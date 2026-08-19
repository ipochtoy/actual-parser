import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const background = readFileSync(new URL('background.js', ROOT), 'utf8');
const contentEbay = readFileSync(new URL('content-ebay.js', ROOT), 'utf8');

function extractFunction(source, name) {
  const functionStart = source.indexOf(`function ${name}`);
  assert.notEqual(functionStart, -1, `function ${name} not found`);
  const start = source.slice(functionStart - 6, functionStart) === 'async '
    ? functionStart - 6
    : functionStart;
  const openParen = source.indexOf('(', functionStart);
  let parenDepth = 0;
  let closeParen = -1;
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === '(') parenDepth++;
    if (source[i] === ')' && --parenDepth === 0) {
      closeParen = i;
      break;
    }
  }
  const openBrace = source.indexOf('{', closeParen);
  let braceDepth = 0;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === '{') braceDepth++;
    if (source[i] === '}' && --braceDepth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`body for ${name} incomplete`);
}

function trackingHelpersSource() {
  const start = background.indexOf('const EBAY_TRACKING_PATTERN_SOURCE');
  const end = background.indexOf('\n\nasync function computeEbayCropSpecs', start);
  assert.ok(start >= 0 && end > start, 'eBay tracking helpers not found');
  return background.slice(start, end);
}

test('eBay parser and screenshot path recognize the same bare FedEx formats', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${trackingHelpersSource()}\nthis.extract = extractEbayTrackingNumber;`, context);

  assert.equal(context.extract('383250549190'), '383250549190');
  assert.equal(context.extract('612999988887777'), '612999988887777');
  assert.equal(context.extract('COCTEATWINBLACK'), '');
  assert.equal(context.extract('order 19-15032-09260'), '');

  const pickerStart = contentEbay.indexOf('const pickBestTracking =');
  const pickerEnd = contentEbay.indexOf('\n    };', pickerStart);
  const picker = contentEbay.slice(pickerStart, pickerEnd);
  assert.match(picker, /FedEx[^\n]*12- or 15-digit/);
  assert.match(picker, /\\d\{15\}\|\\d\{12\}/);
});

test('FedEx queue head becomes a tracked eBay shipment instead of a false unshipped card', async () => {
  const dd = { textContent: '383250549190' };
  const dt = {
    textContent: 'Number',
    parentElement: { querySelector: selector => selector === 'dd' ? dd : null },
    nextElementSibling: null,
  };
  const shipment = {
    getBoundingClientRect: () => ({ top: 160, height: 320 }),
    querySelectorAll: selector => selector === 'dt.eui-label' ? [dt] : [],
    querySelector: () => ({ textContent: 'Verified item' }),
  };
  const orderInfo = {
    getBoundingClientRect: () => ({ top: 20, left: 100, width: 640 }),
  };
  const context = {
    window: { scrollY: 0 },
    document: {
      querySelector: selector => selector === '.section-module.order-info' ? orderInfo : null,
      querySelectorAll: selector => selector === '.shipment-card' ? [shipment] : [],
    },
    console: { warn() {} },
    captureFullPageStitched: async () => 'fedex-card-base64',
    chrome: {
      scripting: {
        executeScript: async ({ func, args = [] }) => [{ result: func(...args) }],
      },
      storage: { local: { get: async () => ({ sentScreenshots: [] }) } },
    },
  };
  vm.createContext(context);
  vm.runInContext(`
    ${trackingHelpersSource()}
    ${extractFunction(background, 'computeEbayCropSpecs')}
    ${extractFunction(background, 'captureEbayShipments')}
  `, context);

  const result = await context.captureEbayShipments({ id: 41 });
  assert.equal(result.skippedAllSent, false);
  assert.equal(result.shipments.length, 1);
  assert.equal(result.shipments[0].trackNum, '383250549190');
  assert.equal(result.shipments[0].base64, 'fedex-card-base64');
});
