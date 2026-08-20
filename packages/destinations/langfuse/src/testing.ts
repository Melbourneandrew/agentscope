import {
  invokeDestinationReporterForTesting,
  prepareDestinationReporterForTesting,
  type DestinationReporterTestPreparation,
  type DestinationTestAdapter,
  type ReporterTestBehavior,
  type ReporterTestLedgerEntry,
} from "@agentscope/destinations-core/testing";
import {
  createDestinationReporter,
  createReporterReceipt,
} from "@agentscope/destinations-core";
import {
  createSanitizedRedactedCanonicalTraceFixture,
  type SanitizedRedactedTraceFixtureOptions,
} from "@agentscope/protocol/testing";
import type { RedactedCanonicalTrace } from "@agentscope/protocol";

import { langfuseDestinationDescriptor } from "./reporter/index.js";

export {
  LANGFUSE_FILTER_CONFORMANCE_FIXTURES,
  LANGFUSE_SANITIZED_HTTP_FIXTURES,
  type LangfuseFilterConformanceFixture,
  type LangfuseHttpFixture,
  type LangfuseJson,
} from "./compatibility-fixtures.js";

export type LangfuseReporterTestHarnessInput = Readonly<{
  executor: DestinationReporterTestPreparation["executor"];
  profileId?:
    | "langfuse-cloud-v4"
    | "langfuse-self-hosted-v4"
    | "langfuse-self-hosted-v3-events-3.225.3";
}>;

export type LangfuseReporterTestAttempt = Readonly<{
  trace?: SanitizedRedactedTraceFixtureOptions;
  signal?: AbortSignal;
  timeoutMilliseconds?: number;
}>;

const prepareLangfuseReporter = (
  executor: DestinationReporterTestPreparation["executor"],
  profileId: LangfuseReporterTestHarnessInput["profileId"],
) =>
  prepareDestinationReporterForTesting({
    descriptor: langfuseDestinationDescriptor,
    settings: {
      endpoint: "http://127.0.0.1:4318",
      allowInsecureLoopback: true,
      profileId: profileId ?? "langfuse-cloud-v4",
      compatibilityManifestId:
        langfuseDestinationDescriptor.defaultSettings.compatibilityManifestId,
      encoding: "application/json",
    },
    credentials: {
      "public-key": "pk-fixture",
      "secret-key": "sk-fixture",
    },
    executor,
  });

export const createLangfuseReporterTestHarness = (
  input: LangfuseReporterTestHarnessInput,
) => {
  const reporter = prepareLangfuseReporter(input.executor, input.profileId);
  return Object.freeze({
    report: (attempt: LangfuseReporterTestAttempt = {}) =>
      invokeDestinationReporterForTesting(reporter, {
        traces: [createSanitizedRedactedCanonicalTraceFixture(attempt.trace)],
        ...(attempt.signal === undefined ? {} : { signal: attempt.signal }),
        ...(attempt.timeoutMilliseconds === undefined
          ? {}
          : { timeoutMilliseconds: attempt.timeoutMilliseconds }),
      }),
  });
};

const encodedResponse = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

type TestExecutorRequest = Parameters<
  DestinationReporterTestPreparation["executor"]
>[0];

const wireTraceIds = (request: TestExecutorRequest): readonly string[] => {
  const decoded = JSON.parse(new TextDecoder().decode(request.body)) as {
    resourceSpans: {
      scopeSpans: { spans: { traceId: string }[] }[];
    }[];
  };
  return Object.freeze(
    decoded.resourceSpans.map((resource) => {
      const identifiers = new Set(
        resource.scopeSpans.flatMap((scope) =>
          scope.spans.map((span) => span.traceId),
        ),
      );
      /* v8 ignore next 2 -- reached only if the concrete Reporter emits an empty or mixed-identity resource, which must fail the shared contract. */
      if (identifiers.size !== 1)
        throw new Error("destination.langfuse.testing.invalid");
      return [...identifiers][0]!;
    }),
  );
};

const executorForBehavior = (
  behavior: ReporterTestBehavior,
  recordRequest: (request: TestExecutorRequest) => void,
): DestinationReporterTestPreparation["executor"] => {
  switch (behavior) {
    case "accept":
    case "deadline-before-send":
      return (request) => {
        recordRequest(request);
        return Promise.resolve({
          status: 200,
          headers: { "content-type": "application/json" },
          body: encodedResponse({}),
        });
      };
    case "definite-reject":
      return (request) => {
        recordRequest(request);
        return Promise.resolve({
          status: 400,
          headers: {},
          body: encodedResponse({}),
        });
      };
    case "unavailable-before-send":
      return (request) => {
        recordRequest(request);
        return Promise.resolve({
          status: 429,
          headers: {},
          body: encodedResponse({}),
        });
      };
    case "malformed-receipt":
      return (request) => {
        recordRequest(request);
        return Promise.resolve({
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode("{"),
        });
      };
    case "commit-then-lose-acknowledgement":
      return (request) => {
        recordRequest(request);
        return Promise.reject(new Error("test acknowledgement loss"));
      };
    case "throw-before-receipt":
      return (request) => {
        recordRequest(request);
        throw new Error("test transport throw");
      };
    case "hang":
      return (request) => {
        recordRequest(request);
        return new Promise(() => undefined);
      };
  }
};

const traceId = (trace: RedactedCanonicalTrace): string => {
  const identifiers = new Set(
    trace.graph.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) =>
        scope.spans.map((span) => span.traceId),
      ),
    ),
  );
  /* v8 ignore next 2 -- Protocol-branded traces bind one trace ID; a violation is retained as a fixed test-adapter failure. */
  if (identifiers.size !== 1)
    throw new Error("destination.langfuse.testing.invalid");
  return [...identifiers][0]!;
};

const ledgerOutcome = (
  behavior: ReporterTestBehavior,
): ReporterTestLedgerEntry["outcome"] => {
  switch (behavior) {
    case "accept":
      return "accepted";
    case "definite-reject":
      return "rejected";
    case "unavailable-before-send":
      return "unavailable";
    default:
      return "no-receipt";
  }
};

export const createLangfuseDestinationTestAdapter =
  (): DestinationTestAdapter => {
    let ledger: ReporterTestLedgerEntry[] = [];
    let resolveDeliveryAttempt: (() => void) | undefined;
    let deliveryAttempt = new Promise<void>((resolve) => {
      resolveDeliveryAttempt = resolve;
    });
    return Object.freeze({
      createReporter: (behavior) => {
        let identityByTraceId = new Map<
          string,
          ReporterTestLedgerEntry["deliveryIdentities"][number]
        >();
        const recordRequest = (request: TestExecutorRequest): void => {
          const deliveryIdentities = wireTraceIds(request).map((identifier) => {
            const identity = identityByTraceId.get(identifier);
            /* v8 ignore next 2 -- reached only if the concrete Reporter mutates or fabricates a wire trace ID, which must fail the shared contract. */
            if (identity === undefined)
              throw new Error("destination.langfuse.testing.invalid");
            return identity;
          });
          ledger.push(
            Object.freeze({
              deliveryIdentities: Object.freeze(deliveryIdentities),
              outcome: ledgerOutcome(behavior),
            }),
          );
          resolveDeliveryAttempt?.();
        };
        const actual = prepareLangfuseReporter(
          executorForBehavior(behavior, recordRequest),
          undefined,
        );
        return createDestinationReporter({
          report: (attempt) => {
            identityByTraceId = new Map(
              attempt.traces.map((trace) => [
                traceId(trace),
                trace.delivery.identity,
              ]),
            );
            if (behavior === "deadline-before-send") {
              ledger.push(
                Object.freeze({
                  deliveryIdentities: Object.freeze(
                    attempt.traces.map((trace) => trace.delivery.identity),
                  ),
                  outcome: "deadline-exceeded",
                }),
              );
              return Promise.resolve(
                createReporterReceipt("deadline-exceeded"),
              );
            }
            return invokeDestinationReporterForTesting(actual, attempt);
          },
        });
      },
      readDeliveryLedger: () =>
        Object.freeze(
          ledger.map((entry) =>
            Object.freeze({
              deliveryIdentities: Object.freeze([...entry.deliveryIdentities]),
              outcome: entry.outcome,
            }),
          ),
        ),
      waitForDeliveryAttempt: () => deliveryAttempt,
      reset: () => {
        ledger = [];
        deliveryAttempt = new Promise<void>((resolve) => {
          resolveDeliveryAttempt = resolve;
        });
      },
    });
  };
