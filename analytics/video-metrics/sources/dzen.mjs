/**
 * Источник: Dzen
 * Метод: Яндекс Метрика API (счетчик 107309881)
 * CDP: НЕ требуется (для видео через Метрику)
 */

import { readFileSync } from 'fs';

// Счетчик Dzen Prostobox
const DZEN_COUNTER_ID = '107309881';
const METRIKA_BASE = 'https://api-metrika.yandex.net/stat/v1/data';

function getToken() {
  // Читаем из окружения
  return process.env.YANDEX_METRIKA_TOKEN_QWIXIT || process.env.YANDEX_METRIKA_TOKEN;
}

/**
 * Получить метрики видео Dzen за последние N дней.
 * @param {Object} options
 * @param {number} options.days
 * @returns {Promise<Array>}
 */
export async function fetchVideos({ days = 7 } = {}) {
  const token = getToken();
  if (!token) {
    throw new Error('YANDEX_METRIKA_TOKEN не задан в .env');
  }

  const today = new Date().toISOString().slice(0, 10);
  const from = new Date();
  from.setDate(from.getDate() - days);
  const fromStr = from.toISOString().slice(0, 10);

  // Получить топ страниц с видео
  const params = new URLSearchParams({
    id: DZEN_COUNTER_ID,
    date1: fromStr,
    date2: today,
    metrics: 'ym:pv:pageviews,ym:pv:avgTimeOnPageSeconds',
    dimensions: 'ym:pv:URLPath',
    filters: "ym:pv:URLPath=~'/video/'",
    limit: '50',
    sort: '-ym:pv:pageviews',
  });

  const res = await fetch(`${METRIKA_BASE}?${params}`, {
    headers: { 'Authorization': `OAuth ${token}` }
  });

  if (!res.ok) {
    throw new Error(`Метрика API: HTTP ${res.status}`);
  }

  const data = await res.json();

  return (data.data ?? []).map(row => {
    const path = row.dimensions[0]?.name ?? '';
    const views = row.metrics[0] ?? 0;
    const avgTime = row.metrics[1] ?? 0;

    return {
      video_id: `dzen-${path.replace(/\//g, '-')}`,
      source: 'dzen',
      url: `https://dzen.ru${path}`,
      title: path.split('/').pop()?.replace(/-/g, ' ') ?? '',
      published_at: null, // Метрика не дает дату публикации
      project: 'prostobox',
      metrics: {
        views,
        likes: 0,    // Метрика не дает лайки
        shares: 0,
        comments: 0,
        saves: 0,
      },
      extra: { avgTimeOnPage: avgTime },
    };
  });
}
