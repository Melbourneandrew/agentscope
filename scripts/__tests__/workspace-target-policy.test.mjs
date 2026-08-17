import assert from "node:assert/strict";
import {
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
