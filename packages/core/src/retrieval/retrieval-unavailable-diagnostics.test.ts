import {
  compileDestinationRegistry,
  createDestinationReporter,
  createDestinationRetriever,
  createReporterReceipt,
  createRetrievedTrace,
  createRetrieverFailure,
  createRetrieverSuccess,
  defineDestinationDescriptor,
  type RetrieverFailureCode,
} from "@agentscope/destinations-core";
import { parseCanonicalTraceGraph } from "@agentscope/protocol";
import { createSanitizedCanonicalTraceFixture } from "@agentscope/protocol/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { compileCredentialBackendRegistry } from "../configuration/credential-adapter.js";
import { parseAgentscopeConfiguration } from "../configuration/schema.js";
import {
  BUILTIN_REDACTION_POLICY_REFERENCES,
  DEFAULT_REDACTION_POLICY_REGISTRY,
} from "../redaction/policy.js";
import {
  createCoreRetrievalRuntime,
  getConfiguredTrace,
  searchConfiguredTraces,
} from "./orchestration.js";
import { failure } from "./retrieval-failure.js";

const graph = parseCanonicalTraceGraph(createSanitizedCanonicalTraceFixture());
const traceId = graph.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.traceId;
const input = Object.freeze({ destinationName: "archive", traceId });
const connectionId = `destination-connection-v1-${"a".repeat(64)}`;
const settingsSchema = z.strictObject({});
void settingsSchema.shape;
z.toJSONSchema(settingsSchema);

const fixture = (
  options: Readonly<{
    preparationFault?: boolean;
    getFault?: Error;
    returned?: unknown;
    code?: RetrieverFailureCode;
    signal?: AbortSignal;
  }> = {},
) => {
  let calls = 0;
  const descriptor = defineDestinationDescriptor({
    descriptorVersion: 1,
    destinationType: "@agentscope/destination-diagnostic-test",
    commandName: "diagnostic-test",
    settingsVersion: 1,
    settingsSchema,
    defaultSettings: {},
    credentialSlots: [],
    documentationPath: "/docs/destinations/diagnostic-test",
    deliveryIdentitySupport: "duplicates-possible",
    transport: { kind: "local" },
    createReporter: () =>
      createDestinationReporter({
        report: () => Promise.resolve(createReporterReceipt("accepted")),
      }),
    retrievalOrdering: "start-time-desc-trace-id-asc",
    createRetriever: () => {
      if (options.preparationFault) throw new Error("SYNTHETIC_BODY");
      return createDestinationRetriever({
        search: () => Promise.resolve(createRetrieverFailure("unavailable")),
        get: (request) => {
          calls += 1;
          if (options.getFault !== undefined)
            return Promise.reject(options.getFault);
          if (options.returned !== undefined)
            return Promise.resolve(options.returned as never);
          if (options.code)
            return Promise.resolve(createRetrieverFailure(options.code));
          return Promise.resolve(
            createRetrieverSuccess(
              createRetrievedTrace({
                locator: request.locator,
                representation: { kind: "canonical-graph", graph },
                consistency: "snapshot",
              }),
            ),
          );
        },
      });
    },
  });
  const destinationRegistry = compileDestinationRegistry([descriptor]);
  const configuration = parseAgentscopeConfiguration(
    {
      configurationVersion: 2,
      generation: 1,
      destinations: {
        "@agentscope/destination-diagnostic-test": {
          namespaceVersion: 1,
          settingsVersion: 1,
          connections: [
            {
              connectionId,
              name: "archive",
              settings: {},
              credentialReferences: {},
            },
          ],
        },
      },
      routing: {
        version: 1,
        selectedConnectionIds: [],
        hookDeadlineMilliseconds: 2_000,
      },
      policy: {
        version: 1,
        reference: BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
      },
    },
    destinationRegistry,
  );
  return {
    calls: () => calls,
    runtime: createCoreRetrievalRuntime({
      configuration,
      policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
      credentialBackendRegistry: compileCredentialBackendRegistry([]),
      transportExecutor: () => Promise.reject(new Error("unused transport")),
      timeoutMilliseconds: 2_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
  };
};

describe("Core-owned unavailable get diagnostics", () => {
  it("distinguishes preparation failure without invoking the adapter", async () => {
    const current = fixture({ preparationFault: true });
    expect(await getConfiguredTrace(current.runtime, input)).toEqual({
      ok: false,
      code: "unavailable",
      failurePhase: "prepare-retriever",
    });
    expect(current.calls()).toBe(0);
  });

  it("classifies the validated family unavailable result as invocation", async () => {
    const current = fixture({ code: "unavailable" });
    expect(await getConfiguredTrace(current.runtime, input)).toEqual({
      ok: false,
      code: "unavailable",
      failurePhase: "invoke-get",
    });
    expect(current.calls()).toBe(1);
  });

  it("never reads a rejected adapter's hostile phase or raw cause", async () => {
    let reads = 0;
    const rejected = Object.defineProperties(new Error("SYNTHETIC_BODY"), {
      failurePhase: {
        get: () => {
          reads += 1;
          throw new Error("SYNTHETIC_SECRET");
        },
      },
      cause: {
        get: () => {
          reads += 1;
          throw new Error("SYNTHETIC_SECRET");
        },
      },
    });
    const current = fixture({ getFault: rejected });
    expect(await getConfiguredTrace(current.runtime, input)).toEqual({
      ok: false,
      code: "unavailable",
      failurePhase: "invoke-get",
    });
    expect(reads).toBe(0);
  });

  it("rejects an adapter-supplied phase instead of importing diagnostic authority", async () => {
    const current = fixture({
      returned: {
        ...createRetrieverFailure("unavailable"),
        failurePhase: "prepare-retriever",
      },
    });
    expect(await getConfiguredTrace(current.runtime, input)).toEqual({
      ok: false,
      code: "malformed-response",
    });
  });

  it.each([
    "not-found",
    "forbidden",
    "rate-limited",
    "malformed-response",
  ] as const)("preserves %s without attaching a phase", async (code) => {
    const current = fixture({ code });
    expect(await getConfiguredTrace(current.runtime, input)).toEqual({
      ok: false,
      code,
    });
  });

  it("preserves deadline failure before adapter invocation", async () => {
    const controller = new AbortController();
    controller.abort();
    const current = fixture({ signal: controller.signal });
    expect(await getConfiguredTrace(current.runtime, input)).toEqual({
      ok: false,
      code: "deadline-exceeded",
    });
    expect(current.calls()).toBe(0);
  });

  it("leaves search preparation and invocation failures unchanged", async () => {
    for (const preparationFault of [false, true]) {
      const current = fixture({ preparationFault });
      expect(
        await searchConfiguredTraces(current.runtime, {
          destinationName: "archive",
          query: {},
        }),
      ).toEqual({ ok: false, code: "unavailable" });
    }
  });

  it("leaves successful get output free of diagnostic fields", async () => {
    const current = fixture();
    const result = await getConfiguredTrace(current.runtime, input);
    expect(result.ok).toBe(true);
    expect(Object.keys(result)).toEqual(["ok", "trace"]);
    expect(result).not.toHaveProperty("failurePhase");
  });

  it("preserves retry hints and suppresses phases on other failure codes", () => {
    expect(failure("unavailable", 250, "invoke-get")).toEqual({
      ok: false,
      code: "unavailable",
      retryAfterMilliseconds: 250,
      failurePhase: "invoke-get",
    });
    expect(failure("rate-limited", 250, "invoke-get")).toEqual({
      ok: false,
      code: "rate-limited",
      retryAfterMilliseconds: 250,
    });
  });
});
