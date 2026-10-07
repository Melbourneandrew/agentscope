import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const actualFunctions = (file: string, required: readonly string[]) => {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const selected = parsed.statements.filter(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          required.includes(declaration.name.text),
      ),
  );
  expect(selected).toHaveLength(required.length);
  return selected.map((statement) => statement.getFullText(parsed)).join("\n");
};

describe("actual retained material source-binding predicates", () => {
  const recordRoot = new URL(
    "../native-directory/files/records/",
    import.meta.url,
  );
  const json = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(new URL(name, recordRoot), "utf8")) as Record<
      string,
      unknown
    >;
  const predicates = runInNewContext(
    actualFunctions("../native-directory/verify-artifact.mjs", [
      "sha",
      "fail",
      "verifyMaterialHeader",
      "verifyObservedCandidate",
    ]) + "\n;({header:verifyMaterialHeader,observed:verifyObservedCandidate});",
    { createHash, Buffer },
  ) as {
    header: (...values: unknown[]) => void;
    observed: (...values: unknown[]) => void;
  };
  const sourceDigest = (name: string) =>
    "sha256:" +
    createHash("sha256")
      .update(readFileSync(new URL(name, import.meta.url)))
      .digest("hex");
  it("binds the retained candidate header to the one closure record", () => {
    const material = json("release-materials.json");
    const provenance = json("provenance.json");
    const verified = { manifest: json("support-manifest.json") };
    expect(() => {
      predicates.header(material, verified, provenance);
    }).not.toThrow();
    for (const substitution of [
      { sourceCommit: "a".repeat(40) },
      { candidateRunId: "1" },
      { candidates: [] },
    ])
      expect(() => {
        predicates.header(
          { ...material, ...substitution },
          verified,
          provenance,
        );
      }).toThrow();
  });
  it.each([
    "sourceCommit",
    "runId",
    "primitiveSourceDigest",
    "driverSourceDigest",
    "workflowSourceDigest",
    "componentProof",
  ])("rejects a rehashed observation substitution of %s", (field) => {
    const material = json("release-materials.json");
    const provenance = json("provenance.json");
    const rows = material.candidates as Record<string, unknown>[];
    const original = rows[0]!;
    const observation = original.observation as Record<string, unknown>;
    const driver = sourceDigest("../native-directory/build-candidate.mjs");
    const workflow = sourceDigest(
      "../../../../.github/workflows/directory-native-candidate.yml",
    );
    expect(() => {
      predicates.observed(original, material, provenance, driver, workflow);
    }).not.toThrow();
    const substituted = { ...observation, [field]: "substituted" };
    const row = {
      ...original,
      observation: substituted,
      observedRecordDigest:
        "sha256:" +
        createHash("sha256").update(JSON.stringify(substituted)).digest("hex"),
    };
    expect(() => {
      predicates.observed(row, material, provenance, driver, workflow);
    }).toThrow();
  });
});

describe("fixed public-bin directory loader relocation", () => {
  const relocate = runInNewContext(
    actualFunctions("../../../../apps/cli/scripts/directory-artifact.mjs", [
      "relocateDirectoryLoader",
    ]).replace(
      "export const relocateDirectoryLoader",
      "const relocateDirectoryLoader",
    ) + "\n;relocateDirectoryLoader;",
    { assert },
  ) as (source: string) => string;
  const expression = 'import("./directory-runtime/loader/owned-loader.mjs")';
  const input = `const module = await ${expression};`;
  it("relocates only the one fixed specifier beside the single copied closure", () => {
    const output = relocate(input);
    expect(output).toBe(
      input.replace(
        '"./directory-runtime/loader/owned-loader.mjs"',
        '"../internal/directory-runtime/loader/owned-loader.mjs"',
      ),
    );
    expect(
      new URL(
        "../internal/directory-runtime/loader/owned-loader.mjs",
        "file:///candidate/dist/bin/agentscope.js",
      ).pathname,
    ).toBe(
      "/candidate/dist/internal/directory-runtime/loader/owned-loader.mjs",
    );
  });
  it.each(["missing", "repeated", "wrong", "missing-import"])(
    "rejects %s source before a bundle transform",
    (kind) => {
      const value =
        kind === "missing"
          ? input.replace(expression, "undefined")
          : kind === "repeated"
            ? `${input}\n${expression}`
            : kind === "wrong"
              ? input.replace("./directory-runtime", "./other-runtime")
              : 'const module = "./directory-runtime/loader/owned-loader.mjs";';
      expect(() => relocate(value)).toThrow();
    },
  );
});
