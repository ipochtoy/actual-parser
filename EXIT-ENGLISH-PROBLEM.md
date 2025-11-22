# Проблема Exit English — Выжимка

## ✅ Что работает (v6.7 STABLE)
- **TBA треки качаются идеально**: 5 разных TBA номеров с первой страницы
- **Один USPS трек качается**: `9261290990091555300362` для Exit English
- **Дедупликация работает**: 16 items → 6 unique
- **Storage и Copy работают**: 33 unique orders

## ❌ Проблема
**Заказ:** `114-1712306-1162613` (Exit English)
**Товар:** Exit English (CD, один и тот же товар)
**Количество в заказе:** 3 штуки (три отдельные посылки)
**Кнопок "Track package":** 3 штуки

### Что мы видим:
```
content-amazon.js:117   📦 Product: Exit English…
content-amazon.js:69     🔗 Fetching: ...itemId=jkkolwqmmpsnomp&ref=ppx...
content-amazon.js:85     ✅ Found: 9261290990091555300362

content-amazon.js:117   📦 Product: Exit English…
content-amazon.js:69     🔗 Fetching: ...itemId=jkkolwqmmpsnomp&ref=ppx...
content-amazon.js:85     ✅ Found: 9261290990091555300362

content-amazon.js:117   📦 Product: Exit English…
content-amazon.js:69     🔗 Fetching: ...itemId=jkkolwqmmpsnomp&ref=ppx...
content-amazon.js:85     ✅ Found: 9261290990091555300362
```

**Все 3 кнопки "Track package" ведут на ОДИН `itemId=jkkolwqmmpsnomp`**

## 🔍 Что мы пробовали

### 1. Добавили специальное логирование для Exit English
```javascript
if (url.includes('jkkolwqmmpsnomp')) {
  console.log('🎯 Exit English page fetched, scanning for multiple USPS tracks');
  const uspsMatches = findAllUSPSTrackingInText(html);
  console.log(`🚛 Exit English USPS tracks detected: ${JSON.stringify(uspsMatches)}`);
}
```

### 2. Создали функцию поиска всех USPS треков в тексте
```javascript
function findAllUSPSTrackingInText(html) {
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
```

### 3. Результат
Парсер нашёл **ТОЛЬКО ОДИН** USPS трек `9261290990091555300362`, хотя на странице должно быть **ТРИ РАЗНЫХ** трека для трёх разных посылок.

## 🧐 Гипотезы

### Гипотеза 1: Amazon возвращает только один трек на один `itemId`
- Все три посылки имеют одинаковый `itemId=jkkolwqmmpsnomp`
- Amazon сервер возвращает информацию только о **первой** посылке
- **Проблема:** Amazon API не предоставляет разные треки для одного `itemId`

### Гипотеза 2: Треки загружаются динамически (JavaScript)
- HTML-ответ содержит только один трек
- Остальные треки подгружаются через AJAX/fetch после загрузки страницы
- **Проблема:** Наш `fetch(url)` получает только начальный HTML, без динамически загруженных данных

### Гипотеза 3: Треки находятся в разных параметрах URL
- Каждая кнопка "Track package" может иметь дополнительные параметры (например, `packageIndex`)
- Мы видели в логах: `packageIndex=0` для всех трёх кнопок
- **Проблема:** Нужно найти правильные параметры URL для каждой посылки

### Гипотеза 4: Треки в зашифрованном/закодированном виде
- Предыдущие попытки показали, что Amazon иногда кодирует треки в Base64 или JSON
- **Проблема:** Нужно найти правильный способ декодирования

## 📋 Что нужно проверить

1. **Открыть страницу** `https://www.amazon.com/gp/your-account/ship-track?itemId=jkkolwqmmpsnomp&ref=ppx_yo2ov_dt_b_track_package&packageIndex=0&orderId=114-1712306-1162613` **вручную в браузере**
   - Посмотреть сколько треков показывает Amazon
   - Проверить есть ли переключатель между посылками
   - Посмотреть Network tab для AJAX запросов

2. **Проверить параметры URL для каждой кнопки "Track package"**
   - Возможно, `packageIndex` должен быть разным (0, 1, 2)?
   - Возможно, есть другие параметры (shipmentId, trackingId)?

3. **Посмотреть исходный HTML страницы заказа**
   - Может быть, все три трека уже есть на странице заказа, но в скрытом виде (JSON, data-attributes)?

4. **Проверить DOM на странице order-history**
   - Может быть, для каждого товара есть уникальные идентификаторы в DOM (data-shipment-id, data-tracking-number)?

## 🎯 Текущий план

1. ✅ **v6.7 STABLE сохранена** — TBA треки работают идеально
2. 🔍 **Исследование Exit English** — нужно понять как Amazon хранит/возвращает несколько треков
3. ⚠️ **НЕ ТРОГАТЬ механизм TBA** — это священная корова
4. 🔧 **Добавить специальную логику** только для случаев с несколькими посылками одного товара

## 💡 Возможные решения

### Решение 1: Парсить страницу order-history глубже
Искать все data-атрибуты, скрытые JSON блоки, script tags с данными о треках.

### Решение 2: Использовать разные packageIndex
Попробовать `packageIndex=0`, `packageIndex=1`, `packageIndex=2` для одного `itemId`.

### Решение 3: Искать все треки на странице ship-track
Если страница ship-track показывает все посылки, парсить все треки с неё.

### Решение 4: Принять ограничение
Если Amazon действительно не предоставляет разные треки через API, возможно, нужно просто задокументировать это ограничение.

---

**Дата:** 2025-10-11  
**Версия:** v6.7 STABLE  
**Статус TBA:** ✅ Работает  
**Статус USPS:** ⚠️ Частично (только первый трек из нескольких)

