import { randomBytes } from "node:crypto";
import { types } from "node:util";

import {
  createDestinationConnectionId,
  getDestinationDescriptor,
  parseDestinationSettings,
  type DestinationRegistry,
  type DestinationDescriptor,
  type DestinationConnectionId,
} from "@agentscope/destinations-core/configuration";

import {
  createCredentialOwnership,
  getStoredCredentialImplementation,
  isCredentialResolutionContext,
  type CredentialBackendRegistry,
  type CredentialResolutionContext,
  type StoredCredentialBackend,
} from "./credential-adapter.js";
import {
  credentialResolutionExpired,
  invokeCredentialMutationForCore,
} from "./credential-resolution-context.js";
import { configureCredentialSetForCore } from "./credential-set-lifecycle.js";
import type { CredentialConfigurationResult } from "./credential-reference-evidence.js";
import { retireCredentialConnectionForCore } from "./credential-retirement-lifecycle.js";
import {
  parseAgentscopeConfiguration,
  serializeAgentscopeConfiguration,
  type AgentscopeConfigurationSnapshot,
  type ConfigurationCredentialReference,
  type ConfiguredDestinationConnection,
} from "./schema.js";
import {
  readConfigurationSnapshot,
  writeConfigurationSnapshot,
  type ConfigurationProcessIdentity,
  type ConfigurationStore,
} from "./transaction.js";

export type CredentialManagementState = Readonly<{
  owner: ConfigurationProcessIdentity;
  registry: DestinationRegistry;
  store: ConfigurationStore;
  credentialRegistry?: CredentialBackendRegistry;
}>;

export type ConfigureStoredDestinationInput = Readonly<{
  commandName: string;
  name: string;
  settings: unknown;
  backend: StoredCredentialBackend;
  resolutionContext: CredentialResolutionContext;
  readSecret: (
    slot: string,
    context: CredentialResolutionContext,
  ) => Promise<string>;
}>;

export type UnconfigureManagedDestinationInput = Readonly<{
  name: string;
  retireCredentials: boolean;
  resolutionContext: CredentialResolutionContext;
}>;

export type ManagedCredentialResult =
  | Readonly<{
      ok: true;
      generation: number;
      name: string;
      state: "active";
      connection: Readonly<{
        connectionId: string;
        destinationType: string;
        name: string;
        routed: boolean;
        settingsVersion: number;
        transport: "local" | "remote";
      }>;
    }>
  | Readonly<{
      ok: true;
      generation: number;
      name: string;
      state: "credentials-retained" | "retired";
    }>
  | Readonly<{
      ok: false;
      code: Extract<CredentialConfigurationResult, { ok: false }>["code"];
      state:
        | "compensated"
        | "orphan-pending"
        | "referenced-pending"
        | "configuration-committed";
      configurationCommitted: boolean;
    }>;

const invalid = (): never => {
  throw new Error("core.configuration.invalid");
};

const own = (input: unknown, keys: string): Record<string, unknown> => {
  if (typeof input !== "object" || input === null || types.isProxy(input))
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join(",") !== keys ||
    Object.values(descriptors).some((value) => !("value" in value))
  )
    return invalid();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, value]) => [
      key,
      value.value as unknown,
    ]),
  );
};

const context = (input: unknown): CredentialResolutionContext => {
  if (
    !isCredentialResolutionContext(input) ||
    input.context !== "hook-equivalent" ||
    input.expiresAtMonotonicMilliseconds === undefined ||
    credentialResolutionExpired(input)
  )
    return invalid();
  return input;
};

const name = (input: unknown): string => {
  if (
    typeof input !== "string" ||
    input.length > 64 ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(input)
  )
    return invalid();
  return input;
};

const documentOf = (
  snapshot: AgentscopeConfigurationSnapshot,
): Record<string, unknown> =>
  JSON.parse(serializeAgentscopeConfiguration(snapshot)) as Record<
    string,
    unknown
  >;

const removal = (
  snapshot: AgentscopeConfigurationSnapshot,
  connection: ConfiguredDestinationConnection,
  registry: DestinationRegistry,
  preserveNamespace = false,
): AgentscopeConfigurationSnapshot => {
  const document = documentOf(snapshot);
  document.generation = snapshot.generation + 1;
  const destinations = document.destinations as Record<
    string,
    { connections: { connectionId: string }[] }
  >;
  const namespace = destinations[connection.destinationType]!;
  namespace.connections = namespace.connections.filter(
    (value) => value.connectionId !== connection.connectionId,
  );
  if (!preserveNamespace && namespace.connections.length === 0)
    delete destinations[connection.destinationType];
  (document.routing as Record<string, unknown>).selectedConnectionIds =
    snapshot.selectedConnectionIds.filter(
      (value) => value !== connection.connectionId,
    );
  return parseAgentscopeConfiguration(document, registry);
};

const collect = async (
  value: Readonly<{
    descriptor: DestinationDescriptor;
    connectionId: DestinationConnectionId;
    boundary: CredentialResolutionContext;
    backend: StoredCredentialBackend;
    readSecret: ConfigureStoredDestinationInput["readSecret"];
  }>,
) => {
  const requests = [];
  for (const slot of value.descriptor.credentialSlots.filter(
    (entry) => entry.required,
  )) {
    let secret: unknown;
    try {
      secret = await invokeCredentialMutationForCore(value.boundary, () =>
        value.readSecret(slot.id, value.boundary),
      );
    } catch {
      return invalid();
    }
    if (
      typeof secret !== "string" ||
      secret.length === 0 ||
      Buffer.byteLength(secret, "utf8") > 8192 ||
      secret.includes("\0") ||
      /[\uD800-\uDFFF]/u.test(secret) ||
      (value.backend === "macos-keychain" && /[\r\n]/u.test(secret))
    )
      return invalid();
    requests.push(
      Object.freeze({
        ownership: createCredentialOwnership({
          destinationType: value.descriptor.destinationType,
          connectionId: value.connectionId,
          slot: slot.id,
        }),
        secret,
      }),
    );
  }
  context(value.boundary);
  return Object.freeze(requests);
};

export const configureStoredDestinationForCore = async (
  state: CredentialManagementState,
  supplied: ConfigureStoredDestinationInput,
): Promise<ManagedCredentialResult> => {
  const input = own(
    supplied,
    "backend,commandName,name,readSecret,resolutionContext,settings",
  );
  const boundary = context(input.resolutionContext);
  const connectionName = name(input.name);
  const commandName = name(input.commandName);
  if (
    !state.credentialRegistry ||
    typeof input.readSecret !== "function" ||
    typeof input.backend !== "string" ||
    ![
      "macos-keychain",
      "windows-credential-manager",
      "linux-secret-service",
    ].includes(input.backend)
  )
    return invalid();
  const backend = input.backend as StoredCredentialBackend;
  getStoredCredentialImplementation(state.credentialRegistry, backend);
  const descriptor = state.registry.descriptors.find(
    (value) => value.commandName === commandName,
  );
  if (
    !descriptor ||
    descriptor.localResourceLifecycle ||
    !descriptor.credentialSlots.some((value) => value.required)
  )
    return invalid();
  const settings = parseDestinationSettings(descriptor, input.settings);
  const current = await readConfigurationSnapshot(state.store);
  context(boundary);
  if (
    !current.mutationSafe ||
    current.connections.some((value) => value.name === connectionName)
  )
    return invalid();
  const connectionId = createDestinationConnectionId(
    `destination-connection-v1-${randomBytes(32).toString("hex")}`,
  );
  const requests = await collect({
    descriptor,
    connectionId,
    boundary,
    backend,
    readSecret:
      input.readSecret as ConfigureStoredDestinationInput["readSecret"],
  });
  const result = await configureCredentialSetForCore(state.credentialRegistry, {
    store: state.store,
    owner: state.owner,
    expectedGeneration: current.generation,
    backend,
    requests: Object.freeze(requests),
    resolutionContext: boundary,
    createCandidate: (
      references: Readonly<Record<string, ConfigurationCredentialReference>>,
    ) => {
      const document = documentOf(current);
      document.generation = current.generation + 1;
      const destinations = document.destinations as Record<
        string,
        {
          connections: unknown[];
          namespaceVersion: number;
          settingsVersion: number;
        }
      >;
      const previous = destinations[descriptor.destinationType];
      destinations[descriptor.destinationType] = {
        namespaceVersion: 1,
        settingsVersion: descriptor.settingsVersion,
        connections: [
          ...(previous?.connections ?? []),
          {
            connectionId,
            credentialReferences: references,
            name: connectionName,
            settings,
          },
        ],
      };
      return parseAgentscopeConfiguration(document, state.registry);
    },
  });
  if (!result.ok)
    return Object.freeze({
      ok: false,
      code: result.code,
      state: result.state,
      configurationCommitted: result.configurationCommitted,
    });
  if (credentialResolutionExpired(boundary))
    return Object.freeze({
      ok: false,
      code: "core.credential.configuration-failed",
      state: "configuration-committed",
      configurationCommitted: true,
    });
  return Object.freeze({
    ok: true,
    generation: result.snapshot.generation,
    name: connectionName,
    state: "active",
    connection: Object.freeze({
      connectionId,
      destinationType: descriptor.destinationType,
      name: connectionName,
      routed: result.snapshot.selectedConnectionIds.includes(connectionId),
      settingsVersion: descriptor.settingsVersion,
      transport: descriptor.transport.kind,
    }),
  });
};

export const unconfigureManagedDestinationForCore = async (
  state: CredentialManagementState,
  supplied: UnconfigureManagedDestinationInput,
): Promise<ManagedCredentialResult> => {
  const input = own(supplied, "name,resolutionContext,retireCredentials");
  const boundary = context(input.resolutionContext);
  const connectionName = name(input.name);
  if (typeof input.retireCredentials !== "boolean") return invalid();
  const current = await readConfigurationSnapshot(state.store);
  context(boundary);
  const connection = current.connections.find(
    (value) => value.name === connectionName,
  );
  if (
    !current.mutationSafe ||
    !connection ||
    getDestinationDescriptor(state.registry, connection.destinationType)
      ?.localResourceLifecycle
  )
    return invalid();
  const stored = Object.values(connection.credentialReferences).some(
    (value) => value.backend !== "ci-environment",
  );
  const candidate = removal(
    current,
    connection,
    state.registry,
    input.retireCredentials && stored,
  );
  if (input.retireCredentials && stored) {
    if (!state.credentialRegistry) return invalid();
    const finalDocument = documentOf(candidate);
    finalDocument.generation = candidate.generation + 1;
    await retireCredentialConnectionForCore(state.credentialRegistry, {
      store: state.store,
      owner: state.owner,
      resolutionContext: boundary,
      connectionId: connection.connectionId,
      preimage: current,
      removal: candidate,
      final: parseAgentscopeConfiguration(finalDocument, state.registry),
    });
    context(boundary);
    return Object.freeze({
      ok: true,
      generation: candidate.generation + 1,
      name: connectionName,
      state: "retired",
    });
  }
  context(boundary);
  await writeConfigurationSnapshot(state.store, {
    candidate,
    expectedGeneration: current.generation,
    owner: state.owner,
  });
  if (credentialResolutionExpired(boundary))
    return Object.freeze({
      ok: false,
      code: "core.credential.configuration-failed",
      state: "configuration-committed",
      configurationCommitted: true,
    });
  return Object.freeze({
    ok: true,
    generation: candidate.generation,
    name: connectionName,
    state: "credentials-retained",
  });
};
