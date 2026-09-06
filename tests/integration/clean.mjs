/* eslint import-x/no-cycle: "off" -- private executable capability */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve, sep } from "node:path";

import {
  ownedIntegrationResources,
  remainingIntegrationOperationMilliseconds,
  requireDisposableOuterHostCapability,
} from "./dist/controller.js";

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
const addDirectory = (targets, relative) => {
  const path = resolve(artifactsRoot, relative);
  if (!existsSync(path)) return;
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink())
    throw new Error("integration.cleanup.path");
  targets.push({ bytes: directoryBytes(path), path, relative });
};

const diskTargets = [];
try {
  assertArtifactsRoot();
  for (const name of owned.artifactFiles) addFile(diskTargets, name);
  for (const identity of owned.candidateIdentities)
    addDirectory(diskTargets, `candidates/${identity}`);
  for (const runId of owned.runIds) {
    addDirectory(diskTargets, `contexts/${runId}`);
    addDirectory(diskTargets, `runs/${runId}`);
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
