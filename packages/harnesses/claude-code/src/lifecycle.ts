import type {
  HarnessInstallationPlanner,
  OwnedHarnessHookInvocation,
} from "@agentscope/harnesses-core";

export const CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID =
  "langfuse-observability@claude-plugins-official" as const;
export const CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST =
  "sha256-5bc309f17043a4a187bd0b2bd35eafd33ffc19b5c4cb9ccf2c59cfdcb6095154" as const;
export const CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST =
  "sha256-2160981011baab8b42fd5cb6ed1bafbb6cd5927e3b9d6fd4b7f187a11795c2e8" as const;

export const CLAUDE_CODE_LIFECYCLE_EVENTS = Object.freeze([
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
] as const);

type ClaudeCodeLifecycleEvent = (typeof CLAUDE_CODE_LIFECYCLE_EVENTS)[number];
type ClaudeCodeSettingsScope = "user" | "project" | "local" | "managed";
type EffectivePluginState = Readonly<{
  enabled: boolean;
  scope: ClaudeCodeSettingsScope;
}>;
type InspectedPluginOverlap =
  | Readonly<{ status: "absent" }>
  | Readonly<{
      status: "conflict";
      pluginId: string;
      effectiveScope: ClaudeCodeSettingsScope;
    }>
  | Readonly<{ status: "ambiguous" }>;

export type ClaudeCodePluginSettingsLayer = Readonly<{
  scope: ClaudeCodeSettingsScope;
  enabledPlugins: Readonly<Record<string, boolean>>;
}>;

export type ClaudeCodeInstalledPlugin = Readonly<{
  pluginId: string;
  installedRegistryId: string;
  cachePluginId: string;
  manifestName: string;
  manifestVersion: string;
  manifestDigest: string;
  hooksDigest: string;
  hookEvents: readonly string[];
  directTraceExporter: boolean;
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
const overlappingEvents = new Set<ClaudeCodeLifecycleEvent>([
  "Stop",
  "SessionEnd",
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
    for (const [pluginId, state] of Object.entries(layer.enabledPlugins)) {
      if (pluginId.length === 0 || typeof state !== "boolean") return undefined;
      enabled.set(
        pluginId,
        Object.freeze({ enabled: state, scope: layer.scope }),
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
  plugin.directTraceExporter &&
  ["Stop", "SessionEnd"].every((event) => plugin.hookEvents.includes(event));

const inspectPluginOverlap = (
  inventory: ClaudeCodePluginInventory,
): InspectedPluginOverlap => {
  const enabled = effectiveEnabledPlugins(inventory.settingsLayers);
  if (enabled === undefined) return Object.freeze({ status: "ambiguous" });
  const records = inventory.installedPlugins.filter(
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
    });
  }
  if (
    record !== undefined &&
    record.pluginId !== CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID
  )
    return Object.freeze({ status: "ambiguous" });
  for (const [pluginId, state] of enabled) {
    if (!state.enabled) continue;
    const enabledRecords = inventory.installedPlugins.filter(
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
    if (
      plugin.directTraceExporter &&
      plugin.hookEvents.some((event) =>
        overlappingEvents.has(event as ClaudeCodeLifecycleEvent),
      )
    )
      return Object.freeze({
        status: "conflict",
        pluginId: plugin.pluginId,
        effectiveScope: state.scope,
      });
  }
  return Object.freeze({ status: "absent" });
};

export const inspectClaudeCodePluginOverlap = (
  inventory: ClaudeCodePluginInventory,
): ClaudeCodePluginOverlap => {
  const overlap = inspectPluginOverlap(inventory);
  return overlap.status === "conflict"
    ? Object.freeze({ status: "conflict", pluginId: overlap.pluginId })
    : overlap;
};

const emptyInventory = Object.freeze({
  settingsLayers: Object.freeze([]),
  installedPlugins: Object.freeze([]),
}) satisfies ClaudeCodePluginInventory;

const ownedHook = (invocation: OwnedHarnessHookInvocation) =>
  Object.freeze({
    type: "command" as const,
    command: invocation.launcherPath,
    args: Object.freeze([]),
  });

const ownedMatcher = (invocation: OwnedHarnessHookInvocation) =>
  Object.freeze({ hooks: Object.freeze([ownedHook(invocation)]) });

const ownedSettings = (invocation: OwnedHarnessHookInvocation) => ({
  hooks: Object.fromEntries(
    CLAUDE_CODE_LIFECYCLE_EVENTS.map((event) => [
      event,
      [ownedMatcher(invocation)],
    ]),
  ),
});

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((member) => canonical(member));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
};

const encodeSettings = (value: Readonly<Record<string, unknown>>): Uint8Array =>
  encoder.encode(`${JSON.stringify(canonical(value), null, 2)}\n`);

const decode = (bytes: Uint8Array): string | undefined => {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
};

const parseSettings = (
  bytes: Uint8Array,
): Record<string, unknown> | undefined => {
  const text = decode(bytes);
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const hookArrayEquals = (
  value: unknown,
  invocation: OwnedHarnessHookInvocation,
): boolean => {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const hook: unknown = (value as readonly unknown[])[0];
  return (
    isRecord(hook) &&
    hook.type === "command" &&
    hook.command === invocation.launcherPath &&
    Array.isArray(hook.args) &&
    hook.args.length === 0 &&
    Object.keys(hook).length === 3
  );
};

const ownedMatcherEquals = (
  value: unknown,
  invocation: OwnedHarnessHookInvocation,
): boolean =>
  isRecord(value) &&
  Object.keys(value).length === 1 &&
  hookArrayEquals(value.hooks, invocation);

const matcherReferencesLauncher = (
  value: unknown,
  invocation: OwnedHarnessHookInvocation,
): boolean =>
  isRecord(value) &&
  Array.isArray(value.hooks) &&
  (value.hooks as readonly unknown[]).some(
    (hook) => isRecord(hook) && hook.command === invocation.launcherPath,
  );

const editHooks = (
  settings: Record<string, unknown>,
  invocation: OwnedHarnessHookInvocation,
  operation: "install" | "migrate" | "uninstall",
): "changed" | "unchanged" | "conflict" => {
  const hooks = settings.hooks;
  if (hooks !== undefined && !isRecord(hooks)) return "conflict";
  const target = hooks ?? {};
  let ownedEventCount = 0;
  for (const event of CLAUDE_CODE_LIFECYCLE_EVENTS) {
    const entries = target[event];
    if (entries !== undefined && !Array.isArray(entries)) return "conflict";
    const current: readonly unknown[] =
      entries === undefined ? [] : (entries as readonly unknown[]);
    const owned = current.filter((entry) =>
      ownedMatcherEquals(entry, invocation),
    );
    if (
      owned.length > 1 ||
      current.some(
        (entry) =>
          matcherReferencesLauncher(entry, invocation) &&
          !ownedMatcherEquals(entry, invocation),
      )
    )
      return "conflict";
    if (owned.length === 1) ownedEventCount += 1;
  }
  if (
    operation !== "uninstall" &&
    ownedEventCount > 0 &&
    ownedEventCount !== CLAUDE_CODE_LIFECYCLE_EVENTS.length
  )
    return "conflict";
  let changed = false;
  for (const event of CLAUDE_CODE_LIFECYCLE_EVENTS) {
    const entries = target[event];
    if (entries !== undefined && !Array.isArray(entries)) return "conflict";
    const current: readonly unknown[] =
      entries === undefined ? [] : (entries as readonly unknown[]);
    const owned = current.filter((entry) =>
      ownedMatcherEquals(entry, invocation),
    );
    if (operation === "uninstall") {
      if (owned.length === 1) {
        target[event] = current.filter(
          (entry) => !ownedMatcherEquals(entry, invocation),
        );
        changed = true;
      }
    } else if (owned.length === 0) {
      target[event] = [...current, ownedMatcher(invocation)];
      changed = true;
    }
  }
  settings.hooks = target;
  return changed ? "changed" : "unchanged";
};

const disableMigratedPlugin = (
  settings: Record<string, unknown>,
  pluginId: string,
): boolean => {
  const enabledPlugins = settings.enabledPlugins;
  if (!isRecord(enabledPlugins) || enabledPlugins[pluginId] !== true)
    return false;
  settings.enabledPlugins = { ...enabledPlugins, [pluginId]: false };
  return true;
};

export const createClaudeCodeInstallationPlanner = (
  operation: "install" | "migrate" | "uninstall",
  invocation: OwnedHarnessHookInvocation,
  inventory: ClaudeCodePluginInventory = emptyInventory,
): HarnessInstallationPlanner => {
  const overlap = inspectPluginOverlap(inventory);
  return ({ exists, bytes }) => {
    const current = bytes === null ? "" : decode(bytes);
    if (current === undefined) return { kind: "unsupported" };
    if (current === "unsupported-native-format") return { kind: "unsupported" };
    if (operation === "uninstall") {
      if (!exists || bytes === null) return { kind: "unchanged" };
      if (current === decoder.decode(encodeSettings(ownedSettings(invocation))))
        return { kind: "remove" };
    }
    if (operation === "install" && overlap.status !== "absent")
      return { kind: "conflict" };
    if (
      operation === "migrate" &&
      (overlap.status !== "conflict" ||
        overlap.pluginId !== CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID ||
        overlap.effectiveScope !== "user")
    )
      return { kind: "conflict" };
    const settings = exists && bytes !== null ? parseSettings(bytes) : {};
    if (settings === undefined) return { kind: "unsupported" };
    if (
      operation === "migrate" &&
      overlap.status === "conflict" &&
      !disableMigratedPlugin(settings, overlap.pluginId)
    )
      return { kind: "conflict" };
    const result = editHooks(settings, invocation, operation);
    if (result === "conflict") return { kind: "conflict" };
    if (result === "unchanged") return { kind: "unchanged" };
    return {
      kind: operation === "migrate" ? "replace-overlap" : "replace",
      bytes: encodeSettings(settings),
    };
  };
};
