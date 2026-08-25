import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentscopeHomeResolver } from "@agentscope/core/configuration-management";
import {
  commitLocalResourceConfiguration,
  compileLocalResourceLifecycleHandlerRegistry,
  createDestinationRetriever,
  createDestinationReporter,
  defineDestinationReachabilityProbe,
  createRetrieverFailure,
  createReporterReceipt,
  createRetrieverSearchPage,
  createRetrieverSuccess,
  createTraceLocator,
  createTraceSummary,
  defineLocalResourceLifecycleDeclaration,
  defineLocalResourceLifecycleHandler,
  type LocalResourceLifecyclePlanEvidence,
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
const localLifecycleDeclaration = defineLocalResourceLifecycleDeclaration({
  artifactGrammarFingerprint: `sha256-${"1".repeat(64)}`,
  artifactGrammarVersion: 1,
  artifactKinds: ["active-database", "lifecycle-intent", "ownership-receipt"],
  capabilityVersion: 1,
  destinationType: "@agentscope/destination-cli-local",
  operations: ["configure", "delete", "doctor", "recover", "unconfigure"],
  receiptReasons: ["destination-busy"],
  recoveryHandlerId: "@agentscope/destination-cli-local/lifecycle-v1",
  settingKeys: ["project"],
  settingsVersion: 1,
});
const localDescriptor = defineDestinationDescriptor({
  commandName: "cli-local",
  createReporter: () =>
    createDestinationReporter({
      report: () => Promise.resolve(createReporterReceipt("accepted")),
    }),
  credentialSlots: [],
  defaultSettings: { project: "default" },
  deliveryIdentitySupport: "duplicates-possible",
  descriptorVersion: 1,
  destinationType: "@agentscope/destination-cli-local",
  documentationPath: "/docs/destinations/cli-local",
  localResourceLifecycle: localLifecycleDeclaration,
  settingsSchema,
  settingsVersion: 1,
  transport: { kind: "local" },
});
const localRegistry = compileDestinationRegistry([localDescriptor]);
const roots: string[] = [];
const presentPlan = (): Promise<void> => Promise.resolve();

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("installed CLI home authority", () => {
  it("uses the explicit portable home without mutating the HOME default", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentscope-cli-home-override-"));
    roots.push(root);
    const fallback = join(root, "fallback");
    const override = join(root, "override");
    vi.stubEnv("HOME", fallback);
    vi.stubEnv("AGENTSCOPE_HOME", override);
    const captured = createCapturedOutput();

    await expect(
      runCli(["init", "--yes", "--output", "json"], {
        createServices: () =>
          createProductionCliServicesForTesting({
            environmentOverrideAuthority: "portable",
            registry,
          }),
        output: captured.output,
        version: "1.2.3",
      }),
    ).resolves.toBe(0);
    await expect(
      access(join(override, "config.json")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(fallback, ".agentscope", "config.json")),
    ).rejects.toBeDefined();
  });

  it.each(["relative-home", "/", "\0unsafe-home"])(
    "rejects invalid portable home %j without fallback mutation",
    async (override) => {
      const root = await mkdtemp(
        join(tmpdir(), "agentscope-cli-home-invalid-"),
      );
      roots.push(root);
      const fallback = join(root, "fallback");
      vi.stubEnv("HOME", fallback);
      const captured = createCapturedOutput();

      await expect(
        runCli(["init", "--yes", "--output", "json"], {
          createServices: () =>
            createProductionCliServicesForTesting({
              environment: { AGENTSCOPE_HOME: override },
              environmentOverrideAuthority: "portable",
              registry,
            }),
          output: captured.output,
          version: "1.2.3",
        }),
      ).resolves.toBe(70);
      expect(captured.stdout).toEqual([]);
      expect(captured.stderr).toEqual([
        '{"category":"internal-error","code":"cli.internal","command":"agentscope init","schema":"agentscope.cli.diagnostic.v1"}\n',
      ]);
      expect(captured.stderr.join("")).not.toContain(override);
      await expect(
        access(join(fallback, ".agentscope", "config.json")),
      ).rejects.toBeDefined();
    },
  );

  it("preserves the HOME default when no portable override is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentscope-cli-home-default-"));
    roots.push(root);
    const fallback = join(root, "fallback");
    vi.stubEnv("HOME", fallback);
    const captured = createCapturedOutput();

    await expect(
      runCli(["init", "--yes", "--output", "json"], {
        createServices: () =>
          createProductionCliServicesForTesting({
            environment: {},
            environmentOverrideAuthority: "portable",
            registry,
          }),
        output: captured.output,
        version: "1.2.3",
      }),
    ).resolves.toBe(0);
    await expect(
      access(join(fallback, ".agentscope", "config.json")),
    ).resolves.toBeUndefined();
  });
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

// eslint-disable-next-line max-lines-per-function -- one fixture binds a complete versioned lifecycle handler and its retained authority.
const localLifecycleFixture = async (prefix: string) => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const homeResolver = createAgentscopeHomeResolver({
    environment: { AGENTSCOPE_HOME: root },
    environmentOverrideAuthority: "test",
    platform: process.platform,
  });
  const events: string[] = [];
  let failAfterCommit = false;
  let failBusy = false;
  let failReconciliation = false;
  let retained:
    | Readonly<{
        connectionId: string;
        connectionName: string;
        destinationType: string;
        planEvidence: LocalResourceLifecyclePlanEvidence;
        retainedAuthority: Readonly<{
          databaseFamilyPhysicalIdentity: string;
          receiptDigest: string;
        }>;
      }>
    | undefined;
  const capability = localRegistry.descriptors[0]!.localResourceLifecycle!;
  const planEvidence = Object.freeze({
    displayPath: "/owned/local/traces.sqlite",
    namespaceFingerprint: `sha256-${"2".repeat(64)}`,
    persistentDataNotice: true as const,
    physicalEvidenceFingerprint: `sha256-${"3".repeat(64)}`,
    retentionPolicy: Object.freeze({
      maximumAgeNanoseconds: "2592000000000000",
      maximumPayloadBytes: 1_073_741_824,
      maximumTraceCount: 100_000,
      physicalCleanupTrigger: "next-authorized-mutation" as const,
    }),
  });
  const createHandler = () =>
    defineLocalResourceLifecycleHandler({
      apply: async (context) => {
        events.push(`apply:${context.operation}`);
        if (failBusy) {
          failBusy = false;
          return Object.freeze({
            code: "busy" as const,
            ok: false as const,
            state: "unchanged" as const,
          });
        }
        if (failReconciliation) {
          failReconciliation = false;
          return Object.freeze({
            code: "reconciliation-required" as const,
            ok: false as const,
            state: "unchanged" as const,
          });
        }
        await commitLocalResourceConfiguration(context.configurationAuthority, {
          connectionId: context.connectionId,
          destinationType: context.destinationType,
          lifecycleFingerprint: capability.fingerprint,
          operationId: context.operationId,
          recoveryHandlerId: capability.recoveryHandlerId,
        });
        if (failAfterCommit) {
          failAfterCommit = false;
          throw new Error("simulated post-commit interruption");
        }
        if (context.operation === "unconfigure") {
          retained = Object.freeze({
            connectionId: context.connectionId,
            connectionName: context.connectionName,
            destinationType: context.destinationType,
            planEvidence: context.planEvidence,
            retainedAuthority: Object.freeze({
              databaseFamilyPhysicalIdentity: "dev:1:ino:2",
              receiptDigest: `sha256-${"4".repeat(64)}`,
            }),
          });
          return Object.freeze({
            ok: true as const,
            retainedAuthority: retained.retainedAuthority,
            state: "retained" as const,
          });
        }
        if (context.operation === "delete") retained = undefined;
        return Object.freeze({
          ok: true as const,
          state:
            context.operation === "delete"
              ? ("deleted" as const)
              : ("configured" as const),
        });
      },
      capability,
      complete: () => Promise.resolve(),
      inspectDoctor: () =>
        Promise.resolve(
          Object.freeze({
            backupState: "available" as const,
            databaseDerivedRetention: Object.freeze({
              clockContinuity: "unavailable" as const,
              cutoff: "unavailable" as const,
              payloadBytes: "unavailable" as const,
              rowCount: "unavailable" as const,
            }),
            databaseState: "present" as const,
            lifecycleState: "clean" as const,
            publishedBackupCount: 0,
            retentionPolicy: planEvidence.retentionPolicy,
            sharedLeaseCount: 0,
            state: "available" as const,
          }),
        ),
      inspectPlan: (context) => {
        events.push(`inspect:${context.operation}`);
        return Promise.resolve(planEvidence);
      },
      inspectRetainedDelete: (connectionId) =>
        Promise.resolve(
          retained?.connectionId === connectionId
            ? Object.freeze({ ...retained, connectionName: "retained" })
            : null,
        ),
      recover: async (context) => {
        events.push(`recover:${context.operation}`);
        if (context.configurationAuthority)
          await commitLocalResourceConfiguration(
            context.configurationAuthority,
            {
              connectionId: context.connectionId,
              destinationType: context.destinationType,
              lifecycleFingerprint: capability.fingerprint,
              operationId: context.operationId,
              recoveryHandlerId: capability.recoveryHandlerId,
            },
          );
        return Object.freeze({
          ok: true as const,
          state:
            context.operation === "delete"
              ? ("deleted" as const)
              : ("configured" as const),
        });
      },
    });
  const createServices = () =>
    createProductionCliServicesForTesting({
      homeResolver,
      lifecycleHandlers: compileLocalResourceLifecycleHandlerRegistry(
        localRegistry,
        [createHandler()],
      ),
      ownerState: () => "dead",
      registry: localRegistry,
      workspace: root,
    });
  return {
    createServices,
    events,
    failNextApplyAfterCommit: () => {
      failAfterCommit = true;
    },
    failNextApplyBusy: () => {
      failBusy = true;
    },
    failNextApplyReconciliation: () => {
      failReconciliation = true;
    },
    root,
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

// eslint-disable-next-line max-lines-per-function -- this group owns the complete lifecycle CLI composition matrix.
describe("Local lifecycle CLI composition", () => {
  // eslint-disable-next-line max-lines-per-function -- one causal sequence proves plan/apply, Doctor, retention, fresh-process inspection, and deletion.
  it("plans before mutation, reports Doctor evidence, and deletes a retained database from a fresh service", async () => {
    const fixture = await localLifecycleFixture("agentscope-cli-local-flow-");
    const services = fixture.createServices();
    await services.init({ apply: true, presentPlan });
    const configureInput = {
      credentialEnvironment: [],
      name: "local-history",
      settingsJson: '{"project":"agentscope"}',
      type: "cli-local",
    };
    await expect(
      services.configureDestination(configureInput),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: false, connection: null, state: "planned" },
    });
    await expect(services.listDestinations()).resolves.toMatchObject({
      status: "success",
      value: { connections: [] },
    });
    await expect(
      services.configureDestination({ ...configureInput, apply: true }),
    ).resolves.toMatchObject({
      diagnostic: { code: "cli.input.invalid" },
    });
    const presented: unknown[] = [];
    await expect(
      services.configureDestination({
        ...configureInput,
        apply: true,
        presentPlan: (value) => {
          presented.push(value);
          return Promise.resolve();
        },
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: {
        applied: true,
        connection: { name: "local-history", transport: "local" },
        state: "configured",
      },
    });
    expect(presented).toHaveLength(1);
    const doctor = await services.doctor({ fix: false, presentPlan });
    expect(doctor.status).toBe("success");
    if (doctor.status !== "success") throw new Error("test.invalid");
    const localFinding = doctor.value.findings.find(
      ({ code }) => code === "doctor.destination.local-resource.available",
    );
    expect(localFinding?.evidence.localResource).toEqual({
      backupState: "available",
      databaseDerivedRetention: {
        clockContinuity: "unavailable",
        cutoff: "unavailable",
        payloadBytes: "unavailable",
        rowCount: "unavailable",
      },
      databaseState: "present",
      lifecycleState: "clean",
      publishedBackupCount: 0,
      retentionPolicy: {
        maximumAgeNanoseconds: "2592000000000000",
        maximumPayloadBytes: 1_073_741_824,
        maximumTraceCount: 100_000,
        physicalCleanupTrigger: "next-authorized-mutation",
      },
      sharedLeaseCount: 0,
    });
    await expect(
      services.unconfigureDestination({ name: "local-history" }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: false, state: "planned" },
    });
    await expect(
      services.unconfigureDestination({
        apply: true,
        name: "local-history",
      }),
    ).resolves.toMatchObject({
      diagnostic: { code: "cli.input.invalid" },
    });
    const unconfigured = await services.unconfigureDestination({
      apply: true,
      name: "local-history",
      presentPlan,
    });
    expect(unconfigured).toMatchObject({
      status: "success",
      value: { applied: true, state: "retained" },
    });
    if (unconfigured.status !== "success") throw new Error("test.invalid");
    const selector = unconfigured.value.retainedDeleteSelector;
    if (selector === null) throw new Error("test.invalid");
    const fresh = fixture.createServices();
    await expect(
      fresh.deleteDestination({ confirm: false, name: selector }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: false, deleted: false, state: "planned" },
    });
    await expect(
      fresh.deleteDestination({ confirm: true, name: selector }),
    ).resolves.toMatchObject({
      diagnostic: { code: "cli.input.invalid" },
    });
    await expect(
      fresh.deleteDestination({
        confirm: true,
        name: selector,
        presentPlan,
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: true, deleted: true, state: "deleted" },
    });
    expect(fixture.events).toEqual([
      "inspect:configure",
      "inspect:configure",
      "inspect:configure",
      "apply:configure",
      "inspect:unconfigure",
      "inspect:unconfigure",
      "inspect:unconfigure",
      "apply:unconfigure",
      "apply:delete",
    ]);
  });

  it("requires explicit recovery after an outcome-unknown lifecycle apply", async () => {
    const fixture = await localLifecycleFixture(
      "agentscope-cli-local-recover-",
    );
    const services = fixture.createServices();
    await services.init({ apply: true, presentPlan });
    await expect(
      services.recoverDestinationLifecycle({ apply: false, presentPlan }),
    ).resolves.toMatchObject({
      diagnostic: { code: "configuration.missing" },
      status: "failure",
    });
    fixture.failNextApplyAfterCommit();
    await expect(
      services.configureDestination({
        apply: true,
        credentialEnvironment: [],
        name: "local-history",
        presentPlan,
        settingsJson: '{"project":"agentscope"}',
        type: "cli-local",
      }),
    ).resolves.toMatchObject({
      diagnostic: { code: "destination.lifecycle-outcome-unknown" },
    });
    const fresh = fixture.createServices();
    await expect(
      fresh.recoverDestinationLifecycle({ apply: false, presentPlan }),
    ).resolves.toMatchObject({
      status: "success",
      value: {
        applied: false,
        plan: {
          destinationType: "@agentscope/destination-cli-local",
          expectedGeneration: 0,
          pendingOperation: "configure",
          recoveryStage: "intent",
        },
        state: "planned",
      },
    });
    let presentedValue: unknown;
    const presented = (value: unknown): Promise<void> => {
      presentedValue = value;
      return Promise.resolve();
    };
    await expect(
      fresh.recoverDestinationLifecycle({
        apply: true,
        presentPlan: presented,
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: {
        applied: true,
        plan: {
          destinationType: "@agentscope/destination-cli-local",
          expectedGeneration: 0,
          pendingOperation: "configure",
          recoveryStage: "intent",
        },
        state: "configured",
      },
    });
    expect(presentedValue).toMatchObject({
      applied: false,
      plan: { pendingOperation: "configure" },
      state: "planned",
    });
    expect(fixture.events).toContain("recover:configure");
  });

  it("maps a package-owned busy refusal without configuration commit", async () => {
    const fixture = await localLifecycleFixture("agentscope-cli-local-busy-");
    const services = fixture.createServices();
    await services.init({ apply: true, presentPlan });
    fixture.failNextApplyBusy();
    await expect(
      services.configureDestination({
        apply: true,
        credentialEnvironment: [],
        name: "local-history",
        presentPlan,
        settingsJson: '{"project":"agentscope"}',
        type: "cli-local",
      }),
    ).resolves.toMatchObject({
      diagnostic: { code: "destination.lifecycle-busy" },
    });
  });

  it("maps a package-owned reconciliation refusal without configuration commit", async () => {
    const fixture = await localLifecycleFixture(
      "agentscope-cli-local-reconciliation-",
    );
    const services = fixture.createServices();
    await services.init({ apply: true, presentPlan });
    fixture.failNextApplyReconciliation();
    await expect(
      services.configureDestination({
        apply: true,
        credentialEnvironment: [],
        name: "local-history",
        presentPlan,
        settingsJson: '{"project":"agentscope"}',
        type: "cli-local",
      }),
    ).resolves.toMatchObject({
      diagnostic: { code: "destination.lifecycle-reconciliation-required" },
    });
  });
});
