# Видеометрики — Справочник

## Назначение

Аналитика роликов по ссылкам из Telegram, VK, Dzen, TikTok.

**ER** = (likes + shares + comments + saves) / views × 100

## Скрипты

```
analytics/video-metrics/
├── run-sync.mjs          # Синхронизация всех источников в Google Sheet
├── query-period.mjs      # Запрос метрик за период
└── sources/
    ├── telegram.mjs      # Парсинг Telegram (без CDP)
    ├── vk.mjs            # Парсинг VK (с CDP)
    ├── dzen.mjs          # Парсинг Dzen (Метрика + CDP)
    └── tiktok.mjs        # Парсинг TikTok (с CDP)
```

## Источники и методы

| Источник | Метод | CDP | Метрики |
|----------|-------|-----|---------|
| Telegram | t.me/s/ scraping | Нет | views, forwards, reactions |
| VK | CDP дашборд | **Да** | views, likes, shares, comments |
| Dzen | Метрика API | Нет | pageviews, avg time |
| TikTok | CDP профиль | **Да** | views, likes, comments, shares |

## Запуск

```bash
# Синхронизировать все видео в Google Sheet
node analytics/video-metrics/run-sync.mjs --sheet <sheetId>

# Запрос за период
node analytics/video-metrics/query-period.mjs \
  --from 2024-01-01 --to 2024-01-31 \
  --source telegram,vk,tiktok
```

## Формат данных

```json
{
  "video_id": "unique-id",
  "source": "telegram",
  "url": "https://t.me/prostoboxme/123",
  "published_at": "2024-01-15T10:00:00",
  "title": "Заголовок ролика",
  "metrics": {
    "views": 15420,
    "likes": 342,
    "shares": 87,
    "comments": 23,
    "saves": 56
  },
  "er": 3.29,
  "collected_at": "2024-01-20T12:00:00"
}
```

## Структура Google Sheet

| Столбец | Описание |
|---------|----------|
| A | Дата публикации |
| B | Источник |
| C | URL |
| D | Заголовок |
| E | Просмотры |
| F | Лайки |
| G | Репосты/Поделились |
| H | Комментарии |
| I | Сохранения |
| J | ER (%) |
| K | Дата сбора |

## Telegram (без CDP)

```javascript
// Парсинг публичного веб-интерфейса канала
async function getTelegramPostMetrics(channel, postId) {
  const url = `https://t.me/s/${channel}`;
  const html = await fetch(url).then(r => r.text());
  // Извлечь данные конкретного поста по postId
  // .tgme_widget_message_views — просмотры
  // .tgme_widget_message_reactions — реакции
  return { views, reactions };
}
```

## VK (с CDP)

```javascript
// CDP-скрейпинг статистики видео
async function getVKVideoMetrics(videoUrl) {
  // 1. Проверить CDP доступность
  // 2. Открыть видео через CDP
  // 3. Извлечь .like_count, .share_count, .comment_count, .views_count
  return { views, likes, shares, comments };
}
```

## TikTok (с CDP)

```javascript
// CDP-скрейпинг публичной страницы видео
async function getTikTokVideoMetrics(videoUrl) {
  // 1. Проверить CDP
  // 2. Открыть URL видео
  // 3. Дождаться загрузки (TikTok SPA)
  // 4. Извлечь метрики из DOM или window.__INIT_PROPS__
  return { views, likes, comments, shares };
}
```

## Расчет ER

```javascript
function calculateER(metrics) {
  const { views, likes, shares, comments, saves = 0 } = metrics;
  if (!views) return 0;
  return ((likes + shares + comments + saves) / views * 100).toFixed(2);
}
```

## Бенчмарки ER по платформам

| Платформа | Слабый | Средний | Хороший |
|-----------|--------|---------|---------|
| Telegram | <1% | 1-3% | >3% |
| VK | <2% | 2-5% | >5% |
| TikTok | <3% | 3-8% | >8% |
| Dzen | <1% | 1-4% | >4% |
