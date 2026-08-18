import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";

const restrictedSpecifiers = [
  "@agentscope/protocol/core-finalization",
  "@agentscope/destinations-core/lifecycle-sink",
  "@agentscope/destinations-core/core-orchestration",
];
const testingSpecifiers = [
  "@agentscope/destinations-core/testing",
  "@agentscope/protocol/testing",
];
const testSource = /(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.[^.]+$/u;
const artifactVerifier = /(?:^|\/)verify-artifact\.mjs$/u;
const sourceExtension = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const ignoredDirectories = new Set([
  ".next",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);
const sourceFiles = (root) => {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name))
          pending.push(join(directory, entry.name));
      } else if (entry.isFile() && sourceExtension.test(entry.name)) {
        files.push(join(directory, entry.name));
      }
    }
  }
  return files;
};

const assertNoCoreOnlyImports = (source, file, packageName) => {
  if (packageName === "@agentscope/core") return;
  for (const specifier of restrictedSpecifiers)
    if (source.includes(specifier))
      throw new Error(`${specifier} is Core-only; forbidden import in ${file}`);
};

const assertNoProductionTestingImports = (source, file, packageName) => {
  if (packageName === "@agentscope/testkit" || testSource.test(file)) return;
  for (const specifier of testingSpecifiers)
    if (source.includes(specifier))
      throw new Error(`${specifier} is test-only; forbidden import in ${file}`);
};

const isLiteralModuleSpecifier = (value) =>
  value !== undefined &&
  (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value));

const assertNoComputedModuleLoads = (source, file, packageName) => {
  if (
    packageName === "@agentscope/testkit" ||
    testSource.test(file) ||
    artifactVerifier.test(file)
  )
    return;
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.getScriptKindFromFileName(file),
  );
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      !isLiteralModuleSpecifier(node.arguments[0])
    )
      throw new Error(`computed module load is forbidden in ${file}`);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
};

export const auditCoreFinalizationImports = (
  workspaceRoot,
  expectedPackages,
) => {
  for (const [packagePath, packageName] of expectedPackages) {
    const root = join(workspaceRoot, packagePath);
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      const workspaceFile = relative(workspaceRoot, file);
      assertNoCoreOnlyImports(source, workspaceFile, packageName);
      assertNoProductionTestingImports(source, workspaceFile, packageName);
      assertNoComputedModuleLoads(source, workspaceFile, packageName);
    }
  }
};
