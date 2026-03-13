/**
 * Источник: Telegram
 * Метод: web scraping t.me/s/<channel>
 * CDP: НЕ требуется
 */

const CHANNELS = {
  prostobox: '@prostoboxme',
  pochtoy:   '@poaborr',
};

/**
 * Получить посты канала за последние N дней.
 * @param {Object} options
 * @param {number} options.days
 * @returns {Promise<Array>}
 */
export async function fetchVideos({ days = 7 } = {}) {
  const allVideos = [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  for (const [project, handle] of Object.entries(CHANNELS)) {
    const channel = handle.replace('@', '');
    try {
      const posts = await fetchChannelPosts(channel, cutoff);
      const videos = posts
        .filter(p => p.hasVideo)
        .map(p => ({
          video_id: `tg-${channel}-${p.id}`,
          source: 'telegram',
          url: `https://t.me/${channel}/${p.id}`,
          title: p.text?.slice(0, 100),
          published_at: p.date,
          project,
          metrics: {
            views: p.views ?? 0,
            likes: p.reactions ?? 0,
            shares: p.forwards ?? 0,
            comments: p.comments ?? 0,
            saves: 0,
          },
        }));
      allVideos.push(...videos);
    } catch (err) {
      console.warn(`  Telegram ${channel}: ${err.message}`);
    }
  }

  return allVideos;
}

async function fetchChannelPosts(channel, cutoff) {
  // Парсинг публичного веб-интерфейса t.me/s/<channel>
  const url = `https://t.me/s/${channel}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html',
    }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  return parsePostsFromHTML(html, cutoff);
}

function parsePostsFromHTML(html, cutoff) {
  // Парсинг HTML-страницы t.me/s/<channel>
  // TODO: Реализовать парсинг DOM структуры Telegram web
  // Ключевые селекторы:
  // - .tgme_widget_message — контейнер поста
  // - .tgme_widget_message_views — просмотры
  // - .tgme_widget_message_date — дата (атрибут datetime)
  // - .tgme_widget_message_text — текст
  // - .tgme_widget_message_video — видео (если есть)

  const posts = [];
  // Regex-парсинг (упрощенный)
  const postRegex = /data-post="[^"]*\/(\d+)".*?datetime="([^"]+)".*?class="tgme_widget_message_views"[^>]*>([\d.KM]+)/gs;

  let match;
  while ((match = postRegex.exec(html)) !== null) {
    const [, id, datetime, viewsRaw] = match;
    const date = new Date(datetime);

    if (date < cutoff) continue;

    const views = parseViews(viewsRaw);
    const hasVideo = html.includes(`data-post="[^"]*/${id}"`) && html.includes('tgme_widget_message_video');

    posts.push({
      id,
      date: date.toISOString(),
      views,
      hasVideo,
      reactions: 0, // Telegram не показывает реакции публично
      forwards: 0,
      comments: 0,
      text: '',
    });
  }

  return posts;
}

function parseViews(raw) {
  if (!raw) return 0;
  const str = raw.trim();
  if (str.endsWith('K')) return Math.round(parseFloat(str) * 1000);
  if (str.endsWith('M')) return Math.round(parseFloat(str) * 1000000);
  return parseInt(str.replace(/[^0-9]/g, '')) || 0;
}
