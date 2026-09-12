import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createAgentscopeHomeResolver } from "@agentscope/core/configuration-management";
import { afterEach, describe, expect, it } from "vitest";

import { createHarnessCliServices } from "./harness-services.js";
import { createProductHarnessInstallationInput } from "./product-harness-installation.js";
import {
  type CodexDiscoveryPolicy,
  createProductHarnesses,
  productHarnessParentDirectoryForTesting,
} from "./product-harnesses.js";

const wrapperBytes = Buffer.from(
  "#!/usr/bin/env node\n// synthetic wrapper fixture\n",
);
const wrapperManifestBytes = Buffer.from(
  '{"name":"@openai/codex","version":"0.149.1"}\n',
);
const platformManifestBytes = Buffer.from(
  '{"name":"@openai/codex","version":"0.149.1-test-platform"}\n',
);
const nativeBytes = Buffer.from("synthetic native Codex fixture\n");
const fileIdentity = (bytes: Uint8Array) =>
  Object.freeze({
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
const testDiscoveryPolicy: CodexDiscoveryPolicy = Object.freeze({
  platforms: Object.freeze({
    "darwin-arm64": Object.freeze({
      dependency: "@openai/codex-test-platform",
      executable: fileIdentity(nativeBytes),
      manifest: fileIdentity(platformManifestBytes),
      packageVersion: "0.149.1-test-platform",
      triple: "test-triple",
    }),
  }),
  version: "0.149.1",
  wrapper: fileIdentity(wrapperBytes),
  wrapperManifest: fileIdentity(wrapperManifestBytes),
});

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

const fixture = async (pathEntries = 1, releaseIdentity = "0.1.0") => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agentscope-product-harness-")),
  );
  roots.push(root);
  const vendorHome = join(root, "vendor-home");
  const agentscopeRoot = join(root, "agentscope-home");
  const home = createAgentscopeHomeResolver({
    environment: { AGENTSCOPE_HOME: agentscopeRoot },
    environmentOverrideAuthority: "test",
    platform: process.platform,
  })();
  await mkdir(home.launcherDirectory, { mode: 0o700, recursive: true });
  await mkdir(home.mutationDirectory, { mode: 0o700, recursive: true });
  await mkdir(productHarnessParentDirectoryForTesting(vendorHome), {
    mode: 0o700,
    recursive: true,
  });
  const directories: string[] = [];
  const codexManifests: string[] = [];
  const codexNativeExecutables: string[] = [];
  const codexPlatformManifests: string[] = [];
  for (let index = 0; index < pathEntries; index += 1) {
    const directory = join(root, `bin-${index}`);
    const scopeRoot = join(
      root,
      `packages-${index}`,
      "node_modules",
      "@openai",
    );
    const packageRoot = join(scopeRoot, "codex");
    const packageBin = join(packageRoot, "bin");
    const platformPackage = join(scopeRoot, "codex-test-platform");
    const platformBin = join(platformPackage, "vendor", "test-triple", "bin");
    await mkdir(directory, { mode: 0o700 });
    await mkdir(packageBin, { mode: 0o700, recursive: true });
    await mkdir(platformBin, { mode: 0o700, recursive: true });
    const executable = join(packageBin, "codex.js");
    await writeFile(executable, wrapperBytes);
    await chmod(executable, 0o755);
    const manifest = join(packageRoot, "package.json");
    await writeFile(manifest, wrapperManifestBytes);
    await chmod(manifest, 0o644);
    const platformManifest = join(platformPackage, "package.json");
    await writeFile(platformManifest, platformManifestBytes, { mode: 0o644 });
    const nativeExecutable = join(platformBin, "codex");
    await writeFile(nativeExecutable, nativeBytes, { mode: 0o755 });
    await symlink(executable, join(directory, "codex"));
    directories.push(directory);
    codexManifests.push(manifest);
    codexNativeExecutables.push(nativeExecutable);
    codexPlatformManifests.push(platformManifest);
  }
  const machineEntryPath = join(root, "agentscope-hook-machine.js");
  await writeFile(machineEntryPath, "export {};\n", { mode: 0o600 });
  const input = createProductHarnesses({
    architecture: "arm64",
    codexDiscoveryPolicy: testDiscoveryPolicy,
    environment: { PATH: directories.join(":") },
    home,
    homeDirectory: vendorHome,
    installationFactory: createProductHarnessInstallationInput,
    machineEntryPath,
    nodeExecutable: process.execPath,
    platform: "darwin",
    readHookDeadlineMilliseconds: () => Promise.resolve(2_000),
    releaseIdentity,
  });
  return {
    agentscopeRoot,
    codexExecutables: directories.map((directory) => join(directory, "codex")),
    codexManifests,
    codexNativeExecutables,
    codexPlatformManifests,
    home,
    input,
    machineEntryPath,
    services: createHarnessCliServices(input),
    vendorHome,
  };
};

// eslint-disable-next-line max-lines-per-function -- one lifecycle suite proves the closed product adapter from discovery through removal.
describe("packed CLI Codex product composition", () => {
  it("discovers exactly one compatible Codex executable and known configuration", async () => {
    const value = await fixture();
    await writeFile(join(value.vendorHome, ".codex", "config.toml"), "");
    await expect(value.services.listHarnesses()).resolves.toMatchObject({
      status: "success",
      value: { harnesses: [{ reason: "compatible", version: "0.149.1" }] },
    });
    const executionMarker = join(value.vendorHome, "version-probe-executed");
    await writeFile(
      await realpath(value.codexExecutables[0]!),
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(executionMarker)}, "bad");\n`,
      { mode: 0o755 },
    );
    await expect(value.services.listHarnesses()).resolves.toMatchObject({
      status: "success",
      value: {
        harnesses: [{ reason: "version-unavailable", state: "indeterminate" }],
      },
    });
    await expect(lstat(executionMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects ambiguous executables and ambient current-directory PATH entries", async () => {
    const ambiguous = await fixture(2);
    await expect(ambiguous.services.listHarnesses()).resolves.toMatchObject({
      status: "success",
      value: {
        harnesses: [{ reason: "ambiguous-executable", state: "indeterminate" }],
      },
    });
    const invalid = await fixture();
    const machineEntryPath = join(invalid.vendorHome, "machine.js");
    await writeFile(machineEntryPath, "export {};\n");
    const input = createProductHarnesses({
      architecture: "arm64",
      codexDiscoveryPolicy: testDiscoveryPolicy,
      environment: { PATH: ":/usr/bin" },
      home: invalid.home,
      homeDirectory: invalid.vendorHome,
      installationFactory: createProductHarnessInstallationInput,
      machineEntryPath,
      nodeExecutable: process.execPath,
      platform: "darwin",
      readHookDeadlineMilliseconds: () => Promise.resolve(2_000),
      releaseIdentity: "0.1.0",
    });
    await expect(
      createHarnessCliServices(input).listHarnesses(),
    ).resolves.toMatchObject({
      status: "success",
      value: {
        harnesses: [{ reason: "probe-unavailable", state: "indeterminate" }],
      },
    });
  });

  it("closes every bounded ambient PATH and absolute-path input boundary", async () => {
    const value = await fixture();
    const defaulted = createProductHarnesses({
      home: value.home,
      readHookDeadlineMilliseconds: () => Promise.resolve(2_000),
      releaseIdentity: "0.1.0",
    });
    expect(defaulted.registry?.harnessTypes).toEqual([
      "@agentscope/harness-codex",
    ]);
    for (const homeDirectory of [
      "",
      "relative",
      `/${"x".repeat(4_096)}`,
      "/invalid\0home",
    ])
      expect(() =>
        createProductHarnesses({
          architecture: "arm64",
          codexDiscoveryPolicy: testDiscoveryPolicy,
          environment: { PATH: dirname(value.codexExecutables[0]!) },
          home: value.home,
          homeDirectory,
          installationFactory: createProductHarnessInstallationInput,
          machineEntryPath: value.machineEntryPath,
          nodeExecutable: process.execPath,
          platform: "darwin",
          readHookDeadlineMilliseconds: () => Promise.resolve(2_000),
          releaseIdentity: "0.1.0",
        }),
      ).toThrow("cli.harness.probe-unavailable");
    for (const path of [
      "/relative/../entry",
      Array.from({ length: 65 }, (_, index) => `/missing-${index}`).join(":"),
      "x".repeat(65_537),
    ]) {
      const input = createProductHarnesses({
        architecture: "arm64",
        codexDiscoveryPolicy: testDiscoveryPolicy,
        environment: { PATH: path },
        home: value.home,
        homeDirectory: value.vendorHome,
        installationFactory: createProductHarnessInstallationInput,
        machineEntryPath: value.machineEntryPath,
        nodeExecutable: process.execPath,
        platform: "darwin",
        readHookDeadlineMilliseconds: () => Promise.resolve(2_000),
        releaseIdentity: "0.1.0",
      });
      await expect(
        input.adapters![0]!.probe.locateExecutable(["codex"]),
      ).resolves.toEqual({ kind: "unavailable" });
    }
  });

  it("fails closed for malformed package identity and configuration aliases", async () => {
    const value = await fixture();
    const probe = value.input.adapters![0]!.probe;
    await expect(probe.locateExecutable(["other"])).resolves.toEqual({
      kind: "unavailable",
    });
    await expect(
      probe.readVersion(value.codexExecutables[0]!, []),
    ).resolves.toEqual({ kind: "unavailable" });
    await writeFile(value.codexManifests[0]!, '{"name":"substituted"}\n');
    await expect(value.services.listHarnesses()).resolves.toMatchObject({
      value: {
        harnesses: [{ reason: "version-unavailable", state: "indeterminate" }],
      },
    });
    const aliasedConfiguration = join(value.vendorHome, ".codex", "hooks.json");
    await symlink(
      join(value.vendorHome, "missing-hooks.json"),
      aliasedConfiguration,
    );
    await expect(
      probe.inspectConfiguration([
        [".codex", "hooks.json"],
        [".codex", "config.toml"],
      ]),
    ).resolves.toEqual([
      { locationIndex: 0, present: false },
      { locationIndex: 1, present: false },
    ]);
    await expect(probe.inspectConfiguration([["wrong"]])).rejects.toThrow(
      "cli.harness.probe-unavailable",
    );
    await mkdir(aliasedConfiguration).catch(() => undefined);
    await chmod(value.codexExecutables[0]!, 0o600);
    await expect(probe.locateExecutable(["codex"])).resolves.toEqual({
      kind: "absent",
    });
    await chmod(value.codexExecutables[0]!, 0o755);
    await writeFile(
      value.codexManifests[0]!,
      new Uint8Array(65_537).fill(0x20),
    );
    await expect(value.services.listHarnesses()).resolves.toMatchObject({
      value: {
        harnesses: [{ reason: "version-unavailable", state: "indeterminate" }],
      },
    });
  });

  it("rejects aliased or noncanonical installed package manifests", async () => {
    const value = await fixture();
    const replacement = join(value.vendorHome, "substituted-package.json");
    await writeFile(
      replacement,
      `${JSON.stringify({
        bin: { codex: "bin/codex.js" },
        name: "@openai/codex",
        version: "0.149.1",
      })}\n`,
    );
    await rm(value.codexManifests[0]!);
    await symlink(replacement, value.codexManifests[0]!);
    await expect(value.services.listHarnesses()).resolves.toMatchObject({
      value: {
        harnesses: [{ reason: "version-unavailable", state: "indeterminate" }],
      },
    });
  });

  it("rejects substituted platform manifests and native executables", async () => {
    for (const target of ["manifest", "native"] as const) {
      const value = await fixture();
      await writeFile(
        target === "manifest"
          ? value.codexPlatformManifests[0]!
          : value.codexNativeExecutables[0]!,
        "substituted",
      );
      await expect(value.services.listHarnesses()).resolves.toMatchObject({
        value: {
          harnesses: [
            { reason: "version-unavailable", state: "indeterminate" },
          ],
        },
      });
    }
  });

  it("settles special-file package substitutions without opening a writer", async () => {
    for (const target of ["wrapper", "native"] as const) {
      const value = await fixture();
      const path =
        target === "wrapper"
          ? await realpath(value.codexExecutables[0]!)
          : value.codexNativeExecutables[0]!;
      await rm(path);
      execFileSync("/usr/bin/mkfifo", [path], { timeout: 1_000 });
      const started = performance.now();
      await expect(value.services.listHarnesses()).resolves.toMatchObject({
        value: {
          harnesses: [
            {
              state: target === "wrapper" ? "absent" : "indeterminate",
            },
          ],
        },
      });
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });

  it("rejects unavailable launcher platforms and internal installation artifacts", async () => {
    const value = await fixture();
    const windows = createProductHarnesses({
      architecture: "arm64",
      codexDiscoveryPolicy: testDiscoveryPolicy,
      environment: { PATH: dirname(value.codexExecutables[0]!) },
      home: value.home,
      homeDirectory: value.vendorHome,
      installationFactory: createProductHarnessInstallationInput,
      machineEntryPath: value.machineEntryPath,
      nodeExecutable: process.execPath,
      platform: "win32",
      readHookDeadlineMilliseconds: () => Promise.resolve(2_000),
      releaseIdentity: "0.1.0",
    });
    await expect(
      windows.adapters![0]!.createInstallationInput("install"),
    ).rejects.toThrow("cli.launcher.unsupported");
    const missingMachine = createProductHarnesses({
      architecture: "arm64",
      codexDiscoveryPolicy: testDiscoveryPolicy,
      environment: { PATH: dirname(value.codexExecutables[0]!) },
      home: value.home,
      homeDirectory: value.vendorHome,
      installationFactory: createProductHarnessInstallationInput,
      machineEntryPath: join(value.vendorHome, "missing-machine.js"),
      nodeExecutable: process.execPath,
      platform: "darwin",
      readHookDeadlineMilliseconds: () => Promise.resolve(2_000),
      releaseIdentity: "0.1.0",
    });
    await expect(
      missingMachine.adapters![0]!.createInstallationInput("install"),
    ).rejects.toThrow();
    const machineDirectory = join(value.vendorHome, "machine-directory");
    await mkdir(machineDirectory);
    const invalidMachine = createProductHarnesses({
      architecture: "arm64",
      codexDiscoveryPolicy: testDiscoveryPolicy,
      environment: { PATH: dirname(value.codexExecutables[0]!) },
      home: value.home,
      homeDirectory: value.vendorHome,
      installationFactory: createProductHarnessInstallationInput,
      machineEntryPath: machineDirectory,
      nodeExecutable: process.execPath,
      platform: "darwin",
      readHookDeadlineMilliseconds: () => Promise.resolve(2_000),
      releaseIdentity: "0.1.0",
    });
    await expect(
      invalidMachine.adapters![0]!.createInstallationInput("install"),
    ).rejects.toThrow("cli.launcher.unsupported");
    const invalidNode = createProductHarnesses({
      architecture: "arm64",
      codexDiscoveryPolicy: testDiscoveryPolicy,
      environment: { PATH: dirname(value.codexExecutables[0]!) },
      home: value.home,
      homeDirectory: value.vendorHome,
      installationFactory: createProductHarnessInstallationInput,
      machineEntryPath: value.machineEntryPath,
      nodeExecutable: machineDirectory,
      platform: "darwin",
      readHookDeadlineMilliseconds: () => Promise.resolve(2_000),
      releaseIdentity: "0.1.0",
    });
    await expect(
      invalidNode.adapters![0]!.createInstallationInput("install"),
    ).rejects.toThrow("cli.launcher.unsupported");
  });

  it("rejects a substituted internal installation factory", async () => {
    const value = await fixture();
    const substituted = createProductHarnesses({
      architecture: "arm64",
      codexDiscoveryPolicy: testDiscoveryPolicy,
      environment: { PATH: dirname(value.codexExecutables[0]!) },
      home: value.home,
      homeDirectory: value.vendorHome,
      installationFactory: 1 as never,
      machineEntryPath: value.machineEntryPath,
      nodeExecutable: process.execPath,
      platform: "darwin",
      readHookDeadlineMilliseconds: () => Promise.resolve(2_000),
      releaseIdentity: "0.1.0",
    });
    await expect(
      substituted.adapters![0]!.createInstallationInput("install"),
    ).rejects.toThrow("cli.launcher.unsupported");
  });

  it("atomically installs, diagnoses, and removes the owned launcher and Codex block", async () => {
    const value = await fixture();
    const presentPlan = () => Promise.resolve();
    await rm(join(value.vendorHome, ".codex"), {
      force: true,
      recursive: true,
    });
    await expect(
      value.services.uninstallHarness({
        apply: false,
        harness: "codex",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: false, disposition: "unchanged" },
    });
    await expect(
      value.services.installHarness({
        apply: false,
        harness: "codex",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: false, disposition: "ready", targetCount: 3 },
    });
    await expect(lstat(join(value.vendorHome, ".codex"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await expect(
      value.services.installHarness({
        apply: true,
        harness: "codex",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: {
        applied: true,
        changedTargetCount: 3,
        disposition: "committed",
      },
    });
    expect((await lstat(join(value.vendorHome, ".codex"))).mode & 0o777).toBe(
      0o700,
    );
    const launcherNames = await readdir(value.home.launcherDirectory);
    const launcherName = launcherNames.find(
      (name) =>
        name.startsWith("agentscope-hook-v1-") && !name.endsWith(".json"),
    );
    expect(launcherName).toBeDefined();
    const launcherPath = join(value.home.launcherDirectory, launcherName!);
    expect((await lstat(launcherPath)).mode & 0o777).toBe(0o700);
    expect(
      (
        await readFile(join(value.vendorHome, ".codex", "hooks.json"), "utf8")
      ).includes(launcherPath),
    ).toBe(true);
    await expect(
      value.services.statusHarness({ harness: "codex" }),
    ).resolves.toMatchObject({
      status: "success",
      value: { installation: "unchanged" },
    });
    await chmod(launcherPath, 0o600);
    await expect(
      value.services.statusHarness({ harness: "codex" }),
    ).resolves.toMatchObject({
      status: "success",
      value: { installation: "conflict" },
    });
    await chmod(launcherPath, 0o700);
    await writeFile(launcherPath, "substituted", { mode: 0o700 });
    await expect(
      value.services.statusHarness({ harness: "codex" }),
    ).resolves.toMatchObject({
      status: "success",
      value: { installation: "conflict" },
    });
    const input =
      await value.input.adapters![0]!.createInstallationInput("install");
    const launcherDecision = input.planner({
      bytes: null,
      digest: "",
      exists: false,
      mode: null,
      targetPath: input.targetPaths[1]!,
    });
    expect(launcherDecision.kind).toBe("replace");
    if (launcherDecision.kind !== "replace") throw new Error("unreachable");
    await writeFile(launcherPath, launcherDecision.bytes, {
      mode: launcherDecision.mode,
    });
    await expect(
      value.services.uninstallHarness({
        apply: true,
        harness: "codex",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: true, disposition: "committed" },
    });
    await expect(lstat(launcherPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(join(value.vendorHome, ".codex", "hooks.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("authenticates a prior owned release for upgrade and uninstall but rejects downgrade", async () => {
    const value = await fixture(1, "0.0.9");
    const presentPlan = () => Promise.resolve();
    await expect(
      value.services.installHarness({
        apply: true,
        harness: "codex",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: true, disposition: "committed" },
    });
    const upgradedMachine = join(value.vendorHome, "upgraded-machine.js");
    await writeFile(upgradedMachine, "export {};\n", { mode: 0o600 });
    const createAtRelease = (releaseIdentity: string) =>
      createHarnessCliServices(
        createProductHarnesses({
          architecture: "arm64",
          codexDiscoveryPolicy: testDiscoveryPolicy,
          environment: { PATH: dirname(value.codexExecutables[0]!) },
          home: value.home,
          homeDirectory: value.vendorHome,
          installationFactory: createProductHarnessInstallationInput,
          machineEntryPath: upgradedMachine,
          nodeExecutable: process.execPath,
          platform: "darwin",
          readHookDeadlineMilliseconds: () => Promise.resolve(2_000),
          releaseIdentity,
        }),
      );
    const upgraded = createAtRelease("0.1.0");
    const upgradedApply = await upgraded.installHarness({
      apply: true,
      harness: "codex",
      presentPlan,
    });
    expect(upgradedApply).toMatchObject({
      status: "success",
      value: { applied: true, disposition: "committed" },
    });
    const downgraded = createAtRelease("0.0.8");
    await expect(
      downgraded.installHarness({
        apply: false,
        harness: "codex",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      status: "partial",
      value: { applied: false, disposition: "conflict" },
    });
    await expect(
      downgraded.migrateHarness({
        apply: false,
        harness: "codex",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      status: "partial",
      value: { applied: false, disposition: "conflict" },
    });
    await expect(
      downgraded.uninstallHarness({
        apply: true,
        harness: "codex",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: true, disposition: "committed" },
    });
  });

  it("refuses an aliased or incorrectly permissioned vendor configuration parent before planning", async () => {
    for (const state of ["alias", "mode"] as const) {
      const value = await fixture();
      const configuration = join(value.vendorHome, ".codex");
      await rm(configuration, { force: true, recursive: true });
      if (state === "alias") {
        const substituted = join(value.vendorHome, "substituted-codex");
        await mkdir(substituted, { mode: 0o700 });
        await symlink(substituted, configuration);
      } else await mkdir(configuration, { mode: 0o755 });
      await expect(
        value.services.installHarness({
          apply: true,
          harness: "codex",
          presentPlan: () => Promise.resolve(),
        }),
      ).resolves.toMatchObject({
        diagnostic: { code: "harness.plan-invalid" },
        status: "failure",
      });
      expect(await readdir(value.home.mutationDirectory)).toEqual([]);
    }
  });

  it("rejects configuration-parent substitution after plan presentation", async () => {
    const value = await fixture();
    const configuration = join(value.vendorHome, ".codex");
    const substituted = join(value.vendorHome, "substituted-codex");
    await rm(configuration, { force: true, recursive: true });
    await mkdir(substituted, { mode: 0o700 });
    await expect(
      value.services.installHarness({
        apply: true,
        harness: "codex",
        presentPlan: async () => {
          await symlink(substituted, configuration);
        },
      }),
    ).resolves.toMatchObject({
      diagnostic: { code: "harness.unavailable" },
      status: "failure",
    });
    expect(await readdir(value.home.mutationDirectory)).toEqual([]);
  });

  it("resumes after the durable parent prefix completes before the Core transaction", async () => {
    const value = await fixture();
    const configuration = join(value.vendorHome, ".codex");
    await rm(configuration, { force: true, recursive: true });
    const adapter = value.input.adapters?.[0];
    expect(adapter?.prepareApplication).toBeTypeOf("function");
    await adapter?.prepareApplication?.("install");
    expect(await realpath(configuration)).toBe(configuration);
    expect((await lstat(configuration)).mode & 0o777).toBe(0o700);
    expect(await readdir(value.home.mutationDirectory)).toEqual([]);

    await expect(
      value.services.installHarness({
        apply: true,
        harness: "codex",
        presentPlan: () => Promise.resolve(),
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: true, disposition: "committed" },
    });
  });

  it("requires explicit migrate authority before replacing foreign Codex root hooks", async () => {
    const value = await fixture();
    const configurationPath = join(value.vendorHome, ".codex", "hooks.json");
    const foreign = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                command: "/foreign-observer",
                type: "command",
              },
            ],
            matcher: "startup",
          },
        ],
      },
    };
    await writeFile(configurationPath, `${JSON.stringify(foreign)}\n`, {
      mode: 0o600,
    });
    const presentPlan = () => Promise.resolve();
    await expect(
      value.services.installHarness({
        apply: true,
        harness: "codex",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      status: "partial",
      value: { applied: false, disposition: "conflict" },
    });
    expect(await readFile(configurationPath, "utf8")).toBe(
      `${JSON.stringify(foreign)}\n`,
    );
    await expect(
      value.services.migrateHarness({
        apply: true,
        harness: "codex",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: true, disposition: "committed" },
    });
    expect(await readFile(configurationPath, "utf8")).not.toContain(
      "/foreign-observer",
    );
  });
});
