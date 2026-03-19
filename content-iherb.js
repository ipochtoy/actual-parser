/* content-iherb.js — v7.5.1 (Reliable auto-parse with retry fallback) */
console.log('🟢 iHerb Parser v7.5.1 loaded!', window.location.href);
console.log('📄 Page title:', document.title);
console.log('📄 Page HTML length:', document.body?.innerHTML?.length || 0);

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
      store: 'iHerb',
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

// Debug: Quick check if page contains "Order #" (lightweight version)
setTimeout(() => {
  const hasOrders = document.body?.innerText?.includes('Order #') || false;
  console.log('🔍 Page contains "Order #":', hasOrders);
}, 2000);

// Check for "Service unavailable" error and retry
// Returns: { isUnavailable: boolean, reason: string, debug: object }
function checkServiceUnavailable() {
  // Use lighter weight checks - avoid heavy DOM operations
  const pageText = document.body?.innerText || '';

  // Only get HTML length, not the full content (faster)
  const htmlLength = document.body?.innerHTML?.length || 0;

  const debug = {
    htmlLength: htmlLength,
    textLength: pageText.length,
    hasOrderHash: pageText.includes('Order #'),
    hasServiceUnavailable: pageText.includes('Service unavailable'),
    hasTryAgainLater: pageText.includes('Please try again later'),
    hasTemporarilyUnavailable: pageText.includes('temporarily unavailable'),
    title: document.title
  };

  console.log('🔍 Service check debug:', debug);

  // If page has orders, it's definitely working - ignore any "service unavailable" text
  if (debug.hasOrderHash) {
    console.log('✅ Page has orders - not treating as service unavailable');
    return { isUnavailable: false, reason: 'has_orders', debug };
  }

  // If HTML is very small (<10KB), it's likely an error page
  if (debug.htmlLength < 10000) {
    if (debug.hasServiceUnavailable || debug.hasTryAgainLater || debug.hasTemporarilyUnavailable) {
      return { isUnavailable: true, reason: 'small_page_with_error', debug };
    }
  }

  // If HTML is large but no orders found, might be loading issue - wait more
  if (debug.htmlLength > 100000 && !debug.hasOrderHash) {
    // Large page without orders - could be SPA still loading
    console.log('⚠️ Large page without orders - may need more time to load');
    return { isUnavailable: false, reason: 'large_page_loading', debug };
  }

  // Check for explicit error messages only on small/medium pages
  if (debug.hasServiceUnavailable || debug.hasTryAgainLater || debug.hasTemporarilyUnavailable) {
    return { isUnavailable: true, reason: 'error_text_found', debug };
  }

  return { isUnavailable: false, reason: 'no_errors', debug };
}

// Retry page reload with exponential backoff
async function retryOnServiceUnavailable(maxRetries = 3, baseDelay = 10000) {
  const storageKey = 'iherb_retry_count';
  const timestampKey = 'iherb_retry_timestamp';

  const data = await chrome.storage.local.get([storageKey, timestampKey, 'autoParsePending', 'autoParse_iherb', 'iherb_should_autoparse']);
  let retryCount = data[storageKey] || 0;
  const lastRetryTime = data[timestampKey] || 0;

  // Reset retry count if last retry was more than 5 minutes ago
  if (Date.now() - lastRetryTime > 5 * 60 * 1000) {
    retryCount = 0;
  }

  if (retryCount >= maxRetries) {
    console.log(`❌ Max retries (${maxRetries}) reached. Service still unavailable.`);
    await chrome.storage.local.remove([storageKey, timestampKey, 'iherb_should_autoparse']);

    // Log the failure
    await sendLog('-', '-', '❌ Service Unavailable', `Failed after ${maxRetries} retries`);

    // Notify background script about failure (so chain continues!)
    chrome.runtime.sendMessage({
      action: 'parseError',
      store: 'iHerb',
      error: 'Service unavailable after ' + maxRetries + ' retries'
    });

    return false;
  }

  // Preserve auto-parse flag for after reload (use dedicated flag that doesn't expire)
  const shouldAutoParse = data.autoParsePending === 'iherb' || data.autoParse_iherb || data.iherb_should_autoparse;

  retryCount++;
  const delay = baseDelay * retryCount; // 10s, 20s, 30s

  console.log(`⚠️ Service unavailable! Retry ${retryCount}/${maxRetries} in ${delay/1000}s...`);
  await sendLog('-', '-', '⚠️ Retry', `Service unavailable, retry ${retryCount}/${maxRetries}`);

  // Notify Telegram about retry
  chrome.runtime.sendMessage({
    action: 'addLog',
    store: 'iHerb',
    orderId: '-',
    trackNumber: '-',
    status: '⚠️ Retry',
    details: `Service unavailable, retry ${retryCount}/${maxRetries} in ${delay/1000}s`
  });

  // Save retry state with dedicated auto-parse flag (doesn't expire based on timestamp)
  await chrome.storage.local.set({
    [storageKey]: retryCount,
    [timestampKey]: Date.now(),
    // Use dedicated flag that persists across reloads
    iherb_should_autoparse: shouldAutoParse ? true : false
  });

  // Wait and reload
  setTimeout(() => {
    console.log('🔄 Reloading page...');
    window.location.reload();
  }, delay);

  return true; // Retry scheduled
}

// Check for auto-parse flag on page load (with retry for slow page loads)
(async function checkAutoParse() {
  console.log('🔍 Checking for auto-parse flag...');

  // Try up to 3 times with delays (page might load before flag is set)
  let shouldAutoParse = false;
  let retryAutoParse = false;
  let standardAutoParse = false;
  let isRecent = false;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const data = await chrome.storage.local.get(['autoParsePending', 'autoParse_iherb', 'autoParseTimestamp', 'iherb_should_autoparse']);

    retryAutoParse = data.iherb_should_autoparse === true;
    standardAutoParse = (data.autoParsePending === 'iherb') || data.autoParse_iherb;
    const timestamp = data.autoParseTimestamp || data.autoParse_iherb;
    // Increased timeout to 180 seconds (iHerb pages load slowly at night)
    isRecent = timestamp && (Date.now() - timestamp < 180000);

    shouldAutoParse = retryAutoParse || (standardAutoParse && isRecent);

    if (shouldAutoParse) {
      console.log(`✅ Auto-parse flag found on attempt ${attempt}!`);
      break;
    }

    if (attempt < 3) {
      console.log(`🔍 Attempt ${attempt}: No flag yet, waiting 3 seconds...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  if (!shouldAutoParse) {
    console.log('ℹ️ No auto-parse flag (or expired after 3 attempts) - skipping all checks');
    return; // Exit early - don't do any heavy operations if not needed
  }

  console.log(`   (retryFlag: ${retryAutoParse}, standardFlag: ${standardAutoParse}, isRecent: ${isRecent})`);

  // Clear flags early to prevent double-runs
  await chrome.storage.local.remove(['autoParsePending', 'autoParse_iherb', 'autoParseTimestamp', 'iherb_should_autoparse']);

  // Wait for React/SPA to fully load content
  console.log('⏳ Waiting 5 seconds for page to fully load...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Quick check if orders loaded
  const hasOrders = document.body?.innerText?.includes('Order #') || false;
  console.log('🔍 Quick check - has orders:', hasOrders);

  if (!hasOrders) {
    // Orders not loaded yet - wait more
    console.log('⏳ No orders yet, waiting 5 more seconds...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    const hasOrdersSecondCheck = document.body?.innerText?.includes('Order #') || false;
    console.log('🔍 Second check - has orders:', hasOrdersSecondCheck);

    if (!hasOrdersSecondCheck) {
      // Still no orders - check if it's a real error
      const pageText = document.body?.innerText || '';
      const isServiceError = pageText.includes('Service unavailable') ||
                             pageText.includes('Please try again later') ||
                             pageText.includes('temporarily unavailable');

      if (isServiceError) {
        console.log('⚠️ Service unavailable detected!');
        await sendLog('-', '-', '⚠️ Service Check', 'Service unavailable detected');
        const willRetry = await retryOnServiceUnavailable();
        if (willRetry) {
          return;
        }
      } else {
        // Just log the issue but continue anyway
        console.log('⚠️ No orders found after 10s wait, but no error - will try to parse anyway');
        await sendLog('-', '-', '⚠️ Warning', 'No orders after 10s wait, attempting parse anyway');
      }
    }
  }

  // Clear retry counter on successful load
  await chrome.storage.local.remove(['iherb_retry_count', 'iherb_retry_timestamp']);

  // Start parsing (with guard)
  if (isParsingInProgress) {
    console.log('⚠️ Parse already in progress (triggered by message?), skipping auto-parse');
    return;
  }
  isParsingInProgress = true;
  console.log('🚀 Starting auto-parse...');
  // Notify background that parsing actually started
  chrome.runtime.sendMessage({ action: 'parserStarted', store: 'iHerb' });
  exportOrders();
})();

function checkIfLoggedIn() {
  console.log('🔐 Checking iHerb login status...');

  // Check if redirected to login page
  if (window.location.href.includes('/signin') || window.location.href.includes('/login')) {
    console.log('❌ On login page - user not logged in');
    return false;
  }

  // Check for order history elements (lightweight selectors only)
  const orderHistory = document.querySelector('article[data-order-number]');
  const sidebar = document.querySelector('.my-account-sidebar, [class*="sidebar"]');

  // Check title instead of full body textContent (much faster)
  const isOrdersPage = document.title.includes('Orders') || window.location.pathname.includes('/orders');

  const isLoggedIn = !!(orderHistory || sidebar || isOrdersPage);

  console.log('🔐 Login check result:', {
    orderHistory: !!orderHistory,
    sidebar: !!sidebar,
    isOrdersPage: isOrdersPage,
    isLoggedIn: isLoggedIn
  });

  return isLoggedIn;
}

// Helper: Wait for orders to appear on page
async function waitForOrdersToLoad(maxWaitMs = 15000) {
  const startTime = Date.now();
  const checkInterval = 500;

  while (Date.now() - startTime < maxWaitMs) {
    const hasOrders = document.querySelector('article[data-order-number]') !== null;
    if (hasOrders) {
      console.log('✅ Orders found on page!');
      return true;
    }
    console.log('⏳ Waiting for orders to load...');
    await new Promise(r => setTimeout(r, checkInterval));
  }

  console.log('⚠️ Timeout waiting for orders');
  return false;
}

// Message listener for manual parse triggers (from popup or background)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('📨 Message received:', request);

  // Ping - respond immediately to confirm content script is alive
  if (request.action === 'ping') {
    console.log('🏓 Ping received - responding pong');
    sendResponse({ pong: true, store: 'iHerb' });
    return;
  }

  if (request.action === 'autoParse' || request.action === 'exportIherbOrders' || request.action === 'parseIherb') {
    // Guard: don't start if already parsing
    if (isParsingInProgress) {
      console.log('⚠️ Parse already in progress, ignoring duplicate trigger');
      sendResponse({ received: true, store: 'iHerb', alreadyParsing: true });
      return false;
    }
    isParsingInProgress = true;
    console.log('🚀 Manual parse triggered via message');

    // Respond IMMEDIATELY to confirm receipt (so popup knows script is alive)
    sendResponse({ received: true, store: 'iHerb' });

    // Notify background that parsing actually started
    chrome.runtime.sendMessage({ action: 'parserStarted', store: 'iHerb' });

    // Start parsing asynchronously
    waitForOrdersToLoad(15000).then(() => {
      return exportOrders();
    })
      .then(result => {
        console.log('✅ Complete:', result.orders.length, 'orders');
        console.log(`📊 Stats: ${result.stats.addedCount} new, ${result.stats.updatedCount} updated`);
      })
      .catch(error => {
        console.error('❌ Export Error:', error);
        console.error('❌ Error stack:', error.stack);
        // Notify background about error
        chrome.runtime.sendMessage({
          action: 'parseError',
          store: 'iHerb',
          error: error.message
        });
      });
    return false; // Don't keep channel open - we already responded
  }
});

async function slowProgressiveScroll(limit = 150) {
    console.log(`📜 Starting SLOW progressive scroll (limit: ${limit} orders)...`);
    console.log('⚠️  Scrolling slowly to avoid 429 errors - please wait!');

    // Send initial progress
    chrome?.runtime?.sendMessage?.({
        action: 'parsingProgress',
        data: {
            store: 'iHerb',
            current: 0,
            total: limit,
            status: 'Starting scroll...'
        }
    });

    let previousUniqueCount = 0;
    let noNewOrdersCount = 0;
    const maxNoNewChecks = 8;  // Increased from 5 to 8
    const scrollDelay = 3500;   // Increased from 2500 to 3500ms

    // Initial count - try to find orders by data-order-number attribute first
    const initialHeaders = document.querySelectorAll('article[data-order-number]');
    let initialCount = new Set(
        Array.from(initialHeaders).map(h => h.getAttribute('data-order-number'))
    ).size;

    // Fallback: count by "Order #" text if no data-order-number found
    if (initialCount === 0) {
        const pageText = document.body.innerText;
        const matches = pageText.match(/Order\s+#\d{9,10}/g);
        initialCount = matches ? new Set(matches).size : 0;
    }

    console.log(`📊 Starting with ${initialCount} orders visible`);

    let scrollAttempts = 0;
    const maxScrollAttempts = 60; // Increased from 30 to 60 scroll attempts

    while (scrollAttempts < maxScrollAttempts) {
        scrollAttempts++;

        // Count UNIQUE orders by data-order-number attribute
        const orderHeaders = document.querySelectorAll('article[data-order-number]');
        const uniqueOrderIds = new Set();

        orderHeaders.forEach(header => {
            const orderId = header.getAttribute('data-order-number');
            if (orderId) {
                uniqueOrderIds.add(orderId);
            }
        });

        let currentUniqueCount = uniqueOrderIds.size;

        // Fallback: count by "Order #" text if no data-order-number found
        if (currentUniqueCount === 0) {
            const pageText = document.body.innerText;
            const matches = pageText.match(/Order\s+#\d{9,10}/g);
            currentUniqueCount = matches ? new Set(matches).size : 0;
        }

        console.log(`📦 Loaded ${currentUniqueCount}/${limit} orders... scrolling (attempt ${scrollAttempts})`);

        // Send progress update
        chrome?.runtime?.sendMessage?.({
            action: 'parsingProgress',
            data: {
                store: 'iHerb',
                current: currentUniqueCount,
                total: limit,
                status: `Loading orders ${currentUniqueCount}/${limit}...`,
                found: currentUniqueCount
            }
        });

        // Check if we reached the limit
        if (currentUniqueCount >= limit) {
            console.log(`✅ Reached ${limit} orders limit!`);
            break;
        }

        // Check if new orders were loaded
        if (currentUniqueCount === previousUniqueCount) {
            noNewOrdersCount++;
            console.log(`  ⏸️  No new orders (${noNewOrdersCount}/${maxNoNewChecks} checks)`);

            if (noNewOrdersCount >= maxNoNewChecks) {
                console.log(`📊 Scroll complete: ${currentUniqueCount} orders loaded (no more orders available)`);
                console.log(`📈 Total scroll attempts: ${scrollAttempts}`);
                break;
            }
        } else {
            // New orders loaded - reset counter
            console.log(`  ✅ +${currentUniqueCount - previousUniqueCount} new orders loaded!`);
            noNewOrdersCount = 0;
        }

        previousUniqueCount = currentUniqueCount;

        // Scroll to bottom
        window.scrollTo(0, document.body.scrollHeight);

        // Wait longer for new orders to load
        await new Promise(resolve => setTimeout(resolve, scrollDelay));
    }

    console.log(`📊 Scroll complete: ${previousUniqueCount} orders loaded`);
    console.log(`📈 Total scroll attempts: ${scrollAttempts}`);
}

// Extract tracking number from DOM (buttons, links, hidden elements, HTML)
function extractTrackingFromDOM(orderContainer, orderId, isFirstOrder = false) {
    // Strategy 1: Look for "Track shipment" button or link
    const trackSelectors = [
        'a[href*="track"]',
        'a[href*="Track"]',
        'button[class*="track"]',
        'a[class*="track"]',
        '[data-tracking]',
        '[data-tracking-number]'
    ];

    for (const selector of trackSelectors) {
        const trackBtn = orderContainer.querySelector(selector);
        if (trackBtn) {
            if (isFirstOrder) {
                console.log('🔍 Found track button:', trackBtn.outerHTML.substring(0, 200));
                console.log('🔍 Button href:', trackBtn.getAttribute('href'));
                console.log('🔍 All data attributes:', trackBtn.dataset);
            }

            // Try data attributes
            if (trackBtn.dataset.tracking) return trackBtn.dataset.tracking;
            if (trackBtn.dataset.trackingNumber) return trackBtn.dataset.trackingNumber;
            if (trackBtn.dataset.trackingId) return trackBtn.dataset.trackingId;

            // Try href attribute
            const href = trackBtn.getAttribute('href');
            if (href) {
                // Extract tracking from URL params
                const urlMatch = href.match(/tracking[=\/]([A-Z0-9]+)/i);
                if (urlMatch) return urlMatch[1];

                // Extract tracking number patterns from href
                const trackingMatch = href.match(/94\d{20}|1Z[A-Z0-9]{16}|\d{12,14}/);
                if (trackingMatch) return trackingMatch[0];
            }

            // Try onclick attribute
            const onclick = trackBtn.getAttribute('onclick');
            if (onclick) {
                const trackingMatch = onclick.match(/94\d{20}|1Z[A-Z0-9]{16}|\d{12,14}/);
                if (trackingMatch) return trackingMatch[0];
            }
        }
    }

    // Strategy 2: Look for hidden elements with tracking info
    const hiddenSelectors = [
        '[class*="tracking"]',
        '[id*="tracking"]',
        '[class*="shipment"]',
        '.tracking-number',
        '#tracking-number'
    ];

    for (const selector of hiddenSelectors) {
        const element = orderContainer.querySelector(selector);
        if (element) {
            const text = element.textContent.trim();
            // Extract tracking number patterns
            const trackingMatch = text.match(/94\d{20}|1Z[A-Z0-9]{16}|\d{12,14}/);
            if (trackingMatch) return trackingMatch[0];
        }
    }

    // Strategy 3: Search order HTML for tracking patterns
    const orderHTML = orderContainer.innerHTML;
    const trackingPatterns = [
        /94\d{20}/,        // USPS (starts with 94)
        /1Z[A-Z0-9]{16}/,  // UPS
        /\d{12,14}/        // FedEx (12-14 digits)
    ];

    for (const pattern of trackingPatterns) {
        const match = orderHTML.match(pattern);
        if (match) {
            // Verify it's not part of an order number
            if (!match[0].startsWith('939')) { // iHerb orders start with 939
                return match[0];
            }
        }
    }

    // Strategy 4: Look in text content for "Tracking:" label
    const textContent = orderContainer.textContent;
    const trackingLabelMatch = textContent.match(/Tracking[:\s]+([A-Z0-9]{10,30})/i);
    if (trackingLabelMatch) return trackingLabelMatch[1];

    // Not found
    if (isFirstOrder) {
        console.log('⚠️  No tracking found in DOM for first order - will leave empty');
    }

    return '';
}

function parseOrders() {
    const orders = [];

    console.log('🧪 === IHERB PARSER (REAL STRUCTURE - Jan 2026) ===');
    console.log('🕐 Parse time:', new Date().toISOString());
    console.log('📍 Current URL:', window.location.href);

    // STEP 1: Find all order containers using article[data-order-number] (fast, specific selector)
    console.log('\n📦 STEP 1: Finding order containers...');

    // Primary method: Use data-order-number attribute (fast and reliable)
    let orderContainers = Array.from(document.querySelectorAll('article[data-order-number]'));
    console.log(`  Found ${orderContainers.length} articles with data-order-number`);

    // Fallback: If no articles found, try to extract from page text
    if (orderContainers.length === 0) {
        console.log('  ⚠️ No article elements found, trying text-based extraction...');

        // Get all order IDs from page text (fast regex on innerText)
        const pageText = document.body?.innerText || '';
        const orderMatches = pageText.match(/Order\s+#(\d{9,10})/g);

        if (orderMatches && orderMatches.length > 0) {
            console.log(`  📋 Found ${orderMatches.length} order references in text`);
            // Create pseudo-containers for each unique order
            const uniqueOrderIds = [...new Set(orderMatches.map(m => m.match(/\d{9,10}/)[0]))];
            console.log(`  📋 Unique orders: ${uniqueOrderIds.length}`);

            // For text-based extraction, we need to find elements differently
            // Look for elements containing specific order IDs
            uniqueOrderIds.slice(0, 150).forEach(orderId => {
                // Try to find a container for this order
                const selector = `[data-order-number="${orderId}"], [data-order-id="${orderId}"]`;
                const container = document.querySelector(selector);
                if (container) {
                    orderContainers.push(container);
                }
            });

            console.log(`  Found ${orderContainers.length} containers via ID lookup`);
        }
    }

    // Build orderHeaders array from containers for compatibility with rest of code
    const orderHeaders = orderContainers.map(container => {
        const orderId = container.getAttribute('data-order-number') ||
                       container.getAttribute('data-order-id') ||
                       (container.textContent.match(/Order\s+#(\d{9,10})/) || [])[1];
        return { element: container, orderId: orderId };
    }).filter(h => h.orderId);

    console.log(`  ✅ Found ${orderHeaders.length} order header elements`);

    // Show sample headers for debugging
    orderHeaders.slice(0, 3).forEach((header, i) => {
        console.log(`    [${i}] Order #${header.orderId}`);
    });

    if (orderHeaders.length === 0) {
        console.error('❌ No order headers found!');
        const hasOrderText = (document.body?.innerText || '').includes('Order #');
        console.log('  🔍 Page contains "Order #":', hasOrderText);
        return orders;
    }

    // STEP 2: For each order header, find its container and extract products
    console.log('\n📦 STEP 2: Processing each order (limit: 150)...');

    const processedOrders = new Set();
    const MAX_ORDERS = 150;

    // Send initial processing progress
    chrome?.runtime?.sendMessage?.({
        action: 'progress',
        store: 'iHerb',
        current: 0,
        total: Math.min(orderHeaders.length, MAX_ORDERS),
        status: 'Processing orders...'
    });

    orderHeaders.forEach((headerObj, headerIndex) => {
        // LIMIT: Stop at 76 orders
        if (processedOrders.size >= MAX_ORDERS) {
            console.log(`\n⏹️  Reached ${MAX_ORDERS} orders limit - stopping processing`);
            return;
        }

        // Extract order ID from our preprocessed object
        const orderId = headerObj.orderId;
        if (!orderId) return;

        // Skip duplicates
        if (processedOrders.has(orderId)) {
            console.log(`  ⏭️  Skipping duplicate Order #${orderId}`);
            return;
        }
        processedOrders.add(orderId);

        const isFirstOrder = processedOrders.size === 1;
        console.log(`\n  ✅ Processing Order #${orderId} (${processedOrders.size}/${MAX_ORDERS})`);

        // Send progress update
        chrome?.runtime?.sendMessage?.({
            action: 'progress',
            store: 'iHerb',
            current: processedOrders.size,
            total: Math.min(orderHeaders.length, MAX_ORDERS),
            status: `Processing order ${processedOrders.size}/${MAX_ORDERS}...`
        });

        // Use the element directly as container (it's already the article element)
        let orderContainer = headerObj.element;

        // Extract date if available
        const dateMatch = orderContainer.textContent.match(/Placed\s+on\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i);
        const orderDate = dateMatch ? convertDateToISO(dateMatch[1]) : '';
        if (orderDate) {
            console.log(`    📅 Date: ${orderDate}`);
        }

        // Extract tracking number from DOM (no API calls)
        let trackingNumber = '';
        const trackBtn = orderContainer.querySelector('a[href*="carrierTracking"]');
        if (trackBtn) {
            const href = trackBtn.getAttribute('href');
            const url = new URL(href, 'https://secure.iherb.com');
            trackingNumber = url.searchParams.get('trackingNumber') || '';
            console.log(`    🚚 Tracking: ${trackingNumber}`);
        } else {
            console.log('    ⚠️  No Track button (Fulfilling status)');
        }

        // STEP 3: Find all products in this order
        // Strategy: Look for elements with "Qty:" text
        console.log(`    🔍 Looking for products with "Qty:" pattern...`);

        const allContainerElements = orderContainer.querySelectorAll('*');
        const productElements = Array.from(allContainerElements).filter(el => {
            return /Qty:\s*\d+/.test(el.textContent);
        });

        console.log(`    📦 Found ${productElements.length} elements with "Qty:" pattern`);

        if (productElements.length === 0) {
            // Fallback: Look for product links
            console.log(`    🔄 Fallback: Looking for product links...`);
            const productLinks = orderContainer.querySelectorAll('a[href*="/pr/"]');
            console.log(`    🔗 Found ${productLinks.length} product links`);

            productLinks.forEach(link => {
                const productName = link.textContent.trim();
                if (!productName || productName.length < 10) return;

                console.log(`      ➕ ${productName.substring(0, 60)}...`);

                orders.push({
                    store_name: 'iHerb',
                    order_id: orderId,
                    track_number: trackingNumber, // Extracted from DOM
                    product_name: productName,
                    qty: 1, // Default to 1 if no Qty found
                    color: '',
                    size: ''
                });
                sendLog(orderId, trackingNumber, '✅ Found', productName.substring(0, 80));
            });
        } else {
            // Process elements with Qty
            const processedProducts = new Set();

            productElements.forEach(el => {
                // Extract quantity
                const qtyMatch = el.textContent.match(/Qty:\s*(\d+)/i);
                const qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;

                // Find product name - look for product link in this element or nearby
                let productName = '';

                // Strategy 1: Find <a> tag with /pr/ in href within this element
                const productLink = el.querySelector('a[href*="/pr/"]');
                if (productLink) {
                    productName = productLink.textContent.trim();
                }

                // Strategy 2: Look in parent/siblings
                if (!productName || productName.length < 10) {
                    let searchElement = el.parentElement;
                    for (let i = 0; i < 3; i++) {
                        if (!searchElement) break;
                        const link = searchElement.querySelector('a[href*="/pr/"]');
                        if (link) {
                            productName = link.textContent.trim();
                            break;
                        }
                        searchElement = searchElement.parentElement;
                    }
                }

                if (productName && productName.length >= 10) {
                    // Avoid duplicates
                    const productKey = `${orderId}-${productName}`;
                    if (processedProducts.has(productKey)) return;
                    processedProducts.add(productKey);

                    console.log(`      ➕ ${productName.substring(0, 60)}... (Qty: ${qty})`);

                    orders.push({
                        store_name: 'iHerb',
                        order_id: orderId,
                        track_number: trackingNumber, // Extracted from DOM
                        product_name: productName,
                        qty: qty,
                        color: '',
                        size: ''
                    });
                    sendLog(orderId, trackingNumber, '✅ Found', productName.substring(0, 80));
                }
            });
        }
    });

    // Filter out Fulfilling orders (no tracking number)
    const shippedOrders = orders.filter(order => {
        return order.track_number && order.track_number.trim() !== '';
    });

    const fulfillingCount = orders.length - shippedOrders.length;

    console.log(`\n🚚 FILTERING RESULTS:`);
    console.log(`  ✓ Total products extracted: ${orders.length}`);
    console.log(`  ✓ Shipped products (with tracking): ${shippedOrders.length}`);
    console.log(`  ✓ Fulfilling products (filtered out): ${fulfillingCount}`);

    const uniqueOrderIds = new Set(shippedOrders.map(o => o.order_id));
    console.log(`  ✓ Unique shipped orders: ${uniqueOrderIds.size}`);

    // FINAL STATISTICS
    console.log('\n📊 FINAL STATISTICS:');
    console.log(`  ✓ Order headers found: ${orderHeaders.length}`);
    console.log(`  ✓ Unique orders with tracking: ${uniqueOrderIds.size}`);
    console.log(`  ✓ Products being exported: ${shippedOrders.length}`);
    console.log(`  ✓ Average products per order: ${(shippedOrders.length / (uniqueOrderIds.size || 1)).toFixed(1)}`);

    // Send completion progress (with parsingProgress wrapper for background.js)
    chrome?.runtime?.sendMessage?.({
        action: 'parsingProgress',
        data: {
            store: 'iHerb',
            current: uniqueOrderIds.size,
            total: uniqueOrderIds.size,
            status: 'Done ✅', // Match eBay/Amazon format for auto-upload trigger
            found: shippedOrders.length
        }
    });

    if (shippedOrders.length === 0) {
        console.error('\n❌ NO SHIPPED ORDERS FOUND!');
        console.log('💡 All orders may be in "Fulfilling" status (no tracking yet)');
        console.log(`  Total orders found: ${orders.length}`);
        console.log(`  Orders without tracking: ${fulfillingCount}`);
    }

    return {
        success: true,
        orders: shippedOrders,
        uniqueOrdersCount: uniqueOrderIds.size,
        totalProductsCount: shippedOrders.length
    };
}

// Convert "October 04, 2025" to "2025-10-04"
function convertDateToISO(dateStr) {
    if (!dateStr) return '';

    try {
        const months = {
            'January': '01', 'February': '02', 'March': '03', 'April': '04',
            'May': '05', 'June': '06', 'July': '07', 'August': '08',
            'September': '09', 'October': '10', 'November': '11', 'December': '12'
        };

        // Match "October 04, 2025"
        const match = dateStr.match(/([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/);
        if (match) {
            const [, month, day, year] = match;
            const monthNum = months[month];
            if (!monthNum) return '';
            const dayPadded = day.padStart(2, '0');
            return `${year}-${monthNum}-${dayPadded}`;
        }

        return '';
    } catch (e) {
        return '';
    }
}

function downloadCSV(orders) {
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
    link.download = 'iherb_orders_' + new Date().toISOString().split('T')[0] + '.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// Smart deduplication: merge new orders with existing ones
async function saveOrdersWithDeduplication(newOrders, storeName) {
    return new Promise((resolve) => {
        chrome.storage.local.get(['orderData'], (result_storage) => {
            const orderData = result_storage.orderData || {};
            const storeData = orderData[storeName] || {};
            const existingOrders = storeData.orders || [];

            // Create map of existing orders by unique key (order_id + product_name)
            const existingMap = new Map();
            existingOrders.forEach(order => {
                const key = `${order.order_id}_${order.product_name}`;
                existingMap.set(key, order);
            });

            let addedCount = 0;
            let updatedCount = 0;

            // Merge new orders
            newOrders.forEach(newOrder => {
                const key = `${newOrder.order_id}_${newOrder.product_name}`;

                if (existingMap.has(key)) {
                    // Update existing (tracking might have changed)
                    existingMap.set(key, newOrder);
                    updatedCount++;
                } else {
                    // Add new
                    existingMap.set(key, newOrder);
                    addedCount++;
                }
            });

            // Convert map back to array
            const mergedOrders = Array.from(existingMap.values());

            // Calculate unique order count
            const uniqueOrderIds = new Set(mergedOrders.map(o => o.order_id));

            // Save to storage
            const timestamp = new Date().toISOString();
            orderData[storeName] = {
                orders: mergedOrders,
                lastParsed: timestamp,
                uniqueOrdersCount: uniqueOrderIds.size,
                totalProductsCount: mergedOrders.length
            };

            chrome.storage.local.set({ orderData }, () => {
                console.log(`💾 Storage updated: ${addedCount} new, ${updatedCount} updated, ${mergedOrders.length} total products`);
                console.log(`📊 Unique orders: ${uniqueOrderIds.size}`);
                // Notify popup to refresh UI (enables Copy buttons)
                try { chrome.runtime.sendMessage({ action: 'updatePopup' }); } catch (_) {}

                resolve({
                    addedCount,
                    updatedCount,
                    totalCount: mergedOrders.length,
                    uniqueOrdersCount: uniqueOrderIds.size
                });
            });
        });
    });
}

async function exportOrders() {
    try {
        console.log('🚀 exportOrders() started');
        console.log('📍 URL check:', window.location.href);
        console.log('📍 Expected URL pattern: https://secure.iherb.com/myaccount/orders*');

        // CHECK LOGIN FIRST
        if (!checkIfLoggedIn()) {
            console.log('❌ User not logged in!');
            chrome.runtime.sendMessage({
                action: 'loginRequired',
                store: 'iHerb',
                message: '⚠️ Please login to iHerb first!'
            });
            throw new Error('User not logged in to iHerb');
        }

        console.log('✅ User logged in, starting parse...');

        // Wait a bit for dynamic content to load
        console.log('⏳ Waiting for page to fully load...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        await slowProgressiveScroll(150);
        const result = parseOrders();

        if (!result.orders || result.orders.length === 0) {
            console.error('🛑 No orders parsed!');
            throw new Error('Found 0 orders. Check if you are on the correct iHerb orders page (secure.iherb.com/myaccount/orders)');
        }

        console.log(`✅ Parsed ${result.uniqueOrdersCount} orders (${result.totalProductsCount} products total)`);
        console.log('ℹ️  Tracking numbers extracted from DOM (when available)');

        // Save with deduplication
        const stats = await saveOrdersWithDeduplication(result.orders, 'iHerb');

        // AUTO-SAVE: Also save to iherbOrders for direct access
        chrome.storage.local.set({
            iherbOrders: result.orders,
            iherbLastUpdate: Date.now()
        });
        console.log('💾 Auto-saved to iherbOrders:', result.orders.length);

        // NO auto-download - user will use Copy button for Google Sheets
        // CSV download only via popup "Export to CSV" button if needed
        console.log('✅ Parse complete - data saved to storage (no auto-download)');

        // Return orders with stats for popup display
        return {
            orders: result.orders,
            stats: stats
        };
    } catch (error) {
        throw error;
    }
}

console.log('✅ iHerb parser ready!');
