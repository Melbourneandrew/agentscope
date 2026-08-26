import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(packageRoot, "src");
const distRoot = resolve(packageRoot, "dist");
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

const listRegularFiles = (directory, prefix = "") => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listRegularFiles(join(directory, entry.name), relative));
      continue;
    }
    if (!entry.isFile()) throw new Error("codex.artifact.non-regular");
    files.push(relative);
  }
  return files.sort();
};

const sourceModules = listRegularFiles(sourceRoot)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => file.slice(0, -3));
const expectedFiles = sourceModules
  .flatMap((module) => [`${module}.d.ts`, `${module}.js`])
  .sort();
const actualFiles = listRegularFiles(distRoot);
if (
  actualFiles.length !== expectedFiles.length ||
  actualFiles.some((file, index) => file !== expectedFiles[index]) ||
  actualFiles.some((file) => file.includes(".test."))
)
  throw new Error("codex.artifact.inventory");

const moduleSpecifiers = (path) => {
  const source = readFileSync(path, "utf8");
  const parsed = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.ESNext,
    true,
    path.endsWith(".d.ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  if (parsed.parseDiagnostics.length > 0)
    throw new Error("codex.artifact.syntax");
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text);
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      specifiers.push(node.argument.literal.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    )
      throw new Error("codex.artifact.dynamic-import");
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return { source, specifiers };
};

const graph = (entry, declaration) => {
  const visited = new Set();
  const external = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || visited.has(path)) continue;
    visited.add(path);
    const parsed = moduleSpecifiers(path);
    for (const specifier of parsed.specifiers) {
      if (!specifier.startsWith(".")) {
        external.add(specifier);
        continue;
      }
      const local = resolve(
        dirname(path),
        declaration && specifier.endsWith(".js")
          ? `${specifier.slice(0, -3)}.d.ts`
          : specifier,
      );
      if (!local.startsWith(`${distRoot}/`))
        throw new Error("codex.artifact.graph-escape");
      try {
        readFileSync(local, "utf8");
      } catch {
        throw new Error("codex.artifact.unresolved-edge");
      }
      pending.push(local);
    }
  }
  return { visited, external };
};

const rootRuntime = resolve(distRoot, "index.js");
const rootDeclaration = resolve(distRoot, "index.d.ts");
const testingRuntime = resolve(distRoot, "testing.js");
const testingDeclaration = resolve(distRoot, "testing.d.ts");
const graphs = {
  rootRuntime: graph(rootRuntime, false),
  rootDeclaration: graph(rootDeclaration, true),
  testingRuntime: graph(testingRuntime, false),
  testingDeclaration: graph(testingDeclaration, true),
};
const testingCoreSpecifier = ["@agentscope/harnesses-core", "testing"].join(
  "/",
);
const assertGraph = (actual, expected, code) => {
  const relative = [...actual]
    .map((path) => path.slice(distRoot.length + 1))
    .sort();
  const sortedExpected = [...expected].sort();
  if (
    relative.length !== sortedExpected.length ||
    relative.some((path, index) => path !== sortedExpected[index])
  )
    throw new Error(code);
};
const assertExternal = (actual, expected, code) => {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (
    sortedActual.length !== sortedExpected.length ||
    sortedActual.some((specifier, index) => specifier !== sortedExpected[index])
  )
    throw new Error(code);
};
assertGraph(
  graphs.rootRuntime.visited,
  [
    "configuration.js",
    "descriptor.js",
    "index.js",
    "installation.js",
    "mapping.js",
    "strict-json.js",
  ],
  "codex.artifact.root-runtime-graph",
);
assertGraph(
  graphs.rootDeclaration.visited,
  [
    "configuration.d.ts",
    "descriptor.d.ts",
    "index.d.ts",
    "installation.d.ts",
    "mapping.d.ts",
  ],
  "codex.artifact.root-declaration-graph",
);
assertGraph(
  graphs.testingRuntime.visited,
  [
    "descriptor.js",
    "installation.js",
    "mapping.js",
    "strict-json.js",
    "testing.js",
  ],
  "codex.artifact.testing-runtime-graph",
);
assertExternal(
  graphs.rootRuntime.external,
  ["@agentscope/harnesses-core", "node:path"],
  "codex.artifact.root-runtime-external",
);
assertExternal(
  graphs.rootDeclaration.external,
  ["@agentscope/harnesses-core"],
  "codex.artifact.root-declaration-external",
);
assertExternal(
  graphs.testingRuntime.external,
  [
    "@agentscope/harnesses-core",
    testingCoreSpecifier,
    "node:crypto",
    "node:path",
  ],
  "codex.artifact.testing-runtime-external",
);
assertExternal(
  graphs.testingDeclaration.external,
  [testingCoreSpecifier],
  "codex.artifact.testing-declaration-external",
);
assertGraph(
  graphs.testingDeclaration.visited,
  ["testing.d.ts"],
  "codex.artifact.testing-declaration-graph",
);
for (const production of [graphs.rootRuntime, graphs.rootDeclaration]) {
  if (
    production.visited.has(testingRuntime) ||
    production.visited.has(testingDeclaration) ||
    production.external.has(testingCoreSpecifier)
  )
    throw new Error("codex.artifact.production-authority");
  for (const path of production.visited)
    if (readFileSync(path, "utf8").includes("vendor-observability-hook"))
      throw new Error("codex.artifact.production-sentinel");
}
if (
  !graphs.testingRuntime.external.has(testingCoreSpecifier) ||
  !graphs.testingDeclaration.external.has(testingCoreSpecifier)
)
  throw new Error("codex.artifact.testing-authority");

const exactExports = (value, expected, code) => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((name, index) => name !== sortedExpected[index])
  )
    throw new Error(code);
};
const productionRoot = await import(pathToFileURL(rootRuntime).href);
exactExports(
  productionRoot,
  [
    "CODEX_COMPONENT_EVIDENCE_SLOT",
    "CODEX_HOOK_CONFIGURATION_PATH",
    "CODEX_REPRESENTATIVE_VERSION",
    "CodexConfigurationError",
    "CodexInstallationError",
    "CodexMappingError",
    "codexHarnessDescriptor",
    "codexHarnessPackageId",
    "createCodexInstallationPlanner",
    "createCodexInternalProviderConfiguration",
    "decodeCodexRootHookInput",
    "encodeCodexPosixHookCommand",
    "mapCodexSanitizedNativeObservation",
  ],
  "codex.artifact.production-exports",
);
const testingRoot = await import(pathToFileURL(testingRuntime).href);
exactExports(
  testingRoot,
  [
    "codexComponentContractAdapter",
    "codexComponentEvidence",
    "codexComponentScenario",
    "codexContractContextEvidence",
    "codexSanitizedFixture",
  ],
  "codex.artifact.testing-exports",
);

process.stdout.write(
  "Verified exact Codex runtime, declaration, production, and testing artifact closure.\n",
);
