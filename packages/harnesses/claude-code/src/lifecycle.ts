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
  dialect: "single-quoted-shell-word";
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
const maximumSettingsByteLength = 1_048_576;
const maximumJsonDepth = 128;
const claudeCodeHarnessType = claudeCodeDescriptor.harnessType;
const claudeCodeHarnessDigest = harnessIdentityDigest(claudeCodeHarnessType);
const encodePosixSingleQuotedShellWord = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;
const claudeCodeCommandDialect = Object.freeze({
  harnessVersion: "2.1.245" as const,
  platform: "posix" as const,
  representation: "single-quoted-shell-word" as const,
  encode: encodePosixSingleQuotedShellWord,
});
const posixLauncherBasenamePattern =
  /^agentscope-hook-v1-[a-f0-9]{64}-d(?:[1-9]\d{1,3}|[1-5]\d{4}|60000)$/u;
const unpairedSurrogatePattern =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const dialectAuthorities = new WeakSet<object>();
type InventoryBudget = { remainingBytes: number };

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
    dialect: "single-quoted-shell-word" as const,
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
    authority.dialect !== "single-quoted-shell-word" ||
    !invocation.launcherPath.startsWith("/") ||
    basename === undefined ||
    !posixLauncherBasenamePattern.test(basename) ||
    invocation.launcherPath.includes("\0") ||
    unpairedSurrogatePattern.test(invocation.launcherPath)
  )
    return undefined;
  return claudeCodeCommandDialect.encode(invocation.launcherPath);
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

const boundedHookString = (value: unknown, maximumBytes: number): boolean =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximumBytes &&
  encoder.encode(value).byteLength <= maximumBytes;

const isAdmittedForeignHook = (value: unknown): boolean => {
  if (
    isProxy(value) ||
    !isRecord(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  const allowedKeys = new Set([
    "args",
    "async",
    "command",
    "once",
    "statusMessage",
    "timeout",
    "type",
  ]);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor)) ||
    !keys.includes("command") ||
    !keys.includes("type") ||
    keys.some((key) => !allowedKeys.has(key))
  )
    return false;
  const field = (key: string): unknown => descriptors[key]?.value as unknown;
  if (
    field("type") !== "command" ||
    !boundedHookString(field("command"), 4_096)
  )
    return false;
  if (keys.includes("args")) {
    const arguments_ = exactArrayValues(field("args"));
    if (
      arguments_ === undefined ||
      arguments_.length > 32 ||
      arguments_.some(
        (argument) =>
          typeof argument !== "string" ||
          argument.length > 512 ||
          encoder.encode(argument).byteLength > 512,
      )
    )
      return false;
  }
  if (
    (["async", "once"] as const).some(
      (key) => keys.includes(key) && typeof field(key) !== "boolean",
    ) ||
    (keys.includes("timeout") &&
      (!Number.isSafeInteger(field("timeout")) ||
        (field("timeout") as number) <= 0 ||
        (field("timeout") as number) > 600)) ||
    (keys.includes("statusMessage") &&
      !boundedHookString(field("statusMessage"), 512))
  )
    return false;
  return true;
};

const isAdmittedForeignMatcher = (value: unknown): boolean => {
  const matcher =
    exactRecordValues(value, ["hooks"]) ??
    exactRecordValues(value, ["hooks", "matcher"]);
  if (matcher === undefined) return false;
  if (matcher.matcher !== undefined && !boundedHookString(matcher.matcher, 512))
    return false;
  const hooks = exactArrayValues(matcher.hooks);
  return (
    hooks !== undefined &&
    hooks.length > 0 &&
    hooks.length <= 64 &&
    hooks.every((hook) => isAdmittedForeignHook(hook))
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
          value.command === command ||
          value.command === invocation.launcherPath ||
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
  for (const [event, entries] of Object.entries(target)) {
    if (!Array.isArray(entries)) return "conflict";
    for (const entry of entries) {
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
          !isAdmittedForeignMatcher(entry))
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
