import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
  AnyValueSchema,
  ArrayValueSchema,
  InstrumentationScopeSchema,
  KeyValueSchema,
} from "../generated/otlp/opentelemetry/proto/common/v1/common_pb.js";
import { ExportTraceServiceRequestSchema } from "../generated/otlp/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";
import { ResourceSchema } from "../generated/otlp/opentelemetry/proto/resource/v1/resource_pb.js";
import {
  ResourceSpansSchema,
  ScopeSpansSchema,
  Span_EventSchema,
  Span_LinkSchema,
  SpanSchema,
  StatusSchema,
} from "../generated/otlp/opentelemetry/proto/trace/v1/trace_pb.js";
import type { CanonicalTraceGraph } from "../schema/canonical-graph.js";
import type { OtlpAnyValue } from "../schema/otlp.js";
import { CODEC_PROFILE } from "./codec-profile.js";
import {
  otlpAnyValueToProtobufForTesting,
  otlpRequestForGraphForTesting,
} from "./otlp-producer.js";
import {
  compareOtlpSpansForTesting,
  normalizeOtlpAttributesForTesting,
  normalizeOtlpResourceForTesting,
  normalizeOtlpScopeForTesting,
  normalizeOtlpSpanForTesting,
  otlpAnyValueFromProtobufForTesting,
  receiverCountsAreValidForTesting,
} from "./otlp-reader.js";

const protoValue = (
  caseName:
    "stringValue" | "boolValue" | "intValue" | "doubleValue" | "bytesValue",
  value: string | boolean | bigint | number | Uint8Array,
) => create(AnyValueSchema, { value: { case: caseName, value } } as never);

describe("OTLP producer natural-value mapping", () => {
  it("maps every canonical AnyValue branch without widening", () => {
    const values: OtlpAnyValue[] = [
      { stringValue: "x" },
      { boolValue: true },
      { intValue: "-2" },
      { doubleValue: 1.5 },
      { bytesValue: "+/8=" },
      {
        arrayValue: {
          values: [{ stringValue: "x" }, { intValue: "2" }],
        },
      },
    ];
    expect(
      values.map((value) => otlpAnyValueToProtobufForTesting(value).value.case),
    ).toEqual([
      "stringValue",
      "boolValue",
      "intValue",
      "doubleValue",
      "bytesValue",
      "arrayValue",
    ]);
  });

  it("maps every optional resource, scope, span, event, link, and status field", () => {
    const graph: CanonicalTraceGraph = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "a" } }],
            droppedAttributesCount: 1,
          },
          schemaUrl: "resource-schema",
          scopeSpans: [
            {
              scope: {
                name: "scope",
                version: "1",
                attributes: [{ key: "scope.attr", value: { boolValue: true } }],
                droppedAttributesCount: 2,
              },
              schemaUrl: "scope-schema",
              spans: [
                {
                  traceId: "11".repeat(16),
                  spanId: "22".repeat(8),
                  parentSpanId: "33".repeat(8),
                  traceState: "state",
                  flags: 257,
                  name: "operation",
                  kind: 1,
                  startTimeUnixNano: "1",
                  endTimeUnixNano: "2",
                  attributes: [{ key: "x", value: { doubleValue: 1.5 } }],
                  droppedAttributesCount: 3,
                  events: [
                    {
                      timeUnixNano: "1",
                      name: "event",
                      attributes: [{ key: "x", value: { bytesValue: "AA==" } }],
                      droppedAttributesCount: 4,
                    },
                  ],
                  droppedEventsCount: 5,
                  links: [
                    {
                      traceId: "44".repeat(16),
                      spanId: "55".repeat(8),
                      traceState: "link-state",
                      attributes: [
                        {
                          key: "x",
                          value: {
                            arrayValue: { values: [{ stringValue: "v" }] },
                          },
                        },
                      ],
                      droppedAttributesCount: 6,
                      flags: 769,
                    },
                  ],
                  droppedLinksCount: 7,
                  status: { message: "status", code: 2 },
                },
              ],
            },
          ],
        },
      ],
    };
    const request = otlpRequestForGraphForTesting(graph);
    const span = request.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(request.resourceSpans[0]!.schemaUrl).toBe("resource-schema");
    expect(request.resourceSpans[0]!.resource!.droppedAttributesCount).toBe(1);
    expect(request.resourceSpans[0]!.scopeSpans[0]!.scope!.name).toBe("scope");
    expect(span.parentSpanId).toHaveLength(8);
    expect(span.events[0]!.droppedAttributesCount).toBe(4);
    expect(span.links[0]!.flags).toBe(769);
    expect(span.status?.message).toBe("status");
  });
});

describe("OTLP producer default mapping", () => {
  it("maps absent optional containers to protobuf defaults", () => {
    const graph: CanonicalTraceGraph = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "11".repeat(16),
                  spanId: "22".repeat(8),
                  name: "operation",
                  kind: 1,
                  startTimeUnixNano: "1",
                  endTimeUnixNano: "1",
                },
              ],
            },
          ],
        },
      ],
    };
    const request = otlpRequestForGraphForTesting(graph);
    const resource = request.resourceSpans[0]!;
    const span = resource.scopeSpans[0]!.spans[0]!;
    expect(resource.resource).toBeUndefined();
    expect(resource.scopeSpans[0]!.scope).toBeUndefined();
    expect(span.parentSpanId).toHaveLength(0);
    expect(span.events).toEqual([]);
    expect(span.links).toEqual([]);
    expect(span.status).toBeUndefined();
  });

  it("maps present containers whose optional members use protobuf defaults", () => {
    const graph: CanonicalTraceGraph = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              scope: {},
              spans: [
                {
                  traceId: "11".repeat(16),
                  spanId: "22".repeat(8),
                  name: "operation",
                  kind: 1,
                  startTimeUnixNano: "1",
                  endTimeUnixNano: "1",
                  events: [{ timeUnixNano: "1", name: "event" }],
                  links: [{ traceId: "33".repeat(16), spanId: "44".repeat(8) }],
                  status: { code: 0 },
                },
              ],
            },
          ],
        },
      ],
    };
    const span =
      otlpRequestForGraphForTesting(graph).resourceSpans[0]!.scopeSpans[0]!
        .spans[0]!;
    expect(span.events[0]!.droppedAttributesCount).toBe(0);
    expect(span.links[0]).toMatchObject({
      traceState: "",
      droppedAttributesCount: 0,
      flags: 0,
    });
    expect(span.status?.message).toBe("");
  });
});

describe("OTLP receiver normalization", () => {
  it("sorts spans by numeric start time and then exact span identity", () => {
    const span = (startTimeUnixNano: string, spanId: string) => ({
      traceId: "11".repeat(16),
      spanId,
      name: "operation",
      kind: 1,
      startTimeUnixNano,
      endTimeUnixNano: startTimeUnixNano,
    });
    expect(compareOtlpSpansForTesting(span("2", "bb"), span("10", "aa"))).toBe(
      -1,
    );
    expect(compareOtlpSpansForTesting(span("10", "aa"), span("2", "bb"))).toBe(
      1,
    );
    expect(compareOtlpSpansForTesting(span("2", "aa"), span("2", "bb"))).toBe(
      -1,
    );
    expect(compareOtlpSpansForTesting(span("2", "bb"), span("2", "aa"))).toBe(
      1,
    );
    expect(compareOtlpSpansForTesting(span("2", "aa"), span("2", "aa"))).toBe(
      0,
    );
  });

  it("normalizes every supported protobuf AnyValue and rejects nested/opaque cases", () => {
    const simple = [
      protoValue("stringValue", "x"),
      protoValue("boolValue", true),
      protoValue("intValue", -2n),
      protoValue("doubleValue", 1.5),
      protoValue("bytesValue", new Uint8Array([0xfb, 0xff])),
    ];
    expect(simple.map(otlpAnyValueFromProtobufForTesting)).toEqual([
      { stringValue: "x" },
      { boolValue: true },
      { intValue: "-2" },
      { doubleValue: 1.5 },
      { bytesValue: "+/8=" },
    ]);
    const array = create(AnyValueSchema, {
      value: {
        case: "arrayValue",
        value: create(ArrayValueSchema, { values: simple }),
      },
    });
    const convertedArray = otlpAnyValueFromProtobufForTesting(array);
    expect(convertedArray).toBeDefined();
    if (convertedArray !== undefined && "arrayValue" in convertedArray) {
      expect(convertedArray.arrayValue.values).toHaveLength(5);
    }
    const nested = create(AnyValueSchema, {
      value: {
        case: "arrayValue",
        value: create(ArrayValueSchema, { values: [array] }),
      },
    });
    expect(otlpAnyValueFromProtobufForTesting(nested)).toBeUndefined();
    expect(
      otlpAnyValueFromProtobufForTesting(protoValue("doubleValue", Number.NaN)),
    ).toBeUndefined();
    expect(
      otlpAnyValueFromProtobufForTesting(create(AnyValueSchema)),
    ).toBeUndefined();
  });

  it("drops unknown standard attributes and classifies duplicates and unknown extensions", () => {
    const stringValue = protoValue("stringValue", "value");
    const entries = [
      create(KeyValueSchema, { key: "service.name", value: stringValue }),
      create(KeyValueSchema, { key: "service.name", value: stringValue }),
      create(KeyValueSchema, { key: "future.attribute", value: stringValue }),
      create(KeyValueSchema, {
        key: "agentscope.future",
        value: stringValue,
      }),
      create(KeyValueSchema, { key: "llm.model_name" }),
    ];
    expect(normalizeOtlpAttributesForTesting(entries)).toEqual({
      attributes: [{ key: "service.name", value: { stringValue: "value" } }],
      invalid: true,
      unsupported: true,
    });
    expect(
      normalizeOtlpAttributesForTesting([
        create(KeyValueSchema, { key: "llm.model_name", value: stringValue }),
        create(KeyValueSchema, { key: "input.value", value: stringValue }),
      ]).attributes.map(({ key }) => key),
    ).toEqual(["input.value", "llm.model_name"]);
    expect(
      normalizeOtlpAttributesForTesting([
        create(KeyValueSchema, { key: "input.value", value: stringValue }),
        create(KeyValueSchema, { key: "llm.model_name", value: stringValue }),
      ]).attributes.map(({ key }) => key),
    ).toEqual(["input.value", "llm.model_name"]);
    expect(
      normalizeOtlpAttributesForTesting([
        create(KeyValueSchema, {
          key: "input.value",
          value: create(AnyValueSchema, {
            value: { case: "stringValueStrindex", value: 1 },
          }),
        }),
      ]),
    ).toEqual({ attributes: [], invalid: false, unsupported: false });
  });
});

describe("OTLP span normalization", () => {
  it("normalizes default and populated resource and scope metadata", () => {
    expect(
      normalizeOtlpResourceForTesting(create(ResourceSpansSchema)),
    ).toEqual({
      evidence: { attributes: [], invalid: false, unsupported: false },
      resource: {},
    });
    expect(
      normalizeOtlpResourceForTesting(
        create(ResourceSpansSchema, { resource: create(ResourceSchema) }),
      ).resource,
    ).toEqual({ resource: {} });
    expect(normalizeOtlpScopeForTesting(create(ScopeSpansSchema))).toEqual({
      evidence: { attributes: [], invalid: false, unsupported: false },
      scope: {},
    });
    expect(
      normalizeOtlpScopeForTesting(
        create(ScopeSpansSchema, {
          scope: create(InstrumentationScopeSchema),
        }),
      ).scope,
    ).toEqual({ scope: {} });
    const attribute = create(KeyValueSchema, {
      key: "service.name",
      value: protoValue("stringValue", "safe"),
    });
    expect(
      normalizeOtlpResourceForTesting(
        create(ResourceSpansSchema, {
          resource: create(ResourceSchema, {
            attributes: [attribute],
            droppedAttributesCount: 2,
          }),
          schemaUrl: "resource-schema",
        }),
      ).resource,
    ).toMatchObject({
      resource: { droppedAttributesCount: 2 },
      schemaUrl: "resource-schema",
    });
    expect(
      normalizeOtlpScopeForTesting(
        create(ScopeSpansSchema, {
          scope: create(InstrumentationScopeSchema, {
            name: "scope",
            version: "1",
            attributes: [attribute],
            droppedAttributesCount: 3,
          }),
          schemaUrl: "scope-schema",
        }),
      ).scope,
    ).toMatchObject({
      scope: { name: "scope", version: "1", droppedAttributesCount: 3 },
      schemaUrl: "scope-schema",
    });
  });

  it("normalizes all span collections and non-default scalar presence", () => {
    const attribute = create(KeyValueSchema, {
      key: "input.value",
      value: protoValue("stringValue", "safe"),
    });
    const span = create(SpanSchema, {
      traceId: new Uint8Array(16).fill(1),
      spanId: new Uint8Array(8).fill(2),
      parentSpanId: new Uint8Array(8).fill(3),
      traceState: "state",
      flags: 257,
      name: "operation",
      kind: 1,
      startTimeUnixNano: 1n,
      endTimeUnixNano: 2n,
      attributes: [attribute],
      droppedAttributesCount: 1,
      events: [
        create(Span_EventSchema, {
          timeUnixNano: 1n,
          name: "event",
          attributes: [attribute],
          droppedAttributesCount: 2,
        }),
      ],
      droppedEventsCount: 3,
      links: [
        create(Span_LinkSchema, {
          traceId: new Uint8Array(16).fill(4),
          spanId: new Uint8Array(8).fill(5),
          traceState: "link",
          attributes: [attribute],
          droppedAttributesCount: 4,
          flags: 769,
        }),
      ],
      droppedLinksCount: 5,
      status: create(StatusSchema, { message: "failure", code: 2 }),
    });
    const normalized = normalizeOtlpSpanForTesting(span);
    expect(normalized.invalid).toBe(false);
    expect(normalized.unsupported).toBe(false);
    expect(normalized.span).toMatchObject({
      traceState: "state",
      flags: 257,
      droppedAttributesCount: 1,
      droppedEventsCount: 3,
      droppedLinksCount: 5,
      status: { message: "failure", code: 2 },
    });
  });
});

describe("OTLP default span normalization", () => {
  it("omits all protobuf default-valued optional span fields", () => {
    const normalized = normalizeOtlpSpanForTesting(
      create(SpanSchema, {
        events: [create(Span_EventSchema)],
        links: [create(Span_LinkSchema)],
        status: create(StatusSchema),
      }),
    );
    expect(normalized).toEqual({
      invalid: false,
      unsupported: false,
      span: {
        traceId: "",
        spanId: "",
        name: "",
        kind: 0,
        startTimeUnixNano: "0",
        endTimeUnixNano: "0",
        events: [{ timeUnixNano: "0", name: "" }],
        links: [{ traceId: "", spanId: "" }],
        status: { code: 0 },
      },
    });
  });
});

describe("receiver aggregate budgets", () => {
  const emptySpan = create(SpanSchema);
  const emptyScope = create(ScopeSpansSchema);
  const emptyResource = create(ResourceSpansSchema);
  const keyValue = create(KeyValueSchema, {
    key: "x",
    value: protoValue("stringValue", "x"),
  });
  const limits = CODEC_PROFILE.externalReceiver.budgets;

  it("accepts empty and rejects each aggregate maximum plus one", () => {
    expect(
      receiverCountsAreValidForTesting(create(ExportTraceServiceRequestSchema)),
    ).toBe(true);
    const requests = [
      create(ExportTraceServiceRequestSchema, {
        resourceSpans: Array(limits.maximumResourceSpans + 1).fill(
          emptyResource,
        ),
      }),
      create(ExportTraceServiceRequestSchema, {
        resourceSpans: [
          create(ResourceSpansSchema, {
            scopeSpans: Array(limits.maximumScopeSpans + 1).fill(emptyScope),
          }),
        ],
      }),
      create(ExportTraceServiceRequestSchema, {
        resourceSpans: [
          create(ResourceSpansSchema, {
            scopeSpans: [
              create(ScopeSpansSchema, {
                spans: Array(limits.maximumSpans + 1).fill(emptySpan),
              }),
            ],
          }),
        ],
      }),
      create(ExportTraceServiceRequestSchema, {
        resourceSpans: [
          create(ResourceSpansSchema, {
            resource: create(ResourceSchema, {
              attributes: Array(limits.maximumAttributes + 1).fill(keyValue),
            }),
          }),
        ],
      }),
      create(ExportTraceServiceRequestSchema, {
        resourceSpans: [
          create(ResourceSpansSchema, {
            scopeSpans: [
              create(ScopeSpansSchema, {
                spans: [
                  create(SpanSchema, {
                    events: Array(limits.maximumEvents + 1).fill(
                      create(Span_EventSchema),
                    ),
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      create(ExportTraceServiceRequestSchema, {
        resourceSpans: [
          create(ResourceSpansSchema, {
            scopeSpans: [
              create(ScopeSpansSchema, {
                spans: [
                  create(SpanSchema, {
                    links: Array(limits.maximumLinks + 1).fill(
                      create(Span_LinkSchema),
                    ),
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ];
    expect(requests.map(receiverCountsAreValidForTesting)).toEqual(
      Array(requests.length).fill(false),
    );
  });
});
