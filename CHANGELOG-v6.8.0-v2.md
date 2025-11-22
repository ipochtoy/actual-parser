# CHANGELOG v6.8.0 - Auto-Pagination v2 (Wrapper Only)

**Date**: 2025-10-12  
**Branch**: `v6.8-pagination-v2`  
**Previous**: `v6.7.6-STABLE` (multi-order detection, 1 page)

---

## 🎯 ЗАДАЧА

Добавить пагинацию (4 страницы) **БЕЗ ИЗМЕНЕНИЯ** `parseAmazonOrders()`.

**Проблема v1:** При попытке переименовать `parseAmazonOrders` → `parseCurrentPage` сломалась логика для перчаток (дубликаты).

---

## ✅ РЕШЕНИЕ v2 (Wrapper Only)

### Подход:

**НЕ ТРОГАЕМ** `parseAmazonOrders()` ВООБЩЕ!

Вместо этого:
1. ✅ Создаём **новую** функцию `parseAmazonOrdersWithPagination()` - wrapper
2. ✅ Wrapper **вызывает** оригинальный `parseAmazonOrders()` для каждой страницы
3. ✅ В message listener вызываем wrapper вместо прямого вызова
4. ✅ `parseAmazonOrders()` остаётся **100% нетронутым**

### Код:

```javascript
// ОРИГИНАЛЬНЫЙ parseAmazonOrders() - НЕ ТРОНУТ! (v6.7.6)
async function parseAmazonOrders() {
  // ... весь код v6.7.6 без единого изменения
  // - Multi-product per shipment (v6.7.4)
  // - Перчатки работают
  // - TBA extraction
}

// НОВЫЙ wrapper
async function parseAmazonOrdersWithPagination() {
  let state = await getPaginationState();
  
  if (!state) {
    state = { currentPage: 1, totalPages: 4, allOrders: [], startedAt: Date.now() };
    await savePaginationState(state);
  }
  
  // ВЫЗЫВАЕМ ОРИГИНАЛЬНЫЙ parseAmazonOrders() - НЕ ТРОНУТЫЙ!
  const pageResult = await parseAmazonOrders();
  state.allOrders.push(...pageResult.orders);
  state.currentPage++;
  
  // Промежуточное сохранение
  // ...
  
  if (state.currentPage <= state.totalPages) {
    await sleep(2000); // 2 секунды
    clickNextPage();
    return { success: true, continuing: true };
  } else {
    return await finishPaginationParsing(state); // POST-PROCESSING
  }
}

// Message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "parseAmazon" || request.action === "parseAmazonOrders") {
    parseAmazonOrdersWithPagination() // ← Вызываем wrapper, не оригинал
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// Auto-resume после reload
(async function checkAutoResume() {
  await sleep(1500);
  const state = await getPaginationState();
  if (state && state.currentPage > 1 && state.currentPage <= state.totalPages) {
    console.log(`🔄 AUTO-RESUME: Продолжаем парсинг страницы ${state.currentPage}/${state.totalPages}`);
    parseAmazonOrdersWithPagination().catch(...);
  }
})();
```

---

## 📊 РЕЗУЛЬТАТ

- ✅ **`parseAmazonOrders()` НЕ ТРОНУТ** - ни одного байта изменений!
- ✅ Парсит **4 страницы** автоматически
- ✅ **2 секунды пауза** перед кликом Next
- ✅ **Click-based** (не fetch)
- ✅ **State persistence**
- ✅ **Multi-order detection** в `finishPaginationParsing()`
- ✅ **Auto-resume** после reload (только для страниц 2-4)

---

## ⚠️ СОХРАНЕНО (НЕ ТРОНУТО!)

- ✅ `parseAmazonOrders()` - 100% код v6.7.6
- ✅ TBA tracking extraction
- ✅ Multi-product per shipment (Crocs fix v6.7.4)
- ✅ **Перчатки БЕЗ дублей** (v6.7.4)
- ✅ Multi-order warning (платье+тапочки v6.7.6)
- ✅ eBay/iHerb parsing

---

## 🧪 КРИТИЧНЫЙ ТЕСТ

**ПЕРЧАТКИ** (Order `113-6188912-4297037`):
- ✅ Должен быть **ОДИН** трек `TBA325013762510`
- ✅ Размер: только тот который выслан (например S или L)
- ❌ НЕ должно быть трёх записей с одним треком!

**Если перчатки дублируются** - значит pagination снова что-то сломала → ОТКАТ!

---

## 🔄 FLOW

```
User кликает "Parse Amazon":
  → parseAmazonOrdersWithPagination()
    → parseAmazonOrders() [v6.7.6 НЕ ТРОНУТ]
    → собрал заказы со страницы 1
    → state.allOrders += orders
    → sleep(2000ms)
    → clickNext()
    → [page reload]

Auto-resume (страница 2):
  → parseAmazonOrdersWithPagination()
    → parseAmazonOrders() [v6.7.6 НЕ ТРОНУТ]
    → собрал заказы со страницы 2
    → state.allOrders += orders
    → sleep(2000ms)
    → clickNext()
    → [page reload]

... страницы 3, 4 ...

Страница 4:
  → parseAmazonOrdersWithPagination()
    → parseAmazonOrders() [v6.7.6 НЕ ТРОНУТ]
    → собрал заказы со страницы 4
    → state.allOrders += orders
    → finishPaginationParsing()
      → POST-PROCESSING (multi-order)
      → Финальное сохранение
      → Готово! 🎉
```

---

**STATUS**: ✅ Ready for CRITICAL testing  
**ВАЖНО**: Если перчатки дублируются → немедленный откат!

