import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readClaudePluginDocument } from "./claude-plugin-inventory.js";
import {
  claudeMarketplaceLoadingSource,
  claudeMarketplaceManifestConflict,
} from "./claude-discovery.js";
import {
  exactAbsolutePath,
  type ProductHarnessReadGuard,
} from "./product-harness-probe-files.js";
import {
  deduplicateClaudePluginLoads,
  normalizeClaudePluginRenames,
  resolveClaudePluginRename,
  selectClaudeRenameWithUnobservedPolicy,
} from "./claude-plugin-selection.js";

const unavailable = (): Error =>
  new Error("cli.harness.plugin-inventory-unavailable");

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

export type ClaudeMarketplaceCatalog = Readonly<{
  source: Readonly<Record<string, unknown>>;
  catalog: Readonly<Record<string, unknown> & { plugins: readonly unknown[] }>;
  root: string;
}>;

// Rename resolution and entry selection consult this same owned catalog. The
// caller retains both documents in its existing Core read set, not a new plan.
export const readClaudeMarketplaceCatalog = async (
  pluginsRoot: string,
  market: string,
  retainReadGuard: (guard: ProductHarnessReadGuard) => void,
): Promise<ClaudeMarketplaceCatalog> => {
  if (market.length === 0 || market.includes("@")) throw unavailable();
  const registry = await readClaudePluginDocument(
    join(pluginsRoot, "known_marketplaces.json"),
  );
  retainReadGuard(registry.guard);
  if (!registry.guard.exists) throw unavailable();
  const registered = record(record(registry.value)[market]);
  const source = record(registered.source);
  // Only an already selected cached, non-command source is observed here.
  if (
    !["github", "git", "url", "file", "directory"].includes(
      source.source as string,
    ) ||
    typeof registered.installLocation !== "string"
  )
    throw unavailable();
  if (
    market === "claude-plugins-official" &&
    (source.source !== "github" ||
      source.repo !== "anthropics/claude-plugins-official")
  )
    throw unavailable();
  const path = exactAbsolutePath(registered.installLocation);
  const state = await lstat(path);
  if (state.isSymbolicLink() || (!state.isDirectory() && !state.isFile()))
    throw unavailable();
  const catalog = await readClaudePluginDocument(
    state.isDirectory()
      ? join(path, ".claude-plugin", "marketplace.json")
      : path,
  );
  retainReadGuard(catalog.guard);
  if (!catalog.guard.exists) throw unavailable();
  const value = record(catalog.value);
  if (!Array.isArray(value.plugins) || value.plugins.length > 128)
    throw unavailable();
  return Object.freeze({
    source: Object.freeze(source),
    catalog: Object.freeze({
      ...value,
      plugins: Object.freeze(value.plugins),
    }),
    root: state.isDirectory() ? path : dirname(path),
  });
};

export const selectClaudeMarketplaceEntry = (
  observed: ClaudeMarketplaceCatalog,
  name: string,
): Readonly<{
  hooksDeclarationJson: string | null;
  stringSource: boolean;
  localPath?: string;
  conflictsWithManifest: boolean;
}> => {
  const selected = observed.catalog.plugins.filter(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      Object.getPrototypeOf(entry) === Object.prototype &&
      (entry as Record<string, unknown>).name === name,
  );
  if (selected.length !== 1) throw unavailable();
  // A present name wins before renames. Missing-name composition is separate.
  const { entry, ...loadingSource } = claudeMarketplaceLoadingSource(
    record(selected[0]),
    observed.source,
    observed.root,
    observed.catalog.metadata,
  );
  return Object.freeze({
    hooksDeclarationJson:
      loadingSource.stubbed || entry.hooks === undefined
        ? null
        : JSON.stringify(entry.hooks),
    conflictsWithManifest: claudeMarketplaceManifestConflict(
      entry,
      loadingSource.stubbed,
    ),
    ...loadingSource,
  });
};

// Resolve before registry/cache election. Original settings IDs still occupy
// native deduplication slots, even when disabled; no cache is relabelled.
export const collectClaudeMarketplaceLoads = async (
  pluginsRoot: string,
  settings: ReadonlyMap<string, boolean | readonly string[]>,
  retainReadGuard: (guard: ProductHarnessReadGuard) => void,
) => {
  const catalogs = new Map<string, ClaudeMarketplaceCatalog>();
  const resolved = new Map<string, string | null>();
  for (const [id, state] of settings) {
    if (state !== true && !Array.isArray(state)) continue;
    const parts = id.split("@");
    if (parts.length !== 2 || parts.some((part) => !part)) throw unavailable();
    const [name, market] = parts as [string, string];
    let catalog = catalogs.get(market);
    if (catalog === undefined) {
      catalog = await readClaudeMarketplaceCatalog(
        pluginsRoot,
        market,
        retainReadGuard,
      );
      catalogs.set(market, catalog);
    }
    const names = new Set(
      catalog.catalog.plugins.flatMap((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry))
          return [];
        const candidate: unknown = Object.getOwnPropertyDescriptor(
          entry,
          "name",
        )?.value;
        return typeof candidate === "string" ? [candidate] : [];
      }),
    );
    const selected = selectClaudeRenameWithUnobservedPolicy(
      name,
      resolveClaudePluginRename(
        name,
        names,
        normalizeClaudePluginRenames(catalog.catalog.renames),
      ),
      catalog.source,
    );
    resolved.set(id, selected === null ? null : `${selected}@${market}`);
  }
  const selections = deduplicateClaudePluginLoads(settings, resolved);
  const loads = [];
  for (const [original, state] of settings) {
    if (state !== true && !Array.isArray(state)) continue;
    const id = selections[original];
    if (id === null || id === undefined) continue;
    const [name, market] = id.split("@") as [string, string];
    loads.push(
      Object.freeze({
        id,
        marketplace: selectClaudeMarketplaceEntry(catalogs.get(market)!, name),
      }),
    );
  }
  return Object.freeze({
    loadSelections: Object.entries(selections).some(
      ([id, selected]) => selected !== id,
    )
      ? selections
      : undefined,
    loads: Object.freeze(loads),
  });
};
