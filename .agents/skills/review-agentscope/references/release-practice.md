# Review and release practice

## Severity

- **P0 — critical:** immediate catastrophic data loss, credential disclosure, arbitrary authority, or an unrecoverable release-wide failure.
- **P1 — blocker:** merge-blocking correctness, security, privacy, architecture, persistence, compatibility, acceptance, or required-gate defect.
- **P2 — advisory:** real maintainability, documentation, API hygiene, or diagnostic truthfulness issue that does not block the stated release contract.

Do not inflate severity because a finding uses security vocabulary. Classify by demonstrated impact and governing contract.

## Finding format

Each finding must contain:

1. Severity and a specific claim.
2. Exact source, artifact, ADR, requirement, or workflow evidence.
3. Minimal reproduction or a clearly labeled inference.
4. Concrete impact at the user, authority, data, lifecycle, or release boundary.
5. Required decision or invariant, without prescribing unnecessary implementation detail.
6. Gate state and anything not independently verified.

Keep diagnostics and reproductions content-free. Use synthetic canaries and never repeat secrets, provider bodies, user paths, or captured trace content.

## Exact-head discipline

- Record base and head commits in every whole-PR or release review.
- If the tree changes, discard mixed results and restart the affected pass.
- A later mechanical commit invalidates exact-head certification; perform a bounded delta rereview.
- Resolve review threads only after the finding is fixed and independently replayed.
- Review PR body claims and validation counts as release evidence.

## CLEAN certification

Say `CLEAN` only when:

- no material P0, P1, or P2 remains in the stated scope;
- governing requirements and Blueprints conform;
- focused gates pass;
- required whole-repository, clean-checkout, CI, artifact, and platform gates pass or are explicitly outside the bounded review;
- the exact reviewed commit is unchanged;
- prior findings have been replayed, not merely inspected optimistically.

For a bounded review, state what was not reviewed. For a release review, include all required checks and independent review state.
