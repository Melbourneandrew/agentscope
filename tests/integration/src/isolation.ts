import { createHash } from "node:crypto";

import { z } from "zod";

import type { CandidateEvidence } from "./artifacts.js";
import { deepFreeze } from "./canonical.js";
import type { CapabilityScenario } from "./manifest.js";

const runToken = z.string().regex(/^[a-f\d]{16}$/u);
const digest = z.string().regex(/^sha256-[a-f\d]{64}$/u);
const imageReference = z
  .string()
  .regex(/^[a-z0-9][a-z0-9./_-]{0,159}@sha256:[a-f\d]{64}$/u);
const ociDigest = z.string().regex(/^sha256:[a-f\d]{64}$/u);
const platformComponent = z.string().regex(/^[a-z\d][a-z\d._-]{0,63}$/u);
const preparedImageIdentitySchema = z.strictObject({
  image: imageReference,
  platform: z.strictObject({
    os: platformComponent,
    architecture: platformComponent,
    variant: platformComponent.optional(),
  }),
  manifestDigest: ociDigest,
  configDigest: ociDigest,
});
const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const version = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+_~-]{0,63}$/u);
const productName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 .()_-]{0,95}$/u);
const runtimeName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const boundedCount = z.number().int().min(0).max(256);

export const SCENARIO_TMPFS_MOUNTS = deepFreeze([
  "/home/agentscope",
  "/harness-home",
  "/agentscope-home",
  "/worktree",
  "/ledger",
  "/tmp",
] as const);

const mebibytes = (value: number): number => value * 1024 * 1024;

export const ISOLATION_EXECUTOR_LIMITS = deepFreeze({
  containers: {
    scenario: {
      memoryBytes: mebibytes(512),
      pidsLimit: 128,
      tmpfs: SCENARIO_TMPFS_MOUNTS.map((path) => ({
        path,
        bytes: mebibytes(16),
      })),
    },
    collector: {
      memoryBytes: mebibytes(512),
      pidsLimit: 128,
      tmpfs: [{ path: "/tmp", bytes: mebibytes(16) }],
    },
    retrieval: {
      memoryBytes: mebibytes(512),
      pidsLimit: 128,
      tmpfs: [{ path: "/tmp", bytes: mebibytes(16) }],
    },
    mockServer: {
      memoryBytes: mebibytes(512),
      pidsLimit: 128,
      tmpfs: [{ path: "/tmp", bytes: mebibytes(64) }],
    },
  },
  cleanup: {
    totalMilliseconds: 60_000,
    removalMilliseconds: 50_000,
    proofMilliseconds: 10_000,
  },
  requests: {
    destinationServerMaximumBytes: mebibytes(1),
  },
} as const);

const tmpfsLimitSchema = z.strictObject({
  path: z.enum(SCENARIO_TMPFS_MOUNTS),
  bytes: z.number().int().min(mebibytes(1)).max(mebibytes(64)),
});
const containerLimitSchema = z.strictObject({
  memoryBytes: z.number().int().min(mebibytes(64)).max(mebibytes(1024)),
  pidsLimit: z.number().int().min(16).max(512),
  tmpfs: z.array(tmpfsLimitSchema).min(1).max(SCENARIO_TMPFS_MOUNTS.length),
});
const runtimeIdentitySchema = z.strictObject({
  executor: z.literal("docker"),
  clientVersion: version,
  engine: z.strictObject({
    kind: z.literal("docker-engine"),
    product: productName,
    version,
    apiVersion: version,
    operatingSystem: productName,
    osType: runtimeName,
    architecture: runtimeName,
  }),
  containerRuntime: z.strictObject({
    name: runtimeName,
    version,
  }),
  containerdVersion: version,
});
const runtimeInspectionSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("complete"),
    identity: runtimeIdentitySchema,
  }),
  z.strictObject({
    outcome: z.literal("unavailable"),
    identity: z.null(),
  }),
]);
const selectionFields = {
  selectionVersion: z.literal(2),
  manifestIdentity: digest,
  scenarioIds: z.array(id).min(1).max(256),
} as const;
const selectionPolicySchema = z.discriminatedUnion("mode", [
  z.strictObject({
    ...selectionFields,
    mode: z.literal("scenario"),
    selector: z.strictObject({ scenarioId: id }),
  }),
  z.strictObject({
    ...selectionFields,
    mode: z.literal("harness"),
    selector: z.strictObject({ harnessId: id }),
  }),
  z.strictObject({
    ...selectionFields,
    mode: z.literal("tag"),
    selector: z.strictObject({ tag: id }),
  }),
  z.strictObject({
    ...selectionFields,
    mode: z.literal("shard"),
    selector: z.strictObject({
      shard: z
        .strictObject({
          index: z.number().int().min(0).max(255),
          total: z.number().int().min(1).max(256),
        })
        .refine(({ index, total }) => index < total),
    }),
  }),
  z.strictObject({
    ...selectionFields,
    mode: z.literal("full"),
    selector: z.strictObject({}),
  }),
]);
const executionPolicySchema = z
  .strictObject({
    policyVersion: z.literal(1),
    runtimeInspection: runtimeInspectionSchema,
    selection: selectionPolicySchema,
    maximumParallelScenarios: z.number().int().min(1).max(16),
    scenarioTimeoutMilliseconds: z
      .number()
      .int()
      .min(1)
      .max(30 * 60 * 1000),
    cleanupTimeouts: z.strictObject({
      totalMilliseconds: z.number().int().min(1).max(120_000),
      removalMilliseconds: z.number().int().min(1).max(120_000),
      proofMilliseconds: z.number().int().min(1).max(120_000),
    }),
    containers: z.strictObject({
      scenario: containerLimitSchema,
      collector: containerLimitSchema,
      retrieval: containerLimitSchema,
      mockServer: containerLimitSchema,
    }),
    requests: z.strictObject({
      destinationServerMaximumBytes: z
        .number()
        .int()
        .min(1024)
        .max(16 * 1024 * 1024),
    }),
  })
  .superRefine((value, context) => {
    if (
      JSON.stringify(value.containers) !==
        JSON.stringify(ISOLATION_EXECUTOR_LIMITS.containers) ||
      JSON.stringify(value.cleanupTimeouts) !==
        JSON.stringify(ISOLATION_EXECUTOR_LIMITS.cleanup) ||
      JSON.stringify(value.requests) !==
        JSON.stringify(ISOLATION_EXECUTOR_LIMITS.requests) ||
      value.cleanupTimeouts.removalMilliseconds +
        value.cleanupTimeouts.proofMilliseconds !==
        value.cleanupTimeouts.totalMilliseconds ||
      (value.selection.mode === "scenario" &&
        (value.selection.scenarioIds.length !== 1 ||
          value.selection.scenarioIds[0] !==
            value.selection.selector.scenarioId))
    )
      context.addIssue({ code: "custom", message: "executor policy drift" });
  });

const cleanupInventorySchema = z.strictObject({
  containers: boundedCount,
  networks: boundedCount,
  images: boundedCount,
  volumes: boundedCount,
  buildContexts: boundedCount,
  activeRunMarkers: boundedCount,
});
const cleanupEvidenceSchema = z
  .strictObject({
    outcome: z.enum(["complete", "failed", "verification-failed"]),
    removalFailureCount: z.number().int().min(0).max(8),
    remaining: cleanupInventorySchema.nullable(),
  })
  .superRefine((value, context) => {
    const remainingTotal =
      value.remaining === null
        ? undefined
        : Object.values(value.remaining).reduce(
            (total, count) => total + count,
            0,
          );
    if (
      (value.outcome === "complete" &&
        (value.removalFailureCount !== 0 || remainingTotal !== 0)) ||
      (value.outcome === "failed" &&
        (value.remaining === null ||
          (value.removalFailureCount === 0 && remainingTotal === 0))) ||
      (value.outcome === "verification-failed" && value.remaining !== null)
    )
      context.addIssue({ code: "custom", message: "cleanup evidence drift" });
  });
const headlessRequestSchema = z
  .strictObject({
    runId: runToken,
    executable: z.string().startsWith("/").max(16_384),
    arguments: z.array(z.string().max(16_384)).max(256),
    cwd: z.string().startsWith("/").max(16_384),
    environment: z.record(z.string().max(128), z.string().max(16_384)),
    stdinBase64: z.string().max(1_398_104),
    stdoutLimitBytes: z.number().int().positive().max(1_048_576),
    stderrLimitBytes: z.number().int().positive().max(1_048_576),
    monotonicStartupDeadlineMs: z.number().finite().nonnegative(),
    monotonicExecutionDeadlineMs: z.number().finite().positive(),
    monotonicShutdownDeadlineMs: z.number().finite().positive(),
    terminationGraceMs: z.number().int().nonnegative().max(60_000),
  })
  .superRefine((value, context) => {
    if (
      Object.keys(value.environment).length > 128 ||
      Object.keys(value.environment).some(
        (key) => !/^[A-Z][A-Z0-9_]{0,127}$/u.test(key),
      ) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        value.stdinBase64,
      ) ||
      Buffer.from(value.stdinBase64, "base64").byteLength > 1_048_576
    )
      context.addIssue({ code: "custom", message: "headless request drift" });
  });
const headlessTerminalReceiptSchema = z
  .strictObject({
    receiptVersion: z.literal(1),
    runId: runToken,
    requestFingerprint: z.string().regex(/^sha256:[a-f\d]{64}$/u),
    outerMonotonicDeadlineMs: z.number().finite().positive(),
    requestConstructedAtMs: z.number().finite().nonnegative(),
    translationBootAtMs: z.number().finite().nonnegative(),
    translationLocalAtMs: z.number().finite().nonnegative(),
    request: headlessRequestSchema,
    returnedAtMs: z.number().finite().nonnegative(),
    outcome: z.enum(["exited", "output-limit", "timed-out", "cleanup-failed"]),
    exitCode: z.number().int().nullable(),
    signal: z.enum(["SIGTERM", "SIGKILL"]).nullable(),
    cleanup: z.enum(["clean", "residual", "uncertain"]),
    residualProcessCount: z.number().int().nonnegative().max(256),
    processJoined: z.boolean(),
    stdinJoined: z.boolean(),
    stdoutJoined: z.boolean(),
    stderrJoined: z.boolean(),
  })
  .superRefine((value, context) => {
    const requestFingerprint = `sha256:${createHash("sha256")
      .update(JSON.stringify(value.request))
      .digest("hex")}`;
    if (
      value.request.runId !== value.runId ||
      value.requestFingerprint !== requestFingerprint ||
      value.request.monotonicStartupDeadlineMs >
        value.request.monotonicExecutionDeadlineMs ||
      value.request.monotonicExecutionDeadlineMs +
        value.request.terminationGraceMs >=
        value.request.monotonicShutdownDeadlineMs ||
      value.request.monotonicShutdownDeadlineMs !==
        value.translationLocalAtMs +
          (value.outerMonotonicDeadlineMs - value.translationBootAtMs) ||
      value.outerMonotonicDeadlineMs <= value.translationBootAtMs ||
      value.requestConstructedAtMs < value.translationLocalAtMs ||
      value.request.monotonicStartupDeadlineMs !==
        Math.min(
          value.requestConstructedAtMs + 10_000,
          value.request.monotonicShutdownDeadlineMs - 5_000,
        ) ||
      value.returnedAtMs > value.request.monotonicShutdownDeadlineMs
    )
      context.addIssue({ code: "custom", message: "headless receipt drift" });
  });

export interface IsolationPlan {
  readonly runId: string;
  readonly scenarioId: string;
  readonly manifestIdentity: string;
  readonly candidateBundleIdentity: string;
  readonly candidateRevision: string;
  readonly baseImage: string;
  readonly mockServerImage: string;
  readonly baseImageIdentity: Readonly<PreparedImageIdentity>;
  readonly mockServerImageIdentity: Readonly<PreparedImageIdentity>;
  readonly imageTag: string;
  readonly mockServerImageTag: string;
  readonly networkName: string;
  readonly collectorName: string;
  readonly retrievalName: string;
  readonly mockServerName: string;
  readonly scenarioName: string;
  readonly tmpfsMounts: readonly string[];
  readonly selection: IsolationExecutionPolicy["selection"];
  readonly maximumParallelScenarios: number;
  readonly scenarioTimeoutMilliseconds: number;
}

export type IsolationExecutionPolicy = z.infer<typeof executionPolicySchema>;
export type IsolationCleanupInventory = z.infer<typeof cleanupInventorySchema>;
export type PreparedImageIdentity = z.infer<typeof preparedImageIdentitySchema>;
export type HeadlessTerminalReceipt = z.infer<
  typeof headlessTerminalReceiptSchema
>;
export interface PreparedImageAuthority {
  readonly baseImageIdentity: PreparedImageIdentity;
  readonly mockServerImageIdentity: PreparedImageIdentity;
}

const isolationEvidenceSchema = z
  .strictObject({
    evidenceVersion: z.literal(2),
    runId: runToken,
    scenarioId: id,
    manifestIdentity: digest,
    candidateBundleIdentity: digest,
    candidateRevision: z.string().regex(/^[a-f\d]{40}$/u),
    baseImage: imageReference,
    mockServerImage: imageReference,
    baseImageIdentity: preparedImageIdentitySchema,
    mockServerImageIdentity: preparedImageIdentitySchema,
    builtImageDigest: digest.nullable(),
    builtMockServerImageDigest: digest.nullable(),
    networkMode: z.literal("internal-only"),
    hostMountCount: z.literal(0),
    readOnlyRootFilesystem: z.literal(true),
    tmpfsMounts: z
      .array(z.enum(SCENARIO_TMPFS_MOUNTS))
      .length(SCENARIO_TMPFS_MOUNTS.length)
      .refine(
        (value) =>
          JSON.stringify(value) === JSON.stringify(SCENARIO_TMPFS_MOUNTS),
      ),
    executionPolicy: executionPolicySchema,
    cleanup: cleanupEvidenceSchema,
    headlessTerminalReceipt: headlessTerminalReceiptSchema.nullable(),
    outcome: z.enum(["passed", "failed", "interrupted"]),
  })
  .superRefine((value, context) => {
    const runtimeInspectionUnavailable =
      value.executionPolicy.runtimeInspection.outcome === "unavailable";
    if (
      value.executionPolicy.selection.manifestIdentity !==
        value.manifestIdentity ||
      value.baseImageIdentity.image !== value.baseImage ||
      value.mockServerImageIdentity.image !== value.mockServerImage ||
      !value.executionPolicy.selection.scenarioIds.includes(value.scenarioId) ||
      (runtimeInspectionUnavailable &&
        (value.outcome === "passed" ||
          value.builtImageDigest !== null ||
          value.builtMockServerImageDigest !== null)) ||
      (value.builtMockServerImageDigest !== null &&
        value.builtImageDigest === null) ||
      (value.outcome === "passed" &&
        (value.builtImageDigest === null ||
          value.builtMockServerImageDigest === null ||
          value.headlessTerminalReceipt === null ||
          value.headlessTerminalReceipt.outcome !== "exited" ||
          value.headlessTerminalReceipt.exitCode !== 0 ||
          value.headlessTerminalReceipt.signal !== null ||
          value.headlessTerminalReceipt.cleanup !== "clean" ||
          value.headlessTerminalReceipt.residualProcessCount !== 0 ||
          !value.headlessTerminalReceipt.processJoined ||
          !value.headlessTerminalReceipt.stdinJoined ||
          !value.headlessTerminalReceipt.stdoutJoined ||
          !value.headlessTerminalReceipt.stderrJoined)) ||
      (value.headlessTerminalReceipt !== null &&
        (value.headlessTerminalReceipt.runId !== value.runId ||
          value.headlessTerminalReceipt.returnedAtMs >
            value.headlessTerminalReceipt.request.monotonicShutdownDeadlineMs))
    )
      context.addIssue({ code: "custom", message: "evidence binding drift" });
  });

export type IsolationEvidence = z.infer<typeof isolationEvidenceSchema>;

export interface IsolationDriver {
  inspectExecutionPolicy(
    plan: IsolationPlan,
    signal: AbortSignal,
  ): Promise<unknown>;
  buildImage(plan: IsolationPlan, signal: AbortSignal): Promise<string>;
  buildMockServerImage(
    plan: IsolationPlan,
    signal: AbortSignal,
  ): Promise<string>;
  createNetwork(plan: IsolationPlan, signal: AbortSignal): Promise<void>;
  startCollector(plan: IsolationPlan, signal: AbortSignal): Promise<void>;
  startRetrieval(plan: IsolationPlan, signal: AbortSignal): Promise<void>;
  startMockServer(plan: IsolationPlan, signal: AbortSignal): Promise<void>;
  runScenario(
    plan: IsolationPlan,
    signal: AbortSignal,
  ): Promise<
    Readonly<{ receipt: HeadlessTerminalReceipt; succeeded: boolean }>
  >;
  recordEvidence(evidence: IsolationEvidence): Promise<void>;
  removeContainer(name: string): Promise<void>;
  removeNetwork(name: string): Promise<void>;
  removeImage(tag: string): Promise<void>;
  removeContext(runId: string): Promise<void>;
  inspectCleanup(plan: IsolationPlan): Promise<unknown>;
}

export const compileIsolationExecutionPolicy = (
  input: unknown,
): Readonly<IsolationExecutionPolicy> => {
  const parsed = executionPolicySchema.safeParse(input);
  if (!parsed.success) throw new Error("integration.isolation.runtime-policy");
  return deepFreeze(structuredClone(parsed.data));
};

export const compileIsolationEvidence = (
  input: unknown,
  authority?: PreparedImageAuthority,
): Readonly<IsolationEvidence> => {
  const parsed = isolationEvidenceSchema.safeParse(input);
  const parsedAuthority =
    authority === undefined
      ? undefined
      : z
          .strictObject({
            baseImageIdentity: preparedImageIdentitySchema,
            mockServerImageIdentity: preparedImageIdentitySchema,
          })
          .safeParse(authority);
  if (
    !parsed.success ||
    (parsedAuthority !== undefined &&
      (!parsedAuthority.success ||
        JSON.stringify(parsed.data.baseImageIdentity) !==
          JSON.stringify(parsedAuthority.data.baseImageIdentity) ||
        JSON.stringify(parsed.data.mockServerImageIdentity) !==
          JSON.stringify(parsedAuthority.data.mockServerImageIdentity)))
  )
    throw new Error("integration.isolation.evidence");
  return deepFreeze(structuredClone(parsed.data));
};

export const createIsolationPlan = (input: {
  readonly scenario: CapabilityScenario;
  readonly manifestIdentity: string;
  readonly candidate: CandidateEvidence;
  readonly runToken: string;
  readonly baseImageIdentity: unknown;
  readonly mockServerImageIdentity: unknown;
  readonly selection: unknown;
  readonly maximumParallelScenarios: number;
  readonly scenarioTimeoutMilliseconds: number;
}): Readonly<IsolationPlan> => {
  const parsedToken = runToken.safeParse(input.runToken);
  const parsedSelection = selectionPolicySchema.safeParse(input.selection);
  const parsedBaseImageIdentity = preparedImageIdentitySchema.safeParse(
    input.baseImageIdentity,
  );
  const parsedMockServerImageIdentity = preparedImageIdentitySchema.safeParse(
    input.mockServerImageIdentity,
  );
  if (
    !parsedToken.success ||
    !parsedSelection.success ||
    !parsedBaseImageIdentity.success ||
    !parsedMockServerImageIdentity.success ||
    !digest.safeParse(input.manifestIdentity).success ||
    !imageReference.safeParse(input.scenario.image).success ||
    !imageReference.safeParse(input.scenario.mockServerImage).success ||
    parsedBaseImageIdentity.data.image !== input.scenario.image ||
    parsedMockServerImageIdentity.data.image !==
      input.scenario.mockServerImage ||
    parsedSelection.data.manifestIdentity !== input.manifestIdentity ||
    !parsedSelection.data.scenarioIds.includes(input.scenario.scenarioId) ||
    !Number.isSafeInteger(input.maximumParallelScenarios) ||
    input.maximumParallelScenarios < 1 ||
    input.maximumParallelScenarios > 16 ||
    !Number.isSafeInteger(input.scenarioTimeoutMilliseconds) ||
    input.scenarioTimeoutMilliseconds < 1 ||
    input.scenarioTimeoutMilliseconds > 30 * 60 * 1000
  )
    throw new Error("integration.isolation.plan");
  const prefix = `agentscope-int-${parsedToken.data}`;
  return deepFreeze({
    runId: parsedToken.data,
    scenarioId: input.scenario.scenarioId,
    manifestIdentity: input.manifestIdentity,
    candidateBundleIdentity: input.candidate.bundleIdentity,
    candidateRevision: input.candidate.candidateRevision,
    baseImage: input.scenario.image,
    mockServerImage: input.scenario.mockServerImage,
    baseImageIdentity: parsedBaseImageIdentity.data,
    mockServerImageIdentity: parsedMockServerImageIdentity.data,
    imageTag: `${prefix}:candidate`,
    mockServerImageTag: `${prefix}:mockserver`,
    networkName: `${prefix}-network`,
    collectorName: `${prefix}-collector`,
    retrievalName: `${prefix}-retrieval`,
    mockServerName: `${prefix}-mockserver`,
    scenarioName: `${prefix}-scenario`,
    tmpfsMounts: SCENARIO_TMPFS_MOUNTS,
    selection: parsedSelection.data,
    maximumParallelScenarios: input.maximumParallelScenarios,
    scenarioTimeoutMilliseconds: input.scenarioTimeoutMilliseconds,
  });
};

const unavailableExecutionPolicyFor = (
  plan: IsolationPlan,
): Readonly<IsolationExecutionPolicy> =>
  compileIsolationExecutionPolicy({
    policyVersion: 1,
    runtimeInspection: { outcome: "unavailable", identity: null },
    selection: plan.selection,
    maximumParallelScenarios: plan.maximumParallelScenarios,
    scenarioTimeoutMilliseconds: plan.scenarioTimeoutMilliseconds,
    cleanupTimeouts: ISOLATION_EXECUTOR_LIMITS.cleanup,
    containers: ISOLATION_EXECUTOR_LIMITS.containers,
    requests: ISOLATION_EXECUTOR_LIMITS.requests,
  });

const cleanup = async (
  plan: IsolationPlan,
  driver: IsolationDriver,
): Promise<number> => {
  const operations = [
    () => driver.removeContainer(plan.scenarioName),
    () => driver.removeContainer(plan.collectorName),
    () => driver.removeContainer(plan.retrievalName),
    () => driver.removeContainer(plan.mockServerName),
    () => driver.removeNetwork(plan.networkName),
    () => driver.removeImage(plan.imageTag),
    () => driver.removeImage(plan.mockServerImageTag),
    () => driver.removeContext(plan.runId),
  ];
  let failureCount = 0;
  for (const operation of operations) {
    try {
      await operation();
    } catch {
      failureCount += 1;
    }
  }
  return failureCount;
};

export const executeIsolationPlan = async (
  plan: IsolationPlan,
  driver: IsolationDriver,
  signal: AbortSignal,
): Promise<Readonly<IsolationEvidence>> => {
  let executionPolicy = unavailableExecutionPolicyFor(plan);
  let imageDigest: string | undefined;
  let mockServerImageDigest: string | undefined;
  let failure: unknown;
  let headlessTerminalReceipt: HeadlessTerminalReceipt | null = null;
  let workOutcome: IsolationEvidence["outcome"];
  try {
    executionPolicy = compileIsolationExecutionPolicy(
      await driver.inspectExecutionPolicy(plan, signal),
    );
    if (signal.aborted) throw new Error("integration.isolation.interrupted");
    const builtImageDigest = await driver.buildImage(plan, signal);
    if (!digest.safeParse(builtImageDigest).success)
      throw new Error("integration.isolation.image-digest");
    imageDigest = builtImageDigest;
    const builtMockServerImageDigest = await driver.buildMockServerImage(
      plan,
      signal,
    );
    if (!digest.safeParse(builtMockServerImageDigest).success)
      throw new Error("integration.isolation.image-digest");
    mockServerImageDigest = builtMockServerImageDigest;
    if (signal.aborted) throw new Error("integration.isolation.interrupted");
    await driver.createNetwork(plan, signal);
    await driver.startCollector(plan, signal);
    await driver.startRetrieval(plan, signal);
    await driver.startMockServer(plan, signal);
    const scenarioResult = await driver.runScenario(plan, signal);
    headlessTerminalReceipt = headlessTerminalReceiptSchema.parse(
      scenarioResult.receipt,
    );
    if (!scenarioResult.succeeded)
      throw new Error("integration.isolation.scenario-failed");
    workOutcome = "passed";
  } catch (error) {
    failure = error;
    workOutcome = signal.aborted ? "interrupted" : "failed";
  }
  const removalFailureCount = await cleanup(plan, driver);
  let cleanupInventory: IsolationCleanupInventory | null = null;
  let cleanupInspectionFailed = false;
  try {
    const parsed = cleanupInventorySchema.safeParse(
      await driver.inspectCleanup(plan),
    );
    if (!parsed.success) throw new Error("integration.isolation.cleanup");
    cleanupInventory = parsed.data;
  } catch {
    cleanupInspectionFailed = true;
  }
  const remainingCount =
    cleanupInventory === null
      ? undefined
      : Object.values(cleanupInventory).reduce(
          (total, count) => total + count,
          0,
        );
  const cleanupOutcome = cleanupInspectionFailed
    ? ("verification-failed" as const)
    : removalFailureCount === 0 && remainingCount === 0
      ? ("complete" as const)
      : ("failed" as const);
  const evidence = compileIsolationEvidence(
    {
      evidenceVersion: 2,
      runId: plan.runId,
      scenarioId: plan.scenarioId,
      manifestIdentity: plan.manifestIdentity,
      candidateBundleIdentity: plan.candidateBundleIdentity,
      candidateRevision: plan.candidateRevision,
      baseImage: plan.baseImage,
      mockServerImage: plan.mockServerImage,
      baseImageIdentity: plan.baseImageIdentity,
      mockServerImageIdentity: plan.mockServerImageIdentity,
      builtImageDigest: imageDigest ?? null,
      builtMockServerImageDigest: mockServerImageDigest ?? null,
      networkMode: "internal-only" as const,
      hostMountCount: 0 as const,
      readOnlyRootFilesystem: true as const,
      tmpfsMounts: plan.tmpfsMounts,
      executionPolicy,
      cleanup: {
        outcome: cleanupOutcome,
        removalFailureCount,
        remaining: cleanupInventory,
      },
      headlessTerminalReceipt,
      outcome: workOutcome,
    },
    {
      baseImageIdentity: plan.baseImageIdentity,
      mockServerImageIdentity: plan.mockServerImageIdentity,
    },
  );
  await driver.recordEvidence(evidence);
  if (cleanupOutcome !== "complete") {
    throw new Error("integration.isolation.cleanup");
  }
  if (failure !== undefined) {
    if (workOutcome === "interrupted")
      throw new Error("integration.isolation.interrupted");
    if (failure instanceof Error) throw failure;
    throw new Error("integration.isolation.failed");
  }
  return evidence;
};
