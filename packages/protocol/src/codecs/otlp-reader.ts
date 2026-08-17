import { fromBinary } from "@bufbuild/protobuf";

import type {
  AnyValue,
  KeyValue,
} from "../generated/otlp/opentelemetry/proto/common/v1/common_pb.js";
import {
  ExportTraceServiceRequestSchema,
  type ExportTraceServiceRequest,
} from "../generated/otlp/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";
import type {
  ResourceSpans,
  ScopeSpans,
  Span,
} from "../generated/otlp/opentelemetry/proto/trace/v1/trace_pb.js";
import {
  safeParseTolerantCanonicalTraceGraph,
  type CanonicalTraceGraph,
} from "../schema/canonical-graph.js";
import { getAgentscopeExtension } from "../schema/extensions.js";
import { deepFreeze } from "../schema/immutable.js";
import { getAcceptedSemanticAttributeDescriptor } from "../schema/semantic-profile.js";
import type {
  OtlpAnyValue,
  OtlpKeyValue,
  OtlpResourceSpans,
  OtlpSpan,
} from "../schema/otlp.js";
import { CODEC_PROFILE } from "./codec-profile.js";
import { bytesToBase64, bytesToHex } from "./binary-text.js";
import { parseBoundedJson } from "./json-parser.js";
import { protobufMessageFromParsedJson } from "./json-to-protobuf.js";
import {
  preflightProtobufMessage,
  snapshotProtobufInput,
} from "./protobuf-preflight.js";

export type ExternalOtlpTraceUnit =
  | Readonly<{ status: "canonical"; graph: CanonicalTraceGraph }>
  | Readonly<{ status: "rejected"; reason: "invalid" | "unsupported" }>;

export type ExternalOtlpBatch = Readonly<{
  kind: "untrusted-otlp-batch";
  units: readonly ExternalOtlpTraceUnit[];
  resourceSpanCount: number;
  scopeSpanCount: number;
  spanCount: number;
}>;

export type ExternalOtlpReadResult =
  | Readonly<{ ok: true; batch: ExternalOtlpBatch }>
  | Readonly<{ ok: false; code: "protocol.reader.invalid" }>;

const invalidResult = deepFreeze({
  ok: false as const,
  code: "protocol.reader.invalid" as const,
});

const budgets = CODEC_PROFILE.externalReceiver.budgets;

type AttributesResult = {
  attributes: OtlpKeyValue[];
  invalid: boolean;
  unsupported: boolean;
};

const governedKey = (key: string) =>
  key.startsWith("agentscope.")
    ? getAgentscopeExtension(key) !== undefined
    : getAcceptedSemanticAttributeDescriptor(key) !== undefined;

const anyValue = (value: AnyValue): OtlpAnyValue | undefined => {
  switch (value.value.case) {
    case "stringValue":
      return { stringValue: value.value.value };
    case "boolValue":
      return { boolValue: value.value.value };
    case "intValue":
      return { intValue: value.value.value.toString() };
    case "doubleValue":
      return Number.isFinite(value.value.value)
        ? { doubleValue: value.value.value }
        : undefined;
    case "bytesValue":
      return { bytesValue: bytesToBase64(value.value.value) };
    case "arrayValue": {
      const values: Exclude<OtlpAnyValue, { arrayValue: unknown }>[] = [];
      for (const entry of value.value.value.values) {
        const converted = anyValue(entry);
        if (converted === undefined || "arrayValue" in converted)
          return undefined;
        values.push(converted);
      }
      return { arrayValue: { values } };
    }
    default:
      return undefined;
  }
};

/** Internal verification seam; intentionally absent from package exports. */
export const otlpAnyValueFromProtobufForTesting = anyValue;

const attributes = (entries: readonly KeyValue[]): AttributesResult => {
  const output: OtlpKeyValue[] = [];
  const seen = new Set<string>();
  let invalid = false;
  let unsupported = false;
  for (const entry of entries) {
    if (seen.has(entry.key)) {
      invalid = true;
      continue;
    }
    seen.add(entry.key);
    if (!governedKey(entry.key)) {
      if (entry.key.startsWith("agentscope.")) invalid = true;
      continue;
    }
    if (entry.value?.value.case === "stringValueStrindex") continue;
    const converted =
      entry.value === undefined ? undefined : anyValue(entry.value);
    if (converted === undefined) {
      unsupported = true;
      continue;
    }
    output.push({ key: entry.key, value: converted });
  }
  // Duplicate keys were removed above, so equality is unreachable here.
  output.sort((left, right) => (left.key < right.key ? -1 : 1));
  return { attributes: output, invalid, unsupported };
};

/** Internal verification seam; intentionally absent from package exports. */
export const normalizeOtlpAttributesForTesting = attributes;

const optionalAttributes = (result: AttributesResult) =>
  result.attributes.length === 0 ? undefined : result.attributes;

type NormalizedSpan = {
  span: OtlpSpan;
  invalid: boolean;
  unsupported: boolean;
};

const normalizedSpan = (span: Span): NormalizedSpan => {
  const spanAttributes = attributes(span.attributes);
  let invalid = spanAttributes.invalid;
  let unsupported = spanAttributes.unsupported;
  const events = span.events.map((event) => {
    const eventAttributes = attributes(event.attributes);
    invalid ||= eventAttributes.invalid;
    unsupported ||= eventAttributes.unsupported;
    return {
      timeUnixNano: event.timeUnixNano.toString(),
      name: event.name,
      ...(eventAttributes.attributes.length === 0
        ? {}
        : { attributes: eventAttributes.attributes }),
      ...(event.droppedAttributesCount === 0
        ? {}
        : { droppedAttributesCount: event.droppedAttributesCount }),
    };
  });
  const links = span.links.map((link) => {
    const linkAttributes = attributes(link.attributes);
    invalid ||= linkAttributes.invalid;
    unsupported ||= linkAttributes.unsupported;
    return {
      traceId: bytesToHex(link.traceId),
      spanId: bytesToHex(link.spanId),
      ...(link.traceState === "" ? {} : { traceState: link.traceState }),
      ...(linkAttributes.attributes.length === 0
        ? {}
        : { attributes: linkAttributes.attributes }),
      ...(link.droppedAttributesCount === 0
        ? {}
        : { droppedAttributesCount: link.droppedAttributesCount }),
      ...(link.flags === 0 ? {} : { flags: link.flags }),
    };
  });
  const normalized: OtlpSpan = {
    traceId: bytesToHex(span.traceId),
    spanId: bytesToHex(span.spanId),
    ...(span.traceState === "" ? {} : { traceState: span.traceState }),
    ...(span.parentSpanId.byteLength === 0
      ? {}
      : { parentSpanId: bytesToHex(span.parentSpanId) }),
    ...(span.flags === 0 ? {} : { flags: span.flags }),
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: span.startTimeUnixNano.toString(),
    endTimeUnixNano: span.endTimeUnixNano.toString(),
    ...(spanAttributes.attributes.length === 0
      ? {}
      : { attributes: spanAttributes.attributes }),
    ...(span.droppedAttributesCount === 0
      ? {}
      : { droppedAttributesCount: span.droppedAttributesCount }),
    ...(events.length === 0 ? {} : { events }),
    ...(span.droppedEventsCount === 0
      ? {}
      : { droppedEventsCount: span.droppedEventsCount }),
    ...(links.length === 0 ? {} : { links }),
    ...(span.droppedLinksCount === 0
      ? {}
      : { droppedLinksCount: span.droppedLinksCount }),
    ...(span.status === undefined
      ? {}
      : {
          status: {
            ...(span.status.message === ""
              ? {}
              : { message: span.status.message }),
            code: span.status.code,
          },
        }),
  };
  return { span: normalized, invalid, unsupported };
};

/** Internal verification seam; intentionally absent from package exports. */
export const normalizeOtlpSpanForTesting = normalizedSpan;

type NormalizedScope = {
  scope?: {
    name?: string;
    version?: string;
    attributes?: OtlpKeyValue[];
    droppedAttributesCount?: number;
  };
  schemaUrl?: string;
};

type TraceAccumulator = {
  resourceIndex: number;
  scopeIndex: number;
  spans: OtlpSpan[];
  resource: Omit<OtlpResourceSpans, "scopeSpans">;
  scope: NormalizedScope;
  invalid: boolean;
  unsupported: boolean;
};

const receiverCountsAreValid = (request: ExportTraceServiceRequest) => {
  let scopes = 0;
  let spans = 0;
  let attributesCount = 0;
  let events = 0;
  let links = 0;
  if (request.resourceSpans.length > budgets.maximumResourceSpans) return false;
  for (const resource of request.resourceSpans) {
    scopes += resource.scopeSpans.length;
    attributesCount += resource.resource?.attributes.length ?? 0;
    for (const scope of resource.scopeSpans) {
      spans += scope.spans.length;
      attributesCount += scope.scope?.attributes.length ?? 0;
      for (const span of scope.spans) {
        attributesCount += span.attributes.length;
        events += span.events.length;
        links += span.links.length;
        for (const event of span.events)
          attributesCount += event.attributes.length;
        for (const link of span.links)
          attributesCount += link.attributes.length;
      }
    }
  }
  return (
    scopes <= budgets.maximumScopeSpans &&
    spans <= budgets.maximumSpans &&
    attributesCount <= budgets.maximumAttributes &&
    events <= budgets.maximumEvents &&
    links <= budgets.maximumLinks
  );
};

/** Internal verification seam; intentionally absent from package exports. */
export const receiverCountsAreValidForTesting = receiverCountsAreValid;

const normalizeResource = (resourceSpans: ResourceSpans) => {
  const evidence = attributes(resourceSpans.resource?.attributes ?? []);
  const normalizedAttributes = optionalAttributes(evidence);
  const resource = {
    ...(resourceSpans.resource === undefined
      ? {}
      : {
          resource: {
            ...(normalizedAttributes === undefined
              ? {}
              : { attributes: normalizedAttributes }),
            ...(resourceSpans.resource.droppedAttributesCount === 0
              ? {}
              : {
                  droppedAttributesCount:
                    resourceSpans.resource.droppedAttributesCount,
                }),
          },
        }),
    ...(resourceSpans.schemaUrl === ""
      ? {}
      : { schemaUrl: resourceSpans.schemaUrl }),
  } satisfies Omit<OtlpResourceSpans, "scopeSpans">;
  return { evidence, resource };
};

/** Internal verification seam; intentionally absent from package exports. */
export const normalizeOtlpResourceForTesting = normalizeResource;

const normalizeScope = (scopeSpans: ScopeSpans) => {
  const evidence = attributes(scopeSpans.scope?.attributes ?? []);
  const normalizedAttributes = optionalAttributes(evidence);
  const scope = {
    ...(scopeSpans.scope === undefined
      ? {}
      : {
          scope: {
            ...(scopeSpans.scope.name === ""
              ? {}
              : { name: scopeSpans.scope.name }),
            ...(scopeSpans.scope.version === ""
              ? {}
              : { version: scopeSpans.scope.version }),
            ...(normalizedAttributes === undefined
              ? {}
              : { attributes: normalizedAttributes }),
            ...(scopeSpans.scope.droppedAttributesCount === 0
              ? {}
              : {
                  droppedAttributesCount:
                    scopeSpans.scope.droppedAttributesCount,
                }),
          },
        }),
    ...(scopeSpans.schemaUrl === "" ? {} : { schemaUrl: scopeSpans.schemaUrl }),
  } satisfies NormalizedScope;
  return { evidence, scope };
};

/** Internal verification seam; intentionally absent from package exports. */
export const normalizeOtlpScopeForTesting = normalizeScope;

const addTraceSpan = (
  traces: Map<string, TraceAccumulator>,
  indexes: Readonly<{ resource: number; scope: number }>,
  resource: ReturnType<typeof normalizeResource>,
  scope: ReturnType<typeof normalizeScope>,
  sourceSpan: Span,
) => {
  const converted = normalizedSpan(sourceSpan);
  const traceId = converted.span.traceId;
  const existing = traces.get(traceId);
  if (existing === undefined) {
    traces.set(traceId, {
      resourceIndex: indexes.resource,
      scopeIndex: indexes.scope,
      spans: [converted.span],
      resource: resource.resource,
      scope: scope.scope,
      invalid:
        resource.evidence.invalid ||
        scope.evidence.invalid ||
        converted.invalid,
      unsupported:
        resource.evidence.unsupported ||
        scope.evidence.unsupported ||
        converted.unsupported,
    });
    return;
  }
  existing.invalid ||=
    existing.resourceIndex !== indexes.resource ||
    existing.scopeIndex !== indexes.scope ||
    converted.invalid;
  existing.unsupported ||= converted.unsupported;
  existing.spans.push(converted.span);
};

const canonicalUnits = (request: ExportTraceServiceRequest) => {
  if (!receiverCountsAreValid(request)) throw new Error("invalid");
  const traces = new Map<string, TraceAccumulator>();
  request.resourceSpans.forEach((resourceSpans, resourceIndex) => {
    const resource = normalizeResource(resourceSpans);
    resourceSpans.scopeSpans.forEach((scopeSpans, scopeIndex) => {
      const scope = normalizeScope(scopeSpans);
      for (const sourceSpan of scopeSpans.spans) {
        addTraceSpan(
          traces,
          { resource: resourceIndex, scope: scopeIndex },
          resource,
          scope,
          sourceSpan,
        );
      }
    });
  });
  const units: ExternalOtlpTraceUnit[] = [];
  for (const trace of traces.values()) {
    if (trace.invalid) {
      units.push(deepFreeze({ status: "rejected", reason: "invalid" }));
      continue;
    }
    if (trace.unsupported) {
      units.push(deepFreeze({ status: "rejected", reason: "unsupported" }));
      continue;
    }
    trace.spans.sort(compareOtlpSpans);
    const parsed = safeParseTolerantCanonicalTraceGraph({
      resourceSpans: [
        {
          ...trace.resource,
          scopeSpans: [{ ...trace.scope, spans: trace.spans }],
        },
      ],
    });
    units.push(
      parsed.success
        ? deepFreeze({ status: "canonical", graph: parsed.data })
        : deepFreeze({ status: "rejected", reason: "invalid" }),
    );
  }
  return units;
};

const compareOtlpSpans = (left: OtlpSpan, right: OtlpSpan) => {
  const time = BigInt(left.startTimeUnixNano) - BigInt(right.startTimeUnixNano);
  return time < 0n
    ? -1
    : time > 0n
      ? 1
      : left.spanId < right.spanId
        ? -1
        : left.spanId > right.spanId
          ? 1
          : 0;
};

/** Internal verification seam; intentionally absent from package exports. */
export const compareOtlpSpansForTesting = compareOtlpSpans;

const resultFor = (
  request: ExportTraceServiceRequest,
): ExternalOtlpReadResult => {
  const units = canonicalUnits(request);
  let scopeSpanCount = 0;
  let spanCount = 0;
  for (const resource of request.resourceSpans) {
    scopeSpanCount += resource.scopeSpans.length;
    for (const scope of resource.scopeSpans) spanCount += scope.spans.length;
  }
  return deepFreeze({
    ok: true,
    batch: {
      kind: "untrusted-otlp-batch",
      units,
      resourceSpanCount: request.resourceSpans.length,
      scopeSpanCount,
      spanCount,
    },
  });
};

export const readExternalOtlpJson = (
  input: unknown,
): ExternalOtlpReadResult => {
  try {
    const parsed = parseBoundedJson(input, {
      maximumBytes: budgets.maximumJsonBytes,
      maximumDepth: budgets.maximumDepth,
      maximumNodes: budgets.maximumNodes,
      maximumObjectKeys: budgets.maximumObjectKeys,
      maximumArrayItems: budgets.maximumArrayItems,
      maximumStringBytes: budgets.maximumStringBytes,
    });
    return resultFor(
      protobufMessageFromParsedJson(ExportTraceServiceRequestSchema, parsed),
    );
  } catch {
    return invalidResult;
  }
};

export const readExternalOtlpProtobuf = (
  input: unknown,
): ExternalOtlpReadResult => {
  try {
    const bytes = snapshotProtobufInput(input, budgets.maximumProtobufBytes);
    preflightProtobufMessage(bytes, ExportTraceServiceRequestSchema, {
      maximumBytes: budgets.maximumProtobufBytes,
      maximumDepth: budgets.maximumDepth,
      maximumFields: budgets.maximumWireFields,
      maximumLengthDelimitedBytes: budgets.maximumLengthDelimitedBytes,
    });
    const request = fromBinary(ExportTraceServiceRequestSchema, bytes, {
      readUnknownFields: false,
      recursionLimit: budgets.maximumDepth,
    });
    return resultFor(request);
  } catch {
    return invalidResult;
  }
};
