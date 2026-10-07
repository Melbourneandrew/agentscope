import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeCodeDescriptor,
  createClaudeCodeDialectAuthority,
  type ClaudeCodePluginInventory,
} from "@agentscope/harness-claude-code";
import type { HarnessTargetInspection } from "@agentscope/harnesses-core";
import { afterEach } from "vitest";
import { createOwnedHookLauncherArtifacts } from "../hook-launcher.js";
import {
  createProductHarnessInstallationInput,
  type ProductHarnessInstallationInput,
  type ProductHarnessReadGuard,
} from "../product-harness-installation.js";

export const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export const encode = (value: string): Uint8Array =>
  new TextEncoder().encode(value);

export const directoryProofInNode = (
  input: ProductHarnessInstallationInput,
): unknown =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
    import { writeFile } from "node:fs/promises";
    import { join } from "node:path";
    import { inspectHarnessInstallation, applyHarnessInstallation } from "@agentscope/harnesses-core";
    import { createClaudeCodeDialectAuthority, claudeCodeDescriptor } from "@agentscope/harness-claude-code";
    import { createProductHarnessInstallationInput } from "./src/product-harness-installation.ts";
    const input = JSON.parse(process.argv[1]);
    input.dialectAuthority = createClaudeCodeDialectAuthority({ configurationLocations: [{locationIndex: 0, present: true}],
      harnessType: claudeCodeDescriptor.harnessType, reason: "compatible", state: "installed", version: "2.1.245" }, "posix");
    const plan = await inspectHarnessInstallation(createProductHarnessInstallationInput(input));
    let applied;
    if (plan.disposition === "ready") {
      await writeFile(join(input.cacheElections[0].candidates[0].installPath, "new-content"), "changed");
      applied = await applyHarnessInstallation(plan);
    }
    console.log(JSON.stringify({ disposition: plan.disposition, targetCount: plan.targetCount, applied }));
  `,
        JSON.stringify(input),
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 4096,
        cwd: new URL("../..", import.meta.url),
        env: { PATH: "/usr/bin:/bin" },
      },
    ),
  );

const fixtureLauncher = (input: ProductHarnessInstallationInput) =>
  createOwnedHookLauncherArtifacts({
    agentscopeHome: input.agentscopeHome,
    harnessType: claudeCodeDescriptor.harnessType,
    hookDeadlineMilliseconds: input.hookDeadlineMilliseconds,
    machineEntryPath: input.machineEntryPath,
    nodeExecutable: input.nodeExecutable,
    platform: "posix",
    releaseIdentity: input.releaseIdentity,
  });

const configurationTarget = (
  targetPath: string,
  bytes: Uint8Array,
): HarnessTargetInspection => ({
  targetPath,
  exists: true,
  bytes,
  digest: digest(bytes),
  mode: 0o600,
});

type FixtureClaudeInstallationInput = Extract<
  ProductHarnessInstallationInput,
  { harness: "claude-code" }
> &
  Readonly<{ pluginInventory: ClaudeCodePluginInventory }>;

export const createProductInstallationFixtures = () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true })),
    );
  });

  const fixture = async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "agentscope-product-install-")),
    );
    roots.push(root);
    const settingsPath = join(root, "settings.json");
    const registryPath = join(root, "installed_plugins.json");
    const settings = encode('{"enabledPlugins":{}}\n');
    const registry = encode('{"version":2,"plugins":{}}\n');
    await writeFile(settingsPath, settings, { mode: 0o600 });
    await writeFile(registryPath, registry, { mode: 0o600 });
    await chmod(settingsPath, 0o600);
    await chmod(registryPath, 0o600);
    const common = {
      agentscopeHome: root,
      hookConfigurationPath: settingsPath,
      hookDeadlineMilliseconds: 250,
      machineEntryPath: join(root, "machine.js"),
      mutationDirectory: join(root, "mutations"),
      nodeExecutable: process.execPath,
      operation: "install" as const,
      releaseIdentity: "0.1.0",
    };
    // Synthetic discovery tests factory composition, not an installed vendor.
    const dialectAuthority = createClaudeCodeDialectAuthority(
      {
        configurationLocations: [{ locationIndex: 0, present: true }],
        harnessType: claudeCodeDescriptor.harnessType,
        reason: "compatible",
        state: "installed",
        version: "2.1.245",
      },
      "posix",
    );
    if (dialectAuthority === undefined) throw new Error("fixture.dialect");
    const pluginInventory: ClaudeCodePluginInventory = {
      settingsLayers: [
        {
          scope: "user",
          targetPath: settingsPath,
          targetDigest: digest(settings),
          targetExists: true,
          enabledPlugins: {},
        },
      ],
      installedPlugins: [],
    };
    const guard: ProductHarnessReadGuard = {
      targetPath: registryPath,
      exists: true,
      digest: digest(registry),
      mode: 0o600,
    };
    const input: FixtureClaudeInstallationInput = {
      ...common,
      harness: "claude-code",
      dialectAuthority,
      pluginInventory,
      readGuards: [guard],
    };
    const inspected: HarnessTargetInspection = {
      ...guard,
      bytes: registry,
    };
    const launcher = fixtureLauncher(common);
    return {
      root,
      common,
      input,
      registryPath,
      settingsPath,
      inspected,
      configurationInspected: configurationTarget(settingsPath, settings),
      metadataPath: launcher.metadataPath,
      launcherPath: launcher.launcherPath,
    };
  };

  const withElection = async () => {
    const value = await fixture();
    if (value.input.harness !== "claude-code")
      throw new Error("fixture.harness");
    const paths = [
      join(value.root, "first-cache"),
      join(value.root, "second-cache"),
    ];
    for (const path of paths) await mkdir(path, { mode: 0o755 });
    await mkdir(join(paths[0]!, "node_modules"));
    await mkdir(join(paths[1]!, "skills"));
    const plugin = {
      pluginId: "ordinary@market",
      installedRegistryId: "ordinary@market",
      cachePluginId: "ordinary@market",
      manifestName: null,
      manifestVersion: null,
      manifestDigest: null,
      hooksDigest: null,
      hookEvents: [],
      directTraceExporter: null,
    } as const;
    const sourceInput: ProductHarnessInstallationInput = {
      ...value.input,
      cacheElections: [
        { candidates: paths.map((installPath) => ({ installPath, plugin })) },
      ],
    };
    const input = createProductHarnessInstallationInput(sourceInput);
    return { ...value, paths, input, sourceInput };
  };

  return { fixture, withElection };
};
