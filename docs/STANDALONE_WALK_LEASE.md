# Shared admission for a partial Store Walk

`STANDALONE_WALK_LEASE_PROTOCOL_VERSION === 1` advertises this protocol in the
Parser service worker. It uses the existing `nightCabinetLease` and
`withNightCabinetLeaseWrite` queue. A local lock, read-only gate, or time check
does not grant browser access.

The Node caller creates an immutable request containing its exact `--only`,
`--no-tail`, `--no-blind`, `--no-add` and other effective work limits. Its SHA-256
binds this scope to the following envelope; partial walks do not enter the
six-cabinet manual pipeline.

```js
const standaloneWalk = {
  schemaVersion: 1,
  kind: 'standalone-store-walk',
  id: '<fresh UUID>',
  runId: `store-walk:${pid}:${createdAt}`,
  requestSha: '<immutable Node request SHA-256, 64 lowercase hex characters>',
  createdAt,
  deadlineAt,
  nextNativeAdmissionAt
};
const desired = {
  slotId: String(createdAt),
  owner: 'store-walk',
  phase: 'store-main',
  token: `standalone:${standaloneWalk.id}:walk`
};
```

Parser validates all fields and computes the New York boundary itself, including
DST. First admission must occur within 120 seconds of `createdAt`, before the
work cutoff. `deadlineAt` is at most 570 minutes after creation and no later than
20:15 New York. Work stops 15 minutes before that deadline; that reserve belongs
to cleanup. The native admission boundary is 20:30. These bounds do not permit
rollover over a live or expired but unfinished owner.

Persist `nightCoordinatorLeaseTransitionRequest` with a fresh `requestId`,
`requestedAt`, `desired`, `standaloneWalk`, and an exact `expected` snapshot:

```js
{ state: 'missing' }
// or
{ state: 'present', slotId, owner, phase, token, heartbeat, expires /* runId if present */ }
```

`heartbeat` and `expires` are optional together for legacy callers, but new
callers should always include both raw numbers. They are mandatory when settling
an expired lease. Never coerce, omit or replace an observed owner to get a grant.
`manualControl` and `standaloneWalk` are mutually exclusive. Wake with only
`{action:'nightCoordinatorLeaseTransitionWake'}`; the handler re-reads the durable
request under the existing serialized writer.

Admission requires an exact request-id success in
`nightCoordinatorLeaseTransitionResult` and a fresh exact lease readback. An open
lease must also have `expires > Parser Date.now()`. The writer checks Parser run,
stage, parsing flags, finalizers, pending switches/uploads and screenshot queue
before every new Store Walk owner. Unknown state fails closed. All native Parser
alarms still require an explicit active Parser-ready lease; an expired Store
Walk lease never grants an internal alarm permission.

The durable `standaloneWalkGenerationLedger` shape is:

```js
{
  schemaVersion: 1,
  day: 'YYYY-MM-DD', // New York creation day
  generations: {
    '<id>': {
      schemaVersion: 1,
      envelope: standaloneWalk,
      admittedAt,
      closedAt: null,       // integer after terminal settlement
      terminalPhase: null   // completed | degraded | blocked | failed after settlement
    }
  }
}
```

The lease, record and acknowledgment commit together. Existing generations may
renew only their exact still-active `store-main` lease, with a 15-minute TTL
capped by `deadlineAt`. An expired, missing or replaced lease cannot be reopened.
Closed generations and previously consumed `runId`s cannot start again. A
missing lease pointer does not hide an unclosed generation. The ledger is capped
at 128 generations per day; a new day replaces it only after every old record is
valid, closed and past its immutable deadline. Malformed or incomplete state is
never silently reconstructed or truncated.

Node must acquire before its local round lock, report creation, guard pause or
browser work. It must independently renew while synchronous child commands run,
check the exact open lease before each new action, enforce the work/cleanup
deadlines, and stop only its own child processes on loss or unknown ownership.
An acknowledgment lost after a commit is uncertainty: inspect the same request,
lease and generation; do not invent a new generation or infer success.

## Terminal settlement

After Node proves owned cleanup, it requests `completed`, `degraded`, `blocked`
or `failed` with the same envelope, token and exact expected lease. This changes
the phase and records closure; it preserves the previous `heartbeat` and
`expires`. Settlement grants no new browser time.

The same terminal-only operation can settle an old native or manual Store Walk
lease after its slot window/deadline. An expired manual request must include its
exact existing `manualControl` envelope and valid durable generation/index;
neither is created or repaired by settlement. Both old timestamp fields are
mandatory CAS proof. Missing/changed identity or a renewal after the snapshot
refuses the operation. Native settlement omits either generation envelope but
still supplies the exact old tuple and times. This protocol records Node's
already-proved cleanup; it does not replace Node's process, account or owned-tab
proof and does not authorize cleaning a foreign live worker.

After settlement, re-read the entire old lease: only `phase` may have changed.
Read the exact result and generation closure where applicable. `store-main`,
renewal and Parser-ready requests using the expired descriptor remain refused.

## Early native recovery

The Node slot precheck can call `nightCabinetLeaseSlotIds(Date.now(), desired)`.
For a `store-walk` destination it includes the upcoming native slot from 20:30,
so the persisted native main token can own `recover`, then `store-main` and
cleanup. Parameterless callers and Parser-ready destinations retain the
existing 21:00 upcoming-slot window. Foreign or unfinished expired owners still
block this admission; the earlier clock is not an ownership bypass.

## Expired owner cleanup authority v1

`STORE_WALK_CLEANUP_PROTOCOL_VERSION === 1` exposes a separate, bounded cleanup
authority. It does not renew, replace or reopen an expired work lease. Native,
manual and standalone owners use the same serialized Parser writer. This API
does not execute browser commands, verify remote processes, remove a pause or
release an AutoBuy fence; those are the trusted Node coordinator's duties.

The controlled installer must first provision exactly one Pittsburgh profile:

```js
nightCabinetAuthorityScope = {
  schemaVersion: 1,
  kind: 'pittsburgh-parser-authority',
  id: '<installer-pinned UUID>'
};
```

The API never creates or repairs this scope. Every Node caller must pin that
exact profile/scope and verify all three configured hosts, without falling back
to a local Parser. Equal extension IDs on different profiles do not imply one
shared authority. Normal operation without any cleanup state does not create a
scope or a cleanup ledger.

All SHA fields below are 64 lowercase hexadecimal characters. `targetSha` and
`proofSha` use SHA-256 of UTF-8 JSON with recursively sorted object keys, preserved
array order and no whitespace. IDs, strings, arrays, numeric times and allowed
keys are bounded and validated; unknown fields do not grant permission.

```js
const target = {
  schemaVersion: 1,
  kind: 'dead-store-walk', // or 'unstarted-store-walk' with a Node no-work proof
  scopeId,
  lease: { slotId, owner: 'store-walk', phase, token, heartbeat, expires /* runId if present */ },
  run: { runId, session, hostId, bootId, pid, processStartFingerprint },
  refs: { manifestSha, claimSha, reportSha, guardSha },
  generation: null
  // or {kind:'manual-control', envelope: exactExistingManualEnvelope}
  // or {kind:'standalone-store-walk', envelope: exactExistingStandaloneEnvelope}
};
const proof = {
  schemaVersion: 1,
  kind: 'store-walk-cleanup-admission',
  scopeId,
  targetSha: sha(target),
  attemptId: freshAttemptId,
  capturedAt,
  evidenceSha, // immutable Node admission evidence, including exact liveness checks
  hosts: [
    {hostId: 'pittsburgh', bootId, observedAt, proofSha: hostEvidenceSha},
    {hostId: 'minsk', bootId: minskBootId, observedAt, proofSha: minskEvidenceSha},
    {hostId: 'air', bootId: airBootId, observedAt, proofSha: airEvidenceSha}
  ],
  previous: null
};
const attempt = {
  schemaVersion: 1,
  kind: 'store-walk-cleanup',
  id: freshAttemptId,
  scopeId,
  targetSha: sha(target),
  owner: {hostId, bootId, pid, processStartFingerprint, runId: cleanupWorkerRunId},
  createdAt,
  deadlineAt: createdAt + 900000,
  proofSha: sha(proof)
};
```

`manifestSha` is mandatory. The other file digests may be null for artifacts
that do not exist; a `dead-store-walk` target requires `reportSha`. Node's private
manifest must bind exact canonical paths, contents, original generation, source
versions, cleanup scope and process ancestry. Parser compares the full raw old
lease, validates existing manual/standalone records, verifies envelope hashes and
Parser idleness, and requires three distinct fresh host proof references. It
does **not** interpret a digest or `processesGone:true` as its own PID check.

First admission is within 60 seconds of `createdAt`. Every host observation and
`capturedAt` must be no more than 60 seconds old in Parser time. The deadline is
immutable, exactly 15 minutes after creation. No `renew` or work operation exists.

Persist the request, then issue only the parameterless wake:

```js
nightCabinetCleanupTransitionRequest = {
  schemaVersion: 1,
  requestId: '<fresh 16..200-character request ID>',
  requestedAt,
  operation: 'claim',
  expectedLease: target.lease,
  expectedAux: null, // or the entire observed closed prior aux record
  target,
  attempt,
  proof
};
chrome.runtime.sendMessage({action:'nightCabinetCleanupTransitionWake'});
```

Read the exact request ID from `nightCabinetCleanupTransitionResult`. Success
contains `aux` and the unchanged work `lease`. Re-read scope, full aux, ledger,
old raw lease and Parser clock before browser work. A lost reply is resolved by
re-reading/resending the identical request; no new timestamps or owner are
invented. The immutable attempt and deadline stay unchanged on repeat.

`nightCabinetCleanupLease` is the current attempt record:

```js
{
  schemaVersion: 1, scopeId, targetSha, attempt, proof,
  admittedAt, closedAt: null, phase: 'cleanup', receipt: null,
  claimRequest: {id: requestId, sha: sha(exactRequest)}, finishRequest: null
}
```

`nightCabinetCleanupLedger` contains `{schemaVersion:1,scopeId,target,targetSha,
attempts:{[attempt.id]:record},closedAt:null,receipt:null}`. An unresolved record,
an expired record, a missing pointer with retained ledger, or malformed state
blocks **every** normal lease transition and direct Parser start. Expiry alone
never clears that blocker. The ledger retains up to 64 attempts for its target,
with one chain and one open owner. It rotates only after the previous target is
closed and a different exact expired work lease is current; prior requests then
cannot match the new raw target.

After an interrupted cleanup, `operation:'retry'` supplies the full exact open
`expectedAux`, the same target, a fresh attempt ID and a different worker. The
previous attempt must have expired. Fresh Node proof must include:

```js
proof.previous = {
  attemptId: previousAux.attempt.id,
  auxSha: sha(previousAux),
  owner: previousAux.attempt.owner,
  processesGone: true,
  proofSha: exactPriorCleanupTreeStoppedEvidenceSha
};
```

The trusted Node collector proves that exact host/boot/PID/fingerprint and all
owned descendants stopped, plus the absence of in-flight browser work. Unknown
or unreachable is refusal. Parser checks this exact reference, freshness and
the prior aux CAS, marks that attempt `abandoned`, and grants the new attempt
atomically. It never adopts or renews the previous worker.

After verified home/account state, exact owned-tab cleanup, safe protections,
preserved foreign/manual pauses and exact filesystem-claim closure, Node fsyncs
its immutable receipt. It sends:

```js
const receipt = {
  schemaVersion: 1,
  kind: 'store-walk-cleanup-complete',
  scopeId, targetSha: attempt.targetSha, attemptId: attempt.id,
  completedAt, receiptSha,
  home: true, ownTabs: true, protections: true, pause: true, claimsClosed: true
};
const finishRequest = {
  schemaVersion: 1, requestId: freshRequestId, requestedAt,
  operation: 'finish', expectedLease: target.lease, expectedAux: exactAux,
  target, attempt, receipt
};
```

`completedAt` must be between admission and the original attempt deadline.
`finish` requires that deadline still to be open. `finish-metadata` may close an
already completed cleanup after a crash/expiry, using that exact durable receipt
and a fresh `proof.previous` binding the same aux and stopped worker. It grants
no browser time. An already closed exact receipt can be acknowledged again with
a new request ID and the observed closed aux; no browser operation repeats.

One storage commit changes only the old work lease's phase to `degraded`, closes
aux and ledger, stores the ACK, and closes an existing standalone generation or
records `manualControlCleanupClosures[id]`. The latter preserves the old manual
record shape and prevents any further Parser/work start using that generation.
The exact validated closed cleanup ledger independently consumes the same manual
generation ID if that secondary index is absent or empty; a new ID remains eligible.
Old heartbeat/expires are preserved. A closed record is never a work permit.

`pause:true` describes safe preservation/ownership of pauses, not release of the
separate AutoBuy cleanup fence. The Node completion order is: durable proof and
FS claim close, Parser atomic finish, exact AutoBuy fence release using this
closed receipt, then ordinary new-generation admission. An old work budget or
token is never reset by cleanup.

For the AutoBuy extension only (`ppcgaihnphmgololipboonimikclclgc`), existing
cross-extension IPC accepts the read-only request:

```js
{action:'nightCabinetCleanupAuthorityV1',scopeId,attemptId,targetSha}
// Reply, read under the same writer:
{action:'nightCabinetCleanupAuthorityV1',protocolVersion:1,known:true,
 state:'active',scopeId,attemptId,targetSha,now,createdAt,deadlineAt,owner,auxSha,receipt:null}
```

States are `active`, `expired`, `closed` or `unknown` (`known:false`). Active
requires unchanged raw old lease and exact scope/record/ledger. `closed` retains
the immutable receipt even if a successor work lease exists; it authorizes only
metadata/fence settlement. `auxSha` changes at closure, while attempt identity
and deadline do not. Unauthorized senders or extra authority fields cannot
request mutations through this IPC; no account, order, URL or file contents are
returned. Consumers account conservatively for response latency.

An active/expired retry also returns `previous` from the validated ledger chain:
`{scopeId,attemptId,targetSha,owner,createdAt,deadlineAt,auxSha,processesGone:true,proofSha}`.
It names precisely the prior abandoned attempt and its original open-aux hash;
the proof is the trusted Node death attestation already checked on retry admission.
First attempts and closed records return `previous:null`. AutoBuy may transfer
an expired held fence only if every previous identity/time field matches it and
this fresh retry is active. A matching target or an expired deadline alone is
insufficient. This read-only addition grants no work time and changes no ledger.

Only missing cleanup keys mean that no cleanup history exists. Persisted `null`
in either the auxiliary pointer or its ledger is malformed and blocks normal
lease transitions and direct Parser starts, including cached prior success.
Direct starts retain that refusal when canonical scope is absent/null; a persisted null manual-closure ledger also remains malformed and cannot reopen a closed generation or be replaced on finish.

A started manual coordinator recovery may name the exact `coordinatorRunId` only
as `dead-store-walk` with a valid report hash and raw lease phase `recover` or
`store-main` (the coordinator's current RECOVER mapping), never `store-catchup`.
Node must still prove the typed recovery report, both dead roots, and complete
process groups. The separate `unstarted-store-walk` no-work target remains valid.
