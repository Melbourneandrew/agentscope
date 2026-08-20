import type { RedactedCanonicalTrace } from "@agentscope/protocol";
import { isRedactedCanonicalTrace } from "@agentscope/protocol";

import { createReporterDeadline } from "./deadline.js";
import type { DestinationConnectionId, DestinationTypeId } from "./identity.js";
import type { JsonValue } from "./plain-data.js";
import { invokeReporter, type ReporterOutcome } from "./reporter.js";
import {
  createTraceSearchCursor,
  readTraceSearchCursor,
} from "./retrieval-cursor.js";
import { createTraceLocator, type TraceLocator } from "./retrieval-identity.js";
import {
  normalizeTraceSearchQuery,
  TRACE_SEARCH_ORDERINGS,
  type TraceSearchOrdering,
  type TraceSearchInput,
  type TraceSearchQuery,
} from "./retrieval-query.js";
import {
  createRetrievalContext,
  createTraceGetRequest,
  createTraceSearchRequest,
  invokeRetrieverGet,
  invokeRetrieverSearch,
  RETRIEVER_FAILURE_CODES,
  type TraceGetRequest,
  type TraceSearchRequest,
} from "./retriever.js";
import {
  REPORTER_TEST_BEHAVIORS,
  type DestinationTestAdapter,
  type ReporterTestBehavior,
} from "./testing-reporter.js";
import type { RetrieverTestAdapter } from "./testing-retriever.js";

export type DestinationContractCase = Readonly<{
  name: string;
  run: () => Promise<void>;
}>;

export class DestinationContractAssertionError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "DestinationContractAssertionError";
  }
}

const assert = (condition: boolean, code: string): void => {
  if (!condition) throw new DestinationContractAssertionError(code);
};

export type ReporterContractSuiteInput = Readonly<{
  adapter: DestinationTestAdapter;
  traces: readonly [RedactedCanonicalTrace, ...RedactedCanonicalTrace[]];
}>;

const reporterOutcomeByBehavior: Readonly<Record<string, ReporterOutcome>> =
  Object.freeze({
    accept: "accepted",
    "definite-reject": "rejected",
    "unavailable-before-send": "unavailable",
    "deadline-before-send": "deadline-exceeded",
    "commit-then-lose-acknowledgement": "outcome-unknown",
    "malformed-receipt": "outcome-unknown",
    "throw-before-receipt": "outcome-unknown",
    hang: "outcome-unknown",
  });

const runReporterContractCase = async (
  input: ReporterContractSuiteInput,
  behavior: ReporterTestBehavior,
): Promise<void> => {
  input.adapter.reset();
  const controller = new AbortController();
  const resultPromise = invokeReporter(input.adapter.createReporter(behavior), {
    traces: input.traces,
    signal: controller.signal,
    deadline: createReporterDeadline(1_000),
  });
  if (behavior === "hang") {
    const attempted = await Promise.race([
      input.adapter.waitForDeliveryAttempt().then(() => true),
      resultPromise.then(() => false),
    ]);
    assert(attempted, "destination.contract.reporter.hang.delivery-attempt");
    controller.abort();
  }
  const result = await resultPromise;
  assert(
    result.outcome === reporterOutcomeByBehavior[behavior],
    `destination.contract.reporter.${behavior}.outcome`,
  );
  const ledger = input.adapter.readDeliveryLedger();
  assert(
    ledger.length === 1,
    `destination.contract.reporter.${behavior}.ledger-count`,
  );
  assert(
    ledger[0]?.deliveryIdentities.join("\0") ===
      input.traces.map((trace) => trace.delivery.identity).join("\0"),
    `destination.contract.reporter.${behavior}.delivery-identity`,
  );
};

export const createReporterContractSuite = (
  input: ReporterContractSuiteInput,
): readonly DestinationContractCase[] =>
  Object.freeze([
    ...REPORTER_TEST_BEHAVIORS.map((behavior) =>
      Object.freeze({
        name: `reporter:${behavior}`,
        run: () => runReporterContractCase(input, behavior),
      }),
    ),
    Object.freeze({
      name: "reporter:pre-aborted",
      run: async (): Promise<void> => {
        input.adapter.reset();
        const controller = new AbortController();
        controller.abort();
        const result = await invokeReporter(
          input.adapter.createReporter("accept"),
          {
            traces: input.traces,
            signal: controller.signal,
            deadline: createReporterDeadline(1_000),
          },
        );
        assert(
          result.outcome === "deadline-exceeded" &&
            input.adapter.readDeliveryLedger().length === 0,
          "destination.contract.reporter.pre-aborted",
        );
      },
    }),
    Object.freeze({
      name: "reporter:rejects-unbranded-clone",
      run: async (): Promise<void> => {
        input.adapter.reset();
        let rejected = false;
        try {
          await invokeReporter(input.adapter.createReporter("accept"), {
            traces: [{ ...input.traces[0] }] as never,
            signal: new AbortController().signal,
            deadline: createReporterDeadline(1_000),
          });
        } catch {
          rejected = true;
        }
        assert(
          rejected && input.adapter.readDeliveryLedger().length === 0,
          "destination.contract.reporter.redaction-brand",
        );
      },
    }),
    Object.freeze({
      name: "reporter:delivery-stability",
      run: async (): Promise<void> => {
        input.adapter.reset();
        for (const trace of input.traces) {
          await invokeReporter(input.adapter.createReporter("accept"), {
            traces: [trace],
            signal: new AbortController().signal,
            deadline: createReporterDeadline(1_000),
          });
        }
        const expected = input.traces.map((trace) => trace.delivery.identity);
        const observed = input.adapter
          .readDeliveryLedger()
          .flatMap((entry) => entry.deliveryIdentities);
        assert(
          observed.join("\0") === expected.join("\0"),
          "destination.contract.reporter.delivery-stability",
        );
      },
    }),
    Object.freeze({
      name: "reporter:ledger-snapshot",
      run: async (): Promise<void> => {
        input.adapter.reset();
        await invokeReporter(input.adapter.createReporter("accept"), {
          traces: input.traces,
          signal: new AbortController().signal,
          deadline: createReporterDeadline(1_000),
        });
        const before = input.adapter.readDeliveryLedger();
        input.adapter.reset();
        assert(
          before.length === 1 &&
            input.adapter.readDeliveryLedger().length === 0 &&
            Object.isFrozen(before) &&
            Object.isFrozen(before[0]?.deliveryIdentities),
          "destination.contract.reporter.ledger-snapshot",
        );
      },
    }),
  ]);

export const RETRIEVER_CONTRACT_QUERY_CASE_NAMES = Object.freeze([
  "all",
  "trace-id-match",
  "trace-id-miss",
  "from-match",
  "from-miss",
  "to-match",
  "to-miss",
  "harness-match",
  "harness-miss",
  "branch-match",
  "branch-miss",
  "model-match",
  "model-miss",
  "session-id-match",
  "session-id-miss",
  "tags-match",
  "tags-miss",
  "conjunction-match",
  "conjunction-miss",
  "limit",
  "continuation",
  "partial",
] as const);

export type RetrieverContractQueryCaseName =
  (typeof RETRIEVER_CONTRACT_QUERY_CASE_NAMES)[number];

export type RetrieverContractQueryCase = Readonly<{
  name: RetrieverContractQueryCaseName;
  query: TraceSearchQuery;
  expectedTraceIds: readonly string[];
  expectedState: "exhaustive" | "continuation" | "partial";
  continuationToken?: JsonValue;
  expectedContinuationToken?: JsonValue;
}>;

declare const retrieverContractQueryMatrixBrand: unique symbol;
export type RetrieverContractQueryMatrix =
  readonly RetrieverContractQueryCase[] & {
    readonly [retrieverContractQueryMatrixBrand]: "RetrieverContractQueryMatrix";
  };

export const RETRIEVER_CONTRACT_FIXTURE_VALUES = Object.freeze({
  commandStartedAt: "2026-01-03T00:00:00.000Z",
  primaryStartTime: "2026-01-01T10:00:00.000Z",
  secondaryStartTime: "2026-01-01T09:00:00.000Z",
  harness: "codex",
  nonmatchingHarness: "claude-code",
  branch: "main",
  secondaryBranch: "release",
  nonmatchingBranch: "other",
  model: "gpt-5",
  secondaryModel: "gpt-4",
  nonmatchingModel: "gpt-3.5",
  sessionId: "session-a",
  secondarySessionId: "session-b",
  nonmatchingSessionId: "session-missing",
  matchingTags: Object.freeze(["contract", "safe"]),
  secondaryTags: Object.freeze(["contract"]),
  missingTag: "missing",
});

type QueryMatrixBinding = Readonly<{
  primaryTraceId: string;
  missingTraceId: string;
  ordering: TraceSearchOrdering;
}>;
const queryMatrixRegistry = new WeakMap<object, QueryMatrixBinding>();
const traceIdPattern = /^[0-9a-f]{32}$/u;

const contractQuery = (
  input: TraceSearchInput,
  ordering: TraceSearchOrdering,
): TraceSearchQuery =>
  normalizeTraceSearchQuery(input, {
    commandStartedAt: RETRIEVER_CONTRACT_FIXTURE_VALUES.commandStartedAt,
    knownHarnessIds: [
      RETRIEVER_CONTRACT_FIXTURE_VALUES.harness,
      RETRIEVER_CONTRACT_FIXTURE_VALUES.nonmatchingHarness,
    ],
    ordering,
  });

type QueryCaseInput = Readonly<{
  name: RetrieverContractQueryCaseName;
  input: TraceSearchInput;
  expectedTraceIds: readonly string[];
  expectedState?: "exhaustive" | "continuation" | "partial";
  continuationToken?: JsonValue;
  expectedContinuationToken?: JsonValue;
}>;

const freezeQueryCase = (
  input: QueryCaseInput,
  ordering: TraceSearchOrdering,
): RetrieverContractQueryCase =>
  Object.freeze({
    name: input.name,
    query: contractQuery(input.input, ordering),
    expectedTraceIds: Object.freeze([...input.expectedTraceIds]),
    expectedState: input.expectedState ?? "exhaustive",
    ...(input.continuationToken === undefined
      ? {}
      : { continuationToken: input.continuationToken }),
    ...(input.expectedContinuationToken === undefined
      ? {}
      : { expectedContinuationToken: input.expectedContinuationToken }),
  });

const scalarQueryCases = (
  primary: string,
  secondary: string,
  missingTraceId: string,
  ordering: TraceSearchOrdering,
): readonly RetrieverContractQueryCase[] => {
  const values = RETRIEVER_CONTRACT_FIXTURE_VALUES;
  const freezeCase = (input: QueryCaseInput): RetrieverContractQueryCase =>
    freezeQueryCase(input, ordering);
  return [
    freezeCase({
      name: "all",
      input: {},
      expectedTraceIds: [primary, secondary],
    }),
    freezeCase({
      name: "trace-id-match",
      input: { traceId: primary },
      expectedTraceIds: [primary],
    }),
    freezeCase({
      name: "trace-id-miss",
      input: { traceId: missingTraceId },
      expectedTraceIds: [],
    }),
    freezeCase({
      name: "from-match",
      input: { from: "2026-01-01T09:30:00Z" },
      expectedTraceIds: [primary],
    }),
    freezeCase({
      name: "from-miss",
      input: { from: "2026-01-02T00:00:00Z" },
      expectedTraceIds: [],
    }),
    freezeCase({
      name: "to-match",
      input: { to: "2026-01-01T10:30:00Z" },
      expectedTraceIds: [primary, secondary],
    }),
    freezeCase({
      name: "to-miss",
      input: { to: "2025-12-31T00:00:00Z" },
      expectedTraceIds: [],
    }),
    freezeCase({
      name: "harness-match",
      input: { harness: values.harness },
      expectedTraceIds: [primary, secondary],
    }),
    freezeCase({
      name: "harness-miss",
      input: { harness: values.nonmatchingHarness },
      expectedTraceIds: [],
    }),
    freezeCase({
      name: "branch-match",
      input: { branch: values.branch },
      expectedTraceIds: [primary],
    }),
    freezeCase({
      name: "branch-miss",
      input: { branch: values.nonmatchingBranch },
      expectedTraceIds: [],
    }),
    freezeCase({
      name: "model-match",
      input: { model: values.model },
      expectedTraceIds: [primary],
    }),
    freezeCase({
      name: "model-miss",
      input: { model: values.nonmatchingModel },
      expectedTraceIds: [],
    }),
    freezeCase({
      name: "session-id-match",
      input: { sessionId: values.sessionId },
      expectedTraceIds: [primary],
    }),
    freezeCase({
      name: "session-id-miss",
      input: { sessionId: values.nonmatchingSessionId },
      expectedTraceIds: [],
    }),
  ];
};

const compoundQueryCases = (
  primary: string,
  secondary: string,
  ordering: TraceSearchOrdering,
): readonly RetrieverContractQueryCase[] => {
  const values = RETRIEVER_CONTRACT_FIXTURE_VALUES;
  const freezeCase = (input: QueryCaseInput): RetrieverContractQueryCase =>
    freezeQueryCase(input, ordering);
  return [
    freezeCase({
      name: "tags-match",
      input: { tags: values.matchingTags },
      expectedTraceIds: [primary],
    }),
    freezeCase({
      name: "tags-miss",
      input: { tags: [values.missingTag] },
      expectedTraceIds: [],
    }),
    freezeCase({
      name: "conjunction-match",
      input: {
        traceId: primary,
        harness: values.harness,
        branch: values.branch,
        model: values.model,
        sessionId: values.sessionId,
        tags: values.matchingTags,
      },
      expectedTraceIds: [primary],
    }),
    freezeCase({
      name: "conjunction-miss",
      input: {
        traceId: primary,
        harness: values.harness,
        branch: values.nonmatchingBranch,
        model: values.model,
        sessionId: values.sessionId,
        tags: values.matchingTags,
      },
      expectedTraceIds: [],
    }),
    freezeCase({
      name: "limit",
      input: { limit: 1 },
      expectedTraceIds: [primary],
      expectedState: "continuation",
      expectedContinuationToken: Object.freeze({ offset: 1 }),
    }),
    freezeCase({
      name: "continuation",
      input: { limit: 1 },
      expectedTraceIds: [secondary],
      expectedState: "exhaustive",
      continuationToken: Object.freeze({ offset: 1 }),
    }),
    freezeCase({
      name: "partial",
      input: { model: values.model, limit: 2 },
      expectedTraceIds: [primary],
      expectedState: "partial",
    }),
  ];
};

export const createRetrieverContractQueryMatrix = (input: {
  primaryTraceId: string;
  secondaryTraceId: string;
  ordering: TraceSearchOrdering;
}): RetrieverContractQueryMatrix => {
  const primary = input.primaryTraceId;
  const secondary = input.secondaryTraceId;
  const ordering = input.ordering;
  assert(
    traceIdPattern.test(primary) &&
      primary !== "0".repeat(32) &&
      traceIdPattern.test(secondary) &&
      secondary !== "0".repeat(32) &&
      primary !== secondary,
    "destination.contract.retriever.query-matrix-trace-ids",
  );
  assert(
    TRACE_SEARCH_ORDERINGS.includes(ordering),
    "destination.contract.retriever.query-matrix-ordering",
  );
  const missingTraceId = ["f", "e", "d"]
    .map((digit) => digit.repeat(32))
    .find((candidate) => candidate !== primary && candidate !== secondary)!;
  const cases = Object.freeze([
    ...scalarQueryCases(primary, secondary, missingTraceId, ordering),
    ...compoundQueryCases(primary, secondary, ordering),
  ]) as RetrieverContractQueryMatrix;
  queryMatrixRegistry.set(
    cases,
    Object.freeze({
      primaryTraceId: primary,
      missingTraceId,
      ordering,
    }),
  );
  return cases;
};

export type RetrieverContractSuiteInput = Readonly<{
  adapter: RetrieverTestAdapter;
  queryCases: RetrieverContractQueryMatrix;
  locator: TraceLocator;
  connectionId: DestinationConnectionId;
  destinationType: DestinationTypeId;
  configurationIdentity: string;
}>;

const context = (timeout = 1_000) =>
  createRetrievalContext({
    signal: new AbortController().signal,
    deadline: createReporterDeadline(timeout),
    maximumResponseBytes: 1_000_000,
    maximumProviderRequests: 4,
  });

const cursorToken = (
  input: RetrieverContractSuiteInput,
  queryCase: RetrieverContractQueryCase,
): JsonValue | undefined => {
  if (queryCase.continuationToken === undefined) return undefined;
  const binding = {
    connectionId: input.connectionId,
    destinationType: input.destinationType,
    configurationIdentity: input.configurationIdentity,
    queryFingerprint: queryCase.query.fingerprint,
    upperTimeBound: queryCase.query.to,
  };
  const cursor = createTraceSearchCursor(binding, queryCase.continuationToken);
  let wrongBindingRejected = false;
  try {
    readTraceSearchCursor(cursor, {
      ...binding,
      configurationIdentity: `${input.configurationIdentity}-changed`,
    });
  } catch {
    wrongBindingRejected = true;
  }
  assert(wrongBindingRejected, "destination.contract.retriever.cursor-binding");
  return readTraceSearchCursor(cursor, binding);
};

const queryContractCase = (
  input: RetrieverContractSuiteInput,
  queryCase: RetrieverContractQueryCase,
): DestinationContractCase =>
  Object.freeze({
    name: `retriever:query:${queryCase.name}`,
    run: async (): Promise<void> => {
      input.adapter.reset();
      const retriever = input.adapter.createRetriever("success");
      const token = cursorToken(input, queryCase);
      const request = createTraceSearchRequest(
        queryCase.query,
        {
          connectionId: input.connectionId,
          destinationType: input.destinationType,
        },
        token,
      );
      const result = await invokeRetrieverSearch(retriever, request, context());
      if (!result.ok)
        throw new DestinationContractAssertionError(
          `destination.contract.retriever.query-${queryCase.name}.success`,
        );
      const observed = result.value.summaries.map(
        (summary) => summary.locator.traceId,
      );
      assert(
        observed.join("\0") === queryCase.expectedTraceIds.join("\0"),
        `destination.contract.retriever.query-${queryCase.name}.results`,
      );
      assert(
        result.ok && result.value.state === queryCase.expectedState,
        `destination.contract.retriever.query-${queryCase.name}.state`,
      );
      assert(
        JSON.stringify(result.value.continuationToken) ===
          JSON.stringify(queryCase.expectedContinuationToken),
        `destination.contract.retriever.query-${queryCase.name}.continuation`,
      );
      const ledger = input.adapter.readRetrievalLedger();
      assert(
        ledger.length === 1 &&
          ledger[0]?.operation === "search" &&
          ledger[0].connectionId === input.connectionId &&
          ledger[0].destinationType === input.destinationType &&
          ledger[0].maximumProviderRequests === 4 &&
          ledger[0].queryFingerprint === queryCase.query.fingerprint &&
          ledger[0].hasContinuationToken ===
            (queryCase.continuationToken !== undefined),
        `destination.contract.retriever.query-${queryCase.name}.binding`,
      );
    },
  });

const primaryRetrieverCases = (
  input: RetrieverContractSuiteInput,
  searchRequest: TraceSearchRequest,
  getRequest: TraceGetRequest,
): DestinationContractCase[] => [
  Object.freeze({
    name: "retriever:get-success",
    run: async (): Promise<void> => {
      input.adapter.reset();
      const get = await invokeRetrieverGet(
        input.adapter.createRetriever("success"),
        getRequest,
        context(),
      );
      assert(get.ok, "destination.contract.retriever.get-success");
      assert(
        get.ok && !isRedactedCanonicalTrace(get.value),
        "destination.contract.retriever.unbranded-handoff",
      );
      const ledger = input.adapter.readRetrievalLedger();
      assert(
        ledger.length === 1 &&
          ledger[0]?.operation === "get" &&
          ledger[0].traceId === input.locator.traceId &&
          ledger[0].connectionId === input.connectionId &&
          ledger[0].destinationType === input.destinationType &&
          ledger[0].maximumProviderRequests === 4,
        "destination.contract.retriever.get-binding",
      );
    },
  }),
  Object.freeze({
    name: "retriever:get-missing",
    run: async (): Promise<void> => {
      input.adapter.reset();
      const matrixBinding = queryMatrixRegistry.get(input.queryCases)!;
      const missingLocator = createTraceLocator({
        connectionId: input.connectionId,
        destinationType: input.destinationType,
        traceId: matrixBinding.missingTraceId,
      });
      const result = await invokeRetrieverGet(
        input.adapter.createRetriever("success"),
        createTraceGetRequest(missingLocator, {
          connectionId: input.connectionId,
          destinationType: input.destinationType,
        }),
        context(),
      );
      const ledger = input.adapter.readRetrievalLedger();
      assert(
        !result.ok &&
          result.code === "not-found" &&
          ledger.length === 1 &&
          ledger[0]?.traceId === matrixBinding.missingTraceId,
        "destination.contract.retriever.get-missing",
      );
    },
  }),
  Object.freeze({
    name: "retriever:pre-aborted",
    run: async (): Promise<void> => {
      input.adapter.reset();
      const controller = new AbortController();
      controller.abort();
      const abortedContext = createRetrievalContext({
        signal: controller.signal,
        deadline: createReporterDeadline(1_000),
        maximumResponseBytes: 1_000_000,
        maximumProviderRequests: 4,
      });
      const result = await invokeRetrieverSearch(
        input.adapter.createRetriever("success"),
        searchRequest,
        abortedContext,
      );
      assert(
        !result.ok &&
          result.code === "deadline-exceeded" &&
          input.adapter.readRetrievalLedger().length === 0,
        "destination.contract.retriever.pre-aborted",
      );
    },
  }),
];

export const createRetrieverContractSuite = (
  input: RetrieverContractSuiteInput,
): readonly DestinationContractCase[] => {
  const binding = Object.freeze({
    connectionId: input.connectionId,
    destinationType: input.destinationType,
  });
  assert(
    queryMatrixRegistry.get(input.queryCases)?.primaryTraceId ===
      input.locator.traceId &&
      input.queryCases.every(
        (queryCase) =>
          queryCase.query.ordering ===
          queryMatrixRegistry.get(input.queryCases)?.ordering,
      ),
    "destination.contract.retriever.query-matrix",
  );
  const firstQuery = input.queryCases[0]!;
  const searchRequest = createTraceSearchRequest(firstQuery.query, binding);
  const getRequest = createTraceGetRequest(input.locator, binding);
  const cases = [
    ...input.queryCases.map((queryCase) => queryContractCase(input, queryCase)),
    ...primaryRetrieverCases(input, searchRequest, getRequest),
  ];
  for (const code of RETRIEVER_FAILURE_CODES) {
    const behavior = Object.freeze({ failure: code });
    cases.push(
      Object.freeze({
        name: `retriever:failure:${code}`,
        run: async (): Promise<void> => {
          const retriever = input.adapter.createRetriever(behavior);
          const search = await invokeRetrieverSearch(
            retriever,
            searchRequest,
            context(),
          );
          const get = await invokeRetrieverGet(
            retriever,
            getRequest,
            context(),
          );
          assert(
            !search.ok && search.code === code && !get.ok && get.code === code,
            `destination.contract.retriever.failure-${code}`,
          );
        },
      }),
    );
  }
  for (const behavior of [
    "throw",
    "reject",
    "malformed-response",
    "hang",
  ] as const) {
    cases.push(
      Object.freeze({
        name: `retriever:${behavior}`,
        run: async (): Promise<void> => {
          const retriever = input.adapter.createRetriever(behavior);
          const search = await invokeRetrieverSearch(
            retriever,
            searchRequest,
            context(behavior === "hang" ? 1 : 1_000),
          );
          const get = await invokeRetrieverGet(
            retriever,
            getRequest,
            context(behavior === "hang" ? 1 : 1_000),
          );
          const expected =
            behavior === "malformed-response"
              ? "malformed-response"
              : behavior === "hang"
                ? "deadline-exceeded"
                : "unavailable";
          assert(
            !search.ok &&
              search.code === expected &&
              !get.ok &&
              get.code === expected,
            `destination.contract.retriever.${behavior}`,
          );
        },
      }),
    );
  }
  return Object.freeze(cases);
};
