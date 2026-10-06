import { isAbsolute, normalize } from "node:path";
import { isProxy } from "node:util/types";

export const CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID =
  "langfuse-observability@claude-plugins-official" as const;
export const CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST =
  "sha256-5bc309f17043a4a187bd0b2bd35eafd33ffc19b5c4cb9ccf2c59cfdcb6095154" as const;
export const CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST =
  "sha256-2160981011baab8b42fd5cb6ed1bafbb6cd5927e3b9d6fd4b7f187a11795c2e8" as const;

type ClaudeCodeSettingsScope = "user" | "project" | "local" | "managed";
type EffectivePluginState = Readonly<{
  enabled: boolean;
  scope: ClaudeCodeSettingsScope;
  targetPath: string;
  targetDigest: string;
}>;
export type InspectedPluginOverlap =
  | Readonly<{ status: "absent" }>
  | Readonly<{
      status: "conflict";
      pluginId: string;
      effectiveScope: ClaudeCodeSettingsScope;
      targetPath: string;
      targetDigest: string;
    }>
  | Readonly<{ status: "ambiguous" }>;

export type ClaudeCodePluginSettingsLayer = Readonly<{
  scope: ClaudeCodeSettingsScope;
  targetPath: string;
  targetDigest: string;
  targetExists: boolean;
  enabledPlugins: Readonly<Record<string, boolean>>;
}>;

export type ClaudeCodeInstalledPlugin = Readonly<{
  pluginId: string;
  installedRegistryId: string;
  cachePluginId: string;
  // These describe the observed local manifest, never a vendor fallback name.
  manifestName: string | null;
  // Null is absence; an observed empty version remains an empty string.
  manifestVersion: string | null;
  manifestDigest: string | null;
  // Null means only that the default hooks/hooks.json file was absent.
  hooksDigest: string | null;
  hookEvents: readonly string[];
  // Unknown classification is not evidence that the plugin is not an exporter.
  directTraceExporter: boolean | null;
}>;

export type ClaudeCodePluginInventory = Readonly<{
  settingsLayers: readonly ClaudeCodePluginSettingsLayer[];
  installedPlugins: readonly ClaudeCodeInstalledPlugin[];
}>;

export type ClaudeCodePluginOverlap =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "conflict"; pluginId: string }>
  | Readonly<{ status: "ambiguous" }>;

const scopeOrder: Readonly<Record<ClaudeCodeSettingsScope, number>> = {
  user: 0,
  project: 1,
  local: 2,
  managed: 3,
};
const overlappingEvents = new Set<string>(["Stop", "SessionEnd"]);
const encoder = new TextEncoder();
const digestPattern = /^[a-f0-9]{64}$/u;
const maximumInventoryArrayLength = 1_024;
const maximumSettingsLayerCount = 4;
const maximumInstalledPluginCount = 128;
const maximumEnabledPluginCount = 256;
const maximumHookEventCount = 64;
const maximumTargetPathBytes = 4_096;
const maximumPluginFieldBytes = 512;
export const maximumHookEventBytes = 128;
export const maximumInventoryUtf8Bytes = 96 * 1_024;
type InventoryBudget = { remainingBytes: number };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const exactRecordValues = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined => {
  if (
    isProxy(value) ||
    !isRecord(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join("\0") !==
      [...keys].sort().join("\0") ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return undefined;
  return Object.freeze(
    Object.fromEntries(
      keys.map((key) => [key, descriptors[key]!.value as unknown]),
    ),
  );
};

export const exactArrayValues = (
  value: unknown,
): readonly unknown[] | undefined => {
  if (
    isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors["length"] as
    PropertyDescriptor | undefined;
  const lengthValue = lengthDescriptor?.value as unknown;
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthValue) ||
    (lengthValue as number) < 0 ||
    (lengthValue as number) > maximumInventoryArrayLength
  )
    return undefined;
  const length = lengthValue as number;
  const expected = [
    ...Array.from({ length }, (_, index) => String(index)),
    "length",
  ].sort();
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join("\0") !== expected.join("\0") ||
    Object.entries(descriptors).some(
      ([key, descriptor]) => key !== "length" && !("value" in descriptor),
    )
  )
    return undefined;
  return Object.freeze(
    Array.from(
      { length },
      (_, index) => descriptors[String(index)]!.value as unknown,
    ),
  );
};

const consumeInventoryString = (
  value: unknown,
  maximumBytes: number,
  budget: InventoryBudget,
): value is string => {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > maximumBytes) return false;
  const byteLength = encoder.encode(value).byteLength;
  if (byteLength > maximumBytes || byteLength > budget.remainingBytes)
    return false;
  budget.remainingBytes -= byteLength;
  return true;
};

export const parseEnabledPlugins = (
  value: unknown,
  budget: InventoryBudget,
): Readonly<Record<string, boolean>> | undefined => {
  if (
    isProxy(value) ||
    !isRecord(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).length > maximumEnabledPluginCount ||
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.entries(descriptors).some(
      ([key, descriptor]) =>
        !consumeInventoryString(key, maximumPluginFieldBytes, budget) ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "boolean",
    )
  )
    return undefined;
  return Object.freeze(
    Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [
        key,
        descriptor.value as boolean,
      ]),
    ),
  );
};

const parsePluginSettingsLayer = (
  value: unknown,
  budget: InventoryBudget,
): ClaudeCodePluginSettingsLayer | undefined => {
  const layer = exactRecordValues(value, [
    "enabledPlugins",
    "scope",
    "targetDigest",
    "targetExists",
    "targetPath",
  ]);
  if (layer === undefined) return undefined;
  const enabledPlugins = parseEnabledPlugins(layer.enabledPlugins, budget);
  if (
    !["user", "project", "local", "managed"].includes(layer.scope as string) ||
    !consumeInventoryString(layer.scope, 16, budget) ||
    !consumeInventoryString(layer.targetPath, maximumTargetPathBytes, budget) ||
    !isAbsolute(layer.targetPath) ||
    normalize(layer.targetPath) !== layer.targetPath ||
    !consumeInventoryString(layer.targetDigest, 64, budget) ||
    !digestPattern.test(layer.targetDigest) ||
    typeof layer.targetExists !== "boolean" ||
    enabledPlugins === undefined ||
    (!layer.targetExists && Object.keys(enabledPlugins).length > 0)
  )
    return undefined;
  return Object.freeze({
    scope: layer.scope as ClaudeCodeSettingsScope,
    targetPath: layer.targetPath,
    targetDigest: layer.targetDigest,
    targetExists: layer.targetExists,
    enabledPlugins,
  });
};

const validManifestMetadata = (
  plugin: Readonly<Record<string, unknown>>,
  budget: InventoryBudget,
): boolean => {
  if (plugin.manifestDigest === null)
    return plugin.manifestName === null && plugin.manifestVersion === null;
  return (
    consumeInventoryString(plugin.manifestDigest, 71, budget) &&
    /^sha256-[a-f0-9]{64}$/u.test(plugin.manifestDigest) &&
    consumeInventoryString(
      plugin.manifestName,
      maximumPluginFieldBytes,
      budget,
    ) &&
    !plugin.manifestName.includes(" ") &&
    (plugin.manifestVersion === null ||
      plugin.manifestVersion === "" ||
      consumeInventoryString(
        plugin.manifestVersion,
        maximumPluginFieldBytes,
        budget,
      ))
  );
};

const parseInstalledPlugin = (
  value: unknown,
  budget: InventoryBudget,
  installedIdentities: Set<string>,
): ClaudeCodeInstalledPlugin | undefined => {
  const plugin = exactRecordValues(value, [
    "cachePluginId",
    "directTraceExporter",
    "hookEvents",
    "hooksDigest",
    "installedRegistryId",
    "manifestDigest",
    "manifestName",
    "manifestVersion",
    "pluginId",
  ]);
  if (plugin === undefined) return undefined;
  const hookEvents = exactArrayValues(plugin.hookEvents);
  if (
    hookEvents === undefined ||
    hookEvents.length > maximumHookEventCount ||
    hookEvents.some(
      (event) => !consumeInventoryString(event, maximumHookEventBytes, budget),
    ) ||
    [plugin.pluginId, plugin.installedRegistryId, plugin.cachePluginId].some(
      (entry) =>
        !consumeInventoryString(entry, maximumPluginFieldBytes, budget),
    ) ||
    new Set(hookEvents).size !== hookEvents.length ||
    !validManifestMetadata(plugin, budget) ||
    (plugin.hooksDigest !== null &&
      (!consumeInventoryString(plugin.hooksDigest, 71, budget) ||
        !/^sha256-[a-f0-9]{64}$/u.test(plugin.hooksDigest))) ||
    (plugin.directTraceExporter !== null &&
      typeof plugin.directTraceExporter !== "boolean")
  )
    return undefined;
  const normalizedIdentities = new Set<string>();
  for (const identity of [
    plugin.pluginId,
    plugin.installedRegistryId,
    plugin.cachePluginId,
  ]) {
    const normalized = (identity as string)
      .normalize("NFKC")
      .trim()
      .toLowerCase();
    if (!consumeInventoryString(normalized, maximumPluginFieldBytes, budget))
      return undefined;
    normalizedIdentities.add(normalized);
  }
  if (
    [...normalizedIdentities].some((identity) =>
      installedIdentities.has(identity),
    )
  )
    return undefined;
  for (const identity of normalizedIdentities)
    installedIdentities.add(identity);
  return Object.freeze({
    pluginId: plugin.pluginId as string,
    installedRegistryId: plugin.installedRegistryId as string,
    cachePluginId: plugin.cachePluginId as string,
    manifestName: plugin.manifestName as string | null,
    manifestVersion: plugin.manifestVersion as string | null,
    manifestDigest: plugin.manifestDigest as string | null,
    hooksDigest: plugin.hooksDigest,
    hookEvents: Object.freeze(hookEvents as string[]),
    directTraceExporter: plugin.directTraceExporter,
  });
};

export const parsePluginInventory = (
  value: unknown,
): ClaudeCodePluginInventory | undefined => {
  const record = exactRecordValues(value, [
    "installedPlugins",
    "settingsLayers",
  ]);
  if (record === undefined) return undefined;
  const rawLayers = exactArrayValues(record.settingsLayers);
  const rawPlugins = exactArrayValues(record.installedPlugins);
  if (
    rawLayers === undefined ||
    rawPlugins === undefined ||
    rawLayers.length > maximumSettingsLayerCount ||
    rawPlugins.length > maximumInstalledPluginCount
  )
    return undefined;
  const budget: InventoryBudget = { remainingBytes: maximumInventoryUtf8Bytes };
  const settingsLayers: ClaudeCodePluginSettingsLayer[] = [];
  const scopes = new Set<ClaudeCodeSettingsScope>();
  const paths = new Set<string>();
  for (const rawLayer of rawLayers) {
    const layer = parsePluginSettingsLayer(rawLayer, budget);
    if (
      layer === undefined ||
      scopes.has(layer.scope) ||
      paths.has(layer.targetPath)
    )
      return undefined;
    scopes.add(layer.scope);
    paths.add(layer.targetPath);
    settingsLayers.push(layer);
  }
  const installedPlugins: ClaudeCodeInstalledPlugin[] = [];
  const installedIdentities = new Set<string>();
  for (const rawPlugin of rawPlugins) {
    const plugin = parseInstalledPlugin(rawPlugin, budget, installedIdentities);
    if (plugin === undefined) return undefined;
    installedPlugins.push(plugin);
  }
  return Object.freeze({
    settingsLayers: Object.freeze(settingsLayers),
    installedPlugins: Object.freeze(installedPlugins),
  });
};

const effectiveEnabledPlugins = (
  layers: readonly ClaudeCodePluginSettingsLayer[],
): ReadonlyMap<string, EffectivePluginState> | undefined => {
  const seen = new Set<ClaudeCodeSettingsScope>();
  const ordered = [...layers].sort(
    (left, right) => scopeOrder[left.scope] - scopeOrder[right.scope],
  );
  const enabled = new Map<string, EffectivePluginState>();
  for (const layer of ordered) {
    if (seen.has(layer.scope) || !isRecord(layer.enabledPlugins))
      return undefined;
    seen.add(layer.scope);
    if (!layer.targetExists) continue;
    for (const [pluginId, state] of Object.entries(layer.enabledPlugins)) {
      enabled.set(
        pluginId,
        Object.freeze({
          enabled: state,
          scope: layer.scope,
          targetPath: layer.targetPath,
          targetDigest: layer.targetDigest,
        }),
      );
    }
  }
  return enabled;
};

const isReviewedOfficialLangfuseRecord = (
  plugin: ClaudeCodeInstalledPlugin,
): boolean =>
  plugin.pluginId === CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID &&
  plugin.installedRegistryId === CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID &&
  plugin.cachePluginId === CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID &&
  plugin.manifestName === "langfuse-observability" &&
  plugin.manifestVersion === "1.0.0" &&
  plugin.manifestDigest === CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST &&
  plugin.hooksDigest === CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST &&
  plugin.directTraceExporter === true &&
  ["Stop", "SessionEnd"].every((event) => plugin.hookEvents.includes(event));

export const inspectParsedPluginOverlap = (
  parsed: ClaudeCodePluginInventory,
): InspectedPluginOverlap => {
  const enabled = effectiveEnabledPlugins(parsed.settingsLayers);
  if (enabled === undefined) return Object.freeze({ status: "ambiguous" });
  const records = parsed.installedPlugins.filter(
    (plugin) =>
      plugin.pluginId === CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID ||
      plugin.manifestName === "langfuse-observability",
  );
  if (records.length > 1) return Object.freeze({ status: "ambiguous" });
  const record = records[0];
  const officialState = enabled.get(CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID);
  const officialEnabled = officialState?.enabled === true;
  if (officialEnabled) {
    if (record === undefined || !isReviewedOfficialLangfuseRecord(record))
      return Object.freeze({ status: "ambiguous" });
    return Object.freeze({
      status: "conflict",
      pluginId: CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID,
      effectiveScope: officialState.scope,
      targetPath: officialState.targetPath,
      targetDigest: officialState.targetDigest,
    });
  }
  if (
    record !== undefined &&
    record.pluginId !== CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID
  )
    return Object.freeze({ status: "ambiguous" });
  for (const [pluginId, state] of enabled) {
    if (!state.enabled) continue;
    const enabledRecords = parsed.installedPlugins.filter(
      (plugin) => plugin.pluginId === pluginId,
    );
    if (enabledRecords.length !== 1)
      return Object.freeze({ status: "ambiguous" });
    const plugin = enabledRecords[0]!;
    if (
      plugin.installedRegistryId !== plugin.pluginId ||
      plugin.cachePluginId !== plugin.pluginId
    )
      return Object.freeze({ status: "ambiguous" });
    const overlaps = plugin.hookEvents.some((event) =>
      overlappingEvents.has(event),
    );
    if (overlaps && plugin.directTraceExporter === null)
      return Object.freeze({ status: "ambiguous" });
    if (overlaps && plugin.directTraceExporter === true)
      return Object.freeze({
        status: "conflict",
        pluginId: plugin.pluginId,
        effectiveScope: state.scope,
        targetPath: state.targetPath,
        targetDigest: state.targetDigest,
      });
  }
  return Object.freeze({ status: "absent" });
};

export const inspectPluginOverlap = (
  inventory: unknown,
): InspectedPluginOverlap => {
  const parsed = parsePluginInventory(inventory);
  return parsed === undefined
    ? Object.freeze({ status: "ambiguous" })
    : inspectParsedPluginOverlap(parsed);
};
