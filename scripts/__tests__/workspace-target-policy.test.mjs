import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { auditWorkspaceTargets } from "../workspace-target-policy.mjs";
import { expectedWorkspacePackages } from "../workspace-packages.mjs";

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

test("cleanup remains bound to its authenticated directory after parent replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-clean-identity-"));
  const workspaceDirectory = join(root, "packages/example");
  const movedWorkspaceDirectory = join(root, "packages/example-moved");
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
      'export const expectedWorkspacePackages = new Map([["packages/example", "@agentscope/example"]]);\n',
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

test("the repository has one exact fail-closed cache eligibility matrix", () => {
  const audited = auditWorkspaceTargets({
    workspaceRoot: repositoryRoot,
    expectedPackages: expectedWorkspacePackages,
  });
  assert.equal(audited.length, 17);
});

test("rejects missing cache metadata, remote runners, and unsafe cache widening", () => {
  const root = createFixture();
  const nxPath = join(root, "nx.json");
  const manifestPath = join(root, "packages/example/package.json");
  const originalNx = readFileSync(nxPath, "utf8");
  const originalManifest = readFileSync(manifestPath, "utf8");
  const audit = () =>
    auditWorkspaceTargets({
      workspaceRoot: root,
      expectedPackages: new Map([["packages/example", "@agentscope/example"]]),
    });
  try {
    const nxMutations = [
      (nx) => delete nx.namedInputs.runtimeEnvironment,
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
    assert.throws(audit, /build cache eligibility drifted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub release checks cannot consume Nx result-cache evidence", () => {
  const workflow = parseYaml(
    readFileSync(
      join(repositoryRoot, ".github/workflows/pr-validation.yml"),
      "utf8",
    ),
  );
  assert.equal(workflow.env?.NX_SKIP_NX_CACHE, "true");
  for (const job of ["quality", "unit"]) {
    assert.equal(workflow.jobs[job].env?.NX_SKIP_NX_CACHE, undefined);
    const commands = workflow.jobs[job].steps
      .map((step) => step.run)
      .filter((command) => typeof command === "string")
      .join("\n");
    assert.match(commands, /pnpm (?:lint|test|coverage|build|typecheck)/u);
  }
  assert.doesNotMatch(
    readFileSync(
      join(repositoryRoot, ".github/workflows/pr-validation.yml"),
      "utf8",
    ),
    /\.nx\/cache|nx-cloud|nxCloud/iu,
  );
});

function createNxCacheFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentscope-nx-cache-"));
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
  };
}

test("standard Nx cache invalidates exact inputs and restores only declared outputs", () => {
  const root = createNxCacheFixture();
  const nx = join(repositoryRoot, "node_modules/.bin/nx");
  const run = (arguments_, runtime = "runtime-one") => {
    const result = spawnSync(
      nx,
      [
        ...arguments_,
        ...(arguments_[0] === "reset" ? [] : ["--outputStyle=static"]),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: localNxEnvironment(runtime),
        timeout: 60_000,
      },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  };
  const build = (runtime) => run(["run", "@fixture/consumer:build"], runtime);
  try {
    build();
    assert.equal(executionCount(root, "dependency"), 1);
    assert.equal(executionCount(root, "consumer"), 1);

    writeFileSync(join(root, "packages/dependency/dist/result.txt"), "stale\n");
    rmSync(join(root, "packages/consumer/dist"), {
      recursive: true,
      force: true,
    });
    rmSync(join(root, "untracked"), { recursive: true, force: true });
    build();
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

    writeFileSync(
      join(root, "packages/dependency/src/value.txt"),
      "dependency-two\n",
    );
    build();
    assert.equal(executionCount(root, "dependency"), 2);
    assert.equal(executionCount(root, "consumer"), 2);

    writeFileSync(
      join(root, "packages/dependency/src/value.txt"),
      "substitute-two\n",
    );
    build();
    assert.equal(executionCount(root, "dependency"), 3);
    assert.equal(executionCount(root, "consumer"), 3);

    unlinkSync(join(root, "packages/consumer/src/value.txt"));
    build();
    assert.equal(executionCount(root, "consumer"), 4);

    const manifestPath = join(root, "packages/consumer/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.scripts.build += " command-change";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    build();
    assert.equal(executionCount(root, "consumer"), 5);

    writeFileSync(join(root, "root-policy.txt"), "policy-two\n");
    build();
    assert.equal(executionCount(root, "dependency"), 4);
    assert.equal(executionCount(root, "consumer"), 6);

    const lockPath = join(root, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.seededPolicy = "changed";
    writeFileSync(lockPath, JSON.stringify(lock));
    build();
    assert.equal(executionCount(root, "dependency"), 5);
    assert.equal(executionCount(root, "consumer"), 7);

    build("runtime-two");
    assert.equal(executionCount(root, "dependency"), 6);
    assert.equal(executionCount(root, "consumer"), 8);

    run(["reset"], "runtime-two");
    build("runtime-two");
    assert.equal(executionCount(root, "dependency"), 7);
    assert.equal(executionCount(root, "consumer"), 9);

    run(["run", "@fixture/consumer:coverage"], "runtime-two");
    run(["run", "@fixture/consumer:coverage"], "runtime-two");
    assert.equal(executionCount(root, "consumer", "coverage"), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
