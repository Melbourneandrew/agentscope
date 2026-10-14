import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { runInThisContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { SelectedPtyExecutionRequest } from "../pty-terminal-contract.js";
import type { executeSelectedPtyTransportForTest } from "../internal/headless-supervisor-backend.js";

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

type CheckpointCalls = { freeze: number[]; release: number[] };
const observeFailedTerminalBackend = async (counts: CheckpointCalls) => {
  const namespaces = new Map<string, unknown>([
    [
      "../headless-supervisor-contract.js",
      await import("../headless-supervisor-contract.js"),
    ],
    ["./kernel-errors.js", await import("../internal/kernel-errors.js")],
    ["./kernel-promise.js", await import("../internal/kernel-promise.js")],
    [
      "./proc-process-snapshot.js",
      await import("../internal/proc-process-snapshot.js"),
    ],
    [
      "../bounded-terminal-emulator.js",
      await import("../bounded-terminal-emulator.js"),
    ],
    [
      "./pty-transport-observations.js",
      await import("../internal/pty-transport-observations.js"),
    ],
  ]);
  let source = readFileSync(
    new URL("../internal/headless-supervisor-backend.ts", import.meta.url),
    "utf8",
  );
  const stimulus = '"\\u001b[?2026h\\u001b[2J\\u001b[Hloading\\u001b[?2026l"';
  expect(source).toContain(stimulus);
  source = source.replace(stimulus, '"\\u001b[?9999h"');
  source = source.replaceAll(
    "import.meta.dirname",
    JSON.stringify(new URL("../internal", import.meta.url).pathname),
  );
  const freezeAnchor = "checkpointFreezeCalls += 1;";
  const releaseAnchor = "if (notifyRoot) matchedCheckpointResumed = true;";
  expect(source).toContain(freezeAnchor);
  expect(source).toContain(releaseAnchor);
  source = source.replace(
    freezeAnchor,
    `${freezeAnchor} probeCounts.freeze.push(performance.now());`,
  );
  source = source.replace(
    releaseAnchor,
    `probeCounts.release.push(performance.now()); ${releaseAnchor}`,
  );
  const body = transpileModule(source, {
    compilerOptions: {
      target: ScriptTarget.ES2022,
      module: ModuleKind.CommonJS,
    },
  }).outputText;
  const exports: {
    executeSelectedPtyTransportForTest?: typeof executeSelectedPtyTransportForTest;
  } = {};
  const requireNative = createRequire(import.meta.url);
  const evaluate = runInThisContext(
    `(require,exports,probeCounts)=>{${body}}`,
  ) as (
    require: (name: string) => unknown,
    exports: object,
    counts: CheckpointCalls,
  ) => void;
  evaluate(
    (name: string) => namespaces.get(name) ?? (requireNative(name) as unknown),
    exports,
    counts,
  );
  return exports.executeSelectedPtyTransportForTest!;
};

describe("admitted checkpoint settlement after buffered redraw", () => {
  it("does not settle a pending checkpoint while draining a failed terminal", async () => {
    vi.resetModules();
    vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "clearTimeout"] });
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => vi.getMockedSystemTime()!.getTime());
    let settlement: Promise<unknown> | undefined;
    try {
      const counts: CheckpointCalls = { freeze: [], release: [] };
      const run = await observeFailedTerminalBackend(counts);
      const execution = run(request(), "checkpoint-stop-redraw");
      settlement = execution.catch(() => undefined);
      for (let step = 0; step < 15; step += 1)
        await vi.advanceTimersByTimeAsync(10);
      await expect(execution).rejects.toThrow("unsupported");
      // The second true-pump attempt is preexisting. Failure drain may not
      // add a third attempt or release/publish the already pending checkpoint.
      expect(counts.freeze).toEqual([0, 10]);
      expect(counts.release).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
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
  });
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
