import { z } from "zod";
import type { ClaudeCodePluginInventory } from "@agentscope/harness-claude-code";
import { claudeGitAuthorityHasBackslash } from "./claude-marketplace-url.js";

export const snapshotClaudePlugin = (
  plugin: ClaudeCodePluginInventory["installedPlugins"][number],
): ClaudeCodePluginInventory["installedPlugins"][number] =>
  Object.freeze({
    ...plugin,
    hookEvents: Object.freeze([...plugin.hookEvents]),
  });

// Copy the observed loading projection separately from raw scoped settings.
// This is a DTO snapshot, not selection or a new installation authority.
export const snapshotClaudePluginInventory = (
  inventory: ClaudeCodePluginInventory,
): ClaudeCodePluginInventory =>
  Object.freeze({
    settingsLayers: Object.freeze(
      inventory.settingsLayers.map((layer) =>
        Object.freeze({
          ...layer,
          enabledPlugins: Object.freeze({ ...layer.enabledPlugins }),
        }),
      ),
    ),
    installedPlugins: Object.freeze(
      inventory.installedPlugins.map(snapshotClaudePlugin),
    ),
    ...(inventory.loadSelections === undefined
      ? {}
      : { loadSelections: Object.freeze({ ...inventory.loadSelections }) }),
  });

// Pinned 2.1.245 Po catches an invalid whole renames map as absent. Input is
// the already bounded parsed marketplace document, not an execution authority.
const renamesSchema = z
  .record(z.string(), z.string().nullable())
  .optional()
  .catch(undefined);

export const normalizeClaudePluginRenames = (
  value: unknown,
): Readonly<Record<string, string | null>> | undefined => {
  const parsed = renamesSchema.parse(value);
  return parsed === undefined ? undefined : Object.freeze(parsed);
};

// Wgt checks an existing catalog name before Xxn. Xxn inspects at most sixteen
// nodes, including the final unmapped target; it does not stop at an existing
// intermediate name. Unresolved chains preserve the original load attempt.
export const resolveClaudePluginRename = (
  name: string,
  catalogNames: ReadonlySet<string>,
  renames: Readonly<Record<string, string | null>> | undefined,
): string | null => {
  if (
    catalogNames.has(name) ||
    renames === undefined ||
    !Object.hasOwn(renames, name)
  )
    return name;
  const visited = new Set<string>();
  let current = name;
  for (let iteration = 0; iteration < 16; iteration += 1) {
    if (visited.has(current)) return name;
    visited.add(current);
    const next = Object.hasOwn(renames, current) ? renames[current] : undefined;
    if (next === undefined)
      return catalogNames.has(current) &&
        /^[A-Za-z0-9][-A-Za-z0-9._]*$/.test(current)
        ? current
        : name;
    if (next === null) return null;
    current = next;
  }
  return name;
};

// Wgt consults XG only for a missing-name rename. XG's source-independent Git
// rejection preserves the original ID. Otherwise an unobserved policy permits
// both blocked and allowed outcomes; only their common result is usable here.
// This is a temporary observation boundary, not a claim that policy is absent.
export const selectClaudeRenameWithUnobservedPolicy = (
  original: string,
  renamed: string | null,
  source: Readonly<Record<string, unknown>>,
): string | null => {
  if (renamed === original) return original;
  if (source.source === "git") {
    if (typeof source.url !== "string")
      throw new Error("cli.harness.plugin-inventory-unavailable");
    if (claudeGitAuthorityHasBackslash(source.url)) return original;
  }
  throw new Error("cli.harness.plugin-inventory-unavailable");
};

// Wgt pre-seeds every original valid ID, including disabled selections, before
// visiting aliases in settings order. This is only a projection of the owned
// normalized loading decisions; settings and registry records remain unchanged.
export const deduplicateClaudePluginLoads = (
  settings: ReadonlyMap<string, boolean | readonly string[]>,
  resolved: ReadonlyMap<string, string | null>,
): Readonly<Record<string, string | null>> => {
  const occupied = new Set(settings.keys());
  const selected: [string, string | null][] = [];
  for (const [id, state] of settings) {
    const entrySelected = state === true || Array.isArray(state);
    let target: string | null =
      entrySelected && resolved.has(id) ? (resolved.get(id) ?? null) : id;
    if (target !== null && target !== id) {
      if (occupied.has(target)) target = null;
      else occupied.add(target);
    }
    selected.push([id, target]);
  }
  return Object.freeze(Object.fromEntries(selected));
};
