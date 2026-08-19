import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  auditCodeQualityPolicy,
  auditCoverageRatchet,
} from "../code-quality-policy.mjs";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);

function createPackage(root, path, name, dependencies = {}) {
  const packageRoot = join(root, path);
  mkdirSync(join(packageRoot, "src/__tests__"), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name,
      type: "module",
      exports: "./dist/index.js",
      dependencies,
      scripts: {
        test: "vitest run",
        coverage: "vitest run --coverage",
      },
    }),
  );
  writeFileSync(join(packageRoot, "src/index.ts"), "export const value = 1;\n");
  writeFileSync(
    join(packageRoot, "src/__tests__/index.test.ts"),
    'import { test } from "vitest";\ntest("value", () => {});\n',
  );
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentscope-quality-policy-"));
  createPackage(root, "packages/a", "@agentscope/a");
  createPackage(root, "packages/b", "@agentscope/b", {
    "@agentscope/a": "workspace:*",
  });
  return {
    root,
    workspaceRoot: root,
    expectedPackages: new Map([
      ["packages/a", "@agentscope/a"],
      ["packages/b", "@agentscope/b"],
    ]),
    policy: {
      version: 1,
      packages: {
        "packages/a": {
          role: "protocol-root",
          unitTests: "required",
          coverage: { statements: 70, branches: 60, functions: 70, lines: 70 },
        },
        "packages/b": {
          role: "consumer",
          unitTests: "required",
          coverage: { statements: 70, branches: 60, functions: 70, lines: 70 },
        },
      },
    },
  };
}

test("rejects package-private source imports", () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.root, "packages/b/src/index.ts"),
      'export { value } from "@agentscope/a/src/index.js";\n',
    );
    assert.throws(() => auditCodeQualityPolicy(value), /private source/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects workspace dependency cycles", () => {
  const value = fixture();
  try {
    const manifestPath = join(value.root, "packages/a/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dependencies = { "@agentscope/b": "workspace:*" };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => auditCodeQualityPolicy(value), /dependency cycle/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects production packages without real tests", () => {
  const value = fixture();
  try {
    rmSync(join(value.root, "packages/b/src/__tests__"), {
      recursive: true,
      force: true,
    });
    assert.throws(() => auditCodeQualityPolicy(value), /no unit tests/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects dead production modules outside public entry graphs", () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.root, "packages/b/src/orphan.ts"),
      "export const orphan = true;\n",
    );
    assert.throws(
      () => auditCodeQualityPolicy(value),
      /Dead production module/,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects source module cycles", () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.root, "packages/b/src/index.ts"),
      'export { nested } from "./nested.js";\n',
    );
    writeFileSync(
      join(value.root, "packages/b/src/nested.ts"),
      'export { value as nested } from "./index.js";\n',
    );
    assert.throws(() => auditCodeQualityPolicy(value), /Source module cycle/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects coverage threshold decreases", () => {
  const value = fixture();
  const baseline = structuredClone(value.policy);
  value.policy.packages["packages/a"].coverage.lines = 69;
  assert.throws(
    () => auditCoverageRatchet(value.policy, baseline),
    /coverage.lines may not decrease/,
  );
  rmSync(value.root, { recursive: true, force: true });
});

test("test linting rejects package boundaries, duplicate imports, unsafe values, floating promises, and excessive complexity", () => {
  const path = join(
    repositoryRoot,
    "packages/protocol/src/quality-seed.test.ts",
  );
  const branches = Array.from(
    { length: 31 },
    (_, index) => `  if (value === ${index}) value += 1;`,
  ).join("\n");
  try {
    writeFileSync(
      path,
      [
        'import { agentscope } from "@agentscope/core";',
        'import { AgentTraceSpecVersion } from "@agentscope/core";',
        "declare function unsafeValue(): any;",
        "async function violation(value: number) {",
        "  const unsafe = unsafeValue();",
        "  Promise.resolve(value);",
        branches,
        "  return unsafe.member;",
        "}",
        "void agentscope;",
        "void AgentTraceSpecVersion;",
        "void violation(0);",
        "",
      ].join("\n"),
    );
    const result = spawnSync(
      "pnpm",
      ["exec", "eslint", path, "--max-warnings=0"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /no-unsafe-(?:assignment|call|member-access|return)/);
    assert.match(output, /no-floating-promises/);
    assert.match(output, /complexity/);
    assert.match(output, /no-restricted-imports/);
    assert.match(output, /import-x\/no-duplicates/);
  } finally {
    rmSync(path, { force: true });
  }
}, 10_000);

test("Prettier rejects a seeded formatting violation", () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-format-seed-"));
  const path = join(root, "bad.ts");
  try {
    writeFileSync(path, "export const badlyFormatted={value:1}\n");
    const result = spawnSync("pnpm", ["exec", "prettier", "--check", path], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /Code style issues/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lint rejects Protocol finalization authority outside Core", () => {
  const path = join(
    repositoryRoot,
    "packages/destinations/core/src/finalization-seed.test.ts",
  );
  try {
    writeFileSync(
      path,
      'import { finalizeRedactedCanonicalTrace } from "@agentscope/protocol/core-finalization";\nvoid finalizeRedactedCanonicalTrace;\n',
    );
    const result = spawnSync(
      "pnpm",
      ["exec", "eslint", path, "--max-warnings=0"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /no-restricted-imports/);
    assert.match(`${result.stdout}${result.stderr}`, /Only Core/);
  } finally {
    rmSync(path, { force: true });
  }
});

test("Vitest coverage rejects a seeded untested production module", () => {
  const path = join(repositoryRoot, "packages/testkit/src/coverage-seed.ts");
  try {
    writeFileSync(
      path,
      Array.from(
        { length: 120 },
        (_, index) => `export const uncovered${index} = () => ${index};`,
      ).join("\n"),
    );
    const result = spawnSync(
      "pnpm",
      ["--filter", "@agentscope/testkit", "coverage"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ERROR: Coverage for/);
  } finally {
    rmSync(path, { force: true });
  }
});
