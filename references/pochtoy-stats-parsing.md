# Парсинг pochtoy.com — Справочник

## Назначение

Механизм получения свежих данных из внутреннего API pochtoy.com для обновления файла `scratch/data/pochtoy-stats.json`.

Используется когда пользователь просит:
- «скачай статистику»
- «обнови до сегодня»
- «добавь данные за последние дни»

## Источник данных

Внутренний API pochtoy.com. **НЕ требует CDP** (работает напрямую).

## Переменные окружения (.env)

```
POCHTOY_API_URL=<internal API endpoint>
POCHTOY_API_TOKEN=<token>
POCHTOY_STATS_FILE=scratch/data/pochtoy-stats.json
```

## Алгоритм обновления

```python
import json, os, requests
from datetime import date, timedelta

STATS_FILE = os.environ.get('POCHTOY_STATS_FILE', 'scratch/data/pochtoy-stats.json')
API_URL = os.environ['POCHTOY_API_URL']
API_TOKEN = os.environ['POCHTOY_API_TOKEN']

def load_stats():
    if os.path.exists(STATS_FILE):
        with open(STATS_FILE) as f:
            return json.load(f)
    return {}

def save_stats(data):
    with open(STATS_FILE, 'w') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def fetch_day(day: date):
    """Получить статистику за один день из API."""
    r = requests.get(
        f"{API_URL}/stats",
        headers={'Authorization': f'Bearer {API_TOKEN}'},
        params={'date': day.strftime('%Y-%m-%d')}
    )
    r.raise_for_status()
    return r.json()

def update_to_today():
    stats = load_stats()

    # Определить последнюю имеющуюся дату
    if stats:
        last_date = date.fromisoformat(max(stats.keys()))
        start = last_date + timedelta(days=1)
    else:
        start = date(2020, 1, 1)

    today = date.today()
    current = start
    updated = 0

    while current <= today:
        key = current.strftime('%Y-%m-%d')
        try:
            day_data = fetch_day(current)
            stats[key] = day_data
            updated += 1
            print(f"✓ {key}: получены данные")
        except Exception as e:
            print(f"✗ {key}: ошибка — {e}")
        current += timedelta(days=1)

    save_stats(stats)
    print(f"\nОбновлено дней: {updated}")
    print(f"Последняя дата: {max(stats.keys())}")
    return updated

if __name__ == '__main__':
    update_to_today()
```

## Запуск

```bash
cd /path/to/project
python3 references/update-stats.py
```

## Формат ответа API

```json
{
  "date": "2024-01-15",
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
```

## Проверка актуальности

```python
import json
from datetime import date

with open('scratch/data/pochtoy-stats.json') as f:
    stats = json.load(f)

last = max(stats.keys())
today = date.today().isoformat()
days_behind = (date.today() - date.fromisoformat(last)).days

print(f"Последняя дата в файле: {last}")
print(f"Сегодня: {today}")
print(f"Отставание: {days_behind} дней")
if days_behind > 1:
    print("⚠️ Рекомендуется обновить данные")
```
