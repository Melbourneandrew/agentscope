import { constants, createReadStream } from "node:fs";
import { access, lstat, mkdir, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defineHarnessRegistry,
  type HarnessDiscoveryProbe,
  type HarnessRegistry,
} from "@agentscope/harnesses-core";
import {
  CODEX_HOOK_CONFIGURATION_PATH,
  codexHarnessDescriptor,
} from "@agentscope/harness-codex";

import type { AgentscopeHome } from "@agentscope/core/configuration-management";
import type { CreateHarnessCliServicesInput } from "./harness-services.js";
import type {
  createProductHarnessInstallationInput,
  ProductHarnessInstallationInput,
} from "./product-harness-installation.js";

const MAXIMUM_PATH_CODE_UNITS = 4_096;
const MAXIMUM_PATH_ENTRIES = 64;
type ExactFileIdentity = Readonly<{ bytes: number; sha256: string }>;
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
  environment?: Readonly<Record<string, string | undefined>>;
  home: AgentscopeHome;
  homeDirectory?: string;
  installationFactory?: typeof createProductHarnessInstallationInput;
  machineEntryPath?: string;
  nodeExecutable?: string;
  platform?: NodeJS.Platform;
  readHookDeadlineMilliseconds: () => Promise<number>;
  releaseIdentity: string;
}>;

export const PRODUCT_HARNESS_REGISTRY: HarnessRegistry = defineHarnessRegistry([
  codexHarnessDescriptor,
]);

const unavailable = (): Readonly<{ kind: "unavailable" }> =>
  Object.freeze({ kind: "unavailable" as const });

const exactEnvironmentValue = (
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(environment, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor) || descriptor.value === undefined)
    throw new Error("cli.harness.probe-unavailable");
  if (typeof descriptor.value !== "string")
    throw new Error("cli.harness.probe-unavailable");
  return descriptor.value;
};

const exactAbsolutePath = (value: string): string => {
  if (
    value.length === 0 ||
    value.length > MAXIMUM_PATH_CODE_UNITS ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value
  )
    throw new Error("cli.harness.probe-unavailable");
  return value;
};

const nodeErrorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;

const canonicalFutureDirectory = async (path: string): Promise<string> => {
  let current = exactAbsolutePath(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      return exactAbsolutePath(join(await realpath(current), ...suffix));
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        !["ENOENT", "ENOTDIR"].includes(String(error.code))
      )
        throw error;
      const parent = dirname(current);
      if (parent === current)
        throw new Error("cli.harness.probe-unavailable", { cause: error });
      suffix.unshift(basename(current));
      current = parent;
    }
  }
};

const canonicalPrivateDirectory = async (path: string): Promise<string> => {
  const canonical = exactAbsolutePath(await realpath(path));
  const state = await lstat(canonical);
  if (
    canonical !== path ||
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    (process.platform !== "win32" && (state.mode & 0o777) !== 0o700)
  )
    throw new Error("cli.harness.configuration-directory-unavailable");
  return canonical;
};

const sameDirectoryIdentity = (
  left: Awaited<ReturnType<FileHandle["stat"]>>,
  right: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean =>
  left.isDirectory() &&
  right.isDirectory() &&
  left.dev === right.dev &&
  left.ino === right.ino;

const durablyPublishPrivateDirectory = async (path: string): Promise<void> => {
  const parent = dirname(path);
  if (exactAbsolutePath(await realpath(parent)) !== parent)
    throw new Error("cli.harness.configuration-directory-unavailable");
  const parentHandle = await open(
    parent,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  try {
    const before = await parentHandle.stat();
    const pathBefore = await lstat(parent);
    if (
      !sameDirectoryIdentity(before, pathBefore) ||
      pathBefore.isSymbolicLink()
    )
      throw new Error("cli.harness.configuration-directory-unavailable");
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") throw error;
    }
    await canonicalPrivateDirectory(path);
    await parentHandle.sync();
    const after = await parentHandle.stat();
    const pathAfter = await lstat(parent);
    if (
      !sameDirectoryIdentity(before, after) ||
      !sameDirectoryIdentity(after, pathAfter) ||
      pathAfter.isSymbolicLink() ||
      exactAbsolutePath(await realpath(parent)) !== parent
    )
      throw new Error("cli.harness.configuration-directory-unavailable");
    await canonicalPrivateDirectory(path);
  } finally {
    await parentHandle.close();
  }
};

const pathDirectories = (
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] => {
  const path = exactEnvironmentValue(environment, "PATH");
  if (path === undefined || path.length > 65_536)
    throw new Error("cli.harness.probe-unavailable");
  const entries = path.split(":");
  if (
    entries.length === 0 ||
    entries.length > MAXIMUM_PATH_ENTRIES ||
    entries.some(
      (entry) =>
        entry.length === 0 ||
        entry.length > MAXIMUM_PATH_CODE_UNITS ||
        !isAbsolute(entry) ||
        resolve(entry) !== entry,
    )
  )
    throw new Error("cli.harness.probe-unavailable");
  return Object.freeze([...entries]);
};

const executableCandidates = async (
  names: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<
  | Readonly<{
      kind: "found";
      candidates: readonly Readonly<{ path: string }>[];
    }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unavailable" }>
> => {
  try {
    if (
      names.length !== 1 ||
      names[0] !== "codex" ||
      Object.getPrototypeOf(names) !== Array.prototype
    )
      return unavailable();
    const candidates = new Map<string, Readonly<{ path: string }>>();
    for (const directory of pathDirectories(environment)) {
      const candidate = join(directory, "codex");
      try {
        const canonical = exactAbsolutePath(await realpath(candidate));
        const state = await lstat(canonical);
        if (!state.isFile() || state.isSymbolicLink()) continue;
        await access(canonical, constants.X_OK);
        candidates.set(canonical, Object.freeze({ path: canonical }));
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          ["EACCES", "ENOENT", "ENOTDIR"].includes(String(error.code))
        )
          continue;
        return unavailable();
      }
    }
    return candidates.size === 0
      ? Object.freeze({ kind: "absent" as const })
      : Object.freeze({
          candidates: Object.freeze([...candidates.values()]),
          kind: "found" as const,
        });
  } catch {
    return unavailable();
  }
};

type AuthenticatedFile = Readonly<{
  before: Awaited<ReturnType<FileHandle["stat"]>>;
  handle: FileHandle;
  path: string;
}>;

const authenticateExactFile = async (
  path: string,
  identity: ExactFileIdentity,
  mode: number,
): Promise<AuthenticatedFile> => {
  if (exactAbsolutePath(await realpath(path)) !== path)
    throw new Error("cli.harness.probe-unavailable");
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size !== identity.bytes ||
      (process.platform !== "win32" && (before.mode & 0o777) !== mode)
    )
      throw new Error("cli.harness.probe-unavailable");
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = createReadStream(path, {
      autoClose: false,
      fd: handle.fd,
      start: 0,
    }) as AsyncIterable<Buffer>;
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > identity.bytes)
        throw new Error("cli.harness.probe-unavailable");
      hash.update(chunk);
    }
    if (bytes !== identity.bytes || hash.digest("hex") !== identity.sha256)
      throw new Error("cli.harness.probe-unavailable");
    return Object.freeze({ before, handle, path });
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const revalidateAuthenticatedFile = async (
  authenticated: AuthenticatedFile,
): Promise<void> => {
  const after = await authenticated.handle.stat();
  const pathAfter = await lstat(authenticated.path);
  for (const value of [after, pathAfter])
    if (
      value.dev !== authenticated.before.dev ||
      value.ino !== authenticated.before.ino ||
      value.size !== authenticated.before.size ||
      value.mode !== authenticated.before.mode ||
      value.mtimeMs !== authenticated.before.mtimeMs ||
      value.ctimeMs !== authenticated.before.ctimeMs
    )
      throw new Error("cli.harness.probe-unavailable");
};

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

export const createProductHarnesses =
  // eslint-disable-next-line max-lines-per-function -- one closed composition binds discovery, planning, and apply-only parent preparation.
  (input: CreateProductHarnessesInput): CreateHarnessCliServicesInput => {
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
        if (
          platform === "win32" ||
          requestedHookConfigurationPath === undefined
        )
          throw new Error("cli.launcher.unsupported");
        const nodePath = exactAbsolutePath(await realpath(nodeExecutable));
        const nodeState = await lstat(nodePath);
        if (!nodeState.isFile() || nodeState.isSymbolicLink())
          throw new Error("cli.launcher.unsupported");
        const agentscopeHome = exactAbsolutePath(
          await realpath(input.home.root),
        );
        const requestedConfigurationDirectory = dirname(
          requestedHookConfigurationPath,
        );
        let configurationDirectory: string;
        try {
          configurationDirectory = await canonicalPrivateDirectory(
            requestedConfigurationDirectory,
          );
        } catch (error) {
          if (
            nodeErrorCode(error) !== "ENOENT" ||
            (await canonicalFutureDirectory(
              requestedConfigurationDirectory,
            )) !== requestedConfigurationDirectory
          )
            throw error;
          configurationDirectory = requestedConfigurationDirectory;
        }
        const hookConfigurationPath = join(
          configurationDirectory,
          CODEX_HOOK_CONFIGURATION_PATH[1],
        );
        const machinePath = exactAbsolutePath(await realpath(machineEntryPath));
        const machineState = await lstat(machinePath);
        if (!machineState.isFile() || machineState.isSymbolicLink())
          throw new Error("cli.launcher.unsupported");
        /* v8 ignore start -- the packed-artifact verifier executes the literal
         release-only module edge; source tests inject the same typed factory. */
        const installationModule: unknown = input.installationFactory
          ? undefined
          : await import("../internal/agentscope-product-harness-installation.js");
        const loadedFactory: unknown =
          typeof installationModule === "object" && installationModule !== null
            ? Reflect.get(
                installationModule,
                "createProductHarnessInstallationInput",
              )
            : undefined;
        const installationFactory = input.installationFactory ?? loadedFactory;
        /* v8 ignore stop */
        if (typeof installationFactory !== "function")
          throw new Error("cli.launcher.unsupported");
        const createInstallation =
          installationFactory as typeof createProductHarnessInstallationInput;
        const hookDeadlineMilliseconds =
          await input.readHookDeadlineMilliseconds();
        const installationInput: ProductHarnessInstallationInput =
          Object.freeze({
            agentscopeHome,
            hookConfigurationPath,
            hookDeadlineMilliseconds,
            machineEntryPath: machinePath,
            mutationDirectory: input.home.mutationDirectory,
            nodeExecutable: nodePath,
            operation,
            releaseIdentity: input.releaseIdentity,
          });
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
      adapters: Object.freeze([adapter]),
      registry: PRODUCT_HARNESS_REGISTRY,
    });
  };

export const productHarnessParentDirectoryForTesting = (
  homeDirectory: string,
): string => dirname(join(homeDirectory, ...CODEX_HOOK_CONFIGURATION_PATH));
