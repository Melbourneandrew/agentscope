import { z } from "zod";
import { catalogMarketplaceSource } from "./claude-catalog-entry.js";

// Pinned 2.1.245 ht (280837545) and G (280982131). These operations
// accept already parsed relevant fields, not raw settings or provider authority.
// The pinned on() constructor is undefined, not an extended object schema.
// This leaf preserves parsed raw fields; loading and hook predicates differ.
export type ClaudeParsedPluginFields = Readonly<{
  enabledPlugins?: Readonly<
    Record<string, boolean | readonly string[] | undefined>
  >;
  extraKnownMarketplaces?: Readonly<Record<string, unknown>> | null | undefined;
  additionalMarketplaces?: Readonly<Record<string, unknown>> | null;
  strictKnownMarketplaces?: readonly unknown[] | null | undefined;
  allowedMarketplaces?: readonly unknown[] | null;
  blockedMarketplaces?: readonly unknown[];
}>;

export type ClaudeSettingsLoadingProjection = Readonly<{
  enabledPlugins: Readonly<Record<string, boolean | readonly string[]>>;
  extraKnownMarketplaces?: Readonly<Record<string, unknown>> | null;
  strictKnownMarketplaces?: readonly unknown[] | null;
  blockedMarketplaces?: readonly unknown[];
}>;

const enabledPluginsField = z
  .record(
    z.string(),
    z.union([z.array(z.string()), z.boolean(), z.undefined()]),
  )
  .optional();

// The caller supplies a field from a bounded parsed JSON document. Ke has no
// per-entry catch here: ordinary _d rejects its whole source on a bad field,
// while managed gn drops the whole field. This is not a reproduction of the
// unrelated settings schema, nor proof that a whole document is valid.
export const parseClaudeEnabledPluginsField = (
  value: unknown,
  managed: boolean,
):
  | Readonly<{ kind: "source-ignored" | "field-ignored" }>
  | Readonly<{
      kind: "parsed";
      enabledPlugins?: Readonly<
        Record<string, boolean | readonly string[] | undefined>
      >;
    }> => {
  const parsed = enabledPluginsField.safeParse(value);
  if (!parsed.success)
    return Object.freeze({
      kind: managed ? "field-ignored" : "source-ignored",
    });
  if (parsed.data === undefined) return Object.freeze({ kind: "parsed" });
  return Object.freeze({
    kind: "parsed",
    enabledPlugins: Object.freeze(
      Object.fromEntries(
        Object.entries(parsed.data).map(([id, state]) => [
          id,
          Array.isArray(state) ? Object.freeze([...state]) : state,
        ]),
      ),
    ),
  });
};

const marketplaceListField = z.array(catalogMarketplaceSource).optional();

// The guarded reader supplies bounded parsed JSON. Native ht resolves the
// strict-list alias before Ke/oe parses it. An invalid relevant list rejects
// an ordinary source; managed gn drops only that list, not enabledPlugins.
// This is not a validator for unrelated settings or a marketplace policy gate.
export const parseClaudeEnabledPluginsSettingsSource = (
  value: Readonly<Record<string, unknown>>,
  managed: boolean,
): ReturnType<typeof parseClaudeEnabledPluginsField> => {
  const canonical = value.strictKnownMarketplaces;
  const strict =
    Object.hasOwn(value, "strictKnownMarketplaces") && canonical !== null
      ? canonical
      : Object.hasOwn(value, "allowedMarketplaces")
        ? value.allowedMarketplaces
        : canonical;
  if (
    !managed &&
    (!marketplaceListField.safeParse(strict).success ||
      !marketplaceListField.safeParse(value.blockedMarketplaces).success)
  )
    return Object.freeze({ kind: "source-ignored" });
  return parseClaudeEnabledPluginsField(value.enabledPlugins, managed);
};

// Native ht tests presence, not truthiness; a null canonical value lets the
// alias replace it, whereas an empty canonical map/list suppresses the alias.
export const normalizeClaudeMarketplaceAliases = (
  fields: ClaudeParsedPluginFields,
): ClaudeParsedPluginFields => {
  const extra =
    Object.hasOwn(fields, "extraKnownMarketplaces") &&
    fields.extraKnownMarketplaces !== null
      ? fields.extraKnownMarketplaces
      : Object.hasOwn(fields, "additionalMarketplaces")
        ? fields.additionalMarketplaces
        : fields.extraKnownMarketplaces;
  const strict =
    Object.hasOwn(fields, "strictKnownMarketplaces") &&
    fields.strictKnownMarketplaces !== null
      ? fields.strictKnownMarketplaces
      : Object.hasOwn(fields, "allowedMarketplaces")
        ? fields.allowedMarketplaces
        : fields.strictKnownMarketplaces;
  return Object.freeze({
    ...(fields.enabledPlugins === undefined
      ? {}
      : { enabledPlugins: fields.enabledPlugins }),
    ...(extra === undefined ? {} : { extraKnownMarketplaces: extra }),
    ...(strict === undefined ? {} : { strictKnownMarketplaces: strict }),
    ...(fields.blockedMarketplaces === undefined
      ? {}
      : { blockedMarketplaces: fields.blockedMarketplaces }),
  });
};

// Native G uses uniq([...old, ...new]); this is SameValueZero identity, not
// structural JSON equality. Marketplace declarations replace at the name key.
const union = <T>(old: readonly T[], next: readonly T[]): readonly T[] =>
  Object.freeze([...new Set([...old, ...next])]);

const mergeList = (
  old: readonly unknown[] | null | undefined,
  next: readonly unknown[] | null | undefined,
): readonly unknown[] | null | undefined =>
  next === undefined
    ? old
    : Array.isArray(old) && Array.isArray(next)
      ? union(old, next)
      : next === null
        ? null
        : Object.freeze([...next]);

// Caller supplies the selected, parsed cascade in native low-to-high order
// (user/project/legacy-local/local/flag/policy as actually consulted). This
// does not elect policy tiers, deduplicate physical paths, or resolve aliases.
export const projectClaudeParsedSettings = (
  layers: readonly ClaudeParsedPluginFields[],
): ClaudeSettingsLoadingProjection => {
  const enabled = new Map<string, boolean | readonly string[]>();
  let extra: Readonly<Record<string, unknown>> | null | undefined;
  let strict: readonly unknown[] | null | undefined;
  let blocked: readonly unknown[] | undefined;
  for (const layer of layers) {
    const normalized = normalizeClaudeMarketplaceAliases(layer);
    for (const [id, next] of Object.entries(normalized.enabledPlugins ?? {})) {
      if (next === undefined) continue;
      const old = enabled.get(id);
      enabled.set(
        id,
        Array.isArray(old) && Array.isArray(next)
          ? union(old, next)
          : typeof next === "boolean"
            ? next
            : Object.freeze([...next]),
      );
    }
    if (normalized.extraKnownMarketplaces !== undefined) {
      const next = normalized.extraKnownMarketplaces;
      extra = next === null ? null : Object.freeze({ ...extra, ...next });
    }
    strict = mergeList(strict, normalized.strictKnownMarketplaces);
    blocked = mergeList(blocked, normalized.blockedMarketplaces) ?? undefined;
  }
  return Object.freeze({
    enabledPlugins: Object.freeze(Object.fromEntries(enabled)),
    ...(extra === undefined ? {} : { extraKnownMarketplaces: extra }),
    ...(strict === undefined ? {} : { strictKnownMarketplaces: strict }),
    ...(blocked === undefined ? {} : { blockedMarketplaces: blocked }),
  });
};
