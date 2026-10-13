import { canonicalJson, sha256 } from "./validation.mjs";
import { projectOperatorControlsReport } from "./admission.mjs";
import {
  recorderExactKeys,
  snapshotRecorderInput,
  validateStageResult,
  validateStageTuple,
} from "./stage-result.mjs";

const fail = () => {
  throw new Error("release.recorder.invalid");
};
const digest = /^sha256:[a-f0-9]{64}$/u;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function checkpointWindow(checkpoint, observedAt) {
  const parse = (value) => {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)
    )
      fail();
    const time = Date.parse(value);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
      fail();
    return time;
  };
  const issued = parse(checkpoint.issuedAt);
  const expires = parse(checkpoint.expiresAt);
  const consumed = parse(checkpoint.consumedAt);
  const observed = parse(observedAt);
  if (
    expires <= issued ||
    expires - issued > 900_000 ||
    consumed < issued ||
    consumed > expires ||
    observed < consumed
  )
    fail();
}

function validateHead(head, tuple) {
  recorderExactKeys(head, [
    "schemaVersion",
    "sequence",
    "digest",
    "previousDigest",
    "transition",
    "transactionId",
    "draftReleaseDatabaseId",
    "candidateManifestDigest",
    "sourceRevision",
    "kind",
    "ownerCheckpointDigest",
  ]);
  if (
    head.schemaVersion !== 1 ||
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 1 ||
    head.sequence >= Number.MAX_SAFE_INTEGER ||
    !digest.test(head.digest) ||
    !digest.test(head.previousDigest) ||
    head.transition !== "pre-stage-intent" ||
    head.ownerCheckpointDigest !== tuple.ownerCheckpointDigest ||
    head.transactionId !== tuple.transactionId ||
    head.candidateManifestDigest !== tuple.candidateManifestDigest ||
    head.sourceRevision !== tuple.sourceRevision ||
    head.kind !== tuple.kind
  )
    fail();
  if (
    !Number.isSafeInteger(head.draftReleaseDatabaseId) ||
    head.draftReleaseDatabaseId < 1
  )
    fail();
}

function validateCheckpoint(checkpoint, head, tuple, observedAt) {
  recorderExactKeys(checkpoint, [
    "transactionId",
    "draftReleaseDatabaseId",
    "ownerIdentity",
    "pendingStagesState",
    "issuedAt",
    "expiresAt",
    "consumedAt",
    "state",
    "authenticationDigest",
    "phase",
    "sourceRevision",
    "candidateManifestDigest",
    "expectedSequence",
    "expectedPriorDigest",
    "controlsReport",
    "controlsReportDigest",
    "controlsInspectedAt",
  ]);
  if (
    checkpoint.transactionId !== tuple.transactionId ||
    checkpoint.draftReleaseDatabaseId !== head.draftReleaseDatabaseId ||
    checkpoint.ownerIdentity !== "Melbourneandrew" ||
    checkpoint.pendingStagesState !== "none-conflicting" ||
    checkpoint.state !== "consumed-for-stage" ||
    checkpoint.phase !== "pre-stage" ||
    checkpoint.sourceRevision !== tuple.sourceRevision ||
    checkpoint.candidateManifestDigest !== tuple.candidateManifestDigest ||
    checkpoint.expectedSequence !== head.sequence - 1 ||
    checkpoint.expectedPriorDigest !== head.previousDigest ||
    !digest.test(checkpoint.authenticationDigest) ||
    sha256(canonicalJson(checkpoint)) !== tuple.ownerCheckpointDigest
  )
    fail();
  const controls = projectOperatorControlsReport(
    checkpoint.controlsReport,
    checkpoint.expiresAt,
    checkpoint.consumedAt,
  );
  if (
    controls.controlsReportDigest !== checkpoint.controlsReportDigest ||
    controls.controlsInspectedAt !== checkpoint.controlsInspectedAt ||
    controls.controlsInspectedAt !== checkpoint.issuedAt
  )
    fail();
  checkpointWindow(checkpoint, observedAt);
}

// Structural validation only: the caller must acquire the durable intent and
// authenticate the current GitHub run/approval before invoking a mutation.
export function validateStageCheckpoint(input) {
  const value = snapshotRecorderInput(input);
  recorderExactKeys(value, ["tuple", "head", "ownerCheckpoint", "observedAt"]);
  const tuple = validateStageTuple(value.tuple);
  if (tuple.kind !== "product") fail();
  validateHead(value.head, tuple);
  validateCheckpoint(
    value.ownerCheckpoint,
    value.head,
    tuple,
    value.observedAt,
  );
  if (
    Date.parse(value.observedAt) >= Date.parse(value.ownerCheckpoint.expiresAt)
  )
    fail();
  return tuple;
}

// Production probe records do not impersonate a product draft or tag. These
// projections remain inert; the protected composition authenticates API runs.
export function validateProbeMaterial(input) {
  const value = snapshotRecorderInput(input);
  recorderExactKeys(value, [
    "schemaVersion",
    "kind",
    "preparationRunId",
    "preparationRunAttempt",
    "sourceRevision",
    "workflowDigest",
    "releaseScriptsDigest",
    "version",
    "tarballFilename",
    "tarballSha256",
    "integrity",
    "inventoryDigest",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "inert-probe-material" ||
    !Number.isSafeInteger(value.preparationRunId) ||
    value.preparationRunId < 1 ||
    !Number.isSafeInteger(value.preparationRunAttempt) ||
    value.preparationRunAttempt < 1 ||
    !/^[a-f0-9]{40}$/u.test(value.sourceRevision) ||
    value.version !==
      `0.0.0-oidc-probe.${value.preparationRunId}-${value.preparationRunAttempt}` ||
    value.tarballFilename !== `agentscope-cli-${value.version}.tgz` ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(value.integrity)
  )
    fail();
  for (const key of [
    "workflowDigest",
    "releaseScriptsDigest",
    "tarballSha256",
    "inventoryDigest",
  ])
    if (typeof value[key] !== "string" || !digest.test(value[key])) fail();
  return value;
}

// Authenticated checkout of this reviewed append-only per-version file is the
// reservation source. Its digest alone is not permission to invoke npm.
export function validateProbeInvocationReservation(input, materialInput) {
  const value = snapshotRecorderInput(input);
  const material = validateProbeMaterial(materialInput);
  recorderExactKeys(value, [
    "schemaVersion",
    "kind",
    "repository",
    "workflowPath",
    "workflowDatabaseId",
    "expectedRunNumber",
    "runAttempt",
    "ownerId",
    "ownerLogin",
    "version",
    "preparationRunId",
    "preparationRunAttempt",
    "preparationSourceRevision",
    "preparedMaterialDigest",
    "tarballSha256",
    "integrity",
    "workflowDigest",
    "releaseScriptsDigest",
    "digest",
  ]);
  const { digest: actualDigest, ...unsigned } = value;
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "reserved-inert-probe-invocation" ||
    value.repository !== "Melbourneandrew/agentscope" ||
    value.workflowPath !== ".github/workflows/release.yml" ||
    !Number.isSafeInteger(value.workflowDatabaseId) ||
    value.workflowDatabaseId < 1 ||
    !Number.isSafeInteger(value.expectedRunNumber) ||
    value.expectedRunNumber < 1 ||
    value.runAttempt !== 1 ||
    value.ownerId !== 25971425 ||
    value.ownerLogin !== "Melbourneandrew" ||
    value.version !== material.version ||
    value.preparationRunId !== material.preparationRunId ||
    value.preparationRunAttempt !== material.preparationRunAttempt ||
    value.preparationSourceRevision !== material.sourceRevision ||
    value.preparedMaterialDigest !== sha256(canonicalJson(material)) ||
    value.tarballSha256 !== material.tarballSha256 ||
    value.integrity !== material.integrity ||
    value.workflowDigest !== material.workflowDigest ||
    value.releaseScriptsDigest !== material.releaseScriptsDigest ||
    actualDigest !== sha256(canonicalJson(unsigned))
  )
    fail();
  return value;
}

function validateProbeOwnerCheckpoint(checkpoint, tuple, observedAt, forStage) {
  recorderExactKeys(checkpoint, [
    "phase",
    "sourceRevision",
    "candidateManifestDigest",
    "issuedAt",
    "expiresAt",
    "controlsReport",
    "pendingStagesState",
    "probeVersionState",
    "consumedAt",
    "ownerIdentity",
    "state",
    "authenticationDigest",
    "controlsReportDigest",
    "controlsInspectedAt",
  ]);
  if (
    tuple.ownerCheckpointDigest !== sha256(canonicalJson(checkpoint)) ||
    checkpoint.phase !== "pre-probe" ||
    checkpoint.sourceRevision !== tuple.sourceRevision ||
    checkpoint.candidateManifestDigest !== tuple.candidateManifestDigest ||
    checkpoint.pendingStagesState !== "none-conflicting" ||
    checkpoint.probeVersionState !== "never-staged" ||
    checkpoint.ownerIdentity !== "Melbourneandrew" ||
    checkpoint.state !== "consumed-for-probe" ||
    typeof checkpoint.authenticationDigest !== "string" ||
    !digest.test(checkpoint.authenticationDigest)
  )
    fail();
  const controls = projectOperatorControlsReport(
    checkpoint.controlsReport,
    checkpoint.expiresAt,
    checkpoint.consumedAt,
  );
  if (
    controls.controlsReportDigest !== checkpoint.controlsReportDigest ||
    controls.controlsInspectedAt !== checkpoint.controlsInspectedAt ||
    controls.controlsInspectedAt !== checkpoint.issuedAt
  )
    fail();
  checkpointWindow(checkpoint, observedAt);
  if (forStage && Date.parse(observedAt) >= Date.parse(checkpoint.expiresAt))
    fail();
}

export function validateProbeIntent(input, observedAt, forStage = false) {
  const value = snapshotRecorderInput(input);
  recorderExactKeys(value, [
    "schemaVersion",
    "kind",
    "runId",
    "runAttempt",
    "sourceRevision",
    "material",
    "tuple",
    "ownerCheckpoint",
    "invocationIntent",
    "digest",
  ]);
  const material = validateProbeMaterial(value.material);
  validateProbeInvocationReservation(value.invocationIntent, material);
  const tuple = validateStageTuple(value.tuple);
  const { digest: actualDigest, ...unsigned } = value;
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "probe-stage-intent" ||
    !Number.isSafeInteger(value.runId) ||
    value.runId < 1 ||
    !Number.isSafeInteger(value.runAttempt) ||
    value.runAttempt < 1 ||
    value.runAttempt !== 1 ||
    actualDigest !== sha256(canonicalJson(unsigned)) ||
    tuple.kind !== "probe" ||
    tuple.sourceRevision !== value.sourceRevision ||
    tuple.candidateManifestDigest !== sha256(canonicalJson(material)) ||
    tuple.tarballSha256 !== material.tarballSha256 ||
    tuple.integrity !== material.integrity ||
    tuple.version !== material.version ||
    tuple.workflowDigest !== material.workflowDigest ||
    tuple.releaseScriptsDigest !== material.releaseScriptsDigest
  )
    fail();
  validateProbeOwnerCheckpoint(
    value.ownerCheckpoint,
    tuple,
    observedAt,
    forStage,
  );
  return value;
}

export function validateProbeStagePacket(input, observedAt) {
  const packet = snapshotRecorderInput(input);
  recorderExactKeys(packet, [
    "schemaVersion",
    "kind",
    "sourceRevision",
    "runId",
    "runAttempt",
    "intent",
    "stageResult",
    "stageResultDigest",
    "state",
    "digest",
  ]);
  const { digest: packetDigest, ...unsigned } = packet;
  const intent = validateProbeIntent(packet.intent, observedAt, false);
  const result = validateStageResult(packet.stageResult, intent.tuple);
  if (
    packetDigest !== sha256(canonicalJson(unsigned)) ||
    packet.schemaVersion !== 1 ||
    packet.kind !== "retained-probe-stage" ||
    packet.state !== "pending-owner-reconciliation" ||
    result.response !== "received" ||
    result.stageResultDigest !== packet.stageResultDigest ||
    packet.sourceRevision !== intent.sourceRevision ||
    packet.runId !== intent.runId ||
    packet.runAttempt !== intent.runAttempt
  )
    fail();
  return packet;
}

// Inert proposal only. The integration must authenticate head/checkpoint/stage
// provenance, recheck external controls and CAS this exact prior head before IO.
// No hash or accepted input here is an authorization to append, stage or approve.
export function proposeStageRecord(input) {
  const snapshot = snapshotRecorderInput(input);
  recorderExactKeys(snapshot, [
    "tuple",
    "head",
    "expectedSequence",
    "expectedPriorDigest",
    "ownerCheckpoint",
    "stageResult",
    "observedAt",
    "actor",
  ]);
  const tuple = validateStageTuple(snapshot.tuple);
  // ADR001 probes use protected-main probe manifests, not product draft
  // transactions. The shared validator accepts probes; this recorder cannot.
  if (tuple.kind !== "product") fail();
  validateHead(snapshot.head, tuple);
  if (
    snapshot.expectedSequence !== snapshot.head.sequence ||
    snapshot.expectedPriorDigest !== snapshot.head.digest ||
    typeof snapshot.actor !== "string" ||
    !identifier.test(snapshot.actor)
  )
    fail();
  validateCheckpoint(
    snapshot.ownerCheckpoint,
    snapshot.head,
    tuple,
    snapshot.observedAt,
  );
  const stage = validateStageResult(snapshot.stageResult, tuple);
  const received = stage.response === "received";
  const unsigned = Object.freeze({
    schemaVersion: 1,
    sequence: snapshot.head.sequence + 1,
    previousDigest: snapshot.head.digest,
    transition: received ? "stage-recorded" : "quarantine-still-draft",
    transactionId: tuple.transactionId,
    sourceRevision: tuple.sourceRevision,
    protectedTag: tuple.protectedTag,
    candidateManifestDigest: tuple.candidateManifestDigest,
    actor: snapshot.actor,
    payload: Object.freeze({
      kind: tuple.kind,
      draftReleaseDatabaseId: snapshot.head.draftReleaseDatabaseId,
      stageResultDigest: stage.stageResultDigest,
      ownerCheckpointDigest: tuple.ownerCheckpointDigest,
      stageId: stage.stageId,
      package: tuple.package,
      version: tuple.version,
      distTag: tuple.distTag,
      tarballSha256: tuple.tarballSha256,
      integrity: tuple.integrity,
      ...(received
        ? {}
        : {
            failureClass: `${stage.response}-stage-response`,
            state: "frozen-unresolved",
            terminal: false,
          }),
    }),
  });
  return Object.freeze({
    disposition: "inert-append-proposal-not-authorized",
    expectedSequence: snapshot.head.sequence,
    expectedPriorDigest: snapshot.head.digest,
    record: Object.freeze({
      ...unsigned,
      digest: sha256(canonicalJson(unsigned)),
    }),
  });
}

function validatePublicationTags(tags) {
  if (
    !tags ||
    Object.keys(tags).length > 24 ||
    Object.entries(tags).some(
      ([key, version]) =>
        !/^[a-z][a-z0-9-]{0,63}$/u.test(key) ||
        typeof version !== "string" ||
        version.length > 128 ||
        !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version),
    ) ||
    tags.bootstrap !== "0.0.0-bootstrap.0" ||
    tags.latest !== "0.0.0-bootstrap.0"
  )
    fail();
}

// A validated owner document is an attestation, not npm-server proof. The
// production composition separately authenticates its fixed API principal.
export function validatePublicationObservation(
  input,
  headInput,
  observedAt,
  consume = true,
) {
  const value = snapshotRecorderInput(input);
  const head = snapshotRecorderInput(headInput);
  recorderExactKeys(value, [
    "transactionId",
    "draftReleaseDatabaseId",
    "sourceRevision",
    "candidateManifestDigest",
    "expectedSequence",
    "expectedPriorDigest",
    "stageId",
    "package",
    "version",
    "distTag",
    "tarballSha256",
    "integrity",
    "downloadedTarballSha256",
    "pendingStagesState",
    "distTags",
    "issuedAt",
    "expiresAt",
    "controlsReport",
  ]);
  if (
    !["stage-recorded", "publication-checkpoint"].includes(head.transition) ||
    value.transactionId !== head.transactionId ||
    value.draftReleaseDatabaseId !== head.draftReleaseDatabaseId ||
    value.sourceRevision !== head.sourceRevision ||
    value.candidateManifestDigest !== head.candidateManifestDigest ||
    value.expectedSequence !== head.sequence ||
    value.expectedPriorDigest !== head.digest ||
    value.pendingStagesState !== "exact-stage-only" ||
    value.package !== "agentscope-cli" ||
    value.version !== "0.1.0" ||
    value.distTag !== "alpha" ||
    !identifier.test(value.stageId) ||
    !digest.test(value.tarballSha256) ||
    value.downloadedTarballSha256 !== value.tarballSha256 ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(value.integrity)
  )
    fail();
  const stage =
    head.transition === "stage-recorded" ? head.payload : head.checkpoint;
  for (const key of [
    "stageId",
    "package",
    "version",
    "distTag",
    "tarballSha256",
    "integrity",
  ])
    if (value[key] !== stage[key]) fail();
  const tags = value.distTags;
  validatePublicationTags(tags);
  const issued = Date.parse(value.issuedAt);
  const expires = Date.parse(value.expiresAt);
  const observed = Date.parse(observedAt);
  if (
    [value.issuedAt, value.expiresAt, observedAt].some(
      (time) =>
        !Number.isFinite(Date.parse(time)) ||
        new Date(Date.parse(time)).toISOString() !== time,
    ) ||
    expires <= issued ||
    expires - issued > 900_000 ||
    observed < issued ||
    observed >= expires
  )
    fail();
  const controls = projectOperatorControlsReport(
    value.controlsReport,
    value.expiresAt,
    observedAt,
  );
  if (controls.controlsInspectedAt !== value.issuedAt) fail();
  if (
    consume &&
    head.transition === "publication-checkpoint" &&
    (value.expiresAt !== stage.expiresAt ||
      canonicalJson(tags) !== canonicalJson(stage.distTags))
  )
    fail();
  return snapshotRecorderInput({
    ...value,
    ...controls,
    distTagsDigest: sha256(canonicalJson(tags)),
  });
}
