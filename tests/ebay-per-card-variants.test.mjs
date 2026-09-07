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
