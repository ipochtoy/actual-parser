# 🆘 AMAZON PARSER — STATUS & FIX (v6.1.1)

## Summary
- **v6.1.1 FIX**: RegExp-based href matching вместо CSS attribute selectors
  - Нет ошибок с спецсимволами в селекторах
  - `getProductLinksSafe()` фильтрует `<a>` по `/(?:dp|gp\/product)\//i`
- Названия: DOM → `a-state`/`data-a-state` → `img[alt]`.
- Трекинг: только форматы TBA/UPS/USPS/FedEx, поиск в item-scope, fallback `/order-details` (DOMParser).
- Экспортируются **только** позиции с валидными трек-номерами.

## Технические детали v6.1.1

### Проблема (v6.1):
CSS селектор `a[href*=/dp/], a[href*=/gp/product/]` падал если в атрибуте были спецсимволы.

### Решение (v6.1.1):
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

Используется в `parseCurrentPage()`:
```javascript
const productLinks = getProductLinksSafe(card);
```

## Вопросы для senior developer
1) Нужны ли дополнительные селекторы для order-card / item-row?
2) Уточнить ключи a-state для трекинга (`trackingNumber|trackingId|carrierTrackingId|shipmentTrackingNumber`).
3) Ок ли частота запросов к `/order-details`.
