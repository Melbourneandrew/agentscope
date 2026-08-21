import {
  createDestinationConnectionId,
  createDestinationRetriever,
  createDestinationTypeId,
  createRetrieverFailure,
  createRetrieverSearchPage,
  createTraceLocator,
  type RetrievalContext,
  type TraceGetRequest,
  type TraceSearchRequest,
} from "@agentscope/destinations-core";
import {
  createRetrieverContractQueryMatrix,
  createRetrieverContractSuite,
  createTraceSearchRequest,
  invokeRetrieverGet,
  invokeRetrieverSearch,
  RETRIEVER_CONTRACT_FIXTURE_VALUES,
  type RetrieverTestAdapter,
  type RetrieverTestBehavior,
  type RetrieverTestLedgerEntry,
} from "@agentscope/destinations-core/testing";
import { createSanitizedRedactedCanonicalTraceFixture } from "@agentscope/protocol/testing";
import { describe, it } from "vitest";

import { prepareLocalSqliteTrace } from "../reporter/transaction.js";
import {
  createLocalSqliteRetriever,
  type LocalSqliteRetrievalRow,
} from "./index.js";

const sequences = [20, 21] as const;
const orderedSequences = sequences
  .map((sequence) => ({
    sequence,
    traceId: createSanitizedRedactedCanonicalTraceFixture({ sequence }).graph
      .resourceSpans[0]!.scopeSpans[0]!.spans[0]!.traceId,
  }))
  .sort((left, right) => left.traceId.localeCompare(right.traceId));
const fixtureValues = RETRIEVER_CONTRACT_FIXTURE_VALUES;
const prepared = orderedSequences.map(({ sequence }, index) =>
  prepareLocalSqliteTrace(
    createSanitizedRedactedCanonicalTraceFixture({
      sequence,
      branchName:
        index === 0 ? fixtureValues.branch : fixtureValues.secondaryBranch,
      harnessName: fixtureValues.harness,
      modelName:
        index === 0 ? fixtureValues.model : fixtureValues.secondaryModel,
      sessionId:
        index === 0
          ? fixtureValues.sessionId
          : fixtureValues.secondarySessionId,
      tags:
        index === 0 ? fixtureValues.matchingTags : fixtureValues.secondaryTags,
      startTimeUnixNano: String(
        BigInt(
          Date.parse(
            index === 0
              ? fixtureValues.primaryStartTime
              : fixtureValues.secondaryStartTime,
          ),
        ) * 1_000_000n,
      ),
    }),
    String(1_000_000 + sequence),
  ),
);
const [primary, secondary] = prepared as [
  (typeof prepared)[number],
  (typeof prepared)[number],
];
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
const rowByTraceId = new Map(
  [primary, secondary].map((trace) => [trace.traceId, rowFor(trace)]),
);
const connectionId = createDestinationConnectionId(
  `destination-connection-v1-${"c".repeat(64)}`,
);
const destinationType = createDestinationTypeId(
  "@agentscope/destination-local-sqlite",
);
const snapshotToken = "d".repeat(64);
const retentionCutoffSortKey = "0".repeat(20);
const queryCases = createRetrieverContractQueryMatrix({
  primaryTraceId: primary.traceId,
  secondaryTraceId: secondary.traceId,
  ordering: "start-time-desc-trace-id-asc",
});

const syntheticFailure = (behavior: RetrieverTestBehavior) =>
  createDestinationRetriever({
    search: () => {
      if (typeof behavior === "object")
        return Promise.resolve(createRetrieverFailure(behavior.failure));
      if (behavior === "throw") throw new Error("test throw");
      if (behavior === "reject")
        return Promise.reject(new Error("test reject"));
      if (behavior === "hang") return new Promise(() => undefined);
      return Promise.resolve(Object.freeze({ ok: true, value: {} }) as never);
    },
    get: () => {
      if (typeof behavior === "object")
        return Promise.resolve(createRetrieverFailure(behavior.failure));
      if (behavior === "throw") throw new Error("test throw");
      if (behavior === "reject")
        return Promise.reject(new Error("test reject"));
      if (behavior === "hang") return new Promise(() => undefined);
      return Promise.resolve(Object.freeze({ ok: true, value: {} }) as never);
    },
  });

/* eslint-disable max-lines-per-function -- the shared-suite adapter remains a
 * single stateful test oracle so every ledger entry is causally bound. */
describe("Local SQLite shared Retriever contract", () => {
  let ledger: RetrieverTestLedgerEntry[] = [];
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
  const actual = createLocalSqliteRetriever({
    search: () => {
      if (active?.operation !== "search") throw new Error("missing search");
      ledger.push(
        Object.freeze({
          operation: "search",
          maximumProviderRequests: active.context.maximumProviderRequests,
          connectionId,
          destinationType,
          queryFingerprint: active.request.query.fingerprint,
          hasContinuationToken: active.request.continuationToken !== undefined,
        }),
      );
      return Promise.resolve({
        responseByteLimitReached: active.queryCase.expectedState === "partial",
        retentionCutoffSortKey,
        rows: active.queryCase.expectedTraceIds.map((traceId) =>
          rowByTraceId.get(traceId)!,
        ),
        snapshotToken,
      });
    },
    get: (plan) => {
      if (active?.operation !== "get") throw new Error("missing get");
      ledger.push(
        Object.freeze({
          operation: "get",
          maximumProviderRequests: active.context.maximumProviderRequests,
          connectionId,
          destinationType,
          traceId: active.request.locator.traceId,
        }),
      );
      return Promise.resolve({
        row: rowByTraceId.get(plan.parameters.traceId),
        retentionCutoffSortKey,
      });
    },
  });
  const adapter: RetrieverTestAdapter = Object.freeze({
    createRetriever: (behavior) => {
      if (behavior !== "success") return syntheticFailure(behavior);
      return createDestinationRetriever({
        search: async (request, context) => {
          const queryCase = queryCases.find(
            (candidate) =>
              candidate.query.fingerprint === request.query.fingerprint &&
              JSON.stringify(candidate.continuationToken ?? null) ===
                JSON.stringify(request.continuationToken ?? null),
          )!;
          active = { operation: "search", request, context, queryCase };
          const translated = createTraceSearchRequest(
            request.query,
            { connectionId, destinationType },
            request.continuationToken === undefined
              ? undefined
              : {
                  version: 1,
                  startTimeSortKey: primary.startTimeSortKey,
                  traceId: primary.traceId,
                  snapshotToken,
                },
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
              consistency: "snapshot",
              ordering: "start-time-desc-trace-id-asc",
            }),
          };
        },
        get: (request, context) => {
          active = { operation: "get", request, context };
          return invokeRetrieverGet(actual, request, context);
        },
      });
    },
    readRetrievalLedger: () => Object.freeze([...ledger]),
    reset: () => {
      active = undefined;
      ledger = [];
    },
  });
  const cases = createRetrieverContractSuite({
    adapter,
    queryCases,
    locator: createTraceLocator({
      connectionId,
      destinationType,
      traceId: primary.traceId,
    }),
    connectionId,
    destinationType,
    configurationIdentity: "local-sqlite-retriever-contract-v1",
  });
  void RETRIEVER_CONTRACT_FIXTURE_VALUES;
  for (const contractCase of cases) it(contractCase.name, contractCase.run);
});
/* eslint-enable max-lines-per-function */
