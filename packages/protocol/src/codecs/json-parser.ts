import { deepFreeze } from "../schema/immutable.js";

const jsonNumberBrand: unique symbol = Symbol("protocol.json.number");

export type JsonNumber = Readonly<{
  readonly [jsonNumberBrand]: true;
  readonly lexical: string;
}>;

export interface ParsedJsonArray extends ReadonlyArray<ParsedJson> {
  readonly __parsedJsonArrayBrand?: never;
}

export interface ParsedJsonObject {
  readonly [key: string]: ParsedJson;
}

export type ParsedJson =
  null | boolean | string | JsonNumber | ParsedJsonArray | ParsedJsonObject;

export type JsonParseLimits = Readonly<{
  maximumBytes: number;
  maximumDepth: number;
  maximumNodes: number;
  maximumObjectKeys: number;
  maximumArrayItems: number;
  maximumStringBytes: number;
}>;

export class BoundedJsonError extends Error {
  public constructor() {
    super("protocol.codec.invalid");
    this.name = "BoundedJsonError";
  }
}

const invalid = (): never => {
  throw new BoundedJsonError();
};

const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?/uy;
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

const hasOnlyUnicodeScalars = (value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const decodeInput = (input: unknown, limits: JsonParseLimits) => {
  if (typeof input === "string") {
    if (!hasOnlyUnicodeScalars(input)) invalid();
    if (textEncoder.encode(input).byteLength > limits.maximumBytes) invalid();
    return input;
  }
  if (input instanceof Uint8Array) {
    if (input.byteLength > limits.maximumBytes) invalid();
    const decoded = textDecoder.decode(input);
    /* v8 ignore next -- fatal UTF-8 decoding cannot produce an unpaired UTF-16 surrogate. */
    if (!hasOnlyUnicodeScalars(decoded)) invalid();
    return decoded;
  }
  return invalid();
};

export const isJsonNumber = (value: unknown): value is JsonNumber =>
  typeof value === "object" && value !== null && jsonNumberBrand in value;

type ParserState = {
  source: string;
  position: number;
  nodes: number;
  limits: JsonParseLimits;
};

const skipWhitespace = (state: ParserState) => {
  while (
    state.source[state.position] === " " ||
    state.source[state.position] === "\n" ||
    state.source[state.position] === "\r" ||
    state.source[state.position] === "\t"
  ) {
    state.position += 1;
  }
};

const parseString = (state: ParserState): string => {
  const start = state.position;
  if (state.source[state.position] !== '"') invalid();
  state.position += 1;
  let escaped = false;
  while (state.position < state.source.length) {
    const character = state.source[state.position]!;
    if (escaped) {
      if (character === "u") {
        if (
          !/^[\da-fA-F]{4}$/u.test(
            state.source.slice(state.position + 1, state.position + 5),
          )
        )
          invalid();
        state.position += 4;
      } else if (!'"\\/bfnrt'.includes(character)) {
        invalid();
      }
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      state.position += 1;
      const value = JSON.parse(
        state.source.slice(start, state.position),
      ) as unknown;
      if (
        typeof value !== "string" ||
        !hasOnlyUnicodeScalars(value) ||
        textEncoder.encode(value).byteLength > state.limits.maximumStringBytes
      )
        invalid();
      return value as string;
    } else if (character.charCodeAt(0) < 0x20) {
      invalid();
    }
    state.position += 1;
  }
  return invalid();
};

const parseArray = (state: ParserState, depth: number): ParsedJsonArray => {
  state.position += 1;
  const values: ParsedJson[] = [];
  skipWhitespace(state);
  if (state.source[state.position] === "]") {
    state.position += 1;
    return deepFreeze(values);
  }
  while (true) {
    if (values.length >= state.limits.maximumArrayItems) invalid();
    values.push(parseValue(state, depth + 1));
    skipWhitespace(state);
    if (state.source[state.position] === "]") {
      state.position += 1;
      return deepFreeze(values);
    }
    if (state.source[state.position] !== ",") invalid();
    state.position += 1;
  }
};

const parseObject = (state: ParserState, depth: number): ParsedJsonObject => {
  state.position += 1;
  const record = Object.create(null) as Record<string, ParsedJson>;
  let keyCount = 0;
  skipWhitespace(state);
  if (state.source[state.position] === "}") {
    state.position += 1;
    return deepFreeze(record);
  }
  while (true) {
    if (keyCount++ >= state.limits.maximumObjectKeys) invalid();
    skipWhitespace(state);
    const key = parseString(state);
    skipWhitespace(state);
    if (state.source[state.position] !== ":") invalid();
    state.position += 1;
    record[key] = parseValue(state, depth + 1);
    skipWhitespace(state);
    if (state.source[state.position] === "}") {
      state.position += 1;
      return deepFreeze(record);
    }
    if (state.source[state.position] !== ",") invalid();
    state.position += 1;
  }
};

function parseValue(state: ParserState, depth: number): ParsedJson {
  if (
    depth > state.limits.maximumDepth ||
    ++state.nodes > state.limits.maximumNodes
  )
    invalid();
  skipWhitespace(state);
  const character = state.source[state.position];
  if (character === '"') return parseString(state);
  for (const [token, value] of [
    ["true", true],
    ["false", false],
    ["null", null],
  ] as const) {
    if (state.source.startsWith(token, state.position)) {
      state.position += token.length;
      return value;
    }
  }
  if (character === "[") return parseArray(state, depth);
  if (character === "{") return parseObject(state, depth);
  numberPattern.lastIndex = state.position;
  const match = numberPattern.exec(state.source);
  if (match === null || match.index !== state.position) invalid();
  const matched = match!;
  state.position = numberPattern.lastIndex;
  return deepFreeze({
    [jsonNumberBrand]: true as const,
    lexical: matched[0],
  });
}

export const parseBoundedJson = (
  input: unknown,
  limits: JsonParseLimits,
): ParsedJson => {
  try {
    const source = decodeInput(input, limits);
    const state: ParserState = { source, position: 0, nodes: 0, limits };
    const value = parseValue(state, 0);
    skipWhitespace(state);
    if (state.position !== source.length) invalid();
    return value;
  } catch {
    throw new BoundedJsonError();
  }
};
