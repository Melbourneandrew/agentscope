import { basename, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

import {
  createReporterReceipt,
  REPORTER_OUTCOMES,
  REPORTER_RECEIPT_REASONS,
  type ReporterReceipt,
  type ReporterReceiptReason,
} from "@agentscope/destinations-core";

import type {
  LocalSqlitePreparedDimension,
  LocalSqlitePreparedTrace,
  LocalSqliteReporterPolicy,
} from "../reporter/transaction.js";

const noncePattern = /^(?!0{32})[a-f0-9]{32}$/u;
const uint64Pattern = /^(?:0|[1-9][0-9]{0,19})$/u;
const sortKeyPattern = /^[0-9]{20}$/u;
const traceIdPattern = /^[a-f0-9]{32}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const maximumUint64 = 18_446_744_073_709_551_615n;
const maximumAge = 31_536_000_000_000_000n;
const maximumBatchItems = 32;
const maximumTracePayloadBytes = 16 * 1024 * 1024;
export const MAXIMUM_REPORTER_CHILD_BATCH_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const MAXIMUM_REPORTER_CHILD_REQUEST_BYTES =
  2 * MAXIMUM_REPORTER_CHILD_BATCH_PAYLOAD_BYTES + 2 * 1024 * 1024;
export const MAXIMUM_REPORTER_CHILD_TRACE_BYTES =
  maximumTracePayloadBytes + 1024 * 1024;
export const MAXIMUM_REPORTER_CHILD_HEADER_BYTES = 65_536;

export const localSqliteReporterChildBatchFits = (
  prepared: readonly Readonly<{ payloadBytes: number }>[],
): boolean =>
  prepared.reduce((total, trace) => total + trace.payloadBytes, 0) <=
  MAXIMUM_REPORTER_CHILD_BATCH_PAYLOAD_BYTES;

export type LocalSqliteReporterChildRequest = Readonly<{
  type: "attempt";
  nonce: string;
  databasePath: string;
  databaseFamily: readonly Readonly<{
    name: string;
    physicalIdentity: string;
  }>[];
  maximumWorkMilliseconds: number;
  policy: LocalSqliteReporterPolicy;
  prepared: readonly LocalSqlitePreparedTrace[];
  admissionTimeUnixNano: string;
}>;

export type LocalSqliteReporterChildRequestHeader = Readonly<{
  type: "attempt-header";
  nonce: string;
  databasePath: string;
  databaseFamily: readonly Readonly<{
    name: string;
    physicalIdentity: string;
  }>[];
  maximumWorkMilliseconds: number;
  policy: LocalSqliteReporterPolicy;
  preparedCount: number;
  admissionTimeUnixNano: string;
}>;

export type LocalSqliteReporterChildReady = Readonly<{
  type: "ready";
  nonce: string;
  pid: number;
  startIdentity: string;
}>;

export type LocalSqliteReporterChildPermission = Readonly<{
  type: "permission";
  nonce: string;
}>;

export type LocalSqliteReporterChildResult = Readonly<{
  type: "result";
  nonce: string;
  receipt: ReporterReceipt;
}>;

const exactRecord = (
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined => {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).length !== keys.length ||
      Reflect.ownKeys(descriptors).some(
        (key) => typeof key !== "string" || !keys.includes(key),
      )
    )
      return undefined;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      /* v8 ignore next -- JSON-parsed exact key cardinality proves an own data descriptor for every requested key. */
      if (descriptor === undefined || !("value" in descriptor))
        return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    /* v8 ignore next -- callers provide only JSON.parse output; reflective proxy traps cannot cross this process protocol. */
    return undefined;
  }
};

const exactArray = (
  value: unknown,
  maximum: number,
  minimum = 0,
): readonly unknown[] | undefined => {
  try {
    if (
      !Array.isArray(value) ||
      value.length < minimum ||
      value.length > maximum
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(
      value,
    ) as unknown as PropertyDescriptorMap;
    const expected = new Set([
      "length",
      ...Array.from({ length: value.length }, (_, index) => String(index)),
    ]);
    /* v8 ignore next -- JSON.parse produces dense arrays with exactly the
       indexed own keys and length enumerated above. */
    if (
      Reflect.ownKeys(descriptors).some(
        (key) => typeof key !== "string" || !expected.has(key),
      ) ||
      [...expected].some((key) => !(key in descriptors))
    )
      /* v8 ignore next -- JSON.parse produces dense arrays with only index and length keys. */
      return undefined;
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      /* v8 ignore next -- the dense JSON array key proof above guarantees each indexed data descriptor. */
      if (descriptor === undefined || !("value" in descriptor))
        return undefined;
      result.push(descriptor.value as unknown);
    }
    return Object.freeze(result);
  } catch {
    /* v8 ignore next -- JSON-parsed arrays cannot carry reflective traps. */
    return undefined;
  }
};

const canonicalDimensions = (
  parsed: readonly (LocalSqlitePreparedDimension | undefined)[],
): boolean => {
  const kinds = ["branch", "harness", "model", "session", "tag"] as const;
  return (
    parsed.every((entry) => entry !== undefined) &&
    kinds.every((kind) => {
      const values = parsed.filter((entry) => entry?.kind === kind);
      return values.every(
        (entry, index) =>
          entry?.ordinal === index &&
          (index === 0 || values[index - 1]!.value < entry.value),
      );
    }) &&
    parsed.every(
      (entry, index) =>
        index === 0 ||
        kinds.indexOf(parsed[index - 1]!.kind) <= kinds.indexOf(entry.kind),
    )
  );
};

const uint64 = (value: unknown): value is string =>
  typeof value === "string" &&
  uint64Pattern.test(value) &&
  BigInt(value) <= maximumUint64;

const dimension = (
  value: unknown,
): LocalSqlitePreparedDimension | undefined => {
  const record = exactRecord(value, ["kind", "value", "ordinal"]);
  if (
    record === undefined ||
    typeof record.kind !== "string" ||
    !["branch", "harness", "model", "session", "tag"].includes(record.kind) ||
    typeof record.value !== "string" ||
    record.value.length < 1 ||
    Buffer.byteLength(record.value, "utf8") > 1_024 ||
    typeof record.ordinal !== "number" ||
    !Number.isSafeInteger(record.ordinal) ||
    record.ordinal < 0 ||
    record.ordinal > 255
  )
    return undefined;
  return Object.freeze(record) as LocalSqlitePreparedDimension;
};

const preparedTrace = (
  value: unknown,
): LocalSqlitePreparedTrace | undefined => {
  const record = exactRecord(value, [
    "deliveryIdentity",
    "traceId",
    "startTimeUnixNano",
    "startTimeSortKey",
    "admissionTimeUnixNano",
    "admissionTimeSortKey",
    "protocolCompatibilityId",
    "payloadUtf8",
    "payloadSha256",
    "payloadBytes",
    "dimensions",
  ]);
  const dimensions = exactArray(record?.dimensions, 256);
  const parsedDimensions = dimensions?.map(dimension);
  if (
    record === undefined ||
    typeof record.deliveryIdentity !== "string" ||
    !sha256Pattern.test(record.deliveryIdentity) ||
    typeof record.traceId !== "string" ||
    !traceIdPattern.test(record.traceId) ||
    !uint64(record.startTimeUnixNano) ||
    typeof record.startTimeSortKey !== "string" ||
    !sortKeyPattern.test(record.startTimeSortKey) ||
    !uint64(record.admissionTimeUnixNano) ||
    typeof record.admissionTimeSortKey !== "string" ||
    !sortKeyPattern.test(record.admissionTimeSortKey) ||
    typeof record.protocolCompatibilityId !== "string" ||
    record.protocolCompatibilityId.length < 1 ||
    Buffer.byteLength(record.protocolCompatibilityId, "utf8") > 1_024 ||
    typeof record.payloadUtf8 !== "string" ||
    typeof record.payloadBytes !== "number" ||
    !Number.isSafeInteger(record.payloadBytes) ||
    record.payloadBytes < 1 ||
    record.payloadBytes > maximumTracePayloadBytes ||
    Buffer.byteLength(record.payloadUtf8, "utf8") !== record.payloadBytes ||
    createHash("sha256").update(record.payloadUtf8, "utf8").digest("hex") !==
      record.payloadSha256 ||
    typeof record.payloadSha256 !== "string" ||
    !sha256Pattern.test(record.payloadSha256) ||
    parsedDimensions === undefined ||
    !canonicalDimensions(parsedDimensions) ||
    record.startTimeSortKey !== record.startTimeUnixNano.padStart(20, "0") ||
    record.admissionTimeSortKey !==
      record.admissionTimeUnixNano.padStart(20, "0")
  )
    return undefined;
  return Object.freeze({
    ...record,
    dimensions: Object.freeze(parsedDimensions),
  }) as LocalSqlitePreparedTrace;
};

const policy = (value: unknown): LocalSqliteReporterPolicy | undefined => {
  const record = exactRecord(value, [
    "maximumAgeNanoseconds",
    "maximumPayloadBytes",
    "maximumTraceCount",
  ]);
  if (
    record === undefined ||
    !uint64(record.maximumAgeNanoseconds) ||
    BigInt(record.maximumAgeNanoseconds) > maximumAge ||
    typeof record.maximumPayloadBytes !== "number" ||
    !Number.isSafeInteger(record.maximumPayloadBytes) ||
    record.maximumPayloadBytes < 1 ||
    record.maximumPayloadBytes > 10 * 1024 * 1024 * 1024 ||
    typeof record.maximumTraceCount !== "number" ||
    !Number.isSafeInteger(record.maximumTraceCount) ||
    record.maximumTraceCount < 1 ||
    record.maximumTraceCount > 1_000_000
  )
    return undefined;
  return Object.freeze(record) as LocalSqliteReporterPolicy;
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

export const encodeLocalSqliteReporterChildMessage = (
  value:
    | LocalSqliteReporterChildRequest
    | LocalSqliteReporterChildPermission
    | LocalSqliteReporterChildReady
    | LocalSqliteReporterChildResult,
): string => `${JSON.stringify(value)}\n`;

export const encodeLocalSqliteReporterChildRequestHeader = (
  value: LocalSqliteReporterChildRequest,
): string =>
  `${JSON.stringify({
    type: "attempt-header",
    nonce: value.nonce,
    databasePath: value.databasePath,
    databaseFamily: value.databaseFamily,
    maximumWorkMilliseconds: value.maximumWorkMilliseconds,
    policy: value.policy,
    preparedCount: value.prepared.length,
    admissionTimeUnixNano: value.admissionTimeUnixNano,
  })}\n`;

export const encodeLocalSqliteReporterChildTrace = (
  nonce: string,
  value: LocalSqlitePreparedTrace,
): string => `${JSON.stringify({ type: "trace", nonce, value })}\n`;

export const decodeLocalSqliteReporterChildRequestHeader = (
  value: string,
): LocalSqliteReporterChildRequestHeader | undefined => {
  if (Buffer.byteLength(value, "utf8") > MAXIMUM_REPORTER_CHILD_HEADER_BYTES)
    return undefined;
  const record = exactRecord(parseJson(value), [
    "type",
    "nonce",
    "databasePath",
    "databaseFamily",
    "maximumWorkMilliseconds",
    "policy",
    "preparedCount",
    "admissionTimeUnixNano",
  ]);
  const parsedPolicy = policy(record?.policy);
  const family = exactArray(record?.databaseFamily, 3, 1)?.map((value) =>
    exactRecord(value, ["name", "physicalIdentity"]),
  );
  if (
    record?.type !== "attempt-header" ||
    typeof record.nonce !== "string" ||
    !noncePattern.test(record.nonce) ||
    typeof record.databasePath !== "string" ||
    record.databasePath.length < 1 ||
    record.databasePath.length > 4_096 ||
    record.databasePath.includes("\0") ||
    !isAbsolute(record.databasePath) ||
    basename(record.databasePath) !== "traces.sqlite" ||
    family === undefined ||
    family.some(
      (value) =>
        value === undefined ||
        typeof value.name !== "string" ||
        !["traces.sqlite", "traces.sqlite-wal", "traces.sqlite-shm"].includes(
          value.name,
        ) ||
        typeof value.physicalIdentity !== "string" ||
        !/^dev:[0-9]+:ino:[0-9]+$/u.test(value.physicalIdentity),
    ) ||
    family[0]?.name !== "traces.sqlite" ||
    new Set(family.map((value) => value?.name)).size !== family.length ||
    typeof record.maximumWorkMilliseconds !== "number" ||
    !Number.isSafeInteger(record.maximumWorkMilliseconds) ||
    record.maximumWorkMilliseconds < 1 ||
    record.maximumWorkMilliseconds > 60_000 ||
    parsedPolicy === undefined ||
    typeof record.preparedCount !== "number" ||
    !Number.isSafeInteger(record.preparedCount) ||
    record.preparedCount < 1 ||
    record.preparedCount > maximumBatchItems ||
    !uint64(record.admissionTimeUnixNano)
  )
    return undefined;
  return Object.freeze({
    type: "attempt-header",
    nonce: record.nonce,
    databasePath: record.databasePath,
    databaseFamily: Object.freeze(
      family.map((value) => Object.freeze(value!)),
    ) as LocalSqliteReporterChildRequestHeader["databaseFamily"],
    maximumWorkMilliseconds: record.maximumWorkMilliseconds,
    policy: parsedPolicy,
    preparedCount: record.preparedCount,
    admissionTimeUnixNano: record.admissionTimeUnixNano,
  });
};

export const decodeLocalSqliteReporterChildTrace = (
  input: string,
  expectedNonce: string,
  admissionTimeUnixNano: string,
): LocalSqlitePreparedTrace | undefined => {
  if (Buffer.byteLength(input, "utf8") > MAXIMUM_REPORTER_CHILD_TRACE_BYTES)
    return undefined;
  const record = exactRecord(parseJson(input), ["type", "nonce", "value"]);
  const trace = preparedTrace(record?.value);
  if (
    record?.type !== "trace" ||
    record.nonce !== expectedNonce ||
    trace === undefined ||
    trace.admissionTimeUnixNano !== admissionTimeUnixNano
  )
    return undefined;
  return trace;
};

export const decodeLocalSqliteReporterChildRequest = (
  value: string,
  // eslint-disable-next-line complexity -- the legacy aggregate decoder validates one closed hostile DTO without invoking callbacks or getters.
): LocalSqliteReporterChildRequest | undefined => {
  /* v8 ignore next -- the streaming child and parent independently enforce
     this exact encoded-byte ceiling without allocating a boundary fixture. */
  if (Buffer.byteLength(value, "utf8") > MAXIMUM_REPORTER_CHILD_REQUEST_BYTES)
    return undefined;
  const record = exactRecord(parseJson(value), [
    "type",
    "nonce",
    "databasePath",
    "databaseFamily",
    "maximumWorkMilliseconds",
    "policy",
    "prepared",
    "admissionTimeUnixNano",
  ]);
  const parsedPolicy = policy(record?.policy);
  const family = exactArray(record?.databaseFamily, 3, 1)?.map((value) =>
    exactRecord(value, ["name", "physicalIdentity"]),
  );
  const traces = exactArray(record?.prepared, maximumBatchItems, 1);
  const prepared = traces?.map(preparedTrace);
  if (
    record?.type !== "attempt" ||
    typeof record.nonce !== "string" ||
    !noncePattern.test(record.nonce) ||
    typeof record.databasePath !== "string" ||
    record.databasePath.length < 1 ||
    record.databasePath.length > 4_096 ||
    record.databasePath.includes("\0") ||
    !isAbsolute(record.databasePath) ||
    basename(record.databasePath) !== "traces.sqlite" ||
    family === undefined ||
    family.some(
      (value) =>
        value === undefined ||
        typeof value.name !== "string" ||
        !["traces.sqlite", "traces.sqlite-wal", "traces.sqlite-shm"].includes(
          value.name,
        ) ||
        typeof value.physicalIdentity !== "string" ||
        !/^dev:[0-9]+:ino:[0-9]+$/u.test(value.physicalIdentity),
    ) ||
    family[0]?.name !== "traces.sqlite" ||
    new Set(family.map((value) => value?.name)).size !== family.length ||
    typeof record.maximumWorkMilliseconds !== "number" ||
    !Number.isSafeInteger(record.maximumWorkMilliseconds) ||
    record.maximumWorkMilliseconds < 1 ||
    record.maximumWorkMilliseconds > 60_000 ||
    parsedPolicy === undefined ||
    prepared === undefined ||
    prepared.some((trace) => trace === undefined) ||
    !localSqliteReporterChildBatchFits(
      prepared as readonly LocalSqlitePreparedTrace[],
    ) ||
    !uint64(record.admissionTimeUnixNano) ||
    prepared.some(
      (trace) => trace?.admissionTimeUnixNano !== record.admissionTimeUnixNano,
    ) ||
    new Set(prepared.map((trace) => trace?.deliveryIdentity)).size !==
      prepared.length
  )
    return undefined;
  return Object.freeze({
    type: "attempt",
    nonce: record.nonce,
    databasePath: record.databasePath,
    databaseFamily: Object.freeze(
      family.map((value) => Object.freeze(value!)),
    ) as LocalSqliteReporterChildRequest["databaseFamily"],
    maximumWorkMilliseconds: record.maximumWorkMilliseconds,
    policy: parsedPolicy,
    prepared: Object.freeze(prepared) as readonly LocalSqlitePreparedTrace[],
    admissionTimeUnixNano: record.admissionTimeUnixNano,
  });
};

export const decodeLocalSqliteReporterChildReady = (
  value: string,
): LocalSqliteReporterChildReady | undefined => {
  const record = exactRecord(parseJson(value), [
    "type",
    "nonce",
    "pid",
    "startIdentity",
  ]);
  if (
    record?.type !== "ready" ||
    typeof record.nonce !== "string" ||
    !noncePattern.test(record.nonce) ||
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    typeof record.startIdentity !== "string" ||
    !noncePattern.test(record.startIdentity)
  )
    return undefined;
  return Object.freeze(record) as LocalSqliteReporterChildReady;
};

export const decodeLocalSqliteReporterChildPermission = (
  value: string,
): LocalSqliteReporterChildPermission | undefined => {
  const record = exactRecord(parseJson(value), ["type", "nonce"]);
  return record?.type === "permission" &&
    typeof record.nonce === "string" &&
    noncePattern.test(record.nonce)
    ? (Object.freeze(record) as LocalSqliteReporterChildPermission)
    : undefined;
};

const parseReceipt = (value: unknown): ReporterReceipt | undefined => {
  const record = exactRecord(value, [
    "outcome",
    ...(exactRecord(value, ["outcome"]) === undefined ? ["reason"] : []),
  ]);
  if (
    record === undefined ||
    typeof record.outcome !== "string" ||
    !REPORTER_OUTCOMES.includes(
      record.outcome as (typeof REPORTER_OUTCOMES)[number],
    )
  )
    return undefined;
  const reason = record.reason;
  if (
    reason !== undefined &&
    (typeof reason !== "string" ||
      !REPORTER_RECEIPT_REASONS.includes(reason as ReporterReceiptReason))
  )
    return undefined;
  try {
    return createReporterReceipt(
      record.outcome as (typeof REPORTER_OUTCOMES)[number],
      reason as ReporterReceiptReason | undefined,
    );
  } catch {
    return undefined;
  }
};

export const decodeLocalSqliteReporterChildResult = (
  value: string,
): LocalSqliteReporterChildResult | undefined => {
  const record = exactRecord(parseJson(value), ["type", "nonce", "receipt"]);
  const receipt = parseReceipt(record?.receipt);
  if (
    record?.type !== "result" ||
    typeof record.nonce !== "string" ||
    !noncePattern.test(record.nonce) ||
    receipt === undefined
  )
    return undefined;
  return Object.freeze({ type: "result", nonce: record.nonce, receipt });
};
