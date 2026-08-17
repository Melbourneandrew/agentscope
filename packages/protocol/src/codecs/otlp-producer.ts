import { create, toBinary } from "@bufbuild/protobuf";

import {
  type AnyValue,
  AnyValueSchema,
  ArrayValueSchema,
  InstrumentationScopeSchema,
  KeyValueSchema,
} from "../generated/otlp/opentelemetry/proto/common/v1/common_pb.js";
import { ResourceSchema } from "../generated/otlp/opentelemetry/proto/resource/v1/resource_pb.js";
import { ExportTraceServiceRequestSchema } from "../generated/otlp/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";
import {
  ResourceSpansSchema,
  ScopeSpansSchema,
  Span_EventSchema,
  Span_LinkSchema,
  SpanSchema,
  StatusSchema,
} from "../generated/otlp/opentelemetry/proto/trace/v1/trace_pb.js";
import type { OtlpAnyValue, OtlpKeyValue } from "../schema/otlp.js";
import {
  isRedactedCanonicalTrace,
  type RedactedCanonicalTrace,
} from "../schema/redacted-envelope.js";
import { serializeCanonicalJsonData } from "./json-serialize.js";
import { base64ToBytes, hexToBytes } from "./binary-text.js";

export class OtlpCodecError extends Error {
  public constructor() {
    super("protocol.codec.invalid");
    this.name = "OtlpCodecError";
  }
}

const invalid = (): never => {
  throw new OtlpCodecError();
};

const anyValue = (value: OtlpAnyValue): AnyValue => {
  if ("stringValue" in value)
    return create(AnyValueSchema, {
      value: { case: "stringValue", value: value.stringValue },
    });
  if ("boolValue" in value)
    return create(AnyValueSchema, {
      value: { case: "boolValue", value: value.boolValue },
    });
  if ("intValue" in value)
    return create(AnyValueSchema, {
      value: { case: "intValue", value: BigInt(value.intValue) },
    });
  if ("doubleValue" in value)
    return create(AnyValueSchema, {
      value: { case: "doubleValue", value: value.doubleValue },
    });
  if ("bytesValue" in value)
    return create(AnyValueSchema, {
      value: { case: "bytesValue", value: base64ToBytes(value.bytesValue) },
    });
  return create(AnyValueSchema, {
    value: {
      case: "arrayValue" as const,
      value: create(ArrayValueSchema, {
        values: value.arrayValue.values.map((entry) => anyValue(entry)),
      }),
    },
  });
};

/** Internal verification seam; intentionally absent from package exports. */
export const otlpAnyValueToProtobufForTesting = anyValue;

const attributes = (values: readonly OtlpKeyValue[] | undefined) =>
  values?.map((entry) =>
    create(KeyValueSchema, { key: entry.key, value: anyValue(entry.value) }),
  ) ?? [];

const graphToRequest = (graph: RedactedCanonicalTrace["graph"]) =>
  create(ExportTraceServiceRequestSchema, {
    resourceSpans: graph.resourceSpans.map((resourceSpans) =>
      create(ResourceSpansSchema, {
        resource:
          resourceSpans.resource === undefined
            ? undefined
            : create(ResourceSchema, {
                attributes: attributes(resourceSpans.resource.attributes),
                droppedAttributesCount:
                  resourceSpans.resource.droppedAttributesCount ?? 0,
              }),
        scopeSpans: resourceSpans.scopeSpans.map((scopeSpans) =>
          create(ScopeSpansSchema, {
            scope:
              scopeSpans.scope === undefined
                ? undefined
                : create(InstrumentationScopeSchema, {
                    name: scopeSpans.scope.name ?? "",
                    version: scopeSpans.scope.version ?? "",
                    attributes: attributes(scopeSpans.scope.attributes),
                    droppedAttributesCount:
                      scopeSpans.scope.droppedAttributesCount ?? 0,
                  }),
            spans: scopeSpans.spans.map((span) =>
              create(SpanSchema, {
                traceId: hexToBytes(span.traceId, 16),
                spanId: hexToBytes(span.spanId, 8),
                traceState: span.traceState ?? "",
                parentSpanId:
                  span.parentSpanId === undefined
                    ? new Uint8Array()
                    : hexToBytes(span.parentSpanId, 8),
                flags: span.flags ?? 0,
                name: span.name,
                kind: span.kind,
                startTimeUnixNano: BigInt(span.startTimeUnixNano),
                endTimeUnixNano: BigInt(span.endTimeUnixNano),
                attributes: attributes(span.attributes),
                droppedAttributesCount: span.droppedAttributesCount ?? 0,
                events:
                  span.events?.map((event) =>
                    create(Span_EventSchema, {
                      timeUnixNano: BigInt(event.timeUnixNano),
                      name: event.name,
                      attributes: attributes(event.attributes),
                      droppedAttributesCount: event.droppedAttributesCount ?? 0,
                    }),
                  ) ?? [],
                droppedEventsCount: span.droppedEventsCount ?? 0,
                links:
                  span.links?.map((link) =>
                    create(Span_LinkSchema, {
                      traceId: hexToBytes(link.traceId, 16),
                      spanId: hexToBytes(link.spanId, 8),
                      traceState: link.traceState ?? "",
                      attributes: attributes(link.attributes),
                      droppedAttributesCount: link.droppedAttributesCount ?? 0,
                      flags: link.flags ?? 0,
                    }),
                  ) ?? [],
                droppedLinksCount: span.droppedLinksCount ?? 0,
                status:
                  span.status === undefined
                    ? undefined
                    : create(StatusSchema, {
                        message: span.status.message ?? "",
                        code: span.status.code,
                      }),
              }),
            ),
            schemaUrl: scopeSpans.schemaUrl ?? "",
          }),
        ),
        schemaUrl: resourceSpans.schemaUrl ?? "",
      }),
    ),
  });

/** Internal verification seam; intentionally absent from package exports. */
export const otlpRequestForGraphForTesting = (
  graph: RedactedCanonicalTrace["graph"],
) => graphToRequest(graph);

export const encodeOtlpJson = (trace: RedactedCanonicalTrace): string => {
  try {
    if (!isRedactedCanonicalTrace(trace)) invalid();
    return serializeCanonicalJsonData({
      resourceSpans: trace.graph.resourceSpans,
    });
  } catch {
    throw new OtlpCodecError();
  }
};

export const encodeOtlpProtobuf = (
  trace: RedactedCanonicalTrace,
): Uint8Array => {
  try {
    if (!isRedactedCanonicalTrace(trace)) invalid();
    return toBinary(
      ExportTraceServiceRequestSchema,
      graphToRequest(trace.graph),
      {
        writeUnknownFields: false,
      },
    );
  } catch {
    throw new OtlpCodecError();
  }
};
