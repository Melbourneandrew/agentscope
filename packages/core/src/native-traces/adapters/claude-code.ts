import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

const CLAUDE_PROVIDER = "claude-code";
const DEFAULT_MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;

export type ClaudeCodeNativeTraceAdapterOptions = {
  claudeProjectsRoot?: string;
  maxTranscriptBytes?: number;
};

type ClaudeJsonlRecord = {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
    usage?: Record<string, unknown>;
  };
  attachment?: Record<string, unknown>;
  toolUseResult?: unknown;
  sourceToolAssistantUUID?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  attributionSkill?: string;
};

export function createClaudeCodeNativeTraceAdapter(
  options: ClaudeCodeNativeTraceAdapterOptions = {},
): NativeTraceAdapter {
  return new ClaudeCodeNativeTraceAdapter(options);
}

class ClaudeCodeNativeTraceAdapter implements NativeTraceAdapter {
  readonly provider = CLAUDE_PROVIDER;

  private readonly claudeProjectsRoot: string;
  private readonly maxTranscriptBytes: number;

  constructor(options: ClaudeCodeNativeTraceAdapterOptions) {
    this.claudeProjectsRoot =
      options.claudeProjectsRoot ?? join(homedir(), ".claude/projects");
    this.maxTranscriptBytes =
      options.maxTranscriptBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
  }

  async discover(
    options: NativeTraceDiscoverOptions = {},
  ): Promise<NativeTraceDiscoveryItem[]> {
    await Promise.resolve();
    try {
      const paths = candidateTranscriptPaths(
        this.claudeProjectsRoot,
        options.cwd,
      );
      const items = paths
        .filter((path) => matchesPathOptions(path, options))
        .map((path) => this.discoveryItemFromPath(path, options))
        .filter((item): item is NativeTraceDiscoveryItem => Boolean(item))
        .filter((item) => matchesDiscoveryOptions(item, options))
        .sort(compareDiscoveryItems)
        .slice(0, options.limit ?? undefined);
      return items;
    } catch {
      return [];
    }
  }

  async parse(
    item: NativeTraceDiscoveryItem,
    options: NativeTraceParseOptions = {},
  ): Promise<NativeAgentTrace> {
    await Promise.resolve();
    if (!this.canParseSource(item.source)) {
      throw new Error(
        `Claude Code adapter cannot parse source: ${item.source.sourceType}`,
      );
    }
    const path = item.source.path;
    if (!path) {
      throw new Error("Claude Code transcript source path is required");
    }
    const maxBytes = options.maxBytes ?? this.maxTranscriptBytes;
    const stats = statSync(path);
    if (stats.size > maxBytes) {
      throw new Error(`Claude Code transcript exceeds max parse size: ${path}`);
    }

    const records = readJsonlRecords(path);
    const messages = records.flatMap((record, index) =>
      messageFromRecord(record, index, path),
    );
    const metadata = summarizeRecords(records);
    const id = metadata.sessionId ?? item.sessionId ?? basename(path, ".jsonl");
    return NativeAgentTraceSchema.parse({
      id,
      provider: CLAUDE_PROVIDER,
      traceId: id,
      sessionId: id,
      title: item.title,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt ?? item.updatedAt,
      cwd: metadata.cwd ?? item.cwd ?? cwdFromProjectPath(path),
      model: metadata.model ?? item.model,
      messages,
      sources: [
        {
          provider: CLAUDE_PROVIDER,
          sourceType: "jsonl",
          path,
          recordId: id,
        },
      ],
      metadata: {
        claude_version: metadata.version,
        claude_project_path: dirname(path),
        has_sidechain_messages: metadata.hasSidechainMessages,
      },
    });
  }

  canParseSource(source: RawSourcePointer): boolean {
    return source.provider === CLAUDE_PROVIDER && source.sourceType === "jsonl";
  }

  private discoveryItemFromPath(
    path: string,
    options: NativeTraceDiscoverOptions,
  ): NativeTraceDiscoveryItem | undefined {
    try {
      const stats = statSync(path);
      if (!stats.isFile() || stats.size > this.maxTranscriptBytes) {
        return undefined;
      }
      if (options.since && stats.mtime <= new Date(options.since)) {
        return undefined;
      }
      const records = readJsonlRecords(path);
      const metadata = summarizeRecords(records);
      const sessionId = metadata.sessionId ?? basename(path, ".jsonl");
      return NativeTraceDiscoveryItemSchema.parse({
        provider: CLAUDE_PROVIDER,
        traceId: path,
        sessionId,
        title: metadata.preview,
        preview: metadata.preview,
        cwd: metadata.cwd ?? cwdFromProjectPath(path),
        model: metadata.model,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt ?? new Date(stats.mtimeMs).toISOString(),
        source: {
          provider: CLAUDE_PROVIDER,
          sourceType: "jsonl",
          path,
          recordId: sessionId,
        },
      });
    } catch {
      return undefined;
    }
  }
}

function messageFromRecord(
  record: ClaudeJsonlRecord,
  index: number,
  path: string,
): NativeTraceMessage[] {
  const parts = partsFromRecord(record);
  if (parts.length === 0) {
    return [];
  }
  const id = record.uuid ?? `${basename(path, ".jsonl")}:${index + 1}`;
  const role = roleFromRecord(record);
  const providerIds: Record<string, string> = {
    claude_uuid: id,
    ...(record.sessionId ? { claude_session_id: record.sessionId } : {}),
    ...(record.sourceToolAssistantUUID
      ? { claude_source_tool_assistant_uuid: record.sourceToolAssistantUUID }
      : {}),
    ...(typeof record.attributionSkill === "string"
      ? { claude_attribution_skill: record.attributionSkill }
      : {}),
  };
  return [
    {
      id,
      role,
      timestamp: record.timestamp,
      parentId: record.parentUuid ?? undefined,
      providerIds,
      model: modelFromRecord(record),
      usage: usageFromRecord(record),
      parts,
      source: {
        provider: CLAUDE_PROVIDER,
        sourceType: "jsonl",
        path,
        line: index + 1,
        recordId: record.sessionId,
      },
    },
  ];
}

const SKILL_BASE_DIR_RE = /^Base directory for this skill:\s*(.+?)\s*$/m;

function metaTextParts(text: string): NativeTracePart[] {
  const match = text.match(SKILL_BASE_DIR_RE);
  if (match?.[1]) {
    return [
      {
        type: "attachment",
        name: "skill_content",
        value: { path: match[1], text },
      },
    ];
  }
  return [{ type: "attachment", name: "meta_text", value: { text } }];
}

function partsFromRecord(record: ClaudeJsonlRecord): NativeTracePart[] {
  if (record.attachment) {
    return partsFromAttachment(record.attachment);
  }
  const role = roleFromRecord(record);
  const content = record.message?.content;
  if (typeof content === "string") {
    if (record.isMeta && role === "user" && content.trim()) {
      return metaTextParts(content);
    }
    return [
      {
        type: role === "assistant" ? "assistant_text" : "user_text",
        text: content,
      },
    ];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part): NativeTracePart[] =>
    partsFromContentPart(part, role, Boolean(record.isMeta)),
  );
}

function partsFromContentPart(
  part: unknown,
  role: NativeTraceMessage["role"],
  isMeta: boolean,
): NativeTracePart[] {
  const record = asRecord(part);
  if (!record) {
    return [];
  }
  switch (readString(record.type)) {
    case "thinking":
      return [
        {
          type: "thinking",
          text: readString(record.thinking),
          signature: readString(record.signature),
        },
      ];
    case "text": {
      const text = readString(record.text);
      if (!text) {
        return [];
      }
      if (isMeta && role === "user") {
        return metaTextParts(text);
      }
      return [
        {
          type: role === "assistant" ? "assistant_text" : "user_text",
          text,
        },
      ];
    }
    case "tool_use": {
      const id = readString(record.id) ?? "unknown";
      const name = readString(record.name) ?? "unknown";
      const input = record.input;
      const parts: NativeTracePart[] = [
        {
          type: "tool_call",
          call: {
            id,
            name,
            input,
            providerIds: { claude_tool_use_id: id },
          },
        },
      ];
      const shell = shellCommandFromToolUse(name, input);
      if (shell) {
        parts.push({ type: "shell_command", command: shell });
      }
      return parts;
    }
    case "tool_result": {
      const toolCallId = readString(record.tool_use_id) ?? "unknown";
      const parts: NativeTracePart[] = [
        {
          type: "tool_result",
          result: {
            toolCallId,
            output: record.content,
            isError: Boolean(record.is_error),
            providerIds: { claude_tool_use_id: toolCallId },
          },
        },
      ];
      const shell = shellOutputFromToolResult(toolCallId, record.content);
      if (shell) {
        parts.push(shell);
      }
      return parts;
    }
    default:
      return [{ type: "unknown", value: record }];
  }
}

function partsFromAttachment(
  attachment: Record<string, unknown>,
): NativeTracePart[] {
  const toolCallId = readString(attachment.toolUseID);
  if (readString(attachment.type) === "command") {
    return [
      {
        type: "shell_output",
        toolCallId,
        stdout: readString(attachment.stdout),
        stderr: readString(attachment.stderr),
        exitCode: readNumber(attachment.exitCode),
      },
    ];
  }
  return [
    {
      type: "attachment",
      name: readString(attachment.type),
      value: attachment,
    },
  ];
}

function summarizeRecords(records: ClaudeJsonlRecord[]): {
  sessionId?: string;
  cwd?: string;
  version?: string;
  model?: NativeTraceModel;
  createdAt?: string;
  updatedAt?: string;
  preview?: string;
  hasSidechainMessages?: boolean;
} {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let version: string | undefined;
  let model: NativeTraceModel | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let preview: string | undefined;
  let hasSidechainMessages = false;

  for (const record of records) {
    sessionId ??= readString(record.sessionId);
    cwd ??= readString(record.cwd);
    version ??= readString(record.version);
    model ??= modelFromRecord(record);
    if (record.timestamp) {
      createdAt ??= record.timestamp;
      updatedAt = record.timestamp;
    }
    if (!preview && record.message?.role === "user") {
      preview = previewFromContent(record.message.content);
    }
    hasSidechainMessages = hasSidechainMessages || Boolean(record.isSidechain);
  }

  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(preview !== undefined ? { preview } : {}),
    hasSidechainMessages,
  };
}

function roleFromRecord(record: ClaudeJsonlRecord): NativeTraceMessage["role"] {
  if (record.type === "attachment") {
    return "tool";
  }
  return normalizeRole(
    readString(record.message?.role) ?? readString(record.type),
  );
}

function modelFromRecord(
  record: ClaudeJsonlRecord,
): NativeTraceModel | undefined {
  const name = readString(record.message?.model);
  if (!name) {
    return undefined;
  }
  return {
    provider: "anthropic",
    name,
    version: readString(record.version),
  };
}

function usageFromRecord(
  record: ClaudeJsonlRecord,
): NativeTraceUsage | undefined {
  const usage = record.message?.usage;
  if (!usage) {
    return undefined;
  }
  const inputTokens = readNumber(usage.input_tokens);
  const outputTokens = readNumber(usage.output_tokens);
  const cachedInputTokens = readNumber(usage.cache_read_input_tokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens:
      inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined,
  };
}

function shellCommandFromToolUse(
  name: string,
  input: unknown,
): { command: string; cwd?: string } | undefined {
  const record = asRecord(input);
  if (!record) {
    return undefined;
  }
  if (!["Bash", "Shell", "Terminal"].includes(name)) {
    return undefined;
  }
  const command = readString(record.command) ?? readString(record.cmd);
  if (!command) {
    return undefined;
  }
  const cwd = readString(record.cwd);
  return {
    command,
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

function shellOutputFromToolResult(
  toolCallId: string,
  content: unknown,
): NativeTracePart | undefined {
  const record = asRecord(content);
  if (record) {
    const stdout = readString(record.stdout) ?? readString(record.output);
    const stderr = readString(record.stderr);
    const exitCode =
      readNumber(record.exitCode) ?? readNumber(record.exit_code);
    if (stdout || stderr || exitCode !== undefined) {
      return {
        type: "shell_output",
        toolCallId,
        stdout,
        stderr,
        exitCode,
      };
    }
  }
  if (typeof content === "string") {
    return {
      type: "shell_output",
      toolCallId,
      stdout: content,
    };
  }
  return undefined;
}

function candidateTranscriptPaths(
  projectsRoot: string,
  cwd: string | undefined,
): string[] {
  if (cwd) {
    return listProjectJsonlFiles(
      join(projectsRoot, encodeClaudeProjectPath(cwd)),
    );
  }
  return safeReaddir(projectsRoot).flatMap((entry) =>
    listProjectJsonlFiles(join(projectsRoot, entry)),
  );
}

function listProjectJsonlFiles(projectDir: string): string[] {
  return safeReaddir(projectDir)
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => join(projectDir, entry));
}

export function encodeClaudeProjectPath(path: string): string {
  return resolve(path).replace(/\//g, "-");
}

function cwdFromProjectPath(path: string): string | undefined {
  const project = basename(dirname(path));
  return project.startsWith("-") ? project.replace(/-/g, "/") : undefined;
}

function matchesPathOptions(
  path: string,
  options: NativeTraceDiscoverOptions,
): boolean {
  return !options.sourcePath || options.sourcePath === path;
}

function matchesDiscoveryOptions(
  item: NativeTraceDiscoveryItem,
  options: NativeTraceDiscoverOptions,
): boolean {
  if (
    options.traceId &&
    options.traceId !== item.traceId &&
    options.traceId !== item.sessionId
  ) {
    return false;
  }
  if (options.cwd && item.cwd && resolve(options.cwd) !== resolve(item.cwd)) {
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

function readJsonlRecords(path: string): ClaudeJsonlRecord[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .map((record) => asRecord(record) as ClaudeJsonlRecord)
    .filter((record) => Boolean(record));
}

function previewFromContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.slice(0, 160);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content
    .map((part) => readString(asRecord(part)?.text))
    .filter((text): text is string => Boolean(text))
    .join("\n")
    .slice(0, 160);
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

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
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

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function dateMs(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 0 : date.valueOf();
}
