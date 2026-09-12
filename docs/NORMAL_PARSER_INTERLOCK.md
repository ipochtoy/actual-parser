# Normal Parser browser ownership

`parserWorkAuthority` is the Parser side of AutoBuy's protocol 1
`rpc_parserWorkFence`. It is separate from orphan store-walk cleanup and from
the operator's repair pause. The old `setParserLock` console message is only a
diagnostic; it is not an ownership transport.

A normal start requires the exact native coordinator admission, persisted
with the start request after Node verifies its current process and filesystem
claim. Parser creates its generation and requesting record in the serialized
lease writer. It releases that writer before asking AutoBuy for admission.
AutoBuy checks the durable Parser intent through the fixed, read-only
`parserWorkAuthorityV1` callback. Neither writer waits for the other while
holding the Parser writer. Direct UI, per-store and legacy parallel starts
without that native lifecycle refuse before merchant work.

An active purchase keeps its existing accounting path. Parser waits for an
explicit idle admission, retrying every 30 seconds for at most five minutes.
An explicitly ungranted attempt can finish as refused; a lost response retains
its exact request UUID and is reconciled only by exact readback. No timeout
turns a held fence into permission for another owner. No repair-pause key is
changed by this protocol.

Before merchant work Parser checks the exact generation, live running lease,
its local authority and the same AutoBuy record. Created tabs have a durable
pending intent followed by the exact owned tab ID. Unknown creation outcomes
retain the intent. Existing merchant tabs are never adopted by URL. Owned IDs
are additionally bound to `chrome.storage.session.parserWorkBrowserSessionId`:
a service worker may sleep, but a full browser restart cannot reuse a previous
tab number as ownership evidence. Late eBay detail requests must come from the
current owned parser tab and participate in the actual in-flight operation set.

Completion and a same-run Sheets ACK do not themselves release the browser.
The native coordinator independently verifies the primary iHerb and Amazon
accounts through the existing verify-only cabinet commands, closes all of its
exact verification sessions, and records both strong outputs and zero own
tabs. It then writes `parserWorkFinishRequest` and calls the fixed handler.
Parser requires quiet terminal state and a fresh exact proof, closes only its
own durable tabs in the same browser session, persists the closed receipt, and
then releases AutoBuy outside the serialized writer. A lost release ACK is
retried with the stored UUID; completed browser cleanup is not repeated.

An interrupted cleaning request can be replaced only by a newer proof for the
same held generation after the native side proves its previous workers dead.
The old request is preserved under `parserWorkFinishHistory:<requestId>`.
The normal lease writer blocks every unrelated grant, including a cached ACK,
until this lifecycle is settled. Same-owner running heartbeats remain allowed.

The next native RECOVER may finish a previous **completed/degraded** generation
only with its accepted Sheets ACK, quiet Parser, exact native start receipt,
fresh process evidence on all three hosts, and the same verify-only path. A
running/blocked generation, changed browser session, unknown tab creation or
missing accounting evidence stays blocked; none authorizes a hidden account
switch, queue clearing, new lease grant, or operator-pause change.

Load the matching AutoBuy protocol and Node door before this Parser background.
Older AutoBuy protocol replies do not authorize a new Parser run. The native
installation barrier owns deployment ordering and storage preservation.

Tests: `node --test tests/*.test.mjs`. The four Amazon DOM fixtures additionally
require `PARSER_PRO_PLAYWRIGHT_MODULE` pointing to the installed Playwright
module; they launch only a disposable, network-blocked fixture browser.
External AutoBuy contracts use `PARSER_WORK_CONTRACT_ROOT=<this repository>`.
External VM suites that import `tests/cleanup-authority.test.mjs` must include
its relative `tests/helpers/parser-normal-fixture.mjs` dependency.
