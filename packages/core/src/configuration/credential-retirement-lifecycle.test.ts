import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  link,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  compileDestinationRegistry,
  createDestinationReporter,
  createReporterReceipt,
  defineDestinationDescriptor,
} from "@agentscope/destinations-core";
import {
  compileCredentialBackendRegistry,
  createCredentialOwnership,
  createCredentialResolutionContext,
  defineStoredCredentialBackendAdapter,
  deriveStoredCredentialReference,
} from "./credential-adapter.js";
import { createAgentscopeHomeResolver } from "./home.js";
import {
  parseAgentscopeConfiguration,
  serializeAgentscopeConfiguration,
} from "./schema.js";
import {
  ConfigurationCrashSimulation,
  createConfigurationProcessIdentity,
  createConfigurationStoreForTesting,
  createCredentialMutationIntent,
  inspectCredentialMutation,
  readConfigurationSnapshot,
  readConfigurationBackupSnapshot,
  readRecoverableCredentialMutationIntent,
  recoverAbandonedConfigurationTransaction,
  writeConfigurationSnapshot,
} from "./transaction.js";
import {
  retirementEntries,
  retirementIdentity,
} from "./credential-retirement-evidence.js";
import {
  retireCredentialConnectionForCore,
  reconcileCredentialRetirementForCore,
} from "./credential-retirement-lifecycle.js";

const destinationType = "@agentscope/destination-example";
const connectionId = `destination-connection-v1-${"a".repeat(64)}`;
const owner = createConfigurationProcessIdentity(
  72,
  `process-start-v1-${"b".repeat(64)}`,
);
const reconciler = createConfigurationProcessIdentity(
  73,
  `process-start-v1-${"c".repeat(64)}`,
);
const settingsSchema = z.strictObject({ project: z.string() });
void settingsSchema.shape;
z.toJSONSchema(settingsSchema);
const destinations = compileDestinationRegistry([
  defineDestinationDescriptor({
    descriptorVersion: 1,
    destinationType,
    commandName: "example",
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
const references = Object.fromEntries(
  ["public-key", "secret-key"].map((slot, index) => [
    slot,
    deriveStoredCredentialReference(
      "macos-keychain",
      createCredentialOwnership({ destinationType, connectionId, slot }),
      `credential-generation-v1-${String(index + 1).repeat(64)}`,
    ),
  ]),
);
const snapshot = (generation: number, included: boolean) =>
  parseAgentscopeConfiguration(
    {
      configurationVersion: 2,
      generation,
      destinations: {
        [destinationType]: {
          namespaceVersion: 1,
          settingsVersion: 1,
          connections: included
            ? [
                {
                  connectionId,
                  name: "primary",
                  settings: { project: "example" },
                  credentialReferences: references,
                },
              ]
            : [],
        },
      },
      routing: {
        version: 1,
        selectedConnectionIds: included ? [connectionId] : [],
        hookDeadlineMilliseconds: 2_000,
      },
      policy: { version: 1, reference: "policy-v1" },
    },
    destinations,
  );
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "agentscope-retirement-"));
  roots.push(root);
  const home = createAgentscopeHomeResolver({
    environment: { AGENTSCOPE_HOME: join(root, "home") },
    environmentOverrideAuthority: "test",
    platform: process.platform,
  })();
  let commits = 0;
  let crash: { commit: number; step: string } | undefined;
  let enabled = false;
  let onStep: ((step: string) => void) | undefined;
  const store = createConfigurationStoreForTesting(home, destinations, {
    afterStep: (step) => {
      if (!enabled) return;
      onStep?.(step);
      if (step === "lock-durable") commits += 1;
      if (crash?.commit === commits && crash.step === step) {
        crash = undefined;
        throw new ConfigurationCrashSimulation();
      }
    },
  });
  const preimage = snapshot(0, true);
  const removal = snapshot(1, false);
  const final = snapshot(2, false);
  await writeConfigurationSnapshot(store, {
    expectedGeneration: null,
    candidate: preimage,
    owner,
  });
  enabled = true;
  const controller = new AbortController();
  const resolutionContext = createCredentialResolutionContext(
    "hook-equivalent",
    controller.signal,
  );
  const deletes: string[] = [];
  let failAt = 0;
  let onRemove: (() => unknown) | undefined;
  const unexpected = (): Promise<never> =>
    Promise.reject(new Error("unexpected"));
  const registry = compileCredentialBackendRegistry([
    defineStoredCredentialBackendAdapter("macos-keychain", {
      createPending: unexpected,
      resolve: unexpected,
      activate: unexpected,
      removePending: unexpected,
      removeOwned: ({ ownership }) => {
        deletes.push(ownership.slot);
        const result = onRemove?.();
        return Promise.resolve(
          (result === undefined
            ? deletes.length !== failAt
            : result) as boolean,
        );
      },
    }),
  ]);
  const input = {
    store,
    owner,
    connectionId,
    resolutionContext,
    preimage,
    removal,
    final,
  };
  const reconcile = (
    ownerState: () => "dead" | "live" | "unknown" = () => "dead",
  ) =>
    reconcileCredentialRetirementForCore(registry, {
      store,
      owner: reconciler,
      ownerState,
      resolutionContext,
    });
  const intent = () =>
    createCredentialMutationIntent(store, {
      recordVersion: 3,
      operation: "retire",
      owner,
      entries: retirementEntries(preimage, connectionId),
      preimage: retirementIdentity(preimage),
      removal: retirementIdentity(removal),
      final: retirementIdentity(final),
    });
  return {
    root,
    home,
    store,
    input,
    registry,
    deletes,
    reconcile,
    intent,
    controller,
    crash: (commit: number, step: string) => {
      crash = { commit, step };
    },
    fail: (index: number) => {
      failAt = index;
    },
    onRemove: (callback: () => unknown) => {
      onRemove = callback;
    },
    onStep: (callback: (step: string) => void) => {
      onStep = callback;
    },
  };
};

const fenceFiles = (directory: string, name = "credential.lock") =>
  expect(readdir(directory)).resolves.toEqual([name]);

describe("complete credential retirement", () => {
  it("performs two whole-connection commits before exact all-owned deletion", async () => {
    const value = await fixture();
    await retireCredentialConnectionForCore(value.registry, value.input);
    expect(value.deletes).toEqual(["public-key", "secret-key"]);
    expect(
      serializeAgentscopeConfiguration(
        await readConfigurationSnapshot(value.store),
      ),
    ).toBe(serializeAgentscopeConfiguration(value.input.final));
    expect(
      serializeAgentscopeConfiguration(
        await readConfigurationBackupSnapshot(value.store),
      ),
    ).toBe(serializeAgentscopeConfiguration(value.input.removal));
    expect(await readdir(value.home.mutationDirectory)).toEqual([]);
  });
  it("clears exact preimage without deletion", async () => {
    const value = await fixture();
    await value.intent();
    await value.reconcile();
    expect(value.deletes).toEqual([]);
    expect(await readdir(value.home.mutationDirectory)).toEqual([]);
  });
  it("retains claim after partial deletion and resumes claim-only idempotently", async () => {
    const value = await fixture();
    value.fail(2);
    await expect(
      retireCredentialConnectionForCore(value.registry, value.input),
    ).rejects.toThrow();
    value.fail(3);
    await expect(value.reconcile()).rejects.toThrow();
    await fenceFiles(value.home.mutationDirectory, "credential.recovery.lock");
    expect(await inspectCredentialMutation(value.store, () => "dead")).toEqual({
      state: "reconciliation-required",
    });
    await expect(
      readRecoverableCredentialMutationIntent(value.store, () => "dead"),
    ).rejects.toThrow();
    value.fail(0);
    await value.reconcile();
    expect(value.deletes).toEqual([
      "public-key",
      "secret-key",
      "public-key",
      "public-key",
      "secret-key",
    ]);
    expect(await readdir(value.home.mutationDirectory)).toEqual([]);
  });
});

describe("retirement interruption and refusal", () => {
  it.each([
    "lock-durable",
    "candidate-durable",
    "backup-durable",
    "active-reverified",
    "active-replaced",
  ])(
    "resumes second-CAS crash at %s only after transaction repair",
    async (step) => {
      const value = await fixture();
      value.crash(2, step);
      await expect(
        retireCredentialConnectionForCore(value.registry, value.input),
      ).rejects.toThrow();
      expect(value.deletes).toEqual([]);
      await expect(value.reconcile()).rejects.toThrow();
      expect(value.deletes).toEqual([]);
      await recoverAbandonedConfigurationTransaction(value.store, () => "dead");
      await value.reconcile();
      expect(value.deletes).toEqual(["public-key", "secret-key"]);
    },
  );
  it.each(["live", "unknown"] as const)(
    "retains exact intent for %s owner",
    async (state) => {
      const value = await fixture();
      await value.intent();
      await expect(value.reconcile(() => state)).rejects.toThrow();
      expect(value.deletes).toEqual([]);
      await fenceFiles(value.home.mutationDirectory);
    },
  );
  it("rejects noncanonical partial removal without intent publication", async () => {
    const value = await fixture();
    await expect(
      retireCredentialConnectionForCore(value.registry, {
        ...value.input,
        removal: snapshot(1, true),
      }),
    ).rejects.toThrow();
    expect(value.deletes).toEqual([]);
    expect(await readdir(value.home.mutationDirectory)).toEqual([]);
  });
  it("rejects substituted fixed+claim inode without unlinking either", async () => {
    const value = await fixture();
    await value.intent();
    const fixed = join(value.home.mutationDirectory, "credential.lock");
    const claim = join(
      value.home.mutationDirectory,
      "credential.recovery.lock",
    );
    await writeFile(claim, await readFile(fixed), { mode: 0o600 });
    await expect(value.reconcile()).rejects.toThrow();
    expect((await readdir(value.home.mutationDirectory)).sort()).toEqual([
      "credential.lock",
      "credential.recovery.lock",
    ]);
    expect(value.deletes).toEqual([]);
  });
  it("resumes authentic fixed+claim interruption", async () => {
    const value = await fixture();
    await value.intent();
    await link(
      join(value.home.mutationDirectory, "credential.lock"),
      join(value.home.mutationDirectory, "credential.recovery.lock"),
    );
    await value.reconcile();
    expect(await readdir(value.home.mutationDirectory)).toEqual([]);
    expect(value.deletes).toEqual([]);
  });
  it("aborted reconciliation performs no filesystem mutation", async () => {
    const value = await fixture();
    await value.intent();
    value.controller.abort();
    await expect(value.reconcile()).rejects.toThrow();
    expect(value.deletes).toEqual([]);
    await fenceFiles(value.home.mutationDirectory);
  });
  it("missing backup after committed retirement never authorizes deletion", async () => {
    const value = await fixture();
    value.fail(1);
    await expect(
      retireCredentialConnectionForCore(value.registry, value.input),
    ).rejects.toThrow();
    await unlink(value.home.configBackupFile);
    value.deletes.splice(0);
    await expect(value.reconcile()).rejects.toThrow();
    expect(value.deletes).toEqual([]);
    await fenceFiles(value.home.mutationDirectory, "credential.recovery.lock");
  });
});

describe("retirement first commit and final proof", () => {
  it.each([
    "lock-durable",
    "candidate-durable",
    "backup-durable",
    "active-reverified",
    "active-replaced",
  ])("retains discoverable first-CAS prefix %s", async (step) => {
    const value = await fixture();
    value.crash(1, step);
    await expect(
      retireCredentialConnectionForCore(value.registry, value.input),
    ).rejects.toThrow();
    expect(value.deletes).toEqual([]);
    await recoverAbandonedConfigurationTransaction(value.store, () => "dead");
    await value.reconcile();
    expect(value.deletes).toEqual(
      step === "active-replaced" ? ["public-key", "secret-key"] : [],
    );
    expect(await readdir(value.home.mutationDirectory)).toEqual([]);
  });
  it("rechecks the active digest immediately before replacement", async () => {
    const value = await fixture();
    value.onStep((step) => {
      if (step === "active-reverified")
        writeFileSync(
          value.home.configFile,
          serializeAgentscopeConfiguration(snapshot(3, false)),
          { mode: 0o600 },
        );
    });
    await expect(
      retireCredentialConnectionForCore(value.registry, value.input),
    ).rejects.toThrow();
    expect((await readConfigurationSnapshot(value.store)).generation).toBe(3);
    expect(value.deletes).toEqual([]);
    await fenceFiles(value.home.mutationDirectory);
  });
  it("does not continue deletion after cancellation", async () => {
    const value = await fixture();
    value.onRemove(() => {
      value.controller.abort();
    });
    await expect(
      retireCredentialConnectionForCore(value.registry, value.input),
    ).rejects.toThrow("core.credential.lifecycle-invalid");
    expect(value.deletes).toEqual(["public-key"]);
    await fenceFiles(value.home.mutationDirectory);
  });
  it.each(["exception", "non-boolean"])(
    "refuses backend %s without clearing authority",
    async (failure) => {
      const value = await fixture();
      value.onRemove(() => {
        if (failure === "exception")
          throw new Error("synthetic-private-canary");
        return "truthy";
      });
      await expect(
        retireCredentialConnectionForCore(value.registry, value.input),
      ).rejects.toThrow("core.credential.lifecycle-invalid");
      expect(value.deletes).toEqual(["public-key"]);
      await fenceFiles(value.home.mutationDirectory);
    },
  );
  it("repeats dead-owner proof before each owned deletion", async () => {
    const value = await fixture();
    value.fail(1);
    await expect(
      retireCredentialConnectionForCore(value.registry, value.input),
    ).rejects.toThrow();
    value.deletes.splice(0);
    value.fail(0);
    await expect(
      value.reconcile(() => (value.deletes.length === 0 ? "dead" : "unknown")),
    ).rejects.toThrow();
    expect(value.deletes).toEqual(["public-key"]);
    await fenceFiles(value.home.mutationDirectory, "credential.recovery.lock");
  });
  it("rejects accessor and proxy requests without executing caller hooks", async () => {
    const value = await fixture();
    let effects = 0;
    const accessor = { ...value.input };
    Object.defineProperty(accessor, "connectionId", {
      get: () => {
        effects += 1;
        return connectionId;
      },
    });
    const proxy = new Proxy(value.input, {
      ownKeys: () => {
        effects += 1;
        return [];
      },
    });
    await expect(
      retireCredentialConnectionForCore(value.registry, accessor),
    ).rejects.toThrow();
    await expect(
      retireCredentialConnectionForCore(value.registry, proxy),
    ).rejects.toThrow();
    expect(effects).toBe(0);
    expect(value.deletes).toEqual([]);
    expect(await readdir(value.home.mutationDirectory)).toEqual([]);
  });
});
