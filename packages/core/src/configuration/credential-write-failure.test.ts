import { readFileSync, writeFileSync } from "node:fs";
import {
  mkdtemp,
  open as nodeOpen,
  rename as nodeRename,
  rm,
  unlink as nodeUnlink,
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
  compileCredentialBackendRegistry,
  createCiEnvironmentCredentialReference,
  createCredentialOwnership,
  createCredentialResolutionContext,
  defineStoredCredentialBackendAdapter,
  deriveStoredCredentialReference,
  type StoredCredentialBackendImplementation,
} from "./credential-adapter.js";
import {
  configureCredential,
  recoverCredentialMutation,
} from "./credential-lifecycle.js";
import { credentialWriteFailureEvidence } from "./credential-reference-evidence.js";
import { createAgentscopeHomeResolver } from "./home.js";
import {
  parseAgentscopeConfiguration,
  type ConfigurationCredentialReference,
} from "./schema.js";
import {
  ConfigurationCrashSimulation,
  ConfigurationStoreError,
  createConfigurationProcessIdentity,
  createConfigurationStore,
  createConfigurationStoreForTesting,
  readConfigurationSnapshot,
  recoverAbandonedConfigurationTransaction,
  writeConfigurationSnapshot,
} from "./transaction.js";

const connectionId =
  "destination-connection-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
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
      configurationVersion: 2,
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
      routing: {
        version: 1,
        selectedConnectionIds: [connectionId],
        hookDeadlineMilliseconds: 2_000,
      },
      policy: { version: 1, reference: "policy-v1" },
    },
    destinationRegistry,
  );

const candidateWithoutCredential = (generation: number) =>
  parseAgentscopeConfiguration(
    {
      configurationVersion: 2,
      generation,
      destinations: {},
      routing: {
        version: 1,
        selectedConnectionIds: [],
        hookDeadlineMilliseconds: 2_000,
      },
      policy: { version: 1, reference: "policy-v1" },
    },
    destinationRegistry,
  );

const storedBackend = () => {
  const events: string[] = [];
  let secret = "CANARY_SECRET";
  const implementation: StoredCredentialBackendImplementation = {
    createPending: (input) => {
      events.push("create-pending");
      secret = input.secret;
      return Promise.resolve({
        ok: true as const,
        referenceId: deriveStoredCredentialReference(
          "macos-keychain",
          input.ownership,
          input.generationId,
        ).referenceId,
      });
    },
    resolve: () => {
      events.push("resolve");
      return Promise.resolve({ ok: true as const, secret });
    },
    activate: () => {
      events.push("activate");
      return Promise.resolve(true);
    },
    removePending: () => {
      events.push("remove-pending");
      return Promise.resolve(true);
    },
    removeOwned: () => {
      events.push("remove-owned");
      return Promise.resolve(true);
    },
  };
  return {
    events,
    registry: compileCredentialBackendRegistry([
      defineStoredCredentialBackendAdapter("macos-keychain", implementation),
    ]),
  };
};

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

describe("credential configuration write uncertainty", () => {
  it("retains the stored generation across an active-replaced crash", async () => {
    const { home } = await storeFixture();
    const store = createConfigurationStoreForTesting(
      home,
      destinationRegistry,
      {
        afterStep: (step) => {
          if (step === "active-replaced")
            throw new ConfigurationCrashSimulation();
        },
      },
    );
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
          secret: "CANARY_SECRET",
        },
        resolutionContext: context(),
        createCandidate: (reference) => candidate(0, reference),
      }),
    ).resolves.toMatchObject({
      ok: false,
      state: "referenced-pending",
      code: "core.credential.configuration-failed",
      configurationCommitted: true,
    });
    expect(backend.events).not.toContain("remove-pending");
    await expect(readConfigurationSnapshot(store)).resolves.toMatchObject({
      generation: 0,
    });
    await expect(
      recoverAbandonedConfigurationTransaction(store, () => "dead"),
    ).resolves.toMatchObject({ committed: true });
    await expect(
      recoverCredentialMutation(backend.registry, {
        store,
        ownerState: () => "dead",
        resolutionContext: context(),
      }),
    ).resolves.toEqual({ ok: true, state: "referenced-intent-cleared" });
  });

  it.each([
    "core.configuration.conflict",
    "core.configuration.invalid",
  ] as const)("does not compensate a post-commit %s error", async (code) => {
    const { home } = await storeFixture();
    const store = createConfigurationStoreForTesting(
      home,
      destinationRegistry,
      {
        afterStep: (step) => {
          if (step === "active-replaced")
            throw new ConfigurationStoreError(code);
        },
      },
    );
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
          secret: "CANARY_SECRET",
        },
        resolutionContext: context(),
        createCandidate: (reference) => candidate(0, reference),
      }),
    ).resolves.toMatchObject({
      ok: false,
      state: "referenced-pending",
      code: "core.credential.configuration-failed",
      configurationCommitted: true,
    });
    expect(backend.events).not.toContain("remove-pending");
    await expect(
      recoverCredentialMutation(backend.registry, {
        store,
        ownerState: () => "dead",
        resolutionContext: context(),
      }),
    ).resolves.toEqual({ ok: true, state: "referenced-intent-cleared" });
  });
});

describe("credential configuration cleanup lock faults", () => {
  it.each(["conflict", "invalid"] as const)(
    "preserves a committed reference after lock %s",
    async (failure) => {
      const { home } = await storeFixture();
      const lock = join(home.mutationDirectory, "config.lock");
      const store = createConfigurationStoreForTesting(
        home,
        destinationRegistry,
        {
          afterStep: (step) => {
            if (step !== "active-replaced") return;
            if (failure === "invalid") {
              writeFileSync(lock, "invalid\n");
              return;
            }
            const record = JSON.parse(readFileSync(lock, "utf8")) as Record<
              string,
              unknown
            >;
            writeFileSync(
              lock,
              `${JSON.stringify({ ...record, transactionId: `configuration-transaction-v1-${"f".repeat(64)}` })}\n`,
            );
          },
        },
      );
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
            secret: "CANARY_SECRET",
          },
          resolutionContext: context(),
          createCandidate: (reference) => candidate(0, reference),
        }),
      ).resolves.toMatchObject({
        ok: false,
        state: "referenced-pending",
        code: "core.credential.configuration-failed",
        configurationCommitted: true,
      });
      expect(backend.events).not.toContain("remove-pending");
      await expect(readConfigurationSnapshot(store)).resolves.toMatchObject({
        generation: 0,
      });
    },
  );
});

describe("credential configuration definite precommit failure", () => {
  it("compensates a proven generation conflict", async () => {
    const { store } = await storeFixture();
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: candidate(
        0,
        createCiEnvironmentCredentialReference("EXISTING_KEY", generationId),
      ),
      owner,
    });
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
          secret: "CANARY_SECRET",
        },
        resolutionContext: context(),
        createCandidate: (reference) => candidate(0, reference),
      }),
    ).resolves.toMatchObject({
      ok: false,
      state: "compensated",
      code: "core.credential.configuration-failed",
      configurationCommitted: false,
    });
    expect(backend.events).toContain("remove-pending");
  });
});

describe("uncertain credential write evidence", () => {
  it.each(["unreadable-active", "unresolved-transaction"] as const)(
    "retains the generation without compensation for %s",
    async (failure) => {
      const { home } = await storeFixture();
      const store = createConfigurationStoreForTesting(
        home,
        destinationRegistry,
        {
          afterStep: (step) => {
            if (failure === "unreadable-active" && step === "active-replaced") {
              writeFileSync(home.configFile, "invalid\n");
              throw new ConfigurationCrashSimulation();
            }
            if (
              failure === "unresolved-transaction" &&
              step === "candidate-durable"
            )
              throw new ConfigurationCrashSimulation();
          },
        },
      );
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
            secret: "CANARY_SECRET",
          },
          resolutionContext: context(),
          createCandidate: (reference) => candidate(0, reference),
        }),
      ).resolves.toMatchObject({
        ok: false,
        state: "orphan-pending",
        code: "core.credential.configuration-failed",
        configurationCommitted: false,
      });
      expect(backend.events).toEqual(["create-pending", "resolve"]);
      expect(
        readFileSync(join(home.mutationDirectory, "credential.lock"), "utf8"),
      ).not.toContain("CANARY_SECRET");
    },
  );
  it("requires absence from the last-known-good backup as well as active", async () => {
    const { store } = await storeFixture();
    const reference = deriveStoredCredentialReference(
      "macos-keychain",
      ownership,
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
    await expect(
      credentialWriteFailureEvidence(store, reference),
    ).resolves.toBe("uncertain");
    await writeConfigurationSnapshot(store, {
      expectedGeneration: 1,
      candidate: candidateWithoutCredential(2),
      owner,
    });
    await expect(
      credentialWriteFailureEvidence(store, reference),
    ).resolves.toBe("unreferenced");
  });
});
