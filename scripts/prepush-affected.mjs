import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
const nxConfigurationPath = resolve(repositoryRoot, "nx.json");
const captureTimeoutMilliseconds = 30_000;
const maximumCaptureBytes = 1024 * 1024;
const maximumNxConfigurationBytes = 64 * 1024;
const maximumChangedPaths = 4_096;
const maximumProjects = 256;
const admittedDefaultBase = "main";
const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const projectNamePattern = /^(?:@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)$/u;
const baseNamePattern = /^(?!-)[A-Za-z0-9._/-]{1,256}$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

const rootPolicyPath =
  /^(?:\.github\/|\.husky\/|scripts\/|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|nx\.json$|eslint\.config\.mjs$|tsconfig(?:\.[^/]+)?\.json$|vitest\.config\.ts$|quality-policy\.json$|acceptance-evidence\.json$)|(?:^|\/)(?:package|project)\.json$/u;
const operationalDocumentationPath =
  /^(?:(?:README|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT)\.mdx?|ops\/(?:[^/]+\/)*[^/]+\.mdx?)$/u;
const requiredTargets = Object.freeze(["build", "lint", "test", "typecheck"]);
const policyCommands = Object.freeze([
  ["test:workspace-policy"],
  ["verify:quality"],
  ["verify:acceptance-evidence"],
]);

function validRelativePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function successfulOutput(result) {
  if (
    result === null ||
    typeof result !== "object" ||
    result.error !== undefined ||
    result.status !== 0 ||
    result.signal !== null ||
    !Buffer.isBuffer(result.stdout) ||
    result.stdout.length > maximumCaptureBytes
  ) {
    throw new Error("prepush-selection-unavailable");
  }
  return result.stdout;
}

export function parseObjectId(output) {
  let value;
  try {
    value = decoder.decode(output);
  } catch {
    throw new Error("prepush-base-invalid");
  }
  if (!value.endsWith("\n")) throw new Error("prepush-base-invalid");
  const lines = value.slice(0, -1).split("\n");
  if (lines.length !== 1 || !objectIdPattern.test(lines[0])) {
    throw new Error("prepush-base-invalid");
  }
  return lines[0];
}

export function parseChangedPaths(output) {
  if (!Buffer.isBuffer(output) || output.length > maximumCaptureBytes) {
    throw new Error("prepush-paths-invalid");
  }
  if (output.length === 0) return [];
  if (output.at(-1) !== 0) throw new Error("prepush-paths-invalid");
  const paths = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    if (index === start || paths.length >= maximumChangedPaths) {
      throw new Error("prepush-paths-invalid");
    }
    let path;
    try {
      path = decoder.decode(output.subarray(start, index));
    } catch {
      throw new Error("prepush-paths-invalid");
    }
    if (!validRelativePath(path)) throw new Error("prepush-paths-invalid");
    paths.push(path);
    start = index + 1;
  }
  if (start !== output.length || new Set(paths).size !== paths.length) {
    throw new Error("prepush-paths-invalid");
  }
  return paths;
}

export function parseAffectedProjects(output) {
  let parsed;
  try {
    parsed = JSON.parse(decoder.decode(output));
  } catch {
    throw new Error("prepush-projects-invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > maximumProjects ||
    parsed.some(
      (name) => typeof name !== "string" || !projectNamePattern.test(name),
    ) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new Error("prepush-projects-invalid");
  }
  return [...parsed].sort();
}

export function parseProjectMetadata(output, expectedName) {
  let parsed;
  try {
    parsed = JSON.parse(decoder.decode(output));
  } catch {
    throw new Error("prepush-project-invalid");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.name !== expectedName ||
    !validRelativePath(parsed.root) ||
    parsed.root === "." ||
    parsed.targets === null ||
    typeof parsed.targets !== "object" ||
    Array.isArray(parsed.targets) ||
    requiredTargets.some(
      (target) =>
        parsed.targets[target] === null ||
        typeof parsed.targets[target] !== "object" ||
        Array.isArray(parsed.targets[target]),
    )
  ) {
    throw new Error("prepush-project-invalid");
  }
  return Object.freeze({ name: parsed.name, root: parsed.root });
}

function parseConfiguredBase(contents) {
  if (
    typeof contents !== "string" ||
    Buffer.byteLength(contents) > maximumNxConfigurationBytes
  ) {
    throw new Error("prepush-base-invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("prepush-base-invalid");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof parsed.defaultBase !== "string" ||
    !baseNamePattern.test(parsed.defaultBase) ||
    parsed.defaultBase !== admittedDefaultBase ||
    parsed.defaultBase.includes("..") ||
    parsed.defaultBase.includes("//")
  ) {
    throw new Error("prepush-base-invalid");
  }
  return parsed.defaultBase;
}

function isCoveredByProject(path, projects) {
  return projects.some(
    ({ root }) => path === root || path.startsWith(`${root}/`),
  );
}

export function selectPrepushMode(changedFiles, affectedProjects, available) {
  if (!available) {
    return { full: true, policyChecks: true, verifyCliArtifact: true };
  }
  const roots = new Set(affectedProjects.map(({ root }) => root));
  const invalidProjects = roots.size !== affectedProjects.length;
  const policy = changedFiles.some((path) => rootPolicyPath.test(path));
  const uncovered = changedFiles.some(
    (path) =>
      !rootPolicyPath.test(path) &&
      !operationalDocumentationPath.test(path) &&
      !isCoveredByProject(path, affectedProjects),
  );
  const full = invalidProjects || policy || uncovered;
  return {
    full,
    policyChecks: full,
    verifyCliArtifact:
      full || affectedProjects.some(({ name }) => name === "agentscope-cli"),
  };
}

const capture = (executable, arguments_) =>
  spawnSync(executable, arguments_, {
    cwd: repositoryRoot,
    encoding: null,
    env: process.env,
    maxBuffer: maximumCaptureBytes,
    shell: false,
    timeout: captureTimeoutMilliseconds,
  });

const run = (arguments_) =>
  spawnSync("pnpm", arguments_, {
    cwd: repositoryRoot,
    env: process.env,
    shell: false,
    stdio: "inherit",
  });

export function createPrepushPlan({
  captureCommand = capture,
  nxConfiguration = () => readFileSync(nxConfigurationPath, "utf8"),
} = {}) {
  try {
    const configuredBase = parseConfiguredBase(nxConfiguration());
    const base = parseObjectId(
      successfulOutput(
        captureCommand("git", [
          "rev-parse",
          "--verify",
          `${configuredBase}^{commit}`,
        ]),
      ),
    );
    const head = parseObjectId(
      successfulOutput(
        captureCommand("git", ["rev-parse", "--verify", "HEAD^{commit}"]),
      ),
    );
    const changedFiles = parseChangedPaths(
      successfulOutput(
        captureCommand("git", [
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          `${base}...${head}`,
          "--",
        ]),
      ),
    );
    const affectedArguments = [
      "nx",
      "show",
      "projects",
      "--affected",
      `--base=${base}`,
      `--head=${head}`,
      "--json",
    ];
    const names = parseAffectedProjects(
      successfulOutput(captureCommand("pnpm", affectedArguments)),
    );
    const projects = names.map((name) =>
      parseProjectMetadata(
        successfulOutput(
          captureCommand("pnpm", ["nx", "show", "project", name, "--json"]),
        ),
        name,
      ),
    );
    return Object.freeze({
      base,
      head,
      mode: selectPrepushMode(changedFiles, projects, true),
    });
  } catch {
    return Object.freeze({
      mode: selectPrepushMode([], [], false),
    });
  }
}

export function createPrepushCommands(plan) {
  const commands = [["verify:targets"], ["format:check"]];
  if (plan.mode.policyChecks) commands.push(...policyCommands);
  const selection = plan.mode.full
    ? ["run-many", "--all"]
    : ["affected", `--base=${plan.base}`, `--head=${plan.head}`];
  commands.push(["nx", selection[0], "-t", "build", ...selection.slice(1)]);
  commands.push([
    "nx",
    selection[0],
    "-t",
    "lint,typecheck,test",
    ...selection.slice(1),
  ]);
  if (plan.mode.verifyCliArtifact) commands.push(["verify:cli-artifact"]);
  return commands;
}

export function executePrepush(options = {}) {
  const plan = createPrepushPlan(options);
  const runCommand = options.runCommand ?? run;
  for (const arguments_ of createPrepushCommands(plan)) {
    const result = runCommand(arguments_);
    if (result?.error !== undefined) throw result.error;
    if (result?.signal !== null && result?.signal !== undefined) {
      process.kill(process.pid, result.signal);
      return 74;
    }
    if (result?.status !== 0) return result?.status ?? 74;
  }
  return 0;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = executePrepush();
  } catch {
    process.stderr.write("prepush: affected-validation-unavailable\n");
    process.exitCode = 74;
  }
}
