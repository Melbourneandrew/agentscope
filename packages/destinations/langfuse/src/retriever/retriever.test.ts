import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  createDestinationRetriever,
  createDestinationConnectionId,
  createRetrieverFailure,
  createRetrieverSearchPage,
  createDestinationTypeId,
  createTraceLocator,
  RETRIEVER_FAILURE_CODES,
  type DestinationTransportResponse,
  type JsonValue,
  type RetrievalContext,
  type TraceGetRequest,
  type TraceSearchRequest,
} from "@agentscope/destinations-core";
import {
  bindDestinationTransport,
  createRetrieverContractQueryMatrix,
  createRetrieverContractSuite,
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
  RETRIEVER_CONTRACT_FIXTURE_VALUES,
  resolveDestinationConnection,
  type RetrieverTestAdapter,
  type RetrieverTestBehavior,
  type RetrieverTestLedgerEntry,
} from "@agentscope/destinations-core/testing";
import { createSanitizedRedactedCanonicalTraceFixture } from "@agentscope/protocol/testing";

import { langfuseDestinationDescriptor } from "../reporter/index.js";
import {
  createLangfuseRetrieverTestHarness,
  LANGFUSE_SANITIZED_HTTP_FIXTURES,
} from "../testing.js";
import { deriveLangfuseProjectionFilterKey } from "../compatibility.js";
import { deriveLangfuseCapsuleSpanId } from "../reporter/capsule.js";

const response = (body: unknown): DestinationTransportResponse => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify(body)),
});

type WireAttribute = Readonly<{
  key: string;
  value:
    | Readonly<{ stringValue: string }>
    | Readonly<{
        arrayValue: Readonly<{
          values: readonly Readonly<{ stringValue: string }>[];
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

const milliseconds = (nanoseconds: string): string =>
  new Date(Number(BigInt(nanoseconds) / 1_000_000n)).toISOString();

const observationFor = (span: WireSpan) => ({
  id: span.spanId,
  traceId: span.traceId,
  parentObservationId: span.parentSpanId,
  type: "SPAN",
  isRootObservation: false,
  name: span.name,
  startTime: milliseconds(span.startTimeUnixNano),
  endTime: milliseconds(span.endTimeUnixNano),
  metadata: Object.fromEntries(
    (span.attributes ?? [])
      .filter(({ key }) => key.startsWith("langfuse.observation.metadata."))
      .map(({ key, value }) => [
        key.slice("langfuse.observation.metadata.".length),
        "stringValue" in value
          ? value.stringValue
          : value.arrayValue.values.map((entry) => entry.stringValue),
      ]),
  ),
  level: "DEFAULT",
  statusMessage: null,
});

const settings = {
  ...langfuseDestinationDescriptor.defaultSettings,
  endpoint: "http://127.0.0.1:4318",
  allowInsecureLoopback: true,
};
const credentials = {
  "public-key": "pk-fixture",
  "secret-key": "sk-fixture",
};

describe("Langfuse Retriever testing harness", () => {
  const emptyExecutor = (request: { url: string }) =>
    Promise.resolve(
      response({
        data: [],
        meta: request.url.includes("/v2/")
          ? { cursor: null }
          : { page: 1, limit: 50, totalItems: 0, totalPages: 1 },
      }),
    );

  it("owns default search and get orchestration on the testing subpath", async () => {
    const harness = createLangfuseRetrieverTestHarness({
      executor: emptyExecutor,
    });
    await expect(harness.search()).resolves.toMatchObject({
      ok: true,
      value: { summaries: [] },
    });
    await expect(
      harness.get(
        createTraceLocator({
          connectionId: createDestinationConnectionId(
            "destination-connection-v1-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          ),
          destinationType: createDestinationTypeId(
            "@agentscope/destination-langfuse",
          ),
          traceId: "0123456789abcdef0123456789abcdef",
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: "not-found" });
  });

  it("binds explicit profile, query, cursor, and response budgets", async () => {
    const harness = createLangfuseRetrieverTestHarness({
      executor: emptyExecutor,
      profileId: "langfuse-self-hosted-v3-events-3.225.3",
      maximumResponseBytes: 1024,
      maximumProviderRequests: 2,
    });
    await expect(
      harness.search({ limit: 1, tags: ["fixture"] }, 2),
    ).resolves.toMatchObject({ ok: true, value: { summaries: [] } });
  });

  it("replays the sanitized compatibility header and graph capsule end to end", async () => {
    const requestFixture = LANGFUSE_SANITIZED_HTTP_FIXTURES.find(
      ({ fixtureId }) => fixtureId === "otlp-v4-json-root-v1",
    )!;
    const searchFixture = LANGFUSE_SANITIZED_HTTP_FIXTURES.find(
      ({ fixtureId }) => fixtureId === "observations-v2-root-search-v1",
    )!;
    const request = requestFixture.request.body as unknown as {
      resourceSpans: readonly {
        scopeSpans: readonly { spans: readonly WireSpan[] }[];
      }[];
    };
    const carriers = request.resourceSpans
      .flatMap(({ scopeSpans }) => scopeSpans)
      .flatMap(({ spans }) => spans)
      .filter(({ name }) => name === "agentscope.capsule.carrier.v1")
      .map(observationFor);
    const searchBody = searchFixture.response.body as {
      data: readonly Record<string, unknown>[];
    };
    const harness = createLangfuseRetrieverTestHarness({
      executor: (providerRequest) => {
        const filters =
          new URL(providerRequest.url).searchParams.get("filter") ?? "";
        return Promise.resolve(
          response({
            data: filters.includes("agentscope.capsule.carrier.v1")
              ? carriers
              : searchBody.data,
            meta: {},
          }),
        );
      },
    });
    const search = await harness.search();
    expect(search).toMatchObject({ ok: true, value: { summaries: [{}] } });
    if (!search.ok || search.value.summaries[0] === undefined) return;
    await expect(
      harness.get(search.value.summaries[0].locator),
    ).resolves.toMatchObject({
      ok: true,
      value: { representation: { kind: "canonical-graph" } },
    });
  });
});

const reportedRows = async (
  fixture: Parameters<
    typeof createSanitizedRedactedCanonicalTraceFixture
  >[0] = {},
) => {
  let body: Uint8Array | undefined;
  const reporter = prepareDestinationReporterForTesting({
    descriptor: langfuseDestinationDescriptor,
    settings,
    credentials,
    executor: (request) => {
      body = request.body;
      return Promise.resolve(response({}));
    },
  });
  const trace = createSanitizedRedactedCanonicalTraceFixture(fixture);
  await invokeDestinationReporterForTesting(reporter, { traces: [trace] });
  const decoded = JSON.parse(new TextDecoder().decode(body)) as {
    resourceSpans: { scopeSpans: { spans: WireSpan[] }[] }[];
  };
  const spans = decoded.resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) => scope.spans),
  );
  return {
    trace,
    headers: spans
      .filter((span) => span.name === "agentscope.capsule.header.v1")
      .map(observationFor),
    carriers: spans
      .filter((span) => span.name === "agentscope.capsule.carrier.v1")
      .map(observationFor),
  };
};

const retrievalContext = (
  maximumResponseBytes = 1_048_576,
  maximumProviderRequests = 4,
) =>
  createRetrievalContext({
    signal: new AbortController().signal,
    deadline: createReporterDeadline(1_000),
    maximumResponseBytes,
    maximumProviderRequests,
  });

const createHarness = (
  executor: Parameters<typeof bindDestinationTransport>[1],
  profileId:
    | "langfuse-cloud-v4"
    | "langfuse-self-hosted-v3-events-3.225.3" = "langfuse-cloud-v4",
  maximumResponseBytes = 1_048_576,
) => {
  const prepared = resolveDestinationConnection(langfuseDestinationDescriptor, {
    connectionId: createDestinationConnectionId(
      "destination-connection-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    settings: { ...settings, profileId },
  });
  const retriever = prepareDestinationRetriever(prepared, {
    credentials,
    transport: bindDestinationTransport(prepared.endpoint!, executor),
  });
  const search = (
    input: Parameters<typeof normalizeTraceSearchQuery>[0] = {},
    continuationToken?: JsonValue,
  ) => {
    const query = normalizeTraceSearchQuery(input, {
      commandStartedAt: "2026-01-03T00:00:00.000Z",
      knownHarnessIds: ["fixture-harness", "other-harness"],
      ordering: "start-time-desc-provider",
    });
    return invokeRetrieverSearch(
      retriever,
      createTraceSearchRequest(
        query,
        {
          connectionId: prepared.connectionId,
          destinationType: createDestinationTypeId(
            "@agentscope/destination-langfuse",
          ),
        },
        continuationToken,
      ),
      retrievalContext(maximumResponseBytes),
    );
  };
  return { prepared, retriever, search };
};

const replaceGraph = (
  values: Awaited<ReturnType<typeof reportedRows>>,
  graphJson: string,
) => {
  const bytes = new TextEncoder().encode(graphJson);
  const encoded = Buffer.from(bytes).toString("base64url");
  const chunks = Array.from(
    { length: Math.ceil(encoded.length / 180) },
    (_, index) => encoded.slice(index * 180, (index + 1) * 180),
  );
  const header = {
    ...values.headers[0]!,
    metadata: {
      ...values.headers[0]!.metadata,
      agentscope_capsule_graph_bytes: String(bytes.byteLength),
      agentscope_capsule_graph_sha256: createHash("sha256")
        .update(bytes)
        .digest("hex"),
      agentscope_capsule_chunk_count: String(chunks.length),
      agentscope_capsule_carrier_count: "1",
    },
  };
  const carrier = {
    ...values.carriers[0]!,
    metadata: {
      ...values.carriers[0]!.metadata,
      agentscope_capsule_graph_sha256:
        header.metadata.agentscope_capsule_graph_sha256,
      agentscope_capsule_chunks: chunks,
    },
  };
  return { headers: [header], carriers: [carrier] };
};

const retrieveRows = async (
  headers: readonly Record<string, unknown>[],
  carriers: readonly Record<string, unknown>[],
  options: Readonly<{
    headerMeta?: Record<string, unknown>;
    carrierMeta?: Record<string, unknown>;
  }> = {},
) => {
  const harness = createHarness((request) => {
    const filters = new URL(request.url).searchParams.get("filter") ?? "";
    return Promise.resolve(
      response({
        data: filters.includes("agentscope.capsule.carrier.v1")
          ? carriers
          : headers,
        meta: filters.includes("agentscope.capsule.carrier.v1")
          ? (options.carrierMeta ?? {})
          : (options.headerMeta ?? {}),
      }),
    );
  });
  const search = await harness.search();
  if (!search.ok || search.value.summaries[0] === undefined) return search;
  const locator = search.value.summaries[0].locator;
  return invokeRetrieverGet(
    harness.retriever,
    createTraceGetRequest(locator, {
      connectionId: harness.prepared.connectionId,
      destinationType: createDestinationTypeId(
        "@agentscope/destination-langfuse",
      ),
    }),
    retrievalContext(),
  );
};

const retrieveExactRows = async (
  headers: readonly Record<string, unknown>[],
  carriers: readonly Record<string, unknown>[],
) => {
  const harness = createHarness((request) => {
    const filters = new URL(request.url).searchParams.get("filter") ?? "";
    return Promise.resolve(
      response({
        data: filters.includes("agentscope.capsule.carrier.v1")
          ? carriers
          : headers,
        meta: {},
      }),
    );
  });
  const nonce = (headers[0] as { metadata?: Record<string, unknown> }).metadata
    ?.agentscope_capsule_nonce;
  return invokeRetrieverGet(
    harness.retriever,
    createTraceGetRequest(
      createTraceLocator({
        connectionId: harness.prepared.connectionId,
        destinationType: createDestinationTypeId(
          "@agentscope/destination-langfuse",
        ),
        traceId: (headers[0] as { traceId: string }).traceId,
        destinationRevision: nonce as string,
      }),
      {
        connectionId: harness.prepared.connectionId,
        destinationType: createDestinationTypeId(
          "@agentscope/destination-langfuse",
        ),
      },
    ),
    retrievalContext(),
  );
};

// eslint-disable-next-line max-lines-per-function -- this destination-level suite keeps the complete request/response/capsule adversarial matrix under one reviewed boundary.
describe("Langfuse Retriever round trip", () => {
  // eslint-disable-next-line max-lines-per-function -- one causal oracle binds the actual Reporter request to provider predicates, search, and exact get.
  it("searches the actual header request and reconstructs the selected graph", async () => {
    let reportBody: Uint8Array | undefined;
    const reporter = prepareDestinationReporterForTesting({
      descriptor: langfuseDestinationDescriptor,
      settings,
      credentials,
      executor: (request) => {
        reportBody = request.body;
        return Promise.resolve(response({}));
      },
    });
    const trace = createSanitizedRedactedCanonicalTraceFixture();
    await expect(
      invokeDestinationReporterForTesting(reporter, { traces: [trace] }),
    ).resolves.toEqual({ outcome: "accepted" });
    expect(reportBody).toBeDefined();
    const request = JSON.parse(new TextDecoder().decode(reportBody)) as {
      resourceSpans: {
        scopeSpans: { spans: WireSpan[] }[];
      }[];
    };
    const rows = request.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    );
    const headers = rows
      .filter((span) => span.name === "agentscope.capsule.header.v1")
      .map(observationFor);
    const carriers = rows
      .filter((span) => span.name === "agentscope.capsule.carrier.v1")
      .map(observationFor);
    expect(headers).toHaveLength(1);
    expect(carriers.length).toBeGreaterThan(0);

    const prepared = resolveDestinationConnection(
      langfuseDestinationDescriptor,
      {
        connectionId: createDestinationConnectionId(
          "destination-connection-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ),
        settings,
      },
    );
    expect(prepared.endpoint).not.toBeNull();
    const requestedUrls: string[] = [];
    const transport = bindDestinationTransport(
      prepared.endpoint!,
      (providerRequest) => {
        requestedUrls.push(providerRequest.url);
        const filters = new URL(providerRequest.url).searchParams.get("filter");
        return Promise.resolve(
          response({
            data: filters?.includes("agentscope.capsule.carrier.v1")
              ? carriers
              : headers,
            meta: {},
          }),
        );
      },
    );
    const retriever = prepareDestinationRetriever(prepared, {
      credentials,
      transport,
    });
    const query = normalizeTraceSearchQuery(
      { harness: "fixture-harness" },
      {
        commandStartedAt: "2026-01-03T00:00:00.000Z",
        knownHarnessIds: ["fixture-harness"],
        ordering: "start-time-desc-provider",
      },
    );
    const searchRequest = createTraceSearchRequest(query, {
      connectionId: prepared.connectionId,
      destinationType: createDestinationTypeId(
        "@agentscope/destination-langfuse",
      ),
    });
    const context = createRetrievalContext({
      signal: new AbortController().signal,
      deadline: createReporterDeadline(1_000),
      maximumResponseBytes: 1_048_576,
      maximumProviderRequests: 4,
    });
    const search = await invokeRetrieverSearch(
      retriever,
      searchRequest,
      context,
    );
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    expect(search.value.summaries).toHaveLength(1);
    expect(search.value.summaries[0]!.locator.destinationRevision).toMatch(
      /^[\da-f]{32}$/u,
    );
    const locator = search.value.summaries[0]!.locator;
    const get = await invokeRetrieverGet(
      retriever,
      createTraceGetRequest(locator, {
        connectionId: prepared.connectionId,
        destinationType: createDestinationTypeId(
          "@agentscope/destination-langfuse",
        ),
      }),
      createRetrievalContext({
        signal: new AbortController().signal,
        deadline: createReporterDeadline(1_000),
        maximumResponseBytes: 1_048_576,
        maximumProviderRequests: 4,
      }),
    );
    expect(get.ok).toBe(true);
    if (!get.ok) return;
    expect(get.value.representation).toEqual({
      kind: "canonical-graph",
      graph: trace.graph,
    });
    expect(requestedUrls).toHaveLength(3);
    const carrierFilters = JSON.parse(
      new URL(requestedUrls[2]!).searchParams.get("filter") ?? "[]",
    ) as { key?: string; value?: string }[];
    const digest = headers[0]!.metadata
      .agentscope_capsule_graph_sha256 as string;
    expect(carrierFilters).toContainEqual(
      expect.objectContaining({
        key: "agentscope_capsule_graph_sha256",
        value: digest,
      }),
    );
    expect(
      carriers.every(
        ({ metadata }) => metadata.agentscope_capsule_graph_sha256 === digest,
      ),
    ).toBe(true);
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate-limited"],
    [500, "unavailable"],
    [400, "malformed-response"],
  ] as const)("maps provider status %i to %s", async (status, code) => {
    const harness = createHarness(() =>
      Promise.resolve({ status, headers: {}, body: new Uint8Array() }),
    );
    await expect(harness.search()).resolves.toMatchObject({ ok: false, code });
  });

  it.each([
    ["12", 12_000],
    ["0", 0],
    ["3600", 3_600_000],
  ] as const)("maps bounded Retry-After %s", async (value, milliseconds) => {
    const harness = createHarness(() =>
      Promise.resolve({
        status: 429,
        headers: { "retry-after": value },
        body: new Uint8Array(),
      }),
    );
    await expect(harness.search()).resolves.toMatchObject({
      ok: false,
      code: "rate-limited",
      retryAfterMilliseconds: milliseconds,
    });
  });

  it.each(["3601", "01", "date"])(
    "ignores unsupported Retry-After %s",
    async (value) => {
      const harness = createHarness(() =>
        Promise.resolve({
          status: 429,
          headers: { "retry-after": value },
          body: new Uint8Array(),
        }),
      );
      await expect(harness.search()).resolves.toEqual(
        expect.objectContaining({
          ok: false,
          code: "rate-limited",
        }),
      );
      const result = await harness.search();
      expect(result).not.toHaveProperty("retryAfterMilliseconds");
    },
  );

  it.each([
    new Uint8Array([0xff]),
    new TextEncoder().encode("{"),
    new TextEncoder().encode('"text"'),
    new TextEncoder().encode("true"),
    new TextEncoder().encode(" true false"),
    new TextEncoder().encode("x"),
    new TextEncoder().encode('{"a":"\\n"}'),
    new TextEncoder().encode('{"a":"\\u0062"}'),
    new TextEncoder().encode('{"a":"unterminated}'),
    new TextEncoder().encode('{"a":"\u0001"}'),
    new TextEncoder().encode('{"a" 1}'),
    new TextEncoder().encode('{"a":1;}'),
    new TextEncoder().encode('{"a":1,1:2}'),
    new TextEncoder().encode("[1;]"),
    new TextEncoder().encode(`${"[".repeat(66)}0${"]".repeat(66)}`),
    new TextEncoder().encode(JSON.stringify([])),
    new TextEncoder().encode(JSON.stringify({})),
    new TextEncoder().encode(JSON.stringify({ data: null, meta: {} })),
    new TextEncoder().encode(JSON.stringify({ data: [], meta: "bad" })),
    new TextEncoder().encode(JSON.stringify({ data: [], meta: { cursor: 1 } })),
    new TextEncoder().encode(
      JSON.stringify({ data: [], meta: { cursor: "" } }),
    ),
    new TextEncoder().encode(
      JSON.stringify({ data: [], meta: { cursor: "x".repeat(8_193) } }),
    ),
    new TextEncoder().encode(
      JSON.stringify({
        data: Array.from({ length: 1_001 }, () => ({})),
        meta: {},
      }),
    ),
    new TextEncoder().encode(JSON.stringify({ data: [null], meta: {} })),
    new TextEncoder().encode(
      JSON.stringify({
        data: [
          {
            id: "id",
            traceId: "trace",
            name: "name",
            startTime: "time",
            metadata: {},
          },
        ],
        meta: {},
      }),
    ),
    new TextEncoder().encode(
      JSON.stringify({
        data: [
          {
            id: "id",
            traceId: "trace",
            name: "name",
            startTime: "time",
            metadata: Object.fromEntries(
              Array.from({ length: 201 }, (_, index) => [`key-${index}`, "x"]),
            ),
          },
        ],
        meta: {},
      }),
    ),
    ...(["id", "traceId", "name", "startTime"] as const).map((missing) =>
      new TextEncoder().encode(
        JSON.stringify({
          data: [
            {
              id: "id",
              traceId: "trace",
              name: "name",
              startTime: "time",
              metadata: {},
              [missing]: undefined,
            },
          ],
          meta: {},
        }),
      ),
    ),
    new TextEncoder().encode(
      JSON.stringify({
        data: [
          {
            id: "id",
            traceId: "trace",
            name: "name",
            startTime: "time",
            endTime: 1,
            metadata: {},
          },
        ],
        meta: {},
      }),
    ),
  ])("fails malformed provider DTOs closed", async (body) => {
    const harness = createHarness(() =>
      Promise.resolve({
        status: 200,
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    await expect(harness.search()).resolves.toMatchObject({
      ok: false,
      code: "malformed-response",
    });
  });

  it.each([
    undefined,
    "text/plain",
    "application/json; charset=utf-16",
    "application/json; charset=utf-8; charset=utf-8",
  ])(
    "requires one semantic JSON response media type: %s",
    async (contentType) => {
      const harness = createHarness(() =>
        Promise.resolve({
          status: 200,
          headers:
            contentType === undefined ? {} : { "content-type": contentType },
          body: new TextEncoder().encode(
            JSON.stringify({ data: [], meta: {} }),
          ),
        }),
      );
      await expect(harness.search()).resolves.toMatchObject({
        ok: false,
        code: "malformed-response",
      });
    },
  );

  it.each([
    "application/json",
    "Application/JSON; Charset=UTF-8",
    'application/json; charset="utf-8"',
  ])("accepts semantic JSON response media type: %s", async (contentType) => {
    const harness = createHarness(() =>
      Promise.resolve({
        ...response({ data: [], meta: {} }),
        headers: { "content-type": contentType },
      }),
    );
    await expect(harness.search()).resolves.toMatchObject({ ok: true });
  });

  it("serializes every portable predicate once and supports both continuation grammars", async () => {
    const urls: string[] = [];
    const executor = (
      request: Parameters<Parameters<typeof createHarness>[0]>[0],
    ) => {
      urls.push(request.url);
      return Promise.resolve(response({ data: [], meta: {} }));
    };
    const v2 = createHarness(executor);
    await v2.search(
      {
        traceId: "0123456789abcdef0123456789abcdef",
        from: "2026-01-01T00:00:00.000Z",
        harness: "fixture-harness",
        branch: "main",
        model: "model-fixture",
        sessionId: "session-fixture",
        tags: ["safe-tag"],
      },
      "cursor-fixture",
    );
    const v1 = createHarness(
      executor,
      "langfuse-self-hosted-v3-events-3.225.3",
    );
    await v1.search(
      {
        harness: "fixture-harness",
        sessionId: "session-fixture",
        limit: 1,
      },
      2,
    );
    const v2Url = new URL(urls[0]!);
    const v1Url = new URL(urls[1]!);
    expect(v2Url.searchParams.get("cursor")).toBe("cursor-fixture");
    expect(v2Url.searchParams.getAll("filter")).toHaveLength(1);
    expect(v2Url.searchParams.get("filter")).toContain("sessionId");
    expect(v2Url.searchParams.get("filter")).toContain(
      deriveLangfuseProjectionFilterKey("model", "model-fixture"),
    );
    expect(v2Url.searchParams.get("filter")).toContain(
      deriveLangfuseProjectionFilterKey("tag", "safe-tag"),
    );
    expect(v2Url.searchParams.get("filter")).not.toContain("traceTags");
    expect(v1Url.searchParams.get("page")).toBe("2");
    expect(v1Url.searchParams.get("useEventsTable")).toBe("true");
    expect(v1Url.searchParams.get("filter")).toContain("agentscope_session");
    await expect(v1.search({}, "wrong-token")).resolves.toMatchObject({
      ok: false,
      code: "invalid-query",
    });
    await expect(v2.search({}, 2)).resolves.toMatchObject({
      ok: false,
      code: "invalid-query",
    });
    await expect(v1.search({ limit: 1 })).resolves.toMatchObject({
      ok: true,
      value: { state: "exhaustive" },
    });
    await expect(
      v2.search({
        tags: Array.from(
          { length: 32 },
          (_, index) => `tag-${index}-${"x".repeat(180)}`,
        ),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(
      new TextEncoder().encode(urls.at(-1) ?? "").byteLength,
    ).toBeGreaterThan(2_048);
  });

  it.each([
    { traceId: "f".repeat(32) },
    { from: "2026-01-02T03:04:05.001Z" },
    { to: "1970-01-01T00:00:00.500Z" },
    { harness: "other-harness" },
    { branch: "other" },
    { model: "other-model" },
    { sessionId: "other-session" },
    { tags: ["other-tag"] },
  ])("rejects a provider false-positive for %j", async (query) => {
    const values = await reportedRows();
    const harness = createHarness(() =>
      Promise.resolve(response({ data: values.headers, meta: {} })),
    );
    await expect(harness.search(query)).resolves.toMatchObject({
      ok: false,
      code: "malformed-response",
    });
  });

  // eslint-disable-next-line max-lines-per-function -- the closed-header oracle exercises every field family plus duplicate/conflict semantics together.
  it("rejects malformed and conflicting headers before selection", async () => {
    const values = await reportedRows();
    const valid = values.headers[0]!;
    const cases = [
      { ...valid, name: "wrong" },
      { ...valid, id: "0000000000000000" },
      { ...valid, parentObservationId: "0".repeat(16) },
      { ...valid, type: "GENERATION" },
      { ...valid, isRootObservation: true },
      {
        ...valid,
        metadata: { ...valid.metadata, agentscope_capsule_nonce: "bad" },
      },
      {
        ...valid,
        metadata: {
          ...valid.metadata,
          agentscope_capsule_graph_bytes: "bad",
        },
      },
      {
        ...valid,
        id: deriveLangfuseCapsuleSpanId(
          valid.traceId,
          "0".repeat(32),
          "header",
          0,
        ),
        metadata: {
          ...valid.metadata,
          agentscope_capsule_nonce: "0".repeat(32),
        },
      },
      {
        ...valid,
        metadata: { ...valid.metadata, agentscope_status: "future" },
      },
      {
        ...valid,
        metadata: { ...valid.metadata, agentscope_root: "false" },
      },
      {
        ...valid,
        metadata: { ...valid.metadata, agentscope_unknown: "value" },
      },
      {
        ...valid,
        metadata: { ...valid.metadata, provider_unknown: "value" },
      },
    ];
    for (const row of cases) {
      const harness = createHarness(() =>
        Promise.resolve(response({ data: [row], meta: {} })),
      );
      await expect(harness.search()).resolves.toMatchObject({
        ok: false,
        code: "malformed-response",
      });
    }
    const conflicting = {
      ...valid,
      metadata: { ...valid.metadata, agentscope_status: "error" },
    };
    const harness = createHarness(() =>
      Promise.resolve(response({ data: [valid, conflicting], meta: {} })),
    );
    await expect(harness.search()).resolves.toMatchObject({
      ok: false,
      code: "malformed-response",
    });
    const identical = createHarness(() =>
      Promise.resolve(response({ data: [valid, valid], meta: {} })),
    );
    await expect(identical.search()).resolves.toMatchObject({
      ok: true,
      value: { summaries: [expect.anything()] },
    });
    const missingCount = {
      ...valid,
      metadata: { ...valid.metadata, agentscope_models_count: "bad" },
    };
    const missingIndex = {
      ...valid,
      metadata: { ...valid.metadata, agentscope_model_00: undefined },
    };
    const invalidTagCount = {
      ...valid,
      metadata: { ...valid.metadata, agentscope_tags_count: "bad" },
    };
    const duplicateIndexedModel = {
      ...valid,
      metadata: {
        ...valid.metadata,
        agentscope_models_count: "2",
        agentscope_model_01: valid.metadata.agentscope_model_00,
      },
    };
    for (const row of [
      missingCount,
      missingIndex,
      invalidTagCount,
      duplicateIndexedModel,
      { ...valid, startTime: "bad" },
      { ...valid, startTime: "bad", endTime: "bad" },
      { ...valid, endTime: undefined },
    ]) {
      const invalid = createHarness(() =>
        Promise.resolve(response({ data: [row], meta: {} })),
      );
      await expect(invalid.search()).resolves.toMatchObject({
        ok: false,
        code: "malformed-response",
      });
    }
    const optional = {
      ...valid,
      metadata: {
        ...valid.metadata,
        agentscope_harness: undefined,
        agentscope_branch: undefined,
        agentscope_repository: undefined,
      },
    };
    const withoutOptional = createHarness(() =>
      Promise.resolve(response({ data: [optional], meta: {} })),
    );
    await expect(withoutOptional.search()).resolves.toMatchObject({ ok: true });
    const withoutRootMarker = createHarness(() =>
      Promise.resolve(
        response({
          data: [{ ...valid, isRootObservation: undefined }],
          meta: {},
        }),
      ),
    );
    await expect(withoutRootMarker.search()).resolves.toMatchObject({
      ok: true,
    });
    const withTag = createHarness(() =>
      Promise.resolve(
        response({
          data: [
            {
              ...valid,
              metadata: {
                ...valid.metadata,
                agentscope_tags_count: "1",
                agentscope_tag_00: "tag-fixture",
                [deriveLangfuseProjectionFilterKey("tag", "tag-fixture")]:
                  "tag-fixture",
              },
            },
          ],
          meta: {},
        }),
      ),
    );
    await expect(withTag.search()).resolves.toMatchObject({ ok: true });
  });

  it("validates the complete header and capsule formulas for exact get", async () => {
    const values = await reportedRows();
    const status = {
      ...values.headers[0]!,
      metadata: {
        ...values.headers[0]!.metadata,
        agentscope_status: "future",
      },
    };
    await expect(
      retrieveExactRows([status], values.carriers),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
    const formula = {
      ...values.headers[0]!,
      metadata: {
        ...values.headers[0]!.metadata,
        agentscope_capsule_carrier_count: "2",
      },
    };
    await expect(
      retrieveExactRows([formula], values.carriers),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
    const wrongParent = {
      ...values.headers[0]!,
      parentObservationId: "f".repeat(16),
    };
    const wrongParentCarriers = values.carriers.map((row) => ({
      ...row,
      parentObservationId: "f".repeat(16),
    }));
    await expect(
      retrieveExactRows([wrongParent], wrongParentCarriers),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
  });

  it("rejects duplicate JSON object keys before provider DTO reconstruction", async () => {
    const values = await reportedRows();
    const nonce = values.headers[0]!.metadata
      .agentscope_capsule_nonce as string;
    const serialized = JSON.stringify({ data: values.headers, meta: {} });
    const duplicated = serialized.replace(
      `"agentscope_capsule_nonce":"${nonce}"`,
      `"agentscope_capsule_nonce":"${"0".repeat(32)}","agentscope_capsule_nonce":"${nonce}"`,
    );
    const harness = createHarness(() =>
      Promise.resolve({
        status: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(duplicated),
      }),
    );
    await expect(harness.search()).resolves.toMatchObject({
      ok: false,
      code: "malformed-response",
    });
  });

  it("rejects a noncanonical chunk boundary with identical graph bytes", async () => {
    const values = await reportedRows();
    const lastCarrier = values.carriers.at(-1)!;
    const original = lastCarrier.metadata.agentscope_capsule_chunks as string[];
    expect(original.length).toBeGreaterThan(1);
    const penultimate = original.at(-2)!;
    const final = original.at(-1)!;
    const changed = [
      ...original.slice(0, -2),
      penultimate.slice(0, -1),
      `${penultimate.at(-1)}${final}`,
    ];
    const carriers = [
      ...values.carriers.slice(0, -1),
      {
        ...lastCarrier,
        metadata: {
          ...lastCarrier.metadata,
          agentscope_capsule_chunks: changed,
        },
      },
    ];
    await expect(
      retrieveExactRows(values.headers, carriers),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
  });

  it("fails selected header and carrier incompleteness without fallback", async () => {
    const values = await reportedRows();
    await expect(
      retrieveRows(values.headers, values.carriers, {
        headerMeta: { cursor: "more-headers" },
      }),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
    await expect(retrieveRows(values.headers, [], {})).resolves.toMatchObject({
      ok: false,
      code: "malformed-response",
    });
    await expect(
      retrieveRows(values.headers, values.carriers, {
        carrierMeta: { cursor: "more-carriers" },
      }),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
  });

  it.each([
    (row: Record<string, unknown>) => ({ ...row, name: "wrong" }),
    (row: Record<string, unknown>) => ({ ...row, id: "0000000000000000" }),
    (row: Record<string, unknown>) => ({
      ...row,
      metadata: {
        ...(row.metadata as Record<string, unknown>),
        agentscope_capsule_nonce: "0".repeat(32),
      },
    }),
    (row: Record<string, unknown>) => ({
      ...row,
      metadata: {
        ...(row.metadata as Record<string, unknown>),
        agentscope_capsule_carrier_index: "99",
      },
    }),
    (row: Record<string, unknown>) => ({
      ...row,
      metadata: {
        ...(row.metadata as Record<string, unknown>),
        agentscope_capsule_chunks: [],
      },
    }),
    (row: Record<string, unknown>) => ({
      ...row,
      traceId: "1123456789abcdef0123456789abcdef",
    }),
    (row: Record<string, unknown>) => ({
      ...row,
      metadata: {
        ...(row.metadata as Record<string, unknown>),
        agentscope_capsule_version: "2",
      },
    }),
  ])("rejects malformed selected carrier rows", async (mutate) => {
    const values = await reportedRows();
    const malformed = values.carriers.map((row, index) =>
      index === 0 ? mutate(row) : row,
    );
    await expect(
      retrieveRows(values.headers, malformed),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
  });

  it("collapses only identical duplicate carrier rows", async () => {
    const values = await reportedRows();
    await expect(
      retrieveRows(values.headers, [...values.carriers, values.carriers[0]!]),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      retrieveRows(values.headers, [
        ...values.carriers,
        {
          ...values.carriers[0]!,
          metadata: {
            ...values.carriers[0]!.metadata,
            agentscope_capsule_chunks: (
              values.carriers[0]!.metadata.agentscope_capsule_chunks as string[]
            ).map((chunk, index) =>
              index === 0
                ? `${chunk[0] === "A" ? "B" : "A"}${chunk.slice(1)}`
                : chunk,
            ),
          },
        },
      ]),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
    await expect(
      retrieveRows(values.headers, [
        {
          ...values.carriers[0]!,
          metadata: {
            ...values.carriers[0]!.metadata,
            provider_unknown: "value",
          },
        },
        ...values.carriers.slice(1),
      ]),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
  });

  it("rejects missing headers and corrupted graph integrity", async () => {
    const values = await reportedRows();
    const empty = createHarness(() =>
      Promise.resolve(response({ data: [], meta: {} })),
    );
    await expect(empty.search()).resolves.toMatchObject({
      ok: true,
      value: { summaries: [] },
    });
    const corrupted = values.carriers.map((row, index) =>
      index === 0
        ? {
            ...row,
            metadata: {
              ...row.metadata,
              agentscope_capsule_chunks: (
                row.metadata.agentscope_capsule_chunks as string[]
              ).map((chunk, chunkIndex) =>
                chunkIndex === 0
                  ? `${chunk[0] === "A" ? "B" : "A"}${chunk.slice(1)}`
                  : chunk,
              ),
            },
          }
        : row,
    );
    await expect(
      retrieveRows(values.headers, corrupted),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
  });

  it("distinguishes malformed graph bytes from incompatible current graphs", async () => {
    const values = await reportedRows();
    const malformed = replaceGraph(values, '{"resourceSpans":[]}');
    await expect(
      retrieveRows(malformed.headers, malformed.carriers),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });

    const encoded = Buffer.from(
      (values.carriers[0]!.metadata.agentscope_capsule_chunks as string[]).join(
        "",
      ),
      "base64url",
    ).toString("utf8");
    const graph = JSON.parse(encoded) as {
      resourceSpans: {
        scopeSpans: {
          spans: { attributes?: Record<string, unknown>[] }[];
        }[];
      }[];
    };
    const root = graph.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    root.attributes = [
      ...(root.attributes ?? []),
      { key: "agentscope.unsupported", value: { stringValue: "value" } },
    ];
    const incompatible = replaceGraph(values, JSON.stringify(graph));
    await expect(
      retrieveRows(incompatible.headers, incompatible.carriers),
    ).resolves.toMatchObject({ ok: false, code: "incompatible-trace" });

    const differentTrace = JSON.parse(encoded) as {
      resourceSpans: { scopeSpans: { spans: { traceId: string }[] }[] }[];
    };
    for (const resource of differentTrace.resourceSpans)
      for (const scope of resource.scopeSpans)
        for (const span of scope.spans)
          span.traceId = "1123456789abcdef0123456789abcdef";
    const mismatched = replaceGraph(values, JSON.stringify(differentTrace));
    await expect(
      retrieveRows(mismatched.headers, mismatched.carriers),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
  });

  it("bounds response bytes and maps a provider failure during carrier fetch", async () => {
    const values = await reportedRows();
    const bounded = createHarness(
      () => Promise.resolve(response({ data: values.headers, meta: {} })),
      "langfuse-cloud-v4",
      10,
    );
    await expect(bounded.search()).resolves.toMatchObject({
      ok: false,
      code: "malformed-response",
    });
    let calls = 0;
    const harness = createHarness(() => {
      calls += 1;
      if (calls <= 2)
        return Promise.resolve(response({ data: values.headers, meta: {} }));
      return Promise.resolve({
        status: 500,
        headers: {},
        body: new Uint8Array(),
      });
    });
    const search = await harness.search();
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    await expect(
      invokeRetrieverGet(
        harness.retriever,
        createTraceGetRequest(search.value.summaries[0]!.locator, {
          connectionId: harness.prepared.connectionId,
          destinationType: createDestinationTypeId(
            "@agentscope/destination-langfuse",
          ),
        }),
        retrievalContext(),
      ),
    ).resolves.toMatchObject({ ok: false, code: "unavailable" });

    const boundedRequests = createHarness(() =>
      Promise.resolve(response({ data: values.headers, meta: {} })),
    );
    const searchAgain = await boundedRequests.search();
    expect(searchAgain.ok).toBe(true);
    if (!searchAgain.ok) return;
    await expect(
      invokeRetrieverGet(
        boundedRequests.retriever,
        createTraceGetRequest(searchAgain.value.summaries[0]!.locator, {
          connectionId: boundedRequests.prepared.connectionId,
          destinationType: createDestinationTypeId(
            "@agentscope/destination-langfuse",
          ),
        }),
        retrievalContext(1_048_576, 1),
      ),
    ).resolves.toMatchObject({ ok: false, code: "unavailable" });
  });

  it("enforces one aggregate get response-byte budget", async () => {
    const values = await reportedRows();
    const headerResponse = response({ data: values.headers, meta: {} });
    const carrierResponse = response({ data: values.carriers, meta: {} });
    const harness = createHarness((request) =>
      Promise.resolve(
        new URL(request.url).searchParams
          .get("filter")
          ?.includes("agentscope.capsule.carrier.v1")
          ? carrierResponse
          : headerResponse,
      ),
    );
    const search = await harness.search();
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    await expect(
      invokeRetrieverGet(
        harness.retriever,
        createTraceGetRequest(search.value.summaries[0]!.locator, {
          connectionId: harness.prepared.connectionId,
          destinationType: createDestinationTypeId(
            "@agentscope/destination-langfuse",
          ),
        }),
        retrievalContext(
          headerResponse.body.byteLength + carrierResponse.body.byteLength - 1,
        ),
      ),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
  });

  it("supports v1 get and conservative full-page continuation", async () => {
    const values = await reportedRows();
    const urls: string[] = [];
    const harness = createHarness((request) => {
      urls.push(request.url);
      const filters = new URL(request.url).searchParams.get("filter") ?? "";
      return Promise.resolve(
        response({
          data: filters.includes("agentscope.capsule.carrier.v1")
            ? values.carriers
            : values.headers,
          meta: {},
        }),
      );
    }, "langfuse-self-hosted-v3-events-3.225.3");
    const search = await harness.search({ limit: 1 });
    expect(search).toMatchObject({
      ok: true,
      value: { state: "continuation", continuationToken: 2 },
    });
    if (!search.ok) return;
    const get = await invokeRetrieverGet(
      harness.retriever,
      createTraceGetRequest(search.value.summaries[0]!.locator, {
        connectionId: harness.prepared.connectionId,
        destinationType: createDestinationTypeId(
          "@agentscope/destination-langfuse",
        ),
      }),
      retrievalContext(),
    );
    expect(get.ok).toBe(true);
    expect(
      urls
        .slice(1)
        .every(
          (url) => new URL(url).searchParams.get("useEventsTable") === "true",
        ),
    ).toBe(true);
    await expect(harness.search({ limit: 1 }, 2)).resolves.toMatchObject({
      ok: true,
      value: { state: "continuation", continuationToken: 3 },
    });

    const incompleteGet = createHarness(
      () =>
        Promise.resolve(
          response({
            data: Array.from({ length: 100 }, () => values.headers[0]),
            meta: {},
          }),
        ),
      "langfuse-self-hosted-v3-events-3.225.3",
    );
    const locator = createTraceLocator({
      connectionId: incompleteGet.prepared.connectionId,
      destinationType: createDestinationTypeId(
        "@agentscope/destination-langfuse",
      ),
      traceId: values.headers[0]!.traceId,
      destinationTraceId: "native-trace-fixture",
    });
    await expect(
      invokeRetrieverGet(
        incompleteGet.retriever,
        createTraceGetRequest(locator, {
          connectionId: incompleteGet.prepared.connectionId,
          destinationType: createDestinationTypeId(
            "@agentscope/destination-langfuse",
          ),
        }),
        retrievalContext(),
      ),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
  });

  it("uses TraceId-only selection and returns not-found when no current header exists", async () => {
    const values = await reportedRows();
    let available = true;
    const harness = createHarness((request) => {
      const filter = new URL(request.url).searchParams.get("filter") ?? "";
      return Promise.resolve(
        response({
          data: available
            ? filter.includes("agentscope.capsule.carrier.v1")
              ? values.carriers
              : values.headers
            : [],
          meta: {},
        }),
      );
    });
    const locator = createTraceLocator({
      connectionId: harness.prepared.connectionId,
      destinationType: createDestinationTypeId(
        "@agentscope/destination-langfuse",
      ),
      traceId: values.headers[0]!.traceId,
      destinationTraceId: "native-trace-fixture",
    });
    const selected = await invokeRetrieverGet(
      harness.retriever,
      createTraceGetRequest(locator, {
        connectionId: harness.prepared.connectionId,
        destinationType: createDestinationTypeId(
          "@agentscope/destination-langfuse",
        ),
      }),
      retrievalContext(),
    );
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.value.locator.destinationRevision).toMatch(
      /^[\da-f]{32}$/u,
    );
    expect(selected.value.locator.destinationTraceId).toBe(
      "native-trace-fixture",
    );
    const plainLocator = createTraceLocator({
      connectionId: harness.prepared.connectionId,
      destinationType: createDestinationTypeId(
        "@agentscope/destination-langfuse",
      ),
      traceId: values.headers[0]!.traceId,
    });
    await expect(
      invokeRetrieverGet(
        harness.retriever,
        createTraceGetRequest(plainLocator, {
          connectionId: harness.prepared.connectionId,
          destinationType: createDestinationTypeId(
            "@agentscope/destination-langfuse",
          ),
        }),
        retrievalContext(),
      ),
    ).resolves.toMatchObject({ ok: true });
    available = false;
    await expect(
      invokeRetrieverGet(
        harness.retriever,
        createTraceGetRequest(locator, {
          connectionId: harness.prepared.connectionId,
          destinationType: createDestinationTypeId(
            "@agentscope/destination-langfuse",
          ),
        }),
        retrievalContext(),
      ),
    ).resolves.toMatchObject({ ok: false, code: "not-found" });
  });

  it("deduplicates one TraceId only after validating distinct current revisions", async () => {
    const first = await reportedRows();
    const second = await reportedRows();
    const harness = createHarness(() =>
      Promise.resolve(
        response({ data: [first.headers[0], second.headers[0]], meta: {} }),
      ),
    );
    await expect(harness.search()).resolves.toMatchObject({
      ok: true,
      value: { summaries: [expect.anything()] },
    });
  });

  it("fails a header that becomes malformed between search and get", async () => {
    const values = await reportedRows();
    let calls = 0;
    const harness = createHarness(() => {
      calls += 1;
      return Promise.resolve(
        response({
          data:
            calls === 1
              ? values.headers
              : [{ ...values.headers[0]!, name: "malformed" }],
          meta: {},
        }),
      );
    });
    const search = await harness.search();
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    await expect(
      invokeRetrieverGet(
        harness.retriever,
        createTraceGetRequest(search.value.summaries[0]!.locator, {
          connectionId: harness.prepared.connectionId,
          destinationType: createDestinationTypeId(
            "@agentscope/destination-langfuse",
          ),
        }),
        retrievalContext(),
      ),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
  });

  it("rejects provider rows that violate an exact get locator", async () => {
    const values = await reportedRows();
    const harness = createHarness(() =>
      Promise.resolve(response({ data: values.headers, meta: {} })),
    );
    const wrongTrace = createTraceLocator({
      connectionId: harness.prepared.connectionId,
      destinationType: createDestinationTypeId(
        "@agentscope/destination-langfuse",
      ),
      traceId: "1123456789abcdef0123456789abcdef",
      destinationRevision: String(
        values.headers[0]!.metadata.agentscope_capsule_nonce,
      ),
    });
    await expect(
      invokeRetrieverGet(
        harness.retriever,
        createTraceGetRequest(wrongTrace, {
          connectionId: harness.prepared.connectionId,
          destinationType: createDestinationTypeId(
            "@agentscope/destination-langfuse",
          ),
        }),
        retrievalContext(),
      ),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
    const wrongRevision = createTraceLocator({
      ...wrongTrace,
      traceId: values.headers[0]!.traceId,
      destinationRevision: "f".repeat(32),
    });
    await expect(
      invokeRetrieverGet(
        harness.retriever,
        createTraceGetRequest(wrongRevision, {
          connectionId: harness.prepared.connectionId,
          destinationType: createDestinationTypeId(
            "@agentscope/destination-langfuse",
          ),
        }),
        retrievalContext(),
      ),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
  });

  it.each([
    "CANARY-INVALID-REVISION",
    "F".repeat(32),
    "g".repeat(32),
    "f".repeat(31),
    "0".repeat(32),
  ])(
    "rejects an invalid destination revision before provider I/O: %s",
    async (revision) => {
      let calls = 0;
      const harness = createHarness(() => {
        calls += 1;
        return Promise.resolve(response({ data: [], meta: {} }));
      });
      const locator = createTraceLocator({
        connectionId: harness.prepared.connectionId,
        destinationType: createDestinationTypeId(
          "@agentscope/destination-langfuse",
        ),
        traceId: "0123456789abcdef0123456789abcdef",
        destinationRevision: revision,
      });
      await expect(
        invokeRetrieverGet(
          harness.retriever,
          createTraceGetRequest(locator, {
            connectionId: harness.prepared.connectionId,
            destinationType: createDestinationTypeId(
              "@agentscope/destination-langfuse",
            ),
          }),
          retrievalContext(),
        ),
      ).resolves.toMatchObject({ ok: false, code: "invalid-query" });
      expect(calls).toBe(0);
    },
  );

  it("maps a provider failure while refreshing the selected header", async () => {
    const values = await reportedRows();
    let calls = 0;
    const harness = createHarness(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(response({ data: values.headers, meta: {} }))
        : Promise.resolve({
            status: 500,
            headers: {},
            body: new Uint8Array(),
          });
    });
    const search = await harness.search();
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    await expect(
      invokeRetrieverGet(
        harness.retriever,
        createTraceGetRequest(search.value.summaries[0]!.locator, {
          connectionId: harness.prepared.connectionId,
          destinationType: createDestinationTypeId(
            "@agentscope/destination-langfuse",
          ),
        }),
        retrievalContext(),
      ),
    ).resolves.toMatchObject({ ok: false, code: "unavailable" });
  });

  it("rejects a non-dense chunk ledger before decoding", async () => {
    const values = await reportedRows();
    const header = {
      ...values.headers[0]!,
      metadata: {
        ...values.headers[0]!.metadata,
        agentscope_capsule_chunk_count: "999",
      },
    };
    await expect(
      retrieveRows([header], values.carriers),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
  });

  // eslint-disable-next-line max-lines-per-function -- the shared adapter must retain one actual request ledger and all behavior variants in one lexical authority.
  it("passes the shared Retriever contract through actual Langfuse requests", async () => {
    const primary = await reportedRows({
      sequence: 0,
      sessionId: RETRIEVER_CONTRACT_FIXTURE_VALUES.sessionId,
      tags: RETRIEVER_CONTRACT_FIXTURE_VALUES.matchingTags,
      modelName: RETRIEVER_CONTRACT_FIXTURE_VALUES.model,
    });
    const secondary = await reportedRows({
      sequence: 1,
      sessionId: RETRIEVER_CONTRACT_FIXTURE_VALUES.secondarySessionId,
      tags: RETRIEVER_CONTRACT_FIXTURE_VALUES.secondaryTags,
      modelName: RETRIEVER_CONTRACT_FIXTURE_VALUES.secondaryModel,
    });
    const primaryHeader = {
      ...primary.headers[0]!,
      startTime: RETRIEVER_CONTRACT_FIXTURE_VALUES.primaryStartTime,
      endTime: RETRIEVER_CONTRACT_FIXTURE_VALUES.primaryStartTime,
      metadata: {
        ...primary.headers[0]!.metadata,
        agentscope_harness: RETRIEVER_CONTRACT_FIXTURE_VALUES.harness,
        agentscope_branch: RETRIEVER_CONTRACT_FIXTURE_VALUES.branch,
      },
    };
    const secondaryHeader = {
      ...secondary.headers[0]!,
      startTime: RETRIEVER_CONTRACT_FIXTURE_VALUES.secondaryStartTime,
      endTime: RETRIEVER_CONTRACT_FIXTURE_VALUES.secondaryStartTime,
      metadata: {
        ...secondary.headers[0]!.metadata,
        agentscope_harness: RETRIEVER_CONTRACT_FIXTURE_VALUES.harness,
        agentscope_branch: RETRIEVER_CONTRACT_FIXTURE_VALUES.secondaryBranch,
      },
    };
    const primaryCarriers = primary.carriers.map((row) => ({
      ...row,
      startTime: RETRIEVER_CONTRACT_FIXTURE_VALUES.primaryStartTime,
      endTime: RETRIEVER_CONTRACT_FIXTURE_VALUES.primaryStartTime,
    }));
    const connectionId = createDestinationConnectionId(
      "destination-connection-v1-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    );
    const destinationType = createDestinationTypeId(
      "@agentscope/destination-langfuse",
    );
    const queryCases = createRetrieverContractQueryMatrix({
      primaryTraceId: primaryHeader.traceId,
      secondaryTraceId: secondaryHeader.traceId,
      ordering: "start-time-desc-provider",
    });
    let active:
      | Readonly<{
          operation: "search";
          request: TraceSearchRequest;
          context: RetrievalContext;
          queryCase: (typeof queryCases)[number];
        }>
      | Readonly<{
          operation: "get";
          request: TraceGetRequest;
          context: RetrievalContext;
        }>
      | undefined;
    let recorded = false;
    let ledger: RetrieverTestLedgerEntry[] = [];
    const prepared = resolveDestinationConnection(
      langfuseDestinationDescriptor,
      {
        connectionId,
        settings,
      },
    );
    const actual = prepareDestinationRetriever(prepared, {
      credentials,
      transport: bindDestinationTransport(prepared.endpoint!, (request) => {
        if (active === undefined) throw new Error("missing active request");
        if (!recorded) {
          recorded = true;
          ledger.push(
            Object.freeze({
              operation: active.operation,
              maximumProviderRequests: active.context.maximumProviderRequests,
              connectionId,
              destinationType,
              ...(active.operation === "search"
                ? {
                    queryFingerprint: active.request.query.fingerprint,
                    hasContinuationToken:
                      active.request.continuationToken !== undefined,
                  }
                : { traceId: active.request.locator.traceId }),
            }),
          );
        }
        const requestFilter =
          new URL(request.url).searchParams.get("filter") ?? "";
        if (requestFilter.includes("agentscope.capsule.carrier.v1"))
          return Promise.resolve(response({ data: primaryCarriers, meta: {} }));
        if (active.operation === "get")
          return Promise.resolve(
            response({
              data:
                active.request.locator.traceId === primaryHeader.traceId
                  ? [primaryHeader]
                  : [],
              meta: {},
            }),
          );
        const rows = active.queryCase.expectedTraceIds.map((traceId) =>
          traceId === primaryHeader.traceId ? primaryHeader : secondaryHeader,
        );
        return Promise.resolve(
          response({
            data: rows,
            meta:
              active.queryCase.expectedContinuationToken === undefined
                ? {}
                : { cursor: "contract-offset-1" },
          }),
        );
      }),
    });
    const failureRetriever = (behavior: RetrieverTestBehavior) =>
      createDestinationRetriever({
        search: () => {
          if (typeof behavior === "object")
            return Promise.resolve(createRetrieverFailure(behavior.failure));
          if (behavior === "throw") throw new Error("test throw");
          if (behavior === "reject")
            return Promise.reject(new Error("test reject"));
          if (behavior === "hang") return new Promise(() => undefined);
          return Promise.resolve(
            Object.freeze({ ok: true, value: {} }) as never,
          );
        },
        get: () => {
          if (typeof behavior === "object")
            return Promise.resolve(createRetrieverFailure(behavior.failure));
          if (behavior === "throw") throw new Error("test throw");
          if (behavior === "reject")
            return Promise.reject(new Error("test reject"));
          if (behavior === "hang") return new Promise(() => undefined);
          return Promise.resolve(
            Object.freeze({ ok: true, value: {} }) as never,
          );
        },
      });
    const adapter: RetrieverTestAdapter = Object.freeze({
      createRetriever: (behavior) => {
        if (behavior !== "success") return failureRetriever(behavior);
        return createDestinationRetriever({
          search: async (request, context) => {
            const queryCase = queryCases.find(
              (candidate) =>
                candidate.query.fingerprint === request.query.fingerprint &&
                JSON.stringify(candidate.continuationToken ?? null) ===
                  JSON.stringify(request.continuationToken ?? null),
            )!;
            active = { operation: "search", request, context, queryCase };
            recorded = false;
            const translated = createTraceSearchRequest(
              request.query,
              { connectionId, destinationType },
              request.continuationToken === undefined
                ? undefined
                : "contract-offset-1",
            );
            const result = await invokeRetrieverSearch(
              actual,
              translated,
              context,
            );
            if (!result.ok) return result;
            return {
              ok: true,
              value: createRetrieverSearchPage({
                summaries: result.value.summaries,
                state: queryCase.expectedState,
                ...(queryCase.expectedContinuationToken === undefined
                  ? {}
                  : { continuationToken: queryCase.expectedContinuationToken }),
                ...(queryCase.expectedState === "partial"
                  ? { partialReason: "provider-request-limit" as const }
                  : {}),
                consistency: "best-effort",
                ordering: "start-time-desc-provider",
              }),
            };
          },
          get: async (request, context) => {
            active = { operation: "get", request, context };
            recorded = false;
            return invokeRetrieverGet(actual, request, context);
          },
        });
      },
      readRetrievalLedger: () => Object.freeze([...ledger]),
      reset: () => {
        active = undefined;
        recorded = false;
        ledger = [];
      },
    });
    const locator = createTraceLocator({
      connectionId,
      destinationType,
      traceId: primaryHeader.traceId,
      destinationRevision: String(
        primary.headers[0]!.metadata.agentscope_capsule_nonce,
      ),
    });
    const cases = createRetrieverContractSuite({
      adapter,
      queryCases,
      locator,
      connectionId,
      destinationType,
      configurationIdentity: "langfuse-contract-v1",
    });
    expect(RETRIEVER_FAILURE_CODES.length).toBeGreaterThan(0);
    for (const contractCase of cases) await contractCase.run();
  });
});
