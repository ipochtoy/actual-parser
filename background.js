// Background script for Pochtoy Parser - v7.8.0 (reliable sequential six-cabinet nightly run)

// --- Daily Auto-Parse at 23:00 ---
const DAILY_PARSE_HOUR = 23; // 23:00 local time
const DAILY_PARSE_MINUTE = 0;
const DAILY_ALARM_NAME = 'dailyAutoParse';
const DAILY_ALARM_DRIFT_TOLERANCE_MS = 2 * 60 * 1000;
const DAILY_MISSED_RUN_CATCHUP_MS = 2 * 60 * 60 * 1000;
const DAILY_DIAGNOSTICS_KEY = 'dailyAutoParseDiagnostics';
const DAILY_DIAGNOSTICS_LIMIT = 80;
let dailyDiagnosticWriteQueue = Promise.resolve();
let dailyRunStartInFlight = null;
let resolveStartupPipelineReconciled = null;
const startupPipelineReconciled = new Promise(resolve => {
    resolveStartupPipelineReconciled = resolve;
});

function addDailyDiagnostic(event, details = {}) {
    dailyDiagnosticWriteQueue = dailyDiagnosticWriteQueue
        .then(() => writeDailyDiagnostic(event, details))
        .catch(error => {
            console.warn('⚠️ Failed to write daily auto-parse diagnostic:', error?.message || error);
        });
    return dailyDiagnosticWriteQueue;
}

async function writeDailyDiagnostic(event, details = {}) {
    try {
        const [alarm, storage] = await Promise.all([
            chrome.alarms.get(DAILY_ALARM_NAME).catch(() => null),
            chrome.storage.local.get([
                DAILY_DIAGNOSTICS_KEY,
                'dailyAutoParseEnabled',
                'pipelineStage',
                'parsingState',
                'stopAllParsers',
                'lastDailyAutoParseTriggeredAt',
                'lastDailyAutoParseStatus',
                'lastDailyAutoParseSource'
            ])
        ]);
        const diagnostics = Array.isArray(storage[DAILY_DIAGNOSTICS_KEY])
            ? storage[DAILY_DIAGNOSTICS_KEY]
            : [];
        const entry = {
            ts: Date.now(),
            event,
            details,
            alarm: alarm ? {
                name: alarm.name,
                scheduledTime: alarm.scheduledTime,
                periodInMinutes: alarm.periodInMinutes
            } : null,
            state: {
                enabled: storage.dailyAutoParseEnabled !== false,
                pipelineActive: !!storage.pipelineStage?.active,
                pipelineStage: storage.pipelineStage?.active
                    ? storage.pipelineStage?.stages?.[storage.pipelineStage.currentIndex]
                    : null,
                parsingAllStores: !!storage.parsingState?.isParsingAllStores,
                stopAllParsers: !!storage.stopAllParsers,
                lastTriggerAt: storage.lastDailyAutoParseTriggeredAt || null,
                lastTriggerStatus: storage.lastDailyAutoParseStatus || null,
                lastTriggerSource: storage.lastDailyAutoParseSource || null
            }
        };
        diagnostics.push(entry);
        await chrome.storage.local.set({
            [DAILY_DIAGNOSTICS_KEY]: diagnostics.slice(-DAILY_DIAGNOSTICS_LIMIT)
        });
        console.log('[daily-autoparse]', event, entry);
    } catch (error) {
        throw error;
    }
}

function formatDailyDiagnostic(entry) {
    if (!entry) return '';
    const when = new Date(entry.ts).toLocaleString('ru-RU');
    const next = entry.alarm?.scheduledTime
        ? new Date(entry.alarm.scheduledTime).toLocaleString('ru-RU')
        : 'нет alarm';
    const reason = entry.details?.reason || entry.details?.source || entry.details?.skipReason || '';
    return `${when} — ${entry.event}${reason ? ` (${reason})` : ''}; next: ${next}`;
}

function getNextDailyRun(now = new Date()) {
    const next = new Date(now.getTime());
    next.setHours(DAILY_PARSE_HOUR, DAILY_PARSE_MINUTE, 0, 0);

    if (now >= next) {
        next.setDate(next.getDate() + 1);
    }

    return next;
}

function getLastDailyRunSlot(now = new Date()) {
    const slot = new Date(now);
    slot.setHours(DAILY_PARSE_HOUR, DAILY_PARSE_MINUTE, 0, 0);
    if (now < slot) slot.setDate(slot.getDate() - 1);
    return slot;
}

function setupDailyAlarm(reason = 'setup') {
    const now = new Date();
    const next = getNextDailyRun(now);
    const msUntilNext = next.getTime() - now.getTime();
    const minutesUntilNext = msUntilNext / 1000 / 60;

    console.log(`⏰ Daily parse scheduled for ${next.toLocaleString('ru-RU')} (in ${Math.round(minutesUntilNext)} minutes)`);

    // One-shot local-time alarm. A repeating 1440-minute alarm drifts to
    // 22:00/00:00 Pittsburgh when DST changes.
    chrome.alarms.create(DAILY_ALARM_NAME, { when: next.getTime() });

    chrome.storage.local.set({
        dailyAlarmLastCheckedAt: now.getTime(),
        dailyAlarmLastScheduledAt: now.getTime(),
        dailyAlarmScheduledFor: next.getTime(),
        dailyAlarmScheduleReason: reason
    }).catch(() => {});
    addDailyDiagnostic('alarm-scheduled', {
        reason,
        scheduledFor: next.getTime(),
        minutesUntilNext: Math.round(minutesUntilNext)
    });

    return next;
}

async function ensureDailyAlarm(reason = 'ensure') {
    const settings = await chrome.storage.local.get(['dailyAutoParseEnabled']);
    if (settings.dailyAutoParseEnabled === false) {
        const existing = await chrome.alarms.get(DAILY_ALARM_NAME);
        if (existing) await chrome.alarms.clear(DAILY_ALARM_NAME);
        await chrome.storage.local.set({
            dailyAlarmLastCheckedAt: Date.now(),
            dailyAlarmScheduleReason: `${reason}: disabled`
        });
        await addDailyDiagnostic('alarm-disabled', { reason, clearedExisting: !!existing });
        return null;
    }

    const expected = getNextDailyRun();
    const existing = await chrome.alarms.get(DAILY_ALARM_NAME);
    const existingTime = existing?.scheduledTime || 0;
    const driftMs = Math.abs(existingTime - expected.getTime());

    if (!existing || driftMs > DAILY_ALARM_DRIFT_TOLERANCE_MS || existing.periodInMinutes != null) {
        await addDailyDiagnostic(existing ? 'alarm-reschedule-needed' : 'alarm-missing', {
            reason,
            existingScheduledTime: existing?.scheduledTime || null,
            expectedScheduledTime: expected.getTime(),
            driftMs,
            existingPeriodInMinutes: existing?.periodInMinutes || null
        });
        return setupDailyAlarm(`${reason}: ${existing ? 'rescheduled' : 'missing'}`);
    }

    await chrome.storage.local.set({
        dailyAlarmLastCheckedAt: Date.now(),
        dailyAlarmScheduledFor: existing.scheduledTime,
        dailyAlarmScheduleReason: `${reason}: ok`
    });
    await addDailyDiagnostic('alarm-ok', {
        reason,
        scheduledFor: existing.scheduledTime
    });
    return new Date(existing.scheduledTime);
}

async function runDailyAutoParse(source) {
    if (dailyRunStartInFlight) {
        await addDailyDiagnostic('run-skip', { source, skipReason: 'start-already-in-flight' });
        return dailyRunStartInFlight;
    }
    dailyRunStartInFlight = runDailyAutoParseOnce(source);
    try {
        return await dailyRunStartInFlight;
    } finally {
        dailyRunStartInFlight = null;
    }
}

async function runDailyAutoParseOnce(source) {
    console.log(`⏰ Daily auto-parse started (${source})`);
    await addDailyDiagnostic('run-start', { source });

    // A repeated alarm, watchdog command or manual click must never reset a live
    // run. The old path wrote fresh state and launched a second iHerb pipeline,
    // so both flows raced for the same parser tab/account.
    const beforeStart = await chrome.storage.local.get([
        'pipelineStage', 'parsingState', 'screenshotQueueBlocked', 'trackScreenshotQueue',
        'pendingSheetsUpload', 'iherbHumanChallenge'
    ]);
    if (beforeStart.pipelineStage?.active || beforeStart.parsingState?.isParsingAllStores) {
        await addDailyDiagnostic('run-skip', {
            source,
            skipReason: 'pipeline-already-active',
            stage: beforeStart.pipelineStage?.stages?.[beforeStart.pipelineStage?.currentIndex] || null
        });
        console.warn(`⏸ Daily auto-parse ignored (${source}): pipeline already active`);
        return false;
    }
    if (beforeStart.iherbHumanChallenge?.status === 'awaiting-human') {
        await chrome.storage.local.set({
            lastDailyAutoParseAttemptedAt: Date.now(),
            lastDailyAutoParseSource: source,
            lastDailyAutoParseStatus: 'blocked-human-captcha',
            lastDailyAutoParseError: 'iHerb Press & Hold still requires a human'
        });
        await addDailyDiagnostic('run-skip', {
            source,
            skipReason: 'iherb-press-hold-human-required'
        });
        return false;
    }
    if (beforeStart.screenshotQueueBlocked
        && Array.isArray(beforeStart.trackScreenshotQueue)
        && beforeStart.trackScreenshotQueue.length > 0) {
        await chrome.storage.local.set({
            lastDailyAutoParseAttemptedAt: Date.now(),
            lastDailyAutoParseSource: source,
            lastDailyAutoParseStatus: 'blocked-screenshots',
            lastDailyAutoParseError: 'account-bound screenshot queue requires recovery'
        });
        await addDailyDiagnostic('run-skip', { source, skipReason: 'screenshot-queue-blocked' });
        return false;
    }
    if (beforeStart.pendingSheetsUpload?.runId) {
        await chrome.storage.local.set({
            lastDailyAutoParseAttemptedAt: Date.now(),
            lastDailyAutoParseSource: source,
            lastDailyAutoParseStatus: 'blocked-pending-sheets',
            lastDailyAutoParseError: 'previous run still has an unresolved Sheets upload'
        });
        await addDailyDiagnostic('run-skip', { source, skipReason: 'pending-sheets-upload' });
        return false;
    }

    // Sequential pipeline avoids active-tab races between shop flows. Await the
    // durable start commit: otherwise a storage/navigation error leaves status
    // "started" forever while no pipeline exists.
    let pipelineRun = null;
    try {
        pipelineRun = await createPipelineRun(source);
        await chrome.storage.local.set({
            lastDailyAutoParseAttemptedAt: pipelineRun.attemptedAt,
            lastDailyAutoParseSource: source,
            lastDailyAutoParseStatus: 'starting',
            lastDailyAutoParseError: null
        });

        // Reset states and start parsing.
        cachedProgressState = {};
        parseReport = {
            stores: {},
            screenshots: { sent: 0, skipped: 0, failed: 0, broken: 0 },
            startedAt: pipelineRun.attemptedAt,
            runId: pipelineRun.id
        };
        await chrome.storage.local.set({ progressState: cachedProgressState, stopAllParsers: false });
        await clearParsingLogs();

        const started = await startSequentialPipeline();
        if (started?.started === false) {
            const status = started.reason === 'screenshot-queue-blocked'
                ? 'blocked-screenshots'
                : 'failed-to-start';
            await chrome.storage.local.set({
                lastDailyAutoParseStatus: status,
                lastDailyAutoParseFinishedAt: Date.now(),
                lastDailyAutoParseError: started.reason || 'start-refused'
            });
            await updatePipelineRun(run => ({
                ...run,
                status: status === 'blocked-screenshots' ? 'blocked' : 'failed_to_start',
                finishedAt: Date.now(),
                failures: [...(run.failures || []), { shop: 'pipeline', account: '', reason: started.reason || 'start-refused', at: Date.now() }]
            }));
            await addDailyDiagnostic('run-skip', { source, skipReason: started.reason || 'start-refused' });
            return false;
        }
        // startSequentialPipeline commits pipelineRun + pipelineStage + the
        // legacy trigger proof in one storage.set.  A crash can therefore leave
        // either a retryable `starting` attempt or a fully owned running stage,
        // never three mutually contradictory half-start markers.
        sendTelegramMessage('⏰ Автоматический ночной парсинг запущен (23:00)...').catch(() => {});
        return true;
    } catch (error) {
        const message = String(error?.message || error).slice(0, 300);
        isParsingAllStores = false;
        const failedState = await chrome.storage.local.get(['pipelineStage']);
        await chrome.storage.local.set({
            pipelineStage: failedState.pipelineStage
                ? { ...failedState.pipelineStage, active: false, failedAt: Date.now(), failedReason: message }
                : null,
            parsingState: { isParsingAllStores: false, storesCompleted },
            lastDailyAutoParseTriggeredAt: null,
            lastDailyAutoParseStartedAt: null,
            lastDailyAutoParseStatus: 'failed-to-start',
            lastDailyAutoParseFinishedAt: Date.now(),
            lastDailyAutoParseError: message
        });
        if (pipelineRun) {
            await updatePipelineRun(run => ({
                ...run,
                status: 'failed_to_start',
                finishedAt: Date.now(),
                failures: [...(run.failures || []), { shop: 'pipeline', account: '', reason: message, at: Date.now() }]
            }));
        }
        await addDailyDiagnostic('run-failed', { source, reason: message });
        sendTelegramMessage(`❌ Ночной парсинг не стартовал: ${message}`).catch(() => {});
        throw error;
    }
}

async function runMissedDailyAutoParseIfNeeded(reason = 'startup') {
    const now = new Date();
    const lastSlot = getLastDailyRunSlot(now);
    const missedByMs = now.getTime() - lastSlot.getTime();
    if (missedByMs <= 0 || missedByMs > DAILY_MISSED_RUN_CATCHUP_MS) {
        await addDailyDiagnostic('catchup-skip', {
            reason,
            skipReason: 'outside-catchup-window',
            lastSlot: lastSlot.getTime(),
            missedByMs
        });
        return false;
    }

    const state = await chrome.storage.local.get([
        'dailyAutoParseEnabled',
        'lastDailyAutoParseTriggeredAt',
        'pipelineStage',
        'parsingState'
    ]);

    if (state.dailyAutoParseEnabled === false) {
        await addDailyDiagnostic('catchup-skip', { reason, skipReason: 'disabled', lastSlot: lastSlot.getTime() });
        return false;
    }
    if (state.lastDailyAutoParseTriggeredAt && state.lastDailyAutoParseTriggeredAt >= lastSlot.getTime()) {
        await addDailyDiagnostic('catchup-skip', {
            reason,
            skipReason: 'already-triggered-for-slot',
            lastSlot: lastSlot.getTime(),
            lastTriggeredAt: state.lastDailyAutoParseTriggeredAt
        });
        return false;
    }
    if (state.pipelineStage?.active || state.parsingState?.isParsingAllStores) {
        await addDailyDiagnostic('catchup-skip', {
            reason,
            skipReason: 'pipeline-already-active',
            lastSlot: lastSlot.getTime()
        });
        return false;
    }

    await chrome.storage.local.set({
        lastDailyAutoParseMissedSlot: lastSlot.getTime(),
        lastDailyAutoParseCatchupAt: Date.now(),
        lastDailyAutoParseCatchupReason: reason
    });
    await addDailyDiagnostic('catchup-run', { reason, lastSlot: lastSlot.getTime(), missedByMs });
    sendTelegramMessage(`⏰ Догоняю пропущенный запуск ${lastSlot.toLocaleString('ru-RU')} (${reason})...`).catch(() => {});
    await runDailyAutoParse(`catchup:${reason}`);
    return true;
}

// Initialize and self-heal daily alarm on extension/service-worker start.
ensureDailyAlarm('service-worker-start')
    .then(() => startupPipelineReconciled)
    .then(() => runMissedDailyAutoParseIfNeeded('service-worker-start'))
    .catch(error => console.warn('⚠️ Daily alarm init failed:', error?.message || error));

chrome.runtime.onInstalled.addListener(() => {
    ensureDailyAlarm('runtime.onInstalled').catch(error => console.warn('⚠️ Daily alarm install init failed:', error?.message || error));
});

chrome.runtime.onStartup.addListener(() => {
    ensureDailyAlarm('runtime.onStartup')
        .then(() => startupPipelineReconciled)
        .then(() => runMissedDailyAutoParseIfNeeded('runtime.onStartup'))
        .catch(error => console.warn('⚠️ Daily alarm startup init failed:', error?.message || error));
});

console.log('✅ Daily auto-parse scheduler ENABLED (23:00)');

// --- Google Auth Functions (inlined to avoid import issues) ---
function getAuthToken(interactive) {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: interactive }, (token) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(token);
            }
        });
    });
}

async function removeToken(token) {
    return new Promise(resolve => chrome.identity.removeCachedAuthToken({ token }, resolve));
}

async function readSheetData(spreadsheetId, sheetName) {
    async function attemptRead(interactive) {
        const token = await getAuthToken(interactive);
        if (!token) throw new Error("Authorization failed. No token received.");

        const range = `${sheetName}!A:Z`;
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` },
        });

        if (!response.ok) {
            await removeToken(token);
            const text = await response.text().catch(() => '');
            throw new Error(`Google Sheets API status ${response.status}: ${text || 'no body'}`);
        }
        const data = await response.json();
        return data.values;
    }

    try {
        return await attemptRead(true);
    } catch (err) {
        console.warn('First read attempt failed, retrying with fresh auth...', err);
        try {
            return await attemptRead(true);
        } catch (finalErr) {
            console.error("Error reading Google Sheet:", finalErr);
            throw finalErr;
        }
    }
}

async function writeDataToSheet(spreadsheetId, sheetName, values) {
    const authToken = await getAuthToken(true);
    if (!authToken) {
        throw new Error("Authentication failed. Cannot write to sheet.");
    }

    const range = `${sheetName}!A1`;
    const valueInputOption = 'USER_ENTERED';
    const insertDataOption = 'INSERT_ROWS';

    const body = { values };

    try {
        const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=${valueInputOption}&insertDataOption=${insertDataOption}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('Google Sheets API write error response:', errorData);
            await removeToken(authToken);
            throw new Error(`Google Sheets API Error: ${errorData?.error?.message || response.status}`);
        }

        const result = await response.json();
        console.log('Successfully wrote data to sheet:', result);
        return result;

    } catch (error) {
        console.error('Error writing data to sheet:', error);
        throw error;
    }
}

// --- State Variables ---
let automationQueue = [];
let isAutomationRunning = false;
let automationTabId = null;
let automationOptions = { spreadsheetId: null, sheetName: 'Лист1', skipProcessed: true, colorProcessed: false, limitRows: true };

// --- Parse All Stores Tracking ---
let storesCompleted = { ebay: false, iherb: false, amazon: false };
let isParsingAllStores = false;
// Accumulate stats for one final Telegram report instead of spamming individual messages
let parseReport = { stores: {}, screenshots: { sent: 0, skipped: 0, failed: 0, broken: 0 }, startedAt: null };
const DEFAULT_SPREADSHEET_ID = '1w1QOzGWc_CNovlezuxyLta-h1kM3pgPXc_GoHYaOA98';
const PIPELINE_STALE_TIMEOUT_MS = 15 * 60 * 1000;

// --- Accounts Config (accountsConfig — источник истины для multi-account) ---
// DEFAULT_ACCOUNTS_CONFIG используется, если user ещё не сохранил свой конфиг
// через popup. Реальная настройка — в chrome.storage.local.accountsConfig.
// Primary account = isPrimary:true, идёт ПЕРВЫМ в массиве (парсится первым
// для iHerb, финальный возврат — для Amazon).
const DEFAULT_ACCOUNTS_CONFIG = {
  // iHerb — все три аккаунта (оператор 2026-07-04: «выпарсить все три»).
  // primary photopochtoy парсится по fast-path (уже залогинен), secondaries
  // проходят sign-out dance + логин. Все device-trusted.
  iherb: [
    { email: 'photopochtoy@gmail.com',     password: '', isPrimary: true  },
    { email: 'questburgh@gmail.com',        password: '', isPrimary: false },
    { email: 'oksanasorokapocht@gmail.com', password: '', isPrimary: false }
  ],
  amazon: [
    { email: 'ipochtoy@gmail.com',     isPrimary: true  },
    { email: 'photopochtoy@gmail.com', isPrimary: false }
  ],
  ebay: [
    { email: 'ipochtoy@gmail.com',     isPrimary: true }
  ]
};

// The nightly job is an exact six-cabinet contract, not merely a count.  A
// popup typo must fail before we clear orderData or navigate a shared browser.
const EXPECTED_PIPELINE_ROSTER = Object.freeze({
  iherb: Object.freeze([
    'photopochtoy@gmail.com',
    'questburgh@gmail.com',
    'oksanasorokapocht@gmail.com'
  ]),
  ebay: Object.freeze(['ipochtoy@gmail.com']),
  amazon: Object.freeze(['ipochtoy@gmail.com', 'photopochtoy@gmail.com'])
});

async function loadAccountsConfig() {
  const r = await chrome.storage.local.get(['accountsConfig']);
  return r.accountsConfig || DEFAULT_ACCOUNTS_CONFIG;
}

function mergeIherbAccountsWithoutSecrets(existing = [], desired = []) {
  const byEmail = new Map(existing.map(a => [normalizeAccountEmail(a?.email), a]));
  return desired.map(account => {
    const saved = byEmail.get(normalizeAccountEmail(account.email));
    return { ...account, password: saved?.password || '' };
  });
}

function normalizeAccountEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function buildExpectedPipelineRoster(config) {
  const roster = {
    iherb: (config?.iherb || []).map(a => normalizeAccountEmail(a.email)).filter(Boolean),
    ebay: (config?.ebay || []).map(a => normalizeAccountEmail(a.email)).filter(Boolean),
    amazon: (config?.amazon || []).map(a => normalizeAccountEmail(a.email)).filter(Boolean)
  };
  const primaryCounts = {
    iherb: (config?.iherb || []).filter(a => a?.isPrimary).length,
    ebay: (config?.ebay || []).filter(a => a?.isPrimary).length,
    amazon: (config?.amazon || []).filter(a => a?.isPrimary).length
  };
  const exactRoster = ['iherb', 'ebay', 'amazon'].every(shop =>
    roster[shop].length === EXPECTED_PIPELINE_ROSTER[shop].length
      && roster[shop].every((email, index) => email === EXPECTED_PIPELINE_ROSTER[shop][index])
  );
  const primaryFirst = ['iherb', 'ebay', 'amazon'].every(shop =>
    config?.[shop]?.[0]?.isPrimary === true && primaryCounts[shop] === 1
  );
  // iHerb must be able to return from the final secondary account to primary,
  // therefore all three credentials are a preflight requirement.  We only
  // validate presence; secrets never enter pipelineRun or logs.
  const iherbCredentialsReady = (config?.iherb || []).every(account =>
    typeof account?.password === 'string' && account.password.trim().length > 0
  );
  if (!exactRoster || !primaryFirst || !iherbCredentialsReady) {
    throw new Error('accountsConfig must match the exact 3 iHerb, 1 eBay and 2 Amazon roster, primary first, with all iHerb credentials configured');
  }
  return roster;
}

let pipelineRunWriteChain = Promise.resolve();

function withPipelineRunWrite(work) {
  const task = pipelineRunWriteChain
    .catch(() => {})
    .then(work);
  pipelineRunWriteChain = task.catch(() => {});
  return task;
}

function applyPipelineAccountResult(run, shop, account, {
  runId,
  ok,
  reason = '',
  found = 0
} = {}) {
  const normalized = normalizeAccountEmail(account);
  if (!runId || run?.id !== runId
      || !['starting', 'running'].includes(run.status)
      || !run.expected?.[shop]?.includes(normalized)) {
    return null;
  }

  const next = structuredClone(run);
  next.completed = next.completed && typeof next.completed === 'object'
    ? next.completed
    : {};
  next.completed[shop] = Array.isArray(next.completed[shop])
    ? next.completed[shop]
    : [];
  next.failures = Array.isArray(next.failures) ? next.failures : [];
  if (ok) {
    if (!next.completed[shop].includes(normalized)) next.completed[shop].push(normalized);
    next.failures = next.failures.filter(f => !(
      f.shop === shop && normalizeAccountEmail(f.account) === normalized
    ));
  } else {
    // A terminal failure and a completion for the same exact cabinet must never
    // coexist. A later explicitly accepted retry can add it back and remove the
    // failure through the success branch above.
    next.completed[shop] = next.completed[shop].filter(item =>
      normalizeAccountEmail(item) !== normalized
    );
    if (!next.failures.some(f => f.shop === shop
        && normalizeAccountEmail(f.account) === normalized
        && f.reason === reason)) {
      next.failures.push({
        shop,
        account: normalized,
        reason: String(reason || 'failed').slice(0, 160),
        found,
        at: Date.now()
      });
    }
  }
  return next;
}

async function createPipelineRun(source) {
  const config = await loadAccountsConfig();
  const expected = buildExpectedPipelineRoster(config);
  const now = Date.now();
  const slotAt = getLastDailyRunSlot(new Date(now)).getTime();
  const pipelineRun = {
    id: `${slotAt}-${now}-${Math.random().toString(36).slice(2, 8)}`,
    slotAt,
    source,
    status: 'starting',
    attemptedAt: now,
    startedAt: null,
    finishedAt: null,
    expected,
    completed: { iherb: [], ebay: [], amazon: [] },
    failures: []
  };
  await chrome.storage.local.set({ pipelineRun });
  return pipelineRun;
}

function updatePipelineRun(mutator) {
  return withPipelineRunWrite(async () => {
      const state = await chrome.storage.local.get(['pipelineRun']);
      if (!state.pipelineRun) return null;
      const next = await mutator(structuredClone(state.pipelineRun));
      if (!next) return state.pipelineRun;
      await chrome.storage.local.set({ pipelineRun: next });
      return next;
  });
}

async function markPipelineAccountResult(shop, account, { runId, ok, reason = '', found = 0 } = {}) {
  return updatePipelineRun(run =>
    applyPipelineAccountResult(run, shop, account, { runId, ok, reason, found }) || run
  );
}

function applyPipelineOperationalFailure(run, shop, account, {
  runId,
  reason = '',
  found = 0
} = {}) {
  const normalized = normalizeAccountEmail(account);
  if (!runId || run?.id !== runId
      || !['starting', 'running'].includes(run.status)
      || !run.expected?.[shop]?.includes(normalized)) {
    return null;
  }
  const next = structuredClone(run);
  next.failures = Array.isArray(next.failures) ? next.failures : [];
  if (!next.failures.some(f => f.shop === shop
      && normalizeAccountEmail(f.account) === normalized
      && f.reason === reason)) {
    next.failures.push({
      shop,
      account: normalized,
      reason: String(reason || 'failed').slice(0, 160),
      found,
      at: Date.now()
    });
  }
  return next;
}

async function recordPipelineOperationalFailure(shop, account, {
  runId,
  reason = '',
  found = 0
} = {}) {
  return updatePipelineRun(run =>
    applyPipelineOperationalFailure(run, shop, account, { runId, reason, found }) || run
  );
}

function markPipelineStageTimeout(shop, accounts, generation) {
  return withPipelineRunWrite(async () => {
      const state = await chrome.storage.local.get(['pipelineRun', 'pipelineStage']);
      if (!state.pipelineStage?.active
          || !pipelineGenerationMatches(state.pipelineStage, generation)
          || state.pipelineRun?.id !== generation?.runId
          || !['starting', 'running'].includes(state.pipelineRun?.status)) {
        return false;
      }
      const next = structuredClone(state.pipelineRun);
      next.completed[shop] = Array.isArray(next.completed?.[shop]) ? next.completed[shop] : [];
      next.failures = Array.isArray(next.failures) ? next.failures : [];
      const completed = new Set(next.completed[shop].map(normalizeAccountEmail));
      for (const rawAccount of accounts || []) {
        const account = normalizeAccountEmail(rawAccount);
        if (!account || completed.has(account)) continue;
        if (!next.failures.some(f => f.shop === shop
            && normalizeAccountEmail(f.account) === account
            && f.reason === 'stage-timeout')) {
          next.failures.push({
            shop,
            account,
            reason: 'stage-timeout',
            found: 0,
            at: Date.now()
          });
        }
      }
      await chrome.storage.local.set({ pipelineRun: next });
      return true;
  });
}

function getPipelineRunOutcome(run) {
  const missing = {};
  for (const shop of ['iherb', 'ebay', 'amazon']) {
    const done = new Set(run?.completed?.[shop] || []);
    missing[shop] = (run?.expected?.[shop] || []).filter(account => !done.has(account));
  }
  const complete = Object.values(missing).every(list => list.length === 0)
    && !(run?.failures || []).length;
  return { status: complete ? 'completed' : 'degraded', missing };
}

function pipelineRunAccountIsTerminal(run, shop, account) {
  const normalized = normalizeAccountEmail(account);
  if (!normalized) return false;
  if ((run?.completed?.[shop] || []).some(item => normalizeAccountEmail(item) === normalized)) {
    return true;
  }
  return (run?.failures || []).some(failure => failure?.shop === shop
    && normalizeAccountEmail(failure?.account) === normalized);
}

async function finalizePipelineRun(expectedRunId) {
  const finalRun = await updatePipelineRun(run => {
    if (!expectedRunId || run.id !== expectedRunId || !['starting', 'running'].includes(run.status)) {
      return null;
    }
    const outcome = getPipelineRunOutcome(run);
    run.status = outcome.status;
    run.finishedAt = Date.now();
    run.missing = outcome.missing;
    return run;
  });
  return finalRun?.id === expectedRunId
      && ['completed', 'degraded'].includes(finalRun.status)
    ? finalRun
    : null;
}

// --- One-time migration: перезаписать сохранённый iHerb-список на новый дефолт ---
// Сохранённый accountsConfig перекрывает DEFAULT_ACCOUNTS_CONFIG, поэтому при
// смене списка iHerb-аккаунтов нужна разовая миграция. amazon/ebay сохраняем
// как были у пользователя. Флаг iherbAccountsMigrated_20260703 защищает от
// повторного применения.
async function migrateIherbAccounts_20260703() {
  try {
    const r = await chrome.storage.local.get(['accountsConfig', 'iherbAccountsMigrated_20260703']);
    if (r.iherbAccountsMigrated_20260703) return;
    if (r.accountsConfig) {
      const migrated = {
        ...r.accountsConfig,
        iherb: mergeIherbAccountsWithoutSecrets(r.accountsConfig.iherb, DEFAULT_ACCOUNTS_CONFIG.iherb)
      };
      await chrome.storage.local.set({
        accountsConfig: migrated,
        iherbAccountsMigrated_20260703: true
      });
      console.log('🔄 [migrate] accountsConfig.iherb перезаписан на новый дефолт (questburgh + oksanasorokapocht, убран pochtoy@gmail.com)');
    } else {
      // Своего конфига нет — дефолты и так актуальны, просто ставим флаг.
      await chrome.storage.local.set({ iherbAccountsMigrated_20260703: true });
      console.log('🔄 [migrate] accountsConfig отсутствует — используется актуальный DEFAULT_ACCOUNTS_CONFIG, флаг миграции выставлен');
    }
  } catch (e) {
    console.warn('⚠️ [migrate] iHerb accounts migration failed:', e?.message || e);
  }
}
migrateIherbAccounts_20260703();

// --- One-time migration 2026-07-04: вернуть все 3 iHerb-аккаунта ---
// Прошлая миграция (_20260703) записала в storage одно-аккаунтный список
// (только photopochtoy). Теперь оператор хочет все три — перезаписываем
// сохранённый accountsConfig.iherb новым 3-аккаунтным дефолтом. Отдельный флаг.
async function migrateIherbAccounts_20260704() {
  try {
    const r = await chrome.storage.local.get(['accountsConfig', 'iherbAccountsMigrated_20260704']);
    if (r.iherbAccountsMigrated_20260704) return;
    if (r.accountsConfig) {
      await chrome.storage.local.set({
        accountsConfig: {
          ...r.accountsConfig,
          iherb: mergeIherbAccountsWithoutSecrets(r.accountsConfig.iherb, DEFAULT_ACCOUNTS_CONFIG.iherb)
        },
        iherbAccountsMigrated_20260704: true
      });
      console.log('🔄 [migrate] accountsConfig.iherb → все 3 аккаунта (photopochtoy + questburgh + oksanasorokapocht)');
    } else {
      await chrome.storage.local.set({ iherbAccountsMigrated_20260704: true });
      console.log('🔄 [migrate] accountsConfig отсутствует — 3-аккаунтный DEFAULT актуален, флаг выставлен');
    }
  } catch (e) {
    console.warn('⚠️ [migrate] iHerb accounts 20260704 migration failed:', e?.message || e);
  }
}
migrateIherbAccounts_20260704();

function getPrimary(list)     { return list.find(a => a.isPrimary) || list[0]; }
function getSecondaries(list) { return list.filter(a => !a.isPrimary); }

// --- Multi-Account Amazon Parsing ---
let amazonAccountsQueue = [];
let currentAmazonAccount = null;
let isMultiAccountParsing = false;
const MAX_ACCOUNT_SWITCH_ATTEMPTS = 2;
const ACCOUNT_PARSE_TIMEOUT_MS = 600000; // 10 мин (07.08.2026: при 4 мин кабинет photopochtoy бросался с нулём КАЖДУЮ ночь —
// в журнале account-parse:timeout reason="no progress" idleSec=243 при пороге 240, totalSec=1156: он честно отработал
// 19 минут и застрял на три секунды сверх лимита. Виноваты медленные страницы отслеживания Amazon (та же причина, по
// которой 05.08 подняли PAGE_DELAY_MS до 5 с).
const AMAZON_ACCOUNT_HARD_CAP_MS = 45 * 60_000; // живой 20-страничный кабинет занимает около 40 мин; два лимита оставляют 10 мин стадии на переключения

// --- Multi-Account iHerb Parsing ---
// Список аккаунтов с паролями теперь загружается из accountsConfig (см. выше).
let iherbAccountsQueue = [];
let currentIherbAccount = null;
let isMultiAccountIherb = false;

// --- Sequential pipeline state machine ---
// Stages are shop-level only. iHerb and Amazon drain their own
// primary → secondary → return sub-steps internally (via
// startMultiAccountIherbParsing / startMultiAccountAmazonParsing + their
// finalReturn*() siblings). Each such shop emits ONE advancePipelineStage()
// after its final-return; that moves us to the next shop-level stage.
const PIPELINE_STAGES = ['iherb', 'ebay', 'amazon', 'done'];

// --- Parsing Logs ---
const LOGS_SHEET_NAME = 'Logs';

async function addParsingLog(store, orderId, trackNumber, status, details) {
    const timestamp = new Date().toLocaleString('ru-RU', { 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit',
        day: '2-digit',
        month: '2-digit'
    });
    const logEntry = {
        timestamp,
        store,
        orderId: orderId || '-',
        trackNumber: trackNumber || '-',
        status,
        details: details || ''
    };
    
    // Store in chrome.storage.local to persist across service worker restarts
    const result = await chrome.storage.local.get(['parsingLogs']);
    const logs = result.parsingLogs || [];
    logs.push(logEntry);
    await chrome.storage.local.set({ parsingLogs: logs });
}

async function clearParsingLogs() {
    await chrome.storage.local.set({ parsingLogs: [] });
    console.log('📋 Parsing logs cleared');
}

async function getParsingLogs() {
    const result = await chrome.storage.local.get(['parsingLogs']);
    return result.parsingLogs || [];
}

async function ensureLogsSheetExists(spreadsheetId, authToken) {
    // Check if sheet exists
    const metaResponse = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
    });
    
    if (!metaResponse.ok) {
        console.error('❌ Failed to get spreadsheet metadata:', await metaResponse.text());
        return false;
    }
    
    const meta = await metaResponse.json();
    const sheetNames = meta.sheets?.map(s => s.properties.title) || [];
    console.log(`📋 Existing sheets: ${sheetNames.join(', ')}`);
    
    if (!sheetNames.includes(LOGS_SHEET_NAME)) {
        console.log(`📋 Creating "${LOGS_SHEET_NAME}" sheet...`);
        const createResponse = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                requests: [{
                    addSheet: {
                        properties: { title: LOGS_SHEET_NAME }
                    }
                }]
            })
        });
        
        if (!createResponse.ok) {
            console.error('❌ Failed to create sheet:', await createResponse.text());
            return false;
        }
        console.log(`✅ Sheet "${LOGS_SHEET_NAME}" created`);
    }
    return true;
}

let logsUploadInProgress = false;

async function uploadLogsToSheet() {
    // Prevent double upload
    if (logsUploadInProgress) {
        console.log('📋 Logs upload already in progress, skipping');
        throw new Error('logs upload already in progress');
    }
    logsUploadInProgress = true;
    let parsingLogs;
    try {
        parsingLogs = await getParsingLogs();
    } catch (error) {
        logsUploadInProgress = false;
        throw error;
    }
    console.log(`📋 uploadLogsToSheet called. Logs count: ${parsingLogs.length}`);
    
    if (parsingLogs.length === 0) {
        console.log('📋 No logs to upload - array is empty!');
        logsUploadInProgress = false;
        return;
    }
    
    // Debug: show first 3 logs
    console.log('📋 First 3 logs:', parsingLogs.slice(0, 3));
    
    try {
        const result = await chrome.storage.local.get(['spreadsheetId']);
        const spreadsheetId = result.spreadsheetId || DEFAULT_SPREADSHEET_ID;
        console.log(`📋 Uploading to spreadsheet: ${spreadsheetId}, sheet: ${LOGS_SHEET_NAME}`);
        const authToken = await getAuthToken(true);
        
        // Ensure Logs sheet exists
        const sheetReady = await ensureLogsSheetExists(spreadsheetId, authToken);
        if (!sheetReady) {
            throw new Error('Failed to ensure Logs sheet exists');
        }
        
        // Clear existing data in Logs sheet
        console.log('📋 Clearing old data...');
        const clearRange = encodeURIComponent(`${LOGS_SHEET_NAME}!A:F`);
        const clearResponse = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${clearRange}:clear`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (!clearResponse.ok) {
            console.error('⚠️ Clear failed (non-critical):', await clearResponse.text());
        }
        
        // Prepare data with header
        console.log(`📋 Preparing ${parsingLogs.length} rows...`);
        const header = ['Время', 'Магазин', 'Order ID', 'Track', 'Статус', 'Детали'];
        const rows = parsingLogs.map(log => [
            log.timestamp,
            log.store,
            log.orderId,
            log.trackNumber,
            log.status,
            log.details
        ]);
        const values = [header, ...rows];
        
        // Write new data
        console.log(`📋 Writing ${values.length} rows to ${LOGS_SHEET_NAME}!A1...`);
        const range = encodeURIComponent(`${LOGS_SHEET_NAME}!A1`);
        const writeResponse = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`, {
            method: 'PUT',
            headers: { 
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ values })
        });
        
        if (!writeResponse.ok) {
            const errorText = await writeResponse.text();
            console.error(`❌ Write failed: ${writeResponse.status}`, errorText);
            throw new Error(`API error: ${writeResponse.status} - ${errorText}`);
        }
        
        const writeResult = await writeResponse.json();
        console.log(`✅ Write success:`, writeResult);
        console.log(`📋 Uploaded ${parsingLogs.length} log entries to ${LOGS_SHEET_NAME} sheet`);
        console.log(`📋 Logs (${parsingLogs.length}) uploaded to "${LOGS_SHEET_NAME}"`);
        
        logsUploadInProgress = false;
    } catch (error) {
        console.error('Failed to upload logs:', error);
        sendTelegramMessage(`⚠️ Не удалось сохранить логи: ${error.message}`);
        logsUploadInProgress = false;
        throw error;
    }
}

// --- Telegram Bot State ---
// The token is provisioned through chrome.storage.local by the popup/runtime.
// Never keep a fallback bot credential in tracked source.
let tgBotToken = '';
// Log channel — text messages (progress, errors, /status). Defaults to "Скрины" group
// (-1003888176404, ex-"Amazon"). Auto-set from first chat if still null. Override via popup.
let tgChatId = '-1003888176404';
// Dedicated channel for order screenshots (archive). Used by sendScreenshotToArchive().
// Defaults to "Скрины" (-1003888176404). Override via chrome.storage.local.tgPhotoChatId.
let tgPhotoChatId = '-1003888176404';
let lastUpdateId = 0;
let tgPollingInterval = null;

// Initialize cache on startup
let cachedProgressState = {};
chrome.storage.local.get(['progressState', 'tgBotToken', 'tgChatId', 'tgPhotoChatId', 'lastUpdateId', 'parsingState'], async (result) => {
    if (result.tgPhotoChatId) tgPhotoChatId = result.tgPhotoChatId;
    cachedProgressState = result.progressState || {};

    // RESTORE PARSING STATE (critical for Service Worker that goes inactive!)
    if (result.parsingState) {
        isParsingAllStores = result.parsingState.isParsingAllStores || false;
        storesCompleted = result.parsingState.storesCompleted || { ebay: false, iherb: false, amazon: false };
        console.log('🔄 Restored parsing state:', { isParsingAllStores, storesCompleted });
    }

    // The runtime storage is the only source of the Telegram token.
    if (result.tgBotToken && result.tgBotToken.length > 10) {
        tgBotToken = result.tgBotToken;
    } else {
        console.warn('⚠️ Telegram token is not configured; polling stays disabled');
    }

    // Prefer saved chat id if it's a group/supergroup (starts with '-'); DM chat_ids are
    // positive — those were set by auto-first-chat logic and we don't want logs in DM.
    if (result.tgChatId && String(result.tgChatId).startsWith('-')) {
        tgChatId = result.tgChatId;
    } else if (result.tgChatId) {
        console.log(`⚠️ Ignoring saved tgChatId=${result.tgChatId} (looks like DM) — using default group ${tgChatId}`);
        chrome.storage.local.set({ tgChatId });
    }
    lastUpdateId = result.lastUpdateId || 0;

    console.log('🚀 Background Script Init');
    console.log('📱 Telegram Config:', {
        hasToken: !!tgBotToken,
        tokenPrefix: tgBotToken ? tgBotToken.substring(0, 10) + '...' : 'N/A',
        chatId: tgChatId,
        lastUpdateId
    });

    // Start Telegram polling if configured
    if (tgBotToken) startTelegramPolling();
    else console.warn('⚠️ No Telegram Token - polling disabled');

    try {
        // Normalize a half-written `starting` run without destroying an old
        // stage. The durable stage intent remains authoritative after an MV3 or
        // machine restart even when Chrome lost the owned tab while asleep.
        // Give the idempotent resume path one chance to recreate that exact
        // stage, then run the destructive stale-state audit.
        await reconcileStalePipelineState({ allowDestructiveCleanup: false });
        await resumePreparedPipelineStageAfterRestart();
        await reconcileStalePipelineState({ allowDestructiveCleanup: true });
        await retryPendingIherbHumanChallengeAlert();
    } catch (error) {
        console.warn('⚠️ Failed to reconcile parser pipeline state:', error?.message || error);
    } finally {
        // Catch-up must observe the reconciled state. Previously it raced this
        // callback, saw yesterday's active run, skipped, and was never retried.
        resolveStartupPipelineReconciled?.();
        resolveStartupPipelineReconciled = null;
    }
});

async function clearPipelineRuntimeState(reason) {
    console.warn(`🧹 Clearing stale parser pipeline state: ${reason}`);

    const interruptedAt = Date.now();
    await updatePipelineRun(run => {
        if (!['starting', 'running'].includes(run.status)) return run;
        const failure = {
            shop: 'pipeline',
            account: '',
            reason: String(reason || 'stale pipeline state').slice(0, 160),
            at: interruptedAt
        };
        run.status = 'degraded';
        run.finishedAt = interruptedAt;
        run.failures = [...(run.failures || []), failure];
        run.missing = getPipelineRunOutcome(run).missing;
        return run;
    });

    isParsingAllStores = false;
    storesCompleted = { ebay: false, iherb: false, amazon: false };
    isMultiAccountParsing = false;
    amazonAccountsQueue = [];
    currentAmazonAccount = null;
    isMultiAccountIherb = false;
    iherbAccountsQueue = [];
    currentIherbAccount = null;
    cachedProgressState = {};

    await chrome.storage.local.remove([
        'progressState',
        'pipelineStage',
        'parsingState',
        'multiAccountState',
        'multiAccountIherbState',
        'autoParsePending',
        'autoParse_ebay',
        'autoParse_iherb',
        'autoParse_amazon',
        'autoParseTimestamp',
        'ebay_should_autoparse',
        'iherb_should_autoparse',
        'amazonPaginationState',
        'amazonNavigationGraceUntil',
        'amazonNavigationRecovery',
        'amazonParsingIncomplete',
        'amazonTimeoutAttempt',
        'amazonParserTabId',
        'amazonFinalReturn',
        'amazonParsingComplete', 'amazonPaginationState',
        'accountSwitchStartedAt',
        'accountSwitchFailures',
        'lastAmazonProgressAt',
        'skipGuardAt',
        'pendingAccountSwitch',
        'pendingIherbSwitch',
        'iherbSwitchInProgress',
        'iherbSwitchStartedAt',
        'iherbSwitchFailures',
        'iherbFinalReturn',
        'iherbOrdersReloadDone',
        'iherbParserTabId',
        'iherbParseStartedAt',
        'iherbParseAttemptId',
        'iherbTimeoutAttempt',
        'iherbParsingComplete',
        'iherbWatchdogRetried',
        'iherbParsedAccounts',
        'iherbRetryPassDone',
        'iherbSkipReasons',
        'screenshotStageBudget'
    ]);

    await chrome.storage.local.set({
        progressState: cachedProgressState,
        parsingState: {
            isParsingAllStores,
            storesCompleted
        },
        // Do not leave an interrupted run looking active forever. External
        // guards and the operator can now distinguish a stale cleanup from a
        // successful terminal run.
        lastDailyAutoParseStatus: 'interrupted',
        lastDailyAutoParseFinishedAt: interruptedAt,
        lastDailyAutoParseError: String(reason || 'stale pipeline state').slice(0, 300)
    });
}

function isCanonicalResumablePipeline(run, pipeline) {
    const exactStages = Array.isArray(pipeline?.stages)
        && pipeline.stages.length === PIPELINE_STAGES.length
        && pipeline.stages.every((stage, index) => stage === PIPELINE_STAGES[index]);
    const exactRoster = ['iherb', 'ebay', 'amazon'].every(shop =>
        Array.isArray(run?.expected?.[shop])
        && run.expected[shop].length === EXPECTED_PIPELINE_ROSTER[shop].length
        && run.expected[shop].every((email, index) =>
            normalizeAccountEmail(email) === EXPECTED_PIPELINE_ROSTER[shop][index]
        )
    );
    return !!run?.id
        && pipeline?.active === true
        && pipeline.runId === run.id
        && ['starting', 'running'].includes(run.status)
        && exactStages
        && exactRoster
        && Number.isInteger(pipeline.currentIndex)
        && pipeline.currentIndex >= 0
        && pipeline.currentIndex < PIPELINE_STAGES.length - 1;
}

async function reconcileStalePipelineState({ allowDestructiveCleanup = true } = {}) {
    const state = await chrome.storage.local.get([
        'pipelineRun',
        'pipelineStage',
        'progressState',
        'iherbParserTabId',
        'iherbParseStartedAt',
        'multiAccountIherbState',
        'pendingIherbSwitch',
        'iherbSwitchInProgress',
        'iherbSwitchStartedAt',
        'iherbSwitchDispatch',
        'iherbStageFinalizing',
        'iherbFinalReturnConfirmed',
        'amazonParserTabId',
        'multiAccountState',
        'pendingAccountSwitch',
        'amazonSwitchDispatch',
        'amazonStageFinalizing',
        'amazonFinalReturnConfirmed',
        'amazonParsingComplete',
        'ebayParserTabId',
        'ebayStageDispatch',
        'lastAmazonProgressAt',
        'accountSwitchStartedAt',
        'trackScreenshotQueue',
        'screenshotStageBudget'
    ]);
    const run = state.pipelineRun;
    const pipeline = state.pipelineStage;
    if (run?.status === 'starting' && !pipeline?.active) {
        const attemptAgeMs = Date.now() - (Number(run.attemptedAt) || 0);
        if (attemptAgeMs >= 60_000) {
            await updatePipelineRun(current => current.id === run.id && current.status === 'starting' ? ({
                ...current,
                status: 'failed_to_start',
                finishedAt: Date.now(),
                failures: [...(current.failures || []), {
                    shop: 'pipeline', account: '', reason: 'startup interrupted before durable stage launch', at: Date.now()
                }]
            }) : current);
        }
        return;
    }
    if (run?.status === 'starting' && pipeline?.active && pipeline.runId === run.id) {
        const startedAt = Number(pipeline.startedAt) || Date.now();
        await chrome.storage.local.set({
            pipelineRun: { ...run, status: 'running', startedAt },
            lastDailyAutoParseTriggeredAt: startedAt,
            lastDailyAutoParseStartedAt: startedAt,
            lastDailyAutoParseStatus: 'running'
        });
    }
    if (!pipeline?.active) return;

    const currentStage = pipeline.stages?.[pipeline.currentIndex];
    if (!currentStage || currentStage === 'done') return;
    if (!allowDestructiveCleanup) return;

    // A structurally valid run is never "repaired" by deleting its ownership
    // state. The idempotent resume path gets first refusal and the generation-
    // fenced stage watchdog owns terminal timeout handling. Destructive cleanup
    // is reserved for legacy/corrupt state that cannot belong to the six-cabinet
    // contract at all.
    if (isCanonicalResumablePipeline(run, pipeline)) return;

    const stageTimestamp = Math.max(
        pipeline.startedAt || 0,
        pipeline.stageStartedAt || 0,
        state.progressState?.[currentStage]?.timestamp || 0,
        currentStage === 'iherb' ? (state.iherbParseStartedAt || 0) : 0,
        currentStage === 'amazon'
            ? Math.max(state.lastAmazonProgressAt || 0, state.accountSwitchStartedAt || 0)
            : 0
    );
    const stageAgeMs = stageTimestamp ? (Date.now() - stageTimestamp) : Number.POSITIVE_INFINITY;
    if (stageAgeMs < PIPELINE_STALE_TIMEOUT_MS) return;

    const generation = pipelineGenerationFromStage(pipeline);
    const queueHasItems = Array.isArray(state.trackScreenshotQueue)
        && state.trackScreenshotQueue.length > 0;
    const screenshotBudgetMatches = queueHasItems
        && state.screenshotStageBudget?.stageName === currentStage
        && state.screenshotStageBudget?.stageStartedAt === pipeline.stageStartedAt;
    const exactTabIsLive = async (tabId, urlPattern) => {
        if (!tabId) return false;
        try {
            const tab = await chrome.tabs.get(tabId);
            return !!tab?.id && urlPattern.test(tab.url || '');
        } catch (_) {
            return false;
        }
    };

    let shouldClear = false;
    if (currentStage === 'iherb') {
        const account = normalizeAccountEmail(state.multiAccountIherbState?.currentIherbAccount);
        const pendingOwned = !!account
            && state.pendingIherbSwitch?.runId === generation?.runId
            && normalizeAccountEmail(state.pendingIherbSwitch?.email) === account;
        const dispatchOwned = !!account
            && pipelineGenerationMatches(state.iherbSwitchDispatch, generation)
            && normalizeAccountEmail(state.iherbSwitchDispatch?.account) === account;
        const finalizingOwned = pipelineGenerationMatches(state.iherbStageFinalizing, generation)
            && state.iherbStageFinalizing?.shop === 'iherb';
        const switchOwned = pendingOwned
            && state.iherbSwitchInProgress === true
            && Number.isFinite(Number(state.iherbSwitchStartedAt));
        const tabIsLive = await exactTabIsLive(
            state.iherbParserTabId,
            /^https?:\/\/(?:www|secure|checkout)\.iherb\.com\//i
        );
        const parsingOwned = tabIsLive && Number.isFinite(Number(state.iherbParseStartedAt));
        // Finalizers, prepared switches and a persisted screenshot drain are
        // restart-resumable even when the exact tab has not been recreated yet.
        // Never destroy them before resumePreparedPipelineStageAfterRestart runs.
        shouldClear = !(finalizingOwned || pendingOwned || dispatchOwned || switchOwned
            || parsingOwned || screenshotBudgetMatches);
    } else if (currentStage === 'ebay') {
        const ebayTabId = state.ebayParserTabId;
        const terminalOwned = run?.id === generation?.runId
            && pipelineRunAccountIsTerminal(run, 'ebay', run?.expected?.ebay?.[0]);
        const dispatchOwned = pipelineGenerationMatches(state.ebayStageDispatch, generation);
        const tabIsLive = await exactTabIsLive(
            ebayTabId,
            /^https?:\/\/www\.ebay\.com\/mye\/myebay\/purchase/i
        );
        shouldClear = !(terminalOwned || dispatchOwned || screenshotBudgetMatches || tabIsLive);
    } else if (currentStage === 'amazon') {
        const account = normalizeAccountEmail(state.multiAccountState?.currentAmazonAccount);
        const pendingOwned = !!account
            && state.pendingAccountSwitch?.runId === generation?.runId
            && normalizeAccountEmail(state.pendingAccountSwitch?.email) === account;
        const dispatchOwned = !!account
            && pipelineGenerationMatches(state.amazonSwitchDispatch, generation)
            && normalizeAccountEmail(state.amazonSwitchDispatch?.account) === account;
        const finalizingOwned = pipelineGenerationMatches(state.amazonStageFinalizing, generation)
            && state.amazonStageFinalizing?.shop === 'amazon';
        const completionOwned = !!state.amazonParsingComplete
            && state.amazonParsingComplete.runId === generation?.runId
            && normalizeAccountEmail(state.amazonParsingComplete.account) === account
            && state.amazonParsingComplete.parserTabId === state.amazonParserTabId;
        const tabIsLive = await exactTabIsLive(
            state.amazonParserTabId,
            /^https?:\/\/(?:www\.)?amazon\.com\//i
        );
        const parsingOwned = tabIsLive
            && !!(state.lastAmazonProgressAt || state.accountSwitchStartedAt);
        shouldClear = !(finalizingOwned || pendingOwned || dispatchOwned || completionOwned
            || parsingOwned || screenshotBudgetMatches);
    }

    if (!shouldClear) return;

    const ageMinutes = Math.round(stageAgeMs / 60000);

    // Ночной прогон завис после рестарта Chrome/SW — не умираем молча:
    // предупреждаем оператора и best-effort выгружаем то, что уже собрано.
    try {
        await sendTelegramMessage(`⚠️ Ночной прогон прерван (стадия ${currentStage} зависла после рестарта Chrome/SW). Выгружаю то, что собрано.`);
    } catch (_) {}
    try {
        await uploadToSheets();
        await uploadLogsToSheet();
        console.log('✅ Частичная выгрузка после протухшей стадии выполнена (без green stamp)');
    } catch (e) {
        console.error('❌ Частичная выгрузка после протухшей стадии не удалась:', e?.message || e);
    }

    await clearPipelineRuntimeState(`${currentStage} stage stale for ${ageMinutes} min without live runtime`);
}

async function resumePreparedPipelineStageAfterRestart() {
    const state = await chrome.storage.local.get([
        'pipelineRun', 'pipelineStage',
        'multiAccountIherbState', 'pendingIherbSwitch', 'iherbSwitchInProgress',
        'iherbParserTabId', 'iherbParseAttemptId', 'iherbTimeoutAttempt',
        'iherbParsingComplete',
        'ebayParserTabId', 'autoParsePending', 'ebayStageDispatch',
        'multiAccountState', 'pendingAccountSwitch', 'amazonSwitchDispatch',
        'amazonParserTabId', 'accountSwitchStartedAt', 'amazonTimeoutAttempt',
        'amazonParsingComplete', 'amazonPaginationState',
        'amazonStageFinalizing', 'amazonFinalReturn', 'amazonFinalReturnConfirmed',
        'iherbSwitchDispatch', 'iherbStageFinalizing', 'iherbFinalReturnConfirmed',
        'pendingSheetsUpload', 'lastSheetsUploadRunId', 'lastSheetsUploadOkAt'
    ]);
    const run = state.pipelineRun;
    const stageState = state.pipelineStage;
    if (run?.id !== stageState?.runId) return false;
    const stage = stageState.stages?.[stageState.currentIndex];
    const generation = pipelineGenerationFromStage(stageState);

    if (stage === 'done' && ['starting', 'running', 'completed', 'degraded'].includes(run?.status)) {
        const uploaded = state.lastSheetsUploadRunId === run.id
            && Number.isFinite(state.lastSheetsUploadOkAt)
            && Number.isFinite(run.finishedAt)
            && state.lastSheetsUploadOkAt >= run.finishedAt;
        const pendingOwned = state.pendingSheetsUpload?.runId === run.id;
        if (!stageState.active && (uploaded || pendingOwned)) return false;
        // Covers all terminal crash windows: before finalizePipelineRun, after
        // finalize but before inactive commit, and after inactive commit but
        // before pendingSheetsUpload/checkAllStoresCompleted.
        return runPipelineStage('done', run.id);
    }
    if (!stageState.active || run?.status !== 'running') return false;

    // The stage identity/timer is committed before any browser mutation. If the
    // worker died in that narrow gap, resume only when the shop-specific durable
    // launch proof is absent (or the account queue is still untouched).
    if (stage === 'iherb') {
        if (state.iherbStageFinalizing?.runId === run.id
            && pipelineGenerationMatches(state.iherbStageFinalizing, generation)) {
            return resumeIherbStageFinalization(state.iherbStageFinalizing, generation);
        }
        const multi = state.multiAccountIherbState;
        if (!multi) return runPipelineStage('iherb', run.id);
        if (iherbAttemptIdentityMatches(
            state.iherbParsingComplete,
            iherbAttemptRefFromState(state)
        )) {
            return consumeIherbCompletionMarker(generation);
        }
        const iherbPendingOwned = state.pendingIherbSwitch?.runId === run.id
            && normalizeAccountEmail(state.pendingIherbSwitch?.email)
                === normalizeAccountEmail(multi.currentIherbAccount);
        if (multi.currentIherbAccount
            && pipelineRunAccountIsTerminal(run, 'iherb', multi.currentIherbAccount)
            && (!state.pendingIherbSwitch || iherbPendingOwned)) {
            // A worker may die after the account outcome is committed but before
            // its old login intent/timer is consumed. The durable terminal result
            // wins; otherwise a stale pending flag can hold the run until stage cap.
            if (iherbPendingOwned) {
                await chrome.storage.local.remove([
                    'pendingIherbSwitch', 'iherbSwitchInProgress', 'iherbSwitchStartedAt',
                    'iherbSwitchDispatch', 'iherbParseStartedAt', 'iherbWatchdogRetried'
                ]);
            }
            return switchToNextIherbAccount(generation);
        }
        if (multi.isMultiAccountIherb
            && !multi.currentIherbAccount
            && Array.isArray(multi.iherbAccountsQueue)
            && multi.iherbAccountsQueue.length > 0
            && !state.pendingIherbSwitch
            && !state.iherbSwitchInProgress) {
            return switchToNextIherbAccount(generation);
        }
        if (multi.isMultiAccountIherb
            && multi.currentIherbAccount
            && state.pendingIherbSwitch?.runId === run.id
            && normalizeAccountEmail(state.pendingIherbSwitch.email)
                === normalizeAccountEmail(multi.currentIherbAccount)
            && (state.iherbSwitchDispatch?.phase !== 'dispatched'
                || !pipelineGenerationMatches(state.iherbSwitchDispatch, generation)
                || normalizeAccountEmail(state.iherbSwitchDispatch?.account)
                    !== normalizeAccountEmail(multi.currentIherbAccount))) {
            return dispatchCurrentIherbAccountSwitch(multi.currentIherbAccount, generation);
        }
    } else if (stage === 'ebay') {
        const ebayAccount = run.expected?.ebay?.[0];
        if (pipelineRunAccountIsTerminal(run, 'ebay', ebayAccount)) {
            return advancePipelineStage(generation);
        }
        const markerMatches = state.ebayStageDispatch?.phase === 'dispatched'
            && pipelineGenerationMatches(state.ebayStageDispatch, generation)
            && state.ebayStageDispatch?.tabId === state.ebayParserTabId;
        const tab = markerMatches ? await getEbayParserTab(state.ebayParserTabId) : null;
        if (!markerMatches || !tab || !/\/mye\/myebay\/purchase/i.test(tab.url || '')) {
            return startEbayStageForPipeline(generation);
        }
    } else if (stage === 'amazon') {
        if (state.amazonStageFinalizing?.runId === run.id
            && pipelineGenerationMatches(state.amazonStageFinalizing, generation)) {
            return resumeAmazonStageFinalization(state.amazonStageFinalizing, generation);
        }
        const multi = state.multiAccountState;
        if (!multi) return runPipelineStage('amazon', run.id);
        const amazonPendingOwned = state.pendingAccountSwitch?.runId === run.id
            && normalizeAccountEmail(state.pendingAccountSwitch?.email)
                === normalizeAccountEmail(multi.currentAmazonAccount);
        const amazonCompletionOwned = state.amazonParsingComplete?.runId === run.id
            && normalizeAccountEmail(state.amazonParsingComplete?.account)
                === normalizeAccountEmail(multi.currentAmazonAccount)
            && state.amazonParsingComplete?.parserTabId === state.amazonParserTabId
            && (!state.amazonPaginationState?.parseId
                || state.amazonParsingComplete?.parseId === state.amazonPaginationState.parseId);
        // A completion committed before an MV3 restart outranks an earlier
        // timeout failure. Consume it first so success removes that failure;
        // never delete a valid permit merely because the account is terminal.
        if (amazonCompletionOwned) {
            return consumeAmazonCompletionMarker(generation);
        }
        if (multi.currentAmazonAccount
            && pipelineRunAccountIsTerminal(run, 'amazon', multi.currentAmazonAccount)
            && (!state.pendingAccountSwitch || amazonPendingOwned)) {
            if (amazonPendingOwned) {
                await chrome.storage.local.remove([
                    'pendingAccountSwitch', 'amazonSwitchDispatch',
                    'accountSwitchStartedAt', 'lastAmazonProgressAt'
                ]);
            }
            return switchToNextAmazonAccount(generation);
        }
        if (multi.isMultiAccountParsing
            && !multi.currentAmazonAccount
            && Array.isArray(multi.amazonAccountsQueue)
            && multi.amazonAccountsQueue.length > 0
            && !state.pendingAccountSwitch) {
            return switchToNextAmazonAccount(generation);
        }
        if (multi.isMultiAccountParsing
            && multi.currentAmazonAccount
            && state.pendingAccountSwitch?.runId === run.id
            && normalizeAccountEmail(state.pendingAccountSwitch.email)
                === normalizeAccountEmail(multi.currentAmazonAccount)
            && (state.amazonSwitchDispatch?.phase !== 'dispatched'
                || state.amazonSwitchDispatch?.kind !== 'account-switch'
                || !pipelineGenerationMatches(state.amazonSwitchDispatch, generation)
                || normalizeAccountEmail(state.amazonSwitchDispatch?.account)
                    !== normalizeAccountEmail(multi.currentAmazonAccount))) {
            return dispatchCurrentAmazonAccountSwitch(multi.currentAmazonAccount, generation, 'account-switch');
        }
    }
    return false;
}

// --- Progress Tracking State ---
let totalTasks = 0;
let tasksStarted = 0;
let successCount = 0;
let failureCount = 0;

// --- Progress Handler Function ---
// Persistent diagnostic log for Amazon multi-account flow.
// Lets us see WHEN and WHERE a silent failure happened — picker didn't load,
// email link wasn't found, parser never started, etc.
// Read via: chrome.storage.local.get('amazonMultiAccountLog', console.log)
async function logMultiAccountStep(step, detail = {}) {
    try {
        const { amazonMultiAccountLog = [] } = await new Promise(r => chrome.storage.local.get('amazonMultiAccountLog', r));
        amazonMultiAccountLog.push({ t: Date.now(), iso: new Date().toISOString(), step, ...detail });
        while (amazonMultiAccountLog.length > 200) amazonMultiAccountLog.shift();
        await chrome.storage.local.set({ amazonMultiAccountLog });
        console.log(`📒 [multiAccountLog] ${step}`, detail);
    } catch (e) { console.warn('logMultiAccountStep failed:', e?.message || e); }
}

async function handleProgressMessage(request, sender = null) {
    // Legacy parsingProgress wrapper ({page, totalOrders}, no store) reaches here
    // via the converter below — without a store there is nothing to track.
    if (!request.store) return;
    // Persist progress to storage so popup can restore it when reopened
    const storeKey = request.store.toLowerCase();
    console.log(`📊 [BACKGROUND] Progress from ${request.store}:`, request.current, '/', request.total, request.status);

    // Restore multi-account state from storage FIRST (Service Worker may have restarted)
    const stored = await new Promise(resolve => chrome.storage.local.get([
        'multiAccountState', 'multiAccountIherbState', 'pipelineRun',
        'amazonParserTabId', 'iherbParserTabId', 'ebayParserTabId', 'pipelineStage',
        'iherbStageFinalizing', 'iherbParseAttemptId', 'iherbTimeoutAttempt'
    ], resolve));
    if (stored.multiAccountState) {
        isMultiAccountParsing = stored.multiAccountState.isMultiAccountParsing;
        amazonAccountsQueue = stored.multiAccountState.amazonAccountsQueue || [];
        currentAmazonAccount = stored.multiAccountState.currentAmazonAccount;
    }
    if (stored.multiAccountIherbState) {
        isMultiAccountIherb = stored.multiAccountIherbState.isMultiAccountIherb;
        iherbAccountsQueue = stored.multiAccountIherbState.iherbAccountsQueue || [];
        currentIherbAccount = stored.multiAccountIherbState.currentIherbAccount;
    }

    // Any Amazon progress can extend the idle watchdog, so even non-completion
    // pings must come from the tab explicitly created/owned by this run.
    if (storeKey === 'amazon' && ['starting', 'running'].includes(stored.pipelineRun?.status)) {
        if (!sender?.tab?.id || sender.tab.id !== stored.amazonParserTabId) {
            console.warn('⏭ Ignoring Amazon progress from a non-parser tab');
            return;
        }
        chrome.storage.local.set({ lastAmazonProgressAt: Date.now() });
    }

    // Update completion status
    const isCompleted = request.status === 'Done ✅' || request.status === 'Error';
    const activeRun = ['starting', 'running'].includes(stored.pipelineRun?.status);
    if (isCompleted && activeRun) {
        const expectedAccount = storeKey === 'iherb'
            ? stored.multiAccountIherbState?.currentIherbAccount
            : storeKey === 'amazon'
                ? stored.multiAccountState?.currentAmazonAccount
                : stored.pipelineRun?.expected?.ebay?.[0];
        const wrongRun = !request.runId || request.runId !== stored.pipelineRun.id;
        const wrongAccount = !request.account
            || normalizeAccountEmail(request.account) !== normalizeAccountEmail(expectedAccount);
        const wrongStage = stored.pipelineStage?.runId !== stored.pipelineRun.id
            || stored.pipelineStage?.stages?.[stored.pipelineStage?.currentIndex] !== storeKey
            || (storeKey === 'iherb' && stored.iherbStageFinalizing?.runId === stored.pipelineRun.id);
        const wrongAttempt = storeKey === 'iherb'
            && (!request.attemptId
                || request.attemptId !== stored.iherbParseAttemptId
                || iherbTimeoutAttemptMatchesRuntime(stored.iherbTimeoutAttempt, stored));
        const wrongTab = storeKey === 'amazon'
            ? (!sender?.tab?.id || sender.tab.id !== stored.amazonParserTabId)
            : storeKey === 'iherb'
                ? (!sender?.tab?.id || sender.tab.id !== stored.iherbParserTabId)
                : storeKey === 'ebay'
                    ? (!sender?.tab?.id || sender.tab.id !== stored.ebayParserTabId)
                    : false;
        if (wrongRun || wrongAccount || wrongStage || wrongTab || wrongAttempt) {
            console.warn(`⏭ Ignoring stale completion for ${storeKey}: run/account/stage/tab/attempt fence failed`);
            return;
        }
    }
    const shouldHandleCompletion = isCompleted && (isParsingAllStores || (storeKey === 'amazon' && isMultiAccountParsing) || (storeKey === 'iherb' && isMultiAccountIherb));
    const shouldNotifyTelegram = isCompleted && !shouldHandleCompletion;
    const completionGeneration = pipelineGenerationFromStage(stored.pipelineStage);
    
    console.log(`🔍 [DEBUG] isCompleted: ${isCompleted}, isParsingAllStores: ${isParsingAllStores}, isMultiAccountParsing: ${isMultiAccountParsing}, shouldHandle: ${shouldHandleCompletion}`);
    
    if (shouldHandleCompletion) {
        // Update cache with found count BEFORE checking completion
        cachedProgressState[storeKey] = {
            current: request.current,
            total: request.total,
            status: request.status,
            percent: 100,
            found: request.found !== undefined ? request.found : (cachedProgressState[storeKey]?.found || 0),
            timestamp: Date.now()
        };
        console.log(`💾 [BACKGROUND] Saving COMPLETE state for ${storeKey}:`, cachedProgressState[storeKey]);
        chrome.storage.local.set({ progressState: cachedProgressState });

        if (storeKey in storesCompleted) {
            // Send completion message to Telegram
            const count = request.found || 0;
            const emoji = request.status === 'Error' ? '❌' : '✅';
            
            console.log(`🔍 [DEBUG] Store completed: ${storeKey}, isMultiAccountParsing: ${isMultiAccountParsing}, amazonAccountsQueue: ${JSON.stringify(amazonAccountsQueue)}, currentAccount: ${currentAmazonAccount}`);
            
            // Multi-account Amazon: DON'T switch here — let the watchdog alarm handle it.
            // Watchdog is async and can properly await processScreenshotQueue() between accounts.
            if (storeKey === 'amazon' && isMultiAccountParsing) {
                console.log('[handleProgress] Amazon multi-account: deferring to watchdog for screenshots + switch');
                return;
            }

            if (storeKey === 'iherb'
                && isMultiAccountIherb
                && request.status === 'Done ✅') {
                const consumed = await consumeIherbCompletionMarker(completionGeneration);
                if (!consumed) {
                    console.warn('⏭ iHerb Done had no exact durable completion permit');
                }
                return;
            }

            // Multi-account iHerb: process screenshots, then switch to next account.
            if (storeKey === 'iherb' && isMultiAccountIherb && iherbAccountsQueue.length > 0) {
                console.log('[handleProgress] iHerb multi-account: processing screenshots, then switching');
                parseReport.stores[`iherb_${(currentIherbAccount || '').split('@')[0]}`] = { found: count, status: emoji };
                if (request.status === 'Done ✅') {
                    await recordIherbParsedAccount(currentIherbAccount, request.runId, request.attemptId);
                } else {
                    await recordIherbSkipReason(currentIherbAccount, 'parse_error', request.runId);
                }
                const iherbDoneGate = (await chrome.storage.local.get(['pipelineStage'])).pipelineStage;
                if (!iherbDoneGate?.active
                    || !pipelineGenerationMatches(iherbDoneGate, completionGeneration)) return;
                // Watchdog: cs дошёл до конца — снимаем marker
                await chrome.storage.local.remove(['iherbParseStartedAt', 'iherbWatchdogRetried']);
                // Не используем processScreenshotQueue().finally(...): при уже
                // активном processor re-entry guard возвращает Promise сразу и
                // переключает кабинет с недоснятой очередью. iHerb-карточки
                // доступны только в своём аккаунте, поэтому ждём реальный drain
                // без таймаута и только затем меняем login.
                if (!await waitForScreenshotsDrained()) {
                    return stopPipelineForScreenshotDrain(
                        'iHerb account screenshots blocked',
                        pipelineGenerationFromStage(stored.pipelineStage)
                    );
                }
                await switchToNextIherbAccount(completionGeneration);
                return;
            }
            // Multi-account iHerb: очередь пуста — последний аккаунт этого прохода
            // обработан. НЕ закрываем стадию напрямую: единый chokepoint
            // finalizeIherbStage сам решит — сделать ограниченный retry по
            // недопарсенным аккаунтам ИЛИ реально закрыть стадию (возврат на
            // primary + roster + advance pipeline). Так стадия «complete» только
            // когда учтены ВСЕ аккаунты, а не просто по пустой очереди.
            if (storeKey === 'iherb' && isMultiAccountIherb) {
                console.log('[handleProgress] iHerb multi-account: queue drained, finalize');
                parseReport.stores[`iherb_${(currentIherbAccount || '').split('@')[0]}`] = { found: count, status: emoji };
                if (request.status === 'Done ✅') {
                    await recordIherbParsedAccount(currentIherbAccount, request.runId, request.attemptId);
                } else {
                    await recordIherbSkipReason(currentIherbAccount, 'parse_error', request.runId);
                }
                const iherbDoneGate = (await chrome.storage.local.get(['pipelineStage'])).pipelineStage;
                if (!iherbDoneGate?.active
                    || !pipelineGenerationMatches(iherbDoneGate, completionGeneration)) return;
                await chrome.storage.local.remove(['iherbParseStartedAt', 'iherbWatchdogRetried']);
                if (!await waitForScreenshotsDrained()) {
                    return stopPipelineForScreenshotDrain(
                        'iHerb final screenshots blocked',
                        pipelineGenerationFromStage(stored.pipelineStage)
                    );
                }
                await finalizeIherbStage(undefined, { expectedGeneration: completionGeneration });
                return;
            }

            storesCompleted[storeKey] = true;
            setParserLock(storeKey, false);

            if (storeKey === 'ebay') {
                const cfg = await loadAccountsConfig();
                await markPipelineAccountResult('ebay', cfg.ebay?.[0]?.email, {
                    runId: request.runId,
                    ok: request.status === 'Done ✅',
                    reason: request.status === 'Done ✅' ? '' : 'parse-error',
                    found: count
                });
            }

            if (storeKey === 'amazon' && currentAmazonAccount) {
                parseReport.stores[`amazon_${currentAmazonAccount.split('@')[0]}`] = { found: count, status: emoji };
                isMultiAccountParsing = false;
                currentAmazonAccount = null;
            } else {
                parseReport.stores[storeKey] = { found: count, status: emoji };
            }

            // Pipeline advance: if sequential pipeline is active and we just finished eBay,
            // jump ebay → amazon_primary. iHerb and Amazon advance from their own final-return
            // functions (with a 45s delay for picker/re-login to settle).
            if (storeKey === 'ebay') {
                chrome.storage.local.get(['pipelineStage']).then(r => {
                    const p = r.pipelineStage;
                    if (p && p.active && p.stages[p.currentIndex] === 'ebay') {
                        advancePipelineStage(pipelineGenerationFromStage(p)).catch(() => {});
                    }
                });
            }

            checkAllStoresCompleted();
        }
    }

    // Standalone parse (not multi-account, not parse-all): still notify Telegram
    if (shouldNotifyTelegram && !stored.multiAccountState) {
        const count = request.found || 0;
        const emoji = request.status === 'Error' ? '❌' : '✅';
        parseReport.stores[storeKey] = { found: count, status: emoji };
        sendTelegramMessage(`${emoji} ${request.store || storeKey}: Готово (${count} заказов)`);
        // Upload to Sheets immediately after standalone parse
        if (request.status !== 'Error') {
            setTimeout(() => uploadToSheets().catch(error => {
                console.warn('Standalone Sheets upload failed:', error?.message || error);
            }), 1500);
        }
        if (screenshotsEnabled && trackScreenshotQueue.length > 0) {
            setTimeout(() => processScreenshotQueue(), 2000);
        }
    }

    // Update cache synchronously (if not already updated above)
    if (!shouldHandleCompletion) {
        cachedProgressState[storeKey] = {
            current: request.current,
            total: request.total,
            status: request.status,
            percent: request.total > 0 ? Math.min((request.current / request.total) * 100, 100) : 0,
            found: request.found,
            timestamp: Date.now()
        };

        console.log(`💾 [BACKGROUND] Saving progress state for ${storeKey}:`, cachedProgressState[storeKey]);

        // Save parsing state if needed (redundant but safe)
        if (isParsingAllStores) saveParsingState();

        // Write entire cache to storage
        chrome.storage.local.set({ progressState: cachedProgressState });
    }

    // FIX: Forward progress message to popup for real-time updates!
    chrome.runtime.sendMessage(request).catch(() => {
        // Popup might be closed, ignore error
    });
}

async function validateParserSignal(request, sender) {
    const store = String(request.store || '').toLowerCase();
    if (!['iherb', 'ebay', 'amazon'].includes(store)) return null;
    const state = await chrome.storage.local.get([
        'pipelineRun', 'pipelineStage', 'multiAccountIherbState', 'multiAccountState',
        'iherbParserTabId', 'ebayParserTabId', 'amazonParserTabId',
        'iherbStageFinalizing', 'iherbParseAttemptId', 'iherbTimeoutAttempt'
    ]);
    const expectedAccount = store === 'iherb'
        ? state.multiAccountIherbState?.currentIherbAccount
        : store === 'amazon'
            ? state.multiAccountState?.currentAmazonAccount
            : state.pipelineRun?.expected?.ebay?.[0];
    const expectedTabId = state[`${store}ParserTabId`];
    const valid = ['starting', 'running'].includes(state.pipelineRun?.status)
        && request.runId === state.pipelineRun.id
        && normalizeAccountEmail(request.account) === normalizeAccountEmail(expectedAccount)
        && state.pipelineStage?.active === true
        && state.pipelineStage?.runId === state.pipelineRun.id
        && state.pipelineStage?.stages?.[state.pipelineStage?.currentIndex] === store
        && !(store === 'iherb' && state.iherbStageFinalizing?.runId === state.pipelineRun.id)
        && !(store === 'iherb' && (
            !request.attemptId
            || request.attemptId !== state.iherbParseAttemptId
            || iherbTimeoutAttemptMatchesRuntime(state.iherbTimeoutAttempt, state)
        ))
        && !!sender?.tab?.id
        && sender.tab.id === expectedTabId;
    return valid ? {
        store,
        runId: state.pipelineRun.id,
        account: expectedAccount,
        attemptId: store === 'iherb' ? state.iherbParseAttemptId : null
    } : null;
}

function iherbOwnedActionMatches(state, expected) {
    return !!expected?.runId
        && !!expected?.tabId
        && !!expected?.account
        && state?.pipelineStage?.active === true
        && pipelineGenerationMatches(state.pipelineStage, expected.generation)
        && state.pipelineStage.stages?.[state.pipelineStage.currentIndex] === 'iherb'
        && ['starting', 'running'].includes(state?.pipelineRun?.status)
        && state.pipelineRun.id === expected.runId
        && state.iherbParserTabId === expected.tabId
        && state.iherbParseAttemptId === expected.attemptId
        && normalizeAccountEmail(state.multiAccountIherbState?.currentIherbAccount)
            === normalizeAccountEmail(expected.account);
}

async function readIherbOwnedActionState() {
    return chrome.storage.local.get([
        'pipelineRun', 'pipelineStage', 'multiAccountIherbState',
        'iherbParserTabId', 'iherbPressHoldAttempts'
    ]);
}

function iherbHumanChallengeMatches(marker, expected) {
    return marker?.status === 'awaiting-human'
        && marker.runId === expected?.runId
        && normalizeAccountEmail(marker.account) === normalizeAccountEmail(expected?.account)
        && marker.tabId === expected?.tabId
        && marker.attemptId === expected?.attemptId
        && pipelineGenerationMatches(marker, expected?.generation);
}

async function markIherbHumanChallengeAlerted(expected) {
    const fresh = await chrome.storage.local.get(['iherbHumanChallenge']);
    if (!iherbHumanChallengeMatches(fresh.iherbHumanChallenge, expected)) return false;
    await chrome.storage.local.set({
        iherbHumanChallenge: {
            ...fresh.iherbHumanChallenge,
            alertedAt: Date.now()
        }
    });
    return true;
}

async function sendIherbHumanChallengeAlert(marker) {
    await sendTelegramMessage(
        `🛑 iHerb (${String(marker.account || '').split('@')[0]}): Press & Hold требует человека. `
        + 'Ночной обход остановлен; вкладка оставлена без навигации. После ручного решения нужен отдельный подтверждённый запуск.'
    );
    return markIherbHumanChallengeAlerted({
        runId: marker.runId,
        account: marker.account,
        tabId: marker.tabId,
        attemptId: marker.attemptId,
        generation: marker
    });
}

async function retryPendingIherbHumanChallengeAlert() {
    const state = await chrome.storage.local.get(['iherbHumanChallenge']);
    const marker = state.iherbHumanChallenge;
    if (marker?.status !== 'awaiting-human' || marker.alertedAt) return false;
    await sendIherbHumanChallengeAlert(marker).catch(error => {
        console.warn('⚠️ Failed to resend iHerb human-challenge alert:', error?.message || error);
    });
    return true;
}

async function handleIherbPressHoldDetected(request, sender) {
    const commitTask = pipelineRunWriteChain
        .catch(() => {})
        .then(async () => {
            const state = await chrome.storage.local.get([
                'pipelineRun', 'pipelineStage', 'multiAccountIherbState',
                'iherbParserTabId', 'iherbParseAttemptId', 'iherbHumanChallenge'
            ]);
            const generation = pipelineGenerationFromStage(state.pipelineStage);
            const expected = {
                runId: request.runId,
                account: request.account,
                tabId: sender?.tab?.id || null,
                attemptId: request.attemptId,
                generation
            };
            if (!iherbOwnedActionMatches(state, expected)) {
                return { blocked: false, reason: 'stale_tab_or_run' };
            }

            if (iherbHumanChallengeMatches(state.iherbHumanChallenge, expected)) {
                return {
                    blocked: true,
                    reason: 'human_required',
                    marker: state.iherbHumanChallenge,
                    alertNeeded: !state.iherbHumanChallenge.alertedAt
                };
            }

            const now = Date.now();
            const marker = {
                ...generation,
                runId: state.pipelineRun.id,
                account: state.multiAccountIherbState.currentIherbAccount,
                tabId: state.iherbParserTabId,
                attemptId: state.iherbParseAttemptId,
                kind: 'press-hold',
                status: 'awaiting-human',
                detectedAt: now,
                alertedAt: null
            };
            const failure = {
                shop: 'iherb',
                account: normalizeAccountEmail(marker.account),
                reason: 'press-hold-human-required',
                at: now
            };
            const failures = Array.isArray(state.pipelineRun.failures)
                ? state.pipelineRun.failures.filter(item => !(
                    item?.shop === 'iherb'
                    && normalizeAccountEmail(item?.account) === normalizeAccountEmail(marker.account)
                    && item?.reason === failure.reason
                ))
                : [];
            failures.push(failure);
            const blockedRun = {
                ...state.pipelineRun,
                status: 'blocked',
                finishedAt: now,
                failures
            };
            const blockedStage = {
                ...state.pipelineStage,
                active: false,
                blockedAt: now,
                blockedReason: 'iherb-press-hold-human-required'
            };

            await chrome.storage.local.set({
                pipelineRun: blockedRun,
                pipelineStage: blockedStage,
                iherbHumanChallenge: marker,
                screenshotQueueBlocked: {
                    reason: 'iherb-press-hold-human-required',
                    runId: marker.runId,
                    account: marker.account,
                    at: now
                },
                parsingState: { isParsingAllStores: false, storesCompleted },
                stopAllParsers: true,
                lastDailyAutoParseStatus: 'blocked-human-captcha',
                lastDailyAutoParseFinishedAt: now,
                lastDailyAutoParseError: 'iHerb Press & Hold requires a human'
            });
            isParsingAllStores = false;
            return {
                blocked: true,
                reason: 'human_required',
                marker,
                alertNeeded: true
            };
        });
    pipelineRunWriteChain = commitTask.catch(() => {});
    const result = await commitTask;
    if (result?.blocked && result.alertNeeded) {
        await sendIherbHumanChallengeAlert(result.marker).catch(error => {
            console.warn('⚠️ Failed to send iHerb human-challenge alert:', error?.message || error);
        });
    }
    return {
        blocked: !!result?.blocked,
        reason: result?.reason || 'unknown',
        waitingForHuman: !!result?.blocked
    };
}

// --- Message Listener ---
// Fetch an eBay order's tracking number from its DETAIL page. Some orders/carriers
// (e.g. FedEx order 24-14770-78524 → 873223053751) expose the tracking ONLY in the
// order-details SPA (order.ebay.com/ord/show), never in the purchase-history list feed
// the parser reads. The value sits in embedded JSON: trackingSection → label "Number"
// → value. This is cross-origin from the parser's www.ebay.com tab, so it MUST run in
// the background SW (host_permissions <all_urls> bypasses CORS). Returns '' on miss.
async function fetchEbayOrderTracking(orderId) {
    if (!orderId || orderId === 'N/A') return '';
    try {
        const url = `https://order.ebay.com/ord/show?orderId=${encodeURIComponent(orderId)}`;
        // Hard timeout: one hung detail fetch must never wedge the whole batch.
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 12000);
        let r;
        try { r = await fetch(url, { credentials: 'include', signal: ac.signal }); }
        finally { clearTimeout(to); }
        if (!r.ok) return '';
        const html = await r.text();
        // Anchor on trackingSection so an unrelated number elsewhere can't be grabbed.
        const m = html.match(/"trackingSection"[\s\S]*?"text":"Number"[\s\S]{0,220}?"text":"([A-Z0-9]{8,30})"/);
        return m ? m[1] : '';
    } catch (_) {
        return '';
    }
}

// Batch variant: fetch tracking for many orders in ONE active run so the SW stays
// alive throughout (a single content-script message → one long busy loop, instead of
// many small messages with idle gaps that let the SW sleep and drop the async reply,
// hanging the parse). Returns { [orderId]: tracking }.
async function fetchEbayOrderTrackings(orderIds) {
    const out = {};
    for (const orderId of (orderIds || [])) {
        out[orderId] = await fetchEbayOrderTracking(orderId);
        await new Promise(r => setTimeout(r, 500)); // gentle pacing between detail fetches
    }
    return out;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Debug logs for messages
    if (request.action !== 'progress' && request.action !== 'addLog') { // Reduce noise
        console.log('📨 Message received:', request.action, request);
    }
    
    // Handle parsing logs
    if (request.action === 'addLog') {
        addParsingLog(request.store, request.orderId, request.trackNumber, request.status, request.details)
            .then(() => getParsingLogs())
            .then(logs => console.log(`📝 Log added: ${request.store} | ${request.orderId} | ${request.status} (total: ${logs.length})`));
        return;
    }

    if (request.action === "startPochtoyAutomation") {
        automationOptions = Object.assign({ 
            spreadsheetId: null, 
            sheetName: 'Лист1', 
            skipProcessed: true, 
            colorProcessed: false,
            limitRows: true 
        }, request.options || {});
        
        sendTelegramMessage(`🤖 Запускаю автоматизацию Pochtoy.com...`);
        startPochtoyAutomation(request.data);
        sendResponse({status: "success"});
    } else if (request.action === "stopPochtoyAutomation") {
        stopAutomation();
        sendResponse({status: "success"});
    } else if (request.action === "contentScriptReady") {
        processNextInQueue();
    } else if (request.action === "resetSheetMarks") {
        resetSheetMarks(request.options).then(()=>sendResponse({status:'ok'})).catch(e=>sendResponse({status:'error', message:String(e)}));
    } else if (request.action === "startParsingAllStores") {
        runDailyAutoParse('popup-legacy-all')
            .then(started => sendResponse({ status: started ? 'started' : 'refused' }))
            .catch(error => sendResponse({ status: 'error', error: String(error?.message || error) }));
        return true;
    } else if (request.action === "startSequentialPipeline") {
        // Popup uses the same mutexed/durable door as alarm, Telegram and the
        // external watchdog. No caller may reset state behind an active run.
        runDailyAutoParse('popup')
            .then(started => sendResponse({ status: started ? 'started' : 'refused' }))
            .catch(error => sendResponse({ status: 'error', error: String(error?.message || error) }));
        return true;
    } else if (request.action === "getAccountsConfig") {
        loadAccountsConfig().then(cfg => sendResponse({ config: cfg, defaults: DEFAULT_ACCOUNTS_CONFIG }));
        return true;
    } else if (request.action === "saveAccountsConfig") {
        chrome.storage.local.set({ accountsConfig: request.config }).then(() => sendResponse({ ok: true }));
        return true;
    } else if (request.action === "startMultiAccountAmazon") {
        // A standalone Amazon run has no six-cabinet run identity and can race
        // the book upload. Keep one authoritative launch door.
        sendResponse({ status: 'refused', error: 'standalone-disabled-use-sequential-pipeline' });
    } else if (request.action === "accountSwitchFailed") {
        (async () => {
            console.log(`❌ Account switch failed for ${request.email}: ${request.error}`);
            const failData = await chrome.storage.local.get([
                'accountSwitchFailures', 'pipelineRun', 'pipelineStage',
                'multiAccountState', 'amazonParserTabId'
            ]);
            const email = request.email || currentAmazonAccount || 'unknown';
            const owned = !!sender?.tab?.id
                && sender.tab.id === failData.amazonParserTabId
                && request.runId === failData.pipelineRun?.id
                && ['starting', 'running'].includes(failData.pipelineRun?.status)
                && failData.pipelineStage?.runId === request.runId
                && failData.pipelineStage?.stages?.[failData.pipelineStage?.currentIndex] === 'amazon'
                && normalizeAccountEmail(email)
                    === normalizeAccountEmail(failData.multiAccountState?.currentAmazonAccount);
            if (!owned) {
                console.warn('⏭ Ignoring stale Amazon account-switch failure');
                return;
            }
            const generation = pipelineGenerationFromStage(failData.pipelineStage);
            if (failData.multiAccountState) {
                isMultiAccountParsing = failData.multiAccountState.isMultiAccountParsing;
                amazonAccountsQueue = failData.multiAccountState.amazonAccountsQueue || [];
                currentAmazonAccount = failData.multiAccountState.currentAmazonAccount;
            }
            const failures = failData.accountSwitchFailures || {};
            failures[email] = (failures[email] || 0) + 1;
            await chrome.storage.local.set({ accountSwitchFailures: failures });
            
            if (failures[email] >= MAX_ACCOUNT_SWITCH_ATTEMPTS) {
                console.log(`🚫 Account ${email} failed ${failures[email]} times, skipping`);
                sendTelegramMessage(`🚫 Аккаунт ${email.split('@')[0]} недоступен (попыток: ${failures[email]}), пропускаю`);
                await markPipelineAccountResult('amazon', email, {
                    runId: request.runId,
                    ok: false,
                    reason: 'account-switch-failed'
                });
                const failureGate = await chrome.storage.local.get([
                    'pipelineRun', 'pipelineStage', 'multiAccountState'
                ]);
                if (failureGate.pipelineRun?.id !== request.runId
                    || !failureGate.pipelineStage?.active
                    || !pipelineGenerationMatches(failureGate.pipelineStage, generation)
                    || normalizeAccountEmail(failureGate.multiAccountState?.currentAmazonAccount)
                        !== normalizeAccountEmail(email)) return;
                await chrome.storage.local.remove(['accountSwitchStartedAt']);
                await switchToNextAmazonAccount(generation);
            } else {
                console.log(`⚠️ Не удалось переключиться на ${email.split('@')[0]} (попытка ${failures[email]}/${MAX_ACCOUNT_SWITCH_ATTEMPTS}), пробую ещё раз...`);
                const retryGate = await chrome.storage.local.get([
                    'pipelineRun', 'pipelineStage', 'multiAccountState'
                ]);
                if (retryGate.pipelineRun?.id !== request.runId
                    || !retryGate.pipelineStage?.active
                    || !pipelineGenerationMatches(retryGate.pipelineStage, generation)
                    || normalizeAccountEmail(retryGate.multiAccountState?.currentAmazonAccount)
                        !== normalizeAccountEmail(email)) return;
                amazonAccountsQueue.unshift(email);
                await chrome.storage.local.set({
                    multiAccountState: {
                        isMultiAccountParsing: true,
                        amazonAccountsQueue: amazonAccountsQueue,
                        currentAmazonAccount: currentAmazonAccount
                    }
                });
                await switchToNextAmazonAccount(generation);
            }
        })();
    } else if (request.action === "iherbSwitchFailed") {
        (async () => {
            const reason = request.reason || 'unknown';
            const email = request.email || 'unknown';
            console.warn(`❌ iHerb switch failed for ${email}: ${reason}`);
            const gate = await chrome.storage.local.get(['iherbParserTabId', 'pipelineRun']);
            if (!sender?.tab?.id || sender.tab.id !== gate.iherbParserTabId
                || !request.runId || request.runId !== gate.pipelineRun?.id) {
                console.warn('⏭ Ignoring iHerb switch failure from a stale tab/run');
                return;
            }
            if (reason === 'captcha') {
                await abortIherbStageDueToCaptcha(email, request.runId);
                return;
            }
            await handleIherbSwitchFailure(email, reason, request.runId);
        })();
        return true;
    } else if (request.action === "solveCaptcha") {
        // Решение reCAPTCHA v2 через 2captcha. Вызывается из content-iherb-login.js
        // когда detectActiveCaptcha нашёл ВИДИМЫЙ челлендж. Возвращает
        // { ok:true, token } или { ok:false, reason }. Жёсткий тайм-аут — чтобы
        // content script не висел дольше budget'а (см. pipeline resilience).
        const { sitekey, pageurl, timeoutMs } = request;
        solveRecaptchaVia2Captcha(sitekey, pageurl, timeoutMs || 60000)
            .then(token => sendResponse({ ok: true, token }))
            .catch(err => {
                console.warn('🧩 [2captcha] solve failed:', err?.message || err);
                sendResponse({ ok: false, reason: err?.message || String(err) });
            });
        return true; // async
    } else if (request.action === "iherbPressHoldDetected") {
        handleIherbPressHoldDetected(request, sender)
            .then(sendResponse)
            .catch(error => sendResponse({
                blocked: false,
                reason: String(error?.message || error)
            }));
        return true; // async
    } else if (request.action === "parsingProgress") {
        // Handle parsingProgress from content scripts (convert to progress format)
        const progressData = request.data || {};
        const progressMsg = {
            action: 'progress',
            store: progressData.store,
            current: progressData.current,
            total: progressData.total,
            status: progressData.status,
            found: progressData.found,
            runId: progressData.runId,
            account: progressData.account,
            attemptId: progressData.attemptId
        };

        // Process exactly once. Re-broadcasting this message made this same
        // listener receive `progress`, then the callback called the handler a
        // second time. A Done event could therefore switch/finalize one account
        // twice before its content script had committed orderData.
        handleProgressMessage(progressMsg, sender).catch(error => {
            console.warn('parsingProgress handling failed:', error?.message || error);
        });
    } else if (request.action === "progress") {
        handleProgressMessage(request, sender);
    } else if (request.action === "multiAccountLog") {
        // Forwarded from content-switch-account.js / content-amazon.js —
        // persistent step-log of Amazon multi-account flow for diagnostics.
        logMultiAccountStep(request.step, { ...(request.detail || {}), tabId: sender?.tab?.id || null });
        sendResponse({status: "logged"});
    } else if (request.action === "getParserContext") {
        (async () => {
            const store = String(request.store || '').toLowerCase();
            if (!['iherb', 'ebay'].includes(store)) {
                sendResponse({ active: false, owned: false });
                return;
            }
            const state = await chrome.storage.local.get([
                'pipelineRun', 'pipelineStage', 'multiAccountIherbState',
                'iherbParserTabId', 'ebayParserTabId', 'iherbStageFinalizing',
                'iherbHumanChallenge', 'iherbParseAttemptId', 'iherbTimeoutAttempt'
            ]);
            const active = ['starting', 'running'].includes(state.pipelineRun?.status)
                && state.pipelineStage?.active === true
                && state.pipelineStage?.runId === state.pipelineRun?.id
                && state.pipelineStage?.stages?.[state.pipelineStage?.currentIndex] === store;
            const finalizingIherbAccount = store === 'iherb'
                && pipelineGenerationMatches(
                    state.iherbStageFinalizing,
                    pipelineGenerationFromStage(state.pipelineStage)
                )
                ? state.iherbStageFinalizing?.account
                : null;
            const isIherbFinalizing = !!finalizingIherbAccount;
            const purpose = String(request.purpose || 'parse').toLowerCase();
            const account = store === 'iherb'
                ? (isIherbFinalizing
                    ? (purpose === 'login' ? finalizingIherbAccount : null)
                    : state.multiAccountIherbState?.currentIherbAccount)
                : state.pipelineRun?.expected?.ebay?.[0];
            const timeoutBlocked = store === 'iherb'
                && iherbTimeoutAttemptMatchesRuntime(state.iherbTimeoutAttempt, state);
            const owned = active
                && !!account
                && !!sender?.tab?.id
                && sender.tab.id === state[`${store}ParserTabId`]
                && !timeoutBlocked;
            const blocked = store === 'iherb'
                && state.iherbHumanChallenge?.status === 'awaiting-human';
            sendResponse({
                active,
                owned,
                blocked,
                runId: owned ? state.pipelineRun.id : null,
                account: owned ? account : null,
                tabId: owned ? sender.tab.id : null,
                attemptId: owned && store === 'iherb' ? state.iherbParseAttemptId : null,
                stageStartedAt: owned ? (state.pipelineStage.stageStartedAt || null) : null
            });
        })().catch(error => sendResponse({ active: false, owned: false, error: String(error?.message || error) }));
        return true;
    } else if (request.action === "markIherbFinalReturnLoginSubmitted") {
        markIherbFinalReturnLoginSubmitted(
            sender?.tab?.id || null,
            sender?.url || sender?.tab?.url || ''
        ).then(sendResponse).catch(error => sendResponse({
            accepted: false,
            reason: String(error?.message || error)
        }));
        return true;
    } else if (request.action === "confirmIherbFinalReturnLanding") {
        confirmIherbFinalReturnLanding(
            sender?.tab?.id || null,
            sender?.url || sender?.tab?.url || ''
        ).then(sendResponse).catch(error => sendResponse({
            confirmed: false,
            reason: String(error?.message || error)
        }));
        return true;
    } else if (request.action === "commitIherbAttempt") {
        handleIherbAttemptCommit(request, sender?.tab?.id || null)
            .then(sendResponse)
            .catch(error => sendResponse({
                ok: false,
                status: 'error',
                reason: String(error?.message || error)
            }));
        return true;
    } else if (request.action === "getAmazonParserContext") {
        (async () => {
            const state = await chrome.storage.local.get([
                'amazonParserTabId', 'pipelineRun', 'pipelineStage', 'multiAccountState',
                'amazonFinalReturn', 'pendingAccountSwitch', 'amazonStageFinalizing',
                'accountSwitchStartedAt', 'amazonPaginationState', 'amazonTimeoutAttempt'
            ]);
            const parsingAccount = state.multiAccountState?.isMultiAccountParsing
                ? state.multiAccountState.currentAmazonAccount
                : null;
            const generation = pipelineGenerationFromStage(state.pipelineStage);
            const finalReturnAccount = pipelineGenerationMatches(
                state.amazonStageFinalizing,
                generation
            ) ? state.amazonStageFinalizing?.account : null;
            const timeoutBlocksCurrentAttempt = !!state.amazonTimeoutAttempt
                && amazonWatchdogAttemptIdentityMatches(
                    amazonWatchdogAttemptFromState(state),
                    state.amazonTimeoutAttempt
                );
            const owned = !!sender?.tab?.id
                && sender.tab.id === state.amazonParserTabId
                && ['starting', 'running'].includes(state.pipelineRun?.status)
                && state.pipelineStage?.active === true
                && state.pipelineStage?.runId === state.pipelineRun?.id
                && state.pipelineStage?.stages?.[state.pipelineStage?.currentIndex] === 'amazon'
                && !!(parsingAccount || finalReturnAccount)
                && !timeoutBlocksCurrentAttempt;
            sendResponse({
                owned,
                tabId: owned ? sender.tab.id : null,
                runId: owned ? state.pipelineRun.id : null,
                account: owned ? (parsingAccount || finalReturnAccount) : null,
                stageStartedAt: owned ? (state.pipelineStage.stageStartedAt || null) : null,
                accountSwitchStartedAt: owned ? (state.accountSwitchStartedAt || null) : null,
                parseId: owned ? (state.amazonPaginationState?.parseId || null) : null
            });
        })().catch(error => sendResponse({ owned: false, error: String(error?.message || error) }));
        return true;
    } else if (request.action === "commitAmazonAttempt") {
        handleAmazonAttemptCommit(request, sender?.tab?.id || null)
            .then(sendResponse)
            .catch(error => sendResponse({
                ok: false,
                status: 'error',
                reason: String(error?.message || error)
            }));
        return true;
    } else if (request.action === "fetchEbayOrderTracking") {
        // Parser found no tracking in the list feed for this order — read it from the
        // order-detail page (cross-origin; only the background SW can, due to CORS).
        fetchEbayOrderTracking(request.orderId)
            .then(tracking => sendResponse({ ok: true, tracking }))
            .catch(err => sendResponse({ ok: false, tracking: '', error: String(err?.message || err) }));
        return true; // async
    } else if (request.action === "fetchEbayOrderTrackings") {
        // Batch: recover tracking for all feed-untracked orders from their detail pages.
        fetchEbayOrderTrackings(request.orderIds)
            .then(map => sendResponse({ ok: true, map }))
            .catch(err => sendResponse({ ok: false, map: {}, error: String(err?.message || err) }));
        return true; // async
    } else if (request.action === "queueTrackScreenshot") {
        queueTrackScreenshot(request.orderId, request.trackNumber, request.trackUrl, request.accountName)
            .then(() => sendResponse({status: "queued"}))
            .catch(error => sendResponse({status: "error", error: String(error?.message || error)}));
        return true; // response только после persisted commit (важно для MV3 sleep)
    } else if (request.action === "processScreenshotQueue") {
        processScreenshotQueue();
        sendResponse({status: "processing"});
    } else if (request.action === "saveManualAccount") {
        chrome.storage.local.set({ manualAccountName: request.accountName });
        sendResponse({status: "saved"});
    } else if (request.action === "reloadScreenshotSettings") {
        chrome.storage.local.get(['screenshotsEnabled'], (res) => {
            screenshotsEnabled = res.screenshotsEnabled || false;
            console.log(`📸 Screenshots ${screenshotsEnabled ? 'ENABLED' : 'DISABLED'}`);
        });
    } else if (request.action === "reloadTgSettings") {
        chrome.storage.local.get(['tgBotToken', 'tgChatId'], (res) => {
            console.log('🔄 Reloading Telegram Settings from popup update:', res);
            tgBotToken = res.tgBotToken;
            tgChatId = res.tgChatId;
            if (tgBotToken) startTelegramPolling();
        });
    } else if (request.action === "parserStarted") {
        (async () => {
            const signal = await validateParserSignal(request, sender);
            if (!signal) {
                console.warn('⏭ Ignoring parserStarted from a stale tab/run/account');
                return;
            }
            const startedAt = Date.now();
            if (signal.store === 'iherb') {
                await chrome.storage.local.set({ iherbParseStartedAt: startedAt, iherbWatchdogRetried: false });
            } else if (signal.store === 'amazon') {
                await chrome.storage.local.set({ lastAmazonProgressAt: startedAt });
            }
            console.log(`✅ ${request.store} parser started successfully`);
        })().catch(error => console.warn('parserStarted gate failed:', error?.message || error));
        return true;
    } else if (request.action === "parseError") {
        (async () => {
            const signal = await validateParserSignal(request, sender);
            if (!signal) {
                console.warn('⏭ Ignoring parseError from a stale tab/run/account');
                return;
            }
            const errorMsg = request.error || 'Unknown error';
            if (signal.store === 'iherb') {
                await chrome.storage.local.remove(['iherbParseStartedAt', 'iherbWatchdogRetried']);
            } else if (signal.store === 'amazon') {
                await chrome.storage.local.remove(['lastAmazonProgressAt']);
            }
            console.log(`❌ [BACKGROUND] Parse error from ${request.store}: ${errorMsg}`);
            sendTelegramMessage(`❌ ${request.store}: Ошибка парсинга - ${errorMsg}`).catch(() => {});
            await handleProgressMessage({
                action: 'progress',
                store: request.store,
                current: 0,
                total: 0,
                status: 'Error',
                found: 0,
                runId: signal.runId,
                account: signal.account,
                attemptId: signal.attemptId
            }, sender);
        })().catch(error => console.warn('parseError gate failed:', error?.message || error));
        return true;
    }
    return true; // Keep channel open for async responses
});

function saveParsingState() {
    chrome.storage.local.set({
        parsingState: {
            isParsingAllStores,
            storesCompleted
        }
    });
}

// ─── 2captcha reCAPTCHA-v2 solver ───
// Решает reCAPTCHA через сервис 2captcha (in.php → poll res.php → token).
// API-ключ берётся из chrome.storage.local.twoCaptchaApiKey (можно задать в popup).
// Если ключа нет — кидаем 'no_api_key', чтобы caller сразу ушёл на skip-фолбэк
// (не блокируя pipeline). timeoutMs — жёсткий бюджет на всё решение.
async function solveRecaptchaVia2Captcha(sitekey, pageurl, timeoutMs = 60000) {
    if (!sitekey) throw new Error('no_sitekey');
    if (!pageurl) throw new Error('no_pageurl');

    const cfg = await chrome.storage.local.get(['twoCaptchaApiKey']);
    const apiKey = (cfg.twoCaptchaApiKey || '').trim();
    if (!apiKey) throw new Error('no_api_key');

    const deadline = Date.now() + timeoutMs;
    console.log(`🧩 [2captcha] submitting reCAPTCHA (sitekey=${sitekey.slice(0, 12)}…, pageurl=${pageurl.slice(0, 60)})`);

    // 1) Отправляем задание
    const inUrl = `https://2captcha.com/in.php?key=${encodeURIComponent(apiKey)}` +
        `&method=userrecaptcha&googlekey=${encodeURIComponent(sitekey)}` +
        `&pageurl=${encodeURIComponent(pageurl)}&json=1`;
    const inResp = await fetch(inUrl).then(r => r.json());
    if (String(inResp.status) !== '1') {
        throw new Error('in_php_error: ' + (inResp.request || 'unknown'));
    }
    const captchaId = inResp.request;
    console.log(`🧩 [2captcha] job accepted id=${captchaId}, polling…`);

    // 2) Поллим результат (2captcha рекомендует ждать ~15с до первого запроса,
    //    но мы ограничены timeoutMs — стартуем через 12с, затем каждые 5с)
    await new Promise(r => setTimeout(r, Math.min(12000, Math.max(0, deadline - Date.now()))));
    const resUrl = `https://2captcha.com/res.php?key=${encodeURIComponent(apiKey)}` +
        `&action=get&id=${encodeURIComponent(captchaId)}&json=1`;

    while (Date.now() < deadline) {
        const res = await fetch(resUrl).then(r => r.json()).catch(() => ({ status: 0, request: 'fetch_error' }));
        if (String(res.status) === '1') {
            console.log('🧩 [2captcha] solved');
            return res.request; // g-recaptcha-response token
        }
        if (res.request && res.request !== 'CAPCHA_NOT_READY' && res.request !== 'CAPTCHA_NOT_READY') {
            throw new Error('res_php_error: ' + res.request);
        }
        await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error('solve_timeout');
}

// Captcha не решилась за бюджет — пропускаем всю стадию iHerb и двигаем pipeline
// к следующему магазину (eBay → Amazon). Очищаем iherb-очередь и runtime-флаги,
// чтобы watchdog/ретраи не воскресили зависшую стадию. НЕ делаем
// finalReturnToIherbPrimary в pipeline-режиме — повторный логин снова упрётся в
// captcha и снова сожжёт 60с. Следующим магазинам логин-состояние iHerb не нужно.
async function abortIherbStageDueToCaptcha(email, runId, expectedGeneration = null) {
    const who = (email || '').split('@')[0] || 'аккаунт';
    console.warn(`🧩 [iHerb] captcha unsolved for ${email} — skipping iHerb stage, moving to next shop`);
    sendTelegramMessage(`🧩 iHerb: captcha не пройдена (${who}). Пропускаю iHerb, перехожу к следующему магазину.`).catch(() => {});

    const initial = await chrome.storage.local.get([
        'pipelineRun', 'pipelineStage', 'multiAccountIherbState'
    ]);
    const generation = expectedGeneration || pipelineGenerationFromStage(initial.pipelineStage);
    if (initial.pipelineRun?.id !== runId
        || !initial.pipelineStage?.active
        || !pipelineGenerationMatches(initial.pipelineStage, generation)
        || initial.pipelineStage.stages?.[initial.pipelineStage.currentIndex] !== 'iherb'
        || normalizeAccountEmail(initial.multiAccountIherbState?.currentIherbAccount)
            !== normalizeAccountEmail(email)) return false;

    await recordIherbSkipReason(email, 'captcha', runId);
    const gate = await chrome.storage.local.get([
        'pipelineRun', 'pipelineStage', 'multiAccountIherbState'
    ]);
    if (gate.pipelineRun?.id !== runId
        || !gate.pipelineStage?.active
        || !pipelineGenerationMatches(gate.pipelineStage, generation)
        || normalizeAccountEmail(gate.multiAccountIherbState?.currentIherbAccount)
            !== normalizeAccountEmail(email)) return false;
    iherbAccountsQueue = [];
    await chrome.storage.local.set({
        iherbSwitchInProgress: null,
        iherbSwitchStartedAt: null,
        pendingIherbSwitch: null,
        iherbSwitchDispatch: null,
        multiAccountIherbState: {
            ...(gate.multiAccountIherbState || {}),
            isMultiAccountIherb: true,
            iherbAccountsQueue: [],
            currentIherbAccount: email
        }
    });

    // Всегда закрываем стадию через единый chokepoint: он гарантированно вернёт
    // сессию на primary (оператор хочет always-return, даже после captcha),
    // построит roster + алерт по пропущенным и сам двинет pipeline дальше.
    // fromCaptcha=true отключает retry-проход (captcha по IP — повтор бессмыслен).
    await finalizeIherbStage(undefined, {
        fromCaptcha: true,
        expectedGeneration: generation
    }).catch(e =>
        console.warn('finalizeIherbStage after captcha-abort failed:', e?.message || e));
    return true;
}

// Switch to next Amazon account for multi-account parsing
const parserOperationFlights = new Map();

function pipelineOperationKey(generation, ...parts) {
    return JSON.stringify([
        generation?.runId || null,
        generation?.startedAt || null,
        generation?.currentIndex ?? null,
        generation?.stageStartedAt || null,
        ...parts
    ]);
}

function runParserOperationSingleFlight(slot, key, work) {
    const existing = parserOperationFlights.get(slot);
    if (existing) {
        if (existing.key === key) return existing.promise;
        // Different account/generation operations must not share a browser tab.
        // Let the current owner finish, then let the new caller re-enter and
        // prove that it still owns the stage before doing any side effect.
        return existing.promise
            .catch(() => false)
            .then(() => runParserOperationSingleFlight(slot, key, work));
    }
    const record = { key, promise: null };
    record.promise = Promise.resolve().then(work);
    parserOperationFlights.set(slot, record);
    const clear = () => {
        if (parserOperationFlights.get(slot) === record) parserOperationFlights.delete(slot);
    };
    record.promise.then(clear, clear);
    return record.promise;
}

function getAmazonSwitchAccountUrl() {
    return 'https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com%2F%3Fref_%3Dnav_youraccount_switchacct&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&marketPlaceId=ATVPDKIKX0DER&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&switch_account=picker&ignoreAuthState=1&_encoding=UTF8';
}

function dispatchCurrentAmazonAccountSwitch(email, expectedGeneration, kind = 'account-switch') {
    const key = pipelineOperationKey(
        expectedGeneration,
        normalizeAccountEmail(email),
        kind
    );
    return runParserOperationSingleFlight('amazon-account-dispatch', key, () =>
        dispatchCurrentAmazonAccountSwitchOnce(email, expectedGeneration, kind));
}

async function dispatchCurrentAmazonAccountSwitchOnce(email, expectedGeneration, kind = 'account-switch') {
    const readDispatchState = () => chrome.storage.local.get([
        'pipelineRun', 'pipelineStage', 'multiAccountState', 'pendingAccountSwitch',
        'amazonParserTabId', 'amazonStageFinalizing', 'amazonSwitchDispatch'
    ]);
    const ownsDispatch = state => {
        const regularOwned = kind === 'account-switch'
            && normalizeAccountEmail(state.multiAccountState?.currentAmazonAccount)
                === normalizeAccountEmail(email);
        const finalOwned = kind === 'final-return'
            && pipelineGenerationMatches(state.amazonStageFinalizing, expectedGeneration)
            && normalizeAccountEmail(state.amazonStageFinalizing?.account)
                === normalizeAccountEmail(email);
        return !!expectedGeneration
            && state.pipelineStage?.active === true
            && pipelineGenerationMatches(state.pipelineStage, expectedGeneration)
            && state.pipelineStage.stages?.[state.pipelineStage.currentIndex] === 'amazon'
            && state.pipelineRun?.id === expectedGeneration.runId
            && state.pendingAccountSwitch?.runId === expectedGeneration.runId
            && normalizeAccountEmail(state.pendingAccountSwitch?.email)
                === normalizeAccountEmail(email)
            && (regularOwned || finalOwned);
    };
    const state = await readDispatchState();
    if (!ownsDispatch(state)) {
        console.warn('⏭ Refusing stale Amazon account dispatch');
        return false;
    }

    let parserTab = await getAmazonParserTab(state.amazonParserTabId);
    // getAmazonParserTab/tabs.create are awaited browser calls. The pipeline may
    // advance while either one is pending, so ownership must be reread before
    // every following storage or navigation side effect.
    let afterTab = await readDispatchState();
    if (!ownsDispatch(afterTab)) {
        console.warn('⏭ Amazon generation changed while resolving parser tab');
        return false;
    }
    let createdParserTab = false;
    if (!parserTab) {
        parserTab = await chrome.tabs.create({ url: 'about:blank', active: false });
        if (!parserTab?.id) throw new Error('failed to create owned Amazon parser tab');
        createdParserTab = true;
        afterTab = await readDispatchState();
        if (!ownsDispatch(afterTab)) {
            try { await chrome.tabs.remove(parserTab.id); } catch (_) {}
            console.warn('⏭ Amazon generation changed while creating parser tab');
            return false;
        }
    }
    await chrome.storage.local.set({
        amazonParserTabId: parserTab.id,
        amazonSwitchDispatch: {
            ...expectedGeneration,
            account: email,
            tabId: parserTab.id,
            kind,
            phase: 'prepared',
            preparedAt: Date.now()
        }
    });
    const beforeNavigation = await readDispatchState();
    const prepared = beforeNavigation.amazonSwitchDispatch;
    if (!ownsDispatch(beforeNavigation)
        || !pipelineGenerationMatches(prepared, expectedGeneration)
        || normalizeAccountEmail(prepared?.account) !== normalizeAccountEmail(email)
        || prepared?.tabId !== parserTab.id
        || prepared?.kind !== kind
        || prepared?.phase !== 'prepared') {
        if (createdParserTab && !ownsDispatch(beforeNavigation)) {
            try { await chrome.tabs.remove(parserTab.id); } catch (_) {}
        }
        console.warn('⏭ Amazon generation changed before account navigation');
        return false;
    }
    await chrome.tabs.update(parserTab.id, {
        url: getAmazonSwitchAccountUrl(),
        active: true
    });

    const fresh = await readDispatchState();
    if (!ownsDispatch(fresh)
        || fresh.amazonParserTabId !== parserTab.id
        || !pipelineGenerationMatches(fresh.amazonSwitchDispatch, expectedGeneration)
        || normalizeAccountEmail(fresh.amazonSwitchDispatch?.account)
            !== normalizeAccountEmail(email)
        || fresh.amazonSwitchDispatch?.tabId !== parserTab.id
        || fresh.amazonSwitchDispatch?.kind !== kind
        || fresh.amazonSwitchDispatch?.phase !== 'prepared') {
        console.warn('⏭ Amazon dispatch completed after pipeline generation changed');
        return false;
    }
    await chrome.storage.local.set({
        amazonSwitchDispatch: {
            ...expectedGeneration,
            account: email,
            tabId: parserTab.id,
            kind,
            phase: 'dispatched',
            dispatchedAt: Date.now()
        }
    });
    return true;
}

async function switchToNextAmazonAccount(expectedGeneration = null) {
    // Restore state from storage in case Service Worker restarted
    const stored = await chrome.storage.local.get(['multiAccountState', 'pipelineRun', 'pipelineStage']);
    const generation = expectedGeneration || pipelineGenerationFromStage(stored.pipelineStage);
    if (!stored.pipelineStage?.active
        || !pipelineGenerationMatches(stored.pipelineStage, generation)
        || stored.pipelineStage.stages?.[stored.pipelineStage.currentIndex] !== 'amazon'
        || stored.pipelineRun?.id !== generation?.runId) {
        console.warn('⏭ Refusing stale Amazon queue mutation');
        return false;
    }
    if (stored.multiAccountState) {
        isMultiAccountParsing = stored.multiAccountState.isMultiAccountParsing;
        amazonAccountsQueue = stored.multiAccountState.amazonAccountsQueue || [];
        currentAmazonAccount = stored.multiAccountState.currentAmazonAccount;
        console.log('🔄 Restored multi-account state:', stored.multiAccountState);
    }

    // Amazon tracking/order pages тоже account-bound. Этот общий gate покрывает
    // штатное завершение и timeout-переход: ни одна карточка текущего кабинета
    // не переносится под следующий login.
    if (currentAmazonAccount) {
        if (!await waitForScreenshotsDrained()) {
            return stopPipelineForScreenshotDrain(
                'Amazon account screenshots blocked',
                generation
            );
        }
    }

    const afterDrain = (await chrome.storage.local.get(['pipelineStage'])).pipelineStage;
    if (!afterDrain?.active || !pipelineGenerationMatches(afterDrain, generation)) {
        console.warn('⏭ Amazon queue changed generation during screenshot drain');
        return false;
    }
    
    const prepared = await withAmazonAttemptMutation(async () => {
        const fresh = await chrome.storage.local.get([
            'pipelineRun', 'pipelineStage', 'multiAccountState'
        ]);
        if (!fresh.pipelineStage?.active
            || !pipelineGenerationMatches(fresh.pipelineStage, generation)
            || fresh.pipelineStage.stages?.[fresh.pipelineStage.currentIndex] !== 'amazon'
            || fresh.pipelineRun?.id !== generation?.runId) {
            return { status: 'stale' };
        }
        const multi = fresh.multiAccountState;
        const current = normalizeAccountEmail(multi?.currentAmazonAccount);
        if (current && !pipelineRunAccountIsTerminal(fresh.pipelineRun, 'amazon', current)) {
            // A duplicate completion/timeout caller arrived after this function
            // already prepared the next cabinet. Never shift that queue twice.
            return { status: 'already-prepared' };
        }
        const queue = Array.isArray(multi?.amazonAccountsQueue)
            ? [...multi.amazonAccountsQueue]
            : [];
        if (queue.length === 0) {
            await chrome.storage.local.set({
                lastAmazonProgressAt: null,
                accountSwitchStartedAt: null,
                skipGuardAt: null,
                amazonNavigationGraceUntil: null,
                amazonNavigationRecovery: null,
                amazonParsingIncomplete: null
            });
            return { status: 'finalize' };
        }

        const nextEmail = queue.shift();
        const startedAt = Date.now();
        await chrome.storage.local.set({
            pendingAccountSwitch: { email: nextEmail, runId: fresh.pipelineRun.id },
            amazonSwitchDispatch: {
                ...generation,
                account: nextEmail,
                tabId: null,
                kind: 'account-switch',
                phase: 'prepared',
                preparedAt: startedAt
            },
            amazonPaginationState: null,
            amazonParsingComplete: null,
            amazonNavigationGraceUntil: null,
            amazonNavigationRecovery: null,
            amazonParsingIncomplete: null,
            amazonTimeoutAttempt: null,
            accountSwitchStartedAt: startedAt,
            lastAmazonProgressAt: startedAt,
            multiAccountState: {
                isMultiAccountParsing: true,
                amazonAccountsQueue: queue,
                currentAmazonAccount: nextEmail
            }
        });
        return { status: 'prepared', nextEmail, queue };
    });

    if (prepared.status === 'stale' || prepared.status === 'already-prepared') return false;
    if (prepared.status === 'finalize') {
        console.log('📋 No more Amazon accounts to parse');
        await logMultiAccountStep('multi-account:complete', {});
        isMultiAccountParsing = false;
        currentAmazonAccount = null;
        try {
            const amazonEntries = Object.entries(parseReport.stores || {})
                .filter(([key]) => key.startsWith('amazon_'));
            const lines = amazonEntries.map(([key, value]) =>
                `  ${value.status || '•'} ${key.replace('amazon_', '')}: ${value.found ?? 0}`);
            console.log(lines.length
                ? `✅ Amazon мульти-прогон завершён:\n${lines.join('\n')}`
                : '✅ Amazon мульти-прогон завершён:\n  (ни один аккаунт не дал результата)');
        } catch (error) {
            console.warn('amazon summary build failed:', error?.message || error);
        }
        return beginAmazonStageFinalization(generation);
    }

    amazonAccountsQueue = prepared.queue;
    currentAmazonAccount = prepared.nextEmail;
    console.log(`🔄 Switching to Amazon account: ${prepared.nextEmail}`);
    await logMultiAccountStep('switchToNextAmazonAccount:start', { account: prepared.nextEmail });
    return dispatchCurrentAmazonAccountSwitch(prepared.nextEmail, generation, 'account-switch');
}

// === iHerb multi-account ===
// iHerb не имеет account picker как Amazon. Phase 1 (2026-04-16) findings:
//   - Dropdown "My Account" открывается ТОЛЬКО через CSS `:hover`. DOM-события
//     (dispatchEvent) НЕ триггерят :hover. Поэтому используем chrome.debugger +
//     Input.dispatchMouseEvent — real OS-level mouse events.
//   - `<header>` с dropdown живёт ТОЛЬКО на www.iherb.com (не на secure.iherb.com).
//   - 2-step login: #username-input → Continue → #password-input → Sign In
//     (checkout.iherb.com/auth/ui/account/login).
//   - Оба поля нуждаются в clear-перед-typing (LastPass autofill конкатенирует).
// Работаем в ОДНОМ табе (iherbParserTabId в storage). Не закрываем чужие табы.

const IHERB_DEBUGGER_VERSION = '1.3';
const IHERB_HOVER_HOLD_MS    = 2000;

// ─── Sequential pipeline state machine ──────────────────────────────────────
// Coordinates iHerb → eBay → Amazon as discrete stages. Thin layer: each
// multi-account shop drains its own queue internally; pipeline only triggers
// the NEXT shop after the previous one (including return) finishes.

let sequentialPipelineStartInFlight = null;
let pipelineAdvanceInFlight = null;

async function startSequentialPipeline() {
  if (sequentialPipelineStartInFlight) return sequentialPipelineStartInFlight;
  sequentialPipelineStartInFlight = startSequentialPipelineOnce();
  try {
    return await sequentialPipelineStartInFlight;
  } finally {
    sequentialPipelineStartInFlight = null;
  }
}

async function startSequentialPipelineOnce() {
  const existing = await chrome.storage.local.get([
    'pipelineStage', 'screenshotQueueBlocked', 'trackScreenshotQueue', 'pipelineRun'
  ]);
  if (existing.pipelineStage?.active) {
    console.warn('⏸ Sequential pipeline start refused: already active');
    return { started: false, reason: 'pipeline-already-active' };
  }
  const retainedQueue = Array.isArray(existing.trackScreenshotQueue)
    ? existing.trackScreenshotQueue
    : [];
  if (existing.screenshotQueueBlocked && retainedQueue.length > 0) {
    console.warn('⏸ Sequential pipeline start refused: account-bound screenshot queue is blocked');
    return { started: false, reason: 'screenshot-queue-blocked' };
  }
  if (existing.screenshotQueueBlocked && retainedQueue.length === 0) {
    await chrome.storage.local.remove(['screenshotQueueBlocked']);
  }
  if (!existing.pipelineRun?.id || existing.pipelineRun.status !== 'starting') {
    return { started: false, reason: 'pipeline-run-not-initialized' };
  }
  // Reset the legacy parallel-parse completion tracker and flip the flag that
  // gates handleProgressMessage's completion branch — otherwise eBay's
  // "Done ✅" will be ignored and we never advance from ebay → amazon.
  isParsingAllStores = true;
  storesCompleted = { ebay: false, iherb: false, amazon: false };
  // Чистим leftover iHerb/Amazon state от предыдущих прогонов — иначе stale
  // iherbFinalReturn=true блокирует парсинг (content-iherb.js выходит без
  // действий), а высокий iherbSwitchFailures счётчик срабатывает на первой же
  // неудаче → аккаунт скипается мгновенно.
  await chrome.storage.local.remove([
    'iherbFinalReturn',
    'iherbSwitchInProgress',
    'iherbSwitchStartedAt',
    'iherbSwitchFailures',
    'iherbOrdersReloadDone',
    'pendingIherbSwitch',
    'multiAccountIherbState',
    'iherbSwitchDispatch',
    'iherbStageFinalizing',
    'iherbFinalReturnConfirmed',
    'iherbParsedAccounts',
    'iherbRetryPassDone',
    'iherbSkipReasons',
    'screenshotStageBudget',
    'pendingAccountSwitch',
    'amazonFinalReturn',
    'amazonSwitchDispatch',
    'amazonStageFinalizing',
    'amazonFinalReturnConfirmed',
    'accountSwitchFailures',
    'amazonPaginationState',
    'amazonNavigationGraceUntil',
    'amazonNavigationRecovery',
    'amazonParsingIncomplete',
    'amazonTimeoutAttempt',
    'ebayStageDispatch',
    // Списки отменённых заказов — обнуляем на старте прогона, чтобы отчёт показывал
    // только отменённые ЭТОГО прогона (notifiedCancelledOrderIds НЕ трогаем — это
    // память «о чём уже сообщили оператору», должна пережить прогон).
    'iherbCancelledOrders',
    'ebayCancelledOrders',
    'amazonCancelledOrders',
    'amazonOrders',
    'ebayOrders',
    'iherbOrders'
  ]);
  const startedAt = Date.now();
  const stageStartedAt = startedAt;
  const runningRun = {
    ...existing.pipelineRun,
    status: 'running',
    startedAt,
    finishedAt: null
  };
  await chrome.storage.local.set({
    orderData: {},
    pipelineRun: runningRun,
    pipelineStage: {
      active: true,
      runId: existing.pipelineRun.id,
      stages: PIPELINE_STAGES,
      currentIndex: 0,
      startedAt,
      stageStartedAt,
      stageName: 'iherb'
    },
    screenshotStageBudget: {
      stageName: 'iherb',
      stageStartedAt,
      accruedMs: 0,
      activeSince: null
    },
    parsingState: { isParsingAllStores: true, storesCompleted },
    lastDailyAutoParseTriggeredAt: startedAt,
    lastDailyAutoParseStartedAt: startedAt,
    lastDailyAutoParseStatus: 'running'
  });
  console.log('🚀 Sequential pipeline started: iHerb → eBay → Amazon');
  await runPipelineStage('iherb', existing.pipelineRun.id);
  return { started: true, startedAt };
}

async function runPipelineStage(stageName, expectedRunId = null) {
  console.log(`🎬 runPipelineStage: ${stageName}`);
  if (expectedRunId) {
    const gate = await chrome.storage.local.get(['pipelineStage', 'pipelineRun']);
    if (gate.pipelineRun?.id !== expectedRunId
        || gate.pipelineStage?.runId !== expectedRunId
        || gate.pipelineStage?.stages?.[gate.pipelineStage.currentIndex] !== stageName) {
      console.warn(`⏭ Refusing stale stage start: ${stageName}`);
      return false;
    }
  }
  // Stamp when THIS stage started, so handlePipelineWatchdog can force-advance a stage
  // that hangs. eBay had no safety-net; a hung eBay froze the whole nightly run and the
  // Google Sheets upload with it (blackout from 2026-06-15).
  if (stageName !== 'done') {
    const st = await chrome.storage.local.get(['pipelineStage']);
    if (!st.pipelineStage?.stageStartedAt || st.pipelineStage.stageName !== stageName) {
      throw new Error(`pipeline stage ${stageName} was not atomically prepared`);
    }
  }
  if (stageName === 'iherb') {
    return startMultiAccountIherbParsing();
  }
  if (stageName === 'ebay') {
    return startEbayStageForPipeline();
  }
  if (stageName === 'amazon') {
    return startMultiAccountAmazonParsing();
  }
  if (stageName === 'done') {
    const current = await chrome.storage.local.get(['pipelineRun']);
    const finalRun = current.pipelineRun?.id === expectedRunId
        && ['completed', 'degraded'].includes(current.pipelineRun.status)
      ? current.pipelineRun
      : await finalizePipelineRun(expectedRunId);
    if (!finalRun) return false;
    return finishTerminalPipelineState(finalRun);
  }
}

async function finishTerminalPipelineState(finalRun) {
    if (!finalRun?.id || !['completed', 'degraded'].includes(finalRun.status)) return false;
    const state = await chrome.storage.local.get(['pipelineStage']);
    const stage = state.pipelineStage;
    if (stage?.runId !== finalRun.id
        || stage.stages?.[stage.currentIndex] !== 'done') {
      console.warn('⏭ Refusing terminal commit for a different pipeline generation');
      return false;
    }
    isParsingAllStores = false;
    // Legacy in-memory completion flags are not durable across a Manifest V3
    // worker restart. Reaching the generation-fenced terminal stage is the
    // durable proof that every shop stage has ended (successfully or degraded),
    // so reconstruct and persist the upload trigger from that proof.
    storesCompleted = { ebay: true, iherb: true, amazon: true };
    const finalStatus = finalRun.status === 'completed' ? 'completed' : 'degraded';
    await chrome.storage.local.set({
      pipelineStage: {
        ...stage,
        active: false,
        runId: finalRun.id,
        stageName: 'done',
        stageStartedAt: null
      },
      parsingState: { isParsingAllStores: false, storesCompleted },
      screenshotStageBudget: null,
      lastDailyAutoParseStatus: finalStatus,
      lastDailyAutoParseFinishedAt: finalRun?.finishedAt || Date.now()
    });
    console.log(`${finalStatus === 'completed' ? '✅' : '⚠️'} Sequential pipeline ${finalStatus}`);
    await checkAllStoresCompleted();
    return true;
}

// Blocks until the screenshot queue is fully drained AND processing is idle.
// processScreenshotQueue() has an `isProcessingScreenshots` re-entry guard —
// a bare `await processScreenshotQueue()` returns immediately if another caller
// is already draining, which would let the next stage start too early. This
// helper polls until both flags are clear, kicking off a drain itself if the
// queue has items but nobody is running.
async function waitForScreenshotsDrained(options = {}) {
  const requestedMaxWaitMs = typeof options === 'number'
    ? options
    : (Object.prototype.hasOwnProperty.call(options || {}, 'maxWaitMs')
        ? options.maxWaitMs
        : SCREENSHOT_DRAIN_MAX_WAIT_MS);
  // `null` used to mean infinity. A CAPTCHA or storage failure then held the
  // whole nightly pipeline forever. Every drain now has a real terminal bound.
  const maxWaitMs = Number.isFinite(requestedMaxWaitMs) && requestedMaxWaitMs >= 0
    ? requestedMaxWaitMs
    : SCREENSHOT_DRAIN_MAX_WAIT_MS;
  const start = Date.now();
  await screenshotQueueReady;
  // SW мог уснуть между queueTrackScreenshot и этим вызовом — in-memory очередь
  // тогда пуста, а в storage скрины ещё ждут. Без restore цикл ниже не стартует
  // и аккаунт переключится с недоснятыми скринами. Подтягиваем недостающие.
  while (true) {
    try {
      const settings = await chrome.storage.local.get([
        'screenshotsEnabled', 'trackScreenshotQueue', 'screenshotQueueBlocked'
      ]);
      screenshotsEnabled = settings.screenshotsEnabled || false;
      const storedQ = settings.trackScreenshotQueue || [];
      if (settings.screenshotQueueBlocked) {
        console.warn('⏸ Screenshot queue is quarantined:', settings.screenshotQueueBlocked);
        return false;
      }
      if (!screenshotsEnabled
          && !isProcessingScreenshots
          && (!Array.isArray(storedQ) || storedQ.length === 0)
          && trackScreenshotQueue.length === 0) {
        return true;
      }
      mergePersistedScreenshotQueue(storedQ);
      break;
    } catch (e) {
      if (Number.isFinite(maxWaitMs) && Date.now() - start > maxWaitMs) {
        console.warn('⏰ waitForScreenshotsDrained: storage restore timed out:', e?.message || e);
        return false;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  while (trackScreenshotQueue.length > 0 || isProcessingScreenshots) {
    if (Date.now() - start > maxWaitMs) {
      console.warn('⏰ waitForScreenshotsDrained: timed out with queue still pending');
      return false;
    }
    const blocked = await chrome.storage.local.get(['screenshotQueueBlocked']);
    if (blocked.screenshotQueueBlocked) return false;
    if (!isProcessingScreenshots && trackScreenshotQueue.length > 0) {
      processScreenshotQueue().catch(() => {});
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  // Финальный [] должен быть в storage ДО account/stage switch. Одной пустой
  // in-memory очереди недостаточно: MV3 может заснуть между этими действиями.
  await persistScreenshotQueue();
  const finalState = await chrome.storage.local.get('trackScreenshotQueue');
  const finalStored = Array.isArray(finalState.trackScreenshotQueue)
    ? finalState.trackScreenshotQueue
    : [];
  if (trackScreenshotQueue.length > 0 || isProcessingScreenshots || finalStored.length > 0) {
    // Новая карточка могла прийти между проверкой while и финальным commit.
    return waitForScreenshotsDrained({
      maxWaitMs: Math.max(0, maxWaitMs - (Date.now() - start))
    });
  }
  return true;
}

function pipelineGenerationFromStage(stage) {
  if (!stage) return null;
  return {
    runId: stage.runId,
    startedAt: stage.startedAt,
    currentIndex: stage.currentIndex,
    stageStartedAt: stage.stageStartedAt || null
  };
}

function pipelineGenerationMatches(stage, generation) {
  if (!generation) return true;
  return !!stage
    && stage.runId === generation.runId
    && stage.startedAt === generation.startedAt
    && stage.currentIndex === generation.currentIndex
    && (stage.stageStartedAt || null) === (generation.stageStartedAt || null);
}

function finalReturnConfirmationMatches(confirmation, finalizing) {
  return !!confirmation
    && !!finalizing
    && confirmation.runId === finalizing.runId
    && normalizeAccountEmail(confirmation.account)
      === normalizeAccountEmail(finalizing.account)
    && (!finalizing.tabId || confirmation.tabId === finalizing.tabId)
    && Number.isFinite(confirmation.confirmedAt);
}

function iherbFinalReturnStateMatches(state, senderTabId) {
  const stage = state?.pipelineStage;
  const generation = pipelineGenerationFromStage(stage);
  const marker = state?.iherbStageFinalizing;
  const pending = state?.pendingIherbSwitch;
  const dispatch = state?.iherbSwitchDispatch;
  const account = normalizeAccountEmail(marker?.account);
  return Number.isInteger(senderTabId)
    && ['starting', 'running'].includes(state?.pipelineRun?.status)
    && state.pipelineRun.id === generation?.runId
    && stage?.active === true
    && stage.stages?.[stage.currentIndex] === 'iherb'
    && state.iherbParserTabId === senderTabId
    && state.iherbFinalReturn === true
    && marker?.shop === 'iherb'
    && marker?.returnStatus === 'prepared'
    && marker?.tabId === senderTabId
    && pipelineGenerationMatches(marker, generation)
    && pending?.runId === generation.runId
    && normalizeAccountEmail(pending?.email) === account
    && dispatch?.kind === 'final-return'
    && dispatch?.tabId === senderTabId
    && pipelineGenerationMatches(dispatch, generation)
    && normalizeAccountEmail(dispatch?.account) === account;
}

function iherbFinalReturnLoginSubmitMatches(state, senderTabId, senderUrl) {
  let loginUrl;
  try {
    loginUrl = new URL(String(senderUrl || ''));
  } catch (_) {
    return false;
  }
  const exactLoginPage = (loginUrl.hostname === 'checkout.iherb.com'
      && /^\/auth\/ui\/account\/login(?:\/|$)/i.test(loginUrl.pathname))
    || (loginUrl.hostname === 'secure.iherb.com'
      && /^\/account\/sign-in(?:\/|$)/i.test(loginUrl.pathname));
  return loginUrl.protocol === 'https:'
    && exactLoginPage
    && iherbFinalReturnStateMatches(state, senderTabId)
    && ['dispatched', 'login-submitted'].includes(state.iherbSwitchDispatch?.phase);
}

function iherbFinalReturnLandingMatches(state, senderTabId, senderUrl) {
  let landingUrl;
  try {
    landingUrl = new URL(String(senderUrl || ''));
  } catch (_) {
    return false;
  }
  return landingUrl.protocol === 'https:'
    && landingUrl.hostname === 'secure.iherb.com'
    && /^\/myaccount\/orders(?:\/|$)/i.test(landingUrl.pathname)
    && iherbFinalReturnStateMatches(state, senderTabId)
    && state.iherbSwitchDispatch?.phase === 'login-submitted';
}

async function markIherbFinalReturnLoginSubmitted(senderTabId, senderUrl) {
  const keys = [
    'pipelineRun', 'pipelineStage', 'iherbParserTabId', 'iherbStageFinalizing',
    'pendingIherbSwitch', 'iherbSwitchDispatch', 'iherbFinalReturn'
  ];
  let state = await chrome.storage.local.get(keys);
  if (!iherbFinalReturnLoginSubmitMatches(state, senderTabId, senderUrl)) {
    return { accepted: false, reason: 'stale_or_foreign_login' };
  }
  if (state.iherbSwitchDispatch.phase === 'login-submitted') {
    return { accepted: true, duplicate: true };
  }
  state = await chrome.storage.local.get(keys);
  if (!iherbFinalReturnLoginSubmitMatches(state, senderTabId, senderUrl)
      || state.iherbSwitchDispatch.phase !== 'dispatched') {
    return { accepted: false, reason: 'login_generation_changed' };
  }
  await chrome.storage.local.set({
    iherbSwitchDispatch: {
      ...state.iherbSwitchDispatch,
      phase: 'login-submitted',
      loginSubmittedAt: Date.now()
    }
  });
  return { accepted: true };
}

async function confirmIherbFinalReturnLanding(senderTabId, senderUrl) {
  const keys = [
    'pipelineRun', 'pipelineStage', 'iherbParserTabId', 'iherbStageFinalizing',
    'pendingIherbSwitch', 'iherbSwitchDispatch', 'iherbFinalReturn'
  ];
  let state = await chrome.storage.local.get(keys);
  if (!iherbFinalReturnLandingMatches(state, senderTabId, senderUrl)) {
    return { confirmed: false, reason: 'stale_or_foreign_landing' };
  }
  // The login document is destroyed by the cross-document redirect to
  // /myaccount/orders. Confirm from the owned landing page, but reread the
  // exact generation immediately before the durable write so an old tab can
  // never confirm a later run/account.
  state = await chrome.storage.local.get(keys);
  if (!iherbFinalReturnLandingMatches(state, senderTabId, senderUrl)) {
    return { confirmed: false, reason: 'landing_generation_changed' };
  }
  const generation = pipelineGenerationFromStage(state.pipelineStage);
  await chrome.storage.local.set({
    iherbFinalReturnConfirmed: {
      ...generation,
      account: state.iherbStageFinalizing.account,
      tabId: senderTabId,
      confirmedAt: Date.now()
    }
  });
  return { confirmed: true };
}

async function stopPipelineForScreenshotDrain(reason = 'screenshot queue did not drain', expectedGeneration = null) {
  const state = await chrome.storage.local.get(['pipelineStage', 'screenshotQueueBlocked']);
  const p = state.pipelineStage;
  if (!p?.active || !pipelineGenerationMatches(p, expectedGeneration)) {
    console.warn('⏭ Refusing stale screenshot-drain stop');
    return false;
  }
  const stage = p?.stages?.[p.currentIndex] || p?.stageName || 'unknown';
  const detail = state.screenshotQueueBlocked || { reason, at: Date.now() };
  isParsingAllStores = false;
  if (stage === 'amazon') stopCompletionWatchdog();
  if (stage === 'amazon' || stage === 'iherb' || stage === 'ebay') setParserLock(stage, false);
  await chrome.storage.local.set({
    pipelineStage: p ? { ...p, active: false, blockedAt: Date.now(), blockedReason: reason } : null,
    parsingState: { isParsingAllStores: false, storesCompleted },
    lastDailyAutoParseStatus: 'blocked-screenshots',
    lastDailyAutoParseFinishedAt: Date.now(),
    lastDailyAutoParseError: String(reason).slice(0, 300),
    screenshotQueueBlocked: detail
  });
  await updatePipelineRun(run => run.id === p.runId ? ({
      ...run,
      status: 'blocked',
      finishedAt: Date.now(),
      failures: [...(run.failures || []), { shop: stage, account: '', reason, at: Date.now() }]
  }) : null);
  sendTelegramMessage(
    `❌ Ночной обход остановлен на ${stage}: очередь кадров не завершилась. Очередь сохранена, кабинет не переключаю.`
  ).catch(() => {});
  return false;
}

async function advancePipelineStage(expectedGeneration = null) {
  if (expectedGeneration) {
    const gate = await chrome.storage.local.get(['pipelineStage']);
    if (!gate.pipelineStage?.active
        || !pipelineGenerationMatches(gate.pipelineStage, expectedGeneration)) {
      console.warn('⏭ Refusing stale pipeline advance');
      return false;
    }
  }
  if (pipelineAdvanceInFlight) return pipelineAdvanceInFlight;
  pipelineAdvanceInFlight = advancePipelineStageOnce(expectedGeneration);
  try {
    return await pipelineAdvanceInFlight;
  } finally {
    pipelineAdvanceInFlight = null;
  }
}

async function advancePipelineStageOnce(expectedGeneration = null) {
  const r = await chrome.storage.local.get(['pipelineStage']);
  const p = r.pipelineStage;
  if (!p || !p.active) return;
  if (expectedGeneration && !pipelineGenerationMatches(p, expectedGeneration)) {
    console.warn('⏭ Refusing stale pipeline advance generation');
    return false;
  }
  const generation = {
    runId: p.runId,
    startedAt: p.startedAt,
    currentIndex: p.currentIndex,
    stageStartedAt: p.stageStartedAt || null
  };

  // DRAIN screenshot queue BEFORE starting next stage.
  // chrome.tabs.captureVisibleTab(windowId) captures whatever tab is currently active
  // in that window. If Amazon's switch_account navigation flips its tab to active
  // while eBay screenshots are still queued, captureVisibleTab photographs the
  // Switch-Accounts page instead of the order page (confirmed in Telegram log:
  // Amazon switch page was sent as an eBay "screenshot"). Draining here guarantees
  // the previous stage's screenshots finish before any new tab steals focus.
  if (screenshotsEnabled && (trackScreenshotQueue.length > 0 || isProcessingScreenshots)) {
    console.log(`⏸  Pipeline: waiting for screenshot queue to drain (${trackScreenshotQueue.length} queued, processing=${isProcessingScreenshots})`);
  }
  // Вызываем даже при пустой in-memory очереди: после MV3 restart persisted
  // карточки могут ещё не успеть восстановиться callback'ом и иначе stage сменится.
  const drained = await waitForScreenshotsDrained();
  const freshState = await chrome.storage.local.get(['pipelineStage']);
  const fresh = freshState.pipelineStage;
  const sameGeneration = !!fresh?.active
    && fresh.runId === generation.runId
    && fresh.startedAt === generation.startedAt
    && fresh.currentIndex === generation.currentIndex
    && (fresh.stageStartedAt || null) === generation.stageStartedAt;
  if (!sameGeneration) {
    console.warn('⏭ Pipeline advance ignored: stage generation changed during screenshot drain');
    return false;
  }
  if (!drained) {
    console.warn('⏸  Pipeline: screenshot queue is not drained; refusing to change stage');
    return stopPipelineForScreenshotDrain('stage screenshots blocked', generation);
  }
  if (screenshotsEnabled) console.log('▶  Pipeline: screenshot queue drained, advancing');

  const nextIndex = fresh.currentIndex + 1;
  if (nextIndex >= fresh.stages.length) {
    await chrome.storage.local.set({ pipelineStage: { ...fresh, active: false, currentIndex: fresh.stages.length - 1 } });
    return;
  }
  const nextStage = fresh.stages[nextIndex];
  const nextStageStartedAt = Date.now();
  await chrome.storage.local.set({
    pipelineStage: {
      ...fresh,
      currentIndex: nextIndex,
      stageStartedAt: nextStageStartedAt,
      stageName: nextStage
    },
    screenshotStageBudget: nextStage === 'done' ? null : {
      stageName: nextStage,
      stageStartedAt: nextStageStartedAt,
      accruedMs: 0,
      activeSince: null
    },
    iherbSwitchDispatch: null,
    iherbStageFinalizing: null,
    iherbFinalReturnConfirmed: null,
    pendingIherbSwitch: null,
    iherbFinalReturn: null,
    iherbSwitchInProgress: null,
    iherbSwitchStartedAt: null,
    iherbParseAttemptId: null,
    iherbTimeoutAttempt: null,
    iherbParsingComplete: null,
    amazonSwitchDispatch: null,
    amazonStageFinalizing: null,
    amazonFinalReturnConfirmed: null,
    pendingAccountSwitch: null,
    amazonFinalReturn: null,
    accountSwitchInProgress: null,
    switchedToEmail: null,
    accountSwitchStartedAt: null,
    ebayStageDispatch: null
  });
  await runPipelineStage(nextStage, fresh.runId);
  return true;
}

async function getEbayParserTab(tabId) {
  if (!tabId) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url === 'about:blank') return tab;
    const url = new URL(tab?.url || '');
    if (/(^|\.)ebay\.com$/i.test(url.hostname)
        && /\/mye\/myebay\/purchase/i.test(url.pathname)) return tab;
  } catch (_) {}
  return null;
}

async function startEbayStageForPipeline(expectedGeneration = null) {
  const prepared = await chrome.storage.local.get([
    'pipelineRun', 'pipelineStage', 'ebayParserTabId'
  ]);
  const generation = expectedGeneration || pipelineGenerationFromStage(prepared.pipelineStage);
  if (!prepared.pipelineStage?.active
      || !pipelineGenerationMatches(prepared.pipelineStage, generation)
      || prepared.pipelineRun?.id !== generation?.runId
      || prepared.pipelineStage.stages?.[prepared.pipelineStage.currentIndex] !== 'ebay') {
    console.warn('⏭ Refusing stale eBay stage dispatch');
    return false;
  }
  // content-ebay.js checkAutoParse требует autoParsePending='ebay' + свежий
  // autoParseTimestamp (<120s). Без этого он молча скипнет парсинг.
  await chrome.storage.local.set({
    autoParsePending: 'ebay',
    autoParseTimestamp: Date.now(),
    ebay_should_autoparse: true,
    ebayStageDispatch: null
  });
  const url = 'https://www.ebay.com/mye/myebay/purchase';
  let tab = await getEbayParserTab(prepared.ebayParserTabId);
  if (!tab) {
    // Establish ownership before navigation so a content script can never load
    // in an unowned tab and consume the global auto-parse intent.
    tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    if (!tab?.id) throw new Error('failed to create owned eBay parser tab');
    await chrome.storage.local.set({ ebayParserTabId: tab.id });
  }
  await chrome.tabs.update(tab.id, { url, active: true });

  const fresh = await chrome.storage.local.get(['pipelineStage', 'ebayParserTabId']);
  if (!fresh.pipelineStage?.active
      || !pipelineGenerationMatches(fresh.pipelineStage, generation)
      || fresh.ebayParserTabId !== tab.id) {
    console.warn('⏭ eBay dispatch completed after pipeline generation changed');
    return false;
  }
  await chrome.storage.local.set({
    ebayStageDispatch: {
      ...generation,
      tabId: tab.id,
      phase: 'dispatched',
      dispatchedAt: Date.now()
    }
  });
  return true;
}

async function startMultiAccountIherbParsing() {
    console.log('🚀 startMultiAccountIherbParsing called');

    const cfg = await loadAccountsConfig();
    // accountsConfig.iherb уже в нужном порядке: primary первый, secondary последний.
    iherbAccountsQueue = cfg.iherb.slice();
    isMultiAccountIherb = true;
    currentIherbAccount = null;

    await chrome.storage.local.set({
        multiAccountIherbState: {
            isMultiAccountIherb: true,
            iherbAccountsQueue,
            currentIherbAccount: null,
            // Зеркалим per-run учёт в snapshot restore (top-level ключи — канон).
            iherbParsedAccounts: [],
            iherbRetryPassDone: false,
            iherbSkipReasons: {}
        },
        iherbFinalReturn: null,
        iherbFinalReturnConfirmed: null,
        iherbStageFinalizing: null,
        iherbSwitchDispatch: null,
        pendingIherbSwitch: null,
        iherbParseAttemptId: null,
        iherbTimeoutAttempt: null,
        iherbParsingComplete: null,
        // Per-run учёт аккаунтов: кто реально отпарсился / был ли retry-проход /
        // причины пропуска. Стартуем прогон с чистого листа.
        iherbParsedAccounts: [],
        iherbRetryPassDone: false,
        iherbSkipReasons: {}
    });
    await chrome.storage.local.remove([
        'pendingIherbSwitch',
        'iherbFinalReturn',
        'iherbSwitchInProgress',
        'iherbSwitchStartedAt',
        'iherbOrdersReloadDone'
    ]);

    setParserLock('iherb', true);
    sendTelegramMessage(`🌿 iHerb мульти-аккаунт: ${cfg.iherb.map(a => a.email.split('@')[0]).join(', ')}`).catch(() => {});

    // Находим существующий iherb-таб или создаём один. НЕ закрываем чужие табы.
    const existingTab = await chrome.storage.local.get(['iherbParserTabId']);
    const tabId = await ensureValidIherbParserTab(existingTab.iherbParserTabId);
    await chrome.storage.local.set({ iherbParserTabId: tabId });

    await switchToNextIherbAccount();
}

function dispatchCurrentIherbAccountSwitch(email, expectedGeneration) {
    const key = pipelineOperationKey(expectedGeneration, normalizeAccountEmail(email));
    return runParserOperationSingleFlight('iherb-account-dispatch', key, () =>
        dispatchCurrentIherbAccountSwitchOnce(email, expectedGeneration));
}

async function dispatchCurrentIherbAccountSwitchOnce(email, expectedGeneration) {
    const readDispatchState = () => chrome.storage.local.get([
        'pipelineRun', 'pipelineStage', 'multiAccountIherbState',
        'pendingIherbSwitch', 'iherbParserTabId', 'iherbSwitchDispatch'
    ]);
    const ownsDispatch = state => !!expectedGeneration
        && state.pipelineStage?.active === true
        && pipelineGenerationMatches(state.pipelineStage, expectedGeneration)
        && state.pipelineStage.stages?.[state.pipelineStage.currentIndex] === 'iherb'
        && state.pipelineRun?.id === expectedGeneration.runId
        && state.pendingIherbSwitch?.runId === expectedGeneration.runId
        && normalizeAccountEmail(state.pendingIherbSwitch?.email) === normalizeAccountEmail(email)
        && normalizeAccountEmail(state.multiAccountIherbState?.currentIherbAccount)
            === normalizeAccountEmail(email);
    const state = await readDispatchState();
    if (!ownsDispatch(state)) {
        console.warn('⏭ Refusing stale iHerb account dispatch');
        return false;
    }

    const tabId = await ensureValidIherbParserTab(state.iherbParserTabId);
    const afterTab = await readDispatchState();
    if (!ownsDispatch(afterTab)) {
        console.warn('⏭ iHerb generation changed while resolving parser tab');
        return false;
    }
    await chrome.storage.local.set({
        iherbParserTabId: tabId,
        iherbSwitchDispatch: {
            ...expectedGeneration,
            account: email,
            tabId,
            phase: 'prepared',
            preparedAt: Date.now()
        }
    });
    const beforeNavigation = await readDispatchState();
    if (!ownsDispatch(beforeNavigation)
        || !pipelineGenerationMatches(beforeNavigation.iherbSwitchDispatch, expectedGeneration)
        || normalizeAccountEmail(beforeNavigation.iherbSwitchDispatch?.account)
            !== normalizeAccountEmail(email)
        || beforeNavigation.iherbSwitchDispatch?.tabId !== tabId
        || beforeNavigation.iherbSwitchDispatch?.phase !== 'prepared') {
        console.warn('⏭ iHerb generation changed before account navigation');
        return false;
    }

    try {
        await iherbUiSignOutAndNavigateToLogin(tabId);
    } catch (error) {
        console.error('❌ iHerb UI sign-out flow failed:', error);
        await handleIherbSwitchFailure(
            email,
            'ui_signout_failed',
            expectedGeneration.runId
        );
        return false;
    }

    const fresh = await readDispatchState();
    if (!ownsDispatch(fresh)
        || !pipelineGenerationMatches(fresh.iherbSwitchDispatch, expectedGeneration)
        || normalizeAccountEmail(fresh.iherbSwitchDispatch?.account)
            !== normalizeAccountEmail(email)
        || fresh.iherbSwitchDispatch?.tabId !== tabId
        || fresh.iherbSwitchDispatch?.phase !== 'prepared') {
        console.warn('⏭ iHerb dispatch completed after pipeline generation changed');
        return false;
    }
    await chrome.storage.local.set({
        iherbSwitchDispatch: {
            ...expectedGeneration,
            account: email,
            tabId,
            phase: 'dispatched',
            dispatchedAt: Date.now()
        }
    });
    return true;
}

let iherbAccountTransitionChain = Promise.resolve();

function switchToNextIherbAccount(expectedGeneration = null) {
    const task = iherbAccountTransitionChain
        .catch(() => {})
        .then(() => switchToNextIherbAccountOnce(expectedGeneration));
    iherbAccountTransitionChain = task.catch(() => {});
    return task;
}

async function switchToNextIherbAccountOnce(expectedGeneration = null) {
    // Restore state (SW restart)
    const stored = await chrome.storage.local.get([
        'multiAccountIherbState', 'iherbParserTabId', 'pipelineRun', 'pipelineStage'
    ]);
    const generation = expectedGeneration || pipelineGenerationFromStage(stored.pipelineStage);
    if (!stored.pipelineStage?.active
        || !pipelineGenerationMatches(stored.pipelineStage, generation)
        || stored.pipelineStage.stages?.[stored.pipelineStage.currentIndex] !== 'iherb'
        || stored.pipelineRun?.id !== generation?.runId) {
        console.warn('⏭ Refusing stale iHerb queue mutation');
        return false;
    }
    if (stored.multiAccountIherbState) {
        isMultiAccountIherb = stored.multiAccountIherbState.isMultiAccountIherb;
        iherbAccountsQueue  = stored.multiAccountIherbState.iherbAccountsQueue || [];
        currentIherbAccount = stored.multiAccountIherbState.currentIherbAccount;
    }
    if (currentIherbAccount
        && !pipelineRunAccountIsTerminal(
            stored.pipelineRun,
            'iherb',
            currentIherbAccount
        )) {
        console.warn('⏭ Refusing duplicate iHerb queue shift: current account is not terminal');
        return false;
    }

    // Единый safety gate для ВСЕХ путей (обычный Done, watchdog, login retry):
    // карточки текущего iHerb-кабинета нельзя открывать после смены аккаунта.
    if (currentIherbAccount) {
        if (!await waitForScreenshotsDrained()) {
            return stopPipelineForScreenshotDrain(
                'iHerb account screenshots blocked',
                generation
            );
        }
    }

    const prepared = await withIherbAttemptMutation(async () => {
        const fresh = await chrome.storage.local.get([
            'pipelineRun', 'pipelineStage', 'multiAccountIherbState', 'iherbParserTabId'
        ]);
        if (!fresh.pipelineStage?.active
            || !pipelineGenerationMatches(fresh.pipelineStage, generation)
            || fresh.pipelineStage.stages?.[fresh.pipelineStage.currentIndex] !== 'iherb'
            || fresh.pipelineRun?.id !== generation?.runId) {
            return { status: 'stale' };
        }
        const multi = fresh.multiAccountIherbState;
        const current = normalizeAccountEmail(multi?.currentIherbAccount);
        if (current && !pipelineRunAccountIsTerminal(fresh.pipelineRun, 'iherb', current)) {
            return { status: 'already-prepared' };
        }
        const queue = Array.isArray(multi?.iherbAccountsQueue)
            ? [...multi.iherbAccountsQueue]
            : [];
        if (queue.length === 0) return { status: 'finalize' };

        const next = queue.shift();
        const startedAt = Date.now();
        const parseAttemptId = `${fresh.pipelineRun.id}:${normalizeAccountEmail(next.email)}:${startedAt}:${Math.random().toString(36).slice(2, 8)}`;
        await chrome.storage.local.set({
            pendingIherbSwitch: { email: next.email, password: next.password, runId: fresh.pipelineRun.id },
            iherbSwitchInProgress: true,
            // The previous account's outcome and timeout cannot survive into the
            // new cabinet. This transition shares the exact-attempt arbiter with
            // content commits, so an acknowledged old Done can never land after
            // the new owner is installed.
            iherbParseStartedAt: null,
            iherbWatchdogRetried: null,
            iherbParseAttemptId: parseAttemptId,
            iherbTimeoutAttempt: null,
            iherbParsingComplete: null,
            iherbPressHoldAttempts: null,
            iherbOrdersReloadDone: null,
            iherbSignInRetries: null,
            iherbSwitchStartedAt: startedAt,
            iherbFinalReturn: null,
            iherbSwitchDispatch: {
                ...generation,
                account: next.email,
                tabId: fresh.iherbParserTabId || null,
                phase: 'prepared',
                preparedAt: startedAt
            },
            multiAccountIherbState: {
                isMultiAccountIherb: true,
                iherbAccountsQueue: queue,
                currentIherbAccount: next.email
            }
        });
        return { status: 'prepared', next, queue };
    });

    if (prepared.status === 'stale' || prepared.status === 'already-prepared') {
        console.warn('⏭ iHerb queue changed while preparing the next cabinet');
        return false;
    }
    if (prepared.status === 'finalize') {
        console.log('📋 No more iHerb accounts — finalize');
        return finalizeIherbStage(undefined, { expectedGeneration: generation });
    }

    const next = prepared.next;
    iherbAccountsQueue = prepared.queue;
    currentIherbAccount = next.email;

    console.log(`🔄 Switching to iHerb account: ${next.email}`);

    // Never infer primary identity from "someone is logged in".  The browser
    // may have been left on either secondary account.  Exact sign-out + login
    // is required for every cabinet, including the first/primary one.
    return dispatchCurrentIherbAccountSwitch(next.email, generation);
}

// Проверяет что на iHerb кто-то залогинен (logoff link присутствует в DOM).
// iHerb прячет email в HttpOnly-куках — JS не может прочитать какой именно
// аккаунт залогинен без fetch к пользовательскому API. Для multi-account мы
// ДОВЕРЯЕМ что primary-аккаунт (photopochtoy) — это тот аккаунт, в котором
// оператор обычно сидит. Если это не так, content-iherb.js может проверить
// при парсинге (отдельная проблема вне scope).
async function iherbIsLoggedIn(tabId) {
    try {
        const tabInfo = await chrome.tabs.get(tabId);
        if (!/^https?:\/\/(www|secure)\.iherb\.com\//i.test(tabInfo.url || '')) return false;
        const [res] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => !!document.querySelector('a[href*="logoff"]')
        });
        return !!res?.result;
    } catch (e) {
        console.warn('iherbIsLoggedIn failed:', e?.message || String(e));
        return false;
    }
}

// Общий обработчик сбоев iHerb-свитча (retry или skip).
// Вызывается из catch-а UI sign-out flow и из message listener (iherbSwitchFailed
// от content-iherb-login.js).
async function handleIherbSwitchFailure(email, reason, requestedRunId = null) {
    const failData = await chrome.storage.local.get([
        'iherbSwitchFailures', 'pipelineRun', 'pipelineStage', 'multiAccountIherbState'
    ]);
    const runId = requestedRunId || failData.pipelineRun?.id || null;
    const generation = pipelineGenerationFromStage(failData.pipelineStage);
    if (!runId
        || failData.pipelineRun?.id !== runId
        || !['starting', 'running'].includes(failData.pipelineRun?.status)
        || failData.pipelineStage?.runId !== runId
        || failData.pipelineStage?.stages?.[failData.pipelineStage?.currentIndex] !== 'iherb'
        || normalizeAccountEmail(failData.multiAccountIherbState?.currentIherbAccount) !== normalizeAccountEmail(email)) {
        console.warn('⏭ Ignoring stale iHerb switch failure');
        return false;
    }
    if (failData.multiAccountIherbState) {
        isMultiAccountIherb = failData.multiAccountIherbState.isMultiAccountIherb;
        iherbAccountsQueue = failData.multiAccountIherbState.iherbAccountsQueue || [];
        currentIherbAccount = failData.multiAccountIherbState.currentIherbAccount;
    }
    const failures = failData.iherbSwitchFailures || {};
    failures[email] = (failures[email] || 0) + 1;
    await chrome.storage.local.set({ iherbSwitchFailures: failures });

    const MAX_IH_ATTEMPTS = 2;
    if (failures[email] < MAX_IH_ATTEMPTS && reason !== 'captcha') {
        console.log(`🔁 Retry iHerb switch for ${email} (attempt ${failures[email] + 1}/${MAX_IH_ATTEMPTS})`);
        const cfg = await loadAccountsConfig();
        const retryGate = await chrome.storage.local.get([
            'pipelineRun', 'pipelineStage', 'multiAccountIherbState'
        ]);
        if (retryGate.pipelineRun?.id !== runId
            || !retryGate.pipelineStage?.active
            || !pipelineGenerationMatches(retryGate.pipelineStage, generation)
            || retryGate.pipelineStage.stages?.[retryGate.pipelineStage.currentIndex] !== 'iherb'
            || normalizeAccountEmail(retryGate.multiAccountIherbState?.currentIherbAccount)
                !== normalizeAccountEmail(email)) return false;
        const creds = cfg.iherb.find(a => a.email === email);
        if (creds) iherbAccountsQueue.unshift(creds);
        currentIherbAccount = null;
        await chrome.storage.local.set({
            multiAccountIherbState: {
                isMultiAccountIherb: true,
                iherbAccountsQueue,
                currentIherbAccount: null
            }
        });
        await new Promise(r => setTimeout(r, 5000));
        await switchToNextIherbAccount(generation);
    } else {
        console.log(`🚫 iHerb ${email} skipped (failures=${failures[email]}, reason=${reason})`);
        sendTelegramMessage(`🚫 iHerb ${email.split('@')[0]} пропущен (${reason})`).catch(() => {});
        await recordIherbSkipReason(email, 'switch_failed', runId);
        const skipGate = await chrome.storage.local.get([
            'pipelineRun', 'pipelineStage', 'multiAccountIherbState'
        ]);
        if (skipGate.pipelineRun?.id !== runId
            || !skipGate.pipelineStage?.active
            || !pipelineGenerationMatches(skipGate.pipelineStage, generation)
            || skipGate.pipelineStage.stages?.[skipGate.pipelineStage.currentIndex] !== 'iherb'
            || normalizeAccountEmail(skipGate.multiAccountIherbState?.currentIherbAccount)
                !== normalizeAccountEmail(email)) return false;
        await chrome.storage.local.remove(['iherbSwitchInProgress', 'iherbSwitchStartedAt', 'pendingIherbSwitch']);
        if (iherbAccountsQueue.length > 0) await switchToNextIherbAccount(generation);
        else await finalizeIherbStage(undefined, { expectedGeneration: generation });
    }
    return true;
}

let iherbAttemptMutationChain = Promise.resolve();

function withIherbAttemptMutation(work) {
    const task = iherbAttemptMutationChain
        .catch(() => {})
        .then(work);
    iherbAttemptMutationChain = task.catch(() => {});
    return task;
}

function iherbAttemptRefFromState(state) {
    return {
        runId: state?.pipelineRun?.id || null,
        stageStartedAt: state?.pipelineStage?.stageStartedAt || null,
        account: normalizeAccountEmail(state?.multiAccountIherbState?.currentIherbAccount),
        parserTabId: state?.iherbParserTabId || null,
        attemptId: state?.iherbParseAttemptId || null
    };
}

function iherbAttemptIdentityMatches(left, right) {
    return !!left?.runId
        && !!left?.attemptId
        && left.runId === right?.runId
        && left.stageStartedAt === right?.stageStartedAt
        && normalizeAccountEmail(left.account) === normalizeAccountEmail(right?.account)
        && left.parserTabId === right?.parserTabId
        && left.attemptId === right?.attemptId;
}

function iherbAttemptMatchesRuntime(attempt, state, senderTabId = null) {
    const current = iherbAttemptRefFromState(state);
    return !!attempt?.runId
        && !!attempt?.account
        && !!attempt?.parserTabId
        && !!attempt?.attemptId
        && (senderTabId == null || senderTabId === attempt.parserTabId)
        && state?.pipelineStage?.active === true
        && state.pipelineStage.runId === attempt.runId
        && state.pipelineStage.stages?.[state.pipelineStage.currentIndex] === 'iherb'
        && ['starting', 'running'].includes(state?.pipelineRun?.status)
        && state.pipelineRun.id === attempt.runId
        && !pipelineGenerationMatches(
            state.iherbStageFinalizing,
            pipelineGenerationFromStage(state.pipelineStage)
        )
        && iherbAttemptIdentityMatches(current, attempt);
}

function iherbTimeoutAttemptMatchesRuntime(marker, state) {
    return !!marker
        && iherbAttemptMatchesRuntime(marker, state)
        && iherbAttemptIdentityMatches(marker, iherbAttemptRefFromState(state));
}

async function handleIherbAttemptCommit(request, senderTabId) {
    return withIherbAttemptMutation(async () => {
        const attempt = {
            runId: request.attempt?.runId || null,
            stageStartedAt: request.attempt?.stageStartedAt || null,
            account: normalizeAccountEmail(request.attempt?.account),
            parserTabId: request.attempt?.parserTabId || null,
            attemptId: request.attempt?.attemptId || null
        };
        const state = await chrome.storage.local.get([
            'pipelineRun', 'pipelineStage', 'multiAccountIherbState',
            'iherbParserTabId', 'iherbParseAttemptId', 'iherbTimeoutAttempt',
            'iherbStageFinalizing', 'orderData', 'iherbCancelledOrders'
        ]);
        if (!iherbAttemptMatchesRuntime(attempt, state, senderTabId)) {
            return { ok: false, status: 'stale', reason: 'run-account-attempt-changed' };
        }
        if (iherbTimeoutAttemptMatchesRuntime(state.iherbTimeoutAttempt, state)) {
            return { ok: false, status: 'stale', reason: 'timeout-won' };
        }
        const incomingOrders = (Array.isArray(request.orders) ? request.orders : []).map(order => ({
            ...structuredClone(order),
            parser_run_id: attempt.runId,
            parser_account: attempt.account,
            observed_at: new Date().toISOString()
        }));
        if (!incomingOrders.length) {
            return { ok: false, status: 'invalid', reason: 'empty-iherb-result' };
        }
        const orderData = state.orderData && typeof state.orderData === 'object'
            ? structuredClone(state.orderData)
            : {};
        const existingOrders = Array.isArray(orderData.iHerb?.orders)
            ? orderData.iHerb.orders
            : [];
        const byKey = new Map();
        for (const order of existingOrders) {
            byKey.set(`${order?.order_id || ''}_${order?.product_name || ''}`, order);
        }
        let addedCount = 0;
        let updatedCount = 0;
        for (const order of incomingOrders) {
            const key = `${order?.order_id || ''}_${order?.product_name || ''}`;
            if (byKey.has(key)) updatedCount++;
            else addedCount++;
            byKey.set(key, order);
        }
        const mergedOrders = [...byKey.values()];
        const uniqueOrderIds = new Set(mergedOrders.map(order => order?.order_id).filter(Boolean));
        orderData.iHerb = {
            orders: mergedOrders,
            lastParsed: new Date().toISOString(),
            uniqueOrdersCount: uniqueOrderIds.size,
            totalProductsCount: mergedOrders.length
        };

        const cancelledSeen = new Set();
        const cancelledOrders = [
            ...(Array.isArray(state.iherbCancelledOrders) ? state.iherbCancelledOrders : []),
            ...(Array.isArray(request.cancelledOrders) ? request.cancelledOrders : [])
        ].map(item => structuredClone(item)).filter(order => {
            const key = order?.order_id;
            if (!key || cancelledSeen.has(key)) return false;
            cancelledSeen.add(key);
            return true;
        });
        const completion = {
            ...attempt,
            timestamp: Date.now(),
            found: Number(request.found) || incomingOrders.length
        };
        await chrome.storage.local.set({
            orderData,
            iherbOrders: incomingOrders,
            iherbLastUpdate: Date.now(),
            iherbCancelledOrders: cancelledOrders,
            iherbCancelledUpdatedAt: Date.now(),
            iherbParsingComplete: completion
        });
        return {
            ok: true,
            status: 'committed',
            addedCount,
            updatedCount,
            totalCount: mergedOrders.length,
            uniqueOrdersCount: uniqueOrderIds.size
        };
    });
}

async function commitIherbTimeoutOutcome(attempt, reason = 'parse_timeout') {
    return withIherbAttemptMutation(() => withPipelineRunWrite(async () => {
        const state = await chrome.storage.local.get([
            'pipelineRun', 'pipelineStage', 'multiAccountIherbState',
            'iherbParserTabId', 'iherbParseAttemptId', 'iherbTimeoutAttempt',
            'iherbParsingComplete', 'iherbStageFinalizing',
            'iherbParsedAccounts', 'iherbSkipReasons'
        ]);
        if (!iherbAttemptMatchesRuntime(attempt, state)) return { status: 'stale' };
        if (iherbAttemptIdentityMatches(state.iherbParsingComplete, attempt)) {
            return { status: 'completion-won' };
        }
        const nextRun = applyPipelineAccountResult(
            state.pipelineRun,
            'iherb',
            attempt.account,
            { runId: attempt.runId, ok: false, reason }
        );
        if (!nextRun) return { status: 'stale' };
        const marker = {
            ...attempt,
            phase: 'failed',
            reason,
            resolvedAt: Date.now()
        };
        const parsed = (Array.isArray(state.iherbParsedAccounts)
            ? state.iherbParsedAccounts
            : []).filter(item => normalizeAccountEmail(item) !== attempt.account);
        const skipReasons = state.iherbSkipReasons && typeof state.iherbSkipReasons === 'object'
            ? { ...state.iherbSkipReasons, [attempt.account]: reason }
            : { [attempt.account]: reason };
        await chrome.storage.local.set({
            pipelineRun: nextRun,
            iherbTimeoutAttempt: marker,
            iherbParsedAccounts: parsed,
            iherbSkipReasons: skipReasons,
            iherbParseStartedAt: null,
            iherbWatchdogRetried: null
        });
        return {
            status: 'failed',
            marker,
            multiAccountIherbState: state.multiAccountIherbState,
            pipelineStage: state.pipelineStage
        };
    }));
}

async function consumeIherbCompletionMarker(expectedGeneration) {
    const claimed = await withIherbAttemptMutation(() => withPipelineRunWrite(async () => {
        const state = await chrome.storage.local.get([
            'pipelineRun', 'pipelineStage', 'multiAccountIherbState',
            'iherbParserTabId', 'iherbParseAttemptId', 'iherbTimeoutAttempt',
            'iherbParsingComplete', 'iherbStageFinalizing',
            'iherbParsedAccounts', 'iherbSkipReasons'
        ]);
        const marker = state.iherbParsingComplete;
        if (!marker
            || !pipelineGenerationMatches(state.pipelineStage, expectedGeneration)
            || !iherbAttemptMatchesRuntime(marker, state)) {
            return { claimed: false };
        }
        const parsed = Array.isArray(state.iherbParsedAccounts)
            ? [...state.iherbParsedAccounts]
            : [];
        if (!parsed.some(item => normalizeAccountEmail(item) === marker.account)) {
            parsed.push(marker.account);
        }
        const skipReasons = state.iherbSkipReasons && typeof state.iherbSkipReasons === 'object'
            ? { ...state.iherbSkipReasons }
            : {};
        delete skipReasons[marker.account];
        const nextRun = applyPipelineAccountResult(
            state.pipelineRun,
            'iherb',
            marker.account,
            { runId: marker.runId, ok: true, found: marker.found || 0 }
        );
        if (!nextRun) return { claimed: false };
        await chrome.storage.local.set({
            pipelineRun: nextRun,
            iherbParsedAccounts: parsed,
            iherbSkipReasons: skipReasons,
            iherbParsingComplete: null,
            iherbTimeoutAttempt: null,
            iherbParseStartedAt: null,
            iherbWatchdogRetried: null
        });
        return {
            claimed: true,
            marker,
            multiAccountIherbState: state.multiAccountIherbState,
            pipelineStage: state.pipelineStage
        };
    }));
    if (!claimed.claimed) return false;

    isMultiAccountIherb = !!claimed.multiAccountIherbState?.isMultiAccountIherb;
    iherbAccountsQueue = claimed.multiAccountIherbState?.iherbAccountsQueue || [];
    currentIherbAccount = claimed.multiAccountIherbState?.currentIherbAccount || null;
    parseReport.stores[`iherb_${String(currentIherbAccount || '').split('@')[0]}`] = {
        found: claimed.marker.found || 0,
        status: '✅'
    };
    if (!await waitForScreenshotsDrained()) {
        return stopPipelineForScreenshotDrain(
            'iHerb account screenshots blocked',
            expectedGeneration
        );
    }
    const gate = (await chrome.storage.local.get(['pipelineStage'])).pipelineStage;
    if (!gate?.active || !pipelineGenerationMatches(gate, expectedGeneration)) return false;
    if (isMultiAccountIherb && iherbAccountsQueue.length > 0) {
        return switchToNextIherbAccount(expectedGeneration);
    }
    if (isMultiAccountIherb) {
        return finalizeIherbStage(undefined, { expectedGeneration });
    }
    return true;
}

// ─── Per-run iHerb account accounting helpers ──────────────────────────────
// Записывает аккаунт, который РЕАЛЬНО отпарсился (дал parseReport-запись) в этом
// прогоне. Dedupe. Персист top-level — chrome.storage.local переживает рестарт SW.
async function recordIherbParsedAccount(email, runId, attemptId) {
    if (!email || !runId || !attemptId) return [];
    const r = await chrome.storage.local.get([
        'iherbParsedAccounts', 'pipelineRun', 'pipelineStage', 'multiAccountIherbState',
        'iherbParserTabId', 'iherbParseAttemptId', 'iherbTimeoutAttempt',
        'iherbStageFinalizing'
    ]);
    if (r.pipelineRun?.id !== runId
        || !['starting', 'running'].includes(r.pipelineRun?.status)
        || r.pipelineStage?.runId !== runId
        || r.pipelineStage?.stages?.[r.pipelineStage?.currentIndex] !== 'iherb'
        || normalizeAccountEmail(r.multiAccountIherbState?.currentIherbAccount) !== normalizeAccountEmail(email)
        || r.iherbParseAttemptId !== attemptId
        || iherbTimeoutAttemptMatchesRuntime(r.iherbTimeoutAttempt, r)) {
        console.warn('⏭ Refusing stale iHerb success accounting');
        return Array.isArray(r.iherbParsedAccounts) ? r.iherbParsedAccounts : [];
    }
    const arr = Array.isArray(r.iherbParsedAccounts) ? r.iherbParsedAccounts : [];
    if (!arr.includes(email)) arr.push(email);
    await chrome.storage.local.set({ iherbParsedAccounts: arr });
    await markPipelineAccountResult('iherb', email, { runId, ok: true });
    return arr;
}

// Записывает причину, по которой аккаунт НЕ отпарсился: 'captcha' | 'switch_failed'.
async function recordIherbSkipReason(email, reason, runId) {
    if (!email || !runId) return {};
    const r = await chrome.storage.local.get([
        'iherbSkipReasons', 'pipelineRun', 'pipelineStage', 'multiAccountIherbState'
    ]);
    if (r.pipelineRun?.id !== runId
        || !['starting', 'running'].includes(r.pipelineRun?.status)
        || r.pipelineStage?.runId !== runId
        || r.pipelineStage?.stages?.[r.pipelineStage?.currentIndex] !== 'iherb'
        || normalizeAccountEmail(r.multiAccountIherbState?.currentIherbAccount) !== normalizeAccountEmail(email)) {
        console.warn('⏭ Refusing stale iHerb failure accounting');
        return (r.iherbSkipReasons && typeof r.iherbSkipReasons === 'object') ? r.iherbSkipReasons : {};
    }
    const map = (r.iherbSkipReasons && typeof r.iherbSkipReasons === 'object') ? r.iherbSkipReasons : {};
    map[email] = reason;
    await chrome.storage.local.set({ iherbSkipReasons: map });
    await markPipelineAccountResult('iherb', email, { runId, ok: false, reason });
    return map;
}

// ─── ЕДИНЫЙ chokepoint завершения iHerb-стадии ─────────────────────────────
// До этого стадия закрывалась «complete» просто по iherbAccountsQueue.length===0,
// без учёта того, сколько аккаунтов РЕАЛЬНО отпарсилось. Если аккаунт скипался
// (login/switch fail ≥2 раза, не captcha), он тихо уходил из очереди без парса, а
// прогон рапортовал iHerb done. Теперь ВСЕ пути завершения идут сюда.
//   1. Считаем сколько аккаунтов реально отпарсилось vs всего в конфиге.
//   2. Если есть пропущенные (не captcha) и мы ещё не делали retry-проход —
//      делаем ОДИН ограниченный retry по ним (свежие 2 попытки на аккаунт).
//   3. Иначе реально закрываем стадию: гарантированный возврат на primary +
//      roster + алерт оператору если кого-то недосчитались + advance pipeline.
// Идемпотентна: если storesCompleted.iherb уже true — no-op (защита от двойного
// завершения из watchdog / handleProgressMessage / captcha-abort).
async function finalizeIherbStage(tabId, { fromCaptcha = false, expectedGeneration = null } = {}) {
    if (storesCompleted && storesCompleted.iherb === true) {
        console.log('[finalizeIherb] stage already completed — no-op');
        return { retrying: false };
    }

    const generationState = await chrome.storage.local.get([
        'pipelineStage', 'multiAccountIherbState'
    ]);
    const generation = expectedGeneration || pipelineGenerationFromStage(generationState.pipelineStage);
    if (!generationState.pipelineStage?.active
        || !pipelineGenerationMatches(generationState.pipelineStage, generation)
        || generationState.pipelineStage.stages?.[generationState.pipelineStage.currentIndex] !== 'iherb') {
        console.warn('⏭ Refusing stale iHerb finalization entry');
        return { retrying: false, stale: true };
    }
    if (generationState.multiAccountIherbState) {
        isMultiAccountIherb = generationState.multiAccountIherbState.isMultiAccountIherb;
        iherbAccountsQueue = generationState.multiAccountIherbState.iherbAccountsQueue || [];
        currentIherbAccount = generationState.multiAccountIherbState.currentIherbAccount;
    }

    // finalize вызывается не только из обычного Done, но и из watchdog/captcha
    // путей. Ни retry-login, ни возврат на primary не имеют права сменить
    // кабинет, пока карточки текущего аккаунта реально не записаны и очередь
    // не закреплена persisted [].
    if (currentIherbAccount) {
        if (!await waitForScreenshotsDrained()) {
            return stopPipelineForScreenshotDrain('iHerb final screenshots blocked', generation);
        }
    }

    const cfg = await loadAccountsConfig();
    const allEmails = cfg.iherb.map(a => a.email);

    const st = await chrome.storage.local.get([
        'iherbParsedAccounts', 'iherbRetryPassDone', 'iherbSkipReasons'
    ]);
    const parsed = new Set(Array.isArray(st.iherbParsedAccounts) ? st.iherbParsedAccounts : []);
    const retryPassDone = !!st.iherbRetryPassDone;
    const skipReasons = (st.iherbSkipReasons && typeof st.iherbSkipReasons === 'object') ? st.iherbSkipReasons : {};

    const missing = allEmails.filter(e => !parsed.has(e));
    // captcha привязана к IP — повторять бессмысленно, следующий аккаунт упрётся в неё же.
    const retriable = missing.filter(e => skipReasons[e] !== 'captcha');

    const beforeDecision = (await chrome.storage.local.get(['pipelineStage'])).pipelineStage;
    if (!beforeDecision?.active
        || !pipelineGenerationMatches(beforeDecision, generation)
        || beforeDecision.stages?.[beforeDecision.currentIndex] !== 'iherb') {
        console.warn('⏭ Refusing stale iHerb retry/final-return side effects');
        return { retrying: false, stale: true };
    }

    // ── ОДИН ограниченный retry-проход по недопарсенным (не captcha) аккаунтам ──
    if (!fromCaptcha && retriable.length > 0 && !retryPassDone) {
        console.log(`[finalizeIherb] retry pass for missing accounts: ${retriable.join(', ')}`);

        // Даём каждому retriable-аккаунту свежие 2 попытки (сбрасываем его счётчик).
        const fd = await chrome.storage.local.get(['iherbSwitchFailures']);
        const failures = fd.iherbSwitchFailures || {};
        for (const e of retriable) delete failures[e];

        // Пересобираем очередь ТОЛЬКО из retriable-аккаунтов (в исходном порядке конфига).
        iherbAccountsQueue = cfg.iherb.filter(a => retriable.includes(a.email));
        isMultiAccountIherb = true;
        currentIherbAccount = null;

        await chrome.storage.local.set({
            iherbRetryPassDone: true,
            iherbSwitchFailures: failures,
            multiAccountIherbState: {
                isMultiAccountIherb: true,
                iherbAccountsQueue,
                currentIherbAccount: null,
                iherbParsedAccounts: [...parsed],
                iherbRetryPassDone: true,
                iherbSkipReasons: skipReasons
            }
        });

        const names = retriable.map(e => e.split('@')[0]).join(', ');
        console.log(`♻️ iHerb: повтор для пропущенных аккаунтов: ${names}`);
        sendTelegramMessage(`♻️ iHerb: повтор для пропущенных аккаунтов: ${names}`).catch(() => {});

        await switchToNextIherbAccount(generation);
        return { retrying: true };
    }

    // ── Реальное завершение стадии ──
    const beforeFinalReturn = (await chrome.storage.local.get(['pipelineStage'])).pipelineStage;
    if (generation && (!beforeFinalReturn?.active
        || !pipelineGenerationMatches(beforeFinalReturn, generation)
        || beforeFinalReturn.stages?.[beforeFinalReturn.currentIndex] !== 'iherb')) {
        console.warn('⏭ Refusing stale iHerb finalization');
        return { retrying: false, stale: true };
    }

    isMultiAccountIherb = false;
    const primary = getPrimary(cfg.iherb);
    const ownedTab = (await chrome.storage.local.get(['iherbParserTabId'])).iherbParserTabId || null;
    const finalizing = {
        ...generation,
        shop: 'iherb',
        account: primary.email,
        tabId: ownedTab,
        returnStatus: 'prepared',
        attempts: 0,
        preparedAt: Date.now()
    };
    await chrome.storage.local.set({
        iherbStageFinalizing: finalizing,
        iherbFinalReturnConfirmed: null
    });

    parseReport.iherbRoster = { parsed: [...parsed], missing, total: allEmails.length };

    if (missing.length > 0) {
        const reasonRu = (e) => {
            const rr = skipReasons[e];
            if (rr === 'switch_failed') return 'не удалось войти';
            if (rr === 'captcha') return 'капча';
            return 'не дошёл';
        };
        const lines = missing.map(e => `${e.split('@')[0]} (${reasonRu(e)})`).join(', ');
        console.log(`⚠️ iHerb: отпарсилось ${parsed.size} из ${allEmails.length} аккаунтов. Пропущены: ${lines}`);
    }
    await resumeIherbStageFinalization(finalizing, generation);
    return { retrying: false };
}

async function resumeIherbStageFinalization(finalizing, expectedGeneration) {
    let state = await chrome.storage.local.get([
        'pipelineStage', 'iherbStageFinalizing', 'iherbFinalReturnConfirmed'
    ]);
    let marker = state.iherbStageFinalizing || finalizing;
    if (!state.pipelineStage?.active
        || !pipelineGenerationMatches(state.pipelineStage, expectedGeneration)
        || !pipelineGenerationMatches(marker, expectedGeneration)
        || marker.shop !== 'iherb') {
        console.warn('⏭ Refusing stale iHerb final-return recovery');
        return false;
    }

    let status = marker.returnStatus;
    if (status === 'prepared') {
        if (finalReturnConfirmationMatches(state.iherbFinalReturnConfirmed, marker)) {
            status = 'confirmed';
        } else {
            const returned = await finalReturnToIherbPrimary(marker.tabId, expectedGeneration);
            state = await chrome.storage.local.get([
                'pipelineStage', 'iherbStageFinalizing', 'iherbFinalReturnConfirmed'
            ]);
            marker = state.iherbStageFinalizing || marker;
            if (!state.pipelineStage?.active
                || !pipelineGenerationMatches(state.pipelineStage, expectedGeneration)) {
                return false;
            }
            status = returned
                && finalReturnConfirmationMatches(state.iherbFinalReturnConfirmed, marker)
                ? 'confirmed'
                : 'failed';
        }
        marker = { ...marker, returnStatus: status, resolvedAt: Date.now() };
        await chrome.storage.local.set({ iherbStageFinalizing: marker });
    }

    const fresh = (await chrome.storage.local.get(['pipelineStage'])).pipelineStage;
    if (!fresh?.active
        || !pipelineGenerationMatches(fresh, expectedGeneration)
        || fresh.stages?.[fresh.currentIndex] !== 'iherb') return false;

    if (status === 'failed') {
        // Returning the browser session to primary happens after all iHerb
        // orders were committed. A return failure degrades the run, but it must
        // never erase the already-proven cabinet completion.
        await recordPipelineOperationalFailure('iherb', marker.account, {
            runId: expectedGeneration.runId,
            reason: marker.reason || 'final-primary-return-failed'
        });
    }
    const beforeAdvance = (await chrome.storage.local.get(['pipelineStage'])).pipelineStage;
    if (!beforeAdvance?.active
        || !pipelineGenerationMatches(beforeAdvance, expectedGeneration)) return false;
    setParserLock('iherb', false);
    storesCompleted.iherb = true;
    await chrome.storage.local.set({ parsingState: { isParsingAllStores, storesCompleted } });
    const advanced = await advancePipelineStage(expectedGeneration);
    checkAllStoresCompleted();
    return advanced;
}

function finalReturnToIherbPrimary(_tabId, expectedGeneration = null) {
    const key = pipelineOperationKey(expectedGeneration, 'primary');
    return runParserOperationSingleFlight('iherb-final-return', key, () =>
        finalReturnToIherbPrimaryOnce(_tabId, expectedGeneration));
}

async function finalReturnToIherbPrimaryOnce(_tabId, expectedGeneration = null) {
    const cfg = await loadAccountsConfig();
    const primary = getPrimary(cfg.iherb);
    console.log(`🏁 iHerb final return to ${primary.email}`);

    const readReturnState = () => chrome.storage.local.get([
        'iherbParserTabId', 'pipelineRun', 'pipelineStage', 'iherbStageFinalizing',
        'pendingIherbSwitch', 'iherbSwitchDispatch'
    ]);
    const ownsReturn = state => !!expectedGeneration
        && state.pipelineStage?.active === true
        && pipelineGenerationMatches(state.pipelineStage, expectedGeneration)
        && state.pipelineStage.stages?.[state.pipelineStage.currentIndex] === 'iherb'
        && state.pipelineRun?.id === expectedGeneration.runId
        && pipelineGenerationMatches(state.iherbStageFinalizing, expectedGeneration)
        && normalizeAccountEmail(state.iherbStageFinalizing?.account)
            === normalizeAccountEmail(primary.email);
    const preparedReturnMatches = (state, tabId) => ownsReturn(state)
        && state.iherbParserTabId === tabId
        && state.pendingIherbSwitch?.runId === expectedGeneration.runId
        && normalizeAccountEmail(state.pendingIherbSwitch?.email)
            === normalizeAccountEmail(primary.email)
        && pipelineGenerationMatches(state.iherbSwitchDispatch, expectedGeneration)
        && normalizeAccountEmail(state.iherbSwitchDispatch?.account)
            === normalizeAccountEmail(primary.email)
        && state.iherbSwitchDispatch?.tabId === tabId
        && state.iherbSwitchDispatch?.kind === 'final-return'
        && state.iherbSwitchDispatch?.phase === 'prepared';

    let returnState = await readReturnState();
    if (!ownsReturn(returnState)) {
        console.warn('⏭ Missing exact iHerb finalization marker');
        return false;
    }

    const tabId = await ensureValidIherbParserTab(returnState.iherbParserTabId);
    returnState = await readReturnState();
    if (!ownsReturn(returnState)) {
        console.warn('⏭ iHerb generation changed while resolving final-return tab');
        return false;
    }
    await chrome.storage.local.set({
        iherbParserTabId: tabId,
        iherbStageFinalizing: { ...returnState.iherbStageFinalizing, tabId }
    });

    // Возврат на primary критичен: иначе следующий прогон стартует с чужого
    // аккаунта. Пробуем sign-out+login ДВАЖДЫ; если оба раза упало — громкий
    // алерт оператору (руками проверить), но НЕ бросаем — pipeline должен жить.
    let returned = false;
    for (let attempt = 1; attempt <= 2 && !returned; attempt++) {
        try {
            returnState = await readReturnState();
            if (!ownsReturn(returnState) || returnState.iherbParserTabId !== tabId) {
                console.warn('⏭ iHerb final return lost generation before preparation');
                return false;
            }
            await chrome.storage.local.set({
                pendingIherbSwitch: {
                    email: primary.email,
                    password: primary.password,
                    runId: expectedGeneration.runId
                },
                iherbFinalReturn: true,
                iherbFinalReturnConfirmed: null,
                multiAccountIherbState: null,
                iherbSwitchDispatch: {
                    ...expectedGeneration,
                    account: primary.email,
                    tabId,
                    phase: 'prepared',
                    kind: 'final-return',
                    preparedAt: Date.now()
                },
                iherbStageFinalizing: {
                    ...returnState.iherbStageFinalizing,
                    tabId,
                    attempts: attempt,
                    returnStatus: 'prepared'
                }
            });
            returnState = await readReturnState();
            if (!preparedReturnMatches(returnState, tabId)) {
                console.warn('⏭ iHerb final return lost generation before sign-out cleanup');
                return false;
            }
            await chrome.storage.local.remove(['iherbSwitchInProgress', 'iherbSwitchStartedAt']);
            returnState = await readReturnState();
            if (!preparedReturnMatches(returnState, tabId)) {
                console.warn('⏭ iHerb final return lost generation before navigation');
                return false;
            }
            await iherbUiSignOutAndNavigateToLogin(tabId);
            returnState = await readReturnState();
            if (!preparedReturnMatches(returnState, tabId)) return false;
            await chrome.storage.local.set({
                iherbSwitchDispatch: {
                    ...expectedGeneration,
                    account: primary.email,
                    tabId,
                    phase: 'dispatched',
                    kind: 'final-return',
                    dispatchedAt: Date.now()
                }
            });
            returned = await waitForIherbFinalReturnCompletion(expectedGeneration, 60_000);
            if (!returned) throw new Error('primary_login_not_confirmed');
        } catch (e) {
            returnState = await readReturnState();
            if (!ownsReturn(returnState)) return false;
            console.error(`❌ iHerb final return attempt ${attempt}/2 failed:`, e);
            if (attempt >= 2) {
                sendTelegramMessage(`⚠️ iHerb: не смог вернуться на основной аккаунт photopochtoy — проверь вручную`).catch(() => {});
            } else {
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }
    return returned;
}

async function waitForIherbFinalReturnCompletion(expectedGeneration, maxWaitMs) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        const state = await chrome.storage.local.get([
            'pipelineStage', 'iherbStageFinalizing', 'iherbFinalReturnConfirmed'
        ]);
        if (expectedGeneration && (!state.pipelineStage?.active
            || !pipelineGenerationMatches(state.pipelineStage, expectedGeneration))) {
            return false;
        }
        if (pipelineGenerationMatches(state.iherbStageFinalizing, expectedGeneration)
            && finalReturnConfirmationMatches(
                state.iherbFinalReturnConfirmed,
                state.iherbStageFinalizing
            )) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return false;
}

// ─── Shared: ensure we have exactly one iHerb parser tab ───────────────────
async function ensureIherbParserTab() {
    // Lost ownership cannot be reconstructed from a URL: an existing iHerb tab
    // may belong to the operator or another task. Create one parser-owned tab.
    const t = await chrome.tabs.create({ url: 'https://www.iherb.com/', active: false });
    await waitForTabComplete(t.id, 20000);
    return t.id;
}

// Валидирует cached iherbParserTabId: проверяет что таб жив и на iHerb-домене.
// Если нет — возвращает свежий tabId через ensureIherbParserTab. Это чинит
// ошибку "Cannot access a chrome-extension:// URL of different extension",
// которая возникает когда chrome.debugger.attach пытается подключиться к табу
// чужого расширения (stale ID после закрытия iHerb-таба).
async function ensureValidIherbParserTab(cachedTabId) {
    if (cachedTabId) {
        try {
            const t = await chrome.tabs.get(cachedTabId);
            if (t && /^https?:\/\/[a-z0-9.-]*iherb\.com\//i.test(t.url || '')) {
                return cachedTabId;
            }
            console.warn(`⚠️ iherbParserTabId=${cachedTabId} stale (url=${t?.url?.slice(0,80)}) — re-query`);
        } catch (e) {
            console.warn(`⚠️ iherbParserTabId=${cachedTabId} not found — re-query`);
        }
    }
    return ensureIherbParserTab();
}

function waitForTabComplete(tabId, timeoutMs) {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        const to = setTimeout(finish, timeoutMs);
        const handler = (updatedTabId, info) => {
            if (updatedTabId === tabId && info.status === 'complete') {
                clearTimeout(to);
                chrome.tabs.onUpdated.removeListener(handler);
                finish();
            }
        };
        chrome.tabs.onUpdated.addListener(handler);
    });
}

// ─── chrome.debugger wrapper: real hover+click (Phase 1 parity) ────────────
// В отличие от DOM dispatchEvent, Input.dispatchMouseEvent триггерит настоящий
// :hover. Без этого dropdown не откроется. Requires "debugger" permission.
async function dbgAttach(tabId) {
    await new Promise((resolve, reject) => {
        chrome.debugger.attach({ tabId }, IHERB_DEBUGGER_VERSION, () => {
            if (chrome.runtime.lastError) {
                const m = chrome.runtime.lastError.message || '';
                if (/already attached/i.test(m)) return resolve();
                return reject(new Error(m));
            }
            resolve();
        });
    });
}

async function dbgDetach(tabId) {
    await new Promise((resolve) => {
        chrome.debugger.detach({ tabId }, () => {
            if (chrome.runtime.lastError) { /* swallow */ }
            resolve();
        });
    });
}

function dbgSend(tabId, method, params) {
    return new Promise((resolve, reject) => {
        chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            resolve(res);
        });
    });
}

async function dbgMouseMove(tabId, x, y) {
    await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}
async function dbgMouseClick(tabId, x, y) {
    await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed',  x, y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 80));
    await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function dbgEval(tabId, expression) {
    const res = await dbgSend(tabId, 'Runtime.evaluate', {
        expression: `(function(){try{return JSON.stringify((function(){return ${expression};})());}catch(e){return JSON.stringify({__err:String(e.message||e)});}})()`,
        returnByValue: true
    });
    const v = res?.result?.value;
    if (!v) return null;
    try {
        const parsed = JSON.parse(v);
        if (parsed && parsed.__err) throw new Error('eval: ' + parsed.__err);
        return parsed;
    } catch (_) {
        return null;
    }
}

// Ждёт пока .my-account появится и станет видимым в header. iHerb hydrate'ит
// header асинхронно после `load`; фиксированный dwell 1.5s рейсит с монтажом.
async function waitForIherbHeader(tabId, maxMs = 20000) {
    const start = Date.now();
    let logged = false;
    while (Date.now() - start < maxMs) {
        const ok = await dbgEval(tabId, `
            (() => {
                const el = document.querySelector('.my-account');
                if (!el) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            })()
        `);
        if (ok) return true;
        if (!logged) {
            console.log('🌿 [iHerb UI] waiting for .my-account to hydrate...');
            logged = true;
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
}

// Hover .my-account + ищет элемент в дропдауне с retry. Дропдаун может схлопнуться
// во время CDP round-trip (~200мс) → element.offsetParent===null. Retry с re-hover.
// `evalExpr` должен возвращать { found: bool, x?, y?, reason? }.
async function hoverAndFind(tabId, trigger, evalExpr, maxAttempts = 3) {
    let lastReason = 'unknown';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Neutral → trigger hover. На 2+ попытке — сначала уходим далеко и паузим.
        if (attempt > 1) {
            await dbgMouseMove(tabId, 10, 10);
            await new Promise(r => setTimeout(r, 600));
        }
        await dbgMouseMove(tabId, 100, 500);
        await new Promise(r => setTimeout(r, 300));
        await dbgMouseMove(tabId, trigger.x, trigger.y);
        // Удерживаем hover: мелкие подёргивания чтобы dropdown не подумал что мы ушли.
        const holdMs = IHERB_HOVER_HOLD_MS + (attempt - 1) * 1000; // 2s → 3s → 4s
        const jitters = Math.max(2, Math.floor(holdMs / 400));
        for (let i = 0; i < jitters; i++) {
            await new Promise(r => setTimeout(r, 400));
            await dbgMouseMove(tabId, trigger.x + (i % 2 ? 2 : -2), trigger.y + (i % 3 ? 1 : -1));
        }
        const res = await dbgEval(tabId, evalExpr);
        if (res && res.found) {
            if (attempt > 1) console.log(`🌿 [iHerb UI] found on attempt ${attempt}/${maxAttempts}`);
            return { x: res.x, y: res.y };
        }
        lastReason = res?.reason || 'no_response';
        console.warn(`🌿 [iHerb UI] attempt ${attempt}/${maxAttempts} failed: ${lastReason}`);
    }
    console.error(`🌿 [iHerb UI] hoverAndFind giving up after ${maxAttempts}: ${lastReason}`);
    return null;
}

// ─── Sign-out flow: direct URL redirect (no chrome.debugger) ──
// Раньше использовался chrome.debugger.attach + hover + click через Input.dispatchMouseEvent.
// Это падало с "Cannot access a chrome-extension:// URL of different extension" когда
// другой extension (AutoBuy) имел persistent attached debugger session — Chrome не
// разрешает второму extension одновременно держать chrome.debugger client.
//
// Решение: iHerb sign-out — это обычный <a href="https://checkout.iherb.com/account/logoff">.
// Просто chrome.tabs.update на этот URL → server-side logout → redirect на homepage.
// Затем chrome.tabs.update на /myaccount/orders → если разлогинен, iHerb сам
// отредиректит на /auth/ui/account/login, где content-iherb-login.js берёт за дело.
//
// Никакого debugger, никакого hover, никаких mouse events.
// Helpers dbgAttach/dbgEval/dbgClick/waitForIherbHeader/hoverAndFind остаются как
// dead code на случай если понадобятся в другом флоу.
async function iherbUiSignOutAndNavigateToLogin(tabId) {
    const LOGOFF_URL = 'https://checkout.iherb.com/account/logoff';
    const ORDERS_URL = 'https://secure.iherb.com/myaccount/orders';

    console.log('🌿 [iHerb UI] sign-out via URL redirect');

    // 1) Activate tab + navigate to logoff URL — iHerb выполнит logout server-side
    //    и редиректнет на homepage (с correlationId).
    try {
        await chrome.tabs.update(tabId, { url: LOGOFF_URL, active: true });
        await waitForTabComplete(tabId, 20000);
        await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
        console.warn('[iHerb UI] logoff navigate failed:', e?.message || e);
        throw new Error('logoff_navigate_failed: ' + (e?.message || e));
    }

    // 2) Navigate to /myaccount/orders. Поскольку мы только что разлогинились,
    //    iHerb redirect на /auth/ui/account/login → content-iherb-login.js видит
    //    pendingIherbSwitch и выполняет fillAndSubmit логина для нового аккаунта.
    try {
        await chrome.tabs.update(tabId, { url: ORDERS_URL, active: true });
        await waitForTabComplete(tabId, 25000);
    } catch (e) {
        console.warn('[iHerb UI] orders navigate failed:', e?.message || e);
        throw new Error('orders_navigate_failed: ' + (e?.message || e));
    }

    console.log('🌿 [iHerb UI] login page should be loaded; content-iherb-login.js takes over');
}

// Финальный return — открывает switch_account=picker для primary Amazon-аккаунта
// (из accountsConfig) и выставляет флаг amazonFinalReturn, чтобы content-скрипты
// знали: кликать аккаунт, но НЕ запускать парсинг и НЕ редиректить на orders.
async function beginAmazonStageFinalization(expectedGeneration) {
    const state = await chrome.storage.local.get([
        'pipelineRun', 'pipelineStage', 'amazonParserTabId', 'multiAccountState'
    ]);
    if (!state.pipelineStage?.active
        || !pipelineGenerationMatches(state.pipelineStage, expectedGeneration)
        || state.pipelineStage.stages?.[state.pipelineStage.currentIndex] !== 'amazon'
        || state.pipelineRun?.id !== expectedGeneration?.runId) {
        console.warn('⏭ Refusing stale Amazon finalization entry');
        return false;
    }
    if (state.multiAccountState?.currentAmazonAccount
        && !await waitForScreenshotsDrained()) {
        return stopPipelineForScreenshotDrain(
            'Amazon final screenshots blocked',
            expectedGeneration
        );
    }
    const afterDrain = (await chrome.storage.local.get(['pipelineStage'])).pipelineStage;
    if (!afterDrain?.active
        || !pipelineGenerationMatches(afterDrain, expectedGeneration)
        || afterDrain.stages?.[afterDrain.currentIndex] !== 'amazon') return false;
    const cfg = await loadAccountsConfig();
    const primary = getPrimary(cfg.amazon);
    const beforePrepare = (await chrome.storage.local.get(['pipelineStage'])).pipelineStage;
    if (!beforePrepare?.active
        || !pipelineGenerationMatches(beforePrepare, expectedGeneration)
        || beforePrepare.stages?.[beforePrepare.currentIndex] !== 'amazon') return false;
    const marker = {
        ...expectedGeneration,
        shop: 'amazon',
        account: primary.email,
        tabId: state.amazonParserTabId || null,
        returnStatus: 'prepared',
        attempts: 0,
        preparedAt: Date.now()
    };
    await chrome.storage.local.set({
        multiAccountState: null,
        amazonStageFinalizing: marker,
        amazonFinalReturnConfirmed: null
    });
    return resumeAmazonStageFinalization(marker, expectedGeneration);
}

async function resumeAmazonStageFinalization(finalizing, expectedGeneration) {
    let state = await chrome.storage.local.get([
        'pipelineStage', 'amazonStageFinalizing', 'amazonFinalReturnConfirmed'
    ]);
    let marker = state.amazonStageFinalizing || finalizing;
    if (!state.pipelineStage?.active
        || !pipelineGenerationMatches(state.pipelineStage, expectedGeneration)
        || !pipelineGenerationMatches(marker, expectedGeneration)
        || marker.shop !== 'amazon') {
        console.warn('⏭ Refusing stale Amazon final-return recovery');
        return false;
    }

    let status = marker.returnStatus;
    if (status === 'prepared') {
        if (finalReturnConfirmationMatches(state.amazonFinalReturnConfirmed, marker)) {
            status = 'confirmed';
        } else {
            const returned = await finalReturnToPrimaryAmazon(expectedGeneration);
            state = await chrome.storage.local.get([
                'pipelineStage', 'amazonStageFinalizing', 'amazonFinalReturnConfirmed'
            ]);
            marker = state.amazonStageFinalizing || marker;
            if (!state.pipelineStage?.active
                || !pipelineGenerationMatches(state.pipelineStage, expectedGeneration)) return false;
            status = returned
                && finalReturnConfirmationMatches(state.amazonFinalReturnConfirmed, marker)
                ? 'confirmed'
                : 'failed';
        }
        marker = { ...marker, returnStatus: status, resolvedAt: Date.now() };
        await chrome.storage.local.set({ amazonStageFinalizing: marker });
    }

    const fresh = (await chrome.storage.local.get(['pipelineStage'])).pipelineStage;
    if (!fresh?.active
        || !pipelineGenerationMatches(fresh, expectedGeneration)
        || fresh.stages?.[fresh.currentIndex] !== 'amazon') return false;
    if (status === 'failed') {
        await recordPipelineOperationalFailure('amazon', marker.account, {
            runId: expectedGeneration.runId,
            reason: marker.reason || 'final-primary-return-failed'
        });
    }
    const beforeAdvance = (await chrome.storage.local.get(['pipelineStage'])).pipelineStage;
    if (!beforeAdvance?.active
        || !pipelineGenerationMatches(beforeAdvance, expectedGeneration)) return false;
    setParserLock('amazon', false);
    storesCompleted.amazon = true;
    stopCompletionWatchdog();
    await chrome.storage.local.set({ parsingState: { isParsingAllStores, storesCompleted } });
    const advanced = await advancePipelineStage(expectedGeneration);
    checkAllStoresCompleted();
    return advanced;
}

function finalReturnToPrimaryAmazon(expectedGeneration = null) {
    const key = pipelineOperationKey(expectedGeneration, 'primary');
    return runParserOperationSingleFlight('amazon-final-return', key, () =>
        finalReturnToPrimaryAmazonOnce(expectedGeneration));
}

async function finalReturnToPrimaryAmazonOnce(expectedGeneration = null) {
    const cfg = await loadAccountsConfig();
    const primary = getPrimary(cfg.amazon);
    console.log(`🏁 Amazon final return to ${primary.email}`);

    const runState = await chrome.storage.local.get([
        'pipelineRun', 'pipelineStage', 'amazonStageFinalizing'
    ]);
    const generation = expectedGeneration || pipelineGenerationFromStage(runState.pipelineStage);
    if (!generation || generation.runId !== runState.pipelineRun?.id) {
        console.warn('⏭ Refusing stale Amazon final return');
        return false;
    }
    if (!pipelineGenerationMatches(runState.amazonStageFinalizing, generation)
        || normalizeAccountEmail(runState.amazonStageFinalizing?.account)
            !== normalizeAccountEmail(primary.email)) {
        console.warn('⏭ Missing exact Amazon finalization marker');
        return false;
    }
    await chrome.storage.local.set({
        pendingAccountSwitch: { email: primary.email, runId: runState.pipelineRun?.id || null },
        amazonFinalReturn: true,
        amazonFinalReturnConfirmed: null,
        amazonSwitchDispatch: {
            ...generation,
            account: primary.email,
            tabId: runState.amazonStageFinalizing.tabId || null,
            kind: 'final-return',
            phase: 'prepared',
            preparedAt: Date.now()
        },
        amazonStageFinalizing: {
            ...runState.amazonStageFinalizing,
            attempts: (Number(runState.amazonStageFinalizing.attempts) || 0) + 1,
            returnStatus: 'prepared'
        },
        accountSwitchStartedAt: Date.now(),
        amazonParsingComplete: null
    });
    await chrome.storage.local.remove(['amazonPaginationState']);

    if (!await dispatchCurrentAmazonAccountSwitch(primary.email, generation, 'final-return')) {
        return false;
    }
    const parserState = await chrome.storage.local.get(['amazonParserTabId', 'amazonStageFinalizing']);
    await chrome.storage.local.set({
        amazonStageFinalizing: {
            ...parserState.amazonStageFinalizing,
            tabId: parserState.amazonParserTabId || null
        }
    });

    return waitForAmazonFinalReturnCompletion(generation, 60_000);
}

async function waitForAmazonFinalReturnCompletion(expectedGeneration, maxWaitMs) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        const state = await chrome.storage.local.get([
            'pipelineStage', 'amazonStageFinalizing', 'amazonFinalReturnConfirmed'
        ]);
        if (!state.pipelineStage?.active
            || !pipelineGenerationMatches(state.pipelineStage, expectedGeneration)) {
            return false;
        }
        if (pipelineGenerationMatches(state.amazonStageFinalizing, expectedGeneration)
            && finalReturnConfirmationMatches(
                state.amazonFinalReturnConfirmed,
                state.amazonStageFinalizing
            )) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return false;
}

// Initialize multi-account Amazon parsing
async function startMultiAccountAmazonParsing() {
    console.log('🚀 startMultiAccountAmazonParsing called');

    const cfg = await loadAccountsConfig();
    amazonAccountsQueue = cfg.amazon.map(a => a.email);
    isMultiAccountParsing = true;
    currentAmazonAccount = null;

    // Clear all per-run flags before proceeding (with await!). Keep the exact
    // parser tab id so a new run can reuse its own tab without touching others.
    await new Promise(resolve => {
        chrome.storage.local.set({
            stopAllParsers: false,
            amazonParsingComplete: null,
            amazonPaginationState: null,
            amazonNavigationGraceUntil: null,
            amazonNavigationRecovery: null,
            amazonParsingIncomplete: null,
            accountSwitchStartedAt: null,
            accountSwitchFailures: {},
            amazonSwitchDispatch: null,
            amazonStageFinalizing: null,
            amazonFinalReturnConfirmed: null,
            multiAccountState: {
                isMultiAccountParsing: true,
                amazonAccountsQueue: amazonAccountsQueue,
                currentAmazonAccount: null
            }
        }, resolve);
    });
    console.log('✅ multiAccountState saved to storage');

    console.log(`🚀 Starting multi-account Amazon parsing for ${amazonAccountsQueue.length} accounts`);
    console.log(`🔄 Multi-account Amazon: ${amazonAccountsQueue.map(e => e.split('@')[0]).join(', ')}`);

    // Lock AutoBuy: пока парсим амазон — авто-выкуп амазон не работает
    setParserLock('amazon', true);

    // Start watchdog timer to check for completion flag
    startCompletionWatchdog();

    // Start with first account switch
    await switchToNextAmazonAccount();
}

// Watchdog using chrome.alarms (reliable even when Service Worker sleeps)
const WATCHDOG_ALARM_NAME = 'amazonCompletionWatchdog';
const AMAZON_NAVIGATION_MAX_RETRIES = 2;
const AMAZON_NAVIGATION_RETRY_GAP_MS = 60_000;
const AMAZON_NAVIGATION_GRACE_MS = 5 * 60_000;
let amazonNavigationRetryInFlight = null;
const SCREENSHOT_RESUME_ALARM = 'screenshotResume';
chrome.alarms.create(SCREENSHOT_RESUME_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });

function getAmazonNavigationRetryDecision({ paginationState, recovery, timedOut, now = Date.now() }) {
    const navigation = paginationState?.navigation;
    if (!timedOut || !navigation) return { retry: false, reason: 'no-open-navigation' };
    if (!navigation.navId) return { retry: false, reason: 'missing-navigation-id' };
    if (navigation.targetPage !== paginationState.currentPage) {
        return { retry: false, reason: 'page-generation-mismatch' };
    }
    const sameRecovery = recovery?.navId === navigation.navId
        && recovery?.parseId === paginationState.parseId
        && recovery?.runId === paginationState.runId
        && normalizeAccountEmail(recovery?.account) === normalizeAccountEmail(paginationState.account)
        && recovery?.parserTabId === paginationState.parserTabId;
    const retryCount = sameRecovery ? Math.max(0, Number(recovery.retryCount) || 0) : 0;
    if (retryCount >= AMAZON_NAVIGATION_MAX_RETRIES) {
        return { retry: false, reason: 'retry-limit' };
    }
    if (sameRecovery && recovery.lastRetryAt && now - recovery.lastRetryAt < AMAZON_NAVIGATION_RETRY_GAP_MS) {
        return { retry: false, reason: 'retry-gap' };
    }
    try {
        const target = new URL(navigation.targetUrl);
        if (!/(^|\.)amazon\.com$/i.test(target.hostname)
            || !/(?:order-history|your-orders)/i.test(target.pathname)) {
            return { retry: false, reason: 'unsafe-target' };
        }
    } catch (_) {
        return { retry: false, reason: 'invalid-target' };
    }
    return {
        retry: true,
        retryCount: retryCount + 1,
        navId: navigation.navId,
        targetPage: navigation.targetPage,
        targetUrl: navigation.targetUrl
    };
}

function amazonPaginationOwnershipMatches(paginationState, runtimeState) {
    const stage = runtimeState?.pipelineStage;
    return !!paginationState?.parseId
        && !!paginationState?.runId
        && paginationState.runId === runtimeState?.pipelineRun?.id
        && ['starting', 'running'].includes(runtimeState?.pipelineRun?.status)
        && stage?.active === true
        && stage.runId === paginationState.runId
        && stage.stages?.[stage.currentIndex] === 'amazon'
        && normalizeAccountEmail(paginationState.account)
            === normalizeAccountEmail(runtimeState?.multiAccountState?.currentAmazonAccount)
        && paginationState.parserTabId === runtimeState?.amazonParserTabId;
}

function isAmazonHardCapExpired({ totalElapsed, hardCapMs, now = Date.now(), graceUntil }) {
    if (totalElapsed <= hardCapMs) return false;
    return !(Number.isFinite(graceUntil) && now < graceUntil);
}

function getAmazonAccountTimeoutDecision({
    totalElapsed,
    sinceLastProgress,
    matchingIncomplete = false,
    now = Date.now(),
    graceUntil,
    idleTimeoutMs = ACCOUNT_PARSE_TIMEOUT_MS,
    hardCapMs = AMAZON_ACCOUNT_HARD_CAP_MS
}) {
    const isIdleTimeout = matchingIncomplete || sinceLastProgress > idleTimeoutMs;
    const isHardCap = isAmazonHardCapExpired({ totalElapsed, hardCapMs, now, graceUntil });
    return { isIdleTimeout, isHardCap, timedOut: isIdleTimeout || isHardCap };
}

async function getAmazonParserTab(tabId) {
    if (tabId) {
        try {
            const tab = await chrome.tabs.get(tabId);
            const url = new URL(tab?.url || '');
            const parserPath = /^(?:\/$|\/ap\/signin|\/gp\/(?:your-account\/)?order-history|\/gp\/css\/order-history|\/your-orders)/i.test(url.pathname);
            if (/(^|\.)amazon\.com$/i.test(url.hostname) && parserPath) return tab;
        } catch (_) {}
    }
    // Lost ownership cannot be reconstructed from a URL. Even one matching
    // order-history tab may belong to the operator or another session.
    return null;
}

function amazonWatchdogAttemptFromState(state) {
    return {
        runId: state?.pipelineRun?.id || null,
        stageStartedAt: state?.pipelineStage?.stageStartedAt || null,
        account: normalizeAccountEmail(state?.multiAccountState?.currentAmazonAccount),
        parserTabId: state?.amazonParserTabId || null,
        accountSwitchStartedAt: state?.accountSwitchStartedAt || null,
        parseId: state?.amazonPaginationState?.parseId || null
    };
}

function amazonWatchdogAttemptIdentityMatches(left, right) {
    return !!left?.runId
        && !!right?.runId
        && left.runId === right.runId
        && left.stageStartedAt === right.stageStartedAt
        && left.account === normalizeAccountEmail(right.account)
        && left.parserTabId === right.parserTabId
        && left.accountSwitchStartedAt === right.accountSwitchStartedAt
        && left.parseId === right.parseId;
}

function amazonWatchdogAttemptMatches(state, attempt) {
    const current = amazonWatchdogAttemptFromState(state);
    return !!attempt?.runId
        && !!attempt?.account
        && state?.pipelineStage?.active === true
        && state.pipelineStage.runId === attempt.runId
        && state.pipelineStage.stages?.[state.pipelineStage.currentIndex] === 'amazon'
        && amazonWatchdogAttemptIdentityMatches(current, attempt);
}

async function clearAmazonTimeoutAttempt(expectedAttempt) {
    const current = await chrome.storage.local.get(['amazonTimeoutAttempt']);
    if (amazonWatchdogAttemptIdentityMatches(current.amazonTimeoutAttempt, expectedAttempt)) {
        await chrome.storage.local.set({ amazonTimeoutAttempt: null });
    }
}

function amazonCompletionMatchesAttempt(state, attempt) {
    const marker = state?.amazonParsingComplete;
    return amazonWatchdogAttemptMatches(state, attempt)
        && !!marker?.timestamp
        && marker.runId === attempt.runId
        && normalizeAccountEmail(marker.account) === attempt.account
        && marker.parserTabId === attempt.parserTabId
        && (!attempt.parseId || marker.parseId === attempt.parseId);
}

let amazonAttemptMutationChain = Promise.resolve();

function withAmazonAttemptMutation(work) {
    const task = amazonAttemptMutationChain
        .catch(() => {})
        .then(work);
    amazonAttemptMutationChain = task.catch(() => {});
    return task;
}

function amazonAttemptRefFromPayload(value) {
    return {
        runId: value?.runId || null,
        stageStartedAt: value?.stageStartedAt || null,
        account: normalizeAccountEmail(value?.account),
        parserTabId: value?.parserTabId || null,
        accountSwitchStartedAt: value?.accountSwitchStartedAt || null,
        parseId: value?.parseId || null
    };
}

function amazonAttemptRefMatchesRuntime(
    attempt,
    runtime,
    senderTabId,
    { allowResolvingCompletion = false } = {}
) {
    const stage = runtime?.pipelineStage;
    const currentAccount = normalizeAccountEmail(runtime?.multiAccountState?.currentAmazonAccount);
    if (!attempt?.runId || !attempt?.account || !attempt?.parserTabId || !attempt?.parseId) {
        return { ok: false, reason: 'incomplete-attempt-reference' };
    }
    if (!Number.isFinite(Number(attempt.stageStartedAt))
        || !Number.isFinite(Number(attempt.accountSwitchStartedAt))) {
        return { ok: false, reason: 'missing-attempt-timestamps' };
    }
    if (senderTabId !== attempt.parserTabId
        || runtime?.amazonParserTabId !== attempt.parserTabId) {
        return { ok: false, reason: 'parser-tab-changed' };
    }
    if (!['starting', 'running'].includes(runtime?.pipelineRun?.status)
        || runtime.pipelineRun.id !== attempt.runId
        || stage?.active !== true
        || stage.runId !== attempt.runId
        || stage.stages?.[stage.currentIndex] !== 'amazon'
        || (stage.stageStartedAt || null) !== attempt.stageStartedAt
        || currentAccount !== attempt.account
        || runtime?.accountSwitchStartedAt !== attempt.accountSwitchStartedAt) {
        return { ok: false, reason: 'run-account-generation-changed' };
    }
    if (pipelineGenerationMatches(
        runtime?.amazonStageFinalizing,
        pipelineGenerationFromStage(stage)
    )) {
        return { ok: false, reason: 'amazon-stage-finalizing' };
    }
    const currentPagination = runtime?.amazonPaginationState;
    if (currentPagination?.parseId && currentPagination.parseId !== attempt.parseId) {
        return { ok: false, reason: 'parse-attempt-changed' };
    }
    const timeoutAttempt = runtime?.amazonTimeoutAttempt;
    if (timeoutAttempt && amazonWatchdogAttemptIdentityMatches(timeoutAttempt, attempt)) {
        if (allowResolvingCompletion && timeoutAttempt.phase === 'resolving') {
            return { ok: true };
        }
        return {
            ok: false,
            reason: timeoutAttempt.phase === 'failed' ? 'timeout-won' : 'timeout-resolving'
        };
    }
    return { ok: true };
}

function amazonPaginationPayloadMatchesAttempt(paginationState, attempt) {
    return !!paginationState
        && paginationState.parseId === attempt.parseId
        && paginationState.runId === attempt.runId
        && normalizeAccountEmail(paginationState.account) === attempt.account
        && paginationState.parserTabId === attempt.parserTabId
        && paginationState.stageStartedAt === attempt.stageStartedAt
        && paginationState.accountSwitchStartedAt === attempt.accountSwitchStartedAt;
}

function isSafeAmazonOrdersUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        return /(^|\.)amazon\.com$/i.test(url.hostname)
            && /(?:order-history|your-orders)/i.test(url.pathname);
    } catch (_) {
        return false;
    }
}

async function handleAmazonAttemptCommit(request, senderTabId) {
    return withAmazonAttemptMutation(async () => {
        const attempt = amazonAttemptRefFromPayload(request.attempt);
        const runtime = await chrome.storage.local.get([
            'pipelineRun', 'pipelineStage', 'multiAccountState',
            'amazonParserTabId', 'accountSwitchStartedAt', 'amazonPaginationState',
            'amazonTimeoutAttempt', 'amazonStageFinalizing', 'orderData',
            'amazonCancelledOrders'
        ]);
        const ownership = amazonAttemptRefMatchesRuntime(
            attempt,
            runtime,
            senderTabId,
            { allowResolvingCompletion: request.kind === 'complete' }
        );
        if (!ownership.ok) {
            return { ok: false, status: 'stale', reason: ownership.reason };
        }

        const paginationState = request.paginationState
            ? structuredClone(request.paginationState)
            : null;
        if (paginationState && !amazonPaginationPayloadMatchesAttempt(paginationState, attempt)) {
            return { ok: false, status: 'invalid', reason: 'pagination-attempt-mismatch' };
        }

        if (request.kind === 'clear') {
            await chrome.storage.local.set({
                amazonPaginationState: null,
                amazonNavigationRecovery: null,
                amazonParsingIncomplete: null
            });
            return { ok: true, status: 'committed' };
        }

        if (request.kind === 'cursor' || request.kind === 'navigate') {
            if (!paginationState) {
                return { ok: false, status: 'invalid', reason: 'missing-pagination-state' };
            }
            const mutation = { amazonPaginationState: paginationState };
            if (Array.isArray(request.amazonOrders)) {
                mutation.amazonOrders = structuredClone(request.amazonOrders);
            }
            if (request.clearRecovery === true) {
                mutation.amazonNavigationRecovery = null;
                mutation.amazonParsingIncomplete = null;
            }
            if (request.kind === 'navigate') {
                const targetUrl = String(request.targetUrl || '');
                if (!isSafeAmazonOrdersUrl(targetUrl)
                    || paginationState.navigation?.targetUrl !== targetUrl) {
                    return { ok: false, status: 'invalid', reason: 'unsafe-navigation-target' };
                }
                await chrome.storage.local.set(mutation);
                await chrome.tabs.update(senderTabId, { url: targetUrl, active: true });
                return { ok: true, status: 'navigating', navId: paginationState.navigation?.navId || null };
            }
            await chrome.storage.local.set(mutation);
            return { ok: true, status: 'committed' };
        }

        if (request.kind === 'incomplete') {
            if (!paginationState || !request.incomplete) {
                return { ok: false, status: 'invalid', reason: 'missing-incomplete-payload' };
            }
            const incomplete = {
                ...structuredClone(request.incomplete),
                parseId: attempt.parseId,
                runId: attempt.runId,
                account: attempt.account,
                parserTabId: attempt.parserTabId
            };
            await chrome.storage.local.set({
                amazonPaginationState: paginationState,
                amazonParsingIncomplete: incomplete
            });
            return { ok: true, status: 'committed' };
        }

        if (request.kind !== 'complete') {
            return { ok: false, status: 'invalid', reason: 'unknown-commit-kind' };
        }
        if (!paginationState
            || !['configured-limit', 'explicit-end'].includes(request.reason)
            || paginationState.navigation) {
            return { ok: false, status: 'invalid', reason: 'invalid-completion-state' };
        }

        const observedAt = new Date().toISOString();
        const incomingOrders = (Array.isArray(request.orders) ? request.orders : []).map(order => ({
            ...structuredClone(order),
            parser_run_id: attempt.runId,
            parser_account: attempt.account,
            observed_at: observedAt
        }));
        const orderData = runtime.orderData && typeof runtime.orderData === 'object'
            ? structuredClone(runtime.orderData)
            : {};
        const existingOrders = Array.isArray(orderData.Amazon?.orders)
            ? orderData.Amazon.orders
            : [];
        const seen = new Set();
        const uniqueOrders = [...incomingOrders, ...existingOrders].filter(order => {
            const key = `${order?.order_id || ''}_${order?.track_number || ''}_${order?.product_name || ''}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        const uniqueOrderIds = new Set(uniqueOrders.map(order => order?.order_id).filter(Boolean));
        orderData.Amazon = {
            orders: uniqueOrders,
            lastParsed: observedAt,
            totalOrders: uniqueOrders.length,
            totalProductsCount: uniqueOrders.length,
            uniqueOrdersCount: uniqueOrderIds.size
        };

        const cancelledSeen = new Set();
        const cancelledOrders = [
            ...(Array.isArray(runtime.amazonCancelledOrders) ? runtime.amazonCancelledOrders : []),
            ...(Array.isArray(request.cancelledOrders) ? request.cancelledOrders : [])
        ].map(item => structuredClone(item)).filter(order => {
            const key = order?.order_id;
            if (!key || cancelledSeen.has(key)) return false;
            cancelledSeen.add(key);
            return true;
        });
        const completedState = {
            ...paginationState,
            allOrders: incomingOrders,
            completedAt: Date.now(),
            completionReason: request.reason
        };
        delete completedState.incomplete;
        const completion = {
            ...attempt,
            timestamp: Date.now(),
            found: incomingOrders.length,
            lastCompletedPage: Math.max(0, Number(completedState.currentPage || 1) - 1),
            totalPages: completedState.totalPages,
            reason: request.reason
        };
        await chrome.storage.local.set({
            orderData,
            amazonOrders: incomingOrders,
            amazonCancelledOrders: cancelledOrders,
            amazonCancelledUpdatedAt: Date.now(),
            amazonPaginationState: completedState,
            amazonParsingComplete: completion,
            amazonParsingIncomplete: null,
            amazonTimeoutAttempt: null
        });
        return {
            ok: true,
            status: 'committed',
            found: incomingOrders.length,
            existingCount: existingOrders.length,
            totalCount: uniqueOrders.length,
            uniqueOrdersCount: uniqueOrderIds.size
        };
    });
}

async function claimAmazonTimeoutAttempt(attempt) {
    return withAmazonAttemptMutation(async () => {
        const state = await chrome.storage.local.get([
            'pipelineRun', 'pipelineStage', 'multiAccountState',
            'amazonParserTabId', 'accountSwitchStartedAt', 'amazonPaginationState',
            'amazonParsingComplete', 'amazonTimeoutAttempt'
        ]);
        if (amazonCompletionMatchesAttempt(state, attempt)) {
            return { status: 'completion-won' };
        }
        if (!amazonWatchdogAttemptMatches(state, attempt)) {
            return { status: 'stale' };
        }
        if (amazonWatchdogAttemptIdentityMatches(state.amazonTimeoutAttempt, attempt)) {
            return { status: state.amazonTimeoutAttempt.phase || 'resolving' };
        }
        await chrome.storage.local.set({
            skipGuardAt: Date.now(),
            amazonTimeoutAttempt: {
                ...attempt,
                phase: 'resolving',
                resolvingAt: Date.now()
            }
        });
        return { status: 'claimed' };
    });
}

async function finalizeAmazonTimeoutAttempt(attempt, reason, found = 0) {
    return withAmazonAttemptMutation(() => withPipelineRunWrite(async () => {
        const state = await chrome.storage.local.get([
            'pipelineRun', 'pipelineStage', 'multiAccountState',
            'amazonParserTabId', 'accountSwitchStartedAt', 'amazonPaginationState',
            'amazonParsingComplete', 'amazonTimeoutAttempt'
        ]);
        if (amazonCompletionMatchesAttempt(state, attempt)) {
            return { status: 'completion-won' };
        }
        if (!amazonWatchdogAttemptMatches(state, attempt)
            || !amazonWatchdogAttemptIdentityMatches(state.amazonTimeoutAttempt, attempt)) {
            return { status: 'stale' };
        }

        const nextRun = applyPipelineAccountResult(
            state.pipelineRun,
            'amazon',
            attempt.account,
            { runId: attempt.runId, ok: false, reason, found }
        );
        if (!nextRun) return { status: 'stale' };
        const failedMarker = {
            ...attempt,
            phase: 'failed',
            reason,
            resolvedAt: Date.now()
        };
        await chrome.storage.local.set({
            pipelineRun: nextRun,
            amazonTimeoutAttempt: failedMarker,
            accountSwitchStartedAt: null,
            lastAmazonProgressAt: null,
            amazonPaginationState: null,
            amazonNavigationGraceUntil: null,
            amazonNavigationRecovery: null,
            amazonParsingIncomplete: null,
            skipGuardAt: null
        });
        return {
            status: 'failed',
            marker: failedMarker,
            multiAccountState: state.multiAccountState,
            pipelineStage: state.pipelineStage
        };
    }));
}

async function consumeAmazonCompletionMarker(expectedGeneration) {
    const claimed = await withAmazonAttemptMutation(() => withPipelineRunWrite(async () => {
        const state = await chrome.storage.local.get([
            'pipelineRun', 'pipelineStage', 'multiAccountState',
            'amazonParserTabId', 'amazonParsingComplete', 'amazonTimeoutAttempt',
            'accountSwitchStartedAt', 'amazonPaginationState', 'amazonStageFinalizing'
        ]);
        const marker = state.amazonParsingComplete;
        const account = normalizeAccountEmail(state.multiAccountState?.currentAmazonAccount);
        // A valid completion is allowed to heal an older timeout-failure marker
        // after a service-worker restart. The normal commit path serializes both,
        // but this makes the restart/migration state deterministic too.
        const ownership = marker?.timestamp
            ? amazonAttemptRefMatchesRuntime(
                marker,
                { ...state, amazonTimeoutAttempt: null },
                marker.parserTabId
            )
            : { ok: false };
        const valid = ownership.ok
            && pipelineGenerationMatches(state.pipelineStage, expectedGeneration)
            && normalizeAccountEmail(marker.account) === account
            && (!state.amazonPaginationState?.parseId
                || marker.parseId === state.amazonPaginationState.parseId);
        if (!valid) return { claimed: false };

        const nextRun = applyPipelineAccountResult(
            state.pipelineRun,
            'amazon',
            account,
            { runId: marker.runId, ok: true, found: marker.found || 0 }
        );
        if (!nextRun) return { claimed: false };
        await chrome.storage.local.set({
            pipelineRun: nextRun,
            amazonParsingComplete: null,
            amazonTimeoutAttempt: null,
            accountSwitchStartedAt: null,
            lastAmazonProgressAt: null,
            amazonNavigationGraceUntil: null,
            amazonNavigationRecovery: null,
            amazonParsingIncomplete: null,
            skipGuardAt: null
        });
        return {
            claimed: true,
            marker,
            multiAccountState: state.multiAccountState,
            pipelineStage: state.pipelineStage
        };
    }));
    if (!claimed.claimed) return false;

    isMultiAccountParsing = !!claimed.multiAccountState?.isMultiAccountParsing;
    amazonAccountsQueue = claimed.multiAccountState?.amazonAccountsQueue || [];
    currentAmazonAccount = claimed.multiAccountState?.currentAmazonAccount || null;
    const accountName = String(currentAmazonAccount || 'current').split('@')[0];
    parseReport.stores[`amazon_${accountName}`] = {
        found: claimed.marker.found || 0,
        status: '✅'
    };

    if (!await waitForScreenshotsDrained()) {
        return stopPipelineForScreenshotDrain(
            'Amazon completion screenshots blocked',
            expectedGeneration
        );
    }
    const gate = (await chrome.storage.local.get(['pipelineStage'])).pipelineStage;
    if (!gate?.active
        || !pipelineGenerationMatches(gate, expectedGeneration)
        || gate.stages?.[gate.currentIndex] !== 'amazon') {
        return false;
    }
    if (isMultiAccountParsing && amazonAccountsQueue.length > 0) {
        return switchToNextAmazonAccount(expectedGeneration);
    }
    if (isMultiAccountParsing) {
        isMultiAccountParsing = false;
        currentAmazonAccount = null;
        return beginAmazonStageFinalization(expectedGeneration);
    }
    return true;
}

async function retryAmazonPaginationNavigation(stored, now, timeoutReason) {
    if (amazonNavigationRetryInFlight) return amazonNavigationRetryInFlight;
    amazonNavigationRetryInFlight = retryAmazonPaginationNavigationOnce(stored, now, timeoutReason);
    try {
        return await amazonNavigationRetryInFlight;
    } finally {
        amazonNavigationRetryInFlight = null;
    }
}

async function retryAmazonPaginationNavigationOnce(stored, now, timeoutReason) {
    if (!amazonPaginationOwnershipMatches(stored.amazonPaginationState, stored)) {
        return { status: 'stale', reason: 'pagination-ownership-changed' };
    }
    const decision = getAmazonNavigationRetryDecision({
        paginationState: stored.amazonPaginationState,
        recovery: stored.amazonNavigationRecovery,
        timedOut: true,
        now
    });
    if (!decision.retry) {
        return {
            status: decision.reason === 'retry-gap' ? 'waiting' : 'unrecoverable',
            reason: decision.reason
        };
    }

    const tab = await getAmazonParserTab(stored.amazonParserTabId);
    if (!tab?.id) {
        await logMultiAccountStep('navigation-retry:failed', {
            reason: 'exact-parser-tab-not-found',
            targetPage: decision.targetPage,
            timeoutReason
        });
        return { status: 'unrecoverable', reason: 'exact-parser-tab-not-found' };
    }

    // Re-read after tabs.get under the same arbiter used by content commits and
    // account transitions. Cursor/recovery metadata and tabs.update are one
    // ordered mutation, not a sequence of TOCTOU checks.
    return withAmazonAttemptMutation(async () => {
    const fresh = await chrome.storage.local.get([
        'amazonPaginationState', 'amazonNavigationRecovery', 'amazonParserTabId',
        'pipelineRun', 'pipelineStage', 'multiAccountState'
    ]);
    const freshDecision = getAmazonNavigationRetryDecision({
        paginationState: fresh.amazonPaginationState,
        recovery: fresh.amazonNavigationRecovery,
        timedOut: true,
        now
    });
    if (!amazonPaginationOwnershipMatches(fresh.amazonPaginationState, fresh)
        || fresh.amazonPaginationState.parseId !== stored.amazonPaginationState.parseId
        || !freshDecision.retry
        || freshDecision.navId !== decision.navId
        || fresh.amazonParserTabId !== tab.id) {
        return { status: 'stale', reason: freshDecision.reason || 'navigation-generation-changed' };
    }

    // Persist only retry metadata; amazonPaginationState/allOrders stays owned
    // by the content script and cannot be rolled back by a stale watchdog.
    await chrome.storage.local.set({
        amazonNavigationRecovery: {
            navId: freshDecision.navId,
            parseId: fresh.amazonPaginationState.parseId,
            runId: fresh.amazonPaginationState.runId,
            account: fresh.amazonPaginationState.account,
            parserTabId: tab.id,
            retryCount: freshDecision.retryCount,
            lastRetryAt: now,
            timeoutReason
        },
        amazonParserTabId: tab.id,
        amazonNavigationGraceUntil: now + AMAZON_NAVIGATION_GRACE_MS,
        lastAmazonProgressAt: now,
        skipGuardAt: now
    });
    await logMultiAccountStep('navigation-retry:start', {
        tabId: tab.id,
        targetPage: freshDecision.targetPage,
        retryCount: freshDecision.retryCount,
        timeoutReason,
        targetUrl: freshDecision.targetUrl.slice(0, 200)
    });

    // Final generation check, immediately followed by the update call without
    // another await. This closes the page-18-arrived-during-log race.
    const guard = await chrome.storage.local.get([
        'amazonPaginationState', 'amazonParserTabId',
        'pipelineRun', 'pipelineStage', 'multiAccountState'
    ]);
    if (!amazonPaginationOwnershipMatches(guard.amazonPaginationState, guard)
        || guard.amazonPaginationState?.parseId !== fresh.amazonPaginationState.parseId
        || guard.amazonPaginationState?.navigation?.navId !== freshDecision.navId
        || guard.amazonParserTabId !== tab.id) {
        return { status: 'stale', reason: 'navigation-arrived-before-update' };
    }
    try {
        const updatePromise = chrome.tabs.update(tab.id, { url: freshDecision.targetUrl });
        await updatePromise;
        return { status: 'retried', navId: freshDecision.navId, targetPage: freshDecision.targetPage };
    } catch (e) {
        await logMultiAccountStep('navigation-retry:failed', {
            tabId: tab.id,
            targetPage: freshDecision.targetPage,
            retryCount: freshDecision.retryCount,
            reason: String(e?.message || e)
        });
        return { status: 'unrecoverable', reason: String(e?.message || e) };
    }
    });
}

async function captureAmazonTabWithDebugger(tabId) {
    let attached = false;
    try {
        await new Promise((resolve, reject) => {
            chrome.debugger.attach({ tabId }, '1.3', () => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                attached = true;
                resolve();
            });
        });
        const result = await new Promise((resolve, reject) => {
            chrome.debugger.sendCommand(
                { tabId },
                'Page.captureScreenshot',
                { format: 'png', fromSurface: true, captureBeyondViewport: false },
                response => {
                    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                    resolve(response);
                }
            );
        });
        return result?.data || '';
    } finally {
        if (attached) {
            await new Promise(resolve => chrome.debugger.detach({ tabId }, () => resolve()));
        }
    }
}

// iHerb cs watchdog: проверяет каждую минуту что content-iherb.js не залип
// (Extension context invalidated, infinite scroll стал, network 429 etc.).
// Если cs не отвечает >IHERB_PARSE_TIMEOUT_MS — retry tab.update (one shot), потом fail.
const IHERB_WATCHDOG_ALARM = 'iherbParseWatchdog';
const IHERB_PARSE_TIMEOUT_MS = 240_000; // 4 min hard cap для самого парсинга
// Отдельный таймаут на стадию переключения аккаунта (sign-out → login → /orders).
// 5 минут хватает на: 4с settle + login form fill + OAuth redirect + iherb page load.
// Если за это время iherbSwitchInProgress=true но iherbParseStartedAt так и не
// выставился — switch застрял (SW заснул, login страница не загрузилась и т.п.).
const IHERB_SWITCH_TIMEOUT_MS = 5 * 60_000;
chrome.alarms.create(IHERB_WATCHDOG_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });

// ─── Pipeline stage watchdog ──────────────────────────────────────────────
// Every stage EXCEPT eBay already had a safety-net (iHerb: 45s advance + iherbParseWatchdog;
// Amazon: amazonCompletionWatchdog). eBay had NONE — a hung eBay fetch left
// pipelineStage stuck at currentIndex='ebay' forever: Amazon never started and the
// FINAL Google Sheets upload (gated on storesCompleted.ebay && .iherb && .amazon) never
// fired. That silently froze the nightly upload for ALL stores from 2026-06-15 onward.
// This watchdog force-advances ANY stage that overruns its cap, so the run always reaches
// 'done' and uploads — even if one store is broken or rate-limited (eBay limitexceeded).
const PIPELINE_WATCHDOG_ALARM = 'pipelineStageWatchdog';
const PIPELINE_STAGE_MAX_MS = {
  // 06.08.2026: подняты после того, как Amazon в отчёте давал «found 0 ⏱» КАЖДЫЙ прогон
  // с 05.08. Причина не поломка магазина: 05.08 паузу между страницами подняли 2с→5с
  // (иначе Amazon отшивал страницу трека), а лимиты остались старыми — живой обход не
  // укладывался, сторож рубил его и второй кабинет не читался вовсе. Замер 06.08: Amazon
  // ~40 мин на кабинет × 2 кабинета, iHerb ~26 мин на три кабинета (лимит был 25 — впритык).
  // Это ГРУБАЯ подстраховка: настоящее зависание ловит сторож прогресса (4 мин без движения).
  iherb: 50 * 60_000,   // 3 аккаунта: парсинг ×3 + 2 переключения (+5 мин ретрай логина) + возврат
  ebay:  15 * 60_000,   // 40 pages + detail-page tracking enrichment
  amazon: 100 * 60_000  // 2 кабинета × 20 страниц с паузой 5с; свой сторож прогресса тоже есть
};
// Очередь кадров может быть большой (129 карточек заняли 32 минуты в ночь
// 17→18.08). Эти минуты не являются зависанием парсера и не должны съедать
// stage cap. Кредит всё равно ограничен: сломанная/вечная очередь не сможет
// скрывать зависшую стадию бесконечно.
const SCREENSHOT_STAGE_BUDGET_MAX_MS = 6 * 60 * 60_000;
chrome.alarms.create(PIPELINE_WATCHDOG_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });

function getScreenshotStageBudgetCreditMs({
  budget,
  stageName,
  stageStartedAt,
  queueHasItems,
  now = Date.now()
}) {
  if (!budget
      || budget.stageName !== stageName
      || budget.stageStartedAt !== stageStartedAt) {
    return 0;
  }

  let creditMs = Math.max(0, Number(budget.accruedMs) || 0);
  // activeSince переживает сон/рестарт MV3. Открытый хвост считаем только
  // когда persisted queue действительно непуста. Иначе stale activeSince
  // мог бы спрятать настоящее зависание стадии после уже очищенной очереди.
  if (queueHasItems && Number.isFinite(budget.activeSince)) {
    creditMs += Math.max(0, now - Math.max(stageStartedAt, budget.activeSince));
  }
  return Math.min(creditMs, SCREENSHOT_STAGE_BUDGET_MAX_MS);
}

function getEffectivePipelineStageElapsedMs({ now, startedAt, screenshotCreditMs }) {
  const wallMs = Math.max(0, now - startedAt);
  return Math.max(0, wallMs - Math.max(0, Number(screenshotCreditMs) || 0));
}

async function closeStaleScreenshotStageBudget(pipelineStage, budget) {
  if (!budget?.activeSince) return;
  const stageName = pipelineStage?.stages?.[pipelineStage.currentIndex];
  const stageStartedAt = pipelineStage?.stageStartedAt || pipelineStage?.startedAt || 0;
  if (budget.stageName !== stageName || budget.stageStartedAt !== stageStartedAt) return;

  // Перечитываем прямо перед записью: queueTrackScreenshot мог долить карточку,
  // пока watchdog считал elapsed.
  const fresh = await chrome.storage.local.get(['screenshotStageBudget', 'trackScreenshotQueue']);
  const freshBudget = fresh.screenshotStageBudget;
  if (!freshBudget
      || freshBudget.activeSince !== budget.activeSince
      || (Array.isArray(fresh.trackScreenshotQueue) && fresh.trackScreenshotQueue.length > 0)) {
    return;
  }
  await chrome.storage.local.set({
    screenshotStageBudget: { ...freshBudget, activeSince: null, staleClosedAt: Date.now() }
  });
  console.warn('[pipelineWatchdog] closed stale screenshotStageBudget: persisted queue is empty');
}

async function handlePipelineWatchdog() {
  const r = await chrome.storage.local.get([
    'pipelineStage', 'screenshotStageBudget', 'trackScreenshotQueue'
  ]);
  const p = r.pipelineStage;
  if (!p || !p.active) return;
  const generation = pipelineGenerationFromStage(p);
  const stage = p.stages[p.currentIndex];
  if (stage === 'done') return;
  // stageStartedAt is stamped in runPipelineStage; fall back to pipeline startedAt.
  const startedAt = p.stageStartedAt || p.startedAt || 0;
  if (!startedAt) return;
  const now = Date.now();
  const rawElapsed = now - startedAt;
  const queueHasItems = Array.isArray(r.trackScreenshotQueue) && r.trackScreenshotQueue.length > 0;
  const screenshotCreditMs = getScreenshotStageBudgetCreditMs({
    budget: r.screenshotStageBudget,
    stageName: stage,
    stageStartedAt: startedAt,
    queueHasItems,
    now
  });
  if (r.screenshotStageBudget?.activeSince && !queueHasItems) {
    await closeStaleScreenshotStageBudget(p, r.screenshotStageBudget);
  }
  const afterBudget = (await chrome.storage.local.get(['pipelineStage'])).pipelineStage;
  if (!afterBudget?.active || !pipelineGenerationMatches(afterBudget, generation)) return;
  const elapsed = getEffectivePipelineStageElapsedMs({
    now,
    startedAt,
    screenshotCreditMs
  });
  const cap = PIPELINE_STAGE_MAX_MS[stage] || 15 * 60_000;
  if (elapsed < cap) return;

  console.warn(`[pipelineWatchdog] stage '${stage}' stuck ${Math.round(elapsed/1000)}s effective (${Math.round(rawElapsed/1000)}s wall, screenshot credit ${Math.round(screenshotCreditMs/1000)}s, cap ${Math.round(cap/1000)}s) — force-advancing so the run can still upload`);
  const finalizationState = await chrome.storage.local.get([
    'pipelineStage',
    stage === 'iherb' ? 'iherbStageFinalizing' : 'amazonStageFinalizing',
    stage === 'iherb' ? 'iherbFinalReturnConfirmed' : 'amazonFinalReturnConfirmed'
  ]);
  const finalizing = stage === 'iherb'
    ? finalizationState.iherbStageFinalizing
    : stage === 'amazon'
      ? finalizationState.amazonStageFinalizing
      : null;
  const confirmation = stage === 'iherb'
    ? finalizationState.iherbFinalReturnConfirmed
    : stage === 'amazon'
      ? finalizationState.amazonFinalReturnConfirmed
      : null;
  if (finalizing && pipelineGenerationMatches(finalizing, generation)) {
    if (finalReturnConfirmationMatches(confirmation, finalizing)) {
      if (stage === 'iherb') await resumeIherbStageFinalization(finalizing, generation);
      else await resumeAmazonStageFinalization(finalizing, generation);
      return;
    }
    const failedMarker = {
      ...finalizing,
      returnStatus: 'failed',
      resolvedAt: Date.now(),
      reason: 'final-primary-return-timeout'
    };
    await chrome.storage.local.set(stage === 'iherb'
      ? { iherbStageFinalizing: failedMarker }
      : { amazonStageFinalizing: failedMarker });
    const finalizingGate = (await chrome.storage.local.get(['pipelineStage'])).pipelineStage;
    if (!finalizingGate?.active
        || !pipelineGenerationMatches(finalizingGate, generation)) return;
    if (stage === 'iherb') await resumeIherbStageFinalization(failedMarker, generation);
    else await resumeAmazonStageFinalization(failedMarker, generation);
    return;
  }
  // Mark the stuck store 'completed' so the final upload gate can pass without it.
  // It TIMED OUT (not succeeded) — its data just won't be fresh this run; the other
  // stores still upload. Mirrors the proven iHerb-watchdog pattern (storesCompleted +
  // checkAllStoresCompleted from alarm context).
  if (stage === 'ebay' || stage === 'iherb' || stage === 'amazon') {
    const runState = await chrome.storage.local.get(['pipelineRun']);
    if (runState.pipelineRun?.id !== generation?.runId
        || !['starting', 'running'].includes(runState.pipelineRun?.status)) return;
    const expected = runState.pipelineRun?.expected?.[stage] || [];
    if (!await markPipelineStageTimeout(stage, expected, generation)) return;
    const beforeSideEffects = (await chrome.storage.local.get(['pipelineStage'])).pipelineStage;
    if (!beforeSideEffects?.active
        || !pipelineGenerationMatches(beforeSideEffects, generation)) return;
    try { if (!parseReport.stores[stage]) parseReport.stores[stage] = { found: 0, status: '⏱' }; } catch (_) {}
  }
  sendTelegramMessage(`⏱ Парс: стадия «${stage}» зависла (${Math.round(elapsed/60000)} мин) — пропускаю, чтобы прогон дошёл до выгрузки в таблицу`).catch(() => {});
  if (stage === 'iherb') {
    await finalizeIherbStage(undefined, {
      fromCaptcha: true,
      expectedGeneration: generation
    });
    return;
  }
  if (stage === 'amazon') {
    await beginAmazonStageFinalization(generation);
    return;
  }
  if (typeof storesCompleted === 'object') storesCompleted[stage] = true;
  setParserLock(stage, false);
  // Guard: only advance if we're still on the stuck stage (a late real 'Done ✅' may
  // have advanced it already — then this is a no-op via advancePipelineStage's checks).
  const cur = (await chrome.storage.local.get(['pipelineStage'])).pipelineStage;
  if (cur && cur.active
      && pipelineGenerationMatches(cur, generation)
      && cur.stages[cur.currentIndex] === stage) {
    await advancePipelineStage(generation);
  }
  if (typeof checkAllStoresCompleted === 'function') checkAllStoresCompleted();
}

// ─── Sheets upload watchdog (надёжность выгрузки, инцидент 2026-07-03) ──────
// Финальная выгрузка в Google Sheets раньше ретраилась ×3 через setTimeout В ПАМЯТИ.
// MV3 усыпляет service worker → цепочка setTimeout умирает, ретрай не возобновляется,
// и данные молча не доезжают до таблицы до утра (пока оператор не перезапустит вручную).
// Этот alarm переживает сон/смерть SW и догоняет выгрузку по персистентному маркеру
// pendingSheetsUpload. Тик раз в 2 минуты, до 12 попыток (~24 мин), потом — алерт оператору.
const SHEETS_UPLOAD_WATCHDOG_ALARM = 'sheetsUploadWatchdog';
const SHEETS_UPLOAD_MAX_RETRIES = 12;
chrome.alarms.create(SHEETS_UPLOAD_WATCHDOG_ALARM, { delayInMinutes: 2, periodInMinutes: 2 });

// The durable pending marker lets an MV3 restart resume an upload, but it does
// not serialize two callbacks inside the same service-worker lifetime. Keep a
// separate lock around the actual read/dedupe/write transaction so the normal
// completion timer and the alarm watchdog can never append the same run twice.
let finalSheetsUploadInFlight = null;

function getOrStartFinalSheetsUpload(runId, { source = 'unknown', beforeStart = null } = {}) {
    if (!runId) throw new Error('missing final Sheets upload runId');
    if (finalSheetsUploadInFlight) {
        if (finalSheetsUploadInFlight.runId !== runId) {
            throw new Error(`Sheets upload ${finalSheetsUploadInFlight.runId} is still active`);
        }
        return {
            joined: true,
            source: finalSheetsUploadInFlight.source,
            promise: finalSheetsUploadInFlight.promise
        };
    }

    const record = { runId, source, promise: null };
    record.promise = (async () => {
        const state = await chrome.storage.local.get([
            'pipelineRun', 'pipelineStage', 'pendingSheetsUpload',
            'lastSheetsUploadRunId', 'lastSheetsUploadOkAt'
        ]);
        const run = state.pipelineRun;
        const stage = state.pipelineStage;
        if (run?.id !== runId
            || !['completed', 'degraded'].includes(run?.status)
            || !Number.isFinite(run?.finishedAt)
            || stage?.runId !== runId
            || stage?.active !== false
            || stage?.stages?.[stage.currentIndex] !== 'done') {
            throw new Error('final Sheets upload does not own the terminal pipeline run');
        }

        if (state.lastSheetsUploadRunId === runId
            && Number.isFinite(state.lastSheetsUploadOkAt)
            && state.lastSheetsUploadOkAt >= run.finishedAt) {
            if (state.pendingSheetsUpload?.runId === runId) {
                await chrome.storage.local.set({
                    pendingSheetsUpload: null,
                    sheetsRetryCount: 0,
                    sheetsRetryGaveUp: false
                });
            }
            return { status: 'already-uploaded', runId };
        }
        if (state.pendingSheetsUpload?.runId !== runId) {
            throw new Error('final Sheets upload has no matching durable pending marker');
        }

        // The watchdog increments its persistent retry counter only when it
        // really owns a new attempt. A caller joining an existing timer never
        // consumes another retry.
        if (typeof beforeStart === 'function') await beforeStart();
        await uploadToSheets(runId);
        await uploadLogsToSheet();
        await markSheetsUploadSuccess(runId);
        return { status: 'uploaded', runId };
    })();
    finalSheetsUploadInFlight = record;
    const clear = () => {
        if (finalSheetsUploadInFlight === record) finalSheetsUploadInFlight = null;
    };
    record.promise.then(clear, clear);
    return { joined: false, source, promise: record.promise };
}

// Единая точка фиксации «данные РЕАЛЬНО в таблице». Ставит честные ключи, гасит
// маркер и сбрасывает счётчик ретраев. Вызывается и в штатном пути
// (checkAllStoresCompleted), и в alarm-ретрае — честный флаг всегда один и тот же.
async function markSheetsUploadSuccess(runId) {
    if (!runId) throw new Error('missing Sheets upload runId');
    const now = Date.now();
    const runState = await chrome.storage.local.get(['pipelineRun', 'pendingSheetsUpload']);
    if (runState.pipelineRun?.id !== runId
        || !['completed', 'degraded'].includes(runState.pipelineRun?.status)
        || !Number.isFinite(runState.pipelineRun?.finishedAt)
        || runState.pendingSheetsUpload?.runId !== runId) {
        throw new Error('stale Sheets upload cannot stamp the current run');
    }
    // Дата «зелёного» прогона по таймзоне склада (America/New_York), YYYY-MM-DD.
    let nyDate = '';
    try {
        nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    } catch (_) {
        nyDate = new Date().toISOString().split('T')[0];
    }
    const successfulRunFields = runState.pipelineRun.status === 'completed' ? {
        lastSuccessfulDailyRunAt: now,
        lastSuccessfulDailyRunDate: nyDate
    } : {};
    await chrome.storage.local.set({
        lastSheetsUploadOkAt: now,       // существующий ключ — читает внешний сторож
        lastSheetsUploadRunId: runId,
        pendingSheetsUpload: null,
        sheetsRetryCount: 0,
        sheetsRetryGaveUp: false,
        ...successfulRunFields
    });
}

// Приём внешних команд сторожа (watchdog/parser-watchdog.mjs пишет
// externalControlRequest в chrome.storage.local). Обрабатывается в alarm-тике —
// значит переживает сон SW. Идемпотентность через lastHandledControlAt.
async function handleExternalControlRequest() {
    const s = await chrome.storage.local.get([
        'externalControlRequest', 'lastHandledControlAt',
        'pendingSheetsUpload', 'lastSheetsUploadOkAt', 'lastDailyAutoParseFinishedAt',
        'pipelineStage', 'lastDailyAutoParseTriggeredAt'
    ]);
    const req = s.externalControlRequest;
    if (!req || !req.action || !req.requestedAt) return;
    // Уже обработали эту команду — не переисполняем.
    if (req.requestedAt <= (s.lastHandledControlAt || 0)) return;

    if (req.action === 'reupload_sheets') {
        // Пинок заглохшему ретраю: если выгрузка ещё не подтверждена — сбрасываем
        // счётчик и флаг «сдался», фактическую выгрузку выполнит sheetsUploadWatchdog-тик.
        const uploaded = s.lastSheetsUploadOkAt && s.lastDailyAutoParseFinishedAt
            && s.lastSheetsUploadOkAt >= s.lastDailyAutoParseFinishedAt;
        if (s.pendingSheetsUpload && !uploaded) {
            await chrome.storage.local.set({ sheetsRetryCount: 0, sheetsRetryGaveUp: false });
        }
    } else if (req.action === 'start_pipeline') {
        // Защита от двойных прогонов: только если пайплайн не активен, прогон в этот
        // слот ещё не запускался и с момента слота 23:00 прошло < 3 ч.
        const slot = getLastDailyRunSlot(new Date()).getTime();
        const alreadyTriggered = s.lastDailyAutoParseTriggeredAt && s.lastDailyAutoParseTriggeredAt >= slot;
        const sinceSlotMs = Date.now() - slot;
        if (!s.pipelineStage?.active && !alreadyTriggered && sinceSlotMs < 3 * 60 * 60 * 1000) {
            runDailyAutoParse('watchdog-control');
        }
    }

    await chrome.storage.local.set({
        lastHandledControlAt: req.requestedAt,
        externalControlRequest: null,
        externalControlResult: { action: req.action, ok: true, at: Date.now() }
    });
}

async function handleSheetsUploadWatchdog() {
    // Внешние команды сторожа — в начале тика (alarm-backed, переживает сон SW).
    await handleExternalControlRequest().catch(e => console.warn('[sheetsUploadWatchdog] control error:', e?.message || e));

    const s = await chrome.storage.local.get([
        'lastDailyAutoParseStatus', 'lastDailyAutoParseFinishedAt', 'lastSheetsUploadOkAt',
        'pendingSheetsUpload', 'sheetsRetryCount', 'sheetsRetryGaveUp', 'pipelineStage',
        'pipelineRun', 'lastSheetsUploadRunId'
    ]);

    // Никаких гонок с активной выгрузкой: не трогаем при свежем прогоне или
    // не-completed статусе.
    if (s.pipelineStage?.active) return;
    if (!['completed', 'degraded'].includes(s.lastDailyAutoParseStatus)) return;
    if (!s.lastDailyAutoParseFinishedAt) return;

    const pending = s.pendingSheetsUpload;
    if (!pending) return;
    if (!pending.runId
        || pending.runId !== s.pipelineRun?.id
        || !['completed', 'degraded'].includes(s.pipelineRun?.status)
        || s.pipelineStage?.runId !== pending.runId) return;

    // Уже залито (штатным путём или прошлым тиком) — гасим маркер, no-op дальше.
    if (s.lastSheetsUploadRunId === pending.runId
        && s.lastSheetsUploadOkAt
        && s.lastSheetsUploadOkAt >= s.lastDailyAutoParseFinishedAt) {
        await chrome.storage.local.set({ pendingSheetsUpload: null, sheetsRetryCount: 0, sheetsRetryGaveUp: false });
        return;
    }

    const retryCount = s.sheetsRetryCount || 0;
    if (retryCount >= SHEETS_UPLOAD_MAX_RETRIES) {
        if (!s.sheetsRetryGaveUp) {
            await chrome.storage.local.set({ sheetsRetryGaveUp: true });
            sendTelegramMessage('❗ Выгрузка в Sheets не удалась за 12 попыток (~24 мин), нужен оператор').catch(() => {});
        }
        return; // no-op пока не появится новый pendingSheetsUpload
    }

    try {
        const upload = getOrStartFinalSheetsUpload(pending.runId, {
            source: 'watchdog',
            // Инкремент ДО собственной попытки — чтобы бесконечно висящий upload
            // не крутил счётчик вечно. При join этот callback не запускается.
            beforeStart: () => chrome.storage.local.set({ sheetsRetryCount: retryCount + 1 })
        });
        if (upload.joined) {
            console.log(`⏳ sheetsUploadWatchdog: присоединился к ${upload.source}`);
        }
        await upload.promise;
        if (upload.joined) return;
        console.log(`✅ sheetsUploadWatchdog: догнал выгрузку (попытка ${retryCount + 1})`);
    } catch (e) {
        console.error(`❌ sheetsUploadWatchdog: попытка ${retryCount + 1} провалилась:`, e?.message || e);
        // Просто выходим — alarm повторит через 2 мин.
    }
}

function startCompletionWatchdog() {
    console.log('👀 Starting completion watchdog with chrome.alarms...');
    // Create alarm that fires every 5 seconds (minimum is 0.5 minutes for production, but we use 0.1 for dev)
    chrome.alarms.create(WATCHDOG_ALARM_NAME, { 
        delayInMinutes: 0.05,  // First check in 3 seconds
        periodInMinutes: 0.05  // Then every 3 seconds (0.05 min = 3 sec)
    });
}

function stopCompletionWatchdog() {
    chrome.alarms.clear(WATCHDOG_ALARM_NAME);
    console.log('🛑 Watchdog alarm stopped');
}

// iHerb watchdog handler — запускается раз в минуту.
// Проверяет если cs auto-parse залип >4 минут — retry tab.update (one shot), потом fail.
function iherbWatchdogAttemptFromState(state) {
    return {
        generation: pipelineGenerationFromStage(state?.pipelineStage),
        runId: state?.pipelineRun?.id || null,
        stageStartedAt: state?.pipelineStage?.stageStartedAt || null,
        account: normalizeAccountEmail(state?.multiAccountIherbState?.currentIherbAccount),
        parserTabId: state?.iherbParserTabId || null,
        parseStartedAt: state?.iherbParseStartedAt ?? null,
        retried: state?.iherbWatchdogRetried ?? null,
        switchStartedAt: state?.iherbSwitchStartedAt ?? null,
        switchInProgress: state?.iherbSwitchInProgress === true,
        pendingRunId: state?.pendingIherbSwitch?.runId || null,
        pendingAccount: normalizeAccountEmail(state?.pendingIherbSwitch?.email)
    };
}

function iherbWatchdogAttemptMatches(state, attempt) {
    const current = iherbWatchdogAttemptFromState(state);
    return !!attempt?.runId
        && !!attempt?.account
        && state?.pipelineStage?.active === true
        && state.pipelineStage.stages?.[state.pipelineStage.currentIndex] === 'iherb'
        && ['starting', 'running'].includes(state?.pipelineRun?.status)
        && current.runId === attempt.runId
        && pipelineGenerationMatches(state.pipelineStage, attempt.generation)
        && current.account === attempt.account
        && current.parserTabId === attempt.parserTabId
        && current.attemptId === attempt.attemptId
        && current.parseStartedAt === attempt.parseStartedAt
        && current.retried === attempt.retried
        && current.switchStartedAt === attempt.switchStartedAt
        && current.switchInProgress === attempt.switchInProgress
        && current.pendingRunId === attempt.pendingRunId
        && current.pendingAccount === attempt.pendingAccount;
}

async function readIherbWatchdogState() {
    return chrome.storage.local.get([
        'iherbParseStartedAt', 'iherbWatchdogRetried',
        'iherbParseAttemptId', 'iherbTimeoutAttempt', 'iherbParsingComplete',
        'iherbSwitchInProgress', 'iherbSwitchStartedAt', 'pendingIherbSwitch',
        'multiAccountIherbState', 'iherbParserTabId', 'pipelineRun', 'pipelineStage'
    ]);
}

async function handleIherbWatchdog() {
    const stored = await readIherbWatchdogState();
    const attempt = iherbWatchdogAttemptFromState(stored);
    if (!iherbWatchdogAttemptMatches(stored, attempt)) return;
    if (iherbAttemptIdentityMatches(stored.iherbParsingComplete, attempt)) {
        await consumeIherbCompletionMarker(attempt.generation);
        return;
    }

    // Ветка A: переключение аккаунта застряло. Это случай когда мы выставили
    // iherbSwitchInProgress=true в switchToNextIherbAccount, но cs-парсер так
    // и не прислал parserStarted (iherbParseStartedAt пусто) — значит login
    // страница не загрузилась / cs не запустился / SW заснул посреди sign-out.
    // Без этой ветки watchdog был слепой: ждал iherbParseStartedAt которого
    // никогда не будет, а pipeline зависал на iherb-стадии навсегда.
    if (!stored.iherbParseStartedAt
        && stored.iherbSwitchInProgress
        && stored.iherbSwitchStartedAt) {
        const switchElapsed = Date.now() - stored.iherbSwitchStartedAt;
        if (switchElapsed >= IHERB_SWITCH_TIMEOUT_MS) {
            const acc = stored.multiAccountIherbState?.currentIherbAccount || 'unknown';
            console.log(`[iherbWatchdog] switch deadlock: acc=${acc}, elapsed=${Math.round(switchElapsed/1000)}s`);
            const fresh = await readIherbWatchdogState();
            if (!iherbWatchdogAttemptMatches(fresh, attempt)) return;
            sendTelegramMessage(`🚫 iHerb (${acc.split('@')[0]}) переключение зависло ${Math.round(switchElapsed/60000)} мин — двигаю pipeline`).catch(()=>{});

            // Восстановим in-memory state на случай если SW рестартил между alarm-тиками.
            if (fresh.multiAccountIherbState) {
                isMultiAccountIherb = fresh.multiAccountIherbState.isMultiAccountIherb;
                iherbAccountsQueue = fresh.multiAccountIherbState.iherbAccountsQueue || [];
                currentIherbAccount = fresh.multiAccountIherbState.currentIherbAccount;
            }
            await handleIherbSwitchFailure(acc, 'switch_timeout', attempt.runId).catch(e => {
                console.warn('[iherbWatchdog] handleIherbSwitchFailure threw:', e?.message || e);
            });
        }
        return;
    }

    if (!stored.iherbParseStartedAt) return; // нет активного парса — нечего watch'ить
    const elapsed = Date.now() - stored.iherbParseStartedAt;
    if (elapsed < IHERB_PARSE_TIMEOUT_MS) return; // ещё не таймаут
    const tabId = stored.iherbParserTabId;
    const acc = stored.multiAccountIherbState?.currentIherbAccount || 'unknown';

    // Прочитать heartbeat из tab.localStorage
    let heartbeat = null;
    if (tabId) {
        try {
            const [{ result }] = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    try { return JSON.parse(window.localStorage.getItem('parser_iherb_heartbeat') || 'null'); } catch { return null; }
                }
            });
            heartbeat = result;
        } catch (e) {
            console.warn('[iherbWatchdog] executeScript failed:', e?.message || e);
        }
    }

    const heartbeatAge = heartbeat ? Date.now() - heartbeat.ts : null;
    console.log(`[iherbWatchdog] iHerb stuck: acc=${acc}, elapsed=${Math.round(elapsed/1000)}s, heartbeat=${JSON.stringify(heartbeat)}, hbAge=${heartbeatAge}`);
    const afterHeartbeat = await readIherbWatchdogState();
    if (!iherbWatchdogAttemptMatches(afterHeartbeat, attempt)) {
        console.warn('⏭ iHerb watchdog attempt changed while reading heartbeat');
        return;
    }

    if (!stored.iherbWatchdogRetried) {
        // First retry: reload tab → cs снова auto-parse'нет.
        const retryStartedAt = Date.now();
        const retryAttemptId = `${attempt.runId}:${attempt.account}:${retryStartedAt}:${Math.random().toString(36).slice(2, 8)}`;
        const rotation = await withIherbAttemptMutation(async () => {
            const fresh = await readIherbWatchdogState();
            if (iherbAttemptIdentityMatches(fresh.iherbParsingComplete, attempt)) {
                return { status: 'completion-won' };
            }
            if (!iherbWatchdogAttemptMatches(fresh, attempt)) return { status: 'stale' };
            await chrome.storage.local.set({
                iherbWatchdogRetried: true,
                iherbParseStartedAt: retryStartedAt,
                iherbParseAttemptId: retryAttemptId,
                iherbTimeoutAttempt: null,
                iherbParsingComplete: null
            });
            return { status: 'rotated' };
        });
        if (rotation.status === 'completion-won') {
            await consumeIherbCompletionMarker(attempt.generation);
            return;
        }
        if (rotation.status !== 'rotated') return;
        console.log(`⚠️ iHerb (${acc.split('@')[0]}) залип ${Math.round(elapsed/1000)}с, retry...`);
        if (tabId) {
            try {
                const retryGate = await readIherbWatchdogState();
                const retryOwned = retryGate.pipelineStage?.active === true
                    && pipelineGenerationMatches(retryGate.pipelineStage, attempt.generation)
                    && retryGate.pipelineStage.stages?.[retryGate.pipelineStage.currentIndex] === 'iherb'
                    && retryGate.pipelineRun?.id === attempt.runId
                    && normalizeAccountEmail(retryGate.multiAccountIherbState?.currentIherbAccount) === attempt.account
                    && retryGate.iherbParserTabId === tabId
                    && retryGate.iherbWatchdogRetried === true
                    && retryGate.iherbParseStartedAt === retryStartedAt
                    && retryGate.iherbParseAttemptId === retryAttemptId;
                if (!retryOwned) return;
                await chrome.tabs.update(tabId, { url: 'https://secure.iherb.com/myaccount/orders', active: true });
                console.log('[iherbWatchdog] retry: tab.update sent');
            } catch (e) {
                console.warn('[iherbWatchdog] retry tab.update failed:', e?.message || e);
            }
        }
        return;
    }

    // Already retried — fail this account, move forward.
    console.log(`[iherbWatchdog] Already retried — failing iherb acc=${acc}, moving to next`);
    sendTelegramMessage(`🚫 iHerb (${acc.split('@')[0]}) не отвечает после retry — пропускаю`).catch(()=>{});
    // Timeout and a late content completion compete under one exact-attempt
    // arbiter. The winner is durable before any queue mutation; a late Done can
    // neither erase the failure nor shift the iHerb queue a second time.
    const resolution = await commitIherbTimeoutOutcome(attempt, 'parse_timeout');
    if (resolution.status === 'completion-won') {
        await consumeIherbCompletionMarker(attempt.generation);
        return;
    }
    if (resolution.status !== 'failed') return;

    // Restore in-memory state if SW restarted between alarm ticks
    if (resolution.multiAccountIherbState) {
        isMultiAccountIherb = resolution.multiAccountIherbState.isMultiAccountIherb;
        iherbAccountsQueue = resolution.multiAccountIherbState.iherbAccountsQueue || [];
        currentIherbAccount = resolution.multiAccountIherbState.currentIherbAccount;
    }
    if (isMultiAccountIherb && iherbAccountsQueue.length > 0) {
        await switchToNextIherbAccount(attempt.generation);
    } else if (isMultiAccountIherb) {
        // Очередь пуста, но стадия ещё не закрыта — закрываем через единый
        // chokepoint (возврат на primary + roster + алерт + advance pipeline).
        // Guard `isMultiAccountIherb` + внутренний storesCompleted-guard
        // finalizeIherbStage защищают от двойного завершения.
        await finalizeIherbStage(tabId, { expectedGeneration: attempt.generation })
            .catch(e => console.warn('finalizeIherbStage failed:', e?.message || e));
    }
}

// Alarm listener - this fires even when Service Worker wakes up
chrome.alarms.onAlarm.addListener(async (alarm) => {
    // Handle daily auto-parse
    if (alarm.name === DAILY_ALARM_NAME) {
        console.log('⏰ Daily auto-parse alarm triggered!');
        await addDailyDiagnostic('alarm-fired', {
            scheduledTime: alarm.scheduledTime || null,
            periodInMinutes: alarm.periodInMinutes || null
        });

        await ensureDailyAlarm('daily-alarm-fired');

        const now = new Date();
        const expectedSlot = getLastDailyRunSlot(now).getTime();
        const scheduledTime = Number(alarm.scheduledTime) || 0;
        const slotDriftMs = Math.abs(scheduledTime - expectedSlot);
        const fireAgeMs = now.getTime() - scheduledTime;
        if (!scheduledTime
            || slotDriftMs > DAILY_ALARM_DRIFT_TOLERANCE_MS
            || fireAgeMs < -DAILY_ALARM_DRIFT_TOLERANCE_MS
            || fireAgeMs > DAILY_MISSED_RUN_CATCHUP_MS) {
            await addDailyDiagnostic('alarm-stale-skip', {
                scheduledTime: scheduledTime || null,
                expectedSlot,
                slotDriftMs,
                fireAgeMs
            });
            console.warn('⏸ Ignoring stale/wrong-slot daily alarm');
            return;
        }

        const settings = await chrome.storage.local.get(['dailyAutoParseEnabled']);
        if (settings.dailyAutoParseEnabled === false) {
            console.log('⏰ Auto-parse is disabled, skipping');
            await chrome.storage.local.set({
                lastDailyAutoParseTriggeredAt: Date.now(),
                lastDailyAutoParseSource: 'alarm',
                lastDailyAutoParseStatus: 'disabled'
            });
            await addDailyDiagnostic('run-skip', { source: 'alarm', skipReason: 'disabled' });
            return;
        }

        await runDailyAutoParse('alarm');
        return;
    }
    
    if (alarm.name === SCREENSHOT_RESUME_ALARM) {
        try {
            const { trackScreenshotQueue: stored = [] } = await chrome.storage.local.get('trackScreenshotQueue');
            if (Array.isArray(stored) && stored.length > 0 && !isProcessingScreenshots) {
                console.log(`⏰ screenshotResume: ${stored.length} stuck in queue, resuming`);
                processScreenshotQueue();
            }
        } catch (_) {}
        return;
    }

    if (alarm.name === IHERB_WATCHDOG_ALARM) {
        await handleIherbWatchdog().catch(e => console.warn('[iherbWatchdog] error:', e?.message || e));
        return;
    }

    if (alarm.name === PIPELINE_WATCHDOG_ALARM) {
        await handlePipelineWatchdog().catch(e => console.warn('[pipelineWatchdog] error:', e?.message || e));
        return;
    }

    // Надёжность выгрузки в Sheets (инцидент 2026-07-03): alarm-backed ретрай +
    // приём внешних команд сторожа. Переживает сон/смерть SW.
    if (alarm.name === SHEETS_UPLOAD_WATCHDOG_ALARM) {
        await handleSheetsUploadWatchdog().catch(e => console.warn('[sheetsUploadWatchdog] error:', e?.message || e));
        return;
    }

    if (alarm.name !== WATCHDOG_ALARM_NAME) return;

    const stored = await chrome.storage.local.get([
        'amazonParsingComplete', 'multiAccountState', 'accountSwitchStartedAt',
        'lastAmazonProgressAt', 'skipGuardAt', 'amazonPaginationState',
        'amazonNavigationGraceUntil', 'amazonNavigationRecovery',
        'amazonParsingIncomplete', 'amazonParserTabId', 'pipelineRun', 'pipelineStage'
    ]);

    // Skip-guard mutex: alarm fires every 3s, but skip-path takes 5-10s
    // (screenshot + Telegram photo + log + remove + switch). Without this guard, a
    // second alarm tick reads stale accountSwitchStartedAt AFTER first remove() but
    // BEFORE switchToNextAmazonAccount's new set() commits — triggering duplicate
    // timeout that kills the newly-switched account (observed 2026-04-22 03:59:26:
    // ipochtoy timed out at 600s, photopochtoy switched + parse-started, second
    // watchdog fired 3s later with stale data, killed photopochtoy mid-parse).
    if (stored.skipGuardAt && (Date.now() - stored.skipGuardAt < 30000)) {
        return;
    }

    const incompleteAccount = normalizeAccountEmail(stored.amazonParsingIncomplete?.account);
    const activeAmazonAccount = normalizeAccountEmail(stored.multiAccountState?.currentAmazonAccount);
    const matchingIncomplete = !!stored.amazonParsingIncomplete
        && stored.amazonParsingIncomplete.runId === stored.pipelineRun?.id
        && incompleteAccount
        && incompleteAccount === activeAmazonAccount
        && stored.amazonParsingIncomplete.parserTabId === stored.amazonParserTabId;
    if (stored.amazonParsingIncomplete && !matchingIncomplete) {
        await chrome.storage.local.set({ amazonParsingIncomplete: null });
    }

    // TIMEOUT: progress-based (idle) + hard cap.
    // Old logic killed after 90s from switch-start — fatally short for accounts with
    // 20 pages. New logic: kill if no parsing progress for 10 minutes, or if a
    // single cabinet exceeds the measured 45-minute ceiling. The old 20-minute
    // cap guaranteed a false timeout for healthy 40-minute histories.
    const activeAttempt = amazonWatchdogAttemptFromState(stored);
    const hasMatchingCompletion = amazonCompletionMatchesAttempt(stored, activeAttempt);
    if (!hasMatchingCompletion && stored.accountSwitchStartedAt && stored.multiAccountState) {
        const now = Date.now();
        const totalElapsed = now - stored.accountSwitchStartedAt;
        const sinceLastProgress = now - (stored.lastAmazonProgressAt || stored.accountSwitchStartedAt);
        const { isIdleTimeout, isHardCap } = getAmazonAccountTimeoutDecision({
            totalElapsed,
            sinceLastProgress,
            matchingIncomplete,
            now,
            graceUntil: stored.amazonNavigationGraceUntil,
            idleTimeoutMs: ACCOUNT_PARSE_TIMEOUT_MS,
            hardCapMs: AMAZON_ACCOUNT_HARD_CAP_MS
        });
        if (isIdleTimeout || isHardCap) {
            const timeoutReason = isHardCap
                ? 'hard-cap 45min'
                : (matchingIncomplete
                    ? `incomplete: ${stored.amazonParsingIncomplete.reason || 'content error'}`
                    : 'no progress');
            // A page transition is recoverable: state.currentPage already points
            // to the next page and all previous orders are durably saved. Retry
            // the exact URL before discarding the rest of this account.
            const recovery = await retryAmazonPaginationNavigation(stored, now, timeoutReason);
            if (recovery.status === 'retried' || recovery.status === 'waiting' || recovery.status === 'stale') {
                console.warn(`[amazonWatchdog] navigation recovery ${recovery.status} for page ${stored.amazonPaginationState?.currentPage}`);
                return;
            }

            const timeoutAttempt = amazonWatchdogAttemptFromState(stored);
            // Claim the exact attempt under the same serialized arbiter used by
            // content cursor/final commits. Whichever enters first wins; there is
            // no check→set window where both timeout and completion can succeed.
            const timeoutClaim = await claimAmazonTimeoutAttempt(timeoutAttempt);
            if (!['claimed', 'resolving'].includes(timeoutClaim.status)) {
                console.warn(`⏭ Amazon timeout cancelled: ${timeoutClaim.status}`);
                return;
            }

            const failedEmail = stored.multiAccountState.currentAmazonAccount || 'unknown';
            const reason = timeoutReason;
            const idleSec = Math.round(sinceLastProgress / 1000);
            const totalSec = Math.round(totalElapsed / 1000);
            // Человеку — словами: что случилось, сколько ждал, что я сделал.
            // «hard-cap / no progress / idle= / total=» оставляем только в консоли для разбора.
            const waitText = idleSec >= 120 ? `${Math.round(idleSec / 60)} мин` : `${idleSec} сек`;
            const spentText = totalSec >= 120 ? `${Math.round(totalSec / 60)} мин` : `${totalSec} сек`;
            const humanReason = isHardCap
                ? `сидел в кабинете ${spentText} и не закончил`
                : `кабинет молчал ${waitText}`;

            // Capture the exact parser tab through CDP. captureVisibleTab(windowId)
            // photographed whichever unrelated tab was active in that window and
            // made the old incident frame untrustworthy.
            let evidence = { tabId: null, tabUrl: null, tabTitle: null };
            let evidencePhoto = '';
            try {
                const tab = await getAmazonParserTab(stored.amazonParserTabId);
                if (tab?.id) {
                    evidence = {
                        tabId: tab.id,
                        tabUrl: (tab.url || '').slice(0, 300),
                        tabTitle: (tab.title || '').slice(0, 200),
                        tabStatus: tab.status || null,
                        page: stored.amazonPaginationState?.currentPage || null,
                        navigation: stored.amazonPaginationState?.navigation || null
                    };
                    evidencePhoto = await captureAmazonTabWithDebugger(tab.id) || '';
                }
            } catch (e) { console.warn('timeout-screenshot failed:', e?.message || e); }

            const partialFound = (cachedProgressState.amazon && cachedProgressState.amazon.found) || 0;
            const resolution = await finalizeAmazonTimeoutAttempt(
                timeoutAttempt,
                timeoutReason,
                partialFound
            );
            if (resolution.status === 'completion-won') {
                console.warn('⏭ Amazon timeout lost to a committed completion');
                await consumeAmazonCompletionMarker(pipelineGenerationFromStage(stored.pipelineStage));
                return;
            }
            if (resolution.status !== 'failed') {
                console.warn(`⏭ Amazon timeout became ${resolution.status} before failure commit`);
                return;
            }

            console.log(`🚫 Account ${failedEmail} timed out (${reason}, idle=${idleSec}s, total=${totalSec}s), skipping`);
            await sendTelegramMessage(`🚫 Amazon, почта ${failedEmail.split('@')[0]}: ${humanReason} — иду дальше, заказы оттуда посмотрю в следующий обход`).catch(() => {});
            if (evidencePhoto) {
                await sendTelegramPhoto(
                    evidencePhoto,
                    `🚫 Amazon, почта ${failedEmail.split('@')[0]}: ${humanReason}.\nВот что было на экране в этот момент. Точная вкладка ${evidence.tabId}.`
                ).catch(() => {});
            }
            await logMultiAccountStep('account-parse:timeout', {
                account: failedEmail,
                reason,
                idleSec,
                totalSec,
                ...evidence
            });

            // Populate partial parseReport.stores so final Telegram summary shows
            // partial progress instead of silently reporting zero (observed 2026-04-22:
            // ipochtoy parsed 19 pages but summary showed "(ни один аккаунт не дал
            // результата)" because only the completion-flag path writes parseReport).
            // Read last known count from cachedProgressState['amazon'].found which
            // content-amazon.js updates on every page.
            try {
                const accountName = failedEmail.split('@')[0];
                parseReport.stores[`amazon_${accountName}`] = {
                    found: partialFound,
                    status: isHardCap ? '⏱' : '🚫'
                };
            } catch (e) { console.warn('partial parseReport failed:', e?.message || e); }

            // Restore state
            isMultiAccountParsing = !!resolution.multiAccountState?.isMultiAccountParsing;
            amazonAccountsQueue = resolution.multiAccountState?.amazonAccountsQueue || [];
            currentAmazonAccount = resolution.multiAccountState?.currentAmazonAccount || null;
            await switchToNextAmazonAccount(
                pipelineGenerationFromStage(resolution.pipelineStage)
            );
            return;
        }
    }
    
    if (stored.amazonParsingComplete && stored.amazonParsingComplete.timestamp) {
        const generation = pipelineGenerationFromStage(stored.pipelineStage);
        const consumed = await consumeAmazonCompletionMarker(generation);
        if (!consumed) {
            console.warn('⏭ Ignoring stale Amazon completion marker', stored.amazonParsingComplete);
        }
    }
});

let finalUploadScheduledRunId = null;
let finalUploadScheduleInFlight = null;

// Check if all stores completed and trigger auto-upload
function checkAllStoresCompleted() {
    if (finalUploadScheduleInFlight) return finalUploadScheduleInFlight;
    finalUploadScheduleInFlight = checkAllStoresCompletedOnce();
    return finalUploadScheduleInFlight.finally(() => {
        finalUploadScheduleInFlight = null;
    });
}

async function checkAllStoresCompletedOnce() {
    if (storesCompleted.ebay && storesCompleted.iherb && storesCompleted.amazon) {
        const runState = await chrome.storage.local.get(['pipelineRun', 'pipelineStage', 'pendingSheetsUpload']);
        const runId = runState.pipelineRun?.id || null;
        if (!runId
            || !['completed', 'degraded'].includes(runState.pipelineRun?.status)
            || runState.pipelineStage?.active !== false
            || runState.pipelineStage?.runId !== runId
            || runState.pipelineStage?.currentIndex !== PIPELINE_STAGES.length - 1) {
            console.log('⏳ Final upload waits for the terminal pipeline stage');
            return;
        }
        if (finalUploadScheduledRunId === runId || runState.pendingSheetsUpload?.runId === runId) {
            console.log('⏭ Final upload already scheduled for this run');
            return;
        }
        await chrome.storage.local.set({
            pendingSheetsUpload: {
                runId,
                forSlot: runState.pipelineRun.slotAt,
                savedAt: Date.now()
            },
            sheetsRetryCount: 0,
            sheetsRetryGaveUp: false
        });
        // The in-memory dedupe becomes proof only after the durable retry
        // marker exists. If storage.set rejects, the next call must retry
        // instead of stranding the upload until a lucky service-worker restart.
        finalUploadScheduledRunId = runId;
        isParsingAllStores = false;
        saveParsingState(); // Save final state

        console.log('🚀 All stores parsed! Starting uploads + screenshots...');
        
        // Notify popup if open
        chrome.runtime.sendMessage({ action: 'allStoresCompleted' });

        // Upload + screenshots FIRST, then send final report
        setTimeout(async () => {
            // Финальная выгрузка в Google Sheets — до 3 попыток с паузой 60с.
            // Внешний сторож читает lastSheetsUploadOkAt, поэтому имя ключа фиксировано.
            let sheetsUploadErr = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const upload = getOrStartFinalSheetsUpload(runId, {
                        source: `final-timer-${attempt}`
                    });
                    await upload.promise;
                    sheetsUploadErr = null;
                    console.log(`✅ Выгрузка в Google Sheets успешна (попытка ${attempt}/3)`);
                    break;
                } catch (e) {
                    sheetsUploadErr = e;
                    console.error(`❌ Выгрузка в Google Sheets провалилась (попытка ${attempt}/3):`, e?.message || e);
                    if (attempt < 3) await new Promise(r => setTimeout(r, 60000));
                }
            }
            if (sheetsUploadErr) {
                // In-memory ретрай не осилил (или SW уснул) — маркер остаётся, догонит
                // sheetsUploadWatchdog через alarm (переживает сон SW).
                const msg = String(sheetsUploadErr?.message || sheetsUploadErr).slice(0, 300);
                console.error('❌ Выгрузка в Google Sheets не удалась после 3 попыток (догонит alarm):', msg);
                try { await sendTelegramMessage(`❗ Выгрузка в Google Sheets не удалась после 3 попыток: ${msg}`); } catch (_) {}
            }
            if (screenshotsEnabled && trackScreenshotQueue.length > 0) {
                await processScreenshotQueue();
            }
            
            // Now build and send final report with all stats
            const elapsed = parseReport.startedAt ? Math.round((Date.now() - parseReport.startedAt) / 1000) : 0;
            const mins = Math.floor(elapsed / 60);
            const secs = elapsed % 60;
            // ── Сводка обхода — человеческим языком (оператор не программист) ──
            // Правило: каждая строка отвечает «что случилось» и, если нужно, «что мне делать».
            // Слов «трек», «скриншот», «выгрузка», «строк в таблице» тут быть не должно —
            // 05.08.2026 оператор прочёл прошлую сводку и половину не понял.
            const uploadOk = !sheetsUploadErr;         // тот же флаг, что гейтит "❗ не удалось после 3 попыток"
            const stores = parseReport.stores || {};
            const roster = parseReport.iherbRoster || null;
            const ss = parseReport.screenshots || {};
            const nu = parseReport.newUploads || null;

            // Собираем заказы по МАГАЗИНУ (не по аккаунту): iherb_* → iHerb, amazon_* → Amazon и т.д.
            // '🚫' (кабинет перестал отвечать, :2891) раньше в таблице рангов отсутствовал —
            // сорванный аккаунт Amazon получал ранг 0 и НЕ попадал в «на что посмотреть».
            const STATUS_RANK = { '❌': 3, '🚫': 3, '⏱': 2, '⚠️': 2, '✅': 1 };
            const bucketFor = (key) => {
                if (/^iherb/i.test(key)) return { id: 'iherb', name: 'iHerb' };
                if (/^amazon/i.test(key)) return { id: 'amazon', name: 'Amazon' };
                if (/^ebay/i.test(key)) return { id: 'ebay', name: 'eBay' };
                return { id: key, name: key.charAt(0).toUpperCase() + key.slice(1) };
            };
            const buckets = {};
            let amazonAcctCount = 0;
            for (const [key, val] of Object.entries(stores)) {
                if (/^amazon/i.test(key)) amazonAcctCount++;
                const b = bucketFor(key);
                if (!buckets[b.id]) buckets[b.id] = { name: b.name, found: 0, worst: '✅', worstRank: 0 };
                const bk = buckets[b.id];
                bk.found += Number(val && val.found) || 0;
                const st = (val && val.status) || '✅';
                const rank = STATUS_RANK[st] || 0;
                if (rank > bk.worstRank) { bk.worstRank = rank; bk.worst = st; }
            }

            // Проблемы (дедуп по магазину — один шоп не повторяется дважды)
            const problems = [];
            const seenShops = new Set();
            const addProblem = (shopId, text) => {
                if (shopId) { if (seenShops.has(shopId)) return; seenShops.add(shopId); }
                problems.push(text);
            };
            const rosterMissing = (roster && Array.isArray(roster.missing)) ? roster.missing : [];
            if (roster && rosterMissing.length > 0) {
                const names = rosterMissing.map(e => String(e).split('@')[0]).join(', ');
                addProblem('iherb', `iHerb — не смог зайти в почту ${names}, её заказы не смотрел`);
            }
            for (const [id, bk] of Object.entries(buckets)) {
                if (bk.worst === '❌') addProblem(id, `${bk.name} — не смог прочитать заказы, нужен человек`);
                else if (bk.worst === '🚫') addProblem(id, `${bk.name} — кабинет перестал отвечать, обошёл не весь`);
                else if (bk.worst === '⏱' || bk.worst === '⚠️') addProblem(id, `${bk.name} — завис и не доделал круг`);
            }
            if (!uploadOk) addProblem('sheets', 'таблица заказов не записалась, нужен человек');

            // ── Шапка: когда, сколько заняло ──
            const dateStr = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
            const hours = Math.floor(mins / 60);
            const durationText = hours > 0
                ? `${hours} ${plural(hours, 'час', 'часа', 'часов')} ${mins % 60} мин`
                : (mins > 0 ? `${mins} мин` : `${secs} сек`);
            let report = `🌙 Обошёл кабинеты магазинов — ${dateStr}, занял ${durationText}`;

            // ── Что не получилось (сразу под шапкой: это то, ради чего сводку читают) ──
            if (problems.length > 0) {
                report += `\n\n⚠️ Не получилось:\n` + problems.map(p => `   • ${p}`).join('\n');
            }

            // ── Сколько заказов просмотрел (по магазину) ──
            const bucketOrder = ['iherb', 'ebay', 'amazon'];
            const orderedIds = [
                ...bucketOrder.filter(id => buckets[id]),
                ...Object.keys(buckets).filter(id => !bucketOrder.includes(id))
            ];
            if (orderedIds.length > 0) {
                report += `\n\n👀 Просмотрел заказов:\n`;
                report += orderedIds.map(id => {
                    const bk = buckets[id];
                    // «Amazon — 0» человеку ничего не говорит: ноль тут значит «не смотрел вовсе».
                    if (!bk.found && (bk.worst === '🚫' || bk.worst === '❌' || bk.worst === '⏱')) {
                        return `   ${bk.worst} ${bk.name} — не смотрел, кабинет не ответил`;
                    }
                    let line = `   ${bk.worst} ${bk.name} — ${bk.found}`;
                    if (id === 'iherb' && roster) {
                        const parsedN = Array.isArray(roster.parsed) ? roster.parsed.length : 0;
                        line += (rosterMissing.length === 0)
                            ? ` (обошёл все ${roster.total} почты)`
                            : ` (обошёл ${parsedN} почты из ${roster.total})`;
                    } else if (id === 'amazon' && amazonAcctCount > 0) {
                        line += ` (${amazonAcctCount} ${plural(amazonAcctCount, 'почта', 'почты', 'почт')})`;
                    }
                    return line;
                }).join('\n');
            }

            // ── Новые посылки: главная польза обхода ──
            // nu.tracks — сколько НОВЫХ номеров посылок (магазин+номер) добавилось в таблицу.
            // nu.rows и nu.qtyUpdated человеку не нужны: это внутренний счёт строк таблицы.
            if (nu) {
                const newParcels = Number(nu.tracks) || 0;
                report += `\n\n📦 Новых посылок: ${newParcels}`;
                if (newParcels > 0) {
                    const nparts = Object.entries(nu.byShop || {})
                        .filter(([, n]) => Number(n) > 0)
                        .map(([s, n]) => `${s} ${n}`);
                    if (nparts.length) report += ` (${nparts.join(', ')})`;
                    report += `\n   это заказы, у которых сегодня впервые появился номер посылки`;
                } else {
                    report += `\n   магазины новых отправок за это время не показали`;
                }
            }

            // ── Карточки заказов, которые ушли в этот чат ──
            // После надёжной очереди sent растёт только после подтверждения архива.
            // broken — подмножество окончательно failed, а не уже отправленных карточек.
            const { cardsSent, brokenCards, otherFailedCards } = screenshotReportCounters(ss);
            if (cardsSent > 0 || ss.skipped > 0 || ss.broken > 0 || ss.failed > 0) {
                report += `\n\n📸 Прислал сюда карточек: ${cardsSent}`;
                if (ss.skipped > 0) report += `\n   ещё ${ss.skipped} — их карточки присылал раньше, повторно не слал`;
                if (brokenCards > 0) report += `\n   ${brokenCards} снять не смог: магазин не показал страницу посылки`;
                if (otherFailedCards > 0) report += `\n   ${otherFailedCards} сорвалось из-за другой ошибки — сниму в следующий обход`;
            }

            // ── 🚫 Отменённые заказы (money-safety) ──
            // Магазины (iHerb/eBay/Amazon) отменённые заказы приходят без трек-номера
            // и в таблицу не попадают, но в Pochtoy они «Выкуплены» — клиент заплатил,
            // товар не придёт. Собираем из storage, показываем в отчёте и отдельно ГРОМКО
            // уведомляем про НОВЫЕ (которых оператор ещё не видел).
            try {
                const cxlStore = await chrome.storage.local.get([
                    'iherbCancelledOrders', 'ebayCancelledOrders', 'amazonCancelledOrders',
                    'notifiedCancelledOrderIds'
                ]);
                const allCancelled = [
                    ...(Array.isArray(cxlStore.iherbCancelledOrders) ? cxlStore.iherbCancelledOrders : []),
                    ...(Array.isArray(cxlStore.ebayCancelledOrders) ? cxlStore.ebayCancelledOrders : []),
                    ...(Array.isArray(cxlStore.amazonCancelledOrders) ? cxlStore.amazonCancelledOrders : [])
                ];
                // Дедуп по order_id (один заказ мог попасть из нескольких проходов пагинации).
                const cxlSeen = new Set();
                const cancelled = [];
                for (const c of allCancelled) {
                    const oid = String(c.order_id || '');
                    if (!oid || cxlSeen.has(oid)) continue;
                    cxlSeen.add(oid);
                    cancelled.push(c);
                }

                if (cancelled.length > 0) {
                    const CXL_MAX = 20;      // длинный список отменённых заказов раньше топил всю сводку
                    const cxlWord = plural(cancelled.length, 'заказ', 'заказа', 'заказов');

                    // Новые — те, про которые ещё не писали. Раньше в сводку каждую ночь падал
                    // ВЕСЬ список, и оператор видел одни и те же номера сутками, не понимая,
                    // где настоящая работа (оператор 05.08.2026). Теперь перечисляем только новые.
                    const notified = Array.isArray(cxlStore.notifiedCancelledOrderIds) ? cxlStore.notifiedCancelledOrderIds : [];
                    const notifiedSet = new Set(notified.map(String));
                    const fresh = cancelled.filter(c => !notifiedSet.has(String(c.order_id)));

                    // Название товара магазин отдаёт не всегда — тогда берём его из уже
                    // собранных строк заказа, иначе в списке остаются голые номера.
                    const nameOf = async (c) => {
                        if (c.product_name) return String(c.product_name).slice(0, 50);
                        try {
                            const { orderData } = await chrome.storage.local.get(['orderData']);
                            for (const store of Object.values(orderData || {})) {
                                const rows = (store && Array.isArray(store.orders)) ? store.orders : [];
                                const hit = rows.find(r => String(r.order_id || '') === String(c.order_id) && r.product_name);
                                if (hit) return String(hit.product_name).slice(0, 50);
                            }
                        } catch (_) {}
                        return '';
                    };
                    const listLines = async (rows) => {
                        const out = [];
                        for (const c of rows.slice(0, CXL_MAX)) {
                            const name = await nameOf(c);
                            out.push(`   • ${c.store_name} ${c.order_id}${name ? ` — ${name}` : ''}`);
                        }
                        return out.join('\n');
                    };

                    // Обходчик видит ВСЕ отмены в кабинетах, включая чужие покупки, и про
                    // наши заказы ничего не знает: 05.08.2026 из 57 отмен нашими были 21,
                    // а клиента реально ждали 5. Поэтому здесь только число, без обещаний
                    // про деньги — разбор «где клиент ещё ждёт» делает отдельный робот,
                    // который смотрит в наши записи (agent/parser-cancels-digest.mjs).
                    report += `\n\n🚫 Магазин отменил ${cancelled.length} ${cxlWord} в кабинетах`;
                    if (fresh.length > 0) report += `, из них ${fresh.length} впервые вижу сегодня`;
                    report += `.\n   Разбор, где клиент ещё ждёт товар, пришлю отдельным сообщением.`;

                    // Список новых отмен — коротким сообщением, БЕЗ слов про деньги клиента:
                    // наш это заказ или чужая покупка, обходчик не знает. Кто реально ждёт
                    // товар и что с ним делать — говорит разбор по нашим записям.
                    if (fresh.length > 0) {
                        const freshWord = plural(fresh.length, 'заказ', 'заказа', 'заказов');
                        let alert = `🚫 В кабинетах появилось ${fresh.length} новых отменённых ${freshWord}:\n\n`;
                        alert += await listLines(fresh);
                        if (fresh.length > CXL_MAX) alert += `\n   …и ещё ${fresh.length - CXL_MAX} — весь список в таблице заказов`;
                        alert += `\n\nСледом пришлю разбор: по каким из них клиент ещё ждёт товар.`;
                        try {
                            await deliverFreshCancellationAlert(
                                alert,
                                notified,
                                fresh.map(c => String(c.order_id))
                            );
                        } catch (e) {
                            // Fail open for the nightly report, but never claim the
                            // cancellation alert was delivered. The same IDs stay
                            // fresh and will be retried after Telegram recovers.
                            console.warn('⚠️ Новые отмены не доставлены в Telegram:', e?.message || e);
                        }
                    }
                }
            } catch (e) {
                console.warn('⚠️ Не удалось собрать отменённые заказы:', e?.message || e);
            }

            // ── Подвал (честный статус записи в таблицу) ──
            report += `\n\n${uploadOk ? '✅ Все заказы записал в таблицу' : '❗ Таблицу записать не смог — нужен человек'}`;

            // Сохраняем сводку прогона в storage — чтобы «как прошло» можно было
            // посмотреть в любой момент с цифрами, без раскопок. История — 20 прогонов. (2026-06-08)
            try {
                const runSummary = {
                    finishedAt: Date.now(),
                    durationSec: elapsed,
                    stores: parseReport.stores,
                    screenshots: parseReport.screenshots,
                    newUploads: parseReport.newUploads || null,
                    report
                };
                const prev = await chrome.storage.local.get(['parseRunSummaries']);
                const history = Array.isArray(prev.parseRunSummaries) ? prev.parseRunSummaries : [];
                history.push(runSummary);
                await chrome.storage.local.set({
                    parseReport,
                    parseReportTimestamp: Date.now(),
                    parseRunSummaries: history.slice(-20)
                });
            } catch (e) {
                console.warn('⚠️ Не удалось сохранить сводку прогона:', e?.message || e);
            }

            sendTelegramLong(report).catch(e => {
                console.warn('⚠️ Утренняя сводка не доставлена в Telegram:', e?.message || e);
            });
        }, 1000);
    }
}

async function uploadToSheets(runId = null) {
    try {
        // Get settings from storage
        const result = await chrome.storage.local.get([
            'spreadsheetId', 'sheetName', 'orderData', 'chainPochtoy',
            'skipProcessed', 'colorProcessed', 'limitRows', 'parseMode', 'pipelineRun'
        ]);
        let spreadsheetId = result.spreadsheetId || DEFAULT_SPREADSHEET_ID;
        const parseMode = result.parseMode || 'warehouse';
        const sheetName = (parseMode === 'financial') ? 'Financial_Log' : (result.sheetName || 'Лист1');
        
        console.log(`📤 Uploading to Sheet: ${sheetName} (Mode: ${parseMode})`);

        // Default chainPochtoy to false (disabled - using custom solution)
        if (result.chainPochtoy === undefined) {
            console.log('🔗 chainPochtoy is undefined, defaulting to FALSE');
            result.chainPochtoy = false;
        }
        console.log(`🔗 Chain Pochtoy flag: ${result.chainPochtoy}`);
        
        // Handle URL format if present
        const match = spreadsheetId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
        if (match) {
            spreadsheetId = match[1];
        }

        const orderData = result.orderData || {};
        const allOrders = [];
        Object.values(orderData).forEach(storeData => {
            if (storeData.orders) {
                const rows = runId
                    ? storeData.orders.filter(order => order?.parser_run_id === runId)
                    : storeData.orders;
                allOrders.push(...rows);
            }
        });

        if (runId) {
            if (result.pipelineRun?.id !== runId
                || !['completed', 'degraded'].includes(result.pipelineRun?.status)) {
                throw new Error('Sheets payload does not belong to the terminal pipeline run');
            }
            const slotAt = Number(result.pipelineRun.slotAt);
            const attemptedAt = Number(result.pipelineRun.attemptedAt);
            const startedAt = Number(result.pipelineRun.startedAt);
            const finishedAt = Number(result.pipelineRun.finishedAt);
            if (!Number.isFinite(slotAt)
                || !Number.isFinite(attemptedAt)
                || !Number.isFinite(startedAt)
                || !Number.isFinite(finishedAt)
                || slotAt > attemptedAt
                || attemptedAt > startedAt
                || startedAt > finishedAt) {
                throw new Error('Sheets payload has invalid pipeline timestamps');
            }
            for (const order of allOrders) {
                const shop = /iherb/i.test(order.store_name || '') ? 'iherb'
                    : /ebay/i.test(order.store_name || '') ? 'ebay'
                        : /amazon/i.test(order.store_name || '') ? 'amazon' : null;
                const observedAt = Date.parse(order.observed_at || '');
                const account = normalizeAccountEmail(order.parser_account);
                if (!shop
                    || !result.pipelineRun.expected?.[shop]?.includes(account)
                    || !Number.isFinite(observedAt)
                    || observedAt < startedAt
                    || observedAt > finishedAt) {
                    throw new Error('Sheets payload contains a row outside the run/account/time fence');
                }
            }
        }

        if (allOrders.length === 0) {
            if (runId) throw new Error(`No parsed rows belong to pipeline run ${runId}`);
            console.log('No parsed data to upload.');
            console.log('ℹ️ No data to upload');
            
            // Always trigger chain if enabled (ONLY IN WAREHOUSE MODE)
            if (parseMode === 'warehouse' && result.chainPochtoy) {
                 console.log('🔗 Chaining Pochtoy automation (no new data)...');
                 setTimeout(() => triggerPochtoyAutoStart(spreadsheetId, sheetName, result), 1500);
            }
            return;
        }

        // Format data for Sheets API
        let values;
        if (parseMode === 'financial') {
            // Financial Mode: Expanded columns
            // Header: Store, Order ID, Date, Total, Tax, Shipping, Items JSON, Debug Raw
            values = allOrders.map(o => {
                const f = o.financial || {};
                return [
                    o.store_name || '',
                    o.order_id || '',
                    new Date().toISOString().split('T')[0], // Date parsed (or real date if we extracted it)
                    f.total_amount || o.total_amount || '',
                    f.detected_tax || '',
                    f.shipping || '',
                    JSON.stringify(f), // Dump full object for debugging
                    o.product_name || ''
                ];
            });
        } else {
            // Warehouse Mode: 9 columns A-I.
            // A store | B order_id | C track | D product | E qty | F color | G size |
            // H screenshot_link (written separately by writeScreenshotLinkToSheet) | I account_name
            values = allOrders.map(o => [
                o.store_name || '',
                o.order_id || '',
                o.track_number || '',
                o.product_name || '',
                o.qty || '',
                o.color || '',
                o.size || '',
                '',                        // H screenshot_link placeholder
                o.account_name || ''       // I account_name
            ]);
        }

        // Idempotency: read existing rows, update qty if changed, skip exact duplicates
        // Fail closed: without the existing sheet we cannot dedupe safely and
        // would append every historical row again while still reporting green.
        const existing = await readSheetData(spreadsheetId, sheetName) || [];

        let newValues = [];
        let rowsToUpdate = []; // {row: 1-based index, qty: new qty value}
        
        if (parseMode === 'financial') {
             const existingKeys = new Set(existing.map(r => (r[0]||'') + '_' + (r[1]||'')));
             newValues = values.filter(r => !existingKeys.has(r[0] + '_' + r[1]));
        } else {
             const headerOffset = existing.length > 0 && existing[0].length > 1 && /store/i.test(existing[0][0] || '') ? 1 : 0;
             const existingRows = existing.slice(headerOffset);

             // Key WITHOUT qty: store + order + track + product + account_name (col I = idx 8)
             const existingMap = new Map();
             existingRows.forEach((r, idx) => {
                 const key = [r[0]||'', r[1]||'', r[2]||'', r[3]||'', r[8]||''].join('\u0001');
                 const existingQty = r[4] || '1';
                 existingMap.set(key, { rowIndex: idx + headerOffset + 1, qty: existingQty }); // 1-based row in sheet
             });

             for (const r of values) {
                 const key = [r[0], r[1], r[2], r[3], r[8]||''].join('\u0001');
                 const newQty = r[4] || '1';

                 if (existingMap.has(key)) {
                     const existing = existingMap.get(key);
                     // Check if qty changed
                     if (existing.qty !== newQty) {
                         rowsToUpdate.push({ row: existing.rowIndex, qty: newQty }); // rowIndex already 1-based
                         console.log(`📝 Will update row ${existing.rowIndex}: qty ${existing.qty} → ${newQty}`);
                     }
                     // Skip adding as new (it exists)
                 } else {
                     newValues.push(r);
                 }
             }
        }

        // 🆕 Счётчик новизны прогона — сколько РЕАЛЬНО новых строк и трек-номеров ушло
        // в лист после дедупа, с разбивкой по магазину. Раньше нигде не сохранялось —
        // ответ на «сколько свежих треков за прогон» приходилось выводить по косвенным
        // (byShop скринов). Пишем в parseReport (для сводки) + storage.lastUpload (для
        // ответа в любой момент). Только warehouse-режим: в financial r[2] — это дата. (2026-07-05)
        if (parseMode !== 'financial') {
            try {
                const shopOf = (s) => {
                    const t = String(s || '').toLowerCase();
                    return t.includes('amazon') ? 'Amazon' : t.includes('iherb') ? 'iHerb' : t.includes('ebay') ? 'eBay' : 'прочее';
                };
                const newTrackSet = new Set();
                const byShopTracks = {};
                for (const r of newValues) {
                    const track = r[2] || '';
                    if (!track) continue;
                    const shop = shopOf(r[0]);
                    const tk = shop + '' + track;
                    if (!newTrackSet.has(tk)) {
                        newTrackSet.add(tk);
                        byShopTracks[shop] = (byShopTracks[shop] || 0) + 1;
                    }
                }
                const newUploads = {
                    rows: newValues.length,
                    tracks: newTrackSet.size,
                    byShop: byShopTracks,
                    qtyUpdated: rowsToUpdate.length,
                    at: Date.now()
                };
                parseReport.newUploads = newUploads;
                await chrome.storage.local.set({ lastUpload: newUploads });
                console.log(`🆕 Новых в листе: ${newUploads.tracks} треков / ${newUploads.rows} строк`, byShopTracks);
            } catch (e) { console.warn('newUploads counter failed:', e?.message || e); }
        }

        // Update existing rows with new qty
        if (rowsToUpdate.length > 0) {
            console.log(`📝 Updating ${rowsToUpdate.length} rows with new qty...`);
            const authToken = await getAuthToken(true);
            const updateData = rowsToUpdate.map(u => ({
                range: `${sheetName}!E${u.row}`,
                values: [[u.qty]]
            }));
            
            const updateResponse = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updateData })
            });
            if (!updateResponse.ok) {
                const errorText = await updateResponse.text().catch(() => '');
                throw new Error(`Google Sheets qty update failed: ${updateResponse.status} ${errorText}`.trim());
            }
            console.log(`✅ Updated ${rowsToUpdate.length} qty values`);
            console.log(`📝 Updated qty in ${rowsToUpdate.length} rows`);
        }

        if (newValues.length === 0 && rowsToUpdate.length === 0) {
            console.log('Nothing new to upload.');
            chrome.runtime.sendMessage({ action: 'uploadComplete', status: 'info', message: 'Nothing new to upload (duplicates).' });
            console.log('ℹ️ All duplicates, nothing new to upload');
            
            if (parseMode === 'warehouse' && result.chainPochtoy) {
                 console.log('🔗 Chaining Pochtoy automation (duplicates only)...');
                 setTimeout(() => triggerPochtoyAutoStart(spreadsheetId, sheetName, result), 1500);
            }
            return;
        }
        
        if (newValues.length === 0) {
            // Only updates, no new rows
            chrome.runtime.sendMessage({ action: 'uploadComplete', status: 'success', message: `✅ Updated qty in ${rowsToUpdate.length} rows.` });
            
            if (parseMode === 'warehouse' && result.chainPochtoy) {
                 console.log('🔗 Chaining Pochtoy automation...');
                 setTimeout(() => triggerPochtoyAutoStart(spreadsheetId, sheetName, result), 2000);
            }
            return;
        }

        await writeDataToSheet(spreadsheetId, sheetName, newValues);

        console.log(`✅ Uploaded ${newValues.length} new items, updated ${rowsToUpdate.length} qty.`);
        const updatedMsg = rowsToUpdate.length > 0 ? `, updated qty in ${rowsToUpdate.length}` : '';
        chrome.runtime.sendMessage({ 
            action: 'uploadComplete', 
            status: 'success', 
            message: `✅ Uploaded ${newValues.length} new items${updatedMsg}.` 
        });
        console.log(`✅ Uploaded ${newValues.length} new, updated qty in ${rowsToUpdate.length}`);

        // Chain execution ONLY in warehouse mode
        if (parseMode === 'warehouse' && result.chainPochtoy) {
             console.log('🔗 Chaining Pochtoy automation...');
             setTimeout(() => triggerPochtoyAutoStart(spreadsheetId, sheetName, result), 2000);
        }

    } catch (error) {
        console.error("Upload failed:", error);
        chrome.runtime.sendMessage({ action: 'uploadComplete', status: 'error', message: `Upload Error: ${error.message}` });
        sendTelegramMessage(`❌ Ошибка загрузки: ${error.message}`);
        throw error;
    }
}

async function triggerPochtoyAutoStart(spreadsheetId, sheetName, settings) {
    try {
        console.log('🔄 Auto-starting Pochtoy automation...');
        chrome.runtime.sendMessage({ action: 'uploadComplete', status: 'info', message: '🔄 Auto-starting Pochtoy automation...' });
        sendTelegramMessage(`🔄 Авто-запуск робота Pochtoy.com...`);
        
        // Read fresh data from sheet
        const sheetData = await readSheetData(spreadsheetId, sheetName);
        
        if (!sheetData || sheetData.length === 0) {
            console.error('Sheet is empty or unreadable.');
            sendTelegramMessage(`❌ Ошибка чтения таблицы перед запуском робота.`);
            return;
        }
        
        // Set options
        automationOptions = {
            spreadsheetId: spreadsheetId,
            sheetName: sheetName,
            skipProcessed: (typeof settings.skipProcessed === 'boolean') ? settings.skipProcessed : true,
            colorProcessed: (typeof settings.colorProcessed === 'boolean') ? settings.colorProcessed : true,
            limitRows: (typeof settings.limitRows === 'boolean') ? settings.limitRows : true
        };
        
        // Start
        startPochtoyAutomation(sheetData);
        
    } catch (e) {
        console.error('Failed to auto-start Pochtoy:', e);
        sendTelegramMessage(`❌ Не удалось запустить робота: ${e.message}`);
    }
}

function resetProgress() {
    totalTasks = 0;
    tasksStarted = 0;
    successCount = 0;
    failureCount = 0;
}

// Normalize tracking number: remove 4871 prefix for grouping
function normalizeTrackingForGrouping(track) {
    if (!track) return null;
    const trimmed = track.trim();
    // Remove 4871 prefix if present
    if (trimmed.startsWith('4871') && trimmed.length > 4) {
        return trimmed.substring(4);
    }
    return trimmed;
}

// --- Core Automation Logic ---
function startPochtoyAutomation(sheetData) {
    if (isAutomationRunning) return;
    
    // Ensure global stop flag is cleared when starting a new run
    chrome.storage.local.set({ stopAllParsers: false });
    
    resetProgress();
    isAutomationRunning = true;
    
    // Process sheet data and build the queue
    let startIndex = 1;
    if (automationOptions.limitRows && sheetData.length > 800) {
        startIndex = Math.max(1, sheetData.length - 800);
        console.log(`Limiting automation to last 800 rows (starting from row ${startIndex + 1})`);
    }

    const groupedByTrack = new Map();
    const groupedRowIndices = new Map();
    const originalTrackNumbers = new Map(); // Store original track number for each normalized key

    // sheet columns: 0 store, 1 order_id, 2 track, 3 product, 4 qty, 5 status (optional)
    for (let i = startIndex; i < sheetData.length; i++) {
        const row = sheetData[i];
        if (!row || row.length < 3) continue;
        
        // --- FIX: Data Sanitization ---
        const trackNumber = row[2] ? row[2].trim() : null;
        const orderId = row[1] ? String(row[1]).trim() : '';
        const storeName = row[0] ? String(row[0]).trim() : '';
        const status = (row[5] || '').toString().trim();
        // --- END FIX ---

        if (automationOptions.skipProcessed && !automationOptions.limitRows && status.toUpperCase().startsWith('DONE')) continue;
        
        if (trackNumber && trackNumber.length > 5) { // Basic validation for track number
            // Normalize for grouping (remove 4871 prefix)
            const normalizedKey = normalizeTrackingForGrouping(trackNumber);
            
            if (!groupedByTrack.has(normalizedKey)) {
                groupedByTrack.set(normalizedKey, []);
                // Store first original track number for this group
                originalTrackNumbers.set(normalizedKey, trackNumber);
            }
            groupedByTrack.get(normalizedKey).push({
                store: storeName,
                order_id: orderId,
                product_name: row[3] || '',
                qty: row[4] || '1'
            });
            if (!groupedRowIndices.has(normalizedKey)) groupedRowIndices.set(normalizedKey, new Set());
            groupedRowIndices.get(normalizedKey).add(i+1); // 1-based row index in Sheets
        }
    }

    for (const [normalizedKey, items] of groupedByTrack.entries()) {
        // Use original track number for searching (first one encountered)
        const trackNumber = originalTrackNumbers.get(normalizedKey) || normalizedKey;
        
        // Human-friendly header lines
        const validItems = items.filter(item => item.order_id && item.order_id.length > 0);
        const uniqueOrderIds = new Set(validItems.map(item => item.order_id));

        const stores = items.map(it => it.store).filter(Boolean);
        const mainStore = stores.length ? stores[0] : '';

        const totalUnits = items.reduce((sum, it) => sum + (parseInt(it.qty, 10) || 1), 0);

        const headerLines = [];
        if (uniqueOrderIds.size > 1) headerLines.push("‼️ ВНИМАНИЕ: РАЗНЫЕ ЗАКАЗЫ ‼️");
        const now = new Date();
        const hh = String(now.getHours()).padStart(2,'0');
        const mm = String(now.getMinutes()).padStart(2,'0');
        headerLines.push(`ТЕСТ РОБОТА 🤖, СВЕРКА ОБЯЗАТЕЛЬНА. (обновлено ${hh}:${mm})`);

        if (items.length === 1) {
            const it = items[0];
            const q = parseInt(it.qty, 10) || 1;
            if (q === 1) {
                headerLines.push(`Заказ из ${mainStore || 'магазина'}. В посылке один товар — ${it.product_name}.`);
            } else {
                headerLines.push(`Заказ из ${mainStore || 'магазина'}. В посылке ${q} шт. — ${it.product_name}.`);
            }
        } else {
            headerLines.push(`Заказ из ${mainStore || 'магазина'}. В посылке ${items.length} позиций (${totalUnits} шт.).`);
        }

        headerLines.push('Состав:');
        items.forEach(item => {
            headerLines.push(`- ${item.product_name} (Qty: ${item.qty}, Order: ${item.order_id})`);
        });

        const note = headerLines.join('\n');
        const rowIndices = Array.from(groupedRowIndices.get(normalizedKey) || []);
        const hasWarning = uniqueOrderIds.size > 1;
        automationQueue.push({ trackNumber, note: note.trim(), rowIndices, hasWarning });
    }
    
    totalTasks = automationQueue.length;
    sendAutomationProgress(); // Send initial state

    if (totalTasks > 0) {
        findOrCreateAutomationTab();
        sendTelegramMessage(`🤖 Робот начал работу. Задач в очереди: ${totalTasks}`);
    } else {
        isAutomationRunning = false;
        sendAutomationProgress(); // Send final (empty) state
        sendTelegramMessage(`🤖 Робот не нашел новых задач.`);
    }
}

function stopAutomation() {
    isAutomationRunning = false;
    automationQueue = [];
    sendAutomationProgress(); // Send stopped state
    console.log("Automation stopped by user.");
    sendSelfDeletingMessage(`🛑 Робот остановлен пользователем.`, 60);
}

async function findOrCreateAutomationTab() {
    const adminUrl = "https://www.pochtoy.com/admin-room/sa-allocate";
    const tabs = await chrome.tabs.query({ url: `${adminUrl}*` });

    if (tabs.length > 0) {
        automationTabId = tabs[0].id;
        chrome.tabs.update(automationTabId, { active: true }).then(() => injectScript(automationTabId));
    } else {
        chrome.tabs.create({ url: adminUrl, active: true }).then(tab => {
            automationTabId = tab.id;
            // Script will be injected via onUpdated listener
        });
    }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tabId === automationTabId && changeInfo.status === 'complete' && tab.url.includes("pochtoy.com")) {
        injectScript(tabId);
    }
});

async function injectScript(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['content-pochtoy.js'],
        });
    } catch (error) {
        console.error("Failed to inject content script:", error);
        isAutomationRunning = false;
        sendAutomationProgress();
    }
}

function processNextInQueue() {
    if (!isAutomationRunning || tasksStarted >= totalTasks) {
        isAutomationRunning = false;
        sendAutomationProgress(); // Send final report
        sendTelegramMessage(`🏁 Робот закончил работу.\n✅ Успешно: ${successCount}\n❌ Ошибок: ${failureCount}`);
        return;
    }

    const task = automationQueue[tasksStarted];
    tasksStarted++;
    sendAutomationProgress(task); // Update UI with current task

    chrome.tabs.sendMessage(automationTabId, {
        action: "searchAndFill",
        data: task
    }, async (response) => {
        if (chrome.runtime.lastError) {
            console.error("Message sending failed:", chrome.runtime.lastError.message);
            failureCount++;
        } else {
            if (response.status === 'success') {
                successCount++;
                // Mark rows done in Google Sheets
                if (automationOptions.spreadsheetId && task.rowIndices && task.rowIndices.length) {
                    try {
                        // Always color processed rows regardless of toggle
                        await markRowsDone(automationOptions.spreadsheetId, automationOptions.sheetName, task.rowIndices, true, task.hasWarning);
                    } catch (e) {
                        console.warn('Mark rows DONE failed:', e);
                    }
                }
            } else if (response.status === 'stopped') {
                // do not change counters
            } else {
                failureCount++;
            }
        }
        
        if (isAutomationRunning) {
            setTimeout(processNextInQueue, 1500);
        }
    });
}

// --- Telegram Bot Logic ---
function startTelegramPolling() {
    if (tgPollingInterval) clearInterval(tgPollingInterval);
    
    // Poll every 10 seconds (faster)
    tgPollingInterval = setInterval(pollTelegramUpdates, 10000);
    console.log('🚀 Telegram polling started (10s interval).');
}

async function pollTelegramUpdates() {
    if (!tgBotToken) {
        console.log('🚫 pollTelegramUpdates skipped: No token');
        return;
    }
    
    try {
        console.log(`📡 Polling Telegram updates... (Offset: ${lastUpdateId + 1})`);
        const response = await fetch(`https://api.telegram.org/bot${tgBotToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`);
        
        if (!response.ok) {
            console.error(`❌ Telegram API Error: ${response.status} ${response.statusText}`);
            return;
        }

        const data = await response.json();
        
        if (data.ok && data.result.length > 0) {
            console.log(`📩 Received ${data.result.length} updates from Telegram`);
            for (const update of data.result) {
                lastUpdateId = update.update_id;
                
                // Save last update ID to avoid reprocessing
                chrome.storage.local.set({ lastUpdateId });
                
                if (update.message && update.message.text) {
                    const text = update.message.text.trim();
                    const chatId = update.message.chat.id;
                    
                    console.log(`💬 Message from ${chatId}: "${text}"`);

                    // Auto-save Chat ID if it matches (or if user hasn't set it)
                    if (!tgChatId) {
                        tgChatId = chatId;
                        chrome.storage.local.set({ tgChatId });
                        console.log(`💾 Auto-saved Chat ID: ${chatId}`);
                    }
                    
                    // Support both commands to avoid conflict with other bots
                    const isStartCommand = text === '/run_parser' || text === '/start_parser' || text === '🚀 Start Parser' || text === '/start';
                    const isStopCommand = text === '/stop' || text === '🛑 Stop' || text === 'stop';
                    const isRobotCommand = text === '/run_robot' || text === '🤖 Run Robot' || text === 'robot';

                    if (isStopCommand) {
                        console.log('🛑 Stop command received via Telegram');
                        chrome.storage.local.set({ stopAllParsers: true });
                        sendTelegramMessage('🛑 Принято! Останавливаю парсинг и автоматизацию...');
                        continue;
                    }
                    
                    // /test_screenshot <trackUrl> — test screenshot without parsing
                    if (text.startsWith('/test_screenshot ')) {
                        const url = text.replace('/test_screenshot ', '').trim();
                        sendTelegramMessage('📸 Тестирую скриншот: ' + url.substring(0, 60) + '...');
                        captureTrackScreenshot({ orderId: 'TEST', trackNumber: 'TEST', trackUrl: url, accountName: 'test' }, 1, 1);
                        continue;
                    }
                    
                    // Auto-parse commands
                    if (text === '/autoparse on' || text === '/auto on') {
                        await chrome.storage.local.set({ dailyAutoParseEnabled: true });
                        const nextRun = await ensureDailyAlarm('telegram:on');
                        sendTelegramMessage(`⏰ Автопарсинг ВКЛЮЧЕН! Следующий запуск: ${nextRun.toLocaleString('ru-RU')}`);
                        continue;
                    }
                    
                    if (text === '/autoparse off' || text === '/auto off') {
                        await chrome.storage.local.set({ dailyAutoParseEnabled: false });
                        chrome.alarms.clear(DAILY_ALARM_NAME);
                        await addDailyDiagnostic('autoparse-off', { source: 'telegram' });
                        sendTelegramMessage('⏰ Автопарсинг ВЫКЛЮЧЕН.');
                        continue;
                    }

                    if (text === '/autoparse log' || text === '/auto log') {
                        const stored = await chrome.storage.local.get([DAILY_DIAGNOSTICS_KEY]);
                        const diagnostics = Array.isArray(stored[DAILY_DIAGNOSTICS_KEY])
                            ? stored[DAILY_DIAGNOSTICS_KEY]
                            : [];
                        const tail = diagnostics.slice(-10);
                        const lines = tail.length
                            ? tail.map(formatDailyDiagnostic)
                            : ['лог пока пуст'];
                        sendTelegramMessage(`🧾 Лог автозапуска:\n${lines.join('\n')}`);
                        continue;
                    }
                    
                    if (text === '/status') {
                        const settings = await chrome.storage.local.get([
                            'dailyAutoParseEnabled',
                            'dailyAlarmLastCheckedAt',
                            'dailyAlarmScheduledFor',
                            'dailyAlarmScheduleReason',
                            'lastDailyAutoParseTriggeredAt',
                            'lastDailyAutoParseStatus',
                            'lastDailyAutoParseSource',
                            DAILY_DIAGNOSTICS_KEY
                        ]);
                        const autoEnabled = settings.dailyAutoParseEnabled !== false; // default true
                        const alarm = autoEnabled ? await ensureDailyAlarm('telegram:status') : await chrome.alarms.get(DAILY_ALARM_NAME);
                        let statusMsg = `📊 Статус:\n`;
                        statusMsg += `⏰ Автопарсинг: ${autoEnabled ? 'ВКЛ' : 'ВЫКЛ'}\n`;
                        if (alarm) {
                            const nextRun = new Date(alarm.scheduledTime);
                            statusMsg += `📅 Следующий запуск: ${nextRun.toLocaleString('ru-RU')}\n`;
                        } else {
                            statusMsg += `📅 Следующий запуск: не назначен\n`;
                        }
                        if (settings.lastDailyAutoParseTriggeredAt) {
                            const lastRun = new Date(settings.lastDailyAutoParseTriggeredAt);
                            statusMsg += `🧾 Последний автозапуск: ${lastRun.toLocaleString('ru-RU')} (${settings.lastDailyAutoParseStatus || 'unknown'}, ${settings.lastDailyAutoParseSource || 'unknown'})\n`;
                        }
                        if (settings.dailyAlarmLastCheckedAt) {
                            const checked = new Date(settings.dailyAlarmLastCheckedAt);
                            statusMsg += `🔎 Проверка alarm: ${checked.toLocaleString('ru-RU')} (${settings.dailyAlarmScheduleReason || 'unknown'})\n`;
                        }
                        const diagnostics = Array.isArray(settings[DAILY_DIAGNOSTICS_KEY])
                            ? settings[DAILY_DIAGNOSTICS_KEY]
                            : [];
                        if (diagnostics.length > 0) {
                            statusMsg += `🧾 Последние события:\n${diagnostics.slice(-3).map(formatDailyDiagnostic).join('\n')}`;
                        }
                        sendTelegramMessage(statusMsg);
                        continue;
                    }

                    if (isRobotCommand) {
                        console.log('🤖 Robot command received via Telegram');
                        sendTelegramMessage('🤖 Запускаю робота Pochtoy (без парсинга)...');
                        // Get settings and start
                        const settings = await chrome.storage.local.get(['spreadsheetId', 'sheetName', 'chainPochtoy', 'skipProcessed', 'colorProcessed', 'limitRows']);
                        let spreadsheetId = settings.spreadsheetId || DEFAULT_SPREADSHEET_ID;
                        const sheetName = settings.sheetName || 'Лист1';
                        const match = spreadsheetId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
                        if (match) spreadsheetId = match[1];
                        
                        triggerPochtoyAutoStart(spreadsheetId, sheetName, settings);
                        continue;
                    }
                    
                    if (isStartCommand) {
                        if (tgChatId && String(tgChatId) !== String(chatId)) {
                            console.warn(`⚠️ Ignored command from unauthorized chat: ${chatId} (Expected: ${tgChatId})`);
                            continue;
                        }

                        if (text === '/start') {
                            // Send keyboard
                            console.log('👋 Sending welcome message...');
                            await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    chat_id: chatId,
                                    text: '👋 Привет! Я бот для парсинга заказов.\nЖми кнопку ниже, чтобы начать.',
                                    reply_markup: {
                                        keyboard: [
                                            [{ text: "🚀 Start Parser" }, { text: "🤖 Run Robot" }],
                                            [{ text: "🛑 Stop" }]
                                        ],
                                        resize_keyboard: true
                                    }
                                })
                            });
                        } else {
                            // Trigger Parse All Stores — sequential pipeline only.
                            // The legacy launchParsersFromBackground() fires iHerb + Amazon
                            // multi-account flows in parallel, which races with screenshot
                            // captureVisibleTab (active-tab contention). Sequential keeps
                            // one shop's tabs in focus at a time.
                            console.log('✅ Command accepted! Starting sequential pipeline...');
                            await runDailyAutoParse('telegram');
                        }
                    }
                }
            }
        } else {
            // console.log('💤 No new updates');
        }
    } catch (e) {
        console.error('❌ Telegram polling error:', e);
    }
}

// FALLBACK: Send parse commands via sendMessage with retry
// In case auto-parse flags didn't trigger (e.g., content script loaded before flags were set)
async function sendParseCommandsWithRetry(openedTabs) {
    const storeConfigs = [
        { key: 'ebay', tabId: openedTabs.ebay, action: 'exportEbayOrders', name: 'eBay' },
        { key: 'iherb', tabId: openedTabs.iherb, action: 'exportIherbOrders', name: 'iHerb' },
        { key: 'amazon', tabId: openedTabs.amazon, action: 'parseAmazon', name: 'Amazon' }
    ];

    // Wait for pages to initially load
    await new Promise(r => setTimeout(r, 10000));
    console.log('📤 [FALLBACK] Starting sendMessage retry for eBay, iHerb & Amazon...');

    for (const store of storeConfigs) {
        if (!store.tabId) continue;

        // Check if this store already started parsing (flag was picked up)
        if (storesCompleted[store.key]) {
            console.log(`✅ [FALLBACK] ${store.name} already completed, skipping`);
            continue;
        }

        // Check if parserStarted message was received (meaning auto-parse worked)
        const progressState = cachedProgressState[store.key];
        if (progressState && progressState.status && progressState.status !== 'Waiting...') {
            console.log(`✅ [FALLBACK] ${store.name} already parsing (status: ${progressState.status}), skipping`);
            continue;
        }

        console.log(`📤 [FALLBACK] ${store.name} hasn't started yet, sending message with retry...`);
        console.log(`⚠️ ${store.name}: Auto-parse didn't start, sending direct command...`);

        let sent = false;
        for (let attempt = 1; attempt <= 15; attempt++) {
            try {
                await new Promise((resolve, reject) => {
                    chrome.tabs.sendMessage(store.tabId, { action: store.action }, (response) => {
                        if (chrome.runtime.lastError) {
                            reject(chrome.runtime.lastError);
                        } else {
                            resolve(response);
                        }
                    });
                });
                console.log(`✅ [FALLBACK] ${store.name}: Message delivered on attempt ${attempt}`);
                console.log(`✅ ${store.name}: Parse command sent (attempt ${attempt})`);
                sent = true;
                break;
            } catch (e) {
                console.warn(`⚠️ [FALLBACK] ${store.name} attempt ${attempt}: ${e.message}`);
                await new Promise(r => setTimeout(r, 3000));
            }
        }

        if (!sent) {
            console.error(`❌ [FALLBACK] ${store.name}: Failed after 15 attempts`);
            console.error(`❌ ${store.name}: Failed to start parser after 15 attempts`);
        }
    }
}

// Шлёт текстовую команду в Telegram-группу для AutoBuy:
//   /parser_lock {shop} on|off
// AutoBuy подхватывает в native-host telegram-poller и пишет в свой chrome.storage,
// а auto-cart блокирует авто-выкуп на этот шоп пока флаг on.
async function setParserLock(shop, on) {
    const cmd = `/parser_lock ${shop} ${on ? 'on' : 'off'}`;
    console.log(cmd);
}

async function launchParsersFromBackground() {
    console.log('🚀 launchParsersFromBackground() triggered');
    if (!parseReport.startedAt || (Date.now() - parseReport.startedAt > 5000)) {
        parseReport = { stores: {}, screenshots: { sent: 0, skipped: 0, failed: 0, broken: 0 }, startedAt: Date.now() };
        sendTelegramMessage('🚀 Запущен парсинг всех магазинов...');
    }
    
    // Ensure stop flag is cleared
    await chrome.storage.local.set({ stopAllParsers: false });

    // Start parsing state
    isParsingAllStores = true;
    storesCompleted = { ebay: false, iherb: false, amazon: false };
    saveParsingState();
    
    // Reset progress cache
    cachedProgressState = {}; 
    chrome.storage.local.set({ progressState: cachedProgressState });
    
    // eBay open immediately. Amazon и iHerb идут через multi-account flow.
    const storesToParse = [
        { key: 'ebay', url: 'https://www.ebay.com/mye/myebay/purchase', emoji: '🛒' }
    ];

    const now = Date.now();
    await chrome.storage.local.set({
        autoParse_ebay: now,
        autoParse_iherb: now,
        autoParse_amazon: now,
        ebay_should_autoparse: true,
        iherb_should_autoparse: true,
        amazon_should_autoparse: true
    });
    console.log('🚩 Auto-parse flags set for eBay, iHerb & Amazon');
    parseReport = { stores: {}, screenshots: { sent: 0, skipped: 0, failed: 0, broken: 0 }, startedAt: Date.now() };

    const openedTabs = {};
    for (const store of storesToParse) {
        console.log(`🌐 Opening tab for ${store.key}...`);
        const tab = await chrome.tabs.create({ url: store.url, active: false });
        openedTabs[store.key] = tab.id;
        setParserLock(store.key, true);
    }

    // FALLBACK: If auto-parse flags don't work, send message with retry after page loads
    sendParseCommandsWithRetry(openedTabs);

    // Amazon: multi-account flow (photopochtoy + ipochtoy sequentially)
    startMultiAccountAmazonParsing();

    // iHerb: multi-account flow (pochtoy + photopochtoy sequentially)
    startMultiAccountIherbParsing();

    // Watchdog: Check progress after 3 minutes
    setTimeout(() => {
        if (isParsingAllStores && !storesCompleted.ebay && !storesCompleted.iherb && !storesCompleted.amazon) {
             console.log(`⚠️ Внимание: Прошло 3 минуты, а парсинг не завершен. Проверьте вкладки браузера.`);
        }
    }, 180000);
}

async function sendTelegramMessage(text) {
    if (!tgBotToken || !tgChatId) {
        console.warn('⚠️ Cannot send Telegram message - missing token or chat ID');
        return false;
    }
    
    console.log(`📤 Sending Telegram message: "${text}"`);
    try {
        const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: tgChatId,
                text: text
            })
        });
        if (!res.ok) {
             const err = await res.text();
             console.error(`❌ Telegram send failed: ${res.status} ${err}`);
             return false;
        } else {
             console.log('✅ Telegram message sent.');
             return true;
        }
    } catch (e) {
        console.error('Failed to send Telegram message:', e);
        return false;
    }
}

// Telegram не принимает сообщение длиннее 4096 знаков и молча выбрасывает его целиком.
// Так пропала утренняя сводка в ночь на 05.08.2026 (длинный список отмен). Режем по
// строкам и отправляем частями — лучше две части, чем ни одной.
async function sendTelegramLong(text, limit = 3500) {
    const full = String(text == null ? '' : text);
    if (full.length <= limit) {
        if (!await sendTelegramMessage(full)) throw new Error('Telegram message was not accepted');
        return true;
    }
    const parts = [];
    let buf = '';
    for (const line of full.split('\n')) {
        if (line.length > limit) {                       // одна строка длиннее лимита — рубим её
            if (buf) { parts.push(buf); buf = ''; }
            for (let i = 0; i < line.length; i += limit) parts.push(line.slice(i, i + limit));
            continue;
        }
        if (buf && (buf.length + 1 + line.length) > limit) { parts.push(buf); buf = ''; }
        buf = buf ? `${buf}\n${line}` : line;
    }
    if (buf) parts.push(buf);
    for (let i = 0; i < parts.length; i++) {
        const sent = await sendTelegramMessage(
            parts.length > 1 ? `(часть ${i + 1} из ${parts.length})\n${parts[i]}` : parts[i]
        );
        if (!sent) throw new Error(`Telegram part ${i + 1}/${parts.length} was not accepted`);
        await new Promise(r => setTimeout(r, 400));
    }
    return true;
}

async function deliverFreshCancellationAlert(
    alert,
    previouslyNotified = [],
    freshOrderIds = [],
    telegramPartLimit = 3500
) {
    await sendTelegramLong(alert, telegramPartLimit);
    const merged = new Set([
        ...previouslyNotified.map(String),
        ...freshOrderIds.map(String)
    ]);
    const notifiedCancelledOrderIds = [...merged].slice(-500);
    await chrome.storage.local.set({ notifiedCancelledOrderIds });
    return notifiedCancelledOrderIds;
}

function screenshotReportCounters(stats = {}) {
    const cardsSent = Math.max(0, Number(stats.sent) || 0);
    const brokenCards = Math.max(0, Number(stats.broken) || 0);
    const failedCards = Math.max(0, Number(stats.failed) || 0);
    return {
        cardsSent,
        brokenCards,
        otherFailedCards: Math.max(0, failedCards - brokenCards)
    };
}

// «5 посылок» / «2 посылки» / «1 посылка» — без склонения сводка читается как машинный лог.
function plural(n, one, few, many) {
    const abs = Math.abs(Number(n) || 0) % 100;
    const last = abs % 10;
    if (abs > 10 && abs < 20) return many;
    if (last > 1 && last < 5) return few;
    if (last === 1) return one;
    return many;
}


async function sendSelfDeletingMessage(text, deleteAfterSec = 60) {
    if (!tgBotToken || !tgChatId) return;
    try {
        const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: tgChatId, text })
        });
        const json = await res.json().catch(() => ({}));
        if (json.ok && json.result?.message_id) {
            setTimeout(async () => {
                try {
                    await fetch(`https://api.telegram.org/bot${tgBotToken}/deleteMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: tgChatId, message_id: json.result.message_id })
                    });
                } catch (e) { console.warn('Failed to auto-delete message:', e); }
            }, deleteAfterSec * 1000);
        }
    } catch (e) {
        console.error('Failed to send self-deleting message:', e);
    }
}


// --- TRACK SCREENSHOT QUEUE ---
// Очередь персистится в chrome.storage.local — критично для MV3 SW, который засыпает
// между парсингом первого аккаунта (ipochtoy) и тиком watchdog. Без персистенса очередь
// теряется и скрины первого аккаунта не отправляются.
let trackScreenshotQueue = [];
let isProcessingScreenshots = false;
let screenshotsEnabled = false;
let screenshotQueueInitError = null;
let screenshotQueuePersistChain = Promise.resolve();
const SCREENSHOT_DRAIN_MAX_WAIT_MS = 90 * 60_000;
const SCREENSHOT_MAX_ATTEMPTS = 3;

function screenshotQueueKey(item) {
    return `${item?.accountName || ''}|${item?.orderId || ''}|${item?.trackNumber || ''}`;
}

function mergePersistedScreenshotQueue(items) {
    const seen = new Set(trackScreenshotQueue.map(screenshotQueueKey));
    for (const item of (Array.isArray(items) ? items : [])) {
        const key = screenshotQueueKey(item);
        if (!seen.has(key)) {
            trackScreenshotQueue.push(item);
            seen.add(key);
        }
    }
}

// Initialization used to replace the whole in-memory queue from an async
// callback. A producer could append first and then be silently overwritten by
// the late callback. Merge once, and make every producer/consumer await it.
const screenshotQueueReady = chrome.storage.local.get(['screenshotsEnabled', 'trackScreenshotQueue'])
    .then(res => {
        screenshotsEnabled = res.screenshotsEnabled || false;
        mergePersistedScreenshotQueue(res.trackScreenshotQueue);
        if (trackScreenshotQueue.length > 0) {
            console.log(`📸 Restored ${trackScreenshotQueue.length} screenshots from storage`);
        }
    })
    .catch(error => {
        screenshotQueueInitError = error instanceof Error ? error : new Error(String(error));
        console.warn('⚠️ Screenshot queue init failed:', error?.message || error);
    });

async function persistScreenshotQueue() {
    await screenshotQueueReady;
    // storage.local.set сериализует не мгновенно. Передаём самостоятельный
    // snapshot и выстраиваем записи в цепочку, иначе поздняя запись старой
    // очереди может затереть финальный []. Await удерживает MV3 worker живым
    // до фактического commit в storage.
    const snapshot = trackScreenshotQueue.map(item => ({
        ...item,
        extraTracks: Array.isArray(item.extraTracks) ? [...item.extraTracks] : []
    }));
    // Перед финальным [] переносим уже прошедший active-хвост в accruedMs.
    // Watchdog обязан игнорировать activeSince при пустой persisted queue; без
    // checkpoint он бы вместе со stale-маркером потерял весь кредит длинного drain.
    const shouldCheckpointBudget = snapshot.length === 0 && isProcessingScreenshots;
    screenshotQueuePersistChain = screenshotQueuePersistChain
        .catch(() => {})
        .then(async () => {
            if (shouldCheckpointBudget) await checkpointScreenshotStageBudget();
            await chrome.storage.local.set({ trackScreenshotQueue: snapshot });
        });
    try {
        await screenshotQueuePersistChain;
        return true;
    } catch (e) {
        console.warn('⚠️ Failed to persist screenshot queue:', e?.message || e);
        throw e;
    }
}

async function beginScreenshotStageBudget() {
    try {
        const state = await chrome.storage.local.get(['pipelineStage', 'screenshotStageBudget']);
        const p = state.pipelineStage;
        if (!p?.active) return;
        const stageName = p.stages?.[p.currentIndex];
        const stageStartedAt = p.stageStartedAt || p.startedAt || 0;
        if (!stageName || stageName === 'done' || !stageStartedAt) return;

        const old = state.screenshotStageBudget;
        const sameStage = old?.stageName === stageName && old?.stageStartedAt === stageStartedAt;
        const next = sameStage ? { ...old } : {
            stageName,
            stageStartedAt,
            accruedMs: 0,
            activeSince: null
        };
        // Если MV3 worker умер посреди рассылки, persisted activeSince уже есть.
        // Не сбрасываем его при resume: watchdog должен исключить весь открытый
        // участок, пока persisted queue остаётся непустой.
        if (!Number.isFinite(next.activeSince)) next.activeSince = Date.now();
        await chrome.storage.local.set({ screenshotStageBudget: next });
    } catch (e) {
        console.warn('⚠️ Failed to start screenshot stage budget:', e?.message || e);
    }
}

async function finishScreenshotStageBudget() {
    try {
        const state = await chrome.storage.local.get(['pipelineStage', 'screenshotStageBudget']);
        const p = state.pipelineStage;
        const budget = state.screenshotStageBudget;
        const stageName = p?.stages?.[p.currentIndex];
        const stageStartedAt = p?.stageStartedAt || p?.startedAt || 0;
        if (!budget
            || budget.stageName !== stageName
            || budget.stageStartedAt !== stageStartedAt
            || !Number.isFinite(budget.activeSince)) {
            return;
        }
        const now = Date.now();
        const segmentMs = Math.max(0, now - Math.max(stageStartedAt, budget.activeSince));
        await chrome.storage.local.set({
            screenshotStageBudget: {
                ...budget,
                accruedMs: Math.min(
                    SCREENSHOT_STAGE_BUDGET_MAX_MS,
                    Math.max(0, Number(budget.accruedMs) || 0) + segmentMs
                ),
                activeSince: null,
                lastFinishedAt: now
            }
        });
    } catch (e) {
        console.warn('⚠️ Failed to finish screenshot stage budget:', e?.message || e);
    }
}

async function checkpointScreenshotStageBudget() {
    try {
        const state = await chrome.storage.local.get(['pipelineStage', 'screenshotStageBudget']);
        const p = state.pipelineStage;
        const budget = state.screenshotStageBudget;
        const stageName = p?.stages?.[p.currentIndex];
        const stageStartedAt = p?.stageStartedAt || p?.startedAt || 0;
        if (!budget
            || budget.stageName !== stageName
            || budget.stageStartedAt !== stageStartedAt
            || !Number.isFinite(budget.activeSince)) {
            return;
        }
        const now = Date.now();
        const segmentMs = Math.max(0, now - Math.max(stageStartedAt, budget.activeSince));
        await chrome.storage.local.set({
            screenshotStageBudget: {
                ...budget,
                accruedMs: Math.min(
                    SCREENSHOT_STAGE_BUDGET_MAX_MS,
                    Math.max(0, Number(budget.accruedMs) || 0) + segmentMs
                ),
                // Оставляем новый открытый хвост до process finally. Если worker
                // умрёт после commit [], watchdog увидит пустую очередь и закроет
                // его, не потеряв уже checkpointed accruedMs.
                activeSince: now,
                lastCheckpointAt: now
            }
        });
    } catch (e) {
        console.warn('⚠️ Failed to checkpoint screenshot stage budget:', e?.message || e);
    }
}

async function sendTelegramPhoto(base64Data, caption) {
    if (!tgBotToken || !tgChatId) {
        console.warn('⚠️ Cannot send Telegram photo - missing token or chat ID');
        return;
    }

    try {
        const byteChars = atob(base64Data);
        const byteArray = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) {
            byteArray[i] = byteChars.charCodeAt(i);
        }
        const blob = new Blob([byteArray], { type: 'image/png' });

        const formData = new FormData();
        formData.append('chat_id', tgChatId);
        formData.append('photo', blob, 'screenshot.png');
        if (caption) formData.append('caption', caption);

        const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendPhoto`, {
            method: 'POST',
            body: formData
        });

        if (!res.ok) {
            const err = await res.text();
            console.error(`❌ Telegram photo send failed: ${res.status} ${err}`);
        } else {
            console.log('✅ Telegram photo sent.');
        }
    } catch (e) {
        console.error('Failed to send Telegram photo:', e);
    }
}

/**
 * Send screenshot to the dedicated archive channel ("Скрины" by default).
 * Returns { ok, messageId, chatId, link } on success so caller can store link in Sheet.
 * Link format: https://t.me/c/{chat_id без -100}/{message_id} — clickable in Google Sheet.
 * Does NOT replace sendTelegramPhoto — this is a parallel path for archive.
 */
// HTML-экранирование динамических кусков подписи (для parse_mode:'HTML').
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Кликабельный номер заказа → ссылка на админку Pochtoy (серверный фильтр по shop_order_number).
function orderLink(orderId) {
    const id = String(orderId == null ? '' : orderId);
    const url = `https://www.pochtoy.com/admin-room/orders?shop_order_number=${encodeURIComponent(id)}`;
    return `<a href="${url}">${esc(id)}</a>`;
}

// Строка состава под карточкой: «🛒 2× Название / 1× Название».
// Товары берём из уже собранных строк (chrome.storage.local.orderData) — на сайт не ходим,
// лишних заходов в магазин это не создаёт. Если у строк проставлен номер посылки, показываем
// состав ИМЕННО этой коробки; иначе — весь заказ. Раньше под кадром был только номер посылки,
// и оператор не понимал, что внутри (оператор 05.08.2026).
// Подпись Telegram — не длиннее 1024 знаков, поэтому держим бюджет и честно пишем остаток.
let _itemsCache = { at: 0, data: null };   // за обход кадров сотни, а список заказов один
async function itemsCaptionLine(orderId, trackNumber, budget = 620) {
    try {
        if (!orderId) return '';
        // Держим список товаров минуту: перечитывать его на каждый кадр — сотни лишних
        // обращений к памяти расширения за один обход.
        if (!_itemsCache.data || Date.now() - _itemsCache.at > 60_000) {
            const fresh = await chrome.storage.local.get(['orderData']);
            _itemsCache = { at: Date.now(), data: fresh.orderData || {} };
        }
        const orderData = _itemsCache.data;
        const rowsOfOrder = [];
        for (const store of Object.values(orderData || {})) {
            const rows = (store && Array.isArray(store.orders)) ? store.orders : [];
            for (const r of rows) if (String(r.order_id || '') === String(orderId)) rowsOfOrder.push(r);
        }
        if (!rowsOfOrder.length) return '';
        const ofThisBox = trackNumber
            ? rowsOfOrder.filter(r => String(r.track_number || '') === String(trackNumber))
            : [];
        const rows = ofThisBox.length ? ofThisBox : rowsOfOrder;

        // Один и тот же товар мог прийти из нескольких проходов списка — берём БОЛЬШЕЕ
        // количество, а не сумму: сложение задваивало бы штуки на повторном чтении.
        const merged = new Map();
        for (const r of rows) {
            const name = String(r.product_name || '').replace(/\s+/g, ' ').trim();
            if (!name) continue;
            const qty = Number(r.qty) || 1;
            merged.set(name, Math.max(merged.get(name) || 0, qty));
        }
        const list = [...merged.entries()];
        if (!list.length) return '';

        const lines = [];
        let used = 0;
        for (const [name, qty] of list) {
            const short = name.length > 70 ? `${name.slice(0, 69)}…` : name;
            const line = `${qty}× ${short}`;
            if (lines.length > 0 && used + line.length > budget) break;
            lines.push(line);
            used += line.length + 7;                      // + перевод строки и отступ
        }
        const rest = list.length - lines.length;
        const body = lines.map((l, i) => (i === 0 ? `🛒 ${esc(l)}` : `       ${esc(l)}`)).join('\n');
        const tail = rest > 0
            ? `\n       …и ещё ${rest} ${plural(rest, 'товар', 'товара', 'товаров')} — весь список в таблице`
            : '';
        return `\n${body}${tail}`;
    } catch (e) {
        console.warn('⚠️ itemsCaptionLine failed:', e?.message || e);
        return '';
    }
}

async function sendScreenshotToArchive(base64Data, caption) {
    if (!tgBotToken || !tgPhotoChatId) {
        console.warn('⚠️ Cannot send screenshot to archive - missing token or tgPhotoChatId');
        return { ok: false };
    }

    // Подготовка blob
    const byteChars = atob(base64Data);
    const byteArray = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
    const blob = new Blob([byteArray], { type: 'image/png' });

    // Helper: общая отправка с обработкой fallback.
    // useHtml=true → parse_mode:'HTML' (кликабельный номер заказа в подписи).
    const sendAs = async (apiMethod, fileField, filename, useHtml) => {
        const fd = new FormData();
        fd.append('chat_id', tgPhotoChatId);
        fd.append(fileField, blob, filename);
        if (caption) fd.append('caption', caption);
        if (useHtml) fd.append('parse_mode', 'HTML');
        const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/${apiMethod}`, {
            method: 'POST',
            body: fd
        });
        const json = await res.json().catch(() => ({}));
        return { res, json };
    };

    // Одна попытка: sendPhoto → fallback sendDocument (при dimension/size/400) с заданным parse_mode.
    const trySend = async (useHtml) => {
        let { res, json } = await sendAs('sendPhoto', 'photo', 'screenshot.png', useHtml);
        const photoJson = json;
        const errDesc = String(json?.description || '');
        const fellThrough = !res.ok || !json?.ok;
        const dimensionIssue = /PHOTO_INVALID_DIMENSIONS|PHOTO_SAVE_FILE_INVALID|file is too big|wrong file/i.test(errDesc);
        if (fellThrough && (dimensionIssue || res.status === 400)) {
            console.warn(`⚠️ sendPhoto failed (${errDesc || res.status}), retrying as document`);
            const r2 = await sendAs('sendDocument', 'document', 'screenshot.png', useHtml);
            res = r2.res; json = r2.json;
        }
        return { res, json, photoJson };
    };

    try {
        // 1) HTML-подпись (кликабельный номер заказа)
        let { res, json, photoJson } = await trySend(true);

        // 2) Ошибка парсинга HTML-подписи → повтор той же подписи plain (без parse_mode),
        //    чтобы скриншот не потерялся из-за спецсимвола в названии/треке.
        const parseIssue = /can't parse|parse entities|byte offset|end tag|unclosed|entit|unsupported/i.test(String(json?.description || ''));
        if ((!res.ok || !json?.ok) && parseIssue) {
            console.warn(`⚠️ HTML caption parse failed (${json?.description}), retrying plain`);
            const plain = await trySend(false);
            res = plain.res; json = plain.json;
        }

        if (!res.ok || !json?.ok) {
            console.error(`❌ Archive send failed (photo+doc): photo=${JSON.stringify(photoJson)}, final=${JSON.stringify(json)}`);
            return { ok: false };
        }

        const messageId = json.result?.message_id;
        const chatId = String(tgPhotoChatId);
        const chatIdStripped = chatId.startsWith('-100') ? chatId.slice(4) : chatId.replace(/^-/, '');
        const link = messageId ? `https://t.me/c/${chatIdStripped}/${messageId}` : '';

        console.log(`✅ Archive sent: msg_id=${messageId}, link=${link}`);
        return { ok: true, messageId, chatId, link };
    } catch (e) {
        console.error('Failed to send screenshot to archive:', e);
        return { ok: false };
    }
}

async function queueTrackScreenshot(orderId, trackNumber, trackUrl, accountName) {
    // A queue message can be the very first event after an MV3 worker restart.
    // Wait for the persisted setting/queue before deciding whether screenshots
    // are enabled; checking the default `false` first silently dropped cards.
    await screenshotQueueReady;
    if (screenshotQueueInitError) throw screenshotQueueInitError;
    if (!screenshotsEnabled) return { queued: false, skipped: 'disabled' };
    const url = String(trackUrl || '');
    // eBay/iHerb: одна страница заказа на все товары/треки → дедуп по orderId.
    //   В существующую запись доливаем все доп. треки в extraTracks для подписи и записи в Sheet.
    // Amazon: каждая посылка — отдельная trackUrl страница → дедуп по trackNumber.
    const isOrderPage = /order\.ebay\.com\/ord\/show|secure\.iherb\.com\/myaccount\/orderdetails/i.test(url);
    if (isOrderPage && orderId) {
        const existing = trackScreenshotQueue.find(q => q.orderId === orderId);
        if (existing) {
            existing.extraTracks = existing.extraTracks || [];
            if (trackNumber && trackNumber !== existing.trackNumber && !existing.extraTracks.includes(trackNumber)) {
                existing.extraTracks.push(trackNumber);
                await persistScreenshotQueue();
                console.log(`📸 Merged track ${trackNumber} into existing order ${orderId} (extras: ${existing.extraTracks.length})`);
            }
            return { queued: false, merged: true };
        }
    } else if (trackNumber && trackScreenshotQueue.some(q => q.trackNumber === trackNumber)) {
        console.log(`📸 Skip duplicate queue: ${trackNumber} already queued`);
        return { queued: false, duplicate: true };
    }
    const resolvedAccount = accountName || (currentAmazonAccount ? currentAmazonAccount.split('@')[0] : '');
    trackScreenshotQueue.push({ orderId, trackNumber, trackUrl, accountName: resolvedAccount, extraTracks: [] });
    await persistScreenshotQueue();
    console.log(`📸 Queued screenshot: ${orderId} / ${trackNumber} (queue: ${trackScreenshotQueue.length})`);
    return { queued: true };
}

async function filterAlreadySent(queue) {
    const { sentScreenshots = [] } = await chrome.storage.local.get('sentScreenshots');
    const sentSet = new Set(sentScreenshots);

    // Second layer: tracking numbers that already have a screenshot_link in Sheet column H.
    // This survives storage.local reset and prevents re-screenshotting after extension reload.
    try {
        const rows = await readSheetData(DEFAULT_SPREADSHEET_ID, 'Лист1');
        if (rows && rows.length) {
            const headerOffset = rows[0] && /store|магаз/i.test(rows[0][0] || '') ? 1 : 0;
            for (let i = headerOffset; i < rows.length; i++) {
                const tracking = (rows[i][2] || '').trim();
                const link = (rows[i][7] || '').trim();
                if (tracking && link) sentSet.add(tracking);
            }
        }
    } catch (e) {
        console.warn('⚠️ Sheet dedup check failed (soft-ignored):', e?.message || e);
    }
    // Для заказа с несколькими треками (extraTracks) пропускаем ТОЛЬКО если ВСЕ
    // треки набора уже отправлены. Если появился хоть один новый трек — заказ
    // остаётся в очереди (снимется только новая карточка, см. captureEbayShipments).
    const filtered = queue.filter(item => {
        const tracks = [item.trackNumber, ...(item.extraTracks || [])].filter(Boolean);
        if (tracks.length === 0) return true; // нет трек-инфо — оставляем, решит съёмка
        return !tracks.every(t => sentSet.has(t));
    });
    const skipped = queue.length - filtered.length;
    if (skipped > 0) console.log(`📸 Пропущено ${skipped} уже отправленных скриншотов`);
    return filtered;
}

async function markAsSent(trackNumbers) {
    const { sentScreenshots = [] } = await chrome.storage.local.get('sentScreenshots');
    const updated = [...new Set([...sentScreenshots, ...trackNumbers])];
    await chrome.storage.local.set({ sentScreenshots: updated });
}

async function processScreenshotQueue() {
    await screenshotQueueReady;
    if (screenshotQueueInitError) {
        console.warn('⏸ Screenshot queue unavailable:', screenshotQueueInitError.message);
        return false;
    }
    // SW мог уснуть после queueTrackScreenshot — merge очереди из storage.
    // Сравнение только длины теряло другой item при равных размерах очередей.
    try {
        const state = await chrome.storage.local.get(['trackScreenshotQueue', 'screenshotQueueBlocked']);
        if (state.screenshotQueueBlocked) {
            console.warn('⏸ Screenshot queue remains blocked:', state.screenshotQueueBlocked);
            return false;
        }
        mergePersistedScreenshotQueue(state.trackScreenshotQueue);
    } catch (_) {}

    if (isProcessingScreenshots || trackScreenshotQueue.length === 0) return true;
    isProcessingScreenshots = true;
    await beginScreenshotStageBudget();

    try {

    const beforeFilter = trackScreenshotQueue.length;
    trackScreenshotQueue = await filterAlreadySent(trackScreenshotQueue);
    parseReport.screenshots.skipped += (beforeFilter - trackScreenshotQueue.length);
    // Важно персистить и непустой отфильтрованный snapshot, и особенно [].
    // Иначе после сна MV3 восстановится старая очередь и карточки уйдут повторно.
    await persistScreenshotQueue();
    if (trackScreenshotQueue.length === 0) {
        console.log('📸 All screenshots already sent');
        return;
    }

    const total = trackScreenshotQueue.length;
    console.log(`📸 Processing ${total} screenshots...`);
    // Send progress message that we'll delete after done
    let progressMsgId = null;
    try {
        const pRes = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: tgChatId, text: `📸 Скриншоты: 0/${total}...` })
        });
        const pJson = await pRes.json().catch(() => ({}));
        if (pJson.ok) progressMsgId = pJson.result.message_id;
    } catch(e) {}

    let done = 0;

    // Один переиспользуемый таб для всех скринов — раньше каждый item создавал
    // новую вкладку и закрывал; на 100+ скринов это быстро ронит браузер и
    // путает SPA-роутеры. Теперь только chrome.tabs.update({ url }).
    let reuseTab = null;
    try {
        reuseTab = await chrome.tabs.create({ url: 'about:blank', active: true });
    } catch (e) {
        console.warn('⚠️ Не удалось создать reusable tab, fallback на per-item create:', e?.message || e);
    }

    // Живой набор уже отправленных треков — для ПОштучного дедупа прямо в цикле.
    // filterAlreadySent (выше) фильтрует очередь ОДИН раз, батчем, до цикла. Но
    // queueTrackScreenshot доливает items в очередь ПОКА идёт парсинг, а слив
    // стартует по 1-мин аларму раньше конца парсинга — стриминговые items
    // shift()-ятся мимо батч-фильтра. eBay-ветка защищена своей проверкой, а
    // Amazon/iHerb — нет, и переснимали одно и то же каждый прогон. Эта живая
    // проверка ловит их для ВСЕХ магазинов. См. incident 2026-07-03.
    let sentSet = new Set();
    try {
        const { sentScreenshots = [] } = await chrome.storage.local.get('sentScreenshots');
        sentSet = new Set(sentScreenshots);
    } catch (_) {}

    let captchaPaused = false;
    while (trackScreenshotQueue.length > 0) {
        // Keep the in-flight item at the persisted head until delivery is
        // confirmed. A worker crash or archive error must never turn it into a
        // disappearing card.
        const item = trackScreenshotQueue[0];
        done++;
        // Поштучный дедуп: если ВСЕ треки этого заказа уже сняты — не переснимаем.
        const itemTracks = [item.trackNumber, ...(item.extraTracks || [])].filter(Boolean);
        if (itemTracks.length > 0 && itemTracks.every(t => sentSet.has(t))) {
            console.log(`⏭  skip already-sent order ${item.orderId} (${itemTracks.length} track(s))`);
            parseReport.screenshots.skipped++;
            trackScreenshotQueue.shift();
            await persistScreenshotQueue();
            continue;
        }
        // Магазин по trackUrl — чтобы в сводке прогона видеть «сколько скринов ушло по iHerb / Amazon / eBay»
        const u = String(item.trackUrl || '');
        const shop = /iherb\.com/i.test(u) ? 'iherb' : /amazon\./i.test(u) ? 'amazon' : /ebay\./i.test(u) ? 'ebay' : 'other';
        if (shop === 'iherb' || shop === 'amazon') {
            const ownerState = await chrome.storage.local.get(['multiAccountIherbState', 'multiAccountState']);
            const activeAccount = shop === 'iherb'
                ? ownerState.multiAccountIherbState?.currentIherbAccount
                : ownerState.multiAccountState?.currentAmazonAccount;
            const normalizedItemAccount = String(item.accountName || '').split('@')[0].toLowerCase();
            const normalizedActiveAccount = String(activeAccount || '').split('@')[0].toLowerCase();
            if (!normalizedItemAccount || !normalizedActiveAccount || normalizedItemAccount !== normalizedActiveAccount) {
                const blocked = {
                    kind: 'account-mismatch',
                    at: Date.now(),
                    shop,
                    itemKey: screenshotQueueKey(item),
                    accountName: item.accountName || '',
                    activeAccount: activeAccount || '',
                    orderId: item.orderId || '',
                    trackNumber: item.trackNumber || ''
                };
                await chrome.storage.local.set({ screenshotQueueBlocked: blocked });
                await persistScreenshotQueue();
                console.error(`⛔ Refusing ${shop} screenshot under a different account`);
                break;
            }
        }
        try {
            const result = await captureTrackScreenshot(item, done, total, reuseTab?.id);
            if (result?.status === 'captcha') {
                const blocked = {
                    kind: 'captcha',
                    at: Date.now(),
                    itemKey: screenshotQueueKey(item),
                    accountName: item.accountName || '',
                    orderId: item.orderId || '',
                    trackNumber: item.trackNumber || ''
                };
                await chrome.storage.local.set({ screenshotQueueBlocked: blocked });
                await persistScreenshotQueue();
                captchaPaused = true; // не закрываем reuseTab — юзер будет решать капчу там
                break;
            }

            const confirmed = new Set(Array.isArray(result?.tracks) ? result.tracks.filter(Boolean) : []);
            const unresolved = itemTracks.filter(t => !sentSet.has(t));
            if (result?.status !== 'sent' || unresolved.some(t => !confirmed.has(t))) {
                throw new Error(result?.reason || `archive did not confirm ${unresolved.length} track(s)`);
            }

            // Only a confirmed archive response may remove the item and mark
            // tracks sent. No fallback to the requested track is allowed.
            const tracksToMark = [...confirmed];
            tracksToMark.forEach(t => sentSet.add(t)); // живой дедуп в рамках слива
            parseReport.screenshots.sent++;
            parseReport.screenshots.byShop = parseReport.screenshots.byShop || {};
            parseReport.screenshots.byShop[shop] = (parseReport.screenshots.byShop[shop] || 0) + 1;
            await markAsSent(tracksToMark);

            // A producer may merge another track into this same order while
            // capture/archive is in flight. Its durable ACK means that track
            // must remain owned by the queue. Re-read the live head after the
            // final await and remove it only if every track known *now* is sent.
            const latestHead = trackScreenshotQueue[0];
            const sameHead = latestHead
                && screenshotQueueKey(latestHead) === screenshotQueueKey(item);
            const latestTracks = sameHead
                ? [latestHead.trackNumber, ...(latestHead.extraTracks || [])].filter(Boolean)
                : [];
            const lateUnsent = latestTracks.filter(track => !sentSet.has(track));
            if (!sameHead) {
                throw new Error('screenshot queue head changed during archive confirmation');
            }
            if (lateUnsent.length > 0) {
                console.log(`📸 Keeping ${item.orderId}: ${lateUnsent.length} track(s) arrived during capture`);
                await persistScreenshotQueue();
                continue;
            }
            trackScreenshotQueue.shift();
            await persistScreenshotQueue();
            // Update progress message
            if (progressMsgId) {
                const remaining = trackScreenshotQueue.length;
                fetch(`https://api.telegram.org/bot${tgBotToken}/editMessageText`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: tgChatId, message_id: progressMsgId, text: `📸 Скриншоты: ${done}/${total} (осталось ${remaining})...` })
                }).catch(() => {});
            }
        } catch (e) {
            console.error(`❌ Screenshot failed for ${item.orderId}:`, e);
            console.error(`❌ Screenshot ${done}/${total} failed: ${item.orderId} — ${e.message || e}`);
            item._attempts = Math.max(0, Number(item._attempts) || 0) + 1;
            item._lastError = String(e?.message || e).slice(0, 240);
            item._lastAttemptAt = Date.now();
            await persistScreenshotQueue();
            if (item._attempts >= SCREENSHOT_MAX_ATTEMPTS) {
                // Счётчики отчёта — по окончательно не доставленным карточкам,
                // а не по трём внутренним попыткам одной и той же карточки.
                parseReport.screenshots.failed++;
                if (/broken tracking page/i.test(item._lastError)) {
                    parseReport.screenshots.broken++;
                }
                await chrome.storage.local.set({
                    screenshotQueueBlocked: {
                        kind: 'delivery-failed',
                        at: Date.now(),
                        attempts: item._attempts,
                        itemKey: screenshotQueueKey(item),
                        accountName: item.accountName || '',
                        orderId: item.orderId || '',
                        trackNumber: item.trackNumber || '',
                        reason: item._lastError
                    }
                });
                break;
            }
        }
        // Пауза между заказами: 1.2-2.2 сек базово; iHerb триггерит на бота → 3-6 сек.
        const isIherbItem = /(secure\.|www\.)?iherb\.com/i.test(String(item.trackUrl || ''));
        const pauseMs = isIherbItem ? (3000 + Math.random() * 3000) : (1200 + Math.random() * 1000);
        await new Promise(r => setTimeout(r, pauseMs));
    }

    // Закрыть переиспользуемую вкладку (если не оставлена для решения капчи)
    if (reuseTab && !captchaPaused) {
        try { await chrome.tabs.remove(reuseTab.id); } catch (_) {}
    }

    await persistScreenshotQueue();
    console.log(`✅ Screenshots done: ${done}/${total}`);
    // Delete progress message — final stats will be in the summary report
    if (progressMsgId) {
        fetch(`https://api.telegram.org/bot${tgBotToken}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: tgChatId, message_id: progressMsgId })
        }).catch(() => {});
    }
    } finally {
        isProcessingScreenshots = false;
        await finishScreenshotStageBudget();
    }
    const { screenshotQueueBlocked = null } = await chrome.storage.local.get('screenshotQueueBlocked');
    return !screenshotQueueBlocked && trackScreenshotQueue.length === 0;
}


// === Fullpage screenshot via scroll + OffscreenCanvas stitch ===
// Используется для eBay (order.ebay.com/ord/show) и iHerb (orderdetails) —
// одна страница содержит ВЕСЬ заказ (Order info, Delivery, Tracking, Item info со всеми товарами).
// captureVisibleTab снимает только viewport, поэтому скроллим по странице, склеиваем в один PNG.
// Вычисляет список crop-spec'ов для eBay order page: один spec на каждую shipment-card.
// Каждый скрин содержит: Order info (общий) + одна shipment-card (Delivery info + Tracking details + Item info).
// Горизонтально обрезает до левой колонки (прячет Shipping address / Payment info / рекламу справа).
async function computeEbayCropSpecs(tab) {
    try {
        const res = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const orderInfo = document.querySelector('.section-module.order-info');
                const shipments = Array.from(document.querySelectorAll('.shipment-card'));
                if (!orderInfo || shipments.length === 0) return [];

                const oRect = orderInfo.getBoundingClientRect();
                const orderInfoTop = Math.round(oRect.top + window.scrollY);
                const orderInfoLeft = Math.round(oRect.left);
                const orderInfoWidth = Math.round(oRect.width);

                // Левая колонка — ширина order-info + небольшие поля по бокам
                const leftX = Math.max(0, orderInfoLeft - 30);
                const rightX = orderInfoLeft + orderInfoWidth + 30;

                // Начало: чуть выше order-info (20px поля)
                const startY = Math.max(0, orderInfoTop - 20);

                const specs = [];
                for (let i = 0; i < shipments.length; i++) {
                    const sc = shipments[i];
                    const scRect = sc.getBoundingClientRect();
                    const scTop = Math.round(scRect.top + window.scrollY);
                    const scBottom = Math.round(scRect.top + window.scrollY + scRect.height);
                    // shipment 1: показываем Order info сверху; дальше — только сам пакет
                    const shipStartY = i === 0 ? startY : Math.max(0, scTop - 20);

                    // Трек-номер из этой shipment-card
                    let trackNum = '';
                    const dts = sc.querySelectorAll('dt.eui-label');
                    // Strict tracking formats only (mirror pickBestTracking from content-ebay.js):
                    // UPS 1Z[A-Z0-9]{16}, USPS 9[2-6]\d{18,24}, Yanwen YT\d, UPU [A-Z]{2}\d{9}[A-Z]{2}.
                    // Loose /[A-Z0-9]{10,}/ used to catch product-name text like "COCTEATWINBLACK".
                    const TRACK_RE = /\b(1Z[0-9A-Z]{16}|9[2-6]\d{18,24}|YT\d{10,25}|[A-Z]{2}\d{9}[A-Z]{2})\b/;
                    for (const dt of dts) {
                        if (/^number$/i.test((dt.textContent || '').trim())) {
                            const dd = dt.parentElement?.querySelector('dd') || dt.nextElementSibling;
                            if (dd) {
                                const m = (dd.textContent || '').toUpperCase().match(TRACK_RE);
                                if (m) { trackNum = m[1]; break; }
                            }
                        }
                    }
                    // Имя первого товара в этом shipment-card
                    let itemName = '';
                    const firstItemLink = sc.querySelector('a[href*="/itm/"], a[href*="/p/"]');
                    if (firstItemLink) itemName = (firstItemLink.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 80);

                    specs.push({
                        startY: shipStartY,
                        endY: scBottom + 20,
                        leftX,
                        rightX,
                        trackNum,
                        itemName,
                        shipmentIdx: i + 1,
                        shipmentTotal: shipments.length
                    });
                }
                return specs;
            }
        });
        return res?.[0]?.result || [];
    } catch (e) {
        console.warn('⚠️ computeEbayCropSpecs failed:', e?.message || e);
        return [];
    }
}

// eBay order page: возвращает массив скриншотов (по одному на shipment-card).
// Каждый элемент: { base64, trackNum, itemName, shipmentIdx, shipmentTotal }.
// Если specs пусто (страница не стандартная) — fallback: один обычный stitch.
// Возвращает { shipments: [...], skippedAllSent: bool }.
//  - shipments === []  + skippedAllSent === false → карточки не распознались (fallback на single visible)
//  - shipments === []  + skippedAllSent === true  → все карточки заказа уже сняты ранее (ничего не слать)
//  - shipments.length > 0 → только НОВЫЕ (ещё не отправленные) карточки
async function captureEbayShipments(tab) {
    const specs = await computeEbayCropSpecs(tab);
    if (specs.length === 0) {
        const b64 = await captureFullPageStitched(tab);
        return {
            shipments: b64 ? [{ base64: b64, trackNum: '', itemName: '', shipmentIdx: 1, shipmentTotal: 1 }] : [],
            skippedAllSent: false
        };
    }

    // Дедуп на уровне карточки: уже снятые треки не переснимаем.
    let sentSet = new Set();
    try {
        const { sentScreenshots = [] } = await chrome.storage.local.get('sentScreenshots');
        sentSet = new Set(sentScreenshots);
    } catch (_) {}

    const specsWithTrack = specs.filter(s => s.trackNum);
    const alreadySentCount = specsWithTrack.filter(s => sentSet.has(s.trackNum)).length;

    const out = [];
    for (const spec of specs) {
        if (spec.trackNum && sentSet.has(spec.trackNum)) {
            console.log(`⏭  skip already-sent track ${spec.trackNum} (card ${spec.shipmentIdx}/${spec.shipmentTotal})`);
            continue;
        }
        const b64 = await captureFullPageStitched(tab, {
            startY: spec.startY,
            endY: spec.endY,
            leftX: spec.leftX,
            rightX: spec.rightX
        });
        if (b64) out.push({
            base64: b64,
            trackNum: spec.trackNum,
            itemName: spec.itemName,
            shipmentIdx: spec.shipmentIdx,
            shipmentTotal: spec.shipmentTotal
        });
    }

    // Все карточки с трек-номером уже были сняты ранее, ничего нового не осталось.
    const skippedAllSent = specsWithTrack.length > 0 &&
                           alreadySentCount === specsWithTrack.length &&
                           out.length === 0;
    return { shipments: out, skippedAllSent };
}

async function captureFullPageStitched(tab, override = null) {
    try {
        // 1) Скрываем только sticky/fixed (header не должен повторяться при scroll).
        //    Высоту страницы РЕЖЕМ по top'у самой ранней рекламной секции — НЕ трогаем DOM содержания.
        //    override: { startY, endY, leftX, rightX } — прицельный crop для eBay multi-shipment.
        const measure = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            args: [override || null],
            func: (override) => {
                const hidden = [];
                const hide = (el) => {
                    if (!el || el.dataset?.parserHidden === '1') return;
                    hidden.push({ el, prev: el.style.visibility });
                    el.style.setProperty('visibility', 'hidden', 'important');
                    el.dataset.parserHidden = '1';
                };

                // Скрываем только sticky/fixed элементы (header/баннер cookie)
                document.querySelectorAll('*').forEach(el => {
                    try {
                        const cs = getComputedStyle(el);
                        if (cs.position === 'fixed' || cs.position === 'sticky') hide(el);
                    } catch(_) {}
                });

                window.__parserHiddenBackup = hidden;

                const dpr = window.devicePixelRatio || 1;
                const fullPageHeight = Math.max(
                    document.body.scrollHeight,
                    document.documentElement.scrollHeight,
                    document.body.offsetHeight,
                    document.documentElement.offsetHeight
                );

                const host = location.hostname;
                let startY = 0;
                let endY = fullPageHeight;
                let leftX = 0;
                let rightX = window.innerWidth;

                if (override) {
                    // Прицельный crop (eBay shipment-card): startY/endY/leftX/rightX заданы снаружи.
                    startY = Math.max(0, override.startY | 0);
                    endY = Math.min(fullPageHeight, override.endY | 0) || fullPageHeight;
                    if (typeof override.leftX === 'number') leftX = Math.max(0, override.leftX);
                    if (typeof override.rightX === 'number') rightX = Math.min(window.innerWidth, override.rightX);
                } else if (host.includes('order.ebay.com')) {
                    const summary = document.querySelector('.summary-region');
                    const orderInfo = document.querySelector('.section-module.order-info');
                    const orderDetailsH1 = Array.from(document.querySelectorAll('h1')).find(h => /order details/i.test(h.textContent || ''));
                    if (summary) {
                        const r = summary.getBoundingClientRect();
                        startY = Math.max(0, Math.round(r.top + window.scrollY) - 20);
                    } else if (orderInfo) {
                        const r = orderInfo.getBoundingClientRect();
                        startY = Math.max(0, Math.round(r.top + window.scrollY) - 60);
                    } else if (orderDetailsH1) {
                        const r = orderDetailsH1.getBoundingClientRect();
                        startY = Math.max(0, Math.round(r.top + window.scrollY) - 20);
                    }
                    // endY: первый из "Other actions" / evo-banner после Item info
                    const cutoffSelectors = [
                        '.order-level-actions-title',
                        '.evo-banner-confirmation__headline',
                        '.evo-banner-confirmation'
                    ];
                    let bestCutoff = Infinity;
                    cutoffSelectors.forEach(sel => {
                        document.querySelectorAll(sel).forEach(el => {
                            const r = el.getBoundingClientRect();
                            const top = Math.round(r.top + window.scrollY);
                            if (top > startY + 200 && top < bestCutoff) bestCutoff = top;
                        });
                    });
                    if (bestCutoff === Infinity) {
                        // text fallback
                        document.querySelectorAll('h1, h2, h3, h4').forEach(h => {
                            const txt = (h.textContent || '').trim();
                            if (/other actions|looking for more great deals|these are for you/i.test(txt)) {
                                const rect = h.getBoundingClientRect();
                                const top = Math.round(rect.top + window.scrollY);
                                if (top > startY + 200 && top < bestCutoff) bestCutoff = top;
                            }
                        });
                    }
                    if (bestCutoff !== Infinity) endY = bestCutoff + 20; // +20 чтобы заголовок Item info влез
                } else {
                    // Generic: cutoff по рекламным якорям
                    const adPatterns = [
                        /inspired by your recent views/i,
                        /frequently bought together/i,
                        /compare with similar items/i,
                        /these are for you/i,
                        /people who viewed this item also viewed/i,
                        /more from this seller/i,
                        /sign up to get email promotions/i,
                        /looking for more great deals/i,
                        /explore (related|this store)/i,
                        /related (sponsored|searches|items)/i
                    ];
                    let cutoffY = fullPageHeight;
                    document.querySelectorAll('h1, h2, h3, h4, span, p').forEach(h => {
                        const txt = (h.textContent || '').trim();
                        if (!txt || txt.length > 80) return;
                        if (!adPatterns.some(p => p.test(txt))) return;
                        const rect = h.getBoundingClientRect();
                        const absTop = rect.top + window.scrollY;
                        if (absTop > 200 && absTop < cutoffY) cutoffY = absTop;
                    });
                    cutoffY = Math.max(cutoffY, window.innerHeight * 1.5);
                    endY = cutoffY;
                }

                window.scrollTo(0, startY);

                return {
                    startY,
                    endY,
                    leftX,
                    rightX,
                    pageHeight: Math.max(1, endY - startY),
                    fullPageHeight,
                    viewportHeight: window.innerHeight,
                    viewportWidth: window.innerWidth,
                    devicePixelRatio: dpr,
                    hiddenCount: hidden.length,
                    cutoffApplied: (endY - startY) < fullPageHeight,
                    host
                };
            }
        });
        const dims = measure?.[0]?.result;
        if (!dims) throw new Error('failed to measure page');

        const { pageHeight, viewportHeight, viewportWidth, devicePixelRatio } = dims;
        const startY = dims.startY || 0;
        // Ограничиваем максимум по высоте чтобы не выйти за лимит Telegram (10 МБ)
        const MAX_PAGE_HEIGHT = 12000;
        const effectivePageHeight = Math.min(pageHeight, MAX_PAGE_HEIGHT);
        const numSteps = Math.max(1, Math.ceil(effectivePageHeight / viewportHeight));

        const captures = [];
        // Цикл скрин-захвата с естественными микро-задержками
        let lastCaptureAt = 0;
        for (let i = 0; i < numSteps; i++) {
            // Чуть рандомизированный шаг (±40px) — не идеально-механически
            const jitter = i === 0 ? 0 : (Math.floor(Math.random() * 80) - 40);
            const scrollY = Math.max(0, startY + i * viewportHeight + jitter);
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: (y) => {
                    window.scrollTo({ top: y, behavior: 'instant' });
                    // Лёгкий mousemove — выглядит как живой скролл
                    document.dispatchEvent(new MouseEvent('mousemove', {
                        bubbles: true,
                        clientX: Math.floor(Math.random() * window.innerWidth),
                        clientY: Math.floor(Math.random() * window.innerHeight)
                    }));
                },
                args: [scrollY]
            });
            // Ждём подгрузки lazy картинок: 280-400мс хватает на eBay/iHerb (картинки уже в кэше после прокрутки)
            await new Promise(r => setTimeout(r, 280 + Math.random() * 120));
            // Соблюдаем Chrome лимит captureVisibleTab (~2 raz/сек): минимум 520мс между вызовами
            const sinceLast = Date.now() - lastCaptureAt;
            if (lastCaptureAt && sinceLast < 520) {
                await new Promise(r => setTimeout(r, 520 - sinceLast));
            }
            try {
                const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
                captures.push({ dataUrl, scrollY });
                lastCaptureAt = Date.now();
            } catch (e) {
                console.warn(`⚠️ captureVisibleTab step ${i+1}/${numSteps} failed:`, e?.message || e);
                // При rate-limit — ждём и retry разово
                if (/MAX_CAPTURE_VISIBLE_TAB_CALLS/i.test(e?.message || '')) {
                    await new Promise(r => setTimeout(r, 1100));
                    try {
                        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
                        captures.push({ dataUrl, scrollY });
                        lastCaptureAt = Date.now();
                        continue;
                    } catch (_) {}
                }
                if (captures.length === 0) throw e;
                break;
            }
        }

        // Восстанавливаем скрытые элементы (sticky + реклама)
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                if (Array.isArray(window.__parserHiddenBackup)) {
                    window.__parserHiddenBackup.forEach(b => {
                        try {
                            b.el.style.visibility = b.prev || '';
                            delete b.el.dataset.parserHidden;
                        } catch(_) {}
                    });
                    window.__parserHiddenBackup = null;
                }
            }
        }).catch(() => {});

        if (captures.length === 0) return null;

        // 2) Склейка/кроп через OffscreenCanvas (доступен в SW MV3).
        //    Даже при 1 capture идём через canvas — нужно обрезать до pageHeight и отмасштабировать.
        const bitmaps = [];
        for (const c of captures) {
            const blob = await (await fetch(c.dataUrl)).blob();
            const bm = await createImageBitmap(blob);
            bitmaps.push({ bm, scrollY: c.scrollY });
        }

        // === Telegram photo лимит: width + height ≤ 10000, ratio ≤ 20:1 ===
        // 1600px — комфортно для чтения, sendDocument fallback покрывает остальные случаи
        const TARGET_WIDTH = 1600;
        // Горизонтальный crop (только левая колонка для eBay order page)
        const leftX = typeof dims.leftX === 'number' ? dims.leftX : 0;
        const rightX = typeof dims.rightX === 'number' ? dims.rightX : dims.viewportWidth;
        const cropLeftPx = Math.max(0, Math.round(leftX * devicePixelRatio));
        const cropRightPx = Math.min(bitmaps[0].bm.width, Math.round(rightX * devicePixelRatio));
        const sourceWidth = Math.max(1, cropRightPx - cropLeftPx);  // PNG-px после crop
        const scale = Math.min(1, TARGET_WIDTH / sourceWidth);
        const finalWidth = Math.round(sourceWidth * scale);

        // Высота: общая страница в PNG-px после scale, но не больше лимита
        const totalSourceHeight = Math.min(
            effectivePageHeight * devicePixelRatio,
            bitmaps.reduce((sum, b) => sum + b.bm.height, 0)
        );
        const MAX_FINAL_HEIGHT = 10000 - finalWidth - 200; // запас на округление
        let finalHeight = Math.min(Math.round(totalSourceHeight * scale), MAX_FINAL_HEIGHT);
        if (finalHeight < 100) finalHeight = 100;

        const canvas = new OffscreenCanvas(finalWidth, finalHeight);
        const ctx = canvas.getContext('2d');

        let drawn = 0;
        for (let i = 0; i < bitmaps.length; i++) {
            const { bm } = bitmaps[i];
            const ySource = i * viewportHeight * devicePixelRatio;
            const remainingSourceHeight = totalSourceHeight - ySource;
            const drawSourceHeight = Math.min(bm.height, remainingSourceHeight);
            if (drawSourceHeight <= 0) break;
            const yDest = Math.round(ySource * scale);
            const drawDestHeight = Math.round(drawSourceHeight * scale);
            // Если выходим за финальную высоту — обрезаем
            const safeDestHeight = Math.min(drawDestHeight, finalHeight - yDest);
            if (safeDestHeight <= 0) break;
            const safeSourceHeight = Math.round(safeDestHeight / scale);
            ctx.drawImage(
                bm,
                cropLeftPx, 0, sourceWidth, safeSourceHeight,
                0, yDest, finalWidth, safeDestHeight
            );
            drawn++;
            bm.close();
        }
        if (drawn === 0) return null;

        const blob = await canvas.convertToBlob({ type: 'image/png' });
        // Blob → base64
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        const base64 = btoa(binary);
        console.log(`📸 Stitched ${drawn} captures → ${(blob.size / 1024).toFixed(0)}KB`);
        return base64;
    } catch (e) {
        console.error('❌ captureFullPageStitched error:', e);
        return null;
    }
}

// iHerb tracking page (secure.iherb.com/tr/carrierTracking) — кропим только левую карточку:
// 4 верхние секции в .row > .column (carrier + expected delivery + product thumbs + timeline).
// Ждём пока догрузятся картинки товаров (async), затем скроллим карточку в topViewport и режем виз. скрин.
async function captureIherbTrackingCard(tab) {
    try {
        // 1) Скролл карточки наверх + ожидание загрузки product thumbnails
        const measure = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async () => {
                const delay = ms => new Promise(r => setTimeout(r, ms));
                const col = document.querySelector('.row > .column');
                if (!col) return { error: 'no_column' };
                const sections = Array.from(col.children).slice(0, 4);
                if (sections.length < 2) return { error: 'not_enough_sections' };

                // Скрываем sticky/fixed чтобы не перекрывали карточку при скролле
                const hidden = [];
                document.querySelectorAll('*').forEach(el => {
                    try {
                        const cs = getComputedStyle(el);
                        if ((cs.position === 'fixed' || cs.position === 'sticky') && el.dataset.parserHidden !== '1') {
                            hidden.push({ el, prev: el.style.visibility });
                            el.style.setProperty('visibility', 'hidden', 'important');
                            el.dataset.parserHidden = '1';
                        }
                    } catch (_) {}
                });
                window.__iherbCardHidden = hidden;

                // Скроллим первую секцию к верху вьюпорта (с небольшим отступом)
                const topOffset = 10;
                const firstRect = sections[0].getBoundingClientRect();
                window.scrollBy({ top: firstRect.top - topOffset, behavior: 'instant' });
                await delay(400);

                // Ждём пока картинки в карточке догрузятся (product thumbs лениво).
                // Условие: все <img> внутри карточки имеют complete===true И naturalHeight>0 И width>10.
                // Таймаут 20 сек — iHerb медленно грузит thumbs.
                const allImgs = () => sections.flatMap(s => Array.from(s.querySelectorAll('img')));
                const imgsReady = () => {
                    const list = allImgs();
                    if (list.length === 0) return true;
                    return list.every(i => i.complete && i.naturalHeight > 0 && i.naturalWidth > 10);
                };
                const t0 = Date.now();
                while (!imgsReady() && Date.now() - t0 < 20000) {
                    await delay(400);
                }
                await delay(1200); // pixel stability + decode finish

                // Обмеряем объединённый bounding box первых 4 секций
                const rects = sections.map(s => s.getBoundingClientRect());
                const x = Math.max(0, Math.floor(Math.min(...rects.map(r => r.left)) - 8));
                const yTop = Math.max(0, Math.floor(Math.min(...rects.map(r => r.top)) - 8));
                const right = Math.min(window.innerWidth, Math.ceil(Math.max(...rects.map(r => r.right)) + 8));
                const bottom = Math.min(window.innerHeight, Math.ceil(Math.max(...rects.map(r => r.bottom)) + 8));
                const w = right - x;
                const h = bottom - yTop;
                const dpr = window.devicePixelRatio || 1;
                return {
                    x, y: yTop, w, h, dpr,
                    imgsLoaded: allImgs().filter(i => i.complete && i.naturalHeight > 0).length,
                    imgsTotal: allImgs().length,
                    sectionsCount: sections.length,
                };
            }
        });
        const m = measure?.[0]?.result;
        if (!m || m.error) {
            console.warn('⚠️ captureIherbTrackingCard measure failed:', m);
            return null;
        }
        console.log(`📐 iHerb card: ${m.w}x${m.h}@${m.x},${m.y} dpr=${m.dpr} imgs=${m.imgsLoaded}/${m.imgsTotal}`);

        // 2) captureVisibleTab
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

        // 3) Crop через OffscreenCanvas
        const blob = await (await fetch(dataUrl)).blob();
        const bitmap = await createImageBitmap(blob);
        const cx = Math.round(m.x * m.dpr);
        const cy = Math.round(m.y * m.dpr);
        const cw = Math.round(m.w * m.dpr);
        const ch = Math.round(m.h * m.dpr);
        const canvas = new OffscreenCanvas(cw, ch);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, cx, cy, cw, ch, 0, 0, cw, ch);
        const cropBlob = await canvas.convertToBlob({ type: 'image/png' });
        const arr = new Uint8Array(await cropBlob.arrayBuffer());
        let bin = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < arr.length; i += chunkSize) bin += String.fromCharCode.apply(null, arr.subarray(i, i + chunkSize));
        const base64 = btoa(bin);

        // 4) Восстанавливаем скрытые элементы
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    const h = window.__iherbCardHidden || [];
                    h.forEach(({ el, prev }) => {
                        try { el.style.visibility = prev || ''; delete el.dataset.parserHidden; } catch (_) {}
                    });
                    window.__iherbCardHidden = null;
                }
            });
        } catch (_) {}

        console.log(`📸 iHerb tracking card cropped → ${(cropBlob.size / 1024).toFixed(0)}KB`);
        return base64;
    } catch (e) {
        console.error('❌ captureIherbTrackingCard error:', e);
        return null;
    }
}

async function captureTrackScreenshot({ orderId, trackNumber, trackUrl, accountName, extraTracks }, current, total, reuseTabId) {
    // markAsSent receives only tracks whose archive request actually succeeded.
    // The old code pre-filled this set from the request, so every error looked
    // like a successful delivery and the queue item was deleted.
    const expectedTracks = [trackNumber, ...(extraTracks || [])].filter(Boolean);
    const capturedTracks = new Set();
    if (!trackUrl) return { status: 'failed', reason: 'missing tracking URL', tracks: [] };

    let fullUrl = trackUrl;
    if (fullUrl.startsWith('http')) {
        // Already absolute (e.g. eBay order.ebay.com/ord/show, iHerb secure.iherb.com)
    } else if (fullUrl.startsWith('/')) {
        fullUrl = 'https://www.amazon.com' + fullUrl;
    } else {
        fullUrl = 'https://www.amazon.com/' + fullUrl;
    }
    const isAmazon = /(^https?:\/\/)?(www\.)?amazon\.com/i.test(fullUrl);
    const isEbay = /(^https?:\/\/)?(www\.|order\.)?ebay\.com/i.test(fullUrl);
    const isIherb = /(^https?:\/\/)?(secure\.|www\.)?iherb\.com/i.test(fullUrl);

    console.log(`📸 [${current}/${total}] Capturing: ${orderId} / ${trackNumber} -> ${fullUrl.substring(0, 80)} (amazon=${isAmazon}, reuse=${!!reuseTabId})`);

    let tab;
    let keepTabOpen = false;
    let createdLocally = false;
    try {
        if (reuseTabId) {
            try {
                tab = await chrome.tabs.update(reuseTabId, { url: fullUrl, active: true });
            } catch (e) {
                console.warn('⚠️ reuseTab update failed, fallback to create:', e?.message || e);
                tab = await chrome.tabs.create({ url: fullUrl, active: true });
                createdLocally = true;
            }
        } else {
            tab = await chrome.tabs.create({ url: fullUrl, active: true });
            createdLocally = true;
        }

        await new Promise(resolve => {
            function onUpdated(tabId, info) {
                if (tabId === tab.id && info.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(onUpdated);
                    resolve();
                }
            }
            chrome.tabs.onUpdated.addListener(onUpdated);
            setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(onUpdated);
                resolve();
            }, 10000);
        });

        // --- ПРОВЕРКА КАПЧИ ---
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    const html = document.body ? document.body.innerHTML : "";
                    if (html.includes('Type the characters you see in this image') || 
                        document.getElementById('captchacharacters')) {
                        return true;
                    }
                    return false;
                }
            });
            if (results && results[0] && results[0].result === true) {
                console.error('🚨 CAPTCHA DETECTED! Stopping queue.');
                sendTelegramMessage('🚨 ВНИМАНИЕ: На Amazon вылезла капча! Парсинг скриншотов приостановлен.\nПерейдите в открытую вкладку Amazon и решите капчу.');
                keepTabOpen = true; // Не закрываем вкладку, чтобы юзер мог решить
                return { status: 'captcha', reason: 'captcha', tracks: [] };
            }
        } catch (captchaErr) {
            console.warn('⚠️ Ошибка проверки капчи:', captchaErr);
        }

        // --- BROKEN TRACKING PAGE CHECK (Amazon-specific) ---
        // Amazon часто показывает "Sorry, we are unable to get the tracking information.
        // Redirecting to Your Orders in N seconds" с задержкой после complete.
        // Polling: ждём до 6 сек, проверяя каждые 500мс. Заодно — детект URL-редиректа на /your-orders.
        if (isAmazon) {
            try {
                let broken = false;
                for (let attempt = 0; attempt < 12; attempt++) {
                    // 1) URL-проверка: редиректнул на /your-orders без shipment id?
                    const tabInfo2 = await chrome.tabs.get(tab.id).catch(() => null);
                    const curUrl = tabInfo2?.url || '';
                    if (/\/your-orders\/orders/i.test(curUrl) && !/shipmentId=|orderId=/i.test(curUrl)) {
                        console.log(`⚠️ Amazon redirected to your-orders for ${trackNumber}: ${curUrl.substring(0,100)}`);
                        broken = true;
                        break;
                    }
                    // 2) Текстовая проверка
                    const r = await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        func: () => {
                            const text = document.body?.innerText || '';
                            const hasError = /sorry,?\s*we are unable to get the tracking information/i.test(text) ||
                                             /redirecting to your orders/i.test(text);
                            // Также детектим "пустую" страницу: нет ни карусели, ни прогресс-бара
                            const hasContent = !!document.querySelector(
                                '.promise-card-carousel-container, .promise-progress-bar, [class*="ship-track" i], [data-component*="tracking" i]'
                            );
                            return { hasError, hasContent, len: text.length };
                        }
                    });
                    const res = r?.[0]?.result || {};
                    if (res.hasError) {
                        broken = true;
                        break;
                    }
                    if (res.hasContent && res.len > 200) break; // контент загрузился — выходим
                    await new Promise(r => setTimeout(r, 500));
                }
                if (broken) {
                    console.log(`⚠️ Broken tracking page for ${trackNumber}, skipping screenshot`);
                    return { status: 'failed', reason: 'broken tracking page', tracks: [] };
                }
            } catch (e) {
                console.warn('⚠️ Broken page check failed:', e?.message || e);
            }
        }

        // --- Лёгкая прелюдия (anti-bot) — короткое движение мыши, без scrollIntoView ---
        // Для eBay/iHerb stitch сам управляет скроллом; для Amazon просто остаёмся на верху страницы.
        await new Promise(r => setTimeout(r, 350 + Math.random() * 350));
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                args: [{ isAmazon }],
                func: async (cfg) => {
                    const delay = ms => new Promise(res => setTimeout(res, ms));
                    // 1-2 случайных mousemove — выглядит органично, не палит автоматизацию
                    const moves = 1 + Math.floor(Math.random() * 2);
                    for (let i = 0; i < moves; i++) {
                        const x = Math.floor(Math.random() * window.innerWidth);
                        const y = Math.floor(Math.random() * window.innerHeight);
                        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
                        await delay(80 + Math.random() * 120);
                    }
                    if (cfg.isAmazon) {
                        window.scrollTo({ top: 0, behavior: 'instant' });
                        await delay(200);
                    }
                }
            });
        } catch (injectErr) {
            console.warn('⚠️ Mouse pre-move failed:', injectErr?.message || injectErr);
        }

        const tabInfo = await chrome.tabs.get(tab.id);
        const finalUrl = tabInfo.url || '';
        if (finalUrl.includes('signin') || finalUrl.includes('ap/challenge')) {
            console.log(`⚠️ Skipping screenshot - login page: ${finalUrl.substring(0, 80)}`);
            return { status: 'failed', reason: 'tracking page requires login', tracks: [] };
        }

        // --- SCREENSHOTS ---
        // Amazon: карусель карточек товаров (до 3 страниц), снимаем captureVisibleTab по странице.
        // eBay/iHerb: страница заказа целиком — делаем full-page scroll+stitch один скрин на orderId.
        let screenshotsTaken = 0;
        let firstPageLink = null;

        // === Ветка eBay: по скрину на каждую shipment-card (один заказ может содержать несколько отправок) ===
        if (isEbay) {
            try {
                const allTracks = [trackNumber, ...(extraTracks || [])].filter(Boolean);
                const accountTag = accountName ? '\n📧 ' + esc(accountName) : '';
                const ebayResult = await captureEbayShipments(tab);
                const shipments = ebayResult.shipments || [];

                if (ebayResult.skippedAllSent) {
                    // Все shipment-карточки заказа уже были сняты в прошлые прогоны →
                    // ничего нового не шлём, заказ считаем обработанным.
                    console.log(`⏭  eBay: все карточки заказа ${orderId} уже сняты ранее — ничего не отправляю`);
                    expectedTracks.forEach(track => capturedTracks.add(track));
                } else if (shipments.length === 0) {
                    console.warn(`⚠️ captureEbayShipments returned [] for ${orderId}, fallback to single visible`);
                    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
                    const fallbackBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
                    const captionFallback = `📦 ${orderLink(orderId)}\n🚚 ${esc(trackNumber || '—')}${accountTag}`;
                    const archive = await sendScreenshotToArchive(fallbackBase64, captionFallback);
                    if (!archive?.ok) throw new Error('eBay fallback archive failed');
                    if (archive.link) firstPageLink = archive.link;
                    expectedTracks.forEach(track => capturedTracks.add(track));
                    screenshotsTaken++;
                } else {
                    for (const s of shipments) {
                        // Packet without its own per-shipment tracking = seller hasn't shipped yet.
                        // Previously we fell back to order-level `trackNumber` here — that leaked the
                        // shipped packet's tracking onto unshipped siblings (see order 22-14502-80036:
                        // one real USPS for sneakers got stamped onto two Cocteau Twins shirts that
                        // were still "Paid / Tracking available" pending). Skip such packets — when the
                        // seller actually ships, next parser run will pick the real track up.
                        if (!s.trackNum) {
                            console.log(`⏭  skip shipment ${s.shipmentIdx}/${s.shipmentTotal} for ${orderId} — no tracking yet`);
                            continue;
                        }
                        const track = s.trackNum;
                        const trackLine = '🚚 ' + esc(track);
                        const shipTag = s.shipmentTotal > 1 ? ` • коробка ${s.shipmentIdx} из ${s.shipmentTotal}` : '';
                        // Полный состав коробки из собранных строк; если их нет — хотя бы
                        // название первого товара со страницы, как было раньше.
                        const itemLine = (await itemsCaptionLine(orderId, track))
                            || (s.itemName ? ('\n🛒 ' + esc(s.itemName)) : '');
                        const caption = `📦 ${orderLink(orderId)}${shipTag}\n${trackLine}${itemLine}${accountTag}`;
                        const archive = await sendScreenshotToArchive(s.base64, caption);
                        if (!archive?.ok) throw new Error(`eBay archive failed for ${track}`);
                        capturedTracks.add(track);
                        if (archive.link) {
                            if (!firstPageLink) firstPageLink = archive.link;
                            try { await writeScreenshotLinkToSheet(s.trackNum, archive.link); }
                            catch (e) { console.warn(`⚠️ writeScreenshotLinkToSheet ${s.trackNum}:`, e?.message || e); }
                        }
                        screenshotsTaken++;
                    }
                }
                console.log(`✅ eBay screenshots sent for ${orderId} (shipments: ${shipments.length}, tracks: ${allTracks.length})`);
            } catch (capErr) {
                console.error(`❌ eBay capture failed for ${orderId}:`, capErr);
                throw capErr;
            }
        } else if (isIherb) {
            try {
                const allTracks = [trackNumber, ...(extraTracks || [])].filter(Boolean);
                // Кадр снимается со страницы ОДНОЙ посылки (secure.iherb.com/tr/carrierTracking),
                // поэтому и номер в подписи должен быть ОДИН — тот, что на картинке. Раньше сюда
                // склеивались через запятую все номера заказа, и оператор не понимал, что на кадре.
                const tracksLine = '🚚 ' + esc(trackNumber || '—');
                const accountTag = accountName ? '\n📧 ' + esc(accountName) : '';
                const itemsLine = await itemsCaptionLine(orderId, trackNumber);
                const captionFull = `📦 ${orderLink(orderId)}\n${tracksLine}${itemsLine}${accountTag}`;

                // iHerb: кропим только левую tracking-карточку (carrier + delivery + product thumbs + timeline).
                // Ждём пока догрузятся картинки товаров — без этого снимок получается без thumb-квадратиков.
                const cardBase64 = await captureIherbTrackingCard(tab);
                if (!cardBase64) {
                    console.warn(`⚠️ captureIherbTrackingCard returned null for ${orderId}, fallback to visible`);
                    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
                    const fallbackBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
                    const archive = await sendScreenshotToArchive(fallbackBase64, captionFull);
                    if (!archive?.ok) throw new Error('iHerb fallback archive failed');
                    if (archive.link) firstPageLink = archive.link;
                } else {
                    const archive = await sendScreenshotToArchive(cardBase64, captionFull);
                    if (!archive?.ok) throw new Error('iHerb archive failed');
                    if (archive.link) firstPageLink = archive.link;
                }
                allTracks.forEach(track => capturedTracks.add(track));
                screenshotsTaken++;
                console.log(`✅ iHerb tracking card screenshot sent for ${orderId} (tracks: ${allTracks.length})`);

                // Ссылку на кадр пишем ТОЛЬКО тому номеру посылки, который на кадре и есть.
                // Раньше одна ссылка проставлялась всем номерам заказа — и вторая коробка
                // навсегда считалась снятой (фильтр «уже присылали» смотрит именно эту колонку),
                // то есть её карточка не приходила НИКОГДА.
                if (firstPageLink && trackNumber) {
                    try { await writeScreenshotLinkToSheet(trackNumber, firstPageLink); }
                    catch (e) { console.warn(`⚠️ writeScreenshotLinkToSheet ${trackNumber}:`, e?.message || e); }
                }
            } catch (capErr) {
                console.error(`❌ Fullpage capture failed for ${orderId}:`, capErr);
                throw capErr;
            }
        } else {
            // === Ветка Amazon (как было): карусель ===
            let carouselPages = 1;
            if (isAmazon) {
                try {
                    const pagesCheck = await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        func: () => {
                            const c = document.querySelector('.promise-card-carousel-container');
                            if (!c) return 1;
                            const cards = c.querySelectorAll('.a-carousel-card');
                            const viewport = c.querySelector('.a-carousel-viewport, .a-carousel-row-inner');
                            if (!viewport || cards.length <= 4) return 1;
                            const visW = viewport.getBoundingClientRect().width;
                            const cardW = cards[0]?.getBoundingClientRect()?.width || 100;
                            const perPage = Math.max(1, Math.floor(visW / cardW));
                            return Math.min(3, Math.ceil(cards.length / perPage));
                        }
                    });
                    carouselPages = pagesCheck?.[0]?.result || 1;
                } catch(e) { console.warn('Carousel pages check failed:', e); }
                console.log(`📸 Carousel: ${carouselPages} page(s) for ${orderId}`);
            }

            for (let page = 1; page <= carouselPages; page++) {
                let dataUrl;
                try {
                    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
                } catch (captureErr) {
                    console.error(`❌ captureVisibleTab failed (page ${page}):`, captureErr);
                    break;
                }
                const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
                const pageLabel = carouselPages > 1 ? ` • кадр ${page} из ${carouselPages}` : '';
                const accountTag = accountName ? '\n📧 ' + esc(accountName) : '';
                const itemLine = await itemsCaptionLine(orderId, trackNumber);
                const caption = `📦 ${orderLink(orderId)}${pageLabel}\n🚚 ${esc(trackNumber)}${itemLine}${accountTag}`;

                const archive = await sendScreenshotToArchive(base64, caption);
                if (!archive?.ok) throw new Error(`Amazon archive failed on carousel page ${page}`);
                if (archive.link && !firstPageLink) firstPageLink = archive.link;

                screenshotsTaken++;
                console.log(`✅ Screenshot ${page}/${carouselPages} sent for ${orderId}`);

                if (isAmazon && page < carouselPages) {
                    try {
                        await chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            func: () => {
                                const c = document.querySelector('.promise-card-carousel-container');
                                const btn = c?.querySelector('.a-carousel-goto-nextpage');
                                if (btn) btn.click();
                            }
                        });
                    } catch (e) { console.warn('Carousel click failed:', e); break; }
                    await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
                }
            }
            if (firstPageLink && trackNumber) {
                try { await writeScreenshotLinkToSheet(trackNumber, firstPageLink); }
                catch (e) { console.warn(`⚠️ writeScreenshotLinkToSheet ${trackNumber}:`, e?.message || e); }
            }
            if (screenshotsTaken > 0 && trackNumber) capturedTracks.add(trackNumber);
        }
    } finally {
        // Закрываем только если сами создали локальную вкладку (без reuseTabId).
        // reuse-таб закроет processScreenshotQueue после всего цикла.
        if (tab && createdLocally && !keepTabOpen) {
            try { await chrome.tabs.remove(tab.id); } catch (_) {}
        }
    }
    if (capturedTracks.size === 0 && expectedTracks.length > 0) {
        return { status: 'failed', reason: 'no screenshot was archived', tracks: [] };
    }
    return { status: 'sent', tracks: Array.from(capturedTracks) };
}

/**
 * Write Telegram deep-link to Sheet column H for all rows matching given tracking number.
 * Sheet columns: A=store, B=order_id, C=tracking, D=name, E=qty, F=color, G=size, H=screenshot_link.
 * Parser usually writes only A-G at append time, so H is safe to set independently.
 */
async function writeScreenshotLinkToSheet(trackNumber, link) {
    if (!trackNumber || !link) return;
    const spreadsheetId = DEFAULT_SPREADSHEET_ID;
    const sheetName = 'Лист1';

    const rows = await readSheetData(spreadsheetId, sheetName);
    if (!rows || !rows.length) return;

    // Header row detection (col A header like "store" or "Магазин")
    const headerOffset = rows[0] && /store|магаз/i.test(rows[0][0] || '') ? 1 : 0;

    // Find all rows where column C (tracking) matches
    const matchedRowsSheetIndex = [];
    for (let i = headerOffset; i < rows.length; i++) {
        const t = (rows[i][2] || '').trim();
        if (t && t === trackNumber) {
            // Don't overwrite if already has a link (idempotent)
            const existing = (rows[i][7] || '').trim();
            if (!existing) matchedRowsSheetIndex.push(i + 1); // 1-based row
        }
    }

    if (!matchedRowsSheetIndex.length) {
        console.log(`ℹ️ No empty H cells to update for tracking ${trackNumber}`);
        return;
    }

    const token = await getAuthToken(true);
    const data = matchedRowsSheetIndex.map(r => ({
        range: `${sheetName}!H${r}`,
        values: [[link]]
    }));

    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data })
    });

    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`batchUpdate H failed: ${res.status} ${t}`);
    }
    console.log(`📝 Wrote screenshot link to Sheet H for ${matchedRowsSheetIndex.length} row(s) (tracking ${trackNumber})`);
}
// ... Google Sheets helpers use getAuthToken() defined above ...

async function getSheetId(spreadsheetId, sheetName){
    const token = await getAuthToken(true);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId,title))`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`Sheet metadata error: ${res.status}`);
    const data = await res.json();
    const sheet = (data.sheets||[]).map(s=>s.properties).find(p=>p.title===sheetName);
    if (!sheet) throw new Error(`Sheet '${sheetName}' not found`);
    return sheet.sheetId;
}

async function markRowsDone(spreadsheetId, sheetName, rowIndices, colorProcessed, hasWarning){
    // Write status to column F for given rows; then color rows accordingly
    const token = await getAuthToken(true);

    // Decide value & color
    const statusValue = hasWarning ? '⚠️ РАЗНЫЕ ЗАКАЗЫ' : `DONE ${new Date().toISOString().replace('T',' ').slice(0,16)}`;

    // Batch values update for F cells
    const data = rowIndices.map(r=>({ range: `${sheetName}!F${r}`, values: [[statusValue]] }));
    const res1 = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data })
    });
    if (!res1.ok) {
        const t = await res1.text().catch(()=> '');
        console.warn('batchUpdate values error:', t);
    }

    if (!colorProcessed) return;

    // Color full rows A:Z (0..26)
    const sheetId = await getSheetId(spreadsheetId, sheetName);
    const bg = hasWarning
      ? { red: 1.0, green: 0.95, blue: 0.75 }   // light yellow
      : { red: 0.86, green: 0.96, blue: 0.86 }; // light green

    const requests = rowIndices.map(r => ({
        repeatCell: {
            range: {
                sheetId,
                startRowIndex: r-1,
                endRowIndex: r,
                startColumnIndex: 0,
                endColumnIndex: 26
            },
            cell: { userEnteredFormat: { backgroundColor: bg } },
            fields: 'userEnteredFormat.backgroundColor'
        }
    }));

    const res2 = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests })
    });
    if (!res2.ok) {
        const t = await res2.text().catch(()=> '');
        console.warn('batchUpdate format error:', t);
    }
}

async function resetSheetMarks({ spreadsheetId, sheetName }){
    const token = await getAuthToken(true);
    const sheetId = await getSheetId(spreadsheetId, sheetName);

    // Clear F2:F1000
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName+'!F2:F1000')}:clear`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }
    });

    // Remove row background for rows 2..1000 (A..Z)
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{
            repeatCell: {
                range: { sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 26 },
                cell: { userEnteredFormat: { backgroundColor: null } },
                fields: 'userEnteredFormat.backgroundColor'
            }
        }] })
    });
    if (!res.ok) {
        const t = await res.text().catch(()=> '');
        console.warn('reset formatting error:', t);
    }
}

// --- Progress Communication ---
function sendAutomationProgress(currentTask = null) {
    const state = {
        isRunning: isAutomationRunning,
        current: tasksStarted,
        total: totalTasks,
        currentTask: currentTask,
        found: successCount,
        summary: !isAutomationRunning ? { success: successCount, failure: failureCount, total: totalTasks } : null
    };
    
    // Send to popup
    chrome.runtime.sendMessage({ action: "automationProgress", data: state });
    
    // Persist state so popup can restore it (do not auto-clear; user clears via Clear Data)
    chrome.storage.local.set({ automationState: state });
}
