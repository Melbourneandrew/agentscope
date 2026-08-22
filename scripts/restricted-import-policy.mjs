import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";

const restrictedSpecifiers = [
  "@agentscope/protocol/core-finalization",
  "@agentscope/destinations-core/core-orchestration",
];
const cliOnlySpecifiers = [
  "@agentscope/core/configuration-management",
  "@agentscope/core/hook-orchestration",
  "@agentscope/core/retrieval-orchestration",
  "@agentscope/harnesses-core/cli-management",
];
const testingSpecifiers = [
  "@agentscope/destination-langfuse/testing",
  "@agentscope/destinations-core/testing",
  "@agentscope/harnesses-core/testing",
  "@agentscope/protocol/testing",
];
const testSource = /(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.[^.]+$/u;
const testEntrypointSource =
  /(?:^|\/)src\/testing\.ts$|(?:^|\/)packages\/destinations\/langfuse\/src\/(?:compatibility-fixtures|mock-roundtrip)\.ts$/u;
const artifactVerifier = /(?:^|\/)verify-artifact\.mjs$/u;
const ownedLocalSqliteNativeCandidate =
  /^packages\/destinations\/local-sqlite\/native-candidate\/files\//u;
const ownedLocalSqliteNativeTooling =
  /^packages\/destinations\/local-sqlite\/native-candidate\/tooling\//u;
const sourceExtension = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const homeAuthoritySource = "packages/core/src/configuration/home.ts";
const applicationSource = /^(?:apps|packages)\//u;
const integrationPackage = /^@agentscope\/(?:destination|harness)/u;
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
  if (packageName !== "@agentscope/core")
    for (const specifier of restrictedSpecifiers)
      if (source.includes(specifier))
        throw new Error(
          `${specifier} is Core-only; forbidden import in ${file}`,
        );
  if (packageName !== "@agentscope/cli")
    for (const specifier of cliOnlySpecifiers)
      if (source.includes(specifier))
        throw new Error(
          `${specifier} is CLI-only; forbidden import in ${file}`,
        );
};

const assertNoProductionTestingImports = (source, file, packageName) => {
  if (
    packageName === "@agentscope/testkit" ||
    testSource.test(file) ||
    testEntrypointSource.test(file)
  )
    return;
  for (const specifier of testingSpecifiers)
    if (source.includes(specifier))
      throw new Error(`${specifier} is test-only; forbidden import in ${file}`);
};

const isLiteralModuleSpecifier = (value) =>
  value !== undefined &&
  (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value));

const assertLiteralSpecifierAllowed = (specifier, file, packageName) => {
  if (packageName !== "@agentscope/core")
    for (const restricted of restrictedSpecifiers)
      if (specifier === restricted)
        throw new Error(
          `${restricted} is Core-only; forbidden import in ${file}`,
        );
  if (
    packageName !== "@agentscope/cli" &&
    cliOnlySpecifiers.includes(specifier)
  )
    throw new Error(`${specifier} is CLI-only; forbidden import in ${file}`);
  if (
    packageName === "@agentscope/testkit" ||
    testSource.test(file) ||
    testEntrypointSource.test(file)
  )
    return;
  for (const testing of testingSpecifiers)
    if (specifier === testing)
      throw new Error(`${testing} is test-only; forbidden import in ${file}`);
};

const assertNoComputedModuleLoads = (source, file, packageName) => {
  const computedLoadsAllowed = artifactVerifier.test(file);
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.getScriptKindFromFileName(file),
  );
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      isLiteralModuleSpecifier(node.moduleSpecifier)
    )
      assertLiteralSpecifierAllowed(
        node.moduleSpecifier.text,
        file,
        packageName,
      );
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isLiteralModuleSpecifier(node.moduleReference.expression)
    )
      assertLiteralSpecifierAllowed(
        node.moduleReference.expression.text,
        file,
        packageName,
      );
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const specifier = node.arguments[0];
      if (!isLiteralModuleSpecifier(specifier) && !computedLoadsAllowed)
        throw new Error(`computed module load is forbidden in ${file}`);
      if (isLiteralModuleSpecifier(specifier))
        assertLiteralSpecifierAllowed(specifier.text, file, packageName);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
};

const assertSingleHomeAuthority = (source, file) => {
  if (
    file === homeAuthoritySource ||
    testSource.test(file) ||
    artifactVerifier.test(file) ||
    !applicationSource.test(file)
  )
    return;
  for (const pattern of [
    /\bAGENTSCOPE_HOME\b/u,
    /\bhomedir\b/u,
    /process\.env\.(?:HOME|USERPROFILE)\b/u,
    /process\.env\[['"](?:HOME|USERPROFILE)['"]\]/u,
  ])
    if (pattern.test(source))
      throw new Error(
        `Agentscope home must be injected from ${homeAuthoritySource}; forbidden derivation in ${file}`,
      );
};

const assertNoIntegrationStreams = (source, file, packageName) => {
  if (
    !integrationPackage.test(packageName) ||
    testSource.test(file) ||
    artifactVerifier.test(file) ||
    ownedLocalSqliteNativeTooling.test(file)
  )
    return;
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.getScriptKindFromFileName(file),
  );
  const processAliases = new Set(["process"]);
  const fail = () => {
    throw new Error(
      `terminal streams are CLI-owned; forbidden process authority in ${file}`,
    );
  };
  const isProcessAuthority = (node) =>
    (ts.isIdentifier(node) && processAliases.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "globalThis" &&
      node.name.text === "process");
  const registerImportAliases = (node) => {
    if (
      !ts.isImportDeclaration(node) ||
      !isLiteralModuleSpecifier(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== "node:process"
    )
      return;
    const clause = node.importClause;
    if (clause?.name) processAliases.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
      processAliases.add(clause.namedBindings.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
      for (const element of clause.namedBindings.elements)
        if (
          ["stdout", "stderr"].includes(
            element.propertyName?.text ?? element.name.text,
          )
        )
          fail();
  };
  const registerVariableAlias = (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !node.initializer ||
      !isProcessAuthority(node.initializer)
    )
      return;
    if (ts.isIdentifier(node.name)) {
      processAliases.add(node.name.text);
      return;
    }
    for (const element of node.name.elements)
      if (
        !ts.isOmittedExpression(element) &&
        ts.isIdentifier(element.name) &&
        ["stdout", "stderr"].includes(
          element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text,
        )
      )
        fail();
  };
  const isStreamAccess = (node) =>
    (ts.isPropertyAccessExpression(node) &&
      isProcessAuthority(node.expression) &&
      ["stdout", "stderr"].includes(node.name.text)) ||
    (ts.isElementAccessExpression(node) &&
      isProcessAuthority(node.expression) &&
      isLiteralModuleSpecifier(node.argumentExpression) &&
      ["stdout", "stderr"].includes(node.argumentExpression.text));
  const visit = (node) => {
    registerImportAliases(node);
    registerVariableAlias(node);
    if (isStreamAccess(node)) fail();
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
      const workspaceFile = relative(workspaceRoot, file);
      if (ownedLocalSqliteNativeCandidate.test(workspaceFile)) continue;
      const source = readFileSync(file, "utf8");
      assertNoCoreOnlyImports(source, workspaceFile, packageName);
      assertNoProductionTestingImports(source, workspaceFile, packageName);
      assertNoComputedModuleLoads(source, workspaceFile, packageName);
      assertSingleHomeAuthority(source, workspaceFile);
      assertNoIntegrationStreams(source, workspaceFile, packageName);
    }
  }
};
