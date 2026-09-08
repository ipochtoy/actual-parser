import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../content-ebay.js', import.meta.url), 'utf8');
const start = source.indexOf('function parseItem(item) {');
const end = source.indexOf('\nfunction downloadCSV(', start);
assert.ok(start >= 0 && end > start);
const actual = source.slice(start, end);
const track = '9434608106244517838177';
const aspect = text => ({ textSpans: [{ text }] });
const card = (aspects = [], extra = {}) => ({
  title: { textSpans: [{ text: 'Synthetic listing' }] },
  quantity: 1,
  aspectValuesList: aspects.map(a => typeof a === 'string' ? aspect(a) : a),
  __myb: { actionList: [{ action: { params: { trackingNumber: track } } }] },
  ...extra,
});
async function parse(cards, extra = {}) {
  const sent = [];
  const context = vm.createContext({
    PARSE_MODE: 'warehouse', __ebayAccountName: 'synthetic@example.test',
    __ebayScreenshotQueueCommits: [], detectEbayCancelled: () => ({ cancelled: false }),
    console: { log() {}, warn() {}, error() {} },
    chrome: { runtime: { sendMessage: async request => {
      sent.push(request); return { status: 'queued' };
    } } },
  });
  vm.runInContext(actual, context);
  const result = context.parseItem({
    secondaryMessage: [aspect('Order number:'), aspect('11-11111-11111')],
    itemCards: cards, ...extra,
  });
  await Promise.all(context.__ebayScreenshotQueueCommits);
  return { rows: JSON.parse(JSON.stringify(result)), sent };
}

test('five colors stay five separate rows with their own variants and unchanged qty/tracking', async () => {
  const colors = ['5n+', '6n+', '20 Volume', '10 Volume', '5ch+'];
  const { rows, sent } = await parse(colors.map(c => card([`Color: ${c}`])));
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(r => r.color), colors);
  assert.deepEqual(rows.map(r => r.qty), [1, 1, 1, 1, 1]);
  assert.ok(rows.every(r => r.track_number === track && r.size === ''));
  assert.equal(sent.length, 1, 'existing screenshot order/track queue remains unchanged');
});

test('live feed Shade labels and numeric entities retain all five distinct variants', async () => {
  const shades = ['20 Volume The Color Cream Developer', '10 Volume The Color Cream Developer', '6n', '5ch&#x2b;', '5n'];
  const { rows } = await parse(shades.map(s => card([`Shade: ${s}`])));
  assert.deepEqual(rows.map(r => r.color), ['20 Volume The Color Cream Developer', '10 Volume The Color Cream Developer', '6n', '5ch+', '5n']);
});

test('shoe size labels retain their size system and never inherit a sibling shirt size', async () => {
  const shoe = card(['US Shoe Size: 10'], {
    listingId: '168309076827',
    title: { textSpans: [{ text: 'Synthetic shoes' }], action: { params: { listingId: '168309076827', variationId: '467833716761' } } },
    __myb: { actionList: [{ action: { params: { trackingNumber: track, itemId: '168309076827', transactionId: '10084151273004' } } }] },
  });
  const { rows } = await parse([card(['Size Type: Regular', 'Size: XL']), shoe,
    card(['UK Shoe Size: 9']), card(['EU Shoe Size: 44']), card(['AU Shoe Size: 9'])]);
  assert.deepEqual(rows.map(r => r.size), ['XL', 'US 10', 'UK 9', 'EU 44', 'AU 9']);
  assert.equal(rows[1].ebay_item_identity.size, 'US 10');
  const labels = await parse([card(['Size: XL', 'US Shoe Size: 10'])]);
  assert.equal(labels.rows[0].size, 'US 10; Size XL', 'preserve both labelled observations without asserting equivalence');
});

test('seller Size and standardized shoe sizes remain separate exact card attributes', async () => {
  const shoe = card(['US Shoe Size: 10.5', 'Size: 10-', 'Color: Black &#x2f; White'], {
    listingId: '123456789012',
    title: { textSpans: [{ text: 'Synthetic shoes' }], action: { params: { listingId: '123456789012', variationId: '10000000000001' } } },
    __myb: { actionList: [{ action: { params: { trackingNumber: track, itemId: '123456789012', transactionId: '10000000000002' } } }] },
  });
  const { rows } = await parse([shoe, card(['EU Shoe Size: 44', 'US Shoe Size: 10', 'UK Shoe Size: 9', 'AU Shoe Size: 9'])]);
  assert.equal(rows[0].size, 'US 10.5; Size 10-');
  assert.equal(rows[0].color, 'Black / White');
  assert.equal(rows[0].ebay_item_identity.size, 'US 10.5; Size 10-');
  assert.equal(rows[1].size, 'US 10; UK 9; EU 44; AU 9');
  const reordered = await parse([{ ...shoe, aspectValuesList: [...shoe.aspectValuesList].reverse() }]);
  assert.deepEqual(reordered.rows, [rows[0]], 'feed aspect order cannot change the stored variant');
});

test('conflicting or empty values for one size label still refuse variant identity', async () => {
  const { rows } = await parse([
    card(['US Shoe Size: 10', 'US Shoe Size: 11', 'Size: 10-']),
    card(['US Shoe Size: 10', 'Size: S', 'Size: L']),
    card(['US Shoe Size: 10', 'US Shoe Size:']),
    card(['US Shoe Size: 10', 'US Shoe Size: 10']),
  ]);
  assert.deepEqual(rows.map(r => r.size), ['', '', '', 'US 10']);
  assert.ok(rows.slice(0, 3).every(r => r.ebay_item_identity === null));
});

test('variant identity binds each card to its own transaction and tracking', async () => {
  const identified = (color, transactionId) => card([`Color: ${color}`], {
    listingId: '123456789012',
    title: { textSpans: [{ text: 'Synthetic listing' }], action: { params: { listingId: '123456789012', variationId: transactionId } } },
    __myb: { actionList: [{ action: { params: { trackingNumber: track, itemId: '123456789012', transactionId } } }] },
  });
  const { rows } = await parse([identified('Black', '10000000000001'), identified('White', '10000000000002')]);
  assert.deepEqual(rows.map(r => r.ebay_item_identity), [
    { schema: 1, source: 'purchase-feed-item-card', orderId: '11-11111-11111', itemId: '123456789012', transactionId: '10000000000001', variationId: '10000000000001', track, color: 'Black', size: '' },
    { schema: 1, source: 'purchase-feed-item-card', orderId: '11-11111-11111', itemId: '123456789012', transactionId: '10000000000002', variationId: '10000000000002', track, color: 'White', size: '' },
  ]);
  const bad = identified('Black', '10000000000001');
  bad.__myb.actionList[0].action.params.itemId = '999999999999';
  const refused = await parse([bad, identified('', '10000000000002')]);
  assert.ok(refused.rows.every(r => r.ebay_item_identity === null));
});

test('quantity in first-card action params cannot leak onto its sibling', async () => {
  const first = card(['Color: Black'], { quantity: undefined, __myb: { actionList: [{ action: { params: { trackingNumber: track, quantity: 2 } } }] } });
  const second = card(['Color: White'], { quantity: undefined, __myb: { actionList: [{ action: { params: { trackingNumber: track, quantity: 3 } } }] } });
  const { rows } = await parse([first, second]);
  assert.deepEqual(rows.map(r => r.qty), [2, 3]);
});

test('two sizes and colors are scoped to the corresponding cards', async () => {
  const { rows } = await parse([card(['Color: Black', 'Size: Small']), card(['Colour: White', 'Size: Large'])]);
  assert.deepEqual(rows.map(r => [r.color, r.size]), [['Black', 'Small'], ['White', 'Large']]);
});

test('single-card variant source remains valid, including itemCards object form', async () => {
  const { rows } = await parse(card(['Color: Blue', 'Size: One size']));
  assert.deepEqual(rows.map(r => [r.color, r.size]), [['Blue', 'One size']]);
});

test('missing card aspects never inherit first-card or unbound common aspects', async () => {
  const { rows } = await parse([card(['Color: Red', 'Size: S']), card(undefined, { aspectValuesList: undefined })],
    { aspectValuesList: [aspect('Color: Green'), aspect('Size: XL')] });
  assert.deepEqual(rows.map(r => [r.color, r.size]), [['Red', 'S'], ['', '']]);
});

test('two cards with explicit same local aspects may keep equal values and multiplicity', async () => {
  const { rows } = await parse([card(['Color: Black']), card(['Color: Black'])]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], rows[1]);
});

test('split spans within one aspect preserve the label/value without searching unrelated text', async () => {
  const { rows } = await parse([card([
    { textSpans: [{ text: 'Color:' }, { text: ' Navy' }] },
    { textSpans: [{ text: 'Size: ' }, { text: '10' }, { text: ' Wide' }] },
    'Seller note color: Red',
  ])]);
  assert.equal(rows[0].color, 'Navy'); assert.equal(rows[0].size, '10 Wide');
});

test('conflicting, empty, malformed and missing aspects remain unknown', async () => {
  const { rows } = await parse([
    card(['Color: Black', 'Colour: White', 'Size: S', 'Size: L']),
    card(['Color: Black', 'Color:']),
    card([{ textSpans: [{ text: 'Color: ' }, { text: 42 }] }, { textSpans: 'Size: M' }]),
    card([], { aspectValuesList: 'Color: Red' }),
    card([]),
  ]);
  assert.ok(rows.every(r => r.color === '' && r.size === ''));
});

test('duplicate identical aspect labels are unambiguous', async () => {
  const { rows } = await parse([card(['Color: Black', 'Colour: Black', 'Size: M', 'Size: M'])]);
  assert.equal(rows[0].color, 'Black'); assert.equal(rows[0].size, 'M');
});

test('per-card quantity, title decoding and track exclusion behavior are unchanged', async () => {
  const { rows } = await parse([
    card(['Color: Red'], { quantity: 2, title: { textSpans: [{ text: 'A &#38; B &amp; C' }] } }),
    card(['Color: Blue'], { quantity: 3 }),
    card(['Color: Green'], { quantity: 4, __myb: { actionList: [] } }),
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.qty), [2, 3]);
  assert.equal(rows[0].product_name, 'A & B &amp; C', 'named-entity change is outside this fix');
  assert.deepEqual(rows.map(r => r.color), ['Red', 'Blue']);
});
