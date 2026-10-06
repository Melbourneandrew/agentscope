import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
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
  createCiEnvironmentCredentialReference,
  createCredentialOwnership,
  createCredentialResolutionContext,
  defineStoredCredentialBackendAdapter,
  deriveStoredCredentialReference,
  type StoredCredentialBackendImplementation,
} from "./credential-adapter.js";
import { invokeCredentialMutationForCore } from "./credential-resolution-context.js";
import { configureCredentialSetForCore } from "./credential-set-lifecycle.js";
import {
  configureCredential,
  removeCredentialReference,
} from "./credential-lifecycle.js";
import { retireCredentialConnectionForCore } from "./credential-retirement-lifecycle.js";
import { createAgentscopeHomeResolver } from "./home.js";
import {
  parseAgentscopeConfiguration,
  type ConfigurationCredentialReference,
} from "./schema.js";
import {
  createConfigurationProcessIdentity,
  createConfigurationStoreForTesting,
  inspectCredentialMutation,
  readConfigurationSnapshot,
  writeConfigurationSnapshot,
} from "./transaction.js";

const destinationType = "@agentscope/destination-example";
const connectionId = `destination-connection-v1-${"a".repeat(64)}`;
const owner = createConfigurationProcessIdentity(
  72,
  `process-start-v1-${"b".repeat(64)}`,
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
const ownership = (slot = "public-key") =>
  createCredentialOwnership({ destinationType, connectionId, slot });
const candidate = (
  generation: number,
  references: Readonly<Record<string, ConfigurationCredentialReference>>,
  included = true,
) =>
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
        hookDeadlineMilliseconds: 2000,
      },
      policy: { version: 1, reference: "policy-v1" },
    },
    destinations,
  );
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const fixture = async () => {
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const root = await mkdtemp(join(tmpdir(), "agentscope-mutation-deadline-"));
  roots.push(root);
  const home = createAgentscopeHomeResolver({
    environment: { AGENTSCOPE_HOME: join(root, "home") },
    environmentOverrideAuthority: "test",
    platform: process.platform,
  })();
  let onStep: ((step: string) => void) | undefined;
  const store = createConfigurationStoreForTesting(home, destinations, {
    afterStep: (step) => onStep?.(step),
  });
  const controller = new AbortController();
  const context = createCredentialResolutionContext(
    "hook-equivalent",
    controller.signal,
    200,
  );
  const calls: string[] = [];
  const boundaries: unknown[] = [];
  const values = new Map<string, string>();
  let afterMutation: ((kind: string) => void) | undefined;
  let resolveFails = false;
  const mutation = (kind: string, boundary: unknown) => {
    calls.push(kind);
    boundaries.push(boundary);
    afterMutation?.(kind);
  };
  const implementation: StoredCredentialBackendImplementation = {
    createPending: (input) => {
      const reference = deriveStoredCredentialReference(
        "macos-keychain",
        input.ownership,
        input.generationId,
      );
      values.set(reference.referenceId, input.secret);
      mutation("create", input);
      return Promise.resolve({ ok: true, referenceId: reference.referenceId });
    },
    resolve: (input) =>
      Promise.resolve(
        resolveFails
          ? { ok: false, code: "locked" }
          : {
              ok: true,
              secret:
                input.reference.backend === "ci-environment"
                  ? ""
                  : (values.get(input.reference.referenceId) ?? ""),
            },
      ),
    activate: (input) => {
      mutation("activate", input);
      return Promise.resolve(true);
    },
    removePending: (input) => {
      mutation("compensate", input);
      return Promise.resolve(true);
    },
    removeOwned: (input) => {
      mutation("remove", input);
      return Promise.resolve(true);
    },
  };
  const registry = compileCredentialBackendRegistry([
    defineStoredCredentialBackendAdapter("macos-keychain", implementation),
  ]);
  return {
    store,
    home,
    context,
    controller,
    registry,
    calls,
    boundaries,
    expire: () => {
      now = 200;
    },
    onMutation: (callback: (kind: string) => void) => {
      afterMutation = callback;
    },
    onStep: (callback: (step: string) => void) => {
      onStep = callback;
    },
    failResolution: () => {
      resolveFails = true;
    },
    configure: () =>
      configureCredentialSetForCore(registry, {
        store,
        owner,
        expectedGeneration: null,
        backend: "macos-keychain",
        requests: ["public-key", "secret-key"].map((slot) => ({
          ownership: ownership(slot),
          secret: `private-${slot}`,
        })),
        resolutionContext: context,
        createCandidate: (references) => candidate(0, references),
      }),
  };
};

describe("the same mutation context guards entry and observed settlement", () => {
  it.each(["cloned", "proxy", "expired", "aborted"])(
    "refuses %s context before invoking any mutation",
    async (kind) => {
      const value = await fixture();
      let context = value.context;
      if (kind === "cloned") context = { ...context };
      if (kind === "proxy") context = new Proxy(context, {});
      if (kind === "expired") value.expire();
      if (kind === "aborted") value.controller.abort();
      const invoke = vi.fn(() => Promise.resolve(true));
      await expect(
        invokeCredentialMutationForCore(context, invoke),
      ).rejects.toMatchObject({ code: "core.credential.invalid" });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it.each(["expired", "aborted"])(
    "passes a frozen original boundary and rejects %s fulfillment",
    async (kind) => {
      const value = await fixture();
      await expect(
        invokeCredentialMutationForCore(value.context, (boundary) => {
          expect(boundary).toEqual({
            signal: value.controller.signal,
            expiresAtMonotonicMilliseconds: 200,
          });
          expect(Object.isFrozen(boundary)).toBe(true);
          if (kind === "expired") value.expire();
          else value.controller.abort();
          return Promise.resolve(true);
        }),
      ).rejects.toMatchObject({ code: "core.credential.invalid" });
    },
  );

  it("observes a rejected operation without inventing success or replacing its error", async () => {
    const value = await fixture();
    const primary = new Error("synthetic-provider-failure");
    await expect(
      invokeCredentialMutationForCore(value.context, () => {
        value.expire();
        return Promise.reject(primary);
      }),
    ).rejects.toBe(primary);
  });

  it("preserves the old signal-only context without inventing an expiry", async () => {
    const context = createCredentialResolutionContext(
      "hook-equivalent",
      new AbortController().signal,
    );
    await expect(
      invokeCredentialMutationForCore(context, (boundary) => {
        expect(Object.keys(boundary)).toEqual(["signal"]);
        return Promise.resolve(true);
      }),
    ).resolves.toBe(true);
  });
});

describe("multi-slot mutation cutoffs preserve intent and referenced state", () => {
  it.each(["create", "activate", "compensate"])(
    "preserves v1 pending state after late %s without a later native call",
    async (kind) => {
      const value = await fixture();
      if (kind === "compensate") value.failResolution();
      value.onMutation((entered) => {
        if (entered === kind) value.expire();
      });
      const result = await configureCredential(value.registry, {
        store: value.store,
        owner,
        expectedGeneration: null,
        ownership: ownership(),
        request: {
          kind: "stored",
          backend: "macos-keychain",
          secret: "private-public-key",
        },
        resolutionContext: value.context,
        createCandidate: (reference) =>
          candidate(0, {
            "public-key": reference,
            "secret-key": createCiEnvironmentCredentialReference(
              "AGENTSCOPE_TEST_CREDENTIAL",
              `credential-generation-v1-${"d".repeat(64)}`,
            ),
          }),
      });
      expect(result).toMatchObject({
        ok: false,
        state: kind === "activate" ? "referenced-pending" : "orphan-pending",
        configurationCommitted: kind === "activate",
      });
      expect(value.calls.filter((entered) => entered === kind)).toHaveLength(1);
      expect(value.calls).not.toContain("remove");
      if (kind !== "activate")
        expect(await readdir(value.home.mutationDirectory)).toContain(
          "credential.lock",
        );
    },
  );

  it("rejects expired entry before an intent or native call exists", async () => {
    const value = await fixture();
    value.expire();
    await expect(value.configure()).rejects.toMatchObject({
      code: "core.credential.lifecycle-invalid",
    });
    expect(value.calls).toEqual([]);
    expect(
      await inspectCredentialMutation(value.store, () => "unknown"),
    ).toMatchObject({ state: "clean" });
  });

  it.each(["create", "activate", "compensate"])(
    "does not start a later slot after a late %s settlement",
    async (kind) => {
      const value = await fixture();
      if (kind === "compensate") value.failResolution();
      value.onMutation((entered) => {
        if (entered === kind) value.expire();
      });
      const result = await value.configure();
      expect(result).toMatchObject({
        ok: false,
        state: kind === "activate" ? "referenced-pending" : "orphan-pending",
        configurationCommitted: kind === "activate",
      });
      expect(value.calls.filter((entered) => entered === kind)).toHaveLength(1);
      if (kind !== "activate")
        expect(await readdir(value.home.mutationDirectory)).toContain(
          "credential.lock",
        );
      if (kind === "activate")
        expect(
          (await readConfigurationSnapshot(value.store)).connections,
        ).toHaveLength(1);
    },
  );

  it("forwards the original boundary unchanged through every timely slot mutation", async () => {
    const value = await fixture();
    expect(await value.configure()).toMatchObject({
      ok: true,
      state: "active",
    });
    expect(value.calls).toEqual(["create", "create", "activate", "activate"]);
    for (const boundary of value.boundaries)
      expect(boundary).toMatchObject({
        signal: value.controller.signal,
        expiresAtMonotonicMilliseconds: 200,
      });
  });

  it("holds the intent after a successful CAS settles late and starts no activation", async () => {
    const value = await fixture();
    value.onStep((step) => {
      if (step === "active-replaced") value.expire();
    });
    expect(await value.configure()).toMatchObject({
      ok: false,
      configurationCommitted: true,
      state: "referenced-pending",
    });
    expect(value.calls).toEqual(["create", "create"]);
    expect(await readdir(value.home.mutationDirectory)).toContain(
      "credential.lock",
    );
    expect((await readConfigurationSnapshot(value.store)).generation).toBe(0);
  });
});

describe("configuration-only CAS and native retirement are not fictional cleanup", () => {
  it.each(["timely", "late", "failed"])(
    "reports only observed configuration commit for %s CI removal",
    async (kind) => {
      const value = await fixture();
      const reference = createCiEnvironmentCredentialReference(
        "AGENTSCOPE_TEST_CREDENTIAL",
        `credential-generation-v1-${"d".repeat(64)}`,
      );
      const references = {
        "public-key": reference,
        "secret-key": createCiEnvironmentCredentialReference(
          "AGENTSCOPE_TEST_SECOND_CREDENTIAL",
          `credential-generation-v1-${"e".repeat(64)}`,
        ),
      };
      await writeConfigurationSnapshot(value.store, {
        expectedGeneration: null,
        owner,
        candidate: candidate(0, references),
      });
      value.onStep((step) => {
        if (step === "active-replaced" && kind === "late") value.expire();
        if (step === "candidate-durable" && kind === "failed")
          throw new Error("synthetic-CAS-failure");
      });
      const result = await removeCredentialReference({
        store: value.store,
        owner,
        expectedGeneration: 0,
        ownership: ownership(),
        reference,
        resolutionContext: value.context,
        createCandidate: () => candidate(1, {}, false),
      });
      expect(result).toMatchObject(
        kind === "late"
          ? {
              ok: false,
              state: "configuration-committed",
              configurationCommitted: true,
            }
          : kind === "failed"
            ? { ok: false, configurationCommitted: false }
            : { ok: true, configurationCommitted: true },
      );
      expect(value.calls).toEqual([]);
      if (kind !== "failed")
        expect((await readConfigurationSnapshot(value.store)).generation).toBe(
          1,
        );
    },
  );

  it("does not delete the second owned slot or clear its claim after a late first deletion", async () => {
    const value = await fixture();
    const references = Object.fromEntries(
      ["public-key", "secret-key"].map((slot) => [
        slot,
        deriveStoredCredentialReference(
          "macos-keychain",
          ownership(slot),
          `credential-generation-v1-${"c".repeat(64)}`,
        ),
      ]),
    );
    const preimage = candidate(0, references);
    await writeConfigurationSnapshot(value.store, {
      expectedGeneration: null,
      owner,
      candidate: preimage,
    });
    value.onMutation((kind) => {
      if (kind === "remove") value.expire();
    });
    await expect(
      retireCredentialConnectionForCore(value.registry, {
        store: value.store,
        owner,
        connectionId,
        resolutionContext: value.context,
        preimage,
        removal: candidate(1, {}, false),
        final: candidate(2, {}, false),
      }),
    ).rejects.toMatchObject({ code: "core.credential.lifecycle-invalid" });
    expect(value.calls).toEqual(["remove"]);
    expect(
      (await readdir(value.home.mutationDirectory)).some((name) =>
        name.includes("credential"),
      ),
    ).toBe(true);
    expect((await readConfigurationSnapshot(value.store)).generation).toBe(2);
  });
});
