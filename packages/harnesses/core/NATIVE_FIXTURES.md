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
- Record the exact fixture-producing recipe and the reviewed vendor license
  source. A fixture is admitted only when redistribution is reviewed for the
  repository.

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

## Compatibility representative linkage

The fixture records the exact representative version, scenario ID, and evidence
slot. Harness Core requires those values to match the contract scenario and
compatibility evidence. `deriveHarnessContractEvidenceDigests` binds the whole
fixture and scenario, so changing a representative requires regenerating both
unit-contract and real-scenario evidence together. A fixture cannot broaden a
descriptor compatibility range or create a release support claim.

## Automated enforcement

`auditNativeFixtureInventory` rejects noncanonical JSON, unexpected file kinds,
oversized files, path/identity mismatches, malformed governance, secret-shaped
content, user paths, raw transcript or terminal fields, and prose-shaped payload
values. Harness Core's unit suite runs this inventory audit on every repository
validation. The post-adapter inventory certification remains responsible for
proving that every implemented native mapping is represented.

Synthetic unresolved fixtures are component-only and cannot establish
actual-binary, compatibility-catalog, or release admission. Every admission
consumer must call `assertNativeFixtureAdmissionProvenance`; it fails closed
unless the fixture came from disposable-hermetic capture and carries
authenticated artifact authority. `deriveHarnessContractEvidenceDigests` binds
component evidence only and does not confer release or actual-binary authority.
