import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileHarnessRegistry,
  defineHarnessDescriptor,
  type HarnessDiscoveryProbe,
  type HarnessInstallationPlanner,
} from "@agentscope/harnesses-core/cli-management";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHarnessCliServices,
  type CliHarnessAdapter,
} from "./harness-services.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const descriptor = defineHarnessDescriptor({
  compatibility: [
    {
      evidenceSlot: "stable-v1",
      maximumExclusive: "2.0.0",
      minimumInclusive: "1.0.0",
    },
  ],
  configuration: { locationSegments: [["example", "config.json"]] },
  descriptorVersion: 1,
  executable: {
    names: ["example"],
    versionArguments: ["--version"],
    versionPrefix: "example ",
    versionSuffix: "",
  },
  harnessType: "@agentscope/harness-example",
  nativeSource: { continuityVersion: 1, sourceKind: "example-session" },
});
const registry = compileHarnessRegistry([descriptor], {
  entries: [
    {
      contractSuiteDigest: `sha256-${"a".repeat(64)}`,
      evidenceSlot: "stable-v1",
      harnessType: descriptor.harnessType,
      realScenarioDigest: `sha256-${"b".repeat(64)}`,
      testedVersion: "1.2.0",
    },
  ],
  manifestVersion: 1,
});

const owned = new TextEncoder().encode("agentscope-owned-hook");
const vendor = "vendor-observability-hook";
const presentPlan = (): Promise<void> => Promise.resolve();

const planner =
  (
    operation: "install" | "migrate" | "uninstall",
  ): HarnessInstallationPlanner =>
  (target) => {
    const text = target.bytes
      ? new TextDecoder().decode(target.bytes)
      : undefined;
    if (operation === "uninstall")
      return text === "agentscope-owned-hook"
        ? { kind: "remove" }
        : { kind: "unchanged" };
    if (!target.exists) return { bytes: owned, kind: "replace" };
    if (text === "agentscope-owned-hook") return { kind: "unchanged" };
    if (text === vendor) return { bytes: owned, kind: "replace-overlap" };
    return { kind: "unsupported" };
  };

const probe = (version = "1.2.0"): HarnessDiscoveryProbe => ({
  inspectConfiguration: () =>
    Promise.resolve([{ locationIndex: 0, present: true }]),
  locateExecutable: () =>
    Promise.resolve({
      candidates: [{ path: "/opt/example/bin/example" }],
      kind: "found",
    }),
  readVersion: () =>
    Promise.resolve({ kind: "observed", output: `example ${version}` }),
});

const fixture = async (version = "1.2.0") => {
  const root = await mkdtemp(join(tmpdir(), "agentscope-cli-harness-"));
  roots.push(root);
  const targetPath = join(root, "config.json");
  const manifestPath = (operation: "install" | "migrate" | "uninstall") =>
    join(root, `${operation}.json`);
  const adapter: CliHarnessAdapter = {
    commandName: "example",
    createInstallationInput: (operation) => ({
      manifestPath: manifestPath(operation),
      operation,
      planner: planner(operation),
      targetPaths: [targetPath],
    }),
    harnessType: descriptor.harnessType,
    probe: probe(version),
  };
  return {
    adapter,
    manifestPath: manifestPath("install"),
    root,
    services: createHarnessCliServices({ adapters: [adapter], registry }),
    targetPath,
  };
};

describe("harness CLI composition", () => {
  it("discovers registered harnesses without exposing paths", async () => {
    const value = await fixture();
    await expect(value.services.listHarnesses()).resolves.toEqual({
      status: "success",
      value: {
        harnesses: [
          {
            configurationLocationCount: 1,
            configurationPresentCount: 1,
            harness: "example",
            harnessType: "@agentscope/harness-example",
            reason: "compatible",
            state: "installed",
            version: "1.2.0",
          },
        ],
      },
    });
    expect(JSON.stringify(await value.services.listHarnesses())).not.toContain(
      value.root,
    );
  });
});

describe("harness CLI plan-first mutation", () => {
  it("keeps install and uninstall plan-first and mutates only with --yes authority", async () => {
    const value = await fixture();
    const presentedInstall = vi.fn(async () => {
      await expect(readFile(value.targetPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
    await expect(
      value.services.installHarness({
        apply: false,
        harness: "example",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: false, disposition: "ready" },
    });
    await expect(readFile(value.targetPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      value.services.installHarness({
        apply: true,
        harness: "example",
        presentPlan: presentedInstall,
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: true, disposition: "committed" },
    });
    await expect(readFile(value.targetPath, "utf8")).resolves.toBe(
      "agentscope-owned-hook",
    );
    expect(presentedInstall).toHaveBeenCalledWith(
      expect.objectContaining({ applied: false, disposition: "ready" }),
    );
    await expect(
      value.services.statusHarness({ harness: "example" }),
    ).resolves.toMatchObject({
      status: "success",
      value: { installation: "unchanged" },
    });
    await expect(
      value.services.uninstallHarness({
        apply: false,
        harness: "example",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: false, disposition: "ready" },
    });
    await expect(readFile(value.targetPath, "utf8")).resolves.toBe(
      "agentscope-owned-hook",
    );
    await expect(
      value.services.uninstallHarness({
        apply: true,
        harness: "example",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: true, disposition: "committed" },
    });
    await expect(readFile(value.targetPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never grants overlap replacement to ordinary install", async () => {
    const value = await fixture();
    await writeFile(value.targetPath, vendor);
    await expect(
      value.services.installHarness({
        apply: true,
        harness: "example",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      diagnostic: { code: "harness.overlap-conflict" },
      status: "partial",
      value: { applied: false, disposition: "conflict" },
    });
    await expect(readFile(value.targetPath, "utf8")).resolves.toBe(vendor);
    await expect(
      value.services.migrateHarness({
        apply: false,
        harness: "example",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: false, disposition: "ready" },
    });
    await expect(readFile(value.targetPath, "utf8")).resolves.toBe(vendor);
    await expect(
      value.services.migrateHarness({
        apply: true,
        harness: "example",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: true, disposition: "committed" },
    });
    await expect(readFile(value.targetPath, "utf8")).resolves.toBe(
      "agentscope-owned-hook",
    );
  });
});

describe("harness CLI state classification", () => {
  it("preserves unsupported, missing, and recovery-required distinctions", async () => {
    const unsupported = await fixture("2.0.0");
    await expect(
      unsupported.services.installHarness({
        apply: true,
        harness: "example",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      diagnostic: { code: "harness.version-unsupported" },
      status: "failure",
    });
    await expect(
      unsupported.services.installHarness({
        apply: true,
        harness: "missing",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      diagnostic: { code: "harness.adapter-missing" },
      status: "failure",
    });
    const recovery = await fixture();
    await writeFile(recovery.manifestPath, "interrupted");
    await expect(
      recovery.services.installHarness({
        apply: true,
        harness: "example",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      diagnostic: { code: "harness.recovery-required" },
      status: "partial",
      value: { applied: false, disposition: "recovery-required" },
    });

    await writeFile(recovery.targetPath, "unknown-native-format");
    await rm(recovery.manifestPath, { force: true });
    await expect(
      recovery.services.installHarness({
        apply: false,
        harness: "example",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      diagnostic: { code: "harness.installation-unsupported" },
      status: "partial",
      value: { disposition: "unsupported" },
    });
  });

  it("maps absent and indeterminate discovery before installation planning", async () => {
    const value = await fixture();
    const absent: CliHarnessAdapter = {
      ...value.adapter,
      probe: {
        ...probe(),
        locateExecutable: () => Promise.resolve({ kind: "absent" }),
      },
    };
    await expect(
      createHarnessCliServices({ adapters: [absent], registry }).installHarness(
        { apply: true, harness: "example", presentPlan },
      ),
    ).resolves.toMatchObject({
      diagnostic: { code: "harness.absent" },
      status: "failure",
    });
    const indeterminate: CliHarnessAdapter = {
      ...value.adapter,
      probe: {
        ...probe(),
        locateExecutable: () => Promise.resolve({ kind: "unavailable" }),
      },
    };
    await expect(
      createHarnessCliServices({
        adapters: [indeterminate],
        registry,
      }).migrateHarness({ apply: true, harness: "example", presentPlan }),
    ).resolves.toMatchObject({
      diagnostic: { code: "harness.discovery-indeterminate" },
      status: "failure",
    });
  });
});

describe("harness CLI failure containment", () => {
  it("contains invalid factories and post-plan concurrent edits", async () => {
    const value = await fixture();
    const invalid: CliHarnessAdapter = {
      ...value.adapter,
      createInstallationInput: () =>
        ({
          manifestPath: "relative",
          operation: "install",
          planner: planner("install"),
          targetPaths: ["relative"],
        }) as never,
    };
    await expect(
      createHarnessCliServices({
        adapters: [invalid],
        registry,
      }).installHarness({ apply: false, harness: "example", presentPlan }),
    ).resolves.toMatchObject({
      diagnostic: { code: "harness.plan-invalid" },
      status: "partial",
      value: { disposition: "invalid" },
    });

    await writeFile(value.targetPath, vendor);
    const authoritySwap: CliHarnessAdapter = {
      ...value.adapter,
      createInstallationInput: () => ({
        manifestPath: join(value.root, "authority-swap.json"),
        operation: "migrate",
        planner: planner("migrate"),
        targetPaths: [value.targetPath],
      }),
    };
    await expect(
      createHarnessCliServices({
        adapters: [authoritySwap],
        registry,
      }).installHarness({ apply: true, harness: "example", presentPlan }),
    ).resolves.toEqual({
      diagnostic: { category: "unavailable", code: "harness.plan-invalid" },
      status: "failure",
    });
    await expect(readFile(value.targetPath, "utf8")).resolves.toBe(vendor);
    await rm(value.targetPath);

    const throwing: CliHarnessAdapter = {
      ...value.adapter,
      createInstallationInput: () => {
        throw new Error("CANARY_SECRET");
      },
    };
    const throwingServices = createHarnessCliServices({
      adapters: [throwing],
      registry,
    });
    await expect(
      throwingServices.uninstallHarness({
        apply: true,
        harness: "example",
        presentPlan,
      }),
    ).resolves.toEqual({
      diagnostic: { category: "unavailable", code: "harness.plan-invalid" },
      status: "failure",
    });
    await expect(
      throwingServices.statusHarness({ harness: "example" }),
    ).resolves.toEqual({
      diagnostic: { category: "unavailable", code: "harness.unavailable" },
      status: "failure",
    });

    const concurrent: CliHarnessAdapter = {
      ...value.adapter,
      createInstallationInput: (operation) => ({
        manifestPath: join(value.root, "concurrent.json"),
        operation,
        planner: () => {
          writeFileSync(value.targetPath, "concurrent-vendor-edit");
          return { bytes: owned, kind: "replace" };
        },
        targetPaths: [value.targetPath],
      }),
    };
    await expect(
      createHarnessCliServices({
        adapters: [concurrent],
        registry,
      }).installHarness({ apply: true, harness: "example", presentPlan }),
    ).resolves.toMatchObject({
      diagnostic: { code: "harness.overlap-conflict" },
      status: "partial",
      value: { applied: false, disposition: "conflict" },
    });
  });
});

describe("harness CLI authority boundaries", () => {
  it("supports an intentionally empty production registry", async () => {
    await expect(createHarnessCliServices().listHarnesses()).resolves.toEqual({
      status: "success",
      value: { harnesses: [] },
    });
  });

  it("returns a fixed not-found status for unregistered names", async () => {
    await expect(
      createHarnessCliServices().statusHarness({ harness: "missing" }),
    ).resolves.toEqual({
      diagnostic: { category: "not-found", code: "harness.adapter-missing" },
      status: "failure",
    });
  });

  it("rejects accessor-backed adapters before invoking them", () => {
    const candidate = {
      commandName: "example",
      createInstallationInput: vi.fn(),
      harnessType: descriptor.harnessType,
      probe: probe(),
    };
    let reads = 0;
    Object.defineProperty(candidate, "probe", {
      enumerable: true,
      get() {
        reads += 1;
        return probe();
      },
    });
    expect(() =>
      createHarnessCliServices({
        adapters: [candidate as never],
        registry,
      }),
    ).toThrow("cli.harness.invalid");
    expect(reads).toBe(0);

    const plain: CliHarnessAdapter = {
      commandName: "example",
      createInstallationInput: () => ({
        manifestPath: "/tmp/agentscope-cli-harness.json",
        operation: "install",
        planner: planner("install"),
        targetPaths: ["/tmp/agentscope-cli-harness-target"],
      }),
      harnessType: descriptor.harnessType,
      probe: probe(),
    };
    expect(() => createHarnessCliServices({ adapters: [plain] })).toThrow(
      "cli.harness.invalid",
    );
    expect(() =>
      createHarnessCliServices({ adapters: [plain, plain], registry }),
    ).toThrow("cli.harness.invalid");
    expect(() =>
      createHarnessCliServices({
        adapters: [
          { ...plain, probe: { ...probe(), readVersion: 1 } } as never,
        ],
        registry,
      }),
    ).toThrow("cli.harness.invalid");
  });
});
