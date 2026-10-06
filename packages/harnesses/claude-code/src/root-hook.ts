import { isAbsolute } from "node:path";
import { isUint8Array } from "node:util/types";

const maximumBytes = 65_536;
const maximumNodes = 4_096;
const maximumDepth = 32;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// eslint-disable-next-line @typescript-eslint/unbound-method -- intrinsic invoked only through Reflect.apply with a validated receiver.
const byteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;
// eslint-disable-next-line @typescript-eslint/unbound-method -- intrinsic invoked only through Reflect.apply with an owned receiver.
const setBytes = Uint8Array.prototype.set;
const apply = Reflect.apply;
const decoded = new WeakSet<object>();
const addDecoded = decoded.add.bind(decoded);
const hasDecoded = decoded.has.bind(decoded);

type JsonValue = null | boolean | number | string | JsonValue[] | JsonRecord;
type JsonRecord = { [key: string]: JsonValue };
type NativeJson =
  | null
  | boolean
  | number
  | string
  | readonly NativeJson[]
  | { readonly [key: string]: NativeJson };

const freezeJson = (value: JsonValue): NativeJson => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
};

const invalid = (): never => {
  throw new Error("claude-code.mapping.invalid");
};

// Parse the bounded bytes ourselves to reject duplicate keys at every depth.
// This is input validation, not authentication of a vendor process or payload.
const parseJson = (text: string): JsonValue => {
  let offset = 0;
  let nodes = 0;
  const scalar =
    /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/uy;
  const whitespace = () => {
    while (/[\t\n\r ]/u.test(text[offset] ?? "!")) offset += 1;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === "\\") offset += 1;
      else if (character === '"') {
        const value: unknown = JSON.parse(text.slice(start, offset));
        if (typeof value !== "string") return invalid();
        return value;
      }
    }
    return invalid();
  };
  const value = (depth: number): JsonValue => {
    if (depth > maximumDepth || ++nodes > maximumNodes) return invalid();
    whitespace();
    const character = text[offset];
    if (character === '"') return string();
    if (character === "{" || character === "[") {
      offset += 1;
      const object: JsonRecord = Object.create(null) as JsonRecord;
      const array: JsonValue[] = [];
      const close = character === "{" ? "}" : "]";
      whitespace();
      if (text[offset] === close) {
        offset += 1;
        return character === "{" ? object : array;
      }
      for (;;) {
        if (character === "{") {
          whitespace();
          if (text[offset] !== '"') return invalid();
          const key = string();
          if (Object.hasOwn(object, key)) return invalid();
          whitespace();
          if (text[offset++] !== ":") return invalid();
          object[key] = value(depth + 1);
        } else array.push(value(depth + 1));
        whitespace();
        const separator = text[offset++];
        if (separator === close) return character === "{" ? object : array;
        if (separator !== ",") return invalid();
      }
    }
    scalar.lastIndex = offset;
    const token = scalar.exec(text)?.[0];
    if (token === undefined) return invalid();
    offset += token.length;
    const parsed: unknown = JSON.parse(token);
    if (typeof parsed === "number" && !Number.isFinite(parsed))
      return invalid();
    return parsed as null | boolean | number;
  };
  const result = value(0);
  whitespace();
  if (offset !== text.length) return invalid();
  return result;
};

const record = (value: JsonValue): JsonRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value;
};
const text = (value: JsonValue | undefined, maximum: number): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    // eslint-disable-next-line no-control-regex -- reject control characters in native identifiers and workspace paths.
    /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)
  )
    return invalid();
  return value;
};

const eventKeys = Object.freeze({
  SessionStart: ["source", "model", "agent_type"],
  PreToolUse: ["tool_name", "tool_input", "tool_use_id"],
  PostToolUse: [
    "tool_name",
    "tool_input",
    "tool_response",
    "tool_use_id",
    "duration_ms",
  ],
  Stop: [
    "stop_hook_active",
    "last_assistant_message",
    "background_tasks",
    "session_crons",
  ],
  SessionEnd: ["reason"],
} as const);
export type ClaudeCodeRootHookEvent = keyof typeof eventKeys;
export type ClaudeCodeRootHookInput = Readonly<{
  eventName: ClaudeCodeRootHookEvent;
  sessionId: string;
  workspacePath: string;
  promptId: string | null;
  toolName: string | null;
  toolUseId: string | null;
  stopHookActive: boolean | null;
  assistantMessage: string | null;
  model: string | null;
  toolInput: NativeJson;
  toolResponse: NativeJson;
  toolResponsePresent: boolean;
  durationMilliseconds: number | null;
}>;

const commonKeys = [
  "session_id",
  "transcript_path",
  "cwd",
  "hook_event_name",
  "prompt_id",
  "permission_mode",
  "agent_id",
  "agent_type",
  "effort",
];
const optionalText = (value: JsonValue | undefined): string | null =>
  value === undefined ? null : text(value, 256);

const nativeMetadata = (input: JsonRecord, event: ClaudeCodeRootHookEvent) => {
  const duration = input.duration_ms;
  if (
    duration !== undefined &&
    (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)
  )
    return invalid();
  const tool = event === "PreToolUse" || event === "PostToolUse";
  return {
    // Preserve facts without inventing LLM attribution or epoch timing.
    model: optionalText(input.model),
    toolInput: tool ? freezeJson(input.tool_input ?? null) : null,
    toolResponse:
      event === "PostToolUse" ? freezeJson(input.tool_response ?? null) : null,
    toolResponsePresent: event === "PostToolUse",
    durationMilliseconds: typeof duration === "number" ? duration : null,
  };
};

export const decodeClaudeCodeRootHookInput = (
  bytes: Uint8Array,
): ClaudeCodeRootHookInput => {
  try {
    if (
      !isUint8Array(bytes) ||
      Object.getPrototypeOf(bytes) !== Uint8Array.prototype
    )
      return invalid();
    const length = apply(byteLength, bytes, []) as number;
    if (length === 0 || length > maximumBytes) return invalid();
    const copy = new Uint8Array(length);
    apply(setBytes, copy, [bytes]);
    const input = record(parseJson(decoder.decode(copy)));
    const event = input.hook_event_name;
    if (typeof event !== "string" || !Object.hasOwn(eventKeys, event))
      return invalid();
    const eventName = event as ClaudeCodeRootHookEvent;
    const allowed = [...commonKeys, ...eventKeys[eventName]];
    if (Object.keys(input).some((key) => !allowed.includes(key)))
      return invalid();
    const sessionId = text(input.session_id, 256);
    const workspacePath = text(input.cwd, 4_096);
    if (!isAbsolute(workspacePath)) return invalid();
    if (
      typeof input.transcript_path !== "string" ||
      input.transcript_path.length > 4_096
    )
      return invalid();
    const tool = eventName === "PreToolUse" || eventName === "PostToolUse";
    if (tool) record(input.tool_input ?? null);
    if (eventName === "PostToolUse" && !Object.hasOwn(input, "tool_response"))
      return invalid();
    if (eventName === "Stop" && typeof input.stop_hook_active !== "boolean")
      return invalid();
    if (eventName === "SessionStart") text(input.source, 256);
    if (eventName === "SessionEnd") text(input.reason, 256);
    const assistantMessage = input.last_assistant_message;
    if (
      assistantMessage !== undefined &&
      (typeof assistantMessage !== "string" || assistantMessage.length > 32_768)
    )
      return invalid();
    const result = Object.freeze({
      eventName,
      sessionId,
      workspacePath,
      promptId: optionalText(input.prompt_id),
      toolName: tool ? text(input.tool_name, 256) : null,
      toolUseId: tool ? text(input.tool_use_id, 256) : null,
      stopHookActive:
        eventName === "Stop" ? (input.stop_hook_active as boolean) : null,
      assistantMessage:
        typeof assistantMessage === "string" ? assistantMessage : null,
      ...nativeMetadata(input, eventName),
    });
    addDecoded(result);
    return result;
  } catch {
    return invalid();
  }
};

export const requireDecodedClaudeCodeRootHook = (
  input: ClaudeCodeRootHookInput,
): ClaudeCodeRootHookInput => (hasDecoded(input) ? input : invalid());
