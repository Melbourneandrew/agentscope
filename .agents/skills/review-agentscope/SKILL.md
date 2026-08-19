---
name: review-agentscope
description: Use for independent reviews of Agentscope code, pull requests, architecture, trust boundaries, tests, evidence, release readiness, or implementation plans. Applies the repository's requirements and Blueprints as binding decisions, runs adversarial and built-artifact checks, and records reusable review lessons back into this skill.
---

# Review Agentscope

Review an exact, quiescent change against the user-facing requirements, the approved architecture, and the executable repository boundaries. Produce evidence-backed findings, not speculative redesign.

## Non-negotiable Blueprint gate

Blueprint decisions are binding on implementation reviews.

- Read every Blueprint and requirement governing the changed capability before judging the implementation.
- Treat implementation divergence from an approved Blueprint as a merge-blocking P1 even when the implementation seems preferable.
- Do not rewrite a Blueprint inside an implementation PR to make the implementation appear conformant.
- Permit an architectural exception only when a compelling reason was approved and merged in an earlier, standalone Blueprint-only PR. Record that PR and review the implementation against the newly merged decision.
- If the architecture should change and no prior standalone Blueprint-only PR exists, stop that implementation path. Require the Blueprint-only decision PR first, then rebase or revise the implementation in a later PR.
- Do not waive a requirements conflict through a Blueprint. Requirements remain the external source of truth and must be reconciled separately through the Software Factory process.

## Review workflow

1. Establish scope and authority.
   - State that this is an authorized defensive review of the repository and named change.
   - Resolve the exact base and head commits. Require a clean or understood worktree and pause if the target changes during review.
   - Classify the review as Blueprint-only, implementation, whole-PR, bounded delta, or release certification.
2. Load sources of truth.
   - Read the applicable FRDs, acceptance criteria, Blueprints, package policies, and task or PR description.
   - Build a compact decision inventory: mandatory behavior, forbidden behavior, authority owner, persistence boundary, and claimed evidence.
3. Inventory the delta.
   - Inspect every changed file and adjacent production boundary, not only the named function.
   - Identify public exports, persisted formats, trust transitions, irreversible operations, deadlines, concurrency, and generated artifacts affected by the change.
4. Run focused review passes.
   - Always read [architecture-blueprints.md](references/architecture-blueprints.md).
   - Select the relevant system checklists from [review-map.md](references/review-map.md).
   - Read [review-language.md](references/review-language.md) before writing findings that use security-sensitive terms.
5. Prove or dismiss risks.
   - Prefer a minimal source-level or built-dist reproduction over a hypothetical claim.
   - Exercise the exact hostile boundary: accessors, proxies, aliases, mutation timing, crash prefixes, path identity, cancellation, stale artifacts, malformed DTOs, or cross-process interleavings as applicable.
   - Preserve the user's worktree. Do not edit during an independent read-only review.
6. Verify gates in proportion to the claim.
   - Run focused lint, typecheck, tests, exact coverage, builds, artifact checks, and policy checks.
   - For release certification, require the repository's full validation, exact-head CI, and all required independent reviews.
7. Report decisively.
   - Use the severity and finding format in [release-practice.md](references/release-practice.md).
   - Say `CLEAN` only for the exact reviewed commit when no material finding remains and the stated gates are green.
   - Distinguish source inspection, local reproduction, built-artifact reproduction, CI evidence, and inference.
8. Evolve this skill.
   - When a review reveals a reusable class of defect, create or update a durable task for the generalized lesson.
   - Add the smallest non-duplicative checklist rule and, when useful, a deterministic validation or adversarial seed.
   - Commit the skill update through its own reviewable PR or a clearly scoped follow-up; never leave durable review knowledge only in a PR comment.
   - Run this skill's validator and skill-creator `quick_validate.py` after every change.

## Reference routing

- System area and required checklist selection: [review-map.md](references/review-map.md)
- Requirements, ADRs, exceptions, and architectural truthfulness: [architecture-blueprints.md](references/architecture-blueprints.md)
- Brands, credentials, privacy, hostile DTOs, origins, and diagnostic disclosure: [trust-data-privacy.md](references/trust-data-privacy.md)
- Deadlines, cancellation, locks, crash recovery, filesystem identity, and irreversible mutation: [lifecycle-recovery-concurrency.md](references/lifecycle-recovery-concurrency.md)
- Dependencies, exports, package authority, generated output, and built artifacts: [api-package-artifacts.md](references/api-package-artifacts.md)
- Contract suites, negative matrices, acceptance evidence, coverage, and end-to-end claims: [testing-evidence-acceptance.md](references/testing-evidence-acceptance.md)
- Exact-head procedure, severity, findings, rerereviews, and certification: [release-practice.md](references/release-practice.md)
- Defensive vocabulary and content-free evidence: [review-language.md](references/review-language.md)

## Required validation

Run both commands from the repository root:

```bash
python3 .agents/skills/review-agentscope/scripts/validate_review_skill.py
python3 "$CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py" .agents/skills/review-agentscope
```

If `$CODEX_HOME` is unavailable, resolve the installed skill-creator location without modifying repository state.
