import {
  getDestinationDescriptor,
  isReporterDeadline,
  reporterDeadlineRemainingMilliseconds,
  type DestinationConnectionId,
  type DestinationRegistry,
  type RedactedTraceBatch,
  type Reporter,
  type ReporterDeadline,
  type ReporterOutcome,
} from "@agentscope/destinations-core";
import {
  bindDestinationTransport,
  invokeReporter,
  prepareDestinationReporter,
  resolveDestinationConnection,
  type DestinationTransportExecutor,
} from "@agentscope/destinations-core/core-orchestration";
import {
  isRedactedCanonicalTrace,
  type RedactedCanonicalTrace,
} from "@agentscope/protocol";

import {
  createCredentialResolutionContext,
  readResolvedCredentialForCore,
  resolveCredentialReference,
  type CredentialBackendRegistry,
} from "../configuration/credential-adapter.js";
import type {
  AgentscopeConfigurationSnapshot,
  ConfiguredDestinationConnection,
} from "../configuration/schema.js";

export const CONNECTION_SETUP_TIMEOUT_MILLISECONDS = 1_000;

export type RoutedConnectionResult = Readonly<{
  connectionId: DestinationConnectionId;
  outcome: ReporterOutcome;
}>;

export type RoutingDeliveryResult = Readonly<{
  outcome: "completed" | "routing-unselected";
  connections: readonly RoutedConnectionResult[];
}>;

export type RouteRedactedTraceBatchInput = Readonly<{
  traces: readonly RedactedCanonicalTrace[];
  configuration: AgentscopeConfigurationSnapshot;
  credentialBackendRegistry: CredentialBackendRegistry;
  transportExecutor: DestinationTransportExecutor;
  deadline: ReporterDeadline;
  signal?: AbortSignal;
}>;

const fixedResult = (
  connectionId: DestinationConnectionId,
  outcome: ReporterOutcome,
): RoutedConnectionResult => Object.freeze({ connectionId, outcome });

const signalIsAborted = (signal: AbortSignal | undefined): boolean => {
  try {
    return signal?.aborted === true;
  } catch {
    return true;
  }
};

const normalizeBatch = (
  input: readonly RedactedCanonicalTrace[],
): RedactedTraceBatch => {
  if (!Array.isArray(input) || input.length === 0 || input.length > 32)
    throw new Error("core.routing.invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const output: RedactedCanonicalTrace[] = [];
  const identities = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !isRedactedCanonicalTrace(descriptor.value) ||
      identities.has(descriptor.value.delivery.identity)
    )
      throw new Error("core.routing.invalid");
    identities.add(descriptor.value.delivery.identity);
    output.push(descriptor.value);
  }
  if (
    Object.keys(descriptors).some(
      (key) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key),
    )
  )
    throw new Error("core.routing.invalid");
  return Object.freeze(output) as RedactedTraceBatch;
};

const findConnection = (
  configuration: AgentscopeConfigurationSnapshot,
  connectionId: DestinationConnectionId,
): ConfiguredDestinationConnection | undefined =>
  configuration.connections.find(
    (connection) => connection.connectionId === connectionId,
  );

const prepareConnectionReporter = async (
  connection: ConfiguredDestinationConnection,
  destinationRegistry: DestinationRegistry,
  credentialBackendRegistry: CredentialBackendRegistry,
  transportExecutor: DestinationTransportExecutor,
  signal: AbortSignal,
): Promise<Reporter | undefined> => {
  try {
    const descriptor = getDestinationDescriptor(
      destinationRegistry,
      connection.destinationType,
    );
    /* v8 ignore next -- configuration parsing and the immutable snapshot use
       this exact registry, so a retained configured type always resolves. */
    if (!descriptor) return undefined;
    const prepared = resolveDestinationConnection(descriptor, {
      connectionId: connection.connectionId,
      settings: connection.settings,
    });
    const transport = prepared.endpoint
      ? bindDestinationTransport(prepared.endpoint, transportExecutor)
      : null;
    if (signal.aborted) return undefined;
    const context = createCredentialResolutionContext("hook", signal);
    const credentials = await Promise.all(
      descriptor.credentialSlots.map(async (slot) => {
        const reference = connection.credentialReferences[slot.id];
        if (!reference) return [slot.id, undefined] as const;
        const result = await resolveCredentialReference(
          credentialBackendRegistry,
          reference,
          context,
        );
        if (!result.ok) throw new Error("core.routing.unavailable");
        return [
          slot.id,
          readResolvedCredentialForCore(result.credential),
        ] as const;
      }),
    );
    if (signal.aborted) return undefined;
    return prepareDestinationReporter(prepared, {
      credentials: Object.freeze(
        Object.fromEntries(
          credentials.filter(
            (entry): entry is readonly [(typeof entry)[0], string] =>
              entry[1] !== undefined,
          ),
        ),
      ),
      transport,
    });
  } catch {
    return undefined;
  }
};

type SetupSettlement =
  | Readonly<{ kind: "prepared"; reporter: Reporter | undefined }>
  | Readonly<{ kind: "expired" }>;

const setupReporter = async (
  connection: ConfiguredDestinationConnection,
  input: RouteRedactedTraceBatchInput,
  controller: AbortController,
): Promise<SetupSettlement> => {
  const remaining = reporterDeadlineRemainingMilliseconds(input.deadline);
  if (remaining <= 0 || signalIsAborted(input.signal))
    return Object.freeze({ kind: "expired" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiration = new Promise<SetupSettlement>((resolve) => {
    timer = setTimeout(
      () => {
        controller.abort();
        resolve(Object.freeze({ kind: "expired" }));
      },
      Math.min(CONNECTION_SETUP_TIMEOUT_MILLISECONDS, remaining),
    );
  });
  const preparation: Promise<SetupSettlement> = prepareConnectionReporter(
    connection,
    input.configuration.destinationRegistry,
    input.credentialBackendRegistry,
    input.transportExecutor,
    controller.signal,
  ).then((reporter) => Object.freeze({ kind: "prepared", reporter }));
  const settlement = await Promise.race([preparation, expiration]);
  /* v8 ignore else -- the Promise executor synchronously initializes timer. */
  if (timer !== undefined) clearTimeout(timer);
  return settlement;
};

const routeConnection = async (
  connectionId: DestinationConnectionId,
  traces: RedactedTraceBatch,
  input: RouteRedactedTraceBatchInput,
): Promise<RoutedConnectionResult> => {
  const connection = findConnection(input.configuration, connectionId);
  if (!connection) return fixedResult(connectionId, "unavailable");
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };
  try {
    input.signal?.addEventListener("abort", abort, { once: true });
    const setup = await setupReporter(connection, input, controller);
    if (setup.kind === "expired")
      return fixedResult(
        connectionId,
        reporterDeadlineRemainingMilliseconds(input.deadline) <= 0 ||
          signalIsAborted(input.signal)
          ? "deadline-exceeded"
          : "unavailable",
      );
    if (!setup.reporter)
      return fixedResult(
        connectionId,
        reporterDeadlineRemainingMilliseconds(input.deadline) <= 0 ||
          signalIsAborted(input.signal)
          ? "deadline-exceeded"
          : "unavailable",
      );
    const receipt = await invokeReporter(setup.reporter, {
      traces,
      signal: controller.signal,
      deadline: input.deadline,
    });
    return fixedResult(connectionId, receipt.outcome);
  } catch {
    return fixedResult(
      connectionId,
      reporterDeadlineRemainingMilliseconds(input.deadline) <= 0 ||
        signalIsAborted(input.signal)
        ? "deadline-exceeded"
        : "unavailable",
    );
  } finally {
    controller.abort();
    try {
      input.signal?.removeEventListener("abort", abort);
    } catch {
      // A hostile optional signal is treated as cancellation at the stage gates.
    }
  }
};

export const routeRedactedTraceBatch = async (
  input: RouteRedactedTraceBatchInput,
): Promise<RoutingDeliveryResult> => {
  if (!isReporterDeadline(input.deadline))
    throw new Error("core.routing.invalid");
  const selected = input.configuration.selectedConnectionIds;
  if (selected.length === 0)
    return Object.freeze({
      outcome: "routing-unselected",
      connections: Object.freeze([]),
    });
  const traces = normalizeBatch(input.traces);
  const connections = await Promise.all(
    selected.map((connectionId) =>
      routeConnection(connectionId, traces, input),
    ),
  );
  return Object.freeze({
    outcome: "completed",
    connections: Object.freeze(connections),
  });
};
