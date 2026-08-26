import { isAbsolute, normalize } from "node:path";
import { isProxy } from "node:util/types";

import {
  harnessIdentityDigest,
  isOwnedHarnessHookInvocation,
} from "@agentscope/harnesses-core";
import type {
  HarnessDiscoveryResult,
  HarnessInstallationPlanner,
  OwnedHarnessHookInvocation,
} from "@agentscope/harnesses-core";

import {
  CLAUDE_CODE_COMPONENT_VERSION,
  claudeCodeDescriptor,
} from "./descriptor.js";

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

declare const dialectAuthorityBrand: unique symbol;
export type ClaudeCodeDialectAuthority = Readonly<{
  observedVersion: typeof CLAUDE_CODE_COMPONENT_VERSION;
  platform: "posix";
  dialect: "posix-direct-exec";
  readonly [dialectAuthorityBrand]: true;
}>;

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
const governedLifecycleEvents = new Set<string>(CLAUDE_CODE_LIFECYCLE_EVENTS);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const digestPattern = /^[a-f0-9]{64}$/u;
const maximumInventoryArrayLength = 1_024;
const maximumSettingsLayerCount = 4;
const maximumInstalledPluginCount = 128;
const maximumEnabledPluginCount = 256;
const maximumHookEventCount = 64;
const maximumTargetPathBytes = 4_096;
const maximumPluginFieldBytes = 512;
const maximumHookEventBytes = 128;
const maximumInventoryUtf8Bytes = 96 * 1_024;
const maximumHookMatcherCount = 64;
const maximumHookHandlerCount = 64;
const maximumHookUtf8Bytes = 64 * 1_024;
const maximumSettingsByteLength = 1_048_576;
const maximumJsonDepth = 128;
const claudeCodeHarnessType = claudeCodeDescriptor.harnessType;
const claudeCodeHarnessDigest = harnessIdentityDigest(claudeCodeHarnessType);
const claudeCodeCommandDialect = Object.freeze({
  harnessVersion: "2.1.245" as const,
  platform: "posix" as const,
  representation: "posix-direct-exec" as const,
});
const posixLauncherBasenamePattern =
  /^agentscope-hook-v1-[a-f0-9]{64}-d(?:[1-9]\d{1,3}|[1-5]\d{4}|60000)$/u;
const unpairedSurrogatePattern =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const dialectAuthorities = new WeakSet<object>();
type InventoryBudget = { remainingBytes: number };
type HookBudget = { remainingBytes: number };

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

export const createClaudeCodeDialectAuthority = (
  discovery: HarnessDiscoveryResult,
  platform: "posix" | "win32",
): ClaudeCodeDialectAuthority | undefined => {
  const record = exactRecordValues(discovery, [
    "configurationLocations",
    "harnessType",
    "reason",
    "state",
    "version",
  ]);
  if (record === undefined) return undefined;
  const locations = exactArrayValues(record.configurationLocations);
  if (
    locations === undefined ||
    locations.length !==
      claudeCodeDescriptor.configuration.locationSegments.length
  )
    return undefined;
  const locationIndexes = new Set<number>();
  for (const location of locations) {
    const parsed = exactRecordValues(location, ["locationIndex", "present"]);
    if (
      parsed === undefined ||
      !Number.isSafeInteger(parsed.locationIndex) ||
      (parsed.locationIndex as number) < 0 ||
      (parsed.locationIndex as number) >= locations.length ||
      locationIndexes.has(parsed.locationIndex as number) ||
      typeof parsed.present !== "boolean"
    )
      return undefined;
    locationIndexes.add(parsed.locationIndex as number);
  }
  if (
    record.harnessType !== claudeCodeHarnessType ||
    record.state !== "installed" ||
    record.reason !== "compatible" ||
    record.version !== CLAUDE_CODE_COMPONENT_VERSION ||
    platform !== "posix"
  )
    return undefined;
  const authority = Object.freeze({
    observedVersion: CLAUDE_CODE_COMPONENT_VERSION,
    platform: "posix" as const,
    dialect: "posix-direct-exec" as const,
  }) as ClaudeCodeDialectAuthority;
  dialectAuthorities.add(authority);
  return authority;
};

const isClaudeCodeDialectAuthority = (
  value: unknown,
): value is ClaudeCodeDialectAuthority =>
  typeof value === "object" && value !== null && dialectAuthorities.has(value);

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

const parseEnabledPlugins = (
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
    [
      plugin.pluginId,
      plugin.installedRegistryId,
      plugin.cachePluginId,
      plugin.manifestName,
      plugin.manifestVersion,
    ].some(
      (entry) =>
        !consumeInventoryString(entry, maximumPluginFieldBytes, budget),
    ) ||
    !consumeInventoryString(plugin.manifestDigest, 71, budget) ||
    !/^sha256-[a-f0-9]{64}$/u.test(plugin.manifestDigest) ||
    !consumeInventoryString(plugin.hooksDigest, 71, budget) ||
    !/^sha256-[a-f0-9]{64}$/u.test(plugin.hooksDigest) ||
    typeof plugin.directTraceExporter !== "boolean"
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
    manifestName: plugin.manifestName as string,
    manifestVersion: plugin.manifestVersion as string,
    manifestDigest: plugin.manifestDigest,
    hooksDigest: plugin.hooksDigest,
    hookEvents: Object.freeze(hookEvents as string[]),
    directTraceExporter: plugin.directTraceExporter,
  });
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
  if (
    rawLayers === undefined ||
    rawPlugins === undefined ||
    rawLayers.length > maximumSettingsLayerCount ||
    rawPlugins.length > maximumInstalledPluginCount
  )
    return undefined;
  const budget: InventoryBudget = { remainingBytes: maximumInventoryUtf8Bytes };
  const settingsLayers: ClaudeCodePluginSettingsLayer[] = [];
  for (const rawLayer of rawLayers) {
    const layer = parsePluginSettingsLayer(rawLayer, budget);
    if (layer === undefined) return undefined;
    settingsLayers.push(layer);
  }
  const installedPlugins: ClaudeCodeInstalledPlugin[] = [];
  const installedIdentities = new Set<string>();
  for (const rawPlugin of rawPlugins) {
    const plugin = parseInstalledPlugin(rawPlugin, budget, installedIdentities);
    if (plugin === undefined) return undefined;
    installedPlugins.push(plugin);
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

const encodeClaudeCodeHookCommand = (
  invocation: OwnedHarnessHookInvocation,
  authority: ClaudeCodeDialectAuthority,
): string | undefined => {
  const segments = invocation.launcherPath.split("/");
  const basename = segments.at(-1);
  if (
    authority.observedVersion !== claudeCodeCommandDialect.harnessVersion ||
    authority.platform !== claudeCodeCommandDialect.platform ||
    authority.dialect !== claudeCodeCommandDialect.representation ||
    !invocation.launcherPath.startsWith("/") ||
    basename === undefined ||
    !posixLauncherBasenamePattern.test(basename) ||
    !posixExecutableStringIsRepresentable(invocation.launcherPath)
  )
    return undefined;
  return invocation.launcherPath;
};

const ownedHook = (command: string) =>
  Object.freeze({
    type: "command" as const,
    command,
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
  command: string,
) =>
  Object.freeze({
    agentscope: ownedMetadata(invocation, event),
    hooks: Object.freeze([ownedHook(command)]),
  });

const ownedSettings = (
  invocation: OwnedHarnessHookInvocation,
  command: string,
) => ({
  hooks: Object.fromEntries(
    CLAUDE_CODE_LIFECYCLE_EVENTS.map((event) => [
      event,
      [ownedMatcher(invocation, event, command)],
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
    if (scalar !== "true" && scalar !== "false" && scalar !== "null") {
      const numericValue = Number(scalar);
      if (
        !Number.isFinite(numericValue) ||
        Object.is(numericValue, -0) ||
        (Number.isInteger(numericValue) &&
          !Number.isSafeInteger(numericValue)) ||
        JSON.stringify(numericValue) !== scalar
      )
        return false;
    }
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

const hookArrayEquals = (value: unknown, command: string): boolean => {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const hook: unknown = (value as readonly unknown[])[0];
  return (
    isRecord(hook) &&
    hook.type === "command" &&
    hook.command === command &&
    Array.isArray(hook.args) &&
    hook.args.length === 0 &&
    Object.keys(hook).length === 3
  );
};

const boundedHookString = (
  value: unknown,
  maximumBytes: number,
  allowEmpty = false,
): boolean =>
  typeof value === "string" &&
  (allowEmpty || value.length > 0) &&
  value.length <= maximumBytes &&
  encoder.encode(value).byteLength <= maximumBytes;

const allHookTypeEvents = new Set([
  "PermissionDenied",
  "PermissionRequest",
  "PostToolBatch",
  "PostToolUse",
  "PostToolUseFailure",
  "PreToolUse",
  "Stop",
  "SubagentStop",
  "TaskCompleted",
  "TaskCreated",
  "TeammateIdle",
  "UserPromptExpansion",
  "UserPromptSubmit",
]);
const transportHookEvents = new Set([
  ...allHookTypeEvents,
  "ConfigChange",
  "CwdChanged",
  "DirectoryAdded",
  "Elicitation",
  "ElicitationResult",
  "FileChanged",
  "InstructionsLoaded",
  "MessageDisplay",
  "Notification",
  "PostCompact",
  "PreCompact",
  "SessionEnd",
  "StopFailure",
  "SubagentStart",
  "WorktreeCreate",
  "WorktreeRemove",
]);
const everyHookEvent = new Set([
  ...transportHookEvents,
  "SessionStart",
  "Setup",
]);

const consumeHookString = (
  value: unknown,
  maximumBytes: number,
  budget: HookBudget,
  allowEmpty = false,
): value is string => {
  if (!boundedHookString(value, maximumBytes, allowEmpty)) return false;
  const byteLength = encoder.encode(value as string).byteLength;
  if (byteLength > budget.remainingBytes) return false;
  budget.remainingBytes -= byteLength;
  return true;
};

const hookRecord = (
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: ReadonlySet<string>,
  budget: HookBudget,
): Readonly<Record<string, unknown>> | undefined => {
  if (!isRecord(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor)) ||
    keys.some(
      (key) => !allowedKeys.has(key) || !consumeHookString(key, 128, budget),
    ) ||
    [...requiredKeys].some((key) => !keys.includes(key))
  )
    return undefined;
  return Object.freeze(
    Object.fromEntries(
      keys.map((key) => [key, descriptors[key]!.value as unknown]),
    ),
  );
};

const commonHookFieldsAreValid = (
  hook: Readonly<Record<string, unknown>>,
  budget: HookBudget,
): boolean =>
  (hook.if === undefined || consumeHookString(hook.if, 4_096, budget)) &&
  (hook.statusMessage === undefined ||
    consumeHookString(hook.statusMessage, 512, budget, true)) &&
  (hook.once === undefined || typeof hook.once === "boolean") &&
  (hook.timeout === undefined ||
    (Number.isSafeInteger(hook.timeout) &&
      (hook.timeout as number) > 0 &&
      (hook.timeout as number) <= 86_400));

const stringArrayIsValid = (
  value: unknown,
  maximumCount: number,
  maximumBytes: number,
  budget: HookBudget,
  allowEmpty = false,
): boolean => {
  const entries = exactArrayValues(value);
  return (
    entries !== undefined &&
    entries.length <= maximumCount &&
    entries.every((entry) =>
      consumeHookString(entry, maximumBytes, budget, allowEmpty),
    )
  );
};

const jsonInputIsValid = (
  value: unknown,
  budget: HookBudget,
  depth = 0,
): boolean => {
  if (depth > 16) return false;
  if (typeof value === "string")
    return consumeHookString(value, 4_096, budget, true);
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return true;
  const array = exactArrayValues(value);
  if (array !== undefined)
    return (
      array.length <= 64 &&
      array.every((entry) => jsonInputIsValid(entry, budget, depth + 1))
    );
  if (!isRecord(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  return (
    keys.length <= 64 &&
    Reflect.ownKeys(descriptors).every((key) => typeof key === "string") &&
    keys.every((key) => {
      const descriptor = descriptors[key]!;
      return (
        "value" in descriptor &&
        consumeHookString(key, 512, budget) &&
        jsonInputIsValid(descriptor.value, budget, depth + 1)
      );
    })
  );
};

const commonHookKeys = ["if", "once", "statusMessage", "timeout", "type"];
const commandHookKeys = new Set([
  ...commonHookKeys,
  "args",
  "async",
  "asyncRewake",
  "cloud",
  "command",
  "rewakeMessage",
  "rewakeSummary",
  "shell",
]);
const httpHookKeys = new Set([
  ...commonHookKeys,
  "allowedEnvVars",
  "cloud",
  "headers",
  "url",
]);
const mcpToolHookKeys = new Set([...commonHookKeys, "input", "server", "tool"]);
const commandRequiredKeys = new Set(["command", "type"]);
const httpRequiredKeys = new Set(["type", "url"]);
const mcpToolRequiredKeys = new Set(["server", "tool", "type"]);
const promptRequiredKeys = new Set(["prompt", "type"]);
const posixExecutableStringIsRepresentable = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint <= 8 ||
      (codePoint >= 11 && codePoint <= 12) ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127
    )
      return false;
  }
  return !unpairedSurrogatePattern.test(value);
};

const commandArgumentArrayIsValid = (
  value: unknown,
  budget: HookBudget,
): boolean => {
  const entries = exactArrayValues(value);
  return (
    entries !== undefined &&
    entries.length <= 32 &&
    entries.every(
      (entry) =>
        consumeHookString(entry, 512, budget, true) &&
        posixExecutableStringIsRepresentable(entry),
    )
  );
};

const isCommandHook = (value: unknown, budget: HookBudget): boolean => {
  const hook = hookRecord(value, commandHookKeys, commandRequiredKeys, budget);
  if (
    hook === undefined ||
    hook.type !== "command" ||
    !consumeHookString(hook.command, 4_096, budget) ||
    !posixExecutableStringIsRepresentable(hook.command) ||
    !commonHookFieldsAreValid(hook, budget)
  )
    return false;
  return (
    (hook.args === undefined ||
      commandArgumentArrayIsValid(hook.args, budget)) &&
    (hook.async === undefined || typeof hook.async === "boolean") &&
    (hook.asyncRewake === undefined || typeof hook.asyncRewake === "boolean") &&
    (hook.cloud === undefined ||
      ["device", "skip"].includes(hook.cloud as string)) &&
    (hook.rewakeMessage === undefined ||
      consumeHookString(hook.rewakeMessage, 4_096, budget)) &&
    (hook.rewakeSummary === undefined ||
      consumeHookString(hook.rewakeSummary, 4_096, budget)) &&
    (hook.shell === undefined ||
      ["bash", "powershell"].includes(hook.shell as string))
  );
};

const isHttpHookUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) && url.hostname.length > 0
    );
  } catch {
    return false;
  }
};

const isHttpHook = (value: unknown, budget: HookBudget): boolean => {
  const hook = hookRecord(value, httpHookKeys, httpRequiredKeys, budget);
  if (
    hook === undefined ||
    hook.type !== "http" ||
    !consumeHookString(hook.url, 8_192, budget) ||
    !isHttpHookUrl(hook.url) ||
    !commonHookFieldsAreValid(hook, budget) ||
    (hook.cloud !== undefined &&
      !["device", "skip"].includes(hook.cloud as string)) ||
    (hook.allowedEnvVars !== undefined &&
      !stringArrayIsValid(hook.allowedEnvVars, 64, 128, budget))
  )
    return false;
  if (hook.headers === undefined) return true;
  if (!isRecord(hook.headers)) return false;
  const headers = hookRecord(
    hook.headers,
    new Set(Object.keys(hook.headers)),
    new Set(),
    budget,
  );
  return (
    headers !== undefined &&
    Object.keys(headers).length <= 64 &&
    Object.values(headers).every((entry) =>
      consumeHookString(entry, 1_024, budget, true),
    )
  );
};

const isMcpToolHook = (value: unknown, budget: HookBudget): boolean => {
  const hook = hookRecord(value, mcpToolHookKeys, mcpToolRequiredKeys, budget);
  return (
    hook !== undefined &&
    hook.type === "mcp_tool" &&
    consumeHookString(hook.server, 512, budget) &&
    consumeHookString(hook.tool, 512, budget) &&
    commonHookFieldsAreValid(hook, budget) &&
    (hook.input === undefined || jsonInputIsValid(hook.input, budget))
  );
};

const isPromptOrAgentHook = (
  value: unknown,
  type: "prompt" | "agent",
  budget: HookBudget,
): boolean => {
  const hook = hookRecord(
    value,
    new Set([
      ...commonHookKeys,
      ...(type === "prompt" ? ["continueOnBlock"] : []),
      "model",
      "prompt",
    ]),
    promptRequiredKeys,
    budget,
  );
  return (
    hook !== undefined &&
    hook.type === type &&
    consumeHookString(hook.prompt, 16_384, budget, true) &&
    commonHookFieldsAreValid(hook, budget) &&
    (hook.model === undefined ||
      consumeHookString(hook.model, 512, budget, true)) &&
    (hook.continueOnBlock === undefined ||
      typeof hook.continueOnBlock === "boolean")
  );
};

const hookTypeIsCompatible = (event: string, type: string): boolean =>
  type === "command" ||
  type === "mcp_tool" ||
  (type === "http" && transportHookEvents.has(event)) ||
  (["prompt", "agent"].includes(type) && allHookTypeEvents.has(event));

const isAdmittedForeignHook = (
  value: unknown,
  event: string,
  budget: HookBudget,
): boolean => {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (!hookTypeIsCompatible(event, value.type)) return false;
  if (value.type === "command") return isCommandHook(value, budget);
  if (value.type === "http") return isHttpHook(value, budget);
  if (value.type === "mcp_tool") return isMcpToolHook(value, budget);
  return (
    (value.type === "prompt" || value.type === "agent") &&
    isPromptOrAgentHook(value, value.type, budget)
  );
};

const isAdmittedForeignMatcher = (
  value: unknown,
  event: string,
  budget: HookBudget,
): boolean => {
  const matcher =
    exactRecordValues(value, ["hooks"]) ??
    exactRecordValues(value, ["hooks", "matcher"]);
  if (matcher === undefined) return false;
  if (
    matcher.matcher !== undefined &&
    !consumeHookString(matcher.matcher, 4_096, budget, true)
  )
    return false;
  const hooks = exactArrayValues(matcher.hooks);
  return (
    hooks !== undefined &&
    hooks.length > 0 &&
    hooks.length <= maximumHookHandlerCount &&
    hooks.every((hook) => isAdmittedForeignHook(hook, event, budget))
  );
};

const ownedMatcherEquals = (
  value: unknown,
  invocation: OwnedHarnessHookInvocation,
  event: ClaudeCodeLifecycleEvent,
  command: string,
): boolean =>
  isRecord(value) &&
  Object.keys(value).sort().join("\0") === "agentscope\0hooks" &&
  hookArrayEquals(value.hooks, command) &&
  isRecord(value.agentscope) &&
  Object.keys(value.agentscope).sort().join("\0") ===
    "contractVersion\0event\0harnessType\0ownershipIdentity" &&
  value.agentscope.contractVersion === invocation.contractVersion &&
  value.agentscope.event === event &&
  value.agentscope.harnessType === invocation.harnessType &&
  value.agentscope.ownershipIdentity === invocation.ownershipIdentity;

const posixReservedExecutableWords = new Set([
  "!",
  "case",
  "coproc",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "time",
  "until",
  "while",
]);
const posixDelegatingExecutableBasenames = new Set([
  ".",
  "ash",
  "bash",
  "builtin",
  "busybox",
  "chroot",
  "command",
  "dash",
  "doas",
  "env",
  "eval",
  "exec",
  "ksh",
  "ionice",
  "nice",
  "nohup",
  "runuser",
  "setsid",
  "sh",
  "source",
  "stdbuf",
  "su",
  "sudo",
  "taskset",
  "timeout",
  "trap",
  "watch",
  "xargs",
  "zsh",
]);
const safeSimpleCommandExecutables = new Set(["/usr/bin/printf", "printf"]);

const executableBasename = (executable: string): string | undefined =>
  executable.split("/").at(-1);

const executableDelegates = (executable: string): boolean => {
  const basename = executableBasename(executable);
  return (
    basename === undefined || posixDelegatingExecutableBasenames.has(basename)
  );
};

type ParsedPosixSimpleCommand = Readonly<{
  executable: string;
  words: readonly string[];
}>;

const parsePosixSimpleCommand = (
  command: string,
): ParsedPosixSimpleCommand | undefined => {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "single" | "double" | undefined;
  const pushWord = (): void => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  for (let position = 0; position < command.length; position += 1) {
    const character = command[position]!;
    if (["\n", "\r"].includes(character)) return undefined;
    if (quote === "single") {
      if (character === "'") quote = undefined;
      else word += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
        continue;
      }
      if (character === "\\") {
        const next = command[position + 1];
        if (next === undefined || next === "\n") return undefined;
        if (["$", "`", '"', "\\"].includes(next)) {
          word += next;
          position += 1;
        } else word += character;
        continue;
      }
      if (["$", "`"].includes(character)) return undefined;
      word += character;
      continue;
    }
    if ([";", "&", "|", "<", ">", "(", ")", "{", "}"].includes(character))
      return undefined;
    if (["$", "`", "#", "*", "?", "[", "]", "~"].includes(character))
      return undefined;
    if (character === " " || character === "\t") {
      pushWord();
      continue;
    }
    inWord = true;
    if (character === "'") quote = "single";
    else if (character === '"') quote = "double";
    else if (character === "\\") {
      const next = command[position + 1];
      if (next === undefined || next === "\n") return undefined;
      word += next;
      position += 1;
    } else word += character;
  }
  if (quote !== undefined) return undefined;
  pushWord();
  const executable = words.find(
    (entry) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(entry),
  );
  return executable !== undefined &&
    !posixReservedExecutableWords.has(executable) &&
    !executableDelegates(executable)
    ? Object.freeze({
        executable,
        words: Object.freeze([...words]),
      })
    : undefined;
};

const commandClaimsExecutable = (
  value: Readonly<Record<string, unknown>>,
  launcherPath: string,
): boolean => {
  if (typeof value.command !== "string") return false;
  if (!posixExecutableStringIsRepresentable(value.command)) return true;
  if (
    value.command.length > 4_096 ||
    encoder.encode(value.command).byteLength > 4_096
  )
    return value.command.includes(launcherPath);
  if (Object.hasOwn(value, "shell") && Object.hasOwn(value, "args"))
    return true;
  if (Object.hasOwn(value, "args")) {
    const args = exactArrayValues(value.args);
    if (
      args === undefined ||
      value.command === launcherPath ||
      executableDelegates(value.command)
    )
      return true;
    return args.length > 0 && !safeSimpleCommandExecutables.has(value.command);
  }
  if (value.shell === "powershell") return true;
  const parsed = parsePosixSimpleCommand(value.command);
  if (parsed === undefined || parsed.executable === launcherPath) return true;
  if (parsed.words.length === 1 && !Object.hasOwn(value, "shell")) return false;
  return (
    parsed.words[0] !== parsed.executable ||
    !safeSimpleCommandExecutables.has(parsed.executable)
  );
};

const valueClaimsAgentscopeLauncher = (
  value: unknown,
  invocation: OwnedHarnessHookInvocation,
  command: string,
): boolean =>
  typeof value === "string"
    ? value === invocation.launcherPath ||
      value === command ||
      value === invocation.ownershipIdentity
    : Array.isArray(value)
      ? value.some((member) =>
          valueClaimsAgentscopeLauncher(member, invocation, command),
        )
      : isRecord(value) &&
        (Object.hasOwn(value, "agentscope") ||
          commandClaimsExecutable(value, invocation.launcherPath) ||
          value.command === command ||
          Object.keys(value).some((key) =>
            valueClaimsAgentscopeLauncher(key, invocation, command),
          ) ||
          Object.values(value).some((member) =>
            valueClaimsAgentscopeLauncher(member, invocation, command),
          ));

const editHooks = (
  settings: Record<string, unknown>,
  invocation: OwnedHarnessHookInvocation,
  command: string,
  operation: "install" | "migrate" | "uninstall",
): "changed" | "unchanged" | "conflict" => {
  const hooks = settings.hooks;
  if (hooks !== undefined && !isRecord(hooks)) return "conflict";
  const target = hooks ?? {};
  const budget: HookBudget = { remainingBytes: maximumHookUtf8Bytes };
  if (Object.keys(target).length > everyHookEvent.size) return "conflict";
  for (const [event, entries] of Object.entries(target)) {
    if (
      !everyHookEvent.has(event) ||
      !consumeHookString(event, maximumHookEventBytes, budget) ||
      valueClaimsAgentscopeLauncher(event, invocation, command)
    )
      return "conflict";
    const matchers = exactArrayValues(entries);
    if (matchers === undefined || matchers.length > maximumHookMatcherCount)
      return "conflict";
    for (const entry of matchers) {
      const owned =
        governedLifecycleEvents.has(event) &&
        ownedMatcherEquals(
          entry,
          invocation,
          event as ClaudeCodeLifecycleEvent,
          command,
        );
      if (
        !owned &&
        (valueClaimsAgentscopeLauncher(entry, invocation, command) ||
          !isAdmittedForeignMatcher(entry, event, budget))
      )
        return "conflict";
    }
  }
  let ownedEventCount = 0;
  for (const event of CLAUDE_CODE_LIFECYCLE_EVENTS) {
    const entries = target[event];
    const current: readonly unknown[] =
      entries === undefined ? [] : (entries as readonly unknown[]);
    const owned = current.filter((entry) =>
      ownedMatcherEquals(entry, invocation, event, command),
    );
    if (
      owned.length > 1 ||
      current.some(
        (entry) =>
          !ownedMatcherEquals(entry, invocation, event, command) &&
          valueClaimsAgentscopeLauncher(entry, invocation, command),
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
      ownedMatcherEquals(entry, invocation, event, command),
    );
    if (operation === "uninstall") {
      if (owned.length === 1) {
        target[event] = current.filter(
          (entry) => !ownedMatcherEquals(entry, invocation, event, command),
        );
        changed = true;
      }
    } else if (owned.length === 0) {
      target[event] = [...current, ownedMatcher(invocation, event, command)];
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
      : parseEnabledPlugins(settings.enabledPlugins, {
          remainingBytes: maximumInventoryUtf8Bytes,
        });
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
  dialectAuthority: ClaudeCodeDialectAuthority,
): HarnessInstallationPlanner => {
  if (
    !isOwnedHarnessHookInvocation(invocation) ||
    invocation.harnessType !== claudeCodeHarnessType ||
    invocation.harnessDigest !== claudeCodeHarnessDigest
  )
    return () => ({ kind: "conflict" });
  if (!isClaudeCodeDialectAuthority(dialectAuthority))
    return () => ({ kind: "unsupported" });
  const command = encodeClaudeCodeHookCommand(invocation, dialectAuthority);
  if (command === undefined) return () => ({ kind: "unsupported" });
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
      if (
        current ===
        decoder.decode(encodeSettings(ownedSettings(invocation, command)))
      )
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
    const result = editHooks(settings, invocation, command, operation);
    if (result === "conflict") return { kind: "conflict" };
    if (result === "unchanged") return { kind: "unchanged" };
    return {
      kind: operation === "migrate" ? "replace-overlap" : "replace",
      bytes: encodeSettings(settings),
    };
  };
};
