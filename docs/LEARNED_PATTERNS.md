# Learned patterns

## Manifest V3 workflows

- A persisted intent is not proof that a side effect happened. Store `prepared` and `dispatched` separately, then resume the exact prepared operation after restart.
- Every awaited storage, tab or network call is an ownership boundary. Reread run, stage, account and tab identity immediately before the next write or navigation.
- Completion and timeout need one arbiter. Late content from an old attempt must be unable to overwrite the new cursor or turn a timeout into a false success.

## Account-bound work

- Never move a screenshot/tracking item across account switches unless the item contains exact account ownership and the browser has re-entered that account.
- Do not remove a queue head until external delivery is confirmed. Persist every merge and the final empty queue.
- Final return to the primary account is part of stage completion, not best-effort cleanup.
- Completion and watchdog paths may fire together. Account dispatch and whole final-return flows must be single-flight.

## Honest completion

- A run is green only when the exact expected roster equals the completed roster and there are no failures.
- Sheet export must use rows from the same run/account/time window and must stamp success only after the physical transaction completes.
- A durable retry marker and an in-memory transaction lock solve different problems: restart recovery and same-worker concurrency.
- Advance a durable cursor only in the same commit that records the exact pending navigation; any deliberate delay belongs after that commit.
- Nested time budgets need one invariant test: all per-account ceilings plus switching/finalization must fit inside the shop-stage ceiling.
- A notification is deduplicated only after every external message part is acknowledged; failed or partial delivery must remain retryable.
