# Testing, evidence, and acceptance

## Contract and oracle integrity

- A reusable suite must own or validate its canonical scenario oracle. Do not let an adapter author supply labels, expected IDs, cursors, and outcomes that make a vacuous implementation pass.
- Cover every advertised filter, conjunction, ordering, pagination, continuation, partial-result, limit, identity, and malformed-response behavior.
- Include a deliberately nonconforming adapter and prove the suite rejects it with a stable code.
- Bind scenario matrices to exact connection, destination type, configuration identity, query fingerprint, locator, and fixture authority.
- Keep fixtures sanitized and out of private cross-package source paths.

## Negative and adversarial matrix

- Test valid edges as well as missing, duplicate, extra, malformed, sparse, oversized, noncanonical, stale, forged, and cross-boundary values.
- Exercise stateful getters, proxies, custom iterators, prototype mutation, callback reentrancy, aliasing, and time-of-check/time-of-use splits.
- For lifecycle code, test every durable crash prefix, transition interleaving, cancellation point, late settlement, and never-settling operation.
- For filesystem code, test lexical, physical, symlink, case, Unicode normalization and casefold, mode, umask, and artifact-role aliases on the supported platform matrix.
- Add built-dist regressions when source or bundle identity, export maps, brands, or emitted artifacts are part of the contract.

## Coverage and gates

- Exact 100% coverage is necessary but not sufficient; verify that assertions prove behavior rather than merely execute branches.
- Scope coverage exclusions narrowly to truly unreachable platform or compiler defenses and retain real behavioral tests on the required matrix.
- Run focused lint, typecheck, tests, coverage, build, and artifact verification before the whole repository gate.
- Distinguish a flaky timing gate from a semantic failure through exact-log inspection and isolated replay; do not silently ignore either.

## Acceptance evidence

- Promote an `AC-*` only when evidence proves the criterion at the layer named by the requirement.
- Component tests do not verify a user-facing CLI command, presentation escaping, exit behavior, or real destination or harness integration.
- Keep evidence planned or explicitly component-only until the end-to-end path exists.
- Evidence paths, case names, and digests must bind to real executable artifacts rather than digest-shaped placeholders or comments.
- Revalidate evidence after squashing, migration, fixture, or generated-artifact changes.
