import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// @ts-expect-error private integration module publishes no declaration
import * as privateAuthority from "../immutable-candidate-authority.mjs";

const { selectedRuntimeFiles } = privateAuthority as {
  selectedRuntimeFiles: readonly string[];
};
const integrationRoot = resolve(import.meta.dirname, "..");
const emittedRoot = resolve(integrationRoot, "../../packages/testkit/dist");
const parse = (text: string) =>
  ts.createSourceFile("fixture.js", text, ts.ScriptTarget.ESNext, true);

function relativeEdges(text: string, includeDynamic: boolean) {
  const edges: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      if (!ts.isStringLiteral(node.moduleSpecifier))
        throw new Error("nonliteral-runtime-edge");
      edges.push(node.moduleSpecifier.text);
    }
    if (
      includeDynamic &&
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0];
      if (
        node.arguments.length !== 1 ||
        argument === undefined ||
        !ts.isStringLiteral(argument)
      )
        throw new Error("nonliteral-runtime-edge");
      edges.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(text));
  return edges.filter((edge) => !edge.startsWith("node:"));
}

function requireClosure(
  files: readonly string[],
  root: string,
  prefix = "",
  entries: readonly string[] = files,
  staticOnly = false,
) {
  const inventory = new Set(files);
  const pending = [...entries];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || !inventory.has(file))
      throw new Error("missing-runtime-entry");
    if (visited.has(file) || !/\.m?js$/u.test(file)) continue;
    visited.add(file);
    const source = readFileSync(
      resolve(root, file.slice(prefix.length)),
      "utf8",
    );
    for (const edge of relativeEdges(source, !staticOnly)) {
      const target = posix.normalize(posix.join(posix.dirname(file), edge));
      if (!edge.startsWith(".") || !inventory.has(target))
        throw new Error(`unresolved-runtime-edge:${target}`);
      pending.push(target);
    }
  }
}

function scenarioProjection(
  omitFrom?: "sources" | "copy",
  omitted:
    | "selected-runtime-files.mjs"
    | "codex-trace-child-diagnostics.mjs" = "selected-runtime-files.mjs",
) {
  const names: string[] = [];
  const copied: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "sources" &&
      node.initializer !== undefined &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      const first = node.initializer.elements[0];
      if (
        first === undefined ||
        !ts.isSpreadElement(first) ||
        !ts.isCallExpression(first.expression)
      )
        throw new Error("unrecognized-runtime-sources");
      const mapping = first.expression.expression;
      const callback = first.expression.arguments[0];
      if (
        !ts.isPropertyAccessExpression(mapping) ||
        mapping.name.text !== "map" ||
        !ts.isArrayLiteralExpression(mapping.expression) ||
        callback === undefined ||
        !ts.isArrowFunction(callback) ||
        callback.body.getText().replace(/\s/gu, "") !==
          "[name,resolve(integrationRoot,name)]"
      )
        throw new Error("unrecognized-runtime-sources");
      for (const name of mapping.expression.elements) {
        if (!ts.isStringLiteral(name))
          throw new Error("nonliteral-runtime-source");
        names.push(name.text);
      }
    }
    if (ts.isStringLiteral(node) && node.text.startsWith("COPY runner.mjs "))
      copied.push(...node.text.split(" ").slice(1, -1));
    ts.forEachChild(node, visit);
  };
  visit(
    parse(readFileSync(resolve(integrationRoot, "run-scenarios.mjs"), "utf8")),
  );
  return names.filter(
    (name) =>
      !(omitFrom === "sources" && name === omitted) &&
      copied.some(
        (copy) => copy === name && !(omitFrom === "copy" && copy === omitted),
      ),
  );
}

describe("actual emitted immutable scenario runtime closure", () => {
  it.each(["sources", "copy"] as const)(
    "rejects the actual static diagnostic helper omitted from %s",
    (projection) => {
      expect(() => {
        requireClosure(
          scenarioProjection(projection, "codex-trace-child-diagnostics.mjs"),
          integrationRoot,
          "",
          ["immutable-candidate-authority.mjs"],
          true,
        );
      }).toThrow("unresolved-runtime-edge:codex-trace-child-diagnostics.mjs");
    },
  );
  it.each([false, true])(
    "checks Testkit closure with helper omitted %s",
    (omitted) => {
      const probe = () => {
        requireClosure(
          selectedRuntimeFiles.filter(
            (name) => !omitted || !name.endsWith("/proc-process-snapshot.js"),
          ),
          emittedRoot,
          "testkit/",
        );
      };
      if (omitted)
        expect(probe).toThrow(
          "unresolved-runtime-edge:testkit/internal/proc-process-snapshot.js",
        );
      else expect(probe).not.toThrow();
    },
  );
  // Conditional dynamic edges belong to scenario.runtimeArtifacts, not this
  // fixed top-level authority graph. Testkit includes literal dynamic edges.
  it.each([undefined, "sources", "copy"] as const)(
    "checks top-level static closure with inventory omitted from %s",
    (projection) => {
      const probe = () => {
        requireClosure(
          scenarioProjection(projection),
          integrationRoot,
          "",
          ["immutable-candidate-authority.mjs"],
          true,
        );
      };
      if (projection === undefined) expect(probe).not.toThrow();
      else
        expect(probe).toThrow(
          "unresolved-runtime-edge:selected-runtime-files.mjs",
        );
    },
  );
});
