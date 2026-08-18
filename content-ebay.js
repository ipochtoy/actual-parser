/* content-ebay.js — v7.8.0 (owned nightly run with durable completion) */
console.log('🔧 eBay Parser v7.8.0 loaded');

// Silence the benign MV3 console flood during long scans. Fire-and-forget
// chrome.runtime.sendMessage() calls (progress/parserStarted/updatePopup)
// reject when the idle service worker isn't listening ("message channel
// closed" / "Receiving end does not exist"). Those rejections are harmless —
// the parse still completes — but they spam the console red and look like the
// parser crashed. Swallow ONLY that specific class; everything else surfaces.
self.addEventListener('unhandledrejection', (e) => {
  const msg = e?.reason?.message || String(e?.reason || '');
  if (/message channel closed|Receiving end does not exist|Extension context invalidated/i.test(msg)) {
    e.preventDefault();
  }
});

let PARSE_MODE = 'warehouse'; // 'warehouse' or 'financial'
// Guard against double-parse (both flag + message could trigger)
let isParsingInProgress = false;

// eBay account email (single account in this extension). Preloaded by
// parseEbayOrders() before calling parseItem() so every row carries it.
let __ebayAccountName = '';
let __ebayRunId = null;
let __ebayScreenshotQueueCommits = [];
// CANCELLED / REFUNDED orders caught this run (money-safety) — reset at parse start,
// persisted to storage `ebayCancelledOrders` at the end for the background night report.
let __ebayCancelledOrders = [];

// Collect display (human-visible) text spans from an eBay feed item — status labels
// live in secondaryMessage / primaryMessage / title, NOT in action buttons (actionList).
function ebayItemDisplayText(item) {
  const out = [];
  const pushDisplays = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const d of arr) {
      const ts = d?.textSpans;
      if (Array.isArray(ts)) for (const s of ts) if (s && s.text) out.push(String(s.text));
    }
  };
  pushDisplays(item?.secondaryMessage);
  pushDisplays(item?.primaryMessage);
  if (item?.title?.textSpans) pushDisplays([item.title]);
  for (const k of ['status', 'orderStatus', 'statusMessage', 'shippingStatus']) {
    const v = item && item[k];
    if (typeof v === 'string') out.push(v);
    else if (v && v.textSpans) pushDisplays([v]);
  }
  return out;
}

// Detect a cancelled/refunded eBay purchase from the already-fetched feed item.
// Start-anchored on the status word to avoid "eligible for refund" / "return window"
// false positives. Reads only data eBay already sent — zero extra network hits.
function detectEbayCancelled(item) {
  for (const t of ebayItemDisplayText(item)) {
    if (/^(cancell?ed|order\s+cancell?ed|refunded|refund\s+issued)\b/i.test((t || '').trim())) {
      return { cancelled: true, status_text: (t || '').trim().slice(0, 60) };
    }
  }
  return { cancelled: false };
}

async function getEbayAccount() {
  try {
    const r = await chrome.storage.local.get(['accountsConfig']);
    const cfg = r.accountsConfig;
    if (cfg && cfg.ebay && cfg.ebay[0]) return cfg.ebay[0].email || '';
    return '';
  } catch (_) {
    return '';
  }
}

function normalizeEbayAccount(value) {
  return String(value || '').trim().toLowerCase();
}

async function captureEbayParserContext(fallbackAccount = '') {
  const door = await chrome.runtime.sendMessage({ action: 'getParserContext', store: 'ebay' }).catch(() => null);
  if (door?.active && !door.owned) {
    throw new Error('eBay pipeline context belongs to a different tab');
  }
  if (door?.owned) {
    if (normalizeEbayAccount(door.account) !== normalizeEbayAccount(fallbackAccount)) {
      throw new Error('eBay account does not match the configured pipeline account');
    }
    return { runId: door.runId, account: door.account, parserTabId: door.tabId, standalone: false };
  }
  return { runId: null, account: fallbackAccount, parserTabId: null, standalone: true };
}

async function verifyEbayParserContext(context) {
  const fresh = await chrome.storage.local.get(['pipelineRun', 'pipelineStage']);
  if (!context.runId) {
    if (['starting', 'running'].includes(fresh.pipelineRun?.status)) {
      throw new Error('standalone eBay parse overlapped a pipeline run');
    }
    return true;
  }
  const valid = fresh.pipelineRun?.id === context.runId
    && ['starting', 'running'].includes(fresh.pipelineRun?.status)
    && fresh.pipelineStage?.active === true
    && fresh.pipelineStage?.runId === context.runId
    && fresh.pipelineStage?.stages?.[fresh.pipelineStage?.currentIndex] === 'ebay'
    && normalizeEbayAccount(fresh.pipelineRun?.expected?.ebay?.[0])
      === normalizeEbayAccount(context.account);
  if (!valid) throw new Error('stale eBay run/account before commit');
  return true;
}

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
      parseEbayOrders().catch(error => {
        chrome.runtime.sendMessage({
          action: 'parseError', store: 'eBay', error: error.message,
          runId: __ebayRunId, account: __ebayAccountName
        }).catch(() => {});
      });
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
          error: error.message,
          runId: __ebayRunId,
          account: __ebayAccountName
        });
      });
    return false; // Don't keep channel open - we already responded
  }
});

async function parseEbayOrders() {
  console.log(`🚀 parseEbayOrders() started (Mode: ${PARSE_MODE})`);
  __ebayCancelledOrders = []; // fresh per run
  __ebayScreenshotQueueCommits = [];
  console.log('📍 Current URL:', window.location.href);

  // Resolve eBay account_name BEFORE we call parseItem() so every row
  // carries it. eBay has only one account in this extension.
  __ebayAccountName = await getEbayAccount();
  const parserContext = await captureEbayParserContext(__ebayAccountName);
  __ebayAccountName = parserContext.account || __ebayAccountName;
  __ebayRunId = parserContext.runId;
  if (parserContext.runId) {
    chrome.runtime.sendMessage({
      action: 'parserStarted', store: 'eBay',
      runId: parserContext.runId, account: parserContext.account
    }).catch(() => {});
  }
  console.log(`👤 eBay account_name: ${__ebayAccountName || '(empty)'}`);

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
  // Per-page retry on transient errors (invalid JSON / upstream error). eBay
  // rate-limits the rapid multi-page fetch and returns non-JSON for a page;
  // the old code silently skipped that whole page (26 orders lost — e.g. order
  // 24-14770-78524 vanished when page 8 came back as invalid JSON). Now we retry
  // the SAME page with backoff before giving up, for ALL pages (not just ≤2).
  const MAX_PAGE_RETRIES = 4;
  let pageAttempt = 0;

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

      // Hard timeout: a hung page fetch (eBay sometimes stalls the connection) must
      // not freeze the whole scan forever with no log. Abort at 20s and retry the page.
      let responseText;
      {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 20000);
        try {
          const response = await fetch(url, {
            credentials: 'include',
            headers: { 'Accept': 'application/json' },
            signal: ac.signal
          });
          responseText = await response.text();
        } catch (netErr) {
          if (pageAttempt < MAX_PAGE_RETRIES) {
            pageAttempt++;
            const backoff = 2000 * pageAttempt;
            console.warn(`⏳ Page ${page} fetch failed (${netErr.name}) — retry ${pageAttempt}/${MAX_PAGE_RETRIES} in ${backoff}ms`);
            sendLog('-', '-', '⚠️ Fetch timeout (retry)', `Page ${page} attempt ${pageAttempt}/${MAX_PAGE_RETRIES}`);
            await new Promise(r => setTimeout(r, backoff));
            continue;
          }
          console.error(`❌ Page ${page} fetch failed ${MAX_PAGE_RETRIES}x (${netErr.name}) — skipping`);
          sendLog('-', '-', '❌ Page LOST', `Page ${page}: fetch failed ${MAX_PAGE_RETRIES}x — its orders were skipped`);
          pageAttempt = 0;
          page++;
          continue;
        } finally {
          clearTimeout(to);
        }
      }

      // Handle eBay upstream errors (temporary server issues)
      if (responseText.includes('upstream connect error') || responseText.includes('error') && responseText.length < 200) {
        console.warn(`⚠️ eBay API error on page ${page}: ${responseText.substring(0, 100)}`);
        if (pageAttempt < MAX_PAGE_RETRIES) {
          pageAttempt++;
          const backoff = 2000 * pageAttempt; // 2s, 4s, 6s, 8s
          console.log(`⏳ Retrying page ${page} in ${backoff}ms (attempt ${pageAttempt}/${MAX_PAGE_RETRIES})...`);
          sendLog('-', '-', '⚠️ API Error (retry)', `Page ${page} attempt ${pageAttempt}/${MAX_PAGE_RETRIES}, waiting ${backoff}ms`);
          await new Promise(r => setTimeout(r, backoff));
          continue; // Retry SAME page (page unchanged)
        }
        // Exhausted retries — LOUD skip so lost orders aren't invisible
        console.error(`❌ Page ${page} failed ${MAX_PAGE_RETRIES}x (upstream error) — skipping, orders on it are LOST`);
        sendLog('-', '-', '❌ Page LOST', `Page ${page}: upstream error ${MAX_PAGE_RETRIES}x — its orders were skipped`);
        pageAttempt = 0;
        page++;
        continue;
      }

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error(`❌ JSON parse error on page ${page}:`, responseText.substring(0, 100));
        if (pageAttempt < MAX_PAGE_RETRIES) {
          pageAttempt++;
          const backoff = 2000 * pageAttempt; // 2s, 4s, 6s, 8s
          console.log(`⏳ Retrying page ${page} in ${backoff}ms (attempt ${pageAttempt}/${MAX_PAGE_RETRIES})...`);
          sendLog('-', '-', '⚠️ Parse Error (retry)', `Page ${page} attempt ${pageAttempt}/${MAX_PAGE_RETRIES}, waiting ${backoff}ms`);
          await new Promise(r => setTimeout(r, backoff));
          continue; // Retry SAME page (page unchanged)
        }
        // Exhausted retries — LOUD skip so lost orders aren't invisible
        console.error(`❌ Page ${page} invalid JSON ${MAX_PAGE_RETRIES}x — skipping, orders on it are LOST`);
        sendLog('-', '-', '❌ Page LOST', `Page ${page}: invalid JSON ${MAX_PAGE_RETRIES}x — its orders were skipped`);
        pageAttempt = 0;
        page++;
        continue; // Skip this page
      }

      // Page parsed cleanly — reset the per-page retry counter for the next page.
      pageAttempt = 0;

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
        // 1000ms (was 500ms) between pages — a modest slowdown to ease eBay's
        // antibot (PerimeterX served non-JSON HTML for some pages at 500ms).
        // The per-page retry-with-backoff below is the real safety net; 1500ms
        // roughly tripled scan time and only worsened the idle-SW noise, so 1s.
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Recover tracking for orders that had NONE in the list feed by reading each
    // order's detail page (order.ebay.com/ord/show) via the background SW (see
    // enrichMissingTrackings). Mutates allOrders in place.
    await enrichMissingTrackings(allOrders);
    // Drop entries STILL without tracking (genuinely un-shipped) and strip the internal
    // flag, preserving the original "sheet gets only trackable shipments" contract.
    allOrders = allOrders.filter(o => o && o.track_number);
    allOrders.forEach(o => { delete o._needsDetailTracking; });

    console.log(`📊 TOTAL: ${allOrders.length} orders`);

    // Zero rows is not a successful cabinet pass. The old code emitted Done and
    // only then threw, so the pipeline advanced while the report claimed eBay
    // completed. Keep the stage on its explicit error/watchdog path instead.
    if (allOrders.length === 0) {
      throw new Error('Found 0 orders. Check if you are on the correct eBay page (www.ebay.com/mye/myebay/purchase) and have orders for this year.');
    }

    // Save orders to storage (store-specific) and await the actual commit before
    // Done is the account-switch permit: every producer ACK must have reached
    // persisted storage before this content script can release it.
    await Promise.all(__ebayScreenshotQueueCommits);

    // Bind every row and the completion permit to the same durable pipeline run.
    await verifyEbayParserContext(parserContext);
    const runId = parserContext.runId;
    const parserAccount = parserContext.account || '';
    const observedAt = new Date().toISOString();
    for (const order of allOrders) {
      order.parser_run_id = runId;
      order.parser_account = parserAccount;
      order.observed_at = observedAt;
    }

    // emitting Done. Done is the background's permission to advance to Amazon.
    const timestamp = new Date().toISOString();
    const stored = await chrome.storage.local.get(['orderData']);
    const orderData = stored.orderData || {};
    orderData['eBay'] = {
      orders: allOrders,
      lastParsed: timestamp,
      totalOrders: allOrders.length
    };
    await chrome.storage.local.set({ orderData });
    console.log('💾 Saved eBay data to storage');
    // Notify popup to refresh UI states (copy buttons etc.)
    chrome.runtime.sendMessage({ action: 'updatePopup' }).catch(() => {});

    // AUTO-SAVE: Also save to ebayOrders for direct access
    await chrome.storage.local.set({
      ebayOrders: allOrders,
      ebayLastUpdate: Date.now()
    });
    console.log('💾 Auto-saved to ebayOrders:', allOrders.length);

    // Persist CANCELLED orders (money-safety) — single-account, overwrite per run.
    await chrome.storage.local.set({
      ebayCancelledOrders: __ebayCancelledOrders.slice(),
      ebayCancelledUpdatedAt: Date.now()
    });
    if (__ebayCancelledOrders.length) console.log(`🚫 Отменённых eBay-заказов за прогон: ${__ebayCancelledOrders.length}`);

    // Send completion progress
    chrome.runtime.sendMessage({
      action: 'progress',
      store: 'eBay',
      current: MAX_PAGES,
      total: MAX_PAGES,
      status: 'Done ✅', // Explicit 'Done ✅' for background.js to detect completion
      found: allOrders.length,
      runId,
      account: parserAccount
    });

    // NO auto-download - user will use Copy button for Google Sheets
    // CSV download only via popup "Export to CSV" button if needed
    console.log('✅ Parse complete - data saved to storage (no auto-download)');
    return allOrders;

  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  }
}

// Post-parse: fill in tracking for orders that had NONE in the purchase-history list
// feed by reading each order's DETAIL page (order.ebay.com/ord/show). The tracking sits
// in the detail SPA's embedded JSON (trackingSection → label "Number" → value). Content
// scripts can't fetch order.ebay.com cross-origin (CORS), so the actual fetch happens in
// the background SW via the 'fetchEbayOrderTracking' message. Sequential + small delay to
// stay gentle on eBay; only the (usually few) feed-untracked orders are looked up.
async function enrichMissingTrackings(allOrders) {
  const pending = allOrders.filter(o => o && o._needsDetailTracking && o.order_id && o.order_id !== 'N/A');
  if (pending.length === 0) return;
  // ⚠️ Detail-page tracking recovery is DISABLED by default. Fetching order.ebay.com
  // per-order is exactly what triggers eBay's soft-ban (limitexceeded.html, ~24h) — see
  // AutoBuy CLAUDE.md rule #11. This path stays dormant until it can be re-verified as a
  // gentle, throttled, new-orders-only pass. Enable with:
  //   chrome.storage.local.set({ ebayDetailEnrichmentEnabled: true })
  // Without it, eBay parses the LIST FEED only (no extra hits, no ban) and any order whose
  // tracking isn't in the feed is simply picked up on a later run once the feed carries it.
  try {
    const flag = await chrome.storage.local.get(['ebayDetailEnrichmentEnabled']);
    if (!flag || flag.ebayDetailEnrichmentEnabled !== true) {
      console.log(`⏭ ${pending.length} feed-untracked order(s) — detail-page enrichment is disabled (feed-only, ban-safe)`);
      return;
    }
  } catch (_) { return; }
  const orderIds = Array.from(new Set(pending.map(o => o.order_id)));
  console.log(`🔎 ${orderIds.length} order(s) had no tracking in the list feed — checking order-detail pages...`);
  sendLog('-', '-', '🔎 Enrich start', `${orderIds.length} feed-untracked order(s) — reading detail pages`);

  // Fetch the WHOLE batch in ONE message. The background SW loops through all the
  // detail-page fetches in a single active run, so it stays alive and won't idle-die
  // mid-way (many small messages with delays between them let the SW sleep, and a
  // dropped async response then hangs the parse forever). The timeout is a safety net
  // so a lost response can never wedge the parse — worst case we recover nothing this
  // run and pick the orders up next run.
  let map = {};
  try {
    map = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(() => { console.warn('⏱ tracking-enrichment batch timed out'); done({}); },
                               orderIds.length * 3000 + 15000);
      try {
        chrome.runtime.sendMessage({ action: 'fetchEbayOrderTrackings', orderIds }, (resp) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) { done({}); return; }
          done((resp && resp.map) || {});
        });
      } catch (_) { clearTimeout(timer); done({}); }
    });
  } catch (_) { map = {}; }

  const recovered = Object.values(map).filter(Boolean).length;
  sendLog('-', '-', '🔎 Enrich done', `recovered ${recovered}/${orderIds.length} from detail pages`);
  for (const orderId of orderIds) {
    const tracking = map[orderId] || '';
    if (tracking) {
      for (const o of allOrders) {
        if (o.order_id === orderId && !o.track_number) o.track_number = tracking;
      }
      console.log(`   ✅ ${orderId}: recovered tracking ${tracking} from order-details page`);
      sendLog(orderId, tracking, '✅ Found (detail)', 'tracking recovered from order-details page');
      // Queue the same order-page screenshot that feed-tracked orders get.
      try {
        const commit = chrome.runtime.sendMessage({
          action: 'queueTrackScreenshot',
          orderId,
          trackNumber: tracking,
          trackUrl: `https://order.ebay.com/ord/show?orderid=${orderId}`,
          accountName: __ebayAccountName || 'ebay'
        }).then(response => {
          if (response?.status !== 'queued') throw new Error(response?.error || 'screenshot queue commit was not acknowledged');
        });
        __ebayScreenshotQueueCommits.push(commit);
      } catch (error) { __ebayScreenshotQueueCommits.push(Promise.reject(error)); }
    } else {
      console.log(`   ⏭ ${orderId}: still no tracking (genuinely un-shipped) — will drop`);
    }
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

    // --- CANCELLED / REFUNDED DETECTION (money-safety) ---
    // Independent of the tracking gate below: a cancelled order (no tracking) would
    // otherwise be dropped, while Pochtoy may still show it as "Выкуплен".
    try {
      const cxl = detectEbayCancelled(item);
      if (cxl.cancelled && orderId && orderId !== 'N/A') {
        if (!__ebayCancelledOrders.some(o => o.order_id === orderId)) {
          __ebayCancelledOrders.push({
            store_name: 'eBay',
            order_id: orderId,
            product_name: (cleanName || '').slice(0, 120),
            status_text: cxl.status_text,
            account_name: __ebayAccountName || ''
          });
          console.log(`🚫 ОТМЕНЁН заказ eBay: ${orderId} — ${cxl.status_text}`);
        }
      }
    } catch (_) {}
    // -----------------------------------------------------

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
        // Priority 5: FedEx — bare 12- or 15-digit numeric (e.g. 873223053751).
        // Safe here because `trackingNumber` param holds ONLY a real track, not
        // arbitrary page text, so a loose numeric match won't grab noise.
        const fedex = up.match(/\b(\d{15}|\d{12})\b/);
        if (fedex) return fedex[1];
      } catch (_) {}
      return '';
    };

    // Per-card tracking extraction — look ONLY at THIS card's __myb.actionList.
    // Earlier versions concatenated firstCard + item-level actionList and fell back to
    // item-level "typical" fields, which leaked one shipment's tracking onto unshipped
    // siblings (see bug: order 05-14528-97460 had firstCard tracking slapped onto the
    // not-yet-shipped TOMS; order 21-14502-88603 inherited 88602's tracking via item-level
    // fields). Strict per-card lookup makes the bot skip genuinely un-shipped items.
    const extractCardTracking = (card) => {
      if (!card) return '';
      const actions = card?.__myb?.actionList || [];
      for (const a of actions) {
        const tn = a?.action?.params?.trackingNumber;
        const best = pickBestTracking(tn);
        if (best) return best;
      }
      return '';
    };

    // Build entries for all items in Multiple items, each with ITS OWN tracking.
    const entries = cards.map(card => {
      const cardTracking = extractCardTracking(card);

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
        track_number: cardTracking,
        product_name: title,
        qty: quantity,
        color: color || '',
        size: size || '',
        financial: financial,
        total_amount: financial.total_amount,
        account_name: __ebayAccountName || ''
      };
    });

    // Collect distinct trackings that actually belong to THIS order's cards.
    const trackingsInOrder = Array.from(new Set(entries.map(e => e.track_number).filter(Boolean)));

    // If NO card in this order has a real tracking in the LIST FEED, don't drop the order
    // yet — some carriers/orders expose the tracking ONLY on the order-DETAIL page
    // (order.ebay.com/ord/show), never in this feed. Example: order 24-14770-78524
    // (MacBook, FedEx 873223053751) has zero trackingNumber in the feed but a real
    // "Tracking details → Number" on its detail page. Tag the entries so the post-parse
    // enrichMissingTrackings() step can recover the tracking via the background SW.
    // Orders that are genuinely un-shipped (no tracking even on the detail page) are
    // dropped later by the caller, so the sheet still gets only trackable shipments.
    if (trackingsInOrder.length === 0) {
      if (orderId && orderId !== 'N/A') {
        return entries.map(e => ({ ...e, _needsDetailTracking: true }));
      }
      return null;
    }

    // Queue ONE screenshot per order (the /ord/show page contains all items + all trackings).
    // queueTrackScreenshot dedupes by orderId for order-page URLs and merges extra trackings
    // into extraTracks — so we call it once per distinct tracking to attach the whole set.
    if (orderId && orderId !== 'N/A') {
      for (const tn of trackingsInOrder) {
        try {
          const commit = chrome.runtime.sendMessage({
            action: 'queueTrackScreenshot',
            orderId,
            trackNumber: tn,
            trackUrl: `https://order.ebay.com/ord/show?orderid=${orderId}`,
            accountName: __ebayAccountName || 'ebay'
          }).then(response => {
            if (response?.status !== 'queued') throw new Error(response?.error || 'screenshot queue commit was not acknowledged');
          });
          __ebayScreenshotQueueCommits.push(commit);
        } catch (error) { __ebayScreenshotQueueCommits.push(Promise.reject(error)); }
      }
    }

    // Drop un-shipped cards from the sheet — we'll pick them up next run when they ship.
    return entries.filter(e => e.track_number);
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
