import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8');

function extractFunction(name) {
  const functionStart = source.indexOf(`function ${name}`);
  assert.notEqual(functionStart, -1, `${name} not found`);
  const start = source.slice(functionStart - 6, functionStart) === 'async '
    ? functionStart - 6
    : functionStart;
  const openParen = source.indexOf('(', functionStart);
  let parens = 0;
  let closeParen = -1;
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === '(') parens++;
    if (source[i] === ')' && --parens === 0) {
      closeParen = i;
      break;
    }
  }
  const openBrace = source.indexOf('{', closeParen);
  let braces = 0;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === '{') braces++;
    if (source[i] === '}' && --braces === 0) return source.slice(start, i + 1);
  }
  assert.fail(`${name} body incomplete`);
}

function makeAttempt(overrides = {}) {
  return {
    runId: 'run-1',
    stageStartedAt: 200,
    account: 'person@example.com',
    parserTabId: 41,
    attemptId: 'attempt-1',
    ...overrides,
  };
}

function makeRuntime(attempt = makeAttempt()) {
  return {
    pipelineRun: {
      id: attempt.runId,
      status: 'running',
      expected: { iherb: [attempt.account], ebay: [], amazon: [] },
      completed: { iherb: [], ebay: [], amazon: [] },
      failures: [],
    },
    pipelineStage: {
      active: true,
      runId: attempt.runId,
      startedAt: 100,
      currentIndex: 0,
      stageStartedAt: attempt.stageStartedAt,
      stages: ['iherb', 'ebay', 'amazon', 'done'],
    },
    multiAccountIherbState: {
      isMultiAccountIherb: true,
      iherbAccountsQueue: [],
      currentIherbAccount: attempt.account,
    },
    iherbParserTabId: attempt.parserTabId,
    iherbParseAttemptId: attempt.attemptId,
    iherbTimeoutAttempt: null,
    iherbParsingComplete: null,
    iherbStageFinalizing: null,
    iherbParsedAccounts: [],
    iherbSkipReasons: {},
    iherbCancelledOrders: [],
    orderData: {},
  };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createHarness(initialRuntime) {
  const runtime = clone(initialRuntime);
  const writes = [];
  const storage = {
    async get(keys) {
      const selected = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) selected[key] = clone(runtime[key]);
      return selected;
    },
    async set(mutation) {
      const saved = clone(mutation);
      writes.push(saved);
      Object.assign(runtime, saved);
    },
  };
  const context = {
    Date,
    Map,
    Promise,
    Set,
    structuredClone,
    console: { log() {}, warn() {}, error() {} },
    chrome: { storage: { local: storage } },
    iherbAttemptMutationChain: Promise.resolve(),
    pipelineRunWriteChain: Promise.resolve(),
  };
  vm.createContext(context);
  for (const name of [
    'normalizeAccountEmail',
    'pipelineGenerationFromStage',
    'pipelineGenerationMatches',
    'withPipelineRunWrite',
    'applyPipelineAccountResult',
    'withIherbAttemptMutation',
    'iherbAttemptRefFromState',
    'iherbAttemptIdentityMatches',
    'iherbAttemptMatchesRuntime',
    'iherbTimeoutAttemptMatchesRuntime',
    'handleIherbAttemptCommit',
    'commitIherbTimeoutOutcome',
  ]) vm.runInContext(extractFunction(name), context);
  return { context, runtime, writes };
}

function commitRequest(attempt, suffix = '1') {
  return {
    attempt,
    orders: [{ order_id: `order-${suffix}`, product_name: `product-${suffix}` }],
    cancelledOrders: [],
    found: 1,
  };
}

test('timeout wins one exact attempt and rejects its late Done without storing rows', async () => {
  const attempt = makeAttempt();
  const { context, runtime } = createHarness(makeRuntime(attempt));

  const timeout = context.commitIherbTimeoutOutcome(attempt, 'parse_timeout');
  const lateDone = context.handleIherbAttemptCommit(commitRequest(attempt), attempt.parserTabId);
  const [timeoutResult, doneResult] = await Promise.all([timeout, lateDone]);

  assert.equal(timeoutResult.status, 'failed');
  assert.equal(doneResult.ok, false);
  assert.equal(doneResult.reason, 'timeout-won');
  assert.equal(runtime.iherbTimeoutAttempt.attemptId, attempt.attemptId);
  assert.equal(runtime.iherbTimeoutAttempt.phase, 'failed');
  assert.equal(runtime.iherbParsingComplete, null);
  assert.equal(runtime.orderData.iHerb, undefined);
  assert.deepEqual(
    runtime.pipelineRun.failures.map(result => [result.shop, result.account, result.reason]),
    [['iherb', attempt.account, 'parse_timeout']],
  );
});

test('durable Done wins when it commits before the timeout arbiter', async () => {
  const attempt = makeAttempt();
  const { context, runtime } = createHarness(makeRuntime(attempt));

  const done = context.handleIherbAttemptCommit(commitRequest(attempt), attempt.parserTabId);
  const timeout = context.commitIherbTimeoutOutcome(attempt, 'parse_timeout');
  const [doneResult, timeoutResult] = await Promise.all([done, timeout]);

  assert.equal(doneResult.ok, true);
  assert.equal(doneResult.status, 'committed');
  assert.equal(timeoutResult.status, 'completion-won');
  assert.equal(runtime.iherbTimeoutAttempt, null);
  assert.equal(runtime.iherbParsingComplete.attemptId, attempt.attemptId);
  assert.equal(runtime.orderData.iHerb.orders.length, 1);
  assert.deepEqual(runtime.pipelineRun.completed.iherb, [], 'success accounting waits for completion consumption');
  assert.deepEqual(runtime.pipelineRun.failures, []);
});

test('a rotated retry rejects the old attempt while the new attempt can commit', async () => {
  const oldAttempt = makeAttempt({ attemptId: 'attempt-old' });
  const newAttempt = makeAttempt({ attemptId: 'attempt-new' });
  const runtime = makeRuntime(newAttempt);
  runtime.iherbTimeoutAttempt = { ...oldAttempt, phase: 'failed', reason: 'parse_timeout' };
  const harness = createHarness(runtime);

  const oldResult = await harness.context.handleIherbAttemptCommit(
    commitRequest(oldAttempt, 'old'),
    oldAttempt.parserTabId,
  );
  const newResult = await harness.context.handleIherbAttemptCommit(
    commitRequest(newAttempt, 'new'),
    newAttempt.parserTabId,
  );

  assert.equal(oldResult.ok, false);
  assert.equal(oldResult.reason, 'run-account-attempt-changed');
  assert.equal(newResult.ok, true);
  assert.equal(newResult.status, 'committed');
  assert.equal(harness.runtime.iherbParsingComplete.attemptId, newAttempt.attemptId);
  assert.deepEqual(
    harness.runtime.orderData.iHerb.orders.map(order => order.order_id),
    ['order-new'],
  );
  assert.equal(harness.runtime.orderData.iHerb.orders[0].parser_run_id, newAttempt.runId);
  assert.equal(harness.runtime.orderData.iHerb.orders[0].parser_account, newAttempt.account);
});
