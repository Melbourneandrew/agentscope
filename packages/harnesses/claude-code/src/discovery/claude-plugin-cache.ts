import { basename, join } from "node:path";
import type { ClaudeCodePluginInventory } from "../lifecycle.js";
import type { ClaudePluginCacheElection } from "./claude-plugin-inventory.js";
import {
  claudePluginTemporaryVersion,
  type ClaudePluginLoadingElection,
  type ClaudePluginVersionRoot,
} from "./claude-discovery.js";
import {
  discoverClaudeCacheRecord,
  type ClaudeCodeDiscoveryReadCapabilities,
} from "./capabilities.js";
type InstalledPlugin = ClaudeCodePluginInventory["installedPlugins"][number];
const unavailable = () => new Error("cli.harness.plugin-inventory-unavailable");

export const collectedCacheElection = (
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
export const discoverCachedLoadingPath = async (
  capabilities: ClaudeCodeDiscoveryReadCapabilities,
  cachePath: string,
  id: string,
  seedRoots: () => readonly string[],
  localPath?: string,
): Promise<ClaudePluginLoadingElection> => {
  if (localPath !== undefined) {
    const state = await capabilities.inspectPath(localPath);
    if (state.symbolicLink || !(state.kind === "directory"))
      throw unavailable();
    return Object.freeze({
      paths: Object.freeze([localPath]),
      selectedPath: localPath,
      localPath,
    });
  }
  const cached = await discoverClaudeCacheRecord(
    capabilities,
    [cachePath],
    false,
  );
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
  const observed = await discoverClaudeCacheRecord(capabilities, paths, false);
  if (observed.index === undefined)
    return discoverAlternateSeedVersion(capabilities, paths, roots);
  return Object.freeze({
    paths: observed.directoryPaths,
    selectedPath: paths[observed.index]!,
  });
};

const discoverAlternateSeedVersion = async (
  capabilities: ClaudeCodeDiscoveryReadCapabilities,
  paths: readonly string[],
  roots: readonly string[],
): Promise<ClaudePluginLoadingElection> => {
  const versionRoots: ClaudePluginVersionRoot[] = [];
  for (const parentPath of roots) {
    const names = (await capabilities.readDirectoryEntries(parentPath)).filter(
      (name) => !claudePluginTemporaryVersion(name),
    );
    const children = names.map((name) => join(parentPath, name));
    versionRoots.push(
      Object.freeze({ parentPath, paths: Object.freeze(children) }),
    );
    const nonempty: string[] = [];
    for (const child of children)
      if (
        (await discoverClaudeCacheRecord(capabilities, [child], false))
          .index !== undefined
      )
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
