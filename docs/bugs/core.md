# Parser Pro incident register

## 2026-09-11: completed iHerb parsing was mistaken for a failed login

The run `1789095600000-1789093501621-7xzcle` stopped at 02:38:24 UTC with
`screenshotQueueBlocked.kind=account-mismatch`. Its next card belonged to the
third iHerb account, but `activeAccount` was empty; 30 cards remained. The last
confirmed archive receipt preceded the block by six seconds. All three iHerb
entries in `pipelineRun.completed` describe parsed rows, not a completed
screenshot stage or a Sheets receipt.

`parserStarted` left `iherbSwitchInProgress` and `iherbSwitchStartedAt` behind.
Completion consumption then cleared `iherbParseStartedAt` before draining the
screenshots. The five-minute switch watchdog interpreted this state as a login
timeout. Its retry handler cleared `currentIherbAccount` and requeued that
account while screenshots still needed it. The stored switch timestamp was
02:33:02.776 UTC, 321 seconds before the block. The actual completion → watchdog
→ failure-handler chain reproduces this loss on both `20fe1ba` and `ef8ec72`.
A late login-failure message from the same run/account could cause the same
mutation; no retained service-worker console identifies the historical caller.

The accepted parse start and valid completion now retire only their matching
switch markers under the existing attempt arbiter. The account remains owned
until the screenshot drain and normal next-account transition finish. Switch
failure recovery requires an open, matching attempt with no accepted parse,
terminal account result, human challenge or screenshot work. A real failed
switch retains its bounded retry and skip behavior.

New login senders include the attempt ID and stage start. A legacy sender's
unbound failure cannot request another login; the exact watchdog can still
recover an actual pending switch. The existing CAPTCHA stop/finalization path
remains available for a matching pending legacy login, and late CAPTCHA or
Press & Hold messages cannot reopen accepted parsing. A locally modified live
login sender must be preserved when deploying the background-only repair.

Regression: `tests/iherb-switch-screenshot-race.test.mjs` covers 30 queued
screenshots, missing parse-start messages, stale switch flags, late and foreign
attempts, legacy sender behavior, CAPTCHA/Press & Hold, and bounded real retries.
This does not turn a blocked run into a usable terminal result or clear its
stored queue. Coordinator stopped-run recovery requires its own exact proof.

## 2026-08-18: nightly six-cabinet run skipped accounts and stalled

Symptoms:

- iHerb spent its stage budget sending 129 account-bound tracking cards and skipped two of three cabinets.
- Amazon stopped between pages 16 and 17; the old timeout screenshot could capture an unrelated active tab.
- Manifest V3 restarts could strand prepared stages, final returns or the final Sheet upload.
- Completion handlers, watchdogs and stale content pages could race over one parser tab and shared storage.

Root causes:

- Screenshot delivery time was charged as parser time and the queue did not have a durable confirmed-head contract.
- Run, account, tab and parse-attempt ownership was not checked at every asynchronous boundary.
- Stage finalizers and the physical Google Sheets transaction were not single-flight.
- A green result was based on legacy aggregate flags instead of the exact six-account run and upload proof.

Resolution in 7.8.0:

- Durable sequential pipeline with exact 3 iHerb + 1 eBay + 2 Amazon roster.
- Generation-fenced account switches, pagination commits, timeouts, restart recovery and final returns.
- Persisted screenshot queue with confirmed delivery, bounded quarantine and stage-budget exclusion.
- Run-scoped Sheet payload plus one shared physical upload transaction and durable success stamp.
- Human-only stop for iHerb Press & Hold.

Regression gate:

- Run `node --test tests/*.test.mjs`.
- Run `node --check` for every manifest production script.
- Run `git diff --check`.
- Live completion additionally requires exact roster completion, empty screenshot queue, inactive `done` stage and a Sheet stamp for the same run ID.

## 2026-08-18: production tuning was lost by the clean reliability release

Symptoms:

- The clean 7.8.0 branch did not contain the dirty live timing and operator-report changes from the bot Mac.
- Amazon advanced the saved cursor before a five-second page settle, so a restart could parse page 16 as page 17 and then skip the real page 17.
- A healthy forty-minute Amazon cabinet was still stopped by a hidden twenty-minute account cap.
- Failed multipart Telegram delivery could still mark a cancellation warning as already shown.

Root causes:

- The live working tree and the clean release had diverged; replacing one with the other would lose proven behavior.
- Cursor progress, navigation intent and the physical navigation were committed in three separate restart windows.
- Nested account and stage time budgets were not tested together.
- Notification deduplication recorded an attempted send instead of confirmed delivery of every part.

Resolution in `62d4565`:

- Three-way merged the exact live `background.js` and `content-amazon.js` into the reliability release.
- Persisted the next-page cursor together with its exact navigation marker before the settle; restart immediately redispatches that marker.
- Set a 45-minute Amazon account cap inside the 100-minute two-account stage and kept the ten-minute idle detector.
- Made multipart Telegram delivery explicit and wrote cancellation IDs only after all parts were accepted.
- Added behavioral regression tests for restart at page transition, exact completion page, nested budgets, report counters and failed delivery.
