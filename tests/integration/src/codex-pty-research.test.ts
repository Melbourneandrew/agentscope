import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  codexArmPtyResearchHint,
  codexPtyResearchHints,
  extractUntrustedCodexPtyHint,
  failedCodexSessionStartHint,
} from "../codex-pty-research.mjs";

const integrationRoot = resolve(import.meta.dirname, "..");
const stages = [
  "authority",
  "observer",
  "signal",
  "reap",
  "residual",
  "child-join",
  "output-join",
  "transport-close",
  "outer-shutdown",
];

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
    const source = readFileSync(
      resolve(integrationRoot, "codex-pty-research.mjs"),
      "utf8",
    );
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
    const authority = readFileSync(
      resolve(integrationRoot, "immutable-candidate-authority.mjs"),
      "utf8",
    );
    const outer = readFileSync(
      resolve(integrationRoot, "run-scenarios.mjs"),
      "utf8",
    );
    for (const name of ["kernel-errors.js", "kernel-promise.js"])
      expect(authority).toContain(`testkit/internal/${name}`);
    expect(outer).toContain("for (const file of selectedRuntimeFiles)");
    expect(outer).toContain("codex-pty-research.mjs");
  });
});
