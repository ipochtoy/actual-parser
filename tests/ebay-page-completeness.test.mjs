import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../content-ebay.js', import.meta.url), 'utf8');
const start = source.indexOf('async function parseEbayOrders()');
const end = source.indexOf('// Post-parse: fill in tracking', start);
assert.ok(start >= 0 && end > start);
const flow = source.slice(start, end);
const rows = n => Array.from({ length: n }, (_, i) => ({ order_id: `order-${i}`, track_number: `track-${i}` }));
const feed = (items, nested = false) => JSON.stringify(nested
  ? { data: { modules: { RIVER: [{ data: { items } }] } } }
  : { modules: { RIVER: [{ data: { items } }] } });

function harness(responseFor) {
  const initial = { orderData: { eBay: { orders: [{ order_id: 'preserved' }] } },
    ebayOrders: [{ order_id: 'preserved' }], ebayCancelledOrders: [{ order_id: 'prior-cancelled' }] };
  const data = structuredClone(initial), requests = [], messages = [], writes = [], delays = [];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, window: { location: { href: 'https://www.ebay.com/mye/myebay/purchase' } },
    PARSE_MODE: 'warehouse', __ebayCancelledOrders: [], __ebayScreenshotQueueCommits: [],
    __ebayAccountName: '', __ebayRunId: null, AbortController,
    setTimeout(fn, ms) { delays.push(ms); if (ms !== 20000) queueMicrotask(fn); return 1; }, clearTimeout() {},
    getEbayAccount: async () => 'test@example.com',
    captureEbayParserContext: async () => ({ runId: 'current-run', account: 'test@example.com' }),
    verifyEbayParserContext: async () => true, checkIfLoggedIn: () => true,
    sendLog() {}, enrichMissingTrackings: async () => {}, parseItem: x => structuredClone(x),
    chrome: { runtime: { sendMessage: async m => { messages.push(structuredClone(m)); } }, storage: { local: {
      get: async keys => Object.fromEntries(keys.map(k => [k, structuredClone(data[k])])),
      set: async patch => { writes.push(structuredClone(patch)); Object.assign(data, structuredClone(patch)); },
    } } },
    fetch: async raw => {
      const page = Number(new URL(raw).searchParams.get('page'));
      requests.push(page);
      const answer = await responseFor(page, requests.filter(p => p === page).length);
      return { ok: true, status: 200, text: async () => answer, ...(typeof answer === 'object' ? answer : {}) };
    },
  }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(flow, context);
  return { run: () => context.parseEbayOrders(), initial, data, requests, messages, writes, delays };
}

for (const nested of [false, true]) test(`actual eBay flow commits a complete ${nested ? 'nested' : 'root'} feed`, async () => {
  const h = harness(page => feed(rows(page === 1 ? 20 : 1), nested));
  const result = await h.run();
  assert.equal(result.length, 21);
  assert.deepEqual(h.requests, [1, 2]);
  assert.equal(h.messages.filter(m => m.status === 'Done ✅').length, 1);
  assert.equal(h.data.ebayOrders.length, 21);
  assert.ok(h.data.ebayOrders.every(r => r.parser_run_id === 'current-run'));
});

test('a transient failure retries the same page and retains earlier rows', async () => {
  const h = harness((page, attempt) => {
    if (page === 2 && attempt < 3) throw new Error('connection reset');
    return feed(rows(page === 1 ? 20 : 1));
  });
  assert.equal((await h.run()).length, 21);
  assert.deepEqual(h.requests, [1, 2, 2, 2]);
  assert.ok(h.delays.includes(2000) && h.delays.includes(4000));
  assert.equal(h.messages.filter(m => m.status === 'Done ✅').length, 1);
});

const failures = {
  network: () => { throw new Error('connection reset'); },
  http: () => ({ ok: false, status: 429, text: async () => feed([]) }),
  upstream: () => 'upstream connect error',
  json: () => '<html>temporarily unavailable</html>',
  absentItems: () => JSON.stringify({ unexpected: 'x'.repeat(300) }),
  nonArrayItems: () => feed({ length: 0 }),
};
for (const [name, failure] of Object.entries(failures)) test(`permanent ${name} failure cannot mark a partial eBay cabinet complete`, async () => {
  const h = harness(page => page === 1 ? feed(rows(20)) : failure());
  await assert.rejects(h.run(), /eBay page 2 incomplete/);
  assert.deepEqual(h.requests, [1, 2, 2, 2, 2, 2]);
  assert.equal(h.messages.some(m => m.status === 'Done ✅'), false);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.data, h.initial);
});

test('an explicit empty final page is a valid end after real rows', async () => {
  const h = harness(page => feed(rows(page === 1 ? 20 : 0)));
  assert.equal((await h.run()).length, 20);
  assert.deepEqual(h.requests, [1, 2]);
});

test('an empty cabinet still cannot emit Done or replace prior rows', async () => {
  const h = harness(() => feed([]));
  await assert.rejects(h.run(), /Found 0 orders/);
  assert.equal(h.messages.some(m => m.status === 'Done ✅'), false);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.data, h.initial);
});
