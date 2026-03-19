# Qwixit — Справочник по схеме БД

## tl_com_orders (Заказы)

| Поле | Тип | Описание |
|------|-----|----------|
| id | int PK | ID заказа |
| external_id | int unsigned | Внешний ID (Pochtoy) |
| external_customer_id | int unsigned | Внешний ID клиента |
| pochtoy_error | text | Ошибка Pochtoy |
| order_code | varchar(50) | Код заказа |
| customer_id | int FK | → tl_com_customers.id |
| name | varchar(50) | Имя клиента (копия) |
| surname | varchar(50) | Фамилия клиента (копия) |
| patronymic | varchar(50) | Отчество клиента (копия) |
| phone | varchar(50) | Телефон клиента (копия) |
| sub_total | double | Подитог (сумма товаров до скидок), руб. |
| total_tax | double | Налог |
| total_delivery_cost | double | Стоимость доставки, руб. |
| total_customs_cost | int | Стоимость таможни, руб. |
| total_discount | double | Скидка по купону, руб. |
| total_bonus_payment | int | Оплата бонусами, руб. |
| total_balance_payment | int | Оплата с баланса (кэшбэк), руб. |
| total_payable_amount | double | Итого к оплате (после скидок/бонусов), руб. |
| total_order_amount | double | Полная сумма заказа, руб. |
| payment_method | int FK | → tl_com_payment_methods.id |
| wallet_payment | int | Оплата кошельком (2=нет) |
| shipping_type | int | 1=самовывоз, 2=доставка |
| pickup_point_id | int FK | ID пункта выдачи |
| shipping_address | int FK | → tl_com_customer_address.id |
| billing_address | int FK | → tl_com_customer_address.id |
| delivery_date | timestamp | Дата доставки |
| note | text | Примечание к заказу |
| payment_status | int | 1=оплачен, 2=не оплачен |
| delivery_status | int | 1=delivered, 2=pending, 3=shipped, 4=cancelled, 5=processing, 6=ready_to_ship, 7=purchased |
| read_at | timestamp | Время прочтения админом |
| created_at | timestamp | Дата создания |
| updated_at | timestamp | Дата обновления |
| pickup_point_code | varchar(100) | Код ПВЗ |
| address | varchar(255) | Адрес доставки |
| postal_code | varchar(6) | Почтовый индекс |
| is_mini_app | tinyint | 1=заказ из Telegram мини-приложения |

## tl_com_ordered_products (Позиции заказов)

| Поле | Тип | Описание |
|------|-----|----------|
| id | int PK | ID позиции |
| order_id | int FK | → tl_com_orders.id |
| seller_id | int | ID продавца |
| product_id | int FK | → tl_com_products.id |
| variant_id | text | Код варианта |
| quantity | int | Количество |
| price_data | text | Данные о ценах (JSON) |
| purchase_price | double | Закупочная цена |
| delivery_cost | double | Стоимость доставки позиции |
| shipping_rate | int FK | → tl_com_shipping_zone_has_rates.id |
| tax | double | Налог |
| discount | double | Скидка |
| unit_price | double | Цена за единицу, руб. |
| order_discount | double | Скидка по заказу |
| total_paid | double | Итого оплачено |
| total_discounted | double | Итого скидка |
| total_bonus_paid | double | Оплачено бонусами |
| attachment | text | Вложение |
| image | text | Изображение товара |
| delivery_status | int | Статус доставки позиции |
| payment_status | int | 1=оплачен, 2=не оплачен |
| status_reason | varchar(255) | Причина статуса |
| returned_sum | double(10,2) | Возвращённая сумма |
| delivery_time | timestamp | Дата доставки |
| return_status | int | 1=not_available, 2=available, 3=returned, 4=processing, 5=return_cancel |
| tracking_id | text | Трек-номер |
| created_at | timestamp | Дата создания |

## tl_com_customers (Клиенты)

Использует soft delete (`deleted_at`).

| Поле | Тип | Описание |
|------|-----|----------|
| id | int PK | ID клиента |
| external_id | int unsigned | Внешний ID |
| uid | varchar(250) | Уникальный код (реферальный код) |
| provider | varchar(255) | Провайдер авторизации |
| provider_id | varchar(255) | ID провайдера |
| name | varchar(50) | Имя |
| surname | varchar(50) | Фамилия |
| patronymic | varchar(50) | Отчество |
| email | varchar(200) | Email |
| image | int | ID аватара |
| phone_code | varchar(50) | Код телефона |
| phone | varchar(255) | Телефон |
| status | int | 1=активен, 2=неактивен |
| verified_at | timestamp | Дата верификации |
| is_logedin | int | 1=залогинен, 2=нет |
| created_at | timestamp | Дата регистрации |
| deleted_at | timestamp | Soft delete (NULL=активен) |

## tl_com_products (Товары)

| Поле | Тип | Описание |
|------|-----|----------|
| id | int PK | ID товара |
| name | varchar(255) | Название (на русском) |
| name_en | varchar(255) | Название (на английском) |
| sku | varchar(150) UK | Артикул |
| product_group | varchar(32) | Группа товаров (связанные цвета/модели) |
| color_name | varchar(150) | Название цвета(ов), через '/' |
| color_code | varchar(30) | HEX-код цвета(ов), через '/' |
| variant_type | varchar(20) | Тип варианта (напр. "Размер") |
| variant_value | varchar(50) | Значение варианта |
| vendor_code | varchar(50) | Код поставщика |
| barcode | varchar(50) | Штрихкод |
| brand | int FK | → tl_com_brands.id |
| summary | text | Краткое описание |
| description | text | Полное описание |
| permalink | varchar(500) | URL-slug |
| has_variant | int | 1=вариативный, 2=простой |
| thumbnail_image | varchar(20) | ID миниатюры |
| is_featured | int | Рекомендованный |
| status | int | 1=активен, 2=неактивен |
| is_approved | int | 1=одобрен |
| source_id | int unsigned FK | → tl_com_sources.id (магазин-источник) |
| is_free_delivery | tinyint | 1=бесплатная доставка |
| shipping_cost | double | Стоимость доставки |
| created_at | timestamp | Дата создания |

## tl_com_sources (Магазины-источники)

| Поле | Тип | Описание |
|------|-----|----------|
| id | bigint unsigned PK | ID источника |
| name | varchar(255) | Название (напр. iherb.com, nike.com) |
| permalink | varchar(255) | URL-slug |

## tl_com_categories (Категории)

| Поле | Тип | Описание |
|------|-----|----------|
| id | int PK | ID категории |
| name | varchar(150) | Название |
| permalink | text | URL |
| parent | int FK | → self.id (родитель, иерархия) |
| is_featured | int | 1=рекомендованная, 2=нет |
| status | int | 1=активна |
| products_count | int | Кол-во товаров |
| is_private | tinyint | 1=приватная, 2=публичная |

## tl_com_brands (Бренды)

| Поле | Тип | Описание |
|------|-----|----------|
| id | int PK | ID бренда |
| name | varchar(150) | Название |
| is_featured | text | Рекомендованный |
| status | int | 1=активен |
| products_count | int | Кол-во товаров |

## tl_com_single_product_price (Цены простых товаров)

| Поле | Тип | Описание |
|------|-----|----------|
| id | int PK | ID |
| product_id | int FK | → tl_com_products.id |
| is_fixed_price | tinyint | 1=цена в рублях (без конвертации), 0=в USD |
| sku | varchar(150) | Артикул |
| purchase_price | double | Закупочная цена |
| unit_price | double | Цена продажи |
| quantity | int | Остаток на складе |
| price_old | double | Старая цена (для зачёркивания) |

## tl_com_variant_product_price (Цены вариантов)

| Поле | Тип | Описание |
|------|-----|----------|
| id | int PK | ID |
| product_id | int FK | → tl_com_products.id |
| variant | varchar(255) | Код варианта (формат "color:123/4:56") |
| sku | varchar(150) | Артикул варианта |
| purchase_price | double | Закупочная цена |
| unit_price | double | Цена продажи |
| quantity | int | Остаток |
| price_old | double | Старая цена |
| status | int | 1=активен |

## tl_com_customer_bonus (Бонусы клиентов)

| Поле | Тип | Описание |
|------|-----|----------|
| id | bigint PK | ID |
| customer_id | int FK | → tl_com_customers.id |
| admin_id | int unsigned | → tl_users.id (кто начислил) |
| order_id | int FK | → tl_com_orders.id |
| ordered_product_id | int unsigned FK | → tl_com_ordered_products.id |
| ordered_product_tracking_id | varchar(255) | Трекинг ID для привязки |
| amount | double(10,2) | Сумма бонусов |
| amount_used | double(10,2) | Использовано бонусов |
| comment | varchar(255) | Комментарий |
| will_expire_at | timestamp | Дата предполагаемого сгорания |
| expired_at | timestamp | Дата сгорания (NULL=активны) |

## tl_com_customer_balance (Баланс / кэшбэк)

| Поле | Тип | Описание |
|------|-----|----------|
| id | bigint PK | ID |
| customer_id | int FK | → tl_com_customers.id |
| admin_id | int unsigned | Кто начислил |
| order_id | int FK | → tl_com_orders.id |
| ordered_product_id | int unsigned | → tl_com_ordered_products.id |
| ordered_product_tracking_id | varchar(255) | Трекинг ID |
| amount | double(10,2) | Сумма (>0 = пополнение, <0 = списание) |
| comment | varchar(255) | Комментарий |

## tl_com_coupons (Купоны)

| Поле | Тип | Описание |
|------|-----|----------|
| id | int PK | ID |
| code | varchar(50) | Код купона |
| customer_id | int unsigned | → tl_com_customers.id (персональный промокод, 0=общий) |
| description | text | Описание |
| discount_type | int | 1=процент, 2=фиксированная сумма |
| discount_amount | double | Размер скидки |
| expire_date | date | Дата истечения |
| free_shipping | int | Бесплатная доставка |
| status | int | Статус |
| minimum_spend_amount | double | Минимальная сумма заказа |
| usage_limit_per_coupon | int | Лимит использований на купон |
| usage_limit_per_user | int | Лимит на пользователя |

## tl_com_coupon_usages (Использования купонов)

| Поле | Тип | Описание |
|------|-----|----------|
| id | int PK | ID |
| coupon_id | int FK | → tl_com_coupons.id |
| customer_id | int FK | → tl_com_customers.id |
| order_id | int FK | → tl_com_orders.id |
| discounted_amount | double | Сумма скидки |
| coupon_code | text | Код купона |

## tl_com_payment_transactions (Платёжные транзакции)

| Поле | Тип | Описание |
|------|-----|----------|
| id | int PK | ID |
| payment_id | bigint unsigned | ID платежа |
| reference_id | int unsigned | ID ссылки (order_id) |
| payment_method | varchar(50) | Метод оплаты (текст) |
| paid_amount | double | Оплаченная сумма |
| payment_for | varchar(150) | Назначение платежа |
| payment_info | mediumtext | Доп. информация (JSON) |
| customer_id | int FK | → tl_com_customers.id |
| status | int | 1=успешно |

## tl_com_customer_referrals (Реферальные связи)

| Поле | Тип | Описание |
|------|-----|----------|
| id | bigint PK | ID |
| customer_id | int unsigned FK | Кто пригласил |
| referred_customer_id | int unsigned FK | Кого пригласили |

## tl_com_product_has_categories (Связь товар → категория)

| Поле | Тип | Описание |
|------|-----|----------|
| id | int PK | ID |
| product_id | int FK | → tl_com_products.id |
| category_id | int FK | → tl_com_categories.id |

## tl_com_source_bonus (Бонус по источнику)

| Поле | Тип | Описание |
|------|-----|----------|
| id | bigint PK | ID |
| source_id | int FK | → tl_com_sources.id |
| value | double(10,2) | Процент бонуса |
| status | tinyint | 1=активен |

## tl_com_customer_address (Адреса клиентов)

| Поле | Тип | Описание |
|------|-----|----------|
| id | int PK | ID |
| customer_id | int FK | → tl_com_customers.id |
| name | varchar(250) | Название адреса |
| country_id | int FK | ID страны |
| state_id | int FK | ID региона |
| city_id | int FK | ID города |
| postal_code | varchar(150) | Индекс |
| address | mediumtext | Адрес |
| phone | mediumtext | Телефон |
| default_shipping | int | 1=адрес доставки по умолчанию |
| default_billing | int | 1=адрес оплаты по умолчанию |

## tl_com_payment_methods (Методы оплаты)

| Поле | Тип | Описание |
|------|-----|----------|
| id | int PK | ID |
| name | varchar(50) | Название (Tinkoff, CloudPayments и др.) |
| status | int | Статус |
| sort_order | int | Порядок сортировки |

## Примеры запросов

### Товары с iHerb, купленные в феврале 2025

```sql
SELECT COUNT(DISTINCT op.id) as positions, SUM(op.quantity) as items,
       ROUND(SUM(op.unit_price * op.quantity)) as revenue
FROM tl_com_ordered_products op
JOIN tl_com_orders o ON o.id = op.order_id
JOIN tl_com_products p ON p.id = op.product_id
JOIN tl_com_sources s ON s.id = p.source_id
WHERE s.name LIKE '%iherb%'
  AND o.payment_status = 1
  AND o.delivery_status != 4
  AND o.created_at >= '2025-02-01'
  AND o.created_at < '2025-03-01';
```

### Новые клиенты в марте с покупками > 10000 руб

```sql
SELECT c.id, c.name, c.surname, c.email,
       COUNT(DISTINCT o.id) as orders_count,
       ROUND(SUM(o.total_payable_amount)) as total_spent
FROM tl_com_customers c
JOIN tl_com_orders o ON o.customer_id = c.id
WHERE c.created_at >= '2025-03-01'
  AND c.created_at < '2025-04-01'
  AND c.deleted_at IS NULL
  AND o.payment_status = 1
  AND o.delivery_status != 4
GROUP BY c.id, c.name, c.surname, c.email
HAVING total_spent > 10000;
```

### Выручка по месяцам

```sql
SELECT DATE_FORMAT(created_at, '%Y-%m') as month,
       COUNT(*) as orders,
       ROUND(SUM(total_payable_amount)) as revenue
FROM tl_com_orders
WHERE payment_status = 1
  AND delivery_status != 4
GROUP BY month
ORDER BY month DESC
LIMIT 12;
```

### Топ-10 магазинов по выручке

```sql
SELECT s.name as source, COUNT(DISTINCT o.id) as orders,
       ROUND(SUM(op.unit_price * op.quantity)) as revenue
FROM tl_com_ordered_products op
JOIN tl_com_orders o ON o.id = op.order_id
JOIN tl_com_products p ON p.id = op.product_id
JOIN tl_com_sources s ON s.id = p.source_id
WHERE o.payment_status = 1 AND o.delivery_status != 4
GROUP BY s.id, s.name
ORDER BY revenue DESC
LIMIT 10;
```

### Средний чек

```sql
SELECT ROUND(AVG(total_payable_amount)) as avg_check
FROM tl_com_orders
WHERE payment_status = 1
  AND delivery_status != 4
  AND total_payable_amount > 0;
```
