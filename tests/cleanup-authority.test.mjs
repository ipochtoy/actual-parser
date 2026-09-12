import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const AT = Date.parse('2026-09-12T13:00:00Z');
const AUX = 'nightCabinetCleanupLease', LEDGER = 'nightCabinetCleanupLedger';
const SCOPE = 'nightCabinetAuthorityScope', REQUEST = 'nightCabinetCleanupTransitionRequest';
const RESULT = 'nightCabinetCleanupTransitionResult', MANUAL = 'manualControlCleanupClosures';
const uuid = () => crypto.randomUUID();
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const sha = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const copy = value => structuredClone(value);

function actualFunction(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, name);
  const end = source.indexOf('\n}\n', match.index);
  assert.ok(end > match.index, name);
  return source.slice(match.index, end + 2);
}

function harness() {
  const clock = { now: AT }, writes = [], starts = [], hooks = {};
  const scope = { schemaVersion: 1, kind: 'pittsburgh-parser-authority', id: uuid() };
  const hosts = ['pittsburgh', 'minsk', 'air'].map(hostId => ({ hostId, bootId: uuid() }));
  const store = { [SCOPE]: scope, trackScreenshotQueue: [] };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const context = vm.createContext({
    Date: Clock, Intl, console: { log() {}, warn() {}, error() {} }, Promise, Set, Object, Number,
    String, Math, JSON, TextEncoder, Uint8Array, crypto: crypto.webcrypto, structuredClone,
    chrome: { storage: { local: {
      get: async keys => {
        await hooks.beforeGet?.(keys);
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
          .filter(key => Object.hasOwn(store, key)).map(key => [key, copy(store[key])]));
      },
      set: async mutation => {
        await hooks.beforeSet?.(mutation);
        writes.push(copy(mutation)); Object.assign(store, copy(mutation));
        await hooks.afterSet?.(mutation);
      },
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; },
    } }, tabs: { create: async () => { starts.push('tab'); return { id: 1 }; }, update: async () => starts.push('navigate') } },
    readParserRejectedUploadProof: async () => null,
    loadAccountsConfig: async () => ({ iherb: [], amazon: [] }),
    buildExpectedPipelineRoster: () => ({ iherb: [], amazon: [], ebay: [] }),
    uploadToSheets: () => {},
  });
  const names = [
    'getNextDailyRun', 'getLastDailyRunSlot', 'nightCabinetSlotId', 'nightCabinetLeaseSlotIds',
    'nightCabinetSlotDay', 'nightCabinetNativeAdmissionAt', 'inspectNightCabinetLease', 'withNightCabinetLeaseWrite',
    'nightCabinetTerminalProof', 'nightCabinetTerminalSlotProof', 'inspectManualControlEnvelope',
    'manualControlEnvelopeEqual', 'manualControlTokenAllowed', 'manualControlTransitionProof', 'manualControlParserStartProof',
    'inspectStandaloneWalkEnvelope', 'standaloneWalkTokenAllowed', 'inspectStandaloneWalkLedger',
    'standaloneWalkCurrentRecord', 'standaloneWalkTransitionProof', 'storeWalkParserIdleProof',
    'inspectNightCabinetTransitionRequest', 'nightCabinetTransitionAllowed', 'handleNightCoordinatorLeaseTransitionRequest',
    'handleNightCoordinatorLeaseTransitionWake', 'prepareParserNightCabinetLease', 'createPipelineRun',
    'runDailyAutoParseOnce', 'startSequentialPipelineOnce', 'startMultiAccountIherbParsing', 'startMultiAccountAmazonParsing',
    'startEbayStageForPipeline', 'launchParsersFromBackground', 'resumePreparedPipelineStageAfterRestart',
    'handleParserTabOwnershipMessage',
    ...Array.from(source.matchAll(/^(?:async )?function ((?:cleanup\w*|inspectCleanup\w*|inspectManualCleanupClosures|withCleanupParserStart|handleNightCabinetCleanup\w*|readNightCabinetCleanupAuthority))\(/gm), m => m[1]),
  ];
  vm.runInContext(source.slice(0, source.indexOf('let dailyDiagnosticWriteQueue'))
    + '\nlet nightCabinetLeaseWriteChain=Promise.resolve(), dailyRunStartInFlight=null;\n'
    + 'let isParsingAllStores=false,isProcessingScreenshots=false,isMultiAccountParsing=false,isMultiAccountIherb=false;\n'
    + 'let finalSheetsUploadInFlight=null,finalUploadScheduleInFlight=null,sequentialPipelineStartInFlight=null,pipelineAdvanceInFlight=null;\n'
    + [...new Set(names)].map(actualFunction).join('\n'), context);
  const actor = (runId = uuid(), pid = 4321) => ({ ...hosts[0], pid, processStartFingerprint: `Sat Sep 12 08:59:${pid % 60} 2026`, runId });
  const target = (kind = 'native') => {
    const run = { ...actor(), session: 'night-cabinet-coordinator' };
    let generation = null;
    const lease = { slotId: context.nightCabinetSlotId(clock.now), owner: 'store-walk', phase: 'store-main',
      token: `native-${uuid()}`, heartbeat: clock.now - 1800000, expires: clock.now - 900000 };
    if (kind !== 'native') {
      const createdAt = clock.now - 3600000, id = uuid(), coordinatorRunId = uuid();
      const envelope = { schemaVersion: 1, kind: kind === 'manual' ? 'manual-control' : 'standalone-store-walk', id,
        requestSha: '1'.repeat(64), createdAt, deadlineAt: clock.now + 3600000,
        nextNativeAdmissionAt: context.nightCabinetNativeAdmissionAt(clock.now),
        ...(kind === 'manual' ? { coordinatorRunId } : { runId: `store-walk:4321:${createdAt}` }) };
      lease.slotId = String(createdAt);
      lease.token = kind === 'manual' ? `control:${id}:main` : `standalone:${id}:walk`;
      run.runId = kind === 'manual' ? `${coordinatorRunId}-store-main-${uuid()}` : envelope.runId;
      if (kind === 'manual') run.session = `control-walk-${id}`;
      generation = { kind: envelope.kind, envelope };
      if (kind === 'manual') {
        store.manualControlGenerationIndex = [id];
        store[`manualControlGeneration:${id}`] = { schemaVersion: 1, envelope, admittedAt: createdAt, parserRunId: null };
      } else {
        store.standaloneWalkGenerationLedger = { schemaVersion: 1, day: context.nightCabinetSlotDay(String(createdAt)),
          generations: { [id]: { schemaVersion: 1, envelope, admittedAt: createdAt, closedAt: null, terminalPhase: null } } };
      }
    }
    store.nightCabinetLease = copy(lease);
    return { schemaVersion: 1, kind: 'dead-store-walk', scopeId: scope.id, lease, run,
      refs: { manifestSha: 'a'.repeat(64), claimSha: 'b'.repeat(64), reportSha: 'c'.repeat(64), guardSha: 'd'.repeat(64) }, generation };
  };
  const proof = (t, id, previous = null) => ({ schemaVersion: 1, kind: 'store-walk-cleanup-admission', scopeId: scope.id,
    targetSha: sha(t), attemptId: id, capturedAt: clock.now, evidenceSha: 'e'.repeat(64),
    hosts: hosts.map(host => ({ ...host, observedAt: clock.now, proofSha: 'f'.repeat(64) })),
    previous: previous ? { attemptId: previous.attempt.id, auxSha: sha(previous), owner: copy(previous.attempt.owner),
      processesGone: true, proofSha: '9'.repeat(64) } : null });
  const request = (t, operation = 'claim', previous = null) => {
    const id = uuid(), p = proof(t, id, operation === 'retry' ? previous : null);
    const attempt = { schemaVersion: 1, kind: 'store-walk-cleanup', id, scopeId: scope.id, targetSha: sha(t),
      owner: actor(), createdAt: clock.now, deadlineAt: clock.now + 900000, proofSha: sha(p) };
    return { schemaVersion: 1, requestId: `cleanup-${uuid()}`, requestedAt: clock.now, operation,
      expectedLease: copy(t.lease), expectedAux: copy(previous), target: copy(t), attempt, proof: p };
  };
  const send = async r => {
    store[REQUEST] = copy(r);
    return context.handleNightCabinetCleanupTransitionWake({ action: 'nightCabinetCleanupTransitionWake' });
  };
  const receipt = aux => ({ schemaVersion: 1, kind: 'store-walk-cleanup-complete', scopeId: scope.id,
    targetSha: aux.targetSha, attemptId: aux.attempt.id, completedAt: clock.now, receiptSha: '8'.repeat(64),
    home: true, ownTabs: true, protections: true, pause: true, claimsClosed: true });
  const finishRequest = (r, operation = 'finish', savedReceipt = null) => ({ schemaVersion: 1,
    requestId: `finish-${uuid()}`, requestedAt: clock.now, operation, expectedLease: copy(r.target.lease),
    expectedAux: copy(store[AUX]), target: copy(r.target), attempt: copy(r.attempt),
    receipt: savedReceipt || receipt(store[AUX]),
    ...(operation === 'finish-metadata' ? { proof: proof(r.target, r.attempt.id, store[AUX]) } : {}) });
  const authority = () => canonical([store[SCOPE], store[AUX], store[LEDGER], store.nightCabinetLease,
    store.standaloneWalkGenerationLedger, store[MANUAL], store.pipelineRun, store.pipelineStage]);
  const runtime = (name, value) => vm.runInContext(`${name}=${JSON.stringify(value)}`, context);
  return { store, scope, hosts, clock, writes, starts, hooks, context, actor, target, proof, request, send, receipt,
    finishRequest, authority, runtime };
}

test('claim grants only aux; finish closes native lease and aux atomically without renewing old clocks', async () => {
  const h = harness(), target = h.target(), r = h.request(target), old = copy(target.lease);
  assert.equal((await h.send(r)).ok, true);
  assert.deepEqual(h.store.nightCabinetLease, old);
  assert.equal(h.store[AUX].attempt.deadlineAt, AT + 900000);
  assert.equal(h.writes.filter(w => w[AUX]).length, 1);
  h.clock.now += 100;
  const finish = h.finishRequest(r);
  assert.equal((await h.send(finish)).ok, true);
  assert.deepEqual(h.store.nightCabinetLease, { ...old, phase: 'degraded' });
  const commit = h.writes.filter(w => w.nightCabinetLease).at(-1);
  assert.equal(commit[AUX].phase, 'degraded');
  assert.equal(commit[LEDGER].closedAt, h.clock.now);
  assert.equal(commit[RESULT].ok, true);
  assert.equal((await h.context.inspectCleanupLedger(h.store)).closed, true);
});

for (const kind of ['standalone', 'manual']) {
  test(`${kind} closure is in the same atomic commit and cannot reopen the consumed generation`, async () => {
    const h = harness(), target = h.target(kind), r = h.request(target), envelope = target.generation.envelope;
    assert.equal((await h.send(r)).ok, true);
    h.clock.now += 100;
    assert.equal((await h.send(h.finishRequest(r))).ok, true);
    const commit = h.writes.findLast(w => w.nightCabinetLease);
    if (kind === 'standalone') {
      assert.equal(commit.standaloneWalkGenerationLedger.generations[envelope.id].terminalPhase, 'degraded');
      assert.equal(commit.standaloneWalkGenerationLedger.generations[envelope.id].closedAt, h.clock.now);
    } else {
      assert.deepEqual(commit[MANUAL][envelope.id].envelope, envelope);
      assert.equal(h.store[`manualControlGeneration:${envelope.id}`].parserRunId, null);
      const denied = await h.context.manualControlTransitionProof({ manualControl: envelope, desired: {
        slotId: target.lease.slotId, owner: 'parser', phase: 'ready', token: `control:${envelope.id}:parser-1`,
      } }, h.store.nightCabinetLease, h.clock.now);
      assert.equal(denied.ok, false);
      await assert.rejects(h.context.manualControlParserStartProof({ slotId: target.lease.slotId,
        token: `control:${envelope.id}:parser-1` }, h.clock.now), /cleanup generation closed/);
    }
    assert.ok(commit[AUX] && commit[LEDGER] && commit[RESULT]);
  });
}

test('atomic writer serializes competing claims and grants at most one request owner', async () => {
  const h = harness(), target = h.target(), a = h.request(target), b = h.request(target);
  const replies = await Promise.all([h.send(a), h.send(b)]);
  assert.equal(replies.filter((reply, i) => reply.ok && reply.result.requestId === [a, b][i].requestId).length, 1);
  assert.equal(h.writes.filter(w => w[AUX]).length, 1);
  assert.equal(Object.keys(h.store[LEDGER].attempts).length, 1);
  assert.deepEqual(h.store.nightCabinetLease, target.lease);
});

test('lost claim ACK re-reads exact committed attempt without granting any new time', async () => {
  const h = harness(), r = h.request(h.target());
  h.hooks.afterSet = mutation => { if (mutation[AUX]) { delete h.hooks.afterSet; throw Error('lost reply'); } };
  await assert.rejects(h.send(r), /lost reply/);
  const aux = copy(h.store[AUX]), before = h.authority();
  h.clock.now += 1000;
  assert.equal((await h.send(r)).ok, true);
  assert.deepEqual(h.store[AUX], aux);
  assert.equal(h.authority(), before);
  const changed = copy(r); changed.attempt.owner.pid++;
  assert.equal((await h.send(changed)).ok, false);
});

test('lost finish ACK and a new metadata finish are idempotent; closed claim cannot replay', async () => {
  const h = harness(), r = h.request(h.target());
  await h.send(r); h.clock.now += 100;
  const finish = h.finishRequest(r);
  h.hooks.afterSet = mutation => { if (mutation.nightCabinetLease) { delete h.hooks.afterSet; throw Error('lost reply'); } };
  await assert.rejects(h.send(finish), /lost reply/);
  const before = h.authority(); h.clock.now += 1000;
  assert.equal((await h.send(finish)).ok, true);
  const metadata = h.finishRequest(r, 'finish-metadata', finish.receipt);
  assert.equal((await h.send(metadata)).ok, true);
  assert.equal(h.authority(), before);
  assert.equal((await h.send(r)).ok, false);
});

test('expiry preserves the blocker; retry needs fresh exact prior death proof and a different worker', async () => {
  const h = harness(), target = h.target(), r = h.request(target);
  await h.send(r); const old = copy(h.store[AUX]); h.clock.now = old.attempt.deadlineAt;
  assert.equal((await h.send(h.finishRequest(r))).ok, false);
  assert.equal((await h.context.cleanupNormalAdmission(h.store)).ok, false);
  const retry = h.request(target, 'retry', old), missing = copy(retry);
  missing.proof.previous = null; missing.attempt.proofSha = sha(missing.proof);
  assert.equal((await h.send(missing)).ok, false);
  const same = copy(retry); same.attempt.owner = copy(old.attempt.owner);
  assert.equal((await h.send(same)).ok, false);
  assert.equal((await h.send(retry)).ok, true);
  assert.equal(h.store[LEDGER].attempts[r.attempt.id].phase, 'abandoned');
  assert.deepEqual(h.store.nightCabinetLease, target.lease);
  assert.equal((await h.context.inspectCleanupLedger(h.store)).ok, true);
  assert.equal((await h.send(r)).ok, false);
});

test('readonly retry IPC binds exactly the abandoned predecessor; missing or changed links never authorize fence transfer', async () => {
  const h = harness(), target = h.target(), r = h.request(target);
  await h.send(r);
  const ref = a => ({ action:'nightCabinetCleanupAuthorityV1',scopeId:a.scopeId,attemptId:a.attempt.id,targetSha:a.targetSha });
  const old = copy(h.store[AUX]);
  assert.equal((await h.context.readNightCabinetCleanupAuthority(ref(old))).previous, null);
  h.clock.now = old.attempt.deadlineAt;
  const retry = h.request(target, 'retry', old); assert.equal((await h.send(retry)).ok, true);
  const current = copy(h.store[AUX]);
  const response = await h.context.readNightCabinetCleanupAuthority(ref(current));
  assert.deepEqual(copy(response.previous), { scopeId:old.scopeId,attemptId:old.attempt.id,targetSha:old.targetSha,
    owner:old.attempt.owner,createdAt:old.attempt.createdAt,deadlineAt:old.attempt.deadlineAt,
    auxSha:sha(old),processesGone:true,proofSha:current.proof.previous.proofSha });
  assert.equal((await h.context.readNightCabinetCleanupAuthority(ref(old))).known, false);
  const before = h.authority();
  h.store[LEDGER].attempts[old.attempt.id].attempt.owner.pid++;
  assert.equal((await h.context.readNightCabinetCleanupAuthority(ref(current))).known, false);
  h.store[LEDGER].attempts[old.attempt.id].attempt.owner.pid--;
  assert.equal(h.authority(), before);
  h.clock.now++;
  assert.equal((await h.send(h.finishRequest(retry))).ok, true);
  assert.equal((await h.context.readNightCabinetCleanupAuthority(ref(h.store[AUX]))).previous, null);
});

test('durable receipt before deadline can finish metadata after crash without fresh browser time', async () => {
  const h = harness(), r = h.request(h.target());
  await h.send(r); h.clock.now += 100;
  const receipt = h.receipt(h.store[AUX]);
  h.clock.now = r.attempt.deadlineAt + 100000;
  const metadata = h.finishRequest(r, 'finish-metadata', receipt);
  assert.equal((await h.send(metadata)).ok, true);
  assert.equal(h.store[AUX].attempt.deadlineAt, r.attempt.deadlineAt);
  assert.equal(h.store.nightCabinetLease.expires, r.target.lease.expires);
});

for (const flaw of ['scope-missing', 'scope-foreign', 'scope-malformed', 'target-hash', 'target-extra', 'target-wrong-pid',
  'raw-changed', 'raw-active', 'time-shorter', 'time-longer', 'first-stale', 'proof-stale', 'hosts-missing', 'hosts-duplicate',
  'hosts-old', 'proof-hash', 'extra-proof', 'request-future', 'unknown-operation', 'parser-busy', 'runtime-busy']) {
  test(`invalid ${flaw} grants no aux and preserves all work state`, async () => {
    const h = harness(), target = h.target(), r = h.request(target);
    if (flaw === 'scope-missing') delete h.store[SCOPE];
    if (flaw === 'scope-foreign') h.store[SCOPE].id = uuid();
    if (flaw === 'scope-malformed') h.store[SCOPE].force = true;
    if (flaw === 'target-hash') r.attempt.targetSha = '0'.repeat(64);
    if (flaw === 'target-extra') r.target.force = true;
    if (flaw === 'target-wrong-pid') r.target.run.pid = 0;
    if (flaw === 'raw-changed') h.store.nightCabinetLease.heartbeat++;
    if (flaw === 'raw-active') h.store.nightCabinetLease.expires = h.clock.now + 1;
    if (flaw === 'time-shorter') r.attempt.deadlineAt--;
    if (flaw === 'time-longer') r.attempt.deadlineAt++;
    if (flaw === 'first-stale') h.clock.now += 60001;
    if (flaw === 'proof-stale') { r.proof.capturedAt -= 60001; r.attempt.proofSha = sha(r.proof); }
    if (flaw === 'hosts-missing') { r.proof.hosts.pop(); r.attempt.proofSha = sha(r.proof); }
    if (flaw === 'hosts-duplicate') { r.proof.hosts[1] = copy(r.proof.hosts[0]); r.attempt.proofSha = sha(r.proof); }
    if (flaw === 'hosts-old') { r.proof.hosts[0].observedAt -= 60001; r.attempt.proofSha = sha(r.proof); }
    if (flaw === 'proof-hash') r.attempt.proofSha = '0'.repeat(64);
    if (flaw === 'extra-proof') { r.proof.force = true; r.attempt.proofSha = sha(r.proof); }
    if (flaw === 'request-future') r.requestedAt++;
    if (flaw === 'unknown-operation') r.operation = 'renew';
    if (flaw === 'parser-busy') h.store.pipelineRun = { id: 'other', status: 'running' };
    if (flaw === 'runtime-busy') h.runtime('isMultiAccountIherb', true);
    const before = h.authority();
    assert.equal((await h.send(r)).ok, false);
    assert.equal(h.authority(), before);
    assert.equal(h.store[AUX], undefined);
  });
}

for (const stateName of ['open', 'expired', 'aux-malformed', 'missing-aux', 'ledger-malformed',
  'both-null', 'only-null-aux', 'only-null-ledger']) {
  test(`${stateName} cleanup blocks normal grants and actual direct Parser entrypoints with zero starts`, async () => {
    const h = harness(), r = h.request(h.target());
    await h.send(r);
    if (stateName === 'expired') h.clock.now = r.attempt.deadlineAt;
    if (stateName === 'aux-malformed') h.store[AUX].attempt.owner.pid++;
    if (stateName === 'missing-aux') delete h.store[AUX];
    if (stateName === 'ledger-malformed') h.store[LEDGER] = { bad: true };
    if (stateName === 'both-null') h.store[AUX] = h.store[LEDGER] = null;
    if (stateName === 'only-null-aux') { h.store[AUX] = null; delete h.store[LEDGER]; }
    if (stateName === 'only-null-ledger') { h.store[LEDGER] = null; delete h.store[AUX]; }
    // A terminal pointer alone would normally permit Parser-ready transfer.
    h.store.nightCabinetLease.phase = 'degraded';
    const lease = h.store.nightCabinetLease;
    const normal = { requestId: `normal-${uuid()}`, requestedAt: h.clock.now,
      expected: { state: 'present', ...lease }, desired: { slotId: lease.slotId, owner: 'parser', phase: 'ready', token: `parser-${uuid()}` } };
    h.store.nightCoordinatorLeaseTransitionRequest = normal;
    assert.equal((await h.context.handleNightCoordinatorLeaseTransitionRequest()).ok, false);
    // A cached pre-cleanup success must not bypass the current cleanup blocker.
    h.store.lastHandledNightCoordinatorLeaseTransitionId = normal.requestId;
    h.store.nightCoordinatorLeaseTransitionResult = { requestId: normal.requestId, ok: true, lease: copy(lease) };
    assert.equal((await h.context.handleNightCoordinatorLeaseTransitionRequest()).ok, false);
    const before = h.authority(), count = h.writes.length;
    for (const name of ['runDailyAutoParseOnce', 'startSequentialPipelineOnce', 'startMultiAccountIherbParsing',
      'startMultiAccountAmazonParsing', 'startEbayStageForPipeline', 'launchParsersFromBackground',
      'resumePreparedPipelineStageAfterRestart']) {
      await assert.rejects(h.context[name](), /cleanup/);
    }
    await assert.rejects(h.context.createPipelineRun('test', { slotId: lease.slotId, token: lease.token }), /cleanup/);
    assert.equal((await h.context.prepareParserNightCabinetLease({ slotId: lease.slotId, token: lease.token, external: true })).ok, false);
    assert.equal(h.authority(), before); assert.equal(h.writes.length, count); assert.deepEqual(h.starts, []);
  });
}

test('serialized direct start reservation beats a later cleanup claim', async () => {
  const h = harness(), r = h.request(h.target());
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const direct = h.context.withCleanupParserStart(async () => { entered(); await held; });
  await started;
  assert.equal((await h.send(r)).ok, false);
  assert.equal(h.store[AUX], undefined);
  release(); await direct;
  assert.equal((await h.send(r)).ok, true);
});

for (const scope of ['missing', 'null']) for (const malformed of ['both-null', 'only-null-aux', 'only-null-ledger']) {
  test(`direct iHerb entry refuses ${malformed} even with ${scope} canonical scope before writing or opening a tab`, async () => {
    const h = harness();
    if (scope === 'missing') delete h.store[SCOPE]; else h.store[SCOPE] = null;
    if (malformed !== 'only-null-ledger') h.store[AUX] = null;
    if (malformed !== 'only-null-aux') h.store[LEDGER] = null;
    h.context.setParserLock = () => {};
    h.context.sendTelegramMessage = async () => {};
    h.context.ensureValidIherbParserTab = async () => { h.starts.push('ensure-iherb-tab'); return 72; };
    h.context.switchToNextIherbAccount = async () => h.starts.push('switch-iherb-account');
    const before = h.authority();
    assert.equal((await h.context.cleanupNormalAdmission(h.store)).ok, false);
    await assert.rejects(h.context.startMultiAccountIherbParsing(), /cleanup-authority-malformed/);
    assert.equal(h.authority(), before); assert.deepEqual(h.writes, []); assert.deepEqual(h.starts, []);
  });
}

test('every direct outer gate observes persisted-null cleanup keys without canonical scope', async () => {
  const h = harness(); delete h.store[SCOPE]; h.store[AUX] = null;
  for (const name of ['runDailyAutoParseOnce', 'startSequentialPipelineOnce', 'startMultiAccountIherbParsing',
    'startMultiAccountAmazonParsing', 'startEbayStageForPipeline', 'launchParsersFromBackground',
    'resumePreparedPipelineStageAfterRestart']) {
    await assert.rejects(h.context[name](), /cleanup-authority-malformed/, name);
  }
  assert.deepEqual(h.writes, []); assert.deepEqual(h.starts, []);
});

for (const malformed of [null, false, 0, '']) {
  test(`persisted ${JSON.stringify(malformed)} manual closure ledger cannot reopen a closed generation or authorize Parser`, async () => {
    const h = harness(), target = h.target('manual'), r = h.request(target), envelope = target.generation.envelope;
    await h.send(r); h.clock.now++;
    assert.equal((await h.send(h.finishRequest(r))).ok, true);
    const lease = copy(h.store.nightCabinetLease);
    h.store[MANUAL] = malformed;
    h.store.nightCoordinatorLeaseTransitionRequest = {
      requestId: `normal-${uuid()}`, requestedAt: h.clock.now, expected: { state: 'present', ...lease },
      desired: { slotId: lease.slotId, owner: 'parser', phase: 'ready', token: `control:${envelope.id}:parser-1` },
      manualControl: envelope,
    };
    assert.equal((await h.context.handleNightCoordinatorLeaseTransitionRequest()).ok, false);
    assert.deepEqual(h.store.nightCabinetLease, lease);
    await assert.rejects(h.context.manualControlParserStartProof({ slotId: lease.slotId, token: `control:${envelope.id}:parser-1` }, h.clock.now), /cleanup generation closed/);
    assert.equal(h.store[MANUAL], malformed);
  });
  test(`finish preserves a persisted ${JSON.stringify(malformed)} manual closure ledger as malformed`, async () => {
    const h = harness(), target = h.target('manual'), r = h.request(target);
    assert.equal((await h.send(r)).ok, true); h.clock.now++;
    h.store[MANUAL] = malformed;
    const before = h.authority();
    assert.equal((await h.send(h.finishRequest(r))).ok, false);
    assert.equal(h.authority(), before); assert.equal(h.store[MANUAL], malformed);
  });
}

for (const loss of ['absent', 'empty-object']) {
  test(`closed primary cleanup ledger denies the same manual generation when closure index is ${loss}`, async () => {
    const h = harness(), target = h.target('manual'), r = h.request(target), envelope = target.generation.envelope;
    assert.equal((await h.send(r)).ok, true); h.clock.now++;
    assert.equal((await h.send(h.finishRequest(r))).ok, true);
    if (loss === 'absent') delete h.store[MANUAL]; else h.store[MANUAL] = {};
    const lease = copy(h.store.nightCabinetLease), primary = canonical([h.store[AUX], h.store[LEDGER]]);
    assert.equal((await h.context.inspectCleanupLedger(h.store)).closed, true);
    h.store.nightCoordinatorLeaseTransitionRequest = {
      requestId: `normal-${uuid()}`, requestedAt: h.clock.now, expected: { state: 'present', ...lease },
      desired: { slotId: lease.slotId, owner: 'parser', phase: 'ready', token: `control:${envelope.id}:parser-1` },
      manualControl: envelope,
    };
    const denied = await h.context.handleNightCoordinatorLeaseTransitionRequest();
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'manual-control-cleanup-closed');
    assert.deepEqual(h.store.nightCabinetLease, lease);
    // A stale ready pointer cannot bypass the independent pipeline consumer.
    const ready = { ...lease, owner: 'parser', phase: 'ready', token: `control:${envelope.id}:parser-1`,
      heartbeat: h.clock.now, expires: h.clock.now + 900000 };
    h.store.nightCabinetLease = ready;
    const count = h.writes.length;
    await assert.rejects(h.context.createPipelineRun('coordinator-control', ready), /cleanup generation closed/);
    assert.equal(h.writes.length, count); assert.equal(h.store.pipelineRun, undefined);
    assert.equal(canonical([h.store[AUX], h.store[LEDGER]]), primary);
  });

  test(`closed primary cleanup history permits a fresh manual generation when closure index is ${loss}`, async () => {
    const h = harness(), target = h.target('manual'), r = h.request(target);
    assert.equal((await h.send(r)).ok, true); h.clock.now++;
    assert.equal((await h.send(h.finishRequest(r))).ok, true);
    if (loss === 'absent') delete h.store[MANUAL]; else h.store[MANUAL] = {};
    const primary = canonical([h.store[AUX], h.store[LEDGER]]);
    const envelope = { ...target.generation.envelope, id: uuid(), coordinatorRunId: uuid(), createdAt: h.clock.now };
    for (const [owner, phase, suffix] of [['store-walk', 'store-main', 'main'],
      ['store-walk', 'completed', 'main'], ['parser', 'ready', 'parser-1']]) {
      h.store.nightCoordinatorLeaseTransitionRequest = {
        requestId: `normal-${uuid()}`, requestedAt: h.clock.now,
        expected: { state: 'present', ...h.store.nightCabinetLease },
        desired: { slotId: String(envelope.createdAt), owner, phase, token: `control:${envelope.id}:${suffix}` },
        manualControl: envelope,
      };
      assert.equal((await h.context.handleNightCoordinatorLeaseTransitionRequest()).ok, true, phase);
    }
    const run = await h.context.createPipelineRun('coordinator-control', h.store.nightCabinetLease);
    assert.equal(h.store[`manualControlGeneration:${envelope.id}`].parserRunId, run.id);
    assert.equal(canonical([h.store[AUX], h.store[LEDGER]]), primary);
  });
}

test('closed exact ledger permits normal native admission but never creates canonical scope', async () => {
  const h = harness(), r = h.request(h.target());
  await h.send(r); h.clock.now++;
  await h.send(h.finishRequest(r));
  assert.equal((await h.context.cleanupNormalAdmission(h.store)).ok, true);
  const blank = harness(); delete blank.store[SCOPE];
  assert.equal((await blank.context.cleanupNormalAdmission(blank.store)).ok, true);
  assert.equal(blank.store[SCOPE], undefined); assert.equal(blank.writes.length, 0);
});

test('retry ledger cannot omit or fork a consumed attempt', async () => {
  const h = harness(), target = h.target(), r = h.request(target);
  await h.send(r); h.clock.now = r.attempt.deadlineAt;
  const retry = h.request(target, 'retry', h.store[AUX]); await h.send(retry);
  delete h.store[LEDGER].attempts[r.attempt.id];
  assert.equal((await h.context.inspectCleanupLedger(h.store)).ok, false);
  assert.equal((await h.context.cleanupNormalAdmission(h.store)).ok, false);
});

test('same-profile readonly IPC is exact, allowlisted, bounded, and cannot mutate authority', async () => {
  const h = harness(), r = h.request(h.target()); await h.send(r);
  const request = { action: 'nightCabinetCleanupAuthorityV1', scopeId: h.scope.id,
    attemptId: r.attempt.id, targetSha: r.attempt.targetSha };
  const before = h.authority(), count = h.writes.length;
  assert.equal(h.context.handleParserTabOwnershipMessage(request, { id: 'foreign' }, () => assert.fail()), false);
  const response = await new Promise(resolve => assert.equal(h.context.handleParserTabOwnershipMessage(request,
    { id: 'ppcgaihnphmgololipboonimikclclgc' }, resolve), true));
  assert.equal(response.known, true); assert.equal(response.state, 'active');
  assert.equal(response.auxSha, sha(h.store[AUX]));
  assert.equal(response.deadlineAt, r.attempt.deadlineAt);
  assert.equal(JSON.stringify(response).includes('evidenceSha'), false);
  h.clock.now = r.attempt.deadlineAt;
  assert.equal((await h.context.readNightCabinetCleanupAuthority(request)).state, 'expired');
  assert.equal((await h.context.readNightCabinetCleanupAuthority({ ...request, targetSha: '0'.repeat(64) })).known, false);
  h.store.nightCabinetLease.token = `foreign-${uuid()}`;
  assert.equal((await h.context.readNightCabinetCleanupAuthority(request)).known, false);
  h.store.nightCabinetLease = copy(r.target.lease);
  assert.equal(h.authority(), before); assert.equal(h.writes.length, count);
});

test('parameterless wake refuses authority payload from its transport', async () => {
  const h = harness(), r = h.request(h.target()); h.store[REQUEST] = r;
  assert.equal((await h.context.handleNightCabinetCleanupTransitionWake({ action: 'nightCabinetCleanupTransitionWake', request: r })).ok, false);
  assert.equal(h.store[AUX], undefined); assert.equal(h.writes.length, 0);
});

for (const flaw of ['false-home', 'false-tabs', 'false-pause', 'claim-open', 'future-receipt', 'late-receipt',
  'foreign-attempt', 'changed-aux', 'missing-metadata-proof', 'metadata-owner-live', 'metadata-foreign-aux']) {
  test(`finish ${flaw} cannot terminalize the old work owner or release any ledger`, async () => {
    const h = harness(), r = h.request(h.target()); await h.send(r); h.clock.now += 100;
    const receipt = h.receipt(h.store[AUX]);
    const metadata = flaw.startsWith('metadata-') || flaw === 'missing-metadata-proof';
    if (metadata) h.clock.now = r.attempt.deadlineAt + 1;
    const finish = h.finishRequest(r, metadata ? 'finish-metadata' : 'finish', receipt);
    if (flaw === 'false-home') finish.receipt.home = false;
    if (flaw === 'false-tabs') finish.receipt.ownTabs = false;
    if (flaw === 'false-pause') finish.receipt.pause = false;
    if (flaw === 'claim-open') finish.receipt.claimsClosed = false;
    if (flaw === 'future-receipt') finish.receipt.completedAt = h.clock.now + 1;
    if (flaw === 'late-receipt') finish.receipt.completedAt = r.attempt.deadlineAt + 1;
    if (flaw === 'foreign-attempt') finish.receipt.attemptId = uuid();
    if (flaw === 'changed-aux') finish.expectedAux.admittedAt++;
    if (flaw === 'missing-metadata-proof') delete finish.proof;
    if (flaw === 'metadata-owner-live') finish.proof.previous.processesGone = false;
    if (flaw === 'metadata-foreign-aux') finish.proof.previous.auxSha = '0'.repeat(64);
    const before = h.authority();
    assert.equal((await h.send(finish)).ok, false);
    assert.equal(h.authority(), before);
  });
}

test('admission rechecks the clock after asynchronous proof validation', async () => {
  const h = harness(), r = h.request(h.target());
  let digests = 0;
  h.context.crypto = { subtle: { digest: async (...args) => {
    const result = await crypto.webcrypto.subtle.digest(...args);
    if (++digests === 3) h.clock.now += 60001;
    return result;
  } } };
  assert.equal((await h.send(r)).ok, false);
  assert.equal(h.store[AUX], undefined);
  assert.deepEqual(h.store.nightCabinetLease, r.target.lease);
});

test('closed target rotation rejects an older target, UUID or raw lease replay', async () => {
  const h = harness(), r = h.request(h.target()); await h.send(r); h.clock.now++;
  await h.send(h.finishRequest(r));
  const oldAux = copy(h.store[AUX]);
  const nextTarget = h.target(), next = h.request(nextTarget, 'claim', oldAux);
  assert.equal((await h.send(next)).ok, true);
  const before = h.authority();
  assert.equal((await h.send(r)).ok, false);
  assert.equal(h.authority(), before);
  assert.deepEqual(h.store.nightCabinetLease, nextTarget.lease);
});

test('unstarted target is accepted only as a separately hashed no-work manifest', async () => {
  const h = harness(), target = h.target();
  target.kind = 'unstarted-store-walk'; target.refs.claimSha = target.refs.reportSha = target.refs.guardSha = null;
  const r = h.request(target);
  assert.equal((await h.send(r)).ok, true);
  const changed = copy(r); changed.target.kind = 'dead-store-walk';
  assert.equal((await h.send(changed)).ok, false);
});

for (const phase of ['recover', 'store-main']) {
  test(`started manual coordinator recovery accepts exact coordinator ID with raw ${phase} and report proof`, async () => {
    const h = harness(), target = h.target('manual');
    target.run.runId = target.generation.envelope.coordinatorRunId;
    // The Node coordinator's RECOVER execution maps to the raw store-main phase.
    target.lease.phase = phase; h.store.nightCabinetLease = copy(target.lease);
    const r = h.request(target);
    assert.equal((await h.send(r)).ok, true);
    h.clock.now++;
    assert.equal((await h.send(h.finishRequest(r))).ok, true);
    assert.deepEqual(h.store.nightCabinetLease, { ...target.lease, phase: 'degraded' });
  });
}

for (const phase of ['claimed', 'running', 'store-catchup']) {
  test(`exact manual coordinator ID is not a started recovery target in ${phase}`, async () => {
    const h = harness(), target = h.target('manual');
    target.run.runId = target.generation.envelope.coordinatorRunId;
    target.lease.phase = phase;
    if (phase === 'store-catchup') target.lease.token = `control:${target.generation.envelope.id}:catchup-1`;
    h.store.nightCabinetLease = copy(target.lease);
    assert.equal((await h.send(h.request(target))).ok, false);
    assert.equal(h.store[AUX], undefined); assert.deepEqual(h.store.nightCabinetLease, target.lease);
  });
}

for (const reportSha of [null, 'invalid']) {
  test(`started coordinator recovery requires a valid report hash (${reportSha})`, async () => {
    const h = harness(), target = h.target('manual');
    target.run.runId = target.generation.envelope.coordinatorRunId;
    target.refs.reportSha = reportSha;
    assert.equal((await h.send(h.request(target))).ok, false);
    assert.equal(h.store[AUX], undefined);
  });
}

test('unstarted exact manual coordinator target retains its separate no-report admission', async () => {
  const h = harness(), target = h.target('manual');
  target.kind = 'unstarted-store-walk'; target.run.runId = target.generation.envelope.coordinatorRunId;
  target.refs.claimSha = target.refs.reportSha = target.refs.guardSha = null;
  assert.equal((await h.send(h.request(target))).ok, true);
});

test('worker start/boot identity is bound to its fresh host observation', async () => {
  const h = harness(), r = h.request(h.target());
  r.attempt.owner.bootId = uuid();
  assert.equal((await h.send(r)).ok, false);
  assert.equal(h.store[AUX], undefined);
});
