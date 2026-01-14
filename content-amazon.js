/* content-amazon.js — v7.3 (Quantity fix - product-image__qty) */

(function () {
  console.log("🚀 Amazon Parser v7.3 (+ Quantity via .product-image__qty)");

  // Check for auto-parse flag on page load
  (async function checkAutoParse() {
    console.log('🔍 Checking for auto-parse flag...');
    
    const data = await chrome.storage.local.get(['autoParsePending', 'autoParse_amazon', 'autoParseTimestamp']);
    
    const shouldAutoParse = (data.autoParsePending === 'amazon') || data.autoParse_amazon;
    const timestamp = data.autoParseTimestamp || data.autoParse_amazon;
    
    const isRecent = timestamp && (Date.now() - timestamp < 10000);
    
    if (shouldAutoParse && isRecent) {
      console.log('✅ Auto-parse flag found! Starting parse in 2 seconds...');
      
      await chrome.storage.local.remove(['autoParsePending', 'autoParse_amazon', 'autoParseTimestamp']);
      
      setTimeout(() => {
        console.log('🚀 Starting auto-parse with pagination...');
        // Notify background that parsing actually started
        chrome.runtime.sendMessage({
          action: 'parserStarted',
          store: 'Amazon'
        });
        // Auto-mode: Parse up to 30 pages
        parseAmazonOrdersWithPagination({ pages: 30 });
      }, 3000); // Increased delay to 3s
    } else {
      console.log('ℹ️ No auto-parse flag (or expired)');
    }
  })();

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const htmlDecode = (s) => { const t = document.createElement("textarea"); t.innerHTML = s || ""; return (t.value || "").trim(); };
  const safeJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const bySel = (root, sel) => Array.from(root.querySelectorAll(sel));

  // --- VISUAL OVERLAY HELPER ---
  function showOverlay(text, color = '#28a745') {
    let el = document.getElementById('amazon-parser-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'amazon-parser-overlay';
      Object.assign(el.style, {
        position: 'fixed',
        top: '10px',
        right: '10px',
        padding: '15px 25px',
        zIndex: '2147483647', // Max z-index
        borderRadius: '8px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        fontFamily: 'sans-serif',
        fontWeight: 'bold',
        fontSize: '16px',
        pointerEvents: 'none', // Allow clicking through
        transition: 'all 0.3s ease'
      });
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.backgroundColor = color;
    el.style.color = 'white';
    el.style.display = 'block';
  }

  let PARSE_MODE = 'warehouse'; // 'warehouse' or 'financial'

  // NEW: Listener for explicit parse command (backup trigger)
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Update Mode
    if (request.options && request.options.mode) {
        PARSE_MODE = request.options.mode;
        console.log(`ℹ️ SET PARSE_MODE = ${PARSE_MODE}`);
    }

    // Handle forced parse
    if (request.action === "parse" || request.action === "autoParse") {
        console.log("📨 Forced parse command received!", request);
        showOverlay(`🚀 ЗАПУСК (${PARSE_MODE})...`, "#d35400");
        // Use a small delay to ensure overlay renders
        setTimeout(() => parseAmazonOrdersWithPagination(request.options || { pages: 30 }), 100);
        sendResponse({ status: "started" });
        return;
    }
    // Handle legacy parse
    if (request.action === "parseAmazon" || request.action === "parseAmazonOrders") {
         console.log("📨 Legacy parse command received!");
         showOverlay(`🚀 ЗАПУСК (${PARSE_MODE})...`, "#d35400");
         setTimeout(() => parseAmazonOrdersWithPagination(request.options || { pages: 30 }), 100);
         sendResponse({ status: "started" });
    }
  });

  // ... (helpers) ...

  function extractFinancialDetails(card, orderId) {
      console.log(`\n💰 [FINANCIAL DEBUG] Analyzing Order ${orderId}`);
      
      // 1. Log raw text for user inspection
      const text = card.innerText || "";
      console.log(`📄 RAW TEXT:\n${text.substring(0, 200)}...`);
      
      // 2. Try to find price
      const priceMatch = text.match(/Total\s*[\$:]([\d,]+\.\d{2})/i) || text.match(/[\$:]([\d,]+\.\d{2})/);
      const total = priceMatch ? priceMatch[1] : "???";
      
      // 3. Try to find hidden JSON (often in data-yo-serp-item or similar)
      const dataset = Object.assign({}, card.dataset);
      console.log(`💾 DATASET:`, dataset);
      
      // 4. Look for hidden inputs
      const hiddenInputs = Array.from(card.querySelectorAll('input[type="hidden"]')).map(i => `${i.name}=${i.value}`);
      if(hiddenInputs.length) console.log(`HIDDEN INPUTS:`, hiddenInputs);

      return {
          total_amount: total,
          currency: "$", // Assumption
          detected_tax: "0.00", // Placeholder
          raw_debug: text.substring(0, 100)
      };
  }

  function findProductAnchors(root) {
    const anchors = Array.from((root || document).getElementsByTagName("a"));
    const rx = /\/(?:dp|gp\/product)\//i;
    return anchors.filter(a => {
      try {
        const h = a.getAttribute("href") || a.href || "";
        return rx.test(h);
      } catch { return false; }
    });
  }

  function extractTitleFromDOM(scope) {
    const anchors = ["a.a-link-normal[href*=\"/gp/product/\"]", "a.a-link-normal[href*=\"/dp/\"]", "a[href*=\"/gp/product/\"]", "a[href*=\"/dp/\"]"];
    for (const sel of anchors) {
      const a = scope.querySelector(sel);
      if (a) {
        const tt = a.textContent?.trim(); 
        if (tt && tt.length > 5) return tt;
        const s = a.querySelector("span"); 
        if (s && s.textContent?.trim()) return s.textContent.trim();
      }
    }
    const full = scope.querySelector(".a-truncate .a-truncate-full"); 
    if (full && full.textContent?.trim()) return full.textContent.trim();
    const cut = scope.querySelector(".a-truncate .a-truncate-cut");  
    if (cut && cut.textContent?.trim()) return cut.textContent.trim();
    const img = scope.querySelector("img[alt]"); 
    if (img && img.alt && img.alt.trim().length > 10) return img.alt.trim();
    return "";
  }

  // v7.3: Extract quantity from product card (badge on image or text)
  function extractQuantityFromDOM(scope) {
    // 1. ПЕРВЫМ ДЕЛОМ: Ищем span.product-image__qty (точный селектор Amazon)
    const qtySpan = scope.querySelector('span.product-image__qty, .product-image__qty');
    if (qtySpan) {
      const text = qtySpan.textContent?.trim();
      if (text && /^\d+$/.test(text)) {
        console.log(`  📊 QTY found via .product-image__qty: ${text}`);
        return text;
      }
    }
    
    // 2. Ищем в родительских элементах (если scope слишком узкий)
    let parent = scope.parentElement;
    for (let i = 0; i < 5 && parent; i++) {
      const qtyInParent = parent.querySelector('span.product-image__qty, .product-image__qty');
      if (qtyInParent) {
        const text = qtyInParent.textContent?.trim();
        if (text && /^\d+$/.test(text)) {
          console.log(`  📊 QTY found via parent .product-image__qty: ${text}`);
          return text;
        }
      }
      parent = parent.parentElement;
    }
    
    // 3. Ищем картинку товара и число рядом с ней
    const img = scope.querySelector('img[alt]');
    if (img) {
      // Ищем в родительских элементах картинки (до 5 уровней)
      let container = img.parentElement;
      for (let i = 0; i < 5 && container; i++) {
        // Ищем все текстовые узлы и элементы с числами
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while (node = walker.nextNode()) {
          const text = node.textContent?.trim();
          // Число от 2 до 99, стоящее отдельно
          if (/^[2-9]\d?$/.test(text)) {
            console.log(`  📊 Quantity found via text node near image: ${text}`);
            return text;
          }
        }
        container = container.parentElement;
      }
    }
    
    // 2. Ищем span/div с числом внутри item контейнера
    const itemContainers = [
      '.yohtmlc-item',
      '.a-fixed-left-grid-inner',
      '.a-row.shipment',
      '[class*="item"]'
    ];
    
    for (const sel of itemContainers) {
      const itemEl = scope.closest(sel) || scope.querySelector(sel);
      if (itemEl) {
        // Ищем элементы которые содержат только число
        const allElements = itemEl.querySelectorAll('span, div');
        for (const el of allElements) {
          const text = el.textContent?.trim();
          // Число 2-99, элемент содержит ТОЛЬКО это число
          if (/^[2-9]\d?$/.test(text) && el.children.length === 0) {
            // Убедимся что это не часть цены
            const parentText = el.parentElement?.textContent || '';
            if (!parentText.includes('$') && !parentText.includes('price')) {
              console.log(`  📊 Quantity found via element in item container: ${text}`);
              return text;
            }
          }
        }
      }
    }
    
    // 3. Ищем паттерн "Qty: X" или "Quantity: X" в тексте
    const scopeText = scope.textContent || '';
    const qtyMatch = scopeText.match(/(?:Qty|Quantity)[:\s]*(\d+)/i);
    if (qtyMatch && parseInt(qtyMatch[1]) > 0) {
      console.log(`  📊 Quantity found via Qty text pattern: ${qtyMatch[1]}`);
      return qtyMatch[1];
    }
    
    // 4. Поиск в item-view-left-col (где картинка)
    const leftCol = scope.querySelector('.item-view-left-col-inner, .a-fixed-left-grid-col, [class*="left-col"]');
    if (leftCol) {
      const text = leftCol.textContent?.trim();
      // Извлекаем все числа
      const numbers = text.match(/\b([2-9]\d?)\b/g);
      if (numbers && numbers.length === 1) {
        console.log(`  📊 Quantity found in left column: ${numbers[0]}`);
        return numbers[0];
      }
    }
    
    // 5. Последняя попытка - найти любой элемент с классом содержащим qty/quantity/count
    const qtyElements = scope.querySelectorAll('[class*="qty"], [class*="quantity"], [class*="count"], [class*="badge"]');
    for (const el of qtyElements) {
      const text = el.textContent?.trim();
      const match = text?.match(/^(\d+)$/);
      if (match && parseInt(match[1]) > 1) {
        console.log(`  📊 Quantity found via qty-class element: ${match[1]}`);
        return match[1];
      }
    }
    
    console.log('  📊 Quantity not found, defaulting to 1');
    return "1"; // default
  }

  function extractASINFromLink(href) {
    if (!href) return "";
    const m = href.match(/\/(?:dp|product)\/([A-Z0-9]{8,10})/i);
    return m ? m[1].toUpperCase() : "";
  }

  function closestItemScope(node) {
    const isItem = (el) => el && el.matches && el.matches(".yohtmlc-item, [data-test-id=\"item-row\"], .a-fixed-left-grid-inner, .a-row");
    let cur = node;
    for (let i = 0; i < 8 && cur; i++, cur = cur.parentElement) if (isItem(cur)) return cur;
    return node;
  }

  function collectNearbyJSON(scope) {
    const blobs = []; const take = (el) => {
      if (!el) return;
      bySel(el, "script[type=\"a-state\"]").forEach(s => { const j = safeJSON(s.textContent || ""); if (j && typeof j === "object") blobs.push(j); });
      bySel(el, "[data-a-state]").forEach(n => { const j = safeJSON(n.getAttribute("data-a-state") || ""); if (j && typeof j === "object") blobs.push(j); });
    };
    take(scope); take(scope && scope.parentElement); return blobs;
  }

  function pickTitleFromJSON(blobs) {
    const keys = ["title","productTitle","itemTitle","asinTitle","product_name"];
    for (const b of blobs) {
      for (const k of keys) { const v = b && b[k]; if (typeof v === "string" && v.trim()) return v.trim(); }
      const stack = [b];
      while (stack.length) {
        const cur = stack.pop(); if (!cur || typeof cur !== "object") continue;
        for (const k of keys) { const v = cur[k]; if (typeof v === "string" && v.trim()) return v.trim(); }
        for (const v of Object.values(cur)) if (v && typeof v === "object") stack.push(v);
      }
    }
    return "";
  }

  // === SIMPLE TRACKING FETCH (from v5.5 - WORKING VERSION) ===
  function describeTrackButton(btn, idx) {
    const href = btn.getAttribute("href") || "";
    const dataPopover = btn.getAttribute("data-a-popover-href") || "";
    const dataPopoverJson = btn.getAttribute("data-a-popover") || "";
    const action = btn.getAttribute("data-a-expander-target") || "";
    const ds = btn.dataset ? JSON.stringify(btn.dataset) : "";
    console.log(`    🔘 Track button [${idx}] href=${href.substring(0, 120)}... popover=${dataPopover.substring(0, 120)}... dataset=${ds}`);
    if (dataPopoverJson) {
      console.log(`      📦 data-a-popover JSON: ${dataPopoverJson.substring(0, 150)}...`);
    }
    if (action) {
      console.log(`      🎯 data-a-expander-target: ${action}`);
    }
  }

  function findTrackButtons(ctx) {
    const selectors = [
      'a[href*="ship-track"]',
      'a[href*="track-package"]',
      'a[href*="progress-tracker"]',
      'button[data-action="amzn-track-package"]',
      'button[data-a-popover-href*="track"]'
    ];
    const uniq = new Set();
    const out = [];
    selectors.forEach(sel => {
      ctx.querySelectorAll(sel).forEach(btn => {
        if (!uniq.has(btn)) {
          uniq.add(btn);
          out.push(btn);
        }
      });
    });
    return out;
  }

  function findAllUSPSTrackingInText(html) {
    if (!html) return [];
    const regex = /(9\d{21,})/g;
    const out = [];
    let match;
    while ((match = regex.exec(html))) {
      const candidate = match[1];
      if (candidate && candidate.length >= 22 && candidate.length <= 30) {
        out.push(candidate);
      }
    }
    return out;
  }

  async function fetchTrackingFromShipTrackUrl(url, options = {}) {
    try {
      console.log(`    🔗 Fetching: ${url.substring(0, 80)}...`);
      const response = await fetch(url, { credentials: 'include' });
      const html = await response.text();

      // Simple patterns - TBA and USPS only (UPS removed)
      const patterns = [
        { re: /(TBA\d{6,})/, label: 'TBA' },
        { re: /(9\d{21,})/, label: 'USPS' },
      ];

      for (const { re, label } of patterns) {
        const match = html.match(re);
        if (match) {
          const track = match[1].replace(/\s+/g, '');
          console.log(`    ✅ ${label} track found: ${track}`);
          return [track];
        }
      }

      console.log('    ⚠️ No tracking found in fetched page');
      return [];
    } catch (err) {
      console.error('    ❌ Fetch error:', err);
      return [];
    }
  }

  async function fetchFromPopover(popoverHref) {
    try {
      const res = await fetch(popoverHref, { credentials: 'include' });
      if (!res.ok) return [];
      const html = await res.text();
      const tracks = findAllUSPSTrackingInText(html);
      console.log(`    📄 Popover ${popoverHref.substring(0, 80)}... USPS tracks: ${JSON.stringify(tracks)}`);
      return tracks;
    } catch (err) {
      console.warn('    ⚠️ Popover fetch failed:', err);
      return [];
    }
  }

  async function parseIndividualItemSimpleByTrackUrl(card, productLink, orderId, trackUrl) {
    const scope = closestItemScope(productLink || card);
    
    // PRODUCT NAME - keep the good v6.6 logic
    let title = extractTitleFromDOM(scope);
    if (!title) {
      const blobs = collectNearbyJSON(scope);
      const alt = pickTitleFromJSON(blobs);
      if (alt) title = alt;
    }
    if (!title) {
      const img = scope.querySelector("img[alt]");
      if (img && img.alt && img.alt.trim().length > 10) title = img.alt.trim();
    }
    if (!title) {
      console.log("  ❌ No product name found");
      return null;
    }
    title = htmlDecode(title);
    console.log(`  📦 Product: ${title.substring(0, 70)}…`);
    
    // v6.7.5: Check if product has individual Order ID (multi-order shipment detection)
    const scopeText = scope.textContent || '';
    const orderMatch = scopeText.match(/Order #?\s*(\d{3}-\d{7}-\d{7})/i);
    const individualOrderId = orderMatch ? orderMatch[1] : orderId;
    
    // Detect if product is from DIFFERENT order
    const isMultiOrderShipment = individualOrderId !== orderId;
    
    if (isMultiOrderShipment) {
      console.log(`  🚨 ВНИМАНИЕ! Товар из ДРУГОГО заказа!`);
      console.log(`  📦 Order карточки: ${orderId}`);
      console.log(`  🔖 Order товара: ${individualOrderId}`);
    }
    
    // Fetch tracking from provided URL (already contains shipmentId)
    const trackResults = await fetchTrackingFromShipTrackUrl(trackUrl);
    
    if (!trackResults || trackResults.length === 0) {
      console.log('  ❌ No tracking number');
      return null;
    }
    
    const trackNumber = trackResults[0]; // Take first track
    
    // Skip if equals ORDER ID
    if (trackNumber === orderId) {
      console.log('  ❌ Tracking equals ORDER ID, skipping');
      return null;
    }
    
    const asin = extractASINFromLink(productLink && productLink.href);
    console.log(`  🔗 ASIN: ${asin || "—"}`);
    console.log(`  ✅ TRACK: ${trackNumber}`);

    // v7.1: Extract actual quantity
    const qty = extractQuantityFromDOM(scope);
    console.log(`  📊 QTY: ${qty}`);

    return {
      store_name: "Amazon",
      order_id: individualOrderId,  // ← Use INDIVIDUAL Order ID!
      track_number: trackNumber,
      product_name: title,
      qty: qty,
      color: isMultiOrderShipment ? "⚠️ РАЗНЫЕ ЗАКАЗЫ" : "",  // ← WARNING in color field!
      size: ""
    };
  }

  async function getTracksForShipment(trackButtons, defaultTrackLink) {
    const allTracks = [];

    for (const btn of trackButtons) {
      const popHref = btn.getAttribute('data-a-popover-href');
      if (popHref) {
        const tracks = await fetchFromPopover(popHref);
        allTracks.push(...tracks);
      }
    }

    if (!allTracks.length && defaultTrackLink) {
      const linkTracks = await fetchTrackingFromShipTrackUrl(defaultTrackLink, { expectMultiple: true });
      allTracks.push(...linkTracks);
    }

    return Array.from(new Set(allTracks));
  }

  async function parseIndividualItemSimple(card, productLink, orderId) {
    const scope = closestItemScope(productLink || card);
    let title = extractTitleFromDOM(scope);
    if (!title) {
      console.log('  ❌ No title found');
      return null;
    }
    console.log(`  📦 Product: ${title.substring(0, 70)}…`);

    const cardScope = closestItemScope(card);
    const trackButtons = cardScope ? findTrackButtons(cardScope) : [];
    trackButtons.forEach((btn, idx) => describeTrackButton(btn, idx));

    // 1. Find track link - расширенные селекторы
    let trackLink = scope.querySelector('a[href*="ship-track"], a[href*="progress-tracker"], a[href*="track-package"], a[href*="tracking"]');
    
    // Если не найден в scope, ищем в родительских элементах
    if (!trackLink) {
      const parent = scope.parentElement;
      if (parent) {
        trackLink = parent.querySelector('a[href*="ship-track"], a[href*="progress-tracker"], a[href*="track-package"], a[href*="tracking"]');
      }
    }
    
    // Если все еще не найден, ищем в соседних элементах
    if (!trackLink) {
      const parent = scope.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children);
        const currentIndex = siblings.indexOf(scope);
        // Ищем в следующих 2 элементах после текущего товара
        for (let k = currentIndex + 1; k < Math.min(currentIndex + 3, siblings.length); k++) {
          const sibling = siblings[k];
          const foundLink = sibling.querySelector('a[href*="ship-track"], a[href*="progress-tracker"], a[href*="track-package"], a[href*="tracking"]');
          if (foundLink) {
            trackLink = foundLink;
            break;
          }
        }
      }
    }
    
    if (!trackLink) {
      console.log('  ❌ No track link found');
      // Отладочная информация
      console.log('  🔍 Scope HTML:', scope.outerHTML.substring(0, 200) + '...');
      return null;
    }
    
    console.log('  ✅ Track link found:', trackLink.href);
    
    // 2. Fetch it
    const trackUrl = trackLink.href;

    const tracks = await getTracksForShipment(trackButtons, trackUrl);

    if (!tracks.length) {
      console.log('  ❌ No tracking number');
      return null;
    }

    const trackNumber = tracks[0];

    if (trackNumber === orderId) {
      console.log('  ❌ Tracking equals ORDER ID, skipping');
    return null;
  }

    console.log(`  ✅ TRACK: ${trackNumber}`);

    // v7.1: Extract actual quantity
    const qty = extractQuantityFromDOM(scope);
    console.log(`  📊 QTY: ${qty}`);

    return {
      store_name: 'Amazon',
      order_id: orderId,
      track_number: trackNumber,
      product_name: title,
      qty: qty,
      source_url: productLink?.href || '',
    };
  }

  function getOrderCards(doc = document) {
    const selectors = [".order-card", ".js-order-card", ".a-box-group.order", "[data-test-id=\"order-card\"]", "[data-order-id]"];
    const all = new Set();
    selectors.forEach(sel => {
      const elements = Array.from(doc.querySelectorAll(sel));
      elements.forEach(el => all.add(el));
    });
    return Array.from(all);
  }

  function getOrderId(card) { 
    const attr = card.getAttribute("data-order-id"); 
    if (attr) return attr; 
    const m = (card.textContent || "").match(/(\d{3}-\d{7}-\d{7})/); 
    return m ? m[1] : ""; 
  }

  async function parseAmazonOrders(currentPage = 1, totalPages = 1) {
    console.log(`\n📦 Запуск парсера Amazon для страницы ${currentPage}/${totalPages}`);
    
      const cards = getOrderCards(document);
      console.log(`📦 Найдено ${cards.length} карточек заказов`);
    
    if (cards.length === 0) {
      console.log("❌ Карточки заказов не найдены!");
      return { success: false, error: "Карточки заказов не найдены", orders: [] };
    }

    const allOrders = [];
    let processedCards = 0;
    const maxCards = Math.min(cards.length, 10); // Обрабатываем максимум 10 карточек

    chrome.runtime.sendMessage({ action: 'progress', store: 'Amazon', current: 0, total: maxCards, status: 'Парсинг заказов...' });

    for (let i = 0; i < maxCards; i++) {
      try {
        const card = cards[i];
        console.log(`\n--- Карточка ${i + 1}/${maxCards} ---`);
        
          const orderId = getOrderId(card);
        console.log(`📋 Order ID: ${orderId}`);
        
        if (!orderId) {
          console.log("⚠️ Order ID не найден, пропускаем");
          continue;
        }

        // --- FINANCIAL MODE HOOK ---
        let financialData = {};
        if (PARSE_MODE === 'financial') {
            financialData = extractFinancialDetails(card, orderId);
            console.log(`💰 EXTRACTED: Total=${financialData.total_amount}`);
        }
        // ---------------------------

        // Find all Track package buttons (each button = one shipment)
        const trackButtons = card.querySelectorAll('a[href*="ship-track"], a[href*="track-package"], a[href*="progress-tracker"]');
        console.log(`📦 Найдено ${trackButtons.length} кнопок Track package`);

        let cardOrders = 0;
        
        for (let j = 0; j < trackButtons.length; j++) {
          try {
            const trackBtn = trackButtons[j];
            const trackUrl = trackBtn.getAttribute('href') || trackBtn.href;
            
            if (!trackUrl) {
              console.log(`⚠️ Кнопка ${j + 1}: нет URL, пропускаем`);
              continue;
            }
            
            console.log(`\n--- Посылка ${j + 1} ---`);
            
            // SMART FIX v6.7.2: Use itemId from track button URL to find correct product
            // Extract itemId from track button URL
            const itemIdMatch = trackUrl.match(/itemId=([^&]+)/);
            const itemId = itemIdMatch ? itemIdMatch[1] : null;
            
            let productLink = null;
            
            if (itemId) {
              // Try to find product link with this itemId in its href
              console.log(`  🔍 Ищем товар с itemId: ${itemId}`);
              const allProductLinks = card.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]');
              
              for (const link of allProductLinks) {
                if (link.href.includes(itemId)) {
                  productLink = link;
                  console.log(`  ✅ Найден товар по itemId!`);
                  break;
                }
              }
            }
            
            // Fallback 1: Search products in the SAME delivery box (не пересекать границы доставок!)
            if (!productLink) {
              console.log(`  🔍 itemId не помог, ищем в том же блоке доставки`);
              
              // Find the closest delivery container
              const deliveryBox = trackBtn.closest('.delivery-box, .a-box, .shipment, [class*="delivery"]');
              
              if (deliveryBox) {
                console.log(`  📦 Нашли контейнер доставки: ${deliveryBox.className}`);
                const nearbyProducts = deliveryBox.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]');
                console.log(`  📦 В контейнере ${nearbyProducts.length} товар(ов)`);
                
                if (nearbyProducts.length > 0) {
                  // v6.7.4 FIX: Collect ALL unique products from delivery-box
                  const uniqueProducts = [];
                  const seenASINs = new Set();
                  
                  for (const product of nearbyProducts) {
                    const asin = product.href.match(/\/(?:dp|product)\/([A-Z0-9]{10})/)?.[1];
                    if (asin && !seenASINs.has(asin)) {
                      seenASINs.add(asin);
                      uniqueProducts.push(product);
                    }
                  }
                  
                  console.log(`  📦 Найдено ${uniqueProducts.length} уникальных товаров в контейнере`);
                  
                  if (uniqueProducts.length > 0) {
                    // Take first unique product (will process all in loop below)
                    productLink = uniqueProducts[0];
                    console.log(`  ✅ Взяли первый товар для обработки`);
                    
                    // Store all products for this shipment
                    trackBtn._allProducts = uniqueProducts;
                  }
                } else {
                  console.log(`  ⚠️ В контейнере доставки нет товаров!`);
                }
              } else {
                console.log(`  ⚠️ Не нашли контейнер доставки, пробуем старый метод (7 уровней вверх)`);
                // Старый fallback на случай если структура страницы другая
                let parent = trackBtn;
                for (let level = 0; level < 7 && parent; level++) {
                  parent = parent.parentElement;
                }
                
                if (parent) {
                  const nearbyProducts = parent.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]');
                  if (nearbyProducts.length > 0) {
                    productLink = nearbyProducts[0];
                    console.log(`  ✅ Взяли первый товар (старый метод)`);
                  }
                }
              }
            }
            
            // Fallback 2: Take first product from card (old behavior)
            if (!productLink) {
              console.log(`  ⚠️ Не нашли товар по itemId или рядом, берём первый из карточки (старое поведение)`);
              productLink = card.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
            }
            
            if (!productLink) {
              console.log(`  ❌ Товар не найден вообще, пропускаем`);
              continue;
            }
                        
            // v6.7.4: Process ALL products from this shipment
            const productsToProcess = trackBtn._allProducts || [productLink];
            console.log(`  🔄 Обрабатываем ${productsToProcess.length} товар(ов) из этой посылки`);
            
            for (let prodIdx = 0; prodIdx < productsToProcess.length; prodIdx++) {
              const prod = productsToProcess[prodIdx];
              const order = await parseIndividualItemSimpleByTrackUrl(card, prod, orderId, trackUrl);
              if (order) {
                // --- FINANCIAL MERGE ---
                if (PARSE_MODE === 'financial') {
                    order.financial = financialData;
                    order.total_amount = financialData.total_amount;
                    // Log for user verification
                    console.log(`  💰 Order attached financial data: ${JSON.stringify(financialData)}`);
                }
                // -----------------------
                allOrders.push(order);
                cardOrders++;
                console.log(`  ✅ Товар ${prodIdx + 1}/${productsToProcess.length}: ${order.product_name.substring(0, 50)}... | Трек: ${order.track_number}`);
              }
            }
          } catch (itemError) {
            console.error(`❌ Ошибка обработки посылки ${j + 1}:`, itemError);
          }
        }
        
        processedCards++;
        console.log(`📊 Карточка ${i + 1}: найдено ${cardOrders} товаров с трек-номерами`);
        
        // Обновляем прогресс
        chrome.runtime.sendMessage({ 
          action: 'progress', 
          store: 'Amazon', 
          current: processedCards, 
          total: maxCards, 
          status: `Стр. ${currentPage}/${totalPages} | Карт. ${processedCards}/${maxCards}...` 
        });
        
        // Небольшая пауза между карточками
        await sleep(500);
        
      } catch (cardError) {
        console.error(`❌ Ошибка обработки карточки ${i + 1}:`, cardError);
        processedCards++;
      }
    }

    console.log(`\n📊 Итого найдено: ${allOrders.length} товаров с трек-номерами на этой странице`);

    // DO NOT SEND COMPLETION MESSAGE HERE - the pagination wrapper will do it.
    // BUT we need to send progress for the current page
    chrome.runtime.sendMessage({ 
      action: 'progress', 
      store: 'Amazon', 
      current: processedCards, 
      total: maxCards, 
      status: `Page ${currentPage}/${totalPages} done.` 
    });

    return { success: true, orders: allOrders, stats: { totalCount: allOrders.length } };
  }


  // ========== PAGINATION v6.8 (wrapper, не трогает parseAmazonOrders) ==========
  const PAGINATION_STATE_KEY = 'amazonPaginationState';
  const PAGE_DELAY_MS = 2000; // 2 секунды (вернули безопасное значение)
  
  async function getPaginationState() {
    return new Promise(resolve => {
      chrome.storage.local.get(PAGINATION_STATE_KEY, (result) => {
        resolve(result[PAGINATION_STATE_KEY] || null);
      });
    });
  }

  async function shouldStop() {
    return new Promise(resolve => {
      chrome.storage.local.get('stopAllParsers', (res) => resolve(!!res.stopAllParsers));
    });
  }
  
  async function savePaginationState(state) {
    return new Promise(resolve => {
      chrome.storage.local.set({ [PAGINATION_STATE_KEY]: state }, resolve);
    });
  }
  
  async function clearPaginationState() {
    return new Promise(resolve => {
      chrome.storage.local.remove(PAGINATION_STATE_KEY, resolve);
    });
  }
  
  function clickNextPage() {
    const selectors = [
      'li.a-last:not(.a-disabled) a',
      '.a-pagination .a-last a',
      'ul.a-pagination li.a-last:not(.a-disabled) a',
      'a.s-pagination-item.s-pagination-next' // Added for new Amazon UI
    ];
    
    for (const sel of selectors) {
      const nextBtn = document.querySelector(sel);
      if (nextBtn && !nextBtn.closest('.a-disabled')) {
        console.log('🔄 Кликаем Next...');
        nextBtn.click();
        return true;
      }
    }
    console.log('⚠️ Next button not found');
    return false;
  }
  
  async function finishPaginationParsing(state) {
    console.log(`\n🎉 ПАРСИНГ ЗАВЕРШЁН!`);
    console.log(`📊 Итого: ${state.allOrders.length} товаров с ${state.totalPages} страниц`);
    console.log(`⏱️ Время: ${Math.round((Date.now() - state.startedAt) / 1000)}с`);
    
    // POST-PROCESSING: Multi-order detection (v6.7.6)
    console.log("\n🔍 POST-PROCESSING: Проверка multi-order shipments...");
    const trackMap = new Map();
    state.allOrders.forEach(order => {
      const track = order.track_number;
      if (!track) return;
      if (!trackMap.has(track)) trackMap.set(track, []);
      trackMap.get(track).push(order);
    });
    
    let multiOrderCount = 0;
    for (const [track, orders] of trackMap.entries()) {
      if (orders.length < 2) continue;
      const uniqueOrderIds = new Set(orders.map(o => o.order_id));
      if (uniqueOrderIds.size > 1) {
        multiOrderCount++;
        console.log(`  🚨 Multi-order #${multiOrderCount}: ${track}`);
        console.log(`     Товаров: ${orders.length}, Заказов: ${uniqueOrderIds.size}`);
        orders.forEach(order => { order.color = "⚠️ РАЗНЫЕ ЗАКАЗЫ"; });
      }
    }
    
    if (multiOrderCount > 0) {
      console.log(`\n✅ Найдено ${multiOrderCount} multi-order shipments`);
    } else {
      console.log("  ✅ Multi-order shipments не найдены");
    }
    
    // Final save
    const timestamp = new Date().toISOString();
    const uniqueOrderIds = new Set(state.allOrders.map(o => o.order_id));
    chrome.storage.local.get(['orderData'], (result) => {
      const orderData = result.orderData || {};
      orderData['Amazon'] = {
        orders: state.allOrders,
        lastParsed: timestamp,
        totalOrders: state.allOrders.length,
        totalProductsCount: state.allOrders.length,
        uniqueOrdersCount: uniqueOrderIds.size
      };
      chrome.storage.local.set({ orderData }, () => {
        console.log(`💾 Финальное сохранение: ${state.allOrders.length} заказов`);
      });
    });
    
    chrome.storage.local.set({ amazonOrders: state.allOrders });
    await clearPaginationState();
    
    chrome.runtime.sendMessage({ 
      action: 'progress', 
      store: 'Amazon', 
      current: state.allOrders.length, 
      total: state.allOrders.length, 
      status: 'Done ✅', // Explicit 'Done ✅' for background.js to detect completion
      found: state.allOrders ? state.allOrders.length : 0
    });
    
    chrome.runtime.sendMessage({ 
      action: 'complete',  
      store: 'Amazon', 
      orders: state.allOrders 
    });
    
    return { success: true, orders: state.allOrders };
  }
  
  // WRAPPER для пагинации - вызывает parseAmazonOrders() для каждой страницы
  async function parseAmazonOrdersWithPagination(options = {}) {
    const maxPagesToParse = options.pages || 1;
    console.log(`\n📦 Запуск парсера Amazon с пагинацией (${maxPagesToParse} страниц)`);

    if (await shouldStop()) {
      console.log('🛑 Stopped before start');
      chrome.runtime.sendMessage({ action: 'progress', store: 'Amazon', current: 0, total: maxPagesToParse, status: 'Stopped' });
      return { success: false, stopped: true, orders: [] };
    }
    
    let state = await getPaginationState();
    
    if (!state) {
      console.log(`🆕 Начинаем новый цикл парсинга (${maxPagesToParse} страниц)`);
      state = {
        currentPage: 1,
        totalPages: maxPagesToParse,
        allOrders: [],
        startedAt: Date.now()
      };
      await savePaginationState(state);
    } else {
      console.log(`🔄 Продолжаем парсинг - страница ${state.currentPage}/${state.totalPages}`);
    }
    
    try {
      console.log(`\n📄 === СТРАНИЦА ${state.currentPage}/${state.totalPages} ===`);

      if (await shouldStop()) {
        console.log('🛑 Stopped during pagination');
        return await finishPaginationParsing(state);
      }
      
      chrome.runtime.sendMessage({ 
        action: 'progress', 
        store: 'Amazon', 
        current: state.currentPage - 1, 
        total: state.totalPages, 
        status: `Страница ${state.currentPage}/${state.totalPages}...` 
      });

      showOverlay(`♻️ ПАРСИНГ: Страница ${state.currentPage}/${state.totalPages}...`, "#e67e22");
      
      // ВЫЗЫВАЕМ ОРИГИНАЛЬНЫЙ parseAmazonOrders() - НЕ ТРОНУТЫЙ!
      const pageResult = await parseAmazonOrders(state.currentPage, state.totalPages);
      const pageOrders = pageResult.orders || [];
      console.log(`✅ Страница ${state.currentPage}: найдено ${pageOrders.length} заказов`);
      
      // Добавляем к общему списку
      state.allOrders.push(...pageOrders);
      state.currentPage++;
      
      // Промежуточное сохранение
      const timestamp = new Date().toISOString();
      const uniqueOrderIds = new Set(state.allOrders.map(o => o.order_id));
      chrome.storage.local.get(['orderData'], (result) => {
        const orderData = result.orderData || {};
        orderData['Amazon'] = {
          orders: state.allOrders,
          lastParsed: timestamp,
          totalOrders: state.allOrders.length,
          totalProductsCount: state.allOrders.length,
          uniqueOrdersCount: uniqueOrderIds.size
        };
        chrome.storage.local.set({ orderData });
      });
      chrome.storage.local.set({ amazonOrders: state.allOrders });
      
      // Переходим на следующую страницу?
      if (state.currentPage <= state.totalPages) {
        console.log(`\n⏳ Пауза ${PAGE_DELAY_MS / 1000}с перед переходом на страницу ${state.currentPage}...`);
        await savePaginationState(state);
        await sleep(PAGE_DELAY_MS);

        if (await shouldStop()) {
          console.log('🛑 Stopped before clicking next');
          return await finishPaginationParsing(state);
        }
        
        const clicked = clickNextPage();
        if (!clicked) {
          console.log('⚠️ Не удалось перейти на следующую страницу, завершаем');
          return await finishPaginationParsing(state);
        }
        return { success: true, continuing: true };
        
      } else {
        return await finishPaginationParsing(state);
      }
      
    } catch (error) {
      console.error('❌ Ошибка парсинга:', error);
      return await finishPaginationParsing(state);
    }
  }
  // ========== END PAGINATION ==========

  // Слушатель сообщений - CLEANED UP
  // Old listener removed because it's handled in the top merged listener now
  
  // AUTO-RESUME: Продолжаем пагинацию после reload
  (async function checkAutoResume() {
    await sleep(1500);
    const state = await getPaginationState();
    if (state && state.currentPage > 1 && state.currentPage <= state.totalPages) {
      console.log(`🔄 AUTO-RESUME: Продолжаем парсинг страницы ${state.currentPage}/${state.totalPages}`);
      showOverlay(`🔄 Продолжаю: Страница ${state.currentPage}/${state.totalPages}`, "#8e44ad");
      parseAmazonOrdersWithPagination().catch(err => {
        console.error('❌ Ошибка auto-resume:', err);
        showOverlay("❌ Ошибка Auto-Resume", "#c0392b");
        clearPaginationState();
      });
    }
  })();

})();