import {
  mkdtemp,
  open as nodeOpen,
  readFile,
  rename as nodeRename,
  rm,
  unlink as nodeUnlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileDestinationRegistry,
  createDestinationReporter,
  createReporterReceipt,
  defineDestinationDescriptor,
} from "@agentscope/destinations-core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CredentialAdapterError,
  compileCredentialBackendRegistry,
  createCiEnvironmentCredentialAdapter,
  createCiEnvironmentCredentialReference,
  createCredentialOwnership,
  createCredentialResolutionContext,
  createStoredCredentialReference,
  defineStoredCredentialBackendAdapter,
  deriveStoredCredentialReference,
  getStoredCredentialImplementation,
  isResolvedCredential,
  readResolvedCredentialForCore,
  resolveCredentialReference,
  type CredentialResolutionFailure,
  type StoredCredentialBackendImplementation,
} from "./credential-adapter.js";
import {
  configureCredential,
  credentialOwnershipMatches,
  CredentialLifecycleError,
  purgeUnreferencedCredential,
  recoverCredentialMutation,
  removeCredentialReference,
  retireCredentialReference,
} from "./credential-lifecycle.js";
import { createAgentscopeHomeResolver } from "./home.js";
import {
  parseAgentscopeConfiguration,
  serializeAgentscopeConfiguration,
  type ConfigurationCredentialReference,
} from "./schema.js";
import {
  ConfigurationCrashSimulation,
  completeCredentialMutationIntent,
  createConfigurationProcessIdentity,
  createConfigurationStore,
  createConfigurationStoreForTesting,
  createCredentialMutationIntent,
  readConfigurationSnapshot,
  writeConfigurationSnapshot,
} from "./transaction.js";

const connectionId =
  "destination-connection-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const referenceId =
  "credential-reference-v1-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const generationId =
  "credential-generation-v1-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const settingsSchema = z.strictObject({ project: z.string() });
void settingsSchema.shape;
z.toJSONSchema(settingsSchema);
const descriptor = defineDestinationDescriptor({
  descriptorVersion: 1,
  destinationType: "@agentscope/destination-example",
  commandName: "example",
  settingsVersion: 1,
  settingsSchema,
  defaultSettings: { project: "default" },
  credentialSlots: [{ id: "api-key", required: true }],
  documentationPath: "/docs/destinations/example",
  deliveryIdentitySupport: "duplicates-possible",
  transport: { kind: "local" },
  createReporter: () =>
    createDestinationReporter({
      report: () => Promise.resolve(createReporterReceipt("accepted")),
    }),
});
const destinationRegistry = compileDestinationRegistry([descriptor]);
const ownership = createCredentialOwnership({
  destinationType: "@agentscope/destination-example",
  connectionId,
  slot: "api-key",
});
const owner = createConfigurationProcessIdentity(
  72,
  `process-start-v1-${"e".repeat(64)}`,
);
const context = () =>
  createCredentialResolutionContext(
    "hook-equivalent",
    new AbortController().signal,
  );
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const storeFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "agentscope-credential-"));
  roots.push(root);
  const home = createAgentscopeHomeResolver({
    environment: { AGENTSCOPE_HOME: join(root, "home") },
    environmentOverrideAuthority: "test",
    platform: process.platform,
  })();
  return {
    home,
    store: createConfigurationStore(home, destinationRegistry),
  };
};

const candidate = (
  generation: number,
  reference: ConfigurationCredentialReference,
) =>
  parseAgentscopeConfiguration(
    {
      configurationVersion: 1,
      generation,
      destinations: {
        "@agentscope/destination-example": {
          namespaceVersion: 1,
          settingsVersion: 1,
          connections: [
            {
              connectionId,
              name: "primary",
              settings: { project: "example" },
              credentialReferences: { "api-key": reference },
            },
          ],
        },
      },
      routing: { version: 1, selectedConnectionIds: [connectionId] },
      policy: { version: 1, reference: "policy-v1" },
    },
    destinationRegistry,
  );

const candidateWithoutCredential = (generation: number) =>
  parseAgentscopeConfiguration(
    {
      configurationVersion: 1,
      generation,
      destinations: {},
      routing: { version: 1, selectedConnectionIds: [] },
      policy: { version: 1, reference: "policy-v1" },
    },
    destinationRegistry,
  );

const createRetirementIntent = (
  store: ReturnType<typeof createConfigurationStore>,
  reference: ConfigurationCredentialReference,
) =>
  createCredentialMutationIntent(store, {
    recordVersion: 1,
    operation: "retire",
    owner,
    ownership,
    reference,
  });

type BackendOptions = Readonly<{
  createFailure?: CredentialResolutionFailure;
  resolveFailure?: CredentialResolutionFailure;
  activate?: boolean;
  remove?: boolean;
  activateThrows?: boolean;
  removeThrows?: boolean;
  beforeRemoveOwned?: () => Promise<void>;
}>;

const storedBackend = (options: BackendOptions = {}) => {
  const events: string[] = [];
  let secret: string | undefined;
  const implementation: StoredCredentialBackendImplementation = {
    createPending: (input) => {
      events.push("create-pending");
      secret = input.secret;
      return Promise.resolve(
        options.createFailure
          ? { ok: false as const, code: options.createFailure }
          : {
              ok: true as const,
              referenceId: deriveStoredCredentialReference(
                "macos-keychain",
                input.ownership,
                input.generationId,
              ).referenceId,
            },
      );
    },
    resolve: () => {
      events.push("resolve");
      return Promise.resolve(
        options.resolveFailure
          ? { ok: false as const, code: options.resolveFailure }
          : { ok: true as const, secret: secret ?? "CANARY_SECRET" },
      );
    },
    activate: () => {
      events.push("activate");
      if (options.activateThrows)
        return Promise.reject(new Error("CANARY_SECRET"));
      return Promise.resolve(options.activate ?? true);
    },
    removePending: () => {
      events.push("remove-pending");
      if (options.removeThrows)
        return Promise.reject(new Error("CANARY_SECRET"));
      return Promise.resolve(options.remove ?? true);
    },
    removeOwned: async () => {
      events.push("remove-owned");
      await options.beforeRemoveOwned?.();
      if (options.removeThrows) throw new Error("CANARY_SECRET");
      return options.remove ?? true;
    },
  };
  const adapter = defineStoredCredentialBackendAdapter(
    "macos-keychain",
    implementation,
  );
  return {
    events,
    registry: compileCredentialBackendRegistry([adapter]),
  };
};

describe("credential adapters", () => {
  it("resolves only the explicitly referenced CI environment value", async () => {
    let getterCalls = 0;
    const environment = Object.defineProperty(
      { AGENTSCOPE_KEY: "CANARY_SECRET", UNRELATED_SECRET: "DO_NOT_READ" },
      "ACCESSOR_SECRET",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "DO_NOT_READ";
        },
      },
    );
    const registry = compileCredentialBackendRegistry([
      createCiEnvironmentCredentialAdapter(environment),
    ]);
    const reference = createCiEnvironmentCredentialReference(
      "AGENTSCOPE_KEY",
      generationId,
    );
    const result = await resolveCredentialReference(
      registry,
      reference,
      context(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isResolvedCredential(result.credential)).toBe(true);
      expect(readResolvedCredentialForCore(result.credential)).toBe(
        "CANARY_SECRET",
      );
      expect(Object.keys(result.credential)).toEqual(["resolvedCredential"]);
    }
    expect(getterCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("CANARY_SECRET");
  });

  it("returns stable missing, malformed, denied, unavailable, and aborted outcomes", async () => {
    const environment = Object.defineProperty(
      { WRONG: 7, EMPTY: "", UNDEFINED: undefined },
      "ACCESSOR",
      { get: () => "CANARY_SECRET" },
    );
    const registry = compileCredentialBackendRegistry([
      createCiEnvironmentCredentialAdapter(environment),
    ]);
    for (const [name, code] of [
      ["MISSING", "missing"],
      ["WRONG", "malformed"],
      ["EMPTY", "malformed"],
      ["UNDEFINED", "missing"],
      ["ACCESSOR", "denied"],
    ] as const)
      await expect(
        resolveCredentialReference(
          registry,
          createCiEnvironmentCredentialReference(name, generationId),
          context(),
        ),
      ).resolves.toEqual({ ok: false, code });
    const controller = new AbortController();
    controller.abort();
    await expect(
      resolveCredentialReference(
        registry,
        createCiEnvironmentCredentialReference("MISSING", generationId),
        createCredentialResolutionContext("hook", controller.signal),
      ),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("CANARY_SECRET");
        },
      },
    );
    await expect(
      resolveCredentialReference(
        compileCredentialBackendRegistry([
          createCiEnvironmentCredentialAdapter(hostile),
        ]),
        createCiEnvironmentCredentialReference("MISSING", generationId),
        context(),
      ),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
  });
});

describe("credential adapter authority", () => {
  it("rejects malformed identities, adapters, registries, and contexts", () => {
    const adapter = createCiEnvironmentCredentialAdapter({ KEY: "value" });
    const sparse = new Array(1);
    const custom = [adapter];
    Object.defineProperty(custom, Symbol.iterator, {
      value: function* () {
        yield adapter;
      },
    });
    for (const input of [
      null,
      sparse,
      custom,
      [{ ...adapter }],
      [adapter, adapter],
    ])
      expect(() =>
        compileCredentialBackendRegistry(input as never),
      ).toThrowError(CredentialAdapterError);
    expect(() =>
      createCredentialOwnership({
        destinationType: "bad",
        connectionId,
        slot: "api-key",
      }),
    ).toThrowError(CredentialAdapterError);
    expect(() =>
      createCredentialResolutionContext("invalid" as never, {} as never),
    ).toThrowError(CredentialAdapterError);
    expect(() =>
      createStoredCredentialReference(
        "macos-keychain",
        "credential-reference-v1-invalid",
        generationId,
      ),
    ).toThrowError(CredentialAdapterError);
    expect(() =>
      deriveStoredCredentialReference(
        "macos-keychain",
        {} as never,
        generationId,
      ),
    ).toThrowError(CredentialAdapterError);
    expect(() => createCredentialOwnership(new Date() as never)).toThrowError(
      CredentialAdapterError,
    );
    expect(() =>
      defineStoredCredentialBackendAdapter("macos-keychain", {
        createPending: 1,
      } as never),
    ).toThrowError(CredentialAdapterError);
    expect(
      credentialOwnershipMatches(
        ownership,
        descriptor.destinationType,
        ownership.connectionId,
        ownership.slot,
      ),
    ).toBe(true);
    expect(
      credentialOwnershipMatches(
        ownership,
        descriptor.destinationType,
        ownership.connectionId,
        "other" as never,
      ),
    ).toBe(false);
  });
});

describe("credential adapter runtime authority", () => {
  it("rejects hostile records and every malformed reference shape", async () => {
    const backend = storedBackend();
    const throwing = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("CANARY_SECRET");
        },
      },
    );
    expect(() => createCredentialOwnership(throwing as never)).toThrowError(
      CredentialAdapterError,
    );
    expect(() =>
      defineStoredCredentialBackendAdapter("macos-keychain", null as never),
    ).toThrowError(CredentialAdapterError);
    expect(() =>
      defineStoredCredentialBackendAdapter(
        "macos-keychain",
        new Proxy({} as never, {
          ownKeys: () => {
            throw new Error("CANARY_SECRET");
          },
        }),
      ),
    ).toThrowError(CredentialAdapterError);
    const fullImplementation = storedBackend().registry;
    void fullImplementation;
    expect(() =>
      defineStoredCredentialBackendAdapter("macos-keychain", {
        createPending: () => Promise.resolve({ ok: true, referenceId }),
        resolve: () => Promise.resolve({ ok: true, secret: "secret" }),
        activate: () => Promise.resolve(true),
        removePending: () => Promise.resolve(true),
        removeOwned: 1,
      } as never),
    ).toThrowError(CredentialAdapterError);
    for (const reference of [
      null,
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("CANARY_SECRET");
          },
        },
      ),
      { referenceVersion: 2, backend: "ci-environment" },
      {
        referenceVersion: 1,
        backend: "ci-environment",
        environmentVariable: "lowercase",
        generationId,
      },
      {
        referenceVersion: 1,
        backend: "macos-keychain",
        referenceId: "bad",
        generationId,
      },
    ])
      await expect(
        resolveCredentialReference(
          backend.registry,
          reference as never,
          context(),
        ),
      ).rejects.toThrowError(CredentialAdapterError);
    await expect(
      resolveCredentialReference(
        backend.registry,
        createStoredCredentialReference(
          "macos-keychain",
          referenceId,
          generationId,
        ),
        {} as never,
      ),
    ).rejects.toThrowError(CredentialAdapterError);
    const hostileArray = new Proxy([], {
      ownKeys: () => {
        throw new Error("CANARY_SECRET");
      },
    });
    expect(() => compileCredentialBackendRegistry(hostileArray)).toThrowError(
      CredentialAdapterError,
    );
  });
});

describe("credential adapter result authority", () => {
  it("rejects forged authority and malformed references without invoking backends", async () => {
    const backend = storedBackend();
    const forged = { credentialBackendRegistry: "agentscope-core" };
    await expect(
      resolveCredentialReference(
        forged as never,
        createStoredCredentialReference(
          "macos-keychain",
          referenceId,
          generationId,
        ),
        context(),
      ),
    ).rejects.toThrowError(CredentialAdapterError);
    await expect(
      resolveCredentialReference(
        backend.registry,
        Object.defineProperty({}, "backend", {
          enumerable: true,
          get: () => "macos-keychain",
        }) as never,
        context(),
      ),
    ).rejects.toThrowError(CredentialAdapterError);
    expect(() => readResolvedCredentialForCore({} as never)).toThrowError(
      CredentialAdapterError,
    );
    expect(() => createCiEnvironmentCredentialAdapter(null)).toThrowError(
      CredentialAdapterError,
    );
    expect(() =>
      createCiEnvironmentCredentialReference("lowercase", generationId),
    ).toThrowError(CredentialAdapterError);
    expect(() =>
      defineStoredCredentialBackendAdapter("invalid" as never, {} as never),
    ).toThrowError(CredentialAdapterError);
    expect(backend.events).toEqual([]);
  });

  it("normalizes stored backend failures and hostile result DTOs", async () => {
    const base = storedBackend().registry;
    void base;
    const makeRegistry = (
      resolve: StoredCredentialBackendImplementation["resolve"],
    ) =>
      compileCredentialBackendRegistry([
        defineStoredCredentialBackendAdapter("linux-secret-service", {
          createPending: () => Promise.resolve({ ok: true, referenceId }),
          resolve,
          activate: () => Promise.resolve(true),
          removePending: () => Promise.resolve(true),
          removeOwned: () => Promise.resolve(true),
        }),
      ]);
    const reference = createStoredCredentialReference(
      "linux-secret-service",
      referenceId,
      generationId,
    );
    for (const [resolve, expected] of [
      [
        () => Promise.resolve({ ok: true as const, secret: "stored-secret" }),
        true,
      ],
      [() => Promise.resolve({ ok: true as const, secret: "pair-😀" }), true],
      [
        () => Promise.resolve({ ok: true as const, secret: "bad-\udc00" }),
        "malformed",
      ],
      [
        () => Promise.resolve({ ok: true as const, secret: "bad-\ud800" }),
        "malformed",
      ],
      [
        () => Promise.resolve({ ok: false as const, code: "locked" as const }),
        "locked",
      ],
      [
        () => Promise.resolve({ ok: false as const, code: "other" as never }),
        "malformed",
      ],
      [() => Promise.resolve(null as never), "malformed"],
      [() => Promise.reject(new Error("CANARY_SECRET")), "unavailable"],
    ] as const) {
      const result = await resolveCredentialReference(
        makeRegistry(resolve),
        reference,
        context(),
      );
      expect(result.ok ? true : result.code).toBe(expected);
      expect(JSON.stringify(result)).not.toContain("CANARY_SECRET");
    }
    const hostile = Object.defineProperty({ ok: true }, "secret", {
      enumerable: true,
      get: () => "CANARY_SECRET",
    });
    await expect(
      resolveCredentialReference(
        makeRegistry(() => Promise.resolve(hostile as never)),
        reference,
        context(),
      ),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
  });
});

describe("credential configuration lifecycle", () => {
  it("creates, preflights, commits, and activates a stored credential", async () => {
    const { home, store } = await storeFixture();
    const backend = storedBackend();
    const result = await configureCredential(backend.registry, {
      store,
      owner,
      expectedGeneration: null,
      ownership,
      request: {
        kind: "stored",
        backend: "macos-keychain",
        secret: "CANARY_😀",
      },
      resolutionContext: context(),
      createCandidate: (reference) => candidate(0, reference),
    });
    expect(result).toMatchObject({ ok: true, state: "active" });
    expect(backend.events).toEqual(["create-pending", "resolve", "activate"]);
    const persisted = await readFile(home.configFile, "utf8");
    expect(persisted).not.toContain("CANARY_SECRET");
    expect(JSON.stringify(result)).not.toContain("CANARY_SECRET");
    await expect(readConfigurationSnapshot(store)).resolves.toMatchObject({
      generation: 0,
    });
  });

  it("commits an explicit CI reference without copying its value", async () => {
    const { home, store } = await storeFixture();
    const registry = compileCredentialBackendRegistry([
      createCiEnvironmentCredentialAdapter({ AGENTSCOPE_KEY: "CANARY_SECRET" }),
    ]);
    const result = await configureCredential(registry, {
      store,
      owner,
      expectedGeneration: null,
      ownership,
      request: {
        kind: "ci-environment",
        environmentVariable: "AGENTSCOPE_KEY",
      },
      resolutionContext: context(),
      createCandidate: (reference) => candidate(0, reference),
    });
    expect(result).toMatchObject({
      ok: true,
      state: "active",
      reference: {
        backend: "ci-environment",
        environmentVariable: "AGENTSCOPE_KEY",
      },
    });
    expect(await readFile(home.configFile, "utf8")).not.toContain(
      "CANARY_SECRET",
    );
  });

  it("fails a missing CI preflight without compensation", async () => {
    const { store } = await storeFixture();
    await expect(
      configureCredential(
        compileCredentialBackendRegistry([
          createCiEnvironmentCredentialAdapter({}),
        ]),
        {
          store,
          owner,
          expectedGeneration: null,
          ownership,
          request: {
            kind: "ci-environment",
            environmentVariable: "AGENTSCOPE_KEY",
          },
          resolutionContext: context(),
          createCandidate: (reference) => candidate(0, reference),
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      state: "compensated",
      code: "core.credential.preflight-missing",
    });
  });

  it.each(["unavailable", "locked", "denied", "missing", "malformed"] as const)(
    "compensates a %s preflight failure",
    async (failure) => {
      const { store } = await storeFixture();
      const backend = storedBackend({ resolveFailure: failure });
      await expect(
        configureCredential(backend.registry, {
          store,
          owner,
          expectedGeneration: null,
          ownership,
          request: {
            kind: "stored",
            backend: "macos-keychain",
            secret: "CANARY_SECRET",
          },
          resolutionContext: context(),
          createCandidate: (reference) => candidate(0, reference),
        }),
      ).resolves.toMatchObject({
        ok: false,
        state: "compensated",
        code: `core.credential.preflight-${failure}`,
        configurationCommitted: false,
      });
      expect(backend.events).toEqual([
        "create-pending",
        "resolve",
        "remove-pending",
      ]);
    },
  );
});

describe("credential configuration compensation", () => {
  it("compensates invalid candidates and CAS conflicts without deleting prior credentials", async () => {
    const { store } = await storeFixture();
    const prior = createStoredCredentialReference(
      "macos-keychain",
      `credential-reference-v1-${"a".repeat(64)}`,
      `credential-generation-v1-${"b".repeat(64)}`,
    );
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidate(0, prior),
      owner,
    });
    for (const createCandidate of [
      () => candidate(1, prior),
      (reference: ConfigurationCredentialReference) => candidate(2, reference),
    ]) {
      const backend = storedBackend();
      const result = await configureCredential(backend.registry, {
        store,
        owner,
        expectedGeneration: 0,
        ownership,
        request: {
          kind: "stored",
          backend: "macos-keychain",
          secret: "CANARY_SECRET",
        },
        resolutionContext: context(),
        createCandidate,
      });
      expect(result).toMatchObject({
        ok: false,
        state: "compensated",
        configurationCommitted: false,
      });
      expect(backend.events.at(-1)).toBe("remove-pending");
    }
    expect(
      serializeAgentscopeConfiguration(await readConfigurationSnapshot(store)),
    ).toContain("referenceId" in prior ? prior.referenceId : "unreachable");
  });

  it("retains a referenced pending credential when activation fails", async () => {
    const { store } = await storeFixture();
    const backend = storedBackend({ activate: false });
    const result = await configureCredential(backend.registry, {
      store,
      owner,
      expectedGeneration: null,
      ownership,
      request: {
        kind: "stored",
        backend: "macos-keychain",
        secret: "CANARY_SECRET",
      },
      resolutionContext: context(),
      createCandidate: (reference) => candidate(0, reference),
    });
    expect(result).toMatchObject({
      ok: false,
      state: "referenced-pending",
      code: "core.credential.activation-failed",
      configurationCommitted: true,
    });
    expect(backend.events).not.toContain("remove-pending");
    await expect(readConfigurationSnapshot(store)).resolves.toMatchObject({
      generation: 0,
    });
  });

  it("retains a referenced pending credential when activation throws", async () => {
    const { store } = await storeFixture();
    const backend = storedBackend({ activateThrows: true });
    await expect(
      configureCredential(backend.registry, {
        store,
        owner,
        expectedGeneration: null,
        ownership,
        request: {
          kind: "stored",
          backend: "macos-keychain",
          secret: "CANARY_SECRET",
        },
        resolutionContext: context(),
        createCandidate: (reference) => candidate(0, reference),
      }),
    ).resolves.toMatchObject({
      ok: false,
      state: "referenced-pending",
      code: "core.credential.activation-failed",
    });
  });
});

describe("credential mutation intent finalization", () => {
  it("retains referenced state when mutation intent finalization fails", async () => {
    const { home } = await storeFixture();
    const store = createConfigurationStoreForTesting(
      home,
      destinationRegistry,
      {
        fileSystem: {
          open: nodeOpen,
          rename: nodeRename,
          unlink: (file: Parameters<typeof nodeUnlink>[0]) =>
            String(file).endsWith("credential.lock")
              ? Promise.reject(new Error("CANARY_SECRET"))
              : nodeUnlink(file),
        },
      },
    );
    await expect(
      configureCredential(storedBackend().registry, {
        store,
        owner,
        expectedGeneration: null,
        ownership,
        request: {
          kind: "stored",
          backend: "macos-keychain",
          secret: "CANARY_SECRET",
        },
        resolutionContext: context(),
        createCandidate: (reference) => candidate(0, reference),
      }),
    ).resolves.toMatchObject({
      ok: false,
      state: "referenced-pending",
      code: "core.credential.intent-finalization-failed",
      configurationCommitted: true,
    });
  });
});

describe("credential configuration hostile boundaries", () => {
  it("retains deterministic orphan evidence after an uncertain creation failure", async () => {
    const { store } = await storeFixture();
    await expect(
      configureCredential(storedBackend({ createFailure: "denied" }).registry, {
        store,
        owner,
        expectedGeneration: null,
        ownership,
        request: {
          kind: "stored",
          backend: "macos-keychain",
          secret: "secret",
        },
        resolutionContext: context(),
        createCandidate: (reference) => candidate(0, reference),
      }),
    ).resolves.toMatchObject({
      ok: false,
      state: "orphan-pending",
      code: "core.credential.create-failed",
      reference: { backend: "macos-keychain" },
    });
  });

  it("compensates when storage does not round-trip the exact value", async () => {
    const { store } = await storeFixture();
    const backend = storedBackend();
    const implementation = getStoredCredentialImplementation(
      backend.registry,
      "macos-keychain",
    );
    const mismatched = compileCredentialBackendRegistry([
      defineStoredCredentialBackendAdapter("macos-keychain", {
        ...implementation,
        resolve: () =>
          Promise.resolve({ ok: true as const, secret: "DIFFERENT_SECRET" }),
      }),
    ]);
    await expect(
      configureCredential(mismatched, {
        store,
        owner,
        expectedGeneration: null,
        ownership,
        request: {
          kind: "stored",
          backend: "macos-keychain",
          secret: "EXPECTED_SECRET",
        },
        resolutionContext: context(),
        createCandidate: (reference) => candidate(0, reference),
      }),
    ).resolves.toMatchObject({
      ok: false,
      state: "compensated",
      code: "core.credential.preflight-malformed",
      configurationCommitted: false,
    });
  });

  it("reports owned orphan evidence when compensation cannot remove pending state", async () => {
    const { store } = await storeFixture();
    const backend = storedBackend({ resolveFailure: "missing", remove: false });
    await expect(
      configureCredential(backend.registry, {
        store,
        owner,
        expectedGeneration: null,
        ownership,
        request: {
          kind: "stored",
          backend: "macos-keychain",
          secret: "CANARY_SECRET",
        },
        resolutionContext: context(),
        createCandidate: (reference) => candidate(0, reference),
      }),
    ).resolves.toMatchObject({
      ok: false,
      state: "orphan-pending",
      code: "core.credential.compensation-failed",
      configurationCommitted: false,
    });
  });

  it("contains compensation exceptions as owned orphan evidence", async () => {
    const { store } = await storeFixture();
    const backend = storedBackend({
      resolveFailure: "missing",
      removeThrows: true,
    });
    await expect(
      configureCredential(backend.registry, {
        store,
        owner,
        expectedGeneration: null,
        ownership,
        request: {
          kind: "stored",
          backend: "macos-keychain",
          secret: "CANARY_SECRET",
        },
        resolutionContext: context(),
        createCandidate: (reference) => candidate(0, reference),
      }),
    ).resolves.toMatchObject({
      ok: false,
      state: "orphan-pending",
      code: "core.credential.compensation-failed",
    });
  });
});

describe("credential hostile value boundaries", () => {
  it("contains a hostile backend creation result", async () => {
    const { store } = await storeFixture();
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("CANARY_SECRET");
        },
      },
    );
    const registry = compileCredentialBackendRegistry([
      defineStoredCredentialBackendAdapter("linux-secret-service", {
        createPending: () => Promise.resolve(hostile as never),
        resolve: () => Promise.resolve({ ok: true, secret: "secret" }),
        activate: () => Promise.resolve(true),
        removePending: () => Promise.resolve(true),
        removeOwned: () => Promise.resolve(true),
      }),
    ]);
    await expect(
      configureCredential(registry, {
        store,
        owner,
        expectedGeneration: null,
        ownership,
        request: {
          kind: "stored",
          backend: "linux-secret-service",
          secret: "secret",
        },
        resolutionContext: context(),
        createCandidate: (reference) => candidate(0, reference),
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "core.credential.create-failed",
    });
  });

  it("rejects malformed stored secrets and throwing lifecycle proxies", async () => {
    const { store } = await storeFixture();
    const backend = storedBackend();
    for (const secret of [
      "",
      "bad\0secret",
      "\ud800",
      "\udc00",
      "\ud800x",
      "\ud800\ue000",
    ]) {
      await expect(
        configureCredential(backend.registry, {
          store,
          owner,
          expectedGeneration: null,
          ownership,
          request: { kind: "stored", backend: "macos-keychain", secret },
          resolutionContext: context(),
          createCandidate: (reference) => candidate(0, reference),
        }),
      ).rejects.toThrowError(CredentialLifecycleError);
    }
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("CANARY_SECRET");
        },
      },
    );
    await expect(
      configureCredential(backend.registry, proxy as never),
    ).rejects.toThrowError(CredentialLifecycleError);
    expect(backend.events).toEqual([]);
  });

  it("contains backend creation and activation exceptions", async () => {
    const { store } = await storeFixture();
    const implementation: StoredCredentialBackendImplementation = {
      createPending: () => Promise.reject(new Error("CANARY_SECRET")),
      resolve: () => Promise.resolve({ ok: true, secret: "secret" }),
      activate: () => Promise.reject(new Error("CANARY_SECRET")),
      removePending: () => Promise.reject(new Error("CANARY_SECRET")),
      removeOwned: () => Promise.reject(new Error("CANARY_SECRET")),
    };
    const registry = compileCredentialBackendRegistry([
      defineStoredCredentialBackendAdapter(
        "windows-credential-manager",
        implementation,
      ),
    ]);
    await expect(
      configureCredential(registry, {
        store,
        owner,
        expectedGeneration: null,
        ownership,
        request: {
          kind: "stored",
          backend: "windows-credential-manager",
          secret: "secret",
        },
        resolutionContext: context(),
        createCandidate: (reference) => candidate(0, reference),
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "core.credential.create-failed",
    });
  });
});

describe("credential lifecycle callback containment", () => {
  it("rejects malformed top-level and nested request records", async () => {
    const { store } = await storeFixture();
    const backend = storedBackend();
    const base = {
      store,
      owner,
      expectedGeneration: null,
      ownership,
      resolutionContext: context(),
      createCandidate: (reference: ConfigurationCredentialReference) =>
        candidate(0, reference),
    };
    for (const input of [
      null,
      { ...base, request: null },
      {
        ...base,
        request: Object.defineProperty(
          { kind: "stored", backend: "macos-keychain" },
          "secret",
          { enumerable: true, get: () => "CANARY_SECRET" },
        ),
      },
      {
        ...base,
        request: new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error("CANARY_SECRET");
            },
          },
        ),
      },
      {
        ...base,
        expectedGeneration: -1,
        request: {
          kind: "ci-environment",
          environmentVariable: "AGENTSCOPE_KEY",
        },
      },
    ])
      await expect(
        configureCredential(backend.registry, input as never),
      ).rejects.toThrowError(CredentialLifecycleError);
    expect(backend.events).toEqual([]);
  });

  it("rejects hostile lifecycle inputs before backend invocation", async () => {
    const { store } = await storeFixture();
    const backend = storedBackend();
    let getterCalls = 0;
    const input = Object.defineProperty(
      {
        store,
        owner,
        expectedGeneration: null,
        ownership,
        resolutionContext: context(),
        createCandidate: () =>
          candidate(
            0,
            createStoredCredentialReference(
              "macos-keychain",
              referenceId,
              generationId,
            ),
          ),
      },
      "request",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return {
            kind: "stored",
            backend: "macos-keychain",
            secret: "CANARY_SECRET",
          };
        },
      },
    );
    await expect(
      configureCredential(backend.registry, input as never),
    ).rejects.toThrowError(CredentialLifecycleError);
    expect(getterCalls).toBe(0);
    expect(backend.events).toEqual([]);
  });
});

describe("credential asynchronous callback containment", () => {
  it("contains a synchronous candidate exception", async () => {
    const { store } = await storeFixture();
    await expect(
      configureCredential(storedBackend().registry, {
        store,
        owner,
        expectedGeneration: null,
        ownership,
        request: {
          kind: "stored",
          backend: "macos-keychain",
          secret: "secret",
        },
        resolutionContext: context(),
        createCandidate: () => {
          throw new Error("CANARY_SECRET");
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "core.credential.candidate-invalid",
    });
  });

  it("safely observes accidental asynchronous candidate construction", async () => {
    const { store } = await storeFixture();
    const backend = storedBackend();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const result = await configureCredential(backend.registry, {
        store,
        owner,
        expectedGeneration: null,
        ownership,
        request: {
          kind: "stored",
          backend: "macos-keychain",
          secret: "CANARY_SECRET",
        },
        resolutionContext: context(),
        createCandidate: (() =>
          Promise.reject(new Error("CANARY_SECRET"))) as never,
      });
      expect(result).toMatchObject({
        ok: false,
        code: "core.credential.candidate-invalid",
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("rejects an asynchronously resolved candidate and a missing connection", async () => {
    const { store } = await storeFixture();
    for (const createCandidate of [
      () => Promise.resolve(candidateWithoutCredential(0)),
      () => candidateWithoutCredential(0),
    ]) {
      const backend = storedBackend();
      await expect(
        configureCredential(backend.registry, {
          store,
          owner,
          expectedGeneration: null,
          ownership,
          request: {
            kind: "stored",
            backend: "macos-keychain",
            secret: "secret",
          },
          resolutionContext: context(),
          createCandidate: createCandidate as never,
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: "core.credential.candidate-invalid",
      });
    }
  });
});

describe("credential rotation and removal", () => {
  it("retains an old credential while last-known-good references it, then removes it", async () => {
    const { store } = await storeFixture();
    const backend = storedBackend();
    const prior = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidate(0, prior),
      owner,
    });
    await expect(
      removeCredentialReference({
        store,
        owner,
        expectedGeneration: 0,
        ownership,
        reference: prior,
        resolutionContext: context(),
        createCandidate: () => candidateWithoutCredential(1),
      }),
    ).resolves.toEqual({
      ok: true,
      state: "retained-last-known-good",
      configurationCommitted: true,
    });
    const intent = await createRetirementIntent(store, prior);
    await expect(
      purgeUnreferencedCredential(backend.registry, {
        store,
        intent,
        ownership,
        reference: prior,
        resolutionContext: context(),
      }),
    ).resolves.toEqual({
      ok: true,
      state: "retained-last-known-good",
      configurationCommitted: false,
    });
    expect(backend.events).not.toContain("remove-owned");

    await writeConfigurationSnapshot(store, {
      expectedGeneration: 1,
      candidate: candidateWithoutCredential(2),
      owner,
      credentialMutationIntent: intent,
    });
    await expect(
      purgeUnreferencedCredential(backend.registry, {
        store,
        intent,
        ownership,
        reference: prior,
        resolutionContext: context(),
      }),
    ).resolves.toEqual({
      ok: true,
      state: "credential-removed",
      configurationCommitted: false,
    });
    expect(backend.events).toContain("remove-owned");
  });
});

describe("credential removal failure boundaries", () => {
  it("never deletes a CI environment value and refuses mismatched removal authority", async () => {
    const { store } = await storeFixture();
    const reference = createCiEnvironmentCredentialReference(
      "AGENTSCOPE_KEY",
      generationId,
    );
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidate(0, reference),
      owner,
    });
    await expect(
      removeCredentialReference({
        store,
        owner,
        expectedGeneration: 0,
        ownership,
        reference: createCiEnvironmentCredentialReference(
          "OTHER_KEY",
          generationId,
        ),
        resolutionContext: context(),
        createCandidate: () => candidateWithoutCredential(1),
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "core.credential.reference-mismatch",
      configurationCommitted: false,
    });
    await expect(
      removeCredentialReference({
        store,
        owner,
        expectedGeneration: 0,
        ownership,
        reference,
        resolutionContext: context(),
        createCandidate: () => candidateWithoutCredential(1),
      }),
    ).resolves.toEqual({
      ok: true,
      state: "reference-removed",
      configurationCommitted: true,
    });
  });

  it("reports an owned orphan when backend deletion fails", async () => {
    const { store } = await storeFixture();
    const backend = storedBackend({ remove: false });
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidateWithoutCredential(0),
      owner,
    });
    const intent = await createRetirementIntent(store, reference);
    await expect(
      purgeUnreferencedCredential(backend.registry, {
        store,
        intent,
        ownership,
        reference,
        resolutionContext: context(),
      }),
    ).resolves.toEqual({
      ok: false,
      state: "owned-orphan",
      code: "core.credential.remove-failed",
      configurationCommitted: false,
    });
  });
});

describe("credential mutation crash recovery", () => {
  it("removes a deterministic dead-owner orphan and clears its intent", async () => {
    const { store } = await storeFixture();
    const backend = storedBackend({ createFailure: "unavailable" });
    await expect(
      configureCredential(backend.registry, {
        store,
        owner,
        expectedGeneration: null,
        ownership,
        request: {
          kind: "stored",
          backend: "macos-keychain",
          secret: "CANARY_SECRET",
        },
        resolutionContext: context(),
        createCandidate: (reference) => candidate(0, reference),
      }),
    ).resolves.toMatchObject({ state: "orphan-pending" });
    await expect(
      recoverCredentialMutation(backend.registry, {
        store,
        ownerState: () => "dead",
        resolutionContext: context(),
      }),
    ).resolves.toEqual({ ok: true, state: "orphan-removed" });
    expect(backend.events).toEqual(["create-pending", "remove-owned"]);
  });

  it("clears an intent whose exact credential is already referenced", async () => {
    const { store } = await storeFixture();
    const backend = storedBackend();
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidate(0, reference),
      owner,
    });
    await createCredentialMutationIntent(store, {
      recordVersion: 1,
      operation: "create",
      owner,
      ownership,
      reference,
    });
    await expect(
      recoverCredentialMutation(backend.registry, {
        store,
        ownerState: () => "dead",
        resolutionContext: context(),
      }),
    ).resolves.toEqual({ ok: true, state: "referenced-intent-cleared" });
    expect(backend.events).not.toContain("remove-owned");
  });
});

describe("credential mutation recovery failures", () => {
  it("rejects malformed, live-owner, and unremovable recovery attempts", async () => {
    const { store } = await storeFixture();
    const backend = storedBackend({
      createFailure: "unavailable",
      remove: false,
    });
    await expect(
      recoverCredentialMutation(backend.registry, null as never),
    ).rejects.toThrowError(CredentialLifecycleError);
    await configureCredential(backend.registry, {
      store,
      owner,
      expectedGeneration: null,
      ownership,
      request: {
        kind: "stored",
        backend: "macos-keychain",
        secret: "CANARY_SECRET",
      },
      resolutionContext: context(),
      createCandidate: (reference) => candidate(0, reference),
    });
    await expect(
      configureCredential(backend.registry, {
        store,
        owner,
        expectedGeneration: null,
        ownership,
        request: {
          kind: "stored",
          backend: "macos-keychain",
          secret: "CANARY_SECRET",
        },
        resolutionContext: context(),
        createCandidate: (reference) => candidate(0, reference),
      }),
    ).resolves.toMatchObject({
      state: "compensated",
      code: "core.credential.create-failed",
    });
    await expect(
      recoverCredentialMutation(backend.registry, {
        store,
        ownerState: () => "live",
        resolutionContext: context(),
      }),
    ).rejects.toBeDefined();
    await expect(
      recoverCredentialMutation(backend.registry, {
        store,
        ownerState: () => "dead",
        resolutionContext: context(),
      }),
    ).rejects.toThrowError(CredentialLifecycleError);

    const configuredState = await storeFixture();
    await writeConfigurationSnapshot(configuredState.store, {
      expectedGeneration: null,
      candidate: candidateWithoutCredential(0),
      owner,
    });
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    await createCredentialMutationIntent(configuredState.store, {
      recordVersion: 1,
      operation: "create",
      owner,
      ownership,
      reference,
    });
    await expect(
      recoverCredentialMutation(storedBackend({ remove: false }).registry, {
        store: configuredState.store,
        ownerState: () => "dead",
        resolutionContext: context(),
      }),
    ).rejects.toThrowError(CredentialLifecycleError);
  });
});

describe("credential recovery backup authority", () => {
  it("retains a credential referenced by backup when active is missing", async () => {
    const { home, store } = await storeFixture();
    const backend = storedBackend();
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidate(0, reference),
      owner,
    });
    await writeConfigurationSnapshot(store, {
      expectedGeneration: 0,
      candidate: candidateWithoutCredential(1),
      owner,
    });
    await createRetirementIntent(store, reference);
    await nodeUnlink(home.configFile);
    await expect(
      recoverCredentialMutation(backend.registry, {
        store,
        ownerState: () => "dead",
        resolutionContext: context(),
      }),
    ).rejects.toThrowError(CredentialLifecycleError);
    expect(backend.events).not.toContain("remove-owned");
  });

  it("rejects malformed backup when active is missing", async () => {
    const { home, store } = await storeFixture();
    const backend = storedBackend();
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidateWithoutCredential(0),
      owner,
    });
    await writeConfigurationSnapshot(store, {
      expectedGeneration: 0,
      candidate: candidateWithoutCredential(1),
      owner,
    });
    await createRetirementIntent(store, reference);
    await nodeUnlink(home.configFile);
    await writeFile(home.configBackupFile, "{malformed", "utf8");
    await expect(
      recoverCredentialMutation(backend.registry, {
        store,
        ownerState: () => "dead",
        resolutionContext: context(),
      }),
    ).rejects.toThrowError(CredentialLifecycleError);
    expect(backend.events).not.toContain("remove-owned");
  });

  it("removes an orphan after a reference-free backup proof", async () => {
    const { home, store } = await storeFixture();
    const backend = storedBackend();
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidateWithoutCredential(0),
      owner,
    });
    await writeConfigurationSnapshot(store, {
      expectedGeneration: 0,
      candidate: candidateWithoutCredential(1),
      owner,
    });
    await createRetirementIntent(store, reference);
    await nodeUnlink(home.configFile);
    await expect(
      recoverCredentialMutation(backend.registry, {
        store,
        ownerState: () => "dead",
        resolutionContext: context(),
      }),
    ).resolves.toEqual({ ok: true, state: "orphan-removed" });
    expect(backend.events).toContain("remove-owned");
  });
});

describe("credential backup retirement", () => {
  it("advances a reference-free backup before deleting the old credential", async () => {
    const { store } = await storeFixture();
    const backend = storedBackend();
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidate(0, reference),
      owner,
    });
    await removeCredentialReference({
      store,
      owner,
      expectedGeneration: 0,
      ownership,
      reference,
      resolutionContext: context(),
      createCandidate: () => candidateWithoutCredential(1),
    });
    await expect(
      retireCredentialReference(backend.registry, {
        store,
        owner,
        expectedGeneration: 1,
        ownership,
        reference,
        resolutionContext: context(),
        createCandidate: () => candidateWithoutCredential(2),
      }),
    ).resolves.toEqual({
      ok: true,
      state: "credential-removed",
      configurationCommitted: true,
    });
    expect(backend.events).toContain("remove-owned");
  });

  it("rejects retirement that changes anything except generation", async () => {
    const { store } = await storeFixture();
    const backend = storedBackend();
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidate(0, reference),
      owner,
    });
    await removeCredentialReference({
      store,
      owner,
      expectedGeneration: 0,
      ownership,
      reference,
      resolutionContext: context(),
      createCandidate: () => candidateWithoutCredential(1),
    });
    await expect(
      retireCredentialReference(backend.registry, {
        store,
        owner,
        expectedGeneration: 1,
        ownership,
        reference,
        resolutionContext: context(),
        createCandidate: () =>
          parseAgentscopeConfiguration(
            {
              ...candidateWithoutCredential(2).document,
              policy: { version: 1, reference: "different-policy" },
            },
            destinationRegistry,
          ),
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "core.credential.candidate-invalid",
    });
  });
});

describe("credential deletion configuration fencing", () => {
  it("blocks reference reintroduction during normal retirement", async () => {
    const { store } = await storeFixture();
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    let reintroductionCode: string | undefined;
    const backend = storedBackend({
      beforeRemoveOwned: async () => {
        try {
          await writeConfigurationSnapshot(store, {
            expectedGeneration: 2,
            candidate: candidate(3, reference),
            owner,
          });
        } catch (error) {
          reintroductionCode = (error as { code?: string }).code;
        }
      },
    });
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidate(0, reference),
      owner,
    });
    await removeCredentialReference({
      store,
      owner,
      expectedGeneration: 0,
      ownership,
      reference,
      resolutionContext: context(),
      createCandidate: () => candidateWithoutCredential(1),
    });
    await expect(
      retireCredentialReference(backend.registry, {
        store,
        owner,
        expectedGeneration: 1,
        ownership,
        reference,
        resolutionContext: context(),
        createCandidate: () => candidateWithoutCredential(2),
      }),
    ).resolves.toMatchObject({ ok: true, state: "credential-removed" });
    expect(reintroductionCode).toBe("core.configuration.contention");
    await expect(readConfigurationSnapshot(store)).resolves.toMatchObject({
      generation: 2,
    });
  });

  it("blocks reference reintroduction during dead-owner recovery", async () => {
    const { store } = await storeFixture();
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    let reintroductionCode: string | undefined;
    const backend = storedBackend({
      beforeRemoveOwned: async () => {
        try {
          await writeConfigurationSnapshot(store, {
            expectedGeneration: 2,
            candidate: candidate(3, reference),
            owner,
          });
        } catch (error) {
          reintroductionCode = (error as { code?: string }).code;
        }
      },
    });
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidate(0, reference),
      owner,
    });
    await writeConfigurationSnapshot(store, {
      expectedGeneration: 0,
      candidate: candidateWithoutCredential(1),
      owner,
    });
    await writeConfigurationSnapshot(store, {
      expectedGeneration: 1,
      candidate: candidateWithoutCredential(2),
      owner,
    });
    await createRetirementIntent(store, reference);
    await expect(
      recoverCredentialMutation(backend.registry, {
        store,
        ownerState: () => "dead",
        resolutionContext: context(),
      }),
    ).resolves.toEqual({ ok: true, state: "orphan-removed" });
    expect(reintroductionCode).toBe("core.configuration.contention");
    await expect(readConfigurationSnapshot(store)).resolves.toMatchObject({
      generation: 2,
    });
  });
});

describe("credential recovery fence transition", () => {
  it("observes the recovery claim after the fixed intent vanishes", async () => {
    const { home, store } = await storeFixture();
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidate(0, reference),
      owner,
    });
    await writeConfigurationSnapshot(store, {
      expectedGeneration: 0,
      candidate: candidateWithoutCredential(1),
      owner,
    });
    await writeConfigurationSnapshot(store, {
      expectedGeneration: 1,
      candidate: candidateWithoutCredential(2),
      owner,
    });
    await createRetirementIntent(store, reference);

    let fixedReadObserved!: () => void;
    let resumeFixedRead!: () => void;
    const fixedReadStarted = new Promise<void>((resolve) => {
      fixedReadObserved = resolve;
    });
    const fixedReadRelease = new Promise<void>((resolve) => {
      resumeFixedRead = resolve;
    });
    const writerStore = createConfigurationStoreForTesting(
      home,
      destinationRegistry,
      {
        fileSystem: {
          open: async (path, flags, mode) => {
            if (String(path).endsWith("credential.lock")) {
              fixedReadObserved();
              await fixedReadRelease;
            }
            return nodeOpen(path, flags, mode);
          },
          rename: nodeRename,
          unlink: nodeUnlink,
        },
      },
    );
    const writerOutcome = writeConfigurationSnapshot(writerStore, {
      expectedGeneration: 2,
      candidate: candidate(3, reference),
      owner,
    }).then(
      () => "committed",
      (error: unknown) => (error as { code?: string }).code,
    );
    await fixedReadStarted;

    let deletionObserved!: () => void;
    let resumeDeletion!: () => void;
    const deletionStarted = new Promise<void>((resolve) => {
      deletionObserved = resolve;
    });
    const deletionRelease = new Promise<void>((resolve) => {
      resumeDeletion = resolve;
    });
    const backend = storedBackend({
      beforeRemoveOwned: async () => {
        deletionObserved();
        await deletionRelease;
      },
    });
    const recovery = recoverCredentialMutation(backend.registry, {
      store,
      ownerState: () => "dead",
      resolutionContext: context(),
    });
    await deletionStarted;
    resumeFixedRead();
    await expect(writerOutcome).resolves.toBe("core.configuration.contention");
    resumeDeletion();
    await expect(recovery).resolves.toEqual({
      ok: true,
      state: "orphan-removed",
    });
    await expect(readConfigurationSnapshot(store)).resolves.toMatchObject({
      generation: 2,
    });
  });
});

describe("credential backup retirement failures", () => {
  it("reports missing evidence and post-commit deletion failure exactly", async () => {
    const missing = await storeFixture();
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    await expect(
      retireCredentialReference(storedBackend().registry, {
        store: missing.store,
        owner,
        expectedGeneration: 1,
        ownership,
        reference,
        resolutionContext: context(),
        createCandidate: () => candidateWithoutCredential(2),
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "core.credential.configuration-failed",
    });

    const { store } = await storeFixture();
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidate(0, reference),
      owner,
    });
    await removeCredentialReference({
      store,
      owner,
      expectedGeneration: 0,
      ownership,
      reference,
      resolutionContext: context(),
      createCandidate: () => candidateWithoutCredential(1),
    });
    await expect(
      retireCredentialReference(storedBackend({ remove: false }).registry, {
        store,
        owner,
        expectedGeneration: 1,
        ownership,
        reference,
        resolutionContext: context(),
        createCandidate: () => candidateWithoutCredential(2),
      }),
    ).resolves.toEqual({
      ok: false,
      state: "owned-orphan",
      code: "core.credential.remove-failed",
      configurationCommitted: true,
    });
    await expect(
      recoverCredentialMutation(storedBackend().registry, {
        store,
        ownerState: () => "dead",
        resolutionContext: context(),
      }),
    ).resolves.toEqual({ ok: true, state: "orphan-removed" });
  });
});

describe("credential retirement intent finalization", () => {
  it("retains a completed deletion intent when finalization is unavailable", async () => {
    const { home, store } = await storeFixture();
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidate(0, reference),
      owner,
    });
    await removeCredentialReference({
      store,
      owner,
      expectedGeneration: 0,
      ownership,
      reference,
      resolutionContext: context(),
      createCandidate: () => candidateWithoutCredential(1),
    });
    const unavailableFinalization = createConfigurationStoreForTesting(
      home,
      destinationRegistry,
      {
        fileSystem: {
          open: nodeOpen,
          rename: nodeRename,
          unlink: async (file) => {
            if (String(file).endsWith("credential.lock"))
              throw new Error("CANARY_SECRET");
            await nodeUnlink(file);
          },
        },
      },
    );
    await expect(
      retireCredentialReference(storedBackend().registry, {
        store: unavailableFinalization,
        owner,
        expectedGeneration: 1,
        ownership,
        reference,
        resolutionContext: context(),
        createCandidate: () => candidateWithoutCredential(2),
      }),
    ).resolves.toEqual({
      ok: false,
      state: "intent-pending",
      code: "core.credential.intent-finalization-failed",
      configurationCommitted: true,
    });
  });
});

describe("credential retirement crash recovery", () => {
  it("contains stale authority and a crashing retirement write", async () => {
    const { home, store } = await storeFixture();
    const backend = storedBackend();
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidate(0, reference),
      owner,
    });
    await removeCredentialReference({
      store,
      owner,
      expectedGeneration: 0,
      ownership,
      reference,
      resolutionContext: context(),
      createCandidate: () => candidateWithoutCredential(1),
    });
    await expect(
      retireCredentialReference(backend.registry, {
        store,
        owner,
        expectedGeneration: 0,
        ownership,
        reference,
        resolutionContext: context(),
        createCandidate: () => candidateWithoutCredential(2),
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "core.credential.reference-mismatch",
    });
    const crashing = createConfigurationStoreForTesting(
      home,
      destinationRegistry,
      {
        afterStep: (step) => {
          if (step === "lock-durable") throw new ConfigurationCrashSimulation();
        },
      },
    );
    await expect(
      retireCredentialReference(backend.registry, {
        store: crashing,
        owner,
        expectedGeneration: 1,
        ownership,
        reference,
        resolutionContext: context(),
        createCandidate: () => candidateWithoutCredential(2),
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "core.credential.configuration-failed",
    });
    await expect(
      recoverCredentialMutation(backend.registry, {
        store: crashing,
        ownerState: () => "dead",
        resolutionContext: context(),
      }),
    ).resolves.toEqual({ ok: true, state: "referenced-intent-cleared" });
  });
});

describe("credential retirement post-commit recovery", () => {
  it("recovers deletion after a crash following the reference-free commit", async () => {
    const { home, store } = await storeFixture();
    const backend = storedBackend();
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidate(0, reference),
      owner,
    });
    await removeCredentialReference({
      store,
      owner,
      expectedGeneration: 0,
      ownership,
      reference,
      resolutionContext: context(),
      createCandidate: () => candidateWithoutCredential(1),
    });
    const crashing = createConfigurationStoreForTesting(
      home,
      destinationRegistry,
      {
        afterStep: (step) => {
          if (step === "active-replaced")
            throw new ConfigurationCrashSimulation();
        },
      },
    );
    await expect(
      retireCredentialReference(backend.registry, {
        store: crashing,
        owner,
        expectedGeneration: 1,
        ownership,
        reference,
        resolutionContext: context(),
        createCandidate: () => candidateWithoutCredential(2),
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "core.credential.configuration-failed",
    });
    await expect(
      recoverCredentialMutation(backend.registry, {
        store: crashing,
        ownerState: () => "dead",
        resolutionContext: context(),
      }),
    ).resolves.toEqual({ ok: true, state: "orphan-removed" });
  });
});

describe("credential purge failure boundaries", () => {
  it("rejects forged and completed deletion intents", async () => {
    const { store } = await storeFixture();
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidateWithoutCredential(0),
      owner,
    });
    const input = {
      store,
      ownership,
      reference,
      resolutionContext: context(),
    };
    await expect(
      purgeUnreferencedCredential(storedBackend().registry, {
        ...input,
        intent: {} as never,
      }),
    ).rejects.toThrowError(CredentialLifecycleError);
    const intent = await createRetirementIntent(store, reference);
    await completeCredentialMutationIntent(store, intent);
    await expect(
      purgeUnreferencedCredential(storedBackend().registry, {
        ...input,
        intent,
      }),
    ).rejects.toThrowError(CredentialLifecycleError);
  });

  it("rejects malformed removal and purge records", async () => {
    const { store } = await storeFixture();
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    for (const input of [
      null,
      {},
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("CANARY_SECRET");
          },
        },
      ),
      {
        store,
        owner,
        expectedGeneration: -1,
        ownership,
        reference,
        resolutionContext: context(),
        createCandidate: () => candidateWithoutCredential(0),
      },
    ])
      await expect(
        removeCredentialReference(input as never),
      ).rejects.toThrowError(CredentialLifecycleError);
    await expect(
      purgeUnreferencedCredential(
        storedBackend().registry,
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error("CANARY_SECRET");
            },
          },
        ) as never,
      ),
    ).rejects.toThrowError(CredentialLifecycleError);
    await expect(
      purgeUnreferencedCredential(storedBackend().registry, {
        store,
        intent: {} as never,
        ownership: {} as never,
        reference,
        resolutionContext: context(),
      }),
    ).rejects.toThrowError(CredentialLifecycleError);
  });
});

describe("credential removal candidate failures", () => {
  it("rejects stale, retained, asynchronous, and throwing removal candidates", async () => {
    const { store } = await storeFixture();
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidate(0, reference),
      owner,
    });
    for (const [expectedGeneration, createCandidate, code] of [
      [
        1,
        () => candidateWithoutCredential(1),
        "core.credential.reference-mismatch",
      ],
      [0, () => candidate(1, reference), "core.credential.candidate-invalid"],
      [
        0,
        () => candidateWithoutCredential(2),
        "core.credential.configuration-failed",
      ],
      [
        0,
        () => Promise.resolve(candidateWithoutCredential(1)),
        "core.credential.candidate-invalid",
      ],
      [
        0,
        () => Promise.reject(new Error("CANARY_SECRET")),
        "core.credential.candidate-invalid",
      ],
      [
        0,
        () => {
          throw new Error("CANARY_SECRET");
        },
        "core.credential.candidate-invalid",
      ],
    ] as const)
      await expect(
        removeCredentialReference({
          store,
          owner,
          expectedGeneration,
          ownership,
          reference,
          resolutionContext: context(),
          createCandidate: createCandidate as never,
        }),
      ).resolves.toMatchObject({ ok: false, code });
  });

  it("refuses deletion when backup authority is malformed or input is hostile", async () => {
    const { home, store } = await storeFixture();
    const backend = storedBackend();
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidateWithoutCredential(0),
      owner,
    });
    await writeConfigurationSnapshot(store, {
      expectedGeneration: 0,
      candidate: candidateWithoutCredential(1),
      owner,
    });
    await writeFile(home.configBackupFile, "{malformed", "utf8");
    const intent = await createRetirementIntent(store, reference);
    await expect(
      purgeUnreferencedCredential(backend.registry, {
        store,
        intent,
        ownership,
        reference,
        resolutionContext: context(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "core.credential.configuration-failed",
    });
    expect(backend.events).not.toContain("remove-owned");
    const hostile = Object.defineProperty(
      { store, ownership, reference },
      "resolutionContext",
      { enumerable: true, get: () => context() },
    );
    await expect(
      purgeUnreferencedCredential(backend.registry, hostile as never),
    ).rejects.toThrowError(CredentialLifecycleError);
  });
});

describe("credential purge terminal outcomes", () => {
  it("maps missing configuration and throwing deletion to fixed outcomes", async () => {
    const { store } = await storeFixture();
    const reference = createStoredCredentialReference(
      "macos-keychain",
      referenceId,
      generationId,
    );
    await expect(
      removeCredentialReference({
        store,
        owner,
        expectedGeneration: 0,
        ownership,
        reference,
        resolutionContext: context(),
        createCandidate: () => candidateWithoutCredential(1),
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "core.credential.configuration-failed",
    });
    await expect(
      purgeUnreferencedCredential(storedBackend().registry, {
        store,
        intent: await createRetirementIntent(store, reference),
        ownership,
        reference,
        resolutionContext: context(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "core.credential.configuration-failed",
    });
    const second = await storeFixture();
    await writeConfigurationSnapshot(second.store, {
      expectedGeneration: null,
      candidate: candidateWithoutCredential(0),
      owner,
    });
    const intent = await createRetirementIntent(second.store, reference);
    await expect(
      purgeUnreferencedCredential(
        storedBackend({ removeThrows: true }).registry,
        {
          store: second.store,
          intent,
          ownership,
          reference,
          resolutionContext: context(),
        },
      ),
    ).resolves.toEqual({
      ok: false,
      state: "owned-orphan",
      code: "core.credential.remove-failed",
      configurationCommitted: false,
    });
  });

  it("removes only an unreferenced CI reference, never its environment value", async () => {
    const { store } = await storeFixture();
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidateWithoutCredential(0),
      owner,
    });
    await expect(
      purgeUnreferencedCredential(
        compileCredentialBackendRegistry([
          createCiEnvironmentCredentialAdapter({ AGENTSCOPE_KEY: "secret" }),
        ]),
        {
          store,
          ownership,
          reference: createCiEnvironmentCredentialReference(
            "AGENTSCOPE_KEY",
            generationId,
          ),
          resolutionContext: context(),
        },
      ),
    ).resolves.toEqual({
      ok: true,
      state: "reference-removed",
      configurationCommitted: false,
    });
  });
});
