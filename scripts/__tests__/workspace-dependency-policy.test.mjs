import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { expectedInternalDependenciesFor } from "../workspace-dependency-policy.mjs";

const importWithAuditSentinel = (specifier, loaderUrl) =>
  spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-loader",
      loaderUrl,
      "--input-type=module",
      "--eval",
      [
        "try {",
        `  await import(${JSON.stringify(new URL(specifier, import.meta.url).href)});`,
        "} catch (error) {",
        '  process.exitCode = error instanceof Error && error.message === "SYNTHETIC_AUDIT_AUTHORITY" ? 86 : 87;',
        "}",
      ].join("\n"),
    ],
    {
      encoding: "utf8",
      maxBuffer: 4_096,
      timeout: 5_000,
    },
  );

test("dependency-policy imports cannot acquire workspace audit authority", () => {
  const loaderRoot = mkdtempSync(join(tmpdir(), "agentscope-audit-sentinel-"));
  try {
    const loaderPath = join(loaderRoot, "loader.mjs");
    writeFileSync(
      loaderPath,
      [
        "export async function load(url, context, nextLoad) {",
        '  if (url.endsWith("/scripts/restricted-import-policy.mjs")) {',
        "    return {",
        '      format: "module",',
        "      shortCircuit: true,",
        '      source: `export const auditCoreFinalizationImports = () => { throw new Error("SYNTHETIC_AUDIT_AUTHORITY"); };`,',
        "    };",
        "  }",
        "  return nextLoad(url, context);",
        "}",
        "",
      ].join("\n"),
    );
    const loaderUrl = pathToFileURL(loaderPath).href;
    const policyImport = importWithAuditSentinel(
      "../workspace-dependency-policy.mjs?audit-authority-negative",
      loaderUrl,
    );
    assert.equal(policyImport.error, undefined);
    assert.equal(policyImport.signal, null);
    assert.equal(policyImport.status, 0);

    const verifierControl = importWithAuditSentinel(
      "../verify-workspace-policy.mjs?audit-authority-control",
      loaderUrl,
    );
    assert.equal(verifierControl.error, undefined);
    assert.equal(verifierControl.signal, null);
    assert.equal(verifierControl.status, 86);
  } finally {
    rmSync(loaderRoot, { recursive: true, force: true });
  }
});

test("Codex keeps only its used inward workspace dependencies", () => {
  assert.deepEqual(
    expectedInternalDependenciesFor("@agentscope/harness-codex"),
    ["@agentscope/harnesses-core", "@agentscope/protocol"],
  );
});

test("the Codex exception does not weaken other concrete harnesses", () => {
  for (const harness of [
    "claude-code",
    "gemini-cli",
    "hermes",
    "opencode",
    "openclaw",
    "pi",
  ]) {
    assert.deepEqual(
      expectedInternalDependenciesFor(`@agentscope/harness-${harness}`),
      [
        "@agentscope/core",
        "@agentscope/harnesses-core",
        "@agentscope/protocol",
      ],
    );
  }
});
