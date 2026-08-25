# Testing, evidence, and acceptance

## Contract and oracle integrity

- A reusable suite must own or validate its canonical scenario oracle. Do not let an adapter author supply labels, expected IDs, cursors, and outcomes that make a vacuous implementation pass.
- Cover every advertised filter, conjunction, ordering, pagination, continuation, partial-result, limit, identity, and malformed-response behavior.
- Include a deliberately nonconforming adapter and prove the suite rejects it with a stable code.
- Bind scenario matrices to exact connection, destination type, configuration identity, query fingerprint, locator, and fixture authority.
- Keep fixtures sanitized and out of private cross-package source paths.

## Plan-bound mutation evidence

- For every plan-first command, require a distinct versioned plan envelope bound to the exact operation, target, and one-use mutation authority, plus every identity required by the governing requirement or Blueprint, such as configuration generation, capability fingerprint, or inventory or intent identity.
- Prove the complete plan envelope is emitted and fully flushed on every promised output channel before apply consumes the authority; call ordering or a buffered write is not completion evidence.
- Require apply to consume only the one-use authority bound to the fully displayed plan projection and revalidate every bound identity immediately before mutation. Substitution, replay, missing intent, output failure, and partial output must fail without mutation.

## Production composition and acceptance scope

- Inventory the real production registry, persisted configuration store, runtime dispatch, and packed composition. Require one canonical destination identity and every descriptor, configuration, or capability identity defined by the governing contract, including a fingerprint only where that contract defines one; reject parallel registries or test-only composition as acceptance authority.
- Do not promote an `AC-*` from component evidence while the ordinary production entry point is empty, uninitialized, unreachable, or wired to a different adapter. Require causal built or packed evidence through that entry point for the claimed user layer.
- For every advertised provider profile and portable predicate, require exact positive and miss wire fixtures, reject nonconforming selector or query shapes, and derive projected responses from documented wire attributes rather than sequential canned responses.
- Bind projection grammar, collision behavior, row and byte ceilings, and advertised predicates into the governed manifest fingerprint. Keep evidence DTOs behind a restricted testing boundary.

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
