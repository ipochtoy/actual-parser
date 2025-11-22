# 🔙 ROLLBACK to v6.8.1-STABLE

**Дата:** 2025-10-12 (2:30 AM)  
**Причина:** v6.9.x сломал работу Amazon, eBay и iHerb парсинга  

---

## ⚠️ **ПРОБЛЕМЫ в v6.9.x:**

### 1. **Amazon перестал работать**
- После UI редизайна Amazon parsing перестал запускаться

### 2. **eBay/iHerb не парсят**
- Логи показывали: `"ℹ️ No auto-parse flag (or expired)"`
- Content scripts проверяли флаг **ДО** того, как popup.js его устанавливал
- Message `autoParse` не доходил до content scripts

### 3. **UI изменения оказались нестабильны**
- Новый popup.js конфликтовал со старой логикой
- Файлы кешировались неправильно
- Сложно было отследить что работает, а что нет

---

## ✅ **v6.8.1 - ПОСЛЕДНЯЯ СТАБИЛЬНАЯ ВЕРСИЯ**

**Что работает:**
- ✅ **Amazon:** Парсит 4 страницы автоматически
- ✅ **eBay:** Парсит с пагинацией
- ✅ **iHerb:** Парсит корректно
- ✅ **TBA tracking:** Работает стабильно
- ✅ **USPS tracking:** Работает для Exit English (3 трека)
- ✅ **Multi-order detection:** Работает (⚠️ РАЗНЫЕ ЗАКАЗЫ)
- ✅ **Multi-product per shipment:** Работает (Crocs, GAP, MrBeast)
- ✅ **Copy button:** Обнуляется при новом парсинге
- ✅ **"Gloves" order:** Парсится корректно (разные треки для разных посылок)

---

## 📦 **ЧТО В v6.8.1:**

### **Файлы:**
- `manifest.json` - v6.8.1
- `content-amazon.js` - v6.8.0 с 4-page pagination
- `content-ebay.js` - v6.7.0 (стабильная)
- `content-iherb.js` - v6.7.0 (стабильная)
- `popup.js` - старый UI (работает)
- `popup.html` - старый UI (работает)

### **Механизмы:**
1. **Amazon Auto-Pagination:**
   - `parseAmazonOrdersWithPagination()` wrapper
   - 4 страницы с авто-переходом (click-based)
   - 2-секундная задержка между страницами
   - Auto-resume после page reload

2. **TBA Tracking:**
   - Приоритет для TBA номеров
   - Фильтрация UPS-like номеров
   - Контекстная проверка

3. **Multi-Order Detection:**
   - Post-processing: группировка по `track_number`
   - Если 1 трек → несколько `order_id` → флаг `"⚠️ РАЗНЫЕ ЗАКАЗЫ"`

4. **Multi-Product per Shipment:**
   - Итерация по всем продуктам в `deliveryBox`
   - Уникальные ASIN для деупликации

---

## 🎯 **ДАЛЬНЕЙШИЙ ПЛАН:**

### **Шаг 1: Стабилизация (v6.8.1-STABLE)**
- ✅ Откат к v6.8.1
- ✅ Создана ветка `v6.8.1-STABLE`
- ✅ Запуш в GitHub

### **Шаг 2: Постепенные изменения (v6.8.2+)**
1. **Сначала функционал:**
   - Починить "Parse This Page" кнопку
   - Улучшить auto-parse logic (message sending)
   - Убедиться что всё работает

2. **Потом UI:**
   - Минималистичный дизайн (pochtoy.com style)
   - Прогресс-бары
   - Улучшенные статусы

3. **После UI - background parsing:**
   - Service worker logic
   - Фоновый парсинг

---

## 🧪 **ТЕСТИРОВАНИЕ v6.8.1:**

**Перед любыми изменениями протестируй:**
1. ✅ Amazon парсит 4 страницы
2. ✅ eBay парсит
3. ✅ iHerb парсит
4. ✅ "Copy" кнопка обнуляется
5. ✅ "Gloves" order (3 треки)
6. ✅ "Exit English" (3 USPS)
7. ✅ "Crocs" order (multi-product)
8. ✅ Multi-order warning (dress + slippers)

---

## ⚡ **ПРАВИЛО:**

> **"Если что-то перестало работать → СРАЗУ ОТКАТ НАЗАД!"**
>
> Не пытаемся чинить сломанное. Откатываемся к стабильной версии и делаем изменения постепенно.

---

## 📝 **CHANGELOG ССЫЛКИ:**

- `CHANGELOG-v6.7.6.md` - Multi-order post-processing
- `CHANGELOG-v6.7.4.md` - Multi-product per shipment
- `CHANGELOG-v6.7.1.md` - Gloves fix
- `CHANGELOG-v6.8.0-v2.md` - Pagination wrapper pattern
- `CHANGELOG-v6.8.1.md` - Clear on parse

---

**🎉 v6.8.1-STABLE готова к использованию!**

