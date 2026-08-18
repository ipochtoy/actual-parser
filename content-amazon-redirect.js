// Content script for Amazon main page after account switch
// Redirects to orders page if account switch just happened

console.log('🔄 Amazon redirect script loaded on:', window.location.href);

(async function() {
  // Skip if already on order-history page (avoid redirect loop)
  if (window.location.href.includes('order-history')) {
    console.log('📋 Already on order-history; content-amazon owns the gated parse flags');
    return;
  }
  
  // Skip if on signin page (let switch-account script handle it)
  if (window.location.href.includes('/ap/signin')) {
    console.log('📋 On signin page, skipping redirect');
    return;
  }
  
  // Check if we just switched accounts and need to go to orders
  const data = await chrome.storage.local.get(['accountSwitchInProgress', 'switchedToEmail', 'amazonFinalReturn']);

  console.log('📋 Checking for account switch flag:', data);

  const hasParserIntent = !!(data.amazonFinalReturn || data.accountSwitchInProgress);
  const ownership = hasParserIntent
    ? await chrome.runtime.sendMessage({ action: 'getAmazonParserContext' }).catch(() => null)
    : null;
  if (hasParserIntent && !ownership?.owned) {
    console.log('⏭ Foreign Amazon home tab — leaving parser flags and URL untouched');
    return;
  }

  // Final return: добрались до главной на нужном аккаунте — просто чистим флаги
  if (data.amazonFinalReturn) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const [freshOwnership, freshFlags] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'getAmazonParserContext' }).catch(() => null),
      chrome.storage.local.get(['amazonFinalReturn', 'pendingAccountSwitch'])
    ]);
    const finalStillOwned = freshOwnership?.owned
      && freshOwnership.runId === ownership.runId
      && freshOwnership.account === ownership.account
      && freshOwnership.tabId === ownership.tabId
      && !!freshFlags.amazonFinalReturn
      && freshFlags.pendingAccountSwitch?.runId === ownership.runId
      && String(freshFlags.pendingAccountSwitch?.email || '').trim().toLowerCase()
        === String(ownership.account || '').trim().toLowerCase();
    if (!finalStillOwned) {
      console.log('⏭ Amazon final-return intent changed before confirmation');
      return;
    }
    console.log('🏁 Amazon final return complete (no parse)');
    await chrome.storage.local.set({
      amazonFinalReturnConfirmed: {
        runId: ownership.runId,
        account: ownership.account,
        tabId: ownership.tabId,
        confirmedAt: Date.now()
      }
    });
    // Do not clear global intent keys from a content script. A newer run could
    // be prepared between the proof above and an awaited remove(). The
    // generation-fenced background finalizer consumes them when it advances.
    return;
  }

  if (data.accountSwitchInProgress) {
    if (String(ownership.account || '').trim().toLowerCase()
        !== String(data.switchedToEmail || '').trim().toLowerCase()) {
      console.log('⏭ Amazon switch landing account does not match parser ownership');
      return;
    }
    console.log(`✅ Account switch completed to ${data.switchedToEmail}, redirecting to orders...`);
    
    // Small delay to let page settle
    await new Promise(resolve => setTimeout(resolve, 500));

    const [freshOwnership, freshFlags] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'getAmazonParserContext' }).catch(() => null),
      chrome.storage.local.get(['accountSwitchInProgress', 'switchedToEmail', 'amazonFinalReturn'])
    ]);
    if (!freshOwnership?.owned
        || freshOwnership.runId !== ownership.runId
        || freshOwnership.account !== ownership.account
        || freshOwnership.tabId !== ownership.tabId
        || !freshFlags.accountSwitchInProgress
        || freshFlags.amazonFinalReturn
        || String(freshFlags.switchedToEmail || '').trim().toLowerCase()
          !== String(ownership.account || '').trim().toLowerCase()) {
      console.log('⏭ Amazon ownership changed before redirect to orders');
      return;
    }
    
    // Redirect to orders page
    window.location.href = 'https://www.amazon.com/gp/your-account/order-history?orderFilter=months-3';
  } else {
    console.log('📋 No account switch in progress');
  }
})();
