import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedWorkspacePackages } from "./workspace-packages.mjs";
import { auditCoreFinalizationImports } from "./restricted-import-policy.mjs";
import { expectedInternalDependenciesFor } from "./workspace-dependency-policy.mjs";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const authoritativeDocumentationPaths = [
  /^(?:AGENTS|CLAUDE|CONTRIBUTING|README)\.[mM][dD]$/u,
  /^\.agents\/(?:research\/precedents|skills)\/.+\.[mM][dD]$/u,
  /^\.beads\/.+\.[mM][dD]$/u,
  /^\.github\/(?:ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE)\/.+\.[mM][dD]$/u,
  /^apps\/docs\/(?:AGENTS|CLAUDE)\.[mM][dD]$/u,
  /^apps\/docs\/content\/docs\/(?:index\.[mM][dD][xX]|(?:blueprints|cli|requirements)\/.+\.[mM][dD][xX])$/u,
  /^(?:apps|ops|packages|tests)\/.+\/README\.[mM][dD]$/u,
  /^packages\/harnesses\/core\/NATIVE_FIXTURES\.[mM][dD]$/u,
];
const ambiguousDocumentationSegment =
  /^(?:draft|handoff|notes?|removal[-_.]?receipt|scratch(?:pad)?|temp(?:orary)?)$/iu;

export function auditDocumentationPlacement(trackedPaths) {
  const violations = trackedPaths
    .filter((path) => /\.mdx?$/iu.test(path))
    .filter((path) => {
      if (path.startsWith(".beads/")) return false;
      const segments = path.split("/");
      const basename = segments.at(-1)?.replace(/\.mdx?$/iu, "") ?? "";
      return (
        ambiguousDocumentationSegment.test(basename) ||
        !authoritativeDocumentationPaths.some((pattern) => pattern.test(path))
      );
    })
    .sort();

  if (violations.length > 0) {
    throw new Error(
      `Tracked Markdown must use an authoritative documentation path and non-scratch name: ${violations.join(", ")}`,
    );
  }
}

export function listTrackedPaths(cwd = workspaceRoot) {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

auditDocumentationPlacement(listTrackedPaths());

const expectedPackages = expectedWorkspacePackages;

const packageRoots = [
  "apps",
  "packages",
  "packages/destinations",
  "packages/harnesses",
  "tests",
];
const discoveredPackagePaths = packageRoots.flatMap((packageRoot) =>
  readdirSync(resolve(workspaceRoot, packageRoot), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(
          resolve(workspaceRoot, packageRoot, entry.name, "package.json"),
        ),
    )
    .map((entry) => `${packageRoot}/${entry.name}`),
);
const unexpectedPackagePaths = discoveredPackagePaths.filter(
  (packagePath) => !expectedPackages.has(packagePath),
);
if (unexpectedPackagePaths.length > 0) {
  throw new Error(
    `Unexpected workspace package paths: ${unexpectedPackagePaths.sort().join(", ")}`,
  );
}

const manifests = new Map();

for (const [relativePath, expectedName] of expectedPackages) {
  const manifestPath = resolve(workspaceRoot, relativePath, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing workspace manifest: ${relativePath}/package.json`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== expectedName) {
    throw new Error(
      `${relativePath}/package.json must be named ${expectedName}; found ${String(manifest.name)}`,
    );
  }
  if (manifests.has(manifest.name)) {
    throw new Error(`Duplicate workspace package name: ${manifest.name}`);
  }
  manifests.set(manifest.name, { manifest, relativePath });
}

for (const legacyPath of [
  "packages/destinations/console/package.json",
  "packages/harnesses/cursor/package.json",
]) {
  if (existsSync(resolve(workspaceRoot, legacyPath))) {
    throw new Error(`Removed legacy workspace must not exist: ${legacyPath}`);
  }
}

const publishable = [...manifests.entries()]
  .filter(([, { manifest }]) => manifest.private !== true)
  .map(([name]) => name);

if (publishable.length !== 1 || publishable[0] !== "agentscope-cli") {
  throw new Error(
    `Only agentscope-cli may be publishable; found ${publishable.join(", ")}`,
  );
}

const cli = manifests.get("agentscope-cli")?.manifest;
if (cli?.bin?.agentscope !== "./dist/bin/agentscope.js") {
  throw new Error(
    "agentscope-cli must expose agentscope at ./dist/bin/agentscope.js",
  );
}
if (cli?.publishConfig?.access !== "public") {
  throw new Error("agentscope-cli must explicitly use public npm access");
}
const publicRuntimeDependencies = Object.keys({
  ...cli?.dependencies,
  ...cli?.optionalDependencies,
  ...cli?.peerDependencies,
}).filter((dependency) => dependency.startsWith("@agentscope/"));
if (publicRuntimeDependencies.length > 0) {
  throw new Error(
    `agentscope-cli may not publish private workspace dependencies: ${publicRuntimeDependencies.join(", ")}`,
  );
}

const protocol = manifests.get("@agentscope/protocol")?.manifest;
const expectedFinalizationExport = {
  types: "./dist/core-finalization.d.ts",
  import: "./dist/core-finalization.js",
};
if (
  JSON.stringify(protocol?.exports?.["./core-finalization"]) !==
  JSON.stringify(expectedFinalizationExport)
) {
  throw new Error(
    "@agentscope/protocol must expose the exact Core-only finalization entrypoint.",
  );
}

const graph = new Map();
for (const [name, { manifest }] of manifests) {
  if (
    name !== "agentscope-cli" &&
    !manifest.scripts?.prepack?.endsWith("scripts/refuse-private-package.mjs")
  ) {
    throw new Error(`${name} must refuse private package packing`);
  }

  const declared = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
    ...manifest.devDependencies,
  };
  const internal = Object.keys(declared)
    .filter((dependency) => dependency.startsWith("@agentscope/"))
    .sort();
  const expected = expectedInternalDependenciesFor(name);

  if (JSON.stringify(internal) !== JSON.stringify(expected)) {
    throw new Error(
      `${name} internal dependencies must be ${JSON.stringify(expected)}; found ${JSON.stringify(internal)}`,
    );
  }

  for (const dependency of internal) {
    if (!manifests.has(dependency)) {
      throw new Error(`${name} references unknown workspace ${dependency}`);
    }
    if (declared[dependency] !== "workspace:*") {
      throw new Error(
        `${name} must declare ${dependency} with the workspace:* protocol`,
      );
    }
  }
  graph.set(name, internal);
}

const visiting = new Set();
const visited = new Set();
function visit(name, path = []) {
  if (visiting.has(name)) {
    throw new Error(
      `Workspace dependency cycle: ${[...path, name].join(" -> ")}`,
    );
  }
  if (visited.has(name)) return;

  visiting.add(name);
  for (const dependency of graph.get(name) ?? []) {
    visit(dependency, [...path, name]);
  }
  visiting.delete(name);
  visited.add(name);
}

for (const name of graph.keys()) visit(name);

auditCoreFinalizationImports(workspaceRoot, expectedPackages);

process.stdout.write(
  `Verified ${manifests.size} workspace packages; agentscope-cli is the sole publishable package.\n`,
);
