import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { sanitizeFixtureResult } from "./operations.js";
import { compileInteractivePtyActions } from "./interactive-pty-actions.js";
import type { CapabilityManifest } from "./manifest.js";

// @ts-expect-error private checksum-bound scenario module has no declaration
import * as adapterModule from "../fixtures/claude-code-platform-adapter.mjs";
// @ts-expect-error private integration authority has no declaration
import * as authorityModule from "../immutable-candidate-authority.mjs";

const { claudeScenarioFailureDiagnostic, encodeInteractiveFailureExitCode } =
  authorityModule as {
    claudeScenarioFailureDiagnostic: (error: unknown, phase: string) => string;
    encodeInteractiveFailureExitCode: (
      diagnostic: string,
      scenario: string,
    ) => number | undefined;
  };

const { claudeCodeInteractiveInvocation } = adapterModule as {
  claudeCodeInteractiveInvocation: (endpoint: string) => Readonly<{
    environment: Readonly<Record<string, string>>;
  }>;
};
const assertActualClaudeEndpoint = (
  endpoint: string,
  record: (event: string) => void,
) => {
  // Real adapter/environment factory; native execution remains synthetic.
  const invocation = claudeCodeInteractiveInvocation(endpoint);
  expect(invocation.environment.ANTHROPIC_BASE_URL).toBe(
    "http://mockserver.agentscope.internal:1080",
  );
  record("vendor-start");
};

const source = readFileSync(
  new URL("../claude-code-scenario.mjs", import.meta.url),
  "utf8",
);
const start = source.indexOf("const waitForClaudeModelPair =");
const end = source.indexOf("\nconst isClaudeScenarioMain =", start);
if (start < 0 || end < 0) throw new Error("synthetic-main-source-boundary");
const main = source.slice(start, end).replace("export const", "const");

it.each([
  [1, null, "code;1"],
  [null, "SIGUSR2", "signal;12"],
  [null, "UNKNOWN", undefined],
  [0, "SIGTERM", undefined],
] as const)(
  "preserves actual refused child close %s/%s in the owned marker",
  async (code, signal, suffix) => {
    const registry = new WeakMap();
    const signals = { SIGUSR2: 12, SIGTERM: 15 };
    const begin = source.indexOf("export const runClaudeCodeInteractiveTurn =");
    const finish = source.indexOf("\nconst publishClaudeMarker", begin);
    const body = source
      .slice(begin, finish)
      .replace("export const", "const")
      .replace(
        'const { claudeCodeInteractiveInvocation } =\n    await import("./scenario-adapter.mjs");',
        "",
      );
    const turn = runInNewContext(`${body}; runClaudeCodeInteractiveTurn`, {
      process: { stdin: { isTTY: true }, stdout: { isTTY: true }, env: {} },
      monotonicNow: () => 1,
      childTerminalFailures: registry,
      childSignals: signals,
      childCodeIsInteger: Number.isSafeInteger,
      childSignalHasOwn: Object.hasOwn,
      claudeCodeInteractiveInvocation: () => ({ environment: {} }),
      spawn: () => ({
        once: (
          event: string,
          callback: (code: unknown, signal: unknown) => void,
        ) => {
          if (event === "close") callback(code, signal);
        },
      }),
    }) as (endpoint: string, deadline: number) => Promise<void>;
    let failure: Error | undefined;
    try {
      await turn("internal", 100);
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).toBeDefined();
    if (failure === undefined)
      throw new Error("synthetic-child-refusal-missing");
    const original = failure;
    expect(registry.get(failure as object)).toBe(suffix);
    const caught = source
      .slice(source.indexOf("if (isClaudeScenarioMain())\n"))
      .replace("if (isClaudeScenarioMain())", "");
    const writes: unknown[][] = [];
    const childProcess = { exitCode: 0, stderr: { write: () => {} } };
    const run = runInNewContext(`(async () => { ${caught} })`, {
      process: childProcess,
      childTerminalFailures: registry,
      claudeFailurePhase: "model-pair",
      claudeScenarioFailureDiagnostic: () =>
        "integration.fixture.claude-vendor-terminal",
      encodeInteractiveFailureExitCode,
      runClaudeCodeScenario: () => Promise.reject(original),
      writeFileSync: (...args: unknown[]) => writes.push(args),
    }) as () => Promise<void>;
    await run();
    expect(writes[0]?.[1]).toBe(
      `integration.fixture.claude-vendor-terminal${suffix === undefined ? "" : `|${suffix}`}\n`,
    );
    expect(childProcess.exitCode).not.toBe(0);
  },
);

it("does not turn the genuine zero-code/null-signal close into a refusal", async () => {
  const begin = source.indexOf("export const runClaudeCodeInteractiveTurn =");
  const body = source
    .slice(begin, source.indexOf("\nconst publishClaudeMarker", begin))
    .replace("export const", "const")
    .replace(
      'const { claudeCodeInteractiveInvocation } =\n    await import("./scenario-adapter.mjs");',
      "",
    );
  const registry = new WeakMap();
  const turn = runInNewContext(`${body}; runClaudeCodeInteractiveTurn`, {
    process: { stdin: { isTTY: true }, stdout: { isTTY: true }, env: {} },
    monotonicNow: () => 1,
    childTerminalFailures: registry,
    childSignals: {},
    childCodeIsInteger: Number.isSafeInteger,
    childSignalHasOwn: Object.hasOwn,
    claudeCodeInteractiveInvocation: () => ({ environment: {} }),
    spawn: () => ({
      once: (event: string, callback: (code: number, signal: null) => void) => {
        if (event === "close") callback(0, null);
      },
    }),
  }) as (endpoint: string, deadline: number) => Promise<void>;
  await expect(turn("internal", 100)).resolves.toBeUndefined();
});

it.each([
  [
    "bootstrap",
    "integration.claude-code.environment",
    "integration.fixture.claude-environment",
    200,
  ],
  [
    "packed-init",
    "PRIVATE",
    "integration.fixture.claude-phase-packed-init",
    240,
  ],
  [
    "packed-configure",
    "PRIVATE",
    "integration.fixture.claude-phase-packed-configure",
    241,
  ],
  [
    "packed-routing",
    "PRIVATE",
    "integration.fixture.claude-phase-packed-routing",
    242,
  ],
  [
    "packed-hook-install",
    "PRIVATE",
    "integration.fixture.claude-phase-packed-hook-install",
    243,
  ],
  [
    "packed-status",
    "integration.codex.cli-output",
    "integration.fixture.claude-phase-packed-status",
    244,
  ],
  [
    "packed-settings",
    "PRIVATE",
    "integration.fixture.claude-phase-packed-settings",
    245,
  ],
  [
    "packed-hook-absent",
    "PRIVATE",
    "integration.fixture.claude-phase-packed-hook-absent",
    246,
  ],
  [
    "packed-hook-adapter-missing",
    "PRIVATE",
    "integration.fixture.claude-phase-packed-hook-adapter-missing",
    247,
  ],
  [
    "packed-hook-discovery-indeterminate",
    "PRIVATE",
    "integration.fixture.claude-phase-packed-hook-discovery-indeterminate",
    248,
  ],
  [
    "packed-hook-installation-unsupported",
    "PRIVATE",
    "integration.fixture.claude-phase-packed-hook-installation-unsupported",
    249,
  ],
  [
    "packed-hook-overlap-conflict",
    "PRIVATE",
    "integration.fixture.claude-phase-packed-hook-overlap-conflict",
    250,
  ],
  [
    "packed-hook-plan-invalid",
    "PRIVATE",
    "integration.fixture.claude-phase-packed-hook-plan-invalid",
    251,
  ],
  [
    "packed-hook-recovery-required",
    "PRIVATE",
    "integration.fixture.claude-phase-packed-hook-recovery-required",
    252,
  ],
  [
    "packed-hook-unavailable",
    "PRIVATE",
    "integration.fixture.claude-phase-packed-hook-unavailable",
    253,
  ],
  [
    "packed-hook-version-unsupported",
    "PRIVATE",
    "integration.fixture.claude-phase-packed-hook-version-unsupported",
    254,
  ],
  [
    "packed-hook-internal",
    "PRIVATE",
    "integration.fixture.claude-phase-packed-hook-internal",
    255,
  ],
] as const)(
  "preserves the Claude refusal at actual fixed phase %s through the top-level catch",
  async (phase, message, predicate, exit) => {
    const boundary = source.indexOf("if (isClaudeScenarioMain())\n");
    expect(boundary).toBeGreaterThan(0);
    const caught = source
      .slice(boundary)
      .replace("if (isClaudeScenarioMain())", "");
    const writes: unknown[][] = [];
    const stderr: string[] = [];
    const process = {
      stderr: { write: (value: string) => stderr.push(value) },
      exitCode: 0,
    };
    const run = runInNewContext(`(async () => { ${caught} })`, {
      process,
      claudeScenarioFailureDiagnostic,
      encodeInteractiveFailureExitCode,
      claudeFailurePhase: phase,
      writeFileSync: (...args: unknown[]) => writes.push(args),
      runClaudeCodeScenario: () => Promise.reject(new Error(message)),
    }) as () => Promise<void>;
    await run();
    expect(writes).toEqual([
      [
        "/ledger/interactive-failure.txt",
        `${predicate}\n`,
        { flag: "wx", mode: 0o600 },
      ],
    ]);
    expect(process.exitCode).toBe(exit);
    expect(stderr).toEqual(["integration.claude-code.scenario\n"]);
  },
);

it("keeps failed/conflicting marker publication a refusal without reflecting the error", async () => {
  const boundary = source.indexOf("if (isClaudeScenarioMain())\n");
  const caught = source
    .slice(boundary)
    .replace("if (isClaudeScenarioMain())", "");
  const original = new Error("PRIVATE_CANARY");
  const stderr: string[] = [];
  const process = {
    stderr: { write: (value: string) => stderr.push(value) },
    exitCode: 0,
  };
  const run = runInNewContext(`(async () => { ${caught} })`, {
    process,
    claudeScenarioFailureDiagnostic,
    encodeInteractiveFailureExitCode,
    claudeFailurePhase: "packed-install",
    writeFileSync: () => {
      throw new Error("EEXIST:PRIVATE_CANARY");
    },
    runClaudeCodeScenario: () => Promise.reject(original),
  }) as () => Promise<void>;
  await run();
  expect(process.exitCode).toBe(1);
  expect(original.message).toBe("PRIVATE_CANARY");
  expect(stderr).toEqual(["integration.claude-code.scenario\n"]);
});

describe("Claude actual module entry", () => {
  it("executes the same environment refusal through direct and aliased entries", () => {
    const target = fileURLToPath(
      new URL("../claude-code-scenario.mjs", import.meta.url),
    );
    const directory = mkdtempSync(join(tmpdir(), "agentscope-claude-entry-"));
    const alias = join(directory, "entry.mjs");
    try {
      symlinkSync(target, alias);
      for (const entry of [target, alias]) {
        // Invalid arguments/environment refuse before any vendor execution.
        const result = spawnSync(process.execPath, [entry], {
          env: {},
          encoding: "utf8",
          maxBuffer: 1024,
          timeout: 5000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.signal).toBeNull();
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("integration.claude-code.scenario\n");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([undefined, process.execPath, "missing"])(
    "keeps ordinary library import inert (entry=%s)",
    (candidate) => {
      const directory = mkdtempSync(
        join(tmpdir(), "agentscope-claude-import-"),
      );
      try {
        const entry =
          candidate === "missing" ? join(directory, "missing.mjs") : candidate;
        const target = new URL("../claude-code-scenario.mjs", import.meta.url);
        const result = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `await import(${JSON.stringify(target.href)})`,
            ...(entry === undefined ? [] : [entry]),
          ],
          { env: {}, encoding: "utf8", maxBuffer: 1024, timeout: 5000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.signal).toBeNull();
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "executes the environment refusal through an inherited procfs descriptor",
    () => {
      const descriptor = openSync(
        new URL("../claude-code-scenario.mjs", import.meta.url),
        "r",
      );
      try {
        const result = spawnSync(process.execPath, ["/proc/self/fd/3"], {
          env: {},
          stdio: ["ignore", "pipe", "pipe", descriptor],
          encoding: "utf8",
          maxBuffer: 1024,
          timeout: 5000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.signal).toBeNull();
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("integration.claude-code.scenario\n");
      } finally {
        closeSync(descriptor);
      }
    },
  );
});

describe("Claude selected PTY input", () => {
  it("reuses the selected challenge only for the exact Claude evidence and scenario", () => {
    const runnerSource = readFileSync(
      new URL("../runner.mjs", import.meta.url),
      "utf8",
    );
    const begin = runnerSource.indexOf("const compileNativeReadiness =");
    const finish = runnerSource.indexOf("\nconst ", begin + 1);
    if (begin < 0 || finish < begin)
      throw new Error("synthetic-readiness-source-boundary");
    const compile = runInNewContext(
      `${runnerSource.slice(begin, finish)}; compileNativeReadiness;`,
    ) as (scenario: unknown, challenge: string) => unknown;
    const scenario = {
      scenarioId: "claude-interactive-trace-smoke",
      harnessEvidenceId: "claude-code-2-1-245",
      nativeReadiness: { kind: "challenge-marker" },
    };
    expect(compile(scenario, "a".repeat(64))).toEqual({
      kind: "challenge-marker",
      challenge: "a".repeat(64),
    });
    for (const foreign of [
      { ...scenario, scenarioId: "claude-foreign-trace-smoke" },
      { ...scenario, harnessEvidenceId: "claude-code-2-1-244" },
      {
        ...scenario,
        nativeReadiness: { kind: "challenge-marker", extra: true },
      },
    ])
      expect(() => compile(foreign, "a".repeat(64))).toThrow();
    expect(() => compile(scenario, "a".repeat(63))).toThrow();
  });
});

describe("Claude selected material and completion ordering", () => {
  it("binds the normal Langfuse scenario to signed and npm-member material without support admission", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../capability-manifest.json", import.meta.url),
        "utf8",
      ),
    ) as CapabilityManifest;
    const scenario = manifest.scenarios.find(
      (row: { scenarioId: string }) =>
        row.scenarioId === "claude-interactive-trace-smoke",
    )!;
    const evidence = manifest.evidence.find(
      (row: { evidenceId: string }) =>
        row.evidenceId === scenario.harnessEvidenceId,
    )!;
    expect(evidence.representativeVersion).toBe("2.1.245");
    expect(evidence.material.kind).toBe("signed-release-manifest");
    if (
      evidence.material.kind !== "signed-release-manifest" ||
      evidence.material.platformPackage === undefined
    )
      throw new Error("synthetic-signed-material");
    expect(evidence.material.platformPackage.memberBytes).toBe(
      evidence.material.binary.bytes,
    );
    expect(evidence.material.platformPackage.memberSha256).toBe(
      evidence.material.binary.sha256,
    );
    // Component catalog linkage is not an actual successful runtime observation.
    expect(evidence.admission).toMatchObject({
      evidenceSlot: "claude-code-2-1-245-component",
      distributionReference: "signed-manifest:claude-code@2.1.245#linux-x64",
      eligibleRange: {
        minimumInclusive: "2.1.245",
        maximumExclusive: "2.1.246",
      },
      component: {
        fixture: {
          path: "packages/harnesses/claude-code/fixtures/native/claude-code-lifecycle-v1.json",
        },
      },
    });
    expect(scenario.destinations).toEqual(["langfuse"]);
    expect(scenario.modelRoutes).toEqual(["anthropic-messages"]);
    expect(
      scenario.runtimeArtifacts.map(
        (row: { destination: string }) => row.destination,
      ),
    ).toEqual([
      "codex-candidate-dropper.mjs",
      "claude-code-lifecycle.mjs",
      "collector-ca.mjs",
    ]);
    const input = Buffer.from(scenario.terminalInputBase64, "base64");
    expect(input.byteLength).toBeLessThanOrEqual(100);
    expect(input.subarray(-6).toString()).toBe("/exit\r");
    expect(input[input.length - 7]).toBe(13);
    expect(
      compileInteractivePtyActions(
        scenario,
        Buffer.concat([Buffer.from(`${"a".repeat(64)}\n`), input]),
      ).some(({ action }) => action === "wait-for-semantic-completion"),
    ).toBe(true);
  });
  it("submits the fixed prompt separately from CR and exits only after completion", () => {
    const input = Buffer.from("Read the fixed stimulus.\r/exit\r");
    const scenario = {
      executionMode: "interactive",
      harnessEvidenceId: "claude-code-2-1-245",
      nativeReadiness: { kind: "challenge-marker" },
      outputContract: "semantic-pty",
      postCompletionControl: "none",
      postCompletionInputByteLength: 6,
      terminalInputBase64: input.toString("base64"),
      waitForSemanticCompletionBeforeTerminalAction: true,
    };
    const actions = compileInteractivePtyActions(
      scenario,
      Buffer.concat([Buffer.from(`${"a".repeat(64)}\n`), input]),
    );
    expect(actions.map(({ action }) => action)).toEqual([
      "resize",
      "input",
      "checkpoint-process-topology",
      "input",
      "input",
      "wait-for-semantic-completion",
      ...Array<string>(6).fill("input"),
    ]);
    expect(actions[3]).toMatchObject({ action: "input", byteLength: 24 });
    expect(actions[4]).toMatchObject({ action: "input", byteLength: 1 });
    const malformed = Buffer.from("Read the fixed stimulus.\n/exit\r");
    expect(() =>
      compileInteractivePtyActions(
        { ...scenario, terminalInputBase64: malformed.toString("base64") },
        Buffer.concat([Buffer.from(`${"a".repeat(64)}\n`), malformed]),
      ),
    ).toThrow("integration.manifest.interaction");
  });
});

const selectedProcess = {
  argv: [
    "node",
    "scenario-process.mjs",
    "--artifact",
    "/candidate/agentscope-cli.tgz",
  ],
  env: {
    AGENTSCOPE_SCENARIO_BOOT_DEADLINE_MS: "2000",
    AGENTSCOPE_SCENARIO_ID: "claude-interactive-trace-smoke",
    AGENTSCOPE_INTEGRATION_RUN_ID: "a".repeat(16),
    AGENTSCOPE_MODEL_SERVER_URL: "http://mockserver:1080",
    AGENTSCOPE_WORKTREE: "/worktree",
    HARNESS_HOME: "/harness-home",
    AGENTSCOPE_LEDGER: "/ledger",
  },
};

// Real orchestration source with fake boundary results: this proves ordering,
// not a vendor turn, credentials, provider compatibility or actual OTLP.
const nativeObserver =
  (record: (event: string) => void, pendingReads: number, expire: () => void) =>
  (_stimulus: unknown, pending = false) => {
    if (pending) {
      record("native-final-readiness");
      expire();
      if (pendingReads-- > 0) return undefined;
    } else record("held-native");
    return {
      nativeSessionId: "01234567-89ab-cdef-0123-456789abcdef",
      nativeToolUseId: "toolu_agentscope_claude_read_1",
    };
  };
const fixture = (
  failure?: string,
  pendingReads = 0,
  deferred = false,
  expired?: "before" | "during",
) => {
  const events: string[] = [];
  const writes: Array<{ path: string; text: string; options: unknown }> = [];
  let joined!: () => void;
  let finalResponse!: () => void;
  let clock = 1000;
  const record = (event: string) => {
    events.push(event);
    if (failure === event) throw new Error(`synthetic-${event}`);
  };
  const context = {
    Buffer,
    process: selectedProcess,
    monotonicNow: () => clock,
    readClaudeCodeReadinessChallenge: () => Promise.resolve("b".repeat(64)),
    prepareClaudeCodePackedCli: () => {
      record("installed-settings");
      return Promise.resolve({
        commands: [],
        settings: Buffer.from("held-settings"),
      });
    },
    prepareClaudeCodeReadStimulus: () => {
      record("stimulus");
    },
    claudeCodeReadExpectations: () => [],
    cliEnvironment: Object.freeze({}),
    openMockServerControl: () => ({
      configure: () => {
        record("configure");
        return Promise.resolve({ status: 201 });
      },
      requests: () =>
        Promise.resolve({
          status: 200,
          bytes: Buffer.from("actual-pair"),
        }),
      snapshot: () => ({ entries: [] }),
    }),
    execute: () => {
      record("candidate-denials");
      return Promise.resolve({
        stdout: JSON.stringify({ runId: "a".repeat(16), entries: [] }),
      });
    },
    snapshotMockServerTraffic: (value: unknown) => value,
    publishClaudeMarker: (marker: string) => {
      if (marker.includes("AGENTSCOPE_PTY_READY:")) record("ready");
      else {
        record("terminal-marker");
        joined();
      }
      return Promise.resolve();
    },
    runClaudeCodeInteractiveTurn: (endpoint: string) => {
      assertActualClaudeEndpoint(endpoint, record);
      return new Promise<void>((resolve) => {
        joined = () => {
          record("vendor-joined");
          resolve();
        };
      });
    },
    claudeCodeReadStimulus: Object.freeze({
      path: "/worktree/fixed",
      prompt: "fixed",
    }),
    inspectClaudeCodeModelRequests: () => {
      record("matched-request-pair");
      if (expired === "before") clock = 2000;
      return { modelRequestBodySha256: ["c".repeat(64), "d".repeat(64)] };
    },
    projectMockServerRequests: () => [],
    setTimeout: (callback: () => void) => {
      if (deferred) finalResponse = callback;
      else callback();
    },
    observeClaudeCodeNativeTurn: nativeObserver(record, pendingReads, () => {
      if (expired === "during") clock = 2000;
    }),
    retireClaudeCodePackedCli: () => {
      record("verified-retirement");
      return Promise.resolve();
    },
    correlateClaudeModelControl: () => [],
    basename: () => "agentscope-cli.tgz",
    claudeModelLedger: () => ({
      ledgerVersion: 1,
      scenarioId: "claude-interactive-trace-smoke",
      entries: Array.from({ length: 2 }, () => ({
        routeId: "anthropic-messages",
        provider: "anthropic",
        method: "POST",
        path: "/v1/messages",
        bodyBytes: 20,
      })),
    }),
    readFileSync: () => "{}",
    writeFileSync: (path: string, text: string, options: unknown) => {
      record("partial-result");
      writes.push({ path, text, options });
    },
  };
  return {
    events,
    writes,
    deliverFinalResponse: () => {
      finalResponse();
    },
    execute: runInNewContext(
      `${main}\nrunClaudeCodeScenario`,
      context,
    ) as () => Promise<void>,
  };
};

describe("Claude selected scenario native-only orchestration", () => {
  it("matches actual request pair before terminal marker and joins before held native read", async () => {
    const input = fixture();
    await input.execute();
    expect(input.events).toEqual([
      "installed-settings",
      "stimulus",
      "configure",
      "candidate-denials",
      "ready",
      "vendor-start",
      "matched-request-pair",
      "native-final-readiness",
      "terminal-marker",
      "vendor-joined",
      "held-native",
      "verified-retirement",
      "partial-result",
    ]);
    expect(input.writes).toHaveLength(1);
    expect(input.writes[0]!.path).toBe("/ledger/fixture-result.json");
    expect(input.writes[0]!.options).toEqual({ flag: "wx", mode: 0o600 });
    const envelope = JSON.parse(input.writes[0]!.text) as {
      encodedEvidence: string;
    };
    const result = JSON.parse(
      Buffer.from(envelope.encodedEvidence, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(result.resultStatus).toBe("partial");
    expect(result.destinationLedger).toEqual({
      ledgerVersion: 1,
      scenarioId: "claude-interactive-trace-smoke",
      ingestion: [],
      retrieval: [],
    });
    expect(result.harnessObservation).toMatchObject({
      kind: "claude-code-native",
      modelRequestBodySha256: ["c".repeat(64), "d".repeat(64)],
    });
    expect(result.harnessObservation).not.toHaveProperty("hookObservations");
    expect(result.harnessObservation).not.toHaveProperty("canonicalGraph");
    const { mockServerTraffic, ...retained } = result;
    expect(mockServerTraffic).toEqual({ runId: "a".repeat(16), entries: [] });
    expect(
      sanitizeFixtureResult(retained, "claude-interactive-trace-smoke"),
    ).toEqual(retained);
  });
  it("does not release terminal input while the second response/native final record is deferred", async () => {
    const input = fixture(undefined, 1, true);
    const running = input.execute();
    await vi.waitFor(() => {
      expect(input.events).toContain("native-final-readiness");
    });
    expect(input.events).toContain("matched-request-pair");
    expect(input.events).not.toContain("terminal-marker");
    expect(input.writes).toEqual([]);
    input.deliverFinalResponse();
    await running;
    expect(
      input.events.filter((event) => event === "native-final-readiness"),
    ).toHaveLength(2);
    expect(input.events.indexOf("terminal-marker")).toBeGreaterThan(
      input.events.lastIndexOf("native-final-readiness"),
    );
    expect(input.events.indexOf("held-native")).toBeGreaterThan(
      input.events.indexOf("vendor-joined"),
    );
  });
  it("pending exhaustion refuses without terminal input or partial evidence", async () => {
    const input = fixture(undefined, Infinity);
    await expect(input.execute()).rejects.toThrow(
      "integration.claude-code.native-final-turn",
    );
    expect(input.events).not.toContain("terminal-marker");
    expect(input.writes).toEqual([]);
  });
  it.each(["before", "during"] as const)(
    "completed native observation expired %s the read cannot release terminal control",
    async (expired) => {
      const input = fixture(undefined, 0, false, expired);
      await expect(input.execute()).rejects.toThrow(
        "integration.claude-code.native-final-turn",
      );
      expect(input.events).not.toContain("terminal-marker");
      expect(input.writes).toEqual([]);
    },
  );
  it.each([
    "configure",
    "candidate-denials",
    "matched-request-pair",
    "native-final-readiness",
  ])(
    "%s failure cannot release terminal control or export a result",
    async (phase) => {
      const input = fixture(phase);
      await expect(input.execute()).rejects.toThrow(`synthetic-${phase}`);
      expect(input.events).not.toContain("terminal-marker");
      expect(input.writes).toEqual([]);
    },
  );
  it.each(["held-native", "verified-retirement"])(
    "%s failure cannot export partial evidence despite a released terminal marker",
    async (phase) => {
      const input = fixture(phase);
      await expect(input.execute()).rejects.toThrow(`synthetic-${phase}`);
      expect(input.events).toContain("vendor-joined");
      expect(input.writes).toEqual([]);
    },
  );
});
