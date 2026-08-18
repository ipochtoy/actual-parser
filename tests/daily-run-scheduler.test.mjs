import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8');

function extractFunction(name) {
  const functionStart = source.indexOf(`function ${name}`);
  assert.notEqual(functionStart, -1, `${name} not found`);
  const start = source.slice(functionStart - 6, functionStart) === 'async ' ? functionStart - 6 : functionStart;
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

test('next alarm remains local 23:00 across Pittsburgh DST changes', () => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const context = { Date, DAILY_PARSE_HOUR: 23, DAILY_PARSE_MINUTE: 0 };
    vm.createContext(context);
    vm.runInContext(extractFunction('getNextDailyRun'), context);

    const spring = context.getNextDailyRun(new Date('2026-03-07T23:30:00-05:00'));
    assert.equal(spring.getFullYear(), 2026);
    assert.equal(spring.getMonth(), 2);
    assert.equal(spring.getDate(), 8);
    assert.equal(spring.getHours(), 23);

    const fall = context.getNextDailyRun(new Date('2026-10-31T23:30:00-04:00'));
    assert.equal(fall.getMonth(), 10);
    assert.equal(fall.getDate(), 1);
    assert.equal(fall.getHours(), 23);
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

test('daily scheduler uses one-shot when alarm and rejects wrong-slot fires', () => {
  const setup = extractFunction('setupDailyAlarm');
  assert.match(setup, /chrome\.alarms\.create\(DAILY_ALARM_NAME, \{ when: next\.getTime\(\) \}\)/);
  assert.doesNotMatch(setup, /periodInMinutes/);

  const alarmBranch = source.slice(source.indexOf("if (alarm.name === DAILY_ALARM_NAME)"), source.indexOf("if (alarm.name === SCREENSHOT_RESUME_ALARM)"));
  assert.match(alarmBranch, /slotDriftMs > DAILY_ALARM_DRIFT_TOLERANCE_MS/);
  assert.match(alarmBranch, /fireAgeMs > DAILY_MISSED_RUN_CATCHUP_MS/);
  assert.match(alarmBranch, /alarm-stale-skip/);
});

test('failed launch stays retryable and cannot leave a false active run', () => {
  const runner = extractFunction('runDailyAutoParseOnce');
  const sequential = extractFunction('startSequentialPipelineOnce');
  const commitStart = sequential.indexOf('await chrome.storage.local.set({');
  const pipelineRun = sequential.indexOf('pipelineRun: runningRun', commitStart);
  const pipelineStage = sequential.indexOf('pipelineStage: {', commitStart);
  const triggeredAt = sequential.indexOf('lastDailyAutoParseTriggeredAt: startedAt', commitStart);
  assert.ok(commitStart >= 0 && pipelineRun > commitStart && pipelineStage > pipelineRun && triggeredAt > pipelineStage,
    'running run, stage and trigger proof must share one atomic storage commit');
  assert.match(runner, /lastDailyAutoParseAttemptedAt/);
  assert.match(runner, /status: 'failed_to_start'/);
  assert.match(runner, /pipelineStage:[\s\S]*?active: false/);
  assert.match(runner, /lastDailyAutoParseTriggeredAt: null/);

  const catchup = extractFunction('runMissedDailyAutoParseIfNeeded');
  assert.match(catchup, /lastDailyAutoParseTriggeredAt/);
  assert.doesNotMatch(catchup, /lastDailyAutoParseAttemptedAt/);
});

test('startup reconciliation always finishes before missed-run catch-up', () => {
  assert.match(source, /ensureDailyAlarm\('service-worker-start'\)[\s\S]*?\.then\(\(\) => startupPipelineReconciled\)[\s\S]*?runMissedDailyAutoParseIfNeeded/);
  const init = source.slice(source.indexOf("chrome.storage.local.get(['progressState'"), source.indexOf('async function clearPipelineRuntimeState'));
  const safeReconcile = init.indexOf('await reconcileStalePipelineState({ allowDestructiveCleanup: false })');
  const resume = init.indexOf('await resumePreparedPipelineStageAfterRestart()');
  const destructiveReconcile = init.indexOf('await reconcileStalePipelineState({ allowDestructiveCleanup: true })');
  const releaseCatchup = init.indexOf('resolveStartupPipelineReconciled?.()');
  assert.ok(safeReconcile >= 0
    && resume > safeReconcile
    && destructiveReconcile > resume
    && releaseCatchup > destructiveReconcile,
  'startup must preserve exact intent, resume it, then clean stale state before catch-up');
  assert.match(init, /resolveStartupPipelineReconciled\?\.\(\)/);
});

test('every service-worker crash window around done resumes finalization or Sheets', () => {
  const resume = extractFunction('resumePreparedPipelineStageAfterRestart');
  assert.match(resume, /stage === 'done'/);
  assert.match(resume, /\['starting', 'running', 'completed', 'degraded'\]\.includes\(run\?\.status\)/);
  assert.match(resume, /return runPipelineStage\('done', run\.id\)/);
  assert.match(resume, /pendingSheetsUpload\?\.runId === run\.id/);
  assert.match(resume, /lastSheetsUploadOkAt >= run\.finishedAt/);

  const done = extractFunction('finishTerminalPipelineState');
  assert.match(done, /stage\.stages\?\.\[stage\.currentIndex\] !== 'done'/);
  assert.match(done, /active: false/);
  assert.match(done, /await checkAllStoresCompleted\(\)/);
});

function makeFinalUploadHarness({ failFirstPendingWrite = false, blockPendingWrite = false } = {}) {
  const runId = 'run-final-upload';
  const storageState = {
    pipelineRun: { id: runId, status: 'completed', slotAt: 1234 },
    pipelineStage: {
      active: false,
      runId,
      currentIndex: 3,
      stages: ['iherb', 'ebay', 'amazon', 'done'],
    },
    pendingSheetsUpload: null,
  };
  let pendingWrites = 0;
  let releasePendingWrite;
  const pendingWriteGate = blockPendingWrite
    ? new Promise(resolve => { releasePendingWrite = resolve; })
    : null;
  const timers = [];
  const context = {
    Date,
    Promise,
    PIPELINE_STAGES: storageState.pipelineStage.stages,
    storesCompleted: { ebay: true, iherb: true, amazon: true },
    finalUploadScheduledRunId: null,
    finalUploadScheduleInFlight: null,
    isParsingAllStores: true,
    console: { log() {}, warn() {}, error() {} },
    saveParsingState() {},
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    chrome: {
      runtime: { sendMessage() {} },
      storage: {
        local: {
          async get(keys) {
            const result = {};
            for (const key of keys) result[key] = structuredClone(storageState[key]);
            return result;
          },
          async set(mutation) {
            if (Object.hasOwn(mutation, 'pendingSheetsUpload')) {
              pendingWrites++;
              if (pendingWriteGate) await pendingWriteGate;
              if (failFirstPendingWrite && pendingWrites === 1) {
                throw new Error('pending marker write failed');
              }
            }
            Object.assign(storageState, structuredClone(mutation));
          },
        },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('checkAllStoresCompleted'), context);
  vm.runInContext(extractFunction('checkAllStoresCompletedOnce'), context);
  return {
    context,
    storageState,
    timers,
    pendingWrites: () => pendingWrites,
    releasePendingWrite: () => releasePendingWrite?.(),
  };
}

test('failed pending Sheets marker stays retryable and schedules only after persistence', async () => {
  const harness = makeFinalUploadHarness({ failFirstPendingWrite: true });

  await assert.rejects(harness.context.checkAllStoresCompleted(), /pending marker write failed/);
  assert.equal(harness.context.finalUploadScheduledRunId, null);
  assert.equal(harness.context.finalUploadScheduleInFlight, null);
  assert.equal(harness.timers.length, 0);

  await harness.context.checkAllStoresCompleted();
  assert.equal(harness.pendingWrites(), 2);
  assert.equal(harness.storageState.pendingSheetsUpload.runId, 'run-final-upload');
  assert.equal(harness.context.finalUploadScheduledRunId, 'run-final-upload');
  assert.equal(harness.timers.length, 1);
});

test('concurrent final-upload checks share one pending write and one timer', async () => {
  const harness = makeFinalUploadHarness({ blockPendingWrite: true });

  const first = harness.context.checkAllStoresCompleted();
  const second = harness.context.checkAllStoresCompleted();
  for (let i = 0; i < 10 && harness.pendingWrites() === 0; i++) await Promise.resolve();
  assert.equal(harness.pendingWrites(), 1);

  harness.releasePendingWrite();
  await Promise.all([first, second]);
  assert.equal(harness.pendingWrites(), 1);
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.storageState.pendingSheetsUpload.runId, 'run-final-upload');
});
