import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MINUTE, coordinatorWakeDecision, nightWindow, observeProgress, sheetsReceipt } from '../watchdog/lib/night-policy.mjs';
import { wakeCoordinator } from '../watchdog/lib/coordinator-wake.mjs';

const time = (hour, minute = 0) => new Date(2026, 8, 5, hour, minute).getTime();
const idle = { dailyAutoParseEnabled: true, pipelineStage: { active: false }, pipelineRun: { id: 'old', status: 'completed' } };
const active = () => ({
  pipelineRun: { id: 'run-1', status: 'running' },
  pipelineStage: { active: true, runId: 'run-1', stages: ['amazon'], currentIndex: 0, stageStartedAt: 1 },
  progressState: { amazon: { current: 2, found: 3, timestamp: 1 } },
  amazonPaginationState: { currentPage: 16 },
  multiAccountState: { currentAmazonAccount: 'primary' },
  trackScreenshotQueue: [{ orderId: 'one', trackNumber: 'track-one' }],
});

test('night wakes stay inside the current night, including the 23:00 boundary', () => {
  assert.equal(nightWindow(time(23, 0)).slot, time(23, 0));
  for (const [h, m, allowed] of [[23, 0, false], [23, 14, false], [23, 15, true], [6, 29, true], [6, 30, false], [12, 0, false], [22, 59, false]]) {
    assert.equal(coordinatorWakeDecision(idle, null, time(h, m)).wake, allowed, `${h}:${m}`);
  }
});

test('wake budget survives ticks and resets only for another night', () => {
  const start = time(23, 15);
  const first = coordinatorWakeDecision(idle, null, start);
  assert.equal(first.wake, true);
  assert.equal(coordinatorWakeDecision(idle, first.attempt, start + MINUTE).reason, 'wake-cooldown');
  const second = coordinatorWakeDecision(idle, first.attempt, start + 15 * MINUTE);
  assert.equal(second.wake, true);
  assert.equal(coordinatorWakeDecision(idle, second.attempt, start + 30 * MINUTE).reason, 'wake-budget-exhausted');
  assert.equal(coordinatorWakeDecision(idle, second.attempt, start + 24 * 60 * MINUTE).wake, true);
});

test('active parser, pending transition, existing coordinator and disabled switch block a wake', () => {
  const now = time(23, 30);
  for (const changed of [active(), { ...idle, pendingIherbSwitch: true }, { ...idle, pipelineRun: { status: 'starting' } }, { ...idle, dailyAutoParseEnabled: false }, { ...idle, lastDailyAutoParseTriggeredAt: time(23) }]) {
    assert.equal(coordinatorWakeDecision(changed, null, now).wake, false);
  }
  assert.equal(coordinatorWakeDecision(idle, null, now, { childAlive: true }).wake, false);
});

test('a recent Sheets timestamp from another run cannot prove this run', () => {
  const slot = time(23);
  const s = { pipelineRun: { id: 'new', status: 'completed', finishedAt: slot + MINUTE }, lastSheetsUploadRunId: 'old', lastSheetsUploadOkAt: slot + 2 * MINUTE };
  assert.equal(sheetsReceipt(s, slot).confirmed, false);
  s.lastSheetsUploadRunId = 'new';
  assert.equal(sheetsReceipt(s, slot).confirmed, true);
  s.pendingSheetsUpload = { runId: 'new' };
  assert.equal(sheetsReceipt(s, slot).confirmed, false);
  delete s.pendingSheetsUpload;
  s.lastSheetsUploadOkAt = slot;
  assert.equal(sheetsReceipt(s, slot).confirmed, false);
});

test('old stage needs repeated unchanged observations; heartbeat alone does not reset the evidence', () => {
  const s = active();
  let observation = observeProgress(s, null, time(23)).observation;
  assert.equal(observeProgress(s, null, time(23)).hung, false);
  s.progressState.amazon.timestamp = time(23, 15);
  let result = observeProgress(s, observation, time(23, 15));
  assert.equal(result.hung, false);
  result = observeProgress(s, result.observation, time(23, 30));
  assert.equal(result.hung, true);
  assert.equal(observeProgress(s, observation, time(23, 40)).hung, false, 'missing observations are not proof');
  assert.equal(observeProgress({ ...s, pipelineRun: { id: 'new' } }, result.observation, time(23, 31)).hung, false);
});

test('page, account, counts and screenshot drain each reset a stall observation', () => {
  for (const change of [
    s => { s.amazonPaginationState.currentPage++; },
    s => { s.progressState.amazon.current++; },
    s => { s.multiAccountState.currentAmazonAccount = 'second'; },
    s => { s.trackScreenshotQueue = []; },
    s => { s.trackScreenshotQueue[0].trackNumber = 'next-track'; },
  ]) {
    const s = active();
    const observation = observeProgress(s, null, time(23)).observation;
    change(s);
    assert.equal(observeProgress(s, observation, time(23, 30)).hung, false);
  }
});

test('wake adapter dry-run performs no process or filesystem effects', async () => {
  const forbidden = () => { throw new Error('unexpected effect'); };
  assert.deepEqual(await wakeCoordinator({ dryRun: true, repo: '/unused' }, {
    launch: forbidden, open: forbidden, close: forbidden,
  }), { started: false, reason: 'dry-run' });
});

test('wake adapter uses the existing one-shot coordinator CLI without a killing timeout', async () => {
  const calls = [];
  const result = await wakeCoordinator({ repo: '/autobuy', node: '/node' }, {
    open: () => 17, close: fd => calls.push(['close', fd]),
    launch: (...args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.pid = 321; child.unref = () => calls.push(['unref']);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  assert.deepEqual(result, { started: true, pid: 321 });
  assert.deepEqual(calls[0], ['/node', ['/autobuy/agent/night-cabinet-coordinator.mjs', '--wake=watchdog'], { cwd: '/autobuy', detached: true, stdio: ['ignore', 17, 17] }]);
});

test('actual watchdog --dry-run reads a fake missed night without writing state or control requests', t => {
  const root = mkdtempSync(join(tmpdir(), 'parser-watchdog-dry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'watchdog');
  cpSync(new URL('../watchdog/', import.meta.url), dir, { recursive: true, filter: source => !source.includes('telegram-creds') && !source.includes('.watchdog-state') });
  const statePath = join(dir, '.watchdog-state.json');
  const before = '{"not_started":{"alerted":false}}';
  writeFileSync(statePath, before);
  const hook = join(root, 'fake.mjs');
  writeFileSync(hook, `
const RealDate = Date; globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [1788665700000])); } static now() { return 1788665700000; } };
globalThis.fetch = async url => { if (!String(url).endsWith('/json')) throw new Error('unexpected network write'); return {json:async()=>[{type:'service_worker',url:'chrome-extension://test/background.js',webSocketDebuggerUrl:'ws://fake'}]}; };
globalThis.WebSocket = class { handlers = {}; constructor() { queueMicrotask(()=>this.handlers.open?.()); } addEventListener(k,f) { this.handlers[k]=f; } close() {} send(raw) { const m=JSON.parse(raw); if (!m.params.expression.includes('chrome.storage.local.get(') || /storage.local.set/.test(m.params.expression)) throw new Error('unexpected browser write'); queueMicrotask(()=>this.handlers.message({data:JSON.stringify({id:m.id,result:{result:{value:{__match:true,d:{dailyAutoParseEnabled:true,pipelineStage:{active:false},pipelineRun:{id:'old',status:'completed'}}}}}})})); } };
`);
  const output = execFileSync(process.execPath, ['--import', hook, join(dir, 'parser-watchdog.mjs'), '--dry-run'], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, TZ: 'America/New_York', AUTOBUY_REPO: root },
  });
  assert.match(output, /would wake existing night coordinator/);
  assert.equal(readFileSync(statePath, 'utf8'), before);
  assert.equal(readdirSync(dir).some(name => name.endsWith('.tmp')), false);
  assert.doesNotMatch(output, /coordinator wake: pid=/);
});
