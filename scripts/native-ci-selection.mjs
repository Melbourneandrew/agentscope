import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

const maximumBytes = 1024 * 1024;
const maximumPaths = 4_096;
const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

const repositoryRoot = new URL("../", import.meta.url);
const policyManifestUrl = new URL(
  "./native-ci-irrelevant-paths.json",
  import.meta.url,
);
const policyManifestPath = "scripts/native-ci-irrelevant-paths.json";
const unconditionalNativePaths = new Set([
  ".github/workflows/pr-validation.yml",
  ".github/workflows/release-candidate-rehearsal.yml",
  "scripts/__tests__/native-ci-policy.test.mjs",
  policyManifestPath,
  "scripts/native-ci-selection.mjs",
  "scripts/workspace-policy-runner.mjs",
]);
const historicalIrrelevantPaths = new Set([
  "tests/integration/evidence/local-docker-substrate-2026-08-22.json",
  "tests/integration/src/controller-policy.test.ts",
]);

function approvedIrrelevantPath(path) {
  return (
    path === "CONTRIBUTING.md" ||
    path === "README.md" ||
    /^apps\/docs\/content\/docs\/(?!blueprints\/|requirements\/).+\.mdx?$/u.test(
      path,
    ) ||
    /^ops\/[^/]+\/README\.md$/u.test(path) ||
    historicalIrrelevantPaths.has(path)
  );
}

function validPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.includes("\n") &&
    !path.includes("\r") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function parseChangedPaths(output) {
  if (!Buffer.isBuffer(output) || output.length > maximumBytes)
    throw new Error("native-ci-paths-invalid");
  if (output.length === 0) return [];
  if (output.at(-1) !== 0) throw new Error("native-ci-paths-invalid");
  const paths = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    if (index === start || paths.length >= maximumPaths)
      throw new Error("native-ci-paths-invalid");
    let path;
    try {
      path = decoder.decode(output.subarray(start, index));
    } catch {
      throw new Error("native-ci-paths-invalid");
    }
    if (!validPath(path)) throw new Error("native-ci-paths-invalid");
    paths.push(path);
    start = index + 1;
  }
  if (start !== output.length || new Set(paths).size !== paths.length)
    throw new Error("native-ci-paths-invalid");
  return paths;
}

export function parseTrackedEntries(output) {
  return parseChangedPaths(output).map((entry) => {
    const match =
      /^(100644|100755|120000|160000) ([0-9a-f]{40}|[0-9a-f]{64}) 0\t(.+)$/u.exec(
        entry,
      );
    if (match === null || !validPath(match[3]))
      throw new Error("native-ci-policy-invalid");
    return Object.freeze({
      mode: match[1],
      objectId: match[2],
      path: match[3],
    });
  });
}

export function validateNativeCiPolicy(manifest, trackedEntries) {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    Object.keys(manifest).sort().join(",") !== "irrelevantPaths,version" ||
    manifest.version !== 2 ||
    !Array.isArray(manifest.irrelevantPaths) ||
    !Array.isArray(trackedEntries)
  )
    throw new Error("native-ci-policy-invalid");
  if (
    manifest.irrelevantPaths.length === 0 ||
    manifest.irrelevantPaths.some(
      (path) => !validPath(path) || !approvedIrrelevantPath(path),
    ) ||
    new Set(manifest.irrelevantPaths).size !==
      manifest.irrelevantPaths.length ||
    manifest.irrelevantPaths.some(
      (path, index) => index > 0 && manifest.irrelevantPaths[index - 1] >= path,
    )
  )
    throw new Error("native-ci-policy-invalid");
  const trackedPaths = trackedEntries.map((entry) => entry.path);
  if (
    trackedEntries.length === 0 ||
    trackedEntries.some(
      (entry) =>
        entry === null ||
        typeof entry !== "object" ||
        !/^(?:100644|100755|120000|160000)$/u.test(entry.mode) ||
        !objectIdPattern.test(entry.objectId) ||
        !validPath(entry.path),
    ) ||
    new Set(trackedPaths).size !== trackedPaths.length ||
    trackedPaths.some(
      (path, index) => index > 0 && trackedPaths[index - 1] >= path,
    )
  )
    throw new Error("native-ci-policy-invalid");
  const irrelevantPaths = new Set(manifest.irrelevantPaths);
  const trackedByPath = new Map(
    trackedEntries.map((entry) => [entry.path, entry]),
  );
  if (
    [...unconditionalNativePaths].some((path) => irrelevantPaths.has(path)) ||
    [...unconditionalNativePaths].some(
      (path) => trackedByPath.get(path)?.mode !== "100644",
    ) ||
    manifest.irrelevantPaths.some(
      (path) =>
        trackedByPath.get(path)?.mode !== "100644" &&
        !(historicalIrrelevantPaths.has(path) && !trackedByPath.has(path)),
    )
  )
    throw new Error("native-ci-policy-invalid");
  const authorityEntries = trackedEntries.filter(
    ({ path }) => path !== policyManifestPath && !irrelevantPaths.has(path),
  );
  if (authorityEntries.length === 0)
    throw new Error("native-ci-policy-invalid");
  return Object.freeze({
    authorityFiles: Object.freeze(authorityEntries.map(({ path }) => path)),
    irrelevantPaths,
  });
}

function captureTrackedEntries() {
  const result = spawnSync(
    "git",
    ["-C", fileURLToPath(repositoryRoot), "ls-files", "--stage", "-z"],
    { encoding: null, maxBuffer: maximumBytes, shell: false, timeout: 30_000 },
  );
  if (result.error || result.status !== 0 || result.signal !== null)
    throw new Error("native-ci-policy-invalid");
  return parseTrackedEntries(result.stdout);
}

function loadNativeCiPolicy() {
  const manifest = JSON.parse(readFileSync(policyManifestUrl, "utf8"));
  return validateNativeCiPolicy(manifest, captureTrackedEntries());
}

let nativeCiPolicy;
try {
  nativeCiPolicy = loadNativeCiPolicy();
} catch {
  nativeCiPolicy = undefined;
}

export function pruneNativeIrrelevantPaths(
  root = repositoryRoot,
  irrelevantPaths = nativeCiPolicy?.irrelevantPaths,
) {
  if (!(irrelevantPaths instanceof Set))
    throw new Error("native-ci-policy-invalid");
  const rootPath = fileURLToPath(root);
  for (const path of irrelevantPaths) {
    const target = resolve(rootPath, ...path.split("/"));
    if (relative(rootPath, target).split(sep).join("/") !== path)
      throw new Error("native-ci-prune-invalid");
    rmSync(target, { force: true, recursive: false });
    if (existsSync(target)) throw new Error("native-ci-prune-failed");
  }
  process.stdout.write(`pruned=${irrelevantPaths.size}\n`);
}

export function selectNativeCertification(eventName, changedPaths = []) {
  if (eventName !== "pull_request") {
    return Object.freeze({
      required: true,
      reason: "protected-merge-or-manual",
    });
  }
  if (!Array.isArray(changedPaths) || changedPaths.length === 0)
    return Object.freeze({
      required: true,
      reason: "empty-or-invalid-change-set",
    });
  if (nativeCiPolicy === undefined)
    return Object.freeze({
      required: true,
      reason: "native-ci-policy-invalid",
    });
  const relevant = changedPaths.find(
    (path) =>
      unconditionalNativePaths.has(path) ||
      !nativeCiPolicy.irrelevantPaths.has(path),
  );
  return relevant === undefined
    ? Object.freeze({ required: false, reason: "explicitly-irrelevant-paths" })
    : Object.freeze({
        required: true,
        reason: "native-relevant-or-unknown-path",
      });
}

function captureDiff(base, head) {
  if (!objectIdPattern.test(base) || !objectIdPattern.test(head))
    throw new Error("native-ci-revision-invalid");
  const result = spawnSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"],
    { encoding: null, maxBuffer: maximumBytes, shell: false, timeout: 30_000 },
  );
  if (result.error || result.status !== 0 || result.signal !== null)
    throw new Error("native-ci-diff-unavailable");
  return parseChangedPaths(result.stdout);
}

export function runNativeSelection({
  eventName = process.env.GITHUB_EVENT_NAME,
  base = process.env.NATIVE_BASE_SHA,
  head = process.env.NATIVE_HEAD_SHA,
  outputPath = process.env.GITHUB_OUTPUT,
} = {}) {
  let selection;
  try {
    const paths = eventName === "pull_request" ? captureDiff(base, head) : [];
    selection = selectNativeCertification(eventName, paths);
  } catch (error) {
    selection = Object.freeze({
      required: true,
      reason: `fail-closed:${error instanceof Error ? error.message : "unknown"}`,
    });
  }
  const output = `required=${selection.required}\nreason=${selection.reason}\n`;
  if (typeof outputPath === "string" && outputPath.length > 0)
    appendFileSync(outputPath, output, { encoding: "utf8" });
  process.stdout.write(output);
  return selection;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--prune-irrelevant") pruneNativeIrrelevantPaths();
  else runNativeSelection();
}
