import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";

import {
  parseSubstrateCertificationCaseValue,
  requireThreeMatchingCertificationReceipts,
  SUBSTRATE_CERTIFICATION_PRIMARY_FAILURES,
  SUBSTRATE_CERTIFICATION_PREDICATES,
} from "./dist/substrate-certification.js";

const fail = () => {
  throw new Error("integration.certification.verification");
};
const exactKeys = (value, keys) =>
  typeof value === "object" &&
  value !== null &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());
const readBounded = (path, maximumBytes) => {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > maximumBytes ||
      (before.mode & 0o7777) !== 0o600
    )
      fail();
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.nlink !== before.nlink ||
      (after.mode & 0o7777) !== (before.mode & 0o7777)
    )
      fail();
    return { content, status: before };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};
const parseJson = (content) => {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(content),
    );
  } catch {
    fail();
  }
};
const ptyFailurePredicates = {
  "candidate-inventory": ["candidate-rejected"],
  "immutable-candidate": ["authority-rejected"],
  "installed-cli": [
    "bin-authority",
    "cli-authority",
    "cli-boundary",
    "driver-input",
    "execution-rejected",
    "interpreter-authority",
    "package-authority",
    "package-manifest",
    "receipt-rejected",
  ],
  "pty-receipt": ["receipt-rejected"],
  "runner-bootstrap": ["runner-rejected"],
};
const validPtyFailure = (value) =>
  value === null ||
  (exactKeys(value, ["phase", "predicate", "receiptVersion"]) &&
    value.receiptVersion === 1 &&
    Object.hasOwn(ptyFailurePredicates, value.phase) &&
    ptyFailurePredicates[value.phase].includes(value.predicate));
const digest = /^sha256:[a-f0-9]{64}$/u;
const diagnosticDigest = (value) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const validPreparedAuthorityDigests = (value) =>
  exactKeys(value, [
    "buildkitImage",
    "buildkitPlatform",
    "daemon",
    "images",
    "socket",
  ]) &&
  Object.values(value).every(
    (identity) => typeof identity === "string" && digest.test(identity),
  );
const validScenarioCleanup = (value, authority) =>
  exactKeys(value, [
    "authorityDigests",
    "diagnosticVersion",
    "outcome",
    "retirementReason",
    "stage",
  ]) &&
  value.diagnosticVersion === 1 &&
  value.stage === "scenario-operation" &&
  value.outcome === "retired-failure" &&
  value.retirementReason === "mutation-outcome-unknown" &&
  exactKeys(value.authorityDigests, ["daemon", "images", "socket"]) &&
  value.authorityDigests.daemon === authority.daemon &&
  value.authorityDigests.images === authority.images &&
  value.authorityDigests.socket === authority.socket;
const reconciliationReason = new Set([
  "not-observed",
  "absent",
  "matched",
  "id",
  "created",
  "name",
  "image-id",
  "image-reference",
  "platform",
  "network-mode",
  "network-attachment",
  "mount",
  "running-state",
  "driver",
  "scope",
  "mountpoint",
  "labels",
  "identity-substitution",
  "late-publication",
]);
const validBuilderCleanup = (value, authority, runId) =>
  exactKeys(value, [
    "diagnosticVersion",
    "expectedResourceCount",
    "expectedResourceDigest",
    "identityDigests",
    "observedResourceCount",
    "observedResourceDigest",
    "operationKind",
    "outcome",
    "process",
    "reconciliationReasons",
    "responseBytes",
    "responseTruncated",
    "stage",
  ]) &&
  value.diagnosticVersion === 1 &&
  value.stage === "builder-reconciliation" &&
  ["builder-create", "builder-bootstrap", "image-build"].includes(
    value.operationKind,
  ) &&
  value.outcome === "retired-failure" &&
  exactKeys(value.identityDigests, [
    "builder",
    "daemon",
    "image",
    "platform",
    "runGeneration",
  ]) &&
  Object.values(value.identityDigests).every(
    (identity) => typeof identity === "string" && digest.test(identity),
  ) &&
  value.identityDigests.builder === diagnosticDigest(`agentscope-${runId}`) &&
  value.identityDigests.daemon === authority.daemon &&
  value.identityDigests.image === authority.buildkitImage &&
  value.identityDigests.platform === authority.buildkitPlatform &&
  value.identityDigests.runGeneration === diagnosticDigest(runId) &&
  exactKeys(value.process, [
    "exited",
    "joined",
    "observed",
    "outputBytes",
    "outputTruncated",
    "signaled",
    "stderrClass",
    "timedOut",
  ]) &&
  [
    value.process.exited,
    value.process.joined,
    value.process.observed,
    value.process.outputTruncated,
    value.process.signaled,
    value.process.timedOut,
    value.responseTruncated,
  ].every((flag) => typeof flag === "boolean") &&
  [
    value.process.outputBytes,
    value.responseBytes,
    value.expectedResourceCount,
    value.observedResourceCount,
  ].every(
    (count) => Number.isSafeInteger(count) && count >= 0 && count <= 16_777_216,
  ) &&
  value.expectedResourceCount === 2 &&
  value.observedResourceCount <= 2 &&
  value.responseTruncated === false &&
  typeof value.process.stderrClass === "string" &&
  /^[a-z-]{1,64}$/u.test(value.process.stderrClass) &&
  typeof value.expectedResourceDigest === "string" &&
  value.expectedResourceDigest ===
    diagnosticDigest([
      `buildx_buildkit_agentscope-${runId}0`,
      `buildx_buildkit_agentscope-${runId}0_state`,
    ]) &&
  typeof value.observedResourceDigest === "string" &&
  digest.test(value.observedResourceDigest) &&
  exactKeys(value.reconciliationReasons, [
    "builderContainer",
    "builderVolume",
    "builtTag",
  ]) &&
  Object.values(value.reconciliationReasons).every(
    (reason) => typeof reason === "string" && reconciliationReason.has(reason),
  );
const validPrivateCleanup = (value, authority, runId) =>
  value === null ||
  validScenarioCleanup(value, authority) ||
  validBuilderCleanup(value, authority, runId);

const artifactsRoot = resolve("artifacts/integration");
// The verifier intentionally validates the complete closed record in one pass.
// eslint-disable-next-line complexity, max-lines-per-function
const verifyFailureEvidence = (expectedCase) => {
  const runsRoot = resolve(artifactsRoot, "runs");
  const manifestPath = resolve(
    artifactsRoot,
    "controller-failure-manifest.json",
  );
  const manifestBytes = readBounded(manifestPath, 65_536).content;
  const manifest = parseJson(manifestBytes);
  if (
    !exactKeys(manifest, [
      "certificationCase",
      "controllerAuthorityDigest",
      "controllerFailureManifestVersion",
      "failureEvidence",
      "preparedAuthorityDigests",
      "runIds",
    ]) ||
    manifest.controllerFailureManifestVersion !== 1 ||
    manifest.certificationCase !== expectedCase ||
    !/^sha256:[a-f0-9]{64}$/u.test(manifest.controllerAuthorityDigest) ||
    !validPreparedAuthorityDigests(manifest.preparedAuthorityDigests) ||
    !Array.isArray(manifest.runIds) ||
    !Array.isArray(manifest.failureEvidence) ||
    manifest.runIds.length < 1 ||
    manifest.runIds.length > 256 ||
    (expectedCase !== null && manifest.runIds.length !== 1) ||
    new Set(manifest.runIds).size !== manifest.runIds.length ||
    JSON.stringify(manifest.runIds) !==
      JSON.stringify([...manifest.runIds].sort()) ||
    manifest.failureEvidence.length !== manifest.runIds.length
  )
    fail();
  const expected = new Set(manifest.runIds);
  const observed = [];
  for (const identity of manifest.failureEvidence) {
    if (
      !exactKeys(identity, ["dev", "digest", "ino", "runId", "size"]) ||
      !expected.has(identity.runId) ||
      !/^[a-f0-9]{16}$/u.test(identity.runId) ||
      !/^sha256:[a-f0-9]{64}$/u.test(identity.digest) ||
      !Number.isSafeInteger(identity.dev) ||
      !Number.isSafeInteger(identity.ino) ||
      !Number.isSafeInteger(identity.size)
    )
      fail();
    const path = resolve(runsRoot, identity.runId, "controller-failure.json");
    const { content, status } = readBounded(path, 16_384);
    const record = parseJson(content);
    if (
      status.dev !== identity.dev ||
      status.ino !== identity.ino ||
      status.size !== identity.size ||
      `sha256:${createHash("sha256").update(content).digest("hex")}` !==
        identity.digest ||
      !exactKeys(record, [
        "certificationCase",
        "certificationPredicate",
        "cleanupFailure",
        "controllerFailureEvidenceVersion",
        "controllerOutcome",
        "installedPtyFailure",
        "primaryFailure",
        "privateCleanup",
        "runId",
        "scenarioOutcome",
      ]) ||
      record.controllerFailureEvidenceVersion !== 2 ||
      record.runId !== identity.runId ||
      record.controllerOutcome !== "retired-failure" ||
      record.certificationCase !== expectedCase ||
      !validPtyFailure(record.installedPtyFailure) ||
      !validPrivateCleanup(
        record.privateCleanup,
        manifest.preparedAuthorityDigests,
        identity.runId,
      ) ||
      !/^integration\.[a-z.-]{1,96}$/u.test(record.primaryFailure) ||
      !(
        record.cleanupFailure === null ||
        /^integration\.[a-z.-]{1,96}$/u.test(record.cleanupFailure)
      ) ||
      !["passed", "failed", "not-complete"].includes(record.scenarioOutcome)
    )
      fail();
    if (
      expectedCase === null
        ? record.certificationPredicate !== null
        : record.certificationPredicate !==
            SUBSTRATE_CERTIFICATION_PREDICATES[expectedCase] ||
          record.primaryFailure !==
            SUBSTRATE_CERTIFICATION_PRIMARY_FAILURES[expectedCase]
    )
      fail();
    if (
      expectedCase !== null &&
      SUBSTRATE_CERTIFICATION_PRIMARY_FAILURES[expectedCase] ===
        "integration.controller.unsettled-operation" &&
      record.privateCleanup === null
    )
      fail();
    observed.push(identity.runId);
  }
  if (
    new Set(observed).size !== expected.size ||
    observed.some((runId) => !expected.has(runId))
  )
    fail();
  const runDirectories = readdirSync(runsRoot, { withFileTypes: true });
  if (
    runDirectories.length !== expected.size ||
    runDirectories.some((entry) => {
      if (!entry.isDirectory() || !expected.has(entry.name)) return true;
      const status = lstatSync(resolve(runsRoot, entry.name));
      return !status.isDirectory() || status.isSymbolicLink();
    })
  )
    fail();
  if (
    expectedCase !== null &&
    existsSync(resolve(artifactsRoot, "certification"))
  )
    fail();
};

const verifyCredentialPreflightFailure = () => {
  const path = resolve(artifactsRoot, "controller-preflight-failure.json");
  const record = parseJson(readBounded(path, 4096).content);
  if (
    !exactKeys(record, [
      "certificationCase",
      "certificationPredicate",
      "controllerPreflightFailureVersion",
      "githubSha",
      "mutationAuthority",
      "primaryFailure",
    ]) ||
    record.certificationCase !== "credential-presence" ||
    record.certificationPredicate !== "credential-environment" ||
    record.controllerPreflightFailureVersion !== 1 ||
    record.githubSha !== process.env.GITHUB_SHA ||
    record.mutationAuthority !== "not-created" ||
    record.primaryFailure !== "integration.controller.provider-credentials" ||
    existsSync(resolve(artifactsRoot, "controller-failure-manifest.json")) ||
    existsSync(resolve(artifactsRoot, "runs")) ||
    existsSync(resolve(artifactsRoot, "certification"))
  )
    fail();
};

const [operation, extra] = process.argv.slice(2);
if (process.argv.length !== 3 || extra !== undefined) fail();
if (operation === "failure") {
  verifyFailureEvidence(null);
} else if (operation === "negative") {
  const expectedCase = parseSubstrateCertificationCaseValue(
    process.env.AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE,
  );
  if (expectedCase === undefined) fail();
  if (expectedCase === "credential-presence")
    verifyCredentialPreflightFailure();
  else verifyFailureEvidence(expectedCase);
} else if (operation === "fan-in") {
  const directory = resolve("artifacts/integration/certification-fan-in");
  const status = lstatSync(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) fail();
  const names = readdirSync(directory).sort();
  if (
    JSON.stringify(names) !==
    JSON.stringify(["replay-1.json", "replay-2.json", "replay-3.json"])
  )
    fail();
  const receipts = names.map((name) =>
    parseJson(readBounded(resolve(directory, name), 65_536).content),
  );
  const receipt = requireThreeMatchingCertificationReceipts(receipts);
  if (receipt.githubSha !== process.env.GITHUB_SHA) fail();
} else {
  fail();
}

console.log("Verified exact substrate certification evidence.");
