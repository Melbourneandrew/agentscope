import { createClaudeCodeNativeTraceAdapter } from "../native-traces/adapters/claude-code.js";
import { createCodexNativeTraceAdapter } from "../native-traces/adapters/codex.js";
import { createCursorNativeTraceAdapter } from "../native-traces/adapters/cursor.js";
import type {
  NativeAgentTrace,
  NativeTraceAdapter,
  NativeTraceDiscoveryItem,
  NativeTraceMessage,
  NativeTraceModel,
  NativeTraceParseOptions,
  NativeTraceProvider,
  RawSourcePointer,
} from "../native-traces/types.js";
import { NativeAgentTraceSchema } from "../native-traces/types.js";

type NativeTurnSelector = {
  transcriptTurnId?: string;
};

export type NativeTurnTraceRequest = NativeTurnSelector & {
  sessionId: string;
  turnId?: string;
  sourcePath?: string;
  model?: NativeTraceModel;
  userEmail?: string;
};

export type NativeTurnTraceBuildOptions = {
  adapter?: NativeTraceAdapter;
  adapterOptions?: Record<string, unknown>;
  parseOptions?: NativeTraceParseOptions;
};

export type NativeTurnTraceResult = {
  trace: NativeAgentTrace;
};

export type NativeTurnTraceOptions = NativeTurnSelector & {
  sessionId?: string;
  fallbackTurnId?: string;
  turnId?: string;
};

export const cursor = {
  buildNativeTurnTrace(
    request: NativeTurnTraceRequest,
    options: NativeTurnTraceBuildOptions = {},
  ): Promise<NativeTurnTraceResult> {
    return buildProviderNativeTurnTrace({
      provider: "cursor",
      adapter:
        options.adapter ??
        createCursorNativeTraceAdapter(options.adapterOptions),
      traceId: request.sessionId,
      traceIds: [request.sessionId, `transcript:${request.sessionId}`],
      sessionId: request.sessionId,
      request,
      options,
    });
  },
};

export const codex = {
  buildNativeTurnTrace(
    request: NativeTurnTraceRequest,
    options: NativeTurnTraceBuildOptions = {},
  ): Promise<NativeTurnTraceResult> {
    return buildProviderNativeTurnTrace({
      provider: "codex",
      adapter:
        options.adapter ??
        createCodexNativeTraceAdapter(options.adapterOptions),
      traceId: request.sessionId,
      sessionId: request.sessionId,
      request,
      options,
    });
  },
};

export const claude = {
  buildNativeTurnTrace(
    request: NativeTurnTraceRequest,
    options: NativeTurnTraceBuildOptions = {},
  ): Promise<NativeTurnTraceResult> {
    return buildProviderNativeTurnTrace({
      provider: "claude-code",
      adapter:
        options.adapter ??
        createClaudeCodeNativeTraceAdapter(options.adapterOptions),
      traceId: request.sessionId,
      sessionId: request.sessionId,
      request,
      options,
    });
  },
};

async function buildProviderNativeTurnTrace({
  provider,
  adapter,
  traceId,
  traceIds,
  sessionId,
  request,
  options,
}: {
  provider: NativeTraceProvider;
  adapter: NativeTraceAdapter;
  traceId?: string;
  traceIds?: readonly string[];
  sessionId?: string;
  request: NativeTurnTraceRequest;
  options?: NativeTurnTraceBuildOptions;
}): Promise<NativeTurnTraceResult> {
  const discovery = await discoverOne(adapter, {
    ...(traceId !== undefined ? { traceId } : {}),
    ...(traceIds !== undefined ? { traceIds } : {}),
    ...(request.sourcePath !== undefined
      ? { sourcePath: request.sourcePath }
      : {}),
  });
  const trace = withRequestModel(
    await adapter.parse(discovery, options?.parseOptions),
    request.model,
  );
  const turnTrace = nativeTurnTrace(trace, {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(request.transcriptTurnId !== undefined
      ? { transcriptTurnId: request.transcriptTurnId }
      : {}),
    ...(request.turnId !== undefined ? { fallbackTurnId: request.turnId } : {}),
  });
  if (turnTrace.provider !== provider) {
    throw new Error(
      `Parsed native trace provider mismatch: expected ${provider}, got ${turnTrace.provider}`,
    );
  }
  return { trace: turnTrace };
}

function withRequestModel(
  trace: NativeAgentTrace,
  model: NativeTraceModel | undefined,
): NativeAgentTrace {
  if (!model?.name || trace.model?.name) {
    return trace;
  }
  return NativeAgentTraceSchema.parse({
    ...trace,
    model: {
      ...trace.model,
      ...model,
    },
  });
}

async function discoverOne(
  adapter: NativeTraceAdapter,
  options: {
    cwd?: string;
    traceId?: string;
    traceIds?: readonly string[];
    sourcePath?: string;
  },
): Promise<NativeTraceDiscoveryItem> {
  const traceIds = options.traceIds ?? [options.traceId];
  for (const traceId of traceIds) {
    const items = await adapter.discover({
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(traceId !== undefined ? { traceId } : {}),
      ...(options.sourcePath !== undefined
        ? { sourcePath: options.sourcePath }
        : {}),
      limit: 1,
    });
    const item = items[0];
    if (item) {
      return item;
    }
  }
  throw new Error(
    `No native ${adapter.provider} trace found for the requested turn`,
  );
}

export function nativeTurnTrace(
  trace: NativeAgentTrace,
  options: NativeTurnTraceOptions = {},
): NativeAgentTrace {
  const selection = selectTurnMessages(trace.messages, options);
  const sessionId = options.sessionId ?? trace.sessionId ?? trace.id;
  const turnId =
    options.turnId ??
    options.fallbackTurnId ??
    trace.turnId ??
    selection.turnId;
  const traceId = turnTraceId(trace.provider, sessionId, turnId);
  const messages = trace.messages.slice(selection.start, selection.end + 1);
  return NativeAgentTraceSchema.parse({
    ...trace,
    id: traceId,
    traceId,
    sessionId,
    turnId,
    user: trace.user,
    createdAt: messages[0]?.timestamp ?? trace.createdAt,
    updatedAt: messages[messages.length - 1]?.timestamp ?? trace.updatedAt,
    messages,
    sources: sourcesForTurn(trace.sources, messages),
    metadata: trace.metadata,
  });
}

function selectTurnMessages(
  messages: NativeTraceMessage[],
  options: NativeTurnSelector,
): { start: number; end: number; turnId?: string } {
  const targetIds = [options.transcriptTurnId].filter(
    (value): value is string => Boolean(value),
  );
  if (targetIds.length > 0) {
    const selections = targetIds.map((targetId) =>
      selectMessagesForTargetId(messages, targetId),
    );
    const first = selections[0];
    if (!first) {
      throw new Error("Native turn selector unexpectedly produced no target");
    }
    if (
      selections.some(
        (selection) =>
          selection.start !== first.start || selection.end !== first.end,
      )
    ) {
      throw new Error(
        `Native turn identifiers do not resolve to the same completed turn: ${targetIds.join(", ")}`,
      );
    }
    return {
      start: first.start,
      end: first.end,
      ...(targetIds[0] !== undefined ? { turnId: targetIds[0] } : {}),
    };
  }

  const end = previousAssistantResponseIndex(messages, messages.length - 1);
  if (end === undefined) {
    throw new Error("Native transcript has no completed assistant response");
  }
  return {
    start: previousUserIndex(messages, end),
    end,
    ...(messages[end]?.id !== undefined ? { turnId: messages[end]?.id } : {}),
  };
}

function selectMessagesForTargetId(
  messages: NativeTraceMessage[],
  targetId: string,
): { start: number; end: number } {
  const matches = messages
    .map((message, index) =>
      messageMatchesAnyProviderId(message, targetId) ? index : -1,
    )
    .filter((index) => index >= 0);
  if (matches.length === 0) {
    throw new Error(
      `Native turn id not found in provider transcript: ${targetId}`,
    );
  }
  const end =
    nextAssistantResponseIndex(messages, matches[matches.length - 1] ?? 0) ??
    previousAssistantResponseIndex(messages, matches[matches.length - 1] ?? 0);
  if (end === undefined) {
    throw new Error(
      `Native turn has no completed assistant response: ${targetId}`,
    );
  }
  const start = previousUserIndex(messages, matches[0] ?? end);
  return { start, end };
}

function previousUserIndex(
  messages: NativeTraceMessage[],
  fromIndex: number,
): number {
  for (let index = fromIndex; index >= 0; index -= 1) {
    if (isUserPrompt(messages[index])) {
      return index;
    }
  }
  return 0;
}

function nextAssistantResponseIndex(
  messages: NativeTraceMessage[],
  fromIndex: number,
): number | undefined {
  for (let index = fromIndex; index < messages.length; index += 1) {
    if (isAssistantResponse(messages[index])) {
      return index;
    }
  }
  return undefined;
}

function previousAssistantResponseIndex(
  messages: NativeTraceMessage[],
  fromIndex: number,
): number | undefined {
  for (let index = fromIndex; index >= 0; index -= 1) {
    if (isAssistantResponse(messages[index])) {
      return index;
    }
  }
  return undefined;
}

function isAssistantResponse(
  message: NativeTraceMessage | undefined,
): message is NativeTraceMessage {
  return (
    message?.role === "assistant" &&
    message.parts.some((part) => part.type === "assistant_text" && part.text)
  );
}

function isUserPrompt(
  message: NativeTraceMessage | undefined,
): message is NativeTraceMessage {
  return (
    message?.role === "user" &&
    message.parts.some((part) => part.type === "user_text" && part.text)
  );
}

function messageMatchesAnyProviderId(
  message: NativeTraceMessage,
  targetId: string,
): boolean {
  if (message.id === targetId) {
    return true;
  }
  if (
    Object.values(message.providerIds ?? {}).some((value) => value === targetId)
  ) {
    return true;
  }
  return message.parts.some((part) => {
    if (part.type === "tool_call") {
      return (
        part.call.id === targetId ||
        Object.values(part.call.providerIds ?? {}).some(
          (value) => value === targetId,
        )
      );
    }
    if (part.type === "tool_result") {
      return (
        part.result.toolCallId === targetId ||
        Object.values(part.result.providerIds ?? {}).some(
          (value) => value === targetId,
        )
      );
    }
    if (part.type === "shell_output" && part.toolCallId) {
      return part.toolCallId === targetId;
    }
    return false;
  });
}

export function turnTraceId(
  provider: string,
  sessionId: string,
  turnId: string | undefined,
): string {
  return [provider, sessionId, turnId ?? "last-turn"].join(":");
}

function sourcesForTurn(
  traceSources: readonly RawSourcePointer[],
  messages: readonly NativeTraceMessage[],
): RawSourcePointer[] {
  const sources = [...traceSources];
  for (const source of messages.map((message) => message.source)) {
    if (!source) {
      continue;
    }
    if (!sources.some((existing) => sameSource(existing, source))) {
      sources.push(source);
    }
  }
  return sources;
}

function sameSource(left: RawSourcePointer, right: RawSourcePointer): boolean {
  return (
    left.provider === right.provider &&
    left.sourceType === right.sourceType &&
    left.path === right.path &&
    left.table === right.table &&
    left.key === right.key &&
    left.line === right.line &&
    left.recordId === right.recordId
  );
}
