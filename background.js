// Background script for Pochtoy Parser - v7.5.0 (Fix: multi-product deduplication, eBay error handling)

// --- Daily Auto-Parse at 1:00 AM ---
const DAILY_PARSE_HOUR = 1; // 1:00 AM
const DAILY_PARSE_MINUTE = 0;
const DAILY_ALARM_NAME = 'dailyAutoParse';

function setupDailyAlarm() {
    // Calculate ms until next 1:00 AM
    const now = new Date();
    const next = new Date();
    next.setHours(DAILY_PARSE_HOUR, DAILY_PARSE_MINUTE, 0, 0);
    
    // If it's already past 1:00 today, schedule for tomorrow
    if (now >= next) {
        next.setDate(next.getDate() + 1);
    }
    
    const msUntilNext = next.getTime() - now.getTime();
    const minutesUntilNext = msUntilNext / 1000 / 60;
    
    console.log(`⏰ Daily parse scheduled for ${next.toLocaleString('ru-RU')} (in ${Math.round(minutesUntilNext)} minutes)`);
    
    // Create alarm
    chrome.alarms.create(DAILY_ALARM_NAME, {
        delayInMinutes: minutesUntilNext,
        periodInMinutes: 24 * 60 // Repeat every 24 hours
    });
}

// Initialize daily alarm on extension start
setupDailyAlarm();
console.log('✅ Daily auto-parse ENABLED (1:00 AM)');

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
const DEFAULT_SPREADSHEET_ID = '1w1QOzGWc_CNovlezuxyLta-h1kM3pgPXc_GoHYaOA98';

// --- Multi-Account Amazon Parsing ---
const AMAZON_ACCOUNTS_TO_PARSE = [
  'photopochtoy@gmail.com'
  // 'ipochtoy@gmail.com'  // TEMPORARILY DISABLED - account suspended
];
let amazonAccountsQueue = [];
let currentAmazonAccount = null;
let isMultiAccountParsing = false;
const MAX_ACCOUNT_SWITCH_ATTEMPTS = 2;
const ACCOUNT_PARSE_TIMEOUT_MS = 90000;

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
        sendTelegramMessage(`📋 Логи (${parsingLogs.length}) → лист "${LOGS_SHEET_NAME}" ✅`);
        
        logsUploadInProgress = false;
    } catch (error) {
        console.error('Failed to upload logs:', error);
        sendTelegramMessage(`⚠️ Не удалось сохранить логи: ${error.message}`);
        logsUploadInProgress = false;
    }
}

// --- Telegram Bot State ---
let tgBotToken = '8274480416:AAEIvhNsqzDl-dYHMOpjTJ0b1XyS_0lW88w'; // Default token provided by user
let tgChatId = null;
let lastUpdateId = 0;
let tgPollingInterval = null;

// Initialize cache on startup
let cachedProgressState = {};
chrome.storage.local.get(['progressState', 'tgBotToken', 'tgChatId', 'lastUpdateId', 'parsingState'], (result) => {
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

    tgChatId = result.tgChatId;
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
});

// --- Progress Tracking State ---
let totalTasks = 0;
let tasksStarted = 0;
let successCount = 0;
let failureCount = 0;

// --- Progress Handler Function ---
async function handleProgressMessage(request) {
    // Persist progress to storage so popup can restore it when reopened
    const storeKey = request.store.toLowerCase();
    console.log(`📊 [BACKGROUND] Progress from ${request.store}:`, request.current, '/', request.total, request.status);

    // Restore multi-account state from storage FIRST (Service Worker may have restarted)
    const stored = await new Promise(resolve => chrome.storage.local.get(['multiAccountState'], resolve));
    if (stored.multiAccountState) {
        isMultiAccountParsing = stored.multiAccountState.isMultiAccountParsing;
        amazonAccountsQueue = stored.multiAccountState.amazonAccountsQueue || [];
        currentAmazonAccount = stored.multiAccountState.currentAmazonAccount;
    }

    // Update completion status
    const isCompleted = request.status === 'Done ✅' || request.status === 'Error';
    const shouldHandleCompletion = isCompleted && (isParsingAllStores || (storeKey === 'amazon' && isMultiAccountParsing));
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
            
            // Check if Amazon has more accounts to parse
            if (storeKey === 'amazon' && isMultiAccountParsing && amazonAccountsQueue.length > 0) {
                const accountName = currentAmazonAccount ? currentAmazonAccount.split('@')[0] : 'current';
                sendTelegramMessage(`${emoji} Amazon (${accountName}): Готово (${count} заказов). Переключаюсь на следующий аккаунт...`);
                
                // Switch to next account
                switchToNextAmazonAccount();
                return; // Don't mark amazon as completed yet
            }
            
            storesCompleted[storeKey] = true;
            
            if (storeKey === 'amazon' && currentAmazonAccount) {
                sendTelegramMessage(`${emoji} Amazon (${currentAmazonAccount.split('@')[0]}): Готово (${count} заказов)`);
                isMultiAccountParsing = false;
                currentAmazonAccount = null;
            } else {
                sendTelegramMessage(`${emoji} ${storeKey.charAt(0).toUpperCase() + storeKey.slice(1)}: Готово (${count} заказов)`);
            }

            checkAllStoresCompleted();
        }
    }

    // Standalone parse (not multi-account, not parse-all): still notify Telegram
    if (shouldNotifyTelegram) {
        const count = request.found || 0;
        const emoji = request.status === 'Error' ? '❌' : '✅';
        sendTelegramMessage(`${emoji} ${request.store || storeKey}: Готово (${count} заказов)`);
        // Process screenshot queue for standalone parse too
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

        sendTelegramMessage(`🚀 Запущен парсинг всех магазинов (eBay, iHerb, Amazon)...`);
        sendResponse({status: "started"});
    } else if (request.action === "startMultiAccountAmazon") {
        // Start multi-account Amazon parsing
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
    } else if (request.action === "queueTrackScreenshot") {
        queueTrackScreenshot(request.orderId, request.trackNumber, request.trackUrl, request.accountName);
        sendResponse({status: "queued"});
    } else if (request.action === "processScreenshotQueue") {
        processScreenshotQueue();
        sendResponse({status: "processing"});
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
        // Notify Telegram that parser actually started working
        const storeEmoji = {
            'eBay': '🛒',
            'iHerb': '🌿',
            'Amazon': '📦'
        }[request.store] || '🔄';
        sendTelegramMessage(`${storeEmoji} ${request.store}: Парсинг успешно начался!`);
        console.log(`✅ ${request.store} parser started successfully`);
    } else if (request.action === "parseError") {
        // Handle parsing errors (e.g., Service unavailable after retries)
        const storeKey = request.store?.toLowerCase();
        const errorMsg = request.error || 'Unknown error';

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
        isMultiAccountParsing = false;
        currentAmazonAccount = null;
        
        // Clear state
        await chrome.storage.local.remove(['multiAccountState']);
        
        storesCompleted.amazon = true;
        sendTelegramMessage(`✅ Все аккаунты Amazon отпарсены!`);
        checkAllStoresCompleted();
        return;
    }
    
    const nextEmail = amazonAccountsQueue.shift();
    currentAmazonAccount = nextEmail;
    
    console.log(`🔄 Switching to Amazon account: ${nextEmail}`);
    sendTelegramMessage(`🔄 Переключаюсь на аккаунт: ${nextEmail.split('@')[0]}`);
    
    // Save pending switch and updated state, clear completion flag and old pagination
    await chrome.storage.local.set({
        pendingAccountSwitch: { email: nextEmail },
        amazonParsingComplete: null,
        amazonPaginationState: null,
        accountSwitchStartedAt: Date.now(),
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
        await chrome.tabs.update(tabs[0].id, { 
            url: switchUrl,
            active: true 
        });
    } else {
        // Create new tab
        await chrome.tabs.create({ 
            url: switchUrl 
        });
    }
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
    
    amazonAccountsQueue = [...AMAZON_ACCOUNTS_TO_PARSE];
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
    sendTelegramMessage(`🔄 Запускаю парсинг ${amazonAccountsQueue.length} аккаунтов Amazon: ${AMAZON_ACCOUNTS_TO_PARSE.map(e => e.split('@')[0]).join(', ')}`);
    
    // Start watchdog timer to check for completion flag
    startCompletionWatchdog();
    
    // Start with first account switch
    switchToNextAmazonAccount();
}

// Watchdog using chrome.alarms (reliable even when Service Worker sleeps)
const WATCHDOG_ALARM_NAME = 'amazonCompletionWatchdog';

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

// Alarm listener - this fires even when Service Worker wakes up
chrome.alarms.onAlarm.addListener(async (alarm) => {
    // Handle daily auto-parse
    if (alarm.name === DAILY_ALARM_NAME) {
        console.log('⏰ Daily auto-parse alarm triggered!');
        
        // Check if auto-parse is enabled
        const settings = await chrome.storage.local.get(['dailyAutoParseEnabled']);
        if (settings.dailyAutoParseEnabled === false) {
            console.log('⏰ Auto-parse is disabled, skipping');
            return;
        }
        
        sendTelegramMessage('⏰ Автоматический ночной парсинг запущен (1:00)...');
        
        // Reset states and start parsing
        isParsingAllStores = true;
        storesCompleted = { ebay: false, iherb: false, amazon: false };
        saveParsingState();
        cachedProgressState = {};
        chrome.storage.local.set({ progressState: cachedProgressState, stopAllParsers: false });
        await clearParsingLogs();
        
        // Launch parsers
        launchParsersFromBackground();
        return;
    }
    
    if (alarm.name !== WATCHDOG_ALARM_NAME) return;
    
    const stored = await chrome.storage.local.get(['amazonParsingComplete', 'multiAccountState', 'accountSwitchStartedAt']);
    
    // TIMEOUT: if account switch started but no completion within 90s, skip the account
    if (!stored.amazonParsingComplete && stored.accountSwitchStartedAt && stored.multiAccountState) {
        const elapsed = Date.now() - stored.accountSwitchStartedAt;
        if (elapsed > ACCOUNT_PARSE_TIMEOUT_MS) {
            const failedEmail = stored.multiAccountState.currentAmazonAccount || 'unknown';
            console.log(`🚫 Account ${failedEmail} timed out after ${Math.round(elapsed/1000)}s, skipping`);
            sendTelegramMessage(`🚫 Аккаунт ${failedEmail.split('@')[0]} не отвечает ${Math.round(elapsed/1000)}с — пропускаю`);
            
            // Restore state
            isMultiAccountParsing = stored.multiAccountState.isMultiAccountParsing;
            amazonAccountsQueue = stored.multiAccountState.amazonAccountsQueue || [];
            currentAmazonAccount = stored.multiAccountState.currentAmazonAccount;
            
            await chrome.storage.local.remove(['accountSwitchStartedAt', 'amazonParsingComplete', 'amazonPaginationState']);
            switchToNextAmazonAccount();
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
            
            // Process screenshots if no more accounts
            if (!(isMultiAccountParsing && amazonAccountsQueue.length > 0)) {
                if (screenshotsEnabled && trackScreenshotQueue.length > 0) {
                    setTimeout(() => processScreenshotQueue(), 2000);
                }
            }
            
            // If multi-account parsing and more accounts remain
            if (isMultiAccountParsing && amazonAccountsQueue.length > 0) {
                const count = stored.amazonParsingComplete.found || 0;
                const accountName = currentAmazonAccount ? currentAmazonAccount.split('@')[0] : 'current';
                sendTelegramMessage(`✅ Amazon (${accountName}): Готово (${count} заказов). Переключаюсь на следующий аккаунт...`);
                switchToNextAmazonAccount();
            } else if (isMultiAccountParsing) {
                // Last account done
                const count = stored.amazonParsingComplete.found || 0;
                const accountName = currentAmazonAccount ? currentAmazonAccount.split('@')[0] : 'last';
                sendTelegramMessage(`✅ Amazon (${accountName}): Готово (${count} заказов)`);
                sendTelegramMessage(`✅ Все аккаунты Amazon отпарсены!`);
                
                isMultiAccountParsing = false;
                currentAmazonAccount = null;
                await chrome.storage.local.remove(['multiAccountState']);
                
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

        // Aggregate stats for Telegram
        const stats = [];
        for (const [key, val] of Object.entries(cachedProgressState)) {
            if (['ebay','iherb','amazon'].includes(key)) {
                stats.push(`${key.charAt(0).toUpperCase() + key.slice(1)}: ${val.found}`);
            }
        }
        const statsMsg = stats.join(', ');
        sendTelegramMessage(`✅ Парсинг магазинов завершен.\n📊 Найдено: ${statsMsg}\n📤 Начинаю выгрузку в Google Sheets...`);

        console.log('🚀 All stores processed! Starting auto-upload to Google Sheets...');
        
        // Notify popup if open
        chrome.runtime.sendMessage({ action: 'allStoresCompleted' });

        // Small delay to ensure data is settled
        setTimeout(async () => {
            await uploadToSheets();
            await uploadLogsToSheet();
            // Process track screenshots queue after everything is done
            if (screenshotsEnabled) {
                processScreenshotQueue();
            }
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
            sendTelegramMessage(`ℹ️ Нет данных для загрузки.`);
            
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
            // Warehouse Mode: Standard columns
            values = allOrders.map(o => [
                o.store_name || '',
                o.order_id || '',
                o.track_number || '',
                o.product_name || '',
                o.qty || '',
                o.color || '',
                o.size || ''
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
             
             // Key WITHOUT qty: store + order + track + product
             const existingMap = new Map();
             existingRows.forEach((r, idx) => {
                 const key = [r[0]||'', r[1]||'', r[2]||'', r[3]||''].join('\u0001');
                 const existingQty = r[4] || '1';
                 existingMap.set(key, { rowIndex: idx + headerOffset + 1, qty: existingQty }); // 1-based row in sheet
             });
             
             for (const r of values) {
                 const key = [r[0], r[1], r[2], r[3]].join('\u0001');
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
            sendTelegramMessage(`📝 Обновлено количество в ${rowsToUpdate.length} строках.`);
        }

        if (newValues.length === 0 && rowsToUpdate.length === 0) {
            console.log('Nothing new to upload.');
            chrome.runtime.sendMessage({ action: 'uploadComplete', status: 'info', message: 'Nothing new to upload (duplicates).' });
            sendTelegramMessage(`ℹ️ Дубликаты пропущены. Новых записей нет.`);
            
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
        sendTelegramMessage(`✅ Загружено ${newValues.length} новых${rowsToUpdate.length > 0 ? `, обновлено qty в ${rowsToUpdate.length}` : ''}.`);

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
    sendTelegramMessage(`🛑 Робот остановлен пользователем.`);
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
                    
                    // Auto-parse commands
                    if (text === '/autoparse on' || text === '/auto on') {
                        await chrome.storage.local.set({ dailyAutoParseEnabled: true });
                        setupDailyAlarm();
                        sendTelegramMessage('⏰ Автопарсинг ВКЛЮЧЕН! Буду запускаться каждый день в 1:00 ночи.');
                        continue;
                    }
                    
                    if (text === '/autoparse off' || text === '/auto off') {
                        await chrome.storage.local.set({ dailyAutoParseEnabled: false });
                        chrome.alarms.clear(DAILY_ALARM_NAME);
                        sendTelegramMessage('⏰ Автопарсинг ВЫКЛЮЧЕН.');
                        continue;
                    }
                    
                    if (text === '/status') {
                        const settings = await chrome.storage.local.get(['dailyAutoParseEnabled']);
                        const autoEnabled = settings.dailyAutoParseEnabled !== false; // default true
                        const alarm = await chrome.alarms.get(DAILY_ALARM_NAME);
                        let statusMsg = `📊 Статус:\n`;
                        statusMsg += `⏰ Автопарсинг: ${autoEnabled ? 'ВКЛ' : 'ВЫКЛ'}\n`;
                        if (alarm) {
                            const nextRun = new Date(alarm.scheduledTime);
                            statusMsg += `📅 Следующий запуск: ${nextRun.toLocaleString('ru-RU')}`;
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
                            // Trigger Parse All Stores
                            console.log('✅ Command accepted! Starting parse...');
                            sendTelegramMessage(`🫡 Принято! Запускаю полный цикл парсинга...`);
                            
                            // Simulate the trigger
                            chrome.runtime.sendMessage({ action: "startParsingAllStores" });
                            
                            launchParsersFromBackground();
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
        { key: 'iherb', tabId: openedTabs.iherb, action: 'exportIherbOrders', name: 'iHerb' }
    ];

    // Wait for pages to initially load
    await new Promise(r => setTimeout(r, 10000));
    console.log('📤 [FALLBACK] Starting sendMessage retry for eBay & iHerb...');

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
        sendTelegramMessage(`⚠️ ${store.name}: Автопарс не сработал, отправляю команду напрямую...`);

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
                sendTelegramMessage(`✅ ${store.name}: Команда парсинга отправлена (попытка ${attempt})`);
                sent = true;
                break;
            } catch (e) {
                console.warn(`⚠️ [FALLBACK] ${store.name} attempt ${attempt}: ${e.message}`);
                await new Promise(r => setTimeout(r, 3000));
            }
        }

        if (!sent) {
            console.error(`❌ [FALLBACK] ${store.name}: Failed after 15 attempts`);
            sendTelegramMessage(`❌ ${store.name}: Не удалось запустить парсер после 15 попыток`);
        }
    }
}

async function launchParsersFromBackground() {
    console.log('🚀 launchParsersFromBackground() triggered');
    
    // Ensure stop flag is cleared
    await chrome.storage.local.set({ stopAllParsers: false });

    // Start parsing state
    isParsingAllStores = true;
    storesCompleted = { ebay: false, iherb: false, amazon: false };
    saveParsingState();
    
    // Reset progress cache
    cachedProgressState = {}; 
    chrome.storage.local.set({ progressState: cachedProgressState });
    
    // eBay and iHerb - open tabs with auto-parse flags
    const nonAmazonStores = [
        { key: 'ebay', url: 'https://www.ebay.com/mye/myebay/purchase', emoji: '🛒' },
        { key: 'iherb', url: 'https://secure.iherb.com/myaccount/orders', emoji: '🌿' }
    ];

    // Set flags in storage so content scripts start automatically when loaded
    // Using BOTH timestamp flags AND boolean flags for reliability
    const now = Date.now();
    await chrome.storage.local.set({
        autoParse_ebay: now,
        autoParse_iherb: now,
        // Boolean flags that don't expire (cleared by content scripts after use)
        ebay_should_autoparse: true,
        iherb_should_autoparse: true
        // Amazon will use multi-account parsing instead!
    });
    console.log('🚩 Auto-parse flags set for eBay & iHerb (timestamp + boolean)');
    sendTelegramMessage(`🏁 Запускаю eBay, iHerb и Amazon (multi-account)...`);

    const openedTabs = {};
    for (const store of nonAmazonStores) {
        console.log(`🌐 Opening tab for ${store.key}...`);
        sendTelegramMessage(`${store.emoji} ${store.key.toUpperCase()}: Открываю страницу заказов...`);
        const tab = await chrome.tabs.create({ url: store.url, active: false });
        openedTabs[store.key] = tab.id;
    }

    // FALLBACK: If auto-parse flags don't work, send message with retry after page loads
    // This runs in background and doesn't block the rest of the flow
    sendParseCommandsWithRetry(openedTabs);

    // Amazon - use multi-account parsing (photopochtoy + ipochtoy)
    console.log('📦 Starting multi-account Amazon parsing...');
    sendTelegramMessage(`📦 AMAZON: Запускаю multi-account парсинг (photo + i)...`);
    startMultiAccountAmazonParsing();

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


// --- TRACK SCREENSHOT QUEUE ---
let trackScreenshotQueue = [];
let isProcessingScreenshots = false;
let screenshotsEnabled = false;

chrome.storage.local.get(['screenshotsEnabled'], (res) => {
    screenshotsEnabled = res.screenshotsEnabled || false;
});

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

function queueTrackScreenshot(orderId, trackNumber, trackUrl, accountName) {
    if (!screenshotsEnabled) return;
    trackScreenshotQueue.push({ orderId, trackNumber, trackUrl, accountName });
    console.log(`📸 Queued screenshot: ${orderId} / ${trackNumber} (queue: ${trackScreenshotQueue.length})`);
}

async function processScreenshotQueue() {
    if (isProcessingScreenshots || trackScreenshotQueue.length === 0) return;
    isProcessingScreenshots = true;

    const total = trackScreenshotQueue.length;
    sendTelegramMessage(`📸 Начинаю скриншоты треков: ${total} шт.`);

    let done = 0;
    while (trackScreenshotQueue.length > 0) {
        const item = trackScreenshotQueue.shift();
        done++;
        try {
            await captureTrackScreenshot(item, done, total);
        } catch (e) {
            console.error(`❌ Screenshot failed for ${item.orderId}:`, e);
        }
        await new Promise(r => setTimeout(r, 500));
    }

    sendTelegramMessage(`✅ Скриншоты треков завершены: ${done}/${total}`);
    isProcessingScreenshots = false;
}

async function captureTrackScreenshot({ orderId, trackNumber, trackUrl, accountName }, current, total) {
    if (!trackUrl) return;

    console.log(`📸 [${current}/${total}] Capturing: ${orderId} / ${trackNumber}`);

    let tab;
    try {
        tab = await chrome.tabs.create({ url: trackUrl, active: true });

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

        await new Promise(r => setTimeout(r, 2000));

        const tabInfo = await chrome.tabs.get(tab.id);
        const finalUrl = tabInfo.url || '';
        if (!finalUrl.includes('ship-track') && !finalUrl.includes('track-package') && !finalUrl.includes('progress-tracker')) {
            console.log(`⚠️ Skipping screenshot - redirected to: ${finalUrl.substring(0, 80)}`);
            return;
        }

        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');

        const acct = accountName ? accountName.split('@')[0] : '';
        const caption = `📦 ${orderId}\n🚚 ${trackNumber}${acct ? '\n👤 ' + acct : ''}`;

        await sendTelegramPhoto(base64, caption);
    } finally {
        if (tab) {
            try { await chrome.tabs.remove(tab.id); } catch (_) {}
        }
    }
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
