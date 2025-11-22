const stores = {
  'secure.iherb.com': { name: 'iHerb', action: 'exportIherbOrders' },
  'www.ebay.com': { name: 'eBay', action: 'exportEbayOrders' },
  'www.amazon.com': { name: 'Amazon', action: 'parseAmazonOrders' }
};

let currentStore = null;
let lastOrders = [];

// Initialize popup
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const url = new URL(tabs[0].url);
  currentStore = stores[url.hostname];

  document.getElementById('storeName').textContent = currentStore ? currentStore.name : 'Unsupported Page';
  document.getElementById('exportBtn').disabled = !currentStore;

  // Load last parsed stats
  if (currentStore) {
    loadStats();
  }
});

// Load statistics and orders from storage (store-specific)
function loadStats() {
  if (!currentStore) return;

  chrome.storage.local.get(['orderData'], (result) => {
    const storeData = result.orderData?.[currentStore.name];

    if (storeData) {
      document.getElementById('stats').style.display = 'block';

      // Show unique orders count with products hint
      const uniqueOrders = storeData.uniqueOrdersCount || 0;
      const totalProducts = storeData.totalProductsCount || storeData.totalOrders || 0;

      const orderCountEl = document.getElementById('orderCount');
      orderCountEl.innerHTML = `${uniqueOrders} orders<br><small style="font-size: 0.7em; opacity: 0.7;">(${totalProducts} products total)</small>`;

      document.getElementById('lastParsed').textContent = formatTimeAgo(storeData.lastParsed);

      // Load orders into memory
      if (storeData.orders && storeData.orders.length > 0) {
        lastOrders = storeData.orders;
        console.log('📦 Loaded', lastOrders.length, currentStore.name, 'orders from storage');
      }
    }
  });
}

// Format timestamp as "X minutes ago"
function formatTimeAgo(timestamp) {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
}

// Listen for progress updates from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'parsingProgress') {
    const { page, totalOrders } = request.data;
    updateProgress(page, totalOrders);
  }
});

// Update progress bar
function updateProgress(page, totalOrders) {
  const progressBar = document.getElementById('progressBar');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');

  progressBar.style.display = 'block';

  // Estimate progress (assuming max 10 pages)
  const progressPercent = Math.min((page / 10) * 100, 95);
  progressFill.style.width = progressPercent + '%';
  progressText.textContent = `Parsing... ${totalOrders} orders found (Page ${page})`;
}

// Export button click handler
document.getElementById('exportBtn').addEventListener('click', async () => {
  if (!currentStore) return;

  const btn = document.getElementById('exportBtn');
  const copyBtn = document.getElementById('copyBtn');
  const status = document.getElementById('status');
  const progressBar = document.getElementById('progressBar');
  const progressFill = document.getElementById('progressFill');

  btn.disabled = true;
  btn.textContent = '⏳ Starting...';
  status.style.display = 'none';
  progressBar.style.display = 'block';
  progressFill.style.width = '0%';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.tabs.sendMessage(tab.id, { action: currentStore.action }, (response) => {
    progressBar.style.display = 'none';

    if (response?.success) {
      lastOrders = response.orders;
      console.log('📦 Received', lastOrders.length, 'orders from content script');

      // Content script already saves to orderData[storeName], just update UI
      status.className = 'success';

      // Show merge statistics
      if (response.stats) {
        const { addedCount, updatedCount, uniqueOrdersCount } = response.stats;
        if (addedCount > 0 && updatedCount > 0) {
          status.textContent = `✅ Added ${addedCount} new, Updated ${updatedCount} existing (${uniqueOrdersCount} orders total)`;
        } else if (addedCount > 0) {
          status.textContent = `✅ Added ${addedCount} new orders (${uniqueOrdersCount} total)`;
        } else if (updatedCount > 0) {
          status.textContent = `✅ Updated ${updatedCount} existing orders (${uniqueOrdersCount} total)`;
        } else {
          status.textContent = `✅ No changes (${uniqueOrdersCount} orders total)`;
        }
      } else {
        // Fallback for old format
        status.textContent = `✅ Exported ${response.orders.length} orders!`;
      }

      status.style.display = 'block';

      // Update stats - reload from storage to get accurate counts
      loadStats();
    } else {
      status.className = 'error';
      status.textContent = '❌ Export failed: ' + (response?.error || 'Unknown error');
      status.style.display = 'block';
    }

    btn.disabled = false;
    btn.textContent = '📥 Export to CSV';
  });
});

// Copy for Google Sheets button
document.getElementById('copyBtn').addEventListener('click', async () => {
  const copyBtn = document.getElementById('copyBtn');
  const status = document.getElementById('status');

  // If no orders in memory, try to load from storage (current store only)
  if (!lastOrders || lastOrders.length === 0) {
    console.log('📦 No orders in memory, loading from storage...');

    if (!currentStore) {
      status.className = 'error';
      status.textContent = '⚠️ Please open this on a supported store page!';
      status.style.display = 'block';
      return;
    }

    const result = await new Promise(resolve => {
      chrome.storage.local.get(['orderData'], resolve);
    });

    const storeData = result.orderData?.[currentStore.name];
    if (storeData?.orders && storeData.orders.length > 0) {
      lastOrders = storeData.orders;
      console.log('✓ Loaded', lastOrders.length, currentStore.name, 'orders from storage');
    } else {
      status.className = 'error';
      status.textContent = '⚠️ No orders found. Please parse orders first!';
      status.style.display = 'block';
      console.log('❌ No', currentStore.name, 'orders in storage');
      return;
    }
  }

  console.log('📋 Copying', lastOrders.length, 'orders to clipboard');

  try {
    const sheetsData = formatForSheets(lastOrders);
    await navigator.clipboard.writeText(sheetsData);

    // Show success message
    const originalText = copyBtn.textContent;
    copyBtn.textContent = '✓ Copied to clipboard!';
    copyBtn.style.background = '#d4edda';
    copyBtn.style.color = '#155724';
    copyBtn.style.borderColor = '#155724';

    setTimeout(() => {
      copyBtn.textContent = originalText;
      copyBtn.style.background = '';
      copyBtn.style.color = '';
      copyBtn.style.borderColor = '';
    }, 2000);

    status.className = 'info';
    status.textContent = `📋 Copied ${lastOrders.length} orders! Ready to paste into Google Sheets.`;
    status.style.display = 'block';
  } catch (err) {
    status.className = 'error';
    status.textContent = '❌ Failed to copy to clipboard';
    status.style.display = 'block';
  }
});

// Copy & Open Google Sheets button
document.getElementById('copyAndOpenSheets').addEventListener('click', async () => {
  const status = document.getElementById('status');

  // If no orders in memory, try to load from storage (current store only)
  if (!lastOrders || lastOrders.length === 0) {
    console.log('📦 No orders in memory, loading from storage...');

    if (!currentStore) {
      status.className = 'error';
      status.textContent = '⚠️ Please open this on a supported store page!';
      status.style.display = 'block';
      return;
    }

    const result = await new Promise(resolve => {
      chrome.storage.local.get(['orderData'], resolve);
    });

    const storeData = result.orderData?.[currentStore.name];
    if (storeData?.orders && storeData.orders.length > 0) {
      lastOrders = storeData.orders;
      console.log('✓ Loaded', lastOrders.length, currentStore.name, 'orders from storage');
    } else {
      status.className = 'error';
      status.textContent = '⚠️ No orders found. Please parse orders first!';
      status.style.display = 'block';
      console.log('❌ No', currentStore.name, 'orders in storage');
      return;
    }
  }

  console.log('📊 Copying', lastOrders.length, 'orders and opening Google Sheets');

  try {
    // Create TSV data (tab-separated, no headers)
    const tsvData = formatForSheets(lastOrders);

    // Copy to clipboard
    await navigator.clipboard.writeText(tsvData);

    status.className = 'success';
    status.textContent = '✅ Copied! Opening Google Sheets...';
    status.style.display = 'block';

    // Open Google Sheets
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1w1QOzGWc_CNovlezuxyLta-h1kM3pgPXc_GoHYaOA98/edit#gid=0';
    chrome.tabs.create({ url: sheetUrl });

    // Show paste instruction after a delay
    setTimeout(() => {
      status.className = 'info';
      status.textContent = `📋 Now paste (Ctrl+V or Cmd+V) in the sheet! ${lastOrders.length} orders ready.`;
      status.style.display = 'block';
    }, 1000);

  } catch (err) {
    status.className = 'error';
    status.textContent = '❌ Failed to copy to clipboard';
    status.style.display = 'block';
    console.error('Clipboard error:', err);
  }
});

// Clear Data button
document.getElementById('clearData').addEventListener('click', async () => {
  if (!currentStore) {
    const status = document.getElementById('status');
    status.className = 'error';
    status.textContent = '⚠️ Please open this on a supported store page!';
    status.style.display = 'block';
    return;
  }

  const storeName = currentStore.name;
  const confirmation = confirm(`⚠️ Delete all ${storeName} orders?\n\nThis will permanently remove all stored data for ${storeName}.\n\nThis action cannot be undone!`);

  if (confirmation) {
    chrome.storage.local.get(['orderData'], (result) => {
      const orderData = result.orderData || {};

      // Remove store data
      delete orderData[storeName];

      chrome.storage.local.set({ orderData }, () => {
        // Clear UI
        lastOrders = [];
        document.getElementById('stats').style.display = 'none';
        document.getElementById('orderCount').textContent = '-';
        document.getElementById('lastParsed').textContent = 'Never';

        const status = document.getElementById('status');
        status.className = 'success';
        status.textContent = `🗑️ ${storeName} data cleared successfully`;
        status.style.display = 'block';

        console.log(`🗑️ Cleared all ${storeName} data from storage`);
      });
    });
  }
});

// Quick Launch functionality
document.querySelectorAll('.store-icon').forEach(icon => {
  icon.addEventListener('click', async () => {
    const store = icon.dataset.store;

    icon.classList.add('loading');
    const status = document.getElementById('status');
    status.className = 'info';
    status.textContent = `⏳ Opening ${store.toUpperCase()}...`;
    status.style.display = 'block';

    const storeUrls = {
      ebay: 'https://www.ebay.com/mye/myebay/purchase',
      iherb: 'https://secure.iherb.com/myaccount/orders',
      amazon: 'https://www.amazon.com/gp/your-account/order-history'
    };

    try {
      // Set auto-parse flag in storage BEFORE opening tab
      await chrome.storage.local.set({
        autoParsePending: store,
        autoParseTimestamp: Date.now()
      });

      // Open store page
      const tab = await chrome.tabs.create({
        url: storeUrls[store],
        active: true
      });

      icon.classList.remove('loading');
      status.className = 'success';
      status.textContent = `✅ Opening ${store.toUpperCase()}... Auto-parse will start`;
      status.style.display = 'block';

    } catch (error) {
      console.error('Quick launch error:', error);
      icon.classList.remove('loading');
      status.className = 'error';
      status.textContent = `❌ Error opening ${store}`;
      status.style.display = 'block';
    }
  });
});

// Parse All Stores functionality
document.getElementById('parseAllStores').addEventListener('click', async () => {
  const btn = document.getElementById('parseAllStores');
  btn.classList.add('loading');
  btn.textContent = '⏳ Opening stores...';

  const stores = [
    { name: 'ebay', url: 'https://www.ebay.com/mye/myebay/purchase' },
    { name: 'iherb', url: 'https://secure.iherb.com/myaccount/orders' },
    { name: 'amazon', url: 'https://www.amazon.com/gp/your-account/order-history' }
  ];

  try {
    const status = document.getElementById('status');
    status.className = 'info';
    status.textContent = '🚀 Opening all stores...';
    status.style.display = 'block';

    // Open all stores with auto-parse flags
    for (const store of stores) {
      await chrome.storage.local.set({
        [`autoParse_${store.name}`]: Date.now()
      });

      await chrome.tabs.create({
        url: store.url,
        active: false  // Open in background
      });

      // Small delay between opens
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    btn.classList.remove('loading');
    btn.textContent = '🚀 Parse All Stores';
    status.className = 'success';
    status.textContent = '✅ All stores opened! Auto-parsing...';
    status.style.display = 'block';

  } catch (error) {
    console.error('Parse all error:', error);
    btn.classList.remove('loading');
    btn.textContent = '🚀 Parse All Stores';
    const status = document.getElementById('status');
    status.className = 'error';
    status.textContent = '❌ Error opening stores';
    status.style.display = 'block';
  }
});

// Listen for login required messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'loginRequired') {
    const status = document.getElementById('status');
    status.className = 'error';
    status.textContent = request.message;
    status.style.display = 'block';
    alert(`${request.message}\n\nPlease login to ${request.store} and try again.`);
  }
});

// Format orders for Google Sheets (tab-separated, NO headers)
function formatForSheets(orders) {
  if (!orders || orders.length === 0) return '';

  // NO header row - user already has column headers in their sheet
  let output = '';

  // Add each order as a row (data only)
  orders.forEach(order => {
    const row = [
      order.store_name || '',
      order.order_id || '',
      order.track_number || '',
      order.product_name || '',
      order.qty || '',
      order.color || '',
      order.size || ''
    ];
    output += row.join('\t') + '\n';
  });

  return output;
}
