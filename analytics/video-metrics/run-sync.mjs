#!/usr/bin/env node
/**
 * Синхронизация видеометрик из всех источников в Google Sheet.
 *
 * Использование:
 *   node run-sync.mjs --sheet <sheetId>
 *   node run-sync.mjs --sheet <sheetId> --source telegram,vk
 *   node run-sync.mjs --sheet <sheetId> --days 7  # последние 7 дней
 */

import { parseArgs } from 'util';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Динамический импорт источников
const SOURCES = {
  telegram: () => import('./sources/telegram.mjs'),
  vk:       () => import('./sources/vk.mjs'),
  dzen:     () => import('./sources/dzen.mjs'),
  tiktok:   () => import('./sources/tiktok.mjs'),
};

// CDP-требования
const CDP_REQUIRED = ['vk', 'tiktok'];

const CDP_URL = 'http://127.0.0.1:9222';

async function checkCDP() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

function calculateER(metrics) {
  const { views = 0, likes = 0, shares = 0, comments = 0, saves = 0 } = metrics;
  if (!views) return 0;
  return +((likes + shares + comments + saves) / views * 100).toFixed(2);
}

async function syncSource(sourceName, days) {
  const sourceModule = await SOURCES[sourceName]();
  const videos = await sourceModule.fetchVideos({ days });

  return videos.map(video => ({
    ...video,
    er: calculateER(video.metrics),
    source: sourceName,
    collected_at: new Date().toISOString(),
  }));
}

async function pushToSheet(sheetId, allVideos, wsUrl) {
  // Формируем строки для Google Sheet
  const headers = [
    'Дата публикации', 'Источник', 'URL', 'Заголовок',
    'Просмотры', 'Лайки', 'Репосты', 'Комментарии', 'Сохранения',
    'ER (%)', 'Дата сбора'
  ];

  const rows = allVideos.map(v => [
    v.published_at?.slice(0, 10) ?? '',
    v.source,
    v.url,
    v.title ?? '',
    v.metrics?.views ?? 0,
    v.metrics?.likes ?? 0,
    v.metrics?.shares ?? 0,
    v.metrics?.comments ?? 0,
    v.metrics?.saves ?? 0,
    v.er,
    v.collected_at.slice(0, 10),
  ]);

  console.log(`  Подготовлено ${rows.length} строк для загрузки`);

  // TODO: CDP-загрузка в Google Sheets
  // 1. Открыть Sheets через CDP
  // 2. Перейти на лист "Видеометрики"
  // 3. Найти первую пустую строку
  // 4. Вставить данные

  const outputFile = join(__dirname, '..', '..', 'scratch', 'data',
    `video-metrics-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outputFile, JSON.stringify({ headers, rows, videos: allVideos }, null, 2));
  console.log(`  ✓ Данные сохранены локально: ${outputFile}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      sheet:  { type: 'string' },
      source: { type: 'string', default: 'telegram,vk,dzen,tiktok' },
      days:   { type: 'string', default: '7' },
    }
  });

  if (!values.sheet) {
    console.error('❌ Укажите --sheet <sheetId>');
    process.exit(1);
  }

  const sources = values.source.split(',').map(s => s.trim());
  const days = parseInt(values.days);

  console.log(`Синхронизация видеометрик | источники: ${sources.join(', ')} | период: ${days} дней`);

  // Проверить CDP для нужных источников
  const needsCDP = sources.some(s => CDP_REQUIRED.includes(s));
  if (needsCDP) {
    const cdpOk = await checkCDP();
    if (!cdpOk) {
      console.error('\n❌ CDP недоступен (нужен для VK, TikTok)');
      console.error('Запустите Chrome: cd ~/Desktop/AutoBuy/agent && node start-chrome.mjs');
      process.exit(1);
    }
    console.log('✓ CDP доступен');
  }

  // Собрать данные из всех источников
  const allVideos = [];
  for (const source of sources) {
    if (!SOURCES[source]) {
      console.warn(`⚠️ Неизвестный источник: ${source}`);
      continue;
    }
    try {
      console.log(`\nСобираем ${source}...`);
      const videos = await syncSource(source, days);
      allVideos.push(...videos);
      console.log(`  ✓ ${videos.length} видео`);
    } catch (err) {
      console.error(`  ✗ ${source}: ${err.message}`);
    }
  }

  if (!allVideos.length) {
    console.log('\nНет данных для загрузки.');
    return;
  }

  // Загрузить в Google Sheets
  console.log(`\nЗагружаем ${allVideos.length} видео в Google Sheets...`);
  await pushToSheet(values.sheet, allVideos, null);

  console.log('\n✅ Синхронизация завершена!');
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
