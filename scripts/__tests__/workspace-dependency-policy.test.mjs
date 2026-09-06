import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { expectedInternalDependenciesFor } from "../workspace-dependency-policy.mjs";
import { loadWorkspacePackageGraph } from "../workspace-package-graph.mjs";

function writeManifest(root, relativePath, manifest) {
  const packageRoot = join(root, relativePath);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify(manifest));
}

function graphFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentscope-package-graph-"));
  const expectedPackages = new Map([
    ["packages/a", "@agentscope/a"],
    ["packages/b", "@agentscope/b"],
  ]);
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n",
  );
  writeManifest(root, "packages/a", { name: "@agentscope/a" });
  writeManifest(root, "packages/b", {
    name: "@agentscope/b",
    dependencies: { "@agentscope/a": "workspace:*" },
  });
  return { expectedPackages, root };
}

test("loads the exact workspace manifests and dependency projection", () => {
  const value = graphFixture();
  try {
    const { graph, manifests } = loadWorkspacePackageGraph(
      value.root,
      value.expectedPackages,
    );
    assert.deepEqual([...manifests.keys()], ["@agentscope/a", "@agentscope/b"]);
    assert.deepEqual(graph.get("@agentscope/a"), []);
    assert.deepEqual(graph.get("@agentscope/b"), ["@agentscope/a"]);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects a missing or substituted workspace manifest identity", () => {
  const value = graphFixture();
  try {
    rmSync(join(value.root, "packages/a/package.json"));
    assert.throws(
      () => loadWorkspacePackageGraph(value.root, value.expectedPackages),
      /Missing workspace package paths: packages\/a/u,
    );
    writeManifest(value.root, "packages/a", { name: "@agentscope/substitute" });
    assert.throws(
      () => loadWorkspacePackageGraph(value.root, value.expectedPackages),
      /must be named @agentscope\/a; found @agentscope\/substitute/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects unexpected packages from the workspace pattern inventory", () => {
  const value = graphFixture();
  try {
    writeManifest(value.root, "packages/unexpected", {
      name: "@agentscope/unexpected",
    });
    assert.throws(
      () => loadWorkspacePackageGraph(value.root, value.expectedPackages),
      /Unexpected workspace package paths: packages\/unexpected/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects traversing workspace patterns", () => {
  const value = graphFixture();
  try {
    writeFileSync(
      join(value.root, "pnpm-workspace.yaml"),
      "packages:\n  - ../*\n",
    );
    assert.throws(
      () => loadWorkspacePackageGraph(value.root, value.expectedPackages),
      /pnpm workspace package pattern root must be a normalized relative path/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects workspace directory and manifest symlink substitution", () => {
  const value = graphFixture();
  const outside = mkdtempSync(join(tmpdir(), "agentscope-package-outside-"));
  try {
    rmSync(join(value.root, "packages/b"), { recursive: true, force: true });
    writeManifest(outside, "b", { name: "@agentscope/b" });
    symlinkSync(join(outside, "b"), join(value.root, "packages/b"), "dir");
    assert.throws(
      () => loadWorkspacePackageGraph(value.root, value.expectedPackages),
      /Workspace pattern packages\/\* contains a symlink entry: b/u,
    );

    rmSync(join(value.root, "packages/b"));
    mkdirSync(join(value.root, "packages/b"));
    symlinkSync(
      join(outside, "b/package.json"),
      join(value.root, "packages/b/package.json"),
    );
    assert.throws(
      () => loadWorkspacePackageGraph(value.root, value.expectedPackages),
      /packages\/b\/package.json must be a no-follow regular file/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("rejects a symlink supplied as the final workspace root", () => {
  const value = graphFixture();
  const linkedRoot = `${value.root}-linked`;
  try {
    symlinkSync(value.root, linkedRoot, "dir");
    assert.throws(
      () => loadWorkspacePackageGraph(linkedRoot, value.expectedPackages),
      /Requested workspace root must be a no-follow directory/u,
    );
  } finally {
    rmSync(linkedRoot, { force: true });
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects workspace root substitution between lstat and realpath", () => {
  const value = graphFixture();
  const replacementRoot = `${value.root}-replacement`;
  const retiredRoot = `${value.root}-race-retired`;
  cpSync(value.root, replacementRoot, { recursive: true });
  const moduleUrl = new URL(
    "../workspace-package-graph.mjs?root-resolution-race",
    import.meta.url,
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        `const root = ${JSON.stringify(value.root)};`,
        `const replacement = ${JSON.stringify(replacementRoot)};`,
        `const retired = ${JSON.stringify(retiredRoot)};`,
        "const originalRealpathSync = fs.realpathSync;",
        "let substituted = false;",
        "fs.realpathSync = (path, ...arguments_) => {",
        "  if (!substituted && path === root) {",
        "    substituted = true;",
        "    fs.renameSync(root, retired);",
        "    fs.renameSync(replacement, root);",
        "  }",
        "  return originalRealpathSync(path, ...arguments_);",
        "};",
        "syncBuiltinESMExports();",
        `const { loadWorkspacePackageGraph } = await import(${JSON.stringify(moduleUrl)});`,
        "try {",
        '  loadWorkspacePackageGraph(root, new Map([["packages/a", "@agentscope/a"], ["packages/b", "@agentscope/b"]]));',
        "  process.exitCode = 91;",
        "} catch (error) {",
        '  if (!String(error?.message).includes("Requested workspace root generation changed during resolution")) {',
        "    process.stderr.write(String(error?.stack ?? error));",
        "    process.exitCode = 92;",
        "  }",
        "}",
      ].join("\n"),
    ],
    { encoding: "utf8", maxBuffer: 4_096, timeout: 5_000 },
  );
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
    rmSync(replacementRoot, { recursive: true, force: true });
    rmSync(retiredRoot, { recursive: true, force: true });
  }
});

test("rejects workspace manifests above the bounded read ceiling", () => {
  const value = graphFixture();
  try {
    writeFileSync(
      join(value.root, "packages/b/package.json"),
      " ".repeat(64 * 1024 + 1),
    );
    assert.throws(
      () => loadWorkspacePackageGraph(value.root, value.expectedPackages),
      /packages\/b\/package.json exceeds its 65536-byte ceiling/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects duplicate package names in the expected identity projection", () => {
  const value = graphFixture();
  try {
    writeManifest(value.root, "packages/b", { name: "@agentscope/a" });
    const duplicateExpectedPackages = new Map([
      ["packages/a", "@agentscope/a"],
      ["packages/b", "@agentscope/a"],
    ]);
    assert.throws(
      () => loadWorkspacePackageGraph(value.root, duplicateExpectedPackages),
      /Duplicate workspace package name: @agentscope\/a/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects unknown internal workspace dependencies", () => {
  const value = graphFixture();
  try {
    writeManifest(value.root, "packages/b", {
      name: "@agentscope/b",
      dependencies: { "@agentscope/unknown": "workspace:*" },
    });
    assert.throws(
      () => loadWorkspacePackageGraph(value.root, value.expectedPackages),
      /@agentscope\/b references unknown workspace @agentscope\/unknown/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("projects exact dependencies on known unscoped workspace packages", () => {
  const value = graphFixture();
  try {
    writeFileSync(
      join(value.root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n  - apps/*\n",
    );
    value.expectedPackages.set("apps/cli", "agentscope-cli");
    writeManifest(value.root, "apps/cli", { name: "agentscope-cli" });
    writeManifest(value.root, "packages/a", {
      name: "@agentscope/a",
      dependencies: {
        "agentscope-cli": "workspace:*",
        "external-package": "1.0.0",
      },
    });
    const { graph } = loadWorkspacePackageGraph(
      value.root,
      value.expectedPackages,
    );
    assert.deepEqual(graph.get("@agentscope/a"), ["agentscope-cli"]);

    writeManifest(value.root, "apps/cli", {
      name: "agentscope-cli",
      dependencies: { "@agentscope/a": "workspace:*" },
    });
    assert.throws(
      () => loadWorkspacePackageGraph(value.root, value.expectedPackages),
      /Workspace dependency cycle: @agentscope\/a -> agentscope-cli -> @agentscope\/a/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects unknown unscoped internal-looking dependencies", () => {
  const value = graphFixture();
  try {
    writeManifest(value.root, "packages/b", {
      name: "@agentscope/b",
      dependencies: { "agentscope-substitute": "workspace:*" },
    });
    assert.throws(
      () => loadWorkspacePackageGraph(value.root, value.expectedPackages),
      /@agentscope\/b references unknown workspace agentscope-substitute/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects workspace root generation replacement during graph creation", () => {
  const value = graphFixture();
  const retiredRoot = `${value.root}-retired`;
  const expectedPackages = new Map(value.expectedPackages);
  const originalKeys = expectedPackages.keys.bind(expectedPackages);
  let replaced = false;
  expectedPackages.keys = () => {
    if (!replaced) {
      replaced = true;
      renameSync(value.root, retiredRoot);
      mkdirSync(value.root);
      renameSync(
        join(retiredRoot, "pnpm-workspace.yaml"),
        join(value.root, "pnpm-workspace.yaml"),
      );
      renameSync(join(retiredRoot, "packages"), join(value.root, "packages"));
    }
    return originalKeys();
  };
  try {
    assert.throws(
      () => loadWorkspacePackageGraph(value.root, expectedPackages),
      /Requested workspace root generation changed during resolution/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
    rmSync(retiredRoot, { recursive: true, force: true });
  }
});

test("rejects in-place workspace definition mutation before graph settlement", () => {
  const value = graphFixture();
  const expectedPackages = new Map(value.expectedPackages);
  const originalKeys = expectedPackages.keys.bind(expectedPackages);
  let substituted = false;
  expectedPackages.keys = () => {
    if (!substituted) {
      substituted = true;
      writeFileSync(
        join(value.root, "pnpm-workspace.yaml"),
        "packages:\n  - packages/?\n",
      );
    }
    return originalKeys();
  };
  try {
    assert.throws(
      () => loadWorkspacePackageGraph(value.root, expectedPackages),
      /pnpm-workspace.yaml identity changed after workspace discovery/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects same-inode manifest mutation before graph settlement", () => {
  const value = graphFixture();
  writeManifest(value.root, "packages/a", {
    name: "@agentscope/a",
    marker: "AAAA",
  });
  const expectedPackages = new Map(value.expectedPackages);
  expectedPackages[Symbol.iterator] = function* () {
    let first = true;
    for (const entry of Map.prototype.entries.call(this)) {
      yield entry;
      if (first) {
        first = false;
        writeManifest(value.root, "packages/a", {
          name: "@agentscope/a",
          marker: "BBBB",
        });
      }
    }
  };
  try {
    assert.throws(
      () => loadWorkspacePackageGraph(value.root, expectedPackages),
      /packages\/a\/package.json identity changed after workspace discovery/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects cycles in the internal workspace dependency projection", () => {
  const value = graphFixture();
  try {
    writeManifest(value.root, "packages/a", {
      name: "@agentscope/a",
      dependencies: { "@agentscope/b": "workspace:*" },
    });
    assert.throws(
      () => loadWorkspacePackageGraph(value.root, value.expectedPackages),
      /Workspace dependency cycle: @agentscope\/a -> @agentscope\/b -> @agentscope\/a/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

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
