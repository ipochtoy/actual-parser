import { readSheetData, writeDataToSheet, getAuthToken } from './google-auth.js';

// Fixed default Google Sheet ID (Pochtoy sheet)
const DEFAULT_SPREADSHEET_ID = '1w1QOzGWc_CNovlezuxyLta-h1kM3pgPXc_GoHYaOA98';

document.addEventListener('DOMContentLoaded', () => {
    initialize();
});

const stores = [
    { name: 'Ebay', id: 'parseEbay', urlPattern: '*://www.ebay.com/mye/myebay/purchase*', url: 'https://www.ebay.com/mye/myebay/purchase', action: 'parseEbay' },
    { name: 'iHerb', id: 'parseIherb', urlPattern: '*://secure.iherb.com/myaccount/orders*', url: 'https://secure.iherb.com/myaccount/orders', action: 'parseIherb' },
    { name: 'Amazon', id: 'parseAmazon', urlPattern: '*://www.amazon.com/gp/your-account/order-history*', url: 'https://www.amazon.com/gp/your-account/order-history', action: 'parseAmazon' }
];

function initialize() {
    stores.forEach(store => {
        document.getElementById(store.id)?.addEventListener('click', () => parseStore(store));
    });

    document.getElementById('parseAllStores')?.addEventListener('click', parseAllStores);
    document.getElementById('parseMultiAmazon')?.addEventListener('click', parseMultiAccountAmazon);
    document.getElementById('exportBtn')?.addEventListener('click', exportToCsv);
    document.getElementById('copyToSheets')?.addEventListener('click', () => copyForAllStores(false));
    // copyAndOpen button removed; keep code resilient if absent
    document.getElementById('copyAndOpen')?.addEventListener('click', () => copyForAllStores(true));
    document.getElementById('clearData')?.addEventListener('click', clearAllStoreData);
    document.getElementById('upload-btn')?.addEventListener('click', uploadToSheets);
    
    // --- NEW: Automation Listeners ---
    document.getElementById('start-sync-btn')?.addEventListener('click', startSync);
    document.getElementById('stop-sync-btn')?.addEventListener('click', stopSync);

    const pagesToParseInput = document.getElementById('pagesToParse');
    if (pagesToParseInput) {
        pagesToParseInput.addEventListener('change', (event) => {
            chrome.storage.local.set({ savedPagesToParse: event.target.value });
        });
    }

    // New controls (with null checks)
    document.getElementById('skip-processed')?.addEventListener('change', (e)=>{
        chrome.storage.local.set({ skipProcessed: e.target.checked });
    });
    document.getElementById('color-processed')?.addEventListener('change', (e)=>{
        chrome.storage.local.set({ colorProcessed: e.target.checked });
    });
    document.getElementById('limit-rows')?.addEventListener('change', (e)=>{
        chrome.storage.local.set({ limitRows: e.target.checked });
    });
    document.getElementById('chain-pochtoy')?.addEventListener('change', (e)=>{
        chrome.storage.local.set({ chainPochtoy: e.target.checked });
    });
    document.getElementById('save-tg-settings')?.addEventListener('click', () => {
        const token = document.getElementById('tg-bot-token')?.value.trim();
        const chatId = document.getElementById('tg-chat-id')?.value.trim();
        chrome.storage.local.set({ tgBotToken: token, tgChatId: chatId }, () => {
            const btn = document.getElementById('save-tg-settings');
            if (btn) {
                btn.textContent = '✓';
                setTimeout(() => btn.textContent = '💾', 1000);
            }
            // Notify background to reload settings
            chrome.runtime.sendMessage({ action: 'reloadTgSettings' });
        });
    });

    document.getElementById('reset-marks-btn')?.addEventListener('click', resetMarks);
    document.getElementById('screenshots-enabled')?.addEventListener('change', (e) => {
        chrome.storage.local.set({ screenshotsEnabled: e.target.checked });
        chrome.runtime.sendMessage({ action: 'reloadScreenshotSettings' });
    });

    // --- NEW: Financial Mode Logic ---
    const modeRadios = document.getElementsByName('parseMode');
    const testParseBtn = document.getElementById('testParseFinancial');

    if (testParseBtn) {
        function updateModeUI(mode) {
            if (mode === 'financial') {
                testParseBtn.style.display = 'block';
            } else {
                testParseBtn.style.display = 'none';
            }
        }

        Array.from(modeRadios).forEach(radio => {
            radio.addEventListener('change', (e) => {
                const mode = e.target.value;
                chrome.storage.local.set({ parseMode: mode });
                updateModeUI(mode);
            });
        });

        testParseBtn.addEventListener('click', () => {
            // Trigger Financial Test Parse for Amazon (defaulting to Amazon for now as it's the most complex)
            const store = stores.find(s => s.name === 'Amazon');
            if (store) {
                 parseStore(store, { isTest: true, pages: 3 });
            }
        });
    }

    // Restore saved toggles and default spreadsheet
    chrome.storage.local.get(['skipProcessed','colorProcessed','limitRows','chainPochtoy','savedPagesToParse','spreadsheetId','sheetName','tgBotToken','tgChatId', 'parseMode', 'screenshotsEnabled'], (res)=>{
        if (res.parseMode && testParseBtn) {
            const radio = document.querySelector(`input[name="parseMode"][value="${res.parseMode}"]`);
            if (radio) radio.checked = true;
            // updateModeUI is inside if(testParseBtn) block, skip if button doesn't exist
        }
        
        const skipProcessedEl = document.getElementById('skip-processed');
        if (skipProcessedEl && typeof res.skipProcessed === 'boolean') skipProcessedEl.checked = res.skipProcessed;

        const colorProcessedEl = document.getElementById('color-processed');
        if (colorProcessedEl) colorProcessedEl.checked = (typeof res.colorProcessed === 'boolean') ? res.colorProcessed : true;

        const limitRowsEl = document.getElementById('limit-rows');
        if (limitRowsEl) limitRowsEl.checked = (typeof res.limitRows === 'boolean') ? res.limitRows : true;

        const chainPochtoyEl = document.getElementById('chain-pochtoy');
        if (chainPochtoyEl) chainPochtoyEl.checked = (typeof res.chainPochtoy === 'boolean') ? res.chainPochtoy : false;
        
        const tgTokenEl = document.getElementById('tg-bot-token');
        if (res.tgBotToken && tgTokenEl) tgTokenEl.value = res.tgBotToken;

        const tgChatEl = document.getElementById('tg-chat-id');
        if (res.tgChatId && tgChatEl) tgChatEl.value = res.tgChatId;

        const screenshotsEl = document.getElementById('screenshots-enabled');
        if (screenshotsEl) screenshotsEl.checked = res.screenshotsEnabled || false;

        if (res.savedPagesToParse && pagesToParseInput) pagesToParseInput.value = res.savedPagesToParse;

        // Restore Spreadsheet ID (or use hardcoded default)
        const ssInput = document.getElementById('spreadsheet-id');
        if (ssInput) {
            ssInput.value = res.spreadsheetId || DEFAULT_SPREADSHEET_ID;
        }

        const snInput = document.getElementById('sheet-name');
        if (snInput && res.sheetName) snInput.value = res.sheetName;
    });

    // Save Spreadsheet ID on change
    document.getElementById('spreadsheet-id')?.addEventListener('change', (e) => {
        const newVal = e.target.value.trim();
        chrome.storage.local.set({ spreadsheetId: newVal });
    });
    
    // Save Spreadsheet ID button
    document.getElementById('save-spreadsheet-id')?.addEventListener('click', () => {
        const val = document.getElementById('spreadsheet-id').value.trim();
        chrome.storage.local.set({ spreadsheetId: val }, () => {
            const btn = document.getElementById('save-spreadsheet-id');
            const originalText = btn.textContent;
            btn.textContent = '✓';
            btn.style.backgroundColor = '#28a745';
            setTimeout(() => {
                btn.textContent = originalText;
                btn.style.backgroundColor = '#4a5568';
            }, 1000);
        });
    });

    // Only persist sheet name, spreadsheet ID is hardcoded
    document.getElementById('sheet-name')?.addEventListener('change', (e)=>{
        chrome.storage.local.set({ sheetName: e.target.value.trim() || 'Лист1' });
    });

    updateCopyButtonState();
    restoreProgressState();
    restorePagesToParse();
    restoreAutomationState(); // Restore automation progress on open
}

function restorePagesToParse() {
    chrome.storage.local.get('savedPagesToParse', (result) => {
        if (result.savedPagesToParse) {
            const pagesToParseInput = document.getElementById('pagesToParse');
            if (pagesToParseInput) {
                pagesToParseInput.value = result.savedPagesToParse;
            }
        }
    });
}

function getUrlPatternsForStore(store) {
    if (store.name === 'Amazon') {
        return [
            '*://www.amazon.com/gp/your-account/order-history*',
            '*://www.amazon.com/gp/css/order-history*',
            '*://www.amazon.com/your-orders*'
        ];
    }
    return [store.urlPattern];
}

function urlMatchesAnyPattern(url, patterns) {
    return patterns.some(p => {
        const rx = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, m => m === '*' ? '.*' : `\\${m}`).replace(/\\\*/g, '.*'));
        return rx.test(url);
    });
}

async function parseStore(store, overrides = {}) {
    const button = document.getElementById(store.id);
    if(button) {
        button.classList.add('loading');
        button.disabled = true;
    }

    // For Amazon, use multi-account parsing (photopochtoy + ipochtoy)
    if (store.name === 'Amazon' && !overrides.skipMultiAccount) {
        console.log('🔄 Starting multi-account Amazon parsing from regular button');
        chrome.runtime.sendMessage({ action: "startMultiAccountAmazon" }, (response) => {
            if (response?.status === 'started') {
                updateStatus('🔄 Multi-account Amazon parsing started', 'success');
            }
        });
        if(button) {
            button.classList.remove('loading');
            button.disabled = false;
        }
        return;
    }

    try {
        // Get current mode
        const mode = document.querySelector('input[name="parseMode"]:checked')?.value || 'warehouse';

        // Clear any previous stop flag when we explicitly start parsing
        await new Promise(resolve => chrome.storage.local.set({ stopAllParsers: false }, resolve));

        const patterns = getUrlPatternsForStore(store);
        // --- IMPROVEMENT: Check current tab first ---
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

        let tabToUse;

        if (activeTab && activeTab.url && urlMatchesAnyPattern(activeTab.url, patterns)) {
            // If the currently active tab matches the store's URL, use it
            console.log(`Parsing directly on active tab: ${activeTab.url}`);
            tabToUse = activeTab;
        } else {
            // Otherwise, find an existing tab matching any pattern
            const existingTabs = await chrome.tabs.query({ url: patterns });
            if (existingTabs.length > 0) {
                tabToUse = existingTabs[0];
                await chrome.tabs.update(tabToUse.id, { active: true });
            } else {
                // Create new tab using explicit URL (no wildcard replacement)
                tabToUse = await chrome.tabs.create({ url: store.url, active: true });
            }
        }
        
        const options = {
            pages: (store.name === 'Amazon') ? (parseInt(document.getElementById('pagesToParse')?.value, 10) || 1) : undefined,
            mode: mode,
            ...overrides
        };

        // ROBUST: Retry sendMessage until content script is ready
        // Content scripts on SPA pages (iHerb, eBay) may not be loaded yet
        const maxRetries = 10;
        let sent = false;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            // Wait longer for newly created tabs
            const waitMs = attempt === 1 ? 1500 : 2000;
            await new Promise(resolve => setTimeout(resolve, waitMs));

            console.log(`📤 [Attempt ${attempt}/${maxRetries}] Sending parse message to ${store.name} (tab ${tabToUse.id})...`);

            try {
                await new Promise((resolve, reject) => {
                    chrome.tabs.sendMessage(tabToUse.id, {
                        action: store.action,
                        options: options
                    }, (response) => {
                        if (chrome.runtime.lastError) {
                            console.warn(`⚠️ Attempt ${attempt}: ${chrome.runtime.lastError.message}`);
                            reject(chrome.runtime.lastError);
                        } else {
                            console.log(`✅ Message delivered to ${store.name} on attempt ${attempt}`, response);
                            resolve(response);
                        }
                    });
                });
                sent = true;
                break;
            } catch (e) {
                if (attempt === maxRetries) {
                    console.error(`❌ Failed to send message to ${store.name} after ${maxRetries} attempts`);
                    updateStatus(`❌ ${store.name}: content script not responding. Try refreshing the page.`, 'error');
                }
            }
        }

    } catch (error) {
        console.error(`Error parsing ${store.name}:`, error);
        updateStatus(`Error with ${store.name}: ${error.message}`, 'error');
    } finally {
        if(button) {
            button.classList.remove('loading');
            button.disabled = false;
        }
    }
}

async function parseAllStores() {
    updateStatus('🚀 Launching parsers...', 'info');
    await clearAllStoreData(false); // silent clear

    // Notify background to initialize state
    chrome.runtime.sendMessage({ action: "startParsingAllStores" });

    // Clear any previous stop flag when we explicitly start parsing
    await new Promise(resolve => chrome.storage.local.set({ stopAllParsers: false }, resolve));

    const multiProgress = document.getElementById('multiProgress');
    if (multiProgress) {
        multiProgress.style.display = 'block';
        ['ebay', 'iherb', 'amazon'].forEach(storeKey => {
            updateStoreProgress(storeKey.charAt(0).toUpperCase() + storeKey.slice(1), 0, 1, 'Waiting...');
        });
    }

    // Helper: retry sending message until content script responds
    async function sendMessageWithRetry(tabId, message, storeName, maxRetries = 12) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const waitMs = attempt <= 3 ? 2000 : 3000;
            await new Promise(resolve => setTimeout(resolve, waitMs));

            console.log(`📤 [${storeName}] Attempt ${attempt}/${maxRetries} sending message...`);
            updateStoreProgress(storeName, 0, 1, `Connecting... (${attempt}/${maxRetries})`);

            try {
                const response = await new Promise((resolve, reject) => {
                    chrome.tabs.sendMessage(tabId, message, (resp) => {
                        if (chrome.runtime.lastError) {
                            reject(chrome.runtime.lastError);
                        } else {
                            resolve(resp);
                        }
                    });
                });
                console.log(`✅ [${storeName}] Message delivered on attempt ${attempt}`, response);
                updateStoreProgress(storeName, 0, 1, "Parsing...");
                return true;
            } catch (e) {
                console.warn(`⚠️ [${storeName}] Attempt ${attempt}: ${e.message}`);
            }
        }
        console.error(`❌ [${storeName}] Failed after ${maxRetries} attempts`);
        updateStoreProgress(storeName, 1, 1, "Error - no response");
        return false;
    }

    // Only eBay and iHerb are opened directly - Amazon uses multi-account via background.js
    try {
        // Step 1: Open eBay tab
        updateStoreProgress('Ebay', 0, 1, "Opening...");
        const ebayTab = await chrome.tabs.create({ url: 'https://www.ebay.com/mye/myebay/purchase', active: false });
        console.log(`🌐 eBay tab created: ${ebayTab.id}`);

        // Step 2: Open iHerb tab
        updateStoreProgress('iHerb', 0, 1, "Opening...");
        const iherbTab = await chrome.tabs.create({ url: 'https://secure.iherb.com/myaccount/orders', active: false });
        console.log(`🌐 iHerb tab created: ${iherbTab.id}`);

        // Step 3: Wait for initial page load
        updateStatus('Waiting for pages to load...', 'info');
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Step 4: Refresh iHerb to avoid "Service unavailable" issue
        updateStoreProgress('iHerb', 0, 1, "Refreshing...");
        await chrome.tabs.reload(iherbTab.id);
        console.log('🔄 iHerb tab refreshed');

        // Step 5: Send parse commands with retry (in parallel)
        console.log('📤 Sending parse commands with retry...');
        const [ebayResult, iherbResult] = await Promise.all([
            sendMessageWithRetry(ebayTab.id, { action: 'exportEbayOrders' }, 'Ebay'),
            sendMessageWithRetry(iherbTab.id, { action: 'exportIherbOrders' }, 'iHerb')
        ]);

        console.log(`📊 Parse commands: eBay=${ebayResult}, iHerb=${iherbResult}`);

        // Step 6: Amazon uses multi-account parsing via background.js
        updateStoreProgress('Amazon', 0, 1, "Starting multi-account...");
        chrome.runtime.sendMessage({ action: "startMultiAccountAmazon" }, (response) => {
            if (response?.status === 'started') {
                console.log('✅ Multi-account Amazon parsing started');
            } else {
                console.error('❌ Failed to start multi-account Amazon parsing');
                updateStoreProgress('Amazon', 1, 1, "Error");
            }
        });

        updateStatus('✅ All parse commands sent!', 'success');

    } catch (error) {
        console.error('Error in parseAllStores:', error);
        updateStatus('Failed to open or command tabs.', 'error');
    }
}

// Multi-account Amazon parsing (photopochtoy + ipochtoy)
async function parseMultiAccountAmazon() {
    updateStatus('🔄 Starting multi-account Amazon parsing...', 'info');
    
    const multiProgress = document.getElementById('multiProgress');
    if (multiProgress) {
        multiProgress.style.display = 'block';
        updateStoreProgress('Amazon', 0, 1, 'Switching accounts...');
    }
    
    // Send message to background to start multi-account parsing
    chrome.runtime.sendMessage({ action: "startMultiAccountAmazon" }, (response) => {
        if (response?.status === 'started') {
            updateStatus('🔄 Multi-account parsing started. Check Amazon tabs.', 'success');
        } else {
            updateStatus('Failed to start multi-account parsing.', 'error');
        }
    });
}


function updateStatus(message, type) {
    const statusEl = document.getElementById('status');
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
    statusEl.style.display = 'block';
      setTimeout(() => {
        if (statusEl.textContent === message) {
            statusEl.style.display = 'none';
        }
    }, 5000);
}

function updateCopyButtonState() {
    chrome.storage.local.get('orderData', (result) => {
        const orderData = result.orderData || {};
        let totalProducts = 0;
        Object.values(orderData).forEach(storeData => {
            if (typeof storeData.totalProductsCount === 'number') {
                totalProducts += storeData.totalProductsCount;
            } else if (Array.isArray(storeData.orders)) {
                totalProducts += storeData.orders.length;
            }
        });

        const copyBtn = document.getElementById('copyToSheets');
        const copyAndOpenBtn = document.getElementById('copyAndOpen');
        
        if (copyBtn) {
            if (totalProducts > 0) {
                copyBtn.textContent = `📋 Copy ${totalProducts} items for Google Sheets`;
                copyBtn.disabled = false;
            } else {
                copyBtn.textContent = '📋 Copy for Google Sheets';
                copyBtn.disabled = true;
            }
        }
        if (copyAndOpenBtn) {
            if (totalProducts > 0) {
                copyAndOpenBtn.textContent = `📊 Copy ${totalProducts} & Open Sheets`;
                copyAndOpenBtn.disabled = false;
            } else {
                copyAndOpenBtn.textContent = '📊 Copy & Open Google Sheets';
                copyAndOpenBtn.disabled = true;
            }
        }
  });
}

async function exportToCsv() {
    chrome.storage.local.get('orderData', (result) => {
        const allOrders = [];
        const orderData = result.orderData || {};
        Object.values(orderData).forEach(storeData => {
            if (storeData.orders) {
                allOrders.push(...storeData.orders);
            }
        });

        if (allOrders.length === 0) {
            updateStatus('No orders to export.', 'info');
      return;
    }

        const header = "Store\tOrder ID\tTracking Number\tProduct Name\tQuantity\tColor\tSize\n";
        const tsv = allOrders.map(o => `${o.store_name}\t${o.order_id}\t${o.track_number}\t${o.product_name}\t${o.qty}\t${o.color || ''}\t${o.size || ''}`).join('\n');
        const blob = new Blob([header + tsv], { type: 'text/tab-separated-values;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `orders_${new Date().toISOString().slice(0,10)}.tsv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        updateStatus('Exported to CSV (TSV format).', 'success');
    });
}

async function copyForAllStores(openSheets = false) {
    const buttonToAnimate = openSheets ? document.getElementById('copyAndOpen') : document.getElementById('copyToSheets');
    const originalText = buttonToAnimate.textContent;

    chrome.storage.local.get('orderData', async (result) => {
        const allOrders = [];
        const orderData = result.orderData || {};
        Object.values(orderData).forEach(storeData => {
            if (storeData.orders) {
                allOrders.push(...storeData.orders);
            }
        });

        if (allOrders.length === 0) {
            updateStatus('No orders to copy.', 'info');
            return;
        }

        const tsv = allOrders.map(o => `${o.store_name || ''}\t${o.order_id || ''}\t${o.track_number || ''}\t${o.product_name || ''}\t${o.qty || ''}\t${o.color || ''}\t${o.size || ''}`).join('\n');
        
        try {
            await navigator.clipboard.writeText(tsv);
            updateStatus(`Copied ${allOrders.length} items!`, 'success');
            
            // --- VISUAL FEEDBACK ---
            buttonToAnimate.textContent = '✓ Copied!';
            buttonToAnimate.style.backgroundColor = '#28a745'; // Green
            buttonToAnimate.style.color = 'white';

            setTimeout(() => {
                buttonToAnimate.textContent = originalText;
                buttonToAnimate.style.backgroundColor = '';
                buttonToAnimate.style.color = '';
            }, 2000);
            // --- END FEEDBACK ---

            if(openSheets) {
                chrome.tabs.create({ url: 'https://docs.google.com/spreadsheets/d/1w1QOzGWc_CNovlezuxyLta-h1kM3pgPXc_GoHYaOA98/edit#gid=0' });
            }
        } catch (err) {
            updateStatus('Failed to copy.', 'error');
        }
    });
}

function copyForSheets() {
    copyForAllStores(false);
}

function copyAndOpenSheets() {
    copyForAllStores(true);
}

async function clearAllStoreData(confirmUser = true) {
    const doClear = confirmUser ? confirm("Are you sure you want to clear ALL stored data for ALL stores?") : true;
    if (doClear) {
        // Also act as STOP for running tasks
        chrome.runtime.sendMessage({ action: "stopPochtoyAutomation" });
        await new Promise(resolve => chrome.storage.local.set({ stopAllParsers: true }, resolve));

        await chrome.storage.local.remove(['orderData', 'progressState', 'automationState', 'parsingState']); // Clear automation state too
        updateCopyButtonState();
        updateStatus('All data cleared and parsing stopped.', 'success');
        
        // Also reset progress bars if they are visible
        const multiProgress = document.getElementById('multiProgress');
        if (multiProgress) {
            multiProgress.style.display = 'none';
        }
        updateAutomationProgress({ isRunning: false, summary: null }); // Reset UI
    }
}


// === NEW UPLOAD LOGIC ===

async function uploadToSheets() {
    const uploadBtn = document.getElementById('upload-btn');
    const originalBtnText = uploadBtn.textContent;
    uploadBtn.textContent = 'Uploading...';
    uploadBtn.disabled = true;

    let spreadsheetId = (document.getElementById('spreadsheet-id').value.trim()) || DEFAULT_SPREADSHEET_ID;
    if (!spreadsheetId) {
        alert("Please enter a Spreadsheet ID or URL first in the automation section.");
        uploadBtn.textContent = originalBtnText;
        uploadBtn.disabled = false;
        return;
    }
    const match = spreadsheetId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (match) {
        spreadsheetId = match[1];
    }

    const sheetName = document.getElementById('sheet-name').value.trim();
    if (!sheetName) {
        alert("Please enter a Sheet Name.");
        uploadBtn.textContent = originalBtnText;
        uploadBtn.disabled = false;
        return;
    }

    try {
        const result = await new Promise(resolve => chrome.storage.local.get('orderData', resolve));
        const orderData = result.orderData || {};
        const allOrders = [];
        Object.values(orderData).forEach(storeData => {
            if (storeData.orders) {
                allOrders.push(...storeData.orders);
            }
        });

        if (allOrders.length === 0) {
            updateStatus('No parsed data to upload.', 'info');
            return;
        }

        // Format data for Sheets API: array of arrays
        const values = allOrders.map(o => [
            o.store_name || '',
            o.order_id || '',
            o.track_number || '',
            o.product_name || '',
            o.qty || '',
            o.color || '',
            o.size || ''
        ]);

        // Idempotency: read existing rows, update qty if changed, skip exact duplicates
        let existing = [];
        try {
            existing = await readSheetData(spreadsheetId, sheetName) || [];
        } catch (e) {
            console.warn('Could not read existing sheet for dedupe, will append all.', e);
        }

        const headerOffset = existing.length > 0 && existing[0].length > 1 && /store/i.test(existing[0][0] || '') ? 1 : 0;
        const existingRows = existing.slice(headerOffset);
        
        // Key WITHOUT qty: store + order + track + product
        const existingMap = new Map();
        existingRows.forEach((r, idx) => {
            const key = [r[0]||'', r[1]||'', r[2]||'', r[3]||''].join('\u0001');
            const existingQty = r[4] || '1';
            existingMap.set(key, { rowIndex: idx + headerOffset + 1, qty: existingQty });
        });
        
        const newValues = [];
        const rowsToUpdate = [];
        
        for (const r of values) {
            const key = [r[0], r[1], r[2], r[3]].join('\u0001');
            const newQty = r[4] || '1';
            
            if (existingMap.has(key)) {
                const existing = existingMap.get(key);
                if (existing.qty !== newQty) {
                    rowsToUpdate.push({ row: existing.rowIndex, qty: newQty }); // rowIndex already 1-based
                }
            } else {
                newValues.push(r);
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
        }

        if (newValues.length === 0 && rowsToUpdate.length === 0) {
            updateStatus('Nothing new to upload (all items already present).', 'info');
            uploadBtn.textContent = originalBtnText;
            uploadBtn.disabled = false;
            return;
        }
        
        if (newValues.length === 0) {
            updateStatus(`✅ Updated qty in ${rowsToUpdate.length} rows.`, 'success');
            uploadBtn.textContent = '✓ Updated!';
            setTimeout(() => { uploadBtn.textContent = originalBtnText; }, 3000);
            uploadBtn.disabled = false;
            return;
        }

        await writeDataToSheet(spreadsheetId, sheetName, newValues);

        const updatedMsg = rowsToUpdate.length > 0 ? `, updated qty in ${rowsToUpdate.length}` : '';
        updateStatus(`✅ Uploaded ${newValues.length} new items${updatedMsg}.`, 'success');
        uploadBtn.textContent = '✓ Uploaded!';
        setTimeout(() => {
            uploadBtn.textContent = originalBtnText;
        }, 3000);

    } catch (error) {
        console.error("Upload failed:", error);
        updateStatus(`Upload Error: ${error.message}`, 'error');
        uploadBtn.textContent = 'Upload Failed!';
    } finally {
        uploadBtn.disabled = false;
    }
}

// --- GOOGLE SHEETS SYNC LOGIC ---
async function startSync() {
    console.log("Starting sync with Google Sheets...");
    let spreadsheetId = document.getElementById('spreadsheet-id').value.trim();
    if (!spreadsheetId) {
        alert("Please enter a Spreadsheet ID or URL.");
        return;
    }

    const match = spreadsheetId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (match) {
        spreadsheetId = match[1];
        console.log(`Extracted Spreadsheet ID from URL: ${spreadsheetId}`);
    }

    // read toggles
    const skipProcessed = document.getElementById('skip-processed').checked;
    const colorProcessed = document.getElementById('color-processed').checked;
    const limitRows = document.getElementById('limit-rows').checked;

    try {
        updateStatus('Reading Google Sheet...', 'info');
        const sheetData = await readSheetData(spreadsheetId, "Лист1");
        console.log("Data from Google Sheet:", sheetData);
        if (sheetData && sheetData.length > 0) {
            updateStatus(`Read ${sheetData.length - 1} rows. Starting automation...`, 'success');
            
            chrome.runtime.sendMessage({
                action: "startPochtoyAutomation",
                data: sheetData,
                options: { spreadsheetId, sheetName: 'Лист1', skipProcessed, colorProcessed, limitRows }
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error("Error sending start message to background:", chrome.runtime.lastError.message);
                    updateStatus('Failed to start automation. See popup console.', 'error');
                } else {
                    console.log("Background script acknowledged start.", response);
                }
            });

        } else {
            updateStatus("Could not find any data in the sheet.", 'error');
        }
    } catch (error) {
        console.error("Failed to read Google Sheet:", error);
        updateStatus(`Error: ${error.message}. Check popup console.`, 'error');
    }
}

function resetMarks(){
    const spreadsheetIdInput = document.getElementById('spreadsheet-id');
    let spreadsheetId = (spreadsheetIdInput.value || '').trim();
    if (!spreadsheetId) return alert('Enter Spreadsheet ID or URL first.');
    const match = spreadsheetId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (match) spreadsheetId = match[1];

    chrome.runtime.sendMessage({ action: 'resetSheetMarks', options: { spreadsheetId, sheetName: 'Лист1' }}, (res)=>{
        if (chrome.runtime.lastError) {
            console.error('Reset marks error:', chrome.runtime.lastError.message);
            updateStatus('Failed to reset marks.', 'error');
        } else {
            updateStatus('Marks reset completed.', 'success');
        }
    });
}

// --- PROGRESS BAR LOGIC ---

// --- Listener for all messages from background scripts ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('📨 POPUP received message:', request.action, request);

    if (request.action === 'updatePopup') {
        updateCopyButtonState();
    } else if (request.action === 'progress') {
        console.log('📊 Progress update:', request.store, request.current, '/', request.total, request.status);
        updateStoreProgress(request.store, request.current, request.total, request.status, request.found);
    } else if (request.action === 'automationProgress') {
        updateAutomationProgress(request.data);
    } else if (request.action === 'allStoresCompleted') {
         updateStatus('🚀 Все магазины обработаны! Автозагрузка в Google Sheets...', 'info');
    } else if (request.action === 'uploadComplete') {
        updateStatus(request.message, request.status);
    } else if (request.action === 'complete') {
        // Aggregate summary for all stores
        chrome.storage.local.get('orderData', (result) => {
            const orderData = result.orderData || {};
            const ebay = orderData['eBay']?.orders?.length || 0;
            const iherb = orderData['iHerb']?.orders?.length || 0;
            const amazon = orderData['Amazon']?.orders?.length || 0;
            const total = ebay + iherb + amazon;
            updateStatus(`Готово. eBay: ${ebay}, iHerb: ${iherb}, Amazon: ${amazon}. Всего: ${total}`, 'success');
            const copyBtn = document.getElementById('copyToSheets');
            if (copyBtn) copyBtn.textContent = `📋 Copy ${total} items for Google Sheets`;
        });
    }
});

function updateStoreProgress(storeName, current, total, status, found) {
  const storeKey = storeName.toLowerCase();
  const multiProgress = document.getElementById('multiProgress');
  const progressBar = document.getElementById(`${storeKey}-progress-bar`);
  const progressText = document.getElementById(`${storeKey}-progress-text`);

  if (!progressBar || !progressText) return;

    if (multiProgress) multiProgress.style.display = 'block';

    const percent = total > 0 ? Math.min((current / total) * 100, 100) : 0;
  progressBar.style.width = `${percent}%`;
    const foundSuffix = (typeof found === 'number') ? ` — Найдено: ${found}` : '';
    progressText.textContent = (status || `${current}/${total}`) + foundSuffix;
    
    if ((percent >= 100) || status === "Done ✅" || status === "Error" || (current >= total && total > 0)) {
         progressBar.style.background = status === "Error" ? '#e53e3e' : '#28a745';
         progressText.style.color = status === "Error" ? '#e53e3e' : '#28a745';
  } else {
         progressBar.style.background = '#667eea';
         progressText.style.color = '#667eea';
    }
    // No storage write here - background handles it
}

function restoreProgressState() {
    chrome.storage.local.get(['progressState'], (result) => {
        if (!result.progressState) return;

        const progressState = result.progressState;
        let hasActiveProgress = false;

        // Correct store name mapping
        const storeNameMap = {
            'ebay': 'Ebay',
            'iherb': 'iHerb',
            'amazon': 'Amazon'
        };

        ['ebay', 'iherb', 'amazon'].forEach(storeKey => {
            const state = progressState[storeKey];
            // Keep report visible until Clear Data
            if (!state) return;

            hasActiveProgress = true;
            const storeName = storeNameMap[storeKey];
            updateStoreProgress(storeName, state.current, state.total, state.status, state.found);
        });

        const multiProgress = document.getElementById('multiProgress');
        if (hasActiveProgress && multiProgress) {
            multiProgress.style.display = 'block';
        }
    });
}

// REAL-TIME PROGRESS POLLING (check storage every second)
let progressPollingInterval = null;

function startProgressPolling() {
    if (progressPollingInterval) return; // Already running

    console.log('🔄 Starting real-time progress polling...');

    progressPollingInterval = setInterval(() => {
        restoreProgressState(); // Read from storage and update UI
    }, 1000); // Poll every 1 second
}

function stopProgressPolling() {
    if (progressPollingInterval) {
        clearInterval(progressPollingInterval);
        progressPollingInterval = null;
        console.log('⏹️ Stopped progress polling');
    }
}

// Start polling when popup opens
startProgressPolling();

// --- AUTOMATION UI LOGIC ---

function stopSync() {
    chrome.runtime.sendMessage({ action: "stopPochtoyAutomation" });
}

function restoreAutomationState() {
    chrome.storage.local.get('automationState', (result) => {
        if (result.automationState) {
            updateAutomationProgress(result.automationState);
        }
    });
}

function updateAutomationProgress(state) {
    const { isRunning, current, total, currentTask, summary, found } = state;
    
    const progressSection = document.getElementById('automation-progress-section');
    const startBtn = document.getElementById('start-sync-btn');
    const progressBar = document.getElementById('automation-progress-bar');
    const progressText = document.getElementById('automation-progress-text');
    const currentTaskEl = document.getElementById('automation-current-task');
    const progressLabelEl = document.getElementById('automation-progress-label');

    // Always show section during run or when summary exists
    if (isRunning || summary) {
        progressSection.style.display = 'block';
        startBtn.style.display = 'none';
    }

    if (!isRunning && !summary) { // Stopped or cleared explicitly
        progressSection.style.display = 'none';
        startBtn.style.display = 'block';
        return;
    }

    if (summary) { // Final report (persistent)
        progressLabelEl.textContent = `Завершено: ${summary.success} найдено, ${summary.failure} не найдено.`;
        currentTaskEl.textContent = `(Всего: ${summary.total})`;
        progressText.textContent = '';
        progressBar.style.width = '100%';
        progressBar.style.backgroundColor = summary.failure > 0 ? '#f6ad55' : '#48bb78';
        return; // keep summary visible
    }

    // In progress (instant feedback)
    const percent = total > 0 ? Math.min((current / total) * 100, 100) : 0;
    progressBar.style.width = `${percent}%`;
    const foundSuffix = typeof found === 'number' ? ` — Найдено: ${found}` : '';
    progressText.textContent = (total > 0 ? `${current}/${total}` : '') + foundSuffix;
    progressLabelEl.textContent = total > 0 ? 'Выполняется...' : 'Подготовка...';
    progressBar.style.backgroundColor = '#28a745';
    currentTaskEl.textContent = currentTask ? `Трек: ${currentTask.trackNumber}` : 'Подготовка...';
}
