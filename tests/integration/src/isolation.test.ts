import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { CandidateEvidence } from "./artifacts.js";
import {
  compileIsolationEvidence,
  compileIsolationExecutionPolicy,
  createIsolationPlan,
  executeIsolationPlan,
  ISOLATION_EXECUTOR_LIMITS,
  scenarioContainerTerminalWitness,
  type IsolationDriver,
} from "./isolation.js";
import { compileCapabilityManifest } from "./manifest.js";

const integrationRoot = resolve(import.meta.dirname, "..");
const manifest = compileCapabilityManifest(
  JSON.parse(
    readFileSync(resolve(integrationRoot, "capability-manifest.json"), "utf8"),
  ),
);
const candidate = {
  evidenceVersion: 1,
  bundleIdentity: `sha256-${"1".repeat(64)}`,
  candidateRevision: "2".repeat(40),
  platform: { os: "linux", architecture: "arm64", nodeVersion: "22.0.0" },
  lockfile: {
    fileName: "pnpm-lock.yaml",
    bytes: 1,
    sha256: `sha256-${"3".repeat(64)}`,
  },
  artifacts: [
    {
      id: "agentscope-cli",
      kind: "npm-tarball",
      fileName: "agentscope-cli.tgz",
      bytes: 1,
      sha256: `sha256-${"4".repeat(64)}`,
    },
  ],
  scenarioNetworkPolicy: "offline-no-package-or-registry-download",
} satisfies CandidateEvidence;

const preparedIdentityFor = (image: string, fill: string) => ({
  image,
  platform: { os: "linux", architecture: "amd64" },
  manifestDigest: `sha256:${fill.repeat(64)}`,
  configDigest: `sha256:${fill.toUpperCase().repeat(64)}`.toLowerCase(),
});

const planFor = (
  token: string,
  executionMode: "headless" | "interactive" = "headless",
) => {
  const scenario = manifest.scenarios.find(
    (candidate) =>
      candidate.executionMode === executionMode &&
      candidate.harnessEvidenceId === "fixture-process-v1",
  )!;
  return createIsolationPlan({
    scenario,
    manifestIdentity: manifest.manifestIdentity,
    candidate,
    runToken: token,
    baseImageIdentity: preparedIdentityFor(scenario.image, "a"),
    mockServerImageIdentity: preparedIdentityFor(scenario.mockServerImage, "b"),
    selection: {
      selectionVersion: 2,
      manifestIdentity: manifest.manifestIdentity,
      mode: "scenario",
      selector: { scenarioId: scenario.scenarioId },
      scenarioIds: [scenario.scenarioId],
    },
    maximumParallelScenarios: 2,
    scenarioTimeoutMilliseconds: 300_000,
  });
};

const executionPolicyFor = (scenarioId = "fixture-process-smoke") => ({
  policyVersion: 1,
  runtimeInspection: {
    outcome: "complete",
    identity: {
      executor: "docker",
      clientVersion: "29.0.0",
      engine: {
        kind: "docker-engine",
        product: "Docker Engine - Community",
        version: "29.0.0",
        apiVersion: "1.52",
        operatingSystem: "Ubuntu 24.04 LTS",
        osType: "linux",
        architecture: "x86_64",
      },
      containerRuntime: { name: "runc", version: "1.3.0" },
      containerdVersion: "2.2.0",
    },
  },
  selection: {
    selectionVersion: 2,
    manifestIdentity: manifest.manifestIdentity,
    mode: "scenario",
    selector: { scenarioId },
    scenarioIds: [scenarioId],
  },
  maximumParallelScenarios: 2,
  scenarioTimeoutMilliseconds: 300_000,
  cleanupTimeouts: ISOLATION_EXECUTOR_LIMITS.cleanup,
  containers: ISOLATION_EXECUTOR_LIMITS.containers,
  requests: ISOLATION_EXECUTOR_LIMITS.requests,
});

const terminalContainer = (overrides: Record<string, unknown> = {}) => ({
  Id: "a".repeat(64),
  Name: "/agentscope-int-scenario",
  RestartCount: 0,
  Config: {
    Labels: {
      "com.agentscope.integration": "true",
      "com.agentscope.integration.run": "0123456789abcdef",
    },
  },
  State: {
    Status: "exited",
    Running: false,
    Paused: false,
    Restarting: false,
    OOMKilled: false,
    Dead: false,
    Pid: 0,
    ExitCode: 7,
    Error: "",
    FinishedAt: "2026-09-15T01:00:00.000000000Z",
  },
  ...overrides,
});

describe("scenario attach terminal witness", () => {
  const witness = (overrides: Record<string, unknown> = {}) =>
    scenarioContainerTerminalWitness({
      attach: { code: 7, killed: false, name: "Error", signal: null },
      container: terminalContainer(),
      containerId: "a".repeat(64),
      runId: "0123456789abcdef",
      scenarioName: "agentscope-int-scenario",
      waitOutput: "7\n",
      ...overrides,
    });

  it("accepts an exact same-container wait and terminal state", () => {
    expect(witness()).toBe(true);
  });

  it("rejects transport-only exit metadata without the daemon witness", () => {
    expect(witness({ container: undefined })).toBe(false);
    expect(witness({ waitOutput: "" })).toBe(false);
    expect(witness({ attach: { code: 7, killed: true, signal: null } })).toBe(
      false,
    );
    expect(witness({ attach: { code: 7, signal: null } })).toBe(false);
    expect(witness({ attach: { code: 7, killed: false, signal: null } })).toBe(
      false,
    );
    expect(
      witness({
        attach: { code: 7, killed: "false", name: "Error", signal: null },
      }),
    ).toBe(false);
    expect(
      witness({
        attach: {
          code: 7,
          killed: false,
          name: "UnexpectedError",
          signal: null,
        },
      }),
    ).toBe(false);
    expect(
      witness({
        attach: { code: 7, killed: false, name: "Error", signal: "SIGTERM" },
      }),
    ).toBe(false);
  });

  it("rejects substituted, live, restarted, and mismatched containers", () => {
    expect(witness({ containerId: "b".repeat(64) })).toBe(false);
    expect(witness({ container: terminalContainer({ RestartCount: 1 }) })).toBe(
      false,
    );
    expect(
      witness({
        container: terminalContainer({
          State: { ...terminalContainer().State, Running: true },
        }),
      }),
    ).toBe(false);
    expect(
      witness({
        container: terminalContainer({
          State: { ...terminalContainer().State, ExitCode: 8 },
        }),
      }),
    ).toBe(false);
    expect(
      witness({
        container: terminalContainer({
          State: {
            ...terminalContainer().State,
            FinishedAt: "not-a-timestamp",
          },
        }),
      }),
    ).toBe(false);
    expect(
      witness({
        container: terminalContainer({
          State: {
            ...terminalContainer().State,
            FinishedAt: "2026-02-31T01:00:00Z",
          },
        }),
      }),
    ).toBe(false);
  });
});

const emptyCleanupInventory = () => ({
  containers: 0,
  networks: 0,
  images: 0,
  volumes: 0,
  buildContexts: 0,
  activeRunMarkers: 0,
});
const headlessReceiptFor = (runId = "0123456789abcdef") => {
  const request = {
    runId,
    executable: "/usr/local/bin/node",
    arguments: ["/opt/agentscope/platform-fixture.mjs"],
    cwd: "/opt/agentscope",
    environment: { HOME: "/home/agentscope" },
    stdinBase64: "",
    stdoutLimitBytes: 1_048_576,
    stderrLimitBytes: 1_048_576,
    monotonicStartupDeadlineMs: 11_000,
    monotonicExecutionDeadlineMs: 26_000,
    monotonicShutdownDeadlineMs: 31_000,
    terminationGraceMs: 1_000,
  };
  return {
    receiptVersion: 1 as const,
    runId,
    requestFingerprint: `sha256:${createHash("sha256")
      .update(JSON.stringify(request))
      .digest("hex")}` as const,
    outerMonotonicDeadlineMs: 31_000,
    requestConstructedAtMs: 1_000,
    translationBootAtMs: 1_000,
    translationLocalAtMs: 1_000,
    request,
    returnedAtMs: 29_000,
    outcome: "exited" as const,
    exitCode: 0 as const,
    signal: null,
    cleanup: "clean" as const,
    residualProcessCount: 0 as const,
    termRequested: false,
    killRequested: false,
    processJoined: true as const,
    stdinJoined: true as const,
    stdoutJoined: true as const,
    stderrJoined: true as const,
  };
};

// The complete canonical fixture is intentionally adjacent so every authority
// field exercised by the isolation verifier remains visible to substitutions.
const ptyReceiptFor = (
  runId = "0123456789abcdef",
  scenarioId = "fixture-process-interactive",
  // eslint-disable-next-line max-lines-per-function
) => {
  const rawProcessRequest = {
    ...headlessReceiptFor(runId).request,
    executable: "/opt/agentscope/platform-fixture.mjs",
    arguments: ["--artifact", "/opt/agentscope/prepared/cli.tgz"],
    stdinBase64: "cnVuCg==",
  };
  const processRequestFingerprint = `sha256:${createHash("sha256")
    .update(JSON.stringify(rawProcessRequest))
    .digest("hex")}` as const;
  const input = Buffer.from("run\n");
  const inputSha256 = createHash("sha256").update(input).digest("hex");
  const processRequest = {
    runId: rawProcessRequest.runId,
    requestFingerprint: processRequestFingerprint,
    executable: rawProcessRequest.executable,
    arguments: rawProcessRequest.arguments,
    cwd: rawProcessRequest.cwd,
    environment: rawProcessRequest.environment,
    inputBytes: input.length,
    inputSha256,
    stdoutLimitBytes: rawProcessRequest.stdoutLimitBytes,
    stderrLimitBytes: rawProcessRequest.stderrLimitBytes,
    monotonicStartupDeadlineMs: rawProcessRequest.monotonicStartupDeadlineMs,
    monotonicExecutionDeadlineMs:
      rawProcessRequest.monotonicExecutionDeadlineMs,
    monotonicShutdownDeadlineMs: rawProcessRequest.monotonicShutdownDeadlineMs,
    terminationGraceMs: rawProcessRequest.terminationGraceMs,
  };
  const geometry = { columns: 80, rows: 24 };
  const completion = { kind: "semantic-marker" as const };
  const readiness = { kind: "semantic-marker" as const };
  const interaction = {
    actions: [
      { action: "resize" as const, geometry: { columns: 100, rows: 30 } },
      { action: "input" as const, byteLength: 4, inputSha256 },
      { action: "eof" as const },
    ],
    trigger: "semantic-ready" as const,
  };
  const interpreter = {
    path: "/usr/local/bin/node",
    sha256: "a".repeat(64),
  };
  const scriptSha256 = createHash("sha256")
    .update(readFileSync(resolve(integrationRoot, "platform-fixture.mjs")))
    .digest("hex");
  return {
    receiptVersion: 1 as const,
    transport: "pty" as const,
    scenarioId,
    runId,
    requestFingerprint: `sha256:${createHash("sha256")
      .update(
        JSON.stringify({
          processRequestFingerprint,
          completion,
          readiness,
          initialGeometry: geometry,
          interaction,
          interpreter,
          scriptSha256,
          inputBytes: input.length,
          inputSha256,
        }),
      )
      .digest("hex")}` as const,
    processRequestFingerprint,
    processStartIdentity: "42001:1",
    inputBytes: input.length,
    inputSha256,
    readinessObserved: true,
    actions: [
      {
        action: "resize" as const,
        geometry: { columns: 100, rows: 30 },
        monotonicAtMs: 2_000,
      },
      {
        action: "input" as const,
        byteLength: 4,
        inputSha256,
        monotonicAtMs: 2_001,
      },
      { action: "eof" as const, monotonicAtMs: 2_002 },
    ],
    outerMonotonicDeadlineMs: 31_000,
    requestConstructedAtMs: 1_000,
    translationBootAtMs: 1_000,
    translationLocalAtMs: 1_000,
    request: {
      process: processRequest,
      completion,
      readiness,
      initialGeometry: geometry,
      interaction,
      interpreter,
      scriptSha256,
    },
    returnedAtMs: 29_000,
    isTTY: true as const,
    observedGeometry: { columns: 100, rows: 30 },
    observedCanonicalMode: true as const,
    eofByte: 4,
    eofByteWritten: true,
    inputBytesWritten: 4,
    outcome: "completed" as const,
    outputBytes: 32,
    outputSha256: "c".repeat(64),
    finalSnapshot: {
      snapshotVersion: 1 as const,
      geometry: { columns: 100, rows: 30 },
      cursor: { column: 0, row: 1 },
      alternateScreen: false,
      cursorVisible: true,
      outputBytes: 32,
      printableCellCount: 0,
      nonEmptyLineCount: 0,
      malformedControlCount: 0,
      unsupportedControlCount: 0,
      sawCursorPositionQuery: false,
      titlePresent: false,
      titleSha256: null,
      screenSha256: "d".repeat(64),
      semanticState: "completed" as const,
    },
    exitCode: 0,
    signal: null,
    cleanup: "clean" as const,
    residualProcessCount: 0,
    processJoined: true,
    terminalInputJoined: true,
    terminalOutputJoined: true,
    terminalTransportClosed: true,
  };
};

const ptyChallengeReceiptFor = () => {
  const receipt = ptyReceiptFor();
  const challenge = "b".repeat(64);
  const initialInput = Buffer.from(`${challenge}\n`);
  const finalInput = Buffer.from([4]);
  const input = Buffer.concat([initialInput, finalInput]);
  const inputSha256 = createHash("sha256").update(input).digest("hex");
  const process = {
    ...receipt.request.process,
    inputBytes: input.length,
    inputSha256,
    // The Codex fixture must settle its selected-PTY failure receipt before
    // its own outer-minus-five-second terminal cutoff.
    monotonicExecutionDeadlineMs: 6_000,
  };
  const rawProcessRequest = {
    runId: process.runId,
    executable: process.executable,
    arguments: process.arguments,
    cwd: process.cwd,
    environment: process.environment,
    stdinBase64: input.toString("base64"),
    stdoutLimitBytes: process.stdoutLimitBytes,
    stderrLimitBytes: process.stderrLimitBytes,
    monotonicStartupDeadlineMs: process.monotonicStartupDeadlineMs,
    monotonicExecutionDeadlineMs: process.monotonicExecutionDeadlineMs,
    monotonicShutdownDeadlineMs: process.monotonicShutdownDeadlineMs,
    terminationGraceMs: process.terminationGraceMs,
  };
  const processRequestFingerprint = `sha256:${createHash("sha256")
    .update(JSON.stringify(rawProcessRequest))
    .digest("hex")}` as const;
  const readiness = {
    kind: "challenge-styled-text" as const,
    challenge,
    text: "›",
    requiredText: "Ask Codex to do anything",
    requiredTerminalProtocol: "csi-u-flags-7-query-v1" as const,
    bold: true,
    dim: false,
  };
  const initialInputAction = {
    action: "input" as const,
    byteLength: initialInput.length,
    inputSha256: createHash("sha256").update(initialInput).digest("hex"),
  };
  const finalInputAction = {
    action: "input" as const,
    byteLength: finalInput.length,
    inputSha256: createHash("sha256").update(finalInput).digest("hex"),
  };
  const interaction = {
    trigger: "immediate" as const,
    actions: [
      receipt.request.interaction.actions[0]!,
      initialInputAction,
      {
        action: "checkpoint-process-topology" as const,
        topology: "root-with-contained-process-set" as const,
      },
      { action: "wait-for-semantic-completion" as const },
      finalInputAction,
    ],
  };
  const request = {
    ...receipt.request,
    process: { ...process, requestFingerprint: processRequestFingerprint },
    readiness,
    interaction,
  };
  const requestFingerprint = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        processRequestFingerprint,
        completion: request.completion,
        readiness,
        initialGeometry: request.initialGeometry,
        interaction: {
          actions: interaction.actions,
          trigger: interaction.trigger,
        },
        interpreter: request.interpreter,
        scriptSha256: request.scriptSha256,
        inputBytes: input.length,
        inputSha256,
      }),
    )
    .digest("hex")}` as const;
  return {
    ...receipt,
    scenarioId: "codex-tui-trace-smoke",
    request,
    requestFingerprint,
    processRequestFingerprint,
    inputBytes: input.length,
    inputSha256,
    actions: interaction.actions.map((action, index) => ({
      ...action,
      monotonicAtMs: 2_000 + index,
    })),
    eofByteWritten: false,
    inputBytesWritten: input.length,
    observedCanonicalMode: false,
  };
};

const refingerprintPtyEnvelope = (
  receipt: ReturnType<typeof ptyChallengeReceiptFor>,
  readiness: typeof receipt.request.readiness | { kind: "semantic-marker" },
  trigger: "immediate" | "semantic-ready",
) => {
  const interaction = { ...receipt.request.interaction, trigger };
  const request = { ...receipt.request, readiness, interaction };
  const requestFingerprint = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        processRequestFingerprint: receipt.processRequestFingerprint,
        completion: request.completion,
        readiness,
        initialGeometry: request.initialGeometry,
        interaction: {
          actions: interaction.actions,
          trigger: interaction.trigger,
        },
        interpreter: request.interpreter,
        scriptSha256: request.scriptSha256,
        inputBytes: receipt.inputBytes,
        inputSha256: receipt.inputSha256,
      }),
    )
    .digest("hex")}` as const;
  return { ...receipt, request, requestFingerprint };
};

const ptyControlReceiptFor = () => {
  const receipt = ptyReceiptFor();
  const interaction = {
    ...receipt.request.interaction,
    actions: [
      ...receipt.request.interaction.actions.slice(0, 2),
      { action: "wait-for-semantic-completion" as const },
      { action: "interrupt-byte" as const, byte: 3 as const },
    ],
  };
  const request = { ...receipt.request, interaction };
  const requestFingerprint = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        processRequestFingerprint: receipt.processRequestFingerprint,
        completion: request.completion,
        readiness: request.readiness,
        initialGeometry: request.initialGeometry,
        interaction,
        interpreter: request.interpreter,
        scriptSha256: request.scriptSha256,
        inputBytes: receipt.inputBytes,
        inputSha256: receipt.inputSha256,
      }),
    )
    .digest("hex")}` as const;
  return {
    ...receipt,
    request,
    requestFingerprint,
    eofByteWritten: false,
    actions: [
      ...receipt.actions.slice(0, 2),
      { action: "wait-for-semantic-completion" as const, monotonicAtMs: 2_002 },
      {
        action: "interrupt-byte" as const,
        byte: 3 as const,
        monotonicAtMs: 2_003,
      },
    ],
  };
};

const ptyPostInputReceiptFor = () => {
  const receipt = ptyReceiptFor();
  const input = Buffer.from("run\n");
  const firstInput = {
    action: "input" as const,
    byteLength: 3,
    inputSha256: createHash("sha256")
      .update(input.subarray(0, 3))
      .digest("hex"),
  };
  const finalInput = {
    action: "input" as const,
    byteLength: 1,
    inputSha256: createHash("sha256").update(input.subarray(3)).digest("hex"),
  };
  const interaction = {
    ...receipt.request.interaction,
    actions: [
      receipt.request.interaction.actions[0]!,
      firstInput,
      { action: "wait-for-semantic-completion" as const },
      finalInput,
    ],
  };
  const request = { ...receipt.request, interaction };
  const requestFingerprint = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        processRequestFingerprint: receipt.processRequestFingerprint,
        completion: request.completion,
        readiness: request.readiness,
        initialGeometry: request.initialGeometry,
        interaction,
        interpreter: request.interpreter,
        scriptSha256: request.scriptSha256,
        inputBytes: receipt.inputBytes,
        inputSha256: receipt.inputSha256,
      }),
    )
    .digest("hex")}` as const;
  return {
    ...receipt,
    request,
    requestFingerprint,
    actions: [
      receipt.actions[0]!,
      { ...firstInput, monotonicAtMs: 2_001 },
      { action: "wait-for-semantic-completion" as const, monotonicAtMs: 2_002 },
      { ...finalInput, monotonicAtMs: 2_003 },
    ],
    eofByteWritten: false,
    observedCanonicalMode: false,
  };
};

const refingerprintPtyProcessDeadline = (
  field:
    | "monotonicStartupDeadlineMs"
    | "monotonicExecutionDeadlineMs"
    | "monotonicShutdownDeadlineMs"
    | "terminationGraceMs",
  value: number,
  receipt:
    | ReturnType<typeof ptyReceiptFor>
    | ReturnType<typeof ptyChallengeReceiptFor> = ptyReceiptFor(),
) => {
  const process = { ...receipt.request.process, [field]: value };
  const rawProcessRequest = {
    runId: process.runId,
    executable: process.executable,
    arguments: process.arguments,
    cwd: process.cwd,
    environment: process.environment,
    stdinBase64:
      receipt.scenarioId === "codex-tui-trace-smoke"
        ? Buffer.concat([
            Buffer.from(`${"b".repeat(64)}\n`),
            Buffer.from([4]),
          ]).toString("base64")
        : "cnVuCg==",
    stdoutLimitBytes: process.stdoutLimitBytes,
    stderrLimitBytes: process.stderrLimitBytes,
    monotonicStartupDeadlineMs: process.monotonicStartupDeadlineMs,
    monotonicExecutionDeadlineMs: process.monotonicExecutionDeadlineMs,
    monotonicShutdownDeadlineMs: process.monotonicShutdownDeadlineMs,
    terminationGraceMs: process.terminationGraceMs,
  };
  const processRequestFingerprint = `sha256:${createHash("sha256")
    .update(JSON.stringify(rawProcessRequest))
    .digest("hex")}` as const;
  const request = {
    ...receipt.request,
    process: { ...process, requestFingerprint: processRequestFingerprint },
  };
  const requestFingerprint = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        processRequestFingerprint,
        completion: request.completion,
        readiness: request.readiness,
        initialGeometry: request.initialGeometry,
        interaction: request.interaction,
        interpreter: request.interpreter,
        scriptSha256: request.scriptSha256,
        inputBytes: process.inputBytes,
        inputSha256: process.inputSha256,
      }),
    )
    .digest("hex")}` as const;
  return { ...receipt, processRequestFingerprint, requestFingerprint, request };
};

const driver = () => {
  const calls: string[] = [];
  const buildImage = vi.fn<IsolationDriver["buildImage"]>(() => {
    calls.push("build");
    return Promise.resolve(`sha256-${"5".repeat(64)}`);
  });
  const runScenario = vi.fn<IsolationDriver["runScenario"]>((plan) => {
    calls.push("scenario");
    return Promise.resolve({
      receipt:
        plan.executionMode === "interactive"
          ? ptyReceiptFor(plan.runId, plan.scenarioId)
          : headlessReceiptFor(plan.runId),
      succeeded: true,
    });
  });
  const removeContainer = vi.fn<IsolationDriver["removeContainer"]>((name) => {
    calls.push(`container:${name}`);
    return Promise.resolve();
  });
  const inspectExecutionPolicy = vi.fn<
    IsolationDriver["inspectExecutionPolicy"]
  >((plan) => Promise.resolve(executionPolicyFor(plan.scenarioId)));
  const recordEvidence = vi.fn<IsolationDriver["recordEvidence"]>(() => {
    calls.push("evidence");
    return Promise.resolve();
  });
  const inspectCleanup = vi.fn<IsolationDriver["inspectCleanup"]>(() =>
    Promise.resolve(emptyCleanupInventory()),
  );
  const implementation: IsolationDriver = {
    inspectExecutionPolicy,
    buildImage,
    buildMockServerImage: vi.fn(() => {
      calls.push("build-mockserver");
      return Promise.resolve(`sha256-${"6".repeat(64)}`);
    }),
    createNetwork: vi.fn(() => {
      calls.push("network");
      return Promise.resolve();
    }),
    startCollector: vi.fn(() => {
      calls.push("collector");
      return Promise.resolve();
    }),
    startRetrieval: vi.fn(() => {
      calls.push("retrieval");
      return Promise.resolve();
    }),
    startMockServer: vi.fn(() => {
      calls.push("mockserver");
      return Promise.resolve();
    }),
    joinMockServer: vi.fn(() => {
      calls.push("mockserver-join");
      return Promise.resolve();
    }),
    runScenario,
    recordEvidence,
    removeContainer,
    removeNetwork: vi.fn((name) => {
      calls.push(`remove-network:${name}`);
      return Promise.resolve();
    }),
    removeImage: vi.fn((name) => {
      calls.push(`image:${name}`);
      return Promise.resolve();
    }),
    removeContext: vi.fn((runId) => {
      calls.push(`context:${runId}`);
      return Promise.resolve();
    }),
    inspectCleanup,
  };
  return {
    buildImage,
    calls,
    implementation,
    inspectCleanup,
    inspectExecutionPolicy,
    recordEvidence,
    removeContainer,
    runScenario,
  };
};

describe("scenario isolation", () => {
  it("creates disjoint immutable plans with no host mounts", () => {
    const first = planFor("0123456789abcdef");
    const second = planFor("fedcba9876543210");
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.networkName).not.toBe(second.networkName);
    expect(first.collectorName).not.toBe(second.collectorName);
    expect(first.retrievalName).not.toBe(second.retrievalName);
    expect(first.mockServerName).not.toBe(second.mockServerName);
    expect(first.scenarioName).not.toBe(second.scenarioName);
    expect(first.tmpfsMounts).toEqual([
      "/home/agentscope",
      "/harness-home",
      "/agentscope-home",
      "/worktree",
      "/ledger",
      "/tmp",
    ]);
    expect(() => planFor("not-a-token")).toThrow("integration.isolation.plan");
  });

  it("records digest-bound evidence and always tears down after success", async () => {
    const fixture = driver();
    const evidence = await executeIsolationPlan(
      planFor("0123456789abcdef"),
      fixture.implementation,
      new AbortController().signal,
    );
    expect(evidence.outcome).toBe("passed");
    expect(evidence.evidenceVersion).toBe(2);
    expect(evidence.hostMountCount).toBe(0);
    expect(evidence.readOnlyRootFilesystem).toBe(true);
    expect(evidence.builtImageDigest).toBe(`sha256-${"5".repeat(64)}`);
    expect(evidence.builtMockServerImageDigest).toBe(
      `sha256-${"6".repeat(64)}`,
    );
    expect(evidence.executionPolicy).toEqual(executionPolicyFor());
    expect(evidence.cleanup).toEqual({
      outcome: "complete",
      removalFailureCount: 0,
      remaining: emptyCleanupInventory(),
    });
    expect(evidence.headlessTerminalReceipt).toEqual(headlessReceiptFor());
    expect(evidence.ptyTerminalReceipt).toBeNull();
    expect(fixture.calls).toEqual([
      "build",
      "build-mockserver",
      "network",
      "collector",
      "retrieval",
      "mockserver",
      "scenario",
      "mockserver-join",
      "container:agentscope-int-0123456789abcdef-scenario",
      "container:agentscope-int-0123456789abcdef-collector",
      "container:agentscope-int-0123456789abcdef-retrieval",
      "container:agentscope-int-0123456789abcdef-mockserver",
      "remove-network:agentscope-int-0123456789abcdef-network",
      "image:agentscope-int-0123456789abcdef:candidate",
      "image:agentscope-int-0123456789abcdef:mockserver",
      "context:0123456789abcdef",
      "evidence",
    ]);
  });

  it("records only bounded semantic PTY evidence for an interactive row", async () => {
    const fixture = driver();
    const plan = planFor("0123456789abcdef", "interactive");
    const evidence = await executeIsolationPlan(
      plan,
      fixture.implementation,
      new AbortController().signal,
    );
    expect(evidence.executionMode).toBe("interactive");
    expect(evidence.headlessTerminalReceipt).toBeNull();
    expect(evidence.ptyTerminalReceipt).toEqual(
      ptyReceiptFor(plan.runId, plan.scenarioId),
    );
    expect(JSON.stringify(evidence)).not.toContain("AGENTSCOPE_PTY_COMPLETE");
    expect(JSON.stringify(evidence)).not.toContain("cnVuCg==");
  });
});

describe("scenario isolation outcomes", () => {
  it("tears down and records failure and interruption outcomes", async () => {
    const failed = driver();
    failed.runScenario.mockRejectedValueOnce(new Error("scenario failed"));
    await expect(
      executeIsolationPlan(
        planFor("0123456789abcdef"),
        failed.implementation,
        new AbortController().signal,
      ),
    ).rejects.toThrow("scenario failed");
    expect(failed.calls).toContain("evidence");
    const observedFailure = driver();
    const timeoutReceipt = {
      ...headlessReceiptFor(),
      outcome: "timed-out" as const,
      exitCode: null,
      signal: "SIGKILL" as const,
    };
    observedFailure.runScenario.mockResolvedValueOnce({
      receipt: timeoutReceipt,
      succeeded: false,
    });
    await expect(
      executeIsolationPlan(
        planFor("0123456789abcdef"),
        observedFailure.implementation,
        new AbortController().signal,
      ),
    ).rejects.toThrow("integration.isolation.scenario-failed");
    expect(
      observedFailure.recordEvidence.mock.calls[0]?.[0].headlessTerminalReceipt,
    ).toEqual(timeoutReceipt);
    const interrupted = driver();
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeIsolationPlan(
        planFor("fedcba9876543210"),
        interrupted.implementation,
        controller.signal,
      ),
    ).rejects.toThrow("integration.isolation.interrupted");
    expect(interrupted.calls).not.toContain("build");
    expect(interrupted.calls.at(-1)).toBe("evidence");
  });

  it("freezes success and failure outcomes before cleanup-only aborts", async () => {
    const passed = driver();
    const passedController = new AbortController();
    passed.removeContainer.mockImplementationOnce(() => {
      passedController.abort();
      return Promise.resolve();
    });
    await expect(
      executeIsolationPlan(
        planFor("0123456789abcdef"),
        passed.implementation,
        passedController.signal,
      ),
    ).resolves.toMatchObject({ outcome: "passed" });
    expect(passed.recordEvidence.mock.calls[0]?.[0].outcome).toBe("passed");

    const failed = driver();
    const failedController = new AbortController();
    failed.runScenario.mockRejectedValueOnce(new Error("scenario failed"));
    failed.removeContainer.mockImplementationOnce(() => {
      failedController.abort();
      return Promise.resolve();
    });
    await expect(
      executeIsolationPlan(
        planFor("fedcba9876543210"),
        failed.implementation,
        failedController.signal,
      ),
    ).rejects.toThrow("scenario failed");
    expect(failed.recordEvidence.mock.calls[0]?.[0].outcome).toBe("failed");
  });
});

// eslint-disable-next-line max-lines-per-function -- one matrix verifies ordered cleanup evidence and causal precedence.
describe("scenario cleanup evidence", () => {
  it("records unavailable runtime inspection and still tears down", async () => {
    const fixture = driver();
    fixture.inspectExecutionPolicy.mockRejectedValueOnce(
      new Error("runtime inspection failed"),
    );
    await expect(
      executeIsolationPlan(
        planFor("0123456789abcdef"),
        fixture.implementation,
        new AbortController().signal,
      ),
    ).rejects.toThrow("runtime inspection failed");
    expect(fixture.calls).not.toContain("build");
    expect(fixture.calls).toContain("context:0123456789abcdef");
    expect(fixture.calls.at(-1)).toBe("evidence");
    expect(fixture.recordEvidence.mock.calls[0]?.[0]).toMatchObject({
      builtImageDigest: null,
      builtMockServerImageDigest: null,
      executionPolicy: {
        runtimeInspection: { outcome: "unavailable", identity: null },
      },
      cleanup: { outcome: "complete" },
      outcome: "failed",
    });
  });

  it("surfaces cleanup failures after attempting every teardown step", async () => {
    const fixture = driver();
    const diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    fixture.removeContainer.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(
      executeIsolationPlan(
        planFor("0123456789abcdef"),
        fixture.implementation,
        new AbortController().signal,
      ),
    ).rejects.toThrow("integration.isolation.cleanup-scenario-container");
    expect(fixture.calls).toContain(
      "remove-network:agentscope-int-0123456789abcdef-network",
    );
    expect(fixture.calls.at(-1)).toBe("evidence");
    expect(fixture.recordEvidence.mock.calls[0]?.[0].cleanup).toEqual({
      outcome: "failed",
      removalFailureCount: 1,
      remaining: emptyCleanupInventory(),
    });
    expect(diagnostic).toHaveBeenCalledWith(
      'integration.isolation.cleanup-diagnostic:{"outcome":"failed","removalFailureCount":1,"remaining":{"containers":0,"networks":0,"images":0,"volumes":0,"buildContexts":0,"activeRunMarkers":0}}\n',
    );
    diagnostic.mockRestore();
  });

  it("retains the fixed network cleanup removal subphase", async () => {
    const fixture = driver();
    const diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const causal = new Error("integration.images.deadline");
    vi.spyOn(fixture.implementation, "removeNetwork").mockRejectedValueOnce(
      new Error("integration.isolation.cleanup-network-remove", {
        cause: causal,
      }),
    );
    let failure: unknown;
    try {
      await executeIsolationPlan(
        planFor("0123456789abcdef"),
        fixture.implementation,
        new AbortController().signal,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      message: "integration.isolation.cleanup-network-remove",
      cause: causal,
    });
    diagnostic.mockRestore();
  });

  it("retains the work failure when cleanup also fails", async () => {
    const fixture = driver();
    const diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const workFailure = new Error("integration.isolation.pty-receipt");
    fixture.runScenario.mockRejectedValueOnce(workFailure);
    vi.spyOn(fixture.implementation, "removeNetwork").mockRejectedValueOnce(
      new Error("integration.isolation.cleanup-network-remove", {
        cause: new Error("integration.images.docker-client"),
      }),
    );
    let failure: unknown;
    try {
      await executeIsolationPlan(
        planFor("0123456789abcdef"),
        fixture.implementation,
        new AbortController().signal,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      message: "integration.isolation.cleanup-network-remove",
      cause: workFailure,
    });
    diagnostic.mockRestore();
  });

  it("rejects a non-digest image result and still tears down", async () => {
    const fixture = driver();
    fixture.buildImage.mockResolvedValueOnce("latest");
    await expect(
      executeIsolationPlan(
        planFor("0123456789abcdef"),
        fixture.implementation,
        new AbortController().signal,
      ),
    ).rejects.toThrow("integration.isolation.image-digest");
    expect(fixture.calls.at(-1)).toBe("evidence");
    expect(fixture.recordEvidence.mock.calls[0]?.[0]).toMatchObject({
      builtImageDigest: null,
      builtMockServerImageDigest: null,
      outcome: "failed",
    });
  });

  it("records only the image identity established before a later build failure", async () => {
    const fixture = driver();
    fixture.implementation.buildMockServerImage = vi
      .fn<IsolationDriver["buildMockServerImage"]>()
      .mockRejectedValueOnce(new Error("mock image failed"));
    await expect(
      executeIsolationPlan(
        planFor("0123456789abcdef"),
        fixture.implementation,
        new AbortController().signal,
      ),
    ).rejects.toThrow("mock image failed");
    expect(fixture.recordEvidence.mock.calls[0]?.[0]).toMatchObject({
      builtImageDigest: `sha256-${"5".repeat(64)}`,
      builtMockServerImageDigest: null,
      outcome: "failed",
    });
  });
});

describe("scenario evidence validation", () => {
  it("rejects omitted, substituted, secret-shaped, and unbounded executor policy", async () => {
    const invalidPolicies = [
      { ...executionPolicyFor(), runtimeInspection: undefined },
      {
        ...executionPolicyFor(),
        maximumParallelScenarios: 17,
      },
      {
        ...executionPolicyFor(),
        requests: { destinationServerMaximumBytes: 2 * 1024 * 1024 },
      },
      {
        ...executionPolicyFor(),
        containers: {
          ...ISOLATION_EXECUTOR_LIMITS.containers,
          scenario: {
            ...ISOLATION_EXECUTOR_LIMITS.containers.scenario,
            memoryBytes: 64 * 1024 * 1024,
          },
        },
      },
      {
        ...executionPolicyFor(),
        runtimeInspection: {
          ...executionPolicyFor().runtimeInspection,
          identity: {
            ...executionPolicyFor().runtimeInspection.identity,
            engine: {
              ...executionPolicyFor().runtimeInspection.identity.engine,
              operatingSystem: "/Users/operator/secret",
            },
          },
        },
      },
      {
        ...executionPolicyFor(),
        runtimeInspection: {
          ...executionPolicyFor().runtimeInspection,
          identity: {
            ...executionPolicyFor().runtimeInspection.identity,
            engine: {
              ...executionPolicyFor().runtimeInspection.identity.engine,
              kind: "docker-desktop",
              product: "Docker Desktop 4.99",
              operatingSystem: "Docker Desktop",
            },
          },
        },
      },
    ];
    for (const policy of invalidPolicies) {
      const fixture = driver();
      fixture.inspectExecutionPolicy.mockResolvedValueOnce(policy);
      await expect(
        executeIsolationPlan(
          planFor("0123456789abcdef"),
          fixture.implementation,
          new AbortController().signal,
        ),
      ).rejects.toThrow("integration.isolation.runtime-policy");
      expect(fixture.calls).toContain(
        "remove-network:agentscope-int-0123456789abcdef-network",
      );
      expect(fixture.calls.at(-1)).toBe("evidence");
      expect(
        fixture.recordEvidence.mock.calls[0]?.[0].executionPolicy
          .runtimeInspection,
      ).toEqual({ outcome: "unavailable", identity: null });
    }
  });

  it("records cleanup proof failure without inventing survivor counts", async () => {
    const fixture = driver();
    const diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    fixture.inspectCleanup.mockRejectedValueOnce(
      new Error("proof unavailable"),
    );
    await expect(
      executeIsolationPlan(
        planFor("0123456789abcdef"),
        fixture.implementation,
        new AbortController().signal,
      ),
    ).rejects.toThrow("integration.isolation.cleanup-inventory");
    expect(fixture.recordEvidence.mock.calls[0]?.[0].cleanup).toEqual({
      outcome: "verification-failed",
      removalFailureCount: 0,
      remaining: null,
    });
    expect(diagnostic).toHaveBeenCalledWith(
      'integration.isolation.cleanup-diagnostic:{"outcome":"verification-failed","removalFailureCount":0,"remaining":null}\n',
    );
    diagnostic.mockRestore();
  });

  it("classifies a proven cleanup survivor separately from inventory failure", async () => {
    const fixture = driver();
    const diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    fixture.inspectCleanup.mockResolvedValueOnce({
      ...emptyCleanupInventory(),
      containers: 1,
    });
    await expect(
      executeIsolationPlan(
        planFor("0123456789abcdef"),
        fixture.implementation,
        new AbortController().signal,
      ),
    ).rejects.toThrow("integration.isolation.cleanup-remaining");
    expect(fixture.recordEvidence.mock.calls[0]?.[0].cleanup).toEqual({
      outcome: "failed",
      removalFailureCount: 0,
      remaining: {
        ...emptyCleanupInventory(),
        containers: 1,
      },
    });
    diagnostic.mockRestore();
  });
});

describe("compiled scenario evidence", () => {
  it("accepts distro-qualified container runtime versions", () => {
    const input = executionPolicyFor();
    input.runtimeInspection.identity.containerRuntime.version =
      "1.3.4-0ubuntu1~24.04.1";
    expect(
      compileIsolationExecutionPolicy(input).runtimeInspection.identity,
    ).toMatchObject({
      containerRuntime: { version: "1.3.4-0ubuntu1~24.04.1" },
    });
  });
});

const compiledEvidenceFixture = () => {
  const policy = compileIsolationExecutionPolicy(executionPolicyFor());
  return {
    policy,
    evidence: {
      evidenceVersion: 2,
      runId: "0123456789abcdef",
      scenarioId: "fixture-process-smoke",
      manifestIdentity: manifest.manifestIdentity,
      candidateBundleIdentity: `sha256-${"2".repeat(64)}`,
      candidateRevision: "3".repeat(40),
      executionMode: "headless",
      terminalAction: "none",
      baseImage: `node@sha256:${"4".repeat(64)}`,
      mockServerImage: `mockserver@sha256:${"5".repeat(64)}`,
      baseImageIdentity: preparedIdentityFor(
        `node@sha256:${"4".repeat(64)}`,
        "a",
      ),
      mockServerImageIdentity: preparedIdentityFor(
        `mockserver@sha256:${"5".repeat(64)}`,
        "b",
      ),
      builtImageDigest: `sha256-${"6".repeat(64)}`,
      builtMockServerImageDigest: `sha256-${"7".repeat(64)}`,
      networkMode: "internal-only",
      hostMountCount: 0,
      readOnlyRootFilesystem: true,
      tmpfsMounts: [...ISOLATION_EXECUTOR_LIMITS.containers.scenario.tmpfs].map(
        ({ path }) => path,
      ),
      executionPolicy: policy,
      cleanup: {
        outcome: "complete",
        removalFailureCount: 0,
        remaining: emptyCleanupInventory(),
      },
      headlessTerminalReceipt: headlessReceiptFor(),
      ptyTerminalReceipt: null,
      outcome: "passed",
    },
  };
};
const compileWithPreparedAuthority = (
  input: unknown,
  authority: ReturnType<typeof compiledEvidenceFixture>["evidence"],
) =>
  compileIsolationEvidence(input, {
    baseImageIdentity: authority.baseImageIdentity,
    mockServerImageIdentity: authority.mockServerImageIdentity,
  });

describe("prepared OCI identity evidence", () => {
  it("rejects omission and substitution of the canonical tuple", () => {
    const { evidence } = compiledEvidenceFixture();
    const withoutIdentity = { ...evidence } as Partial<typeof evidence>;
    delete withoutIdentity.baseImageIdentity;
    expect(() =>
      compileWithPreparedAuthority(withoutIdentity, evidence),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...evidence,
          baseImageIdentity: {
            ...evidence.baseImageIdentity,
            image: evidence.mockServerImage,
          },
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...evidence,
          baseImageIdentity: {
            ...evidence.baseImageIdentity,
            manifestDigest: `sha256:${"f".repeat(64)}`,
          },
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
  });
});

describe("selected headless backend evidence", () => {
  it("rejects missing, substituted, late, and uncertain terminal receipts", () => {
    const { evidence } = compiledEvidenceFixture();
    for (const headlessTerminalReceipt of [
      null,
      { ...evidence.headlessTerminalReceipt, runId: "fedcba9876543210" },
      {
        ...evidence.headlessTerminalReceipt,
        returnedAtMs:
          evidence.headlessTerminalReceipt.request.monotonicShutdownDeadlineMs +
          1,
      },
      { ...evidence.headlessTerminalReceipt, cleanup: "uncertain" },
      { ...evidence.headlessTerminalReceipt, termRequested: true },
      { ...evidence.headlessTerminalReceipt, killRequested: true },
      {
        ...evidence.headlessTerminalReceipt,
        requestFingerprint: `sha256:${"f".repeat(64)}`,
      },
      {
        ...evidence.headlessTerminalReceipt,
        request: {
          ...evidence.headlessTerminalReceipt.request,
          arguments: ["substituted"],
        },
      },
    ])
      expect(() =>
        compileWithPreparedAuthority(
          { ...evidence, headlessTerminalReceipt },
          evidence,
        ),
      ).toThrow("integration.isolation.evidence");
  });
});

// eslint-disable-next-line max-lines-per-function
describe("selected PTY backend evidence", () => {
  it("rejects cross-mode, missing, substituted, and raw terminal evidence", () => {
    const { evidence } = compiledEvidenceFixture();
    const pty = ptyReceiptFor();
    const interactive = {
      ...evidence,
      scenarioId: "fixture-process-interactive",
      executionMode: "interactive",
      terminalAction: "eof",
      executionPolicy: executionPolicyFor("fixture-process-interactive"),
      headlessTerminalReceipt: null,
      ptyTerminalReceipt: pty,
    };
    expect(compileWithPreparedAuthority(interactive, evidence)).toEqual(
      interactive,
    );
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...interactive,
          ptyTerminalReceipt: { ...pty, observedCanonicalMode: false },
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(
      compileWithPreparedAuthority(
        {
          ...interactive,
          terminalAction: "post-completion-input",
          ptyTerminalReceipt: ptyPostInputReceiptFor(),
        },
        evidence,
      ),
    ).toMatchObject({
      terminalAction: "post-completion-input",
      ptyTerminalReceipt: {
        eofByteWritten: false,
        observedCanonicalMode: false,
      },
    });
    expect(() =>
      compileWithPreparedAuthority(
        { ...interactive, terminalAction: "post-completion-input" },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    const controlled = {
      ...interactive,
      terminalAction: "post-completion-controls" as const,
      ptyTerminalReceipt: ptyControlReceiptFor(),
    };
    expect(compileWithPreparedAuthority(controlled, evidence)).toEqual(
      controlled,
    );
    expect(() =>
      compileWithPreparedAuthority(
        { ...controlled, ptyTerminalReceipt: pty },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...interactive,
          ptyTerminalReceipt: { ...pty, eofByteWritten: false },
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    for (const ptyTerminalReceipt of [
      null,
      { ...pty, runId: "fedcba9876543210" },
      { ...pty, scenarioId: "fixture-process-smoke" },
      { ...pty, cleanup: "uncertain" },
      { ...pty, readinessObserved: false },
      { ...pty, inputSha256: "f".repeat(64) },
      {
        ...pty,
        actions: pty.actions.map((action) =>
          action.action === "input"
            ? { ...action, inputSha256: "f".repeat(64) }
            : action,
        ),
      },
      {
        ...pty,
        request: {
          ...pty.request,
          process: { ...pty.request.process, stdinBase64: "cnVuCg==" },
        },
      },
      {
        ...pty,
        finalSnapshot: { ...pty.finalSnapshot, semanticState: "ready" },
      },
      { ...pty, rawOutput: "secret terminal transcript" },
    ])
      expect(() =>
        compileWithPreparedAuthority(
          { ...interactive, ptyTerminalReceipt },
          evidence,
        ),
      ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        { ...interactive, headlessTerminalReceipt: headlessReceiptFor() },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
  });

  it("admits the exact styled challenge receipt and rejects trigger or kind substitution", () => {
    const { evidence } = compiledEvidenceFixture();
    const receipt = ptyChallengeReceiptFor();
    const interactive = {
      ...evidence,
      scenarioId: "codex-tui-trace-smoke",
      executionMode: "interactive",
      terminalAction: "post-completion-input",
      executionPolicy: executionPolicyFor("codex-tui-trace-smoke"),
      headlessTerminalReceipt: null,
      ptyTerminalReceipt: receipt,
    };
    expect(compileWithPreparedAuthority(interactive, evidence)).toEqual(
      interactive,
    );
    const contentFreeDiagnostic = {
      ...receipt,
      postSubmissionIdleDiagnostic: "idle-ready" as const,
      postSubmissionIdleAtTitleDiagnostic: "idle-ready" as const,
    };
    expect(
      compileWithPreparedAuthority(
        { ...interactive, ptyTerminalReceipt: contentFreeDiagnostic },
        evidence,
      ).ptyTerminalReceipt?.postSubmissionIdleDiagnostic,
    ).toBe("idle-ready");
    expect(
      compileWithPreparedAuthority(
        { ...interactive, ptyTerminalReceipt: contentFreeDiagnostic },
        evidence,
      ).ptyTerminalReceipt?.postSubmissionIdleAtTitleDiagnostic,
    ).toBe("idle-ready");
    expect(
      compileWithPreparedAuthority(
        {
          ...interactive,
          ptyTerminalReceipt: {
            ...receipt,
            postSubmissionIdleAtTitleDiagnostic:
              "idle-revoked-alternate-screen-exit",
          },
        },
        evidence,
      ).ptyTerminalReceipt?.postSubmissionIdleAtTitleDiagnostic,
    ).toBe("idle-revoked-alternate-screen-exit");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...interactive,
          ptyTerminalReceipt: {
            ...receipt,
            postSubmissionIdleDiagnostic: "terminal-content",
          },
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...interactive,
          ptyTerminalReceipt: {
            ...receipt,
            postSubmissionIdleAtTitleDiagnostic: "terminal-content",
          },
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    for (const ptyTerminalReceipt of [
      refingerprintPtyEnvelope(
        receipt,
        receipt.request.readiness,
        "semantic-ready",
      ),
      refingerprintPtyEnvelope(
        receipt,
        { kind: "semantic-marker" },
        "immediate",
      ),
      refingerprintPtyProcessDeadline(
        "monotonicExecutionDeadlineMs",
        26_000,
        receipt,
      ),
      {
        ...receipt,
        request: {
          ...receipt.request,
          readiness: { kind: "challenge-marker", challenge: "b".repeat(63) },
        },
      },
    ])
      expect(() =>
        compileWithPreparedAuthority(
          { ...interactive, ptyTerminalReceipt },
          evidence,
        ),
      ).toThrow("integration.isolation.evidence");
  });

  it.each([
    ["monotonicStartupDeadlineMs", 11_001],
    ["monotonicExecutionDeadlineMs", 25_999],
    ["monotonicShutdownDeadlineMs", 31_001],
    ["terminationGraceMs", 999],
  ] as const)("rejects refingerprinted %s substitution", (field, value) => {
    const { evidence } = compiledEvidenceFixture();
    const ptyTerminalReceipt = refingerprintPtyProcessDeadline(field, value);
    const interactive = {
      ...evidence,
      scenarioId: "fixture-process-interactive",
      executionMode: "interactive" as const,
      executionPolicy: executionPolicyFor("fixture-process-interactive"),
      headlessTerminalReceipt: null,
      ptyTerminalReceipt,
    };
    expect(() => compileWithPreparedAuthority(interactive, evidence)).toThrow(
      "integration.isolation.evidence",
    );
  });
});

describe("compiled scenario evidence", () => {
  it("compiles only the closed evidence and policy envelopes", () => {
    const { evidence, policy } = compiledEvidenceFixture();
    expect(compileWithPreparedAuthority(evidence, evidence)).toEqual(evidence);
    expect(() =>
      compileWithPreparedAuthority(
        { ...evidence, credential: "CANARY_SECRET" },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...evidence,
          scenarioId: "different-scenario",
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...evidence,
          executionPolicy: {
            ...policy,
            selection: {
              ...policy.selection,
              manifestIdentity: `sha256-${"9".repeat(64)}`,
            },
          },
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...evidence,
          outcome: "failed",
          executionPolicy: {
            ...policy,
            runtimeInspection: { outcome: "unavailable", identity: null },
          },
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...evidence,
          builtImageDigest: null,
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...evidence,
          executionPolicy: {
            ...policy,
            runtimeInspection: { outcome: "unavailable", identity: null },
          },
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...evidence,
          outcome: "failed",
          builtImageDigest: null,
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...evidence,
          cleanup: {
            ...evidence.cleanup,
            remaining: { ...emptyCleanupInventory(), containers: 1 },
          },
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(
      compileIsolationExecutionPolicy({
        ...executionPolicyFor(),
        selection: {
          selectionVersion: 2,
          manifestIdentity: manifest.manifestIdentity,
          mode: "full",
          selector: {},
          scenarioIds: ["fixture-process-smoke", "fixture-process-smoke"],
        },
      }).selection.scenarioIds,
    ).toEqual(["fixture-process-smoke", "fixture-process-smoke"]);
  });
});
