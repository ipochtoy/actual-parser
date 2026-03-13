# Яндекс Метрика API — Справочник

## Аутентификация

```bash
# Токен из .env
YANDEX_METRIKA_TOKEN=<prostobox/pochtoy/garages>
YANDEX_METRIKA_TOKEN_QWIXIT=<видит все 6 счетчиков>
```

Заголовок запроса: `Authorization: OAuth <TOKEN>`

## Счетчики

| Проект | Counter ID |
|--------|-----------|
| prostobox.com | 57275935 |
| pochtoy.com | 21491899 |
| qwixit.com | 95499360 |
| garage.pochtoy.com | 107082295 |
| garage.prostobox.com | 107082444 |
| dzen.ru/prostobox | 107309881 |

## Базовый URL

```
https://api-metrika.yandex.net/stat/v1/data
```

## Параметры запроса

| Параметр | Описание | Пример |
|----------|----------|--------|
| `id` | ID счетчика | `57275935` |
| `date1` | Начало периода | `2024-01-01` или `7daysAgo` |
| `date2` | Конец периода | `2024-01-31` или `today` |
| `metrics` | Метрики через запятую | `ym:s:visits,ym:s:pageviews` |
| `dimensions` | Группировки | `ym:s:date` |
| `filters` | Фильтры сегментов | `ym:s:trafficSource=='organic'` |
| `limit` | Лимит строк | `100` |
| `sort` | Сортировка | `-ym:s:visits` |

## Основные метрики

### Трафик
- `ym:s:visits` — визиты
- `ym:s:pageviews` — просмотры страниц
- `ym:s:users` — уникальные посетители
- `ym:s:newUsers` — новые пользователи
- `ym:s:bounceRate` — процент отказов
- `ym:s:avgVisitDurationSeconds` — среднее время на сайте
- `ym:s:pageDepth` — глубина просмотра

### Конверсии (цели)
- `ym:s:goal<ID>reaches` — достижения цели
- `ym:s:goal<ID>conversionRate` — конверсия цели

### Источники
- `ym:s:trafficSource` — тип источника (organic, direct, referral, social, ad)
- `ym:s:searchEngine` — поисковик
- `ym:s:socialNetwork` — соцсеть

## Популярные измерения (dimensions)

- `ym:s:date` — по дням
- `ym:s:month` — по месяцам
- `ym:s:trafficSource` — по источникам
- `ym:s:searchPhrase` — по поисковым запросам
- `ym:s:startURL` — по URL входа
- `ym:s:regionCity` — по городам
- `ym:s:deviceCategory` — по устройствам (desktop/mobile/tablet)
- `ym:s:browser` — по браузерам

## Примеры запросов

### Трафик за последние 7 дней по дням
```bash
curl -H "Authorization: OAuth $YANDEX_METRIKA_TOKEN" \
  "https://api-metrika.yandex.net/stat/v1/data?id=57275935&metrics=ym:s:visits,ym:s:users&dimensions=ym:s:date&date1=7daysAgo&date2=today&limit=10&sort=ym:s:date"
```

### Источники трафика за неделю
```bash
curl -H "Authorization: OAuth $YANDEX_METRIKA_TOKEN" \
  "https://api-metrika.yandex.net/stat/v1/data?id=21491899&metrics=ym:s:visits&dimensions=ym:s:trafficSource&date1=7daysAgo&date2=today"
```

### Достижения цели (регистрации)
```bash
curl -H "Authorization: OAuth $YANDEX_METRIKA_TOKEN" \
  "https://api-metrika.yandex.net/stat/v1/data?id=57275935&metrics=ym:s:goal<GOAL_ID>reaches&dimensions=ym:s:date&date1=7daysAgo&date2=today"
```

## Получить список целей счетчика
```bash
curl -H "Authorization: OAuth $YANDEX_METRIKA_TOKEN" \
  "https://api-metrika.yandex.net/management/v1/counter/57275935/goals"
```

## Коды ошибок

| Код | Описание |
|-----|----------|
| 200 | OK |
| 403 | Нет доступа к счетчику (проверь токен) |
| 429 | Rate limit (подожди и повтори) |

## Формат ответа

```json
{
  "data": [
    {
      "dimensions": [{"name": "2024-01-01", "id": "2024-01-01"}],
      "metrics": [1234, 567]
    }
  ],
  "totals": [5678, 1234],
  "query": { ... }
}
```

## Сводка по периодам (Python helper)

```python
import os, requests

TOKEN = os.environ['YANDEX_METRIKA_TOKEN']
HEADERS = {'Authorization': f'OAuth {TOKEN}'}
BASE = 'https://api-metrika.yandex.net/stat/v1/data'

def get_visits(counter_id, date1, date2):
    params = {
        'id': counter_id,
        'metrics': 'ym:s:visits,ym:s:users,ym:s:newUsers,ym:s:bounceRate',
        'date1': date1,
        'date2': date2,
    }
    r = requests.get(BASE, headers=HEADERS, params=params)
    r.raise_for_status()
    return r.json()['totals']
```
