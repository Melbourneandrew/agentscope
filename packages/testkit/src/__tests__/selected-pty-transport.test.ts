import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import type { HeadlessExecutionRequest } from "../headless-supervisor-contract.js";
import { executeSelectedPtyProcess } from "../headless-supervisor-kernel.js";
import type { HeadlessSupervisorCapability } from "../headless-supervisor.js";
import type { SelectedPtyExecutionRequest } from "../pty-terminal-contract.js";
import { executeSelectedPtyTransportForTest } from "../internal/headless-supervisor-backend.js";

const sha256 = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const request = (
  overrides: Partial<HeadlessExecutionRequest> = {},
): SelectedPtyExecutionRequest => {
  const now = performance.now();
  return {
    initialGeometry: { columns: 40, rows: 12 },
    process: {
      runId: "0123456789abcdef",
      requestFingerprint: sha256("selected-pty-request"),
      executable: "/scenario/installed-cli-driver",
      arguments: ["narrow-terminal"],
      cwd: "/scenario",
      environment: { LANG: "C.UTF-8" },
      stdin: new Uint8Array([121, 101, 115, 10]),
      stdoutLimitBytes: 4_096,
      stderrLimitBytes: 4_096,
      monotonicStartupDeadlineMs: now + 100,
      monotonicExecutionDeadlineMs: now + 200,
      monotonicShutdownDeadlineMs: now + 700,
      terminationGraceMs: 50,
      ...overrides,
    },
  };
};

describe("selected PTY transport", () => {
  it("binds real PTY geometry and returns only bounded semantic evidence", async () => {
    const receipt = await executeSelectedPtyTransportForTest(
      request(),
      "clean",
    );
    expect(receipt).toMatchObject({
      receiptVersion: 1,
      isTTY: true,
      initialGeometry: { columns: 40, rows: 12 },
      observedGeometry: { columns: 40, rows: 12 },
      cleanup: "clean",
      processJoined: true,
      residualProcessCount: 0,
      terminalInputJoined: true,
      terminalOutputJoined: true,
      terminalTransportClosed: true,
    });
    expect(receipt.outputBytes).toBe(5);
    expect(receipt.outputSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(receipt)).not.toContain("ready");
  });

  it.each([
    ["geometry-substitution", "testkit.pty.geometry"],
    ["missing-witness", "testkit.pty.geometry"],
    ["identity-substitution", "testkit.headless.observer.identity"],
    ["residual", "testkit.headless.reconciliation.deadline"],
    ["root-missing", "testkit.headless.observer.root"],
  ] as const)("fails closed for %s", async (seed, code) => {
    await expect(
      executeSelectedPtyTransportForTest(request(), seed),
    ).rejects.toMatchObject({ code });
  });

  it("bounds terminal output and joins the selected process authority", async () => {
    const receipt = await executeSelectedPtyTransportForTest(
      request({ stdoutLimitBytes: 16 }),
      "output-limit",
    );
    expect(receipt).toMatchObject({
      cleanup: "clean",
      exitCode: null,
      processJoined: true,
      signal: "SIGTERM",
    });
  });

  it("applies the one absolute deadline and terminates a hung PTY process", async () => {
    const now = performance.now();
    const receipt = await executeSelectedPtyTransportForTest(
      request({
        monotonicStartupDeadlineMs: now + 20,
        monotonicExecutionDeadlineMs: now + 40,
        monotonicShutdownDeadlineMs: now + 300,
        terminationGraceMs: 20,
      }),
      "timeout",
    );
    expect(receipt).toMatchObject({
      cleanup: "clean",
      exitCode: null,
      processJoined: true,
      signal: "SIGTERM",
    });
  });

  it("does not let callers mint selected PTY authority", async () => {
    await expect(
      executeSelectedPtyProcess({} as HeadlessSupervisorCapability, request()),
    ).rejects.toMatchObject({ code: "testkit.headless.capability" });
  });

  it("rejects extra request fields and substituted geometry", async () => {
    const valid = request();
    await expect(
      executeSelectedPtyTransportForTest(
        { ...valid, extra: true } as SelectedPtyExecutionRequest,
        "clean",
      ),
    ).rejects.toMatchObject({ code: "testkit.pty.request" });
    await expect(
      executeSelectedPtyTransportForTest(
        { ...valid, initialGeometry: { columns: 0, rows: 12 } },
        "clean",
      ),
    ).rejects.toMatchObject({ code: "testkit.pty.geometry" });
  });
});
