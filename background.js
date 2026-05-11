// Background script for Pochtoy Parser - v7.5.0 (Fix: multi-product deduplication, eBay error handling)

// --- Daily Auto-Parse at 23:00 ---
const DAILY_PARSE_HOUR = 23; // 23:00 local time
const DAILY_PARSE_MINUTE = 0;
const DAILY_ALARM_NAME = 'dailyAutoParse';
const DAILY_ALARM_PERIOD_MINUTES = 24 * 60;
const DAILY_ALARM_DRIFT_TOLERANCE_MS = 2 * 60 * 1000;
const DAILY_MISSED_RUN_CATCHUP_MS = 2 * 60 * 60 * 1000;
const DAILY_DIAGNOSTICS_KEY = 'dailyAutoParseDiagnostics';
const DAILY_DIAGNOSTICS_LIMIT = 80;
let dailyDiagnosticWriteQueue = Promise.resolve();

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
    const next = new Date();
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

    chrome.alarms.create(DAILY_ALARM_NAME, {
        delayInMinutes: minutesUntilNext,
        periodInMinutes: DAILY_ALARM_PERIOD_MINUTES
    });

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

    if (!existing || driftMs > DAILY_ALARM_DRIFT_TOLERANCE_MS || existing.periodInMinutes !== DAILY_ALARM_PERIOD_MINUTES) {
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
    console.log(`⏰ Daily auto-parse started (${source})`);
    await addDailyDiagnostic('run-start', { source });

    await chrome.storage.local.set({
        lastDailyAutoParseTriggeredAt: Date.now(),
        lastDailyAutoParseSource: source,
        lastDailyAutoParseStatus: 'started'
    });

    sendTelegramMessage('⏰ Автоматический ночной парсинг запущен (23:00)...');

    // Reset states and start parsing.
    cachedProgressState = {};
    await chrome.storage.local.set({ progressState: cachedProgressState, stopAllParsers: false });
    await clearParsingLogs();

    // Sequential pipeline avoids active-tab races between shop flows.
    startSequentialPipeline();
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
    .then(() => runMissedDailyAutoParseIfNeeded('service-worker-start'))
    .catch(error => console.warn('⚠️ Daily alarm init failed:', error?.message || error));

chrome.runtime.onInstalled.addListener(() => {
    ensureDailyAlarm('runtime.onInstalled').catch(error => console.warn('⚠️ Daily alarm install init failed:', error?.message || error));
});

chrome.runtime.onStartup.addListener(() => {
    ensureDailyAlarm('runtime.onStartup')
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
  iherb: [
    { email: 'photopochtoy@gmail.com', password: 'jSt0ldU%W55!', isPrimary: true  },
    { email: 'pochtoy@gmail.com',      password: '1Svetakurz@',  isPrimary: false }
  ],
  amazon: [
    { email: 'ipochtoy@gmail.com',     isPrimary: true  },
    { email: 'photopochtoy@gmail.com', isPrimary: false }
  ],
  ebay: [
    { email: 'ipochtoy@gmail.com',     isPrimary: true }
  ]
};

async function loadAccountsConfig() {
  const r = await chrome.storage.local.get(['accountsConfig']);
  return r.accountsConfig || DEFAULT_ACCOUNTS_CONFIG;
}

function getPrimary(list)     { return list.find(a => a.isPrimary) || list[0]; }
function getSecondaries(list) { return list.filter(a => !a.isPrimary); }

// --- Multi-Account Amazon Parsing ---
let amazonAccountsQueue = [];
let currentAmazonAccount = null;
let isMultiAccountParsing = false;
const MAX_ACCOUNT_SWITCH_ATTEMPTS = 2;
const ACCOUNT_PARSE_TIMEOUT_MS = 90000;

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
        return;
    }
    logsUploadInProgress = true;
    
    const parsingLogs = await getParsingLogs();
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
    }
}

// --- Telegram Bot State ---
let tgBotToken = '8274480416:AAEIvhNsqzDl-dYHMOpjTJ0b1XyS_0lW88w'; // Default token provided by user
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
chrome.storage.local.get(['progressState', 'tgBotToken', 'tgChatId', 'tgPhotoChatId', 'lastUpdateId', 'parsingState'], (result) => {
    if (result.tgPhotoChatId) tgPhotoChatId = result.tgPhotoChatId;
    cachedProgressState = result.progressState || {};

    // RESTORE PARSING STATE (critical for Service Worker that goes inactive!)
    if (result.parsingState) {
        isParsingAllStores = result.parsingState.isParsingAllStores || false;
        storesCompleted = result.parsingState.storesCompleted || { ebay: false, iherb: false, amazon: false };
        console.log('🔄 Restored parsing state:', { isParsingAllStores, storesCompleted });
    }

    // Prefer saved token if exists and not empty, otherwise use default
    if (result.tgBotToken && result.tgBotToken.length > 10) {
        tgBotToken = result.tgBotToken;
    } else {
        // Ensure default is saved if nothing was there
        chrome.storage.local.set({ tgBotToken });
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

    reconcileStalePipelineState().catch(error => {
        console.warn('⚠️ Failed to reconcile parser pipeline state:', error?.message || error);
    });
});

async function clearPipelineRuntimeState(reason) {
    console.warn(`🧹 Clearing stale parser pipeline state: ${reason}`);

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
        'amazonFinalReturn',
        'amazonParsingComplete',
        'accountSwitchStartedAt',
        'accountSwitchFailures',
        'lastAmazonProgressAt',
        'skipGuardAt',
        'pendingAccountSwitch',
        'pendingIherbSwitch',
        'iherbSwitchInProgress',
        'iherbSwitchFailures',
        'iherbFinalReturn',
        'iherbOrdersReloadDone',
        'iherbParserTabId',
        'iherbParseStartedAt',
        'iherbWatchdogRetried'
    ]);

    await chrome.storage.local.set({
        progressState: cachedProgressState,
        parsingState: {
            isParsingAllStores,
            storesCompleted
        }
    });
}

async function reconcileStalePipelineState() {
    const state = await chrome.storage.local.get([
        'pipelineStage',
        'progressState',
        'iherbParseStartedAt',
        'lastAmazonProgressAt',
        'accountSwitchStartedAt'
    ]);
    const pipeline = state.pipelineStage;
    if (!pipeline?.active) return;

    const currentStage = pipeline.stages?.[pipeline.currentIndex];
    if (!currentStage || currentStage === 'done') return;

    const stageTimestamp = Math.max(
        pipeline.startedAt || 0,
        state.progressState?.[currentStage]?.timestamp || 0,
        currentStage === 'iherb' ? (state.iherbParseStartedAt || 0) : 0,
        currentStage === 'amazon'
            ? Math.max(state.lastAmazonProgressAt || 0, state.accountSwitchStartedAt || 0)
            : 0
    );
    const stageAgeMs = stageTimestamp ? (Date.now() - stageTimestamp) : Number.POSITIVE_INFINITY;
    if (stageAgeMs < PIPELINE_STALE_TIMEOUT_MS) return;

    let shouldClear = false;
    if (currentStage === 'iherb') {
        const iherbTabs = await chrome.tabs.query({ url: 'https://*.iherb.com/*' });
        shouldClear = iherbTabs.length === 0 || !state.iherbParseStartedAt;
    } else if (currentStage === 'ebay') {
        const ebayTabs = await chrome.tabs.query({ url: 'https://www.ebay.com/mye/myebay/purchase*' });
        shouldClear = ebayTabs.length === 0;
    } else if (currentStage === 'amazon') {
        const amazonTabs = await chrome.tabs.query({ url: 'https://www.amazon.com/*' });
        shouldClear = amazonTabs.length === 0 || !(state.lastAmazonProgressAt || state.accountSwitchStartedAt);
    }

    if (!shouldClear) return;

    const ageMinutes = Math.round(stageAgeMs / 60000);
    await clearPipelineRuntimeState(`${currentStage} stage stale for ${ageMinutes} min without live runtime`);
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

async function handleProgressMessage(request) {
    // Persist progress to storage so popup can restore it when reopened
    const storeKey = request.store.toLowerCase();
    console.log(`📊 [BACKGROUND] Progress from ${request.store}:`, request.current, '/', request.total, request.status);

    // Watchdog uses lastAmazonProgressAt to detect "content-amazon silent" case.
    // Without this ping, a 20-page account gets killed after 90s because watchdog
    // compares now() to accountSwitchStartedAt. Progress-based idle check fixes it.
    if (storeKey === 'amazon') {
        chrome.storage.local.set({ lastAmazonProgressAt: Date.now() });
    }

    // Restore multi-account state from storage FIRST (Service Worker may have restarted)
    const stored = await new Promise(resolve => chrome.storage.local.get(['multiAccountState', 'multiAccountIherbState'], resolve));
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

    // Update completion status
    const isCompleted = request.status === 'Done ✅' || request.status === 'Error';
    const shouldHandleCompletion = isCompleted && (isParsingAllStores || (storeKey === 'amazon' && isMultiAccountParsing) || (storeKey === 'iherb' && isMultiAccountIherb));
    const shouldNotifyTelegram = isCompleted && !shouldHandleCompletion;
    
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
            if (storeKey === 'amazon' && isMultiAccountParsing && amazonAccountsQueue.length > 0) {
                console.log('[handleProgress] Amazon multi-account: deferring to watchdog for screenshots + switch');
                return;
            }

            // Multi-account iHerb: process screenshots, then switch to next account.
            if (storeKey === 'iherb' && isMultiAccountIherb && iherbAccountsQueue.length > 0) {
                console.log('[handleProgress] iHerb multi-account: processing screenshots, then switching');
                parseReport.stores[`iherb_${(currentIherbAccount || '').split('@')[0]}`] = { found: count, status: emoji };
                // Watchdog: cs дошёл до конца — снимаем marker
                chrome.storage.local.remove(['iherbParseStartedAt', 'iherbWatchdogRetried']);
                if (screenshotsEnabled && trackScreenshotQueue.length > 0) {
                    processScreenshotQueue().finally(() => switchToNextIherbAccount());
                } else {
                    switchToNextIherbAccount();
                }
                return;
            }
            // Multi-account iHerb: последний аккаунт обработан — финальный возврат
            if (storeKey === 'iherb' && isMultiAccountIherb) {
                console.log('[handleProgress] iHerb multi-account: last account done, final return');
                parseReport.stores[`iherb_${(currentIherbAccount || '').split('@')[0]}`] = { found: count, status: emoji };
                isMultiAccountIherb = false;
                currentIherbAccount = null;
                chrome.storage.local.remove(['iherbParseStartedAt', 'iherbWatchdogRetried']);
                if (screenshotsEnabled && trackScreenshotQueue.length > 0) {
                    processScreenshotQueue().finally(() => finalReturnToIherbPrimary());
                } else {
                    finalReturnToIherbPrimary();
                }
                setParserLock('iherb', false);
                storesCompleted.iherb = true;
                setTimeout(() => uploadToSheets(), 1500);
                checkAllStoresCompleted();
                return;
            }

            storesCompleted[storeKey] = true;
            setParserLock(storeKey, false);

            if (storeKey === 'amazon' && currentAmazonAccount) {
                parseReport.stores[`amazon_${currentAmazonAccount.split('@')[0]}`] = { found: count, status: emoji };
                isMultiAccountParsing = false;
                currentAmazonAccount = null;
            } else {
                parseReport.stores[storeKey] = { found: count, status: emoji };
            }

            // Upload this store's data to Sheets immediately (dedupe handles duplicates)
            setTimeout(() => uploadToSheets(), 1500);

            // Pipeline advance: if sequential pipeline is active and we just finished eBay,
            // jump ebay → amazon_primary. iHerb and Amazon advance from their own final-return
            // functions (with a 45s delay for picker/re-login to settle).
            if (storeKey === 'ebay') {
                chrome.storage.local.get(['pipelineStage']).then(r => {
                    const p = r.pipelineStage;
                    if (p && p.active && p.stages[p.currentIndex] === 'ebay') {
                        advancePipelineStage().catch(() => {});
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
            setTimeout(() => uploadToSheets(), 1500);
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

// --- Message Listener ---
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
        // Initialize parsing state
        isParsingAllStores = true;
        storesCompleted = { ebay: false, iherb: false, amazon: false };
        saveParsingState();

        // Reset progress cache
        cachedProgressState = {};
        chrome.storage.local.set({ progressState: cachedProgressState });
        
        // Clear parsing logs for new session
        clearParsingLogs();

        parseReport = { stores: {}, screenshots: { sent: 0, skipped: 0, failed: 0, broken: 0 }, startedAt: Date.now() };
        sendTelegramMessage('🚀 Запущен парсинг всех магазинов...');
        sendResponse({status: "started"});
    } else if (request.action === "startSequentialPipeline") {
        // Sequential pipeline: iHerb → eBay → Amazon, one shop at a time, each
        // draining its multi-account queue internally.
        isParsingAllStores = true;
        storesCompleted = { ebay: false, iherb: false, amazon: false };
        saveParsingState();
        cachedProgressState = {};
        chrome.storage.local.set({ progressState: cachedProgressState });
        clearParsingLogs();
        parseReport = { stores: {}, screenshots: { sent: 0, skipped: 0, failed: 0, broken: 0 }, startedAt: Date.now() };
        startSequentialPipeline();
        sendResponse({ status: 'started' });
        return true;
    } else if (request.action === "getAccountsConfig") {
        loadAccountsConfig().then(cfg => sendResponse({ config: cfg, defaults: DEFAULT_ACCOUNTS_CONFIG }));
        return true;
    } else if (request.action === "saveAccountsConfig") {
        chrome.storage.local.set({ accountsConfig: request.config }).then(() => sendResponse({ ok: true }));
        return true;
    } else if (request.action === "startMultiAccountAmazon") {
        // Multi-account Amazon parsing: photopochtoy + ipochtoy sequentially.
        // Re-enabled 2026-04-14 as part of warehouse-verify archive pipeline.
        console.log('🔄 Multi-account Amazon parsing: launching');
        startMultiAccountAmazonParsing();
        sendResponse({status: "started"});
    } else if (request.action === "accountSwitchFailed") {
        (async () => {
            console.log(`❌ Account switch failed for ${request.email}: ${request.error}`);
            const failData = await chrome.storage.local.get(['accountSwitchFailures']);
            const failures = failData.accountSwitchFailures || {};
            const email = request.email || currentAmazonAccount || 'unknown';
            failures[email] = (failures[email] || 0) + 1;
            await chrome.storage.local.set({ accountSwitchFailures: failures });
            
            if (failures[email] >= MAX_ACCOUNT_SWITCH_ATTEMPTS) {
                console.log(`🚫 Account ${email} failed ${failures[email]} times, skipping`);
                sendTelegramMessage(`🚫 Аккаунт ${email.split('@')[0]} недоступен (попыток: ${failures[email]}), пропускаю`);
                await chrome.storage.local.remove(['accountSwitchStartedAt']);
                switchToNextAmazonAccount();
            } else {
                sendTelegramMessage(`⚠️ Не удалось переключиться на ${email.split('@')[0]} (попытка ${failures[email]}/${MAX_ACCOUNT_SWITCH_ATTEMPTS}), пробую ещё раз...`);
                amazonAccountsQueue.unshift(email);
                await chrome.storage.local.set({
                    multiAccountState: {
                        isMultiAccountParsing: true,
                        amazonAccountsQueue: amazonAccountsQueue,
                        currentAmazonAccount: currentAmazonAccount
                    }
                });
                switchToNextAmazonAccount();
            }
        })();
    } else if (request.action === "iherbSwitchFailed") {
        (async () => {
            const reason = request.reason || 'unknown';
            const email = request.email || 'unknown';
            console.warn(`❌ iHerb switch failed for ${email}: ${reason}`);
            sendTelegramMessage(`⚠️ iHerb: переключение на ${email.split('@')[0]} не удалось (${reason})`);
            const failData = await chrome.storage.local.get(['iherbSwitchFailures']);
            const failures = failData.iherbSwitchFailures || {};
            failures[email] = (failures[email] || 0) + 1;
            await chrome.storage.local.set({ iherbSwitchFailures: failures });

            const MAX_IH_ATTEMPTS = 2;
            if (failures[email] < MAX_IH_ATTEMPTS && reason !== 'captcha') {
                console.log(`🔁 Retry iHerb switch for ${email} (attempt ${failures[email]+1}/${MAX_IH_ATTEMPTS})`);
                const cfgForRetry = await loadAccountsConfig();
                iherbAccountsQueue.unshift({ email, password: (cfgForRetry.iherb.find(a => a.email === email) || {}).password });
                await chrome.storage.local.set({
                    multiAccountIherbState: {
                        isMultiAccountIherb: true,
                        iherbAccountsQueue,
                        currentIherbAccount
                    }
                });
                await new Promise(r => setTimeout(r, 5000));
                switchToNextIherbAccount();
            } else {
                console.log(`🚫 iHerb account ${email} skipped (failures: ${failures[email]}, reason: ${reason})`);
                sendTelegramMessage(`🚫 iHerb аккаунт ${email.split('@')[0]} пропущен (${reason})`);
                await chrome.storage.local.remove(['iherbSwitchInProgress', 'pendingIherbSwitch']);
                if (iherbAccountsQueue.length > 0) {
                    switchToNextIherbAccount();
                } else {
                    finalReturnToIherbPrimary();
                }
            }
        })();
        return true;
    } else if (request.action === "parsingProgress") {
        // Handle parsingProgress from content scripts (convert to progress format)
        const progressData = request.data || {};
        const progressMsg = {
            action: 'progress',
            store: progressData.store,
            current: progressData.current,
            total: progressData.total,
            status: progressData.status,
            found: progressData.found
        };

        // Process it as progress message
        chrome.runtime.sendMessage(progressMsg, () => {
            // Handle progress internally
            if (progressMsg.action === "progress") {
                handleProgressMessage(progressMsg);
            }
        });
    } else if (request.action === "progress") {
        handleProgressMessage(request);
    } else if (request.action === "multiAccountLog") {
        // Forwarded from content-switch-account.js / content-amazon.js —
        // persistent step-log of Amazon multi-account flow for diagnostics.
        logMultiAccountStep(request.step, request.detail || {});
        sendResponse({status: "logged"});
    } else if (request.action === "queueTrackScreenshot") {
        queueTrackScreenshot(request.orderId, request.trackNumber, request.trackUrl, request.accountName);
        sendResponse({status: "queued"});
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
        const startedAt = Date.now();
        if (request.store === 'iHerb') {
            const update = { iherbParseStartedAt: startedAt, iherbWatchdogRetried: false };
            if (sender.tab?.id) update.iherbParserTabId = sender.tab.id;
            chrome.storage.local.set(update);
        } else if (request.store === 'Amazon') {
            chrome.storage.local.set({ lastAmazonProgressAt: startedAt });
        }
        // Notify Telegram that parser actually started working
        const storeEmoji = {
            'eBay': '🛒',
            'iHerb': '🌿',
            'Amazon': '📦'
        }[request.store] || '🔄';
        console.log(`✅ ${request.store} parser started successfully`);
    } else if (request.action === "parseError") {
        // Handle parsing errors (e.g., Service unavailable after retries)
        const storeKey = request.store?.toLowerCase();
        const errorMsg = request.error || 'Unknown error';

        if (storeKey === 'iherb') {
            chrome.storage.local.remove(['iherbParseStartedAt', 'iherbWatchdogRetried']);
        } else if (storeKey === 'amazon') {
            chrome.storage.local.remove(['lastAmazonProgressAt']);
        }

        console.log(`❌ [BACKGROUND] Parse error from ${request.store}: ${errorMsg}`);
        sendTelegramMessage(`❌ ${request.store}: Ошибка парсинга - ${errorMsg}`);

        // Mark store as completed (with error) so the chain continues
        if (storeKey && storeKey in storesCompleted) {
            storesCompleted[storeKey] = true;
            saveParsingState();

            // Update progress state to show error
            cachedProgressState[storeKey] = {
                current: 0,
                total: 0,
                status: 'Error',
                found: 0
            };
            chrome.storage.local.set({ progressState: cachedProgressState });

            checkAllStoresCompleted();
        }
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

// Switch to next Amazon account for multi-account parsing
async function switchToNextAmazonAccount() {
    // Restore state from storage in case Service Worker restarted
    const stored = await chrome.storage.local.get(['multiAccountState']);
    if (stored.multiAccountState) {
        isMultiAccountParsing = stored.multiAccountState.isMultiAccountParsing;
        amazonAccountsQueue = stored.multiAccountState.amazonAccountsQueue || [];
        currentAmazonAccount = stored.multiAccountState.currentAmazonAccount;
        console.log('🔄 Restored multi-account state:', stored.multiAccountState);
    }
    
    if (amazonAccountsQueue.length === 0) {
        console.log('📋 No more Amazon accounts to parse');
        await logMultiAccountStep('multi-account:complete', {});
        isMultiAccountParsing = false;
        currentAmazonAccount = null;

        // Clear state
        await chrome.storage.local.remove(['multiAccountState', 'lastAmazonProgressAt', 'accountSwitchStartedAt', 'skipGuardAt']);

        // Build per-account Telegram summary from parseReport.stores
        try {
            const amazonEntries = Object.entries(parseReport.stores || {})
                .filter(([k]) => k.startsWith('amazon_'));
            let summary;
            if (amazonEntries.length === 0) {
                summary = '✅ Amazon мульти-прогон завершён:\n  (ни один аккаунт не дал результата)';
            } else {
                const lines = amazonEntries.map(([k, v]) => {
                    const name = k.replace('amazon_', '');
                    return `  ${v.status || '•'} ${name}: ${v.found ?? 0}`;
                });
                summary = `✅ Amazon мульти-прогон завершён:\n${lines.join('\n')}`;
            }
            sendTelegramMessage(summary).catch(e => console.warn('summary tg failed:', e?.message || e));
        } catch (e) {
            console.warn('amazon summary build failed:', e?.message || e);
        }

        // Финальный возврат на основной аккаунт (ipochtoy) — без парсинга
        finalReturnToPrimaryAmazon().catch(e => console.warn('finalReturn failed:', e));

        setParserLock('amazon', false);

        storesCompleted.amazon = true;
        checkAllStoresCompleted();
        return;
    }
    
    const nextEmail = amazonAccountsQueue.shift();
    currentAmazonAccount = nextEmail;

    console.log(`🔄 Switching to Amazon account: ${nextEmail}`);
    console.log(`🔄 Switching to account: ${nextEmail.split('@')[0]}`);
    await logMultiAccountStep('switchToNextAmazonAccount:start', { account: nextEmail });

    // Save pending switch and updated state, clear completion flag and old pagination
    await chrome.storage.local.set({
        pendingAccountSwitch: { email: nextEmail },
        amazonParsingComplete: null,
        amazonPaginationState: null,
        accountSwitchStartedAt: Date.now(),
        lastAmazonProgressAt: Date.now(),
        multiAccountState: {
            isMultiAccountParsing: true,
            amazonAccountsQueue: amazonAccountsQueue,
            currentAmazonAccount: nextEmail
        }
    });

    // Find active tab or create new one
    const tabs = await chrome.tabs.query({ url: 'https://www.amazon.com/*' });

    const switchUrl = 'https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com%2F%3Fref_%3Dnav_youraccount_switchacct&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&marketPlaceId=ATVPDKIKX0DER&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&switch_account=picker&ignoreAuthState=1&_encoding=UTF8';

    if (tabs.length > 0) {
        // Navigate existing Amazon tab to switch-account page
        await logMultiAccountStep('switchToNextAmazonAccount:redirect', { account: nextEmail, tabId: tabs[0].id, url: switchUrl.slice(0, 80) });
        await chrome.tabs.update(tabs[0].id, {
            url: switchUrl,
            active: true
        });
    } else {
        // Create new tab
        await logMultiAccountStep('switchToNextAmazonAccount:new-tab', { account: nextEmail, url: switchUrl.slice(0, 80) });
        await chrome.tabs.create({
            url: switchUrl
        });
    }
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

async function startSequentialPipeline() {
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
    'iherbSwitchFailures',
    'iherbOrdersReloadDone',
    'pendingIherbSwitch',
    'multiAccountIherbState',
    'pendingAccountSwitch',
    'amazonFinalReturn',
    'accountSwitchFailures',
    'amazonPaginationState'
  ]);
  await chrome.storage.local.set({
    pipelineStage: { active: true, stages: PIPELINE_STAGES, currentIndex: 0, startedAt: Date.now() }
  });
  sendTelegramMessage('🚀 Sequential pipeline started: iHerb → eBay → Amazon').catch(() => {});
  await runPipelineStage('iherb');
}

async function runPipelineStage(stageName) {
  console.log(`🎬 runPipelineStage: ${stageName}`);
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
    isParsingAllStores = false;
    await chrome.storage.local.set({
      pipelineStage: { active: false, stages: PIPELINE_STAGES, currentIndex: PIPELINE_STAGES.length - 1, startedAt: null }
    });
    sendTelegramMessage('✅ Sequential pipeline done').catch(() => {});
    return;
  }
}

// Blocks until the screenshot queue is fully drained AND processing is idle.
// processScreenshotQueue() has an `isProcessingScreenshots` re-entry guard —
// a bare `await processScreenshotQueue()` returns immediately if another caller
// is already draining, which would let the next stage start too early. This
// helper polls until both flags are clear, kicking off a drain itself if the
// queue has items but nobody is running.
async function waitForScreenshotsDrained(maxWaitMs = 10 * 60 * 1000) {
  if (!screenshotsEnabled) return;
  const start = Date.now();
  while (trackScreenshotQueue.length > 0 || isProcessingScreenshots) {
    if (Date.now() - start > maxWaitMs) {
      console.warn('⏰ waitForScreenshotsDrained: timed out, advancing anyway');
      return;
    }
    if (!isProcessingScreenshots && trackScreenshotQueue.length > 0) {
      processScreenshotQueue().catch(() => {});
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function advancePipelineStage() {
  const r = await chrome.storage.local.get(['pipelineStage']);
  const p = r.pipelineStage;
  if (!p || !p.active) return;

  // DRAIN screenshot queue BEFORE starting next stage.
  // chrome.tabs.captureVisibleTab(windowId) captures whatever tab is currently active
  // in that window. If Amazon's switch_account navigation flips its tab to active
  // while eBay screenshots are still queued, captureVisibleTab photographs the
  // Switch-Accounts page instead of the order page (confirmed in Telegram log:
  // Amazon switch page was sent as an eBay "screenshot"). Draining here guarantees
  // the previous stage's screenshots finish before any new tab steals focus.
  if (screenshotsEnabled && (trackScreenshotQueue.length > 0 || isProcessingScreenshots)) {
    console.log(`⏸  Pipeline: waiting for screenshot queue to drain (${trackScreenshotQueue.length} queued, processing=${isProcessingScreenshots})`);
    await waitForScreenshotsDrained();
    console.log('▶  Pipeline: screenshot queue drained, advancing');
  }

  const nextIndex = p.currentIndex + 1;
  if (nextIndex >= p.stages.length) {
    await chrome.storage.local.set({ pipelineStage: { ...p, active: false, currentIndex: p.stages.length - 1 } });
    return;
  }
  const nextStage = p.stages[nextIndex];
  await chrome.storage.local.set({ pipelineStage: { ...p, currentIndex: nextIndex } });
  await runPipelineStage(nextStage);
}

async function startEbayStageForPipeline() {
  // content-ebay.js checkAutoParse требует autoParsePending='ebay' + свежий
  // autoParseTimestamp (<120s). Без этого он молча скипнет парсинг.
  await chrome.storage.local.set({
    autoParsePending: 'ebay',
    autoParseTimestamp: Date.now(),
    ebay_should_autoparse: true
  });
  const url = 'https://www.ebay.com/mye/myebay/purchase';
  const tabs = await chrome.tabs.query({ url: 'https://www.ebay.com/mye/myebay/purchase*' });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { url, active: true });
  } else {
    await chrome.tabs.create({ url });
  }
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
            currentIherbAccount: null
        },
        iherbFinalReturn: null,
        pendingIherbSwitch: null
    });
    await chrome.storage.local.remove([
        'pendingIherbSwitch',
        'iherbFinalReturn',
        'iherbSwitchInProgress',
        'iherbOrdersReloadDone'
    ]);

    setParserLock('iherb', true);
    sendTelegramMessage(`🌿 iHerb мульти-аккаунт: ${cfg.iherb.map(a => a.email.split('@')[0]).join(', ')}`).catch(() => {});

    // Находим существующий iherb-таб или создаём один. НЕ закрываем чужие табы.
    const tabId = await ensureIherbParserTab();
    await chrome.storage.local.set({ iherbParserTabId: tabId });

    switchToNextIherbAccount();
}

async function switchToNextIherbAccount() {
    // Restore state (SW restart)
    const stored = await chrome.storage.local.get(['multiAccountIherbState', 'iherbParserTabId']);
    if (stored.multiAccountIherbState) {
        isMultiAccountIherb = stored.multiAccountIherbState.isMultiAccountIherb;
        iherbAccountsQueue  = stored.multiAccountIherbState.iherbAccountsQueue || [];
        currentIherbAccount = stored.multiAccountIherbState.currentIherbAccount;
    }

    if (iherbAccountsQueue.length === 0) {
        console.log('📋 No more iHerb accounts — final return');
        return finalReturnToIherbPrimary();
    }

    const next = iherbAccountsQueue.shift();
    currentIherbAccount = next.email;

    console.log(`🔄 Switching to iHerb account: ${next.email}`);
    sendTelegramMessage(`🔄 iHerb: переключение на ${next.email.split('@')[0]}`).catch(() => {});

    await chrome.storage.local.set({
        pendingIherbSwitch: { email: next.email, password: next.password },
        iherbSwitchInProgress: true,
        iherbFinalReturn: null,
        multiAccountIherbState: {
            isMultiAccountIherb: true,
            iherbAccountsQueue,
            currentIherbAccount: next.email
        }
    });

    const tabId = await ensureValidIherbParserTab(stored.iherbParserTabId);
    await chrome.storage.local.set({ iherbParserTabId: tabId });

    // Fast path ТОЛЬКО для первого аккаунта в очереди (primary): если оператор
    // уже залогинен на iHerb, пропускаем dropdown-dance и сразу идём на /orders.
    // multiAccountIherbState.currentIherbAccount уже выставлен в next.email, так
    // что content-iherb.js размтит все позиции на правильный account_name.
    // Для secondary-аккаунта (pochtoy) мы ВСЕГДА обязаны делать sign-out dance,
    // потому что оператор сейчас залогинен как primary, не как secondary.
    const cfg = await loadAccountsConfig();
    const primary = getPrimary(cfg.iherb);
    const isPrimaryAttempt = next.email === primary.email;
    const alreadyLoggedIn = isPrimaryAttempt && await iherbIsLoggedIn(tabId);
    if (alreadyLoggedIn) {
        console.log(`✅ Already logged in — skipping sign-out dance, parsing as ${next.email}`);
        sendTelegramMessage(`✅ iHerb уже залогинен — парсим ${next.email.split('@')[0]} напрямую`).catch(() => {});
        await chrome.storage.local.remove(['pendingIherbSwitch']);
        // iherbSwitchInProgress=true уже выставлен выше — content-iherb.js auto-parse.
        // iherb watchdog: marker для проверки залипания cs (Extension context invalidated и т.п.)
        await chrome.storage.local.set({ iherbParseStartedAt: Date.now(), iherbWatchdogRetried: false });
        await chrome.tabs.update(tabId, { url: 'https://secure.iherb.com/myaccount/orders', active: true });
        return;
    }

    try {
        await iherbUiSignOutAndNavigateToLogin(tabId);
        // После этого content-iherb-login.js на checkout.iherb.com/auth/ui/account/login
        // прочитает pendingIherbSwitch и залогинит нужный аккаунт.
    } catch (e) {
        console.error('❌ iHerb UI sign-out flow failed:', e);
        sendTelegramMessage(`⚠️ iHerb UI sign-out упал для ${next.email.split('@')[0]}: ${e.message || e}`).catch(() => {});
        await handleIherbSwitchFailure(next.email, 'ui_signout_failed');
    }
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
async function handleIherbSwitchFailure(email, reason) {
    const failData = await chrome.storage.local.get(['iherbSwitchFailures']);
    const failures = failData.iherbSwitchFailures || {};
    failures[email] = (failures[email] || 0) + 1;
    await chrome.storage.local.set({ iherbSwitchFailures: failures });

    const MAX_IH_ATTEMPTS = 2;
    if (failures[email] < MAX_IH_ATTEMPTS && reason !== 'captcha') {
        console.log(`🔁 Retry iHerb switch for ${email} (attempt ${failures[email] + 1}/${MAX_IH_ATTEMPTS})`);
        const cfg = await loadAccountsConfig();
        const creds = cfg.iherb.find(a => a.email === email);
        if (creds) iherbAccountsQueue.unshift(creds);
        await chrome.storage.local.set({
            multiAccountIherbState: {
                isMultiAccountIherb: true,
                iherbAccountsQueue,
                currentIherbAccount
            }
        });
        await new Promise(r => setTimeout(r, 5000));
        switchToNextIherbAccount();
    } else {
        console.log(`🚫 iHerb ${email} skipped (failures=${failures[email]}, reason=${reason})`);
        sendTelegramMessage(`🚫 iHerb ${email.split('@')[0]} пропущен (${reason})`).catch(() => {});
        await chrome.storage.local.remove(['iherbSwitchInProgress', 'pendingIherbSwitch']);
        if (iherbAccountsQueue.length > 0) switchToNextIherbAccount();
        else finalReturnToIherbPrimary();
    }
}

async function finalReturnToIherbPrimary() {
    const cfg = await loadAccountsConfig();
    const primary = getPrimary(cfg.iherb);
    console.log(`🏁 iHerb final return to ${primary.email}`);
    sendTelegramMessage(`🏁 Возврат на основной iHerb-аккаунт: ${primary.email.split('@')[0]}`).catch(() => {});

    const stored = await chrome.storage.local.get(['iherbParserTabId', 'multiAccountIherbState']);
    const lastKnownAccount = currentIherbAccount || stored.multiAccountIherbState?.currentIherbAccount || null;

    await chrome.storage.local.set({
        pendingIherbSwitch: { email: primary.email, password: primary.password },
        iherbFinalReturn: true,
        multiAccountIherbState: null
    });
    await chrome.storage.local.remove(['iherbSwitchInProgress']);

    const tabId = await ensureValidIherbParserTab(stored.iherbParserTabId);
    await chrome.storage.local.set({ iherbParserTabId: tabId });

    // iherbIsLoggedIn() only proves "some account is logged in"; it cannot
    // identify which email. Skip re-login only when our own state says the last
    // parsed account was already primary.
    const alreadyOnPrimary = lastKnownAccount === primary.email && await iherbIsLoggedIn(tabId);
    if (alreadyOnPrimary) {
        console.log(`✅ Already on primary ${primary.email} — final return no-op`);
        sendTelegramMessage(`✅ iHerb уже на ${primary.email.split('@')[0]} — возврат не нужен`).catch(() => {});
        await chrome.storage.local.remove(['pendingIherbSwitch', 'iherbFinalReturn', 'iherbSwitchInProgress']);
        await chrome.tabs.update(tabId, { url: 'https://www.iherb.com/', active: false });
        // Advance faster — нет 45s login wait.
        setTimeout(() => advancePipelineStage().catch(() => {}), 3000);
        return;
    }

    try {
        await iherbUiSignOutAndNavigateToLogin(tabId);
    } catch (e) {
        console.error('❌ iHerb final return failed:', e);
        sendTelegramMessage(`⚠️ iHerb final return упал: ${e.message || e}`).catch(() => {});
    }

    // Pipeline advance: after ~45s (sign-out + login + orders page load) jump
    // from iherb_return → ebay (if pipeline active).
    setTimeout(() => advancePipelineStage().catch(() => {}), 45000);
}

// ─── Shared: ensure we have exactly one iHerb parser tab ───────────────────
async function ensureIherbParserTab() {
    // Prefer existing tab (we don't close anyone else's work).
    const tabs = await chrome.tabs.query({ url: 'https://*.iherb.com/*' });
    if (tabs.length > 0) return tabs[0].id;
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
async function finalReturnToPrimaryAmazon() {
    const cfg = await loadAccountsConfig();
    const primary = getPrimary(cfg.amazon);
    console.log(`🏁 Amazon final return to ${primary.email}`);
    sendTelegramMessage(`🏁 Amazon: возврат на ${primary.email.split('@')[0]}`).catch(() => {});

    await chrome.storage.local.set({
        pendingAccountSwitch: { email: primary.email },
        amazonFinalReturn: true,
        accountSwitchStartedAt: Date.now(),
        amazonParsingComplete: null
    });
    await chrome.storage.local.remove(['amazonPaginationState']);

    const switchUrl = 'https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com%2F%3Fref_%3Dnav_youraccount_switchacct&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&marketPlaceId=ATVPDKIKX0DER&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&switch_account=picker&ignoreAuthState=1&_encoding=UTF8';

    const tabs = await chrome.tabs.query({ url: 'https://www.amazon.com/*' });
    if (tabs.length > 0) await chrome.tabs.update(tabs[0].id, { url: switchUrl, active: true });
    else await chrome.tabs.create({ url: switchUrl });

    // Pipeline advance: after ~45s give picker → landing page time to finish.
    setTimeout(() => advancePipelineStage().catch(() => {}), 45000);
}

// Initialize multi-account Amazon parsing
async function startMultiAccountAmazonParsing() {
    console.log('🚀 startMultiAccountAmazonParsing called');

    // STEP 1: Close ALL existing Amazon tabs to avoid race conditions
    const existingTabs = await chrome.tabs.query({ url: 'https://www.amazon.com/*' });
    if (existingTabs.length > 0) {
        console.log(`🧹 Closing ${existingTabs.length} existing Amazon tabs...`);
        for (const tab of existingTabs) {
            try {
                await chrome.tabs.remove(tab.id);
            } catch (e) {
                console.log('Tab already closed:', e);
            }
        }
        // Small delay to ensure tabs are closed
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    const cfg = await loadAccountsConfig();
    amazonAccountsQueue = cfg.amazon.map(a => a.email);
    isMultiAccountParsing = true;
    currentAmazonAccount = null;

    // STEP 2: Clear ALL related flags BEFORE proceeding (with await!)
    await new Promise(resolve => {
        chrome.storage.local.set({
            stopAllParsers: false,
            amazonParsingComplete: null,
            amazonPaginationState: null,
            accountSwitchStartedAt: null,
            accountSwitchFailures: {},
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
    switchToNextAmazonAccount();
}

// Watchdog using chrome.alarms (reliable even when Service Worker sleeps)
const WATCHDOG_ALARM_NAME = 'amazonCompletionWatchdog';
const SCREENSHOT_RESUME_ALARM = 'screenshotResume';
chrome.alarms.create(SCREENSHOT_RESUME_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });

// iHerb cs watchdog: проверяет каждую минуту что content-iherb.js не залип
// (Extension context invalidated, infinite scroll стал, network 429 etc.).
// Если cs не отвечает >IHERB_PARSE_TIMEOUT_MS — retry tab.update (one shot), потом fail.
const IHERB_WATCHDOG_ALARM = 'iherbParseWatchdog';
const IHERB_PARSE_TIMEOUT_MS = 240_000; // 4 min hard cap
chrome.alarms.create(IHERB_WATCHDOG_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });

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
async function handleIherbWatchdog() {
    const stored = await chrome.storage.local.get([
        'iherbParseStartedAt', 'iherbWatchdogRetried',
        'multiAccountIherbState', 'iherbParserTabId', 'pipelineStage'
    ]);
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

    if (!stored.iherbWatchdogRetried) {
        // First retry: reload tab → cs снова auto-parse'нет.
        await chrome.storage.local.set({ iherbWatchdogRetried: true, iherbParseStartedAt: Date.now() });
        sendTelegramMessage(`⚠️ iHerb (${acc.split('@')[0]}) залип ${Math.round(elapsed/1000)}с, retry...`).catch(()=>{});
        if (tabId) {
            try {
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
    await chrome.storage.local.remove(['iherbParseStartedAt', 'iherbWatchdogRetried']);

    // Restore in-memory state if SW restarted between alarm ticks
    if (stored.multiAccountIherbState) {
        isMultiAccountIherb = stored.multiAccountIherbState.isMultiAccountIherb;
        iherbAccountsQueue = stored.multiAccountIherbState.iherbAccountsQueue || [];
        currentIherbAccount = stored.multiAccountIherbState.currentIherbAccount;
    }
    if (isMultiAccountIherb && iherbAccountsQueue.length > 0) {
        switchToNextIherbAccount();
    } else {
        // Закрываем iherb stage чтобы pipeline двигался дальше
        isMultiAccountIherb = false;
        currentIherbAccount = null;
        if (typeof storesCompleted === 'object') storesCompleted.iherb = true;
        setParserLock('iherb', false);
        await finalReturnToIherbPrimary().catch(e => console.warn('finalReturn failed:', e?.message || e));
        if (typeof checkAllStoresCompleted === 'function') checkAllStoresCompleted();
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

    if (alarm.name !== WATCHDOG_ALARM_NAME) return;

    const stored = await chrome.storage.local.get(['amazonParsingComplete', 'multiAccountState', 'accountSwitchStartedAt', 'lastAmazonProgressAt', 'skipGuardAt']);

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

    // TIMEOUT: progress-based (idle) + hard cap.
    // Old logic killed after 90s from switch-start — fatally short for accounts with
    // 20 pages (needs 5-7 min). New logic: kill if no parsing progress for 90s, or
    // if total time exceeds 20-minute hard cap (bumped from 10min after 2026-04-22
    // observation: ipochtoy finished 19 pages + started page 20 at exactly 600s).
    if (!stored.amazonParsingComplete && stored.accountSwitchStartedAt && stored.multiAccountState) {
        const now = Date.now();
        const totalElapsed = now - stored.accountSwitchStartedAt;
        const sinceLastProgress = now - (stored.lastAmazonProgressAt || stored.accountSwitchStartedAt);
        const HARD_CAP_MS = 1_200_000; // 20 min absolute
        const isIdleTimeout = sinceLastProgress > ACCOUNT_PARSE_TIMEOUT_MS;
        const isHardCap = totalElapsed > HARD_CAP_MS;
        if (isIdleTimeout || isHardCap) {
            // Set skip-guard IMMEDIATELY before any long awaits — this is the mutex
            // that prevents concurrent alarm handlers from firing duplicate timeouts.
            await chrome.storage.local.set({ skipGuardAt: Date.now() });

            const failedEmail = stored.multiAccountState.currentAmazonAccount || 'unknown';
            const reason = isHardCap ? 'hard-cap 20min' : 'no progress';
            const idleSec = Math.round(sinceLastProgress / 1000);
            const totalSec = Math.round(totalElapsed / 1000);
            console.log(`🚫 Account ${failedEmail} timed out (${reason}, idle=${idleSec}s, total=${totalSec}s), skipping`);
            sendTelegramMessage(`🚫 Аккаунт ${failedEmail.split('@')[0]}: ${reason}, idle=${idleSec}с, total=${totalSec}с — пропускаю`);

            // Screenshot the Amazon tab before skipping — shows what actually was on the
            // page: picker, order-history, CAPTCHA, 2FA, device verification, empty.
            // Critical for diagnosing the "photopochtoy silence" pattern.
            try {
                const amzTabs = await chrome.tabs.query({ url: '*://*.amazon.com/*' });
                if (amzTabs[0]) {
                    const dataUrl = await chrome.tabs.captureVisibleTab(amzTabs[0].windowId, { format: 'png' });
                    const b64 = (dataUrl || '').replace(/^data:image\/png;base64,/, '');
                    if (b64) await sendTelegramPhoto(b64, `🚫 Amazon timeout: ${failedEmail.split('@')[0]}\n${reason}, idle=${idleSec}s total=${totalSec}s`);
                }
            } catch (e) { console.warn('timeout-screenshot failed:', e?.message || e); }

            await logMultiAccountStep('account-parse:timeout', { account: failedEmail, reason, idleSec, totalSec });

            // Populate partial parseReport.stores so final Telegram summary shows
            // partial progress instead of silently reporting zero (observed 2026-04-22:
            // ipochtoy parsed 19 pages but summary showed "(ни один аккаунт не дал
            // результата)" because only the completion-flag path writes parseReport).
            // Read last known count from cachedProgressState['amazon'].found which
            // content-amazon.js updates on every page.
            try {
                const accountName = failedEmail.split('@')[0];
                const partialFound = (cachedProgressState.amazon && cachedProgressState.amazon.found) || 0;
                parseReport.stores[`amazon_${accountName}`] = {
                    found: partialFound,
                    status: isHardCap ? '⏱' : '🚫'
                };
            } catch (e) { console.warn('partial parseReport failed:', e?.message || e); }

            // Restore state
            isMultiAccountParsing = stored.multiAccountState.isMultiAccountParsing;
            amazonAccountsQueue = stored.multiAccountState.amazonAccountsQueue || [];
            currentAmazonAccount = stored.multiAccountState.currentAmazonAccount;

            await chrome.storage.local.remove(['accountSwitchStartedAt', 'lastAmazonProgressAt', 'amazonParsingComplete', 'amazonPaginationState']);
            await switchToNextAmazonAccount();
            return;
        }
    }
    
    if (stored.amazonParsingComplete && stored.amazonParsingComplete.timestamp) {
        const age = Date.now() - stored.amazonParsingComplete.timestamp;
        // Only process if flag is fresh (less than 60 seconds old)
        if (age < 60000) {
            console.log('👀 Watchdog detected completion flag!', stored.amazonParsingComplete);
            
            // Restore multi-account state
            if (stored.multiAccountState) {
                isMultiAccountParsing = stored.multiAccountState.isMultiAccountParsing;
                amazonAccountsQueue = stored.multiAccountState.amazonAccountsQueue || [];
                currentAmazonAccount = stored.multiAccountState.currentAmazonAccount;
            }
            
            // Clear the flag so we don't process again
            await chrome.storage.local.set({ amazonParsingComplete: null, accountSwitchStartedAt: null });
            
            const count = stored.amazonParsingComplete.found || 0;
            const accountName = currentAmazonAccount ? currentAmazonAccount.split('@')[0] : 'current';
            parseReport.stores[`amazon_${accountName}`] = { found: count, status: '✅' };
            
            // Process screenshots for THIS account before moving on
            if (screenshotsEnabled && trackScreenshotQueue.length > 0) {
                await processScreenshotQueue();
            }
            
            if (isMultiAccountParsing && amazonAccountsQueue.length > 0) {
                await switchToNextAmazonAccount();
            } else if (isMultiAccountParsing) {
                isMultiAccountParsing = false;
                currentAmazonAccount = null;
                await chrome.storage.local.remove(['multiAccountState']);

                // Финальный возврат на основной аккаунт (ipochtoy) — без парсинга
                finalReturnToPrimaryAmazon().catch(e => console.warn('finalReturn failed:', e));

                setParserLock('amazon', false);

                storesCompleted.amazon = true;
                stopCompletionWatchdog();
                checkAllStoresCompleted();
            }
        }
    }
});

// Check if all stores completed and trigger auto-upload
async function checkAllStoresCompleted() {
    if (storesCompleted.ebay && storesCompleted.iherb && storesCompleted.amazon) {
        isParsingAllStores = false;
        saveParsingState(); // Save final state

        console.log('🚀 All stores parsed! Starting uploads + screenshots...');
        
        // Notify popup if open
        chrome.runtime.sendMessage({ action: 'allStoresCompleted' });

        // Upload + screenshots FIRST, then send final report
        setTimeout(async () => {
            await uploadToSheets();
            await uploadLogsToSheet();
            if (screenshotsEnabled && trackScreenshotQueue.length > 0) {
                await processScreenshotQueue();
            }
            
            // Now build and send final report with all stats
            const elapsed = parseReport.startedAt ? Math.round((Date.now() - parseReport.startedAt) / 1000) : 0;
            const mins = Math.floor(elapsed / 60);
            const secs = elapsed % 60;
            let report = `📊 Парсинг завершён за ${mins}м ${secs}с\n\n`;
            
            for (const [key, val] of Object.entries(parseReport.stores)) {
                const name = key.startsWith('amazon_') ? `Amazon (${key.replace('amazon_', '')})` : key.charAt(0).toUpperCase() + key.slice(1);
                report += `${val.status} ${name}: ${val.found} заказов\n`;
            }
            
            const ss = parseReport.screenshots;
            if (ss.sent > 0 || ss.skipped > 0 || ss.broken > 0) {
                report += `\n📸 Скриншоты: ${ss.sent} отправлено`;
                if (ss.skipped > 0) report += `, ${ss.skipped} уже было`;
                if (ss.broken > 0) report += `, ${ss.broken} пропущено (битые)`;
                if (ss.failed > 0) report += `, ${ss.failed} ошибок`;
            }
            
            report += `\n\n✅ Выгрузка в Google Sheets завершена`;
            sendTelegramMessage(report);
        }, 1000);
    }
}

async function uploadToSheets() {
    try {
        // Get settings from storage
        const result = await chrome.storage.local.get(['spreadsheetId', 'sheetName', 'orderData', 'chainPochtoy', 'skipProcessed', 'colorProcessed', 'limitRows', 'parseMode']);
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
                allOrders.push(...storeData.orders);
            }
        });

        if (allOrders.length === 0) {
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
        let existing = [];
        try {
            existing = await readSheetData(spreadsheetId, sheetName) || [];
        } catch (e) {
            console.warn('Could not read existing sheet for dedupe, will append all.', e);
        }

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

        // Update existing rows with new qty
        if (rowsToUpdate.length > 0) {
            console.log(`📝 Updating ${rowsToUpdate.length} rows with new qty...`);
            const authToken = await getAuthToken(true);
            const updateData = rowsToUpdate.map(u => ({
                range: `${sheetName}!E${u.row}`,
                values: [[u.qty]]
            }));
            
            await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updateData })
            });
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
                            startSequentialPipeline();
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
    try { await sendTelegramMessage(cmd); } catch (_) {}
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
             sendTelegramMessage(`⚠️ Внимание: Прошло 3 минуты, а парсинг не завершен. Проверьте вкладки браузера.`);
        }
    }, 180000);
}

async function sendTelegramMessage(text) {
    if (!tgBotToken || !tgChatId) {
        console.warn('⚠️ Cannot send Telegram message - missing token or chat ID');
        return;
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
        } else {
             console.log('✅ Telegram message sent.');
        }
    } catch (e) {
        console.error('Failed to send Telegram message:', e);
    }
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

chrome.storage.local.get(['screenshotsEnabled', 'trackScreenshotQueue'], (res) => {
    screenshotsEnabled = res.screenshotsEnabled || false;
    if (Array.isArray(res.trackScreenshotQueue) && res.trackScreenshotQueue.length > 0) {
        trackScreenshotQueue = res.trackScreenshotQueue;
        console.log(`📸 Restored ${trackScreenshotQueue.length} screenshots from storage`);
    }
});

function persistScreenshotQueue() {
    try { chrome.storage.local.set({ trackScreenshotQueue }); } catch (_) {}
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

    // Helper: общая отправка с обработкой fallback
    const sendAs = async (apiMethod, fileField, filename) => {
        const fd = new FormData();
        fd.append('chat_id', tgPhotoChatId);
        fd.append(fileField, blob, filename);
        if (caption) fd.append('caption', caption);
        const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/${apiMethod}`, {
            method: 'POST',
            body: fd
        });
        const json = await res.json().catch(() => ({}));
        return { res, json };
    };

    try {
        // 1) Пробуем как фото — компактно, превью в чате
        let { res, json } = await sendAs('sendPhoto', 'photo', 'screenshot.png');
        let json1 = json;

        // 2) Fallback на sendDocument при PHOTO_INVALID_DIMENSIONS / PHOTO_SAVE_FILE_INVALID / лимитах размера
        const errDesc = String(json?.description || '');
        const fellThrough = !res.ok || !json?.ok;
        const dimensionIssue = /PHOTO_INVALID_DIMENSIONS|PHOTO_SAVE_FILE_INVALID|file is too big|wrong file/i.test(errDesc);
        if (fellThrough && (dimensionIssue || res.status === 400)) {
            console.warn(`⚠️ sendPhoto failed (${errDesc || res.status}), retrying as document`);
            const r2 = await sendAs('sendDocument', 'document', 'screenshot.png');
            res = r2.res; json = r2.json;
        }

        if (!res.ok || !json?.ok) {
            console.error(`❌ Archive send failed (photo+doc): photo=${JSON.stringify(json1)}, doc=${JSON.stringify(json)}`);
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

function queueTrackScreenshot(orderId, trackNumber, trackUrl, accountName) {
    if (!screenshotsEnabled) return;
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
                persistScreenshotQueue();
                console.log(`📸 Merged track ${trackNumber} into existing order ${orderId} (extras: ${existing.extraTracks.length})`);
            }
            return;
        }
    } else if (trackNumber && trackScreenshotQueue.some(q => q.trackNumber === trackNumber)) {
        console.log(`📸 Skip duplicate queue: ${trackNumber} already queued`);
        return;
    }
    const resolvedAccount = accountName || (currentAmazonAccount ? currentAmazonAccount.split('@')[0] : '');
    trackScreenshotQueue.push({ orderId, trackNumber, trackUrl, accountName: resolvedAccount, extraTracks: [] });
    persistScreenshotQueue();
    console.log(`📸 Queued screenshot: ${orderId} / ${trackNumber} (queue: ${trackScreenshotQueue.length})`);
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
    const filtered = queue.filter(item => !sentSet.has(item.trackNumber));
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
    // SW мог уснуть после queueTrackScreenshot — restore очереди из storage
    try {
        const { trackScreenshotQueue: stored = [] } = await chrome.storage.local.get('trackScreenshotQueue');
        if (Array.isArray(stored) && stored.length > trackScreenshotQueue.length) {
            const seen = new Set(trackScreenshotQueue.map(x => x.trackNumber));
            for (const item of stored) {
                if (!seen.has(item.trackNumber)) trackScreenshotQueue.push(item);
            }
            console.log(`📸 Restored ${stored.length} from storage, in-memory now ${trackScreenshotQueue.length}`);
        }
    } catch (_) {}

    if (isProcessingScreenshots || trackScreenshotQueue.length === 0) return;
    isProcessingScreenshots = true;

    const beforeFilter = trackScreenshotQueue.length;
    trackScreenshotQueue = await filterAlreadySent(trackScreenshotQueue);
    parseReport.screenshots.skipped += (beforeFilter - trackScreenshotQueue.length);
    if (trackScreenshotQueue.length === 0) {
        console.log('📸 All screenshots already sent');
        isProcessingScreenshots = false;
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

    const sentTracks = [];
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

    let captchaPaused = false;
    while (trackScreenshotQueue.length > 0) {
        const item = trackScreenshotQueue.shift();
        done++;
        try {
            const result = await captureTrackScreenshot(item, done, total, reuseTab?.id);
            if (result === 'CAPTCHA') {
                trackScreenshotQueue.unshift(item); // Вернуть в очередь
                persistScreenshotQueue();
                isProcessingScreenshots = false;
                captchaPaused = true; // не закрываем reuseTab — юзер будет решать капчу там
                break;
            }
            sentTracks.push(item.trackNumber);
            parseReport.screenshots.sent++;
            await markAsSent([item.trackNumber]);
            persistScreenshotQueue();
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
            parseReport.screenshots.failed++;
            console.error(`❌ Screenshot ${done}/${total} failed: ${item.orderId} — ${e.message || e}`);
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

    if (sentTracks.length > 0) await markAsSent(sentTracks);
    persistScreenshotQueue();
    console.log(`✅ Screenshots done: ${done}/${total}`);
    // Delete progress message — final stats will be in the summary report
    if (progressMsgId) {
        fetch(`https://api.telegram.org/bot${tgBotToken}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: tgChatId, message_id: progressMsgId })
        }).catch(() => {});
    }
    isProcessingScreenshots = false;
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
async function captureEbayShipments(tab) {
    const specs = await computeEbayCropSpecs(tab);
    if (specs.length === 0) {
        const b64 = await captureFullPageStitched(tab);
        return b64 ? [{ base64: b64, trackNum: '', itemName: '', shipmentIdx: 1, shipmentTotal: 1 }] : [];
    }
    const out = [];
    for (const spec of specs) {
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
    return out;
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
    if (!trackUrl) return;

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
                return 'CAPTCHA';
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
                    parseReport.screenshots.broken++;
                    return;
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
            return;
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
                const accountTag = accountName ? '\n📧 ' + accountName : '';
                const shipments = await captureEbayShipments(tab);

                if (shipments.length === 0) {
                    console.warn(`⚠️ captureEbayShipments returned [] for ${orderId}, fallback to single visible`);
                    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
                    const fallbackBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
                    const captionFallback = `📦 ${orderId}\n🚚 ${(trackNumber || '—')}${accountTag}`;
                    const archive = await sendScreenshotToArchive(fallbackBase64, captionFallback);
                    if (archive?.ok && archive.link) firstPageLink = archive.link;
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
                        const trackLine = '🚚 ' + track;
                        const shipTag = s.shipmentTotal > 1 ? ` • пакет ${s.shipmentIdx}/${s.shipmentTotal}` : '';
                        const itemLine = s.itemName ? ('\n🛒 ' + s.itemName) : '';
                        const caption = `📦 ${orderId}${shipTag}\n${trackLine}${itemLine}${accountTag}`;
                        const archive = await sendScreenshotToArchive(s.base64, caption);
                        if (archive?.ok && archive.link) {
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
            }
        } else if (isIherb) {
            try {
                const allTracks = [trackNumber, ...(extraTracks || [])].filter(Boolean);
                const tracksLine = allTracks.length > 1
                    ? '🚚 ' + allTracks.join(', ')
                    : '🚚 ' + (trackNumber || '—');
                const accountTag = accountName ? '\n📧 ' + accountName : '';
                const captionFull = `📦 ${orderId}\n${tracksLine}${accountTag}`;

                // iHerb: кропим только левую tracking-карточку (carrier + delivery + product thumbs + timeline).
                // Ждём пока догрузятся картинки товаров — без этого снимок получается без thumb-квадратиков.
                const cardBase64 = await captureIherbTrackingCard(tab);
                if (!cardBase64) {
                    console.warn(`⚠️ captureIherbTrackingCard returned null for ${orderId}, fallback to visible`);
                    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
                    const fallbackBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
                    const archive = await sendScreenshotToArchive(fallbackBase64, captionFull);
                    if (archive?.ok && archive.link) firstPageLink = archive.link;
                } else {
                    const archive = await sendScreenshotToArchive(cardBase64, captionFull);
                    if (archive?.ok && archive.link) firstPageLink = archive.link;
                }
                screenshotsTaken++;
                console.log(`✅ iHerb tracking card screenshot sent for ${orderId} (tracks: ${allTracks.length})`);

                if (firstPageLink) {
                    for (const tn of allTracks) {
                        try { await writeScreenshotLinkToSheet(tn, firstPageLink); }
                        catch (e) { console.warn(`⚠️ writeScreenshotLinkToSheet ${tn}:`, e?.message || e); }
                    }
                }
            } catch (capErr) {
                console.error(`❌ Fullpage capture failed for ${orderId}:`, capErr);
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
                const pageLabel = page > 1 ? ` [${page}]` : '';
                const accountTag = accountName ? '\n📧 ' + accountName : '';
                const caption = `📦 ${orderId}${pageLabel}\n🚚 ${trackNumber}${accountTag}`;

                const archive = await sendScreenshotToArchive(base64, caption);
                if (archive?.ok && archive.link && !firstPageLink) firstPageLink = archive.link;

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
        }
    } finally {
        // Закрываем только если сами создали локальную вкладку (без reuseTabId).
        // reuse-таб закроет processScreenshotQueue после всего цикла.
        if (tab && createdLocally && !keepTabOpen) {
            try { await chrome.tabs.remove(tab.id); } catch (_) {}
        }
    }
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
