import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const background = readFileSync(new URL('background.js', ROOT), 'utf8');

function extractFunction(name) {
  const functionStart = background.indexOf(`function ${name}`);
  assert.notEqual(functionStart, -1, `function ${name} not found`);
  const start = background.slice(functionStart - 6, functionStart) === 'async '
    ? functionStart - 6
    : functionStart;

  const openParen = background.indexOf('(', start);
  let parenDepth = 0;
  let closeParen = -1;
  for (let i = openParen; i < background.length; i++) {
    if (background[i] === '(') parenDepth++;
    if (background[i] === ')' && --parenDepth === 0) {
      closeParen = i;
      break;
    }
  }
  assert.notEqual(closeParen, -1, `signature for ${name} is incomplete`);

  const openBrace = background.indexOf('{', closeParen);
  let braceDepth = 0;
  for (let i = openBrace; i < background.length; i++) {
    if (background[i] === '{') braceDepth++;
    if (background[i] === '}' && --braceDepth === 0) {
      return background.slice(start, i + 1);
    }
  }
  assert.fail(`body for ${name} is incomplete`);
}

test('screenshot stage credit includes open MV3 tail only for a non-empty persisted queue', () => {
  const context = {
    SCREENSHOT_STAGE_BUDGET_MAX_MS: 6 * 60 * 60_000,
    result: null,
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunction('getScreenshotStageBudgetCreditMs')}
    result = getScreenshotStageBudgetCreditMs({
      budget: { stageName: 'iherb', stageStartedAt: 100_000, accruedMs: 60_000, activeSince: 200_000 },
      stageName: 'iherb', stageStartedAt: 100_000, queueHasItems: true, now: 500_000
    });`, context);
  assert.equal(context.result, 360_000);

  vm.runInContext(`result = getScreenshotStageBudgetCreditMs({
    budget: { stageName: 'iherb', stageStartedAt: 100_000, accruedMs: 60_000, activeSince: 200_000 },
    stageName: 'iherb', stageStartedAt: 100_000, queueHasItems: false, now: 500_000
  });`, context);
  assert.equal(context.result, 60_000, 'empty persisted queue must not extend activeSince');

  vm.runInContext(`result = getScreenshotStageBudgetCreditMs({
    budget: { stageName: 'iherb', stageStartedAt: 99_999, accruedMs: 999_999, activeSince: 100_000 },
    stageName: 'iherb', stageStartedAt: 100_000, queueHasItems: true, now: 500_000
  });`, context);
  assert.equal(context.result, 0, 'budget from another stage generation must be ignored');

  vm.runInContext(`result = getScreenshotStageBudgetCreditMs({
    budget: { stageName: 'iherb', stageStartedAt: 100_000, accruedMs: 9_999_999, activeSince: null },
    stageName: 'iherb', stageStartedAt: 100_000, queueHasItems: true, now: 500_000
  });`, context);
  assert.equal(context.result, 9_999_999, 'healthy sequential account drains must not be clipped at 45 minutes');
});

test('51 minutes of wall time with 49 minutes of screenshots is only 2 minutes of parser time', () => {
  const context = { result: null };
  vm.createContext(context);
  vm.runInContext(`${extractFunction('getEffectivePipelineStageElapsedMs')}
    result = getEffectivePipelineStageElapsedMs({
      startedAt: 0,
      now: 51 * 60_000,
      screenshotCreditMs: 49 * 60_000
    });`, context);
  assert.equal(context.result, 2 * 60_000);

  vm.runInContext(`result = getEffectivePipelineStageElapsedMs({
    startedAt: 0,
    now: 51 * 60_000,
    screenshotCreditMs: 0
  });`, context);
  assert.equal(context.result, 51 * 60_000, 'without matching screenshot credit the stage must still time out');
});

test('sequential drains accumulate but later real parser time still counts', () => {
  const context = {
    SCREENSHOT_STAGE_BUDGET_MAX_MS: 6 * 60 * 60_000,
    credit: null,
    elapsed: null,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('getScreenshotStageBudgetCreditMs'), context);
  vm.runInContext(extractFunction('getEffectivePipelineStageElapsedMs'), context);
  vm.runInContext(`
    credit = getScreenshotStageBudgetCreditMs({
      budget: { stageName: 'iherb', stageStartedAt: 1_000, accruedMs: 30 * 60_000, activeSince: null },
      stageName: 'iherb', stageStartedAt: 1_000, queueHasItems: false, now: 66 * 60_000 + 1_000
    });
    elapsed = getEffectivePipelineStageElapsedMs({
      startedAt: 1_000,
      now: 66 * 60_000 + 1_000,
      screenshotCreditMs: credit
    });
  `, context);
  assert.equal(context.credit, 30 * 60_000, 'three 10-minute drains remain accumulated');
  assert.equal(context.elapsed, 36 * 60_000, '36 minutes of non-screenshot work remain chargeable');
});

test('watchdog closes stale activeSince only when persisted queue is empty', async () => {
  const writes = [];
  const state = {
    screenshotStageBudget: {
      stageName: 'iherb', stageStartedAt: 100_000, accruedMs: 50_000, activeSince: 200_000,
    },
    trackScreenshotQueue: [],
  };
  const context = {
    chrome: {
      storage: {
        local: {
          get: async () => state,
          set: async value => writes.push(value),
        },
      },
    },
    console: { warn() {} },
    Date,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('closeStaleScreenshotStageBudget'), context);
  const pipeline = {
    active: true,
    stages: ['iherb', 'ebay'],
    currentIndex: 0,
    stageStartedAt: 100_000,
  };

  await context.closeStaleScreenshotStageBudget(pipeline, state.screenshotStageBudget);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].screenshotStageBudget.activeSince, null);
  assert.equal(writes[0].screenshotStageBudget.accruedMs, 50_000);

  writes.length = 0;
  state.trackScreenshotQueue = [{ trackNumber: 'pending' }];
  await context.closeStaleScreenshotStageBudget(pipeline, state.screenshotStageBudget);
  assert.equal(writes.length, 0, 'non-empty persisted queue keeps activeSince open across restart');
});

test('queue persistence serializes immutable snapshots and commits final []', async () => {
  const writes = [];
  let firstSetStartedResolve;
  let releaseFirstResolve;
  const firstSetStarted = new Promise(resolve => { firstSetStartedResolve = resolve; });
  const releaseFirst = new Promise(resolve => { releaseFirstResolve = resolve; });
  let setCalls = 0;
  const context = {
    trackScreenshotQueue: [],
    isProcessingScreenshots: false,
    screenshotQueuePersistChain: Promise.resolve(),
    screenshotQueueReady: Promise.resolve(),
    checkpointScreenshotStageBudget: async () => {},
    chrome: {
      storage: {
        local: {
          set: async value => {
            setCalls++;
            if (setCalls === 1) {
              firstSetStartedResolve();
              await releaseFirst;
            }
            writes.push(JSON.parse(JSON.stringify(value)));
          },
        },
      },
    },
    console: { warn() {} },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('persistScreenshotQueue'), context);

  context.trackScreenshotQueue = [{ orderId: 'A', trackNumber: 'T1', extraTracks: ['T2'] }];
  const first = context.persistScreenshotQueue();
  await firstSetStarted;
  context.trackScreenshotQueue[0].extraTracks.push('late-mutation');
  context.trackScreenshotQueue = [];
  const second = context.persistScreenshotQueue();
  releaseFirstResolve();
  await Promise.all([first, second]);

  assert.deepEqual(writes, [
    { trackScreenshotQueue: [{ orderId: 'A', trackNumber: 'T1', extraTracks: ['T2'] }] },
    { trackScreenshotQueue: [] },
  ]);
});

test('account switches are gated by a bounded terminal drain', () => {
  const switchFn = extractFunction('switchToNextIherbAccountOnce');
  const drainAt = switchFn.indexOf('await waitForScreenshotsDrained()');
  const shiftAt = switchFn.indexOf('queue.shift()');
  assert.ok(drainAt > -1 && drainAt < shiftAt, 'drain must happen before account queue shift');

  const finalizeFn = extractFunction('finalizeIherbStage');
  assert.match(
    finalizeFn,
    /if \(currentIherbAccount\) \{\s*if \(!await waitForScreenshotsDrained\(\)\)/,
    'watchdog/captcha finalize paths must use the same account drain gate',
  );

  const amazonSwitchFn = extractFunction('switchToNextAmazonAccount');
  assert.match(
    amazonSwitchFn,
    /if \(currentAmazonAccount\) \{\s*if \(!await waitForScreenshotsDrained\(\)\)/,
    'Amazon account-bound cards must not cross an account switch either',
  );

  assert.doesNotMatch(
    background,
    /processScreenshotQueue\(\)\.finally\(\(\) => (?:switchToNextIherbAccount|finalizeIherbStage)/,
    're-entry guard makes .finally account switches unsafe',
  );
  assert.match(
    background,
    /if \(!await waitForScreenshotsDrained\(\)\)[\s\S]*?await switchToNextIherbAccount\(\);/,
  );
});

test('three long healthy iHerb drains remain outside the parser stage budget', () => {
  const context = { SCREENSHOT_STAGE_BUDGET_MAX_MS: 6 * 60 * 60_000, credit: null, elapsed: null };
  vm.createContext(context);
  vm.runInContext(extractFunction('getScreenshotStageBudgetCreditMs'), context);
  vm.runInContext(extractFunction('getEffectivePipelineStageElapsedMs'), context);
  vm.runInContext(`
    credit = getScreenshotStageBudgetCreditMs({
      budget: { stageName: 'iherb', stageStartedAt: 1_000, accruedMs: 96 * 60_000, activeSince: null },
      stageName: 'iherb', stageStartedAt: 1_000, queueHasItems: false, now: 116 * 60_000 + 1_000
    });
    elapsed = getEffectivePipelineStageElapsedMs({ startedAt: 1_000, now: 116 * 60_000 + 1_000, screenshotCreditMs: credit });
  `, context);
  assert.equal(context.credit, 96 * 60_000);
  assert.equal(context.elapsed, 20 * 60_000, 'only real parser/account-switch time counts toward the 25-minute cap');
});

test('filtered empty queue is awaited before processor returns', () => {
  const processFn = extractFunction('processScreenshotQueue');
  assert.match(
    processFn,
    /trackScreenshotQueue = await filterAlreadySent\(trackScreenshotQueue\);[\s\S]*?await persistScreenshotQueue\(\);\s*if \(trackScreenshotQueue\.length === 0\)/,
  );
  assert.match(processFn, /finally \{\s*isProcessingScreenshots = false;\s*await finishScreenshotStageBudget\(\);/);
});

test('budget generation is reset on every pipeline stage and on runtime cleanup', () => {
  const advanceFn = extractFunction('advancePipelineStageOnce');
  assert.match(
    advanceFn,
    /screenshotStageBudget:[\s\S]*?stageName: nextStage,[\s\S]*?stageStartedAt: nextStageStartedAt,[\s\S]*?accruedMs: 0,[\s\S]*?activeSince: null/,
  );
  const finishTerminalFn = extractFunction('finishTerminalPipelineState');
  assert.match(finishTerminalFn, /screenshotStageBudget: null/);

  const cleanupFn = extractFunction('clearPipelineRuntimeState');
  assert.match(cleanupFn, /'screenshotStageBudget'/);
});
