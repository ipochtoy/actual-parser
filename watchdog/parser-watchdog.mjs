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
// Флаг --dry-run: всё проверяет, но алерты печатает в stdout вместо отправки в Telegram.

import { readFileSync, writeFileSync } from 'node:fs';

// ---------- конфиг ----------
const DRY_RUN = process.argv.includes('--dry-run');
const CDP_PORT = process.env.CDP_PORT || '9222';
const CDP_HOST = '127.0.0.1';

// Telegram — те же значения, что в парсере (background.js ~614/617).
const TG_TOKEN = '8274480416:AAEIvhNsqzDl-dYHMOpjTJ0b1XyS_0lW88w';
const TG_CHAT = '-1003888176404';

const PARSER_MANIFEST_NAME = 'Pochtoy Parsing';

// Пороги (минуты).
const NOT_STARTED_GRACE_MIN = 15;  // сколько ждать после слота, прежде чем считать «не запустился»
const HUNG_STAGE_MIN = 30;         // стадия висит дольше этого → завис
const SHEETS_GRACE_MIN = 20;       // после completed столько ждём подтверждения выгрузки

const STATE_FILE = new URL('.watchdog-state.json', import.meta.url).pathname;
const NET_TIMEOUT_MS = 8000;

const now = Date.now();

// ---------- state-файл (дедуп + переарм) ----------
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { log('saveState fail', e.message); }
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
    'lastSheetsUploadOkAt'
  ];
  const expr =
    `(async()=>{try{if(chrome.runtime.getManifest().name!==${JSON.stringify(PARSER_MANIFEST_NAME)})return {__nomatch:true};` +
    `const d=await chrome.storage.local.get(${JSON.stringify(KEYS)});return {__match:true,d};}catch(e){return {__err:String(e)};}})()`;

  const DORMANT_RETRY_MS = 75000, STEP_MS = 8000;
  const deadline = Date.now() + DORMANT_RETRY_MS;
  for (let attempt = 1; ; attempt++) {
    const r = await tryReadParserStorage(expr);
    if (r.storage) return { ok: true, storage: r.storage, wsUrl: r.wsUrl };
    if (r.down) return { ok: false, reason: 'cdp_down' };   // Chrome закрыт — реальное условие, не ждём
    if (Date.now() >= deadline) return { ok: false, reason: 'ext_missing' };
    log(`readParserStorage: SW парсера не виден (спит?), попытка ${attempt}, жду ${STEP_MS / 1000}s и пробую снова…`);
    await sleep(STEP_MS);
  }
}

// ---------- команда расширению (автопочинка, инцидент 2026-07-03) ----------
// Пишет externalControlRequest в chrome.storage.local SW-таргета через ТОТ ЖЕ CDP-eval,
// что и readParserStorage. SW читает ключ в своём alarm-тике и сам решает, безопасно ли
// исполнять команду (для start_pipeline — guard от двойного запуска на своей стороне).
// action: 'reupload_sheets' | 'start_pipeline'. Возвращает true/false по успеху eval.
async function sendControlToSW(wsUrl, action) {
  if (!wsUrl) { log(`sendControlToSW(${action}): нет wsUrl SW-таргета`); return false; }
  const expr =
    `chrome.storage.local.set({ externalControlRequest: { action: ${JSON.stringify(action)}, ` +
    `requestedAt: Date.now(), source: 'watchdog' } }).then(()=>true).catch(()=>false)`;
  try {
    const ok = await cdpEvaluate(wsUrl, expr, true);
    log(`→ отправил SW команду ${action}`);
    return ok !== false;
  } catch (e) {
    log(`sendControlToSW(${action}) fail:`, e.message);
    return false;
  }
}

// ---------- слот ----------
// Ожидаемый слот: сегодня 23:00, если сейчас >= 23:05; иначе вчера 23:00.
function expectedSlot(d = new Date()) {
  const slot = new Date(d); slot.setHours(23, 0, 0, 0);
  const slotPlus5 = new Date(slot); slotPlus5.setMinutes(5);
  if (d < slotPlus5) slot.setDate(slot.getDate() - 1);
  return slot.getTime();
}

function fmtMin(ms) { return Math.round(ms / 60000); }

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
  const slot = expectedSlot(new Date());
  const slotStr = new Date(slot).toLocaleString('ru-RU');
  const alerts = [];

  const res = await readParserStorage();

  // --- Проверка 1: доступ к Chrome / расширению ---
  if (!res.ok) {
    // Автопочинка (инцидент 2026-07-03): поднять закрытый Chrome из короткоживущего тика
    // ненадёжно — сторож тут только уведомляет, чинит оператор / «ночной Федя».
    const chromeText = res.reason === 'cdp_down'
      ? '❗ Сторож парсера: Chrome закрыт — ночной парс в 23:00 не сможет запуститься. (автопочинка невозможна — Chrome закрыт)'
      : '❗ Сторож парсера: расширение «Pochtoy Parsing» не загружено в Chrome — ночной парс в 23:00 не запустится. (автопочинка невозможна — расширение не загружено)';
    const a = handleCheck(state, 'chrome', true, chromeText);
    if (a) alerts.push(a);
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

  // --- Проверка 2: прогон не стартовал для ожидаемого слота ---
  // Стартовал, если время последнего запуска >= слота. Не стартовал → триггер < слота
  // (или запуска не было вовсе) И прошло больше грейса после слота.
  const pastSlotMin = fmtMin(now - slot);
  const notStarted = enabled
    && status !== 'disabled'
    && triggeredAt < slot
    && pastSlotMin > NOT_STARTED_GRACE_MIN;
  {
    // Автопочинка (инцидент 2026-07-03): мягкий автозапуск прогона.
    // Пинаем расширение start_pipeline только если оно доступно (res.ok здесь уже true)
    // И pipeline не активен — иначе прогон, возможно, уже стартует, а SW сам себя защитит.
    const pipeActive = !!(pipe && pipe.active === true);
    const canAutoStart = notStarted && !pipeActive;
    const healPrev = state.notStartedHeal || { attempts: 0, escalated: false };
    if (notStarted) {
      const nowStr = new Date(now).toLocaleTimeString('ru-RU');
      const text = `⚠️ Ночной парс не стартовал к ${nowStr} — прошу расширение запустить прогон.`;
      let attempts = healPrev.attempts;
      if (canAutoStart) {
        const sent = await sendControlToSW(res.wsUrl, 'start_pipeline');
        attempts = healPrev.attempts + (sent ? 1 : 0);
      }
      state.notStartedHeal = { attempts, escalated: healPrev.escalated };

      const a = handleCheck(state, 'not_started', true, text);
      if (a) alerts.push(a);

      // Эскалация: после 2 попыток (~30 мин) прогон так и не стартовал → нужен оператор.
      const HEAL_MAX_START = 2;
      if (attempts >= HEAL_MAX_START && !healPrev.escalated) {
        const esc = '❗ Прогон не удалось запустить автоматически, нужен оператор.';
        sendAlert(esc);
        alerts.push(esc);
        state.notStartedHeal = { attempts, escalated: true };
        log('CHECK not_started: escalated (auto-start did not help)');
      }
    } else {
      // Условие ушло → сброс счётчика автопочинки + переарм алерта.
      if (healPrev.attempts || healPrev.escalated) log('CHECK not_started: cleared → reset heal counter');
      state.notStartedHeal = { attempts: 0, escalated: false };
      handleCheck(state, 'not_started', false, '');
    }
  }

  // --- Проверка 3: прогон завис на стадии ---
  let hung = false, hangText = '';
  if (pipe && pipe.active === true) {
    const stageStart = Number(pipe.stageStartedAt) || Number(pipe.startedAt) || 0;
    const stageMin = stageStart ? fmtMin(now - stageStart) : 0;
    const stageName = pipe.stageName
      || (Array.isArray(pipe.stages) ? pipe.stages[pipe.currentIndex] : null)
      || 'неизвестная';
    if (stageStart && stageMin > HUNG_STAGE_MIN) {
      hung = true;
      hangText = `❗ Ночной парс завис: стадия «${stageName}» висит уже ${stageMin} мин (порог ${HUNG_STAGE_MIN}). Прогон не двигается.`;
    }
  }
  {
    const a = handleCheck(state, 'hung', hung, hangText);
    if (a) alerts.push(a);
  }

  // --- Проверка 4: прогон прошёл, но выгрузка в Sheets не подтверждена ---
  // Прогон за слот завершён (completed + finishedAt после слота), прошло больше грейса,
  // а подтверждения выгрузки нет либо оно старше слота.
  const completedForSlot = status === 'completed' && finishedAt >= slot;
  const afterFinishMin = finishedAt ? fmtMin(now - finishedAt) : 0;
  const sheetsConfirmed = sheetsOkAt >= slot;
  const sheetsFailing = completedForSlot
    && afterFinishMin > SHEETS_GRACE_MIN
    && !sheetsConfirmed;
  {
    // Ключа нет вообще → прогон шёл на старой версии расширения, которая ещё не
    // умела подтверждать выгрузку. Это не сбой — молчим, ждём первого нового прогона.
    const legacy = !('lastSheetsUploadOkAt' in s);
    const firing = sheetsFailing && !legacy;

    // Автопочинка (инцидент 2026-07-03): не только алерт, но и команда расширению
    // перезалить уже персистнутый payload (reupload_sheets — идемпотентно).
    const healPrev = state.sheetsHeal || { attempts: 0, escalated: false };
    if (firing) {
      // Раз в тик (launchd = 15 мин) пинаем расширение перезалить выгрузку.
      const sent = await sendControlToSW(res.wsUrl, 'reupload_sheets');
      const attempts = healPrev.attempts + (sent ? 1 : 0);
      state.sheetsHeal = { attempts, escalated: healPrev.escalated };

      // Основной алерт про автопочинку — один раз на инцидент (дедуп через handleCheck).
      const a = handleCheck(state, 'sheets', true,
        '⚠️ Ночной парс прошёл, но выгрузка в Google Sheets не подтвердилась — прошу расширение перезалить (попытка автопочинки).');
      if (a) alerts.push(a);

      // Эскалация: после 3 попыток (~45 мин) всё ещё не залито → нужен оператор.
      const HEAL_MAX_SHEETS = 3;
      if (attempts >= HEAL_MAX_SHEETS && !healPrev.escalated) {
        const esc = '❗ Автопочинка выгрузки не помогла за 45 мин, нужен оператор.';
        sendAlert(esc);
        alerts.push(esc);
        state.sheetsHeal = { attempts, escalated: true };
        log('CHECK sheets: escalated (heal did not help)');
      }
    } else {
      // Выгрузка догнала слот (или прогона за слот нет) → сброс счётчика + переарм алерта.
      if (healPrev.attempts || healPrev.escalated) log('CHECK sheets: cleared → reset heal counter');
      state.sheetsHeal = { attempts: 0, escalated: false };
      handleCheck(state, 'sheets', false, '');
    }
  }

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
    `pipeline=${pipe && pipe.active ? (pipe.stageName || pipe.stages?.[pipe.currentIndex] || '?') + ' active' : 'idle'}`,
    `alerts=${alerts.length}`
  ].join(' | ');
  log('STATUS:', statusLine);
  if (DRY_RUN && alerts.length === 0) console.log('[DRY-RUN] всё ок — алертов нет');
}

main().catch(e => { log('FATAL:', e.message); process.exit(1); });
