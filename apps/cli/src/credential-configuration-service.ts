import { randomBytes } from "node:crypto";
import {
  ConfigurationManagementError,
  ConfigurationStoreError,
  configureDestinationConnection,
  configureStoredDestinationConnection,
  unconfigureManagedDestinationConnection,
  createCiEnvironmentCredentialReference,
  createCiEnvironmentCredentialPreflight,
  inspectDestinationConfigureLifecyclePlan,
  inspectDestinationLifecyclePlan,
  applyDestinationLifecyclePlan,
  listDestinationConnections,
  type ConfigurationManagementRuntime,
  type DestinationLifecyclePlan,
} from "@agentscope/core/configuration-management";
import {
  getDestinationDescriptor,
  type DestinationRegistry,
} from "@agentscope/destinations-core/configuration";
import type { CliDiagnostic, CliOperationResult } from "./cli-contract.js";
import type { CliConfigurationServices } from "./configuration-command-contract.js";
import type { CliCommandBoundary } from "./command-runtime.js";
import { readHiddenCredentialForCli } from "./credential-input.js";
import { localSqliteDestinationDescriptor } from "@agentscope/destination-local-sqlite";

type ProductionState = Readonly<{
  management: ConfigurationManagementRuntime;
  registry: DestinationRegistry;
  environment: object;
  commandBoundary: CliCommandBoundary;
}>;

const expired = (state: ProductionState) =>
  state.commandBoundary.credentialContext.signal.aborted ||
  state.commandBoundary.credentialContext.expiresAtMonotonicMilliseconds ===
    undefined ||
  performance.now() >=
    state.commandBoundary.credentialContext.expiresAtMonotonicMilliseconds;

const configureInteractive = async (
  state: ProductionState,
  input: Parameters<CliConfigurationServices["configureDestination"]>[0],
): Promise<
  Awaited<ReturnType<CliConfigurationServices["configureDestination"]>>
> => {
  if (
    expired(state) ||
    process.platform !== "darwin" ||
    state.commandBoundary.outputMode !== "human" ||
    input.humanInteractive !== true ||
    !process.stdin.isTTY ||
    !process.stderr.isTTY
  )
    return failure(
      diagnostic("unavailable", "destination.credential-unavailable"),
    );
  const result = await configureStoredDestinationConnection(state.management, {
    commandName: input.type,
    name: input.name,
    settings: parseSettings(input.settingsJson),
    backend: "macos-keychain",
    resolutionContext: state.commandBoundary.credentialContext,
    readSecret: readHiddenCredentialForCli,
  });
  if (!result.ok)
    return failure(
      diagnostic("unavailable", "destination.credential-unavailable", {
        configurationCommitted: result.configurationCommitted,
        reconciliationRequired: result.state !== "compensated",
      }),
    );
  if (result.state !== "active") throw new Error("cli.input.invalid");
  return success({
    applied: true,
    connection: result.connection,
    generation: result.generation,
    plan: null,
    state: "configured" as const,
  });
};

type ServiceResult<Value> = CliOperationResult<Value>;

export const failure = <Value>(
  diagnostic: CliDiagnostic,
): ServiceResult<Value> =>
  Object.freeze({ diagnostic, status: "failure" as const });

export const success = <Value>(value: Value): ServiceResult<Value> =>
  Object.freeze({ status: "success" as const, value });

export const diagnostic = (
  category: CliDiagnostic["category"],
  code: string,
  facts?: CliDiagnostic["facts"],
): CliDiagnostic =>
  Object.freeze({ category, code, ...(facts === undefined ? {} : { facts }) });

export const unavailable = diagnostic(
  "unavailable",
  "configuration.unavailable",
);
export const missingConfiguration = diagnostic(
  "not-found",
  "configuration.missing",
);

export const mapError = (error: unknown): CliDiagnostic => {
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
    case "core.destination.lifecycle-busy":
      return diagnostic("conflict", "destination.lifecycle-busy");
    case "core.destination.lifecycle-capacity":
      return diagnostic("unavailable", "destination.lifecycle-capacity");
    case "core.destination.lifecycle-outcome-unknown":
      return diagnostic("unavailable", "destination.lifecycle-outcome-unknown");
    case "core.destination.lifecycle-reconciliation-required":
      return diagnostic(
        "conflict",
        "destination.lifecycle-reconciliation-required",
      );
    case "core.destination.lifecycle-unavailable":
      return diagnostic("unavailable", "destination.lifecycle-unavailable");
    case "core.destination.type-missing":
      return diagnostic("not-found", "destination.type-missing");
    default:
      return unavailable;
  }
};

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

export const lifecyclePlanValue = (plan: DestinationLifecyclePlan) =>
  Object.freeze({
    destinationType: plan.destinationType,
    displayPath: plan.displayPath,
    operation: plan.operation,
    persistentDataNotice: plan.persistentDataNotice,
    retentionPolicy: plan.retentionPolicy,
  });

export const createConfigureService =
  (state: ProductionState): CliConfigurationServices["configureDestination"] =>
  async (input) => {
    // The alpha keeps descriptor discovery, not an admitted Local capability.
    // Refuse before settings, credentials, plans, or any mutation.
    if (input.type === localSqliteDestinationDescriptor.commandName)
      return failure(
        diagnostic("unavailable", "destination.capability-unavailable"),
      );
    try {
      if (expired(state)) return failure(unavailable);
      const signal = state.commandBoundary.credentialContext.signal;
      const candidate = {
        commandName: input.type,
        credentialReferences: parseCredentialEnvironment(
          input.credentialEnvironment,
        ),
        name: input.name,
        settings: parseSettings(input.settingsJson),
      };
      const preflight = createCiEnvironmentCredentialPreflight(
        state.environment,
        signal,
      );
      const descriptor = state.registry.descriptors.find(
        (value) => value.commandName === input.type,
      );
      if (!descriptor?.localResourceLifecycle) {
        if (
          input.credentialEnvironment.length === 0 &&
          descriptor?.credentialSlots.some((slot) => slot.required)
        )
          return await configureInteractive(state, input);
        const configured = await configureDestinationConnection(
          state.management,
          candidate,
          preflight,
        );
        if (expired(state))
          return failure(
            diagnostic("unavailable", "configuration.unavailable", {
              configurationCommitted: true,
            }),
          );
        return success({
          applied: true,
          connection: configured.connection,
          generation: configured.generation,
          plan: null,
          state: "configured",
        });
      }
      const plan = await inspectDestinationConfigureLifecyclePlan(
        state.management,
        candidate,
        signal,
        preflight,
      );
      const planned = {
        applied: false,
        connection: null,
        generation: null,
        plan: lifecyclePlanValue(plan),
        state: "planned" as const,
      };
      if (input.apply !== true) return success(planned);
      if (!input.presentPlan)
        return failure(diagnostic("usage", "cli.input.invalid"));
      await input.presentPlan(planned);
      const applied = await applyDestinationLifecyclePlan(plan);
      const connection = (
        await listDestinationConnections(state.management)
      ).find((value) => value.name === applied.name);
      if (!connection)
        return failure(
          diagnostic("unavailable", "destination.lifecycle-outcome-unknown"),
        );
      return success({
        applied: true,
        connection,
        generation: applied.generation,
        plan: lifecyclePlanValue(plan),
        state: "configured",
      });
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error instanceof Error && error.message === "cli.input.invalid")
      )
        return failure(diagnostic("usage", "cli.input.invalid"));
      return failure(mapError(error));
    }
  };

export const createUnconfigureService =
  (
    state: ProductionState,
  ): CliConfigurationServices["unconfigureDestination"] =>
  async ({ apply, name, presentPlan, retireCredentials }) => {
    try {
      if (expired(state)) return failure(unavailable);
      const connection = (
        await listDestinationConnections(state.management)
      ).find((value) => value.name === name);
      if (!connection)
        return failure(
          diagnostic("not-found", "destination.connection-missing"),
        );
      const descriptor = getDestinationDescriptor(
        state.registry,
        connection.destinationType,
      );
      if (!descriptor?.localResourceLifecycle) {
        const result = await unconfigureManagedDestinationConnection(
          state.management,
          {
            name,
            retireCredentials: retireCredentials === true,
            resolutionContext: state.commandBoundary.credentialContext,
          },
        );
        if (!result.ok)
          return failure(
            diagnostic("unavailable", "configuration.unavailable", {
              configurationCommitted: result.configurationCommitted,
            }),
          );
        return success({
          applied: true,
          dataPreserved: true,
          generation: result.generation,
          name: result.name,
          plan: null,
          retainedDeleteSelector: null,
          state: "unconfigured",
        });
      }
      if (retireCredentials)
        return failure(diagnostic("usage", "cli.input.invalid"));
      const plan = await inspectDestinationLifecyclePlan(
        state.management,
        "unconfigure",
        name,
        state.commandBoundary.credentialContext.signal,
      );
      const planned = {
        applied: false,
        dataPreserved: true as const,
        generation: null,
        name,
        plan: lifecyclePlanValue(plan),
        retainedDeleteSelector: null,
        state: "planned" as const,
      };
      if (apply !== true) return success(planned);
      if (!presentPlan)
        return failure(diagnostic("usage", "cli.input.invalid"));
      await presentPlan(planned);
      const result = await applyDestinationLifecyclePlan(plan);
      return success({
        applied: true,
        dataPreserved: true,
        generation: result.generation,
        name: result.name,
        plan: lifecyclePlanValue(plan),
        retainedDeleteSelector: result.retainedDeleteSelector ?? null,
        state: "retained",
      });
    } catch (error) {
      return failure(mapError(error));
    }
  };
