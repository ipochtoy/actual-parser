---
name: marketing-hub
description: >-
  Единый маркетинг-хаб: Яндекс Метрика (6 счетчиков), Яндекс Директ (3 аккаунта),
  соцсети (Telegram, VK, TikTok, Dzen, TGStat), CRM-данные Pochtoy/Prostobox,
  парсинг pochtoy.com, цены конкурентов, видеоаналитика, еженедельные отчеты.
  Включает CDP-воркфлоу для нетехнических пользователей.
---
# Marketing Hub
Суперскилл маркетинговой аналитики для трех проектов: **Prostobox**, **Pochtoy**, **Qwixit**.
## Когда использовать
Активируется на любой запрос, связанный с маркетингом, аналитикой или рекламой:
- «дай отчет за неделю», «метрика за март», «как директ»
- «сравни соцсети», «сверь ролики», «стата за 3 дня»
- «создай кампанию», «проверь модерацию», «запусти A/B тест»
- «обнови цены конкурентов», «сколько заказов», «как гараж»
- «скачай/обнови статистику», «почтой стата»
- «сравни Telegram и VK», «как тикток», «что с дзеном»
## Первый шаг: определи источник данных
```
Запрос пользователя
  │
  ├─ Метрика/трафик/воронка ──────► Модуль A (Яндекс Метрика)
  ├─ Директ/реклама/кампании ─────► Модуль B (Яндекс Директ)
  ├─ Соцсети/подписчики/ER ───────► Модуль C (Соцсети)    [может требовать CDP]
  ├─ Заказы/доход/регистрации ────► Модуль D (CRM-данные)
  ├─ Обнови стату pochtoy.com ────► Модуль E (Парсинг pochtoy.com)
  ├─ Конкуренты/цены/тарифы ──────► Модуль F (Конкуренты)  [требует CDP]
  ├─ Ролики/видео/охваты ────────► Модуль G (Видеометрики) [может требовать CDP]
  └─ Общий отчет ─────────────────► Комбинация модулей + references/report-templates.md
```
## CDP Pre-flight (ОБЯЗАТЕЛЬНО)
При любой задаче, требующей CDP (VK, TikTok, Dzen, TGStat, конкуренты, Google Sheets), ПЕРВЫМ ДЕЛОМ проверь доступность:
```bash
curl -s http://127.0.0.1:9222/json/version
```
Если ответ есть — продолжай. Если нет — выведи пользователю:
> Мне нужен доступ к браузеру для сбора данных.
>
> Пожалуйста:
> 1. **Закройте ВСЕ окна Google Chrome** (важно — все до единого)
> 2. Откройте **Терминал** (Cmd+Пробел → наберите «Terminal» → Enter)
> 3. Вставьте команду и нажмите Enter:
>    ```
>    cd ~/Desktop/AutoBuy/agent && node start-chrome.mjs
>    ```
> 4. Дождитесь надписи **«CDP ready on port 9222»**
> 5. В открывшемся Chrome **залогиньтесь** на нужных сайтах (VK, TikTok, Dzen — в зависимости от задачи)
> 6. Вернитесь сюда и скажите **«готово»**
После подтверждения — проверь повторно `curl` и продолжай.
## Модули
### A. Яндекс Метрика
Подробности: `references/metrika-api.md`
**Что умеет:** трафик, источники, цели, воронки, bounce rate, география, устройства, поисковики, соцсети-источники, топ страниц.
**Счетчики:**
| Проект | Counter ID |
|--------|-----------|
| prostobox.com | 57275935 |
| pochtoy.com | 21491899 |
| qwixit.com | 95499360 |
| garage.pochtoy.com | 107082295 |
| garage.prostobox.com | 107082444 |
| dzen.ru/prostobox | 107309881 |
**Токен:** `.env` → `YANDEX_METRIKA_TOKEN` (prostobox/pochtoy/garages) или `YANDEX_METRIKA_TOKEN_QWIXIT` (видит ВСЕ 6 счетчиков, включая qwixit и dzen).
**НЕ требует CDP.**
### B. Яндекс Директ
Подробности: `references/direct-api.md`
**Что умеет:** чтение кампаний, создание/редактирование объявлений, ключевые слова, отчеты (по кампаниям, объявлениям, ключам), модерация, A/B тесты.
**Аккаунты:**
| Проект | Логин | Токен (.env) | Валюта |
|--------|-------|-------------|--------|
| Prostobox | prostoboxmarketing | `YANDEX_DIRECT_TOKEN` | USD |
| Qwixit | qwixit | `YANDEX_QWIXIT_TOKEN` | USD |
| Pochtoy | pochtoynew | `YANDEX_POCHTOY_TOKEN` | USD |
**КРИТИЧНО:**
- Валюта — **USD**, НЕ рубли. Все суммы из API в долларах.
- НЕ трогать кампании директолога без явного указания пользователя.
- Кампании Claude имеют префикс `claude-`, Gemini — `gemini-`.
- Перед рекламой конкретных товаров — **проверь** `docs/SHIPPING_RULES.md` (запрещенка).
**НЕ требует CDP.**
### C. Соцсети
Подробности: `references/social-media.md`
| Платформа | Метод | CDP? |
|-----------|-------|------|
| Telegram | Bot API (подписчики) + web scraping t.me/s/ (посты, просмотры) | Нет |
| VK | CDP-скрейпинг дашборда | **Да** |
| TikTok | CDP-скрейпинг профиля и видео (публичные данные) | **Да** |
| Dzen | Метрика (счетчик 98682040) + CDP редактора | Частично |
| TGStat.ru | CDP-скрейпинг всех вкладок | **Да** |
**Каналы:**
- Telegram: `@prostoboxme`, `@poaborr`
- VK: prostobox, pochtoy.usa
- TikTok: `@prostobox.com`, `@pochtoy.usa`
- Dzen: prostobox
### D. CRM-данные
Подробности: `references/crm-data.md`
**Файл:** `scratch/data/pochtoy-stats.json` — ежедневная статистика Pochtoy + Prostobox (2000+ дней, с 2020 года).
**Метрики:** parcelsReceived, ordersPurchased, itemsPurchased, ordersPurchasedAmount, ticketsReceived, garageReceived, garageBought, garageSent, telegramBotUsers, registrations.
**Сравнения:** день / 3 дня / неделя / месяц vs прошлый период и прошлый год.
**Для Qwixit:** CRM API пока нет, используем Метрику как прокси (цель «Оформление заказа» ≈ реальным заказам).
**НЕ требует CDP.**
### E. Парсинг pochtoy.com
Подробности: `references/pochtoy-stats-parsing.md`
Механизм получения свежих данных для `pochtoy-stats.json`. Используется когда пользователь просит «скачай статистику» или «обнови до сегодня».
**НЕ требует CDP** (работает через внутренний API).
### F. Конкуренты
Подробности: `references/competitors.md`
10 посредников (Prostobox, Pochtoy, Qwintry, Shopfans, Easyship, CDEK, Polexp, LiteMF, Fishisfast, Undbox). Цены 1–25 кг, 3 категории тарифов.
**Скрипты:** `docs/competitors/scripts/` (collect_all.py, build_tables.py, push_to_sheets.mjs).
**Google Sheet:** `1-RQb_bmYCIxcAtxGMEysPQPAl22VkaT5SUI8BUiWY4g`
**Требует CDP** для Polexp, Easyship и заливки в Google Sheets.
### G. Видеометрики
Подробности: `references/video-metrics.md`
Аналитика роликов по ссылкам из Telegram, VK, Dzen, TikTok.
**Скрипты:** `analytics/video-metrics/` (run-sync.mjs, query-period.mjs, sources/*).
**ER** = (likes + shares + comments + saves) / views × 100.
**Может требовать CDP** для VK и TikTok.
## Отчеты
Подробности: `references/report-templates.md`
| Тип отчета | Для кого | Источники |
|-----------|---------|-----------|
| Еженедельный маркетинг | Руководитель | Метрика + Директ + соцсети + CRM |
| Директ-отчет | Директолог | Директ + воронка Метрики |
| SMM-отчет | SMM-менеджер | Соцсети + видеометрики |
| CRM-дашборд | Руководитель | CRM + Метрика (сверка целей) |
Формат: Markdown → PDF через `python3 /tmp/md2pdf.py input.md output.pdf`.
## Правила безопасности
1. **Запрещенка:** Перед созданием рекламы конкретных товаров ВСЕГДА проверяй `docs/SHIPPING_RULES.md`. Бытовая техника, электроинструменты, ножи, дроны — ЗАПРЕЩЕНЫ.
2. **Директ:** НЕ трогай чужие кампании. НЕ меняй ставки/ключи директолога. Только свои (prefix `claude-` или `gemini-`).
3. **Валюта:** Директ работает в USD. НЕ пересчитывай в рубли, если пользователь не просит.
4. **Цели Метрики:** Могут быть сломаны (особенно regprosobox для Prostobox). Всегда сверяй с CRM-данными.
5. **Anti-bot:** При CDP-скрейпинге не делай больше 1 запроса в секунду. Используй задержки.
## Кешированные snapshot-ы
В `references/snapshot-YYYY-MM-DD.md` хранятся готовые снимки данных за конкретные дни. **Перед парсингом проверь** — возможно, данные уже собраны.
## Быстрые команды
```bash
# Проверить CDP
curl -s http://127.0.0.1:9222/json/version
# Запустить Chrome с CDP
cd ~/Desktop/AutoBuy/agent && node start-chrome.mjs
# Собрать цены конкурентов
cd ~/Desktop/AutoBuy && python3 docs/competitors/scripts/collect_all.py
# Синхронизировать видеометрики
cd ~/Desktop/AutoBuy && node analytics/video-metrics/run-sync.mjs --sheet <sheetId>
```
