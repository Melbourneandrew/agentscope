import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
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
  compileCredentialBackendRegistry,
  createCredentialOwnership,
  createCredentialResolutionContext,
  defineStoredCredentialBackendAdapter,
  deriveStoredCredentialReference,
  type StoredCredentialBackendImplementation,
} from "./credential-adapter.js";
import { recoverCredentialMutation } from "./credential-lifecycle.js";
import { configureCredentialSetForCore } from "./credential-set-lifecycle.js";
import { createAgentscopeHomeResolver } from "./home.js";
import {
  parseAgentscopeConfiguration,
  type ConfigurationCredentialReference,
} from "./schema.js";
import {
  ConfigurationCrashSimulation,
  createConfigurationProcessIdentity,
  createConfigurationStore,
  createConfigurationStoreForTesting,
  createCredentialMutationIntent,
  inspectCredentialMutation,
  readConfigurationSnapshot,
  recoverAbandonedConfigurationTransaction,
  writeConfigurationSnapshot,
} from "./transaction.js";

const connectionId = `destination-connection-v1-${"a".repeat(64)}`;
const destinationType = "@agentscope/destination-example";
const settingsSchema = z.strictObject({ project: z.string() });
void settingsSchema.shape;
z.toJSONSchema(settingsSchema);
const destinationRegistry = compileDestinationRegistry([
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
const owner = createConfigurationProcessIdentity(
  72,
  `process-start-v1-${"e".repeat(64)}`,
);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const context = () =>
  createCredentialResolutionContext(
    "hook-equivalent",
    new AbortController().signal,
  );
const requests = () =>
  ["public-key", "secret-key"].map((slot) => ({
    ownership: createCredentialOwnership({
      destinationType,
      connectionId,
      slot,
    }),
    secret: `private-${slot}`,
  }));
const candidate = (
  generation: number,
  references: Readonly<Record<string, ConfigurationCredentialReference>>,
  include = true,
) =>
  parseAgentscopeConfiguration(
    {
      configurationVersion: 2,
      generation,
      destinations: {
        [destinationType]: {
          namespaceVersion: 1,
          settingsVersion: 1,
          connections: include
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
        selectedConnectionIds: include ? [connectionId] : [],
        hookDeadlineMilliseconds: 2_000,
      },
      policy: { version: 1, reference: "policy-v1" },
    },
    destinationRegistry,
  );

const fixture = async (fault?: string) => {
  const root = await mkdtemp(join(tmpdir(), "agentscope-credential-set-"));
  roots.push(root);
  const home = createAgentscopeHomeResolver({
    environment: { AGENTSCOPE_HOME: join(root, "home") },
    environmentOverrideAuthority: "test",
    platform: process.platform,
  })();
  const store = fault
    ? createConfigurationStoreForTesting(home, destinationRegistry, {
        afterStep: (step) => {
          if (step === fault) throw new ConfigurationCrashSimulation();
        },
      })
    : createConfigurationStore(home, destinationRegistry);
  const events: string[] = [];
  const values = new Map<string, string>();
  let failCreate = false,
    failResolve = false,
    failRemove = false,
    failActivate = false;
  const implementation: StoredCredentialBackendImplementation = {
    createPending: async (input) => {
      events.push(`create:${input.ownership.slot}`);
      expect(await readdir(home.mutationDirectory)).toContain(
        "credential.lock",
      );
      const reference = deriveStoredCredentialReference(
        "macos-keychain",
        input.ownership,
        input.generationId,
      );
      values.set(reference.referenceId, input.secret);
      if (failCreate && input.ownership.slot === "secret-key")
        throw new Error("private-provider-body");
      return { ok: true, referenceId: reference.referenceId };
    },
    resolve: (input) => {
      events.push("resolve");
      if (failResolve)
        return Promise.resolve({ ok: false as const, code: "locked" as const });
      return Promise.resolve(
        input.reference.backend !== "ci-environment" &&
          values.has(input.reference.referenceId)
          ? { ok: true, secret: values.get(input.reference.referenceId) ?? "" }
          : { ok: false as const, code: "missing" as const },
      );
    },
    activate: async () => {
      events.push("activate");
      expect((await readConfigurationSnapshot(store)).connections).toHaveLength(
        1,
      );
      return !failActivate;
    },
    removePending: (input) => {
      events.push("remove-pending");
      if (failRemove) return Promise.resolve(false);
      if (input.reference.backend !== "ci-environment")
        values.delete(input.reference.referenceId);
      return Promise.resolve(true);
    },
    removeOwned: (input) => {
      events.push("remove-owned");
      if (failRemove) return Promise.resolve(false);
      if (input.reference.backend !== "ci-environment")
        values.delete(input.reference.referenceId);
      return Promise.resolve(true);
    },
  };
  const registry = compileCredentialBackendRegistry([
    defineStoredCredentialBackendAdapter("macos-keychain", implementation),
  ]);
  return {
    store,
    home,
    registry,
    events,
    values,
    input: () => ({
      store,
      owner,
      expectedGeneration: null,
      backend: "macos-keychain" as const,
      requests: requests(),
      resolutionContext: context(),
      createCandidate: (
        references: Readonly<Record<string, ConfigurationCredentialReference>>,
      ) => candidate(0, references),
    }),
    fail: (kind: "create" | "resolve" | "remove" | "activate") => {
      if (kind === "create") failCreate = true;
      if (kind === "resolve") failResolve = true;
      if (kind === "remove") failRemove = true;
      if (kind === "activate") failActivate = true;
    },
  };
};

describe("complete stored credential creation", () => {
  it("creates and round-trips all slots before one complete commit and activation", async () => {
    const value = await fixture();
    const input = value.input();
    const result = await configureCredentialSetForCore(value.registry, {
      ...input,
      requests: [...input.requests].reverse(),
    });
    expect(result.ok).toBe(true);
    expect(value.events).toEqual([
      "create:public-key",
      "create:secret-key",
      "resolve",
      "resolve",
      "activate",
      "activate",
    ]);
    expect((await readConfigurationSnapshot(value.store)).generation).toBe(0);
    expect(await inspectCredentialMutation(value.store, () => "dead")).toEqual({
      state: "clean",
    });
    expect(JSON.stringify(result)).not.toContain("private-public-key");
  });

  it("retains every prederived generation when a create may have committed", async () => {
    const value = await fixture();
    value.fail("create");
    const result = await configureCredentialSetForCore(
      value.registry,
      value.input(),
    );
    expect(result).toMatchObject({
      ok: false,
      state: "orphan-pending",
      code: "core.credential.create-failed",
    });
    expect(value.values.size).toBe(2);
    const bytes = await readFile(
      join(value.home.mutationDirectory, "credential.lock"),
      "utf8",
    );
    expect(bytes).not.toContain("private-");
    expect(JSON.parse(bytes)).toMatchObject({
      recordVersion: 2,
      operation: "create",
    });
    expect(
      await recoverCredentialMutation(value.registry, {
        store: value.store,
        ownerState: () => "dead",
        resolutionContext: context(),
      }),
    ).toEqual({ ok: true, state: "orphan-removed" });
    expect(value.values.size).toBe(0);
  });

  it("compensates the complete pending set on preflight refusal", async () => {
    const value = await fixture();
    value.fail("resolve");
    expect(
      await configureCredentialSetForCore(value.registry, value.input()),
    ).toMatchObject({
      ok: false,
      state: "compensated",
      code: "core.credential.preflight-locked",
    });
    expect(value.values.size).toBe(0);
    expect(
      value.events.filter((event) => event === "remove-pending"),
    ).toHaveLength(2);
  });
});

describe("complete stored credential compensation and recovery", () => {
  it("retains the intent when compensation cannot prove complete removal", async () => {
    const value = await fixture();
    value.fail("resolve");
    value.fail("remove");
    expect(
      await configureCredentialSetForCore(value.registry, value.input()),
    ).toMatchObject({
      state: "orphan-pending",
      code: "core.credential.compensation-failed",
    });
    expect(await readdir(value.home.mutationDirectory)).toContain(
      "credential.lock",
    );
  });

  it("refuses a partial candidate without a configuration commit", async () => {
    const value = await fixture();
    expect(
      await configureCredentialSetForCore(value.registry, {
        ...value.input(),
        createCandidate: (references) =>
          candidate(0, {
            "public-key": references[
              "public-key"
            ] as ConfigurationCredentialReference,
          }),
      }),
    ).toMatchObject({
      state: "compensated",
      code: "core.credential.candidate-invalid",
    });
    expect(value.values.size).toBe(0);
  });

  it("never deletes durable references after activation refusal", async () => {
    const value = await fixture();
    value.fail("activate");
    expect(
      await configureCredentialSetForCore(value.registry, value.input()),
    ).toMatchObject({
      state: "referenced-pending",
      configurationCommitted: true,
    });
    expect(value.values.size).toBe(2);
  });

  it.each(["candidate-durable", "backup-durable", "active-replaced"])(
    "retains the set at uncertain configuration prefix %s",
    async (prefix) => {
      const value = await fixture(prefix);
      expect(
        await configureCredentialSetForCore(value.registry, value.input()),
      ).toMatchObject({
        state:
          prefix === "active-replaced"
            ? "referenced-pending"
            : "orphan-pending",
      });
      expect(value.values.size).toBe(2);
      expect(value.events).not.toContain("remove-pending");
      await recoverAbandonedConfigurationTransaction(value.store, () => "dead");
      const result = await recoverCredentialMutation(value.registry, {
        store: value.store,
        ownerState: () => "dead",
        resolutionContext: context(),
      });
      expect(result.state).toBe(
        prefix === "active-replaced"
          ? "referenced-intent-cleared"
          : "orphan-removed",
      );
    },
  );
});

describe("complete stored credential recovery refuses ambiguous authority", () => {
  it("retains the claim when owned deletion refuses", async () => {
    const value = await fixture();
    value.fail("create");
    value.fail("remove");
    await configureCredentialSetForCore(value.registry, value.input());
    await expect(
      recoverCredentialMutation(value.registry, {
        store: value.store,
        ownerState: () => "dead",
        resolutionContext: context(),
      }),
    ).rejects.toThrow();
    expect(value.values.size).toBe(2);
    expect(await inspectCredentialMutation(value.store, () => "dead")).toEqual({
      state: "reconciliation-required",
    });
  });

  it("rejects cloned intent authority at the original CAS fence", async () => {
    const value = await fixture();
    const entries = requests().map((request) => ({
      ownership: request.ownership,
      reference: deriveStoredCredentialReference(
        "macos-keychain",
        request.ownership,
        `credential-generation-v1-${"d".repeat(64)}`,
      ),
    }));
    const intent = await createCredentialMutationIntent(value.store, {
      recordVersion: 2,
      operation: "create",
      owner,
      entries,
    });
    await expect(
      writeConfigurationSnapshot(value.store, {
        expectedGeneration: null,
        candidate: candidate(
          0,
          Object.fromEntries(
            entries.map((entry) => [entry.ownership.slot, entry.reference]),
          ),
        ),
        owner,
        credentialMutationIntent: { ...intent },
      }),
    ).rejects.toThrow();
    expect(value.events).toEqual([]);
  });
});

describe("complete stored credential ownership evidence", () => {
  it("preserves backup-only references during recovery", async () => {
    const value = await fixture();
    const entries = requests().map((request) => ({
      ownership: request.ownership,
      reference: deriveStoredCredentialReference(
        "macos-keychain",
        request.ownership,
        `credential-generation-v1-${"d".repeat(64)}`,
      ),
    }));
    const intent = await createCredentialMutationIntent(value.store, {
      recordVersion: 2,
      operation: "create",
      owner,
      entries,
    });
    const references = Object.fromEntries(
      entries.map((entry) => [entry.ownership.slot, entry.reference]),
    );
    await writeConfigurationSnapshot(value.store, {
      expectedGeneration: null,
      candidate: candidate(0, references),
      owner,
      credentialMutationIntent: intent,
    });
    await writeConfigurationSnapshot(value.store, {
      expectedGeneration: 0,
      candidate: candidate(1, {}, false),
      owner,
      credentialMutationIntent: intent,
    });
    await expect(
      recoverCredentialMutation(value.registry, {
        store: value.store,
        ownerState: () => "dead",
        resolutionContext: context(),
      }),
    ).rejects.toThrow();
    expect(value.events).not.toContain("remove-owned");
    expect(await inspectCredentialMutation(value.store, () => "dead")).toEqual({
      state: "reconciliation-required",
    });
  });

  it.each(["live", "unknown"] as const)(
    "never cleans a %s owner",
    async (state) => {
      const value = await fixture();
      value.fail("create");
      await configureCredentialSetForCore(value.registry, value.input());
      await expect(
        recoverCredentialMutation(value.registry, {
          store: value.store,
          ownerState: () => state,
          resolutionContext: context(),
        }),
      ).rejects.toThrow();
      expect(value.values.size).toBe(2);
    },
  );

  it("rejects duplicate slots and an interactive-only context before credential creation", async () => {
    const value = await fixture();
    const input = value.input();
    await expect(
      configureCredentialSetForCore(value.registry, {
        ...input,
        requests: [
          input.requests[0] as (typeof input.requests)[number],
          input.requests[0] as (typeof input.requests)[number],
        ],
      }),
    ).rejects.toThrow();
    await expect(
      configureCredentialSetForCore(value.registry, {
        ...input,
        resolutionContext: createCredentialResolutionContext(
          "interactive",
          new AbortController().signal,
        ),
      }),
    ).rejects.toThrow();
    expect(value.events).toEqual([]);
  });
});
