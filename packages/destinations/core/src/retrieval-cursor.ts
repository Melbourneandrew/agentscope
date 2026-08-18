import { createHash, timingSafeEqual } from "node:crypto";

import {
  createDestinationConnectionId,
  createDestinationTypeId,
  type DestinationConnectionId,
  type DestinationTypeId,
} from "./identity.js";
import { cloneJsonObject, type JsonValue } from "./plain-data.js";
import {
  isTraceQueryFingerprint,
  type TraceQueryFingerprint,
} from "./retrieval-query.js";

declare const traceCursorBrand: unique symbol;
export type TraceSearchCursor = string & {
  readonly [traceCursorBrand]: "TraceSearchCursor";
};

export type TraceCursorBinding = Readonly<{
  connectionId: DestinationConnectionId;
  destinationType: DestinationTypeId;
  configurationIdentity: string;
  queryFingerprint: TraceQueryFingerprint;
  upperTimeBound: string;
}>;

const CURSOR_PREFIX = "agentscope-cursor-v1";
const MAXIMUM_CURSOR_CHARACTERS = 16_384;
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const objectKeys = Object.keys;
const textEncoder = new TextEncoder();

export class TraceCursorError extends Error {
  public readonly code = "destination.trace-cursor.invalid";

  public constructor() {
    super("destination.trace-cursor.invalid");
    this.name = "TraceCursorError";
  }
}

const invalid = (): never => {
  throw new TraceCursorError();
};

const valueOf = (descriptors: PropertyDescriptorMap, key: string): unknown => {
  const descriptor = descriptors[key];
  if (!descriptor || !("value" in descriptor)) return invalid();
  return descriptor.value;
};

const boundedIdentity = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    textEncoder.encode(value).byteLength > 512 ||
    /\p{Cc}/u.test(value)
  )
    return invalid();
  return value;
};

export const validateTraceCursorBinding = (
  input: TraceCursorBinding,
): TraceCursorBinding => {
  if (typeof input !== "object" || input === null) return invalid();
  const descriptors = objectGetOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    objectKeys(descriptors).sort().join(",") !==
      "configurationIdentity,connectionId,destinationType,queryFingerprint,upperTimeBound"
  )
    return invalid();
  const queryFingerprint = valueOf(descriptors, "queryFingerprint");
  const upperTimeBound = valueOf(descriptors, "upperTimeBound");
  if (
    !isTraceQueryFingerprint(queryFingerprint) ||
    typeof upperTimeBound !== "string" ||
    !Number.isFinite(Date.parse(upperTimeBound)) ||
    new Date(Date.parse(upperTimeBound)).toISOString() !== upperTimeBound
  )
    return invalid();
  return Object.freeze({
    connectionId: createDestinationConnectionId(
      valueOf(descriptors, "connectionId"),
    ),
    destinationType: createDestinationTypeId(
      valueOf(descriptors, "destinationType"),
    ),
    configurationIdentity: boundedIdentity(
      valueOf(descriptors, "configurationIdentity"),
    ),
    queryFingerprint,
    upperTimeBound,
  });
};

const digest = (payload: string): string =>
  createHash("sha256")
    .update(`${CURSOR_PREFIX}\0${payload}`)
    .digest("base64url");

const equalDigest = (left: string, right: string): boolean => {
  try {
    if (
      !/^[A-Za-z0-9_-]{43}$/u.test(left) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(right)
    )
      return false;
    const leftBytes = Buffer.from(left, "base64url");
    const rightBytes = Buffer.from(right, "base64url");
    return (
      leftBytes.length === 32 &&
      rightBytes.length === 32 &&
      leftBytes.toString("base64url") === left &&
      rightBytes.toString("base64url") === right &&
      timingSafeEqual(leftBytes, rightBytes)
    );
  } catch {
    /* v8 ignore next -- bounded base64url strings cannot make Buffer decoding throw. */
    return false;
  }
};

const envelope = (
  inputBinding: TraceCursorBinding,
  providerToken: JsonValue,
) => {
  const bound = validateTraceCursorBinding(inputBinding);
  return cloneJsonObject({
    version: 1,
    connectionId: bound.connectionId,
    destinationType: bound.destinationType,
    configurationIdentity: bound.configurationIdentity,
    queryFingerprint: bound.queryFingerprint,
    upperTimeBound: bound.upperTimeBound,
    providerToken,
  });
};

export const createTraceSearchCursor = (
  inputBinding: TraceCursorBinding,
  providerToken: JsonValue,
): TraceSearchCursor => {
  try {
    const material = envelope(inputBinding, providerToken);
    const payload = Buffer.from(JSON.stringify(material), "utf8").toString(
      "base64url",
    );
    const cursor = `${CURSOR_PREFIX}.${payload}.${digest(payload)}`;
    if (cursor.length > MAXIMUM_CURSOR_CHARACTERS) return invalid();
    return cursor as TraceSearchCursor;
  } catch {
    return invalid();
  }
};

export const readTraceSearchCursor = (
  input: unknown,
  expectedBinding: TraceCursorBinding,
): JsonValue => {
  try {
    if (
      typeof input !== "string" ||
      input.length === 0 ||
      input.length > MAXIMUM_CURSOR_CHARACTERS
    )
      return invalid();
    const parts = input.split(".");
    if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) return invalid();
    const payload = parts[1]!;
    if (!equalDigest(parts[2]!, digest(payload))) return invalid();
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    const cloned = cloneJsonObject(parsed);
    if (
      Buffer.from(JSON.stringify(cloned), "utf8").toString("base64url") !==
      payload
    )
      return invalid();
    const descriptors = objectGetOwnPropertyDescriptors(cloned);
    if (
      Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
      objectKeys(descriptors).sort().join(",") !==
        "configurationIdentity,connectionId,destinationType,providerToken,queryFingerprint,upperTimeBound,version" ||
      valueOf(descriptors, "version") !== 1
    )
      return invalid();
    const expected = validateTraceCursorBinding(expectedBinding);
    if (
      valueOf(descriptors, "connectionId") !== expected.connectionId ||
      valueOf(descriptors, "destinationType") !== expected.destinationType ||
      valueOf(descriptors, "configurationIdentity") !==
        expected.configurationIdentity ||
      valueOf(descriptors, "queryFingerprint") !== expected.queryFingerprint ||
      valueOf(descriptors, "upperTimeBound") !== expected.upperTimeBound
    )
      return invalid();
    return valueOf(descriptors, "providerToken") as JsonValue;
  } catch {
    return invalid();
  }
};
