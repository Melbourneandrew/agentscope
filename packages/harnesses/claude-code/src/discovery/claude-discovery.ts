import { delimiter, dirname, join, resolve } from "node:path";

import { claudeCodeDescriptor } from "../descriptor.js";
import type {
  HarnessDiscoveryProbe,
  HarnessDirectoryInspection,
} from "@agentscope/harnesses-core";

import { normalizeClaudeCatalogEntry } from "./claude-catalog-entry.js";

import {
  exactAbsolutePath,
  exactEnvironmentValue,
  unavailable,
  claudePluginCacheContentName,
  type ExactFileIdentity,
  type ClaudeCodeDiscoveryReadCapabilities,
} from "./capabilities.js";

export type ClaudeDiscoveryPolicy = Readonly<{
  version: string;
  platforms: Readonly<Record<string, ExactFileIdentity>>;
}>;

// Exact native artifacts only: neither the npm failure stub nor its fallback
// wrapper proves the installed executable. No vendor process is invoked here.
const CLAUDE_DISCOVERY_POLICY: ClaudeDiscoveryPolicy = Object.freeze({
  version: "2.1.245",
  platforms: Object.freeze({
    "linux-x64": Object.freeze({
      bytes: 391_948_592,
      sha256:
        "16ad2b94deaf7b29abed966d981c9991a47af0420f5be8ed4a3f83bea9f678bc",
    }),
    "darwin-arm64": Object.freeze({
      bytes: 376_109_392,
      sha256:
        "9f7c2260251765a18d0b35198669dacc1912f6e8129a3b01f6b58d93365ff1f1",
    }),
  }),
});

const claudeConfigurationDirectory = (
  home: string,
  project: string,
  environment: Readonly<Record<string, string | undefined>>,
) => {
  // Pinned nbd -> In -> vi resolves the NFC-normalized nullish selection.
  // Empty is the project root; ~ is literal here, unlike the cache override.
  const selected =
    exactEnvironmentValue(environment, "CLAUDE_CONFIG_DIR") ??
    join(exactAbsolutePath(home), ".claude");
  return exactAbsolutePath(
    resolve(exactAbsolutePath(project), selected.normalize("NFC")),
  );
};

export const claudeUserConfiguration = (
  home: string,
  project: string,
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const directory = claudeConfigurationDirectory(home, project, environment);
  const cowork = Boolean(
    exactEnvironmentValue(environment, "CLAUDE_CODE_USE_COWORK_PLUGINS"),
  );
  return Object.freeze({
    directory,
    settingsPath: join(
      directory,
      cowork ? "cowork_settings.json" : "settings.json",
    ),
  });
};

export const captureClaudeEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> => {
  const captured = {};
  try {
    for (const key of [
      "PATH",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_CODE_USE_COWORK_PLUGINS",
      "CLAUDE_CODE_PLUGIN_CACHE_DIR",
      "CLAUDE_CODE_PLUGIN_SEED_DIR",
      "CLAUDE_SECURESTORAGE_CONFIG_DIR",
      // Pinned aBc/kBc select the provider before any account-dependent branch.
      // Preserve descriptors only: this is not effective policy or eligibility.
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_USE_ANTHROPIC_AWS",
      "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
      "CLAUDE_CODE_USE_MANTLE",
      "CLAUDE_CODE_USE_VERTEX",
      "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_ENTRYPOINT",
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(environment, key);
      if (descriptor !== undefined)
        Object.defineProperty(captured, key, descriptor);
    }
    return Object.freeze(captured);
  } catch {
    // The existing exact reader rejects this explicit undefined descriptor.
    // A malformed Claude-only environment cannot disable the Codex adapter.
    return Object.freeze({ PATH: undefined });
  }
};

// Pinned Linux Qn/Jn and Darwin er/Zn both reach the exact O selector.
// This is only the plaintext file path: Darwin's Keychain primary remains
// separate. The pure projection reads no credentials and proves no absence.
// Its caller must bind the native user-home path and original working directory.
export const claudePlaintextCredentialPath = (
  nativeHome: string,
  originalProject: string,
  environment: Readonly<Record<string, string | undefined>>,
): string => {
  const selected = exactEnvironmentValue(
    environment,
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  );
  const directory =
    selected === undefined
      ? claudeConfigurationDirectory(nativeHome, originalProject, environment)
      : exactAbsolutePath(
          resolve(
            exactAbsolutePath(originalProject),
            (
              selected || join(exactAbsolutePath(nativeHome), ".claude")
            ).normalize("NFC"),
          ),
        );
  return join(directory, ".credentials.json");
};

// Pinned Dtb -> me splits path.delimiter, discards empty entries, and maps
// Lnd -> Vo. Vo expands only ~ and ~/. Relative paths remain relative to the
// original project when the downstream filesystem consumer resolves them.
export const claudePluginDirectoryPath = (
  value: string,
  home: string,
  project: string,
): string =>
  exactAbsolutePath(
    resolve(
      exactAbsolutePath(project),
      value === "~" || value.startsWith("~/")
        ? exactAbsolutePath(home) + value.slice(1)
        : value,
    ),
  );

export const claudePluginSeedDirectories = (
  home: string,
  project: string,
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] => {
  const selected = exactEnvironmentValue(
    environment,
    "CLAUDE_CODE_PLUGIN_SEED_DIR",
  );
  return Object.freeze(
    selected
      ? selected
          .split(delimiter)
          .filter(Boolean)
          .map((path) => claudePluginDirectoryPath(path, home, project))
      : [],
  );
};

export type ClaudePluginVersionRoot = Readonly<{
  parentPath: string;
  paths: readonly string[];
}>;
export type ClaudePluginLoadingElection = Readonly<{
  paths: readonly string[];
  selectedPath: string;
  versionRoots?: readonly ClaudePluginVersionRoot[];
  localPath?: string;
}>;
export const claudePluginTemporaryVersion = (name: string): boolean =>
  /\.tmp~[0-9a-f]{8}$/.test(name);

export const claudeMarketplaceLoadingSource = (
  entry: Readonly<Record<string, unknown>>,
  source: Readonly<Record<string, unknown>>,
  marketplaceRoot: string,
  metadata?: unknown,
): Readonly<{
  entry: Readonly<Record<string, unknown>>;
  stringSource: boolean;
  localPath?: string;
  stubbed: boolean;
}> => {
  const unavailable = () =>
    new Error("cli.harness.plugin-inventory-unavailable");
  let relative = entry.source === "." ? "./" : entry.source;
  const pluginRoot = claudeMarketplacePluginRoot(metadata);
  if (
    pluginRoot !== undefined &&
    typeof relative === "string" &&
    /^[A-Za-z0-9][-A-Za-z0-9._]*$/.test(relative) &&
    !relative.includes("..")
  )
    relative =
      pluginRoot === "." ? `./${relative}` : `./${pluginRoot}/${relative}`;
  // Pinned xo/vo rewrite precedes go/co's whole-entry parse. Keep one owned
  // normalized entry for source selection, conflict and catalog hooks alike.
  const normalized = normalizeClaudeCatalogEntry({
    ...entry,
    source: relative,
  });
  if (normalized === undefined) throw unavailable();
  relative = normalized.source;
  const stringSource = typeof relative === "string";
  const stubbed =
    typeof relative === "object" &&
    relative !== null &&
    (relative as Record<string, unknown>).source === "unsupported" &&
    !(
      typeof entry.source === "object" &&
      entry.source !== null &&
      (entry.source as Record<string, unknown>).source === "unsupported"
    );
  const local = source.source === "file" || source.source === "directory";
  if (local && typeof source.path !== "string") throw unavailable();
  return Object.freeze({
    entry: normalized,
    stringSource,
    stubbed,
    ...(local && stringSource
      ? {
          localPath: exactAbsolutePath(
            resolve(marketplaceRoot, relative as string),
          ),
        }
      : {}),
  });
};

const claudeMarketplacePluginRoot = (metadata: unknown): string | undefined => {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    Object.getPrototypeOf(metadata) !== Object.prototype
  )
    return undefined;
  const root = (metadata as Record<string, unknown>).pluginRoot;
  if (
    typeof root !== "string" ||
    !root ||
    root.startsWith("/") ||
    root.includes("\\") ||
    root.includes(":")
  )
    return undefined;
  const normalized = root.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized === ".") return ".";
  return normalized
    .split("/")
    .some((segment) => !segment || segment === "." || segment === "..")
    ? undefined
    : normalized;
};

export const claudeMarketplaceManifestConflict = (
  entry: Readonly<Record<string, unknown>>,
  stubbed: boolean,
): boolean =>
  !stubbed &&
  entry.strict === false &&
  (["commands", "agents", "skills", "hooks", "outputStyles", "themes"].some(
    (key) => Boolean(entry[key]),
  ) ||
    Boolean(
      typeof entry.experimental === "object" && entry.experimental !== null
        ? (entry.experimental as Record<string, unknown>).themes
        : undefined,
    ));

// Re-elect from Core's held snapshot, never from the preliminary pathname
// listing. Exact-version roots precede YDo's one-nonempty-version fallback.
export const selectClaudePluginLoadingPath = (
  paths: readonly string[],
  directories: readonly HarnessDirectoryInspection[],
  versionRoots: readonly ClaudePluginVersionRoot[] = [],
  localPath?: string,
): string | undefined => {
  const inspect = (path: string) => {
    const found = directories.filter((entry) => entry.directoryPath === path);
    if (found.length !== 1)
      throw new Error("cli.harness.plugin-inventory-unavailable");
    return found[0]!;
  };
  const content = (path: string) => {
    const directory = inspect(path);
    return (
      directory.exists && directory.entries.some(claudePluginCacheContentName)
    );
  };
  if (localPath !== undefined) {
    if (paths.length !== 1 || paths[0] !== localPath || versionRoots.length)
      throw new Error("cli.harness.plugin-inventory-unavailable");
    return inspect(localPath).exists ? localPath : undefined;
  }
  for (const path of paths) if (content(path)) return path;
  for (const root of versionRoots) {
    const names = inspect(root.parentPath).entries.filter(
      (name) => !claudePluginTemporaryVersion(name),
    );
    const expected = new Set(names.map((name) => join(root.parentPath, name)));
    if (
      expected.size !== root.paths.length ||
      root.paths.some((path) => !expected.has(path))
    )
      throw new Error("cli.harness.plugin-inventory-unavailable");
    const nonempty = root.paths.filter(content);
    if (nonempty.length === 1) return nonempty[0];
  }
  return undefined;
};

export const createClaudeDiscoveryProbe = (
  input: Readonly<{
    environment: Readonly<Record<string, string | undefined>>;
    homeDirectory?: string;
    projectDirectory: string;
    platform: NodeJS.Platform;
    architecture: NodeJS.Architecture;
    policy?: ClaudeDiscoveryPolicy;
  }>,
  capabilities: ClaudeCodeDiscoveryReadCapabilities,
): HarnessDiscoveryProbe => {
  const {
    inspectPath: lstat,
    realpath,
    canonicalFutureDirectory,
    executableCandidates,
    authenticateExecutable,
  } = capabilities;
  const policy = input.policy ?? CLAUDE_DISCOVERY_POLICY;
  return Object.freeze({
    locateExecutable: async (names: readonly string[]) => {
      try {
        if (names.length !== 1 || names[0] !== "claude") return unavailable();
        return await executableCandidates(names, input.environment);
      } catch {
        return unavailable();
      }
    },
    readVersion: async (path: string, arguments_: readonly string[]) => {
      try {
        if (
          arguments_.length !== 1 ||
          arguments_[0] !== "--version" ||
          Object.getPrototypeOf(arguments_) !== Array.prototype
        )
          return unavailable();
        const identity =
          policy.platforms[`${input.platform}-${input.architecture}`];
        if (identity === undefined) return unavailable();
        const canonical = exactAbsolutePath(
          await realpath(exactAbsolutePath(path)),
        );
        await authenticateExecutable(canonical, identity, 0o755);
        return Object.freeze({
          kind: "observed" as const,
          output: `${policy.version} (Claude Code)\n`,
        });
      } catch {
        return unavailable();
      }
    },
    inspectConfiguration: async (locations: readonly (readonly string[])[]) => {
      if (
        input.homeDirectory === undefined ||
        locations.length !== 1 ||
        Object.getPrototypeOf(locations[0]) !== Array.prototype ||
        locations[0]!.join("\0") !==
          claudeCodeDescriptor.configuration.locationSegments[0]!.join("\0")
      )
        throw new Error("cli.harness.probe-unavailable");
      const path = claudeUserConfiguration(
        input.homeDirectory,
        input.projectDirectory,
        input.environment,
      ).settingsPath;
      if ((await canonicalFutureDirectory(dirname(path))) !== dirname(path))
        throw new Error("cli.harness.probe-unavailable");
      try {
        const state = await lstat(path);
        if (state.kind !== "file" || state.symbolicLink)
          throw new Error("cli.harness.probe-unavailable");
        return [Object.freeze({ locationIndex: 0, present: true })];
      } catch (error) {
        const code: unknown =
          typeof error === "object" && error !== null
            ? Object.getOwnPropertyDescriptor(error, "code")?.value
            : undefined;
        if (code === "ENOENT" || code === "ENOTDIR")
          return [Object.freeze({ locationIndex: 0, present: false })];
        throw error;
      }
    },
  });
};
