import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const source = readFileSync(new URL('background.js', ROOT), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function extractFunction(name) {
  const functionStart = source.indexOf(`function ${name}`);
  assert.notEqual(functionStart, -1, `function ${name} not found`);
  const start = source.slice(functionStart - 6, functionStart) === 'async ' ? functionStart - 6 : functionStart;
  const openParen = source.indexOf('(', functionStart);
  let parenDepth = 0;
  let closeParen = -1;
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === '(') parenDepth++;
    if (source[i] === ')' && --parenDepth === 0) { closeParen = i; break; }
  }
  const openBrace = source.indexOf('{', closeParen);
  let braceDepth = 0;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === '{') braceDepth++;
    if (source[i] === '}' && --braceDepth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`body for ${name} incomplete`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeColdHarness(initialRead) {
  const writes = [];
  const context = {
    chrome: { storage: { local: {
      get: async () => initialRead.promise,
      set: async value => writes.push(clone(value)),
    } } },
    console: { log() {}, warn() {} },
    currentAmazonAccount: null,
    isProcessingScreenshots: false,
    checkpointScreenshotStageBudget: async () => {},
  };
  vm.createContext(context);
  const initStart = source.indexOf('const screenshotQueueReady =');
  const initEnd = source.indexOf('\nasync function persistScreenshotQueue', initStart);
  assert.ok(initStart >= 0 && initEnd > initStart);
  vm.runInContext(`
    let trackScreenshotQueue = [];
    let screenshotsEnabled = false;
    let screenshotQueueInitError = null;
    let screenshotQueuePersistChain = Promise.resolve();
    ${extractFunction('screenshotQueueKey')}
    ${extractFunction('mergePersistedScreenshotQueue')}
    ${source.slice(initStart, initEnd)}
    ${extractFunction('persistScreenshotQueue')}
    ${extractFunction('queueTrackScreenshot')}
  `, context);
  return { context, writes };
}

test('cold MV3 init waits, merges, and persists the first producer item', async () => {
  const initialRead = deferred();
  const { context, writes } = makeColdHarness(initialRead);
  let settled = false;
  const queued = vm.runInContext(`queueTrackScreenshot(
    'O1', 'T1', 'https://secure.iherb.com/myaccount/orderdetails?x=1', 'questburgh'
  )`, context);
  queued.finally(() => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  initialRead.resolve({ screenshotsEnabled: true, trackScreenshotQueue: [] });
  assert.deepEqual(clone(await queued), { queued: true });
  assert.deepEqual(writes.at(-1), { trackScreenshotQueue: [{
    orderId: 'O1', trackNumber: 'T1',
    trackUrl: 'https://secure.iherb.com/myaccount/orderdetails?x=1',
    accountName: 'questburgh', extraTracks: [],
  }] });
});

test('cold MV3 init failure rejects the producer and writes nothing', async () => {
  const initialRead = deferred();
  const { context, writes } = makeColdHarness(initialRead);
  const queued = vm.runInContext(
    `queueTrackScreenshot('O1', 'T1', 'https://secure.iherb.com/x', 'questburgh')`, context,
  );
  initialRead.reject(new Error('init failed'));
  await assert.rejects(queued, /init failed/);
  assert.equal(writes.length, 0);
});

function makeProcessHarness({ queue, activeIherb = 'questburgh@gmail.com', activeAmazon = '', capture }) {
  const storage = {
    trackScreenshotQueue: clone(queue), screenshotQueueBlocked: null, sentScreenshots: [],
    multiAccountIherbState: { currentIherbAccount: activeIherb },
    multiAccountState: { currentAmazonAccount: activeAmazon },
  };
  const writes = [];
  const markCalls = [];
  const tabUpdates = [];
  const context = {
    trackScreenshotQueue: clone(queue), isProcessingScreenshots: false,
    screenshotQueueReady: Promise.resolve(), screenshotQueueInitError: null,
    SCREENSHOT_MAX_ATTEMPTS: 3,
    parseReport: { screenshots: { sent: 0, skipped: 0, failed: 0, broken: 0, byShop: {} } },
    tgBotToken: '', tgChatId: '',
    beginScreenshotStageBudget: async () => {}, finishScreenshotStageBudget: async () => {},
    replayScreenshotLinks: async () => ({ updated: 0 }),
    filterAlreadySent: async items => items,
    markAsSent: async tracks => {
      markCalls.push([...tracks]);
      storage.sentScreenshots = [...new Set([...storage.sentScreenshots, ...tracks])];
    },
    captureTrackScreenshot: async (...args) => capture(context, ...args),
    persistScreenshotQueue: async () => {
      const snapshot = clone(context.trackScreenshotQueue);
      storage.trackScreenshotQueue = snapshot;
      writes.push(snapshot);
    },
    fetch: async () => ({ json: async () => ({ ok: false }) }),
    setTimeout: callback => { callback(); return 0; },
    Math, Date, console: { log() {}, warn() {}, error() {} },
    chrome: {
      storage: { local: {
        get: async keys => {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.map(key => [key, storage[key]]));
        },
        set: async value => Object.assign(storage, clone(value)),
        remove: async key => { delete storage[key]; },
      } },
      tabs: {
        create: async () => ({ id: 91 }),
        update: async (id, options) => { tabUpdates.push({ id, options }); return { id, ...options }; },
        remove: async () => {},
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(`
    ${extractFunction('screenshotQueueKey')}
    ${extractFunction('mergePersistedScreenshotQueue')}
    ${extractFunction('rememberParserScreenshotTab')}
    ${extractFunction('forgetParserScreenshotTab')}
    ${extractFunction('processScreenshotQueue')}
  `, context);
  return { context, storage, writes, markCalls, tabUpdates, run: () => context.processScreenshotQueue() };
}

const itemA = {
  orderId: 'A', trackNumber: 'TA',
  trackUrl: 'https://secure.iherb.com/myaccount/orderdetails?id=A',
  accountName: 'questburgh', extraTracks: [],
};

test('owner mismatch quarantines the head before capture or navigation', async () => {
  let captures = 0;
  const harness = makeProcessHarness({
    queue: [itemA], activeIherb: 'photopochtoy@gmail.com',
    capture: async () => { captures++; return { status: 'sent', tracks: ['TA'] }; },
  });
  assert.equal(await harness.run(), false);
  assert.equal(captures, 0);
  assert.equal(harness.tabUpdates.length, 0);
  assert.equal(harness.storage.screenshotQueueBlocked.kind, 'account-mismatch');
  assert.deepEqual(harness.storage.trackScreenshotQueue, [itemA]);
});

test('confirmed archive removes the head and marks its track once', async () => {
  let captures = 0;
  const harness = makeProcessHarness({
    queue: [itemA],
    capture: async () => { captures++; return { status: 'sent', tracks: ['TA'] }; },
  });
  assert.equal(await harness.run(), true);
  assert.equal(captures, 1);
  assert.deepEqual(harness.storage.trackScreenshotQueue, []);
  assert.equal(harness.storage.screenshotQueueBlocked, null);
  assert.deepEqual(harness.markCalls, [['TA']]);
});

test('a track durably merged during capture stays queued until its own archive confirmation', async () => {
  let captures = 0;
  const harness = makeProcessHarness({
    queue: [itemA],
    capture: async context => {
      captures++;
      if (captures === 1) {
        context.trackScreenshotQueue[0].extraTracks.push('TB');
        await context.persistScreenshotQueue();
        return { status: 'sent', tracks: ['TA'] };
      }
      return { status: 'sent', tracks: ['TB'] };
    },
  });
  assert.equal(await harness.run(), true);
  assert.equal(captures, 2);
  assert.deepEqual(harness.markCalls, [['TA'], ['TB']]);
  assert.deepEqual(harness.storage.trackScreenshotQueue, []);
  const withLateTrack = harness.writes.find(snapshot => snapshot[0]?.extraTracks?.includes('TB'));
  assert.ok(withLateTrack, 'the acknowledged late track must appear in a durable head snapshot');
});

test('archive failure retries exactly three times and quarantines without shift', async () => {
  let captures = 0;
  const harness = makeProcessHarness({
    queue: [itemA],
    capture: async () => { captures++; return { status: 'failed', reason: 'archive false', tracks: [] }; },
  });
  assert.equal(await harness.run(), false);
  assert.equal(captures, 3);
  assert.equal(harness.storage.trackScreenshotQueue.length, 1);
  assert.equal(harness.storage.trackScreenshotQueue[0]._attempts, 3);
  assert.equal(harness.storage.screenshotQueueBlocked.kind, 'delivery-failed');
  assert.equal(harness.markCalls.length, 0);
});

test('streaming enqueue keeps the in-flight head durably ahead of the new item', async () => {
  let captures = 0;
  let inserted = false;
  const itemB = {
    orderId: 'B', trackNumber: 'TB',
    trackUrl: 'https://secure.iherb.com/myaccount/orderdetails?id=B',
    accountName: 'questburgh', extraTracks: [],
  };
  const harness = makeProcessHarness({
    queue: [itemA],
    capture: async context => {
      captures++;
      if (!inserted) {
        inserted = true;
        context.trackScreenshotQueue.push(clone(itemB));
        await context.persistScreenshotQueue();
      }
      return { status: 'failed', reason: 'archive false', tracks: [] };
    },
  });
  assert.equal(await harness.run(), false);
  assert.equal(captures, 3);
  assert.deepEqual(harness.storage.trackScreenshotQueue.map(item => item.orderId), ['A', 'B']);
  assert.ok(harness.writes
    .filter(snapshot => snapshot.some(item => item.orderId === 'B'))
    .every(snapshot => snapshot[0].orderId === 'A'));
});
