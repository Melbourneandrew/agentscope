import {
  compileDestinationRegistry,
  createDestinationReporter,
  createDestinationRetriever,
  createReporterReceipt,
  createRetrievedTrace,
  createRetrieverSearchPage,
  createRetrieverFailure,
  createRetrieverSuccess,
  createTraceLocator,
  createTraceSummary,
  defineDestinationDescriptor,
  type RetrieverFailureCode,
} from "@agentscope/destinations-core";
import {
  createReporterDeadline,
  readTraceSearchCursorUpperTimeBound,
} from "@agentscope/destinations-core/core-orchestration";
import { createSanitizedCanonicalTraceFixture } from "@agentscope/protocol/testing";
import {
  parseCanonicalTraceGraph,
  standardsManifest,
} from "@agentscope/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  compileCredentialBackendRegistry,
  defineStoredCredentialBackendAdapter,
} from "../configuration/credential-adapter.js";
import { createAgentscopeHomeResolver } from "../configuration/home.js";
import {
  parseAgentscopeConfiguration,
  serializeAgentscopeConfiguration,
} from "../configuration/schema.js";
import { createConfigurationStoreForTesting } from "../configuration/transaction.js";
import {
  BUILTIN_REDACTION_POLICY_REFERENCES,
  DEFAULT_REDACTION_POLICY_REGISTRY,
} from "../redaction/policy.js";
import {
  createCoreRetrievalRuntime,
  getConfiguredTrace,
  prepareCoreRetrievalRuntime,
  searchConfiguredTraces,
  type CoreRetrievalRuntime,
} from "./orchestration.js";

// Core component coverage only. User-facing AC-RET evidence remains planned
// until the CLI and concrete destination integration own the output boundary.

const connectionId =
  "destination-connection-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const settingsSchema = z.strictObject({});
void settingsSchema.shape;
z.toJSONSchema(settingsSchema);

const graph = parseCanonicalTraceGraph(createSanitizedCanonicalTraceFixture());
const fixtureTraceId = graph.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.traceId;

const runtime = (
  options: Readonly<{
    retrieval?: boolean;
    policy?: "baseline" | "strict";
    throwFactory?: boolean;
    failure?: RetrieverFailureCode;
    partial?: boolean;
    incompatible?: boolean;
    persisted?: boolean;
    hang?: boolean;
    sparseSummary?: boolean;
    oversizedToken?: boolean;
  }> = {},
  // eslint-disable-next-line max-lines-per-function -- one fixture binds one exact descriptor and configuration authority.
) => {
  let factoryCalls = 0;
  let searches = 0;
  let gets = 0;
  const descriptor = defineDestinationDescriptor({
    descriptorVersion: 1,
    destinationType: "@agentscope/destination-retrieval-test",
    commandName: "retrieval-test",
    settingsVersion: 1,
    settingsSchema,
    defaultSettings: {},
    credentialSlots: [],
    documentationPath: "/docs/destinations/retrieval-test",
    deliveryIdentitySupport: "duplicates-possible",
    transport: { kind: "local" },
    createReporter: () =>
      createDestinationReporter({
        report: () => Promise.resolve(createReporterReceipt("accepted")),
      }),
    ...(options.retrieval === false
      ? {}
      : {
          createRetriever: () => {
            factoryCalls += 1;
            if (options.throwFactory) throw new Error("CANARY_PROVIDER_BODY");
            return createDestinationRetriever({
              search: (request) => {
                searches += 1;
                if (options.hang) return new Promise(() => undefined);
                if (options.failure)
                  return Promise.resolve(
                    createRetrieverFailure(
                      options.failure,
                      options.failure === "rate-limited" ? 250 : undefined,
                    ),
                  );
                const summary = createTraceSummary({
                  locator: createTraceLocator({
                    connectionId: request.connectionId,
                    destinationType: request.destinationType,
                    traceId: fixtureTraceId,
                  }),
                  startTime: "2026-01-01T00:00:00.000Z",
                  ...(options.sparseSummary
                    ? { endTime: "2026-01-01T00:00:01.000Z" }
                    : {
                        harness: "codex",
                        branch: "main",
                        repositoryIdentity: "agentscope",
                      }),
                  models: ["gpt-5"],
                  status: "ok",
                  spanCount: 3,
                  tags: ["fixture"],
                });
                return Promise.resolve(
                  createRetrieverSuccess(
                    createRetrieverSearchPage({
                      summaries: [summary],
                      state: options.partial
                        ? "partial"
                        : request.continuationToken === undefined
                          ? "continuation"
                          : "exhaustive",
                      ...(options.partial
                        ? { partialReason: "provider-request-limit" as const }
                        : request.continuationToken === undefined
                          ? {
                              continuationToken: options.oversizedToken
                                ? {
                                    first: "x".repeat(8_000),
                                    second: "x".repeat(8_000),
                                    third: "x".repeat(8_000),
                                  }
                                : { offset: 1 },
                            }
                          : {}),
                      consistency: "snapshot",
                      exactTotal: 1,
                    }),
                  ),
                );
              },
              get: (request) => {
                gets += 1;
                if (options.hang) return new Promise(() => undefined);
                if (options.failure)
                  return Promise.resolve(
                    createRetrieverFailure(options.failure),
                  );
                const returnedGraph = structuredClone(graph);
                if (options.incompatible)
                  returnedGraph.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name =
                    "Bearer CANARY_SECRET";
                const representation = options.persisted
                  ? {
                      kind: "persisted-envelope" as const,
                      envelope: JSON.stringify({
                        envelopeVersion: 1,
                        protocolManifestId: standardsManifest.manifestId,
                        delivery: {
                          identity: "ab".repeat(32),
                          stability: "session-stable",
                        },
                        graph: returnedGraph,
                      }),
                    }
                  : { kind: "canonical-graph" as const, graph: returnedGraph };
                return Promise.resolve(
                  createRetrieverSuccess(
                    createRetrievedTrace({
                      locator: request.locator,
                      representation,
                      consistency: "snapshot",
                    }),
                  ),
                );
              },
            });
          },
        }),
  });
  const destinationRegistry = compileDestinationRegistry([descriptor]);
  const configuration = parseAgentscopeConfiguration(
    {
      configurationVersion: 2,
      generation: 9,
      destinations: {
        "@agentscope/destination-retrieval-test": {
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
        reference:
          options.policy === "strict"
            ? BUILTIN_REDACTION_POLICY_REFERENCES.strict
            : BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
      },
    },
    destinationRegistry,
  );
  const value: CoreRetrievalRuntime = createCoreRetrievalRuntime({
    configuration,
    policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
    credentialBackendRegistry: compileCredentialBackendRegistry([]),
    transportExecutor: () => Promise.reject(new Error("unexpected transport")),
    timeoutMilliseconds: 2_000,
  });
  return {
    value,
    counts: () => ({ factoryCalls, searches, gets }),
  };
};

describe("Core retrieval orchestration", () => {
  it("anchors the command before bounded configuration resolution", async () => {
    const fixture = runtime();
    const serialized = serializeAgentscopeConfiguration(
      fixture.value.configuration,
    );
    const home = createAgentscopeHomeResolver({
      environment: { AGENTSCOPE_HOME: "/tmp/agentscope-retrieval-runtime" },
      environmentOverrideAuthority: "test",
      platform: "linux",
    })();
    const store = createConfigurationStoreForTesting(
      home,
      fixture.value.configuration.destinationRegistry,
      { readForHook: () => Promise.resolve(serialized) },
    );
    const before = Date.now();
    const controller = new AbortController();
    const prepared = await prepareCoreRetrievalRuntime({
      configurationStore: store,
      credentialBackendRegistry: fixture.value.credentialBackendRegistry,
      policyRegistry: fixture.value.policyRegistry,
      signal: controller.signal,
      transportExecutor: fixture.value.transportExecutor,
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(
      Date.parse(prepared.runtime.commandStartedAt),
    ).toBeGreaterThanOrEqual(before);
    expect(prepared.runtime.configuration.generation).toBe(
      fixture.value.configuration.generation,
    );
    expect(
      createCoreRetrievalRuntime({
        configuration: fixture.value.configuration,
        credentialBackendRegistry: fixture.value.credentialBackendRegistry,
        policyRegistry: fixture.value.policyRegistry,
        signal: controller.signal,
        timeoutMilliseconds: 2_000,
        transportExecutor: fixture.value.transportExecutor,
      }).signal,
    ).toBe(controller.signal);
    await expect(
      prepareCoreRetrievalRuntime({
        configurationStore: store,
        credentialBackendRegistry: fixture.value.credentialBackendRegistry,
        policyRegistry: fixture.value.policyRegistry,
        transportExecutor: fixture.value.transportExecutor,
      }),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("Core retrieval preparation failure", () => {
  it("fails closed for missing, cancelled, and accessor preparation input", async () => {
    const fixture = runtime();
    const home = createAgentscopeHomeResolver({
      environment: { AGENTSCOPE_HOME: "/tmp/agentscope-retrieval-failure" },
      environmentOverrideAuthority: "test",
      platform: "linux",
    })();
    const store = createConfigurationStoreForTesting(
      home,
      fixture.value.configuration.destinationRegistry,
      { readForHook: () => Promise.resolve(undefined) },
    );
    const input = {
      configurationStore: store,
      credentialBackendRegistry: fixture.value.credentialBackendRegistry,
      policyRegistry: fixture.value.policyRegistry,
      transportExecutor: fixture.value.transportExecutor,
    };
    await expect(prepareCoreRetrievalRuntime(input)).resolves.toEqual({
      ok: false,
      code: "core.configuration.missing",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareCoreRetrievalRuntime({ ...input, signal: controller.signal }),
    ).resolves.toEqual({ ok: false, code: "deadline-exceeded" });
    const hostileSignal = {
      aborted: false,
      addEventListener: () => {
        throw new Error("CANARY_SIGNAL");
      },
      removeEventListener: () => {
        throw new Error("CANARY_SIGNAL");
      },
    } as never;
    await expect(
      prepareCoreRetrievalRuntime({ ...input, signal: hostileSignal }),
    ).resolves.toEqual({ ok: false, code: "deadline-exceeded" });
    const hostileAbortedGetter = Object.defineProperty({}, "aborted", {
      get: () => {
        throw new Error("CANARY_SIGNAL");
      },
    }) as AbortSignal;
    await expect(
      prepareCoreRetrievalRuntime({
        ...input,
        signal: hostileAbortedGetter,
      }),
    ).resolves.toEqual({ ok: false, code: "deadline-exceeded" });
    const delayedController = new AbortController();
    const delayedStore = createConfigurationStoreForTesting(
      home,
      fixture.value.configuration.destinationRegistry,
      {
        readForHook: (_path, signal) =>
          new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                resolve(undefined);
              },
              { once: true },
            );
          }),
      },
    );
    const delayed = prepareCoreRetrievalRuntime({
      ...input,
      configurationStore: delayedStore,
      signal: delayedController.signal,
    });
    delayedController.abort();
    await expect(delayed).resolves.toEqual({
      ok: false,
      code: "deadline-exceeded",
    });
    let reads = 0;
    await expect(
      prepareCoreRetrievalRuntime(
        Object.defineProperty({}, "configurationStore", {
          get: () => {
            reads += 1;
            return store;
          },
        }) as never,
      ),
    ).resolves.toEqual({
      ok: false,
      code: "core.configuration.unavailable",
    });
    expect(reads).toBe(0);
  });
});

describe("Core retrieval query execution", () => {
  it("rejects a configuration snapshot not minted by the parser", async () => {
    const fixture = runtime();
    const forgedConfiguration = Object.freeze({
      ...fixture.value.configuration,
    });
    await expect(
      getConfiguredTrace(
        {
          ...fixture.value,
          configuration: forgedConfiguration,
        },
        { destinationName: "archive", traceId: fixtureTraceId },
      ),
    ).resolves.toEqual({ ok: false, code: "invalid-query" });
    expect(fixture.counts()).toEqual({ factoryCalls: 0, searches: 0, gets: 0 });
  });

  it("searches exactly one named connection and binds continuation", async () => {
    const fixture = runtime();
    const commandStartedAt = "2025-12-31T23:59:59.000Z";
    const first = await searchConfiguredTraces(
      { ...fixture.value, commandStartedAt },
      {
        destinationName: "archive",
        query: { harness: "codex" },
      },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.page).toMatchObject({
      schemaVersion: 1,
      connectionName: "archive",
      state: "continuation",
      consistency: "snapshot",
    });
    expect(first.page.summaries[0]).toMatchObject({
      branch: "main",
      models: ["gpt-5"],
      tags: ["fixture"],
    });
    expect(readTraceSearchCursorUpperTimeBound(first.page.nextCursor)).toBe(
      commandStartedAt,
    );
    const second = await searchConfiguredTraces(fixture.value, {
      destinationName: "archive",
      query: { harness: "codex" },
      cursor: first.page.nextCursor,
    });
    expect(second).toMatchObject({ ok: true, page: { state: "exhaustive" } });
    expect(fixture.counts()).toEqual({ factoryCalls: 2, searches: 2, gets: 0 });
  });

  it("retrieves one exact locator and returns a governed portable graph", async () => {
    const fixture = runtime();
    const result = await getConfiguredTrace(fixture.value, {
      destinationName: "archive",
      traceId: fixtureTraceId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace).toMatchObject({
      schemaVersion: 1,
      connectionName: "archive",
      consistency: "snapshot",
    });
    expect(result.trace.locator.traceId).toBe(fixtureTraceId);
    expect(result.trace.graph).not.toBe(graph);
    expect(fixture.counts()).toEqual({ factoryCalls: 1, searches: 0, gets: 1 });
  });

  it("fails unknown and unsupported selection before a Retriever factory", async () => {
    const supported = runtime();
    await expect(
      searchConfiguredTraces(supported.value, {
        destinationName: "missing",
        query: {},
      }),
    ).resolves.toEqual({ ok: false, code: "unknown-connection" });
    expect(supported.counts().factoryCalls).toBe(0);

    const unsupported = runtime({ retrieval: false });
    await expect(
      getConfiguredTrace(unsupported.value, {
        destinationName: "archive",
        traceId: fixtureTraceId,
      }),
    ).resolves.toEqual({ ok: false, code: "retrieval-unsupported" });
    expect(unsupported.counts().factoryCalls).toBe(0);
  });

  it("contains provider failures and rejects cursor/query substitution", async () => {
    const broken = runtime({ throwFactory: true });
    await expect(
      searchConfiguredTraces(broken.value, {
        destinationName: "archive",
        query: {},
      }),
    ).resolves.toEqual({ ok: false, code: "unavailable" });

    const fixture = runtime();
    const first = await searchConfiguredTraces(fixture.value, {
      destinationName: "archive",
      query: { branch: "main" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await expect(
      searchConfiguredTraces(fixture.value, {
        destinationName: "archive",
        query: { branch: "other" },
        cursor: first.page.nextCursor,
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-query" });
  });
});

describe("Core retrieval failure and governance boundaries", () => {
  it("preserves typed failures and explicit partial results", async () => {
    const limited = runtime({ failure: "rate-limited" });
    await expect(
      searchConfiguredTraces(limited.value, {
        destinationName: "archive",
        query: {},
      }),
    ).resolves.toEqual({
      ok: false,
      code: "rate-limited",
      retryAfterMilliseconds: 250,
    });
    const partial = runtime({ partial: true });
    await expect(
      searchConfiguredTraces(partial.value, {
        destinationName: "archive",
        query: {},
      }),
    ).resolves.toMatchObject({
      ok: true,
      page: {
        state: "partial",
        partialReason: "provider-request-limit",
      },
    });
    const missing = runtime({ failure: "not-found" });
    await expect(
      getConfiguredTrace(missing.value, {
        destinationName: "archive",
        traceId: fixtureTraceId,
      }),
    ).resolves.toEqual({ ok: false, code: "not-found" });
  });

  it("accepts current persisted envelopes and rejects newly unsafe graphs", async () => {
    const persisted = runtime({ persisted: true });
    await expect(
      getConfiguredTrace(persisted.value, {
        destinationName: "archive",
        traceId: fixtureTraceId,
        destinationTraceId: "provider-safe-id",
      }),
    ).resolves.toMatchObject({ ok: true });
    const incompatible = runtime({ incompatible: true });
    await expect(
      getConfiguredTrace(incompatible.value, {
        destinationName: "archive",
        traceId: fixtureTraceId,
      }),
    ).resolves.toEqual({ ok: false, code: "incompatible-trace" });
  });

  it("rejects expired, cancelled, accessor, and malformed user inputs", async () => {
    const expired = runtime();
    await expect(
      searchConfiguredTraces(
        { ...expired.value, deadline: createReporterDeadline(0) },
        { destinationName: "archive", query: {} },
      ),
    ).resolves.toEqual({ ok: false, code: "deadline-exceeded" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      getConfiguredTrace(
        { ...expired.value, signal: controller.signal },
        { destinationName: "archive", traceId: fixtureTraceId },
      ),
    ).resolves.toEqual({ ok: false, code: "deadline-exceeded" });
    const accessor = Object.defineProperty({}, "destinationName", {
      get: () => "archive",
    });
    await expect(
      searchConfiguredTraces(expired.value, accessor as never),
    ).resolves.toEqual({ ok: false, code: "invalid-query" });
    await expect(
      getConfiguredTrace(expired.value, {
        destinationName: "archive",
        traceId: "not-a-trace-id",
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-query" });
    await expect(
      searchConfiguredTraces(expired.value, {
        destinationName: "Archive",
        query: {},
      }),
    ).resolves.toEqual({ ok: false, code: "unknown-connection" });
    await expect(
      searchConfiguredTraces(expired.value, {
        destinationName: "archive",
        query: { from: "not-a-time" },
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-query" });
    await expect(
      searchConfiguredTraces(expired.value, {
        destinationName: "archive",
        query: {},
        commandStartedAt: 1,
      } as never),
    ).resolves.toEqual({ ok: false, code: "invalid-query" });
    const hanging = runtime({ hang: true });
    await expect(
      searchConfiguredTraces(
        { ...hanging.value, deadline: createReporterDeadline(20) },
        { destinationName: "archive", query: {} },
      ),
    ).resolves.toEqual({ ok: false, code: "deadline-exceeded" });
    const oversizedToken = runtime({ oversizedToken: true });
    await expect(
      searchConfiguredTraces(oversizedToken.value, {
        destinationName: "archive",
        query: {},
      }),
    ).resolves.toEqual({ ok: false, code: "malformed-response" });
  });
});

describe("Core retrieval presentation governance", () => {
  it("applies strict summary policy before presentation", async () => {
    const fixture = runtime({ policy: "strict" });
    const result = await searchConfiguredTraces(fixture.value, {
      destinationName: "archive",
      query: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.summaries[0]).toEqual({
      locator: result.page.summaries[0]!.locator,
      startTime: "2026-01-01T00:00:00.000Z",
      models: [],
      status: "ok",
      spanCount: 3,
      tags: [],
    });
  });

  it("preserves optional time while omitting absent summary identifiers", async () => {
    const fixture = runtime({ sparseSummary: true });
    const result = await searchConfiguredTraces(fixture.value, {
      destinationName: "archive",
      query: {},
    });
    expect(result).toMatchObject({
      ok: true,
      page: {
        summaries: [
          {
            endTime: "2026-01-01T00:00:01.000Z",
            models: ["gpt-5"],
          },
        ],
      },
    });
  });
});

/* eslint-disable max-lines-per-function -- success and denial share one exact compiled remote authority. */
describe("Core retrieval connection setup", () => {
  it("binds a remote transport and resolved credential", async () => {
    const remoteSchema = z.strictObject({ endpoint: z.string() });
    void remoteSchema.shape;
    z.toJSONSchema(remoteSchema);
    let constructed = 0;
    const descriptor = defineDestinationDescriptor({
      descriptorVersion: 1,
      destinationType: "@agentscope/destination-retrieval-remote",
      commandName: "retrieval-remote",
      settingsVersion: 1,
      settingsSchema: remoteSchema,
      defaultSettings: { endpoint: "https://example.com/api" },
      credentialSlots: [
        { id: "token", required: true },
        { id: "optional", required: false },
      ],
      documentationPath: "/docs/destinations/retrieval-remote",
      deliveryIdentitySupport: "duplicates-possible",
      transport: {
        kind: "remote",
        resolveEndpoint: ({ endpoint }) => ({
          url: endpoint,
          allowInsecureLoopback: false,
        }),
      },
      createReporter: () =>
        createDestinationReporter({
          report: () => Promise.resolve(createReporterReceipt("accepted")),
        }),
      createRetriever: ({ endpoint, transport, credentials }) => {
        expect(endpoint?.href).toBe("https://example.com/api");
        expect(transport).not.toBeNull();
        expect(credentials).toBeDefined();
        constructed += 1;
        return createDestinationRetriever({
          search: () =>
            Promise.resolve(
              createRetrieverSuccess(
                createRetrieverSearchPage({
                  summaries: [],
                  state: "exhaustive",
                  consistency: "best-effort",
                }),
              ),
            ),
          get: () => Promise.resolve(createRetrieverFailure("not-found")),
        });
      },
    });
    const destinationRegistry = compileDestinationRegistry([descriptor]);
    const referenceId = `credential-reference-v1-${"b".repeat(64)}`;
    const generationId = `credential-generation-v1-${"c".repeat(64)}`;
    const configuration = parseAgentscopeConfiguration(
      {
        configurationVersion: 2,
        generation: 1,
        destinations: {
          "@agentscope/destination-retrieval-remote": {
            namespaceVersion: 1,
            settingsVersion: 1,
            connections: [
              {
                connectionId,
                name: "remote",
                settings: { endpoint: "https://example.com/api" },
                credentialReferences: {
                  token: {
                    referenceVersion: 1,
                    backend: "macos-keychain",
                    referenceId,
                    generationId,
                  },
                },
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
    let credentialReads = 0;
    const backend = defineStoredCredentialBackendAdapter("macos-keychain", {
      createPending: () => Promise.resolve({ ok: false, code: "denied" }),
      activate: () => Promise.resolve(false),
      removePending: () => Promise.resolve(false),
      removeOwned: () => Promise.resolve(false),
      resolve: () => {
        credentialReads += 1;
        return Promise.resolve({ ok: true, secret: "ephemeral-secret" });
      },
    });
    const configuredRuntime = {
      commandStartedAt: "2026-01-01T00:00:00.000Z",
      configuration,
      policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
      credentialBackendRegistry: compileCredentialBackendRegistry([backend]),
      transportExecutor: () => Promise.reject(new Error("unused")),
      deadline: createReporterDeadline(1_000),
    };
    await expect(
      getConfiguredTrace(configuredRuntime, {
        destinationName: "remote",
        traceId: "not-a-trace-id",
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-query" });
    expect(credentialReads).toBe(0);
    await expect(
      searchConfiguredTraces(configuredRuntime, {
        destinationName: "remote",
        query: {},
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(credentialReads).toBe(1);
    expect(constructed).toBe(1);
    const denied = defineStoredCredentialBackendAdapter("macos-keychain", {
      createPending: () => Promise.resolve({ ok: false, code: "denied" }),
      activate: () => Promise.resolve(false),
      removePending: () => Promise.resolve(false),
      removeOwned: () => Promise.resolve(false),
      resolve: () => Promise.resolve({ ok: false, code: "denied" }),
    });
    await expect(
      searchConfiguredTraces(
        {
          commandStartedAt: "2026-01-01T00:00:00.000Z",
          configuration,
          policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
          credentialBackendRegistry: compileCredentialBackendRegistry([denied]),
          transportExecutor: () => Promise.reject(new Error("unused")),
          deadline: createReporterDeadline(1_000),
        },
        { destinationName: "remote", query: {} },
      ),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
    const delayed = defineStoredCredentialBackendAdapter("macos-keychain", {
      createPending: () => Promise.resolve({ ok: false, code: "denied" }),
      activate: () => Promise.resolve(false),
      removePending: () => Promise.resolve(false),
      removeOwned: () => Promise.resolve(false),
      resolve: ({ context }) =>
        new Promise((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              resolve({ ok: true, secret: "late-secret" });
            },
            { once: true },
          );
        }),
    });
    await expect(
      searchConfiguredTraces(
        {
          commandStartedAt: "2026-01-01T00:00:00.000Z",
          configuration,
          policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
          credentialBackendRegistry: compileCredentialBackendRegistry([
            delayed,
          ]),
          transportExecutor: () => Promise.reject(new Error("unused")),
          deadline: createReporterDeadline(20),
        },
        { destinationName: "remote", query: {} },
      ),
    ).resolves.toEqual({ ok: false, code: "deadline-exceeded" });
    const lateFailure = defineStoredCredentialBackendAdapter("macos-keychain", {
      createPending: () => Promise.resolve({ ok: false, code: "denied" }),
      activate: () => Promise.resolve(false),
      removePending: () => Promise.resolve(false),
      removeOwned: () => Promise.resolve(false),
      resolve: ({ context }) =>
        new Promise((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              resolve({ ok: false, code: "unavailable" });
            },
            { once: true },
          );
        }),
    });
    await expect(
      searchConfiguredTraces(
        {
          commandStartedAt: "2026-01-01T00:00:00.000Z",
          configuration,
          policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
          credentialBackendRegistry: compileCredentialBackendRegistry([
            lateFailure,
          ]),
          transportExecutor: () => Promise.reject(new Error("unused")),
          deadline: createReporterDeadline(20),
        },
        { destinationName: "remote", query: {} },
      ),
    ).resolves.toEqual({ ok: false, code: "deadline-exceeded" });
    const neverSettles = defineStoredCredentialBackendAdapter(
      "macos-keychain",
      {
        createPending: () => Promise.resolve({ ok: false, code: "denied" }),
        activate: () => Promise.resolve(false),
        removePending: () => Promise.resolve(false),
        removeOwned: () => Promise.resolve(false),
        resolve: () => new Promise(() => undefined),
      },
    );
    await expect(
      searchConfiguredTraces(
        {
          commandStartedAt: "2026-01-01T00:00:00.000Z",
          configuration,
          policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
          credentialBackendRegistry: compileCredentialBackendRegistry([
            neverSettles,
          ]),
          transportExecutor: () => Promise.reject(new Error("unused")),
          deadline: createReporterDeadline(20),
        },
        { destinationName: "remote", query: {} },
      ),
    ).resolves.toEqual({ ok: false, code: "deadline-exceeded" });
  });
});
/* eslint-enable max-lines-per-function */

describe("Core retrieval cancellation setup", () => {
  it("rejects runtime authority accessors without invoking them", async () => {
    const base = runtime();
    let configurationReads = 0;
    const accessorRuntime = Object.defineProperty(
      { ...base.value },
      "configuration",
      {
        get() {
          configurationReads += 1;
          return base.value.configuration;
        },
      },
    );
    await expect(
      getConfiguredTrace(accessorRuntime as CoreRetrievalRuntime, {
        destinationName: "archive",
        traceId: fixtureTraceId,
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-query" });
    await expect(
      searchConfiguredTraces(accessorRuntime as CoreRetrievalRuntime, {
        destinationName: "archive",
        query: {},
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-query" });
    expect(configurationReads).toBe(0);
    expect(base.counts()).toEqual({ factoryCalls: 0, searches: 0, gets: 0 });
  });

  it("contains hostile cancellation accessors", async () => {
    const base = runtime();
    const controller = new AbortController();
    const hostileSignal = new Proxy(controller.signal, {
      get(target, property, receiver) {
        if (property === "addEventListener") throw new Error("CANARY_SECRET");
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    await expect(
      searchConfiguredTraces(
        { ...base.value, signal: hostileSignal },
        { destinationName: "archive", query: {} },
      ),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
  });

  it("is total over hostile operation records", async () => {
    const base = runtime();
    const throwing = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("CANARY_SECRET");
        },
      },
    );
    const symbolInput = {
      destinationName: "archive",
      query: {},
      [Symbol("hostile")]: true,
    };
    for (const input of [
      null,
      {},
      { destinationName: "archive", query: {}, extra: true },
      throwing,
      symbolInput,
    ])
      await expect(
        searchConfiguredTraces(base.value, input as never),
      ).resolves.toEqual({ ok: false, code: "invalid-query" });
    await expect(
      getConfiguredTrace(base.value, {
        destinationName: "archive",
        traceId: fixtureTraceId,
        extra: true,
      } as never),
    ).resolves.toEqual({ ok: false, code: "invalid-query" });
  });
});
