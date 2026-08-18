import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const background = readFileSync(new URL('background.js', ROOT), 'utf8');
const contentIherb = readFileSync(new URL('content-iherb.js', ROOT), 'utf8');

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

function baseState() {
  const generation = {
    runId: 'run-1',
    startedAt: 100,
    currentIndex: 0,
    stageStartedAt: 200,
  };
  return {
    pipelineRun: { id: 'run-1', status: 'running' },
    pipelineStage: {
      ...generation,
      active: true,
      stages: ['iherb', 'ebay', 'amazon', 'done'],
    },
    iherbParserTabId: 77,
    iherbFinalReturn: true,
    iherbStageFinalizing: {
      ...generation,
      shop: 'iherb',
      account: 'primary@example.com',
      tabId: 77,
      returnStatus: 'prepared',
    },
    pendingIherbSwitch: {
      runId: 'run-1',
      email: 'primary@example.com',
      password: 'configured',
    },
    iherbSwitchDispatch: {
      ...generation,
      account: 'primary@example.com',
      tabId: 77,
      kind: 'final-return',
      phase: 'dispatched',
    },
  };
}

function createContext(extra = {}) {
  const context = { URL, Date, Number, String, ...extra };
  vm.createContext(context);
  for (const name of [
    'normalizeAccountEmail',
    'pipelineGenerationFromStage',
    'pipelineGenerationMatches',
    'iherbFinalReturnStateMatches',
    'iherbFinalReturnLoginSubmitMatches',
    'iherbFinalReturnLandingMatches',
    'markIherbFinalReturnLoginSubmitted',
    'confirmIherbFinalReturnLanding',
  ]) vm.runInContext(extractFunction(background, name), context);
  return context;
}

test('only the exact owned iHerb orders landing can confirm final return', () => {
  const context = createContext();
  const exact = baseState();
  assert.equal(context.iherbFinalReturnLandingMatches(
    exact,
    77,
    'https://secure.iherb.com/myaccount/orders?rcode=abc',
  ), false, 'dispatch alone is not proof that the primary login was submitted');
  exact.iherbSwitchDispatch.phase = 'login-submitted';
  assert.equal(context.iherbFinalReturnLandingMatches(
    exact,
    77,
    'https://secure.iherb.com/myaccount/orders?rcode=abc',
  ), true);

  const negatives = [
    [exact, 78, 'https://secure.iherb.com/myaccount/orders'],
    [exact, 77, 'https://www.iherb.com/'],
    [{ ...exact, iherbFinalReturn: false }, 77, 'https://secure.iherb.com/myaccount/orders'],
    [{ ...exact, pipelineStage: { ...exact.pipelineStage, currentIndex: 1 } }, 77, 'https://secure.iherb.com/myaccount/orders'],
    [{ ...exact, iherbSwitchDispatch: { ...exact.iherbSwitchDispatch, phase: 'prepared' } }, 77, 'https://secure.iherb.com/myaccount/orders'],
    [{ ...exact, pendingIherbSwitch: { ...exact.pendingIherbSwitch, email: 'other@example.com' } }, 77, 'https://secure.iherb.com/myaccount/orders'],
  ];
  for (const [state, tabId, url] of negatives) {
    assert.equal(context.iherbFinalReturnLandingMatches(state, tabId, url), false);
  }
});

test('landing confirmation rereads generation before its durable write', async () => {
  let state = baseState();
  state.iherbSwitchDispatch.phase = 'login-submitted';
  const writes = [];
  const context = createContext({
    chrome: {
      storage: {
        local: {
          get: async () => structuredClone(state),
          set: async patch => {
            writes.push(structuredClone(patch));
            state = { ...state, ...structuredClone(patch) };
          },
        },
      },
    },
  });
  const result = await context.confirmIherbFinalReturnLanding(
    77,
    'https://secure.iherb.com/myaccount/orders',
  );
  assert.equal(result.confirmed, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes[0].iherbFinalReturnConfirmed)),
    {
      runId: 'run-1',
      startedAt: 100,
      currentIndex: 0,
      stageStartedAt: 200,
      account: 'primary@example.com',
      tabId: 77,
      confirmedAt: writes[0].iherbFinalReturnConfirmed.confirmedAt,
    },
  );

  let reads = 0;
  state = baseState();
  state.iherbSwitchDispatch.phase = 'login-submitted';
  writes.length = 0;
  context.chrome.storage.local.get = async () => {
    reads++;
    if (reads === 2) state = {
      ...state,
      pipelineStage: { ...state.pipelineStage, currentIndex: 1, stageStartedAt: 300 },
    };
    return structuredClone(state);
  };
  const stale = await context.confirmIherbFinalReturnLanding(
    77,
    'https://secure.iherb.com/myaccount/orders',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(stale)), {
    confirmed: false,
    reason: 'landing_generation_changed',
  });
  assert.equal(writes.length, 0);
});

test('exact final-return login submit advances the durable dispatch proof', async () => {
  let state = baseState();
  const writes = [];
  const context = createContext({
    chrome: {
      storage: {
        local: {
          get: async () => structuredClone(state),
          set: async patch => {
            writes.push(structuredClone(patch));
            state = { ...state, ...structuredClone(patch) };
          },
        },
      },
    },
  });
  const accepted = await context.markIherbFinalReturnLoginSubmitted(
    77,
    'https://checkout.iherb.com/auth/ui/account/login',
  );
  assert.equal(accepted.accepted, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].iherbSwitchDispatch.phase, 'login-submitted');

  state = baseState();
  writes.length = 0;
  const rejected = await context.markIherbFinalReturnLoginSubmitted(
    78,
    'https://checkout.iherb.com/auth/ui/account/login',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(rejected)), {
    accepted: false,
    reason: 'stale_or_foreign_login',
  });
  assert.equal(writes.length, 0);
});

test('iHerb orders content asks background to confirm before skipping parse', () => {
  const helper = extractFunction(contentIherb, 'confirmIherbFinalReturnLanding');
  assert.match(helper, /action: 'confirmIherbFinalReturnLanding'/);
  const finalGate = contentIherb.slice(
    contentIherb.indexOf("const finalReturnCheck = await chrome.storage.local.get(['iherbFinalReturn'])"),
    contentIherb.indexOf('// Multi-account resume:'),
  );
  assert.match(finalGate, /await confirmIherbFinalReturnLanding\(\)/);
  assert.match(finalGate, /skipping parse/);
  assert.match(background, /request\.action === "confirmIherbFinalReturnLanding"/);
  const login = readFileSync(new URL('content-iherb-login.js', ROOT), 'utf8');
  const submitProof = extractFunction(login, 'markIherbFinalReturnLoginSubmitted');
  assert.match(submitProof, /action: 'markIherbFinalReturnLoginSubmitted'/);
  assert.match(extractFunction(login, 'runTwoStepLogin'),
    /markIherbFinalReturnLoginSubmitted\(expectedIntent\)[\s\S]*?signInBtn\.click\(\)/);
  assert.match(extractFunction(login, 'runLegacyLogin'),
    /markIherbFinalReturnLoginSubmitted\(expectedIntent\)[\s\S]*?submitBtn\.click\(\)/);
  assert.match(extractFunction(login, 'trySolveCaptcha'),
    /markIherbFinalReturnLoginSubmitted\(expectedIntent\)[\s\S]*?injectRecaptchaToken\(token\)/);
});

test('a final-session return failure degrades without erasing parsed cabinet proof', () => {
  const context = { Date, structuredClone };
  vm.createContext(context);
  vm.runInContext(extractFunction(background, 'normalizeAccountEmail'), context);
  vm.runInContext(extractFunction(background, 'applyPipelineOperationalFailure'), context);
  const run = {
    id: 'run-1',
    status: 'running',
    expected: {
      iherb: ['primary@example.com', 'second@example.com', 'third@example.com'],
      amazon: ['amazon-primary@example.com', 'amazon-second@example.com'],
    },
    completed: {
      iherb: ['primary@example.com', 'second@example.com', 'third@example.com'],
      amazon: ['amazon-primary@example.com', 'amazon-second@example.com'],
    },
    failures: [],
  };
  const failedReturn = context.applyPipelineOperationalFailure(
    run,
    'iherb',
    'primary@example.com',
    { runId: 'run-1', reason: 'final-primary-return-failed' },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(failedReturn.completed.iherb)),
    ['primary@example.com', 'second@example.com', 'third@example.com'],
  );
  assert.equal(failedReturn.failures.length, 1);
  assert.equal(failedReturn.failures[0].reason, 'final-primary-return-failed');

  const resumeFinalizer = extractFunction(background, 'resumeIherbStageFinalization');
  assert.match(resumeFinalizer, /recordPipelineOperationalFailure\('iherb'/);
  assert.doesNotMatch(resumeFinalizer, /markPipelineAccountResult\('iherb',[\s\S]*?final-primary-return-failed/);

  const failedAmazonReturn = context.applyPipelineOperationalFailure(
    run,
    'amazon',
    'amazon-primary@example.com',
    { runId: 'run-1', reason: 'final-primary-return-failed' },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(failedAmazonReturn.completed.amazon)),
    ['amazon-primary@example.com', 'amazon-second@example.com'],
  );
  const resumeAmazonFinalizer = extractFunction(background, 'resumeAmazonStageFinalization');
  assert.match(resumeAmazonFinalizer, /recordPipelineOperationalFailure\('amazon'/);
  assert.doesNotMatch(resumeAmazonFinalizer, /markPipelineAccountResult\('amazon',[\s\S]*?final-primary-return-failed/);
});
