import {
  parseCanonicalTraceGraph,
  readPersistedCanonicalEnvelope,
  type CanonicalTraceGraph,
  type PersistedCanonicalEnvelope,
} from "@agentscope/protocol";

import { cloneJsonObject, type JsonValue } from "./plain-data.js";
import { isTraceLocator, type TraceLocator } from "./retrieval-identity.js";
import {
  TRACE_SEARCH_ORDERINGS,
  type TraceSearchOrdering,
} from "./retrieval-query.js";

export const TRACE_SUMMARY_STATUSES = Object.freeze([
  "unset",
  "ok",
  "error",
] as const);
export type TraceSummaryStatus = (typeof TRACE_SUMMARY_STATUSES)[number];
export type RetrievalConsistency = "snapshot" | "best-effort";
export type PartialResultReason =
  "provider-request-limit" | "response-byte-limit" | "deadline";

declare const traceSummaryBrand: unique symbol;
declare const retrieverPageBrand: unique symbol;
declare const retrievedTraceBrand: unique symbol;

export type TraceSummary = Readonly<{
  locator: TraceLocator;
  startTime: string;
  endTime?: string;
  harness?: string;
  branch?: string;
  repositoryIdentity?: string;
  models: readonly string[];
  status: TraceSummaryStatus;
  spanCount: number;
  tags: readonly string[];
  readonly [traceSummaryBrand]: true;
}>;

export type TraceSummaryInput = Omit<TraceSummary, typeof traceSummaryBrand>;

export type RetrieverSearchPage = Readonly<{
  summaries: readonly TraceSummary[];
  state: "exhaustive" | "continuation" | "partial";
  partialReason?: PartialResultReason;
  continuationToken?: JsonValue;
  consistency: RetrievalConsistency;
  ordering: TraceSearchOrdering;
  exactTotal?: number;
  readonly [retrieverPageBrand]: true;
}>;

export type RetrieverSearchPageInput = Omit<
  RetrieverSearchPage,
  typeof retrieverPageBrand
>;

export type RetrievedTraceRepresentation =
  | Readonly<{
      kind: "persisted-envelope";
      envelope: PersistedCanonicalEnvelope;
    }>
  | Readonly<{ kind: "canonical-graph"; graph: CanonicalTraceGraph }>;

export type RetrievedTrace = Readonly<{
  locator: TraceLocator;
  representation: RetrievedTraceRepresentation;
  consistency: RetrievalConsistency;
  readonly [retrievedTraceBrand]: true;
}>;

const summaryRegistry = new WeakSet<object>();
const pageRegistry = new WeakSet<object>();
const traceRegistry = new WeakSet<object>();
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const objectKeys = Object.keys;
const textEncoder = new TextEncoder();

export class RetrievalResultError extends Error {
  public readonly code = "destination.retrieval-result.invalid";

  public constructor() {
    super("destination.retrieval-result.invalid");
    this.name = "RetrievalResultError";
  }
}

const invalid = (): never => {
  throw new RetrievalResultError();
};

const valueOf = (descriptors: PropertyDescriptorMap, key: string): unknown => {
  const descriptor = descriptors[key];
  if (!descriptor || !("value" in descriptor)) return invalid();
  return descriptor.value;
};

const exactOptionalKeys = (
  descriptors: PropertyDescriptorMap,
  required: readonly string[],
  optional: readonly string[],
): boolean => {
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"))
    return false;
  const keys = objectKeys(descriptors);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
};

const boundedText = (value: unknown, maximumBytes = 512): string => {
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

const canonicalTime = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    return invalid();
  return value;
};

const stringArray = (
  value: unknown,
  maximumItems: number,
): readonly string[] => {
  if (!Array.isArray(value) || value.length > maximumItems) return invalid();
  const descriptors = objectGetOwnPropertyDescriptors(value);
  const output: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) return invalid();
    const item = boundedText(descriptor.value);
    if (seen.has(item)) return invalid();
    seen.add(item);
    output.push(item);
  }
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)),
    )
  )
    return invalid();
  return Object.freeze(output.sort());
};

export const createTraceSummary = (input: TraceSummaryInput): TraceSummary => {
  try {
    if (typeof input !== "object" || input === null) return invalid();
    const descriptors = objectGetOwnPropertyDescriptors(input);
    if (
      !exactOptionalKeys(
        descriptors,
        ["locator", "models", "spanCount", "startTime", "status", "tags"],
        ["branch", "endTime", "harness", "repositoryIdentity"],
      )
    )
      return invalid();
    const locator = valueOf(descriptors, "locator");
    const status = valueOf(descriptors, "status");
    const spanCount = valueOf(descriptors, "spanCount");
    if (
      !isTraceLocator(locator) ||
      !TRACE_SUMMARY_STATUSES.includes(status as TraceSummaryStatus) ||
      !Number.isSafeInteger(spanCount) ||
      (spanCount as number) < 1 ||
      (spanCount as number) > 1_000_000
    )
      return invalid();
    const startTime = canonicalTime(valueOf(descriptors, "startTime"));
    const endTime = descriptors.endTime
      ? canonicalTime(valueOf(descriptors, "endTime"))
      : undefined;
    if (endTime !== undefined && Date.parse(endTime) < Date.parse(startTime))
      return invalid();
    const summary = Object.freeze({
      locator,
      startTime,
      ...(endTime === undefined ? {} : { endTime }),
      ...(descriptors.harness
        ? { harness: boundedText(valueOf(descriptors, "harness"), 64) }
        : {}),
      ...(descriptors.branch
        ? { branch: boundedText(valueOf(descriptors, "branch")) }
        : {}),
      ...(descriptors.repositoryIdentity
        ? {
            repositoryIdentity: boundedText(
              valueOf(descriptors, "repositoryIdentity"),
            ),
          }
        : {}),
      models: stringArray(valueOf(descriptors, "models"), 32),
      status: status as TraceSummaryStatus,
      spanCount: spanCount as number,
      tags: stringArray(valueOf(descriptors, "tags"), 32),
    }) as TraceSummary;
    summaryRegistry.add(summary);
    return summary;
  } catch {
    return invalid();
  }
};

export const isTraceSummary = (value: unknown): value is TraceSummary =>
  typeof value === "object" && value !== null && summaryRegistry.has(value);

const pageOrderIsValid = (
  summaries: readonly TraceSummary[],
  ordering: TraceSearchOrdering,
): boolean => {
  const ids = new Set<string>();
  for (let index = 0; index < summaries.length; index += 1) {
    const current = summaries[index]!;
    if (ids.has(current.locator.traceId)) return false;
    ids.add(current.locator.traceId);
    const previous = summaries[index - 1];
    if (!previous) continue;
    if (previous.startTime < current.startTime) return false;
    if (
      ordering === "start-time-desc-trace-id-asc" &&
      previous.startTime === current.startTime &&
      previous.locator.traceId > current.locator.traceId
    )
      return false;
  }
  return true;
};

const pageStateIsValid = (
  state: unknown,
  consistency: unknown,
  ordering: unknown,
  partialReason: unknown,
  continuationToken: unknown,
): boolean =>
  ["exhaustive", "continuation", "partial"].includes(state as string) &&
  ["snapshot", "best-effort"].includes(consistency as string) &&
  TRACE_SEARCH_ORDERINGS.includes(ordering as TraceSearchOrdering) &&
  ((ordering === "start-time-desc-trace-id-asc" &&
    consistency === "snapshot") ||
    (ordering === "start-time-desc-provider" &&
      consistency === "best-effort")) &&
  !(state === "exhaustive" && continuationToken !== undefined) &&
  !(state === "continuation" && continuationToken === undefined) &&
  (state === "partial") === (partialReason !== undefined) &&
  (partialReason === undefined ||
    ["provider-request-limit", "response-byte-limit", "deadline"].includes(
      partialReason as string,
    ));

const graphTraceId = (graph: CanonicalTraceGraph): string => {
  const traceIds = new Set<string>();
  for (const resource of graph.resourceSpans) {
    for (const scope of resource.scopeSpans) {
      for (const span of scope.spans) traceIds.add(span.traceId);
    }
  }
  /* v8 ignore next -- strict canonical parsing already requires one trace identity per graph. */
  if (traceIds.size !== 1) return invalid();
  return traceIds.values().next().value as string;
};

export const createRetrieverSearchPage = (
  input: RetrieverSearchPageInput,
): RetrieverSearchPage => {
  try {
    if (typeof input !== "object" || input === null) return invalid();
    const descriptors = objectGetOwnPropertyDescriptors(input);
    if (
      !exactOptionalKeys(
        descriptors,
        ["consistency", "ordering", "state", "summaries"],
        ["continuationToken", "exactTotal", "partialReason"],
      )
    )
      return invalid();
    const candidates = valueOf(descriptors, "summaries");
    if (!Array.isArray(candidates) || candidates.length > 200) return invalid();
    const candidateDescriptors = objectGetOwnPropertyDescriptors(candidates);
    if (
      Reflect.ownKeys(candidateDescriptors).some(
        (key) =>
          key !== "length" &&
          (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)),
      )
    )
      return invalid();
    const summaries: TraceSummary[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const descriptor = candidateDescriptors[String(index)];
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !isTraceSummary(descriptor.value)
      )
        return invalid();
      summaries.push(descriptor.value);
    }
    const state = valueOf(descriptors, "state");
    const consistency = valueOf(descriptors, "consistency");
    const ordering = valueOf(descriptors, "ordering");
    if (
      !TRACE_SEARCH_ORDERINGS.includes(ordering as TraceSearchOrdering) ||
      !pageOrderIsValid(summaries, ordering as TraceSearchOrdering)
    )
      return invalid();
    const partialReason = descriptors.partialReason
      ? valueOf(descriptors, "partialReason")
      : undefined;
    const continuationToken = descriptors.continuationToken
      ? valueOf(descriptors, "continuationToken")
      : undefined;
    if (
      !pageStateIsValid(
        state,
        consistency,
        ordering,
        partialReason,
        continuationToken,
      )
    )
      return invalid();
    const exactTotal = descriptors.exactTotal
      ? valueOf(descriptors, "exactTotal")
      : undefined;
    if (
      exactTotal !== undefined &&
      (!Number.isSafeInteger(exactTotal) ||
        (exactTotal as number) < summaries.length ||
        consistency !== "snapshot")
    )
      return invalid();
    const page = Object.freeze({
      summaries: Object.freeze(summaries),
      state: state as RetrieverSearchPage["state"],
      ...(partialReason === undefined
        ? {}
        : { partialReason: partialReason as PartialResultReason }),
      ...(continuationToken === undefined
        ? {}
        : {
            continuationToken: cloneJsonObject({ value: continuationToken })[
              "value"
            ]!,
          }),
      consistency: consistency as RetrievalConsistency,
      ordering: ordering as TraceSearchOrdering,
      ...(exactTotal === undefined ? {} : { exactTotal: exactTotal as number }),
    }) as RetrieverSearchPage;
    pageRegistry.add(page);
    return page;
  } catch {
    return invalid();
  }
};

export const isRetrieverSearchPage = (
  value: unknown,
): value is RetrieverSearchPage =>
  typeof value === "object" && value !== null && pageRegistry.has(value);

export const createRetrievedTrace = (input: {
  locator: TraceLocator;
  representation: unknown;
  consistency: RetrievalConsistency;
}): RetrievedTrace => {
  try {
    if (typeof input !== "object" || input === null) return invalid();
    const descriptors = objectGetOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
      objectKeys(descriptors).sort().join(",") !==
        "consistency,locator,representation"
    )
      return invalid();
    const locator = valueOf(descriptors, "locator");
    const consistency = valueOf(descriptors, "consistency");
    const representationInput = valueOf(descriptors, "representation");
    if (
      !isTraceLocator(locator) ||
      !["snapshot", "best-effort"].includes(consistency as string) ||
      typeof representationInput !== "object" ||
      representationInput === null
    )
      return invalid();
    const representationDescriptors =
      objectGetOwnPropertyDescriptors(representationInput);
    if (
      Reflect.ownKeys(representationDescriptors).some(
        (key) => typeof key !== "string",
      )
    )
      return invalid();
    const kind = valueOf(representationDescriptors, "kind");
    let representation: RetrievedTraceRepresentation;
    if (
      kind === "persisted-envelope" &&
      objectKeys(representationDescriptors).sort().join(",") === "envelope,kind"
    ) {
      const read = readPersistedCanonicalEnvelope(
        valueOf(representationDescriptors, "envelope"),
      );
      if (!read.ok) return invalid();
      if (graphTraceId(read.envelope.graph) !== locator.traceId)
        return invalid();
      representation = Object.freeze({
        kind,
        envelope: read.envelope,
      });
    } else if (
      kind === "canonical-graph" &&
      objectKeys(representationDescriptors).sort().join(",") === "graph,kind"
    ) {
      const graph = parseCanonicalTraceGraph(
        valueOf(representationDescriptors, "graph"),
      );
      if (graphTraceId(graph) !== locator.traceId) return invalid();
      representation = Object.freeze({ kind, graph });
    } else return invalid();
    const trace = Object.freeze({
      locator,
      representation,
      consistency: consistency as RetrievalConsistency,
    }) as RetrievedTrace;
    traceRegistry.add(trace);
    return trace;
  } catch {
    return invalid();
  }
};

export const isRetrievedTrace = (value: unknown): value is RetrievedTrace =>
  typeof value === "object" && value !== null && traceRegistry.has(value);
