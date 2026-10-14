import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import type { SelectedPtyExecutionRequest } from "../pty-terminal-contract.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const request = (): SelectedPtyExecutionRequest => {
  const challenge = "a".repeat(64);
  const input = (value: string) => ({
    action: "input" as const,
    byteLength: Buffer.byteLength(value),
    inputSha256: digest(value),
  });
  const paste = `\u001b[200~${"x".repeat(55)}\u001b[201~`;
  const enter = "\u001b[13u";
  return {
    completion: { kind: "semantic-marker" },
    readiness: {
      kind: "challenge-styled-text",
      challenge,
      text: "›",
      requiredText: "Ask Codex to do anything",
      postSubmissionResponseText: `AGENTSCOPE_CODEX_RESPONSE:${challenge}`,
      requiredTerminalProtocol: "csi-u-flags-7-query-v1",
      bold: true,
      dim: false,
    },
    interaction: {
      trigger: "immediate",
      actions: [
        input(`${challenge}\n`),
        {
          action: "checkpoint-process-topology",
          topology: "root-with-contained-process-set",
        },
        input(paste),
        input(enter),
        { action: "wait-for-semantic-completion" },
        input("\u0004"),
      ],
    },
    initialGeometry: { columns: 100, rows: 30 },
    interpreter: {
      path: "/usr/local/bin/node",
      sha256: digest("node-interpreter"),
    },
    process: {
      runId: "0123456789abcdef",
      requestFingerprint: `sha256:${digest("selected-pty-request")}`,
      executable: "/scenario/installed-cli-driver",
      arguments: ["narrow-terminal"],
      cwd: "/scenario",
      environment: { LANG: "C.UTF-8" },
      stdin: new TextEncoder().encode(`${challenge}\n${paste}${enter}\u0004`),
      stdoutLimitBytes: 4096,
      stderrLimitBytes: 4096,
      monotonicStartupDeadlineMs: 50,
      monotonicExecutionDeadlineMs: 100,
      monotonicShutdownDeadlineMs: 500,
      terminationGraceMs: 50,
    },
    scriptSha256: digest("installed-cli-driver"),
  };
};

const execute = async (
  seed:
    | "checkpoint-stop-redraw"
    | "checkpoint-stop-pending"
    | "checkpoint-stop-never",
  abort = false,
) => {
  vi.resetModules();
  vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "clearTimeout"] });
  const clock = vi
    .spyOn(performance, "now")
    .mockImplementation(() => vi.getMockedSystemTime()!.getTime());
  let settlement: Promise<unknown> | undefined;
  try {
    const { executeSelectedPtyTransportForTest: run } =
      await import("../internal/headless-supervisor-backend.js");
    const controller = new AbortController();
    const execution = run(request(), seed, { signal: controller.signal });
    settlement = execution.catch(() => undefined);
    if (abort)
      setTimeout(() => {
        controller.abort();
      }, 10);
    for (let step = 0; step < 15; step += 1)
      await vi.advanceTimersByTimeAsync(10);
    const receipt = await execution;
    expect(vi.getTimerCount()).toBe(0);
    return receipt;
  } finally {
    try {
      await vi.runAllTimersAsync();
      await settlement;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
      vi.resetModules();
    }
  }
};

describe("admitted checkpoint settlement after buffered redraw", () => {
  it("settles pending stops before the original cutoff without admitting stale input", async () => {
    const receipt = await execute("checkpoint-stop-redraw");
    // The checkpoint settles, but the buffered clear still denies later
    // input. Completing a stop is not historical prompt/input authority.
    expect(receipt).toMatchObject({
      outcome: "timeout",
      readinessObserved: false,
      checkpointProgressDiagnostic: "advanced",
      inputBytesWritten: 65,
      actions: [
        { action: "input", byteLength: 65 },
        { action: "checkpoint-process-topology", monotonicAtMs: 20 },
      ],
      cleanup: "clean",
      processJoined: true,
    });
    expect(receipt.pumpFailureDiagnostic).toBeUndefined();
    expect(receipt.actions[1]!.monotonicAtMs).toBeLessThan(100);
  });
  it("admits later input only after a fresh live redraw following exact release", async () => {
    const receipt = await execute("checkpoint-stop-pending");
    expect(receipt).toMatchObject({
      outcome: "completed",
      cleanup: "clean",
      checkpointProgressDiagnostic: "advanced",
      processJoined: true,
      actions: [
        { action: "input", byteLength: 65 },
        { action: "checkpoint-process-topology", monotonicAtMs: 20 },
        { action: "input", byteLength: 67 },
        { action: "input", byteLength: 5 },
        { action: "wait-for-semantic-completion" },
        { action: "input", byteLength: 1 },
      ],
    });
    expect(receipt.pumpFailureDiagnostic).toBeUndefined();
  });
  it.each([false, true])(
    "joins pending stops without later actions (abort=%s)",
    async (abort) => {
      const receipt = await execute("checkpoint-stop-never", abort);
      expect(receipt).toMatchObject({
        outcome: abort ? "aborted" : "timeout",
        cleanup: "clean",
        processJoined: true,
        residualProcessCount: 0,
        inputBytesWritten: 65,
        actions: [{ action: "input", byteLength: 65 }],
      });
      expect(receipt.pumpFailureDiagnostic).toBeUndefined();
    },
  );
});
