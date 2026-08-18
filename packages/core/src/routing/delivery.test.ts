import {
  compileDestinationRegistry,
  createDestinationConnectionId,
  createDestinationReporter,
  createReporterReceipt,
  defineDestinationDescriptor,
  type ReporterOutcome,
} from "@agentscope/destinations-core";
import { createReporterDeadline } from "@agentscope/destinations-core/core-orchestration";
import type { RedactedCanonicalTrace } from "@agentscope/protocol";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { withCaptureInvocation } from "../capture/runtime.js";
import type {
  CapturedTraceCandidate,
  CaptureInvocationContext,
} from "../capture/types.js";
import {
  compileCredentialBackendRegistry,
  defineStoredCredentialBackendAdapter,
} from "../configuration/credential-adapter.js";
import { parseAgentscopeConfiguration } from "../configuration/schema.js";
import { redactCapturedTrace } from "../redaction/pipeline.js";
import {
  BUILTIN_REDACTION_POLICY_REFERENCES,
  DEFAULT_REDACTION_POLICY_REGISTRY,
  resolveRedactionPolicy,
} from "../redaction/policy.js";
import { routeRedactedTraceBatch } from "./delivery.js";

// End-to-end Core evidence for AC-CAP-001.1, AC-CAP-001.2,
// AC-CONN-002.1, AC-CONN-002.2, AC-REP-001.1, AC-REP-001.2,
// AC-REP-001.3, AC-REP-003.1, AC-REP-003.2, and AC-REP-003.4.

const connectionId = (digit: string) =>
  `destination-connection-v1-${digit.repeat(64)}` as const;
const acceptedId = connectionId("a");
const rejectedId = connectionId("b");
const unknownId = connectionId("c");
const unavailableId = connectionId("d");

const invocation = (): CaptureInvocationContext => {
  const policy = resolveRedactionPolicy(
    DEFAULT_REDACTION_POLICY_REGISTRY,
    BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
  );
  return {
    harnessRegistryId: "codex",
    harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
    snapshot: {
      configurationIdentity: "configuration-v2-test",
      policyIdentity: policy.identity,
      redactionPolicy: policy,
    },
    hookObservedUnixNano: "10",
    operationIdScope: "session-global",
    context: {
      fields: [],
      unavailable: [
        {
          field: "agentscope.workspace.directory",
          source: "process",
          state: "unavailable",
          reason: "resolution-failed",
        },
        ...[
          "agentscope.git.worktree",
          "agentscope.git.repository_root",
          "vcs.ref.head.name",
          "vcs.ref.head.revision",
          "vcs.ref.type",
        ].map((field) => ({
          field,
          source: "git" as const,
          state: "unavailable" as const,
          reason: "resolution-failed" as const,
        })),
      ],
    },
  };
};

const candidate = (): CapturedTraceCandidate => ({
  captureBoundary: {
    session: {
      kind: "native-session",
      nativeIdentityKind: "thread",
      nativeIdentity: "thread-1",
    },
    boundaryKind: "turn",
    boundaryId: "turn-1",
    generation: 0,
    positionKind: "event-index",
    startPosition: 0,
    exclusiveEndPosition: 1,
  },
  rootContext: { fields: [], unavailable: [] },
  operations: [
    {
      logicalKey: "root",
      locator: { kind: "source-ordinal", ordinal: 0 },
      kind: "AGENT",
      name: "agent-operation",
      nameProvenance: { field: "span.name", source: "native-artifact" },
      timing: {
        basis: "native-interval",
        nativeState: "observed",
        source: "native-artifact",
        startUnixNano: "1",
        endUnixNano: "20",
      },
      fields: [],
      unavailable: [],
      events: [],
      links: [],
    },
  ],
});

const mintTrace = async (): Promise<RedactedCanonicalTrace> =>
  redactCapturedTrace(
    await withCaptureInvocation(invocation(), (factory) =>
      factory.capture(candidate()),
    ),
  );

const emptySettings = z.strictObject({});
void emptySettings.shape;
z.toJSONSchema(emptySettings);

const routingFixture = (unavailableDelayMilliseconds = 0) => {
  const starts: string[] = [];
  const received: RedactedCanonicalTrace[] = [];
  const deadlines: object[] = [];
  const settlements = new Map<string, (outcome: ReporterOutcome) => void>();
  const outcomes = new Map<string, ReporterOutcome>([
    [acceptedId, "accepted"],
    [rejectedId, "rejected"],
    [unknownId, "outcome-unknown"],
  ]);
  const descriptor = defineDestinationDescriptor({
    descriptorVersion: 1,
    destinationType: "@agentscope/destination-routing-test",
    commandName: "routing-test",
    settingsVersion: 1,
    settingsSchema: emptySettings,
    defaultSettings: {},
    credentialSlots: [],
    documentationPath: "/docs/destinations/routing-test",
    deliveryIdentitySupport: "duplicates-possible",
    transport: { kind: "local" },
    createReporter: ({ connectionId: current }) => {
      if (current === unavailableId) {
        const expiresAt = performance.now() + unavailableDelayMilliseconds;
        while (performance.now() < expiresAt) {
          // Deterministically exercise a synchronous first-party factory overrun.
        }
        throw new Error("CANARY_SECRET");
      }
      return createDestinationReporter({
        report: ({ deadline, traces }) => {
          starts.push(current);
          received.push(traces[0]);
          deadlines.push(deadline);
          return new Promise((resolve) => {
            settlements.set(current, (outcome) => {
              resolve(createReporterReceipt(outcome));
            });
          });
        },
      });
    },
  });
  const destinationRegistry = compileDestinationRegistry([descriptor]);
  const selectedConnectionIds = [
    unavailableId,
    unknownId,
    rejectedId,
    acceptedId,
  ];
  const configuration = parseAgentscopeConfiguration(
    {
      configurationVersion: 2,
      generation: 1,
      destinations: {
        "@agentscope/destination-routing-test": {
          namespaceVersion: 1,
          settingsVersion: 1,
          connections: selectedConnectionIds.map((current, index) => ({
            connectionId: current,
            name: `connection-${index}`,
            settings: {},
            credentialReferences: {},
          })),
        },
      },
      routing: {
        version: 1,
        selectedConnectionIds,
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
    starts,
    received,
    deadlines,
    settlements,
    outcomes,
    destinationRegistry,
    configuration,
  };
};

describe("Core connection routing", () => {
  it("fans the original branded trace to every selected connection concurrently", async () => {
    const value = routingFixture();
    const trace = await mintTrace();
    const resultPromise = routeRedactedTraceBatch({
      traces: [trace],
      configuration: value.configuration,
      credentialBackendRegistry: compileCredentialBackendRegistry([]),
      transportExecutor: () => Promise.reject(new Error("unexpected")),
      deadline: createReporterDeadline(2_000),
    });
    await vi.waitFor(() => {
      expect(value.starts).toHaveLength(3);
    });
    expect(value.received.every((received) => received === trace)).toBe(true);
    expect(new Set(value.deadlines).size).toBe(1);
    for (const [current, outcome] of value.outcomes)
      value.settlements.get(current)?.(outcome);
    await expect(resultPromise).resolves.toEqual({
      outcome: "completed",
      connections: [
        { connectionId: acceptedId, outcome: "accepted" },
        { connectionId: rejectedId, outcome: "rejected" },
        { connectionId: unknownId, outcome: "outcome-unknown" },
        { connectionId: unavailableId, outcome: "unavailable" },
      ],
    });
  });

  it("short-circuits an empty route before inspecting a batch", async () => {
    const destinationRegistry = compileDestinationRegistry([]);
    const configuration = parseAgentscopeConfiguration(
      {
        configurationVersion: 2,
        generation: 1,
        destinations: {},
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
    await expect(
      routeRedactedTraceBatch({
        traces: [] as never,
        configuration,
        credentialBackendRegistry: compileCredentialBackendRegistry([]),
        transportExecutor: () => Promise.reject(new Error("unexpected")),
        deadline: createReporterDeadline(1_000),
      }),
    ).resolves.toEqual({
      outcome: "routing-unselected",
      connections: [],
    });
  });
});

describe("Core remote connection routing", () => {
  it("binds a validated remote endpoint before Reporter construction", async () => {
    const remoteId = connectionId("6");
    const remoteSettings = z.strictObject({
      endpoint: z.string(),
      insecure: z.boolean(),
    });
    void remoteSettings.shape;
    z.toJSONSchema(remoteSettings);
    const descriptor = defineDestinationDescriptor({
      descriptorVersion: 1,
      destinationType: "@agentscope/destination-remote-test",
      commandName: "remote-test",
      settingsVersion: 1,
      settingsSchema: remoteSettings,
      defaultSettings: {
        endpoint: "https://example.com/v1/traces",
        insecure: false,
      },
      credentialSlots: [],
      documentationPath: "/docs/destinations/remote-test",
      deliveryIdentitySupport: "duplicates-possible",
      transport: {
        kind: "remote",
        resolveEndpoint: (settings) => ({
          url: settings.endpoint,
          allowInsecureLoopback: settings.insecure,
        }),
      },
      createReporter: () =>
        createDestinationReporter({
          report: () => Promise.resolve(createReporterReceipt("accepted")),
        }),
    });
    const destinationRegistry = compileDestinationRegistry([descriptor]);
    const configuration = parseAgentscopeConfiguration(
      {
        configurationVersion: 2,
        generation: 1,
        destinations: {
          "@agentscope/destination-remote-test": {
            namespaceVersion: 1,
            settingsVersion: 1,
            connections: [
              {
                connectionId: remoteId,
                name: "remote",
                settings: {
                  endpoint: "https://example.com/v1/traces",
                  insecure: false,
                },
                credentialReferences: {},
              },
            ],
          },
        },
        routing: {
          version: 1,
          selectedConnectionIds: [remoteId],
          hookDeadlineMilliseconds: 2_000,
        },
        policy: {
          version: 1,
          reference: BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
        },
      },
      destinationRegistry,
    );
    await expect(
      routeRedactedTraceBatch({
        traces: [await mintTrace()],
        configuration,
        credentialBackendRegistry: compileCredentialBackendRegistry([]),
        transportExecutor: () => Promise.reject(new Error("unused")),
        deadline: createReporterDeadline(1_000),
      }),
    ).resolves.toEqual({
      outcome: "completed",
      connections: [{ connectionId: remoteId, outcome: "accepted" }],
    });
  });
});

describe("Core connection setup isolation", () => {
  it("times out one credential setup without delaying a ready sibling", async () => {
    const slowId = connectionId("e");
    const readyId = connectionId("f");
    const slowReference =
      "credential-reference-v1-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const readyReference =
      "credential-reference-v1-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const generationId =
      "credential-generation-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let slowSignal: AbortSignal | undefined;
    const settings = z.strictObject({});
    void settings.shape;
    z.toJSONSchema(settings);
    const descriptor = defineDestinationDescriptor({
      descriptorVersion: 1,
      destinationType: "@agentscope/destination-credential-test",
      commandName: "credential-test",
      settingsVersion: 1,
      settingsSchema: settings,
      defaultSettings: {},
      credentialSlots: [{ id: "token", required: true }],
      documentationPath: "/docs/destinations/credential-test",
      deliveryIdentitySupport: "duplicates-possible",
      transport: { kind: "local" },
      createReporter: () =>
        createDestinationReporter({
          report: () => Promise.resolve(createReporterReceipt("accepted")),
        }),
    });
    const destinationRegistry = compileDestinationRegistry([descriptor]);
    const credentialBackendRegistry = compileCredentialBackendRegistry([
      defineStoredCredentialBackendAdapter("macos-keychain", {
        createPending: () => Promise.resolve({ ok: false, code: "denied" }),
        activate: () => Promise.resolve(false),
        removePending: () => Promise.resolve(false),
        removeOwned: () => Promise.resolve(false),
        resolve: ({ reference, context }) => {
          if (
            "referenceId" in reference &&
            reference.referenceId === slowReference
          ) {
            slowSignal = context.signal;
            return new Promise((resolve) => {
              setTimeout(() => {
                resolve({ ok: true, secret: "late-token" });
              }, 1_100);
            });
          }
          return Promise.resolve({ ok: true, secret: "ephemeral-token" });
        },
      }),
    ]);
    const references = (referenceId: string) => ({
      token: {
        referenceVersion: 1,
        backend: "macos-keychain",
        referenceId,
        generationId,
      },
    });
    const configuration = parseAgentscopeConfiguration(
      {
        configurationVersion: 2,
        generation: 1,
        destinations: {
          "@agentscope/destination-credential-test": {
            namespaceVersion: 1,
            settingsVersion: 1,
            connections: [
              {
                connectionId: slowId,
                name: "slow",
                settings: {},
                credentialReferences: references(slowReference),
              },
              {
                connectionId: readyId,
                name: "ready",
                settings: {},
                credentialReferences: references(readyReference),
              },
            ],
          },
        },
        routing: {
          version: 1,
          selectedConnectionIds: [slowId, readyId],
          hookDeadlineMilliseconds: 2_000,
        },
        policy: {
          version: 1,
          reference: BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
        },
      },
      destinationRegistry,
    );
    const startedAt = performance.now();
    await expect(
      routeRedactedTraceBatch({
        traces: [await mintTrace()],
        configuration,
        credentialBackendRegistry,
        transportExecutor: () => Promise.reject(new Error("unexpected")),
        deadline: createReporterDeadline(2_000),
      }),
    ).resolves.toEqual({
      outcome: "completed",
      connections: [
        { connectionId: slowId, outcome: "unavailable" },
        { connectionId: readyId, outcome: "accepted" },
      ],
    });
    expect(performance.now() - startedAt).toBeLessThan(1_500);
    expect(slowSignal?.aborted).toBe(true);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  });
});

describe("Core credential setup outcomes", () => {
  it("supports omitted optional credentials and contains denied resolution", async () => {
    const optionalId = connectionId("7");
    const deniedId = connectionId("8");
    const deniedReference =
      "credential-reference-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const generationId =
      "credential-generation-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const descriptor = defineDestinationDescriptor({
      descriptorVersion: 1,
      destinationType: "@agentscope/destination-optional-test",
      commandName: "optional-test",
      settingsVersion: 1,
      settingsSchema: emptySettings,
      defaultSettings: {},
      credentialSlots: [{ id: "token", required: false }],
      documentationPath: "/docs/destinations/optional-test",
      deliveryIdentitySupport: "duplicates-possible",
      transport: { kind: "local" },
      createReporter: () =>
        createDestinationReporter({
          report: () => Promise.resolve(createReporterReceipt("accepted")),
        }),
    });
    const destinationRegistry = compileDestinationRegistry([descriptor]);
    const credentialBackendRegistry = compileCredentialBackendRegistry([
      defineStoredCredentialBackendAdapter("macos-keychain", {
        createPending: () => Promise.resolve({ ok: false, code: "denied" }),
        activate: () => Promise.resolve(false),
        removePending: () => Promise.resolve(false),
        removeOwned: () => Promise.resolve(false),
        resolve: () => Promise.resolve({ ok: false, code: "denied" }),
      }),
    ]);
    const configuration = parseAgentscopeConfiguration(
      {
        configurationVersion: 2,
        generation: 1,
        destinations: {
          "@agentscope/destination-optional-test": {
            namespaceVersion: 1,
            settingsVersion: 1,
            connections: [
              {
                connectionId: optionalId,
                name: "optional",
                settings: {},
                credentialReferences: {},
              },
              {
                connectionId: deniedId,
                name: "denied",
                settings: {},
                credentialReferences: {
                  token: {
                    referenceVersion: 1,
                    backend: "macos-keychain",
                    referenceId: deniedReference,
                    generationId,
                  },
                },
              },
            ],
          },
        },
        routing: {
          version: 1,
          selectedConnectionIds: [optionalId, deniedId],
          hookDeadlineMilliseconds: 2_000,
        },
        policy: {
          version: 1,
          reference: BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
        },
      },
      destinationRegistry,
    );
    await expect(
      routeRedactedTraceBatch({
        traces: [await mintTrace()],
        configuration,
        credentialBackendRegistry,
        transportExecutor: () => Promise.reject(new Error("unexpected")),
        deadline: createReporterDeadline(1_000),
      }),
    ).resolves.toEqual({
      outcome: "completed",
      connections: [
        { connectionId: optionalId, outcome: "accepted" },
        { connectionId: deniedId, outcome: "unavailable" },
      ],
    });
  });
});

describe("Core connection deadline isolation", () => {
  it("returns unknown for invoked work still unsettled at the global deadline", async () => {
    const hangingId = connectionId("1");
    const readyId = connectionId("2");
    let hangingSignal: AbortSignal | undefined;
    const descriptor = defineDestinationDescriptor({
      descriptorVersion: 1,
      destinationType: "@agentscope/destination-deadline-test",
      commandName: "deadline-test",
      settingsVersion: 1,
      settingsSchema: emptySettings,
      defaultSettings: {},
      credentialSlots: [],
      documentationPath: "/docs/destinations/deadline-test",
      deliveryIdentitySupport: "duplicates-possible",
      transport: { kind: "local" },
      createReporter: ({ connectionId: current }) =>
        createDestinationReporter({
          report: ({ signal }) => {
            if (current === hangingId) {
              hangingSignal = signal;
              return new Promise(() => undefined);
            }
            return Promise.resolve(createReporterReceipt("accepted"));
          },
        }),
    });
    const destinationRegistry = compileDestinationRegistry([descriptor]);
    const configuration = parseAgentscopeConfiguration(
      {
        configurationVersion: 2,
        generation: 1,
        destinations: {
          "@agentscope/destination-deadline-test": {
            namespaceVersion: 1,
            settingsVersion: 1,
            connections: [hangingId, readyId].map((current, index) => ({
              connectionId: current,
              name: `deadline-${index}`,
              settings: {},
              credentialReferences: {},
            })),
          },
        },
        routing: {
          version: 1,
          selectedConnectionIds: [readyId, hangingId],
          hookDeadlineMilliseconds: 50,
        },
        policy: {
          version: 1,
          reference: BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
        },
      },
      destinationRegistry,
    );
    await expect(
      routeRedactedTraceBatch({
        traces: [await mintTrace()],
        configuration,
        credentialBackendRegistry: compileCredentialBackendRegistry([]),
        transportExecutor: () => Promise.reject(new Error("unexpected")),
        deadline: createReporterDeadline(50),
      }),
    ).resolves.toEqual({
      outcome: "completed",
      connections: [
        { connectionId: hangingId, outcome: "outcome-unknown" },
        { connectionId: readyId, outcome: "accepted" },
      ],
    });
    expect(hangingSignal?.aborted).toBe(true);
  });
});

describe("Core routing boundary rejection", () => {
  it("rejects non-branded and malformed batches before Reporter setup", async () => {
    const value = routingFixture();
    const trace = await mintTrace();
    const accessor = [trace];
    Object.defineProperty(accessor, "0", { get: () => trace });
    const extra = Object.assign([trace], { extra: true });
    const sparse = new Array<RedactedCanonicalTrace>(1);
    for (const traces of [
      [],
      new Array(33).fill(trace),
      [structuredClone(trace)],
      [trace, trace],
      accessor,
      extra,
      sparse,
    ])
      await expect(
        routeRedactedTraceBatch({
          traces: traces as never,
          configuration: value.configuration,
          credentialBackendRegistry: compileCredentialBackendRegistry([]),
          transportExecutor: () => Promise.reject(new Error("unexpected")),
          deadline: createReporterDeadline(1_000),
        }),
      ).rejects.toThrow("core.routing.invalid");
    expect(value.starts).toHaveLength(0);
  });

  it("closes missing setup authority and pre-invocation expiry per connection", async () => {
    const value = routingFixture();
    const first = value.configuration.selectedConnectionIds[0]!;
    const missingId = createDestinationConnectionId(connectionId("9"));
    const missingConnection = Object.freeze({
      ...value.configuration,
      selectedConnectionIds: Object.freeze([missingId]),
    });
    await expect(
      routeRedactedTraceBatch({
        traces: [await mintTrace()],
        configuration: missingConnection,
        credentialBackendRegistry: compileCredentialBackendRegistry([]),
        transportExecutor: () => Promise.reject(new Error("unexpected")),
        deadline: createReporterDeadline(1_000),
      }),
    ).resolves.toEqual({
      outcome: "completed",
      connections: [{ connectionId: missingId, outcome: "unavailable" }],
    });
    await expect(
      routeRedactedTraceBatch({
        traces: [await mintTrace()],
        configuration: Object.freeze({
          ...value.configuration,
          selectedConnectionIds: Object.freeze([first]),
        }),
        credentialBackendRegistry: compileCredentialBackendRegistry([]),
        transportExecutor: () => Promise.reject(new Error("unexpected")),
        deadline: createReporterDeadline(0),
      }),
    ).resolves.toEqual({
      outcome: "completed",
      connections: [{ connectionId: first, outcome: "deadline-exceeded" }],
    });
    await expect(
      routeRedactedTraceBatch({
        traces: [await mintTrace()],
        configuration: value.configuration,
        credentialBackendRegistry: compileCredentialBackendRegistry([]),
        transportExecutor: () => Promise.reject(new Error("unexpected")),
        deadline: {} as never,
      }),
    ).rejects.toThrow("core.routing.invalid");

    const delayed = routingFixture(60);
    await expect(
      routeRedactedTraceBatch({
        traces: [await mintTrace()],
        configuration: Object.freeze({
          ...delayed.configuration,
          selectedConnectionIds: Object.freeze([
            createDestinationConnectionId(unavailableId),
          ]),
        }),
        credentialBackendRegistry: compileCredentialBackendRegistry([]),
        transportExecutor: () => Promise.reject(new Error("unexpected")),
        deadline: createReporterDeadline(50),
      }),
    ).resolves.toEqual({
      outcome: "completed",
      connections: [
        { connectionId: unavailableId, outcome: "deadline-exceeded" },
      ],
    });
  });
});

describe("Core routing cancellation containment", () => {
  it("contains hostile signal methods and invokes task cancellation", async () => {
    const value = routingFixture();
    const first = value.configuration.selectedConnectionIds[0]!;
    const oneConnection = Object.freeze({
      ...value.configuration,
      selectedConnectionIds: Object.freeze([first]),
    });
    const throwingMethods = Object.freeze({
      aborted: false,
      addEventListener() {
        throw new Error("CANARY_SECRET");
      },
      removeEventListener() {
        throw new Error("CANARY_SECRET");
      },
    }) as unknown as AbortSignal;
    await expect(
      routeRedactedTraceBatch({
        traces: [await mintTrace()],
        configuration: oneConnection,
        credentialBackendRegistry: compileCredentialBackendRegistry([]),
        transportExecutor: () => Promise.reject(new Error("unexpected")),
        deadline: createReporterDeadline(1_000),
        signal: throwingMethods,
      }),
    ).resolves.toEqual({
      outcome: "completed",
      connections: [{ connectionId: first, outcome: "unavailable" }],
    });
    const listenerSignal = {
      get aborted() {
        return false;
      },
      addEventListener(_name: string, listener: () => void) {
        listener();
      },
      removeEventListener() {},
    } as unknown as AbortSignal;
    await expect(
      routeRedactedTraceBatch({
        traces: [await mintTrace()],
        configuration: oneConnection,
        credentialBackendRegistry: compileCredentialBackendRegistry([]),
        transportExecutor: () => Promise.reject(new Error("unexpected")),
        deadline: createReporterDeadline(1_000),
        signal: listenerSignal,
      }),
    ).resolves.toEqual({
      outcome: "completed",
      connections: [{ connectionId: first, outcome: "unavailable" }],
    });
    const throwingAborted = Object.freeze({
      get aborted() {
        throw new Error("CANARY_SECRET");
      },
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as AbortSignal;
    await expect(
      routeRedactedTraceBatch({
        traces: [await mintTrace()],
        configuration: oneConnection,
        credentialBackendRegistry: compileCredentialBackendRegistry([]),
        transportExecutor: () => Promise.reject(new Error("unexpected")),
        deadline: createReporterDeadline(1_000),
        signal: throwingAborted,
      }),
    ).resolves.toEqual({
      outcome: "completed",
      connections: [{ connectionId: first, outcome: "deadline-exceeded" }],
    });
    const delayedThrowingMethods = Object.freeze({
      aborted: false,
      addEventListener() {
        const expiresAt = performance.now() + 60;
        while (performance.now() < expiresAt) {
          // Exercise the catch path after the absolute deadline passes.
        }
        throw new Error("CANARY_SECRET");
      },
      removeEventListener() {},
    }) as unknown as AbortSignal;
    await expect(
      routeRedactedTraceBatch({
        traces: [await mintTrace()],
        configuration: oneConnection,
        credentialBackendRegistry: compileCredentialBackendRegistry([]),
        transportExecutor: () => Promise.reject(new Error("unexpected")),
        deadline: createReporterDeadline(50),
        signal: delayedThrowingMethods,
      }),
    ).resolves.toEqual({
      outcome: "completed",
      connections: [{ connectionId: first, outcome: "deadline-exceeded" }],
    });
  });
});
