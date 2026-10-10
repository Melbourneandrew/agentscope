/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { classifyCodexTraceGetFailure } from "../codex-runtime-evidence.mjs";
import { classifyCodexCollectedChildFailure } from "../codex-pty-research.mjs";

// The authority is deliberately private integration JavaScript, not a package API.
// @ts-expect-error no declaration file is published for this private module
import * as immutableAuthority from "../immutable-candidate-authority.mjs";

const readIntegration = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "..", name), "utf8");

const {
  claudePackedInstallFailurePhase,
  claudeScenarioFailureDiagnostic,
  codexArmPendingResearchHint,
  codexArmPtyResearchHint,
  codexFailureExitPair,
  compileCandidateInventory,
  compileImmutableCandidateHandoff,
  codexProjectionFailureDiagnostic,
  codexUninstallFailureDiagnostic,
  codexUninstallUnclassifiedStageDiagnostic,
  decodeCodexJoinDeadlineExitCode,
  decodeInteractiveFailureExitCode,
  decodeInteractivePtyReceipt,
  decodeImmutableCandidateHandoff,
  encodeInteractiveFailureExitCode,
  encodeCodexJoinDeadlineExitCode,
  extractInteractiveChildDiagnostic,
  formatInteractiveChildDiagnostic,
  readInteractiveChildFailureObservation,
  validInstalledPtyFailure,
  extractUntrustedCodexConfigHint,
  extractUntrustedCodexGateHint,
  extractUntrustedCodexPtyHint,
  extractUntrustedCodexJoinHint,
  extractUntrustedCodexTraceHint,
  gateReceiptResearchRejection,
  validCodexResearchDiagnostic,
  interactivePtyEnvelopeDeadlineMatches,
  interactivePtyEnvelopeRejectionCode,
  interactivePtyActionPrefixDiagnostic,
  interactivePtyReadinessProgressDiagnostic,
  interactivePtyIdleObservationDiagnostic,
  interactivePtyIdleAtTitleDiagnostic,
  interactivePtyExecutionReserveMilliseconds,
  interactivePtyObservedActionsMatch,
  interactivePtyArtifactReadinessMatches,
  interactivePtyReadinessRejectionDiagnostic,
  interactivePtyArtifactRejectionCode,
  interactivePtyReceiptFailed,
  interactivePtyReceiptAuthorityMatches,
  interactivePtyReceiptRejectionCode,
  parseCodexMachineOutput,
  readBoundedInteractiveFailureMarker,
  selectInteractiveExecutionFailurePredicate,
  selectInteractiveFailureDiagnostic,
  untrustedCodexTraceHint,
  selectedRuntimeFiles,
  validateImmutableScenarioContainer,
} = immutableAuthority;

const packedInstallError = () =>
  Object.assign(new Error("PRIVATE_NOT_RETAINED"), {
    code: 5,
    signal: null,
    killed: false,
    stderr:
      '{"category":"unavailable","code":"harness.unavailable","command":"agentscope install","schema":"agentscope.cli.diagnostic.v1"}\n',
  });

describe("exact existing Claude install diagnostic envelopes", () => {
  it.each([
    ["packed-hook-absent", "harness.absent", "not-found", 3, 246],
    [
      "packed-hook-adapter-missing",
      "harness.adapter-missing",
      "not-found",
      3,
      247,
    ],
    [
      "packed-hook-discovery-indeterminate",
      "harness.discovery-indeterminate",
      "unavailable",
      5,
      248,
    ],
    [
      "packed-hook-installation-unsupported",
      "harness.installation-unsupported",
      "unavailable",
      5,
      249,
    ],
    [
      "packed-hook-overlap-conflict",
      "harness.overlap-conflict",
      "conflict",
      4,
      250,
    ],
    ["packed-hook-plan-invalid", "harness.plan-invalid", "unavailable", 5, 251],
    [
      "packed-hook-recovery-required",
      "harness.recovery-required",
      "conflict",
      4,
      252,
    ],
    ["packed-hook-unavailable", "harness.unavailable", "unavailable", 5, 253],
    [
      "packed-hook-version-unsupported",
      "harness.version-unsupported",
      "unavailable",
      5,
      254,
    ],
    ["packed-hook-internal", "cli.internal", "internal-error", 70, 255],
  ] as const)(
    "maps exact %s at appended exit %i",
    (phase, code, category, nativeExit, exit) => {
      const error = Object.assign(packedInstallError(), {
        code: nativeExit,
        stderr: `${JSON.stringify({ category, code, command: "agentscope install", schema: "agentscope.cli.diagnostic.v1" })}\n`,
      });
      expect(claudePackedInstallFailurePhase(error)).toBe(phase);
      const diagnostic = claudeScenarioFailureDiagnostic(error, phase);
      expect(diagnostic).toBe(`integration.fixture.claude-phase-${phase}`);
      expect(
        encodeInteractiveFailureExitCode(
          diagnostic,
          "claude-interactive-trace-smoke",
        ),
      ).toBe(exit);
      expect(
        decodeInteractiveFailureExitCode(
          exit,
          "claude-interactive-trace-smoke",
        ),
      ).toBe(diagnostic);
      expect(
        decodeInteractiveFailureExitCode(exit, "codex-tui-trace-smoke"),
      ).toBeUndefined();
      expect(
        encodeInteractiveFailureExitCode(diagnostic, "codex-tui-trace-smoke"),
      ).toBeUndefined();
    },
  );
});
describe("malformed existing Claude install diagnostic envelopes", () => {
  it.each([
    { code: 3 },
    { code: "5" },
    { signal: "SIGTERM" },
    { killed: true },
    { signal: undefined },
    { killed: undefined },
    { stderr: Buffer.from("private") },
    { stderr: "x".repeat(513) },
    { stderr: "😀".repeat(129) },
    { stderr: "" },
  ])("keeps malformed native error metadata a fixed fallback", (patch) => {
    expect(
      claudePackedInstallFailurePhase(
        Object.assign(packedInstallError(), patch),
      ),
    ).toBe("packed-hook-install");
  });

  it("rejects every noncanonical or expanded existing diagnostic envelope", () => {
    const original = packedInstallError().stderr;
    for (const stderr of [
      ` ${original}`,
      `${original}\n`,
      `${original}${original}`,
      original.trimEnd(),
      original.replace('"code":', '"code":"harness.unavailable","code":'),
      original.replace("agentscope install", "agentscope uninstall"),
      original.replace("agentscope.cli.diagnostic.v1", "foreign.v1"),
      original.replace("harness.unavailable", "harness.private-content"),
      original.replace('"unavailable"', '"conflict"'),
      original.replace('"schema":', '"facts":{"private":true},"schema":'),
      original.replace(
        '"category":"unavailable","code":"harness.unavailable"',
        '"code":"harness.unavailable","category":"unavailable"',
      ),
    ])
      expect(
        claudePackedInstallFailurePhase(
          Object.assign(packedInstallError(), { stderr }),
        ),
      ).toBe("packed-hook-install");
  });
});
describe("hostile existing Claude install error metadata", () => {
  it("never evaluates forged/accessor/Proxy or unrelated error content", () => {
    const trap = () => {
      throw new Error("PRIVATE_TRAP");
    };
    const original = packedInstallError();
    for (const key of ["stdout", "message", "cause", "facts"])
      Object.defineProperty(original, key, { get: trap });
    expect(claudePackedInstallFailurePhase(original)).toBe(
      "packed-hook-unavailable",
    );
    for (const key of ["code", "stderr", "signal", "killed"]) {
      const error = packedInstallError();
      Object.defineProperty(error, key, { get: trap });
      expect(claudePackedInstallFailurePhase(error)).toBe(
        "packed-hook-install",
      );
      const missing = packedInstallError();
      Reflect.deleteProperty(missing, key);
      expect(claudePackedInstallFailurePhase(missing)).toBe(
        "packed-hook-install",
      );
    }
    expect(claudePackedInstallFailurePhase({ ...packedInstallError() })).toBe(
      "packed-hook-install",
    );
    expect(
      claudePackedInstallFailurePhase(
        new Proxy(packedInstallError(), {
          get: trap,
          getOwnPropertyDescriptor: trap,
          getPrototypeOf: trap,
        }),
      ),
    ).toBe("packed-hook-install");
    expect(
      decodeInteractiveFailureExitCode(256, "claude-interactive-trace-smoke"),
    ).toBeUndefined();
    expect(
      encodeInteractiveFailureExitCode(
        "integration.fixture.claude-phase-packed-settings",
        "claude-interactive-trace-smoke",
      ),
    ).toBe(245);
  });
});

const semanticFacts = {
  finalSemanticState: "ready",
  inputJoined: false,
  readinessObserved: true,
  allInputBytesWritten: false,
};
const semanticPredicate = "testkit.pty.transport.semantic-incomplete";
describe("unsupported exit signal in the existing diagnostic frame", () => {
  it.each([1, 3, 64])(
    "round-trips unsupported signal %s in the same bounded frame",
    (signal) => {
      const predicate = "testkit.pty.transport.exit";
      const frame: string = formatInteractiveChildDiagnostic(
        predicate,
        undefined,
        signal,
      );
      expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(256);
      expect(readInteractiveChildFailureObservation(frame)).toEqual({
        predicate,
        exitSignal: signal,
      });
      expect(
        readInteractiveChildFailureObservation(frame + frame),
      ).toBeUndefined();
      expect(
        readInteractiveChildFailureObservation(
          frame.replace(predicate, semanticPredicate),
        ),
      ).toBeUndefined();
      const record = {
        receiptVersion: 1,
        phase: "pty-execution",
        predicate,
        scenarioId: "claude-interactive-trace-smoke",
        exitSignal: signal,
      };
      expect(validInstalledPtyFailure(JSON.parse(JSON.stringify(record)))).toBe(
        true,
      );
      expect(
        validInstalledPtyFailure({
          ...record,
          scenarioId: "fixture-process-smoke",
        }),
      ).toBe(false);
      expect(
        validInstalledPtyFailure({ ...record, predicate: semanticPredicate }),
      ).toBe(false);
      let traps = 0;
      expect(
        validInstalledPtyFailure(
          Object.defineProperty({ ...record }, "exitSignal", {
            get() {
              traps++;
              throw new Error("PRIVATE");
            },
          }),
        ),
      ).toBe(false);
      expect(
        validInstalledPtyFailure(
          new Proxy(record, {
            getPrototypeOf() {
              traps++;
              throw new Error("PRIVATE");
            },
          }),
        ),
      ).toBe(false);
      expect(traps).toBe(0);
    },
  );
  it.each(["0", "2", "9", "15", "65", "-1", "1.5", "01", "PRIVATE"])(
    "rejects contradictory/malformed exit signal %s",
    (signal) => {
      const predicate = "testkit.pty.transport.exit";
      expect(
        readInteractiveChildFailureObservation(
          `integration.runner.interactive-diagnostic:${predicate};signal;${signal}\n`,
        ),
      ).toBeUndefined();
      expect(
        validInstalledPtyFailure({
          receiptVersion: 1,
          phase: "pty-execution",
          predicate,
          scenarioId: "claude-interactive-trace-smoke",
          exitSignal: Number(signal),
        }),
      ).toBe(signal === "01");
      expect(
        validInstalledPtyFailure({
          receiptVersion: 1,
          phase: "pty-execution",
          predicate,
          scenarioId: "claude-interactive-trace-smoke",
          exitSignal: signal,
        }),
      ).toBe(false);
    },
  );
});
describe("bounded existing PTY diagnostic frame", () => {
  it.each(["active", "ready"])(
    "round-trips settled %s facts without admission authority",
    (state) => {
      const facts = { ...semanticFacts, finalSemanticState: state };
      const frame: string = formatInteractiveChildDiagnostic(
        semanticPredicate,
        facts,
      );
      expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(256);
      expect(readInteractiveChildFailureObservation(frame)).toEqual({
        predicate: semanticPredicate,
        semanticFailure: facts,
      });
      expect(extractInteractiveChildDiagnostic(frame)).toBe(semanticPredicate);
      expect(
        readInteractiveChildFailureObservation(
          formatInteractiveChildDiagnostic(semanticPredicate),
        ),
      ).toEqual({ predicate: semanticPredicate });
    },
  );
  it.each([
    ";completed;1;1;1",
    ";ready;true;1;1",
    ";ready;1;1",
    ";ready;1;1;1;PRIVATE",
    ";ready;1;1;1;claude-interactive-trace-smoke",
    ";ready;1;1;1\r",
  ])("rejects foreign/malformed scalar suffix %s", (suffix) => {
    const frame = `integration.runner.interactive-diagnostic:${semanticPredicate}${suffix}\n`;
    expect(readInteractiveChildFailureObservation(frame)).toBeUndefined();
  });
  it("rejects duplicates, other predicates and excessive frames", () => {
    const frame = formatInteractiveChildDiagnostic(
      semanticPredicate,
      semanticFacts,
    );
    expect(
      readInteractiveChildFailureObservation(frame + frame),
    ).toBeUndefined();
    expect(
      readInteractiveChildFailureObservation(
        frame + "integration.runner.interactive-diagnostic:PRIVATE\n",
      ),
    ).toBeUndefined();
    expect(
      readInteractiveChildFailureObservation(
        frame.replace(semanticPredicate, "testkit.pty.request"),
      ),
    ).toBeUndefined();
    expect(
      readInteractiveChildFailureObservation(
        `integration.runner.interactive-diagnostic:${"x".repeat(256)}\n`,
      ),
    ).toBeUndefined();
    expect(readInteractiveChildFailureObservation({})).toBeUndefined();
    expect(
      readInteractiveChildFailureObservation("x".repeat(16 * 1024 * 1024 + 1)),
    ).toBeUndefined();
    expect(formatInteractiveChildDiagnostic("PRIVATE")).not.toContain(
      "PRIVATE",
    );
  });
});
describe("content-free installed PTY diagnostic validator", () => {
  const original = {
    receiptVersion: 1,
    phase: "pty-execution",
    predicate: semanticPredicate,
  };
  it.each(["codex-tui-trace-smoke", "claude-interactive-trace-smoke"])(
    "validates held-plan scenario %s only",
    (scenarioId) => {
      expect(
        validInstalledPtyFailure({
          ...original,
          scenarioId,
          semanticFailure: semanticFacts,
        }),
      ).toBe(true);
      expect(validInstalledPtyFailure({ ...original, scenarioId })).toBe(true);
      expect(validInstalledPtyFailure(original)).toBe(true);
      expect(validInstalledPtyFailure(null)).toBe(true);
    },
  );
  it("refuses forged/accessor/proxy and malformed field projections without reading content", () => {
    let traps = 0;
    const accessor = Object.defineProperty(
      { ...semanticFacts },
      "inputJoined",
      {
        get() {
          traps++;
          throw new Error("PRIVATE");
        },
      },
    );
    const proxy = new Proxy(semanticFacts, {
      ownKeys() {
        traps++;
        throw new Error("PRIVATE");
      },
    });
    for (const semanticFailure of [
      accessor,
      proxy,
      { ...semanticFacts, extra: true },
      { ...semanticFacts, inputJoined: 1 },
      { ...semanticFacts, readinessObserved: 1 },
      { ...semanticFacts, allInputBytesWritten: 1 },
      { ...semanticFacts, finalSemanticState: "completed" },
    ]) {
      expect(
        validInstalledPtyFailure({
          ...original,
          scenarioId: "codex-tui-trace-smoke",
          semanticFailure,
        }),
      ).toBe(false);
      expect(
        readInteractiveChildFailureObservation(
          formatInteractiveChildDiagnostic(semanticPredicate, semanticFailure),
        ),
      ).toEqual({ predicate: semanticPredicate });
    }
    for (const value of [
      undefined,
      [],
      { ...original, scenarioId: "PRIVATE" },
      {
        ...original,
        phase: "pty-receipt",
        scenarioId: "codex-tui-trace-smoke",
      },
      {
        ...original,
        scenarioId: "codex-tui-trace-smoke",
        predicate: "testkit.pty.request",
        semanticFailure: semanticFacts,
      },
      { ...original, extra: true },
      new Proxy(original, {
        getPrototypeOf() {
          traps++;
          throw new Error("PRIVATE");
        },
      }),
    ])
      expect(validInstalledPtyFailure(value)).toBe(false);
    expect(traps).toBe(0);
  });
});
describe("actual held-plan parent PTY failure projection", () => {
  it.each([
    ["codex-tui-trace-smoke", false],
    ["claude-interactive-trace-smoke", false],
    ["codex-tui-trace-smoke", true],
    ["claude-interactive-trace-smoke", true],
  ] as const)(
    "binds the existing parent record to held %s plan, never child metadata (exit=%s)",
    (scenarioId, exit) => {
      const predicate = exit ? "testkit.pty.transport.exit" : semanticPredicate;
      const frame = formatInteractiveChildDiagnostic(
        predicate,
        exit ? undefined : semanticFacts,
        exit ? 1 : undefined,
      );
      const original = {
        receiptVersion: 1,
        phase: "pty-execution",
        predicate,
      };
      const source = readIntegration("run-scenarios.mjs");
      const start = source.indexOf("const recordInteractiveExecutionFailure ="),
        end = source.indexOf("const retainCodexResearchDiagnostic =", start);
      const failures = new Map();
      const record = runInNewContext(
        `${source.slice(start, end)}; recordInteractiveExecutionFailure`,
        {
          installedPtyFailures: failures,
          readInteractiveChildFailureObservation,
          selectInteractiveExecutionFailurePredicate: () => predicate,
          contentFreeChildFailureCode: () => predicate,
        },
      );
      const plan = {
        runId: "a".repeat(16),
        executionMode: "interactive",
        scenarioId,
      };
      const originalError = new Error("PRIVATE");
      expect(record(plan, originalError, frame, undefined)).toBe(predicate);
      expect(failures.get(plan.runId)).toEqual({
        ...original,
        scenarioId: plan.scenarioId,
        ...(exit ? { exitSignal: 1 } : { semanticFailure: semanticFacts }),
      });
      expect(
        validInstalledPtyFailure(
          JSON.parse(JSON.stringify(failures.get(plan.runId))),
        ),
      ).toBe(true);
      const generic = { ...plan, scenarioId: "fixture-process-smoke" };
      expect(record(generic, originalError, frame, undefined)).toBe(predicate);
      expect(failures.get(generic.runId)).toEqual(original);
      // The persisted consumer reads ordinary JSON, not the VM's foreign realm.
      expect(
        validInstalledPtyFailure(
          JSON.parse(JSON.stringify(failures.get(generic.runId))),
        ),
      ).toBe(true);
      record(
        plan,
        originalError,
        `${frame.trim()};claude-interactive-trace-smoke\n`,
        undefined,
      );
      expect(failures.get(plan.runId)).toEqual({
        ...original,
        scenarioId: plan.scenarioId,
      });
      record(
        plan,
        originalError,
        formatInteractiveChildDiagnostic(
          exit ? semanticPredicate : "testkit.pty.transport.exit",
          exit ? semanticFacts : undefined,
          exit ? undefined : 1,
        ),
        undefined,
      );
      expect(failures.get(plan.runId)).toEqual({ ...original, scenarioId });
    },
  );
});
describe("actual runner caught-failure diagnostic routing", () => {
  it.each([false, true])(
    "uses the existing private reader on the same caught error and preserves the predicate (exit=%s)",
    (exit) => {
      const predicate = exit ? "testkit.pty.transport.exit" : semanticPredicate;
      const source = readIntegration("runner.mjs");
      const caught = source.indexOf(
        "} catch (error) {\n  emitCodexPtyFailureHint();",
      );
      const start = source.indexOf(
        '  if (scenario.executionMode === "interactive")',
        caught,
      );
      const end = source.indexOf(
        '  if (\n    scenario.executionMode === "headless"',
        start,
      );
      expect(caught).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const error = new Error(predicate),
        frames: string[] = [];
      runInNewContext(
        `let interactiveFailureDiagnostic; ${source.slice(start, end)}`,
        {
          scenario: { executionMode: "interactive" },
          error,
          ledger: "/synthetic",
          readBoundedInteractiveFailureMarker: () => undefined,
          retainedInteractivePhase: () => undefined,
          selectInteractiveFailureDiagnostic: (
            _fixture: unknown,
            _phase: unknown,
            code: unknown,
          ) => code,
          readPtySemanticFailure: (caughtError: unknown) => {
            expect(caughtError).toBe(error);
            return exit ? undefined : semanticFacts;
          },
          readPtyExitSignal: (caughtError: unknown) => {
            expect(caughtError).toBe(error);
            return exit ? 1 : undefined;
          },
          formatInteractiveChildDiagnostic,
          process: { stdout: { write: (frame: string) => frames.push(frame) } },
        },
      );
      expect(frames).toEqual([
        formatInteractiveChildDiagnostic(
          predicate,
          exit ? undefined : semanticFacts,
          exit ? 1 : undefined,
        ),
      ]);
      expect(readInteractiveChildFailureObservation(frames[0])).toEqual({
        predicate,
        ...(exit ? { exitSignal: 1 } : { semanticFailure: semanticFacts }),
      });
    },
  );
});

const hex = (character: string): string => character.repeat(64);

const completed = {
  outcome: "completed",
  finalSnapshot: { semanticState: "completed" },
  exitCode: 0,
  signal: null,
  cleanup: "clean",
  residualProcessCount: 0,
  processJoined: true,
  terminalInputJoined: true,
  terminalOutputJoined: true,
  terminalTransportClosed: true,
};

describe("Codex machine-output failure containment", () => {
  const command = "agentscope uninstall";
  const valid = Buffer.from(
    JSON.stringify({
      command,
      completion: "complete",
      records: [{ ok: true }],
    }),
  );

  it("returns only records from one valid closed envelope", () => {
    expect(parseCodexMachineOutput(valid, command)).toEqual([{ ok: true }]);
  });

  it.each([
    ["invalid-utf8", Buffer.from([0xff])],
    ["invalid-json", Buffer.from("not-json")],
    [
      "missing-records",
      Buffer.from(JSON.stringify({ command, completion: "complete" })),
    ],
    [
      "wrong-command",
      Buffer.from(
        JSON.stringify({
          command: "other",
          completion: "complete",
          records: [],
        }),
      ),
    ],
    ["oversized", Buffer.alloc(1024 * 1024 + 1)],
    ["wrong-type", "not-a-buffer"],
  ] as const)(
    "collapses %s output to one content-free code",
    (_label, bytes) => {
      expect(() => parseCodexMachineOutput(bytes, command)).toThrow(
        "integration.codex.cli-output",
      );
    },
  );
});

describe("historical Codex PTY readiness", () => {
  it("uses only the completed challenged topology checkpoint as historical Codex readiness", () => {
    const actions = [
      { action: "input" },
      {
        action: "checkpoint-process-topology",
        topology: "root-with-contained-process-set",
      },
      { action: "wait-for-semantic-completion" },
    ];
    const historical = {
      ...completed,
      scenarioId: "codex-tui-trace-smoke",
      readinessObserved: false,
      request: {
        readiness: { kind: "challenge-styled-text" },
        interaction: { trigger: "immediate", actions },
      },
      actions,
    };
    expect(interactivePtyArtifactReadinessMatches(historical)).toBe(true);
    expect(interactivePtyArtifactReadinessMatches(historical, true)).toBe(
      false,
    );
    const rejected = [
      { ...historical, scenarioId: "fixture-process-interactive" },
      {
        ...historical,
        request: {
          ...historical.request,
          readiness: { kind: "challenge-marker" },
        },
      },
      {
        ...historical,
        request: {
          ...historical.request,
          interaction: { trigger: "semantic-ready", actions },
        },
      },
      { ...historical, actions: actions.slice(0, 2) },
      {
        ...historical,
        actions: actions.filter(
          ({ action }) => action !== "checkpoint-process-topology",
        ),
      },
      {
        ...historical,
        request: {
          ...historical.request,
          interaction: {
            trigger: "immediate",
            actions: [actions[0], actions[2]],
          },
        },
        actions: [actions[0], actions[2]],
      },
      {
        ...historical,
        request: {
          ...historical.request,
          interaction: {
            trigger: "immediate",
            actions: [actions[0], actions[1], actions[1], actions[2]],
          },
        },
        actions: [actions[0], actions[1], actions[1], actions[2]],
      },
      {
        ...historical,
        actions: [
          actions[0],
          { ...actions[1], topology: "substituted" },
          actions[2],
        ],
      },
      { ...historical, cleanup: "uncertain" },
      { ...historical, exitCode: 1 },
      { ...historical, finalSnapshot: null },
      { ...historical, readinessObserved: undefined },
    ];
    for (const receipt of rejected)
      expect(interactivePtyArtifactReadinessMatches(receipt)).toBe(false);
  });
});

describe("interactive PTY artifact diagnostics", () => {
  it("reports only fixed readiness and terminal categories", () => {
    const secret = "do-not-print-this-receipt-content";
    expect(
      interactivePtyReadinessRejectionDiagnostic({
        ...completed,
        readinessObserved: false,
        request: { interaction: { trigger: "semantic-ready" } },
        output: secret,
      }),
    ).toBe(
      "entry-normal:readiness-false:terminal-completed:trigger-semantic-ready",
    );
    expect(
      interactivePtyReadinessRejectionDiagnostic(
        {
          ...completed,
          outcome: "deadline",
          readinessObserved: false,
          request: { interaction: { trigger: "immediate" } },
        },
        true,
      ),
    ).toBe("entry-failed:readiness-false:terminal-failed:trigger-immediate");
    const malformed = interactivePtyReadinessRejectionDiagnostic({
      readinessObserved: secret,
      request: { interaction: { trigger: secret } },
      output: secret,
    });
    expect(malformed).toBe(
      "entry-normal:readiness-invalid:terminal-invalid:trigger-invalid",
    );
    expect(malformed).not.toContain(secret);
  });
  it("requires readiness for success but retains a false observation for a settled failure", () => {
    const unreadyFailure = {
      ...completed,
      outcome: "deadline",
      finalSnapshot: { semanticState: "active" },
      readinessObserved: false,
    };
    expect(interactivePtyArtifactReadinessMatches(unreadyFailure, true)).toBe(
      true,
    );
    expect(interactivePtyArtifactReadinessMatches(unreadyFailure)).toBe(false);
    expect(
      interactivePtyArtifactReadinessMatches(
        { ...completed, readinessObserved: false },
        true,
      ),
    ).toBe(false);
    for (const invalid of [undefined, null, 0, "false"])
      expect(
        interactivePtyArtifactReadinessMatches(
          { ...unreadyFailure, readinessObserved: invalid },
          true,
        ),
      ).toBe(false);
  });
  it("classifies only the first failed artifact field without emitting its content", () => {
    const predicates = {
      "process-fingerprint": () => true,
      "input-bytes": () => true,
      "input-digest": () => true,
      readiness: () => true,
      interpreter: () => true,
      "script-digest": () => true,
    };
    expect(interactivePtyArtifactRejectionCode(predicates)).toBeNull();
    for (const field of Object.keys(predicates))
      expect(
        interactivePtyArtifactRejectionCode({
          ...predicates,
          [field]: () => false,
        }),
      ).toBe(field);
    expect(
      interactivePtyArtifactRejectionCode({
        ...predicates,
        "input-bytes": () => false,
        readiness: () => false,
      }),
    ).toBe("input-bytes");
  });
});

describe("untrusted Codex trace hint transport", () => {
  it.each([
    "hook-deadline",
    "reporter-child",
    "search-child-deadline",
    "search-child-exit-5",
    "search-child-exit-other",
    "search-child-signal",
    "search-child-output-limit",
    "search-hook-log",
    "search-other",
  ])("extracts one closed content-free hint: %s", (hint) => {
    const line = `integration.runner.untrusted-trace-hint:${hint}\n`;
    expect(extractUntrustedCodexTraceHint(line)).toBe(hint);
    for (const output of [
      `${line}${line}`,
      `${line}integration.runner.untrusted-trace-hint:other\n`,
      `x:${line}`,
      `integration.runner.untrusted-trace-hint:${hint}-extra\n`,
      `integration.runner.untrusted-trace-hint:${hint}:secret\n`,
    ])
      expect(extractUntrustedCodexTraceHint(output)).toBeUndefined();
  });
  it("rejects non-text and oversized attached output", () => {
    expect(extractUntrustedCodexTraceHint(undefined)).toBeUndefined();
    expect(
      extractUntrustedCodexTraceHint("x".repeat(16 * 1024 * 1024 + 1)),
    ).toBeUndefined();
  });
});

describe("untrusted Codex candidate configuration hint transport", () => {
  it.each(["closed-marker", "render", "create", "open", "prove", "publish"])(
    "extracts one bounded progress hint without admission: %s",
    (stage) => {
      const line = `integration.runner.untrusted-config-hint:${stage}\n`;
      expect(extractUntrustedCodexConfigHint(line)).toBe(stage);
      for (const output of [
        `${line}${line}`,
        `${line}integration.runner.untrusted-config-hint:other\n`,
        `x:${line}`,
        `integration.runner.untrusted-config-hint:${stage}-extra\n`,
        `integration.runner.untrusted-config-hint:${stage}:secret\n`,
      ])
        expect(extractUntrustedCodexConfigHint(output)).toBeUndefined();
      expect(
        selectInteractiveExecutionFailurePredicate(
          `integration.fixture.codex-candidate-config-${stage}`,
          undefined,
          "fixture-process-interactive",
        ),
      ).toBe("child-failure");
      expect(
        selectInteractiveExecutionFailurePredicate(
          `integration.fixture.codex-candidate-config-${stage}`,
          undefined,
          "codex-tui-trace-smoke",
        ),
      ).toBe("child-failure");
    },
  );
  it("rejects non-text and oversized attached output", () => {
    expect(extractUntrustedCodexConfigHint(undefined)).toBeUndefined();
    expect(
      extractUntrustedCodexConfigHint("x".repeat(16 * 1024 * 1024 + 1)),
    ).toBeUndefined();
  });
});

describe("untrusted Codex model-gate research hint transport", () => {
  it.each([
    [new Error("integration.codex.deadline"), "arm-deadline"],
    [new Error("integration.codex.clock"), "arm-clock"],
    [new Error("integration.codex.failure-phase"), "arm-phase"],
    [new Error("integration.codex.hook-log"), "arm-hook-log"],
    [new Error("integration.codex.hook-lifecycle"), "arm-hook-lifecycle"],
    [new Error("integration.codex.hook-mediation"), "arm-hook-mediation"],
    [
      new Error("integration.codex.hook-session-start-missing"),
      "arm-session-missing",
    ],
    [new Error("integration.codex.model-gate"), "arm-control"],
    [new Error("integration.codex.child"), "arm-child"],
    [
      Object.assign(new Error("untrusted path"), { code: "ENOSPC" }),
      "arm-filesystem",
    ],
    [new Error("secret-bearing unrecognized error"), "arm-other"],
    [null, "arm-other"],
  ])(
    "classifies an arm exception without retaining its text: %s",
    (error, hint) => {
      expect(codexArmPendingResearchHint(error)).toBe(hint);
      expect(
        extractUntrustedCodexGateHint(
          `integration.runner.untrusted-gate-hint:${hint}\n`,
        ),
      ).toBe(hint);
    },
  );
  it("collapses a hostile thrown object without invoking its content", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error("secret");
        },
      },
    );
    expect(codexArmPendingResearchHint(hostile)).toBe("arm-other");
  });
  it.each([
    "arm-log-unavailable",
    "arm-log-invalid",
    "arm-hook-unseen",
    "arm-hook-open",
    "arm-hook-completed",
    "seal-deadline",
    "seal-request",
    "receipt-shape",
    "ledger-shape",
  ])("retains one closed failure hint without admission: %s", (hint) => {
    const line = `integration.runner.untrusted-gate-hint:${hint}\n`;
    expect(extractUntrustedCodexGateHint(line)).toBe(hint);
    for (const output of [
      `${line}${line}`,
      `${line}integration.runner.untrusted-gate-hint:other\n`,
      `x:${line}`,
      `integration.runner.untrusted-gate-hint:${hint}-extra\n`,
      `integration.runner.untrusted-gate-hint:${hint}:secret\n`,
    ])
      expect(extractUntrustedCodexGateHint(output)).toBeUndefined();
    expect(
      selectInteractiveExecutionFailurePredicate(
        `integration.fixture.codex-gate-research-${hint}`,
        undefined,
        "codex-tui-trace-smoke",
      ),
    ).toBe("child-failure");
  });
  it("rejects non-text and oversized attached output", () => {
    expect(extractUntrustedCodexGateHint(undefined)).toBeUndefined();
    expect(
      extractUntrustedCodexGateHint("x".repeat(16 * 1024 * 1024 + 1)),
    ).toBeUndefined();
  });
});

describe("rejected Codex model-gate receipt classification", () => {
  const expected = {
    challengeSha256: "a".repeat(64),
    runId: "run-1",
    sessionStartSpanSha256: "b".repeat(64),
  };
  const connection = {
    admission: "admitted",
    closed: true,
    eof: true,
    generation: 1,
    parserOutcome: "accepted",
    parserTransportClosed: true,
    rawForwardedBytes: 4,
    rawRejectedBytes: 0,
    responseBytes: 8,
  };
  const receipt = {
    ...expected,
    connectionCount: 1,
    connections: [connection],
    cutoffUnsettled: false,
    ledgerCount: 1,
    mutationGeneration: 1,
    parserFailures: 0,
    state: "draining",
  };
  it.each([
    [null, "receipt-shape"],
    [{ ...receipt, extra: "secret" }, "receipt-shape"],
    [{ ...receipt, cutoffUnsettled: true }, "cutoff-unsettled"],
    [{ ...receipt, state: "admitted" }, "state"],
    [{ ...receipt, connectionCount: 2 }, "connection-count"],
    [{ ...receipt, connections: [{}] }, "connection-shape"],
    [
      { ...receipt, connections: [{ ...connection, admission: "denied" }] },
      "admission",
    ],
    [
      { ...receipt, connections: [{ ...connection, closed: false }] },
      "connection-open",
    ],
    [
      { ...receipt, connections: [{ ...connection, generation: 2 }] },
      "generation",
    ],
    [
      { ...receipt, connections: [{ ...connection, parserOutcome: "failed" }] },
      "parser-outcome",
    ],
    [
      {
        ...receipt,
        connections: [{ ...connection, parserTransportClosed: false }],
      },
      "parser-open",
    ],
    [
      { ...receipt, connections: [{ ...connection, rawRejectedBytes: 1 }] },
      "raw-rejected",
    ],
    [
      { ...receipt, connections: [{ ...connection, responseBytes: 0 }] },
      "transport-bytes",
    ],
    [{ ...receipt, ledgerCount: 2 }, "ledger-count"],
    [{ ...receipt, parserFailures: 1 }, "parser-failures"],
    [{ ...receipt, mutationGeneration: 0 }, "mutation-generation"],
    [{ ...receipt, runId: "other" }, "identity"],
    [receipt, "other"],
  ])(
    "labels one rejected receipt without exposing values: %s",
    (candidate, hint) => {
      expect(gateReceiptResearchRejection(candidate, expected)).toBe(hint);
    },
  );
});

describe("Codex failure exit comparison", () => {
  it("keeps exact fixture and authenticated terminal container codes separate", () => {
    expect(codexFailureExitPair(150, 78, "codex-tui-trace-smoke")).toBe(
      "150:78",
    );
    expect(codexFailureExitPair(undefined, 78, "codex-tui-trace-smoke")).toBe(
      "none:78",
    );
  });
  it.each([
    [150, 78, "fixture-process-interactive"],
    [150, 0, "codex-tui-trace-smoke"],
    [150, 256, "codex-tui-trace-smoke"],
    [150, "78", "codex-tui-trace-smoke"],
  ])("rejects a non-Codex or invalid terminal witness", (child, outer, id) => {
    expect(codexFailureExitPair(child, outer, id)).toBeUndefined();
  });
});

describe("bounded research-only Codex failure evidence", () => {
  const valid = {
    diagnosticVersion: 3,
    untrustedConfigHint: "render",
    untrustedGateHint: "receipt-shape",
    untrustedPtyHint: "arm-pty-reconciliation",
    exitPair: "150:78",
  };
  it("accepts only the exact bounded record or null", () => {
    expect(validCodexResearchDiagnostic(null)).toBe(true);
    expect(validCodexResearchDiagnostic(valid)).toBe(true);
    expect(
      validCodexResearchDiagnostic({
        diagnosticVersion: 1,
        untrustedConfigHint: "render",
        exitPair: "150:78",
      }),
    ).toBe(true);
    expect(
      validCodexResearchDiagnostic({
        diagnosticVersion: 2,
        untrustedConfigHint: null,
        untrustedGateHint: null,
        exitPair: "none:255",
      }),
    ).toBe(true);
  });
  it.each([
    { ...valid, untrustedConfigHint: "secret" },
    { ...valid, untrustedGateHint: "secret" },
    { ...valid, untrustedPtyHint: "secret" },
    { ...valid, exitPair: "150:0" },
    { ...valid, exitPair: "256:78" },
    { ...valid, extra: true },
    { ...valid, diagnosticVersion: 1 },
    { ...valid, untrustedConfigHint: "render\nsecret" },
  ])("rejects substituted or expanded diagnostic authority", (record) => {
    expect(validCodexResearchDiagnostic(record)).toBe(false);
  });
});

describe("Codex selected PTY failure classification", () => {
  it.each([
    ["testkit.headless.reconciliation.deadline", "arm-pty-reconciliation"],
    ["testkit.headless.startup.deadline", "arm-pty-startup"],
    ["testkit.pty.transport", "arm-pty-transport"],
    ["testkit.headless.kernel.failure", "arm-pty-kernel"],
    ["unexpected private error", "arm-pty-other"],
  ])("publishes only a closed category for %s", (message, expected) => {
    const hint = codexArmPtyResearchHint(new Error(message));
    expect(hint).toBe(expected);
    expect(
      extractUntrustedCodexPtyHint(
        `integration.runner.untrusted-pty-hint:${hint}\n`,
      ),
    ).toBe(expected);
  });

  it("keeps the PTY error and hook state independently observable", () => {
    const output =
      "integration.runner.untrusted-gate-hint:arm-hook-unseen\n" +
      "integration.runner.untrusted-pty-hint:arm-pty-reconciliation\n";
    expect(extractUntrustedCodexGateHint(output)).toBe("arm-hook-unseen");
    expect(extractUntrustedCodexPtyHint(output)).toBe("arm-pty-reconciliation");
    expect(
      validCodexResearchDiagnostic({
        diagnosticVersion: 3,
        untrustedConfigHint: null,
        untrustedGateHint: extractUntrustedCodexGateHint(output),
        untrustedPtyHint: extractUntrustedCodexPtyHint(output),
        exitPair: "none:1",
      }),
    ).toBe(true);
  });

  it("rejects duplicate or substituted PTY hints", () => {
    const line = "integration.runner.untrusted-pty-hint:arm-pty-kernel\n";
    for (const output of [
      `${line}${line}`,
      `${line}integration.runner.untrusted-pty-hint:arm-pty-other\n`,
      "integration.runner.untrusted-pty-hint:secret\n",
      `prefix:${line}`,
    ])
      expect(extractUntrustedCodexPtyHint(output)).toBeUndefined();
  });

  it("contains a hostile thrown object", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error("private content");
        },
      },
    );
    expect(codexArmPtyResearchHint(hostile)).toBe("arm-pty-other");
  });
});

describe("interactive PTY receipt settlement", () => {
  it("admits retained success evidence only for an exact completed receipt", () => {
    expect(interactivePtyReceiptFailed(completed)).toBe(false);
  });

  it.each([92, 93])(
    "classifies a semantically complete fixture exit %i as failure before success evidence",
    (exitCode) => {
      expect(
        interactivePtyReceiptFailed({
          ...completed,
          outcome: "exited-nonzero",
          exitCode,
        }),
      ).toBe(true);
    },
  );

  it("rejects conflicting terminal status despite semantic completion", () => {
    expect(interactivePtyReceiptFailed({ ...completed, exitCode: 92 })).toBe(
      true,
    );
    expect(interactivePtyReceiptFailed({ ...completed, signal: 9 })).toBe(true);
  });

  it("accepts a late non-completed receipt only for failure diagnosis with every authority check", () => {
    const checks = {
      envelope: true,
      process: true,
      geometry: true,
      artifact: true,
      fingerprint: true,
    };
    const lateFailure = {
      ...completed,
      outcome: "deadline",
      exitCode: 32,
      finalSnapshot: { semanticState: "active" },
      returnedAtMs: 150,
      request: { process: { monotonicShutdownDeadlineMs: 100 } },
    };
    expect(
      interactivePtyReceiptAuthorityMatches(lateFailure, checks, true),
    ).toBe(true);
    expect(interactivePtyReceiptAuthorityMatches(lateFailure, checks)).toBe(
      false,
    );
    for (const key of [
      "fingerprint",
      "geometry",
      "artifact",
      "process",
      "envelope",
    ] as const)
      expect(
        interactivePtyReceiptAuthorityMatches(
          lateFailure,
          { ...checks, [key]: false },
          true,
        ),
      ).toBe(false);
    const timelySuccess = {
      ...completed,
      returnedAtMs: 50,
      request: { process: { monotonicShutdownDeadlineMs: 100 } },
    };
    expect(interactivePtyReceiptAuthorityMatches(timelySuccess, checks)).toBe(
      true,
    );
    expect(
      interactivePtyReceiptAuthorityMatches(timelySuccess, checks, true),
    ).toBe(false);
  });
});

describe("interactive PTY readiness progress diagnostics", () => {
  it("reduces failed readiness to fixed content-free categories", () => {
    const receipt = {
      outputBytes: 256,
      readinessObserved: false,
      finalSnapshot: {
        printableCellCount: 12,
        nonEmptyLineCount: 2,
        sawCursorPositionQuery: false,
        semanticState: "active",
        screenText: "never-print",
      },
    };
    expect(interactivePtyReadinessProgressDiagnostic(receipt)).toBe(
      "integration.isolation.pty-readiness-progress:output-present:printable-present:lines-present:cursor-query-absent:readiness-absent:semantic-active",
    );
    expect(
      interactivePtyReadinessProgressDiagnostic({
        ...receipt,
        challengedReadinessProgress: {
          marker: true,
          synchronizedFrame: true,
          styledGlyph: false,
          requiredText: false,
          terminalProtocol: "rejected",
          protocolRejectionKind: "order",
          protocolRejectedAtPhase: 1,
          protocolRejectedStep: 4,
          protocolRejectedModePrefix: null,
          protocolRejectedModeValue: null,
          readinessEverObserved: false,
          screenRevoked: true,
        },
      }),
    ).toBe(
      "integration.isolation.pty-readiness-progress:output-present:printable-present:lines-present:cursor-query-absent:readiness-absent:semantic-active:marker-observed:frame-observed:glyph-absent:prompt-absent:protocol-rejected:protocol-rejection-order-1-4:ever-ready-absent:screen-revoked",
    );
    expect(
      interactivePtyReadinessProgressDiagnostic({
        ...receipt,
        outputBytes: 0,
        readinessObserved: true,
        finalSnapshot: {
          ...receipt.finalSnapshot,
          printableCellCount: 0,
          nonEmptyLineCount: 0,
          sawCursorPositionQuery: true,
          semanticState: "ready",
        },
      }),
    ).toBe(
      "integration.isolation.pty-readiness-progress:output-absent:printable-absent:lines-absent:cursor-query-observed:readiness-observed:semantic-ready",
    );
    for (const malformed of [
      { ...receipt, outputBytes: -1 },
      { ...receipt, readinessObserved: "true" },
      {
        ...receipt,
        challengedReadinessProgress: {
          marker: true,
          synchronizedFrame: true,
          styledGlyph: false,
          requiredText: false,
          terminalProtocol: "unknown",
          protocolRejectionKind: "none",
          protocolRejectedAtPhase: null,
          protocolRejectedStep: null,
          protocolRejectedModePrefix: null,
          protocolRejectedModeValue: null,
          readinessEverObserved: false,
          screenRevoked: true,
        },
      },
      {
        ...receipt,
        challengedReadinessProgress: {
          marker: true,
          synchronizedFrame: true,
          styledGlyph: false,
          requiredText: false,
          terminalProtocol: "rejected",
          protocolRejectionKind: "order",
          protocolRejectedAtPhase: 1,
          protocolRejectedStep: 2,
          protocolRejectedModePrefix: null,
          protocolRejectedModeValue: null,
          readinessEverObserved: false,
          screenRevoked: true,
        },
      },
      {
        ...receipt,
        finalSnapshot: { ...receipt.finalSnapshot, printableCellCount: -1 },
      },
      {
        ...receipt,
        finalSnapshot: {
          ...receipt.finalSnapshot,
          semanticState: "never-print",
        },
      },
    ])
      expect(
        interactivePtyReadinessProgressDiagnostic(malformed),
      ).toBeUndefined();
  });
});

it("reports only bounded CSI-u mode and historical readiness facts", () => {
  expect(
    interactivePtyReadinessProgressDiagnostic({
      outputBytes: 1,
      readinessObserved: false,
      finalSnapshot: {
        printableCellCount: 1,
        nonEmptyLineCount: 1,
        sawCursorPositionQuery: false,
        semanticState: "completed",
      },
      challengedReadinessProgress: {
        marker: true,
        synchronizedFrame: true,
        styledGlyph: true,
        requiredText: true,
        terminalProtocol: "rejected",
        protocolRejectionKind: "mode",
        protocolRejectedAtPhase: 6,
        protocolRejectedStep: null,
        protocolRejectedModePrefix: "less",
        protocolRejectedModeValue: 1,
        readinessEverObserved: true,
        screenRevoked: false,
      },
      checkpointProgressDiagnostic: "topology-nonroot-missing",
    }),
  ).toContain(
    ":protocol-rejection-mode-6-less-1:ever-ready-observed:screen-intact:checkpoint-topology-nonroot-missing",
  );
});

it("rejects an unclosed checkpoint diagnostic before logging", () => {
  expect(
    interactivePtyReadinessProgressDiagnostic({
      outputBytes: 1,
      readinessObserved: false,
      checkpointProgressDiagnostic: "raw-terminal-content",
      finalSnapshot: {
        printableCellCount: 1,
        nonEmptyLineCount: 1,
        sawCursorPositionQuery: false,
        semanticState: "active",
      },
    }),
  ).toBeUndefined();
});

it("rejects impossible historical readiness diagnostics", () => {
  const challenged = {
    marker: false,
    synchronizedFrame: true,
    styledGlyph: true,
    requiredText: true,
    terminalProtocol: "complete",
    protocolRejectionKind: "none",
    protocolRejectedAtPhase: null,
    protocolRejectedStep: null,
    protocolRejectedModePrefix: null,
    protocolRejectedModeValue: null,
    readinessEverObserved: true,
    screenRevoked: false,
  };
  expect(
    interactivePtyReadinessProgressDiagnostic({
      outputBytes: 1,
      readinessObserved: false,
      finalSnapshot: {
        printableCellCount: 1,
        nonEmptyLineCount: 1,
        sawCursorPositionQuery: false,
        semanticState: "active",
      },
      challengedReadinessProgress: challenged,
    }),
  ).toBeUndefined();
});

describe("interactive PTY action prefix diagnostics", () => {
  it("emits only bounded counts for an authenticated failed-action prefix", () => {
    const requested = [
      { action: "resize" },
      { action: "input", secret: "never-print" },
      { action: "wait-for-semantic-completion" },
    ];
    expect(
      interactivePtyActionPrefixDiagnostic({
        actions: requested.slice(0, 2),
        request: { interaction: { actions: requested } },
      }),
    ).toBe("integration.isolation.pty-action-prefix:2/3");
    expect(
      interactivePtyActionPrefixDiagnostic({
        actions: [{ action: "input" }],
        request: { interaction: { actions: requested } },
      }),
    ).toBeUndefined();
    expect(
      interactivePtyActionPrefixDiagnostic({
        actions: [],
        request: {
          interaction: {
            actions: Array.from({ length: 33 }, () => ({ action: "input" })),
          },
        },
      }),
    ).toBeUndefined();
  });

  it("prints only closed post-submission idle categories from a failed receipt", () => {
    const receipt = {
      request: {
        readiness: { kind: "challenge-styled-text" },
        interaction: {
          actions: [{ action: "wait-for-post-submission-idle-prompt" }],
        },
      },
      postSubmissionIdleDiagnostic: "response-not-observed",
      postSubmissionIdleAtTitleDiagnostic: "idle-ready",
    };
    expect(interactivePtyIdleObservationDiagnostic(receipt)).toBe(
      "integration.isolation.pty-idle-diagnostic:response-not-observed",
    );
    expect(interactivePtyIdleAtTitleDiagnostic(receipt)).toBe(
      "integration.isolation.pty-idle-at-title:idle-ready",
    );
    for (const category of [
      "idle-revoked-screen",
      "idle-revoked-alternate-screen-enter",
      "idle-revoked-alternate-screen-exit",
      "idle-revoked-autowrap-enable",
      "idle-revoked-autowrap-disable",
      "idle-revoked-scroll-region",
      "idle-revoked-screen-edit",
    ])
      expect(
        interactivePtyIdleAtTitleDiagnostic({
          ...receipt,
          postSubmissionIdleAtTitleDiagnostic: category,
        }),
      ).toBe(`integration.isolation.pty-idle-at-title:${category}`);
    for (const substituted of [
      "terminal-content\nspoofed-output",
      "\u001b[31mredacted\u001b[0m",
      { toString: () => "secret" },
      null,
      undefined,
    ])
      expect(
        interactivePtyIdleObservationDiagnostic({
          ...receipt,
          postSubmissionIdleDiagnostic: substituted,
        }),
      ).toBe("integration.isolation.pty-idle-diagnostic:missing-or-invalid");
    for (const substituted of [
      "terminal-content\nspoofed-output",
      "\u001b[31mredacted\u001b[0m",
      { toString: () => "secret" },
      null,
      undefined,
    ])
      expect(
        interactivePtyIdleAtTitleDiagnostic({
          ...receipt,
          postSubmissionIdleAtTitleDiagnostic: substituted,
        }),
      ).toBe("integration.isolation.pty-idle-at-title:missing-or-invalid");
    expect(
      interactivePtyIdleObservationDiagnostic({
        ...receipt,
        request: {
          ...receipt.request,
          readiness: { kind: "semantic-marker" },
        },
      }),
    ).toBeUndefined();
  });
});

describe("Codex trace cutoff ordering", () => {
  it("keeps the selected PTY alive through the actual Codex trace cutoff", () => {
    expect(
      interactivePtyExecutionReserveMilliseconds("codex-tui-trace-smoke"),
    ).toBe(5_000);
    for (const other of ["fixture-process-interactive", "", undefined])
      expect(interactivePtyExecutionReserveMilliseconds(other)).toBe(5_000);

    const runner = readIntegration("runner.mjs");
    expect(runner).toContain(
      "receipt[key] === undefined ? {} : { [key]: receipt[key] }",
    );
    expect(
      [
        ...runner.matchAll(/\.\.\.optionalReceiptDiagnostic\("([^"]+)"\)/gu),
      ].map((match) => match[1]),
    ).toEqual([
      "pumpFailureDiagnostic",
      "challengedReadinessProgress",
      "checkpointProgressDiagnostic",
      "postSubmissionIdleDiagnostic",
      "postSubmissionIdleAtTitleDiagnostic",
    ]);
    const controller = readIntegration("run-scenarios.mjs");
    const fixture = readIntegration("codex-pty-scenario.mjs");
    const runnerReserve = runner.match(
      /AGENTSCOPE_SCENARIO_BOOT_DEADLINE_MS: String\(headlessOuterDeadline - ([\d_]+)\)/u,
    )?.[1];
    const controllerReserve = controller.match(
      /AGENTSCOPE_SCENARIO_BOOT_DEADLINE_MS: String\(\s*outerMonotonicDeadlineMs - ([\d_]+),?\s*\)/u,
    )?.[1];
    const traceReserve = fixture.match(
      /const traceDeadline = deadline - ([\d_]+);/u,
    )?.[1];
    expect(runnerReserve).toBeDefined();
    expect(controllerReserve).toBe(runnerReserve);
    expect(traceReserve).toBeDefined();
    const traceCutoffReserve =
      Number(runnerReserve?.replaceAll("_", "")) +
      Number(traceReserve?.replaceAll("_", ""));
    expect(traceCutoffReserve).toBe(8_000);
    expect(
      traceCutoffReserve -
        interactivePtyExecutionReserveMilliseconds("codex-tui-trace-smoke"),
    ).toBeGreaterThanOrEqual(3_000);
  });
});

describe("interactive PTY action matching", () => {
  it("requires full successful PTY actions but an exact failure prefix", () => {
    const expected = [
      { action: "resize" },
      { action: "input" },
      { action: "wait-for-semantic-completion" },
      { action: "input" },
    ];
    expect(interactivePtyObservedActionsMatch(expected, expected)).toBe(true);
    expect(
      interactivePtyObservedActionsMatch(expected.slice(0, 2), expected),
    ).toBe(false);
    expect(
      interactivePtyObservedActionsMatch(expected.slice(0, 2), expected, true),
    ).toBe(true);
    expect(interactivePtyObservedActionsMatch([], expected, true)).toBe(true);
    expect(
      interactivePtyObservedActionsMatch([{ action: "input" }], expected, true),
    ).toBe(false);
    expect(
      interactivePtyObservedActionsMatch(
        [...expected, { action: "input" }],
        expected,
        true,
      ),
    ).toBe(false);
    expect(interactivePtyObservedActionsMatch(null, expected, true)).toBe(
      false,
    );
    expect(interactivePtyObservedActionsMatch([null], expected, true)).toBe(
      false,
    );
  });
});

describe("interactive PTY receipt rejection diagnostics", () => {
  it("uses closed envelope field names and stops at the first failed field", () => {
    const calls: string[] = [];
    const fields = [
      "identity",
      "deadline",
      "completion",
      "readiness",
      "trigger",
      "requested-actions",
      "observed-actions",
      "terminal-action",
      "tty",
      "canonical-mode",
    ];
    const predicates = Object.fromEntries(
      fields.map((field) => [
        field,
        () => {
          calls.push(field);
          return field !== "readiness";
        },
      ]),
    );
    expect(interactivePtyEnvelopeRejectionCode(predicates)).toBe("readiness");
    expect(calls).toEqual(["identity", "deadline", "completion", "readiness"]);
    expect(interactivePtyEnvelopeRejectionCode({})).toBe("identity");
    const passing = Object.fromEntries(
      fields.map((field) => [field, () => true]),
    );
    expect(interactivePtyEnvelopeRejectionCode(passing)).toBeNull();
    for (const field of fields)
      expect(
        interactivePtyEnvelopeRejectionCode({
          ...passing,
          [field]: () => false,
        }),
      ).toBe(field);
  });

  it("keeps a late exact envelope only for failure diagnosis", () => {
    expect(interactivePtyEnvelopeDeadlineMatches(100, 100, 99)).toBe(true);
    expect(interactivePtyEnvelopeDeadlineMatches(100, 100, 100)).toBe(false);
    expect(interactivePtyEnvelopeDeadlineMatches(100, 100, 101)).toBe(false);
    expect(interactivePtyEnvelopeDeadlineMatches(100, 100, 101, true)).toBe(
      true,
    );
    expect(interactivePtyEnvelopeDeadlineMatches(99, 100, 101, true)).toBe(
      false,
    );
    expect(interactivePtyEnvelopeDeadlineMatches(101, 100, 101, true)).toBe(
      false,
    );
  });

  it("classifies rejected receipt authority with closed content-free codes", () => {
    const checks = {
      envelope: true,
      process: true,
      geometry: true,
      artifact: true,
      fingerprint: true,
    };
    const failed = {
      ...completed,
      outcome: "deadline",
      finalSnapshot: { semanticState: "active" },
    };
    expect(interactivePtyReceiptRejectionCode(failed, checks, true)).toBeNull();
    expect(interactivePtyReceiptRejectionCode(completed, checks, true)).toBe(
      "terminal-state",
    );
    for (const key of Object.keys(checks))
      expect(
        interactivePtyReceiptRejectionCode(
          failed,
          { ...checks, [key]: false },
          true,
        ),
      ).toBe(key);
    expect(
      interactivePtyReceiptRejectionCode(
        failed,
        {
          ...checks,
          envelope: false,
          fingerprint: false,
        },
        true,
      ),
    ).toBe("envelope");
    expect(
      interactivePtyReceiptRejectionCode(
        { ...completed, finalSnapshot: null },
        checks,
        true,
      ),
    ).toBe("terminal-state");
  });
});

describe("interactive failure diagnostic precedence", () => {
  it("retains an exact fixture cause ahead of the last progress phase", () => {
    expect(
      selectInteractiveFailureDiagnostic(
        "integration.fixture.codex-model-gate-arm-control",
        "integration.fixture.codex-model-gate-arm-start",
        "testkit.pty.receipt-terminal",
      ),
    ).toBe("integration.fixture.codex-model-gate-arm-control");
    expect(
      selectInteractiveFailureDiagnostic(
        "integration.fixture.codex-not-allowlisted",
        "integration.fixture.codex-model-gate-arm-health-pending",
        "testkit.pty.receipt-terminal",
      ),
    ).toBe("integration.fixture.codex-model-gate-arm-health-pending");
    expect(
      selectInteractiveFailureDiagnostic(
        undefined,
        undefined,
        "testkit.pty.receipt-terminal",
      ),
    ).toBe("testkit.pty.receipt-terminal");
  });
});
const candidate = () => ({
  evidenceVersion: 1,
  bundleIdentity: `sha256-${hex("a")}`,
  candidateRevision: "1".repeat(40),
  platform: { os: "linux", architecture: "x64", nodeVersion: "22.23.2" },
  lockfile: {
    fileName: "pnpm-lock.yaml",
    bytes: 3,
    sha256: `sha256-${hex("b")}`,
  },
  artifacts: [
    {
      id: "agentscope-cli",
      kind: "npm-tarball",
      fileName: "agentscope-cli.tgz",
      bytes: 7,
      sha256: `sha256-${hex("c")}`,
    },
  ],
  scenarioNetworkPolicy: "offline-no-package-or-registry-download",
});
const image = () => ({ Id: `sha256:${hex("d")}`, Config: { User: "node" } });
const plan = () => ({ runId: "0123456789abcdef", scenarioId: "codex-smoke" });
const compiled = () =>
  compileImmutableCandidateHandoff({
    candidate: candidate(),
    image: image(),
    plan: plan(),
  });
const expected = () => ({
  candidateBundleIdentity: candidate().bundleIdentity,
  candidateInventorySha256: compileCandidateInventory(candidate()).sha256,
  candidateRoot: "/opt/agentscope/prepared",
  ...plan(),
});
const controlVolume = (handoff: ReturnType<typeof compiled>) => ({
  name: `agentscope-int-${handoff.runId}-control`,
  mountpoint: "/var/lib/docker/volumes/control/_data",
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const container = (handoff: ReturnType<typeof compiled>): any => ({
  Image: handoff.imageId,
  Config: {
    User: "1000:1000",
    Env: [`AGENTSCOPE_IMMUTABLE_CANDIDATE_AUTHORITY=${handoff.encoded}`],
  },
  HostConfig: {
    ReadonlyRootfs: true,
    NetworkMode: "selected-network",
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
    Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=1024" },
  },
  Mounts: [
    {
      Type: "volume",
      Name: controlVolume(handoff).name,
      Source: controlVolume(handoff).mountpoint,
      Destination: "/control",
      RW: true,
    },
  ],
});
// eslint-disable-next-line max-lines-per-function -- one closed handoff and container adversarial matrix
describe("immutable candidate authority", () => {
  it("binds a canonical candidate inventory and closed handoff", () => {
    const handoff = compiled();
    expect(
      decodeImmutableCandidateHandoff(handoff.encoded, expected()),
    ).toEqual(expect.objectContaining(expected()));
    expect(selectedRuntimeFiles).toEqual(
      expect.arrayContaining([
        "testkit/bounded-terminal-emulator.js",
        "testkit/pty-terminal-contract.js",
        "testkit/pty-runtime/node127-linux-x64-glibc/pty.node",
        "testkit/pty-runtime/node127-linux-x64-musl/pty.node",
      ]),
    );
  });

  it.each(["missing", "extra", "malformed", "substituted"] as const)(
    "rejects %s handoff authority",
    (seed) => {
      const handoff = compiled();
      let encoded = handoff.encoded;
      if (seed === "missing") encoded = "";
      if (seed === "malformed") encoded = "not_base64+";
      if (seed === "substituted")
        encoded = compileImmutableCandidateHandoff({
          candidate: candidate(),
          image: image(),
          plan: { ...plan(), scenarioId: "other" },
        }).encoded;
      const expectedRecord = expected() as ReturnType<typeof expected> & {
        extra?: boolean;
      };
      if (seed === "extra") expectedRecord.extra = true;
      expect(() =>
        decodeImmutableCandidateHandoff(encoded, expectedRecord),
      ).toThrow("integration.immutable-candidate.authority");
    },
  );

  it("accepts only the exact read-only selected container and image", () => {
    const handoff = compiled();
    expect(
      validateImmutableScenarioContainer({
        container: container(handoff),
        controlVolume: controlVolume(handoff),
        handoff,
        image: image(),
        networkName: "selected-network",
        tmpfs: container(handoff).HostConfig.Tmpfs,
      }),
    ).toBe(true);
  });

  it.each(["codex-tui-trace-smoke", "claude-interactive-trace-smoke"])(
    "binds the exact %s controller profile without admitting a substitute capability",
    (scenarioId) => {
      const handoff = compileImmutableCandidateHandoff({
        candidate: candidate(),
        image: image(),
        plan: { ...plan(), scenarioId },
      });
      const selected = container(handoff);
      selected.Config.User = "0:0";
      selected.HostConfig.CapAdd = [
        "CAP_CHOWN",
        "CAP_DAC_OVERRIDE",
        "CAP_KILL",
        "CAP_SETGID",
        "CAP_SETUID",
      ];
      const controlVolume = {
        name: `agentscope-int-${handoff.runId}-control`,
        mountpoint: "/var/lib/docker/volumes/control/_data",
      };
      selected.Mounts = [
        {
          Type: "volume",
          Name: controlVolume.name,
          Source: controlVolume.mountpoint,
          Destination: "/control",
          RW: true,
        },
      ];
      const input = {
        container: selected,
        controlVolume,
        handoff,
        image: image(),
        networkName: "selected-network",
        tmpfs: selected.HostConfig.Tmpfs,
      };
      expect(validateImmutableScenarioContainer(input)).toBe(true);
      const foreign = compileImmutableCandidateHandoff({
        candidate: candidate(),
        image: image(),
        plan: { ...plan(), scenarioId: "claude-foreign-trace-smoke" },
      });
      const foreignContainer = container(foreign);
      foreignContainer.Config.User = "0:0";
      foreignContainer.HostConfig.CapAdd = selected.HostConfig.CapAdd;
      expect(() =>
        validateImmutableScenarioContainer({
          ...input,
          container: foreignContainer,
          handoff: foreign,
        }),
      ).toThrow("integration.immutable-candidate.authority");
      expect(() =>
        validateImmutableScenarioContainer({
          ...input,
          container: {
            ...selected,
            HostConfig: {
              ...selected.HostConfig,
              CapAdd: ["CHOWN", "DAC_OVERRIDE", "KILL", "SETGID", "SETUID"],
            },
          },
        }),
      ).toThrow("integration.immutable-candidate.authority");
      expect(() =>
        validateImmutableScenarioContainer({
          ...input,
          container: {
            ...selected,
            HostConfig: { ...selected.HostConfig, CapAdd: ["SETUID"] },
          },
        }),
      ).toThrow("integration.immutable-candidate.authority");
    },
  );

  it("rejects duplicate and non-closed candidate inventory entries", () => {
    const duplicate = candidate();
    duplicate.artifacts.push({
      id: duplicate.artifacts[0]!.id,
      kind: duplicate.artifacts[0]!.kind,
      fileName: duplicate.artifacts[0]!.fileName,
      bytes: duplicate.artifacts[0]!.bytes,
      sha256: duplicate.artifacts[0]!.sha256,
    });
    expect(() => compileCandidateInventory(duplicate)).toThrow(
      "integration.immutable-candidate.authority",
    );
    expect(() =>
      compileCandidateInventory({ ...candidate(), extra: true }),
    ).toThrow("integration.immutable-candidate.authority");
  });

  it.each(["duplicate-id", "count", "bytes", "id", "kind"] as const)(
    "rejects production candidate artifact %s substitution",
    (seed) => {
      const value = candidate();
      if (seed === "duplicate-id")
        value.artifacts.push({
          ...value.artifacts[0]!,
          fileName: "other.tgz",
        });
      if (seed === "count")
        value.artifacts = Array.from({ length: 33 }, (_, index) => ({
          ...value.artifacts[0]!,
          id: `artifact-${index}`,
          fileName: `artifact-${index}.tgz`,
        }));
      if (seed === "bytes") value.artifacts[0]!.bytes = 256 * 1024 * 1024 + 1;
      if (seed === "id") value.artifacts[0]!.id = "other";
      if (seed === "kind") value.artifacts[0]!.kind = "runtime-binary";
      expect(() => compileCandidateInventory(value)).toThrow(
        "integration.immutable-candidate.authority",
      );
    },
  );

  it.each([
    "image",
    "config",
    "user",
    "root-writable",
    "capability",
    "privilege",
    "mount",
    "handoff",
  ] as const)("rejects selected-container %s substitution", (seed) => {
    const handoff = compiled();
    const selected = structuredClone(container(handoff));
    const selectedImage = structuredClone(image());
    if (seed === "image") selected.Image = `sha256:${hex("e")}`;
    if (seed === "config") selectedImage.Config.User = "root";
    if (seed === "user") selected.Config.User = "0:0";
    if (seed === "root-writable") selected.HostConfig.ReadonlyRootfs = false;
    if (seed === "capability") selected.HostConfig.CapDrop = [];
    if (seed === "privilege") selected.HostConfig.SecurityOpt = [];
    if (seed === "mount") selected.Mounts = [{ Type: "bind" }];
    if (seed === "handoff") selected.Config.Env = [];
    expect(() =>
      validateImmutableScenarioContainer({
        container: selected,
        controlVolume: controlVolume(handoff),
        handoff,
        image: selectedImage,
        networkName: "selected-network",
        tmpfs: selected.HostConfig.Tmpfs,
      }),
    ).toThrow("integration.immutable-candidate.authority");
  });
});

describe("interactive PTY receipt transport", () => {
  const line = (value: unknown) =>
    `AGENTSCOPE_INTERACTIVE_PTY_RECEIPT=${Buffer.from(JSON.stringify(value)).toString("base64url")}`;

  it("accepts exactly one canonical bounded receipt record", () => {
    expect(decodeInteractivePtyReceipt(line({ receiptVersion: 1 }))).toEqual({
      receiptVersion: 1,
    });
  });

  it.each([
    "",
    `${line({ receiptVersion: 1 })}\n${line({ receiptVersion: 1 })}`,
    `${line({ receiptVersion: 1 })}\n${line({ receiptVersion: 2 })}`,
    "AGENTSCOPE_INTERACTIVE_PTY_RECEIPT=***",
    `AGENTSCOPE_INTERACTIVE_PTY_RECEIPT=${Buffer.from('{ "receiptVersion": 1 }').toString("base64url")}`,
  ])(
    "rejects missing, duplicate, malformed, or noncanonical records",
    (value) => {
      expect(() => decodeInteractivePtyReceipt(value)).toThrow(
        "integration.immutable-candidate.authority",
      );
    },
  );
});

describe("interactive PTY failure diagnostic provenance", () => {
  it("never reports a spoofed Codex subtype from stdout or another scenario", () => {
    const specific =
      "integration.fixture.codex-tui-join-deadline-session-end-completed";
    expect(
      selectInteractiveExecutionFailurePredicate(
        specific,
        undefined,
        "codex-tui-trace-smoke",
      ),
    ).toBe("child-failure");
    expect(
      selectInteractiveExecutionFailurePredicate(
        specific,
        undefined,
        "fixture-process-interactive",
      ),
    ).toBe("child-failure");
    expect(
      selectInteractiveExecutionFailurePredicate(
        specific,
        specific,
        "fixture-process-interactive",
      ),
    ).toBe("child-failure");
    expect(
      selectInteractiveExecutionFailurePredicate(
        "integration.runner.fixture-failed",
        specific,
        "codex-tui-trace-smoke",
      ),
    ).toBe(specific);
  });
  it("rejects a Codex post-trace subtype from a different scenario receipt or stdout", () => {
    const specific = "integration.fixture.codex-verify-adapter-observation";
    expect(
      encodeInteractiveFailureExitCode(specific, "fixture-process-interactive"),
    ).toBeUndefined();
    expect(
      decodeInteractiveFailureExitCode(160, "fixture-process-interactive"),
    ).toBeUndefined();
    expect(decodeInteractiveFailureExitCode(160)).toBeUndefined();
    expect(
      selectInteractiveExecutionFailurePredicate(
        "integration.runner.fixture-failed",
        specific,
        "fixture-process-interactive",
      ),
    ).toBe("child-failure");
    const stdoutDiagnostic = extractInteractiveChildDiagnostic(
      `integration.runner.interactive-diagnostic:${specific}\n`,
    );
    expect(stdoutDiagnostic).toBe(specific);
    expect(
      selectInteractiveExecutionFailurePredicate(
        stdoutDiagnostic,
        undefined,
        "fixture-process-interactive",
      ),
    ).toBe("child-failure");
    expect(
      selectInteractiveExecutionFailurePredicate(
        stdoutDiagnostic,
        undefined,
        "codex-tui-trace-smoke",
      ),
    ).toBe("child-failure");
    expect(
      selectInteractiveExecutionFailurePredicate(
        "integration.runner.fixture-failed",
        specific,
        "codex-tui-trace-smoke",
      ),
    ).toBe(specific);
  });
});

describe("interactive PTY failure diagnostic transport", () => {
  it("uses a disjoint authenticated exit-code range for join classifications", () => {
    const generic = "integration.fixture.codex-tui-join-deadline";
    for (const [index, state] of [
      "log-unavailable",
      "hook-log-invalid",
      "stop-unseen",
      "stop-active",
      "stop-completed",
      "session-end-active",
      "session-end-completed",
    ].entries()) {
      const specific = `${generic}-${state}`;
      expect(encodeCodexJoinDeadlineExitCode(state)).toBe(32 + index);
      expect(decodeCodexJoinDeadlineExitCode(32 + index)).toBe(specific);
      expect(
        encodeInteractiveFailureExitCode(specific, "codex-tui-trace-smoke"),
      ).toBe(32 + index);
      expect(
        decodeInteractiveFailureExitCode(32 + index, "codex-tui-trace-smoke"),
      ).toBe(specific);
      expect(encodeInteractiveFailureExitCode(specific)).toBeUndefined();
      expect(
        encodeInteractiveFailureExitCode(
          specific,
          "fixture-process-interactive",
        ),
      ).toBeUndefined();
      expect(decodeInteractiveFailureExitCode(32 + index)).toBeUndefined();
      expect(
        decodeInteractiveFailureExitCode(
          32 + index,
          "fixture-process-interactive",
        ),
      ).toBeUndefined();
      expect(
        extractInteractiveChildDiagnostic(
          `integration.runner.interactive-diagnostic:${specific}\n`,
        ),
      ).toBe(specific);
    }
    for (const untrusted of [
      undefined,
      "success",
      "session-end-completed-extra",
    ])
      expect(encodeCodexJoinDeadlineExitCode(untrusted)).toBeUndefined();
    for (const unreserved of [undefined, 1, 31, 39, 63, 92, 126, 1.5])
      expect(decodeCodexJoinDeadlineExitCode(unreserved)).toBeUndefined();
  });

  it.each([
    "integration.fixture.codex-tui-exit-published",
    "integration.fixture.codex-tui-joined",
  ])("preserves one post-completion failure witness: %s", (diagnostic) => {
    expect(
      selectInteractiveFailureDiagnostic(
        undefined,
        diagnostic,
        "testkit.pty.receipt-terminal",
      ),
    ).toBe(diagnostic);
    const exitCode = encodeInteractiveFailureExitCode(diagnostic);
    expect(exitCode).toEqual(expect.any(Number));
    expect(exitCode).toBeLessThanOrEqual(134);
    expect(decodeInteractiveFailureExitCode(exitCode)).toBe(diagnostic);
    expect(
      extractInteractiveChildDiagnostic(
        `integration.runner.interactive-diagnostic:${diagnostic}\n`,
      ),
    ).toBe(diagnostic);
  });

  it.each([
    "integration.fixture.codex-tui-join-deadline",
    "integration.fixture.codex-tui-child-rejected",
  ])(
    "transports a join failure through an authenticated exit code: %s",
    (diagnostic) => {
      const exitCode = encodeInteractiveFailureExitCode(diagnostic);
      expect(exitCode).toEqual(expect.any(Number));
      expect(exitCode).toBeLessThanOrEqual(125);
      expect(decodeInteractiveFailureExitCode(exitCode)).toBe(diagnostic);
      expect(
        selectInteractiveFailureDiagnostic(
          undefined,
          diagnostic,
          "testkit.pty.receipt-terminal",
        ),
      ).toBe("testkit.pty.receipt-terminal");
      expect(
        selectInteractiveFailureDiagnostic(
          diagnostic,
          "integration.fixture.codex-tui-exit-published",
          "testkit.pty.receipt-terminal",
        ),
      ).toBe("integration.fixture.codex-tui-exit-published");
      expect(
        selectInteractiveFailureDiagnostic(undefined, undefined, diagnostic),
      ).toBeUndefined();
      expect(
        extractInteractiveChildDiagnostic(
          `integration.runner.interactive-diagnostic:${diagnostic}\n`,
        ),
      ).toBe(diagnostic);
    },
  );
});

describe("pre-checkpoint failure diagnostic transport", () => {
  it.each([
    ["integration.fixture.codex-tui-exit-before-checkpoint", 139],
    ["integration.fixture.codex-tui-checkpoint-not-witnessed", 140],
  ] as const)(
    "retains %s only through its controller exit code",
    (diagnostic, exitCode) => {
      expect(
        selectInteractiveFailureDiagnostic(
          diagnostic,
          "integration.fixture.codex-tui-run-created",
          "testkit.pty.receipt-terminal",
        ),
      ).toBe("integration.fixture.codex-tui-run-created");
      expect(encodeInteractiveFailureExitCode(diagnostic)).toBeUndefined();
      expect(
        encodeInteractiveFailureExitCode(diagnostic, "codex-tui-trace-smoke"),
      ).toBe(exitCode);
      expect(
        decodeInteractiveFailureExitCode(exitCode, "codex-tui-trace-smoke"),
      ).toBe(diagnostic);
      expect(
        decodeInteractiveFailureExitCode(
          exitCode,
          "fixture-process-interactive",
        ),
      ).toBeUndefined();
      expect(
        selectInteractiveFailureDiagnostic(diagnostic, undefined, undefined),
      ).toBeUndefined();
      expect(
        selectInteractiveExecutionFailurePredicate(
          undefined,
          diagnostic,
          "codex-tui-trace-smoke",
        ),
      ).toBe(diagnostic);
      expect(
        extractInteractiveChildDiagnostic(
          `integration.runner.interactive-diagnostic:${diagnostic}\n`,
        ),
      ).toBe(diagnostic);
    },
  );
});

describe("candidate configuration diagnostic transport", () => {
  it.each([
    ["render", 150],
    ["create", 151],
    ["open", 152],
    ["prove", 153],
    ["closed-marker", 154],
    ["publish", 155],
  ] as const)(
    "keeps %s in a separate bounded Codex exit-code range",
    (stage, exitCode) => {
      const diagnostic = `integration.fixture.codex-candidate-config-${stage}`;
      expect(encodeInteractiveFailureExitCode(diagnostic)).toBeUndefined();
      expect(
        encodeInteractiveFailureExitCode(diagnostic, "codex-tui-trace-smoke"),
      ).toBe(exitCode);
      expect(
        decodeInteractiveFailureExitCode(exitCode, "codex-tui-trace-smoke"),
      ).toBe(diagnostic);
      expect(
        decodeInteractiveFailureExitCode(
          exitCode,
          "fixture-process-interactive",
        ),
      ).toBeUndefined();
      expect(
        selectInteractiveFailureDiagnostic(diagnostic, undefined, undefined),
      ).toBeUndefined();
      expect(
        selectInteractiveExecutionFailurePredicate(
          undefined,
          diagnostic,
          "codex-tui-trace-smoke",
        ),
      ).toBe(diagnostic);
    },
  );
});

describe("interactive trace failure-marker transport", () => {
  it.each([
    "integration.fixture.codex-trace-await-hook-deadline",
    "integration.fixture.codex-trace-await-reporter-child",
    "integration.fixture.codex-trace-await-search-child-deadline",
    "integration.fixture.codex-trace-await-search-child-exit-5",
    "integration.fixture.codex-trace-await-search-hook-log",
    "integration.fixture.codex-trace-await-search-other",
  ])("does not promote a candidate-writable trace hint: %s", (diagnostic) => {
    expect(
      selectInteractiveFailureDiagnostic(
        diagnostic,
        "integration.fixture.codex-trace-search",
        "testkit.pty.receipt-terminal",
      ),
    ).toBe("integration.fixture.codex-trace-search");
    expect(encodeInteractiveFailureExitCode(diagnostic)).toBeUndefined();
    expect(
      extractInteractiveChildDiagnostic(
        `integration.runner.interactive-diagnostic:${diagnostic}\n`,
      ),
    ).toBeUndefined();
    expect(untrustedCodexTraceHint(diagnostic)).toBe(
      diagnostic.slice("integration.fixture.codex-trace-await-".length),
    );
  });
  for (const marker of [
    "integration.fixture.codex-trace-await-other-child",
    "integration.fixture.codex-trace-await-hook-extra",
    "integration.fixture.codex-trace-await-hook",
    "integration.fixture.codex-trace-search",
    undefined,
  ])
    it(`rejects a substituted untrusted trace hint: ${marker}`, () => {
      expect(untrustedCodexTraceHint(marker)).toBeUndefined();
    });
});

describe("Codex uninstall failure diagnostic transport", () => {
  it.each([
    ["integration.codex.child", "child", 167],
    ["integration.codex.child-deadline", "child-deadline", 168],
    ["integration.codex.deadline", "deadline", 169],
    ["integration.codex.trace-deadline", "trace-deadline", 170],
    ["integration.codex.cli-output", "cli-output", 171],
    ["integration.codex.uninstall", "result", 172],
    ["integration.codex.child-spawn", "child-spawn", 173],
  ] as const)(
    "maps only the exact owned uninstall failure %s",
    (error, category, expectedExitCode) => {
      const diagnostic = `integration.fixture.codex-verify-uninstall-${category}`;
      expect(codexUninstallFailureDiagnostic(error)).toBe(diagnostic);
      const exitCode = encodeInteractiveFailureExitCode(
        diagnostic,
        "codex-tui-trace-smoke",
      );
      expect(exitCode).toBe(expectedExitCode);
      expect(
        decodeInteractiveFailureExitCode(exitCode, "codex-tui-trace-smoke"),
      ).toBe(diagnostic);
    },
  );

  it.each([
    undefined,
    null,
    "integration.codex.child:stderr",
    "integration.codex.uninstall\nsecret",
    "integration.codex.other",
  ])("rejects unowned uninstall error content: %s", (error) => {
    expect(codexUninstallFailureDiagnostic(error)).toBeUndefined();
  });

  it.each([
    ["cli", "during-cli-unclassified", 174],
    ["result", "during-result-unclassified", 175],
    ["hook", "during-hook-unclassified", 176],
  ] as const)(
    "keeps an unclassified error during %s content-free and failure-only",
    (stage, category, expectedExitCode) => {
      const diagnostic = `integration.fixture.codex-verify-uninstall-${category}`;
      expect(codexUninstallUnclassifiedStageDiagnostic(stage)).toBe(diagnostic);
      const exitCode = encodeInteractiveFailureExitCode(
        diagnostic,
        "codex-tui-trace-smoke",
      );
      expect(exitCode).toBe(expectedExitCode);
      expect(
        decodeInteractiveFailureExitCode(exitCode, "codex-tui-trace-smoke"),
      ).toBe(diagnostic);
    },
  );
  for (const stage of [undefined, null, "else", "cli-secret"]) {
    it(`rejects a substituted uninstall stage: ${stage}`, () => {
      expect(codexUninstallUnclassifiedStageDiagnostic(stage)).toBeUndefined();
    });
  }

  it("records only temporal stages and normalizes a native spawn error", () => {
    const source = readIntegration("codex-pty-scenario.mjs");
    expect(source).toMatch(
      /child\.once\("error", \(\) =>\s+reject\(new Error\("integration\.codex\.child-spawn"\)\),\s+\);/u,
    );
    expect(source).toContain(
      "codexUninstallUnclassifiedStageDiagnostic(uninstallVerificationStep)",
    );
    const invoke = source.indexOf('recordInteractivePhase("verify-uninstall")');
    const result = source.indexOf(
      'uninstallVerificationStep = "result";',
      invoke,
    );
    const project = source.indexOf(
      "const uninstall = projectUninstall(uninstallRecords);",
      result,
    );
    const hook = source.indexOf('uninstallVerificationStep = "hook";', project);
    const next = source.indexOf(
      'recordInteractivePhase("verify-status")',
      hook,
    );
    expect(invoke).toBeGreaterThan(0);
    expect(result).toBeGreaterThan(invoke);
    expect(project).toBeGreaterThan(result);
    expect(hook).toBeGreaterThan(project);
    expect(next).toBeGreaterThan(hook);
  });
});

it("reserves specialist codes beyond every scenario phase exit", () => {
  expect(readIntegration("runner.mjs")).toContain(
    'import { interactivePhases } from "./codex-trace-child-diagnostics.mjs";',
  );
  const phaseDeclaration =
    readIntegration("codex-trace-child-diagnostics.mjs")
      .split("const interactivePhases = Object.freeze([", 2)[1]
      ?.split("]);", 1)[0] ?? "";
  expect(phaseDeclaration.length).toBeGreaterThan(0);
  const phaseCount = [...phaseDeclaration.matchAll(/^ {2}"[a-z-]+",$/gmu)]
    .length;
  expect(64 + phaseCount - 1).toBeLessThan(160);
  const expectCode = (predicate: string, code: number) => {
    expect(
      encodeInteractiveFailureExitCode(predicate, "codex-tui-trace-smoke"),
    ).toBe(code);
  };
  expectCode("integration.fixture.codex-verify-adapter-observation", 160);
  expectCode(
    "integration.fixture.codex-verify-uninstall-during-hook-unclassified",
    176,
  );
});

// eslint-disable-next-line max-lines-per-function -- closed transport and source-level causal matrix
describe("Codex trace-get failure-only diagnostic transport", () => {
  const categories = [
    "locator-input",
    "child-spawn",
    "child-deadline",
    "child-signal",
    "child-exit",
    "child-output-limit",
    "terminal-deadline",
    "machine-output",
    "record-count",
    "locator-result",
    "unclassified",
  ];
  it.each(categories.map((category, index) => [category, 177 + index]))(
    "transports %s only for the exact scenario and retained failure marker",
    (category, code) => {
      const diagnostic = `integration.fixture.codex-verify-trace-get-${category}`;
      expect(
        encodeInteractiveFailureExitCode(diagnostic, "codex-tui-trace-smoke"),
      ).toBe(code);
      expect(
        decodeInteractiveFailureExitCode(code, "codex-tui-trace-smoke"),
      ).toBe(diagnostic);
      expect(
        encodeInteractiveFailureExitCode(diagnostic, "fixture"),
      ).toBeUndefined();
      expect(
        selectInteractiveExecutionFailurePredicate(
          diagnostic,
          undefined,
          "codex-tui-trace-smoke",
        ),
      ).toBe("child-failure");
      expect(
        selectInteractiveExecutionFailurePredicate(
          diagnostic,
          diagnostic,
          "fixture",
        ),
      ).toBe("child-failure");
      expect(
        selectInteractiveExecutionFailurePredicate(
          diagnostic,
          diagnostic,
          "codex-tui-trace-smoke",
        ),
      ).toBe(diagnostic);
    },
  );

  it("preserves the historical trace-get transport and fixture phase numbering", () => {
    expect(
      encodeInteractiveFailureExitCode(
        "integration.fixture.codex-verify-trace-get",
        "codex-tui-trace-smoke",
      ),
    ).toBe(128);
    const source = readIntegration("codex-pty-scenario.mjs");
    const diagnostic = readIntegration("codex-trace-child-diagnostics.mjs");
    expect(source).toContain('from "./codex-trace-child-diagnostics.mjs"');
    const phases =
      diagnostic
        .split("const interactivePhases = Object.freeze([", 2)[1]
        ?.split("]);", 1)[0] ?? "";
    const names = [...phases.matchAll(/"([a-z-]+)"/gu)].map(
      (match) => match[1],
    );
    expect(names.indexOf("verify-trace-get")).toBe(68);
    expect(source).toContain("64 + interactiveFailurePhaseIndex");
    expect(source).not.toContain(
      'interactiveFailurePhase === "verify-trace-get"',
    );
    expect(source).not.toContain(
      "classifyCodexTraceGetFailure(error?.message)",
    );
  });

  it("keeps Local retrieval out of production while retaining legacy locator categories", () => {
    const source = readIntegration("codex-pty-scenario.mjs");
    expect(source).not.toContain('recordInteractivePhase("verify-trace-get");');
    expect(source).not.toContain('["traces", "get"');
    expect(source).not.toContain("local-sqlite");
    expect(source).toContain("native: {");
    expect(source).toContain("sessionId: codexSessionId");
    expect(source).toContain("turnId: codexTurnId");
    for (const category of [
      "locator-input",
      "record-count",
      "locator-result",
    ]) {
      expect(
        classifyCodexTraceGetFailure(`integration.codex.trace-get-${category}`),
      ).toBe(category);
    }
    expect(classifyCodexTraceGetFailure("arbitrary-private-body")).toBe(
      "unclassified",
    );
  });

  it("executes the production CLI parser and both original deadline checks", async () => {
    const source = readIntegration("codex-pty-scenario.mjs");
    const start = source.indexOf("const cli = async (");
    const end = source.indexOf("\nconst prompt =", start);
    const declaration = source.slice(start, end);
    const invoke = (stdout: Buffer, terminalChecks: boolean[]) => {
      const cli = runInNewContext(`${declaration}; cli`, {
        run: () => Promise.resolve({ stdout }),
        agentscope: "synthetic-cli",
        process: { env: {} },
        terminalObservationBeforeDeadline: () => terminalChecks.shift(),
        bootNow: () => 123,
        parseMachine: parseCodexMachineOutput,
      });
      return cli([], "agentscope traces get", { monotonicDeadline: 456 });
    };
    const bytes = Buffer.from(
      JSON.stringify({
        command: "agentscope traces get",
        completion: "complete",
        records: [],
      }),
    );
    await expect(invoke(bytes, [true, true])).resolves.toEqual([]);
    await expect(invoke(Buffer.from("canary"), [true, true])).rejects.toThrow(
      "integration.codex.cli-output",
    );
    await expect(invoke(bytes, [false, true])).rejects.toThrow(
      "integration.codex.trace-deadline",
    );
    await expect(invoke(bytes, [true, false])).rejects.toThrow(
      "integration.codex.trace-deadline",
    );
  });
});

describe("Codex production get-child diagnostic wiring", () => {
  it.each(["success", "spawn", "deadline", "signal", "exit", "output-limit"])(
    "classifies %s using the production run body without granting a retry",
    async (kind) => {
      const source = readIntegration("codex-pty-scenario.mjs");
      const start = source.indexOf("const maximumOutput =");
      const end = source.indexOf("\nconst agentscope =", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const child = Object.assign(new EventEmitter(), {
        pid: 123,
        stdout: Object.assign(new EventEmitter(), { destroy: () => undefined }),
        stderr: Object.assign(new EventEmitter(), { destroy: () => undefined }),
        kill: () => true,
      });
      let spawned = 0;
      let deadlineCallback: (() => void) | undefined;
      let cleared = false;
      const run = runInNewContext(`${source.slice(start, end)}; run`, {
        Buffer,
        process: { env: {} },
        remaining: () => undefined,
        bootNow: () => 100,
        spawn: () => {
          spawned++;
          return child;
        },
        setTimeout: (callback: () => void, milliseconds: number) => {
          expect(milliseconds).toBe(200);
          deadlineCallback = callback;
          return 1;
        },
        clearTimeout: () => {
          cleared = true;
        },
        classifyCodexCollectedChildFailure,
        adapterReportedFailure: undefined,
      });
      const completion = run("synthetic", [], {
        monotonicDeadline: 300,
        traceGetDiagnostic: true,
      });
      if (kind === "spawn") child.emit("error", new Error("private-canary"));
      if (kind === "deadline") deadlineCallback?.();
      if (kind === "output-limit")
        child.stderr.emit("data", Buffer.alloc(1024 * 1024 + 1));
      child.emit(
        "close",
        kind === "exit" ? 5 : 0,
        kind === "signal" ? "SIGTERM" : null,
      );
      if (kind === "success")
        await expect(completion).resolves.toMatchObject({
          stdout: Buffer.alloc(0),
        });
      else {
        const expected =
          kind === "spawn"
            ? "integration.codex.child-spawn"
            : `integration.codex.trace-get-child-${kind}`;
        await expect(completion).rejects.toThrow(expected);
      }
      expect(spawned).toBe(1);
      expect(cleared).toBe(true);
    },
  );
});

describe("source-defined Claude failure code transport", () => {
  it.each([
    "environment",
    "clock",
    "deadline",
    "destination-settings",
    "doctor",
    "install",
    "readiness",
    "settings",
    "uninstall",
    "model-control",
    "model-route",
    "native-content",
    "native-directory",
    "native-file",
    "native-identity",
    "native-inventory",
    "native-jsonl",
    "native-model",
    "native-record",
    "native-tool",
    "native-tool-result",
    "native-turn",
    "early-exit",
    "model-pair",
    "native-early-exit",
    "native-final-turn",
    "pty",
    "response-model",
    "vendor-terminal",
    "internal-endpoint",
  ])("transports only the exact source-defined Claude refusal %s", (code) => {
    const message =
      code === "internal-endpoint"
        ? "claude-code.execution.internal-endpoint"
        : `integration.claude-code.${code}`;
    const diagnostic = claudeScenarioFailureDiagnostic(
      new Error(message),
      "bootstrap",
    );
    expect(diagnostic).toBe(`integration.fixture.claude-${code}`);
    const exit = encodeInteractiveFailureExitCode(
      diagnostic,
      "claude-interactive-trace-smoke",
    );
    expect(exit).toBeGreaterThanOrEqual(200);
    expect(exit).toBeLessThanOrEqual(255);
    expect(
      decodeInteractiveFailureExitCode(exit, "claude-interactive-trace-smoke"),
    ).toBe(diagnostic);
    expect(
      decodeInteractiveFailureExitCode(exit, "codex-tui-trace-smoke"),
    ).toBeUndefined();
    expect(
      encodeInteractiveFailureExitCode(diagnostic, "codex-tui-trace-smoke"),
    ).toBeUndefined();
    expect(
      selectInteractiveExecutionFailurePredicate(
        diagnostic,
        undefined,
        "codex-tui-trace-smoke",
      ),
    ).toBe("child-failure");
  });
});
describe("source-defined Claude failure phases", () => {
  it.each([
    ["packed-init", 240],
    ["packed-configure", 241],
    ["packed-routing", 242],
    ["packed-hook-install", 243],
    ["packed-status", 244],
    ["packed-settings", 245],
  ] as const)(
    "appends %s at exit %i without changing old assignments",
    (phase, exit) => {
      const diagnostic = claudeScenarioFailureDiagnostic(
        new Error("PRIVATE"),
        phase,
      );
      expect(
        encodeInteractiveFailureExitCode(
          diagnostic,
          "claude-interactive-trace-smoke",
        ),
      ).toBe(exit);
      expect(
        decodeInteractiveFailureExitCode(
          exit,
          "claude-interactive-trace-smoke",
        ),
      ).toBe(diagnostic);
      expect(
        decodeInteractiveFailureExitCode(exit, "codex-tui-trace-smoke"),
      ).toBeUndefined();
      expect(
        encodeInteractiveFailureExitCode(diagnostic, "codex-tui-trace-smoke"),
      ).toBeUndefined();
      expect(
        decodeInteractiveFailureExitCode(246, "claude-interactive-trace-smoke"),
      ).toBe("integration.fixture.claude-phase-packed-hook-absent");
      expect(
        decodeInteractiveFailureExitCode(256, "claude-interactive-trace-smoke"),
      ).toBeUndefined();
      expect(
        encodeInteractiveFailureExitCode(
          "integration.fixture.claude-phase-result",
          "claude-interactive-trace-smoke",
        ),
      ).toBe(239);
    },
  );
  it.each([
    "bootstrap",
    "readiness",
    "packed-install",
    "packed-init",
    "packed-configure",
    "packed-routing",
    "packed-hook-install",
    "packed-status",
    "packed-settings",
    "stimulus",
    "model-config",
    "candidate-denial",
    "model-pair",
    "native-final",
    "retirement",
    "result",
  ])(
    "retains only actual fixed phase %s for unknown/reflected values",
    (phase) => {
      const trap = () => {
        throw Error("must-not-read");
      };
      const accessor = new Error();
      Object.defineProperty(accessor, "message", { get: trap });
      for (const error of [
        new Error("PRIVATE_CANARY"),
        { message: "integration.claude-code.environment" },
        accessor,
        new Proxy(new Error(), { get: trap, getOwnPropertyDescriptor: trap }),
      ]) {
        const diagnostic = claudeScenarioFailureDiagnostic(error, phase);
        expect(diagnostic).toBe(`integration.fixture.claude-phase-${phase}`);
        const exit = encodeInteractiveFailureExitCode(
          diagnostic,
          "claude-interactive-trace-smoke",
        );
        expect(
          decodeInteractiveFailureExitCode(
            exit,
            "claude-interactive-trace-smoke",
          ),
        ).toBe(diagnostic);
      }
    },
  );
});
describe("Claude owned failure marker routing", () => {
  it.each([
    "integration.fixture.claude-model-pair",
    "integration.fixture.claude-phase-packed-init",
    "integration.fixture.claude-phase-packed-configure",
    "integration.fixture.claude-phase-packed-routing",
    "integration.fixture.claude-phase-packed-hook-install",
    "integration.fixture.claude-phase-packed-status",
    "integration.fixture.claude-phase-packed-settings",
    "integration.fixture.claude-phase-packed-hook-absent",
    "integration.fixture.claude-phase-packed-hook-adapter-missing",
    "integration.fixture.claude-phase-packed-hook-discovery-indeterminate",
    "integration.fixture.claude-phase-packed-hook-installation-unsupported",
    "integration.fixture.claude-phase-packed-hook-overlap-conflict",
    "integration.fixture.claude-phase-packed-hook-plan-invalid",
    "integration.fixture.claude-phase-packed-hook-recovery-required",
    "integration.fixture.claude-phase-packed-hook-unavailable",
    "integration.fixture.claude-phase-packed-hook-version-unsupported",
    "integration.fixture.claude-phase-packed-hook-internal",
  ])(
    "routes owned marker %s through strict reader/frame/held-scenario selector",
    (diagnostic) => {
      const ledger = mkdtempSync(join(tmpdir(), "agentscope-claude-failure-"));
      try {
        writeFileSync(
          join(ledger, "interactive-failure.txt"),
          `${diagnostic}\n`,
          { flag: "wx", mode: 0o600 },
        );
        const retained = readBoundedInteractiveFailureMarker(ledger);
        const selected = selectInteractiveFailureDiagnostic(
          retained,
          undefined,
          "testkit.pty.transport.semantic-nonzero",
        );
        const frame: string = formatInteractiveChildDiagnostic(selected);
        expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(256);
        const observed = extractInteractiveChildDiagnostic(frame);
        expect(
          selectInteractiveExecutionFailurePredicate(
            observed,
            undefined,
            "claude-interactive-trace-smoke",
          ),
        ).toBe(diagnostic);
        expect(
          selectInteractiveExecutionFailurePredicate(
            observed,
            undefined,
            "fixture-process-interactive",
          ),
        ).toBe("child-failure");
        expect(
          extractInteractiveChildDiagnostic(`${frame}${frame}`),
        ).toBeUndefined();
        expect(
          validInstalledPtyFailure({
            receiptVersion: 1,
            phase: "pty-execution",
            predicate: diagnostic,
            scenarioId: "claude-interactive-trace-smoke",
          }),
        ).toBe(true);
        expect(
          validInstalledPtyFailure({
            receiptVersion: 1,
            phase: "pty-execution",
            predicate: diagnostic,
            scenarioId: "codex-tui-trace-smoke",
          }),
        ).toBe(false);
        expect(
          validInstalledPtyFailure({
            receiptVersion: 1,
            phase: "pty-execution",
            predicate: diagnostic,
          }),
        ).toBe(false);
      } finally {
        rmSync(ledger, { recursive: true, force: true });
      }
    },
  );
  it("binds the Claude environment refusal to its exact scenario", () => {
    const diagnostic = "integration.fixture.claude-environment";
    expect(
      encodeInteractiveFailureExitCode(
        diagnostic,
        "claude-interactive-trace-smoke",
      ),
    ).toBe(200);
    expect(
      decodeInteractiveFailureExitCode(200, "claude-interactive-trace-smoke"),
    ).toBe(diagnostic);
    expect(
      decodeInteractiveFailureExitCode(200, "codex-tui-trace-smoke"),
    ).toBeUndefined();
  });
});
describe("interactive PTY failure exit-code transport", () => {
  it.each([
    [
      "integration.codex.adapter-observation",
      "integration.fixture.codex-verify-adapter-observation",
      160,
    ],
    ...[
      "scenario",
      "hook-mediation",
      "stimulus",
      "model-request",
      "trace",
      "lifecycle",
    ].map((predicate, index) => [
      `integration.codex.oracle-${predicate}`,
      `integration.fixture.codex-verify-oracle-${predicate}`,
      161 + index,
    ]),
  ])(
    "maps only exact owned projection failure %s",
    (error, diagnostic, expectedExitCode) => {
      expect(codexProjectionFailureDiagnostic(error)).toBe(diagnostic);
      const exitCode = encodeInteractiveFailureExitCode(
        diagnostic,
        "codex-tui-trace-smoke",
      );
      expect(exitCode).toBe(expectedExitCode);
      expect(
        decodeInteractiveFailureExitCode(exitCode, "codex-tui-trace-smoke"),
      ).toBe(diagnostic);
    },
  );

  it.each([
    undefined,
    null,
    "integration.codex.oracle-other",
    "integration.codex.oracle-trace:raw-content",
    "integration.codex.adapter-observation\nsecret",
    "integration.codex.oracle-__proto__",
  ])("does not export an unowned projection error: %s", (error) => {
    expect(codexProjectionFailureDiagnostic(error)).toBeUndefined();
  });
  it("round-trips one exact allowlisted runner diagnostic through a reserved exit code", () => {
    const diagnostic = "integration.fixture.codex-model-request";
    const exitCode = encodeInteractiveFailureExitCode(diagnostic);
    expect(exitCode).toEqual(expect.any(Number));
    expect(exitCode).toBeGreaterThanOrEqual(64);
    expect(exitCode).toBeLessThanOrEqual(125);
    expect(decodeInteractiveFailureExitCode(exitCode)).toBe(diagnostic);
  });

  it.each([
    ["config", 126],
    ["gate", 127],
    ["trace-get", 128],
    ["correlation", 129],
    ["doctor", 130],
    ["uninstall", 131],
    ["status", 132],
    ["projection", 133],
    ["evidence", 134],
  ] as const)(
    "transports only the closed post-trace checkpoint %s at exit code %i",
    (checkpoint, exitCode) => {
      const diagnostic = `integration.fixture.codex-verify-${checkpoint}`;
      expect(encodeInteractiveFailureExitCode(diagnostic)).toBe(exitCode);
      expect(decodeInteractiveFailureExitCode(exitCode)).toBe(diagnostic);
    },
  );

  it.each([
    undefined,
    "integration.fixture.codex-not-allowlisted",
    "testkit.pty.transport.semantic-nonzero",
  ])("refuses to encode an unapproved diagnostic: %s", (diagnostic) => {
    expect(encodeInteractiveFailureExitCode(diagnostic)).toBeUndefined();
  });

  it.each([undefined, 1, 31, 39, 63, 135, 136, 137, 138, 139, 159, 177, 1.5])(
    "refuses to decode an unreserved exit code: %s",
    (exitCode) => {
      expect(decodeInteractiveFailureExitCode(exitCode)).toBeUndefined();
    },
  );

  it("extracts one exact allowlisted runner diagnostic from attach output", () => {
    expect(
      extractInteractiveChildDiagnostic(
        "prefix\nintegration.runner.interactive-diagnostic:integration.fixture.codex-model-request\nsuffix\n",
      ),
    ).toBe("integration.fixture.codex-model-request");
  });

  it("transports model-gate arm diagnostics without consuming an exit-code slot", () => {
    const diagnostic =
      "integration.fixture.codex-model-gate-arm-session-start-missing";
    expect(encodeInteractiveFailureExitCode(diagnostic)).toBeUndefined();
    expect(
      extractInteractiveChildDiagnostic(
        `integration.runner.interactive-diagnostic:${diagnostic}\n`,
      ),
    ).toBe(diagnostic);
  });

  it.each([
    "",
    "integration.runner.interactive-diagnostic:integration.fixture.codex-model-request\nintegration.runner.interactive-diagnostic:integration.fixture.codex-tui-start\n",
    "integration.runner.interactive-diagnostic:integration.fixture.codex-not-allowlisted\n",
    "x:integration.runner.interactive-diagnostic:integration.fixture.codex-model-request\n",
  ])("rejects missing, duplicate, unapproved, or non-line records", (value) => {
    expect(extractInteractiveChildDiagnostic(value)).toBeUndefined();
  });
});

describe("untrusted Codex join hints", () => {
  it("reads only a bounded no-follow marker as untrusted data", () => {
    const ledger = mkdtempSync(join(tmpdir(), "agentscope-join-hint-"));
    const marker = join(ledger, "interactive-failure.txt");
    const payload = join(ledger, "payload.txt");
    const value = "integration.fixture.codex-tui-join-deadline-stop-active\n";
    try {
      expect(readBoundedInteractiveFailureMarker(ledger)).toBeUndefined();
      writeFileSync(payload, value);
      symlinkSync(payload, marker);
      expect(readBoundedInteractiveFailureMarker(ledger)).toBeUndefined();
      rmSync(marker);
      writeFileSync(marker, "x".repeat(129));
      expect(readBoundedInteractiveFailureMarker(ledger)).toBeUndefined();
      writeFileSync(marker, value);
      expect(readBoundedInteractiveFailureMarker(ledger)).toBe(value.trim());
      writeFileSync(marker, `${value}extra`);
      expect(readBoundedInteractiveFailureMarker(ledger)).toBeUndefined();
    } finally {
      rmSync(ledger, { recursive: true, force: true });
    }
  });

  it("never promotes a candidate-writable specific marker into authority", () => {
    const specific =
      "integration.fixture.codex-tui-join-deadline-session-end-completed";
    expect(
      selectInteractiveFailureDiagnostic(
        specific,
        undefined,
        "testkit.pty.receipt-terminal",
      ),
    ).toBe("testkit.pty.receipt-terminal");
    expect(
      selectInteractiveFailureDiagnostic(specific, undefined, specific),
    ).toBeUndefined();
    expect(decodeInteractiveFailureExitCode(38, "codex-tui-trace-smoke")).toBe(
      specific,
    );
  });

  it("extracts only one closed content-free research hint", () => {
    const line = "integration.runner.untrusted-join-hint:stop-active\n";
    expect(extractUntrustedCodexJoinHint(line)).toBe("stop-active");
    for (const output of [
      `${line}${line}`,
      "integration.runner.untrusted-join-hint:arbitrary\n",
      "integration.runner.untrusted-join-hint:stop-active-extra\n",
      "integration.runner.untrusted-join-hint:stop-active:secret\n",
    ])
      expect(extractUntrustedCodexJoinHint(output)).toBeUndefined();
  });
});
