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
