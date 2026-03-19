// Content script for Amazon main page after account switch
// Redirects to orders page if account switch just happened

console.log('🔄 Amazon redirect script loaded on:', window.location.href);

(async function() {
  // Skip if already on order-history page (avoid redirect loop)
  if (window.location.href.includes('order-history')) {
    console.log('📋 Already on order-history, clearing switch flag...');
    await chrome.storage.local.remove(['accountSwitchInProgress', 'switchedToEmail']);
    return;
  }
  
  // Skip if on signin page (let switch-account script handle it)
  if (window.location.href.includes('/ap/signin')) {
    console.log('📋 On signin page, skipping redirect');
    return;
  }
  
  // Check if we just switched accounts and need to go to orders
  const data = await chrome.storage.local.get(['accountSwitchInProgress', 'switchedToEmail']);
  
  console.log('📋 Checking for account switch flag:', data);
  
  if (data.accountSwitchInProgress) {
    console.log(`✅ Account switch completed to ${data.switchedToEmail}, redirecting to orders...`);
    
    // Clear flag BEFORE redirect to avoid loops
    await chrome.storage.local.remove(['accountSwitchInProgress', 'switchedToEmail']);
    
    // Small delay to let page settle
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Redirect to orders page
    window.location.href = 'https://www.amazon.com/gp/your-account/order-history?orderFilter=year-2025';
  } else {
    console.log('📋 No account switch in progress');
  }
})();
