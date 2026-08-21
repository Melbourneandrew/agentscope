import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import {
  createDestinationConnectionId,
  createDestinationTypeId,
  createTraceLocator,
  type JsonValue,
} from "@agentscope/destinations-core";
import {
  createReporterDeadline,
  createRetrievalContext,
  createTraceGetRequest,
  createTraceSearchRequest,
  invokeRetrieverGet,
  invokeRetrieverSearch,
  normalizeTraceSearchQuery,
} from "@agentscope/destinations-core/testing";
import {
  standardsManifest,
  SUPPORTED_PERSISTED_MANIFEST_IDS,
} from "@agentscope/protocol";
import { createSanitizedRedactedCanonicalTraceFixture } from "@agentscope/protocol/testing";
import { describe, expect, it, vi } from "vitest";

import { prepareLocalSqliteTrace } from "../reporter/transaction.js";
import {
  compileLocalSqliteSearchPlan,
  createLocalSqliteRetriever,
  type LocalSqliteRetrievalRow,
  type LocalSqliteRetrieverDatabase,
} from "./index.js";

const connectionId = createDestinationConnectionId(
  `destination-connection-v1-${"a".repeat(64)}`,
);
const destinationType = createDestinationTypeId(
  "@agentscope/destination-local-sqlite",
);
const primary = prepareLocalSqliteTrace(
  createSanitizedRedactedCanonicalTraceFixture({
    sequence: 4,
    sessionId: "session-primary",
    tags: ["tag-a", "tag-b"],
    modelName: "model-primary",
  }),
  "1000000",
);
const secondary = prepareLocalSqliteTrace(
  createSanitizedRedactedCanonicalTraceFixture({
    sequence: 5,
    sessionId: "session-secondary",
    tags: ["tag-b"],
    modelName: "model-secondary",
  }),
  "2000000",
);

const rowFor = (trace: typeof primary): LocalSqliteRetrievalRow =>
  Object.freeze({
    deliveryIdentity: trace.deliveryIdentity,
    traceId: trace.traceId,
    startTimeSortKey: trace.startTimeSortKey,
    admissionTimeSortKey: trace.admissionTimeSortKey,
    protocolCompatibilityId: trace.protocolCompatibilityId,
    payloadUtf8: trace.payloadUtf8,
    payloadSha256: trace.payloadSha256,
    payloadBytes: trace.payloadBytes,
  });

const rows = Object.freeze(
  [rowFor(primary), rowFor(secondary)].sort((left, right) =>
    left.startTimeSortKey === right.startTimeSortKey
      ? left.traceId.localeCompare(right.traceId)
      : left.startTimeSortKey > right.startTimeSortKey
        ? -1
        : 1,
  ),
);
const snapshotToken = createHash("sha256").update("snapshot-v1").digest("hex");
const retentionCutoffSortKey = "0".repeat(20);

const context = (maximumResponseBytes = 1_000_000) =>
  createRetrievalContext({
    signal: new AbortController().signal,
    deadline: createReporterDeadline(1_000),
    maximumResponseBytes,
    maximumProviderRequests: 1,
  });
const executionBounds = Object.freeze({
  maximumResponseBytes: 1_000_000,
  maximumWorkMilliseconds: 1_000,
});

const query = (limit = 10) =>
  normalizeTraceSearchQuery(
    { limit },
    {
      commandStartedAt: "2099-01-01T00:00:00.000Z",
      knownHarnessIds: ["codex"],
      ordering: "start-time-desc-trace-id-asc",
    },
  );

const request = (limit = 10, continuationToken?: JsonValue) =>
  createTraceSearchRequest(
    query(limit),
    { connectionId, destinationType },
    continuationToken,
  );

const database = (
  searchRows: readonly LocalSqliteRetrievalRow[] = rows,
): LocalSqliteRetrieverDatabase =>
  Object.freeze({
    search: (plan) => {
      const selected: LocalSqliteRetrievalRow[] = [];
      let payloadBytes = 0;
      let responseByteLimitReached = false;
      for (const row of searchRows.slice(0, plan.maximumRows)) {
        if (row.payloadBytes > plan.maximumResponseBytes - payloadBytes) {
          responseByteLimitReached = true;
          break;
        }
        selected.push(row);
        payloadBytes += row.payloadBytes;
      }
      return Promise.resolve({
        responseByteLimitReached,
        retentionCutoffSortKey,
        rows: selected,
        snapshotToken,
      });
    },
    get: (plan) =>
      Promise.resolve({
        row: searchRows.find((row) => row.traceId === plan.parameters.traceId),
        retentionCutoffSortKey,
      }),
  });

describe("Local SQLite Retriever deadline preflight", () => {
  it("classifies a positive sub-millisecond budget before database I/O", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    let calls = 0;
    try {
      vi.resetModules();
      const [core, family, local] = await Promise.all([
        import("@agentscope/destinations-core"),
        import("@agentscope/destinations-core/testing"),
        import("./index.js"),
      ]);
      const isolatedConnectionId = core.createDestinationConnectionId(
        `destination-connection-v1-${"b".repeat(64)}`,
      );
      const isolatedDestinationType = core.createDestinationTypeId(
        "@agentscope/destination-local-sqlite",
      );
      const isolatedQuery = family.normalizeTraceSearchQuery(
        { limit: 1 },
        {
          commandStartedAt: "2099-01-01T00:00:00.000Z",
          knownHarnessIds: ["codex"],
          ordering: "start-time-desc-trace-id-asc",
        },
      );
      const retriever = local.createLocalSqliteRetriever({
        search: () => {
          calls += 1;
          return Promise.reject(new Error("must not run"));
        },
        get: () => {
          calls += 1;
          return Promise.reject(new Error("must not run"));
        },
      });
      const subMillisecond = family.createRetrievalContext({
        signal: new AbortController().signal,
        deadline: family.createReporterDeadline(0.5),
        maximumResponseBytes: 1_000_000,
        maximumProviderRequests: 1,
      });
      await expect(
        family.invokeRetrieverSearch(
          retriever,
          family.createTraceSearchRequest(isolatedQuery, {
            connectionId: isolatedConnectionId,
            destinationType: isolatedDestinationType,
          }),
          subMillisecond,
        ),
      ).resolves.toMatchObject({ ok: false, code: "deadline-exceeded" });
      await expect(
        family.invokeRetrieverGet(
          retriever,
          family.createTraceGetRequest(
            core.createTraceLocator({
              connectionId: isolatedConnectionId,
              destinationType: isolatedDestinationType,
              traceId: primary.traceId,
            }),
            {
              connectionId: isolatedConnectionId,
              destinationType: isolatedDestinationType,
            },
          ),
          subMillisecond,
        ),
      ).resolves.toMatchObject({ ok: false, code: "deadline-exceeded" });
      expect(calls).toBe(0);
    } finally {
      now.mockRestore();
      vi.resetModules();
    }
  });
});

/* eslint-disable max-lines-per-function -- hostile evidence tables deliberately
 * keep each end-to-end Retriever oracle and its causal database state together. */
describe("Local SQLite Retriever", () => {
  it("rejects invalid database authorities and destination-native locators", async () => {
    for (const candidate of [
      null,
      {},
      { get: () => undefined, search: 1 },
      Object.defineProperty(
        { search: () => Promise.resolve({ rows: [], snapshotToken }) },
        "get",
        { get: () => () => Promise.resolve(undefined), enumerable: true },
      ),
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("CANARY");
          },
        },
      ),
    ])
      expect(() =>
        createLocalSqliteRetriever(candidate as LocalSqliteRetrieverDatabase),
      ).toThrow("destination.local-sqlite.retriever.invalid");

    const retriever = createLocalSqliteRetriever(database());
    for (const locator of [
      createTraceLocator({
        connectionId,
        destinationType,
        traceId: primary.traceId,
        destinationTraceId: "provider-id",
      }),
      createTraceLocator({
        connectionId,
        destinationType,
        traceId: primary.traceId,
        destinationRevision: "revision-1",
      }),
    ])
      await expect(
        invokeRetrieverGet(
          retriever,
          createTraceGetRequest(locator, { connectionId, destinationType }),
          context(),
        ),
      ).resolves.toMatchObject({ ok: false, code: "invalid-query" });
  });

  it("compiles values as bound parameters and returns persisted envelopes", async () => {
    const hostile = "x' OR 1=1 --";
    const normalized = normalizeTraceSearchQuery(
      { tags: [hostile] },
      {
        commandStartedAt: "2099-01-01T00:00:00.000Z",
        knownHarnessIds: ["codex"],
        ordering: "start-time-desc-trace-id-asc",
      },
    );
    const plan = compileLocalSqliteSearchPlan(
      createTraceSearchRequest(normalized, { connectionId, destinationType }),
      executionBounds,
    )!;
    expect(plan.sql).not.toContain(hostile);
    expect(Object.values(plan.parameters)).toContain(hostile);
    for (const invalidBounds of [
      { maximumResponseBytes: 0, maximumWorkMilliseconds: 1 },
      { maximumResponseBytes: 8 * 1024 * 1024 + 1, maximumWorkMilliseconds: 1 },
      { maximumResponseBytes: 1.5, maximumWorkMilliseconds: 1 },
      { maximumResponseBytes: 1, maximumWorkMilliseconds: 0 },
      { maximumResponseBytes: 1, maximumWorkMilliseconds: 1.5 },
    ])
      expect(
        compileLocalSqliteSearchPlan(
          createTraceSearchRequest(normalized, {
            connectionId,
            destinationType,
          }),
          invalidBounds,
        ),
      ).toBeUndefined();

    const retriever = createLocalSqliteRetriever(database());
    const search = await invokeRetrieverSearch(retriever, request(), context());
    expect(search).toMatchObject({ ok: true, value: { state: "exhaustive" } });
    if (!search.ok) throw new Error("expected search success");
    expect(
      search.value.summaries.map(({ locator }) => locator.traceId),
    ).toEqual(rows.map(({ traceId }) => traceId));
    expect(JSON.stringify(search.value)).not.toContain("payloadUtf8");

    const get = await invokeRetrieverGet(
      retriever,
      createTraceGetRequest(
        createTraceLocator({
          connectionId,
          destinationType,
          traceId: primary.traceId,
        }),
        { connectionId, destinationType },
      ),
      context(),
    );
    expect(get).toMatchObject({
      ok: true,
      value: { representation: { kind: "persisted-envelope" } },
    });
  });

  it("uses the exact nanosecond key and snapshot identity for continuation", async () => {
    const retriever = createLocalSqliteRetriever(database());
    const first = await invokeRetrieverSearch(retriever, request(1), context());
    expect(first).toMatchObject({ ok: true, value: { state: "continuation" } });
    if (!first.ok) throw new Error("expected search success");
    expect(first.value.continuationToken).toEqual({
      version: 1,
      startTimeSortKey: rows[0]!.startTimeSortKey,
      traceId: rows[0]!.traceId,
      snapshotToken,
    });
    const continued = compileLocalSqliteSearchPlan(
      request(1, first.value.continuationToken),
      executionBounds,
    )!;
    expect(continued.snapshotToken).toBe(snapshotToken);
    expect(continued.parameters.cursorStart).toBe(rows[0]!.startTimeSortKey);
    expect(
      compileLocalSqliteSearchPlan(
        request(1, {
          ...(first.value.continuationToken as Record<string, JsonValue>),
          version: 2,
        }),
        executionBounds,
      ),
    ).toBeUndefined();
  });

  it("fails closed on malformed ordering, payload evidence, and snapshot drift", async () => {
    const reversed = createLocalSqliteRetriever(database([...rows].reverse()));
    await expect(
      invokeRetrieverSearch(reversed, request(), context()),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });

    const bad = { ...rows[0]!, payloadSha256: "0".repeat(64) };
    await expect(
      invokeRetrieverSearch(
        createLocalSqliteRetriever(database([bad])),
        request(),
        context(),
      ),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });

    const cursor = {
      version: 1,
      startTimeSortKey: rows[0]!.startTimeSortKey,
      traceId: rows[0]!.traceId,
      snapshotToken: "f".repeat(64),
    };
    await expect(
      invokeRetrieverSearch(
        createLocalSqliteRetriever(database()),
        request(1, cursor),
        context(),
      ),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
  });

  it("retains cutoff equality and rejects evidence one nanosecond older", async () => {
    const row = rows[0]!;
    const cutoff = row.admissionTimeSortKey;
    const older = (BigInt(cutoff) - 1n).toString().padStart(20, "0");
    const getRequest = createTraceGetRequest(
      createTraceLocator({
        connectionId,
        destinationType,
        traceId: row.traceId,
      }),
      { connectionId, destinationType },
    );
    const retriever = createLocalSqliteRetriever({
      search: (plan) => {
        expect(plan.sql).toContain(
          "admission_time_sort_key >= :retentionCutoffSortKey",
        );
        return Promise.resolve({
          responseByteLimitReached: false,
          retentionCutoffSortKey: cutoff,
          rows: [row],
          snapshotToken,
        });
      },
      get: (plan) => {
        expect(plan.sql).toContain(
          "admission_time_sort_key >= :retentionCutoffSortKey",
        );
        return Promise.resolve({ row, retentionCutoffSortKey: cutoff });
      },
    });
    await expect(
      invokeRetrieverSearch(retriever, request(), context()),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      invokeRetrieverGet(retriever, getRequest, context()),
    ).resolves.toMatchObject({ ok: true });

    const expired = { ...row, admissionTimeSortKey: older };
    const expiredRetriever = createLocalSqliteRetriever({
      search: () =>
        Promise.resolve({
          responseByteLimitReached: false,
          retentionCutoffSortKey: cutoff,
          rows: [expired],
          snapshotToken,
        }),
      get: () =>
        Promise.resolve({ row: expired, retentionCutoffSortKey: cutoff }),
    });
    await expect(
      invokeRetrieverSearch(expiredRetriever, request(), context()),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
    await expect(
      invokeRetrieverGet(expiredRetriever, getRequest, context()),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
  });

  it("postvalidates every portable filter against the persisted graph", async () => {
    const matchingRow = rowFor(primary);
    const filteredRequest = (
      input: Parameters<typeof normalizeTraceSearchQuery>[0],
    ) =>
      createTraceSearchRequest(
        normalizeTraceSearchQuery(input, {
          commandStartedAt: "2099-01-01T00:00:00.000Z",
          knownHarnessIds: ["codex", "fixture-harness"],
          ordering: "start-time-desc-trace-id-asc",
        }),
        { connectionId, destinationType },
      );
    const matching = filteredRequest({
      from: "1970-01-01T00:00:00.000Z",
      traceId: primary.traceId,
      harness: "fixture-harness",
      branch: "fixture-branch",
      model: "model-primary",
      sessionId: "session-primary",
      tags: ["tag-a", "tag-b"],
    });
    await expect(
      invokeRetrieverSearch(
        createLocalSqliteRetriever(database([matchingRow])),
        matching,
        context(),
      ),
    ).resolves.toMatchObject({ ok: true });

    const nonmatching = [
      { from: "2098-01-01T00:00:00.000Z" },
      { to: "1969-01-01T00:00:00.000Z" },
      { traceId: secondary.traceId },
      { harness: "codex" },
      { branch: "other" },
      { model: "other" },
      { sessionId: "other" },
      { tags: ["missing"] },
    ] as const;
    for (const input of nonmatching) {
      const result = await invokeRetrieverSearch(
        createLocalSqliteRetriever(database([matchingRow])),
        filteredRequest(input),
        context(),
      );
      expect(result, JSON.stringify(input)).toMatchObject({
        ok: false,
        code: "malformed-response",
      });
    }
  });

  it("rejects hostile search evidence before constructing public DTOs", async () => {
    const evidence = (rowValues: unknown, token = snapshotToken) => ({
      responseByteLimitReached: false,
      retentionCutoffSortKey,
      rows: rowValues,
      snapshotToken: token,
    });
    const malformedRows: readonly unknown[] = [
      null,
      evidence(null),
      evidence([], "bad"),
      { ...evidence([]), retentionCutoffSortKey: "bad" },
      evidence([rows[0], rows[0]]),
      evidence([...rows].reverse()),
      evidence([{ ...rows[0], traceId: "0".repeat(32) }]),
      evidence([{ ...rows[0], payloadBytes: 0 }]),
      evidence([{ ...rows[0], startTimeSortKey: "1" }]),
      evidence([{ ...rows[0], extra: true }]),
      evidence([
        {
          ...rows[0],
          admissionTimeSortKey: (BigInt(retentionCutoffSortKey) - 1n)
            .toString()
            .padStart(20, "0"),
        },
      ]),
      Object.defineProperty({ retentionCutoffSortKey, snapshotToken }, "rows", {
        get: () => [rows[0]],
        enumerable: true,
      }),
      evidence(Object.assign([], { canary: true })),
      evidence(new Array(1)),
      evidence(Object.assign(new Array(1), { canary: true })),
      evidence(
        new Proxy([], {
          ownKeys: () => {
            throw new Error("CANARY");
          },
        }),
      ),
    ];
    for (const evidence of malformedRows) {
      const retriever = createLocalSqliteRetriever({
        search: () => Promise.resolve(evidence as never),
        get: () => Promise.resolve({ row: undefined, retentionCutoffSortKey }),
      });
      await expect(
        invokeRetrieverSearch(retriever, request(), context()),
      ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
    }
  });

  it("maps incompatible and inconsistent persisted envelopes exactly", async () => {
    const envelope = JSON.parse(primary.payloadUtf8) as Record<string, unknown>;
    const unsupportedPayload = JSON.stringify({
      ...envelope,
      protocolManifestId: "agentscope-protocol-unsupported",
    });
    const oversizedSummaryPayload = JSON.stringify(envelope).replace(
      '"fixture-branch"',
      `"${"b".repeat(600)}"`,
    );
    const payloadRow = (payloadUtf8: string): LocalSqliteRetrievalRow => ({
      ...rows[0]!,
      payloadUtf8,
      payloadBytes: Buffer.byteLength(payloadUtf8, "utf8"),
      payloadSha256: createHash("sha256").update(payloadUtf8).digest("hex"),
    });
    const cases = [
      [payloadRow("{}"), "malformed-response"],
      [payloadRow(unsupportedPayload), "incompatible-trace"],
      [payloadRow(oversizedSummaryPayload), "malformed-response"],
      [{ ...rows[0]!, deliveryIdentity: "f".repeat(64) }, "malformed-response"],
      [
        {
          ...rows[0]!,
          startTimeSortKey: (BigInt(rows[0]!.startTimeSortKey) + 1n)
            .toString()
            .padStart(20, "0"),
        },
        "malformed-response",
      ],
    ] as const;
    for (const [candidate, code] of cases)
      await expect(
        invokeRetrieverSearch(
          createLocalSqliteRetriever(database([candidate])),
          request(),
          context(),
        ),
      ).resolves.toMatchObject({ ok: false, code });
  });

  it("authenticates historical row identity before Protocol migration", async () => {
    const historicalManifestId = SUPPORTED_PERSISTED_MANIFEST_IDS.find(
      (candidate) => candidate !== standardsManifest.manifestId,
    )!;
    const source = JSON.parse(primary.payloadUtf8) as {
      protocolManifestId: string;
      graph: {
        resourceSpans: Array<{
          resource?: {
            attributes?: Array<{
              key: string;
              value: { stringValue?: string };
            }>;
          };
          scopeSpans: Array<{ scope?: { version?: string } }>;
        }>;
      };
    };
    source.protocolManifestId = historicalManifestId;
    for (const resource of source.graph.resourceSpans) {
      const manifest = resource.resource?.attributes?.find(
        ({ key }) => key === "agentscope.protocol.manifest_id",
      );
      if (manifest?.value.stringValue !== undefined)
        manifest.value.stringValue = historicalManifestId;
      for (const scope of resource.scopeSpans)
        if (scope.scope !== undefined) scope.scope.version = "1";
    }
    const payloadUtf8 = JSON.stringify(source);
    const historicalRow = Object.freeze({
      ...rows[0]!,
      protocolCompatibilityId: historicalManifestId,
      payloadUtf8,
      payloadBytes: Buffer.byteLength(payloadUtf8, "utf8"),
      payloadSha256: createHash("sha256").update(payloadUtf8).digest("hex"),
    });
    const retriever = createLocalSqliteRetriever(database([historicalRow]));
    await expect(
      invokeRetrieverSearch(retriever, request(), context()),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      invokeRetrieverGet(
        retriever,
        createTraceGetRequest(
          createTraceLocator({
            connectionId,
            destinationType,
            traceId: historicalRow.traceId,
          }),
          { connectionId, destinationType },
        ),
        context(),
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it("maps preflight, database, missing, and response-budget failures", async () => {
    const throwing = createLocalSqliteRetriever({
      search: () => Promise.reject(new Error("native")),
      get: () => Promise.reject(new Error("native")),
    });
    await expect(
      invokeRetrieverSearch(throwing, request(), context()),
    ).resolves.toMatchObject({
      ok: false,
      code: "unavailable",
    });
    const missing = createLocalSqliteRetriever(database([]));
    await expect(
      invokeRetrieverGet(
        missing,
        createTraceGetRequest(
          createTraceLocator({
            connectionId,
            destinationType,
            traceId: primary.traceId,
          }),
          { connectionId, destinationType },
        ),
        context(),
      ),
    ).resolves.toMatchObject({ ok: false, code: "not-found" });
    await expect(
      invokeRetrieverSearch(
        createLocalSqliteRetriever(database()),
        request(),
        context(1),
      ),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
    await expect(
      invokeRetrieverSearch(
        createLocalSqliteRetriever(database()),
        request(),
        context(rows[0]!.payloadBytes + 1),
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { state: "partial", partialReason: "response-byte-limit" },
    });
    await expect(
      invokeRetrieverSearch(
        createLocalSqliteRetriever({
          search: () =>
            Promise.resolve({
              responseByteLimitReached: false,
              retentionCutoffSortKey,
              rows,
              snapshotToken,
            }),
          get: () =>
            Promise.resolve({ row: undefined, retentionCutoffSortKey }),
        }),
        request(),
        context(rows.reduce((total, row) => total + row.payloadBytes, -1)),
      ),
    ).resolves.toMatchObject({ ok: false, code: "malformed-response" });

    const controller = new AbortController();
    controller.abort();
    const expired = createRetrievalContext({
      signal: controller.signal,
      deadline: createReporterDeadline(1_000),
      maximumResponseBytes: 1_000_000,
      maximumProviderRequests: 1,
    });
    await expect(
      invokeRetrieverSearch(
        createLocalSqliteRetriever(database()),
        request(),
        expired,
      ),
    ).resolves.toMatchObject({ ok: false, code: "deadline-exceeded" });

    const abortDuring = new AbortController();
    const aborting = createLocalSqliteRetriever({
      search: () => {
        abortDuring.abort();
        return Promise.resolve({
          responseByteLimitReached: false,
          retentionCutoffSortKey,
          rows: [],
          snapshotToken,
        });
      },
      get: () => {
        abortDuring.abort();
        return Promise.resolve({ row: undefined, retentionCutoffSortKey });
      },
    });
    const abortedContext = createRetrievalContext({
      signal: abortDuring.signal,
      deadline: createReporterDeadline(1_000),
      maximumResponseBytes: 1_000_000,
      maximumProviderRequests: 1,
    });
    await expect(
      invokeRetrieverSearch(aborting, request(), abortedContext),
    ).resolves.toMatchObject({ ok: false, code: "deadline-exceeded" });

    const getAbortController = new AbortController();
    const abortingGet = createLocalSqliteRetriever({
      search: () =>
        Promise.resolve({
          responseByteLimitReached: false,
          retentionCutoffSortKey,
          rows: [],
          snapshotToken,
        }),
      get: () => {
        getAbortController.abort();
        return Promise.resolve({ row: rows[0], retentionCutoffSortKey });
      },
    });
    const getAbortContext = createRetrievalContext({
      signal: getAbortController.signal,
      deadline: createReporterDeadline(1_000),
      maximumResponseBytes: 1_000_000,
      maximumProviderRequests: 1,
    });
    await expect(
      invokeRetrieverGet(
        abortingGet,
        createTraceGetRequest(
          createTraceLocator({
            connectionId,
            destinationType,
            traceId: primary.traceId,
          }),
          { connectionId, destinationType },
        ),
        getAbortContext,
      ),
    ).resolves.toMatchObject({ ok: false, code: "deadline-exceeded" });

    const getThrow = createLocalSqliteRetriever({
      search: () =>
        Promise.resolve({
          responseByteLimitReached: false,
          retentionCutoffSortKey,
          rows: [],
          snapshotToken,
        }),
      get: () => Promise.reject(new Error("native")),
    });
    const getRequest = createTraceGetRequest(
      createTraceLocator({
        connectionId,
        destinationType,
        traceId: primary.traceId,
      }),
      { connectionId, destinationType },
    );
    const mismatchedEnvelope = JSON.parse(rows[0]!.payloadUtf8) as {
      graph: {
        resourceSpans: Array<{
          scopeSpans: Array<{
            spans: Array<{ traceId: string }>;
          }>;
        }>;
      };
    };
    for (const resource of mismatchedEnvelope.graph.resourceSpans)
      for (const scope of resource.scopeSpans)
        for (const span of scope.spans) span.traceId = secondary.traceId;
    const mismatchedPayload = JSON.stringify(mismatchedEnvelope);
    const mismatchedGraphRow = {
      ...rows[0]!,
      payloadUtf8: mismatchedPayload,
      payloadBytes: Buffer.byteLength(mismatchedPayload, "utf8"),
      payloadSha256: createHash("sha256")
        .update(mismatchedPayload)
        .digest("hex"),
    };
    await expect(
      invokeRetrieverGet(getThrow, getRequest, context()),
    ).resolves.toMatchObject({ ok: false, code: "unavailable" });
    for (const [candidate, budget] of [
      [{ ...rows[0]!, traceId: secondary.traceId }, 1_000_000],
      [rows[0]!, 1],
      [mismatchedGraphRow, 1_000_000],
      [
        {
          ...rows[0]!,
          payloadUtf8: "{}",
          payloadBytes: 2,
          payloadSha256:
            "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
        },
        1_000_000,
      ],
    ] as const)
      await expect(
        invokeRetrieverGet(
          createLocalSqliteRetriever({
            search: () =>
              Promise.resolve({
                responseByteLimitReached: false,
                retentionCutoffSortKey,
                rows: [],
                snapshotToken,
              }),
            get: () =>
              Promise.resolve({ row: candidate, retentionCutoffSortKey }),
          }),
          getRequest,
          context(budget),
        ),
      ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
    for (const getEvidence of [
      null,
      { row: rows[0], retentionCutoffSortKey: "bad" },
      {
        row: { ...rows[0], extra: true },
        retentionCutoffSortKey,
      },
      {
        row: {
          ...rows[0],
          admissionTimeSortKey: (BigInt(rows[0]!.admissionTimeSortKey) - 1n)
            .toString()
            .padStart(20, "0"),
        },
        retentionCutoffSortKey: rows[0]!.admissionTimeSortKey,
      },
    ])
      await expect(
        invokeRetrieverGet(
          createLocalSqliteRetriever({
            search: () =>
              Promise.resolve({
                responseByteLimitReached: false,
                retentionCutoffSortKey,
                rows: [],
                snapshotToken,
              }),
            get: () => Promise.resolve(getEvidence as never),
          }),
          getRequest,
          context(),
        ),
      ).resolves.toMatchObject({ ok: false, code: "malformed-response" });
  });
});
/* eslint-enable max-lines-per-function */
