import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const AT = Date.parse('2026-09-12T03:00:00Z');
const copy = value => structuredClone(value);
function actual(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, name);
  const end = source.indexOf('\n}\n', match.index);
  assert.ok(end > match.index, name);
  return source.slice(match.index, end + 2);
}
function harness() {
  const clock = { now: AT }, calls = [], writes = [], alarms = new Map(), liveTabs = new Set();
  const state = { orderData: { retained: true }, trackScreenshotQueue: [], stopAllParsers: true }, session = {};
  const external = { record: null, busy: false, drop: false, beforeRead: null, requests: [] };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } }
  let context;
  const local = {
    get: async keys => Object.fromEntries((keys === null ? Object.keys(state) : Array.isArray(keys) ? keys : [keys])
      .filter(key => Object.hasOwn(state, key)).map(key => [key, copy(state[key])])),
    set: async value => { writes.push(copy(value)); Object.assign(state, copy(value)); },
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key]; },
  };
  context = vm.createContext({ Date: Clock, Intl, console: { log() {}, warn() {}, error() {} },
    crypto: crypto.webcrypto, TextEncoder, Uint8Array, structuredClone, setTimeout, clearTimeout,
    chrome: { storage: { local, session: { get: async () => copy(session), set: async value => Object.assign(session, copy(value)) } }, runtime: { sendMessage: async (id, message) => {
      if (typeof id === 'object') return;
      assert.equal(id, 'ppcgaihnphmgololipboonimikclclgc');
      if (message.operation === 'read') {
        await external.beforeRead?.();
        return { ok: true, protocolVersion: 1, now: clock.now, record: copy(external.record) };
      }
      external.requests.push(copy(message));
      const authority = await context.readParserWorkAuthority({ action: 'parserWorkAuthorityV1',
        runId: message.desired.runId, slotId: message.desired.slotId, token: message.desired.token });
      assert.equal(authority.known, true, 'callback sees durable intent without a writer deadlock');
      if (external.busy) return { ok: false, protocolVersion: 1, requestId: message.requestId, reason: 'PARSER_WORK_BUSY' };
      external.record = copy(message.desired);
      if (external.drop) return null;
      return { ok: true, protocolVersion: 1, requestId: message.requestId, now: clock.now, record: copy(external.record) };
    } }, alarms: { create: (name, options) => alarms.set(name, copy(options)), clear: async name => alarms.delete(name), get: async name => alarms.get(name) },
    tabs: { create: async options => { calls.push(['create', options]); const id = 100 + calls.length; liveTabs.add(id); return { id, ...options }; },
      get: async id => { if (!liveTabs.has(id)) throw new Error(`No tab with id: ${id}.`); return { id }; },
      remove: async id => { calls.push(['remove', id]); liveTabs.delete(id); } } },
    loadAccountsConfig: async () => ({}), buildExpectedPipelineRoster: () => ({ iherb: ['i1'], amazon: ['a1'], ebay: ['e1'] }),
    readParserRejectedUploadProof: async () => null,
    clearParsingLogs: async () => calls.push(['clear-logs']),
    sendTelegramMessage: async () => {},
    startSequentialPipeline: async () => { calls.push(['start']); return { started: true }; },
    updatePipelineRun: async fn => { state.pipelineRun = copy(await fn(copy(state.pipelineRun))); return copy(state.pipelineRun); },
    isParsingAllStores: false, storesCompleted: {}, parseReport: {}, cachedProgressState: {},
  });
  vm.runInContext(source.slice(0, source.indexOf('async function runDailyAutoParse(')) + '\n' + actual('createPipelineRun'), context);
  async function create() {
    const slotId = context.nightCabinetSlotId(clock.now);
    const lease = { slotId, owner: 'parser', phase: 'ready', token: crypto.randomUUID(), heartbeat: clock.now, expires: clock.now + 900000 };
    state.nightCabinetLease = lease;
    state.parserWorkNativeAdmission = { schemaVersion:1,kind:'parser-native-admission',slotId,token:lease.token,createdAt:clock.now,
      owner:{hostId:'pittsburgh',bootId:crypto.randomUUID(),pid:42,ppid:1,pgid:42,processStartFingerprint:'42:start',commandSha:'f'.repeat(64),runId:'coor-current'},descriptorSha:'e'.repeat(64) };
    return context.createPipelineRun('coordinator', lease);
  }
  return { context, state, session, external, clock, calls, writes, alarms, liveTabs, create };
}

test('actual create atomically saves requesting identity with the exact running lease and no merchant work', async () => {
  const h = harness(), run = await h.create();
  const commit = h.writes.find(value => value.pipelineRun);
  assert.equal(commit.parserWorkAuthority.record.runId, run.id);
  assert.equal(commit.nightCabinetLease.runId, run.id);
  assert.equal(commit.nightCabinetLease.phase, 'running');
  assert.equal(commit.parserWorkAuthority.state, 'requesting');
  assert.equal(h.state.stopAllParsers, true);
  assert.deepEqual(h.state.orderData, { retained: true });
  assert.equal(h.calls.length, 0);
});

test('actual busy acquire leaves all parse flags/data untouched; the same run starts after idle', async () => {
  const h = harness(), run = await h.create(); h.external.busy = true;
  assert.equal(await h.context.parserWorkResumeStart(run.id), false);
  assert.equal(h.state.stopAllParsers, true);
  assert.deepEqual(h.state.orderData, { retained: true });
  assert.equal(h.calls.length, 0);
  assert.equal(h.alarms.has('parserWorkAdmissionRetry'), true);
  h.external.busy = false; h.clock.now += 30_000;
  assert.equal(await h.context.parserWorkResumeStart(run.id), true);
  assert.equal(h.state.parserWorkAuthority.state, 'held');
  assert.equal(h.state.pipelineRun.id, run.id);
  assert.equal(h.calls.filter(call => call[0] === 'start').length, 1);
  assert.equal(h.state.stopAllParsers, false);
});

test('lost acquire response preserves request identity; readback recovers only the same held generation', async () => {
  const h = harness(), run = await h.create(); h.external.drop = true;
  assert.equal((await h.context.parserWorkAcquire(run.id)).admitted, false);
  const request = copy(h.state.parserWorkAuthority.request);
  assert.equal(request.requestId, h.external.requests[0].requestId);
  assert.equal(h.calls.length, 0);
  h.external.drop = false;
  assert.equal((await h.context.parserWorkAcquire(run.id)).admitted, true);
  assert.equal(h.external.requests.length, 1);
});

test('foreign or malformed normal records refuse merchant permission', async () => {
  for (const replacement of [null, {}, { schemaVersion: 1 }]) {
    const h = harness(), run = await h.create(); await h.context.parserWorkAcquire(run.id);
    h.external.record = replacement;
    await assert.rejects(h.context.parserWorkCreateTab({ url: 'https://example.test/' }), /PARSER_WORK_/);
    assert.equal(h.calls.length, 0);
  }
});

test('a fence changed during the read cannot authorize the next merchant action', async () => {
  const h = harness(), run = await h.create(); await h.context.parserWorkAcquire(run.id);
  h.external.beforeRead = () => { h.state.pipelineRun.id = 'foreign'; };
  await assert.rejects(h.context.parserWorkCreateTab({ url: 'https://example.test/' }), /PARSER_WORK_AUTHORITY_CHANGED/);
  assert.equal(h.calls.length, 0);
});

test('owned created tab is durable; unknown create preserves pending intent and forbids a replacement', async () => {
  const h = harness(), run = await h.create(); await h.context.parserWorkAcquire(run.id);
  const tab = await h.context.parserWorkCreateTab({ url: 'https://example.test/' });
  assert.deepEqual(h.state.parserWorkAuthority.ownedTabs, [tab.id]);
  h.context.chrome.tabs.create = async () => { throw new Error('lost create reply'); };
  await assert.rejects(h.context.parserWorkCreateTab({ url: 'https://example.test/' }), /lost create reply/);
  assert.equal(h.state.parserWorkAuthority.pendingCreates.length, 1);
  await assert.rejects(h.context.parserWorkCreateTab({ url: 'https://example.test/' }), /PARSER_WORK_TAB_CREATE_UNCERTAIN/);
});

async function terminal(h) {
  const run = await h.create(); await h.context.parserWorkAcquire(run.id);
  Object.assign(h.context, { isProcessingScreenshots: false, isMultiAccountParsing: false, isMultiAccountIherb: false,
    finalSheetsUploadInFlight: null, finalUploadScheduleInFlight: null, sequentialPipelineStartInFlight: null,
    pipelineAdvanceInFlight: null, parserOperationFlights: new Map(), uploadToSheets: async () => {} });
  Object.assign(h.state, { pipelineRun: { ...h.state.pipelineRun, status: 'completed', finishedAt: h.clock.now },
    pipelineStage: { active: false, runId: run.id, currentIndex: 3, stages: ['iherb', 'ebay', 'amazon', 'done'] },
    parsingState: { isParsingAllStores: false }, pendingSheetsUpload: null,
    lastSheetsUploadRunId: run.id, lastSheetsUploadOkAt: h.clock.now });
  const r = copy(h.state.parserWorkAuthority.record);
  h.state.parserWorkFinishRequest = { schemaVersion: 1, kind: 'parser-work-finish', requestId: crypto.randomUUID(),
    requestedAt: h.clock.now, expected: r, proof: { schemaVersion: 1, kind: 'parser-primary-verification',
      runId: r.runId, slotId: r.slotId, token: r.token, verifiedAt: h.clock.now, descriptorSha: 'a'.repeat(64),
      owner: { hostId: 'pittsburgh', bootId: crypto.randomUUID(), pid: 42, processStartFingerprint: '42:start', runId: 'coor-exact' },
      primary: [['iherb', 'photopochtoy@gmail.com'], ['amazon', 'ipochtoy@gmail.com']].map(([shop, account]) =>
        ({ shop, account, verifiedAt: h.clock.now, outputSha: 'b'.repeat(64) })),
      ownTabs: { session: 'parser-verify-exact', remaining: 0, verifiedAt: h.clock.now } } };
  return run;
}

test('terminal close requires both strong primary receipts and all actual operations drained', async () => {
  for (const mutate of [h => h.state.parserWorkFinishRequest.proof.primary.pop(),
    h => h.state.trackScreenshotQueue.push({ pending: true }),
    h => h.context.parserOperationFlights.set('late-switch', { promise: Promise.resolve() }),
    h => h.state.lastSheetsUploadRunId = 'foreign',
    h => h.state.parserWorkAuthority.pendingCreates.push(crypto.randomUUID())]) {
    const h = harness(); await terminal(h); mutate(h);
    assert.equal((await h.context.handleParserWorkFinishRequest()).ok, false);
    assert.equal(h.state.parserWorkAuthority.state, 'held'); assert.equal(h.calls.length, 0);
  }
});

test('actual terminal handler removes only exact tracked IDs then saves receipt before AutoBuy release', async () => {
  const h = harness(); await terminal(h);
  h.state.parserWorkAuthority.ownedTabs = [77]; h.liveTabs.add(77); h.liveTabs.add(99);
  assert.equal((await h.context.handleParserWorkFinishRequest()).ok, true);
  assert.deepEqual(h.calls, [['remove', 77]]); assert.equal(h.liveTabs.has(99), true);
  assert.equal(h.state.parserWorkAuthority.state, 'closed');
  assert.equal(h.state.parserWorkAuthority.request, null);
  assert.equal(h.external.record.state, 'closed');
  assert.equal(h.state.parserWorkFinishProgress.state, 'completed');
  assert.ok(h.writes.find(value => value.parserWorkAuthority?.state === 'closed'));
});

test('lost terminal release response retains exact request; recovery after deadline does not repeat browser cleanup', async () => {
  const h = harness(); await terminal(h); h.external.drop = true;
  h.state.parserWorkAuthority.ownedTabs = [77]; h.liveTabs.add(77);
  assert.equal((await h.context.handleParserWorkFinishRequest()).ok, false);
  const requestId = h.state.parserWorkAuthority.request.requestId;
  assert.equal(h.state.parserWorkAuthority.state, 'closed');
  await assert.rejects(h.create(), /previous Parser browser authority is unresolved/);
  h.clock.now += 600000; h.external.drop = false;
  assert.equal((await h.context.handleParserWorkFinishRequest()).ok, true);
  assert.deepEqual(h.calls, [['remove', 77]]);
  assert.equal(h.external.requests.filter(r => r.requestId === requestId).length, 1);
});

test('explicit busy deadline closes only definitely ungranted intent; unknown outstanding request is preserved', async () => {
  for (const unknown of [false, true]) {
    const h = harness(), run = await h.create(); h.external.busy = !unknown; h.external.drop = unknown;
    await h.context.parserWorkAcquire(run.id);
    if (unknown) h.external.record = null;
    h.clock.now += 300000;
    assert.equal(await h.context.parserWorkRefuseUnstarted(run.id), !unknown);
    assert.equal(h.state.parserWorkAuthority.state, unknown ? 'requesting' : 'refused');
    assert.equal(h.calls.length, 0);
  }
});

test('a full browser restart never adopts reused integer tab IDs or permits merchant work', async () => {
  const h=harness();await terminal(h);h.state.parserWorkAuthority.ownedTabs=[77];h.liveTabs.add(77);
  delete h.session.parserWorkBrowserSessionId;
  await assert.rejects(h.context.parserWorkCreateTab({url:'https://example.test/'}),/PARSER_WORK_/);
  assert.equal((await h.context.handleParserWorkFinishRequest()).ok,false);
  assert.equal(h.liveTabs.has(77),true);assert.equal(h.calls.length,0);assert.equal(h.external.record.state,'held');
});

test('direct UI/legacy lacks a native verifier and never clears flags or starts a merchant', async () => {
  const h=harness(),diagnostics=[];
  h.context.addDailyDiagnostic=async(...args)=>diagnostics.push(args);
  vm.runInContext(actual('runDailyAutoParseOnce'),h.context);
  assert.equal(await h.context.runDailyAutoParseOnce('popup'),false);
  assert.equal(await h.context.runDailyAutoParseOnce('alarm'),false);
  assert.equal(h.state.stopAllParsers,true);assert.deepEqual(h.state.orderData,{retained:true});assert.equal(h.calls.length,0);
  assert.ok(diagnostics.every(([,d])=>d.skipReason==='native-verifier-required'));
  const run=await h.create();const lease={...h.state.nightCabinetLease,phase:'ready'};
  delete h.state.parserWorkAuthority;h.state.nightCabinetLease=lease;delete h.state.parserWorkNativeAdmission;
  await assert.rejects(h.context.createPipelineRun('coordinator-control',lease),/native Parser verifier/);
  assert.equal(h.state.pipelineRun.id,run.id);
});

test('new exact primary proof can finish an interrupted cleaning attempt; old proof is preserved', async () => {
  const h=harness();await terminal(h);h.state.parserWorkAuthority.ownedTabs=[77];h.liveTabs.add(77);
  h.context.chrome.tabs.remove=async()=>{throw Error('unknown remove result')};
  assert.equal((await h.context.handleParserWorkFinishRequest()).ok,false);
  const previous=copy(h.state.parserWorkFinishProgress);h.clock.now+=300001;
  const fresh=copy(h.state.parserWorkFinishRequest);fresh.requestId=crypto.randomUUID();fresh.requestedAt=h.clock.now;
  fresh.proof.verifiedAt=h.clock.now;fresh.proof.primary.forEach(p=>p.verifiedAt=h.clock.now);fresh.proof.ownTabs.verifiedAt=h.clock.now;
  h.state.parserWorkFinishRequest=fresh;h.context.chrome.tabs.remove=async id=>{h.calls.push(['remove',id]);h.liveTabs.delete(id)};
  assert.equal((await h.context.handleParserWorkFinishRequest()).ok,true);
  assert.deepEqual(h.state[`parserWorkFinishHistory:${previous.request.requestId}`],previous);
  assert.equal(h.external.record.state,'closed');
});

test('late eBay background tracking cannot start after release and keeps terminal quiet false while admitted', async () => {
  const h=harness(),run=await h.create();await h.context.parserWorkAcquire(run.id);
  h.state.pipelineRun.status='running';h.state.pipelineStage={active:true,runId:run.id,currentIndex:1,stages:['iherb','ebay','amazon','done']};
  h.state.ebayParserTabId=77;h.state.parserWorkAuthority.ownedTabs=[77];
  h.context.parserOperationFlights=new Map();
  for(const name of ['runParserOperationSingleFlight','fetchEbayTrackingForSender'])vm.runInContext(actual(name),h.context);
  let release;const pending=new Promise(resolve=>release=resolve),calls=[];
  h.context.fetchEbayOrderTracking=async(id,runId)=>{calls.push({id,runId});await pending;return 'tracking'};
  const work=h.context.fetchEbayTrackingForSender({action:'fetchEbayOrderTracking',orderId:'order'}, {tab:{id:77}});
  while(h.context.parserOperationFlights.size===0)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.context.parserOperationFlights.size,1);release();assert.equal(await work,'tracking');
  assert.equal(h.context.parserOperationFlights.size,0);assert.deepEqual(calls,[{id:'order',runId:run.id}]);
  h.external.record=null;await assert.rejects(h.context.fetchEbayTrackingForSender({action:'fetchEbayOrderTracking',orderId:'old'}, {tab:{id:77}}),/PARSER_WORK_/);
  assert.equal(calls.length,1);
});
