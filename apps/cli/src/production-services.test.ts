import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentscopeHomeResolver } from "@agentscope/core/configuration-management";
import {
  createDestinationReporter,
  createReporterReceipt,
} from "@agentscope/destinations-core";
import {
  compileDestinationRegistry,
  defineDestinationDescriptor,
} from "@agentscope/destinations-core/configuration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createCapturedOutput } from "./__tests__/cli-fixture.js";
import { runCli } from "./program.js";
import { createProductionCliServices } from "./production-services.js";

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
const presentPlan = (): Promise<void> => Promise.resolve();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

const productionFixture = async (prefix: string) => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const homeResolver = createAgentscopeHomeResolver({
    environment: { AGENTSCOPE_HOME: root },
    environmentOverrideAuthority: "test",
    platform: process.platform,
  });
  return {
    homeResolver,
    root,
    services: createProductionCliServices({
      environment: { EXAMPLE_API_KEY: "secret" },
      homeResolver,
      registry,
    }),
  };
};

describe("production configuration composition", () => {
  it("writes the exact initialization plan before --yes mutation", async () => {
    const { root, services } = await productionFixture(
      "agentscope-cli-plan-order-",
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    await expect(
      runCli(["init", "--yes"], {
        output: {
          writeErr: async (text) => {
            await expect(
              access(join(root, "config.json")),
            ).rejects.toBeDefined();
            stderr.push(text);
          },
          writeOut: (text) => {
            stdout.push(text);
          },
        },
        services,
        version: "1.2.3",
      }),
    ).resolves.toBe(0);
    expect(stderr).toEqual([
      "Initialization plan (no changes applied):\n",
      "planned: create-configuration\n",
    ]);
    expect(stdout).toEqual([
      "Initialization plan applied.\n",
      "applied: create-configuration\n",
    ]);
    await expect(access(join(root, "config.json"))).resolves.toBeUndefined();
  });

  it("separates a machine initialization plan from the final result", async () => {
    const { services } = await productionFixture(
      "agentscope-cli-machine-plan-",
    );
    const captured = createCapturedOutput();
    await expect(
      runCli(["init", "--yes", "--output", "json"], {
        output: captured.output,
        services,
        version: "1.2.3",
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(captured.stderr[0] ?? "null")).toMatchObject({
      schema: "agentscope.cli.plan.v1",
    });
    expect(JSON.parse(captured.stdout[0] ?? "null")).toMatchObject({
      schema: "agentscope.cli.result.v1",
    });
  });

  it("awaits the real stderr write completion before initialization", async () => {
    const { root, services } = await productionFixture(
      "agentscope-cli-process-plan-",
    );
    let completePlanWrite: (() => void) | undefined;
    vi.spyOn(process.stderr, "write").mockImplementation(
      (_value: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
        const completion =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback;
        if (typeof completion === "function") {
          completePlanWrite = () => {
            Reflect.apply(completion, undefined, []);
          };
        }
        return false;
      },
    );
    vi.spyOn(process.stdout, "write").mockImplementation(
      (_value: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
        const completion =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback;
        if (typeof completion === "function")
          Reflect.apply(completion, undefined, []);
        return true;
      },
    );

    const invocation = runCli(["init", "--yes", "--output", "json"], {
      services,
      version: "1.2.3",
    });
    await vi.waitFor(() => {
      expect(completePlanWrite).toBeTypeOf("function");
    });
    await expect(access(join(root, "config.json"))).rejects.toBeDefined();
    completePlanWrite?.();
    await expect(invocation).resolves.toBe(0);
    await expect(access(join(root, "config.json"))).resolves.toBeUndefined();
  });
});

describe("production configuration composition", () => {
  it("keeps plan inspection read-only and applies the generic lifecycle after --yes", async () => {
    const { root, services } = await productionFixture(
      "agentscope-cli-production-",
    );
    const run = async (arguments_: readonly string[]) => {
      const captured = createCapturedOutput();
      const exitCode = await runCli(arguments_, {
        output: captured.output,
        services,
        version: "1.2.3",
      });
      return { captured, exitCode };
    };

    expect((await run(["init", "--output", "json"])).exitCode).toBe(0);
    await expect(access(join(root, "config.json"))).rejects.toBeDefined();
    expect((await run(["init", "--yes"])).exitCode).toBe(0);
    await expect(access(join(root, "config.json"))).resolves.toBeUndefined();

    expect(
      (
        await run([
          "destination",
          "configure",
          "example",
          "--name",
          "local",
          "--settings",
          '{"project":"agentscope"}',
        ])
      ).exitCode,
    ).toBe(0);
    expect((await run(["routing", "set", "local"])).exitCode).toBe(0);
    expect((await run(["routing", "list"])).captured.stdout).toEqual([
      "Selected destinations: local\n",
    ]);
    const listed = await run(["destination", "list", "--output", "json"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.captured.stdout.join(""))).toMatchObject({
      records: [{ name: "local", routed: true }],
    });
    expect((await run(["destination", "unconfigure", "local"])).exitCode).toBe(
      0,
    );
    expect((await run(["routing", "list"])).captured.stdout).toEqual([
      "Delivery is disabled; no destination is selected.\n",
    ]);

    expect(
      (
        await run([
          "destination",
          "configure",
          "secret-example",
          "--name",
          "missing-secret",
          "--settings",
          '{"project":"agentscope"}',
          "--credential-env",
          "api-key=MISSING_KEY",
        ])
      ).exitCode,
    ).toBe(5);
    expect(
      (
        await run([
          "destination",
          "configure",
          "secret-example",
          "--name",
          "remote",
          "--settings",
          '{"project":"agentscope"}',
          "--credential-env",
          "api-key=EXAMPLE_API_KEY",
        ])
      ).exitCode,
    ).toBe(0);
    expect((await run(["destination", "inspect", "remote"])).exitCode).toBe(0);
    expect(
      (
        await run([
          "destination",
          "rotate",
          "remote",
          "--slot",
          "api-key",
          "--environment-variable",
          "EXAMPLE_API_KEY",
        ])
      ).exitCode,
    ).toBe(5);
    expect((await run(["destination", "unconfigure", "remote"])).exitCode).toBe(
      4,
    );
  });
});

describe("production configuration diagnostics", () => {
  it("returns closed diagnostics for invalid and unsupported lifecycle requests", async () => {
    const { homeResolver, services } = await productionFixture(
      "agentscope-cli-diagnostics-",
    );
    await expect(services.listDestinations()).resolves.toMatchObject({
      diagnostic: { code: "configuration.missing" },
    });
    await expect(services.listRouting()).resolves.toMatchObject({
      diagnostic: { code: "configuration.missing" },
    });
    for (const result of [
      services.inspectDestination({ name: "missing" }),
      services.deleteDestination({ confirm: true, name: "missing" }),
      services.rotateDestinationCredential({
        environmentVariable: "EXAMPLE_API_KEY",
        name: "missing",
        slot: "api-key",
      }),
    ])
      await expect(result).resolves.toMatchObject({
        diagnostic: { code: "configuration.missing" },
      });
    await expect(
      services.init({ apply: false, presentPlan }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: false, generation: null },
    });
    await expect(
      services.init({ apply: true, presentPlan }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: true, generation: 0 },
    });
    await expect(
      services.init({ apply: false, presentPlan }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: false, generation: 0 },
    });
    const unavailable = await productionFixture(
      "agentscope-cli-invalid-config-",
    );
    await writeFile(join(unavailable.root, "config.json"), "not-json", "utf8");
    await expect(
      unavailable.services.init({ apply: false, presentPlan }),
    ).resolves.toMatchObject({
      diagnostic: { code: "configuration.unavailable" },
    });
    for (const settingsJson of ["{", "[]", "null"]) {
      await expect(
        services.configureDestination({
          credentialEnvironment: [],
          name: "invalid",
          settingsJson,
          type: "example",
        }),
      ).resolves.toMatchObject({ diagnostic: { code: "cli.input.invalid" } });
    }
    await expect(
      services.configureDestination({
        credentialEnvironment: [],
        name: "unknown",
        settingsJson: "{}",
        type: "unknown",
      }),
    ).resolves.toMatchObject({
      diagnostic: { code: "destination.type-missing" },
    });
    await expect(
      services.configureDestination({
        credentialEnvironment: [
          "api-key=EXAMPLE_API_KEY",
          "api-key=EXAMPLE_API_KEY",
        ],
        name: "duplicate-slot",
        settingsJson: '{"project":"agentscope"}',
        type: "secret-example",
      }),
    ).resolves.toMatchObject({ diagnostic: { code: "cli.input.invalid" } });
    await expect(
      services.configureDestination({
        credentialEnvironment: [],
        name: "local",
        settingsJson: '{"project":"agentscope"}',
        type: "example",
      }),
    ).resolves.toMatchObject({ status: "success" });
    await expect(
      services.configureDestination({
        credentialEnvironment: [],
        name: "local",
        settingsJson: '{"project":"agentscope"}',
        type: "example",
      }),
    ).resolves.toMatchObject({
      diagnostic: { code: "destination.connection-exists" },
    });
    await expect(
      services.configureDestination({
        credentialEnvironment: [],
        name: "invalid-settings",
        settingsJson: '{"project":1}',
        type: "example",
      }),
    ).resolves.toMatchObject({
      diagnostic: { code: "configuration.unavailable" },
    });

    const defaults = createProductionCliServices({ homeResolver, registry });
    await expect(
      defaults.init({ apply: false, presentPlan }),
    ).resolves.toMatchObject({
      status: "success",
    });
  });
});

describe("production configuration mutation diagnostics", () => {
  it("validates connection and slot authority before unsupported mutations", async () => {
    const { services } = await productionFixture("agentscope-cli-unsupported-");
    await services.init({ apply: true, presentPlan });
    await services.configureDestination({
      credentialEnvironment: [],
      name: "local",
      settingsJson: '{"project":"agentscope"}',
      type: "example",
    });
    await expect(
      services.inspectDestination({ name: "local" }),
    ).resolves.toMatchObject({
      status: "success",
      value: { credentialSlots: [], settingKeys: ["project"] },
    });
    await expect(
      services.inspectDestination({ name: "missing" }),
    ).resolves.toMatchObject({
      diagnostic: { code: "destination.connection-missing" },
    });
    await expect(
      services.setRouting({ names: ["local", "local"] }),
    ).resolves.toMatchObject({
      diagnostic: { code: "routing.duplicate-connection" },
    });
    await expect(
      services.setRouting({ names: ["missing"] }),
    ).resolves.toMatchObject({
      diagnostic: { code: "routing.connection-missing" },
    });
    await expect(
      services.deleteDestination({ confirm: false, name: "local" }),
    ).resolves.toMatchObject({
      diagnostic: { code: "destination.confirmation-required" },
    });
    await expect(
      services.deleteDestination({ confirm: true, name: "missing" }),
    ).resolves.toMatchObject({
      diagnostic: { code: "destination.connection-missing" },
    });
    await expect(
      services.deleteDestination({ confirm: true, name: "local" }),
    ).resolves.toMatchObject({
      diagnostic: { code: "destination.data-delete-unsupported" },
    });
    await expect(
      services.rotateDestinationCredential({
        environmentVariable: "EXAMPLE_API_KEY",
        name: "missing",
        slot: "api-key",
      }),
    ).resolves.toMatchObject({
      diagnostic: { code: "destination.connection-missing" },
    });
    await expect(
      services.rotateDestinationCredential({
        environmentVariable: "EXAMPLE_API_KEY",
        name: "local",
        slot: "api-key",
      }),
    ).resolves.toMatchObject({
      diagnostic: { code: "destination.credential-slot-missing" },
    });
    await expect(
      services.unconfigureDestination({ name: "missing" }),
    ).resolves.toMatchObject({
      diagnostic: { code: "destination.connection-missing" },
    });
  });
});
