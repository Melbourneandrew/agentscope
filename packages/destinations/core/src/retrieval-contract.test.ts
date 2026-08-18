import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { standardsManifest } from "@agentscope/protocol";
import { createSanitizedCanonicalTraceFixture } from "@agentscope/protocol/testing";

import { createReporterDeadline } from "./deadline.js";
import {
  createDestinationConnectionId,
  createDestinationTypeId,
} from "./identity.js";
import {
  createTraceSearchCursor,
  readTraceSearchCursor,
  readTraceSearchCursorUpperTimeBound,
  TraceCursorError,
} from "./retrieval-cursor.js";
import {
  createTraceSearchPage,
  isTraceSearchPage,
  TraceSearchPageError,
} from "./retrieval-page.js";
import {
  createTraceLocator,
  isTraceLocator,
  RetrievalIdentityError,
} from "./retrieval-identity.js";
import {
  normalizeTraceSearchQuery,
  TraceQueryError,
} from "./retrieval-query.js";
import {
  createRetrievedTrace,
  createRetrieverSearchPage,
  createTraceSummary,
  RetrievalResultError,
} from "./retrieval-results.js";
import {
  createDestinationRetriever,
  createRetrievalContext,
  createRetrieverFailure,
  createRetrieverSuccess,
  createTraceGetRequest,
  createTraceSearchRequest,
  invokeRetrieverGet,
  invokeRetrieverSearch,
  RetrieverContractError,
} from "./retriever.js";

const connectionId = createDestinationConnectionId(
  "destination-connection-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const destinationType = createDestinationTypeId(
  "@agentscope/destination-local-sqlite",
);
const traceId = "0123456789abcdef0123456789abcdef";
const graph: unknown = createSanitizedCanonicalTraceFixture();

const locator = () =>
  createTraceLocator({
    connectionId,
    destinationType,
    traceId,
    destinationTraceId: "native-trace-1",
  });

const query = () =>
  normalizeTraceSearchQuery(
    {
      traceId,
      from: "2026-01-01T00:00:00-08:00",
      harness: "codex",
      branch: "main",
      model: "gpt-5",
      sessionId: "session-1",
      tags: ["safe", "important"],
      limit: 25,
    },
    {
      commandStartedAt: "2026-01-02T00:00:00Z",
      knownHarnessIds: ["codex", "claude-code"],
    },
  );

const context = (timeout = 1_000, signal = new AbortController().signal) =>
  createRetrievalContext({
    signal,
    deadline: createReporterDeadline(timeout),
    maximumResponseBytes: 1_000_000,
    maximumProviderRequests: 4,
  });

const summary = (overrides: Record<string, unknown> = {}) =>
  createTraceSummary({
    locator: locator(),
    startTime: "2026-01-01T10:00:00.000Z",
    endTime: "2026-01-01T10:00:01.000Z",
    harness: "codex",
    branch: "main",
    repositoryIdentity: "repo-safe-id",
    models: ["gpt-5"],
    status: "ok",
    spanCount: 3,
    tags: ["safe"],
    ...overrides,
  } as never);

const rewriteCursor = (
  cursor: string,
  mutate: (value: Record<string, unknown>) => void,
): string => {
  const [, payload] = cursor.split(".");
  const value = JSON.parse(
    Buffer.from(payload!, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  mutate(value);
  const nextPayload = Buffer.from(JSON.stringify(value), "utf8").toString(
    "base64url",
  );
  const digest = createHash("sha256")
    .update(`agentscope-cursor-v1\0${nextPayload}`)
    .digest("base64url");
  return `agentscope-cursor-v1.${nextPayload}.${digest}`;
};

describe("portable retrieval identity and query", () => {
  it("constructs a destination-qualified trace locator", () => {
    const value = locator();
    expect(isTraceLocator(value)).toBe(true);
    expect(Object.isFrozen(value)).toBe(true);
    expect(value).toMatchObject({ connectionId, destinationType, traceId });
    for (const invalid of [
      { ...value, traceId: "0".repeat(32) },
      { ...value, traceId: traceId.toUpperCase() },
      { ...value, destinationTraceId: "bad\nvalue" },
      { ...value, extra: true },
    ]) {
      expect(() => createTraceLocator(invalid as never)).toThrowError(
        RetrievalIdentityError,
      );
    }
  });

  it("normalizes every filter and binds one deterministic fingerprint", () => {
    const value = query();
    expect(value).toMatchObject({
      from: "2026-01-01T08:00:00.000Z",
      to: "2026-01-02T00:00:00.000Z",
      tags: ["important", "safe"],
      ordering: "start-time-desc-trace-id-asc",
    });
    expect(value.fingerprint).toMatch(/^sha256-[\da-f]{64}$/u);
    expect(query().fingerprint).toBe(value.fingerprint);
    expect(
      normalizeTraceSearchQuery(
        {},
        {
          commandStartedAt: "2026-01-02T00:00:00Z",
          knownHarnessIds: ["codex"],
        },
      ),
    ).toMatchObject({ limit: 50, tags: [] });
    for (const invalid of [
      { from: "2026-01-02T00:00:00Z", to: "2026-01-01T00:00:00Z" },
      { harness: "unknown" },
      { tags: ["same", "same"] },
      { tags: new Array(33).fill("tag") },
      { limit: 0 },
      { limit: 201 },
      { traceId: "not-a-trace" },
      { extra: true },
    ]) {
      expect(() =>
        normalizeTraceSearchQuery(invalid, {
          commandStartedAt: "2026-01-02T00:00:00Z",
          knownHarnessIds: ["codex"],
        }),
      ).toThrowError(TraceQueryError);
    }
  });
});

describe("hostile retrieval identity and query inputs", () => {
  it("rejects accessors, missing fields, excessive text, and hostile arrays", () => {
    const accessor = { connectionId, destinationType, traceId };
    Object.defineProperty(accessor, "traceId", { get: () => traceId });
    const symbolLocator = { connectionId, destinationType, traceId };
    Object.defineProperty(symbolLocator, Symbol("extra"), { value: true });
    for (const invalid of [
      null,
      accessor,
      symbolLocator,
      { connectionId, destinationType },
      {
        connectionId,
        destinationType,
        traceId,
        destinationTraceId: "x".repeat(1_025),
      },
    ]) {
      expect(() => createTraceLocator(invalid as never)).toThrowError(
        RetrievalIdentityError,
      );
    }

    const sparse = new Array(2);
    sparse[0] = "one";
    const tagged = ["one"];
    Object.defineProperty(tagged, "extra", { value: true });
    const known = ["codex"];
    Object.defineProperty(known, Symbol.iterator, {
      value: () => [][Symbol.iterator](),
    });
    for (const invalid of [
      { from: "2026-02-30T00:00:00Z" },
      { from: "2026-01-01T24:00:00Z" },
      { from: "2026-01-01T00:00:00+24:00" },
      { branch: "bad\nbranch" },
      { tags: sparse },
      { tags: tagged },
    ]) {
      expect(() =>
        normalizeTraceSearchQuery(invalid, {
          commandStartedAt: "2026-03-01T00:00:00Z",
          knownHarnessIds: ["codex"],
        }),
      ).toThrowError(TraceQueryError);
    }
    expect(() =>
      normalizeTraceSearchQuery(
        {},
        {
          commandStartedAt: "2026-03-01T00:00:00Z",
          knownHarnessIds: known,
        },
      ),
    ).toThrowError(TraceQueryError);
    expect(() =>
      normalizeTraceSearchQuery(
        {},
        {
          commandStartedAt: "2026-03-01T00:00:00Z",
          knownHarnessIds: ["codex", "codex"],
        },
      ),
    ).toThrowError(TraceQueryError);

    const queryAccessor = { branch: "main" };
    Object.defineProperty(queryAccessor, "branch", { get: () => "main" });
    const symbolQuery = {};
    Object.defineProperty(symbolQuery, Symbol("extra"), { value: true });
    const harnessAccessor = ["codex"];
    Object.defineProperty(harnessAccessor, "0", { get: () => "codex" });
    for (const [input, normalization] of [
      [
        queryAccessor,
        {
          commandStartedAt: "2026-03-01T00:00:00Z",
          knownHarnessIds: ["codex"],
        },
      ],
      [
        symbolQuery,
        {
          commandStartedAt: "2026-03-01T00:00:00Z",
          knownHarnessIds: ["codex"],
        },
      ],
      [{}, { commandStartedAt: 1, knownHarnessIds: ["codex"] }],
      [
        {},
        {
          commandStartedAt: "2026-03-01T00:00:00Z",
          knownHarnessIds: harnessAccessor,
        },
      ],
    ] as const) {
      expect(() =>
        normalizeTraceSearchQuery(input, normalization as never),
      ).toThrowError(TraceQueryError);
    }
  });
});

describe("hostile query normalization authority", () => {
  it("rejects malformed normalization authorities", () => {
    for (const normalization of [
      null,
      {},
      {
        commandStartedAt: "invalid",
        knownHarnessIds: ["codex"],
      },
      {
        commandStartedAt: "2026-01-01T00:00:00Z",
        knownHarnessIds: [],
      },
      {
        commandStartedAt: "2026-01-01T00:00:00Z",
        knownHarnessIds: ["bad\nid"],
      },
    ]) {
      expect(() =>
        normalizeTraceSearchQuery({}, normalization as never),
      ).toThrowError(TraceQueryError);
    }
  });
});

describe("bound opaque retrieval cursor", () => {
  it("round-trips a provider token only under the exact binding", () => {
    const normalized = query();
    const binding = {
      connectionId,
      destinationType,
      configurationIdentity: "config-v1-safe",
      queryFingerprint: normalized.fingerprint,
      upperTimeBound: normalized.to,
    };
    const cursor = createTraceSearchCursor(binding, {
      offset: 25,
      key: "opaque",
    });
    expect(cursor).not.toContain("opaque");
    expect(readTraceSearchCursor(cursor, binding)).toEqual({
      key: "opaque",
      offset: 25,
    });
    expect(readTraceSearchCursorUpperTimeBound(cursor)).toBe(normalized.to);
    expect(() =>
      readTraceSearchCursorUpperTimeBound(`${cursor}=`),
    ).toThrowError(TraceCursorError);
    expect(() =>
      readTraceSearchCursorUpperTimeBound(
        rewriteCursor(cursor, (value) => {
          value.upperTimeBound = "not-a-time";
        }),
      ),
    ).toThrowError(TraceCursorError);
    for (const changed of [
      { ...binding, configurationIdentity: "config-v2" },
      {
        ...binding,
        connectionId: createDestinationConnectionId(
          "destination-connection-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ),
      },
      {
        ...binding,
        queryFingerprint: normalizeTraceSearchQuery(
          {},
          {
            commandStartedAt: normalized.to,
            knownHarnessIds: ["codex"],
          },
        ).fingerprint,
      },
    ]) {
      expect(() => readTraceSearchCursor(cursor, changed)).toThrowError(
        TraceCursorError,
      );
    }
    expect(() =>
      readTraceSearchCursor(`${cursor.slice(0, -1)}x`, binding),
    ).toThrowError(TraceCursorError);

    const portable = createTraceSearchPage(
      createRetrieverSearchPage({
        summaries: [],
        state: "continuation",
        continuationToken: { offset: 25 },
        consistency: "snapshot",
      }),
      binding,
    );
    expect(isTraceSearchPage(portable)).toBe(true);
    expect(portable.nextCursor).toMatch(/^agentscope-cursor-v1\./u);
    expect(
      createTraceSearchPage(
        createRetrieverSearchPage({
          summaries: [],
          state: "partial",
          partialReason: "deadline",
          consistency: "best-effort",
        }),
        binding,
      ),
    ).toMatchObject({ partialReason: "deadline" });
    expect(isTraceSearchPage({ ...portable })).toBe(false);
    expect(() => createTraceSearchPage({} as never, binding)).toThrowError(
      TraceSearchPageError,
    );
    expect(() =>
      createTraceSearchPage(
        createRetrieverSearchPage({
          summaries: [],
          state: "exhaustive",
          consistency: "snapshot",
        }),
        { ...binding, upperTimeBound: "2026-01-01" },
      ),
    ).toThrowError(TraceSearchPageError);
    const otherConnection = createDestinationConnectionId(
      "destination-connection-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(() =>
      createTraceSearchPage(
        createRetrieverSearchPage({
          summaries: [
            summary({
              locator: createTraceLocator({
                connectionId: otherConnection,
                destinationType,
                traceId,
              }),
            }),
          ],
          state: "exhaustive",
          consistency: "snapshot",
        }),
        binding,
      ),
    ).toThrowError(TraceSearchPageError);
  });
});

describe("hostile cursor envelopes", () => {
  it("rejects malformed bindings, oversized tokens, and canonical drift", () => {
    const normalized = query();
    const binding = {
      connectionId,
      destinationType,
      configurationIdentity: "config-v1-safe",
      queryFingerprint: normalized.fingerprint,
      upperTimeBound: normalized.to,
    };
    for (const invalid of [
      null,
      { ...binding, extra: true },
      { ...binding, configurationIdentity: "bad\nidentity" },
      { ...binding, queryFingerprint: "sha256-invalid" },
      { ...binding, upperTimeBound: "not-time" },
    ]) {
      expect(() =>
        createTraceSearchCursor(invalid as never, null),
      ).toThrowError(TraceCursorError);
    }
    expect(() =>
      createTraceSearchCursor(binding, { value: "x".repeat(40_000) }),
    ).toThrowError(TraceCursorError);
    const accessorBinding = { ...binding };
    Object.defineProperty(accessorBinding, "connectionId", {
      get: () => connectionId,
    });
    expect(() => createTraceSearchCursor(accessorBinding, null)).toThrowError(
      TraceCursorError,
    );
    const symbolBinding = { ...binding };
    Object.defineProperty(symbolBinding, Symbol("extra"), { value: true });
    expect(() => createTraceSearchCursor(symbolBinding, null)).toThrowError(
      TraceCursorError,
    );
    expect(() =>
      createTraceSearchCursor(binding, ["x".repeat(8_000), "y".repeat(8_000)]),
    ).toThrowError(TraceCursorError);

    const cursor = createTraceSearchCursor(binding, { offset: 1 });
    for (const invalid of [
      null,
      "",
      "wrong-prefix.payload.digest",
      `${cursor}.extra`,
      `${cursor}!`,
      `${cursor}=`,
      "x".repeat(16_385),
      rewriteCursor(cursor, (value) => {
        value.version = 2;
      }),
      rewriteCursor(cursor, (value) => {
        value.extra = true;
      }),
    ]) {
      expect(() => readTraceSearchCursor(invalid, binding)).toThrowError(
        TraceCursorError,
      );
    }
  });
});

describe("portable retrieval results", () => {
  it("validates summary ordering, deduplication, and partial metadata", () => {
    const first = summary();
    const second = summary({
      locator: createTraceLocator({
        connectionId,
        destinationType,
        traceId: "1123456789abcdef0123456789abcdef",
      }),
      startTime: "2026-01-01T09:00:00.000Z",
    });
    const page = createRetrieverSearchPage({
      summaries: [first, second],
      state: "partial",
      partialReason: "provider-request-limit",
      continuationToken: { offset: 2 },
      consistency: "best-effort",
    });
    expect(Object.isFrozen(page)).toBe(true);
    expect(
      createTraceSummary({
        locator: locator(),
        startTime: "2026-01-01T10:00:00.000Z",
        models: [],
        status: "unset",
        spanCount: 1,
        tags: [],
      }),
    ).not.toHaveProperty("endTime");
    const exhaustive = createRetrieverSearchPage({
      summaries: [first],
      state: "exhaustive",
      consistency: "snapshot",
      exactTotal: 1,
    });
    expect(
      createTraceSearchPage(exhaustive, {
        connectionId,
        destinationType,
        configurationIdentity: "config-v1-safe",
        queryFingerprint: query().fingerprint,
        upperTimeBound: query().to,
      }),
    ).toMatchObject({ exactTotal: 1, state: "exhaustive" });
    for (const invalid of [
      {
        summaries: [second, first],
        state: "exhaustive",
        consistency: "snapshot",
      },
      {
        summaries: [first, first],
        state: "exhaustive",
        consistency: "snapshot",
      },
      { summaries: [], state: "continuation", consistency: "snapshot" },
      { summaries: [], state: "partial", consistency: "snapshot" },
      {
        summaries: [],
        state: "exhaustive",
        consistency: "best-effort",
        exactTotal: 0,
      },
      {
        summaries: [],
        state: "exhaustive",
        consistency: "snapshot",
        continuationToken: 1,
      },
      {
        summaries: [],
        state: "continuation",
        consistency: "snapshot",
        continuationToken: 1,
        partialReason: "deadline",
      },
    ]) {
      expect(() => createRetrieverSearchPage(invalid as never)).toThrowError(
        RetrievalResultError,
      );
    }
  });

  it("returns a fresh unbranded canonical candidate bound to its locator", () => {
    const retrieved = createRetrievedTrace({
      locator: locator(),
      representation: { kind: "canonical-graph", graph },
      consistency: "snapshot",
    });
    expect(retrieved.representation.kind).toBe("canonical-graph");
    expect(Object.isFrozen(retrieved)).toBe(true);
    expect(() =>
      createRetrievedTrace({
        locator: createTraceLocator({
          connectionId,
          destinationType,
          traceId: "1123456789abcdef0123456789abcdef",
        }),
        representation: { kind: "canonical-graph", graph },
        consistency: "snapshot",
      }),
    ).toThrowError(RetrievalResultError);
  });
});

describe("hostile portable retrieval results", () => {
  it("rejects malformed summaries and page containers", () => {
    for (const invalid of [
      { status: "provider-native" },
      { spanCount: 0 },
      { endTime: "2025-01-01T00:00:00.000Z" },
      { startTime: "2026-01-01T00:00:00Z" },
      { models: ["same", "same"] },
      { tags: ["bad\ntag"] },
      { extra: true },
    ]) {
      expect(() => summary(invalid)).toThrowError(RetrievalResultError);
    }
    expect(() => createTraceSummary(null as never)).toThrowError(
      RetrievalResultError,
    );
    const symbolSummary = {
      locator: locator(),
      startTime: "2026-01-01T00:00:00.000Z",
      models: [],
      status: "ok",
      spanCount: 1,
      tags: [],
    };
    Object.defineProperty(symbolSummary, Symbol("extra"), { value: true });
    expect(() => createTraceSummary(symbolSummary as never)).toThrowError(
      RetrievalResultError,
    );
    const accessorModels = ["model"];
    Object.defineProperty(accessorModels, "0", { get: () => "model" });
    expect(() => summary({ models: accessorModels })).toThrowError(
      RetrievalResultError,
    );
    const extraModels = ["model"];
    Object.defineProperty(extraModels, "extra", { value: true });
    expect(() => summary({ models: extraModels })).toThrowError(
      RetrievalResultError,
    );
    expect(() =>
      summary({ models: Array.from({ length: 33 }, () => "model") }),
    ).toThrowError(RetrievalResultError);
    const pageItems = [summary()];
    Object.defineProperty(pageItems, "extra", { value: true });
    const sparsePageItems = new Array(1);
    const accessorPageItems = [summary()];
    Object.defineProperty(accessorPageItems, "0", { get: () => summary() });
    for (const invalid of [
      null,
      { summaries: pageItems, state: "exhaustive", consistency: "snapshot" },
      {
        summaries: sparsePageItems,
        state: "exhaustive",
        consistency: "snapshot",
      },
      {
        summaries: accessorPageItems,
        state: "exhaustive",
        consistency: "snapshot",
      },
      {
        summaries: Array.from({ length: 201 }, () => summary()),
        state: "exhaustive",
        consistency: "snapshot",
      },
      {
        summaries: [],
        state: "exhaustive",
        consistency: "snapshot",
        extra: true,
      },
      { summaries: [{}], state: "exhaustive", consistency: "snapshot" },
      { summaries: [], state: "unknown", consistency: "snapshot" },
      { summaries: [], state: "exhaustive", consistency: "unknown" },
      {
        summaries: [],
        state: "partial",
        partialReason: "provider-body",
        consistency: "snapshot",
      },
      {
        summaries: [],
        state: "exhaustive",
        consistency: "snapshot",
        exactTotal: -1,
      },
      {
        summaries: [summary()],
        state: "exhaustive",
        consistency: "snapshot",
        exactTotal: 0,
      },
    ]) {
      expect(() => createRetrieverSearchPage(invalid as never)).toThrowError(
        RetrievalResultError,
      );
    }
    expect(() =>
      createRetrieverSearchPage({
        summaries: [
          summary({
            locator: createTraceLocator({
              connectionId,
              destinationType,
              traceId: "f123456789abcdef0123456789abcdef",
            }),
          }),
          summary(),
        ],
        state: "exhaustive",
        consistency: "snapshot",
      }),
    ).toThrowError(RetrievalResultError);
  });
});

describe("hostile retrieved trace representations", () => {
  it("rejects malformed and incompatible retrieved representations", () => {
    const symbolRepresentation = { kind: "canonical-graph", graph };
    Object.defineProperty(symbolRepresentation, Symbol("extra"), {
      value: true,
    });
    for (const representation of [
      null,
      {},
      { kind: "provider-body", body: "CANARY" },
      { kind: "canonical-graph", graph: {} },
      { kind: "persisted-envelope", envelope: {} },
      { kind: "canonical-graph", graph, extra: true },
      symbolRepresentation,
    ]) {
      expect(() =>
        createRetrievedTrace({
          locator: locator(),
          representation,
          consistency: "snapshot",
        }),
      ).toThrowError(RetrievalResultError);
    }
    expect(() =>
      createTraceSummary({
        locator: locator(),
        startTime: "2026-01-01T00:00:00.000Z",
      } as never),
    ).toThrowError(RetrievalResultError);
    expect(() =>
      createRetrievedTrace({
        locator: locator(),
        representation: { kind: "canonical-graph", graph },
        consistency: "unknown" as never,
      }),
    ).toThrowError(RetrievalResultError);
    expect(() => createRetrievedTrace(null as never)).toThrowError(
      RetrievalResultError,
    );
    expect(() =>
      createRetrievedTrace({
        locator: locator(),
        representation: { kind: "canonical-graph", graph },
        consistency: "snapshot",
        extra: true,
      } as never),
    ).toThrowError(RetrievalResultError);
    const currentEnvelope = {
      envelopeVersion: 1,
      protocolManifestId: standardsManifest.manifestId,
      delivery: {
        identity: "ab".repeat(32),
        stability: "session-stable",
      },
      graph,
    };
    expect(
      createRetrievedTrace({
        locator: locator(),
        representation: {
          kind: "persisted-envelope",
          envelope: JSON.stringify(currentEnvelope),
        },
        consistency: "snapshot",
      }).representation.kind,
    ).toBe("persisted-envelope");
    expect(() =>
      createRetrievedTrace({
        locator: createTraceLocator({
          connectionId,
          destinationType,
          traceId: "1123456789abcdef0123456789abcdef",
        }),
        representation: {
          kind: "persisted-envelope",
          envelope: JSON.stringify(currentEnvelope),
        },
        consistency: "snapshot",
      }),
    ).toThrowError(RetrievalResultError);
  });
});

describe("Retriever operation boundary", () => {
  it("requires complete search and get and returns typed successes", async () => {
    const selectedLocator = locator();
    const page = createRetrieverSearchPage({
      summaries: [summary()],
      state: "exhaustive",
      consistency: "snapshot",
      exactTotal: 1,
    });
    const retrieved = createRetrievedTrace({
      locator: selectedLocator,
      representation: { kind: "canonical-graph", graph },
      consistency: "snapshot",
    });
    const search = vi.fn(() => Promise.resolve(createRetrieverSuccess(page)));
    const get = vi.fn(() => Promise.resolve(createRetrieverSuccess(retrieved)));
    const retriever = createDestinationRetriever({ search, get });
    const operationContext = context();
    await expect(
      invokeRetrieverSearch(
        retriever,
        createTraceSearchRequest(query(), { connectionId, destinationType }),
        operationContext,
      ),
    ).resolves.toEqual({ ok: true, value: page });
    await expect(
      invokeRetrieverSearch(
        retriever,
        createTraceSearchRequest(
          query(),
          { connectionId, destinationType },
          { offset: 1 },
        ),
        operationContext,
      ),
    ).resolves.toEqual({ ok: true, value: page });
    await expect(
      invokeRetrieverGet(
        retriever,
        createTraceGetRequest(selectedLocator, {
          connectionId,
          destinationType,
        }),
        operationContext,
      ),
    ).resolves.toEqual({ ok: true, value: retrieved });
    expect(search).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledOnce();
    for (const candidate of [
      null,
      { search },
      { get },
      { search, get, extra: true },
      { search: 1, get },
    ]) {
      expect(() => createDestinationRetriever(candidate as never)).toThrowError(
        RetrieverContractError,
      );
    }
    const symbolRetriever = { search, get };
    Object.defineProperty(symbolRetriever, Symbol("extra"), { value: true });
    expect(() => createDestinationRetriever(symbolRetriever)).toThrowError(
      RetrieverContractError,
    );
  });

  it("binds every search and get result to the selected identity", async () => {
    const otherConnection = createDestinationConnectionId(
      "destination-connection-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    const otherLocator = createTraceLocator({
      connectionId: otherConnection,
      destinationType,
      traceId,
    });
    const otherPage = createRetrieverSearchPage({
      summaries: [summary({ locator: otherLocator })],
      state: "exhaustive",
      consistency: "snapshot",
    });
    const otherTrace = createRetrievedTrace({
      locator: otherLocator,
      representation: { kind: "canonical-graph", graph },
      consistency: "snapshot",
    });
    const retriever = createDestinationRetriever({
      search: () => Promise.resolve(createRetrieverSuccess(otherPage)),
      get: () => Promise.resolve(createRetrieverSuccess(otherTrace)),
    });
    await expect(
      invokeRetrieverSearch(
        retriever,
        createTraceSearchRequest(query(), { connectionId, destinationType }),
        context(),
      ),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
    await expect(
      invokeRetrieverGet(
        retriever,
        createTraceGetRequest(locator(), { connectionId, destinationType }),
        context(),
      ),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
  });
});

describe("Retriever cancellation boundary", () => {
  it("contains failures, cancellation, malformed returns, and hangs", async () => {
    const request = createTraceSearchRequest(query(), {
      connectionId,
      destinationType,
    });
    const operationContext = context();
    const cases = [
      {
        retriever: createDestinationRetriever({
          search: () => Promise.resolve(createRetrieverFailure("unauthorized")),
          get: () => Promise.resolve(createRetrieverFailure("not-found")),
        }),
        code: "unauthorized",
      },
      {
        retriever: createDestinationRetriever({
          search: () => Promise.reject(new Error("CANARY")),
          get: () => Promise.reject(new Error("CANARY")),
        }),
        code: "unavailable",
      },
      {
        retriever: createDestinationRetriever({
          search: (() => Promise.resolve({ providerBody: "CANARY" })) as never,
          get: (() => Promise.resolve({ providerBody: "CANARY" })) as never,
        }),
        code: "malformed-response",
      },
    ];
    for (const candidate of cases) {
      await expect(
        invokeRetrieverSearch(candidate.retriever, request, operationContext),
      ).resolves.toMatchObject({ ok: false, code: candidate.code });
    }
    const hanging = createDestinationRetriever({
      search: () => new Promise(() => undefined),
      get: () => new Promise(() => undefined),
    });
    await expect(
      invokeRetrieverSearch(hanging, request, context(5)),
    ).resolves.toMatchObject({ ok: false, code: "deadline-exceeded" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      invokeRetrieverSearch(
        hanging,
        request,
        context(1_000, controller.signal),
      ),
    ).resolves.toMatchObject({ ok: false, code: "deadline-exceeded" });

    let settle:
      ((value: ReturnType<typeof createRetrieverFailure>) => void) | undefined;
    const late = createDestinationRetriever({
      search: () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
      get: () => new Promise(() => undefined),
    });
    const lateController = new AbortController();
    const operation = invokeRetrieverSearch(
      late,
      request,
      context(1_000, lateController.signal),
    );
    lateController.abort();
    await expect(operation).resolves.toMatchObject({
      ok: false,
      code: "deadline-exceeded",
    });
    settle?.(createRetrieverFailure("unavailable"));
    await Promise.resolve();
  });
});

describe("hostile Retriever contract inputs", () => {
  it("validates failures, request identity, and operation context", () => {
    for (const args of [
      ["unknown"],
      ["unauthorized", 1],
      ["rate-limited", -1],
      ["unavailable", 3_600_001],
    ]) {
      expect(() =>
        createRetrieverFailure(args[0] as never, args[1] as number | undefined),
      ).toThrowError(RetrieverContractError);
    }
    expect(createRetrieverFailure("rate-limited", 1_000)).toMatchObject({
      ok: false,
      code: "rate-limited",
      retryAfterMilliseconds: 1_000,
    });
    expect(() =>
      createTraceGetRequest(locator(), {
        connectionId: createDestinationConnectionId(
          "destination-connection-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ),
        destinationType,
      }),
    ).toThrowError(RetrieverContractError);
    expect(() =>
      createTraceSearchRequest({} as never, { connectionId, destinationType }),
    ).toThrowError(RetrieverContractError);
    expect(() => createTraceSearchRequest(query(), null as never)).toThrowError(
      RetrieverContractError,
    );
    const symbolSearchBinding = { connectionId, destinationType };
    Object.defineProperty(symbolSearchBinding, Symbol("extra"), {
      value: true,
    });
    expect(() =>
      createTraceSearchRequest(query(), symbolSearchBinding),
    ).toThrowError(RetrieverContractError);
    expect(() => createTraceGetRequest(locator(), null as never)).toThrowError(
      RetrieverContractError,
    );
    const accessorBinding = { connectionId, destinationType };
    Object.defineProperty(accessorBinding, "connectionId", {
      get: () => connectionId,
    });
    expect(() =>
      createTraceGetRequest(locator(), accessorBinding),
    ).toThrowError(RetrieverContractError);
    for (const invalid of [
      null,
      {},
      {
        signal: {},
        deadline: createReporterDeadline(10),
        maximumResponseBytes: 1,
        maximumProviderRequests: 1,
      },
      {
        signal: new AbortController().signal,
        deadline: {},
        maximumResponseBytes: 1,
        maximumProviderRequests: 1,
      },
      {
        signal: new AbortController().signal,
        deadline: createReporterDeadline(10),
        maximumResponseBytes: 0,
        maximumProviderRequests: 1,
      },
      {
        signal: new AbortController().signal,
        deadline: createReporterDeadline(10),
        maximumResponseBytes: 1,
        maximumProviderRequests: 17,
      },
    ]) {
      expect(() => createRetrievalContext(invalid as never)).toThrowError(
        RetrieverContractError,
      );
    }
  });
});

describe("hostile Retriever operation results", () => {
  it("rejects malformed success, oversized pages, and sync misuse", async () => {
    const many = Array.from({ length: 26 }, (_, index) =>
      summary({
        locator: createTraceLocator({
          connectionId,
          destinationType,
          traceId: `${(index + 1).toString(16).padStart(32, "0")}`,
        }),
        startTime: new Date(
          Date.UTC(2026, 0, 1, 0, 0, 26 - index),
        ).toISOString(),
      }),
    );
    const oversizedPage = createRetrieverSearchPage({
      summaries: many,
      state: "exhaustive",
      consistency: "snapshot",
    });
    const syncThrow = createDestinationRetriever({
      search: () => {
        throw new Error("CANARY");
      },
      get: () => {
        throw new Error("CANARY");
      },
    });
    const rawPromise = createDestinationRetriever({
      search: (() => ({ then: null })) as never,
      get: (() => ({ then: null })) as never,
    });
    const throwingThen = createDestinationRetriever({
      search: (() => ({
        get then() {
          throw new Error("CANARY");
        },
      })) as never,
      get: (() => ({
        get then() {
          throw new Error("CANARY");
        },
      })) as never,
    });
    const tooMany = createDestinationRetriever({
      search: () => Promise.resolve(createRetrieverSuccess(oversizedPage)),
      get: () => Promise.resolve(createRetrieverFailure("not-found")),
    });
    const request = createTraceSearchRequest(query(), {
      connectionId,
      destinationType,
    });
    for (const [retriever, code] of [
      [syncThrow, "unavailable"],
      [rawPromise, "malformed-response"],
      [throwingThen, "malformed-response"],
      [tooMany, "malformed-response"],
    ] as const) {
      await expect(
        invokeRetrieverSearch(retriever, request, context()),
      ).resolves.toMatchObject({ ok: false, code });
    }
    await expect(
      invokeRetrieverSearch(
        createDestinationRetriever({
          search: () =>
            Promise.resolve(
              createRetrieverSuccess(
                createRetrieverSearchPage({
                  summaries: [summary()],
                  state: "exhaustive",
                  consistency: "snapshot",
                }),
              ),
            ),
          get: () => Promise.resolve(createRetrieverFailure("not-found")),
        }),
        request,
        createRetrievalContext({
          signal: new AbortController().signal,
          deadline: createReporterDeadline(1_000),
          maximumResponseBytes: 1,
          maximumProviderRequests: 1,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });

    const nullTokenPage = createRetrieverSearchPage({
      summaries: [],
      state: "continuation",
      continuationToken: null,
      consistency: "snapshot",
    });
    await expect(
      invokeRetrieverSearch(
        createDestinationRetriever({
          search: () => Promise.resolve(createRetrieverSuccess(nullTokenPage)),
          get: () => Promise.resolve(createRetrieverFailure("not-found")),
        }),
        request,
        context(),
      ),
    ).resolves.toEqual({ ok: true, value: nullTokenPage });

    await expect(
      invokeRetrieverSearch({} as never, request, context()),
    ).rejects.toThrowError(RetrieverContractError);
    await expect(
      invokeRetrieverGet(
        createDestinationRetriever({
          search: () => Promise.resolve(createRetrieverFailure("unavailable")),
          get: () => Promise.resolve(createRetrieverFailure("not-found")),
        }),
        {} as never,
        context(),
      ),
    ).rejects.toThrowError(RetrieverContractError);
    expect(() => createRetrieverSuccess({} as never)).toThrowError(
      RetrieverContractError,
    );
  });
});
