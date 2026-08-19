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
  configureDestinationConnection,
  createConfigurationManagementRuntime,
  initializeAgentscopeConfiguration,
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
    ).resolves.toMatchObject({
      connection: { name: "remote", transport: "remote" },
    });
    await expect(
      unconfigureDestinationConnection(runtime, "remote"),
    ).rejects.toMatchObject({
      code: "core.destination.credential-removal-required",
    });
  });

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
});
