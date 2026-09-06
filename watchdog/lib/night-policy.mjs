// Read-only decisions shared by the external watchdog and its regression tests.
export const MINUTE = 60_000;
export const MAX_COORDINATOR_WAKES = 2;

export function nightWindow(now) {
  const date = new Date(now);
  const slot = new Date(date);
  slot.setHours(23, 0, 0, 0);
  if (date < slot) slot.setDate(slot.getDate() - 1);
  const deadline = new Date(slot);
  deadline.setDate(deadline.getDate() + 1);
  deadline.setHours(6, 30, 0, 0);
  return { slot: slot.getTime(), active: now >= slot.getTime() + 15 * MINUTE && now < deadline.getTime() };
}

export function parserInFlight(s) {
  return s.pipelineStage?.active === true
    || ['starting', 'running'].includes(s.pipelineRun?.status)
    || s.parsingState?.isParsingAllStores === true
    || Boolean(s.iherbStageFinalizing || s.amazonStageFinalizing
      || s.pendingIherbSwitch || s.pendingAccountSwitch);
}

export function coordinatorWakeDecision(s, previous, now, { childAlive = false } = {}) {
  const window = nightWindow(now);
  const sameSlot = previous?.slot === window.slot;
  const attempt = sameSlot ? previous : { slot: window.slot, attempts: 0 };
  if (!window.active) return { wake: false, reason: 'outside-night-window', attempt };
  if (s.dailyAutoParseEnabled === false || s.lastDailyAutoParseStatus === 'disabled') return { wake: false, reason: 'disabled', attempt };
  if (parserInFlight(s)) return { wake: false, reason: 'parser-active', attempt };
  if (Number(s.lastDailyAutoParseTriggeredAt) >= window.slot) return { wake: false, reason: 'already-started', attempt };
  if (childAlive) return { wake: false, reason: 'coordinator-process-alive', attempt };
  if (Number(attempt.attempts) >= MAX_COORDINATOR_WAKES) return { wake: false, reason: 'wake-budget-exhausted', attempt };
  if (attempt.lastAt && now - attempt.lastAt < 15 * MINUTE) return { wake: false, reason: 'wake-cooldown', attempt };
  return { wake: true, reason: 'coordinator-wake', attempt: { slot: window.slot, attempts: Number(attempt.attempts || 0) + 1, lastAt: now } };
}

export function sheetsReceipt(s, slot) {
  const run = s.pipelineRun;
  const finishedAt = Number(run?.finishedAt) || 0;
  const completed = Boolean(run?.id && run.status === 'completed' && finishedAt >= slot);
  const confirmed = completed && s.lastSheetsUploadRunId === run.id
    && Number(s.lastSheetsUploadOkAt) >= finishedAt && !s.pendingSheetsUpload;
  return { completed, confirmed, finishedAt, runId: run?.id || null };
}

const values = (o, keys) => keys.map(key => o?.[key] ?? null);

export function observeProgress(s, previous, now) {
  const stage = s.pipelineStage;
  const name = stage?.stages?.[stage.currentIndex] || stage?.stageName;
  if (!stage?.active || !s.pipelineRun?.id || stage.runId !== s.pipelineRun.id || !name) {
    return { hung: false, observation: null, idleMinutes: 0, stage: name };
  }
  const identity = JSON.stringify([s.pipelineRun.id, stage.stageStartedAt, name]);
  const queue = Array.isArray(s.trackScreenshotQueue) ? s.trackScreenshotQueue : null;
  const fingerprint = JSON.stringify([
    values(s.progressState?.[name], ['current', 'total', 'found', 'status']),
    values(s.amazonPaginationState, ['currentPage', 'lastCompletedPage', 'isActive']),
    values(s.multiAccountState, ['currentAmazonAccount']),
    values(s.multiAccountIherbState, ['currentIherbAccount']),
    s.iherbParseAttemptId || null,
    queue && [queue.length, ...values(queue[0], ['orderId', 'trackNumber', 'accountName'])],
  ]);
  // A sleeping/offline watchdog has no continuous evidence of a stall. Neither a
  // stage's age nor a repeating heartbeat counts as work moving forward.
  const continuous = previous?.identity === identity && previous.fingerprint === fingerprint
    && now >= previous.lastSeenAt && now - previous.lastSeenAt <= 35 * MINUTE;
  const unchangedSince = continuous ? previous.unchangedSince : now;
  const idleMinutes = Math.floor((now - unchangedSince) / MINUTE);
  return {
    hung: idleMinutes >= 30,
    idleMinutes, stage: name,
    observation: { identity, fingerprint, unchangedSince, lastSeenAt: now },
  };
}
