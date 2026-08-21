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
  let paren = 0;
  let closeParen = -1;
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === '(') paren++;
    if (source[i] === ')' && --paren === 0) { closeParen = i; break; }
  }
  const openBrace = source.indexOf('{', closeParen);
  let braces = 0;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === '{') braces++;
    if (source[i] === '}' && --braces === 0) return source.slice(start, i + 1);
  }
  assert.fail(`${name} body incomplete`);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function leaseContext(initialLease = undefined) {
  const state = {};
  if (initialLease !== undefined) state.nightCabinetLease = clone(initialLease);
  const writes = [];
  const context = {
    Date,
    Math,
    Number,
    Object,
    Set,
    String,
    Intl,
    globalThis: {},
    NIGHT_CABINET_LEASE_KEY: 'nightCabinetLease',
    NIGHT_CABINET_LEASE_TTL_MS: 15 * 60_000,
    NIGHT_CABINET_TIME_ZONE: 'America/New_York',
    NIGHT_CABINET_OWNERS: new Set(['store-walk', 'parser']),
    NIGHT_CABINET_PHASES: new Set([
      'claimed', 'running', 'ready', 'store-main', 'store-catchup', 'recover',
      'completed', 'degraded', 'blocked', 'failed',
    ]),
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const result = {};
            for (const key of keys) result[key] = clone(state[key]);
            return result;
          },
          async set(mutation) {
            writes.push(clone(mutation));
            Object.assign(state, clone(mutation));
          },
        },
      },
    },
  };
  vm.createContext(context);
  for (const name of [
    'nightCabinetSlotDay',
    'inspectNightCabinetLease',
    'prepareParserNightCabinetLease',
    'externalCoordinatorStartDecision',
  ]) vm.runInContext(extractFunction(name), context);
  return { context, state, writes };
}

function storeWalkLease(overrides = {}) {
  return {
    slotId: '1787281200000',
    owner: 'store-walk',
    phase: 'running',
    token: 'store-walk-token-0001',
    heartbeat: 1_000_000,
    expires: 1_600_000,
    ...overrides,
  };
}

test('23:00 collision defers while an exact store-walk lease is alive', async () => {
  const lease = storeWalkLease();
  const { context, writes } = leaseContext(lease);
  const result = await context.prepareParserNightCabinetLease({
    slotId: lease.slotId,
    now: 1_100_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'store-walk-active');
  assert.equal(writes.length, 0, 'Parser must not overwrite the store-walk owner');

  const runner = extractFunction('runDailyAutoParseOnce');
  assert.ok(runner.indexOf('prepareParserNightCabinetLease') < runner.indexOf('createPipelineRun'),
    'lease proof must precede pipeline creation');
  assert.match(runner, /scheduleNightCabinetRetry\(String\(slotId\), leaseResult\.reason\)/);
});

test('coordinator store phases are valid leases and still block Parser', async () => {
  for (const phase of ['store-main', 'store-catchup', 'recover']) {
    const lease = storeWalkLease({ phase });
    const { context, writes } = leaseContext(lease);
    assert.equal(context.inspectNightCabinetLease(lease, { now: 1_100_000 }).state, 'active', phase);
    const result = await context.prepareParserNightCabinetLease({ slotId: lease.slotId, now: 1_100_000 });
    assert.equal(result.reason, 'store-walk-active', phase);
    assert.equal(writes.length, 0, phase);
  }
});

test('an expired lease is never claimed by an internal Parser alarm', async () => {
  const old = storeWalkLease({ heartbeat: 100_000, expires: 200_000 });
  const { context, state, writes } = leaseContext(old);
  const result = await context.prepareParserNightCabinetLease({
    slotId: old.slotId,
    now: 300_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'external-coordinator-proof-required');
  assert.deepEqual(state.nightCabinetLease, old);
  assert.equal(writes.length, 0);
});

test('a delayed Store Walk claim cannot be overwritten by fixed or retry alarms', async () => {
  const { context, state, writes } = leaseContext();
  const slotId = '1787281200000';

  const fixedResult = await context.prepareParserNightCabinetLease({ slotId, now: 300_000 });
  assert.equal(fixedResult.reason, 'external-coordinator-proof-required');
  state.nightCabinetLease = storeWalkLease({ slotId, heartbeat: 300_001, expires: 900_001 });
  const retryResult = await context.prepareParserNightCabinetLease({ slotId, now: 300_002 });

  assert.equal(retryResult.reason, 'store-walk-active');
  assert.equal(state.nightCabinetLease.owner, 'store-walk');
  assert.equal(writes.length, 0, 'neither internal alarm may write the owner slot');
});

test('external coordinator proof starts exactly once and rejects stale or wrong proof', () => {
  const ready = {
    ...storeWalkLease(),
    owner: 'parser',
    phase: 'ready',
    token: 'parser-token-exact-0001',
  };
  const { context } = leaseContext(ready);
  const exact = { slotId: ready.slotId, token: ready.token };

  assert.equal(context.externalCoordinatorStartDecision(exact, ready, {
    now: 1_100_000,
  }).start, true);
  assert.equal(context.externalCoordinatorStartDecision(exact, ready, {
    now: 1_100_000,
    alreadyTriggered: true,
  }).reason, 'pipeline-already-started');
  assert.equal(context.externalCoordinatorStartDecision({
    ...exact,
    token: 'wrong-token-00000001',
  }, ready, { now: 1_100_000 }).start, false);
  assert.equal(context.externalCoordinatorStartDecision({
    ...exact,
    slotId: '1787194800000',
  }, ready, { now: 1_100_000 }).start, false);
  assert.equal(context.externalCoordinatorStartDecision(exact, {
    ...ready,
    expires: 1_050_000,
  }, { now: 1_100_000 }).start, false);

  const handler = extractFunction('handleExternalControlRequest');
  assert.match(handler, /externalCoordinatorStartDecision/);
  assert.match(handler, /external: true/);
  assert.match(handler, /decision\.lease\.slotId/);
  assert.match(handler, /decision\.lease\.token/);
});

test('a terminal same-slot run permits one rotated exact coordinator token only', () => {
  const ready = {
    ...storeWalkLease(),
    owner: 'parser',
    phase: 'ready',
    token: 'parser-token-attempt-0002',
  };
  const { context } = leaseContext(ready);
  const request = { slotId: ready.slotId, token: ready.token };
  const previous = {
    id: 'run-night-1',
    status: 'degraded',
    nightSlotDay: '2026-08-20',
    nightRequestToken: 'parser-token-attempt-0001',
  };

  assert.equal(context.externalCoordinatorStartDecision(request, ready, {
    now: 1_100_000,
    alreadyTriggered: true,
    previousRun: previous,
  }).start, true);
  assert.equal(context.externalCoordinatorStartDecision(request, ready, {
    now: 1_100_000,
    alreadyTriggered: true,
    previousRun: { ...previous, nightRequestToken: ready.token },
  }).start, false, 'the same token must not start twice');
  assert.equal(context.externalCoordinatorStartDecision(request, ready, {
    now: 1_100_000,
    alreadyTriggered: true,
    previousRun: { ...previous, status: 'running' },
  }).start, false, 'a nonterminal previous run must not overlap');
  assert.equal(context.externalCoordinatorStartDecision(request, ready, {
    now: 1_100_000,
    alreadyTriggered: true,
    previousRun: { ...previous, nightSlotDay: '2026-08-19' },
  }).start, false, 'a terminal run from another slot is not retry proof');
});

test('a terminal legacy run in the exact slot can be adopted once by the coordinator', () => {
  const ready = {
    ...storeWalkLease(), owner: 'parser', phase: 'ready', token: 'parser-token-first-0001',
  };
  const { context } = leaseContext(ready);
  const request = { slotId: ready.slotId, token: ready.token };

  assert.equal(context.externalCoordinatorStartDecision(request, ready, {
    now: 1_100_000,
    alreadyTriggered: true,
    previousRun: { id: 'legacy-terminal', status: 'degraded', slotAt: Number(ready.slotId) },
  }).start, true);
  assert.equal(context.externalCoordinatorStartDecision(request, ready, {
    now: 1_100_000,
    alreadyTriggered: true,
    previousRun: { id: 'legacy-foreign', status: 'degraded', slotAt: Number(ready.slotId) - 86_400_000 },
  }).start, false);
  assert.equal(context.externalCoordinatorStartDecision(request, ready, {
    now: 1_100_000,
    alreadyTriggered: true,
    previousRun: { id: 'legacy-active', status: 'running', slotAt: Number(ready.slotId) },
  }).start, false);
});

test('slot day and coordinator adoption fields are deterministic and atomically stored', () => {
  const context = {
    Date,
    Number,
    Object,
    Intl,
    NIGHT_CABINET_TIME_ZONE: 'America/New_York',
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('nightCabinetSlotDay'), context);
  assert.equal(context.nightCabinetSlotDay('1787281200000'), '2026-08-20');

  const createRun = extractFunction('createPipelineRun');
  assert.match(createRun, /nightRequestToken: currentLease\.lease\.token/);
  assert.match(createRun, /nightSlotDay,/);
  assert.match(createRun, /pipelineRun,[\s\S]*?\[NIGHT_CABINET_LEASE_KEY\]: \{/);
});

test('Parser adopts exact ready token atomically and leaves terminal ownership to coordinator', async () => {
  const ready = {
    ...storeWalkLease(),
    owner: 'parser',
    phase: 'ready',
    token: 'parser-token-exact-0001',
  };
  const runner = extractFunction('runDailyAutoParseOnce');
  assert.match(runner, /createPipelineRun\(source, nightLease\)/);
  const createRun = extractFunction('createPipelineRun');
  assert.match(createRun, /pipelineRun,[\s\S]*?\[NIGHT_CABINET_LEASE_KEY\]: \{/);
  assert.match(createRun, /phase: 'running'/);
  assert.match(createRun, /runId: pipelineRun\.id/);
  const terminal = extractFunction('finishTerminalPipelineState');
  assert.doesNotMatch(terminal, /NIGHT_CABINET_LEASE_KEY|nightCabinetLease|markParserNightCabinetLease/);
  assert.doesNotMatch(source, /function markParserNightCabinetLease|markParserNightCabinetLeaseForRun/);
});

test('terminal commit cannot overwrite coordinator lease after a crash or takeover', async () => {
  const lease = storeWalkLease({
    owner: 'parser',
    phase: 'running',
    runId: 'run-night-1',
  });
  const state = {
    pipelineStage: {
      active: true,
      runId: 'run-night-1',
      stages: ['iherb', 'ebay', 'amazon', 'done'],
      currentIndex: 3,
    },
    nightCabinetLease: clone(lease),
  };
  const writes = [];
  const context = {
    Date,
    console,
    isParsingAllStores: true,
    storesCompleted: { ebay: false, iherb: false, amazon: false },
    checkAllStoresCompleted: async () => {},
    chrome: {
      storage: {
        local: {
          async get() { return { pipelineStage: clone(state.pipelineStage) }; },
          async set(mutation) {
            writes.push(clone(mutation));
            Object.assign(state, clone(mutation));
          },
        },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('finishTerminalPipelineState'), context);

  assert.equal(await context.finishTerminalPipelineState({
    id: 'run-night-1', status: 'degraded', finishedAt: 1_200_000,
  }), true);
  assert.deepEqual(state.nightCabinetLease, lease);
  assert.equal(state.pipelineStage.active, false);
  assert.equal(writes.some(write => Object.hasOwn(write, 'nightCabinetLease')), false);
});

test('retry alarm is idempotent and stops at its bounded attempt count', async () => {
  const state = {};
  const alarms = [];
  const context = {
    Date,
    Number,
    NIGHT_CABINET_RETRY_KEY: 'nightCabinetRetryState',
    NIGHT_CABINET_RETRY_ALARM: 'nightCabinetLeaseRetry',
    NIGHT_CABINET_RETRY_MINUTES: 10,
    NIGHT_CABINET_RETRY_MAX: 3,
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const result = {};
            for (const key of keys) result[key] = clone(state[key]);
            return result;
          },
          async set(mutation) { Object.assign(state, clone(mutation)); },
        },
      },
      alarms: {
        create(name, options) { alarms.push({ name, options: clone(options) }); },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('scheduleNightCabinetRetry'), context);

  const slotId = '1787281200000';
  const first = await context.scheduleNightCabinetRetry(slotId, 'store-walk-active', { now: 1_000 });
  const duplicate = await context.scheduleNightCabinetRetry(slotId, 'store-walk-active', { now: 2_000 });
  assert.equal(first.attempts, 1);
  assert.equal(duplicate.idempotent, true);
  assert.equal(state.nightCabinetRetryState.attempts, 1);
  assert.equal(alarms.length, 1);

  const second = await context.scheduleNightCabinetRetry(slotId, 'store-walk-active', {
    now: first.scheduledFor + 1,
  });
  const third = await context.scheduleNightCabinetRetry(slotId, 'store-walk-active', {
    now: second.scheduledFor + 1,
  });
  const exhausted = await context.scheduleNightCabinetRetry(slotId, 'store-walk-active', {
    now: third.scheduledFor + 1,
  });
  assert.equal(third.attempts, 3);
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.attempts, 3);
  assert.equal(alarms.length, 3);
});

test('malformed and unreadable lease state fail closed', async () => {
  const malformed = storeWalkLease({ unexpected: true });
  const { context } = leaseContext(malformed);
  assert.equal(context.inspectNightCabinetLease(malformed, { now: 1_100_000 }).state, 'malformed');
  const result = await context.prepareParserNightCabinetLease({
    slotId: malformed.slotId,
    now: 1_100_000,
  });
  assert.equal(result.ok, false);

  context.chrome.storage.local.get = async () => { throw new Error('storage down'); };
  const unreadable = await context.prepareParserNightCabinetLease({
    slotId: malformed.slotId,
    now: 1_100_000,
  });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.reason, 'lease-unreadable');
});

function controlWakeHarness({ request, lastHandledControlAt = 0, result = null } = {}) {
  const now = Date.now();
  const slotId = '1787281200000';
  const token = 'parser-token-wake-0001';
  const state = {
    externalControlRequest: clone(request),
    lastHandledControlAt,
    externalControlResult: clone(result),
    pendingSheetsUpload: null,
    lastSheetsUploadOkAt: null,
    lastDailyAutoParseFinishedAt: null,
    pipelineStage: { active: false },
    pipelineRun: null,
    lastDailyAutoParseTriggeredAt: null,
    nightCabinetLease: {
      slotId,
      owner: 'parser',
      phase: 'ready',
      token,
      heartbeat: now - 1_000,
      expires: now + 10 * 60_000,
    },
  };
  let starts = 0;
  const context = {
    Date,
    Number,
    Object,
    Set,
    String,
    Intl,
    NIGHT_CABINET_LEASE_KEY: 'nightCabinetLease',
    NIGHT_CABINET_LEASE_TTL_MS: 15 * 60_000,
    NIGHT_CABINET_TIME_ZONE: 'America/New_York',
    NIGHT_CABINET_OWNERS: new Set(['store-walk', 'parser']),
    NIGHT_CABINET_PHASES: new Set([
      'claimed', 'running', 'ready', 'store-main', 'store-catchup', 'recover',
      'completed', 'degraded', 'blocked', 'failed',
    ]),
    getLastDailyRunSlot() { return { getTime: () => Number(slotId) }; },
    async runDailyAutoParse() { starts++; return true; },
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const out = {};
            for (const key of keys) out[key] = clone(state[key]);
            return out;
          },
          async set(mutation) { Object.assign(state, clone(mutation)); },
        },
      },
    },
  };
  vm.createContext(context);
  for (const name of [
    'nightCabinetSlotDay',
    'inspectNightCabinetLease',
    'externalCoordinatorStartDecision',
    'handleExternalControlRequest',
    'handleNightCoordinatorControlWake',
  ]) vm.runInContext(extractFunction(name), context);
  return { context, state, starts: () => starts, slotId, token };
}

test('runtime wake ignores stale or missing durable requests', async () => {
  const missing = controlWakeHarness();
  const noRequest = await missing.context.handleNightCoordinatorControlWake({
    action: 'nightCoordinatorControlWake',
  });
  assert.equal(noRequest.ok, true);
  assert.equal(noRequest.handled, false);
  assert.equal(noRequest.reason, 'no-request');
  assert.equal(missing.starts(), 0);

  const staleResult = { action: 'start_pipeline', ok: true, at: 99 };
  const stale = controlWakeHarness({
    request: { action: 'start_pipeline', requestedAt: 100 },
    lastHandledControlAt: 100,
    result: staleResult,
  });
  const replay = await stale.context.handleNightCoordinatorControlWake({
    action: 'nightCoordinatorControlWake',
  });
  assert.equal(replay.handled, false);
  assert.equal(replay.reason, 'request-already-handled');
  assert.deepEqual(JSON.parse(JSON.stringify(replay.externalControlResult)), staleResult);
  assert.equal(stale.starts(), 0);
});

test('runtime wake consumes one exact durable request and never accepts start proof in payload', async () => {
  const requestedAt = Date.now();
  const harness = controlWakeHarness();
  harness.state.externalControlRequest = {
    action: 'start_pipeline',
    requestedAt,
    slotId: harness.slotId,
    token: harness.token,
  };

  const first = await harness.context.handleNightCoordinatorControlWake({
    action: 'nightCoordinatorControlWake',
  });
  assert.equal(first.ok, true);
  assert.equal(first.handled, true);
  assert.equal(first.externalControlResult.ok, true);
  assert.equal(first.externalControlResult.reason, 'pipeline-started');
  assert.equal(harness.starts(), 1);
  assert.equal(harness.state.externalControlRequest, null);

  const second = await harness.context.handleNightCoordinatorControlWake({
    action: 'nightCoordinatorControlWake',
  });
  assert.equal(second.handled, false);
  assert.equal(harness.starts(), 1);

  const injected = await harness.context.handleNightCoordinatorControlWake({
    action: 'nightCoordinatorControlWake',
    slotId: harness.slotId,
    token: harness.token,
  });
  assert.equal(injected.ok, false);
  assert.equal(injected.reason, 'wake-payload-refused');
  assert.equal(harness.starts(), 1);

  const listener = source.slice(source.indexOf('chrome.runtime.onMessage.addListener'),
    source.indexOf('function saveParsingState'));
  assert.match(listener, /request\.action === 'nightCoordinatorControlWake'/);
  assert.match(listener, /handleNightCoordinatorControlWake\(request\)/);
});

function leaseTransitionHarness({ destination = 'store-walk', blockTransitionSet = false } = {}) {
  const now = 1_000_000;
  const slotId = '1787281200000';
  const oldToken = 'parser-terminal-token-0001';
  const nextToken = destination === 'parser'
    ? 'parser-retry-token-000002'
    : 'store-walk-token-next-0002';
  const lease = {
    slotId,
    owner: 'parser',
    phase: 'running',
    token: oldToken,
    runId: 'run-terminal-1',
    heartbeat: 100_000,
    expires: 200_000,
  };
  const state = {
    nightCabinetLease: clone(lease),
    nightCoordinatorLeaseTransitionRequest: {
      requestId: `transition-request-${destination}-0001`,
      requestedAt: now - 1,
      expected: {
        state: 'present', slotId, owner: 'parser', phase: 'running',
        token: oldToken, runId: lease.runId,
      },
      desired: {
        slotId,
        owner: destination,
        phase: destination === 'parser' ? 'ready' : 'claimed',
        token: nextToken,
      },
    },
    pipelineRun: {
      id: lease.runId,
      status: 'completed',
      finishedAt: now - 10_000,
      slotAt: Number(slotId),
      nightRequestToken: oldToken,
      nightSlotDay: '2026-08-20',
    },
    pipelineStage: {
      active: false,
      runId: lease.runId,
      stages: ['iherb', 'ebay', 'amazon', 'done'],
      currentIndex: 3,
      stageName: 'done',
    },
    trackScreenshotQueue: [],
    screenshotQueueBlocked: null,
    pendingSheetsUpload: null,
    lastSheetsUploadRunId: lease.runId,
    lastSheetsUploadOkAt: now - 1_000,
  };
  let releaseSet;
  let transitionSetEntered;
  const setEntered = new Promise(resolve => { transitionSetEntered = resolve; });
  const setRelease = new Promise(resolve => { releaseSet = resolve; });
  let blocked = false;
  const writes = [];
  const context = {
    Date: class extends Date { static now() { return now; } },
    Math,
    Number,
    Object,
    Set,
    String,
    Intl,
    structuredClone,
    nightCabinetLeaseWriteChain: Promise.resolve(),
    NIGHT_CABINET_LEASE_KEY: 'nightCabinetLease',
    NIGHT_CABINET_LEASE_TTL_MS: 15 * 60_000,
    NIGHT_CABINET_TIME_ZONE: 'America/New_York',
    NIGHT_CABINET_OWNERS: new Set(['store-walk', 'parser']),
    NIGHT_CABINET_PHASES: new Set([
      'claimed', 'running', 'ready', 'store-main', 'store-catchup', 'recover',
      'completed', 'degraded', 'blocked', 'failed',
    ]),
    NIGHT_CABINET_TRANSITION_REQUEST_KEY: 'nightCoordinatorLeaseTransitionRequest',
    NIGHT_CABINET_TRANSITION_RESULT_KEY: 'nightCoordinatorLeaseTransitionResult',
    NIGHT_CABINET_TRANSITION_HANDLED_KEY: 'lastHandledNightCoordinatorLeaseTransitionId',
    NIGHT_CABINET_CATCHUP_RESUME_KEY: 'nightCabinetCatchupResumeMarkers',
    nightCabinetSlotId() { return slotId; },
    nightCabinetSlotDay() { return '2026-08-20'; },
    async loadAccountsConfig() { return {}; },
    buildExpectedPipelineRoster() { return { iherb: [], ebay: [], amazon: [] }; },
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const out = {};
            for (const key of keys) out[key] = clone(state[key]);
            return out;
          },
          async set(mutation) {
            if (blockTransitionSet && !blocked
                && mutation.nightCoordinatorLeaseTransitionResult?.ok === true) {
              blocked = true;
              transitionSetEntered();
              await setRelease;
            }
            writes.push(clone(mutation));
            Object.assign(state, clone(mutation));
          },
        },
      },
    },
  };
  vm.createContext(context);
  for (const name of [
    'inspectNightCabinetLease',
    'withNightCabinetLeaseWrite',
    'nightCabinetTerminalProof',
    'nightCabinetTerminalSlotProof',
    'inspectNightCabinetTransitionRequest',
    'nightCabinetTransitionAllowed',
    'handleNightCoordinatorLeaseTransitionRequest',
    'handleNightCoordinatorLeaseTransitionWake',
    'createPipelineRun',
  ]) vm.runInContext(extractFunction(name), context);
  return {
    context, state, lease, slotId, nextToken, writes,
    setEntered, releaseSet,
  };
}

test('terminal proof hands exact Parser ownership to Store Walk and refuses false green', async () => {
  const valid = leaseTransitionHarness({ destination: 'store-walk' });
  const result = await valid.context.handleNightCoordinatorLeaseTransitionWake({
    action: 'nightCoordinatorLeaseTransitionWake',
  });
  assert.equal(result.ok, true);
  assert.equal(valid.state.nightCabinetLease.owner, 'store-walk');
  assert.equal(valid.state.nightCabinetLease.phase, 'claimed');
  assert.equal(valid.state.nightCabinetLease.token, valid.nextToken);

  for (const phase of ['claimed', 'running', 'store-main', 'store-catchup', 'recover']) {
    assert.equal(valid.context.nightCabinetTransitionAllowed(valid.lease, {
      slotId: valid.slotId,
      owner: 'store-walk',
      phase,
      token: `store-destination-${phase}-token`,
    }, { terminalProof: true }).ok, true, phase);
  }

  assert.equal(valid.context.nightCabinetTransitionAllowed({
    ...valid.lease,
    owner: 'store-walk',
    phase: 'completed',
    slotId: '1787194800000',
  }, {
    slotId: valid.slotId,
    owner: 'store-walk',
    phase: 'claimed',
    token: 'next-slot-store-token-0001',
  }, { currentState: 'expired' }).ok, true);
  assert.equal(valid.context.nightCabinetTransitionAllowed({
    ...valid.lease,
    slotId: '1787194800000',
  }, {
    slotId: valid.slotId,
    owner: 'store-walk',
    phase: 'claimed',
    token: 'next-slot-store-token-0001',
  }, { currentState: 'expired', terminalProof: false }).reason, 'parser-terminal-proof-required');

  for (const breakProof of [
    state => { state.pipelineStage.active = true; },
    state => { state.trackScreenshotQueue.push({ track: 'still-pending' }); },
    state => { state.screenshotQueueBlocked = { reason: 'blocked' }; },
    state => { state.pendingSheetsUpload = { runId: 'run-terminal-1' }; },
    state => { state.lastSheetsUploadOkAt = state.pipelineRun.finishedAt - 1; },
  ]) {
    const invalid = leaseTransitionHarness({ destination: 'store-walk' });
    breakProof(invalid.state);
    const rejected = await invalid.context.handleNightCoordinatorLeaseTransitionRequest();
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'parser-terminal-proof-required');
    assert.deepEqual(invalid.state.nightCabinetLease, invalid.lease);
  }
});

test('degraded Store Walk gets one exact durable catch-up resume after terminal Parser proof', async () => {
  const harness = leaseTransitionHarness({ destination: 'store-walk' });
  const oldToken = 'degraded-store-token-0001';
  const newToken = 'catchup-resume-token-0002';
  const degraded = {
    slotId: harness.slotId,
    owner: 'store-walk',
    phase: 'degraded',
    token: oldToken,
    heartbeat: 100_000,
    expires: 200_000,
  };
  harness.state.nightCabinetLease = clone(degraded);
  harness.state.nightCoordinatorLeaseTransitionRequest = {
    requestId: 'catchup-resume-request-0001',
    requestedAt: 999_999,
    expected: {
      state: 'present', slotId: harness.slotId, owner: 'store-walk', phase: 'degraded',
      token: oldToken,
    },
    desired: {
      slotId: harness.slotId, owner: 'store-walk', phase: 'store-catchup', token: newToken,
    },
  };
  delete harness.state.lastHandledNightCoordinatorLeaseTransitionId;
  delete harness.state.nightCoordinatorLeaseTransitionResult;

  const first = await harness.context.handleNightCoordinatorLeaseTransitionRequest();
  assert.equal(first.ok, true);
  assert.equal(first.reason, 'catchup-resume-one-shot');
  assert.equal(harness.state.nightCabinetLease.phase, 'store-catchup');
  assert.equal(harness.state.nightCabinetLease.token, newToken);
  const markerKey = `${harness.slotId}:${oldToken}`;
  assert.deepEqual(harness.state.nightCabinetCatchupResumeMarkers[markerKey], {
    slotId: harness.slotId,
    oldToken,
    newToken,
    parserRunId: harness.state.pipelineRun.id,
    consumedAt: 1_000_000,
  });
  const atomic = harness.writes.find(write => write.nightCoordinatorLeaseTransitionResult?.requestId
    === 'catchup-resume-request-0001');
  assert.equal(atomic.nightCabinetLease.token, newToken);
  assert.equal(atomic.nightCabinetCatchupResumeMarkers[markerKey].newToken, newToken,
    'lease and one-shot marker must share one storage.set');

  harness.state.nightCabinetLease = clone(degraded);
  harness.state.nightCoordinatorLeaseTransitionRequest = {
    ...harness.state.nightCoordinatorLeaseTransitionRequest,
    requestId: 'catchup-resume-request-0002',
  };
  const repeat = await harness.context.handleNightCoordinatorLeaseTransitionRequest();
  assert.equal(repeat.ok, false);
  assert.equal(repeat.reason, 'catchup-resume-already-consumed');
  assert.deepEqual(harness.state.nightCabinetLease, degraded);
});

test('each distinct degraded Store Walk token gets one same-slot resume, never one global resume', async () => {
  const harness = leaseTransitionHarness({ destination: 'store-walk' });
  const tokens = Array.from({ length: 7 }, (_, index) => `catchup-budget-token-${String(index).padStart(4, '0')}`);
  const transition = async (oldToken, newToken, index) => {
    harness.state.nightCabinetLease = {
      slotId: harness.slotId, owner: 'store-walk', phase: 'degraded', token: oldToken,
      heartbeat: 100_000 + index, expires: 200_000 + index,
    };
    harness.state.nightCoordinatorLeaseTransitionRequest = {
      requestId: `multi-catchup-resume-${index}`,
      requestedAt: 999_999,
      expected: {
        state: 'present', slotId: harness.slotId, owner: 'store-walk', phase: 'degraded', token: oldToken,
      },
      desired: {
        slotId: harness.slotId, owner: 'store-walk', phase: 'store-catchup', token: newToken,
      },
    };
    delete harness.state.lastHandledNightCoordinatorLeaseTransitionId;
    delete harness.state.nightCoordinatorLeaseTransitionResult;
    return harness.context.handleNightCoordinatorLeaseTransitionRequest();
  };

  for (let index = 0; index < 6; index++) {
    assert.equal((await transition(tokens[index], tokens[index + 1], index + 1)).ok, true,
      `bounded continuation ${index + 1} must accept its distinct exact old token`);
  }
  assert.deepEqual(Object.keys(harness.state.nightCabinetCatchupResumeMarkers).sort(),
    tokens.slice(0, 6).map(token => `${harness.slotId}:${token}`).sort());
  const replay = await transition(tokens[0], 'catchup-resume-token-foreign', 3);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'catchup-resume-already-consumed');
});

test('catch-up resume refuses foreign, nonterminal and malformed durable proof', async () => {
  const configure = (harness) => {
    const oldToken = 'degraded-store-token-0001';
    harness.state.nightCabinetLease = {
      slotId: harness.slotId, owner: 'store-walk', phase: 'degraded', token: oldToken,
      heartbeat: 100_000, expires: 200_000,
    };
    harness.state.nightCoordinatorLeaseTransitionRequest = {
      requestId: 'catchup-resume-refusal-0001',
      requestedAt: 999_999,
      expected: {
        state: 'present', slotId: harness.slotId, owner: 'store-walk', phase: 'degraded',
        token: oldToken,
      },
      desired: {
        slotId: harness.slotId, owner: 'store-walk', phase: 'store-catchup',
        token: 'catchup-resume-token-0002',
      },
    };
    delete harness.state.lastHandledNightCoordinatorLeaseTransitionId;
    delete harness.state.nightCoordinatorLeaseTransitionResult;
  };

  for (const [label, breakProof, reason] of [
    ['foreign slot', state => { state.pipelineRun.slotAt -= 86_400_000; }, 'catchup-resume-terminal-proof-required'],
    ['nonterminal run', state => { state.pipelineRun.status = 'running'; }, 'catchup-resume-terminal-proof-required'],
    ['nonempty queue', state => { state.trackScreenshotQueue.push({ track: 'pending' }); }, 'catchup-resume-terminal-proof-required'],
    ['foreign Sheets run', state => { state.lastSheetsUploadRunId = 'foreign-run'; }, 'catchup-resume-terminal-proof-required'],
    ['malformed marker', state => { state.nightCabinetCatchupResumeMarkers = []; }, 'catchup-resume-marker-malformed'],
  ]) {
    const harness = leaseTransitionHarness({ destination: 'store-walk' });
    configure(harness);
    const before = clone(harness.state.nightCabinetLease);
    breakProof(harness.state);
    const result = await harness.context.handleNightCoordinatorLeaseTransitionRequest();
    assert.equal(result.ok, false, label);
    assert.equal(result.reason, reason, label);
    assert.deepEqual(harness.state.nightCabinetLease, before, label);
    assert.equal(harness.state.nightCabinetCatchupResumeMarkers?.[`${harness.slotId}:${before.token}`], undefined, label);
  }
});

test('retry-ready handoff and ready-to-running start share one deterministic barrier', async () => {
  const harness = leaseTransitionHarness({ destination: 'parser', blockTransitionSet: true });
  const transition = harness.context.handleNightCoordinatorLeaseTransitionRequest();
  await harness.setEntered;

  const readyProof = { slotId: harness.slotId, token: harness.nextToken };
  const start = harness.context.createPipelineRun('barrier-test', readyProof);
  let startSettled = false;
  start.finally(() => { startSettled = true; });
  await Promise.resolve();
  assert.equal(startSettled, false, 'ready-to-running must wait behind the transition writer');

  harness.releaseSet();
  assert.equal((await transition).ok, true);
  const run = await start;
  assert.equal(harness.state.nightCabinetLease.owner, 'parser');
  assert.equal(harness.state.nightCabinetLease.phase, 'running');
  assert.equal(harness.state.nightCabinetLease.runId, run.id);
  assert.equal(harness.state.pipelineRun.id, run.id);
});

test('a delayed Store Walk heartbeat cannot overwrite Parser running ownership', async () => {
  const harness = leaseTransitionHarness({ destination: 'parser' });
  assert.equal((await harness.context.handleNightCoordinatorLeaseTransitionRequest()).ok, true);
  const run = await harness.context.createPipelineRun('stale-heartbeat-test', {
    slotId: harness.slotId,
    token: harness.nextToken,
  });
  const running = clone(harness.state.nightCabinetLease);

  harness.state.nightCoordinatorLeaseTransitionRequest = {
    requestId: 'delayed-store-heartbeat-0001',
    requestedAt: 999_999,
    expected: {
      state: 'present', slotId: harness.slotId, owner: 'store-walk', phase: 'running',
      token: 'old-store-heartbeat-token-1',
    },
    desired: {
      slotId: harness.slotId, owner: 'store-walk', phase: 'running',
      token: 'old-store-heartbeat-token-1',
    },
  };
  const stale = await harness.context.handleNightCoordinatorLeaseTransitionRequest();
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'transition-current-proof-mismatch');
  assert.deepEqual(harness.state.nightCabinetLease, running);
  assert.equal(harness.state.nightCabinetLease.runId, run.id);

  const injected = await harness.context.handleNightCoordinatorLeaseTransitionWake({
    action: 'nightCoordinatorLeaseTransitionWake',
    token: running.token,
  });
  assert.equal(injected.ok, false);
  assert.equal(injected.reason, 'transition-wake-payload-refused');
});
