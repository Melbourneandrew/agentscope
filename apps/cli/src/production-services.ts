import { randomBytes } from "node:crypto";

import {
  createCredentialResolutionContext,
  isCredentialResolutionContext,
  createOperationalStateStore,
  DEFAULT_REDACTION_POLICY_REGISTRY,
  inspectGitContextForDoctor,
  type CredentialBackendRegistry,
  type ConfigurationOwnerState,
  type ConfigurationProcessIdentity,
  type RedactionPolicyRegistry,
} from "@agentscope/core";
import {
  applyAgentscopeConfigurationInitialization,
  createAgentscopeHomeResolver,
  createConfigurationManagementRuntime,
  createConfigurationProcessIdentity,
  createConfigurationStore,
  inspectDestinationLifecyclePlan,
  inspectDestinationLifecycleRecoveryPlan,
  inspectDestinationLocalResourceDoctor,
  applyDestinationLifecyclePlan,
  applyDestinationLifecycleRecoveryPlan,
  inspectAgentscopeConfigurationInitialization,
  listDestinationConnections,
  readConfigurationSnapshot,
  setDestinationRouting,
  type ConfigurationManagementRuntime,
  type AgentscopeHome,
  type AgentscopeHomeResolver,
  type ConfigurationStore,
} from "@agentscope/core/configuration-management";
import { createLocalResourceHomeAuthority } from "@agentscope/core/home-authority";
import {
  getConfiguredTrace,
  prepareConfiguredDestinationReachability,
  prepareCoreRetrievalRuntime,
  searchConfiguredTraces,
  type CoreRetrievalFailure,
  type PrepareCoreRetrievalRuntimeInput,
} from "@agentscope/core/retrieval-orchestration";
import {
  getDestinationDescriptor,
  type DestinationRegistry,
} from "@agentscope/destinations-core/configuration";
import {
  createLangfuseReachabilityProbe,
  langfuseDestinationDescriptor,
  type LangfuseDestinationSettings,
} from "@agentscope/destination-langfuse";
import {
  initializeLocalSqliteProductionComposition,
  localSqliteDestinationDescriptor,
} from "@agentscope/destination-local-sqlite";

import type { CliDiagnostic } from "./cli-contract.js";
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
import {
  compileLocalResourceLifecycleHandlerRegistry,
  type DestinationReachabilityProbe,
  type LocalResourceLifecycleHandlerRegistry,
} from "@agentscope/destinations-core";
import type { CliTraceServices } from "./trace-commands.js";
import { productionDestinationTransportExecutor } from "./destination-transport.js";
import { createProductHarnesses } from "./product-harnesses.js";
import { createProductCredentialBackendRegistry } from "./product-credential-registry.js";
import {
  createConfigureService,
  createUnconfigureService,
  diagnostic,
  failure,
  success,
  mapError,
  unavailable,
  missingConfiguration,
  lifecyclePlanValue,
} from "./credential-configuration-service.js";
import type { CliCommandBoundary } from "./command-runtime.js";
import {
  PRODUCT_DESTINATION_REGISTRY,
  requireExactProductDestinationRegistry,
  requireExactProductDestinationRegistryForTesting,
} from "./product-destination-registry.js";

export { requireExactProductDestinationRegistryForTesting };

declare const __AGENTSCOPE_CLI_VERSION__: string;

// Type-only edges declare the process-private build entries to the source
// closure audit without loading them into the ordinary Commander runtime.
export type { OwnedHookLauncherArtifacts } from "./hook-launcher.js";
export type { HookMachineTestingInput } from "./hook-machine.js";

type ProductionState = Readonly<{
  commandBoundary: CliCommandBoundary;
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

export type CreateProductionCliServicesInput = Readonly<{
  commandBoundary?: CliCommandBoundary;
  environment?: object;
  harnesses?: CreateHarnessCliServicesInput;
  homeResolver?: AgentscopeHomeResolver;
  credentialBackendRegistry?: CredentialBackendRegistry;
  policyRegistry?: RedactionPolicyRegistry;
  reachabilityProbes?: readonly DestinationReachabilityProbe[];
  transportExecutor?: PrepareCoreRetrievalRuntimeInput["transportExecutor"];
  gitExecutable?: string;
  workspace?: string;
}>;

const createState = (
  input: CreateProductionCliServicesInput,
  registry: DestinationRegistry,
  createLifecycleHandlers: (
    home: AgentscopeHome,
    registry: DestinationRegistry,
  ) => LocalResourceLifecycleHandlerRegistry,
): ProductionState => {
  const enteredAt = performance.now();
  const commandBoundary =
    input.commandBoundary ??
    Object.freeze({
      outputMode: "human" as const,
      credentialContext: createCredentialResolutionContext(
        "hook-equivalent",
        new AbortController().signal,
        enteredAt + 60_000,
      ),
    });
  if (
    !isCredentialResolutionContext(commandBoundary.credentialContext) ||
    commandBoundary.credentialContext.expiresAtMonotonicMilliseconds ===
      undefined ||
    commandBoundary.credentialContext.signal.aborted ||
    performance.now() >=
      commandBoundary.credentialContext.expiresAtMonotonicMilliseconds
  )
    throw new Error("cli.command.expired");
  const home = (input.homeResolver ?? createAgentscopeHomeResolver())();
  const store = createConfigurationStore(home, registry);
  const lifecycleHandlers = createLifecycleHandlers(home, registry);
  const owner = createConfigurationProcessIdentity(
    process.pid,
    `process-start-v1-${randomBytes(32).toString("hex")}`,
  );
  const credentialBackendRegistry =
    input.credentialBackendRegistry ??
    createProductCredentialBackendRegistry(input.environment ?? process.env);
  return Object.freeze({
    commandBoundary,
    credentialBackendRegistry,
    environment: input.environment ?? process.env,
    home,
    management: createConfigurationManagementRuntime(
      registry,
      store,
      owner,
      lifecycleHandlers,
      credentialBackendRegistry,
    ),
    owner,
    policyRegistry: input.policyRegistry ?? DEFAULT_REDACTION_POLICY_REGISTRY,
    registry,
    store,
    transportExecutor:
      input.transportExecutor ?? productionDestinationTransportExecutor,
  });
};

const createProductLifecycleHandlers = (
  home: AgentscopeHome,
  registry: DestinationRegistry,
): LocalResourceLifecycleHandlerRegistry => {
  const composition = initializeLocalSqliteProductionComposition(
    createLocalResourceHomeAuthority(home),
  );
  const capability = getDestinationDescriptor(
    registry,
    localSqliteDestinationDescriptor.destinationType,
  )?.localResourceLifecycle;
  if (
    composition.destinationDescriptor !== localSqliteDestinationDescriptor ||
    !capability
  )
    throw new Error("cli.product-destination-registry.invalid");
  return compileLocalResourceLifecycleHandlerRegistry(registry, [
    composition.createLifecycleHandler(capability),
  ]);
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
    state: ProductionState,
    list: CliConfigurationServices["listDestinations"],
  ): CliConfigurationServices["deleteDestination"] =>
  async ({ confirm, name, presentPlan }) => {
    const listed = await list();
    if (listed.status !== "success") return failure(listed.diagnostic);
    const connection = listed.value.connections.find(
      (candidate) => candidate.name === name,
    );
    if (
      connection === undefined &&
      !/^destination-connection-v1-[0-9a-f]{64}$/u.test(name)
    )
      return failure(diagnostic("not-found", "destination.connection-missing"));
    if (connection !== undefined) {
      const descriptor = getDestinationDescriptor(
        state.registry,
        connection.destinationType,
      );
      if (!descriptor?.localResourceLifecycle) {
        if (!confirm)
          return failure(
            diagnostic("conflict", "destination.confirmation-required"),
          );
        return failure(
          diagnostic("unavailable", "destination.data-delete-unsupported"),
        );
      }
    }
    try {
      const plan = await inspectDestinationLifecyclePlan(
        state.management,
        "delete",
        name,
        new AbortController().signal,
      );
      const planned = {
        applied: false,
        deleted: false,
        plan: lifecyclePlanValue(plan),
        selector: name,
        state: "planned" as const,
      };
      if (!confirm) return success(planned);
      if (!presentPlan)
        return failure(diagnostic("usage", "cli.input.invalid"));
      await presentPlan(planned);
      await applyDestinationLifecyclePlan(plan);
      return success({
        applied: true,
        deleted: true,
        plan: lifecyclePlanValue(plan),
        selector: name,
        state: "deleted" as const,
      });
    } catch (error) {
      return failure(mapError(error));
    }
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
    signal: state.commandBoundary.credentialContext.signal,
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

const createProductionLangfuseProbe = (
  state: ProductionState,
): DestinationReachabilityProbe =>
  createLangfuseReachabilityProbe(
    async (
      connectionId,
      configurationGeneration,
      configurationIdentity,
      signal,
    ) => {
      try {
        if (signal.aborted) return null;
        const preparation = await prepareCoreRetrievalRuntime({
          configurationStore: state.store,
          credentialBackendRegistry: state.credentialBackendRegistry,
          policyRegistry: state.policyRegistry,
          signal,
          transportExecutor: state.transportExecutor,
        });
        if (!preparation.ok || signal.aborted) return null;
        const connection = prepareConfiguredDestinationReachability(
          preparation.runtime,
          connectionId,
          langfuseDestinationDescriptor.destinationType,
          configurationGeneration,
          configurationIdentity,
        );
        if (!connection.ok) return null;
        const profileId = connection.settings.profileId;
        if (typeof profileId !== "string") return null;
        return Object.freeze({
          connectionId,
          profileId: profileId as LangfuseDestinationSettings["profileId"],
          transport: connection.transport,
        });
      } catch {
        return null;
      }
    },
  );

const defaultProductionReachabilityProbes = (
  state: ProductionState,
): readonly DestinationReachabilityProbe[] =>
  getDestinationDescriptor(
    state.registry,
    langfuseDestinationDescriptor.destinationType,
  ) === langfuseDestinationDescriptor
    ? Object.freeze([createProductionLangfuseProbe(state)])
    : Object.freeze([]);

const createProductionDoctorServices = (
  state: ProductionState,
  input: CreateProductionCliServicesInput,
  harnessServices: CliHarnessServices,
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState,
): CliDoctorServices => {
  const localResourceDestinationType = state.registry.descriptors.find(
    (descriptor) =>
      descriptor.localResourceLifecycle?.operations.includes("doctor") === true,
  )?.destinationType;
  return createDoctorCliServices({
    configurationStore: state.store,
    credentialRegistry: state.credentialBackendRegistry,
    credentialResolutionContext: createCredentialResolutionContext(
      "interactive",
      state.commandBoundary.credentialContext.signal,
      state.commandBoundary.credentialContext.expiresAtMonotonicMilliseconds,
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
    ...(localResourceDestinationType === undefined
      ? {}
      : { localResourceDestinationType }),
    localResourceInspector: async (connectionId, signal) => {
      const connection = (
        await listDestinationConnections(state.management)
      ).find((value) => value.connectionId === connectionId);
      if (!connection) throw new Error("core.destination.connection-missing");
      return inspectDestinationLocalResourceDoctor(
        state.management,
        connection.name,
        signal,
      );
    },
    operationalStateStore: createOperationalStateStore(state.home, state.owner),
    ownerState,
    reachabilityProbes: (
      input.reachabilityProbes ?? defaultProductionReachabilityProbes(state)
    ).map((probe) => {
      if (!getDestinationDescriptor(state.registry, probe.destinationType))
        throw new Error("cli.doctor.invalid");
      return probe;
    }),
  });
};

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

const createRecoveryService =
  (
    state: ProductionState,
    ownerState: (
      owner: ConfigurationProcessIdentity,
    ) => ConfigurationOwnerState,
  ): CliConfigurationServices["recoverDestinationLifecycle"] =>
  async ({ apply, presentPlan }) => {
    try {
      const plan = await inspectDestinationLifecycleRecoveryPlan(
        state.management,
        ownerState,
        new AbortController().signal,
      );
      const planValue = Object.freeze({
        authorizedGenerations: [...plan.authorizedGenerations],
        connectionId: plan.connectionId,
        destinationType: plan.destinationType,
        expectedGeneration: plan.expectedGeneration,
        lifecycleFingerprint: plan.lifecycleFingerprint,
        operationId: plan.operationId,
        pendingOperation: plan.pendingOperation,
        recoveryStage: plan.recoveryStage,
      });
      const planned = {
        applied: false,
        backupSelector: null,
        generation: null,
        operation: "recover" as const,
        plan: planValue,
        retainedDeleteSelector: null,
        state: "planned" as const,
      };
      if (!apply) return success(planned);
      await presentPlan(planned);
      const result = await applyDestinationLifecycleRecoveryPlan(plan);
      return success({
        applied: true,
        backupSelector: result.backupSelector ?? null,
        generation: result.generation,
        operation: "recover",
        plan: planValue,
        retainedDeleteSelector: result.retainedDeleteSelector ?? null,
        state: result.state,
      });
    } catch (error) {
      return failure(mapError(error));
    }
  };

const createCliServices = (
  input: CreateProductionCliServicesInput,
  registry: DestinationRegistry,
  createLifecycleHandlers: (
    home: AgentscopeHome,
    registry: DestinationRegistry,
  ) => LocalResourceLifecycleHandlerRegistry,
  resolveOwnerState: (
    state: ProductionState,
  ) => (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState,
  resolveHarnesses: (
    state: ProductionState,
    input: CreateProductionCliServicesInput,
  ) => CreateHarnessCliServicesInput | undefined,
): CliConfigurationServices &
  CliDoctorServices &
  CliHarnessServices &
  CliTraceServices => {
  const state = createState(input, registry, createLifecycleHandlers);
  const ownerState = resolveOwnerState(state);
  const harnessServices = createHarnessCliServices(
    resolveHarnesses(state, input),
  );
  const list = createListService(state);
  const services: CliConfigurationServices = {
    configureDestination: createConfigureService(state),
    deleteDestination: createDeleteService(state, list),
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
    recoverDestinationLifecycle: createRecoveryService(state, ownerState),
    unconfigureDestination: createUnconfigureService(state),
  };
  return Object.freeze({
    ...services,
    ...createProductionDoctorServices(
      state,
      input,
      harnessServices,
      ownerState,
    ),
    ...harnessServices,
    ...createTraceServices(state),
  });
};

export const createProductionCliServices = (
  input: CreateProductionCliServicesInput = {},
): CliConfigurationServices &
  CliDoctorServices &
  CliHarnessServices &
  CliTraceServices =>
  createCliServices(
    input,
    requireExactProductDestinationRegistry(PRODUCT_DESTINATION_REGISTRY),
    createProductLifecycleHandlers,
    (state) => productionOwnerState(state.owner),
    (state, productInput) =>
      productInput.harnesses ??
      createProductHarnesses({
        environment: state.environment as Readonly<
          Record<string, string | undefined>
        >,
        home: state.home,
        /* v8 ignore next -- the packed-artifact verifier executes this exact
           production callback through installed Codex plan/apply/status. */
        readHookDeadlineMilliseconds: async () =>
          (await readConfigurationSnapshot(state.store))
            .hookDeadlineMilliseconds,
        releaseIdentity:
          typeof __AGENTSCOPE_CLI_VERSION__ === "string"
            ? __AGENTSCOPE_CLI_VERSION__
            : "0.1.0",
      }),
  );

export const createProductionCliServicesForTesting = (
  input: CreateProductionCliServicesInput &
    Readonly<{
      registry: DestinationRegistry;
      lifecycleHandlers?: LocalResourceLifecycleHandlerRegistry;
      ownerState?: (
        owner: ConfigurationProcessIdentity,
      ) => ConfigurationOwnerState;
    }>,
): CliConfigurationServices &
  CliDoctorServices &
  CliHarnessServices &
  CliTraceServices =>
  createCliServices(
    input,
    input.registry,
    (_home, registry) =>
      input.lifecycleHandlers ??
      compileLocalResourceLifecycleHandlerRegistry(registry, []),
    (state) => input.ownerState ?? productionOwnerState(state.owner),
    (_state, testingInput) => testingInput.harnesses,
  );
