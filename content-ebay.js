console.log('🔧 eBay Parser WITH PAGINATION loaded');

// Check for auto-parse flag on page load
(async function checkAutoParse() {
  console.log('🔍 Checking for auto-parse flag...');

  const data = await chrome.storage.local.get(['autoParsePending', 'autoParse_ebay', 'autoParseTimestamp']);

  // Check both old and new flag formats
  const shouldAutoParse = (data.autoParsePending === 'ebay') || data.autoParse_ebay;
  const timestamp = data.autoParseTimestamp || data.autoParse_ebay;

  // Only auto-parse if flag is recent (within last 10 seconds)
  const isRecent = timestamp && (Date.now() - timestamp < 10000);

  if (shouldAutoParse && isRecent) {
    console.log('✅ Auto-parse flag found! Starting parse in 2 seconds...');

    // Clear the flag
    await chrome.storage.local.remove(['autoParsePending', 'autoParse_ebay', 'autoParseTimestamp']);

    // Wait for page to fully load
    setTimeout(() => {
      console.log('🚀 Starting auto-parse...');
      parseEbayOrders();
    }, 2000);
  } else {
    console.log('ℹ️ No auto-parse flag (or expired)');
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

// Keep existing message listener as backup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('📨 Message received:', request);

  if (request.action === 'debugLogin') {
    console.log('🔍 Running login debug...');
    const result = checkIfLoggedIn();
    console.log('🔍 Login check result:', result);
    alert(`eBay Login Check: ${result ? 'LOGGED IN ✅' : 'NOT LOGGED IN ❌'}\n\nCheck console for details`);
    sendResponse({ success: true, isLoggedIn: result });
    return true;
  }

  if (request.action === 'autoParse' || request.action === 'exportEbayOrders' || request.action === 'parseEbay') {
    console.log('🚀 Parse triggered');
    parseEbayOrders()
      .then(orders => {
        console.log('✅ Complete:', orders.length, 'orders');
        sendResponse({ success: true, orders: orders });
      })
      .catch(error => {
        console.error('❌ Error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

async function parseEbayOrders() {
  console.log('🚀 parseEbayOrders() started');
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
  const MAX_PAGES = 10;

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

      const data = await response.json();
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
        size: size || ''
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
