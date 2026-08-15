import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  NativeAgentTrace,
  NativeTraceAdapter,
  NativeTraceDiscoveryItem,
  NativeTraceDiscoverOptions,
  NativeTraceMessage,
  NativeTraceModel,
  NativeTraceParseOptions,
  NativeTracePart,
  NativeTraceUsage,
  RawSourcePointer,
} from "../types.js";
import {
  NativeAgentTraceSchema,
  NativeTraceDiscoveryItemSchema,
} from "../types.js";

const CODEX_PROVIDER = "codex";
const DEFAULT_SQLITE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_SQLITE_VALUE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ROLLOUT_BYTES = 20 * 1024 * 1024;

export type CodexNativeTraceAdapterOptions = {
  codexStateDbPath?: string;
  sqliteBinary?: string;
  sqliteTimeoutMs?: number;
  maxSQLiteValueBytes?: number;
  maxRolloutBytes?: number;
};

type CodexThreadRow = {
  id: string;
  rollout_path: string;
  created_at?: number;
  updated_at?: number;
  created_at_ms?: number;
  updated_at_ms?: number;
  source?: string;
  thread_source?: string;
  model_provider?: string;
  cwd?: string;
  title?: string;
  git_sha?: string;
  git_branch?: string;
  git_origin_url?: string;
  cli_version?: string;
  first_user_message?: string;
  agent_nickname?: string;
  agent_role?: string;
  memory_mode?: string;
  model?: string;
  reasoning_effort?: string;
  preview?: string;
};

type CodexJsonlRecord = {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

export function createCodexNativeTraceAdapter(
  options: CodexNativeTraceAdapterOptions = {},
): NativeTraceAdapter {
  return new CodexNativeTraceAdapter(options);
}

class CodexNativeTraceAdapter implements NativeTraceAdapter {
  readonly provider = CODEX_PROVIDER;

  private readonly codexStateDbPath: string;
  private readonly sqliteBinary: string;
  private readonly sqliteTimeoutMs: number;
  private readonly maxSQLiteValueBytes: number;
  private readonly maxRolloutBytes: number;

  constructor(options: CodexNativeTraceAdapterOptions) {
    this.codexStateDbPath =
      options.codexStateDbPath ?? defaultCodexStateDbPath();
    this.sqliteBinary = options.sqliteBinary ?? "sqlite3";
    this.sqliteTimeoutMs = options.sqliteTimeoutMs ?? DEFAULT_SQLITE_TIMEOUT_MS;
    this.maxSQLiteValueBytes =
      options.maxSQLiteValueBytes ?? DEFAULT_MAX_SQLITE_VALUE_BYTES;
    this.maxRolloutBytes = options.maxRolloutBytes ?? DEFAULT_MAX_ROLLOUT_BYTES;
  }

  async discover(
    options: NativeTraceDiscoverOptions = {},
  ): Promise<NativeTraceDiscoveryItem[]> {
    const sourcePathItem = this.discoverSourcePathItem(options);
    if (!existsSync(this.codexStateDbPath)) {
      return sourcePathItem ? [sourcePathItem] : [];
    }

    try {
      const rows = this.queryThreadRows(options);
      const dbItems = rows
        .filter((row) => matchesDiscoveryOptions(options, row))
        .map((row) => discoveryItemFromThread(row, this.codexStateDbPath))
        .filter((item): item is NativeTraceDiscoveryItem => Boolean(item));
      const items = [...(sourcePathItem ? [sourcePathItem] : []), ...dbItems];
      return dedupeDiscoveryItems(items)
        .sort(compareDiscoveryItems)
        .slice(0, options.limit ?? undefined);
    } catch {
      return sourcePathItem ? [sourcePathItem] : [];
    }
  }

  async parse(
    item: NativeTraceDiscoveryItem,
    options: NativeTraceParseOptions = {},
  ): Promise<NativeAgentTrace> {
    if (!this.canParseSource(item.source)) {
      throw new Error(
        `Codex adapter cannot parse source: ${item.source.sourceType}`,
      );
    }

    const row =
      item.source.sourceType === "jsonl"
        ? codexThreadRowFromJsonlItem(item)
        : this.readThreadRow(item.traceId);
    if (!row) {
      throw new Error(`Codex thread not found: ${item.traceId}`);
    }
    if (!row.rollout_path) {
      throw new Error(`Codex thread has no rollout path: ${item.traceId}`);
    }
    const stats = statSync(row.rollout_path);
    if (stats.size > (options.maxBytes ?? this.maxRolloutBytes)) {
      throw new Error(
        `Codex rollout exceeds max parse size: ${row.rollout_path}`,
      );
    }

    const records = readJsonlRecords(row.rollout_path);
    const parsed = messagesFromRolloutRecords(
      records,
      row,
      row.rollout_path,
      options,
    );
    const model = modelFromThread(row) ?? parsed.model;
    const cwd = row.cwd ?? parsed.cwd;
    return NativeAgentTraceSchema.parse({
      id: row.id,
      provider: CODEX_PROVIDER,
      traceId: row.id,
      sessionId: row.id,
      turnId: parsed.latestTurnId,
      title: readNonEmptyString(row.title),
      summary: readNonEmptyString(row.preview),
      createdAt: dateFromMillis(
        row.created_at_ms ?? secondsToMillis(row.created_at),
      )?.toISOString(),
      updatedAt: dateFromMillis(
        row.updated_at_ms ?? secondsToMillis(row.updated_at),
      )?.toISOString(),
      cwd,
      model,
      messages: parsed.messages,
      sources: [
        {
          provider: CODEX_PROVIDER,
          sourceType: "sqlite",
          path: this.codexStateDbPath,
          table: "threads",
          recordId: row.id,
        },
        {
          provider: CODEX_PROVIDER,
          sourceType: "jsonl",
          path: row.rollout_path,
          recordId: row.id,
        },
      ],
      metadata: {
        codex_source: row.source,
        codex_thread_source: row.thread_source,
        codex_cli_version: row.cli_version,
        codex_agent_nickname: row.agent_nickname,
        codex_agent_role: row.agent_role,
        codex_memory_mode: row.memory_mode,
      },
    });
  }

  canParseSource(source: RawSourcePointer): boolean {
    return (
      source.provider === CODEX_PROVIDER &&
      (source.sourceType === "sqlite" || source.sourceType === "jsonl")
    );
  }

  private readThreadRow(id: string): CodexThreadRow | undefined {
    const rows = this.querySQLiteJsonRows(
      `SELECT ${threadColumns()} FROM threads WHERE id = ${sqliteQuote(id)} LIMIT 1`,
    );
    return codexThreadRow(rows[0]);
  }

  private queryThreadRows(
    options: NativeTraceDiscoverOptions,
  ): CodexThreadRow[] {
    const clauses = ["archived = 0"];
    if (options.cwd) {
      clauses.push(`cwd = ${sqliteQuote(resolve(options.cwd))}`);
    }
    if (options.traceId) {
      clauses.push(`id = ${sqliteQuote(options.traceId)}`);
    }
    if (options.sourcePath) {
      clauses.push(`rollout_path = ${sqliteQuote(options.sourcePath)}`);
    }
    if (options.since) {
      const sinceMs = new Date(options.since).valueOf();
      if (!Number.isNaN(sinceMs)) {
        clauses.push(`updated_at_ms >= ${sinceMs}`);
      }
    }
    const limit = Number.isInteger(options.limit) ? Number(options.limit) : 100;
    const rows = this.querySQLiteJsonRows(
      [
        `SELECT ${threadColumns()} FROM threads`,
        `WHERE ${clauses.join(" AND ")}`,
        "ORDER BY updated_at_ms DESC, updated_at DESC, id DESC",
        `LIMIT ${Math.max(limit, 100)}`,
      ].join(" "),
    );
    return rows
      .map(codexThreadRow)
      .filter((row): row is CodexThreadRow => Boolean(row));
  }

  private discoverSourcePathItem(
    options: NativeTraceDiscoverOptions,
  ): NativeTraceDiscoveryItem | undefined {
    if (!options.sourcePath || !existsSync(options.sourcePath)) {
      return undefined;
    }
    try {
      const stats = statSync(options.sourcePath);
      if (!stats.isFile() || stats.size > this.maxRolloutBytes) {
        return undefined;
      }
      const traceId =
        options.traceId ?? rolloutTraceIdFromPath(options.sourcePath);
      const cwd = options.cwd ? resolve(options.cwd) : undefined;
      return NativeTraceDiscoveryItemSchema.parse({
        provider: CODEX_PROVIDER,
        traceId,
        sessionId: options.traceId ?? traceId,
        cwd,
        updatedAt: new Date(stats.mtimeMs).toISOString(),
        source: {
          provider: CODEX_PROVIDER,
          sourceType: "jsonl",
          path: options.sourcePath,
          recordId: traceId,
        },
      });
    } catch {
      return undefined;
    }
  }

  private querySQLiteJsonRows(sql: string): Array<Record<string, unknown>> {
    const output = execFileSync(
      this.sqliteBinary,
      ["-json", this.codexStateDbPath, sql],
      {
        encoding: "utf8",
        timeout: this.sqliteTimeoutMs,
        maxBuffer: this.maxSQLiteValueBytes,
      },
    );
    if (!output.trim()) {
      return [];
    }
    const rows = JSON.parse(output) as unknown;
    return Array.isArray(rows)
      ? rows.filter((row): row is Record<string, unknown> =>
          Boolean(asRecord(row)),
        )
      : [];
  }
}

function defaultCodexStateDbPath(): string {
  return process.env.CODEX_HOME
    ? join(process.env.CODEX_HOME, "state_5.sqlite")
    : join(homedir(), ".codex/state_5.sqlite");
}

function discoveryItemFromThread(
  row: CodexThreadRow,
  dbPath: string,
): NativeTraceDiscoveryItem | undefined {
  if (!row.id) {
    return undefined;
  }
  return NativeTraceDiscoveryItemSchema.parse({
    provider: CODEX_PROVIDER,
    traceId: row.id,
    sessionId: row.id,
    title: readNonEmptyString(row.title),
    preview: readNonEmptyString(row.preview ?? row.first_user_message),
    cwd: row.cwd,
    model: modelFromThread(row),
    createdAt: dateFromMillis(
      row.created_at_ms ?? secondsToMillis(row.created_at),
    )?.toISOString(),
    updatedAt: dateFromMillis(
      row.updated_at_ms ?? secondsToMillis(row.updated_at),
    )?.toISOString(),
    source: {
      provider: CODEX_PROVIDER,
      sourceType: "sqlite",
      path: dbPath,
      table: "threads",
      recordId: row.id,
    },
  });
}

function codexThreadRowFromJsonlItem(
  item: NativeTraceDiscoveryItem,
): CodexThreadRow | undefined {
  const rolloutPath = item.source.path;
  if (!rolloutPath) {
    return undefined;
  }
  return {
    id: item.sessionId ?? item.traceId,
    rollout_path: rolloutPath,
    cwd: item.cwd,
    model_provider: item.model?.provider,
    model: item.model?.name,
    reasoning_effort: item.model?.reasoningEffort,
    preview: item.preview,
    title: item.title,
  };
}

function rolloutTraceIdFromPath(path: string): string {
  const match = /rollout-[^.]+-([0-9a-f-]+)\.jsonl$/u.exec(path);
  return match?.[1] ?? path;
}

function dedupeDiscoveryItems(
  items: NativeTraceDiscoveryItem[],
): NativeTraceDiscoveryItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = [
      item.provider,
      item.traceId,
      item.source.sourceType,
      item.source.path,
    ].join(":");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function messagesFromRolloutRecords(
  records: CodexJsonlRecord[],
  row: CodexThreadRow,
  path: string,
  options: NativeTraceParseOptions,
): {
  messages: NativeTraceMessage[];
  latestTurnId?: string;
  cwd?: string;
  model?: NativeTraceModel;
} {
  const messages: NativeTraceMessage[] = [];
  let latestTurnId: string | undefined;
  let cwd = row.cwd;
  let model = modelFromThread(row);
  let latestUsage: NativeTraceUsage | undefined;

  records.forEach((record, index) => {
    const payload = asRecord(record.payload);
    const payloadType = readString(payload?.type);
    const timestamp = readString(record.timestamp);
    const turnId = readString(payload?.turn_id);
    if (turnId) {
      latestTurnId = turnId;
    }

    if (record.type === "session_meta") {
      cwd = cwd ?? readString(payload?.cwd);
      model = mergeModel(model, modelFromPayload(payload));
      return;
    }
    if (record.type === "turn_context") {
      cwd = readString(payload?.cwd) ?? cwd;
      model = mergeModel(model, modelFromPayload(payload));
      return;
    }
    if (record.type === "event_msg" && payloadType === "task_started") {
      return;
    }
    if (record.type === "event_msg" && payloadType === "token_count") {
      latestUsage = usageFromTokenCount(payload);
      return;
    }

    const parts = partsFromCodexRecord(record, index, options);
    if (parts.length === 0) {
      return;
    }
    const role = roleFromCodexRecord(record);
    const source: RawSourcePointer = {
      provider: CODEX_PROVIDER,
      sourceType: "jsonl",
      path,
      line: index + 1,
      recordId: row.id,
    };
    messages.push({
      id:
        readString(payload?.id) ??
        readString(payload?.call_id) ??
        `${row.id}:${index + 1}`,
      role,
      timestamp,
      providerIds: {
        codex_session_id: row.id,
        ...(latestTurnId ? { codex_turn_id: latestTurnId } : {}),
        ...(readString(payload?.call_id)
          ? { codex_call_id: readString(payload?.call_id) as string }
          : {}),
      },
      model:
        modelFromPayload(payload) ?? (role === "assistant" ? model : undefined),
      usage: role === "assistant" ? latestUsage : undefined,
      parts,
      source,
    });
  });

  return {
    messages: dedupeAdjacentTextMessages(messages),
    latestTurnId,
    cwd,
    model,
  };
}

function partsFromCodexRecord(
  record: CodexJsonlRecord,
  index: number,
  options: NativeTraceParseOptions,
): NativeTracePart[] {
  const payload = asRecord(record.payload);
  const type = readString(payload?.type);
  if (!payload || !type) {
    return [];
  }

  if (
    record.type === "event_msg" &&
    (type === "user_message" ||
      (type === "agent_message" &&
        normalizeRole(readString(payload.role)) === "user"))
  ) {
    const text = readString(payload.message);
    return text ? [{ type: "user_text", text }] : [];
  }

  if (record.type !== "response_item") {
    return [];
  }

  switch (type) {
    case "message":
      return messageParts(payload);
    case "reasoning":
      return reasoningParts(payload, options);
    case "function_call":
    case "custom_tool_call":
      return toolCallParts(payload, index);
    case "function_call_output":
    case "custom_tool_call_output":
      return toolOutputParts(payload);
    default:
      return [{ type: "unknown", value: payload }];
  }
}

function messageParts(payload: Record<string, unknown>): NativeTracePart[] {
  const role = normalizeRole(readString(payload.role));
  if (role !== "user" && role !== "assistant") {
    return [];
  }
  const content = payload.content;
  if (typeof content === "string") {
    return [
      {
        type: role === "user" ? "user_text" : "assistant_text",
        text: content,
      },
    ];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part): NativeTracePart[] => {
    const record = asRecord(part);
    if (!record) {
      return [];
    }
    const type = readString(record.type);
    const text =
      readString(record.text) ??
      readString(record.input_text) ??
      readString(record.output_text);
    if (role === "user" && (type === "input_text" || text)) {
      return text ? [{ type: "user_text" as const, text }] : [];
    }
    if (
      role === "assistant" &&
      (type === "output_text" || type === "text" || text)
    ) {
      return text ? [{ type: "assistant_text" as const, text }] : [];
    }
    return [{ type: "unknown" as const, value: record }];
  });
}

function dedupeAdjacentTextMessages(
  messages: NativeTraceMessage[],
): NativeTraceMessage[] {
  return messages.filter((message, index) => {
    const previous = messages[index - 1];
    if (!previous || previous.role !== message.role) {
      return true;
    }
    const previousText = singleTextPart(previous);
    const text = singleTextPart(message);
    return !previousText || !text || previousText !== text;
  });
}

function singleTextPart(message: NativeTraceMessage): string | undefined {
  if (message.parts.length !== 1) {
    return undefined;
  }
  const part = message.parts[0];
  if (part?.type === "user_text" || part?.type === "assistant_text") {
    return part.text;
  }
  return undefined;
}

function reasoningParts(
  payload: Record<string, unknown>,
  options: NativeTraceParseOptions,
): NativeTracePart[] {
  const summary = Array.isArray(payload.summary) ? payload.summary : [];
  const text = summary
    .map((item) => readString(asRecord(item)?.text))
    .filter((value): value is string => Boolean(value))
    .join("\n");
  if (text) {
    return [{ type: "thinking", text }];
  }
  if (readString(payload.encrypted_content)) {
    return [
      {
        type: "thinking",
        signature: options.includeRawContent
          ? readString(payload.encrypted_content)
          : "encrypted_content_present",
      },
    ];
  }
  return [];
}

function toolCallParts(
  payload: Record<string, unknown>,
  index: number,
): NativeTracePart[] {
  const name = readString(payload.name) ?? "unknown";
  const id = readString(payload.call_id) ?? `codex-tool-${index}`;
  const input = parseMaybeJson(payload.arguments ?? payload.input);
  const parts: NativeTracePart[] = [
    {
      type: "tool_call",
      call: {
        id,
        name,
        input,
        providerIds: { codex_call_id: id },
      },
    },
  ];
  const shell = shellCommandFromToolCall(name, input);
  if (shell) {
    parts.push({ type: "shell_command", command: shell });
  }
  return parts;
}

function toolOutputParts(payload: Record<string, unknown>): NativeTracePart[] {
  const callId = readString(payload.call_id) ?? "unknown";
  const output = payload.output ?? payload.result;
  const parts: NativeTracePart[] = [
    {
      type: "tool_result",
      result: {
        toolCallId: callId,
        output,
        isError: Boolean(payload.is_error ?? payload.error),
        providerIds: { codex_call_id: callId },
      },
    },
  ];
  const shell = shellOutputFromToolOutput(callId, output);
  if (shell) {
    parts.push(shell);
  }
  return parts;
}

function shellCommandFromToolCall(
  name: string,
  input: unknown,
): { command: string; cwd?: string } | undefined {
  const record = asRecord(input);
  if (!record) {
    return undefined;
  }
  if (!["exec_command", "shell", "bash", "terminal"].includes(name)) {
    return undefined;
  }
  const command = readString(record.cmd) ?? readString(record.command);
  if (!command) {
    return undefined;
  }
  return {
    command,
    cwd: readString(record.workdir) ?? readString(record.cwd),
  };
}

function shellOutputFromToolOutput(
  toolCallId: string,
  output: unknown,
): NativeTracePart | undefined {
  const record = asRecord(output);
  if (!record) {
    return undefined;
  }
  const stdout = readString(record.output) ?? readString(record.stdout);
  const stderr = readString(record.stderr);
  const exitCode = readNumber(record.exit_code) ?? readNumber(record.exitCode);
  if (!stdout && !stderr && exitCode === undefined) {
    return undefined;
  }
  return {
    type: "shell_output",
    toolCallId,
    stdout,
    stderr,
    exitCode,
  };
}

function usageFromTokenCount(
  payload: Record<string, unknown> | undefined,
): NativeTraceUsage | undefined {
  const info = asRecord(payload?.info);
  const usage =
    asRecord(info?.last_token_usage) ?? asRecord(info?.total_token_usage);
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: readNumber(usage.input_tokens),
    outputTokens: readNumber(usage.output_tokens),
    cachedInputTokens: readNumber(usage.cached_input_tokens),
    reasoningOutputTokens: readNumber(usage.reasoning_output_tokens),
    totalTokens: readNumber(usage.total_tokens),
  };
}

function roleFromCodexRecord(
  record: CodexJsonlRecord,
): NativeTraceMessage["role"] {
  const payload = asRecord(record.payload);
  const payloadType = readString(payload?.type);
  if (
    payloadType === "function_call_output" ||
    payloadType === "custom_tool_call_output"
  ) {
    return "tool";
  }
  if (
    payloadType === "function_call" ||
    payloadType === "custom_tool_call" ||
    payloadType === "reasoning"
  ) {
    return "assistant";
  }
  return normalizeRole(readString(payload?.role));
}

function normalizeRole(value: string | undefined): NativeTraceMessage["role"] {
  switch (value) {
    case "system":
    case "developer":
      return "system";
    case "user":
    case "assistant":
    case "tool":
    case "agent":
      return value;
    default:
      return "unknown";
  }
}

function modelFromThread(row: CodexThreadRow): NativeTraceModel | undefined {
  if (!row.model && !row.model_provider && !row.reasoning_effort) {
    return undefined;
  }
  return {
    provider: row.model_provider,
    name: row.model,
    reasoningEffort: row.reasoning_effort,
  };
}

function modelFromPayload(
  payload: Record<string, unknown> | undefined,
): NativeTraceModel | undefined {
  const name = readString(payload?.model);
  const provider = readString(payload?.model_provider);
  const reasoningEffort = readString(payload?.effort);
  if (!name && !provider && !reasoningEffort) {
    return undefined;
  }
  return { provider, name, reasoningEffort };
}

function mergeModel(
  current: NativeTraceModel | undefined,
  next: NativeTraceModel | undefined,
): NativeTraceModel | undefined {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  return {
    provider: current.provider ?? next.provider,
    name: current.name ?? next.name,
    version: current.version ?? next.version,
    reasoningEffort: current.reasoningEffort ?? next.reasoningEffort,
    contextWindow: current.contextWindow ?? next.contextWindow,
  };
}

function codexThreadRow(
  row: Record<string, unknown> | undefined,
): CodexThreadRow | undefined {
  if (!row) {
    return undefined;
  }
  const id = readString(row.id);
  const rolloutPath = readString(row.rollout_path);
  if (!id || !rolloutPath) {
    return undefined;
  }
  return {
    id,
    rollout_path: rolloutPath,
    created_at: readNumber(row.created_at),
    updated_at: readNumber(row.updated_at),
    created_at_ms: readNumber(row.created_at_ms),
    updated_at_ms: readNumber(row.updated_at_ms),
    source: readString(row.source),
    thread_source: readString(row.thread_source),
    model_provider: readString(row.model_provider),
    cwd: readString(row.cwd),
    title: readString(row.title),
    git_sha: readString(row.git_sha),
    git_branch: readString(row.git_branch),
    git_origin_url: readString(row.git_origin_url),
    cli_version: readString(row.cli_version),
    first_user_message: readString(row.first_user_message),
    agent_nickname: readString(row.agent_nickname),
    agent_role: readString(row.agent_role),
    memory_mode: readString(row.memory_mode),
    model: readString(row.model),
    reasoning_effort: readString(row.reasoning_effort),
    preview: readString(row.preview),
  };
}

function matchesDiscoveryOptions(
  options: NativeTraceDiscoverOptions,
  row: CodexThreadRow,
): boolean {
  if (options.traceId && options.traceId !== row.id) {
    return false;
  }
  if (options.sourcePath && options.sourcePath !== row.rollout_path) {
    return false;
  }
  if (options.cwd && row.cwd && resolve(row.cwd) !== resolve(options.cwd)) {
    return false;
  }
  return true;
}

function compareDiscoveryItems(
  left: NativeTraceDiscoveryItem,
  right: NativeTraceDiscoveryItem,
): number {
  return dateMs(right.updatedAt) - dateMs(left.updatedAt);
}

function readJsonlRecords(path: string): CodexJsonlRecord[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .map((record) => asRecord(record) as CodexJsonlRecord)
    .filter((record) => Boolean(record));
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function threadColumns(): string {
  return [
    "id",
    "rollout_path",
    "created_at",
    "updated_at",
    "created_at_ms",
    "updated_at_ms",
    "source",
    "thread_source",
    "model_provider",
    "cwd",
    "title",
    "git_sha",
    "git_branch",
    "git_origin_url",
    "cli_version",
    "first_user_message",
    "agent_nickname",
    "agent_role",
    "memory_mode",
    "model",
    "reasoning_effort",
    "preview",
  ].join(", ");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function secondsToMillis(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value * 1000;
}

function dateFromMillis(value: number | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  return new Date(value);
}

function dateMs(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 0 : date.valueOf();
}

function sqliteQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
