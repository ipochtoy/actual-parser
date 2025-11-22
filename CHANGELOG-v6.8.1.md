# CHANGELOG v6.8.1 - Clear Data on Parse

**Date**: 2025-10-12  
**Branch**: `v6.8.1-clear-on-parse`  
**Previous**: `v6.8.0-STABLE` (4-page pagination working)

---

## 🐛 ПРОБЛЕМА

Кнопка "Copy for Google Sheets" накапливала заказы при повторных парсингах вместо замены старых данных новыми.

**Пример:**
1. Парс Amazon → 55 orders
2. Copy to Sheets → OK
3. Парс Amazon снова → Copy button показывает 110 orders (55 + 55) ❌

---

## ✅ РЕШЕНИЕ

Добавлена **очистка данных магазина** ПЕРЕД каждым новым парсингом.

### Изменения в `popup.js`:

```javascript
document.getElementById('exportBtn').addEventListener('click', async () => {
  // ... setup ...
  
  // CRITICAL FIX: Clear store data BEFORE parsing
  console.log(`🗑️ Clearing ${currentStore.name} data before new parse...`);
  chrome.storage.local.get(['orderData'], (result) => {
    const orderData = result.orderData || {};
    delete orderData[currentStore.name]; // Remove old data
    
    chrome.storage.local.set({ orderData }, () => {
      console.log(`✅ ${currentStore.name} data cleared`);
      
      // Reset Copy button state immediately
      copyBtn.disabled = true;
      copyBtn.textContent = '📋 Copy for Google Sheets';
    });
  });
  
  // THEN start parsing
  chrome.tabs.sendMessage(tab.id, { action: currentStore.action }, ...);
});
```

---

## 📊 РЕЗУЛЬТАТ

**Теперь:**
1. Парс Amazon → 55 orders
2. Copy to Sheets → OK
3. Парс Amazon снова → 🗑️ Старые данные удалены → 55 orders (новые) ✅

**Copy button:**
- ✅ Сбрасывается при каждом новом парсинге
- ✅ Показывает только НОВЫЕ данные
- ✅ Не накапливает старые заказы

---

## ⚠️ ВАЖНО

Это касается только **отдельных кнопок** eBay/iHerb/Amazon.

**"Parse All Stores"** - не затронута (работает как и раньше).

---

## 🧪 ТЕСТ

1. Парси Amazon → Запиши количество orders
2. Copy to Sheets → OK
3. Парси Amazon снова
4. Проверь Copy button → должно быть то же количество или меньше (не больше!)

---

**STATUS**: ✅ Ready for testing  
**NEXT**: UI Редизайн в стиле pochtoy.com
