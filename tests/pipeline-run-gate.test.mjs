import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const background = readFileSync(new URL('background.js', ROOT), 'utf8');
const amazon = readFileSync(new URL('content-amazon.js', ROOT), 'utf8');
const ebay = readFileSync(new URL('content-ebay.js', ROOT), 'utf8');
const iherb = readFileSync(new URL('content-iherb.js', ROOT), 'utf8');

function extractFunction(source, name) {
  const marker = `function ${name}`;
  const functionStart = source.indexOf(marker);
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

test('roster gate requires exactly 3 iHerb, 1 eBay and 2 Amazon accounts', () => {
  const exact = {
    iherb: ['photopochtoy@gmail.com', 'questburgh@gmail.com', 'oksanasorokapocht@gmail.com'],
    ebay: ['ipochtoy@gmail.com'],
    amazon: ['ipochtoy@gmail.com', 'photopochtoy@gmail.com'],
  };
  const context = { EXPECTED_PIPELINE_ROSTER: exact };
  vm.createContext(context);
  vm.runInContext(extractFunction(background, 'normalizeAccountEmail'), context);
  vm.runInContext(extractFunction(background, 'buildExpectedPipelineRoster'), context);
  const config = {
    iherb: [
      { email: exact.iherb[0], isPrimary: true, password: 'configured-1' },
      { email: exact.iherb[1], isPrimary: false, password: 'configured-2' },
      { email: exact.iherb[2], isPrimary: false, password: 'configured-3' },
    ],
    ebay: [{ email: exact.ebay[0], isPrimary: true }],
    amazon: [{ email: exact.amazon[0], isPrimary: true }, { email: exact.amazon[1], isPrimary: false }],
  };
  assert.deepEqual(JSON.parse(JSON.stringify(context.buildExpectedPipelineRoster(config))), exact);
  assert.throws(() => context.buildExpectedPipelineRoster({ ...config, amazon: config.amazon.slice(0, 1) }), /exact 3 iHerb/);
  assert.throws(() => context.buildExpectedPipelineRoster({ ...config, iherb: config.iherb.map(a => ({ ...a, isPrimary: false })) }), /primary first/);
  assert.throws(() => context.buildExpectedPipelineRoster({ ...config, ebay: [{ email: 'somebody@example.com', isPrimary: true }] }), /exact 3 iHerb/);
  assert.throws(() => context.buildExpectedPipelineRoster({ ...config, amazon: [...config.amazon].reverse() }), /primary first/);
  assert.throws(() => context.buildExpectedPipelineRoster({
    ...config,
    iherb: config.iherb.map((a, index) => index === 1 ? { ...a, password: '' } : a),
  }), /credentials configured/);
});

test('only exact six-account completion is green', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(extractFunction(background, 'getPipelineRunOutcome'), context);
  const expected = { iherb: ['i1', 'i2', 'i3'], ebay: ['e1'], amazon: ['a1', 'a2'] };
  const complete = { iherb: ['i1', 'i2', 'i3'], ebay: ['e1'], amazon: ['a1', 'a2'] };
  assert.equal(context.getPipelineRunOutcome({ expected, completed: complete, failures: [] }).status, 'completed');
  const partial = structuredClone(complete);
  partial.amazon.pop();
  const outcome = context.getPipelineRunOutcome({ expected, completed: partial, failures: [] });
  assert.equal(outcome.status, 'degraded');
  assert.deepEqual(Array.from(outcome.missing.amazon), ['a2']);
  assert.equal(context.getPipelineRunOutcome({ expected, completed: complete, failures: [{ shop: 'ebay' }] }).status, 'degraded');
});

test('all launch doors use the same mutexed daily runner', () => {
  const listenerStart = background.indexOf('chrome.runtime.onMessage.addListener');
  const listenerEnd = background.indexOf('// Keep persistent popup settings', listenerStart);
  const listener = background.slice(listenerStart, listenerEnd > listenerStart ? listenerEnd : undefined);
  assert.match(listener, /request\.action === "startSequentialPipeline"[\s\S]*?runDailyAutoParse\('popup'\)/);
  assert.match(background, /await runDailyAutoParse\('telegram'\)/);
  assert.match(background, /runDailyAutoParse\('watchdog-control'\)/);
  assert.match(background, /await runDailyAutoParse\('alarm'\)/);
  assert.match(extractFunction(background, 'runDailyAutoParse'), /dailyRunStartInFlight/);
});

test('completion permits carry run and account provenance and stale permits are rejected', () => {
  for (const source of [amazon, ebay, iherb]) {
    assert.match(source, /runId/);
    assert.match(source, /account/);
  }
  for (const source of [ebay, iherb]) {
    assert.match(source, /parser_run_id/);
    assert.match(source, /observed_at/);
  }
  const amazonFinish = extractFunction(amazon, 'finishPaginationParsing');
  assert.match(amazonFinish, /commitAmazonAttempt\('complete', state,[\s\S]*?orders: state\.allOrders/);
  assert.match(amazonFinish, /status: 'Done ✅'[\s\S]*?runId: state\.runId[\s\S]*?account: state\.account/);
  const amazonCommit = extractFunction(background, 'handleAmazonAttemptCommit');
  assert.match(amazonCommit, /parser_run_id: attempt\.runId/);
  assert.match(amazonCommit, /parser_account: attempt\.account/);
  assert.match(amazonCommit, /observed_at: observedAt/);
  const progress = extractFunction(background, 'handleProgressMessage');
  assert.match(progress, /const wrongRun = !request\.runId \|\| request\.runId !== stored\.pipelineRun\.id/);
  assert.match(progress, /const wrongAttempt = storeKey === 'iherb'/);
  assert.match(progress, /const wrongTab = storeKey === 'amazon'/);
  const watchdog = background.slice(background.indexOf("if (alarm.name !== WATCHDOG_ALARM_NAME) return;"));
  assert.match(watchdog, /amazonCompletionMatchesAttempt\(stored, activeAttempt\)/);
  assert.match(watchdog, /consumeAmazonCompletionMarker\(generation\)/);
  const amazonPermit = extractFunction(background, 'amazonCompletionMatchesAttempt');
  assert.match(amazonPermit, /marker\.runId === attempt\.runId/);
  assert.match(amazonPermit, /normalizeAccountEmail\(marker\.account\) === attempt\.account/);
  assert.match(amazonPermit, /marker\.parserTabId === attempt\.parserTabId/);
});

test('tracked Parser source does not contain default account passwords', () => {
  const defaults = background.slice(
    background.indexOf('const DEFAULT_ACCOUNTS_CONFIG'),
    background.indexOf('async function loadAccountsConfig'),
  );
  assert.doesNotMatch(defaults, /password:\s*['"][^'"]+['"]/);
});

test('old timers and watchdogs cannot mutate a newer pipeline generation', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(extractFunction(background, 'pipelineGenerationFromStage'), context);
  vm.runInContext(extractFunction(background, 'pipelineGenerationMatches'), context);
  const oldStage = { runId: 'old', startedAt: 10, currentIndex: 0, stageStartedAt: 11 };
  const oldGeneration = context.pipelineGenerationFromStage(oldStage);
  assert.equal(context.pipelineGenerationMatches(oldStage, oldGeneration), true);
  assert.equal(context.pipelineGenerationMatches({ ...oldStage, runId: 'new' }, oldGeneration), false);
  assert.equal(context.pipelineGenerationMatches({ ...oldStage, stageStartedAt: 12 }, oldGeneration), false);

  const stop = extractFunction(background, 'stopPipelineForScreenshotDrain');
  assert.match(stop, /pipelineGenerationMatches\(p, expectedGeneration\)/);
  const advance = extractFunction(background, 'advancePipelineStage');
  assert.match(advance, /pipelineGenerationMatches\(gate\.pipelineStage, expectedGeneration\)/);
  const iherbReturn = extractFunction(background, 'waitForIherbFinalReturnCompletion');
  assert.match(iherbReturn, /pipelineGenerationMatches\(state\.pipelineStage, expectedGeneration\)/);
  const iherbFinalize = extractFunction(background, 'finalizeIherbStage');
  assert.doesNotMatch(iherbFinalize, /setTimeout/);
  const watchdog = extractFunction(background, 'handlePipelineWatchdog');
  assert.match(watchdog, /pipelineGenerationMatches\(beforeSideEffects, generation\)/);
  assert.match(watchdog, /advancePipelineStage\(generation\)/);
  const amazonReturn = extractFunction(background, 'finalReturnToPrimaryAmazonOnce');
  assert.doesNotMatch(amazonReturn, /setTimeout/);
  assert.match(amazonReturn, /waitForAmazonFinalReturnCompletion\(generation, 60_000\)/);
  const amazonReturnWait = extractFunction(background, 'waitForAmazonFinalReturnCompletion');
  assert.match(amazonReturnWait, /pipelineGenerationMatches\(state\.pipelineStage, expectedGeneration\)/);
});

test('iHerb primary is proven by an exact re-login, never by someone-is-logged-in', () => {
  const finalReturn = extractFunction(background, 'finalReturnToIherbPrimaryOnce');
  assert.match(finalReturn, /iherbUiSignOutAndNavigateToLogin\(tabId\)/);
  assert.doesNotMatch(finalReturn, /iherbIsLoggedIn/);
  assert.doesNotMatch(finalReturn, /alreadyOnPrimary/);
  assert.match(finalReturn, /pendingIherbSwitch:[\s\S]*?email: primary\.email[\s\S]*?runId: expectedGeneration\.runId/);
  assert.match(finalReturn, /waitForIherbFinalReturnCompletion\(expectedGeneration, 60_000\)/);
});
