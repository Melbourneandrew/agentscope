/* eslint import-x/no-cycle: "off" -- private executable capability */
import { execFileSync } from "node:child_process";
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
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve, sep } from "node:path";

import {
  failureEvidenceCoverageIsExact,
  ownedIntegrationResources,
  remainingIntegrationOperationMilliseconds,
  requireDisposableOuterHostCapability,
} from "./dist/controller.js";
import { IMAGE_PREPARATION_LIMITS } from "./image-preparation.mjs";

const capability = requireDisposableOuterHostCapability();
const owned = ownedIntegrationResources();
const integrationRoot = import.meta.dirname;
const artifactsRoot = resolve(integrationRoot, "../../artifacts/integration");
const expectedRealArtifactsRoot = resolve(
  realpathSync(resolve(integrationRoot, "../..")),
  "artifacts/integration",
);
const integrationLabel = "com.agentscope.integration=true";
const resourcePattern = (kind, runId) =>
  ({
    container: new RegExp(
      `^agentscope-int-${runId}-(?:scenario|collector|retrieval|mockserver|model-proxy)$`,
      "u",
    ),
    image: new RegExp(
      `^agentscope-int-${runId}:(?:candidate|mockserver)$`,
      "u",
    ),
    network: new RegExp(
      `^agentscope-int-${runId}-(?:network|control-network)$`,
      "u",
    ),
  })[kind];
const docker = (arguments_, options = {}) =>
  execFileSync(capability.binding.dockerExecutable, arguments_, {
    env: capability.binding.dockerEnvironment,
    timeout: remainingIntegrationOperationMilliseconds(30_000, true),
    ...options,
  });
const list = (kind, runId) => {
  const arguments_ = [kind, "ls"];
  if (kind === "container") arguments_.push("--all");
  arguments_.push(
    "--filter",
    `label=${integrationLabel}`,
    "--filter",
    `label=com.agentscope.integration.run=${runId}`,
    "--format",
    kind === "image"
      ? "{{.Repository}}:{{.Tag}}"
      : kind === "container"
        ? "{{.Names}}"
        : "{{.Name}}",
  );
  const names = docker(arguments_, { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  if (kind === "volume") {
    if (names.length > 0) throw new Error("integration.cleanup.resource");
    return [];
  }
  if (names.some((name) => !resourcePattern(kind, runId).test(name)))
    throw new Error("integration.cleanup.resource");
  return names;
};
const removeDocker = (arguments_, names) => {
  if (names.length === 0) return;
  docker([...arguments_, ...names], { stdio: "inherit" });
};

const assertArtifactsRoot = () => {
  const status = lstatSync(artifactsRoot);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    realpathSync(artifactsRoot) !== expectedRealArtifactsRoot
  )
    throw new Error("integration.cleanup.path");
};
const assertPrivateStorageRetirements = () => {
  const storage = capability.binding.privateStorage;
  const rootStatus = lstatSync(storage.root);
  if (
    !rootStatus.isDirectory() ||
    rootStatus.isSymbolicLink() ||
    rootStatus.dev !== storage.rootDev ||
    rootStatus.ino !== storage.rootIno ||
    rootStatus.uid !== storage.rootUid ||
    rootStatus.gid !== storage.rootGid ||
    (rootStatus.mode & 0o7777) !== storage.rootMode
  )
    throw new Error("integration.cleanup.private-storage");
  const retirements = new Map(
    owned.privateStorageRetirements.map((retirement) => [
      retirement.path,
      retirement,
    ]),
  );
  const entries = readdirSync(storage.root, { withFileTypes: true });
  if (
    retirements.size !== owned.privateStorageRetirements.length ||
    entries.length !== retirements.size
  )
    throw new Error("integration.cleanup.private-storage");
  for (const entry of entries) {
    const path = resolve(storage.root, entry.name);
    const retirement = retirements.get(path);
    const status = lstatSync(path);
    if (
      retirement === undefined ||
      !/^docker-client-[A-Za-z0-9_-]{6}$/u.test(entry.name) ||
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      status.dev !== retirement.dev ||
      status.ino !== retirement.ino ||
      status.uid !== storage.rootUid ||
      status.gid !== storage.rootGid ||
      (status.mode & 0o7777) !== 0o700 ||
      retirement.authorityDigest !== storage.authorityDigest
    )
      throw new Error("integration.cleanup.private-storage");
  }
  const after = lstatSync(storage.root);
  if (after.dev !== rootStatus.dev || after.ino !== rootStatus.ino)
    throw new Error("integration.cleanup.private-storage");
  return owned.privateStorageRetirements.map(
    ({ entryCount, entrySetDigest, totalBytes }) => ({
      entryCount,
      entrySetDigest,
      totalBytes,
    }),
  );
};
const directoryBytes = (root) => {
  let bytes = 0;
  let entries = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      entries += 1;
      if (entries > 100_000) throw new Error("integration.cleanup.path");
      const target = resolve(current, entry.name);
      if (!target.startsWith(`${root}${sep}`) || entry.isSymbolicLink())
        throw new Error("integration.cleanup.path");
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) bytes += statSync(target).size;
      else throw new Error("integration.cleanup.path");
      if (!Number.isSafeInteger(bytes) || bytes > 8 * 1024 * 1024 * 1024)
        throw new Error("integration.cleanup.path");
    }
  }
  return bytes;
};
const addFile = (targets, relative, maximumBytes = 16_384) => {
  const path = resolve(artifactsRoot, relative);
  if (!existsSync(path)) return;
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink() || status.size > maximumBytes)
    throw new Error("integration.cleanup.path");
  targets.push({ bytes: status.size, path, relative });
};
const artifactMaximumBytes = Object.freeze({
  "current-candidate.json": 16_384,
  "current-images.json": IMAGE_PREPARATION_LIMITS.maximumEvidenceBytes,
  "current-model-routes.json": 16_384,
  "current-selection.json": 16_384,
});
const failureRetainedArtifactNames = Object.freeze([
  "current-candidate.json",
  "current-images.json",
  "current-model-routes.json",
  "current-selection.json",
]);
const exactKeys = (value, keys) =>
  typeof value === "object" &&
  value !== null &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());
const compileFailureRetention = (
  manifest,
  requiredRunIds,
  failureEvidence,
  retainedInputDigests,
  expectedControllerAuthorityDigest,
) => {
  const expectedInputs = [
    "capability-manifest.json",
    ...failureRetainedArtifactNames,
  ].sort();
  const sortedRunIds = [...requiredRunIds].sort();
  const sortedFailureEvidence = [...failureEvidence].sort((left, right) =>
    left.runId.localeCompare(right.runId),
  );
  if (
    !exactKeys(manifest, [
      "controllerAuthorityDigest",
      "controllerFailureManifestVersion",
      "failureEvidence",
      "retainedInputs",
      "runIds",
    ]) ||
    manifest.controllerFailureManifestVersion !== 1 ||
    !/^sha256:[a-f0-9]{64}$/u.test(expectedControllerAuthorityDigest) ||
    manifest.controllerAuthorityDigest !== expectedControllerAuthorityDigest ||
    JSON.stringify(manifest.runIds) !== JSON.stringify(sortedRunIds) ||
    JSON.stringify(manifest.failureEvidence) !==
      JSON.stringify(sortedFailureEvidence) ||
    !exactKeys(manifest.retainedInputs, expectedInputs) ||
    !exactKeys(retainedInputDigests, expectedInputs) ||
    expectedInputs.some(
      (name) =>
        !/^sha256:[a-f0-9]{64}$/u.test(manifest.retainedInputs[name]) ||
        manifest.retainedInputs[name] !== retainedInputDigests[name],
    )
  )
    throw new Error("integration.cleanup.failure-evidence");
  return new Set(failureRetainedArtifactNames);
};
const retainedInputIdentity = (path, maximumBytes, expectedMode) => {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > maximumBytes ||
      (before.mode & 0o7777) !== expectedMode
    )
      throw new Error("integration.cleanup.failure-evidence");
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const named = lstatSync(path);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.nlink !== before.nlink ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      named.isSymbolicLink() ||
      (after.mode & 0o7777) !== (before.mode & 0o7777)
    )
      throw new Error("integration.cleanup.failure-evidence");
    return {
      content,
      digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};
const assertFailureRetention = (requiredRunIds, failureEvidence) => {
  const manifestPath = resolve(
    artifactsRoot,
    "controller-failure-manifest.json",
  );
  const manifestIdentity = retainedInputIdentity(manifestPath, 65_536, 0o600);
  const manifest = JSON.parse(manifestIdentity.content.toString("utf8"));
  const retainedInputDigests = Object.fromEntries([
    [
      "capability-manifest.json",
      retainedInputIdentity(
        resolve(integrationRoot, "capability-manifest.json"),
        1024 * 1024,
        0o644,
      ).digest,
    ],
    ...failureRetainedArtifactNames.map((name) => [
      name,
      retainedInputIdentity(
        resolve(artifactsRoot, name),
        artifactMaximumBytes[name],
        name === "current-images.json" ? 0o600 : 0o644,
      ).digest,
    ]),
  ]);
  return compileFailureRetention(
    manifest,
    requiredRunIds,
    failureEvidence,
    retainedInputDigests,
    capability.binding.privateStorage.authorityDigest,
  );
};
const installedPtyFailurePredicates = Object.freeze({
  "candidate-inventory": Object.freeze(["candidate-rejected"]),
  "immutable-candidate": Object.freeze(["authority-rejected"]),
  "installed-cli": Object.freeze([
    "bin-authority",
    "cli-authority",
    "cli-boundary",
    "driver-input",
    "execution-rejected",
    "interpreter-authority",
    "package-authority",
    "package-manifest",
    "receipt-rejected",
  ]),
  "pty-receipt": Object.freeze(["receipt-rejected"]),
  "runner-bootstrap": Object.freeze(["runner-rejected"]),
});
const installedContractFailurePredicates = Object.freeze({
  "aggregate-evaluation": Object.freeze([
    "aggregate-count-order-digest",
    "duplicate-ordinal",
    "inventory-candidate-digest-mismatch",
    "missing-ordinal",
    "out-of-range-ordinal",
    "per-case-observation-shape",
    "per-case-result-count",
    "per-case-setup-output",
    "per-case-setup-receipt-shape",
    "per-case-setup-receipt-status",
    "per-case-state-digest",
    "per-case-step-output",
    "per-case-step-receipt-shape",
    "per-case-step-receipt-status",
    "unexpected-extra-evidence",
  ]),
  "artifact-install": Object.freeze([
    "candidate-rejected",
    "egress-rejected",
    "install-rejected",
    "manifest-rejected",
    "plan-rejected",
    "toolchain-rejected",
  ]),
  "case-execution": Object.freeze([
    "narrow-help-rejected",
    "setup-candidate-bin-identity",
    "setup-cwd-env-config",
    "setup-deadline",
    "setup-descriptor-permission",
    "setup-fixture-input-creation",
    "setup-workspace-root-authority",
    "state-rejected",
    "testkit.headless.aborted",
    "testkit.headless.backend.receipt",
    "testkit.headless.capability",
    "testkit.headless.kernel.failure",
    "testkit.headless.kernel.options",
    "testkit.headless.kernel.request",
    "testkit.headless.kernel.spawn",
    "testkit.headless.observer.identity",
    "testkit.headless.observer.read",
    "testkit.headless.observer.reap",
    "testkit.headless.observer.reap.deadline",
    "testkit.headless.observer.reap.leader-identity",
    "testkit.headless.observer.reap.observer-stop-join",
    "testkit.headless.observer.reap.residual-membership",
    "testkit.headless.observer.root",
    "testkit.headless.observer.signal",
    "testkit.headless.reconciliation.deadline",
    "testkit.headless.startup.deadline",
    "testkit.pty.immutable-candidate",
  ]),
  "receipt-finalization": Object.freeze(["receipt-rejected"]),
});
const installedContractCaseCount = 123;
const installedContractInventorySha256 =
  "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a";
const validInstalledPtyFailure = (value) =>
  value === null ||
  (typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(["phase", "predicate", "receiptVersion"].sort()) &&
    value.receiptVersion === 1 &&
    Object.hasOwn(installedPtyFailurePredicates, value.phase) &&
    installedPtyFailurePredicates[value.phase].includes(value.predicate)) ||
  (typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(
        (value.phase === "case-execution"
          ? [
              "caseOrdinal",
              "contractInventorySha256",
              "phase",
              "predicate",
              "receiptVersion",
            ]
          : ["phase", "predicate", "receiptVersion"]
        ).sort(),
      ) &&
    value.receiptVersion === 1 &&
    Object.hasOwn(installedContractFailurePredicates, value.phase) &&
    installedContractFailurePredicates[value.phase].includes(value.predicate) &&
    (value.phase !== "case-execution" ||
      (Number.isSafeInteger(value.caseOrdinal) &&
        value.caseOrdinal >= 0 &&
        value.caseOrdinal < installedContractCaseCount &&
        value.contractInventorySha256 === installedContractInventorySha256)));
const addDirectory = (targets, relative) => {
  const path = resolve(artifactsRoot, relative);
  if (!existsSync(path)) return;
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink())
    throw new Error("integration.cleanup.path");
  targets.push({ bytes: directoryBytes(path), path, relative });
};
const validSecondaryFailures = (failures) =>
  Array.isArray(failures) &&
  failures.length <= 2 &&
  new Set(failures).size === failures.length &&
  failures.every((failure) =>
    /^integration\.isolation\.(?:cleanup|evidence)$/u.test(failure),
  );
const validRetainedEvidence = (value) =>
  typeof value === "object" &&
  value !== null &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([
      "destination-ledger.json",
      "evidence.json",
      "fixture-lifecycle.json",
      "model-ledger.json",
    ]) &&
  Object.values(value).every((digest) => /^sha256:[a-f0-9]{64}$/u.test(digest));
const validFailureRecord = (record, runId) =>
  JSON.stringify(Object.keys(record).sort()) ===
    JSON.stringify(
      [
        "cleanupFailure",
        "controllerFailureEvidenceVersion",
        "controllerOutcome",
        "installedPtyFailure",
        "primaryFailure",
        "privateCleanup",
        "retainedEvidence",
        "runId",
        "scenarioOutcome",
        "scenarioFailure",
        "scenarioSecondaryFailures",
      ].sort(),
    ) &&
  record.controllerFailureEvidenceVersion === 2 &&
  record.runId === runId &&
  record.controllerOutcome === "retired-failure" &&
  validInstalledPtyFailure(record.installedPtyFailure) &&
  /^(?:integration\.[a-z.-]{1,96})$/u.test(record.primaryFailure) &&
  (record.scenarioFailure === null ||
    /^(?:integration\.[a-z.-]{1,96})$/u.test(record.scenarioFailure)) &&
  validRetainedEvidence(record.retainedEvidence) &&
  validSecondaryFailures(record.scenarioSecondaryFailures) &&
  (record.cleanupFailure === null ||
    /^(?:integration\.[a-z.-]{1,96})$/u.test(record.cleanupFailure)) &&
  ["passed", "failed", "interrupted", "not-complete"].includes(
    record.scenarioOutcome,
  ) &&
  (record.privateCleanup === null ||
    (record.privateCleanup?.diagnosticVersion === 1 &&
      record.privateCleanup?.outcome === "retired-failure"));
const assertFailureEvidence = (identity) => {
  const directory = resolve(artifactsRoot, "runs", identity.runId);
  const path = resolve(directory, "controller-failure.json");
  const status = lstatSync(path);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    status.dev !== identity.dev ||
    status.ino !== identity.ino ||
    status.size !== identity.size ||
    (status.mode & 0o7777) !== 0o600 ||
    status.size > 16_384 ||
    directoryBytes(directory) > 128 * 1024 * 1024
  )
    throw new Error("integration.cleanup.failure-evidence");
  const content = readFileSync(path);
  if (
    `sha256:${createHash("sha256").update(content).digest("hex")}` !==
    identity.digest
  )
    throw new Error("integration.cleanup.failure-evidence");
  const after = lstatSync(path);
  if (
    after.dev !== status.dev ||
    after.ino !== status.ino ||
    after.size !== status.size ||
    after.nlink !== status.nlink ||
    (after.mode & 0o7777) !== (status.mode & 0o7777)
  )
    throw new Error("integration.cleanup.failure-evidence");
  const record = JSON.parse(content.toString("utf8"));
  if (!validFailureRecord(record, identity.runId))
    throw new Error("integration.cleanup.failure-evidence");
};

const diskTargets = [];
const privateStorage = assertPrivateStorageRetirements();
try {
  assertArtifactsRoot();
  const failureEvidenceByRunId = new Map(
    owned.failureEvidence.map((identity) => [identity.runId, identity]),
  );
  const requiredFailureEvidence = new Set(owned.requiredFailureEvidence);
  const retainedArtifactFiles =
    requiredFailureEvidence.size === 0
      ? new Set()
      : assertFailureRetention(
          owned.requiredFailureEvidence,
          owned.failureEvidence,
        );
  if (
    !failureEvidenceCoverageIsExact(
      owned.runIds,
      owned.requiredFailureEvidence,
      owned.failureEvidence.map(({ runId }) => runId),
    )
  )
    throw new Error("integration.cleanup.failure-evidence");
  for (const name of owned.artifactFiles)
    if (!retainedArtifactFiles.has(name))
      addFile(diskTargets, name, artifactMaximumBytes[name]);
  for (const identity of owned.candidateIdentities)
    addDirectory(diskTargets, `candidates/${identity}`);
  for (const runId of owned.runIds) {
    addDirectory(diskTargets, `contexts/${runId}`);
    if (requiredFailureEvidence.has(runId))
      assertFailureEvidence(failureEvidenceByRunId.get(runId));
    else addDirectory(diskTargets, `runs/${runId}`);
    const markerPath = resolve(artifactsRoot, "active", `${runId}.json`);
    if (existsSync(markerPath)) {
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      if (
        marker?.activeVersion !== 1 ||
        marker?.runId !== runId ||
        marker?.pid !== process.pid
      )
        throw new Error("integration.cleanup.active");
      addFile(diskTargets, `active/${runId}.json`);
    }
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const containers = owned.runIds.flatMap((runId) => list("container", runId));
const networks = owned.runIds.flatMap((runId) => list("network", runId));
const images = owned.runIds.flatMap((runId) => list("image", runId));
for (const runId of owned.runIds) list("volume", runId);
console.log(
  JSON.stringify({
    cleanupVersion: 1,
    containers,
    networks,
    images,
    disk: diskTargets.map(({ relative, bytes }) => ({ relative, bytes })),
    diskBytes: diskTargets.reduce((total, target) => total + target.bytes, 0),
    privateStorage,
  }),
);
removeDocker(["container", "rm", "--force"], containers);
removeDocker(["network", "rm"], networks);
removeDocker(["image", "rm", "--force"], images);
for (const target of diskTargets) {
  assertArtifactsRoot();
  const status = lstatSync(target.path);
  const realTarget = realpathSync(target.path);
  if (
    status.isSymbolicLink() ||
    !realTarget.startsWith(`${expectedRealArtifactsRoot}${sep}`)
  )
    throw new Error("integration.cleanup.path");
  rmSync(target.path, { force: true, recursive: true });
}
console.log("Agentscope integration cleanup complete.");
