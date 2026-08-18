import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve, sep } from "node:path";

import { acquireIntegrationOperationLock } from "./operation-lock.mjs";

const integrationRoot = import.meta.dirname;
const artifactsRoot = resolve(integrationRoot, "../../artifacts/integration");
const workspaceRoot = resolve(integrationRoot, "../..");
const releaseOperationLock = acquireIntegrationOperationLock(
  workspaceRoot,
  "integration.cleanup.active",
);
process.once("exit", releaseOperationLock);
const expectedRealArtifactsRoot = resolve(
  realpathSync(resolve(integrationRoot, "../..")),
  "artifacts/integration",
);
const label = "com.agentscope.integration=true";
const runToken = "[a-f0-9]{16}";
const resourcePatterns = {
  container: new RegExp(
    `^agentscope-int-${runToken}-(?:scenario|collector|retrieval|mockserver)$`,
    "u",
  ),
  network: new RegExp(`^agentscope-int-${runToken}-network$`, "u"),
  image: new RegExp(
    `^agentscope-int-${runToken}:(?:candidate|mockserver)$`,
    "u",
  ),
};
const list = (kind) => {
  const arguments_ = [kind, "ls"];
  if (kind === "container") arguments_.push("--all");
  arguments_.push(
    "--filter",
    `label=${label}`,
    "--format",
    kind === "image"
      ? "{{.Repository}}:{{.Tag}}"
      : kind === "container"
        ? "{{.Names}}"
        : "{{.Name}}",
  );
  return execFileSync("docker", arguments_, { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((name) => {
      if (!resourcePatterns[kind].test(name))
        throw new Error("integration.cleanup.resource");
      return name;
    });
};
const remove = (arguments_, names) => {
  if (names.length === 0) return;
  console.log(`Removing Agentscope integration resources: ${names.join(", ")}`);
  execFileSync("docker", [...arguments_, ...names], { stdio: "inherit" });
};

const ownedDirectories = {
  candidates: /^sha256-[a-f0-9]{64}$/u,
  contexts: /^[a-f0-9]{16}$/u,
  runs: /^[a-f0-9]{16}$/u,
};
const ownedFiles = new Set([
  "current-candidate.json",
  "current-images.json",
  "current-model-routes.json",
  "current-selection.json",
]);
const activeMarkerPattern = /^([a-f0-9]{16})\.json$/u;
const processIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw new Error("integration.cleanup.active", { cause: error });
  }
};
const parseActiveMarker = (root, entry) => {
  const match = activeMarkerPattern.exec(entry.name);
  const path = resolve(root, entry.name);
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    value = undefined;
  }
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    match === null ||
    value === null ||
    typeof value !== "object" ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(["activeVersion", "pid", "runId"]) ||
    value.activeVersion !== 1 ||
    value.runId !== match[1] ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1
  )
    throw new Error("integration.cleanup.path");
  if (processIsAlive(value.pid)) throw new Error("integration.cleanup.active");
  return { path, bytes: statSync(path).size };
};
const directoryBytes = (root) => {
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = resolve(current, entry.name);
      if (!target.startsWith(`${root}${sep}`) || entry.isSymbolicLink())
        throw new Error("integration.cleanup.path");
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) bytes += statSync(target).size;
      else throw new Error("integration.cleanup.path");
    }
  }
  return bytes;
};
const assertOwnedRoot = () => {
  const status = lstatSync(artifactsRoot);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    realpathSync(artifactsRoot) !== expectedRealArtifactsRoot
  )
    throw new Error("integration.cleanup.path");
};
const diskTargets = [];
try {
  assertOwnedRoot();
  for (const entry of readdirSync(artifactsRoot, { withFileTypes: true })) {
    const target = resolve(artifactsRoot, entry.name);
    if (!target.startsWith(`${artifactsRoot}${sep}`) || entry.isSymbolicLink())
      throw new Error("integration.cleanup.path");
    if (entry.isFile()) {
      if (!ownedFiles.has(entry.name))
        throw new Error("integration.cleanup.path");
      diskTargets.push({ path: target, bytes: statSync(target).size });
      continue;
    }
    if (entry.name === "active") {
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("integration.cleanup.path");
      diskTargets.push(
        ...readdirSync(target, { withFileTypes: true }).map((marker) =>
          parseActiveMarker(target, marker),
        ),
      );
      continue;
    }
    const pattern = ownedDirectories[entry.name];
    if (!entry.isDirectory() || pattern === undefined)
      throw new Error("integration.cleanup.path");
    for (const child of readdirSync(target, { withFileTypes: true })) {
      if (
        !child.isDirectory() ||
        child.isSymbolicLink() ||
        !pattern.test(child.name)
      )
        throw new Error("integration.cleanup.path");
      const childPath = resolve(target, child.name);
      diskTargets.push({ path: childPath, bytes: directoryBytes(childPath) });
    }
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const containers = list("container");
const networks = list("network");
const images = list("image");
console.log(
  JSON.stringify({
    cleanupVersion: 1,
    containers,
    networks,
    images,
    disk: diskTargets.map(({ path, bytes }) => ({
      path: path.slice(`${artifactsRoot}${sep}`.length),
      bytes,
    })),
    diskBytes: diskTargets.reduce((total, target) => total + target.bytes, 0),
  }),
);
remove(["container", "rm", "--force"], containers);
remove(["network", "rm"], networks);
remove(["image", "rm", "--force"], images);
for (const target of diskTargets) {
  assertOwnedRoot();
  const status = lstatSync(target.path);
  const realTarget = realpathSync(target.path);
  if (
    status.isSymbolicLink() ||
    !realTarget.startsWith(`${expectedRealArtifactsRoot}${sep}`)
  )
    throw new Error("integration.cleanup.path");
  rmSync(target.path, { force: true, recursive: true });
}
for (const directory of Object.keys(ownedDirectories)) {
  const path = resolve(artifactsRoot, directory);
  try {
    assertOwnedRoot();
    const status = lstatSync(path);
    if (!status.isDirectory() || status.isSymbolicLink())
      throw new Error("integration.cleanup.path");
    if (readdirSync(path).length === 0) rmSync(path, { recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
try {
  assertOwnedRoot();
  const activeRoot = resolve(artifactsRoot, "active");
  const status = lstatSync(activeRoot);
  if (!status.isDirectory() || status.isSymbolicLink())
    throw new Error("integration.cleanup.path");
  if (readdirSync(activeRoot).length === 0)
    rmSync(activeRoot, { recursive: true });
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
try {
  assertOwnedRoot();
  if (
    lstatSync(artifactsRoot).isDirectory() &&
    readdirSync(artifactsRoot).length === 0
  )
    rmSync(artifactsRoot, { recursive: true });
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
console.log("Agentscope integration cleanup complete.");
releaseOperationLock();
process.removeListener("exit", releaseOperationLock);
