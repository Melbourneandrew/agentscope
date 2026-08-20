import { randomBytes } from "node:crypto";

import {
  compileCredentialBackendRegistry,
  createCiEnvironmentCredentialAdapter,
  createCredentialResolutionContext,
  createOperationalStateStore,
  DEFAULT_REDACTION_POLICY_REGISTRY,
  inspectGitContextForDoctor,
  type CredentialBackendRegistry,
  type ConfigurationOwnerState,
  type ConfigurationProcessIdentity,
  type RedactionPolicyRegistry,
} from "@agentscope/core";
import {
  ConfigurationManagementError,
  ConfigurationStoreError,
  applyAgentscopeConfigurationInitialization,
  configureDestinationConnection,
  createAgentscopeHomeResolver,
  createCiEnvironmentCredentialReference,
  createCiEnvironmentCredentialPreflight,
  createConfigurationManagementRuntime,
  createConfigurationProcessIdentity,
  createConfigurationStore,
  inspectAgentscopeConfigurationInitialization,
  listDestinationConnections,
  readConfigurationSnapshot,
  setDestinationRouting,
  unconfigureDestinationConnection,
  type ConfigurationManagementRuntime,
  type AgentscopeHome,
  type AgentscopeHomeResolver,
  type ConfigurationStore,
} from "@agentscope/core/configuration-management";
import {
  getConfiguredTrace,
  prepareCoreRetrievalRuntime,
  searchConfiguredTraces,
  type CoreRetrievalFailure,
  type PrepareCoreRetrievalRuntimeInput,
} from "@agentscope/core/retrieval-orchestration";
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
import type { CliDoctorServices } from "./doctor-commands.js";
import { createDoctorCliServices } from "./doctor-services.js";
import type { DestinationReachabilityProbe } from "@agentscope/destinations-core";
import type { CliTraceServices } from "./trace-commands.js";

// Type-only edges declare the process-private build entries to the source
// closure audit without loading them into the ordinary Commander runtime.
export type { OwnedHookLauncherArtifacts } from "./hook-launcher.js";
export type { HookMachineTestingInput } from "./hook-machine.js";

type ServiceResult<Value> = CliOperationResult<Value>;

const failure = <Value>(diagnostic: CliDiagnostic): ServiceResult<Value> =>
  Object.freeze({ diagnostic, status: "failure" as const });

const success = <Value>(value: Value): ServiceResult<Value> =>
  Object.freeze({ status: "success" as const, value });

const diagnostic = (
  category: CliDiagnostic["category"],
  code: string,
  facts?: CliDiagnostic["facts"],
): CliDiagnostic =>
  Object.freeze({ category, code, ...(facts === undefined ? {} : { facts }) });

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
  credentialBackendRegistry: CredentialBackendRegistry;
  environment: object;
  home: AgentscopeHome;
  management: ConfigurationManagementRuntime;
  owner: ConfigurationProcessIdentity;
  policyRegistry: RedactionPolicyRegistry;
  registry: DestinationRegistry;
  store: ConfigurationStore;
  transportExecutor: PrepareCoreRetrievalRuntimeInput["transportExecutor"];
}>;

/* v8 ignore next -- Phase 8 has no remote production descriptor; Phase 9 supplies Core's bound executor. */
const unavailableTransportExecutor: PrepareCoreRetrievalRuntimeInput["transportExecutor"] =
  () => Promise.reject(new Error("destination.transport.unavailable"));

export type CreateProductionCliServicesInput = Readonly<{
  environment?: object;
  harnesses?: CreateHarnessCliServicesInput;
  homeResolver?: AgentscopeHomeResolver;
  credentialBackendRegistry?: CredentialBackendRegistry;
  policyRegistry?: RedactionPolicyRegistry;
  registry?: DestinationRegistry;
  reachabilityProbes?: readonly DestinationReachabilityProbe[];
  transportExecutor?: PrepareCoreRetrievalRuntimeInput["transportExecutor"];
  gitExecutable?: string;
  workspace?: string;
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
    credentialBackendRegistry:
      input.credentialBackendRegistry ??
      compileCredentialBackendRegistry([
        createCiEnvironmentCredentialAdapter(input.environment ?? process.env),
      ]),
    environment: input.environment ?? process.env,
    home,
    management: createConfigurationManagementRuntime(registry, store, owner),
    owner,
    policyRegistry: input.policyRegistry ?? DEFAULT_REDACTION_POLICY_REGISTRY,
    registry,
    store,
    transportExecutor: input.transportExecutor ?? unavailableTransportExecutor,
  });
};

const productionOwnerState =
  (
    current: ConfigurationProcessIdentity,
  ): ((owner: ConfigurationProcessIdentity) => ConfigurationOwnerState) =>
  (owner) => {
    if (
      owner.processId === current.processId &&
      owner.processStartIdentity === current.processStartIdentity
    )
      return "live";
    try {
      process.kill(owner.processId, 0);
      return "unknown";
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "ESRCH"
        ? "dead"
        : "unknown";
    }
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
  async ({ apply, presentPlan }) => {
    let plan: Awaited<
      ReturnType<typeof inspectAgentscopeConfigurationInitialization>
    >;
    try {
      plan = await inspectAgentscopeConfigurationInitialization(
        state.management,
      );
    } catch (error) {
      return failure(mapError(error));
    }
    if (plan.action === "no-change") {
      const value: CliInitializationValue = {
        applied: false,
        generation: plan.generation,
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
      await presentPlan(planned);
      const result = await applyAgentscopeConfigurationInitialization(plan);
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

const retrievalDiagnostic = (
  failureValue: CoreRetrievalFailure,
): CliDiagnostic => {
  const [category, code] = RETRIEVAL_DIAGNOSTICS[failureValue.code];
  const facts =
    failureValue.retryAfterMilliseconds === undefined
      ? undefined
      : { retryAfterMilliseconds: failureValue.retryAfterMilliseconds };
  return diagnostic(category, code, facts);
};

const RETRIEVAL_DIAGNOSTICS = Object.freeze({
  "deadline-exceeded": ["unavailable", "traces.deadline-exceeded"],
  forbidden: ["permission-denied", "traces.forbidden"],
  "incompatible-trace": ["unavailable", "traces.incompatible-trace"],
  "invalid-query": ["usage", "traces.invalid-query"],
  "malformed-response": ["unavailable", "traces.malformed-response"],
  "not-found": ["not-found", "traces.not-found"],
  "rate-limited": ["unavailable", "traces.rate-limited"],
  "retrieval-unsupported": ["unavailable", "traces.retrieval-unsupported"],
  unauthorized: ["permission-denied", "traces.unauthorized"],
  unavailable: ["unavailable", "traces.unavailable"],
  "unknown-connection": ["not-found", "traces.destination-unknown"],
} as const satisfies Readonly<
  Record<
    CoreRetrievalFailure["code"],
    readonly [CliDiagnostic["category"], string]
  >
>);

const retrievalRuntime = (state: ProductionState) =>
  prepareCoreRetrievalRuntime({
    configurationStore: state.store,
    credentialBackendRegistry: state.credentialBackendRegistry,
    policyRegistry: state.policyRegistry,
    transportExecutor: state.transportExecutor,
  });

const RETRIEVAL_PREPARATION_DIAGNOSTICS = Object.freeze({
  "core.configuration.invalid": unavailable,
  "core.configuration.missing": missingConfiguration,
  "core.configuration.unavailable": unavailable,
  "core.configuration.unsupported": unavailable,
  "deadline-exceeded": diagnostic("unavailable", "traces.deadline-exceeded"),
});

const retrievalPreparationDiagnostic = (
  code: keyof typeof RETRIEVAL_PREPARATION_DIAGNOSTICS,
): CliDiagnostic => RETRIEVAL_PREPARATION_DIAGNOSTICS[code];

const createTraceServices = (state: ProductionState): CliTraceServices => ({
  searchTraces: async (input) => {
    try {
      const prepared = await retrievalRuntime(state);
      if (!prepared.ok)
        return failure(retrievalPreparationDiagnostic(prepared.code));
      const { cursor, destination } = input;
      const result = await searchConfiguredTraces(prepared.runtime, {
        destinationName: destination,
        query: {
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          ...(input.from === undefined ? {} : { from: input.from }),
          ...(input.harness === undefined ? {} : { harness: input.harness }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.sessionId === undefined
            ? {}
            : { sessionId: input.sessionId }),
          tags: input.tags,
          ...(input.to === undefined ? {} : { to: input.to }),
          ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        },
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!result.ok) return failure(retrievalDiagnostic(result));
      const value = result.page;
      return value.state === "partial"
        ? Object.freeze({
            diagnostic: diagnostic("unavailable", "traces.partial"),
            status: "partial" as const,
            value,
          })
        : success(value);
    } catch (error) {
      return failure(mapError(error));
    }
  },
  getTrace: async (input) => {
    try {
      const prepared = await retrievalRuntime(state);
      if (!prepared.ok)
        return failure(retrievalPreparationDiagnostic(prepared.code));
      const reference = input.traceReference;
      if (reference !== undefined) {
        const connection = prepared.runtime.configuration.connections.find(
          ({ name }) => name === input.destination,
        );
        if (!connection)
          return failure(diagnostic("not-found", "traces.destination-unknown"));
        if (
          reference.connectionId !== connection.connectionId ||
          reference.destinationType !== connection.destinationType
        )
          return failure(diagnostic("usage", "traces.invalid-query"));
      }
      const result = await getConfiguredTrace(prepared.runtime, {
        destinationName: input.destination,
        traceId: reference?.traceId ?? input.traceId ?? "",
        ...(reference?.destinationTraceId === undefined
          ? {}
          : { destinationTraceId: reference.destinationTraceId }),
        ...(reference?.destinationRevision === undefined
          ? {}
          : { destinationRevision: reference.destinationRevision }),
      });
      return result.ok
        ? success(result.trace)
        : failure(retrievalDiagnostic(result));
    } catch (error) {
      return failure(mapError(error));
    }
  },
});

const createProductionDoctorServices = (
  state: ProductionState,
  input: CreateProductionCliServicesInput,
  harnessServices: CliHarnessServices,
): CliDoctorServices =>
  createDoctorCliServices({
    configurationStore: state.store,
    credentialRegistry: state.credentialBackendRegistry,
    credentialResolutionContext: createCredentialResolutionContext(
      "interactive",
      new AbortController().signal,
    ),
    gitInspector: () =>
      inspectGitContextForDoctor({
        gitExecutable:
          input.gitExecutable ??
          (process.platform === "win32"
            ? "C:\\Program Files\\Git\\cmd\\git.exe"
            : "/usr/bin/git"),
        timeoutMilliseconds: 1_000,
        workspace: input.workspace ?? process.cwd(),
      }),
    harnessServices,
    operationalStateStore: createOperationalStateStore(state.home, state.owner),
    ownerState: productionOwnerState(state.owner),
    ...(input.reachabilityProbes === undefined
      ? {}
      : {
          reachabilityProbes: input.reachabilityProbes.map((probe) => {
            if (
              !getDestinationDescriptor(state.registry, probe.destinationType)
            )
              throw new Error("cli.doctor.invalid");
            return probe;
          }),
        }),
  });

const createListService =
  (state: ProductionState): CliConfigurationServices["listDestinations"] =>
  async () => {
    try {
      return success({
        connections: [...(await listDestinationConnections(state.management))],
      });
    } catch (error) {
      return failure(mapError(error));
    }
  };

export const createProductionCliServices = (
  input: CreateProductionCliServicesInput = {},
): CliConfigurationServices &
  CliDoctorServices &
  CliHarnessServices &
  CliTraceServices => {
  const state = createState(input);
  const harnessServices = createHarnessCliServices(input.harnesses);
  const list = createListService(state);
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
    ...createProductionDoctorServices(state, input, harnessServices),
    ...harnessServices,
    ...createTraceServices(state),
  });
};
