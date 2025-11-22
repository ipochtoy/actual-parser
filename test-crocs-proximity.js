// Открой страницу с заказом 114-5434563-5138656 и запусти этот скрипт

(function() {
  console.log('\n\n🔬 ДИАГНОСТИКА CROCS ORDER\n');
  
  const ORDER_ID = '114-5434563-5138656';
  
  // Find order card
  const cards = document.querySelectorAll('.order-card, .js-order-card, .a-box-group.order, [data-test-id="order-card"], [data-order-id]');
  
  let targetCard = null;
  for (const card of cards) {
    if (card.textContent.includes(ORDER_ID)) {
      targetCard = card;
      break;
    }
  }
  
  if (!targetCard) {
    console.error('❌ Order not found!');
    return;
  }
  
  console.log('✅ Order card found\n');
  
  // Find track buttons
  const trackButtons = targetCard.querySelectorAll('a[href*="ship-track"]');
  console.log(`📦 Found ${trackButtons.length} track buttons\n`);
  
  trackButtons.forEach((btn, idx) => {
    console.log(`\n━━━ TRACK BUTTON ${idx + 1} ━━━`);
    
    const href = btn.href;
    const itemId = href.match(/itemId=([^&]+)/)?.[1];
    console.log(`🔗 URL: ${href.substring(0, 100)}...`);
    console.log(`📍 itemId: ${itemId}`);
    
    // Go UP and see what's around
    console.log('\n🔍 Going UP from button:\n');
    
    let parent = btn;
    for (let level = 1; level <= 10; level++) {
      parent = parent.parentElement;
      if (!parent) break;
      
      const products = parent.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]');
      
      if (products.length > 0) {
        console.log(`  Level ${level} (${parent.tagName}.${Array.from(parent.classList).join('.')}): ${products.length} products`);
        
        products.forEach((p, i) => {
          const title = p.querySelector('img')?.alt || p.textContent?.trim().substring(0, 50) || 'No title';
          const asin = p.href.match(/\/(?:dp|product)\/([A-Z0-9]{10})/)?.[1];
          console.log(`    ${i+1}. ${title}... [${asin}]`);
        });
      }
    }
    
    // Check SIBLINGS of button's parent
    console.log('\n🔍 Checking SIBLINGS:\n');
    const btnParent = btn.closest('.a-row, .a-box, .shipment');
    if (btnParent && btnParent.parentElement) {
      const siblings = Array.from(btnParent.parentElement.children);
      const btnIndex = siblings.indexOf(btnParent);
      
      console.log(`  Button is at index ${btnIndex} of ${siblings.length} siblings`);
      
      // Check previous sibling
      if (btnIndex > 0) {
        const prevSibling = siblings[btnIndex - 1];
        const prevProducts = prevSibling.querySelectorAll('a[href*="/dp/"]');
        console.log(`  PREV sibling: ${prevProducts.length} products`);
        prevProducts.forEach((p, i) => {
          const title = p.querySelector('img')?.alt || p.textContent?.trim().substring(0, 50);
          console.log(`    ${i+1}. ${title}...`);
        });
      }
      
      // Check next sibling
      if (btnIndex < siblings.length - 1) {
        const nextSibling = siblings[btnIndex + 1];
        const nextProducts = nextSibling.querySelectorAll('a[href*="/dp/"]');
        console.log(`  NEXT sibling: ${nextProducts.length} products`);
        nextProducts.forEach((p, i) => {
          const title = p.querySelector('img')?.alt || p.textContent?.trim().substring(0, 50);
          console.log(`    ${i+1}. ${title}...`);
        });
      }
    }
  });
  
  console.log('\n\n✅ DONE\n');
  
})();
