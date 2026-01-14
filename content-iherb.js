console.log('🟢 iHerb content script loaded!', window.location.href);
console.log('📄 Page title:', document.title);
console.log('📄 Page HTML length:', document.body?.innerHTML?.length || 0);

// Debug: Check if page contains "Order #"
setTimeout(() => {
  const allText = document.body.innerText;
  const hasOrders = allText.includes('Order #');
  console.log('🔍 Page contains "Order #":', hasOrders);

  if (hasOrders) {
    // Find sample elements
    const orderElements = Array.from(document.querySelectorAll('*'))
      .filter(el => el.textContent.includes('Order #') && el.textContent.length < 500)
      .slice(0, 5);
    console.log('📦 Sample elements with "Order #":', orderElements.length);
    orderElements.forEach((el, i) => {
      console.log(`  [${i}] ${el.tagName}.${el.className}:`, el.textContent.substring(0, 100));
    });
  }
}, 2000);

// Check for auto-parse flag on page load
(async function checkAutoParse() {
  console.log('🔍 Checking for auto-parse flag...');

  const data = await chrome.storage.local.get(['autoParsePending', 'autoParse_iherb', 'autoParseTimestamp']);

  const shouldAutoParse = (data.autoParsePending === 'iherb') || data.autoParse_iherb;
  const timestamp = data.autoParseTimestamp || data.autoParse_iherb;

  const isRecent = timestamp && (Date.now() - timestamp < 10000);

  if (shouldAutoParse && isRecent) {
    console.log('✅ Auto-parse flag found! Starting parse in 2 seconds...');

    await chrome.storage.local.remove(['autoParsePending', 'autoParse_iherb', 'autoParseTimestamp']);

    setTimeout(() => {
      console.log('🚀 Starting auto-parse...');
      exportOrders();
    }, 2000);
  } else {
    console.log('ℹ️ No auto-parse flag (or expired)');
  }
})();

function checkIfLoggedIn() {
  console.log('🔐 Checking iHerb login status...');

  // Check if redirected to login page
  if (window.location.href.includes('/signin') || window.location.href.includes('/login')) {
    console.log('❌ On login page - user not logged in');
    return false;
  }

  // Check for order history elements
  const orderHistory = document.querySelector('.order-history-root, article[data-order-number]');
  const accountMenu = document.querySelector('[class*="account"], [class*="user-menu"]');
  const myAccountText = document.body.textContent.includes('My Account');

  const isLoggedIn = !!(orderHistory || accountMenu || myAccountText);

  console.log('🔐 Login check result:', {
    orderHistory: !!orderHistory,
    accountMenu: !!accountMenu,
    myAccountText: myAccountText,
    isLoggedIn: isLoggedIn
  });

  return isLoggedIn;
}

// Keep existing message listener as backup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('📨 Message received:', request);

  if (request.action === 'autoParse' || request.action === 'exportIherbOrders' || request.action === 'parseIherb') {
    console.log('🚀 Manual parse triggered');
    exportOrders()
      .then(result => {
        console.log('✅ Complete:', result.orders.length, 'orders');
        console.log(`📊 Stats: ${result.stats.addedCount} new, ${result.stats.updatedCount} updated`);
        sendResponse({
          success: true,
          orders: result.orders,
          stats: result.stats
        });
      })
      .catch(error => {
        console.error('❌ Export Error:', error);
        console.error('❌ Error stack:', error.stack);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

async function slowProgressiveScroll(limit = 76) {
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
    const maxScrollAttempts = 30; // Maximum 30 scroll attempts

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

    console.log('🧪 === IHERB PARSER (REAL STRUCTURE - Oct 2025) ===');
    console.log('🕐 Parse time:', new Date().toISOString());
    console.log('📍 Current URL:', window.location.href);

    // STEP 1: Find all order headers with pattern "Order #939168115"
    console.log('\n📦 STEP 1: Finding order headers...');
    const allElements = document.querySelectorAll('*');
    console.log(`  Scanning ${allElements.length} elements`);

    const orderHeaders = Array.from(allElements).filter(el => {
        const text = el.textContent || '';
        // Match "Order #" followed by 9-10 digits, but text should be relatively short
        return /Order\s+#\d{9,10}/.test(text) && text.length < 200;
    });

    console.log(`  ✅ Found ${orderHeaders.length} order header elements`);

    // Show sample headers for debugging
    orderHeaders.slice(0, 3).forEach((header, i) => {
        const match = header.textContent.match(/Order\s+#(\d{9,10})/);
        console.log(`    [${i}] Order #${match ? match[1] : 'N/A'} - ${header.tagName}.${header.className}`);
    });

    if (orderHeaders.length === 0) {
        console.error('❌ No order headers found!');

        // Debug: Check if page contains "Order #" at all
        const pageText = document.body.innerText;
        const hasOrderText = pageText.includes('Order #');
        console.log('  🔍 Page contains "Order #":', hasOrderText);

        if (hasOrderText) {
            const orderMatches = pageText.match(/Order\s+#\d{9,10}/g);
            console.log('  📋 Found in page text:', orderMatches?.slice(0, 5));
            console.log('  ⚠️ Pattern exists but elements not detected - try adjusting filter');
        }

        return orders;
    }

    // STEP 2: For each order header, find its container and extract products
    console.log('\n📦 STEP 2: Processing each order (limit: 76)...');

    const processedOrders = new Set();
    const MAX_ORDERS = 76;

    // Send initial processing progress
    chrome?.runtime?.sendMessage?.({
        action: 'progress',
        store: 'iHerb',
        current: 0,
        total: Math.min(orderHeaders.length, MAX_ORDERS),
        status: 'Processing orders...'
    });

    orderHeaders.forEach((header, headerIndex) => {
        // LIMIT: Stop at 25 orders
        if (processedOrders.size >= MAX_ORDERS) {
            console.log(`\n⏹️  Reached ${MAX_ORDERS} orders limit - stopping processing`);
            return;
        }

        // Extract order ID
        const orderMatch = header.textContent.match(/Order\s+#(\d{9,10})/);
        if (!orderMatch) return;

        const orderId = orderMatch[1];

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

        // Find order container by going up parent chain
        let orderContainer = header;

        // Try to find a good container - look for parent that might contain products
        // Try multiple strategies
        for (let i = 0; i < 10; i++) {
            if (!orderContainer.parentElement) break;
            orderContainer = orderContainer.parentElement;

            // Check if this container has product-like elements
            const hasQty = orderContainer.textContent.includes('Qty:');
            const hasProducts = orderContainer.querySelectorAll('img, a[href*="/pr/"]').length > 0;

            if (hasQty || hasProducts) {
                console.log(`    📦 Found container at level ${i}: ${orderContainer.tagName}.${orderContainer.className || '(no class)'}`);
                break;
            }
        }

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

        await slowProgressiveScroll(25);
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
