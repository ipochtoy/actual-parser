/**
 * Источник: VK
 * Метод: CDP-скрейпинг дашборда
 * CDP: ТРЕБУЕТСЯ
 */

const GROUPS = {
  prostobox: 'prostobox',
  pochtoy:   'pochtoy.usa',
};

const CDP_URL = 'http://127.0.0.1:9222';

async function sendCDP(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Date.now();
    const msg = JSON.stringify({ id, method, params });
    ws.send(msg);
    const handler = (data) => {
      const response = JSON.parse(data.toString());
      if (response.id === id) {
        ws.off('message', handler);
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result);
      }
    };
    ws.on('message', handler);
    setTimeout(() => reject(new Error('CDP timeout')), 30000);
  });
}

async function getWSEndpoint() {
  const res = await fetch(`${CDP_URL}/json`);
  const pages = await res.json();
  const page = pages.find(p => p.type === 'page');
  return page?.webSocketDebuggerUrl;
}

/**
 * Получить видео VK-групп за последние N дней.
 * @param {Object} options
 * @param {number} options.days
 * @returns {Promise<Array>}
 */
export async function fetchVideos({ days = 7 } = {}) {
  const { WebSocket } = await import('ws');
  const wsUrl = await getWSEndpoint();
  if (!wsUrl) throw new Error('Нет открытых вкладок Chrome');

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(reject, 5000);
  });

  const allVideos = [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  try {
    for (const [project, group] of Object.entries(GROUPS)) {
      const videos = await fetchGroupVideos(ws, group, project, cutoff);
      allVideos.push(...videos);
      await new Promise(r => setTimeout(r, 2000)); // Anti-bot
    }
  } finally {
    ws.close();
  }

  return allVideos;
}

async function fetchGroupVideos(ws, group, project, cutoff) {
  // Открыть страницу видео группы VK
  const url = `https://vk.com/${group}?z=video`;
  await sendCDP(ws, 'Page.navigate', { url });
  await new Promise(r => setTimeout(r, 3000)); // Ждем загрузки

  // Извлечь список видео из DOM
  const result = await sendCDP(ws, 'Runtime.evaluate', {
    expression: `
      Array.from(document.querySelectorAll('.video_item')).slice(0, 20).map(el => ({
        id: el.dataset.id,
        title: el.querySelector('.video_desc_title')?.textContent?.trim(),
        views: el.querySelector('.video_views')?.textContent?.trim(),
        date: el.querySelector('.video_date')?.getAttribute('data-time'),
        url: el.querySelector('a')?.href,
      }))
    `,
    returnByValue: true,
  });

  const rawVideos = result?.result?.value ?? [];

  return rawVideos
    .filter(v => {
      const date = v.date ? new Date(v.date * 1000) : null;
      return date && date >= cutoff;
    })
    .map(v => ({
      video_id: `vk-${group}-${v.id}`,
      source: 'vk',
      url: v.url,
      title: v.title,
      published_at: v.date ? new Date(v.date * 1000).toISOString() : null,
      project,
      metrics: {
        views: parseViews(v.views),
        likes: 0,   // требует открытия каждого видео
        shares: 0,
        comments: 0,
        saves: 0,
      },
    }));
}

function parseViews(raw) {
  if (!raw) return 0;
  return parseInt(raw.replace(/[^0-9]/g, '')) || 0;
}
