import { mkdtemp, rm } from "node:fs/promises";
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

import { createAgentscopeHomeFromOwnedRootForCore } from "./home.js";
import {
  ConfigurationManagementError,
  applyAgentscopeConfigurationInitialization,
  configureDestinationConnection,
  createCiEnvironmentCredentialPreflight,
  createConfigurationManagementRuntime,
  initializeAgentscopeConfiguration,
  inspectAgentscopeConfigurationInitialization,
  listDestinationConnections,
  setDestinationRouting,
  unconfigureDestinationConnection,
} from "./management.js";
import {
  createConfigurationProcessIdentity,
  createConfigurationStore,
  readConfigurationSnapshot,
} from "./transaction.js";

const settingsSchema = z.strictObject({ project: z.string() });
void settingsSchema.shape;
z.toJSONSchema(settingsSchema);
const descriptor = defineDestinationDescriptor({
  commandName: "example",
  createReporter: () =>
    createDestinationReporter({
      report: () => Promise.resolve(createReporterReceipt("accepted")),
    }),
  credentialSlots: [],
  defaultSettings: { project: "default" },
  deliveryIdentitySupport: "duplicates-possible",
  descriptorVersion: 1,
  destinationType: "@agentscope/destination-example",
  documentationPath: "/docs/destinations/example",
  settingsSchema,
  settingsVersion: 1,
  transport: { kind: "local" },
});
const secretDescriptor = defineDestinationDescriptor({
  commandName: "secret-example",
  createReporter: () =>
    createDestinationReporter({
      report: () => Promise.resolve(createReporterReceipt("accepted")),
    }),
  credentialSlots: [{ id: "api-key", required: true }],
  defaultSettings: { project: "default" },
  deliveryIdentitySupport: "duplicates-possible",
  descriptorVersion: 1,
  destinationType: "@agentscope/destination-secret-example",
  documentationPath: "/docs/destinations/secret-example",
  settingsSchema,
  settingsVersion: 1,
  transport: {
    kind: "remote",
    resolveEndpoint: () => ({
      allowInsecureLoopback: false,
      url: "https://example.com/v1/traces",
    }),
  },
});
const registry = compileDestinationRegistry([descriptor, secretDescriptor]);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "agentscope-management-"));
  roots.push(root);
  const home = createAgentscopeHomeFromOwnedRootForCore(root, process.platform);
  const store = createConfigurationStore(home, registry);
  const owner = createConfigurationProcessIdentity(
    process.pid,
    `process-start-v1-${"a".repeat(64)}`,
  );
  return {
    root,
    runtime: createConfigurationManagementRuntime(registry, store, owner),
    store,
  };
};

const environmentReference = {
  backend: "ci-environment" as const,
  environmentVariable: "EXAMPLE_API_KEY",
  generationId: `credential-generation-v1-${"b".repeat(64)}`,
  referenceVersion: 1 as const,
};

describe("Core-owned destination configuration management", () => {
  it("rejects unbranded runtimes, registries, stores, and owners", async () => {
    const { runtime, store } = await fixture();
    const independentlyCompiledRegistry = compileDestinationRegistry([
      descriptor,
      secretDescriptor,
    ]);
    expect(() =>
      createConfigurationManagementRuntime(
        independentlyCompiledRegistry,
        store,
        createConfigurationProcessIdentity(
          process.pid,
          `process-start-v1-${"e".repeat(64)}`,
        ),
      ),
    ).toThrowError(ConfigurationManagementError);
    expect(() =>
      createConfigurationManagementRuntime(
        registry,
        {} as never,
        createConfigurationProcessIdentity(
          process.pid,
          `process-start-v1-${"c".repeat(64)}`,
        ),
      ),
    ).toThrowError(ConfigurationManagementError);
    expect(() =>
      createConfigurationManagementRuntime(
        {} as never,
        store,
        createConfigurationProcessIdentity(
          process.pid,
          `process-start-v1-${"d".repeat(64)}`,
        ),
      ),
    ).toThrowError(ConfigurationManagementError);
    await expect(
      listDestinationConnections({ ...runtime }),
    ).rejects.toThrowError(ConfigurationManagementError);
  });

  it("returns exact missing-state failures before initialization", async () => {
    const { runtime } = await fixture();
    await expect(listDestinationConnections(runtime)).rejects.toMatchObject({
      code: "core.configuration.missing",
    });
    await expect(
      configureDestinationConnection(runtime, {
        commandName: "example",
        credentialReferences: {},
        name: "local",
        settings: { project: "agentscope" },
      }),
    ).rejects.toMatchObject({ code: "core.configuration.missing" });
    await expect(setDestinationRouting(runtime, [])).rejects.toMatchObject({
      code: "core.configuration.missing",
    });
    await expect(
      unconfigureDestinationConnection(runtime, "local"),
    ).rejects.toMatchObject({ code: "core.configuration.missing" });
  });
});

describe("destination configuration lifecycle", () => {
  it("initializes once and atomically configures, routes, and unconfigures", async () => {
    const { runtime, store } = await fixture();
    await expect(initializeAgentscopeConfiguration(runtime)).resolves.toEqual({
      created: true,
      generation: 0,
    });
    await expect(initializeAgentscopeConfiguration(runtime)).resolves.toEqual({
      created: false,
      generation: 0,
    });
    const configured = await configureDestinationConnection(runtime, {
      commandName: "example",
      credentialReferences: {},
      name: "local",
      settings: { project: "agentscope" },
    });
    expect(configured).toMatchObject({
      connection: { name: "local", routed: false, transport: "local" },
      generation: 1,
    });
    expect(await listDestinationConnections(runtime)).toEqual([
      configured.connection,
    ]);
    await expect(setDestinationRouting(runtime, ["local"])).resolves.toEqual({
      generation: 2,
      selected: ["local"],
    });
    expect((await listDestinationConnections(runtime))[0]).toMatchObject({
      routed: true,
    });
    await expect(
      unconfigureDestinationConnection(runtime, "local"),
    ).resolves.toEqual({
      generation: 3,
      name: "local",
    });
    expect(await listDestinationConnections(runtime)).toEqual([]);
    expect(
      (await readConfigurationSnapshot(store)).selectedConnectionIds,
    ).toEqual([]);
  });

  it("binds initialization to an exact one-use inspected plan", async () => {
    const { root, runtime } = await fixture();
    const createPlan =
      await inspectAgentscopeConfigurationInitialization(runtime);
    expect(createPlan).toMatchObject({ action: "create", generation: null });
    await expect(
      applyAgentscopeConfigurationInitialization({ ...createPlan }),
    ).rejects.toThrowError(ConfigurationManagementError);
    await expect(
      applyAgentscopeConfigurationInitialization(createPlan),
    ).resolves.toEqual({ created: true, generation: 0 });
    await expect(
      applyAgentscopeConfigurationInitialization(createPlan),
    ).rejects.toThrowError(ConfigurationManagementError);

    const unchangedPlan =
      await inspectAgentscopeConfigurationInitialization(runtime);
    await configureDestinationConnection(runtime, {
      commandName: "example",
      credentialReferences: {},
      name: "later",
      settings: { project: "agentscope" },
    });
    await expect(
      applyAgentscopeConfigurationInitialization(unchangedPlan),
    ).rejects.toMatchObject({ code: "core.configuration.conflict" });

    const missingPlan =
      await inspectAgentscopeConfigurationInitialization(runtime);
    await rm(join(root, "config.json"));
    await expect(
      applyAgentscopeConfigurationInitialization(missingPlan),
    ).rejects.toMatchObject({ code: "core.configuration.missing" });
  });
});

describe("destination credential configuration", () => {
  it("validates descriptor settings and credential references before writes", async () => {
    const { runtime } = await fixture();
    await initializeAgentscopeConfiguration(runtime);
    await expect(
      configureDestinationConnection(runtime, {
        commandName: "secret-example",
        credentialReferences: {},
        name: "remote",
        settings: { project: "agentscope" },
      }),
    ).rejects.toThrowError(ConfigurationManagementError);
    await expect(
      configureDestinationConnection(runtime, {
        commandName: "secret-example",
        credentialReferences: { "api-key": environmentReference },
        name: "remote",
        settings: { project: "agentscope" },
      }),
    ).rejects.toMatchObject({
      code: "core.destination.credential-unavailable",
    });
    await expect(
      configureDestinationConnection(
        runtime,
        {
          commandName: "secret-example",
          credentialReferences: { "api-key": environmentReference },
          name: "remote",
          settings: { project: "agentscope" },
        },
        createCiEnvironmentCredentialPreflight(
          { EXAMPLE_API_KEY: "secret" },
          new AbortController().signal,
        ),
      ),
    ).resolves.toMatchObject({
      connection: { name: "remote", transport: "remote" },
    });
    await expect(
      unconfigureDestinationConnection(runtime, "remote"),
    ).rejects.toMatchObject({
      code: "core.destination.credential-removal-required",
    });
  });

  it("preflights CI credential references before configuration mutation", async () => {
    const { runtime, store } = await fixture();
    await initializeAgentscopeConfiguration(runtime);
    for (const environment of [{}, { EXAMPLE_API_KEY: 42 }]) {
      await expect(
        configureDestinationConnection(
          runtime,
          {
            commandName: "secret-example",
            credentialReferences: { "api-key": environmentReference },
            name: "remote",
            settings: { project: "agentscope" },
          },
          createCiEnvironmentCredentialPreflight(
            environment,
            new AbortController().signal,
          ),
        ),
      ).rejects.toMatchObject({
        code: "core.destination.credential-unavailable",
      });
      expect((await readConfigurationSnapshot(store)).generation).toBe(0);
    }
    const controller = new AbortController();
    controller.abort();
    await expect(
      configureDestinationConnection(
        runtime,
        {
          commandName: "secret-example",
          credentialReferences: { "api-key": environmentReference },
          name: "remote",
          settings: { project: "agentscope" },
        },
        createCiEnvironmentCredentialPreflight(
          { EXAMPLE_API_KEY: "secret" },
          controller.signal,
        ),
      ),
    ).rejects.toMatchObject({
      code: "core.destination.credential-unavailable",
    });
    expect((await readConfigurationSnapshot(store)).generation).toBe(0);
  });
});

describe("destination configuration rejection and cleanup", () => {
  it("rejects duplicates, unknown routes, and hostile credential records", async () => {
    const { runtime } = await fixture();
    await initializeAgentscopeConfiguration(runtime);
    await configureDestinationConnection(runtime, {
      commandName: "example",
      credentialReferences: {},
      name: "local",
      settings: { project: "agentscope" },
    });
    await expect(
      configureDestinationConnection(runtime, {
        commandName: "example",
        credentialReferences: {},
        name: "local",
        settings: { project: "other" },
      }),
    ).rejects.toMatchObject({ code: "core.destination.connection-exists" });
    await expect(
      setDestinationRouting(runtime, ["missing"]),
    ).rejects.toMatchObject({
      code: "core.destination.connection-missing",
    });
    await expect(
      setDestinationRouting(runtime, ["local", "local"]),
    ).rejects.toMatchObject({ code: "core.configuration.invalid" });
    await expect(
      unconfigureDestinationConnection(runtime, "missing"),
    ).rejects.toMatchObject({ code: "core.destination.connection-missing" });
    await expect(
      configureDestinationConnection(runtime, {
        commandName: "unknown",
        credentialReferences: {},
        name: "unknown",
        settings: {},
      }),
    ).rejects.toMatchObject({ code: "core.destination.type-missing" });
    const hostile = {} as Record<string, typeof environmentReference>;
    Object.defineProperty(hostile, "api-key", {
      enumerable: true,
      get: () => environmentReference,
    });
    await expect(
      configureDestinationConnection(runtime, {
        commandName: "secret-example",
        credentialReferences: hostile,
        name: "second",
        settings: { project: "agentscope" },
      }),
    ).rejects.toThrowError(ConfigurationManagementError);
  });

  it("retains a destination namespace until its final connection is removed", async () => {
    const { runtime } = await fixture();
    await initializeAgentscopeConfiguration(runtime);
    for (const name of ["first", "second"])
      await configureDestinationConnection(runtime, {
        commandName: "example",
        credentialReferences: {},
        name,
        settings: { project: name },
      });
    await expect(
      unconfigureDestinationConnection(runtime, "first"),
    ).resolves.toMatchObject({ name: "first" });
    await expect(listDestinationConnections(runtime)).resolves.toMatchObject([
      { name: "second" },
    ]);
  });
});
