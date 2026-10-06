import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  compileDestinationRegistry,
  createDestinationReporter,
  createReporterReceipt,
  defineDestinationDescriptor,
} from "@agentscope/destinations-core";
import {
  compileCredentialBackendRegistry,
  createCredentialResolutionContext,
  defineStoredCredentialBackendAdapter,
  deriveStoredCredentialReference,
  type StoredCredentialBackendImplementation,
} from "./credential-adapter.js";
import { createAgentscopeHomeFromOwnedRootForCore } from "./home.js";
import {
  configureStoredDestinationConnection,
  createConfigurationManagementRuntime,
  initializeAgentscopeConfiguration,
  unconfigureManagedDestinationConnection,
} from "./management.js";
import {
  createConfigurationProcessIdentity,
  createConfigurationStore,
  createConfigurationStoreForTesting,
  readConfigurationBackupSnapshot,
  readConfigurationSnapshot,
} from "./transaction.js";

const settingsSchema = z.strictObject({ project: z.string() });
void settingsSchema.shape;
z.toJSONSchema(settingsSchema);
const registry = compileDestinationRegistry([
  defineDestinationDescriptor({
    commandName: "example",
    descriptorVersion: 1,
    destinationType: "@agentscope/destination-example",
    settingsVersion: 1,
    settingsSchema,
    defaultSettings: { project: "default" },
    credentialSlots: [
      { id: "public-key", required: true },
      { id: "secret-key", required: true },
    ],
    documentationPath: "/docs/destinations/example",
    deliveryIdentitySupport: "duplicates-possible",
    transport: { kind: "local" },
    createReporter: () =>
      createDestinationReporter({
        report: () => Promise.resolve(createReporterReceipt("accepted")),
      }),
  }),
]);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const fixture = async (onStep?: (step: string) => void) => {
  const root = await mkdtemp(
    join(tmpdir(), "agentscope-credential-management-"),
  );
  roots.push(root);
  const home = createAgentscopeHomeFromOwnedRootForCore(root, process.platform);
  const store = onStep
    ? createConfigurationStoreForTesting(home, registry, { afterStep: onStep })
    : createConfigurationStore(home, registry);
  const owner = createConfigurationProcessIdentity(
    process.pid,
    `process-start-v1-${"a".repeat(64)}`,
  );
  const events: string[] = [];
  const values = new Map<string, string>();
  const implementation: StoredCredentialBackendImplementation = {
    createPending: (input) => {
      events.push(`create:${input.ownership.slot}`);
      const reference = deriveStoredCredentialReference(
        "macos-keychain",
        input.ownership,
        input.generationId,
      );
      values.set(reference.referenceId, input.secret);
      return Promise.resolve({ ok: true, referenceId: reference.referenceId });
    },
    resolve: ({ reference }) =>
      Promise.resolve(
        reference.backend !== "ci-environment" &&
          values.has(reference.referenceId)
          ? { ok: true, secret: values.get(reference.referenceId)! }
          : { ok: false, code: "missing" },
      ),
    activate: () => {
      events.push("activate");
      return Promise.resolve(true);
    },
    removePending: ({ reference }) => {
      events.push("remove-pending");
      if (reference.backend !== "ci-environment")
        values.delete(reference.referenceId);
      return Promise.resolve(true);
    },
    removeOwned: ({ reference }) => {
      events.push("remove-owned");
      if (reference.backend !== "ci-environment")
        values.delete(reference.referenceId);
      return Promise.resolve(true);
    },
  };
  const backends = compileCredentialBackendRegistry([
    defineStoredCredentialBackendAdapter("macos-keychain", implementation),
  ]);
  const runtime = createConfigurationManagementRuntime(
    registry,
    store,
    owner,
    undefined,
    backends,
  );
  await initializeAgentscopeConfiguration(runtime);
  const abort = new AbortController();
  const context = createCredentialResolutionContext(
    "hook-equivalent",
    abort.signal,
    performance.now() + 60_000,
  );
  const input = {
    commandName: "example",
    name: "primary",
    settings: { project: "default" },
    backend: "macos-keychain" as const,
    resolutionContext: context,
    readSecret: (slot: string, received: typeof context) => {
      expect(received).toBe(context);
      events.push(`input:${slot}`);
      return Promise.resolve(`private-${slot}`);
    },
  };
  return { runtime, store, owner, events, values, input, abort, context };
};

describe("management complete-set composition", () => {
  it("collects every input before creating and returns no secrets or references", async () => {
    const value = await fixture();
    const result = await configureStoredDestinationConnection(
      value.runtime,
      value.input,
    );
    expect(result).toEqual({
      ok: true,
      generation: 1,
      name: "primary",
      state: "active",
      connection: {
        connectionId: expect.stringMatching(
          /^destination-connection-v1-[a-f0-9]{64}$/u,
        ) as unknown,
        destinationType: "@agentscope/destination-example",
        name: "primary",
        routed: false,
        settingsVersion: 1,
        transport: "local",
      },
    });
    expect(value.events.slice(0, 4)).toEqual([
      "input:public-key",
      "input:secret-key",
      "create:public-key",
      "create:secret-key",
    ]);
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(
      (await readConfigurationSnapshot(value.store)).connections,
    ).toHaveLength(1);
  });
  it.each(["throw", "abort", "malformed"])(
    "starts no native operation after %s input",
    async (mode) => {
      const value = await fixture();
      let calls = 0;
      const input = {
        ...value.input,
        readSecret: () => {
          if (++calls === 2) {
            if (mode === "throw") throw new Error("secret-canary");
            if (mode === "abort") value.abort.abort();
            if (mode === "malformed") return Promise.resolve("\0");
          }
          return Promise.resolve("private-value");
        },
      };
      await expect(
        configureStoredDestinationConnection(value.runtime, input),
      ).rejects.toThrow("core.configuration.invalid");
      expect(value.events).toEqual([]);
      expect(value.values.size).toBe(0);
      expect((await readConfigurationSnapshot(value.store)).generation).toBe(0);
    },
  );
  it("retains stored values and the old generation in backup by default", async () => {
    const value = await fixture();
    await configureStoredDestinationConnection(value.runtime, value.input);
    const result = await unconfigureManagedDestinationConnection(
      value.runtime,
      {
        name: "primary",
        retireCredentials: false,
        resolutionContext: value.context,
      },
    );
    expect(result).toEqual({
      ok: true,
      generation: 2,
      name: "primary",
      state: "credentials-retained",
    });
    expect(value.values.size).toBe(2);
    expect(
      (await readConfigurationBackupSnapshot(value.store)).connections,
    ).toHaveLength(1);
    expect(value.events).not.toContain("remove-owned");
    expect((await readConfigurationSnapshot(value.store)).connections).toEqual(
      [],
    );
  });
  it("explicitly retires all slots only after the two configuration generations", async () => {
    const value = await fixture();
    await configureStoredDestinationConnection(value.runtime, value.input);
    expect(
      await unconfigureManagedDestinationConnection(value.runtime, {
        name: "primary",
        retireCredentials: true,
        resolutionContext: value.context,
      }),
    ).toEqual({ ok: true, generation: 3, name: "primary", state: "retired" });
    expect(value.values.size).toBe(0);
    expect(
      value.events.filter((event) => event === "remove-owned"),
    ).toHaveLength(2);
  });
  it("rejects proxy input without evaluating traps", async () => {
    const value = await fixture();
    let effects = 0;
    const input = new Proxy(value.input, {
      ownKeys: () => {
        effects += 1;
        throw new Error();
      },
    });
    await expect(
      configureStoredDestinationConnection(value.runtime, input),
    ).rejects.toThrow();
    expect(effects).toBe(0);
    expect(value.events).toEqual([]);
  });
});

describe("management original cutoff and hostile boundary", () => {
  it("denies all input/native work when the supplied original context is expired", async () => {
    const value = await fixture();
    const expired = createCredentialResolutionContext(
      "hook-equivalent",
      value.abort.signal,
      performance.now(),
    );
    await expect(
      configureStoredDestinationConnection(value.runtime, {
        ...value.input,
        resolutionContext: expired,
      }),
    ).rejects.toThrow("core.configuration.invalid");
    expect(value.events).toEqual([]);
  });
  it("does not reset the original expiry after the last input callback", async () => {
    const value = await fixture();
    let reads = 0;
    await expect(
      configureStoredDestinationConnection(value.runtime, {
        ...value.input,
        readSecret: () => {
          if (++reads === 2)
            vi.spyOn(performance, "now").mockReturnValue(
              value.context.expiresAtMonotonicMilliseconds!,
            );
          return Promise.resolve("private-value");
        },
      }),
    ).rejects.toThrow("core.configuration.invalid");
    expect(reads).toBe(2);
    expect(value.events).toEqual([]);
    expect(value.values.size).toBe(0);
  });
  it("reports observed late configuration-only commitment without later native cleanup", async () => {
    let late = false;
    let expires = 0;
    const value = await fixture((step) => {
      if (late && step === "active-replaced")
        vi.spyOn(performance, "now").mockReturnValue(expires);
    });
    await configureStoredDestinationConnection(value.runtime, value.input);
    expires = value.context.expiresAtMonotonicMilliseconds!;
    late = true;
    expect(
      await unconfigureManagedDestinationConnection(value.runtime, {
        name: "primary",
        retireCredentials: false,
        resolutionContext: value.context,
      }),
    ).toEqual({
      ok: false,
      code: "core.credential.configuration-failed",
      state: "configuration-committed",
      configurationCommitted: true,
    });
    expect((await readConfigurationSnapshot(value.store)).generation).toBe(2);
    expect(value.values.size).toBe(2);
    expect(value.events).not.toContain("remove-owned");
  });
  it.each(["accessor", "extra", "registry-clone"])(
    "refuses %s before callbacks",
    async (mode) => {
      const value = await fixture();
      let effects = 0;
      const input = { ...value.input };
      if (mode === "accessor")
        Object.defineProperty(input, "readSecret", {
          get: () => {
            effects += 1;
            throw new Error();
          },
        });
      if (mode === "extra")
        Object.assign(input, {
          createCandidate: () => {
            effects += 1;
          },
        });
      const runtime =
        mode === "registry-clone"
          ? Object.freeze({ ...value.runtime })
          : value.runtime;
      await expect(
        configureStoredDestinationConnection(runtime, input),
      ).rejects.toThrow();
      expect(effects).toBe(0);
      expect(value.events).toEqual([]);
    },
  );
  it("rejects a duplicate name before asking for new secrets", async () => {
    const value = await fixture();
    await configureStoredDestinationConnection(value.runtime, value.input);
    value.events.length = 0;
    await expect(
      configureStoredDestinationConnection(value.runtime, value.input),
    ).rejects.toThrow("core.configuration.invalid");
    expect(value.events).toEqual([]);
  });
});
