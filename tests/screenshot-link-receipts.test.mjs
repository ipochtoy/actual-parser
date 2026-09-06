import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const clone = value => structuredClone(value);
const identity = { store: 'eBay', orderId: '11-15104-24625', accountName: 'eBay (Dzianis)', tracks: ['876535629114'], page: 1 };
const archive = { ok: true, messageId: 123, chatId: '-100123456', link: 'https://t.me/c/123456/123' };
const sheetRow = (overrides = {}) => {
  const cells = ['eBay', identity.orderId, identity.tracks[0], 'Fixture item', '1', '', '', '', identity.accountName, 'parser|old', ''];
  for (const [index, value] of Object.entries(overrides)) cells[Number(index)] = value;
  return cells;
};

function receiptSource() {
  const start = source.indexOf('// BEGIN DURABLE SCREENSHOT ARCHIVE RECEIPTS');
  const end = source.indexOf('// END DURABLE SCREENSHOT ARCHIVE RECEIPTS', start);
  assert.ok(start >= 0 && end > start, 'execute the complete production receipt/replay block');
  return source.slice(start, end);
}

function extractFunction(name) {
  const found = source.indexOf(`function ${name}(`);
  assert.ok(found >= 0, `production function ${name} exists`);
  const start = source.slice(found - 6, found) === 'async ' ? found - 6 : found;
  let depth = 0, closeParen = -1;
  for (let i = source.indexOf('(', found); i < source.length; i++) {
    if (source[i] === '(') depth++;
    if (source[i] === ')' && --depth === 0) { closeParen = i; break; }
  }
  for (let i = source.indexOf('{', closeParen); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`production function ${name} is incomplete`);
}

function harness({ storage = {}, rows = [] } = {}) {
  const calls = { sends: 0, writes: [], reads: 0 };
  const faults = { deliveredWrite: false, sheetWrite: false, staleReadback: false, allowQtyWrites: false };
  const h = { storage, rows: clone(rows), calls, faults, archiveResult: clone(archive) };
  const context = {
    Date, Math, Promise, URL,
    console: { log() {}, warn() {}, error() {} },
    DEFAULT_SPREADSHEET_ID: 'sheet-fixture',
    async sendScreenshotToArchive() { calls.sends++; return clone(h.archiveResult); },
    async readSheetData() { calls.reads++; return clone(h.rows); },
    async getAuthToken() { return 'fixture-token'; },
    async fetch(url, options) {
      assert.match(url, /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/sheet-fixture\/values:batchUpdate$/);
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      calls.writes.push(clone(body));
      if (faults.sheetWrite) return { ok: false, status: 503, text: async () => 'fixture failure' };
      for (const entry of body.data) {
        const match = /^(?:'Лист1'|Лист1)!(H|E)(\d+)$/.exec(entry.range);
        assert.ok(match, `only H or an explicitly tested qty upload can change: ${entry.range}`);
        assert.ok(match[1] === 'H' || faults.allowQtyWrites);
        if (!faults.staleReadback) h.rows[Number(match[2]) - 1][match[1] === 'H' ? 7 : 4] = entry.values[0][0];
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    chrome: { storage: { local: {
      async get(keys) {
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, clone(storage[key])]));
      },
      async set(patch) {
        if (faults.deliveredWrite && Object.values(patch.screenshotArchiveLedger?.entries || {}).some(entry => entry.state === 'delivered')) {
          throw new Error('fixture receipt disk failure');
        }
        Object.assign(storage, clone(patch));
      },
    } } },
  };
  vm.createContext(context);
  vm.runInContext(receiptSource(), context);
  h.context = context;
  h.send = (id = identity) => context.archiveScreenshotWithReceipt('fixture-image', 'fixture-caption', clone(id));
  h.replay = () => context.replayScreenshotLinks({ spreadsheetId: 'sheet-fixture', sheetName: 'Лист1' });
  return h;
}

test('regression: archive before row, cold restart, then late bulk row gets H without another archive', async () => {
  const first = harness();
  await first.send();
  await first.replay();
  assert.equal(first.calls.sends, 1);
  assert.equal(first.calls.writes.length, 0);
  const cold = harness({ storage: clone(first.storage), rows: [sheetRow()] });
  await cold.replay();
  assert.equal(cold.rows[0][7], archive.link);
  assert.equal(cold.rows[0][9], 'parser|old', 'repair H must not rewrite the parser stamp');
  assert.equal(cold.calls.sends, 0);
  await cold.send();
  await cold.replay();
  assert.equal(cold.calls.sends, 0, 'durable delivery survives worker replacement');
  assert.equal(cold.calls.writes.length, 1, 'replay is idempotent');
});

test('existing matching rows receive H while foreign order/account/store and conflicting H remain unchanged', async () => {
  const rows = [sheetRow(), sheetRow({ 1: '22-15104-24625' }), sheetRow({ 8: 'different-account' }),
    sheetRow({ 0: 'Amazon' }), sheetRow({ 7: 'https://t.me/c/123456/999' })];
  const h = harness({ rows });
  await h.send();
  await h.replay();
  assert.equal(h.rows[0][7], archive.link);
  assert.deepEqual(h.rows.slice(1), rows.slice(1));
});

test('actual iHerb queue account matches full Sheet account without borrowing another email with the same prefix', async () => {
  const content = readFileSync(new URL('../content-iherb.js', import.meta.url), 'utf8');
  const marker = content.indexOf('// Account was resolved before parseOrders.');
  const start = content.indexOf('const accountName =', marker);
  const end = content.indexOf(';', start);
  assert.ok(marker >= 0 && start > marker && end > start, 'execute the actual iHerb queue account expression');
  const email = 'photopochtoy@gmail.com';
  const accountName = vm.runInNewContext(`(()=>{${content.slice(start, end + 1)}return accountName;})()`, {
    window: { __iherbCurrentAccountName: email },
  });
  const rows = [sheetRow({ 0: 'iHerb', 8: email }), sheetRow({ 0: 'iHerb', 8: 'photopochtoy@other.invalid' })];
  const h = harness({ rows });
  await h.send({ ...identity, store: 'iherb', accountName });
  await h.replay();
  assert.equal(h.rows[0][7], archive.link, 'producer identity must match the full account already written by Parser');
  assert.deepEqual(h.rows[1], rows[1], 'a shared email prefix does not establish account ownership');
});

test('Sheets failure retains the delivered receipt so a cold retry writes H without sending again', async () => {
  const h = harness({ rows: [sheetRow()] });
  await h.send();
  h.faults.sheetWrite = true;
  await assert.rejects(h.replay());
  const cold = harness({ storage: clone(h.storage), rows: clone(h.rows) });
  await cold.replay();
  assert.equal(cold.rows[0][7], archive.link);
  assert.equal(cold.calls.sends, 0);
});

test('an accepted Sheets write without matching post-read cannot count as successful replay', async () => {
  const h = harness({ rows: [sheetRow()] });
  await h.send();
  h.faults.staleReadback = true;
  await assert.rejects(h.replay());
  assert.equal(h.rows[0][7], '');
  const cold = harness({ storage: clone(h.storage), rows: clone(h.rows) });
  await cold.replay();
  assert.equal(cold.rows[0][7], archive.link);
  assert.equal(cold.calls.sends, 0);
});

test('receipt persistence failure after send leaves an uncertain intent and never resends on retry or restart', async () => {
  const h = harness();
  h.faults.deliveredWrite = true;
  await assert.rejects(h.send());
  assert.equal(h.calls.sends, 1);
  assert.ok(Object.values(h.storage.screenshotArchiveLedger.entries).some(entry => entry.state === 'sending' || entry.state === 'unknown'));
  await assert.rejects(h.send());
  assert.equal(h.calls.sends, 1);
  const cold = harness({ storage: clone(h.storage), rows: [sheetRow()] });
  await assert.rejects(cold.send());
  assert.equal(cold.calls.sends, 0);
  assert.equal(cold.rows[0][7], '', 'an uncertain send is not a proven archive link');
});

test('a proven rejection permits retry, but a missing ACK survives restart and blocks overlapping track merges', async () => {
  const rejected = harness();
  rejected.archiveResult = { ok: false, definitelyNotSent: true };
  assert.equal((await rejected.send()).ok, false);
  assert.equal(Object.keys(rejected.storage.screenshotArchiveLedger.entries).length, 0);
  rejected.archiveResult = archive;
  assert.equal((await rejected.send()).ok, true);
  assert.equal(rejected.calls.sends, 2);

  const unknown = harness();
  unknown.archiveResult = { ok: false };
  await assert.rejects(unknown.send(), /uncertain/);
  assert.equal(unknown.calls.sends, 1);
  const cold = harness({ storage: clone(unknown.storage) });
  await assert.rejects(cold.send(), /uncertain/);
  await assert.rejects(cold.send({ ...identity, tracks: [...identity.tracks, '876535629115'] }), /uncertain/);
  assert.equal(cold.calls.sends, 0, 'adding a late track does not authorize resending the uncertain old track');
});

test('a receipt cannot publish to a different destination selected after archival', async () => {
  const h = harness({ rows: [sheetRow()] });
  await h.send();
  for (const change of [{ spreadsheetId: 'different-sheet' }, { sheetName: 'Другой лист' }, { parseMode: 'financial' }]) {
    const cold = harness({ storage: { ...clone(h.storage), ...change }, rows: h.rows });
    assert.equal((await cold.context.replayScreenshotLinks()).updated, 0);
    assert.equal(cold.calls.writes.length, 0);
    assert.equal(cold.rows[0][7], '');
  }
});

test('actual eBay fallback retains its archive receipt and publishes H on the next empty-queue alarm', async () => {
  const h = harness({ rows: [sheetRow()] });
  Object.assign(h.context, {
    isEbay: true, orderId: identity.orderId, trackNumber: identity.tracks[0], extraTracks: [],
    accountName: identity.accountName, expectedTracks: identity.tracks, capturedTracks: new Set(),
    tab: { id: 1, windowId: 1 }, screenshotsTaken: 0, firstPageLink: null,
    esc: value => value, orderLink: value => value,
    captureEbayShipments: async () => ({ shipments: [], skippedAllSent: false }),
  });
  h.context.chrome.tabs = { captureVisibleTab: async () => 'data:image/png;base64,fixture' };
  const start = source.indexOf('        if (isEbay) {', source.indexOf('// === Ветка eBay:'));
  const end = source.indexOf('        } else if (isIherb) {', start);
  assert.ok(start >= 0 && end > start, 'execute the actual eBay capture branch');
  await vm.runInContext(`(async()=>{${source.slice(start, end)}\n}})()`, h.context);
  assert.equal(h.calls.sends, 1);
  assert.equal(h.context.capturedTracks.has(identity.tracks[0]), true);
  assert.equal(h.rows[0][7], '', 'the archive ACK and H publication are separate');
  const cold = harness({ storage: clone(h.storage), rows: h.rows });
  installQueue(cold, []);
  assert.equal(await cold.context.processScreenshotQueue(), true);
  assert.equal(cold.rows[0][7], archive.link);
  assert.equal(cold.calls.sends, 0);
});

test('actual iHerb capture and fallback acknowledge only the photographed track, never legacy merged extras', async () => {
  const fullAccount = 'photopochtoy@gmail.com';
  const extra = '876535629115';
  const startMarker = '        } else if (isIherb) {';
  const start = source.indexOf(startMarker, source.indexOf('// === Ветка eBay:')) + startMarker.length;
  const end = source.indexOf('        } else {\n            // === Ветка Amazon', start);
  assert.ok(start >= startMarker.length && end > start, 'execute the actual iHerb branch');
  for (const hasCard of [true, false]) {
    const h = harness({ rows: [sheetRow({ 0: 'iHerb', 8: fullAccount }), sheetRow({ 0: 'iHerb', 2: extra, 8: fullAccount })] });
    Object.assign(h.context, {
      orderId: identity.orderId, trackNumber: identity.tracks[0], extraTracks: [extra],
      accountName: fullAccount, capturedTracks: new Set(), tab: { id: 1, windowId: 1 }, screenshotsTaken: 0,
      esc: value => value, orderLink: value => value, itemsCaptionLine: async () => '',
      captureIherbTrackingCard: async () => hasCard ? 'fixture-card' : null,
    });
    h.context.chrome.tabs = { captureVisibleTab: async () => 'data:image/png;base64,fixture' };
    const capture = () => vm.runInContext(`(async()=>{${source.slice(start, end)}})()`, h.context);
    await capture();
    assert.deepEqual([...h.context.capturedTracks], identity.tracks);
    assert.deepEqual(Object.values(h.storage.screenshotArchiveLedger.entries).map(entry => entry.identity.tracks), [identity.tracks]);
    await h.replay();
    assert.equal(h.rows[0][7], archive.link);
    assert.equal(h.rows[1][7], '');
    await capture();
    assert.equal(h.calls.sends, 1, 'retry with unresolved extras reuses the primary receipt');
  }
});

test('actual replay and readSheetData remain noninteractive through the first auth failure and retry', async () => {
  const h = harness({ rows: [sheetRow()] });
  await h.send();
  const auth = []; let readAttempts = 0, removed = 0;
  h.context.getAuthToken = async interactive => { auth.push(interactive); return 'fixture-token'; };
  h.context.removeToken = async () => { removed++; };
  const write = h.context.fetch;
  h.context.fetch = async (url, options) => {
    if (options.method === 'POST') return write(url, options);
    assert.equal(url, 'https://sheets.googleapis.com/v4/spreadsheets/sheet-fixture/values/Лист1!A:Z');
    readAttempts++;
    if (readAttempts === 1) return { ok: false, status: 401, text: async () => 'expired fixture token' };
    return { ok: true, json: async () => ({ values: clone(h.rows) }) };
  };
  vm.runInContext(extractFunction('readSheetData'), h.context);
  await h.replay();
  assert.equal(h.rows[0][7], archive.link);
  assert.equal(removed, 1);
  assert.equal(readAttempts, 4, 'first read retry plus pre-write and post-write reads');
  assert.deepEqual(auth, [false, false, false, false, false], 'no replay read, retry or write may open authorization UI');
  auth.length = 0;
  await h.context.readSheetData('sheet-fixture', 'Лист1');
  assert.deepEqual(auth, [true], 'other callers retain their existing explicit interactive default');
});

function installQueue(h, queue) {
  Object.assign(h.storage, { trackScreenshotQueue: clone(queue), screenshotQueueBlocked: null, sentScreenshots: [] });
  Object.assign(h.context, {
    trackScreenshotQueue: clone(queue), screenshotQueueReady: Promise.resolve(), screenshotQueueInitError: null,
    isProcessingScreenshots: false, SCREENSHOT_MAX_ATTEMPTS: 3, tgBotToken: '', tgChatId: '',
    parseReport: { screenshots: { sent: 0, skipped: 0, failed: 0, broken: 0, byShop: {} } },
    beginScreenshotStageBudget: async () => {}, finishScreenshotStageBudget: async () => {},
    persistScreenshotQueue: async () => { h.storage.trackScreenshotQueue = clone(h.context.trackScreenshotQueue); },
    setTimeout: callback => { callback(); return 0; },
    captureTrackScreenshot: async () => {
      const result = await h.send();
      if (!result?.ok) return { status: 'failed', reason: 'fixture explicit archive rejection', tracks: [] };
      return { status: 'sent', tracks: identity.tracks };
    },
  });
  h.context.chrome.tabs = { create: async () => ({ id: 1 }), remove: async () => {} };
  h.context.chrome.storage.local.remove = async keys => {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete h.storage[key];
  };
  const originalFetch = h.context.fetch;
  h.context.fetch = async (url, options) => {
    if (url.startsWith('https://api.telegram.org/')) return { json: async () => ({ ok: false }) };
    return originalFetch(url, options);
  };
  for (const name of ['screenshotQueueKey', 'mergePersistedScreenshotQueue', 'rememberParserScreenshotTab',
    'forgetParserScreenshotTab', 'filterAlreadySent', 'markAsSent', 'processScreenshotQueue']) {
    vm.runInContext(extractFunction(name), h.context);
  }
}

test('actual queue retries cannot resend or declare success after accepted send but failed receipt persistence', async () => {
  const item = { orderId: identity.orderId, trackNumber: identity.tracks[0],
    trackUrl: 'https://www.ebay.com/ord/show', accountName: identity.accountName, extraTracks: [] };
  const h = harness();
  installQueue(h, [item]);
  h.faults.deliveredWrite = true;
  assert.equal(await h.context.processScreenshotQueue(), false);
  assert.equal(h.calls.sends, 1, 'queue retry attempts never repeat the accepted archive send');
  assert.deepEqual(h.storage.sentScreenshots, []);
  assert.equal(h.context.parseReport.screenshots.sent, 0);
  assert.equal(h.storage.trackScreenshotQueue.length, 1);
  const cold = harness({ storage: clone(h.storage) });
  installQueue(cold, cold.storage.trackScreenshotQueue);
  assert.equal(await cold.context.processScreenshotQueue(), false);
  assert.equal(cold.calls.sends, 0);
  assert.deepEqual(cold.storage.sentScreenshots, []);
});

for (const existing of ['new-row', 'duplicate', 'qty-only']) {
  test(`actual bulk upload ${existing} path publishes a retained receipt before reporting completion`, async () => {
    const rows = existing === 'new-row' ? [] : [sheetRow(existing === 'qty-only' ? { 4: '2' } : {})];
    const h = harness({ rows });
    await h.send();
    const cold = harness({ storage: clone(h.storage), rows: h.rows });
    cold.faults.allowQtyWrites = true;
    cold.storage.orderData = { eBay: { orders: [{ store_name: 'eBay', order_id: identity.orderId,
      track_number: identity.tracks[0], product_name: 'Fixture item', qty: 1, account_name: identity.accountName }] } };
    const messages = [];
    Object.assign(cold.context, {
      parseReport: {}, sendTelegramMessage: async () => {},
      writeDataToSheet: async (_sheetId, _sheet, appended) => { cold.rows.push(...clone(appended)); },
    });
    cold.context.chrome.runtime = { sendMessage: message => { messages.push({ message, H: cold.rows[0]?.[7] }); } };
    vm.runInContext(extractFunction('uploadToSheets'), cold.context);
    await cold.context.uploadToSheets();
    assert.equal(cold.rows.length, 1);
    assert.equal(cold.rows[0][4], '1');
    assert.equal(cold.rows[0][7], archive.link);
    assert.equal(cold.calls.sends, 0);
    assert.ok(messages.length);
    assert.ok(messages.every(({ H }) => H === archive.link), 'no completion message before H replay');
  });
}
