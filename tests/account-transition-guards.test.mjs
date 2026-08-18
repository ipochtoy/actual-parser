import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const background = readFileSync(new URL('background.js', ROOT), 'utf8');
const amazonPicker = readFileSync(new URL('content-switch-account.js', ROOT), 'utf8');
const amazonRedirect = readFileSync(new URL('content-amazon-redirect.js', ROOT), 'utf8');
const iherbLogin = readFileSync(new URL('content-iherb-login.js', ROOT), 'utf8');

function extractFunction(source, name) {
  const marker = `function ${name}`;
  const functionStart = source.indexOf(marker);
  assert.notEqual(functionStart, -1, `${name} not found`);
  const start = source.slice(functionStart - 6, functionStart) === 'async '
    ? functionStart - 6
    : functionStart;
  const openParen = source.indexOf('(', functionStart);
  let parens = 0;
  let closeParen = -1;
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === '(') parens++;
    if (source[i] === ')' && --parens === 0) { closeParen = i; break; }
  }
  const openBrace = source.indexOf('{', closeParen);
  let braces = 0;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === '{') braces++;
    if (source[i] === '}' && --braces === 0) return source.slice(start, i + 1);
  }
  assert.fail(`${name} body incomplete`);
}

test('Amazon picker rereads exact run/account/tab intent after waits and before click', async () => {
  let ownership = { owned: true, runId: 'run-1', account: 'target@example.com', tabId: 77 };
  let pending = { runId: 'run-1', email: 'target@example.com' };
  const context = {
    Promise,
    chrome: {
      runtime: { sendMessage: async () => ownership },
      storage: { local: { get: async () => ({ pendingAccountSwitch: pending, amazonFinalReturn: false }) } },
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(amazonPicker, 'normalizeSwitchEmail'), context);
  vm.runInContext(extractFunction(amazonPicker, 'readFreshSwitchIntent'), context);
  const expected = { runId: 'run-1', account: 'target@example.com', tabId: 77, finalReturn: false };
  assert.equal((await context.readFreshSwitchIntent(expected)).ownership.runId, 'run-1');
  ownership = { ...ownership, runId: 'run-2' };
  pending = { runId: 'run-2', email: 'other@example.com' };
  assert.equal(await context.readFreshSwitchIntent(expected), null);

  assert.match(amazonPicker, /picker was settling/);
  assert.match(amazonPicker, /intent changed before click/);
  assert.doesNotMatch(amazonPicker, /remove\(\['pendingAccountSwitch'\]\)/);
});

test('iHerb login and captcha mutations require a fresh exact intent', async () => {
  let ownership = { owned: true, runId: 'run-1', account: 'iherb@example.com', tabId: 12 };
  let pending = { runId: 'run-1', email: 'iherb@example.com', password: 'configured' };
  const context = {
    Promise,
    sendMessageAsync: async () => ownership,
    chrome: {
      storage: { local: { get: async () => ({ pendingIherbSwitch: pending, iherbFinalReturn: false }) } },
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(iherbLogin, 'normalizeIherbEmail'), context);
  vm.runInContext(extractFunction(iherbLogin, 'readFreshIherbLoginIntent'), context);
  const expected = { runId: 'run-1', email: 'iherb@example.com', tabId: 12, finalReturn: false };
  assert.equal((await context.readFreshIherbLoginIntent(expected)).ownership.tabId, 12);
  ownership = { ...ownership, account: 'new@example.com' };
  pending = { ...pending, email: 'new@example.com' };
  assert.equal(await context.readFreshIherbLoginIntent(expected), null);

  const twoStep = extractFunction(iherbLogin, 'runTwoStepLogin');
  assert.match(twoStep, /assertFreshIherbLoginIntent\(expectedIntent\)[\s\S]*?continueBtn\.click\(\)/);
  assert.match(twoStep, /assertFreshIherbLoginIntent\(expectedIntent\)[\s\S]*?signInBtn\.click\(\)/);
  const captcha = extractFunction(iherbLogin, 'trySolveCaptcha');
  assert.match(captcha, /assertFreshIherbLoginIntent\(expectedIntent\)[\s\S]*?injectRecaptchaToken/);
  assert.match(captcha, /assertFreshIherbLoginIntent\(expectedIntent\)[\s\S]*?submitBtn\.click/);
  assert.doesNotMatch(iherbLogin, /remove\(\['pendingIherbSwitch'\]\)/);
});

test('stale iHerb watchdog generation cannot mutate a later stage', () => {
  const context = {};
  vm.createContext(context);
  for (const name of [
    'normalizeAccountEmail',
    'pipelineGenerationFromStage',
    'pipelineGenerationMatches',
    'iherbWatchdogAttemptFromState',
    'iherbWatchdogAttemptMatches',
  ]) vm.runInContext(extractFunction(background, name), context);

  const state = {
    pipelineRun: { id: 'run-1', status: 'running' },
    pipelineStage: {
      active: true, runId: 'run-1', startedAt: 1, stageStartedAt: 2,
      stages: ['iherb', 'ebay', 'amazon', 'done'], currentIndex: 0,
    },
    multiAccountIherbState: { currentIherbAccount: 'iherb@example.com' },
    iherbParserTabId: 9,
    iherbParseStartedAt: 100,
    iherbParseAttemptId: 'attempt-1',
    iherbWatchdogRetried: false,
    iherbSwitchInProgress: false,
  };
  const attempt = context.iherbWatchdogAttemptFromState(state);
  assert.equal(context.iherbWatchdogAttemptMatches(state, attempt), true);
  assert.equal(context.iherbWatchdogAttemptMatches({
    ...state,
    pipelineStage: { ...state.pipelineStage, currentIndex: 1, stageStartedAt: 3 },
  }, attempt), false);
  assert.equal(context.iherbWatchdogAttemptMatches({
    ...state,
    multiAccountIherbState: { currentIherbAccount: 'other@example.com' },
  }, attempt), false);

  const watchdog = extractFunction(background, 'handleIherbWatchdog');
  assert.match(watchdog, /afterHeartbeat[\s\S]*?iherbWatchdogAttemptMatches\(afterHeartbeat, attempt\)/);
  assert.match(watchdog, /withIherbAttemptMutation[\s\S]*?iherbParseAttemptId: retryAttemptId/,
    'watchdog retry rotation must share the exact-attempt arbiter');
  assert.match(watchdog, /commitIherbTimeoutOutcome\(attempt, 'parse_timeout'\)[\s\S]*?switchToNextIherbAccount\(attempt\.generation\)/);
  assert.match(watchdog, /switchToNextIherbAccount\(attempt\.generation\)/);
});

test('account transition atomically resets stale iHerb timers and Amazon uses rolling orders', () => {
  const switchIherb = extractFunction(background, 'switchToNextIherbAccountOnce');
  const arbiterAt = switchIherb.indexOf('withIherbAttemptMutation');
  const prepareAt = switchIherb.indexOf('pendingIherbSwitch:');
  const parseTimerAt = switchIherb.indexOf('iherbParseStartedAt: null', prepareAt);
  const retryTimerAt = switchIherb.indexOf('iherbWatchdogRetried: null', prepareAt);
  const multiAt = switchIherb.indexOf('multiAccountIherbState:', prepareAt);
  assert.ok(arbiterAt >= 0 && prepareAt > arbiterAt
    && parseTimerAt > prepareAt && retryTimerAt > parseTimerAt && multiAt > retryTimerAt);

  assert.match(amazonRedirect, /orderFilter=months-3/);
  assert.doesNotMatch(amazonRedirect, /orderFilter=year-\d{4}/);
  assert.match(amazonRedirect, /freshFlags\.accountSwitchInProgress/);
});

test('stage cap returns account-bound shops to primary before advancing', () => {
  const watchdog = extractFunction(background, 'handlePipelineWatchdog');
  assert.match(watchdog, /stage === 'iherb'[\s\S]*?finalizeIherbStage\(undefined,[\s\S]*?return/);
  assert.match(watchdog, /stage === 'amazon'[\s\S]*?beginAmazonStageFinalization\(generation\)[\s\S]*?return/);
  const directAdvanceAt = watchdog.lastIndexOf('await advancePipelineStage(generation)');
  const ebayGateAt = watchdog.lastIndexOf("if (typeof storesCompleted === 'object')");
  assert.ok(directAdvanceAt > ebayGateAt, 'only the eBay tail may directly advance');
});

test('restart reconciliation preserves durable switches, drains and finalizers', () => {
  const reconcile = extractFunction(background, 'reconcileStalePipelineState');
  assert.match(reconcile, /iherbStageFinalizing/);
  assert.match(reconcile, /amazonStageFinalizing/);
  assert.match(reconcile, /pendingIherbSwitch/);
  assert.match(reconcile, /pendingAccountSwitch/);
  assert.match(reconcile, /screenshotBudgetMatches/);
  assert.match(reconcile, /finalizingOwned \|\| pendingOwned \|\| dispatchOwned/);
  assert.doesNotMatch(reconcile, /chrome\.tabs\.query\(\{ url: 'https:\/\/\*\.iherb\.com/);

  const pressHoldHandler = extractFunction(background, 'handleIherbPressHoldDetected');
  assert.match(pressHoldHandler, /iherbOwnedActionMatches\(state, expected\)/);
  assert.match(pressHoldHandler, /iherbHumanChallenge:[\s\S]*?screenshotQueueBlocked:/);
  assert.doesNotMatch(pressHoldHandler, /chrome\.debugger|chrome\.tabs\.update|solveIherbPressHold/);
});

test('iHerb final return owns login only and fences late parser commits', () => {
  const door = background.slice(
    background.indexOf('request.action === "getParserContext"'),
    background.indexOf('request.action === "getAmazonParserContext"'),
  );
  assert.match(door, /purpose === 'login' \? finalizingIherbAccount : null/);
  assert.match(iherbLogin, /purpose: 'login'/);
  assert.match(readFileSync(new URL('content-iherb.js', ROOT), 'utf8'), /purpose: 'parse'/);
  const verify = extractFunction(readFileSync(new URL('content-iherb.js', ROOT), 'utf8'), 'verifyIherbParserContext');
  assert.match(verify, /iherbStageFinalizing\?\.runId !== context\.runId/);
});

test('iHerb final return rechecks generation after a delayed tab lookup', async () => {
  const generation = { runId: 'run-1', startedAt: 1, currentIndex: 0, stageStartedAt: 2 };
  const primary = { email: 'primary@example.com', password: 'configured', isPrimary: true };
  const state = {
    pipelineRun: { id: 'run-1', status: 'running' },
    pipelineStage: {
      active: true,
      runId: 'run-1',
      startedAt: 1,
      currentIndex: 0,
      stageStartedAt: 2,
      stages: ['iherb', 'ebay', 'amazon', 'done'],
    },
    iherbParserTabId: 7,
    iherbStageFinalizing: {
      ...generation,
      shop: 'iherb',
      account: primary.email,
      returnStatus: 'prepared',
    },
    pendingIherbSwitch: null,
    iherbSwitchDispatch: null,
  };
  let releaseTab;
  let tabLookupStarted;
  const tabStarted = new Promise(resolve => { tabLookupStarted = resolve; });
  const tabGate = new Promise(resolve => { releaseTab = resolve; });
  const calls = { sets: 0, removes: 0, navigations: 0 };
  const context = {
    Date,
    Promise,
    parserOperationFlights: new Map(),
    console: { log() {}, warn() {}, error() {} },
    loadAccountsConfig: async () => ({ iherb: [primary] }),
    getPrimary: accounts => accounts.find(account => account.isPrimary),
    async ensureValidIherbParserTab() {
      tabLookupStarted();
      await tabGate;
      return 7;
    },
    async iherbUiSignOutAndNavigateToLogin() { calls.navigations++; },
    async waitForIherbFinalReturnCompletion() { return true; },
    sendTelegramMessage: async () => {},
    setTimeout,
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const result = {};
            for (const key of keys) result[key] = structuredClone(state[key]);
            return result;
          },
          async set(mutation) {
            calls.sets++;
            Object.assign(state, structuredClone(mutation));
          },
          async remove(keys) {
            calls.removes++;
            for (const key of keys) delete state[key];
          },
        },
      },
    },
  };
  vm.createContext(context);
  for (const name of [
    'normalizeAccountEmail',
    'pipelineGenerationMatches',
    'pipelineOperationKey',
    'runParserOperationSingleFlight',
    'finalReturnToIherbPrimaryOnce',
  ]) {
    vm.runInContext(extractFunction(background, name), context);
  }
  vm.runInContext(extractFunction(background, 'finalReturnToIherbPrimary'), context);

  const returning = context.finalReturnToIherbPrimary(7, generation);
  await tabStarted;
  state.pipelineStage = {
    ...state.pipelineStage,
    currentIndex: 1,
    stageStartedAt: 3,
  };
  state.iherbStageFinalizing = null;
  releaseTab();

  assert.equal(await returning, false);
  assert.deepEqual(calls, { sets: 0, removes: 0, navigations: 0 });
  assert.equal(state.pendingIherbSwitch, null);
  assert.equal(state.iherbSwitchDispatch, null);
});

test('regular iHerb account dispatch also stops before stale navigation', async () => {
  const generation = { runId: 'run-1', startedAt: 1, currentIndex: 0, stageStartedAt: 2 };
  const state = {
    pipelineRun: { id: 'run-1', status: 'running' },
    pipelineStage: {
      active: true,
      runId: 'run-1',
      startedAt: 1,
      currentIndex: 0,
      stageStartedAt: 2,
      stages: ['iherb', 'ebay', 'amazon', 'done'],
    },
    multiAccountIherbState: { currentIherbAccount: 'next@example.com' },
    pendingIherbSwitch: { runId: 'run-1', email: 'next@example.com' },
    iherbParserTabId: 7,
    iherbSwitchDispatch: null,
  };
  let releaseTab;
  let tabLookupStarted;
  const tabStarted = new Promise(resolve => { tabLookupStarted = resolve; });
  const tabGate = new Promise(resolve => { releaseTab = resolve; });
  const calls = { sets: 0, navigations: 0, failures: 0 };
  const context = {
    Date,
    Promise,
    parserOperationFlights: new Map(),
    console: { log() {}, warn() {}, error() {} },
    async ensureValidIherbParserTab() {
      tabLookupStarted();
      await tabGate;
      return 7;
    },
    async iherbUiSignOutAndNavigateToLogin() { calls.navigations++; },
    async handleIherbSwitchFailure() { calls.failures++; },
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const result = {};
            for (const key of keys) result[key] = structuredClone(state[key]);
            return result;
          },
          async set(mutation) {
            calls.sets++;
            Object.assign(state, structuredClone(mutation));
          },
        },
      },
    },
  };
  vm.createContext(context);
  for (const name of [
    'normalizeAccountEmail',
    'pipelineGenerationMatches',
    'pipelineOperationKey',
    'runParserOperationSingleFlight',
    'dispatchCurrentIherbAccountSwitchOnce',
  ]) {
    vm.runInContext(extractFunction(background, name), context);
  }
  vm.runInContext(extractFunction(background, 'dispatchCurrentIherbAccountSwitch'), context);

  const dispatch = context.dispatchCurrentIherbAccountSwitch('next@example.com', generation);
  await tabStarted;
  state.pipelineStage = {
    ...state.pipelineStage,
    currentIndex: 1,
    stageStartedAt: 3,
  };
  releaseTab();

  assert.equal(await dispatch, false);
  assert.deepEqual(calls, { sets: 0, navigations: 0, failures: 0 });
  assert.equal(state.iherbSwitchDispatch, null);
});

test('duplicate iHerb final return shares one logout and login sequence', async () => {
  const generation = { runId: 'run-1', startedAt: 1, currentIndex: 0, stageStartedAt: 2 };
  const primary = { email: 'primary@example.com', password: 'configured', isPrimary: true };
  const state = {
    pipelineRun: { id: 'run-1', status: 'running' },
    pipelineStage: {
      active: true,
      runId: 'run-1',
      startedAt: 1,
      currentIndex: 0,
      stageStartedAt: 2,
      stages: ['iherb', 'ebay', 'amazon', 'done'],
    },
    iherbParserTabId: 7,
    iherbStageFinalizing: {
      ...generation,
      shop: 'iherb',
      account: primary.email,
      returnStatus: 'prepared',
    },
    pendingIherbSwitch: null,
    iherbSwitchDispatch: null,
  };
  const calls = { navigations: 0, removes: 0, waits: 0, phases: [] };
  const context = {
    Date,
    Promise,
    parserOperationFlights: new Map(),
    console: { log() {}, warn() {}, error() {} },
    loadAccountsConfig: async () => ({ iherb: [primary] }),
    getPrimary: accounts => accounts.find(account => account.isPrimary),
    ensureValidIherbParserTab: async () => 7,
    async iherbUiSignOutAndNavigateToLogin() { calls.navigations++; },
    async waitForIherbFinalReturnCompletion() { calls.waits++; return true; },
    sendTelegramMessage: async () => {},
    setTimeout,
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const result = {};
            for (const key of keys) result[key] = structuredClone(state[key]);
            return result;
          },
          async set(mutation) {
            if (mutation.iherbSwitchDispatch?.phase) {
              calls.phases.push(mutation.iherbSwitchDispatch.phase);
            }
            Object.assign(state, structuredClone(mutation));
          },
          async remove(keys) {
            calls.removes++;
            for (const key of keys) delete state[key];
          },
        },
      },
    },
  };
  vm.createContext(context);
  for (const name of [
    'normalizeAccountEmail',
    'pipelineGenerationMatches',
    'pipelineOperationKey',
    'runParserOperationSingleFlight',
    'finalReturnToIherbPrimaryOnce',
    'finalReturnToIherbPrimary',
  ]) vm.runInContext(extractFunction(background, name), context);

  const [first, second] = await Promise.all([
    context.finalReturnToIherbPrimary(7, generation),
    context.finalReturnToIherbPrimary(7, generation),
  ]);
  assert.deepEqual([first, second], [true, true]);
  assert.equal(calls.navigations, 1);
  assert.equal(calls.removes, 1);
  assert.equal(calls.waits, 1);
  assert.deepEqual(calls.phases, ['prepared', 'dispatched']);
  assert.equal(context.parserOperationFlights.size, 0);
});
