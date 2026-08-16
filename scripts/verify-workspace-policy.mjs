import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const expectedPackages = new Map([
  ["apps/cli", "@agentscope/cli"],
  ["apps/docs", "@agentscope/docs"],
  ["packages/core", "@agentscope/core"],
  ["packages/protocol", "@agentscope/protocol"],
  ["packages/testkit", "@agentscope/testkit"],
  ["packages/destinations/core", "@agentscope/destinations-core"],
  ["packages/destinations/langfuse", "@agentscope/destination-langfuse"],
  [
    "packages/destinations/local-sqlite",
    "@agentscope/destination-local-sqlite",
  ],
  ["packages/harnesses/core", "@agentscope/harnesses-core"],
  ["packages/harnesses/claude-code", "@agentscope/harness-claude-code"],
  ["packages/harnesses/codex", "@agentscope/harness-codex"],
  ["packages/harnesses/gemini-cli", "@agentscope/harness-gemini-cli"],
  ["packages/harnesses/hermes", "@agentscope/harness-hermes"],
  ["packages/harnesses/opencode", "@agentscope/harness-opencode"],
  ["packages/harnesses/openclaw", "@agentscope/harness-openclaw"],
  ["packages/harnesses/pi", "@agentscope/harness-pi"],
  ["tests/integration-live", "@agentscope/integration-live"],
]);

const expectedInternalDependencies = new Map([
  [
    "@agentscope/cli",
    [
      "@agentscope/core",
      "@agentscope/destination-langfuse",
      "@agentscope/destination-local-sqlite",
      "@agentscope/harness-claude-code",
      "@agentscope/harness-codex",
      "@agentscope/harness-gemini-cli",
      "@agentscope/harness-hermes",
      "@agentscope/harness-opencode",
      "@agentscope/harness-openclaw",
      "@agentscope/harness-pi",
    ],
  ],
  ["@agentscope/docs", []],
  [
    "@agentscope/core",
    ["@agentscope/destinations-core", "@agentscope/protocol"],
  ],
  ["@agentscope/protocol", []],
  [
    "@agentscope/testkit",
    [
      "@agentscope/destinations-core",
      "@agentscope/harnesses-core",
      "@agentscope/protocol",
    ],
  ],
  ["@agentscope/destinations-core", ["@agentscope/protocol"]],
  [
    "@agentscope/destination-langfuse",
    ["@agentscope/destinations-core", "@agentscope/protocol"],
  ],
  [
    "@agentscope/destination-local-sqlite",
    ["@agentscope/destinations-core", "@agentscope/protocol"],
  ],
  ["@agentscope/harnesses-core", ["@agentscope/protocol"]],
  ...[
    "claude-code",
    "codex",
    "gemini-cli",
    "hermes",
    "opencode",
    "openclaw",
    "pi",
  ].map((harness) => [
    `@agentscope/harness-${harness}`,
    ["@agentscope/core", "@agentscope/harnesses-core", "@agentscope/protocol"],
  ]),
  ["@agentscope/integration-live", []],
]);

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

if (publishable.length !== 1 || publishable[0] !== "@agentscope/cli") {
  throw new Error(
    `Only @agentscope/cli may be publishable; found ${publishable.join(", ")}`,
  );
}

const cli = manifests.get("@agentscope/cli")?.manifest;
if (cli?.bin?.agentscope !== "./dist/bin/agentscope.js") {
  throw new Error(
    "@agentscope/cli must expose agentscope at ./dist/bin/agentscope.js",
  );
}
if (cli?.publishConfig?.access !== "public") {
  throw new Error("@agentscope/cli must explicitly use public npm access");
}
const publicRuntimeDependencies = Object.keys({
  ...cli?.dependencies,
  ...cli?.optionalDependencies,
  ...cli?.peerDependencies,
}).filter((dependency) => dependency.startsWith("@agentscope/"));
if (publicRuntimeDependencies.length > 0) {
  throw new Error(
    `@agentscope/cli may not publish private workspace dependencies: ${publicRuntimeDependencies.join(", ")}`,
  );
}

const graph = new Map();
for (const [name, { manifest }] of manifests) {
  if (
    name !== "@agentscope/cli" &&
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
  const expected = [...(expectedInternalDependencies.get(name) ?? [])].sort();

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

process.stdout.write(
  `Verified ${manifests.size} workspace packages; @agentscope/cli is the sole publishable package.\n`,
);
