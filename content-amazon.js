/* content-amazon.js — v7.9.0 (одна отправка = все её товары) */

(function () {
  console.log("🚀 Amazon Parser v7.9.0 loaded");

  // Разбор состава отправки живёт в отдельном файле shipment-scope.js: его же читает
  // офлайн-тест в AutoBuy, поэтому правило «одна отправка = все её товары» проверяется
  // на настоящем коде, а не на копии. Файл подключён в manifest.json ПЕРЕД этим.
  // Нет файла — Chrome вообще не поднимет расширение, так что молча работать по-старому
  // (одна строка вместо четырёх) парсер уже не может.
  const SHIPMENT = (typeof globalThis !== 'undefined' ? globalThis : window).PPShipmentScope;
  if (!SHIPMENT) {
    console.error('❌ shipment-scope.js не загружен — состав отправки разбирать нечем. Скопируйте файл в папку расширения.');
    throw new Error('shipment-scope.js missing');
  }
  
  // Get current Amazon account name for logs
  function getAmazonAccountName() {
    return new Promise(resolve => {
      chrome.storage.local.get(['multiAccountState'], result => {
        const account = result.multiAccountState?.currentAmazonAccount;
        if (account) {
          resolve(`Amazon (${account.split('@')[0]})`);
        } else {
          resolve('Amazon');
        }
      });
    });
  }

  // Resolve current Amazon account email — used to stamp every parsed order
  // with `account_name` so the sheet/AutoBuy can attribute rows to the right
  // Amazon login. Falls back to accountsConfig primary when we're not in
  // multi-account mode.
  async function getAmazonAccount() {
    const r = await chrome.storage.local.get(['multiAccountState', 'accountsConfig']);
    if (r.multiAccountState && r.multiAccountState.currentAmazonAccount) {
      return r.multiAccountState.currentAmazonAccount;
    }
    const cfg = r.accountsConfig;
    if (cfg && cfg.amazon && cfg.amazon.length) {
      const primary = cfg.amazon.find(a => a.isPrimary) || cfg.amazon[0];
      return primary.email || '';
    }
    return '';
  }
  
  // Current page number for logging
  let currentLogPage = 1;
  
  // Save log entry directly to storage (more reliable than sendMessage)
  async function sendLog(orderId, trackNumber, status, details, page = null) {
    try {
      const store = await getAmazonAccountName();
      const pageInfo = page || currentLogPage;
      const timestamp = new Date().toLocaleString('ru-RU', { 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit',
        day: '2-digit',
        month: '2-digit'
      });
      
      const logEntry = {
        timestamp,
        store,
        orderId: orderId || '-',
        trackNumber: trackNumber || '-',
        status,
        details: `[Стр.${pageInfo}] ${details || ''}`
      };
      
      // Save directly to chrome.storage.local
      const result = await chrome.storage.local.get(['parsingLogs']);
      const logs = result.parsingLogs || [];
      logs.push(logEntry);
      await chrome.storage.local.set({ parsingLogs: logs });
      
      console.log(`📝 Log: ${status} | ${orderId} | ${trackNumber?.substring(0, 15) || '-'}`);
    } catch (e) {
      console.error('Failed to save log:', e);
    }
  }

  async function getSavedPageCount() {
    const res = await chrome.storage.local.get(['savedPagesToParse']);
    return parseInt(res.savedPagesToParse, 10) || 20;
  }

  // Check for auto-parse flag on page load
  (async function checkAutoParse() {
    console.log('🔍 Checking for auto-parse flag...');

    const data = await chrome.storage.local.get(['autoParsePending', 'autoParse_amazon', 'autoParseTimestamp', 'accountSwitchInProgress', 'switchedToEmail', 'amazonFinalReturn']);

    const hasParserIntent = !!(data.amazonFinalReturn
      || data.accountSwitchInProgress
      || data.autoParsePending === 'amazon'
      || data.autoParse_amazon);
    const ownership = hasParserIntent ? await getOwnedAmazonParserContext() : null;
    if (hasParserIntent && !ownership) {
      console.log('⏭ Amazon auto-parse intent belongs to another tab/run');
      return;
    }

    // Гард: финальный возврат на ipochtoy — парс не запускаем
    if (data.amazonFinalReturn) {
      console.log('🏁 amazonFinalReturn=true — пропускаю auto-parse');
      return;
    }
    
    // Check if this is after account switch (multi-account parsing)
    if (data.accountSwitchInProgress) {
      if (String(ownership?.account || '').trim().toLowerCase()
          !== String(data.switchedToEmail || '').trim().toLowerCase()) {
        console.log('⏭ Amazon switched account does not match owned parser context');
        return;
      }
      console.log(`✅ Account switch detected! Now parsing as: ${data.switchedToEmail}`);
      
      await chrome.storage.local.remove(['accountSwitchInProgress', 'switchedToEmail']);
      
      setTimeout(async () => {
        const freshOwnership = await getOwnedAmazonParserContext();
        if (!freshOwnership
            || freshOwnership.runId !== ownership.runId
            || freshOwnership.account !== ownership.account) return;
        const pages = await getSavedPageCount();
        console.log(`🚀 Starting parse after account switch (${pages} pages)...`);
        parseAmazonOrdersWithPagination({ pages });
      }, 3000);
      return;
    }

    const shouldAutoParse = (data.autoParsePending === 'amazon') || data.autoParse_amazon;
    const timestamp = data.autoParseTimestamp || data.autoParse_amazon;

    const isRecent = timestamp && (Date.now() - timestamp < 10000);

    if (shouldAutoParse && isRecent) {
      console.log('✅ Auto-parse flag found! Starting parse in 2 seconds...');

      await chrome.storage.local.remove(['autoParsePending', 'autoParse_amazon', 'autoParseTimestamp']);

      setTimeout(async () => {
        const freshOwnership = await getOwnedAmazonParserContext();
        if (!freshOwnership
            || freshOwnership.runId !== ownership.runId
            || freshOwnership.account !== ownership.account) return;
        const pages = await getSavedPageCount();
        console.log(`🚀 Starting auto-parse (${pages} pages)...`);
        parseAmazonOrdersWithPagination({ pages });
      }, 3000);
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
        (async () => {
          console.log("🔥 CALLING CLEAR PAGINATION"); await clearPaginationState();
          const opts = request.options || { pages: await getSavedPageCount() };
          parseAmazonOrdersWithPagination(opts);
        })();
        sendResponse({ status: "started" });
        return;
    }
    // Handle legacy parse
    if (request.action === "parseAmazon" || request.action === "parseAmazonOrders") {
         console.log("📨 Legacy parse command received!");
         showOverlay(`🚀 ЗАПУСК (${PARSE_MODE})...`, "#d35400");
         (async () => {
          console.log("🔥 CALLING CLEAR PAGINATION"); await clearPaginationState();
          const opts = request.options || { pages: await getSavedPageCount() };
          parseAmazonOrdersWithPagination(opts);
        })();
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
  // v7.9: два новых аргумента — рамка отправки и число позиций в ней. Нужны, чтобы
  // отличить «посмотрели рамку товара, значка нет» (у Amazon это ровно одна штука)
  // от «рамку товара найти не удалось». Во втором случае цифру НЕ выдумываем: пустой
  // qty поднимает в листе пометку «состав не разобран».
  function extractQuantityFromDOM(scope, shipmentBox, positionsInShipment) {
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
    
    // Значок отправки: у посылки из ОДНОЙ позиции цифра иногда висит не внутри рамки
    // товара, а рядом с ней. Берём её только когда позиция в отправке одна и значок
    // в отправке один — иначе легко утащить цифру соседнего товара.
    if (shipmentBox && positionsInShipment === 1 && shipmentBox.querySelectorAll) {
      const badges = shipmentBox.querySelectorAll('span.product-image__qty, .product-image__qty');
      if (badges.length === 1) {
        const badgeText = badges[0].textContent?.trim();
        if (badgeText && /^\d+$/.test(badgeText)) {
          console.log(`  📊 QTY found via shipment badge: ${badgeText}`);
          return badgeText;
        }
      }
    }

    // Рамка позиции опознана, значка на ней нет — у Amazon значок появляется только
    // от двух штук, поэтому это честная одна штука. Значок с соседних уровней шаг 2
    // выше уже искал, так что «нет значка» здесь означает именно единицу.
    // Картинку внутри рамки НЕ требуем: у Amazon рамкой позиции бывает и строка с одним
    // названием — потребуй мы картинку, пометка «состав не разобран» полезла бы на
    // обычные строки и перестала что-либо значить.
    const looksLikeItemCard = !!(scope && scope.matches
      && scope.matches(SHIPMENT.ITEM_SCOPE_SELECTOR));
    if (looksLikeItemCard) {
      console.log('  📊 Quantity badge absent on item card → 1');
      return "1";
    }

    console.log('  📊 Рамку товара опознать не удалось — qty оставляем пустым');
    return null;
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

      // Simple patterns - TBA, USPS, and UPS
      // UPS format: 1Z + 6 alphanumeric + 2 DIGITS (service code) + 8 alphanumeric
      // This strict pattern avoids false positives like "1ZAUXFMSEBKUFEFJRA"
      const patterns = [
        { re: /(TBA\d{6,})/, label: 'TBA' },
        { re: /(9\d{21,})/, label: 'USPS' },
        { re: /(1Z[A-Z0-9]{6}\d{2}[A-Z0-9]{8})/, label: 'UPS' },
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

  async function queueAmazonTrackScreenshot(payload) {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'queueTrackScreenshot', ...payload });
      if (response?.status !== 'queued') {
        throw new Error(response?.error || 'screenshot queue commit was not acknowledged');
      }
      return response;
    } catch (cause) {
      const error = new Error(cause?.message || String(cause));
      error.code = 'SCREENSHOT_QUEUE_COMMIT_FAILED';
      throw error;
    }
  }

  // composition — разбор состава отправки из главного цикла:
  //   { parsed: true|false, reason: '', box: Element, positions: number }
  // parsed=false значит «состав отправки разобрать не удалось»: строка уедет в лист
  // с пометкой, а робот описи вместо «В посылке N товаров» напишет предупреждение.
  async function parseIndividualItemSimpleByTrackUrl(card, productLink, orderId, trackUrl, parserAccount, composition) {
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
    // Fallback: try to get title from productLink directly
    if (!title && productLink) {
      // Try link text
      const linkText = productLink.textContent?.trim();
      if (linkText && linkText.length > 5 && linkText.length < 300) {
        title = linkText;
        console.log("  📦 Title from link text");
      }
      // Try title attribute
      if (!title && productLink.title) {
        title = productLink.title.trim();
        console.log("  📦 Title from link title attr");
      }
      // Try nearby img alt
      if (!title) {
        const nearbyImg = productLink.querySelector('img[alt]') || productLink.closest('div')?.querySelector('img[alt]');
        if (nearbyImg && nearbyImg.alt && nearbyImg.alt.length > 5) {
          title = nearbyImg.alt.trim();
          console.log("  📦 Title from nearby img alt");
        }
      }
      // Ищем название по ДРУГИМ ссылкам ТОГО ЖЕ товара (картинка и название дают две
      // ссылки с одним ASIN). Соседние позиции не трогаем: до v7.9 отсюда бралась
      // первая ссылка рамки доставки, и в отправке из четырёх кукол все четыре строки
      // могли получить имя первой.
      if (!title) {
        const deliveryBox = productLink.closest('.delivery-box, .a-box');
        const ownAsin = extractASINFromLink(productLink.getAttribute('href') || productLink.href);
        if (deliveryBox) {
          const allLinks = Array.from(deliveryBox.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]'))
            .filter(l => !ownAsin || extractASINFromLink(l.getAttribute('href') || l.href) === ownAsin);
          for (const link of allLinks) {
            const txt = link.textContent?.trim();
            if (txt && txt.length > 5 && txt.length < 300) {
              title = txt;
              console.log("  📦 Title from delivery-box link");
              break;
            }
            // Also check img inside
            const img = link.querySelector('img[alt]');
            if (img && img.alt && img.alt.length > 5) {
              title = img.alt.trim();
              console.log("  📦 Title from delivery-box img alt");
              break;
            }
          }
        }
      }
      // Last resort: extract from URL
      if (!title && productLink.href) {
        // Try to extract product name from URL like /Product-Name-Here/dp/ASIN
        const match = productLink.href.match(/amazon\.com\/([^\/]+)\/dp\/([A-Z0-9]+)/i);
        if (match && match[1] && match[1] !== 'dp' && match[1] !== 'gp') {
          title = decodeURIComponent(match[1].replace(/-/g, ' ').replace(/_/g, ' '));
          console.log("  📦 Title from URL path:", title.substring(0, 50));
        }
        // Also try /dp/ASIN format (no name in URL) - use ASIN as last resort
        if (!title) {
          const asinMatch = productLink.href.match(/\/dp\/([A-Z0-9]+)/i);
          if (asinMatch) {
            title = `Product ASIN: ${asinMatch[1]}`;
            console.log("  📦 Title from ASIN (fallback)");
          }
        }
      }
    }
    if (!title) {
      console.log("  ❌ No product name found, productLink:", productLink?.href);
      sendLog(orderId, '-', '❌ No name', 'Не найдено название товара');
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
      sendLog(individualOrderId || orderId, '-', '❌ No track', title?.substring(0, 80) || 'Unknown product');
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
    const qty = extractQuantityFromDOM(scope, composition && composition.box, composition && composition.positions);
    console.log(`  📊 QTY: ${qty === null ? '— (не нашли)' : qty}`);

    // Anti-rate-limit: skip скрин если order > 14 дней. Дата ищется в order card
    // (ближайший родитель с [data-order-id]) по паттерну "Order placed Month DD, YYYY".
    const SCREENSHOT_MAX_AGE_DAYS = 14;
    let skipForAge_1 = false;
    const orderCard_1 = (scope.closest && scope.closest('[data-order-id]')) || scope;
    const dateMatch_1 = (orderCard_1.textContent || '').match(/Order\s+placed\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i);
    if (dateMatch_1) {
      const orderTs_1 = Date.parse(dateMatch_1[1]);
      if (orderTs_1 && (Date.now() - orderTs_1) > SCREENSHOT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000) {
        const ageDays_1 = Math.round((Date.now() - orderTs_1) / 86400000);
        console.log('    ⏭️  Skip screenshot for ' + individualOrderId + ' (age ' + ageDays_1 + 'd > ' + SCREENSHOT_MAX_AGE_DAYS + 'd)');
        skipForAge_1 = true;
      }
    }
    if (!skipForAge_1) {
      console.log('📸 Sending queueTrackScreenshot for ' + trackNumber + ' acct: ' + parserAccount);
      await queueAmazonTrackScreenshot({
        orderId: individualOrderId,
        trackNumber,
        trackUrl,
        accountName: parserAccount
      });
    }

    const accountName = await getAmazonAccount();
    return {
      store_name: "Amazon",
      order_id: individualOrderId,
      track_number: trackNumber,
      product_name: title,
      qty: qty,
      color: isMultiOrderShipment ? "⚠️ РАЗНЫЕ ЗАКАЗЫ" : "",
      size: "",
      account_name: accountName,
      // Разобрали ли состав отправки целиком. false → лист получит пометку, а робот
      // описи не напечатает число позиций.
      composition_parsed: composition ? composition.parsed !== false : false,
      composition_reason: (composition && composition.reason) || (composition ? '' : 'no-composition')
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

  async function parseIndividualItemSimple(card, productLink, orderId, parserAccount) {
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
      sendLog(orderId, '-', '❌ No track', title?.substring(0, 80) || 'Unknown product');
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

    // Anti-rate-limit: skip скрин если order > 14 дней.
    let skipForAge_2 = false;
    const orderCard_2 = (scope.closest && scope.closest('[data-order-id]')) || scope;
    const dateMatch_2 = (orderCard_2.textContent || '').match(/Order\s+placed\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i);
    if (dateMatch_2) {
      const orderTs_2 = Date.parse(dateMatch_2[1]);
      if (orderTs_2 && (Date.now() - orderTs_2) > 14 * 24 * 60 * 60 * 1000) {
        const ageDays_2 = Math.round((Date.now() - orderTs_2) / 86400000);
        console.log('    ⏭️  Skip screenshot for ' + orderId + ' (age ' + ageDays_2 + 'd > 14d)');
        skipForAge_2 = true;
      }
    }
    if (!skipForAge_2) {
      console.log('📸 Sending queueTrackScreenshot for ' + trackNumber + ' acct: ' + parserAccount);
      await queueAmazonTrackScreenshot({
        orderId,
        trackNumber,
        trackUrl,
        accountName: parserAccount
      });
    }

    const accountName = await getAmazonAccount();
    return {
      store_name: 'Amazon',
      order_id: orderId,
      track_number: trackNumber,
      product_name: title,
      qty: qty,
      source_url: productLink?.href || '',
      account_name: accountName
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

  // Detect a CANCELLED / REFUNDED order from its card (money-safety net).
  // Verified live 2026-07-09: cancelled orders render the status word inside
  // `.delivery-box__primary-text` / `.yohtmlc-shipment-status-primaryText`
  // (text "Cancelled") — NOT in an action button, so no "Cancel order"-button
  // false positive. Such orders have no tracking → would otherwise be silently
  // dropped, while Pochtoy may still show them as "Выкуплен".
  function detectAmazonCancelled(card) {
    const statusEls = card.querySelectorAll(
      '.delivery-box__primary-text, .yohtmlc-shipment-status-primaryText, [class*="shipment-status-primaryText"]'
    );
    for (const el of statusEls) {
      const t = (el.innerText || el.textContent || '').trim();
      if (/^cancell?ed\b|order\s+cancell?ed/i.test(t)) return { cancelled: true, status_text: t.slice(0, 60) };
      if (/^refund(ed)?\b|refund\s+issued/i.test(t)) return { cancelled: true, status_text: t.slice(0, 60) };
    }
    return { cancelled: false };
  }

  async function parseAmazonOrders(currentPage = 1, totalPages = 1) {
    console.log(`\n📦 Запуск парсера Amazon для страницы ${currentPage}/${totalPages}`);

      const ownerState = await chrome.storage.local.get(['multiAccountState', 'manualAccountName']);
      const parserAccount = ownerState.multiAccountState?.currentAmazonAccount
        || ownerState.manualAccountName
        || '';
      if (!parserAccount) throw new Error('Amazon parser account is not pinned');

      const cards = getOrderCards(document);
      console.log(`📦 Найдено ${cards.length} карточек заказов`);

    if (cards.length === 0) {
      console.log("❌ Карточки заказов не найдены!");
      try {
        chrome.runtime.sendMessage({
          action: 'multiAccountLog',
          step: 'content-amazon:no-cards',
          detail: {
            url: location.href.slice(0, 160),
            bodyPreview: (document.body?.innerText || '').slice(0, 400)
          }
        });
      } catch (e) { /* ignore */ }
      return { success: false, error: "Карточки заказов не найдены", orders: [] };
    }

    const allOrders = [];
    const cancelledThisPage = [];
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

        // --- CANCELLED / REFUNDED DETECTION (money-safety) ---
        // Cancelled orders have no Track button → the shipment loop below produces
        // no rows and the order would vanish. Capture it here so background alerts
        // the operator (order may still show "Выкуплен" in Pochtoy).
        const cxl = detectAmazonCancelled(card);
        if (cxl.cancelled) {
          let nm = '';
          try { nm = (extractTitleFromDOM(card) || '').trim(); } catch (_) {}
          const acctForCxl = await getAmazonAccount();
          cancelledThisPage.push({
            store_name: 'Amazon',
            order_id: orderId,
            product_name: nm.slice(0, 120),
            status_text: cxl.status_text,
            account_name: acctForCxl || ''
          });
          console.log(`🚫 ОТМЕНЁН заказ Amazon: ${orderId} — ${cxl.status_text}`);
        }
        // -----------------------------------------------------

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
            
            // v7.9: ОДНА ОТПРАВКА = ВСЕ ЕЁ ТОВАРЫ.
            // Сначала рамка отправки и весь её состав, и только потом — itemId из
            // ссылки кнопки. Раньше было наоборот: itemId находил один товар и
            // отключал разбор рамки (`if (!productLink)`), поэтому заказ из четырёх
            // кукол уехал в лист одной строкой (114-4364449-9800232, 02.09.2026).
            const shipment = SHIPMENT.shipmentScope(trackBtn, card);
            let productsToProcess = shipment.box ? SHIPMENT.collectShipmentProducts(shipment.box) : [];
            const compositionReasons = [];
            if (!shipment.isolated) compositionReasons.push(shipment.reason || 'scope-multi-track');
            console.log(`  📦 Рамка отправки: ${shipment.box ? (shipment.box.className || shipment.box.tagName) : '—'}, товаров в ней: ${productsToProcess.length}`);

            // itemId из ссылки кнопки — теперь только ПРОВЕРКА, а не поиск: если в
            // рамке нет товара с этим itemId, значит рамку взяли не ту.
            const itemIdMatch = trackUrl.match(/itemId=([^&]+)/);
            const itemId = itemIdMatch ? itemIdMatch[1] : null;
            if (itemId && productsToProcess.length) {
              const hit = productsToProcess.some(link => String(link.getAttribute('href') || link.href || '').includes(itemId));
              if (!hit) {
                console.log(`  ⚠️ В рамке отправки нет товара с itemId ${itemId}`);
                compositionReasons.push('itemId-not-in-box');
              }
            }

            // Запасная дорога 1: рамка пуста — ищем товар по itemId во всей карточке.
            if (!productsToProcess.length && itemId) {
              const byItemId = Array.from(card.querySelectorAll(SHIPMENT.PRODUCT_LINK_SELECTOR))
                .filter(link => String(link.getAttribute('href') || link.href || '').includes(itemId));
              if (byItemId.length) {
                productsToProcess = [byItemId[0]];
                compositionReasons.push('a-fallback');
                console.log(`  ⚠️ Взяли товар по itemId — состав отправки не разобран`);
              }
            }

            // Запасная дорога 2: не нашли ничего — первый товар карточки, С ПОМЕТКОЙ.
            if (!productsToProcess.length) {
              const first = card.querySelector(SHIPMENT.PRODUCT_LINK_SELECTOR);
              if (first) {
                productsToProcess = [first];
                compositionReasons.push('d-fallback');
                console.log(`  ⚠️ Взяли первый товар карточки — состав отправки не разобран`);
              }
            }

            if (!productsToProcess.length) {
              console.log(`  ❌ Товар не найден вообще, пропускаем`);
              continue;
            }

            // Состав отправки всегда живёт массивом — даже когда товар один.
            trackBtn._allProducts = productsToProcess;

            const composition = {
              parsed: compositionReasons.length === 0,
              reason: compositionReasons.join('+'),
              box: shipment.box,
              positions: productsToProcess.length
            };
            console.log(`  🔄 Обрабатываем ${productsToProcess.length} товар(ов) из этой посылки${composition.parsed ? '' : ' (состав не разобран: ' + composition.reason + ')'}`);
            
            let shipmentTrack = '';
            let emptyQtySeen = false;
            for (let prodIdx = 0; prodIdx < productsToProcess.length; prodIdx++) {
              const prod = productsToProcess[prodIdx];
              const order = await parseIndividualItemSimpleByTrackUrl(card, prod, orderId, trackUrl, parserAccount, composition);
              if (order) {
                if (!shipmentTrack) shipmentTrack = order.track_number || '';
                if (order.qty === null || order.qty === undefined || order.qty === '') emptyQtySeen = true;
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
                // Log success
                sendLog(order.order_id, order.track_number, '✅ Found', order.product_name.substring(0, 80));
              }
            }

            // Состав отправки разобрать не смогли — говорим об этом вслух, один раз на
            // отправку. Молчаливая одна строка вместо четырёх стоила складу трёх кукол.
            if (!composition.parsed || emptyQtySeen) {
              const reason = composition.parsed ? 'empty-qty' : composition.reason;
              sendLog(orderId, shipmentTrack || '-', '⚠️ Состав не разобран', `причина=${reason}`);
            }
          } catch (itemError) {
            console.error(`❌ Ошибка обработки посылки ${j + 1}:`, itemError);
            if (itemError?.code === 'SCREENSHOT_QUEUE_COMMIT_FAILED') throw itemError;
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
        if (cardError?.code === 'SCREENSHOT_QUEUE_COMMIT_FAILED') throw cardError;
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

    return { success: true, orders: allOrders, cancelled: cancelledThisPage, stats: { totalCount: allOrders.length } };
  }


  // ========== PAGINATION v6.8 (wrapper, не трогает parseAmazonOrders) ==========
  const PAGINATION_STATE_KEY = 'amazonPaginationState';
  const PAGE_DELAY_MS = 5000; // 5 секунд (05.08.2026: на 2 с Amazon отшивал страницу трека «redirecting in 7 seconds», кабинет уходил в ноль)
  
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
  
  function amazonParserContextMatchesState(context, state) {
    return !!context?.owned
      && !!state?.runId
      && context.runId === state.runId
      && String(context.account || '').trim().toLowerCase()
        === String(state.account || '').trim().toLowerCase()
      && context.tabId === state.parserTabId
      && context.stageStartedAt === state.stageStartedAt
      && context.accountSwitchStartedAt === state.accountSwitchStartedAt;
  }

  async function requireOwnedAmazonPaginationState(state, phase) {
    const context = await getOwnedAmazonParserContext();
    if (!amazonParserContextMatchesState(context, state)) {
      throw new Error(`stale Amazon parser run/account/tab ${phase || 'before cursor mutation'}`);
    }
    return context;
  }

  function amazonAttemptRefFromState(state) {
    return {
      runId: state?.runId || null,
      account: state?.account || '',
      parserTabId: state?.parserTabId || null,
      stageStartedAt: state?.stageStartedAt || null,
      accountSwitchStartedAt: state?.accountSwitchStartedAt || null,
      parseId: state?.parseId || null
    };
  }

  async function commitAmazonAttempt(kind, state, extra = {}) {
    const response = await chrome.runtime.sendMessage({
      action: 'commitAmazonAttempt',
      kind,
      attempt: amazonAttemptRefFromState(state),
      paginationState: state,
      ...extra
    });
    if (!response?.ok) {
      const error = new Error(`Amazon ${kind} commit rejected: ${response?.reason || response?.status || 'unknown'}`);
      error.code = response?.reason === 'timeout-won' || response?.reason === 'timeout-resolving'
        ? 'AMAZON_TIMEOUT_WON'
        : 'AMAZON_STALE_ATTEMPT';
      throw error;
    }
    return response;
  }

  async function savePaginationState(state) {
    // Background validates and writes under the same serialized attempt lock.
    // A post-write ownership check cannot undo a stale cursor that already
    // poisoned the next account's shared pagination slot.
    await commitAmazonAttempt('cursor', state);
    return true;
  }
  
  async function clearPaginationState() {
    console.log('🧹 ПРИНУДИТЕЛЬНАЯ ОЧИСТКА ПАГИНАЦИИ');
    const state = await getPaginationState();
    if (!state) return true;
    await commitAmazonAttempt('clear', state);
    return true;
  }
  
  function getAmazonPageFromUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      const startIndex = Number(url.searchParams.get('startIndex'));
      if (url.searchParams.has('startIndex') && Number.isFinite(startIndex) && startIndex >= 0) {
        return Math.floor(startIndex / 10) + 1;
      }
      const page = Number(url.searchParams.get('page'));
      if (url.searchParams.has('page') && Number.isFinite(page) && page >= 1) return Math.floor(page);
      return 1;
    } catch (_) {
      return null;
    }
  }

  function buildAmazonPageUrl(rawUrl, pageNumber) {
    try {
      const url = new URL(rawUrl, location.href);
      if (!/(^|\.)amazon\.com$/i.test(url.hostname)) return null;
      if (!/(?:order-history|your-orders)/i.test(url.pathname)) return null;
      const page = Math.max(1, Math.floor(Number(pageNumber) || 1));
      url.searchParams.set('startIndex', String((page - 1) * 10));
      return url.href;
    } catch (_) {
      return null;
    }
  }

  function findNextPageUrl(nextPageNumber) {
    const selectors = [
      'li.a-last:not(.a-disabled) a',
      '.a-pagination .a-last a',
      'ul.a-pagination li.a-last:not(.a-disabled) a',
      'a.s-pagination-item.s-pagination-next' // Added for new Amazon UI
    ];
    
    for (const sel of selectors) {
      const nextBtn = document.querySelector(sel);
      if (nextBtn && !nextBtn.closest('.a-disabled')) {
        const href = nextBtn.href || nextBtn.getAttribute('href');
        try {
          const resolved = new URL(href, location.href).href;
          return buildAmazonPageUrl(resolved, nextPageNumber);
        } catch (_) { /* try another known selector */ }
      }
    }
    return null;
  }

  function hasExplicitAmazonLastPage() {
    return !!document.querySelector(
      'li.a-last.a-disabled, .a-pagination .a-last.a-disabled, a.s-pagination-next[aria-disabled="true"]'
    );
  }

  async function prepareAmazonNextPageNavigation(state) {
    await requireOwnedAmazonPaginationState(state, 'before next-page planning');
    const targetPage = state.currentPage;
    if (state.navigation) {
      if (state.navigation.targetPage === targetPage && state.navigation.targetUrl) {
        return {
          status: 'prepared',
          targetPage,
          targetUrl: state.navigation.targetUrl,
          navId: state.navigation.navId
        };
      }
      return { status: 'blocked', reason: 'navigation-generation-mismatch' };
    }
    if (hasExplicitAmazonLastPage()) {
      return { status: 'explicit-end' };
    }
    // Amazon changes the pagination DOM often. A missing selector is not proof
    // that the order list ended; build the exact next URL from the current safe
    // order-history URL before declaring the transition blocked.
    const targetUrl = findNextPageUrl(targetPage) || buildAmazonPageUrl(location.href, targetPage);
    if (!targetUrl) {
      console.log('⚠️ Next URL not found');
      return { status: 'blocked', reason: 'missing-safe-next-url' };
    }

    // Save a durable transition marker BEFORE leaving the document. If Chrome is
    // starved while navigating, the background watchdog can retry this exact URL
    // without discarding the already parsed pages.
    state.navigation = {
      navId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      targetPage,
      targetUrl,
      fromUrl: location.href.slice(0, 500),
      startedAt: Date.now()
    };
    try {
      chrome.runtime.sendMessage({
        action: 'multiAccountLog',
        step: 'content-amazon:navigation-start',
        detail: { targetPage, targetUrl: targetUrl.slice(0, 200) }
      });
    } catch (_) {}

    return { status: 'prepared', targetPage, targetUrl, navId: state.navigation.navId };
  }

  async function navigateToNextPage(state) {
    const prepared = await prepareAmazonNextPageNavigation(state);
    if (prepared.status !== 'prepared') return prepared;
    const { targetPage, targetUrl } = prepared;

    console.log(`🔄 Переходим на страницу ${targetPage}: ${targetUrl}`);
    try {
      // Cursor commit and tab navigation share the background attempt lock, so
      // an account transition can be ordered either before both (stale/no-op)
      // or after both — never between them.
      const result = await commitAmazonAttempt('navigate', state, { targetUrl });
      return { status: result.status || 'navigating', navId: state.navigation.navId };
    } catch (error) {
      state.navigation.lastError = String(error?.message || error).slice(0, 240);
      state.navigation.lastErrorAt = Date.now();
      if (error?.code === 'AMAZON_STALE_ATTEMPT'
          || error?.code === 'AMAZON_TIMEOUT_WON') {
        throw error;
      }
      // If navigation itself failed while this attempt is still current, retain
      // the marker for the background recovery path. A stale attempt is already
      // fenced and must not write anything else.
      if (error?.code !== 'AMAZON_STALE_ATTEMPT' && error?.code !== 'AMAZON_TIMEOUT_WON') {
        await savePaginationState(state);
      }
      return { status: 'blocked', reason: 'navigation-assign-failed', navId: state.navigation.navId };
    }
  }

  async function failPaginationParsing(state, reason, error = null) {
    const message = error ? String(error?.message || error).slice(0, 300) : '';
    state.incomplete = {
      at: Date.now(),
      reason,
      message,
      lastCompletedPage: Math.max(0, (Number(state.currentPage) || 1) - 1),
      totalPages: state.totalPages
    };
    await commitAmazonAttempt('incomplete', state, {
      incomplete: {
        timestamp: Date.now(),
        reason,
        message,
        found: Array.isArray(state.allOrders) ? state.allOrders.length : 0,
        lastCompletedPage: state.incomplete.lastCompletedPage,
        totalPages: state.totalPages
      }
    });
    try {
      chrome.runtime.sendMessage({
        action: 'progress',
        store: 'Amazon',
        status: `Incomplete: ${reason}`,
        found: Array.isArray(state.allOrders) ? state.allOrders.length : 0
      });
    } catch (_) {}
    return { success: false, incomplete: true, reason, orders: state.allOrders || [] };
  }
  
  async function getOwnedAmazonParserContext() {
    try {
      const context = await chrome.runtime.sendMessage({ action: 'getAmazonParserContext' });
      return context?.owned ? context : null;
    } catch (_) {
      return null;
    }
  }

  async function finishPaginationParsing(state, reason) {
    if (!['configured-limit', 'explicit-end'].includes(reason) || state.navigation) {
      return failPaginationParsing(state, reason || 'invalid-completion-state');
    }
    const ownedContext = await getOwnedAmazonParserContext();
    if (!ownedContext
        || ownedContext.runId !== state.runId
        || ownedContext.account !== state.account
        || ownedContext.tabId !== state.parserTabId) {
      throw new Error('stale Amazon parser run/account/tab before commit');
    }
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
    
    // Keep the cursor until background acknowledges the completion and switches
    // the account. The background arbiter rereads fresh shared data, validates
    // ownership and commits rows + cursor + completion permit in one critical
    // section; content-side check-then-set cannot provide that guarantee.
    state.completedAt = Date.now();
    state.completionReason = reason;
    delete state.incomplete;
    const finalCommit = await commitAmazonAttempt('complete', state, {
      orders: state.allOrders,
      cancelledOrders: Array.isArray(state.cancelledOrders) ? state.cancelledOrders : [],
      reason
    });
    console.log(`💾 Финальное сохранение: ${state.allOrders.length} новых + ${finalCommit.existingCount || 0} существующих = ${finalCommit.totalCount || state.allOrders.length} уникальных`);
    if (state.cancelledOrders?.length) console.log(`🚫 Сохранено отменённых Amazon-заказов (этот аккаунт): ${state.cancelledOrders.length}`);
    console.log('🚩 Флаг завершения Amazon записан в storage');
    try {
      chrome.runtime.sendMessage({
        action: 'multiAccountLog',
        step: 'content-amazon:parse-end',
        detail: { url: location.href.slice(0, 160), found: state.allOrders.length }
      });
    } catch (e) { /* ignore */ }
    
    // Отправляем сообщение (может потеряться, но storage уже есть)
    chrome.runtime.sendMessage({ 
      action: 'progress', 
      store: 'Amazon', 
      current: state.allOrders.length, 
      total: state.allOrders.length, 
      status: 'Done ✅',
      found: state.allOrders ? state.allOrders.length : 0,
      runId: state.runId || null,
      account: state.account || ''
    }).catch(() => console.log('⚠️ sendMessage failed, but storage flag is set'));
    
    chrome.runtime.sendMessage({ 
      action: 'complete',  
      store: 'Amazon', 
      orders: state.allOrders 
    }).catch(() => {});
    
    // НЕ переключаем аккаунт из content-скрипта — это делает watchdog в background.js.
    // Гонка двух механизмов крала очередь скриншотов первого аккаунта (ipochtoy):
    // SW успевал начать switch до того как processScreenshotQueue() обрабатывал очередь.
    console.log('✅ Флаг amazonParsingComplete установлен — ждём watchdog в background');

    return { success: true, orders: state.allOrders };
  }
  
  // WRAPPER для пагинации - вызывает parseAmazonOrders() для каждой страницы
  async function parseAmazonOrdersWithPagination(options = {}) {
    const maxPagesToParse = options.pages || 20;
    console.log(`\n📦 Запуск парсера Amazon с пагинацией (${maxPagesToParse} страниц)`);

    try {
      chrome.runtime.sendMessage({
        action: 'multiAccountLog',
        step: 'content-amazon:parse-start',
        detail: { url: location.href.slice(0, 160), maxPages: maxPagesToParse }
      });
    } catch (e) { /* SW may be asleep, ignore */ }

    const ownedContext = await getOwnedAmazonParserContext();
    if (!ownedContext) {
      console.log('⏭ Amazon parse ignored in a non-parser tab/run');
      return { success: false, stale: true, orders: [] };
    }
    chrome.runtime.sendMessage({
      action: 'parserStarted', store: 'Amazon',
      runId: ownedContext.runId, account: ownedContext.account
    }).catch(() => {});

    if (await shouldStop()) {
      console.log('🛑 Stopped before start');
      chrome.runtime.sendMessage({ action: 'progress', store: 'Amazon', current: 0, total: maxPagesToParse, status: 'Stopped' });
      return { success: false, stopped: true, orders: [] };
    }
    
    let state = await getPaginationState();
    
    if (!state) {
      console.log(`🆕 Начинаем новый цикл парсинга (${maxPagesToParse} страниц)`);
      state = {
        parseId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        runId: ownedContext.runId,
        account: ownedContext.account,
        parserTabId: ownedContext.tabId,
        stageStartedAt: ownedContext.stageStartedAt,
        accountSwitchStartedAt: ownedContext.accountSwitchStartedAt,
        currentPage: 1,
        totalPages: maxPagesToParse,
        allOrders: [],
        cancelledOrders: [],
        startedAt: Date.now()
      };
      await savePaginationState(state);
    } else {
      console.log(`🔄 Продолжаем парсинг - страница ${state.currentPage}/${state.totalPages}`);
      if (state.runId !== ownedContext.runId
          || state.account !== ownedContext.account
          || state.parserTabId !== ownedContext.tabId
          || state.stageStartedAt !== ownedContext.stageStartedAt
          || state.accountSwitchStartedAt !== ownedContext.accountSwitchStartedAt) {
        return failPaginationParsing(state, 'stale-pagination-context');
      }
    }

    if (state.completedAt) {
      console.log('✅ Amazon completion already persisted; waiting for background acknowledgement');
      return { success: true, completed: true, waitingForBackground: true, orders: state.allOrders || [] };
    }

    if (state.navigation && state.navigation.targetPage === state.currentPage) {
      const actualPage = getAmazonPageFromUrl(location.href);
      if (actualPage !== state.currentPage) {
        console.warn(`⚠️ Amazon navigation mismatch: expected page ${state.currentPage}, loaded ${actualPage}`);
        try {
          chrome.runtime.sendMessage({
            action: 'multiAccountLog',
            step: 'content-amazon:navigation-mismatch',
            detail: {
              expectedPage: state.currentPage,
              actualPage,
              url: location.href.slice(0, 200)
            }
          });
        } catch (_) {}
        // Do not parse the previous page under the next page number. Redispatch
        // the already durable exact marker immediately; waiting for the idle
        // watchdog would waste ten minutes after a content-script restart.
        const resumedNavigation = await navigateToNextPage(state);
        if (resumedNavigation.status === 'navigating') {
          return { success: true, continuing: true, navigationPending: true };
        }
        return failPaginationParsing(
          state,
          resumedNavigation.reason || 'navigation-resume-blocked'
        );
      }

      const navigation = state.navigation;
      delete state.navigation;
      delete state.incomplete;
      await commitAmazonAttempt('cursor', state, {
        amazonOrders: state.allOrders,
        clearRecovery: true
      });
      try {
        chrome.runtime.sendMessage({
          action: 'multiAccountLog',
          step: 'content-amazon:navigation-arrived',
          detail: {
            page: state.currentPage,
            retryCount: navigation.retryCount || 0,
            elapsedMs: Math.max(0, Date.now() - (navigation.startedAt || Date.now())),
            url: location.href.slice(0, 200)
          }
        });
      } catch (_) {}
    }
    
    try {
      console.log(`\n📄 === СТРАНИЦА ${state.currentPage}/${state.totalPages} ===`);
      
      // Update page number for logging
      currentLogPage = state.currentPage;

      if (await shouldStop()) {
        console.log('🛑 Stopped during pagination');
        return await failPaginationParsing(state, 'stopped-during-pagination');
      }
      
      chrome.runtime.sendMessage({ 
        action: 'progress', 
        store: 'Amazon', 
        current: state.currentPage - 1, 
        total: state.totalPages, 
        status: `Страница ${state.currentPage}/${state.totalPages}...` 
      });

      showOverlay(`♻️ ПАРСИНГ: Страница ${state.currentPage}/${state.totalPages}...`, "#e67e22");
      
      // HEARTBEAT прогресса во время разбора страницы.
      // Прогресс-пинг иначе шлётся ТОЛЬКО в начале страницы (выше), а watchdog в
      // background.js убивает аккаунт после 90с без прогресса (lastAmazonProgressAt).
      // Свежепереключённый 2-й аккаунт (photopochtoy) Amazon придушивает → fetch'и
      // трек-номеров идут медленно, страница 1 легко превышает 90с → ложный таймаут
      // «no progress» → 0 заказов → 0 скринов. Пинг каждые 25с держит таймер живым,
      // пока страница реально парсится. Это НЕ трогает ядро parseAmazonOrders().
      const __hbPage = state.currentPage, __hbTotal = state.totalPages;
      const __heartbeat = setInterval(() => {
        try {
          chrome.runtime.sendMessage({
            action: 'progress', store: 'Amazon',
            current: __hbPage - 1, total: __hbTotal,
            status: `Страница ${__hbPage}/${__hbTotal} (обработка)...`
          }, () => chrome.runtime.lastError);
        } catch (e) { /* SW asleep, ignore */ }
      }, 25000);

      // ВЫЗЫВАЕМ ОРИГИНАЛЬНЫЙ parseAmazonOrders() - НЕ ТРОНУТЫЙ!
      let pageResult;
      try {
        pageResult = await parseAmazonOrders(state.currentPage, state.totalPages);
      } finally {
        clearInterval(__heartbeat);
      }
      if (!pageResult?.success) {
        throw new Error(pageResult?.error || `Amazon page ${state.currentPage} did not parse successfully`);
      }
      const pageOrders = pageResult.orders || [];
      console.log(`✅ Страница ${state.currentPage}: найдено ${pageOrders.length} заказов`);
      
      // Добавляем к общему списку
      state.allOrders.push(...pageOrders);
      if (!state.cancelledOrders) state.cancelledOrders = [];
      if (Array.isArray(pageResult.cancelled) && pageResult.cancelled.length) {
        state.cancelledOrders.push(...pageResult.cancelled);
      }
      const completedPage = state.currentPage;
      // The durable cursor always means "the next page to parse". Completion
      // provenance therefore uses cursor - 1 for both configured limit and an
      // explicit Amazon last page.
      state.currentPage = completedPage + 1;

      // Переходим на следующую страницу?
      if (completedPage < state.totalPages) {
        // Persist the next-page cursor together with its exact navigation marker
        // before the five-second settle. A crash anywhere in that delay can then
        // only redispatch this page; it can never parse the old URL under the new
        // cursor and silently skip an order-history page.
        const navigationPlan = await prepareAmazonNextPageNavigation(state);
        if (navigationPlan.status === 'explicit-end') {
          return await finishPaginationParsing(state, 'explicit-end');
        }
        if (navigationPlan.status !== 'prepared') {
          return await failPaginationParsing(
            state,
            navigationPlan.reason || 'navigation-plan-blocked'
          );
        }
        await commitAmazonAttempt('cursor', state, { amazonOrders: state.allOrders });

        console.log(`\n⏳ Пауза ${PAGE_DELAY_MS / 1000}с перед переходом на страницу ${state.currentPage}...`);
        await sleep(PAGE_DELAY_MS);

        if (await shouldStop()) {
          console.log('🛑 Stopped before clicking next');
          return await failPaginationParsing(state, 'stopped-before-navigation');
        }
        
        const navigationResult = await navigateToNextPage(state);
        if (navigationResult.status !== 'navigating') {
          console.log('⚠️ Не удалось перейти на следующую страницу; оставляю честный incomplete');
          return await failPaginationParsing(state, navigationResult.reason || 'navigation-blocked');
        }
        return { success: true, continuing: true };
        
      }
      return await finishPaginationParsing(state, 'configured-limit');
      
    } catch (error) {
      console.error('❌ Ошибка парсинга:', error);
      if (error?.code === 'AMAZON_STALE_ATTEMPT'
          || error?.code === 'AMAZON_TIMEOUT_WON') {
        return {
          success: false,
          stale: error.code === 'AMAZON_STALE_ATTEMPT',
          timeout: error.code === 'AMAZON_TIMEOUT_WON',
          reason: error.code,
          orders: state?.allOrders || []
        };
      }
      try {
        return await failPaginationParsing(state, 'parser-error', error);
      } catch (commitError) {
        if (commitError?.code === 'AMAZON_STALE_ATTEMPT'
            || commitError?.code === 'AMAZON_TIMEOUT_WON') {
          return {
            success: false,
            stale: commitError.code === 'AMAZON_STALE_ATTEMPT',
            timeout: commitError.code === 'AMAZON_TIMEOUT_WON',
            reason: commitError.code,
            orders: state?.allOrders || []
          };
        }
        throw commitError;
      }
    }
  }
  // ========== END PAGINATION ==========

  // Слушатель сообщений - CLEANED UP
  // Old listener removed because it's handled in the top merged listener now
  
  // AUTO-RESUME: Продолжаем пагинацию после reload
  // НО: если это новый multi-account парсинг — начинаем заново!
  (async function checkAutoResume() {
    await sleep(1500);
    const ownership = await getOwnedAmazonParserContext();
    if (!ownership) {
      console.log('⏭ Amazon auto-resume skipped: this is not the parser-owned tab');
      return;
    }
    
    // Проверяем, есть ли активный multi-account парсинг
    const multiState = await new Promise(resolve => 
      chrome.storage.local.get(['multiAccountState'], resolve)
    );
    
    // Если multi-account активен — проверяем начат ли уже парсинг
    if (multiState.multiAccountState && multiState.multiAccountState.isMultiAccountParsing) {
      // Проверяем есть ли уже активное состояние пагинации (парсинг уже идёт)
      const existingState = await getPaginationState();
      if (existingState && existingState.currentPage >= 1) {
        // Парсинг уже идёт — продолжаем через обычный auto-resume ниже
        console.log('🔄 Multi-account: парсинг уже идёт, продолжаем...');
      } else {
        // Первый запуск — начинаем с чистого листа
        console.log('🔄 Multi-account mode active, starting fresh parse...');
        showOverlay("🔄 Multi-account: Начинаю парсинг...", "#3498db");
        getSavedPageCount().then(pages => parseAmazonOrdersWithPagination({ pages })).catch(err => {
          console.error('❌ Ошибка multi-account парсинга:', err);
          showOverlay("❌ Ошибка парсинга", "#c0392b");
        });
        return;
      }
    }
    
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
