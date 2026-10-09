import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { sanitizeFixtureResult } from "./operations.js";
import { compileInteractivePtyActions } from "./interactive-pty-actions.js";
import type { CapabilityManifest } from "./manifest.js";

const source = readFileSync(
  new URL("../claude-code-scenario.mjs", import.meta.url),
  "utf8",
);
const start = source.indexOf("const waitForClaudeModelPair =");
const end = source.indexOf("\nif (", start);
if (start < 0 || end < 0) throw new Error("synthetic-main-source-boundary");
const main = source.slice(start, end).replace("export const", "const");

const lifecycleSource = readFileSync(
  new URL("../claude-code-lifecycle.mjs", import.meta.url),
  "utf8",
);
const snapshotSource = lifecycleSource
  .slice(
    lifecycleSource.indexOf("export const readClaudeCodeInstalledSettings ="),
  )
  .replace("export const", "const");
const installedSettingsFixture = () => {
  const events = ["SessionStart", "PreToolUse", "PostToolUse", "Stop"];
  const value = {
    hooks: Object.fromEntries(
      events.map((event) => [
        event,
        [
          {
            agentscope: {
              contractVersion: 1,
              event,
              harnessType: "@agentscope/harness-claude-code",
              ownershipIdentity: `agentscope-hook-v1-sha256-${"a".repeat(64)}`,
            },
            hooks: [
              {
                type: "command",
                command: "/opt/agentscope/bin/owned-hook",
                args: [],
                timeout: 4,
              },
            ],
          },
        ],
      ]),
    ),
  };
  const bytes = () => Buffer.from(JSON.stringify(value));
  const closed: number[] = [];
  const status = () => ({
    isFile: () => true,
    uid: 1000,
    nlink: 1,
    mode: 0o100600,
    size: bytes().length,
    dev: 1,
    ino: 2,
    mtimeMs: 3,
    ctimeMs: 4,
  });
  const read = runInNewContext(
    `${snapshotSource}; readClaudeCodeInstalledSettings;`,
    {
      Buffer,
      TextDecoder,
      constants: { O_RDONLY: 1, O_NOFOLLOW: 2, O_NONBLOCK: 4 },
      openSync: (path: string, flags: number) => {
        expect(path).toBe("/harness-home/settings.json");
        expect(flags).toBe(7);
        return 41;
      },
      fstatSync: status,
      lstatSync: status,
      readSync: (
        _fd: number,
        output: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => bytes().copy(output, offset, position, position + length),
      closeSync: (fd: number) => {
        closed.push(fd);
      },
    },
  ) as () => Buffer;
  return { value, bytes, closed, read };
};

describe("Claude installed launcher snapshot", () => {
  it("holds the exact four CLI-owned metadata/command bytes and closes the descriptor", () => {
    const fixture = installedSettingsFixture();
    expect(fixture.read()).toEqual(fixture.bytes());
    expect(fixture.closed).toEqual([41]);
  });
  it("refuses event, ownership, contract and command substitutions without exporting settings", () => {
    for (const mutate of [
      (value: ReturnType<typeof installedSettingsFixture>["value"]) => {
        value.hooks.Stop![0]!.agentscope.event = "SessionEnd";
      },
      (value: ReturnType<typeof installedSettingsFixture>["value"]) => {
        value.hooks.Stop![0]!.agentscope.ownershipIdentity = `agentscope-hook-v1-sha256-${"b".repeat(64)}`;
      },
      (value: ReturnType<typeof installedSettingsFixture>["value"]) => {
        value.hooks.Stop![0]!.agentscope.contractVersion = 2;
      },
      (value: ReturnType<typeof installedSettingsFixture>["value"]) => {
        value.hooks.Stop![0]!.hooks[0]!.command = "/replacement";
      },
    ]) {
      const fixture = installedSettingsFixture();
      mutate(fixture.value);
      expect(() => fixture.read()).toThrow("integration.claude-code.settings");
      expect(fixture.closed).toEqual([41]);
    }
  });
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
    expect(evidence.admission).toBeUndefined();
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
const fixture = (failure?: string) => {
  const events: string[] = [];
  const writes: Array<{ path: string; text: string; options: unknown }> = [];
  let joined!: () => void;
  const record = (event: string) => {
    events.push(event);
    if (failure === event) throw new Error(`synthetic-${event}`);
  };
  const context = {
    Buffer,
    process: selectedProcess,
    monotonicNow: () => 1000,
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
    runClaudeCodeInteractiveTurn: () => {
      record("vendor-start");
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
      return { modelRequestBodySha256: ["c".repeat(64), "d".repeat(64)] };
    },
    projectMockServerRequests: () => [],
    setTimeout: (callback: () => void) => {
      callback();
    },
    observeClaudeCodeNativeTurn: () => {
      record("held-native");
      return {
        nativeSessionId: "01234567-89ab-cdef-0123-456789abcdef",
        nativeToolUseId: "toolu_agentscope_claude_read_1",
      };
    },
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
  it.each(["configure", "candidate-denials", "matched-request-pair"])(
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
