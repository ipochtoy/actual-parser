# Яндекс Директ API — Справочник

## Аккаунты и токены

| Проект | Логин | Переменная .env | Валюта |
|--------|-------|-----------------|--------|
| Prostobox | prostoboxmarketing | `YANDEX_DIRECT_TOKEN` | **USD** |
| Qwixit | qwixit | `YANDEX_QWIXIT_TOKEN` | **USD** |
| Pochtoy | pochtoynew | `YANDEX_POCHTOY_TOKEN` | **USD** |

> **КРИТИЧНО:** Все суммы в API в долларах (USD). НЕ конвертировать в рубли.

## Базовый URL

```
https://api.direct.yandex.com/json/v5/
```

## Аутентификация

```bash
Authorization: Bearer <TOKEN>
Client-Login: <логин>  # обязателен для агентских токенов
Accept-Language: ru
```

## Основные сервисы API v5

### Кампании (campaigns)
```bash
POST https://api.direct.yandex.com/json/v5/campaigns
```

**Получить список кампаний:**
```json
{
  "method": "get",
  "params": {
    "SelectionCriteria": {},
    "FieldNames": ["Id", "Name", "Status", "Type", "Statistics"],
    "Page": {"Limit": 1000}
  }
}
```

### Группы объявлений (adgroups)
```bash
POST https://api.direct.yandex.com/json/v5/adgroups
```

### Объявления (ads)
```bash
POST https://api.direct.yandex.com/json/v5/ads
```

**Получить объявления кампании:**
```json
{
  "method": "get",
  "params": {
    "SelectionCriteria": {
      "CampaignIds": [12345]
    },
    "FieldNames": ["Id", "Status", "AdGroupId"],
    "TextAdFieldNames": ["Title", "Title2", "Text", "Href"],
    "Page": {"Limit": 1000}
  }
}
```

### Ключевые слова (keywords)
```bash
POST https://api.direct.yandex.com/json/v5/keywords
```

### Отчеты (reports)
```bash
POST https://api.direct.yandex.com/json/v5/reports
```

**Пример отчета по кампаниям:**
```json
{
  "params": {
    "SelectionCriteria": {
      "DateFrom": "2024-01-01",
      "DateTo": "2024-01-31"
    },
    "FieldNames": [
      "CampaignId", "CampaignName", "Date",
      "Impressions", "Clicks", "Cost",
      "Conversions", "ConversionRate", "CostPerConversion"
    ],
    "ReportName": "weekly-report",
    "ReportType": "CAMPAIGN_PERFORMANCE_REPORT",
    "DateRangeType": "CUSTOM_DATE",
    "Format": "TSV",
    "IncludeVAT": "NO",
    "IncludeDiscount": "YES"
  }
}
```

## Работа с отчетами (асинхронный режим)

Отчеты генерируются асинхронно. Алгоритм:

```python
import requests, time

def get_report(token, login, body):
    headers = {
        'Authorization': f'Bearer {token}',
        'Client-Login': login,
        'Accept-Language': 'ru',
        'processingMode': 'auto',
        'returnMoneyInMicros': 'false',
    }
    url = 'https://api.direct.yandex.com/json/v5/reports'

    while True:
        r = requests.post(url, headers=headers, json=body)
        if r.status_code == 200:
            return r.text  # TSV данные
        elif r.status_code == 201:
            retry = int(r.headers.get('retryIn', 60))
            time.sleep(retry)
        elif r.status_code == 202:
            retry = int(r.headers.get('retryIn', 60))
            time.sleep(retry)
        else:
            raise Exception(f"Error {r.status_code}: {r.text}")
```

## Правила безопасности

1. **НЕ трогай** кампании без префикса `claude-` или `gemini-` (они директолога).
2. **НЕ меняй** ставки и ключевые слова без явного указания пользователя.
3. **Перед созданием рекламы товаров** — проверь `docs/SHIPPING_RULES.md`.
4. **Именование новых кампаний:** `claude-<описание>-<дата>`.

## Статусы кампаний

| Статус | Описание |
|--------|----------|
| ACCEPTED | Активна |
| ON_MODERATION | На модерации |
| REJECTED | Отклонена |
| SUSPENDED | Остановлена |
| ENDED | Завершена |

## Коды ошибок API

| Код | Описание |
|-----|----------|
| 200 | Успех |
| 201 | Отчет формируется (подожди retryIn секунд) |
| 202 | Отчет в очереди |
| 400 | Ошибка запроса |
| 500 | Ошибка сервера Яндекса |

## Лимиты

- Не более 10 000 кампаний на аккаунт
- Не более 20 000 запросов в сутки
- Отчеты: не более 6 одновременных запросов
