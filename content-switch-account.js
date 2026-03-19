// Content script for Amazon Switch Account page
// Handles automatic account switching for multi-account parsing

console.log('🔄 Switch Account script loaded on:', window.location.href);

// Only run on switch account picker page
if (!window.location.href.includes('switch_account=picker') && !window.location.href.includes('switchacct')) {
  console.log('📋 Not a switch account page, skipping');
} else {
  (async function() {
    console.log('🔄 Switch account page detected!');
    
    // Wait a bit for background to set the flag
    await new Promise(resolve => setTimeout(resolve, 1000));
    
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
    
    console.log('✅ Found pending switch to:', data.pendingAccountSwitch.email);
    
    const targetEmail = data.pendingAccountSwitch.email;
    console.log(`🎯 Looking for account: ${targetEmail}`);
    
    // Wait for page to fully load
    await new Promise(resolve => setTimeout(resolve, 2500));
    
    // Debug: log page content
    console.log('📄 Page text:', document.body.innerText.substring(0, 1500));
    
    // Check if target email is visible on page
    if (!document.body.innerText.includes(targetEmail)) {
      console.log(`❌ Email ${targetEmail} not found in page text!`);
      await chrome.storage.local.remove(['pendingAccountSwitch']);
      chrome.runtime.sendMessage({ 
        action: 'accountSwitchFailed', 
        email: targetEmail,
        error: 'Email not visible on page'
      });
      return;
    }
    
    console.log(`✅ Email ${targetEmail} found in page text`);
    
    // Find all account rows - each account is in a container with avatar + name + email
    const allDivs = Array.from(document.querySelectorAll('div'));
    
    let targetRow = null;
    let isAlreadySelected = false;
    
    for (const div of allDivs) {
      // Check if this div contains our target email
      if (div.textContent.includes(targetEmail) && div.textContent.length < 400) {
        // Check if this row has a checkmark (means already selected)
        const hasCheckmark = div.querySelector('svg') !== null || 
                            div.innerHTML.includes('✓') ||
                            div.innerHTML.includes('✔') ||
                            div.querySelector('[class*="check"]') !== null;
        
        // Look for checkmark more precisely - should be INSIDE this account row
        const svgs = div.querySelectorAll('svg');
        let hasCheckmarkSvg = false;
        for (const svg of svgs) {
          // Checkmark SVGs usually have path with specific pattern
          if (svg.innerHTML.includes('path') && svg.closest('div')?.textContent.includes(targetEmail)) {
            // Check if svg is actually a checkmark (near the avatar, not a signout icon)
            const svgParent = svg.parentElement;
            if (svgParent && !svgParent.textContent.includes('Sign out')) {
              hasCheckmarkSvg = true;
            }
          }
        }
        
        console.log(`📋 Found container for ${targetEmail}, length=${div.textContent.length}, hasCheckmark=${hasCheckmark}, hasCheckmarkSvg=${hasCheckmarkSvg}`);
        
        // If has checkmark, this account is already selected
        if (hasCheckmarkSvg) {
          isAlreadySelected = true;
          console.log('✅ This account appears to be already selected!');
          break;
        }
        
        // Save this as potential target row (prefer smaller/more specific containers)
        if (!targetRow || div.textContent.length < targetRow.textContent.length) {
          targetRow = div;
        }
      }
    }
    
    if (isAlreadySelected) {
      console.log('🚀 Already on target account, going straight to orders!');
      await chrome.storage.local.remove(['pendingAccountSwitch']);
      await chrome.storage.local.set({ 
        accountSwitchInProgress: true,
        switchedToEmail: targetEmail 
      });
      window.location.href = 'https://www.amazon.com/gp/your-account/order-history?orderFilter=year-2025';
      return;
    }
    
    if (targetRow) {
      console.log(`🖱️ Found target row for: ${targetEmail}`);
      console.log('Row HTML:', targetRow.outerHTML.substring(0, 300));
      
      // Clear pending switch before clicking
      await chrome.storage.local.remove(['pendingAccountSwitch']);
      
      // Set flag that we switched
      await chrome.storage.local.set({ 
        accountSwitchInProgress: true,
        switchedToEmail: targetEmail 
      });
      
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
      
      if (clickTarget) {
        console.log('🖱️ Clicking:', clickTarget.tagName, clickTarget.textContent.substring(0, 50));
        clickTarget.click();
      } else {
        console.log('🖱️ Clicking row directly');
        targetRow.click();
      }
      
      // Wait and redirect to orders
      setTimeout(() => {
        console.log('🔄 Redirecting to orders page...');
        window.location.href = 'https://www.amazon.com/gp/your-account/order-history?orderFilter=year-2025';
      }, 2000);
      
    } else {
      console.log(`❌ Could not find clickable element for ${targetEmail}`);
      
      await chrome.storage.local.remove(['pendingAccountSwitch']);
      chrome.runtime.sendMessage({ 
        action: 'accountSwitchFailed', 
        email: targetEmail,
        error: 'Could not find clickable account element'
      });
    }
  })();
}
