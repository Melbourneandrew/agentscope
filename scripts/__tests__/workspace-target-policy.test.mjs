import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { auditWorkspaceTargets } from "../workspace-target-policy.mjs";
import { expectedWorkspacePackages } from "../workspace-packages.mjs";
import {
  assertNxCacheWorkBudget,
  bindNxCacheFixture,
  bindNxCacheMessagesForTesting,
  cleanupNxCacheFixture,
  runNxCacheCommand,
} from "../fixtures/nx-cache-process.mjs";

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

test("cleanup remains bound to its authenticated directory after parent replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-clean-identity-"));
  const workspaceDirectory = join(root, "packages/protocol");
  const movedWorkspaceDirectory = join(root, "packages/protocol-moved");
  const externalDirectory = join(root, "external");
  const cleaner = join(root, "scripts/clean-workspace.mjs");
  const preload = join(root, "replace-parent.cjs");
  try {
    mkdirSync(workspaceDirectory, { recursive: true });
    mkdirSync(join(externalDirectory, ".next"), { recursive: true });
    mkdirSync(join(workspaceDirectory, ".next"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(workspaceDirectory, ".next/original-canary"),
      "original",
    );
    writeFileSync(join(externalDirectory, ".next/external-canary"), "external");
    writeFileSync(
      cleaner,
      readFileSync(join(repositoryRoot, "scripts/clean-workspace.mjs")),
    );
    writeFileSync(
      join(root, "scripts/workspace-packages.mjs"),
      'export const expectedWorkspacePackages = new Map([["packages/protocol", "@agentscope/protocol"]]);\n',
    );
    writeFileSync(
      preload,
      `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const originalRmSync = fs.rmSync;
const originalDirectory = process.cwd();
let replaced = false;
fs.rmSync = function (target, options) {
  if (!replaced) {
    replaced = true;
    fs.renameSync(originalDirectory, ${JSON.stringify(movedWorkspaceDirectory)});
    fs.symlinkSync(${JSON.stringify(externalDirectory)}, originalDirectory, "dir");
  }
  return Reflect.apply(originalRmSync, this, [target, options]);
};
syncBuiltinESMExports();
`,
    );

    const result = spawnSync(process.execPath, [cleaner, "--build-outputs"], {
      cwd: workspaceDirectory,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
    });
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shared strict configuration rejects a seeded type error", () => {
  const root = createFixture();
  try {
    mkdirSync(join(root, "packages/protocol/src"));
    writeFileSync(
      join(root, "packages/protocol/src/index.ts"),
      'const count: number = "not-a-number";\nexport { count };\n',
    );
    const tsc = join(repositoryRoot, "node_modules/typescript/bin/tsc");
    const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
      cwd: join(root, "packages/protocol"),
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

function createNxCacheFixture(root) {
  for (const name of ["dependency", "consumer"]) {
    mkdirSync(join(root, `packages/${name}/src`), { recursive: true });
    writeFileSync(
      join(root, `packages/${name}/src/value.txt`),
      `${name}-one\n`,
    );
    writeFileSync(
      join(root, `packages/${name}/package.json`),
      JSON.stringify({
        name: `@fixture/${name}`,
        version: "1.0.0",
        scripts: {
          build: `node ../../task.mjs ${name} build`,
          coverage: `node ../../task.mjs ${name} coverage`,
        },
        ...(name === "consumer"
          ? { dependencies: { "@fixture/dependency": "workspace:*" } }
          : {}),
      }),
    );
  }
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "cache-fixture",
      private: true,
      version: "1.0.0",
      packageManager: "npm@10.9.2",
      workspaces: ["packages/*"],
    }),
  );
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: "cache-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "cache-fixture",
          version: "1.0.0",
          workspaces: ["packages/*"],
        },
        "packages/dependency": {
          name: "@fixture/dependency",
          version: "1.0.0",
        },
        "packages/consumer": {
          name: "@fixture/consumer",
          version: "1.0.0",
          dependencies: { "@fixture/dependency": "workspace:*" },
        },
      },
    }),
  );
  writeFileSync(join(root, "root-policy.txt"), "policy-one\n");
  writeFileSync(join(root, ".gitignore"), ".nx\nobservations\nuntracked\n");
  writeFileSync(
    join(root, "nx.json"),
    JSON.stringify({
      neverConnectToCloud: true,
      namedInputs: {
        default: [
          "{projectRoot}/src/**/*",
          "{projectRoot}/package.json",
          "sharedGlobals",
        ],
        production: ["default"],
        sharedGlobals: [
          "{workspaceRoot}/task.mjs",
          "{workspaceRoot}/root-policy.txt",
          "{workspaceRoot}/package-lock.json",
        ],
        runtimeEnvironment: [{ env: "CACHE_RUNTIME" }],
      },
      targetDefaults: {
        build: {
          cache: true,
          dependsOn: ["^build"],
          inputs: ["production", "^production", "runtimeEnvironment"],
          outputs: ["{projectRoot}/dist"],
        },
        coverage: {
          cache: false,
          inputs: ["default", "^production", "runtimeEnvironment"],
        },
      },
    }),
  );
  writeFileSync(
    join(root, "task.mjs"),
    `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const [name, target] = process.argv.slice(2);
const root = process.cwd().endsWith(name) ? resolve(process.cwd(), "../..") : process.cwd();
const project = resolve(root, "packages", name);
const source = resolve(project, "src/value.txt");
const value = existsSync(source) ? readFileSync(source, "utf8") : "missing\\n";
mkdirSync(resolve(root, "observations"), { recursive: true });
appendFileSync(resolve(root, "observations", name + "-" + target), "executed\\n");
mkdirSync(resolve(root, "untracked"), { recursive: true });
writeFileSync(resolve(root, "untracked", name), "not-a-declared-output\\n");
if (target === "build") {
  mkdirSync(resolve(project, "dist"), { recursive: true });
  writeFileSync(resolve(project, "dist/result.txt"), value);
}
`,
  );
  return root;
}

function executionCount(root, name, target = "build") {
  const path = join(root, "observations", `${name}-${target}`);
  return existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").length
    : 0;
}

function replaceFixtureInput(path, value) {
  const previous = readFileSync(path, "utf8");
  const previousMtime = statSync(path).mtimeMs;
  assert.notEqual(value, previous);
  assert.equal(Buffer.byteLength(value), Buffer.byteLength(previous));
  const replacement = `${path}.replacement`;
  writeFileSync(replacement, value);
  renameSync(replacement, path);
  const nextMtimeSeconds = Math.floor(previousMtime / 1_000) + 1;
  utimesSync(path, nextMtimeSeconds, nextMtimeSeconds);
  assert.ok(statSync(path).mtimeMs > previousMtime);
}

function localNxEnvironment(runtime) {
  const environment = { ...process.env };
  for (const name of [
    "NX_SKIP_NX_CACHE",
    "NX_DISABLE_NX_CACHE",
    "NX_TASKS_RUNNER",
  ]) {
    delete environment[name];
  }
  return {
    ...environment,
    CACHE_RUNTIME: runtime,
    NX_DAEMON: "false",
    NX_NO_CLOUD: "true",
    // This closed fixture has no custom plugins. Keep built-in graph loading
    // in-process: plugin-worker startup is not part of the cache contract.
    // Real Nx commands, hashing, cache and output restoration stay enabled.
    NX_ISOLATE_PLUGINS: "false",
  };
}

async function withNxCacheFixture(check, duration = 30_000) {
  // Each independent cache proposition owns one deadline before setup.
  const deadline = performance.now() + duration;
  const root = mkdtempSync(join(tmpdir(), "agentscope-nx-cache-"));
  const identity = lstatSync(root);
  let authority;
  const run = (arguments_, runtime = "runtime-one") =>
    runNxCacheCommand(authority, arguments_, localNxEnvironment(runtime));
  const build = (runtime) => run(["run", "@fixture/consumer:build"], runtime);
  let primary;
  try {
    authority = bindNxCacheFixture(root, deadline);
    createNxCacheFixture(root);
    await check({ root, authority, run, build });
  } catch (error) {
    primary = { error };
  }
  // Unsettled/substituted authority retains its private fixture, never a
  // prefix sweep or cleanup claim based only on the Nx leader's exit.
  try {
    if (authority === undefined)
      throw new Error("Nx fixture setup root quarantined", {
        cause: { path: root, dev: identity.dev, ino: identity.ino },
      });
    cleanupNxCacheFixture(authority);
  } catch (error) {
    if (primary !== undefined)
      throw new AggregateError(
        [primary.error, error],
        "Nx fixture failed and remains unsettled",
        { cause: error },
      );
    throw error;
  }
  if (primary !== undefined) throw primary.error;
}

test("standard Nx cache restores only declared outputs", async () => {
  await withNxCacheFixture(async ({ root, build }) => {
    await build();
    assert.equal(executionCount(root, "dependency"), 1);
    assert.equal(executionCount(root, "consumer"), 1);

    writeFileSync(join(root, "packages/dependency/dist/result.txt"), "stale\n");
    rmSync(join(root, "packages/consumer/dist"), {
      recursive: true,
      force: true,
    });
    rmSync(join(root, "untracked"), { recursive: true, force: true });
    await build();
    assert.equal(executionCount(root, "dependency"), 1);
    assert.equal(executionCount(root, "consumer"), 1);
    assert.equal(
      readFileSync(join(root, "packages/dependency/dist/result.txt"), "utf8"),
      "dependency-one\n",
    );
    assert.equal(
      readFileSync(join(root, "packages/consumer/dist/result.txt"), "utf8"),
      "consumer-one\n",
    );
    assert.equal(existsSync(join(root, "untracked/dependency")), false);
    assert.equal(existsSync(join(root, "untracked/consumer")), false);
  });
}, 30_000);

const cacheInputCases = [
  {
    name: "dependency content change",
    dependencyExecutions: 2,
    change(root) {
      writeFileSync(
        join(root, "packages/dependency/src/value.txt"),
        "dependency-two\n",
      );
    },
  },
  {
    name: "same-length atomic dependency substitution",
    dependencyExecutions: 2,
    change(root) {
      replaceFixtureInput(
        join(root, "packages/dependency/src/value.txt"),
        "substitute-one\n",
      );
    },
  },
  {
    name: "source deletion",
    dependencyExecutions: 1,
    change(root) {
      unlinkSync(join(root, "packages/consumer/src/value.txt"));
    },
  },
  {
    name: "command manifest change",
    dependencyExecutions: 1,
    change(root) {
      const path = join(root, "packages/consumer/package.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.scripts.build += " command-change";
      writeFileSync(path, JSON.stringify(manifest));
    },
  },
  {
    name: "root policy change",
    dependencyExecutions: 2,
    change(root) {
      writeFileSync(join(root, "root-policy.txt"), "policy-two\n");
    },
  },
  {
    name: "lockfile change",
    dependencyExecutions: 2,
    change(root) {
      const path = join(root, "package-lock.json");
      const lock = JSON.parse(readFileSync(path, "utf8"));
      lock.seededPolicy = "changed";
      writeFileSync(path, JSON.stringify(lock));
    },
  },
  {
    name: "runtime input change",
    dependencyExecutions: 2,
    runtime: "runtime-two",
    change() {},
  },
];

test.each(cacheInputCases)(
  "standard Nx cache invalidates $name",
  async (entry) => {
    await withNxCacheFixture(async ({ root, build }) => {
      await build();
      assert.equal(executionCount(root, "dependency"), 1);
      assert.equal(executionCount(root, "consumer"), 1);
      entry.change(root);
      await build(entry.runtime);
      assert.equal(
        executionCount(root, "dependency"),
        entry.dependencyExecutions,
      );
      assert.equal(executionCount(root, "consumer"), 2);
    });
  },
  30_000,
);

test("standard Nx reset removes prior execution evidence", async () => {
  await withNxCacheFixture(async ({ root, build, run }) => {
    await build();
    await run(["reset"]);
    await build();
    assert.equal(executionCount(root, "dependency"), 2);
    assert.equal(executionCount(root, "consumer"), 2);
  });
}, 30_000);

test("standard Nx coverage never consumes cached execution", async () => {
  await withNxCacheFixture(async ({ root, run }) => {
    await run(["run", "@fixture/consumer:coverage"]);
    assert.equal(executionCount(root, "consumer", "coverage"), 1);
    await run(["run", "@fixture/consumer:coverage"]);
    assert.equal(executionCount(root, "consumer", "coverage"), 2);
  });
}, 30_000);

test("Nx fixture rejects arbitrary command authority without a child", async () => {
  await withNxCacheFixture(({ authority, run }) => {
    assert.throws(() => run(["exec", "arbitrary"]), /fixture.command/u);
    assert.equal(authority.active, false);
  });
}, 30_000);

test("Nx fixture rejects exhausted invocation budget at its exact cutoff", () => {
  assert.equal(assertNxCacheWorkBudget(30_000, 26_999), 27_000);
  for (const now of [27_000, 27_001, 30_000, NaN, Infinity])
    assert.throws(
      () => assertNxCacheWorkBudget(30_000, now),
      /fixture.deadline/u,
    );
  assert.throws(() => assertNxCacheWorkBudget(NaN, 0), /fixture.deadline/u);
});

test("Nx fixture rejects symlink and changed-mode roots without launching", async () => {
  await withNxCacheFixture(({ root, authority, run }) => {
    const alias = join(root, "root-alias");
    symlinkSync(root, alias, "dir");
    assert.throws(
      () => bindNxCacheFixture(alias, authority.deadline),
      /fixture.root-authority/u,
    );
    unlinkSync(alias);
    chmodSync(root, 0o750);
    try {
      assert.throws(() => run(["reset"]), /fixture.root-substitution/u);
      assert.throws(
        () => cleanupNxCacheFixture(authority),
        /fixture.root-substitution/u,
      );
      assert.equal(authority.active, false);
      assert.equal(existsSync(root), true);
    } finally {
      chmodSync(root, 0o700);
    }
  });
}, 30_000);

test("Nx fixture preserves quarantined evidence instead of deleting it", async () => {
  await withNxCacheFixture(({ root, authority }) => {
    authority.quarantined = true;
    try {
      assert.throws(
        () => cleanupNxCacheFixture(authority),
        /fixture.quarantined/u,
      );
      assert.equal(existsSync(root), true);
    } finally {
      // This synthetic metadata-only case launched no child or mutation.
      authority.quarantined = false;
    }
  });
}, 30_000);

function messageFixture() {
  const child = new EventEmitter();
  const sent = [];
  const errors = [];
  let stopped = false;
  child.send = (message) => sent.push(message);
  const command = {
    nonce: "a".repeat(32),
    leader: { pid: 1 },
    arguments: ["reset"],
    cutoff: performance.now() + 5_000,
    deadline: performance.now() + 8_000,
    progress: { phase: "wrapper-startup" },
  };
  bindNxCacheMessagesForTesting(
    child,
    command,
    () => stopped,
    (error) => errors.push(error),
    () => {
      stopped = true;
    },
  );
  return { child, command, sent, errors };
}

test("Nx fixture rejects late ready before starting a command", () => {
  const state = messageFixture();
  state.command.cutoff = performance.now() - 1;
  state.child.emit("message", { nonce: state.command.nonce, kind: "ready" });
  assert.equal(state.sent.length, 0);
  assert.match(state.errors[0].message, /fixture.deadline/u);
});

test("Nx fixture rejects late terminal before success inspection", () => {
  const state = messageFixture();
  state.child.emit("message", { nonce: state.command.nonce, kind: "ready" });
  state.command.cutoff = performance.now() - 1;
  state.child.emit("message", {
    nonce: state.command.nonce,
    kind: "terminal",
    code: 0,
    signal: null,
    error: false,
    overflow: false,
  });
  assert.equal(state.sent.length, 1);
  assert.match(state.errors[0].message, /fixture.deadline/u);
  assert.equal(state.command.progress.phase, "nx-command");
});

test.each(["substituted", "duplicate"])(
  "Nx fixture rejects %s ready authority",
  (kind) => {
    const state = messageFixture();
    if (kind === "duplicate")
      state.child.emit("message", {
        nonce: state.command.nonce,
        kind: "ready",
      });
    state.child.emit("message", {
      nonce: kind === "substituted" ? "b".repeat(32) : state.command.nonce,
      kind: "ready",
    });
    assert.equal(state.sent.length, kind === "duplicate" ? 1 : 0);
    assert.match(state.errors[0].message, /fixture.message/u);
  },
);

test("Nx fixture bounds overflowing command output and joins before cleanup", async () => {
  await withNxCacheFixture(async ({ root, authority, build }) => {
    const path = join(root, "task.mjs");
    writeFileSync(
      path,
      readFileSync(path, "utf8") +
        '\nif (name === "consumer") process.stdout.write("x".repeat(128 * 1024));\n',
    );
    await assert.rejects(build(), /fixture.command-terminal/u);
    assert.equal(authority.active, false);
    assert.equal(authority.quarantined, false);
  });
}, 30_000);

test("Nx fixture rejects a surviving descendant and joins it before cleanup", async () => {
  await withNxCacheFixture(async ({ root, authority, build }) => {
    const path = join(root, "task.mjs");
    writeFileSync(
      path,
      readFileSync(path, "utf8") +
        `
if (name === "consumer") {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.send("owned-descendant-ready");'], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await new Promise((settle) => child.once("message", (message) => {
    if (message !== "owned-descendant-ready") process.exit(1);
    writeFileSync(resolve(root, "descendant-pid"), String(child.pid));
    child.disconnect(); child.unref(); settle();
  }));
}
`,
    );
    await assert.rejects(build(), /fixture.command-terminal/u);
    const pid = Number(readFileSync(join(root, "descendant-pid"), "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(authority.active, false);
    assert.equal(authority.quarantined, false);
  });
}, 30_000);
