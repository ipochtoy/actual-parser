import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const source = readFileSync(new URL('background.js', ROOT), 'utf8');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function extractFunction(name) {
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

function baseEbayState(overrides = {}) {
  const stageStartedAt = Date.now() - 20 * 60_000;
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
      currentIndex: 1,
      stageName: 'ebay',
      startedAt: stageStartedAt,
      stageStartedAt,
    },
    progressState: {},
    ebayParserTabId: 77,
    ebayStageDispatch: null,
    trackScreenshotQueue: [],
    screenshotStageBudget: null,
    ...clone(overrides),
  };
}

function makeReconcileHarness(initialState) {
  const state = clone(initialState);
  const calls = {
    clear: [],
    telegram: [],
    uploads: [],
    tabGets: [],
    writes: [],
  };
  const context = {
    PIPELINE_STALE_TIMEOUT_MS: 15 * 60_000,
    PIPELINE_STAGES: ['iherb', 'ebay', 'amazon', 'done'],
    EXPECTED_PIPELINE_ROSTER: {
      iherb: ['photopochtoy@gmail.com', 'questburgh@gmail.com', 'oksanasorokapocht@gmail.com'],
      ebay: ['ipochtoy@gmail.com'],
      amazon: ['ipochtoy@gmail.com', 'photopochtoy@gmail.com'],
    },
    console: { log() {}, warn() {}, error() {} },
    chrome: {
      storage: {
        local: {
          get: async () => clone(state),
          set: async value => {
            calls.writes.push(clone(value));
            Object.assign(state, clone(value));
          },
        },
      },
      tabs: {
        get: async tabId => {
          calls.tabGets.push(tabId);
          throw new Error('exact parser tab is gone');
        },
      },
    },
    updatePipelineRun: async () => {},
    sendTelegramMessage: async message => calls.telegram.push(message),
    uploadToSheets: async () => calls.uploads.push('sheets'),
    uploadLogsToSheet: async () => calls.uploads.push('logs'),
    clearPipelineRuntimeState: async reason => calls.clear.push(reason),
  };
  vm.createContext(context);
  for (const name of [
    'normalizeAccountEmail',
    'pipelineGenerationFromStage',
    'pipelineGenerationMatches',
    'pipelineRunAccountIsTerminal',
    'isCanonicalResumablePipeline',
    'reconcileStalePipelineState',
  ]) {
    vm.runInContext(extractFunction(name), context);
  }
  return {
    state,
    calls,
    run: options => context.reconcileStalePipelineState(options),
  };
}

test('canonical active eBay is never destroyed for a missing tab or mismatched screenshot budget', async () => {
  const base = baseEbayState();
  const harness = makeReconcileHarness({
    ...base,
    trackScreenshotQueue: [{ orderId: 'E1' }],
    screenshotStageBudget: {
      stageName: 'amazon',
      stageStartedAt: base.pipelineStage.stageStartedAt - 1,
      activeSince: Date.now() - 10_000,
    },
  });
  const before = clone(harness.state);

  await harness.run();

  assert.deepEqual(harness.calls.clear, []);
  assert.deepEqual(harness.calls.uploads, []);
  assert.deepEqual(harness.calls.telegram, []);
  assert.deepEqual(harness.calls.tabGets, []);
  assert.deepEqual(harness.state, before);
});

test('eBay matching persisted drain survives a missing parser tab in legacy restart state', async () => {
  const base = baseEbayState();
  // Force the test through the eBay ownership branch rather than the canonical
  // active-run early return. Exact queue/budget ownership must still be kept.
  base.pipelineRun.expected.iherb = [];
  const queue = [{ orderId: 'E1', trackNumber: 'TE1', trackUrl: 'https://order.ebay.com/ord/show?orderid=E1' }];
  const budget = {
    stageName: 'ebay',
    stageStartedAt: base.pipelineStage.stageStartedAt,
    accruedMs: 30_000,
    activeSince: Date.now() - 10_000,
  };
  const harness = makeReconcileHarness({ ...base, trackScreenshotQueue: queue, screenshotStageBudget: budget });
  const before = clone(harness.state);

  await harness.run();

  assert.deepEqual(harness.calls.clear, []);
  assert.deepEqual(harness.calls.uploads, []);
  assert.deepEqual(harness.calls.telegram, []);
  assert.deepEqual(harness.state, before);
});

test('eBay exact terminal success or failure survives a missing parser tab', async t => {
  const cases = [
    {
      name: 'completed account',
      patch: { completed: { iherb: [], ebay: ['ipochtoy@gmail.com'], amazon: [] }, failures: [] },
    },
    {
      name: 'terminal account failure',
      patch: {
        completed: { iherb: [], ebay: [], amazon: [] },
        failures: [{ shop: 'ebay', account: 'ipochtoy@gmail.com', reason: 'parse-error' }],
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const base = baseEbayState();
      base.pipelineRun.expected.iherb = [];
      base.pipelineRun = { ...base.pipelineRun, ...clone(item.patch) };
      const harness = makeReconcileHarness(base);

      await harness.run();

      assert.deepEqual(harness.calls.clear, []);
      assert.deepEqual(harness.calls.uploads, []);
      assert.deepEqual(harness.calls.telegram, []);
    });
  }
});

test('only structurally invalid or foreign eBay ownership is cleaned exactly once', async t => {
  const cases = [
    {
      name: 'foreign pipeline run id',
      mutate(base) {
        base.pipelineRun.id = 'run-2';
      },
    },
    {
      name: 'foreign roster',
      mutate(base) {
        base.pipelineRun.expected.ebay = ['other@example.com'];
      },
    },
    {
      name: 'corrupt stage roster',
      mutate(base) {
        base.pipelineStage.stages = ['iherb', 'ebay', 'done'];
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const base = baseEbayState();
      item.mutate(base);
      const harness = makeReconcileHarness(base);

      await harness.run();

      assert.equal(harness.calls.clear.length, 1);
      assert.match(harness.calls.clear[0], /ebay stage stale/);
      assert.deepEqual(harness.calls.uploads, ['sheets', 'logs']);
      assert.equal(harness.calls.telegram.length, 1);
    });
  }
});

test('restart resume advances an exact terminal eBay account and never redispatches it', async () => {
  const state = baseEbayState();
  state.pipelineRun.completed.ebay = ['ipochtoy@gmail.com'];
  const calls = { advance: [], start: [], tab: [] };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    chrome: { storage: { local: { get: async () => clone(state), remove: async () => {} } } },
    advancePipelineStage: async generation => {
      calls.advance.push(clone(generation));
      return true;
    },
    startEbayStageForPipeline: async generation => {
      calls.start.push(clone(generation));
      return true;
    },
    getEbayParserTab: async tabId => {
      calls.tab.push(tabId);
      return null;
    },
  };
  vm.createContext(context);
  for (const name of [
    'normalizeAccountEmail',
    'pipelineGenerationFromStage',
    'pipelineGenerationMatches',
    'pipelineRunAccountIsTerminal',
    'resumePreparedPipelineStageAfterRestart',
  ]) {
    vm.runInContext(extractFunction(name), context);
  }

  assert.equal(await context.resumePreparedPipelineStageAfterRestart(), true);
  assert.equal(calls.advance.length, 1);
  assert.deepEqual(calls.advance[0], {
    runId: 'run-1',
    startedAt: state.pipelineStage.startedAt,
    currentIndex: 1,
    stageStartedAt: state.pipelineStage.stageStartedAt,
  });
  assert.deepEqual(calls.start, []);
  assert.deepEqual(calls.tab, []);
});

test('terminal eBay restart waits for the real screenshot drain before starting Amazon', async () => {
  const state = baseEbayState({
    trackScreenshotQueue: [{ orderId: 'E1', account: 'ipochtoy@gmail.com' }],
  });
  state.pipelineRun.completed.ebay = ['ipochtoy@gmail.com'];

  let signalDrainStarted;
  const drainStarted = new Promise(resolve => { signalDrainStarted = resolve; });
  let resolveDrain;
  const drainResult = new Promise(resolve => { resolveDrain = resolve; });
  const calls = { runStage: [], stop: [], startEbay: [], tab: [], writes: [] };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    pipelineAdvanceInFlight: null,
    screenshotsEnabled: true,
    trackScreenshotQueue: clone(state.trackScreenshotQueue),
    isProcessingScreenshots: false,
    chrome: {
      storage: {
        local: {
          get: async () => clone(state),
          set: async value => {
            calls.writes.push(clone(value));
            Object.assign(state, clone(value));
          },
          remove: async () => {},
        },
      },
    },
    waitForScreenshotsDrained: async () => {
      signalDrainStarted();
      return drainResult;
    },
    stopPipelineForScreenshotDrain: async (...args) => {
      calls.stop.push(clone(args));
      return false;
    },
    runPipelineStage: async (...args) => {
      calls.runStage.push(clone(args));
      return true;
    },
    startEbayStageForPipeline: async generation => {
      calls.startEbay.push(clone(generation));
      return true;
    },
    getEbayParserTab: async tabId => {
      calls.tab.push(tabId);
      return null;
    },
  };
  vm.createContext(context);
  for (const name of [
    'normalizeAccountEmail',
    'pipelineGenerationFromStage',
    'pipelineGenerationMatches',
    'pipelineRunAccountIsTerminal',
    'advancePipelineStageOnce',
    'advancePipelineStage',
    'resumePreparedPipelineStageAfterRestart',
  ]) {
    vm.runInContext(extractFunction(name), context);
  }

  const resume = context.resumePreparedPipelineStageAfterRestart();
  await drainStarted;

  assert.equal(state.pipelineStage.currentIndex, 1);
  assert.equal(state.pipelineStage.stageName, 'ebay');
  assert.deepEqual(calls.runStage, []);
  assert.deepEqual(calls.startEbay, []);
  assert.deepEqual(calls.tab, []);

  context.trackScreenshotQueue.length = 0;
  state.trackScreenshotQueue = [];
  resolveDrain(true);

  assert.equal(await resume, true);
  assert.equal(state.pipelineStage.currentIndex, 2);
  assert.equal(state.pipelineStage.stageName, 'amazon');
  assert.deepEqual(calls.runStage, [['amazon', 'run-1']]);
  assert.deepEqual(calls.stop, []);
});
