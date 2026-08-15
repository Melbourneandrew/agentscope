import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
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

const CURSOR_PROVIDER = "cursor";
const DEFAULT_SQLITE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_SQLITE_VALUE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;

export type CursorNativeTraceAdapterOptions = {
  cursorGlobalStateDbPath?: string;
  cursorProjectsRoot?: string;
  sqliteBinary?: string;
  sqliteTimeoutMs?: number;
  maxSQLiteValueBytes?: number;
  maxTranscriptBytes?: number;
};

type CursorComposerRecord = {
  composerId?: string;
  name?: string;
  text?: string;
  createdAt?: number | string;
  lastUpdatedAt?: number | string;
  updatedAt?: number | string;
  workspaceIdentifier?: {
    uri?: {
      fsPath?: string;
      path?: string;
      external?: string;
    };
  };
  modelConfig?: {
    modelName?: string;
    selectedModels?: Array<{
      modelId?: string;
      parameters?: Array<{ id?: string; value?: string }>;
    }>;
  };
  fullConversationHeadersOnly?: Array<{
    bubbleId?: string;
    type?: number;
  }>;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  filesChangedCount?: number;
};

type CursorBubbleRecord = {
  bubbleId?: string;
  requestId?: string;
  createdAt?: string | number;
  text?: string;
  type?: number;
  thinking?: {
    text?: string;
    signature?: string;
  };
  thinkingDurationMs?: number;
  tokenCount?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  toolResults?: unknown;
  diffsSinceLastApply?: unknown;
  fileDiffTrajectories?: unknown;
  humanChanges?: unknown;
};

export function createCursorNativeTraceAdapter(
  options: CursorNativeTraceAdapterOptions = {},
): NativeTraceAdapter {
  const adapter = new CursorNativeTraceAdapter(options);
  return adapter;
}

class CursorNativeTraceAdapter implements NativeTraceAdapter {
  readonly provider = CURSOR_PROVIDER;

  private readonly cursorGlobalStateDbPath: string;
  private readonly cursorProjectsRoot: string;
  private readonly sqliteBinary: string;
  private readonly sqliteTimeoutMs: number;
  private readonly maxSQLiteValueBytes: number;
  private readonly maxTranscriptBytes: number;

  constructor(options: CursorNativeTraceAdapterOptions) {
    this.cursorGlobalStateDbPath =
      options.cursorGlobalStateDbPath ??
      join(
        homedir(),
        "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
      );
    this.cursorProjectsRoot =
      options.cursorProjectsRoot ?? join(homedir(), ".cursor/projects");
    this.sqliteBinary = options.sqliteBinary ?? "sqlite3";
    this.sqliteTimeoutMs = options.sqliteTimeoutMs ?? DEFAULT_SQLITE_TIMEOUT_MS;
    this.maxSQLiteValueBytes =
      options.maxSQLiteValueBytes ?? DEFAULT_MAX_SQLITE_VALUE_BYTES;
    this.maxTranscriptBytes =
      options.maxTranscriptBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
  }

  async discover(
    options: NativeTraceDiscoverOptions = {},
  ): Promise<NativeTraceDiscoveryItem[]> {
    const transcriptItems = this.discoverTranscriptItems(options);
    const globalItems = this.discoverGlobalComposerItems(options);
    return [...transcriptItems, ...globalItems]
      .sort(compareDiscoveryItems)
      .slice(0, options.limit ?? undefined);
  }

  async parse(
    item: NativeTraceDiscoveryItem,
    _options: NativeTraceParseOptions = {},
  ): Promise<NativeAgentTrace> {
    if (!this.canParseSource(item.source)) {
      throw new Error(
        `Cursor adapter cannot parse source: ${item.source.sourceType}`,
      );
    }

    if (item.source.sourceType === "jsonl") {
      return this.parseTranscriptItem(item);
    }
    return this.parseGlobalComposerItem(item);
  }

  canParseSource(source: RawSourcePointer): boolean {
    if (source.provider !== CURSOR_PROVIDER) {
      return false;
    }
    return (
      source.sourceType === "jsonl" || source.sourceType === "cursor-global"
    );
  }

  private discoverTranscriptItems(
    options: NativeTraceDiscoverOptions,
  ): NativeTraceDiscoveryItem[] {
    const roots = candidateTranscriptRoots(
      this.cursorProjectsRoot,
      options.cwd,
    );
    const items: NativeTraceDiscoveryItem[] = [];
    for (const root of roots) {
      if (!existsSync(root)) {
        continue;
      }
      for (const path of listTranscriptJsonlFiles(root)) {
        try {
          const stats = statSync(path);
          const traceId = transcriptTraceId(path);
          if (!matchesDiscoveryOptions(options, traceId, traceId, path)) {
            continue;
          }
          if (options.since && stats.mtime <= new Date(options.since)) {
            continue;
          }
          items.push(
            NativeTraceDiscoveryItemSchema.parse({
              provider: CURSOR_PROVIDER,
              traceId,
              sessionId: traceId.replace(/^transcript:/, ""),
              cwd: options.cwd,
              updatedAt: new Date(stats.mtimeMs).toISOString(),
              source: {
                provider: CURSOR_PROVIDER,
                sourceType: "jsonl",
                path,
                recordId: traceId,
              },
            }),
          );
        } catch {
          continue;
        }
      }
    }
    return items;
  }

  private discoverGlobalComposerItems(
    options: NativeTraceDiscoverOptions,
  ): NativeTraceDiscoveryItem[] {
    if (!existsSync(this.cursorGlobalStateDbPath)) {
      return [];
    }

    try {
      const rows = this.querySQLiteJsonRows(
        "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'",
      );
      const items: NativeTraceDiscoveryItem[] = [];
      for (const row of rows) {
        const composer = parseJsonObject<CursorComposerRecord>(row.value);
        if (!composer) {
          continue;
        }
        const composerId = composer.composerId ?? row.key.split(":")[1];
        if (!composerId) {
          continue;
        }
        const cwd = getComposerCwd(composer);
        if (options.cwd && cwd && !isSameOrNestedPath(cwd, options.cwd)) {
          continue;
        }
        const traceId = composerId;
        if (
          !matchesDiscoveryOptions(
            options,
            traceId,
            composerId,
            `global:${composerId}`,
          )
        ) {
          continue;
        }
        const updatedAt = dateFromUnknown(
          composer.lastUpdatedAt ?? composer.updatedAt ?? composer.createdAt,
        );
        if (
          options.since &&
          updatedAt &&
          updatedAt <= new Date(options.since)
        ) {
          continue;
        }
        items.push(
          NativeTraceDiscoveryItemSchema.parse({
            provider: CURSOR_PROVIDER,
            traceId,
            sessionId: composerId,
            title: readNonEmptyString(composer.name ?? composer.text),
            cwd,
            model: modelFromComposer(composer),
            createdAt: dateFromUnknown(composer.createdAt)?.toISOString(),
            updatedAt: updatedAt?.toISOString(),
            source: {
              provider: CURSOR_PROVIDER,
              sourceType: "cursor-global",
              path: this.cursorGlobalStateDbPath,
              table: "cursorDiskKV",
              key: row.key,
              recordId: composerId,
            },
          }),
        );
      }
      return items;
    } catch {
      return [];
    }
  }

  private parseTranscriptItem(
    item: NativeTraceDiscoveryItem,
  ): NativeAgentTrace {
    const path = item.source.path;
    if (!path) {
      throw new Error("Cursor transcript source path is required");
    }
    const stats = statSync(path);
    if (stats.size > this.maxTranscriptBytes) {
      throw new Error(`Cursor transcript exceeds max parse size: ${path}`);
    }
    const records = readJsonlRecords(path);
    const fallbackTimestamp = stats.mtime.toISOString();
    const messages = records.map((record, index) =>
      messageFromTranscriptRecord(record, index, path, fallbackTimestamp),
    );
    const id = item.traceId;
    return NativeAgentTraceSchema.parse({
      id,
      provider: CURSOR_PROVIDER,
      traceId: id,
      sessionId: item.sessionId ?? id.replace(/^transcript:/, ""),
      title: item.title,
      createdAt: messages[0]?.timestamp,
      updatedAt: item.updatedAt ?? messages[messages.length - 1]?.timestamp,
      cwd: item.cwd,
      model: item.model,
      messages,
      sources: [item.source],
      metadata: {
        cursor_source_kind: "agent-transcript",
      },
    });
  }

  private parseGlobalComposerItem(
    item: NativeTraceDiscoveryItem,
  ): NativeAgentTrace {
    const key = item.source.key;
    if (!key) {
      throw new Error("Cursor global source key is required");
    }
    const composer = this.readSQLiteJsonValue<CursorComposerRecord>(key);
    if (!composer) {
      throw new Error(`Cursor composer not found: ${key}`);
    }
    const composerId = composer.composerId ?? key.split(":")[1] ?? item.traceId;
    const messages = this.readComposerBubbleMessages(composer, composerId);
    const cwd = item.cwd ?? getComposerCwd(composer);
    return NativeAgentTraceSchema.parse({
      id: composerId,
      provider: CURSOR_PROVIDER,
      traceId: composerId,
      sessionId: composerId,
      title: readNonEmptyString(composer.name ?? composer.text) ?? item.title,
      createdAt: dateFromUnknown(composer.createdAt)?.toISOString(),
      updatedAt: dateFromUnknown(
        composer.lastUpdatedAt ?? composer.updatedAt ?? composer.createdAt,
      )?.toISOString(),
      cwd,
      model: modelFromComposer(composer),
      messages,
      sources: [
        item.source,
        ...messages
          .map((message) => message.source)
          .filter((source): source is RawSourcePointer => Boolean(source)),
      ],
      metadata: {
        cursor_source_kind: "global-composer",
        total_lines_added: composer.totalLinesAdded,
        total_lines_removed: composer.totalLinesRemoved,
        files_changed_count: composer.filesChangedCount,
      },
    });
  }

  private readComposerBubbleMessages(
    composer: CursorComposerRecord,
    composerId: string,
  ): NativeTraceMessage[] {
    const headers = composer.fullConversationHeadersOnly ?? [];
    return headers
      .map((header, index) => {
        const bubbleId = header.bubbleId;
        if (!bubbleId) {
          return undefined;
        }
        const key = `bubbleId:${composerId}:${bubbleId}`;
        const bubble = this.readSQLiteJsonValue<CursorBubbleRecord>(key);
        if (!bubble) {
          return undefined;
        }
        return messageFromBubbleRecord(bubble, composerId, key, index);
      })
      .filter((message): message is NativeTraceMessage => Boolean(message));
  }

  private readSQLiteJsonValue<T extends Record<string, unknown>>(
    key: string,
  ): T | undefined {
    const rows = this.querySQLiteJsonRows(
      `SELECT key, value FROM cursorDiskKV WHERE key = ${sqliteQuote(key)} LIMIT 1`,
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return parseJsonObject<T>(row.value);
  }

  private querySQLiteJsonRows(
    sql: string,
  ): Array<{ key: string; value: string }> {
    const output = execFileSync(
      this.sqliteBinary,
      ["-json", this.cursorGlobalStateDbPath, sql],
      {
        encoding: "utf8",
        timeout: this.sqliteTimeoutMs,
        maxBuffer: this.maxSQLiteValueBytes,
      },
    );
    if (!output.trim()) {
      return [];
    }
    const rows = JSON.parse(output) as Array<{
      key?: unknown;
      value?: unknown;
    }>;
    return rows
      .map((row) => ({
        key: String(row.key ?? ""),
        value:
          typeof row.value === "string" ? row.value : String(row.value ?? ""),
      }))
      .filter((row) => row.key && row.value);
  }
}

function messageFromTranscriptRecord(
  record: unknown,
  index: number,
  path: string,
  fallbackTimestamp?: string,
): NativeTraceMessage {
  const source: RawSourcePointer = {
    provider: CURSOR_PROVIDER,
    sourceType: "jsonl",
    path,
    line: index + 1,
  };
  const value = asRecord(record) ?? {};
  const message = asRecord(value.message);
  const role = normalizeRole(readString(value.role));
  const content = Array.isArray(message?.content) ? message.content : [];
  return {
    id:
      readString(value.id) ??
      readString(message?.id) ??
      `cursor-message-${index}`,
    role,
    timestamp:
      readString(value.timestamp) ??
      readString(message?.timestamp) ??
      fallbackTimestamp,
    providerIds: {
      cursor_transcript_line: String(index + 1),
    },
    parts: content.flatMap((part, partIndex) =>
      partsFromTranscriptContent(part, role, index, partIndex),
    ),
    source,
  };
}

function partsFromTranscriptContent(
  part: unknown,
  role: NativeTraceMessage["role"],
  messageIndex: number,
  partIndex: number,
): NativeTracePart[] {
  const record = asRecord(part);
  if (!record) {
    return [];
  }
  const type = readString(record.type);
  if (type === "text") {
    const text = cursorTranscriptText(role, String(record.text ?? ""));
    return [
      {
        type: role === "user" ? "user_text" : "assistant_text",
        text,
      },
    ];
  }
  if (type === "tool_use") {
    const name = readString(record.name) ?? "unknown";
    const id =
      readString(record.id) ?? `cursor-tool-${messageIndex}-${partIndex}`;
    const parts: NativeTracePart[] = [
      {
        type: "tool_call",
        call: {
          id,
          name,
          input: record.input,
          providerIds: { cursor_tool_name: name },
        },
      },
    ];
    const shell = shellCommandFromToolUse(name, record.input);
    if (shell) {
      parts.push({ type: "shell_command", command: shell });
    }
    return parts;
  }
  return [{ type: "unknown", value: record }];
}

function cursorTranscriptText(
  role: NativeTraceMessage["role"],
  text: string,
): string {
  const unwrapped = role === "user" ? unwrapUserQuery(text) : text;
  return stripRedactedSentinels(unwrapped);
}

function unwrapUserQuery(text: string): string {
  const match = text.match(/<user_query>\s*\n?([\s\S]*?)\n?\s*<\/user_query>/);
  return match?.[1]?.trim() ?? text;
}

function stripRedactedSentinels(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "[REDACTED]")
    .join("\n")
    .trim();
}

function messageFromBubbleRecord(
  bubble: CursorBubbleRecord,
  composerId: string,
  key: string,
  index: number,
): NativeTraceMessage {
  const parts: NativeTracePart[] = [];
  if (bubble.thinking?.text || bubble.thinking?.signature) {
    parts.push({
      type: "thinking",
      text: bubble.thinking.text,
      signature: bubble.thinking.signature,
      durationMs: bubble.thinkingDurationMs,
    });
  }
  if (bubble.text) {
    parts.push({ type: "assistant_text", text: bubble.text });
  }
  parts.push(...partsFromCursorToolResults(bubble.toolResults));
  parts.push(...partsFromCursorFileEdits(bubble));
  if (parts.length === 0) {
    parts.push({ type: "unknown", value: { bubbleType: bubble.type } });
  }

  return {
    id: bubble.bubbleId ?? `${composerId}-bubble-${index}`,
    role: bubbleRole(bubble),
    timestamp: dateFromUnknown(bubble.createdAt)?.toISOString(),
    providerIds: {
      cursor_composer_id: composerId,
      cursor_bubble_id: bubble.bubbleId ?? `${index}`,
      ...(bubble.requestId ? { cursor_request_id: bubble.requestId } : {}),
    },
    usage: usageFromBubble(bubble),
    parts,
    source: {
      provider: CURSOR_PROVIDER,
      sourceType: "cursor-global",
      table: "cursorDiskKV",
      key,
      recordId: bubble.bubbleId,
    },
  };
}

function partsFromCursorToolResults(value: unknown): NativeTracePart[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item, index) => {
    const record = asRecord(item);
    if (!record) {
      return [];
    }
    const id =
      readString(record.toolCallId) ??
      readString(record.toolUseId) ??
      readString(record.id) ??
      `cursor-tool-result-${index}`;
    return [
      {
        type: "tool_result" as const,
        result: {
          toolCallId: id,
          output: record.output ?? record.result ?? record.content ?? record,
          isError: Boolean(record.isError ?? record.error),
        },
      },
    ];
  });
}

function partsFromCursorFileEdits(
  bubble: CursorBubbleRecord,
): NativeTracePart[] {
  const edits: NativeTracePart[] = [];
  for (const candidate of [
    bubble.diffsSinceLastApply,
    bubble.fileDiffTrajectories,
    bubble.humanChanges,
  ]) {
    for (const record of flattenRecords(candidate)) {
      const path =
        readString(record.path) ??
        readString(record.filePath) ??
        readString(record.relativePath) ??
        readString(record.uri);
      if (!path) {
        continue;
      }
      edits.push({
        type: "file_edit",
        edit: {
          path,
          operation: normalizeFileOperation(readString(record.operation)),
          diff: readString(record.diff) ?? readString(record.patch),
          addedLines: readNumber(record.addedLines),
          removedLines: readNumber(record.removedLines),
        },
      });
    }
  }
  return edits;
}

function readJsonlRecords(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function listTranscriptJsonlFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of safeReaddir(root)) {
    const transcriptDir = join(root, entry);
    if (!safeStat(transcriptDir)?.isDirectory()) {
      continue;
    }
    for (const file of safeReaddir(transcriptDir)) {
      if (file.endsWith(".jsonl")) {
        files.push(join(transcriptDir, file));
      }
    }
  }
  return files;
}

function candidateTranscriptRoots(
  projectsRoot: string,
  cwd: string | undefined,
): string[] {
  if (cwd) {
    return [
      join(projectsRoot, encodeCursorProjectPath(cwd), "agent-transcripts"),
    ];
  }
  return safeReaddir(projectsRoot).map((entry) =>
    join(projectsRoot, entry, "agent-transcripts"),
  );
}

export function encodeCursorProjectPath(path: string): string {
  return resolve(path)
    .replace(/^\//, "")
    .replace(/[^A-Za-z0-9]/g, "-");
}

function transcriptTraceId(path: string): string {
  return `transcript:${basename(path, ".jsonl")}`;
}

function matchesDiscoveryOptions(
  options: NativeTraceDiscoverOptions,
  traceId: string,
  sessionId: string,
  sourcePath: string,
): boolean {
  if (
    options.traceId &&
    options.traceId !== traceId &&
    options.traceId !== sessionId
  ) {
    return false;
  }
  if (options.sourcePath && options.sourcePath !== sourcePath) {
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

function modelFromComposer(
  composer: CursorComposerRecord,
): NativeTraceModel | undefined {
  const selected = composer.modelConfig?.selectedModels?.[0];
  const name = composer.modelConfig?.modelName ?? selected?.modelId;
  const reasoningEffort = selected?.parameters?.find(
    (parameter) => parameter.id === "reasoning_effort",
  )?.value;
  if (!name && !reasoningEffort) {
    return undefined;
  }
  return { name, reasoningEffort };
}

function getComposerCwd(composer: CursorComposerRecord): string | undefined {
  return (
    readNonEmptyString(composer.workspaceIdentifier?.uri?.fsPath) ??
    readNonEmptyString(composer.workspaceIdentifier?.uri?.path) ??
    readNonEmptyString(composer.workspaceIdentifier?.uri?.external)
  );
}

function usageFromBubble(
  bubble: CursorBubbleRecord,
): NativeTraceUsage | undefined {
  if (!bubble.tokenCount) {
    return undefined;
  }
  const inputTokens = readNumber(bubble.tokenCount.inputTokens);
  const outputTokens = readNumber(bubble.tokenCount.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined,
  };
}

function bubbleRole(bubble: CursorBubbleRecord): NativeTraceMessage["role"] {
  if (bubble.type === 1 || bubble.thinking || bubble.toolResults) {
    return "assistant";
  }
  return "user";
}

function shellCommandFromToolUse(
  name: string,
  input: unknown,
): { command: string; cwd?: string } | undefined {
  const record = asRecord(input);
  if (!record) {
    return undefined;
  }
  const command =
    readString(record.command) ??
    (["shell", "bash", "terminal"].some((term) =>
      name.toLowerCase().includes(term),
    )
      ? readString(record.cmd)
      : undefined);
  if (!command) {
    return undefined;
  }
  return {
    command,
    cwd: readString(record.cwd),
  };
}

function normalizeRole(value: string | undefined): NativeTraceMessage["role"] {
  switch (value) {
    case "system":
    case "user":
    case "assistant":
    case "tool":
    case "agent":
      return value;
    default:
      return "unknown";
  }
}

function normalizeFileOperation(
  value: string | undefined,
): "create" | "update" | "delete" | "rename" | "unknown" {
  switch (value) {
    case "create":
    case "update":
    case "delete":
    case "rename":
      return value;
    default:
      return "unknown";
  }
}

function flattenRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap(flattenRecords);
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  return [record, ...Object.values(record).flatMap(flattenRecords)];
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeStat(path: string) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function parseJsonObject<T extends Record<string, unknown>>(
  value: string,
): T | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed) as T | undefined;
  } catch {
    return undefined;
  }
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

function dateFromUnknown(value: unknown): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(millis);
  }
  if (typeof value === "string" && value.length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? undefined : date;
  }
  return undefined;
}

function dateMs(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 0 : date.valueOf();
}

function isSameOrNestedPath(candidate: string, expected: string): boolean {
  const resolvedCandidate = resolve(candidate);
  const resolvedExpected = resolve(expected);
  return (
    resolvedCandidate === resolvedExpected ||
    resolvedCandidate.startsWith(`${resolvedExpected}/`) ||
    resolvedExpected.startsWith(`${resolvedCandidate}/`)
  );
}

function sqliteQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
