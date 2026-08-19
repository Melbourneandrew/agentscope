# Trust, data, and privacy boundaries

## Authority and reconstruction

- Require runtime brand checks immediately before privileged invocation; TypeScript types are not authority.
- Snapshot hostile caller inputs once through exact own data descriptors. Reject accessors, proxies, sparse arrays, extra keys, symbol keys, aliases, cycles, and mutable authority graphs.
- Never validate one object and then reread caller-owned state for use. Preserve a single validated, frozen reconstruction.
- Keep authority mints on restricted internal subpaths. Concrete adapters receive bounded capabilities, not constructors for privileged transports, brands, deadlines, or finalizers.
- Reject clones, JSON round trips, spreads, forged values, second-package brands, and stale persisted DTOs wherever a live in-process brand is required.

## Secrets and destinations

- Validate configuration and canonical remote origin before resolving credential slots.
- Bind credentials to the exact endpoint capability, not merely a host or origin when path or tenant identity matters.
- Forbid userinfo, unsupported schemes, unsafe redirects, and non-loopback insecure HTTP.
- Prevent ambient network use when Core-owned transport is the architectural boundary.
- Keep credentials out of settings, defaults, identities, receipts, errors, diagnostics, fixtures, snapshots, and logs.
- Collapse thrown provider bodies and secret-bearing errors to closed content-free codes.

## Privacy and diagnostics

- Confirm every semantic terminal follows its governed privacy route before serialization or persistence.
- Validate compound semantics before redaction so policy cannot launder contradictory source assertions; validate again afterward for atomic completeness.
- Scan paths, URIs, decoded secrets, nested structured content, metadata, names, labels, and status messages where the semantic profile classifies them as sensitive.
- Never include inspected content, credential values, paths, provider messages, or arbitrary thrown strings in findings, diagnostics, fingerprints, or snapshots.
- Pre-brand lifecycle diagnostics must be a separately governed, fixed-enum, content-free record.

## Hostile callback and schema seams

- Treat first-party callbacks as trusted code but hostile operationally: catch sync throws, rejected promises, unexpected thenables, mutation, and late settlement without leaking content.
- Do not retain caller-mutable schemas or validators as runtime authority.
- If a schema is compiled through another representation, prove semantic round-trip closure; reject callbacks, refinements, metadata, emitter overrides, mutable caches, accessors, and unrepresented checks.
- Bound identifiers, strings, arrays, objects, headers, nested JSON, and aggregate work before expensive parsing or scanning.
