import { createHash, randomBytes } from "node:crypto";

import {
  createDestinationConnectionId,
  getDestinationDescriptor,
  parseDestinationSettings,
  type DestinationConnectionId,
  type DestinationDescriptor,
  type DestinationRegistry,
} from "@agentscope/destinations-core/configuration";
import {
  applyLocalResourceLifecyclePlan,
  applyLocalResourceMaintenancePlan,
  completeLocalResourceLifecycle,
  getLocalResourceLifecycleHandlerCapability,
  inspectLocalResourceLifecyclePlan,
  inspectLocalResourceMaintenancePlan,
  inspectLocalResourceDoctor,
  inspectRetainedLocalResourceDelete,
  LocalResourceConfigurationCommitError,
  isLocalResourceLifecycleHandlerRegistry,
  localResourceLifecycleHandlerRegistryUsesDestinationRegistry,
  recoverLocalResourceLifecycle,
  recoverLocalResourceMaintenance,
  type LocalResourceDoctorInspection,
  type LocalResourceLifecycleApplyResult,
  type LocalResourceLifecycleContext,
  type LocalResourceLifecycleHandlerRegistry,
  type LocalResourceLifecyclePlanEvidence,
  type LocalResourceMaintenanceContext,
  type LocalResourceMaintenancePlanEvidence,
  type LocalResourceMaintenanceResult,
  type LocalResourceRetainedDeleteAuthority,
} from "@agentscope/destinations-core";
import {
  bindLocalResourceConfigurationAuthorityForCore,
  bindLocalResourceLifecycleContextForCore,
  bindLocalResourceLifecycleRecoveryContextForCore,
  bindLocalResourceMaintenanceContextForCore,
  bindLocalResourceMaintenanceRecoveryContextForCore,
  bindLocalResourceDoctorContextForCore,
  createLocalResourceLifecycleDeadlineForCore,
} from "@agentscope/destinations-core/core-orchestration";
import { z } from "zod";

import { BUILTIN_REDACTION_POLICY_REFERENCES } from "../redaction/policy-reference.js";
import {
  compileCredentialBackendRegistry,
  createCiEnvironmentCredentialAdapter,
  createCredentialResolutionContext,
  resolveCredentialReference,
  type CredentialBackendRegistry,
  type CredentialResolutionContext,
} from "./credential-adapter.js";
import {
  AGENTSCOPE_CONFIGURATION_VERSION,
  DEFAULT_HOOK_DEADLINE_MILLISECONDS,
  parseAgentscopeConfiguration,
  parseConfigurationCredentialReference,
  serializeAgentscopeConfiguration,
  type AgentscopeConfigurationSnapshot,
  type ConfigurationCredentialReference,
  type ConfiguredDestinationConnection,
} from "./schema.js";
import {
  completeLocalResourceMutationIntent,
  ConfigurationStoreError,
  configurationStoreUsesRegistry,
  createLocalResourceMutationIntent,
  isConfigurationProcessIdentity,
  isConfigurationStore,
  readConfigurationSnapshot,
  readRecoverableLocalResourceMutationIntent,
  recoverAbandonedConfigurationTransaction,
  inspectConfigurationTransaction,
  inspectRecoverableLocalResourceMutationIntent,
  isLocalResourceMutationCompletion,
  finalizeLocalResourceMutationCompletion,
  writeConfigurationSnapshot,
  type ConfigurationProcessIdentity,
  type ConfigurationStore,
  type ConfigurationOwnerState,
  type LocalResourceMutationRecord,
} from "./transaction.js";
import { cloneConfigurationDocument } from "./plain-data.js";

const connectionNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const commandNameSchema = connectionNameSchema;
const configureInputSchema = z.strictObject({
  commandName: commandNameSchema,
  credentialReferences: z.record(z.string(), z.unknown()),
  name: connectionNameSchema,
  settings: z.unknown(),
});
const configurationManagementRuntimes = new WeakMap<
  object,
  Readonly<{
    owner: ConfigurationProcessIdentity;
    registry: DestinationRegistry;
    store: ConfigurationStore;
    lifecycleHandlers?: LocalResourceLifecycleHandlerRegistry;
  }>
>();
const configurationCredentialPreflights = new WeakMap<
  object,
  Readonly<{
    context: CredentialResolutionContext;
    registry: CredentialBackendRegistry;
  }>
>();
const configurationInitializationPlans = new WeakMap<
  object,
  Readonly<{
    action: "create" | "no-change";
    generation: number | null;
    runtime: ConfigurationManagementRuntime;
  }>
>();
const consumedConfigurationInitializationPlans = new WeakSet<object>();
const destinationLifecyclePlans = new WeakMap<
  object,
  Readonly<{
    runtime: ConfigurationManagementRuntime;
    operation: "configure" | "delete" | "unconfigure";
    context: LocalResourceLifecycleContext;
    evidence: LocalResourceLifecyclePlanEvidence;
    candidates: readonly AgentscopeConfigurationSnapshot[];
    connectionName: string;
    retainedAuthority?: LocalResourceRetainedDeleteAuthority;
  }>
>();
const consumedDestinationLifecyclePlans = new WeakSet<object>();
const destinationMaintenancePlans = new WeakMap<
  object,
  Readonly<{
    runtime: ConfigurationManagementRuntime;
    context: LocalResourceMaintenanceContext;
    evidence: LocalResourceMaintenancePlanEvidence;
    connectionName: string;
  }>
>();
const consumedDestinationMaintenancePlans = new WeakSet<object>();
const destinationLifecycleRecoveryPlans = new WeakMap<
  object,
  Readonly<{
    runtime: ConfigurationManagementRuntime;
    ownerState: (
      owner: ConfigurationProcessIdentity,
    ) => ConfigurationOwnerState;
    signal: AbortSignal;
    intent: LocalResourceMutationRecord;
  }>
>();
const consumedDestinationLifecycleRecoveryPlans = new WeakSet<object>();

export type ConfigurationManagementRuntime = Readonly<{
  readonly configurationManagement: "agentscope-core";
}>;

export type ConfigurationCredentialPreflight = Readonly<{
  readonly configurationCredentialPreflight: "agentscope-core";
}>;

export type ConfigurationInitializationPlan = Readonly<{
  readonly action: "create" | "no-change";
  readonly configurationInitializationPlan: "agentscope-core";
  readonly generation: number | null;
}>;

export type DestinationLifecyclePlan = Readonly<{
  readonly destinationLifecyclePlan: "agentscope-core";
  readonly operation: "configure" | "delete" | "unconfigure";
  readonly connectionName: string;
  readonly destinationType: string;
  readonly displayPath: string;
  readonly persistentDataNotice: true;
  readonly retentionPolicy: LocalResourceLifecyclePlanEvidence["retentionPolicy"];
}>;

export type DestinationMaintenancePlan = Readonly<{
  readonly destinationMaintenancePlan: "agentscope-core";
  readonly operation: "backup" | "restore";
  readonly connectionName: string;
  readonly destinationType: string;
  readonly displayPath: string;
  readonly persistentDataNotice: true;
  readonly retentionPolicy: LocalResourceLifecyclePlanEvidence["retentionPolicy"];
  readonly backupSelector: string;
}>;

export type DestinationMaintenanceResult = Readonly<{
  operation: "backup" | "restore";
  connectionName: string;
  state: "backed-up" | "restored";
  backupSelector: string;
}>;

export type DestinationLifecycleRecoveryPlan = Readonly<{
  readonly authorizedGenerations: readonly number[];
  readonly destinationLifecycleRecoveryPlan: "agentscope-core";
  readonly connectionId: string;
  readonly destinationType: string;
  readonly expectedGeneration: number;
  readonly lifecycleFingerprint: string;
  readonly operationId: string;
  readonly pendingOperation:
    "backup" | "configure" | "delete" | "restore" | "unconfigure";
  readonly recoveryStage: "completion" | "intent";
}>;

export type DestinationDoctorInspection = Readonly<{
  connectionName: string;
  destinationType: string;
  inspection: LocalResourceDoctorInspection;
}>;

export type DestinationConnectionSummary = Readonly<{
  connectionId: DestinationConnectionId;
  destinationType: string;
  name: string;
  routed: boolean;
  settingsVersion: number;
  transport: "local" | "remote";
}>;

export type ConfigureDestinationConnectionInput = Readonly<{
  commandName: string;
  credentialReferences: Readonly<
    Record<string, ConfigurationCredentialReference>
  >;
  name: string;
  settings: unknown;
}>;

export type DestinationConfigurationResult = Readonly<{
  connection: DestinationConnectionSummary;
  generation: number;
}>;

export class ConfigurationManagementError extends Error {
  public constructor(
    public readonly code:
      | "core.configuration.conflict"
      | "core.configuration.invalid"
      | "core.configuration.missing"
      | "core.configuration.unavailable"
      | "core.destination.connection-exists"
      | "core.destination.connection-missing"
      | "core.destination.credential-unavailable"
      | "core.destination.credential-removal-required"
      | "core.destination.lifecycle-busy"
      | "core.destination.lifecycle-capacity"
      | "core.destination.lifecycle-outcome-unknown"
      | "core.destination.lifecycle-reconciliation-required"
      | "core.destination.lifecycle-unavailable"
      | "core.destination.type-missing",
  ) {
    super(code);
    this.name = "ConfigurationManagementError";
  }
}

const invalid = (
  code: ConfigurationManagementError["code"] = "core.configuration.invalid",
): never => {
  throw new ConfigurationManagementError(code);
};

const signalAborted = (signal: AbortSignal): boolean => {
  try {
    return signal.aborted;
  } catch {
    return true;
  }
};

export const createCiEnvironmentCredentialPreflight = (
  environment: object,
  signal: AbortSignal,
): ConfigurationCredentialPreflight => {
  const context = createCredentialResolutionContext("interactive", signal);
  const registry = compileCredentialBackendRegistry([
    createCiEnvironmentCredentialAdapter(environment),
  ]);
  const preflight = Object.freeze({
    configurationCredentialPreflight: "agentscope-core" as const,
  });
  configurationCredentialPreflights.set(preflight, { context, registry });
  return preflight;
};

const stored = (
  runtime: ConfigurationManagementRuntime,
): NonNullable<ReturnType<typeof configurationManagementRuntimes.get>> =>
  configurationManagementRuntimes.get(runtime) ?? invalid();

export const createConfigurationManagementRuntime = (
  registry: DestinationRegistry,
  store: ConfigurationStore,
  owner: ConfigurationProcessIdentity,
  lifecycleHandlers?: LocalResourceLifecycleHandlerRegistry,
): ConfigurationManagementRuntime => {
  if (
    !isConfigurationStore(store) ||
    !configurationStoreUsesRegistry(store, registry) ||
    !isConfigurationProcessIdentity(owner) ||
    (lifecycleHandlers !== undefined &&
      (!isLocalResourceLifecycleHandlerRegistry(lifecycleHandlers) ||
        !localResourceLifecycleHandlerRegistryUsesDestinationRegistry(
          lifecycleHandlers,
          registry,
        )))
  )
    return invalid();
  const runtime = Object.freeze({
    configurationManagement: "agentscope-core" as const,
  });
  configurationManagementRuntimes.set(runtime, {
    owner,
    registry,
    store,
    ...(lifecycleHandlers === undefined ? {} : { lifecycleHandlers }),
  });
  return runtime;
};

const mapStoreError = (error: unknown): never => {
  /* v8 ignore next -- the branded store exposes only fixed ConfigurationStoreError failures. */
  if (!(error instanceof ConfigurationStoreError))
    return invalid("core.configuration.unavailable");
  /* v8 ignore next 6 -- management callers preserve the exact fixed store code; each store family is covered at its source. */
  if (
    error.code === "core.configuration.conflict" ||
    error.code === "core.configuration.missing" ||
    error.code === "core.configuration.invalid"
  )
    return invalid(error.code);
  /* v8 ignore next -- remaining fixed store codes are unavailable and are covered at the store boundary. */
  return invalid("core.configuration.unavailable");
};

const documentOf = (
  snapshot: AgentscopeConfigurationSnapshot,
): Record<string, unknown> =>
  JSON.parse(serializeAgentscopeConfiguration(snapshot)) as Record<
    string,
    unknown
  >;

const destinationDocument = (
  document: Record<string, unknown>,
): Record<string, unknown> => {
  const value = document.destinations;
  /* v8 ignore next -- documentOf reconstructs this field from a branded current snapshot. */
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
};

const snapshotDigest = (snapshot: AgentscopeConfigurationSnapshot): string =>
  `sha256-${createHash("sha256")
    .update(serializeAgentscopeConfiguration(snapshot), "utf8")
    .digest("hex")}`;

const createOperationId = (): string => {
  let value = "0".repeat(32);
  while (/^0{32}$/u.test(value)) value = randomBytes(16).toString("hex");
  return value;
};

const removalCandidate = (
  current: AgentscopeConfigurationSnapshot,
  connection: ConfiguredDestinationConnection,
  registry: DestinationRegistry,
): AgentscopeConfigurationSnapshot => {
  const document = documentOf(current);
  document.generation = current.generation + 1;
  const destinations = destinationDocument(document);
  const namespace = destinations[connection.destinationType] as {
    connections: Array<{ connectionId: string }>;
  };
  namespace.connections = namespace.connections.filter(
    (candidate) => candidate.connectionId !== connection.connectionId,
  );
  if (namespace.connections.length === 0)
    delete destinations[connection.destinationType];
  const routing = document.routing as Record<string, unknown>;
  routing.selectedConnectionIds = current.selectedConnectionIds.filter(
    (connectionId) => connectionId !== connection.connectionId,
  );
  return parseAgentscopeConfiguration(document, registry);
};

const generationOnlyCandidate = (
  current: AgentscopeConfigurationSnapshot,
  registry: DestinationRegistry,
): AgentscopeConfigurationSnapshot => {
  const document = documentOf(current);
  document.generation = current.generation + 1;
  return parseAgentscopeConfiguration(document, registry);
};

const summary = (
  snapshot: AgentscopeConfigurationSnapshot,
  connection: ConfiguredDestinationConnection,
): DestinationConnectionSummary => {
  const descriptor = getDestinationDescriptor(
    snapshot.destinationRegistry,
    connection.destinationType,
  );
  /* v8 ignore next -- a mutation-safe snapshot is compiled against this exact registry. */
  if (!descriptor) return invalid();
  return Object.freeze({
    connectionId: connection.connectionId,
    destinationType: connection.destinationType,
    name: connection.name,
    routed: snapshot.selectedConnectionIds.includes(connection.connectionId),
    settingsVersion: descriptor.settingsVersion,
    transport: descriptor.transport.kind,
  });
};

const writeCandidate = async (
  runtime: ConfigurationManagementRuntime,
  current: AgentscopeConfigurationSnapshot,
  document: Record<string, unknown>,
): Promise<AgentscopeConfigurationSnapshot> => {
  const state = stored(runtime);
  document.generation = current.generation + 1;
  const candidate = parseAgentscopeConfiguration(document, state.registry);
  try {
    return await writeConfigurationSnapshot(state.store, {
      candidate,
      expectedGeneration: current.generation,
      owner: state.owner,
    });
  } catch (error) {
    /* v8 ignore next -- transaction failure families are exhaustively covered by the fenced store tests. */
    return mapStoreError(error);
  }
};

export const inspectAgentscopeConfigurationInitialization = async (
  runtime: ConfigurationManagementRuntime,
): Promise<ConfigurationInitializationPlan> => {
  const state = stored(runtime);
  let action: "create" | "no-change" = "create";
  let generation: number | null = null;
  try {
    const current = await readConfigurationSnapshot(state.store);
    /* v8 ignore next -- an unsupported namespace cannot be minted by this management registry. */
    if (!current.mutationSafe) return invalid();
    action = "no-change";
    generation = current.generation;
  } catch (error) {
    /* v8 ignore next -- branded store reads throw only the fixed store error family. */
    if (
      !(error instanceof ConfigurationStoreError) ||
      error.code !== "core.configuration.missing"
    )
      return mapStoreError(error);
  }
  const plan = Object.freeze({
    action,
    configurationInitializationPlan: "agentscope-core" as const,
    generation,
  });
  configurationInitializationPlans.set(plan, { action, generation, runtime });
  return plan;
};

export const applyAgentscopeConfigurationInitialization = async (
  plan: ConfigurationInitializationPlan,
): Promise<Readonly<{ created: boolean; generation: number }>> => {
  const authority = configurationInitializationPlans.get(plan);
  if (!authority || consumedConfigurationInitializationPlans.has(plan))
    return invalid();
  consumedConfigurationInitializationPlans.add(plan);
  const state = stored(authority.runtime);
  if (authority.action === "no-change") {
    let current: AgentscopeConfigurationSnapshot;
    try {
      current = await readConfigurationSnapshot(state.store);
    } catch (error) {
      return mapStoreError(error);
    }
    if (
      !current.mutationSafe ||
      authority.generation === null ||
      current.generation !== authority.generation
    )
      return invalid("core.configuration.conflict");
    return Object.freeze({ created: false, generation: current.generation });
  }
  const candidate = parseAgentscopeConfiguration(
    {
      configurationVersion: AGENTSCOPE_CONFIGURATION_VERSION,
      destinations: {},
      generation: 0,
      policy: {
        reference: BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
        version: 1,
      },
      routing: {
        hookDeadlineMilliseconds: DEFAULT_HOOK_DEADLINE_MILLISECONDS,
        selectedConnectionIds: [],
        version: 1,
      },
    },
    state.registry,
  );
  try {
    await writeConfigurationSnapshot(state.store, {
      candidate,
      expectedGeneration: null,
      owner: state.owner,
    });
    return Object.freeze({ created: true, generation: 0 });
  } catch (error) {
    /* v8 ignore next -- initial-write contention and recovery are covered by the transaction service. */
    return mapStoreError(error);
  }
};

export const initializeAgentscopeConfiguration = async (
  runtime: ConfigurationManagementRuntime,
): Promise<Readonly<{ created: boolean; generation: number }>> =>
  applyAgentscopeConfigurationInitialization(
    await inspectAgentscopeConfigurationInitialization(runtime),
  );

export const listDestinationConnections = async (
  runtime: ConfigurationManagementRuntime,
): Promise<readonly DestinationConnectionSummary[]> => {
  const state = stored(runtime);
  try {
    const snapshot = await readConfigurationSnapshot(state.store);
    /* v8 ignore next -- an unsupported namespace cannot be minted by this management registry. */
    if (!snapshot.mutationSafe) return invalid();
    return Object.freeze(
      snapshot.connections.map((connection) => summary(snapshot, connection)),
    );
  } catch (error) {
    /* v8 ignore next -- branded store reads throw only the fixed store error family. */
    return mapStoreError(error);
  }
};

const descriptorByCommand = (
  registry: DestinationRegistry,
  commandName: string,
): DestinationDescriptor =>
  registry.descriptors.find(
    (descriptor) => descriptor.commandName === commandName,
  ) ?? invalid("core.destination.type-missing");

const parseReferences = (
  descriptor: DestinationDescriptor,
  input: Readonly<Record<string, ConfigurationCredentialReference>>,
): Record<string, ConfigurationCredentialReference> => {
  const descriptors = Object.getOwnPropertyDescriptors(input);
  /* v8 ignore next -- cloneConfigurationDocument reconstructs an exact plain record before this seam. */
  if (
    Object.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")
  )
    return invalid();
  const declared = new Map<string, (typeof descriptor.credentialSlots)[number]>(
    descriptor.credentialSlots.map((slot) => [slot.id, slot]),
  );
  const output: Record<string, ConfigurationCredentialReference> = {};
  for (const key of Object.keys(descriptors).sort()) {
    const property = descriptors[key];
    /* v8 ignore next -- the exact cloned own-key inventory guarantees a data descriptor. */
    if (!property || !("value" in property) || !declared.has(key))
      return invalid();
    output[key] = parseConfigurationCredentialReference(property.value);
  }
  for (const slot of descriptor.credentialSlots)
    if (slot.required && output[slot.id] === undefined) return invalid();
  return output;
};

const preflightReferences = async (
  references: Readonly<Record<string, ConfigurationCredentialReference>>,
  preflight: ConfigurationCredentialPreflight | undefined,
): Promise<void> => {
  if (Object.keys(references).length === 0) return;
  const authority = preflight
    ? configurationCredentialPreflights.get(preflight)
    : undefined;
  if (!authority) return invalid("core.destination.credential-unavailable");
  const resolutions = await Promise.all(
    Object.values(references).map((reference) =>
      resolveCredentialReference(
        authority.registry,
        reference,
        authority.context,
      ),
    ),
  );
  if (resolutions.some((resolution) => !resolution.ok))
    return invalid("core.destination.credential-unavailable");
};

const appendConfiguredConnection = (
  value: Readonly<{
    current: AgentscopeConfigurationSnapshot;
    registry: DestinationRegistry;
    descriptor: DestinationDescriptor;
    input: z.infer<typeof configureInputSchema>;
    connectionId: DestinationConnectionId;
    settings: ConfiguredDestinationConnection["settings"];
    credentialReferences: Readonly<
      Record<string, ConfigurationCredentialReference>
    >;
  }>,
): Readonly<{
  candidate: AgentscopeConfigurationSnapshot;
  connection: ConfiguredDestinationConnection;
}> => {
  const document = documentOf(value.current);
  document.generation = value.current.generation + 1;
  const destinations = destinationDocument(document);
  const existing = destinations[value.descriptor.destinationType] as
    | Readonly<{
        connections?: unknown[];
        namespaceVersion?: number;
        settingsVersion?: number;
      }>
    | undefined;
  if (
    existing !== undefined &&
    (existing.namespaceVersion !== 1 ||
      existing.settingsVersion !== value.descriptor.settingsVersion ||
      !Array.isArray(existing.connections))
  )
    return invalid();
  destinations[value.descriptor.destinationType] = {
    connections: [
      ...(existing?.connections ?? []),
      {
        connectionId: value.connectionId,
        credentialReferences: value.credentialReferences,
        name: value.input.name,
        settings: value.settings,
      },
    ],
    namespaceVersion: 1,
    settingsVersion: value.descriptor.settingsVersion,
  };
  const candidate = parseAgentscopeConfiguration(document, value.registry);
  const connection = candidate.connections.find(
    (entry) => entry.connectionId === value.connectionId,
  );
  if (!connection) return invalid();
  return Object.freeze({ candidate, connection });
};

export const configureDestinationConnection = async (
  runtime: ConfigurationManagementRuntime,
  input: ConfigureDestinationConnectionInput,
  preflight?: ConfigurationCredentialPreflight,
): Promise<DestinationConfigurationResult> => {
  const state = stored(runtime);
  let candidateInput: z.infer<typeof configureInputSchema>;
  try {
    candidateInput = configureInputSchema.parse(
      cloneConfigurationDocument(input),
    );
  } catch {
    return invalid();
  }
  const descriptor = descriptorByCommand(
    state.registry,
    candidateInput.commandName,
  );
  if (descriptor.localResourceLifecycle)
    return invalid("core.destination.lifecycle-unavailable");
  const settings = parseDestinationSettings(
    descriptor,
    candidateInput.settings,
  );
  const credentialReferences = parseReferences(
    descriptor,
    candidateInput.credentialReferences as Readonly<
      Record<string, ConfigurationCredentialReference>
    >,
  );
  await preflightReferences(credentialReferences, preflight);
  let current: AgentscopeConfigurationSnapshot;
  try {
    current = await readConfigurationSnapshot(state.store);
  } catch (error) {
    /* v8 ignore next -- branded store reads throw only the fixed store error family. */
    return mapStoreError(error);
  }
  /* v8 ignore next -- an unsupported namespace cannot be minted by this management registry. */
  if (!current.mutationSafe) return invalid();
  if (
    current.connections.some(
      (connection) => connection.name === candidateInput.name,
    )
  )
    return invalid("core.destination.connection-exists");
  const document = documentOf(current);
  const destinations = destinationDocument(document);
  const existing = destinations[descriptor.destinationType] as
    | Readonly<{
        connections?: unknown[];
        namespaceVersion?: number;
        settingsVersion?: number;
      }>
    | undefined;
  /* v8 ignore next 7 -- current parsing already proves the registered namespace shape and version. */
  if (
    existing !== undefined &&
    (existing.namespaceVersion !== 1 ||
      existing.settingsVersion !== descriptor.settingsVersion ||
      !Array.isArray(existing.connections))
  )
    return invalid();
  const connectionId = createDestinationConnectionId(
    `destination-connection-v1-${randomBytes(32).toString("hex")}`,
  );
  destinations[descriptor.destinationType] = {
    connections: [
      ...(existing?.connections ?? []),
      {
        connectionId,
        credentialReferences,
        name: candidateInput.name,
        settings,
      },
    ],
    namespaceVersion: 1,
    settingsVersion: descriptor.settingsVersion,
  };
  const written = await writeCandidate(runtime, current, document);
  const connection = written.connections.find(
    (candidate) => candidate.connectionId === connectionId,
  );
  /* v8 ignore next -- the candidate inserts this freshly minted identity before the atomic write. */
  if (!connection) return invalid();
  return Object.freeze({
    connection: summary(written, connection),
    generation: written.generation,
  });
};

export const setDestinationRouting = async (
  runtime: ConfigurationManagementRuntime,
  namesInput: readonly string[],
): Promise<Readonly<{ generation: number; selected: readonly string[] }>> => {
  const state = stored(runtime);
  const names = z.array(connectionNameSchema).max(32).parse(namesInput);
  if (new Set(names).size !== names.length) return invalid();
  let current: AgentscopeConfigurationSnapshot;
  try {
    current = await readConfigurationSnapshot(state.store);
  } catch (error) {
    /* v8 ignore next -- branded store reads throw only the fixed store error family. */
    return mapStoreError(error);
  }
  /* v8 ignore next -- an unsupported namespace cannot be minted by this management registry. */
  if (!current.mutationSafe) return invalid();
  const byName = new Map(
    current.connections.map((connection) => [connection.name, connection]),
  );
  const selected = names.map(
    (name) =>
      byName.get(name)?.connectionId ??
      invalid("core.destination.connection-missing"),
  );
  const document = documentOf(current);
  const routing = document.routing;
  /* v8 ignore next -- documentOf reconstructs routing from a branded current snapshot. */
  if (typeof routing !== "object" || routing === null || Array.isArray(routing))
    return invalid();
  (routing as Record<string, unknown>).selectedConnectionIds = selected;
  const written = await writeCandidate(runtime, current, document);
  return Object.freeze({
    generation: written.generation,
    selected: Object.freeze(
      written.connections
        .filter((connection) =>
          written.selectedConnectionIds.includes(connection.connectionId),
        )
        .map((connection) => connection.name)
        .sort(),
    ),
  });
};

export const inspectDestinationLifecyclePlan = async (
  runtime: ConfigurationManagementRuntime,
  operation: "delete" | "unconfigure",
  nameInput: string,
  signal: AbortSignal,
  // eslint-disable-next-line max-lines-per-function -- one immutable plan binds config, retained authority, and lifecycle evidence.
): Promise<DestinationLifecyclePlan> => {
  const state = stored(runtime);
  const parsedName = connectionNameSchema.safeParse(nameInput);
  if (!(signal instanceof AbortSignal) || signalAborted(signal))
    return invalid("core.destination.lifecycle-unavailable");
  let current: AgentscopeConfigurationSnapshot;
  try {
    current = await readConfigurationSnapshot(state.store);
  } catch (error) {
    return mapStoreError(error);
  }
  if (!current.mutationSafe) return invalid();
  const connection = current.connections.find(
    (candidate) => parsedName.success && candidate.name === parsedName.data,
  );
  const lifecycleHandlers = state.lifecycleHandlers;
  if (!lifecycleHandlers)
    return invalid("core.destination.lifecycle-unavailable");
  let destinationType: string;
  let connectionId: string;
  let connectionName: string;
  let settings: ConfiguredDestinationConnection["settings"];
  let evidence: LocalResourceLifecyclePlanEvidence | undefined;
  let retainedAuthority: LocalResourceRetainedDeleteAuthority | undefined;
  let candidates: readonly AgentscopeConfigurationSnapshot[];
  if (!connection) {
    if (operation !== "delete")
      return invalid("core.destination.connection-missing");
    let retained;
    try {
      retained = await inspectRetainedLocalResourceDelete(
        lifecycleHandlers,
        nameInput,
        signal,
        createLocalResourceLifecycleDeadlineForCore(
          DEFAULT_HOOK_DEADLINE_MILLISECONDS,
        ),
      );
    } catch {
      return invalid("core.destination.lifecycle-unavailable");
    }
    if (!retained) return invalid("core.destination.connection-missing");
    destinationType = retained.destinationType;
    connectionId = retained.connectionId;
    connectionName = retained.connectionName;
    settings = Object.freeze({});
    evidence = retained.planEvidence;
    retainedAuthority = retained.retainedAuthority;
    const first = generationOnlyCandidate(current, state.registry);
    candidates = Object.freeze([
      first,
      generationOnlyCandidate(first, state.registry),
    ]);
  } else {
    if (Object.keys(connection.credentialReferences).length > 0)
      return invalid("core.destination.credential-removal-required");
    destinationType = connection.destinationType;
    connectionId = connection.connectionId;
    connectionName = connection.name;
    settings = connection.settings;
    const first = removalCandidate(current, connection, state.registry);
    candidates =
      operation === "delete"
        ? Object.freeze([first, generationOnlyCandidate(first, state.registry)])
        : Object.freeze([first]);
  }
  const descriptor = getDestinationDescriptor(state.registry, destinationType);
  const capability = descriptor?.localResourceLifecycle;
  const registered = getLocalResourceLifecycleHandlerCapability(
    lifecycleHandlers,
    destinationType,
  );
  if (
    !descriptor ||
    !capability ||
    !registered ||
    registered.fingerprint !== capability.fingerprint ||
    !capability.operations.includes(operation)
  )
    return invalid("core.destination.lifecycle-unavailable");
  const finalCandidate = candidates[candidates.length - 1]!;
  const context: LocalResourceLifecycleContext =
    bindLocalResourceLifecycleContextForCore({
      operation,
      operationId: createOperationId(),
      destinationType,
      connectionId,
      connectionName,
      owner: state.owner,
      settings,
      expectedConfigurationGeneration: current.generation,
      candidateConfigurationGeneration: finalCandidate.generation,
      expectedConfigurationDigest: snapshotDigest(current),
      candidateConfigurationDigest: snapshotDigest(finalCandidate),
      signal,
      deadline: createLocalResourceLifecycleDeadlineForCore(
        DEFAULT_HOOK_DEADLINE_MILLISECONDS,
      ),
    });
  if (!evidence) {
    try {
      evidence = await inspectLocalResourceLifecyclePlan(
        lifecycleHandlers,
        context,
      );
    } catch {
      return invalid("core.destination.lifecycle-unavailable");
    }
  }
  if (signalAborted(signal))
    return invalid("core.destination.lifecycle-unavailable");
  const plan = Object.freeze({
    destinationLifecyclePlan: "agentscope-core" as const,
    operation,
    connectionName,
    destinationType,
    displayPath: evidence.displayPath,
    persistentDataNotice: true as const,
    retentionPolicy: evidence.retentionPolicy,
  });
  destinationLifecyclePlans.set(
    plan,
    Object.freeze({
      runtime,
      operation,
      context,
      evidence,
      candidates,
      connectionName,
      ...(retainedAuthority ? { retainedAuthority } : {}),
    }),
  );
  return plan;
};

export const inspectDestinationConfigureLifecyclePlan = async (
  runtime: ConfigurationManagementRuntime,
  input: ConfigureDestinationConnectionInput,
  signal: AbortSignal,
  preflight?: ConfigurationCredentialPreflight,
  // eslint-disable-next-line max-lines-per-function -- configure preflight and immutable lifecycle planning share one authority boundary.
): Promise<DestinationLifecyclePlan> => {
  const state = stored(runtime);
  if (!(signal instanceof AbortSignal) || signalAborted(signal))
    return invalid("core.destination.lifecycle-unavailable");
  let candidateInput: z.infer<typeof configureInputSchema>;
  try {
    candidateInput = configureInputSchema.parse(
      cloneConfigurationDocument(input),
    );
  } catch {
    return invalid();
  }
  const descriptor = descriptorByCommand(
    state.registry,
    candidateInput.commandName,
  );
  const capability = descriptor.localResourceLifecycle;
  const lifecycleHandlers = state.lifecycleHandlers;
  const registered = lifecycleHandlers
    ? getLocalResourceLifecycleHandlerCapability(
        lifecycleHandlers,
        descriptor.destinationType,
      )
    : undefined;
  if (
    !capability ||
    !lifecycleHandlers ||
    !registered ||
    registered.fingerprint !== capability.fingerprint ||
    !capability.operations.includes("configure")
  )
    return invalid("core.destination.lifecycle-unavailable");
  const settings = parseDestinationSettings(
    descriptor,
    candidateInput.settings,
  );
  const credentialReferences = parseReferences(
    descriptor,
    candidateInput.credentialReferences as Readonly<
      Record<string, ConfigurationCredentialReference>
    >,
  );
  await preflightReferences(credentialReferences, preflight);
  let current: AgentscopeConfigurationSnapshot;
  try {
    current = await readConfigurationSnapshot(state.store);
  } catch (error) {
    return mapStoreError(error);
  }
  if (!current.mutationSafe) return invalid();
  if (
    current.connections.some(
      (connection) => connection.name === candidateInput.name,
    )
  )
    return invalid("core.destination.connection-exists");
  const connectionId = createDestinationConnectionId(
    `destination-connection-v1-${randomBytes(32).toString("hex")}`,
  );
  const { candidate, connection } = appendConfiguredConnection({
    current,
    registry: state.registry,
    descriptor,
    input: candidateInput,
    connectionId,
    settings,
    credentialReferences,
  });
  const context: LocalResourceLifecycleContext =
    bindLocalResourceLifecycleContextForCore({
      operation: "configure",
      operationId: createOperationId(),
      destinationType: connection.destinationType,
      connectionId: connection.connectionId,
      connectionName: connection.name,
      owner: state.owner,
      settings: connection.settings,
      expectedConfigurationGeneration: current.generation,
      candidateConfigurationGeneration: candidate.generation,
      expectedConfigurationDigest: snapshotDigest(current),
      candidateConfigurationDigest: snapshotDigest(candidate),
      signal,
      deadline: createLocalResourceLifecycleDeadlineForCore(
        DEFAULT_HOOK_DEADLINE_MILLISECONDS,
      ),
    });
  let evidence: LocalResourceLifecyclePlanEvidence;
  try {
    evidence = await inspectLocalResourceLifecyclePlan(
      lifecycleHandlers,
      context,
    );
  } catch {
    return invalid("core.destination.lifecycle-unavailable");
  }
  if (signalAborted(signal))
    return invalid("core.destination.lifecycle-unavailable");
  const plan = Object.freeze({
    destinationLifecyclePlan: "agentscope-core" as const,
    operation: "configure" as const,
    connectionName: connection.name,
    destinationType: connection.destinationType,
    displayPath: evidence.displayPath,
    persistentDataNotice: true as const,
    retentionPolicy: evidence.retentionPolicy,
  });
  destinationLifecyclePlans.set(
    plan,
    Object.freeze({
      runtime,
      operation: "configure",
      context,
      evidence,
      candidates: Object.freeze([candidate]),
      connectionName: connection.name,
    }),
  );
  return plan;
};

const mapLifecycleFailure = (
  result: Exclude<LocalResourceLifecycleApplyResult, { ok: true }>,
): never => {
  if (result.code === "busy") return invalid("core.destination.lifecycle-busy");
  if (result.code === "reconciliation-required")
    return invalid("core.destination.lifecycle-reconciliation-required");
  if (result.code === "outcome-unknown")
    return invalid("core.destination.lifecycle-outcome-unknown");
  return invalid("core.destination.lifecycle-unavailable");
};

const mapMaintenanceFailure = (
  result: Exclude<LocalResourceMaintenanceResult, { ok: true }>,
): never => {
  if (result.code === "busy") return invalid("core.destination.lifecycle-busy");
  if (result.code === "capacity")
    return invalid("core.destination.lifecycle-capacity");
  if (result.code === "reconciliation-required")
    return invalid("core.destination.lifecycle-reconciliation-required");
  if (result.code === "outcome-unknown")
    return invalid("core.destination.lifecycle-outcome-unknown");
  return invalid("core.destination.lifecycle-unavailable");
};

export const inspectDestinationMaintenancePlan = async (
  runtime: ConfigurationManagementRuntime,
  operation: "backup" | "restore",
  nameInput: string,
  backupSelectorInput: string | undefined,
  signal: AbortSignal,
): Promise<DestinationMaintenancePlan> => {
  const state = stored(runtime);
  const parsedName = connectionNameSchema.safeParse(nameInput);
  if (
    !parsedName.success ||
    !(signal instanceof AbortSignal) ||
    signalAborted(signal)
  )
    return invalid("core.destination.lifecycle-unavailable");
  if (
    (operation === "backup" && backupSelectorInput !== undefined) ||
    (operation === "restore" &&
      (typeof backupSelectorInput !== "string" ||
        !/^(?!0{32}$)[0-9a-f]{32}$/u.test(backupSelectorInput)))
  )
    return invalid();
  let current: AgentscopeConfigurationSnapshot;
  try {
    current = await readConfigurationSnapshot(state.store);
  } catch (error) {
    return mapStoreError(error);
  }
  if (!current.mutationSafe)
    return invalid("core.destination.lifecycle-unavailable");
  const connection = current.connections.find(
    (candidate) => candidate.name === parsedName.data,
  );
  if (!connection) return invalid("core.destination.connection-missing");
  const capability = getDestinationDescriptor(
    state.registry,
    connection.destinationType,
  )?.localResourceLifecycle;
  const registered = state.lifecycleHandlers
    ? getLocalResourceLifecycleHandlerCapability(
        state.lifecycleHandlers,
        connection.destinationType,
      )
    : undefined;
  if (
    !state.lifecycleHandlers ||
    !capability ||
    !registered ||
    registered.fingerprint !== capability.fingerprint ||
    !capability.operations.includes(operation)
  )
    return invalid("core.destination.lifecycle-unavailable");
  const operationId = createOperationId();
  const resourceSelector =
    operation === "backup" ? createOperationId() : backupSelectorInput!;
  const context = bindLocalResourceMaintenanceContextForCore({
    operation,
    operationId,
    resourceSelector,
    destinationType: connection.destinationType,
    connectionId: connection.connectionId,
    connectionName: connection.name,
    owner: state.owner,
    settings: connection.settings,
    configurationGeneration: current.generation,
    configurationDigest: snapshotDigest(current),
    signal,
    deadline: createLocalResourceLifecycleDeadlineForCore(
      DEFAULT_HOOK_DEADLINE_MILLISECONDS,
    ),
  });
  let evidence: LocalResourceMaintenancePlanEvidence;
  try {
    evidence = await inspectLocalResourceMaintenancePlan(
      state.lifecycleHandlers,
      context,
    );
  } catch {
    return invalid("core.destination.lifecycle-unavailable");
  }
  if (signalAborted(signal))
    return invalid("core.destination.lifecycle-unavailable");
  const plan = Object.freeze({
    destinationMaintenancePlan: "agentscope-core" as const,
    operation,
    connectionName: connection.name,
    destinationType: connection.destinationType,
    displayPath: evidence.planEvidence.displayPath,
    persistentDataNotice: true as const,
    retentionPolicy: evidence.planEvidence.retentionPolicy,
    backupSelector: resourceSelector,
  });
  destinationMaintenancePlans.set(
    plan,
    Object.freeze({
      runtime,
      context,
      evidence,
      connectionName: connection.name,
    }),
  );
  return plan;
};

export const applyDestinationMaintenancePlan = async (
  plan: DestinationMaintenancePlan,
): Promise<DestinationMaintenanceResult> => {
  const authority = destinationMaintenancePlans.get(plan);
  if (!authority || consumedDestinationMaintenancePlans.has(plan))
    return invalid();
  consumedDestinationMaintenancePlans.add(plan);
  const state = stored(authority.runtime);
  if (!state.lifecycleHandlers || signalAborted(authority.context.signal))
    return invalid("core.destination.lifecycle-unavailable");
  let current: AgentscopeConfigurationSnapshot;
  try {
    current = await readConfigurationSnapshot(state.store);
  } catch (error) {
    return mapStoreError(error);
  }
  if (
    !current.mutationSafe ||
    current.generation !== authority.context.configurationGeneration ||
    snapshotDigest(current) !== authority.context.configurationDigest
  )
    return invalid("core.configuration.conflict");
  const capability = getLocalResourceLifecycleHandlerCapability(
    state.lifecycleHandlers,
    authority.context.destinationType,
  );
  if (!capability) return invalid("core.destination.lifecycle-unavailable");
  const context = bindLocalResourceMaintenanceContextForCore({
    operation: authority.context.operation,
    operationId: authority.context.operationId,
    resourceSelector: authority.context.resourceSelector,
    destinationType: authority.context.destinationType,
    connectionId: authority.context.connectionId,
    connectionName: authority.context.connectionName,
    owner: authority.context.owner,
    settings: authority.context.settings,
    configurationGeneration: authority.context.configurationGeneration,
    configurationDigest: authority.context.configurationDigest,
    signal: authority.context.signal,
    deadline: createLocalResourceLifecycleDeadlineForCore(
      DEFAULT_HOOK_DEADLINE_MILLISECONDS,
    ),
  });
  let lifecycleIntent;
  try {
    lifecycleIntent = await createLocalResourceMutationIntent(state.store, {
      recordVersion: 2,
      operation: context.operation,
      operationId: context.operationId,
      resourceSelector: context.resourceSelector,
      owner: state.owner,
      destinationType: context.destinationType,
      connectionId: context.connectionId,
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      expectedGeneration: context.configurationGeneration,
      expectedDigest: context.configurationDigest,
      authorizedCandidates: Object.freeze([]),
    });
  } catch (error) {
    return mapStoreError(error);
  }
  let result: LocalResourceMaintenanceResult;
  try {
    result = await applyLocalResourceMaintenancePlan(
      state.lifecycleHandlers,
      context,
      authority.evidence,
    );
  } catch {
    return invalid("core.destination.lifecycle-outcome-unknown");
  }
  if (!result.ok) return mapMaintenanceFailure(result);
  const expectedState =
    context.operation === "backup" ? "backed-up" : "restored";
  if (result.state !== expectedState)
    return invalid("core.destination.lifecycle-outcome-unknown");
  try {
    const completion = await completeLocalResourceMutationIntent(
      state.store,
      lifecycleIntent,
      result.state,
    );
    await completeLocalResourceLifecycle(state.lifecycleHandlers, context);
    await finalizeLocalResourceMutationCompletion(state.store, completion);
  } catch {
    return invalid("core.destination.lifecycle-outcome-unknown");
  }
  return Object.freeze({
    operation: context.operation,
    connectionName: authority.connectionName,
    state: expectedState,
    backupSelector:
      result.state === "backed-up"
        ? result.backupAuthority.backupId
        : context.resourceSelector,
  });
};

export const inspectDestinationLocalResourceDoctor = async (
  runtime: ConfigurationManagementRuntime,
  nameInput: string,
  signal: AbortSignal,
): Promise<DestinationDoctorInspection> => {
  const state = stored(runtime);
  const parsedName = connectionNameSchema.safeParse(nameInput);
  if (
    !parsedName.success ||
    !(signal instanceof AbortSignal) ||
    signalAborted(signal)
  )
    return invalid("core.destination.lifecycle-unavailable");
  let current: AgentscopeConfigurationSnapshot;
  try {
    current = await readConfigurationSnapshot(state.store);
  } catch (error) {
    return mapStoreError(error);
  }
  const connection = current.connections.find(
    (candidate) => candidate.name === parsedName.data,
  );
  if (!connection) return invalid("core.destination.connection-missing");
  const capability = getDestinationDescriptor(
    state.registry,
    connection.destinationType,
  )?.localResourceLifecycle;
  const registered = state.lifecycleHandlers
    ? getLocalResourceLifecycleHandlerCapability(
        state.lifecycleHandlers,
        connection.destinationType,
      )
    : undefined;
  if (
    !state.lifecycleHandlers ||
    !capability ||
    !registered ||
    capability.fingerprint !== registered.fingerprint ||
    !capability.operations.includes("doctor")
  )
    return invalid("core.destination.lifecycle-unavailable");
  const context = bindLocalResourceDoctorContextForCore({
    destinationType: connection.destinationType,
    connectionId: connection.connectionId,
    connectionName: connection.name,
    settings: connection.settings,
    configurationGeneration: current.generation,
    configurationDigest: snapshotDigest(current),
    signal,
    deadline: createLocalResourceLifecycleDeadlineForCore(
      DEFAULT_HOOK_DEADLINE_MILLISECONDS,
    ),
  });
  let inspection: LocalResourceDoctorInspection;
  try {
    inspection = await inspectLocalResourceDoctor(
      state.lifecycleHandlers,
      context,
    );
  } catch {
    return invalid("core.destination.lifecycle-unavailable");
  }
  return Object.freeze({
    connectionName: connection.name,
    destinationType: connection.destinationType,
    inspection,
  });
};

const freshLifecycleContext = (
  context: LocalResourceLifecycleContext,
): LocalResourceLifecycleContext =>
  bindLocalResourceLifecycleContextForCore({
    operation: context.operation,
    operationId: context.operationId,
    destinationType: context.destinationType,
    connectionId: context.connectionId,
    connectionName: context.connectionName,
    owner: context.owner,
    settings: context.settings,
    expectedConfigurationGeneration: context.expectedConfigurationGeneration,
    candidateConfigurationGeneration: context.candidateConfigurationGeneration,
    expectedConfigurationDigest: context.expectedConfigurationDigest,
    candidateConfigurationDigest: context.candidateConfigurationDigest,
    signal: context.signal,
    deadline: createLocalResourceLifecycleDeadlineForCore(
      DEFAULT_HOOK_DEADLINE_MILLISECONDS,
    ),
  });

export const applyDestinationLifecyclePlan = async (
  plan: DestinationLifecyclePlan,
): Promise<
  Readonly<{
    generation: number;
    name: string;
    state: "configured" | "deleted" | "retained";
    retainedDeleteSelector?: string;
  }>
  // eslint-disable-next-line max-lines-per-function -- one-use apply owns the durable cross-resource fence and exact CAS sequence.
> => {
  const authority = destinationLifecyclePlans.get(plan);
  if (!authority || consumedDestinationLifecyclePlans.has(plan))
    return invalid();
  consumedDestinationLifecyclePlans.add(plan);
  const state = stored(authority.runtime);
  if (!state.lifecycleHandlers || signalAborted(authority.context.signal))
    return invalid("core.destination.lifecycle-unavailable");
  const applyContext = freshLifecycleContext(authority.context);
  let current: AgentscopeConfigurationSnapshot;
  try {
    current = await readConfigurationSnapshot(state.store);
  } catch (error) {
    return mapStoreError(error);
  }
  if (
    !current.mutationSafe ||
    current.generation !== authority.context.expectedConfigurationGeneration ||
    snapshotDigest(current) !== authority.context.expectedConfigurationDigest
  )
    return invalid("core.configuration.conflict");
  const capability = getLocalResourceLifecycleHandlerCapability(
    state.lifecycleHandlers,
    authority.context.destinationType,
  );
  if (!capability) return invalid("core.destination.lifecycle-unavailable");
  let lifecycleIntent;
  try {
    lifecycleIntent = await createLocalResourceMutationIntent(state.store, {
      recordVersion: 1,
      operation: authority.operation,
      operationId: applyContext.operationId,
      owner: state.owner,
      destinationType: applyContext.destinationType,
      connectionId: applyContext.connectionId,
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      expectedGeneration: applyContext.expectedConfigurationGeneration,
      expectedDigest: applyContext.expectedConfigurationDigest,
      authorizedCandidates: Object.freeze(
        authority.candidates.map((candidate) =>
          Object.freeze({
            generation: candidate.generation,
            digest: snapshotDigest(candidate),
          }),
        ),
      ),
    });
  } catch (error) {
    return mapStoreError(error);
  }
  const configurationAuthority = bindLocalResourceConfigurationAuthorityForCore(
    {
      destinationType: applyContext.destinationType,
      connectionId: applyContext.connectionId,
      operationId: applyContext.operationId,
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      priorGeneration: applyContext.expectedConfigurationGeneration,
      candidateGeneration: applyContext.candidateConfigurationGeneration,
      candidateDigest: applyContext.candidateConfigurationDigest,
      commit: async () => {
        let expected = applyContext.expectedConfigurationGeneration;
        try {
          for (const candidate of authority.candidates) {
            await writeConfigurationSnapshot(state.store, {
              candidate,
              expectedGeneration: expected,
              localResourceMutationIntent: lifecycleIntent,
              owner: state.owner,
            });
            expected = candidate.generation;
          }
        } catch {
          throw new LocalResourceConfigurationCommitError();
        }
        return Object.freeze({
          priorGeneration: applyContext.expectedConfigurationGeneration,
          committedGeneration: applyContext.candidateConfigurationGeneration,
          candidateDigest: applyContext.candidateConfigurationDigest,
        });
      },
    },
  );
  let result: LocalResourceLifecycleApplyResult;
  try {
    result = await applyLocalResourceLifecyclePlan(
      state.lifecycleHandlers,
      applyContext,
      authority.evidence,
      configurationAuthority,
      authority.retainedAuthority,
    );
  } catch {
    return invalid("core.destination.lifecycle-outcome-unknown");
  }
  if (!result.ok) return mapLifecycleFailure(result);
  const expectedState =
    authority.operation === "delete"
      ? "deleted"
      : authority.operation === "configure"
        ? "configured"
        : "retained";
  if (result.state !== expectedState)
    return invalid("core.destination.lifecycle-outcome-unknown");
  try {
    await completeLocalResourceMutationIntent(state.store, lifecycleIntent);
    await completeLocalResourceLifecycle(state.lifecycleHandlers, applyContext);
    await finalizeLocalResourceMutationCompletion(state.store, lifecycleIntent);
  } catch {
    return invalid("core.destination.lifecycle-outcome-unknown");
  }
  return Object.freeze({
    generation: applyContext.candidateConfigurationGeneration,
    name: authority.connectionName,
    state: expectedState,
    ...(expectedState === "retained"
      ? { retainedDeleteSelector: applyContext.connectionId }
      : {}),
  });
};

const recoveryInspectionError = (error: unknown): never => {
  if (error instanceof ConfigurationManagementError) throw error;
  if (!(error instanceof ConfigurationStoreError))
    return invalid("core.destination.lifecycle-unavailable");
  if (error.code === "core.configuration.missing")
    return invalid("core.configuration.missing");
  if (error.code === "core.configuration.recovery-owner-live")
    return invalid("core.destination.lifecycle-busy");
  if (
    error.code === "core.configuration.conflict" ||
    error.code === "core.configuration.contention" ||
    error.code === "core.configuration.invalid"
  )
    return invalid("core.destination.lifecycle-reconciliation-required");
  return invalid("core.destination.lifecycle-unavailable");
};

export const inspectDestinationLifecycleRecoveryPlan = async (
  runtime: ConfigurationManagementRuntime,
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState,
  signal: AbortSignal,
): Promise<DestinationLifecycleRecoveryPlan> => {
  const state = stored(runtime);
  if (
    !state.lifecycleHandlers ||
    !(signal instanceof AbortSignal) ||
    signalAborted(signal)
  )
    return invalid("core.destination.lifecycle-unavailable");
  let intent: LocalResourceMutationRecord;
  let recoveryStage: DestinationLifecycleRecoveryPlan["recoveryStage"];
  try {
    const inspection = await inspectRecoverableLocalResourceMutationIntent(
      state.store,
      ownerState,
    );
    intent = inspection.record;
    recoveryStage = inspection.recoveryStage;
    const descriptor = getDestinationDescriptor(
      state.registry,
      intent.destinationType,
    );
    const declared = descriptor?.localResourceLifecycle;
    const registered = getLocalResourceLifecycleHandlerCapability(
      state.lifecycleHandlers,
      intent.destinationType,
    );
    if (
      !declared ||
      !registered ||
      declared.fingerprint !== registered.fingerprint ||
      declared.recoveryHandlerId !== registered.recoveryHandlerId ||
      !declared.operations.includes("recover") ||
      !registered.operations.includes("recover") ||
      intent.lifecycleFingerprint !== registered.fingerprint ||
      intent.recoveryHandlerId !== registered.recoveryHandlerId
    )
      return invalid("core.destination.lifecycle-reconciliation-required");
    const transaction = await inspectConfigurationTransaction(
      state.store,
      ownerState,
    );
    if (
      transaction.state !== "clean" &&
      !(transaction.state === "recoverable" && intent.recordVersion === 1)
    )
      return invalid("core.destination.lifecycle-reconciliation-required");
    const current = await readConfigurationSnapshot(state.store);
    const currentIdentity = Object.freeze({
      digest: snapshotDigest(current),
      generation: current.generation,
    });
    const authorizedIdentities = [
      Object.freeze({
        digest: intent.expectedDigest,
        generation: intent.expectedGeneration,
      }),
      ...intent.authorizedCandidates,
    ];
    if (
      !authorizedIdentities.some(
        ({ digest, generation }) =>
          digest === currentIdentity.digest &&
          generation === currentIdentity.generation,
      )
    )
      return invalid("core.destination.lifecycle-reconciliation-required");
  } catch (error) {
    return recoveryInspectionError(error);
  }
  const plan = Object.freeze({
    authorizedGenerations: Object.freeze([
      intent.expectedGeneration,
      ...intent.authorizedCandidates.map(({ generation }) => generation),
    ]),
    connectionId: intent.connectionId,
    destinationLifecycleRecoveryPlan: "agentscope-core" as const,
    destinationType: intent.destinationType,
    expectedGeneration: intent.expectedGeneration,
    lifecycleFingerprint: intent.lifecycleFingerprint,
    operationId: intent.operationId,
    pendingOperation: intent.operation,
    recoveryStage,
  });
  destinationLifecycleRecoveryPlans.set(plan, {
    intent,
    ownerState,
    runtime,
    signal,
  });
  return plan;
};

const recoverDestinationLifecycleMutationInternal = async (
  runtime: ConfigurationManagementRuntime,
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState,
  signal: AbortSignal,
  expectedIntent?: LocalResourceMutationRecord,
): Promise<
  Readonly<{
    generation: number;
    state:
      | "backed-up"
      | "configured"
      | "deleted"
      | "restored"
      | "retained"
      | "rolled-back";
    backupSelector?: string;
    retainedDeleteSelector?: string;
  }>
  // eslint-disable-next-line max-lines-per-function, complexity -- recovery claims, classifies, dispatches, and finalizes both versioned durable lifecycle transactions.
> => {
  const state = stored(runtime);
  if (
    !state.lifecycleHandlers ||
    !(signal instanceof AbortSignal) ||
    signalAborted(signal)
  )
    return invalid("core.destination.lifecycle-unavailable");
  let intent;
  try {
    intent = await readRecoverableLocalResourceMutationIntent(
      state.store,
      ownerState,
      expectedIntent,
    );
    const transaction = await inspectConfigurationTransaction(
      state.store,
      ownerState,
    );
    if (transaction.state === "recoverable" && intent.recordVersion === 1)
      await recoverAbandonedConfigurationTransaction(
        state.store,
        ownerState,
        intent,
      );
    else if (transaction.state !== "clean")
      return invalid("core.destination.lifecycle-reconciliation-required");
  } catch (error) {
    return mapStoreError(error);
  }
  let current: AgentscopeConfigurationSnapshot;
  try {
    current = await readConfigurationSnapshot(state.store);
  } catch (error) {
    return mapStoreError(error);
  }
  if (intent.recordVersion === 2 || intent.recordVersion === 3) {
    if (
      current.generation !== intent.expectedGeneration ||
      snapshotDigest(current) !== intent.expectedDigest
    )
      return invalid("core.destination.lifecycle-reconciliation-required");
    const context = bindLocalResourceMaintenanceRecoveryContextForCore({
      operation: intent.operation,
      operationId: intent.operationId,
      resourceSelector: intent.resourceSelector,
      destinationType: intent.destinationType,
      connectionId: intent.connectionId,
      owner: intent.owner,
      lifecycleFingerprint: intent.lifecycleFingerprint,
      recoveryHandlerId: intent.recoveryHandlerId,
      configurationGeneration: intent.expectedGeneration,
      configurationDigest: intent.expectedDigest,
      signal,
      deadline: createLocalResourceLifecycleDeadlineForCore(
        DEFAULT_HOOK_DEADLINE_MILLISECONDS,
      ),
    });
    if (isLocalResourceMutationCompletion(intent)) {
      if (intent.recordVersion !== 3)
        return invalid("core.destination.lifecycle-reconciliation-required");
      try {
        await completeLocalResourceLifecycle(state.lifecycleHandlers, context);
        await finalizeLocalResourceMutationCompletion(state.store, intent);
      } catch {
        return invalid("core.destination.lifecycle-outcome-unknown");
      }
      return Object.freeze({
        generation: current.generation,
        state: intent.terminalState,
        ...(intent.terminalState === "backed-up" ||
        intent.terminalState === "restored"
          ? { backupSelector: intent.resourceSelector }
          : {}),
      });
    }
    if (intent.recordVersion !== 2)
      return invalid("core.destination.lifecycle-reconciliation-required");
    let result: LocalResourceMaintenanceResult;
    try {
      result = await recoverLocalResourceMaintenance(
        state.lifecycleHandlers,
        context,
      );
    } catch {
      return invalid("core.destination.lifecycle-outcome-unknown");
    }
    if (!result.ok) return mapMaintenanceFailure(result);
    try {
      const completion = await completeLocalResourceMutationIntent(
        state.store,
        intent,
        result.state,
      );
      await completeLocalResourceLifecycle(state.lifecycleHandlers, context);
      await finalizeLocalResourceMutationCompletion(state.store, completion);
    } catch {
      return invalid("core.destination.lifecycle-outcome-unknown");
    }
    return Object.freeze({
      generation: current.generation,
      state: result.state,
      ...(result.state === "backed-up" || result.state === "restored"
        ? { backupSelector: intent.resourceSelector }
        : {}),
    });
  }
  const currentDigest = snapshotDigest(current);
  const last =
    intent.authorizedCandidates[intent.authorizedCandidates.length - 1]!;
  const configurationState =
    current.generation === intent.expectedGeneration &&
    currentDigest === intent.expectedDigest
      ? ("prior" as const)
      : current.generation === last.generation && currentDigest === last.digest
        ? ("committed" as const)
        : intent.authorizedCandidates.length === 2 &&
            current.generation === intent.authorizedCandidates[0]!.generation &&
            currentDigest === intent.authorizedCandidates[0]!.digest
          ? ("intermediate" as const)
          : invalid("core.destination.lifecycle-reconciliation-required");
  let configurationAuthority;
  if (configurationState === "intermediate") {
    const candidate = generationOnlyCandidate(current, state.registry);
    if (
      candidate.generation !== last.generation ||
      snapshotDigest(candidate) !== last.digest
    )
      return invalid("core.destination.lifecycle-reconciliation-required");
    configurationAuthority = bindLocalResourceConfigurationAuthorityForCore({
      destinationType: intent.destinationType,
      connectionId: intent.connectionId,
      operationId: intent.operationId,
      lifecycleFingerprint: intent.lifecycleFingerprint,
      recoveryHandlerId: intent.recoveryHandlerId,
      priorGeneration: current.generation,
      candidateGeneration: candidate.generation,
      candidateDigest: last.digest,
      commit: async () => {
        await writeConfigurationSnapshot(state.store, {
          expectedGeneration: current.generation,
          candidate,
          owner: state.owner,
          localResourceMutationIntent: intent,
        });
        return Object.freeze({
          priorGeneration: current.generation,
          committedGeneration: candidate.generation,
          candidateDigest: last.digest,
        });
      },
    });
  }
  const context = bindLocalResourceLifecycleRecoveryContextForCore({
    operation: intent.operation,
    operationId: intent.operationId,
    destinationType: intent.destinationType,
    connectionId: intent.connectionId,
    owner: intent.owner,
    lifecycleFingerprint: intent.lifecycleFingerprint,
    recoveryHandlerId: intent.recoveryHandlerId,
    expectedConfigurationGeneration: intent.expectedGeneration,
    expectedConfigurationDigest: intent.expectedDigest,
    authorizedCandidates: intent.authorizedCandidates,
    configurationState,
    signal,
    deadline: createLocalResourceLifecycleDeadlineForCore(
      DEFAULT_HOOK_DEADLINE_MILLISECONDS,
    ),
    ...(configurationAuthority ? { configurationAuthority } : {}),
  });
  if (isLocalResourceMutationCompletion(intent)) {
    if (configurationState !== "committed")
      return invalid("core.destination.lifecycle-reconciliation-required");
    try {
      await completeLocalResourceLifecycle(state.lifecycleHandlers, context);
      await finalizeLocalResourceMutationCompletion(state.store, intent);
    } catch {
      return invalid("core.destination.lifecycle-outcome-unknown");
    }
    const recoveredState =
      intent.operation === "configure"
        ? ("configured" as const)
        : intent.operation === "delete"
          ? ("deleted" as const)
          : ("retained" as const);
    return Object.freeze({
      generation: last.generation,
      state: recoveredState,
      ...(recoveredState === "retained"
        ? { retainedDeleteSelector: intent.connectionId }
        : {}),
    });
  }
  let result: LocalResourceLifecycleApplyResult;
  try {
    result = await recoverLocalResourceLifecycle(
      state.lifecycleHandlers,
      context,
    );
  } catch {
    return invalid("core.destination.lifecycle-outcome-unknown");
  }
  if (!result.ok) return mapLifecycleFailure(result);
  try {
    await completeLocalResourceMutationIntent(state.store, intent);
    await completeLocalResourceLifecycle(state.lifecycleHandlers, context);
    await finalizeLocalResourceMutationCompletion(state.store, intent);
  } catch {
    return invalid("core.destination.lifecycle-outcome-unknown");
  }
  return Object.freeze({
    generation:
      result.state === "rolled-back" ? current.generation : last.generation,
    state: result.state,
    ...(result.state === "retained"
      ? { retainedDeleteSelector: intent.connectionId }
      : {}),
  });
};

export const applyDestinationLifecycleRecoveryPlan = async (
  plan: DestinationLifecycleRecoveryPlan,
): ReturnType<typeof recoverDestinationLifecycleMutationInternal> => {
  const authority = destinationLifecycleRecoveryPlans.get(plan);
  if (!authority || consumedDestinationLifecycleRecoveryPlans.has(plan))
    return invalid();
  consumedDestinationLifecycleRecoveryPlans.add(plan);
  return recoverDestinationLifecycleMutationInternal(
    authority.runtime,
    authority.ownerState,
    authority.signal,
    authority.intent,
  );
};

export const recoverDestinationLifecycleMutation = async (
  runtime: ConfigurationManagementRuntime,
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState,
  signal: AbortSignal,
): ReturnType<typeof recoverDestinationLifecycleMutationInternal> =>
  recoverDestinationLifecycleMutationInternal(runtime, ownerState, signal);

export const unconfigureDestinationConnection = async (
  runtime: ConfigurationManagementRuntime,
  nameInput: string,
): Promise<Readonly<{ generation: number; name: string }>> => {
  const state = stored(runtime);
  const name = connectionNameSchema.parse(nameInput);
  let current: AgentscopeConfigurationSnapshot;
  try {
    current = await readConfigurationSnapshot(state.store);
  } catch (error) {
    /* v8 ignore next -- branded store reads throw only the fixed store error family. */
    return mapStoreError(error);
  }
  /* v8 ignore next -- an unsupported namespace cannot be minted by this management registry. */
  if (!current.mutationSafe) return invalid();
  const connection = current.connections.find(
    (candidate) => candidate.name === name,
  );
  if (!connection) return invalid("core.destination.connection-missing");
  if (
    getDestinationDescriptor(state.registry, connection.destinationType)
      ?.localResourceLifecycle
  )
    return invalid("core.destination.lifecycle-unavailable");
  if (Object.keys(connection.credentialReferences).length > 0)
    return invalid("core.destination.credential-removal-required");
  const document = documentOf(current);
  const destinations = destinationDocument(document);
  const namespace = destinations[connection.destinationType] as {
    connections: Array<{ connectionId: string }>;
  };
  namespace.connections = namespace.connections.filter(
    (candidate) => candidate.connectionId !== connection.connectionId,
  );
  if (namespace.connections.length === 0)
    delete destinations[connection.destinationType];
  const routing = document.routing as Record<string, unknown>;
  routing.selectedConnectionIds = current.selectedConnectionIds.filter(
    (connectionId) => connectionId !== connection.connectionId,
  );
  const written = await writeCandidate(runtime, current, document);
  return Object.freeze({ generation: written.generation, name });
};
