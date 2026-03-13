#!/usr/bin/env node
/**
 * Запрос видеометрик за период.
 *
 * Использование:
 *   node query-period.mjs --from 2024-01-01 --to 2024-01-31
 *   node query-period.mjs --from 2024-01-01 --to 2024-01-31 --source telegram,vk
 *   node query-period.mjs --last 7  # последние 7 дней
 */

import { parseArgs } from 'util';
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'scratch', 'data');

function getDateRange(from, to, last) {
  const end = to ? new Date(to) : new Date();
  let start;

  if (last) {
    start = new Date(end);
    start.setDate(start.getDate() - parseInt(last));
  } else if (from) {
    start = new Date(from);
  } else {
    start = new Date(end);
    start.setDate(start.getDate() - 7);
  }

  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  };
}

function loadLocalData(fromDate, toDate) {
  const files = readdirSync(DATA_DIR)
    .filter(f => f.startsWith('video-metrics-') && f.endsWith('.json'))
    .sort()
    .reverse();

  const allVideos = [];
  for (const file of files) {
    const fileDate = file.replace('video-metrics-', '').replace('.json', '');
    if (fileDate >= fromDate && fileDate <= toDate) {
      const data = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8'));
      if (data.videos) allVideos.push(...data.videos);
    }
  }
  return allVideos;
}

function filterBySource(videos, sources) {
  if (!sources || sources === 'all') return videos;
  const list = sources.split(',').map(s => s.trim());
  return videos.filter(v => list.includes(v.source));
}

function formatReport(videos, from, to) {
  const bySource = {};
  for (const v of videos) {
    if (!bySource[v.source]) bySource[v.source] = [];
    bySource[v.source].push(v);
  }

  let report = `# Видеометрики: ${from} — ${to}\n\n`;
  report += `Всего видео: ${videos.length}\n\n`;

  for (const [source, svids] of Object.entries(bySource)) {
    const totalViews = svids.reduce((s, v) => s + (v.metrics?.views ?? 0), 0);
    const avgER = svids.reduce((s, v) => s + (v.er ?? 0), 0) / svids.length;
    const topVideo = svids.sort((a, b) => (b.metrics?.views ?? 0) - (a.metrics?.views ?? 0))[0];

    report += `## ${source.toUpperCase()}\n\n`;
    report += `- Видео за период: ${svids.length}\n`;
    report += `- Суммарные просмотры: ${totalViews.toLocaleString()}\n`;
    report += `- Средний ER: ${avgER.toFixed(2)}%\n`;
    if (topVideo) {
      report += `- Топ видео: ${topVideo.title ?? topVideo.url} (${topVideo.metrics?.views?.toLocaleString()} просмотров)\n`;
    }
    report += '\n';

    // Таблица топ-5
    report += '| Заголовок | Просмотры | Лайки | ER% |\n';
    report += '|-----------|-----------|-------|-----|\n';
    svids.slice(0, 5).forEach(v => {
      const title = (v.title ?? v.url ?? '').slice(0, 40);
      report += `| ${title} | ${v.metrics?.views ?? 0} | ${v.metrics?.likes ?? 0} | ${v.er ?? 0}% |\n`;
    });
    report += '\n';
  }

  return report;
}

async function main() {
  const { values } = parseArgs({
    options: {
      from:   { type: 'string' },
      to:     { type: 'string' },
      last:   { type: 'string' },
      source: { type: 'string', default: 'all' },
      format: { type: 'string', default: 'markdown' },
    }
  });

  const { from, to } = getDateRange(values.from, values.to, values.last);
  console.log(`Запрос видеометрик: ${from} — ${to}`);

  const videos = loadLocalData(from, to);
  const filtered = filterBySource(videos, values.source);

  if (!filtered.length) {
    console.log('Нет данных за указанный период.');
    console.log('Сначала запустите: node run-sync.mjs --sheet <sheetId>');
    return;
  }

  const report = formatReport(filtered, from, to);
  console.log('\n' + report);
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
