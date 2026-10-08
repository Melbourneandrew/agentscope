import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { ClaudeCodePluginInventory } from "../lifecycle.js";
import type { HarnessDirectoryInspection } from "@agentscope/harnesses-core";
import type { ClaudePluginLoadingElection } from "./claude-discovery.js";
export { selectClaudePluginLoadingPath } from "./claude-discovery.js";
import { claudePluginHookEventNames } from "./claude-catalog-transports.js";
import { parseClaudeEnabledPluginsSettingsSource } from "./claude-settings-projection.js";
export { claudePluginHookEventNames };

import {
  type ClaudeCodeDiscoveryReadCapabilities,
  exactAbsolutePath,
  type ProductHarnessReadGuard,
  type ClaudePluginDocument,
  claudePluginCacheContentName,
} from "./capabilities.js";

// These documents enter the existing Core transaction as consulted read targets.
// Do not relax its per-target byte bound or mint another installation plan.
const unavailable = (): Error =>
  new Error("cli.harness.plugin-inventory-unavailable");

// Pinned 2.1.245 KDo/eV/sV: preserve registry order, prefer the first
// nonempty cache for multiple applicable records, otherwise keep the first.
// UIe's imported constants resolve to these three bookkeeping marker names.
// This is only record election, not dLo's later cache/seed loading decision.

export type ClaudePluginCacheElection = Readonly<{
  directoryPaths?: readonly string[];
  candidates: readonly Readonly<{
    installPath: string;
    loading?: ClaudePluginLoadingElection;
    plugin: ClaudeCodePluginInventory["installedPlugins"][number] | null;
  }>[];
}>;

export const claudePluginCacheHasContent = (
  directory: HarnessDirectoryInspection,
): boolean =>
  directory.exists && directory.entries.some(claudePluginCacheContentName);

export const selectClaudePluginCacheRecord = (
  installPaths: readonly string[],
  directories: readonly HarnessDirectoryInspection[],
): number | undefined => {
  if (installPaths.length === 0) return undefined;
  if (installPaths.length === 1) return 0;
  const inspections = new Map<string, HarnessDirectoryInspection>();
  for (const directory of directories) {
    if (inspections.has(directory.directoryPath)) throw unavailable();
    inspections.set(directory.directoryPath, directory);
  }
  // Native KDo stops at its first nonempty candidate. Every directory consumed
  // up to that point must be in the SAME held Core snapshot; later records
  // cannot become extra eligibility requirements or mutation dependencies.
  for (const [index, path] of installPaths.entries()) {
    if (path.endsWith(".zip")) throw unavailable();
    const inspection = inspections.get(exactAbsolutePath(path));
    if (inspection === undefined) throw unavailable();
    if (claudePluginCacheHasContent(inspection)) return index;
  }
  return 0;
};

export const readClaudePluginDocument = async (
  capabilities: ClaudeCodeDiscoveryReadCapabilities,
  requestedPath: string,
): Promise<ClaudePluginDocument> => {
  const document = await capabilities.readTextDocument(requestedPath);
  try {
    const value: unknown = document.guard.exists
      ? JSON.parse(document.text!)
      : undefined;
    return Object.freeze({ guard: document.guard, value });
  } catch {
    throw unavailable();
  }
};

type SettingsLayer = ClaudeCodePluginInventory["settingsLayers"][number];

export const readClaudePluginSettingsLayer = async (
  capabilities: ClaudeCodeDiscoveryReadCapabilities,
  path: string,
  scope: SettingsLayer["scope"],
): Promise<
  Readonly<{ guard: ProductHarnessReadGuard; layer: SettingsLayer }>
> => {
  const document = await readClaudePluginDocument(capabilities, path);
  let enabledPlugins: SettingsLayer["enabledPlugins"] = Object.freeze({});
  if (document.guard.exists) {
    const value = dataRecord(document.value);
    if (value === undefined) throw unavailable();
    const parsed = parseClaudeEnabledPluginsSettingsSource(
      value,
      scope === "managed",
    );
    if (parsed.kind === "parsed" && parsed.enabledPlugins !== undefined) {
      const values = Object.entries(parsed.enabledPlugins);
      if (
        values.length > 256 ||
        values.some(
          ([key]) => key.length === 0 || Buffer.byteLength(key, "utf8") > 512,
        )
      )
        throw unavailable();
      enabledPlugins = parsed.enabledPlugins;
    }
  }
  // One file is one observed layer, not a globally effective plugin inventory.
  // The composition must include every applicable selected higher-priority layer.
  return Object.freeze({
    guard: document.guard,
    layer: Object.freeze({
      scope,
      targetPath: document.guard.targetPath,
      targetDigest: document.guard.digest,
      targetExists: document.guard.exists,
      enabledPlugins,
    }),
  });
};

type InstalledPluginLocation = Readonly<{
  pluginId: string;
  scope: SettingsLayer["scope"];
  projectPath: string | null;
  installPath: string;
  version: string | null;
}>;

const dataRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype
    ? (value as Record<string, unknown>)
    : undefined;

const boundedString = (
  value: unknown,
  maximumBytes: number,
  allowEmpty = false,
): value is string =>
  typeof value === "string" &&
  (allowEmpty || value.length > 0) &&
  Buffer.byteLength(value, "utf8") <= maximumBytes &&
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    value,
  );

export const readClaudePluginManifest = async (
  capabilities: ClaudeCodeDiscoveryReadCapabilities,
  installPath: string,
): Promise<
  Readonly<{
    guard: ProductHarnessReadGuard;
    manifestName: string | null;
    manifestVersion: string | null;
    hasDeclaredHooks: boolean;
    hooksDeclarationJson: string | null;
  }>
> => {
  const document = await readClaudePluginDocument(
    capabilities,
    join(exactAbsolutePath(installPath), ".claude-plugin", "plugin.json"),
  );
  if (!document.guard.exists)
    return Object.freeze({
      guard: document.guard,
      manifestName: null,
      manifestVersion: null,
      hasDeclaredHooks: false,
      hooksDeclarationJson: null,
    });
  const manifest = dataRecord(document.value);
  if (
    manifest === undefined ||
    !boundedString(manifest.name, 512) ||
    manifest.name.includes(" ") ||
    (manifest.version !== undefined &&
      !boundedString(manifest.version, 512, true))
  )
    throw unavailable();
  // This is observed metadata only. Absence is never an inferred marketplace
  // name/version, no default-hook claim, or an exporter classification.
  return Object.freeze({
    guard: document.guard,
    manifestName: manifest.name,
    manifestVersion: manifest.version ?? null,
    hasDeclaredHooks: Object.hasOwn(manifest, "hooks"),
    // Retain the same observed declaration as immutable data for the version-
    // bound composition. Null is absence; even an observed null is JSON text.
    // This is not a command, a resolved path, or evidence of effective hooks.
    hooksDeclarationJson: Object.hasOwn(manifest, "hooks")
      ? JSON.stringify(manifest.hooks)
      : null,
  });
};

const installedPluginLocation = (
  pluginId: string,
  value: unknown,
): InstalledPluginLocation => {
  const record = dataRecord(value);
  if (
    record === undefined ||
    !["managed", "user", "project", "local"].includes(record.scope as string) ||
    !boundedString(record.installPath, 4_096) ||
    (record.projectPath !== undefined &&
      !boundedString(record.projectPath, 4_096)) ||
    (record.version !== undefined && !boundedString(record.version, 512))
  )
    throw unavailable();
  return Object.freeze({
    pluginId,
    scope: record.scope as SettingsLayer["scope"],
    installPath: exactAbsolutePath(record.installPath),
    projectPath:
      record.projectPath === undefined
        ? null
        : exactAbsolutePath(record.projectPath),
    version: record.version ?? null,
  });
};

const legacyPluginLocation = (
  root: string,
  pluginId: string,
  value: unknown,
): InstalledPluginLocation => {
  const record = dataRecord(value);
  if (
    record === undefined ||
    !boundedString(record.version, 512) ||
    typeof record.installedAt !== "string" ||
    typeof record.installPath !== "string" ||
    !/^[A-Za-z0-9][-A-Za-z0-9._]*(?:@[A-Za-z0-9][-A-Za-z0-9._]*)?$/u.test(
      pluginId,
    )
  )
    throw unavailable();
  const [name, market = "unknown"] = pluginId.split("@");
  const segment = (text: string): string =>
    text.replace(/[^A-Za-z0-9\-_]/gu, "-");
  const version = record.version.replace(/[^A-Za-z0-9\-_.]/gu, "-");
  return installedPluginLocation(pluginId, {
    scope: "user",
    version: record.version,
    // Native UDe/MR derives this cache path. The historical recorded path is
    // required by its V1 schema but is not the directory the V2 loader uses.
    installPath: join(
      root,
      "cache",
      segment(market),
      segment(name!),
      version === "." || version === ".." ? "-" : version,
    ),
  });
};

export const readClaudeInstalledPluginRegistry = async (
  capabilities: ClaudeCodeDiscoveryReadCapabilities,
  path: string,
): Promise<
  Readonly<{
    guard: ProductHarnessReadGuard;
    locations: readonly InstalledPluginLocation[];
  }>
> => {
  try {
    const document = await readClaudePluginDocument(capabilities, path);
    const locations: InstalledPluginLocation[] = [];
    if (document.guard.exists) {
      const registry = dataRecord(document.value);
      const plugins = dataRecord(registry?.plugins);
      // Exact 2.1.245 reads installed_plugins.json. The _v2 filename is a
      // migration input, not a fallback. V1 derives cache paths differently.
      if (
        (registry?.version !== 1 && registry?.version !== 2) ||
        plugins === undefined
      )
        throw unavailable();
      const entries = Object.entries(plugins);
      if (entries.length > 128) throw unavailable();
      for (const [pluginId, records] of entries) {
        if (!boundedString(pluginId, 512)) throw unavailable();
        if (registry.version === 1) {
          locations.push(
            legacyPluginLocation(
              dirname(document.guard.targetPath),
              pluginId,
              records,
            ),
          );
          continue;
        }
        if (!Array.isArray(records) || locations.length + records.length > 128)
          throw unavailable();
        for (const value of records) {
          locations.push(installedPluginLocation(pluginId, value));
        }
      }
    }
    // Preserve every scoped observation. The native current-project selection
    // and cache identity checks belong to the subsequent inventory composition,
    // never an arbitrary first-record choice or a fabricated manifest version.
    return Object.freeze({
      guard: document.guard,
      locations: Object.freeze(locations),
    });
  } catch {
    throw unavailable();
  }
};

type Manifest = Awaited<ReturnType<typeof readClaudePluginManifest>>;

const record = (value: unknown): Record<string, unknown> => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw unavailable();
  return value as Record<string, unknown>;
};

const declarationPath = (root: string, declaration: string): string => {
  if (declaration.length === 0 || isAbsolute(declaration)) throw unavailable();
  const path = resolve(root, declaration);
  const child = relative(root, path);
  if (child === "" || child === ".." || child.startsWith("../"))
    throw unavailable();
  return path;
};

export type ClaudePluginHooksObservation = Readonly<{
  hookEvents: readonly string[];
  hooksDigest: string | null;
  directTraceExporter: null;
  readGuards: readonly ProductHarnessReadGuard[];
}>;

// Native 2.1.245 qgt always reads hooks/hooks.json, then merges manifest.hooks;
// aMn/_In subsequently applies the selected marketplace entry's inline hooks.
// The caller must obtain that entry from its authenticated marketplace document.
// This helper does not select a plugin, establish marketplace identity, or claim
// complete current-context coverage. Its returned observations need those guards
// in the SAME Core installation plan before any owned mutation.
const collectClaudePluginHooks = async (
  capabilities: ClaudeCodeDiscoveryReadCapabilities,
  input: Readonly<{
    installPath: string;
    manifest: Manifest;
    marketplaceHooksDeclarationJson: string | null;
  }>,
): Promise<ClaudePluginHooksObservation> => {
  const root = exactAbsolutePath(input.installPath);
  const guards = new Map<string, ProductHarnessReadGuard>();
  const events = new Set<string>();
  const addDocument = (document: ClaudePluginDocument): void => {
    const previous = guards.get(document.guard.targetPath);
    if (
      previous !== undefined &&
      JSON.stringify(previous) !== JSON.stringify(document.guard)
    )
      throw unavailable();
    guards.set(document.guard.targetPath, document.guard);
    if (guards.size > 16) throw unavailable();
    if (document.guard.exists)
      for (const event of claudePluginHookEventNames(
        record(document.value).hooks,
      ))
        events.add(event);
  };
  const defaultPath = resolve(root, "hooks", "hooks.json");
  const defaults = await readClaudePluginDocument(capabilities, defaultPath);
  addDocument(defaults);
  const raw = input.manifest.hooksDeclarationJson;
  if (raw !== null) {
    const declaration: unknown = JSON.parse(raw);
    const declarations = Array.isArray(declaration)
      ? declaration
      : [declaration];
    if (declarations.length > 64) throw unavailable();
    for (const entry of declarations) {
      if (typeof entry === "string") {
        const path = declarationPath(root, entry);
        // Native strict mode treats a repeated default/custom file as an error.
        if (guards.has(path)) throw unavailable();
        const custom = await readClaudePluginDocument(capabilities, path);
        if (!custom.guard.exists) throw unavailable();
        addDocument(custom);
      } else
        for (const event of claudePluginHookEventNames(entry))
          events.add(event);
    }
  }
  mergeMarketplaceHookEvents(
    events,
    input.marketplaceHooksDeclarationJson,
    input.manifest.guard.exists,
  );
  if (events.size > 64) throw unavailable();
  return Object.freeze({
    hookEvents: Object.freeze([...events]),
    hooksDigest: defaults.guard.exists
      ? `sha256-${defaults.guard.digest}`
      : null,
    // Hook commands are not interpreted or guessed to be non-exporters.
    directTraceExporter: null,
    readGuards: Object.freeze([...guards.values()]),
  });
};

const mergeMarketplaceHookEvents = (
  events: Set<string>,
  raw: string | null,
  hasManifest: boolean,
): void => {
  if (raw === null) return;
  const declaration: unknown = JSON.parse(raw);
  // Pinned uLo reports unsupported catalog path/array declarations but returns
  // no replacement hooks; aMn still loads the actual cache plugin. Never read
  // these catalog file paths or erase its observed default/custom hooks.
  if (typeof declaration === "string" || Array.isArray(declaration)) return;
  const declared = record(declaration);
  const active = new Set(claudePluginHookEventNames(declared));
  if (Object.keys(declared).length === 0) return;
  // aMn assign without a manifest; _In append replaces each declared key.
  if (!hasManifest) events.clear();
  for (const event of Object.keys(declared)) {
    events.delete(event);
    if (active.has(event)) events.add(event);
  }
};

export const readClaudePluginHooks: typeof collectClaudePluginHooks = async (
  capabilities: ClaudeCodeDiscoveryReadCapabilities,
  input,
) => {
  try {
    return await collectClaudePluginHooks(capabilities, input);
  } catch {
    throw unavailable();
  }
};

export type {
  ClaudePluginDocument,
  ClaudePluginTextDocument,
} from "./capabilities.js";
