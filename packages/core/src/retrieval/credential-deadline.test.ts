import { performance } from "node:perf_hooks";
import {
  compileDestinationRegistry,
  createDestinationReporter,
  createDestinationRetriever,
  createReporterReceipt,
  createRetrieverFailure,
  defineDestinationDescriptor,
} from "@agentscope/destinations-core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  compileCredentialBackendRegistry,
  defineStoredCredentialBackendAdapter,
  type CredentialResolutionContext,
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
import { resolveCredentialsWithinDeadline } from "./credential-setup.js";
import {
  createCoreRetrievalRuntime,
  prepareCoreRetrievalRuntime,
  searchConfiguredTraces,
} from "./orchestration.js";

const clock = vi.hoisted(() => {
  const value = { now: 100 };
  vi.spyOn(globalThis.performance, "now").mockImplementation(() => value.now);
  return value;
});

const fixture = (
  resolve: (
    context: CredentialResolutionContext,
  ) => Promise<Readonly<{ ok: true; secret: string }>>,
) => {
  const settingsSchema = z.strictObject({});
  void settingsSchema.shape;
  z.toJSONSchema(settingsSchema);
  const search = vi.fn(() =>
    Promise.resolve(createRetrieverFailure("unavailable")),
  );
  const descriptor = defineDestinationDescriptor({
    descriptorVersion: 1,
    destinationType: "@agentscope/destination-retrieval-clock",
    commandName: "retrieval-clock",
    settingsVersion: 1,
    settingsSchema,
    defaultSettings: {},
    credentialSlots: [{ id: "token", required: true }],
    documentationPath: "/docs/destinations/retrieval-clock",
    transport: { kind: "local" },
    deliveryIdentitySupport: "duplicates-possible",
    retrievalOrdering: "start-time-desc-trace-id-asc",
    createReporter: () =>
      createDestinationReporter({
        report: () => Promise.resolve(createReporterReceipt("accepted")),
      }),
    createRetriever: () =>
      createDestinationRetriever({
        search,
        get: () => Promise.resolve(createRetrieverFailure("unavailable")),
      }),
  });
  const configuration = parseAgentscopeConfiguration(
    {
      configurationVersion: 2,
      generation: 1,
      destinations: {
        "@agentscope/destination-retrieval-clock": {
          namespaceVersion: 1,
          settingsVersion: 1,
          connections: [
            {
              connectionId: `destination-connection-v1-${"a".repeat(64)}`,
              name: "clock",
              settings: {},
              credentialReferences: {
                token: {
                  referenceVersion: 1,
                  backend: "macos-keychain",
                  referenceId: `credential-reference-v1-${"b".repeat(64)}`,
                  generationId: `credential-generation-v1-${"c".repeat(64)}`,
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
    compileDestinationRegistry([descriptor]),
  );
  const registry = compileCredentialBackendRegistry([
    defineStoredCredentialBackendAdapter("macos-keychain", {
      createPending: () => Promise.resolve({ ok: false, code: "denied" }),
      activate: () => Promise.resolve(false),
      removePending: () => Promise.resolve(false),
      removeOwned: () => Promise.resolve(false),
      resolve: ({ context }) => resolve(context),
    }),
  ]);
  const runtime = (timeoutMilliseconds = 2_000) =>
    createCoreRetrievalRuntime({
      configuration,
      credentialBackendRegistry: registry,
      policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
      transportExecutor: () => Promise.reject(new Error("unused")),
      timeoutMilliseconds,
    });
  return { descriptor, configuration, registry, runtime, search };
};

afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => vi.restoreAllMocks());

describe("retrieval credential setup inherits its earlier runtime deadline", () => {
  it("keeps time spent in the actual configuration reader inside the credential cutoff", async () => {
    clock.now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock.now);
    let captured: CredentialResolutionContext | undefined;
    const value = fixture((context) => {
      captured = context;
      return Promise.resolve({ ok: true, secret: "CANARY" });
    });
    const home = createAgentscopeHomeResolver({
      environment: {
        AGENTSCOPE_HOME: "/tmp/agentscope-credential-clock-fixture",
      },
      environmentOverrideAuthority: "test",
      platform: "linux",
    })();
    const store = createConfigurationStoreForTesting(
      home,
      value.configuration.destinationRegistry,
      {
        readForHook: () => {
          clock.now = 900;
          return Promise.resolve(
            serializeAgentscopeConfiguration(value.configuration),
          );
        },
      },
    );
    const prepared = await prepareCoreRetrievalRuntime({
      configurationStore: store,
      credentialBackendRegistry: value.registry,
      policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
      transportExecutor: () => Promise.reject(new Error("unused")),
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    await searchConfiguredTraces(prepared.runtime, {
      destinationName: "clock",
      query: {},
    });
    expect(captured?.expiresAtMonotonicMilliseconds).toBe(2_100);
  });

  it("propagates the original two-second expiry after setup time was consumed", async () => {
    clock.now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock.now);
    let captured: CredentialResolutionContext | undefined;
    const value = fixture((context) => {
      captured = context;
      return Promise.resolve({ ok: true, secret: "CANARY" });
    });
    const runtime = value.runtime();
    clock.now = 900;
    await searchConfiguredTraces(runtime, {
      destinationName: "clock",
      query: {},
    });
    expect(captured?.expiresAtMonotonicMilliseconds).toBe(
      runtime.deadline.expiresAtMonotonicMilliseconds,
    );
    expect(captured?.expiresAtMonotonicMilliseconds).toBe(2_100);
    expect(value.search).toHaveBeenCalledOnce();
  });

  it("does not invent a two-second reset for a selected shorter runtime", async () => {
    clock.now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock.now);
    let captured: CredentialResolutionContext | undefined;
    const value = fixture((context) => {
      captured = context;
      return Promise.resolve({ ok: true, secret: "CANARY" });
    });
    const runtime = value.runtime(500);
    clock.now = 400;
    await searchConfiguredTraces(runtime, {
      destinationName: "clock",
      query: {},
    });
    expect(captured?.expiresAtMonotonicMilliseconds).toBe(600);
  });

  it("rejects late success before destination invocation without relying on a timer callback", async () => {
    clock.now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock.now);
    const value = fixture((context) => {
      clock.now = context.expiresAtMonotonicMilliseconds!;
      return Promise.resolve({ ok: true, secret: "CANARY" });
    });
    await expect(
      searchConfiguredTraces(value.runtime(), {
        destinationName: "clock",
        query: {},
      }),
    ).resolves.toEqual({ ok: false, code: "deadline-exceeded" });
    expect(value.search).not.toHaveBeenCalled();
  });
});

describe("retrieval setup settlement boundaries", () => {
  it("does not miss cancellation initiated synchronously during backend entry", async () => {
    vi.spyOn(performance, "now").mockReturnValue(100);
    const controller = new AbortController();
    const value = fixture(() => {
      controller.abort();
      return new Promise(() => {});
    });
    await expect(
      resolveCredentialsWithinDeadline(
        value.descriptor,
        value.configuration.connections[0]!,
        value.registry,
        controller,
        2_100,
      ),
    ).resolves.toEqual({ kind: "expired" });
  });

  it("preserves ordinary failed resolution and omitted credentials", async () => {
    vi.spyOn(performance, "now").mockReturnValue(100);
    const value = fixture(() => Promise.reject(new Error("CANARY")));
    const connection = value.configuration.connections[0]!;
    const controller = new AbortController();
    await expect(
      resolveCredentialsWithinDeadline(
        value.descriptor,
        connection,
        value.registry,
        controller,
        2_100,
      ),
    ).resolves.toEqual({ kind: "failed" });
    await expect(
      resolveCredentialsWithinDeadline(
        value.descriptor,
        { ...connection, credentialReferences: {} },
        value.registry,
        controller,
        2_100,
      ),
    ).resolves.toEqual({ kind: "resolved", credentials: {} });
  });

  it("refuses an expired or cancelled setup before backend access", async () => {
    vi.spyOn(performance, "now").mockReturnValue(200);
    const resolve = vi.fn(() =>
      Promise.resolve({ ok: true as const, secret: "CANARY" }),
    );
    const value = fixture(resolve);
    const controller = new AbortController();
    const connection = value.configuration.connections[0]!;
    await expect(
      resolveCredentialsWithinDeadline(
        value.descriptor,
        connection,
        value.registry,
        controller,
        200,
      ),
    ).resolves.toEqual({ kind: "expired" });
    controller.abort();
    await expect(
      resolveCredentialsWithinDeadline(
        value.descriptor,
        connection,
        value.registry,
        controller,
        500,
      ),
    ).resolves.toEqual({ kind: "expired" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("observes late rejection after caller cancellation and removes the abort observer", async () => {
    vi.spyOn(performance, "now").mockReturnValue(100);
    let reject: ((reason: Error) => void) | undefined;
    const value = fixture(
      () =>
        new Promise((_resolve, reject_) => {
          reject = reject_;
        }),
    );
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = resolveCredentialsWithinDeadline(
      value.descriptor,
      value.configuration.connections[0]!,
      value.registry,
      controller,
      2_100,
    );
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: "expired" });
    reject?.(new Error("CANARY"));
    await Promise.resolve();
    expect(remove).toHaveBeenCalledOnce();
  });
});
