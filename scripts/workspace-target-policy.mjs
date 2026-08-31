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
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
  const sharedGlobals = new Set(nx.namedInputs?.sharedGlobals ?? []);
  for (const input of requiredSharedGlobals) {
    assert(sharedGlobals.has(input), `nx sharedGlobals is missing ${input}`);
  }
  for (const target of mandatoryWorkspaceTargets) {
    assert(
      nx.targetDefaults?.[target] !== undefined,
      `nx targetDefaults is missing ${target}`,
    );
  }
  assert(nx.targetDefaults?.clean?.cache === false, "clean must not be cached");
  for (const target of ["lint", "test", "coverage"]) {
    const dependencies = nx.targetDefaults?.[target]?.dependsOn;
    assert(
      Array.isArray(dependencies) &&
        dependencies.length === 1 &&
        dependencies[0] === "build",
      `nx ${target} must depend on its own settled build`,
    );
  }

  const audited = [];
  for (const [relativePath, expectedName] of expectedPackages) {
    const manifestPath = resolve(workspaceRoot, relativePath, "package.json");
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
