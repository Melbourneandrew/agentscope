import { createHash } from "node:crypto";

import {
  getDestinationDescriptor,
  createTraceLocator,
  type DestinationDescriptor,
  type ReporterDeadline,
  type Retriever,
  type RetrieverFailureCode,
  type TraceSearchCursor,
  type TraceSearchInput,
  reporterDeadlineRemainingMilliseconds,
} from "@agentscope/destinations-core";
import {
  bindDestinationTransport,
  createReporterDeadline,
  createRetrievalContext,
  createTraceGetRequest,
  createTraceSearchPage,
  createTraceSearchRequest,
  invokeRetrieverGet,
  invokeRetrieverSearch,
  normalizeTraceSearchQuery,
  prepareDestinationRetriever,
  readTraceSearchCursor,
  readTraceSearchCursorUpperTimeBound,
  resolveDestinationConnection,
  type DestinationTransportExecutor,
} from "@agentscope/destinations-core/core-orchestration";
import type { CanonicalTraceGraph } from "@agentscope/protocol";

import { FIRST_PARTY_HARNESS_IDS } from "../capture/types.js";
import {
  createCredentialResolutionContext,
  readResolvedCredentialForCore,
  resolveCredentialReference,
  type CredentialBackendRegistry,
} from "../configuration/credential-adapter.js";
import {
  readConfigurationForHook,
  type ConfigurationStore,
  type HookConfigurationReadResult,
} from "../configuration/transaction.js";
import {
  serializeAgentscopeConfiguration,
  type AgentscopeConfigurationSnapshot,
  type ConfiguredDestinationConnection,
} from "../configuration/schema.js";
import {
  resolveRedactionPolicy,
  type RedactionPolicyRegistry,
  type ResolvedRedactionPolicy,
} from "../redaction/policy.js";
import {
  governRetrievedTrace,
  governTraceSummary,
  type GovernedTraceSummary,
} from "./governance.js";

export const RETRIEVAL_MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024;
export const RETRIEVAL_MAXIMUM_PROVIDER_REQUESTS = 8;
export const RETRIEVAL_OPERATION_DEADLINE_MILLISECONDS = 2_000;

export type CoreRetrievalFailureCode = RetrieverFailureCode;
export type CoreRetrievalFailure = Readonly<{
  ok: false;
  code: CoreRetrievalFailureCode;
  retryAfterMilliseconds?: number;
}>;

export type CoreTraceSearchPage = Readonly<{
  schemaVersion: 1;
  connectionName: string;
  summaries: readonly GovernedTraceSummary[];
  state: "exhaustive" | "continuation" | "partial";
  partialReason?: "provider-request-limit" | "response-byte-limit" | "deadline";
  nextCursor?: TraceSearchCursor;
  consistency: "snapshot" | "best-effort";
  exactTotal?: number;
}>;

export type CoreRetrievedTrace = Readonly<{
  schemaVersion: 1;
  connectionName: string;
  locator: ReturnType<typeof createTraceLocator>;
  graph: CanonicalTraceGraph;
  consistency: "snapshot" | "best-effort";
  policyIdentity: string;
}>;

export type CoreTraceSearchResult =
  Readonly<{ ok: true; page: CoreTraceSearchPage }> | CoreRetrievalFailure;
export type CoreTraceGetResult =
  Readonly<{ ok: true; trace: CoreRetrievedTrace }> | CoreRetrievalFailure;

export type CoreRetrievalRuntime = Readonly<{
  commandStartedAt: string;
  configuration: AgentscopeConfigurationSnapshot;
  policyRegistry: RedactionPolicyRegistry;
  credentialBackendRegistry: CredentialBackendRegistry;
  transportExecutor: DestinationTransportExecutor;
  deadline: ReporterDeadline;
  signal?: AbortSignal;
}>;

export type CreateCoreRetrievalRuntimeInput = Readonly<{
  configuration: AgentscopeConfigurationSnapshot;
  policyRegistry: RedactionPolicyRegistry;
  credentialBackendRegistry: CredentialBackendRegistry;
  transportExecutor: DestinationTransportExecutor;
  timeoutMilliseconds: number;
  signal?: AbortSignal;
}>;

export const createCoreRetrievalRuntime = (
  input: CreateCoreRetrievalRuntimeInput,
): CoreRetrievalRuntime =>
  Object.freeze({
    commandStartedAt: new Date().toISOString(),
    configuration: input.configuration,
    policyRegistry: input.policyRegistry,
    credentialBackendRegistry: input.credentialBackendRegistry,
    transportExecutor: input.transportExecutor,
    deadline: createReporterDeadline(input.timeoutMilliseconds),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

export type PrepareCoreRetrievalRuntimeInput = Readonly<{
  configurationStore: ConfigurationStore;
  policyRegistry: RedactionPolicyRegistry;
  credentialBackendRegistry: CredentialBackendRegistry;
  transportExecutor: DestinationTransportExecutor;
  signal?: AbortSignal;
}>;

export type CoreRetrievalRuntimePreparation =
  | Readonly<{ ok: true; runtime: CoreRetrievalRuntime }>
  | Readonly<{
      ok: false;
      code:
        | "core.configuration.missing"
        | "core.configuration.invalid"
        | "core.configuration.unsupported"
        | "core.configuration.unavailable"
        | "deadline-exceeded";
    }>;

const failure = (
  code: CoreRetrievalFailureCode,
  retryAfterMilliseconds?: number,
): CoreRetrievalFailure =>
  Object.freeze({
    ok: false,
    code,
    ...(retryAfterMilliseconds === undefined ? {} : { retryAfterMilliseconds }),
  });

const findConnection = (
  configuration: AgentscopeConfigurationSnapshot,
  name: unknown,
): ConfiguredDestinationConnection | undefined => {
  if (
    typeof name !== "string" ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name)
  )
    return undefined;
  return configuration.connections.find(
    (connection) => connection.name === name,
  );
};

const configurationIdentity = (
  configuration: AgentscopeConfigurationSnapshot,
): string =>
  `configuration-v2-sha256-${createHash("sha256")
    .update(serializeAgentscopeConfiguration(configuration))
    .digest("hex")}`;

const readInput = (
  input: unknown,
  required: readonly string[],
  optional: readonly string[],
): PropertyDescriptorMap | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
      !required.every(
        (key) => descriptors[key] && "value" in descriptors[key],
      ) ||
      Object.keys(descriptors).some(
        (key) => !required.includes(key) && !optional.includes(key),
      ) ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor))
    )
      return undefined;
    return descriptors;
  } catch {
    return undefined;
  }
};

const descriptorValue = (
  descriptors: PropertyDescriptorMap,
  key: string,
): unknown => descriptors[key]?.value;

const readRuntime = (input: unknown): CoreRetrievalRuntime | undefined => {
  const descriptors = readInput(
    input,
    [
      "commandStartedAt",
      "configuration",
      "credentialBackendRegistry",
      "deadline",
      "policyRegistry",
      "transportExecutor",
    ],
    ["signal"],
  );
  if (!descriptors) return undefined;
  const signal = descriptorValue(descriptors, "signal") as
    AbortSignal | undefined;
  return Object.freeze({
    commandStartedAt: descriptorValue(
      descriptors,
      "commandStartedAt",
    ) as string,
    configuration: descriptorValue(
      descriptors,
      "configuration",
    ) as AgentscopeConfigurationSnapshot,
    policyRegistry: descriptorValue(
      descriptors,
      "policyRegistry",
    ) as RedactionPolicyRegistry,
    credentialBackendRegistry: descriptorValue(
      descriptors,
      "credentialBackendRegistry",
    ) as CredentialBackendRegistry,
    transportExecutor: descriptorValue(
      descriptors,
      "transportExecutor",
    ) as DestinationTransportExecutor,
    deadline: descriptorValue(descriptors, "deadline") as ReporterDeadline,
    ...(signal === undefined ? {} : { signal }),
  });
};

type ConfigurationSettlement =
  | Readonly<{ kind: "settled"; value: HookConfigurationReadResult }>
  | Readonly<{ kind: "expired" }>;

const readConfigurationWithinRetrievalDeadline = async (
  store: ConfigurationStore,
  deadline: ReporterDeadline,
  signal: AbortSignal | undefined,
): Promise<ConfigurationSettlement> => {
  const remaining = reporterDeadlineRemainingMilliseconds(deadline);
  if (remaining <= 0 || signal?.aborted === true)
    return Object.freeze({ kind: "expired" });
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  const timer = setTimeout(abort, remaining);
  try {
    signal?.addEventListener("abort", abort, { once: true });
  } catch {
    controller.abort();
  }
  if (controller.signal.aborted) {
    clearTimeout(timer);
    try {
      signal?.removeEventListener("abort", abort);
    } catch {
      // Hostile optional cancellation is already represented by expiry.
    }
    return Object.freeze({ kind: "expired" });
  }
  const read = readConfigurationForHook(store, controller.signal);
  const expired = new Promise<ConfigurationSettlement>((resolve) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        resolve(Object.freeze({ kind: "expired" }));
      },
      { once: true },
    );
  });
  const settled = read.then(
    (value): ConfigurationSettlement =>
      Object.freeze({ kind: "settled", value }),
    /* v8 ignore next 8 -- readConfigurationForHook is a total async boundary
       that converts filesystem and parser rejection into a fixed result. */
    (): ConfigurationSettlement =>
      Object.freeze({
        kind: "settled",
        value: Object.freeze({
          ok: false,
          code: "core.configuration.unavailable",
        }),
      }),
  );
  const result = await Promise.race([settled, expired]);
  clearTimeout(timer);
  controller.abort();
  try {
    signal?.removeEventListener("abort", abort);
  } catch {
    // Hostile optional cancellation collapses to the fixed expiry result.
  }
  return result;
};

export const prepareCoreRetrievalRuntime = async (
  input: PrepareCoreRetrievalRuntimeInput,
): Promise<CoreRetrievalRuntimePreparation> => {
  const commandStartedAt = new Date().toISOString();
  const deadline = createReporterDeadline(
    RETRIEVAL_OPERATION_DEADLINE_MILLISECONDS,
  );
  const descriptors = readInput(
    input,
    [
      "configurationStore",
      "credentialBackendRegistry",
      "policyRegistry",
      "transportExecutor",
    ],
    ["signal"],
  );
  if (!descriptors)
    return Object.freeze({
      ok: false,
      code: "core.configuration.unavailable",
    });
  const signal = descriptorValue(descriptors, "signal") as
    AbortSignal | undefined;
  const settlement = await readConfigurationWithinRetrievalDeadline(
    descriptorValue(descriptors, "configurationStore") as ConfigurationStore,
    deadline,
    signal,
  );
  if (settlement.kind === "expired")
    return Object.freeze({ ok: false, code: "deadline-exceeded" });
  if (!settlement.value.ok)
    return Object.freeze({ ok: false, code: settlement.value.code });
  /* v8 ignore next -- the same deadline owns and wins the configuration-read
     race; this is the defensive instruction-edge check after settlement. */
  if (reporterDeadlineRemainingMilliseconds(deadline) <= 0)
    return Object.freeze({ ok: false, code: "deadline-exceeded" });
  return Object.freeze({
    ok: true,
    runtime: Object.freeze({
      commandStartedAt,
      configuration: settlement.value.snapshot,
      credentialBackendRegistry: descriptorValue(
        descriptors,
        "credentialBackendRegistry",
      ) as CredentialBackendRegistry,
      deadline,
      policyRegistry: descriptorValue(
        descriptors,
        "policyRegistry",
      ) as RedactionPolicyRegistry,
      transportExecutor: descriptorValue(
        descriptors,
        "transportExecutor",
      ) as DestinationTransportExecutor,
      ...(signal === undefined ? {} : { signal }),
    }),
  });
};

type CredentialSettlement =
  | Readonly<{
      kind: "resolved";
      credentials: Readonly<Record<string, string>>;
    }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "expired" }>;

const resolveCredentialsWithinDeadline = async (
  descriptor: DestinationDescriptor,
  connection: ConfiguredDestinationConnection,
  credentialBackendRegistry: CredentialBackendRegistry,
  controller: AbortController,
): Promise<CredentialSettlement> => {
  const credentialContext = createCredentialResolutionContext(
    "interactive",
    controller.signal,
  );
  const resolution = Promise.all(
    descriptor.credentialSlots.map(async (slot) => {
      const reference = connection.credentialReferences[slot.id];
      if (!reference) return [slot.id, undefined] as const;
      const resolved = await resolveCredentialReference(
        credentialBackendRegistry,
        reference,
        credentialContext,
      );
      if (!resolved.ok) throw new Error("core.retrieval.unavailable");
      return [
        slot.id,
        readResolvedCredentialForCore(resolved.credential),
      ] as const;
    }),
  ).then(
    (entries): CredentialSettlement =>
      Object.freeze({
        kind: "resolved",
        credentials: Object.freeze(
          Object.fromEntries(entries.filter((entry) => entry[1] !== undefined)),
        ),
      }),
    (): CredentialSettlement => Object.freeze({ kind: "failed" }),
  );
  let resolveExpiration: (() => void) | undefined;
  const expiration = new Promise<CredentialSettlement>((resolve) => {
    resolveExpiration = () => {
      resolve(Object.freeze({ kind: "expired" }));
    };
  });
  /* v8 ignore else -- the Promise executor initializes this synchronously. */
  if (resolveExpiration !== undefined)
    controller.signal.addEventListener("abort", resolveExpiration, {
      once: true,
    });
  const settlement = await Promise.race([resolution, expiration]);
  /* v8 ignore else -- the Promise executor initializes this synchronously. */
  if (resolveExpiration !== undefined)
    controller.signal.removeEventListener("abort", resolveExpiration);
  return settlement;
};

const prepareRetriever = async (
  runtime: CoreRetrievalRuntime,
  destinationName: unknown,
  preflight?: (connection: ConfiguredDestinationConnection) => void,
): Promise<
  | Readonly<{
      ok: true;
      connection: ConfiguredDestinationConnection;
      retriever: Retriever;
      controller: AbortController;
      abort: () => void;
      timer: ReturnType<typeof setTimeout>;
      policy: ResolvedRedactionPolicy;
    }>
  | CoreRetrievalFailure
> => {
  try {
    // The runtime type is public for composition, but only configuration
    // snapshots minted by the configuration parser may select authorities.
    serializeAgentscopeConfiguration(runtime.configuration);
  } catch {
    return failure("invalid-query");
  }
  const connection = findConnection(runtime.configuration, destinationName);
  if (!connection) return failure("unknown-connection");
  const descriptor = getDestinationDescriptor(
    runtime.configuration.destinationRegistry,
    connection.destinationType,
  );
  /* v8 ignore next -- configuration snapshots are compiled with and retain this exact registry. */
  if (!descriptor) return failure("unknown-connection");
  if (descriptor.retrievalSupport !== "search-and-get")
    return failure("retrieval-unsupported");
  try {
    preflight?.(connection);
  } catch {
    return failure("invalid-query");
  }
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  const remaining = reporterDeadlineRemainingMilliseconds(runtime.deadline);
  if (remaining <= 0) return failure("deadline-exceeded");
  const timer = setTimeout(abort, remaining);
  const unavailable = (code: "deadline-exceeded" | "unavailable") => {
    clearTimeout(timer);
    controller.abort();
    try {
      runtime.signal?.removeEventListener("abort", abort);
    } catch {
      // Hostile cancellation input collapses to the fixed failure.
    }
    return failure(code);
  };
  try {
    runtime.signal?.addEventListener("abort", abort, { once: true });
    if (runtime.signal?.aborted === true)
      return unavailable("deadline-exceeded");
    const prepared = resolveDestinationConnection(descriptor, {
      connectionId: connection.connectionId,
      settings: connection.settings,
    });
    const transport = prepared.endpoint
      ? bindDestinationTransport(prepared.endpoint, runtime.transportExecutor)
      : null;
    const credentialSettlement = await resolveCredentialsWithinDeadline(
      descriptor,
      connection,
      runtime.credentialBackendRegistry,
      controller,
    );
    if (credentialSettlement.kind === "expired")
      return unavailable("deadline-exceeded");
    if (credentialSettlement.kind === "failed")
      return unavailable("unavailable");
    /* v8 ignore next -- an abort resolves the competing expiration before credentials. */
    if (controller.signal.aborted) return unavailable("deadline-exceeded");
    const retriever = prepareDestinationRetriever(prepared, {
      credentials: credentialSettlement.credentials,
      transport,
    });
    const policy = resolveRedactionPolicy(
      runtime.policyRegistry,
      runtime.configuration.policyReference,
    );
    return Object.freeze({
      ok: true,
      connection,
      retriever,
      controller,
      abort,
      timer,
      policy,
    });
  } catch {
    /* v8 ignore next 3 -- abort-driven setup settles through expiration before callback failures. */
    return unavailable(
      controller.signal.aborted ? "deadline-exceeded" : "unavailable",
    );
  }
};

const context = (runtime: CoreRetrievalRuntime, signal: AbortSignal) =>
  createRetrievalContext({
    signal,
    deadline: runtime.deadline,
    maximumResponseBytes: RETRIEVAL_MAXIMUM_RESPONSE_BYTES,
    maximumProviderRequests: RETRIEVAL_MAXIMUM_PROVIDER_REQUESTS,
  });

const close = (
  runtime: CoreRetrievalRuntime,
  prepared: Readonly<{
    controller: AbortController;
    abort: () => void;
    timer: ReturnType<typeof setTimeout>;
  }>,
): void => {
  clearTimeout(prepared.timer);
  prepared.controller.abort();
  try {
    runtime.signal?.removeEventListener("abort", prepared.abort);
  } catch {
    // Hostile optional signals are already represented by the fixed outcome.
  }
};

export const searchConfiguredTraces = async (
  runtime: CoreRetrievalRuntime,
  input: Readonly<{
    destinationName: string;
    query: TraceSearchInput;
    cursor?: unknown;
  }>,
): Promise<CoreTraceSearchResult> => {
  const boundedRuntime = readRuntime(runtime);
  if (!boundedRuntime) return failure("invalid-query");
  const descriptors = readInput(
    input,
    ["destinationName", "query"],
    ["cursor"],
  );
  if (!descriptors) return failure("invalid-query");
  let upperTimeBound: string;
  let query: ReturnType<typeof normalizeTraceSearchQuery>;
  try {
    const cursor = descriptorValue(descriptors, "cursor");
    if (cursor !== undefined)
      upperTimeBound = readTraceSearchCursorUpperTimeBound(cursor);
    else upperTimeBound = boundedRuntime.commandStartedAt;
    query = normalizeTraceSearchQuery(
      descriptorValue(descriptors, "query") as TraceSearchInput,
      {
        commandStartedAt: upperTimeBound,
        knownHarnessIds: FIRST_PARTY_HARNESS_IDS,
      },
    );
  } catch {
    return failure("invalid-query");
  }
  let cursorAuthority:
    | Readonly<{
        binding: Parameters<typeof readTraceSearchCursor>[1];
        continuationToken: ReturnType<typeof readTraceSearchCursor> | undefined;
      }>
    | undefined;
  const cursor = descriptorValue(descriptors, "cursor");
  const prepared = await prepareRetriever(
    boundedRuntime,
    descriptorValue(descriptors, "destinationName"),
    (connection) => {
      const binding = Object.freeze({
        connectionId: connection.connectionId,
        destinationType: connection.destinationType,
        configurationIdentity: configurationIdentity(
          boundedRuntime.configuration,
        ),
        queryFingerprint: query.fingerprint,
        upperTimeBound: query.to,
      });
      cursorAuthority = Object.freeze({
        binding,
        continuationToken:
          cursor === undefined
            ? undefined
            : readTraceSearchCursor(cursor, binding),
      });
    },
  );
  if (!prepared.ok) return prepared;
  try {
    /* v8 ignore next -- successful preparation executes its synchronous preflight. */
    if (!cursorAuthority) return failure("invalid-query");
    const request = createTraceSearchRequest(
      query,
      {
        connectionId: prepared.connection.connectionId,
        destinationType: prepared.connection.destinationType,
      },
      cursorAuthority.continuationToken,
    );
    const result = await invokeRetrieverSearch(
      prepared.retriever,
      request,
      context(boundedRuntime, prepared.controller.signal),
    );
    if (!result.ok) return failure(result.code, result.retryAfterMilliseconds);
    try {
      const page = createTraceSearchPage(result.value, cursorAuthority.binding);
      return Object.freeze({
        ok: true,
        page: Object.freeze({
          schemaVersion: 1,
          connectionName: prepared.connection.name,
          summaries: Object.freeze(
            page.summaries.map((summary) =>
              governTraceSummary(summary, prepared.policy),
            ),
          ),
          state: page.state,
          ...(page.partialReason === undefined
            ? {}
            : { partialReason: page.partialReason }),
          ...(page.nextCursor === undefined
            ? {}
            : { nextCursor: page.nextCursor }),
          consistency: page.consistency,
          ...(page.exactTotal === undefined
            ? {}
            : { exactTotal: page.exactTotal }),
        }),
      });
    } catch {
      return failure("malformed-response");
    }
  } /* v8 ignore next 2 -- syntax and cursor authority are closed by the preflight above. */ catch {
    return failure("invalid-query");
  } finally {
    close(boundedRuntime, prepared);
  }
};

export const getConfiguredTrace = async (
  runtime: CoreRetrievalRuntime,
  input: Readonly<{
    destinationName: string;
    traceId: string;
    destinationTraceId?: string;
  }>,
): Promise<CoreTraceGetResult> => {
  const boundedRuntime = readRuntime(runtime);
  if (!boundedRuntime) return failure("invalid-query");
  const descriptors = readInput(
    input,
    ["destinationName", "traceId"],
    ["destinationTraceId"],
  );
  if (!descriptors) return failure("invalid-query");
  let locator: ReturnType<typeof createTraceLocator> | undefined;
  const prepared = await prepareRetriever(
    boundedRuntime,
    descriptorValue(descriptors, "destinationName"),
    (connection) => {
      const destinationTraceId = descriptorValue(
        descriptors,
        "destinationTraceId",
      );
      locator = createTraceLocator({
        connectionId: connection.connectionId,
        destinationType: connection.destinationType,
        traceId: descriptorValue(descriptors, "traceId") as string,
        ...(destinationTraceId === undefined
          ? {}
          : { destinationTraceId: destinationTraceId as string }),
      });
    },
  );
  if (!prepared.ok) return prepared;
  try {
    /* v8 ignore next -- successful preparation executes its synchronous preflight. */
    if (!locator) return failure("invalid-query");
    const request = createTraceGetRequest(locator, {
      connectionId: prepared.connection.connectionId,
      destinationType: prepared.connection.destinationType,
    });
    const result = await invokeRetrieverGet(
      prepared.retriever,
      request,
      context(boundedRuntime, prepared.controller.signal),
    );
    if (!result.ok) return failure(result.code, result.retryAfterMilliseconds);
    const graph = governRetrievedTrace(result.value, prepared.policy);
    return Object.freeze({
      ok: true,
      trace: Object.freeze({
        schemaVersion: 1,
        connectionName: prepared.connection.name,
        locator,
        graph,
        consistency: result.value.consistency,
        policyIdentity: prepared.policy.identity,
      }),
    });
  } catch {
    return failure("incompatible-trace");
  } finally {
    close(boundedRuntime, prepared);
  }
};
