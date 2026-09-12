import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const scopeSource = fs.readFileSync(new URL('../shipment-scope.js', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../content-amazon.js', import.meta.url), 'utf8');
const fixture = fs.readFileSync(new URL('./fixtures/amazon-cancel-delivery-link.html', import.meta.url), 'utf8');
const block = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a); return source.slice(a, b);
};
function scopeContext(extra = {}) {
  const context = { URL, console: { log() {}, warn() {}, error() {} }, ...extra };
  vm.createContext(context); vm.runInContext(scopeSource, context); return context;
}

test('tracking URL admission excludes cancel actions and unrelated or foreign routes', () => {
  const c = scopeContext(), isTrack = c.PPShipmentScope.isTrackingPageUrl;
  assert.equal(typeof isTrack, 'function');
  for (const url of ['/progress-tracker/package?orderId=111-1111111-1111111&shipmentId=SHP1',
    '/progress-tracker/package/ref=ppx_yo_dt_b_track_package?itemId=opaque',
    'https://www.amazon.com/gp/your-account/ship-track?orderId=111-1111111-1111111',
    'https://amazon.com/track-package?shipmentId=SHP1']) assert.equal(isTrack(url), true, url);
  for (const url of ['/progress-tracker/package/in-transit/cancel?trackingId=TBA111111111',
    '/progress-tracker/package/%69n-transit/cancel', '/progress-tracker/package/cancel/ref=track',
    '/gp/your-account/ship-track/cancel', '/ap/signin?return_to=/progress-tracker/package',
    '/some-page?ingressUrl=/progress-tracker/package', 'https://example.invalid/progress-tracker/package',
    'http://www.amazon.com/progress-tracker/package', 'https://user:pass@www.amazon.com/progress-tracker/package',
    'https://www.amazon.com:9443/progress-tracker/package', 'javascript:void(0)', '', null])
    assert.equal(isTrack(url), false, String(url));
});

test('actual tracking fetch refuses a cancel link before making a request', async () => {
  const requests = [];
  const c = scopeContext({ fetch: async url => { requests.push(url); return { text: async () => 'TBA111111111' }; } });
  vm.runInContext('const SHIPMENT=globalThis.PPShipmentScope;\n'
    + block('  async function fetchTrackingFromShipTrackUrl(', '  async function fetchFromPopover('), c);
  assert.deepEqual(Array.from(await c.fetchTrackingFromShipTrackUrl('/progress-tracker/package/in-transit/cancel')), []);
  assert.deepEqual(requests, []);
  assert.deepEqual(Array.from(await c.fetchTrackingFromShipTrackUrl('/progress-tracker/package?shipmentId=SHP1')), ['TBA111111111']);
  assert.equal(requests.length, 1);
});

test('cancel-link fixture keeps the primary layout without customer or resource data', () => {
  assert.match(fixture, /progress-tracker\/package\/in-transit\/cancel/);
  assert.match(fixture, /Cancel this delivery/);
  assert.doesNotMatch(fixture, /@|114-3164225|TBA\d|Reebok|<script|<iframe|<input|\bsrc=/i);
});

test('actual parser reads all three primary shipment boundaries and never fetches or queues cancel delivery', {
  skip: !process.env.PARSER_PRO_PLAYWRIGHT_MODULE,
}, async () => {
  const { chromium } = await import(pathToFileURL(process.env.PARSER_PRO_PLAYWRIGHT_MODULE).href);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(); await context.route('**/*', route => route.abort());
    const page = await context.newPage(); await page.setContent(fixture);
    await page.addScriptTag({ content: scopeSource });
    const actual = [block('  function findProductAnchors(', '  async function fetchFromPopover('),
      block('  async function parseIndividualItemSimpleByTrackUrl(', '  async function getTracksForShipment('),
      block('  function getOrderCards(', '  // ========== PAGINATION')].join('\n');
    const bootstrap = `const SHIPMENT=globalThis.PPShipmentScope;const PARSE_MODE='warehouse';
      const requests=[],screenshots=[];const sleep=async()=>{};
      const htmlDecode=s=>{const t=document.createElement('textarea');t.innerHTML=s||'';return t.value.trim()};
      const safeJSON=s=>{try{return JSON.parse(s)}catch{return null}};
      const bySel=(r,s)=>Array.from(r.querySelectorAll(s));const sendLog=()=>{};
      const getAmazonAccount=async()=>'fixture@example.invalid';
      const fetch=async url=>{requests.push(url);const n=new URL(url).searchParams.get('shipmentId').slice(-1);
        return {text:async()=> 'TBA'+n.repeat(9)}};
      const queueAmazonTrackScreenshot=async payload=>screenshots.push(payload.trackUrl);
      const chrome={runtime:{sendMessage(){}},storage:{local:{get:async()=>({multiAccountState:{currentAmazonAccount:'fixture@example.invalid'}})}}};`;
    await page.addScriptTag({ content: bootstrap + actual });
    const result = await page.evaluate(async () => {
      const r = await parseAmazonOrders();
      return { requests, screenshots, rows: r.orders.map(o => ({ name: o.product_name,
        qty: o.qty, parsed: o.composition_parsed, reason: o.composition_reason, track: o.track_number })) };
    });
    assert.deepEqual(result.rows.map(r => r.name), ['Fixture Jacket', 'Fixture T-shirt', 'Fixture Pant Set']);
    assert.deepEqual(result.rows.map(r => r.qty), ['1', '1', '1']);
    assert.ok(result.rows.every(r => r.parsed && r.reason === ''));
    assert.deepEqual(result.rows.map(r => r.track), ['TBA111111111', 'TBA222222222', 'TBA333333333']);
    assert.equal(result.requests.length, 3); assert.equal(result.screenshots.length, 3);
    assert.ok([...result.requests, ...result.screenshots].every(url => !url.includes('/cancel')));
  } finally { await browser.close(); }
});
