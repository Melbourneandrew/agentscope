import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  compileDestinationRegistry,
  createDestinationReporter,
  createReporterReceipt,
  defineDestinationDescriptor,
  type ReporterOutcome,
} from "@agentscope/destinations-core";
import { serializeRedactedCanonicalTrace } from "@agentscope/protocol";
import { z } from "zod";

import { withCaptureInvocation } from "../capture/runtime.js";
import type { CapturedTraceCandidate } from "../capture/types.js";
import type { CaptureAdapter } from "../lifecycle.js";
import {
  createAgentscopeHomeResolver,
  ensureAgentscopeHomeLayout,
} from "../configuration/home.js";
import {
  compileCredentialBackendRegistry,
  parseAgentscopeConfiguration,
  serializeAgentscopeConfiguration,
} from "../index.js";
import {
  createConfigurationStore,
  createConfigurationStoreForTesting,
  createConfigurationProcessIdentity,
} from "../configuration/transaction.js";
import {
  createOperationalStateStore,
  createOperationalStateStoreForTesting,
  inspectOperationalState,
} from "../configuration/operational-state.js";
import { redactCapturedTrace } from "../redaction/pipeline.js";
import { runResolvedTraceLifecycle } from "./lifecycle.js";
import {
  BUILTIN_REDACTION_POLICY_REFERENCES,
  compileRedactionPolicyRegistry,
  DEFAULT_REDACTION_POLICY_REGISTRY,
} from "../redaction/policy.js";
import {
  resolveCaptureInvocationSnapshot,
  resolveCaptureInvocationSnapshotForTesting,
  type InvocationPreparationResult,
} from "./snapshot.js";

// End-to-end Core evidence for AC-CAP-001.3, AC-CAP-002.1,
// AC-CAP-002.2, AC-CAP-002.7, AC-GOV-001.1, AC-GOV-001.2,
// AC-GOV-001.3, and AC-GOV-001.5.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const connectionId =
  "destination-connection-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const emptySettings = z.strictObject({});
void emptySettings.shape;
z.toJSONSchema(emptySettings);

const createRuntime = (
  reporterOutcome: ReporterOutcome = "accepted",
  reporterNeverSettles = false,
) => {
  const deliveries: string[] = [];
  const descriptor = defineDestinationDescriptor({
    descriptorVersion: 1,
    destinationType: "@agentscope/destination-test",
    commandName: "test",
    settingsVersion: 1,
    settingsSchema: emptySettings,
    defaultSettings: {},
    credentialSlots: [],
    documentationPath: "/docs/destinations/test",
    deliveryIdentitySupport: "duplicates-possible",
    transport: { kind: "local" },
    createReporter: () =>
      createDestinationReporter({
        report: ({ traces }) => {
          deliveries.push(serializeRedactedCanonicalTrace(traces[0]));
          if (reporterNeverSettles) return new Promise(() => undefined);
          return Promise.resolve(createReporterReceipt(reporterOutcome));
        },
      }),
  });
  return {
    deliveries,
    destinationRegistry: compileDestinationRegistry([descriptor]),
    credentialBackendRegistry: compileCredentialBackendRegistry([]),
    transportExecutor: () => Promise.reject(new Error("unexpected transport")),
  };
};

const fixture = async (
  reference: string,
  selected = true,
  hookDeadlineMilliseconds = 2_000,
  reporterOutcome: ReporterOutcome = "accepted",
  options: Readonly<{
    reporterNeverSettles?: boolean;
    connectionCount?: number;
  }> = {},
) => {
  const runtime = createRuntime(
    reporterOutcome,
    options.reporterNeverSettles ?? false,
  );
  const root = await mkdtemp(join(tmpdir(), "agentscope-invocation-"));
  roots.push(root);
  const home = createAgentscopeHomeResolver({
    environment: { AGENTSCOPE_HOME: join(root, "home") },
    environmentOverrideAuthority: "test",
  })();
  await ensureAgentscopeHomeLayout(home);
  const configuredConnectionIds = Array.from(
    { length: options.connectionCount ?? 1 },
    (_, index) =>
      (index === 0
        ? connectionId
        : `destination-connection-v1-${(index + 10)
            .toString(16)
            .padStart(64, "0")}`) as typeof connectionId,
  );
  const configuration = parseAgentscopeConfiguration(
    {
      configurationVersion: 2,
      generation: 7,
      destinations: {
        "@agentscope/destination-test": {
          namespaceVersion: 1,
          settingsVersion: 1,
          connections: configuredConnectionIds.map(
            (configuredConnectionId, index) => ({
              connectionId: configuredConnectionId,
              name: `test-${index}`,
              settings: {},
              credentialReferences: {},
            }),
          ),
        },
      },
      routing: {
        version: 1,
        selectedConnectionIds: selected ? configuredConnectionIds : [],
        hookDeadlineMilliseconds,
      },
      policy: { version: 1, reference },
    },
    runtime.destinationRegistry,
  );
  await writeFile(
    home.configFile,
    serializeAgentscopeConfiguration(configuration),
    {
      mode: 0o600,
    },
  );
  return {
    ...runtime,
    configuredConnectionIds,
    home,
    store: createConfigurationStore(home, runtime.destinationRegistry),
    operationalStateStore: createOperationalStateStore(
      home,
      createConfigurationProcessIdentity(
        777,
        `process-start-v1-${"7".repeat(64)}`,
      ),
    ),
  };
};

const candidate = (): CapturedTraceCandidate => ({
  captureBoundary: {
    session: {
      kind: "native-session",
      nativeIdentityKind: "thread",
      nativeIdentity: "thread-1",
    },
    boundaryKind: "turn",
    boundaryId: "turn-1",
    generation: 0,
    positionKind: "event-index",
    startPosition: 0,
    exclusiveEndPosition: 1,
  },
  rootContext: { fields: [], unavailable: [] },
  operations: [
    {
      logicalKey: "root",
      locator: { kind: "source-ordinal", ordinal: 0 },
      kind: "AGENT",
      name: "agent-operation",
      nameProvenance: { field: "span.name", source: "native-artifact" },
      timing: {
        basis: "native-interval",
        nativeState: "observed",
        source: "native-artifact",
        startUnixNano: "1",
        endUnixNano: "2",
      },
      fields: [],
      unavailable: [],
      events: [],
      links: [],
    },
  ],
});

const captureCandidate: CaptureAdapter = (factory, _signal, resolver) => {
  if (resolver === undefined) throw new Error("missing checkpoint resolver");
  return factory.capture(resumeCandidate(candidate(), resolver));
};

const resumeCandidate = (
  input: CapturedTraceCandidate,
  resolver: NonNullable<Parameters<CaptureAdapter>[2]>,
  availableStartPosition = 0,
): CapturedTraceCandidate => {
  const boundary = input.captureBoundary;
  if (boundary.session.kind !== "native-session") return input;
  const resume = resolver({
    nativeIdentityKind: boundary.session.nativeIdentityKind,
    nativeIdentity: boundary.session.nativeIdentity,
    sourceGeneration: boundary.generation,
    positionKind: boundary.positionKind,
    availableStartPosition,
  });
  return {
    ...input,
    captureBoundary: {
      ...boundary,
      startPosition: resume.startPosition,
      exclusiveEndPosition: Math.max(
        boundary.exclusiveEndPosition,
        resume.startPosition + 1,
      ),
    },
  };
};

const field = (semantic: string, value: string) => ({
  field: semantic,
  value,
  provenance: { field: semantic, source: "native-artifact" as const },
});

const runWithOperationalStore = async (
  value: Awaited<ReturnType<typeof fixture>>,
  operationalStateStore: ReturnType<
    typeof createOperationalStateStoreForTesting
  >,
  signal?: AbortSignal,
  capture: CaptureAdapter = captureCandidate,
) =>
  runResolvedTraceLifecycle({
    configurationStore: value.store,
    operationalStateStore,
    credentialBackendRegistry: value.credentialBackendRegistry,
    transportExecutor: value.transportExecutor,
    policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
    harnessRegistryId: "codex",
    harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
    hookObservedUnixNano: "100",
    operationIdScope: "session-global",
    workspaceCandidates: [],
    gitExecutable: "/usr/bin/git",
    bootstrapDeadlineMilliseconds: 1_000,
    ...(signal === undefined ? {} : { signal }),
    capture,
  });

const context = Object.freeze({
  fields: Object.freeze([
    {
      field: "agentscope.workspace.directory",
      value: "workspace/project",
      provenance: {
        field: "agentscope.workspace.directory",
        source: "process" as const,
      },
    },
    ...[
      ["agentscope.git.worktree", "workspace/project"],
      ["agentscope.git.repository_root", "workspace/project"],
      ["vcs.ref.head.name", "main"],
      ["vcs.ref.head.revision", "a".repeat(40)],
      ["vcs.ref.type", "branch"],
    ].map(([field, value]) => ({
      field: field!,
      value: value!,
      provenance: { field: field!, source: "git" as const },
    })),
  ]),
  unavailable: Object.freeze([]),
});

const resolve = async (
  store: ReturnType<typeof createConfigurationStore>,
  bootstrapDeadlineMilliseconds = 1_000,
  contextResolver: Parameters<
    typeof resolveCaptureInvocationSnapshotForTesting
  >[0]["contextResolver"] = () => Promise.resolve(context),
): Promise<InvocationPreparationResult> =>
  resolveCaptureInvocationSnapshotForTesting({
    configurationStore: store,
    policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
    harnessRegistryId: "codex",
    harnessVersion: {
      state: "observed",
      value: "1.2.3",
      source: "process",
    },
    hookObservedUnixNano: "100",
    operationIdScope: "session-global",
    workspaceCandidates: [],
    gitExecutable: "/usr/bin/git",
    bootstrapDeadlineMilliseconds,
    contextResolver,
  });

const delayedConfigurationStore = (
  home: Parameters<typeof createConfigurationStoreForTesting>[0],
  registry: Parameters<typeof createConfigurationStoreForTesting>[1],
  delayMilliseconds: number,
  continued: () => void = () => undefined,
) => {
  const readForHook = (
    file: string,
    signal: AbortSignal,
  ): Promise<string | undefined> =>
    new Promise((resolveRead, rejectRead) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        rejectRead(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        continued();
        void readFile(file, "utf8").then(resolveRead, rejectRead);
      }, delayMilliseconds);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  return createConfigurationStoreForTesting(home, registry, {
    fileSystem: { open, rename, unlink },
    readForHook,
  });
};

describe("immutable capture invocation snapshot", () => {
  it("binds one configuration, policy, and Git context through finalization", async () => {
    const value = await fixture(BUILTIN_REDACTION_POLICY_REFERENCES.baseline);
    const result = await resolve(value.store);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected snapshot");
    expect(result.snapshot.configuration.generation).toBe(7);
    expect(result.snapshot.invocation.snapshot.configurationIdentity).toMatch(
      /^configuration-v1-sha256-/u,
    );
    expect(result.snapshot.deadlineProvenance).toEqual({
      bootstrapDeadlineMilliseconds: 1_000,
      configuredDeadlineMilliseconds: 2_000,
      effectiveDeadlineMilliseconds: 1_000,
    });
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    const captured = await withCaptureInvocation(
      result.snapshot.invocation,
      (factory) => factory.capture(candidate()),
    );
    const serialized = serializeRedactedCanonicalTrace(
      redactCapturedTrace(captured),
    );
    expect(serialized).toContain("main");
    expect(serialized).toContain("agentscope.redaction.effective.v1.baseline");
  });
});

describe("capture invocation preparation failure closure", () => {
  it("returns fixed content-free failures for invalid policy and expiry", async () => {
    const value = await fixture("unknown-policy");
    const invalid = await resolve(value.store);
    expect(invalid).toEqual({
      ok: false,
      outcome: "failed-open",
      stage: "policy",
      code: "policy-unavailable",
      diagnostic: {
        code: "policy-unavailable",
        severity: "warning",
        configurationGeneration: 7,
      },
    });
    expect(JSON.stringify(invalid)).not.toContain("unknown-policy");
    const expired = await resolve(value.store, 0);
    expect(expired).toMatchObject({
      ok: false,
      outcome: "failed-open",
      code: "deadline-exceeded",
    });
    await expect(
      resolve(value.store, Number.POSITIVE_INFINITY),
    ).resolves.toMatchObject({
      stage: "configuration",
      code: "deadline-exceeded",
    });
    await expect(resolve(value.store, 60_001)).resolves.toMatchObject({
      stage: "configuration",
      code: "deadline-exceeded",
    });
    await expect(
      resolveCaptureInvocationSnapshotForTesting({
        configurationStore: value.store,
        policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
        harnessRegistryId: "codex",
        harnessVersion: {
          state: "observed",
          value: "1.2.3",
          source: "process",
        },
        hookObservedUnixNano: "100",
        operationIdScope: "session-global",
        workspaceCandidates: [],
        gitExecutable: "/usr/bin/git",
        bootstrapDeadlineMilliseconds: 1_000,
        signal: Object.defineProperty({}, "aborted", {
          get: () => {
            throw new Error("CANARY_SECRET");
          },
        }) as AbortSignal,
        contextResolver: () => Promise.resolve(context),
      }),
    ).resolves.toMatchObject({
      stage: "configuration",
      code: "deadline-exceeded",
    });
  });

  it("closes every deadline and context-resolution failure boundary", async () => {
    const value = await fixture(BUILTIN_REDACTION_POLICY_REFERENCES.baseline);
    const result = await resolve(value.store, 1_000, async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_050));
      return context;
    });
    expect(result).toMatchObject({
      outcome: "failed-open",
      stage: "context",
      code: "deadline-exceeded",
    });
    await expect(
      resolve(value.store, 1_000, () =>
        Promise.reject(new Error("CANARY_SECRET")),
      ),
    ).resolves.toMatchObject({
      outcome: "failed-open",
      stage: "context",
      code: "context-unavailable",
    });
    await expect(
      resolveCaptureInvocationSnapshotForTesting(
        new Proxy({} as never, {
          get(_target, property) {
            if (property === "contextResolver")
              throw new Error("CANARY_SECRET");
            return undefined;
          },
        }),
      ),
    ).resolves.toMatchObject({
      stage: "configuration",
      code: "configuration-unavailable",
    });
  });
});

describe("capture invocation signal race closure", () => {
  it("detects cancellation between configuration listener checks", async () => {
    const value = await fixture(BUILTIN_REDACTION_POLICY_REFERENCES.baseline);
    let abortedReads = 0;
    const racingSignal = {
      get aborted() {
        abortedReads += 1;
        return abortedReads >= 3;
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;
    await expect(
      resolveCaptureInvocationSnapshotForTesting({
        configurationStore: value.store,
        policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
        harnessRegistryId: "codex",
        harnessVersion: {
          state: "observed",
          value: "1.2.3",
          source: "process",
        },
        hookObservedUnixNano: "100",
        operationIdScope: "session-global",
        workspaceCandidates: [],
        gitExecutable: "/usr/bin/git",
        bootstrapDeadlineMilliseconds: 1_000,
        signal: racingSignal,
        contextResolver: () => Promise.resolve(context),
      }),
    ).resolves.toMatchObject({
      stage: "configuration",
      code: "deadline-exceeded",
    });
  });
});

describe("configured capture deadline", () => {
  it("creates the bootstrap deadline before configuration I/O", async () => {
    const value = await fixture(BUILTIN_REDACTION_POLICY_REFERENCES.baseline);
    let configurationReadContinued = false;
    const slowStore = delayedConfigurationStore(
      value.home,
      value.destinationRegistry,
      75,
      () => {
        configurationReadContinued = true;
      },
    );
    await expect(resolve(slowStore, 50)).resolves.toMatchObject({
      outcome: "failed-open",
      stage: "configuration",
      code: "deadline-exceeded",
    });
    expect(configurationReadContinued).toBe(false);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    expect(configurationReadContinued).toBe(false);
  });

  it("contains cancellation and hostile signals during configuration I/O", async () => {
    const value = await fixture(BUILTIN_REDACTION_POLICY_REFERENCES.baseline);
    const slowStore = delayedConfigurationStore(
      value.home,
      value.destinationRegistry,
      75,
    );
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 10);
    await expect(
      resolveCaptureInvocationSnapshotForTesting({
        configurationStore: slowStore,
        policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
        harnessRegistryId: "codex",
        harnessVersion: {
          state: "observed",
          value: "1.2.3",
          source: "process",
        },
        hookObservedUnixNano: "100",
        operationIdScope: "session-global",
        workspaceCandidates: [],
        gitExecutable: "/usr/bin/git",
        bootstrapDeadlineMilliseconds: 1_000,
        signal: controller.signal,
        contextResolver: () => Promise.resolve(context),
      }),
    ).resolves.toMatchObject({
      stage: "configuration",
      code: "deadline-exceeded",
    });
    const hostileSignal = {
      aborted: false,
      addEventListener() {
        throw new Error("CANARY_SECRET");
      },
      removeEventListener() {},
    } as unknown as AbortSignal;
    await expect(
      resolveCaptureInvocationSnapshotForTesting({
        configurationStore: value.store,
        policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
        harnessRegistryId: "codex",
        harnessVersion: {
          state: "observed",
          value: "1.2.3",
          source: "process",
        },
        hookObservedUnixNano: "100",
        operationIdScope: "session-global",
        workspaceCandidates: [],
        gitExecutable: "/usr/bin/git",
        bootstrapDeadlineMilliseconds: 1_000,
        signal: hostileSignal,
        contextResolver: () => Promise.resolve(context),
      }),
    ).resolves.toMatchObject({
      stage: "configuration",
      code: "deadline-exceeded",
    });
  });

  it("applies configured expiry from the original entry instant", async () => {
    const value = await fixture(
      BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
      true,
      50,
    );
    const slowStore = delayedConfigurationStore(
      value.home,
      value.destinationRegistry,
      60,
    );
    await expect(resolve(slowStore, 1_000)).resolves.toMatchObject({
      stage: "configuration",
      code: "deadline-exceeded",
    });
  });

  it("measures the configured deadline from preparation entry", async () => {
    const value = await fixture(
      BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
      true,
      50,
    );
    const result = await resolve(value.store, 1_000, async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
      return context;
    });
    expect(result).toMatchObject({
      outcome: "failed-open",
      stage: "context",
      code: "deadline-exceeded",
    });
  });
});

describe("capture invocation configuration failure", () => {
  it("fails open before policy resolution when configuration is missing", async () => {
    const value = await fixture(BUILTIN_REDACTION_POLICY_REFERENCES.baseline);
    await rm(value.home.configFile);
    await expect(resolve(value.store)).resolves.toEqual({
      ok: false,
      outcome: "failed-open",
      stage: "configuration",
      code: "configuration-unavailable",
      diagnostic: {
        code: "configuration-invalid",
        severity: "warning",
        configurationGeneration: null,
      },
    });
  });
});

describe("resolved fail-open trace lifecycle", () => {
  it("contains hostile invocation accessors and enforces remaining-budget stage gates", async () => {
    await expect(
      resolveCaptureInvocationSnapshot(
        new Proxy({} as never, {
          get() {
            throw new Error("CANARY_SECRET");
          },
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      stage: "configuration",
      code: "configuration-unavailable",
    });
    await expect(
      runResolvedTraceLifecycle(
        new Proxy({} as never, {
          get() {
            throw new Error("CANARY_SECRET");
          },
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      outcome: "failed-open",
      stage: "configuration",
      code: "configuration-unavailable",
      diagnostic: {
        code: "configuration-invalid",
        severity: "warning",
        configurationGeneration: null,
      },
    });

    const value = await fixture(BUILTIN_REDACTION_POLICY_REFERENCES.baseline);
    const controller = new AbortController();
    const result = await runResolvedTraceLifecycle({
      configurationStore: value.store,
      operationalStateStore: value.operationalStateStore,
      credentialBackendRegistry: value.credentialBackendRegistry,
      transportExecutor: value.transportExecutor,
      policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
      harnessRegistryId: "codex",
      harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
      hookObservedUnixNano: "100",
      operationIdScope: "session-global",
      workspaceCandidates: [],
      gitExecutable: "/usr/bin/git",
      bootstrapDeadlineMilliseconds: 1_000,
      signal: controller.signal,
      capture(factory, _signal, resolver) {
        if (resolver === undefined) throw new Error("missing resolver");
        const captured = factory.capture(
          resumeCandidate(candidate(), resolver),
        );
        controller.abort();
        return captured;
      },
    });
    expect(result).toMatchObject({
      outcome: "failed-open",
      stage: "redaction",
      reason: "cancelled",
    });
    expect(value.deliveries).toHaveLength(0);

    const hostileCapture = {
      configurationStore: value.store,
      operationalStateStore: value.operationalStateStore,
      credentialBackendRegistry: value.credentialBackendRegistry,
      transportExecutor: value.transportExecutor,
      policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
      harnessRegistryId: "codex" as const,
      harnessVersion: {
        state: "observed" as const,
        value: "1.2.3",
        source: "process" as const,
      },
      hookObservedUnixNano: "100",
      operationIdScope: "session-global" as const,
      workspaceCandidates: [],
      gitExecutable: "/usr/bin/git",
      bootstrapDeadlineMilliseconds: 1_000,
    };
    Object.defineProperty(hostileCapture, "capture", {
      get() {
        throw new Error("CANARY_SECRET");
      },
    });
    await expect(
      runResolvedTraceLifecycle(hostileCapture as never),
    ).resolves.toMatchObject({
      outcome: "failed-open",
      stage: "capture",
      reason: "failed",
    });
  });
});

describe("routing-disabled trace lifecycle", () => {
  it("returns after recording bounded no-route evidence", async () => {
    const value = await fixture(
      BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
      false,
    );
    let captureCalls = 0;
    const result = await runResolvedTraceLifecycle({
      configurationStore: value.store,
      operationalStateStore: value.operationalStateStore,
      credentialBackendRegistry: value.credentialBackendRegistry,
      transportExecutor: value.transportExecutor,
      policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
      harnessRegistryId: "codex",
      harnessVersion: {
        state: "observed",
        value: "1.2.3",
        source: "process",
      },
      hookObservedUnixNano: "100",
      operationIdScope: "session-global",
      workspaceCandidates: [],
      gitExecutable: "/usr/bin/git",
      bootstrapDeadlineMilliseconds: 1_000,
      capture(factory) {
        captureCalls += 1;
        return factory.capture(candidate());
      },
    });
    expect(result).toMatchObject({
      outcome: "routing-unselected",
      stage: "routing",
      configurationGeneration: 7,
      connections: [],
      operationalEvidence: {
        diagnostics: [{ code: "no-route", severity: "info" }],
        health: [{ scope: "hook", stage: "routing", outcome: "no-route" }],
        persistence: { recorded: true, code: "recorded" },
        checkpoints: [],
      },
    });
    expect(captureCalls).toBe(0);
    expect(value.deliveries).toHaveLength(0);
    expect(
      await inspectOperationalState(value.operationalStateStore),
    ).toMatchObject({
      diagnostics: [{ code: "no-route" }],
      health: [{ scope: "hook", outcome: "no-route" }],
      checkpoints: [],
    });
  });
});

describe("resolved operational-store authority", () => {
  it("rejects a state store that is not bound to the configuration home", async () => {
    const value = await fixture(BUILTIN_REDACTION_POLICY_REFERENCES.baseline);
    const root = await mkdtemp(join(tmpdir(), "agentscope-other-state-"));
    roots.push(root);
    const otherHome = createAgentscopeHomeResolver({
      environment: { AGENTSCOPE_HOME: join(root, "home") },
      environmentOverrideAuthority: "test",
    })();
    const otherStore = createOperationalStateStore(
      otherHome,
      createConfigurationProcessIdentity(
        778,
        `process-start-v1-${"8".repeat(64)}`,
      ),
    );
    let captureCalls = 0;
    const result = await runResolvedTraceLifecycle({
      configurationStore: value.store,
      operationalStateStore: otherStore,
      credentialBackendRegistry: value.credentialBackendRegistry,
      transportExecutor: value.transportExecutor,
      policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
      harnessRegistryId: "codex",
      harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
      hookObservedUnixNano: "100",
      operationIdScope: "session-global",
      workspaceCandidates: [],
      gitExecutable: "/usr/bin/git",
      bootstrapDeadlineMilliseconds: 1_000,
      capture(factory) {
        captureCalls += 1;
        return factory.capture(candidate());
      },
    });
    expect(result).toMatchObject({
      outcome: "failed-open",
      stage: "configuration",
      code: "configuration-unavailable",
      operationalEvidence: {
        health: [{ scope: "hook", stage: "hook-started" }],
        persistence: { recorded: false, code: "not-attempted" },
      },
    });
    expect(captureCalls).toBe(0);
  });

  it("returns fixed pre-brand evidence for an entry-time cancellation", async () => {
    const value = await fixture(BUILTIN_REDACTION_POLICY_REFERENCES.baseline);
    const controller = new AbortController();
    controller.abort();
    const result = await runResolvedTraceLifecycle({
      configurationStore: value.store,
      operationalStateStore: value.operationalStateStore,
      credentialBackendRegistry: value.credentialBackendRegistry,
      transportExecutor: value.transportExecutor,
      policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
      harnessRegistryId: "codex",
      harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
      hookObservedUnixNano: "100",
      operationIdScope: "session-global",
      workspaceCandidates: [],
      gitExecutable: "/usr/bin/git",
      bootstrapDeadlineMilliseconds: 1_000,
      signal: controller.signal,
      capture: captureCandidate,
    });
    expect(result).toMatchObject({
      outcome: "failed-open",
      code: "deadline-exceeded",
      operationalEvidence: {
        health: [{ scope: "hook", outcome: "deadline-exceeded" }],
        persistence: { recorded: false, code: "not-attempted" },
      },
    });
  });
});

describe("resolved configured trace lifecycle", () => {
  it("suppresses capture and Reporter invocation when configured policy is invalid", async () => {
    const value = await fixture("unknown-policy");
    let captureCalls = 0;
    const result = await runResolvedTraceLifecycle({
      configurationStore: value.store,
      operationalStateStore: value.operationalStateStore,
      credentialBackendRegistry: value.credentialBackendRegistry,
      transportExecutor: value.transportExecutor,
      policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
      harnessRegistryId: "codex",
      harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
      hookObservedUnixNano: "100",
      operationIdScope: "session-global",
      workspaceCandidates: [],
      gitExecutable: "/usr/bin/git",
      bootstrapDeadlineMilliseconds: 1_000,
      capture(factory) {
        captureCalls += 1;
        return factory.capture(candidate());
      },
    });
    expect(result).toMatchObject({
      outcome: "failed-open",
      stage: "policy",
      code: "policy-unavailable",
    });
    expect(captureCalls).toBe(0);
    expect(value.deliveries).toHaveLength(0);
  });

  it("runs the prepared lifecycle through the production Git projection", async () => {
    const value = await fixture(BUILTIN_REDACTION_POLICY_REFERENCES.baseline);
    const result = await runResolvedTraceLifecycle({
      configurationStore: value.store,
      operationalStateStore: value.operationalStateStore,
      credentialBackendRegistry: value.credentialBackendRegistry,
      transportExecutor: value.transportExecutor,
      policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
      harnessRegistryId: "codex",
      harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
      hookObservedUnixNano: "100",
      operationIdScope: "session-global",
      workspaceCandidates: [{ path: process.cwd(), source: "process" }],
      gitExecutable: "/usr/bin/git",
      bootstrapDeadlineMilliseconds: 1_000,
      capture: (factory, _signal, resolver) => {
        if (resolver === undefined) throw new Error("missing resolver");
        const value = candidate();
        return factory.capture(
          resumeCandidate(
            {
              ...value,
              operations: [
                {
                  ...value.operations[0]!,
                  fields: [field("input.value", "password=CANARY_SECRET")],
                },
              ],
            },
            resolver,
          ),
        );
      },
    });
    expect(result).toMatchObject({
      outcome: "completed",
      stage: "routing",
      configurationGeneration: 7,
      connections: [{ connectionId, outcome: "accepted" }],
    });
    const delivered = value.deliveries[0] ?? "";
    expect(delivered).toContain("vcs.ref.head.revision");
    expect(delivered).not.toContain(process.cwd());
    expect(delivered).not.toContain("CANARY_SECRET");
    await expect(
      runResolvedTraceLifecycle({
        configurationStore: value.store,
        operationalStateStore: value.operationalStateStore,
        credentialBackendRegistry: value.credentialBackendRegistry,
        transportExecutor: value.transportExecutor,
        policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
        harnessRegistryId: "codex",
        harnessVersion: {
          state: "observed",
          value: "1.2.3",
          source: "process",
        },
        hookObservedUnixNano: "100",
        operationIdScope: "session-global",
        workspaceCandidates: [{ path: process.cwd(), source: "process" }],
        gitExecutable: "/usr/bin/git",
        bootstrapDeadlineMilliseconds: 1_000,
        signal: new AbortController().signal,
        capture: captureCandidate,
      }),
    ).resolves.toMatchObject({
      outcome: "completed",
      stage: "routing",
      connections: [{ connectionId, outcome: "accepted" }],
    });
  });
});

describe("resolved checkpoint lifecycle evidence", () => {
  it("preloads and advances an accepted checkpoint", async () => {
    const value = await fixture(BUILTIN_REDACTION_POLICY_REFERENCES.baseline);
    const selectedStarts: number[] = [];
    const run = (exclusiveEndPosition: number) =>
      runResolvedTraceLifecycle({
        configurationStore: value.store,
        operationalStateStore: value.operationalStateStore,
        credentialBackendRegistry: value.credentialBackendRegistry,
        transportExecutor: value.transportExecutor,
        policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
        harnessRegistryId: "codex",
        harnessVersion: {
          state: "observed",
          value: "1.2.3",
          source: "process",
        },
        hookObservedUnixNano: "100",
        operationIdScope: "session-global",
        workspaceCandidates: [],
        gitExecutable: "/usr/bin/git",
        bootstrapDeadlineMilliseconds: 1_000,
        capture(factory, _signal, resolver) {
          if (resolver === undefined) throw new Error("missing resolver");
          const input = candidate();
          const resumed = resumeCandidate(input, resolver);
          selectedStarts.push(resumed.captureBoundary.startPosition);
          return factory.capture({
            ...resumed,
            captureBoundary: {
              ...resumed.captureBoundary,
              exclusiveEndPosition,
            },
          });
        },
      });

    const first = await run(1);
    expect(first).toMatchObject({
      outcome: "completed",
      operationalEvidence: {
        diagnostics: [
          {
            code: "checkpoint-unavailable",
            connectionId,
            severity: "warning",
          },
        ],
        health: [
          { scope: "hook", stage: "remote-acceptance", outcome: "accepted" },
          {
            scope: "connection",
            connectionId,
            stage: "remote-acceptance",
            outcome: "accepted",
            receipt: "accepted",
          },
        ],
        persistence: { recorded: true, code: "recorded" },
        checkpoints: [
          {
            connectionId,
            advanced: true,
            code: "advanced",
            acknowledgedExclusivePosition: 1,
          },
        ],
      },
    });
    const second = await run(2);
    expect(second.operationalEvidence.checkpoints).toMatchObject([
      {
        connectionId,
        advanced: true,
        code: "advanced",
        acknowledgedExclusivePosition: 2,
      },
    ]);
    expect(selectedStarts).toEqual([0, 1]);
    const snapshot = await inspectOperationalState(value.operationalStateStore);
    expect(snapshot.health.length).toBeGreaterThan(0);
    expect(snapshot.checkpoints).toMatchObject([
      { connectionId, acknowledgedExclusivePosition: 2 },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("thread-1");

    const boundaryScoped = await runResolvedTraceLifecycle({
      configurationStore: value.store,
      operationalStateStore: value.operationalStateStore,
      credentialBackendRegistry: value.credentialBackendRegistry,
      transportExecutor: value.transportExecutor,
      policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
      harnessRegistryId: "codex",
      harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
      hookObservedUnixNano: "100",
      operationIdScope: "session-global",
      workspaceCandidates: [],
      gitExecutable: "/usr/bin/git",
      bootstrapDeadlineMilliseconds: 1_000,
      capture(factory) {
        const input = candidate();
        return factory.capture({
          ...input,
          captureBoundary: {
            ...input.captureBoundary,
            session: { kind: "boundary-scoped" },
          },
        });
      },
    });
    expect(boundaryScoped.operationalEvidence.checkpoints).toEqual([]);
  });
});

describe("resolved checkpoint restart authority", () => {
  it("selects retained, replay, and source-loss windows from one preload", async () => {
    const value = await fixture(BUILTIN_REDACTION_POLICY_REFERENCES.baseline);
    const observed: Array<Readonly<{ disposition: string; start: number }>> =
      [];
    const adapter =
      (generation: number, availableStartPosition: number): CaptureAdapter =>
      (factory, _signal, resolver) => {
        if (resolver === undefined) throw new Error("missing resolver");
        const input = candidate();
        const boundary = input.captureBoundary;
        if (boundary.session.kind !== "native-session")
          throw new Error("invalid");
        const resume = resolver({
          nativeIdentityKind: boundary.session.nativeIdentityKind,
          nativeIdentity: boundary.session.nativeIdentity,
          sourceGeneration: generation,
          positionKind: boundary.positionKind,
          availableStartPosition,
        });
        observed.push({
          disposition: resume.disposition,
          start: resume.startPosition,
        });
        return factory.capture({
          ...input,
          captureBoundary: {
            ...boundary,
            generation,
            startPosition: resume.startPosition,
            exclusiveEndPosition: resume.startPosition + 1,
          },
        });
      };
    await expect(
      runWithOperationalStore(
        value,
        value.operationalStateStore,
        undefined,
        adapter(0, 5),
      ),
    ).resolves.toMatchObject({ outcome: "completed" });
    await expect(
      runWithOperationalStore(
        value,
        value.operationalStateStore,
        undefined,
        adapter(0, 0),
      ),
    ).resolves.toMatchObject({ outcome: "completed" });
    await expect(
      runWithOperationalStore(
        value,
        value.operationalStateStore,
        undefined,
        adapter(0, 10),
      ),
    ).resolves.toMatchObject({
      outcome: "completed",
      operationalEvidence: {
        diagnostics: [
          { code: "native-source-loss", connectionId, severity: "warning" },
        ],
        checkpoints: [{ connectionId, advanced: false, code: "stale" }],
      },
    });
    await expect(
      runWithOperationalStore(
        value,
        value.operationalStateStore,
        undefined,
        adapter(1, 10),
      ),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(observed).toEqual([
      { disposition: "source-loss", start: 5 },
      { disposition: "retained", start: 6 },
      { disposition: "source-loss", start: 10 },
      { disposition: "source-loss", start: 10 },
    ]);

    const expiredStore = createOperationalStateStoreForTesting({
      home: value.home,
      owner: createConfigurationProcessIdentity(
        781,
        `process-start-v1-${"b".repeat(64)}`,
      ),
      now: () => Date.now() + 31 * 24 * 60 * 60 * 1_000,
    });
    await expect(
      runWithOperationalStore(value, expiredStore, undefined, adapter(1, 20)),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(observed.at(-1)).toEqual({
      disposition: "source-loss",
      start: 20,
    });

    const unavailable = await fixture(
      BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
    );
    await writeFile(
      join(unavailable.home.healthDirectory, "operational-state-v1.json"),
      "{}\n",
    );
    await expect(
      runWithOperationalStore(
        unavailable,
        unavailable.operationalStateStore,
        undefined,
        adapter(0, 7),
      ),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(observed.at(-1)).toEqual({ disposition: "source-loss", start: 7 });
  });
});

describe("checkpoint source-loss persistence fallback", () => {
  it("retains native loss evidence when an accepted write is unavailable", async () => {
    const value = await fixture(BUILTIN_REDACTION_POLICY_REFERENCES.baseline);
    await expect(
      runWithOperationalStore(value, value.operationalStateStore),
    ).resolves.toMatchObject({ outcome: "completed" });
    const sourceLoss: CaptureAdapter = (factory, _signal, resolver) => {
      if (resolver === undefined) throw new Error("missing resolver");
      const input = candidate();
      const boundary = input.captureBoundary;
      if (boundary.session.kind !== "native-session")
        throw new Error("invalid");
      const resume = resolver({
        nativeIdentityKind: boundary.session.nativeIdentityKind,
        nativeIdentity: boundary.session.nativeIdentity,
        sourceGeneration: boundary.generation,
        positionKind: boundary.positionKind,
        availableStartPosition: 20,
      });
      return factory.capture({
        ...input,
        captureBoundary: {
          ...boundary,
          startPosition: resume.startPosition,
          exclusiveEndPosition: resume.startPosition + 1,
        },
      });
    };
    const unavailableWrite = createOperationalStateStoreForTesting({
      home: value.home,
      owner: createConfigurationProcessIdentity(
        782,
        `process-start-v1-${"c".repeat(64)}`,
      ),
      fileSystem: {
        open,
        rename: () => Promise.resolve(),
        unlink,
        atomicRename: () => {
          throw new Error("CANARY_CHECKPOINT_WRITE");
        },
      },
    });
    await expect(
      runWithOperationalStore(value, unavailableWrite, undefined, sourceLoss),
    ).resolves.toMatchObject({
      outcome: "completed",
      operationalEvidence: {
        diagnostics: [
          { code: "native-source-loss", connectionId, severity: "warning" },
          {
            code: "checkpoint-unavailable",
            connectionId,
            severity: "warning",
          },
        ],
        persistence: { recorded: false, code: "unavailable" },
      },
    });
  });
});

describe("checkpoint source-loss across routing membership", () => {
  it("retains resolver loss authority for a newly selected connection", async () => {
    const value = await fixture(BUILTIN_REDACTION_POLICY_REFERENCES.baseline);
    await expect(
      runWithOperationalStore(value, value.operationalStateStore),
    ).resolves.toMatchObject({ outcome: "completed" });
    const secondConnectionId =
      `destination-connection-v1-${"b".repeat(64)}` as const;
    const next = parseAgentscopeConfiguration(
      {
        configurationVersion: 2,
        generation: 8,
        destinations: {
          "@agentscope/destination-test": {
            namespaceVersion: 1,
            settingsVersion: 1,
            connections: [
              {
                connectionId,
                name: "test-a",
                settings: {},
                credentialReferences: {},
              },
              {
                connectionId: secondConnectionId,
                name: "test-b",
                settings: {},
                credentialReferences: {},
              },
            ],
          },
        },
        routing: {
          version: 1,
          selectedConnectionIds: [secondConnectionId],
          hookDeadlineMilliseconds: 2_000,
        },
        policy: {
          version: 1,
          reference: BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
        },
      },
      value.destinationRegistry,
    );
    await writeFile(
      value.home.configFile,
      serializeAgentscopeConfiguration(next),
      { mode: 0o600 },
    );
    const sourceTransition: CaptureAdapter = (factory, _signal, resolver) => {
      if (resolver === undefined) throw new Error("missing resolver");
      const input = candidate();
      const boundary = input.captureBoundary;
      if (boundary.session.kind !== "native-session")
        throw new Error("invalid");
      const resume = resolver({
        nativeIdentityKind: boundary.session.nativeIdentityKind,
        nativeIdentity: boundary.session.nativeIdentity,
        sourceGeneration: 1,
        positionKind: boundary.positionKind,
        availableStartPosition: 0,
      });
      expect(resume).toEqual({
        disposition: "source-loss",
        startPosition: 0,
      });
      return factory.capture({
        ...input,
        captureBoundary: { ...boundary, generation: 1 },
      });
    };
    const result = await runWithOperationalStore(
      value,
      value.operationalStateStore,
      undefined,
      sourceTransition,
    );
    expect(result).toMatchObject({
      outcome: "completed",
      operationalEvidence: {
        diagnostics: [
          {
            code: "native-source-loss",
            connectionId: secondConnectionId,
          },
        ],
        checkpoints: [
          {
            connectionId: secondConnectionId,
            advanced: true,
            code: "advanced",
            acknowledgedExclusivePosition: 1,
          },
        ],
      },
    });
  });
});

describe("checkpoint resolver misuse containment", () => {
  it("rejects duplicate, malformed, and mismatched adapter authority", async () => {
    const value = await fixture(BUILTIN_REDACTION_POLICY_REFERENCES.baseline);
    const request = {
      nativeIdentityKind: "thread" as const,
      nativeIdentity: "thread-1",
      sourceGeneration: 0,
      positionKind: "event-index" as const,
      availableStartPosition: 0,
    };
    const duplicate: CaptureAdapter = (factory, _signal, resolver) => {
      if (resolver === undefined) throw new Error("missing resolver");
      resolver(request);
      resolver(request);
      return factory.capture(candidate());
    };
    const malformed: CaptureAdapter = (factory, _signal, resolver) => {
      if (resolver === undefined) throw new Error("missing resolver");
      resolver({ ...request, nativeIdentity: "" });
      return factory.capture(candidate());
    };
    const mismatched: CaptureAdapter = (factory, _signal, resolver) => {
      if (resolver === undefined) throw new Error("missing resolver");
      resolver(request);
      const input = candidate();
      return factory.capture({
        ...input,
        captureBoundary: {
          ...input.captureBoundary,
          startPosition: 1,
          exclusiveEndPosition: 2,
        },
      });
    };
    for (const capture of [duplicate, malformed, mismatched])
      await expect(
        runWithOperationalStore(
          value,
          value.operationalStateStore,
          undefined,
          capture,
        ),
      ).resolves.toMatchObject({ outcome: "failed-open", stage: "capture" });
  });
});

describe("checkpoint resolver hostile authority containment", () => {
  it("snapshots plain requests once and rejects accessor or proxy authority", async () => {
    const value = await fixture(BUILTIN_REDACTION_POLICY_REFERENCES.baseline);
    let accessorReads = 0;
    const accessor: CaptureAdapter = (_factory, _signal, resolver) => {
      if (resolver === undefined) throw new Error("missing resolver");
      const request = Object.create(null) as Record<string, unknown>;
      Object.defineProperties(request, {
        availableStartPosition: { enumerable: true, value: 0 },
        nativeIdentity: {
          enumerable: true,
          get() {
            accessorReads += 1;
            return "thread-1";
          },
        },
        nativeIdentityKind: { enumerable: true, value: "thread" },
        positionKind: { enumerable: true, value: "event-index" },
        sourceGeneration: { enumerable: true, value: 0 },
      });
      resolver(request as never);
      throw new Error("unreachable");
    };
    const hostileProxy: CaptureAdapter = (_factory, _signal, resolver) => {
      if (resolver === undefined) throw new Error("missing resolver");
      const request = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("CANARY_CHECKPOINT_REQUEST");
          },
        },
      );
      resolver(request as never);
      throw new Error("unreachable");
    };
    for (const capture of [accessor, hostileProxy])
      await expect(
        runWithOperationalStore(
          value,
          value.operationalStateStore,
          undefined,
          capture,
        ),
      ).resolves.toMatchObject({ outcome: "failed-open", stage: "capture" });
    expect(accessorReads).toBe(0);
  });

  it("revokes retained resolver callbacks when capture returns or fails", async () => {
    const value = await fixture(BUILTIN_REDACTION_POLICY_REFERENCES.baseline);
    const request = {
      nativeIdentityKind: "thread" as const,
      nativeIdentity: "thread-1",
      sourceGeneration: 0,
      positionKind: "event-index" as const,
      availableStartPosition: 0,
    };
    let retained: NonNullable<Parameters<CaptureAdapter>[2]> | undefined;
    let asynchronousOutcome = "pending";
    const boundaryScoped: CaptureAdapter = (factory, _signal, resolver) => {
      if (resolver === undefined) throw new Error("missing resolver");
      retained = resolver;
      queueMicrotask(() => {
        try {
          resolver(request);
          asynchronousOutcome = "accepted";
        } catch {
          asynchronousOutcome = "rejected";
        }
      });
      const input = candidate();
      return factory.capture({
        ...input,
        captureBoundary: {
          ...input.captureBoundary,
          session: { kind: "boundary-scoped" },
        },
      });
    };
    await expect(
      runWithOperationalStore(
        value,
        value.operationalStateStore,
        undefined,
        boundaryScoped,
      ),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(() => retained?.(request)).toThrow("core.lifecycle.invalid");
    await Promise.resolve();
    expect(asynchronousOutcome).toBe("rejected");

    const failing: CaptureAdapter = (_factory, _signal, resolver) => {
      retained = resolver;
      if (resolver === undefined) throw new Error("missing resolver");
      resolver(request);
      throw new Error("CANARY_CAPTURE_FAILURE");
    };
    const failed = await runWithOperationalStore(
      value,
      value.operationalStateStore,
      undefined,
      failing,
    );
    expect(failed).toMatchObject({
      outcome: "failed-open",
      stage: "capture",
      operationalEvidence: {
        diagnostics: [
          { code: "capture-failed" },
          { code: "checkpoint-unavailable", connectionId },
        ],
      },
    });
    expect(() => retained?.(request)).toThrow("core.lifecycle.invalid");
  });
});

describe("resolved negative lifecycle evidence", () => {
  it("retains negative connection health without advancing a rejected boundary", async () => {
    const value = await fixture(
      BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
      true,
      2_000,
      "rejected",
    );
    const result = await runResolvedTraceLifecycle({
      configurationStore: value.store,
      operationalStateStore: value.operationalStateStore,
      credentialBackendRegistry: value.credentialBackendRegistry,
      transportExecutor: value.transportExecutor,
      policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
      harnessRegistryId: "codex",
      harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
      hookObservedUnixNano: "100",
      operationIdScope: "session-global",
      workspaceCandidates: [],
      gitExecutable: "/usr/bin/git",
      bootstrapDeadlineMilliseconds: 1_000,
      capture: captureCandidate,
    });
    expect(result).toMatchObject({
      outcome: "completed",
      connections: [{ connectionId, outcome: "rejected" }],
      operationalEvidence: {
        diagnostics: [
          { code: "reporter-rejected", connectionId, severity: "warning" },
          {
            code: "checkpoint-unavailable",
            connectionId,
            severity: "warning",
          },
        ],
        health: [
          { scope: "hook", stage: "delivery", outcome: "completed" },
          { scope: "connection", outcome: "rejected", receipt: "rejected" },
        ],
        checkpoints: [],
      },
    });
    expect(
      (await inspectOperationalState(value.operationalStateStore)).checkpoints,
    ).toEqual([]);
  });

  it.each([
    ["unavailable", "reporter-unavailable"],
    ["deadline-exceeded", "reporter-deadline-exceeded"],
    ["outcome-unknown", "reporter-outcome-unknown"],
  ] as const)("records fixed %s reporter evidence", async (outcome, code) => {
    const value = await fixture(
      BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
      true,
      2_000,
      outcome,
    );
    const result = await runResolvedTraceLifecycle({
      configurationStore: value.store,
      operationalStateStore: value.operationalStateStore,
      credentialBackendRegistry: value.credentialBackendRegistry,
      transportExecutor: value.transportExecutor,
      policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
      harnessRegistryId: "codex",
      harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
      hookObservedUnixNano: "100",
      operationIdScope: "session-global",
      workspaceCandidates: [],
      gitExecutable: "/usr/bin/git",
      bootstrapDeadlineMilliseconds: 1_000,
      capture: captureCandidate,
    });
    expect(result.operationalEvidence).toMatchObject({
      diagnostics: [
        { code, connectionId, severity: "warning" },
        {
          code: "checkpoint-unavailable",
          connectionId,
          severity: "warning",
        },
      ],
      health: [
        { scope: "hook", outcome: "completed" },
        { scope: "connection", outcome, receipt: outcome },
      ],
      checkpoints: [],
    });
  });
});

describe("maximum fanout operational evidence", () => {
  it("atomically records delivery and checkpoint diagnostics for 32 failures", async () => {
    const value = await fixture(
      BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
      true,
      2_000,
      "rejected",
      { connectionCount: 32 },
    );
    const result = await runWithOperationalStore(
      value,
      value.operationalStateStore,
    );
    expect(result).toMatchObject({
      outcome: "completed",
      operationalEvidence: {
        persistence: { recorded: true, code: "recorded" },
        checkpoints: [],
      },
    });
    expect(result.operationalEvidence.diagnostics).toHaveLength(64);
    expect(result.operationalEvidence.health).toHaveLength(33);
    expect(
      result.operationalEvidence.diagnostics.filter(
        (diagnostic) => diagnostic.code === "reporter-rejected",
      ),
    ).toHaveLength(32);
    expect(
      result.operationalEvidence.diagnostics.filter(
        (diagnostic) => diagnostic.code === "checkpoint-unavailable",
      ),
    ).toHaveLength(32);
    const stored = await inspectOperationalState(value.operationalStateStore);
    expect(stored.diagnostics).toHaveLength(64);
    expect(stored.health).toHaveLength(33);
  });
});

describe("resolved operational persistence boundaries", () => {
  it("bounds a hanging write and contains an unavailable write", async () => {
    const value = await fixture(
      BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
      true,
      100,
    );
    const owner = createConfigurationProcessIdentity(
      778,
      `process-start-v1-${"8".repeat(64)}`,
    );
    const hanging = createOperationalStateStoreForTesting({
      home: value.home,
      owner,
      fileSystem: {
        open,
        rename: () => Promise.resolve(),
        unlink,
        atomicRename: () => {
          throw new Error("CANARY_SECRET");
        },
      },
    });
    await expect(
      runWithOperationalStore(value, hanging),
    ).resolves.toMatchObject({
      operationalEvidence: {
        diagnostics: [
          { code: "checkpoint-unavailable", connectionId, severity: "warning" },
        ],
        persistence: { recorded: false, code: "unavailable" },
      },
    });

    const unavailable = createOperationalStateStoreForTesting({
      home: value.home,
      owner,
      fileSystem: {
        open: () => Promise.reject(new Error("CANARY_SECRET")),
        rename: () => Promise.resolve(),
        unlink: () => Promise.resolve(),
        atomicRename: () => {
          throw new Error("CANARY_SECRET");
        },
      },
    });
    await expect(
      runWithOperationalStore(value, unavailable),
    ).resolves.toMatchObject({
      operationalEvidence: {
        diagnostics: [
          { code: "checkpoint-unavailable", connectionId, severity: "warning" },
        ],
        persistence: { recorded: false, code: "unavailable" },
      },
    });
  });

  it("does not start persistence after the Reporter consumes the deadline", async () => {
    const value = await fixture(
      BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
      true,
      100,
      "accepted",
      { reporterNeverSettles: true },
    );
    let stateIoCalls = 0;
    const stateStore = createOperationalStateStoreForTesting({
      home: value.home,
      owner: createConfigurationProcessIdentity(
        779,
        `process-start-v1-${"9".repeat(64)}`,
      ),
      fileSystem: {
        open: () => {
          stateIoCalls += 1;
          return Promise.reject(new Error("unexpected state I/O"));
        },
        rename: () => Promise.resolve(),
        unlink: () => Promise.resolve(),
      },
    });
    const result = await runWithOperationalStore(value, stateStore);
    expect(result).toMatchObject({
      connections: [{ outcome: "outcome-unknown" }],
      operationalEvidence: {
        persistence: { recorded: false, code: "deadline-exceeded" },
      },
    });
    expect(stateIoCalls).toBe(0);
  });
});

describe("operational persistence deadline fencing", () => {
  it("uses no asynchronous filesystem work after operational admission", async () => {
    const value = await fixture(
      BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
      true,
      150,
    );
    let asynchronousCalls = 0;
    const stateStore = createOperationalStateStoreForTesting({
      home: value.home,
      owner: createConfigurationProcessIdentity(
        780,
        `process-start-v1-${"a".repeat(64)}`,
      ),
      fileSystem: {
        open: () => {
          asynchronousCalls += 1;
          return new Promise(() => undefined);
        },
        rename: () => {
          asynchronousCalls += 1;
          return new Promise(() => undefined);
        },
        unlink: () => {
          asynchronousCalls += 1;
          return new Promise(() => undefined);
        },
        atomicRename: () => {
          throw new Error("CANARY_SECRET");
        },
      },
    });
    await expect(
      runWithOperationalStore(value, stateStore),
    ).resolves.toMatchObject({
      operationalEvidence: {
        diagnostics: [
          { code: "checkpoint-unavailable", connectionId, severity: "warning" },
        ],
        persistence: { recorded: false, code: "unavailable" },
      },
    });
    await expect(
      readFile(
        join(value.home.healthDirectory, "operational-state-v1.json"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(asynchronousCalls).toBe(0);
  });
});

describe("configured user-policy lifecycle", () => {
  it("can only omit additional matched values", async () => {
    const value = await fixture("user-omit-input-v1");
    const policyRegistry = compileRedactionPolicyRegistry([
      {
        version: 1,
        reference: "user-omit-input-v1",
        mode: "baseline",
        rules: [
          {
            selector: { kind: "semantic-key", value: "input.value" },
            action: "omit",
          },
        ],
      },
    ]);
    const result = await runResolvedTraceLifecycle({
      configurationStore: value.store,
      operationalStateStore: value.operationalStateStore,
      credentialBackendRegistry: value.credentialBackendRegistry,
      transportExecutor: value.transportExecutor,
      policyRegistry,
      harnessRegistryId: "codex",
      harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
      hookObservedUnixNano: "100",
      operationIdScope: "session-global",
      workspaceCandidates: [],
      gitExecutable: "/usr/bin/git",
      bootstrapDeadlineMilliseconds: 1_000,
      capture(factory, _signal, resolver) {
        if (resolver === undefined) throw new Error("missing resolver");
        const input = candidate();
        return factory.capture(
          resumeCandidate(
            {
              ...input,
              operations: [
                {
                  ...input.operations[0]!,
                  fields: [
                    field("input.value", "safe input"),
                    field("output.value", "safe output"),
                  ],
                },
              ],
            },
            resolver,
          ),
        );
      },
    });
    expect(result).toMatchObject({
      outcome: "completed",
      stage: "routing",
      connections: [{ connectionId, outcome: "accepted" }],
    });
    const delivered = value.deliveries[0] ?? "";
    expect(delivered).not.toContain("safe input");
    expect(delivered).toContain("safe output");
  });
});
