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
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  claudeCodeDescriptor,
  type ClaudeCodePluginInventory,
} from "@agentscope/harness-claude-code";
import type { HarnessTargetInspection } from "@agentscope/harnesses-core";
import { afterAll, afterEach } from "vitest";
import { createOwnedHookLauncherArtifacts } from "../hook-launcher.js";
import type { createProductHarnesses } from "../product-harnesses.js";
import type { createHarnessCliServices } from "../harness-services.js";
import {
  createProductHarnessInstallationInput,
  type ProductHarnessInstallationInput,
  type ProductHarnessReadGuard,
} from "../product-harness-installation.js";

export const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export const encode = (value: string): Uint8Array =>
  new TextEncoder().encode(value);

// The ordinary unit suite owns these exact current-source bundles; it never
// relies on a warm ignored CLI dist or adds a shipped export for the test.
export const builtProductInstallationModules = async (root: string) => {
  const privatePath = join(
    root,
    "internal",
    "agentscope-product-harness-installation.js",
  );
  const productPath = join(root, "bin", "product-harnesses.mjs");
  const options = {
    bundle: true,
    format: "esm" as const,
    platform: "node" as const,
    target: "node22",
  };
  await build({
    ...options,
    entryPoints: [
      fileURLToPath(
        new URL("../product-harness-installation.ts", import.meta.url),
      ),
    ],
    outfile: privatePath,
  });
  await build({
    ...options,
    stdin: {
      contents:
        'export { createProductHarnesses } from "./src/product-harnesses.ts"; export { createHarnessCliServices } from "./src/harness-services.ts";',
      resolveDir: fileURLToPath(new URL("../..", import.meta.url)),
      loader: "ts",
    },
    external: [
      "../internal/agentscope-product-harness-installation.js",
      "./directory-runtime/loader/owned-loader.mjs",
    ],
    outfile: productPath,
  });
  return {
    installation: (await import(
      /* @vite-ignore */ pathToFileURL(privatePath).href
    )) as {
      createProductHarnessInstallationInput: typeof createProductHarnessInstallationInput;
    },
    product: (await import(
      /* @vite-ignore */ pathToFileURL(productPath).href
    )) as {
      createProductHarnesses: typeof createProductHarnesses;
      createHarnessCliServices: typeof createHarnessCliServices;
    },
  };
};

// Real held-directory DTOs originate in Node's realm, not Vitest's VM realm.
// This child invokes only first-party services over synthetic vendor bytes.
export const claudeServiceProofInNode = (
  input: Readonly<{
    agentscopeRoot: string;
    vendorHome: string;
    machineEntryPath: string;
    environment: Readonly<Record<string, string | undefined>>;
    codexDiscoveryPolicy: unknown;
    claudeDiscoveryPolicy: unknown;
    kind: "empty-profile" | "directory-drift";
  }>,
): Readonly<{
  tupleExpected: boolean;
  result: unknown;
  presented: boolean;
  presentationDisposition: string | null;
  gitGuarded: boolean;
  parentMode: number;
  settingsMode: number | null;
  coworkExists: boolean;
  launcherNames: readonly string[];
}> =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
    import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    import { createAgentscopeHomeResolver } from "@agentscope/core/configuration-management";
    import { createHarnessCliServices } from "./src/harness-services.ts";
    import { createProductHarnesses } from "./src/product-harnesses.ts";
    import { createProductHarnessInstallationInput } from "./src/product-harness-installation.ts";
    const input = JSON.parse(process.argv[1]);
    const environment = { ...input.environment };
    const home = createAgentscopeHomeResolver({ environment: { AGENTSCOPE_HOME: input.agentscopeRoot },
      environmentOverrideAuthority: "test", platform: process.platform })();
    const product = createProductHarnesses({ home, environment, homeDirectory: input.vendorHome,
      projectDirectory: input.vendorHome, architecture: "arm64", platform: "darwin",
      codexDiscoveryPolicy: input.codexDiscoveryPolicy, claudeDiscoveryPolicy: input.claudeDiscoveryPolicy,
      installationFactory: createProductHarnessInstallationInput, machineEntryPath: input.machineEntryPath,
      nodeExecutable: process.execPath, releaseIdentity: "0.1.0",
      readHookDeadlineMilliseconds: () => Promise.resolve(2000) });
    const directory = join(input.vendorHome, "observed-directory");
    if (input.kind === "directory-drift") await mkdir(directory, { mode: 0o700 });
    let gitGuarded = false;
    const adapters = product.adapters.map(adapter => adapter.commandName !== "claude-code" ? adapter : {
      ...adapter, createInstallationInput: async operation => {
        const plan = await adapter.createInstallationInput(operation);
        gitGuarded = plan.directoryPaths?.includes(join(input.vendorHome, ".git")) === true;
        return input.kind === "directory-drift"
          ? { ...plan, directoryPaths: [...(plan.directoryPaths ?? []), directory] } : plan;
      }
    });
    let presented = false, presentationDisposition = null;
    const result = await createHarnessCliServices({ ...product, adapters }).installHarness({
      apply: true, harness: "claude-code", presentPlan: async plan => {
        presented = true; presentationDisposition = plan.disposition;
        if (input.kind === "directory-drift") await writeFile(join(directory, "late-entry"), "changed");
        else {
          environment.CLAUDE_CONFIG_DIR = "/foreign-profile";
          environment.CLAUDE_CODE_USE_COWORK_PLUGINS = "1";
          environment.CLAUDE_CODE_PLUGIN_CACHE_DIR = "/foreign-cache";
        }
      }
    });
    const selected = input.kind === "empty-profile" ? input.vendorHome : join(input.vendorHome, ".claude");
    const mode = async path => { try { return (await lstat(path)).mode & 0o777; }
      catch (error) { if (error.code !== "ENOENT") throw error; return null; } };
    // This is the canonical positive CI tuple expectation, not loader admission.
    // OS/libc/NAPI/assets must still pass the real loader or the positive fails.
    const tupleExpected = process.versions.node.split(".")[0] === "22" &&
      ((process.platform === "darwin" && process.arch === "arm64") ||
       (process.platform === "linux" && process.arch === "x64"));
    console.log(JSON.stringify({ tupleExpected, result, presented, presentationDisposition, gitGuarded,
      parentMode: await mode(input.vendorHome), settingsMode: await mode(join(selected, "settings.json")),
      coworkExists: (await mode(join(selected, "cowork_settings.json"))) !== null,
      launcherNames: await readdir(home.launcherDirectory) }));
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
  ) as ReturnType<typeof claudeServiceProofInNode>;

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
    import { claudeCodeDescriptor } from "@agentscope/harness-claude-code";
    import { createProductHarnessInstallationInput } from "./src/product-harness-installation.ts";
    const input = JSON.parse(process.argv[1]);
    input.observedDiscovery = { configurationLocations: [{locationIndex: 0, present: true}],
      harnessType: claudeCodeDescriptor.harnessType, reason: "compatible", state: "installed", version: "2.1.245" };
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
  const cleanup = async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true })),
    );
  };
  afterEach(cleanup);
  afterAll(cleanup);

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
    const observedDiscovery = {
      configurationLocations: [{ locationIndex: 0, present: true }],
      harnessType: claudeCodeDescriptor.harnessType,
      reason: "compatible",
      state: "installed",
      version: "2.1.245",
    } as const;
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
      observedDiscovery,
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
