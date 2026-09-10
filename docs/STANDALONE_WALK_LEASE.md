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
