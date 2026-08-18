# Parser Pro incident register

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
