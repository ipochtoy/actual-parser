# CHANGELOG v6.7.6 - Multi-Order Post-Processing

**Date**: 2025-10-12  
**Branch**: `v6.7.6-multi-order-post-processing`  
**Previous**: `v6.7.5` (attempt to detect multi-order in scope - failed)

---

## 🎯 ПРОБЛЕМА v6.7.5

В v6.7.5 пытались найти индивидуальный Order ID для каждого товара в его DOM scope.

**НЕ РАБОТАЕТ**, потому что:
- На странице Amazon Orders **Order ID показан только для карточки**, не для каждого товара
- Товары в multi-order shipments **не имеют индивидуального Order ID** в DOM

**Пример из логов:**
```
Карточка 3 (Order: 114-4412217-9430658):
  📦 Dearfoams slippers | Трек: TBA324920696386

Карточка 4 (Order: 114-3764396-9473831):
  📦 Nautica dress | Трек: TBA324920696386  ← ТОТ ЖЕ ТРЕК!
```

❌ Логи НЕ показывали `🚨 ВНИМАНИЕ! Товар из ДРУГОГО заказа!`

---

## ✅ РЕШЕНИЕ v6.7.6

**POST-PROCESSING** после парсинга:

1. ✅ Парсим все заказы как обычно
2. ✅ **ПОСЛЕ парсинга** группируем по `track_number`
3. ✅ Для каждого трека проверяем: сколько уникальных `order_id`
4. ✅ Если `uniqueOrderIds.size > 1` → **ФЛАГ** `"⚠️ РАЗНЫЕ ЗАКАЗЫ"` для ВСЕХ товаров с этим треком

---

## 📝 КОД

Добавлено ПОСЛЕ `console.log(\`📊 Итого найдено: ${allOrders.length}\`)`:

```javascript
// v6.7.6: POST-PROCESSING - Detect multi-order shipments
console.log("\n🔍 POST-PROCESSING: Проверка multi-order shipments...");

// Группируем заказы по tracking number
const trackMap = new Map(); // track_number -> [order1, order2, ...]

allOrders.forEach(order => {
  const track = order.track_number;
  if (!track) return;
  
  if (!trackMap.has(track)) {
    trackMap.set(track, []);
  }
  trackMap.get(track).push(order);
});

// Ищем треки с товарами из РАЗНЫХ заказов
let multiOrderShipmentsCount = 0;

for (const [track, orders] of trackMap.entries()) {
  if (orders.length < 2) continue; // Только 1 товар - пропускаем
  
  // Собираем уникальные Order IDs
  const uniqueOrderIds = new Set(orders.map(o => o.order_id));
  
  if (uniqueOrderIds.size > 1) {
    // НАШЛИ! Разные заказы в одной посылке
    multiOrderShipmentsCount++;
    console.log(`  🚨 Multi-order shipment #${multiOrderShipmentsCount}:`);
    console.log(`     Трек: ${track}`);
    console.log(`     Товаров: ${orders.length}`);
    console.log(`     Разных заказов: ${uniqueOrderIds.size}`);
    console.log(`     Order IDs: ${Array.from(uniqueOrderIds).join(', ')}`);
    
    // ПРОСТАВЛЯЕМ ФЛАГ для всех товаров в этой посылке
    orders.forEach(order => {
      order.color = "⚠️ РАЗНЫЕ ЗАКАЗЫ";
    });
  }
}

if (multiOrderShipmentsCount > 0) {
  console.log(`\n✅ POST-PROCESSING: Найдено ${multiOrderShipmentsCount} multi-order shipments, флаги проставлены`);
} else {
  console.log("  ✅ Multi-order shipments не найдены");
}
```

---

## 📊 РЕЗУЛЬТАТ

Для посылки `TBA324920696386` (платье + тапочки):
- ✅ Оба товара получают флаг `"⚠️ РАЗНЫЕ ЗАКАЗЫ"` в столбце `color`
- ✅ Оператор видит предупреждение в Google Sheets
- ✅ В консоли логируется:
  ```
  🚨 Multi-order shipment #1:
     Трек: TBA324920696386
     Товаров: 2
     Разных заказов: 2
     Order IDs: 114-4412217-9430658, 114-3764396-9473831
  ```

---

## ⚠️ СОХРАНЕНО

- ✅ TBA tracking extraction (v6.6-6.7)
- ✅ Multi-product per shipment (v6.7.4)
- ✅ eBay/iHerb parsing
- ✅ USPS tracking (v6.7)
- ✅ Auto-pagination (v6.8)
- ✅ Основной парсинг НЕ ТРОНУТ (только пост-обработка)

---

## 🧪 ТЕСТИРОВАНИЕ

1. Перезагрузи экстеншен в `chrome://extensions/`
2. Рестарт таба Amazon
3. Парси 1 страницу
4. Ищи в консоли: `🚨 Multi-order shipment`
5. Копируй в Google Sheets → ищи `⚠️ РАЗНЫЕ ЗАКАЗЫ` в столбце `color`

---

**STATUS**: ✅ Ready for testing  
**NEXT**: Test and confirm multi-order detection works

