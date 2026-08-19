# Architecture and Blueprint conformance

## Authority order

1. Product and Feature Requirements define externally required behavior.
2. Approved Blueprints define durable internal decisions that satisfy those requirements.
3. Implementation, tests, PR descriptions, and acceptance evidence must conform to both.
4. Comments and current code do not silently supersede an approved decision.

## Review checklist

- Locate every affected `REQ-*` and mandatory `AC-*`; distinguish user acceptance from component evidence.
- Read the complete governing Blueprint, including consequences and cross-referenced ADRs.
- Check that ownership, trust, failure, persistence, versioning, and compatibility decisions are implemented exactly.
- Flag documentation that overstates an upstream standard, a MUST, or current system capability.
- Reject implementation-specific API inventories disguised as Blueprint decisions; retain decision-first architecture records.
- Check terminology consistency across FRDs, Blueprints, code, diagnostics, packages, and PR text.
- Verify migrations, compatibility windows, and historical artifacts match real prior production state rather than a reconstructed approximation.
- Treat simultaneous behavioral implementation and architectural justification as an invalid exception path.

## Standalone exception protocol

An implementation may depart from an older Blueprint only when all of the following are true:

1. A compelling architectural reason is documented against the requirements.
2. A standalone Blueprint-only PR contains no implementation behavior change.
3. That PR receives the required architecture review and merges first.
4. The implementation PR is rebased onto the merged decision.
5. The implementation is reviewed against the new Blueprint, not against discussion drafts.

If any step is absent, report the divergence as P1 and require the decision sequence to be corrected.

A requirements conflict cannot be waived by an architectural exception; reconcile it through a separate Software Factory requirements change.

Use the project `software-factory` skill when proposing or reviewing changes to requirements or Blueprints.
