/* content-amazon.js — v6.6 (quoted selectors + safe href + strict tracking)
 * - All CSS attribute selectors properly quoted (no parse errors)
 * - RegExp-based href matching (no CSS selector errors with special chars)
 * - Only valid tracking numbers (TBA / 1Z / USPS / FedEx) are exported
 * - Product title: DOM -> hidden JSON (a-state / data-a-state) -> img[alt]
 * - Per-item scope (closest container), no order-level bleed
 * - Fallback fetch: /gp/your-account/order-details?orderId=... with DOMParser
 * - Results include ONLY items with a valid tracking number
 */

(function () {
  
// === SAFE HREF MATCHING (v6.6.1) ===
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

console.log("🚀 Amazon Parser v6.6 loaded (quoted selectors + safe href)");

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const htmlDecode = (s) => { const t = document.createElement("textarea"); t.innerHTML = s || ""; return (t.value || "").trim(); };
  const safeJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const bySel = (root, sel) => Array.from(root.querySelectorAll(sel));
  const t = (el) => (el ? (el.textContent || "").trim() : "");

  function isValidTracking(s) {
    if (!s) return false;
    const x = s.trim().replace(/\s+/g, "");
    if (/^TBA[0-9A-Z]{6,}$/i.test(x)) return true;
    if (/^1Z[0-9A-Z]{16,}$/i.test(x)) return true;
    if (/^9\d{15,}$/i.test(x) && x.length >= 18 && x.length <= 30) return true;
    if (/^\d{12,15}$/.test(x)) return true;
    return false;
  }
  function findTrackingInText(txt) {
    if (!txt) return null;
    const pats = [/(TBA[0-9A-Z]+)/i, /(1Z[0-9A-Z]{16,})/i, /(\b9\d{15,}\b)/, /(\b\d{12,15}\b)/];
    for (const re of pats) {
      const m = String(txt).match(re);
      if (m && isValidTracking(m[1])) return m[1].replace(/\s+/g, "");
    }
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

// === SIMPLE TRACKING FETCH (from v5.5 - WORKING VERSION) ===

async function fetchTrackingFromShipTrackUrl(url) {
  try {
    console.log(`    🔗 Fetching: ${url.substring(0, 80)}...`);
    const response = await fetch(url);
    const html = await response.text();
    
    // Simple regex patterns that WORKED before
    const patterns = [
      /(TBA\d{12})/,           // Amazon TBA
      /(1Z[A-Z0-9]{16})/,      // UPS
      /(\d{22})/,              // USPS
      /(9[0-9]{21})/,          // FedEx
    ];
    
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        const track = match[1].replace(/\s+/g, '');
        console.log(`    ✅ Found: ${track}`);
        return track;
      }
    }
    
    console.log(`    ⚠️ No tracking found in fetched page`);
    return null;
  } catch (err) {
    console.error(`    ❌ Fetch error:`, err);
    return null;
  }
}

async function parseIndividualItemSimple(card, productLink, orderId) {
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
  
  // TRACKING - Find shipment container (going up from item)
  // Track button is at SHIPMENT level, not ITEM level
  // Need to find the shipment container that includes this item
  
  function findShipmentContainer(node) {
    let current = node;
    // Go up max 10 levels looking for shipment container
    for (let i = 0; i < 10 && current; i++) {
      // Shipment container usually has class with "shipment" or has track button
      if (current.classList && 
          (current.classList.contains('shipment') || 
           current.classList.contains('js-shipment') ||
           current.querySelector && current.querySelector('a[href*="ship-track"]'))) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }
  
  const shipmentContainer = findShipmentContainer(scope);
  let trackLink = null;
  
  if (shipmentContainer) {
    trackLink = shipmentContainer.querySelector('a[href*="ship-track"], a[href*="progress-tracker"]');
  }
  
  if (!trackLink) {
    console.log('  ⚠️ No tracking link found');
    return null;
  }
  
  // 2. Fetch it
  const trackUrl = trackLink.href;
  const trackNumber = await fetchTrackingFromShipTrackUrl(trackUrl);
  
  if (!trackNumber) {
    console.log('  ❌ No tracking number');
    return null;
  }
  
  // 3. Skip if equals ORDER ID
  if (trackNumber === orderId) {
    console.log('  ❌ Tracking equals ORDER ID, skipping');
    return null;
  }
  
  const asin = extractASINFromLink(productLink && productLink.href);
  console.log(`  🔗 ASIN: ${asin || "—"}`);
  console.log(`  ✅ TRACK: ${trackNumber}`);
  
  return {
    store_name: "Amazon",
    order_id: orderId,
    track_number: trackNumber,
    product_name: title,
    qty: "1",
    color: "",
    size: ""
  };
}



  function extractTitleFromDOM(scope) {
    const anchors = ["a.a-link-normal[href*=\"/gp/product/\"]", "a.a-link-normal[href*=\"/dp/\"]", "a[href*=\"/gp/product/\"]", "a[href*=\"/dp/\"]"];
    for (const sel of anchors) {
      const a = scope.querySelector(sel);
      if (a) {
        const tt = t(a); if (tt && tt.length > 5) return tt;
        const s = a.querySelector("span"); if (s && t(s)) return t(s);
      }
    }
    const full = scope.querySelector(".a-truncate .a-truncate-full"); if (full && t(full)) return t(full);
    const cut  = scope.querySelector(".a-truncate .a-truncate-cut");  if (cut  && t(cut))  return t(cut);
    const img = scope.querySelector("img[alt]"); if (img && img.alt && img.alt.trim().length > 10) return img.alt.trim();
    return "";
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

  function extractTrackingFromDOM(scope) {
    const labels = Array.from(scope.querySelectorAll("*")).filter(n => /tracking id/i.test(n.textContent || ""));
    for (const n of labels) {
      const txt = (n.parentElement ? n.parentElement.textContent : "") + " " + (n.textContent || "");
      const hit = findTrackingInText(txt); if (hit) return hit;
      const sibs = [n.nextElementSibling, n.parentElement && n.parentElement.nextElementSibling].filter(Boolean);
      for (const s of sibs) { const h = findTrackingInText(s.textContent || ""); if (h) return h; }
    }
    const links = scope.querySelectorAll("a[href*=\"shipment-tracking\"], a[href*=\"progress-tracker\"], a[href*=\"ship-track\"], a[href*=\"package\"]");
    for (const a of links) { const h = findTrackingInText(a.textContent || ""); if (h) return h; }
    const near = scope.querySelectorAll(".js-shipment-tracking, .a-row.delivery-info, .carrier-info, [id*=\"tracking\"]");
    for (const n of near) { const h = findTrackingInText(n.textContent || ""); if (h) return h; }
    return "";
  }
  function extractTrackingFromJSON(blobs) {
    const keys = ["trackingNumber","trackingId","carrierTrackingId","shipmentTrackingNumber","perItemTrackingNumber"];
    for (const b of blobs) {
      for (const k of keys) {
        const v = b && b[k]; if (typeof v === "string") { const h = findTrackingInText(v); if (h) return h; }
      }
      const stack = [b];
      while (stack.length) {
        const cur = stack.pop(); if (!cur || typeof cur !== "object") continue;
        for (const k of keys) { const v = cur[k]; if (typeof v === "string") { const h = findTrackingInText(v); if (h) return h; } }
        for (const v of Object.values(cur)) { if (Array.isArray(v)) v.forEach(x => x && typeof x === "object" && stack.push(x)); else if (v && typeof v === "object") stack.push(v); }
      }
    }
    return "";
  }
  async function fetchOrderDetailsTracking(orderId, asinOrTitleHint) {
    if (!orderId) return "";
    try {
      const url = `/gp/your-account/order-details?orderId=${encodeURIComponent(orderId)}`;
      const res = await fetch(url, { credentials: "include" }); if (!res.ok) return "";
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");

      const labels = Array.from(doc.querySelectorAll("*")).filter(n => /tracking id/i.test(n.textContent || ""));
      for (const n of labels) {
        const txt = (n.parentElement ? n.parentElement.textContent : "") + " " + (n.textContent || "");
        const hit = findTrackingInText(txt); if (hit) return hit;
        const sibs = [n.nextElementSibling, n.parentElement && n.parentElement.nextElementSibling].filter(Boolean);
        for (const s of sibs) { const h = findTrackingInText(s.textContent || ""); if (h) return h; }
      }
      const scripts = doc.querySelectorAll("script[type=\"a-state\"]");
      for (const s of scripts) { const j = safeJSON(s.textContent || ""); if (!j) continue; const tr = extractTrackingFromJSON([j]); if (tr) return tr; }

      if (asinOrTitleHint) {
        const esc = String(asinOrTitleHint).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(esc, "i");
        const nodes = Array.from(doc.querySelectorAll("body *")).filter(n => re.test(n.textContent || ""));
        for (const n of nodes.slice(0, 15)) {
          const h = findTrackingInText((n.parentElement ? n.parentElement.textContent : "") + " " + (n.textContent || ""));
          if (h) return h;
        }
      }
      return "";
    } catch (e) { console.warn("order-details fetch failed", e); return ""; }
  }

  const orderCardSelectors = [".order-card", ".js-order-card", ".a-box-group.order", "[data-test-id=\"order-card\"]", "[data-order-id]"];
  function getOrderCards() { const all = new Set(); orderCardSelectors.forEach(sel => bySel(document, sel).forEach(el => all.add(el))); return Array.from(all); }
  function getOrderId(card) { const attr = card.getAttribute("data-order-id"); if (attr) return attr; const m = (card.textContent || "").match(/(\d{3}-\d{7}-\d{7})/); return m ? m[1] : ""; }

  async function parseIndividualItem(card, productLink, orderId) {
    const scope = closestItemScope(productLink || card);
    let title = extractTitleFromDOM(scope);
    if (!title) { const blobs = collectNearbyJSON(scope); const alt = pickTitleFromJSON(blobs); if (alt) title = alt; }
    if (!title) { const img = scope.querySelector("img[alt]"); if (img && img.alt && img.alt.trim().length > 10) title = img.alt.trim(); }
    if (!title) { console.log("  ❌ No product name found"); return null; }
    title = htmlDecode(title);

    const asin = extractASINFromLink(productLink && productLink.href);

    let track = extractTrackingFromDOM(scope);
    if (!track) { const blobs = collectNearbyJSON(scope); track = extractTrackingFromJSON(blobs); }
    if (!track && orderId) { const hint = asin || title; track = await fetchOrderDetailsTracking(orderId, hint); }

    if (!track || !isValidTracking(track) || track === orderId) { console.log("  ❌ No valid tracking for:", title.substring(0, 60)); return null; }

    console.log(`  📦 Product: ${title.substring(0, 70)}…`);
    console.log(`  🔗 ASIN: ${asin || "—"}`);
    console.log(`  ✅ TRACK: ${track}`);

    return { store_name: "Amazon", order_id: orderId, track_number: track, product_name: title, qty: "1", color: "", size: "" };
  }

  async function parseCurrentPage() {
    await sleep(800);
    const cards = getOrderCards();
    console.log(`\n📦 Found ${cards.length} order cards`);
    const out = [];
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      console.log(`\n--- Card ${i + 1}/${cards.length} ---`);
      const orderId = getOrderId(card); if (!orderId) { console.log("⚠️ No ORDER #"); continue; }
      console.log(`📋 ORDER: ${orderId}`);
      const productLinks = getProductLinksSafe(card);
      if (!productLinks.length) { console.log("  ⏭️ No product links in this card"); continue; }
      console.log(`  📦 ${productLinks.length} product links found`);
      for (const a of productLinks) { const item = await parseIndividualItemSimple(card, a, orderId); if (item) out.push(item); }
    }
    console.log(`\n📊 Total: ${out.length} items with valid tracking`);
  
  // DEDUPLICATION: Remove duplicate items (same order + tracking + product)
  const seen = new Set();
  const deduped = out.filter(item => {
    const key = `${item.order_id}|${item.track_number}|${item.product_name}`;
    if (seen.has(key)) {
      console.log(`  🗑️ Skipping duplicate: ${item.product_name.substring(0, 50)}...`);
      return false;
    }
    seen.add(key);
    return true;
  });
  
  console.log(`\n✨ After deduplication: ${deduped.length} unique items`);
  return deduped;
  }

  async function saveOrdersWithDeduplication(newOrders, storeName) {
    return new Promise((resolve) => {
      chrome.storage.local.get(['parsedOrders'], (result) => {
        const existing = result.parsedOrders || [];
        const existingMap = new Map();

        existing.forEach(order => {
          const key = `${order.order_id}|${order.product_name}`.toLowerCase();
          existingMap.set(key, order);
        });

        let addedCount = 0;
        let updatedCount = 0;

        newOrders.forEach(newOrder => {
          const key = `${newOrder.order_id}|${newOrder.product_name}`.toLowerCase();
          const existingOrder = existingMap.get(key);

          if (!existingOrder) {
            existingMap.set(key, newOrder);
            addedCount++;
          } else if (newOrder.track_number && newOrder.track_number !== existingOrder.track_number) {
            existingOrder.track_number = newOrder.track_number;
            updatedCount++;
          }
        });

        const merged = Array.from(existingMap.values());

        chrome.storage.local.set({ parsedOrders: merged }, () => {
          resolve({
            addedCount,
            updatedCount,
            totalCount: merged.length
          });
        });
      });
    });
  }

  async function parseAmazonOrders() {
    console.log("\n📦 Starting Amazon parse (v6.6)");
    try {
      const orders = await parseCurrentPage();
      console.log(`✅ Found ${orders.length} items with tracking`);

      // Save and return with stats for popup.js
      const result = await saveOrdersWithDeduplication(orders, 'Amazon');

      return {
        success: true,
        orders: orders,
        stats: {
          addedCount: result.addedCount,
          updatedCount: result.updatedCount,
          uniqueOrdersCount: result.totalCount
        }
      };
    } catch (e) {
      console.error("❌ Parse error:", e && e.message ? e.message : e);
      throw e;
    }
  }

  function checkIfLoggedIn() {
    const indicators = [
      document.querySelector('.nav-line-1-container'),
      document.querySelector('.your-orders-content-container'),
      document.querySelector('.order-card'),
      document.title.includes('Your Orders')
    ];

    const loginCount = indicators.filter(el => el).length;
    const notLoginPage = !window.location.href.includes('/ap/signin');

    return loginCount >= 2 && notLoginPage;
  }

  chrome?.runtime?.onMessage?.addListener?.((request, sender, sendResponse) => {
    if (request && request.action === "parseAmazonOrders") {
      console.log("\n📨 PARSE REQUEST");
      parseAmazonOrders()
        .then(result => {
          console.log(`\n✅ Sending ${result.orders.length} orders`);
          console.log('Stats:', result.stats);
          sendResponse(result);
        })
        .catch(err => {
          console.error("\n❌ Failed:", err && err.message ? err.message : err);
          sendResponse({ success: false, error: (err && err.message) || "Unknown error" });
        });
      return true;
    }

    if (request && request.action === 'checkAmazonAuth') {
      const isLoggedIn = checkIfLoggedIn();
      sendResponse({ isLoggedIn });
    }
  });

  console.log("✅ Amazon Parser v6.6 ready (quoted selectors + safe href + dedup & stats)");
})();
