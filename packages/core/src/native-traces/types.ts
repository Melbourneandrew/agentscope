import { z } from "zod";

export const NativeTraceProviders = ["cursor", "codex", "claude-code"] as const;

export type NativeTraceKnownProvider = (typeof NativeTraceProviders)[number];
export type NativeTraceProvider = NativeTraceKnownProvider | (string & {});

export const RawSourcePointerSchema = z.object({
  provider: z.string().min(1),
  sourceType: z.enum([
    "jsonl",
    "sqlite",
    "cursor-global",
    "traces-index",
    "hook-payload",
    "unknown",
  ]),
  path: z.string().optional(),
  table: z.string().optional(),
  key: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  byteOffset: z.number().int().nonnegative().optional(),
  eventId: z.string().optional(),
  recordId: z.string().optional(),
});

export type RawSourcePointer = z.infer<typeof RawSourcePointerSchema>;

export const NativeTraceUserSchema = z.object({
  id: z.string().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
  source: z.string().optional(),
});

export type NativeTraceUser = z.infer<typeof NativeTraceUserSchema>;

export const NativeTraceModelSchema = z.object({
  provider: z.string().optional(),
  name: z.string().optional(),
  version: z.string().optional(),
  reasoningEffort: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
});

export type NativeTraceModel = z.infer<typeof NativeTraceModelSchema>;

export const NativeTraceUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
});

export type NativeTraceUsage = z.infer<typeof NativeTraceUsageSchema>;

export const NativeTraceToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown().optional(),
  providerIds: z.record(z.string(), z.string()).optional(),
});

export type NativeTraceToolCall = z.infer<typeof NativeTraceToolCallSchema>;

export const NativeTraceToolResultSchema = z.object({
  toolCallId: z.string(),
  output: z.unknown().optional(),
  isError: z.boolean().optional(),
  providerIds: z.record(z.string(), z.string()).optional(),
});

export type NativeTraceToolResult = z.infer<typeof NativeTraceToolResultSchema>;

export const NativeTraceFileEditSchema = z.object({
  path: z.string(),
  operation: z.enum(["create", "update", "delete", "rename", "unknown"]),
  diff: z.string().optional(),
  oldPath: z.string().optional(),
  addedLines: z.number().int().nonnegative().optional(),
  removedLines: z.number().int().nonnegative().optional(),
});

export type NativeTraceFileEdit = z.infer<typeof NativeTraceFileEditSchema>;

export const NativeTraceShellCommandSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().nonnegative().optional(),
});

export type NativeTraceShellCommand = z.infer<
  typeof NativeTraceShellCommandSchema
>;

export const NativeTracePartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user_text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("assistant_text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("thinking"),
    text: z.string().optional(),
    signature: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("tool_call"),
    call: NativeTraceToolCallSchema,
  }),
  z.object({
    type: z.literal("tool_result"),
    result: NativeTraceToolResultSchema,
  }),
  z.object({
    type: z.literal("file_edit"),
    edit: NativeTraceFileEditSchema,
  }),
  z.object({
    type: z.literal("shell_command"),
    command: NativeTraceShellCommandSchema,
  }),
  z.object({
    type: z.literal("shell_output"),
    toolCallId: z.string().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exitCode: z.number().int().optional(),
  }),
  z.object({
    type: z.literal("attachment"),
    name: z.string().optional(),
    contentType: z.string().optional(),
    value: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("unknown"),
    value: z.unknown().optional(),
  }),
]);

export type NativeTracePart = z.infer<typeof NativeTracePartSchema>;

export const NativeTraceMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["system", "user", "assistant", "tool", "agent", "unknown"]),
  timestamp: z.string().optional(),
  parentId: z.string().optional(),
  providerIds: z.record(z.string(), z.string()).optional(),
  model: NativeTraceModelSchema.optional(),
  usage: NativeTraceUsageSchema.optional(),
  parts: z.array(NativeTracePartSchema),
  source: RawSourcePointerSchema.optional(),
});

export type NativeTraceMessage = z.infer<typeof NativeTraceMessageSchema>;

export const NativeAgentTraceSchema = z.object({
  id: z.string(),
  provider: z.string().min(1),
  traceId: z.string().optional(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  cwd: z.string().optional(),
  model: NativeTraceModelSchema.optional(),
  user: NativeTraceUserSchema.optional(),
  messages: z.array(NativeTraceMessageSchema),
  sources: z.array(RawSourcePointerSchema),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type NativeAgentTrace = z.infer<typeof NativeAgentTraceSchema>;

export const NativeTraceDiscoveryItemSchema = z.object({
  provider: z.string().min(1),
  traceId: z.string(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  title: z.string().optional(),
  preview: z.string().optional(),
  cwd: z.string().optional(),
  model: NativeTraceModelSchema.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  source: RawSourcePointerSchema,
});

export type NativeTraceDiscoveryItem = z.infer<
  typeof NativeTraceDiscoveryItemSchema
>;

export type NativeTraceDiscoverOptions = {
  cwd?: string;
  since?: string;
  limit?: number;
  traceId?: string;
  sourcePath?: string;
};

export type NativeTraceParseOptions = {
  includeRawContent?: boolean;
  maxBytes?: number;
};

export interface NativeTraceAdapter {
  readonly provider: NativeTraceProvider;
  discover(
    options?: NativeTraceDiscoverOptions,
  ): Promise<NativeTraceDiscoveryItem[]>;
  parse(
    item: NativeTraceDiscoveryItem,
    options?: NativeTraceParseOptions,
  ): Promise<NativeAgentTrace>;
  canParseSource?(source: RawSourcePointer): boolean;
}

export function parseNativeAgentTrace(value: unknown): NativeAgentTrace {
  return NativeAgentTraceSchema.parse(value);
}

export function parseNativeTraceDiscoveryItem(
  value: unknown,
): NativeTraceDiscoveryItem {
  return NativeTraceDiscoveryItemSchema.parse(value);
}
