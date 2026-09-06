#!/usr/bin/env node
// Pochtoy Parsing — внешний сторож ночного парса.
//
// Живёт ВНЕ Chrome (launchd, каждые 15 мин). Один тик = набор проверок ниже, затем exit.
// Если Chrome закрыт / машина спала / прогон завис / выгрузка в Sheets упала — шлёт
// оператору обычный текстовый Telegram-алерт. Дедуп: один алерт на инцидент (state-файл
// с флагом alerted по каждой проверке), авто-переарм когда условие ушло и вернулось.
//
// Доступ к состоянию расширения — по CDP (127.0.0.1:9222). Находим service-worker-таргет
// парсера (проверяем chrome.runtime.getManifest().name === 'Pochtoy Parsing'), читаем нужные
// ключи chrome.storage.local через Runtime.evaluate. Никаких внешних npm-зависимостей —
// fetch и WebSocket встроены в Node 22+.
//
// Флаг --dry-run: только чтение; без команд, дочерних процессов и записи состояния.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readExtensionInstallation } from './lib/extension-installation.mjs';
import { coordinatorWakeDecision, nightWindow, observeProgress, sheetsReceipt } from './lib/night-policy.mjs';
import { processAlive, wakeCoordinator } from './lib/coordinator-wake.mjs';

// ---------- конфиг ----------
const DRY_RUN = process.argv.includes('--dry-run');
const CDP_PORT = process.env.CDP_PORT || '9222';
const CDP_HOST = '127.0.0.1';

// Telegram credential is local-only. Preferred source is the launchd
// environment; telegram-creds.json is an ignored 0600 fallback.
const TG_CREDS_FILE = new URL('telegram-creds.json', import.meta.url).pathname;
function loadTelegramToken() {
  const fromEnv = String(process.env.PARSER_TELEGRAM_BOT_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const local = JSON.parse(readFileSync(TG_CREDS_FILE, 'utf8'));
    return String(local.tgBotToken || local.telegramBotToken || '').trim();
  } catch {
    return '';
  }
}
const TG_TOKEN = loadTelegramToken();
const TG_CHAT = '-1003888176404';

const PARSER_MANIFEST_NAME = 'Pochtoy Parsing';
const PARSER_EXT_ID = 'hglkogmefkopebgipcnmfmnhflnhajbo';
const CHROME_USER_DATA = process.env.PARSER_CHROME_USER_DATA_DIR
  || join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');

// Пороги (минуты).
const SHEETS_GRACE_MIN = 20;       // после completed столько ждём подтверждения выгрузки

const STATE_FILE = new URL('.watchdog-state.json', import.meta.url).pathname;
const NET_TIMEOUT_MS = 8000;

const now = Date.now();

// ---------- state-файл (дедуп + переарм) ----------
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch (error) { return error.code === 'ENOENT' ? {} : { wakeStateUnreadable: true }; }
}
function saveState(s) {
  if (DRY_RUN) return false;
  try {
    const temp = `${STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(temp, STATE_FILE);
    return true;
  } catch (e) { log('saveState fail', e.message); return false; }
}

function log(...a) { console.log(new Date().toISOString(), ...a); }

// ---------- Telegram ----------
const pendingSends = [];
function sendAlert(text) {
  const p = _sendAlert(text);
  pendingSends.push(p);
  return p;
}
async function drainAlerts() { await Promise.allSettled(pendingSends); }

async function _sendAlert(text) {
  if (DRY_RUN) { console.log('\n[DRY-RUN ALERT] ' + text + '\n'); return; }
  if (!TG_TOKEN) {
    log('telegram send skipped: local token is not configured');
    return;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), NET_TIMEOUT_MS);
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    if (!j.ok) log('telegram not ok:', JSON.stringify(j));
  } catch (e) { log('telegram send fail:', e.message); }
}

// ---------- CDP helpers ----------
async function httpJson(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), NET_TIMEOUT_MS);
  try {
    const r = await fetch(`http://${CDP_HOST}:${CDP_PORT}${path}`, { signal: ctrl.signal });
    return await r.json();
  } finally { clearTimeout(t); }
}

// Открывает ws к таргету, шлёт Runtime.evaluate, ждёт результат. Возвращает распарсенное
// значение (returnByValue) либо кидает при таймауте/ошибке.
function cdpEvaluate(wsUrl, expression, awaitPromise = false) {
  return new Promise((resolve, reject) => {
    let ws;
    const id = 1;
    const timer = setTimeout(() => { try { ws && ws.close(); } catch {} reject(new Error('cdp eval timeout')); }, NET_TIMEOUT_MS);
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) { clearTimeout(timer); return reject(e); }
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise, returnByValue: true }
      }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (msg.error) return reject(new Error(msg.error.message || 'cdp error'));
      const res = msg.result && msg.result.result;
      if (res && res.subtype === 'error') return reject(new Error(res.description || 'eval threw'));
      resolve(res ? res.value : undefined);
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
    ws.addEventListener('close', () => { /* handled elsewhere */ });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Одна попытка: найти SW-таргет парсера в /json и прочитать storage.
// { storage, wsUrl } при успехе | { down:true } если CDP недоступен | {} если SW не найден.
async function tryReadParserStorage(expr) {
  let targets;
  try {
    targets = await httpJson('/json');
  } catch {
    return { down: true };
  }
  const sws = (Array.isArray(targets) ? targets : []).filter(
    t => t.type === 'service_worker' && typeof t.url === 'string' && t.url.startsWith('chrome-extension://') && t.webSocketDebuggerUrl
  );
  for (const sw of sws) {
    let out;
    try { out = await cdpEvaluate(sw.webSocketDebuggerUrl, expr, true); }
    catch { continue; }
    if (out && out.__match) return { storage: out.d || {}, wsUrl: sw.webSocketDebuggerUrl };
  }
  return {};
}

// Ищет SW-таргет парсера и читает нужные ключи storage.
// Возвращает { ok:true, storage, wsUrl } | { ok:false, reason:'cdp_down'|'ext_missing' }.
//
// ВАЖНО (флап-фикс 2026-07-04): MV3 service worker парсера засыпает ~30с из ~60с цикла и
// ПРОПАДАЕТ из /json целиком (browser-level Target.setDiscoverTargets его тоже не видит,
// а ServiceWorker.startWorker для extension-SW в CDP недоступен). Дормантность != «расширение
// не загружено»: alarm в 23:00 сам разбудит SW и парс пойдёт. Раньше сторож, поймав тик на
// спящем SW, слал ложный «не загружено» каждые ~30-60 мин всю ночь (лог 2026-07-04). Теперь
// при промахе РЕТРАИМ до ~75с — SW сам встаёт на ближайшем alarm-тике (замер макс. дормантности
// = 30с). Только стойкое отсутствие (>75с) = реально выгружено/выключено. cdp_down (Chrome
// закрыт) остаётся мгновенным — это отдельное реальное условие, не дормантность SW.
async function readParserStorage() {
  const KEYS = [
    'dailyAutoParseEnabled',
    'lastDailyAutoParseTriggeredAt',
    'lastDailyAutoParseStatus',
    'lastDailyAutoParseFinishedAt',
    'pipelineStage',
    'lastSheetsUploadOkAt', 'lastSheetsUploadRunId', 'pendingSheetsUpload',
    'pipelineRun', 'parsingState', 'progressState', 'amazonPaginationState',
    'multiAccountState', 'multiAccountIherbState', 'iherbParseAttemptId',
    'trackScreenshotQueue', 'iherbStageFinalizing', 'amazonStageFinalizing',
    'pendingIherbSwitch', 'pendingAccountSwitch'
  ];
  const expr =
    `(async()=>{try{if(chrome.runtime.getManifest().name!==${JSON.stringify(PARSER_MANIFEST_NAME)})return {__nomatch:true};` +
    `const d=await chrome.storage.local.get(${JSON.stringify(KEYS)});` +
    `for(const k of ['pendingIherbSwitch','pendingAccountSwitch','iherbStageFinalizing','amazonStageFinalizing'])d[k]=!!d[k];` +
    `d.multiAccountState={currentAmazonAccount:d.multiAccountState?.currentAmazonAccount};` +
    `d.multiAccountIherbState={currentIherbAccount:d.multiAccountIherbState?.currentIherbAccount};` +
    `return {__match:true,d};}catch(e){return {__err:String(e)};}})()`;

  const DORMANT_RETRY_MS = 75000, STEP_MS = 8000;
  const deadline = Date.now() + DORMANT_RETRY_MS;
  for (let attempt = 1; ; attempt++) {
    const r = await tryReadParserStorage(expr);
    if (r.storage) return { ok: true, storage: r.storage, wsUrl: r.wsUrl };
    if (r.down) return { ok: false, reason: 'cdp_down' };   // Chrome закрыт — реальное условие, не ждём
    if (Date.now() >= deadline) break;
    log(`readParserStorage: SW парсера не виден (спит?), попытка ${attempt}, жду ${STEP_MS / 1000}s и пробую снова…`);
    await sleep(STEP_MS);
  }
  // Не открываем popup/chrome:// и не создаём вкладку: внешний сторож не имеет
  // tab claim и не должен касаться общего браузера. После исчерпания обычных
  // MV3-ретраев читаем только Chrome Preferences. Нечитаемый/неоднозначный файл
  // остаётся ext_missing (ночной fail-closed), а точное отсутствие — отдельная
  // круглосуточная тревога.
  const configured = readExtensionInstallation({
    userDataRoot: CHROME_USER_DATA, extensionId: PARSER_EXT_ID,
    manifestName: PARSER_MANIFEST_NAME,
    expectedPath: process.env.PARSER_EXTENSION_PATH || join(homedir(), 'Desktop', 'order-parser-pro'),
  });
  return { ok: false, reason: configured.state === 'missing' ? 'ext_not_installed' : 'ext_missing' };
}

// ---------- обработка одной проверки: дедуп + переарм ----------
function handleCheck(state, key, firing, text) {
  const prev = state[key] || { alerted: false };
  if (firing) {
    if (!prev.alerted) {
      log(`CHECK ${key}: FIRING → alert`);
      sendAlert(text); // fire-and-forget ок: process ждёт микротаски через await в main
      state[key] = { alerted: true, since: now };
      return text;
    }
    log(`CHECK ${key}: still firing (already alerted, silent)`);
    state[key] = { alerted: true, since: prev.since || now };
  } else {
    if (prev.alerted) log(`CHECK ${key}: cleared → re-arm`);
    state[key] = { alerted: false };
  }
  return null;
}

// ---------- main ----------
async function main() {
  const HANG_GUARD = setTimeout(() => {
    log('WATCHDOG: тик завис >120с, выхожу для рестарта launchd');
    process.exit(1);
  }, 120000);
  if (typeof HANG_GUARD.unref === 'function') HANG_GUARD.unref();

  const state = loadState();
  const window = nightWindow(now);
  const slot = window.slot;
  const slotStr = new Date(slot).toLocaleString('ru-RU');
  const alerts = [];

  const res = await readParserStorage();

  // --- Проверка 1: доступ к Chrome / расширению ---
  if (!res.ok) {
    // То же ночное окно, что у координатора: после 23:15 и до 06:30.
    // Только в это окно недоступность SW = реальная проблема (будильник 23:00
    // ДОЛЖЕН был разбудить спящий service worker, а он не отвечает).
    const inNightWindow = window.active;

    if (res.reason === 'cdp_down') {
      // Chrome реально закрыт — без него будильник 23:00 не сработает. Уведомляем
      // (handleCheck дедупит: одно сообщение, не спам). Автопочинка невозможна.
      const a = handleCheck(state, 'chrome', true,
        '❗ Сторож парсера: Chrome закрыт — ночной парс в 23:00 не сможет запуститься. Нужен оператор.');
      if (a) alerts.push(a);
    } else if (res.reason === 'ext_not_installed') {
      const a = handleCheck(state, 'chrome', true,
        '❗ Сторож парсера: расширение «Pochtoy Parsing» не установлено или выключено в Chrome — ночной парс не запустится. Нужен оператор.');
      if (a) alerts.push(a);
    } else {
      // ext_missing: почти всегда просто СПЯЩИЙ service worker (MV3 выгружает его
      // через ~30с простоя), а НЕ «расширение удалено» — по CDP их не отличить, и
      // разбудить принудительно нельзя. Днём это ЛОЖНАЯ тревога (та, на которую
      // жаловался оператор) → молчим. Тревожим только в ночном окне, когда прогон
      // реально должен был идти.
      if (inNightWindow) {
        const a = handleCheck(state, 'chrome', true,
          '❗ Сторож парсера: расширение «Pochtoy Parsing» не отвечает в ночном окне — прогон в 23:00 мог не запуститься. Нужен оператор.');
        if (a) alerts.push(a);
      } else {
        // Дневная дремота SW — не тревога. Переарм, чтобы не тащить старое состояние.
        handleCheck(state, 'chrome', false);
        log('storage unreadable (ext_missing) вне ночного окна — молчим (спящий SW, не тревога)');
      }
    }
    // Проверки 2-4 требуют storage — при недоступности их не оцениваем (state не трогаем).
    saveState(state);
    await drainAlerts();
    log('done (no storage):', res.reason, '| alerts:', alerts.length);
    return;
  }
  handleCheck(state, 'chrome', false); // Chrome вернулся → переарм

  const s = res.storage || {};
  const enabled = s.dailyAutoParseEnabled !== false;
  const triggeredAt = Number(s.lastDailyAutoParseTriggeredAt) || 0;
  const status = s.lastDailyAutoParseStatus || null;
  const finishedAt = Number(s.lastDailyAutoParseFinishedAt) || 0;
  const sheetsOkAt = Number(s.lastSheetsUploadOkAt) || 0;
  const pipe = s.pipelineStage || null;

  // --- Проверка 2: пропущенный старт будит общего владельца ночи ---
  // Голый start_pipeline обходит договор с координатором и бесконечно получает
  // defer. Только штатный CLI решает, кому сейчас можно взять общий браузер.
  const wake = coordinatorWakeDecision(s, state.coordinatorWake, now, {
    childAlive: processAlive(state.coordinatorWake?.pid),
  });
  if (wake.wake && !state.wakeStateUnreadable) {
    if (DRY_RUN) {
      log('[DRY-RUN] would wake existing night coordinator');
    } else {
      state.coordinatorWake = wake.attempt;
      if (!saveState(state)) throw new Error('cannot persist coordinator wake budget');
      const result = await wakeCoordinator({
        dryRun: DRY_RUN,
        repo: process.env.AUTOBUY_REPO || join(homedir(), 'Desktop', 'AutoBuy'),
      });
      state.coordinatorWake = { ...wake.attempt, pid: result.pid || null, result: result.reason || 'spawned' };
      saveState(state);
      log('coordinator wake:', result.started ? `pid=${result.pid}` : result.reason);
    }
  }
  const missed = enabled && status !== 'disabled' && triggeredAt < slot && window.active;
  const notStartedAlert = handleCheck(state, 'not_started', missed,
    '⚠️ Ночной Parser Pro ещё не стартовал. Запуском распоряжается общий координатор ночи; прямой второй обход не запускаю.');
  if (notStartedAlert) alerts.push(notStartedAlert);
  if (missed) log('not started:', wake.reason);

  // --- Проверка 3: длительность стадии не доказывает зависание ---
  const progress = observeProgress(s, state.progressObservation, now);
  state.progressObservation = progress.observation;
  const hungAlert = handleCheck(state, 'hung', progress.hung,
    `⚠️ У Parser Pro стадия «${progress.stage}»: ${progress.idleMinutes} мин не меняются страницы, счётчики и очередь снимков. Нужна проверка; прогон не перезапускаю.`);
  if (hungAlert) alerts.push(hungAlert);

  // --- Проверка 4: подтверждение относится к конкретному прогону ---
  const receipt = sheetsReceipt(s, slot);
  const sheetsFailing = receipt.completed && !receipt.confirmed
    && now - receipt.finishedAt > SHEETS_GRACE_MIN * 60000;
  const sheetsAlert = handleCheck(state, 'sheets', sheetsFailing,
    '⚠️ Parser Pro закончил разбор, но выгрузка именно этого прогона в Google Sheets не подтверждена. Успешной ночь пока не считается.');
  if (sheetsAlert) alerts.push(sheetsAlert);
  // The extension owns its durable upload retry. A legacy unscoped reupload
  // command could reset another run's retry budget; the external reader sends none.

  saveState(state);
  await drainAlerts();

  // Итоговый статус в лог (для /tmp/parser-watchdog.log).
  const statusLine = [
    `slot=${slotStr}`,
    `enabled=${enabled}`,
    `lastRun=${triggeredAt ? new Date(triggeredAt).toLocaleString('ru-RU') : '—'}`,
    `status=${status || '—'}`,
    `finished=${finishedAt ? new Date(finishedAt).toLocaleString('ru-RU') : '—'}`,
    `sheetsOk=${sheetsOkAt ? new Date(sheetsOkAt).toLocaleString('ru-RU') : '—'}`,
    `sheetsRun=${s.lastSheetsUploadRunId || '—'}`,
    `sheetsConfirmedForRun=${receipt.confirmed}`,
    `pipeline=${pipe && pipe.active ? (pipe.stageName || pipe.stages?.[pipe.currentIndex] || '?') + ' active' : 'idle'}`,
    `alerts=${alerts.length}`
  ].join(' | ');
  log('STATUS:', statusLine);
  if (DRY_RUN && alerts.length === 0) console.log('[DRY-RUN] всё ок — алертов нет');
}

main().catch(e => { log('FATAL:', e.message); process.exit(1); });
