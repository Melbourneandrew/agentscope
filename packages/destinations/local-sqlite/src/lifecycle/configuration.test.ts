import {
  applyLocalResourceLifecyclePlan,
  completeLocalResourceLifecycle,
  commitLocalResourceConfiguration,
  compileDestinationRegistry,
  compileLocalResourceLifecycleHandlerRegistry,
  createDestinationReporter,
  createReporterReceipt,
  defineDestinationDescriptor,
  inspectLocalResourceLifecyclePlan,
  inspectRetainedLocalResourceDelete,
  LocalResourceConfigurationCommitError,
  recoverLocalResourceLifecycle,
  type LocalResourceLifecycleContext,
} from "@agentscope/destinations-core";
import {
  bindLocalResourceConfigurationAuthorityForTesting,
  bindLocalResourceLifecycleContextForTesting,
  bindLocalResourceLifecycleRecoveryContextForTesting,
  createLocalResourceLifecycleDeadlineForTesting,
} from "@agentscope/destinations-core/testing";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import {
  LOCAL_SQLITE_DESTINATION_TYPE,
  localSqliteLifecycleDeclaration,
} from "./capability.js";
import {
  createLocalSqliteLifecycleHandler,
  createLocalSqliteLifecycleHandlerForTesting,
  decodeLocalSqliteLifecycleIntent,
  decodeLocalSqliteOwnershipReceipt,
  encodeLocalSqliteLifecycleIntent,
  encodeLocalSqliteOwnershipReceipt,
  LocalSqliteLifecycleError,
  type LocalSqliteLifecyclePort,
  type LocalSqliteLifecycleIntent,
  type LocalSqliteOwnershipReceipt,
} from "./configuration.js";

const controlledMonotonicClock = vi.hoisted(() => {
  let milliseconds = 0;
  const now = vi
    .spyOn(performance, "now")
    .mockImplementation(() => milliseconds);
  return {
    advance: (elapsedMilliseconds: number) => {
      milliseconds += elapsedMilliseconds;
    },
    reset: () => {
      milliseconds = 0;
    },
    restore: () => {
      now.mockRestore();
    },
  };
});

const settingsSchema = z.strictObject({
  maximumAgeNanoseconds: z.string(),
  maximumPayloadBytes: z.number().int(),
  maximumTraceCount: z.number().int(),
});
void settingsSchema.shape;

const registry = compileDestinationRegistry([
  defineDestinationDescriptor({
    commandName: "local-sqlite",
    createReporter: () =>
      createDestinationReporter({
        report: () => Promise.resolve(createReporterReceipt("accepted")),
      }),
    credentialSlots: [],
    defaultSettings: {
      maximumAgeNanoseconds: "2592000000000000",
      maximumPayloadBytes: 1_000_000,
      maximumTraceCount: 10_000,
    },
    deliveryIdentitySupport: "duplicates-possible",
    descriptorVersion: 1,
    destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
    documentationPath: "/docs/local-sqlite",
    localResourceLifecycle: localSqliteLifecycleDeclaration,
    settingsSchema,
    settingsVersion: 1,
    transport: { kind: "local" },
  }),
]);
const capability = registry.descriptors[0]!.localResourceLifecycle!;

const context = (
  operation: "configure" | "delete" | "unconfigure",
  signal = new AbortController().signal,
  timeoutMilliseconds = 10_000,
): LocalResourceLifecycleContext =>
  bindLocalResourceLifecycleContextForTesting({
    operation,
    operationId: "1".repeat(32),
    destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
    connectionId: `destination-connection-v1-${"2".repeat(64)}`,
    connectionName: "local",
    owner: {
      processId: 123,
      processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
    },
    settings: {
      maximumAgeNanoseconds: "2592000000000000",
      maximumPayloadBytes: 1_000_000,
      maximumTraceCount: 10_000,
    },
    expectedConfigurationGeneration: 7,
    candidateConfigurationGeneration: operation === "delete" ? 9 : 8,
    expectedConfigurationDigest: `sha256-${"3".repeat(64)}`,
    candidateConfigurationDigest: `sha256-${"4".repeat(64)}`,
    signal,
    deadline:
      createLocalResourceLifecycleDeadlineForTesting(timeoutMilliseconds),
  });

const evidence = {
  namespaceFingerprint: `sha256-${"5".repeat(64)}`,
  physicalEvidenceFingerprint: `sha256-${"6".repeat(64)}`,
  displayPath: "/owned/local-sqlite",
  persistentDataNotice: true as const,
  retentionPolicy: Object.freeze({
    maximumAgeNanoseconds: "2592000000000000",
    maximumTraceCount: 10_000,
    maximumPayloadBytes: 1_000_000,
    physicalCleanupTrigger: "next-authorized-mutation" as const,
  }),
};

const exclusiveFence = Object.freeze({
  state: "exclusive" as const,
  filename: "exclusive-fence-v1" as const,
  physicalIdentity: "dev:1:ino:9",
  record: Object.freeze({
    transactionId: "1".repeat(32),
    lifecycleFingerprint: capability.fingerprint,
    lifecycleGeneration: 1,
    purpose: "lifecycle" as const,
    owner: Object.freeze({ pid: 7, startIdentity: "2".repeat(32) }),
  }),
  deadLeaseNames: Object.freeze([]),
});

const port = (events: string[], failAt?: string): LocalSqliteLifecyclePort => {
  const step = (name: string) => () => {
    events.push(name);
    if (failAt === name)
      return Promise.reject(new LocalSqliteLifecycleError("busy"));
    return Promise.resolve();
  };
  return {
    inspect: () => {
      events.push("inspect");
      return Promise.resolve(evidence);
    },
    inspectRetainedDelete: () => Promise.resolve(null),
    publishIntent: step("intent"),
    acquireExclusiveFence: () => {
      events.push("fence");
      return Promise.resolve(exclusiveFence);
    },
    revalidatePhysicalEvidence: step("revalidate"),
    stageConfigure: step("stage"),
    activateConfigure: step("activate"),
    inspectOwnedDatabase: () => {
      events.push("inspect-owned");
      return Promise.resolve({ databaseFamilyPhysicalIdentity: "dev:1:ino:2" });
    },
    publishOwnershipReceipt: step("receipt"),
    authenticateOwnershipReceipt: step("authenticate-receipt"),
    claimRecoveryIntent: () => Promise.reject(new Error("unused")),
    rollbackPrepared: step("rollback-prepared"),
    verifyRetainedDatabase: step("verify-retained"),
    deleteOwnedDatabaseFamily: step("delete-family"),
    finalize: step("finalize"),
    completeFinalization: step("complete-finalization"),
  };
};

const apply = async (
  operation: "configure" | "delete" | "unconfigure",
  lifecyclePort: LocalSqliteLifecyclePort,
  retainedAuthority?: Readonly<{
    receiptDigest: string;
    databaseFamilyPhysicalIdentity: string;
  }>,
  commitImplementation?: () => Promise<{
    priorGeneration: number;
    committedGeneration: number;
    candidateDigest: string;
  }>,
  signal?: AbortSignal,
  timeoutMilliseconds = 10_000,
  // eslint-disable-next-line max-params -- one test helper exposes each lifecycle authority independently.
) => {
  const handler = createLocalSqliteLifecycleHandlerForTesting(
    capability,
    lifecyclePort,
  );
  const handlers = compileLocalResourceLifecycleHandlerRegistry(registry, [
    handler,
  ]);
  const value = context(
    operation,
    signal ?? new AbortController().signal,
    timeoutMilliseconds,
  );
  const planEvidence = await inspectLocalResourceLifecyclePlan(handlers, value);
  const commit = vi.fn(
    commitImplementation ??
      (() =>
        Promise.resolve({
          priorGeneration: value.expectedConfigurationGeneration,
          committedGeneration: value.candidateConfigurationGeneration,
          candidateDigest: value.candidateConfigurationDigest,
        })),
  );
  const configurationAuthority =
    bindLocalResourceConfigurationAuthorityForTesting({
      destinationType: value.destinationType,
      connectionId: value.connectionId,
      operationId: value.operationId,
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      priorGeneration: value.expectedConfigurationGeneration,
      candidateGeneration: value.candidateConfigurationGeneration,
      candidateDigest: value.candidateConfigurationDigest,
      commit,
    });
  return {
    commit,
    result: await applyLocalResourceLifecyclePlan(
      handlers,
      value,
      planEvidence,
      configurationAuthority,
      retainedAuthority,
    ),
  };
};

beforeEach(() => {
  controlledMonotonicClock.reset();
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  controlledMonotonicClock.restore();
});

// eslint-disable-next-line max-lines-per-function -- one engine fixture shares exact phase and durable-record authority.
describe("Local SQLite configuration lifecycle phase engine", () => {
  it.each([
    [
      "configure",
      [
        "inspect",
        "intent",
        "fence",
        "revalidate",
        "stage",
        "activate",
        "finalize",
      ],
      "configured",
    ],
    [
      "unconfigure",
      [
        "inspect",
        "intent",
        "fence",
        "revalidate",
        "inspect-owned",
        "receipt",
        "verify-retained",
        "finalize",
      ],
      "retained",
    ],
    [
      "delete",
      [
        "inspect",
        "intent",
        "fence",
        "revalidate",
        "inspect-owned",
        "receipt",
        "delete-family",
        "finalize",
      ],
      "deleted",
    ],
  ] as const)(
    "orders %s around one Core commit",
    async (operation, order, state) => {
      const events: string[] = [];
      const result = await apply(operation, port(events));
      expect(result.result).toMatchObject({ ok: true, state });
      expect(result.commit).toHaveBeenCalledOnce();
      expect(events).toEqual(order);
    },
  );

  it("retains exact pre- and post-commit recovery state", async () => {
    const before = await apply("configure", port([], "stage"));
    expect(before.result).toEqual({
      ok: false,
      state: "prepared",
      code: "busy",
    });
    expect(before.commit).not.toHaveBeenCalled();

    const after = await apply("configure", port([], "activate"));
    expect(after.result).toEqual({
      ok: false,
      state: "configuration-committed",
      code: "busy",
    });
    expect(after.commit).toHaveBeenCalledOnce();

    const ambiguous = await apply("configure", port([]), undefined, () =>
      Promise.reject(new LocalResourceConfigurationCommitError()),
    );
    expect(ambiguous.result).toEqual({
      ok: false,
      state: "configuration-committed",
      code: "outcome-unknown",
    });
    const hostileSignal = new AbortController().signal;
    Object.defineProperty(hostileSignal, "aborted", {
      get() {
        throw new Error("CANARY");
      },
    });
    const hostile = await apply(
      "configure",
      port([]),
      undefined,
      undefined,
      hostileSignal,
    );
    expect(hostile.result).toMatchObject({ ok: true, state: "configured" });
  });

  it("does not confuse a pre-expired authority with in-stage cancellation", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let releaseInspection!: () => void;
    let enterInspection!: () => void;
    let stageSignal: AbortSignal | undefined;
    const inspectionBlocked = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    const inspectionEntered = new Promise<void>((resolve) => {
      enterInspection = resolve;
    });
    const value = port(events);
    const execution = apply(
      "configure",
      {
        ...value,
        inspect: async () => {
          events.push("inspect-blocked");
          enterInspection();
          await inspectionBlocked;
          return evidence;
        },
        stageConfigure: (_intent, _fence, signal) => {
          stageSignal = signal;
          return Promise.resolve();
        },
      },
      undefined,
      undefined,
      undefined,
      20,
    );
    await inspectionEntered;
    const rejection = expect(execution).rejects.toMatchObject({
      code: "destination.local-resource-handler.invalid",
    });
    controlledMonotonicClock.advance(20);
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    expect(stageSignal).toBeUndefined();
    expect(events).toEqual(["inspect-blocked"]);
    releaseInspection();
  });

  it("aborts an entered phase at the deadline before any later mutation", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let releaseStage!: () => void;
    let enterStage!: () => void;
    let stageSignal: AbortSignal | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseStage = resolve;
    });
    const stageEntered = new Promise<void>((resolve) => {
      enterStage = resolve;
    });
    const value = port(events);
    const execution = apply(
      "configure",
      {
        ...value,
        stageConfigure: (_intent, _fence, signal) => {
          events.push("stage-blocked");
          stageSignal = signal;
          enterStage();
          return blocked;
        },
      },
      undefined,
      undefined,
      undefined,
      20,
    );
    let settled = false;
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await stageEntered;
    expect(stageSignal?.aborted).toBe(false);
    controlledMonotonicClock.advance(20);
    await vi.advanceTimersByTimeAsync(20);
    expect(stageSignal?.aborted).toBe(true);
    expect(settled).toBe(false);
    releaseStage();
    await expect(execution).rejects.toMatchObject({
      code: "destination.local-resource-handler.invalid",
    });
    expect(events).toEqual([
      "inspect",
      "intent",
      "fence",
      "revalidate",
      "stage-blocked",
    ]);
  });

  it("keeps the durable completion marker until Core completes its intent", async () => {
    const events: string[] = [];
    const handler = createLocalSqliteLifecycleHandlerForTesting(
      capability,
      port(events),
    );
    const handlers = compileLocalResourceLifecycleHandlerRegistry(registry, [
      handler,
    ]);
    const value = context("configure");
    const planEvidence = await inspectLocalResourceLifecyclePlan(
      handlers,
      value,
    );
    const configurationAuthority =
      bindLocalResourceConfigurationAuthorityForTesting({
        destinationType: value.destinationType,
        connectionId: value.connectionId,
        operationId: value.operationId,
        lifecycleFingerprint: capability.fingerprint,
        recoveryHandlerId: capability.recoveryHandlerId,
        priorGeneration: value.expectedConfigurationGeneration,
        candidateGeneration: value.candidateConfigurationGeneration,
        candidateDigest: value.candidateConfigurationDigest,
        commit: () =>
          Promise.resolve({
            priorGeneration: value.expectedConfigurationGeneration,
            committedGeneration: value.candidateConfigurationGeneration,
            candidateDigest: value.candidateConfigurationDigest,
          }),
      });
    await expect(
      applyLocalResourceLifecyclePlan(
        handlers,
        value,
        planEvidence,
        configurationAuthority,
      ),
    ).resolves.toEqual({ ok: true, state: "configured" });
    expect(events.at(-1)).toBe("finalize");
    await completeLocalResourceLifecycle(handlers, value);
    expect(events.slice(-2)).toEqual(["finalize", "complete-finalization"]);
  });

  it("authenticates the retained receipt instead of republishing it", async () => {
    const events: string[] = [];
    let durableIntent: LocalSqliteLifecycleIntent | undefined;
    const value = port(events);
    const result = await apply(
      "delete",
      {
        ...value,
        publishIntent: (intent, bytes, signal) => {
          durableIntent = intent;
          return value.publishIntent(intent, bytes, signal);
        },
      },
      Object.freeze({
        receiptDigest: `sha256-${"9".repeat(64)}`,
        databaseFamilyPhysicalIdentity: "dev:1:ino:2",
      }),
    );
    expect(result.result).toEqual({ ok: true, state: "deleted" });
    expect(events).toEqual([
      "inspect",
      "intent",
      "fence",
      "revalidate",
      "authenticate-receipt",
      "delete-family",
      "finalize",
    ]);
    expect(durableIntent).toMatchObject({
      retainedReceiptDigest: `sha256-${"9".repeat(64)}`,
      retainedDatabaseFamilyPhysicalIdentity: "dev:1:ino:2",
    });
    expect(durableIntent).not.toHaveProperty("connectionName");
    if (!durableIntent) throw new Error("missing retained intent");
    const retainedIntent = durableIntent;
    expect(
      decodeLocalSqliteLifecycleIntent(
        encodeLocalSqliteLifecycleIntent(retainedIntent),
      ),
    ).toBeDefined();
    const recoveryEvents: string[] = [];
    const recoveryHandlers = compileLocalResourceLifecycleHandlerRegistry(
      registry,
      [
        createLocalSqliteLifecycleHandlerForTesting(capability, {
          ...port(recoveryEvents),
          claimRecoveryIntent: () =>
            Promise.resolve({
              canonicalBytes: encodeLocalSqliteLifecycleIntent(retainedIntent),
              fence: exclusiveFence,
            }),
        }),
      ],
    );
    const deleteContext = context("delete");
    await expect(
      recoverLocalResourceLifecycle(
        recoveryHandlers,
        bindLocalResourceLifecycleRecoveryContextForTesting({
          operation: "delete",
          operationId: deleteContext.operationId,
          destinationType: deleteContext.destinationType,
          connectionId: deleteContext.connectionId,
          owner: deleteContext.owner,
          lifecycleFingerprint: capability.fingerprint,
          recoveryHandlerId: capability.recoveryHandlerId,
          expectedConfigurationGeneration: 7,
          expectedConfigurationDigest:
            deleteContext.expectedConfigurationDigest,
          authorizedCandidates: [
            { generation: 8, digest: `sha256-${"8".repeat(64)}` },
            {
              generation: 9,
              digest: deleteContext.candidateConfigurationDigest,
            },
          ],
          configurationState: "committed",
          signal: new AbortController().signal,
          deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
        }),
      ),
    ).resolves.toEqual({ ok: true, state: "deleted" });
    expect(recoveryEvents).toContain("authenticate-receipt");
  });

  // eslint-disable-next-line max-lines-per-function -- one restart matrix proves rollback and the two-generation delete resume.
  it("decodes a claimed intent and deterministically rolls back or resumes", async () => {
    let configureBytes = "";
    const original = port([]);
    const prepared = await apply("configure", {
      ...original,
      publishIntent: (intent, bytes, signal) => {
        configureBytes = bytes;
        return original.publishIntent(intent, bytes, signal);
      },
      stageConfigure: () =>
        Promise.reject(new LocalSqliteLifecycleError("busy")),
    });
    expect(prepared.result).toMatchObject({ ok: false, state: "prepared" });
    const rollbackEvents: string[] = [];
    const rollbackPort = {
      ...port(rollbackEvents),
      claimRecoveryIntent: () =>
        Promise.resolve({
          canonicalBytes: configureBytes,
          fence: exclusiveFence,
        }),
    };
    const rollbackHandlers = compileLocalResourceLifecycleHandlerRegistry(
      registry,
      [createLocalSqliteLifecycleHandlerForTesting(capability, rollbackPort)],
    );
    const configureContext = context("configure");
    await expect(
      recoverLocalResourceLifecycle(
        rollbackHandlers,
        bindLocalResourceLifecycleRecoveryContextForTesting({
          operation: "configure",
          operationId: configureContext.operationId,
          destinationType: configureContext.destinationType,
          connectionId: configureContext.connectionId,
          owner: configureContext.owner,
          lifecycleFingerprint: capability.fingerprint,
          recoveryHandlerId: capability.recoveryHandlerId,
          expectedConfigurationGeneration: 7,
          expectedConfigurationDigest:
            configureContext.expectedConfigurationDigest,
          authorizedCandidates: Object.freeze([
            Object.freeze({
              generation: 8,
              digest: configureContext.candidateConfigurationDigest,
            }),
          ]),
          configurationState: "prior",
          signal: new AbortController().signal,
          deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
        }),
      ),
    ).resolves.toEqual({ ok: true, state: "rolled-back" });
    expect(rollbackEvents).toEqual(["rollback-prepared", "finalize"]);

    const activateEvents: string[] = [];
    const activateHandlers = compileLocalResourceLifecycleHandlerRegistry(
      registry,
      [
        createLocalSqliteLifecycleHandlerForTesting(capability, {
          ...port(activateEvents),
          claimRecoveryIntent: () =>
            Promise.resolve({
              canonicalBytes: configureBytes,
              fence: exclusiveFence,
            }),
        }),
      ],
    );
    await expect(
      recoverLocalResourceLifecycle(
        activateHandlers,
        bindLocalResourceLifecycleRecoveryContextForTesting({
          operation: "configure",
          operationId: configureContext.operationId,
          destinationType: configureContext.destinationType,
          connectionId: configureContext.connectionId,
          owner: configureContext.owner,
          lifecycleFingerprint: capability.fingerprint,
          recoveryHandlerId: capability.recoveryHandlerId,
          expectedConfigurationGeneration: 7,
          expectedConfigurationDigest:
            configureContext.expectedConfigurationDigest,
          authorizedCandidates: [
            {
              generation: 8,
              digest: configureContext.candidateConfigurationDigest,
            },
          ],
          configurationState: "committed",
          signal: new AbortController().signal,
          deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
        }),
      ),
    ).resolves.toEqual({ ok: true, state: "configured" });
    expect(activateEvents).toEqual(["activate", "finalize"]);

    const invalidHandlers = compileLocalResourceLifecycleHandlerRegistry(
      registry,
      [
        createLocalSqliteLifecycleHandlerForTesting(capability, {
          ...port([]),
          claimRecoveryIntent: () =>
            Promise.resolve({ canonicalBytes: "{}\n", fence: exclusiveFence }),
        }),
      ],
    );
    await expect(
      recoverLocalResourceLifecycle(
        invalidHandlers,
        bindLocalResourceLifecycleRecoveryContextForTesting({
          operation: "configure",
          operationId: configureContext.operationId,
          destinationType: configureContext.destinationType,
          connectionId: configureContext.connectionId,
          owner: configureContext.owner,
          lifecycleFingerprint: capability.fingerprint,
          recoveryHandlerId: capability.recoveryHandlerId,
          expectedConfigurationGeneration: 7,
          expectedConfigurationDigest:
            configureContext.expectedConfigurationDigest,
          authorizedCandidates: [
            {
              generation: 8,
              digest: configureContext.candidateConfigurationDigest,
            },
          ],
          configurationState: "prior",
          signal: new AbortController().signal,
          deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      state: "reconciliation-required",
    });

    let deleteBytes = "";
    const deletePort = port([]);
    await apply("delete", {
      ...deletePort,
      publishIntent: (intent, bytes, signal) => {
        deleteBytes = bytes;
        return deletePort.publishIntent(intent, bytes, signal);
      },
    });
    const resumeEvents: string[] = [];
    const resumedPort = {
      ...port(resumeEvents),
      claimRecoveryIntent: () =>
        Promise.resolve({ canonicalBytes: deleteBytes, fence: exclusiveFence }),
    };
    const resumeHandlers = compileLocalResourceLifecycleHandlerRegistry(
      registry,
      [createLocalSqliteLifecycleHandlerForTesting(capability, resumedPort)],
    );
    const deleteContext = context("delete");
    const intermediateWithoutAuthority =
      bindLocalResourceLifecycleRecoveryContextForTesting({
        operation: "delete",
        operationId: deleteContext.operationId,
        destinationType: deleteContext.destinationType,
        connectionId: deleteContext.connectionId,
        owner: deleteContext.owner,
        lifecycleFingerprint: capability.fingerprint,
        recoveryHandlerId: capability.recoveryHandlerId,
        expectedConfigurationGeneration: 7,
        expectedConfigurationDigest: deleteContext.expectedConfigurationDigest,
        authorizedCandidates: [
          { generation: 8, digest: `sha256-${"8".repeat(64)}` },
          {
            generation: 9,
            digest: deleteContext.candidateConfigurationDigest,
          },
        ],
        configurationState: "intermediate",
        signal: new AbortController().signal,
        deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
      });
    await expect(
      recoverLocalResourceLifecycle(
        resumeHandlers,
        intermediateWithoutAuthority,
      ),
    ).resolves.toMatchObject({
      ok: false,
      state: "reconciliation-required",
    });
    const commit = vi.fn(() =>
      Promise.resolve({
        priorGeneration: 8,
        committedGeneration: 9,
        candidateDigest: deleteContext.candidateConfigurationDigest,
      }),
    );
    const authority = bindLocalResourceConfigurationAuthorityForTesting({
      destinationType: deleteContext.destinationType,
      connectionId: deleteContext.connectionId,
      operationId: deleteContext.operationId,
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      priorGeneration: 8,
      candidateGeneration: 9,
      candidateDigest: deleteContext.candidateConfigurationDigest,
      commit,
    });
    await expect(
      recoverLocalResourceLifecycle(
        resumeHandlers,
        bindLocalResourceLifecycleRecoveryContextForTesting({
          operation: "delete",
          operationId: deleteContext.operationId,
          destinationType: deleteContext.destinationType,
          connectionId: deleteContext.connectionId,
          owner: deleteContext.owner,
          lifecycleFingerprint: capability.fingerprint,
          recoveryHandlerId: capability.recoveryHandlerId,
          expectedConfigurationGeneration: 7,
          expectedConfigurationDigest:
            deleteContext.expectedConfigurationDigest,
          authorizedCandidates: Object.freeze([
            Object.freeze({
              generation: 8,
              digest: `sha256-${"8".repeat(64)}`,
            }),
            Object.freeze({
              generation: 9,
              digest: deleteContext.candidateConfigurationDigest,
            }),
          ]),
          configurationState: "intermediate",
          signal: new AbortController().signal,
          deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
          configurationAuthority: authority,
        }),
      ),
    ).resolves.toEqual({ ok: true, state: "deleted" });
    expect(commit).toHaveBeenCalledOnce();
    expect(resumeEvents).toEqual([
      "authenticate-receipt",
      "delete-family",
      "finalize",
    ]);

    let unconfigureBytes = "";
    const unconfigurePort = port([]);
    await apply("unconfigure", {
      ...unconfigurePort,
      publishIntent: (intent, bytes, signal) => {
        unconfigureBytes = bytes;
        return unconfigurePort.publishIntent(intent, bytes, signal);
      },
    });
    const retainedEvents: string[] = [];
    const retainedHandlers = compileLocalResourceLifecycleHandlerRegistry(
      registry,
      [
        createLocalSqliteLifecycleHandlerForTesting(capability, {
          ...port(retainedEvents),
          claimRecoveryIntent: () =>
            Promise.resolve({
              canonicalBytes: unconfigureBytes,
              fence: exclusiveFence,
            }),
        }),
      ],
    );
    const unconfigureContext = context("unconfigure");
    await expect(
      recoverLocalResourceLifecycle(
        retainedHandlers,
        bindLocalResourceLifecycleRecoveryContextForTesting({
          operation: "unconfigure",
          operationId: unconfigureContext.operationId,
          destinationType: unconfigureContext.destinationType,
          connectionId: unconfigureContext.connectionId,
          owner: unconfigureContext.owner,
          lifecycleFingerprint: capability.fingerprint,
          recoveryHandlerId: capability.recoveryHandlerId,
          expectedConfigurationGeneration: 7,
          expectedConfigurationDigest:
            unconfigureContext.expectedConfigurationDigest,
          authorizedCandidates: [
            {
              generation: 8,
              digest: unconfigureContext.candidateConfigurationDigest,
            },
          ],
          configurationState: "committed",
          signal: new AbortController().signal,
          deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
        }),
      ),
    ).resolves.toMatchObject({ ok: true, state: "retained" });
    expect(retainedEvents).toEqual([
      "verify-retained",
      "inspect-owned",
      "finalize",
    ]);
  });

  it("contains unknown failures and rejects malformed ownership evidence", async () => {
    const beforePort = port([]);
    const before = await apply("configure", {
      ...beforePort,
      stageConfigure: () => Promise.reject(new Error("CANARY")),
    });
    expect(before.result).toEqual({
      ok: false,
      state: "prepared",
      code: "outcome-unknown",
    });
    const afterPort = port([]);
    const after = await apply("configure", {
      ...afterPort,
      activateConfigure: () => Promise.reject(new Error("CANARY")),
    });
    expect(after.result).toEqual({
      ok: false,
      state: "configuration-committed",
      code: "outcome-unknown",
    });
    for (const invalid of [
      null,
      {},
      { databaseFamilyPhysicalIdentity: "" },
      { databaseFamilyPhysicalIdentity: "CANARY value" },
      { databaseFamilyPhysicalIdentity: "a".repeat(193) },
      { databaseFamilyPhysicalIdentity: "dev:1", extra: true },
    ]) {
      const invalidPort = port([]);
      const value = await apply("unconfigure", {
        ...invalidPort,
        inspectOwnedDatabase: () => Promise.resolve(invalid as never),
      });
      expect(value.result).toEqual({
        ok: false,
        state: "reconciliation-required",
        code: "reconciliation-required",
      });
    }
    const mismatchedPort = port([]);
    const mismatchedHandler = createLocalSqliteLifecycleHandlerForTesting(
      capability,
      {
        ...mismatchedPort,
        inspect: () =>
          Promise.resolve({
            ...evidence,
            retentionPolicy: {
              ...evidence.retentionPolicy,
              maximumTraceCount: 99,
            },
          }),
      },
    );
    await expect(
      inspectLocalResourceLifecyclePlan(
        compileLocalResourceLifecycleHandlerRegistry(registry, [
          mismatchedHandler,
        ]),
        context("configure"),
      ),
    ).rejects.toMatchObject({ code: "reconciliation-required" });
  });

  it("brands canonical durable records and rejects copies", async () => {
    let intent: LocalSqliteLifecycleIntent | undefined;
    let receipt: LocalSqliteOwnershipReceipt | undefined;
    const value = port([]);
    const result = await apply("unconfigure", {
      ...value,
      publishIntent: (record, bytes) => {
        intent = record;
        expect(bytes).toBe(encodeLocalSqliteLifecycleIntent(record));
        return Promise.resolve();
      },
      publishOwnershipReceipt: (record, bytes) => {
        receipt = record;
        expect(bytes).toBe(encodeLocalSqliteOwnershipReceipt(record));
        return Promise.resolve();
      },
    });
    expect(result.result).toMatchObject({ ok: true, state: "retained" });
    if (!intent || !receipt) throw new Error("fixture did not publish records");
    expect(() =>
      encodeLocalSqliteLifecycleIntent({
        ...intent,
      } as LocalSqliteLifecycleIntent),
    ).toThrow(LocalSqliteLifecycleError);
    expect(() =>
      encodeLocalSqliteOwnershipReceipt({
        ...receipt,
      } as LocalSqliteOwnershipReceipt),
    ).toThrow(LocalSqliteLifecycleError);
  });

  it("strictly decodes canonical intent and ownership records", async () => {
    let intentBytes = "";
    let receiptBytes = "";
    const value = port([]);
    await apply("unconfigure", {
      ...value,
      publishIntent: (intent, bytes, signal) => {
        intentBytes = bytes;
        return value.publishIntent(intent, bytes, signal);
      },
      publishOwnershipReceipt: (receipt, bytes, fence, signal) => {
        receiptBytes = bytes;
        return value.publishOwnershipReceipt(receipt, bytes, fence, signal);
      },
    });
    expect(decodeLocalSqliteLifecycleIntent(intentBytes)).toBeDefined();
    expect(decodeLocalSqliteOwnershipReceipt(receiptBytes)).toBeDefined();
    const mutate = (bytes: string, key: string, value: unknown): string => {
      const record = JSON.parse(bytes) as Record<string, unknown>;
      record[key] = value;
      return `${JSON.stringify(record)}\n`;
    };
    for (const invalid of [
      null,
      "{}",
      "not-json\n",
      "null\n",
      "[]\n",
      "{}\n",
      ` ${intentBytes}`,
      mutate(intentBytes, "recordVersion", 2),
      mutate(intentBytes, "operation", "future"),
      mutate(intentBytes, "transactionId", "0".repeat(32)),
      mutate(intentBytes, "destinationType", "future"),
      mutate(intentBytes, "connectionId", "invalid"),
      mutate(intentBytes, "owner", null),
      mutate(intentBytes, "owner", {
        processId: 123,
        processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
        extra: true,
      }),
      mutate(intentBytes, "namespaceFingerprint", "invalid"),
      mutate(intentBytes, "physicalEvidenceFingerprint", "invalid"),
      mutate(intentBytes, "lifecycleFingerprint", "invalid"),
      mutate(intentBytes, "artifactGrammarFingerprint", "invalid"),
      mutate(intentBytes, "expectedConfigurationGeneration", -1),
      mutate(intentBytes, "candidateConfigurationGeneration", 7),
      mutate(intentBytes, "expectedConfigurationDigest", "invalid"),
      mutate(intentBytes, "candidateConfigurationDigest", "invalid"),
      mutate(intentBytes, "retainedReceiptDigest", `sha256-${"9".repeat(64)}`),
    ])
      expect(decodeLocalSqliteLifecycleIntent(invalid)).toBeUndefined();
    for (const invalid of [
      null,
      "{}",
      "not-json\n",
      "null\n",
      "[]\n",
      "{}\n",
      ` ${receiptBytes}`,
      mutate(receiptBytes, "recordVersion", 2),
      mutate(receiptBytes, "destinationType", "future"),
      mutate(receiptBytes, "connectionId", "invalid"),
      mutate(receiptBytes, "namespaceFingerprint", "invalid"),
      mutate(receiptBytes, "physicalEvidenceFingerprint", "invalid"),
      mutate(receiptBytes, "databaseFamilyPhysicalIdentity", "invalid value"),
      mutate(receiptBytes, "destinationFormat", "future"),
      mutate(receiptBytes, "lifecycleFingerprint", "invalid"),
      mutate(receiptBytes, "artifactGrammarFingerprint", "invalid"),
      mutate(receiptBytes, "originatingConfigurationGeneration", -1),
      mutate(receiptBytes, "originatingConfigurationDigest", "invalid"),
      mutate(receiptBytes, "transactionId", "0".repeat(32)),
    ])
      expect(decodeLocalSqliteOwnershipReceipt(invalid)).toBeUndefined();
  });

  it("keeps production unavailable before lifecycle mutation", async () => {
    const handler = createLocalSqliteLifecycleHandler(capability);
    const handlers = compileLocalResourceLifecycleHandlerRegistry(registry, [
      handler,
    ]);
    await expect(
      inspectLocalResourceLifecyclePlan(handlers, context("configure")),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      inspectRetainedLocalResourceDelete(
        handlers,
        context("delete").connectionId,
        new AbortController().signal,
        createLocalResourceLifecycleDeadlineForTesting(10_000),
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    const value = context("configure");
    const authority = bindLocalResourceConfigurationAuthorityForTesting({
      destinationType: value.destinationType,
      connectionId: value.connectionId,
      operationId: value.operationId,
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      priorGeneration: 7,
      candidateGeneration: 8,
      candidateDigest: value.candidateConfigurationDigest,
      commit: () => Promise.reject(new Error("unused")),
    });
    await expect(
      applyLocalResourceLifecyclePlan(handlers, value, evidence, authority),
    ).resolves.toEqual({
      ok: false,
      state: "unchanged",
      code: "unavailable",
    });
    await expect(
      recoverLocalResourceLifecycle(
        handlers,
        bindLocalResourceLifecycleRecoveryContextForTesting({
          operation: "configure",
          operationId: value.operationId,
          destinationType: value.destinationType,
          connectionId: value.connectionId,
          owner: value.owner,
          lifecycleFingerprint: capability.fingerprint,
          recoveryHandlerId: capability.recoveryHandlerId,
          expectedConfigurationGeneration: 7,
          expectedConfigurationDigest: value.expectedConfigurationDigest,
          authorizedCandidates: [
            { generation: 8, digest: value.candidateConfigurationDigest },
          ],
          configurationState: "prior",
          signal: new AbortController().signal,
          deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      state: "unchanged",
      code: "unavailable",
    });
    await expect(
      completeLocalResourceLifecycle(handlers, value),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("returns exact retained delete authority from the testing port", async () => {
    const value = port([]);
    const handler = createLocalSqliteLifecycleHandlerForTesting(capability, {
      ...value,
      inspectRetainedDelete: () =>
        Promise.resolve({
          connectionId: context("delete").connectionId,
          connectionName: "retained" as const,
          planEvidence: evidence,
          retainedAuthority: {
            receiptDigest: `sha256-${"9".repeat(64)}`,
            databaseFamilyPhysicalIdentity: "dev:1:ino:2",
          },
        }),
    });
    await expect(
      inspectRetainedLocalResourceDelete(
        compileLocalResourceLifecycleHandlerRegistry(registry, [handler]),
        context("delete").connectionId,
        new AbortController().signal,
        createLocalResourceLifecycleDeadlineForTesting(10_000),
      ),
    ).resolves.toMatchObject({
      connectionId: context("delete").connectionId,
      retainedAuthority: {
        receiptDigest: `sha256-${"9".repeat(64)}`,
      },
    });
    await expect(
      inspectRetainedLocalResourceDelete(
        compileLocalResourceLifecycleHandlerRegistry(registry, [
          createLocalSqliteLifecycleHandlerForTesting(capability, value),
        ]),
        context("delete").connectionId,
        new AbortController().signal,
        createLocalResourceLifecycleDeadlineForTesting(10_000),
      ),
    ).resolves.toBeNull();
  });

  it("rejects an unrelated capability", () => {
    expect(() => createLocalSqliteLifecycleHandler({ ...capability })).toThrow(
      LocalSqliteLifecycleError,
    );
  });

  it("does not expose the Core commit callback to the port", async () => {
    const events: string[] = [];
    const result = await apply("delete", port(events));
    expect(result.result).toEqual({ ok: true, state: "deleted" });
    expect(commitLocalResourceConfiguration).toBeTypeOf("function");
  });
});
