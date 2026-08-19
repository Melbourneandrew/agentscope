import { randomBytes } from "node:crypto";

import {
  ConfigurationManagementError,
  ConfigurationStoreError,
  configureDestinationConnection,
  createAgentscopeHomeResolver,
  createCiEnvironmentCredentialReference,
  createCiEnvironmentCredentialPreflight,
  createConfigurationManagementRuntime,
  createConfigurationProcessIdentity,
  createConfigurationStore,
  initializeAgentscopeConfiguration,
  listDestinationConnections,
  readConfigurationSnapshot,
  setDestinationRouting,
  unconfigureDestinationConnection,
  type ConfigurationManagementRuntime,
  type AgentscopeHomeResolver,
  type ConfigurationStore,
} from "@agentscope/core/configuration-management";
import {
  compileDestinationRegistry,
  getDestinationDescriptor,
  type DestinationRegistry,
} from "@agentscope/destinations-core/configuration";

import type { CliDiagnostic, CliOperationResult } from "./cli-contract.js";
import type {
  CliConfigurationServices,
  CliInitializationValue,
} from "./configuration-commands.js";
import type { CliHarnessServices } from "./harness-commands.js";
import {
  createHarnessCliServices,
  type CreateHarnessCliServicesInput,
} from "./harness-services.js";

type ServiceResult<Value> = CliOperationResult<Value>;

const failure = <Value>(diagnostic: CliDiagnostic): ServiceResult<Value> =>
  Object.freeze({ diagnostic, status: "failure" as const });

const success = <Value>(value: Value): ServiceResult<Value> =>
  Object.freeze({ status: "success" as const, value });

const diagnostic = (
  category: CliDiagnostic["category"],
  code: string,
): CliDiagnostic => Object.freeze({ category, code });

const unavailable = diagnostic("unavailable", "configuration.unavailable");
const missingConfiguration = diagnostic("not-found", "configuration.missing");

const mapError = (error: unknown): CliDiagnostic => {
  const code =
    error instanceof ConfigurationManagementError ||
    error instanceof ConfigurationStoreError
      ? error.code
      : undefined;
  switch (code) {
    case "core.configuration.conflict":
    case "core.configuration.contention":
      return diagnostic("conflict", "configuration.conflict");
    case "core.configuration.missing":
      return missingConfiguration;
    case "core.destination.connection-exists":
      return diagnostic("conflict", "destination.connection-exists");
    case "core.destination.connection-missing":
      return diagnostic("not-found", "destination.connection-missing");
    case "core.destination.credential-unavailable":
      return diagnostic("unavailable", "destination.credential-unavailable");
    case "core.destination.credential-removal-required":
      return diagnostic("conflict", "destination.credential-removal-required");
    case "core.destination.type-missing":
      return diagnostic("not-found", "destination.type-missing");
    default:
      return unavailable;
  }
};

type ProductionState = Readonly<{
  environment: object;
  management: ConfigurationManagementRuntime;
  registry: DestinationRegistry;
  store: ConfigurationStore;
}>;

export type CreateProductionCliServicesInput = Readonly<{
  environment?: object;
  harnesses?: CreateHarnessCliServicesInput;
  homeResolver?: AgentscopeHomeResolver;
  registry?: DestinationRegistry;
}>;

const createState = (
  input: CreateProductionCliServicesInput,
): ProductionState => {
  // Phase 9 registers concrete first-party descriptors. An empty registry is
  // intentional here: it makes init/list/routing useful without inventing
  // placeholder provider behavior.
  const registry = input.registry ?? compileDestinationRegistry([]);
  const home = (input.homeResolver ?? createAgentscopeHomeResolver())();
  const store = createConfigurationStore(home, registry);
  const owner = createConfigurationProcessIdentity(
    process.pid,
    `process-start-v1-${randomBytes(32).toString("hex")}`,
  );
  return Object.freeze({
    environment: input.environment ?? process.env,
    management: createConfigurationManagementRuntime(registry, store, owner),
    registry,
    store,
  });
};

const snapshotGeneration = async (state: ProductionState): Promise<number> =>
  (await readConfigurationSnapshot(state.store)).generation;

const parseCredentialEnvironment = (
  assignments: readonly string[],
): Readonly<
  Record<string, ReturnType<typeof createCiEnvironmentCredentialReference>>
> => {
  const entries: Array<
    readonly [string, ReturnType<typeof createCiEnvironmentCredentialReference>]
  > = [];
  const slots = new Set<string>();
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    const slot = assignment.slice(0, separator);
    const environmentVariable = assignment.slice(separator + 1);
    if (slots.has(slot)) throw new Error("cli.input.invalid");
    slots.add(slot);
    entries.push([
      slot,
      createCiEnvironmentCredentialReference(
        environmentVariable,
        `credential-generation-v1-${randomBytes(32).toString("hex")}`,
      ),
    ]);
  }
  return Object.freeze(Object.fromEntries(entries));
};

const parseSettings = (text: string): unknown => {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("cli.input.invalid");
  return value;
};

const createInitService =
  (state: ProductionState): CliConfigurationServices["init"] =>
  async ({ apply }) => {
    try {
      const snapshot = await readConfigurationSnapshot(state.store);
      const value: CliInitializationValue = {
        applied: false,
        generation: snapshot.generation,
        steps: [
          {
            action: "no-change",
            destructive: false,
            id: "configuration-current",
            state: "unchanged",
          },
        ],
      };
      return success(value);
    } catch (error) {
      if (
        !(error instanceof ConfigurationStoreError) ||
        error.code !== "core.configuration.missing"
      )
        return failure(mapError(error));
    }
    const planned: CliInitializationValue = {
      applied: false,
      generation: null,
      steps: [
        {
          action: "create-configuration",
          destructive: false,
          id: "configuration-create",
          state: "planned",
        },
      ],
    };
    if (!apply) return success(planned);
    try {
      const result = await initializeAgentscopeConfiguration(state.management);
      return success({
        applied: result.created,
        generation: result.generation,
        steps: [
          {
            action: result.created ? "create-configuration" : "no-change",
            destructive: false,
            id: result.created
              ? "configuration-create"
              : "configuration-current",
            state: result.created ? "applied" : "unchanged",
          },
        ],
      });
    } catch (error) {
      return failure(mapError(error));
    }
  };

const createDeleteService =
  (
    list: CliConfigurationServices["listDestinations"],
  ): CliConfigurationServices["deleteDestination"] =>
  async ({ confirm, name }) => {
    if (!confirm)
      return failure(
        diagnostic("conflict", "destination.confirmation-required"),
      );
    const listed = await list();
    if (listed.status !== "success") return failure(listed.diagnostic);
    if (
      !listed.value.connections.some((connection) => connection.name === name)
    )
      return failure(diagnostic("not-found", "destination.connection-missing"));
    return failure(
      diagnostic("unavailable", "destination.data-delete-unsupported"),
    );
  };

const createRotateService =
  (
    state: ProductionState,
    list: CliConfigurationServices["listDestinations"],
  ): CliConfigurationServices["rotateDestinationCredential"] =>
  async ({ name, slot }) => {
    const listed = await list();
    if (listed.status !== "success") return failure(listed.diagnostic);
    const connection = listed.value.connections.find(
      (candidate) => candidate.name === name,
    );
    if (!connection)
      return failure(diagnostic("not-found", "destination.connection-missing"));
    const descriptor = getDestinationDescriptor(
      state.registry,
      connection.destinationType,
    );
    if (!descriptor) return failure(unavailable);
    if (!descriptor.credentialSlots.some((candidate) => candidate.id === slot))
      return failure(
        diagnostic("not-found", "destination.credential-slot-missing"),
      );
    return failure(
      diagnostic("unavailable", "destination.credential-rotation-unsupported"),
    );
  };

export const createProductionCliServices = (
  input: CreateProductionCliServicesInput = {},
): CliConfigurationServices & CliHarnessServices => {
  const state = createState(input);
  const list: CliConfigurationServices["listDestinations"] = async () => {
    try {
      return success({
        connections: [...(await listDestinationConnections(state.management))],
      });
    } catch (error) {
      return failure(mapError(error));
    }
  };
  const services: CliConfigurationServices = {
    configureDestination: async (input) => {
      try {
        return success(
          await configureDestinationConnection(
            state.management,
            {
              commandName: input.type,
              credentialReferences: parseCredentialEnvironment(
                input.credentialEnvironment,
              ),
              name: input.name,
              settings: parseSettings(input.settingsJson),
            },
            createCiEnvironmentCredentialPreflight(
              state.environment,
              new AbortController().signal,
            ),
          ),
        );
      } catch (error) {
        if (
          error instanceof SyntaxError ||
          (error instanceof Error && error.message === "cli.input.invalid")
        )
          return failure(diagnostic("usage", "cli.input.invalid"));
        return failure(mapError(error));
      }
    },
    deleteDestination: createDeleteService(list),
    init: createInitService(state),
    inspectDestination: async ({ name }) => {
      const listed = await list();
      if (listed.status !== "success") return failure(listed.diagnostic);
      const connection = listed.value.connections.find(
        (candidate) => candidate.name === name,
      );
      if (!connection)
        return failure(
          diagnostic("not-found", "destination.connection-missing"),
        );
      const descriptor = getDestinationDescriptor(
        state.registry,
        connection.destinationType,
      );
      if (!descriptor) return failure(unavailable);
      return success({
        connection,
        credentialSlots: descriptor.credentialSlots.map((slot) => slot.id),
        documentationPath: descriptor.documentationPath,
        settingKeys: [...descriptor.settingKeys],
      });
    },
    listDestinations: list,
    listRouting: async () => {
      const listed = await list();
      if (listed.status !== "success") return failure(listed.diagnostic);
      try {
        return success({
          generation: await snapshotGeneration(state),
          selected: listed.value.connections
            .filter((connection) => connection.routed)
            .map((connection) => connection.name),
        });
      } catch (error) {
        return failure(mapError(error));
      }
    },
    rotateDestinationCredential: createRotateService(state, list),
    setRouting: async ({ names }) => {
      if (new Set(names).size !== names.length)
        return failure(diagnostic("usage", "routing.duplicate-connection"));
      try {
        const result = await setDestinationRouting(state.management, names);
        return success({
          generation: result.generation,
          selected: [...result.selected],
        });
      } catch (error) {
        const mapped = mapError(error);
        return failure(
          mapped.code === "destination.connection-missing"
            ? diagnostic("not-found", "routing.connection-missing")
            : mapped,
        );
      }
    },
    unconfigureDestination: async ({ name }) => {
      try {
        const result = await unconfigureDestinationConnection(
          state.management,
          name,
        );
        return success({ ...result, dataPreserved: true as const });
      } catch (error) {
        return failure(mapError(error));
      }
    },
  };
  return Object.freeze({
    ...services,
    ...createHarnessCliServices(input.harnesses),
  });
};
