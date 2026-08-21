import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const between = (source, from, to) => {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `missing start marker: ${from}`);
  const end = source.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `missing end marker: ${to}`);
  return source.slice(start, end);
};

test('legacy iHerb progress wrapper invokes the completion handler exactly once', () => {
  const source = read('background.js');
  const branch = between(
    source,
    '} else if (request.action === "parsingProgress") {',
    '} else if (request.action === "progress") {'
  );
  assert.match(branch, /handleProgressMessage\(progressMsg, sender\)/);
  assert.doesNotMatch(branch, /chrome\.runtime\.sendMessage\(progressMsg/);
});

test('daily run awaits a durable pipeline start and refuses a second active run', () => {
  const source = read('background.js');
  const daily = between(source, 'async function runDailyAutoParse(source', 'async function runMissedDailyAutoParseIfNeeded');
  assert.match(daily, /pipelineStage\?\.active/);
  assert.match(daily, /await startSequentialPipeline\(\)/);
  assert.match(daily, /lastDailyAutoParseStatus: 'failed-to-start'/);

  const sequential = between(source, 'async function startSequentialPipelineOnce()', 'async function runPipelineStage');
  assert.match(sequential, /existing\.pipelineStage\?\.active/);
  assert.match(sequential, /return \{ started: true, startedAt \}/);
  assert.match(sequential, /pipelineRun: runningRun[\s\S]*?pipelineStage:[\s\S]*?lastDailyAutoParseTriggeredAt: startedAt/);
});

test('iHerb background arbiter commits rows before exposing the completion permit', () => {
  const source = read('content-iherb.js');
  const parse = between(source, 'function parseOrders()', '// Convert "October 04, 2025"');
  assert.doesNotMatch(parse, /status: 'Done ✅'/, 'parseOrders must not permit an account switch');

  const exportFlow = between(source, 'async function exportOrders()', "console.log('✅ iHerb parser ready!');");
  const pipelineCommit = exportFlow.indexOf('stats = await commitIherbAttemptResult(');
  const done = exportFlow.indexOf("status: 'Done ✅'");
  assert.ok(pipelineCommit >= 0 && done > pipelineCommit,
    'pipeline content must await its background result commit before Done');

  const background = read('background.js');
  const arbiter = between(
    background,
    'async function handleIherbAttemptCommit(request, senderTabId)',
    'async function commitIherbTimeoutOutcome'
  );
  const atomicSet = arbiter.indexOf('await chrome.storage.local.set({\n            orderData,');
  const direct = arbiter.indexOf('iherbOrders: incomingOrders', atomicSet);
  const completion = arbiter.indexOf('iherbParsingComplete: completion', direct);
  assert.ok(atomicSet >= 0 && direct > atomicSet && completion > direct,
    'shared rows, direct snapshot and completion permit must share one background commit');
});

test('eBay validates rows and commits every storage view before Done', () => {
  const source = read('content-ebay.js');
  const flow = between(source, 'async function parseEbayOrders()', '// Post-parse: fill in tracking');
  const zero = flow.indexOf('if (allOrders.length === 0)');
  const shared = flow.indexOf('await chrome.storage.local.set({ orderData })');
  const direct = flow.indexOf('await chrome.storage.local.set({\n      ebayOrders: allOrders');
  const cancelled = flow.indexOf('await chrome.storage.local.set({\n      ebayCancelledOrders:');
  const done = flow.indexOf("status: 'Done ✅'");
  assert.ok(zero >= 0 && shared > zero && direct > shared && cancelled > direct && done > cancelled);
});

test('Amazon background arbiter commits rows before exposing the completion permit', () => {
  const contentSource = read('content-amazon.js');
  const contentFlow = between(
    contentSource,
    'async function finishPaginationParsing(state, reason)',
    '// WRAPPER для пагинации'
  );
  const request = contentFlow.indexOf("await commitAmazonAttempt('complete', state, {");
  const progress = contentFlow.indexOf("action: 'progress'", request);
  const completeMessage = contentFlow.indexOf("action: 'complete'", progress);
  assert.ok(request >= 0 && progress > request && completeMessage > progress,
    'content must await the background completion commit before emitting Done');
  assert.doesNotMatch(contentFlow, /chrome\.storage\.local\.set/,
    'content must not perform a check-then-set final commit');
  assert.doesNotMatch(contentFlow, /clearPaginationState\(\)/,
    'completion must retain the cursor until background acknowledgement');

  const backgroundSource = read('background.js');
  const arbiter = between(
    backgroundSource,
    'async function handleAmazonAttemptCommit(request, senderTabId)',
    'async function claimAmazonTimeoutAttempt(attempt)'
  );
  const atomicSet = arbiter.indexOf('await chrome.storage.local.set({\n            orderData,');
  const orders = arbiter.indexOf('amazonOrders: incomingOrders', atomicSet);
  const cursor = arbiter.indexOf('amazonPaginationState: completedState', orders);
  const complete = arbiter.indexOf('amazonParsingComplete: completion', cursor);
  const timeout = arbiter.indexOf('amazonTimeoutAttempt: null', complete);
  assert.ok(atomicSet >= 0 && orders > atomicSet && cursor > orders && complete > cursor && timeout > complete,
    'rows, cursor, completion permit and timeout reset must share one background commit');
});
