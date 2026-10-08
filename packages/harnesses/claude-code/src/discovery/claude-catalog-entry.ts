import { isIP } from "node:net";
import { z } from "zod";
import {
  componentFields,
  optionalRecord,
} from "./claude-catalog-components.js";

const name = z
  .string()
  .min(1)
  .refine((value) => !value.includes(" "));
const strings = z.record(z.string(), z.string());
const helper = z
  .string()
  .max(500)
  .refine((value) => !/[^\x20-\x7E]| {4,}/.test(value));
const git = {
  ref: z.string().optional(),
  sha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
};
// This is the pinned archive-source predicate, not an acquisition policy.
const localArchiveHost = (hostname: string): boolean => {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) {
    const [a, b, c, d] = host.split(".").map(Number);
    return (
      a === 127 ||
      (a === 169 && b === 254) ||
      a === 0 ||
      (a === 100 && b === 100 && c === 100 && d === 200)
    );
  }
  if (isIP(host) !== 6) return false;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (dotted?.[1]) return localArchiveHost(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const first = Number.parseInt(hex[1], 16),
      last = Number.parseInt(hex[2], 16);
    return localArchiveHost(
      `${first >> 8}.${first & 255}.${last >> 8}.${last & 255}`,
    );
  }
  if (["::1", "::", "fd00:ec2::254"].includes(host)) return true;
  const first = Number.parseInt(/^([0-9a-f]{1,4}):/.exec(host)?.[1] ?? "0", 16);
  return first >= 65152 && first <= 65215;
};
const source = z.union([
  z.preprocess(
    (value) => (value === "." ? "./" : value),
    z.string().startsWith("./"),
  ),
  z.object({
    source: z.literal("npm"),
    package: z
      .string()
      .refine(
        (value) =>
          /^(?:file|https?|git(?:\+https?|\+ssh)?|ssh|github|gitlab|bitbucket):/i.test(
            value,
          ) || !value.includes(".."),
      ),
    version: z.string().optional(),
    registry: z.string().url().optional(),
  }),
  z.object({ source: z.literal("url"), url: z.string(), ...git }),
  z.object({ source: z.literal("github"), repo: z.string(), ...git }),
  z.object({
    source: z.literal("git-subdir"),
    url: z.string(),
    path: z.string().min(1),
    ...git,
  }),
  z.object({
    source: z.literal("archive"),
    url: z
      .string()
      .url()
      .refine((value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return url.protocol === "https:" && !localArchiveHost(url.hostname);
      }),
    sha256: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/)
      .optional(),
  }),
  z.object({
    source: z.literal("command"),
    command: helper.min(1),
    timeout: z.number().int().positive().max(600).optional(),
    mode: z.enum(["copy", "link"]).optional(),
  }),
  z.object({ source: z.literal("unsupported"), error: z.string().optional() }),
]);
// Pinned ao is the settings-source entry, not the catalog's co/go entry.
// It has no component fields or default strict value and rejects the named
// unsupported placeholder instead of converting it into a catalog stub.
const settingsEntry = z
  .object({
    name,
    source,
    description: z.string().optional(),
    version: z.string().optional(),
    strict: z.boolean().optional(),
    headers: strings.optional(),
    headersHelper: helper.optional(),
  })
  .refine(
    (value) =>
      typeof value.source !== "string" && value.source.source !== "unsupported",
  );
const settingsEntries = z.array(settingsEntry);

// Pinned DRc/so (283005700) is the marketplace source union, not the
// plugin-entry source above. These predicates parse data; they never acquire
// a marketplace or execute a headers helper.
const reservedMarketplaces = new Set([
  "claude-community",
  "claude-plugins-community",
  "healthcare",
  "claude-code-marketplace",
  "claude-code-plugins",
  "claude-plugins-official",
  "anthropic-marketplace",
  "anthropic-plugins",
  "agent-skills",
  "anthropic-agent-skills",
  "life-sciences",
  "knowledge-work-plugins",
  "claude-for-legal",
  "claude-for-financial-services",
  "financial-services-plugins",
  "first-party-plugins",
]);
const marketplaceName = name.refine(
  (value) =>
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("..") &&
    value !== "." &&
    !/[^\u0020-\u007E]/.test(value) &&
    !/(?:official[^a-z0-9]*(anthropic|claude)|(?:anthropic|claude)[^a-z0-9]*official|^(?:anthropic|claude)[^a-z0-9]*(marketplace|plugins|official))/i.test(
      value,
    ) &&
    !["inline", "builtin", "skills-dir", "synced"].includes(
      value.toLowerCase(),
    ) &&
    !reservedMarketplaces.has(value.toLowerCase()),
);
const marketplaceGitFields = {
  ref: z.string().optional(),
  path: z.string().optional(),
  sparsePaths: z.array(z.string()).optional(),
  skipLfs: z.boolean().optional(),
};
const packageName = z
  .string()
  .refine(
    (value) =>
      !value.includes("..") &&
      !value.includes("//") &&
      /^(?:@[a-z0-9][a-z0-9-._]*\/)?[a-z0-9][a-z0-9-._]*$/.test(value),
  );
export const catalogMarketplaceSource = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("url"),
    url: z.string().url(),
    headers: strings.optional(),
    headersHelper: helper.optional(),
  }),
  z.object({
    source: z.literal("github"),
    repo: z.string(),
    ...marketplaceGitFields,
  }),
  z.object({
    source: z.literal("git"),
    url: z.string(),
    ...marketplaceGitFields,
  }),
  z.object({ source: z.literal("npm"), package: packageName }),
  z.object({ source: z.literal("file"), path: z.string() }),
  z.object({ source: z.literal("directory"), path: z.string() }),
  z.object({ source: z.literal("skills-dir") }),
  z.object({ source: z.literal("hostPattern"), hostPattern: z.string() }),
  z.object({ source: z.literal("pathPattern"), pathPattern: z.string() }),
  z.object({
    source: z.literal("settings"),
    name: marketplaceName,
    plugins: settingsEntries,
    owner: z
      .object({
        name: z.string().min(1),
        email: z.string().optional(),
        url: z.string().optional(),
      })
      .optional(),
  }),
]);

// Both inputs come from the caller's bounded parsed-JSON documents. This
// reproduces only ced's ordinary JSON comparison, never a generic equality
// oracle for caller objects, constructors, wrappers, accessors or functions.
const settingsValuesEqual = (actual: unknown, policy: unknown): boolean => {
  if (actual === policy) return true;
  if (
    actual === null ||
    policy === null ||
    typeof actual !== "object" ||
    typeof policy !== "object"
  )
    return false;
  if (Array.isArray(actual) && Array.isArray(policy))
    return (
      actual.length === policy.length &&
      actual.every((value, index) => settingsValuesEqual(value, policy[index]))
    );
  // ced checks the wrapper marker before object-tag mismatch or own-key
  // comparison. ao can retain it in headers; native then calls value(), which
  // is not callable under that string-record schema. Preserve an unavailable
  // observation rather than claiming equality or executing the marker.
  if (
    (!Array.isArray(actual) && Object.hasOwn(actual, "__wrapped__")) ||
    (!Array.isArray(policy) && Object.hasOwn(policy, "__wrapped__"))
  )
    throw new Error("cli.harness.plugin-inventory-unavailable");
  if (Array.isArray(actual) || Array.isArray(policy)) return false;
  const keys = Object.keys(actual);
  return (
    keys.length === Object.keys(policy).length &&
    keys.every(
      (key) =>
        Object.hasOwn(policy, key) &&
        settingsValuesEqual(
          (actual as Record<string, unknown>)[key],
          (policy as Record<string, unknown>)[key],
        ),
    )
  );
};

// Pinned x's settings branch compares name then ced(plugins, plugins). Owner
// and unknown entry fields are not comparison inputs. This pure branch does
// not establish which managed/provider policy is effective for a live host.
export const claudeMarketplaceStrictSettingsSourceMatches = (
  actual: Readonly<{ name: string; plugins: unknown }>,
  policy: Readonly<{ name: string; plugins: unknown }>,
): boolean => {
  if (actual.name !== policy.name) return false;
  const observed = settingsEntries.safeParse(actual.plugins);
  const allowed = settingsEntries.safeParse(policy.plugins);
  if (!observed.success || !allowed.success)
    throw new Error("cli.harness.plugin-inventory-unavailable");
  return settingsValuesEqual(observed.data, allowed.data);
};
const bareName = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][-A-Za-z0-9._]*$/);
const dependency = z.union([
  z
    .string()
    .regex(
      /^[A-Za-z0-9][-A-Za-z0-9._]*(@[A-Za-z0-9][-A-Za-z0-9._]*)?(@\^[^@]*)?$/,
    )
    .transform((value) => value.replace(/@\^[^@]*$/, "")),
  z
    .looseObject({ name: bareName, marketplace: bareName.optional() })
    .transform((value) =>
      value.marketplace === undefined
        ? value.name
        : `${value.name}@${value.marketplace}`,
    ),
]);
const signals = z.object({
  cli: z.array(z.string().max(64)).max(10).optional(),
  hosts: z.array(z.string().max(128)).max(20).optional(),
  filesRead: z.array(z.string().max(256)).max(10).optional(),
  manifestDeps: z
    .array(
      z.object({ file: z.string().max(256), pattern: z.string().max(256) }),
    )
    .max(10)
    .optional(),
  cwd: z.array(z.string().max(256)).max(10).optional(),
});
const entry = z.object({
  $schema: z.string().optional(),
  name,
  source,
  displayName: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z
    .object({
      name: z.string().min(1),
      email: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  homepage: z.string().url().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  defaultEnabled: z.boolean().optional(),
  dependencies: z.array(dependency).optional(),
  metadata: z.preprocess(
    optionalRecord,
    z.record(z.string(), z.unknown()).optional(),
  ),
  ...componentFields,
  headers: strings.optional(),
  headersHelper: helper.optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  strict: z.boolean().optional().default(true),
  relevance: z.preprocess(
    optionalRecord,
    z
      .object({
        topic: z.string().max(64).optional(),
        signals: signals.optional(),
      })
      .optional(),
  ),
});

// Pure projection of authenticated parsed catalog data. No filesystem,
// executable acquisition, eligibility, or installation authority is minted.
export const normalizeClaudeCatalogEntry = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined => {
  try {
    const result = entry.safeParse(value);
    if (result.success) {
      if (
        typeof result.data.source !== "string" &&
        result.data.source.source === "unsupported"
      )
        result.data.source = { source: "unsupported" };
      return Object.freeze(result.data);
    }
    const named = z.object({ name }).safeParse(value);
    return named.success
      ? Object.freeze({
          name: named.data.name,
          source: { source: "unsupported" },
          strict: true,
        })
      : undefined;
  } catch {
    // Accessors/proxies are not parsed JSON and cannot establish a named entry.
    return undefined;
  }
};
