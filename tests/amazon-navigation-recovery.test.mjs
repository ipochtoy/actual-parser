import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const content = readFileSync(new URL('content-amazon.js', ROOT), 'utf8');
const background = readFileSync(new URL('background.js', ROOT), 'utf8');

function extractFunction(source, name) {
  const functionStart = source.indexOf(`function ${name}`);
  assert.notEqual(functionStart, -1, `function ${name} not found`);
  const start = source.slice(functionStart - 6, functionStart) === 'async '
    ? functionStart - 6
    : functionStart;
  const openParen = source.indexOf('(', functionStart);
  let parenDepth = 0;
  let closeParen = -1;
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === '(') parenDepth++;
    if (source[i] === ')' && --parenDepth === 0) {
      closeParen = i;
      break;
    }
  }
  const openBrace = source.indexOf('{', closeParen);
  let braceDepth = 0;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === '{') braceDepth++;
    if (source[i] === '}' && --braceDepth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`body for ${name} is incomplete`);
}

test('Amazon page URL helpers preserve the filter and target page 17 exactly', () => {
  const context = {
    URL,
    location: { href: 'https://www.amazon.com/gp/your-account/order-history?orderFilter=months-3&startIndex=150' },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(content, 'getAmazonPageFromUrl'), context);
  vm.runInContext(extractFunction(content, 'buildAmazonPageUrl'), context);

  assert.equal(context.getAmazonPageFromUrl(context.location.href), 16);
  assert.equal(
    context.getAmazonPageFromUrl('https://www.amazon.com/your-orders?orderFilter=months-3&page=17'),
    17,
  );
  assert.equal(context.getAmazonPageFromUrl('https://www.amazon.com/your-orders?orderFilter=months-3'), 1);

  const page17 = new URL(context.buildAmazonPageUrl(context.location.href, 17));
  assert.equal(page17.searchParams.get('startIndex'), '160');
  assert.equal(page17.searchParams.get('orderFilter'), 'months-3');
  assert.equal(context.buildAmazonPageUrl('https://evilamazon.com/order-history', 17), null);
  assert.equal(context.buildAmazonPageUrl('https://www.amazon.com/gp/cart/view.html', 17), null);
});

test('content script durably records a transition before direct navigation', () => {
  const fn = extractFunction(content, 'navigateToNextPage');
  const markerAt = fn.indexOf('state.navigation =');
  const persistAt = fn.indexOf('await savePaginationState(state)');
  const navigateAt = fn.indexOf('location.assign(targetUrl)');
  assert.ok(markerAt > -1 && markerAt < persistAt && persistAt < navigateAt);

  const wrapper = extractFunction(content, 'parseAmazonOrdersWithPagination');
  assert.match(wrapper, /actualPage !== state\.currentPage[\s\S]*?navigationPending: true/);
  assert.match(wrapper, /delete state\.navigation;\s*await savePaginationState\(state\)/);
});

test('watchdog retries only a safe matching navigation generation, at most twice', () => {
  const context = {
    URL,
    Date,
    AMAZON_NAVIGATION_MAX_RETRIES: 2,
    AMAZON_NAVIGATION_RETRY_GAP_MS: 60_000,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(background, 'getAmazonNavigationRetryDecision'), context);

  const state = {
    currentPage: 17,
    navigation: {
      targetPage: 17,
      targetUrl: 'https://www.amazon.com/gp/your-account/order-history?startIndex=160',
      retryCount: 0,
    },
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.getAmazonNavigationRetryDecision({ paginationState: state, timedOut: true, now: 500_000 }))),
    { retry: true, retryCount: 1, targetPage: 17, targetUrl: state.navigation.targetUrl },
  );

  state.navigation.retryCount = 2;
  assert.equal(context.getAmazonNavigationRetryDecision({ paginationState: state, timedOut: true, now: 500_000 }).reason, 'retry-limit');
  state.navigation.retryCount = 0;
  state.navigation.targetPage = 18;
  assert.equal(context.getAmazonNavigationRetryDecision({ paginationState: state, timedOut: true, now: 500_000 }).reason, 'page-generation-mismatch');
  state.navigation.targetPage = 17;
  state.navigation.targetUrl = 'https://example.com/order-history?startIndex=160';
  assert.equal(context.getAmazonNavigationRetryDecision({ paginationState: state, timedOut: true, now: 500_000 }).reason, 'unsafe-target');
});

test('navigation recovery grants a bounded hard-cap grace window', () => {
  const context = { Date };
  vm.createContext(context);
  vm.runInContext(extractFunction(background, 'isAmazonHardCapExpired'), context);

  assert.equal(context.isAmazonHardCapExpired({ totalElapsed: 1_200_001, hardCapMs: 1_200_000, now: 100, graceUntil: 200 }), false);
  assert.equal(context.isAmazonHardCapExpired({ totalElapsed: 1_200_001, hardCapMs: 1_200_000, now: 201, graceUntil: 200 }), true);
  assert.equal(context.isAmazonHardCapExpired({ totalElapsed: 1_199_999, hardCapMs: 1_200_000, now: 999, graceUntil: null }), false);
});

test('timeout evidence is captured from the exact parser tab, never the active window tab', () => {
  const capture = extractFunction(background, 'captureAmazonTabWithDebugger');
  assert.match(capture, /'Page\.captureScreenshot'/);
  assert.doesNotMatch(capture, /captureVisibleTab/);

  const timeoutStart = background.indexOf('let evidence = { tabId: null');
  const timeoutEnd = background.indexOf("await logMultiAccountStep('account-parse:timeout'", timeoutStart);
  assert.ok(timeoutStart > -1 && timeoutEnd > timeoutStart);
  const timeoutEvidence = background.slice(timeoutStart, timeoutEnd);
  assert.match(timeoutEvidence, /getAmazonParserTab\(stored\.amazonParserTabId\)/);
  assert.match(timeoutEvidence, /captureAmazonTabWithDebugger\(tab\.id\)/);
  assert.doesNotMatch(timeoutEvidence, /captureVisibleTab/);
});

test('recovery is wired before the destructive account-skip path', () => {
  const alarmStart = background.indexOf("if (alarm.name !== WATCHDOG_ALARM_NAME) return;");
  const retryAt = background.indexOf('await retryAmazonPaginationNavigation(stored, now, timeoutReason)', alarmStart);
  const skipGuardAt = background.indexOf('await chrome.storage.local.set({ skipGuardAt: Date.now() })', retryAt);
  const clearStateAt = background.indexOf("'amazonPaginationState', 'amazonNavigationGraceUntil'", retryAt);
  assert.ok(retryAt > alarmStart && retryAt < skipGuardAt && skipGuardAt < clearStateAt);
  assert.match(background, /rememberAmazonParserTab\(sender\)/);
});

test('night parser never closes or hijacks unrelated Amazon tabs', () => {
  const start = extractFunction(background, 'startMultiAccountAmazonParsing');
  assert.doesNotMatch(start, /chrome\.tabs\.remove/);
  assert.doesNotMatch(start, /url:\s*'https:\/\/www\.amazon\.com\/\*'/);

  const switchAccount = extractFunction(background, 'switchToNextAmazonAccount');
  assert.match(switchAccount, /getAmazonParserTab\(parserState\.amazonParserTabId\)/);
  assert.doesNotMatch(switchAccount, /chrome\.tabs\.query\(\{ url: 'https:\/\/www\.amazon\.com\/\*'/);

  const finalReturn = extractFunction(background, 'finalReturnToPrimaryAmazon');
  assert.match(finalReturn, /getAmazonParserTab\(parserState\.amazonParserTabId\)/);
  assert.doesNotMatch(finalReturn, /chrome\.tabs\.query\(\{ url: 'https:\/\/www\.amazon\.com\/\*'/);
});
