/* eslint import-x/no-cycle: "off" -- private executable capability */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
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
import {
  validInstalledPtyFailure,
  validCodexResearchDiagnostic,
} from "./immutable-candidate-authority.mjs";
import { certificationFailureAuthorityIsValid } from "./dist/substrate-certification.js";
import { sanitizeFixtureResult } from "./dist/operations.js";

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
      `^agentscope-int-${runId}-(?:scenario|collector|retrieval|mockserver)$`,
      "u",
    ),
    image: new RegExp(
      `^agentscope-int-${runId}:(?:candidate|mockserver)$`,
      "u",
    ),
    network: new RegExp(`^agentscope-int-${runId}-network$`, "u"),
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
  "harness-support-evidence.json": 1_048_576,
});
const addDirectory = (targets, relative) => {
  const path = resolve(artifactsRoot, relative);
  if (!existsSync(path)) return;
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink())
    throw new Error("integration.cleanup.path");
  targets.push({ bytes: directoryBytes(path), path, relative });
};
const successfulDocuments = Object.freeze([
  "evidence.json",
  "fixture-lifecycle.json",
  "model-ledger.json",
  "destination-ledger.json",
  "harness-observation.json",
]);
const readSuccessfulDocument = (relative) => {
  let descriptor;
  try {
    remainingIntegrationOperationMilliseconds(30_000, true);
    const path = resolve(artifactsRoot, relative);
    if (realpathSync(path) !== resolve(expectedRealArtifactsRoot, relative))
      throw new Error();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o7777) !== 0o600 ||
      before.size < 1 ||
      before.size > 1_048_576
    )
      throw new Error();
    const bytes = Buffer.alloc(before.size + 1);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    const after = fstatSync(descriptor),
      named = lstatSync(path);
    if (
      count !== before.size ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      [
        "dev",
        "ino",
        "mode",
        "uid",
        "gid",
        "nlink",
        "size",
        "mtimeMs",
        "ctimeMs",
      ].some((key) => before[key] !== after[key] || before[key] !== named[key])
    )
      throw new Error();
    return JSON.parse(bytes.subarray(0, count).toString("utf8"));
  } catch {
    throw new Error("integration.cleanup.success-evidence");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};
// Registered support bytes were compiled from this controller's completed live
// authorities. These IDs select cleanup targets, not new admission authority.
const successfulEvidenceRuns = () => {
  const retained = new Set();
  if (!owned.artifactFiles.includes("harness-support-evidence.json"))
    return retained;
  if (owned.requiredFailureEvidence.length !== 0)
    throw new Error("integration.cleanup.success-evidence");
  const support = readSuccessfulDocument("harness-support-evidence.json");
  if (
    !Array.isArray(support.entries) ||
    support.entries.length < 1 ||
    support.entries.length > 32
  )
    throw new Error("integration.cleanup.success-evidence");
  for (const entry of support.entries) {
    const runId = entry.binding?.seed?.runId;
    if (
      ![
        "@agentscope/harness-codex",
        "@agentscope/harness-claude-code",
      ].includes(entry.harnessType) ||
      typeof runId !== "string" ||
      !/^[a-f0-9]{16}$/u.test(runId) ||
      !owned.runIds.includes(runId) ||
      retained.has(runId)
    )
      throw new Error("integration.cleanup.success-evidence");
    const documents = Object.fromEntries(
      successfulDocuments.map((name) => [
        name,
        readSuccessfulDocument(`runs/${runId}/${name}`),
      ]),
    );
    const evidence = documents["evidence.json"];
    if (
      evidence.runId !== runId ||
      evidence.scenarioId !== entry.binding.seed.scenarioId ||
      evidence.outcome !== "passed" ||
      evidence.cleanup?.outcome !== "complete" ||
      evidence.cleanup.removalFailureCount !== 0 ||
      evidence.cleanup.remaining === null ||
      Object.values(evidence.cleanup.remaining).some((count) => count !== 0) ||
      entry.binding.completion?.runId !== runId ||
      entry.binding.completion.outcome !== "scenario-terminal-clean" ||
      entry.binding.completion.remainingOwnedResources !== 0
    )
      throw new Error("integration.cleanup.success-evidence");
    const fixture = sanitizeFixtureResult(
      {
        ...documents["fixture-lifecycle.json"],
        modelLedger: documents["model-ledger.json"],
        destinationLedger: documents["destination-ledger.json"],
        harnessObservation: documents["harness-observation.json"],
      },
      evidence.scenarioId,
    );
    if (
      fixture.resultStatus !== "complete" ||
      fixture.harnessObservation?.kind !==
        (entry.harnessType === "@agentscope/harness-codex"
          ? "codex-tui-trace"
          : "claude-code-trace")
    )
      throw new Error("integration.cleanup.success-evidence");
    retained.add(runId);
  }
  return retained;
};
const addSuccessfulRunCleanup = (targets, runId) => {
  const relative = `runs/${runId}`,
    root = resolve(artifactsRoot, relative);
  directoryBytes(root);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (successfulDocuments.includes(entry.name)) continue;
    const start = targets.length,
      child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) addDirectory(targets, child);
    else addFile(targets, child, 8 * 1024 * 1024 * 1024);
    // Keep unknown child names out of the existing content-free cleanup log.
    for (const target of targets.slice(start)) target.relative = relative;
  }
};
// The exact record validator intentionally checks every durable field together.
// eslint-disable-next-line complexity
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
  if (
    JSON.stringify(Object.keys(record).sort()) !==
      JSON.stringify(
        [
          "cleanupFailure",
          "causalFailure",
          "certificationCase",
          "certificationPredicate",
          "certificationReadiness",
          "controllerFailureEvidenceVersion",
          "controllerOutcome",
          "codexResearchDiagnostic",
          "installedPtyFailure",
          "primaryFailure",
          "privateCleanup",
          "runId",
          "scenarioOutcome",
        ].sort(),
      ) ||
    record.controllerFailureEvidenceVersion !== 3 ||
    record.runId !== identity.runId ||
    record.controllerOutcome !== "retired-failure" ||
    !validInstalledPtyFailure(record.installedPtyFailure) ||
    !validCodexResearchDiagnostic(record.codexResearchDiagnostic) ||
    !(
      record.causalFailure === null ||
      /^(?:integration\.[a-z.-]{1,96})$/u.test(record.causalFailure)
    ) ||
    !/^(?:integration\.[a-z.-]{1,96})$/u.test(record.primaryFailure) ||
    !certificationFailureAuthorityIsValid(record) ||
    !(
      record.cleanupFailure === null ||
      /^(?:integration\.[a-z.-]{1,96})$/u.test(record.cleanupFailure)
    ) ||
    !["passed", "failed", "not-complete"].includes(record.scenarioOutcome) ||
    !(
      record.privateCleanup === null ||
      (record.privateCleanup?.diagnosticVersion === 1 &&
        record.privateCleanup?.outcome === "retired-failure")
    )
  )
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
  if (
    !failureEvidenceCoverageIsExact(
      owned.runIds,
      owned.requiredFailureEvidence,
      owned.failureEvidence.map(({ runId }) => runId),
    )
  )
    throw new Error("integration.cleanup.failure-evidence");
  const retainedRuns = successfulEvidenceRuns();
  for (const name of owned.artifactFiles)
    if (name !== "harness-support-evidence.json" || retainedRuns.size === 0)
      addFile(diskTargets, name, artifactMaximumBytes[name]);
  for (const identity of owned.candidateIdentities)
    addDirectory(diskTargets, `candidates/${identity}`);
  for (const runId of owned.runIds) {
    addDirectory(diskTargets, `contexts/${runId}`);
    if (requiredFailureEvidence.has(runId))
      assertFailureEvidence(failureEvidenceByRunId.get(runId));
    else if (retainedRuns.has(runId))
      addSuccessfulRunCleanup(diskTargets, runId);
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
