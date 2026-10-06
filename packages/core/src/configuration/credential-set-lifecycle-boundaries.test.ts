import { mkdtemp, open, rename, rm, unlink, writeFile } from "node:fs/promises";
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
  createCiEnvironmentCredentialAdapter,
  createCredentialOwnership,
  createCredentialResolutionContext,
  defineStoredCredentialBackendAdapter,
  deriveStoredCredentialReference,
  type StoredCredentialBackendImplementation,
} from "./credential-adapter.js";
import {
  configureCredentialSetForCore,
  type ConfigureCredentialSetInput,
} from "./credential-set-lifecycle.js";
import {
  configureCredential,
  recoverCredentialMutation,
} from "./credential-lifecycle.js";
import { createAgentscopeHomeResolver } from "./home.js";
import {
  parseAgentscopeConfiguration,
  type ConfigurationCredentialReference,
} from "./schema.js";
import {
  createConfigurationProcessIdentity,
  ConfigurationCrashSimulation,
  createConfigurationStoreForTesting,
  createCredentialMutationIntent,
  inspectCredentialMutation,
  readConfigurationSnapshot,
  writeConfigurationSnapshot,
} from "./transaction.js";

const destinationType = "@agentscope/destination-example";
const connectionId = `destination-connection-v1-${"a".repeat(64)}`;
const owner = createConfigurationProcessIdentity(
  74,
  `process-start-v1-${"c".repeat(64)}`,
);
const schema = z.strictObject({});
void schema.shape;
z.toJSONSchema(schema);
const destinations = compileDestinationRegistry([
  defineDestinationDescriptor({
    descriptorVersion: 1,
    destinationType,
    commandName: "example",
    settingsVersion: 1,
    settingsSchema: schema,
    defaultSettings: {},
    credentialSlots: [{ id: "api-key", required: true }],
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
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const snapshot = (
  refs: Readonly<Record<string, ConfigurationCredentialReference>>,
  generation = 0,
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
                  settings: {},
                  credentialReferences: refs,
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
    destinations,
  );

const faultFileSystem = (
  mode: string,
  home: ReturnType<ReturnType<typeof createAgentscopeHomeResolver>>,
  controller: AbortController,
) => ({
  open: (
    path: Parameters<typeof open>[0],
    flags: Parameters<typeof open>[1],
    permissions?: Parameters<typeof open>[2],
  ) => {
    if (
      String(path) === home.configBackupFile &&
      mode === "abort-before-remove"
    )
      controller.abort();
    if (String(path) === home.configBackupFile && mode === "lost-recovery")
      return unlink(
        join(home.mutationDirectory, "credential.recovery.lock"),
      ).then(() => open(path, flags, permissions));
    return open(path, flags, permissions);
  },
  rename,
  unlink: (path: Parameters<typeof unlink>[0]) => {
    if (String(path).endsWith("credential.lock") && mode === "abort-activation")
      controller.abort();
    if (String(path).endsWith("credential.lock") && mode === "finalize-error")
      return Promise.reject(new Error("fixed-fault"));
    return unlink(path);
  },
});

const fixture = async (mode = "normal") => {
  const root = await mkdtemp(join(tmpdir(), "agentscope-set-boundary-"));
  roots.push(root);
  const home = createAgentscopeHomeResolver({
    environment: { AGENTSCOPE_HOME: join(root, "home") },
    environmentOverrideAuthority: "test",
    platform: process.platform,
  })();
  const events: string[] = [],
    values = new Map<string, string>();
  const controller = new AbortController();
  const store = createConfigurationStoreForTesting(home, destinations, {
    afterStep: (step) => {
      if (mode === "unresolved-write" && step === "candidate-durable")
        throw new ConfigurationCrashSimulation();
    },
    fileSystem: faultFileSystem(mode, home, controller),
  });
  const implementation: StoredCredentialBackendImplementation = {
    createPending: (input) => {
      events.push("create");
      const reference = deriveStoredCredentialReference(
        "macos-keychain",
        input.ownership,
        input.generationId,
      );
      values.set(reference.referenceId, input.secret);
      if (mode === "abort-stage" || mode === "abort-preflight")
        controller.abort();
      const result: unknown =
        mode === "bad-create"
          ? { ok: false }
          : mode === "wrong-create"
            ? { ok: true, referenceId: "wrong" }
            : {
                ok: mode !== "false-create",
                referenceId: reference.referenceId,
              };
      return Promise.resolve(
        result as Awaited<
          ReturnType<StoredCredentialBackendImplementation["createPending"]>
        >,
      );
    },
    resolve: (input) => {
      events.push("resolve");
      if (mode === "abort-resolve") controller.abort();
      if (mode === "lost-intent")
        return unlink(join(home.mutationDirectory, "credential.lock")).then(
          () => ({ ok: true as const, secret: "wrong" }),
        );
      return Promise.resolve({
        ok: true,
        secret:
          mode === "wrong-secret"
            ? "not-the-secret"
            : input.reference.backend === "ci-environment"
              ? ""
              : (values.get(input.reference.referenceId) ?? ""),
      });
    },
    activate: () => {
      events.push("activate");
      if (mode === "late-activate") controller.abort();
      return mode === "activate-throw"
        ? Promise.reject(new Error("private-provider-body"))
        : Promise.resolve(true);
    },
    removePending: (input) => {
      events.push("remove-pending");
      if (mode === "remove-throw")
        return Promise.reject(new Error("private-provider-body"));
      if (input.reference.backend !== "ci-environment")
        values.delete(input.reference.referenceId);
      return Promise.resolve(true);
    },
    removeOwned: () => {
      events.push("remove-owned");
      if (mode === "abort-recovery") controller.abort();
      return Promise.resolve(true);
    },
  };
  const registry = compileCredentialBackendRegistry([
    defineStoredCredentialBackendAdapter("macos-keychain", implementation),
  ]);
  const ownership = createCredentialOwnership({
    destinationType,
    connectionId,
    slot: "api-key",
  });
  const input: ConfigureCredentialSetInput = {
    store,
    owner,
    expectedGeneration: null,
    backend: "macos-keychain",
    requests: [{ ownership, secret: "private-canary" }],
    resolutionContext: createCredentialResolutionContext(
      "hook-equivalent",
      controller.signal,
    ),
    createCandidate: (references) => snapshot(references),
  };
  return { root, home, store, registry, input, events, values, controller };
};

describe("credential set operation failures retain exact ownership", () => {
  it.each(["bad-create", "wrong-create", "false-create"])(
    "retains predicted references after %s",
    async (mode) => {
      const value = await fixture(mode);
      expect(
        await configureCredentialSetForCore(value.registry, value.input),
      ).toMatchObject({
        state: "orphan-pending",
        code: "core.credential.create-failed",
      });
      expect(value.values.size).toBe(1);
      expect(value.events).toEqual(["create"]);
    },
  );
  it.each(["wrong-secret", "lost-intent"])(
    "handles %s without deleting without authority",
    async (mode) => {
      const value = await fixture(mode);
      expect(
        await configureCredentialSetForCore(value.registry, value.input),
      ).toMatchObject({
        state: mode === "lost-intent" ? "orphan-pending" : "compensated",
        code:
          mode === "lost-intent"
            ? "core.credential.compensation-failed"
            : "core.credential.preflight-malformed",
      });
      expect(value.values.size).toBe(mode === "lost-intent" ? 1 : 0);
    },
  );
  it("preserves failed compensation and postcommit finalization as distinct states", async () => {
    const pending = await fixture("remove-throw");
    expect(
      await configureCredentialSetForCore(pending.registry, {
        ...pending.input,
        createCandidate: () => {
          throw new Error();
        },
      }),
    ).toMatchObject({
      state: "orphan-pending",
      code: "core.credential.compensation-failed",
    });
    const committed = await fixture("finalize-error");
    expect(
      await configureCredentialSetForCore(committed.registry, committed.input),
    ).toMatchObject({
      state: "referenced-pending",
      code: "core.credential.intent-finalization-failed",
      configurationCommitted: true,
    });
    expect(
      (await readConfigurationSnapshot(committed.store)).connections,
    ).toHaveLength(1);
    expect(committed.events).not.toContain("activate");
    const unfinished = await fixture("finalize-error");
    expect(
      await configureCredentialSetForCore(unfinished.registry, {
        ...unfinished.input,
        createCandidate: () => {
          throw new Error();
        },
      }),
    ).toMatchObject({
      state: "orphan-pending",
      code: "core.credential.intent-finalization-failed",
    });
  });
  it.each(["activate-throw", "abort-activation", "late-activate"])(
    "returns referenced-pending after %s without deleting",
    async (mode) => {
      const value = await fixture(mode);
      expect(
        await configureCredentialSetForCore(value.registry, value.input),
      ).toMatchObject({
        state: "referenced-pending",
        code:
          mode === "abort-activation"
            ? "core.credential.intent-finalization-failed"
            : "core.credential.activation-failed",
      });
      expect(value.values.size).toBe(1);
      if (mode === "abort-activation")
        expect(value.events).not.toContain("activate");
    },
  );
});

describe("credential set candidate and CAS failure", () => {
  it("compensates a definite stale-generation refusal without deleting referenced values", async () => {
    const value = await fixture();
    await writeConfigurationSnapshot(value.store, {
      expectedGeneration: null,
      candidate: snapshot({}, 0, false),
      owner,
    });
    expect(
      await configureCredentialSetForCore(value.registry, value.input),
    ).toMatchObject({
      state: "compensated",
      code: "core.credential.configuration-failed",
    });
    expect(value.values.size).toBe(0);
  });
  it.each([
    () => Promise.resolve({}),
    () => Promise.reject(new Error("private-canary")),
  ])(
    "observes asynchronous candidate %# without a write or unhandled rejection",
    async (candidate) => {
      const value = await fixture();
      expect(
        await configureCredentialSetForCore(value.registry, {
          ...value.input,
          createCandidate:
            candidate as unknown as ConfigureCredentialSetInput["createCandidate"],
        }),
      ).toMatchObject({
        state: "compensated",
        code: "core.credential.candidate-invalid",
      });
      expect(value.values.size).toBe(0);
    },
  );
  it("retains pending values without compensation when cancellation arrives before CAS", async () => {
    const value = await fixture();
    expect(
      await configureCredentialSetForCore(value.registry, {
        ...value.input,
        createCandidate: (refs) => {
          value.controller.abort();
          return snapshot(refs);
        },
      }),
    ).toMatchObject({
      state: "orphan-pending",
      code: "core.credential.compensation-failed",
    });
    expect(value.events).toEqual(["create", "resolve"]);
    expect(value.values.size).toBe(1);
    await expect(readConfigurationSnapshot(value.store)).rejects.toThrow();
  });
});

describe("credential set recovery proves absence before deletion", () => {
  it("refuses unresolved transaction and malformed active evidence", async () => {
    for (const name of ["config.lock", "config.json"]) {
      const value = await fixture(
        name === "config.lock" ? "unresolved-write" : "bad-create",
      );
      await configureCredentialSetForCore(value.registry, value.input);
      if (name === "config.json")
        await writeFile(value.home.configFile, "malformed", { mode: 0o600 });
      await expect(
        recoverCredentialMutation(value.registry, {
          store: value.store,
          ownerState: () => "dead",
          resolutionContext: value.input.resolutionContext,
        }),
      ).rejects.toThrow();
      expect(value.events).not.toContain("remove-owned");
      expect(
        await inspectCredentialMutation(value.store, () => "dead"),
      ).toEqual({ state: "reconciliation-required" });
    }
  });
});

describe("version-1 CI configuration compatibility", () => {
  it("compensates a failed CI CAS without minting a stored intent", async () => {
    const value = await fixture();
    const environment = { KEY: "private-canary" };
    const result = await configureCredential(
      compileCredentialBackendRegistry([
        createCiEnvironmentCredentialAdapter(environment),
      ]),
      {
        store: value.store,
        owner,
        expectedGeneration: 1,
        ownership: value.input.requests[0]!.ownership,
        request: { kind: "ci-environment", environmentVariable: "KEY" },
        resolutionContext: value.input.resolutionContext,
        createCandidate: (reference) => snapshot({ "api-key": reference }),
      },
    );
    expect(result).toMatchObject({
      state: "compensated",
      code: "core.credential.configuration-failed",
    });
    expect(environment.KEY).toBe("private-canary");
    expect(await inspectCredentialMutation(value.store, () => "dead")).toEqual({
      state: "clean",
    });
  });
});

describe("credential set cancellation preserves phase boundaries", () => {
  it.each(["abort-stage", "abort-preflight", "abort-resolve"])(
    "admits no later backend phase after %s",
    async (mode) => {
      const value = await fixture(mode);
      const requests = [...value.input.requests];
      if (mode === "abort-stage")
        requests.push({
          ownership: createCredentialOwnership({
            ...value.input.requests[0]!.ownership,
            slot: "secret-key",
          }),
          secret: "other-private-value",
        });
      expect(
        await configureCredentialSetForCore(value.registry, {
          ...value.input,
          requests,
        }),
      ).toMatchObject({
        state: "orphan-pending",
      });
      expect(value.events).toEqual(
        mode === "abort-resolve" ? ["create", "resolve"] : ["create"],
      );
      expect(value.values.size).toBe(1);
    },
  );
  it.each(["abort-recovery", "abort-before-remove", "lost-recovery"])(
    "never completes recovery after %s",
    async (mode) => {
      const value = await fixture(mode);
      const ownership = value.input.requests[0]?.ownership;
      if (!ownership) throw new Error();
      await createCredentialMutationIntent(value.store, {
        recordVersion: 2,
        operation: "create",
        owner,
        entries: [
          {
            ownership,
            reference: deriveStoredCredentialReference(
              "macos-keychain",
              ownership,
              `credential-generation-v1-${"d".repeat(64)}`,
            ),
          },
        ],
      });
      await expect(
        recoverCredentialMutation(value.registry, {
          store: value.store,
          ownerState: () => "dead",
          resolutionContext: value.input.resolutionContext,
        }),
      ).rejects.toThrow();
      expect(
        value.events.filter((event) => event === "remove-owned"),
      ).toHaveLength(mode === "abort-recovery" ? 1 : 0);
    },
  );
});
