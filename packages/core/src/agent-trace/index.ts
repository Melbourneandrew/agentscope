import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  NativeAgentTrace,
  NativeTraceModel,
} from "../native-traces/index.js";

export const AgentTraceSpecVersion = "0.1.0";

export const AgentTraceContributorTypeSchema = z.enum([
  "human",
  "ai",
  "mixed",
  "unknown",
]);

export const AgentTraceContributorSchema = z.object({
  type: AgentTraceContributorTypeSchema,
  model_id: z.string().max(250).optional(),
});

export const AgentTraceRangeSchema = z.object({
  start_line: z.number().int().min(1),
  end_line: z.number().int().min(1),
  content_hash: z.string().optional(),
  contributor: AgentTraceContributorSchema.optional(),
});

export const AgentTraceRelatedResourceSchema = z.object({
  type: z.string(),
  url: z.string().url(),
});

export const AgentTraceConversationSchema = z.object({
  url: z.string().url().optional(),
  contributor: AgentTraceContributorSchema.optional(),
  ranges: z.array(AgentTraceRangeSchema),
  related: z.array(AgentTraceRelatedResourceSchema).optional(),
});

export const AgentTraceFileSchema = z.object({
  path: z.string(),
  conversations: z.array(AgentTraceConversationSchema),
});

export const AgentTraceVcsSchema = z.object({
  type: z.enum(["git", "jj", "hg", "svn"]),
  revision: z.string(),
});

export const AgentTraceToolSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
});

export const AgentTraceRecordSchema = z.object({
  version: z.string(),
  id: z.string().uuid(),
  timestamp: z.string().datetime(),
  vcs: AgentTraceVcsSchema.optional(),
  tool: AgentTraceToolSchema.optional(),
  files: z.array(AgentTraceFileSchema),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type AgentTraceContributorType = z.infer<
  typeof AgentTraceContributorTypeSchema
>;
export type AgentTraceContributor = z.infer<typeof AgentTraceContributorSchema>;
export type AgentTraceRange = z.infer<typeof AgentTraceRangeSchema>;
export type AgentTraceConversation = z.infer<
  typeof AgentTraceConversationSchema
>;
export type AgentTraceFile = z.infer<typeof AgentTraceFileSchema>;
export type AgentTraceRecord = z.infer<typeof AgentTraceRecordSchema>;

export type NativeTraceAttributionRange = {
  path: string;
  startLine: number;
  endLine: number;
  contentHash?: string;
  contributor?: AgentTraceContributor;
};

export type NativeTraceAgentTraceOptions = {
  id?: string;
  timestamp?: string;
  conversationUrl?: string;
  related?: AgentTraceConversation["related"];
  ranges: readonly NativeTraceAttributionRange[];
  contributor?: AgentTraceContributor;
  metadata?: Record<string, unknown>;
};

export function parseAgentTraceRecord(value: unknown): AgentTraceRecord {
  return AgentTraceRecordSchema.parse(value);
}

export function nativeTraceModelId(
  model: NativeTraceModel | undefined,
): string | undefined {
  if (!model?.name) {
    return undefined;
  }
  return model.provider ? `${model.provider}/${model.name}` : model.name;
}

export function contributorFromNativeTrace(
  trace: NativeAgentTrace,
  fallback: AgentTraceContributorType = "ai",
): AgentTraceContributor {
  return {
    type: fallback,
    model_id: nativeTraceModelId(trace.model),
  };
}

export function agentTraceRecordFromNativeTrace(
  trace: NativeAgentTrace,
  options: NativeTraceAgentTraceOptions,
): AgentTraceRecord {
  const contributor =
    options.contributor ?? contributorFromNativeTrace(trace, "ai");
  const conversationsByPath = new Map<string, AgentTraceConversation>();

  for (const range of options.ranges) {
    const conversation = conversationsByPath.get(range.path) ?? {
      url: options.conversationUrl,
      contributor,
      ranges: [],
      related: options.related,
    };
    conversation.ranges.push({
      start_line: range.startLine,
      end_line: range.endLine,
      content_hash: range.contentHash,
      contributor: range.contributor,
    });
    conversationsByPath.set(range.path, conversation);
  }

  const record: AgentTraceRecord = {
    version: AgentTraceSpecVersion,
    id: options.id ?? randomUUID(),
    timestamp: options.timestamp ?? new Date().toISOString(),
    tool: {
      name: trace.provider,
      version: trace.metadata?.tool_version as string | undefined,
    },
    files: [...conversationsByPath.entries()].map(([path, conversation]) => ({
      path,
      conversations: [conversation],
    })),
    metadata: {
      trace_id: trace.traceId ?? trace.id,
      session_id: trace.sessionId,
      provider: trace.provider,
      cwd: trace.cwd,
      ...options.metadata,
    },
  };

  return parseAgentTraceRecord(record);
}
