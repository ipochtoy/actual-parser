import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createStorage(initial, hooks = {}) {
  const data = copy(initial);
  const writes = [];
  return {
    data,
    writes,
    local: {
      async get(keys) {
        if (hooks.beforeGet) await hooks.beforeGet(keys, data);
        if (keys == null) return copy(data);
        if (typeof keys === 'string') return { [keys]: copy(data[keys]) };
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map(key => [key, copy(data[key])]));
        }
        return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
          key,
          data[key] === undefined ? copy(fallback) : copy(data[key]),
        ]));
      },
      async set(patch) {
        const snapshot = copy(patch);
        if (hooks.beforeSet) await hooks.beforeSet(snapshot, data);
        Object.assign(data, snapshot);
        writes.push(snapshot);
        if (hooks.afterSet) await hooks.afterSet(snapshot, data);
      },
      async remove(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        if (hooks.beforeRemove) await hooks.beforeRemove(list, data);
        for (const key of list) delete data[key];
      },
    },
  };
}

function makeRuntime({ terminal = false, orderData = undefined } = {}) {
  const account = 'old@example.com';
  const nextAccount = 'next@example.com';
  const stage = {
    active: true,
    runId: 'run-1',
    startedAt: 100,
    currentIndex: 2,
    stageStartedAt: 200,
    stages: ['iherb', 'ebay', 'amazon'],
  };
  const pagination = {
    runId: 'run-1',
    account,
    parserTabId: 9,
    stageStartedAt: 200,
    accountSwitchStartedAt: 300,
    parseId: 'parse-1',
    currentPage: 17,
    totalPages: 20,
    startedAt: 250,
    allOrders: [],
    cancelledOrders: [],
  };
  return {
    pipelineRun: {
      id: 'run-1',
      status: 'running',
      expected: { iherb: [], ebay: [], amazon: [account, nextAccount] },
      completed: { iherb: [], ebay: [], amazon: [] },
      failures: terminal
        ? [{ shop: 'amazon', account, reason: 'parse-timeout', found: 0 }]
        : [],
    },
    pipelineStage: stage,
    multiAccountState: {
      isMultiAccountParsing: true,
      amazonAccountsQueue: [nextAccount],
      currentAmazonAccount: account,
    },
    amazonParserTabId: 9,
    accountSwitchStartedAt: 300,
    lastAmazonProgressAt: 300,
    amazonPaginationState: pagination,
    amazonTimeoutAttempt: null,
    amazonParsingComplete: null,
    amazonStageFinalizing: null,
    orderData: orderData || {},
    amazonCancelledOrders: [],
  };
}

function attemptFrom(runtime) {
  return {
    runId: runtime.pipelineRun.id,
    stageStartedAt: runtime.pipelineStage.stageStartedAt,
    account: runtime.multiAccountState.currentAmazonAccount,
    parserTabId: runtime.amazonParserTabId,
    accountSwitchStartedAt: runtime.accountSwitchStartedAt,
    parseId: runtime.amazonPaginationState.parseId,
  };
}

function cursorRequest(runtime) {
  return {
    kind: 'cursor',
    attempt: attemptFrom(runtime),
    paginationState: copy(runtime.amazonPaginationState),
  };
}

function navigationRequest(runtime) {
  const targetUrl = 'https://www.amazon.com/gp/your-account/order-history?orderFilter=months-3&startIndex=160';
  const paginationState = copy(runtime.amazonPaginationState);
  paginationState.navigation = {
    navId: 'nav-17',
    targetPage: 17,
    targetUrl,
    fromUrl: 'https://www.amazon.com/gp/your-account/order-history?startIndex=150',
    startedAt: 400,
  };
  return {
    kind: 'navigate',
    attempt: attemptFrom(runtime),
    paginationState,
    targetUrl,
  };
}

function completionRequest(runtime, orders = []) {
  const paginationState = copy(runtime.amazonPaginationState);
  delete paginationState.navigation;
  return {
    kind: 'complete',
    attempt: attemptFrom(runtime),
    paginationState,
    orders,
    cancelledOrders: [],
    reason: 'configured-limit',
  };
}

const REAL_FUNCTIONS = [
  'normalizeAccountEmail',
  'pipelineGenerationFromStage',
  'pipelineGenerationMatches',
  'pipelineRunAccountIsTerminal',
  'withPipelineRunWrite',
  'applyPipelineAccountResult',
  'updatePipelineRun',
  'markPipelineAccountResult',
  'amazonWatchdogAttemptFromState',
  'amazonWatchdogAttemptIdentityMatches',
  'amazonWatchdogAttemptMatches',
  'amazonCompletionMatchesAttempt',
  'withAmazonAttemptMutation',
  'amazonAttemptRefFromPayload',
  'amazonAttemptRefMatchesRuntime',
  'amazonPaginationPayloadMatchesAttempt',
  'isSafeAmazonOrdersUrl',
  'handleAmazonAttemptCommit',
  'claimAmazonTimeoutAttempt',
  'finalizeAmazonTimeoutAttempt',
  'consumeAmazonCompletionMarker',
  'switchToNextAmazonAccount',
  'resumePreparedPipelineStageAfterRestart',
];

function createHarness(initial, { storageHooks = {}, updateTab = null } = {}) {
  const storage = createStorage(initial, storageHooks);
  const tabUpdates = [];
  const dispatches = [];
  const context = {
    URL,
    Date,
    Promise,
    structuredClone,
    console: { log() {}, warn() {}, error() {} },
    chrome: {
      storage: { local: storage.local },
      tabs: {
        async update(tabId, update) {
          tabUpdates.push({ tabId, update: copy(update) });
          if (updateTab) await updateTab(tabId, update);
          return { id: tabId, ...update };
        },
      },
    },
    amazonAttemptMutationChain: Promise.resolve(),
    pipelineRunWriteChain: Promise.resolve(),
    isMultiAccountParsing: false,
    amazonAccountsQueue: [],
    currentAmazonAccount: null,
    parseReport: { stores: {} },
    waitForScreenshotsDrained: async () => true,
    stopPipelineForScreenshotDrain: async () => false,
    logMultiAccountStep: async () => true,
    dispatchCurrentAmazonAccountSwitch: async (email, generation, kind) => {
      dispatches.push({ email, generation: copy(generation), kind });
      return true;
    },
    beginAmazonStageFinalization: async () => true,
  };
  vm.createContext(context);
  for (const name of REAL_FUNCTIONS) {
    vm.runInContext(extractFunction(background, name), context);
  }
  return { context, storage, tabUpdates, dispatches };
}

test('cursor and account transition serialize safely in both queue orders', async () => {
  {
    const runtime = makeRuntime({ terminal: true });
    const entered = deferred();
    const release = deferred();
    let blockCursor = true;
    const harness = createHarness(runtime, {
      storageHooks: {
        async beforeSet(patch) {
          if (blockCursor && patch.amazonPaginationState?.parseId === 'parse-1'
              && !Object.hasOwn(patch, 'pendingAccountSwitch')) {
            blockCursor = false;
            entered.resolve();
            await release.promise;
          }
        },
      },
    });
    const generation = harness.context.pipelineGenerationFromStage(runtime.pipelineStage);
    const commitPromise = harness.context.handleAmazonAttemptCommit(cursorRequest(runtime), 9);
    await entered.promise;
    const transitionPromise = harness.context.switchToNextAmazonAccount(generation);
    release.resolve();
    const [commit, transition] = await Promise.all([commitPromise, transitionPromise]);

    assert.equal(commit.ok, true);
    assert.equal(transition, true);
    assert.equal(harness.storage.data.multiAccountState.currentAmazonAccount, 'next@example.com');
    assert.equal(harness.storage.data.amazonPaginationState, null);
    const cursorWrite = harness.storage.writes.find(patch => patch.amazonPaginationState?.parseId === 'parse-1');
    const transitionWrite = harness.storage.writes.find(patch => patch.pendingAccountSwitch?.email === 'next@example.com');
    assert.ok(cursorWrite, 'cursor must commit when it owns the arbiter first');
    assert.ok(transitionWrite, 'transition must commit after the cursor owner leaves the arbiter');
    assert.ok(harness.storage.writes.indexOf(cursorWrite) < harness.storage.writes.indexOf(transitionWrite));
  }

  {
    const runtime = makeRuntime({ terminal: true });
    const entered = deferred();
    const release = deferred();
    let blockTransition = true;
    const harness = createHarness(runtime, {
      storageHooks: {
        async beforeSet(patch) {
          if (blockTransition && patch.pendingAccountSwitch?.email === 'next@example.com') {
            blockTransition = false;
            entered.resolve();
            await release.promise;
          }
        },
      },
    });
    const generation = harness.context.pipelineGenerationFromStage(runtime.pipelineStage);
    const transitionPromise = harness.context.switchToNextAmazonAccount(generation);
    await entered.promise;
    const commitPromise = harness.context.handleAmazonAttemptCommit(cursorRequest(runtime), 9);
    release.resolve();
    const [transition, commit] = await Promise.all([transitionPromise, commitPromise]);

    assert.equal(transition, true);
    assert.equal(commit.ok, false);
    assert.equal(commit.status, 'stale');
    assert.equal(commit.reason, 'run-account-generation-changed');
    assert.equal(harness.storage.data.multiAccountState.currentAmazonAccount, 'next@example.com');
    assert.equal(harness.storage.data.amazonPaginationState, null);
    assert.equal(
      harness.storage.writes.filter(patch => patch.amazonPaginationState?.parseId === 'parse-1').length,
      0,
      'the old cursor must perform zero writes after the transition owns the arbiter',
    );
  }
});

test('navigation save plus tabs.update cannot be split by an account transition', async () => {
  {
    const runtime = makeRuntime({ terminal: true });
    const tabEntered = deferred();
    const releaseTab = deferred();
    const trace = [];
    const harness = createHarness(runtime, {
      storageHooks: {
        beforeSet(patch) {
          if (patch.amazonPaginationState?.navigation?.navId === 'nav-17') trace.push('navigation-saved');
          if (patch.pendingAccountSwitch?.email === 'next@example.com') trace.push('transition-saved');
        },
      },
      updateTab: async () => {
        trace.push('tab-update-start');
        tabEntered.resolve();
        await releaseTab.promise;
        trace.push('tab-update-end');
      },
    });
    const generation = harness.context.pipelineGenerationFromStage(runtime.pipelineStage);
    const navigatePromise = harness.context.handleAmazonAttemptCommit(navigationRequest(runtime), 9);
    await tabEntered.promise;
    const transitionPromise = harness.context.switchToNextAmazonAccount(generation);
    await Promise.resolve();
    assert.equal(harness.storage.data.multiAccountState.currentAmazonAccount, 'old@example.com');
    releaseTab.resolve();
    const [navigation, transition] = await Promise.all([navigatePromise, transitionPromise]);

    assert.equal(navigation.ok, true);
    assert.equal(navigation.status, 'navigating');
    assert.equal(transition, true);
    assert.deepEqual(trace, [
      'navigation-saved',
      'tab-update-start',
      'tab-update-end',
      'transition-saved',
    ]);
    assert.equal(harness.tabUpdates.length, 1);
    assert.equal(harness.storage.data.amazonPaginationState, null);
  }

  {
    const runtime = makeRuntime({ terminal: true });
    const entered = deferred();
    const release = deferred();
    const harness = createHarness(runtime, {
      storageHooks: {
        async beforeSet(patch) {
          if (patch.pendingAccountSwitch?.email === 'next@example.com') {
            entered.resolve();
            await release.promise;
          }
        },
      },
    });
    const generation = harness.context.pipelineGenerationFromStage(runtime.pipelineStage);
    const transitionPromise = harness.context.switchToNextAmazonAccount(generation);
    await entered.promise;
    const navigatePromise = harness.context.handleAmazonAttemptCommit(navigationRequest(runtime), 9);
    release.resolve();
    const [transition, navigation] = await Promise.all([transitionPromise, navigatePromise]);

    assert.equal(transition, true);
    assert.equal(navigation.ok, false);
    assert.equal(navigation.status, 'stale');
    assert.equal(harness.tabUpdates.length, 0);
    assert.equal(harness.storage.data.amazonPaginationState, null);
  }
});

test('completion and timeout have deterministic priority for final-first, resolving-first and failed-first', async () => {
  {
    const runtime = makeRuntime();
    const attempt = attemptFrom(runtime);
    const harness = createHarness(runtime);
    const completion = await harness.context.handleAmazonAttemptCommit(
      completionRequest(runtime, [{ order_id: 'A-1', track_number: 'T-1', product_name: 'Widget' }]),
      9,
    );
    const timeout = await harness.context.claimAmazonTimeoutAttempt(attempt);

    assert.equal(completion.ok, true);
    assert.equal(timeout.status, 'completion-won');
    assert.equal(harness.storage.data.amazonParsingComplete.parseId, 'parse-1');
    assert.equal(harness.storage.data.amazonTimeoutAttempt, null);
    assert.equal(harness.storage.data.pipelineRun.failures.length, 0);
  }

  {
    const runtime = makeRuntime();
    const attempt = attemptFrom(runtime);
    const harness = createHarness(runtime);
    const claim = await harness.context.claimAmazonTimeoutAttempt(attempt);
    const writesAfterClaim = harness.storage.writes.length;
    const completion = await harness.context.handleAmazonAttemptCommit(
      completionRequest(runtime, [{ order_id: 'A-2', track_number: 'T-2', product_name: 'Gadget' }]),
      9,
    );
    const failure = await harness.context.finalizeAmazonTimeoutAttempt(attempt, 'no progress', 3);

    assert.equal(claim.status, 'claimed');
    assert.equal(completion.ok, true);
    assert.equal(writesAfterClaim, 1);
    assert.equal(failure.status, 'completion-won');
    assert.equal(harness.storage.data.amazonParsingComplete.parseId, 'parse-1');
    assert.equal(harness.storage.data.amazonTimeoutAttempt, null);
    assert.equal(harness.storage.data.amazonPaginationState.completedAt > 0, true);
    assert.equal(harness.storage.data.pipelineRun.failures.length, 0);
  }

  {
    const runtime = makeRuntime();
    const attempt = attemptFrom(runtime);
    const harness = createHarness(runtime);
    const claim = await harness.context.claimAmazonTimeoutAttempt(attempt);
    const failure = await harness.context.finalizeAmazonTimeoutAttempt(attempt, 'no progress', 3);
    const writesAfterFailure = harness.storage.writes.length;
    const lateCompletion = await harness.context.handleAmazonAttemptCommit(
      completionRequest(runtime, [{ order_id: 'A-3', track_number: 'T-3', product_name: 'Late' }]),
      9,
    );
    assert.equal(claim.status, 'claimed');
    assert.equal(failure.status, 'failed');
    assert.equal(lateCompletion.ok, false);
    assert.equal(lateCompletion.status, 'stale');
    assert.equal(harness.storage.writes.length, writesAfterFailure);
    assert.equal(harness.storage.data.amazonTimeoutAttempt.phase, 'failed');
    assert.equal(harness.storage.data.amazonPaginationState, null);
    assert.equal(harness.storage.data.pipelineRun.failures.at(-1).reason, 'no progress');
  }

  {
    const runtime = makeRuntime();
    const attempt = attemptFrom(runtime);
    runtime.amazonTimeoutAttempt = { ...attempt, phase: 'failed', resolvedAt: 500 };
    const harness = createHarness(runtime);
    const completion = await harness.context.handleAmazonAttemptCommit(
      completionRequest(runtime, [{ order_id: 'A-4', track_number: 'T-4', product_name: 'Too late' }]),
      9,
    );
    assert.equal(completion.ok, false);
    assert.equal(completion.reason, 'timeout-won');
    assert.equal(harness.storage.writes.length, 0);
  }
});

test('Amazon completion records the exact last parsed page for both terminal doors', async () => {
  for (const { reason, cursor, lastCompletedPage } of [
    { reason: 'configured-limit', cursor: 21, lastCompletedPage: 20 },
    { reason: 'explicit-end', cursor: 8, lastCompletedPage: 7 },
  ]) {
    const runtime = makeRuntime();
    runtime.amazonPaginationState.currentPage = cursor;
    runtime.amazonPaginationState.totalPages = 20;
    const request = completionRequest(runtime, []);
    request.reason = reason;
    request.paginationState.currentPage = cursor;
    const harness = createHarness(runtime);
    const result = await harness.context.handleAmazonAttemptCommit(request, 9);
    assert.equal(result.ok, true);
    assert.equal(harness.storage.data.amazonParsingComplete.lastCompletedPage, lastCompletedPage);
    assert.equal(harness.storage.data.amazonPaginationState.currentPage, cursor);
  }
});

test('restart consumes a valid completion before an older terminal failure', async () => {
  const runtime = makeRuntime({ terminal: true });
  const attempt = attemptFrom(runtime);
  runtime.amazonParsingComplete = {
    ...attempt,
    timestamp: 600,
    found: 4,
    reason: 'configured-limit',
  };
  runtime.amazonTimeoutAttempt = { ...attempt, phase: 'failed', resolvedAt: 550 };
  const harness = createHarness(runtime);

  const resumed = await harness.context.resumePreparedPipelineStageAfterRestart();

  assert.equal(resumed, true);
  assert.deepEqual(harness.storage.data.pipelineRun.completed.amazon, ['old@example.com']);
  assert.equal(
    harness.storage.data.pipelineRun.failures.some(failure => failure.shop === 'amazon'
      && failure.account === 'old@example.com'),
    false,
  );
  assert.equal(harness.storage.data.amazonParsingComplete, null);
  assert.equal(harness.storage.data.amazonTimeoutAttempt, null);
  assert.equal(harness.storage.data.multiAccountState.currentAmazonAccount, 'next@example.com');
  assert.equal(harness.dispatches.length, 1);
  assert.equal(harness.dispatches[0].email, 'next@example.com');
});

test('fresh final merge keeps current attempt metadata for duplicate Amazon rows', async () => {
  const existingDuplicate = {
    order_id: 'A-10',
    track_number: 'T-10',
    product_name: 'Widget',
    status: 'old',
    parser_run_id: 'run-old',
    parser_account: 'stale@example.com',
    observed_at: '2026-01-01T00:00:00.000Z',
  };
  const existingOther = {
    order_id: 'A-11',
    track_number: 'T-11',
    product_name: 'Other',
    status: 'kept',
  };
  const runtime = makeRuntime({
    orderData: {
      Amazon: { orders: [existingDuplicate, existingOther], lastParsed: 'old' },
    },
  });
  const harness = createHarness(runtime);
  const result = await harness.context.handleAmazonAttemptCommit(
    completionRequest(runtime, [{
      order_id: 'A-10',
      track_number: 'T-10',
      product_name: 'Widget',
      status: 'fresh',
      parser_run_id: 'spoofed',
      parser_account: 'spoofed@example.com',
      observed_at: 'spoofed',
    }]),
    9,
  );

  assert.equal(result.ok, true);
  assert.equal(result.totalCount, 2);
  const merged = harness.storage.data.orderData.Amazon.orders;
  const current = merged.find(order => order.order_id === 'A-10');
  assert.equal(current.status, 'fresh');
  assert.equal(current.parser_run_id, 'run-1');
  assert.equal(current.parser_account, 'old@example.com');
  assert.notEqual(current.observed_at, 'spoofed');
  assert.equal(merged.find(order => order.order_id === 'A-11').status, 'kept');

  const finalWrite = harness.storage.writes.find(patch => patch.amazonParsingComplete?.parseId === 'parse-1');
  assert.ok(finalWrite?.orderData?.Amazon);
  assert.equal(finalWrite.amazonPaginationState.parseId, 'parse-1');
  assert.equal(finalWrite.amazonTimeoutAttempt, null);
});

test('stale cursor, navigation and final attempts perform zero shared writes', async () => {
  const runtime = makeRuntime();
  const harness = createHarness(runtime);
  const staleRuntime = makeRuntime();
  staleRuntime.pipelineRun.id = 'run-stale';
  staleRuntime.pipelineStage.runId = 'run-stale';
  staleRuntime.amazonPaginationState.runId = 'run-stale';

  const requests = [
    cursorRequest(staleRuntime),
    navigationRequest(staleRuntime),
    completionRequest(staleRuntime, [{ order_id: 'STALE', track_number: 'X', product_name: 'Old' }]),
  ];
  for (const request of requests) {
    const result = await harness.context.handleAmazonAttemptCommit(request, 9);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'stale');
    assert.equal(result.reason, 'run-account-generation-changed');
  }

  assert.equal(harness.storage.writes.length, 0);
  assert.equal(harness.tabUpdates.length, 0);
  assert.equal(harness.storage.data.amazonParsingComplete, null);
  assert.equal(harness.storage.data.amazonPaginationState.parseId, 'parse-1');
});
