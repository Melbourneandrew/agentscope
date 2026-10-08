import { z } from "zod";
import { catalogHooks, catalogMcpServer } from "./claude-catalog-transports.js";

const relative = z.string().startsWith("./");
const json = relative.endsWith(".json");
const markdown = relative.endsWith(".md");
const oneOrMany = <T extends z.ZodType>(schema: T) =>
  z.union([schema, z.array(schema)]);
const record = z.record(z.string(), z.unknown());
export const optionalRecord = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
const configValue = z
  .object({
    type: z.enum(["string", "number", "boolean", "directory", "file"]),
    title: z.string(),
    description: z.string(),
    required: z.boolean().optional(),
    multiple: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    default: z
      .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
      .optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict();
const monitor = z.looseObject({
  name: z.string().min(1),
  command: z.string().min(1),
  description: z.string().min(1),
  when: z
    .union([
      z.literal("always"),
      z
        .string()
        .startsWith("on-skill-invoke:")
        .refine((value) => value.length > 16),
    ])
    .default("always"),
});
const monitors = z.union([
  json,
  z
    .array(monitor)
    .refine(
      (values) =>
        new Set(values.map((value) => value.name)).size === values.length,
    ),
]);
const paths = oneOrMany(relative);
const highlighting = z
  .object({
    hljsLanguages: z
      .array(
        z
          .object({
            id: z
              .string()
              .max(64)
              .regex(/^[a-z][a-z0-9_-]*$/),
            remote: z
              .string()
              .max(256)
              .regex(
                /^(npm:[@a-z0-9/._-]+(@[a-z0-9._+-]+)?|github:[\w.-]+\/[\w.-]+@[\w./-]+#.+\.js)$/,
              )
              .optional(),
            integrity: z
              .string()
              .max(512)
              .regex(/^sha(256|384|512)-[A-Za-z0-9+/=]+$/)
              .optional(),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
const binary = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const binaries = (value: unknown) => {
  const parsed = record.safeParse(value);
  if (!parsed.success) return undefined;
  const entries: [string, z.infer<typeof binary>][] = [];
  for (const [name, item] of Object.entries(parsed.data)) {
    if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9_-])?$/.test(name)) continue;
    const found = binary.safeParse(item);
    if (found.success) entries.push([name, found.data]);
    if (entries.length === 64) break;
  }
  return entries.length ? Object.fromEntries(entries) : undefined;
};
const lsp = z.looseObject({
  command: z
    .string()
    .min(1)
    .refine((value) => !value.includes(" ") || value.startsWith("/")),
  args: z.array(z.string().min(1)).optional(),
  extensionToLanguage: z
    .record(z.string().min(2).startsWith("."), z.string().min(1))
    .refine((value) => Object.keys(value).length > 0),
  transport: z.enum(["stdio", "socket"]).default("stdio"),
  env: z.record(z.string(), z.string()).optional(),
  initializationOptions: z.unknown().optional(),
  settings: z.unknown().optional(),
  workspaceFolder: z.string().optional(),
  startupTimeout: z.number().int().positive().optional(),
  shutdownTimeout: z.number().int().positive().optional(),
  restartOnCrash: z.boolean().optional(),
  maxRestarts: z.number().int().nonnegative().optional(),
  diagnostics: z.boolean().optional(),
});
const command = z
  .object({
    source: relative.optional(),
    content: z.string().optional(),
    description: z.string().optional(),
    argumentHint: z.string().optional(),
    model: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
  })
  .refine((value) =>
    Boolean(
      (value.source && !value.content) || (!value.source && value.content),
    ),
  );
const bundle = z.union([
  relative.refine((value) => value.endsWith(".mcpb") || value.endsWith(".dxt")),
  z
    .string()
    .url()
    .refine((value) => value.endsWith(".mcpb") || value.endsWith(".dxt")),
]);
export const componentFields = {
  commands: z
    .union([relative, z.array(relative), z.record(z.string(), command)])
    .optional(),
  agents: oneOrMany(markdown).optional(),
  skills: oneOrMany(z.union([z.literal("."), relative])).optional(),
  outputStyles: paths.optional(),
  themes: paths.optional(),
  workflows: paths.optional(),
  hooks: oneOrMany(z.union([json, catalogHooks])).optional(),
  mcpServers: oneOrMany(
    z.union([json, bundle, z.record(z.string(), catalogMcpServer)]),
  ).optional(),
  userConfig: z
    .record(z.string().regex(/^[A-Za-z_]\w*$/), configValue)
    .optional(),
  channels: z
    .array(
      z
        .object({
          server: z.string().min(1),
          displayName: z.string().optional(),
          userConfig: z.record(z.string(), configValue).optional(),
        })
        .strict(),
    )
    .optional(),
  settings: record.optional(),
  lspServers: oneOrMany(z.union([json, z.record(z.string(), lsp)])).optional(),
  monitors: monitors.optional(),
  binaries: z.unknown().transform(binaries).optional(),
  experimental: z.preprocess(
    optionalRecord,
    z
      .object({
        themes: paths.optional(),
        outputStyles: paths.optional(),
        monitors: monitors.optional(),
        syntaxHighlighting: highlighting.optional(),
        evals: oneOrMany(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  ),
};
