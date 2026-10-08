import { canonicalJson, sha256 } from "./validation.mjs";
import {
  recorderExactKeys,
  snapshotRecorderInput,
  validateStageTuple,
  validateStageResult,
} from "./stage-result.mjs";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { types } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifyCandidateArtifact,
  verifyInertProbeTarball,
  inspectCandidateTarball,
} from "./candidate.mjs";
import {
  proposeStageRecord,
  validateStageCheckpoint,
  validateProbeMaterial,
  validateProbeIntent,
  validateProbeStagePacket,
  validateProbeInvocationReservation,
  validatePublicationObservation,
} from "./production-recorder.mjs";
import {
  projectOperatorControlsReport,
  parseAdmissionDocument,
} from "./admission.mjs";
import { produceNpmStage } from "./npm-stage-producer.mjs";

const authenticated = new WeakMap();
const fail = () => {
  throw new Error("release.recording.unresolved");
};
const encode = (value) => Buffer.from(`${canonicalJson(value)}\n`);

// Ordinary npm pack supplies this inert archive. Preparation output records
// observed bytes; it is neither product certification nor stage authority.
export function prepareProbeMaterial({
  tarballPath,
  runId,
  runAttempt,
  sourceRevision,
  executingDigests,
}) {
  if (
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1
  )
    fail();
  const version = `0.0.0-oidc-probe.${runId}-${runAttempt}`;
  const facts = inspectCandidateTarball(tarballPath);
  const material = validateProbeMaterial({
    schemaVersion: 1,
    kind: "inert-probe-material",
    preparationRunId: runId,
    preparationRunAttempt: runAttempt,
    sourceRevision,
    ...executingDigests,
    version,
    tarballFilename: `agentscope-cli-${version}.tgz`,
    tarballSha256: facts.sha256,
    integrity: facts.integrity,
    inventoryDigest: facts.inventoryDigest,
  });
  verifyInertProbeTarball({
    tarballPath,
    tuple: {
      kind: "probe",
      package: "agentscope-cli",
      version,
      distTag: "oidc-probe",
      protectedTag: null,
      tarballSha256: material.tarballSha256,
      integrity: material.integrity,
    },
  });
  return material;
}

async function authenticatePreparedProbe(
  store,
  material,
  identity,
  executingDigests,
) {
  const value = validateProbeMaterial(material);
  const run = await store.run(value.preparationRunId);
  if (
    run.id !== value.preparationRunId ||
    run.run_attempt !== value.preparationRunAttempt ||
    run.head_sha !== value.sourceRevision ||
    run.head_branch !== "main" ||
    run.path !== ".github/workflows/release.yml" ||
    run.event !== "workflow_dispatch" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.actor?.id !== 25971425 ||
    run.triggering_actor?.id !== 25971425 ||
    run.actor?.login !== "Melbourneandrew" ||
    run.triggering_actor?.login !== "Melbourneandrew" ||
    value.workflowDigest !== executingDigests.workflowDigest ||
    value.releaseScriptsDigest !== executingDigests.releaseScriptsDigest
  )
    fail();
  await store.protectedMainSource(value.sourceRevision);
  await store.protectedMainSource(identity.sourceRevision);
  return value;
}

function matchReservedProbeRun(run, reservationInput, material) {
  const reservation = validateProbeInvocationReservation(
    reservationInput,
    material,
  );
  if (
    !Number.isSafeInteger(run.workflow_id) ||
    !Number.isSafeInteger(run.run_number) ||
    run.workflow_id !== reservation.workflowDatabaseId ||
    run.run_number !== reservation.expectedRunNumber ||
    run.run_attempt !== 1 ||
    run.actor?.id !== reservation.ownerId ||
    run.triggering_actor?.id !== reservation.ownerId ||
    run.actor?.login !== reservation.ownerLogin ||
    run.triggering_actor?.login !== reservation.ownerLogin
  )
    fail();
  return reservation;
}

export async function prepareProbeIntent(
  store,
  input,
  observationInput,
  observedAt,
) {
  const value = snapshotRecorderInput(input);
  recorderExactKeys(value, [
    "identity",
    "material",
    "executingDigests",
    "transactionId",
    "invocationIntent",
  ]);
  const {
    value: identity,
    run,
    approval,
  } = await authenticateRunApproval(store, value.identity);
  const material = await authenticatePreparedProbe(
    store,
    value.material,
    identity,
    value.executingDigests,
  );
  const invocationIntent = matchReservedProbeRun(
    run,
    value.invocationIntent,
    material,
  );
  const observation = snapshotRecorderInput(observationInput);
  recorderExactKeys(observation, [
    "phase",
    "sourceRevision",
    "candidateManifestDigest",
    "issuedAt",
    "expiresAt",
    "controlsReport",
    "pendingStagesState",
    "probeVersionState",
  ]);
  const consumedAt = observedAt ?? new Date().toISOString();
  const controls = projectOperatorControlsReport(
    observation.controlsReport,
    observation.expiresAt,
    consumedAt,
  );
  const checkpoint = {
    ...observation,
    ...controls,
    consumedAt,
    ownerIdentity: identity.owner,
    state: "consumed-for-probe",
    authenticationDigest: sha256(canonicalJson({ run, approval, observation })),
  };
  const tuple = validateStageTuple({
    kind: "probe",
    transactionId: value.transactionId,
    candidateManifestDigest: sha256(canonicalJson(material)),
    tarballSha256: material.tarballSha256,
    integrity: material.integrity,
    sourceRevision: identity.sourceRevision,
    protectedTag: null,
    package: "agentscope-cli",
    version: material.version,
    distTag: "oidc-probe",
    workflowDigest: material.workflowDigest,
    releaseScriptsDigest: material.releaseScriptsDigest,
    ownerCheckpointDigest: sha256(canonicalJson(checkpoint)),
  });
  const unsigned = {
    schemaVersion: 1,
    kind: "probe-stage-intent",
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    sourceRevision: identity.sourceRevision,
    material,
    tuple,
    ownerCheckpoint: checkpoint,
    invocationIntent,
  };
  return validateProbeIntent(
    { ...unsigned, digest: sha256(canonicalJson(unsigned)) },
    consumedAt,
    true,
  );
}

async function authenticateProbeIntent(store, input, observedAt, forStage) {
  const value = snapshotRecorderInput(input);
  recorderExactKeys(value, [
    "identity",
    "intent",
    "intentDigest",
    "executingDigests",
  ]);
  const { value: identity, run } = await authenticateRunApproval(
    store,
    value.identity,
  );
  const intent = validateProbeIntent(value.intent, observedAt, forStage);
  matchReservedProbeRun(run, intent.invocationIntent, intent.material);
  if (
    intent.digest !== value.intentDigest ||
    intent.runId !== identity.runId ||
    intent.runAttempt !== identity.runAttempt ||
    intent.sourceRevision !== identity.sourceRevision
  )
    fail();
  await authenticatePreparedProbe(
    store,
    intent.material,
    identity,
    value.executingDigests,
  );
  return intent;
}

export async function stageRetainedProbe(
  store,
  input,
  tarballPath,
  deadline,
  execution = {},
) {
  const intent = await authenticateProbeIntent(
    store,
    input,
    new Date().toISOString(),
    true,
  );
  const facts = verifyInertProbeTarball({ tarballPath, tuple: intent.tuple });
  const bytes = readFileSync(tarballPath);
  if (
    bytes.length !== facts.bytes ||
    sha256(bytes) !== intent.tuple.tarballSha256
  )
    fail();
  const root = mkdtempSync(join(tmpdir(), "agentscope-inert-probe-"));
  const path = join(root, intent.material.tarballFilename);
  let created = false;
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    created = true;
    verifyInertProbeTarball({ tarballPath: path, tuple: intent.tuple });
    validateProbeIntent(intent, new Date().toISOString(), true);
    const boundedDeadline = Math.min(
      deadline,
      performance.now() +
        Date.parse(intent.ownerCheckpoint.expiresAt) -
        Date.now(),
    );
    return await produceNpmStage({
      tuple: intent.tuple,
      tarballPath: path,
      deadline: boundedDeadline,
      execFileImpl: execution.execFileImpl,
    });
  } finally {
    if (created) unlinkSync(path);
    rmdirSync(root);
  }
}

export async function recordProbeStagePacket(
  store,
  input,
  stageResult,
  observedAt = new Date().toISOString(),
) {
  const intent = await authenticateProbeIntent(store, input, observedAt, false);
  const result = validateStageResult(stageResult, intent.tuple);
  const unsigned = {
    schemaVersion: 1,
    kind: "retained-probe-stage",
    sourceRevision: intent.sourceRevision,
    runId: intent.runId,
    runAttempt: intent.runAttempt,
    intent,
    stageResult: snapshotRecorderInput(stageResult),
    stageResultDigest: result.stageResultDigest,
    state:
      result.response === "received"
        ? "pending-owner-reconciliation"
        : "frozen-unresolved",
  };
  return snapshotRecorderInput({
    ...unsigned,
    digest: sha256(canonicalJson(unsigned)),
  });
}

// The owner supplies observations of standard npm stage download/reject with
// interactive 2FA. This projection attests the authenticated owner report; it
// neither executes npm nor claims independent npm-server proof.
export async function reconcileProbePacket(
  store,
  input,
  ownerInput,
  observedAt = new Date().toISOString(),
) {
  const value = snapshotRecorderInput(input);
  recorderExactKeys(value, ["identity", "packet", "executingDigests"]);
  const {
    value: identity,
    run,
    approval,
  } = await authenticateRunApproval(store, value.identity);
  const packet = validateProbeStagePacket(value.packet, observedAt);
  await store.protectedMainSource(identity.sourceRevision);
  const intent = packet.intent;
  const result = validateStageResult(packet.stageResult, intent.tuple);
  // Later reviewed manifest commits differ from the actual dispatch source.
  // Preserve that source and prove ancestry plus current code equality instead.
  await store.protectedMainSource(intent.sourceRevision);
  const original = await authenticateRunApproval(store, {
    ...identity,
    runId: intent.runId,
    runAttempt: intent.runAttempt,
    sourceRevision: intent.sourceRevision,
  });
  matchReservedProbeRun(original.run, intent.invocationIntent, intent.material);
  if (
    intent.tuple.workflowDigest !== value.executingDigests.workflowDigest ||
    intent.tuple.releaseScriptsDigest !==
      value.executingDigests.releaseScriptsDigest
  )
    fail();
  const owner = snapshotRecorderInput(ownerInput);
  recorderExactKeys(owner, [
    "phase",
    "packetDigest",
    "issuedAt",
    "expiresAt",
    "controlsReport",
    "stageId",
    "downloadedTarballSha256",
    "downloadedIntegrity",
    "downloadedInventoryDigest",
    "terminalNpmState",
  ]);
  if (
    owner.phase !== "reconcile-probe" ||
    owner.packetDigest !== packet.digest ||
    owner.stageId !== result.stageId ||
    owner.downloadedTarballSha256 !== intent.tuple.tarballSha256 ||
    owner.downloadedIntegrity !== intent.tuple.integrity ||
    owner.downloadedInventoryDigest !== intent.material.inventoryDigest ||
    owner.terminalNpmState !== "rejected"
  )
    fail();
  const controls = projectOperatorControlsReport(
    owner.controlsReport,
    owner.expiresAt,
    observedAt,
  );
  if (controls.controlsInspectedAt !== owner.issuedAt) fail();
  const unsigned = {
    schemaVersion: 1,
    kind: "terminal-inert-oidc-probe",
    repository: "Melbourneandrew/agentscope",
    workflowPath: ".github/workflows/release.yml",
    environment: "npm-release",
    trustedPublisherAction: "stage-publish",
    sourceRevision: intent.sourceRevision,
    runId: intent.runId,
    runAttempt: intent.runAttempt,
    workflowDigest: intent.tuple.workflowDigest,
    releaseScriptsDigest: intent.tuple.releaseScriptsDigest,
    material: intent.material,
    stageId: result.stageId,
    recorderOutputDigest: packet.digest,
    invocationIntentDigest: intent.invocationIntent.digest,
    ownerIdentity: identity.owner,
    ownerObservation: owner,
    ...controls,
    authenticationDigest: sha256(canonicalJson({ run, approval, owner })),
    terminalNpmState: "rejected",
    disposition: "awaiting-reviewed-append-under-release-records/probes",
  };
  return snapshotRecorderInput({
    ...unsigned,
    digest: sha256(canonicalJson(unsigned)),
  });
}

// Candidate validation remains the existing authority; this producer neither
// certifies support evidence nor rebuilds the packed candidate.
export async function prepareDraft(store, input) {
  const {
    manifest,
    certificationRecord,
    tarballPath,
    expectedManifestDigest,
    expectedSourceRevision,
    expectedProtectedTag,
    transactionId,
    retainedAssets,
    authenticatedActor,
  } = input;
  const verified = verifyCandidateArtifact({
    manifest,
    certificationRecord,
    tarballPath,
    expectedManifestDigest,
    expectedSourceRevision,
    expectedProtectedTag,
  });
  if (
    !/^[a-z0-9-]{1,80}$/u.test(transactionId) ||
    typeof authenticatedActor !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(authenticatedActor)
  )
    fail();
  const tarball = readFileSync(tarballPath);
  if (tarball.length !== verified.bytes || sha256(tarball) !== verified.sha256)
    fail();
  const roles = [
    "checksum-manifest.json",
    "support-admission.json",
    "sbom.json",
    "attestations.json",
    "evidence-index.json",
  ];
  if (!Array.isArray(retainedAssets) || retainedAssets.length !== roles.length)
    fail();
  const owned = roles.map((name) => {
    const matches = retainedAssets.filter((entry) => entry.name === name);
    if (
      matches.length !== 1 ||
      !Buffer.isBuffer(matches[0].bytes) ||
      matches[0].bytes.length > 2_097_152 ||
      sha256(matches[0].bytes) !== matches[0].digest
    )
      fail();
    return {
      name,
      bytes: Buffer.from(matches[0].bytes),
      digest: matches[0].digest,
    };
  });
  for (const [name, expected] of [
    ["support-admission.json", certificationRecord.supportAdmissionDigest],
    ["evidence-index.json", certificationRecord.evidenceIndexDigest],
  ]) {
    const artifact = owned.find((entry) => entry.name === name);
    if (
      sha256(canonicalJson(JSON.parse(artifact.bytes.toString("utf8")))) !==
      expected
    )
      fail();
  }
  const releases = await store.releases();
  // Ambiguous creation is never retried or reconciled by creating another
  // release. An existing draft or any active unrelated transaction stops.
  if (
    !Array.isArray(releases) ||
    releases.length >= 100 ||
    releases.some(
      (release) => release.draft || release.tag_name === expectedProtectedTag,
    )
  )
    fail();
  const release = await store.createDraft(
    expectedSourceRevision,
    transactionId,
  );
  if (
    !Number.isSafeInteger(release.id) ||
    release.id < 1 ||
    !release.draft ||
    !release.prerelease ||
    release.tag_name !== expectedProtectedTag
  )
    fail();
  const uploaded = [];
  for (const asset of [
    { name: manifest.tarball.fileName, bytes: tarball },
    { name: "candidate-manifest.json", bytes: encode(manifest) },
    { name: "certification-record.json", bytes: encode(certificationRecord) },
    ...owned,
  ]) {
    uploaded.push(await store.appendAsset(release.id, asset.name, asset.bytes));
  }
  const unsigned = {
    schemaVersion: 1,
    sequence: 1,
    previousDigest: null,
    transition: "draft-prepared",
    transactionId,
    draftReleaseDatabaseId: release.id,
    candidateManifestDigest: expectedManifestDigest,
    sourceRevision: expectedSourceRevision,
    protectedTag: expectedProtectedTag,
    kind: "product",
    actor: authenticatedActor,
    assets: uploaded,
  };
  const record = { ...unsigned, digest: sha256(canonicalJson(unsigned)) };
  await store.appendAsset(
    release.id,
    "release-record-000001.json",
    encode(record),
  );
  return Object.freeze({
    state: "draft-durable-no-stage-executed",
    releaseId: release.id,
    record,
  });
}

function validateObservationContext(observation, value) {
  if (
    observation.pendingStagesState !== "none-conflicting" ||
    observation.phase !== "pre-stage" ||
    observation.sourceRevision !== value.sourceRevision ||
    value.owner !== "Melbourneandrew" ||
    !/^sha256:[a-f0-9]{64}$/u.test(observation.candidateManifestDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(observation.expectedPriorDigest) ||
    !Number.isSafeInteger(observation.expectedSequence) ||
    observation.expectedSequence < 1 ||
    observation.expectedSequence >= 31 ||
    !Number.isSafeInteger(observation.draftReleaseDatabaseId) ||
    observation.draftReleaseDatabaseId < 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(observation.transactionId)
  )
    fail();
}

// Authentication comes from the fixed GitHub API store, never from a caller
// owner label or from a digest of an unauthenticated document.
async function authenticateRunApproval(store, input) {
  const value = snapshotRecorderInput(input);
  recorderExactKeys(value, [
    "runId",
    "runAttempt",
    "sourceRevision",
    "owner",
    "environmentId",
  ]);
  const run = await store.run(value.runId);
  const approvals = await store.approvals(value.runId);
  if (
    run.id !== value.runId ||
    run.head_sha !== value.sourceRevision ||
    run.run_attempt !== value.runAttempt ||
    run.path !== ".github/workflows/release.yml" ||
    run.event !== "workflow_dispatch" ||
    run.actor?.login !== value.owner ||
    run.triggering_actor?.login !== value.owner ||
    run.actor?.id !== 25971425 ||
    run.triggering_actor?.id !== 25971425 ||
    !Array.isArray(approvals)
  )
    fail();
  // The fixed workflow protects both the writer and stage jobs. GitHub's
  // review history may therefore contain multiple approvals by the same owner;
  // global history cardinality is not authentication of a particular job.
  const approval = approvals.filter(
    (entry) =>
      entry.state === "approved" &&
      entry.user?.login === value.owner &&
      entry.user?.id === 25971425 &&
      entry.environments?.some(
        (environment) =>
          environment.id === value.environmentId &&
          environment.name === "npm-release",
      ),
  );
  if (
    !approval.length ||
    approvals.length > 100 ||
    approval.length !== approvals.length
  )
    fail();
  if (value.owner !== "Melbourneandrew") fail();
  return { value, run, approval: approval[0] };
}

export async function authenticateOwnerCheckpoint(
  store,
  input,
  npmObservation,
  observedAt,
) {
  const { value, run, approval } = await authenticateRunApproval(store, input);
  const observation = snapshotRecorderInput(npmObservation);
  recorderExactKeys(observation, [
    "transactionId",
    "draftReleaseDatabaseId",
    "issuedAt",
    "expiresAt",
    "pendingStagesState",
    "phase",
    "sourceRevision",
    "candidateManifestDigest",
    "expectedSequence",
    "expectedPriorDigest",
    "controlsReport",
  ]);
  const issued = Date.parse(observation.issuedAt);
  const expires = Date.parse(observation.expiresAt);
  // Dispatch and environment approval may queue. Consumption is a runner fact,
  // not a timestamp the operator must predict before the job begins. This does
  // not renew the original observation's issuedAt/expiresAt freshness window.
  const consumedAt = observedAt ?? new Date().toISOString();
  const consumed = Date.parse(consumedAt);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    !Number.isFinite(consumed) ||
    [observation.issuedAt, observation.expiresAt, consumedAt].some(
      (time) => new Date(Date.parse(time)).toISOString() !== time,
    ) ||
    expires <= issued ||
    expires - issued > 900_000 ||
    consumed < issued ||
    consumed > expires
  )
    fail();
  validateObservationContext(observation, value);
  const controls = projectOperatorControlsReport(
    observation.controlsReport,
    observation.expiresAt,
    consumedAt,
  );
  if (controls.controlsInspectedAt !== observation.issuedAt) fail();
  const checkpoint = snapshotRecorderInput({
    ...observation,
    ...controls,
    consumedAt,
    ownerIdentity: value.owner,
    state: "consumed-for-stage",
    authenticationDigest: sha256(canonicalJson({ run, approval, observation })),
  });
  authenticated.set(checkpoint, value);
  return checkpoint;
}

const intentHead = (intent) =>
  Object.fromEntries(
    [
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
    ].map((key) => [key, intent[key]]),
  );

async function authenticatedIntent(store, value) {
  const { value: identity } = await authenticateRunApproval(
    store,
    value.identity,
  );
  await store.protectedSource(identity.sourceRevision);
  const intent = await readLatestRecord(store, value.releaseId);
  if (
    intent.transition !== "pre-stage-intent" ||
    intent.digest !== value.intentDigest ||
    intent.runId !== identity.runId ||
    intent.runAttempt !== identity.runAttempt ||
    intent.sourceRevision !== identity.sourceRevision
  )
    fail();
  // Fresh API principal/approval authentication is independent of the recorded
  // authentication digest. Mutable API run metadata cannot be replayed as a
  // new checkpoint, and no digest substitutes for the fixed authenticated run.
  const tuple = await bindIntentTuple(
    store,
    intent,
    intent.tuple,
    value.executingDigests,
  );
  return { intent, tuple };
}

// This is the protected product job's composition, not a new admission source.
// The entrypoint's actual semantic guard remains mandatory and disabled.
export async function stageRetainedCandidate(
  store,
  input,
  candidate,
  execution = {},
) {
  const value = snapshotRecorderInput(input);
  recorderExactKeys(value, [
    "releaseId",
    "intentDigest",
    "identity",
    "executingDigests",
    "deadline",
  ]);
  const { intent, tuple } = await authenticatedIntent(store, value);
  const checkpoint = intent.ownerCheckpoint;
  const verified = verifyCandidateArtifact({
    ...candidate,
    expectedManifestDigest: tuple.candidateManifestDigest,
    expectedSourceRevision: tuple.sourceRevision,
    expectedProtectedTag: tuple.protectedTag,
  });
  const bytes = readFileSync(candidate.tarballPath);
  if (
    bytes.length !== verified.bytes ||
    sha256(bytes) !== tuple.tarballSha256 ||
    candidate.manifest.tarball.integrity !== tuple.integrity ||
    !Number.isFinite(value.deadline)
  )
    fail();
  const root = mkdtempSync(join(tmpdir(), "agentscope-npm-stage-"));
  const path = join(root, "agentscope-cli-0.1.0.tgz");
  let created = false;
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    created = true;
    verifyCandidateArtifact({
      ...candidate,
      tarballPath: path,
      expectedManifestDigest: tuple.candidateManifestDigest,
      expectedSourceRevision: tuple.sourceRevision,
      expectedProtectedTag: tuple.protectedTag,
    });
    const current = await readLatestRecord(store, value.releaseId);
    if (current.digest !== intent.digest) fail();
    const observedAt = new Date().toISOString();
    validateStageCheckpoint({
      tuple,
      head: intentHead(intent),
      ownerCheckpoint: checkpoint,
      observedAt,
    });
    // The original owner expiry also caps version acquisition and the mutation;
    // npm preflight cannot renew it. There is exactly one producer invocation.
    const deadline = Math.min(
      value.deadline,
      performance.now() + Date.parse(checkpoint.expiresAt) - Date.now(),
    );
    return await produceNpmStage({
      tuple,
      tarballPath: path,
      deadline,
      execFileImpl: execution.execFileImpl,
    });
  } finally {
    // Trusted npm direct-child callback/stdio closure precedes exact owned cleanup.
    if (created) unlinkSync(path);
    rmdirSync(root);
  }
}

// Fixed dependent-job output acquisition belongs to the protected entrypoint.
// Authenticate the same API principal/intent again, but do not renew expiry or
// discard an uncertain stage merely because recording occurs after expiry.
export async function recordStageFromJob(store, input) {
  const value = snapshotRecorderInput(input);
  recorderExactKeys(value, [
    "releaseId",
    "intentDigest",
    "identity",
    "executingDigests",
    "stageResult",
    "observedAt",
  ]);
  await authenticatedIntent(store, value);
  return recordStage(store, {
    releaseId: value.releaseId,
    intentDigest: value.intentDigest,
    runId: value.identity.runId,
    runAttempt: value.identity.runAttempt,
    stageResult: value.stageResult,
    observedAt: value.observedAt,
    actor: value.identity.owner,
  });
}

export async function bindIntentTuple(store, head, input, executingDigests) {
  const tuple = validateStageTuple(input);
  const assets = await store.assets(head.draftReleaseDatabaseId);
  const matches = assets.filter(
    (entry) => entry.name === "candidate-manifest.json",
  );
  if (matches.length !== 1 || matches[0].size > 65_536) fail();
  const bytes = await store.readAsset(matches[0].id);
  if (sha256(bytes) !== matches[0].digest || bytes.length !== matches[0].size)
    fail();
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (
    sha256(canonicalJson(manifest)) !== head.candidateManifestDigest ||
    tuple.candidateManifestDigest !== head.candidateManifestDigest ||
    tuple.kind !== "product" ||
    tuple.sourceRevision !== manifest.sourceRevision ||
    tuple.protectedTag !== manifest.protectedTag ||
    tuple.tarballSha256 !== manifest.tarball.sha256 ||
    tuple.integrity !== manifest.tarball.integrity ||
    tuple.package !== manifest.package.name ||
    tuple.version !== manifest.package.version ||
    tuple.distTag !== manifest.channel.npmDistTag ||
    tuple.transactionId !== head.transactionId ||
    tuple.workflowDigest !== executingDigests.workflowDigest ||
    tuple.releaseScriptsDigest !== executingDigests.releaseScriptsDigest
  )
    fail();
  return tuple;
}

export async function readLatestRecord(
  store,
  releaseId,
  allowImmutable = false,
) {
  const release = await store.release(releaseId);
  if (
    (!release.draft && !(allowImmutable && release.immutable === true)) ||
    !release.prerelease ||
    release.tag_name !== "v0.1.0"
  )
    fail();
  const entries = (await store.assets(releaseId)).filter((entry) =>
    /^release-record-\d{6}\.json$/u.test(entry.name),
  );
  if (!entries.length || entries.length > 32) fail();
  entries.sort((a, b) => a.name.localeCompare(b.name));
  let previous = null;
  let latest;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (
      entry.name !==
        `release-record-${String(index + 1).padStart(6, "0")}.json` ||
      entry.size > 65_536
    )
      fail();
    const bytes = await store.readAsset(entry.id);
    if (bytes.length !== entry.size || sha256(bytes) !== entry.digest) fail();
    const record = JSON.parse(bytes.toString("utf8"));
    const { digest, ...unsigned } = record;
    if (
      record.sequence !== index + 1 ||
      record.previousDigest !== previous ||
      record.draftReleaseDatabaseId !== releaseId ||
      digest !== sha256(canonicalJson(unsigned))
    )
      fail();
    latest = record;
    previous = digest;
  }
  return latest;
}

export function prepareIntent(input, checkpoint) {
  if (!authenticated.has(checkpoint)) fail();
  const identity = authenticated.get(checkpoint);
  const value = snapshotRecorderInput(input);
  recorderExactKeys(value, [
    "tuple",
    "head",
    "expectedPriorDigest",
    "expectedSequence",
    "consumedAt",
  ]);
  const tuple = validateStageTuple(value.tuple);
  const head = value.head;
  recorderExactKeys(head, [
    "schemaVersion",
    "sequence",
    "digest",
    "transition",
    "transactionId",
    "draftReleaseDatabaseId",
    "candidateManifestDigest",
    "sourceRevision",
    "kind",
  ]);
  if (
    tuple.kind !== "product" ||
    tuple.sourceRevision !== identity.sourceRevision ||
    head.schemaVersion !== 1 ||
    head.sourceRevision !== tuple.sourceRevision ||
    head.kind !== "product" ||
    !/^sha256:[a-f0-9]{64}$/u.test(head.digest) ||
    head.transition !== "draft-prepared" ||
    head.digest !== value.expectedPriorDigest ||
    head.sequence !== value.expectedSequence ||
    head.transactionId !== tuple.transactionId ||
    head.candidateManifestDigest !== tuple.candidateManifestDigest ||
    tuple.ownerCheckpointDigest !== sha256(canonicalJson(checkpoint)) ||
    checkpoint.transactionId !== tuple.transactionId ||
    checkpoint.draftReleaseDatabaseId !== head.draftReleaseDatabaseId ||
    checkpoint.phase !== "pre-stage" ||
    checkpoint.sourceRevision !== tuple.sourceRevision ||
    checkpoint.candidateManifestDigest !== tuple.candidateManifestDigest ||
    checkpoint.expectedSequence !== head.sequence ||
    checkpoint.expectedPriorDigest !== head.digest ||
    value.consumedAt !== checkpoint.consumedAt ||
    !Number.isSafeInteger(head.draftReleaseDatabaseId) ||
    head.draftReleaseDatabaseId < 1 ||
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 1 ||
    head.sequence >= 31 ||
    head.sequence >= Number.MAX_SAFE_INTEGER ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value.consumedAt)
  )
    fail();
  const unsigned = {
    schemaVersion: 1,
    sequence: head.sequence + 1,
    previousDigest: head.digest,
    transition: "pre-stage-intent",
    transactionId: tuple.transactionId,
    draftReleaseDatabaseId: head.draftReleaseDatabaseId,
    candidateManifestDigest: tuple.candidateManifestDigest,
    sourceRevision: tuple.sourceRevision,
    kind: tuple.kind,
    tuple,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    ownerCheckpointDigest: tuple.ownerCheckpointDigest,
    ownerCheckpoint: checkpoint,
    consumedAt: value.consumedAt,
  };
  return snapshotRecorderInput({
    ...unsigned,
    digest: sha256(canonicalJson(unsigned)),
  });
}

// No stage invocation exists here. Successful durable readback is a necessary
// predecessor, not permission to publish. The protected continuation must also
// compare the latest chain head and retain unknown-stage quarantine.
export async function consumeIntent(store, intent, latestHead) {
  const record = snapshotRecorderInput(intent);
  const { digest, ...unsigned } = record;
  if (
    record.transition !== "pre-stage-intent" ||
    latestHead.digest !== record.previousDigest ||
    latestHead.sequence + 1 !== record.sequence ||
    sha256(canonicalJson(unsigned)) !== digest
  )
    fail();
  const name = `release-record-${String(record.sequence).padStart(6, "0")}.json`;
  const current = await readLatestRecord(store, record.draftReleaseDatabaseId);
  if (
    current.digest !== latestHead.digest ||
    current.sequence !== latestHead.sequence
  )
    fail();
  const result = await store.appendAsset(
    record.draftReleaseDatabaseId,
    name,
    encode(record),
  );
  const after = await readLatestRecord(store, record.draftReleaseDatabaseId);
  if (after.digest !== record.digest || after.sequence !== record.sequence)
    fail();
  return Object.freeze({
    state: "intent-durable-no-stage-executed",
    intent: record,
    asset: result,
  });
}

// The future protected stage-result acquisition must authenticate provenance
// before this function. These equality checks are not a signature, nor do they
// authorize a stage. A missing/ambiguous result stays a durable unresolved head.
export async function recordStage(store, input) {
  const value = snapshotRecorderInput(input);
  recorderExactKeys(value, [
    "releaseId",
    "intentDigest",
    "runId",
    "runAttempt",
    "stageResult",
    "observedAt",
    "actor",
  ]);
  const intent = await readLatestRecord(store, value.releaseId);
  if (
    intent.transition !== "pre-stage-intent" ||
    intent.digest !== value.intentDigest ||
    intent.runId !== value.runId ||
    intent.runAttempt !== value.runAttempt
  )
    fail();
  const proposal = proposeStageRecord({
    tuple: intent.tuple,
    head: {
      schemaVersion: intent.schemaVersion,
      sequence: intent.sequence,
      digest: intent.digest,
      previousDigest: intent.previousDigest,
      transition: intent.transition,
      transactionId: intent.transactionId,
      draftReleaseDatabaseId: intent.draftReleaseDatabaseId,
      candidateManifestDigest: intent.candidateManifestDigest,
      sourceRevision: intent.sourceRevision,
      kind: intent.kind,
      ownerCheckpointDigest: intent.ownerCheckpointDigest,
    },
    expectedSequence: intent.sequence,
    expectedPriorDigest: intent.digest,
    ownerCheckpoint: intent.ownerCheckpoint,
    stageResult: value.stageResult,
    observedAt: value.observedAt,
    actor: value.actor,
  });
  const current = await readLatestRecord(store, value.releaseId);
  if (current.digest !== intent.digest) fail();
  const record = proposal.record;
  // All records in the same chain retain the draft database identity at root.
  const unsigned = { ...record };
  delete unsigned.digest;
  const durable = {
    ...unsigned,
    draftReleaseDatabaseId: value.releaseId,
    tuple: intent.tuple,
    stageRunId: intent.runId,
    stageRunAttempt: intent.runAttempt,
  };
  const result = { ...durable, digest: sha256(canonicalJson(durable)) };
  await store.appendAsset(
    value.releaseId,
    `release-record-${String(result.sequence).padStart(6, "0")}.json`,
    encode(result),
  );
  const after = await readLatestRecord(store, value.releaseId);
  if (after.digest !== result.digest) fail();
  return after;
}

async function appendPublicationRecord(store, head, transition, fields) {
  const current = await readLatestRecord(store, head.draftReleaseDatabaseId);
  if (
    current.sequence !== head.sequence ||
    current.digest !== head.digest ||
    head.sequence >= 31
  )
    fail();
  const unsigned = {
    schemaVersion: 1,
    sequence: head.sequence + 1,
    previousDigest: head.digest,
    transactionId: head.transactionId,
    draftReleaseDatabaseId: head.draftReleaseDatabaseId,
    candidateManifestDigest: head.candidateManifestDigest,
    sourceRevision: head.sourceRevision,
    protectedTag: "v0.1.0",
    kind: "product",
    transition,
    tuple: head.tuple,
    stageRunId: head.stageRunId,
    stageRunAttempt: head.stageRunAttempt,
    ...fields,
  };
  const record = { ...unsigned, digest: sha256(canonicalJson(unsigned)) };
  await store.appendAsset(
    head.draftReleaseDatabaseId,
    `release-record-${String(record.sequence).padStart(6, "0")}.json`,
    encode(record),
  );
  const after = await readLatestRecord(store, head.draftReleaseDatabaseId);
  if (after.digest !== record.digest || after.sequence !== record.sequence)
    fail();
  return after;
}

async function assertSelectedReleaseFence(store, releaseId) {
  const releases = await store.releases();
  if (
    !Array.isArray(releases) ||
    releases.length >= 100 ||
    releases.filter((release) => release.id === releaseId).length !== 1 ||
    releases.some(
      (release) =>
        release.id !== releaseId &&
        (release.draft || release.immutable !== true),
    ) ||
    releases.filter((release) => release.tag_name === "v0.1.0").length !== 1 ||
    releases.find((release) => release.id === releaseId).tag_name !== "v0.1.0"
  )
    fail();
}

// Owner-only pending-stage list/download facts are explicitly attestations.
// Ordinary npm stage approve <exact UUID> remains an interactive owner action,
// never invoked by this workflow or by an Actions/OIDC token.
export async function recordPublicationCheckpoint(
  store,
  input,
  observation,
  consume = false,
) {
  const value = snapshotRecorderInput(input);
  recorderExactKeys(value, [
    "identity",
    "releaseId",
    "expectedSequence",
    "expectedPriorDigest",
    "observedAt",
    "executingDigests",
  ]);
  const {
    value: identity,
    run,
    approval,
  } = await authenticateRunApproval(store, value.identity);
  await store.protectedSource(identity.sourceRevision);
  await assertSelectedReleaseFence(store, value.releaseId);
  const head = await readLatestRecord(store, value.releaseId);
  if (
    run.head_branch !== "v0.1.0" ||
    head.sourceRevision !== identity.sourceRevision ||
    head.sequence !== value.expectedSequence ||
    head.digest !== value.expectedPriorDigest ||
    !(consume
      ? head.transition === "publication-checkpoint"
      : ["stage-recorded", "publication-checkpoint"].includes(head.transition))
  )
    fail();
  await bindIntentTuple(store, head, head.tuple, value.executingDigests);
  const checkpoint = validatePublicationObservation(
    observation,
    head,
    value.observedAt,
    consume,
  );
  const authenticatedCheckpoint = {
    ...checkpoint,
    ownerIdentity: identity.owner,
    state: consume
      ? "consumed-before-interactive-approval"
      : "valid-unconsumed",
    authenticationDigest: sha256(
      canonicalJson({ run, approval, observation: checkpoint }),
    ),
  };
  if (consume) {
    authenticatedCheckpoint.originalCheckpointDigest = sha256(
      canonicalJson(head.checkpoint),
    );
    authenticatedCheckpoint.consumedAt = value.observedAt;
  }
  return appendPublicationRecord(
    store,
    head,
    consume ? "publication-consumed" : "publication-checkpoint",
    {
      checkpoint: authenticatedCheckpoint,
      actor: identity.owner,
      runId: identity.runId,
      runAttempt: identity.runAttempt,
    },
  );
}

export async function recordPublicationApproval(store, input, ownerReport) {
  const value = snapshotRecorderInput(input);
  recorderExactKeys(value, [
    "identity",
    "releaseId",
    "expectedSequence",
    "expectedPriorDigest",
    "observedAt",
    "executingDigests",
  ]);
  const {
    value: identity,
    run,
    approval,
  } = await authenticateRunApproval(store, value.identity);
  await store.protectedSource(identity.sourceRevision);
  await assertSelectedReleaseFence(store, value.releaseId);
  const head = await readLatestRecord(store, value.releaseId);
  if (
    head.transition !== "publication-consumed" ||
    run.head_branch !== "v0.1.0" ||
    head.sourceRevision !== identity.sourceRevision ||
    head.sequence !== value.expectedSequence ||
    head.digest !== value.expectedPriorDigest
  )
    fail();
  await bindIntentTuple(store, head, head.tuple, value.executingDigests);
  const report = snapshotRecorderInput(ownerReport);
  recorderExactKeys(report, [
    "stageId",
    "checkpointDigest",
    "transactionRecordDigest",
    "state",
    "approvedAt",
  ]);
  const time = Date.parse(report.approvedAt);
  if (
    report.stageId !== head.checkpoint.stageId ||
    report.checkpointDigest !== sha256(canonicalJson(head.checkpoint)) ||
    report.transactionRecordDigest !== head.digest ||
    report.state !== "approved" ||
    !Number.isFinite(time) ||
    new Date(time).toISOString() !== report.approvedAt ||
    time < Date.parse(head.checkpoint.consumedAt) ||
    time >= Date.parse(head.checkpoint.expiresAt) ||
    time > Date.parse(value.observedAt)
  )
    fail();
  return appendPublicationRecord(store, head, "approval-reported", {
    checkpoint: head.checkpoint,
    approval: {
      ...report,
      ownerIdentity: identity.owner,
      authenticationDigest: sha256(canonicalJson({ run, approval, report })),
    },
    actor: identity.owner,
  });
}

// Credential-free ordinary children only. This is the existing npm/installed
// smoke process boundary, not an authorization kernel or process-set oracle.
function publicationChildRunner(deadline, root, execFileImpl) {
  const env = Object.fromEntries(
    ["PATH", "LANG", "SystemRoot"]
      .filter((key) => typeof process.env[key] === "string")
      .map((key) => [key, process.env[key]]),
  );
  Object.assign(env, {
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    npm_config_cache: join(root, "cache"),
    npm_config_userconfig: join(root, "empty-npmrc"),
    npm_config_registry: "https://registry.npmjs.org",
    NO_COLOR: "1",
  });
  return async (command, args, cwd = root) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) fail();
    return new Promise((resolve, reject) => {
      try {
        execFileImpl(
          command,
          args,
          {
            cwd,
            env,
            encoding: "buffer",
            maxBuffer: 2_097_152,
            timeout: remaining,
            killSignal: "SIGKILL",
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            if (
              error ||
              performance.now() >= deadline ||
              types.isProxy(stdout) ||
              types.isProxy(stderr) ||
              !Buffer.isBuffer(stdout) ||
              !Buffer.isBuffer(stderr) ||
              stdout.length > 2_097_152 ||
              stderr.length > 65_536
            )
              reject(new Error("release.recording.unresolved"));
            else resolve(Buffer.from(stdout));
          },
        );
      } catch {
        reject(new Error("release.recording.unresolved"));
      }
    });
  };
}

function validateNpmStatement(statement, head) {
  const definition = statement.predicate?.buildDefinition;
  const workflow = definition?.externalParameters?.workflow;
  const dependencies = definition?.resolvedDependencies;
  if (
    statement.predicateType !== "https://slsa.dev/provenance/v1" ||
    workflow?.repository !== "https://github.com/Melbourneandrew/agentscope" ||
    workflow.path !== ".github/workflows/release.yml" ||
    workflow.ref !== "refs/tags/v0.1.0" ||
    !Array.isArray(dependencies) ||
    dependencies.length !== 1 ||
    dependencies[0].uri !==
      "git+https://github.com/Melbourneandrew/agentscope@refs/tags/v0.1.0" ||
    dependencies[0].digest?.gitCommit !== head.sourceRevision ||
    statement.predicate?.runDetails?.metadata?.invocationId !==
      `https://github.com/Melbourneandrew/agentscope/actions/runs/${head.stageRunId}/attempts/${head.stageRunAttempt}`
  )
    fail();
}

async function readRegistryMetadata(run, tuple, head) {
  const metadata = parseAdmissionDocument(
    await run("npm", [
      "view",
      "agentscope-cli@0.1.0",
      "--json",
      "--registry",
      "https://registry.npmjs.org",
    ]),
  );
  const tags = parseAdmissionDocument(
    await run("npm", [
      "view",
      "agentscope-cli",
      "dist-tags",
      "--json",
      "--registry",
      "https://registry.npmjs.org",
    ]),
  );
  if (
    metadata.name !== tuple.package ||
    metadata.version !== tuple.version ||
    (metadata.bin?.agentscope !== "dist/bin/agentscope.js" &&
      metadata.bin?.agentscope !== "./dist/bin/agentscope.js") ||
    Object.keys(metadata.bin ?? {}).length !== 1 ||
    metadata.dist?.integrity !== tuple.integrity ||
    metadata.dist?.tarball !==
      "https://registry.npmjs.org/agentscope-cli/-/agentscope-cli-0.1.0.tgz" ||
    canonicalJson(tags) !==
      canonicalJson({ ...head.checkpoint.distTags, alpha: "0.1.0" })
  )
    fail();
  return { metadata, tags };
}

async function runInstalledPublicationSmoke(run, root, tarball, tuple) {
  const smoke = parseAdmissionDocument(
    await run(
      process.execPath,
      [
        "--import",
        "tsx",
        new URL(
          "../../apps/cli/scripts/verify-installed-smoke.ts",
          import.meta.url,
        ).pathname,
        "--executable",
        join(root, "node_modules/.bin/agentscope"),
        "--tarball",
        tarball,
        "--installed-package-root",
        join(root, "node_modules/agentscope-cli"),
        "--expected-version",
        "0.1.0",
      ],
      new URL("../..", import.meta.url).pathname,
    ),
  );
  if (
    smoke.schema !== "agentscope.cli.installed-smoke.v1" ||
    smoke.scope !== "packed-public-command-smoke" ||
    smoke.package !== tuple.package ||
    smoke.version !== tuple.version ||
    smoke.candidateDigest !== tuple.tarballSha256 ||
    !Number.isSafeInteger(smoke.checkCount) ||
    smoke.checkCount <= 80
  )
    fail();
  return smoke;
}

function validateRegistryContinuationPacket(registryPacket, value, head) {
  const packet = snapshotRecorderInput(registryPacket);
  recorderExactKeys(packet, [
    "schemaVersion",
    "sourceRevision",
    "transactionRecordDigest",
    "candidateManifestDigest",
    "registryMetadataDigest",
    "distTags",
    "downloadedTarballSha256",
    "integrity",
    "provenanceDigest",
    "installedSmokeDigest",
    "state",
    "runId",
    "runAttempt",
    "workflowDigest",
    "releaseScriptsDigest",
  ]);
  if (
    packet.schemaVersion !== 1 ||
    packet.state !== "registry-and-installed-smoke-verified" ||
    packet.runId !== value.identity.runId ||
    packet.runAttempt !== value.identity.runAttempt ||
    packet.sourceRevision !== head.sourceRevision ||
    packet.transactionRecordDigest !== head.digest ||
    packet.candidateManifestDigest !== head.candidateManifestDigest ||
    packet.downloadedTarballSha256 !== head.tuple.tarballSha256 ||
    packet.integrity !== head.tuple.integrity ||
    packet.workflowDigest !== value.executingDigests.workflowDigest ||
    packet.releaseScriptsDigest !==
      value.executingDigests.releaseScriptsDigest ||
    canonicalJson(packet.distTags) !==
      canonicalJson({ ...head.checkpoint.distTags, alpha: "0.1.0" }) ||
    [
      packet.registryMetadataDigest,
      packet.provenanceDigest,
      packet.installedSmokeDigest,
    ].some((hash) => !/^sha256:[a-f0-9]{64}$/u.test(hash))
  )
    fail();
  return packet;
}

function validateContinuationControls(controlsObservation, value) {
  const fresh = snapshotRecorderInput(controlsObservation);
  recorderExactKeys(fresh, ["controlsReport", "issuedAt", "expiresAt"]);
  const controls = projectOperatorControlsReport(
    fresh.controlsReport,
    fresh.expiresAt,
    value.observedAt,
  );
  const issued = Date.parse(fresh.issuedAt);
  const expires = Date.parse(fresh.expiresAt);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    expires <= issued ||
    expires - issued > 900_000 ||
    Date.parse(value.observedAt) < issued ||
    Date.parse(value.observedAt) >= expires ||
    controls.controlsInspectedAt !== fresh.issuedAt
  )
    fail();
  return { controls, expires };
}

function verifiedNpmProvenance(bytes, head) {
  const value = parseAdmissionDocument(bytes);
  if (
    !Array.isArray(value.invalid) ||
    value.invalid.length ||
    !Array.isArray(value.missing) ||
    value.missing.length ||
    !Array.isArray(value.verified)
  )
    fail();
  const packages = value.verified.filter(
    (entry) => entry.name === "agentscope-cli" && entry.version === "0.1.0",
  );
  if (
    packages.length !== 1 ||
    packages[0].registry !== "https://registry.npmjs.org/" ||
    !Array.isArray(packages[0].attestationBundles)
  )
    fail();
  const proofs = packages[0].attestationBundles.filter(
    (entry) => entry.predicateType === "https://slsa.dev/provenance/v1",
  );
  if (
    proofs.length !== 1 ||
    typeof proofs[0].bundle?.dsseEnvelope?.payload !== "string"
  )
    fail();
  const statement = parseAdmissionDocument(
    Buffer.from(proofs[0].bundle.dsseEnvelope.payload, "base64"),
  );
  validateNpmStatement(statement, head);
  return sha256(canonicalJson(proofs[0]));
}

// Executed ONLY by the fixed separate no-write/no-OIDC verification job. The
// privileged publisher consumes its same-run artifact, never loads the CLI.
export async function verifyRegistryPublication(
  headInput,
  candidate,
  deadline,
  execution = {},
) {
  const head = snapshotRecorderInput(headInput);
  if (
    !["approval-reported", "ready-to-publish"].includes(head.transition) ||
    !Number.isFinite(deadline)
  )
    fail();
  const tuple = validateStageTuple(head.tuple);
  // The ordinary entry returns only these retained candidate inputs. Expected
  // identities come from the authenticated record, never fixture/caller extras.
  verifyCandidateArtifact({
    manifest: candidate.manifest,
    certificationRecord: candidate.certificationRecord,
    tarballPath: candidate.tarballPath,
    expectedManifestDigest: head.candidateManifestDigest,
    expectedSourceRevision: head.sourceRevision,
    expectedProtectedTag: "v0.1.0",
  });
  const root = mkdtempSync(join(tmpdir(), "agentscope-registry-install-"));
  try {
    mkdirSync(join(root, "home"), { mode: 0o700 });
    writeFileSync(join(root, "empty-npmrc"), "", { flag: "wx", mode: 0o600 });
    const run = publicationChildRunner(
      deadline,
      root,
      execution.execFileImpl ?? execFile,
    );
    const npmVersion = await run("npm", ["--version"]);
    if (!/^11\.17\.0\r?\n?$/u.test(npmVersion.toString("utf8"))) fail();
    const { metadata, tags } = await readRegistryMetadata(run, tuple, head);
    // A fresh exact-version install uses the public registry, ordinary lifecycle
    // behavior and no candidate rebuild. Its tarball is downloaded independently.
    const packed = parseAdmissionDocument(
      await run("npm", [
        "pack",
        "agentscope-cli@0.1.0",
        "--json",
        "--ignore-scripts",
        "--registry",
        "https://registry.npmjs.org",
      ]),
    );
    if (
      !Array.isArray(packed) ||
      packed.length !== 1 ||
      packed[0].filename !== "agentscope-cli-0.1.0.tgz"
    )
      fail();
    const tarball = join(root, "agentscope-cli-0.1.0.tgz");
    const facts = inspectCandidateTarball(tarball);
    if (
      facts.sha256 !== tuple.tarballSha256 ||
      facts.integrity !== tuple.integrity
    )
      fail();
    await run("npm", [
      "install",
      "agentscope-cli@0.1.0",
      "--save-exact",
      "--no-audit",
      "--no-fund",
      "--registry",
      "https://registry.npmjs.org",
    ]);
    const lock = parseAdmissionDocument(
      readFileSync(join(root, "package-lock.json")),
    );
    const installed = lock.packages?.["node_modules/agentscope-cli"];
    if (
      installed?.version !== tuple.version ||
      installed.integrity !== tuple.integrity ||
      installed.resolved !== metadata.dist.tarball
    )
      fail();
    const audit = await run("npm", [
      "audit",
      "signatures",
      "--json",
      "--include-attestations",
      "--registry",
      "https://registry.npmjs.org",
    ]);
    const provenanceDigest = verifiedNpmProvenance(audit, head);
    const smoke = await runInstalledPublicationSmoke(run, root, tarball, tuple);
    return snapshotRecorderInput({
      schemaVersion: 1,
      sourceRevision: head.sourceRevision,
      transactionRecordDigest: head.digest,
      candidateManifestDigest: head.candidateManifestDigest,
      registryMetadataDigest: sha256(canonicalJson(metadata)),
      distTags: tags,
      downloadedTarballSha256: facts.sha256,
      integrity: facts.integrity,
      provenanceDigest,
      installedSmokeDigest: sha256(canonicalJson(smoke)),
      state: "registry-and-installed-smoke-verified",
    });
  } finally {
    rmSync(root, { recursive: true, force: false });
  }
}

export async function readPublicationForVerification(store, input) {
  const value = snapshotRecorderInput(input);
  recorderExactKeys(value, [
    "identity",
    "releaseId",
    "expectedSequence",
    "expectedPriorDigest",
    "executingDigests",
  ]);
  const run = await store.run(value.identity.runId);
  if (
    run.id !== value.identity.runId ||
    run.run_attempt !== value.identity.runAttempt ||
    run.head_sha !== value.identity.sourceRevision ||
    run.head_branch !== "v0.1.0" ||
    run.path !== ".github/workflows/release.yml" ||
    run.event !== "workflow_dispatch" ||
    run.actor?.id !== 25971425 ||
    run.triggering_actor?.id !== 25971425 ||
    run.actor?.login !== "Melbourneandrew" ||
    run.triggering_actor?.login !== "Melbourneandrew"
  )
    fail();
  await store.protectedSource(value.identity.sourceRevision);
  await assertSelectedReleaseFence(store, value.releaseId);
  const head = await readLatestRecord(store, value.releaseId, true);
  if (
    !["approval-reported", "ready-to-publish"].includes(head.transition) ||
    head.sourceRevision !== value.identity.sourceRevision ||
    head.sequence !== value.expectedSequence ||
    head.digest !== value.expectedPriorDigest
  )
    fail();
  await bindIntentTuple(store, head, head.tuple, value.executingDigests);
  return head;
}

async function verifyRetainedReleaseAssets(store, releaseId) {
  const assets = await store.assets(releaseId);
  const initial = assets.filter(
    (entry) => entry.name === "release-record-000001.json",
  );
  if (initial.length !== 1) fail();
  const initialBytes = await store.readAsset(initial[0].id);
  if (sha256(initialBytes) !== initial[0].digest) fail();
  const first = parseAdmissionDocument(initialBytes);
  if (first.transition !== "draft-prepared" || !Array.isArray(first.assets))
    fail();
  const retained = assets.filter(
    (entry) => !/^release-record-\d{6}\.json$/u.test(entry.name),
  );
  if (
    retained.length !== first.assets.length ||
    retained.some(
      (entry) =>
        first.assets.filter(
          (original) =>
            original.id === entry.id &&
            original.name === entry.name &&
            original.size === entry.size &&
            original.digest === entry.digest,
        ).length !== 1,
    )
  )
    fail();
  const expected = new Set();
  for (const asset of assets) {
    if (
      expected.has(asset.name) ||
      asset.state !== "uploaded" ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0 ||
      asset.size > 52_428_800
    )
      fail();
    expected.add(asset.name);
    const bytes = await store.readAsset(asset.id);
    if (bytes.length !== asset.size || sha256(bytes) !== asset.digest) fail();
  }
  return sha256(
    canonicalJson(
      assets
        .map(({ id, name, size, digest }) => ({ id, name, size, digest }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ),
  );
}

// The fixed workflow's same-run no-write job supplies this packet, not an event
// field. Durable ready bytes precede the only PATCH; completion is a reviewed
// protected-main append, not a success announcement or mutable Release asset.
export async function continuePublication(
  store,
  input,
  registryPacket,
  controlsObservation,
) {
  const value = snapshotRecorderInput(input);
  recorderExactKeys(value, [
    "identity",
    "releaseId",
    "expectedSequence",
    "expectedPriorDigest",
    "executingDigests",
    "observedAt",
  ]);
  const { run, approval } = await authenticateRunApproval(
    store,
    value.identity,
  );
  const verificationInput = { ...value };
  delete verificationInput.observedAt;
  const head = await readPublicationForVerification(store, verificationInput);
  const packet = validateRegistryContinuationPacket(
    registryPacket,
    value,
    head,
  );
  // Fresh controls may be inspected after approval; they do not extend or renew
  // the publication checkpoint whose consumed/approved times are already fixed.
  const { controls, expires } = validateContinuationControls(
    controlsObservation,
    value,
  );
  await store.protectedSource(head.sourceRevision);
  const assetsDigest = await verifyRetainedReleaseAssets(
    store,
    value.releaseId,
  );
  const attestationVerifierDigest = await store.verifyAttestationCapability();
  if (Date.now() >= expires) fail();
  const ready =
    head.transition === "ready-to-publish"
      ? head
      : await appendPublicationRecord(store, head, "ready-to-publish", {
          checkpoint: head.checkpoint,
          approval: head.approval,
          checkpointDigest: sha256(canonicalJson(head.checkpoint)),
          approvalDigest: sha256(canonicalJson(head.approval)),
          registryPacketDigest: sha256(canonicalJson(packet)),
          registry: packet,
          releaseLedgerPath: "release-records/releases/",
          incidentLedgerPath: "release-records/incidents/",
          controls,
          authenticationDigest: sha256(canonicalJson({ run, approval })),
          assetsDigest,
          attestationVerifierDigest,
        });
  await store.protectedSource(head.sourceRevision);
  const before = await readLatestRecord(store, value.releaseId, true);
  if (before.digest !== ready.digest) fail();
  const beforeAssetsDigest = await verifyRetainedReleaseAssets(
    store,
    value.releaseId,
  );
  const currentRelease = await store.release(value.releaseId);
  if (Date.now() >= expires) fail();
  const outcome =
    currentRelease.immutable === true && currentRelease.draft === false
      ? { release: currentRelease, uncertain: false }
      : await store.publishDraft(value.releaseId);
  // Reacquire tag and every retained asset even after an ambiguous response.
  const tag = await store.protectedSource(head.sourceRevision);
  const release = outcome.release;
  const after = await readLatestRecord(store, value.releaseId, true);
  if (
    after.digest !== ready.digest ||
    release.id !== value.releaseId ||
    release.tag_name !== "v0.1.0" ||
    release.prerelease !== true
  )
    fail();
  const immutableAssetsDigest = await verifyRetainedReleaseAssets(
    store,
    value.releaseId,
  );
  if (immutableAssetsDigest !== beforeAssetsDigest) fail();
  if (release.draft !== false || release.immutable !== true) {
    return Object.freeze({
      state: "frozen-unresolved",
      readyManifestDigest: ready.digest,
      releaseId: value.releaseId,
      disposition: "owner-reconciliation-required-no-retry",
    });
  }
  const immutableAttestationDigest = await store.verifyImmutableAttestation(
    value.releaseId,
    await store.assets(value.releaseId),
    tag.tagObjectSha,
  );
  const unsigned = {
    schemaVersion: 1,
    kind: "release-completion",
    state: "immutable-awaiting-reviewed-completion",
    transactionId: head.transactionId,
    sourceRevision: head.sourceRevision,
    protectedTag: "v0.1.0",
    draftReleaseDatabaseId: value.releaseId,
    candidateManifestDigest: head.candidateManifestDigest,
    readyManifestDigest: ready.digest,
    registryPacketDigest: sha256(canonicalJson(packet)),
    immutableReleaseDigest: sha256(canonicalJson(release)),
    immutableAssetsDigest,
    immutableAttestationDigest,
    releaseLedgerPath: "release-records/releases/",
    incidentLedgerPath: "release-records/incidents/",
  };
  return Object.freeze({
    ...unsigned,
    digest: sha256(canonicalJson(unsigned)),
    disposition: "awaiting-reviewed-append-under-release-records/releases",
  });
}
