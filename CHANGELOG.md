# Order Parser Pro - Changelog

## Version 7.5 - Multi-Account & Stability (2026-02-05)

### 🔧 Amazon Parser
- **UPS tracking NOT supported** - intentionally excluded due to issues with regex pattern breaking TBA detection
- Supported carriers: TBA (Amazon Logistics), USPS only
- Multi-account parsing with automatic account switching
- Pagination up to 20 pages
- Multi-order shipment detection (products from different orders in same package)
- Deduplication by order_id + track_number + product_name

### 📝 Known Limitations
- UPS tracking numbers (1Z...) are NOT extracted - fetch returns page without tracking visible in HTML
- Some delivered orders may not have accessible tracking info

---

## Version 3.1 - Enhanced Edition

### 🎯 Major Improvements

#### 1. eBay Parser Enhancements
- **ISO Date Format**: Order dates now exported as YYYY-MM-DD (e.g., "2025-10-01")
- **Real Order Numbers**: Fixed extraction to get actual order numbers (e.g., "18-13669-03850") instead of transaction IDs
- **Smart Scroll Detection**: Automatically stops when no new orders appear (2 consecutive empty pages)
- **Progress Tracking**: Real-time progress updates sent to popup during parsing
- **Better Error Handling**: Skips broken orders instead of crashing, continues processing

#### 2. Beautiful UI Improvements
- **Progress Bar**: Visual progress indicator showing "Parsing... 25/100 orders (Page 3)"
- **Statistics Display**:
  - 📦 Total Orders: Shows count of last export
  - ⏰ Last Parsed: "2 minutes ago" style timestamps
- **Improved Button Layout**: Better spacing and visual hierarchy
- **Status Messages**: Success, error, and info messages with appropriate colors

#### 3. Google Sheets Integration
- **New Button**: "📋 Copy for Google Sheets"
- **Tab-Separated Format**: Ready to paste directly into Google Sheets
- **Grouped Data**: Combines products from same order
- **Columns**: Order ID | Date | Total | Products
- **Visual Feedback**: "✓ Copied to clipboard!" message for 2 seconds

#### 4. Modern Icons
- **SVG Source**: Professional blue/purple gradient package icon
- **3 Sizes**: 16px, 48px, 128px PNG files
- **Rounded Design**: Modern, clean aesthetic
- **Instructions**: README in icons/ folder for regenerating

### 📁 Files Modified

#### content-ebay.js
- Added `convertToISODate()` function
- Enhanced `parseEbayOrders()` with progress tracking and smart scroll
- Updated `parseItem()` to extract order_date
- Added `order_date` field to CSV export
- Created `formatForSheets()` function
- Better error handling with try-catch
- Removed verbose debug logging

#### popup.html
- Added progress bar with animated fill
- Added statistics card (total orders, last parsed time)
- Added "Copy for Google Sheets" button
- Improved CSS with hover effects and transitions
- Wider popup (380px) for better layout

#### popup.js
- Complete rewrite with new functionality
- `loadStats()`: Load and display previous parse stats
- `formatTimeAgo()`: Convert timestamps to human-readable format
- `updateProgress()`: Handle real-time progress updates
- `formatForSheets()`: Create tab-separated data for Google Sheets
- Clipboard API integration for copy functionality
- Visual feedback for all actions

#### manifest.json
- Version bumped to 3.1
- Added "storage" permission for stats
- Added icon paths for extension
- Updated description

#### icons/
- Created icon.svg (source file)
- Generated icon-16.png, icon-48.png, icon-128.png
- Added README.md with generation instructions
- Added generate_icons.py (Python script)
- Added create-placeholders.sh (bash script)

### 🔧 Technical Details

#### New Data Structure
```javascript
{
  store_name: 'eBay',
  order_id: '18-13669-03850',  // Real order number
  order_date: '2025-10-01',     // ISO format
  track_number: 'TRACKING123',
  product_name: 'Product Name',
  qty: 1,
  color: 'Blue',
  size: 'M',
  price: '29.99'
}
```

#### Google Sheets Format
```
Order ID        Date          Total    Products
18-13669-03850  2025-10-01    29.99    Product 1 (x1), Product 2 (x2)
```

### 📝 Usage Instructions

1. **Install/Update Extension**:
   - Load unpacked extension in Chrome
   - The new version (3.1) will show updated UI

2. **Export Orders**:
   - Navigate to eBay orders page
   - Click extension icon
   - Click "📥 Export to CSV"
   - Watch progress bar in real-time
   - CSV file downloads automatically

3. **Copy to Google Sheets**:
   - After export, click "📋 Copy for Google Sheets"
   - Open Google Sheets
   - Paste (Ctrl+V / Cmd+V)
   - Data formats automatically with proper columns

4. **View Statistics**:
   - Stats card shows automatically after first export
   - Displays total orders and when last parsed
   - Persists across browser sessions

### 🎨 Visual Improvements

- Modern blue/purple gradient theme (#667eea → #764ba2)
- Smooth transitions and hover effects
- Clear visual hierarchy
- Professional iconography
- Responsive feedback for all actions

### 🐛 Bug Fixes

- Fixed eBay order ID extraction (was using transaction ID)
- Fixed date parsing from eBay API
- Improved error handling to prevent crashes
- Fixed progress tracking during multi-page parsing

### 🚀 Performance

- Smart scroll stops early when no new orders
- Efficient progress updates (no flooding)
- Minimal memory footprint
- Fast clipboard operations

### 📚 Documentation

- Added CHANGELOG.md (this file)
- Updated icons/README.md
- Inline code comments for complex logic
- Clear function names and structure

---

**Built with ❤️ for efficient order management**
