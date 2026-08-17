import {
  fromJson,
  ScalarType,
  type DescField,
  type DescMessage,
  type JsonValue,
  type MessageShape,
} from "@bufbuild/protobuf";

import {
  isJsonNumber,
  type JsonNumber,
  type ParsedJson,
  type ParsedJsonObject,
} from "./json-parser.js";
import { base64ToBytes, bytesToBase64, hexToBytes } from "./binary-text.js";

export class JsonToProtobufError extends Error {
  public constructor() {
    super("protocol.codec.invalid");
    this.name = "JsonToProtobufError";
  }
}

const invalid = (): never => {
  throw new JsonToProtobufError();
};

const isRecord = (value: ParsedJson): value is ParsedJsonObject =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !isJsonNumber(value);

const integerLexical = (lexical: string) => {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(lexical);
  if (match === null) invalid();
  const matched = match!;
  const fraction = matched[3] ?? "";
  const exponent = Number(matched[4] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) invalid();
  let digits = `${matched[2]}${fraction}`;
  const scale = fraction.length - exponent;
  if (scale > 0) {
    if (scale >= digits.length) {
      if (!/^0+$/u.test(digits)) invalid();
      digits = "0";
    } else {
      const removed = digits.slice(digits.length - scale);
      if (!/^0+$/u.test(removed)) invalid();
      digits = digits.slice(0, digits.length - scale);
    }
  } else if (scale < 0) {
    digits += "0".repeat(-scale);
  }
  digits = digits.replace(/^0+(?=\d)/u, "");
  if (digits.length > 30) invalid();
  return matched[1] === "-" && digits !== "0" ? `-${digits}` : digits;
};

/** Internal verification seam; intentionally absent from package exports. */
export const normalizeIntegerLexicalForTesting = integerLexical;

const finiteNumber = (value: ParsedJson) => {
  if (!isJsonNumber(value)) invalid();
  const parsed = Number((value as JsonNumber).lexical);
  if (!Number.isFinite(parsed)) invalid();
  return parsed;
};

const quotedNumberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?$/u;

const floatingValue = (value: ParsedJson): JsonValue => {
  if (typeof value === "string") {
    if (["NaN", "Infinity", "-Infinity"].includes(value)) return value;
    if (!quotedNumberPattern.test(value) || !Number.isFinite(Number(value)))
      invalid();
    return value;
  }
  return finiteNumber(value);
};

const identityByteLength = (field: DescField) => {
  if (field.localName === "traceId") return 16;
  if (field.localName === "spanId" || field.localName === "parentSpanId")
    return 8;
  return undefined;
};

const scalarValue = (field: DescField, value: ParsedJson): JsonValue => {
  if (field.scalar === ScalarType.STRING) {
    if (typeof value !== "string") invalid();
    return value as string;
  }
  if (field.scalar === ScalarType.BYTES) {
    if (typeof value !== "string") invalid();
    const identityLength = identityByteLength(field);
    return bytesToBase64(
      identityLength === undefined
        ? base64ToBytes(value as string)
        : hexToBytes(value as string, identityLength),
    );
  }
  if (field.scalar === ScalarType.BOOL) {
    if (typeof value !== "boolean") invalid();
    return value as boolean;
  }
  if (
    field.scalar === ScalarType.INT64 ||
    field.scalar === ScalarType.UINT64 ||
    field.scalar === ScalarType.SINT64 ||
    field.scalar === ScalarType.FIXED64 ||
    field.scalar === ScalarType.SFIXED64
  ) {
    if (typeof value !== "string" && !isJsonNumber(value)) invalid();
    if (typeof value === "string") return integerLexical(value);
    const number = finiteNumber(value);
    if (!Number.isInteger(number)) invalid();
    return BigInt(number).toString();
  }
  if (field.scalar === ScalarType.DOUBLE || field.scalar === ScalarType.FLOAT)
    return floatingValue(value);
  const normalized =
    typeof value === "string" ? integerLexical(value) : undefined;
  const number =
    normalized === undefined ? finiteNumber(value) : Number(normalized);
  if (
    !Number.isInteger(number) ||
    number < -2_147_483_648 ||
    number > 4_294_967_295
  ) {
    invalid();
  }
  return number;
};

const transformField = (field: DescField, value: ParsedJson): JsonValue => {
  if (field.fieldKind === "message")
    return transformMessage(field.message, value);
  if (field.fieldKind === "enum") {
    const number = finiteNumber(value);
    if (!Number.isInteger(number)) invalid();
    return number;
  }
  if (field.fieldKind === "scalar") return scalarValue(field, value);
  /* v8 ignore else -- every non-list descriptor kind returned above. */
  if (field.fieldKind === "list") {
    if (!Array.isArray(value)) invalid();
    return (value as readonly ParsedJson[]).map((entry) => {
      /* v8 ignore else -- the pinned OTLP closure has only repeated messages. */
      if (field.listKind === "message")
        return transformMessage(field.message, entry);
      /* v8 ignore next -- the pinned OTLP v1.11 schema closure has no repeated enum field. */
      if (field.listKind === "enum") {
        const number = finiteNumber(entry);
        if (!Number.isInteger(number)) invalid();
        return number;
      }
      /* v8 ignore next -- the pinned OTLP v1.11 closure has no repeated scalar field. */
      return scalarValue(field, entry);
    });
  }
  /* v8 ignore next -- the pinned closure has no map field and all descriptor kinds are closed. */
  return invalid();
};

const transformMessage = (
  schema: DescMessage,
  value: ParsedJson,
): JsonValue => {
  if (!isRecord(value)) invalid();
  const record = value as ParsedJsonObject;
  const output = Object.create(null) as Record<string, JsonValue>;
  const oneofs = new Set<object>();
  for (const key of Object.keys(record)) {
    const field = schema.fields.find((candidate) => candidate.jsonName === key);
    if (field === undefined) {
      if (schema.fields.some((candidate) => candidate.name === key)) invalid();
      continue;
    }
    if (record[key] === null) continue;
    if (field.oneof !== undefined) {
      if (oneofs.has(field.oneof)) invalid();
      oneofs.add(field.oneof);
    }
    output[key] = transformField(field, record[key]!);
  }
  return output;
};

export const protobufMessageFromParsedJson = <Desc extends DescMessage>(
  schema: Desc,
  value: ParsedJson,
): MessageShape<Desc> => {
  try {
    return fromJson(schema, transformMessage(schema, value), {
      ignoreUnknownFields: true,
      recursionLimit: 24,
    });
  } catch {
    throw new JsonToProtobufError();
  }
};
