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
  let parens = 0;
  let closeParen = -1;
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === '(') parens++;
    if (source[i] === ')' && --parens === 0) {
      closeParen = i;
      break;
    }
  }
  const openBrace = source.indexOf('{', closeParen);
  let braces = 0;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === '{') braces++;
    if (source[i] === '}' && --braces === 0) return source.slice(start, i + 1);
  }
  assert.fail(`${name} body incomplete`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHarness() {
  const runId = 'run-1';
  const state = {
    pipelineRun: {
      id: runId,
      status: 'completed',
      finishedAt: 2_000,
    },
    pipelineStage: {
      active: false,
      runId,
      currentIndex: 3,
      stages: ['iherb', 'ebay', 'amazon', 'done'],
    },
    pendingSheetsUpload: { runId, savedAt: 2_001 },
    lastDailyAutoParseStatus: 'completed',
    lastDailyAutoParseFinishedAt: 2_000,
    lastSheetsUploadRunId: null,
    lastSheetsUploadOkAt: null,
    sheetsRetryCount: 0,
    sheetsRetryGaveUp: false,
  };
  const calls = {
    uploads: 0,
    logs: 0,
    stamps: 0,
    retryWrites: 0,
  };
  let uploadGate = deferred();
  let uploadStarted = deferred();

  const context = {
    Date,
    Promise,
    SHEETS_UPLOAD_MAX_RETRIES: 12,
    finalSheetsUploadInFlight: null,
    console: { log() {}, warn() {}, error() {} },
    async handleExternalControlRequest() {},
    sendTelegramMessage() { return Promise.resolve(); },
    async uploadToSheets(uploadRunId) {
      assert.equal(uploadRunId, runId);
      calls.uploads++;
      uploadStarted.resolve();
      return uploadGate.promise;
    },
    async uploadLogsToSheet() {
      calls.logs++;
    },
    async markSheetsUploadSuccess(stampRunId) {
      assert.equal(stampRunId, runId);
      calls.stamps++;
      Object.assign(state, {
        lastSheetsUploadRunId: runId,
        lastSheetsUploadOkAt: 2_100,
        pendingSheetsUpload: null,
        sheetsRetryCount: 0,
        sheetsRetryGaveUp: false,
      });
    },
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const result = {};
            for (const key of keys) result[key] = structuredClone(state[key]);
            return result;
          },
          async set(mutation) {
            if (Object.hasOwn(mutation, 'sheetsRetryCount')) calls.retryWrites++;
            Object.assign(state, structuredClone(mutation));
          },
        },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('getOrStartFinalSheetsUpload'), context);
  vm.runInContext(extractFunction('handleSheetsUploadWatchdog'), context);

  return {
    context,
    state,
    calls,
    waitForUploadStart: () => uploadStarted.promise,
    resolveUpload: () => uploadGate.resolve(),
    rejectUpload: error => uploadGate.reject(error),
    replaceUploadGate() {
      uploadGate = deferred();
      uploadStarted = deferred();
    },
  };
}

test('normal final timer and watchdog share one actual Sheets transaction', async () => {
  const h = makeHarness();
  const timer = h.context.getOrStartFinalSheetsUpload('run-1', {
    source: 'final-timer-1',
  });
  await h.waitForUploadStart();

  const watchdog = h.context.handleSheetsUploadWatchdog();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(h.calls.uploads, 1);
  assert.equal(h.state.sheetsRetryCount, 0, 'a joined watchdog must not consume a retry');

  h.resolveUpload();
  await Promise.all([timer.promise, watchdog]);
  assert.equal(h.calls.uploads, 1);
  assert.equal(h.calls.logs, 1);
  assert.equal(h.calls.stamps, 1);
  assert.equal(h.context.finalSheetsUploadInFlight, null);
});

test('two concurrent watchdog ticks own one retry and one upload', async () => {
  const h = makeHarness();
  const first = h.context.handleSheetsUploadWatchdog();
  const second = h.context.handleSheetsUploadWatchdog();
  await h.waitForUploadStart();

  assert.equal(h.calls.uploads, 1);
  assert.equal(h.state.sheetsRetryCount, 1);
  assert.equal(h.calls.retryWrites, 1);

  h.resolveUpload();
  await Promise.all([first, second]);
  assert.equal(h.calls.uploads, 1);
  assert.equal(h.calls.logs, 1);
  assert.equal(h.calls.stamps, 1);
});

test('failed upload releases the lock and a later watchdog can retry', async () => {
  const h = makeHarness();
  const first = h.context.handleSheetsUploadWatchdog();
  await h.waitForUploadStart();
  h.rejectUpload(new Error('temporary Sheets failure'));
  await first;

  assert.equal(h.calls.uploads, 1);
  assert.equal(h.calls.stamps, 0);
  assert.equal(h.state.pendingSheetsUpload.runId, 'run-1');
  assert.equal(h.context.finalSheetsUploadInFlight, null);

  h.replaceUploadGate();
  const retry = h.context.handleSheetsUploadWatchdog();
  await h.waitForUploadStart();
  assert.equal(h.calls.uploads, 2);
  assert.equal(h.state.sheetsRetryCount, 2);
  h.resolveUpload();
  await retry;

  assert.equal(h.calls.stamps, 1);
  assert.equal(h.state.pendingSheetsUpload, null);
  assert.equal(h.context.finalSheetsUploadInFlight, null);
});

test('both final upload doors use the shared transaction helper', () => {
  const watchdog = extractFunction('handleSheetsUploadWatchdog');
  const scheduler = extractFunction('checkAllStoresCompletedOnce');
  assert.match(watchdog, /getOrStartFinalSheetsUpload\(pending\.runId/);
  assert.doesNotMatch(watchdog, /await uploadToSheets\(/);
  assert.match(scheduler, /getOrStartFinalSheetsUpload\(runId/);
  assert.doesNotMatch(scheduler, /await uploadToSheets\(/);
});
