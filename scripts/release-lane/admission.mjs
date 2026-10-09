import { createHash } from "node:crypto";
import { types } from "node:util";
import { deriveIdentityBundle } from "@agentscope/protocol";
import { canonicalJson, sha256 } from "./validation.mjs";

const reject = () => {
  throw new Error("release.admission.evidence");
};
const byteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
).get;

function boundedDocument(value, depth = 0, count = { value: 0 }) {
  if (++count.value > 8192 || depth > 16) reject();
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value))
      boundedDocument(entry, depth + 1, count);
  }
  return value;
}
function keys(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expected].sort())
  )
    reject();
}

function preparedEvidence(value) {
  keys(value, [
    "evidenceVersion",
    "bundleIdentity",
    "candidateRevision",
    "platform",
    "lockfile",
    "artifacts",
    "scenarioNetworkPolicy",
  ]);
  keys(value.platform, ["os", "architecture", "nodeVersion"]);
  if (
    !Array.isArray(value.artifacts) ||
    value.artifacts.length < 1 ||
    value.artifacts.length > 32
  )
    reject();
  if (
    ![value.platform.os, value.platform.architecture].every(
      (part) => typeof part === "string" && /^[a-z0-9-]{1,32}$/u.test(part),
    ) ||
    !/^\d+\.\d+\.\d+$/u.test(value.platform.nodeVersion) ||
    !/^[a-f0-9]{40,64}$/u.test(value.candidateRevision)
  )
    reject();
  const files = [value.lockfile, ...value.artifacts];
  for (const file of files) {
    keys(
      file,
      file === value.lockfile
        ? ["fileName", "bytes", "sha256"]
        : ["id", "kind", "fileName", "bytes", "sha256"],
    );
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u.test(file.fileName) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 268_435_456 ||
      !/^sha256-[a-f0-9]{64}$/u.test(file.sha256)
    )
      reject();
    if (
      file !== value.lockfile &&
      (!/^[a-z][a-z0-9-]{0,63}$/u.test(file.id) ||
        !["npm-tarball", "runtime-archive", "runtime-binary"].includes(
          file.kind,
        ))
    )
      reject();
  }
  if (
    value.lockfile.fileName !== "pnpm-lock.yaml" ||
    new Set(files.map((file) => file.fileName)).size !== files.length ||
    new Set(value.artifacts.map((file) => file.id)).size !==
      value.artifacts.length
  )
    reject();
}

// Parse owned byte snapshots, not caller-selected object getters or labels.
export function parseAdmissionDocument(bytes) {
  if (
    types.isProxy(bytes) ||
    !Buffer.isBuffer(bytes) ||
    byteLength.call(bytes) > 1_048_576
  )
    reject();
  try {
    return boundedDocument(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    return reject();
  }
}

// Inert projection of an operator attestation, not server authentication or
// release permission. The existing owner checkpoint must authenticate its
// submitter and bind this exact string to the phase, candidate and chain head.
// Keep the array inside the encoded string; recorder DTOs remain array-free.
export function projectOperatorControlsReport(encoded, expiresAt, observedAt) {
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 4096)
    reject();
  const report = parseAdmissionDocument(Buffer.from(encoded));
  keys(report, [
    "state",
    "repository",
    "ownerId",
    "ownerLogin",
    "inspectedAt",
    "responseCount",
    "responses",
  ]);
  if (
    report.state !== "operator-controls-observed" ||
    report.repository !== "Melbourneandrew/agentscope" ||
    report.ownerId !== 25971425 ||
    report.ownerLogin !== "Melbourneandrew" ||
    report.responseCount !== 8 ||
    !Array.isArray(report.responses) ||
    report.responses.length !== 8
  )
    reject();
  const paths = [
    "/user",
    "/rulesets?per_page=100",
    null,
    null,
    "/immutable-releases",
    "/branches/main/protection",
    "/environments/npm-release",
    "/environments/npm-release/deployment-branch-policies?per_page=100",
  ];
  report.responses.forEach((response, index) => {
    keys(response, ["path", "bytes", "digest"]);
    if (
      typeof response.path !== "string" ||
      (paths[index] === null
        ? !/^\/rulesets\/[1-9][0-9]{0,15}$/u.test(response.path)
        : response.path !== paths[index]) ||
      !Number.isSafeInteger(response.bytes) ||
      response.bytes < 1 ||
      response.bytes > 1_048_576 ||
      typeof response.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(response.digest)
    )
      reject();
  });
  if (report.responses[2].path === report.responses[3].path) reject();
  const times = [report.inspectedAt, expiresAt, observedAt];
  if (
    times.some(
      (time) =>
        typeof time !== "string" ||
        !Number.isFinite(Date.parse(time)) ||
        new Date(Date.parse(time)).toISOString() !== time,
    )
  )
    reject();
  const [inspected, expires, observed] = times.map(Date.parse);
  if (
    expires <= inspected ||
    expires - inspected > 900_000 ||
    observed < inspected ||
    observed > expires
  )
    reject();
  return Object.freeze({
    controlsReportDigest: sha256(Buffer.from(encoded)),
    controlsInspectedAt: report.inspectedAt,
  });
}

// This is artifact binding only. It never promotes the producer's awaiting-
// release-gate disposition, a job conclusion, or a certification label.
export function bindPreparedCliEvidence(evidenceBytes, manifestBytes, tarball) {
  const evidence = parseAdmissionDocument(evidenceBytes);
  const manifest = parseAdmissionDocument(manifestBytes);
  if (types.isProxy(tarball) || !Buffer.isBuffer(tarball)) reject();
  const size = byteLength.call(tarball);
  if (size < 1 || size > 52_428_800) reject();
  if (
    evidence?.evidenceVersion !== 1 ||
    evidence.candidateRevision !== manifest?.sourceRevision ||
    evidence.scenarioNetworkPolicy !==
      "offline-no-package-or-registry-download" ||
    !Array.isArray(evidence.artifacts) ||
    evidence.artifacts.length < 1 ||
    evidence.artifacts.length > 32
  )
    reject();
  preparedEvidence(evidence);
  const { bundleIdentity, ...material } = evidence;
  if (
    sha256(canonicalJson(material)).replace("sha256:", "sha256-") !==
    bundleIdentity
  )
    reject();
  const selected = evidence.artifacts.filter(
    (item) => item?.id === "agentscope-cli",
  );
  const digest = sha256(tarball);
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (
    selected.length !== 1 ||
    selected[0].kind !== "npm-tarball" ||
    selected[0].bytes !== size ||
    selected[0].sha256 !== digest.replace("sha256:", "sha256-") ||
    manifest.tarball?.bytes !== size ||
    manifest.tarball.sha256 !== digest ||
    manifest.tarball.integrity !== integrity
  )
    reject();
  return Object.freeze({
    sourceRevision: evidence.candidateRevision,
    bundleIdentity,
    cliSha256: digest,
    cliIntegrity: integrity,
  });
}

const integrationDigest = (value) =>
  sha256(canonicalJson(value)).replace("sha256:", "sha256-");
const equal = (left, right) => canonicalJson(left) === canonicalJson(right);

// Inputs are bounded server response bytes acquired by the fixed read-only
// entry. Job success authenticates provenance, never native semantics.
export function bindIntegrationArtifacts(
  runBytes,
  jobsBytes,
  artifactsBytes,
  id,
  revision,
) {
  const run = parseAdmissionDocument(runBytes);
  const jobs = parseAdmissionDocument(jobsBytes);
  const artifacts = parseAdmissionDocument(artifactsBytes);
  if (
    !Number.isSafeInteger(id) ||
    id < 1 ||
    typeof revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(revision) ||
    run.id !== id ||
    run.head_sha !== revision ||
    run.repository?.full_name !== "Melbourneandrew/agentscope" ||
    run.head_repository?.full_name !== "Melbourneandrew/agentscope" ||
    run.path !== ".github/workflows/integration.yml" ||
    run.event !== "push" ||
    run.head_branch !== "main" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1
  )
    reject();
  for (const [list, field] of [
    [jobs, "jobs"],
    [artifacts, "artifacts"],
  ])
    if (
      !Array.isArray(list[field]) ||
      list.total_count !== list[field].length ||
      list.total_count > 100
    )
      reject();
  const select = (name, jobName) => {
    const found = artifacts.artifacts.filter((item) => item.name === name);
    const producers = jobs.jobs.filter((job) => job.name === jobName);
    if (found.length !== 1 || producers.length !== 1) reject();
    const artifact = found[0];
    const job = producers[0];
    const times = [
      job.started_at,
      artifact.created_at,
      artifact.updated_at,
      job.completed_at,
    ].map(Date.parse);
    if (
      [
        job.started_at,
        artifact.created_at,
        artifact.updated_at,
        job.completed_at,
      ].some((time) => typeof time !== "string") ||
      job.run_id !== id ||
      (job.run_attempt !== undefined && job.run_attempt !== run.run_attempt) ||
      job.head_sha !== revision ||
      job.status !== "completed" ||
      job.conclusion !== "success" ||
      times.some((time) => !Number.isFinite(time)) ||
      times.some((time, index) => index > 0 && time < times[index - 1]) ||
      artifact.expired !== false ||
      artifact.workflow_run?.id !== id ||
      artifact.workflow_run?.head_sha !== revision ||
      !Number.isSafeInteger(artifact.id) ||
      artifact.id < 1 ||
      !Number.isSafeInteger(artifact.size_in_bytes) ||
      artifact.size_in_bytes < 1 ||
      artifact.size_in_bytes > 268_435_456 ||
      !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest)
    )
      reject();
    return artifact.id;
  };
  return Object.freeze({
    candidateArtifactId: select(
      `integration-candidate-${revision}`,
      "Prepare immutable candidate",
    ),
    scenarioArtifactId: select(
      "integration-0-of-1-1",
      "Hermetic shard 0-of-1 replay 1",
    ),
    runAttempt: run.run_attempt,
  });
}

function codexObservation(observation) {
  keys(observation, [
    "observationVersion",
    "kind",
    "nativeSessionId",
    "nativeTurnId",
    "nativeModelName",
    "modelRequestBodySha256",
    "traceId",
    "canonicalGraphDigest",
    "spanIds",
    "contextDisposition",
    "resourceSpanCount",
    "spanNames",
    "parentLinked",
    "doctorErrors",
    "uninstallDisposition",
    "sessionStartCommandDurationMilliseconds",
  ]);
  if (
    observation.observationVersion !== 1 ||
    observation.kind !== "codex-tui-trace" ||
    [
      observation.nativeSessionId,
      observation.nativeTurnId,
      observation.nativeModelName,
    ].some(
      (part) =>
        typeof part !== "string" || part.length < 1 || part.length > 256,
    ) ||
    !/^[a-f0-9]{64}$/u.test(observation.modelRequestBodySha256) ||
    !/^[a-f0-9]{64}$/u.test(observation.canonicalGraphDigest) ||
    observation.contextDisposition !== "unversioned-workspace-redacted" ||
    observation.resourceSpanCount !== 1 ||
    !equal(observation.spanNames, ["codex.turn", "codex.response"]) ||
    observation.parentLinked !== true ||
    observation.doctorErrors !== 0 ||
    observation.uninstallDisposition !== "committed" ||
    !(
      observation.sessionStartCommandDurationMilliseconds === null ||
      (Number.isFinite(observation.sessionStartCommandDurationMilliseconds) &&
        observation.sessionStartCommandDurationMilliseconds >= 0)
    )
  )
    reject();
  const turn = `codex:${observation.nativeTurnId}`;
  const identity = deriveIdentityBundle({
    harnessRegistryId: "codex",
    operationIdScope: "session-global",
    session: { kind: "boundary-scoped" },
    boundary: {
      kind: "hook-invocation",
      id: turn,
      generation: 0,
      positionKind: "sequence",
      exclusiveEndPosition: 1,
    },
    operations: [
      {
        logicalKey: "codex-turn",
        locator: { kind: "native-operation", nativeId: turn },
      },
      {
        logicalKey: "codex-llm",
        parentLogicalKey: "codex-turn",
        locator: { kind: "native-operation", nativeId: `${turn}:llm` },
      },
    ],
  });
  if (
    observation.traceId !== identity.traceId ||
    !equal(observation.spanIds, [
      identity.spans["codex-turn"],
      identity.spans["codex-llm"],
    ])
  )
    reject();
}

function claudeObservation(value) {
  keys(value, [
    "observationVersion",
    "kind",
    "nativeSessionId",
    "nativeToolUseId",
    "modelRequestBodySha256",
    "doctorErrors",
    "uninstallDisposition",
    "hookObservations",
    ...(Object.hasOwn(value, "nativeModelName") ? ["nativeModelName"] : []),
  ]);
  if (
    value.observationVersion !== 1 ||
    value.kind !== "claude-code-trace" ||
    typeof value.nativeSessionId !== "string" ||
    !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/u.test(
      value.nativeSessionId,
    ) ||
    value.nativeToolUseId !== "toolu_agentscope_claude_read_1" ||
    (Object.hasOwn(value, "nativeModelName") &&
      (typeof value.nativeModelName !== "string" ||
        value.nativeModelName.length < 1 ||
        value.nativeModelName.length > 256)) ||
    !Array.isArray(value.modelRequestBodySha256) ||
    value.modelRequestBodySha256.length !== 2 ||
    value.modelRequestBodySha256.some(
      (part) => typeof part !== "string" || !/^[a-f\d]{64}$/u.test(part),
    ) ||
    value.doctorErrors !== 0 ||
    value.uninstallDisposition !== "committed" ||
    !Array.isArray(value.hookObservations) ||
    value.hookObservations.length !== 4
  )
    reject();
  claudeHooks(value.hookObservations);
}
function claudeHooks(hooks) {
  for (const [index, row] of hooks.entries()) {
    keys(row, [
      "eventName",
      "traceId",
      "canonicalGraphDigest",
      "contextDisposition",
      "spanIds",
    ]);
    if (
      row.eventName !==
        ["SessionStart", "PreToolUse", "PostToolUse", "Stop"][index] ||
      typeof row.traceId !== "string" ||
      !/^[a-f\d]{32}$/u.test(row.traceId) ||
      typeof row.canonicalGraphDigest !== "string" ||
      !/^[a-f\d]{64}$/u.test(row.canonicalGraphDigest) ||
      row.contextDisposition !== "unversioned-workspace-redacted" ||
      !Array.isArray(row.spanIds) ||
      row.spanIds.length !== (index === 0 ? 1 : 2) ||
      row.spanIds.some(
        (id) => typeof id !== "string" || !/^[a-f\d]{16}$/u.test(id),
      ) ||
      new Set(row.spanIds).size !== row.spanIds.length
    )
      reject();
  }
  if (new Set(hooks.map((row) => row.traceId)).size !== 4) reject();
}

function bindSourceMaterial(input, entry, preparedHarnessMaterial) {
  if (
    types.isProxy(input) ||
    !input ||
    typeof input !== "object" ||
    Object.getOwnPropertySymbols(input).length !== 0
  )
    reject();
  keys(input, [
    "catalogBytes",
    "fixtureBytes",
    "adapterBytes",
    "mappingBytes",
    "controllerBytes",
  ]);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Object.values(descriptors).some((value) => !Object.hasOwn(value, "value"))
  )
    reject();
  const catalog = parseAdmissionDocument(input.catalogBytes);
  keys(catalog, [
    "manifestVersion",
    "manifestIdentity",
    "requiredRepresentativeIds",
    "evidence",
    "scenarios",
  ]);
  const fixture = parseAdmissionDocument(input.fixtureBytes);
  const seed = entry.binding.seed;
  const rows = catalog.scenarios?.filter(
    (row) => row.scenarioId === seed.scenarioId,
  );
  const evidence = catalog.evidence?.filter(
    (row) => row.evidenceId === rows?.[0]?.harnessEvidenceId,
  );
  if (
    rows?.length !== 1 ||
    evidence?.length !== 1 ||
    catalog.manifestIdentity !== seed.manifestIdentity ||
    catalog.manifestIdentity !== catalogIdentity(catalog)
  )
    reject();
  bindSourceAuthority(fixture, evidence[0], entry);
  bindPreparedMaterial(input, evidence[0], entry, preparedHarnessMaterial);
  bindSourceComponent(input, evidence[0], entry);
  bindSourceCatalog(rows[0], evidence[0], entry);
}
function bindComponentMetadata(fixture, row) {
  const provenance = fixture.governance?.provenance;
  const authority = provenance?.artifactAuthority;
  const representative = fixture.governance?.representative;
  const identity = /^[a-z][a-z0-9-]{0,63}$/u;
  if (!authority || !representative) reject();
  keys(representative, ["scenarioId", "representativeVersion", "evidenceSlot"]);
  if (
    fixture.fixtureVersion !== 1 ||
    fixture.harnessId !== row.harnessId ||
    fixture.harnessVersion !== row.representativeVersion ||
    representative.representativeVersion !== row.representativeVersion ||
    typeof representative.scenarioId !== "string" ||
    !identity.test(representative.scenarioId) ||
    typeof representative.evidenceSlot !== "string" ||
    !identity.test(representative.evidenceSlot)
  )
    reject();
  if (provenance.captureKind === "synthetic") {
    keys(authority, ["status", "reason"]);
    if (
      authority.status !== "unresolved" ||
      authority.reason !== "independent-integrity-unavailable"
    )
      reject();
  } else if (provenance.captureKind === "disposable-hermetic") {
    keys(authority, ["status", "digest"]);
    if (
      authority.status !== "authenticated" ||
      typeof authority.digest !== "string" ||
      !/^sha256-[a-f\d]{64}$/u.test(authority.digest)
    )
      reject();
  } else reject();
}
function bindSourceAuthority(fixture, row, entry) {
  const seed = entry.binding.seed;
  const component = row.admission?.component;
  bindComponentMetadata(fixture, row);
  if (
    !component ||
    !["npm", "signed-release-manifest"].includes(row.material?.kind) ||
    seed.admissionVersion !== 1 ||
    typeof entry.binding.controller.authorityIdentity !== "string" ||
    !/^sha256:[a-f\d]{64}$/u.test(entry.binding.controller.authorityIdentity) ||
    typeof component.componentEvidenceDigest !== "string" ||
    !/^component-sha256-[a-f\d]{64}$/u.test(
      component.componentEvidenceDigest,
    ) ||
    row.harnessPackage !== entry.harnessType ||
    row.representativeVersion !== entry.testedVersion ||
    row.admission.evidenceSlot !== entry.evidenceSlot ||
    row.material.platformIdentity !== seed.platformIdentity
  )
    reject();
}
function bindPreparedMaterial(input, row, entry, record) {
  const descriptor = row.material;
  const { materialIdentity, ...preimage } = record ?? {};
  const signed = descriptor.kind === "signed-release-manifest";
  keys(
    record,
    signed
      ? [
          "authorityVersion",
          "evidenceId",
          "kind",
          "binary",
          "platformIdentity",
          "manifestSha256",
          "signatureSha256",
          "signatureHashAlgorithm",
          "signingKey",
          "verifier",
          "materialIdentity",
          ...(descriptor.platformPackage === undefined
            ? []
            : ["platformPackage"]),
        ]
      : [
          "authorityVersion",
          "evidenceId",
          "kind",
          "packages",
          "platformIdentity",
          "verifierNpmVersion",
          "verifier",
          "materialIdentity",
        ],
  );
  if (
    record.authorityVersion !== 1 ||
    record.evidenceId !== row.evidenceId ||
    record.kind !== descriptor.kind ||
    record.platformIdentity !== descriptor.platformIdentity ||
    materialIdentity !== integrationDigest(preimage) ||
    materialIdentity !== entry.binding.seed.harness.artifactDigest
  )
    reject();
  const verifier = record.verifier;
  keys(verifier, [
    "controllerSha256",
    "image",
    "imageConfigDigest",
    "imageId",
    "imageManifestDigest",
    "name",
  ]);
  if (
    verifier.name !== (signed ? "gpg" : "npm") ||
    verifier.image !== descriptor.verifierImage ||
    !/^sha256:[a-f\d]{64}$/u.test(verifier.imageManifestDigest) ||
    !/^sha256:[a-f\d]{64}$/u.test(verifier.imageConfigDigest) ||
    !/^sha256-[a-f\d]{64}$/u.test(verifier.imageId) ||
    verifier.controllerSha256 !==
      integrationDigestBytes(input.controllerBytes).slice(7)
  )
    reject();
  if (signed) bindPreparedSignedMaterial(record, descriptor);
  else bindPreparedNpmMaterial(record, descriptor);
}
function bindPreparedSignedMaterial(record, descriptor) {
  keys(record.binary, [
    "bytes",
    "executableName",
    "fileName",
    "platform",
    "sha256",
    "version",
  ]);
  if (
    !equal(record.binary, {
      bytes: descriptor.binary.bytes,
      executableName: descriptor.binary.executableName,
      fileName: `${descriptor.binary.sha256}.bin`,
      platform: descriptor.platform,
      sha256: descriptor.binary.sha256,
      version: descriptor.version,
    }) ||
    record.manifestSha256 !== descriptor.manifest.sha256 ||
    record.signatureSha256 !== descriptor.signature.sha256 ||
    record.signatureHashAlgorithm !==
      descriptor.signingKey.signatureHashAlgorithm ||
    (descriptor.platformPackage !== undefined &&
      !equal(record.platformPackage, descriptor.platformPackage))
  )
    reject();
  keys(record.signingKey, [
    "fingerprint",
    "sha256",
    "signerFingerprint",
    "uid",
  ]);
  if (
    !equal(record.signingKey, {
      fingerprint: descriptor.signingKey.fingerprint,
      sha256: descriptor.signingKey.sha256,
      signerFingerprint: descriptor.signingKey.signerFingerprint,
      uid: descriptor.signingKey.uid,
    })
  )
    reject();
}
function bindPreparedNpmMaterial(record, descriptor) {
  if (
    record.verifierNpmVersion !== descriptor.verifierNpmVersion ||
    !Array.isArray(record.packages) ||
    record.packages.length !== descriptor.packages.length
  )
    reject();
  for (const pin of descriptor.packages) {
    const rows = record.packages.filter(
      (value) =>
        value.packageName === pin.packageName && value.version === pin.version,
    );
    if (rows.length !== 1) reject();
    const archive = rows[0];
    keys(archive, [
      "packageName",
      "installName",
      "version",
      "fileName",
      "bytes",
      "sha256",
      "integrity",
      "shasum",
      "attestationBundleDigest",
    ]);
    if (
      archive.installName !== pin.installName ||
      archive.bytes !== pin.bytes ||
      archive.integrity !== pin.integrity ||
      archive.shasum !== pin.shasum ||
      !/^[a-f\d]{64}$/u.test(archive.sha256) ||
      archive.fileName !== `${archive.sha256}.tgz` ||
      archive.attestationBundleDigest !==
        `sha256-${pin.attestations.bundleDigest}`
    )
      reject();
  }
}
function bindSourceComponent(input, row, entry) {
  const seed = entry.binding.seed;
  const component = row.admission.component;
  const expected = {
    fixtureDigest: integrationDigestBytes(input.fixtureBytes),
    adapterArtifactDigest: integrationDigestBytes(input.adapterBytes),
    mappingArtifactDigest: integrationDigestBytes(input.mappingBytes),
    componentEvidenceDigest: component.componentEvidenceDigest,
  };
  if (
    ["fixture", "adapterArtifact", "mappingArtifact"].some(
      (key, index) =>
        `sha256-${component[key]?.sha256}` !== Object.values(expected)[index],
    ) ||
    !equal(seed.component, expected) ||
    entry.contractSuiteDigest !== integrationDigest(expected) ||
    entry.catalogRowIdentity !== seed.catalogRowIdentity ||
    seed.harness.exactVersion !== row.representativeVersion ||
    seed.harness.distributionReference !== row.admission.distributionReference
  )
    reject();
}
function bindSourceCatalog(scenario, row, entry) {
  const seed = entry.binding.seed;
  const harnessArtifact = {
    registryIdentity: row.harnessPackage,
    exactVersion: row.representativeVersion,
    distributionReference: row.admission.distributionReference,
    artifactDigest: seed.harness.artifactDigest,
  };
  const catalogRow = {
    productIdentity: "agentscope-cli",
    harness: {
      registryIdentity: row.harnessPackage,
      evidenceSlot: row.admission.evidenceSlot,
      exactVersion: row.representativeVersion,
    },
    execution: seed.execution,
    platformIdentity: seed.platformIdentity,
    destinationCombinationIdentity: seed.destinationCombinationIdentity,
  };
  if (
    seed.harness.artifactAuthorityDigest !==
      integrationDigest(harnessArtifact) ||
    seed.catalogRowIdentity !== integrationDigest(catalogRow) ||
    !equal(seed.harness.eligibleRange, row.admission.eligibleRange) ||
    seed.execution.mode !== scenario.executionMode ||
    seed.execution.outputContract !== scenario.outputContract ||
    seed.destinationCombinationIdentity !==
      integrationDigest({
        destinations: [...scenario.destinations].sort(),
        modelRoutes: [...scenario.modelRoutes].sort(),
      })
  )
    reject();
}
// Same finite preimage as Integration's capabilityManifestIdentity; no new
// catalog authority or schema parser is minted by recomputing this checksum.
function catalogIdentity(catalog) {
  const sorted = (values) => {
    if (
      !Array.isArray(values) ||
      values.some((value) => typeof value !== "string")
    )
      reject();
    return [...values].sort((left, right) => left.localeCompare(right));
  };
  return integrationDigest({
    manifestVersion: catalog.manifestVersion,
    requiredRepresentativeIds: sorted(catalog.requiredRepresentativeIds),
    evidence: [...catalog.evidence].sort((left, right) =>
      left.evidenceId.localeCompare(right.evidenceId),
    ),
    scenarios: catalog.scenarios
      .map((row) => ({
        ...row,
        modelRoutes: sorted(row.modelRoutes),
        tags: sorted(row.tags),
        destinations: sorted(row.destinations),
      }))
      .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId)),
  });
}
const integrationDigestBytes = (bytes) => {
  if (
    types.isProxy(bytes) ||
    !Buffer.isBuffer(bytes) ||
    bytes.length < 1 ||
    bytes.length > 1_048_576
  )
    reject();
  return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
};

function cleanCodexTerminal(evidence) {
  const receipt = evidence.ptyTerminalReceipt;
  keys(evidence.cleanup, ["outcome", "removalFailureCount", "remaining"]);
  keys(evidence.cleanup.remaining, [
    "containers",
    "networks",
    "images",
    "volumes",
    "buildContexts",
    "activeRunMarkers",
  ]);
  if (
    evidence.evidenceVersion !== 2 ||
    evidence.outcome !== "passed" ||
    evidence.executionMode !== "interactive" ||
    evidence.headlessTerminalReceipt !== null ||
    evidence.cleanup.outcome !== "complete" ||
    evidence.cleanup.removalFailureCount !== 0 ||
    Object.values(evidence.cleanup.remaining).some((count) => count !== 0) ||
    receipt?.receiptVersion !== 1 ||
    receipt.transport !== "pty" ||
    receipt.runId !== evidence.runId ||
    receipt.scenarioId !== evidence.scenarioId ||
    receipt.outcome !== "completed" ||
    receipt.exitCode !== 0 ||
    receipt.signal !== null ||
    receipt.cleanup !== "clean" ||
    receipt.residualProcessCount !== 0 ||
    receipt.finalSnapshot?.semanticState !== "completed" ||
    [
      receipt.processJoined,
      receipt.terminalInputJoined,
      receipt.terminalOutputJoined,
      receipt.terminalTransportClosed,
    ].some((joined) => joined !== true) ||
    !Number.isFinite(receipt.returnedAtMs) ||
    !Number.isFinite(receipt.request?.process?.monotonicShutdownDeadlineMs) ||
    receipt.returnedAtMs >
      receipt.request.process.monotonicShutdownDeadlineMs ||
    receipt.processRequestFingerprint !==
      receipt.request.process.requestFingerprint ||
    receipt.requestFingerprint !==
      sha256(
        JSON.stringify({
          processRequestFingerprint: receipt.processRequestFingerprint,
          completion: receipt.request.completion,
          readiness: receipt.request.readiness,
          initialGeometry: receipt.request.initialGeometry,
          interaction: {
            actions: receipt.request.interaction.actions,
            trigger: receipt.request.interaction.trigger,
          },
          interpreter: receipt.request.interpreter,
          scriptSha256: receipt.request.scriptSha256,
          inputBytes: receipt.inputBytes,
          inputSha256: receipt.inputSha256,
        }),
      )
  )
    reject();
  return receipt;
}

function codexLifecycle(evidence, lifecycle) {
  keys(lifecycle, [
    "evidenceVersion",
    "resultStatus",
    "scenarioId",
    "artifactFileName",
    "certificationReadiness",
    "lifecycle",
    "eventKinds",
  ]);
  if (
    lifecycle.evidenceVersion !== 1 ||
    lifecycle.scenarioId !== evidence.scenarioId ||
    lifecycle.resultStatus !== "complete" ||
    lifecycle.certificationReadiness !== null ||
    !equal(lifecycle.lifecycle, [
      "install",
      "configure",
      "hook",
      "execute",
      "export",
      "retrieve",
      "uninstall",
    ]) ||
    !equal(lifecycle.eventKinds, ["hook", "model", "destination"])
  )
    reject();
}
function codexLedgers(
  modelLedger,
  destinationLedger,
  scenarioId,
  family = "codex",
) {
  keys(modelLedger, ["ledgerVersion", "scenarioId", "entries"]);
  keys(destinationLedger, [
    "ledgerVersion",
    "scenarioId",
    "ingestion",
    "retrieval",
  ]);
  if (
    modelLedger.ledgerVersion !== 1 ||
    modelLedger.scenarioId !== scenarioId ||
    !Array.isArray(modelLedger.entries) ||
    modelLedger.entries.length < (family === "claude-code" ? 2 : 1) ||
    modelLedger.entries.length > 32 ||
    destinationLedger.ledgerVersion !== 1 ||
    destinationLedger.scenarioId !== scenarioId ||
    !Array.isArray(destinationLedger.ingestion) ||
    destinationLedger.ingestion.length !== (family === "claude-code" ? 4 : 1) ||
    !equal(destinationLedger.retrieval, [])
  )
    reject();
  for (const row of destinationLedger.ingestion) {
    keys(row, ["operation", "method", "path", "bodyBytes", "outcome"]);
    if (
      row.operation !== "otlp" ||
      row.method !== "POST" ||
      row.path !== "/api/public/otel/v1/traces" ||
      row.outcome !== "accepted" ||
      !Number.isSafeInteger(row.bodyBytes) ||
      row.bodyBytes < 1 ||
      row.bodyBytes > 1_048_576
    )
      reject();
  }
  modelRows(modelLedger.entries, family);
}
function modelRows(entries, family) {
  let primary = 0;
  for (const model of entries) {
    keys(model, ["routeId", "provider", "method", "path", "bodyBytes"]);
    if (
      (family === "codex"
        ? model.routeId !== "codex-tui-responses" ||
          model.provider !== "openai" ||
          model.path !== "/v1/responses"
        : model.routeId !== "anthropic-messages" ||
          model.provider !== "anthropic" ||
          model.path !== "/v1/messages") ||
      model.method !== "POST" ||
      !Number.isSafeInteger(model.bodyBytes) ||
      model.bodyBytes < 1 ||
      model.bodyBytes > 1_048_576
    )
      reject();
    if (model.routeId === "anthropic-messages") primary++;
  }
  if (family === "claude-code" && primary < 2) reject();
}
function codexCompletion(entry, evidence, native, receipt, prepared) {
  const family =
    native.harnessObservation.kind === "claude-code-trace"
      ? "claude-code"
      : "codex";
  const { seed, controller, completion } = entry.binding;
  const execution = Object.fromEntries(
    [
      "baseImageIdentity",
      "builtImageDigest",
      "candidateBundleIdentity",
      "executionMode",
      "manifestIdentity",
      "mockServerImageIdentity",
      "scenarioId",
    ].map((key) => [key, evidence[key]]),
  );
  execution.receipt = receipt;
  if (Object.hasOwn(evidence, "preparedHarnessMaterial"))
    execution.preparedHarnessMaterial = evidence.preparedHarnessMaterial;
  if (
    seed.productIdentity !== "agentscope-cli" ||
    seed.candidateDigest !== prepared.bundleIdentity ||
    seed.manifestIdentity !== evidence.manifestIdentity ||
    seed.scenarioId !== evidence.scenarioId ||
    seed.execution?.mode !== "interactive" ||
    seed.execution.outputContract !== "semantic-pty" ||
    seed.harness?.registryIdentity !== `@agentscope/harness-${family}` ||
    seed.preparedImage?.scenarioImageDigest !== evidence.builtImageDigest ||
    controller?.hostKind !== "github-hosted" ||
    controller.workspaceRevision !== prepared.candidateRevision ||
    completion?.completionVersion !== 1 ||
    completion.runId !== evidence.runId ||
    completion.requestFingerprint !== receipt.requestFingerprint ||
    completion.observationPlaneDigest !==
      integrationDigest({ native, execution }) ||
    completion.cleanupEvidenceDigest !== integrationDigest(evidence.cleanup) ||
    completion.scenarioImageDigest !== evidence.builtImageDigest ||
    completion.outcome !== "scenario-terminal-clean" ||
    completion.remainingOwnedResources !== 0 ||
    entry.realScenarioDigest !== integrationDigest(entry.binding)
  )
    reject();
  return completion;
}
// A transient map of owned file-byte snapshots, never a persisted evidence DTO.
function codexDocuments(files, family = "codex") {
  if (types.isProxy(files) || !files || typeof files !== "object") reject();
  if (Object.getOwnPropertySymbols(files).length !== 0) reject();
  keys(files, [
    "evidence.json",
    "fixture-lifecycle.json",
    "model-ledger.json",
    "destination-ledger.json",
    "harness-observation.json",
  ]);
  const descriptors = Object.getOwnPropertyDescriptors(files);
  const read = (name) => {
    if (!Object.hasOwn(descriptors[name], "value")) reject();
    return parseAdmissionDocument(descriptors[name].value);
  };
  const evidence = read("evidence.json"),
    lifecycle = read("fixture-lifecycle.json");
  const modelLedger = read("model-ledger.json"),
    destinationLedger = read("destination-ledger.json"),
    harnessObservation = read("harness-observation.json");
  codexLifecycle(evidence, lifecycle);
  codexLedgers(modelLedger, destinationLedger, evidence.scenarioId, family);
  if (family === "codex") codexObservation(harnessObservation);
  else claudeObservation(harnessObservation);
  return {
    evidence,
    native: {
      ...lifecycle,
      modelLedger,
      destinationLedger,
      harnessObservation,
    },
  };
}
// Reconstruct ONLY existing completion preimages from owned snapshots. This
// binds the bounded Codex projection, not a new support certificate or graph.
export function bindCodexScenarioEvidence(preparedBytes, supportBytes, files) {
  return bindScenarioEvidence(preparedBytes, supportBytes, files, "codex");
}
export function bindClaudeScenarioEvidence(
  preparedBytes,
  supportBytes,
  files,
  material,
) {
  return bindScenarioEvidence(
    preparedBytes,
    supportBytes,
    files,
    "claude-code",
    material,
  );
}
const admitted = new WeakSet();
export function bindScenarioEvidence(
  preparedBytes,
  supportBytes,
  files,
  family,
  material,
) {
  if (!["codex", "claude-code"].includes(family)) reject();
  const prepared = parseAdmissionDocument(preparedBytes);
  preparedEvidence(prepared);
  const { bundleIdentity, ...preparedMaterial } = prepared;
  if (integrationDigest(preparedMaterial) !== bundleIdentity) reject();
  const support = parseAdmissionDocument(supportBytes);
  keys(support, [
    "manifestVersion",
    "disposition",
    "manifestIdentity",
    "entries",
  ]);
  if (
    support.manifestVersion !== 1 ||
    support.disposition !== "real-scenario-evidence-awaiting-release-gate" ||
    !Array.isArray(support.entries) ||
    support.entries.length < 1 ||
    support.entries.length > 32 ||
    support.manifestIdentity !==
      integrationDigest({
        manifestVersion: support.manifestVersion,
        disposition: support.disposition,
        entries: support.entries,
      })
  )
    reject();
  const { evidence, native } = codexDocuments(files, family);
  if (
    !/^[a-f0-9]{16}$/u.test(evidence.runId) ||
    evidence.candidateBundleIdentity !== bundleIdentity ||
    evidence.candidateRevision !== prepared.candidateRevision
  )
    reject();
  const receipt = cleanCodexTerminal(evidence);
  const entries = support.entries.filter(
    (entry) =>
      entry.harnessType === `@agentscope/harness-${family}` &&
      entry.binding?.seed?.runId === evidence.runId,
  );
  if (entries.length !== 1) reject();
  const completion = codexCompletion(
    entries[0],
    evidence,
    native,
    receipt,
    prepared,
  );
  const result = Object.freeze({
    runId: evidence.runId,
    scenarioId: evidence.scenarioId,
    candidateBundleIdentity: bundleIdentity,
    observationPlaneDigest: completion.observationPlaneDigest,
    family,
    candidateRevision: prepared.candidateRevision,
    manifestIdentity: evidence.manifestIdentity,
    platformIdentity: entries[0].binding.seed.platformIdentity,
    destinationCombinationIdentity:
      entries[0].binding.seed.destinationCombinationIdentity,
    controllerAuthorityIdentity:
      entries[0].binding.controller.authorityIdentity,
  });
  if (material !== undefined) {
    bindSourceMaterial(material, entries[0], evidence.preparedHarnessMaterial);
    admitted.add(result);
  }
  return result;
}

// Bindings retain checked-out component regression bytes as source attribution.
// The entry authenticates the immutable producing run; JSON labels alone do not.
export function requireActualSemanticAdmission(values) {
  const missing = () => {
    throw new Error("release.admission.actual-otlp-evidence-missing");
  };
  if (types.isProxy(values) || !Array.isArray(values)) missing();
  const descriptors = Object.getOwnPropertyDescriptors(values);
  if (
    Reflect.ownKeys(descriptors).length !== 3 ||
    descriptors.length?.value !== 2 ||
    !Object.hasOwn(descriptors[0] ?? {}, "value") ||
    !Object.hasOwn(descriptors[1] ?? {}, "value")
  )
    missing();
  values = [descriptors[0].value, descriptors[1].value];
  if (
    values.some((value) => types.isProxy(value) || !admitted.has(value)) ||
    !equal(values.map((value) => value.family).sort(), [
      "claude-code",
      "codex",
    ]) ||
    [
      "candidateRevision",
      "candidateBundleIdentity",
      "manifestIdentity",
      "platformIdentity",
      "controllerAuthorityIdentity",
    ].some((key) => values[0][key] !== values[1][key]) ||
    values[0].runId === values[1].runId
  )
    missing();
  return Object.freeze([...values]);
}
