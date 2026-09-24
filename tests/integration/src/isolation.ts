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

export const SCENARIO_HOME = "/home/agentscope" as const;

// Production CLI ignores ambient AGENTSCOPE_HOME. Its owned hook launcher is
// installed under HOME/.agentscope/bin and must be executable in this guest.
export const scenarioTmpfsIsExecutable = (path: string): boolean =>
  path === SCENARIO_HOME;

export const SCENARIO_TMPFS_MOUNTS = deepFreeze([
  SCENARIO_HOME,
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
    removalFailureCount: z.number().int().min(0).max(9),
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
    termRequested: z.boolean(),
    killRequested: z.boolean(),
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
const ptyGeometrySchema = z.strictObject({
  columns: z.number().int().min(1).max(512),
  rows: z.number().int().min(1).max(512),
});
const ptyProcessAuthoritySchema = z
  .strictObject({
    runId: runToken,
    requestFingerprint: z.string().regex(/^sha256:[a-f\d]{64}$/u),
    executable: z.string().startsWith("/").max(16_384),
    arguments: z.array(z.string().max(16_384)).max(256),
    cwd: z.string().startsWith("/").max(16_384),
    environment: z.record(z.string().max(128), z.string().max(16_384)),
    inputBytes: z.number().int().nonnegative().max(1_048_576),
    inputSha256: z.string().regex(/^[a-f\d]{64}$/u),
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
      )
    )
      context.addIssue({ code: "custom", message: "pty process drift" });
  });
const ptyRequestedActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("resize"), geometry: ptyGeometrySchema }),
  z.strictObject({
    action: z.literal("input"),
    byteLength: z.number().int().positive().max(1_048_576),
    inputSha256: z.string().regex(/^[a-f\d]{64}$/u),
  }),
  z.strictObject({ action: z.literal("eof") }),
  z.strictObject({ action: z.literal("wait-for-semantic-completion") }),
  z.strictObject({
    action: z.literal("wait-for-post-submission-idle-prompt"),
  }),
  z.strictObject({
    action: z.literal("checkpoint-process-topology"),
    topology: z.literal("root-with-contained-process-set"),
  }),
  z.strictObject({ action: z.literal("interrupt-byte"), byte: z.literal(3) }),
  z.strictObject({
    action: z.literal("signal"),
    signal: z.enum(["SIGINT", "SIGTERM", "SIGKILL"]),
  }),
]);
const ptyObservedActionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("resize"),
    geometry: ptyGeometrySchema,
    monotonicAtMs: z.number().finite().nonnegative(),
  }),
  z.strictObject({
    action: z.literal("input"),
    byteLength: z.number().int().positive().max(1_048_576),
    inputSha256: z.string().regex(/^[a-f\d]{64}$/u),
    monotonicAtMs: z.number().finite().nonnegative(),
  }),
  z.strictObject({
    action: z.literal("eof"),
    monotonicAtMs: z.number().finite().nonnegative(),
  }),
  z.strictObject({
    action: z.literal("wait-for-semantic-completion"),
    monotonicAtMs: z.number().finite().nonnegative(),
  }),
  z.strictObject({
    action: z.literal("wait-for-post-submission-idle-prompt"),
    monotonicAtMs: z.number().finite().nonnegative(),
  }),
  z.strictObject({
    action: z.literal("checkpoint-process-topology"),
    topology: z.literal("root-with-contained-process-set"),
    monotonicAtMs: z.number().finite().nonnegative(),
  }),
  z.strictObject({
    action: z.literal("interrupt-byte"),
    byte: z.literal(3),
    monotonicAtMs: z.number().finite().nonnegative(),
  }),
  z.strictObject({
    action: z.literal("signal"),
    signal: z.enum(["SIGINT", "SIGTERM", "SIGKILL"]),
    targetStartIdentity: z.string().min(1).max(256),
    monotonicAtMs: z.number().finite().nonnegative(),
  }),
]);
const ptySnapshotSchema = z.strictObject({
  snapshotVersion: z.literal(1),
  geometry: ptyGeometrySchema,
  cursor: z.strictObject({
    column: z.number().int().min(0).max(511),
    row: z.number().int().min(0).max(511),
  }),
  alternateScreen: z.boolean(),
  cursorVisible: z.boolean(),
  outputBytes: z.number().int().min(0).max(1_048_576),
  printableCellCount: z.number().int().min(0).max(65_536),
  nonEmptyLineCount: z.number().int().min(0).max(512),
  malformedControlCount: z.number().int().min(0).max(1_048_576),
  unsupportedControlCount: z.number().int().min(0).max(1_048_576),
  sawCursorPositionQuery: z.boolean(),
  titlePresent: z.boolean(),
  titleSha256: z
    .string()
    .regex(/^[a-f\d]{64}$/u)
    .nullable(),
  screenSha256: z.string().regex(/^[a-f\d]{64}$/u),
  semanticState: z.enum([
    "active",
    "ready",
    "completed",
    "credential-prompt",
    "malformed-control",
    "output-limit",
  ]),
});
const ptyTerminalReceiptRecordSchema = z.strictObject({
  receiptVersion: z.literal(1),
  transport: z.literal("pty"),
  scenarioId: id,
  runId: runToken,
  requestFingerprint: z.string().regex(/^sha256:[a-f\d]{64}$/u),
  processRequestFingerprint: z.string().regex(/^sha256:[a-f\d]{64}$/u),
  processStartIdentity: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/u),
  inputBytes: z.number().int().nonnegative().max(1_048_576),
  inputSha256: z.string().regex(/^[a-f\d]{64}$/u),
  readinessObserved: z.boolean(),
  challengedReadinessProgress: z
    .strictObject({
      marker: z.boolean(),
      synchronizedFrame: z.boolean(),
      styledGlyph: z.boolean(),
      requiredText: z.boolean(),
      terminalProtocol: z.enum(["complete", "incomplete", "rejected"]),
      protocolRejectionKind: z.enum(["none", "order", "mode", "reset"]),
      protocolRejectedAtPhase: z.number().int().min(0).max(6).nullable(),
      protocolRejectedStep: z.number().int().min(1).max(6).nullable(),
      protocolRejectedModePrefix: z.enum(["greater", "less"]).nullable(),
      protocolRejectedModeValue: z.number().int().min(0).max(31).nullable(),
      readinessEverObserved: z.boolean(),
      screenRevoked: z.boolean(),
    })
    .optional(),
  checkpointProgressDiagnostic: z
    .enum([
      "not-requested",
      "no-live-readiness",
      "terminal-order-rejected",
      "terminal-reply-unsettled",
      "protocol-not-ready",
      "deadline",
      "ready-gate-other",
      "ready-gate-open",
      "topology-root-missing",
      "topology-nonroot-missing",
      "topology-identity-conflict",
      "publication-unsettled",
      "advanced",
    ])
    .optional(),
  postSubmissionIdleDiagnostic: z
    .enum([
      "not-armed",
      "response-not-observed",
      "idle-frame-not-observed",
      "idle-frame-rejected",
      "idle-readiness-revoked",
      "idle-ready",
    ])
    .optional(),
  postSubmissionIdleAtTitleDiagnostic: z
    .enum([
      "title-not-observed",
      "not-armed",
      "response-not-observed",
      "idle-frame-not-observed",
      "idle-frame-rejected",
      "idle-readiness-revoked",
      "idle-ready",
      "idle-revoked-protocol",
      "idle-revoked-screen",
      "idle-revoked-unclassified",
      "idle-revoked-combined-sync",
      "idle-revoked-alternate-screen-enter",
      "idle-revoked-alternate-screen-exit",
      "idle-revoked-autowrap-enable",
      "idle-revoked-autowrap-disable",
      "idle-revoked-scroll-region",
      "idle-revoked-screen-edit",
      "idle-revoked-cursor-restore",
      "idle-revoked-reverse-index",
      "idle-revoked-tab-stop-set",
      "idle-revoked-charset",
      "idle-revoked-tab",
      "idle-revoked-untrusted-cell",
      "idle-revoked-rendition",
    ])
    .optional(),
  actions: z.array(ptyObservedActionSchema).max(64),
  outerMonotonicDeadlineMs: z.number().finite().positive(),
  requestConstructedAtMs: z.number().finite().nonnegative(),
  translationBootAtMs: z.number().finite().nonnegative(),
  translationLocalAtMs: z.number().finite().nonnegative(),
  request: z.strictObject({
    process: ptyProcessAuthoritySchema,
    completion: z.strictObject({ kind: z.literal("semantic-marker") }),
    readiness: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("semantic-marker") }),
      z.strictObject({
        kind: z.literal("challenge-marker"),
        challenge: z.string().regex(/^[a-f\d]{64}$/u),
      }),
      z.strictObject({
        kind: z.literal("challenge-process-topology"),
        challenge: z.string().regex(/^[a-f\d]{64}$/u),
      }),
      z.strictObject({
        kind: z.literal("challenge-styled-text"),
        challenge: z.string().regex(/^[a-f\d]{64}$/u),
        text: z.string().length(1),
        requiredText: z.string().min(1).max(32),
        postSubmissionResponseText: z.string().min(65).max(128).optional(),
        requiredTerminalProtocol: z.literal("csi-u-flags-7-query-v1"),
        bold: z.boolean(),
        dim: z.boolean(),
      }),
      z.strictObject({
        kind: z.literal("styled-text-after-completion"),
        text: z.string().min(1).max(4),
        bold: z.boolean(),
        dim: z.boolean(),
      }),
    ]),
    initialGeometry: ptyGeometrySchema,
    interaction: z.strictObject({
      trigger: z.enum(["semantic-ready", "immediate"]),
      actions: z.array(ptyRequestedActionSchema).min(1).max(64),
    }),
    interpreter: z.strictObject({
      path: z.string().startsWith("/").max(16_384),
      sha256: z.string().regex(/^[a-f\d]{64}$/u),
    }),
    scriptSha256: z.string().regex(/^[a-f\d]{64}$/u),
  }),
  returnedAtMs: z.number().finite().nonnegative(),
  isTTY: z.literal(true),
  observedGeometry: ptyGeometrySchema,
  observedCanonicalMode: z.boolean(),
  eofByte: z.number().int().min(0).max(255),
  eofByteWritten: z.boolean(),
  inputBytesWritten: z.number().int().min(0).max(1_048_576),
  outcome: z.enum([
    "completed",
    "signaled",
    "exited-nonzero",
    "aborted",
    "timeout",
    "output-limit",
    "transport-failed",
    "input-incomplete",
  ]),
  outputBytes: z.number().int().min(0).max(1_048_576),
  outputSha256: z.string().regex(/^[a-f\d]{64}$/u),
  finalSnapshot: ptySnapshotSchema,
  exitCode: z.number().int().min(0).max(255).nullable(),
  signal: z.enum(["SIGINT", "SIGTERM", "SIGKILL"]).nullable(),
  cleanup: z.enum(["clean", "residual", "uncertain"]),
  residualProcessCount: z.number().int().nonnegative().max(256),
  processJoined: z.boolean(),
  terminalInputJoined: z.boolean(),
  terminalOutputJoined: z.boolean(),
  terminalTransportClosed: z.boolean(),
});

type PtyTerminalReceiptRecord = z.infer<typeof ptyTerminalReceiptRecordSchema>;

// The live challenged screen may clear on TUI exit. Only one kernel-recorded
// topology checkpoint in a complete, settled Codex receipt proves earlier
// readiness; the outer envelope separately binds the exact manifest plan.
const historicalCodexReadinessMatches = (
  value: PtyTerminalReceiptRecord,
  requestedActionKinds: readonly string[],
  observedActionKinds: readonly string[],
): boolean => {
  const checkpointIndex = requestedActionKinds.indexOf(
    "checkpoint-process-topology",
  );
  return (
    value.scenarioId === "codex-tui-trace-smoke" &&
    value.request.readiness.kind === "challenge-styled-text" &&
    value.request.interaction.trigger === "immediate" &&
    value.outcome === "completed" &&
    value.finalSnapshot.semanticState === "completed" &&
    value.exitCode === 0 &&
    value.signal === null &&
    value.cleanup === "clean" &&
    value.residualProcessCount === 0 &&
    value.processJoined &&
    value.terminalInputJoined &&
    value.terminalOutputJoined &&
    value.terminalTransportClosed &&
    checkpointIndex >= 0 &&
    checkpointIndex ===
      requestedActionKinds.lastIndexOf("checkpoint-process-topology") &&
    value.actions.length === requestedActionKinds.length &&
    observedActionKinds[checkpointIndex] === "checkpoint-process-topology"
  );
};

const challengedReadinessProgressConsistent = (
  progress: z.infer<
    typeof ptyTerminalReceiptRecordSchema
  >["challengedReadinessProgress"],
): boolean => {
  if (progress === undefined) return true;
  if (
    progress.readinessEverObserved &&
    (!progress.marker ||
      !progress.synchronizedFrame ||
      !progress.styledGlyph ||
      !progress.requiredText ||
      progress.terminalProtocol === "incomplete" ||
      (progress.terminalProtocol === "rejected" &&
        progress.protocolRejectedAtPhase !== 6))
  )
    return false;
  if (progress.protocolRejectionKind === "none")
    return (
      progress.terminalProtocol !== "rejected" &&
      progress.protocolRejectedAtPhase === null &&
      progress.protocolRejectedStep === null &&
      progress.protocolRejectedModePrefix === null &&
      progress.protocolRejectedModeValue === null
    );
  return (
    progress.terminalProtocol === "rejected" &&
    progress.protocolRejectedAtPhase !== null &&
    (progress.protocolRejectionKind === "order"
      ? progress.protocolRejectedStep !== null &&
        progress.protocolRejectedStep !==
          progress.protocolRejectedAtPhase + 1 &&
        progress.protocolRejectedModePrefix === null &&
        progress.protocolRejectedModeValue === null
      : progress.protocolRejectionKind === "mode"
        ? progress.protocolRejectedStep === null &&
          progress.protocolRejectedModePrefix !== null &&
          progress.protocolRejectedModeValue !== null &&
          !(
            progress.protocolRejectedModePrefix === "greater" &&
            progress.protocolRejectedModeValue === 7
          )
        : progress.protocolRejectedStep === null &&
          progress.protocolRejectedModePrefix === null &&
          progress.protocolRejectedModeValue === null)
  );
};

const checkpointProgressConsistent = (
  value: PtyTerminalReceiptRecord,
): boolean => {
  const diagnostic = value.checkpointProgressDiagnostic;
  if (diagnostic === undefined) return true;
  const requested = value.request.interaction.actions.some(
    ({ action }) => action === "checkpoint-process-topology",
  );
  const observed = value.actions.some(
    ({ action }) => action === "checkpoint-process-topology",
  );
  return (
    value.request.readiness.kind === "challenge-styled-text" &&
    (requested
      ? diagnostic !== "not-requested"
      : diagnostic === "not-requested") &&
    ["advanced", "publication-unsettled"].includes(diagnostic) === observed
  );
};

const ptyTerminalReceiptSchema = ptyTerminalReceiptRecordSchema.superRefine(
  (value, context) => {
    const request = value.request.process;
    const challengeReadiness =
      value.request.readiness.kind === "challenge-marker" ||
      value.request.readiness.kind === "challenge-process-topology" ||
      value.request.readiness.kind === "challenge-styled-text";
    const finalGeometry = value.request.interaction.actions.reduce(
      (geometry, action) =>
        action.action === "resize" ? action.geometry : geometry,
      value.request.initialGeometry,
    );
    const observedActionKinds = value.actions.map(({ action }) => action);
    const requestedActionKinds = value.request.interaction.actions.map(
      ({ action }) => action,
    );
    const historicalCodexReadiness = historicalCodexReadinessMatches(
      value,
      requestedActionKinds,
      observedActionKinds,
    );
    const requestFingerprint = `sha256:${createHash("sha256")
      .update(
        JSON.stringify({
          processRequestFingerprint: value.processRequestFingerprint,
          completion: value.request.completion,
          readiness: value.request.readiness,
          initialGeometry: value.request.initialGeometry,
          interaction: {
            actions: value.request.interaction.actions,
            trigger: value.request.interaction.trigger,
          },
          interpreter: value.request.interpreter,
          scriptSha256: value.request.scriptSha256,
          inputBytes: value.inputBytes,
          inputSha256: value.inputSha256,
        }),
      )
      .digest("hex")}`;
    if (
      request.runId !== value.runId ||
      value.requestFingerprint !== requestFingerprint ||
      value.processRequestFingerprint !== request.requestFingerprint ||
      value.inputBytes !== request.inputBytes ||
      value.inputSha256 !== request.inputSha256 ||
      !challengedReadinessProgressConsistent(
        value.challengedReadinessProgress,
      ) ||
      !checkpointProgressConsistent(value) ||
      (!value.readinessObserved && !historicalCodexReadiness) ||
      (challengeReadiness
        ? value.request.interaction.trigger !== "immediate"
        : value.request.interaction.trigger !== "semantic-ready") ||
      request.monotonicStartupDeadlineMs !==
        Math.min(
          value.requestConstructedAtMs + 10_000,
          request.monotonicShutdownDeadlineMs - 5_000,
        ) ||
      request.monotonicExecutionDeadlineMs !==
        request.monotonicShutdownDeadlineMs - 5_000 ||
      request.terminationGraceMs !== 1_000 ||
      request.monotonicShutdownDeadlineMs !==
        value.translationLocalAtMs +
          (value.outerMonotonicDeadlineMs - value.translationBootAtMs) ||
      value.requestConstructedAtMs < value.translationLocalAtMs ||
      value.returnedAtMs > request.monotonicShutdownDeadlineMs ||
      JSON.stringify(finalGeometry) !==
        JSON.stringify(value.observedGeometry) ||
      JSON.stringify(value.finalSnapshot.geometry) !==
        JSON.stringify(value.observedGeometry) ||
      JSON.stringify(observedActionKinds) !==
        JSON.stringify(requestedActionKinds) ||
      value.actions.some((observed, index) => {
        const requested = value.request.interaction.actions[index];
        if (requested?.action !== observed.action) return true;
        if (requested.action === "resize" && observed.action === "resize")
          return (
            JSON.stringify(requested.geometry) !==
            JSON.stringify(observed.geometry)
          );
        if (requested.action === "input" && observed.action === "input")
          return (
            requested.byteLength !== observed.byteLength ||
            requested.inputSha256 !== observed.inputSha256
          );
        if (
          requested.action === "interrupt-byte" &&
          observed.action === "interrupt-byte"
        )
          return requested.byte !== observed.byte;
        return (
          requested.action === "signal" &&
          observed.action === "signal" &&
          (requested.signal !== observed.signal ||
            observed.targetStartIdentity !== value.processStartIdentity)
        );
      }) ||
      value.actions.some(
        (action, index) =>
          action.monotonicAtMs < value.requestConstructedAtMs ||
          action.monotonicAtMs > request.monotonicExecutionDeadlineMs ||
          action.monotonicAtMs > value.returnedAtMs ||
          (index > 0 &&
            action.monotonicAtMs < value.actions[index - 1]!.monotonicAtMs),
      ) ||
      value.finalSnapshot.outputBytes !== value.outputBytes ||
      value.outputBytes >
        Math.min(request.stdoutLimitBytes, request.stderrLimitBytes) ||
      value.inputBytesWritten > value.inputBytes ||
      (value.eofByteWritten && value.inputBytesWritten !== value.inputBytes)
    )
      context.addIssue({ code: "custom", message: "pty receipt drift" });
  },
);

export interface IsolationPlan {
  readonly runId: string;
  readonly scenarioId: string;
  readonly executionMode: "headless" | "interactive";
  readonly terminalAction:
    "none" | "eof" | "post-completion-input" | "post-completion-controls";
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
  readonly controlVolumeName: string | null;
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
export type PtyTerminalReceipt = z.infer<typeof ptyTerminalReceiptSchema>;
export type ScenarioTerminalReceipt =
  HeadlessTerminalReceipt | PtyTerminalReceipt;
export interface PreparedImageAuthority {
  readonly baseImageIdentity: PreparedImageIdentity;
  readonly mockServerImageIdentity: PreparedImageIdentity;
}

const headlessReceiptPasses = (
  receipt: HeadlessTerminalReceipt | null,
): boolean =>
  receipt !== null &&
  receipt.outcome === "exited" &&
  receipt.exitCode === 0 &&
  receipt.signal === null &&
  receipt.cleanup === "clean" &&
  receipt.residualProcessCount === 0 &&
  !receipt.termRequested &&
  !receipt.killRequested &&
  receipt.processJoined &&
  receipt.stdinJoined &&
  receipt.stdoutJoined &&
  receipt.stderrJoined;

const ptyReceiptPasses = (
  receipt: PtyTerminalReceipt | null,
  terminalAction: IsolationPlan["terminalAction"],
): boolean => {
  if (receipt === null) return false;
  const actions = receipt.request.interaction.actions.map(
    ({ action }) => action,
  );
  const terminalActionMatches =
    (terminalAction === "eof" &&
      actions.at(-1) === "eof" &&
      !actions.includes("wait-for-semantic-completion") &&
      !actions.includes("interrupt-byte")) ||
    (terminalAction === "post-completion-input" &&
      actions.at(-1) === "input" &&
      actions.includes("wait-for-semantic-completion") &&
      !actions.includes("eof") &&
      !actions.includes("interrupt-byte")) ||
    (terminalAction === "post-completion-controls" &&
      JSON.stringify(actions.slice(-2)) ===
        JSON.stringify(["wait-for-semantic-completion", "interrupt-byte"]));
  return (
    terminalActionMatches &&
    receipt.outcome === "completed" &&
    receipt.exitCode === 0 &&
    receipt.signal === null &&
    receipt.cleanup === "clean" &&
    receipt.residualProcessCount === 0 &&
    receipt.finalSnapshot.semanticState === "completed" &&
    receipt.eofByteWritten === (terminalAction === "eof") &&
    (terminalAction !== "eof" || receipt.observedCanonicalMode) &&
    receipt.processJoined &&
    receipt.terminalInputJoined &&
    receipt.terminalOutputJoined &&
    receipt.terminalTransportClosed
  );
};

const terminalEvidencePasses = (value: {
  executionMode: "headless" | "interactive";
  terminalAction: IsolationPlan["terminalAction"];
  headlessTerminalReceipt: HeadlessTerminalReceipt | null;
  ptyTerminalReceipt: PtyTerminalReceipt | null;
}): boolean =>
  value.executionMode === "headless"
    ? value.terminalAction === "none" &&
      value.ptyTerminalReceipt === null &&
      headlessReceiptPasses(value.headlessTerminalReceipt)
    : value.terminalAction !== "none" &&
      value.headlessTerminalReceipt === null &&
      ptyReceiptPasses(value.ptyTerminalReceipt, value.terminalAction);

const isolationEvidenceSchema = z
  .strictObject({
    evidenceVersion: z.literal(2),
    runId: runToken,
    scenarioId: id,
    manifestIdentity: digest,
    candidateBundleIdentity: digest,
    candidateRevision: z.string().regex(/^[a-f\d]{40}$/u),
    executionMode: z.enum(["headless", "interactive"]),
    terminalAction: z.enum([
      "none",
      "eof",
      "post-completion-input",
      "post-completion-controls",
    ]),
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
    ptyTerminalReceipt: ptyTerminalReceiptSchema.nullable(),
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
          !terminalEvidencePasses(value))) ||
      (value.headlessTerminalReceipt !== null &&
        (value.headlessTerminalReceipt.runId !== value.runId ||
          value.headlessTerminalReceipt.returnedAtMs >
            value.headlessTerminalReceipt.request
              .monotonicShutdownDeadlineMs)) ||
      (value.ptyTerminalReceipt !== null &&
        (value.ptyTerminalReceipt.runId !== value.runId ||
          value.ptyTerminalReceipt.scenarioId !== value.scenarioId ||
          value.ptyTerminalReceipt.returnedAtMs >
            value.ptyTerminalReceipt.request.process
              .monotonicShutdownDeadlineMs))
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
  createControlVolume(plan: IsolationPlan, signal: AbortSignal): Promise<void>;
  startCollector(plan: IsolationPlan, signal: AbortSignal): Promise<void>;
  startRetrieval(plan: IsolationPlan, signal: AbortSignal): Promise<void>;
  startMockServer(plan: IsolationPlan, signal: AbortSignal): Promise<void>;
  joinMockServer(plan: IsolationPlan, signal: AbortSignal): Promise<void>;
  runScenario(
    plan: IsolationPlan,
    signal: AbortSignal,
  ): Promise<
    Readonly<{ receipt: ScenarioTerminalReceipt; succeeded: boolean }>
  >;
  recordEvidence(evidence: IsolationEvidence): Promise<void>;
  removeContainer(name: string): Promise<void>;
  removeNetwork(name: string): Promise<void>;
  removeControlVolume(name: string): Promise<void>;
  removeImage(tag: string): Promise<void>;
  removeContext(runId: string): Promise<void>;
  inspectCleanup(plan: IsolationPlan): Promise<unknown>;
}

/* eslint-disable complexity -- one closed exact daemon terminal witness */
export const scenarioContainerTerminalWitness = (input: {
  readonly attach: {
    readonly code?: unknown;
    readonly killed?: unknown;
    readonly name?: unknown;
    readonly signal?: unknown;
  };
  readonly container: unknown;
  readonly containerId: string;
  readonly runId: string;
  readonly scenarioName: string;
  readonly waitOutput: string;
}): boolean => {
  const { attach, container, containerId, runId, scenarioName, waitOutput } =
    input;
  const record =
    typeof container === "object" && container !== null
      ? (container as Record<string, unknown>)
      : undefined;
  const config = record?.Config as Record<string, unknown> | undefined;
  const labels = config?.Labels as Record<string, unknown> | undefined;
  const state = record?.State as Record<string, unknown> | undefined;
  const exitCode = typeof attach.code === "number" ? attach.code : NaN;
  const finishedAt = state?.FinishedAt;
  const timestampMatch =
    typeof finishedAt === "string"
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u.exec(
          finishedAt,
        )
      : null;
  const canonicalFinishedAt = (() => {
    if (timestampMatch === null) return false;
    const [, year, month, day, hour, minute, second] = timestampMatch;
    const yearNumber = Number(year);
    const monthNumber = Number(month);
    const dayNumber = Number(day);
    const hourNumber = Number(hour);
    const minuteNumber = Number(minute);
    const secondNumber = Number(second);
    const leapYear =
      yearNumber % 4 === 0 &&
      (yearNumber % 100 !== 0 || yearNumber % 400 === 0);
    const daysInMonth = [
      31,
      leapYear ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ][monthNumber - 1];
    return (
      yearNumber > 1 &&
      daysInMonth !== undefined &&
      dayNumber >= 1 &&
      dayNumber <= daysInMonth &&
      hourNumber <= 23 &&
      minuteNumber <= 59 &&
      secondNumber <= 59
    );
  })();
  return (
    Number.isSafeInteger(exitCode) &&
    exitCode > 0 &&
    exitCode <= 255 &&
    attach.signal === null &&
    attach.killed === false &&
    attach.name === "Error" &&
    /^[a-f0-9]{64}$/u.test(containerId) &&
    waitOutput === `${exitCode}\n` &&
    record?.Id === containerId &&
    record?.Name === `/${scenarioName}` &&
    labels?.["com.agentscope.integration"] === "true" &&
    labels?.["com.agentscope.integration.run"] === runId &&
    record?.RestartCount === 0 &&
    state?.Status === "exited" &&
    state?.Running === false &&
    state?.Paused === false &&
    state?.Restarting === false &&
    state?.OOMKilled === false &&
    state?.Dead === false &&
    state?.Pid === 0 &&
    state?.ExitCode === exitCode &&
    state?.Error === "" &&
    canonicalFinishedAt
  );
};
/* eslint-enable complexity */

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
    executionMode: input.scenario.executionMode,
    terminalAction:
      input.scenario.executionMode === "headless"
        ? "none"
        : input.scenario.postCompletionControl !== "none"
          ? "post-completion-controls"
          : input.scenario.waitForSemanticCompletionBeforeTerminalAction
            ? "post-completion-input"
            : "eof",
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
    controlVolumeName:
      input.scenario.scenarioId === "codex-tui-trace-smoke"
        ? `${prefix}-control`
        : null,
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

type CleanupResult = Readonly<{
  failureCount: number;
  firstFailure: string | null;
  firstFailureCause: unknown;
}>;

const cleanup = async (
  plan: IsolationPlan,
  driver: IsolationDriver,
): Promise<CleanupResult> => {
  const controlVolumeName = plan.controlVolumeName;
  const operations: ReadonlyArray<readonly [string, () => Promise<void>]> = [
    ["scenario-container", () => driver.removeContainer(plan.scenarioName)],
    ["collector-container", () => driver.removeContainer(plan.collectorName)],
    ["retrieval-container", () => driver.removeContainer(plan.retrievalName)],
    [
      "mock-server-container",
      () => driver.removeContainer(plan.mockServerName),
    ],
    ["network", () => driver.removeNetwork(plan.networkName)],
    ...(controlVolumeName === null
      ? []
      : [
          [
            "control-volume",
            () => driver.removeControlVolume(controlVolumeName),
          ] as const,
        ]),
    ["scenario-image", () => driver.removeImage(plan.imageTag)],
    ["mock-server-image", () => driver.removeImage(plan.mockServerImageTag)],
    ["context", () => driver.removeContext(plan.runId)],
  ];
  let failureCount = 0;
  let firstFailure: string | null = null;
  let firstFailureCause: unknown;
  for (const [name, operation] of operations) {
    try {
      await operation();
    } catch (error) {
      failureCount += 1;
      const classified =
        name === "network" &&
        error instanceof Error &&
        /^integration\.isolation\.cleanup-network-remove$/u.test(error.message)
          ? error.message.slice("integration.isolation.cleanup-".length)
          : name;
      if (firstFailure === null) {
        firstFailure = classified;
        firstFailureCause = error instanceof Error ? error.cause : undefined;
      }
    }
  }
  return { failureCount, firstFailure, firstFailureCause };
};

const failCleanup = (
  cleanup: IsolationEvidence["cleanup"],
  result: CleanupResult,
  workFailure: unknown,
): never => {
  process.stderr.write(
    `integration.isolation.cleanup-diagnostic:${JSON.stringify(cleanup)}\n`,
  );
  throw new Error(
    result.firstFailure === null
      ? cleanup.remaining === null
        ? "integration.isolation.cleanup-inventory"
        : "integration.isolation.cleanup-remaining"
      : `integration.isolation.cleanup-${result.firstFailure}`,
    { cause: workFailure ?? result.firstFailureCause },
  );
};

/* eslint-disable max-lines-per-function -- one closed lifecycle transaction */
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
  let ptyTerminalReceipt: PtyTerminalReceipt | null = null;
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
    if (plan.controlVolumeName !== null)
      await driver.createControlVolume(plan, signal);
    await driver.startCollector(plan, signal);
    await driver.startRetrieval(plan, signal);
    await driver.startMockServer(plan, signal);
    const scenarioResult = await driver.runScenario(plan, signal);
    await driver.joinMockServer(plan, signal);
    if (plan.executionMode === "interactive")
      ptyTerminalReceipt = ptyTerminalReceiptSchema.parse(
        scenarioResult.receipt,
      );
    else
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
  const cleanupResult = await cleanup(plan, driver);
  const removalFailureCount = cleanupResult.failureCount;
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
      executionMode: plan.executionMode,
      terminalAction: plan.terminalAction,
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
      ptyTerminalReceipt,
      outcome: workOutcome,
    },
    {
      baseImageIdentity: plan.baseImageIdentity,
      mockServerImageIdentity: plan.mockServerImageIdentity,
    },
  );
  await driver.recordEvidence(evidence);
  if (cleanupOutcome !== "complete")
    failCleanup(evidence.cleanup, cleanupResult, failure);
  if (failure !== undefined) {
    if (workOutcome === "interrupted")
      throw new Error("integration.isolation.interrupted");
    if (failure instanceof Error) throw failure;
    throw new Error("integration.isolation.failed");
  }
  return evidence;
};
/* eslint-enable max-lines-per-function */
