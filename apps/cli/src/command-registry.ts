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
  {
    dataSchema: "agentscope.cli.init.v1",
    diagnostics: [
      "configuration.conflict",
      "configuration.unavailable",
      "initialization.destructive-plan",
    ],
    documentationPage: "cli/init.mdx",
    id: "init",
    kind: "command",
    outputModes: ["human", "json", "jsonl"],
    path: ["init"],
    summary:
      "Inspect the machine and produce or apply a non-destructive initialization plan.",
    visibility: "public",
  },
  {
    dataSchema: "agentscope.cli.install.v1",
    diagnostics: [
      "harness.absent",
      "harness.adapter-missing",
      "harness.discovery-indeterminate",
      "harness.installation-unsupported",
      "harness.overlap-conflict",
      "harness.plan-invalid",
      "harness.recovery-required",
      "harness.unavailable",
      "harness.version-unsupported",
    ],
    documentationPage: "cli/install.mdx",
    id: "install",
    kind: "command",
    outputModes: ["human", "json", "jsonl"],
    path: ["install"],
    summary: "Inspect or apply an owned harness integration plan.",
    visibility: "public",
  },
  {
    dataSchema: "agentscope.cli.uninstall.v1",
    diagnostics: [
      "harness.adapter-missing",
      "harness.installation-unsupported",
      "harness.overlap-conflict",
      "harness.plan-invalid",
      "harness.recovery-required",
      "harness.unavailable",
    ],
    documentationPage: "cli/uninstall.mdx",
    id: "uninstall",
    kind: "command",
    outputModes: ["human", "json", "jsonl"],
    path: ["uninstall"],
    summary: "Inspect or apply removal of only an Agentscope-owned hook.",
    visibility: "public",
  },
  {
    dataSchema: null,
    diagnostics: [],
    documentationPage: "cli/harness/index.mdx",
    id: "harness",
    kind: "group",
    outputModes: ["human"],
    path: ["harness"],
    summary: "Discover harnesses and inspect or migrate owned integrations.",
    visibility: "public",
  },
  {
    dataSchema: "agentscope.cli.harness-list.v1",
    diagnostics: ["harness.unavailable"],
    documentationPage: "cli/harness/list.mdx",
    id: "harness.list",
    kind: "command",
    outputModes: ["human", "json", "jsonl"],
    path: ["harness", "list"],
    summary: "Discover every registered first-party harness without mutation.",
    visibility: "public",
  },
  {
    dataSchema: "agentscope.cli.harness-status.v1",
    diagnostics: ["harness.adapter-missing", "harness.unavailable"],
    documentationPage: "cli/harness/status.mdx",
    id: "harness.status",
    kind: "command",
    outputModes: ["human", "json", "jsonl"],
    path: ["harness", "status"],
    summary: "Show discovery and owned installation state for one harness.",
    visibility: "public",
  },
  {
    dataSchema: "agentscope.cli.harness-migrate.v1",
    diagnostics: [
      "harness.absent",
      "harness.adapter-missing",
      "harness.discovery-indeterminate",
      "harness.installation-unsupported",
      "harness.overlap-conflict",
      "harness.plan-invalid",
      "harness.recovery-required",
      "harness.unavailable",
      "harness.version-unsupported",
    ],
    documentationPage: "cli/harness/migrate.mdx",
    id: "harness.migrate",
    kind: "command",
    outputModes: ["human", "json", "jsonl"],
    path: ["harness", "migrate"],
    summary: "Explicitly inspect or replace one overlapping vendor hook.",
    visibility: "public",
  },
  {
    dataSchema: null,
    diagnostics: [],
    documentationPage: "cli/destination/index.mdx",
    id: "destination",
    kind: "group",
    outputModes: ["human"],
    path: ["destination"],
    summary: "Configure and inspect named trace destination connections.",
    visibility: "public",
  },
  {
    dataSchema: "agentscope.cli.destination-configure.v1",
    diagnostics: [
      "configuration.conflict",
      "configuration.missing",
      "configuration.unavailable",
      "destination.connection-exists",
      "destination.credential-unavailable",
      "destination.type-missing",
    ],
    documentationPage: "cli/destination/configure.mdx",
    id: "destination.configure",
    kind: "command",
    outputModes: ["human", "json", "jsonl"],
    path: ["destination", "configure"],
    summary:
      "Configure a named connection from a first-party destination descriptor.",
    visibility: "public",
  },
  {
    dataSchema: "agentscope.cli.destination-delete.v1",
    diagnostics: [
      "configuration.unavailable",
      "destination.confirmation-required",
      "destination.connection-missing",
      "destination.data-delete-unsupported",
    ],
    documentationPage: "cli/destination/delete.mdx",
    id: "destination.delete",
    kind: "command",
    outputModes: ["human", "json", "jsonl"],
    path: ["destination", "delete"],
    summary:
      "Delete an exact destination-owned local data file after confirmation.",
    visibility: "public",
  },
  {
    dataSchema: "agentscope.cli.destination-inspect.v1",
    diagnostics: [
      "configuration.missing",
      "configuration.unavailable",
      "destination.connection-missing",
    ],
    documentationPage: "cli/destination/inspect.mdx",
    id: "destination.inspect",
    kind: "command",
    outputModes: ["human", "json", "jsonl"],
    path: ["destination", "inspect"],
    summary: "Inspect non-secret metadata for a named destination connection.",
    visibility: "public",
  },
  {
    dataSchema: "agentscope.cli.destination-list.v1",
    diagnostics: ["configuration.missing", "configuration.unavailable"],
    documentationPage: "cli/destination/list.mdx",
    id: "destination.list",
    kind: "command",
    outputModes: ["human", "json", "jsonl"],
    path: ["destination", "list"],
    summary:
      "List configured destination connections without resolving credentials.",
    visibility: "public",
  },
  {
    dataSchema: "agentscope.cli.destination-rotate.v1",
    diagnostics: [
      "configuration.conflict",
      "configuration.unavailable",
      "destination.connection-missing",
      "destination.credential-slot-missing",
      "destination.credential-rotation-unsupported",
    ],
    documentationPage: "cli/destination/rotate.mdx",
    id: "destination.rotate",
    kind: "command",
    outputModes: ["human", "json", "jsonl"],
    path: ["destination", "rotate"],
    summary:
      "Rotate a destination credential reference through the owned lifecycle.",
    visibility: "public",
  },
  {
    dataSchema: "agentscope.cli.destination-unconfigure.v1",
    diagnostics: [
      "configuration.conflict",
      "configuration.unavailable",
      "destination.connection-missing",
      "destination.credential-removal-required",
    ],
    documentationPage: "cli/destination/unconfigure.mdx",
    id: "destination.unconfigure",
    kind: "command",
    outputModes: ["human", "json", "jsonl"],
    path: ["destination", "unconfigure"],
    summary:
      "Remove a connection while preserving destination-owned local data.",
    visibility: "public",
  },
  {
    dataSchema: null,
    diagnostics: [],
    documentationPage: "cli/traces/index.mdx",
    id: "traces",
    kind: "group",
    outputModes: ["human"],
    path: ["traces"],
    summary: "Search and retrieve portable traces from one named destination.",
    visibility: "public",
  },
  {
    dataSchema: "agentscope.cli.traces-search.v1",
    diagnostics: [
      "configuration.missing",
      "configuration.unavailable",
      "traces.deadline-exceeded",
      "traces.destination-unknown",
      "traces.forbidden",
      "traces.incompatible-trace",
      "traces.invalid-query",
      "traces.malformed-response",
      "traces.not-found",
      "traces.partial",
      "traces.rate-limited",
      "traces.retrieval-unsupported",
      "traces.unauthorized",
      "traces.unavailable",
    ],
    documentationPage: "cli/traces/search.mdx",
    id: "traces.search",
    kind: "command",
    outputModes: ["human", "json", "jsonl"],
    path: ["traces", "search"],
    summary: "Search one configured retriever with portable bounded filters.",
    visibility: "public",
  },
  {
    dataSchema: "agentscope.cli.traces-get.v1",
    diagnostics: [
      "configuration.missing",
      "configuration.unavailable",
      "traces.deadline-exceeded",
      "traces.destination-unknown",
      "traces.forbidden",
      "traces.incompatible-trace",
      "traces.invalid-query",
      "traces.malformed-response",
      "traces.not-found",
      "traces.rate-limited",
      "traces.retrieval-unsupported",
      "traces.unauthorized",
      "traces.unavailable",
    ],
    documentationPage: "cli/traces/get.mdx",
    id: "traces.get",
    kind: "command",
    outputModes: ["human", "json", "jsonl"],
    path: ["traces", "get"],
    summary:
      "Retrieve one governed portable trace by ID or structured locator.",
    visibility: "public",
  },
  {
    dataSchema: null,
    diagnostics: [],
    documentationPage: "cli/routing/index.mdx",
    id: "routing",
    kind: "group",
    outputModes: ["human"],
    path: ["routing"],
    summary: "Inspect or replace the explicit destination routing selection.",
    visibility: "public",
  },
  {
    dataSchema: "agentscope.cli.routing-list.v1",
    diagnostics: ["configuration.missing", "configuration.unavailable"],
    documentationPage: "cli/routing/list.mdx",
    id: "routing.list",
    kind: "command",
    outputModes: ["human", "json", "jsonl"],
    path: ["routing", "list"],
    summary: "Show the exact selected destination connections.",
    visibility: "public",
  },
  {
    dataSchema: "agentscope.cli.routing-set.v1",
    diagnostics: [
      "configuration.conflict",
      "configuration.unavailable",
      "routing.connection-missing",
      "routing.duplicate-connection",
    ],
    documentationPage: "cli/routing/set.mdx",
    id: "routing.set",
    kind: "command",
    outputModes: ["human", "json", "jsonl"],
    path: ["routing", "set"],
    summary:
      "Atomically replace routing; an empty selection disables delivery.",
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
