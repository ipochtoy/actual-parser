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

test('content script delegates cursor plus navigation to the background arbiter', () => {
  const fn = extractFunction(content, 'navigateToNextPage');
  const markerAt = fn.indexOf('state.navigation =');
  const commitAt = fn.indexOf("await commitAmazonAttempt('navigate', state, { targetUrl })");
  assert.ok(markerAt > -1 && markerAt < commitAt);
  assert.doesNotMatch(fn, /location\.(?:assign|replace)\(/);

  const commit = extractFunction(background, 'handleAmazonAttemptCommit');
  assert.match(
    commit,
    /if \(request\.kind === 'navigate'\)[\s\S]*?await chrome\.storage\.local\.set\(mutation\);[\s\S]*?await chrome\.tabs\.update\(senderTabId, \{ url: targetUrl, active: true \}\)/,
  );

  const wrapper = extractFunction(content, 'parseAmazonOrdersWithPagination');
  assert.match(wrapper, /actualPage !== state\.currentPage[\s\S]*?navigationPending: true/);
  assert.match(
    wrapper,
    /delete state\.navigation;[\s\S]*?await commitAmazonAttempt\('cursor', state, \{[\s\S]*?amazonOrders: state\.allOrders,[\s\S]*?clearRecovery: true/,
  );
});

test('late old Amazon page sends one fenced cursor request and performs no direct write', async () => {
  const requests = [];
  const context = {
    chrome: {
      runtime: {
        sendMessage: async request => {
          requests.push(request);
          return { ok: false, status: 'stale', reason: 'run-account-generation-changed' };
        },
      },
      storage: {
        local: {
          set: async () => assert.fail('content must not write the shared Amazon cursor directly'),
        },
      },
    },
  };
  vm.createContext(context);
  for (const name of [
    'amazonAttemptRefFromState',
    'commitAmazonAttempt',
    'savePaginationState',
  ]) vm.runInContext(extractFunction(content, name), context);

  const oldState = {
    runId: 'run-old', account: 'old@example.com', parserTabId: 9,
    stageStartedAt: 10, accountSwitchStartedAt: 11, parseId: 'parse-old',
  };
  const error = await context.savePaginationState(oldState).catch(value => value);
  assert.match(error.message, /Amazon cursor commit rejected: run-account-generation-changed/);
  assert.equal(error.code, 'AMAZON_STALE_ATTEMPT');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].action, 'commitAmazonAttempt');
  assert.equal(requests[0].kind, 'cursor');
  assert.equal(requests[0].attempt.parseId, 'parse-old');

  const navigation = extractFunction(content, 'navigateToNextPage');
  assert.match(navigation, /await commitAmazonAttempt\('navigate', state, \{ targetUrl \}\)/);
  assert.doesNotMatch(navigation, /chrome\.storage\.local\.set|location\.(?:assign|replace)\(/);
});

test('watchdog retries only a safe matching navigation generation, at most twice', () => {
  const context = {
    URL,
    Date,
    AMAZON_NAVIGATION_MAX_RETRIES: 2,
    AMAZON_NAVIGATION_RETRY_GAP_MS: 60_000,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(background, 'normalizeAccountEmail'), context);
  vm.runInContext(extractFunction(background, 'getAmazonNavigationRetryDecision'), context);

  const state = {
    currentPage: 17,
    navigation: {
      navId: 'nav-17',
      targetPage: 17,
      targetUrl: 'https://www.amazon.com/gp/your-account/order-history?startIndex=160',
      retryCount: 0,
    },
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.getAmazonNavigationRetryDecision({ paginationState: state, recovery: null, timedOut: true, now: 500_000 }))),
    { retry: true, retryCount: 1, navId: 'nav-17', targetPage: 17, targetUrl: state.navigation.targetUrl },
  );

  const recovery = { navId: 'nav-17', retryCount: 2, lastRetryAt: 100_000 };
  assert.equal(context.getAmazonNavigationRetryDecision({ paginationState: state, recovery, timedOut: true, now: 500_000 }).reason, 'retry-limit');
  recovery.retryCount = 0;
  state.navigation.targetPage = 18;
  assert.equal(context.getAmazonNavigationRetryDecision({ paginationState: state, recovery, timedOut: true, now: 500_000 }).reason, 'page-generation-mismatch');
  state.navigation.targetPage = 17;
  state.navigation.targetUrl = 'https://example.com/order-history?startIndex=160';
  assert.equal(context.getAmazonNavigationRetryDecision({ paginationState: state, recovery, timedOut: true, now: 500_000 }).reason, 'unsafe-target');
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
  const claimAt = background.indexOf('await claimAmazonTimeoutAttempt(timeoutAttempt)', retryAt);
  const finalizeAt = background.indexOf('await finalizeAmazonTimeoutAttempt(', claimAt);
  const switchAt = background.indexOf('await switchToNextAmazonAccount(', finalizeAt);
  assert.ok(retryAt > alarmStart && retryAt < claimAt && claimAt < finalizeAt && finalizeAt < switchAt);
  assert.doesNotMatch(background, /rememberAmazonParserTab/);
  const autoResume = extractFunction(content, 'checkAutoResume');
  assert.match(autoResume, /getOwnedAmazonParserContext\(\)/);
  assert.match(autoResume, /if \(!ownership\)[\s\S]*?return/);
});

test('timeout fences the exact attempt and never erases a racing completion slot', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(extractFunction(background, 'normalizeAccountEmail'), context);
  vm.runInContext(extractFunction(background, 'amazonWatchdogAttemptIdentityMatches'), context);
  const attempt = {
    runId: 'run-1', stageStartedAt: 10, account: 'a@example.com', parserTabId: 8,
    accountSwitchStartedAt: 11, parseId: 'parse-1',
  };
  assert.equal(context.amazonWatchdogAttemptIdentityMatches(attempt, { ...attempt }), true);
  assert.equal(context.amazonWatchdogAttemptIdentityMatches(attempt, { ...attempt, parseId: 'parse-2' }), false);

  const commit = extractFunction(background, 'handleAmazonAttemptCommit');
  const claim = extractFunction(background, 'claimAmazonTimeoutAttempt');
  const finalize = extractFunction(background, 'finalizeAmazonTimeoutAttempt');
  for (const fn of [commit, claim]) {
    assert.match(fn, /return withAmazonAttemptMutation\(async \(\) => \{/);
  }
  assert.match(
    finalize,
    /return withAmazonAttemptMutation\(\(\) => withPipelineRunWrite\(async \(\) => \{/,
  );
  assert.match(claim, /amazonCompletionMatchesAttempt\(state, attempt\)[\s\S]*?status: 'completion-won'/);
  assert.match(finalize, /amazonCompletionMatchesAttempt\(state, attempt\)[\s\S]*?status: 'completion-won'/);
  assert.match(finalize, /amazonTimeoutAttempt: failedMarker[\s\S]*?amazonPaginationState: null/);

  const contextDoor = background.slice(
    background.indexOf('request.action === "getAmazonParserContext"'),
    background.indexOf('request.action === "fetchEbayOrderTracking"'),
  );
  assert.match(contextDoor, /timeoutBlocksCurrentAttempt/);
  assert.match(contextDoor, /amazonWatchdogAttemptIdentityMatches/);
});

test('night parser never closes or hijacks unrelated Amazon tabs', () => {
  const start = extractFunction(background, 'startMultiAccountAmazonParsing');
  assert.doesNotMatch(start, /chrome\.tabs\.remove/);
  assert.doesNotMatch(start, /url:\s*'https:\/\/www\.amazon\.com\/\*'/);

  const switchAccount = extractFunction(background, 'switchToNextAmazonAccount');
  assert.match(switchAccount, /dispatchCurrentAmazonAccountSwitch\(prepared\.nextEmail, generation, 'account-switch'\)/);
  assert.doesNotMatch(switchAccount, /chrome\.tabs\.query\(\{ url: 'https:\/\/www\.amazon\.com\/\*'/);

  const finalReturn = extractFunction(background, 'finalReturnToPrimaryAmazonOnce');
  assert.match(finalReturn, /dispatchCurrentAmazonAccountSwitch\(primary\.email, generation, 'final-return'\)/);
  assert.doesNotMatch(finalReturn, /chrome\.tabs\.query\(\{ url: 'https:\/\/www\.amazon\.com\/\*'/);

  const dispatch = extractFunction(background, 'dispatchCurrentAmazonAccountSwitchOnce');
  assert.match(dispatch, /getAmazonParserTab\(state\.amazonParserTabId\)/);
  assert.match(dispatch, /failed to create owned Amazon parser tab/);
  assert.doesNotMatch(dispatch, /chrome\.tabs\.query/);

  const exactGetter = extractFunction(background, 'getAmazonParserTab');
  assert.doesNotMatch(exactGetter, /chrome\.tabs\.query/);
  assert.match(exactGetter, /return null/);
});

test('Amazon account dispatch rechecks generation after a delayed tab lookup', async () => {
  const generation = { runId: 'run-1', startedAt: 1, currentIndex: 2, stageStartedAt: 3 };
  const state = {
    pipelineRun: { id: 'run-1', status: 'running' },
    pipelineStage: {
      active: true,
      runId: 'run-1',
      startedAt: 1,
      currentIndex: 2,
      stageStartedAt: 3,
      stages: ['iherb', 'ebay', 'amazon', 'done'],
    },
    multiAccountState: { currentAmazonAccount: 'target@example.com' },
    pendingAccountSwitch: { runId: 'run-1', email: 'target@example.com' },
    amazonParserTabId: 9,
    amazonStageFinalizing: null,
    amazonSwitchDispatch: null,
  };
  let releaseTab;
  let tabLookupStarted;
  const tabStarted = new Promise(resolve => { tabLookupStarted = resolve; });
  const tabGate = new Promise(resolve => { releaseTab = resolve; });
  const calls = { sets: 0, updates: 0, creates: 0, removes: 0 };
  const context = {
    Date,
    Promise,
    parserOperationFlights: new Map(),
    console: { log() {}, warn() {}, error() {} },
    async getAmazonParserTab() {
      tabLookupStarted();
      await tabGate;
      return { id: 9, url: 'https://www.amazon.com/gp/your-account/order-history' };
    },
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const result = {};
            for (const key of keys) result[key] = structuredClone(state[key]);
            return result;
          },
          async set(mutation) {
            calls.sets++;
            Object.assign(state, structuredClone(mutation));
          },
        },
      },
      tabs: {
        async update() { calls.updates++; },
        async create() { calls.creates++; return { id: 10 }; },
        async remove() { calls.removes++; },
      },
    },
  };
  vm.createContext(context);
  for (const name of [
    'normalizeAccountEmail',
    'pipelineGenerationMatches',
    'pipelineOperationKey',
    'runParserOperationSingleFlight',
    'getAmazonSwitchAccountUrl',
    'dispatchCurrentAmazonAccountSwitchOnce',
  ]) {
    vm.runInContext(extractFunction(background, name), context);
  }
  vm.runInContext(extractFunction(background, 'dispatchCurrentAmazonAccountSwitch'), context);

  const dispatch = context.dispatchCurrentAmazonAccountSwitch(
    'target@example.com',
    generation,
    'account-switch',
  );
  await tabStarted;
  state.pipelineStage = {
    ...state.pipelineStage,
    active: false,
    currentIndex: 3,
    stageStartedAt: 4,
  };
  state.amazonSwitchDispatch = null;
  releaseTab();

  assert.equal(await dispatch, false);
  assert.deepEqual(calls, { sets: 0, updates: 0, creates: 0, removes: 0 });
  assert.equal(state.amazonSwitchDispatch, null);
});

test('duplicate Amazon final dispatch shares one navigation with or without an existing tab', async t => {
  for (const existingTab of [true, false]) {
    await t.test(existingTab ? 'existing parser tab' : 'new parser tab', async () => {
      const generation = { runId: 'run-1', startedAt: 1, currentIndex: 2, stageStartedAt: 3 };
      const state = {
        pipelineRun: { id: 'run-1', status: 'running' },
        pipelineStage: {
          active: true,
          runId: 'run-1',
          startedAt: 1,
          currentIndex: 2,
          stageStartedAt: 3,
          stages: ['iherb', 'ebay', 'amazon', 'done'],
        },
        multiAccountState: null,
        pendingAccountSwitch: { runId: 'run-1', email: 'primary@example.com' },
        amazonParserTabId: existingTab ? 9 : null,
        amazonStageFinalizing: {
          ...generation,
          shop: 'amazon',
          account: 'primary@example.com',
          returnStatus: 'prepared',
        },
        amazonSwitchDispatch: null,
      };
      const calls = { creates: 0, updates: 0, removes: 0, phases: [] };
      const context = {
        Date,
        Promise,
        parserOperationFlights: new Map(),
        console: { log() {}, warn() {}, error() {} },
        async getAmazonParserTab(tabId) {
          return tabId ? { id: tabId, url: 'https://www.amazon.com/' } : null;
        },
        chrome: {
          storage: {
            local: {
              async get(keys) {
                const result = {};
                for (const key of keys) result[key] = structuredClone(state[key]);
                return result;
              },
              async set(mutation) {
                if (mutation.amazonSwitchDispatch?.phase) {
                  calls.phases.push(mutation.amazonSwitchDispatch.phase);
                }
                Object.assign(state, structuredClone(mutation));
              },
            },
          },
          tabs: {
            async create() { calls.creates++; return { id: 10, url: 'about:blank' }; },
            async update() { calls.updates++; },
            async remove() { calls.removes++; },
          },
        },
      };
      vm.createContext(context);
      for (const name of [
        'normalizeAccountEmail',
        'pipelineGenerationMatches',
        'pipelineOperationKey',
        'runParserOperationSingleFlight',
        'getAmazonSwitchAccountUrl',
        'dispatchCurrentAmazonAccountSwitchOnce',
        'dispatchCurrentAmazonAccountSwitch',
      ]) vm.runInContext(extractFunction(background, name), context);

      const [first, second] = await Promise.all([
        context.dispatchCurrentAmazonAccountSwitch('primary@example.com', generation, 'final-return'),
        context.dispatchCurrentAmazonAccountSwitch('primary@example.com', generation, 'final-return'),
      ]);
      assert.deepEqual([first, second], [true, true]);
      assert.equal(calls.creates, existingTab ? 0 : 1);
      assert.equal(calls.updates, 1);
      assert.equal(calls.removes, 0);
      assert.deepEqual(calls.phases, ['prepared', 'dispatched']);
      assert.equal(context.parserOperationFlights.size, 0);
    });
  }
});

test('duplicate Amazon stage final return shares one confirmation flow', async () => {
  const generation = { runId: 'run-1', startedAt: 1, currentIndex: 2, stageStartedAt: 3 };
  const primary = { email: 'primary@example.com', isPrimary: true };
  const state = {
    pipelineRun: { id: 'run-1', status: 'running' },
    pipelineStage: {
      active: true,
      runId: 'run-1',
      startedAt: 1,
      currentIndex: 2,
      stageStartedAt: 3,
      stages: ['iherb', 'ebay', 'amazon', 'done'],
    },
    amazonParserTabId: 9,
    amazonStageFinalizing: {
      ...generation,
      shop: 'amazon',
      account: primary.email,
      tabId: 9,
      returnStatus: 'prepared',
      attempts: 0,
    },
    amazonSwitchDispatch: null,
  };
  const calls = { dispatches: 0, waits: 0, removes: 0 };
  const context = {
    Date,
    Promise,
    parserOperationFlights: new Map(),
    console: { log() {}, warn() {}, error() {} },
    loadAccountsConfig: async () => ({ amazon: [primary] }),
    getPrimary: accounts => accounts.find(account => account.isPrimary),
    async dispatchCurrentAmazonAccountSwitch() { calls.dispatches++; return true; },
    async waitForAmazonFinalReturnCompletion() { calls.waits++; return true; },
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const result = {};
            for (const key of keys) result[key] = structuredClone(state[key]);
            return result;
          },
          async set(mutation) { Object.assign(state, structuredClone(mutation)); },
          async remove(keys) {
            calls.removes++;
            for (const key of keys) delete state[key];
          },
        },
      },
    },
  };
  vm.createContext(context);
  for (const name of [
    'normalizeAccountEmail',
    'pipelineGenerationMatches',
    'pipelineOperationKey',
    'runParserOperationSingleFlight',
    'finalReturnToPrimaryAmazonOnce',
    'finalReturnToPrimaryAmazon',
  ]) vm.runInContext(extractFunction(background, name), context);

  const [first, second] = await Promise.all([
    context.finalReturnToPrimaryAmazon(generation),
    context.finalReturnToPrimaryAmazon(generation),
  ]);
  assert.deepEqual([first, second], [true, true]);
  assert.equal(calls.dispatches, 1);
  assert.equal(calls.waits, 1);
  assert.equal(calls.removes, 1);
  assert.equal(context.parserOperationFlights.size, 0);
});

test('missing Next, stop and parser errors cannot emit Amazon completion', () => {
  const wrapper = extractFunction(content, 'parseAmazonOrdersWithPagination');
  assert.match(wrapper, /failPaginationParsing\(state, 'stopped-during-pagination'\)/);
  assert.match(wrapper, /failPaginationParsing\(state, 'stopped-before-navigation'\)/);
  assert.match(wrapper, /navigationResult\.status === 'explicit-end'/);
  assert.match(wrapper, /failPaginationParsing\(state, navigationResult\.reason \|\| 'navigation-blocked'\)/);
  assert.match(wrapper, /failPaginationParsing\(state, 'parser-error', error\)/);

  const finish = extractFunction(content, 'finishPaginationParsing');
  assert.match(finish, /\['configured-limit', 'explicit-end'\]\.includes\(reason\)/);
  assert.match(finish, /state\.navigation/);

  const fail = extractFunction(content, 'failPaginationParsing');
  assert.doesNotMatch(fail, /amazonParsingComplete/);
  assert.match(fail, /await commitAmazonAttempt\('incomplete', state, \{/);
  assert.doesNotMatch(fail, /chrome\.storage\.local\.set/);
});
