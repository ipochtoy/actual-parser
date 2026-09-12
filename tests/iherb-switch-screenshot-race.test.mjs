import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8');

function extractFunction(name, sourceText = source) {
  const source = sourceText;
  const at = source.indexOf(`function ${name}(`);
  assert.ok(at >= 0, name);
  const start = source.slice(at - 6, at) === 'async ' ? at - 6 : at;
  let parens = 0;
  let afterArgs;
  for (let i = source.indexOf('(', at); i < source.length; i++) {
    if (source[i] === '(') parens++;
    if (source[i] === ')' && --parens === 0) { afterArgs = i; break; }
  }
  let braces = 0;
  for (let i = source.indexOf('{', afterArgs); i < source.length; i++) {
    if (source[i] === '{') braces++;
    if (source[i] === '}' && --braces === 0) return source.slice(start, i + 1);
  }
  assert.fail(`unfinished ${name}`);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const now = 1789094304255;
  const switchStartedAt = 1789093982776;
  const runId = '1789095600000-1789093501621-7xzcle';
  const account = 'oksanasorokapocht@gmail.com';
  const attempt = {
    runId, account, stageStartedAt: 1789093501769, parserTabId: 1305915451,
    attemptId: `${runId}:${account}:${switchStartedAt}:d1k5d4`,
  };
  const state = {
    pipelineRun: {
      id: runId, status: 'running',
      expected: { iherb: [account], amazon: [], ebay: [] },
      completed: { iherb: [], amazon: [], ebay: [] }, failures: [],
    },
    pipelineStage: {
      runId, active: true, startedAt: 1789093501769,
      stageStartedAt: attempt.stageStartedAt, currentIndex: 0,
      stages: ['iherb', 'ebay', 'amazon', 'done'],
    },
    multiAccountIherbState: {
      isMultiAccountIherb: true, iherbAccountsQueue: [], currentIherbAccount: account,
    },
    iherbParserTabId: attempt.parserTabId,
    iherbParseAttemptId: attempt.attemptId,
    iherbParseStartedAt: switchStartedAt + 20000,
    iherbWatchdogRetried: false,
    iherbParsingComplete: { ...attempt, found: 46 },
    iherbTimeoutAttempt: null,
    iherbStageFinalizing: null,
    iherbParsedAccounts: [],
    iherbSkipReasons: {},
    iherbSwitchFailures: {},
    iherbSwitchInProgress: true,
    iherbSwitchStartedAt: switchStartedAt,
    pendingIherbSwitch: { email: account, runId, attemptId: attempt.attemptId },
    iherbSwitchDispatch: {
      runId, startedAt: 1789093501769, currentIndex: 0,
      stageStartedAt: attempt.stageStartedAt,
      account, tabId: attempt.parserTabId, attemptId: attempt.attemptId,
      phase: 'dispatched', dispatchedAt: switchStartedAt + 8034,
    },
    trackScreenshotQueue: Array.from({ length: 30 }, (_, i) => ({
      accountName: account, orderId: String(945474074 - i),
      trackNumber: `${945474074 - i}-0`,
    })),
  };
  const drain = deferred();
  const enteredDrain = deferred();
  const events = [];
  const writes = [];
  const context = {
    Date: class extends Date { static now() { return now; } },
    Map, Set, Number, Promise, structuredClone,
    console: { log(...args) { events.push(args.join(' ')); }, warn() {}, error() {} },
    IHERB_SWITCH_TIMEOUT_MS: 300000, IHERB_PARSE_TIMEOUT_MS: 240000,
    iherbAttemptMutationChain: Promise.resolve(), pipelineRunWriteChain: Promise.resolve(),
    parseReport: { stores: {} }, isMultiAccountIherb: true,
    currentIherbAccount: account, iherbAccountsQueue: [],
    setTimeout(done) { done(); },
    async sendTelegramMessage() {},
    async loadAccountsConfig() { return { iherb: [{ email: account }] }; },
    async switchToNextIherbAccount() { events.push('switch-next'); },
    async finalizeIherbStage(_tab, options) { events.push(options?.fromCaptcha ? 'finalize-captcha' : 'finalize'); },
    async waitForScreenshotsDrained() { enteredDrain.resolve(); return drain.promise; },
    async stopPipelineForScreenshotDrain(reason) { events.push(reason); },
    chrome: { storage: { local: {
      async get(keys) {
        return Object.fromEntries(keys.map(key => [key, structuredClone(state[key])]));
      },
      async set(patch) {
        writes.push(structuredClone(patch));
        Object.assign(state, structuredClone(patch));
      },
      async remove(keys) { for (const key of keys) delete state[key]; },
    } } },
  };
  vm.createContext(context);
  for (const name of [
    'normalizeAccountEmail', 'pipelineGenerationFromStage', 'pipelineGenerationMatches',
    'withPipelineRunWrite', 'applyPipelineAccountResult', 'pipelineRunAccountIsTerminal',
    'updatePipelineRun', 'markPipelineAccountResult', 'recordIherbSkipReason',
    'withIherbAttemptMutation', 'iherbAttemptRefFromState', 'iherbAttemptIdentityMatches',
    'iherbAttemptMatchesRuntime', 'iherbTimeoutAttemptMatchesRuntime',
    'consumeIherbCompletionMarker', 'iherbWatchdogAttemptFromState',
    'iherbWatchdogAttemptMatches', 'readIherbWatchdogState', 'handleIherbWatchdog',
    'iherbAcceptedSwitchPatch', 'iherbPendingSwitchMatchesAttempt',
    'acceptIherbParserStarted', 'handleIherbSwitchFailure', 'handleIherbSwitchFailureMessage',
    'abortIherbStageDueToCaptcha',
  ]) vm.runInContext(extractFunction(name), context);
  return { context, state, attempt, events, writes, drain, enteredDrain };
}

test('completion then five-minute switch watchdog preserves all thirty pending screenshots and account', async () => {
  const h = harness();
  const completing = h.context.consumeIherbCompletionMarker(
    h.context.pipelineGenerationFromStage(h.state.pipelineStage),
  );
  await Promise.race([
    h.enteredDrain.promise,
    completing.then(() => { throw new Error('completion did not reach screenshot drain'); }),
  ]);
  try {
    assert.equal(h.state.pipelineRun.completed.iherb.includes(h.attempt.account), true);
    await h.context.handleIherbWatchdog();
    assert.equal(h.state.multiAccountIherbState.currentIherbAccount, h.attempt.account);
    assert.equal(h.state.trackScreenshotQueue.length, 30);
    assert.deepEqual(h.state.multiAccountIherbState.iherbAccountsQueue, []);
    assert.deepEqual(h.state.iherbSwitchFailures, {});
    assert.equal(h.events.includes('switch-next'), false);
  } finally {
    h.drain.resolve(false);
    await completing;
  }
});

test('late switch failure after accepted parsing cannot erase the active screenshot account', async () => {
  const h = harness();
  await h.context.handleIherbSwitchFailure(h.attempt.account, 'no_redirect_after_signin', h.attempt.runId, h.attempt);
  assert.equal(h.state.multiAccountIherbState.currentIherbAccount, h.attempt.account);
  assert.equal(h.state.trackScreenshotQueue.length, 30);
  assert.deepEqual(h.state.iherbSwitchFailures, {});
  assert.equal(h.events.includes('switch-next'), false);
});

function pendingSwitch(h) {
  h.state.iherbParsingComplete = null;
  h.state.iherbParseStartedAt = null;
  h.state.trackScreenshotQueue = [];
}

function startedRequest(h) {
  return { store: 'iherb', runId: h.attempt.runId, account: h.attempt.account, attemptId: h.attempt.attemptId };
}

function failedRequest(h, reason = 'no_redirect_after_signin') {
  return {
    email: h.attempt.account, reason, runId: h.attempt.runId,
    attemptId: h.attempt.attemptId, stageStartedAt: h.attempt.stageStartedAt,
  };
}

test('exact parserStarted closes only its switch markers and preserves a retry deadline', async () => {
  const h = harness();
  pendingSwitch(h);
  h.state.iherbWatchdogRetried = true;
  assert.equal(await h.context.acceptIherbParserStarted(startedRequest(h), h.attempt.parserTabId), true);
  const startedAt = h.state.iherbParseStartedAt;
  assert.equal(h.state.iherbSwitchInProgress, null);
  assert.equal(h.state.iherbSwitchStartedAt, null);
  assert.equal(h.state.pendingIherbSwitch, null);
  assert.equal(h.state.iherbSwitchDispatch, null);
  assert.equal(h.state.multiAccountIherbState.currentIherbAccount, h.attempt.account);
  assert.equal(h.state.iherbWatchdogRetried, true);
  assert.equal(await h.context.acceptIherbParserStarted(startedRequest(h), h.attempt.parserTabId), true);
  assert.equal(h.state.iherbParseStartedAt, startedAt);
  await h.context.handleIherbWatchdog();
  await h.context.handleIherbSwitchFailureMessage(failedRequest(h), h.attempt.parserTabId);
  assert.deepEqual(h.state.iherbSwitchFailures, {});
  assert.equal(h.events.includes('switch-next'), false);
});

test('valid completion without parserStarted still retires the matching switch before drain', async () => {
  const h = harness();
  h.state.iherbParseStartedAt = null;
  const completing = h.context.consumeIherbCompletionMarker(h.context.pipelineGenerationFromStage(h.state.pipelineStage));
  await h.enteredDrain.promise;
  try {
    await h.context.handleIherbWatchdog();
    assert.equal(h.state.iherbSwitchInProgress, null);
    assert.equal(h.state.pendingIherbSwitch, null);
    assert.equal(h.state.multiAccountIherbState.currentIherbAccount, h.attempt.account);
    assert.equal(h.state.trackScreenshotQueue.length, 30);
    assert.deepEqual(h.state.iherbSwitchFailures, {});
  } finally {
    h.drain.resolve(false);
    await completing;
  }
});

test('legacy flags after completed parsing are not an open switch even after the queue drained', async () => {
  const h = harness();
  pendingSwitch(h);
  h.state.pipelineRun.completed.iherb = [h.attempt.account];
  const before = structuredClone(h.state);
  await h.context.handleIherbWatchdog();
  await h.context.handleIherbSwitchFailure(h.attempt.account, 'switch_timeout', h.attempt.runId, h.attempt);
  assert.deepEqual(h.state, before);
  assert.equal(h.writes.length, 0);
});

test('an unconfirmed switch with screenshot work cannot clear its account for retry', async () => {
  const h = harness();
  h.state.iherbParseStartedAt = null;
  h.state.iherbParsingComplete = null;
  const before = structuredClone(h.state);
  await h.context.handleIherbWatchdog();
  assert.deepEqual(h.state, before);
  assert.equal(h.writes.length, 0);
});

test('a real switch timeout still retries once, rejects duplicate ticks, then records bounded failure', async () => {
  const h = harness();
  pendingSwitch(h);
  await Promise.all([h.context.handleIherbWatchdog(), h.context.handleIherbWatchdog()]);
  assert.equal(h.state.iherbSwitchFailures[h.attempt.account], 1);
  assert.equal(h.events.filter(e => e === 'switch-next').length, 1);
  assert.equal(h.state.multiAccountIherbState.iherbAccountsQueue.length, 1);
  const oldAttempt = structuredClone(h.attempt);
  h.attempt.attemptId += ':retry';
  h.state.iherbParseAttemptId = h.attempt.attemptId;
  h.state.pendingIherbSwitch.attemptId = h.attempt.attemptId;
  h.state.iherbSwitchDispatch.attemptId = h.attempt.attemptId;
  h.state.multiAccountIherbState.currentIherbAccount = h.attempt.account;
  h.state.multiAccountIherbState.iherbAccountsQueue = [];
  const beforeStale = structuredClone(h.state);
  assert.equal(await h.context.handleIherbSwitchFailure(h.attempt.account, 'switch_timeout', h.attempt.runId, oldAttempt), false);
  assert.deepEqual(h.state, beforeStale);
  await h.context.handleIherbWatchdog();
  assert.equal(h.state.iherbSwitchFailures[h.attempt.account], 2);
  assert.equal(h.state.iherbSkipReasons[h.attempt.account], 'switch_failed');
  assert.equal(h.state.pipelineRun.failures[0].reason, 'switch_failed');
  assert.equal(h.events.filter(e => e === 'switch-next').length, 1);
  assert.equal(h.events.filter(e => e === 'finalize').length, 1);
  const beforeThird = structuredClone(h.state);
  await h.context.handleIherbWatchdog();
  assert.deepEqual(h.state, beforeThird);
});

test('legacy failure cannot authorize retry; the exact watchdog retains its bounded recovery', async () => {
  const h = harness();
  pendingSwitch(h);
  const { attemptId, stageStartedAt, ...legacy } = failedRequest(h);
  const before = structuredClone(h.state);
  assert.equal(await h.context.handleIherbSwitchFailureMessage(legacy, h.attempt.parserTabId), false);
  assert.deepEqual(h.state, before);
  await h.context.handleIherbWatchdog();
  assert.equal(h.state.iherbSwitchFailures[h.attempt.account], 1);
  assert.equal(h.events.includes('switch-next'), true);
});

test('legacy CAPTCHA uses the existing stop/finalization path, never a login retry', async () => {
  const h = harness();
  pendingSwitch(h);
  const { attemptId, stageStartedAt, ...legacy } = failedRequest(h, 'captcha');
  assert.equal(await h.context.handleIherbSwitchFailureMessage(legacy, h.attempt.parserTabId), true);
  assert.equal(h.state.iherbSkipReasons[h.attempt.account], 'captcha');
  assert.equal(h.state.multiAccountIherbState.currentIherbAccount, h.attempt.account);
  assert.equal(h.state.iherbSwitchInProgress, null);
  await h.context.handleIherbWatchdog();
  assert.deepEqual(h.state.iherbSwitchFailures, {});
  assert.equal(h.events.includes('switch-next'), false);
  assert.equal(h.events.includes('finalize-captcha'), true);
});

test('late CAPTCHA after parse admission and PressHold stop cannot reopen or erase account state', async () => {
  for (const pressed of [false, true]) {
    const h = harness();
    if (pressed) {
      h.state.pipelineRun.status = 'blocked';
      h.state.pipelineStage.active = false;
      h.state.iherbHumanChallenge = { status: 'awaiting-human', ...h.attempt };
    }
    const before = structuredClone(h.state);
    const { attemptId, stageStartedAt, ...legacy } = failedRequest(h, 'captcha');
    await h.context.handleIherbSwitchFailureMessage(legacy, h.attempt.parserTabId);
    await h.context.handleIherbSwitchFailureMessage(failedRequest(h, 'captcha'), h.attempt.parserTabId);
    assert.deepEqual(h.state, before);
    assert.equal(h.writes.length, 0);
  }
});

test('foreign pending attempt, stage or tab cannot be closed by parserStarted', async () => {
  for (const mutate of [
    h => { h.state.pendingIherbSwitch.attemptId = 'new-attempt'; },
    h => { h.state.iherbSwitchDispatch.stageStartedAt++; },
    h => { h.state.iherbParserTabId++; },
    h => { h.state.pipelineStage.active = false; },
  ]) {
    const h = harness();
    pendingSwitch(h);
    mutate(h);
    const before = structuredClone(h.state);
    assert.equal(await h.context.acceptIherbParserStarted(startedRequest(h), h.attempt.parserTabId), false);
    assert.deepEqual(h.state, before);
  }
});

test('switch failure rereads generation after account config await', async () => {
  const h = harness();
  pendingSwitch(h);
  h.context.loadAccountsConfig = async () => {
    h.state.pipelineStage.currentIndex = 1;
    h.state.pipelineStage.stageStartedAt++;
    return { iherb: [{ email: h.attempt.account }] };
  };
  assert.equal(await h.context.handleIherbSwitchFailure(h.attempt.account, 'switch_timeout', h.attempt.runId, h.attempt), false);
  assert.equal(h.writes.length, 0);
  assert.equal(h.state.multiAccountIherbState.currentIherbAccount, h.attempt.account);
});

test('login sender binds its failure and pending intent to one attempt of the same account', async () => {
  const loginSource = readFileSync(new URL('../content-iherb-login.js', import.meta.url), 'utf8');
  const messages = [];
  const ownership = {
    owned: true, runId: 'run-1', tabId: 14, account: 'iherb@example.com',
    attemptId: 'attempt-1', stageStartedAt: 123,
  };
  const pending = { runId: 'run-1', email: ownership.account, attemptId: 'attempt-1' };
  const c = {
    Promise, iherbSwitchRunId: 'run-1', iherbSwitchAttemptId: 'attempt-1',
    iherbSwitchStageStartedAt: 123,
    sendMessageAsync: async () => ownership,
    chrome: {
      runtime: { sendMessage(message) { messages.push(message); } },
      storage: { local: { get: async () => ({ pendingIherbSwitch: pending, iherbFinalReturn: false }) } },
    },
  };
  vm.createContext(c);
  for (const name of ['normalizeIherbEmail', 'readFreshIherbLoginIntent', 'sendFailed']) {
    vm.runInContext(extractFunction(name, loginSource), c);
  }
  const expected = { runId: 'run-1', tabId: 14, email: ownership.account, finalReturn: false, attemptId: 'attempt-1', stageStartedAt: 123 };
  assert.ok(await c.readFreshIherbLoginIntent(expected));
  c.sendFailed(ownership.account, 'no_redirect_after_signin');
  assert.equal(messages[0].attemptId, 'attempt-1');
  assert.equal(messages[0].stageStartedAt, 123);
  ownership.attemptId = 'attempt-2';
  pending.attemptId = 'attempt-2';
  assert.equal(await c.readFreshIherbLoginIntent(expected), null);
});
