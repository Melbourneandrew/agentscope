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
} from "node:fs";
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
} from "./production-recorder.mjs";
import { projectOperatorControlsReport } from "./admission.mjs";
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

export async function readLatestRecord(store, releaseId) {
  const release = await store.release(releaseId);
  if (!release.draft || !release.prerelease || release.tag_name !== "v0.1.0")
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
  const durable = { ...unsigned, draftReleaseDatabaseId: value.releaseId };
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
