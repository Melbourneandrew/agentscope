import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedWorkspacePackages } from "./workspace-packages.mjs";
import { auditCoreFinalizationImports } from "./restricted-import-policy.mjs";
import { expectedInternalDependenciesFor } from "./workspace-dependency-policy.mjs";
import { loadWorkspacePackageGraph } from "./workspace-package-graph.mjs";

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

const { graph, manifests } = loadWorkspacePackageGraph(
  workspaceRoot,
  expectedPackages,
);

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
  const internal = graph.get(name);
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
}

auditCoreFinalizationImports(workspaceRoot, expectedPackages);

process.stdout.write(
  `Verified ${manifests.size} workspace packages; agentscope-cli is the sole publishable package.\n`,
);
