import {
  createCredentialSlotId,
  createDestinationConnectionId,
  createDestinationTypeId,
  getDestinationDescriptor,
  parseDestinationSettings,
  type CredentialSlotId,
  type DestinationConnectionId,
  type DestinationRegistry,
  type DestinationTypeId,
  type JsonObject,
} from "@agentscope/destinations-core";
import { z } from "zod";

import { cloneConfigurationDocument } from "./plain-data.js";

export const AGENTSCOPE_CONFIGURATION_VERSION = 2 as const;
export const MAXIMUM_CONFIGURED_CONNECTIONS = 64;
export const MAXIMUM_DESTINATION_NAMESPACES = 32;
export const MAXIMUM_ROUTED_CONNECTIONS = 32;
export const DEFAULT_HOOK_DEADLINE_MILLISECONDS = 2_000;
export const MINIMUM_HOOK_DEADLINE_MILLISECONDS = 50;
export const MAXIMUM_HOOK_DEADLINE_MILLISECONDS = 60_000;

const connectionNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const opaqueReferencePattern = /^credential-reference-v1-[0-9a-f]{64}$/u;
const generationPattern = /^credential-generation-v1-[0-9a-f]{64}$/u;
const environmentNamePattern = /^[A-Z][A-Z0-9_]{0,127}$/u;
const policyReferencePattern = /^[a-z0-9][a-z0-9._-]{0,255}$/u;
const configurationSnapshots = new WeakSet<object>();

const storedCredentialReferenceSchema = z.strictObject({
  referenceVersion: z.literal(1),
  backend: z.enum([
    "macos-keychain",
    "windows-credential-manager",
    "linux-secret-service",
  ]),
  referenceId: z.string().regex(opaqueReferencePattern),
  generationId: z.string().regex(generationPattern),
});

const environmentCredentialReferenceSchema = z.strictObject({
  referenceVersion: z.literal(1),
  backend: z.literal("ci-environment"),
  environmentVariable: z.string().regex(environmentNamePattern),
  generationId: z.string().regex(generationPattern),
});

const credentialReferenceSchema = z.union([
  storedCredentialReferenceSchema,
  environmentCredentialReferenceSchema,
]);

const configuredConnectionSchema = z.strictObject({
  connectionId: z.string(),
  name: z.string().min(1).max(64).regex(connectionNamePattern),
  settings: z.unknown(),
  credentialReferences: z.record(z.string(), credentialReferenceSchema),
});

const knownNamespaceSchema = z.strictObject({
  namespaceVersion: z.literal(1),
  settingsVersion: z.number().int().positive(),
  connections: z
    .array(configuredConnectionSchema)
    .max(MAXIMUM_CONFIGURED_CONNECTIONS),
});

const namespaceVersionHeaderSchema = z
  .object({
    namespaceVersion: z.number().int().positive(),
    settingsVersion: z.number().int().positive(),
  })
  .passthrough();

const outerConfigurationSchema = z.strictObject({
  configurationVersion: z.literal(AGENTSCOPE_CONFIGURATION_VERSION),
  generation: z.number().int().nonnegative().safe(),
  destinations: z.record(z.string(), z.unknown()),
  routing: z.strictObject({
    version: z.literal(1),
    selectedConnectionIds: z.array(z.string()).max(MAXIMUM_ROUTED_CONNECTIONS),
    hookDeadlineMilliseconds: z
      .number()
      .int()
      .min(MINIMUM_HOOK_DEADLINE_MILLISECONDS)
      .max(MAXIMUM_HOOK_DEADLINE_MILLISECONDS),
  }),
  policy: z.strictObject({
    version: z.literal(1),
    reference: z.string().regex(policyReferencePattern),
  }),
});

export type ConfigurationCredentialReference = z.infer<
  typeof credentialReferenceSchema
>;

export const parseConfigurationCredentialReference = (
  input: unknown,
): ConfigurationCredentialReference => {
  try {
    const parsed = credentialReferenceSchema.safeParse(
      cloneConfigurationDocument(input),
    );
    if (!parsed.success) return invalid();
    return Object.freeze(parsed.data);
  } catch {
    return invalid();
  }
};

export type ConfiguredDestinationConnection = Readonly<{
  connectionId: DestinationConnectionId;
  name: string;
  destinationType: DestinationTypeId;
  settings: JsonObject;
  credentialReferences: Readonly<
    Record<CredentialSlotId, ConfigurationCredentialReference>
  >;
}>;

export type AgentscopeConfigurationSnapshot = Readonly<{
  configurationVersion: typeof AGENTSCOPE_CONFIGURATION_VERSION;
  generation: number;
  document: JsonObject;
  destinationRegistry: DestinationRegistry;
  connections: readonly ConfiguredDestinationConnection[];
  selectedConnectionIds: readonly DestinationConnectionId[];
  hookDeadlineMilliseconds: number;
  policyReference: string;
  unsupportedDestinationTypes: readonly DestinationTypeId[];
  mutationSafe: boolean;
}>;

export class AgentscopeConfigurationError extends Error {
  public readonly code = "core.configuration.invalid";

  public constructor() {
    super("core.configuration.invalid");
    this.name = "AgentscopeConfigurationError";
  }
}

const invalid = (): never => {
  throw new AgentscopeConfigurationError();
};

const freezeRecord = <Value>(
  entries: readonly (readonly [string, Value])[],
): Readonly<Record<string, Value>> =>
  Object.freeze(Object.fromEntries(entries));

const parseCredentialReferences = (
  input: Readonly<Record<string, ConfigurationCredentialReference>>,
  declaredSlots: readonly Readonly<{
    id: CredentialSlotId;
    required: boolean;
  }>[],
): Readonly<Record<CredentialSlotId, ConfigurationCredentialReference>> => {
  const declared = new Map(declaredSlots.map((slot) => [slot.id, slot]));
  const entries: [CredentialSlotId, ConfigurationCredentialReference][] = [];
  for (const [key, reference] of Object.entries(input)) {
    const slot = createCredentialSlotId(key);
    if (!declared.has(slot)) return invalid();
    entries.push([slot, Object.freeze({ ...reference })]);
  }
  for (const slot of declaredSlots)
    if (slot.required && !entries.some(([id]) => id === slot.id))
      return invalid();
  entries.sort(([left], [right]) => left.localeCompare(right));
  return freezeRecord(entries);
};

const parseKnownNamespace = (
  destinationType: DestinationTypeId,
  input: unknown,
  registry: DestinationRegistry,
): readonly ConfiguredDestinationConnection[] | undefined => {
  const descriptor = getDestinationDescriptor(registry, destinationType);
  if (!descriptor) return undefined;
  const header = namespaceVersionHeaderSchema.safeParse(input);
  if (!header.success) return invalid();
  if (
    header.data.namespaceVersion !== 1 ||
    header.data.settingsVersion !== descriptor.settingsVersion
  )
    return undefined;
  const parsed = knownNamespaceSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const output: ConfiguredDestinationConnection[] = [];
  for (const connection of parsed.data.connections) {
    const connectionId = createDestinationConnectionId(connection.connectionId);
    const settings = parseDestinationSettings(descriptor, connection.settings);
    output.push(
      Object.freeze({
        connectionId,
        name: connection.name,
        destinationType,
        settings,
        credentialReferences: parseCredentialReferences(
          connection.credentialReferences,
          descriptor.credentialSlots,
        ),
      }),
    );
  }
  return Object.freeze(output);
};

const parseDestinations = (
  destinations: Record<string, unknown>,
  registry: DestinationRegistry,
): Readonly<{
  connections: readonly ConfiguredDestinationConnection[];
  unsupportedDestinationTypes: readonly DestinationTypeId[];
}> => {
  const keys = Object.keys(destinations).sort();
  if (keys.length > MAXIMUM_DESTINATION_NAMESPACES) return invalid();
  const connections: ConfiguredDestinationConnection[] = [];
  const unsupported: DestinationTypeId[] = [];
  const connectionIds = new Set<string>();
  const connectionNames = new Set<string>();
  for (const key of keys) {
    const destinationType = createDestinationTypeId(key);
    const parsed = parseKnownNamespace(
      destinationType,
      destinations[key],
      registry,
    );
    if (!parsed) {
      unsupported.push(destinationType);
      continue;
    }
    for (const connection of parsed) {
      if (
        connectionIds.has(connection.connectionId) ||
        connectionNames.has(connection.name)
      )
        return invalid();
      connectionIds.add(connection.connectionId);
      connectionNames.add(connection.name);
      connections.push(connection);
    }
  }
  if (connections.length > MAXIMUM_CONFIGURED_CONNECTIONS) return invalid();
  connections.sort((left, right) =>
    left.connectionId.localeCompare(right.connectionId),
  );
  return Object.freeze({
    connections: Object.freeze(connections),
    unsupportedDestinationTypes: Object.freeze(unsupported),
  });
};

export const parseAgentscopeConfiguration = (
  input: unknown,
  registry: DestinationRegistry,
): AgentscopeConfigurationSnapshot => {
  try {
    const document = cloneConfigurationDocument(input);
    const parsed = outerConfigurationSchema.safeParse(document);
    if (!parsed.success) return invalid();
    const destinationState = parseDestinations(
      parsed.data.destinations,
      registry,
    );
    const selected = parsed.data.routing.selectedConnectionIds
      .map((value) => createDestinationConnectionId(value))
      .sort((left, right) => left.localeCompare(right));
    if (new Set(selected).size !== selected.length) return invalid();
    const knownIds = new Set(
      destinationState.connections.map((connection) => connection.connectionId),
    );
    if (
      destinationState.unsupportedDestinationTypes.length === 0 &&
      selected.some((connectionId) => !knownIds.has(connectionId))
    )
      return invalid();
    const snapshot = Object.freeze({
      configurationVersion: AGENTSCOPE_CONFIGURATION_VERSION,
      generation: parsed.data.generation,
      document,
      destinationRegistry: registry,
      connections: destinationState.connections,
      selectedConnectionIds: Object.freeze(selected),
      hookDeadlineMilliseconds: parsed.data.routing.hookDeadlineMilliseconds,
      policyReference: parsed.data.policy.reference,
      unsupportedDestinationTypes: destinationState.unsupportedDestinationTypes,
      mutationSafe: destinationState.unsupportedDestinationTypes.length === 0,
    });
    configurationSnapshots.add(snapshot);
    return snapshot;
  } catch {
    return invalid();
  }
};

export const serializeAgentscopeConfiguration = (
  snapshot: AgentscopeConfigurationSnapshot,
): string => {
  try {
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      !configurationSnapshots.has(snapshot) ||
      snapshot.configurationVersion !== AGENTSCOPE_CONFIGURATION_VERSION
    )
      return invalid();
    return `${JSON.stringify(snapshot.document)}\n`;
  } catch {
    return invalid();
  }
};
