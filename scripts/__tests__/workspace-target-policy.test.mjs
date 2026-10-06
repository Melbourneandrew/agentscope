import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vitest";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { auditWorkspaceTargets } from "../workspace-target-policy.mjs";
import { expectedWorkspacePackages } from "../workspace-packages.mjs";
import { createWorkspaceCleanupFixture } from "../fixtures/workspace-cleanup-fixture.mjs";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentscope-target-policy-"));
  mkdirSync(join(root, "packages/protocol"), { recursive: true });
  for (const file of [
    "eslint.config.mjs",
    ".prettierignore",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
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
    join(root, "packages/protocol/tsconfig.json"),
    '{"extends":"../../tsconfig.base.json","include":["src/**/*.ts"]}',
  );
  writeFileSync(
    join(root, "packages/protocol/package.json"),
    JSON.stringify({
      name: "@agentscope/protocol",
      scripts: Object.fromEntries(
        ["build", "typecheck", "lint", "test", "coverage", "clean"].map(
          (target) => [target, `example-${target}`],
        ),
      ),
    }),
  );
  return root;
}

function createDocsFixture() {
  const root = createFixture();
  mkdirSync(join(root, "apps"));
  renameSync(join(root, "packages/protocol"), join(root, "apps/docs"));
  const manifestPath = join(root, "apps/docs/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.name = "@agentscope/docs";
  manifest.nx = {
    targets: {
      build: { cache: false },
      typecheck: {
        cache: false,
        dependsOn: ["build", "^typecheck", "^build"],
      },
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return root;
}

test("audits every mandatory target without modifying the fixture", () => {
  const root = createFixture();
  try {
    const manifestPath = join(root, "packages/protocol/package.json");
    const before = readFileSync(manifestPath, "utf8");
    const result = auditWorkspaceTargets({
      workspaceRoot: root,
      expectedPackages: new Map([
        ["packages/protocol", "@agentscope/protocol"],
      ]),
    });
    assert.deepEqual(result, [
      { name: "@agentscope/protocol", path: "packages/protocol" },
    ]);
    assert.equal(readFileSync(manifestPath, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails deterministically when a workspace target is missing", () => {
  const root = createFixture();
  try {
    const manifestPath = join(root, "packages/protocol/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.scripts.coverage;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
      () =>
        auditWorkspaceTargets({
          workspaceRoot: root,
          expectedPackages: new Map([
            ["packages/protocol", "@agentscope/protocol"],
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
              ["packages/protocol", "@agentscope/protocol"],
            ]),
          }),
        new RegExp(
          `nx ${target} cache inputs, outputs, or dependencies drifted`,
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("rejects build cleanup that can delete another target's output", () => {
  const root = createFixture();
  try {
    const manifestPath = join(root, "packages/protocol/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.scripts.build =
      "node ../../scripts/clean-workspace.mjs && tsc -p tsconfig.json";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
      () =>
        auditWorkspaceTargets({
          workspaceRoot: root,
          expectedPackages: new Map([
            ["packages/protocol", "@agentscope/protocol"],
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
    const manifestPath = join(root, "packages/protocol/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.scripts.build =
      "node ../../scripts/clean-workspace.mjs --build-outputs && node ../../scripts/clean-workspace.mjs";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
      () =>
        auditWorkspaceTargets({
          workspaceRoot: root,
          expectedPackages: new Map([
            ["packages/protocol", "@agentscope/protocol"],
          ]),
        }),
      /build cleanup must preserve other target outputs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build cleanup preserves coverage while full cleanup owns it", () => {
  const fixture = createWorkspaceCleanupFixture(repositoryRoot);
  const { workspaceDirectory, cleaner } = fixture;
  const realOutputs = ["dist", "coverage"].map((name) => {
    const path = join(repositoryRoot, "packages/testkit", name);
    return [path, existsSync(path) ? lstatSync(path) : undefined];
  });
  const coverageCanary = join(
    workspaceDirectory,
    "coverage/artifact-owner-canary",
  );
  const buildCanary = join(workspaceDirectory, "dist/build-owner-canary");
  try {
    mkdirSync(join(workspaceDirectory, "coverage"), { recursive: true });
    mkdirSync(join(workspaceDirectory, "dist"), { recursive: true });
    writeFileSync(coverageCanary, "coverage-owned");
    writeFileSync(buildCanary, "build-owned");

    const buildCleanup = spawnSync(
      process.execPath,
      [cleaner, "--build-outputs"],
      fixture.childOptions(),
    );
    assert.equal(buildCleanup.status, 0, buildCleanup.stderr);
    assert.equal(existsSync(coverageCanary), true);
    assert.equal(existsSync(buildCanary), false);

    const invalidCleanup = spawnSync(
      process.execPath,
      [cleaner, "--build-outputs", "--unexpected"],
      fixture.childOptions(),
    );
    assert.notEqual(invalidCleanup.status, 0);
    assert.match(
      `${invalidCleanup.stdout}${invalidCleanup.stderr}`,
      /Usage: clean-workspace\.mjs/,
    );
    assert.equal(existsSync(coverageCanary), true);

    const fullCleanup = spawnSync(
      process.execPath,
      [cleaner],
      fixture.childOptions(),
    );
    assert.equal(fullCleanup.status, 0, fullCleanup.stderr);
    assert.equal(existsSync(coverageCanary), false);
  } finally {
    fixture.cleanup();
    for (const [path, before] of realOutputs) {
      assert.equal(existsSync(path), before !== undefined);
      if (before) assert.deepEqual(lstatSync(path), before);
    }
  }
});

test("cleanup remains bound to its authenticated directory after parent replacement", () => {
  const fixture = createWorkspaceCleanupFixture(repositoryRoot);
  const { root, workspaceDirectory, cleaner } = fixture;
  const movedWorkspaceDirectory = join(root, "packages/protocol-moved");
  const externalDirectory = join(root, "external");
  try {
    mkdirSync(join(externalDirectory, ".next"), { recursive: true });
    mkdirSync(join(workspaceDirectory, ".next"), { recursive: true });
    writeFileSync(
      join(workspaceDirectory, ".next/original-canary"),
      "original",
    );
    writeFileSync(join(externalDirectory, ".next/external-canary"), "external");
    const preload = fixture.replacementPreload(
      movedWorkspaceDirectory,
      externalDirectory,
    );

    const result = spawnSync(
      process.execPath,
      [cleaner, "--build-outputs"],
      fixture.childOptions({
        env: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
      }),
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(
      existsSync(join(movedWorkspaceDirectory, ".next/original-canary")),
      false,
    );
    assert.equal(
      existsSync(join(externalDirectory, ".next/external-canary")),
      true,
    );
  } finally {
    fixture.cleanup();
  }
});

test("the shared strict configuration rejects a seeded type error", () => {
  const deadline = performance.now() + 5000;
  const root = createFixture();
  try {
    mkdirSync(join(root, "packages/protocol/src"));
    writeFileSync(
      join(root, "packages/protocol/src/index.ts"),
      'const count: number = "not-a-number";\nexport { count };\n',
    );
    const tsc = join(repositoryRoot, "node_modules/typescript/bin/tsc");
    const timeout = Math.floor(deadline - performance.now());
    assert.ok(timeout > 0, "target fixture deadline");
    const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
      cwd: join(root, "packages/protocol"),
      encoding: "utf8",
      timeout,
      maxBuffer: 64 * 1024,
      killSignal: "SIGKILL",
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
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 64 * 1024,
      killSignal: "SIGKILL",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Refusing to clean/);
});

test("the repository has one exact fail-closed cache eligibility matrix", () => {
  const audited = auditWorkspaceTargets({
    workspaceRoot: repositoryRoot,
    expectedPackages: expectedWorkspacePackages,
  });
  assert.equal(audited.length, 17);
});

test("Docs typecheck waits for its own generated route types", () => {
  const root = createDocsFixture();
  const manifestPath = join(root, "apps/docs/package.json");
  const audit = () =>
    auditWorkspaceTargets({
      workspaceRoot: root,
      expectedPackages: new Map([["apps/docs", "@agentscope/docs"]]),
    });
  try {
    assert.deepEqual(audit(), [
      { name: "@agentscope/docs", path: "apps/docs" },
    ]);
    for (const dependsOn of [
      ["^typecheck", "^build"],
      ["build", "^build", "^typecheck"],
    ]) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.nx.targets.typecheck.dependsOn = dependsOn;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      assert.throws(audit, /project Nx configuration drifted/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects missing cache metadata, remote runners, and unsafe cache widening", () => {
  const root = createFixture();
  const nxPath = join(root, "nx.json");
  const manifestPath = join(root, "packages/protocol/package.json");
  const originalNx = readFileSync(nxPath, "utf8");
  const originalManifest = readFileSync(manifestPath, "utf8");
  const audit = () =>
    auditWorkspaceTargets({
      workspaceRoot: root,
      expectedPackages: new Map([
        ["packages/protocol", "@agentscope/protocol"],
      ]),
    });
  try {
    const nxMutations = [
      (nx) => delete nx.namedInputs.runtimeEnvironment,
      (nx) => {
        nx.namedInputs.default = [];
      },
      (nx) => {
        nx.namedInputs.production = [];
      },
      (nx) => {
        nx.namedInputs.sharedGlobals.pop();
      },
      (nx) => {
        nx.neverConnectToCloud = false;
      },
      (nx) => {
        nx.nxCloudId = "seeded-remote-cache";
      },
      (nx) => {
        nx.tasksRunnerOptions = { default: { runner: "seeded-runner" } };
      },
      (nx) => {
        nx.plugins = ["./seeded-target-plugin.mjs"];
      },
      (nx) => {
        nx.targetDefaults.build.cache = true;
      },
      (nx) => {
        nx.targetDefaults.test.outputs = ["{projectRoot}/seeded-output"];
      },
      (nx) => {
        nx.targetDefaults.typecheck.dependsOn = ["^typecheck"];
      },
    ];
    for (const mutate of nxMutations) {
      const nx = JSON.parse(originalNx);
      mutate(nx);
      writeFileSync(nxPath, JSON.stringify(nx));
      assert.throws(audit);
    }

    writeFileSync(nxPath, originalNx);
    const manifest = JSON.parse(originalManifest);
    manifest.nx = {
      targets: {
        build: { cache: true, outputs: ["{projectRoot}/dist"] },
      },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(audit, /project Nx configuration drifted/);

    for (const target of ["typecheck", "lint", "test"]) {
      const changed = JSON.parse(originalManifest);
      changed.nx = { targets: { [target]: { inputs: [], dependsOn: [] } } };
      writeFileSync(manifestPath, JSON.stringify(changed));
      assert.throws(audit, /project Nx configuration drifted/);
    }

    for (const nxOverride of [
      { namedInputs: { default: [], production: [] } },
      { includedScripts: ["clean"] },
    ]) {
      const changed = JSON.parse(originalManifest);
      changed.nx = nxOverride;
      writeFileSync(manifestPath, JSON.stringify(changed));
      assert.throws(audit, /project Nx configuration drifted/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new workspace cannot inherit cache authority without explicit review", () => {
  const root = createFixture();
  try {
    renameSync(join(root, "packages/protocol"), join(root, "packages/future"));
    const manifestPath = join(root, "packages/future/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.name = "@agentscope/future";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
      () =>
        auditWorkspaceTargets({
          workspaceRoot: root,
          expectedPackages: new Map([
            ["packages/future", "@agentscope/future"],
          ]),
        }),
      /cache eligibility drifted/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a project.json cannot override the audited package target authority", () => {
  const root = createFixture();
  try {
    writeFileSync(
      join(root, "packages/protocol/project.json"),
      JSON.stringify({ targets: { test: { cache: true, inputs: [] } } }),
    );
    assert.throws(
      () =>
        auditWorkspaceTargets({
          workspaceRoot: root,
          expectedPackages: new Map([
            ["packages/protocol", "@agentscope/protocol"],
          ]),
        }),
      /must not add a second Nx project configuration/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function assertWorkflowCacheBypass(workflow) {
  assert.equal(workflow.env?.NX_SKIP_NX_CACHE, "true");
  for (const job of ["quality", "unit", "native"]) {
    assert.equal(workflow.jobs[job].env?.NX_SKIP_NX_CACHE, undefined);
    for (const step of workflow.jobs[job].steps) {
      assert.equal(step.env?.NX_SKIP_NX_CACHE, undefined);
      assert.doesNotMatch(step.run ?? "", /NX_SKIP_NX_CACHE/u);
    }
    const commands = workflow.jobs[job].steps
      .map((step) => step.run)
      .filter((command) => typeof command === "string")
      .join("\n");
    assert.match(
      commands,
      /pnpm (?:lint|test|coverage|build|typecheck|verify:native-candidate)/u,
    );
  }
}

test("GitHub release checks cannot consume Nx result-cache evidence", () => {
  const workflowSource = readFileSync(
    join(repositoryRoot, ".github/workflows/pr-validation.yml"),
    "utf8",
  );
  const workflow = parseYaml(workflowSource);
  assertWorkflowCacheBypass(workflow);
  assert.doesNotMatch(workflowSource, /\.nx\/cache|nx-cloud|nxCloud/iu);

  for (const mutate of [
    (copy) => {
      copy.jobs.quality.env = { NX_SKIP_NX_CACHE: "false" };
    },
    (copy) => {
      copy.jobs.native.steps.at(-1).env = { NX_SKIP_NX_CACHE: "false" };
    },
    (copy) => {
      copy.jobs.native.steps.at(-1).run =
        "NX_SKIP_NX_CACHE=false pnpm verify:native-candidate";
    },
  ]) {
    const changed = structuredClone(workflow);
    mutate(changed);
    assert.throws(() => assertWorkflowCacheBypass(changed));
  }
});
