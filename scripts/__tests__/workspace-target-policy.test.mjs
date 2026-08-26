import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import { auditWorkspaceTargets } from "../workspace-target-policy.mjs";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentscope-target-policy-"));
  mkdirSync(join(root, "packages/example"), { recursive: true });
  for (const file of [
    "eslint.config.mjs",
    ".prettierignore",
    "pnpm-lock.yaml",
  ]) {
    writeFileSync(join(root, file), "");
  }
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/workspace-target-policy.mjs"), "");
  writeFileSync(join(root, "scripts/verify-workspace-targets.mjs"), "");
  writeFileSync(join(root, "package.json"), '{"private":true}');
  writeFileSync(
    join(root, "tsconfig.base.json"),
    readFileSync(join(repositoryRoot, "tsconfig.base.json")),
  );
  writeFileSync(
    join(root, "nx.json"),
    readFileSync(join(repositoryRoot, "nx.json")),
  );
  writeFileSync(
    join(root, "packages/example/tsconfig.json"),
    '{"extends":"../../tsconfig.base.json","include":["src/**/*.ts"]}',
  );
  writeFileSync(
    join(root, "packages/example/package.json"),
    JSON.stringify({
      name: "@agentscope/example",
      scripts: Object.fromEntries(
        ["build", "typecheck", "lint", "test", "coverage", "clean"].map(
          (target) => [target, `example-${target}`],
        ),
      ),
    }),
  );
  return root;
}

test("audits every mandatory target without modifying the fixture", () => {
  const root = createFixture();
  try {
    const manifestPath = join(root, "packages/example/package.json");
    const before = readFileSync(manifestPath, "utf8");
    const result = auditWorkspaceTargets({
      workspaceRoot: root,
      expectedPackages: new Map([["packages/example", "@agentscope/example"]]),
    });
    assert.deepEqual(result, [
      { name: "@agentscope/example", path: "packages/example" },
    ]);
    assert.equal(readFileSync(manifestPath, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails deterministically when a workspace target is missing", () => {
  const root = createFixture();
  try {
    const manifestPath = join(root, "packages/example/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.scripts.coverage;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
      () =>
        auditWorkspaceTargets({
          workspaceRoot: root,
          expectedPackages: new Map([
            ["packages/example", "@agentscope/example"],
          ]),
        }),
      /missing mandatory Nx\/package target: coverage/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const target of ["lint", "test", "coverage"]) {
  test(`rejects ${target} without a same-project build settlement edge`, () => {
    const root = createFixture();
    try {
      const nxPath = join(root, "nx.json");
      const nx = JSON.parse(readFileSync(nxPath, "utf8"));
      nx.targetDefaults[target].dependsOn = ["^build"];
      writeFileSync(nxPath, JSON.stringify(nx));
      assert.throws(
        () =>
          auditWorkspaceTargets({
            workspaceRoot: root,
            expectedPackages: new Map([
              ["packages/example", "@agentscope/example"],
            ]),
          }),
        new RegExp(`nx ${target} must depend on its own settled build`),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("rejects build cleanup that can delete another target's output", () => {
  const root = createFixture();
  try {
    const manifestPath = join(root, "packages/example/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.scripts.build =
      "node ../../scripts/clean-workspace.mjs && tsc -p tsconfig.json";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
      () =>
        auditWorkspaceTargets({
          workspaceRoot: root,
          expectedPackages: new Map([
            ["packages/example", "@agentscope/example"],
          ]),
        }),
      /build cleanup must preserve other target outputs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects any unscoped cleaner invocation in a build script", () => {
  const root = createFixture();
  try {
    const manifestPath = join(root, "packages/example/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.scripts.build =
      "node ../../scripts/clean-workspace.mjs --build-outputs && node ../../scripts/clean-workspace.mjs";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
      () =>
        auditWorkspaceTargets({
          workspaceRoot: root,
          expectedPackages: new Map([
            ["packages/example", "@agentscope/example"],
          ]),
        }),
      /build cleanup must preserve other target outputs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build cleanup preserves coverage while full cleanup owns it", () => {
  const workspaceDirectory = join(repositoryRoot, "packages/testkit");
  const coverageCanary = join(
    workspaceDirectory,
    "coverage/artifact-owner-canary",
  );
  const buildCanary = join(workspaceDirectory, "dist/build-owner-canary");
  const cleaner = join(repositoryRoot, "scripts/clean-workspace.mjs");
  try {
    mkdirSync(join(workspaceDirectory, "coverage"), { recursive: true });
    mkdirSync(join(workspaceDirectory, "dist"), { recursive: true });
    writeFileSync(coverageCanary, "coverage-owned");
    writeFileSync(buildCanary, "build-owned");

    const buildCleanup = spawnSync(
      process.execPath,
      [cleaner, "--build-outputs"],
      { cwd: workspaceDirectory, encoding: "utf8" },
    );
    assert.equal(buildCleanup.status, 0, buildCleanup.stderr);
    assert.equal(existsSync(coverageCanary), true);
    assert.equal(existsSync(buildCanary), false);

    const invalidCleanup = spawnSync(
      process.execPath,
      [cleaner, "--build-outputs", "--unexpected"],
      { cwd: workspaceDirectory, encoding: "utf8" },
    );
    assert.notEqual(invalidCleanup.status, 0);
    assert.match(
      `${invalidCleanup.stdout}${invalidCleanup.stderr}`,
      /Usage: clean-workspace\.mjs/,
    );
    assert.equal(existsSync(coverageCanary), true);

    const fullCleanup = spawnSync(process.execPath, [cleaner], {
      cwd: workspaceDirectory,
      encoding: "utf8",
    });
    assert.equal(fullCleanup.status, 0, fullCleanup.stderr);
    assert.equal(existsSync(coverageCanary), false);
  } finally {
    rmSync(coverageCanary, { force: true });
    rmSync(buildCanary, { force: true });
  }
});

test("the shared strict configuration rejects a seeded type error", () => {
  const root = createFixture();
  try {
    mkdirSync(join(root, "packages/example/src"));
    writeFileSync(
      join(root, "packages/example/src/index.ts"),
      'const count: number = "not-a-number";\nexport { count };\n',
    );
    const tsc = join(repositoryRoot, "node_modules/typescript/bin/tsc");
    const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
      cwd: join(root, "packages/example"),
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /TS2322/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace cleanup refuses to run from the repository root", () => {
  const result = spawnSync(
    process.execPath,
    [join(repositoryRoot, "scripts/clean-workspace.mjs")],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Refusing to clean/);
});
