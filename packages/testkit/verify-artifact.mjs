import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, posix, resolve } from "node:path";

import ts from "typescript";

const root = import.meta.dirname;
const maximumFiles = 256;
const maximumFileBytes = 2 * 1024 * 1024;

const readBoundedRegularFile = (absolute) => {
  const descriptor = openSync(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximumFileBytes)
      throw new Error(
        `Testkit artifact input is not bounded regular data: ${absolute}`,
      );
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
};

const listRegularFiles = (directory, prefix = "") => {
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.length > maximumFiles)
    throw new Error("Testkit artifact directory is too large.");
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const absolute = resolve(directory, entry.name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink())
      throw new Error(`Testkit artifact contains a symlink: ${relative}`);
    if (stat.isDirectory()) {
      files.push(...listRegularFiles(absolute, relative));
      continue;
    }
    if (!stat.isFile() || stat.size > maximumFileBytes)
      throw new Error(
        `Testkit artifact entry is not bounded regular data: ${relative}`,
      );
    files.push(relative);
    if (files.length > maximumFiles)
      throw new Error("Testkit artifact inventory is too large.");
  }
  return files.sort();
};

const packageManifest = JSON.parse(
  readBoundedRegularFile(resolve(root, "package.json")),
);
if (packageManifest.exports !== "./dist/index.js")
  throw new Error("Testkit package export drifted.");
const allowedExternals = new Set(
  Object.keys(packageManifest.dependencies ?? {}),
);

const sourceFiles = listRegularFiles(resolve(root, "src"));
const productionSources = sourceFiles
  .filter(
    (file) =>
      file.endsWith(".ts") &&
      !file.endsWith(".test.ts") &&
      !file.startsWith("__tests__/") &&
      !file.includes("/__tests__/"),
  )
  .map((file) => file.slice(0, -3))
  .sort();
const expectedArtifacts = productionSources
  .flatMap((file) => [`${file}.d.ts`, `${file}.js`])
  .sort();
const actualArtifacts = listRegularFiles(resolve(root, "dist"));
if (
  actualArtifacts.length !== expectedArtifacts.length ||
  actualArtifacts.some((file, index) => file !== expectedArtifacts[index]) ||
  actualArtifacts.some(
    (file) => file.includes(".test.") || file.includes("__tests__"),
  )
)
  throw new Error("Testkit production artifact inventory is not exact.");

const collectSpecifiers = (absolute, kind) => {
  const text = readBoundedRegularFile(absolute);
  const source = ts.createSourceFile(
    absolute,
    text,
    ts.ScriptTarget.ESNext,
    true,
    kind,
  );
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      if (!ts.isStringLiteral(node.moduleSpecifier))
        throw new Error(
          `Testkit artifact has a nonliteral module edge: ${absolute}`,
        );
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
        throw new Error(
          `Testkit artifact has a nonliteral dynamic import: ${absolute}`,
        );
      specifiers.push(node.arguments[0].text);
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (
        !ts.isExternalModuleReference(node.moduleReference) ||
        node.moduleReference.expression === undefined ||
        !ts.isStringLiteral(node.moduleReference.expression)
      )
        throw new Error(
          `Testkit artifact has a nonliteral import-equals edge: ${absolute}`,
        );
      specifiers.push(node.moduleReference.expression.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
        throw new Error(
          `Testkit artifact has a nonliteral require edge: ${absolute}`,
        );
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
};

const verifyGraph = (directory, files, mode) => {
  const inventory = new Set(files);
  for (const file of files) {
    const kind = file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    for (const specifier of collectSpecifiers(resolve(directory, file), kind)) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) {
        const packageName = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        if (!allowedExternals.has(packageName))
          throw new Error(
            `Testkit artifact has an unexpected external edge: ${specifier}`,
          );
        continue;
      }
      const normalized = posix.normalize(posix.join(dirname(file), specifier));
      if (normalized.startsWith("../") || posix.isAbsolute(normalized))
        throw new Error(
          `Testkit artifact edge escapes its graph: ${specifier}`,
        );
      const target =
        mode === "source"
          ? normalized.replace(/\.js$/u, ".ts")
          : mode === "declaration"
            ? normalized.replace(/\.js$/u, ".d.ts")
            : normalized;
      if (!inventory.has(target))
        throw new Error(
          `Testkit artifact has an unresolved local edge: ${file} -> ${specifier}`,
        );
    }
  }
};

verifyGraph(
  resolve(root, "src"),
  productionSources.map((file) => `${file}.ts`),
  "source",
);
verifyGraph(
  resolve(root, "dist"),
  actualArtifacts.filter((file) => file.endsWith(".js")),
  "javascript",
);
verifyGraph(
  resolve(root, "dist"),
  actualArtifacts.filter((file) => file.endsWith(".d.ts")),
  "declaration",
);

const built = await import("./dist/index.js");
for (const symbol of [
  "BoundedTerminalEmulator",
  "BoundedTerminalEmulatorError",
  "PtySemanticContractError",
  "createPtySemanticContractSuite",
  "validatePtyModeApplicability",
  "validatePtyTerminalSemanticSnapshot",
])
  if (!(symbol in built))
    throw new Error(`Testkit built export is missing: ${symbol}`);
