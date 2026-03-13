# Конкуренты — Справочник

## Список конкурентов (10 посредников)

| # | Компания | Сайт | Позиционирование |
|---|----------|------|-----------------|
| 1 | Prostobox | prostobox.com | Наш проект |
| 2 | Pochtoy | pochtoy.com | Наш проект |
| 3 | Qwintry | qwintry.com | Крупный игрок США |
| 4 | Shopfans | shopfans.ru | Россия/США |
| 5 | Easyship | easyship.com | Глобальный агрегатор |
| 6 | CDEK | cdek.ru | Крупнейший в РФ |
| 7 | Polexp | polexp.com | Польша |
| 8 | LiteMF | litemf.com | США/Европа |
| 9 | Fishisfast | fishisfast.com | США |
| 10 | Undbox | undbox.com | Европа |

## Тарифные категории

Собираем цены по **3 категориям** отправлений:

| Категория | Описание |
|-----------|----------|
| Одежда | Легкие не-хрупкие товары |
| Электроника | Хрупкие/ценные товары |
| Смешанная | Общий тариф |

## Весовые диапазоны

Цены собираем для весов от 1 до 25 кг (с шагом 1 кг).

## Скрипты

```
docs/competitors/scripts/
├── collect_all.py      # Сбор цен со всех сайтов
├── build_tables.py     # Формирование сравнительных таблиц
└── push_to_sheets.mjs  # Загрузка в Google Sheets
```

## Google Sheet

**ID:** `1-RQb_bmYCIxcAtxGMEysPQPAl22VkaT5SUI8BUiWY4g`

Структура листов:
- `Сырые данные` — все цены со всех сайтов
- `Сравнение (одежда)` — сравнительная таблица для одежды
- `Сравнение (электроника)` — сравнительная таблица для электроники
- `Позиционирование` — наше место среди конкурентов

## Требования CDP

| Сайт | CDP нужен | Примечание |
|------|-----------|-----------|
| Prostobox | Нет | Публичные цены |
| Pochtoy | Нет | Публичные цены |
| Qwintry | Нет | Публичные цены |
| Shopfans | Нет | Публичные цены |
| Easyship | **Да** | Требует JS-рендеринга |
| CDEK | Нет | Калькулятор по API |
| Polexp | **Да** | Требует JS-рендеринга |
| LiteMF | Нет | Публичные цены |
| Fishisfast | Нет | Публичные цены |
| Undbox | Нет | Публичные цены |

**Google Sheets** — загрузка через CDP всегда.

## Запуск сбора данных

```bash
# Полный сбор (требует CDP для Polexp и Easyship)
cd ~/Desktop/AutoBuy && python3 docs/competitors/scripts/collect_all.py

# Только без CDP
cd ~/Desktop/AutoBuy && python3 docs/competitors/scripts/collect_all.py --no-cdp

# Загрузка в Google Sheets (требует CDP)
cd ~/Desktop/AutoBuy && node docs/competitors/scripts/push_to_sheets.mjs \
  --sheet 1-RQb_bmYCIxcAtxGMEysPQPAl22VkaT5SUI8BUiWY4g
```

## Формат данных collect_all.py

```python
# Выходной формат (CSV или JSON)
{
  "collected_at": "2024-01-15T12:00:00",
  "prices": {
    "qwintry": {
      "clothes": {"1kg": 12.5, "2kg": 16.0, ...},
      "electronics": {"1kg": 15.0, "2kg": 19.5, ...}
    },
    "shopfans": { ... },
    ...
  }
}
```

## Интерпретация результатов

При анализе конкурентов обращай внимание:
1. **Позиция Prostobox/Pochtoy** по цене среди конкурентов (1-й, 2-й, 3-й ценовой диапазон)
2. **Разница в %** от дешевейшего конкурента
3. **Динамика** — как менялись цены конкурентов за последний месяц
4. **Уникальные преимущества** (скорость, сервис, склады) не отражены в цене
