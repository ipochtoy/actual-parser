import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const AT = Date.parse('2026-09-09T13:00:00Z');
const LEDGER = 'standaloneWalkGenerationLedger';
const terminalPhases = ['completed', 'degraded', 'blocked', 'failed'];

function actualFunction(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, name);
  const end = source.indexOf('\n}\n', match.index);
  assert.ok(end > match.index, name);
  return source.slice(match.index, end + 2);
}

function harness() {
  const store = { trackScreenshotQueue: [] }, writes = [], clock = { now: AT };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const context = vm.createContext({
    Date: Clock, Intl, console, Promise, Set, Object, Number, String, Math, JSON,
    chrome: { storage: { local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys])
        .filter(key => key in store).map(key => [key, structuredClone(store[key])])),
      set: async mutation => { writes.push(structuredClone(mutation)); Object.assign(store, structuredClone(mutation)); },
    } } },
    readParserRejectedUploadProof: async () => null,
  });
  const names = [
    'getNextDailyRun', 'getLastDailyRunSlot', 'nightCabinetSlotId', 'nightCabinetLeaseSlotIds',
    'nightCabinetSlotDay', 'nightCabinetNativeAdmissionAt', 'inspectNightCabinetLease',
    'withNightCabinetLeaseWrite', 'nightCabinetTerminalProof', 'nightCabinetTerminalSlotProof',
    'inspectManualControlEnvelope', 'manualControlEnvelopeEqual', 'manualControlTokenAllowed',
    'manualControlTransitionProof', 'inspectStandaloneWalkEnvelope', 'standaloneWalkTokenAllowed',
    'inspectStandaloneWalkLedger', 'standaloneWalkCurrentRecord', 'standaloneWalkTransitionProof',
    'storeWalkParserIdleProof', 'inspectNightCabinetTransitionRequest', 'nightCabinetTransitionAllowed',
    'handleNightCoordinatorLeaseTransitionRequest', 'handleNightCoordinatorLeaseTransitionWake',
  ];
  vm.runInContext(source.slice(0, source.indexOf('let dailyDiagnosticWriteQueue'))
    + '\nlet nightCabinetLeaseWriteChain = Promise.resolve();\n'
    + names.map(actualFunction).join('\n'), context);
  const envelope = (overrides = {}) => ({
    schemaVersion: 1, kind: 'standalone-store-walk', id: crypto.randomUUID(),
    runId: `store-walk:1234:${clock.now}`, requestSha: 'a'.repeat(64), createdAt: clock.now,
    deadlineAt: Math.min(clock.now + 6 * 3600_000, context.nightCabinetNativeAdmissionAt(clock.now) - 900_000),
    nextNativeAdmissionAt: context.nightCabinetNativeAdmissionAt(clock.now), ...overrides,
  });
  const desired = (e, phase = 'store-main') => ({
    slotId: String(e.createdAt), owner: 'store-walk', phase, token: `standalone:${e.id}:walk`,
  });
  const expected = () => {
    const current = store.nightCabinetLease;
    return current ? {
      state: 'present', slotId: current.slotId, owner: current.owner, phase: current.phase,
      token: current.token, heartbeat: current.heartbeat, expires: current.expires,
      ...(current.runId ? { runId: current.runId } : {}),
    } : { state: 'missing' };
  };
  const request = (e, phase = 'store-main', overrides = {}) => ({
    requestId: `request-${crypto.randomUUID()}`, requestedAt: clock.now,
    expected: expected(), desired: desired(e, phase), standaloneWalk: e, ...overrides,
  });
  const send = async value => {
    store.nightCoordinatorLeaseTransitionRequest = structuredClone(value);
    return context.handleNightCoordinatorLeaseTransitionWake({ action: 'nightCoordinatorLeaseTransitionWake' });
  };
  const transition = (e, phase = 'store-main', overrides = {}) => send(request(e, phase, overrides));
  return { store, writes, clock, context, envelope, desired, expected, request, send, transition };
}

const authority = h => JSON.stringify([h.store.nightCabinetLease, h.store[LEDGER],
  h.store.pipelineRun, h.store.pipelineStage, h.store.pendingSheetsUpload, h.store.trackScreenshotQueue]);

test('partial standalone grant, renewal and terminal close share one durable lease and generation', async () => {
  const h = harness();
  const immutableRequest = { only: ['iherb-1'], noTail: false, noBlind: true, noAdd: false };
  const e = h.envelope({ requestSha: crypto.createHash('sha256').update(JSON.stringify(immutableRequest)).digest('hex') });
  const first = await h.transition(e);
  assert.equal(first.ok, true);
  assert.equal(h.store.nightCabinetLease.owner, 'store-walk');
  assert.equal(h.store.nightCabinetLease.expires, AT + 900_000);
  assert.deepEqual(h.store[LEDGER].generations[e.id], {
    schemaVersion: 1, envelope: e, admittedAt: AT, closedAt: null, terminalPhase: null,
  });
  assert.ok(h.writes.some(write => write.nightCabinetLease && write[LEDGER] && write.nightCoordinatorLeaseTransitionResult?.ok));
  h.clock.now += 30_000;
  assert.equal((await h.transition(e)).ok, true);
  const renewed = structuredClone(h.store.nightCabinetLease);
  h.clock.now += 30_000;
  assert.equal((await h.transition(e, 'completed')).ok, true);
  assert.deepEqual(h.store.nightCabinetLease, { ...renewed, phase: 'completed' });
  assert.equal(h.store[LEDGER].generations[e.id].closedAt, h.clock.now);
  assert.equal(h.store[LEDGER].generations[e.id].terminalPhase, 'completed');
  assert.equal(h.store.pipelineRun, undefined);
  assert.equal(h.store.manualControlGenerationIndex, undefined);
});

for (const kind of ['missing', 'null', 'extra', 'hash', 'run-id', 'future', 'late', 'deadline', 'native-at', 'both-kinds', 'parser', 'catchup']) {
  test(`standalone ${kind} cannot allocate a lease or generation`, async () => {
    const h = harness(), e = h.envelope();
    const request = h.request(e);
    if (kind === 'missing') delete request.standaloneWalk;
    if (kind === 'null') request.standaloneWalk = null;
    if (kind === 'extra') e.force = true;
    if (kind === 'hash') e.requestSha = 'bad';
    if (kind === 'run-id') e.runId = `store-walk:1234:${AT - 1}`;
    if (kind === 'future') e.createdAt = AT + 1;
    if (kind === 'late') h.clock.now += 120_001;
    if (kind === 'deadline') e.deadlineAt = e.nextNativeAdmissionAt;
    if (kind === 'native-at') e.nextNativeAdmissionAt += 60_000;
    if (kind === 'both-kinds') request.manualControl = { ...e, kind: 'manual-control' };
    if (kind === 'parser') Object.assign(request.desired, { owner: 'parser', phase: 'ready' });
    if (kind === 'catchup') request.desired.phase = 'store-catchup';
    const before = authority(h);
    assert.equal((await h.send(request)).ok, false);
    assert.equal(authority(h), before);
  });
}

for (const [key, value] of [
  ['pipelineRun', { id: 'unleased', status: 'running' }],
  ['pipelineRun', { id: 'unknown', status: 'mystery' }],
  ['pipelineStage', { active: true }], ['pipelineStage', { active: 'false' }],
  ['parsingState', { isParsingAllStores: true }], ['parsingState', false],
  ['iherbStageFinalizing', {}], ['amazonStageFinalizing', {}],
  ['pendingIherbSwitch', {}], ['pendingAccountSwitch', {}], ['pendingSheetsUpload', {}],
  ['screenshotQueueBlocked', {}], ['trackScreenshotQueue', [{}]], ['trackScreenshotQueue', null],
]) {
  test(`atomic first grant refuses Parser work or unknown ${key} ${JSON.stringify(value)}`, async () => {
    for (const type of ['standalone', 'native']) {
      const h = harness(), e = h.envelope();
      h.store[key] = value;
      const request = type === 'standalone' ? h.request(e) : {
        requestId: `native-${crypto.randomUUID()}`, requestedAt: AT, expected: { state: 'missing' },
        desired: { slotId: h.context.nightCabinetSlotId(AT), owner: 'store-walk', phase: 'recover', token: 'native-recover-token-0001' },
      };
      const before = authority(h);
      assert.equal((await h.send(request)).ok, false, type);
      assert.equal(authority(h), before, type);
    }
  });
}

test('queued writer re-reads Parser state after an earlier serialized start', async () => {
  const h = harness(), e = h.envelope();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const start = h.context.withNightCabinetLeaseWrite(async () => {
    await barrier;
    await h.context.chrome.storage.local.set({ pipelineRun: { id: 'started-first', status: 'running' } });
  });
  const admission = h.transition(e);
  release();
  await start;
  assert.equal((await admission).ok, false);
  assert.equal(h.store.nightCabinetLease, undefined);
  assert.equal(h.store[LEDGER], undefined);
});

test('competing machines cannot both win a missing-lease snapshot', async () => {
  const h = harness(), a = h.envelope(), b = h.envelope({ runId: `store-walk:5678:${AT}` });
  const first = h.request(a), staleSecond = h.request(b);
  assert.equal((await h.send(first)).ok, true);
  const before = authority(h);
  assert.equal((await h.send(staleSecond)).reason, 'transition-current-proof-mismatch');
  assert.equal(authority(h), before);
  assert.equal(h.store[LEDGER].generations[b.id], undefined);
});

for (const expired of [false, true]) {
  test(`foreign ${expired ? 'expired but unsettled' : 'live'} Store Walk lease never rolls over`, async () => {
    for (const mode of ['standalone', 'native']) {
      const h = harness(), e = h.envelope();
      h.store.nightCabinetLease = {
        slotId: String(AT - 86400_000), owner: 'store-walk', phase: 'store-main', token: 'foreign-store-walk-token',
        heartbeat: AT - 900_000, expires: expired ? AT - 1 : AT + 900_000,
      };
      const request = mode === 'standalone' ? h.request(e) : {
        requestId: `native-${crypto.randomUUID()}`, requestedAt: AT, expected: h.expected(),
        desired: { slotId: h.context.nightCabinetSlotId(AT), owner: 'store-walk', phase: 'recover', token: 'native-recover-token-0001' },
      };
      const before = authority(h);
      assert.equal((await h.send(request)).ok, false);
      assert.equal(authority(h), before);
    }
  });
}

test('closed A cannot revive after terminal B expires; an old runId cannot be assigned a new generation', async () => {
  const h = harness(), a = h.envelope();
  assert.equal((await h.transition(a)).ok, true);
  assert.equal((await h.transition(a, 'completed')).ok, true);
  h.clock.now += 901_000;
  const b = h.envelope();
  assert.equal((await h.transition(b)).ok, true);
  assert.equal((await h.transition(b, 'completed')).ok, true);
  h.clock.now += 901_000;
  const before = authority(h);
  assert.equal((await h.transition(a)).ok, false);
  assert.equal(authority(h), before);

  const separate = harness(), old = separate.envelope();
  await separate.transition(old);
  await separate.transition(old, 'completed');
  delete separate.store.nightCabinetLease; // Simulate a lost pointer, not lost durable closure.
  const duplicate = { ...old, id: crypto.randomUUID() };
  const beforeDuplicate = authority(separate);
  assert.equal((await separate.transition(duplicate)).reason, 'standalone-run-already-consumed');
  assert.equal(authority(separate), beforeDuplicate);
});

for (const phase of terminalPhases) {
  test(`expired standalone may only settle ${phase} with exact times, without renewing browser access`, async () => {
    const h = harness(), e = h.envelope();
    await h.transition(e);
    const lease = structuredClone(h.store.nightCabinetLease);
    h.clock.now = e.deadlineAt + 86400_000;
    assert.equal((await h.transition(e)).ok, false);
    const request = h.request(e, phase);
    assert.equal((await h.send(request)).ok, true);
    assert.deepEqual(h.store.nightCabinetLease, { ...lease, phase });
    assert.equal(h.store[LEDGER].generations[e.id].terminalPhase, phase);
    assert.equal((await h.transition(e)).ok, false);
  });
}

test('lost or expired standalone work cannot renew; cleanup can close only the exact surviving owner', async () => {
  for (const changed of ['expired', 'missing', 'foreign', 'ledger']) {
    const h = harness(), e = h.envelope();
    await h.transition(e);
    if (changed === 'expired') h.clock.now = h.store.nightCabinetLease.expires;
    if (changed === 'missing') delete h.store.nightCabinetLease;
    if (changed === 'foreign') h.store.nightCabinetLease.token = 'foreign-native-token0001';
    if (changed === 'ledger') delete h.store[LEDGER];
    const before = authority(h);
    assert.equal((await h.transition(e)).ok, false, changed);
    assert.equal(authority(h), before);
    if (changed !== 'expired') assert.equal((await h.transition(e, 'degraded')).ok, false, changed);
  }
});

test('a missing lease pointer cannot hide an unclosed standalone generation from a new native or standalone owner', async () => {
  for (const type of ['native', 'standalone']) {
    const h = harness(), old = h.envelope();
    await h.transition(old);
    delete h.store.nightCabinetLease;
    h.clock.now++;
    const e = h.envelope();
    const request = type === 'standalone' ? h.request(e) : {
      requestId: `native-${crypto.randomUUID()}`, requestedAt: h.clock.now, expected: { state: 'missing' },
      desired: { slotId: h.context.nightCabinetSlotId(h.clock.now), owner: 'store-walk', phase: 'recover', token: 'native-after-lost-pointer-0001' },
    };
    const before = authority(h);
    assert.equal((await h.send(request)).reason, 'standalone-owner-work-unproven');
    assert.equal(authority(h), before);
  }
});

test('late exact heartbeat may cover cleanup reserve but never extend the immutable deadline', async () => {
  const h = harness();
  h.clock.now = Date.parse('2026-09-09T23:45:00Z'); // 19:45 New York.
  const e = h.envelope();
  assert.equal(e.deadlineAt, Date.parse('2026-09-10T00:15:00Z'));
  assert.equal((await h.transition(e)).ok, true);
  h.clock.now += 899_000;
  assert.equal((await h.transition(e)).ok, true);
  h.clock.now += 60_000; // Past the 20:00 work cutoff, still cleaning up.
  assert.equal((await h.transition(e)).ok, true);
  assert.equal(h.store.nightCabinetLease.expires, e.deadlineAt);
  h.clock.now = e.deadlineAt;
  assert.equal((await h.transition(e)).ok, false);
});

test('post-write uncertainty and duplicate requests never allocate a second generation', async () => {
  const h = harness(), e = h.envelope();
  const request = h.request(e), set = h.context.chrome.storage.local.set;
  h.context.chrome.storage.local.set = async values => {
    await set(values);
    throw Error('disconnect after durable commit');
  };
  await assert.rejects(h.send(request), /disconnect/);
  assert.equal(Object.keys(h.store[LEDGER].generations).length, 1);
  h.context.chrome.storage.local.set = set;
  const n = h.writes.length;
  assert.equal((await h.send(request)).ok, true);
  assert.equal(h.writes.length, n);
});

test('write failure before commit issues neither a phantom lease nor a consumed generation', async () => {
  const h = harness(), e = h.envelope();
  h.context.chrome.storage.local.set = async () => { throw Error('quota'); };
  await assert.rejects(h.transition(e), /quota/);
  assert.equal(h.store.nightCabinetLease, undefined);
  assert.equal(h.store[LEDGER], undefined);
});

test('ledger corruption, capacity and unsettled prior day cannot be silently rebuilt or truncated', async () => {
  for (const kind of ['record', 'duplicate-run', 'full', 'unsettled-day']) {
    const h = harness(), e = h.envelope();
    await h.transition(e);
    await h.transition(e, 'completed');
    delete h.store.nightCabinetLease;
    if (kind === 'record') h.store[LEDGER].generations[e.id].closedAt = 'wrong';
    if (kind === 'duplicate-run') {
      const id = crypto.randomUUID();
      h.store[LEDGER].generations[id] = { ...h.store[LEDGER].generations[e.id], envelope: { ...e, id } };
    }
    if (kind === 'full') for (let i = 1; i < 128; i++) {
      const id = crypto.randomUUID();
      h.store[LEDGER].generations[id] = {
        ...h.store[LEDGER].generations[e.id], envelope: { ...e, id, runId: `store-walk:${1234 + i}:${AT}` },
      };
    }
    if (kind === 'unsettled-day') {
      Object.assign(h.store[LEDGER].generations[e.id], { closedAt: null, terminalPhase: null });
      h.clock.now += 86400_000;
    } else h.clock.now++;
    const next = h.envelope(), before = authority(h);
    assert.equal((await h.transition(next)).ok, false, kind);
    assert.equal(authority(h), before, kind);
  }
});

test('a fully closed expired prior day rotates one bounded ledger, while old descriptors stay refused', async () => {
  const h = harness(), old = h.envelope();
  await h.transition(old);
  await h.transition(old, 'completed');
  h.clock.now += 86400_000;
  const next = h.envelope();
  assert.equal((await h.transition(next)).ok, true);
  assert.equal(Object.keys(h.store[LEDGER].generations).length, 1);
  const before = authority(h);
  assert.equal((await h.transition(old)).ok, false);
  assert.equal(authority(h), before);
});

test('standalone descriptor native boundary uses New York time in either host timezone, including DST', () => {
  const previous = process.env.TZ;
  try {
    for (const timezone of ['UTC', 'America/New_York']) for (const [start, native] of [
      ['2026-03-08T13:00:00Z', '2026-03-09T00:30:00Z'],
      ['2026-11-01T14:00:00Z', '2026-11-02T01:30:00Z'],
    ]) {
      process.env.TZ = timezone;
      const h = harness(); h.clock.now = Date.parse(start);
      const e = h.envelope();
      assert.equal(e.nextNativeAdmissionAt, Date.parse(native));
      assert.equal(h.context.inspectStandaloneWalkEnvelope(e).ok, true);
    }
  } finally { if (previous == null) delete process.env.TZ; else process.env.TZ = previous; }
});

test('native RECOVER and main get 20:30 admission; the parameterless and Parser-ready windows stay at 21:00', async () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    for (const [time, allowed] of [['2026-09-09T20:29:59-04:00', false], ['2026-09-09T20:30:00-04:00', true]]) {
      const h = harness(); h.clock.now = Date.parse(time);
      const slot = String(Date.parse('2026-09-09T23:00:00-04:00'));
      const desired = { slotId: slot, owner: 'store-walk', phase: 'recover', token: 'native-main-token-0001' };
      assert.equal(h.context.nightCabinetLeaseSlotIds(h.clock.now, desired).includes(slot), allowed);
      assert.equal(h.context.nightCabinetLeaseSlotIds(h.clock.now).includes(slot), false);
      assert.equal(h.context.nightCabinetLeaseSlotIds(h.clock.now, { owner: 'parser' }).includes(slot), false);
      const request = { requestId: `native-${crypto.randomUUID()}`, requestedAt: h.clock.now, expected: { state: 'missing' }, desired };
      assert.equal((await h.send(request)).ok, allowed);
      if (allowed) {
        assert.equal((await h.send({ ...request, requestId: `native-${crypto.randomUUID()}`, expected: h.expected(), desired: { ...desired, phase: 'store-main' } })).ok, true);
      }
    }
  } finally { if (previous == null) delete process.env.TZ; else process.env.TZ = previous; }
});

test('expired native open leases cannot regain browser time with their exact old token', async () => {
  for (const currentPhase of ['claimed', 'running', 'store-main', 'store-catchup', 'recover']) {
    for (const desiredPhase of ['claimed', 'running', 'store-main', 'store-catchup', 'recover']) {
      const h=harness();
      h.store.nightCabinetLease={slotId:h.context.nightCabinetSlotId(AT),owner:'store-walk',
        phase:currentPhase,token:'expired-native-owner-token-0001',heartbeat:AT-900001,expires:AT-1};
      const before=authority(h);
      const result=await h.send({requestId:`expired-native-${crypto.randomUUID()}`,requestedAt:AT,
        expected:h.expected(),desired:{slotId:h.store.nightCabinetLease.slotId,owner:'store-walk',
          phase:desiredPhase,token:h.store.nightCabinetLease.token}});
      assert.equal(result.ok,false,`${currentPhase} -> ${desiredPhase}`);
      assert.equal(result.reason,'store-walk-owner-work-unproven');
      assert.equal(authority(h),before);
    }
  }
});

test('old native terminal settlement needs exact heartbeat/expires and never extends its lease', async () => {
  const h = harness();
  h.store.nightCabinetLease = {
    slotId: String(AT - 2 * 86400_000), owner: 'store-walk', phase: 'store-main', token: 'old-native-owner-token0001',
    heartbeat: AT - 2 * 86400_000, expires: AT - 2 * 86400_000 + 900_000,
  };
  const before = structuredClone(h.store.nightCabinetLease);
  const request = {
    requestId: `settlement-${crypto.randomUUID()}`, requestedAt: AT, expected: h.expected(),
    desired: { slotId: before.slotId, owner: before.owner, token: before.token, phase: 'degraded' },
  };
  const noTime = structuredClone(request); delete noTime.expected.heartbeat; delete noTime.expected.expires;
  assert.equal((await h.send(noTime)).ok, false);
  h.store.nightCabinetLease.heartbeat++;
  assert.equal((await h.send(request)).reason, 'transition-current-proof-mismatch');
  h.store.nightCabinetLease = before;
  assert.equal((await h.send({ ...request, requestId: `settlement-${crypto.randomUUID()}` })).ok, true);
  assert.deepEqual(h.store.nightCabinetLease, { ...before, phase: 'degraded' });
});

function oldManual(h) {
  const id = 'a97db852-3978-4c43-98af-a44e994e1445';
  const envelope = {
    schemaVersion: 1, kind: 'manual-control', id,
    coordinatorRunId: '03d07094-5eaa-4db3-aae2-2f90c04119be', createdAt: 1788871772564,
    deadlineAt: 1788905972564, nextNativeAdmissionAt: 1788913800000,
    requestSha: '9604358b079b5fa362d1c7f8dfbddda01d9eef1bcc014dbf56ad806ee45de495',
  };
  h.clock.now = Date.parse('2026-09-10T02:12:00Z');
  h.store.manualControlGenerationIndex = [id];
  h.store[`manualControlGeneration:${id}`] = { schemaVersion: 1, envelope, admittedAt: 1788871773525, parserRunId: null };
  h.store.nightCabinetLease = { slotId: String(envelope.createdAt), owner: 'store-walk', phase: 'store-main',
    token: `control:${id}:main`, heartbeat: 1788873124534, expires: 1788874024534 };
  return envelope;
}

test('exact expired manual a97 can close after deadline with existing record, without reactivation or new work time', async () => {
  const h = harness(), envelope = oldManual(h);
  const lease = structuredClone(h.store.nightCabinetLease), record = structuredClone(h.store[`manualControlGeneration:${envelope.id}`]);
  const request = { requestId: `settlement-${crypto.randomUUID()}`, requestedAt: h.clock.now, expected: h.expected(),
    desired: { slotId: lease.slotId, owner: lease.owner, token: lease.token, phase: 'degraded' }, manualControl: envelope };
  assert.equal((await h.send({ ...request, desired: { ...request.desired, phase: 'store-main' } })).ok, false);
  assert.equal((await h.send(request)).ok, true);
  assert.deepEqual(h.store.nightCabinetLease, { ...lease, phase: 'degraded' });
  assert.deepEqual(h.store[`manualControlGeneration:${envelope.id}`], record);
  assert.equal(h.store.pipelineRun, undefined);
  assert.equal((await h.send({ ...request, requestId: `replay-${crypto.randomUUID()}`, expected: h.expected(), desired: { ...request.desired, phase: 'store-main' } })).ok, false);
});

for (const kind of ['missing-record', 'missing-index', 'changed-envelope', 'renewed', 'missing-times']) {
  test(`expired manual cleanup refuses ${kind}, without changing the old lease`, async () => {
    const h = harness(), envelope = oldManual(h);
    const lease = h.store.nightCabinetLease;
    const request = { requestId: `settlement-${crypto.randomUUID()}`, requestedAt: h.clock.now, expected: h.expected(),
      desired: { slotId: lease.slotId, owner: lease.owner, token: lease.token, phase: 'degraded' }, manualControl: envelope };
    if (kind === 'missing-record') delete h.store[`manualControlGeneration:${envelope.id}`];
    if (kind === 'missing-index') h.store.manualControlGenerationIndex = [];
    if (kind === 'changed-envelope') request.manualControl = { ...envelope, requestSha: 'b'.repeat(64) };
    if (kind === 'renewed') h.store.nightCabinetLease.heartbeat++;
    if (kind === 'missing-times') { delete request.expected.heartbeat; delete request.expected.expires; }
    const before = authority(h);
    assert.equal((await h.send(request)).ok, false);
    assert.equal(authority(h), before);
  });
}
