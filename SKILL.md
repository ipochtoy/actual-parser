---
name: qwixit-db-analytics
description: >-
  Выполняет аналитические SQL-запросы к production базе данных интернет-магазина Qwixit.
  Используй когда пользователь спрашивает о статистике продаж, клиентах, заказах, товарах,
  бонусах, купонах, рефералах, выручке, или задаёт аналитические вопросы типа "сколько заказов",
  "сколько клиентов", "выручка за месяц", "товары с магазина iherb", "новые клиенты",
  "средний чек", "топ товаров", "конверсия".
---

# Qwixit DB Analytics

## Подключение к БД

Креденшалы хранятся в [config.env](config.env). Прочитай файл и используй значения для подключения.

Выполняй запросы через CLI:

```bash
mysql -h $DB_HOST -P $DB_PORT -u $DB_USERNAME -p'$DB_PASSWORD' $DB_DATABASE -e "SQL" 2>/dev/null
```

**КРИТИЧНО**: Пользователь read-only. Выполняй ТОЛЬКО `SELECT`. Никогда не выполняй INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE.

## Ключевые таблицы

| Таблица | Назначение |
|---------|-----------|
| `tl_com_orders` | Заказы |
| `tl_com_ordered_products` | Позиции заказов (товары в заказе) |
| `tl_com_customers` | Клиенты (soft delete через `deleted_at`) |
| `tl_com_products` | Каталог товаров |
| `tl_com_sources` | Магазины-источники (iHerb, Nike, Zara и др.) |
| `tl_com_categories` | Категории товаров (иерархия через `parent`) |
| `tl_com_brands` | Бренды товаров |
| `tl_com_single_product_price` | Цены простых товаров |
| `tl_com_variant_product_price` | Цены вариантов товаров |
| `tl_com_customer_bonus` | Бонусы клиентов |
| `tl_com_customer_balance` | Баланс клиентов (кэшбэк) |
| `tl_com_customer_referrals` | Реферальные связи |
| `tl_com_coupons` | Купоны/промокоды |
| `tl_com_coupon_usages` | Факты использования купонов |
| `tl_com_payment_transactions` | Платёжные транзакции |
| `tl_com_product_has_categories` | Связь товар → категория |
| `tl_com_source_bonus` | Процент бонусов по источнику |
| `tl_com_referral_traffic` | Реферальный трафик |

## Коды статусов

### Оплата (`payment_status`)

- `1` = оплачен (paid)
- `2` = не оплачен (unpaid)

### Доставка (`delivery_status`)

- `1` = доставлен (delivered)
- `2` = в ожидании (pending) — дефолт
- `3` = отправлен (shipped)
- `4` = отменён (cancelled)
- `5` = в обработке (processing) — отправлен в Pochtoy
- `6` = готов к отправке (ready_to_ship)
- `7` = выкуплен (purchased) — выкуплен Pochtoy

### Методы оплаты (`payment_method`)

- `1` = COD (наложенный платёж)
- `17` = Tinkoff
- `18` = CloudPayments
- `19` = MTS Pay

### Статус товара (`tl_com_products.status`)

- `1` = активен
- `2` = неактивен

### Тип варианта (`has_variant`)

- `1` = вариативный (несколько вариантов с разными ценами)
- `2` = простой (одна цена)

## Связи

```
tl_com_orders.customer_id         → tl_com_customers.id
tl_com_ordered_products.order_id  → tl_com_orders.id
tl_com_ordered_products.product_id→ tl_com_products.id
tl_com_products.source_id         → tl_com_sources.id
tl_com_products.brand             → tl_com_brands.id
tl_com_product_has_categories     → product_id + category_id
tl_com_customer_bonus.customer_id → tl_com_customers.id
tl_com_customer_bonus.order_id    → tl_com_orders.id
tl_com_coupon_usages.order_id     → tl_com_orders.id
tl_com_coupon_usages.coupon_id    → tl_com_coupons.id
tl_com_customer_referrals         → customer_id (пригласил) + referred_customer_id (приглашён)
```

## Рекомендации при составлении запросов

1. **Оплаченные заказы**: `WHERE o.payment_status = 1`
2. **Не отменённые заказы**: `WHERE o.delivery_status != 4`
3. **Активные клиенты**: `WHERE c.deleted_at IS NULL`
4. **Фильтр по магазину**: JOIN `tl_com_products` → `tl_com_sources`, фильтр `s.name LIKE '%iherb%'`
5. **Новые клиенты за период**: `WHERE c.created_at BETWEEN '...' AND '...'`
6. **Валюта**: все суммы в заказах (`total_payable_amount`, `unit_price` в ordered_products) — в рублях. Если пользователь спрашивает в долларах — уточни курс или используй приблизительный.
7. **Мини-апп**: `tl_com_orders.is_mini_app = 1` — заказы из Telegram мини-приложения.
8. **Заказ содержит**: `name`, `surname`, `patronymic`, `phone` — данные клиента продублированы в заказе.
9. **Сумма товара в позиции**: `unit_price * quantity`
10. **total_payable_amount** — итоговая сумма заказа к оплате (после скидок и бонусов)
11. **sub_total** — сумма товаров до скидок
12. **total_discount** — скидка по купону
13. **total_bonus_payment** — оплата бонусами
14. **total_balance_payment** — оплата с баланса (кэшбэк)

## Популярные источники (магазины)

| ID | Магазин |
|----|---------|
| 12 | iherb.com |
| 53 | nike.com |
| 62 | zara.com |
| 96 | asos.com |
| 193 | skims.com |
| 52 | macys.com |
| 192 | adidas.com |
| 155 | victoriassecret.com |
| 1 | amazon.com |
| 168 | ralphlauren.com |

## Полная документация по полям таблиц

Для детальной информации по всем полям см. [schema-reference.md](schema-reference.md)
