import { EventEmitter } from "node:events";
import { Agent, type request as HttpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { projectCodexPostJoinTranscript } from "../codex-runtime-evidence.mjs";
import {
  createCodexModelControlRequest,
  createCodexFailureResearchRecord,
  extractAdapterReportedFailure,
  projectUntrustedCodexPtyReceipt,
  encodeAdapterReportedFailureMarker,
  codexGateResearchHints,
} from "../codex-pty-research.mjs";
// @ts-expect-error private integration module has no published declaration
import * as privateAuthority from "../immutable-candidate-authority.mjs";
const {
  codexFailureExitPair,
  validCodexResearchDiagnostic,
  encodeInteractiveFailureExitCode,
  extractUntrustedCodexGateHint,
  readBoundedInteractiveFailureRecord,
  selectInteractiveFailureDiagnostic,
  codexArmPendingResearchHint,
} = privateAuthority as {
  codexArmPendingResearchHint: (error: unknown) => string;
  readBoundedInteractiveFailureRecord: (
    ledger: string,
    runId: string,
  ) => { predicate: string } | undefined;
  selectInteractiveFailureDiagnostic: (
    marker: unknown,
    phase: unknown,
    selected: unknown,
  ) => string | undefined;
  extractUntrustedCodexGateHint: (output: unknown) => string | undefined;
  codexFailureExitPair: (
    fixture: unknown,
    container: unknown,
    scenario: string,
  ) => string | undefined;
  validCodexResearchDiagnostic: (value: unknown) => boolean;
  encodeInteractiveFailureExitCode: (
    value: string,
    scenario: string,
  ) => number | undefined;
};
const readIntegration = (name: string): string =>
  readFileSync(resolve(import.meta.dirname, "..", name), "utf8");

const codexLiveMetadata = `${JSON.stringify({ type: "session_meta", payload: { id: "synthetic-session" } })}\n`;
const codexLiveTerminal = `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "synthetic-turn", last_agent_message: "synthetic-completion" } })}\n`;
const observeCodexLiveLedger = (
  snapshots: readonly (readonly {
    content: string;
    ino?: number;
    append?: boolean;
    fault?: string;
    utf8?: "split" | "invalid";
  }[])[],
  metrics = { reads: 0, waits: [] as number[], clock: 0 },
): Promise<{ turnId: string; reads: number; baseline: string }> => {
  const scenario = readIntegration("codex-pty-scenario.mjs");
  const evidence = readIntegration("codex-runtime-evidence.mjs");
  const between = (source: string, start: string, end: string): string => {
    const first = source.indexOf(start),
      last = source.indexOf(end, first);
    expect(first).toBeGreaterThan(0);
    expect(last).toBeGreaterThan(first);
    return source.slice(first, last).replaceAll("export ", "");
  };
  return runInNewContext(
    `(() => {
      ${between(evidence, "const plainRecord =", "export const readBoundedJsonResponse")}
      ${between(evidence, "const codexTurnTerminalId =", "export const projectCodexPostJoinTranscript")}
      ${between(evidence, "const sameSnapshotIdentity =", "const openChild =")}
      ${between(evidence, "export const settledCodexLedgerSnapshot =", "export const readCodexSessionLedgers =")}
      ${between(evidence, "export const waitWithinObservationDeadline =", "/**\n * @param {{\n *   deadline:")}
      ${between(scenario, "const recordModelBaseline =", "// Retrieval is provisional.")}
      ${between(scenario, "const waitForCodexTurnTerminal =", "const waitForCodexStopBeforeExit =").replaceAll("readCodexSessionLedgerRecords(", "readRecords(")}
      let codexSessionId, codexLedgerBaseline, reads = 0, clock = 0;
      const expectedAssistantMessage = "synthetic-completion", homeDescriptor = 0;
      const values = JSON.parse(serialized);
      const actualRead = readCodexSessionLedgerRecords;
      let active, statusRead, byteRead;
      const ledgerLimit = 2 * 1024 * 1024, directoryFlags = 0;
      const constants = { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 0 };
      const openChild = (parent, name) => ({'.codex': 1, sessions: 2, '2026': 3, '01': parent === 3 ? 4 : 5}[name] ?? 6);
      const authenticatedEntries = (descriptor) => descriptor === 2 ? ['2026'] : descriptor === 3 || descriptor === 4 ? ['01'] : active.map((_, index) => index === 0 ? 'rollout-synthetic.jsonl' : 'rollout-extra.jsonl');
      const closeSync = () => {};
      const sampleBytes = (value, stage) => value.utf8
        ? Buffer.concat([Buffer.from(value.content), Buffer.from([
            ...(value.utf8 === 'invalid' ? [0xff] : []), 0xe2, ...(stage === 1 ? [0x82] : []),
          ])])
        : Buffer.from(value.content + (value.append && stage === 1 ? '{' : ''));
      const fstatSync = (descriptor) => {
        if (descriptor !== 6) return { isDirectory: () => true };
        const value = active[0], stage = statusRead++;
        return {
          isFile: () => true, dev: 1n, ino: BigInt(value.ino ?? 2),
          mode: value.fault === 'mode' && stage > 0 ? 0o100644n : 0o100600n,
          uid: value.fault === 'owner' && stage > 0 ? 1001n : 1000n, gid: 1000n,
          size: BigInt(sampleBytes(value, stage === 2 ? 1 : 0).length),
          mtimeNs: BigInt(value.append ? stage : 0), ctimeNs: BigInt(value.append ? stage : 0),
        };
      };
      const readCapped = () => {
        const value = active[0], stage = byteRead++;
        return sampleBytes(value, stage);
      };
      const readRecords = (...args) => {
        active = values[Math.min(reads++, values.length - 1)]; statusRead = 0; byteRead = 0;
        metrics.reads = reads;
        return actualRead(...args);
      };
      const bootNow = () => clock;
      const terminalObservationBeforeDeadline = ({observed, deadline, now}) => {
        if (now() >= deadline) throw new Error("integration.codex.trace-deadline");
        return observed;
      };
      const setTimeout = (resolve, milliseconds) => { metrics.waits.push(milliseconds); clock += milliseconds; metrics.clock = clock; resolve(); };
      const remaining = () => {};
      return waitForCodexTurnTerminal(300).then(result => ({
        turnId: result.turnId, reads, baseline: codexLedgerBaseline[0].content,
      }));
    })()`,
    { serialized: JSON.stringify(snapshots), metrics, Buffer, TextDecoder },
    { timeout: 1000 },
  ) as Promise<{ turnId: string; reads: number; baseline: string }>;
};

describe("actual Codex bound live append observation", () => {
  it("waits through an authenticated append and observes the settled terminal within the original deadline", async () => {
    await expect(
      observeCodexLiveLedger([
        [{ content: codexLiveMetadata }],
        [{ content: codexLiveMetadata, append: true }],
        [{ content: codexLiveMetadata + codexLiveTerminal }],
      ]),
    ).resolves.toEqual({
      turnId: "synthetic-turn",
      reads: 3,
      baseline: codexLiveMetadata,
    });
  });
  it("expires an append that never settles at the unchanged 300ms deadline", async () => {
    const metrics = { reads: 0, waits: [] as number[], clock: 0 };
    await expect(
      observeCodexLiveLedger(
        [
          [{ content: codexLiveMetadata }],
          [{ content: codexLiveMetadata, append: true }],
          [{ content: codexLiveMetadata, append: true }],
          [{ content: codexLiveMetadata + codexLiveTerminal }],
        ],
        metrics,
      ),
    ).rejects.toThrow("integration.codex.trace-deadline");
    expect(metrics).toEqual({ reads: 3, waits: [100, 100, 100], clock: 300 });
  });
  it.each(["mode", "owner"])(
    "rejects %s changes during an append instead of waiting",
    async (fault) => {
      await expect(
        observeCodexLiveLedger([
          [{ content: codexLiveMetadata }],
          [{ content: codexLiveMetadata, append: true, fault }],
          [{ content: codexLiveMetadata + codexLiveTerminal }],
        ]),
      ).rejects.toThrow("integration.codex.session-ledger");
    },
  );
  it.each([
    "{\n",
    codexLiveTerminal.replace("synthetic-completion", "wrong"),
    codexLiveTerminal + codexLiveTerminal,
  ])(
    "does not hide invalid completed observations behind pending",
    async (line) => {
      await expect(
        observeCodexLiveLedger([
          [{ content: codexLiveMetadata }],
          [{ content: codexLiveMetadata + line, append: true }],
          [{ content: codexLiveMetadata + codexLiveTerminal }],
        ]),
      ).rejects.toThrow("integration.codex.session-ledger");
    },
  );
});

describe("live append UTF-8 complete-prefix observation", () => {
  const partial = `${codexLiveMetadata}{"note":"`;
  const complete = `${codexLiveMetadata}{"note":"€"}\n${codexLiveTerminal}`;
  it("waits through E2 then E282 and observes the later complete UTF-8 terminal", async () => {
    await expect(
      observeCodexLiveLedger([
        [{ content: codexLiveMetadata }],
        [{ content: partial, append: true, utf8: "split" }],
        [{ content: complete }],
      ]),
    ).resolves.toEqual({
      turnId: "synthetic-turn",
      reads: 3,
      baseline: codexLiveMetadata,
    });
  });
  it("rejects invalid UTF-8 before an otherwise incomplete tail", async () => {
    await expect(
      observeCodexLiveLedger([
        [{ content: codexLiveMetadata }],
        [{ content: partial, append: true, utf8: "invalid" }],
        [{ content: complete }],
      ]),
    ).rejects.toThrow("integration.codex.session-ledger");
  });
  it("does not extend the original deadline for an incomplete UTF-8 append", async () => {
    const metrics = { reads: 0, waits: [] as number[], clock: 0 };
    await expect(
      observeCodexLiveLedger(
        [
          [{ content: codexLiveMetadata }],
          [{ content: partial, append: true, utf8: "split" }],
          [{ content: partial, append: true, utf8: "split" }],
          [{ content: complete }],
        ],
        metrics,
      ),
    ).rejects.toThrow("integration.codex.trace-deadline");
    expect(metrics).toEqual({ reads: 3, waits: [100, 100, 100], clock: 300 });
  });
});

describe("actual Codex live baseline complete-line boundary", () => {
  it.each([
    codexLiveMetadata,
    `${codexLiveMetadata}{"type":`,
    '{"type":"session_meta",',
  ])(
    "binds only complete metadata before the terminal observation",
    async (content) => {
      await expect(
        observeCodexLiveLedger([
          [{ content }],
          [{ content: codexLiveMetadata + codexLiveTerminal }],
        ]),
      ).resolves.toEqual({
        turnId: "synthetic-turn",
        reads: 2,
        baseline: codexLiveMetadata,
      });
    },
  );
  it.each([
    "{\n",
    `${codexLiveMetadata}{\n`,
    codexLiveMetadata + codexLiveMetadata,
    `${JSON.stringify({ type: "other" })}\n${codexLiveMetadata}`,
    `${JSON.stringify({ type: "session_meta", payload: {} })}\n`,
  ])("refuses malformed completed lines or metadata", async (content) => {
    await expect(observeCodexLiveLedger([[{ content }]])).rejects.toThrow(
      "integration.codex.session-ledger",
    );
  });
  it("refuses multiple live records even before metadata completes", async () => {
    await expect(
      observeCodexLiveLedger([[{ content: "{" }, { content: "{" }]]),
    ).rejects.toThrow("integration.codex.session-ledger");
  });
  it.each(
    [
      [],
      [{ content: codexLiveMetadata + codexLiveTerminal, ino: 3 }],
      [
        {
          content:
            codexLiveMetadata.replace("synthetic-session", "other") +
            codexLiveTerminal,
        },
      ],
      [
        {
          content:
            codexLiveMetadata +
            codexLiveTerminal.replace("synthetic-completion", "other"),
        },
      ],
    ].map((next) => ({ next })),
  )("preserves strict evolution after baseline binding", async ({ next }) => {
    await expect(
      observeCodexLiveLedger([[{ content: codexLiveMetadata }], next]),
    ).rejects.toThrow("integration.codex.session-ledger");
  });
  it("does not mint completion when byte-zero metadata remains incomplete", async () => {
    await expect(observeCodexLiveLedger([[{ content: "{" }]])).rejects.toThrow(
      "integration.codex.trace-deadline",
    );
  });
  it("keeps final postjoin snapshots strict about unfinished tails", () => {
    const context = `${JSON.stringify({ type: "turn_context", payload: { turn_id: "synthetic-turn", model: "synthetic-model" } })}\n`;
    const content = codexLiveMetadata + context + codexLiveTerminal;
    const record = (value: string) => ({
      relativePath: ".codex/sessions/2026/01/01/rollout-synthetic.jsonl",
      dev: 1n,
      ino: 2n,
      mode: 0o100600n,
      uid: 1000n,
      gid: 1000n,
      content: value,
    });
    const input = {
      baseline: [record(codexLiveMetadata)],
      observedRecords: [record(content)],
      expectedMessage: "synthetic-completion",
      sessionId: "synthetic-session",
      turnId: "synthetic-turn",
      modelName: "synthetic-model",
    };
    expect(
      projectCodexPostJoinTranscript({ ...input, records: [record(content)] }),
    ).toHaveProperty("exclusiveEndPosition", 3);
    expect(() =>
      projectCodexPostJoinTranscript({
        ...input,
        records: [record(`${content}{`)],
      }),
    ).toThrow("integration.codex.session-ledger");
  });
});

describe("actual retained model research marker channel", () => {
  it.each([
    "model-budget",
    "model-http-status",
    "model-projection",
    "model-control-order",
    "model-control-count",
    "model-ledger",
  ])("preserves fixture131 and verify-gate while retaining only %s", (hint) => {
    const source = readIntegration("codex-pty-scenario.mjs");
    const start = source.indexOf(
      "process.setUncaughtExceptionCaptureCallback(",
    );
    const end = source.indexOf("const required =", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const phasesSource = readIntegration("codex-trace-child-diagnostics.mjs");
    const phases = runInNewContext(
      `${phasesSource.slice(phasesSource.indexOf("export const interactivePhases"), phasesSource.indexOf("export const candidateConfigStages")).replace("export const", "const")}\ninteractivePhases;`,
    ) as readonly string[];
    const phaseIndex = phases.indexOf("verify-gate");
    expect(phaseIndex).toBe(67);
    const directory = mkdtempSync(join(tmpdir(), "agentscope-model-hint-"));
    let callback: ((error: Error) => void) | undefined;
    let fixtureExit: number | undefined;
    try {
      runInNewContext(
        source.slice(start, end),
        {
          process: {
            setUncaughtExceptionCaptureCallback: (
              value: (error: Error) => void,
            ) => {
              callback = value;
            },
            stdout: {
              write: (_text: string, complete: (error?: unknown) => void) => {
                complete();
              },
            },
            exit: (code: number) => {
              fixtureExit = code;
            },
          },
          interactiveFailurePhase: "verify-gate",
          interactiveFailurePhaseIndex: phaseIndex,
          modelControlFailureHint: hint,
          candidateConfigStage: undefined,
          preCheckpointFailureDiagnostic: undefined,
          joinDeadlineHookState: undefined,
          adapterReportedFailure: undefined,
          postTraceFailureDiagnostic: () => undefined,
          ledger: directory,
          integrationRunId: "0123456789abcdef",
          terminalCompletionMarker: "AGENTSCOPE_PTY_COMPLETE",
          encodeInteractiveFailureExitCode,
          encodeAdapterReportedFailureMarker,
          writeFileSync,
          join,
          setTimeout: () => 1,
          clearTimeout: () => undefined,
        },
        { timeout: 1000 },
      );
      expect(callback).toBeDefined();
      callback!(new Error("synthetic original"));
      expect(fixtureExit).toBe(131);
      const record = readBoundedInteractiveFailureRecord(
        directory,
        "0123456789abcdef",
      );
      expect(record?.predicate).toBe(
        `integration.fixture.codex-gate-research-${hint}`,
      );
      const primary = selectInteractiveFailureDiagnostic(
        record?.predicate,
        "integration.fixture.codex-verify-gate",
        "integration.runner.fixture-failed",
      );
      expect(primary).toBe("integration.fixture.codex-verify-gate");
      expect(
        encodeInteractiveFailureExitCode(primary!, "codex-tui-trace-smoke"),
      ).toBe(127);
      expect(codexGateResearchHints).toContain(hint);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

const postCheckpointFailure = (
  error: unknown,
  phase = "model-gate-arm-complete",
  sinkThrows = false,
) => {
  const source = readIntegration("codex-pty-scenario.mjs");
  const start = source.indexOf("process.setUncaughtExceptionCaptureCallback(");
  const end = source.indexOf("const required =", start);
  const phasesSource = readIntegration("codex-trace-child-diagnostics.mjs");
  const phases = runInNewContext(
    `${phasesSource.slice(phasesSource.indexOf("export const interactivePhases"), phasesSource.indexOf("export const candidateConfigStages")).replace("export const", "const")}\ninteractivePhases;`,
  ) as readonly string[];
  const directory = mkdtempSync(join(tmpdir(), "agentscope-post-checkpoint-"));
  let callback: ((error: unknown) => void) | undefined;
  let exitCode: number | undefined;
  try {
    runInNewContext(
      source.slice(start, end),
      {
        process: {
          setUncaughtExceptionCaptureCallback: (value: typeof callback) => {
            callback = value;
          },
          stdout: {
            write: (_text: string, complete: () => void) => {
              complete();
            },
          },
          exit: (code: number) => {
            exitCode = code;
          },
        },
        interactiveFailurePhase: phase,
        interactiveFailurePhaseIndex: phases.indexOf(phase),
        modelControlFailureHint: undefined,
        candidateConfigStage: undefined,
        preCheckpointFailureDiagnostic: undefined,
        joinDeadlineHookState: undefined,
        adapterReportedFailure: undefined,
        postTraceFailureDiagnostic: () => undefined,
        codexArmPendingResearchHint,
        ledger: directory,
        integrationRunId: "0123456789abcdef",
        terminalCompletionMarker: "AGENTSCOPE_PTY_COMPLETE",
        encodeInteractiveFailureExitCode,
        encodeAdapterReportedFailureMarker,
        writeFileSync: sinkThrows
          ? () => {
              throw new Error("private sink");
            }
          : writeFileSync,
        join,
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
      { timeout: 1000 },
    );
    expect(callback).toBeDefined();
    callback!(error);
    return {
      exitCode,
      originalExitCode: 64 + phases.indexOf(phase),
      marker: readBoundedInteractiveFailureRecord(directory, "0123456789abcdef")
        ?.predicate,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("post-checkpoint original failure research", () => {
  it.each([
    ["integration.codex.trace-deadline", "arm-deadline"],
    ["integration.codex.session-ledger", "arm-session-ledger"],
    ["private synthetic error", "arm-other"],
  ])(
    "retains only %s category without replacing the phase",
    (message, hint) => {
      const result = postCheckpointFailure(new Error(message));
      expect(result.exitCode).toBe(result.originalExitCode);
      expect(result.marker).toBe(
        `integration.fixture.codex-gate-research-${hint}`,
      );
      const runner = readIntegration("runner.mjs");
      const start = runner.indexOf(
        'const gatePrefix = "integration.fixture.codex-gate-research-";',
      );
      const end = runner.indexOf("const traceHint =", start);
      const lines: string[] = [];
      runInNewContext(
        `(async () => { ${runner.slice(start, end)} })()`,
        {
          marker: result.marker,
          codexGateResearchHints,
          process: { stdout: { write: (line: string) => lines.push(line) } },
        },
        { timeout: 1000 },
      );
      const untrustedGateHint = extractUntrustedCodexGateHint(lines.join(""));
      expect(untrustedGateHint).toBe(hint);
      const phase = "integration.fixture.codex-model-gate-arm-complete";
      expect(
        selectInteractiveFailureDiagnostic(
          result.marker,
          phase,
          "integration.runner.fixture-failed",
        ),
      ).toBe(phase);
      expect(lines.join("")).not.toContain(message);
      const research = createCodexFailureResearchRecord(
        { runId: "0123456789abcdef", scenarioId: "codex-tui-trace-smoke" },
        lines.join(""),
        undefined,
        { code: 1 },
        [
          () => undefined,
          extractUntrustedCodexGateHint,
          () => undefined,
          projectUntrustedCodexPtyReceipt,
          extractAdapterReportedFailure,
          codexFailureExitPair,
        ],
      );
      expect(research.untrustedGateHint).toBe(hint);
      expect(research.exitPair).toBe("none:1");
      expect(
        validCodexResearchDiagnostic(JSON.parse(JSON.stringify(research))),
      ).toBe(true);
    },
  );
  it("retains unrelated phases and the existing optional sink fallback", () => {
    const unrelated = postCheckpointFailure(
      new Error("integration.codex.session-ledger"),
      "tui-checkpoint",
    );
    expect(unrelated.marker).toBe("integration.fixture.codex-tui-checkpoint");
    expect(unrelated.exitCode).toBe(unrelated.originalExitCode);
    const sink = postCheckpointFailure(
      new Error("integration.codex.session-ledger"),
      "model-gate-arm-complete",
      true,
    );
    expect(sink.marker).toBeUndefined();
    expect(sink.exitCode).toBe(64);
  });
  it("contains hostile and foreign categories without reflecting their content", () => {
    const hostile = Object.defineProperty(new Error(), "message", {
      get: () => {
        throw new Error("private getter");
      },
    });
    for (const value of [
      null,
      "integration.codex.session-ledger",
      { message: "integration.codex.session-ledger" },
      hostile,
      new Proxy(new Error(), {
        get: () => {
          throw new Error("private proxy");
        },
      }),
    ]) {
      expect(codexArmPendingResearchHint(value)).toBe("arm-other");
    }
    expect(
      extractUntrustedCodexGateHint(
        "integration.runner.untrusted-gate-hint:arm-session-ledger-private\n",
      ),
    ).toBeUndefined();
  });
});

const finalModelFixture = (variant: string) => {
  const source = readIntegration("codex-pty-scenario.mjs");
  const start = source.indexOf("const readModelRequests = async () => {");
  const end = source.indexOf("const configureModelGate =", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const control = (path: string) => ({
    method: "PUT",
    path,
    role: "allowed-control",
    status: 200,
    bodyBytes: 2,
    bodySha256: "a".repeat(64),
  });
  const configuration = control("/mockserver/expectation");
  const retrieval = control("/mockserver/retrieve");
  const candidate = Array.from({ length: 5 }, (_, index) => ({
    ...control(`/denied-${index}`),
    role: "forbidden-control",
    status: 403,
  }));
  const rows = [configuration, ...candidate, retrieval];
  if (variant === "order") [rows[0], rows[1]] = [rows[1]!, rows[0]!];
  if (variant === "count") rows.pop();
  const original = new Error("synthetic original");
  const requests = vi.fn(() =>
    Promise.resolve({
      status: variant === "status" ? 503 : 200,
      bytes: Buffer.from("synthetic bounded response"),
    }),
  );
  const execute = runInNewContext(
    `let modelControlFailureHint; ${source.slice(start, end)};
     ({ read: readModelRequests, hint: () => modelControlFailureHint });`,
    {
      upstreamControl: {
        snapshot: () => ({
          entries:
            variant === "budget"
              ? Array.from({ length: 7 }, () => configuration)
              : [configuration, retrieval],
        }),
        requests,
      },
      candidateTraffic: { entries: candidate },
      promptSha256: "b".repeat(64),
      integrationRunId: "0123456789abcdef",
      projectMockServerRequests: () => {
        if (variant === "projection") throw original;
        return rows;
      },
      snapshotMockServerTraffic: (value: unknown) => value,
      boundedRequestLedger: () => {
        if (variant === "ledger") throw original;
        return [];
      },
      upstreamTraffic: undefined,
    },
    { timeout: 1000 },
  ) as { read: () => Promise<unknown>; hint: () => unknown };
  return { ...execute, requests, original };
};

describe("actual final model-control boundary observations", () => {
  it.each([
    ["budget", "model-budget"],
    ["status", "model-http-status"],
    ["projection", "model-projection"],
    ["order", "model-control-order"],
    ["count", "model-control-count"],
    ["ledger", "model-ledger"],
  ])(
    "preserves %s refusal and records only its fixed hint",
    async (variant, hint) => {
      const fixture = finalModelFixture(variant);
      await expect(fixture.read()).rejects.toMatchObject({
        message:
          variant === "projection" || variant === "ledger"
            ? fixture.original.message
            : "integration.codex.model-control",
      });
      expect(fixture.hint()).toBe(hint);
      if (variant === "budget") expect(fixture.requests).not.toHaveBeenCalled();
      if (variant === "projection" || variant === "ledger")
        await expect(fixture.read()).rejects.toBe(fixture.original);
      expect(fixture.hint()).toBe(hint);
    },
  );
  it("keeps valid control ordering successful without a hint", async () => {
    const fixture = finalModelFixture("success");
    await expect(fixture.read()).resolves.toEqual([]);
    expect(fixture.hint()).toBeUndefined();
    expect(fixture.requests).toHaveBeenCalledTimes(1);
  });
});

describe("optional runner diagnostic sink preserves the original failure", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "preserves the actual exit when sink throws %s and model hint %s",
    async (throws, modelHint) => {
      const source = readIntegration("runner.mjs");
      const start = source.indexOf(
        'if (scenario.executionMode === "interactive" && fixtureFailure !== undefined)',
      );
      expect(start).toBeGreaterThan(0);
      const predicate = modelHint
        ? "integration.fixture.codex-verify-gate"
        : "integration.fixture.codex-verify-trace-get-child-invoke-get";
      const writes: string[] = [];
      const process = {
        env: {},
        exitCode: undefined as number | undefined,
        stdout: {
          write: (value: string) => {
            writes.push(value);
            if (throws) throw new Error("synthetic sink failure");
          },
        },
      };
      const completed: unknown = runInNewContext(
        `(async () => { ${source.slice(start)} })()`,
        {
          scenario: { executionMode: "interactive" },
          scenarioId: "codex-tui-trace-smoke",
          fixtureFailure: new Error("original failure"),
          fixtureOutput: "",
          interactiveFailureDiagnostic: predicate,
          ledger: "owned-fixture",
          home: "owned-home",
          process,
          emitCodexPtyFailureHint: () => undefined,
          retainedCandidateConfigStage: () => undefined,
          untrustedCodexJoinHint: () => undefined,
          requiredEnvironment: () => "0123456789abcdef",
          readBoundedInteractiveFailureRecord: () => ({
            predicate: modelHint
              ? "integration.fixture.codex-gate-research-model-control-order"
              : predicate,
            adapterReportedFailure: modelHint
              ? undefined
              : {
                  stage: 11,
                  cutoffExpired: false,
                  workerJoined: true,
                  watchdogJoined: null,
                  leaseReleased: false,
                },
          }),
          encodeAdapterReportedFailureMarker,
          retainedInteractivePhase: () => undefined,
          codexGateResearchHints,
          untrustedCodexTraceHint: () => undefined,
          encodeInteractiveFailureExitCode,
        },
        { timeout: 1000 },
      );
      await expect(Promise.resolve(completed)).resolves.toBeUndefined();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(
        modelHint
          ? /^integration\.runner\.untrusted-gate-hint:model-control-order\n$/u
          : /^integration\.runner\.adapter-reported-failure:/u,
      );
      if (modelHint)
        expect(extractUntrustedCodexGateHint(writes[0])).toBe(
          "model-control-order",
        );
      expect(process.exitCode).toBe(modelHint ? 127 : 189);
      expect(process.exitCode).toBe(
        encodeInteractiveFailureExitCode(predicate, "codex-tui-trace-smoke"),
      );
    },
  );
});

const modelFixture = (observe?: (hint: string) => void) => {
  const response = Object.assign(new EventEmitter(), { statusCode: 200 });
  const request = Object.assign(new EventEmitter(), {
    end: (body?: string) => {
      sentBody = body;
    },
    destroy: () => {
      destroyed += 1;
      request.emit("error", new Error("private"));
    },
  });
  let sentBody: string | undefined;
  let destroyed = 0;
  let options: Record<string, unknown> | undefined;
  let deliver: (() => void) | undefined;
  let clock = 100;
  const hints: string[] = [];
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const headers = Object.freeze({
    authorization: "private",
    "content-type": "application/json",
  });
  const httpRequest = ((
    input: Record<string, unknown>,
    callback: (value: EventEmitter) => void,
  ) => {
    options = input;
    deliver = () => {
      callback(response);
    };
    return request;
  }) as unknown as typeof HttpRequest;
  const control = createCodexModelControlRequest({
    httpRequest,
    agent,
    headers,
    socketPath: "/private/socket",
    deadline: () => 1000,
    gateCutoff: () => 600,
    now: () => clock,
    observe: (hint) => {
      hints.push(hint);
      observe?.(hint);
    },
  });
  return {
    control,
    request,
    response,
    hints,
    agent,
    headers,
    deliver: () => deliver?.(),
    setClock: (value: number) => {
      clock = value;
    },
    options: () => options,
    body: () => sentBody,
    destroyed: () => destroyed,
  };
};

describe("model control first seal failure research", () => {
  it("preserves request options, body and successful silence", async () => {
    const f = modelFixture();
    const result = f.control("/seal", "POST", { runId: "owned" });
    expect(f.options()).toMatchObject({
      agent: f.agent,
      method: "POST",
      path: "/seal",
      socketPath: "/private/socket",
    });
    expect(f.options()?.headers).toEqual({
      ...f.headers,
      "content-length": 17,
    });
    expect(f.options()?.signal).toBeInstanceOf(AbortSignal);
    expect(f.body()).toBe('{"runId":"owned"}');
    f.deliver();
    f.response.emit("data", Buffer.from('{"receipt":true}'));
    f.response.emit("end");
    await expect(result).resolves.toEqual({ receipt: true });
    expect(f.hints).toEqual([]);
  });
  it.each([
    ["seal-http-status", "status"],
    ["seal-response-decode", "json"],
    ["seal-response-decode", "utf8"],
    ["seal-response-limit", "limit"],
    ["seal-response-aborted", "aborted"],
    ["seal-transport", "transport"],
  ])(
    "retains first %s without exposing failure content",
    async (hint, stage) => {
      const f = modelFixture();
      const result = f.control("/seal", "POST", {});
      const rejected = expect(result).rejects.toThrow(
        "integration.codex.model-gate",
      );
      f.deliver();
      if (stage === "status") f.response.statusCode = 409;
      if (stage === "json") f.response.emit("data", Buffer.from("private"));
      if (stage === "utf8") f.response.emit("data", Buffer.from([255]));
      if (stage === "limit") f.response.emit("data", Buffer.alloc(65537));
      else if (stage === "aborted") {
        f.response.emit("aborted");
        f.request.emit("error", new Error("private body/path"));
      } else if (stage === "transport")
        f.request.emit("error", new Error("private body/path"));
      else f.response.emit("end");
      await rejected;
      f.response.emit("aborted");
      expect(f.hints).toEqual([hint]);
      expect(f.destroyed()).toBe(stage === "limit" ? 1 : 0);
    },
  );
  it("retains caller cancellation without changing its generic failure", async () => {
    const f = modelFixture();
    const controller = new AbortController();
    const result = f.control("/seal", "POST", {}, controller.signal);
    const rejected = expect(result).rejects.toThrow(
      "integration.codex.model-gate",
    );
    controller.abort(new Error("private"));
    f.request.emit("error", new Error("private"));
    await rejected;
    expect(f.hints).toEqual(["seal-signal-aborted"]);
  });
});

describe("model control unchanged cutoff and settlement", () => {
  it("passes original remaining budget without a recreated window", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      for (const [path, budget] of [
        ["/seal", 900],
        ["/deny", 900],
        ["/requests", 500],
      ] as const) {
        const f = modelFixture();
        const result = f.control(path, "PUT");
        expect(timeout).toHaveBeenLastCalledWith(budget);
        expect(f.options()?.headers).toBe(f.headers);
        expect(f.body()).toBeUndefined();
        f.deliver();
        f.response.emit("data", Buffer.from("{}"));
        f.response.emit("end");
        await expect(result).resolves.toEqual({});
      }
    } finally {
      timeout.mockRestore();
    }
  });
  it("does not replace a synchronous primary request failure", async () => {
    const primary = new Error("private original");
    const hints: string[] = [];
    const control = createCodexModelControlRequest({
      httpRequest: () => {
        throw primary;
      },
      agent: new Agent({ keepAlive: true, maxSockets: 1 }),
      headers: {},
      socketPath: "/private/socket",
      deadline: () => 1000,
      gateCutoff: () => undefined,
      now: () => 100,
      observe: (hint) => {
        hints.push(hint);
      },
    });
    await expect(control("/seal", "POST", {})).rejects.toBe(primary);
    expect(hints).toEqual([]);
  });
  it("preserves the original absolute and gate cutoffs", () => {
    const f = modelFixture();
    f.setClock(600);
    expect(() => f.control("/requests", "PUT", {})).toThrow(
      "integration.codex.model-gate-deadline",
    );
    expect(f.hints).toEqual([]);
    f.setClock(1000);
    expect(() => f.control("/seal", "POST", {})).toThrow(
      "integration.codex.model-gate-deadline",
    );
    expect(f.hints).toEqual(["seal-deadline"]);
    expect(f.options()).toBeUndefined();
  });
  it("ignores sink failure and observes aborted responses without settling them", async () => {
    const f = modelFixture(() => {
      throw new Error("private sink");
    });
    let settled = false;
    const result = f.control("/seal", "POST", {}).finally(() => {
      settled = true;
    });
    const rejected = expect(result).rejects.toThrow(
      "integration.codex.model-gate",
    );
    f.deliver();
    f.response.emit("aborted");
    await Promise.resolve();
    expect(settled).toBe(false);
    f.request.emit("error", new Error("private"));
    await rejected;
    expect(f.hints).toEqual(["seal-response-aborted"]);
  });
  it("leaves non-seal failures unobserved", async () => {
    const f = modelFixture();
    const result = f.control("/deny", "POST", {});
    const rejected = expect(result).rejects.toThrow(
      "integration.codex.model-gate",
    );
    f.request.emit("error", new Error("private"));
    await rejected;
    expect(f.hints).toEqual([]);
  });
});

describe("returned receipt packet compatibility and wiring", () => {
  it("preserves historical versions and closes exact version-4 keys", () => {
    const base = { untrustedConfigHint: "publish", exitPair: "none:1" };
    for (const diagnosticVersion of [1, 2, 3, 4]) {
      const record = {
        ...base,
        diagnosticVersion,
        ...(diagnosticVersion >= 2
          ? { untrustedGateHint: "arm-log-unavailable" }
          : {}),
        ...(diagnosticVersion >= 3
          ? { untrustedPtyHint: "arm-pty-returned-failed" }
          : {}),
        ...(diagnosticVersion === 4
          ? {
              untrustedPtyReceipt: {
                outcome: "timeout",
                checkpointProgressDiagnostic: "no-live-readiness",
              },
            }
          : {}),
      };
      expect(validCodexResearchDiagnostic(record)).toBe(true);
      expect(
        validCodexResearchDiagnostic({ ...record, extra: "private" }),
      ).toBe(false);
      if (diagnosticVersion === 4) {
        expect(
          validCodexResearchDiagnostic({
            ...record,
            untrustedPtyReceipt: null,
          }),
        ).toBe(true);
        expect(
          validCodexResearchDiagnostic({
            ...record,
            untrustedPtyReceipt: {
              outcome: "timeout",
              checkpointProgressDiagnostic: "private",
            },
          }),
        ).toBe(false);
      } else
        expect(
          validCodexResearchDiagnostic({
            ...record,
            untrustedPtyReceipt: null,
          }),
        ).toBe(false);
    }
  });
  it("executes the actual outer failure retainer and stays silent for non-Codex", () => {
    const source = readIntegration("run-scenarios.mjs");
    const start = source.indexOf("const retainCodexResearchDiagnostic =");
    const end = source.indexOf("const captureFailedScenarioReceipt =", start);
    expect(end).toBeGreaterThan(start);
    for (const scenarioId of ["codex-tui-trace-smoke", "other"])
      for (const receipt of [
        undefined,
        {
          outcome: "timeout",
          checkpointProgressDiagnostic: "advanced",
          exitCode: null,
        },
      ]) {
        const retained = new Map<
          string,
          {
            diagnosticVersion: number;
            untrustedPtyReceipt: ReturnType<
              typeof projectUntrustedCodexPtyReceipt
            > | null;
            exitPair: string | null;
            adapterReportedFailure: null;
          }
        >();
        runInNewContext(
          `${source.slice(start, end)} retainCodexResearchDiagnostic(plan, '', receipt, {code:1});`,
          {
            plan: { scenarioId, runId: "closed-canary" },
            receipt,
            codexResearchDiagnostics: retained,
            projectUntrustedCodexPtyReceipt,
            extractAdapterReportedFailure,
            createCodexFailureResearchRecord,
            codexResearchDependencies: [
              () => "publish",
              () => "arm-log-unavailable",
              () => "arm-pty-returned-failed",
              projectUntrustedCodexPtyReceipt,
              extractAdapterReportedFailure,
              codexFailureExitPair,
            ],
            extractUntrustedCodexConfigHint: () => "publish",
            extractUntrustedCodexGateHint: () => "arm-log-unavailable",
            extractUntrustedCodexPtyHint: () => "arm-pty-returned-failed",
            codexFailureExitPair,
          },
          { timeout: 1000 },
        );
        if (scenarioId === "other") expect(retained.size).toBe(0);
        else {
          const record = retained.get("closed-canary");
          expect(record?.diagnosticVersion).toBe(6);
          expect(record?.untrustedPtyReceipt).toEqual(
            projectUntrustedCodexPtyReceipt(receipt, 6) ?? null,
          );
          expect(record?.exitPair).toBe("none:1");
          expect(record?.adapterReportedFailure).toBeNull();
        }
      }
  });
});
