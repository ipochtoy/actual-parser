# iHerb Parser Debug Instructions

## 🚨 PROBLEM: Extension shows "No orders found" or "Unknown error"

Follow these steps **in order** and document the results:

---

## ✅ STEP 1: Verify Extension Installation

1. Open Chrome and go to `chrome://extensions/`
2. Find "Order Parser Pro" (version 3.3)
3. **Check:**
   - ✓ Extension is **enabled** (toggle on)
   - ✓ Click "Details" → scroll to "Content scripts"
   - ✓ Should show: `https://secure.iherb.com/myaccount/orders*`

4. **Force reload:**
   - Click "Remove" button
   - Reload the extension (drag folder or use "Load unpacked")

---

## ✅ STEP 2: Check the Correct Page

1. Navigate to: **https://secure.iherb.com/myaccount/orders**
   - NOT: www.iherb.com
   - NOT: /account/orders
   - MUST BE: **secure.iherb.com/myaccount/orders**

2. **Verify you see your orders on the page**
   - You should see text like "Order #939074140"
   - You should see product names and images

---

## ✅ STEP 3: Check Console Logs

1. Press `F12` to open DevTools
2. Click the **Console** tab
3. Refresh the page (`Ctrl+R` or `Cmd+R`)

**Look for these messages:**

```
🟢 iHerb content script loaded! https://secure.iherb.com/myaccount/orders
📄 Page title: ...
📄 Page HTML length: ...
🔍 Page contains "Order #": true
📦 Sample elements with "Order #": ...
```

### ❌ If you DON'T see these messages:
- Content script didn't load
- **Fix:** Reload extension, refresh page, check URL matches pattern

### ✅ If you DO see these messages:
- Content script loaded successfully
- Continue to next step

---

## ✅ STEP 4: Run Debug Script

1. Open `debug-iherb.js` in this folder
2. Copy the **entire file** contents
3. Paste into the Console
4. Press Enter

**Expected output:**
```
🔧 iHerb Debug Script Starting...
📄 STEP 1: PAGE INFORMATION
  URL: https://secure.iherb.com/myaccount/orders
  ...
🔍 STEP 2: SEARCHING FOR "Order #" TEXT
  Page contains "Order #": true
  Order numbers found in text: 5
  ...
```

### 📋 Share this complete output!

---

## ✅ STEP 5: Test the Export

1. Keep Console open
2. Click the extension icon (Belarus flag)
3. Click "📥 Export to CSV"

**Watch the Console for:**

```
📨 Message received: {action: 'exportIherbOrders'}
🚀 Starting iHerb export...
🚀 exportOrders() started
📍 URL check: https://secure.iherb.com/myaccount/orders
⏳ Waiting for page to fully load...
📜 Starting auto-scroll...
🧪 === IHERB PARSER (Real Structure) ===
...
```

### Common Error Patterns:

#### ❌ Error: "No orders found"
**Console shows:**
```
📊 PARSING STATISTICS:
  - Total elements scanned: 3803
  - Elements with order match: 0
  - Final products: 0
```

**This means:** Parser can't find "Order #" pattern in elements
**Check:** Run debug script, look at STEP 3 output

---

#### ❌ Error: "Unknown error"
**Console shows:**
```
❌ Export Error: ...
❌ Error stack: ...
```

**Look at the error message!** Share it.

---

#### ❌ No console logs at all
**This means:** Content script not loaded
**Fix:**
1. Check URL is exactly: `https://secure.iherb.com/myaccount/orders`
2. Reload extension
3. Hard refresh page (`Ctrl+Shift+R`)

---

## ✅ STEP 6: Check Page Structure (Advanced)

If parser finds 0 orders but page contains "Order #", the HTML structure might have changed.

**Run in console:**

```javascript
// Find an order element manually
const el = document.querySelector('*');
const allEls = Array.from(document.querySelectorAll('*'));
const orderEl = allEls.find(e => e.textContent.includes('Order #939074140'));

console.log('Found element:', orderEl);
console.log('Tag:', orderEl.tagName);
console.log('Classes:', orderEl.className);
console.log('Text:', orderEl.textContent.substring(0, 200));
console.log('HTML:', orderEl.outerHTML.substring(0, 300));
```

**Share this output!**

---

## ✅ STEP 7: Manual Test

Try running the parser manually:

```javascript
// In console:
const orders = [];
const allElements = document.querySelectorAll('*');

Array.from(allElements).forEach(el => {
  const match = el.textContent.match(/Order\s*#\s*(\d{9,10})/);
  if (match && el.textContent.length < 500) {
    console.log('Found order:', match[1], '- Element:', el.tagName, el.className);
    orders.push(match[1]);
  }
});

console.log('Total unique orders:', [...new Set(orders)].length);
```

---

## 📊 Summary Checklist

Before reporting the issue, verify:

- [ ] Extension version is 3.3
- [ ] URL is **exactly** `https://secure.iherb.com/myaccount/orders`
- [ ] Page shows orders visually
- [ ] Console shows "🟢 iHerb content script loaded!"
- [ ] Console shows "🔍 Page contains 'Order #': true"
- [ ] Ran debug script (`debug-iherb.js`)
- [ ] Tried clicking Export and watched console
- [ ] Captured all error messages

---

## 📤 What to Share

**Please provide:**

1. **Complete console output** after page load (first 50 lines)
2. **Complete console output** after clicking Export
3. **Debug script output** (all of it)
4. **Screenshots** of:
   - Extension details page showing content scripts
   - iHerb orders page showing you have orders
   - Console with error messages
5. **URL** you're visiting (copy from address bar)

---

## 🔧 Quick Fixes to Try

### Fix 1: Hard Reload Everything
```
1. chrome://extensions/ → Remove extension
2. Close all iHerb tabs
3. Re-load extension
4. Open fresh tab → https://secure.iherb.com/myaccount/orders
5. Wait 5 seconds
6. Try export
```

### Fix 2: Check URL Pattern
The URL **must** start with:
```
https://secure.iherb.com/myaccount/orders
```

Not:
- ✗ http://secure.iherb.com/myaccount/orders (not HTTPS)
- ✗ https://www.iherb.com/myaccount/orders (not secure subdomain)
- ✗ https://secure.iherb.com/account/orders (different path)

### Fix 3: Wait for Page Load
Sometimes orders load via JavaScript. Try:
1. Load page
2. Wait 10 seconds
3. Scroll to bottom
4. Wait 5 more seconds
5. Then click Export

---

## 🆘 Still Not Working?

Share:
1. All console logs (copy/paste as text)
2. Debug script output
3. Screenshot of iHerb page showing orders
4. Any error messages

This will help identify if it's a:
- URL matching issue
- Content script loading issue
- DOM structure change
- Parser logic issue
