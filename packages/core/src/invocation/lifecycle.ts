import { createHash } from "node:crypto";

import {
  reporterDeadlineRemainingMilliseconds,
  type ReporterReceiptReason,
} from "@agentscope/destinations-core";
import type { DestinationTransportExecutor } from "@agentscope/destinations-core/core-orchestration";
import type { RedactedCanonicalTrace } from "@agentscope/protocol";

import { readCapturedTraceForCore } from "../capture/runtime.js";
import type { CapturedTrace } from "../capture/types.js";
import type { CredentialBackendRegistry } from "../configuration/credential-adapter.js";
import {
  operationalStateStoreMatchesHomeForCore,
  resolveCaptureCheckpointFromSnapshotForCore,
  type CaptureCheckpointResume,
  type CaptureCheckpointInput,
  type HookOperationalEvidenceWriteResult,
  type OperationalStateSnapshot,
  type OperationalStateStore,
  type PipelineHealthInput,
  type SanitizedDiagnosticInput,
} from "../configuration/operational-state.js";
import { configurationStoreHomeForCore } from "../configuration/transaction.js";
import {
  runFailOpenTraceLifecycle,
  type CaptureAdapter,
  type CaptureResumeRequest,
  type LifecycleResult,
} from "../lifecycle.js";
import {
  routeRedactedTraceBatch,
  type RoutedConnectionResult,
  type RoutingDeliveryResult,
} from "../routing/delivery.js";
import {
  resolveCaptureInvocationSnapshot,
  type CaptureInvocationPreparationInput,
  type InvocationPreparationFailure,
} from "./snapshot.js";
import {
  commitOperationalEvidenceForCore,
  preloadOperationalStateForCore,
} from "./operational-coordinator.js";

const reporterReasonDiagnosticMapping = Object.freeze({
  version: 1 as const,
  codes: Object.freeze({
    "destination-busy": "destination-busy",
    "destination-full": "destination-full",
    "destination-corrupt": "destination-corrupt",
    "destination-migrating": "destination-migrating",
    "destination-retention": "destination-retention",
    "destination-capacity": "destination-capacity",
  } satisfies Readonly<
    Record<ReporterReceiptReason, SanitizedDiagnosticInput["code"]>
  >),
});

export type ResolvedTraceLifecycleInput = CaptureInvocationPreparationInput &
  Readonly<{
    capture: CaptureAdapter;
    credentialBackendRegistry: CredentialBackendRegistry;
    operationalStateStore: OperationalStateStore;
    transportExecutor: DestinationTransportExecutor;
  }>;

export type ResolvedRoutingLifecycleResult = RoutingDeliveryResult &
  Readonly<{
    stage: "routing";
    configurationGeneration: number;
    policyIdentity: string;
  }>;

export type ResolvedLifecycleOperationalEvidence = Readonly<{
  diagnostics: readonly Readonly<SanitizedDiagnosticInput>[];
  health: readonly Readonly<PipelineHealthInput>[];
  persistence: Readonly<{
    recorded: boolean;
    code:
      | "recorded"
      | "invalid"
      | "unavailable"
      | "deadline-exceeded"
      | "not-attempted";
  }>;
  checkpoints: HookOperationalEvidenceWriteResult["checkpoints"];
}>;

type LifecycleOutcome =
  | Exclude<LifecycleResult, { outcome: "sink-returned" }>
  | ResolvedRoutingLifecycleResult
  | InvocationPreparationFailure;

export type ResolvedTraceLifecycleResult = LifecycleOutcome &
  Readonly<{ operationalEvidence: ResolvedLifecycleOperationalEvidence }>;

type Preparation = Extract<
  Awaited<ReturnType<typeof resolveCaptureInvocationSnapshot>>,
  { ok: true }
>;

type CheckpointBoundary = Omit<
  CaptureCheckpointInput,
  "configurationGeneration" | "destinationType" | "connectionId"
>;

const skippedPersistence = Object.freeze({
  recorded: false,
  code: "not-attempted" as const,
});
const deadlinePersistence = Object.freeze({
  recorded: false,
  code: "deadline-exceeded" as const,
});
const OPERATIONAL_PERSISTENCE_CLEANUP_RESERVE_MILLISECONDS = 25;

const checkpointUnavailableDiagnostics = (
  checkpoints: readonly CaptureCheckpointInput[],
): readonly SanitizedDiagnosticInput[] =>
  checkpoints.map((checkpoint) =>
    Object.freeze({
      code: "checkpoint-unavailable" as const,
      severity: "warning" as const,
      configurationGeneration: checkpoint.configurationGeneration,
      destinationType: checkpoint.destinationType,
      connectionId: checkpoint.connectionId,
    }),
  );

const freezeEvidence = (
  diagnostics: readonly SanitizedDiagnosticInput[],
  health: readonly PipelineHealthInput[],
  persistence: ResolvedLifecycleOperationalEvidence["persistence"] = skippedPersistence,
  checkpoints: HookOperationalEvidenceWriteResult["checkpoints"] = [],
): ResolvedLifecycleOperationalEvidence =>
  Object.freeze({
    diagnostics: Object.freeze(
      diagnostics
        .filter(
          (entry, index) =>
            diagnostics.findIndex(
              (candidate) =>
                candidate.code === entry.code &&
                candidate.severity === entry.severity &&
                candidate.configurationGeneration ===
                  entry.configurationGeneration &&
                candidate.destinationType === entry.destinationType &&
                candidate.connectionId === entry.connectionId,
            ) === index,
        )
        .map((entry) => Object.freeze({ ...entry })),
    ),
    health: Object.freeze(health.map((entry) => Object.freeze({ ...entry }))),
    persistence: Object.freeze({ ...persistence }),
    checkpoints: Object.freeze(
      checkpoints.map((entry) => Object.freeze({ ...entry })),
    ),
  });

const withEvidence = (
  result: LifecycleOutcome,
  evidence: ResolvedLifecycleOperationalEvidence,
): ResolvedTraceLifecycleResult =>
  Object.freeze({ ...result, operationalEvidence: evidence });

const configurationFailure = (): InvocationPreparationFailure =>
  Object.freeze({
    ok: false,
    outcome: "failed-open",
    stage: "configuration",
    code: "configuration-unavailable",
    diagnostic: Object.freeze({
      code: "configuration-invalid",
      severity: "warning",
      configurationGeneration: null,
    }),
  });

const preparationEvidence = (
  failure: InvocationPreparationFailure,
): ResolvedLifecycleOperationalEvidence =>
  freezeEvidence(
    [failure.diagnostic],
    [
      {
        scope: "hook",
        stage: "hook-started",
        outcome:
          failure.code === "deadline-exceeded"
            ? "deadline-exceeded"
            : "suppressed",
        configurationGeneration: null,
        policyMode: null,
        receipt: null,
      },
    ],
  );

const resolvedRoutingResult = (
  preparation: Preparation,
  result: RoutingDeliveryResult,
): ResolvedRoutingLifecycleResult =>
  Object.freeze({
    ...result,
    stage: "routing",
    configurationGeneration: preparation.snapshot.configuration.generation,
    policyIdentity: preparation.snapshot.invocation.snapshot.policyIdentity,
  });

const captureCheckpointBoundary = (
  captured: CapturedTrace,
): CheckpointBoundary | undefined => {
  const value = readCapturedTraceForCore(captured);
  const session = value.captureBoundary.session;
  if (session.kind !== "native-session") return undefined;
  const adapterId = `@agentscope/harness-${value.invocation.harnessRegistryId}`;
  const sourceIdentityDigest = createHash("sha256")
    .update("agentscope.capture-checkpoint-source.v1\0", "utf8")
    .update(adapterId, "utf8")
    .update("\0", "utf8")
    .update(session.nativeIdentityKind, "utf8")
    .update("\0", "utf8")
    .update(session.nativeIdentity, "utf8")
    .digest("hex");
  return Object.freeze({
    adapterId,
    sourceIdentityDigest,
    nativeIdentityKind:
      session.nativeIdentityKind as CaptureCheckpointInput["nativeIdentityKind"],
    sourceGeneration: value.captureBoundary.generation,
    positionKind: value.captureBoundary
      .positionKind as CaptureCheckpointInput["positionKind"],
    startPosition: value.captureBoundary.startPosition,
    exclusiveEndPosition: value.captureBoundary.exclusiveEndPosition,
  });
};

const createCheckpointResolver = (
  preparation: Preparation,
  operationalSnapshot: OperationalStateSnapshot | undefined,
): Readonly<{
  resolve: (request: CaptureResumeRequest) => CaptureCheckpointResume;
  observed: () =>
    | Readonly<{
        request: CaptureResumeRequest;
        result: CaptureCheckpointResume;
      }>
    | undefined;
  close: () => void;
}> => {
  let resolution:
    | Readonly<{
        request: CaptureResumeRequest;
        result: CaptureCheckpointResume;
      }>
    | undefined;
  let closed = false;
  return Object.freeze({
    resolve(request) {
      if (closed || resolution !== undefined)
        throw new Error("core.lifecycle.invalid");
      let descriptors: PropertyDescriptorMap;
      let prototype: object | null;
      try {
        descriptors = Object.getOwnPropertyDescriptors(request);
        prototype = Reflect.getPrototypeOf(request);
      } catch {
        throw new Error("core.lifecycle.invalid");
      }
      const expectedKeys = [
        "availableStartPosition",
        "nativeIdentity",
        "nativeIdentityKind",
        "positionKind",
        "sourceGeneration",
      ];
      if (
        Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
        (prototype !== Object.prototype && prototype !== null) ||
        Object.keys(descriptors).sort().join("\0") !==
          expectedKeys.join("\0") ||
        Object.values(descriptors).some(
          (descriptor) => !("value" in descriptor),
        )
      )
        throw new Error("core.lifecycle.invalid");
      const snapshot = Object.freeze({
        availableStartPosition: descriptors.availableStartPosition!
          .value as number,
        nativeIdentity: descriptors.nativeIdentity!.value as string,
        nativeIdentityKind: descriptors.nativeIdentityKind!
          .value as CaptureResumeRequest["nativeIdentityKind"],
        positionKind: descriptors.positionKind!
          .value as CaptureResumeRequest["positionKind"],
        sourceGeneration: descriptors.sourceGeneration!.value as number,
      });
      if (
        typeof snapshot.nativeIdentity !== "string" ||
        snapshot.nativeIdentity.length === 0 ||
        snapshot.nativeIdentity.length > 1_024
      )
        throw new Error("core.lifecycle.invalid");
      const adapterId = `@agentscope/harness-${preparation.snapshot.invocation.harnessRegistryId}`;
      const sourceIdentityDigest = createHash("sha256")
        .update("agentscope.capture-checkpoint-source.v1\0", "utf8")
        .update(adapterId, "utf8")
        .update("\0", "utf8")
        .update(snapshot.nativeIdentityKind, "utf8")
        .update("\0", "utf8")
        .update(snapshot.nativeIdentity, "utf8")
        .digest("hex");
      const result = operationalSnapshot
        ? resolveCaptureCheckpointFromSnapshotForCore(operationalSnapshot, {
            adapterId,
            sourceIdentityDigest,
            nativeIdentityKind: snapshot.nativeIdentityKind,
            sourceGeneration: snapshot.sourceGeneration,
            positionKind: snapshot.positionKind,
            availableStartPosition: snapshot.availableStartPosition,
            connectionIds:
              preparation.snapshot.configuration.selectedConnectionIds,
          })
        : Object.freeze({
            disposition:
              snapshot.availableStartPosition > 0
                ? ("source-loss" as const)
                : ("unavailable" as const),
            startPosition: snapshot.availableStartPosition,
          });
      resolution = Object.freeze({ request: snapshot, result });
      return result;
    },
    observed: () => resolution,
    close() {
      closed = true;
    },
  });
};

type CheckpointResolution = NonNullable<
  ReturnType<ReturnType<typeof createCheckpointResolver>["observed"]>
>;

const checkpointResolutionDiagnostics = (
  resolution: CheckpointResolution | undefined,
  preparation: Preparation,
): readonly SanitizedDiagnosticInput[] => {
  if (resolution === undefined || resolution.result.disposition === "retained")
    return [];
  const code =
    resolution.result.disposition === "source-loss"
      ? ("native-source-loss" as const)
      : ("checkpoint-unavailable" as const);
  return preparation.snapshot.configuration.connections
    .filter((connection) =>
      preparation.snapshot.configuration.selectedConnectionIds.includes(
        connection.connectionId,
      ),
    )
    .map((connection) =>
      Object.freeze({
        code,
        severity: "warning" as const,
        configurationGeneration: preparation.snapshot.configuration.generation,
        destinationType: connection.destinationType,
        connectionId: connection.connectionId,
      }),
    );
};

const diagnosticForConnection = (
  connection: RoutedConnectionResult,
  preparation: Preparation,
): SanitizedDiagnosticInput | undefined => {
  if (connection.outcome === "accepted") return undefined;
  const configured = preparation.snapshot.configuration.connections.find(
    (entry) => entry.connectionId === connection.connectionId,
  );
  /* v8 ignore next -- routing results are minted from the same immutable
   * configured-connection snapshot used by this lookup. */
  if (!configured) return undefined;
  const code =
    (connection.reason === undefined
      ? undefined
      : reporterReasonDiagnosticMapping.codes[connection.reason]) ??
    ({
      rejected: "reporter-rejected",
      unavailable: "reporter-unavailable",
      "deadline-exceeded": "reporter-deadline-exceeded",
      "outcome-unknown": "reporter-outcome-unknown",
    }[connection.outcome] as SanitizedDiagnosticInput["code"]);
  return Object.freeze({
    code,
    severity: "warning",
    configurationGeneration: preparation.snapshot.configuration.generation,
    destinationType: configured.destinationType,
    connectionId: configured.connectionId,
  });
};

const connectionHealth = (
  connection: RoutedConnectionResult,
  preparation: Preparation,
): PipelineHealthInput => {
  const configured = preparation.snapshot.configuration.connections.find(
    (entry) => entry.connectionId === connection.connectionId,
  );
  /* v8 ignore next -- routing results are minted from the same immutable
   * configured-connection snapshot used by this lookup. */
  if (!configured) throw new Error("core.lifecycle.invalid");
  return Object.freeze({
    scope: "connection",
    stage: connection.outcome === "accepted" ? "remote-acceptance" : "delivery",
    outcome: connection.outcome,
    configurationGeneration: preparation.snapshot.configuration.generation,
    policyMode: preparation.snapshot.invocation.snapshot.redactionPolicy.mode,
    destinationType: configured.destinationType,
    connectionId: configured.connectionId,
    receipt: connection.outcome,
  });
};

const persistEvidence = async (
  input: ResolvedTraceLifecycleInput,
  preparation: Preparation,
  diagnostics: readonly SanitizedDiagnosticInput[],
  health: readonly PipelineHealthInput[],
  checkpointEvidence: Readonly<{
    checkpoints: readonly CaptureCheckpointInput[];
  }>,
): Promise<ResolvedLifecycleOperationalEvidence> => {
  const { checkpoints } = checkpointEvidence;
  const remaining = reporterDeadlineRemainingMilliseconds(
    preparation.snapshot.deadline,
  );
  if (remaining <= OPERATIONAL_PERSISTENCE_CLEANUP_RESERVE_MILLISECONDS)
    return freezeEvidence(
      [...diagnostics, ...checkpointUnavailableDiagnostics(checkpoints)],
      health,
      deadlinePersistence,
    );
  const home = configurationStoreHomeForCore(input.configurationStore);
  const committed = await commitOperationalEvidenceForCore(
    home,
    input.operationalStateStore,
    Object.freeze({ diagnostics, health, checkpoints }),
    Math.floor(
      remaining - OPERATIONAL_PERSISTENCE_CLEANUP_RESERVE_MILLISECONDS,
    ),
    input.signal,
  );
  if (!committed.ok || !committed.result.recorded)
    return freezeEvidence(
      [...diagnostics, ...checkpointUnavailableDiagnostics(checkpoints)],
      health,
      Object.freeze({
        recorded: false,
        code: committed.ok ? committed.result.code : "unavailable",
      }),
    );
  return freezeEvidence(
    [...diagnostics, ...committed.result.diagnostics],
    health,
    Object.freeze({ recorded: true, code: "recorded" }),
    committed.result.checkpoints,
  );
};

const routingEvidence = async (
  input: ResolvedTraceLifecycleInput,
  preparation: Preparation,
  result: RoutingDeliveryResult,
  boundary: CheckpointBoundary | undefined,
  resolution: CheckpointResolution | undefined,
): Promise<ResolvedLifecycleOperationalEvidence> => {
  const checkpointDiagnostics = checkpointResolutionDiagnostics(
    resolution,
    preparation,
  );
  if (result.outcome === "routing-unselected") {
    const diagnostics: SanitizedDiagnosticInput[] = [
      {
        code: "no-route",
        severity: "info",
        configurationGeneration: preparation.snapshot.configuration.generation,
      },
    ];
    const health: PipelineHealthInput[] = [
      {
        scope: "hook",
        stage: "routing",
        outcome: "no-route",
        configurationGeneration: preparation.snapshot.configuration.generation,
        policyMode:
          preparation.snapshot.invocation.snapshot.redactionPolicy.mode,
        receipt: null,
      },
    ];
    return await persistEvidence(
      input,
      preparation,
      [...diagnostics, ...checkpointDiagnostics],
      health,
      { checkpoints: [] },
    );
  }
  const diagnostics = [
    ...result.connections
      .map((connection) => diagnosticForConnection(connection, preparation))
      .filter(
        (entry): entry is SanitizedDiagnosticInput => entry !== undefined,
      ),
    ...checkpointDiagnostics,
  ];
  const allAccepted = result.connections.every(
    (connection) => connection.outcome === "accepted",
  );
  const health: PipelineHealthInput[] = [
    {
      scope: "hook",
      stage: allAccepted ? "remote-acceptance" : "delivery",
      outcome: allAccepted ? "accepted" : "completed",
      configurationGeneration: preparation.snapshot.configuration.generation,
      policyMode: preparation.snapshot.invocation.snapshot.redactionPolicy.mode,
      receipt: null,
    },
    ...result.connections.map((connection) =>
      connectionHealth(connection, preparation),
    ),
  ];
  const checkpoints = boundary
    ? result.connections
        .filter((connection) => connection.outcome === "accepted")
        .map((connection) => {
          const configured =
            preparation.snapshot.configuration.connections.find(
              (entry) => entry.connectionId === connection.connectionId,
            );
          /* v8 ignore next -- accepted connection results are minted from the
           * exact immutable selected-connection registry. */
          if (!configured) throw new Error("core.lifecycle.invalid");
          return {
            ...boundary,
            configurationGeneration:
              preparation.snapshot.configuration.generation,
            destinationType: configured.destinationType,
            connectionId: connection.connectionId,
          };
        })
    : [];
  return await persistEvidence(input, preparation, diagnostics, health, {
    checkpoints,
  });
};

const lifecycleEvidence = (
  preparation: Preparation,
  lifecycle: Exclude<LifecycleResult, { outcome: "sink-returned" }>,
): ResolvedLifecycleOperationalEvidence => {
  const cancelled = lifecycle.reason === "cancelled";
  let stage: PipelineHealthInput["stage"] = "capture";
  if (lifecycle.stage !== "capture") {
    /* v8 ignore else -- the internal sink succeeds before routing, so a
     * failed-open lifecycle cannot fail at a delivery stage. */
    if (lifecycle.stage === "redaction") stage = "redaction";
    else stage = "delivery";
  }
  const code =
    lifecycle.stage === "redaction" ? "redaction-suppressed" : "capture-failed";
  return freezeEvidence(
    [
      {
        code,
        severity: "warning",
        configurationGeneration: preparation.snapshot.configuration.generation,
      },
    ],
    [
      {
        scope: "hook",
        stage,
        outcome: cancelled ? "deadline-exceeded" : "suppressed",
        configurationGeneration: preparation.snapshot.configuration.generation,
        policyMode:
          preparation.snapshot.invocation.snapshot.redactionPolicy.mode,
        receipt: null,
      },
    ],
  );
};

const executeCaptureStage = (
  input: ResolvedTraceLifecycleInput,
  preparation: Preparation,
  operationalSnapshot: OperationalStateSnapshot | undefined,
): Readonly<{
  lifecycle: LifecycleResult;
  redacted: RedactedCanonicalTrace | undefined;
  boundary: CheckpointBoundary | undefined;
  checkpointResolution: CheckpointResolution | undefined;
}> => {
  let redacted: RedactedCanonicalTrace | undefined;
  let boundary: CheckpointBoundary | undefined;
  const checkpointResolver = createCheckpointResolver(
    preparation,
    operationalSnapshot,
  );
  let lifecycle: LifecycleResult;
  try {
    lifecycle = runFailOpenTraceLifecycle({
      invocation: preparation.snapshot.invocation,
      capture: input.capture,
      sink(trace) {
        redacted = trace;
      },
      onCaptured(captured) {
        boundary = captureCheckpointBoundary(captured);
        if (boundary !== undefined) {
          const observed = checkpointResolver.observed();
          const session =
            readCapturedTraceForCore(captured).captureBoundary.session;
          if (
            observed === undefined ||
            session.kind !== "native-session" ||
            observed.request.nativeIdentity !== session.nativeIdentity ||
            observed.request.nativeIdentityKind !==
              boundary.nativeIdentityKind ||
            observed.request.sourceGeneration !== boundary.sourceGeneration ||
            observed.request.positionKind !== boundary.positionKind ||
            observed.result.startPosition !== boundary.startPosition
          )
            throw new Error("core.lifecycle.invalid");
        }
      },
      checkpointResolver: checkpointResolver.resolve,
      remainingMilliseconds: () =>
        reporterDeadlineRemainingMilliseconds(preparation.snapshot.deadline),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } finally {
    checkpointResolver.close();
  }
  return Object.freeze({
    lifecycle,
    redacted,
    boundary,
    checkpointResolution: checkpointResolver.observed(),
  });
};

const executePreparedLifecycle = async (
  input: ResolvedTraceLifecycleInput,
  preparation: Preparation,
): Promise<ResolvedTraceLifecycleResult> => {
  if (preparation.snapshot.configuration.selectedConnectionIds.length === 0) {
    const routing = Object.freeze({
      outcome: "routing-unselected" as const,
      connections: Object.freeze([]),
    });
    const evidence = await routingEvidence(
      input,
      preparation,
      routing,
      undefined,
      undefined,
    );
    return withEvidence(resolvedRoutingResult(preparation, routing), evidence);
  }
  const preloadRemaining = reporterDeadlineRemainingMilliseconds(
    preparation.snapshot.deadline,
  );
  /* v8 ignore next -- an exact final-reserve race is defensive; deadline
   * consumption after preload is covered at the persistence boundary. */
  const preload =
    preloadRemaining <= OPERATIONAL_PERSISTENCE_CLEANUP_RESERVE_MILLISECONDS
      ? Object.freeze({ ok: false as const })
      : await preloadOperationalStateForCore(
          configurationStoreHomeForCore(input.configurationStore),
          input.operationalStateStore,
          Math.floor(
            preloadRemaining -
              OPERATIONAL_PERSISTENCE_CLEANUP_RESERVE_MILLISECONDS,
          ),
          input.signal,
        );
  const { lifecycle, redacted, boundary, checkpointResolution } =
    executeCaptureStage(
      input,
      preparation,
      preload.ok ? preload.snapshot : undefined,
    );
  if (lifecycle.outcome !== "sink-returned") {
    const evidence = lifecycleEvidence(preparation, lifecycle);
    const diagnostics = [
      ...evidence.diagnostics,
      ...checkpointResolutionDiagnostics(checkpointResolution, preparation),
    ];
    return withEvidence(
      lifecycle,
      await persistEvidence(input, preparation, diagnostics, evidence.health, {
        checkpoints: [],
      }),
    );
  }
  /* v8 ignore next 6 -- the internal sink assigns the exact trace before the
     synchronous lifecycle can produce sink-returned. */
  if (!redacted) {
    const failed = Object.freeze({
      outcome: "failed-open" as const,
      stage: "sink" as const,
      reason: "failed" as const,
    });
    const evidence = lifecycleEvidence(preparation, failed);
    return withEvidence(
      failed,
      await persistEvidence(
        input,
        preparation,
        evidence.diagnostics,
        evidence.health,
        { checkpoints: [] },
      ),
    );
  }
  const routing = await routeRedactedTraceBatch({
    traces: [redacted],
    configuration: preparation.snapshot.configuration,
    credentialBackendRegistry: input.credentialBackendRegistry,
    transportExecutor: input.transportExecutor,
    deadline: preparation.snapshot.deadline,
    admissionTimeUnixNano: preparation.snapshot.admissionTimeUnixNano,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const evidence = await routingEvidence(
    input,
    preparation,
    routing,
    boundary,
    checkpointResolution,
  );
  return withEvidence(resolvedRoutingResult(preparation, routing), evidence);
};

export const runResolvedTraceLifecycle = async (
  input: ResolvedTraceLifecycleInput,
): Promise<ResolvedTraceLifecycleResult> => {
  let completedPreparation: Preparation | undefined;
  try {
    const home = configurationStoreHomeForCore(input.configurationStore);
    if (
      !operationalStateStoreMatchesHomeForCore(
        input.operationalStateStore,
        home,
      )
    ) {
      const failed = configurationFailure();
      return withEvidence(failed, preparationEvidence(failed));
    }
    const preparation = await resolveCaptureInvocationSnapshot(input);
    if (!preparation.ok)
      return withEvidence(preparation, preparationEvidence(preparation));
    completedPreparation = preparation;
    return await executePreparedLifecycle(input, preparation);
  } catch {
    if (completedPreparation) {
      const failed = Object.freeze({
        outcome: "failed-open" as const,
        stage: "capture" as const,
        reason: "failed" as const,
      });
      const evidence = lifecycleEvidence(completedPreparation, failed);
      return withEvidence(
        failed,
        await persistEvidence(
          input,
          completedPreparation,
          evidence.diagnostics,
          evidence.health,
          { checkpoints: [] },
        ),
      );
    }
    const failed = configurationFailure();
    return withEvidence(failed, preparationEvidence(failed));
  }
};
