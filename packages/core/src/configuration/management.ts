import { randomBytes } from "node:crypto";

import {
  createDestinationConnectionId,
  getDestinationDescriptor,
  parseDestinationSettings,
  type DestinationConnectionId,
  type DestinationDescriptor,
  type DestinationRegistry,
} from "@agentscope/destinations-core/configuration";
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
  ConfigurationStoreError,
  configurationStoreUsesRegistry,
  isConfigurationProcessIdentity,
  isConfigurationStore,
  readConfigurationSnapshot,
  writeConfigurationSnapshot,
  type ConfigurationProcessIdentity,
  type ConfigurationStore,
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
): ConfigurationManagementRuntime => {
  if (
    !isConfigurationStore(store) ||
    !configurationStoreUsesRegistry(store, registry) ||
    !isConfigurationProcessIdentity(owner)
  )
    return invalid();
  const runtime = Object.freeze({
    configurationManagement: "agentscope-core" as const,
  });
  configurationManagementRuntimes.set(runtime, { owner, registry, store });
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
  if (Object.keys(credentialReferences).length > 0) {
    const authority = preflight
      ? configurationCredentialPreflights.get(preflight)
      : undefined;
    if (!authority) return invalid("core.destination.credential-unavailable");
    const resolutions = await Promise.all(
      Object.values(credentialReferences).map((reference) =>
        resolveCredentialReference(
          authority.registry,
          reference,
          authority.context,
        ),
      ),
    );
    if (resolutions.some((resolution) => !resolution.ok))
      return invalid("core.destination.credential-unavailable");
  }
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
