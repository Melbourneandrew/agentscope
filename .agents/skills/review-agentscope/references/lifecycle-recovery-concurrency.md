# Lifecycle, recovery, and concurrency

## Deadlines and cancellation

- Create the hard absolute deadline at process or command entry before configuration, Git, filesystem, credential, or adapter work.
- Later configured deadlines may shorten but never extend the original authority.
- Pass one monotonic deadline through fan-out; do not restart a full timeout for sequential substeps.
- Distinguish pre-invocation definite noncommit from post-invocation outcome uncertainty.
- Request cooperative cancellation and prevent new work at expiry, but do not claim an uncooperative operation stopped unless it is isolated and joined.
- Observe late resolutions and rejections; leave no event-loop-retaining timer, child, worker, file request, lock, or detached write after return.
- Durable diagnostic writes must not become work that violates the hook deadline.

## Cross-process state

- In-process serialization is not sufficient for hooks running in separate processes.
- Require fenced compare-and-swap, stable double-checked claims, or independently atomic records for shared state.
- Audit every transition interleaving, especially fixed-name to recovery-claim handoffs.
- A recovery claim must have one closed classification and an actionable reconciliation path.
- Irreversible deletion requires a final, fenced proof that no active or backup authority references the object.

## Crash and mutation prefixes

- Enumerate every durable prefix around prepare, claim, marker, commit, cleanup, and recovery.
- At each prefix, prove exactly one safe action: resume, roll back, clean up, reconcile, or fail closed without mutation.
- Authenticate bytes, modes, identities, and ownership before rename, restore, delete, or credential removal.
- Verify the final state after irreversible mutation; do not discover corruption only after overwriting the valid preimage.
- Ensure cancellation of a prepared operation removes only its own artifacts and never mutates a target.

## Filesystem identity and artifacts

- Compare physical filesystem identity, not only lexical absolute strings.
- Resolve existing ancestors, reject final symlinks when required, and close `..`, symlink-parent, case, Unicode normalization, and platform caseless aliases.
- Derive every target, stage, backup, temporary, candidate, marker, claim, and manifest namespace from the same platform identity.
- Reject collisions across all roles, including cross-target artifact aliases, before creating or deleting anything.
- Treat process umask, file mode, flush, directory sync, rename, cleanup, and stale artifact behavior as part of the transaction contract.

## Checkpoints and replay

- Bind checkpoint lookup to one exact source, configuration, and destination identity snapshot.
- Define exclusive boundaries, generation continuity, gap or overlap behavior, source loss, expiry, corruption, and restart policy.
- Advance only the highest contiguous definitely accepted boundary; partial or uncertain delivery does not advance.
- Revoke one-shot checkpoint callbacks immediately after the capture stage.
- Preserve explicit source-loss evidence even when persistence or delivery succeeds or fails later.
