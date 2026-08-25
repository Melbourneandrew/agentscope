import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  auditCodeQualityPolicy,
  auditCoverageRatchet,
} from "../code-quality-policy.mjs";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
// Typed ESLint cold starts measured 19.6s under 12-of-16-core load. This is a
// subprocess phase ceiling, not a retry or a workspace-wide test timeout.
const eslintPolicyPhaseDeadlineMs = 25_000;
const eslintPolicyTerminationGraceMs = 250;
const eslintPolicyTeardownDeadlineMs = 750;
const eslintPolicyTestDeadlineMs = eslintPolicyPhaseDeadlineMs + 1_000;
const eslintPolicyPerStreamBytes = 512 * 1024;
const eslintPolicyAggregateBytes = 768 * 1024;

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function processGroupIsAbsent(pid) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
}

function policyProcessError(message, reapConfirmed) {
  const error = new Error(message);
  error.reapConfirmed = reapConfirmed;
  return error;
}

function collectBoundedProcessOutput(
  child,
  perStreamBytes,
  aggregateBytes,
  onOverflow,
) {
  const stdout = { bytes: 0, chunks: [] };
  const stderr = { bytes: 0, chunks: [] };
  let aggregateOutputBytes = 0;
  const append = (stream, chunk) => {
    const nextStreamBytes = stream.bytes + chunk.length;
    const nextAggregateBytes = aggregateOutputBytes + chunk.length;
    if (
      nextStreamBytes > perStreamBytes ||
      nextAggregateBytes > aggregateBytes
    ) {
      onOverflow();
      return;
    }
    stream.bytes = nextStreamBytes;
    aggregateOutputBytes = nextAggregateBytes;
    stream.chunks.push(chunk);
  };
  child.stdout.on("data", (chunk) => append(stdout, chunk));
  child.stderr.on("data", (chunk) => append(stderr, chunk));
  return () => ({
    stdout: Buffer.concat(stdout.chunks).toString("utf8"),
    stderr: Buffer.concat(stderr.chunks).toString("utf8"),
  });
}

function runPolicyProcess({
  command,
  args,
  cwd,
  phaseDeadlineMs,
  perStreamBytes,
  aggregateBytes,
  diagnosticName,
}) {
  if (process.platform === "win32") {
    throw policyProcessError(
      `${diagnosticName} requires POSIX process-group authority`,
      true,
    );
  }
  const startedAt = performance.now();
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let terminationReason;
    let killSent = false;
    let childClosed = false;
    let settled = false;
    let killTimer;
    let reapTimer;
    let teardownTimer;

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(phaseTimer);
      clearTimeout(killTimer);
      clearInterval(reapTimer);
      clearTimeout(teardownTimer);
      callback(value);
    };
    const terminationMessage = () => {
      const elapsedMs = Math.ceil(performance.now() - startedAt);
      return terminationReason === "output"
        ? `${diagnosticName} output exceeded its byte ceiling; process group reaped`
        : `${diagnosticName} exceeded its ${phaseDeadlineMs}ms phase deadline; process group reaped after ${elapsedMs}ms`;
    };
    const confirmReap = () => {
      if (!killSent || !childClosed) return;
      let groupAbsent;
      try {
        groupAbsent = processGroupIsAbsent(child.pid);
      } catch {
        settle(
          rejectResult,
          policyProcessError(
            `${diagnosticName} teardown could not inspect process-group reap`,
            false,
          ),
        );
        return;
      }
      if (groupAbsent) {
        settle(rejectResult, policyProcessError(terminationMessage(), true));
      }
    };
    const beginTermination = (reason) => {
      if (terminationReason) return;
      terminationReason = reason;
      child.stdout.destroy();
      child.stderr.destroy();
      signalProcessGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        signalProcessGroup(child.pid, "SIGKILL");
        killSent = true;
        confirmReap();
        reapTimer = setInterval(confirmReap, 10);
      }, eslintPolicyTerminationGraceMs);
      teardownTimer = setTimeout(() => {
        settle(
          rejectResult,
          policyProcessError(
            `${diagnosticName} teardown did not confirm process-group reap within ${eslintPolicyTeardownDeadlineMs}ms`,
            false,
          ),
        );
      }, eslintPolicyTeardownDeadlineMs);
    };
    const collectedOutput = collectBoundedProcessOutput(
      child,
      perStreamBytes,
      aggregateBytes,
      () => beginTermination("output"),
    );

    const phaseTimer = setTimeout(
      () => beginTermination("deadline"),
      phaseDeadlineMs,
    );

    child.once("error", () => {
      if (terminationReason) return;
      settle(
        rejectResult,
        policyProcessError(`${diagnosticName} process failed to start`, true),
      );
    });
    child.once("close", (status, signal) => {
      childClosed = true;
      if (terminationReason) {
        confirmReap();
        return;
      }
      settle(resolveResult, {
        status,
        signal,
        ...collectedOutput(),
      });
    });
  });
}

function runEslintPolicySeed(path) {
  return runPolicyProcess({
    command: "pnpm",
    args: ["exec", "eslint", path, "--max-warnings=0"],
    cwd: repositoryRoot,
    phaseDeadlineMs: eslintPolicyPhaseDeadlineMs,
    perStreamBytes: eslintPolicyPerStreamBytes,
    aggregateBytes: eslintPolicyAggregateBytes,
    diagnosticName: "ESLint policy",
  });
}

function signalResistantProcessTreeScript(pidPath, output = "") {
  return [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });',
    `writeFileSync(${JSON.stringify(pidPath)}, process.pid + "\\n" + child.pid + "\\n");`,
    'process.on("SIGTERM", () => {});',
    output ? `process.stdout.write(${JSON.stringify(output)});` : "",
    "setInterval(() => {}, 1000);",
  ].join("\n");
}

function assertProcessIdsAbsent(pidPath) {
  const pids = readFileSync(pidPath, "utf8").trim().split("\n").map(Number);
  assert.equal(pids.length, 2);
  for (const pid of pids) {
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error?.code === "ESRCH",
    );
  }
}

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

test(
  "test linting rejects package boundaries, duplicate imports, unsafe values, floating promises, and excessive complexity",
  async () => {
    const path = join(
      repositoryRoot,
      "packages/protocol/src/quality-seed.test.ts",
    );
    const branches = Array.from(
      { length: 31 },
      (_, index) => `  if (value === ${index}) value += 1;`,
    ).join("\n");
    let cleanupAllowed = true;
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
      const result = await runEslintPolicySeed(path);
      const output = `${result.stdout}${result.stderr}`;
      assert.notEqual(result.status, 0);
      assert.match(
        output,
        /no-unsafe-(?:assignment|call|member-access|return)/,
      );
      assert.match(output, /no-floating-promises/);
      assert.match(output, /complexity/);
      assert.match(output, /no-restricted-imports/);
      assert.match(output, /import-x\/no-duplicates/);
    } catch (error) {
      cleanupAllowed = error?.reapConfirmed !== false;
      throw error;
    } finally {
      if (cleanupAllowed) rmSync(path, { force: true });
    }
  },
  eslintPolicyTestDeadlineMs,
);

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

test(
  "lint rejects Protocol finalization authority outside Core",
  async () => {
    const path = join(
      repositoryRoot,
      "packages/destinations/core/src/finalization-seed.test.ts",
    );
    let cleanupAllowed = true;
    try {
      writeFileSync(
        path,
        'import { finalizeRedactedCanonicalTrace } from "@agentscope/protocol/core-finalization";\nvoid finalizeRedactedCanonicalTrace;\n',
      );
      const result = await runEslintPolicySeed(path);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /no-restricted-imports/);
      assert.match(`${result.stdout}${result.stderr}`, /Only Core/);
    } catch (error) {
      cleanupAllowed = error?.reapConfirmed !== false;
      throw error;
    } finally {
      if (cleanupAllowed) rmSync(path, { force: true });
    }
  },
  eslintPolicyTestDeadlineMs,
);

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

test("policy timeout waits for child close and process-group reap before seed cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-policy-timeout-"));
  const pidPath = join(root, "pids");
  const seedPath = join(root, "quality-seed.test.ts");
  writeFileSync(seedPath, "export const seed = true;\n");
  let cleanupAllowed = true;
  let failure;
  try {
    failure = await runPolicyProcess({
      command: process.execPath,
      args: ["-e", signalResistantProcessTreeScript(pidPath)],
      cwd: repositoryRoot,
      phaseDeadlineMs: 1_000,
      perStreamBytes: 1_024,
      aggregateBytes: 1_536,
      diagnosticName: "Policy timeout regression",
    }).then(
      () => assert.fail("signal-resistant policy process unexpectedly exited"),
      (error) => error,
    );
  } catch (error) {
    cleanupAllowed = error?.reapConfirmed !== false;
    throw error;
  } finally {
    if (cleanupAllowed) rmSync(seedPath, { force: true });
  }
  assert.equal(failure.reapConfirmed, true);
  assert.match(failure.message, /phase deadline; process group reaped/);
  assert.equal(existsSync(seedPath), false);
  assertProcessIdsAbsent(pidPath);
  rmSync(root, { recursive: true, force: true });
});

test("policy output overflow is content-free and reaps the process group", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-policy-output-"));
  const pidPath = join(root, "pids");
  const sensitiveOutput = "SENSITIVE_POLICY_OUTPUT".repeat(4_096);
  try {
    const failure = await runPolicyProcess({
      command: process.execPath,
      args: ["-e", signalResistantProcessTreeScript(pidPath, sensitiveOutput)],
      cwd: repositoryRoot,
      phaseDeadlineMs: 2_000,
      perStreamBytes: 1_024,
      aggregateBytes: 1_536,
      diagnosticName: "Policy output regression",
    }).then(
      () => assert.fail("overflowing policy process unexpectedly exited"),
      (error) => error,
    );
    assert.equal(failure.reapConfirmed, true);
    assert.equal(
      failure.message,
      "Policy output regression output exceeded its byte ceiling; process group reaped",
    );
    assert.doesNotMatch(failure.message, /SENSITIVE_POLICY_OUTPUT/);
    assertProcessIdsAbsent(pidPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
