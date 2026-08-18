import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const background = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const amazon = readFileSync(new URL('../content-amazon.js', import.meta.url), 'utf8');

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

test('live cabinet timing survives the reliability refactor', () => {
  assert.match(background, /ACCOUNT_PARSE_TIMEOUT_MS\s*=\s*600000/,
    'Amazon may be quiet for ten minutes while its long order history advances');
  assert.match(background, /iherb:\s*50\s*\*\s*60_000/);
  assert.match(background, /ebay:\s*15\s*\*\s*60_000/);
  assert.match(background, /amazon:\s*100\s*\*\s*60_000/);
  assert.match(background, /AMAZON_ACCOUNT_HARD_CAP_MS\s*=\s*45\s*\*\s*60_000/,
    'healthy forty-minute Amazon cabinets must not be cut by the old twenty-minute cap');
  assert.match(background, /SCREENSHOT_STAGE_BUDGET_MAX_MS\s*=\s*6\s*\*\s*60\s*\*\s*60_000/,
    'screenshot time remains excluded without making the queue unbounded');
});

test('fresh Amazon progress survives forty minutes but a true forty-five-minute overrun stops', () => {
  const hardCapSource = extractFunction(background, 'isAmazonHardCapExpired');
  const decisionSource = extractFunction(background, 'getAmazonAccountTimeoutDecision');
  const context = vm.createContext({
    Date,
    ACCOUNT_PARSE_TIMEOUT_MS: 10 * 60_000,
    AMAZON_ACCOUNT_HARD_CAP_MS: 45 * 60_000,
  });
  vm.runInContext(hardCapSource, context);
  vm.runInContext(decisionSource, context);

  assert.deepEqual(
    { ...context.getAmazonAccountTimeoutDecision({
      totalElapsed: 40 * 60_000,
      sinceLastProgress: 25_000,
      now: 40 * 60_000,
    }) },
    { isIdleTimeout: false, isHardCap: false, timedOut: false },
  );
  assert.equal(context.getAmazonAccountTimeoutDecision({
    totalElapsed: 40 * 60_000,
    sinceLastProgress: 10 * 60_000 + 1,
  }).isIdleTimeout, true);
  assert.equal(context.getAmazonAccountTimeoutDecision({
    totalElapsed: 45 * 60_000 + 1,
    sinceLastProgress: 1_000,
  }).isHardCap, true);
  assert.ok(2 * 45 * 60_000 < 100 * 60_000,
    'two account ceilings must leave stage time for both switches and final return');
});

test('Amazon keeps the proven five-second page settle', () => {
  assert.match(amazon, /PAGE_DELAY_MS\s*=\s*5000/,
    'two seconds produced redirecting pages and empty cabinet results in production');
});

test('operator reports and tracking cards retain the live readable contract', () => {
  assert.match(background, /async function sendTelegramLong\(/);
  assert.match(background, /sendTelegramLong\(report\)/);
  assert.match(background, /async function itemsCaptionLine\(/);
  assert.match(background, /STATUS_RANK\s*=\s*\{[^\n]*'🚫':\s*3/);
});

test('report counts confirmed cards and final failures, not internal retries', () => {
  const source = background.match(/function screenshotReportCounters\([\s\S]*?\n\}/)?.[0];
  assert.ok(source, 'pure report counter helper must remain extractable');
  const counters = vm.runInNewContext(`(${source})`);
  assert.deepEqual(
    { ...counters({ sent: 10, broken: 2, failed: 2 }) },
    { cardsSent: 10, brokenCards: 2, otherFailedCards: 0 },
  );
  assert.deepEqual(
    { ...counters({ sent: 10, broken: 2, failed: 5 }) },
    { cardsSent: 10, brokenCards: 2, otherFailedCards: 3 },
  );

  assert.equal((background.match(/parseReport\.screenshots\.failed\+\+/g) || []).length, 1);
  assert.equal((background.match(/parseReport\.screenshots\.broken\+\+/g) || []).length, 1);
  assert.match(background, /item\._attempts\s*>=\s*SCREENSHOT_MAX_ATTEMPTS[\s\S]{0,500}screenshots\.failed\+\+/);
});

test('Telegram delivery failure never suppresses a fresh cancellation alert', async () => {
  const makeContext = responses => {
    const writes = [];
    const context = {
      console: { log() {}, warn() {}, error() {} },
      tgBotToken: 'token',
      tgChatId: 'chat',
      setTimeout: callback => { callback(); return 1; },
      fetch: async () => {
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return {
          ok: next !== false,
          status: next === false ? 500 : 200,
          text: async () => next === false ? 'failed' : 'ok',
        };
      },
      chrome: { storage: { local: { set: async mutation => writes.push(structuredClone(mutation)) } } },
      writes,
    };
    vm.createContext(context);
    for (const name of [
      'sendTelegramMessage',
      'sendTelegramLong',
      'deliverFreshCancellationAlert',
    ]) vm.runInContext(extractFunction(background, name), context);
    return context;
  };

  const ok = makeContext([true, true]);
  await ok.deliverFreshCancellationAlert('first line\ntwo', ['old'], ['new'], 10);
  assert.deepEqual(ok.writes, [{ notifiedCancelledOrderIds: ['old', 'new'] }]);

  const failed = makeContext([true, false]);
  await assert.rejects(
    failed.deliverFreshCancellationAlert('first line\ntwo', ['old'], ['new'], 10),
    /Telegram part 2\/2 was not accepted/,
  );
  assert.deepEqual(failed.writes, [], 'failed multipart delivery must stay retryable');

  const missing = makeContext([]);
  missing.tgBotToken = '';
  assert.equal(await missing.sendTelegramMessage('alert'), false);
  assert.deepEqual(missing.writes, []);
});
