# CRM-данные — Справочник

## Файл данных

**Путь:** `scratch/data/pochtoy-stats.json`

**Содержимое:** Ежедневная статистика Pochtoy + Prostobox с 2020 года (2000+ дней).

## Структура JSON

```json
{
  "2024-01-01": {
    "pochtoy": {
      "parcelsReceived": 145,
      "ordersPurchased": 87,
      "itemsPurchased": 203,
      "ordersPurchasedAmount": 4521.50,
      "ticketsReceived": 12,
      "garageReceived": 34,
      "garageBought": 28,
      "garageSent": 41,
      "telegramBotUsers": 1205,
      "registrations": 23
    },
    "prostobox": {
      "parcelsReceived": 98,
      "ordersPurchased": 54,
      "itemsPurchased": 134,
      "ordersPurchasedAmount": 3102.75,
      "ticketsReceived": 8,
      "garageReceived": 12,
      "garageBought": 10,
      "garageSent": 15,
      "telegramBotUsers": 634,
      "registrations": 11
    }
  }
}
```

## Описание метрик

| Метрика | Описание |
|---------|----------|
| `parcelsReceived` | Получено посылок на склад |
| `ordersPurchased` | Оформлено заказов на выкуп |
| `itemsPurchased` | Куплено товаров (штук) |
| `ordersPurchasedAmount` | Сумма выкупленных заказов (USD) |
| `ticketsReceived` | Обращений в поддержку |
| `garageReceived` | Получено в гараж |
| `garageBought` | Куплено через гараж |
| `garageSent` | Отправлено из гаража |
| `telegramBotUsers` | Активных пользователей Telegram бота |
| `registrations` | Новых регистраций |

## Как читать данные

```python
import json
from datetime import date, timedelta

with open('scratch/data/pochtoy-stats.json') as f:
    data = json.load(f)

# Получить данные за конкретный день
day = data.get('2024-01-01', {})
pochtoy = day.get('pochtoy', {})

# Диапазон дат
def get_range(start_date, end_date):
    result = {}
    d = start_date
    while d <= end_date:
        key = d.strftime('%Y-%m-%d')
        if key in data:
            result[key] = data[key]
        d += timedelta(days=1)
    return result

# Суммировать за период
def sum_period(start_date, end_date, project='pochtoy'):
    period_data = get_range(start_date, end_date)
    totals = {}
    for day_data in period_data.values():
        proj = day_data.get(project, {})
        for k, v in proj.items():
            totals[k] = totals.get(k, 0) + (v or 0)
    return totals
```

## Сравнительные периоды

При запросе пользователя «за неделю» или «за период» — всегда сравнивай с:
1. **Предыдущим аналогичным периодом** (например, предыдущая неделя)
2. **Тем же периодом год назад**

```python
from datetime import date, timedelta

today = date.today()
week_ago = today - timedelta(days=7)
two_weeks_ago = today - timedelta(days=14)
year_ago_start = week_ago - timedelta(days=365)
year_ago_end = today - timedelta(days=365)

current = sum_period(week_ago, today)
prev_week = sum_period(two_weeks_ago, week_ago)
last_year = sum_period(year_ago_start, year_ago_end)
```

## Qwixit

У Qwixit нет CRM API. Используем Яндекс Метрику как прокси:
- Цель «Оформление заказа» (Goal ID нужно уточнить в интерфейсе) ≈ реальным заказам
- Counter ID: `95499360`
- Токен: `YANDEX_METRIKA_TOKEN_QWIXIT`

## Обновление данных

Данные обновляются через механизм парсинга pochtoy.com.
Подробности: `references/pochtoy-stats-parsing.md`

Для обновления до сегодняшней даты:
```bash
# Смотри references/pochtoy-stats-parsing.md
```

## Типичные KPI (ориентиры)

| Метрика | Нормальный день (Pochtoy) |
|---------|--------------------------|
| parcelsReceived | 100-200 |
| ordersPurchased | 50-120 |
| registrations | 15-40 |
| ticketsReceived | 8-20 |
