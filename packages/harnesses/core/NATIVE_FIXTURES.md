# Native harness fixture governance

Native fixtures are test inputs, not acceptance evidence. Harness Core owns the
schema and scanner; each concrete harness package owns its fixture files under:

```text
packages/harnesses/<harness-id>/fixtures/native/<fixture-id>.json
```

Every file uses `fixtureVersion: 1`, canonical JSON from
`serializeHarnessSanitizedFixture`, and metadata accepted by
`parseHarnessSanitizedFixture`.

## Capture and provenance

- Use `captureKind: synthetic` for authored synthetic records. Its source is an
  `urn:agentscope:synthetic:*` identifier.
- Use `captureKind: disposable-hermetic` only when the source was observed in a
  disposable hermetic scenario with dummy credentials, internal model mocks,
  denied public egress, and no paid model request. Never capture on a developer
  host.
- A synthetic component fixture records `artifactAuthority.status: unresolved`
  with the closed reason `independent-integrity-unavailable`. Never insert a
  placeholder or locally computed artifact hash.
- A disposable-hermetic fixture requires authenticated `artifactAuthority`
  and a digest from independently obtained, version-bound
  integrity metadata. That digest identifies the harness artifact; it is never a
  digest of a prompt, transcript, terminal stream, or private native content.
- Record the exact fixture-producing recipe, one reviewed license identifier or
  `LicenseRef-*`, and the reviewed vendor license source. Compound SPDX
  expressions are deliberately outside this component schema. A fixture is
  retained only when redistribution is reviewed for the repository.

## Sanitization and review

Raw prompts, responses, transcripts, terminal output, credentials, user paths,
and complete native record bodies never leave the disposable scenario. The
checked-in payload contains only bounded categorical identifiers, booleans, and
safe integers needed by the mapping oracle. Do not replace removed content with
realistic user prose.

The redaction metadata attests all mandatory removed categories. Two distinct
review references and an approval date are required. Reviewers inspect both the
canonical file and its provenance/license record; scanner success does not
replace human privacy and redistribution review.

## Component representative linkage

The fixture records the exact representative version, scenario ID, and evidence
slot. Harness Core requires those values to match the component contract
scenario. `deriveHarnessComponentEvidenceDigest` binds the whole
fixture, scenario, complete harness descriptor/executable contract, and the
separate bounded mapping-artifact and adapter-context checksums. The evidence
schema is versioned and uses the structurally separate
`component-sha256-*` namespace. It does not contain `realScenarioDigest`, cannot
populate `HarnessSupportEvidenceManifest`, and cannot compile a production
compatibility-registry row. A fixture cannot broaden a descriptor compatibility
range or create an actual-binary or release support claim. The component suite
still requires the representative version to fall inside one descriptor
compatibility row, and that exact row must own the fixture's component evidence
slot.

## Automated enforcement

`auditNativeFixtureInventory` rejects noncanonical JSON, unexpected file kinds,
oversized files, path/identity mismatches, malformed governance, secret-shaped
content, user paths, raw transcript or terminal fields, and prose-shaped payload
values. It rejects symlinked lexical ancestry, then retains an inode-pinned root
directory capability for the complete traversal; replacement of the caller's
path cannot redirect the scan. Package, fixture, and native-directory traversal
does not follow symlinks, and every file is read through one identity-stable
no-follow handle. The fixed scanner child accepts at most 256 files, 64 KiB per
file, and 3 MiB decoded in aggregate. Root and native-directory entries are read
through a buffer-one directory stream and rejected on the 257th entry before
sorting or materialization can grow further. The 3 MiB ceiling base64-encodes to
4 MiB, and retained relative paths are capped at 140 KiB in aggregate. Even at
JSON's worst six-byte escaping expansion, those paths consume at most 840 KiB;
the fixed 256-record envelope consumes less than 16 KiB. The complete maximum
valid snapshot is therefore below the parent's 5 MiB output ceiling.

One monotonic 10-second work authority begins as the audit API's first action.
It covers path resolution, test-plan parsing, ancestry authentication, worker
execution, and every bounded parent-side path, decoding, secret-scan, JSON,
fixture, canonicalization, digest, and sorting phase through the final success
return. Authority is checked before and after every awaited or bounded phase;
expiry stops ordinary work with a content-free failure. Worker work is aborted
at 9 seconds so the final second initiates forced termination and join. The
worker must emit the complete terminal frame and then close with code zero and
no signal. No success or failure returns before direct-child close is confirmed;
if the runtime delays close after forced termination, the join invariant—not a
wall-clock shortcut—governs return. Root restoration and worker cleanup remain
mandatory and may outlast the work authority. Expiry is checked again
immediately before spawn, so an expired audit starts no child work. The optional audit test plan is
a bounded, serialized JSON primitive decoded into closed plain data. Passing an
object, proxy, callback, thenable, oversized value, or malformed JSON cannot
execute caller properties or callbacks inside the authority. A genuine native
Promise is rejected as invalid while module-initialization captures of the
Promise, apply, native-Promise, and Proxy-classification intrinsics attach a
content-free rejection sink without dynamic method lookup. The same sink
recognizes native Promises across realms and prevents a separate
unhandled-rejection channel. A valid plan selects only fixed internal race,
termination, or worker-failure operations; it accepts no caller paths. Root
mutation requires a physical direct test root and uses only paths derived inside
a fresh mode-0700 namespace created atomically beneath the physical temporary
root. Fixed-operation failure regressions prove that a held root is restored
before the owned namespace is removed. Malformed plans and internal plan
failures collapse to one content-free diagnostic. Harness Core's unit suite runs
this inventory audit on every repository validation. The post-adapter inventory
certification remains responsible for proving that every implemented native
mapping is represented.

All fixtures governed here are component-only, including fixtures whose capture
metadata records a disposable-hermetic source. Actual-binary, compatibility
catalog, and release admission are intentionally absent from this API. A
separate runner/preparation owner must authenticate external artifact authority,
bind the real scenario, and emit production support evidence; component fixture
metadata is never that authority. This production boundary is owned by
`agentscope-c1k.11`.
