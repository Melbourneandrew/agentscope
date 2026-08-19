# API, package, and artifact boundaries

## Dependency direction

- Confirm packages depend only on approved lower-level contracts; Protocol must not depend on Core or concrete adapters.
- Keep provider, CLI, harness, configuration-document, and diagnostic-store DTOs out of generic family contracts.
- Use one canonical identity type and one registry authority; avoid parallel dispatch or naming authorities.
- Reject deep `src` imports and cross-package private fixtures.

## Export surfaces

- Review source exports, `package.json` export maps, declaration output, runtime output, and bundled output separately.
- Keep testing helpers on explicit test-only subpaths and prohibit them from production modules, including dynamic and escaped module specifiers.
- Keep privileged finalizers, transport binders, orchestration constructors, and brand mints on restricted Core-only subpaths.
- Remove obsolete errors, provisional sinks, compatibility shims, and implementation helpers when their owning public seam is removed.
- Treat exported test-only or authority-bearing symbols as API even if no current consumer imports them.

## Build and artifact closure

- Test from a clean checkout without warm ignored `dist` or Nx cache masking dependency order.
- Ensure lint, test, and coverage build required upstream packages or resolve workspace sources intentionally.
- Clean output safely before emit and verify an exact source-to-artifact file bijection.
- Reject compiled tests, stale renamed modules, symlinks, unexpected regular files, and private source trees in production artifacts.
- Verify direct built-dist and bundled interop use one Protocol registry and brand instance.
- Inspect the packed CLI, not only workspace execution, for dependency and export leakage.

## Compatibility and persistence

- Bind persisted readers to exact envelope and manifest identities, not numeric version alone.
- Archive real previous production artifacts byte-for-byte before evolving a format.
- Dispatch through one authority and migrate only adjacent supported generations.
- Preserve identifiers only when the governing identity profile proves equality.
