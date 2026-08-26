import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const expectedExports = [".", "./testing"];
const actualExports = Object.keys(manifest.exports ?? {}).sort();
if (JSON.stringify(actualExports) !== JSON.stringify(expectedExports))
  throw new Error("claude-code artifact exports changed unexpectedly");

for (const file of ["dist/index.js", "dist/testing.js"])
  if (!existsSync(file)) throw new Error(`missing built entrypoint: ${file}`);

const sortedKeys = (value) => Object.keys(value).sort();
const assertExactKeys = (label, value, expected) => {
  const actual = sortedKeys(value);
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort()))
    throw new Error(`${label} exports changed: ${actual.join(",")}`);
};

const rootModule = await import(pathToFileURL(resolve("dist/index.js")).href);
assertExactKeys("production root", rootModule, [
  "CLAUDE_CODE_COMPONENT_VERSION",
  "CLAUDE_CODE_DOCUMENTED_INTERFACES",
  "CLAUDE_CODE_EVIDENCE_SLOT",
  "CLAUDE_CODE_INTERNAL_AUTH_SENTINEL",
  "CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST",
  "CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST",
  "CLAUDE_CODE_LIFECYCLE_EVENTS",
  "CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID",
  "claudeCodeDescriptor",
  "claudeCodeHarnessPackageId",
  "createClaudeCodeDialectAuthority",
  "createClaudeCodeExecutionEnvironment",
  "createClaudeCodeInstallationPlanner",
  "inspectClaudeCodePluginOverlap",
  "mapClaudeCodeCapture",
]);

const testingModule = await import(
  pathToFileURL(resolve("dist/testing.js")).href
);
assertExactKeys("testing entrypoint", testingModule, [
  "CLAUDE_CODE_FIXTURE_ID",
  "CLAUDE_CODE_SCENARIO_ID",
  "claudeCodeComponentAdapter",
  "claudeCodeContextEvidence",
  "claudeCodeFixture",
  "claudeCodeScenario",
  "runClaudeCodeHook",
]);

const literalText = (node) =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;

const moduleSpecifiersFromSource = (file, source) => {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  if (parsed.parseDiagnostics.length > 0)
    throw new Error(`unparseable built module: ${file}`);
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier === undefined)
        throw new Error(`non-literal module edge: ${file}`);
      specifiers.push(specifier);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = node.moduleReference.expression;
      const text = specifier === undefined ? undefined : literalText(specifier);
      if (text === undefined)
        throw new Error(`non-literal import-equals edge: ${file}`);
      specifiers.push(text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const specifier = node.arguments[0];
      const text = specifier === undefined ? undefined : literalText(specifier);
      if (text === undefined || node.arguments.length !== 1)
        throw new Error(`non-literal dynamic import: ${file}`);
      specifiers.push(text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      const specifier = node.arguments[0];
      const text = specifier === undefined ? undefined : literalText(specifier);
      if (text === undefined || node.arguments.length !== 1)
        throw new Error(`non-literal require edge: ${file}`);
      specifiers.push(text);
    }
    if (ts.isImportTypeNode(node)) {
      const text = ts.isLiteralTypeNode(node.argument)
        ? literalText(node.argument.literal)
        : undefined;
      if (text === undefined)
        throw new Error(`non-literal declaration import: ${file}`);
      specifiers.push(text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
};

const moduleSpecifiers = (file) =>
  moduleSpecifiersFromSource(file, readFileSync(file, "utf8"));

const adversarialEdges = moduleSpecifiersFromSource(
  "artifact-boundary-probe.ts",
  [
    'import "./static.js";',
    'export * from "./exported.js";',
    'void import("./dynamic.js");',
    'require("./required.js");',
    'import legacy = require("./legacy.js");',
    'type Fixture = import("./fixture.js").Fixture;',
  ].join("\n"),
).sort();
if (
  JSON.stringify(adversarialEdges) !==
  JSON.stringify(
    [
      "./dynamic.js",
      "./exported.js",
      "./fixture.js",
      "./legacy.js",
      "./required.js",
      "./static.js",
    ].sort(),
  )
)
  throw new Error("syntax-aware module edge probe failed");
for (const source of ["import(variable);", "require(variable);"]) {
  let rejected = false;
  try {
    moduleSpecifiersFromSource("artifact-boundary-negative.js", source);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("non-literal module edge was accepted");
}

const closeGraph = (entry, declaration) => {
  const graph = new Set();
  const external = new Set();
  const visit = (file) => {
    const absolute = resolve(file);
    if (graph.has(absolute)) return;
    if (!existsSync(absolute))
      throw new Error(`unresolved module edge: ${file}`);
    graph.add(absolute);
    for (const specifier of moduleSpecifiers(absolute)) {
      if (!specifier.startsWith(".")) {
        external.add(specifier);
        continue;
      }
      const runtimeTarget = resolve(dirname(absolute), specifier);
      const target = declaration
        ? runtimeTarget.replace(/\.js$/u, ".d.ts")
        : runtimeTarget;
      visit(target);
    }
  };
  visit(entry);
  return Object.freeze({
    files: Object.freeze(
      [...graph].map((file) => relative(resolve("dist"), file)).sort(),
    ),
    external: Object.freeze([...external].sort()),
  });
};

const assertGraph = (label, actual, expectedFiles) => {
  const expected = [...expectedFiles].sort();
  if (JSON.stringify(actual.files) !== JSON.stringify(expected))
    throw new Error(`${label} graph changed: ${actual.files.join(",")}`);
};

const assertExternal = (label, actual, expectedSpecifiers) => {
  const expected = [...expectedSpecifiers].sort();
  if (JSON.stringify(actual.external) !== JSON.stringify(expected))
    throw new Error(
      `${label} external graph changed: ${actual.external.join(",")}`,
    );
};

const productionRuntime = closeGraph("dist/index.js", false);
const productionDeclarations = closeGraph("dist/index.d.ts", true);
const testingRuntime = closeGraph("dist/testing.js", false);
const testingDeclarations = closeGraph("dist/testing.d.ts", true);
const harnessCoreTestingSpecifier = [
  "@agentscope/harnesses-core",
  "testing",
].join("/");

assertGraph("production runtime", productionRuntime, [
  "descriptor.js",
  "execution.js",
  "index.js",
  "lifecycle.js",
  "mapping.js",
]);
assertGraph("production declarations", productionDeclarations, [
  "descriptor.d.ts",
  "execution.d.ts",
  "index.d.ts",
  "lifecycle.d.ts",
  "mapping.d.ts",
]);
assertGraph("testing runtime", testingRuntime, [
  "descriptor.js",
  "fixture.js",
  "lifecycle.js",
  "mapping.js",
  "testing.js",
]);
assertGraph("testing declarations", testingDeclarations, [
  "fixture.d.ts",
  "testing.d.ts",
]);
assertExternal("production runtime", productionRuntime, [
  "@agentscope/harnesses-core",
  "node:path",
  "node:util/types",
]);
assertExternal("production declarations", productionDeclarations, [
  "@agentscope/harnesses-core",
  "@agentscope/protocol",
]);
assertExternal("testing runtime", testingRuntime, [
  "@agentscope/harnesses-core",
  harnessCoreTestingSpecifier,
  "node:crypto",
  "node:path",
  "node:util/types",
]);
assertExternal("testing declarations", testingDeclarations, [
  harnessCoreTestingSpecifier,
]);

for (const graph of [productionRuntime, productionDeclarations])
  if (graph.external.some((specifier) => specifier.endsWith("/testing")))
    throw new Error("testing authority escaped through production graph");
if (!testingRuntime.external.includes(harnessCoreTestingSpecifier))
  throw new Error("testing runtime lost component-contract authority");
if (!testingDeclarations.external.includes(harnessCoreTestingSpecifier))
  throw new Error("testing declarations lost component-contract authority");

console.log("Verified Claude Code production/testing artifact boundary.");
