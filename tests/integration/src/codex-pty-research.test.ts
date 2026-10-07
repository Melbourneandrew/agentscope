import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  codexArmPtyResearchHint,
  codexPtyResearchHints,
  extractUntrustedCodexPtyHint,
  failedCodexSessionStartHint,
  projectUntrustedCodexPtyReceipt,
  validUntrustedCodexPtyReceipt,
} from "../codex-pty-research.mjs";
// Private integration JavaScript deliberately publishes no package declaration.
// @ts-expect-error no declaration file is published for this private module
import * as privateAuthority from "../immutable-candidate-authority.mjs";

const { codexFailureExitPair } = privateAuthority as {
  codexFailureExitPair: (
    fixture: unknown,
    container: unknown,
    scenario: string,
  ) => string | undefined;
};

const integrationRoot = resolve(import.meta.dirname, "..");
const readIntegration = (name: string): string =>
  readFileSync(resolve(integrationRoot, name), "utf8");

describe("returned receipt failure research retention", () => {
  it.each([
    "completed",
    "signaled",
    "exited-nonzero",
    "aborted",
    "timeout",
    "output-limit",
    "transport-failed",
    "input-incomplete",
  ])("retains only closed %s observations, not receipt content", (outcome) => {
    const result = projectUntrustedCodexPtyReceipt({
      outcome,
      checkpointProgressDiagnostic: "advanced",
      exitCode: null,
      finalSnapshot: { text: "private content" },
      privatePath: "/private/canary",
    });
    expect(result).toEqual({
      outcome,
      checkpointProgressDiagnostic: "advanced",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(validUntrustedCodexPtyReceipt(result)).toBe(true);
    expect(codexFailureExitPair(null, 1, "codex-tui-trace-smoke")).toBe(
      "none:1",
    );
  });
  it.each([
    "not-requested",
    "no-live-readiness",
    "terminal-order-rejected",
    "terminal-reply-unsettled",
    "protocol-not-ready",
    "deadline",
    "ready-gate-other",
    "ready-gate-open",
    "topology-root-missing",
    "topology-nonroot-missing",
    "topology-identity-conflict",
    "publication-unsettled",
    "advanced",
  ])(
    "retains the existing fixed %s checkpoint without inferring hook absence",
    (checkpointProgressDiagnostic) => {
      expect(
        projectUntrustedCodexPtyReceipt({
          outcome: "timeout",
          checkpointProgressDiagnostic,
        }),
      ).toEqual({ outcome: "timeout", checkpointProgressDiagnostic });
    },
  );
  it("distinguishes an absent receipt from a null-exit receipt", () => {
    expect(projectUntrustedCodexPtyReceipt(undefined)).toBeUndefined();
    expect(
      projectUntrustedCodexPtyReceipt({ outcome: "timeout", exitCode: null }),
    ).toEqual({ outcome: "timeout", checkpointProgressDiagnostic: null });
    for (const value of [
      undefined,
      null,
      "private",
      { outcome: "private" },
      { outcome: "timeout", checkpointProgressDiagnostic: "private" },
    ])
      expect(projectUntrustedCodexPtyReceipt(value)).toBeUndefined();
  });
  it("rejects accessors, substituted types and extra retained fields", () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, "outcome", {
      get: () => {
        reads += 1;
        throw new Error("private");
      },
    });
    expect(projectUntrustedCodexPtyReceipt(accessor)).toBeUndefined();
    expect(reads).toBe(0);
    const valid = { outcome: "timeout", checkpointProgressDiagnostic: null };
    for (const value of [
      undefined,
      [],
      accessor,
      { ...valid, extra: "private" },
      Object.defineProperty({ ...valid }, "extra", { value: "private" }),
      { ...valid, outcome: "private" },
      { ...valid, checkpointProgressDiagnostic: 1 },
    ])
      expect(validUntrustedCodexPtyReceipt(value)).toBe(false);
    expect(validUntrustedCodexPtyReceipt(null)).toBe(true);
  });
});
const stages = [
  "authority",
  "observer",
  "observer-read",
  "observer-stat",
  "observer-esrch",
  "observer-permission",
  "observer-io",
  "observer-namespace",
  "observer-identity",
  "observer-graph",
  "observer-root-reuse",
  "observer-target-reuse",
  "observer-zombie-before",
  "observer-zombie-after",
  "signal",
  "reap",
  "residual",
  "child-join",
  "output-join",
  "transport-close",
  "outer-shutdown",
];

describe("runner failure boundary research", () => {
  it.each([
    "arm-pty-before-call",
    "arm-pty-receipt-processing",
    "arm-pty-returned-failed",
  ])("retains the fixed %s boundary without raw error content", (hint) => {
    expect(
      extractUntrustedCodexPtyHint(
        `integration.runner.untrusted-pty-hint:${hint}\n`,
      ),
    ).toBe(hint);
  });

  it("executes the actual catch independently of late or unreadable phase markers", async () => {
    const source = readIntegration("runner.mjs");
    const start = source.indexOf("    let receipt;\n");
    const end = source.indexOf("    const returnedAtMs =", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const boundary = source.slice(start, end);
    for (const scenarioId of ["codex-tui-trace-smoke", "other-scenario"])
      for (const rejects of [true, false]) {
        let phaseReads = 0;
        const result = await (runInNewContext(
          `(async () => { let codexPtyFailureHint; let caught; try { ${boundary} } catch (error) { caught = error; } return { hint: codexPtyFailureHint, caught }; })()`,
          {
            scenarioId,
            headlessCapability: {},
            completion: {},
            readiness: {},
            initialGeometry: {},
            interaction: {},
            interpreter: {},
            request: {},
            scriptSha256: "",
            executeSelectedPtyProcess: () =>
              rejects
                ? Promise.reject(
                    new Error("testkit.headless.reconciliation.deadline"),
                  )
                : Promise.resolve({}),
            readPtyReconciliationStage: () => "observer",
            codexArmPtyResearchHint,
            retainedInteractivePhase: () => {
              phaseReads += 1;
              throw new Error("unreadable phase marker");
            },
          },
          { timeout: 1000 },
        ) as Promise<{ hint?: string; caught?: Error }>);
        expect(phaseReads).toBe(0);
        expect(result.hint).toBe(
          scenarioId !== "codex-tui-trace-smoke"
            ? undefined
            : rejects
              ? "arm-pty-observer"
              : "arm-pty-receipt-processing",
        );
        expect(result.caught?.message).toBe(
          rejects ? "testkit.headless.reconciliation.deadline" : undefined,
        );
      }
  });

  it("emits only on failure and before fallible retained-state snapshots", () => {
    const source = readIntegration("runner.mjs");
    const failure = source.indexOf(
      'if (scenario.executionMode === "interactive" && fixtureFailure !== undefined) {',
    );
    const hint = source.indexOf("emitCodexPtyFailureHint();", failure);
    const snapshot = source.indexOf("const configHint =", failure);
    expect(failure).toBeGreaterThan(0);
    expect(hint).toBeGreaterThan(failure);
    expect(snapshot).toBeGreaterThan(hint);
    expect(source).toContain("} catch (error) {\n  emitCodexPtyFailureHint();");
    expect(
      source.match(/integration\.runner\.untrusted-pty-hint:/gu),
    ).toHaveLength(1);
    expect(source).toContain(
      'scenarioId === "codex-tui-trace-smoke" ? "arm-pty-before-call" : undefined',
    );
    const failedReceipt = source.indexOf(
      "if (interactivePtyReceiptFailed(receipt)) {",
    );
    expect(
      source.indexOf(
        'codexPtyFailureHint = "arm-pty-returned-failed";',
        failedReceipt,
      ),
    ).toBeLessThan(
      source.indexOf("retainedInteractivePhase(ledger)", failedReceipt),
    );
  });

  it("emits the actual fixed boundary only once despite later snapshot failure", () => {
    const source = readIntegration("runner.mjs");
    const start = source.indexOf("const emitCodexPtyFailureHint =");
    const end = source.indexOf("const recoverRetainedFixtureOutput =", start);
    for (const hint of [
      undefined,
      "arm-pty-before-call",
      "arm-pty-receipt-processing",
      "arm-pty-returned-failed",
      "arm-pty-observer",
    ]) {
      const output: string[] = [];
      runInNewContext(
        `let codexPtyFailureHint = initial; ${source.slice(start, end)} emitCodexPtyFailureHint(); try { throw new Error('snapshot unavailable'); } catch {} emitCodexPtyFailureHint();`,
        {
          initial: hint,
          process: { stdout: { write: (line: string) => output.push(line) } },
        },
        { timeout: 1000 },
      );
      expect(output).toEqual(
        hint === undefined
          ? []
          : [`integration.runner.untrusted-pty-hint:${hint}\n`],
      );
    }
  });
});

describe("best-effort runner diagnostic output", () => {
  it("preserves primary failure and never repeats a failed write", () => {
    const source = readIntegration("runner.mjs");
    const start = source.indexOf("const emitCodexPtyFailureHint =");
    const end = source.indexOf("const recoverRetainedFixtureOutput =", start);
    let attempts = 0;
    const primary = new Error("original primary failure");
    const result = runInNewContext(
      `let codexPtyFailureHint = 'arm-pty-observer'; ${source.slice(start, end)} try { throw primary; } catch (error) { emitCodexPtyFailureHint(); emitCodexPtyFailureHint(); caught = error; }`,
      {
        primary,
        process: {
          stdout: {
            write: () => {
              attempts += 1;
              throw new Error("diagnostic write failed");
            },
          },
        },
      },
      { timeout: 1000 },
    ) as unknown;
    expect(result).toBe(primary);
    expect(attempts).toBe(1);
  });
});

describe("failed PTY research categories", () => {
  it.each(stages)("retains only the closed %s category", (stage) => {
    const hint = codexArmPtyResearchHint(
      new Error("testkit.headless.reconciliation.deadline"),
      stage,
    );
    expect(hint).toBe(`arm-pty-${stage}`);
    expect(
      extractUntrustedCodexPtyHint(
        `integration.runner.untrusted-pty-hint:${hint}\n`,
      ),
    ).toBe(hint);
  });

  it("preserves prior categories and rejects arbitrary stages", () => {
    expect(
      codexArmPtyResearchHint(
        new Error("testkit.headless.reconciliation.deadline"),
      ),
    ).toBe("arm-pty-reconciliation");
    expect(
      codexArmPtyResearchHint(
        new Error("testkit.headless.reconciliation.deadline"),
        "constructor",
      ),
    ).toBe("arm-pty-reconciliation");
    expect(
      codexArmPtyResearchHint(
        new Error("testkit.headless.startup.deadline"),
        "observer",
      ),
    ).toBe("arm-pty-startup");
    expect(codexArmPtyResearchHint(new Error("testkit.pty.failed"))).toBe(
      "arm-pty-transport",
    );
    expect(
      codexArmPtyResearchHint(new Error("testkit.headless.kernel.failure")),
    ).toBe("arm-pty-kernel");
  });

  it("does not expose hostile thrown values", () => {
    const hostile = new Error();
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("private");
      },
    });
    for (const value of [hostile, null, "private", { message: "private" }])
      expect(codexArmPtyResearchHint(value)).toBe("arm-pty-other");
  });

  it("rejects duplicated, malformed, unknown and over-bound retained text", () => {
    const line = "integration.runner.untrusted-pty-hint:arm-pty-observer";
    for (const output of [
      `${line}\n${line}\n`,
      `${line} private`,
      `${line}\r\n`,
      "integration.runner.untrusted-pty-hint:private",
      "x".repeat(16 * 1024 * 1024 + 1),
      null,
    ])
      expect(extractUntrustedCodexPtyHint(output)).toBeUndefined();
    expect(new Set(codexPtyResearchHints).size).toBe(
      codexPtyResearchHints.length,
    );
    expect(
      codexPtyResearchHints.every((hint: string) =>
        /^[a-z-]{1,32}$/u.test(hint),
      ),
    ).toBe(true);
  });

  it("keeps the post-failure snapshot separate from gate admission", async () => {
    const source = readIntegration("codex-pty-research.mjs");
    expect(source).toContain(
      'await import("./runtime/codex-runtime-evidence.mjs")',
    );
    expect(source).toContain("classifyCodexSessionStartAtFailedPty({");
    expect(source).toContain("constants.O_NOFOLLOW");
    expect(source).toContain("constants.O_NONBLOCK");
    expect(source).toContain("closeSync(directoryDescriptor)");
    expect(
      await failedCodexSessionStartHint(
        "/nonexistent-agentscope-research-home",
      ),
    ).toBe("arm-log-invalid");
  });

  it("copies the same diagnostic modules into the immutable runtime graph", () => {
    const authority = readIntegration("immutable-candidate-authority.mjs");
    const outer = readIntegration("run-scenarios.mjs");
    for (const name of [
      "kernel-errors.js",
      "kernel-promise.js",
      "pty-transport-observations.js",
    ])
      expect(authority).toContain(`testkit/internal/${name}`);
    expect(outer).toContain("for (const file of selectedRuntimeFiles)");
    expect(outer).toContain("codex-pty-research.mjs");
  });
});
