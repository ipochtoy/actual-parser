/**
 * Источник: TikTok
 * Метод: CDP-скрейпинг публичного профиля
 * CDP: ТРЕБУЕТСЯ
 */

const ACCOUNTS = {
  prostobox: '@prostobox.com',
  pochtoy:   '@pochtoy.usa',
};

const CDP_URL = 'http://127.0.0.1:9222';

async function sendCDP(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Date.now() + Math.random();
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
 * Получить видео TikTok-аккаунтов за последние N дней.
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

  try {
    for (const [project, handle] of Object.entries(ACCOUNTS)) {
      const videos = await fetchAccountVideos(ws, handle, project, days);
      allVideos.push(...videos);
      await new Promise(r => setTimeout(r, 3000)); // Anti-bot delay
    }
  } finally {
    ws.close();
  }

  return allVideos;
}

async function fetchAccountVideos(ws, handle, project, days) {
  const url = `https://www.tiktok.com/${handle}`;

  await sendCDP(ws, 'Page.navigate', { url });
  await new Promise(r => setTimeout(r, 5000)); // TikTok SPA загружается долго

  // Попытка получить данные из window.__INIT_PROPS__
  const initPropsResult = await sendCDP(ws, 'Runtime.evaluate', {
    expression: `
      try {
        const data = window.__INIT_PROPS__?.['/']?.userData?.user;
        const videos = window.__INIT_PROPS__?.['/']?.itemList ?? [];
        JSON.stringify({ user: data, videos: videos.slice(0, 30) })
      } catch(e) { 'null' }
    `,
    returnByValue: true,
  });

  let parsed = null;
  try {
    parsed = JSON.parse(initPropsResult?.result?.value);
  } catch {
    // Fallback: DOM-парсинг
  }

  if (parsed?.videos?.length) {
    return parsed.videos.map(v => ({
      video_id: `tiktok-${v.id}`,
      source: 'tiktok',
      url: `https://www.tiktok.com/${handle}/video/${v.id}`,
      title: v.desc ?? '',
      published_at: v.createTime ? new Date(v.createTime * 1000).toISOString() : null,
      project,
      metrics: {
        views:    v.stats?.playCount ?? 0,
        likes:    v.stats?.diggCount ?? 0,
        shares:   v.stats?.shareCount ?? 0,
        comments: v.stats?.commentCount ?? 0,
        saves:    v.stats?.collectCount ?? 0,
      },
    }));
  }

  // Fallback: DOM
  const domResult = await sendCDP(ws, 'Runtime.evaluate', {
    expression: `
      Array.from(document.querySelectorAll('[data-e2e="user-post-item"]')).slice(0, 20).map(el => ({
        href: el.querySelector('a')?.href,
        views: el.querySelector('[data-e2e="video-views"]')?.textContent?.trim(),
      }))
    `,
    returnByValue: true,
  });

  return (domResult?.result?.value ?? []).map(v => ({
    video_id: `tiktok-${v.href?.split('/').pop()}`,
    source: 'tiktok',
    url: v.href,
    title: '',
    published_at: null,
    project,
    metrics: {
      views:    parseViews(v.views),
      likes:    0,
      shares:   0,
      comments: 0,
      saves:    0,
    },
  }));
}

function parseViews(raw) {
  if (!raw) return 0;
  const s = raw.trim();
  if (s.endsWith('K')) return Math.round(parseFloat(s) * 1000);
  if (s.endsWith('M')) return Math.round(parseFloat(s) * 1000000);
  return parseInt(s.replace(/[^0-9]/g, '')) || 0;
}
