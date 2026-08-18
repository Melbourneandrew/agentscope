import {
  createDestinationRetriever,
  createRetrieverFailure,
  createRetrieverSuccess,
  type RetrievalContext,
  type Retriever,
  type RetrieverFailureCode,
  type TraceGetRequest,
  type TraceSearchRequest,
} from "./retriever.js";
import type {
  RetrievedTrace,
  RetrieverSearchPage,
} from "./retrieval-results.js";

export const RETRIEVER_TEST_BEHAVIORS = Object.freeze([
  "success",
  "throw",
  "reject",
  "hang",
  "malformed-response",
] as const);

export type RetrieverTestBehavior =
  | (typeof RETRIEVER_TEST_BEHAVIORS)[number]
  | Readonly<{ failure: RetrieverFailureCode }>;

export type RetrieverTestFixture = Readonly<{
  searchCases: readonly Readonly<{
    queryFingerprint: string;
    continuationToken?: unknown;
    page: RetrieverSearchPage;
  }>[];
  retrievedTrace: RetrievedTrace;
}>;

export type RetrieverTestLedgerEntry = Readonly<{
  operation: "search" | "get";
  maximumProviderRequests: number;
  connectionId: string;
  destinationType: string;
  queryFingerprint?: string;
  hasContinuationToken?: boolean;
  traceId?: string;
}>;

export type RetrieverTestAdapter = Readonly<{
  createRetriever: (behavior: RetrieverTestBehavior) => Retriever;
  readRetrievalLedger: () => readonly RetrieverTestLedgerEntry[];
  reset: () => void;
}>;

const pending = (): Promise<never> => new Promise(() => undefined);

export const createRetrieverTestAdapter = (
  fixture: RetrieverTestFixture,
): RetrieverTestAdapter => {
  let ledger: RetrieverTestLedgerEntry[] = [];
  const appendSearch = (
    request: TraceSearchRequest,
    context: RetrievalContext,
  ): void => {
    ledger.push(
      Object.freeze({
        operation: "search",
        maximumProviderRequests: context.maximumProviderRequests,
        connectionId: request.connectionId,
        destinationType: request.destinationType,
        queryFingerprint: request.query.fingerprint,
        hasContinuationToken: request.continuationToken !== undefined,
      }),
    );
  };
  const appendGet = (
    request: TraceGetRequest,
    context: RetrievalContext,
  ): void => {
    ledger.push(
      Object.freeze({
        operation: "get",
        maximumProviderRequests: context.maximumProviderRequests,
        connectionId: request.locator.connectionId,
        destinationType: request.locator.destinationType,
        traceId: request.locator.traceId,
      }),
    );
  };
  const failureResult = (behavior: RetrieverTestBehavior): unknown => {
    if (typeof behavior === "object")
      return Promise.resolve(createRetrieverFailure(behavior.failure));
    switch (behavior) {
      case "success":
        return undefined;
      case "throw":
        throw new Error("test retriever throw");
      case "reject":
        return Promise.reject(new Error("test retriever rejection"));
      case "hang":
        return pending();
      case "malformed-response":
        return Promise.resolve(Object.freeze({ ok: true, value: {} }));
    }
  };
  const searchResult = (
    behavior: RetrieverTestBehavior,
    request: TraceSearchRequest,
  ): unknown => {
    const failure = failureResult(behavior);
    if (behavior !== "success") return failure;
    const token = JSON.stringify(request.continuationToken ?? null);
    const selected = fixture.searchCases.find(
      (entry) =>
        entry.queryFingerprint === request.query.fingerprint &&
        JSON.stringify(entry.continuationToken ?? null) === token,
    );
    return Promise.resolve(
      selected
        ? createRetrieverSuccess(selected.page)
        : createRetrieverFailure("invalid-query"),
    );
  };
  const getResult = (behavior: RetrieverTestBehavior): unknown => {
    const failure = failureResult(behavior);
    return behavior === "success"
      ? Promise.resolve(createRetrieverSuccess(fixture.retrievedTrace))
      : failure;
  };
  return Object.freeze({
    createRetriever: (behavior) =>
      createDestinationRetriever({
        search: (request, context) => {
          appendSearch(request, context);
          return searchResult(behavior, request) as never;
        },
        get: (request, context) => {
          appendGet(request, context);
          return getResult(behavior) as never;
        },
      }),
    readRetrievalLedger: () =>
      Object.freeze(ledger.map((entry) => Object.freeze({ ...entry }))),
    reset: () => {
      ledger = [];
    },
  });
};
