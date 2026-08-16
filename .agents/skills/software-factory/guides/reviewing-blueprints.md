# Reviewing Blueprints

Use this guide to review one or more Blueprints against the Blueprint Writing Guide. Treat it as the source of truth for review scope, calibration, and the iterative review loop.

## Prepare

1. Read `blueprint-writing-guide.md` and the requirements linked by the target Blueprint.
2. Establish scope. If unspecified, ask whether to review the current Blueprint, all Blueprints changed in the current work, or all project Blueprints.
3. Read every target Blueprint, its referenced Blueprints, and existing open/resolved comments. Do not repeat an already-addressed issue.
4. Build a small dependency map: ownership, sources of truth, lifecycle boundaries, and external integrations. Use it to examine connective tissue, not to expand scope without cause.

## What a material finding is

Create a comment only when it identifies a load-bearing ambiguity or contradiction likely to block implementation, cause incorrect behavior, cause security/privacy/reliability harm, or create expensive rework. Favor evidence and a concrete decision question or simpler alternative.

Review for:

- contradicting ownership, lifecycle, identifiers, configuration precedence, or failure semantics;
- missing source of truth, migration/rollback boundary, trust boundary, or compatibility decision;
- undefined cross-Blueprint references or duplicated decisions that will drift;
- a proposed abstraction, option, integration, or configuration surface that does not earn its complexity;
- an overlooked existing system, open standard, or reusable project capability;
- inadequate verification for a consequential decision, especially installer, hook, credential, redaction, delivery, or recovery behavior.

Do not flag illustrative code syntax, minor wording, formatting, speculative edge cases without material impact, or requests for infinite detail. Blueprints are ADRs, not implementation inventories.

## Thermonuclear review loop

Use independent subagents for the review rounds when available. Give each reviewer only the raw Blueprint scope, linked requirements/Blueprints, and the review task; do not give it prior verdicts, intended fixes, or another reviewer's conclusions. This independence is essential.

Run **five rounds by default** and never exceed **eight** without user direction:

1. **Structural pass:** ADR quality, ownership, source of truth, contradictions, and undefined references.
2. **Failure and lifecycle pass:** initialization, partial failure, retries, idempotency, rollback, migration, compatibility, and recovery.
3. **Boundary pass:** trust/secrets, privacy/redaction, package/plugin boundaries, external standards, and versioning.
4. **Operability pass:** configuration, installation, diagnostics, observability, support, and verification strategy.
5. **Adversarial integration pass:** cross-Blueprint composition, simplification, reuse, and the strongest remaining decision questions.

For each round:

1. Ask the subagent to produce only material findings, with evidence, impact, and a decision-oriented recommendation.
2. Create one structured comment per accepted finding on the specific Blueprint/section. A comment must include severity, evidence, impact, and the decision needed. If the review surface has no native comments, use the platform's inline review/comment mechanism rather than an untracked TODO file.
3. Address every accepted comment in the Blueprint, related requirement, or an explicit decision record. Resolve the comment only after the change is made or the user makes the decision.
4. Re-read the modified records and give the next independent reviewer the updated raw artifacts.

Stop before round five only when **two consecutive independent rounds find no material issues**. Stop at round five when the fifth reviewer finds no material issue after prior findings are resolved. Continue through round eight only if a round exposes a new cross-cutting concern; stop immediately once a subsequent independent pass finds no new material finding. At the cap, report unresolved questions rather than inventing a ninth pass.

## Comment format

```text
Severity: blocker | important | advisory
Evidence: [specific Blueprint section and conflicting/missing context]
Impact: [implementation, safety, operability, or rework consequence]
Decision needed: [one concrete question or simpler alternative]
```

## Completion report

Report the Blueprints reviewed, rounds run, comments created/resolved, any unresolved decision points, and the saturation reason. A zero-finding result is valid only after an independent review explains why the load-bearing boundaries are coherent.
