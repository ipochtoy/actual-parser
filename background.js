// Background script for Pochtoy Parser - v6.10.5 (Service Worker Fix)

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
function handleProgressMessage(request) {
    // Persist progress to storage so popup can restore it when reopened
    const storeKey = request.store.toLowerCase();
    console.log(`📊 [BACKGROUND] Progress from ${request.store}:`, request.current, '/', request.total, request.status);

    // Update completion status
    if (isParsingAllStores && (request.status === 'Done ✅' || request.status === 'Error')) {
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
            storesCompleted[storeKey] = true;

            // Send completion message to Telegram
            const count = request.found || 0;
            const emoji = request.status === 'Error' ? '❌' : '✅';
            sendTelegramMessage(`${emoji} ${storeKey.charAt(0).toUpperCase() + storeKey.slice(1)}: Готово (${count} заказов)`);

            checkAllStoresCompleted();
        }
    }

    // Update cache synchronously (if not already updated above)
    if (!(isParsingAllStores && (request.status === 'Done ✅' || request.status === 'Error'))) {
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
    if (request.action !== 'progress') { // Reduce noise
        console.log('📨 Message received:', request.action, request);
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

        sendTelegramMessage(`🚀 Запущен парсинг всех магазинов (eBay, iHerb, Amazon)...`);
        sendResponse({status: "started"});
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
        setTimeout(() => {
            uploadToSheets();
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
                        // Also tell tabs? Not really needed as they poll storage or check on next page
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
    
    // Open all tabs first
    const stores = [
        { key: 'ebay', url: 'https://www.ebay.com/mye/myebay/purchase', emoji: '🛒' },
        { key: 'iherb', url: 'https://secure.iherb.com/myaccount/orders', emoji: '🌿' },
        { key: 'amazon', url: 'https://www.amazon.com/gp/css/order-history', emoji: '📦' }
    ];

    // Set flags in storage so content scripts start automatically when loaded
    const now = Date.now();
    await chrome.storage.local.set({
        autoParse_ebay: now,
        autoParse_iherb: now,
        autoParse_amazon: now
    });
    console.log('🚩 Auto-parse flags set in storage');
    sendTelegramMessage(`🏁 Флаги запуска установлены. Открываю вкладки...`);

    for (const store of stores) {
        console.log(`🌐 Opening tab for ${store.key}...`);
        sendTelegramMessage(`${store.emoji} ${store.key.toUpperCase()}: Открываю страницу заказов...`);
        // Open tab - content script will read storage and start
        await chrome.tabs.create({ url: store.url, active: false });
        // No need to inject or send messages manually!
    }

    // Watchdog: Check progress after 2 minutes
    setTimeout(() => {
        if (isParsingAllStores && !storesCompleted.ebay && !storesCompleted.iherb && !storesCompleted.amazon) {
             sendTelegramMessage(`⚠️ Внимание: Прошло 2 минуты, а парсинг не завершен. Проверьте вкладки браузера.`);
        }
    }, 120000);

    // Backup: Send explicit message to Amazon after 5 seconds (in case flag missed)
    setTimeout(async () => {
        if (isParsingAllStores && !storesCompleted.amazon) {
             console.log('⚠️ Sending backup "parse" command to Amazon tab...');
             const tabs = await chrome.tabs.query({ url: "https://www.amazon.com/gp/css/order-history*" });
             if (tabs.length > 0) {
                 chrome.tabs.sendMessage(tabs[0].id, { action: "autoParse" }).catch(() => {});
             }
        }
    }, 7000);
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
