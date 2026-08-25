import { basename, isAbsolute } from "node:path";

import type {
  LocalSqliteGetEvidence,
  LocalSqliteGetPlan,
  LocalSqliteSearchEvidence,
  LocalSqliteSearchPlan,
} from "../retriever/index.js";
import {
  isLocalSqliteGetPlan,
  isLocalSqliteSearchPlan,
} from "../retriever/index.js";
import type { LocalSqliteExecutionPolicy } from "./sqlite-port.js";

const noncePattern = /^(?!0{32})[a-f0-9]{32}$/u;
const physicalIdentityPattern = /^dev:[0-9]+:ino:[0-9]+$/u;
const maximumAgeNanoseconds = 31_536_000_000_000_000n;

export const MAXIMUM_RETRIEVER_CHILD_REQUEST_BYTES = 131_072;
export const MAXIMUM_RETRIEVER_CHILD_RESULT_BYTES =
  6 * 8 * 1024 * 1024 + 1024 * 1024;

export type LocalSqliteRetrieverChildRequest = Readonly<{
  type: "retrieve";
  nonce: string;
  databasePath: string;
  databaseFamily: readonly Readonly<{
    name: string;
    physicalIdentity: string;
  }>[];
  maximumWorkMilliseconds: number;
  policy: LocalSqliteExecutionPolicy;
  operation: "search" | "get";
  plan: LocalSqliteSearchPlan | LocalSqliteGetPlan;
}>;

export type LocalSqliteRetrieverChildResult = Readonly<{
  type: "retrieval-result";
  nonce: string;
  ok: boolean;
  evidence?: LocalSqliteSearchEvidence | LocalSqliteGetEvidence;
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
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      /* v8 ignore next -- only JSON.parse output reaches this helper, and the
         exact own-key cardinality above proves every requested data key. */
      if (descriptor === undefined || !("value" in descriptor))
        return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    /* v8 ignore next -- JSON.parse output cannot carry reflective proxy traps. */
    return undefined;
  }
};

const exactArray = (
  value: unknown,
  maximum: number,
  minimum: number,
): readonly unknown[] | undefined => {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  /* v8 ignore next -- JSON.parse produces dense arrays with exactly indexed
     data keys plus length. */
  if (Reflect.ownKeys(descriptors).length !== value.length + 1)
    return undefined;
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    /* v8 ignore start -- JSON.parse and the exact own-key count above make a
       missing or accessor-backed indexed descriptor unreachable. */
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    /* v8 ignore stop */
    output.push(descriptor.value);
  }
  return output;
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

const parseFamily = (
  value: unknown,
): LocalSqliteRetrieverChildRequest["databaseFamily"] | undefined => {
  const family = exactArray(value, 3, 1)?.map((entry) =>
    exactRecord(entry, ["name", "physicalIdentity"]),
  );
  if (
    family === undefined ||
    family.some(
      (entry) =>
        entry === undefined ||
        typeof entry.name !== "string" ||
        !["traces.sqlite", "traces.sqlite-wal", "traces.sqlite-shm"].includes(
          entry.name,
        ) ||
        typeof entry.physicalIdentity !== "string" ||
        !physicalIdentityPattern.test(entry.physicalIdentity),
    ) ||
    family[0]?.name !== "traces.sqlite" ||
    new Set(family.map((entry) => entry?.name)).size !== family.length
  )
    return undefined;
  return Object.freeze(
    family.map((entry) =>
      Object.freeze({
        name: entry!.name as string,
        physicalIdentity: entry!.physicalIdentity as string,
      }),
    ),
  );
};

const parsePolicy = (
  value: unknown,
): LocalSqliteExecutionPolicy | undefined => {
  const record = exactRecord(value, [
    "maximumAgeNanoseconds",
    "maximumPayloadBytes",
    "maximumTraceCount",
  ]);
  if (
    record === undefined ||
    typeof record.maximumAgeNanoseconds !== "string" ||
    !/^[1-9][0-9]{0,16}$/u.test(record.maximumAgeNanoseconds) ||
    BigInt(record.maximumAgeNanoseconds) > maximumAgeNanoseconds ||
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
  return Object.freeze(record) as LocalSqliteExecutionPolicy;
};

export const encodeLocalSqliteRetrieverChildRequest = (
  value: LocalSqliteRetrieverChildRequest,
): string => `${JSON.stringify(value)}\n`;

export const decodeLocalSqliteRetrieverChildRequest = (
  value: string,
): LocalSqliteRetrieverChildRequest | undefined => {
  if (Buffer.byteLength(value, "utf8") > MAXIMUM_RETRIEVER_CHILD_REQUEST_BYTES)
    return undefined;
  const record = exactRecord(parseJson(value), [
    "type",
    "nonce",
    "databasePath",
    "databaseFamily",
    "maximumWorkMilliseconds",
    "policy",
    "operation",
    "plan",
  ]);
  const family = parseFamily(record?.databaseFamily);
  const policy = parsePolicy(record?.policy);
  const validPlan =
    record?.operation === "search"
      ? isLocalSqliteSearchPlan(record.plan)
      : record?.operation === "get"
        ? isLocalSqliteGetPlan(record.plan)
        : false;
  if (
    record?.type !== "retrieve" ||
    typeof record.nonce !== "string" ||
    !noncePattern.test(record.nonce) ||
    typeof record.databasePath !== "string" ||
    record.databasePath.length < 1 ||
    record.databasePath.length > 4_096 ||
    record.databasePath.includes("\0") ||
    !isAbsolute(record.databasePath) ||
    basename(record.databasePath) !== "traces.sqlite" ||
    family === undefined ||
    typeof record.maximumWorkMilliseconds !== "number" ||
    !Number.isSafeInteger(record.maximumWorkMilliseconds) ||
    record.maximumWorkMilliseconds < 1 ||
    record.maximumWorkMilliseconds > 60_000 ||
    policy === undefined ||
    !validPlan ||
    (record.plan as LocalSqliteSearchPlan | LocalSqliteGetPlan)
      .maximumWorkMilliseconds !== record.maximumWorkMilliseconds
  )
    return undefined;
  return Object.freeze({
    type: "retrieve",
    nonce: record.nonce,
    databasePath: record.databasePath,
    databaseFamily: family,
    maximumWorkMilliseconds: record.maximumWorkMilliseconds,
    policy,
    operation: record.operation,
    plan: record.plan,
  }) as LocalSqliteRetrieverChildRequest;
};

export const encodeLocalSqliteRetrieverChildResult = (
  value: LocalSqliteRetrieverChildResult,
): string => `${JSON.stringify(value)}\n`;

export const decodeLocalSqliteRetrieverChildResult = (
  value: string,
): LocalSqliteRetrieverChildResult | undefined => {
  if (Buffer.byteLength(value, "utf8") > MAXIMUM_RETRIEVER_CHILD_RESULT_BYTES)
    return undefined;
  const parsed = parseJson(value);
  const success = exactRecord(parsed, ["type", "nonce", "ok", "evidence"]);
  const failure = success ?? exactRecord(parsed, ["type", "nonce", "ok"]);
  if (
    failure?.type !== "retrieval-result" ||
    typeof failure.nonce !== "string" ||
    !noncePattern.test(failure.nonce) ||
    typeof failure.ok !== "boolean" ||
    (failure.ok && success === undefined) ||
    (!failure.ok && success !== undefined)
  )
    return undefined;
  return Object.freeze(
    failure.ok
      ? {
          type: "retrieval-result",
          nonce: failure.nonce,
          ok: true,
          evidence: success!.evidence as
            LocalSqliteSearchEvidence | LocalSqliteGetEvidence,
        }
      : { type: "retrieval-result", nonce: failure.nonce, ok: false },
  );
};
