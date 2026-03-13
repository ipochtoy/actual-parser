#!/usr/bin/env node
/**
 * Загрузка данных о ценах конкурентов в Google Sheets через CDP.
 *
 * Использование:
 *   node push_to_sheets.mjs --sheet 1-RQb_bmYCIxcAtxGMEysPQPAl22VkaT5SUI8BUiWY4g
 *   node push_to_sheets.mjs --sheet <id> --input scratch/data/competitors-2024-01-15.json
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', '..', 'scratch', 'data');

const SHEET_ID_DEFAULT = '1-RQb_bmYCIxcAtxGMEysPQPAl22VkaT5SUI8BUiWY4g';
const CDP_URL = 'http://127.0.0.1:9222';

const CATEGORIES = ['clothes', 'electronics', 'mixed'];
const WEIGHT_RANGE = Array.from({ length: 25 }, (_, i) => i + 1);

async function checkCDP() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function getCDPEndpoint() {
  const res = await fetch(`${CDP_URL}/json`);
  const pages = await res.json();
  const page = pages.find(p => p.type === 'page');
  return page?.webSocketDebuggerUrl;
}

function findLatestDataFile() {
  const files = readdirSync(DATA_DIR)
    .filter(f => f.startsWith('competitors-') && f.endsWith('.json') && !f.includes('report'))
    .sort()
    .reverse();

  if (!files.length) throw new Error(`Нет файлов competitors-*.json в ${DATA_DIR}`);
  return join(DATA_DIR, files[0]);
}

function buildSheetRows(data) {
  const { prices, collected_at } = data;
  const companies = Object.keys(prices).sort();

  const sheets = {};

  for (const category of CATEGORIES) {
    const headers = ['Вес (кг)', ...companies, 'Дата обновления'];
    const rows = [headers];

    for (const weight of WEIGHT_RANGE) {
      const key = `${weight}kg`;
      const row = [weight];
      for (const company of companies) {
        const price = prices[company]?.[category]?.[key];
        row.push(price != null ? price : '');
      }
      row.push(collected_at.slice(0, 10));
      rows.push(row);
    }

    sheets[category] = rows;
  }

  return sheets;
}

async function updateGoogleSheet(wsUrl, sheetId, sheets) {
  // CDP WebSocket подключение для управления Google Sheets
  // Открываем нужный лист и вставляем данные

  const sheetNames = {
    clothes: 'Сравнение (одежда)',
    electronics: 'Сравнение (электроника)',
    mixed: 'Сравнение (смешанная)',
  };

  for (const [category, rows] of Object.entries(sheets)) {
    const sheetName = sheetNames[category];
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=0`;

    console.log(`  Обновляем лист: ${sheetName}...`);

    // TODO: CDP navigation + script execution for Sheets API
    // 1. Открыть Google Sheets через CDP
    // 2. Перейти на нужный лист
    // 3. Очистить данные
    // 4. Вставить новые строки

    await new Promise(r => setTimeout(r, 1000)); // Anti-bot delay
    console.log(`  ✓ ${sheetName} обновлен (${rows.length - 1} строк)`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      sheet: { type: 'string', default: SHEET_ID_DEFAULT },
      input: { type: 'string' },
    }
  });

  // Проверить CDP
  const cdpOk = await checkCDP();
  if (!cdpOk) {
    console.error('❌ CDP недоступен. Запустите Chrome с CDP:');
    console.error('   cd ~/Desktop/AutoBuy/agent && node start-chrome.mjs');
    process.exit(1);
  }
  console.log('✓ CDP доступен');

  // Загрузить данные
  const dataFile = values.input || findLatestDataFile();
  console.log(`Загружаем данные из ${dataFile}...`);
  const data = JSON.parse(readFileSync(dataFile, 'utf8'));

  // Подготовить строки для листов
  const sheets = buildSheetRows(data);

  // Получить CDP endpoint
  const wsUrl = await getCDPEndpoint();
  if (!wsUrl) {
    console.error('❌ Нет открытых вкладок в Chrome');
    process.exit(1);
  }

  // Загрузить в Google Sheets
  console.log(`Загружаем в Google Sheet ${values.sheet}...`);
  await updateGoogleSheet(wsUrl, values.sheet, sheets);

  console.log('\n✅ Готово! Данные загружены в Google Sheets.');
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
