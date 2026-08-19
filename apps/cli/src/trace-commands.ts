import type { Command } from "commander";
import { z } from "zod";

import type { CliOperationResult } from "./cli-contract.js";
import {
  defineCliCommandModule,
  type RuntimeCliCommandModule,
} from "./command-runtime.js";

const connectionNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const traceIdSchema = z.string().regex(/^(?!0{32}$)[0-9a-f]{32}$/u);
const destinationTypeSchema = z
  .string()
  .regex(/^@agentscope\/destination-[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const connectionIdSchema = z
  .string()
  .regex(/^destination-connection-v1-[0-9a-f]{64}$/u);
const boundedTextSchema = z.string().min(1).max(512);
const timestampSchema = z.string().min(1).max(40);
const cursorSchema = z.string().min(1).max(16_384);
const tagSchema = z.string().min(1).max(256);
const limitTextSchema = z
  .string()
  .regex(/^[1-9]\d{0,2}$/u)
  .transform((value) => Number(value));

const locatorSchema = z.strictObject({
  connectionId: connectionIdSchema,
  destinationType: destinationTypeSchema,
  destinationTraceId: z.string().min(1).max(512).optional(),
  traceId: traceIdSchema,
});

const traceReferenceSchema = z
  .string()
  .min(2)
  .max(2_048)
  .transform((value, context) => {
    try {
      const parsed = locatorSchema.safeParse(JSON.parse(value));
      if (parsed.success) return parsed.data;
    } catch {
      // The fixed usage result is selected by the command runtime.
    }
    context.addIssue({ code: "custom", message: "invalid trace reference" });
    return z.NEVER;
  });

const summarySchema = z.strictObject({
  locator: locatorSchema,
  startTime: timestampSchema,
  endTime: timestampSchema.optional(),
  harness: z.string().min(1).max(64).optional(),
  branch: boundedTextSchema.optional(),
  repositoryIdentity: boundedTextSchema.optional(),
  models: z.array(boundedTextSchema).max(32).readonly(),
  status: z.enum(["unset", "ok", "error"]),
  spanCount: z.number().int().positive().max(1_000_000),
  tags: z.array(boundedTextSchema).max(32).readonly(),
});

const searchValueSchema = z.strictObject({
  connectionName: connectionNameSchema,
  consistency: z.enum(["snapshot", "best-effort"]),
  exactTotal: z.number().int().nonnegative().optional(),
  nextCursor: cursorSchema.optional(),
  partialReason: z
    .enum(["provider-request-limit", "response-byte-limit", "deadline"])
    .optional(),
  schemaVersion: z.literal(1),
  state: z.enum(["exhaustive", "continuation", "partial"]),
  summaries: z.array(summarySchema).max(200).readonly(),
});
export type CliTraceSearchValue = z.infer<typeof searchValueSchema>;

// Core has already parsed and governed this graph. The CLI independently closes
// the presentation DTO root so a provider-shaped body cannot become output.
const canonicalGraphSchema = z.strictObject({
  resourceSpans: z.array(z.unknown()).max(256).readonly(),
});

const getValueSchema = z.strictObject({
  connectionName: connectionNameSchema,
  consistency: z.enum(["snapshot", "best-effort"]),
  graph: canonicalGraphSchema,
  locator: locatorSchema,
  policyIdentity: z.string().min(1).max(512),
  schemaVersion: z.literal(1),
});
export type CliTraceGetValue = z.infer<typeof getValueSchema>;

const searchInputSchema = z.strictObject({
  branch: boundedTextSchema.optional(),
  cursor: cursorSchema.optional(),
  destination: connectionNameSchema,
  from: timestampSchema.optional(),
  harness: z.string().min(1).max(64).optional(),
  limit: limitTextSchema.optional(),
  model: boundedTextSchema.optional(),
  sessionId: boundedTextSchema.optional(),
  tags: z.array(tagSchema).max(32).readonly(),
  to: timestampSchema.optional(),
  traceId: traceIdSchema.optional(),
});

const getInputSchema = z
  .strictObject({
    destination: connectionNameSchema,
    traceId: traceIdSchema.optional(),
    traceReference: locatorSchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      (value.traceId === undefined) ===
      (value.traceReference === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "exactly one trace identity is required",
      });
    }
  });

type Result<Value> = CliOperationResult<Value>;

export type CliTraceServices = Readonly<{
  searchTraces: (
    input: z.infer<typeof searchInputSchema>,
  ) => Result<CliTraceSearchValue> | Promise<Result<CliTraceSearchValue>>;
  getTrace: (
    input: z.infer<typeof getInputSchema>,
  ) => Result<CliTraceGetValue> | Promise<Result<CliTraceGetValue>>;
}>;

const options = (command: Command): Readonly<Record<string, unknown>> => {
  const value: unknown = command.opts();
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : {};
};

const option = (command: Command, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(options(command), key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

const presentOption = (
  command: Command,
  key: string,
): Readonly<Record<string, unknown>> => {
  const value = option(command, key);
  return value === undefined ? {} : { [key]: value };
};

const parseTraceReference = (value: unknown): unknown => {
  if (value === undefined || typeof value !== "string") return value;
  const parsed = traceReferenceSchema.safeParse(value);
  return parsed.success ? parsed.data : value;
};

const display = (value: string | undefined): string => value ?? "-";

const searchModule = defineCliCommandModule({
  configure: (command: Command) => {
    command
      .requiredOption(
        "--destination <name>",
        "required configured destination connection",
      )
      .option("--trace-id <id>", "exact lowercase W3C trace ID")
      .option("--from <instant>", "inclusive RFC 3339 start instant")
      .option("--to <instant>", "exclusive RFC 3339 end instant")
      .option("--harness <identity>", "canonical first-party harness identity")
      .option("--branch <name>", "exact case-sensitive branch name")
      .option("--model <name>", "exact normalized model identity")
      .option("--session <id>", "exact session identity")
      .option("--tag <tag...>", "one or more exact tags")
      .option("--limit <count>", "page size from 1 through 200 (default: 50)")
      .option(
        "--cursor <cursor>",
        "opaque cursor from a prior matching search",
      );
  },
  execute: (services: CliTraceServices, input) => services.searchTraces(input),
  human: (value) => [
    "TRACE REFERENCE | START | STATUS | HARNESS | MODELS | SPANS",
    ...value.summaries.map(
      (summary) =>
        `${value.connectionName}:${summary.locator.traceId} | ${summary.startTime} | ${summary.status} | ${display(summary.harness)} | ${summary.models.join(",") || "-"} | ${summary.spanCount}`,
    ),
    `Result state: ${value.state} (${value.consistency})`,
    ...(value.partialReason === undefined
      ? []
      : [`Partial reason: ${value.partialReason}`]),
    ...(value.nextCursor === undefined
      ? []
      : [`Continuation cursor: ${value.nextCursor}`]),
  ],
  id: "traces.search",
  inputSchema: searchInputSchema,
  machineRecords: (value) => [value],
  outputSchema: searchValueSchema,
  readInput: (command: Command) => ({
    ...presentOption(command, "branch"),
    ...presentOption(command, "cursor"),
    destination: option(command, "destination"),
    ...presentOption(command, "from"),
    ...presentOption(command, "harness"),
    ...presentOption(command, "limit"),
    ...presentOption(command, "model"),
    ...(option(command, "session") === undefined
      ? {}
      : { sessionId: option(command, "session") }),
    tags: option(command, "tag") ?? [],
    ...presentOption(command, "to"),
    ...presentOption(command, "traceId"),
  }),
});

const getModule = defineCliCommandModule({
  configure: (command: Command) => {
    command
      .requiredOption(
        "--destination <name>",
        "required configured destination connection",
      )
      .option("--trace-id <id>", "exactly one identity: lowercase W3C trace ID")
      .option(
        "--trace-ref <json>",
        "exactly one identity: structured locator from search output",
      );
  },
  execute: (services: CliTraceServices, input) => services.getTrace(input),
  human: (value) => [
    `Trace reference: ${value.connectionName}:${value.locator.traceId}`,
    `Consistency: ${value.consistency}`,
    `Policy: ${value.policyIdentity}`,
    JSON.stringify(value.graph),
  ],
  id: "traces.get",
  inputSchema: getInputSchema,
  machineRecords: (value) => [value],
  outputSchema: getValueSchema,
  readInput: (command: Command) => {
    const traceReference = parseTraceReference(option(command, "traceRef"));
    return {
      destination: option(command, "destination"),
      ...presentOption(command, "traceId"),
      ...(traceReference === undefined ? {} : { traceReference }),
    };
  },
});

export const traceCommandModules: readonly RuntimeCliCommandModule[] =
  Object.freeze([searchModule, getModule]);
