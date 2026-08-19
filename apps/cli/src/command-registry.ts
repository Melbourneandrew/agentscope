import { z } from "zod";

const commandSegmentSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z][a-z0-9-]*$/u);

const commandRegistrationSchema = z.strictObject({
  dataSchema: z
    .string()
    .min(1)
    .max(128)
    .regex(/^agentscope\.cli\.[a-z0-9.-]+\.v[1-9]\d*$/u)
    .nullable(),
  diagnostics: z
    .array(
      z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
    )
    .max(32),
  documentationPage: z
    .string()
    .min(1)
    .max(160)
    .regex(/^cli\/[a-z0-9/-]+\.mdx$/u),
  id: z
    .string()
    .min(1)
    .max(96)
    .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u),
  kind: z.enum(["root", "group", "command"]),
  outputModes: z
    .array(z.enum(["human", "json", "jsonl"]))
    .min(1)
    .max(3),
  path: z.array(commandSegmentSchema).max(8),
  summary: z.string().min(1).max(120),
  visibility: z.enum(["public", "internal"]),
});

type ParsedCommandRegistration = z.infer<typeof commandRegistrationSchema>;

export type CommandRegistration = Readonly<
  Omit<ParsedCommandRegistration, "diagnostics" | "outputModes" | "path"> & {
    readonly diagnostics: readonly string[];
    readonly outputModes: readonly ("human" | "json" | "jsonl")[];
    readonly path: readonly string[];
  }
>;

const rawCommandRegistry = [
  {
    dataSchema: null,
    diagnostics: ["cli.internal", "cli.usage"],
    documentationPage: "cli/index.mdx",
    id: "root",
    kind: "root",
    outputModes: ["human"],
    path: [],
    summary:
      "Capture coding-agent traces and report them to trace destinations.",
    visibility: "public",
  },
] as const;

function freezeRegistration(
  registration: ParsedCommandRegistration,
): CommandRegistration {
  return Object.freeze({
    ...registration,
    diagnostics: Object.freeze([...registration.diagnostics]),
    outputModes: Object.freeze([...registration.outputModes]),
    path: Object.freeze([...registration.path]),
  });
}

export function compileCommandRegistry(
  input: unknown,
): readonly CommandRegistration[] {
  const parsed = z.array(commandRegistrationSchema).min(1).max(64).parse(input);
  const ids = new Set<string>();
  const paths = new Set<string>();
  const pages = new Set<string>();
  let rootCount = 0;

  for (const registration of parsed) {
    const pathKey = registration.path.join(" ");
    if (
      ids.has(registration.id) ||
      paths.has(pathKey) ||
      pages.has(registration.documentationPage)
    ) {
      throw new Error("cli.registry.invalid");
    }
    ids.add(registration.id);
    paths.add(pathKey);
    pages.add(registration.documentationPage);

    if (registration.kind === "root") {
      rootCount += 1;
      if (registration.path.length !== 0 || registration.id !== "root") {
        throw new Error("cli.registry.invalid");
      }
    } else if (registration.path.length === 0) {
      throw new Error("cli.registry.invalid");
    }

    if (
      registration.kind !== "command" &&
      (registration.outputModes.length !== 1 ||
        registration.outputModes[0] !== "human")
    ) {
      throw new Error("cli.registry.invalid");
    }
    if (
      (registration.kind === "command") !==
      (registration.dataSchema !== null)
    ) {
      throw new Error("cli.registry.invalid");
    }
  }

  if (rootCount !== 1) throw new Error("cli.registry.invalid");

  const ordered = [...parsed].sort((left, right) => {
    const depth = left.path.length - right.path.length;
    return depth === 0
      ? left.path.join(" ").localeCompare(right.path.join(" "))
      : depth;
  });
  const knownPaths = new Set([""]);
  for (const registration of ordered) {
    if (registration.kind === "root") continue;
    const parentPath = registration.path.slice(0, -1).join(" ");
    if (!knownPaths.has(parentPath)) throw new Error("cli.registry.invalid");
    knownPaths.add(registration.path.join(" "));
  }

  return Object.freeze(ordered.map(freezeRegistration));
}

export const commandRegistry = compileCommandRegistry(rawCommandRegistry);

export function commandPath(registration: CommandRegistration): string {
  return ["agentscope", ...registration.path].join(" ");
}

export function commandDocumentationUrl(
  registration: CommandRegistration,
): string {
  const slug = registration.documentationPage.replace(/\.mdx$/u, "");
  return `https://melbourneandrew.github.io/agentscope/docs/${slug}`;
}
