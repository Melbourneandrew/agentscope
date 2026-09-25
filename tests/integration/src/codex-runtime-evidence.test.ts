import {
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  boundedRequestLedger,
  classifyCodexSettledTraceObservation,
  classifyCodexSessionStartAtFailedPty,
  classifyCodexTraceDeadlineObservation,
  classifyCodexTraceFailureHint,
  codexTraceSearchChildFailureCategory,
  codexTraceSearchAttemptDeadlines,
  codexTraceSearchUnavailable,
  codexTraceSearchTimedOut,
  codexSessionStartCheckpointMatchesLifecycle,
  classifyCodexStopHookCommand,
  classifyCodexShutdownAtJoinDeadline,
  classifyCodexShutdownLogSource,
  codexStopHookReadyForExit,
  classifyMissingOperationalStateByHookDuration,
  classifyLocalSqliteOutcomeAfterBaseline,
  inspectCodexRootHookLifecycle,
  inspectCodexSessionStartBeforeFirstModelRequestAdmission,
  inspectCodexStopHookCommand,
  classifyTraceSearchRecordsBeforeDeadline,
  codexSessionIdentity,
  codexSessionStartMediationUpperBoundMilliseconds,
  codexTurnTerminalObserved,
  codexTurnTerminalObservedAfterBaseline,
  localSqliteAcceptanceBaseline,
  localSqliteAcceptanceObservedAfterBaseline,
  localSqliteReporterSettled,
  openLocalSqliteLifecycle,
  inspectDiagnosticBeforeDeadline,
  openOperationalStateHealth,
  publishTerminalCompletionBeforeDeadline,
  recordTerminalObservationBeforeDeadline,
  readCodexSessionLedgers,
  readCodexSessionLedgerRecords,
  readBoundedJsonResponse,
  settledCodexLedgerSnapshot,
  settledLocalSqliteLifecycleSnapshot,
  terminalObservationBeforeDeadline,
  traceSummaryBeforeDeadline,
  waitForModelRequestBeforeDeadline,
  waitWithinObservationDeadline,
} from "../codex-runtime-evidence.mjs";

// eslint-disable-next-line max-lines-per-function -- descriptor-bound hostile native-record matrix
describe("Codex bounded native ledgers", () => {
  it("classifies shutdown progress without using terminal contents", () => {
    const start = (event: string) =>
      `TRACE codex.hooks.command{hook.event_name="${event}"}: new\n`;
    const close = (event: string) =>
      `TRACE codex.hooks.command{hook.event_name="${event}" hook.command_outcome="completed"}: close time.busy=1ms time.idle=1ms\n`;
    const sessionStart = `${start("SessionStart")}${close("SessionStart")}`;
    const stop = `${start("Stop")}${close("Stop")}`;
    const sessionEnd = `${start("SessionEnd")}${close("SessionEnd")}`;
    for (const [source, expected] of [
      ["", "log-unavailable"],
      [sessionStart, "stop-unseen"],
      [`${sessionStart}${start("Stop")}`, "stop-active"],
      [`${sessionStart}${stop}`, "stop-completed"],
      [`${sessionStart}${stop}${start("SessionEnd")}`, "session-end-active"],
      [`${sessionStart}${stop}${sessionEnd}`, "session-end-completed"],
    ] as const) {
      expect(classifyCodexShutdownLogSource(source)).toBe(expected);
      if (expected === "stop-completed")
        expect(codexStopHookReadyForExit(expected)).toBe(true);
      else if (
        expected === "session-end-active" ||
        expected === "session-end-completed"
      )
        expect(() => codexStopHookReadyForExit(expected)).toThrow(
          "integration.codex.hook-lifecycle",
        );
      else expect(codexStopHookReadyForExit(expected)).toBe(false);
    }
    expect(() => codexStopHookReadyForExit("unknown" as never)).toThrow(
      "integration.codex.hook-lifecycle",
    );
    for (const source of [
      "TRACE unrelated: new\n",
      `${sessionStart}${sessionEnd}`,
      `${stop}${sessionStart}`,
      `${sessionStart}${stop}${sessionEnd}${sessionEnd}`,
      `${sessionStart}${start("Stop")}${start("SessionEnd")}`,
      `${sessionStart}${start("Stop")}${close("Stop").replace('"completed"', '"timeout"')}`,
      `${sessionStart}${stop}${start("SessionEnd")}${close("SessionEnd").replace('"completed"', '"timeout"')}`,
    ])
      expect(() => classifyCodexShutdownLogSource(source)).toThrow(
        /integration\.codex\.hook-(?:log|lifecycle)/u,
      );
  });

  it.runIf(process.platform === "linux")(
    "classifies only exact root-hook progress at a failed TUI join",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentscope-codex-join-log-"));
      const directory = join(root, "log");
      mkdirSync(directory, { mode: 0o700 });
      const descriptor = openSync(
        directory,
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
      const path = join(directory, "codex-tui.log");
      const input = {
        directoryDescriptor: descriptor,
        directoryPath: directory,
      };
      const start = (event: string) =>
        `TRACE codex.hooks.command{hook.event_name="${event}"}: new\n`;
      const close = (event: string) =>
        `TRACE codex.hooks.command{hook.event_name="${event}" hook.command_outcome="completed"}: close time.busy=1ms time.idle=1ms\n`;
      const sessionStart = `${start("SessionStart")}${close("SessionStart")}`;
      const stop = `${start("Stop")}${close("Stop")}`;
      const sessionEnd = `${start("SessionEnd")}${close("SessionEnd")}`;
      try {
        expect(classifyCodexShutdownAtJoinDeadline(input)).toBe(
          "log-unavailable",
        );
        for (const [source, expected] of [
          [sessionStart, "stop-unseen"],
          [`${sessionStart}${start("Stop")}`, "stop-active"],
          [`${sessionStart}${stop}`, "stop-completed"],
          [
            `${sessionStart}${stop}${start("SessionEnd")}`,
            "session-end-active",
          ],
          [`${sessionStart}${stop}${sessionEnd}`, "session-end-completed"],
        ] as const) {
          writeFileSync(path, source);
          expect(classifyCodexShutdownAtJoinDeadline(input)).toBe(expected);
        }
        for (const source of [
          `${sessionStart}${sessionEnd}`,
          `${stop}${sessionStart}`,
          `${sessionStart}${stop}${sessionEnd}${sessionEnd}`,
          `${sessionStart}${start("Stop")}${start("SessionEnd")}`,
          `${sessionStart}${start("Stop")}${close("Stop").replace('"completed"', '"timeout"')}`,
        ]) {
          writeFileSync(path, source);
          expect(() => classifyCodexShutdownAtJoinDeadline(input)).toThrow(
            /integration\.codex\.hook-(?:log|lifecycle)/u,
          );
        }
      } finally {
        closeSync(descriptor);
        rmSync(root, { recursive: true });
      }
    },
  );

  it("classifies the closed Stop-hook latency buckets", () => {
    expect(classifyMissingOperationalStateByHookDuration(0)).toBe(
      "hook-no-operational-state-subsecond",
    );
    expect(classifyMissingOperationalStateByHookDuration(499.999)).toBe(
      "hook-no-operational-state-subsecond",
    );
    expect(classifyMissingOperationalStateByHookDuration(500)).toBe(
      "hook-no-operational-state-low-latency",
    );
    expect(classifyMissingOperationalStateByHookDuration(1_500)).toBe(
      "hook-no-operational-state-mid-latency",
    );
    expect(classifyMissingOperationalStateByHookDuration(3_000)).toBe(
      "hook-no-operational-state-high-latency",
    );
    expect(classifyMissingOperationalStateByHookDuration(4_000)).toBe(
      "hook-no-operational-state-near-deadline",
    );
    expect(classifyMissingOperationalStateByHookDuration(4_900)).toBe(
      "hook-command-completed-near-budget-boundary",
    );
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 120_001])
      expect(() =>
        classifyMissingOperationalStateByHookDuration(value),
      ).toThrow("integration.codex.hook-log");
  });

  it("requires a fresh post-settlement trace observation", () => {
    expect(
      classifyCodexSettledTraceObservation({
        hookCompleted: false,
        observationClosed: false,
        reporterSettled: false,
        tracePresent: false,
      }),
    ).toBe("pending");
    expect(
      classifyCodexSettledTraceObservation({
        hookCompleted: false,
        observationClosed: false,
        reporterSettled: true,
        tracePresent: true,
      }),
    ).toBe("pending");
    expect(
      classifyCodexSettledTraceObservation({
        hookCompleted: true,
        observationClosed: true,
        reporterSettled: false,
        tracePresent: false,
      }),
    ).toBe("pending");
    expect(
      classifyCodexSettledTraceObservation({
        hookCompleted: true,
        observationClosed: false,
        reporterSettled: true,
        tracePresent: false,
      }),
    ).toBe("pending");
    expect(
      classifyCodexSettledTraceObservation({
        hookCompleted: true,
        observationClosed: false,
        reporterSettled: true,
        tracePresent: true,
      }),
    ).toBe("accepted");
    expect(
      classifyCodexSettledTraceObservation({
        hookCompleted: true,
        observationClosed: true,
        reporterSettled: true,
        tracePresent: false,
      }),
    ).toBe("missing");
  });

  it("diagnoses only the last closed trace-deadline observation", () => {
    expect(
      classifyCodexTraceDeadlineObservation({
        hookCompleted: false,
        reporterSettled: false,
      }),
    ).toBe("trace-await-hook");
    expect(
      classifyCodexTraceDeadlineObservation({
        hookCompleted: true,
        reporterSettled: false,
      }),
    ).toBe("trace-await-reporter");
    expect(
      classifyCodexTraceDeadlineObservation({
        hookCompleted: true,
        reporterSettled: true,
      }),
    ).toBe("trace-await-search");
    for (const input of [
      { hookCompleted: false, reporterSettled: true },
      { hookCompleted: "completed", reporterSettled: false },
      { hookCompleted: true, reporterSettled: "settled" },
    ])
      expect(() =>
        classifyCodexTraceDeadlineObservation(input as never),
      ).toThrow("integration.codex.trace-observation");
  });

  it("reduces trace failure errors to a closed stage and kind without reflecting content", () => {
    const kinds = [
      ["integration.codex.trace-deadline", "deadline"],
      ["integration.codex.child-deadline", "child-deadline"],
      ["integration.codex.child", "child"],
      ["integration.codex.trace-search-child-exit-5", "child-exit-5"],
      ["integration.codex.trace-search-child-exit-other", "child-exit-other"],
      ["integration.codex.trace-search-child-signal", "child-signal"],
      [
        "integration.codex.trace-search-child-output-limit",
        "child-output-limit",
      ],
      ["integration.codex.trace-search-child-deadline", "child-deadline"],
      ["integration.codex.hook-log", "hook-log"],
      ["secret-bearing unexpected error", "other"],
      [undefined, "other"],
    ] as const;
    for (const [errorMessage, expectedKind] of kinds)
      expect(
        classifyCodexTraceFailureHint({
          errorMessage,
          hookCompleted: true,
          reporterSettled: true,
        }),
      ).toBe(`search-${expectedKind}`);
    expect(
      classifyCodexTraceFailureHint({
        errorMessage: "integration.codex.child",
        hookCompleted: false,
        reporterSettled: false,
      }),
    ).toBe("hook-child");
    expect(
      classifyCodexTraceFailureHint({
        errorMessage: "integration.codex.child",
        hookCompleted: true,
        reporterSettled: false,
      }),
    ).toBe("reporter-child");
  });

  it("classifies only bounded trace-search child status, never output content", () => {
    const base = {
      code: 0,
      deadlineExpired: false,
      signal: null,
      stderrBytes: 0,
      stdoutBytes: 0,
      maximumBytes: 4_096,
    };
    expect(codexTraceSearchChildFailureCategory({ ...base, code: 5 })).toBe(
      "exit-5",
    );
    expect(codexTraceSearchChildFailureCategory({ ...base, code: 1 })).toBe(
      "exit-other",
    );
    expect(
      codexTraceSearchChildFailureCategory({
        ...base,
        code: null,
        signal: "SIGKILL",
      }),
    ).toBe("signal");
    expect(
      codexTraceSearchChildFailureCategory({
        ...base,
        deadlineExpired: true,
      }),
    ).toBe("deadline");
    expect(
      codexTraceSearchChildFailureCategory({
        ...base,
        stderrBytes: 4_097,
      }),
    ).toBe("output-limit");
    expect(() => codexTraceSearchChildFailureCategory(base)).toThrow(
      "integration.codex.trace-search-child-observation",
    );
    expect(() =>
      codexTraceSearchChildFailureCategory({ ...base, stdoutBytes: -1 }),
    ).toThrow("integration.codex.trace-search-child-observation");
  });

  it("retries only the exact content-free trace-unavailable diagnostic", () => {
    const diagnostic = Buffer.from(
      '{"category":"unavailable","code":"traces.unavailable","command":"agentscope traces search","schema":"agentscope.cli.diagnostic.v1"}\n',
    );
    const exact = {
      code: 5,
      signal: null,
      stderr: diagnostic,
      stdout: Buffer.alloc(0),
    };
    expect(codexTraceSearchUnavailable(exact)).toBe(true);
    expect(codexTraceSearchUnavailable({ ...exact, code: 0 })).toBe(false);
    expect(
      codexTraceSearchUnavailable({ ...exact, stdout: Buffer.from("{}\n") }),
    ).toBe(false);
    expect(
      codexTraceSearchUnavailable({
        ...exact,
        stderr: Buffer.from(
          `${JSON.stringify({
            schema: "agentscope.cli.diagnostic.v1",
            command: "agentscope traces search",
            category: "unavailable",
            code: "traces.unavailable",
            detail: "substituted",
          })}\n`,
        ),
      }),
    ).toBe(false);
    expect(
      codexTraceSearchUnavailable({
        ...exact,
        stderr: Buffer.from(
          '{"category":"unavailable","code":"substituted","code":"traces.unavailable","command":"agentscope traces search","schema":"agentscope.cli.diagnostic.v1"}\n',
        ),
      }),
    ).toBe(false);
    expect(
      codexTraceSearchUnavailable({
        ...exact,
        stderr: Buffer.from("not-json\n"),
      }),
    ).toBe(false);
  });

  it("treats only an exact joined content-free trace-search cutoff as pending", () => {
    const exact = {
      code: null,
      deadlineExpired: true,
      signal: "SIGKILL" as const,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    };
    expect(codexTraceSearchTimedOut(exact)).toBe(true);
    expect(codexTraceSearchTimedOut({ ...exact, deadlineExpired: false })).toBe(
      false,
    );
    expect(codexTraceSearchTimedOut({ ...exact, code: 0 })).toBe(false);
    expect(codexTraceSearchTimedOut({ ...exact, signal: null })).toBe(false);
    expect(
      codexTraceSearchTimedOut({ ...exact, stderr: Buffer.from("late") }),
    ).toBe(false);
    expect(
      codexTraceSearchTimedOut({ ...exact, stdout: Buffer.from("{}\n") }),
    ).toBe(false);
  });

  it("reserves trace-search join time inside the immutable observation window", () => {
    expect(
      codexTraceSearchAttemptDeadlines({
        now: 1_000,
        observationDeadline: 20_000,
      }),
    ).toEqual({
      attemptDeadline: 19_500,
      childDeadline: 19_250,
      observationDeadline: 20_000,
    });
    expect(
      codexTraceSearchAttemptDeadlines({
        now: 17_499,
        observationDeadline: 20_000,
      }),
    ).toEqual({
      attemptDeadline: 19_500,
      childDeadline: 19_250,
      observationDeadline: 20_000,
    });
    expect(
      codexTraceSearchAttemptDeadlines({
        now: 17_500,
        observationDeadline: 20_000,
      }),
    ).toBeNull();
    expect(
      codexTraceSearchAttemptDeadlines({
        now: 20_000,
        observationDeadline: 20_000,
      }),
    ).toBeNull();
  });

  it.runIf(process.platform === "linux")(
    "classifies only one descriptor-bound Codex Stop hook outcome",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentscope-codex-hook-log-"));
      const directory = join(root, "log");
      mkdirSync(directory, { mode: 0o700 });
      const descriptor = openSync(
        directory,
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
      const path = join(directory, "codex-tui.log");
      const started =
        'TRACE codex.hooks.command{hook.event_name="Stop"}: new\n';
      const line = (outcome: string, repeated = false) =>
        `TRACE codex.hooks.command{hook.event_name="Stop" hook.command_outcome="${outcome}"${repeated ? ` hook.command_outcome="${outcome}"` : ""}}: close\n`;
      try {
        expect(
          classifyCodexStopHookCommand({
            directoryDescriptor: descriptor,
            directoryPath: directory,
          }),
        ).toBeUndefined();
        for (const outcome of [
          "completed",
          "timeout",
          "spawn_error",
          "stdin_error",
          "wait_error",
        ]) {
          writeFileSync(path, `${started}${line(outcome)}`);
          expect(
            classifyCodexStopHookCommand({
              directoryDescriptor: descriptor,
              directoryPath: directory,
            }),
          ).toBe(outcome);
          writeFileSync(path, `${started}${line(outcome, true)}`);
          expect(
            classifyCodexStopHookCommand({
              directoryDescriptor: descriptor,
              directoryPath: directory,
            }),
          ).toBe(outcome);
        }
        writeFileSync(path, `${started}${line("timeout")}${line("completed")}`);
        expect(() =>
          classifyCodexStopHookCommand({
            directoryDescriptor: descriptor,
            directoryPath: directory,
          }),
        ).toThrow("integration.codex.hook-log");
        writeFileSync(
          path,
          `${started}TRACE codex.hooks.command{hook.event_name="Stop" hook.command_outcome="completed" hook.command_outcome="completed" hook.command_outcome="completed"}: close\n`,
        );
        expect(() =>
          classifyCodexStopHookCommand({
            directoryDescriptor: descriptor,
            directoryPath: directory,
          }),
        ).toThrow("integration.codex.hook-log");
        writeFileSync(
          path,
          `${started}TRACE codex.hooks.command{hook.event_name="Stop"}: close\n`,
        );
        expect(() =>
          classifyCodexStopHookCommand({
            directoryDescriptor: descriptor,
            directoryPath: directory,
          }),
        ).toThrow("integration.codex.hook-log");
        writeFileSync(
          path,
          `${started}TRACE codex.hooks.command{hook.event_name="Stop" hook.event_name="SessionEnd" hook.command_outcome="timeout"}: close\n`,
        );
        expect(() =>
          classifyCodexStopHookCommand({
            directoryDescriptor: descriptor,
            directoryPath: directory,
          }),
        ).toThrow("integration.codex.hook-log");
        writeFileSync(
          path,
          `${started}TRACE codex.hooks.command{hook.event_name="Stop" hook.command_outcome="timeout" hook.command_outcome="completed"}: close\n`,
        );
        expect(() =>
          classifyCodexStopHookCommand({
            directoryDescriptor: descriptor,
            directoryPath: directory,
          }),
        ).toThrow("integration.codex.hook-log");
        for (const hostile of [
          `${line("completed")}${started}`,
          'TRACE codex.hooks.command{hook.event_name="Stop" hook.command_outcome="completed"}: new : close\n',
        ]) {
          writeFileSync(path, hostile);
          expect(() =>
            classifyCodexStopHookCommand({
              directoryDescriptor: descriptor,
              directoryPath: directory,
            }),
          ).toThrow("integration.codex.hook-log");
        }
      } finally {
        closeSync(descriptor);
        rmSync(root, { recursive: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "measures only one descriptor-bound Codex Stop command span",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentscope-codex-hook-log-"));
      const directory = join(root, "log");
      mkdirSync(directory, { mode: 0o700 });
      const descriptor = openSync(
        directory,
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
      const path = join(directory, "codex-tui.log");
      const inspect = (afterRead?: () => void) =>
        inspectCodexStopHookCommand({
          ...(afterRead === undefined ? {} : { afterRead }),
          directoryDescriptor: descriptor,
          directoryPath: directory,
        });
      const started =
        'TRACE codex.hooks.command{hook.event_name="Stop"}: new\n';
      const line = (durations = "time.busy=4.75s time.idle=125ms") =>
        `TRACE codex.hooks.command{hook.event_name="Stop" hook.command_outcome="completed"}: close ${durations}\n`;
      const repeatedLine = (durations = "time.busy=4.75s time.idle=125ms") =>
        `TRACE codex.hooks.command{hook.event_name="Stop" hook.command_outcome="completed" hook.command_outcome="completed"}: close ${durations}\n`;
      try {
        expect(inspect()).toBeUndefined();
        writeFileSync(path, `${started}${line()}`);
        expect(inspect()).toEqual({
          outcome: "completed",
          durationMilliseconds: 4_875,
        });
        writeFileSync(path, `${started}${repeatedLine()}`);
        expect(inspect()).toEqual({
          outcome: "completed",
          durationMilliseconds: 4_875,
        });
        writeFileSync(
          path,
          `${started}${line("time.busy=500us time.idle=0.25s")}`,
        );
        expect(inspect()).toEqual({
          outcome: "completed",
          durationMilliseconds: 250.5,
        });
        writeFileSync(
          path,
          `${started}TRACE codex.hooks.command{hook.event_name="Stop" hook.command_outcome="timeout"}: close time.busy=5ms time.idle=1ms\n`,
        );
        expect(inspect()).toEqual({
          outcome: "timeout",
          durationMilliseconds: 6,
        });
        expect(() =>
          inspect(() => {
            writeFileSync(path, "mutated", { flag: "a" });
          }),
        ).toThrow("integration.codex.hook-log");
        for (const hostile of [
          started,
          line(),
          `${line()}${started}`,
          'TRACE codex.hooks.command{hook.event_name="Stop" hook.command_outcome="completed"}: new : close time.busy=1ms time.idle=1ms\n',
          `${started}${started}${line()}`,
          `${started}${line()}${line()}`,
          `${started}${line("time.busy=1ms")}`,
          `${started}${line("time.busy=1ms time.busy=2ms time.idle=3ms")}`,
          `${started}${line("time.busy=120001ms time.idle=0ms")}`,
          `${started}TRACE codex.hooks.command{hook.event_name="Stop" hook.event_name="SessionStart" hook.command_outcome="completed"}: close time.busy=1ms time.idle=1ms\n`,
        ]) {
          writeFileSync(path, hostile);
          expect(inspect).toThrow("integration.codex.hook-log");
        }
      } finally {
        closeSync(descriptor);
        rmSync(root, { recursive: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "bounds SessionStart mediation from one exact new and close span",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentscope-codex-hook-log-"));
      const directory = join(root, "log");
      mkdirSync(directory, { mode: 0o700 });
      const descriptor = openSync(
        directory,
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
      const path = join(directory, "codex-tui.log");
      const measure = () =>
        codexSessionStartMediationUpperBoundMilliseconds({
          directoryDescriptor: descriptor,
          directoryPath: directory,
        });
      const started =
        '2026-08-31T12:00:00.000Z TRACE codex.hooks.command{hook.event_name="SessionStart"}: new\n';
      const completed = (durations = "time.busy=125ms time.idle=25ms") =>
        `2026-08-31T12:00:01.000Z TRACE codex.hooks.command{hook.event_name="SessionStart" hook.command_outcome="completed" hook.command_outcome="completed"}: close ${durations}\n`;
      try {
        expect(measure()).toBeUndefined();
        writeFileSync(path, `${started}${completed()}`);
        expect(measure()).toBe(150);
        writeFileSync(
          path,
          `${started}${completed("time.busy=500ms time.idle=500ms")}`,
        );
        expect(measure()).toBe(1_000);
        for (const hostile of [
          started,
          completed(),
          `${completed()}${started}`,
          'TRACE codex.hooks.command{hook.event_name="SessionStart" hook.command_outcome="completed"}: new : close time.busy=1ms time.idle=1ms\n',
          `${started}${started}${completed()}`,
          `${started}${completed()}${completed()}`,
          `${started}${completed("time.busy=1000ms time.idle=1ms")}`,
          `${started}${completed("time.busy=1ms")}`,
          `${started}${completed().replaceAll("completed", "timeout")}`,
          `${started}${completed().replace('hook.event_name="SessionStart"', 'hook.event_name="SessionStart" hook.event_name="Stop"')}`,
        ]) {
          writeFileSync(path, hostile);
          expect(measure).toThrow(
            /integration\.codex\.(?:hook-log|hook-mediation)/u,
          );
        }
      } finally {
        closeSync(descriptor);
        rmSync(root, { recursive: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "proves the closed root-hook lifecycle before the first model request",
    // eslint-disable-next-line max-lines-per-function -- one fixture preserves the causal checkpoint through terminal lifecycle negatives
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentscope-codex-hook-log-"));
      const directory = join(root, "log");
      mkdirSync(directory, { mode: 0o700 });
      const descriptor = openSync(
        directory,
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
      const span = (event: string, duration: string) =>
        `TRACE codex.hooks.command{hook.event_name="${event}"}: new\n` +
        `TRACE codex.hooks.command{hook.event_name="${event}" hook.command_outcome="completed" hook.command_outcome="completed"}: close ${duration}\n`;
      const sessionStart = span(
        "SessionStart",
        "time.busy=125ms time.idle=25ms",
      );
      const stop = span("Stop", "time.busy=4.75s time.idle=125ms");
      const sessionEnd = span("SessionEnd", "time.busy=100ms time.idle=50ms");
      const path = join(directory, "codex-tui.log");
      const input = {
        directoryDescriptor: descriptor,
        directoryPath: directory,
      };
      try {
        expect(classifyCodexSessionStartAtFailedPty(input)).toBe(
          "arm-log-unavailable",
        );
        writeFileSync(path, "TRACE codex.startup: ready\n");
        expect(classifyCodexSessionStartAtFailedPty(input)).toBe(
          "arm-hook-unseen",
        );
        expect(
          inspectCodexSessionStartBeforeFirstModelRequestAdmission(input),
        ).toBe(undefined);
        writeFileSync(path, "");
        expect(
          inspectCodexSessionStartBeforeFirstModelRequestAdmission(input),
        ).toBe(undefined);
        writeFileSync(
          path,
          'TRACE codex.hooks.command{hook.event_name="SessionStart"}: unfinished\n',
        );
        expect(() =>
          inspectCodexSessionStartBeforeFirstModelRequestAdmission(input),
        ).toThrow("integration.codex.hook-log");
        expect(() => classifyCodexSessionStartAtFailedPty(input)).toThrow(
          "integration.codex.hook-log",
        );
        writeFileSync(
          path,
          sessionStart.slice(0, sessionStart.indexOf("\n") + 1),
        );
        expect(classifyCodexSessionStartAtFailedPty(input)).toBe(
          "arm-hook-open",
        );
        expect(
          inspectCodexSessionStartBeforeFirstModelRequestAdmission(input),
        ).toBe(undefined);
        writeFileSync(path, sessionStart);
        expect(classifyCodexSessionStartAtFailedPty(input)).toBe(
          "arm-hook-completed",
        );
        const firstModelRequestCheckpoint =
          inspectCodexSessionStartBeforeFirstModelRequestAdmission(input);
        expect(firstModelRequestCheckpoint?.durationMilliseconds).toBe(150);
        expect(firstModelRequestCheckpoint?.spanSha256).toMatch(
          /^[a-f\d]{64}$/u,
        );
        writeFileSync(path, `${sessionStart}${stop}${sessionEnd}`);
        const lifecycle = inspectCodexRootHookLifecycle(input);
        expect(lifecycle).toEqual({
          sessionStartDurationMilliseconds: 150,
          sessionStartSpanSha256: firstModelRequestCheckpoint?.spanSha256,
          stopDurationMilliseconds: 4_875,
          sessionEndDurationMilliseconds: 150,
        });
        expect(
          codexSessionStartCheckpointMatchesLifecycle(
            firstModelRequestCheckpoint,
            lifecycle,
          ),
        ).toBe(true);
        const substitutedSessionStart = span(
          "SessionStart",
          "time.busy=100ms time.idle=50ms",
        );
        writeFileSync(path, `${substitutedSessionStart}${stop}${sessionEnd}`);
        const substitutedLifecycle = inspectCodexRootHookLifecycle(input);
        expect(substitutedLifecycle?.sessionStartDurationMilliseconds).toBe(
          firstModelRequestCheckpoint?.durationMilliseconds,
        );
        expect(substitutedLifecycle?.sessionStartSpanSha256).not.toBe(
          firstModelRequestCheckpoint?.spanSha256,
        );
        expect(
          codexSessionStartCheckpointMatchesLifecycle(
            firstModelRequestCheckpoint,
            substitutedLifecycle,
          ),
        ).toBe(false);
        writeFileSync(path, `${sessionStart}${stop}${sessionEnd}`);
        expect(codexSessionStartMediationUpperBoundMilliseconds(input)).toBe(
          150,
        );
        expect(classifyCodexStopHookCommand(input)).toBe("completed");
        expect(inspectCodexStopHookCommand(input)).toEqual({
          outcome: "completed",
          durationMilliseconds: 4_875,
        });
        for (const hostile of [
          `${sessionStart}${stop}`,
          `${sessionStart}${sessionEnd}${stop}`,
          `${sessionStart}${sessionStart}${stop}${sessionEnd}`,
          `${sessionStart}${stop}${sessionEnd}${sessionEnd}`,
          `${stop}${sessionStart}${sessionEnd}`,
          `${sessionStart}${stop}${sessionEnd.replaceAll(
            "completed",
            "timeout",
          )}`,
          `${sessionStart}${span(
            "PreToolUse",
            "time.busy=1ms time.idle=1ms",
          )}${stop}${sessionEnd}`,
          `${sessionStart}${span(
            "Stop",
            "time.busy=7s time.idle=1ms",
          )}${sessionEnd}`,
          `${sessionStart}${stop}${span(
            "SessionEnd",
            "time.busy=7s time.idle=1ms",
          )}`,
        ]) {
          writeFileSync(path, hostile);
          expect(() => inspectCodexRootHookLifecycle(input)).toThrow(
            /integration\.codex\.hook-(?:lifecycle|log)/u,
          );
        }
        writeFileSync(
          path,
          `${sessionStart}${span(
            "Stop",
            "time.busy=7s time.idle=0ms",
          )}${span("SessionEnd", "time.busy=7s time.idle=0ms")}`,
        );
        expect(inspectCodexRootHookLifecycle(input)).toMatchObject({
          stopDurationMilliseconds: 7_000,
          sessionEndDurationMilliseconds: 7_000,
        });
        writeFileSync(path, `${sessionStart}${stop}`);
        expect(() =>
          inspectCodexSessionStartBeforeFirstModelRequestAdmission(input),
        ).toThrow("integration.codex.hook-lifecycle");
      } finally {
        closeSync(descriptor);
        rmSync(root, { recursive: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects hostile Codex hook logs and substituted parents",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentscope-codex-hook-log-"));
      const directory = join(root, "log");
      const moved = join(root, "moved");
      mkdirSync(directory, { mode: 0o700 });
      const descriptor = openSync(
        directory,
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
      const path = join(directory, "codex-tui.log");
      const classify = (afterRead?: () => void) =>
        classifyCodexStopHookCommand({
          ...(afterRead === undefined ? {} : { afterRead }),
          directoryDescriptor: descriptor,
          directoryPath: directory,
        });
      try {
        writeFileSync(path, Buffer.from([0xff]));
        expect(classify).toThrow("integration.codex.hook-log");
        writeFileSync(path, "");
        // An empty live log is provisional, never a completed Stop witness.
        expect(classify()).toBe(undefined);
        writeFileSync(path, Buffer.alloc(1_048_577, 0x61));
        expect(classify).toThrow("integration.codex.hook-log");
        rmSync(path);
        mkdirSync(path);
        expect(classify).toThrow("integration.codex.hook-log");
        rmSync(path, { recursive: true });
        writeFileSync(join(root, "external"), "safe");
        symlinkSync(join(root, "external"), path);
        expect(classify).toThrow("integration.codex.hook-log");
        rmSync(path);
        writeFileSync(
          path,
          'TRACE codex.hooks.command{hook.event_name="Stop" hook.command_outcome="timeout"}: close\n',
        );
        expect(() =>
          classify(() => {
            writeFileSync(path, "mutated", { flag: "a" });
          }),
        ).toThrow("integration.codex.hook-log");
        renameSync(directory, moved);
        mkdirSync(directory);
        writeFileSync(
          join(directory, "codex-tui.log"),
          'TRACE codex.hooks.command{hook.event_name="Stop" hook.command_outcome="timeout"}: close\n',
        );
        expect(classify).toThrow("integration.codex.hook-log");
      } finally {
        closeSync(descriptor);
        rmSync(root, { recursive: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "holds the home identity and rejects symlinked session ancestors",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentscope-codex-ledger-"));
      const moved = `${root}-moved`;
      const external = mkdtempSync(
        join(tmpdir(), "agentscope-codex-external-"),
      );
      const day = join(root, ".codex", "sessions", "2026", "09", "14");
      mkdirSync(day, { recursive: true });
      const terminal = `${JSON.stringify({ type: "event_msg" })}\n`;
      writeFileSync(join(day, "rollout-exact.jsonl"), terminal);
      const descriptor = openSync(
        root,
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
      try {
        expect(readCodexSessionLedgers(descriptor)).toEqual([terminal]);
        const records = readCodexSessionLedgerRecords(descriptor);
        expect(records).toEqual([
          expect.objectContaining({
            relativePath: ".codex/sessions/2026/09/14/rollout-exact.jsonl",
            content: terminal,
          }),
        ]);
        expect(typeof records[0]?.dev).toBe("bigint");
        expect(typeof records[0]?.ino).toBe("bigint");
        renameSync(root, moved);
        mkdirSync(root);
        symlinkSync(external, join(root, ".codex"));
        expect(readCodexSessionLedgers(descriptor)).toEqual([terminal]);
        rmSync(join(moved, ".codex", "sessions", "2026", "09"), {
          recursive: true,
        });
        symlinkSync(external, join(moved, ".codex", "sessions", "2026", "09"));
        expect(() => readCodexSessionLedgers(descriptor)).toThrow(
          "integration.codex.session-ledger",
        );
      } finally {
        closeSync(descriptor);
        rmSync(root, { recursive: true, force: true });
        rmSync(moved, { recursive: true, force: true });
        rmSync(external, { recursive: true, force: true });
      }
    },
  );

  it("rejects same-size rewrites and growth across ledger snapshots", () => {
    const identity = {
      dev: 1n,
      ino: 2n,
      mode: 0o100600n,
      uid: 3n,
      gid: 4n,
      size: 2n,
      mtimeNs: 5n,
      ctimeNs: 6n,
    };
    expect(
      settledCodexLedgerSnapshot({
        before: identity,
        first: Buffer.from("a\n"),
        middle: identity,
        second: Buffer.from("a\n"),
        after: identity,
      }),
    ).toBe("a\n");
    expect(
      settledCodexLedgerSnapshot({
        before: identity,
        first: Buffer.from("a\n"),
        middle: identity,
        second: Buffer.from("b\n"),
        after: identity,
      }),
    ).toBeNull();
    expect(
      settledCodexLedgerSnapshot({
        before: identity,
        first: Buffer.from("a\n"),
        middle: identity,
        second: Buffer.from("a\n"),
        after: { ...identity, size: 3n, mtimeNs: 7n, ctimeNs: 7n },
      }),
    ).toBeNull();
  });
});

// Lifecycle fixtures keep descriptor identity, durable acceptance, and
// settlement adversaries adjacent.
// eslint-disable-next-line max-lines-per-function
describe("Codex Local SQLite reporter settlement", () => {
  it.runIf(process.platform === "linux")(
    "requires a new durable Local SQLite acceptance after the exact baseline",
    // eslint-disable-next-line max-lines-per-function -- one closed operational-state adversary matrix
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentscope-codex-health-"));
      const health = join(root, ".agentscope", "health");
      mkdirSync(health, { recursive: true });
      const homeDescriptor = openSync(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      const statePath = join(health, "operational-state-v1.json");
      const accepted = {
        version: 1,
        nextSequence: 1,
        losses: { diagnostics: 0, health: 0, checkpoints: 0 },
        diagnostics: [],
        health: [
          {
            scope: "connection",
            stage: "remote-acceptance",
            outcome: "accepted",
            configurationGeneration: 1,
            policyMode: "baseline",
            destinationType: "@agentscope/destination-local-sqlite",
            connectionId: `destination-connection-v1-${"a".repeat(64)}`,
            receipt: "accepted",
            sequence: 0,
            observedAtUnixMilliseconds: 1,
          },
        ],
        checkpoints: [],
      };
      const healthDescriptor = openOperationalStateHealth(homeDescriptor);
      try {
        const baseline = localSqliteAcceptanceBaseline(healthDescriptor);
        expect(baseline).toEqual({
          nextSequence: 0,
          losses: { diagnostics: 0, health: 0, checkpoints: 0 },
          diagnostics: [],
          health: [],
          checkpoints: [],
        });
        writeFileSync(statePath, `${JSON.stringify(accepted)}\n`);
        expect(
          localSqliteAcceptanceObservedAfterBaseline(
            healthDescriptor,
            baseline,
          ),
        ).toBe(true);
        expect(
          classifyLocalSqliteOutcomeAfterBaseline(healthDescriptor, baseline),
        ).toBe("hook-accepted-without-trace");
        const afterAcceptance = localSqliteAcceptanceBaseline(healthDescriptor);
        expect(
          localSqliteAcceptanceObservedAfterBaseline(
            healthDescriptor,
            afterAcceptance,
          ),
        ).toBe(false);
        expect(
          classifyLocalSqliteOutcomeAfterBaseline(
            healthDescriptor,
            afterAcceptance,
          ),
        ).toBe("no-operational-state");
        for (const [scope, stage, outcome, receipt, expected] of [
          ["hook", "hook-started", "suppressed", null, "hook-start-suppressed"],
          [
            "hook",
            "capture",
            "deadline-exceeded",
            null,
            "hook-capture-deadline",
          ],
          ["hook", "routing", "no-route", null, "hook-routing-no-route"],
          [
            "connection",
            "delivery",
            "unavailable",
            "unavailable",
            "hook-delivery-unavailable",
          ],
        ] as const) {
          const healthEntry = {
            ...accepted.health[0],
            scope,
            stage,
            outcome,
            receipt,
            ...(scope === "hook"
              ? { destinationType: undefined, connectionId: undefined }
              : {}),
          };
          const normalizedHealthEntry = Object.fromEntries(
            Object.entries(healthEntry).filter(
              ([, value]) => value !== undefined,
            ),
          );
          writeFileSync(
            statePath,
            `${JSON.stringify({ ...accepted, health: [normalizedHealthEntry] })}\n`,
          );
          expect(
            classifyLocalSqliteOutcomeAfterBaseline(healthDescriptor, baseline),
          ).toBe(expected);
        }
        writeFileSync(
          statePath,
          `${JSON.stringify({
            ...accepted,
            health: [{ ...accepted.health[0], substituted: true }],
          })}\n`,
        );
        expect(() =>
          localSqliteAcceptanceObservedAfterBaseline(
            healthDescriptor,
            baseline,
          ),
        ).toThrow("integration.codex.operational-state");
        writeFileSync(statePath, ` ${JSON.stringify(accepted)}\n`);
        expect(() => localSqliteAcceptanceBaseline(healthDescriptor)).toThrow(
          "integration.codex.operational-state",
        );
        writeFileSync(
          statePath,
          `${JSON.stringify({
            ...accepted,
            losses: { diagnostics: 0, health: 0 },
          })}\n`,
        );
        expect(() => localSqliteAcceptanceBaseline(healthDescriptor)).toThrow(
          "integration.codex.operational-state",
        );
        writeFileSync(
          statePath,
          `${JSON.stringify({ ...accepted, diagnostics: [{}] })}\n`,
        );
        expect(() => localSqliteAcceptanceBaseline(healthDescriptor)).toThrow(
          "integration.codex.operational-state",
        );
      } finally {
        closeSync(healthDescriptor);
        closeSync(homeDescriptor);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "holds the health directory and rejects path and logical-history substitution",
    // eslint-disable-next-line max-lines-per-function -- one descriptor-bound replacement matrix
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentscope-codex-health-"));
      const health = join(root, ".agentscope", "health");
      const moved = `${health}-moved`;
      mkdirSync(health, { recursive: true });
      const homeDescriptor = openSync(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      const healthDescriptor = openOperationalStateHealth(homeDescriptor);
      const connection = {
        scope: "connection",
        stage: "remote-acceptance",
        outcome: "accepted",
        configurationGeneration: 1,
        policyMode: "baseline",
        destinationType: "@agentscope/destination-local-sqlite",
        connectionId: `destination-connection-v1-${"b".repeat(64)}`,
        receipt: "accepted",
        sequence: 1,
        observedAtUnixMilliseconds: 2,
      };
      const initialHealth = {
        scope: "hook",
        stage: "hook-started",
        outcome: "completed",
        configurationGeneration: 1,
        policyMode: "baseline",
        receipt: null,
        sequence: 0,
        observedAtUnixMilliseconds: 1,
      };
      const initial = {
        version: 1,
        nextSequence: 1,
        losses: { diagnostics: 0, health: 0, checkpoints: 0 },
        diagnostics: [],
        health: [initialHealth],
        checkpoints: [],
      };
      try {
        writeFileSync(
          join(health, "operational-state-v1.json"),
          `${JSON.stringify(initial)}\n`,
        );
        const baseline = localSqliteAcceptanceBaseline(healthDescriptor);
        renameSync(health, moved);
        mkdirSync(health);
        writeFileSync(
          join(health, "operational-state-v1.json"),
          `${JSON.stringify({
            ...initial,
            nextSequence: 2,
            health: [initialHealth, connection],
          })}\n`,
        );
        expect(
          localSqliteAcceptanceObservedAfterBaseline(
            healthDescriptor,
            baseline,
          ),
        ).toBe(false);
        writeFileSync(
          join(moved, "operational-state-v1.json"),
          `${JSON.stringify({
            ...initial,
            nextSequence: 2,
            health: [initialHealth, connection],
          })}\n`,
        );
        expect(
          localSqliteAcceptanceObservedAfterBaseline(
            healthDescriptor,
            baseline,
          ),
        ).toBe(true);
        writeFileSync(
          join(moved, "operational-state-v1.json"),
          `${JSON.stringify({
            ...initial,
            nextSequence: 3,
            health: [
              {
                ...initialHealth,
                stage: "delivery",
                sequence: 1,
                observedAtUnixMilliseconds: 2,
              },
              { ...connection, sequence: 2, observedAtUnixMilliseconds: 2 },
            ],
          })}\n`,
        );
        expect(
          localSqliteAcceptanceObservedAfterBaseline(
            healthDescriptor,
            baseline,
          ),
        ).toBe(true);
        writeFileSync(
          join(moved, "operational-state-v1.json"),
          `${JSON.stringify({
            ...initial,
            nextSequence: 2,
            health: [
              { ...initialHealth, observedAtUnixMilliseconds: 9 },
              connection,
            ],
          })}\n`,
        );
        expect(() =>
          localSqliteAcceptanceObservedAfterBaseline(
            healthDescriptor,
            baseline,
          ),
        ).toThrow("integration.codex.operational-state");
      } finally {
        closeSync(healthDescriptor);
        closeSync(homeDescriptor);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "binds one exact lifecycle and accepts only stable empty settlement",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentscope-codex-sqlite-"));
      const namespace = join(
        root,
        ".agentscope",
        "destinations",
        "local-sqlite",
        "a".repeat(64),
      );
      const lifecycle = join(namespace, "lifecycle");
      mkdirSync(lifecycle, { recursive: true });
      const homeDescriptor = openSync(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      let lifecycleDescriptor;
      try {
        lifecycleDescriptor = openLocalSqliteLifecycle(homeDescriptor);
        expect(localSqliteReporterSettled(lifecycleDescriptor)).toBe(true);
        writeFileSync(join(lifecycle, `lease-${"b".repeat(32)}.json`), "{}\n");
        expect(localSqliteReporterSettled(lifecycleDescriptor)).toBe(false);
        rmSync(join(lifecycle, `lease-${"b".repeat(32)}.json`));
        writeFileSync(
          join(lifecycle, `lease-cleanup-${"c".repeat(32)}.json`),
          "{}\n",
        );
        expect(localSqliteReporterSettled(lifecycleDescriptor)).toBe(false);
      } finally {
        if (lifecycleDescriptor !== undefined) closeSync(lifecycleDescriptor);
        closeSync(homeDescriptor);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects ambiguous namespaces, symlink ancestors, and unknown entries",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentscope-codex-sqlite-"));
      const localSqlite = join(
        root,
        ".agentscope",
        "destinations",
        "local-sqlite",
      );
      mkdirSync(join(localSqlite, "a".repeat(64), "lifecycle"), {
        recursive: true,
      });
      const homeDescriptor = openSync(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        mkdirSync(join(localSqlite, "b".repeat(64), "lifecycle"), {
          recursive: true,
        });
        expect(() => openLocalSqliteLifecycle(homeDescriptor)).toThrow(
          "integration.codex.local-sqlite-settlement",
        );
        rmSync(join(localSqlite, "b".repeat(64)), { recursive: true });
        const lifecycleDescriptor = openLocalSqliteLifecycle(homeDescriptor);
        try {
          writeFileSync(
            join(localSqlite, "a".repeat(64), "lifecycle", "unknown"),
            "",
          );
          expect(() => localSqliteReporterSettled(lifecycleDescriptor)).toThrow(
            "integration.codex.local-sqlite-settlement",
          );
        } finally {
          closeSync(lifecycleDescriptor);
        }
        rmSync(join(root, ".agentscope"), { recursive: true });
        symlinkSync(tmpdir(), join(root, ".agentscope"));
        expect(() => openLocalSqliteLifecycle(homeDescriptor)).toThrow(
          "integration.codex.local-sqlite-settlement",
        );
      } finally {
        closeSync(homeDescriptor);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("Codex Local SQLite settlement snapshots", () => {
  it("accepts only an unchanged empty lifecycle snapshot", () => {
    const identity = {
      dev: 1n,
      ino: 2n,
      mode: 0o40700n,
      uid: 3n,
      gid: 4n,
      size: 0n,
      mtimeNs: 5n,
      ctimeNs: 6n,
    };
    expect(
      settledLocalSqliteLifecycleSnapshot({
        before: identity,
        first: [],
        middle: identity,
        second: [],
        after: identity,
      }),
    ).toBe(true);
    const lease = {
      kind: "file",
      name: `lease-${"a".repeat(32)}.json`,
    };
    expect(
      settledLocalSqliteLifecycleSnapshot({
        before: identity,
        first: [lease],
        middle: identity,
        second: [lease],
        after: identity,
      }),
    ).toBe(false);
    expect(
      settledLocalSqliteLifecycleSnapshot({
        before: identity,
        first: [],
        middle: { ...identity, mtimeNs: 7n },
        second: [],
        after: { ...identity, mtimeNs: 7n },
      }),
    ).toBe(false);
    expect(() =>
      settledLocalSqliteLifecycleSnapshot({
        before: identity,
        first: [{ kind: "other", name: "exclusive-fence-v1" }],
        middle: identity,
        second: [{ kind: "other", name: "exclusive-fence-v1" }],
        after: identity,
      }),
    ).toThrow("integration.codex.local-sqlite-settlement");
    expect(() =>
      settledLocalSqliteLifecycleSnapshot({
        before: identity,
        first: [{ kind: "file", name: "unknown" }],
        middle: identity,
        second: [{ kind: "file", name: "unknown" }],
        after: identity,
      }),
    ).toThrow("integration.codex.local-sqlite-settlement");
  });
});

// eslint-disable-next-line max-lines-per-function -- closed native-record adversarial matrix
describe("Codex bounded native records", () => {
  it("rejects a terminal observation at the exact deadline cutoff", () => {
    let observedAt = 99;
    const now = () => observedAt;
    expect(
      terminalObservationBeforeDeadline({
        observed: true,
        deadline: 100,
        now,
      }),
    ).toBe(true);
    observedAt = 100;
    expect(
      terminalObservationBeforeDeadline({
        observed: true,
        deadline: 100,
        now,
      }),
    ).toBe(false);
  });

  it("rechecks the cutoff after recording the terminal diagnostic", async () => {
    let observedAt = 99;
    let published = false;
    await expect(
      publishTerminalCompletionBeforeDeadline({
        deadline: 100,
        now: () => observedAt,
        record: () => {
          observedAt = 100;
        },
        publish: () => {
          published = true;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("integration.codex.trace-deadline");
    expect(published).toBe(false);
  });

  it("rejects a synchronous diagnostic that crosses the immutable cutoff", () => {
    let observedAt = 99;
    let inspected = 0;
    expect(() =>
      inspectDiagnosticBeforeDeadline({
        deadline: 100,
        now: () => observedAt,
        inspect: () => {
          inspected += 1;
          observedAt = 100;
          return "timeout";
        },
      }),
    ).toThrow("integration.codex.trace-deadline");
    expect(inspected).toBe(1);
  });

  it("admits no phase record before or after the immutable cutoff", () => {
    let observedAt = 100;
    let records = 0;
    expect(() => {
      recordTerminalObservationBeforeDeadline({
        deadline: 100,
        now: () => observedAt,
        record: () => {
          records += 1;
        },
      });
    }).toThrow("integration.codex.trace-deadline");
    expect(records).toBe(0);

    observedAt = 99;
    expect(() => {
      recordTerminalObservationBeforeDeadline({
        deadline: 100,
        now: () => observedAt,
        record: () => {
          records += 1;
          observedAt = 100;
        },
      });
    }).toThrow("integration.codex.trace-deadline");
    expect(records).toBe(1);
  });

  it("publishes no trace classification when classification reaches the cutoff", () => {
    let clockRead = 0;
    const phases: string[] = [];
    expect(() => {
      classifyTraceSearchRecordsBeforeDeadline({
        records: [],
        deadline: 100,
        now: () => (clockRead++ === 0 ? 99 : 100),
        record: (phase: string) => {
          phases.push(phase);
        },
      });
    }).toThrow("integration.codex.trace-deadline");
    expect(phases).toEqual([]);
  });

  it("rejects a completed trace search at the exact deadline cutoff", () => {
    let observedAt = 99;
    const now = () => observedAt;
    expect(
      traceSummaryBeforeDeadline({ summary: "trace", deadline: 100, now }),
    ).toBe("trace");
    observedAt = 100;
    expect(() =>
      traceSummaryBeforeDeadline({ summary: "trace", deadline: 100, now }),
    ).toThrow("integration.codex.trace-deadline");
  });

  it("accepts exactly one complete native task-terminal witness", () => {
    const message = "AGENTSCOPE_PTY_COMPLETE";
    const terminal = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-1",
        last_agent_message: message,
      },
    });
    expect(codexTurnTerminalObserved([], message)).toBe(false);
    expect(codexTurnTerminalObserved([`${terminal}\n`], message)).toBe(true);
    expect(codexTurnTerminalObserved([terminal], message)).toBe(false);
    expect(() =>
      codexTurnTerminalObserved([`${terminal}\n${terminal}\n`], message),
    ).toThrow("integration.codex.session-ledger");
    expect(() =>
      codexTurnTerminalObserved(
        [
          `${JSON.stringify({
            type: "event_msg",
            payload: {
              type: "task_complete",
              turn_id: "turn-1",
              last_agent_message: "substituted",
            },
          })}\n`,
        ],
        message,
      ),
    ).toThrow("integration.codex.session-ledger");
    expect(() => codexTurnTerminalObserved(["{\n"], message)).toThrow(
      "integration.codex.session-ledger",
    );
    const record = (content: string, overrides = {}) => ({
      relativePath:
        ".codex/sessions/2026/09/16/rollout-2026-09-16T00:00:00-test.jsonl",
      dev: 1n,
      ino: 2n,
      mode: 0o100600n,
      uid: 1000n,
      gid: 1000n,
      content,
      ...overrides,
    });
    const baseline = [record(`${JSON.stringify({ type: "session_meta" })}\n`)];
    expect(
      codexTurnTerminalObservedAfterBaseline(baseline, baseline, message),
    ).toBe(false);
    expect(
      codexTurnTerminalObservedAfterBaseline(
        [record(`${baseline[0]!.content}${terminal}\n`)],
        baseline,
        message,
      ),
    ).toBe(true);
    expect(() =>
      codexTurnTerminalObservedAfterBaseline(
        [record(`${baseline[0]!.content}${terminal}\n`, { ino: 3n })],
        baseline,
        message,
      ),
    ).toThrow("integration.codex.session-ledger");
    expect(() =>
      codexTurnTerminalObservedAfterBaseline(
        [record(`${terminal}\n`)],
        [record(`${terminal}\n`)],
        message,
      ),
    ).toThrow("integration.codex.session-ledger");
    expect(() =>
      codexTurnTerminalObservedAfterBaseline(
        [
          record(`${baseline[0]!.content}${terminal}\n`),
          record("unrelated\n", {
            relativePath:
              ".codex/sessions/2026/09/16/rollout-2026-09-16T00:00:01-extra.jsonl",
            ino: 4n,
          }),
        ],
        baseline,
        message,
      ),
    ).toThrow("integration.codex.session-ledger");
  });

  it("extracts exactly one bounded Codex session identity", () => {
    const record = (content: string, overrides = {}) => ({
      relativePath:
        ".codex/sessions/2026/09/16/rollout-2026-09-16T00:00:00-test.jsonl",
      dev: 1n,
      ino: 2n,
      mode: 0o100600n,
      uid: 1000n,
      gid: 1000n,
      content,
      ...overrides,
    });
    const session = (id: unknown) =>
      JSON.stringify({ type: "session_meta", payload: { id } });
    expect(codexSessionIdentity([record(`${session("session-1")}\n`)])).toBe(
      "session-1",
    );
    for (const content of [
      "",
      `${session(1)}\n`,
      `${session("")}\n`,
      `${session("x".repeat(257))}\n`,
      `${session("session-1")}\n${session("session-2")}\n`,
      session("session-1"),
    ])
      expect(() => codexSessionIdentity([record(content)])).toThrow(
        "integration.codex.session-ledger",
      );
    expect(() => codexSessionIdentity([])).toThrow(
      "integration.codex.session-ledger",
    );
  });

  it("reads one bounded JSON response and rejects overflow or malformed data", async () => {
    await expect(
      readBoundedJsonResponse(
        new Response(JSON.stringify([{ method: "POST" }])),
        128,
      ),
    ).resolves.toEqual([{ method: "POST" }]);
    await expect(
      readBoundedJsonResponse(new Response("x".repeat(129)), 128),
    ).rejects.toThrow("integration.codex.sidecar");
    await expect(
      readBoundedJsonResponse(new Response("{"), 128),
    ).rejects.toThrow("integration.codex.sidecar");
  });

  it("retains all request records and rejects extra capacity or non-records", () => {
    const records = [{ path: "/v1/responses" }, { path: "/unexpected" }];
    expect(boundedRequestLedger(records)).toHaveLength(2);
    expect(() =>
      boundedRequestLedger(Array.from({ length: 9 }, () => ({}))),
    ).toThrow("integration.codex.model-request");
    expect(() => boundedRequestLedger([null])).toThrow(
      "integration.codex.model-request",
    );
  });

  it("never lets an observation backoff survive its absolute deadline", async () => {
    const boundedWait = waitWithinObservationDeadline;
    let now = 14_000;
    const waits: number[] = [];
    const wait = (milliseconds: number) => {
      waits.push(milliseconds);
      now += milliseconds;
      return Promise.resolve();
    };
    await expect(
      boundedWait({
        deadline: 15_000,
        maximumWaitMilliseconds: 500,
        now: () => now,
        wait,
      }),
    ).resolves.toBeUndefined();
    expect(waits).toEqual([500]);
    now = 14_900;
    await expect(
      boundedWait({
        deadline: 15_000,
        maximumWaitMilliseconds: 500,
        now: () => now,
        wait,
      }),
    ).rejects.toThrow("integration.codex.trace-deadline");
    expect(waits).toEqual([500, 100]);
    await expect(
      boundedWait({
        deadline: 15_000,
        maximumWaitMilliseconds: 500,
        now: () => now,
        wait,
      }),
    ).rejects.toThrow("integration.codex.trace-deadline");
    expect(waits).toEqual([500, 100]);
  });

  it("starts no model-ledger request after its diagnostic cutoff", async () => {
    const requests: AbortSignal[] = [];
    await expect(
      waitForModelRequestBeforeDeadline({
        deadline: 100,
        now: () => 100,
        request: (signal) => {
          requests.push(signal);
          return Promise.resolve([]);
        },
        wait: () => Promise.resolve(),
      }),
    ).rejects.toThrow("integration.codex.diagnostic-deadline");
    expect(requests).toEqual([]);
  });

  it("aborts and joins an in-flight model-ledger request at the cutoff", async () => {
    let now = 0;
    let joined = false;
    const request = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            joined = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    const observation = waitForModelRequestBeforeDeadline({
      deadline: 10,
      now: () => now,
      request,
      wait: () => Promise.resolve(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    now = 10;
    await expect(observation).rejects.toThrow(
      "integration.codex.diagnostic-deadline",
    );
    expect(joined).toBe(true);
  });

  it("starts no later request when the diagnostic cutoff ends a backoff", async () => {
    let now = 99;
    let requests = 0;
    let pendingWait = false;
    await expect(
      waitForModelRequestBeforeDeadline({
        deadline: 100,
        now: () => now,
        request: () => {
          requests += 1;
          return Promise.resolve([]);
        },
        wait: (milliseconds) => {
          pendingWait = true;
          now += milliseconds;
          pendingWait = false;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("integration.codex.diagnostic-deadline");
    expect(requests).toBe(1);
    expect(pendingWait).toBe(false);
  });
});
