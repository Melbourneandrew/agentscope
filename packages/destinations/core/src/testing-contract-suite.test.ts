import type * as ProtocolModule from "@agentscope/protocol";
import type { RedactedCanonicalTrace } from "@agentscope/protocol";
import { createSanitizedCanonicalTraceFixture } from "@agentscope/protocol/testing";
import { describe, expect, it, vi } from "vitest";

const protocolMock = vi.hoisted(() => ({ brands: new WeakSet<object>() }));
vi.mock("@agentscope/protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof ProtocolModule>()),
  isRedactedCanonicalTrace: (value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    protocolMock.brands.has(value),
}));

import {
  createDestinationConnectionId,
  createDestinationTypeId,
} from "./identity.js";
import { createTraceLocator } from "./retrieval-identity.js";
import {
  createRetrievedTrace,
  createRetrieverSearchPage,
  createTraceSummary,
} from "./retrieval-results.js";
import {
  createReporterContractSuite,
  createRetrieverContractSuite,
  createRetrieverContractQueryMatrix,
  DestinationContractAssertionError,
  RETRIEVER_CONTRACT_FIXTURE_VALUES,
} from "./testing-contract-suite.js";
import { createRetrieverTestAdapter } from "./testing-retriever.js";
import { createDestinationTestAdapter } from "./testing.js";

const connectionId = createDestinationConnectionId(
  "destination-connection-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const destinationType = createDestinationTypeId(
  "@agentscope/destination-local-sqlite",
);
const traceId = "0123456789abcdef0123456789abcdef";
const secondTraceId = "1123456789abcdef0123456789abcdef";
const graph: unknown = createSanitizedCanonicalTraceFixture();

const redactedTrace = (identity: string): RedactedCanonicalTrace => {
  const trace = Object.freeze({
    delivery: Object.freeze({ identity }),
  });
  protocolMock.brands.add(trace);
  return trace as RedactedCanonicalTrace;
};

const fixture = () => {
  const locator = createTraceLocator({
    connectionId,
    destinationType,
    traceId,
  });
  const first = createTraceSummary({
    locator,
    startTime: RETRIEVER_CONTRACT_FIXTURE_VALUES.primaryStartTime,
    harness: RETRIEVER_CONTRACT_FIXTURE_VALUES.harness,
    branch: RETRIEVER_CONTRACT_FIXTURE_VALUES.branch,
    models: [RETRIEVER_CONTRACT_FIXTURE_VALUES.model],
    status: "ok",
    spanCount: 3,
    tags: RETRIEVER_CONTRACT_FIXTURE_VALUES.matchingTags,
  });
  const second = createTraceSummary({
    locator: createTraceLocator({
      connectionId,
      destinationType,
      traceId: secondTraceId,
    }),
    startTime: RETRIEVER_CONTRACT_FIXTURE_VALUES.secondaryStartTime,
    harness: RETRIEVER_CONTRACT_FIXTURE_VALUES.harness,
    branch: RETRIEVER_CONTRACT_FIXTURE_VALUES.secondaryBranch,
    models: [RETRIEVER_CONTRACT_FIXTURE_VALUES.secondaryModel],
    status: "ok",
    spanCount: 1,
    tags: RETRIEVER_CONTRACT_FIXTURE_VALUES.secondaryTags,
  });
  const queryCases = createRetrieverContractQueryMatrix({
    primaryTraceId: traceId,
    secondaryTraceId: secondTraceId,
  });
  const searchCases = queryCases.map((queryCase) => {
    const summaries = queryCase.expectedTraceIds.map((id) =>
      id === traceId ? first : second,
    );
    return Object.freeze({
      queryFingerprint: queryCase.query.fingerprint,
      ...(queryCase.continuationToken === undefined
        ? {}
        : { continuationToken: queryCase.continuationToken }),
      page: createRetrieverSearchPage({
        summaries,
        state: queryCase.expectedState,
        ...(queryCase.expectedState === "continuation"
          ? { continuationToken: { offset: 2 } }
          : {}),
        ...(queryCase.expectedState === "partial"
          ? { partialReason: "provider-request-limit" as const }
          : {}),
        consistency:
          queryCase.expectedState === "partial" ? "best-effort" : "snapshot",
        ...(queryCase.expectedState === "exhaustive"
          ? { exactTotal: summaries.length }
          : {}),
      }),
    });
  });
  return {
    locator,
    queryCases,
    searchCases,
    retrievedTrace: createRetrievedTrace({
      locator,
      representation: { kind: "canonical-graph", graph },
      consistency: "snapshot",
    }),
  };
};

describe("shared Reporter contract suite", () => {
  it("passes every Reporter case against the deterministic adapter", async () => {
    const cases = createReporterContractSuite({
      adapter: createDestinationTestAdapter(),
      traces: [redactedTrace("delivery-a"), redactedTrace("delivery-b")],
    });
    expect(Object.isFrozen(cases)).toBe(true);
    expect(cases.map((testCase) => testCase.name)).toContain(
      "reporter:commit-then-lose-acknowledgement",
    );
    for (const testCase of cases) await testCase.run();
  });

  it("reports a precise assertion for a seeded Reporter violation", async () => {
    const adapter = createDestinationTestAdapter();
    const wrongIdentity = redactedTrace("seeded-wrong-identity").delivery
      .identity;
    const invalidAdapter = Object.freeze({
      ...adapter,
      readDeliveryLedger: () =>
        Object.freeze([
          Object.freeze({
            deliveryIdentities: Object.freeze([wrongIdentity]),
            outcome: "accepted" as const,
          }),
        ]),
    });
    const contractCase = createReporterContractSuite({
      adapter: invalidAdapter,
      traces: [redactedTrace("delivery-c")],
    }).find((entry) => entry.name === "reporter:accept")!;
    await expect(contractCase.run()).rejects.toMatchObject({
      code: "destination.contract.reporter.accept.delivery-identity",
    });
  });
});

describe("shared Retriever contract suite", () => {
  it("passes every Retriever case against the in-memory reference", async () => {
    const values = fixture();
    const adapter = createRetrieverTestAdapter(values);
    const cases = createRetrieverContractSuite({
      adapter,
      queryCases: values.queryCases,
      locator: values.locator,
      connectionId,
      destinationType,
      configurationIdentity: "contract-config-v1",
    });
    expect(cases.map((testCase) => testCase.name)).toContain(
      "retriever:failure:rate-limited",
    );
    for (const testCase of cases) await testCase.run();
    const snapshot = adapter.readRetrievalLedger();
    adapter.reset();
    expect(snapshot.length).toBeGreaterThan(0);
    expect(adapter.readRetrievalLedger()).toEqual([]);
  });

  it("reports a precise assertion for a seeded Retriever violation", async () => {
    const values = fixture();
    const ignoredQueryPage = values.searchCases[0]!.page;
    const adapter = createRetrieverTestAdapter({
      retrievedTrace: values.retrievedTrace,
      searchCases: values.searchCases.map((entry) =>
        Object.freeze({ ...entry, page: ignoredQueryPage }),
      ),
    });
    const cases = createRetrieverContractSuite({
      adapter,
      queryCases: values.queryCases,
      locator: values.locator,
      connectionId,
      destinationType,
      configurationIdentity: "contract-config-v1",
    });
    const contractCase = cases.find(
      ({ name }) => name === "retriever:query:trace-id-miss",
    )!;
    await expect(contractCase.run()).rejects.toEqual(
      new DestinationContractAssertionError(
        "destination.contract.retriever.query-trace-id-miss.results",
      ),
    );
    const missingCaseAdapter = createRetrieverTestAdapter({
      retrievedTrace: values.retrievedTrace,
      searchCases: values.searchCases.slice(1),
    });
    const missingCase = createRetrieverContractSuite({
      adapter: missingCaseAdapter,
      queryCases: values.queryCases,
      locator: values.locator,
      connectionId,
      destinationType,
      configurationIdentity: "contract-config-v1",
    })[0]!;
    await expect(missingCase.run()).rejects.toEqual(
      new DestinationContractAssertionError(
        "destination.contract.retriever.query-all.success",
      ),
    );
    expect(() =>
      createRetrieverContractSuite({
        adapter,
        queryCases: [...values.queryCases] as never,
        locator: values.locator,
        connectionId,
        destinationType,
        configurationIdentity: "contract-config-v1",
      }),
    ).toThrowError(
      new DestinationContractAssertionError(
        "destination.contract.retriever.query-matrix",
      ),
    );
    const differentlyBoundMatrix = createRetrieverContractQueryMatrix({
      primaryTraceId: secondTraceId,
      secondaryTraceId: "2123456789abcdef0123456789abcdef",
    });
    expect(() =>
      createRetrieverContractSuite({
        adapter,
        queryCases: differentlyBoundMatrix,
        locator: values.locator,
        connectionId,
        destinationType,
        configurationIdentity: "contract-config-v1",
      }),
    ).toThrowError(
      new DestinationContractAssertionError(
        "destination.contract.retriever.query-matrix",
      ),
    );
  });

  it("rejects invalid family-owned query-matrix trace identities", () => {
    for (const invalid of ["0".repeat(32), "A".repeat(32), "short", traceId]) {
      expect(() =>
        createRetrieverContractQueryMatrix({
          primaryTraceId: traceId,
          secondaryTraceId: invalid,
        }),
      ).toThrowError(
        new DestinationContractAssertionError(
          "destination.contract.retriever.query-matrix-trace-ids",
        ),
      );
    }
  });
});
