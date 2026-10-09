import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { runSupervisedProcess } from "../supervisor.mjs";
import { writeExactRegularFile } from "../exact-file.mjs";
import { SUBSTRATE_CERTIFICATION_CASES } from "./substrate-certification.js";
import { sanitizeFixtureResult } from "./operations.js";
import { knownFailureCode } from "./controller-failure-diagnostic.js";

type OperationDiagnosticFunctions = {
  joinMockServer: (plan: object, signal: AbortSignal) => Promise<void>;
  publishOperationFailureDiagnostic: (
    slot: string,
    error: unknown,
    plan?: object,
  ) => void;
};
const terminalMockContainer = (containerId: string, runId: string) => ({
  Id: containerId,
  Name: "/owned",
  Config: {
    Labels: {
      "com.agentscope.integration": "true",
      "com.agentscope.integration.run": runId,
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
    ExitCode: 0,
    Error: "",
    FinishedAt: "2026-01-01T00:00:00Z",
  },
});
const operationDiagnosticFixture = (failAt = "", sinkFails = false) => {
  const source = readIntegration("run-scenarios.mjs");
  const start = source.indexOf("const operationFailureSlots =");
  const end = source.indexOf("const createScenarioContainer =", start);
  const runId = "a".repeat(16);
  const containerId = "b".repeat(64);
  const plan = {
    runId,
    scenarioId: "codex-tui-trace-smoke",
    mockServerName: "owned",
  };
  const error = new Error("integration.mockserver.control");
  const calls: string[] = [];
  const output: string[] = [];
  const state = { uncertain: false, observerFails: false };
  const step = (slot: string, value?: unknown) => {
    calls.push(slot);
    if (slot === failAt) {
      state.uncertain = true;
      throw error;
    }
    return value;
  };
  const container = terminalMockContainer(containerId, runId);
  const functions = runInNewContext(
    `${source.slice(start, end)}; ({ joinMockServer, publishOperationFailureDiagnostic })`,
    {
      Buffer,
      AbortSignal,
      knownFailureCode,
      preparedDockerClient: {},
      preparedDockerClientRequiresOuterHostRetirement: () => {
        if (state.observerFails) throw new Error("PRIVATE observer");
        return state.uncertain;
      },
      writeSync: (_fd: number, bytes: Buffer) => {
        if (sinkFails) throw new Error("PRIVATE sink");
        output.push(bytes.toString("utf8"));
      },
      mockServerContainerIdentities: new Map([[runId, containerId]]),
      mockServerJoinDeadlines: new Map([[runId, 1000]]),
      linuxBootMonotonicMilliseconds: () => step("join-deadline", 100),
      assertControlVolumeCurrent: (_plan: object, signal: AbortSignal) => {
        expect(signal.aborted).toBe(false);
        step("join-control-volume");
      },
      mockServerControls: new Map([
        [runId, { host: "mockserver", material: {} }],
      ]),
      openMockServerControl: (input: { deadline: number }) => {
        expect(input.deadline).toBe(1000);
        step("join-control-open");
        return {
          stop: () => step("join-control-stop", { status: 200 }),
          snapshot: () => ({ entries: [] }),
        };
      },
      verifyMockServerControlBoundary: () => step("join-control-boundary"),
      dockerWithSignal: (
        args: string[],
        signal: AbortSignal,
        options: { terminal: boolean },
      ) => {
        expect(signal.aborted).toBe(false);
        expect(options.terminal).toBe(true);
        if (args[0] === "cp")
          return step(
            args[1]?.endsWith("requests.json")
              ? "join-ledger-requests"
              : "join-ledger-complete",
          );
        return step(
          args[1] === "wait" ? "join-container-wait" : "join-container-inspect",
          { stdout: args[1] === "wait" ? "0\n" : JSON.stringify([container]) },
        );
      },
      artifactsRoot: "/owned",
      resolve,
      mkdirSync: () => step("join-ledger-directory"),
      readMockServerFinalLedger: (input: { deadline: number }) => {
        expect(input.deadline).toBe(1000);
        return step("join-ledger-read", []);
      },
      projectMockServerRequests: (value: unknown) => value,
      assertMockServerFinalLedger: () => step("join-ledger-assert"),
      fixtureResults: new Map(),
      modelRoutes: {},
      fixtureTrafficObservations: new Map(),
      manifest: { scenarios: [plan] },
      joinCollectorObservations: (
        _plan: object,
        _signal: AbortSignal,
        deadline: number,
      ) => {
        expect(deadline).toBe(1000);
        return step("join-collector-read", []);
      },
      completeCodexCollectorFixture: () => step("join-collector-project"),
      completeClaudeCollectorFixture: () => step("join-collector-project"),
    },
  ) as OperationDiagnosticFunctions;
  return { source, functions, plan, error, calls, output, state, container };
};

describe("actual-source optional original operation diagnostics", () => {
  it.each([
    "join-deadline",
    "join-control-volume",
    "join-control-open",
    "join-control-boundary",
    "join-control-stop",
    "join-container-wait",
    "join-container-inspect",
    "join-ledger-directory",
    "join-ledger-requests",
    "join-ledger-complete",
    "join-ledger-read",
    "join-ledger-assert",
    "join-collector-read",
    "join-collector-project",
  ])(
    "retains exact %s failure before cleanup without changing its identity or deadline",
    async (slot) => {
      const f = operationDiagnosticFixture(slot);
      await expect(
        f.functions.joinMockServer(f.plan, new AbortController().signal),
      ).rejects.toBe(f.error);
      expect(f.calls.at(-1)).toBe(slot);
      expect(f.output).toHaveLength(1);
      expect(Buffer.byteLength(f.output[0]!)).toBeLessThanOrEqual(512);
      expect(
        JSON.parse(f.output[0]!.slice(f.output[0]!.indexOf(":") + 1)),
      ).toEqual({
        slot,
        runId: f.plan.runId,
        code: "integration.mockserver.control",
        clientRetirementRequired: true,
      });
    },
  );
  it("leaves a completed join silent and preserves actual boundary order", async () => {
    const f = operationDiagnosticFixture();
    await f.functions.joinMockServer(f.plan, new AbortController().signal);
    expect(f.output).toEqual([]);
    expect(f.calls).toEqual([
      "join-deadline",
      "join-control-volume",
      "join-control-open",
      "join-control-boundary",
      "join-control-stop",
      "join-container-wait",
      "join-container-inspect",
      "join-ledger-directory",
      "join-ledger-requests",
      "join-ledger-complete",
      "join-ledger-read",
      "join-ledger-assert",
      "join-collector-read",
      "join-collector-project",
    ]);
  });
  it("preserves the exact terminal witness rejection and its join slot", async () => {
    const f = operationDiagnosticFixture();
    f.container.State.ExitCode = 1;
    await expect(
      f.functions.joinMockServer(f.plan, new AbortController().signal),
    ).rejects.toThrow("integration.isolation.mockserver-terminal");
    expect(f.calls.at(-1)).toBe("join-container-inspect");
    expect(
      JSON.parse(f.output[0]!.slice(f.output[0]!.indexOf(":") + 1)),
    ).toEqual({
      slot: "join-terminal-witness",
      runId: f.plan.runId,
      code: "integration.isolation.mockserver-terminal",
      clientRetirementRequired: false,
    });
  });
  it.each(["sink", "observer"])(
    "preserves original join error when optional %s fails",
    async (failure) => {
      const f = operationDiagnosticFixture(
        "join-control-stop",
        failure === "sink",
      );
      f.state.observerFails = failure === "observer";
      await expect(
        f.functions.joinMockServer(f.plan, new AbortController().signal),
      ).rejects.toBe(f.error);
      expect(f.output).toEqual([]);
    },
  );
});

describe("optional direct original and cleanup diagnostic separation", () => {
  it("separates direct original and final cleanup codes without reading a nested cause", () => {
    const f = operationDiagnosticFixture();
    f.functions.publishOperationFailureDiagnostic(
      "runtime-original",
      new Error("integration.certification.leaked-child"),
    );
    f.state.uncertain = true;
    f.functions.publishOperationFailureDiagnostic(
      "cleanup-images",
      new Error("PRIVATE", { cause: f.error }),
    );
    expect(
      f.output.map(
        (text) => JSON.parse(text.slice(text.indexOf(":") + 1)) as unknown,
      ),
    ).toEqual([
      {
        slot: "runtime-original",
        runId: null,
        code: "integration.certification.leaked-child",
        clientRetirementRequired: false,
      },
      {
        slot: "cleanup-images",
        runId: null,
        code: "unknown",
        clientRetirementRequired: true,
      },
    ]);
    f.functions.publishOperationFailureDiagnostic("PRIVATE slot", f.error);
    f.functions.publishOperationFailureDiagnostic("runtime-original", f.error, {
      runId: "PRIVATE",
    });
    for (const runId of [[], {}, 1, { toJSON: () => "PRIVATE" }])
      f.functions.publishOperationFailureDiagnostic(
        "runtime-original",
        f.error,
        {
          runId,
        },
      );
    expect(f.output).toHaveLength(2);
    expect(f.output.join("")).not.toContain("PRIVATE");
  });
});

describe("actual-source candidate failure diagnostics", () => {
  it.each(["client", "prepared", "context", "build"])(
    "observes the original build-candidate %s rejection before cleanup wrapping",
    async (phase) => {
      const f = operationDiagnosticFixture();
      const original = new Error("integration.isolation.context");
      const start = f.source.indexOf("const buildImage =");
      const end = f.source.indexOf("const prepareMockServerImage =", start);
      const buildImage = runInNewContext(
        `${f.source.slice(start, end)}; buildImage`,
        {
          requireSettledMockServerClients: () => {
            if (phase === "client") throw original;
          },
          preparedImageFor: () => {
            if (phase === "prepared") throw original;
          },
          stageBuildContext: () => {
            if (phase === "context") throw original;
            return {
              context: "/owned",
              requiresHarnessBuildContextBound: false,
            };
          },
          buildPreparedDockerImage: () => Promise.reject(original),
          preparedDockerClient: {},
          scenarioTimeoutMilliseconds: 300_000,
          IMAGE_PREPARATION_LIMITS: {
            maximumPreparationMilliseconds: 300_000,
            defaultMaximumBuildContextBytes: 1024,
          },
          publishOperationFailureDiagnostic:
            f.functions.publishOperationFailureDiagnostic,
        },
      ) as (plan: object, signal: AbortSignal) => Promise<unknown>;
      await expect(
        buildImage(f.plan, new AbortController().signal),
      ).rejects.toBe(original);
      expect(
        JSON.parse(f.output[0]!.slice(f.output[0]!.indexOf(":") + 1)),
      ).toEqual({
        slot: (
          {
            client: "candidate-client",
            prepared: "candidate-prepared-image",
            context: "candidate-context-staging",
            build: "candidate-image-build",
          } as Record<string, string>
        )[phase],
        runId: f.plan.runId,
        code: "integration.isolation.context",
        clientRetirementRequired: false,
      });
    },
  );
});

describe("actual-source original versus final cleanup precedence", () => {
  it("executes the actual outer catch and final cleanup slots without replacing either first error", async () => {
    const f = operationDiagnosticFixture();
    const original = new Error(
      "integration.certification.mixed-artifact-digest",
    );
    const cleanup = new Error("integration.images.deadline");
    const material = new Error("integration.harness-material.failed");
    const start = f.source.indexOf(
      '} catch (error) {\n  publishOperationFailureDiagnostic("runtime-original"',
    );
    const end = f.source.indexOf(
      "if (primaryError !== undefined) throw primaryError;",
      start,
    );
    expect(start).toBeGreaterThan(0);
    const result = (await runInNewContext(
      `(async () => { let primaryError; let retirementRequired = false; try { throw original; ${f.source.slice(start, end)} return { primaryError, retirementRequired }; })()`,
      {
        original,
        publishOperationFailureDiagnostic:
          f.functions.publishOperationFailureDiagnostic,
        publishScenarioContextRefusals: () => undefined,
        mockServerBuiltImages: new Map(),
        preparedDockerClient: {},
        preparedDockerClientRequiresOuterHostRetirement: () => false,
        plans: [],
        substrateCertificationCase: undefined,
        process: { removeListener: () => undefined },
        abort: () => undefined,
        requireSettledMockServerClients: () => {
          throw cleanup;
        },
        preparedHarnessMaterials: new Map([["owned", {}]]),
        retirePreparedHarnessMaterial: () => {
          throw material;
        },
        requireIntegrationFailureEvidence: () => undefined,
        publishControllerFailureManifest: () => undefined,
      },
    )) as { primaryError: unknown; retirementRequired: boolean };
    expect(result.primaryError).toBe(original);
    expect(result.retirementRequired).toBe(true);
    expect(
      f.output.map(
        (text) => JSON.parse(text.slice(text.indexOf(":") + 1)) as unknown,
      ),
    ).toEqual([
      {
        slot: "runtime-original",
        runId: null,
        code: original.message,
        clientRetirementRequired: false,
      },
      {
        slot: "cleanup-images",
        runId: null,
        code: cleanup.message,
        clientRetirementRequired: false,
      },
      {
        slot: "cleanup-materials",
        runId: null,
        code: material.message,
        clientRetirementRequired: false,
      },
    ]);
  });
});
import { snapshotMockServerTraffic } from "../mockserver-control.mjs";

const mixedArtifactPartialOutput = () => {
  const platform = readFileSync(
    resolve(import.meta.dirname, "../platform-fixture.mjs"),
    "utf8",
  );
  const plan = {
    runId: "a".repeat(16),
    scenarioId: "fixture-codex-smoke",
    executionMode: "headless",
  };
  let output = "";
  runInNewContext(
    `${platform.slice(platform.indexOf("const trafficEvidence ="), platform.indexOf('emitEvidence("partial");'))};emitEvidence("partial");`,
    {
      snapshotMockServerTraffic,
      integrationRunId: plan.runId,
      mockTraffic: [],
      Buffer,
      basename: () => "pnpm-lock.yaml",
      artifactPath: "/prepared/pnpm-lock.yaml",
      scenarioId: plan.scenarioId,
      observedLifecycle: [],
      certificationReadiness: null,
      partial: {
        eventKinds: [],
        modelLedger: {
          ledgerVersion: 1,
          scenarioId: plan.scenarioId,
          entries: [],
        },
        destinationLedger: {
          ledgerVersion: 1,
          scenarioId: plan.scenarioId,
          ingestion: [],
          retrieval: [],
        },
      },
      interactive: false,
      console: {
        log: (value: string) => {
          output = value;
        },
      },
    },
  );
  return { output, plan };
};
const mixedArtifactCaptureFixture = () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../run-scenarios.mjs"),
    "utf8",
  );
  const { output, plan } = mixedArtifactPartialOutput();
  const observed: string[] = [];
  const context = {
    Buffer,
    createHash,
    snapshotMockServerTraffic,
    sanitizeFixtureResult,
    fixtureTrafficObservations: new Map(),
    fixtureResults: new Map(),
    substrateCertificationCase: "mixed-artifact-digest",
    testMode: undefined,
    candidate: {
      bundleIdentity: "held-bundle",
      lockfile: { fileName: "pnpm-lock.yaml" },
    },
    cliArtifact: { fileName: "agentscope-cli.tgz" },
    SCENARIO_HOME: "/home/runner",
    manifest: { scenarios: [{ ...plan, harnessEvidenceId: "fixture" }] },
    evidenceById: new Map([["fixture", { material: { kind: "npm" } }]]),
    linuxBootMonotonicMilliseconds: () => 100,
    SUBSTRATE_CERTIFICATION_PREDICATES: {
      "mixed-artifact-digest": "artifact-digest-mismatch",
    },
    observeSubstrateCertificationPredicate: (
      _runId: string,
      predicate: string,
    ) => observed.push(predicate),
  };
  const definitions = [
    source.slice(
      source.indexOf("const fingerprintHeadlessRequest ="),
      source.indexOf("const fingerprintSelectedPtyAuthority ="),
    ),
    source.slice(
      source.indexOf("const expectedHeadlessEnvironment ="),
      source.indexOf("const activeMarkerFor ="),
    ),
    source.slice(
      source.indexOf("const captureFixtureResult ="),
      source.indexOf(
        "// eslint-disable-next-line complexity -- exact closed receipt predicate",
      ),
    ),
  ].join("\n");
  const helpers = runInNewContext(
    `${definitions};({expectedNegativeHeadlessRequest, fingerprintHeadlessRequest, captureFixtureResult});`,
    context,
  ) as {
    expectedNegativeHeadlessRequest: (
      receipt: unknown,
      plan: unknown,
    ) => { monotonicShutdownDeadlineMs: number };
    fingerprintHeadlessRequest: (request: unknown) => string;
    captureFixtureResult: (output: string, plan: unknown) => boolean;
  };
  const receipt = {
    receiptVersion: 1,
    runId: plan.runId,
    outerMonotonicDeadlineMs: 50_000,
    requestConstructedAtMs: 200,
    translationBootAtMs: 100,
    translationLocalAtMs: 100,
    request: { monotonicShutdownDeadlineMs: 50_000 },
    returnedAtMs: 300,
    outcome: "exited",
    exitCode: 1,
    signal: null,
    termRequested: false,
    killRequested: false,
    cleanup: "clean",
    residualProcessCount: 0,
    processJoined: true,
    stdinJoined: true,
    stdoutJoined: true,
    stderrJoined: true,
    requestFingerprint: "",
  };
  receipt.request = helpers.expectedNegativeHeadlessRequest(receipt, plan);
  receipt.requestFingerprint = helpers.fingerprintHeadlessRequest(
    receipt.request,
  );
  const branchStart = source.indexOf(
    '      const output = `${error?.stdout ?? ""}`;',
  );
  const branchEnd = source.indexOf("      const receipt =", branchStart);
  const evaluate = (
    selectedOutput: string,
    selectedCase = "mixed-artifact-digest",
    mode = "headless",
  ) =>
    runInNewContext(`${definitions};${source.slice(branchStart, branchEnd)}`, {
      ...context,
      substrateCertificationCase: selectedCase,
      plan: { ...plan, executionMode: mode },
      outerMonotonicDeadline: 50_000,
      error: { stdout: selectedOutput },
    }) as unknown;
  const encode = (value: unknown) =>
    `${output}\nAGENTSCOPE_HEADLESS_RECEIPT=${Buffer.from(JSON.stringify(value)).toString("base64url")}\n`;
  return { output, receipt, observed, helpers, plan, evaluate, encode };
};

describe("mixed artifact failed-receipt chronology", () => {
  it("recognizes the exact mutation before parsing actual wrong-artifact partial output", () => {
    const fixture = mixedArtifactCaptureFixture();
    expect(() =>
      fixture.helpers.captureFixtureResult(fixture.output, fixture.plan),
    ).toThrow("integration.operations.fixture-result");
    expect(fixture.observed).toEqual([]);
    expect(() => fixture.evaluate(fixture.encode(fixture.receipt))).toThrow(
      "integration.certification.mixed-artifact-digest",
    );
    expect(fixture.observed).toEqual(["artifact-digest-mismatch"]);
  });

  it("refuses missing, malformed, foreign and substituted receipts without observing the predicate", () => {
    const fixture = mixedArtifactCaptureFixture();
    const substitutedRequest = {
      ...fixture.receipt.request,
      arguments: [
        "/opt/agentscope/scenario-process.mjs",
        "--artifact",
        "/foreign/agentscope-cli.tgz",
      ],
    };
    const invalid = [
      fixture.output,
      `${fixture.output}\nAGENTSCOPE_HEADLESS_RECEIPT=!`,
      fixture.encode({ ...fixture.receipt, runId: "b".repeat(16) }),
      fixture.encode({
        ...fixture.receipt,
        requestFingerprint: "sha256:" + "0".repeat(64),
      }),
      fixture.encode({ ...fixture.receipt, outerMonotonicDeadlineMs: 50_001 }),
      fixture.encode({
        ...fixture.receipt,
        request: substitutedRequest,
        requestFingerprint:
          fixture.helpers.fingerprintHeadlessRequest(substitutedRequest),
      }),
    ];
    for (const output of invalid)
      expect(() => fixture.evaluate(output)).toThrow(
        "integration.isolation.headless-receipt",
      );
    expect(fixture.observed).toEqual([]);
  });

  it("does not bypass fixture parsing for ordinary, leaked-child or interactive paths", () => {
    const fixture = mixedArtifactCaptureFixture();
    for (const [selectedCase, mode] of [
      ["ordinary", "headless"],
      ["leaked-child", "headless"],
      ["mixed-artifact-digest", "interactive"],
    ])
      expect(() =>
        fixture.evaluate(fixture.encode(fixture.receipt), selectedCase, mode),
      ).toThrow("integration.operations.fixture-result");
    expect(fixture.observed).toEqual([]);
  });
});

const expectCodexNativeBeforeCollectorCompletion = (scenario: string): void => {
  const terminal = scenario.indexOf(
    "await waitForCodexTurnTerminal(traceDeadline)",
  );
  const hook = scenario.indexOf(
    "await waitForCodexStopBeforeExit(traceDeadline)",
    terminal,
  );
  const native = scenario.indexOf(
    "const translated = translateCodexNativeObservations(",
    hook,
  );
  expect(terminal).toBeGreaterThan(-1);
  expect(hook).toBeGreaterThan(terminal);
  expect(native).toBeGreaterThan(hook);
  expect(scenario).not.toMatch(
    /localSqlite|openOperationalStateHealth|waitForTraceSummary|--destination",\\s*"local"/u,
  );
};

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const readIntegration = (name: string) =>
  readFileSync(resolve(workspaceRoot, "tests/integration", name), "utf8");
const manifest = (path: string) =>
  JSON.parse(readFileSync(resolve(workspaceRoot, path), "utf8")) as {
    scripts: Record<string, string>;
  };
describe("integration failure diagnostic preimages", () => {
  it("hashes the actual builder image tuple identically in private diagnostic and failure manifest", () => {
    const boundary = readIntegration("image-preparation/boundary.mjs");
    const runner = readIntegration("run-scenarios.mjs");
    const docker = readIntegration("image-preparation/docker.mjs");
    const slice = (source: string, begin: string, end: string): string => {
      const start = source.indexOf(begin);
      const finish = source.indexOf(end, start);
      if (start < 0 || finish <= start)
        throw new Error("actual-diagnostic-source-boundary");
      return source.slice(start, finish).replaceAll("export const", "const");
    };
    const privateHash =
      slice(
        boundary,
        "export const diagnosticDigest =",
        "export const classifyBuildxStderrForTesting",
      ) +
      slice(
        boundary,
        "export const digestBytes =",
        "export const jsonRecord =",
      );
    const manifestHash = slice(
      runner,
      "const diagnosticDigest =",
      "const admissionDigest =",
    );
    const privateTuple = /image: diagnosticDigest\((\{[^}]+\})\)/u.exec(
      docker,
    )?.[1];
    const manifestTuple =
      /buildkitImage: diagnosticDigest\((\{[^}]+\})\)/u.exec(runner)?.[1];
    expect(privateTuple).toBeDefined();
    expect(manifestTuple).toBeDefined();
    const facts = {
      image: `buildkit@sha256:${"a".repeat(64)}`,
      configDigest: `sha256:${"b".repeat(64)}`,
    };
    const privateDigest = runInNewContext(
      `${privateHash}; diagnosticDigest(${privateTuple});`,
      {
        Buffer,
        createHash,
        authority: { buildkit: facts },
      },
    ) as string;
    const manifestDigest = (buildkit: typeof facts): string =>
      runInNewContext(`${manifestHash}; diagnosticDigest(${manifestTuple});`, {
        createHash,
        buildkit,
      }) as string;
    expect(manifestDigest(facts)).toBe(privateDigest);
    expect(
      manifestDigest({ ...facts, image: `buildkit@sha256:${"c".repeat(64)}` }),
    ).not.toBe(privateDigest);
    expect(
      manifestDigest({ ...facts, configDigest: `sha256:${"d".repeat(64)}` }),
    ).not.toBe(privateDigest);
  });
});

describe("integration controller policy", () => {
  it("retains the original packed CLI material roles after candidate preparation", () => {
    const workflow = readFileSync(
      resolve(workspaceRoot, ".github/workflows/integration.yml"),
      "utf8",
    );
    const prepare = workflow.slice(
      workflow.indexOf("      - name: Build and prepare candidate once"),
      workflow.indexOf("  hermetic-platform:"),
    );
    const terminal = prepare.indexOf("          pnpm test:integration\n");
    expect(terminal).toBeGreaterThan(-1);
    for (const role of ["sbom", "attestations"]) {
      const target = `artifacts/integration/cli-release-materials/${role}.json`;
      const copy = `install -m 600 artifacts/npm/${role}.json ${target}`;
      expect(prepare.indexOf(copy)).toBeGreaterThan(terminal);
      expect(prepare).toContain(`            ${target}\n`);
    }
    expect(prepare).toContain("            artifacts/integration/candidates\n");
    expect(prepare).toContain(
      "            artifacts/integration/current-candidate.json\n",
    );
    expect(prepare).not.toMatch(
      /npm (?:pack|publish)|assembleCandidateAssets/u,
    );
  });

  it("requires the exact private control mount for ordinary and TUI consumers", () => {
    const source = readIntegration("immutable-candidate-authority.mjs");
    const start = source.indexOf("const selectedControlMountMatches =");
    const end = source.indexOf(
      "\nexport const validateImmutableScenarioContainer",
      start,
    );
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const matches = runInNewContext(
      `${source.slice(start, end)}; selectedControlMountMatches`,
    ) as (container: unknown, volume: unknown, handoff: unknown) => boolean;
    const volume = {
      name: "agentscope-int-0123456789abcdef-control",
      mountpoint: "/private/volume",
    };
    const mount = {
      Type: "volume",
      Name: volume.name,
      Source: volume.mountpoint,
      Destination: "/control",
      RW: true,
    };
    for (const scenarioId of [
      "fixture-process-smoke",
      "codex-tui-trace-smoke",
    ]) {
      const handoff = { runId: "0123456789abcdef", scenarioId };
      expect(matches({ Mounts: [mount] }, volume, handoff)).toBe(true);
      for (const mounts of [
        [],
        [mount, mount],
        [{ ...mount, RW: false }],
        [{ ...mount, Name: "substituted" }],
        [{ ...mount, Destination: "/candidate" }],
        [{ ...mount, Source: "/other" }],
      ])
        expect(matches({ Mounts: mounts }, volume, handoff)).toBe(false);
      expect(matches({ Mounts: [mount] }, undefined, handoff)).toBe(false);
    }
  });
});
describe("integration controller policy", () => {
  it("exposes one integration command and no public stage aliases", () => {
    const root = manifest("package.json");
    const integration = manifest("tests/integration/package.json");
    expect(root.scripts["test:integration"]).toBe(
      "pnpm --filter @agentscope/integration integration",
    );
    expect(integration.scripts.integration).toBe("node controller.mjs");
    for (const name of [
      "prepare:candidate",
      "prepare:images",
      "prepare:model-routes",
      "run:scenarios",
      "test:integration:clean",
      "test:integration:runner",
    ]) {
      expect(root.scripts).not.toHaveProperty(name);
      expect(integration.scripts).not.toHaveProperty(name);
    }
  });

  it("removes the validation lease without creating an outer-host platform", () => {
    expect(
      existsSync(resolve(workspaceRoot, "scripts/validation-lease.py")),
    ).toBe(false);
    expect(
      existsSync(
        resolve(workspaceRoot, "scripts/__tests__/validation-lease.test.mjs"),
      ),
    ).toBe(false);
    const source = readIntegration("src/controller.ts");
    expect(source).not.toMatch(
      /OIDC|attestation|bootstrap-manifest|PNPM_HOME|validation lease/iu,
    );
    expect(source).toMatch(
      /const dockerEndpoint =\s*`unix:\/\/\$\{realpathSync\("\/var\/run\/docker\.sock"\)\}`/u,
    );
    expect(source).toContain(
      'resolve(privateStorageParent, "agentscope-integration-controller-")',
    );
    expect(source).toContain("rootMode: 0o700");
  });

  it("does not retain workstation-local substrate evidence", () => {
    const evidenceRoot = resolve(workspaceRoot, "tests/integration/evidence");
    expect(existsSync(evidenceRoot) ? readdirSync(evidenceRoot) : []).toEqual(
      [],
    );
  });

  it("keeps external-material verification inside the selected disposable daemon", () => {
    const material = readIntegration("harness-material.mjs");
    const command = readIntegration("harness-material-command.mjs");
    expect(material).toContain("buildPreparedDockerImage(client");
    expect(material).toContain("retirePreparedDockerImage(client");
    expect(material).toContain('RUN --network=${operation === "gpg-verify"');
    expect(material).not.toContain("runSupervisedProcess");
    expect(command).toContain('root !== "/verify"');
    expect(command).toContain('NPM_CONFIG_IGNORE_SCRIPTS: "true"');
    expect(command).toContain(
      "npmVersion !== `${policy.verifierNpmVersion}\\n`",
    );
    expect(command).toContain("verified.attestationBundles");
    expect(command).toContain('"--no-auto-key-retrieve"');
  });

  it("retains narrow cleanup ceilings for controller-owned artifacts", () => {
    const source = readIntegration("clean.mjs");
    expect(source).toContain(
      '"current-images.json": IMAGE_PREPARATION_LIMITS.maximumEvidenceBytes',
    );
    expect(source).toContain('"current-candidate.json": 16_384');
    expect(source).toContain('"current-model-routes.json": 16_384');
    expect(source).toContain('"current-selection.json": 16_384');
    expect(source).toContain('"harness-support-evidence.json": 1_048_576');
    expect(source).toContain(
      "const addFile = (targets, relative, maximumBytes = 16_384)",
    );
    expect(source).toContain("requiredFailureEvidence.has(runId)");
    expect(source).toContain(
      "assertFailureEvidence(failureEvidenceByRunId.get(runId))",
    );
    expect(source).toContain("failureEvidenceCoverageIsExact(");
  });

  it.each([
    "clean.mjs",
    "maintain-artifacts.mjs",
    "prepare-cli.mjs",
    "prepare-images.mjs",
    "prepare-model-routes.mjs",
    "run-scenarios.mjs",
    "select.mjs",
  ])("rejects direct execution of mutation stage %s", (stage) => {
    // Keep the existing 5 s case deadline, rather than charging seven Node
    // startups to one case. Child settlement uses only that case's budget.
    const result = spawnSync(process.execPath, [stage], {
      cwd: resolve(workspaceRoot, "tests/integration"),
      encoding: "utf8",
      env: { LANG: "C.UTF-8", PATH: process.env.PATH },
      timeout: 4_500,
      killSignal: "SIGKILL",
      maxBuffer: 16_384,
    });
    expect(result.error, stage).toBeUndefined();
    expect(result.signal, stage).toBeNull();
    expect(result.status, stage).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`, stage).toContain(
      "integration.outer-host.capability-required",
    );
  });
});

// eslint-disable-next-line max-lines-per-function -- closed integration authority matrix
describe("integration cleanup authority", () => {
  it("preserves the causal interactive child diagnostic over a later generic receipt failure", () => {
    const source = readIntegration("run-scenarios.mjs");
    const recorder = source.slice(
      source.indexOf("const recordInteractiveReceiptFailure ="),
      source.indexOf("const recordInteractiveExecutionFailure ="),
    );
    expect(recorder).toContain("installedPtyFailures.has(plan.runId)");
    expect(
      recorder.indexOf("installedPtyFailures.has(plan.runId)"),
    ).toBeLessThan(recorder.indexOf("installedPtyFailures.set(plan.runId"));
  });

  it("carries a semantically nonzero PTY receipt phase into the authenticated exit channel", () => {
    const source = readIntegration("runner.mjs");
    expect(source).toContain("interactiveFailureDiagnostic = diagnostic;");
    expect(
      source.indexOf("interactiveFailureDiagnostic = diagnostic;"),
    ).toBeLessThan(
      source.indexOf(
        'fixtureFailure = new Error("integration.runner.fixture-failed")',
      ),
    );
    expect(source).toContain("decodeScenarioFailureExitCode(receipt.exitCode)");
    expect(source).toContain(
      "decodeInteractiveFailureExitCode(exitCode, scenarioId)",
    );
    expect(source).toMatch(
      /const phase = interactivePhases\[exitCode - 64\];\s+return phase === undefined\s+\? decodeInteractiveFailureExitCode\(exitCode, scenarioId\)/u,
    );
    expect(source).toContain("if (interactivePtyReceiptFailed(receipt)) {");
    expect(source).toContain(
      "} else fixtureOutput = recoverRetainedFixtureOutput();",
    );
    expect(
      source.indexOf("if (interactivePtyReceiptFailed(receipt)) {"),
    ).toBeLessThan(
      source.indexOf("} else fixtureOutput = recoverRetainedFixtureOutput();"),
    );
    expect(
      source.indexOf("decodeScenarioFailureExitCode(receipt.exitCode)"),
    ).toBeLessThan(
      source.indexOf("} else fixtureOutput = recoverRetainedFixtureOutput();"),
    );

    const scenario = readIntegration("codex-pty-scenario.mjs");
    expect(scenario).toContain("exitCode = 64 + interactiveFailurePhaseIndex;");
    expect(scenario).toContain(
      "process.stdout.write(`${terminalCompletionMarker}\\r\\n`, (error)",
    );
    expect(
      scenario.indexOf(
        "process.stdout.write(`${terminalCompletionMarker}\\r\\n`, (error)",
      ),
    ).toBeLessThan(scenario.indexOf("settle(error === null"));
    expect(scenario).toContain(
      "const timer = setTimeout(() => settle(1), 1_000)",
    );
    const completionPublished = scenario.indexOf(
      'recordInteractivePhase("tui-exit-published");',
    );
    const codexJoined = scenario.indexOf(
      'recordInteractivePhase("tui-joined");',
    );
    expect(completionPublished).toBeGreaterThan(
      scenario.indexOf("await publishTerminalCompletionBeforeDeadline({"),
    );
    expect(completionPublished).toBeLessThan(
      scenario.indexOf(
        "await observeBeforeDiagnosticDeadline(codexRun, traceDeadline);",
      ),
    );
    expect(scenario).toContain(
      'if (message === "integration.codex.diagnostic-deadline") {\n      recordInteractivePhase("tui-join-deadline");',
    );
    expect(scenario).toContain(
      "joinDeadlineHookState = classifyCodexShutdownAtJoinDeadline({",
    );
    expect(scenario).toContain("encodeCodexJoinDeadlineExitCode(");
    expect(scenario).toContain("decodeCodexJoinDeadlineExitCode(exitCode) ??");
    expect(scenario).toContain(
      'writeFileSync(\n        join(ledger, "interactive-failure.txt"),\n        encodeAdapterReportedFailureMarker(',
    );
    expect(scenario).toContain(") ?? `${diagnostic}\\n`,");
    expect(source).toContain(
      "decodeInteractiveFailureExitCode(exitCode, scenarioId)",
    );
    expect(source).toContain("integration.runner.untrusted-join-hint:");
    expect(source).toContain("const hint = untrustedCodexJoinHint(ledger);");
    expect(source).toContain(
      "encodeInteractiveFailureExitCode(interactiveFailureDiagnostic, scenarioId)",
    );
    expect(source).toContain(
      "encodeInteractiveFailureExitCode(interactiveFailureDiagnostic, scenarioId)",
    );
    expect(source).not.toContain("readRetainedJoinDiagnostic");
    expect(source).toContain('scenarioId === "codex-tui-trace-smoke"');
    expect(scenario).toContain(
      '} else if (message === "integration.codex.child")\n      recordInteractivePhase("tui-child-rejected");',
    );
    expect(codexJoined).toBeGreaterThan(completionPublished);
    expect(codexJoined).toBeLessThan(
      scenario.indexOf(
        "const rootHookLifecycle = inspectDiagnosticBeforeDeadline",
      ),
    );
    expect(source).toContain(
      'AGENTSCOPE_INTEGRATION_RUN_ID: requiredEnvironment(\n      "AGENTSCOPE_INTEGRATION_RUN_ID",\n    )',
    );
    const controller = readIntegration("run-scenarios.mjs");
    expect(controller).toContain("AGENTSCOPE_INTEGRATION_RUN_ID: plan.runId,");
    expect(scenario).toContain(
      "const preparationCutoff = Math.floor(deadline - 5_000);",
    );
    expect(scenario).toContain("!Number.isSafeInteger(preparationCutoff) ||");
  });

  it("keeps native terminal diagnosis distinct from outer canonical OTLP delivery", () => {
    const scenario = readIntegration("codex-pty-scenario.mjs");
    const diagnostic = readIntegration("codex-trace-child-diagnostics.mjs");
    const authority = readIntegration("immutable-candidate-authority.mjs");
    const runner = readIntegration("runner.mjs");
    const outer = readIntegration("run-scenarios.mjs");
    for (const phase of ["trace-terminal", "trace-settlement"]) {
      expect(scenario).toContain(`recordInteractivePhase("${phase}")`);
      expect(authority).toContain(`"integration.fixture.codex-${phase}"`);
    }
    for (const phase of [
      "hook-command-timeout",
      "hook-command-spawn-error",
      "hook-command-stdin-error",
      "hook-command-wait-error",
      "hook-command-missing",
      "hook-command-completed-before-budget-boundary",
      "hook-command-completed-near-budget-boundary",
      "hook-no-operational-state-subsecond",
      "hook-no-operational-state-low-latency",
      "hook-no-operational-state-mid-latency",
      "hook-no-operational-state-high-latency",
      "hook-no-operational-state-near-deadline",
      "hook-start-suppressed",
      "hook-start-deadline",
      "hook-capture-suppressed",
      "hook-capture-deadline",
      "hook-redaction-suppressed",
      "hook-redaction-deadline",
      "hook-routing-no-route",
      "hook-delivery-rejected",
      "hook-delivery-unavailable",
      "hook-delivery-deadline",
      "hook-delivery-unknown",
      "hook-accepted-without-trace",
      "hook-operational-unclassified",
    ]) {
      expect(diagnostic).toContain(`"${phase}"`);
      expect(authority).toContain(`"integration.fixture.codex-${phase}"`);
    }
    expect(scenario).toContain("inspectDiagnosticBeforeDeadline({");
    expect(scenario).toContain("recordTerminalObservationBeforeDeadline({");
    expectCodexNativeBeforeCollectorCompletion(scenario);
    expect(outer).toContain("observeSelectedWriterOtlp(");
    expect(outer).toMatch(
      /await joinCollectorObservations\(\s*plan,\s*joinSignal,\s*deadline,?\s*\)/u,
    );
    expect(scenario).toContain("classifyCodexCollectedChildFailure(");
    const search = diagnostic.indexOf(
      "codexTraceSearchChildFailureCategory(observation)",
    );
    const get = diagnostic.indexOf(
      "codexTraceGetChildFailureCategory(observation)",
    );
    expect(search).toBeGreaterThan(-1);
    expect(get).toBeGreaterThan(search);
    expect(scenario).toContain(
      "const failureObservation = {\n            code,\n            deadlineExpired,\n            signal,\n            stderrBytes: stderr.length,\n            stdoutBytes: stdout.length,\n            maximumBytes: maximumOutput,\n            stderr,\n            stdout,\n          };",
    );
    for (const phase of [
      "trace-await-hook",
      "trace-await-reporter",
      "trace-await-search",
    ])
      expect(scenario).not.toContain(`recordInteractivePhase("${phase}")`);
    expect(authority).toContain("codex-trace-await-");
    const receiptPredicates = authority.slice(
      authority.indexOf("export const ptyExecutionFailurePredicates"),
      authority.indexOf("export const selectInteractiveFailureDiagnostic"),
    );
    expect(receiptPredicates).not.toContain(
      '"integration.fixture.codex-trace-await-',
    );
    expect(runner).toContain("untrustedCodexTraceHint(");
    expect(runner).toContain("integration.runner.untrusted-trace-hint:");
    expect(runner).toContain("retainedCandidateConfigStage(ledger)");
    expect(runner).toContain("integration.runner.untrusted-config-hint:");
    expect(runner).toContain("integration.runner.untrusted-gate-hint:");
    expect(scenario).toContain("codexArmPendingResearchHint(error)");
    expect(outer).toContain(
      "retainCodexResearchDiagnostic(plan, output, receipt, error)",
    );
    expect(outer).toContain("codexResearchDiagnostics.get(plan.runId) ?? null");
    const observerStart = outer.indexOf(
      "const publishOperationFailureDiagnostic =",
    );
    const observerEnd = outer.indexOf(
      "/* eslint-disable complexity",
      observerStart,
    );
    const observer = outer.slice(observerStart, observerEnd);
    expect(observer).toContain("if (bytes.length <= 512) writeSync(2, bytes);");
    expect(observer).toContain("code: knownFailureCode(error)");
    expect(observer).toContain("catch {");
    expect(observer).not.toMatch(/error\.(?:message|stack|name|cause)/u);
    expect(
      outer.slice(0, observerStart) + outer.slice(observerEnd),
    ).not.toContain("writeSync(2,");
    expect(diagnostic).toContain(
      "exitPair(receipt?.exitCode, error?.code, plan.scenarioId)",
    );
    expect(outer).not.toContain("integration.isolation.codex-exit-pair:");
    expect(outer.match(/process\.stderr\.write\(/gu)).toHaveLength(1);
    expect(outer).toContain(
      "if (Buffer.byteLength(output) <= 512) process.stderr.write(output);",
    );
    expect(authority).toContain("extractUntrustedCodexConfigHint");
    expect(authority).toContain("extractUntrustedCodexGateHint");
    const researchCapture = outer.indexOf(
      "retainCodexResearchDiagnostic(plan, output, receipt, error)",
    );
    expect(researchCapture).toBeLessThan(
      outer.indexOf("recordInteractiveExecutionFailure(", researchCapture),
    );
    expect(scenario).not.toContain("classifyCodexSettledTraceObservation");
    expect(scenario).toContain("sessionId: codexSessionId,");
    for (const phase of ["hook-missing", "hook-failed", "hook-completed"])
      expect(authority).not.toContain(`"integration.fixture.codex-${phase}"`);
    expect(authority).not.toContain('"integration.fixture.codex-trace"');
  });

  it("keeps post-failure Codex hook snapshots outside gate admission", () => {
    const runner = readIntegration("runner.mjs");
    expect(runner).toContain(
      'encodeAdapterReportedFailureMarker,\n  failedCodexSessionStartHint,\n} from "./codex-pty-research.mjs"',
    );
    expect(runner).not.toContain('from "./codex-runtime-evidence.mjs"');
    expect(runner).toContain(
      '"integration.fixture.codex-model-gate-arm-health-pending"',
    );
    expect(runner).toContain("failedCodexSessionStartHint(home)");
    expect(runner).toContain("integration.runner.untrusted-pty-hint:");
    const selectedPtyBoundary = runner.slice(
      runner.indexOf("let receipt;"),
      runner.indexOf("const returnedAtMs = performance.now();"),
    );
    expect(selectedPtyBoundary).toContain(
      "receipt = await executeSelectedPtyProcess(headlessCapability, {",
    );
    expect(selectedPtyBoundary).toContain("readPtyReconciliationStage(error)");
    expect(selectedPtyBoundary).toContain("throw error;");
    expect(runner.split("codexArmPtyResearchHint(")).toHaveLength(2);
    const otherInteractiveFailures = runner.slice(
      runner.indexOf("const returnedAtMs = performance.now();"),
      runner.indexOf(
        'if (scenario.executionMode === "interactive" && fixtureFailure !== undefined)',
      ),
    );
    expect(otherInteractiveFailures).not.toContain("codexArmPtyResearchHint");
    expect(runner).toContain(
      'if (scenario.executionMode === "interactive" && fixtureFailure !== undefined)',
    );
    expect(runner.indexOf("failedCodexSessionStartHint(home)")).toBeGreaterThan(
      runner.indexOf(
        'if (scenario.executionMode === "interactive" && fixtureFailure !== undefined)',
      ),
    );
  });

  it("stores optional Codex research hints only in retired-failure evidence", () => {
    const source = readIntegration("run-scenarios.mjs");
    expect(source).toContain("codexResearchDiagnostics.set(");
    expect(source).toContain("createCodexFailureResearchRecord(");
    expect(source).toContain(
      'if (plan.scenarioId !== "codex-tui-trace-smoke") return;',
    );
    const diagnostic = readIntegration("codex-trace-child-diagnostics.mjs");
    expect(diagnostic).toContain("untrustedGateHint: gate(output) ?? null");
    expect(diagnostic).toContain("untrustedPtyHint: pty(output) ?? null");
    const research = readIntegration("codex-pty-research.mjs");
    expect(research).toContain(
      "export const codexResearchDependencies = Object.freeze([\n  extractUntrustedCodexConfigHint,\n  extractUntrustedCodexGateHint,\n  extractUntrustedCodexPtyHint,\n  projectUntrustedCodexPtyReceipt,\n  extractAdapterReportedFailure,\n  codexFailureExitPair,\n]);",
    );
    expect(source).toContain(
      "codexResearchDiagnostic: codexResearchDiagnostics.get(plan.runId) ?? null",
    );
    expect(source).toContain('controllerOutcome: "retired-failure"');
    expect(source).not.toContain(
      "integration.isolation.untrusted-config-hint:",
    );
    expect(source).not.toContain("integration.isolation.codex-exit-pair:");
  });

  it("validates the failed PTY receipt before reporting a Codex join subtype", () => {
    const controller = readIntegration("run-scenarios.mjs");
    const receipt = controller.indexOf(
      "const receipt = captureAvailableFailedScenarioReceipt(",
    );
    const decode = controller.indexOf(
      "? decodeInteractiveFailureExitCode(receipt.exitCode, plan.scenarioId)",
    );
    const report = controller.indexOf(
      "recordInteractiveExecutionFailure(",
      decode,
    );
    expect(receipt).toBeGreaterThan(-1);
    expect(controller).toContain("? captureFailedScenarioReceipt(");
    expect(controller).toContain("interactivePtyReceiptAuthorityMatches(");
    expect(controller).toContain(
      "envelope: interactivePtyEnvelopeMatches(receipt, plan, expected, failed)",
    );
    expect(controller).toContain(
      "fingerprint: interactivePtyFingerprintMatches(receipt)",
    );
    expect(controller).toContain(
      "{ outerMonotonicDeadline },\n          true,",
    );
    expect(decode).toBeGreaterThan(receipt);
    expect(report).toBeGreaterThan(decode);
    expect(controller).toContain("receipt.exitCode === error?.code");
  });

  it("gives only interactive fixtures one exact capable terminal identity", () => {
    const scenarios = readIntegration("run-scenarios.mjs");
    const runner = readIntegration("runner.mjs");
    expect(scenarios).toContain(
      '...(plan.executionMode === "interactive" ? { TERM: "xterm-256color" } : {})',
    );
    expect(runner).toContain(
      '...(scenario.executionMode === "interactive"\n      ? { TERM: "xterm-256color" }\n      : {})',
    );
    expect(scenarios.match(/TERM: "xterm-256color"/gu)).toHaveLength(1);
    expect(runner.match(/TERM: "xterm-256color"/gu)).toHaveLength(1);
  });

  it("reserves the terminal controller window for Docker cleanup only", () => {
    const source = readIntegration("run-scenarios.mjs");
    expect(source).toContain(
      "remainingIntegrationOperationMilliseconds(30_000, true)",
    );
    expect(source).toContain("terminal: true");
    expect(source).toContain(
      "remainingIntegrationOperationMilliseconds(\n        scenarioTimeoutMilliseconds,\n        terminal,\n      )",
    );
  });

  it("does not reset a scenario deadline after preparation", () => {
    const source = readIntegration("run-scenarios.mjs");
    expect(source).toContain(
      "const scenarioDeadline = performance.now() + scenarioTimeoutMilliseconds;",
    );
    expect(source).toContain(
      "runScenario(selectedPlan, signal, scenarioDeadline)",
    );
    expect(source).toContain("scenarioDeadline - performance.now()");
    expect(source).not.toContain(
      "const remainingOuterMilliseconds = Math.min(\n    scenarioTimeoutMilliseconds,",
    );
  });

  it("uses distinct closed npm configuration files for offline harness installation", () => {
    const source = readIntegration("run-scenarios.mjs");
    expect(source).toContain(
      '"--userconfig=/opt/agentscope/harness/npm-userconfig", "--globalconfig=/opt/agentscope/harness/npm-globalconfig"',
    );
    expect(source).toContain('resolve(context, "harness/npm-userconfig")');
    expect(source).toContain('resolve(context, "harness/npm-globalconfig")');
    expect(source).not.toContain(
      '"--userconfig=/dev/null", "--globalconfig=/dev/null"',
    );
  });

  it.each([0o600, 0o644, 0o444] as const)(
    "settles exact file mode %s despite a restrictive umask",
    (mode) => {
      const directory = mkdtempSync(
        resolve(tmpdir(), "agentscope-npm-config-"),
      );
      const target = resolve(directory, "npm-userconfig");
      const priorUmask = process.umask(0o777);
      try {
        writeExactRegularFile(target, Buffer.alloc(0), mode);
        const status = lstatSync(target);
        expect(status.isFile()).toBe(true);
        expect(status.isSymbolicLink()).toBe(false);
        expect(status.size).toBe(0);
        expect(status.mode & 0o777).toBe(mode);
      } finally {
        process.umask(priorUmask);
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );
  it("stages the actual read-only collector CA caller without relaxing exclusive file identity", () => {
    const source = readIntegration("run-scenarios.mjs");
    const start = source.indexOf(
      "  if (gateCapableMockServer)\n    writeExactRegularFile(",
    );
    const end = source.indexOf("  stageEsmPackageBoundary(context);", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const directory = mkdtempSync(
      resolve(tmpdir(), "agentscope-collector-ca-"),
    );
    const target = resolve(directory, "collector-ca.pem");
    const collectorCa = "synthetic-public-test-ca\n";
    try {
      runInNewContext(source.slice(start, end), {
        gateCapableMockServer: true,
        writeExactRegularFile,
        resolve,
        context: directory,
        Buffer,
        collectorCa,
      });
      expect(readFileSync(target, "utf8")).toBe(collectorCa);
      expect(lstatSync(target).mode & 0o777).toBe(0o444);
      expect(() => {
        writeExactRegularFile(target, Buffer.from("replacement"), 0o444);
      }).toThrow();
      expect(readFileSync(target, "utf8")).toBe(collectorCa);
      const alias = resolve(directory, "alias");
      symlinkSync(target, alias);
      expect(() => {
        writeExactRegularFile(alias, Buffer.alloc(0), 0o444);
      }).toThrow();
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      for (const mode of [0o400, 0o440, 0o555, 0o666, 0o777]) {
        const unsupported = resolve(directory, `unsupported-${mode}`);
        expect(() => {
          Reflect.apply(writeExactRegularFile, undefined, [
            unsupported,
            Buffer.alloc(0),
            mode,
          ]);
        }).toThrow("integration.isolation.context");
        expect(existsSync(unsupported)).toBe(false);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// eslint-disable-next-line max-lines-per-function -- closed diagnostic phase order
describe("Codex interactive diagnostic order", () => {
  // eslint-disable-next-line max-lines-per-function -- closed diagnostic phase order
  it("keeps retained phases in the writer's strict lifecycle order", () => {
    const scenario = readIntegration("codex-pty-scenario.mjs");
    const runner = readIntegration("runner.mjs");
    const diagnostic = readIntegration("codex-trace-child-diagnostics.mjs");
    const expected = [
      "bootstrap",
      "bootstrap-arguments",
      "bootstrap-deadline",
      "bootstrap-readiness",
      "bootstrap-environment",
      "bootstrap-modules",
      "bootstrap-artifact",
      "bootstrap-pty",
      "init",
      "destination",
      "routing",
      "install",
      "model-gate-start",
      "model-gate-configured",
      "control-plane-closed",
      "tui-readiness-challenge-published",
      "tui-start",
      "tui-run-created",
      "tui-checkpoint",
      "model-gate-arm-start",
      "model-gate-arm-health-pending",
      "model-gate-arm-session-start",
      "tui-exit-before-arm",
      "model-gate-arm-complete",
      "model-request-observed",
      "model-request",
      "trace-terminal",
      "tui-exit-published",
      "tui-join-deadline",
      "tui-child-rejected",
      "tui-joined",
      "trace-settlement",
      "trace-search",
      "hook-command-timeout",
      "hook-command-spawn-error",
      "hook-command-stdin-error",
      "hook-command-wait-error",
      "hook-command-missing",
      "hook-command-completed-before-budget-boundary",
      "hook-command-completed-near-budget-boundary",
      "hook-no-operational-state-subsecond",
      "hook-no-operational-state-low-latency",
      "hook-no-operational-state-mid-latency",
      "hook-no-operational-state-high-latency",
      "hook-no-operational-state-near-deadline",
      "hook-start-suppressed",
      "hook-start-deadline",
      "hook-capture-suppressed",
      "hook-capture-deadline",
      "hook-redaction-suppressed",
      "hook-redaction-deadline",
      "hook-routing-no-route",
      "hook-delivery-rejected",
      "hook-delivery-unavailable",
      "hook-delivery-deadline",
      "hook-delivery-unknown",
      "hook-accepted-without-trace",
      "hook-operational-unclassified",
      "trace-search-record-count",
      "trace-search-shape",
      "trace-search-ambiguous",
      "trace-search-harness",
      "trace-search-locator",
      "trace-reporter-settled",
      "trace-search-result",
      "verify",
      "verify-config",
      "verify-gate",
      "verify-trace-get",
      "verify-correlation",
      "verify-doctor",
      "verify-uninstall",
      "verify-status",
      "verify-projection",
      "verify-evidence",
    ];
    const phases = (source: string) => {
      const declaration = source.slice(
        source.indexOf("const interactivePhases = Object.freeze(["),
        source.indexOf("]);", source.indexOf("const interactivePhases")) + 3,
      );
      return [...declaration.matchAll(/^ {2}"([a-z-]+)",$/gmu)].map(
        (match) => match[1],
      );
    };
    expect(scenario).toContain(
      '  interactivePhases,\n  classifyCodexCollectedChildFailure,\n} from "./codex-trace-child-diagnostics.mjs";',
    );
    expect(phases(diagnostic)).toEqual(expected);
    expect(runner).toContain(
      'import { interactivePhases } from "./codex-trace-child-diagnostics.mjs";',
    );
    expect(64 + expected.length - 1).toBeLessThan(139);
    for (const phase of expected.slice(expected.indexOf("verify") + 1)) {
      if (!["verify-trace-get", "verify-correlation"].includes(phase))
        expect(scenario).toContain(`recordInteractivePhase("${phase}")`);
    }
    expect(scenario).toContain(
      "if (phaseIndex <= interactiveFailurePhaseIndex)",
    );
    expect(scenario).not.toContain("recordInteractivePhase(classification)");
    expectCodexNativeBeforeCollectorCompletion(scenario);
    const modelRequestObservation = scenario.indexOf(
      "await waitForModelRequestBeforeDeadline({",
    );
    const modelRequestPhase = scenario.indexOf(
      'recordInteractivePhase("model-request")',
      modelRequestObservation,
    );
    const settlementPhase = scenario.indexOf(
      'recordInteractivePhase("trace-settlement")',
      modelRequestPhase,
    );
    const traceObservation = scenario.indexOf(
      "const translated = translateCodexNativeObservations(",
      modelRequestPhase,
    );
    const terminalLedgerRead = scenario.indexOf(
      "const records = readCodexSessionLedgerRecords(homeDescriptor);",
      scenario.indexOf("const waitForCodexTurnTerminal ="),
    );
    const terminalDeadlinePrecheck = scenario.lastIndexOf(
      "if (bootNow() >= traceDeadline)",
      terminalLedgerRead,
    );
    const terminalObservation = scenario.indexOf(
      "await waitForCodexTurnTerminal(traceDeadline)",
      terminalLedgerRead,
    );
    const sessionCorrelation = scenario.indexOf(
      "sessionId: codexSessionId,",
      terminalObservation,
    );
    expect(modelRequestPhase).toBeGreaterThan(modelRequestObservation);
    expect(terminalDeadlinePrecheck).toBeGreaterThan(-1);
    expect(terminalLedgerRead).toBeGreaterThan(terminalDeadlinePrecheck);
    expect(terminalObservation).toBeGreaterThan(terminalLedgerRead);
    expect(sessionCorrelation).toBeGreaterThan(terminalObservation);
    expect(settlementPhase).toBeGreaterThan(modelRequestPhase);
    expect(traceObservation).toBeGreaterThan(terminalObservation);
    expect(settlementPhase).toBeLessThan(traceObservation);
    for (let index = 0; index < expected.length; index += 1)
      expect(expected.slice(0, index + 1).at(-1)).toBe(expected[index]);
  });
});

describe("integration controller supervision", () => {
  it("kills and proves absence of descendants after the leader exits", async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(resolve(tmpdir(), "agentscope-supervisor-"));
    const evidence = resolve(directory, "descendant.pid");
    try {
      const result = await runSupervisedProcess({
        arguments_: [
          resolve(
            workspaceRoot,
            "tests/integration/fixtures/stubborn-controller-child.mjs",
          ),
        ],
        environment: {
          AGENTSCOPE_SUPERVISOR_EVIDENCE: evidence,
          LANG: "C.UTF-8",
          PATH: "/usr/bin:/bin",
        },
        executable: process.execPath,
        maximumMilliseconds: 5_000,
        stdio: "ignore",
      });
      expect(result).toMatchObject({
        code: 1,
        contained: true,
        residualWorkObserved: true,
      });
      const descendant = Number(readFileSync(evidence, "utf8"));
      expect(() => process.kill(descendant, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("does not upgrade a successful leader with residual work", async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(resolve(tmpdir(), "agentscope-supervisor-"));
    const evidence = resolve(directory, "descendant.pid");
    try {
      const result = await runSupervisedProcess({
        arguments_: [
          resolve(
            workspaceRoot,
            "tests/integration/fixtures/stubborn-controller-child.mjs",
          ),
        ],
        environment: {
          AGENTSCOPE_SUPERVISOR_EVIDENCE: evidence,
          AGENTSCOPE_SUPERVISOR_LEADER_EXIT: "0",
          LANG: "C.UTF-8",
          PATH: "/usr/bin:/bin",
        },
        executable: process.execPath,
        maximumMilliseconds: 5_000,
        stdio: "ignore",
      });
      expect(result).toMatchObject({
        code: 0,
        contained: true,
        residualWorkObserved: true,
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

// The workflow policy inventory is kept in one closed review surface.
// eslint-disable-next-line max-lines-per-function
describe("integration workflow policy", () => {
  // eslint-disable-next-line max-lines-per-function -- one closed workflow and staged-runtime inventory
  it("routes candidate, clean replay, and controlled rejection through one command", () => {
    const workflow = readFileSync(
      resolve(workspaceRoot, ".github/workflows/integration.yml"),
      "utf8",
    );
    for (const [pattern, count] of [
      [/pnpm test:integration/gu, 4],
      [/persist-credentials: false/gu, 5],
      [/NPM_CONFIG_GLOBALCONFIG=.*agentscope-global\.npmrc/gu, 4],
      [/NPM_CONFIG_USERCONFIG=.*agentscope-user\.npmrc/gu, 4],
      [/Initialize closed npm configuration/gu, 4],
      [/AGENTSCOPE_INTEGRATION_OUTER_DEADLINE_MONOTONIC_MS/gu, 4],
    ] as const)
      expect(workflow.match(pattern)).toHaveLength(count);
    expect(workflow).not.toMatch(/\$\{\{ runner\.temp \}\}/gu);
    expect(workflow).not.toMatch(
      /prepare:candidate|prepare:images|prepare:model-routes|run:scenarios|test:integration:clean/gu,
    );
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).not.toContain("if-no-files-found: ignore");
    expect(workflow).toContain("Verify complete sanitized failure evidence");
    expect(workflow).toContain("id: failure_evidence");
    expect(workflow).toContain(
      "if: failure() && steps.failure_evidence.outcome == 'success'",
    );
    expect(workflow).toContain(
      "artifacts/integration/controller-failure-manifest.json",
    );
    expect(workflow).toContain(
      "artifacts/integration/runs/*/controller-failure.json",
    );
    expect(workflow).toContain("replay: [1, 2, 3]");
    expect(workflow).toContain(
      "node tests/integration/verify-substrate-certification.mjs failure",
    );
    expect(workflow).toContain("continue-on-error: true");
    expect(workflow).toContain(
      'test "$CONTROLLED_REJECTION_OUTCOME" = failure',
    );
    expect(workflow).toContain(
      "node tests/integration/verify-substrate-certification.mjs negative",
    );
    expect(workflow).toContain(
      "export OPENAI_API_KEY=AGENTSCOPE_SYNTHETIC_CANARY",
    );
    expect(workflow).toContain(
      "artifacts/integration/controller-preflight-failure.json",
    );
    expect(workflow).toContain(
      "node tests/integration/verify-substrate-certification.mjs fan-in",
    );
    expect(workflow).toContain(
      "run: pnpm --filter '@agentscope/integration...' build",
    );
    expect(workflow).not.toContain(
      "run: pnpm --filter @agentscope/integration build",
    );
    for (const certificationCase of SUBSTRATE_CERTIFICATION_CASES)
      expect(workflow).toContain(`          - ${certificationCase}`);
    const scenarios = readIntegration("run-scenarios.mjs");
    const exactFile = readIntegration("exact-file.mjs");
    const finalized = scenarios.indexOf(
      "finalizeControllerFailureEvidence(plan",
    );
    const required = scenarios.indexOf(
      "requireIntegrationFailureEvidence(plans.map",
    );
    const propagated = scenarios.indexOf("throw primaryError");
    const manifest = scenarios.lastIndexOf("publishControllerFailureManifest");
    const readinessReleased = scenarios.lastIndexOf("fixtureResults.delete");
    expect(scenarios).toContain(
      '({ stdout } = await dockerWithSignal(\n      ["start", "--attach", plan.scenarioName],\n      signal,\n    ))',
    );
    expect(scenarios).toContain(
      "terminalMutationProved = await proveFailedAttachSettled(",
    );
    const attachStart = scenarios.indexOf(
      '({ stdout } = await dockerWithSignal(\n      ["start", "--attach", plan.scenarioName]',
    );
    const attachCatch = scenarios.indexOf("  } catch (error) {", attachStart);
    const successfulReceipt = scenarios.indexOf(
      '  const receipt =\n    plan.executionMode === "interactive"',
      attachCatch,
    );
    const rejectedAttachProof = scenarios.indexOf(
      "terminalMutationProved = await proveFailedAttachSettled(",
      attachCatch,
    );
    const rejectedAttachOutput = scenarios.indexOf(
      'const output = `${error?.stdout ?? ""}`;',
      attachCatch,
    );
    expect(attachStart).toBeGreaterThan(-1);
    expect(attachCatch).toBeGreaterThan(attachStart);
    expect(successfulReceipt).toBeGreaterThan(attachCatch);
    expect(rejectedAttachProof).toBeGreaterThan(attachCatch);
    expect(rejectedAttachOutput).toBeGreaterThan(rejectedAttachProof);
    expect(
      scenarios
        .slice(attachStart, attachCatch)
        .includes("captureHeadlessReceipt"),
    ).toBe(false);
    expect(scenarios).toContain('["container", "wait", containerId]');
    expect(scenarios).toContain('["container", "inspect", containerId]');
    expect(scenarios).toContain('"COPY dist ./dist"');
    expect(scenarios).toContain(
      'const packageBoundaryPath = resolve(context, "dist/package.json")',
    );
    expect(scenarios).toContain(
      "writeExactRegularFile(packageBoundaryPath, packageBoundaryBytes, 0o644)",
    );
    expect(exactFile).toContain("fchmodSync(descriptor, mode)");
    expect(exactFile).toContain("constants.O_NOFOLLOW");
    expect(exactFile).toContain("descriptorStatus.ino !== pathStatus.ino");
    expect(scenarios.indexOf('"COPY dist ./dist"')).toBeLessThan(
      scenarios.indexOf('"USER node"'),
    );
    expect(required).toBeGreaterThanOrEqual(0);
    expect(scenarios.match(/process\.stderr\.write\(/gu)).toHaveLength(1);
    expect(scenarios).toContain(
      "if (Buffer.byteLength(output) <= 512) process.stderr.write(output);",
    );
    expect(finalized).toBeGreaterThan(required);
    expect(manifest).toBeGreaterThan(finalized);
    expect(readinessReleased).toBeGreaterThan(manifest);
    expect(finalized).toBeGreaterThanOrEqual(0);
    expect(propagated).toBeGreaterThan(finalized);
  });

  it("rejects partial current-run failure evidence before upload", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "agentscope-evidence-"));
    const artifacts = resolve(directory, "artifacts/integration");
    const runIds = ["0123456789abcdef", "fedcba9876543210"].sort();
    try {
      const failureEvidence = runIds.map((runId) => {
        const run = resolve(artifacts, "runs", runId);
        mkdirSync(run, { recursive: true, mode: 0o700 });
        const path = resolve(run, "controller-failure.json");
        const content = `${JSON.stringify({
          controllerFailureEvidenceVersion: 3,
          runId,
          certificationCase: null,
          certificationPredicate: null,
          certificationReadiness: null,
          scenarioOutcome: "not-complete",
          controllerOutcome: "retired-failure",
          primaryFailure: "integration.controller.failed",
          causalFailure: null,
          cleanupFailure: null,
          installedPtyFailure: null,
          codexResearchDiagnostic: null,
          privateCleanup: null,
        })}\n`;
        writeFileSync(path, content, { mode: 0o600 });
        const status = lstatSync(path);
        return {
          dev: status.dev,
          digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
          ino: status.ino,
          runId,
          size: status.size,
        };
      });
      writeFileSync(
        resolve(artifacts, "controller-failure-manifest.json"),
        `${JSON.stringify({
          controllerFailureManifestVersion: 1,
          controllerAuthorityDigest: `sha256:${"a".repeat(64)}`,
          certificationCase: null,
          preparedAuthorityDigests: {
            buildkitImage: `sha256:${"b".repeat(64)}`,
            buildkitPlatform: `sha256:${"c".repeat(64)}`,
            daemon: `sha256:${"d".repeat(64)}`,
            images: `sha256:${"e".repeat(64)}`,
            socket: `sha256:${"f".repeat(64)}`,
          },
          runIds,
          failureEvidence,
        })}\n`,
        { mode: 0o600 },
      );
      expect(
        spawnSync(
          process.execPath,
          [
            resolve(
              workspaceRoot,
              "tests/integration/verify-substrate-certification.mjs",
            ),
            "failure",
          ],
          { cwd: directory },
        ).status,
      ).toBe(0);
      rmSync(resolve(artifacts, "runs", runIds[1]!), {
        recursive: true,
      });
      expect(
        spawnSync(
          process.execPath,
          [
            resolve(
              workspaceRoot,
              "tests/integration/verify-substrate-certification.mjs",
            ),
            "failure",
          ],
          { cwd: directory },
        ).status,
      ).not.toBe(0);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("accepts only exact pre-mutation credential rejection evidence", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "agentscope-preflight-"));
    const artifacts = resolve(directory, "artifacts/integration");
    const githubSha = "d".repeat(40);
    const evidence = {
      certificationCase: "credential-presence",
      certificationPredicate: "credential-environment",
      controllerPreflightFailureVersion: 1,
      githubSha,
      mutationAuthority: "not-created",
      primaryFailure: "integration.controller.provider-credentials",
    };
    try {
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(
        resolve(artifacts, "controller-preflight-failure.json"),
        `${JSON.stringify(evidence)}\n`,
        { mode: 0o600 },
      );
      const verify = () =>
        spawnSync(
          process.execPath,
          [
            resolve(
              workspaceRoot,
              "tests/integration/verify-substrate-certification.mjs",
            ),
            "negative",
          ],
          {
            cwd: directory,
            env: {
              AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE: "credential-presence",
              GITHUB_SHA: githubSha,
              PATH: process.env.PATH,
            },
          },
        ).status;
      expect(verify()).toBe(0);
      mkdirSync(resolve(artifacts, "runs"));
      expect(verify()).not.toBe(0);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  // Each case retains the full ordered mutation setup on the same held file
  // identities, but launches only its selected real verifier under default 5s.
  it.each([
    [1, "scenario retirement"],
    [2, "bounded research observation"],
    [3, "research hint privacy"],
    [4, "research exit refusal"],
    [5, "missing cleanup"],
    [6, "scenario success refusal"],
    [7, "scenario daemon substitution"],
    [8, "builder retirement"],
    [9, "settled failure"],
    [10, "settled negative refusal"],
    [11, "settled success refusal"],
    [12, "settled retired-success refusal"],
    [13, "settled unknown refusal"],
    [14, "settled resource count"],
    [15, "settled response truncation"],
    [16, "settled response bound"],
    [17, "settled resource digest"],
    [18, "settled generation"],
    [19, "settled process output bound"],
    [20, "retired generation"],
    [21, "retired resource count"],
    [22, "retired response truncation"],
    [23, "retired resource digest"],
    [24, "witnessed wrong argv"],
    [25, "unwitnessed wrong argv"],
    [26, "shared settled failure"],
    [27, "shared negative refusal"],
    [28, "shared foreign owner"],
    [29, "shared crossed builder"],
    [30, "shared crossed resources"],
    [31, "shared rehashed recipient identity"],
    [32, "shared duplicate recipient"],
  ] as const)(
    "separates retirement and certification: %s %s",
    // eslint-disable-next-line max-lines-per-function
    (caseNumber, _caseName) => {
      const directory = mkdtempSync(
        resolve(tmpdir(), "agentscope-retirement-"),
      );
      const artifacts = resolve(directory, "artifacts/integration");
      const runId = "0123456789abcdef";
      const run = resolve(artifacts, "runs", runId);
      const diagnostic = {
        diagnosticVersion: 1,
        stage: "scenario-operation",
        authorityDigests: {
          daemon: `sha256:${"a".repeat(64)}`,
          images: `sha256:${"b".repeat(64)}`,
          socket: `sha256:${"c".repeat(64)}`,
        },
        outcome: "retired-failure",
        retirementReason: "mutation-outcome-unknown",
      };
      const preparedAuthorityDigests = {
        buildkitImage: `sha256:${"d".repeat(64)}`,
        buildkitPlatform: `sha256:${"e".repeat(64)}`,
        daemon: diagnostic.authorityDigests.daemon,
        images: diagnostic.authorityDigests.images,
        socket: diagnostic.authorityDigests.socket,
      };
      const writeEvidence = (
        privateCleanup: unknown,
        certification = {
          certificationCase: null as string | null,
          certificationPredicate: null as string | null,
          primaryFailure: "integration.controller.unsettled-operation",
        },
        codexResearchDiagnostic: unknown = null,
        runIds = [runId],
      ) => {
        const failureEvidence = runIds.map((recipientRunId) => {
          const recipient = resolve(artifacts, "runs", recipientRunId);
          mkdirSync(recipient, { recursive: true, mode: 0o700 });
          const content = `${JSON.stringify({
            controllerFailureEvidenceVersion: 3,
            runId: recipientRunId,
            certificationCase: certification.certificationCase,
            certificationPredicate: certification.certificationPredicate,
            certificationReadiness: null,
            scenarioOutcome: "failed",
            controllerOutcome: "retired-failure",
            primaryFailure: certification.primaryFailure,
            causalFailure: null,
            cleanupFailure: null,
            installedPtyFailure: null,
            codexResearchDiagnostic,
            privateCleanup,
          })}\n`;
          writeFileSync(
            resolve(recipient, "controller-failure.json"),
            content,
            {
              mode: 0o600,
            },
          );
          const status = lstatSync(
            resolve(recipient, "controller-failure.json"),
          );
          return {
            dev: status.dev,
            digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
            ino: status.ino,
            runId: recipientRunId,
            size: status.size,
          };
        });
        writeFileSync(
          resolve(artifacts, "controller-failure-manifest.json"),
          `${JSON.stringify({
            controllerFailureManifestVersion: 1,
            controllerAuthorityDigest: `sha256:${"d".repeat(64)}`,
            certificationCase: certification.certificationCase,
            preparedAuthorityDigests,
            runIds: [...runIds].sort(),
            failureEvidence: failureEvidence.sort((left, right) =>
              left.runId.localeCompare(right.runId),
            ),
          })}\n`,
          { mode: 0o600 },
        );
      };
      const verify = (mode = "failure", certificationCase?: string) =>
        spawnSync(
          process.execPath,
          [
            resolve(
              workspaceRoot,
              "tests/integration/verify-substrate-certification.mjs",
            ),
            mode,
          ],
          {
            cwd: directory,
            env: {
              ...(certificationCase === undefined
                ? {}
                : {
                    AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE: certificationCase,
                  }),
              PATH: process.env.PATH,
            },
          },
        ).status;
      let vectorNumber = 0;
      let executed = 0;
      const checkVerification = (
        success: boolean,
        mode = "failure",
        certificationCase?: string,
      ) => {
        vectorNumber += 1;
        if (vectorNumber !== caseNumber) return;
        executed += 1;
        const status = verify(mode, certificationCase);
        if (success) expect(status).toBe(0);
        else expect(status).not.toBe(0);
      };
      try {
        mkdirSync(run, { recursive: true, mode: 0o700 });
        writeEvidence(diagnostic);
        checkVerification(true);
        writeEvidence(diagnostic, undefined, {
          diagnosticVersion: 1,
          untrustedConfigHint: "render",
          exitPair: "150:78",
        });
        checkVerification(true);
        writeEvidence(diagnostic, undefined, {
          diagnosticVersion: 1,
          untrustedConfigHint: "render:secret",
          exitPair: "150:78",
        });
        checkVerification(false);
        writeEvidence(diagnostic, undefined, {
          diagnosticVersion: 1,
          untrustedConfigHint: "render",
          exitPair: "150:0",
        });
        checkVerification(false);
        writeEvidence(null);
        checkVerification(false);
        writeEvidence({ ...diagnostic, outcome: "retired-success" });
        checkVerification(false);
        writeEvidence({
          ...diagnostic,
          authorityDigests: {
            ...diagnostic.authorityDigests,
            daemon: `sha256:${"f".repeat(64)}`,
          },
        });
        checkVerification(false);
        const digestJson = (value: unknown) =>
          `sha256:${createHash("sha256")
            .update(JSON.stringify(value))
            .digest("hex")}`;
        const builderCleanup = {
          diagnosticVersion: 1,
          stage: "builder-reconciliation",
          operationKind: "image-build",
          identityDigests: {
            builder: digestJson(`agentscope-${runId}`),
            daemon: preparedAuthorityDigests.daemon,
            image: preparedAuthorityDigests.buildkitImage,
            platform: preparedAuthorityDigests.buildkitPlatform,
            runGeneration: digestJson(runId),
          },
          process: {
            observed: true,
            exited: false,
            signaled: true,
            timedOut: true,
            joined: false,
            outputBytes: 1,
            outputTruncated: false,
            stderrClass: "unknown",
          },
          responseBytes: 1,
          responseTruncated: false,
          expectedResourceCount: 2,
          observedResourceCount: 1,
          expectedResourceDigest: digestJson([
            `buildx_buildkit_agentscope-${runId}0`,
            `buildx_buildkit_agentscope-${runId}0_state`,
          ]),
          observedResourceDigest: `sha256:${"f".repeat(64)}`,
          reconciliationReasons: {
            builderContainer: "matched",
            builderVolume: "absent",
            builtTag: "not-observed",
          },
          outcome: "retired-failure",
        };
        writeEvidence(builderCleanup);
        checkVerification(true);
        // rejectSettledBuild records this distinct disposition after reconciliation;
        // the captured process is the first failure, not a successful build result.
        const settledFailure = { ...builderCleanup, outcome: "failed-settled" };
        writeEvidence(settledFailure);
        checkVerification(true);
        checkVerification(false, "negative", "wrong-argv");
        for (const outcome of ["success", "retired-success", "unknown"]) {
          writeEvidence({ ...settledFailure, outcome });
          checkVerification(false);
        }
        for (const substitution of [
          { expectedResourceCount: 3 },
          { responseTruncated: true },
          { responseBytes: 16_777_217 },
          { expectedResourceDigest: `sha256:${"a".repeat(64)}` },
          {
            identityDigests: {
              ...settledFailure.identityDigests,
              runGeneration: `sha256:${"f".repeat(64)}`,
            },
          },
          { process: { ...settledFailure.process, outputBytes: 16_777_217 } },
        ]) {
          writeEvidence({ ...settledFailure, ...substitution });
          checkVerification(false);
        }
        writeEvidence({
          ...builderCleanup,
          identityDigests: {
            ...builderCleanup.identityDigests,
            runGeneration: `sha256:${"f".repeat(64)}`,
          },
        });
        checkVerification(false);
        writeEvidence({ ...builderCleanup, expectedResourceCount: 3 });
        checkVerification(false);
        writeEvidence({ ...builderCleanup, responseTruncated: true });
        checkVerification(false);
        writeEvidence({
          ...builderCleanup,
          expectedResourceDigest: `sha256:${"a".repeat(64)}`,
        });
        checkVerification(false);
        const witnessedWrongArgv = {
          certificationCase: "wrong-argv",
          certificationPredicate: "request-argv-mismatch",
          primaryFailure: "integration.certification.wrong-argv",
        };
        writeEvidence(null, witnessedWrongArgv);
        checkVerification(true, "negative", "wrong-argv");
        writeEvidence(diagnostic, {
          ...witnessedWrongArgv,
          primaryFailure: "integration.controller.unsettled-operation",
        });
        checkVerification(false, "negative", "wrong-argv");
        // One material build belongs to an owned plan, while its shared-client
        // failure is copied into every selected recipient's retained record.
        const recipients = [runId, "1123456789abcdef", "2123456789abcdef"];
        const writeShared = (cleanup: unknown) => {
          writeEvidence(cleanup, undefined, null, recipients);
        };
        writeShared(settledFailure);
        checkVerification(true);
        checkVerification(false, "negative", "wrong-argv");
        for (const substitution of [
          {
            identityDigests: {
              ...settledFailure.identityDigests,
              runGeneration: digestJson("foreign-owner"),
            },
          },
          {
            identityDigests: {
              ...settledFailure.identityDigests,
              builder: digestJson(`agentscope-${recipients[1]}`),
            },
          },
          {
            expectedResourceDigest: digestJson([
              `buildx_buildkit_agentscope-${recipients[1]}0`,
              `buildx_buildkit_agentscope-${recipients[1]}0_state`,
            ]),
          },
        ]) {
          writeShared({ ...settledFailure, ...substitution });
          checkVerification(false);
        }
        writeShared(settledFailure);
        const manifestPath = resolve(
          artifacts,
          "controller-failure-manifest.json",
        );
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          runIds: string[];
          failureEvidence: { runId: string; size: number; digest: string }[];
        };
        const recipientPath = resolve(
          artifacts,
          "runs",
          recipients[1]!,
          "controller-failure.json",
        );
        const recipient = JSON.parse(
          readFileSync(recipientPath, "utf8"),
        ) as Record<string, unknown>;
        recipient.runId = runId;
        const substituted = `${JSON.stringify(recipient)}\n`;
        writeFileSync(recipientPath, substituted);
        const identity = manifest.failureEvidence.find(
          (value) => value.runId === recipients[1],
        )!;
        identity.size = Buffer.byteLength(substituted);
        identity.digest = `sha256:${createHash("sha256").update(substituted).digest("hex")}`;
        writeFileSync(manifestPath, JSON.stringify(manifest));
        checkVerification(false);
        writeShared(settledFailure);
        const duplicated = JSON.parse(
          readFileSync(manifestPath, "utf8"),
        ) as Record<string, unknown>;
        duplicated.runIds = [runId, runId, recipients[2]!];
        writeFileSync(manifestPath, JSON.stringify(duplicated));
        checkVerification(false);
        expect(vectorNumber).toBe(32);
        expect(executed).toBe(1);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );
});
