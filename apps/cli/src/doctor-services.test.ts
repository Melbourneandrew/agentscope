import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileCredentialBackendRegistry,
  createCiEnvironmentCredentialAdapter,
  createCredentialResolutionContext,
  createOperationalStateStore,
} from "@agentscope/core";
import {
  createAgentscopeHomeResolver,
  configureDestinationConnection,
  createConfigurationManagementRuntime,
  createConfigurationProcessIdentity,
  createConfigurationStore,
  initializeAgentscopeConfiguration,
} from "@agentscope/core/configuration-management";
import {
  createDestinationReporter,
  createReporterReceipt,
  defineDestinationReachabilityProbe,
} from "@agentscope/destinations-core";
import {
  compileDestinationRegistry,
  defineDestinationDescriptor,
} from "@agentscope/destinations-core/configuration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { CliHarnessServices } from "./harness-commands.js";
import {
  createDoctorCliServices,
  type CreateDoctorCliServicesInput,
} from "./doctor-services.js";

// AC-DOC-001.4 AC-DOC-001.6 AC-DOC-001.7 AC-DOC-002.1 AC-DOC-002.2

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
const registry = compileDestinationRegistry([descriptor]);
const owner = createConfigurationProcessIdentity(
  process.pid,
  `process-start-v1-${"d".repeat(64)}`,
);
const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

const emptyHarnessServices = (): CliHarnessServices => ({
  installHarness: () => {
    throw new Error("unreachable");
  },
  listHarnesses: () => ({ status: "success", value: { harnesses: [] } }),
  migrateHarness: () => {
    throw new Error("unreachable");
  },
  statusHarness: () => {
    throw new Error("unreachable");
  },
  uninstallHarness: () => {
    throw new Error("unreachable");
  },
});

const fixture = async (
  overrides: Partial<CreateDoctorCliServicesInput> = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "agentscope-cli-doctor-"));
  roots.push(root);
  const home = createAgentscopeHomeResolver({
    environment: { AGENTSCOPE_HOME: root },
    environmentOverrideAuthority: "test",
    platform: process.platform,
  })();
  const configurationStore = createConfigurationStore(home, registry);
  const operationalStateStore = createOperationalStateStore(home, owner);
  const input: CreateDoctorCliServicesInput = {
    configurationStore,
    credentialRegistry: compileCredentialBackendRegistry([
      createCiEnvironmentCredentialAdapter({}),
    ]),
    credentialResolutionContext: createCredentialResolutionContext(
      "interactive",
      new AbortController().signal,
    ),
    gitInspector: () =>
      Promise.resolve({
        head: "unavailable",
        repository: "unavailable",
        workspace: "available",
      }),
    harnessServices: emptyHarnessServices(),
    operationalStateStore,
    ownerState: () => "dead",
    ...overrides,
  };
  return {
    configurationStore,
    home,
    input,
    services: createDoctorCliServices(input),
  };
};

const inspect = async (value: Awaited<ReturnType<typeof fixture>>) => {
  const result = await value.services.doctor({
    fix: false,
    presentPlan: () => Promise.reject(new Error("unreachable")),
  });
  expect(result.status).toBe("success");
  if (result.status !== "success") throw new Error("unreachable");
  return result.value;
};

const configureFixtureConnection = async (
  value: Awaited<ReturnType<typeof fixture>>,
) => {
  const management = createConfigurationManagementRuntime(
    registry,
    value.configurationStore,
    owner,
  );
  await initializeAgentscopeConfiguration(management);
  await configureDestinationConnection(management, {
    commandName: "example",
    credentialReferences: {},
    name: "fixture",
    settings: { project: "fixture" },
  });
};

describe("Doctor CLI composition", () => {
  it("declares unavailable harness and destination inspection for empty registries", async () => {
    const report = await inspect(await fixture());

    const harness = report.findings.find(
      ({ code }) => code === "doctor.harness.unavailable",
    );
    const destination = report.findings.find(
      ({ code }) => code === "doctor.destination.unavailable",
    );
    expect(harness?.evidence).toMatchObject({
      count: 0,
      freshness: "unavailable",
    });
    expect(destination?.evidence).toMatchObject({
      count: 0,
      freshness: "unavailable",
    });
  });

  it("composes missing state, retained-health absence, and unavailable Git", async () => {
    const value = await fixture({
      gitInspector: () => Promise.reject(new Error("CANARY_SECRET")),
      harnessServices: {
        ...emptyHarnessServices(),
        listHarnesses: () => ({
          diagnostic: { category: "unavailable", code: "harness.unavailable" },
          status: "failure",
        }),
      },
    });
    const report = await inspect(value);

    expect(report.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "doctor.configuration.missing",
        "doctor.pipeline-health.absent",
        "doctor.harness.unavailable",
        "doctor.git.workspace-unavailable",
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("CANARY_SECRET");
    expect(report.fixed).toBe(false);
  });

  it("maps every harness discovery and owned-hook disposition", async () => {
    const states = [
      ["installed", "1.2.3", "unchanged"],
      ["absent", null, "ready"],
      ["unsupported", "2.0.0", "conflict"],
      ["indeterminate", null, "unavailable"],
    ] as const;
    const harnessServices: CliHarnessServices = {
      ...emptyHarnessServices(),
      listHarnesses: () => ({
        status: "success",
        value: {
          harnesses: states.map(([state, version], index) => ({
            configurationLocationCount: 1,
            configurationPresentCount: state === "installed" ? 1 : 0,
            harness: `fixture-${index}`,
            harnessType: `@agentscope/harness-fixture-${index}`,
            reason:
              state === "installed"
                ? "compatible"
                : state === "absent"
                  ? "not-found"
                  : state === "unsupported"
                    ? "version-unsupported"
                    : "probe-unavailable",
            state,
            version,
          })),
        },
      }),
      statusHarness: ({ harness }) => {
        const index = Number(harness.slice("fixture-".length));
        const disposition = states[index]?.[2];
        return disposition === "unavailable"
          ? {
              diagnostic: {
                category: "unavailable",
                code: "harness.unavailable",
              },
              status: "failure",
            }
          : {
              status: "success",
              value: {
                discovery: {
                  configurationLocationCount: 1,
                  configurationPresentCount: 1,
                  harness,
                  harnessType: `@agentscope/harness-${harness}`,
                  reason: "compatible",
                  state: "installed",
                  version: "1.2.3",
                },
                installation: disposition!,
              },
            };
      },
    };
    const report = await inspect(await fixture({ harnessServices }));

    expect(report.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "doctor.harness.installed",
        "doctor.harness.absent",
        "doctor.harness.unsupported",
        "doctor.harness.indeterminate",
        "doctor.hook.unchanged",
        "doctor.hook.ready",
        "doctor.hook.conflict",
        "doctor.hook.unavailable",
      ]),
    );
  });
});

describe("Doctor destination composition", () => {
  it("runs a bounded declared reachability probe for one configured connection", async () => {
    const probes: unknown[] = [];
    const value = await fixture({
      reachabilityProbes: [
        defineDestinationReachabilityProbe({
          destinationType: descriptor.destinationType,
          inspect: ({ connectionId, signal }) => {
            probes.push({ connectionId, signal });
            return Promise.resolve("available");
          },
        }),
      ],
    });
    await configureFixtureConnection(value);
    const report = await inspect(value);

    expect(probes).toHaveLength(1);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "doctor.destination.available" }),
    );
    const unsupported = createDoctorCliServices({
      ...value.input,
      reachabilityProbes: [],
    });
    const unsupportedResult = await unsupported.doctor({
      fix: false,
      presentPlan: () => Promise.reject(new Error("unreachable")),
    });
    expect(unsupportedResult.status).toBe("success");
    if (unsupportedResult.status !== "success") throw new Error("unreachable");
    expect(unsupportedResult.value.findings.map(({ code }) => code)).toContain(
      "doctor.destination.probe-unsupported",
    );
  });

  it("contains throwing, rejecting, and hanging destination probes", async () => {
    const cases = [
      () => {
        throw new Error("CANARY_SYNC");
      },
      () => Promise.reject(new Error("CANARY_REJECT")),
      () => new Promise<"available">(() => undefined),
      () => Promise.resolve("provider-secret" as never),
    ];
    for (const probe of cases) {
      const value = await fixture({
        reachabilityProbes: [
          defineDestinationReachabilityProbe({
            destinationType: descriptor.destinationType,
            inspect: probe,
          }),
        ],
      });
      await configureFixtureConnection(value);
      const report = await inspect(value);
      expect(report.findings).toContainEqual(
        expect.objectContaining({ code: "doctor.destination.unavailable" }),
      );
      expect(JSON.stringify(report)).not.toContain("CANARY");
      expect(JSON.stringify(report)).not.toContain("provider-secret");
    }
  }, 10_000);
});

describe("Doctor retained and Git evidence", () => {
  it("reports unavailable pipeline evidence when the retained document is malformed", async () => {
    const value = await fixture();
    await mkdir(value.home.healthDirectory, { recursive: true });
    await writeFile(
      join(value.home.healthDirectory, "operational-state-v1.json"),
      "{}\n",
    );
    const report = await inspect(value);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "doctor.pipeline-health.unavailable" }),
    );
  });

  it("summarizes retained pipeline evidence and its explicit loss count", async () => {
    const value = await fixture();
    await mkdir(value.home.healthDirectory, { recursive: true });
    await writeFile(
      join(value.home.healthDirectory, "operational-state-v1.json"),
      `${JSON.stringify({
        version: 1,
        nextSequence: 1,
        losses: { diagnostics: 0, health: 2, checkpoints: 0 },
        diagnostics: [],
        health: [
          {
            scope: "hook",
            stage: "remote-acceptance",
            outcome: "accepted",
            configurationGeneration: 1,
            policyMode: "baseline",
            receipt: null,
            sequence: 0,
            observedAtUnixMilliseconds: 1,
          },
        ],
        checkpoints: [],
      })}\n`,
    );
    const report = await inspect(value);
    const retained = report.findings.find(
      ({ code }) => code === "doctor.pipeline-health.retained",
    );
    expect(retained?.evidence).toMatchObject({ count: 1, lossCount: 2 });
  });

  it("classifies branch, detached, and unavailable repository states", async () => {
    for (const git of [
      { head: "branch", repository: "available", workspace: "available" },
      { head: "detached", repository: "available", workspace: "available" },
      {
        head: "unavailable",
        repository: "unavailable",
        workspace: "available",
      },
    ] as const) {
      const report = await inspect(
        await fixture({ gitInspector: () => Promise.resolve(git) }),
      );
      expect(report.findings).toContainEqual(
        expect.objectContaining({
          code: `doctor.git.${
            git.repository === "unavailable"
              ? "repository-unavailable"
              : git.head === "detached"
                ? "detached"
                : "available"
          }`,
        }),
      );
    }
  });
});

describe("Doctor safe repair authority", () => {
  it("plans, applies, and re-inspects only a dead-owner operational lock", async () => {
    const value = await fixture();
    await mkdir(value.home.healthDirectory, { recursive: true });
    const lock = join(value.home.healthDirectory, "operational-state.lock");
    await writeFile(
      lock,
      `${JSON.stringify({
        version: 1,
        owner: {
          processId: 2_147_483_000,
          processStartIdentity: `process-start-v1-${"a".repeat(64)}`,
        },
        token: "b".repeat(32),
      })}\n`,
    );
    const plans: unknown[] = [];
    const result = await value.services.doctor({
      fix: true,
      presentPlan: (plan) => {
        plans.push(plan);
        return Promise.resolve();
      },
    });

    expect(result).toMatchObject({
      status: "success",
      value: {
        fixed: true,
        repairs: [
          { action: "repair-operational-state-lock", state: "applied" },
        ],
      },
    });
    expect(plans).toHaveLength(1);
    await expect(unlink(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a repair that becomes unavailable after its exact plan", async () => {
    const value = await fixture();
    await mkdir(value.home.healthDirectory, { recursive: true });
    const lock = join(value.home.healthDirectory, "operational-state.lock");
    await writeFile(
      lock,
      `${JSON.stringify({
        version: 1,
        owner: {
          processId: 2_147_483_000,
          processStartIdentity: `process-start-v1-${"a".repeat(64)}`,
        },
        token: "c".repeat(32),
      })}\n`,
    );
    const result = await value.services.doctor({
      fix: true,
      presentPlan: async () => unlink(lock),
    });

    expect(result).toMatchObject({
      status: "success",
      value: {
        fixed: false,
        repairs: [
          { action: "repair-operational-state-lock", state: "unavailable" },
        ],
      },
    });
  });
});

describe("Doctor probe registration boundary", () => {
  const registered = defineDestinationReachabilityProbe({
    destinationType: "@agentscope/destination-example",
    inspect: () => Promise.resolve("available"),
  });
  it.each([
    null,
    new Array(33).fill(registered),
    new Array(1),
    [{ destinationType: "x", inspect: 1 }],
    [{ inspect: () => Promise.resolve("available") }],
    [registered, registered],
    Object.assign([registered], { extra: true }),
  ])("rejects malformed probe registries", async (reachabilityProbes) => {
    const value = await fixture();
    expect(() =>
      createDoctorCliServices({
        ...value.input,
        reachabilityProbes: reachabilityProbes as never,
      }),
    ).toThrow("cli.doctor.invalid");
  });
});
