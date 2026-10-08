import {
  authenticateExactFile,
  createProductClaudeDiscoveryFactory,
  canonicalFutureDirectory,
  canonicalPrivateDirectory,
  canonicalConfigurationDirectory,
  durablyPublishPrivateDirectory,
  exactAbsolutePath,
  exactEnvironmentValue,
  executableCandidates,
  nodeErrorCode,
  revalidateAuthenticatedFile,
  unavailable,
  type AuthenticatedFile,
  type ExactFileIdentity,
} from "./product-harness-probe-files.js";
import { lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defineHarnessRegistry,
  discoverHarness,
  type HarnessDiscoveryProbe,
  type HarnessRegistry,
} from "@agentscope/harnesses-core";
import {
  CODEX_HOOK_CONFIGURATION_PATH,
  codexHarnessDescriptor,
} from "@agentscope/harness-codex";
import {
  claudeCodeDescriptor,
  createClaudeCodeDialectAuthority,
  type ClaudeDiscoveryPolicy,
} from "@agentscope/harness-claude-code";

import type { AgentscopeHome } from "@agentscope/core/configuration-management";
import type {
  CliHarnessAdapter,
  CreateHarnessCliServicesInput,
} from "./harness-services.js";
import type {
  createProductHarnessInstallationInput,
  ProductHarnessInstallationInput,
} from "./product-harness-installation.js";

type CodexPlatformIdentity = Readonly<{
  dependency: string;
  executable: ExactFileIdentity;
  manifest: ExactFileIdentity;
  packageVersion: string;
  triple: string;
}>;
export type CodexDiscoveryPolicy = Readonly<{
  platforms: Readonly<Record<string, CodexPlatformIdentity>>;
  version: string;
  wrapper: ExactFileIdentity;
  wrapperManifest: ExactFileIdentity;
}>;
const CODEX_DISCOVERY_POLICY: CodexDiscoveryPolicy = Object.freeze({
  platforms: Object.freeze({
    "darwin-arm64": Object.freeze({
      dependency: "@openai/codex-darwin-arm64",
      executable: Object.freeze({
        bytes: 220_552_944,
        sha256:
          "f0d8762236594359b60cfbe17f4c7e945a3ce8d1c91e74778838c968d250fb6c",
      }),
      manifest: Object.freeze({
        bytes: 517,
        sha256:
          "1de96e9f1d6e9bcb6c84f2c854333a87391f696ce71f80fa865622b5b0e81919",
      }),
      packageVersion: "0.149.1-darwin-arm64",
      triple: "aarch64-apple-darwin",
    }),
    "linux-x64": Object.freeze({
      dependency: "@openai/codex-linux-x64",
      executable: Object.freeze({
        bytes: 258_227_840,
        sha256:
          "73dc5888888f411c1f0fa7b81d866e721dcc86b527ce8e3b2cf4708661e823ba",
      }),
      manifest: Object.freeze({
        bytes: 511,
        sha256:
          "798fb4a2b5c64f41d6dd778b1d296b6cc3d41be06a5213bd9532bffdb8c30dbc",
      }),
      packageVersion: "0.149.1-linux-x64",
      triple: "x86_64-unknown-linux-musl",
    }),
  }),
  version: "0.149.1",
  wrapper: Object.freeze({
    bytes: 7_236,
    sha256: "134063e133f0b4244fa3b251acf973d4fe4b4aeeacbdc135211bf480f59f1477",
  }),
  wrapperManifest: Object.freeze({
    bytes: 1_082,
    sha256: "4aa95175f28bc38085c880398057afa1428257835c868403391c23099513b28e",
  }),
});

export type CreateProductHarnessesInput = Readonly<{
  architecture?: NodeJS.Architecture;
  codexDiscoveryPolicy?: CodexDiscoveryPolicy;
  claudeDiscoveryPolicy?: ClaudeDiscoveryPolicy;
  environment?: Readonly<Record<string, string | undefined>>;
  home: AgentscopeHome;
  homeDirectory?: string;
  installationFactory?: typeof createProductHarnessInstallationInput;
  machineEntryPath?: string;
  nodeExecutable?: string;
  platform?: NodeJS.Platform;
  projectDirectory?: string;
  readHookDeadlineMilliseconds: () => Promise<number>;
  releaseIdentity: string;
}>;

export const PRODUCT_HARNESS_REGISTRY: HarnessRegistry = defineHarnessRegistry([
  codexHarnessDescriptor,
  claudeCodeDescriptor,
]);

const readBoundedInstalledPackageVersion = async (
  executablePath: string,
  arguments_: readonly string[],
  architecture: NodeJS.Architecture,
  platform: NodeJS.Platform,
  policy: CodexDiscoveryPolicy,
): Promise<
  | Readonly<{ kind: "observed"; output: string }>
  | Readonly<{ kind: "unavailable" }>
> => {
  try {
    if (
      arguments_.length !== 1 ||
      arguments_[0] !== "--version" ||
      Object.getPrototypeOf(arguments_) !== Array.prototype
    )
      return unavailable();
    const platformIdentity = policy.platforms[`${platform}-${architecture}`];
    if (platformIdentity === undefined) return unavailable();
    const executable = exactAbsolutePath(await realpath(executablePath));
    if (
      basename(executable) !== "codex.js" ||
      basename(dirname(executable)) !== "bin"
    )
      return unavailable();
    const manifestPath = join(dirname(dirname(executable)), "package.json");
    const platformManifestPath = exactAbsolutePath(
      createRequire(manifestPath).resolve(
        `${platformIdentity.dependency}/package.json`,
      ),
    );
    const nativePath = join(
      dirname(platformManifestPath),
      "vendor",
      platformIdentity.triple,
      "bin",
      "codex",
    );
    const authenticated: AuthenticatedFile[] = [];
    try {
      authenticated.push(
        await authenticateExactFile(executable, policy.wrapper, 0o755),
      );
      authenticated.push(
        await authenticateExactFile(
          manifestPath,
          policy.wrapperManifest,
          0o644,
        ),
      );
      authenticated.push(
        await authenticateExactFile(
          platformManifestPath,
          platformIdentity.manifest,
          0o644,
        ),
      );
      authenticated.push(
        await authenticateExactFile(
          nativePath,
          platformIdentity.executable,
          0o755,
        ),
      );
      await Promise.all(authenticated.map(revalidateAuthenticatedFile));
      return Object.freeze({
        kind: "observed" as const,
        output: `codex-cli ${policy.version}\n`,
      });
    } finally {
      await Promise.all(authenticated.map(({ handle }) => handle.close()));
    }
  } catch {
    return unavailable();
  }
};

const inspectConfiguration = async (
  locations: readonly (readonly string[])[],
  homeDirectory: string,
) => {
  if (
    locations.length !== 2 ||
    locations.some(
      (segments, index) =>
        Object.getPrototypeOf(segments) !== Array.prototype ||
        segments.join("\0") !==
          codexHarnessDescriptor.configuration.locationSegments[index]!.join(
            "\0",
          ),
    )
  )
    throw new Error("cli.harness.probe-unavailable");
  return Promise.all(
    locations.map(async (segments, locationIndex) => {
      const path = exactAbsolutePath(join(homeDirectory, ...segments));
      try {
        if ((await canonicalFutureDirectory(dirname(path))) !== dirname(path))
          throw new Error("cli.harness.probe-unavailable");
        const state = await lstat(path);
        return Object.freeze({
          locationIndex,
          present: state.isFile() && !state.isSymbolicLink(),
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          ["ENOENT", "ENOTDIR"].includes(String(error.code))
        )
          return Object.freeze({ locationIndex, present: false });
        throw error;
      }
    }),
  );
};

const productProbe = (
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string | undefined,
  architecture: NodeJS.Architecture,
  platform: NodeJS.Platform,
  policy: CodexDiscoveryPolicy,
): HarnessDiscoveryProbe =>
  Object.freeze({
    inspectConfiguration: (locations: readonly (readonly string[])[]) =>
      homeDirectory === undefined
        ? Promise.reject(new Error("cli.harness.probe-unavailable"))
        : inspectConfiguration(locations, homeDirectory),
    locateExecutable: (names: readonly string[]) =>
      executableCandidates(names, environment),
    readVersion: (executablePath: string, arguments_: readonly string[]) =>
      readBoundedInstalledPackageVersion(
        executablePath,
        arguments_,
        architecture,
        platform,
        policy,
      ),
  });

const loadInstallationFactory = async (
  input: CreateProductHarnessesInput,
): Promise<typeof createProductHarnessInstallationInput> => {
  /* v8 ignore start -- the packed-artifact verifier executes the literal
   release-only module edge; source tests inject the same typed factory. */
  const installationModule: unknown = input.installationFactory
    ? undefined
    : await import("../internal/agentscope-product-harness-installation.js");
  const loadedFactory: unknown =
    typeof installationModule === "object" && installationModule !== null
      ? Reflect.get(installationModule, "createProductHarnessInstallationInput")
      : undefined;
  const installationFactory = input.installationFactory ?? loadedFactory;
  /* v8 ignore stop */
  if (typeof installationFactory !== "function")
    throw new Error("cli.launcher.unsupported");
  return installationFactory as typeof createProductHarnessInstallationInput;
};

const installationCommonInput = async (
  input: CreateProductHarnessesInput,
  operation: "install" | "migrate" | "uninstall",
  paths: Readonly<{
    requestedHookConfigurationPath: string;
    nodeExecutable: string;
    machineEntryPath: string;
    existingVendorDirectory?: boolean;
  }>,
): Promise<ProductHarnessInstallationInput> => {
  const nodePath = exactAbsolutePath(await realpath(paths.nodeExecutable));
  const nodeState = await lstat(nodePath);
  if (!nodeState.isFile() || nodeState.isSymbolicLink())
    throw new Error("cli.launcher.unsupported");
  const agentscopeHome = exactAbsolutePath(await realpath(input.home.root));
  const requestedConfigurationDirectory = dirname(
    paths.requestedHookConfigurationPath,
  );
  let configurationDirectory: string;
  try {
    configurationDirectory = await (
      paths.existingVendorDirectory
        ? canonicalConfigurationDirectory
        : canonicalPrivateDirectory
    )(requestedConfigurationDirectory);
  } catch (error) {
    if (
      nodeErrorCode(error) !== "ENOENT" ||
      (await canonicalFutureDirectory(requestedConfigurationDirectory)) !==
        requestedConfigurationDirectory
    )
      throw error;
    configurationDirectory = requestedConfigurationDirectory;
  }
  const hookConfigurationPath = join(
    configurationDirectory,
    basename(paths.requestedHookConfigurationPath),
  );
  const machinePath = exactAbsolutePath(await realpath(paths.machineEntryPath));
  const machineState = await lstat(machinePath);
  if (!machineState.isFile() || machineState.isSymbolicLink())
    throw new Error("cli.launcher.unsupported");
  const hookDeadlineMilliseconds = await input.readHookDeadlineMilliseconds();
  return Object.freeze({
    agentscopeHome,
    hookConfigurationPath,
    hookDeadlineMilliseconds,
    machineEntryPath: machinePath,
    mutationDirectory: input.home.mutationDirectory,
    nodeExecutable: nodePath,
    operation,
    releaseIdentity: input.releaseIdentity,
  });
};

export const createProductHarnesses = (
  input: CreateProductHarnessesInput,
): CreateHarnessCliServicesInput => {
  const environment = input.environment ?? process.env;
  const homeValue =
    input.homeDirectory ?? exactEnvironmentValue(environment, "HOME");
  const homeDirectory =
    homeValue === undefined ? undefined : exactAbsolutePath(homeValue);
  const platform = input.platform ?? process.platform;
  const architecture = input.architecture ?? process.arch;
  const codexDiscoveryPolicy =
    input.codexDiscoveryPolicy ?? CODEX_DISCOVERY_POLICY;
  const machineEntryPath = exactAbsolutePath(
    input.machineEntryPath ??
      fileURLToPath(
        new URL("../internal/agentscope-hook-machine.js", import.meta.url),
      ),
  );
  const nodeExecutable = exactAbsolutePath(
    input.nodeExecutable ?? process.execPath,
  );
  const projectDirectory = exactAbsolutePath(
    input.projectDirectory ?? process.cwd(),
  );
  const requestedHookConfigurationPath =
    homeDirectory === undefined
      ? undefined
      : exactAbsolutePath(
          join(homeDirectory, ...CODEX_HOOK_CONFIGURATION_PATH),
        );
  const adapter = Object.freeze({
    commandName: "codex",
    createInstallationInput: async (
      operation: "install" | "migrate" | "uninstall",
    ) => {
      if (platform === "win32" || requestedHookConfigurationPath === undefined)
        throw new Error("cli.launcher.unsupported");
      const installationInput = await installationCommonInput(
        input,
        operation,
        {
          requestedHookConfigurationPath,
          machineEntryPath,
          nodeExecutable,
        },
      );
      const createInstallation = await loadInstallationFactory(input);
      return createInstallation(installationInput);
    },
    harnessType: codexHarnessDescriptor.harnessType,
    prepareApplication: async (
      operation: "install" | "migrate" | "uninstall",
    ) => {
      if (
        operation === "uninstall" ||
        requestedHookConfigurationPath === undefined
      )
        return;
      const directory = dirname(requestedHookConfigurationPath);
      await durablyPublishPrivateDirectory(directory);
    },
    probe: productProbe(
      environment,
      homeDirectory,
      architecture,
      platform,
      codexDiscoveryPolicy,
    ),
  });
  return Object.freeze({
    adapters: Object.freeze([
      adapter,
      createClaudeProductAdapter(input, {
        environment,
        homeDirectory,
        platform,
        architecture,
        machineEntryPath,
        nodeExecutable,
        projectDirectory,
      }),
    ]),
    registry: PRODUCT_HARNESS_REGISTRY,
  });
};

const createClaudeProductAdapter = (
  input: CreateProductHarnessesInput,
  context: Readonly<{
    environment: Readonly<Record<string, string | undefined>>;
    homeDirectory: string | undefined;
    platform: NodeJS.Platform;
    architecture: NodeJS.Architecture;
    machineEntryPath: string;
    nodeExecutable: string;
    projectDirectory: string;
  }>,
): CliHarnessAdapter => {
  const { homeDirectory, platform, architecture } = context;
  const discovery = createProductClaudeDiscoveryFactory().bindInvocation({
    environment: context.environment,
    projectDirectory: context.projectDirectory,
    ...(homeDirectory === undefined ? {} : { homeDirectory }),
    platform,
    architecture,
    ...(input.claudeDiscoveryPolicy === undefined
      ? {}
      : { policy: input.claudeDiscoveryPolicy }),
  });
  const selectedHookConfigurationPath = discovery.configurationPath;
  const probe = discovery.probe;
  return Object.freeze({
    commandName: "claude-code",
    harnessType: claudeCodeDescriptor.harnessType,
    probe,
    createInstallationInput: async (operation) => {
      const requestedHookConfigurationPath = selectedHookConfigurationPath();
      if (
        homeDirectory === undefined ||
        requestedHookConfigurationPath === undefined ||
        (platform !== "darwin" && platform !== "linux")
      )
        throw new Error("cli.launcher.unsupported");
      const common = await installationCommonInput(input, operation, {
        requestedHookConfigurationPath,
        nodeExecutable: context.nodeExecutable,
        machineEntryPath: context.machineEntryPath,
        existingVendorDirectory: true,
      });
      const observed = await discoverHarness(
        PRODUCT_HARNESS_REGISTRY,
        claudeCodeDescriptor.harnessType,
        probe,
      );
      const dialectAuthority = createClaudeCodeDialectAuthority(
        observed,
        "posix",
      );
      if (dialectAuthority === undefined)
        throw new Error("cli.launcher.unsupported");
      const plugins = await discovery.observeInstallationContext();
      const createInstallation = await loadInstallationFactory(input);
      return createInstallation({
        ...common,
        harness: "claude-code",
        dialectAuthority,
        ...plugins,
      });
    },
    prepareApplication: async (operation) => {
      const requestedHookConfigurationPath = selectedHookConfigurationPath();
      if (
        operation === "uninstall" ||
        requestedHookConfigurationPath === undefined
      )
        return;
      const directory = dirname(requestedHookConfigurationPath);
      try {
        await canonicalConfigurationDirectory(directory);
      } catch (error) {
        if (nodeErrorCode(error) !== "ENOENT") throw error;
        await durablyPublishPrivateDirectory(directory);
      }
    },
  });
};

export const productHarnessParentDirectoryForTesting = (
  homeDirectory: string,
): string => dirname(join(homeDirectory, ...CODEX_HOOK_CONFIGURATION_PATH));
