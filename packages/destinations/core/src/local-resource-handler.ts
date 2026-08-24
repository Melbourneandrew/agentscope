import {
  getDestinationDescriptor,
  type DestinationRegistry,
} from "./descriptor.js";
import { cloneJsonObject, type JsonObject } from "./plain-data.js";
import {
  bindLocalResourceConfigurationAuthorityForInvocation,
  type LocalResourceConfigurationAuthority,
} from "./local-resource-configuration-authority.js";
import {
  isLocalResourceLifecycleCapability,
  type LocalResourceLifecycleCapability,
} from "./local-resource-lifecycle.js";

export type LocalResourceLifecycleMutationOperation =
  "configure" | "delete" | "unconfigure";

export type LocalResourceMaintenanceOperation = "backup" | "restore";

export type LocalResourceLifecycleDeadline = Readonly<{
  expiresAtMonotonicMilliseconds: number;
}>;

export type LocalResourceLifecycleContext = Readonly<{
  readonly localResourceLifecycleContext: "agentscope-destinations-core";
  operation: LocalResourceLifecycleMutationOperation;
  operationId: string;
  destinationType: string;
  connectionId: string;
  connectionName: string;
  owner: Readonly<{
    processId: number;
    processStartIdentity: string;
  }>;
  settings: JsonObject;
  expectedConfigurationGeneration: number;
  candidateConfigurationGeneration: number;
  expectedConfigurationDigest: string;
  candidateConfigurationDigest: string;
  signal: AbortSignal;
  deadline: LocalResourceLifecycleDeadline;
}>;

export type LocalResourceLifecycleRecoveryContext = Readonly<{
  readonly localResourceLifecycleRecoveryContext: "agentscope-destinations-core";
  operation: LocalResourceLifecycleMutationOperation;
  operationId: string;
  destinationType: string;
  connectionId: string;
  owner: Readonly<{
    processId: number;
    processStartIdentity: string;
  }>;
  lifecycleFingerprint: string;
  recoveryHandlerId: string;
  expectedConfigurationGeneration: number;
  expectedConfigurationDigest: string;
  authorizedCandidates: readonly Readonly<{
    generation: number;
    digest: string;
  }>[];
  configurationState: "committed" | "intermediate" | "prior";
  signal: AbortSignal;
  deadline: LocalResourceLifecycleDeadline;
  configurationAuthority?: LocalResourceConfigurationAuthority;
}>;

export type LocalResourceMaintenanceContext = Readonly<{
  readonly localResourceMaintenanceContext: "agentscope-destinations-core";
  operation: LocalResourceMaintenanceOperation;
  operationId: string;
  resourceSelector: string;
  destinationType: string;
  connectionId: string;
  connectionName: string;
  owner: Readonly<{
    processId: number;
    processStartIdentity: string;
  }>;
  settings: JsonObject;
  configurationGeneration: number;
  configurationDigest: string;
  signal: AbortSignal;
  deadline: LocalResourceLifecycleDeadline;
}>;

export type LocalResourceMaintenanceRecoveryContext = Readonly<{
  readonly localResourceMaintenanceRecoveryContext: "agentscope-destinations-core";
  operation: LocalResourceMaintenanceOperation;
  operationId: string;
  resourceSelector: string;
  destinationType: string;
  connectionId: string;
  owner: Readonly<{
    processId: number;
    processStartIdentity: string;
  }>;
  lifecycleFingerprint: string;
  recoveryHandlerId: string;
  configurationGeneration: number;
  configurationDigest: string;
  signal: AbortSignal;
  deadline: LocalResourceLifecycleDeadline;
}>;

export type LocalResourceLifecyclePlanEvidence = Readonly<{
  namespaceFingerprint: string;
  physicalEvidenceFingerprint: string;
  displayPath: string;
  persistentDataNotice: true;
  retentionPolicy: Readonly<{
    maximumAgeNanoseconds: string;
    maximumTraceCount: number;
    maximumPayloadBytes: number;
    physicalCleanupTrigger: "next-authorized-mutation";
  }>;
}>;

export type LocalResourceRetainedDeleteAuthority = Readonly<{
  receiptDigest: string;
  databaseFamilyPhysicalIdentity: string;
}>;

export type LocalResourceBackupAuthority = Readonly<{
  backupId: string;
  receiptDigest: string;
  snapshotPhysicalIdentity: string;
}>;

export type LocalResourceMaintenancePlanEvidence = Readonly<{
  planEvidence: LocalResourceLifecyclePlanEvidence;
  resourceSelector: string;
  selectedBackupAuthority: LocalResourceBackupAuthority | null;
}>;

export type LocalResourceMaintenanceResult =
  | Readonly<{
      ok: true;
      state: "backed-up";
      backupAuthority: LocalResourceBackupAuthority;
    }>
  | Readonly<{ ok: true; state: "restored" | "rolled-back" }>
  | Readonly<{
      ok: false;
      state: "prepared" | "reconciliation-required" | "unchanged";
      code:
        | "busy"
        | "capacity"
        | "outcome-unknown"
        | "reconciliation-required"
        | "unavailable";
    }>;

export type LocalResourceDoctorContext = Readonly<{
  readonly localResourceDoctorContext: "agentscope-destinations-core";
  destinationType: string;
  connectionId: string;
  connectionName: string;
  settings: JsonObject;
  configurationGeneration: number;
  configurationDigest: string;
  signal: AbortSignal;
  deadline: LocalResourceLifecycleDeadline;
}>;

export type LocalResourceDoctorInspection = Readonly<{
  state:
    | "available"
    | "reconciliation-required"
    | "recovery-required"
    | "unavailable";
  lifecycleState:
    | "clean"
    | "busy"
    | "reconciliation-required"
    | "recovery-required"
    | "unavailable";
  databaseState: "present" | "missing" | "unavailable";
  backupState: "available" | "reconciliation-required" | "unavailable";
  sharedLeaseCount: number | null;
  publishedBackupCount: number | null;
  retentionPolicy: LocalResourceLifecyclePlanEvidence["retentionPolicy"];
  databaseDerivedRetention: Readonly<{
    cutoff: "unavailable";
    clockContinuity: "unavailable";
    rowCount: "unavailable";
    payloadBytes: "unavailable";
  }>;
}>;

export type LocalResourceLifecycleApplyResult =
  | Readonly<{
      ok: true;
      state: "configured" | "deleted" | "rolled-back";
    }>
  | Readonly<{
      ok: true;
      state: "retained";
      retainedAuthority: LocalResourceRetainedDeleteAuthority;
    }>
  | Readonly<{
      ok: false;
      state:
        | "configuration-committed"
        | "prepared"
        | "reconciliation-required"
        | "unchanged";
      code:
        "busy" | "outcome-unknown" | "reconciliation-required" | "unavailable";
    }>;

export type LocalResourceLifecycleHandlerImplementation = Readonly<{
  capability: LocalResourceLifecycleCapability;
  inspectPlan(
    context: LocalResourceLifecycleContext,
  ): Promise<LocalResourceLifecyclePlanEvidence>;
  inspectRetainedDelete(
    connectionId: string,
    signal: AbortSignal,
    deadline: LocalResourceLifecycleDeadline,
  ): Promise<null | Readonly<{
    destinationType: string;
    connectionId: string;
    connectionName: string;
    planEvidence: LocalResourceLifecyclePlanEvidence;
    retainedAuthority: LocalResourceRetainedDeleteAuthority;
  }>>;
  apply(
    context: LocalResourceLifecycleContext &
      Readonly<{
        planEvidence: LocalResourceLifecyclePlanEvidence;
        configurationAuthority: LocalResourceConfigurationAuthority;
        retainedAuthority?: LocalResourceRetainedDeleteAuthority;
      }>,
  ): Promise<LocalResourceLifecycleApplyResult>;
  recover(
    context: LocalResourceLifecycleRecoveryContext,
  ): Promise<LocalResourceLifecycleApplyResult>;
  complete(
    operation:
      | LocalResourceLifecycleMutationOperation
      | LocalResourceMaintenanceOperation,
    operationId: string,
    signal: AbortSignal,
    deadline: LocalResourceLifecycleDeadline,
  ): Promise<void>;
  inspectMaintenancePlan?(
    context: LocalResourceMaintenanceContext,
  ): Promise<LocalResourceMaintenancePlanEvidence>;
  applyMaintenance?(
    context: LocalResourceMaintenanceContext &
      Readonly<{ planEvidence: LocalResourceMaintenancePlanEvidence }>,
  ): Promise<LocalResourceMaintenanceResult>;
  recoverMaintenance?(
    context: LocalResourceMaintenanceRecoveryContext,
  ): Promise<LocalResourceMaintenanceResult>;
  inspectDoctor?(
    context: LocalResourceDoctorContext,
  ): Promise<LocalResourceDoctorInspection>;
}>;

export type LocalResourceLifecycleHandler = Readonly<{
  readonly localResourceLifecycleHandler: "agentscope-destinations-core";
}>;

export type LocalResourceLifecycleHandlerRegistry = Readonly<{
  readonly localResourceLifecycleHandlerRegistry: "agentscope-destinations-core";
}>;

type StoredHandler = Readonly<{
  capability: LocalResourceLifecycleCapability;
  inspectPlan: LocalResourceLifecycleHandlerImplementation["inspectPlan"];
  inspectRetainedDelete: LocalResourceLifecycleHandlerImplementation["inspectRetainedDelete"];
  apply: LocalResourceLifecycleHandlerImplementation["apply"];
  recover: LocalResourceLifecycleHandlerImplementation["recover"];
  complete: LocalResourceLifecycleHandlerImplementation["complete"];
  inspectMaintenancePlan?: NonNullable<
    LocalResourceLifecycleHandlerImplementation["inspectMaintenancePlan"]
  >;
  applyMaintenance?: NonNullable<
    LocalResourceLifecycleHandlerImplementation["applyMaintenance"]
  >;
  recoverMaintenance?: NonNullable<
    LocalResourceLifecycleHandlerImplementation["recoverMaintenance"]
  >;
  inspectDoctor?: NonNullable<
    LocalResourceLifecycleHandlerImplementation["inspectDoctor"]
  >;
}>;

const handlers = new WeakMap<object, StoredHandler>();
type StoredRegistry = Readonly<{
  currentByDestinationType: ReadonlyMap<string, StoredHandler>;
  recoveryByIdentity: ReadonlyMap<string, StoredHandler>;
}>;
const registries = new WeakMap<object, StoredRegistry>();
const registryOwners = new WeakMap<object, DestinationRegistry>();
const contexts = new WeakSet<object>();
const recoveryContexts = new WeakSet<object>();
const maintenanceContexts = new WeakSet<object>();
const maintenanceRecoveryContexts = new WeakSet<object>();
const doctorContexts = new WeakSet<object>();
const deadlines = new WeakSet<object>();
const monotonicNow = performance.now.bind(performance);
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only through Reflect.apply with a verified signal receiver.
const abortGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)!.get!;
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only through Reflect.apply with a verified signal receiver.
const eventTargetAdd = EventTarget.prototype.addEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only through Reflect.apply with a verified signal receiver.
const eventTargetRemove = EventTarget.prototype.removeEventListener;
const signalAborted = (signal: AbortSignal): boolean => {
  try {
    return Reflect.apply(abortGetter, signal, []) as boolean;
  } catch {
    /* v8 ignore next -- the captured intrinsic cannot throw for the verified native AbortSignal accepted by both public binders. */
    return true;
  }
};

export const createLocalResourceLifecycleDeadlineForCore = (
  timeoutMilliseconds: number,
): LocalResourceLifecycleDeadline => {
  if (
    !Number.isFinite(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > 60_000
  )
    return invalid();
  const deadline = Object.freeze({
    expiresAtMonotonicMilliseconds: monotonicNow() + timeoutMilliseconds,
  });
  deadlines.add(deadline);
  return deadline;
};

const deadlineRemaining = (
  deadline: LocalResourceLifecycleDeadline,
): number => {
  /* v8 ignore next -- all callers receive the deadline only through a branded context/recovery context or an explicit public preflight. */
  if (!deadlines.has(deadline)) return invalid();
  return Math.max(0, deadline.expiresAtMonotonicMilliseconds - monotonicNow());
};

const bounded = async <T>(
  invoke: (ownedSignal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  deadline: LocalResourceLifecycleDeadline,
  joinAfterCancellation = false,
): Promise<T> => {
  const remaining = deadlineRemaining(deadline);
  if (remaining === 0 || signalAborted(signal)) return invalid();
  const controller = new AbortController();
  let promise: Promise<T>;
  try {
    promise = invoke(controller.signal);
  } catch {
    return invalid();
  }
  if (
    typeof promise !== "object" ||
    promise === null ||
    Object.getPrototypeOf(promise) !== Promise.prototype
  )
    return invalid();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let cancelled = false;
    const finish = (action: () => void): void => {
      /* v8 ignore next -- multiple cancellation sources and promise settlement are idempotently contained. */
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      Reflect.apply(eventTargetRemove, signal, ["abort", cancel]);
      controller.abort();
      action();
    };
    const cancel = (): void => {
      cancelled = true;
      controller.abort();
      if (!joinAfterCancellation)
        finish(() => {
          reject(new LocalResourceLifecycleHandlerError());
        });
    };
    const timer = setTimeout(cancel, remaining);
    Reflect.apply(eventTargetAdd, signal, ["abort", cancel, { once: true }]);
    if (signalAborted(signal)) {
      cancel();
      return;
    }
    void promise.then(
      (value) => {
        finish(() => {
          if (cancelled) reject(new LocalResourceLifecycleHandlerError());
          else resolve(value);
        });
      },
      (error) => {
        finish(() => {
          if (cancelled) reject(new LocalResourceLifecycleHandlerError());
          else
            reject(
              error instanceof Error
                ? error
                : new LocalResourceLifecycleHandlerError(),
            );
        });
      },
    );
  });
};

export class LocalResourceLifecycleHandlerError extends Error {
  public readonly code = "destination.local-resource-handler.invalid";

  public constructor() {
    super("destination.local-resource-handler.invalid");
    this.name = "LocalResourceLifecycleHandlerError";
  }
}

const invalid = (): never => {
  throw new LocalResourceLifecycleHandlerError();
};

export const bindLocalResourceLifecycleContextForCore = (
  input: Omit<LocalResourceLifecycleContext, "localResourceLifecycleContext">,
): LocalResourceLifecycleContext => {
  if (
    typeof input !== "object" ||
    input === null ||
    !["configure", "delete", "unconfigure"].includes(input.operation) ||
    !/^[0-9a-f]{32}$/u.test(input.operationId) ||
    /^0{32}$/u.test(input.operationId) ||
    !/^@agentscope\/destination-[a-z0-9-]{1,64}$/u.test(
      input.destinationType,
    ) ||
    !/^destination-connection-v1-[0-9a-f]{64}$/u.test(input.connectionId) ||
    !(input.signal instanceof AbortSignal) ||
    !deadlines.has(input.deadline) ||
    !Number.isSafeInteger(input.expectedConfigurationGeneration) ||
    input.expectedConfigurationGeneration < 0 ||
    !Number.isSafeInteger(input.candidateConfigurationGeneration) ||
    input.candidateConfigurationGeneration <=
      input.expectedConfigurationGeneration ||
    input.candidateConfigurationGeneration >
      input.expectedConfigurationGeneration + 2 ||
    !/^sha256-[0-9a-f]{64}$/u.test(input.expectedConfigurationDigest) ||
    !/^sha256-[0-9a-f]{64}$/u.test(input.candidateConfigurationDigest)
  )
    return invalid();
  const context = Object.freeze({
    ...input,
    localResourceLifecycleContext: "agentscope-destinations-core" as const,
    owner: Object.freeze({ ...input.owner }),
  });
  contexts.add(context);
  return context;
};

export const bindLocalResourceLifecycleRecoveryContextForCore = (
  input: Omit<
    LocalResourceLifecycleRecoveryContext,
    "localResourceLifecycleRecoveryContext"
  >,
): LocalResourceLifecycleRecoveryContext => {
  if (
    typeof input !== "object" ||
    input === null ||
    !["configure", "delete", "unconfigure"].includes(input.operation) ||
    !/^(?!0{32}$)[0-9a-f]{32}$/u.test(input.operationId) ||
    !/^@agentscope\/destination-[a-z0-9-]{1,64}$/u.test(
      input.destinationType,
    ) ||
    !/^destination-connection-v1-[0-9a-f]{64}$/u.test(input.connectionId) ||
    !/^sha256-[0-9a-f]{64}$/u.test(input.lifecycleFingerprint) ||
    typeof input.recoveryHandlerId !== "string" ||
    !Number.isSafeInteger(input.expectedConfigurationGeneration) ||
    input.expectedConfigurationGeneration < 0 ||
    !/^sha256-[0-9a-f]{64}$/u.test(input.expectedConfigurationDigest) ||
    !Array.isArray(input.authorizedCandidates) ||
    input.authorizedCandidates.length < 1 ||
    input.authorizedCandidates.length > 2 ||
    !["committed", "intermediate", "prior"].includes(
      input.configurationState,
    ) ||
    !(input.signal instanceof AbortSignal) ||
    !deadlines.has(input.deadline)
  )
    return invalid();
  const authorizedCandidates = input.authorizedCandidates.map(
    (candidate, index) => {
      const value = candidate as unknown as Record<string, unknown>;
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        value.generation !==
          input.expectedConfigurationGeneration + index + 1 ||
        typeof value.digest !== "string" ||
        !/^sha256-[0-9a-f]{64}$/u.test(value.digest)
      )
        return invalid();
      return Object.freeze({
        generation: value.generation,
        digest: value.digest,
      });
    },
  );
  const context = Object.freeze({
    ...input,
    localResourceLifecycleRecoveryContext:
      "agentscope-destinations-core" as const,
    owner: Object.freeze({ ...input.owner }),
    authorizedCandidates: Object.freeze(authorizedCandidates),
  });
  recoveryContexts.add(context);
  return context;
};

const exactConnectionContext = (
  input: Readonly<{
    destinationType: string;
    connectionId: string;
    signal: AbortSignal;
    deadline: LocalResourceLifecycleDeadline;
    configurationGeneration: number;
    configurationDigest: string;
  }>,
): void => {
  if (
    !/^@agentscope\/destination-[a-z0-9-]{1,64}$/u.test(
      input.destinationType,
    ) ||
    !/^destination-connection-v1-[0-9a-f]{64}$/u.test(input.connectionId) ||
    !(input.signal instanceof AbortSignal) ||
    !deadlines.has(input.deadline) ||
    !Number.isSafeInteger(input.configurationGeneration) ||
    input.configurationGeneration < 0 ||
    !/^sha256-[0-9a-f]{64}$/u.test(input.configurationDigest)
  )
    return invalid();
};

const exactDataRecord = (
  input: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> => {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor || !("value" in descriptor);
    })
  )
    return invalid();
  return Object.freeze(
    Object.fromEntries(
      keys.map((key) => [key, descriptors[key]!.value as unknown]),
    ),
  );
};

const exactOwner = (
  value: unknown,
): LocalResourceMaintenanceContext["owner"] => {
  const owner = exactDataRecord(value, ["processId", "processStartIdentity"]);
  if (
    !Number.isSafeInteger(owner.processId) ||
    (owner.processId as number) < 1 ||
    typeof owner.processStartIdentity !== "string" ||
    !/^process-start-v1-[0-9a-f]{64}$/u.test(owner.processStartIdentity)
  )
    return invalid();
  return Object.freeze({
    processId: owner.processId as number,
    processStartIdentity: owner.processStartIdentity,
  });
};

export const bindLocalResourceMaintenanceContextForCore = (
  input: Omit<
    LocalResourceMaintenanceContext,
    "localResourceMaintenanceContext"
  >,
): LocalResourceMaintenanceContext => {
  const record = exactDataRecord(input, [
    "configurationDigest",
    "configurationGeneration",
    "connectionId",
    "connectionName",
    "deadline",
    "destinationType",
    "operation",
    "operationId",
    "owner",
    "resourceSelector",
    "settings",
    "signal",
  ]);
  if (
    !["backup", "restore"].includes(record.operation as string) ||
    typeof record.operationId !== "string" ||
    !/^(?!0{32}$)[0-9a-f]{32}$/u.test(record.operationId) ||
    typeof record.resourceSelector !== "string" ||
    !/^(?!0{32}$)[0-9a-f]{32}$/u.test(record.resourceSelector) ||
    typeof record.connectionName !== "string" ||
    record.connectionName.length < 1 ||
    record.connectionName.length > 128
  )
    return invalid();
  exactConnectionContext(
    record as unknown as Parameters<typeof exactConnectionContext>[0],
  );
  const context = Object.freeze({
    ...record,
    localResourceMaintenanceContext: "agentscope-destinations-core" as const,
    owner: exactOwner(record.owner),
    settings: cloneJsonObject(record.settings),
  }) as LocalResourceMaintenanceContext;
  maintenanceContexts.add(context);
  return context;
};

export const bindLocalResourceMaintenanceRecoveryContextForCore = (
  input: Omit<
    LocalResourceMaintenanceRecoveryContext,
    "localResourceMaintenanceRecoveryContext"
  >,
): LocalResourceMaintenanceRecoveryContext => {
  const record = exactDataRecord(input, [
    "configurationDigest",
    "configurationGeneration",
    "connectionId",
    "deadline",
    "destinationType",
    "lifecycleFingerprint",
    "operation",
    "operationId",
    "owner",
    "recoveryHandlerId",
    "resourceSelector",
    "signal",
  ]);
  if (
    !["backup", "restore"].includes(record.operation as string) ||
    typeof record.operationId !== "string" ||
    !/^(?!0{32}$)[0-9a-f]{32}$/u.test(record.operationId) ||
    typeof record.resourceSelector !== "string" ||
    !/^(?!0{32}$)[0-9a-f]{32}$/u.test(record.resourceSelector) ||
    typeof record.lifecycleFingerprint !== "string" ||
    !/^sha256-[0-9a-f]{64}$/u.test(record.lifecycleFingerprint) ||
    typeof record.recoveryHandlerId !== "string" ||
    record.recoveryHandlerId.length < 1 ||
    record.recoveryHandlerId.length > 256
  )
    return invalid();
  exactConnectionContext(
    record as unknown as Parameters<typeof exactConnectionContext>[0],
  );
  const context = Object.freeze({
    ...record,
    localResourceMaintenanceRecoveryContext:
      "agentscope-destinations-core" as const,
    owner: exactOwner(record.owner),
  }) as LocalResourceMaintenanceRecoveryContext;
  maintenanceRecoveryContexts.add(context);
  return context;
};

export const bindLocalResourceDoctorContextForCore = (
  input: Omit<LocalResourceDoctorContext, "localResourceDoctorContext">,
): LocalResourceDoctorContext => {
  const record = exactDataRecord(input, [
    "configurationDigest",
    "configurationGeneration",
    "connectionId",
    "connectionName",
    "deadline",
    "destinationType",
    "settings",
    "signal",
  ]);
  if (
    typeof record.connectionName !== "string" ||
    record.connectionName.length < 1 ||
    record.connectionName.length > 128
  )
    return invalid();
  exactConnectionContext(
    record as unknown as Parameters<typeof exactConnectionContext>[0],
  );
  const context = Object.freeze({
    ...record,
    localResourceDoctorContext: "agentscope-destinations-core" as const,
    settings: cloneJsonObject(record.settings),
  }) as LocalResourceDoctorContext;
  doctorContexts.add(context);
  return context;
};

const dataMethod = (
  descriptors: PropertyDescriptorMap,
  key:
    | "apply"
    | "applyMaintenance"
    | "complete"
    | "inspectDoctor"
    | "inspectMaintenancePlan"
    | "inspectPlan"
    | "inspectRetainedDelete"
    | "recover"
    | "recoverMaintenance",
): ((...input: never[]) => unknown) => {
  const descriptor = descriptors[key];
  if (
    !descriptor ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function"
  )
    return invalid();
  return descriptor.value as (...input: never[]) => unknown;
};

const optionalDataMethod = (
  descriptors: PropertyDescriptorMap,
  key:
    | "applyMaintenance"
    | "inspectDoctor"
    | "inspectMaintenancePlan"
    | "recoverMaintenance",
): ((...input: never[]) => unknown) | undefined =>
  descriptors[key] ? dataMethod(descriptors, key) : undefined;

export const defineLocalResourceLifecycleHandler = (
  implementation: LocalResourceLifecycleHandlerImplementation,
): LocalResourceLifecycleHandler => {
  if (
    typeof implementation !== "object" ||
    implementation === null ||
    Array.isArray(implementation) ||
    Object.getPrototypeOf(implementation) !== Object.prototype
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(implementation);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length < 6 ||
    keys.length > 10 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        ![
          "apply",
          "applyMaintenance",
          "capability",
          "complete",
          "inspectDoctor",
          "inspectMaintenancePlan",
          "inspectPlan",
          "inspectRetainedDelete",
          "recover",
          "recoverMaintenance",
        ].includes(key),
    )
  )
    return invalid();
  const capabilityDescriptor = descriptors.capability;
  if (
    !capabilityDescriptor ||
    !("value" in capabilityDescriptor) ||
    !isLocalResourceLifecycleCapability(capabilityDescriptor.value)
  )
    return invalid();
  const handler = Object.freeze({
    localResourceLifecycleHandler: "agentscope-destinations-core" as const,
  });
  handlers.set(
    handler,
    Object.freeze({
      capability: capabilityDescriptor.value,
      inspectPlan: dataMethod(
        descriptors,
        "inspectPlan",
      ) as StoredHandler["inspectPlan"],
      inspectRetainedDelete: dataMethod(
        descriptors,
        "inspectRetainedDelete",
      ) as StoredHandler["inspectRetainedDelete"],
      apply: dataMethod(descriptors, "apply") as StoredHandler["apply"],
      complete: dataMethod(
        descriptors,
        "complete",
      ) as StoredHandler["complete"],
      recover: dataMethod(descriptors, "recover") as StoredHandler["recover"],
      ...(optionalDataMethod(descriptors, "inspectMaintenancePlan")
        ? {
            inspectMaintenancePlan: optionalDataMethod(
              descriptors,
              "inspectMaintenancePlan",
            ) as NonNullable<StoredHandler["inspectMaintenancePlan"]>,
          }
        : {}),
      ...(optionalDataMethod(descriptors, "applyMaintenance")
        ? {
            applyMaintenance: optionalDataMethod(
              descriptors,
              "applyMaintenance",
            ) as NonNullable<StoredHandler["applyMaintenance"]>,
          }
        : {}),
      ...(optionalDataMethod(descriptors, "recoverMaintenance")
        ? {
            recoverMaintenance: optionalDataMethod(
              descriptors,
              "recoverMaintenance",
            ) as NonNullable<StoredHandler["recoverMaintenance"]>,
          }
        : {}),
      ...(optionalDataMethod(descriptors, "inspectDoctor")
        ? {
            inspectDoctor: optionalDataMethod(
              descriptors,
              "inspectDoctor",
            ) as NonNullable<StoredHandler["inspectDoctor"]>,
          }
        : {}),
    }),
  );
  return handler;
};

export const compileLocalResourceLifecycleHandlerRegistry = (
  destinationRegistry: DestinationRegistry,
  input: readonly LocalResourceLifecycleHandler[],
): LocalResourceLifecycleHandlerRegistry => {
  if (!Array.isArray(input) || input.length > 64) return invalid();
  const inventory = Object.getOwnPropertyDescriptors(input);
  const expected = new Set([
    "length",
    ...Array.from({ length: input.length }, (_, index) => String(index)),
  ]);
  if (
    Reflect.ownKeys(inventory).length !== expected.size ||
    Reflect.ownKeys(inventory).some(
      (key) => typeof key !== "string" || !expected.has(key),
    )
  )
    return invalid();
  const currentByDestinationType = new Map<string, StoredHandler>();
  const recoveryByIdentity = new Map<string, StoredHandler>();
  for (const candidate of input as readonly unknown[]) {
    if (typeof candidate !== "object" || candidate === null) return invalid();
    const stored = handlers.get(candidate);
    if (!stored) return invalid();
    if (
      ((stored.capability.operations.includes("backup") ||
        stored.capability.operations.includes("restore")) &&
        (!stored.inspectMaintenancePlan ||
          !stored.applyMaintenance ||
          !stored.recoverMaintenance)) ||
      (stored.capability.operations.includes("doctor") && !stored.inspectDoctor)
    )
      return invalid();
    const descriptor = getDestinationDescriptor(
      destinationRegistry,
      stored.capability.destinationType,
    );
    if (!descriptor?.localResourceLifecycle) return invalid();
    const recoveryIdentity = `${stored.capability.destinationType}\u0000${stored.capability.fingerprint}\u0000${stored.capability.recoveryHandlerId}`;
    const isCurrent =
      descriptor.localResourceLifecycle.fingerprint ===
        stored.capability.fingerprint &&
      descriptor.localResourceLifecycle.recoveryHandlerId ===
        stored.capability.recoveryHandlerId;
    if (
      !stored.capability.operations.includes("recover") ||
      (isCurrent &&
        currentByDestinationType.has(stored.capability.destinationType)) ||
      recoveryByIdentity.has(recoveryIdentity)
    )
      return invalid();
    recoveryByIdentity.set(recoveryIdentity, stored);
    if (isCurrent) {
      currentByDestinationType.set(stored.capability.destinationType, stored);
    }
  }
  if (
    destinationRegistry.descriptors.some(
      (descriptor) =>
        descriptor.localResourceLifecycle !== null &&
        !currentByDestinationType.has(descriptor.destinationType),
    )
  )
    return invalid();
  const registry = Object.freeze({
    localResourceLifecycleHandlerRegistry:
      "agentscope-destinations-core" as const,
  });
  registries.set(
    registry,
    Object.freeze({ currentByDestinationType, recoveryByIdentity }),
  );
  registryOwners.set(registry, destinationRegistry);
  return registry;
};

export const isLocalResourceLifecycleHandlerRegistry = (
  value: unknown,
): value is LocalResourceLifecycleHandlerRegistry =>
  typeof value === "object" && value !== null && registries.has(value);

export const localResourceLifecycleHandlerRegistryUsesDestinationRegistry = (
  registry: LocalResourceLifecycleHandlerRegistry,
  destinationRegistry: DestinationRegistry,
): boolean => registryOwners.get(registry) === destinationRegistry;

export const getLocalResourceLifecycleHandlerCapability = (
  registry: LocalResourceLifecycleHandlerRegistry,
  destinationType: string,
): LocalResourceLifecycleCapability | undefined =>
  registries.get(registry)?.currentByDestinationType.get(destinationType)
    ?.capability;

const normalizePlanEvidence = (
  result: unknown,
  // eslint-disable-next-line complexity -- one closed DTO boundary validates every nested field without coercion.
): LocalResourceLifecyclePlanEvidence => {
  if (
    typeof result !== "object" ||
    result === null ||
    Object.getPrototypeOf(result) !== Object.prototype
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(result);
  const keys = [
    "displayPath",
    "namespaceFingerprint",
    "persistentDataNotice",
    "physicalEvidenceFingerprint",
    "retentionPolicy",
  ];
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor || !("value" in descriptor);
    })
  )
    return invalid();
  const namespaceFingerprint = descriptors.namespaceFingerprint
    ?.value as unknown;
  const physicalEvidenceFingerprint = descriptors.physicalEvidenceFingerprint
    ?.value as unknown;
  const displayPath = descriptors.displayPath?.value as unknown;
  const retentionPolicy = descriptors.retentionPolicy?.value as unknown;
  if (
    typeof namespaceFingerprint !== "string" ||
    !/^sha256-[0-9a-f]{64}$/u.test(namespaceFingerprint) ||
    typeof physicalEvidenceFingerprint !== "string" ||
    !/^sha256-[0-9a-f]{64}$/u.test(physicalEvidenceFingerprint) ||
    typeof displayPath !== "string" ||
    Buffer.byteLength(displayPath, "utf8") > 4_096 ||
    descriptors.persistentDataNotice?.value !== true
  )
    return invalid();
  if (
    typeof retentionPolicy !== "object" ||
    retentionPolicy === null ||
    Object.getPrototypeOf(retentionPolicy) !== Object.prototype
  )
    return invalid();
  const retentionDescriptors =
    Object.getOwnPropertyDescriptors(retentionPolicy);
  if (
    Object.keys(retentionDescriptors).sort().join(",") !==
      "maximumAgeNanoseconds,maximumPayloadBytes,maximumTraceCount,physicalCleanupTrigger" ||
    Reflect.ownKeys(retentionDescriptors).length !== 4 ||
    Object.values(retentionDescriptors).some(
      (descriptor) => !("value" in descriptor),
    )
  )
    return invalid();
  const maximumAgeNanoseconds = retentionDescriptors.maximumAgeNanoseconds
    ?.value as unknown;
  const maximumTraceCount = retentionDescriptors.maximumTraceCount
    ?.value as unknown;
  const maximumPayloadBytes = retentionDescriptors.maximumPayloadBytes
    ?.value as unknown;
  if (
    typeof maximumAgeNanoseconds !== "string" ||
    !/^(?:0|[1-9][0-9]{0,19})$/u.test(maximumAgeNanoseconds) ||
    typeof maximumTraceCount !== "number" ||
    !Number.isSafeInteger(maximumTraceCount) ||
    maximumTraceCount < 1 ||
    typeof maximumPayloadBytes !== "number" ||
    !Number.isSafeInteger(maximumPayloadBytes) ||
    maximumPayloadBytes < 1 ||
    retentionDescriptors.physicalCleanupTrigger?.value !==
      "next-authorized-mutation"
  )
    return invalid();
  return Object.freeze({
    namespaceFingerprint,
    physicalEvidenceFingerprint,
    displayPath,
    persistentDataNotice: true,
    retentionPolicy: Object.freeze({
      maximumAgeNanoseconds,
      maximumTraceCount,
      maximumPayloadBytes,
      physicalCleanupTrigger: "next-authorized-mutation" as const,
    }),
  });
};

export const inspectLocalResourceLifecyclePlan = async (
  registry: LocalResourceLifecycleHandlerRegistry,
  context: LocalResourceLifecycleContext,
): Promise<LocalResourceLifecyclePlanEvidence> => {
  if (!contexts.has(context)) return invalid();
  const stored = registries
    .get(registry)
    ?.currentByDestinationType.get(context.destinationType);
  if (!stored || !stored.capability.operations.includes(context.operation))
    return invalid();
  return normalizePlanEvidence(
    await bounded(
      (ownedSignal) =>
        stored.inspectPlan(Object.freeze({ ...context, signal: ownedSignal })),
      context.signal,
      context.deadline,
    ),
  );
};

const normalizeRetainedAuthority = (
  authority: unknown,
): LocalResourceRetainedDeleteAuthority => {
  if (
    typeof authority !== "object" ||
    authority === null ||
    Object.getPrototypeOf(authority) !== Object.prototype
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(authority);
  if (
    Object.keys(descriptors).sort().join(",") !==
      "databaseFamilyPhysicalIdentity,receiptDigest" ||
    Reflect.ownKeys(descriptors).length !== 2 ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  const receiptDigest = descriptors.receiptDigest?.value as unknown;
  const databaseFamilyPhysicalIdentity = descriptors
    .databaseFamilyPhysicalIdentity?.value as unknown;
  if (
    typeof receiptDigest !== "string" ||
    !/^sha256-[0-9a-f]{64}$/u.test(receiptDigest) ||
    typeof databaseFamilyPhysicalIdentity !== "string" ||
    databaseFamilyPhysicalIdentity.length < 1 ||
    databaseFamilyPhysicalIdentity.length > 192 ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(databaseFamilyPhysicalIdentity)
  )
    return invalid();
  return Object.freeze({ receiptDigest, databaseFamilyPhysicalIdentity });
};

const normalizeBackupAuthority = (
  authority: unknown,
): LocalResourceBackupAuthority => {
  if (
    typeof authority !== "object" ||
    authority === null ||
    Object.getPrototypeOf(authority) !== Object.prototype
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(authority);
  if (
    Object.keys(descriptors).sort().join(",") !==
      "backupId,receiptDigest,snapshotPhysicalIdentity" ||
    Reflect.ownKeys(descriptors).length !== 3 ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  const backupId = descriptors.backupId?.value as unknown;
  const receiptDigest = descriptors.receiptDigest?.value as unknown;
  const snapshotPhysicalIdentity = descriptors.snapshotPhysicalIdentity
    ?.value as unknown;
  if (
    typeof backupId !== "string" ||
    !/^(?!0{32}$)[0-9a-f]{32}$/u.test(backupId) ||
    typeof receiptDigest !== "string" ||
    !/^sha256-[0-9a-f]{64}$/u.test(receiptDigest) ||
    typeof snapshotPhysicalIdentity !== "string" ||
    snapshotPhysicalIdentity.length < 1 ||
    snapshotPhysicalIdentity.length > 192 ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(snapshotPhysicalIdentity)
  )
    return invalid();
  return Object.freeze({ backupId, receiptDigest, snapshotPhysicalIdentity });
};

const normalizeMaintenancePlanEvidence = (
  result: unknown,
  context: LocalResourceMaintenanceContext,
): LocalResourceMaintenancePlanEvidence => {
  if (
    typeof result !== "object" ||
    result === null ||
    Object.getPrototypeOf(result) !== Object.prototype
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(result);
  if (
    Object.keys(descriptors).sort().join(",") !==
      "planEvidence,resourceSelector,selectedBackupAuthority" ||
    Reflect.ownKeys(descriptors).length !== 3 ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor)) ||
    descriptors.resourceSelector?.value !== context.resourceSelector
  )
    return invalid();
  const selected = descriptors.selectedBackupAuthority?.value as unknown;
  if (
    (context.operation === "backup" && selected !== null) ||
    (context.operation === "restore" && selected === null)
  )
    return invalid();
  const selectedBackupAuthority =
    selected === null ? null : normalizeBackupAuthority(selected);
  if (
    selectedBackupAuthority !== null &&
    selectedBackupAuthority.backupId !== context.resourceSelector
  )
    return invalid();
  return Object.freeze({
    planEvidence: normalizePlanEvidence(descriptors.planEvidence?.value),
    resourceSelector: context.resourceSelector,
    selectedBackupAuthority,
  });
};

export const inspectRetainedLocalResourceDelete = async (
  registry: LocalResourceLifecycleHandlerRegistry,
  connectionId: string,
  signal: AbortSignal,
  deadline: LocalResourceLifecycleDeadline,
): Promise<null | Readonly<{
  destinationType: string;
  connectionId: string;
  connectionName: string;
  planEvidence: LocalResourceLifecyclePlanEvidence;
  retainedAuthority: LocalResourceRetainedDeleteAuthority;
}>> => {
  const storedRegistry = registries.get(registry);
  if (
    !storedRegistry ||
    !/^destination-connection-v1-[0-9a-f]{64}$/u.test(connectionId) ||
    !(signal instanceof AbortSignal) ||
    !deadlines.has(deadline)
  )
    return invalid();
  const matches = [];
  for (const stored of storedRegistry.currentByDestinationType.values()) {
    if (!stored.capability.operations.includes("delete")) continue;
    const result = await bounded(
      (ownedSignal) =>
        stored.inspectRetainedDelete(connectionId, ownedSignal, deadline),
      signal,
      deadline,
    );
    if (result === null) continue;
    if (
      typeof result !== "object" ||
      Object.getPrototypeOf(result) !== Object.prototype
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(result);
    const keys = [
      "connectionId",
      "connectionName",
      "destinationType",
      "planEvidence",
      "retainedAuthority",
    ];
    if (
      Reflect.ownKeys(descriptors).length !== keys.length ||
      keys.some((key) => {
        const descriptor = descriptors[key];
        return !descriptor || !("value" in descriptor);
      })
    )
      return invalid();
    const destinationType = descriptors.destinationType?.value as unknown;
    const returnedConnectionId = descriptors.connectionId?.value as unknown;
    const returnedName = descriptors.connectionName?.value as unknown;
    if (
      destinationType !== stored.capability.destinationType ||
      returnedConnectionId !== connectionId ||
      returnedName !== "retained"
    )
      return invalid();
    const authority = normalizeRetainedAuthority(
      descriptors.retainedAuthority?.value,
    );
    matches.push(
      Object.freeze({
        destinationType: stored.capability.destinationType,
        connectionId: returnedConnectionId,
        connectionName: returnedName,
        planEvidence: normalizePlanEvidence(
          descriptors.planEvidence?.value as unknown,
        ),
        retainedAuthority: authority,
      }),
    );
  }
  if (matches.length > 1) return invalid();
  return matches[0] ?? null;
};

export const inspectLocalResourceMaintenancePlan = async (
  registry: LocalResourceLifecycleHandlerRegistry,
  context: LocalResourceMaintenanceContext,
): Promise<LocalResourceMaintenancePlanEvidence> => {
  if (!maintenanceContexts.has(context)) return invalid();
  const stored = registries
    .get(registry)
    ?.currentByDestinationType.get(context.destinationType);
  if (
    !stored ||
    !stored.inspectMaintenancePlan ||
    !stored.capability.operations.includes(context.operation)
  )
    return invalid();
  return normalizeMaintenancePlanEvidence(
    await bounded(
      (ownedSignal) =>
        stored.inspectMaintenancePlan!(
          Object.freeze({ ...context, signal: ownedSignal }),
        ),
      context.signal,
      context.deadline,
    ),
    context,
  );
};

const normalizeMaintenanceResult = (
  result: unknown,
  context:
    LocalResourceMaintenanceContext | LocalResourceMaintenanceRecoveryContext,
): LocalResourceMaintenanceResult => {
  if (
    typeof result !== "object" ||
    result === null ||
    Object.getPrototypeOf(result) !== Object.prototype
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(result);
  const ok = descriptors.ok?.value as unknown;
  const state = descriptors.state?.value as unknown;
  const keys =
    ok === true && state === "backed-up"
      ? ["backupAuthority", "ok", "state"]
      : ok === true
        ? ["ok", "state"]
        : ["code", "ok", "state"];
  if (
    Object.keys(descriptors).sort().join(",") !== keys.sort().join(",") ||
    Reflect.ownKeys(descriptors).length !== keys.length ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  if (ok === true && state === "backed-up") {
    if (context.operation !== "backup") return invalid();
    const backupAuthority = normalizeBackupAuthority(
      descriptors.backupAuthority?.value,
    );
    if (backupAuthority.backupId !== context.resourceSelector) return invalid();
    return Object.freeze({ ok: true, state, backupAuthority });
  }
  if (ok === true && (state === "restored" || state === "rolled-back")) {
    if (state === "restored" && context.operation !== "restore")
      return invalid();
    return Object.freeze({ ok: true, state });
  }
  const code = descriptors.code?.value as unknown;
  if (
    ok !== false ||
    !["prepared", "reconciliation-required", "unchanged"].includes(
      state as string,
    ) ||
    ![
      "busy",
      "capacity",
      "outcome-unknown",
      "reconciliation-required",
      "unavailable",
    ].includes(code as string)
  )
    return invalid();
  return Object.freeze({
    ok: false,
    state: state as Exclude<
      LocalResourceMaintenanceResult,
      { ok: true }
    >["state"],
    code: code as Exclude<LocalResourceMaintenanceResult, { ok: true }>["code"],
  });
};

export const applyLocalResourceMaintenancePlan = async (
  registry: LocalResourceLifecycleHandlerRegistry,
  context: LocalResourceMaintenanceContext,
  planEvidence: LocalResourceMaintenancePlanEvidence,
): Promise<LocalResourceMaintenanceResult> => {
  if (!maintenanceContexts.has(context)) return invalid();
  const stored = registries
    .get(registry)
    ?.currentByDestinationType.get(context.destinationType);
  if (
    !stored ||
    !stored.applyMaintenance ||
    !stored.capability.operations.includes(context.operation)
  )
    return invalid();
  const result = await bounded(
    (ownedSignal) =>
      stored.applyMaintenance!(
        Object.freeze({ ...context, signal: ownedSignal, planEvidence }),
      ),
    context.signal,
    context.deadline,
    true,
  );
  return normalizeMaintenanceResult(result, context);
};

export const recoverLocalResourceMaintenance = async (
  registry: LocalResourceLifecycleHandlerRegistry,
  context: LocalResourceMaintenanceRecoveryContext,
): Promise<LocalResourceMaintenanceResult> => {
  if (!maintenanceRecoveryContexts.has(context)) return invalid();
  const recoveryIdentity = `${context.destinationType}\u0000${context.lifecycleFingerprint}\u0000${context.recoveryHandlerId}`;
  const stored = registries
    .get(registry)
    ?.recoveryByIdentity.get(recoveryIdentity);
  if (
    !stored ||
    !stored.recoverMaintenance ||
    stored.capability.fingerprint !== context.lifecycleFingerprint ||
    stored.capability.recoveryHandlerId !== context.recoveryHandlerId ||
    !stored.capability.operations.includes("recover") ||
    !stored.capability.operations.includes(context.operation)
  )
    return invalid();
  const result = await bounded(
    (ownedSignal) =>
      stored.recoverMaintenance!(
        Object.freeze({ ...context, signal: ownedSignal }),
      ),
    context.signal,
    context.deadline,
    true,
  );
  return normalizeMaintenanceResult(result, context);
};

const normalizeDoctorInspection = (
  result: unknown,
  // eslint-disable-next-line complexity -- one closed nonmutating Doctor DTO is reconstructed atomically.
): LocalResourceDoctorInspection => {
  if (
    typeof result !== "object" ||
    result === null ||
    Object.getPrototypeOf(result) !== Object.prototype
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(result);
  const keys = [
    "backupState",
    "databaseDerivedRetention",
    "databaseState",
    "lifecycleState",
    "publishedBackupCount",
    "retentionPolicy",
    "sharedLeaseCount",
    "state",
  ];
  if (
    Object.keys(descriptors).sort().join(",") !== keys.sort().join(",") ||
    Reflect.ownKeys(descriptors).length !== keys.length ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  const state = descriptors.state?.value as unknown;
  const lifecycleState = descriptors.lifecycleState?.value as unknown;
  const databaseState = descriptors.databaseState?.value as unknown;
  const backupState = descriptors.backupState?.value as unknown;
  const sharedLeaseCount = descriptors.sharedLeaseCount?.value as unknown;
  const publishedBackupCount = descriptors.publishedBackupCount
    ?.value as unknown;
  if (
    ![
      "available",
      "reconciliation-required",
      "recovery-required",
      "unavailable",
    ].includes(state as string) ||
    ![
      "clean",
      "busy",
      "reconciliation-required",
      "recovery-required",
      "unavailable",
    ].includes(lifecycleState as string) ||
    !["present", "missing", "unavailable"].includes(databaseState as string) ||
    !["available", "reconciliation-required", "unavailable"].includes(
      backupState as string,
    ) ||
    !(
      sharedLeaseCount === null ||
      (Number.isSafeInteger(sharedLeaseCount) &&
        (sharedLeaseCount as number) >= 0 &&
        (sharedLeaseCount as number) <= 64)
    ) ||
    !(
      publishedBackupCount === null ||
      (Number.isSafeInteger(publishedBackupCount) &&
        (publishedBackupCount as number) >= 0 &&
        (publishedBackupCount as number) <= 8)
    )
  )
    return invalid();
  const retentionPolicy = normalizePlanEvidence({
    namespaceFingerprint: `sha256-${"0".repeat(64)}`,
    physicalEvidenceFingerprint: `sha256-${"0".repeat(64)}`,
    displayPath: "",
    persistentDataNotice: true,
    retentionPolicy: descriptors.retentionPolicy?.value as unknown,
  }).retentionPolicy;
  const retention = descriptors.databaseDerivedRetention?.value as unknown;
  if (
    typeof retention !== "object" ||
    retention === null ||
    Object.getPrototypeOf(retention) !== Object.prototype
  )
    return invalid();
  const retentionDescriptors = Object.getOwnPropertyDescriptors(retention);
  if (
    Object.keys(retentionDescriptors).sort().join(",") !==
      "clockContinuity,cutoff,payloadBytes,rowCount" ||
    Reflect.ownKeys(retentionDescriptors).length !== 4 ||
    Object.values(retentionDescriptors).some(
      (descriptor) =>
        !("value" in descriptor) || descriptor.value !== "unavailable",
    )
  )
    return invalid();
  return Object.freeze({
    state: state as LocalResourceDoctorInspection["state"],
    lifecycleState:
      lifecycleState as LocalResourceDoctorInspection["lifecycleState"],
    databaseState:
      databaseState as LocalResourceDoctorInspection["databaseState"],
    backupState: backupState as LocalResourceDoctorInspection["backupState"],
    sharedLeaseCount: sharedLeaseCount as number | null,
    publishedBackupCount: publishedBackupCount as number | null,
    retentionPolicy,
    databaseDerivedRetention: Object.freeze({
      cutoff: "unavailable",
      clockContinuity: "unavailable",
      rowCount: "unavailable",
      payloadBytes: "unavailable",
    }),
  });
};

export const inspectLocalResourceDoctor = async (
  registry: LocalResourceLifecycleHandlerRegistry,
  context: LocalResourceDoctorContext,
): Promise<LocalResourceDoctorInspection> => {
  if (!doctorContexts.has(context)) return invalid();
  const stored = registries
    .get(registry)
    ?.currentByDestinationType.get(context.destinationType);
  if (
    !stored ||
    !stored.inspectDoctor ||
    !stored.capability.operations.includes("doctor")
  )
    return invalid();
  return normalizeDoctorInspection(
    await bounded(
      (ownedSignal) =>
        stored.inspectDoctor!(
          Object.freeze({ ...context, signal: ownedSignal }),
        ),
      context.signal,
      context.deadline,
    ),
  );
};

const normalizeApplyResult = (
  result: unknown,
): LocalResourceLifecycleApplyResult => {
  if (
    typeof result !== "object" ||
    result === null ||
    Object.getPrototypeOf(result) !== Object.prototype
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(result);
  const ok = descriptors.ok?.value as unknown;
  const state = descriptors.state?.value as unknown;
  const keys =
    ok === true
      ? state === "retained"
        ? ["ok", "retainedAuthority", "state"]
        : ["ok", "state"]
      : ["code", "ok", "state"];
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor || !("value" in descriptor);
    })
  )
    return invalid();
  if (
    ok === true &&
    (state === "configured" || state === "deleted" || state === "rolled-back")
  )
    return Object.freeze({ ok: true, state });
  if (ok === true && state === "retained")
    return Object.freeze({
      ok: true,
      state,
      retainedAuthority: normalizeRetainedAuthority(
        descriptors.retainedAuthority?.value,
      ),
    });
  const code = descriptors.code?.value as unknown;
  if (
    ok !== false ||
    ![
      "configuration-committed",
      "prepared",
      "reconciliation-required",
      "unchanged",
    ].includes(state as string) ||
    ![
      "busy",
      "outcome-unknown",
      "reconciliation-required",
      "unavailable",
    ].includes(code as string)
  )
    return invalid();
  return Object.freeze({
    ok: false,
    state: state as Exclude<
      LocalResourceLifecycleApplyResult,
      { ok: true }
    >["state"],
    code: code as Exclude<
      LocalResourceLifecycleApplyResult,
      { ok: true }
    >["code"],
  });
};

export const applyLocalResourceLifecyclePlan = async (
  registry: LocalResourceLifecycleHandlerRegistry,
  context: LocalResourceLifecycleContext,
  planEvidence: LocalResourceLifecyclePlanEvidence,
  configurationAuthority: LocalResourceConfigurationAuthority,
  retainedAuthority?: LocalResourceRetainedDeleteAuthority,
): Promise<LocalResourceLifecycleApplyResult> => {
  if (!contexts.has(context)) return invalid();
  const stored = registries
    .get(registry)
    ?.currentByDestinationType.get(context.destinationType);
  if (!stored || !stored.capability.operations.includes(context.operation))
    return invalid();
  const result = await bounded(
    (ownedSignal) => {
      const invocation = bindLocalResourceConfigurationAuthorityForInvocation(
        configurationAuthority,
        ownedSignal,
      );
      const result = stored.apply(
        Object.freeze({
          ...context,
          signal: ownedSignal,
          planEvidence,
          configurationAuthority: invocation.authority,
          ...(retainedAuthority ? { retainedAuthority } : {}),
        }),
      );
      return result.then(
        async (value) => {
          await invocation.awaitCommitSettlement();
          return value;
        },
        async (error: unknown) => {
          await invocation.awaitCommitSettlement();
          throw error;
        },
      );
    },
    context.signal,
    context.deadline,
    true,
  );
  return normalizeApplyResult(result);
};

export const recoverLocalResourceLifecycle = async (
  registry: LocalResourceLifecycleHandlerRegistry,
  context: LocalResourceLifecycleRecoveryContext,
): Promise<LocalResourceLifecycleApplyResult> => {
  if (!recoveryContexts.has(context)) return invalid();
  const recoveryIdentity = `${context.destinationType}\u0000${context.lifecycleFingerprint}\u0000${context.recoveryHandlerId}`;
  const stored = registries
    .get(registry)
    ?.recoveryByIdentity.get(recoveryIdentity);
  if (
    !stored ||
    stored.capability.fingerprint !== context.lifecycleFingerprint ||
    stored.capability.recoveryHandlerId !== context.recoveryHandlerId ||
    !stored.capability.operations.includes("recover")
  )
    return invalid();
  const result = await bounded(
    (ownedSignal) => {
      const invocation = context.configurationAuthority
        ? bindLocalResourceConfigurationAuthorityForInvocation(
            context.configurationAuthority,
            ownedSignal,
          )
        : undefined;
      const result = stored.recover(
        Object.freeze({
          ...context,
          signal: ownedSignal,
          ...(invocation
            ? { configurationAuthority: invocation.authority }
            : {}),
        }),
      );
      return result.then(
        async (value) => {
          await invocation?.awaitCommitSettlement();
          return value;
        },
        async (error: unknown) => {
          await invocation?.awaitCommitSettlement();
          throw error;
        },
      );
    },
    context.signal,
    context.deadline,
    true,
  );
  return normalizeApplyResult(result);
};

export const completeLocalResourceLifecycle = async (
  registry: LocalResourceLifecycleHandlerRegistry,
  context:
    | LocalResourceLifecycleContext
    | LocalResourceLifecycleRecoveryContext
    | LocalResourceMaintenanceContext
    | LocalResourceMaintenanceRecoveryContext,
): Promise<void> => {
  const isRecovery = recoveryContexts.has(context);
  const isMaintenanceRecovery = maintenanceRecoveryContexts.has(context);
  const isMaintenance = maintenanceContexts.has(context);
  const storedRegistry = registries.get(registry);
  const stored =
    isRecovery || isMaintenanceRecovery
      ? storedRegistry?.recoveryByIdentity.get(
          `${context.destinationType}\u0000${(context as LocalResourceLifecycleRecoveryContext | LocalResourceMaintenanceRecoveryContext).lifecycleFingerprint}\u0000${(context as LocalResourceLifecycleRecoveryContext | LocalResourceMaintenanceRecoveryContext).recoveryHandlerId}`,
        )
      : storedRegistry?.currentByDestinationType.get(context.destinationType);
  if (
    (!isRecovery &&
      !isMaintenanceRecovery &&
      !isMaintenance &&
      !contexts.has(context)) ||
    !stored
  )
    return invalid();
  await bounded(
    (ownedSignal) =>
      stored.complete(
        context.operation,
        context.operationId,
        ownedSignal,
        context.deadline,
      ),
    context.signal,
    context.deadline,
    true,
  );
};
