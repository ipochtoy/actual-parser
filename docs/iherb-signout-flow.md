# iHerb Sign Out / Sign In Flow — CDP findings (2026-04-16)

**Phase 1 complete**: full cycle `photopochtoy → Sign out → Sign in as pochtoy` проверен в одном табе через CDP. Логаут и логин работают.

## Критические открытия

### 1. `<header>` с dropdown живёт ТОЛЬКО на `www.iherb.com`

На `secure.iherb.com/myaccount/orders` header вообще отсутствует: есть только `<MAIN>` с сайдбар-нав (Dashboard / Orders / Autoship / ...). Ни `.my-account`, ни Sign out там нет.

**Вывод**: для sign-out/sign-in надо сначала навигировать таб на `https://www.iherb.com/` (GET), и уже там использовать dropdown.

### 2. Tab MUST be activated before Input events

Если таб в background (не активен во фронте браузера) — каждый `Input.dispatchMouseEvent` висит 5 сек (измерено). После активации — 2–5 мс.

Активация: `POST http://127.0.0.1:9222/json/activate/<tabId>` (или `chrome.tabs.update(tabId, {active: true})` из расширения).

### 3. Pre-filled fields надо ЧИСТИТЬ

LastPass / browser autofill подставляет email+password. Если печатать поверх — получишь `1Svetakurz@1Svetakurz@` → Invalid password.

Последовательность clear:
1. Click на поле (фокус)
2. Triple-click (select all text)
3. Cmd/Ctrl+A (дополнительно)
4. Delete
5. Backspace (страховка)
6. Только потом typeKeys

### 4. Hover-driven dropdown, не click

`.my-account` триггер открывает панель ТОЛЬКО через CSS `:hover`. Клик по `.my-account-label` навигирует на Dashboard.

Механика:
1. `mouseMoved` → нейтральная точка (100, 500)
2. Пауза 300–500ms
3. `mouseMoved` → центр `.my-account` (трейт живёт ~1920×20 в header-е)
4. Ждать 1500–2000ms — dropdown рендерится с анимацией
5. Для click по кнопке внутри dropdown: "glide" мышью ВНИЗ через центр trigger-а (чтобы не триггернуть mouseleave)

## Полный flow (подтверждённый)

```
START: www.iherb.com (logged-in as photopochtoy)
 │
 ├─ activateTab(id)
 ├─ hover .my-account (1800ms)
 ├─ glide mouse to Sign out btn
 ├─ click Sign out (a[href*="logoff"])
 │    → redirect to www.iherb.com/?correlationId=<uuid> (logged-out)
 │
 ├─ hover .my-account again (dropdown now shows "Welcome!" + green btn)
 ├─ click "Sign in/Create an account" (a[href*="/auth/ui/account/login"])
 │    → checkout.iherb.com/auth/ui/account/login?correlationId=<uuid>
 │
 ├─ type email в #username-input (после clear!)
 ├─ click "Continue" button (type="submit", text "Continue")
 │    → stays on same URL, появляется password step
 │
 ├─ CLEAR #password-input (triple-click + Cmd+A + Delete + Backspace)
 ├─ type password
 ├─ click #auth-sign-in-button (text "Sign In")
 │    → /auth/connect/authorize/callback?client_id=... (OAuth)
 │    → www.iherb.com/?correlationId=<uuid> (logged-in as pochtoy)
 │
 └─ DONE. dropdown теперь показывает "Hi Dzianis", Sign out снова появилась.
```

## Селекторы

| Поле / Кнопка | Селектор | Fallback |
|---|---|---|
| Dropdown trigger (на www.iherb.com) | `.my-account` | `.my-account-link-container` |
| Sign out link (logged-in state) | `a.btn-primary-universal[href*="logoff"]` | text === "Sign out" |
| Sign in / Create btn (logged-out state) | `a[href*="/auth/ui/account/login"]` | text matches `sign.*in.*create` |
| Email input | `#username-input` | `input[name="username"]`, `input[autocomplete*="username"]`, `input[type="email"]` |
| Continue button (email step) | `button[type="submit"]` + `textContent.toLowerCase()==='continue'` | — |
| Password input | `#password-input` | `input[type="password"]`, `input[autocomplete="current-password"]` |
| Sign In button (password step) | `#auth-sign-in-button` (указал юзер) | `button` + `textContent.toLowerCase()==='sign in'` |

## Тайминги (real measurements)

| Шаг | Время |
|---|---|
| Hover trigger → dropdown visible | 1500–2000 ms |
| Sign out click → redirect complete | ~3–4 s |
| Click Sign in/Create → login page render | ~2 s |
| Email step → password step | ~500 ms (same URL, SPA render) |
| Password submit → OAuth callback → home logged-in | 3–6 s |

## Риски

- **reCAPTCHA Enterprise loaded** (невидимый). Если бот заподозрён — форма сабмитится, но login не проходит, редиректа нет. Нужен fallback: детектить по `location.href` не ушедшему с login page после 15 сек.
- **LastPass autofill** предзаполняет password → обязательный clear step.
- **Keep me signed in** чекбокс уже checked по умолчанию — трогать не надо.
- **correlationId** в URL новый для каждого OAuth-цикла — не кешировать URL.
- **Sign In with Email Link** кнопка тоже `type="submit"` — если не фильтровать по тексту/id, может случайно кликнуться.

## Скрипты reference

- `agent/_iherb-signout-walk.mjs` — начало flow (sign out + nav to login) с активацией и glide-mouse
- `agent/_iherb-fill-password.mjs` — clear pre-filled + type password + click Sign In
- `agent/_iherb-signin-only.mjs` — sign-in half starting from logged-out home
