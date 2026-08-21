import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const background = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const content = readFileSync(new URL('../content-iherb.js', import.meta.url), 'utf8');

function extractFunction(source, name) {
  const functionStart = source.indexOf(`function ${name}`);
  assert.notEqual(functionStart, -1, `${name} not found`);
  const start = source.slice(functionStart - 6, functionStart) === 'async '
    ? functionStart - 6
    : functionStart;
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

test('MV3 restart preserves the next tick of an existing periodic alarm', async () => {
  const existing = {
    name: 'iherbParseWatchdog',
    periodInMinutes: 1,
    scheduledTime: 123456,
  };
  const creates = [];
  const context = {
    Number,
    chrome: {
      alarms: {
        async get() { return existing; },
        create(name, options) { creates.push({ name, options }); },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(background, 'ensurePeriodicAlarm'), context);

  const result = await context.ensurePeriodicAlarm('iherbParseWatchdog', 1);
  assert.equal(result.created, false);
  assert.equal(result.alarm.scheduledTime, 123456);
  assert.deepEqual(creates, [], 'worker startup must not replace/postpone the alarm');
});

test('missing or misconfigured periodic alarm is created with the exact cadence', async () => {
  for (const existing of [null, { name: 'iherbParseWatchdog', periodInMinutes: 5 }]) {
    const creates = [];
    const context = {
      Number,
      chrome: {
        alarms: {
          async get() { return existing; },
          create(name, options) { creates.push({ name, options }); },
        },
      },
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(background, 'ensurePeriodicAlarm'), context);
    const result = await context.ensurePeriodicAlarm('iherbParseWatchdog', 1);
    assert.equal(result.created, true);
    assert.deepEqual(JSON.parse(JSON.stringify(creates)), [{
      name: 'iherbParseWatchdog',
      options: { delayInMinutes: 1, periodInMinutes: 1 },
    }]);
  }
});

function activeIherbState() {
  return {
    pipelineRun: { id: 'run-1', status: 'running' },
    pipelineStage: {
      active: true,
      runId: 'run-1',
      startedAt: 1,
      stageStartedAt: 2,
      stages: ['iherb', 'ebay', 'amazon', 'done'],
      currentIndex: 0,
    },
    multiAccountIherbState: { currentIherbAccount: 'iherb@example.com' },
    iherbParserTabId: 9,
    iherbParseAttemptId: 'attempt-1',
    iherbParseStartedAt: 100,
    iherbWatchdogRetried: false,
    iherbSwitchInProgress: false,
    iherbStageFinalizing: null,
    iherbTimeoutAttempt: null,
  };
}

test('iHerb watchdog snapshot and heartbeat are bound to the exact attempt', () => {
  const context = { Number, Date, IHERB_HEARTBEAT_STALE_MS: 90_000 };
  vm.createContext(context);
  for (const name of [
    'normalizeAccountEmail',
    'pipelineGenerationFromStage',
    'pipelineGenerationMatches',
    'iherbWatchdogAttemptFromState',
    'iherbWatchdogAttemptMatches',
    'iherbHeartbeatMatchesAttempt',
    'iherbHeartbeatIsFresh',
  ]) vm.runInContext(extractFunction(background, name), context);

  const state = activeIherbState();
  const attempt = context.iherbWatchdogAttemptFromState(state);
  assert.equal(attempt.attemptId, 'attempt-1');
  assert.equal(context.iherbWatchdogAttemptMatches(state, attempt), true);
  assert.equal(context.iherbWatchdogAttemptMatches({
    ...state,
    iherbParseAttemptId: 'attempt-2',
  }, attempt), false);

  const heartbeat = {
    runId: 'run-1',
    account: 'IHERB@example.com',
    attemptId: 'attempt-1',
    ts: 123,
  };
  assert.equal(context.iherbHeartbeatMatchesAttempt(heartbeat, attempt), true);
  assert.equal(context.iherbHeartbeatMatchesAttempt({
    ...heartbeat,
    attemptId: 'attempt-2',
  }, attempt), false);
  assert.equal(context.iherbHeartbeatMatchesAttempt({
    ...heartbeat,
    runId: 'run-2',
  }, attempt), false);
  assert.equal(context.iherbHeartbeatIsFresh({ ...heartbeat, ts: 910_000 }, { now: 1_000_000 }), true);
  assert.equal(context.iherbHeartbeatIsFresh({ ...heartbeat, ts: 909_999 }, { now: 1_000_000 }), false);
});

async function runWatchdogHeartbeatScenario(heartbeat) {
  const now = 1_000_000;
  const FixedDate = class extends Date { static now() { return now; } };
  const state = {
    ...activeIherbState(),
    iherbParseStartedAt: now - 240_001,
  };
  const events = [];
  const context = {
    Date: FixedDate,
    Math,
    Number,
    console: { log() {}, warn() {} },
    IHERB_PARSE_TIMEOUT_MS: 240_000,
    IHERB_SWITCH_TIMEOUT_MS: 300_000,
    IHERB_HEARTBEAT_STALE_MS: 90_000,
    async readIherbWatchdogState() { return structuredClone(state); },
    iherbWatchdogAttemptFromState(current) {
      return {
        runId: current.pipelineRun.id,
        account: current.multiAccountIherbState.currentIherbAccount,
        parserTabId: current.iherbParserTabId,
        attemptId: current.iherbParseAttemptId,
        parseStartedAt: current.iherbParseStartedAt,
        retried: current.iherbWatchdogRetried,
        generation: {},
      };
    },
    iherbWatchdogAttemptMatches() { return true; },
    iherbAttemptIdentityMatches() { return false; },
    async consumeIherbCompletionMarker() {},
    async withIherbAttemptMutation(work) { return work(); },
    pipelineGenerationMatches() { return true; },
    normalizeAccountEmail(value) { return String(value || '').toLowerCase(); },
    async commitIherbTimeoutOutcome() { return { status: 'timeout-won' }; },
    async handleIherbSwitchFailure() {},
    sendTelegramMessage() { return Promise.resolve(); },
    chrome: {
      scripting: { async executeScript() { return [{ result: structuredClone(heartbeat) }]; } },
      storage: {
        local: {
          async set(mutation) {
            events.push({ type: 'set', mutation: structuredClone(mutation) });
            Object.assign(state, structuredClone(mutation));
          },
        },
      },
      tabs: {
        async update(tabId, mutation) {
          events.push({ type: 'reload', tabId, mutation: structuredClone(mutation) });
        },
      },
    },
  };
  vm.createContext(context);
  for (const name of [
    'iherbHeartbeatMatchesAttempt',
    'iherbHeartbeatIsFresh',
    'handleIherbWatchdog',
  ]) vm.runInContext(extractFunction(background, name), context);
  await context.handleIherbWatchdog();
  return { state, events };
}

test('fresh exact iHerb heartbeat defers recovery while stale or foreign evidence recovers', async () => {
  const exact = { runId: 'run-1', account: 'iherb@example.com', attemptId: 'attempt-1' };
  const fresh = await runWatchdogHeartbeatScenario({ ...exact, ts: 999_999 });
  assert.equal(fresh.state.iherbWatchdogRetried, false);
  assert.equal(fresh.events.length, 0, 'fresh progress must not rotate or reload the attempt');

  for (const heartbeat of [
    { ...exact, ts: 900_000 },
    { ...exact, runId: 'foreign-run', ts: 999_999 },
  ]) {
    const recovery = await runWatchdogHeartbeatScenario(heartbeat);
    assert.equal(recovery.state.iherbWatchdogRetried, true);
    assert.equal(recovery.events.some(event => event.type === 'reload'), true);
  }
});

test('nonterminal iHerb progress accepts only the exact run account attempt and tab', () => {
  const context = {
    iherbTimeoutAttemptMatchesRuntime(marker) { return !!marker; },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(background, 'normalizeAccountEmail'), context);
  vm.runInContext(extractFunction(background, 'iherbProgressOwnsActiveAttempt'), context);

  const state = activeIherbState();
  const progress = {
    store: 'iHerb',
    status: 'Loading orders 90/150...',
    runId: 'run-1',
    account: 'iherb@example.com',
    attemptId: 'attempt-1',
  };
  assert.equal(context.iherbProgressOwnsActiveAttempt(progress, 9, state), true);
  for (const [changed, tabId] of [
    [{ ...progress, runId: 'run-2' }, 9],
    [{ ...progress, account: 'other@example.com' }, 9],
    [{ ...progress, attemptId: 'attempt-2' }, 9],
    [progress, 10],
  ]) assert.equal(context.iherbProgressOwnsActiveAttempt(changed, tabId, state), false);

  const handler = extractFunction(background, 'handleProgressMessage');
  const gate = handler.indexOf('iherbProgressOwnsActiveAttempt');
  const mutation = handler.indexOf('cachedProgressState[storeKey]');
  assert.ok(gate >= 0 && mutation > gate,
    'ownership must be checked before any progress cache mutation');
});

test('iHerb content attaches immutable provenance to heartbeat and progress', () => {
  const scroll = extractFunction(content, 'slowProgressiveScroll');
  assert.match(scroll, /const provenance = Object\.freeze\(/);
  assert.match(scroll, /HEARTBEAT_KEY[\s\S]*?\.\.\.provenance/);
  assert.match(scroll, /action: 'parsingProgress'[\s\S]*?\.\.\.provenance/);
});
