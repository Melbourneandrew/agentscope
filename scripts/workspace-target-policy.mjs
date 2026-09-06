import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const mandatoryWorkspaceTargets = Object.freeze([
  "build",
  "typecheck",
  "lint",
  "test",
  "coverage",
  "clean",
]);

const requiredStrictOptions = Object.freeze({
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  useUnknownInCatchVariables: true,
  noImplicitOverride: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  forceConsistentCasingInFileNames: true,
});

const requiredSharedGlobals = Object.freeze([
  "{workspaceRoot}/package.json",
  "{workspaceRoot}/pnpm-lock.yaml",
  "{workspaceRoot}/pnpm-workspace.yaml",
  "{workspaceRoot}/nx.json",
  "{workspaceRoot}/tsconfig.base.json",
  "{workspaceRoot}/eslint.config.mjs",
  "{workspaceRoot}/vitest.config.ts",
  "{workspaceRoot}/quality-policy.json",
  "{workspaceRoot}/.prettierignore",
  "{workspaceRoot}/scripts/workspace-packages.mjs",
  "{workspaceRoot}/scripts/workspace-target-policy.mjs",
  "{workspaceRoot}/scripts/verify-workspace-targets.mjs",
  "{workspaceRoot}/scripts/clean-workspace.mjs",
  "{workspaceRoot}/scripts/code-quality-policy.mjs",
  "{workspaceRoot}/scripts/verify-code-quality-policy.mjs",
  "{workspaceRoot}/scripts/acceptance-evidence.mjs",
  "{workspaceRoot}/acceptance-evidence.json",
]);

const requiredRuntimeEnvironment = Object.freeze([
  Object.freeze({
    runtime:
      'node -p "JSON.stringify([process.version, process.platform, process.arch])"',
  }),
  Object.freeze({ runtime: "pnpm --version" }),
]);

const requiredDefaultInputs = Object.freeze([
  "{projectRoot}/**/*",
  "sharedGlobals",
]);

const requiredProductionInputs = Object.freeze([
  "default",
  "!{projectRoot}/**/*.test.*",
  "!{projectRoot}/**/__tests__/**",
]);

const cacheableBuildPaths = new Set([
  "apps/cli",
  "packages/core",
  "packages/destinations/langfuse",
  "packages/destinations/local-sqlite",
  "packages/harnesses/claude-code",
  "packages/harnesses/codex",
  "packages/harnesses/core",
  "packages/testkit",
]);

const cacheableTypecheckPaths = new Set([
  "apps/cli",
  "packages/core",
  "packages/destinations/core",
  "packages/destinations/langfuse",
  "packages/destinations/local-sqlite",
  "packages/harnesses/claude-code",
  "packages/harnesses/codex",
  "packages/harnesses/core",
  "packages/harnesses/gemini-cli",
  "packages/harnesses/hermes",
  "packages/harnesses/opencode",
  "packages/harnesses/openclaw",
  "packages/harnesses/pi",
  "packages/protocol",
  "packages/testkit",
  "tests/integration",
]);

const cacheableLintPaths = new Set([
  "apps/cli",
  "apps/docs",
  ...cacheableTypecheckPaths,
]);

const cacheableTestPaths = new Set(
  [...cacheableLintPaths].filter((path) => path !== "tests/integration"),
);

const expectedTargetDefaults = Object.freeze({
  build: Object.freeze({
    cache: false,
    dependsOn: Object.freeze(["^build"]),
    inputs: Object.freeze(["production", "^production", "runtimeEnvironment"]),
  }),
  typecheck: Object.freeze({
    cache: true,
    dependsOn: Object.freeze(["^typecheck", "^build"]),
    inputs: Object.freeze(["default", "^production", "runtimeEnvironment"]),
  }),
  lint: Object.freeze({
    cache: true,
    dependsOn: Object.freeze(["build"]),
    inputs: Object.freeze(["default", "^production", "runtimeEnvironment"]),
  }),
  test: Object.freeze({
    cache: true,
    dependsOn: Object.freeze(["build"]),
    inputs: Object.freeze(["default", "^production", "runtimeEnvironment"]),
  }),
  coverage: Object.freeze({
    cache: false,
    dependsOn: Object.freeze(["build"]),
    inputs: Object.freeze(["default", "^production", "runtimeEnvironment"]),
    outputs: Object.freeze(["{projectRoot}/coverage"]),
  }),
  clean: Object.freeze({ cache: false }),
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function targetOverride(manifest, target) {
  const value = manifest.nx?.targets?.[target];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function auditNxConfiguration(nx) {
  assert(
    exactJson(
      Object.keys(nx).sort(),
      [
        "$schema",
        "defaultBase",
        "namedInputs",
        "targetDefaults",
        "neverConnectToCloud",
        "analytics",
      ].sort(),
    ),
    "nx root configuration authority drifted",
  );
  assert(
    nx.$schema === "./node_modules/nx/schemas/nx-schema.json" &&
      nx.defaultBase === "main" &&
      nx.analytics === false,
    "nx root identity settings drifted",
  );
  assert(
    nx.neverConnectToCloud === true,
    "nx must permanently disable remote cache connection",
  );
  assert(
    nx.nxCloudId === undefined && nx.tasksRunnerOptions === undefined,
    "nx remote or custom task runners are forbidden",
  );
  assert(
    exactJson(nx.namedInputs?.sharedGlobals, requiredSharedGlobals),
    "nx shared global inputs drifted",
  );
  for (const target of mandatoryWorkspaceTargets) {
    assert(
      nx.targetDefaults?.[target] !== undefined,
      `nx targetDefaults is missing ${target}`,
    );
    assert(
      exactJson(nx.targetDefaults[target], expectedTargetDefaults[target]),
      `nx ${target} cache inputs, outputs, or dependencies drifted`,
    );
  }
  assert(
    exactJson(nx.namedInputs?.runtimeEnvironment, requiredRuntimeEnvironment),
    "nx runtime environment fingerprint drifted",
  );
  assert(
    exactJson(nx.namedInputs?.default, requiredDefaultInputs),
    "nx default inputs drifted",
  );
  assert(
    exactJson(nx.namedInputs?.production, requiredProductionInputs),
    "nx production inputs drifted",
  );
}

function auditProjectCache({ manifest, nx, relativePath, expectedName }) {
  const expectedCache = {
    build: cacheableBuildPaths.has(relativePath),
    typecheck: cacheableTypecheckPaths.has(relativePath),
    lint: cacheableLintPaths.has(relativePath),
    test: cacheableTestPaths.has(relativePath),
    coverage: false,
    clean: false,
  };
  const expectedManifestNx = cacheableBuildPaths.has(relativePath)
    ? {
        targets: {
          build: { cache: true, outputs: ["{projectRoot}/dist"] },
        },
      }
    : relativePath === "apps/docs"
      ? {
          targets: {
            build: { cache: false },
            typecheck: { cache: false },
          },
        }
      : relativePath === "tests/integration"
        ? {
            targets: {
              build: { cache: false },
              test: { cache: false },
            },
          }
        : undefined;
  assert(
    exactJson(manifest.nx, expectedManifestNx),
    `${expectedName} project Nx configuration drifted`,
  );
  for (const [target, expected] of Object.entries(expectedCache)) {
    const override = targetOverride(manifest, target);
    const expectedOverride =
      target === "build" && expected
        ? { cache: true, outputs: ["{projectRoot}/dist"] }
        : target === "build" &&
            ["apps/docs", "tests/integration"].includes(relativePath)
          ? { cache: false }
          : target === "typecheck" && relativePath === "apps/docs"
            ? { cache: false }
            : target === "test" && relativePath === "tests/integration"
              ? { cache: false }
              : {};
    assert(
      exactJson(override, expectedOverride),
      `${expectedName} ${target} target override drifted`,
    );
    const actual = override.cache ?? nx.targetDefaults[target].cache;
    assert(
      actual === expected,
      `${expectedName} ${target} cache eligibility drifted`,
    );
    if (["typecheck", "lint", "test"].includes(target)) {
      assert(
        override.outputs === undefined &&
          nx.targetDefaults[target].outputs === undefined,
        `${expectedName} ${target} must declare no outputs`,
      );
    }
  }
  const build = targetOverride(manifest, "build");
  if (expectedCache.build) {
    assert(
      exactJson(build.outputs, ["{projectRoot}/dist"]),
      `${expectedName} cacheable build must replace exactly dist`,
    );
    assert(
      manifest.scripts.build.includes(
        relativePath === "apps/cli"
          ? "node build.mjs"
          : "clean-workspace.mjs --build-outputs",
      ),
      `${expectedName} cacheable build lacks exact output settlement`,
    );
  } else {
    assert(
      build.outputs === undefined,
      `${expectedName} non-cacheable build must declare no replay output`,
    );
  }
}

export function auditWorkspaceTargets({ workspaceRoot, expectedPackages }) {
  const baseTsconfigPath = resolve(workspaceRoot, "tsconfig.base.json");
  const baseTsconfig = readJson(baseTsconfigPath);
  for (const [option, expected] of Object.entries(requiredStrictOptions)) {
    assert(
      baseTsconfig.compilerOptions?.[option] === expected,
      `tsconfig.base.json must set compilerOptions.${option} to ${String(expected)}`,
    );
  }

  const nx = readJson(resolve(workspaceRoot, "nx.json"));
  auditNxConfiguration(nx);

  const audited = [];
  for (const [relativePath, expectedName] of expectedPackages) {
    const manifestPath = resolve(workspaceRoot, relativePath, "package.json");
    assert(
      !existsSync(resolve(workspaceRoot, relativePath, "project.json")),
      `${relativePath} must not add a second Nx project configuration`,
    );
    assert(
      existsSync(manifestPath),
      `Missing workspace manifest: ${relativePath}`,
    );
    const manifest = readJson(manifestPath);
    assert(
      manifest.name === expectedName,
      `${relativePath} must be named ${expectedName}`,
    );
    for (const target of mandatoryWorkspaceTargets) {
      assert(
        typeof manifest.scripts?.[target] === "string" &&
          manifest.scripts[target].trim().length > 0,
        `${expectedName} is missing mandatory Nx/package target: ${target}`,
      );
    }

    auditProjectCache({ manifest, nx, relativePath, expectedName });
    if (manifest.scripts.build.includes("clean-workspace.mjs")) {
      const cleanerInvocations = [
        ...manifest.scripts.build.matchAll(/clean-workspace\.mjs/gu),
      ];
      const scopedCleanerInvocations = [
        ...manifest.scripts.build.matchAll(
          /clean-workspace\.mjs\s+--build-outputs(?=\s*(?:&&|\|\||;|$))/gu,
        ),
      ];
      assert(
        cleanerInvocations.length === scopedCleanerInvocations.length,
        `${expectedName} build cleanup must preserve other target outputs`,
      );
    }

    const tsconfigPath = resolve(workspaceRoot, relativePath, "tsconfig.json");
    assert(
      existsSync(tsconfigPath),
      `${expectedName} is missing tsconfig.json`,
    );
    const tsconfig = readJson(tsconfigPath);
    assert(
      typeof tsconfig.extends === "string" &&
        resolve(workspaceRoot, relativePath, tsconfig.extends) ===
          baseTsconfigPath,
      `${expectedName} tsconfig.json must extend the root tsconfig.base.json`,
    );
    audited.push({ name: expectedName, path: relativePath });
  }

  return audited;
}
