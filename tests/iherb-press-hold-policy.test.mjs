import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const background = readFileSync(new URL('background.js', ROOT), 'utf8');
const contentIherb = readFileSync(new URL('content-iherb.js', ROOT), 'utf8');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function extractFunction(source, name) {
  const functionStart = source.indexOf(`function ${name}`);
  assert.notEqual(functionStart, -1, `${name} not found`);
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
  assert.fail(`${name} body incomplete`);
}

function basePressHoldState() {
  return {
    pipelineRun: {
      id: 'run-1',
      status: 'running',
      expected: {
        iherb: ['photopochtoy@gmail.com', 'questburgh@gmail.com', 'oksanasorokapocht@gmail.com'],
        ebay: ['ipochtoy@gmail.com'],
        amazon: ['ipochtoy@gmail.com', 'photopochtoy@gmail.com'],
      },
      completed: { iherb: [], ebay: [], amazon: [] },
      failures: [],
    },
    pipelineStage: {
      active: true,
      runId: 'run-1',
      stages: ['iherb', 'ebay', 'amazon', 'done'],
      currentIndex: 0,
      stageName: 'iherb',
      startedAt: 1_000,
      stageStartedAt: 2_000,
    },
    multiAccountIherbState: {
      isMultiAccountIherb: true,
      currentIherbAccount: 'photopochtoy@gmail.com',
      iherbAccountsQueue: [
        { email: 'questburgh@gmail.com', password: 'kept-secret' },
        { email: 'oksanasorokapocht@gmail.com', password: 'kept-secret-2' },
      ],
    },
    pendingIherbSwitch: {
      runId: 'run-1',
      email: 'photopochtoy@gmail.com',
      password: 'kept-secret-primary',
    },
    iherbParserTabId: 77,
    iherbParseAttemptId: 'attempt-1',
    iherbHumanChallenge: null,
    trackScreenshotQueue: [{
      orderId: 'I1',
      trackNumber: 'TI1',
      trackUrl: 'https://secure.iherb.com/myaccount/orderdetails?orderId=I1',
      accountName: 'photopochtoy',
    }],
    screenshotStageBudget: {
      stageName: 'iherb',
      stageStartedAt: 2_000,
      accruedMs: 15_000,
      activeSince: 20_000,
    },
  };
}

function makePressHoldHarness({ state: suppliedState, alertFailures = 0 } = {}) {
  const state = clone(suppliedState || basePressHoldState());
  let remainingAlertFailures = alertFailures;
  const calls = {
    writes: [],
    alerts: [],
    debugger: [],
    navigation: [],
    abort: [],
    skip: [],
    finalize: [],
    advance: [],
  };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    chrome: {
      storage: {
        local: {
          get: async keys => {
            const list = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(list.map(key => [key, clone(state[key])]));
          },
          set: async value => {
            calls.writes.push(clone(value));
            Object.assign(state, clone(value));
          },
          remove: async keys => {
            for (const key of (Array.isArray(keys) ? keys : [keys])) delete state[key];
          },
        },
      },
      tabs: {
        update: async (...args) => calls.navigation.push(['update', ...clone(args)]),
        create: async (...args) => calls.navigation.push(['create', ...clone(args)]),
        remove: async (...args) => calls.navigation.push(['remove', ...clone(args)]),
      },
      debugger: {
        attach: (...args) => calls.debugger.push(['attach', ...clone(args)]),
        sendCommand: (...args) => calls.debugger.push(['sendCommand', ...clone(args)]),
        detach: (...args) => calls.debugger.push(['detach', ...clone(args)]),
      },
    },
    sendTelegramMessage: async message => {
      calls.alerts.push(message);
      if (remainingAlertFailures > 0) {
        remainingAlertFailures--;
        throw new Error('telegram unavailable');
      }
      return true;
    },
    abortIherbStageDueToCaptcha: async (...args) => calls.abort.push(clone(args)),
    recordIherbSkipReason: async (...args) => calls.skip.push(clone(args)),
    finalizeIherbStage: async (...args) => calls.finalize.push(clone(args)),
    advancePipelineStage: async (...args) => calls.advance.push(clone(args)),
  };
  vm.createContext(context);
  vm.runInContext(`
    let pipelineRunWriteChain = Promise.resolve();
    let isParsingAllStores = true;
    let storesCompleted = { iherb: false, ebay: false, amazon: false };
    ${extractFunction(background, 'normalizeAccountEmail')}
    ${extractFunction(background, 'pipelineGenerationFromStage')}
    ${extractFunction(background, 'pipelineGenerationMatches')}
    ${extractFunction(background, 'iherbOwnedActionMatches')}
    ${extractFunction(background, 'iherbHumanChallengeMatches')}
    ${extractFunction(background, 'markIherbHumanChallengeAlerted')}
    ${extractFunction(background, 'sendIherbHumanChallengeAlert')}
    ${extractFunction(background, 'retryPendingIherbHumanChallengeAlert')}
    ${extractFunction(background, 'handleIherbPressHoldDetected')}
  `, context);
  return {
    state,
    calls,
    context,
    setAlertFailures(value) { remainingAlertFailures = value; },
    request(patch = {}) {
      return {
        runId: 'run-1',
        account: 'photopochtoy@gmail.com',
        attemptId: 'attempt-1',
        ...patch,
      };
    },
    sender(tabId = 77) { return { tab: { id: tabId } }; },
  };
}

function assertNoForbiddenSideEffects(calls) {
  assert.deepEqual(calls.debugger, []);
  assert.deepEqual(calls.navigation, []);
  assert.deepEqual(calls.abort, []);
  assert.deepEqual(calls.skip, []);
  assert.deepEqual(calls.finalize, []);
  assert.deepEqual(calls.advance, []);
}

test('owned iHerb Press & Hold durably blocks the run and preserves queue/account ownership', async () => {
  const harness = makePressHoldHarness();
  const before = {
    queue: clone(harness.state.trackScreenshotQueue),
    multi: clone(harness.state.multiAccountIherbState),
    pending: clone(harness.state.pendingIherbSwitch),
    budget: clone(harness.state.screenshotStageBudget),
    completed: clone(harness.state.pipelineRun.completed),
  };

  const result = await harness.context.handleIherbPressHoldDetected(
    harness.request(),
    harness.sender(),
  );

  assert.deepEqual(clone(result), {
    blocked: true,
    reason: 'human_required',
    waitingForHuman: true,
  });
  assert.equal(harness.state.pipelineRun.status, 'blocked');
  assert.equal(harness.state.pipelineRun.failures.length, 1);
  assert.deepEqual(harness.state.pipelineRun.failures[0], {
    shop: 'iherb',
    account: 'photopochtoy@gmail.com',
    reason: 'press-hold-human-required',
    at: harness.state.iherbHumanChallenge.detectedAt,
  });
  assert.equal(harness.state.pipelineStage.active, false);
  assert.equal(harness.state.pipelineStage.blockedReason, 'iherb-press-hold-human-required');
  assert.equal(harness.state.lastDailyAutoParseStatus, 'blocked-human-captcha');
  assert.equal(harness.state.stopAllParsers, true);
  assert.deepEqual(harness.state.trackScreenshotQueue, before.queue);
  assert.deepEqual(harness.state.multiAccountIherbState, before.multi);
  assert.deepEqual(harness.state.pendingIherbSwitch, before.pending);
  assert.deepEqual(harness.state.screenshotStageBudget, before.budget);
  assert.deepEqual(harness.state.pipelineRun.completed, before.completed);
  assert.equal(harness.state.iherbSkipReasons, undefined);
  assert.deepEqual({
    kind: harness.state.iherbHumanChallenge.kind,
    status: harness.state.iherbHumanChallenge.status,
    runId: harness.state.iherbHumanChallenge.runId,
    account: harness.state.iherbHumanChallenge.account,
    tabId: harness.state.iherbHumanChallenge.tabId,
    attemptId: harness.state.iherbHumanChallenge.attemptId,
  }, {
    kind: 'press-hold',
    status: 'awaiting-human',
    runId: 'run-1',
    account: 'photopochtoy@gmail.com',
    tabId: 77,
    attemptId: 'attempt-1',
  });
  assert.ok(Number.isFinite(harness.state.iherbHumanChallenge.detectedAt));
  assert.ok(Number.isFinite(harness.state.iherbHumanChallenge.alertedAt));
  assert.equal(harness.calls.alerts.length, 1);
  assert.match(harness.calls.alerts[0], /Press & Hold требует человека/);
  assert.match(harness.calls.alerts[0], /вкладка оставлена без навигации/);
  assertNoForbiddenSideEffects(harness.calls);
});

test('stale or foreign Press & Hold signals are side-effect free', async t => {
  const cases = [
    { name: 'wrong run', request: { runId: 'run-2' } },
    { name: 'wrong account', request: { account: 'questburgh@gmail.com' } },
    { name: 'wrong attempt', request: { attemptId: 'attempt-2' } },
    { name: 'wrong parser tab', tabId: 78 },
    {
      name: 'wrong active stage',
      mutate(state) {
        state.pipelineStage.currentIndex = 1;
        state.pipelineStage.stageName = 'ebay';
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const state = basePressHoldState();
      item.mutate?.(state);
      const harness = makePressHoldHarness({ state });
      const before = clone(harness.state);

      const result = await harness.context.handleIherbPressHoldDetected(
        harness.request(item.request),
        harness.sender(item.tabId ?? 77),
      );

      assert.deepEqual(clone(result), {
        blocked: false,
        reason: 'stale_tab_or_run',
        waitingForHuman: false,
      });
      assert.deepEqual(harness.state, before);
      assert.deepEqual(harness.calls.writes, []);
      assert.deepEqual(harness.calls.alerts, []);
      assertNoForbiddenSideEffects(harness.calls);
    });
  }
});

test('failed Press & Hold alert remains durable and is retried once after restart', async () => {
  const harness = makePressHoldHarness({ alertFailures: 1 });

  const result = await harness.context.handleIherbPressHoldDetected(
    harness.request(),
    harness.sender(),
  );

  assert.equal(result.blocked, true);
  assert.equal(harness.state.iherbHumanChallenge.status, 'awaiting-human');
  assert.equal(harness.state.iherbHumanChallenge.alertedAt, null);
  assert.equal(harness.calls.alerts.length, 1);
  assert.equal(await harness.context.retryPendingIherbHumanChallengeAlert(), true);
  assert.equal(harness.calls.alerts.length, 2);
  assert.ok(Number.isFinite(harness.state.iherbHumanChallenge.alertedAt));
  assert.equal(await harness.context.retryPendingIherbHumanChallengeAlert(), false);
  assert.equal(harness.calls.alerts.length, 2);
  assertNoForbiddenSideEffects(harness.calls);
});

test('unresolved Press & Hold marker blocks the next daily launch even with an empty queue', async () => {
  const state = {
    pipelineStage: { active: false, runId: 'run-1' },
    parsingState: { isParsingAllStores: false },
    screenshotQueueBlocked: null,
    trackScreenshotQueue: [],
    pendingSheetsUpload: null,
    iherbHumanChallenge: {
      kind: 'press-hold',
      status: 'awaiting-human',
      runId: 'run-1',
      account: 'photopochtoy@gmail.com',
      tabId: 77,
      attemptId: 'attempt-1',
      detectedAt: Date.now(),
    },
  };
  const calls = { diagnostics: [], writes: [], create: 0, start: 0, clearLogs: 0 };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    chrome: {
      storage: {
        local: {
          get: async keys => {
            const list = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(list.map(key => [key, clone(state[key])]));
          },
          set: async value => {
            calls.writes.push(clone(value));
            Object.assign(state, clone(value));
          },
        },
      },
    },
    addDailyDiagnostic: async (event, detail) => calls.diagnostics.push({ event, detail: clone(detail) }),
    createPipelineRun: async () => { calls.create++; return { id: 'unexpected' }; },
    startSequentialPipeline: async () => { calls.start++; return { started: true }; },
    clearParsingLogs: async () => { calls.clearLogs++; },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(background, 'runDailyAutoParseOnce'), context);

  assert.equal(await context.runDailyAutoParseOnce('alarm'), false);
  assert.equal(state.lastDailyAutoParseStatus, 'blocked-human-captcha');
  assert.equal(state.lastDailyAutoParseError, 'iHerb Press & Hold still requires a human');
  assert.deepEqual(calls.diagnostics.map(item => item.event), ['run-start', 'run-skip']);
  assert.equal(calls.diagnostics[1].detail.skipReason, 'iherb-press-hold-human-required');
  assert.equal(calls.create, 0);
  assert.equal(calls.start, 0);
  assert.equal(calls.clearLogs, 0);
});

test('Press & Hold path has no automatic debugger solver or navigation capability', () => {
  const handler = extractFunction(background, 'handleIherbPressHoldDetected');
  assert.doesNotMatch(background, /solveIherbPressHold/);
  assert.doesNotMatch(handler, /chrome\.debugger|dbgAttach|dbgSend|Input\.dispatchMouseEvent/);
  assert.doesNotMatch(handler, /chrome\.tabs\.(?:update|create|remove)/);
  assert.doesNotMatch(handler, /abortIherbStageDueToCaptcha|finalizeIherbStage|advancePipelineStage/);
  assert.match(contentIherb, /action:\s*'iherbPressHoldDetected'/);
  assert.match(contentIherb, /Press & Hold detected — waiting for a human/);
  assert.doesNotMatch(contentIherb, /action:\s*'solveIherbPressHold'/);
});
