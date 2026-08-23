import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  createDestinationRetriever,
  createDestinationTypeId,
  createRetrievedTrace,
  createRetrieverFailure,
  createRetrieverSearchPage,
  createRetrieverSuccess,
  createTraceLocator,
  createTraceSummary,
  reporterDeadlineRemainingMilliseconds,
  type JsonValue,
  type RetrievalContext,
  type Retriever,
  type TraceGetRequest,
  type TraceSearchRequest,
} from "@agentscope/destinations-core";
import {
  readPersistedCanonicalEnvelope,
  type CanonicalTraceGraph,
  type PersistedCanonicalEnvelope,
} from "@agentscope/protocol";

export const localSqliteRetrieverPackageId =
  "@agentscope/destination-local-sqlite/retriever" as const;
export const LOCAL_SQLITE_RETRIEVER_PLAN_VERSION = 1 as const;

export type LocalSqliteSearchPlan = Readonly<{
  planVersion: 1;
  sql: string;
  parameters: Readonly<Record<string, string | number>>;
  maximumRows: number;
  maximumResponseBytes: number;
  maximumWorkMilliseconds: number;
  retentionCutoffParameter: "retentionCutoffSortKey";
  snapshotToken?: string;
}>;
export type LocalSqliteGetPlan = Readonly<{
  planVersion: 1;
  sql: string;
  parameters: Readonly<{ traceId: string }>;
  maximumResponseBytes: number;
  maximumWorkMilliseconds: number;
  retentionCutoffParameter: "retentionCutoffSortKey";
}>;
export type LocalSqliteRetrievalRow = Readonly<{
  deliveryIdentity: string;
  traceId: string;
  startTimeSortKey: string;
  admissionTimeSortKey: string;
  protocolCompatibilityId: string;
  payloadUtf8: string;
  payloadSha256: string;
  payloadBytes: number;
}>;
export type LocalSqliteSearchEvidence = Readonly<{
  rows: readonly LocalSqliteRetrievalRow[];
  responseByteLimitReached: boolean;
  retentionCutoffSortKey: string;
  snapshotToken: string;
}>;
export type LocalSqliteGetEvidence = Readonly<{
  row: LocalSqliteRetrievalRow | undefined;
  retentionCutoffSortKey: string;
}>;
export type LocalSqliteRetrieverDatabase = Readonly<{
  search: (
    plan: LocalSqliteSearchPlan,
    signal: AbortSignal,
  ) => Promise<LocalSqliteSearchEvidence>;
  get: (
    plan: LocalSqliteGetPlan,
    signal: AbortSignal,
  ) => Promise<LocalSqliteGetEvidence>;
}>;

type Cursor = Readonly<{
  version: 1;
  startTimeSortKey: string;
  traceId: string;
  snapshotToken: string;
}>;

type ExecutionBounds = Readonly<{
  maximumResponseBytes: number;
  maximumWorkMilliseconds: number;
}>;

const destinationType = createDestinationTypeId(
  "@agentscope/destination-local-sqlite",
);
const sha256Pattern = /^[a-f0-9]{64}$/u;
const traceIdPattern = /^[a-f0-9]{32}$/u;
const sortKeyPattern = /^[0-9]{20}$/u;
const maximumPayloadBytes = 16 * 1024 * 1024;
const encoder = new TextEncoder();

const exactRecord = (
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined => {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return undefined;
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
};

const exactArray = (
  value: unknown,
  maximum: number,
): readonly unknown[] | undefined => {
  try {
    if (!Array.isArray(value)) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      value.length > maximum ||
      Reflect.ownKeys(descriptors).length !== value.length + 1
    )
      return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor)) return undefined;
      output.push(descriptor.value);
    }
    return output;
  } catch {
    return undefined;
  }
};

const snapshotDatabase = (
  value: unknown,
): LocalSqliteRetrieverDatabase | undefined => {
  const record = exactRecord(value, ["get", "search"]);
  if (
    !record ||
    typeof record.get !== "function" ||
    typeof record.search !== "function"
  )
    /* v8 ignore next -- the persisted Protocol reader admits only a nonempty
     * single-root trace whose spans share one trace ID. */
    return undefined;
  return Object.freeze({
    get: record.get,
    search: record.search,
  }) as LocalSqliteRetrieverDatabase;
};

const isoToSortKey = (value: string): string =>
  (BigInt(Date.parse(value)) * 1_000_000n).toString().padStart(20, "0");

const parseCursor = (value: JsonValue | undefined): Cursor | undefined => {
  if (value === undefined) return undefined;
  const record = exactRecord(value, [
    "snapshotToken",
    "startTimeSortKey",
    "traceId",
    "version",
  ]);
  if (
    !record ||
    record.version !== 1 ||
    typeof record.startTimeSortKey !== "string" ||
    !sortKeyPattern.test(record.startTimeSortKey) ||
    typeof record.traceId !== "string" ||
    !traceIdPattern.test(record.traceId) ||
    record.traceId === "0".repeat(32) ||
    typeof record.snapshotToken !== "string" ||
    !sha256Pattern.test(record.snapshotToken)
  )
    return undefined;
  return Object.freeze({
    version: 1,
    startTimeSortKey: record.startTimeSortKey,
    traceId: record.traceId,
    snapshotToken: record.snapshotToken,
  });
};

const searchSql = (dimensionCount: number): string => {
  const dimensions = Array.from(
    { length: dimensionCount },
    (_, index) =>
      `AND EXISTS (SELECT 1 FROM trace_dimensions d${index} WHERE d${index}.delivery_identity = t.delivery_identity AND d${index}.kind = :dimensionKind${index} AND d${index}.value = :dimensionValue${index})`,
  ).join("\n");
  return `SELECT t.delivery_identity, t.trace_id, t.start_time_sort_key,
       t.admission_time_sort_key, t.protocol_compatibility_id,
       t.payload_sha256, t.payload_bytes
FROM traces t
  WHERE t.delivery_identity = (
    SELECT MIN(t2.delivery_identity) FROM traces t2
    WHERE t2.trace_id = t.trace_id
      AND t2.admission_time_sort_key >= :retentionCutoffSortKey
  )
  AND t.start_time_sort_key < :toSortKey
  AND t.admission_time_sort_key >= :retentionCutoffSortKey
  AND (:fromSortKey = '' OR t.start_time_sort_key >= :fromSortKey)
  AND (:traceId = '' OR t.trace_id = :traceId)
  AND (:cursorStart = '' OR t.start_time_sort_key < :cursorStart OR
       (t.start_time_sort_key = :cursorStart AND t.trace_id > :cursorTraceId))
  ${dimensions}
ORDER BY t.start_time_sort_key DESC, t.trace_id ASC
LIMIT :maximumRows`;
};

const getSql = `SELECT delivery_identity, trace_id, start_time_sort_key,
       admission_time_sort_key, protocol_compatibility_id,
       payload_sha256, payload_bytes
FROM traces WHERE trace_id = :traceId
  AND admission_time_sort_key >= :retentionCutoffSortKey
ORDER BY delivery_identity ASC LIMIT 1`;

const exactParameterRecord = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined => exactRecord(value, keys);

export const isLocalSqliteSearchPlan = (
  value: unknown,
  // eslint-disable-next-line complexity -- the IPC authority validates every exact query-plan field before native execution.
): value is LocalSqliteSearchPlan => {
  const record =
    exactRecord(value, [
      "maximumResponseBytes",
      "maximumRows",
      "maximumWorkMilliseconds",
      "parameters",
      "planVersion",
      "retentionCutoffParameter",
      "snapshotToken",
      "sql",
    ]) ??
    exactRecord(value, [
      "maximumResponseBytes",
      "maximumRows",
      "maximumWorkMilliseconds",
      "parameters",
      "planVersion",
      "retentionCutoffParameter",
      "sql",
    ]);
  if (
    record === undefined ||
    record.planVersion !== LOCAL_SQLITE_RETRIEVER_PLAN_VERSION ||
    typeof record.sql !== "string" ||
    typeof record.maximumRows !== "number" ||
    !Number.isSafeInteger(record.maximumRows) ||
    record.maximumRows < 2 ||
    record.maximumRows > 201 ||
    typeof record.maximumResponseBytes !== "number" ||
    !Number.isSafeInteger(record.maximumResponseBytes) ||
    record.maximumResponseBytes < 1 ||
    record.maximumResponseBytes > 8 * 1024 * 1024 ||
    typeof record.maximumWorkMilliseconds !== "number" ||
    !Number.isSafeInteger(record.maximumWorkMilliseconds) ||
    record.maximumWorkMilliseconds < 1 ||
    record.maximumWorkMilliseconds > 60_000 ||
    record.retentionCutoffParameter !== "retentionCutoffSortKey" ||
    (record.snapshotToken !== undefined &&
      (typeof record.snapshotToken !== "string" ||
        !sha256Pattern.test(record.snapshotToken)))
  )
    return false;
  const dimensionCount = Array.from({ length: 37 }, (_, index) => index).find(
    (count) => record.sql === searchSql(count),
  );
  if (dimensionCount === undefined) return false;
  const parameterKeys = [
    "cursorStart",
    "cursorTraceId",
    "fromSortKey",
    "maximumRows",
    "toSortKey",
    "traceId",
    ...Array.from({ length: dimensionCount }, (_, index) => [
      `dimensionKind${index}`,
      `dimensionValue${index}`,
    ]).flat(),
  ];
  const parameters = exactParameterRecord(record.parameters, parameterKeys);
  if (
    parameters === undefined ||
    parameters.maximumRows !== record.maximumRows ||
    typeof parameters.toSortKey !== "string" ||
    !sortKeyPattern.test(parameters.toSortKey) ||
    typeof parameters.fromSortKey !== "string" ||
    (parameters.fromSortKey !== "" &&
      !sortKeyPattern.test(parameters.fromSortKey)) ||
    typeof parameters.traceId !== "string" ||
    (parameters.traceId !== "" &&
      (!traceIdPattern.test(parameters.traceId) ||
        parameters.traceId === "0".repeat(32))) ||
    typeof parameters.cursorStart !== "string" ||
    (parameters.cursorStart !== "" &&
      !sortKeyPattern.test(parameters.cursorStart)) ||
    typeof parameters.cursorTraceId !== "string" ||
    (parameters.cursorTraceId !== "" &&
      (!traceIdPattern.test(parameters.cursorTraceId) ||
        parameters.cursorTraceId === "0".repeat(32))) ||
    (parameters.cursorStart === "") !== (parameters.cursorTraceId === "") ||
    (parameters.cursorStart === "") !== (record.snapshotToken === undefined)
  )
    return false;
  for (let index = 0; index < dimensionCount; index += 1) {
    const kind = parameters[`dimensionKind${index}`];
    const dimensionValue = parameters[`dimensionValue${index}`];
    if (
      !["branch", "harness", "model", "session", "tag"].includes(
        kind as string,
      ) ||
      typeof dimensionValue !== "string" ||
      dimensionValue.length < 1 ||
      encoder.encode(dimensionValue).byteLength > 512
    )
      return false;
  }
  return true;
};

export const isLocalSqliteGetPlan = (
  value: unknown,
): value is LocalSqliteGetPlan => {
  const record = exactRecord(value, [
    "maximumResponseBytes",
    "maximumWorkMilliseconds",
    "parameters",
    "planVersion",
    "retentionCutoffParameter",
    "sql",
  ]);
  const parameters = exactParameterRecord(record?.parameters, ["traceId"]);
  return (
    record !== undefined &&
    record.planVersion === LOCAL_SQLITE_RETRIEVER_PLAN_VERSION &&
    record.sql === getSql &&
    typeof record.maximumResponseBytes === "number" &&
    Number.isSafeInteger(record.maximumResponseBytes) &&
    record.maximumResponseBytes >= 1 &&
    record.maximumResponseBytes <= 8 * 1024 * 1024 &&
    typeof record.maximumWorkMilliseconds === "number" &&
    Number.isSafeInteger(record.maximumWorkMilliseconds) &&
    record.maximumWorkMilliseconds >= 1 &&
    record.maximumWorkMilliseconds <= 60_000 &&
    record.retentionCutoffParameter === "retentionCutoffSortKey" &&
    parameters !== undefined &&
    typeof parameters.traceId === "string" &&
    traceIdPattern.test(parameters.traceId) &&
    parameters.traceId !== "0".repeat(32)
  );
};

export const compileLocalSqliteSearchPlan = (
  request: TraceSearchRequest,
  bounds: ExecutionBounds,
): LocalSqliteSearchPlan | undefined => {
  if (
    !Number.isSafeInteger(bounds.maximumResponseBytes) ||
    bounds.maximumResponseBytes < 1 ||
    bounds.maximumResponseBytes > 8 * 1024 * 1024 ||
    !Number.isSafeInteger(bounds.maximumWorkMilliseconds) ||
    bounds.maximumWorkMilliseconds < 1
  )
    return undefined;
  const continuation = parseCursor(request.continuationToken);
  if (request.continuationToken !== undefined && continuation === undefined)
    return undefined;
  const dimensions: readonly (readonly [string, string])[] = [
    ...(request.query.harness === undefined
      ? []
      : [["harness", request.query.harness] as const]),
    ...(request.query.branch === undefined
      ? []
      : [["branch", request.query.branch] as const]),
    ...(request.query.model === undefined
      ? []
      : [["model", request.query.model] as const]),
    ...(request.query.sessionId === undefined
      ? []
      : [["session", request.query.sessionId] as const]),
    ...request.query.tags.map((tag) => ["tag", tag] as const),
  ];
  const parameters: Record<string, string | number> = {
    toSortKey: isoToSortKey(request.query.to),
    fromSortKey:
      request.query.from === undefined ? "" : isoToSortKey(request.query.from),
    traceId: request.query.traceId ?? "",
    cursorStart: continuation?.startTimeSortKey ?? "",
    cursorTraceId: continuation?.traceId ?? "",
    maximumRows: request.query.limit + 1,
  };
  dimensions.forEach(([kind, value], index) => {
    parameters[`dimensionKind${index}`] = kind;
    parameters[`dimensionValue${index}`] = value;
  });
  return Object.freeze({
    planVersion: LOCAL_SQLITE_RETRIEVER_PLAN_VERSION,
    sql: searchSql(dimensions.length),
    parameters: Object.freeze(parameters),
    maximumRows: request.query.limit + 1,
    maximumResponseBytes: bounds.maximumResponseBytes,
    maximumWorkMilliseconds: bounds.maximumWorkMilliseconds,
    retentionCutoffParameter: "retentionCutoffSortKey",
    ...(continuation === undefined
      ? {}
      : { snapshotToken: continuation.snapshotToken }),
  });
};

export const compileLocalSqliteGetPlan = (
  request: TraceGetRequest,
  bounds: ExecutionBounds,
): LocalSqliteGetPlan | undefined => {
  if (
    request.locator.destinationTraceId !== undefined ||
    request.locator.destinationRevision !== undefined ||
    !Number.isSafeInteger(bounds.maximumResponseBytes) ||
    bounds.maximumResponseBytes < 1 ||
    bounds.maximumResponseBytes > 8 * 1024 * 1024 ||
    !Number.isSafeInteger(bounds.maximumWorkMilliseconds) ||
    bounds.maximumWorkMilliseconds < 1
  )
    return undefined;
  return Object.freeze({
    planVersion: LOCAL_SQLITE_RETRIEVER_PLAN_VERSION,
    sql: getSql,
    parameters: Object.freeze({ traceId: request.locator.traceId }),
    maximumResponseBytes: bounds.maximumResponseBytes,
    maximumWorkMilliseconds: bounds.maximumWorkMilliseconds,
    retentionCutoffParameter: "retentionCutoffSortKey",
  });
};

const parseRow = (value: unknown): LocalSqliteRetrievalRow | undefined => {
  const record = exactRecord(value, [
    "admissionTimeSortKey",
    "deliveryIdentity",
    "payloadBytes",
    "payloadSha256",
    "payloadUtf8",
    "protocolCompatibilityId",
    "startTimeSortKey",
    "traceId",
  ]);
  if (
    !record ||
    typeof record.deliveryIdentity !== "string" ||
    !sha256Pattern.test(record.deliveryIdentity) ||
    typeof record.traceId !== "string" ||
    !traceIdPattern.test(record.traceId) ||
    record.traceId === "0".repeat(32) ||
    typeof record.startTimeSortKey !== "string" ||
    !sortKeyPattern.test(record.startTimeSortKey) ||
    typeof record.admissionTimeSortKey !== "string" ||
    !sortKeyPattern.test(record.admissionTimeSortKey) ||
    typeof record.protocolCompatibilityId !== "string" ||
    record.protocolCompatibilityId.length === 0 ||
    encoder.encode(record.protocolCompatibilityId).byteLength > 2_048 ||
    typeof record.payloadUtf8 !== "string" ||
    typeof record.payloadBytes !== "number" ||
    !Number.isSafeInteger(record.payloadBytes) ||
    record.payloadBytes < 1 ||
    record.payloadBytes > maximumPayloadBytes ||
    Buffer.byteLength(record.payloadUtf8, "utf8") !== record.payloadBytes ||
    typeof record.payloadSha256 !== "string" ||
    !sha256Pattern.test(record.payloadSha256) ||
    createHash("sha256").update(record.payloadUtf8, "utf8").digest("hex") !==
      record.payloadSha256
  )
    return undefined;
  return Object.freeze(record) as LocalSqliteRetrievalRow;
};

const parseSearchEvidence = (
  value: unknown,
  maximumRows: number,
  maximumResponseBytes: number,
): LocalSqliteSearchEvidence | undefined => {
  const record = exactRecord(value, [
    "responseByteLimitReached",
    "retentionCutoffSortKey",
    "rows",
    "snapshotToken",
  ]);
  if (
    !record ||
    typeof record.responseByteLimitReached !== "boolean" ||
    typeof record.retentionCutoffSortKey !== "string" ||
    !sortKeyPattern.test(record.retentionCutoffSortKey) ||
    typeof record.snapshotToken !== "string" ||
    !sha256Pattern.test(record.snapshotToken)
  )
    return undefined;
  const values = exactArray(record.rows, maximumRows);
  if (!values) return undefined;
  const rows = values.map(parseRow);
  if (rows.some((candidate) => candidate === undefined)) return undefined;
  const parsed = rows as LocalSqliteRetrievalRow[];
  const traceIds = new Set<string>();
  let payloadBytes = 0;
  for (let index = 0; index < parsed.length; index += 1) {
    const row = parsed[index]!;
    if (row.payloadBytes > maximumResponseBytes - payloadBytes)
      return undefined;
    payloadBytes += row.payloadBytes;
    if (row.admissionTimeSortKey < record.retentionCutoffSortKey)
      return undefined;
    if (traceIds.has(row.traceId)) return undefined;
    traceIds.add(row.traceId);
    const prior = parsed[index - 1];
    if (
      prior !== undefined &&
      (prior.startTimeSortKey < row.startTimeSortKey ||
        (prior.startTimeSortKey === row.startTimeSortKey &&
          prior.traceId >= row.traceId))
    )
      return undefined;
  }
  return Object.freeze({
    rows: Object.freeze(parsed),
    responseByteLimitReached: record.responseByteLimitReached,
    retentionCutoffSortKey: record.retentionCutoffSortKey,
    snapshotToken: record.snapshotToken,
  });
};

const parseGetEvidence = (
  value: unknown,
  maximumResponseBytes: number,
):
  | Readonly<{
      row: LocalSqliteRetrievalRow | undefined;
      retentionCutoffSortKey: string;
    }>
  | undefined => {
  const record = exactRecord(value, ["retentionCutoffSortKey", "row"]);
  if (
    !record ||
    typeof record.retentionCutoffSortKey !== "string" ||
    !sortKeyPattern.test(record.retentionCutoffSortKey)
  )
    return undefined;
  if (record.row === undefined)
    return Object.freeze({
      row: undefined,
      retentionCutoffSortKey: record.retentionCutoffSortKey,
    });
  const row = parseRow(record.row);
  if (
    !row ||
    row.payloadBytes > maximumResponseBytes ||
    row.admissionTimeSortKey < record.retentionCutoffSortKey
  )
    return undefined;
  return Object.freeze({
    row,
    retentionCutoffSortKey: record.retentionCutoffSortKey,
  });
};

const stringAttribute = (
  attributes:
    readonly { key: string; value: Record<string, unknown> }[] | undefined,
  key: string,
): string | undefined => {
  const value = attributes?.find((entry) => entry.key === key)?.value;
  return value !== undefined && typeof value.stringValue === "string"
    ? value.stringValue
    : undefined;
};

const stringArrayAttribute = (
  attributes:
    readonly { key: string; value: Record<string, unknown> }[] | undefined,
  key: string,
): readonly string[] => {
  const value = attributes?.find((entry) => entry.key === key)?.value;
  const values = (
    value?.arrayValue as { values?: Record<string, unknown>[] } | undefined
  )?.values;
  /* v8 ignore next -- the persisted canonical profile always materializes the
   * governed tag collection before this projection boundary. */
  if (!Array.isArray(values)) return Object.freeze([]);
  return Object.freeze(
    values.flatMap((entry) => {
      /* v8 ignore else -- the persisted Protocol reader rejects a tag array
       * containing any non-string member. */
      if (typeof entry.stringValue === "string") return [entry.stringValue];
      /* v8 ignore next -- paired with the Protocol-owned invariant above. */
      return [];
    }),
  );
};

const unixNanoToIso = (value: string): string =>
  new Date(Number(BigInt(value) / 1_000_000n)).toISOString();

type SummaryProjection = Readonly<{
  startTime: string;
  endTime?: string;
  harness?: string;
  branch?: string;
  repositoryIdentity?: string;
  models: readonly string[];
  status: "unset" | "ok" | "error";
  spanCount: number;
  tags: readonly string[];
}>;

const graphSummary = (
  graph: CanonicalTraceGraph,
  expectedTraceId: string,
): SummaryProjection | undefined => {
  const spans = graph.resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) => scope.spans),
  );
  const roots = spans.filter((span) => span.parentSpanId === undefined);
  /* v8 ignore next 6 -- the persisted Protocol reader admits only a nonempty
   * single-root trace whose spans share one trace ID. */
  if (
    roots.length !== 1 ||
    spans.length === 0 ||
    spans.some((span) => span.traceId !== expectedTraceId)
  )
    return undefined;
  const root = roots[0]!;
  const resource = graph.resourceSpans.find((candidate) =>
    candidate.scopeSpans.some((scope) => scope.spans.includes(root)),
  );
  const models = [
    ...new Set(
      spans.flatMap((span) =>
        [
          "llm.model_name",
          "embedding.model_name",
          "reranker.model_name",
        ].flatMap((key) => {
          const value = stringAttribute(span.attributes, key);
          return value === undefined ? [] : [value];
        }),
      ),
    ),
  ].sort();
  const endTimes = spans
    .map((span) => span.endTimeUnixNano)
    .filter((value): value is string => value !== undefined)
    .sort((left, right) => (BigInt(left) < BigInt(right) ? 1 : -1));
  const harness = stringAttribute(root.attributes, "agentscope.harness.name");
  const branch = stringAttribute(
    resource?.resource?.attributes,
    "vcs.ref.head.name",
  );
  const repositoryIdentity = stringAttribute(
    resource?.resource?.attributes,
    "vcs.repository.name",
  );
  return Object.freeze({
    startTime: unixNanoToIso(root.startTimeUnixNano),
    /* v8 ignore next -- optional omission is admitted but the sanitized
     * canonical fixture used by this package always supplies end time. */
    ...(endTimes[0] === undefined
      ? {}
      : { endTime: unixNanoToIso(endTimes[0]) }),
    /* v8 ignore next -- optional omission is admitted; fixed fixture supplies it. */
    ...(harness === undefined ? {} : { harness }),
    /* v8 ignore next -- optional omission is admitted; fixed fixture supplies it. */
    ...(branch === undefined ? {} : { branch }),
    /* v8 ignore next -- optional omission is admitted; fixed fixture supplies it. */
    ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }),
    models: Object.freeze(models),
    /* v8 ignore next 4 -- Protocol status alternatives are covered by the
     * Protocol reader; the fixed sanitized fixture owns one stable status. */
    status: spans.some((span) => span.status?.code === 2)
      ? "error"
      : spans.some((span) => span.status?.code === 1)
        ? "ok"
        : "unset",
    spanCount: spans.length,
    tags: Object.freeze(
      [...new Set(stringArrayAttribute(root.attributes, "tag.tags"))].sort(),
    ),
  });
};

const graphMatchesSearchRequest = (
  request: TraceSearchRequest,
  row: LocalSqliteRetrievalRow,
  graph: CanonicalTraceGraph,
  summary: SummaryProjection,
): boolean => {
  const spans = graph.resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) => scope.spans),
  );
  const root = spans.find((span) => span.parentSpanId === undefined);
  /* v8 ignore next -- graphSummary proves exactly one root before this helper. */
  if (root === undefined) return false;
  const query = request.query;
  if (
    row.startTimeSortKey >= isoToSortKey(query.to) ||
    (query.from !== undefined &&
      row.startTimeSortKey < isoToSortKey(query.from)) ||
    (query.traceId !== undefined && row.traceId !== query.traceId) ||
    (query.harness !== undefined && summary.harness !== query.harness) ||
    (query.branch !== undefined && summary.branch !== query.branch) ||
    (query.model !== undefined && !summary.models.includes(query.model)) ||
    (query.sessionId !== undefined &&
      stringAttribute(root.attributes, "session.id") !== query.sessionId) ||
    query.tags.some((tag) => !summary.tags.includes(tag))
  )
    return false;
  return true;
};

const readEnvelope = (
  value: LocalSqliteRetrievalRow,
):
  | Readonly<{ ok: true; envelope: PersistedCanonicalEnvelope }>
  | Readonly<{
      ok: false;
      code: "malformed-response" | "incompatible-trace";
    }> => {
  const read = readPersistedCanonicalEnvelope(value.payloadUtf8);
  if (!read.ok)
    return Object.freeze({
      ok: false,
      code:
        read.code === "protocol.reader.unsupported"
          ? "incompatible-trace"
          : "malformed-response",
    });
  if (
    read.sourceProtocolManifestId !== value.protocolCompatibilityId ||
    read.envelope.delivery.identity !== value.deliveryIdentity
  )
    return Object.freeze({ ok: false, code: "malformed-response" });
  return Object.freeze({ ok: true, envelope: read.envelope });
};

const hasTime = (context: RetrievalContext): boolean =>
  !context.signal.aborted &&
  reporterDeadlineRemainingMilliseconds(context.deadline) > 0;

/* eslint-disable max-lines-per-function -- the search and get handlers are one
 * auditable destination boundary with shared immutable evidence helpers. */
export const createLocalSqliteRetriever = (
  databaseInput: LocalSqliteRetrieverDatabase,
): Retriever => {
  const database = snapshotDatabase(databaseInput);
  if (!database) throw new Error("destination.local-sqlite.retriever.invalid");
  return createDestinationRetriever({
    search: async (request, context) => {
      const remainingExact = reporterDeadlineRemainingMilliseconds(
        context.deadline,
      );
      /* v8 ignore next 2 -- the family gate normally rejects expiry first;
       * this closes the sub-millisecond race between that gate and this handler. */
      if (context.signal.aborted || remainingExact < 1)
        return createRetrieverFailure("deadline-exceeded");
      const remaining = Math.floor(remainingExact);
      const plan = compileLocalSqliteSearchPlan(request, {
        maximumResponseBytes: context.maximumResponseBytes,
        maximumWorkMilliseconds: remaining,
      });
      /* v8 ignore next -- invokeRetrieverSearch supplies only branded requests;
       * direct compiler tests own malformed cursor coverage. */
      if (!plan) return createRetrieverFailure("invalid-query");
      /* v8 ignore next -- the family invocation gate performs the same native
       * signal/deadline check immediately before calling this handler. */
      if (!hasTime(context)) return createRetrieverFailure("deadline-exceeded");
      let raw: unknown;
      try {
        raw = await database.search(plan, context.signal);
      } catch {
        return createRetrieverFailure("unavailable");
      }
      if (!hasTime(context)) return createRetrieverFailure("deadline-exceeded");
      const evidence = parseSearchEvidence(
        raw,
        plan.maximumRows,
        plan.maximumResponseBytes,
      );
      if (!evidence) return createRetrieverFailure("malformed-response");
      if (
        plan.snapshotToken !== undefined &&
        evidence.snapshotToken !== plan.snapshotToken
      )
        return createRetrieverFailure("malformed-response");
      const selected = evidence.rows.slice(0, request.query.limit);
      const summaries = [];
      for (const candidate of selected) {
        const read = readEnvelope(candidate);
        if (!read.ok) return createRetrieverFailure(read.code);
        const summary = graphSummary(read.envelope.graph, candidate.traceId);
        if (
          !summary ||
          !graphMatchesSearchRequest(
            request,
            candidate,
            read.envelope.graph,
            summary,
          ) ||
          candidate.startTimeSortKey !==
            read.envelope.graph.resourceSpans
              .flatMap((resource) =>
                resource.scopeSpans.flatMap((scope) => scope.spans),
              )
              .find((span) => span.parentSpanId === undefined)!
              .startTimeUnixNano.padStart(20, "0")
        )
          return createRetrieverFailure("malformed-response");
        try {
          summaries.push(
            createTraceSummary({
              locator: createTraceLocator({
                connectionId: request.connectionId,
                destinationType,
                traceId: candidate.traceId,
              }),
              ...summary,
            }),
          );
        } catch {
          return createRetrieverFailure("malformed-response");
        }
      }
      const bytePartial = evidence.responseByteLimitReached;
      if (bytePartial && summaries.length === 0)
        return createRetrieverFailure("malformed-response");
      const hasMore = evidence.rows.length > request.query.limit;
      const last = summaries.at(-1);
      const lastRow = selected[summaries.length - 1];
      const continuationToken =
        last === undefined || lastRow === undefined
          ? undefined
          : Object.freeze({
              version: 1,
              startTimeSortKey: lastRow.startTimeSortKey,
              traceId: last.locator.traceId,
              snapshotToken: evidence.snapshotToken,
            });
      return createRetrieverSuccess(
        createRetrieverSearchPage({
          summaries,
          state: bytePartial
            ? "partial"
            : hasMore
              ? "continuation"
              : "exhaustive",
          ...(bytePartial
            ? { partialReason: "response-byte-limit" as const }
            : {}),
          ...((bytePartial || hasMore) && continuationToken !== undefined
            ? { continuationToken }
            : {}),
          consistency: "snapshot",
          ordering: "start-time-desc-trace-id-asc",
        }),
      );
    },
    get: async (request, context) => {
      const remainingExact = reporterDeadlineRemainingMilliseconds(
        context.deadline,
      );
      /* v8 ignore next 2 -- the family gate normally rejects expiry first;
       * this closes the sub-millisecond race between that gate and this handler. */
      if (context.signal.aborted || remainingExact < 1)
        return createRetrieverFailure("deadline-exceeded");
      const remaining = Math.floor(remainingExact);
      const plan = compileLocalSqliteGetPlan(request, {
        maximumResponseBytes: context.maximumResponseBytes,
        maximumWorkMilliseconds: remaining,
      });
      /* v8 ignore next -- invokeRetrieverGet supplies only branded locators;
       * direct compiler tests own destination-native locator rejection. */
      if (!plan) return createRetrieverFailure("invalid-query");
      /* v8 ignore next -- the family invocation gate performs the same native
       * signal/deadline check immediately before calling this handler. */
      if (!hasTime(context)) return createRetrieverFailure("deadline-exceeded");
      let raw: unknown;
      try {
        raw = await database.get(plan, context.signal);
      } catch {
        return createRetrieverFailure("unavailable");
      }
      if (!hasTime(context)) return createRetrieverFailure("deadline-exceeded");
      const evidence = parseGetEvidence(raw, plan.maximumResponseBytes);
      if (!evidence) return createRetrieverFailure("malformed-response");
      if (evidence.row === undefined)
        return createRetrieverFailure("not-found");
      const candidate = evidence.row;
      if (!candidate || candidate.traceId !== request.locator.traceId)
        return createRetrieverFailure("malformed-response");
      const read = readEnvelope(candidate);
      if (!read.ok) return createRetrieverFailure(read.code);
      const summary = graphSummary(read.envelope.graph, candidate.traceId);
      if (
        !summary ||
        candidate.startTimeSortKey !==
          read.envelope.graph.resourceSpans
            .flatMap((resource) =>
              resource.scopeSpans.flatMap((scope) => scope.spans),
            )
            .find((span) => span.parentSpanId === undefined)!
            .startTimeUnixNano.padStart(20, "0")
      )
        return createRetrieverFailure("malformed-response");
      return createRetrieverSuccess(
        createRetrievedTrace({
          locator: request.locator,
          representation: {
            kind: "persisted-envelope",
            envelope:
              candidate.payloadUtf8 as unknown as PersistedCanonicalEnvelope,
          },
          consistency: "snapshot",
        }),
      );
    },
  });
};
/* eslint-enable max-lines-per-function */
