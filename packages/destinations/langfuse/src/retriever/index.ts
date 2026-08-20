import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  createDestinationRetriever,
  createCredentialSlotId,
  createDestinationTypeId,
  createRetrievedTrace,
  createRetrieverFailure,
  createRetrieverSearchPage,
  createRetrieverSuccess,
  createTraceLocator,
  createTraceSummary,
  executeBoundDestinationRequest,
  readReporterCredential,
  type JsonValue,
  type RetrieverFactoryContext,
  type RetrieverFailureCode,
  type Retriever,
  type RetrievalContext,
  type TraceGetRequest,
  type TraceSearchRequest,
} from "@agentscope/destinations-core";
import { readExternalOtlpJson } from "@agentscope/protocol";

import {
  deriveLangfuseProjectionFilterKey,
  LANGFUSE_COMPATIBILITY_MANIFEST,
  LANGFUSE_CAPSULE_CONTRACT,
  LANGFUSE_PROJECTION_CONTRACT,
  type LangfuseDestinationSettings,
} from "../compatibility.js";
import { deriveLangfuseCapsuleSpanId } from "../reporter/capsule.js";

type JsonObject = Record<string, unknown>;
type Observation = Readonly<{
  id: string;
  traceId: string;
  parentObservationId: string;
  type: "SPAN";
  isRootObservation?: false;
  name: string;
  startTime: string;
  endTime?: string;
  metadata: Readonly<Record<string, unknown>>;
}>;
type Profile = (typeof LANGFUSE_COMPATIBILITY_MANIFEST.profiles)[number];

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const projection = LANGFUSE_PROJECTION_CONTRACT;
const capsule = LANGFUSE_CAPSULE_CONTRACT;

const isJsonResponseContentType = (value: string | undefined): boolean => {
  if (value === undefined || value.length > 256) return false;
  const segments = value.split(";");
  if (segments.shift()?.trim().toLowerCase() !== "application/json")
    return false;
  if (segments.length === 0) return true;
  if (segments.length !== 1) return false;
  return /^charset\s*=\s*(?:utf-8|"utf-8")$/iu.test(segments[0]!.trim());
};

const profileFor = (id: LangfuseDestinationSettings["profileId"]): Profile => {
  const profile = LANGFUSE_COMPATIBILITY_MANIFEST.profiles.find(
    (candidate) => candidate.profileId === id,
  );
  /* v8 ignore next 2 -- the settings enum is generated from this exact immutable profile inventory. */
  if (profile === undefined)
    throw new Error("destination.langfuse.profile.unavailable");
  return profile;
};

const authorizationFor = (
  context: RetrieverFactoryContext<LangfuseDestinationSettings>,
): string => {
  const publicKey = readReporterCredential(
    context.credentials,
    createCredentialSlotId("public-key"),
  );
  const secretKey = readReporterCredential(
    context.credentials,
    createCredentialSlotId("secret-key"),
  );
  /* v8 ignore next 2 -- both exact descriptor slots are required before the family invokes this factory. */
  if (publicKey === undefined || secretKey === undefined)
    throw new Error("destination.langfuse.credentials.unavailable");
  const value = `Basic ${Buffer.from(`${publicKey}:${secretKey}`, "utf8").toString("base64")}`;
  /* v8 ignore next 2 -- credential-slot preflight is stricter than this independently retained wire-header ceiling. */
  if (value.length > 8_192)
    throw new Error("destination.langfuse.credentials.unavailable");
  return value;
};

const object = (value: unknown): JsonObject | undefined =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype
    ? (value as JsonObject)
    : undefined;

const text = (value: unknown, maximum = 2_048): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  encoder.encode(value).byteLength <= maximum &&
  !/\p{Cc}/u.test(value)
    ? value
    : undefined;

const metadataText = (value: Observation, key: string): string | undefined =>
  text(value.metadata[key], 512);

const isCapsuleNonce = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[\da-f]{32}$/u.test(value) &&
  value !== "0".repeat(32);

const parseJsonWithoutDuplicateKeys = (source: string): unknown => {
  let position = 0;
  const skipWhitespace = () => {
    while (/\s/u.test(source[position] ?? "")) position += 1;
  };
  const parseString = (): string => {
    const start = position;
    if (source[position] !== '"') throw new Error();
    position += 1;
    while (position < source.length) {
      const character = source[position++]!;
      if (character === '"')
        return JSON.parse(source.slice(start, position)) as string;
      if (character === "\\") {
        if (source[position] === "u") position += 5;
        else position += 1;
      } else if (character.charCodeAt(0) <= 0x1f) throw new Error();
    }
    throw new Error();
  };
  const parseValue = (depth: number): void => {
    if (depth > 64) throw new Error();
    skipWhitespace();
    const character = source[position];
    if (character === '"') {
      parseString();
      return;
    }
    if (character === "{") {
      position += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[position] === "}") {
        position += 1;
        return;
      }
      while (true) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) throw new Error();
        keys.add(key);
        skipWhitespace();
        if (source[position++] !== ":") throw new Error();
        parseValue(depth + 1);
        skipWhitespace();
        const delimiter = source[position++];
        if (delimiter === "}") return;
        if (delimiter !== ",") throw new Error();
      }
    }
    if (character === "[") {
      position += 1;
      skipWhitespace();
      if (source[position] === "]") {
        position += 1;
        return;
      }
      while (true) {
        parseValue(depth + 1);
        skipWhitespace();
        const delimiter = source[position++];
        if (delimiter === "]") return;
        if (delimiter !== ",") throw new Error();
      }
    }
    const token = source
      .slice(position)
      .match(
        /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u,
      )?.[0];
    if (token === undefined) throw new Error();
    position += token.length;
  };
  parseValue(0);
  skipWhitespace();
  if (position !== source.length) throw new Error();
  return JSON.parse(source) as unknown;
};

/* eslint-disable complexity -- the provider DTO parser retains one closed fail-closed ledger for root, rows, metadata, time fields, and continuation. */
const parseObservations = (
  body: Uint8Array,
  maximumRows: number,
):
  | Readonly<{ data: readonly Observation[]; continuation?: JsonValue }>
  | undefined => {
  try {
    const root = object(parseJsonWithoutDuplicateKeys(decoder.decode(body)));
    if (
      root === undefined ||
      !Array.isArray(root.data) ||
      root.data.length > maximumRows
    )
      return undefined;
    const data: Observation[] = [];
    for (const candidate of root.data) {
      const row = object(candidate);
      const metadata = object(row?.metadata);
      const id = text(row?.id, 64);
      const traceId = text(row?.traceId, 64);
      const parentObservationId = text(row?.parentObservationId, 64);
      const type = row?.type;
      const isRootObservation = row?.isRootObservation;
      const name = text(row?.name, 256);
      const startTime = text(row?.startTime, 64);
      const endTime = row?.endTime == null ? undefined : text(row.endTime, 64);
      if (
        row === undefined ||
        metadata === undefined ||
        Object.keys(metadata).length > 200 ||
        id === undefined ||
        traceId === undefined ||
        parentObservationId === undefined ||
        !/^[\da-f]{16}$/u.test(parentObservationId) ||
        parentObservationId === "0".repeat(16) ||
        type !== "SPAN" ||
        (isRootObservation !== undefined && isRootObservation !== false) ||
        name === undefined ||
        startTime === undefined ||
        (row.endTime != null && endTime === undefined)
      )
        return undefined;
      data.push(
        Object.freeze({
          id,
          traceId,
          parentObservationId,
          type,
          ...(isRootObservation === undefined ? {} : { isRootObservation }),
          name,
          startTime,
          ...(endTime === undefined ? {} : { endTime }),
          metadata: Object.freeze({ ...metadata }),
        }),
      );
    }
    const meta = object(root.meta);
    if (meta === undefined) return undefined;
    const cursor = meta?.cursor;
    if (
      cursor !== undefined &&
      cursor !== null &&
      (typeof cursor !== "string" ||
        cursor.length === 0 ||
        cursor.length > 8_192)
    )
      return undefined;
    return Object.freeze({
      data: Object.freeze(data),
      ...(typeof cursor === "string" ? { continuation: cursor } : {}),
    });
  } catch {
    return undefined;
  }
};
/* eslint-enable complexity */

const filter = (
  type: string,
  column: string,
  operator: string,
  value: unknown,
  key?: string,
) =>
  Object.freeze({
    type,
    column,
    ...(key === undefined ? {} : { key }),
    operator,
    value,
  });
const metadataFilter = (key: string, value: string) =>
  filter("stringObject", "metadata", "=", value, key);

const portableFilters = (
  request: TraceSearchRequest,
  v1: boolean,
): readonly Readonly<Record<string, unknown>>[] => {
  const query = request.query;
  const filters: Readonly<Record<string, unknown>>[] = [
    metadataFilter(capsule.keys.marker, capsule.marker),
  ];
  if (query.traceId)
    filters.push(filter("string", "traceId", "=", query.traceId));
  if (query.from)
    filters.push(filter("datetime", "startTime", ">=", query.from));
  filters.push(filter("datetime", "startTime", "<", query.to));
  if (query.harness)
    filters.push(metadataFilter(projection.harness, query.harness));
  if (query.branch)
    filters.push(metadataFilter(projection.branch, query.branch));
  if (query.model)
    filters.push(
      metadataFilter(
        deriveLangfuseProjectionFilterKey("model", query.model),
        query.model,
      ),
    );
  if (query.sessionId)
    filters.push(
      v1
        ? metadataFilter(projection.session, query.sessionId)
        : filter("string", "sessionId", "=", query.sessionId),
    );
  for (const tag of query.tags)
    filters.push(
      metadataFilter(deriveLangfuseProjectionFilterKey("tag", tag), tag),
    );
  return Object.freeze(filters);
};

const searchPath = (
  profile: Profile,
  request: TraceSearchRequest,
): string | undefined => {
  const v1 = profile.retriever.pagination === "page-offset";
  const query = new URLSearchParams();
  if (!v1 && "summaryFieldGroups" in profile.retriever)
    query.set("fields", profile.retriever.summaryFieldGroups.join(","));
  query.set(
    "limit",
    String(Math.min(request.query.limit, profile.retriever.maximumLimit)),
  );
  if (v1) query.set("useEventsTable", "true");
  if (request.continuationToken !== undefined) {
    if (v1) {
      if (
        typeof request.continuationToken !== "number" ||
        !Number.isSafeInteger(request.continuationToken) ||
        request.continuationToken < 2
      )
        return undefined;
      query.set("page", String(request.continuationToken));
    } else {
      if (
        typeof request.continuationToken !== "string" ||
        request.continuationToken.length === 0
      )
        return undefined;
      query.set("cursor", request.continuationToken);
    }
  } else if (v1) query.set("page", "1");
  query.set("filter", JSON.stringify(portableFilters(request, v1)));
  const value = `${profile.retriever.path}?${query.toString()}`;
  /* v8 ignore next 4 -- normalized portable values plus the bounded provider cursor algebraically fit this manifest-owned ceiling; the independent transport retains the same defensive bound. */
  return encoder.encode(value).byteLength <=
    LANGFUSE_COMPATIBILITY_MANIFEST.structuredFilter.maximumRequestTargetBytes
    ? value
    : undefined;
};

const failureCode = (status: number): RetrieverFailureCode | undefined => {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "unavailable";
  if (status >= 300) return "malformed-response";
  return undefined;
};

const retryAfterMilliseconds = (
  value: string | undefined,
): number | undefined => {
  if (value === undefined || !/^(?:0|[1-9]\d{0,3})$/u.test(value))
    return undefined;
  const seconds = Number(value);
  return seconds <= 3_600 ? seconds * 1_000 : undefined;
};

type Header = Readonly<{
  row: Observation;
  nonce: string;
  graphBytes: number;
  graphDigest: string;
  carrierCount: number;
  chunkCount: number;
  spanCount: number;
  status: "unset" | "ok" | "error";
  models: readonly string[];
  tags: readonly string[];
}>;

const projectionValue = (row: Observation, key: string): string | undefined => {
  const value = metadataText(row, key);
  if (
    value === undefined ||
    value.normalize("NFC") !== value ||
    [...value].length > projection.maximumValueCharacters
  )
    return undefined;
  return value;
};

const indexedValues = (
  row: Observation,
  countKey: string,
  prefix: string,
): readonly string[] | undefined => {
  const count = integer(metadataText(row, countKey), 32);
  if (count === undefined) return undefined;
  const output: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = projectionValue(
      row,
      `${prefix}${String(index).padStart(2, "0")}`,
    );
    if (value === undefined) return undefined;
    if (output.includes(value)) return undefined;
    output.push(value);
  }
  return Object.freeze(output);
};

const allowedHeaderMetadata = (
  row: Observation,
  models: readonly string[],
  tags: readonly string[],
): ReadonlySet<string> => {
  return new Set([
    capsule.keys.marker,
    capsule.keys.version,
    capsule.keys.nonce,
    capsule.keys.graphBytes,
    capsule.keys.graphDigest,
    capsule.keys.carrierCount,
    capsule.keys.chunkCount,
    projection.root,
    projection.session,
    projection.harness,
    projection.branch,
    projection.repository,
    projection.status,
    projection.spanCount,
    projection.modelCount,
    projection.tagCount,
    ...Array.from(
      { length: models.length },
      (_, index) =>
        `${projection.modelIndexPrefix}${String(index).padStart(2, "0")}`,
    ),
    ...Array.from(
      { length: tags.length },
      (_, index) =>
        `${projection.tagIndexPrefix}${String(index).padStart(2, "0")}`,
    ),
    ...models.map((value) => deriveLangfuseProjectionFilterKey("model", value)),
    ...tags.map((value) => deriveLangfuseProjectionFilterKey("tag", value)),
  ]);
};

const integer = (
  value: string | undefined,
  maximum: number,
): number | undefined => {
  if (value === undefined || !/^(?:0|[1-9]\d*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : undefined;
};

// eslint-disable-next-line complexity -- one parser validates the complete closed header grammar and all dependent formulas before selection.
const parseHeader = (row: Observation): Header | undefined => {
  const nonce = metadataText(row, capsule.keys.nonce);
  const digest = metadataText(row, capsule.keys.graphDigest);
  const graphBytes = integer(
    metadataText(row, capsule.keys.graphBytes),
    capsule.maximumGraphBytes,
  );
  const carrierCount = integer(
    metadataText(row, capsule.keys.carrierCount),
    capsule.maximumCarriers,
  );
  const chunkCount = integer(metadataText(row, capsule.keys.chunkCount), 2_048);
  const spanCount = integer(
    metadataText(row, projection.spanCount),
    projection.maximumSpans,
  );
  const status = metadataText(row, projection.status);
  const models = indexedValues(
    row,
    projection.modelCount,
    projection.modelIndexPrefix,
  );
  const tags = indexedValues(
    row,
    projection.tagCount,
    projection.tagIndexPrefix,
  );
  const encodedCharacters =
    graphBytes === undefined ? undefined : Math.ceil((graphBytes * 8) / 6);
  const expectedChunkCount =
    encodedCharacters === undefined
      ? undefined
      : Math.ceil(encodedCharacters / capsule.chunkCharacters);
  const expectedCarrierCount =
    expectedChunkCount === undefined
      ? undefined
      : Math.ceil(expectedChunkCount / capsule.maximumChunksPerCarrier);
  if (
    row.name !== capsule.headerName ||
    row.endTime !== row.startTime ||
    metadataText(row, capsule.keys.marker) !== capsule.marker ||
    metadataText(row, capsule.keys.version) !== capsule.version ||
    metadataText(row, projection.root) !== "true" ||
    models === undefined ||
    tags === undefined ||
    Object.keys(row.metadata).some(
      (key) => !allowedHeaderMetadata(row, models ?? [], tags ?? []).has(key),
    ) ||
    !isCapsuleNonce(nonce) ||
    !/^[\da-f]{64}$/u.test(digest ?? "") ||
    graphBytes === undefined ||
    graphBytes < 1 ||
    carrierCount === undefined ||
    carrierCount < 1 ||
    chunkCount === undefined ||
    chunkCount < 1 ||
    chunkCount !== expectedChunkCount ||
    carrierCount !== expectedCarrierCount ||
    spanCount === undefined ||
    spanCount < 1 ||
    !["unset", "ok", "error"].includes(status ?? "") ||
    !Number.isFinite(Date.parse(row.startTime)) ||
    [
      projection.session,
      projection.harness,
      projection.branch,
      projection.repository,
    ].some(
      (key) =>
        Object.hasOwn(row.metadata, key) &&
        projectionValue(row, key) === undefined,
    ) ||
    models?.some(
      (value) =>
        metadataText(row, deriveLangfuseProjectionFilterKey("model", value)) !==
        value,
    ) ||
    tags?.some(
      (value) =>
        metadataText(row, deriveLangfuseProjectionFilterKey("tag", value)) !==
        value,
    ) ||
    row.id !== deriveLangfuseCapsuleSpanId(row.traceId, nonce, "header", 0)
  )
    return undefined;
  return Object.freeze({
    row,
    nonce,
    graphBytes,
    graphDigest: digest!,
    carrierCount,
    chunkCount,
    spanCount,
    status: status as "unset" | "ok" | "error",
    models,
    tags,
  });
};

const observationFingerprint = (row: Observation): string =>
  JSON.stringify([
    row.id,
    row.traceId,
    row.parentObservationId,
    row.type,
    row.isRootObservation,
    row.name,
    row.startTime,
    row.endTime!,
    Object.entries(row.metadata).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ]);

const parseHeaders = (
  rows: readonly Observation[],
): readonly Header[] | undefined => {
  const output: Header[] = [];
  const seen = new Map<string, string>();
  for (const row of rows) {
    const header = parseHeader(row);
    if (header === undefined) return undefined;
    const serialized = observationFingerprint(header.row);
    const prior = seen.get(header.nonce);
    if (prior !== undefined) {
      if (prior !== serialized) return undefined;
      continue;
    }
    seen.set(header.nonce, serialized);
    output.push(header);
  }
  return Object.freeze(output);
};

const createSummary = (
  context: RetrieverFactoryContext<LangfuseDestinationSettings>,
  header: Header,
) => {
  try {
    return createTraceSummary({
      locator: createTraceLocator({
        connectionId: context.connectionId,
        destinationType: createDestinationTypeId(
          "@agentscope/destination-langfuse",
        ),
        traceId: header.row.traceId,
        destinationRevision: header.nonce,
      }),
      startTime: new Date(header.row.startTime).toISOString(),
      ...(metadataText(header.row, projection.harness) === undefined
        ? {}
        : { harness: metadataText(header.row, projection.harness)! }),
      ...(metadataText(header.row, projection.branch) === undefined
        ? {}
        : { branch: metadataText(header.row, projection.branch)! }),
      ...(metadataText(header.row, projection.repository) === undefined
        ? {}
        : {
            repositoryIdentity: metadataText(
              header.row,
              projection.repository,
            )!,
          }),
      models: header.models,
      status: header.status,
      spanCount: header.spanCount,
      tags: header.tags,
    });
  } catch {
    /* v8 ignore next -- exact closed header validation plus query fixed-point checks make constructor rejection defensive only. */
    return undefined;
  }
};

const headerMatchesRequest = (
  header: Header,
  request: TraceSearchRequest,
): boolean => {
  const query = request.query;
  const start = Date.parse(header.row.startTime);
  return (
    Number.isFinite(start) &&
    (query.traceId === undefined || header.row.traceId === query.traceId) &&
    (query.from === undefined || start >= Date.parse(query.from)) &&
    start < Date.parse(query.to) &&
    (query.harness === undefined ||
      metadataText(header.row, projection.harness) === query.harness) &&
    (query.branch === undefined ||
      metadataText(header.row, projection.branch) === query.branch) &&
    (query.model === undefined || header.models.includes(query.model)) &&
    (query.sessionId === undefined ||
      metadataText(header.row, projection.session) === query.sessionId) &&
    query.tags.every((tag) => header.tags.includes(tag))
  );
};

/* eslint-disable max-lines-per-function -- the factory closes over one endpoint/profile/credential authority and exposes no mutable runtime seam. */
export const createLangfuseRetriever = (
  factory: RetrieverFactoryContext<LangfuseDestinationSettings>,
): Retriever => {
  /* v8 ignore next 2 -- the remote descriptor factory is invoked only after exact endpoint/transport preparation. */
  if (factory.transport === null || factory.endpoint === null)
    throw new Error("destination.langfuse.transport.unavailable");
  const transport = factory.transport;
  const profile = profileFor(factory.settings.profileId);
  const headers = Object.freeze({ authorization: authorizationFor(factory) });

  const requestRows = async (
    pathAndQuery: string,
    context: RetrievalContext,
    remainingResponseBytes = context.maximumResponseBytes,
  ) => {
    const response = await executeBoundDestinationRequest(transport, {
      method: "GET",
      pathAndQuery,
      headers,
      signal: context.signal,
      deadline: context.deadline,
    });
    const failure = failureCode(response.status);
    if (failure !== undefined)
      return {
        failure: createRetrieverFailure(
          failure,
          failure === "rate-limited"
            ? retryAfterMilliseconds(response.headers["retry-after"])
            : undefined,
        ),
      } as const;
    if (
      !isJsonResponseContentType(response.headers["content-type"]) ||
      response.body.byteLength >
        Math.min(remainingResponseBytes, profile.retriever.maximumResponseBytes)
    )
      return { failure: createRetrieverFailure("malformed-response") } as const;
    const parsed = parseObservations(
      response.body,
      profile.retriever.maximumResponseRows,
    );
    return parsed === undefined
      ? ({ failure: createRetrieverFailure("malformed-response") } as const)
      : ({ parsed, responseBytes: response.body.byteLength } as const);
  };

  const chooseHeader = async (
    locator: TraceGetRequest["locator"],
    context: RetrievalContext,
  ) => {
    const query = new URLSearchParams();
    if (profile.retriever.pagination === "page-offset")
      query.set("useEventsTable", "true");
    else
      query.set(
        "fields",
        (
          profile.retriever as { headerGetFieldGroups: readonly string[] }
        ).headerGetFieldGroups.join(","),
      );
    query.set("limit", String(Math.min(profile.retriever.maximumLimit, 100)));
    query.set(
      "filter",
      JSON.stringify([
        metadataFilter(capsule.keys.marker, capsule.marker),
        filter("string", "traceId", "=", locator.traceId),
        ...(locator.destinationRevision === undefined
          ? []
          : [metadataFilter(capsule.keys.nonce, locator.destinationRevision)]),
      ]),
    );
    const result = await requestRows(
      `${profile.retriever.path}?${query.toString()}`,
      context,
    );
    if (!("parsed" in result)) return { failure: result.failure } as const;
    const candidates = parseHeaders(result.parsed.data);
    if (candidates === undefined)
      return { failure: createRetrieverFailure("malformed-response") } as const;
    if (
      candidates.some(
        (candidate) =>
          candidate.row.traceId !== locator.traceId ||
          (locator.destinationRevision !== undefined &&
            candidate.nonce !== locator.destinationRevision),
      )
    )
      return { failure: createRetrieverFailure("malformed-response") } as const;
    if (result.parsed.continuation !== undefined)
      return { failure: createRetrieverFailure("malformed-response") } as const;
    if (
      profile.retriever.pagination === "page-offset" &&
      result.parsed.data.length ===
        Math.min(profile.retriever.maximumLimit, 100)
    )
      return { failure: createRetrieverFailure("malformed-response") } as const;
    return candidates[0] === undefined
      ? ({ failure: createRetrieverFailure("not-found") } as const)
      : ({
          header: candidates[0],
          responseBytes: result.responseBytes,
        } as const);
  };

  return createDestinationRetriever({
    search: async (request, context) => {
      const path = searchPath(profile, request);
      if (path === undefined) return createRetrieverFailure("invalid-query");
      const result = await requestRows(path, context);
      if ("failure" in result) return result.failure;
      const candidates = parseHeaders(result.parsed.data);
      if (candidates === undefined)
        return createRetrieverFailure("malformed-response");
      const summaries = [];
      const traceIds = new Set<string>();
      for (const header of candidates) {
        if (!headerMatchesRequest(header, request))
          return createRetrieverFailure("malformed-response");
        if (traceIds.has(header.row.traceId)) continue;
        const summary = createSummary(factory, header);
        /* v8 ignore next 2 -- complete header parsing validates the same bounded summary fields before selection; constructor failure remains a defensive containment seam. */
        if (summary === undefined)
          return createRetrieverFailure("malformed-response");
        traceIds.add(header.row.traceId);
        summaries.push(summary);
      }
      const v1Continuation =
        profile.retriever.pagination === "page-offset" &&
        result.parsed.data.length ===
          Math.min(request.query.limit, profile.retriever.maximumLimit)
          ? (typeof request.continuationToken === "number"
              ? request.continuationToken
              : 1) + 1
          : undefined;
      const continuation = result.parsed.continuation ?? v1Continuation;
      return createRetrieverSuccess(
        createRetrieverSearchPage({
          summaries,
          state: continuation === undefined ? "exhaustive" : "continuation",
          ...(continuation === undefined
            ? {}
            : { continuationToken: continuation }),
          consistency: "best-effort",
          ordering: "start-time-desc-provider",
        }),
      );
    },
    // eslint-disable-next-line complexity -- the selected revision is validated through one closed header/carrier/digest/Protocol state machine.
    get: async (request, context) => {
      if (
        request.locator.destinationRevision !== undefined &&
        !isCapsuleNonce(request.locator.destinationRevision)
      )
        return createRetrieverFailure("invalid-query");
      if (context.maximumProviderRequests < 2)
        return createRetrieverFailure("unavailable");
      const selected = await chooseHeader(request.locator, context);
      if (!("header" in selected)) return selected.failure;
      const header = selected.header;
      const query = new URLSearchParams();
      if (profile.retriever.pagination === "page-offset")
        query.set("useEventsTable", "true");
      else
        query.set(
          "fields",
          (
            profile.retriever as { carrierGetFieldGroups: readonly string[] }
          ).carrierGetFieldGroups.join(","),
        );
      query.set("limit", String(profile.retriever.maximumLimit));
      query.set(
        "filter",
        JSON.stringify([
          filter("string", "traceId", "=", request.locator.traceId),
          metadataFilter(capsule.keys.version, capsule.version),
          metadataFilter(capsule.keys.nonce, header.nonce),
          metadataFilter(capsule.keys.graphDigest, header.graphDigest),
          filter("string", "name", "=", capsule.carrierName),
        ]),
      );
      const result = await requestRows(
        `${profile.retriever.path}?${query.toString()}`,
        context,
        context.maximumResponseBytes - selected.responseBytes!,
      );
      if ("failure" in result) return result.failure;
      if (result.parsed.continuation !== undefined)
        return createRetrieverFailure("malformed-response");
      const chunksByIndex = new Map<
        number,
        Readonly<{ chunks: readonly string[]; fingerprint: string }>
      >();
      for (const row of result.parsed.data) {
        const index = integer(
          metadataText(row, capsule.keys.carrierIndex),
          header.carrierCount - 1,
        );
        const chunks = row.metadata[capsule.keys.chunks];
        const expectedChunks =
          index === undefined
            ? undefined
            : Math.min(
                capsule.maximumChunksPerCarrier,
                header.chunkCount - index * capsule.maximumChunksPerCarrier,
              );
        if (
          row.name !== capsule.carrierName ||
          row.traceId !== header.row.traceId ||
          row.parentObservationId !== header.row.parentObservationId ||
          row.startTime !== header.row.startTime ||
          row.endTime !== header.row.startTime ||
          metadataText(row, capsule.keys.version) !== capsule.version ||
          metadataText(row, capsule.keys.nonce) !== header.nonce ||
          metadataText(row, capsule.keys.graphDigest) !== header.graphDigest ||
          index === undefined ||
          row.id !==
            deriveLangfuseCapsuleSpanId(
              row.traceId,
              header.nonce,
              "carrier",
              index,
            ) ||
          !Array.isArray(chunks) ||
          expectedChunks === undefined ||
          expectedChunks < 1 ||
          chunks.length !== expectedChunks ||
          chunks.some(
            (chunk, localIndex) =>
              typeof chunk !== "string" ||
              !/^[A-Za-z0-9_-]{1,180}$/u.test(chunk) ||
              (index * capsule.maximumChunksPerCarrier + localIndex <
                header.chunkCount - 1 &&
                chunk.length !== capsule.chunkCharacters),
          ) ||
          Object.keys(row.metadata).some(
            (key) =>
              !new Set<string>([
                capsule.keys.nonce,
                capsule.keys.version,
                capsule.keys.graphDigest,
                capsule.keys.carrierIndex,
                capsule.keys.chunks,
              ]).has(key),
          )
        )
          return createRetrieverFailure("malformed-response");
        const fingerprint = observationFingerprint(row);
        const prior = chunksByIndex.get(index);
        if (prior !== undefined) {
          if (prior.fingerprint !== fingerprint)
            return createRetrieverFailure("malformed-response");
          continue;
        }
        chunksByIndex.set(
          index,
          Object.freeze({ chunks: chunks as string[], fingerprint }),
        );
      }
      if (chunksByIndex.size !== header.carrierCount)
        return createRetrieverFailure("malformed-response");
      const chunks = Array.from(
        { length: header.carrierCount },
        /* v8 ignore next -- exact cardinality, unique dense bounded indices, and per-row validation guarantee every entry. */
        (_, index) => chunksByIndex.get(index)?.chunks ?? [],
      ).flat();
      /* v8 ignore next 2 -- exact per-carrier distribution, dense indices, and header formulas already prove this equality. */
      if (chunks.length !== header.chunkCount)
        return createRetrieverFailure("malformed-response");
      const encodedGraph = chunks.join("");
      const bytes = Uint8Array.from(Buffer.from(encodedGraph, "base64url"));
      if (
        Buffer.from(bytes).toString("base64url") !== encodedGraph ||
        bytes.byteLength !== header.graphBytes ||
        createHash("sha256").update(bytes).digest("hex") !== header.graphDigest
      )
        return createRetrieverFailure("malformed-response");
      const decoded = readExternalOtlpJson(bytes);
      if (!decoded.ok || decoded.batch.units.length !== 1)
        return createRetrieverFailure("malformed-response");
      const unit = decoded.batch.units[0]!;
      if (unit.status !== "canonical")
        return createRetrieverFailure("incompatible-trace");
      const traceIds = new Set(
        unit.graph.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) =>
            scope.spans.map((span) => span.traceId),
          ),
        ),
      );
      const logicalRoots = unit.graph.resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) =>
          scope.spans.filter(
            (span) =>
              span.traceId === header.row.traceId &&
              span.parentSpanId === undefined,
          ),
        ),
      );
      if (
        traceIds.size !== 1 ||
        !traceIds.has(header.row.traceId) ||
        logicalRoots.length !== 1 ||
        logicalRoots[0]!.spanId !== header.row.parentObservationId
      )
        return createRetrieverFailure("malformed-response");
      const selectedLocator =
        request.locator.destinationRevision === undefined
          ? createTraceLocator({
              connectionId: request.locator.connectionId,
              destinationType: request.locator.destinationType,
              traceId: request.locator.traceId,
              ...(request.locator.destinationTraceId === undefined
                ? {}
                : {
                    destinationTraceId: request.locator.destinationTraceId,
                  }),
              destinationRevision: header.nonce,
            })
          : request.locator;
      return createRetrieverSuccess(
        createRetrievedTrace({
          locator: selectedLocator,
          representation: { kind: "canonical-graph", graph: unit.graph },
          consistency: "best-effort",
        }),
      );
    },
  });
};
/* eslint-enable max-lines-per-function */
