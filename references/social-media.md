# Соцсети — Справочник

## Каналы проектов

| Платформа | Prostobox | Pochtoy |
|-----------|-----------|---------|
| Telegram | @prostoboxme | @poaborr |
| VK | prostobox | pochtoy.usa |
| TikTok | @prostobox.com | @pochtoy.usa |
| Dzen | prostobox | — |

---

## Telegram

### Метод получения данных

**Подписчики** — Telegram Bot API:
```bash
curl "https://api.telegram.org/bot<TOKEN>/getChatMembersCount?chat_id=@prostoboxme"
```

**Посты и просмотры** — web scraping `t.me/s/<channel>`:
```javascript
// Публичный веб-интерфейс канала
const url = `https://t.me/s/${channel}`;
// Парсим .tgme_widget_message_views для просмотров
// Парсим .tgme_widget_message_text для текста
// Парсим .tgme_widget_message_date для даты
```

### Токены (.env)
```
TELEGRAM_BOT_TOKEN_PROSTOBOX=<token>
TELEGRAM_BOT_TOKEN_POCHTOY=<token>
```

### CDP: НЕ требуется

---

## VK

### Метод: CDP-скрейпинг дашборда статистики

**URL:** `https://vk.com/stats?gid=<group_id>`

### CDP требуется: ДА

```javascript
// Шаги:
// 1. Проверь CDP: curl http://127.0.0.1:9222/json/version
// 2. Открыть страницу статистики VK
// 3. Скрейпить данные из таблиц дашборда
// 4. Извлечь: подписчики, охваты, ER, просмотры постов
```

### Метрики VK
- Подписчики (всего, новые, отписки)
- Охват (уникальные пользователи, видевшие записи)
- Посещаемость страницы
- Активность (лайки, репосты, комментарии)
- ER = (лайки + репосты + комментарии) / охват × 100

---

## TikTok

### Метод: CDP-скрейпинг публичного профиля

**URL:** `https://www.tiktok.com/@prostobox.com`

### CDP требуется: ДА

```javascript
// Шаги:
// 1. Проверь CDP
// 2. Перейти на профиль @prostobox.com или @pochtoy.usa
// 3. Извлечь: подписчики, лайки, кол-во видео
// 4. Для каждого видео: просмотры, лайки, комменты, репосты
```

### Метрики TikTok
- Подписчики
- Суммарные лайки профиля
- Количество видео
- Для видео: views, likes, comments, shares
- ER = (likes + comments + shares) / views × 100

---

## Dzen

### Метод: комбинированный

**Яндекс Метрика** (счетчик `107309881`):
- Трафик на канал из поиска
- Новые читатели через Метрику

**CDP редактора Dzen** (частично):
- URL: `https://dzen.ru/editor/`
- Подписчики, охваты, монетизация

### CDP: ЧАСТИЧНО

---

## TGStat

### Метод: CDP-скрейпинг всех вкладок

**URL:** `https://tgstat.ru/channel/@prostoboxme`

### CDP требуется: ДА

### Вкладки для скрейпинга:
1. **Обзор** — подписчики, ERR, охваты
2. **Публикации** — статистика постов
3. **Источники** — откуда приходят подписчики
4. **Упоминания** — где упоминают канал
5. **Рекламные посты** — история рекламы

### Метрики TGStat
- Subscribers — подписчики
- ERR (Engagement Rate by Reach) — вовлеченность по охвату
- Avg Post Reach — средний охват поста
- Daily Reach — ежедневный охват
- Views per post — просмотры на пост
- Mentions count — упоминания

---

## Общий алгоритм сбора соцсетей (CDP)

```javascript
// 1. Проверка CDP
const cdpAvailable = await checkCDP(); // curl http://127.0.0.1:9222/json/version
if (!cdpAvailable) { showCDPInstructions(); return; }

// 2. Подключение к CDP
const ws = new WebSocket(cdpEndpoint);

// 3. Открытие страницы
await sendCDPCommand('Page.navigate', { url: targetUrl });
await waitForLoad();

// 4. Извлечение данных
const data = await sendCDPCommand('Runtime.evaluate', {
  expression: `document.querySelector('.metric-selector').textContent`
});

// 5. Задержка между запросами (anti-bot)
await sleep(1000); // минимум 1 секунда
```

---

## Anti-bot правила

- Не более **1 запроса в секунду**
- Между сайтами — задержка **2-3 секунды**
- Если получили CAPTCHA — остановись и сообщи пользователю
- Не делать более **50 CDP-запросов** за одну сессию
