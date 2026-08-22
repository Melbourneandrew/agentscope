import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentscopeHomeResolver } from "@agentscope/core/configuration-management";
import {
  createDestinationRetriever,
  createDestinationReporter,
  defineDestinationReachabilityProbe,
  createRetrieverFailure,
  createReporterReceipt,
  createRetrieverSearchPage,
  createRetrieverSuccess,
  createTraceLocator,
  createTraceSummary,
} from "@agentscope/destinations-core";
import {
  compileDestinationRegistry,
  defineDestinationDescriptor,
} from "@agentscope/destinations-core/configuration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createCapturedOutput } from "./__tests__/cli-fixture.js";
import { runCli } from "./program.js";

// AC-DOC-001.3 AC-DOC-001.4 AC-DOC-001.6
import {
  createProductionCliServices,
  createProductionCliServicesForTesting,
  requireExactProductDestinationRegistryForTesting,
} from "./production-services.js";

const settingsSchema = z.strictObject({ project: z.string() });
void settingsSchema.shape;
z.toJSONSchema(settingsSchema);
const retrievedTraceId = "0123456789abcdef0123456789abcdef";
const descriptor = defineDestinationDescriptor({
  commandName: "example",
  retrievalOrdering: "start-time-desc-trace-id-asc",
  createRetriever: () =>
    createDestinationRetriever({
      get: () => Promise.resolve(createRetrieverFailure("not-found")),
      search: (request) =>
        Promise.resolve(
          request.query.branch === "rate-limit"
            ? createRetrieverFailure("rate-limited", 250)
            : createRetrieverSuccess(
                createRetrieverSearchPage({
                  consistency: "snapshot",
                  ordering: "start-time-desc-trace-id-asc",
                  state: "exhaustive",
                  summaries: [
                    createTraceSummary({
                      branch: "main",
                      harness: "codex",
                      locator: createTraceLocator({
                        connectionId: request.connectionId,
                        destinationType: request.destinationType,
                        traceId: retrievedTraceId,
                        destinationRevision: "1".repeat(32),
                      }),
                      models: ["gpt-5"],
                      spanCount: 3,
                      startTime: "2026-01-01T00:00:00.000Z",
                      status: "ok",
                      tags: ["fixture"],
                    }),
                  ],
                }),
              ),
        ),
    }),
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

const productionFixture = async (
  prefix: string,
  overrides: Parameters<typeof createProductionCliServices>[0] = {},
) => {
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
    services: createProductionCliServicesForTesting({
      environment: { EXAMPLE_API_KEY: "secret" },
      homeResolver,
      registry,
      ...overrides,
    }),
  };
};

const productionLangfuseFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "agentscope-cli-langfuse-"));
  roots.push(root);
  const homeResolver = createAgentscopeHomeResolver({
    environment: { AGENTSCOPE_HOME: root },
    environmentOverrideAuthority: "test",
    platform: process.platform,
  });
  const requests: unknown[] = [];
  const services = createProductionCliServices({
    environment: {
      LANGFUSE_PUBLIC_KEY: "public-canary",
      LANGFUSE_SECRET_KEY: "secret-canary",
    },
    homeResolver,
    transportExecutor: (request) => {
      requests.push(request);
      return Promise.resolve({
        status: 405,
        headers: { "x-canary": "discarded" },
        body: new TextEncoder().encode("discarded-provider-body"),
      });
    },
    workspace: root,
  });
  await services.init({ apply: true, presentPlan });
  const configured = services.configureDestination({
    credentialEnvironment: [
      "public-key=LANGFUSE_PUBLIC_KEY",
      "secret-key=LANGFUSE_SECRET_KEY",
    ],
    name: "langfuse",
    settingsJson: JSON.stringify({
      allowInsecureLoopback: true,
      endpoint: "http://127.0.0.1:4318",
    }),
    type: "langfuse",
  });
  return { configured, requests, services };
};

describe("production destination registry boundary", () => {
  it("rejects every non-product destination registry inventory", () => {
    let executableReads = 0;
    const hostile = Object.defineProperty({}, "descriptors", {
      get: () => {
        executableReads += 1;
        return [];
      },
    });
    expect(() =>
      requireExactProductDestinationRegistryForTesting(hostile as never),
    ).toThrow("cli.product-destination-registry.invalid");
    expect(executableReads).toBe(0);
    expect(() =>
      requireExactProductDestinationRegistryForTesting(
        compileDestinationRegistry([]),
      ),
    ).toThrow("cli.product-destination-registry.invalid");
    expect(() =>
      requireExactProductDestinationRegistryForTesting(
        compileDestinationRegistry([descriptor]),
      ),
    ).toThrow("cli.product-destination-registry.invalid");
    expect(() =>
      requireExactProductDestinationRegistryForTesting(registry),
    ).toThrow("cli.product-destination-registry.invalid");
    expect(() => compileDestinationRegistry([descriptor, descriptor])).toThrow(
      "destination.descriptor.invalid",
    );
  });
});

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

describe("production Doctor composition", () => {
  it("composes the immutable Langfuse descriptor and its bound Doctor probe by default", async () => {
    const { configured, requests, services } =
      await productionLangfuseFixture();
    await expect(configured).resolves.toMatchObject({
      status: "success",
      value: {
        connection: {
          destinationType: "@agentscope/destination-langfuse",
          name: "langfuse",
          transport: "remote",
        },
      },
    });
    await expect(
      services.inspectDestination({ name: "langfuse" }),
    ).resolves.toMatchObject({
      status: "success",
      value: {
        credentialSlots: ["public-key", "secret-key"],
        settingKeys: [
          "allowInsecureLoopback",
          "compatibilityManifestId",
          "encoding",
          "endpoint",
          "profileId",
        ],
      },
    });

    const report = await services.doctor({
      fix: false,
      presentPlan: () => Promise.reject(new Error("unreachable")),
    });
    expect(report.status).toBe("success");
    if (report.status !== "success") throw new Error("unreachable");
    expect(report.value.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "doctor.credential.available",
        "doctor.destination.available",
      ]),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      headers: {},
      method: "GET",
      url: "http://127.0.0.1:4318/api/public/otel/v1/traces",
    });
    expect(requests[0]).not.toHaveProperty("body");
    expect(JSON.stringify(report)).not.toContain("canary");
  });

  it("rejects a destination-declared probe absent from the exact registry", async () => {
    await expect(
      productionFixture("agentscope-cli-doctor-registry-", {
        reachabilityProbes: [
          defineDestinationReachabilityProbe({
            destinationType: "@agentscope/destination-unknown",
            inspect: () => Promise.resolve("available"),
          }),
        ],
      }),
    ).rejects.toThrow("cli.doctor.invalid");
  });

  it("uses the approved home, real Git inspector, and opaque credential checks", async () => {
    const { services } = await productionFixture("agentscope-cli-doctor-");
    await services.init({ apply: true, presentPlan });
    await services.configureDestination({
      credentialEnvironment: ["api-key=EXAMPLE_API_KEY"],
      name: "secret",
      settingsJson: JSON.stringify({ project: "fixture" }),
      type: "secret-example",
    });

    const result = await services.doctor({
      fix: false,
      presentPlan: () => Promise.reject(new Error("unreachable")),
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("unreachable");
    expect(result.value.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "doctor.configuration.valid",
        "doctor.credential.available",
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("EXAMPLE_API_KEY");
  });

  it("classifies a live process with a different start identity as unknown", async () => {
    const { root, services } = await productionFixture(
      "agentscope-cli-doctor-owner-",
    );
    await mkdir(join(root, "health"), { recursive: true });
    await writeFile(
      join(root, "health", "operational-state.lock"),
      `${JSON.stringify({
        version: 1,
        owner: {
          processId: process.pid,
          processStartIdentity: `process-start-v1-${"f".repeat(64)}`,
        },
        token: "e".repeat(32),
      })}\n`,
    );

    const result = await services.doctor({
      fix: false,
      presentPlan: () => Promise.reject(new Error("unreachable")),
    });
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("unreachable");
    expect(result.value.findings.map(({ code }) => code)).toContain(
      "doctor.operational-state.lock-owner-unknown",
    );
  });
});

describe("production trace retrieval composition", () => {
  it("maps missing and invalid configuration before retrieval authority", async () => {
    const { root, services } = await productionFixture(
      "agentscope-cli-retrieval-config-",
    );
    const input = { destination: "archive", tags: [] };

    await expect(services.searchTraces(input)).resolves.toEqual({
      diagnostic: {
        category: "not-found",
        code: "configuration.missing",
      },
      status: "failure",
    });
    await writeFile(join(root, "config.json"), "{}\n", { mode: 0o600 });
    await expect(services.searchTraces(input)).resolves.toEqual({
      diagnostic: {
        category: "unavailable",
        code: "configuration.unavailable",
      },
      status: "failure",
    });
  });

  it("searches and gets through one configured Retriever with safe schemas", async () => {
    const { services } = await productionFixture("agentscope-cli-retrieval-");
    const invoke = async (arguments_: readonly string[]) => {
      const captured = createCapturedOutput();
      const exitCode = await runCli(arguments_, {
        output: captured.output,
        services,
        version: "1.2.3",
      });
      return { captured, exitCode };
    };
    expect((await invoke(["init", "--yes"])).exitCode).toBe(0);
    expect(
      (
        await invoke([
          "destination",
          "configure",
          "example",
          "--name",
          "archive",
        ])
      ).exitCode,
    ).toBe(0);

    const search = await invoke([
      "traces",
      "search",
      "--destination",
      "archive",
      "--trace-id",
      retrievedTraceId,
      "--from",
      "2025-12-31T00:00:00Z",
      "--to",
      "2026-01-02T00:00:00Z",
      "--harness",
      "codex",
      "--branch",
      "main",
      "--model",
      "gpt-5",
      "--session",
      "session-1",
      "--tag",
      "fixture",
      "--limit",
      "25",
      "--output",
      "json",
    ]);
    expect(search.exitCode).toBe(0);
    const searchDocument = JSON.parse(search.captured.stdout.join("")) as {
      records: Array<{
        summaries: Array<{
          locator: {
            connectionId: string;
            destinationType: string;
            destinationRevision: string;
            traceId: string;
          };
        }>;
      }>;
    };
    const returnedLocator = searchDocument.records[0]!.summaries[0]!.locator;
    expect(returnedLocator.traceId).toBe(retrievedTraceId);
    expect(returnedLocator.destinationRevision).toBe("1".repeat(32));

    const get = await invoke([
      "traces",
      "get",
      "--destination",
      "archive",
      "--trace-ref",
      JSON.stringify(returnedLocator),
      "--output",
      "json",
    ]);
    expect(get.exitCode).toBe(3);
    expect(get.captured.stdout).toEqual([]);
    expect(JSON.parse(get.captured.stderr.join(""))).toMatchObject({
      code: "traces.not-found",
    });

    expect(
      (
        await invoke([
          "traces",
          "get",
          "--destination",
          "archive",
          "--trace-id",
          retrievedTraceId,
        ])
      ).exitCode,
    ).toBe(3);
  });
});

describe("production trace retrieval selection", () => {
  it("keeps selection explicit and rejects a cross-connection locator", async () => {
    const { services } = await productionFixture(
      "agentscope-cli-retrieval-selection-",
    );
    const invoke = async (arguments_: readonly string[]) => {
      const captured = createCapturedOutput();
      const exitCode = await runCli(arguments_, {
        output: captured.output,
        services,
        version: "1.2.3",
      });
      return { captured, exitCode };
    };
    await invoke(["init", "--yes"]);
    await invoke(["destination", "configure", "example", "--name", "archive"]);
    await invoke([
      "destination",
      "configure",
      "secret-example",
      "--name",
      "write-only",
      "--credential-env",
      "api-key=EXAMPLE_API_KEY",
    ]);
    const unknown = await invoke([
      "traces",
      "search",
      "--destination",
      "missing",
    ]);
    const mismatch = await invoke([
      "traces",
      "get",
      "--destination",
      "archive",
      "--trace-ref",
      JSON.stringify({
        connectionId:
          "destination-connection-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        destinationType: "@agentscope/destination-example",
        traceId: retrievedTraceId,
      }),
    ]);
    const unsupported = await invoke([
      "traces",
      "search",
      "--destination",
      "write-only",
    ]);
    const rateLimited = await invoke([
      "traces",
      "search",
      "--destination",
      "archive",
      "--branch",
      "rate-limit",
      "--output",
      "json",
    ]);

    expect(unknown.exitCode).toBe(3);
    expect(unknown.captured.stderr).toEqual([
      "error [traces.destination-unknown]\n",
    ]);
    expect(mismatch.exitCode).toBe(2);
    expect(mismatch.captured.stderr).toEqual([
      "error [traces.invalid-query]\n",
    ]);
    expect(unsupported.exitCode).toBe(5);
    expect(unsupported.captured.stderr).toEqual([
      "error [traces.retrieval-unsupported]\n",
    ]);
    expect(rateLimited.exitCode).toBe(5);
    expect(JSON.parse(rateLimited.captured.stderr.join(""))).toMatchObject({
      code: "traces.rate-limited",
      facts: { retryAfterMilliseconds: 250 },
    });
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

    const defaults = createProductionCliServicesForTesting({
      homeResolver,
      registry,
    });
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
