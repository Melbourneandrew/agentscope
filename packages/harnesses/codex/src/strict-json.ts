const utf8 = new TextDecoder("utf-8", { fatal: true });
const maximumJsonDepth = 64;
const maximumJsonNodes = 8_192;

type JsonAuditState = {
  readonly text: string;
  index: number;
  nodes: number;
};

const reject = (): never => {
  throw new Error("codex.json.invalid");
};

const skipWhitespace = (state: JsonAuditState): void => {
  while (/\s/u.test(state.text[state.index] ?? "")) state.index += 1;
};

const auditString = (state: JsonAuditState): string => {
  const start = state.index++;
  let escaped = false;
  while (state.index < state.text.length) {
    const character = state.text[state.index++];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      const value: unknown = JSON.parse(state.text.slice(start, state.index));
      return typeof value === "string" ? value : reject();
    }
  }
  return reject();
};

const auditPrimitive = (state: JsonAuditState): void => {
  const start = state.index;
  while (
    state.index < state.text.length &&
    !/[\s,\]}]/u.test(state.text[state.index] ?? "")
  )
    state.index += 1;
  if (state.index === start) reject();
};

const auditValue = (state: JsonAuditState, depth: number): void => {
  if (depth > maximumJsonDepth || ++state.nodes > maximumJsonNodes) reject();
  skipWhitespace(state);
  const character = state.text[state.index];
  if (character === "{") {
    auditObject(state, depth + 1);
    return;
  }
  if (character === "[") {
    auditArray(state, depth + 1);
    return;
  }
  if (character === '"') {
    auditString(state);
    return;
  }
  auditPrimitive(state);
};

const auditObject = (state: JsonAuditState, depth: number): void => {
  state.index += 1;
  const keys = new Set<string>();
  skipWhitespace(state);
  if (state.text[state.index] === "}") {
    state.index += 1;
    return;
  }
  for (;;) {
    if (state.text[state.index] !== '"') reject();
    const key = auditString(state);
    if (keys.has(key)) reject();
    keys.add(key);
    skipWhitespace(state);
    if (state.text[state.index] !== ":") reject();
    state.index += 1;
    auditValue(state, depth);
    skipWhitespace(state);
    const separator = state.text[state.index++];
    if (separator === "}") return;
    if (separator !== ",") reject();
    skipWhitespace(state);
  }
};

const auditArray = (state: JsonAuditState, depth: number): void => {
  state.index += 1;
  skipWhitespace(state);
  if (state.text[state.index] === "]") {
    state.index += 1;
    return;
  }
  for (;;) {
    auditValue(state, depth);
    skipWhitespace(state);
    const separator = state.text[state.index++];
    if (separator === "]") return;
    if (separator !== ",") reject();
    skipWhitespace(state);
  }
};

export const parseCodexBoundedDuplicateAwareJson = (
  bytes: Uint8Array,
  maximumBytes: number,
): unknown => {
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) reject();
  const text = utf8.decode(bytes);
  const state: JsonAuditState = { text, index: 0, nodes: 0 };
  auditValue(state, 0);
  skipWhitespace(state);
  if (state.index !== text.length) reject();
  return JSON.parse(text) as unknown;
};
