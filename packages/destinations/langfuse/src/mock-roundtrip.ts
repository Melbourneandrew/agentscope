import {
  bindDestinationTransport,
  createReporterDeadline,
  createRetrievalContext,
  createTraceGetRequest,
  createTraceSearchRequest,
  invokeDestinationReporterForTesting,
  invokeRetrieverGet,
  invokeRetrieverSearch,
  normalizeTraceSearchQuery,
  prepareDestinationReporterForTesting,
  prepareDestinationRetriever,
  resolveDestinationConnection,
  type DestinationReporterTestPreparation,
} from "@agentscope/destinations-core/testing";
import {
  createDestinationConnectionId,
  createDestinationTypeId,
  type JsonValue,
  type TraceLocator,
} from "@agentscope/destinations-core";
import { createSanitizedRedactedCanonicalTraceFixture } from "@agentscope/protocol/testing";

import { LANGFUSE_COMPATIBILITY_MANIFEST } from "./compatibility.js";
import { langfuseDestinationDescriptor } from "./reporter/index.js";

const RUN_ID = /^[\da-f]{16}$/u;
const MAXIMUM_VISIBILITY_DELAYS = 8;

export type LangfuseMockRoundTripFailure =
  "get-unavailable" | "report-unavailable" | "search-unavailable";

export type LangfuseMockRoundTripInput = Readonly<{
  runId: string;
  visibilityDelayAttempts?: number;
  failure?: LangfuseMockRoundTripFailure;
}>;

export type LangfuseMockRoundTripResult = Readonly<{
  resultVersion: 1;
  compatibilityManifestId: string;
  runId: string;
  uniqueTag: string;
  outcome: "passed" | "unavailable";
  report: "accepted" | "unavailable";
  search: "matched" | "unavailable";
  get: "matched" | "unavailable";
  canonicalGraphMatch: boolean;
  visibilityAttempts: number;
  providerRequestCount: number;
  networkAuthority: "in-memory-loopback-executor-only";
}>;

type WireAttribute = Readonly<{
  key: string;
  value: Readonly<{
    stringValue?: string;
    arrayValue?: Readonly<{
      values: readonly Readonly<{ stringValue?: string }>[];
    }>;
  }>;
}>;

type WireSpan = Readonly<{
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: readonly WireAttribute[];
}>;

type Observation = Readonly<{
  id: string;
  traceId: string;
  parentObservationId?: string;
  type: "SPAN";
  isRootObservation: false;
  name: string;
  startTime: string;
  endTime: string;
  metadata: Readonly<Record<string, JsonValue>>;
}>;

const exactInput = (input: LangfuseMockRoundTripInput) => {
  if (typeof input !== "object" || input === null)
    throw new Error("destination.langfuse.mock-evidence.invalid");
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    throw new Error("destination.langfuse.mock-evidence.invalid");
  }
  const keys = Object.keys(descriptors).sort();
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    keys.some(
      (key) => !["failure", "runId", "visibilityDelayAttempts"].includes(key),
    ) ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    throw new Error("destination.langfuse.mock-evidence.invalid");
  const runId: unknown = descriptors.runId?.value;
  const visibilityDelayAttempts: unknown =
    descriptors.visibilityDelayAttempts?.value ?? 0;
  const failure: unknown = descriptors.failure?.value;
  if (
    typeof runId !== "string" ||
    !RUN_ID.test(runId) ||
    !Number.isSafeInteger(visibilityDelayAttempts) ||
    (visibilityDelayAttempts as number) < 0 ||
    (visibilityDelayAttempts as number) > MAXIMUM_VISIBILITY_DELAYS ||
    (failure !== undefined &&
      !["get-unavailable", "report-unavailable", "search-unavailable"].includes(
        failure as string,
      ))
  )
    throw new Error("destination.langfuse.mock-evidence.invalid");
  return Object.freeze({
    runId,
    visibilityDelayAttempts: visibilityDelayAttempts as number,
    failure: failure as LangfuseMockRoundTripFailure | undefined,
  });
};

const response = (status: number, value: unknown) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(value)),
  });

const createRetrieverHarness = (
  executor: DestinationReporterTestPreparation["executor"],
) => {
  const connectionId = createDestinationConnectionId(
    `destination-connection-v1-${"e".repeat(64)}`,
  );
  const destinationType = createDestinationTypeId(
    "@agentscope/destination-langfuse",
  );
  const prepared = resolveDestinationConnection(langfuseDestinationDescriptor, {
    connectionId,
    settings: {
      ...langfuseDestinationDescriptor.defaultSettings,
      endpoint: "http://127.0.0.1:4318",
      allowInsecureLoopback: true,
    },
  });
  /* v8 ignore next 2 -- the fixed test endpoint is remote and the exact descriptor cannot resolve it as local. */
  if (prepared.endpoint === null)
    throw new Error("destination.langfuse.mock-evidence.invalid");
  const retriever = prepareDestinationRetriever(prepared, {
    credentials: { "public-key": "pk-fixture", "secret-key": "sk-fixture" },
    transport: bindDestinationTransport(prepared.endpoint, executor),
  });
  const context = () =>
    createRetrievalContext({
      signal: new AbortController().signal,
      deadline: createReporterDeadline(1_000),
      maximumResponseBytes: 1_048_576,
      maximumProviderRequests: 4,
    });
  return Object.freeze({
    search: (tag: string) => {
      const query = normalizeTraceSearchQuery(
        { tags: [tag] },
        {
          commandStartedAt: "2026-12-31T00:00:00.000Z",
          knownHarnessIds: ["fixture-harness"],
          ordering: "start-time-desc-provider",
        },
      );
      return invokeRetrieverSearch(
        retriever,
        createTraceSearchRequest(query, { connectionId, destinationType }),
        context(),
      );
    },
    get: (locator: Parameters<typeof createTraceGetRequest>[0]) =>
      invokeRetrieverGet(
        retriever,
        createTraceGetRequest(locator, { connectionId, destinationType }),
        context(),
      ),
  });
};

const observationFor = (span: WireSpan): Observation =>
  Object.freeze({
    id: span.spanId,
    traceId: span.traceId,
    /* v8 ignore next 3 -- this converter receives only capsule header/carrier spans, whose manifest grammar requires the canonical root parent. */
    ...(span.parentSpanId === undefined
      ? {}
      : { parentObservationId: span.parentSpanId }),
    type: "SPAN" as const,
    isRootObservation: false as const,
    name: span.name,
    startTime: new Date(
      Number(BigInt(span.startTimeUnixNano) / 1_000_000n),
    ).toISOString(),
    endTime: new Date(
      Number(BigInt(span.endTimeUnixNano) / 1_000_000n),
    ).toISOString(),
    metadata: Object.freeze(
      Object.fromEntries(
        /* v8 ignore next -- capsule header/carrier wire spans always carry their closed metadata attributes. */
        (span.attributes ?? [])
          .filter(({ key }) => key.startsWith("langfuse.observation.metadata."))
          .map(({ key, value }) => [
            key.slice("langfuse.observation.metadata.".length),
            /* v8 ignore next 5 -- every closed capsule metadata value is emitted as one stringValue. */
            value.stringValue ??
              value.arrayValue?.values.map(
                (entry) => entry.stringValue ?? "",
              ) ??
              "",
          ]),
      ),
    ),
  });

const evidence = (
  input: ReturnType<typeof exactInput>,
  state: Omit<
    LangfuseMockRoundTripResult,
    | "compatibilityManifestId"
    | "resultVersion"
    | "networkAuthority"
    | "runId"
    | "uniqueTag"
  >,
): LangfuseMockRoundTripResult =>
  Object.freeze({
    resultVersion: 1,
    compatibilityManifestId: LANGFUSE_COMPATIBILITY_MANIFEST.manifestId,
    runId: input.runId,
    uniqueTag: `agentscope-roundtrip-${input.runId}`,
    ...state,
    networkAuthority: "in-memory-loopback-executor-only",
  });

/* eslint-disable max-lines-per-function -- the hermetic evidence runner keeps one causal Reporter-to-Retriever state machine and returns only its sanitized ledger. */
export const executeLangfuseMockRoundTrip = async (
  rawInput: LangfuseMockRoundTripInput,
): Promise<LangfuseMockRoundTripResult> => {
  const input = exactInput(rawInput);
  const uniqueTag = `agentscope-roundtrip-${input.runId}`;
  const trace = createSanitizedRedactedCanonicalTraceFixture({
    sequence: 7,
    tags: [uniqueTag],
  });
  let reportBody: Uint8Array | undefined;
  let providerRequestCount = 0;
  const reporter = prepareDestinationReporterForTesting({
    descriptor: langfuseDestinationDescriptor,
    settings: {
      ...langfuseDestinationDescriptor.defaultSettings,
      endpoint: "http://127.0.0.1:4318",
      allowInsecureLoopback: true,
    },
    credentials: { "public-key": "pk-fixture", "secret-key": "sk-fixture" },
    executor: (request) => {
      providerRequestCount += 1;
      reportBody = request.body;
      return input.failure === "report-unavailable"
        ? response(503, {})
        : response(200, {});
    },
  });
  const report = await invokeDestinationReporterForTesting(reporter, {
    traces: [trace],
  });
  if (report.outcome !== "accepted" || reportBody === undefined)
    return evidence(input, {
      outcome: "unavailable",
      report: "unavailable",
      search: "unavailable",
      get: "unavailable",
      canonicalGraphMatch: false,
      visibilityAttempts: 0,
      providerRequestCount,
    });
  const parsed: unknown = JSON.parse(new TextDecoder().decode(reportBody));
  const resourceSpans = (
    parsed as {
      resourceSpans?: readonly Readonly<{
        scopeSpans?: readonly Readonly<{ spans?: readonly WireSpan[] }>[];
      }>[];
    }
  ).resourceSpans;
  /* v8 ignore next 4 -- an accepted response from the concrete Reporter always retains its emitted resource/scope/span arrays. */
  const spans =
    resourceSpans?.flatMap((resource) =>
      (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
    ) ?? [];
  const headers = spans
    .filter(({ name }) => name === "agentscope.capsule.header.v1")
    .map(observationFor);
  const carriers = spans
    .filter(({ name }) => name === "agentscope.capsule.carrier.v1")
    .map(observationFor);
  /* v8 ignore next -- the concrete Reporter artifact verifier owns the exact one-header/nonempty-carrier invariant. */
  if (headers.length !== 1 || carriers.length === 0)
    return evidence(input, {
      outcome: "unavailable",
      report: "accepted",
      search: "unavailable",
      get: "unavailable",
      canonicalGraphMatch: false,
      visibilityAttempts: 0,
      providerRequestCount,
    });
  let searchAttempts = 0;
  let searchCompleted = false;
  const retriever = createRetrieverHarness((request) => {
    providerRequestCount += 1;
    if (
      (input.failure === "search-unavailable" && !searchCompleted) ||
      (input.failure === "get-unavailable" && searchCompleted)
    )
      return response(503, {});
    /* v8 ignore next -- every Retriever request created here owns exactly one structured filter key. */
    const filter = new URL(request.url).searchParams.get("filter") ?? "";
    if (filter.includes("agentscope.capsule.carrier.v1"))
      return response(200, { data: carriers, meta: {} });
    searchAttempts += searchCompleted ? 0 : 1;
    const visible =
      searchCompleted || searchAttempts > input.visibilityDelayAttempts;
    return response(200, { data: visible ? headers : [], meta: {} });
  });
  let locator: TraceLocator | undefined;
  for (
    let attempt = 0;
    attempt <= input.visibilityDelayAttempts && locator === undefined;
    attempt += 1
  ) {
    const result = await retriever.search(uniqueTag);
    if (!result.ok)
      return evidence(input, {
        outcome: "unavailable",
        report: "accepted",
        search: "unavailable",
        get: "unavailable",
        canonicalGraphMatch: false,
        visibilityAttempts: searchAttempts,
        providerRequestCount,
      });
    if (result.value.summaries.length === 1)
      locator = result.value.summaries[0]!.locator;
  }
  /* v8 ignore next -- the loop admits exactly delay+1 attempts and reveals the header on that final attempt. */
  if (locator === undefined)
    return evidence(input, {
      outcome: "unavailable",
      report: "accepted",
      search: "unavailable",
      get: "unavailable",
      canonicalGraphMatch: false,
      visibilityAttempts: searchAttempts,
      providerRequestCount,
    });
  searchCompleted = true;
  const get = await retriever.get(locator);
  if (!get.ok)
    return evidence(input, {
      outcome: "unavailable",
      report: "accepted",
      search: "matched",
      get: "unavailable",
      canonicalGraphMatch: false,
      visibilityAttempts: searchAttempts,
      providerRequestCount,
    });
  /* v8 ignore next 2 -- the mock returns the exact carrier bytes emitted from this same branded graph. */
  const canonicalGraphMatch =
    get.value.representation.kind === "canonical-graph" &&
    JSON.stringify(get.value.representation.graph) ===
      JSON.stringify(trace.graph);
  /* v8 ignore next 11 -- the graph-mismatch outcome is defensive; both sides derive from the same Reporter request in this hermetic runner. */
  if (!canonicalGraphMatch)
    return evidence(input, {
      outcome: "unavailable",
      report: "accepted",
      search: "matched",
      get: "unavailable",
      canonicalGraphMatch: false,
      visibilityAttempts: searchAttempts,
      providerRequestCount,
    });
  return evidence(input, {
    outcome: "passed",
    report: "accepted",
    search: "matched",
    get: "matched",
    canonicalGraphMatch: true,
    visibilityAttempts: searchAttempts,
    providerRequestCount,
  });
};
/* eslint-enable max-lines-per-function */
