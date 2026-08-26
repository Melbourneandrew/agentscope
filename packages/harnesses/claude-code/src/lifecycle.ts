import { isAbsolute, normalize } from "node:path";
import { isProxy } from "node:util/types";

import { isOwnedHarnessHookInvocation } from "@agentscope/harnesses-core";
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
  targetPath: string;
  targetDigest: string;
}>;
type InspectedPluginOverlap =
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
const digestPattern = /^[a-f0-9]{64}$/u;
const maximumInventoryArrayLength = 1_024;
const maximumSettingsByteLength = 1_048_576;
const maximumJsonDepth = 128;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactRecordValues = (
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

const exactArrayValues = (value: unknown): readonly unknown[] | undefined => {
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

const parseEnabledPlugins = (
  value: unknown,
): Readonly<Record<string, boolean>> | undefined => {
  if (
    isProxy(value) ||
    !isRecord(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.entries(descriptors).some(
      ([key, descriptor]) =>
        key.length === 0 ||
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

const parsePluginInventory = (
  value: unknown,
): ClaudeCodePluginInventory | undefined => {
  const record = exactRecordValues(value, [
    "installedPlugins",
    "settingsLayers",
  ]);
  if (record === undefined) return undefined;
  const rawLayers = exactArrayValues(record.settingsLayers);
  const rawPlugins = exactArrayValues(record.installedPlugins);
  if (rawLayers === undefined || rawPlugins === undefined) return undefined;
  const settingsLayers: ClaudeCodePluginSettingsLayer[] = [];
  for (const rawLayer of rawLayers) {
    const layer = exactRecordValues(rawLayer, [
      "enabledPlugins",
      "scope",
      "targetDigest",
      "targetExists",
      "targetPath",
    ]);
    if (layer === undefined) return undefined;
    const enabledPlugins = parseEnabledPlugins(layer.enabledPlugins);
    if (
      !["user", "project", "local", "managed"].includes(
        layer.scope as string,
      ) ||
      typeof layer.targetPath !== "string" ||
      !isAbsolute(layer.targetPath) ||
      normalize(layer.targetPath) !== layer.targetPath ||
      typeof layer.targetDigest !== "string" ||
      !digestPattern.test(layer.targetDigest) ||
      typeof layer.targetExists !== "boolean" ||
      enabledPlugins === undefined ||
      (!layer.targetExists && Object.keys(enabledPlugins).length > 0)
    )
      return undefined;
    settingsLayers.push(
      Object.freeze({
        scope: layer.scope as ClaudeCodeSettingsScope,
        targetPath: layer.targetPath,
        targetDigest: layer.targetDigest,
        targetExists: layer.targetExists,
        enabledPlugins,
      }),
    );
  }
  const installedPlugins: ClaudeCodeInstalledPlugin[] = [];
  const installedIdentities = new Set<string>();
  for (const rawPlugin of rawPlugins) {
    const plugin = exactRecordValues(rawPlugin, [
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
      hookEvents.some((event) => typeof event !== "string") ||
      [
        plugin.pluginId,
        plugin.installedRegistryId,
        plugin.cachePluginId,
        plugin.manifestName,
        plugin.manifestVersion,
      ].some((entry) => typeof entry !== "string" || entry.length === 0) ||
      typeof plugin.manifestDigest !== "string" ||
      !/^sha256-[a-f0-9]{64}$/u.test(plugin.manifestDigest) ||
      typeof plugin.hooksDigest !== "string" ||
      !/^sha256-[a-f0-9]{64}$/u.test(plugin.hooksDigest) ||
      typeof plugin.directTraceExporter !== "boolean"
    )
      return undefined;
    const normalizedIdentities = new Set(
      [plugin.pluginId, plugin.installedRegistryId, plugin.cachePluginId].map(
        (identity) =>
          (identity as string).normalize("NFKC").trim().toLowerCase(),
      ),
    );
    if (
      [...normalizedIdentities].some((identity) =>
        installedIdentities.has(identity),
      )
    )
      return undefined;
    for (const identity of normalizedIdentities)
      installedIdentities.add(identity);
    installedPlugins.push(
      Object.freeze({
        pluginId: plugin.pluginId as string,
        installedRegistryId: plugin.installedRegistryId as string,
        cachePluginId: plugin.cachePluginId as string,
        manifestName: plugin.manifestName as string,
        manifestVersion: plugin.manifestVersion as string,
        manifestDigest: plugin.manifestDigest,
        hooksDigest: plugin.hooksDigest,
        hookEvents: Object.freeze(hookEvents as string[]),
        directTraceExporter: plugin.directTraceExporter,
      }),
    );
  }
  if (
    settingsLayers.some((layer) => !layer.targetExists) &&
    installedPlugins.length > 0
  )
    return undefined;
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
      if (pluginId.length === 0 || typeof state !== "boolean") return undefined;
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
  plugin.directTraceExporter &&
  ["Stop", "SessionEnd"].every((event) => plugin.hookEvents.includes(event));

const inspectParsedPluginOverlap = (
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
        targetPath: state.targetPath,
        targetDigest: state.targetDigest,
      });
  }
  return Object.freeze({ status: "absent" });
};

const inspectPluginOverlap = (inventory: unknown): InspectedPluginOverlap => {
  const parsed = parsePluginInventory(inventory);
  return parsed === undefined
    ? Object.freeze({ status: "ambiguous" })
    : inspectParsedPluginOverlap(parsed);
};

export const inspectClaudeCodePluginOverlap = (
  inventory: ClaudeCodePluginInventory,
): ClaudeCodePluginOverlap => {
  const overlap = inspectPluginOverlap(inventory);
  return overlap.status === "conflict"
    ? Object.freeze({ status: "conflict", pluginId: overlap.pluginId })
    : overlap;
};

const ownedHook = (invocation: OwnedHarnessHookInvocation) =>
  Object.freeze({
    type: "command" as const,
    command: invocation.launcherPath,
    args: Object.freeze([]),
  });

const ownedMetadata = (
  invocation: OwnedHarnessHookInvocation,
  event: ClaudeCodeLifecycleEvent,
) =>
  Object.freeze({
    contractVersion: invocation.contractVersion,
    event,
    harnessType: invocation.harnessType,
    ownershipIdentity: invocation.ownershipIdentity,
  });

const ownedMatcher = (
  invocation: OwnedHarnessHookInvocation,
  event: ClaudeCodeLifecycleEvent,
) =>
  Object.freeze({
    agentscope: ownedMetadata(invocation, event),
    hooks: Object.freeze([ownedHook(invocation)]),
  });

const ownedSettings = (invocation: OwnedHarnessHookInvocation) => ({
  hooks: Object.fromEntries(
    CLAUDE_CODE_LIFECYCLE_EVENTS.map((event) => [
      event,
      [ownedMatcher(invocation, event)],
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

const hasUniqueJsonObjectKeys = (text: string): boolean => {
  let position = 0;

  const skipWhitespace = (): void => {
    while ([" ", "\t", "\n", "\r"].includes(text[position] ?? ""))
      position += 1;
  };

  const parseString = (): string | undefined => {
    if (text[position] !== '"') return undefined;
    const start = position;
    position += 1;
    while (position < text.length) {
      const character = text[position]!;
      if (character === '"') {
        position += 1;
        try {
          const decoded: unknown = JSON.parse(text.slice(start, position));
          return typeof decoded === "string" ? decoded : undefined;
        } catch {
          return undefined;
        }
      }
      if (character === "\\") {
        position += 2;
      } else {
        position += 1;
      }
    }
    return undefined;
  };

  const parseValue = (depth: number): boolean => {
    if (depth > maximumJsonDepth) return false;
    skipWhitespace();
    if (text[position] === "{") {
      position += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (text[position] === "}") {
        position += 1;
        return true;
      }
      while (position < text.length) {
        const key = parseString();
        if (key === undefined || keys.has(key)) return false;
        keys.add(key);
        skipWhitespace();
        if (text[position] !== ":") return false;
        position += 1;
        if (!parseValue(depth + 1)) return false;
        skipWhitespace();
        if (text[position] === "}") {
          position += 1;
          return true;
        }
        if (text[position] !== ",") return false;
        position += 1;
        skipWhitespace();
      }
      return false;
    }
    if (text[position] === "[") {
      position += 1;
      skipWhitespace();
      if (text[position] === "]") {
        position += 1;
        return true;
      }
      while (position < text.length) {
        if (!parseValue(depth + 1)) return false;
        skipWhitespace();
        if (text[position] === "]") {
          position += 1;
          return true;
        }
        if (text[position] !== ",") return false;
        position += 1;
      }
      return false;
    }
    if (text[position] === '"') return parseString() !== undefined;
    const remainder = text.slice(position);
    const scalar =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(
        remainder,
      )?.[0];
    if (scalar === undefined) return false;
    position += scalar.length;
    return true;
  };

  if (!parseValue(0)) return false;
  skipWhitespace();
  return position === text.length;
};

const parseSettings = (
  bytes: Uint8Array,
): Record<string, unknown> | undefined => {
  if (bytes.byteLength > maximumSettingsByteLength) return undefined;
  const text = decode(bytes);
  if (text === undefined || !hasUniqueJsonObjectKeys(text)) return undefined;
  const value: unknown = JSON.parse(text);
  return isRecord(value) ? value : undefined;
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
  event: ClaudeCodeLifecycleEvent,
): boolean =>
  isRecord(value) &&
  Object.keys(value).sort().join("\0") === "agentscope\0hooks" &&
  hookArrayEquals(value.hooks, invocation) &&
  isRecord(value.agentscope) &&
  Object.keys(value.agentscope).sort().join("\0") ===
    "contractVersion\0event\0harnessType\0ownershipIdentity" &&
  value.agentscope.contractVersion === invocation.contractVersion &&
  value.agentscope.event === event &&
  value.agentscope.harnessType === invocation.harnessType &&
  value.agentscope.ownershipIdentity === invocation.ownershipIdentity;

const matcherReferencesLauncher = (
  value: unknown,
  invocation: OwnedHarnessHookInvocation,
): boolean =>
  isRecord(value) &&
  Array.isArray(value.hooks) &&
  (value.hooks as readonly unknown[]).some(
    (hook) => isRecord(hook) && hook.command === invocation.launcherPath,
  );

const matcherClaimsAgentscopeOwnership = (value: unknown): boolean =>
  isRecord(value) && value.agentscope !== undefined;

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
      ownedMatcherEquals(entry, invocation, event),
    );
    if (
      owned.length > 1 ||
      current.some(
        (entry) =>
          (matcherReferencesLauncher(entry, invocation) ||
            matcherClaimsAgentscopeOwnership(entry)) &&
          !ownedMatcherEquals(entry, invocation, event),
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
    const current: readonly unknown[] =
      entries === undefined ? [] : (entries as readonly unknown[]);
    const owned = current.filter((entry) =>
      ownedMatcherEquals(entry, invocation, event),
    );
    if (operation === "uninstall") {
      if (owned.length === 1) {
        target[event] = current.filter(
          (entry) => !ownedMatcherEquals(entry, invocation, event),
        );
        changed = true;
      }
    } else if (owned.length === 0) {
      target[event] = [...current, ownedMatcher(invocation, event)];
      changed = true;
    }
  }
  settings.hooks = target;
  return changed ? "changed" : "unchanged";
};

const disableMigratedPlugin = (
  settings: Record<string, unknown>,
  pluginId: string,
): void => {
  const enabledPlugins = settings.enabledPlugins as Record<string, unknown>;
  settings.enabledPlugins = { ...enabledPlugins, [pluginId]: false };
};

const enabledPluginsEqual = (
  left: Readonly<Record<string, boolean>>,
  right: Readonly<Record<string, boolean>>,
): boolean => {
  const leftEntries = Object.keys(left)
    .sort()
    .map((key) => [key, left[key]]);
  const rightEntries = Object.keys(right)
    .sort()
    .map((key) => [key, right[key]]);
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
};

const targetLayerAgrees = (
  inventory: ClaudeCodePluginInventory,
  target: Readonly<{
    exists: boolean;
    digest: string;
    targetPath: string;
  }>,
  settings: Readonly<Record<string, unknown>>,
): boolean => {
  const visibleEnabledPlugins =
    settings.enabledPlugins === undefined
      ? Object.freeze({})
      : parseEnabledPlugins(settings.enabledPlugins);
  if (visibleEnabledPlugins === undefined) return false;
  const boundLayers = inventory.settingsLayers.filter(
    (layer) =>
      layer.scope === "user" &&
      layer.targetPath === target.targetPath &&
      layer.targetDigest === target.digest &&
      layer.targetExists === target.exists,
  );
  return (
    inventory.settingsLayers.length === 1 &&
    boundLayers.length === 1 &&
    enabledPluginsEqual(boundLayers[0]!.enabledPlugins, visibleEnabledPlugins)
  );
};

export const createClaudeCodeInstallationPlanner = (
  operation: "install" | "migrate" | "uninstall",
  invocation: OwnedHarnessHookInvocation,
  inventory: ClaudeCodePluginInventory,
): HarnessInstallationPlanner => {
  if (!isOwnedHarnessHookInvocation(invocation))
    return () => ({ kind: "conflict" });
  const parsedInventory = parsePluginInventory(inventory);
  if (parsedInventory === undefined) return () => ({ kind: "conflict" });
  const overlap = inspectParsedPluginOverlap(parsedInventory);
  return ({ exists, bytes, digest, targetPath }) => {
    if (overlap.status === "ambiguous") return { kind: "conflict" };
    if (exists !== (bytes !== null)) return { kind: "conflict" };
    const current = bytes === null ? "" : decode(bytes);
    if (current === undefined) return { kind: "unsupported" };
    if (current === "unsupported-native-format") return { kind: "unsupported" };
    const settings = exists && bytes !== null ? parseSettings(bytes) : {};
    if (settings === undefined) return { kind: "unsupported" };
    if (
      !targetLayerAgrees(
        parsedInventory,
        { exists, digest, targetPath },
        settings,
      )
    )
      return { kind: "conflict" };
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
        overlap.effectiveScope !== "user" ||
        overlap.targetPath !== targetPath ||
        overlap.targetDigest !== digest)
    )
      return { kind: "conflict" };
    if (operation === "migrate" && overlap.status === "conflict")
      disableMigratedPlugin(settings, overlap.pluginId);
    const result = editHooks(settings, invocation, operation);
    if (result === "conflict") return { kind: "conflict" };
    if (result === "unchanged") return { kind: "unchanged" };
    return {
      kind: operation === "migrate" ? "replace-overlap" : "replace",
      bytes: encodeSettings(settings),
    };
  };
};
