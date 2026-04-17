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

(async function main() {
  if (IS_LOGOFF) {
    // iHerb после /account/logoff сам редиректит на home. Фолбэк на sign-in если застряли.
    console.log('🔐 [iHerb Login] logoff page — waiting for redirect');
    setTimeout(() => {
      if (/\/account\/logoff/i.test(location.href)) {
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

  const { email, password } = data.pendingIherbSwitch;
  if (!email || !password) {
    console.warn('🔐 [iHerb Login] pendingIherbSwitch missing email/password');
    return;
  }

  console.log(`🔐 [iHerb Login] auto-login as ${email} (finalReturn=${!!data.iherbFinalReturn}, layout=${IS_NEW_LOGIN ? '2step' : 'legacy'})`);

  // Детект error-page (cloudflare / 503 / temporarily unavailable)
  if (isErrorPage()) {
    const retries = (data.iherbSignInRetries || 0) + 1;
    const MAX = 3;
    if (retries <= MAX) {
      const wait = retries === 1 ? 5000 : retries === 2 ? 15000 : 30000;
      console.warn(`🔐 [iHerb Login] error page (try ${retries}/${MAX}) — reload in ${wait}ms`);
      await chrome.storage.local.set({ iherbSignInRetries: retries });
      await sleep(wait);
      location.reload();
      return;
    } else {
      console.error('🔐 [iHerb Login] error page persists after retries');
      await chrome.storage.local.remove(['iherbSignInRetries']);
      sendFailed(email, 'sign_in_page_error_after_retries');
      return;
    }
  }
  await chrome.storage.local.remove(['iherbSignInRetries']);

  try {
    if (IS_NEW_LOGIN) {
      await runTwoStepLogin(email, password);
    } else {
      await runLegacyLogin(email, password);
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

  // CAPTCHA check
  if (/\/account\/(sign-in|login)/i.test(location.href)) {
    const captcha = !!document.querySelector(
      'iframe[src*="captcha" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], [class*="captcha" i]'
    );
    if (captcha) {
      console.warn('🔐 [iHerb Login] CAPTCHA detected — alert operator');
      sendFailed(email, 'captcha');
      return;
    }
  }

  // Login завершён — чистим pendingIherbSwitch
  await chrome.storage.local.remove(['pendingIherbSwitch']);

  if (data.iherbFinalReturn) {
    console.log('🏁 [iHerb Login] final return done, going to home');
    await chrome.storage.local.remove(['iherbFinalReturn', 'iherbSwitchInProgress']);
    location.href = 'https://www.iherb.com/';
    return;
  }

  console.log('🔐 [iHerb Login] → /myaccount/orders for parse');
  await chrome.storage.local.set({ iherbSwitchInProgress: true });
  location.href = 'https://secure.iherb.com/myaccount/orders';
})();

// ─── 2-step login (checkout.iherb.com/auth/ui/account/login) ───
async function runTwoStepLogin(email, password) {
  // Step A: email
  const emailInput = await waitForSelector(
    '#username-input, input[name="username"], input[autocomplete*="username"], input[type="email"]',
    16, 500
  );
  if (!emailInput) throw new Error('email_field_not_found');

  await clearAndType(emailInput, email);
  await sleep(600 + Math.random() * 400);

  const continueBtn = findVisibleButton([
    '#auth-continue-button',
    'button[type="submit"]'
  ], btn => /continue/i.test((btn.textContent || '').trim()));
  if (!continueBtn) throw new Error('continue_button_not_found');
  console.log('🔐 [iHerb Login] click Continue');
  continueBtn.click();

  // Step B: wait for password step
  const passInput = await waitForSelector(
    '#password-input, input[type="password"], input[autocomplete="current-password"]',
    20, 500
  );
  if (!passInput) throw new Error('password_field_not_found_after_continue');

  await sleep(400 + Math.random() * 400);
  await clearAndType(passInput, password);
  await sleep(900 + Math.random() * 600);

  const signInBtn = findVisibleButton([
    '#auth-sign-in-button',
    'button[type="submit"]'
  ], btn => /^sign\s*in$/i.test((btn.textContent || '').trim()));
  if (!signInBtn) throw new Error('sign_in_button_not_found');
  console.log('🔐 [iHerb Login] click Sign In');
  signInBtn.click();
}

// ─── Legacy single-form (secure.iherb.com/account/sign-in) ───
async function runLegacyLogin(email, password) {
  const emailInput = await waitForSelector(
    'input[type="email"], input[name="email"], input[id*="email" i], input[autocomplete="username"]',
    16, 500
  );
  const passInput = await waitForSelector(
    'input[type="password"], input[name="password"], input[id*="password" i]',
    16, 500
  );
  if (!emailInput || !passInput) throw new Error('legacy_login_fields_not_found');

  await clearAndType(emailInput, email);
  await sleep(400 + Math.random() * 400);
  await clearAndType(passInput, password);
  await sleep(900 + Math.random() * 700);

  const form = passInput.closest('form');
  let submitBtn = form?.querySelector('button[type="submit"], input[type="submit"]');
  if (!submitBtn) submitBtn = document.querySelector('button[type="submit"], input[type="submit"], button[id*="sign" i]');

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
  await sleep(80);

  // 1. Select all via setSelectionRange (работает на text inputs)
  try {
    if (typeof input.setSelectionRange === 'function') {
      input.setSelectionRange(0, (input.value || '').length);
    } else {
      input.select?.();
    }
  } catch (_) {}
  await sleep(50);

  // 2. Clear value через native setter (React/Vue not bypass)
  setNativeValue(input, '');
  input.dispatchEvent(new Event('input',  { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(120);

  // 3. Посимвольный ввод с anti-bot jitter
  for (const ch of text) {
    const prev = input.value || '';
    setNativeValue(input, prev + ch);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ch }));
    input.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: ch }));
    await sleep(80 + Math.random() * 80);
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur',   { bubbles: true }));
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

function sendFailed(email, reason) {
  chrome.runtime.sendMessage({
    action: 'iherbSwitchFailed',
    email,
    reason
  }, () => chrome.runtime.lastError /* swallow */);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
