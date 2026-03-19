/* content-ebay.js — v7.5.1 (Reliable auto-parse with retry fallback) */
console.log('🔧 eBay Parser v7.5.1 loaded');

let PARSE_MODE = 'warehouse'; // 'warehouse' or 'financial'
// Guard against double-parse (both flag + message could trigger)
let isParsingInProgress = false;

// Save log entry directly to storage
async function sendLog(orderId, trackNumber, status, details) {
  try {
    const timestamp = new Date().toLocaleString('ru-RU', { 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit',
      day: '2-digit',
      month: '2-digit'
    });
    
    const logEntry = {
      timestamp,
      store: 'eBay',
      orderId: orderId || '-',
      trackNumber: trackNumber || '-',
      status,
      details: details || ''
    };
    
    const result = await chrome.storage.local.get(['parsingLogs']);
    const logs = result.parsingLogs || [];
    logs.push(logEntry);
    await chrome.storage.local.set({ parsingLogs: logs });
  } catch (e) {
    console.error('Failed to save log:', e);
  }
}

// Check for auto-parse flag on page load
(async function checkAutoParse() {
  console.log('🔍 Checking for auto-parse flag...');

  const data = await chrome.storage.local.get(['autoParsePending', 'autoParse_ebay', 'autoParseTimestamp', 'ebay_should_autoparse']);

  // Check both old and new flag formats + dedicated retry flag
  const retryAutoParse = data.ebay_should_autoparse === true;
  const standardAutoParse = (data.autoParsePending === 'ebay') || data.autoParse_ebay;
  const timestamp = data.autoParseTimestamp || data.autoParse_ebay;

  // Increased timeout to 120 seconds (eBay pages load slowly)
  const isRecent = timestamp && (Date.now() - timestamp < 120000);

  const shouldAutoParse = retryAutoParse || (standardAutoParse && isRecent);

  if (shouldAutoParse) {
    console.log('✅ Auto-parse flag found! Starting parse in 3 seconds...');
    console.log(`   (retryFlag: ${retryAutoParse}, standardFlag: ${standardAutoParse}, isRecent: ${isRecent})`);

    // Clear the flag
    await chrome.storage.local.remove(['autoParsePending', 'autoParse_ebay', 'autoParseTimestamp', 'ebay_should_autoparse']);

    // Wait for page to fully load
    setTimeout(() => {
      if (isParsingInProgress) {
        console.log('⚠️ Parse already in progress (triggered by message?), skipping auto-parse');
        return;
      }
      isParsingInProgress = true;
      console.log('🚀 Starting auto-parse...');
      // Notify background that parsing actually started
      chrome.runtime.sendMessage({
        action: 'parserStarted',
        store: 'eBay'
      });
      parseEbayOrders();
    }, 3000);
  } else {
    console.log('ℹ️ No auto-parse flag (or expired)');
    console.log(`   (retryFlag: ${retryAutoParse}, standardFlag: ${standardAutoParse}, timestamp: ${timestamp}, isRecent: ${isRecent})`);
  }
})();

function checkIfLoggedIn() {
  console.log('🔐 Checking eBay login status...');
  console.log('📍 Current URL:', window.location.href);

  // If we're on the purchase history page itself, assume logged in
  if (window.location.href.includes('/mye/myebay/purchase')) {
    console.log('✅ On purchase history page - assuming logged in');
    return true;
  }

  // Check if explicitly on signin/login page (these are bad signs)
  if (window.location.href.includes('signin.ebay.com') ||
      window.location.href.includes('/signin') ||
      window.location.pathname === '/signin') {
    console.log('❌ On explicit signin page');
    return false;
  }

  // Look for multiple login indicators
  const indicators = {
    // Account dropdown in header
    accountMenu: document.querySelector('#gh-ug, [id*="gh-eb"], .gh-eb, [data-test-id*="account"]'),

    // User name display
    userName: document.querySelector('.gh-ug-guest, .gh-ug, [class*="username"]'),

    // Sign out link
    signOutBtn: document.querySelector('a[href*="signout"], a[href*="SignOut"]'),

    // My eBay link
    myEbayLink: document.querySelector('a[href*="myebay"]'),

    // Purchase history elements
    purchaseHistory: document.querySelector('.purchase-history, [class*="purchase"], [id*="purchase"]'),

    // Order cards
    orderCards: document.querySelector('[class*="order"], [data-test-id*="order"]'),

    // Check for "Sign in" button (if present, NOT logged in)
    signInButton: (() => {
      // Check href
      const byHref = document.querySelector('a[href*="signin"]');
      if (byHref) return byHref;

      // Check button text manually
      const buttons = document.querySelectorAll('button, a');
      for (const btn of buttons) {
        if (btn.textContent.trim().toLowerCase().includes('sign in')) {
          return btn;
        }
      }
      return null;
    })()
  };

  console.log('🔍 Login indicators found:', {
    accountMenu: !!indicators.accountMenu,
    userName: !!indicators.userName,
    signOutBtn: !!indicators.signOutBtn,
    myEbayLink: !!indicators.myEbayLink,
    purchaseHistory: !!indicators.purchaseHistory,
    orderCards: !!indicators.orderCards,
    signInButton: !!indicators.signInButton
  });

  // If we see explicit "Sign in" button, definitely not logged in
  if (indicators.signInButton) {
    console.log('❌ Found "Sign in" button - not logged in');
    return false;
  }

  // Count positive indicators
  const positiveCount = [
    indicators.accountMenu,
    indicators.userName,
    indicators.signOutBtn,
    indicators.myEbayLink,
    indicators.purchaseHistory,
    indicators.orderCards
  ].filter(Boolean).length;

  console.log(`📊 Positive indicators: ${positiveCount}/6`);

  // If we have at least 2 positive indicators, assume logged in
  if (positiveCount >= 2) {
    console.log('✅ Multiple indicators suggest user is logged in');
    return true;
  }

  // If on purchase page but no indicators, still try (page might be loading)
  if (window.location.href.includes('myebay')) {
    console.log('⚠️ On myebay page but few indicators - will try anyway');
    return true;
  }

  console.log('❌ Not enough evidence of login');
  return false;
}

// Message listener for manual parse triggers (from popup or background)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('📨 Message received:', request);

  // Ping - respond immediately to confirm content script is alive
  if (request.action === 'ping') {
    console.log('🏓 Ping received - responding pong');
    sendResponse({ pong: true, store: 'eBay' });
    return;
  }

  // SET MODE
  if (request.options && request.options.mode) {
      PARSE_MODE = request.options.mode;
      console.log(`ℹ️ SET PARSE_MODE = ${PARSE_MODE}`);
  }

  if (request.action === 'debugLogin') {
    console.log('🔍 Running login debug...');
    const result = checkIfLoggedIn();
    console.log('🔍 Login check result:', result);
    alert(`eBay Login Check: ${result ? 'LOGGED IN ✅' : 'NOT LOGGED IN ❌'}\n\nCheck console for details`);
    sendResponse({ success: true, isLoggedIn: result });
    return true;
  }

  if (request.action === 'autoParse' || request.action === 'exportEbayOrders' || request.action === 'parseEbay') {
    // Guard: don't start if already parsing
    if (isParsingInProgress) {
      console.log('⚠️ Parse already in progress, ignoring duplicate trigger');
      sendResponse({ received: true, store: 'eBay', alreadyParsing: true });
      return false;
    }
    isParsingInProgress = true;
    console.log('🚀 Parse triggered via message');

    // Respond IMMEDIATELY to confirm receipt (so popup knows script is alive)
    sendResponse({ received: true, store: 'eBay' });

    // Notify background that parsing actually started
    chrome.runtime.sendMessage({ action: 'parserStarted', store: 'eBay' });

    // Start parsing asynchronously
    parseEbayOrders()
      .then(orders => {
        console.log('✅ Complete:', orders.length, 'orders');
      })
      .catch(error => {
        console.error('❌ Error:', error);
        // Notify background about error
        chrome.runtime.sendMessage({
          action: 'parseError',
          store: 'eBay',
          error: error.message
        });
      });
    return false; // Don't keep channel open - we already responded
  }
});

async function parseEbayOrders() {
  console.log(`🚀 parseEbayOrders() started (Mode: ${PARSE_MODE})`);
  console.log('📍 Current URL:', window.location.href);

  // Wait a bit for page to fully load
  await new Promise(resolve => setTimeout(resolve, 1000));

  // CHECK LOGIN
  const isLoggedIn = checkIfLoggedIn();

  if (!isLoggedIn) {
    console.log('⚠️ Login check failed');

    // Double-check: wait 2 more seconds and try again
    console.log('⏳ Waiting 2 seconds and rechecking...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    const isLoggedInRetry = checkIfLoggedIn();

    if (!isLoggedInRetry) {
      console.log('❌ Still not logged in after retry');
      chrome.runtime.sendMessage({
        action: 'loginRequired',
        store: 'eBay',
        message: '⚠️ Please login to eBay first!'
      });
      throw new Error('User not logged in to eBay');
    } else {
      console.log('✅ Retry succeeded - user is logged in');
    }
  } else {
    console.log('✅ User logged in, starting parse...');
  }

  // Continue with existing export logic
  console.log('⏳ Waiting for page to fully load...');
  await new Promise(resolve => setTimeout(resolve, 1000));

  const year = new Date().getFullYear();
  let allOrders = [];
  let page = 1;
  let hasMore = true;
  const MAX_PAGES = 40;

  try {
    while (hasMore && page <= MAX_PAGES) {
      console.log(`📄 Page ${page}...`);

      // Send progress update to popup (old format for backward compat)
      chrome.runtime.sendMessage({
        action: 'parsingProgress',
        data: { page, totalOrders: allOrders.length }
      });

      // NEW: Send multi-store progress
      chrome.runtime.sendMessage({
        action: 'progress',
        store: 'eBay',
        current: page,
        total: MAX_PAGES,
        status: `Page ${page}/${MAX_PAGES} - ${allOrders.length} orders`,
        found: allOrders.length
      });

      const url = `https://www.ebay.com/mye/myebay/ajax/v2/purchase/mp/get?filter=year_filter:${year}&page=${page}&modules=ALL_TRANSACTIONS&moduleId=122164&pg=purchase&mp=purchase-module-v2`;

      const response = await fetch(url, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });

      // Check if response is valid JSON before parsing
      const responseText = await response.text();

      // Handle eBay upstream errors (temporary server issues)
      if (responseText.includes('upstream connect error') || responseText.includes('error') && responseText.length < 200) {
        console.warn(`⚠️ eBay API error on page ${page}: ${responseText.substring(0, 100)}`);
        sendLog('-', '-', '⚠️ API Error', `Page ${page}: ${responseText.substring(0, 50)}`);
        // Retry this page after a delay
        if (page <= 2) {
          console.log('⏳ Retrying page in 3 seconds...');
          await new Promise(r => setTimeout(r, 3000));
          continue; // Retry same page
        }
        // For later pages, just skip and continue
        page++;
        continue;
      }

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error(`❌ JSON parse error on page ${page}:`, responseText.substring(0, 100));
        sendLog('-', '-', '❌ Parse Error', `Page ${page}: Invalid JSON response`);
        page++;
        continue; // Skip this page
      }

      let items = data.modules?.RIVER?.[0]?.data?.items || data.data?.modules?.RIVER?.[0]?.data?.items;

      if (!items || items.length === 0) {
        console.log(`📭 No more items on page ${page}`);
        hasMore = false;
      } else {
        consecutiveEmptyPages = 0;
        console.log(`📦 Found ${items.length} items`);

        const orders = items.flatMap((item, index) => {
          try {
            const parsed = parseItem(item);
            if (!parsed) return [];
            return Array.isArray(parsed) ? parsed : [parsed];
          } catch (error) {
            console.warn(`⚠️  Skipping broken order at page ${page}, item ${index}:`, error.message);
            return [];
          }
        });

        console.log(`✅ Parsed ${orders.length} orders`);
        // Send logs for each order
        orders.forEach(o => {
          const status = o.track_number ? '✅ Found' : '⚠️ No track';
          sendLog(o.order_id, o.track_number || '-', status, o.product_name?.substring(0, 80) || '');
        });
        allOrders = allOrders.concat(orders);

        // Send updated count
        chrome.runtime.sendMessage({
          action: 'parsingProgress',
          data: { page, totalOrders: allOrders.length }
        });
      }

      if (items && items.length < 20) {
        hasMore = false;
      } else {
        page++;
        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log(`📊 TOTAL: ${allOrders.length} orders`);

    // Save orders to storage (store-specific)
    const timestamp = new Date().toISOString();
    chrome.storage.local.get(['orderData'], (result) => {
      const orderData = result.orderData || {};

      orderData['eBay'] = {
        orders: allOrders,
        lastParsed: timestamp,
        totalOrders: allOrders.length
      };

      chrome.storage.local.set({ orderData });
      console.log('💾 Saved eBay data to storage');
      // Notify popup to refresh UI states (copy buttons etc.)
      chrome.runtime.sendMessage({ action: 'updatePopup' });
    });

    // AUTO-SAVE: Also save to ebayOrders for direct access
    chrome.storage.local.set({
      ebayOrders: allOrders,
      ebayLastUpdate: Date.now()
    });
    console.log('💾 Auto-saved to ebayOrders:', allOrders.length);

    // Send completion progress
    chrome.runtime.sendMessage({
      action: 'progress',
      store: 'eBay',
      current: MAX_PAGES,
      total: MAX_PAGES,
      status: 'Done ✅', // Explicit 'Done ✅' for background.js to detect completion
      found: allOrders.length
    });

    // Check if we found any orders
    if (allOrders.length === 0) {
      throw new Error('Found 0 orders. Check if you are on the correct eBay page (www.ebay.com/mye/myebay/purchase) and have orders for this year.');
    }

    // NO auto-download - user will use Copy button for Google Sheets
    // CSV download only via popup "Export to CSV" button if needed
    console.log('✅ Parse complete - data saved to storage (no auto-download)');
    return allOrders;

  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  }
}

function parseItem(item) {
  try {
    let financial = {};
    // --- FINANCIAL MODE EXTRACTION ---
    if (PARSE_MODE === 'financial') {
        console.log('💰 [FINANCIAL DEBUG] Raw eBay Item:', item);
        
        // Try to find totals
        if (item.pricingSummary) {
            const ps = item.pricingSummary;
            financial.total_amount = ps.total?.value || ps.total?.text;
            financial.subtotal = ps.priceSubtotal?.value || ps.priceSubtotal?.text;
            financial.shipping = ps.deliveryCost?.value || ps.deliveryCost?.text;
            financial.tax = ps.tax?.value || ps.tax?.text; // Sometimes available
        } else if (item.totalPrice) {
            financial.total_amount = item.totalPrice.value || item.totalPrice.text;
        }
        
        console.log('💰 Extracted Financial:', financial);
    }
    // ----------------------------

    const cards = Array.isArray(item?.itemCards) ? item.itemCards : (item?.itemCards ? [item.itemCards] : []);
    if (cards.length === 0) return null;

    const firstCard = cards[0];
    const params = firstCard?.__myb?.actionList?.[0]?.action?.params || {};

    const name = firstCard?.title?.textSpans?.[0]?.text || 'Unknown';
    let size = '', color = '';

    if (firstCard?.aspectValuesList) {
      for (const asp of firstCard.aspectValuesList) {
        const txt = asp?.textSpans?.[0]?.text || '';
        if (txt.toLowerCase().includes('size:')) size = txt.replace(/^size:\s*/i, '').trim();
        else if (txt.toLowerCase().includes('color:')) color = txt.replace(/^colou?r:\s*/i, '').trim();
      }
    }

    const cleanName = name
      .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(d));

    // Extract order number
    let orderId = 'N/A';

    // Extract from secondaryMessage
    if (Array.isArray(item.secondaryMessage)) {
      for (let i = 0; i < item.secondaryMessage.length; i++) {
        const display = item.secondaryMessage[i];
        const text = display?.textSpans?.[0]?.text || '';

        // Extract order number
        if (orderId === 'N/A' && text.match(/Order number:/i)) {
          if (i + 1 < item.secondaryMessage.length) {
            const nextDisplay = item.secondaryMessage[i + 1];
            const orderNumberText = nextDisplay?.textSpans?.[0]?.text || '';
            if (orderNumberText.match(/^\d{2}-\d{5}-\d{5}$/)) {
              orderId = orderNumberText;
              break;  // Found order number, stop searching
            }
          }
        }
      }
    }

    // Fallback to transactionId if order number not found
    if (orderId === 'N/A' && params.transactionId) {
      orderId = params.transactionId;
    }

    // Find tracking number robustly (covers Delivered/Combined cases)
    const pickBestTracking = (text) => {
      if (!text) return '';
      try {
        const up = String(text).toUpperCase();
        // Priority 1: UPS exact 18 chars
        const ups = up.match(/\b(1Z[0-9A-Z]{16})\b/);
        if (ups) return ups[1];
        // Priority 2: USPS numeric starting 92..96 (20-26 digits)
        const usps = up.match(/\b(9[2-6]\d{18,24})\b/);
        if (usps) return usps[1];
        // Priority 3: Yanwen YT
        const yanwen = up.match(/\b(YT\d{10,25})\b/);
        if (yanwen) return yanwen[1];
        // Priority 4: UPU format
        const upu = up.match(/\b([A-Z]{2}\d{9}[A-Z]{2})\b/);
        if (upu) return upu[1];
      } catch (_) {}
      return '';
    };

    const extractTracking = () => {
      // 1) From any actionList entry in card
      const actions = (firstCard?.__myb?.actionList || []).concat(item?.__myb?.actionList || []);
      for (const a of actions) {
        const tn = a?.action?.params?.trackingNumber;
        const best = pickBestTracking(tn);
        if (best) return best;
      }
      // 1b) Shallow search for typical fields (safe subset)
      const typical = [
        item?.trackingNumber,
        item?.shipmentTrackingNumber,
        item?.packageTrackingNumber,
        firstCard?.trackingNumber
      ];
      for (const v of typical) {
        const best = pickBestTracking(v);
        if (best) return best;
      }
      // 2) From params
      {
        const best = pickBestTracking(params?.trackingNumber);
        if (best) return best;
      }
      return '';
    };
    const trackingNumber = extractTracking();
    if (!trackingNumber) return null; // skip items without a real tracking number

    // Build entries for all items in Multiple items
    const entries = cards.map(card => {
      let quantity = 1;
      if (typeof card?.quantity === 'number') quantity = card.quantity;
      else if (params?.quantity) quantity = parseInt(params.quantity, 10) || quantity;
      else if (card?.aspectValuesList) {
        for (const asp of card.aspectValuesList) {
          const t = (asp?.textSpans?.[0]?.text || '').toLowerCase();
          const m = t.match(/\b(quantity|qty)\s*[:x]?\s*(\d{1,3})/i);
          if (m) { quantity = parseInt(m[2], 10) || quantity; break; }
        }
      }

      const title = (card?.title?.textSpans?.[0]?.text || cleanName)
        .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(d));

      return {
        store_name: 'eBay',
        order_id: orderId,
        track_number: trackingNumber || '',
        product_name: title,
        qty: quantity,
        color: color || '',
        size: size || '',
        financial: financial, // Add financial object
        total_amount: financial.total_amount // Add for direct access
      };
    });

    return entries;
  } catch (e) {
    console.error('❌ parseItem error:', e);
    return null;
  }
}

function downloadCSV(orders) {
  if (!orders || orders.length === 0) return;

  const headers = ['store_name', 'order_id', 'track_number', 'product_name', 'qty', 'color', 'size'];
  let csv = headers.join(',') + '\n';

  orders.forEach(o => {
    const row = headers.map(h => {
      let v = o[h] || '';
      v = String(v);
      if (v.includes(',') || v.includes('"')) v = '"' + v.replace(/"/g, '""') + '"';
      return v;
    });
    csv += row.join(',') + '\n';
  });

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `ebay_orders_${new Date().toISOString().split('T')[0]}.csv`;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  console.log('✅ CSV downloaded');
}

// Format orders for Google Sheets (tab-separated)
function formatForSheets(orders) {
  if (!orders || orders.length === 0) return '';

  const headers = ['Order ID', 'Date', 'Total', 'Products'];
  let output = headers.join('\t') + '\n';

  // Group by order_id
  const orderGroups = {};
  orders.forEach(o => {
    if (!orderGroups[o.order_id]) {
      orderGroups[o.order_id] = {
        order_id: o.order_id,
        order_date: o.order_date,
        total: o.price,
        products: []
      };
    }
    orderGroups[o.order_id].products.push(`${o.product_name} (x${o.qty})`);
  });

  Object.values(orderGroups).forEach(order => {
    const row = [
      order.order_id,
      order.order_date,
      order.total,
      order.products.join(', ')
    ];
    output += row.join('\t') + '\n';
  });

  return output;
}

console.log('✅ eBay parser ready');
