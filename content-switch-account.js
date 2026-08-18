// Content script for Amazon Switch Account page
// Handles automatic account switching for multi-account parsing

console.log('🔄 Switch Account script loaded on:', window.location.href);

function switchLog(step, detail = {}) {
  try {
    chrome.runtime.sendMessage({ action: 'multiAccountLog', step: `switch-account:${step}`, detail });
  } catch (e) { /* SW may be starting, ignore */ }
}

function normalizeSwitchEmail(value) {
  return String(value || '').trim().toLowerCase();
}

async function readFreshSwitchIntent(expected) {
  const [ownership, data] = await Promise.all([
    chrome.runtime.sendMessage({ action: 'getAmazonParserContext' }).catch(() => null),
    chrome.storage.local.get(['pendingAccountSwitch', 'amazonFinalReturn'])
  ]);
  const pending = data.pendingAccountSwitch;
  const matches = !!ownership?.owned
    && ownership.runId === expected.runId
    && ownership.tabId === expected.tabId
    && normalizeSwitchEmail(ownership.account) === normalizeSwitchEmail(expected.account)
    && pending?.runId === expected.runId
    && normalizeSwitchEmail(pending?.email) === normalizeSwitchEmail(expected.account)
    && !!data.amazonFinalReturn === expected.finalReturn;
  return matches ? { ownership, pending, finalReturn: !!data.amazonFinalReturn } : null;
}

// Only run on switch account picker page
if (!window.location.href.includes('switch_account=picker') && !window.location.href.includes('switchacct')) {
  console.log('📋 Not a switch account page, skipping');
} else {
  (async function() {
    console.log('🔄 Switch account page detected!');
    switchLog('picker-loaded', { url: window.location.href.slice(0, 120) });

    // Wait a bit for background to set the flag
    await new Promise(resolve => setTimeout(resolve, 1000));

    // The shared Chrome can have another Amazon switch-account tab.  Only the
    // tab explicitly created/owned by the active parser run may consume the
    // global pendingAccountSwitch instruction.
    const ownership = await chrome.runtime.sendMessage({ action: 'getAmazonParserContext' }).catch(() => null);
    if (!ownership?.owned) {
      console.log('⏭ Not the parser-owned Amazon tab; leaving this picker untouched');
      return;
    }
    
    // Check if we need to switch account (with retry)
    let data = await chrome.storage.local.get(['pendingAccountSwitch']);
    
    // Retry after delay if not found
    if (!data.pendingAccountSwitch) {
      console.log('📋 No pending account switch yet, waiting...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      data = await chrome.storage.local.get(['pendingAccountSwitch']);
    }
    
    if (!data.pendingAccountSwitch) {
      console.log('📋 No pending account switch after retry');
      console.log('📋 Storage data:', JSON.stringify(data));
      return;
    }
    
    if (!data.pendingAccountSwitch.runId || data.pendingAccountSwitch.runId !== ownership.runId) {
      console.log('⏭ Stale pendingAccountSwitch ignored');
      return;
    }
    console.log('✅ Found pending switch to:', data.pendingAccountSwitch.email);
    
    const targetEmail = data.pendingAccountSwitch.email;
    const expectedIntent = {
      runId: ownership.runId,
      tabId: ownership.tabId,
      account: targetEmail,
      finalReturn: !!(await chrome.storage.local.get(['amazonFinalReturn'])).amazonFinalReturn
    };
    console.log(`🎯 Looking for account: ${targetEmail}`);
    
    // Wait for page to fully load
    await new Promise(resolve => setTimeout(resolve, 2500));

    if (!await readFreshSwitchIntent(expectedIntent)) {
      console.log('⏭ Amazon switch intent changed while picker was settling');
      return;
    }
    
    // Debug: log page content
    console.log('📄 Page text:', document.body.innerText.substring(0, 1500));
    
    // Check if target email is visible on page
    if (!document.body.innerText.includes(targetEmail)) {
      console.log(`❌ Email ${targetEmail} not found in page text!`);
      switchLog('email-missing', { targetEmail, bodyPreview: document.body.innerText.slice(0, 400) });
      const failureIntent = await readFreshSwitchIntent(expectedIntent);
      if (!failureIntent) return;
      chrome.runtime.sendMessage({
        action: 'accountSwitchFailed',
        email: targetEmail,
        runId: expectedIntent.runId,
        error: 'Email not visible on page'
      });
      return;
    }

    console.log(`✅ Email ${targetEmail} found in page text`);
    switchLog('email-found', { targetEmail });
    
    // Find all account rows - each account is in a container with avatar + name + email
    const allDivs = Array.from(document.querySelectorAll('div'));
    
    let targetRow = null;
    
    for (const div of allDivs) {
      // Check if this div contains our target email
      if (div.textContent.includes(targetEmail) && div.textContent.length < 400) {
        // Save this as potential target row (prefer smaller/more specific containers)
        if (!targetRow || div.textContent.length < targetRow.textContent.length) {
          targetRow = div;
        }
      }
    }
    
    if (targetRow) {
      console.log(`🖱️ Found target row for: ${targetEmail}`);
      console.log('Row HTML:', targetRow.outerHTML.substring(0, 300));
      const clickIntent = await readFreshSwitchIntent(expectedIntent);
      if (!clickIntent) {
        console.log('⏭ Amazon switch intent changed before picker mutation');
        return;
      }
      const isFinalReturn = clickIntent.finalReturn;
      
      // Only parse after a real account switch. Final return must land on home and
      // let content-amazon-redirect.js clear amazonFinalReturn without starting parse.
      if (!isFinalReturn) {
        await chrome.storage.local.set({
          accountSwitchInProgress: true,
          switchedToEmail: targetEmail
        });
      } else {
        await chrome.storage.local.remove(['accountSwitchInProgress', 'switchedToEmail']);
      }
      
      // Find the best element to click - avoid "Sign out" links!
      let clickTarget = null;
      
      // Try to find clickable elements that are NOT sign out
      const links = targetRow.querySelectorAll('a');
      for (const link of links) {
        if (!link.textContent.includes('Sign out') && !link.href.includes('signout')) {
          clickTarget = link;
          break;
        }
      }
      
      // If no link, try the row itself or a name element
      if (!clickTarget) {
        const nameEl = targetRow.querySelector('[class*="name"]') || 
                      targetRow.querySelector('span') ||
                      targetRow;
        if (!nameEl.textContent.includes('Sign out')) {
          clickTarget = nameEl;
        }
      }

      // DOM discovery and storage writes both await. Re-read exact ownership and
      // pending intent immediately before the click so an old picker cannot
      // consume or execute a newer run's switch.
      const finalClickIntent = await readFreshSwitchIntent(expectedIntent);
      if (!finalClickIntent) {
        console.log('⏭ Amazon switch intent changed before click');
        return;
      }
      
      if (clickTarget) {
        console.log('🖱️ Clicking:', clickTarget.tagName, clickTarget.textContent.substring(0, 50));
        switchLog('click-done', { targetEmail, tag: clickTarget.tagName, text: clickTarget.textContent.slice(0, 80) });
        clickTarget.click();
      } else {
        console.log('🖱️ Clicking row directly');
        switchLog('click-done', { targetEmail, fallback: 'row' });
        targetRow.click();
      }

      // Do not force a redirect after click. The Amazon navigation itself is
      // the account-switch proof. If the click was ignored or slow, the
      // watchdog must retry/fail instead of parsing the old cabinet under the
      // target email.

    } else {
      console.log(`❌ Could not find clickable element for ${targetEmail}`);
      switchLog('no-click-target', { targetEmail });

      const failureIntent = await readFreshSwitchIntent(expectedIntent);
      if (!failureIntent) return;
      chrome.runtime.sendMessage({
        action: 'accountSwitchFailed',
        email: targetEmail,
        runId: expectedIntent.runId,
        error: 'Could not find clickable account element'
      });
    }
  })();
}
