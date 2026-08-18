import { createHash } from "node:crypto";

import type { W3CTraceId } from "@agentscope/protocol";

export const TRACE_SEARCH_DEFAULT_LIMIT = 50;
export const TRACE_SEARCH_MAXIMUM_LIMIT = 200;
export const TRACE_SEARCH_MAXIMUM_TAGS = 32;

declare const queryFingerprintBrand: unique symbol;
export type TraceQueryFingerprint = string & {
  readonly [queryFingerprintBrand]: "TraceQueryFingerprint";
};

export type TraceSearchInput = Readonly<{
  traceId?: string;
  from?: string;
  to?: string;
  harness?: string;
  branch?: string;
  model?: string;
  sessionId?: string;
  tags?: readonly string[];
  limit?: number;
}>;

export type TraceSearchQuery = Readonly<{
  traceId?: W3CTraceId;
  from?: string;
  to: string;
  harness?: string;
  branch?: string;
  model?: string;
  sessionId?: string;
  tags: readonly string[];
  limit: number;
  ordering: "start-time-desc-trace-id-asc";
  fingerprint: TraceQueryFingerprint;
}>;

export type TraceQueryNormalization = Readonly<{
  commandStartedAt: string;
  knownHarnessIds: readonly string[];
}>;

const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const objectKeys = Object.keys;
const textEncoder = new TextEncoder();
const queryRegistry = new WeakSet<object>();
const allowedInputKeys = new Set([
  "branch",
  "from",
  "harness",
  "limit",
  "model",
  "sessionId",
  "tags",
  "to",
  "traceId",
]);

export class TraceQueryError extends Error {
  public readonly code = "destination.trace-query.invalid";

  public constructor() {
    super("destination.trace-query.invalid");
    this.name = "TraceQueryError";
  }
}

const invalid = (): never => {
  throw new TraceQueryError();
};

const valueOf = (descriptors: PropertyDescriptorMap, key: string): unknown => {
  const descriptor = descriptors[key];
  if (!descriptor || !("value" in descriptor)) return invalid();
  return descriptor.value;
};

const optionalValue = (
  descriptors: PropertyDescriptorMap,
  key: string,
): unknown =>
  descriptors[key] === undefined ? undefined : valueOf(descriptors, key);

const boundedText = (value: unknown, maximumBytes: number): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumBytes ||
    textEncoder.encode(value).byteLength > maximumBytes ||
    /\p{Cc}/u.test(value)
  )
    return invalid();
  return value;
};

const timestamp = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 40) return invalid();
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (!match) return invalid();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return invalid();
  const milliseconds = Date.parse(value);
  /* v8 ignore next -- the exact calendar and offset grammar above always parses finitely in Node. */
  if (!Number.isFinite(milliseconds)) return invalid();
  return new Date(milliseconds).toISOString();
};

const traceId = (value: unknown): W3CTraceId => {
  if (
    typeof value !== "string" ||
    !/^[\da-f]{32}$/u.test(value) ||
    value === "0".repeat(32)
  )
    return invalid();
  return value as W3CTraceId;
};

const tags = (value: unknown): readonly string[] => {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > TRACE_SEARCH_MAXIMUM_TAGS)
    return invalid();
  const descriptors = objectGetOwnPropertyDescriptors(value);
  const output: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) return invalid();
    const tag = boundedText(descriptor.value, 256);
    if (seen.has(tag)) return invalid();
    seen.add(tag);
    output.push(tag);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (
      key !== "length" &&
      (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key))
    )
      return invalid();
  }
  return Object.freeze(output.sort());
};

const knownHarnesses = (value: unknown): ReadonlySet<string> => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64)
    return invalid();
  const descriptors = objectGetOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)),
    )
  )
    return invalid();
  const output = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) return invalid();
    const id = boundedText(descriptor.value, 64);
    if (output.has(id)) return invalid();
    output.add(id);
  }
  return output;
};

const fingerprint = (material: object): TraceQueryFingerprint =>
  `sha256-${createHash("sha256").update(JSON.stringify(material)).digest("hex")}` as TraceQueryFingerprint;

export const normalizeTraceSearchQuery = (
  input: TraceSearchInput,
  normalization: TraceQueryNormalization,
): TraceSearchQuery => {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      typeof normalization !== "object" ||
      normalization === null
    )
      return invalid();
    const inputDescriptors = objectGetOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(inputDescriptors).some(
        (key) => typeof key !== "string" || !allowedInputKeys.has(key),
      )
    )
      return invalid();
    const normalizationDescriptors =
      objectGetOwnPropertyDescriptors(normalization);
    if (
      Reflect.ownKeys(normalizationDescriptors).some(
        (key) => typeof key !== "string",
      ) ||
      objectKeys(normalizationDescriptors).sort().join(",") !==
        "commandStartedAt,knownHarnessIds"
    )
      return invalid();
    const known = knownHarnesses(
      valueOf(normalizationDescriptors, "knownHarnessIds"),
    );
    const fromValue = optionalValue(inputDescriptors, "from");
    const toValue = optionalValue(inputDescriptors, "to");
    const harnessValue = optionalValue(inputDescriptors, "harness");
    const limitValue = optionalValue(inputDescriptors, "limit");
    const normalizedFrom =
      fromValue === undefined ? undefined : timestamp(fromValue);
    const normalizedTo = timestamp(
      toValue === undefined
        ? valueOf(normalizationDescriptors, "commandStartedAt")
        : toValue,
    );
    if (
      normalizedFrom !== undefined &&
      Date.parse(normalizedFrom) >= Date.parse(normalizedTo)
    )
      return invalid();
    const harness =
      harnessValue === undefined ? undefined : boundedText(harnessValue, 64);
    if (harness !== undefined && !known.has(harness)) return invalid();
    const limit =
      limitValue === undefined ? TRACE_SEARCH_DEFAULT_LIMIT : limitValue;
    if (
      !Number.isSafeInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > TRACE_SEARCH_MAXIMUM_LIMIT
    )
      return invalid();
    const material = {
      ...(inputDescriptors.traceId
        ? { traceId: traceId(valueOf(inputDescriptors, "traceId")) }
        : {}),
      ...(normalizedFrom === undefined ? {} : { from: normalizedFrom }),
      to: normalizedTo,
      ...(harness === undefined ? {} : { harness }),
      ...(inputDescriptors.branch
        ? { branch: boundedText(valueOf(inputDescriptors, "branch"), 512) }
        : {}),
      ...(inputDescriptors.model
        ? { model: boundedText(valueOf(inputDescriptors, "model"), 512) }
        : {}),
      ...(inputDescriptors.sessionId
        ? {
            sessionId: boundedText(valueOf(inputDescriptors, "sessionId"), 512),
          }
        : {}),
      tags: tags(optionalValue(inputDescriptors, "tags")),
      limit: limit as number,
      ordering: "start-time-desc-trace-id-asc" as const,
    };
    const query = Object.freeze({
      ...material,
      fingerprint: fingerprint(material),
    });
    queryRegistry.add(query);
    return query;
  } catch {
    return invalid();
  }
};

export const isTraceQueryFingerprint = (
  value: unknown,
): value is TraceQueryFingerprint =>
  typeof value === "string" && /^sha256-[\da-f]{64}$/u.test(value);

export const isTraceSearchQuery = (value: unknown): value is TraceSearchQuery =>
  typeof value === "object" && value !== null && queryRegistry.has(value);
