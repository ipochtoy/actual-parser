# CHANGELOG v6.7

## Дата: 2025-10-11

## 🎯 ЦЕЛЬ
Добавить поддержку нескольких USPS треков для одного товара (Exit English - 3 посылки)

## ✅ Изменения
1. **Парсинг по кнопкам Track package** вместо product links
   - Теперь парсер находит все кнопки `a[href*="ship-track"]` в карточке заказа
   - Каждая кнопка = одна посылка с уникальным `shipmentId`
   
2. **Сохранение `shipmentId` в URL**
   - Убрана сломанная логика которая перезаписывала URL
   - Теперь используется оригинальный URL кнопки который уже содержит `shipmentId`
   
3. **Новая функция `parseIndividualItemSimpleByTrackUrl`**
   - Принимает готовый `trackUrl` с `shipmentId`
   - Находит название товара рядом с кнопкой Track
   - Делает fetch и парсит трек-номер

## ❌ Что НЕ ТРОНУТО
- ✅ **TBA механизм** - работает как раньше
- ✅ **eBay парсинг** - не затронут
- ✅ **iHerb парсинг** - не затронут
- ✅ **Дедупликация** - работает как раньше

## 📊 Что должно работать
- **TBA треки:** 5 штук (как было)
- **USPS треки для Exit English:** 3 штуки (было 1, стало 3)
- **Всего уникальных заказов:** ~8-9 (было 6)

## 🔧 Технические детали
**Было:**
```javascript
const productLinks = getProductLinksSafe(card);
for (link of productLinks) {
  parseIndividualItemSimple(card, link, orderId);
}
```

**Стало:**
```javascript
const trackButtons = card.querySelectorAll('a[href*="ship-track"]');
for (btn of trackButtons) {
  const trackUrl = btn.href; // contains shipmentId!
  parseIndividualItemSimpleByTrackUrl(card, productLink, orderId, trackUrl);
}
```

## 🎯 Диагностика показала
- Все 3 кнопки Exit English имеют **разные** `shipmentId`:
  - `shipmentId=BtgbTg3CK`
  - `shipmentId=BkgrTg3CK`
  - `shipmentId=BqgCTg3CK`
- Каждый `shipmentId` возвращает свой USPS трек
- Старый код игнорировал `shipmentId` → все треки были одинаковые

## 💾 Бэкап
- `content-amazon.js.bak-v6.6-stable` - стабильная версия 6.6
