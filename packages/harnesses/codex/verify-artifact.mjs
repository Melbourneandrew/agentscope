import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const packageManifest = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8"),
);
const expectedExports = {
  ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
  "./testing": {
    types: "./dist/testing.d.ts",
    import: "./dist/testing.js",
  },
};

if (JSON.stringify(packageManifest.exports) !== JSON.stringify(expectedExports))
  throw new Error("codex.artifact.exports");

const localModulePattern =
  /(?:from\s*|import\s*)["'](\.\/[A-Za-z0-9._/-]+)["']/gu;
const rootEntry = resolve(packageRoot, "dist/index.js");
const testingEntry = resolve(packageRoot, "dist/testing.js");
const testingCoreSpecifier = ["@agentscope/harnesses-core", "testing"].join(
  "/",
);
const visited = new Set();
const pending = [rootEntry];

while (pending.length > 0) {
  const path = pending.pop();
  if (path === undefined || visited.has(path)) continue;
  visited.add(path);
  const source = readFileSync(path, "utf8");
  if (
    source.includes(testingCoreSpecifier) ||
    source.includes("vendor-observability-hook")
  )
    throw new Error("codex.artifact.production-authority");
  for (const match of source.matchAll(localModulePattern)) {
    const specifier = match[1];
    if (specifier === undefined) throw new Error("codex.artifact.graph");
    pending.push(resolve(dirname(path), specifier));
  }
}

if (visited.has(testingEntry))
  throw new Error("codex.artifact.testing-reachable");
const productionRoot = await import(pathToFileURL(rootEntry).href);
for (const forbiddenExport of [
  "codexComponentContractAdapter",
  "codexComponentScenario",
  "codexSanitizedFixture",
])
  if (Object.hasOwn(productionRoot, forbiddenExport))
    throw new Error("codex.artifact.production-testing-export");
const testingSource = readFileSync(testingEntry, "utf8");
if (
  !testingSource.includes(testingCoreSpecifier) ||
  !testingSource.includes("vendor-observability-hook")
)
  throw new Error("codex.artifact.testing-surface");

process.stdout.write(
  "Verified Codex production graph and explicit test-only artifact surface.\n",
);
