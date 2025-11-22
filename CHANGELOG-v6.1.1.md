# CHANGELOG - Amazon Parser v6.1.1

## 🔧 v6.1.1 (2025-10-10) - Critical Fix: Safe Href Matching

### Problem Fixed
CSS attribute selector `a[href*=/dp/], a[href*=/gp/product/]` was throwing errors when special characters appeared in href attributes or DOM structure.

### Solution Implemented
Replaced CSS attribute selectors with RegExp-based href matching:

```javascript
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
```

### Changes
- ✅ Added `getProductLinksSafe()` function
- ✅ Replaced `bySel(card, "a[href*=/dp/], a[href*=/gp/product/]")` with `getProductLinksSafe(card)`
- ✅ No more CSS selector parsing errors
- ✅ Works with any special characters in hrefs

### Files Modified
- `content-amazon.js` - Added safe href matcher, updated parseCurrentPage()
- `manifest.json` - Version bumped to 6.1.1
- `REPORT-FOR-SENIOR.md` - Updated with v6.1.1 technical details

### Backup Created
- `content-amazon.js.bak.20251010-122101`

---

## 🎯 v6.1 (2025-10-10) - Strict Tracking Validation

### Key Features
1. **Strict Tracking Validation**
   - Only exports valid tracking numbers: TBA, UPS (1Z), USPS (9\d{15,}), FedEx (\d{12,15})
   - Rejects invalid formats
   - Rejects Order IDs as tracking numbers

2. **Per-item Scope**
   - Each product parsed in its own container using `closestItemScope()`
   - No data bleed between items in same order

3. **3-tier Title Extraction**
   - DOM → JSON (a-state/data-a-state) → img[alt]

4. **3-tier Tracking Search**
   - DOM labels → JSON blobs → /order-details API fetch

5. **IIFE Pattern**
   - Isolated scope, no global variables

### Technical Improvements
- ✅ Deduplication by `order_id|product_name` (lowercase)
- ✅ Stats return: `{ addedCount, updatedCount, uniqueOrdersCount }`
- ✅ Login detection for checkAmazonAuth
- ✅ Async message handling with `return true`
- ✅ ASIN extraction
- ✅ HTML entity decoding

### Files Modified
- `content-amazon.js` - Complete rewrite with strict validation
- `manifest.json` - Version 6.1
- `AMAZON-TODO.md` - Updated testing checklist
- `SUMMARY.md` - v6.1 Strict Validation Edition
- `REPORT-FOR-SENIOR.md` - Technical questions document

---

## 📊 Version History

- **v6.1.1** - Safe href matching (current)
- **v6.1** - Strict tracking validation
- v6.0 - Advanced Edition (JSON parsing)
- v5.4 - Debug with 2 cards
- v5.3 - Single page mode
- v5.2 - Fixed page navigation
- v5.1 - Debug mode
- v5.0 - Individual item tracking
- v4.0 - Initial Amazon integration

---

## 🚀 Testing Instructions

1. **Reload Extension**
   - Chrome → Extensions (chrome://extensions)
   - Find "Pochtoy Parsing"
   - Click Reload button (🔄)

2. **Test on Amazon**
   - Open: https://www.amazon.com/gp/your-account/order-history
   - Ensure logged in
   - Open extension popup
   - Click "Parse Amazon Orders"
   - Check console (F12) for logs

3. **Expected Console Output**
   ```
   🚀 Amazon Parser v6.1.1 loaded (safe href matching)
   📨 PARSE REQUEST
   📦 Starting Amazon parse (v6.1)
   📦 Found N order cards
   --- Card 1/N ---
   📋 ORDER: 113-2486013-5125017
     📦 2 product links found
     📦 Product: The Bad Guys Episode 1...
     🔗 ASIN: B07XAMPLE
     ✅ TRACK: TBA123456789
   📊 Total: N items with valid tracking
   ✅ Sending N orders
   Stats: { addedCount: N, updatedCount: 0, totalCount: N }
   ✅ Amazon Parser v6.1.1 ready (safe href + deduplication & stats)
   ```

4. **Verify**
   - ✅ No CSS selector errors
   - ✅ Only items with valid tracking are exported
   - ✅ Order IDs not exported as tracking
   - ✅ Product names extracted correctly
   - ✅ Stats displayed in popup

---

## 🛠️ Technical Notes

### Tracking Validation Regex Patterns
```javascript
/^TBA[0-9A-Z]{6,}$/i          // Amazon TBA
/^1Z[0-9A-Z]{16,}$/i          // UPS
/^9\d{15,}$/ (18-30 chars)    // USPS
/^\d{12,15}$/                 // FedEx
```

### Order Card Selectors
```javascript
[".order-card", ".js-order-card", ".a-box-group.order",
 "[data-test-id='order-card']", "[data-order-id]"]
```

### Item Container Selectors (closestItemScope)
```javascript
".yohtmlc-item, [data-test-id='item-row'],
 .a-fixed-left-grid-inner, .a-row"
```

### JSON Keys for Titles
```javascript
["title", "productTitle", "itemTitle", "asinTitle", "product_name"]
```

### JSON Keys for Tracking
```javascript
["trackingNumber", "trackingId", "carrierTrackingId",
 "shipmentTrackingNumber", "perItemTrackingNumber"]
```

---

## 📝 Known Limitations

- **Single Page Mode** - Parses only current page
- **Manual Navigation** - User navigates to next page and re-parses
- **No Auto-pagination** - Removed for stability
- **Per-item Tracking** - Each item gets own tracking (multi-item orders ship separately)

---

## 🙏 Credits

- v6.1 base code provided by senior developer friend
- v6.1.1 safe href matching patch applied by Claude Code

---

**Status:** ✅ READY FOR PRODUCTION TESTING
**Date:** 2025-10-10
**File Size:** 305 lines
