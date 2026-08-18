// content-iherb-login.js
// Автологин на iHerb для multi-account парсинга.
// Активен на:
//   - https://checkout.iherb.com/auth/ui/account/login* (новая 2-step форма)
//   - https://secure.iherb.com/account/sign-in*         (legacy single-form)
//   - https://secure.iherb.com/account/logoff*          (redirect shim)
//
// Phase 1 findings (2026-04-16):
//   - iHerb перешёл на 2-step форму: #username-input → Continue → #password-input → Sign In
//   - LastPass autofill подставляет email и/или password. Оба поля надо ЧИСТИТЬ
//     перед typeKeys, иначе значения конкатенируются и форма валится в Invalid.
//     Последовательность clear: triple-click + select-all (Ctrl/Cmd+A) + Delete + Backspace.
//   - Continue btn: #auth-continue-button; Sign In btn: #auth-sign-in-button.
//   - После успеха OAuth callback → www.iherb.com/?correlationId=<uuid>.
//
// После успешного логина:
//   - если iherbFinalReturn — редиректит на www.iherb.com (без парса), чистит флаги
//   - иначе ставит iherbSwitchInProgress=true и редиректит на /myaccount/orders

console.log('🔐 [iHerb Login] script loaded on:', window.location.href);

const IS_LOGOFF    = /\/account\/logoff/i.test(location.href);
const IS_NEW_LOGIN = /\/auth\/ui\/account\/login/i.test(location.href);        // checkout.iherb.com (2-step)
const IS_OLD_LOGIN = /\/account\/sign-in/i.test(location.href);                // secure.iherb.com (legacy)
const IS_LOGIN     = IS_NEW_LOGIN || IS_OLD_LOGIN;
let iherbSwitchRunId = null;

function normalizeIherbEmail(value) {
  return String(value || '').trim().toLowerCase();
}

async function readFreshIherbLoginIntent(expected) {
  const [ownership, data] = await Promise.all([
    sendMessageAsync({ action: 'getParserContext', store: 'iherb', purpose: 'login' }).catch(() => null),
    chrome.storage.local.get(['pendingIherbSwitch', 'iherbFinalReturn'])
  ]);
  const pending = data.pendingIherbSwitch;
  const matches = !!ownership?.owned
    && ownership.runId === expected.runId
    && ownership.tabId === expected.tabId
    && normalizeIherbEmail(ownership.account) === normalizeIherbEmail(expected.email)
    && pending?.runId === expected.runId
    && normalizeIherbEmail(pending?.email) === normalizeIherbEmail(expected.email)
    && !!data.iherbFinalReturn === expected.finalReturn;
  return matches ? { ownership, pending, finalReturn: !!data.iherbFinalReturn } : null;
}

async function assertFreshIherbLoginIntent(expected) {
  const fresh = await readFreshIherbLoginIntent(expected);
  if (!fresh) throw new Error('stale_iherb_login_intent');
  return fresh;
}

async function markIherbFinalReturnLoginSubmitted(expected) {
  if (!expected?.finalReturn) return true;
  const response = await sendMessageAsync({ action: 'markIherbFinalReturnLoginSubmitted' });
  if (!response?.accepted) {
    throw new Error(`final_return_login_submit_rejected:${response?.reason || 'unknown'}`);
  }
  return true;
}

(async function main() {
  // Внешний email captured для catch блока: чтобы при любом неожиданном
  // throw'е после данной точки мы могли позвать sendFailed → background
  // обработает через handleIherbSwitchFailure (retry / skip / finalReturn).
  // Без этого фолбэка cs script мог уронить любой await (Extension context
  // invalidated, network error в storage.get, race на location.href) и
  // оставить iherbSwitchInProgress=true навсегда. Watchdog (Fix 3b) подхватит
  // через 5 мин, но sendFailed чище — moves on to next account сразу.
  let emailForFailure = null;
  try {
  if (IS_LOGOFF) {
    // iHerb после /account/logoff сам редиректит на home. Фолбэк на sign-in если застряли.
    console.log('🔐 [iHerb Login] logoff page — waiting for redirect');
    const logoffData = await chrome.storage.local.get(['pendingIherbSwitch', 'iherbFinalReturn']);
    const logoffOwnership = await sendMessageAsync({ action: 'getParserContext', store: 'iherb', purpose: 'login' })
      .catch(() => null);
    if (!logoffData.pendingIherbSwitch || !logoffOwnership?.owned) return;
    const logoffIntent = {
      runId: logoffOwnership.runId,
      tabId: logoffOwnership.tabId,
      email: logoffData.pendingIherbSwitch.email,
      finalReturn: !!logoffData.iherbFinalReturn
    };
    setTimeout(async () => {
      if (/\/account\/logoff/i.test(location.href)
          && await readFreshIherbLoginIntent(logoffIntent)) {
        console.log('🔐 [iHerb Login] stuck on logoff — forcing www.iherb.com');
        location.href = 'https://www.iherb.com/';
      }
    }, 5000);
    return;
  }

  if (!IS_LOGIN) {
    console.log('🔐 [iHerb Login] not a login page, skipping');
    return;
  }

  // Ждём рендер формы
  await sleep(1200);

  const data = await chrome.storage.local.get([
    'pendingIherbSwitch', 'iherbFinalReturn', 'iherbSignInRetries'
  ]);
  if (!data.pendingIherbSwitch) {
    console.log('🔐 [iHerb Login] no pendingIherbSwitch — manual login mode');
    return;
  }

  const { email, password, runId } = data.pendingIherbSwitch;
  if (!email || !password) {
    console.warn('🔐 [iHerb Login] pendingIherbSwitch missing email/password');
    return;
  }
  emailForFailure = email;
  iherbSwitchRunId = runId || null;

  const ownership = await sendMessageAsync({ action: 'getParserContext', store: 'iherb', purpose: 'login' })
    .catch(() => null);
  if (!ownership?.owned
      || ownership.runId !== runId
      || String(ownership.account || '').trim().toLowerCase()
        !== String(email || '').trim().toLowerCase()) {
    console.warn('🔐 [iHerb Login] stale or foreign login tab — leaving it untouched');
    return;
  }
  const expectedIntent = {
    runId,
    tabId: ownership.tabId,
    email,
    finalReturn: !!data.iherbFinalReturn
  };

  console.log(`🔐 [iHerb Login] auto-login as ${email} (finalReturn=${!!data.iherbFinalReturn}, layout=${IS_NEW_LOGIN ? '2step' : 'legacy'})`);

  // Детект error-page (cloudflare / 503 / temporarily unavailable)
  if (isErrorPage()) {
    const retries = (data.iherbSignInRetries || 0) + 1;
    const MAX = 3;
    if (retries <= MAX) {
      const wait = retries === 1 ? 5000 : retries === 2 ? 15000 : 30000;
      console.warn(`🔐 [iHerb Login] error page (try ${retries}/${MAX}) — reload in ${wait}ms`);
      await assertFreshIherbLoginIntent(expectedIntent);
      await chrome.storage.local.set({ iherbSignInRetries: retries });
      await sleep(wait);
      await assertFreshIherbLoginIntent(expectedIntent);
      location.reload();
      return;
    } else {
      console.error('🔐 [iHerb Login] error page persists after retries');
      sendFailed(email, 'sign_in_page_error_after_retries');
      return;
    }
  }

  try {
    if (IS_NEW_LOGIN) {
      await runTwoStepLogin(email, password, expectedIntent);
    } else {
      await runLegacyLogin(email, password, expectedIntent);
    }
  } catch (e) {
    console.error('🔐 [iHerb Login] fatal during login flow:', e);
    sendFailed(email, e?.message || 'unknown');
    return;
  }

  // Ждём редирект с login URL (до 12с)
  let waited = 0;
  while (waited < 12000) {
    await sleep(1000);
    waited += 1000;
    if (!/\/account\/(sign-in|login)/i.test(location.href)) {
      console.log('🔐 [iHerb Login] redirected to:', location.href);
      break;
    }
  }

  // CAPTCHA check — только ВИДИМАЯ активная captcha.
  // iHerb постоянно держит на странице невидимый reCAPTCHA (badge/anchor iframe +
  // скрытый g-recaptcha-response textarea) для antifraud-скоринга. Старый селектор
  // `iframe[src*=recaptcha], [class*=captcha]` ловил этот фон и слал ложный
  // 'captcha' → аккаунт мгновенно скипался. Теперь детектим только реальный
  // челлендж (см. detectActiveCaptcha).
  if (/\/account\/(sign-in|login)/i.test(location.href)) {
    const cap = detectActiveCaptcha();
    if (cap.active) {
      console.warn(`🔐 [iHerb Login] active CAPTCHA detected (${cap.type})`);
      // Пытаемся решить через 2captcha (reCAPTCHA с известным sitekey).
      const solved = await trySolveCaptcha(cap, expectedIntent);
      if (solved) {
        console.log('🔐 [iHerb Login] CAPTCHA solved via 2captcha, continuing');
        // упали в нормальный flow ниже (redirect уже случился внутри trySolveCaptcha)
      } else {
        console.warn('🔐 [iHerb Login] CAPTCHA unsolved — skip account');
        sendFailed(email, 'captcha');
        return;
      }
    }
  }

  // Всё ещё на login-странице после 12с и без captcha — редиректа не было,
  // значит логин НЕ прошёл (неверный пароль / inline-ошибка / verify-модалка на
  // том же URL). Раньше это считалось успехом → переход на orders → выброс на
  // свежий login → 5 минут пустого ожидания watchdog'а. Фейлимся сразу и несём
  // текст ошибки со страницы для диагностики.
  if (/\/account\/(sign-in|login)/i.test(location.href)) {
    const errText = Array.from(document.querySelectorAll(
      '[role="alert"], [class*="error" i], [class*="alert" i], [id*="error" i]'
    )).map(el => (el.textContent || '').trim()).filter(t => t && t.length < 200).join(' | ').slice(0, 300);
    console.warn('🔐 [iHerb Login] no redirect after Sign In — login failed.', errText || '(no visible error text)');
    sendFailed(email, 'no_redirect_after_signin' + (errText ? ': ' + errText : ''));
    return;
  }

  const completionIntent = await readFreshIherbLoginIntent(expectedIntent);
  if (!completionIntent) {
    console.log('⏭ [iHerb Login] intent changed before landing mutation');
    return;
  }
  if (completionIntent.finalReturn) {
    console.log('🏁 [iHerb Login] final return done, going to home');
    await chrome.storage.local.set({
      iherbFinalReturnConfirmed: {
        runId,
        account: email,
        tabId: expectedIntent.tabId,
        confirmedAt: Date.now()
      }
    });
    if (!await readFreshIherbLoginIntent(expectedIntent)) return;
    location.href = 'https://www.iherb.com/';
    return;
  }

  // Keep the run-scoped pending intent until the background consumes or
  // overwrites it. A content-script remove could otherwise delete a newer run.
  if (!await readFreshIherbLoginIntent(expectedIntent)) return;
  console.log('🔐 [iHerb Login] → /myaccount/orders for parse');
  await chrome.storage.local.set({ iherbSwitchInProgress: true });
  if (!await readFreshIherbLoginIntent(expectedIntent)) return;
  location.href = 'https://secure.iherb.com/myaccount/orders';
  } catch (e) {
    console.error('🔐 [iHerb Login] uncaught exception in main():', e);
    if (emailForFailure) {
      sendFailed(emailForFailure, 'main_threw: ' + (e?.message || String(e)));
    }
    // Если email не успели прочитать — флаги почистит watchdog (Fix 3b)
    // через IHERB_SWITCH_TIMEOUT_MS (5 мин). Это OK: пайплайн не зависнет.
  }
})();

// ─── 2-step login (checkout.iherb.com/auth/ui/account/login) ───
// LastPass-aware: до и после type ждём чтобы autofill отработал и стабилизировался,
// потом verify value и retry если LastPass перезаписал наш ввод.
async function runTwoStepLogin(email, password, expectedIntent) {
  // Settle wait: LastPass autofill инжектится с delay 1-3 сек после load.
  // Если начнём clear сразу — LastPass дозальёт ПОСЛЕ нашего type → invalid password.
  console.log('🔐 [iHerb Login] settle 4s (LastPass autofill window)');
  await sleep(4000);

  // Step A: email
  const emailInput = await waitForSelector(
    '#username-input, input[name="username"], input[autocomplete*="username"], input[type="email"]',
    16, 500
  );
  if (!emailInput) throw new Error('email_field_not_found');

  await assertFreshIherbLoginIntent(expectedIntent);
  await clearAndType(emailInput, email);
  await verifyOrRetry(emailInput, email, 'email');
  await sleep(800 + Math.random() * 400);

  const continueBtn = findVisibleButton([
    '#auth-continue-button',
    'button[type="submit"]'
  ], btn => /continue/i.test((btn.textContent || '').trim()));
  if (!continueBtn) throw new Error('continue_button_not_found');
  await assertFreshIherbLoginIntent(expectedIntent);
  console.log('🔐 [iHerb Login] click Continue');
  continueBtn.click();

  // Step B: wait for password step
  const passInput = await waitForSelector(
    '#password-input, input[type="password"], input[autocomplete="current-password"]',
    20, 500
  );
  if (!passInput) throw new Error('password_field_not_found_after_continue');

  // После показа password-step LastPass снова может попытаться autofill.
  console.log('🔐 [iHerb Login] password step settle 4s');
  await sleep(4000);

  await assertFreshIherbLoginIntent(expectedIntent);
  await clearAndType(passInput, password);
  await verifyOrRetry(passInput, password, 'password');

  await sleep(700 + Math.random() * 400);

  const signInBtn = findVisibleButton([
    '#auth-sign-in-button',
    'button[type="submit"]'
  ], btn => /^sign\s*in$/i.test((btn.textContent || '').trim()));
  if (!signInBtn) throw new Error('sign_in_button_not_found');
  await assertFreshIherbLoginIntent(expectedIntent);
  await markIherbFinalReturnLoginSubmitted(expectedIntent);
  console.log('🔐 [iHerb Login] click Sign In');
  signInBtn.click();
}

// Pause 1.5s, проверяем value === expected. Если drift — clearAndType ещё раз.
// Делаем до 2 retry, потом throw.
async function verifyOrRetry(input, expected, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(1500);
    const v = input.value || '';
    if (v === expected) {
      console.log(`🔐 [iHerb Login] ${label} value verified (len=${v.length})`);
      return;
    }
    console.warn(`🔐 [iHerb Login] ${label} drifted (got len=${v.length}, expected ${expected.length}); retry ${attempt + 1}/2`);
    if (attempt >= 2) break;
    await clearAndType(input, expected);
  }
  throw new Error(`${label}_input_drift_after_retries`);
}

// ─── Legacy single-form (secure.iherb.com/account/sign-in) ───
async function runLegacyLogin(email, password, expectedIntent) {
  const emailInput = await waitForSelector(
    'input[type="email"], input[name="email"], input[id*="email" i], input[autocomplete="username"]',
    16, 500
  );
  const passInput = await waitForSelector(
    'input[type="password"], input[name="password"], input[id*="password" i]',
    16, 500
  );
  if (!emailInput || !passInput) throw new Error('legacy_login_fields_not_found');

  console.log('🔐 [iHerb Login Legacy] settle 4s (LastPass autofill window)');
  await sleep(4000);
  await assertFreshIherbLoginIntent(expectedIntent);
  await clearAndType(emailInput, email);
  await verifyOrRetry(emailInput, email, 'legacy_email');
  await sleep(600 + Math.random() * 300);
  await clearAndType(passInput, password);
  await verifyOrRetry(passInput, password, 'legacy_password');
  await sleep(700 + Math.random() * 400);

  const form = passInput.closest('form');
  let submitBtn = form?.querySelector('button[type="submit"], input[type="submit"]');
  if (!submitBtn) submitBtn = document.querySelector('button[type="submit"], input[type="submit"], button[id*="sign" i]');

  await assertFreshIherbLoginIntent(expectedIntent);
  await markIherbFinalReturnLoginSubmitted(expectedIntent);
  if (submitBtn) submitBtn.click();
  else if (form) try { form.requestSubmit(); } catch (_) { form.submit(); }
  else throw new Error('legacy_submit_method_not_available');
}

// ─── Helpers ───

// Clear-and-type: LastPass autofill защита.
// DOM-версия через native setter + select/delete events
// (мы не в CDP, поэтому Input.dispatchKeyEvent не доступен —
// но React/Vue-safe setter + InputEvent надёжно чистит/заполняет input).
async function clearAndType(input, text) {
  input.focus();
  await sleep(150);

  // Multi-pass clear: LastPass может перезалить value в течение нескольких сот мс
  // после нашего clear. Очищаем 3 раза с проверкой между попытками.
  for (let pass = 0; pass < 3; pass++) {
    try {
      if (typeof input.setSelectionRange === 'function') {
        input.setSelectionRange(0, (input.value || '').length);
      } else {
        input.select?.();
      }
    } catch (_) {}
    await sleep(80);
    setNativeValue(input, '');
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(250);
    if ((input.value || '') === '') break;
    console.warn(`🔐 [iHerb Login] clear pass ${pass + 1}: value still "${(input.value || '').slice(0, 5)}…" — retry`);
  }
  if ((input.value || '') !== '') {
    console.warn('🔐 [iHerb Login] field STILL non-empty after 3 clear passes — typing on top anyway');
  }

  // Slow typing 200-280мс/символ, anti-LastPass-race
  for (const ch of text) {
    const prev = input.value || '';
    setNativeValue(input, prev + ch);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ch }));
    input.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: ch }));
    await sleep(200 + Math.random() * 80);
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));
  // Не делаем blur сразу: LastPass на blur может re-autofill.
  // Просто ждём небольшой stabilization.
  await sleep(300);
}

// React/Vue используют property setter перехват на HTMLInputElement.value,
// чтобы обнаруживать изменения. Обычный input.value = x не триггерит их state.
// Правильный способ — вызвать prototype setter напрямую.
function setNativeValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
}

async function waitForSelector(selector, tries, interval) {
  for (let i = 0; i < tries; i++) {
    const el = document.querySelector(selector);
    if (el && el.offsetParent !== null) return el;
    await sleep(interval);
  }
  return null;
}

function findVisibleButton(selectors, textFilter) {
  // First try: exact ID/selector match that's visible
  for (const s of selectors) {
    const el = document.querySelector(s);
    if (el && el.offsetParent !== null) {
      if (!textFilter || textFilter(el)) return el;
    }
  }
  // Fallback: scan all visible buttons by text
  const all = Array.from(document.querySelectorAll('button, input[type="submit"]'))
    .filter(b => b.offsetParent !== null);
  if (textFilter) {
    const hit = all.find(b => textFilter(b));
    if (hit) return hit;
  }
  return null;
}

function isErrorPage() {
  const hints = [
    'we couldn\'t find that page',
    'page you were looking for is temporarily unavailable',
    'service unavailable',
    'try again later'
  ];
  const bodyTxt = (document.body?.innerText || '').toLowerCase();
  if (hints.some(h => bodyTxt.includes(h))) return true;
  return /error|unavailable/i.test(document.title);
}

// ─── CAPTCHA detection ───
// Возвращает {active:boolean, type:string, sitekey?:string}.
// active=true ТОЛЬКО для видимого, реально показанного пользователю челленджа.
// НЕ считаются captcha:
//   - скрытый <textarea id="g-recaptcha-response"> (всегда display:none)
//   - фоновый reCAPTCHA anchor/badge iframe (схлопнут или off-screen у invisible)
//   - reCAPTCHA bframe в display:none (challenge ещё не вызван)
function isElementVisible(el) {
  if (!el) return false;
  if (el.offsetParent === null) return false;               // display:none или скрытый предок
  const rect = el.getBoundingClientRect();
  if (rect.width < 50 || rect.height < 50) return false;     // схлопнутый badge/anchor
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none') return false;
  if (parseFloat(cs.opacity || '1') < 0.1) return false;
  // элемент в пределах вьюпорта (не уведён за экран)
  if (rect.bottom < 0 || rect.right < 0 ||
      rect.top > (window.innerHeight || 0) || rect.left > (window.innerWidth || 0)) return false;
  return true;
}

function detectActiveCaptcha() {
  // 1) reCAPTCHA challenge popup (bframe) реально показан
  const recaptchaChallenge = document.querySelectorAll(
    'iframe[src*="recaptcha"][src*="bframe"], iframe[title="recaptcha challenge expires in two minutes." i]'
  );
  for (const f of recaptchaChallenge) {
    if (isElementVisible(f)) return { active: true, type: 'recaptcha-challenge', sitekey: extractRecaptchaSitekey() };
  }

  // 2) Видимый reCAPTCHA v2 checkbox (data-size != invisible)
  const visibleWidget = Array.from(
    document.querySelectorAll('.g-recaptcha:not([data-size="invisible"]), .h-captcha')
  ).find(isElementVisible);
  if (visibleWidget) {
    return { active: true, type: 'recaptcha-checkbox', sitekey: extractRecaptchaSitekey() };
  }

  // 3) hCaptcha challenge видим
  const hCaptcha = document.querySelectorAll(
    'iframe[src*="hcaptcha"][src*="challenge"], iframe[src*="newassets.hcaptcha"]'
  );
  for (const f of hCaptcha) {
    if (isElementVisible(f)) return { active: true, type: 'hcaptcha-challenge' };
  }

  // 4) DataDome / PerimeterX "Press & Hold" — видимый текст
  const bodyTxt = document.body ? (document.body.innerText || '') : '';
  if (/press\s*(&|and)\s*hold/i.test(bodyTxt)) {
    return { active: true, type: 'press-and-hold' };
  }

  // 5) "Verify you are human" — только если это challenge-страница, а не фон.
  //    (невидимый recaptcha не рисует этот текст, но перестрахуемся title-ом/контейнером)
  if (/verify\s+you\s+are\s+(a\s+)?human|are\s+you\s+a\s+robot/i.test(bodyTxt)) {
    if (/captcha|verify|robot|blocked|access\s*denied/i.test(document.title || '')) {
      return { active: true, type: 'verify-human' };
    }
    const overlay = document.querySelector('#datadome, [class*="datadome" i], [id*="captcha-container" i]');
    if (isElementVisible(overlay)) return { active: true, type: 'verify-human-overlay' };
  }

  // 6) Явный видимый captcha-overlay/modal
  const overlay = document.querySelector(
    '#datadome, [class*="datadome" i], [id*="captcha-container" i], [class*="captcha-modal" i]'
  );
  if (isElementVisible(overlay)) return { active: true, type: 'visible-overlay' };

  return { active: false, type: 'none' };
}

// Достаём reCAPTCHA sitekey для решения через 2captcha.
// Источники: data-sitekey виджета, ?k= в src фонового recaptcha iframe.
function extractRecaptchaSitekey() {
  const widget = document.querySelector('.g-recaptcha[data-sitekey], [data-sitekey]');
  if (widget) {
    const k = widget.getAttribute('data-sitekey');
    if (k) return k;
  }
  const frame = document.querySelector('iframe[src*="recaptcha"][src*="k="]');
  if (frame) {
    const m = /[?&]k=([^&]+)/.exec(frame.src || '');
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

// Бюджет на решение captcha. Если за это время не решили — caller уходит на
// skip-фолбэк (см. pipeline resilience в background.iherbSwitchFailed).
const CAPTCHA_SOLVE_BUDGET_MS = 60000;

// Пытается решить captcha через 2captcha (background.solveCaptcha) и применить токен.
// Возвращает true только если после применения мы реально ушли со страницы логина.
// Решаем только reCAPTCHA с известным sitekey — Press&Hold/DataDome 2captcha-токеном
// не закрыть, для них сразу false (→ skip).
async function trySolveCaptcha(cap, expectedIntent) {
  const isRecaptcha = cap.type === 'recaptcha-challenge' || cap.type === 'recaptcha-checkbox';
  if (!isRecaptcha || !cap.sitekey) {
    console.warn(`🧩 [iHerb Login] captcha type "${cap.type}" not auto-solvable (no sitekey / unsupported)`);
    return false;
  }

  const started = Date.now();
  let token;
  try {
    const resp = await sendMessageAsync({
      action: 'solveCaptcha',
      sitekey: cap.sitekey,
      pageurl: location.href.split('#')[0],
      timeoutMs: CAPTCHA_SOLVE_BUDGET_MS
    });
    if (!resp || !resp.ok || !resp.token) {
      console.warn('🧩 [iHerb Login] 2captcha did not return token:', resp && resp.reason);
      return false;
    }
    token = resp.token;
  } catch (e) {
    console.warn('🧩 [iHerb Login] solveCaptcha message failed:', e?.message || e);
    return false;
  }

  // Применяем токен в page-world (isolated content script не видит grecaptcha).
  await assertFreshIherbLoginIntent(expectedIntent);
  // The token callback can submit and navigate synchronously, destroying this
  // content-script context before the manual submit fallback below runs.
  await markIherbFinalReturnLoginSubmitted(expectedIntent);
  injectRecaptchaToken(token);
  await sleep(800);

  // Ре-сабмит формы — invisible reCAPTCHA после callback обычно сабмитит сам,
  // но добиваем кликом по submit на случай если callback не сработал.
  const submitBtn = document.querySelector(
    '#auth-sign-in-button, #auth-continue-button, button[type="submit"], input[type="submit"]'
  );
  if (submitBtn && submitBtn.offsetParent !== null) {
    await assertFreshIherbLoginIntent(expectedIntent);
    await markIherbFinalReturnLoginSubmitted(expectedIntent);
    try { submitBtn.click(); } catch (_) {}
  }

  // Ждём ухода со страницы логина в пределах оставшегося бюджета.
  while (Date.now() - started < CAPTCHA_SOLVE_BUDGET_MS) {
    await sleep(1000);
    if (!/\/account\/(sign-in|login)/i.test(location.href)) return true;
    // Если челлендж исчез и форма ушла — тоже успех
    if (!detectActiveCaptcha().active && !/\/account\/(sign-in|login)/i.test(location.href)) return true;
  }
  return false;
}

// Инжектит g-recaptcha-response токен в page-world и дёргает зарегистрированные
// callbacks через window.___grecaptcha_cfg (стандартная техника для headless-solve).
function injectRecaptchaToken(token) {
  const script = document.createElement('script');
  script.textContent = `(function(token){
    try {
      document.querySelectorAll('textarea#g-recaptcha-response, textarea[name="g-recaptcha-response"], textarea[id^="g-recaptcha-response"]').forEach(function(t){
        t.value = token;
        t.dispatchEvent(new Event('input', { bubbles: true }));
        t.dispatchEvent(new Event('change', { bubbles: true }));
      });
      var cfg = window.___grecaptcha_cfg;
      if (cfg && cfg.clients) {
        Object.keys(cfg.clients).forEach(function(cid){
          var client = cfg.clients[cid];
          Object.keys(client).forEach(function(k){
            var branch = client[k];
            if (branch && typeof branch === 'object') {
              Object.keys(branch).forEach(function(kk){
                var leaf = branch[kk];
                if (leaf && typeof leaf === 'object' && typeof leaf.callback === 'function') {
                  try { leaf.callback(token); } catch (e) {}
                }
              });
            }
          });
        });
      }
    } catch (e) { console.warn('recaptcha token inject error', e); }
  })(${JSON.stringify(token)});`;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

// Promise-обёртка над chrome.runtime.sendMessage.
function sendMessageAsync(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(resp);
      });
    } catch (e) { reject(e); }
  });
}

function sendFailed(email, reason) {
  chrome.runtime.sendMessage({
    action: 'iherbSwitchFailed',
    email,
    reason,
    runId: iherbSwitchRunId
  }, () => chrome.runtime.lastError /* swallow */);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
