/* content-iherb.js — v7.8.0 (attempt-fenced multi-account nightly parser) */
console.log('🟢 iHerb Parser v7.8.0 loaded!', window.location.href);
console.log('📄 Page title:', document.title);
console.log('📄 Page HTML length:', document.body?.innerHTML?.length || 0);

// Guard against double-parse (both flag + message could trigger)
let isParsingInProgress = false;

// Multi-account: current iHerb account email (set by checkAutoParse / exportOrders
// before parseOrders() composes rows). Rows emitted during this run will
// include this email as `account_name`.
window.__iherbCurrentAccountName = window.__iherbCurrentAccountName || '';
window.__iherbRunId = window.__iherbRunId || null;
window.__iherbParseAttemptId = window.__iherbParseAttemptId || null;

// Resolve primary iHerb account from accountsConfig — used when we're not in
// multi-account mode (manual /myaccount/orders parse).
async function getIherbAccountFromConfig() {
  try {
    const r = await chrome.storage.local.get(['accountsConfig']);
    const cfg = r.accountsConfig;
    if (!cfg || !cfg.iherb || !cfg.iherb.length) return '';
    const primary = cfg.iherb.find(a => a.isPrimary) || cfg.iherb[0];
    return primary.email || '';
  } catch (_) {
    return '';
  }
}

function normalizeIherbAccount(value) {
  return String(value || '').trim().toLowerCase();
}

async function captureIherbParserContext(fallbackAccount = '') {
  const door = await chrome.runtime.sendMessage({
    action: 'getParserContext', store: 'iherb', purpose: 'parse'
  }).catch(() => null);
  if (door?.blocked) {
    throw new Error('iHerb pipeline is blocked for human Press & Hold');
  }
  if (door?.active && !door.owned) {
    throw new Error('iHerb pipeline context belongs to a different tab');
  }
  if (door?.owned) {
    return {
      runId: door.runId,
      account: door.account,
      parserTabId: door.tabId,
      attemptId: door.attemptId,
      stageStartedAt: door.stageStartedAt,
      standalone: false
    };
  }
  return { runId: null, account: fallbackAccount, parserTabId: null, attemptId: null, stageStartedAt: null, standalone: true };
}

async function verifyIherbParserContext(context) {
  const fresh = await chrome.storage.local.get([
    'pipelineRun', 'pipelineStage', 'multiAccountIherbState', 'iherbStageFinalizing',
    'iherbParseAttemptId', 'iherbTimeoutAttempt'
  ]);
  if (!context.runId) {
    if (['starting', 'running'].includes(fresh.pipelineRun?.status)) {
      throw new Error('standalone iHerb parse overlapped a pipeline run');
    }
    return true;
  }
  const valid = fresh.pipelineRun?.id === context.runId
    && ['starting', 'running'].includes(fresh.pipelineRun?.status)
    && fresh.pipelineStage?.active === true
    && fresh.pipelineStage?.runId === context.runId
    && fresh.pipelineStage?.stages?.[fresh.pipelineStage?.currentIndex] === 'iherb'
    && (fresh.pipelineStage?.stageStartedAt || null) === context.stageStartedAt
    && fresh.iherbStageFinalizing?.runId !== context.runId
    && fresh.iherbParseAttemptId === context.attemptId
    && fresh.iherbTimeoutAttempt?.attemptId !== context.attemptId
    && normalizeIherbAccount(fresh.multiAccountIherbState?.currentIherbAccount)
      === normalizeIherbAccount(context.account);
  if (!valid) throw new Error('stale iHerb run/account before commit');
  return true;
}

async function confirmIherbFinalReturnLanding() {
  return chrome.runtime.sendMessage({ action: 'confirmIherbFinalReturnLanding' })
    .catch(error => ({
      confirmed: false,
      reason: String(error?.message || error)
    }));
}

async function commitIherbAttemptResult(context, orders, cancelledOrders, found) {
  const response = await chrome.runtime.sendMessage({
    action: 'commitIherbAttempt',
    attempt: {
      runId: context.runId,
      account: context.account,
      parserTabId: context.parserTabId,
      attemptId: context.attemptId,
      stageStartedAt: context.stageStartedAt || null
    },
    orders,
    cancelledOrders,
    found
  });
  if (!response?.ok) {
    throw new Error(`iHerb result commit rejected: ${response?.reason || response?.status || 'unknown'}`);
  }
  return response;
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
async function retryOnServiceUnavailable(maxRetries = 5, baseDelay = 20000) {
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
      error: 'Service unavailable after ' + maxRetries + ' retries',
      runId: window.__iherbRunId,
      account: window.__iherbCurrentAccountName,
      attemptId: window.__iherbParseAttemptId
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

  // Wait then click "Try Again" (or reload as fallback). У iHerb на странице
  // /myaccount/orders в "Service unavailable" состоянии есть кнопка
  // <button class="try-again-btn" onclick="window.location.reload()">Try Again</button>.
  // Нативный клик ведёт себя ровно как reload, но iherb трекает user-action и
  // иногда возвращает orders быстрее, чем при programmatic reload.
  setTimeout(() => {
    const tryAgainBtn = document.querySelector('button.try-again-btn, button.action-btn[onclick*="reload" i]') ||
                        Array.from(document.querySelectorAll('button')).find(b => /try\s*again/i.test(b.textContent || ''));
    if (tryAgainBtn) {
      console.log('🔄 Clicking "Try Again" button');
      tryAgainBtn.click();
    } else {
      console.log('🔄 No Try Again btn found, fallback to reload()');
      window.location.reload();
    }
  }, delay);

  return true; // Retry scheduled
}

// Check for auto-parse flag on page load (with retry for slow page loads)
(async function checkAutoParse() {
  console.log('🔍 Checking for auto-parse flag...');

  // --- Multi-account iHerb gates ---------------------------------------------
  // Final return (we navigated back to primary account just to restore
  // session for AutoBuy) — MUST NOT parse.
  const finalReturnCheck = await chrome.storage.local.get(['iherbFinalReturn']);
  if (finalReturnCheck.iherbFinalReturn === true) {
    const confirmation = await confirmIherbFinalReturnLanding();
    console.log(confirmation?.confirmed
      ? '🏁 iHerb primary landing confirmed — skipping parse (session restore only)'
      : `🏁 iHerb final-return landing rejected (${confirmation?.reason || 'unknown'}) — skipping parse`);
    // Background validates the exact run/account/tab/generation before writing
    // confirmation. This page never clears the final-return proof itself.
    return;
  }

  // Multi-account resume: pipeline switched to next iHerb account and landed
  // us on /myaccount/orders. Pick up the current account name so rows carry
  // the right `account_name`.
  const multiCheck = await chrome.storage.local.get([
    'multiAccountIherbState', 'iherbSwitchInProgress', 'pipelineRun',
    'iherbParseAttemptId'
  ]);
  const multiState = multiCheck.multiAccountIherbState;
  if (multiState && multiState.isMultiAccountIherb && multiState.currentIherbAccount) {
    window.__iherbCurrentAccountName = multiState.currentIherbAccount;
    window.__iherbRunId = multiCheck.pipelineRun?.id || null;
    window.__iherbParseAttemptId = multiCheck.iherbParseAttemptId || null;
    console.log(`👥 Multi-account iHerb resume: currentAccount=${multiState.currentIherbAccount}`);
  }
  // --------------------------------------------------------------------------

  // Try up to 3 times with delays (page might load before flag is set)
  let shouldAutoParse = false;
  let retryAutoParse = false;
  let standardAutoParse = false;
  let isRecent = false;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const data = await chrome.storage.local.get(['autoParsePending', 'autoParse_iherb', 'autoParseTimestamp', 'iherb_should_autoparse', 'iherbSwitchInProgress']);

    retryAutoParse = data.iherb_should_autoparse === true;
    standardAutoParse = (data.autoParsePending === 'iherb') || data.autoParse_iherb;
    const switchAutoParse = data.iherbSwitchInProgress === true; // multi-account
    const timestamp = data.autoParseTimestamp || data.autoParse_iherb;
    // Increased timeout to 180 seconds (iHerb pages load slowly at night)
    isRecent = timestamp && (Date.now() - timestamp < 180000);

    shouldAutoParse = retryAutoParse || switchAutoParse || (standardAutoParse && isRecent);

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
    // PerimeterX "Press & Hold" is intentionally human-only. Keep the exact
    // parser tab untouched and ask background to persist/dedupe an operator
    // alert; never synthesize trusted mouse input.
    const phText = (document.body?.innerText || '').toLowerCase();
    const isPressHold = /press\s*&?\s*hold/.test(phText) &&
                        (/confirm you are a human/.test(phText) || /reference id/.test(phText));
    if (isPressHold) {
      console.log('🧩 Press & Hold detected — waiting for a human');
      await sendLog('-', '-', '🧩 Captcha', 'Press & Hold — требуется человек');
      try {
        chrome.runtime.sendMessage({
          action: 'iherbPressHoldDetected',
          runId: window.__iherbRunId,
          account: window.__iherbCurrentAccountName,
          attemptId: window.__iherbParseAttemptId
        });
      } catch (_) {}
      return; // no parsing/navigation until a person handles the exact tab
    }

    // Orders not loaded yet - wait more
    console.log('⏳ No orders yet, waiting 5 more seconds...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    const hasOrdersSecondCheck = document.body?.innerText?.includes('Order #') || false;
    console.log('🔍 Second check - has orders:', hasOrdersSecondCheck);

    // FALLBACK: после 10с нет articles — один reload (iherb /orders иногда отдаёт пустой SPA-shell).
    // Маркер iherbOrdersReloadDone предотвращает бесконечный цикл reload.
    if (!hasOrdersSecondCheck) {
      const hasArticles = document.querySelector('article[data-order-number]') !== null;
      const reloadStored = await chrome.storage.local.get(['iherbOrdersReloadDone']);
      if (!hasArticles && !reloadStored.iherbOrdersReloadDone) {
        console.log('🔄 No articles after 12s — single reload fallback');
        await chrome.storage.local.set({ iherbOrdersReloadDone: true });
        // не сбрасываем флаги iherb_should_autoparse / iherbSwitchInProgress —
        // после reload checkAutoParse увидит их и снова запустится
        window.location.reload();
        return;
      }
    }

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
  await chrome.storage.local.remove(['iherb_retry_count', 'iherb_retry_timestamp', 'iherbOrdersReloadDone']);

  // Start parsing (with guard)
  if (isParsingInProgress) {
    console.log('⚠️ Parse already in progress (triggered by message?), skipping auto-parse');
    return;
  }
  isParsingInProgress = true;
  console.log('🚀 Starting auto-parse...');
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
          error: error.message,
          runId: window.__iherbRunId,
          account: window.__iherbCurrentAccountName,
          attemptId: window.__iherbParseAttemptId
        });
      });
    return false; // Don't keep channel open - we already responded
  }
});

async function slowProgressiveScroll(limit = 150) {
    console.log(`📜 Starting SLOW progressive scroll (limit: ${limit} orders)...`);
    console.log('⚠️  Scrolling slowly to avoid 429 errors - please wait!');

    // Heartbeat: пишем в localStorage каждую итерацию — переживёт даже Extension context invalidated.
    // bg-watchdog (chrome.scripting.executeScript) сможет прочитать и понять прогресс.
    const HEARTBEAT_KEY = 'parser_iherb_heartbeat';
    // Snapshot once: a later account transition must not relabel an old loop.
    const provenance = Object.freeze({
        runId: window.__iherbRunId || null,
        account: window.__iherbCurrentAccountName || null,
        attemptId: window.__iherbParseAttemptId || null
    });
    const writeHeartbeat = (count, attempt, status) => {
        try {
            window.localStorage.setItem(HEARTBEAT_KEY, JSON.stringify({
                ts: Date.now(), count, attempt, status, limit, ...provenance
            }));
        } catch {}
    };

    // Safe sendMessage: ловим Extension context invalidated → break loop корректно.
    let extensionContextDead = false;
    const safeSendMessage = (msg) => {
        if (extensionContextDead) return;
        try {
            if (!chrome?.runtime?.id) { extensionContextDead = true; return; }
            chrome.runtime.sendMessage(msg, () => {
                if (chrome.runtime.lastError) {
                    const errMsg = chrome.runtime.lastError.message || '';
                    if (/context invalidated|Extension context/i.test(errMsg)) {
                        extensionContextDead = true;
                        console.warn('⚠️  Extension context invalidated, breaking scroll loop');
                    }
                }
            });
        } catch (e) {
            extensionContextDead = true;
            console.warn('⚠️  sendMessage threw:', e.message);
        }
    };

    writeHeartbeat(0, 0, 'starting');
    safeSendMessage({
        action: 'parsingProgress',
        data: {
            store: 'iHerb',
            current: 0,
            total: limit,
            status: 'Starting scroll...',
            ...provenance
        }
    });

    let previousUniqueCount = 0;
    let noNewOrdersCount = 0;
    const maxNoNewChecks = 14;  // дольше ждём если iHerb тормозит
    const scrollDelay = 5000;   // 5s — iHerb lazy-load медленный
    const wallTimeMaxMs = 180_000; // safety: hard cap 3 min на весь loop
    const startedAt = Date.now();

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
    const maxScrollAttempts = 120; // до 120 попыток на случай длинной истории

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

        writeHeartbeat(currentUniqueCount, scrollAttempts, 'scrolling');

        // Send progress update (safe — будет no-op если context dead)
        safeSendMessage({
            action: 'parsingProgress',
            data: {
                store: 'iHerb',
                current: currentUniqueCount,
                total: limit,
                status: `Loading orders ${currentUniqueCount}/${limit}...`,
                found: currentUniqueCount,
                ...provenance
            }
        });

        // Если context invalidated — нет смысла продолжать (cs мёртв с т.з. extension)
        if (extensionContextDead) {
            console.warn(`🛑 Breaking loop: extension context invalidated at attempt ${scrollAttempts}, count=${currentUniqueCount}`);
            writeHeartbeat(currentUniqueCount, scrollAttempts, 'context_invalidated_break');
            break;
        }

        // Wall-time safety: hard cap 3 min
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs > wallTimeMaxMs) {
            console.warn(`🛑 Wall-time safety break at ${Math.round(elapsedMs/1000)}s, count=${currentUniqueCount}/${limit}`);
            writeHeartbeat(currentUniqueCount, scrollAttempts, 'walltime_break');
            break;
        }

        // Check if we reached the limit
        if (currentUniqueCount >= limit) {
            console.log(`✅ Reached ${limit} orders limit!`);
            writeHeartbeat(currentUniqueCount, scrollAttempts, 'limit_reached');
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
    writeHeartbeat(previousUniqueCount, scrollAttempts, extensionContextDead ? 'done_with_context_dead' : 'done_ok');
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

// CANCELLED-ORDER DETECTION (money-safety). Отменённый заказ iHerb приходит БЕЗ трек-номера,
// поэтому фильтр «только с треком» ниже его молча выбрасывает — а в Pochtoy он всё ещё
// «Выкуплен» (клиент заплатил, товар не придёт). Читаем короткие текст-метки статуса внутри
// <article>, исключая кнопки/ссылки (чтобы кнопка «Cancel order» на активном заказе не давала
// ложное срабатывание). Ничего не удаляем — только собираем в отдельный список для отчёта.
function detectIherbCancelled(container) {
    if (!container) return { cancelled: false };
    const els = container.querySelectorAll('span, p, div, strong, b, h2, h3, [class*="status"]');
    for (const el of els) {
        if (el.children.length > 0) continue;            // только листовой текст
        if (el.closest('a, button, [role="button"]')) continue; // не элемент-действие
        const t = (el.innerText || el.textContent || '').trim();
        if (!t || t.length > 40) continue;               // метка статуса короткая
        if (/^(cancell?ed|order\s+cancell?ed)\b/i.test(t)) return { cancelled: true, status_text: t.slice(0, 60) };
        if (/^(refunded|refund\s+issued)\b/i.test(t)) return { cancelled: true, status_text: t.slice(0, 60) };
    }
    return { cancelled: false };
}

async function parseOrders() {
    const orders = [];
    const cancelledThisRun = [];   // отменённые/возвращённые заказы этого прогона (money-safety)
    const cancelledSeen = new Set();
    const screenshotQueueCommits = [];

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
    // Дедуп по ОТГРУЗКЕ (заказ+трек), а не по заказу: сплит-заказ iHerb приезжает
    // несколькими <article> с одним data-order-number, но разными треками — каждый
    // пакет должен пройти как своя строка. (сплит-фикс 2026-07-04)
    const processedShipments = new Set();
    const MAX_ORDERS = 150;

    // Дата-пол глубины парса iHerb (оператор 2026-07-04). Новые аккаунты
    // (questburgh/oksanasorokapocht) без истории дедупа иначе уходят вглубь до
    // февраля и спамят старьё. Заказы на странице идут новейшие→старые, поэтому
    // встретив ПЕРВЫЙ заказ старше пола — прекращаем обработку (всё глубже старее).
    // Для устоявшихся аккаунтов дедуп и так держит глубину; пол — страховка от
    // бэкфилла. Бампить дату по мере надобности. Формат YYYY-MM-DD (лексикогр.).
    const IHERB_MIN_ORDER_DATE = '2026-05-15';
    let reachedOldOrders = false;

    // Send initial processing progress
    chrome?.runtime?.sendMessage?.({
        action: 'progress',
        store: 'iHerb',
        current: 0,
        total: Math.min(orderHeaders.length, MAX_ORDERS),
        status: 'Processing orders...'
    });

    orderHeaders.forEach((headerObj, headerIndex) => {
        // Дата-пол пройден на предыдущей итерации → всё дальше старее, выходим сразу.
        if (reachedOldOrders) return;
        // LIMIT: Stop at 76 orders
        if (processedOrders.size >= MAX_ORDERS) {
            console.log(`\n⏹️  Reached ${MAX_ORDERS} orders limit - stopping processing`);
            return;
        }

        // Extract order ID from our preprocessed object
        const orderId = headerObj.orderId;
        if (!orderId) return;

        // Use the element directly as container (it's already the article element)
        const orderContainer = headerObj.element;

        // CANCELLED-ORDER DETECTION (money-safety) — до дедупа/фильтра по треку.
        try {
            const cxl = detectIherbCancelled(orderContainer);
            if (cxl.cancelled && !cancelledSeen.has(orderId)) {
                cancelledSeen.add(orderId);
                const prodLink = orderContainer.querySelector('a[href*="/pr/"]');
                cancelledThisRun.push({
                    store_name: 'iHerb',
                    order_id: orderId,
                    product_name: (prodLink ? prodLink.textContent.trim() : '').slice(0, 120),
                    status_text: cxl.status_text,
                    account_name: window.__iherbCurrentAccountName || ''
                });
                console.log(`🚫 ОТМЕНЁН заказ iHerb #${orderId} — "${cxl.status_text}"`);
            }
        } catch (_) {}

        // Извлекаем трек РАНЬШЕ дедупа — он нужен для сплит-осознанного ключа.
        // Сплит-заказ iHerb приезжает несколькими <article> с ОДИНАКОВЫМ data-order-number,
        // но каждый пакет — отдельная отгрузка (orderNumber-0/-1/-2) со своим треком. Дедуп
        // по (заказ+трек), а не по заказу, иначе второй пакет схлопывается как «дубликат» и
        // его товары теряются (недосбор). На повторном проходе новый пакет = новый трек =
        // новые строки; строки первого пакета стабильны. (сплит-фикс 2026-07-04)
        let trackingNumber = '';
        const trackBtn = orderContainer.querySelector('a[href*="carrierTracking"]');
        if (trackBtn) {
            try {
                const url = new URL(trackBtn.getAttribute('href'), 'https://secure.iherb.com');
                trackingNumber = url.searchParams.get('trackingNumber') || '';
            } catch (_) {}
            console.log(`    🚚 Tracking: ${trackingNumber}`);
        } else {
            console.log('    ⚠️  No Track button (Fulfilling status)');
        }

        // Дедуп по ОТГРУЗКЕ (заказ+трек): пакеты сплита с разными треками проходят оба,
        // повтор той же отгрузки в одном проходе — отсекается. MAX_ORDERS/счётчик остаются
        // по уникальному заказу (processedOrders), пакеты его не раздувают.
        const shipmentKey = `${orderId}|${trackingNumber || 'notrack'}`;
        if (processedShipments.has(shipmentKey)) {
            console.log(`  ⏭️  Skipping duplicate shipment #${orderId} (track ${trackingNumber || '—'})`);
            return;
        }
        processedShipments.add(shipmentKey);
        processedOrders.add(orderId);

        console.log(`\n  ✅ Processing Order #${orderId} shipment ${trackingNumber || '(no track)'} (${processedShipments.size})`);

        // Send progress update
        chrome?.runtime?.sendMessage?.({
            action: 'progress',
            store: 'iHerb',
            current: processedOrders.size,
            total: Math.min(orderHeaders.length, MAX_ORDERS),
            status: `Processing order ${processedOrders.size}/${MAX_ORDERS}...`
        });

        // Extract date if available
        const dateMatch = orderContainer.textContent.match(/Placed\s+on\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i);
        const orderDate = dateMatch ? convertDateToISO(dateMatch[1]) : '';
        if (orderDate) {
            console.log(`    📅 Date: ${orderDate}`);
        }

        // Дата-пол: заказ старше пола → стоп (заказы идут новейшие→старые, значит
        // всё дальше ещё старее). Пустую/непарсибельную дату НЕ считаем старой,
        // чтобы не оборваться раньше времени на редком заказе без даты.
        if (orderDate && orderDate < IHERB_MIN_ORDER_DATE) {
            console.log(`  ⏹️  Order #${orderId} placed ${orderDate} < floor ${IHERB_MIN_ORDER_DATE} — stopping (older orders skipped)`);
            reachedOldOrders = true;
            // Durable-маркер для контроля глубины из SW (оператор видит, что пол сработал).
            try {
                chrome.storage.local.get(['multiAccountIherbState'], (acc) => {
                    const accEmail = acc?.multiAccountIherbState?.currentIherbAccount || '';
                    chrome.storage.local.set({ iherbFloorStopLast: {
                        account: accEmail, boundaryOrderId: orderId, boundaryDate: orderDate,
                        floor: IHERB_MIN_ORDER_DATE, processedBeforeFloor: processedOrders.size - 1, at: Date.now()
                    }});
                });
            } catch (_) {}
        }
        if (reachedOldOrders) return;

        // (трек и trackBtn уже извлечены выше — до сплит-осознанного дедупа)

        // Очередь скриншота заказа iHerb — страница carrierTracking (по кнопке Track shipment).
        // НЕ фильтруем по возрасту заказа: дедуп «уже отправляли» делает background
        // (filterAlreadySent: sentScreenshots + колонка screenshot_link в таблице, по трек-номеру),
        // поэтому повторов не будет. Прежний фильтр «старше 14 дней» ошибочно резал свежие отгрузки
        // старых заказов и оставлял «несколько штук» вместо всех новых. (2026-06-08)
        if (trackingNumber && orderId && trackBtn) {
            const carrierUrl = trackBtn.href || trackBtn.getAttribute('href') || '';
            if (carrierUrl) {
                // Account was resolved before parseOrders. Queue through the
                // background's acknowledged/persisted door and retain every
                // promise: Done must not race ahead of a late storage callback.
                // Keep the same full account identity as Sheet column I. A mail
                // prefix cannot authorize publication into another cabinet's row.
                const accountName = window.__iherbCurrentAccountName || 'iherb';
                screenshotQueueCommits.push(
                    chrome.runtime.sendMessage({
                        action: 'queueTrackScreenshot',
                        orderId,
                        trackNumber: trackingNumber,
                        trackUrl: carrierUrl,
                        accountName
                    }).then(response => {
                        if (response?.status !== 'queued') {
                            throw new Error(response?.error || 'screenshot queue commit was not acknowledged');
                        }
                    })
                );
            }
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
                    size: '',
                    account_name: window.__iherbCurrentAccountName || ''
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
                        size: '',
                        account_name: window.__iherbCurrentAccountName || ''
                    });
                    sendLog(orderId, trackingNumber, '✅ Found', productName.substring(0, 80));
                }
            });
        }
    });

    // Background responds only after trackScreenshotQueue is durably committed.
    // Await all producers before orderData/Done so an empty-looking drain can
    // never switch to the next iHerb account prematurely.
    await Promise.all(screenshotQueueCommits);

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

    if (shippedOrders.length === 0) {
        console.error('\n❌ NO SHIPPED ORDERS FOUND!');
        console.log('💡 All orders may be in "Fulfilling" status (no tracking yet)');
        console.log(`  Total orders found: ${orders.length}`);
        console.log(`  Orders without tracking: ${fulfillingCount}`);
    }

    if (cancelledThisRun.length) {
        console.log(`🚫 Отменённых iHerb-заказов на странице: ${cancelledThisRun.length}`);
    }

    return {
        success: true,
        orders: shippedOrders,
        cancelled: cancelledThisRun,
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

        const fallbackAccount = window.__iherbCurrentAccountName || await getIherbAccountFromConfig();
        const parserContext = await captureIherbParserContext(fallbackAccount);
        window.__iherbCurrentAccountName = parserContext.account || fallbackAccount;
        window.__iherbRunId = parserContext.runId;
        window.__iherbParseAttemptId = parserContext.attemptId;
        if (parserContext.runId) {
          chrome.runtime.sendMessage({
            action: 'parserStarted',
            store: 'iHerb',
            runId: parserContext.runId,
            account: parserContext.account,
            attemptId: parserContext.attemptId
          }).catch(() => {});
        }

        // Wait a bit for dynamic content to load
        console.log('⏳ Waiting for page to fully load...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Resolve account_name BEFORE parseOrders() runs so every emitted row
        // carries `account_name`. multi-account path already sets the global
        // in checkAutoParse(); fall back to accountsConfig primary.
        console.log(`👤 iHerb account_name: ${window.__iherbCurrentAccountName || '(empty)'}`);

        await slowProgressiveScroll(150);
        const result = await parseOrders();

        if (!result.orders || result.orders.length === 0) {
            console.error('🛑 No orders parsed!');
            throw new Error('Found 0 orders. Check if you are on the correct iHerb orders page (secure.iherb.com/myaccount/orders)');
        }

        console.log(`✅ Parsed ${result.uniqueOrdersCount} orders (${result.totalProductsCount} products total)`);
        console.log('ℹ️  Tracking numbers extracted from DOM (when available)');

        await verifyIherbParserContext(parserContext);
        const runId = parserContext.runId;
        const observedAt = new Date().toISOString();
        const parserAccount = parserContext.account || '';
        result.orders = result.orders.map(order => ({
            ...order,
            parser_run_id: runId,
            parser_account: parserAccount,
            observed_at: observedAt
        }));

        let stats;
        if (parserContext.runId) {
            // Shared rows + direct snapshot + durable completion permit are
            // validated and committed under one background attempt arbiter.
            stats = await commitIherbAttemptResult(
                parserContext,
                result.orders,
                Array.isArray(result.cancelled) ? result.cancelled : [],
                result.totalProductsCount
            );
        } else {
            // Standalone/manual parse has no pipeline attempt; keep its legacy
            // local save path separate from the six-cabinet nightly contract.
            stats = await saveOrdersWithDeduplication(result.orders, 'iHerb');
            await chrome.storage.local.set({
                iherbOrders: result.orders,
                iherbLastUpdate: Date.now()
            });
        }
        console.log('💾 Auto-saved to iherbOrders:', result.orders.length);

        // Completion is an account-switch permit. Emit it only after both the
        // shared orderData and direct iHerb snapshot are durably committed;
        // otherwise a zero/already-sent screenshot queue can navigate away and
        // destroy this content script before Alice's bridge can ever see rows.
        await chrome.runtime.sendMessage({
            action: 'parsingProgress',
            data: {
                store: 'iHerb',
                current: result.uniqueOrdersCount,
                total: result.uniqueOrdersCount,
                status: 'Done ✅',
                found: result.totalProductsCount,
                runId,
                account: parserAccount,
                attemptId: parserContext.attemptId
            }
        }).catch(() => {});

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
