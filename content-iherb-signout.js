// content-iherb-signout.js
// Активен на www.iherb.com/* (header с .my-account dropdown живёт ТОЛЬКО здесь,
// secure.iherb.com — без header-а). Phase 1 CDP findings:
//   - Dropdown открывается ТОЛЬКО через CSS `:hover` на .my-account.
//     DOM-события (dispatchEvent mouseover/click) НЕ триггерят :hover.
//     Поэтому фактический click делает background.js через chrome.debugger
//     (Input.dispatchMouseEvent). Этот content script только отдаёт координаты.
//   - Sign out live в dropdown: `a.btn-primary-universal[href*="logoff"]`.
//     После logout появляется `a[href*="/auth/ui/account/login"]` (или legacy
//     /account/sign-in) — Sign in/Create an account.
//
// RPC actions (chrome.runtime.onMessage):
//   iherbGetDropdownTrigger      → { x, y } of .my-account center
//   iherbGetSignOutCoords        → { x, y, href, visible } после hover
//   iherbGetSignInCreateCoords   → { x, y, href, visible } в logged-out state
//   iherbCheckLoginState         → { loggedIn, email, hasSignInText }

console.log('🚪 [iHerb Signout] script loaded on', location.href);

function centerOf(el) {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.x + r.width / 2),
    y: Math.round(r.y + r.height / 2),
    w: Math.round(r.width),
    h: Math.round(r.height),
    visible: el.offsetParent !== null
  };
}

function findSignOutLink() {
  const sels = [
    'a.btn-primary-universal[href*="logoff"]',
    'a[href*="/account/logoff"]',
    'a[href*="logoff"]'
  ];
  for (const s of sels) {
    const el = document.querySelector(s);
    if (el) return el;
  }
  return Array.from(document.querySelectorAll('a, button'))
    .find(x => (x.textContent || '').trim() === 'Sign out') || null;
}

function findSignInCreateLink() {
  const sels = [
    'a.btn-primary-universal[href*="/auth/ui/account/login"]',
    'a.btn-primary-universal[href*="/account/login"]',
    'a.btn-primary-universal[href*="sign-in"]',
    'a[href*="/auth/ui/account/login"]',
    'a[href*="/account/login"]',
    'a[href*="/account/sign-in"]'
  ];
  for (const s of sels) {
    const el = document.querySelector(s);
    if (el && el.offsetParent !== null) return el;
  }
  return Array.from(document.querySelectorAll('a, button'))
    .find(x => {
      const t = (x.textContent || '').trim();
      return /sign\s*in.*create|create.*account/i.test(t) && x.offsetParent !== null;
    }) || null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.action === 'iherbGetDropdownTrigger') {
        const el = document.querySelector('.my-account');
        if (!el) return sendResponse({ ok: false, error: 'trigger_not_found' });
        return sendResponse({ ok: true, coords: centerOf(el) });
      }

      if (msg?.action === 'iherbGetSignOutCoords') {
        const el = findSignOutLink();
        if (!el) return sendResponse({ ok: false, error: 'signout_not_found' });
        const c = centerOf(el);
        return sendResponse({
          ok: true,
          coords: c,
          href: el.getAttribute('href') || null
        });
      }

      if (msg?.action === 'iherbGetSignInCreateCoords') {
        const el = findSignInCreateLink();
        if (!el) return sendResponse({ ok: false, error: 'signin_create_not_found' });
        const c = centerOf(el);
        return sendResponse({
          ok: true,
          coords: c,
          href: el.getAttribute('href') || null,
          text: (el.textContent || '').trim().slice(0, 60)
        });
      }

      if (msg?.action === 'iherbCheckLoginState') {
        const body = document.body?.innerText || '';
        const hi = body.match(/Hi[,\s]+([^\s!\n<]+)/);
        const welcome = body.match(/Welcome[,\s]+([^\s!\n<]+)/);
        const hasSignInText = /sign\s*in/i.test(body.slice(0, 3000));
        return sendResponse({
          ok: true,
          loggedIn: !!hi,
          email: hi?.[1] || welcome?.[1] || null,
          hasSignInText
        });
      }

      // Unknown action — let other listeners respond
      return false;
    } catch (e) {
      console.warn('🚪 [iHerb Signout] handler error:', e);
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true; // async response
});
