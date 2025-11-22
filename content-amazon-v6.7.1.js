/* content-amazon.js — v7.0-STABLE-RELEASE (Простая рабочая версия) */

(function () {
  console.log("🚀 Amazon Parser v6.8.4 (1 page + multi-order warning)");

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const htmlDecode = (s) => { const t = document.createElement("textarea"); t.innerHTML = s || ""; return (t.value || "").trim(); };
  const safeJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const bySel = (root, sel) => Array.from(root.querySelectorAll(sel));

  function getProductLinksSafe(root) {
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

  async function parseShipmentWithMultipleProducts(card, trackButton, cardOrderId, trackUrl) {
    // Fetch tracking from provided URL (already contains shipmentId)
    const trackResults = await fetchTrackingFromShipTrackUrl(trackUrl);
    
    if (!trackResults || trackResults.length === 0) {
      console.log('  ❌ No tracking number');
      return [];
    }
    
    const trackNumber = trackResults[0]; // Take first track
    
    console.log(`  ✅ TRACK: ${trackNumber}`);
    
    // ВАЖНО: Ищем товары ТОЛЬКО В НЕПОСРЕДСТВЕННОЙ БЛИЗОСТИ от кнопки Track
    // Не во всем searchScope, а только рядом с кнопкой!
    let searchScope = trackButton.closest('.shipment, .a-box-group, .a-row');
    if (!searchScope) {
      // Если нет .shipment, берем родителя кнопки
      searchScope = trackButton.parentElement;
    }
    
    const productLinks = searchScope.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]');
    
    if (productLinks.length === 0) {
      console.log('  ⚠️ Не найдено товаров в области посылки');
      return [];
    }
    
    console.log(`  📦 Найдено ${productLinks.length} товаров рядом с кнопкой Track`);
    
    const orders = [];
    const seenTitles = new Set(); // To avoid duplicates of the same product
    
    for (let i = 0; i < productLinks.length; i++) {
      const productLink = productLinks[i];
      const scope = closestItemScope(productLink);
      
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
        console.log(`    ⚠️ Товар ${i + 1}: название не найдено, пропускаем`);
        continue;
      }

    title = htmlDecode(title);
      const titleKey = title.trim().toLowerCase();
      
      // Skip if we already have this exact title
      if (seenTitles.has(titleKey)) {
        console.log(`    ⏭️ Товар ${i + 1}: дубликат "${title.substring(0, 40)}...", пропускаем`);
        continue;
      }
      
      seenTitles.add(titleKey);
      
      // Try to find Order ID for THIS specific product
      // Amazon может объединить товары из разных заказов в одну посылку!
      let productOrderId = cardOrderId; // Default to card's order ID
      
      // Search for order ID in this product's scope
      const scopeText = scope.textContent || '';
      const orderMatch = scopeText.match(/Order #?\s*(\d{3}-\d{7}-\d{7})/i) || 
                        scopeText.match(/(\d{3}-\d{7}-\d{7})/);
      
      if (orderMatch && orderMatch[1]) {
        productOrderId = orderMatch[1];
        if (productOrderId !== cardOrderId) {
          console.log(`    ⚠️ ВНИМАНИЕ! Товар из ДРУГОГО заказа! ${productOrderId} (вместо ${cardOrderId})`);
          console.log(`    🚨 ОПЕРАТОРУ: Проверить - товары из разных заказов в одной посылке!`);
        }
      }
      
      // Skip if track equals this product's order ID
      if (trackNumber === productOrderId) {
        console.log(`    ❌ Трек равен Order ID, пропускаем`);
        continue;
      }
      
      const asin = extractASINFromLink(productLink.href);
      console.log(`    ${i + 1}. ${title.substring(0, 50)}... | Order: ${productOrderId} | ASIN: ${asin || "—"}`);
      
      // Добавляем специальное поле для операторов если товары из разных заказов
      const isMultiOrderShipment = productOrderId !== cardOrderId;
      
      orders.push({
        store_name: "Amazon",
        order_id: productOrderId,  // ← ИНДИВИДУАЛЬНЫЙ Order ID для каждого товара!
        track_number: trackNumber,
        product_name: title,
        qty: "1",
        color: isMultiOrderShipment ? "⚠️ РАЗНЫЕ ЗАКАЗЫ" : "",  // Warning в поле color
        size: ""
      });
    }
    
    return orders;
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

    return {
      store_name: 'Amazon',
      order_id: orderId,
      track_number: trackNumber,
      product_name: title,
      qty: '1',
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
            
            // Find product links near this track button
            // ВАЖНО: Ищем товары ТОЛЬКО РЯДОМ с кнопкой Track, а не во всей карточке!
            let searchScope = trackBtn.closest('.shipment, .a-box-group, .a-row');
            if (!searchScope) {
              // Если нет .shipment, берем родителя кнопки
              searchScope = trackBtn.parentElement;
            }
            
            const productLinks = searchScope ? searchScope.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]') : [];
            
            if (productLinks.length === 0) {
              console.log(`⚠️ Товары не найдены рядом с кнопкой`);
              continue;
            }
            
            console.log(`  📦 Найдено ${productLinks.length} товар(ов) для этой посылки`);
            
            // Обрабатываем каждый товар в этой посылке
            for (let k = 0; k < productLinks.length; k++) {
              const productLink = productLinks[k];
              const order = await parseIndividualItemSimpleByTrackUrl(card, productLink, orderId, trackUrl);
              if (order) {
                allOrders.push(order);
                cardOrders++;
                console.log(`  ✅ ${k + 1}/${productLinks.length}: ${order.product_name.substring(0, 50)}...`);
              }
            }
      // Look for order ID pattern right after "Order #" or just standalone
      if (/Order #/i.test(text)) {
        const m = text.match(/Order #\s*(\d{3}-\d{7}-\d{7})/i);
        if (m && m[1]) {
          console.log(`   🔍 Found Order ID in element: ${m[1]}`);
          return m[1];
        }
      }
    }
    
    // Try to find "Order #" text in full card text
    const allText = card.textContent || "";
    const patterns = [
      /Order #\s*(\d{3}-\d{7}-\d{7})/i,
      /ORDER #\s*(\d{3}-\d{7}-\d{7})/,
      /Order:\s*(\d{3}-\d{7}-\d{7})/i,
      /(\d{3}-\d{7}-\d{7})/
    ];
    
    for (const pattern of patterns) {
      const m = allText.match(pattern);
      if (m && m[1]) {
        console.log(`   🔍 Found Order ID via pattern: ${m[1]}`);
        return m[1];
      }
    }
    
    // Debug: show what text we're seeing
    console.log(`   ⚠️ Could not find Order ID. Card text preview: ${allText.substring(0, 200)}...`);
    
    return ""; 
  }

  // Parse current page
  async function parseCurrentPage() {
    const doc = document;
    const cards = getOrderCards(doc);
    console.log(`📦 Найдено ${cards.length} карточек заказов на текущей странице`);
    
    if (cards.length === 0) {
      return [];
    }

    const pageOrders = [];
    const maxCards = Math.min(cards.length, 10); // Максимум 10 карточек на странице

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
            
            // Parse all products in this shipment
            // Передаем саму кнопку trackBtn, чтобы искать товары только рядом с ней
            const shipmentOrders = await parseShipmentWithMultipleProducts(card, trackBtn, orderId, trackUrl);
            
            if (shipmentOrders.length > 0) {
              pageOrders.push(...shipmentOrders);
              cardOrders += shipmentOrders.length;
              console.log(`✅ Посылка добавлена: ${shipmentOrders.length} товар(ов)`);
            }
          } catch (itemError) {
            console.error(`❌ Ошибка обработки посылки ${j + 1}:`, itemError);
          }
        }
        
        console.log(`📊 Карточка ${i + 1}: найдено ${cardOrders} товаров с трек-номерами`);
        
        // Небольшая пауза между карточками
        await sleep(300);
        
      } catch (cardError) {
        console.error(`❌ Ошибка обработки карточки ${i + 1}:`, cardError);
      }
    }

    return pageOrders;
  }

  // Auto-pagination state management
  const PAGINATION_STATE_KEY = 'amazonPaginationState';
  
  async function getPaginationState() {
    return new Promise(resolve => {
      chrome.storage.local.get(PAGINATION_STATE_KEY, (result) => {
        resolve(result[PAGINATION_STATE_KEY] || null);
      });
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
  
  // Find and click Next button
  function clickNextPage() {
    // Ищем кнопку Next по разным селекторам
    const selectors = [
      'li.a-last:not(.a-disabled) a',  // Standard pagination
      'a:contains("Next")',
      '.a-pagination .a-last a',
      'ul.a-pagination li.a-last:not(.a-disabled) a'
    ];
    
    for (const sel of selectors) {
      const nextBtn = document.querySelector(sel);
      if (nextBtn && !nextBtn.closest('.a-disabled')) {
        console.log('🔄 Кликаем Next...');
        nextBtn.click();
        return true;
      }
    }
    
    console.log('⚠️ Кнопка Next не найдена или отключена');
    return false;
  }
  
  // Main function with auto-pagination
  async function parseAmazonOrders() {
    console.log("\n📦 Запуск парсера Amazon с авто-пагинацией");
    
    const MAX_PAGES = 1; // Временно 1 страница для быстрого тестирования
    let state = await getPaginationState();
    
    // Если это новый запуск парсинга
    if (!state) {
      console.log(`🆕 Начинаем новый цикл парсинга (${MAX_PAGES} ${MAX_PAGES === 1 ? 'страница' : 'страницы'})`);
      state = {
        currentPage: 1,
        totalPages: MAX_PAGES,
        allOrders: [],
        startedAt: Date.now()
      };
      await savePaginationState(state);
    } else {
      console.log(`🔄 Продолжаем парсинг - страница ${state.currentPage}/${state.totalPages}`);
    }
    
    try {
      // Парсим текущую страницу
      console.log(`\n📄 === СТРАНИЦА ${state.currentPage}/${state.totalPages} ===`);
      
      chrome.runtime.sendMessage({ 
        action: 'progress', 
        store: 'Amazon', 
        current: state.currentPage - 1, 
        total: state.totalPages, 
        status: `Страница ${state.currentPage}/${state.totalPages}...` 
      });

      const pageOrders = await parseCurrentPage();
      console.log(`✅ Страница ${state.currentPage}: найдено ${pageOrders.length} заказов`);
      
      // Добавляем заказы к общему списку
      state.allOrders.push(...pageOrders);
      state.currentPage++;
      
      // Сохраняем промежуточный результат в правильном формате
      const timestamp = new Date().toISOString();
      chrome.storage.local.get(['orderData'], (result) => {
        const orderData = result.orderData || {};
        
        // Подсчитываем уникальные заказы
        const uniqueOrderIds = new Set(state.allOrders.map(o => o.order_id));
        
        orderData['Amazon'] = {
          orders: state.allOrders,
          lastParsed: timestamp,
          totalOrders: state.allOrders.length,
          totalProductsCount: state.allOrders.length,
          uniqueOrdersCount: uniqueOrderIds.size
        };
        
        chrome.storage.local.set({ orderData }, () => {
          console.log(`💾 Сохранено ${state.allOrders.length} заказов (${uniqueOrderIds.size} уникальных)`);
        });
      });
      
      // Также сохраняем в amazonOrders для обратной совместимости
      chrome.storage.local.set({ amazonOrders: state.allOrders });
      
      // Проверяем нужно ли переходить дальше
      if (state.currentPage <= state.totalPages) {
        console.log(`\n⏭️ Переходим на страницу ${state.currentPage}...`);
        
        // Сохраняем состояние перед переходом
        await savePaginationState(state);
        
        // Небольшая пауза перед кликом
        await sleep(500);
        
        // Кликаем Next
        const clicked = clickNextPage();
        
        if (!clicked) {
          console.log('⚠️ Не удалось перейти на следующую страницу, завершаем');
          await finishParsing(state);
        }
        // После клика страница перезагрузится и content script запустится снова
        
      } else {
        // Закончили все страницы
        await finishParsing(state);
      }
      
    } catch (error) {
      console.error('❌ Ошибка парсинга:', error);
      await finishParsing(state);
    }
  }
  
  async function finishParsing(state) {
    console.log(`\n🎉 ПАРСИНГ ЗАВЕРШЁН!`);
    console.log(`📊 Итого найдено: ${state.allOrders.length} товаров с трек-номерами`);
    console.log(`⏱️ Время: ${Math.round((Date.now() - state.startedAt) / 1000)}с`);
    
    // Финальное сохранение в правильном формате
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
        console.log(`💾 Финальное сохранение: ${state.allOrders.length} заказов (${uniqueOrderIds.size} уникальных)`);
      });
    });
    
    // Также сохраняем в amazonOrders для обратной совместимости
    chrome.storage.local.set({ amazonOrders: state.allOrders });
    
    // Очищаем состояние пагинации
    await clearPaginationState();

    chrome.runtime.sendMessage({ 
      action: 'complete', 
      store: 'Amazon', 
      orders: state.allOrders 
    });

    return { success: true, orders: state.allOrders, stats: { totalPages: state.totalPages, totalOrders: state.allOrders.length } };
  }

  // Слушатель сообщений
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "parseAmazon" || request.action === "parseAmazonOrders") {
      console.log("\n📨 ПОЛУЧЕН ЗАПРОС НА ПАРСИНГ AMAZON");
      parseAmazonOrders()
        .then(result => {
          console.log("📦 Парсинг завершен:", result);
          sendResponse(result);
        })
        .catch(err => {
          console.error("❌ Ошибка парсинга:", err);
          sendResponse({ success: false, error: err.message });
        });
      return true;
    }
  });

  // Auto-continue pagination on page load
  // Проверяем при загрузке страницы - есть ли активное состояние пагинации
  (async function checkAutoResume() {
    // Небольшая задержка чтобы страница полностью загрузилась
    await sleep(1000);
    
    const state = await getPaginationState();
    if (state) {
      console.log('🔄 Обнаружено активное состояние пагинации - автоматически продолжаем...');
      console.log(`   Страница ${state.currentPage}/${state.totalPages}`);
      
      // Автоматически продолжаем парсинг
      setTimeout(() => {
        parseAmazonOrders().catch(err => {
          console.error('❌ Ошибка авто-продолжения:', err);
          clearPaginationState();
        });
      }, 500);
    }
  })();

})();