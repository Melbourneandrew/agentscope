import { basename, dirname, join, resolve } from "node:path";
import { lstat } from "node:fs/promises";

import {
  CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID,
  CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST,
  CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST,
  type ClaudeCodePluginInventory,
} from "@agentscope/harness-claude-code";

import {
  readClaudeInstalledPluginRegistry,
  readClaudePluginTextDocument,
  readClaudePluginManifest,
  readClaudePluginHooks,
  type ClaudePluginCacheElection,
} from "./claude-plugin-inventory.js";
import {
  claudeUserConfiguration,
  claudePluginDirectoryPath,
  claudePluginSeedDirectories,
  claudePluginTemporaryVersion,
  type ClaudePluginLoadingElection,
  type ClaudePluginVersionRoot,
} from "./claude-discovery.js";
import {
  exactAbsolutePath,
  exactEnvironmentValue,
  nodeErrorCode,
  type ProductHarnessReadGuard,
  discoverClaudeCacheRecord,
  discoverClaudeDirectoryEntries,
} from "./product-harness-probe-files.js";
import { collectClaudeMarketplaceLoads } from "./claude-marketplace-context.js";
import { projectClaudeParsedSettings } from "./claude-settings-projection.js";
import {
  discoverClaudeManagedSettings,
  claudeManagedSettingsPath,
  readClaudeScopedSettings,
  type ClaudeSettingsDirectorySelection,
} from "./claude-managed-settings.js";

const unavailable = (): Error =>
  new Error("cli.harness.plugin-inventory-unavailable");
type InstalledPlugin = ClaudeCodePluginInventory["installedPlugins"][number];

export type ClaudePluginContext = Readonly<{
  pluginInventory: ClaudeCodePluginInventory;
  readGuards: readonly ProductHarnessReadGuard[];
  cacheElections: readonly ClaudePluginCacheElection[];
  settingsDirectorySelections: readonly ClaudeSettingsDirectorySelection[];
}>;

export type ClaudePluginContextObservation = Readonly<
  Omit<ClaudePluginContext, "pluginInventory"> & {
    // Unavailable is not an empty effective inventory. Only the held-context
    // election may decide whether this branch's failure is applicable.
    pluginInventory: ClaudeCodePluginInventory | null;
  }
>;

type ContextObservations = Readonly<{
  guards: Map<string, ProductHarnessReadGuard>;
  settingsDirectorySelections: ClaudeSettingsDirectorySelection[];
}>;

const effectivePluginSelections = (
  layers: ClaudeCodePluginInventory["settingsLayers"],
): ReadonlyMap<string, boolean | readonly string[]> =>
  new Map(Object.entries(projectClaudeParsedSettings(layers).enabledPlugins));

const pluginRegistryRoot = (
  home: string,
  project: string,
  environment: Readonly<Record<string, string | undefined>>,
  configurationDirectory: string,
): string => {
  // Pinned cpe/ipe use Di's cache root. Ctb gives a truthy override precedence;
  // Vo expands only ~ and ~/. The default fresh host is non-cowork, while the
  // explicit environment selector uses string truthiness, not parsed booleans.
  const override = exactEnvironmentValue(
    environment,
    "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  );
  if (override) return claudePluginDirectoryPath(override, home, project);
  return join(
    configurationDirectory,
    exactEnvironmentValue(environment, "CLAUDE_CODE_USE_COWORK_PLUGINS")
      ? "cowork_plugins"
      : "plugins",
  );
};

// In-progress composition: multi-record election/worktree/fallback closures
// remain incomplete. Single applicable physical caches are observed below.
// No temporary limitation is a permanent eligibility rule or support claim.
const collectClaudePluginContext = async (
  input: Readonly<{
    homeDirectory: string;
    projectDirectory: string;
    // Preliminary route only: installation must select this context using
    // ownership facts held by its original Core plan before any mutation.
    localSettingsRoot?: string;
    platform: NodeJS.Platform;
    environment?: Readonly<Record<string, string | undefined>>;
  }>,
  observations?: ContextObservations,
): Promise<ClaudePluginContext> => {
  const guards =
    observations?.guards ?? new Map<string, ProductHarnessReadGuard>();
  const settingsDirectorySelections =
    observations?.settingsDirectorySelections ?? [];
  const home = exactAbsolutePath(input.homeDirectory);
  const project = exactAbsolutePath(input.projectDirectory);
  const localSettingsRoot =
    input.localSettingsRoot === undefined
      ? project
      : exactAbsolutePath(input.localSettingsRoot);
  const configuration = claudeUserConfiguration(
    home,
    project,
    input.environment ?? {},
  );
  const registryRoot = pluginRegistryRoot(
    home,
    project,
    input.environment ?? {},
    configuration.directory,
  );
  const managed = claudeManagedSettingsPath(input.platform);
  const managedSources = await discoverClaudeManagedSettings(managed);
  settingsDirectorySelections.push(
    managedSources.selection,
    ...(managedSources.ignoredDirectories ?? []).map((directoryPath) =>
      Object.freeze({ directoryPath, exists: true }),
    ),
  );
  const observed = await readClaudeScopedSettings(
    configuration.settingsPath,
    project,
    managedSources.paths,
    localSettingsRoot,
  );
  const registry = await readClaudeInstalledPluginRegistry(
    join(registryRoot, "installed_plugins.json"),
  );
  for (const guard of [...observed.map((entry) => entry.guard), registry.guard])
    retainGuard(guards, guard);
  const enabled = effectivePluginSelections(
    observed.map((entry) => entry.layer),
  );
  const installedPlugins: InstalledPlugin[] = [];
  const cacheElections: ClaudePluginCacheElection[] = [];
  const loading = await collectClaudeMarketplaceLoads(
    registryRoot,
    enabled,
    retainGuard.bind(undefined, guards),
  );
  // Source-policy admission remains separate from catalog rename projection.
  for (const { id, marketplace } of loading.loads) {
    const locations = registry.locations.filter(
      (entry) => entry.pluginId === id,
    );
    const applicable = await applicablePluginLocations(
      locations,
      project,
      guards,
      settingsDirectorySelections,
    );
    const preliminary = await discoverClaudeCacheRecord(
      applicable.map((location) => location.installPath),
    );
    if (preliminary.index === undefined) throw unavailable();
    const location = applicable[preliminary.index]!;
    if (location.installPath.endsWith(".zip")) throw unavailable();
    const loading = await discoverCachedLoadingPath(
      location.installPath,
      id,
      () =>
        marketplace.stringSource
          ? claudePluginSeedDirectories(home, project, input.environment ?? {})
          : [],
      marketplace.localPath,
    );
    const manifest = await readClaudePluginManifest(loading.selectedPath);
    retainGuard(guards, manifest.guard);
    if (manifest.guard.exists && marketplace.conflictsWithManifest)
      throw unavailable();
    const hooks = await readClaudePluginHooks({
      installPath: loading.selectedPath,
      manifest,
      marketplaceHooksDeclarationJson: marketplace.hooksDeclarationJson,
    });
    for (const guard of hooks.readGuards) retainGuard(guards, guard);
    const selectedPlugin = observedPlugin(id, manifest, hooks);
    installedPlugins.push(selectedPlugin);
    cacheElections.push(
      collectedCacheElection(
        applicable,
        preliminary.index,
        selectedPlugin,
        loading,
        preliminary.directoryPaths,
      ),
    );
  }
  return collectedContext(
    observed.map((entry) => entry.layer),
    installedPlugins,
    guards,
    cacheElections,
    {
      settingsDirectorySelections,
      loadSelections: loading.loadSelections,
    },
  );
};

const collectedContext = (
  layers: ClaudeCodePluginInventory["settingsLayers"],
  installedPlugins: InstalledPlugin[],
  guards: Map<string, ProductHarnessReadGuard>,
  cacheElections: ClaudePluginCacheElection[],
  selection: Readonly<{
    settingsDirectorySelections: readonly ClaudeSettingsDirectorySelection[];
    loadSelections?: ClaudeCodePluginInventory["loadSelections"];
  }>,
): ClaudePluginContext =>
  Object.freeze({
    pluginInventory: Object.freeze({
      settingsLayers: Object.freeze(layers),
      installedPlugins: Object.freeze(installedPlugins),
      ...(selection.loadSelections === undefined
        ? {}
        : { loadSelections: selection.loadSelections }),
    }),
    readGuards: Object.freeze([...guards.values()]),
    cacheElections: Object.freeze(cacheElections),
    settingsDirectorySelections: Object.freeze(
      selection.settingsDirectorySelections,
    ),
  });

const collectedCacheElection = (
  locations: readonly Readonly<{ installPath: string }>[],
  selected: number,
  plugin: InstalledPlugin,
  loading: ClaudePluginLoadingElection,
  prefix: readonly string[],
): ClaudePluginCacheElection =>
  Object.freeze({
    directoryPaths: Object.freeze(
      Array.from(
        new Set([
          ...prefix,
          ...loading.paths,
          ...(loading.versionRoots?.flatMap((root) => [
            root.parentPath,
            ...root.paths,
          ]) ?? []),
        ]),
      ),
    ),
    candidates: Object.freeze(
      locations.map((candidate, index) =>
        Object.freeze({
          installPath: candidate.installPath,
          ...(index === selected ? { loading } : {}),
          plugin: index === selected ? plugin : null,
        }),
      ),
    ),
  });

// Native dLo's cached nonlocal string route tries the recorded cache first,
// then JIn's exact version across seed roots. Its YDo fallback is collected
// separately; an unobserved fallback is never fabricated as an empty plugin.
const discoverCachedLoadingPath = async (
  cachePath: string,
  id: string,
  seedRoots: () => readonly string[],
  localPath?: string,
): Promise<ClaudePluginLoadingElection> => {
  if (localPath !== undefined) {
    const state = await lstat(localPath);
    if (state.isSymbolicLink() || !state.isDirectory()) throw unavailable();
    return Object.freeze({
      paths: Object.freeze([localPath]),
      selectedPath: localPath,
      localPath,
    });
  }
  const cached = await discoverClaudeCacheRecord([cachePath], false);
  if (cached.index !== undefined)
    return Object.freeze({
      paths: cached.directoryPaths,
      selectedPath: cachePath,
    });
  const parts = id.split("@");
  if (parts.length !== 2 || parts.some((part) => !part)) throw unavailable();
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9\-_]/g, "-");
  let version = basename(cachePath)
    .replace(/\.zip$/, "")
    .replace(/[^a-zA-Z0-9\-_.]/g, "-");
  if (version === "." || version === "..") version = "-";
  const roots = seedRoots().map((root) =>
    join(root, "cache", safe(parts[1]!), safe(parts[0]!)),
  );
  const paths = [cachePath, ...roots.map((root) => join(root, version))];
  const observed = await discoverClaudeCacheRecord(paths, false);
  if (observed.index === undefined)
    return discoverAlternateSeedVersion(paths, roots);
  return Object.freeze({
    paths: observed.directoryPaths,
    selectedPath: paths[observed.index]!,
  });
};

const discoverAlternateSeedVersion = async (
  paths: readonly string[],
  roots: readonly string[],
): Promise<ClaudePluginLoadingElection> => {
  const versionRoots: ClaudePluginVersionRoot[] = [];
  for (const parentPath of roots) {
    const names = (await discoverClaudeDirectoryEntries(parentPath)).filter(
      (name) => !claudePluginTemporaryVersion(name),
    );
    const children = names.map((name) => join(parentPath, name));
    versionRoots.push(
      Object.freeze({ parentPath, paths: Object.freeze(children) }),
    );
    const nonempty: string[] = [];
    for (const child of children)
      if ((await discoverClaudeCacheRecord([child], false)).index !== undefined)
        nonempty.push(child);
    if (nonempty.length === 1)
      return Object.freeze({
        paths: Object.freeze([...paths]),
        selectedPath: nonempty[0]!,
        versionRoots: Object.freeze(versionRoots),
      });
  }
  throw unavailable();
};

export const readClaudePluginContext = async (
  input: Parameters<typeof collectClaudePluginContext>[0],
): Promise<ClaudePluginContext> => {
  try {
    return await collectClaudePluginContext(input);
  } catch {
    throw unavailable();
  }
};

export const readClaudePluginContextObservation = async (
  input: Parameters<typeof collectClaudePluginContext>[0],
): Promise<ClaudePluginContextObservation> => {
  const observations: ContextObservations = {
    guards: new Map(),
    settingsDirectorySelections: [],
  };
  try {
    return await collectClaudePluginContext(input, observations);
  } catch {
    return Object.freeze({
      pluginInventory: null,
      readGuards: Object.freeze([...observations.guards.values()]),
      cacheElections: Object.freeze([]),
      settingsDirectorySelections: Object.freeze([
        ...observations.settingsDirectorySelections,
      ]),
    });
  }
};

export const mergeClaudePluginReadGuards = (
  groups: readonly (readonly ProductHarnessReadGuard[])[],
): readonly ProductHarnessReadGuard[] => {
  const guards = new Map<string, ProductHarnessReadGuard>();
  for (const group of groups)
    for (const guard of group) retainGuard(guards, guard);
  return Object.freeze([...guards.values()]);
};

const retainGuard = (
  guards: Map<string, ProductHarnessReadGuard>,
  guard: ProductHarnessReadGuard,
): void => {
  const existing = guards.get(guard.targetPath);
  if (
    existing !== undefined &&
    JSON.stringify(existing) !== JSON.stringify(guard)
  )
    throw unavailable();
  guards.set(guard.targetPath, guard);
  // Three existing owned installation files share Core's original 16 targets.
  if (guards.size > 13) throw unavailable();
};

// Native zDe's Ns is Er: locate .git from originalCwd, then ye resolves the
// linked-worktree gitdir/commondir/backlink. Text uses the SAME bounded reader
// and Core guards; consulted directories use the existing selection guards.
// No Git process, directory token, or new authority is minted.
const canonicalProjectRoot = async (
  requested: string,
  guards: Map<string, ProductHarnessReadGuard>,
  selections: ClaudeSettingsDirectorySelection[],
): Promise<string | null> => {
  let root = exactAbsolutePath(requested);
  for (;;) {
    const marker = join(root, ".git");
    let state;
    try {
      state = await lstat(marker);
    } catch (error) {
      const code: unknown =
        typeof error === "object" && error !== null
          ? Object.getOwnPropertyDescriptor(error, "code")?.value
          : undefined;
      if (code !== "ENOENT") throw unavailable();
      const absent = await readClaudePluginTextDocument(marker);
      if (absent.guard.exists) throw unavailable();
      retainGuard(guards, absent.guard);
      if (dirname(root) === root) return null;
      root = dirname(root);
      continue;
    }
    if (state.isSymbolicLink()) throw unavailable();
    if (state.isDirectory()) {
      // Native Kt accepts the directory itself; it does not consult HEAD.
      // Core binds that directory through the existing selection pipeline.
      selections.push(Object.freeze({ directoryPath: marker, exists: true }));
      return root;
    }
    if (!state.isFile()) throw unavailable();
    const git = await readClaudePluginTextDocument(marker);
    retainGuard(guards, git.guard);
    if (git.text === undefined) throw unavailable();
    if (!git.text.trim().startsWith("gitdir:")) return root;
    const gitdir = resolve(root, git.text.trim().slice(7).trim());
    const common = await readClaudePluginTextDocument(
      join(gitdir, "commondir"),
    );
    retainGuard(guards, common.guard);
    if (common.text === undefined) return root;
    const commonPath = resolve(gitdir, common.text.trim());
    if (resolve(dirname(gitdir)) !== join(commonPath, "worktrees")) return root;
    const backlink = await readClaudePluginTextDocument(join(gitdir, "gitdir"));
    retainGuard(guards, backlink.guard);
    if (
      backlink.text === undefined ||
      resolve(gitdir, backlink.text.trim()) !== marker
    )
      return root;
    const canonical =
      basename(commonPath) === ".git" ? dirname(commonPath) : commonPath;
    return canonical;
  }
};

// This discovers routes only. The caller must put every returned guard and
// directory selection in the original Core plan; no lstat UID selects a root.
export const discoverClaudeCanonicalSettingsRoot = async (
  projectDirectory: string,
  realHome: string | null,
) => {
  const guards = new Map<string, ProductHarnessReadGuard>();
  const selections: ClaudeSettingsDirectorySelection[] = [];
  const candidate = await canonicalProjectRoot(
    projectDirectory,
    guards,
    selections,
  );
  if (
    candidate !== null &&
    candidate !== projectDirectory &&
    realHome !== null &&
    candidate !== realHome
  ) {
    for (const path of [
      candidate,
      join(candidate, ".git"),
      join(candidate, ".claude"),
    ]) {
      let state;
      try {
        state = await lstat(path);
      } catch (error) {
        if (nodeErrorCode(error) !== "ENOENT" || path === candidate)
          throw unavailable();
        selections.push(Object.freeze({ directoryPath: path, exists: false }));
        continue;
      }
      if (state.isSymbolicLink()) throw unavailable();
      if (state.isDirectory())
        selections.push(Object.freeze({ directoryPath: path, exists: true }));
      else if (path === join(candidate, ".git") && state.isFile()) {
        const observed = await readClaudePluginTextDocument(path);
        if (!observed.guard.exists) throw unavailable();
        retainGuard(guards, observed.guard);
      } else throw unavailable();
    }
  }
  const directories = new Map<string, ClaudeSettingsDirectorySelection>();
  for (const entry of selections) {
    const previous = directories.get(entry.directoryPath);
    if (
      previous !== undefined &&
      JSON.stringify(previous) !== JSON.stringify(entry)
    )
      throw unavailable();
    directories.set(entry.directoryPath, entry);
  }
  return Object.freeze({
    candidate,
    readGuards: Object.freeze([...guards.values()]),
    settingsDirectorySelections: Object.freeze([...directories.values()]),
  });
};

const applicablePluginLocations = async (
  locations: Awaited<
    ReturnType<typeof readClaudeInstalledPluginRegistry>
  >["locations"],
  project: string,
  guards: Map<string, ProductHarnessReadGuard>,
  selections: ClaudeSettingsDirectorySelection[],
) => {
  // zDe compares canonical Git roots. Retain each consulted preimage before
  // deciding that a differing project record is inapplicable.
  const applicable = [];
  for (const entry of locations) {
    if (
      entry.scope === "user" ||
      entry.scope === "managed" ||
      entry.projectPath === project
    )
      applicable.push(entry);
    else if (entry.projectPath !== null) {
      const current = await canonicalProjectRoot(project, guards, selections);
      if (
        current !== null &&
        (await canonicalProjectRoot(entry.projectPath, guards, selections)) ===
          current
      )
        applicable.push(entry);
    }
  }
  return applicable;
};

const exactOfficialExporter = (
  plugin: ClaudeCodePluginInventory["installedPlugins"][number],
): boolean =>
  plugin.pluginId === CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID &&
  plugin.manifestName === "langfuse-observability" &&
  plugin.manifestVersion === "1.0.0" &&
  plugin.manifestDigest === CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST &&
  plugin.hooksDigest === CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST &&
  plugin.hookEvents.length === 2 &&
  ["Stop", "SessionEnd"].every((event) => plugin.hookEvents.includes(event));

const observedPlugin = (
  id: string,
  manifest: Awaited<ReturnType<typeof readClaudePluginManifest>>,
  hooks: Awaited<ReturnType<typeof readClaudePluginHooks>>,
): InstalledPlugin => {
  const plugin = Object.freeze({
    pluginId: id,
    installedRegistryId: id,
    cachePluginId: id,
    manifestName: manifest.manifestName,
    manifestVersion: manifest.manifestVersion,
    manifestDigest: manifest.guard.exists
      ? `sha256-${manifest.guard.digest}`
      : null,
    hooksDigest: hooks.hooksDigest,
    hookEvents: hooks.hookEvents,
    directTraceExporter: null as boolean | null,
  });
  return Object.freeze({
    ...plugin,
    directTraceExporter: exactOfficialExporter(plugin) ? true : null,
  });
};

export { readClaudePluginHooks } from "./claude-plugin-inventory.js";
