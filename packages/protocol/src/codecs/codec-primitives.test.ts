import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
  ExportTraceServiceRequestSchema,
  ExportTraceServiceResponseSchema,
} from "../generated/otlp/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";
import { AnyValueSchema } from "../generated/otlp/opentelemetry/proto/common/v1/common_pb.js";
import { SpanSchema } from "../generated/otlp/opentelemetry/proto/trace/v1/trace_pb.js";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  hexToBytes,
} from "./binary-text.js";
import {
  isJsonNumber,
  parseBoundedJson,
  type JsonParseLimits,
} from "./json-parser.js";
import {
  normalizeIntegerLexicalForTesting,
  protobufMessageFromParsedJson,
} from "./json-to-protobuf.js";
import {
  preflightProtobufMessage,
  snapshotProtobufInput,
} from "./protobuf-preflight.js";

const generous: JsonParseLimits = {
  maximumBytes: 65_536,
  maximumDepth: 16,
  maximumNodes: 1_024,
  maximumObjectKeys: 128,
  maximumArrayItems: 128,
  maximumStringBytes: 1_024,
};

const requestFrom = (json: string) =>
  protobufMessageFromParsedJson(
    ExportTraceServiceRequestSchema,
    parseBoundedJson(json, generous),
  );

describe("binary text normalization", () => {
  it("normalizes hexadecimal and standard or URL-safe base64", () => {
    expect(bytesToHex(hexToBytes("aAbB", 2))).toBe("aabb");
    expect(bytesToBase64(new Uint8Array())).toBe("");
    expect(bytesToBase64(new Uint8Array([0xfb]))).toBe("+w==");
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]))).toBe("+/8=");
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff, 0x00]))).toBe("+/8A");
    expect(base64ToBytes("+w==")).toEqual(new Uint8Array([0xfb]));
    expect(base64ToBytes("-_8")).toEqual(new Uint8Array([0xfb, 0xff]));
    expect(base64ToBytes("+/8=")).toEqual(new Uint8Array([0xfb, 0xff]));
    expect(base64ToBytes("+/8A")).toEqual(new Uint8Array([0xfb, 0xff, 0x00]));
  });

  it.each(["0", "zz", "0000"])("rejects malformed hex %s", (value) => {
    expect(() => hexToBytes(value, 1)).toThrowError("protocol.codec.invalid");
  });

  it.each(["A", "AB", "A===", "?", "AA=A", "YWJj=", "YWJj=="])(
    "rejects malformed or noncanonical base64 %s",
    (value) => {
      expect(() => base64ToBytes(value)).toThrowError("protocol.codec.invalid");
    },
  );
});

describe("bounded duplicate-aware JSON parsing", () => {
  it("parses every JSON token while preserving exact numeric lexical form", () => {
    const value = parseBoundedJson(
      String.raw` { "values" : ["\b\f\n\r\t\/\\\"\uD83D\uDE00", true, false, null, -1.20e+3, {}, []] } `,
      generous,
    ) as { values: readonly unknown[] };
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.values)).toBe(true);
    expect(value.values.slice(0, 4)).toEqual([
      '\b\f\n\r\t/\\"😀',
      true,
      false,
      null,
    ]);
    expect(isJsonNumber(value.values[4])).toBe(true);
    if (isJsonNumber(value.values[4]))
      expect(value.values[4].lexical).toBe("-1.20e+3");
    expect(parseBoundedJson(new TextEncoder().encode("[]"), generous)).toEqual(
      [],
    );
    expect(
      (
        parseBoundedJson('{"a":1,"a":2}', generous) as {
          a: { lexical: string };
        }
      ).a.lexical,
    ).toBe("2");
  });

  it.each([
    "",
    "tru",
    "nul",
    "01",
    "1.",
    "[1,]",
    "[1 2]",
    '{"a":1,}',
    '{"a" 1}',
    '{"a":1 "b":2}',
    '"\\x"',
    '"\\u12xz"',
    '"unterminated',
    '"\u0001"',
    "{} trailing",
  ])("rejects malformed JSON without parser detail: %s", (value) => {
    expect(() => parseBoundedJson(value, generous)).toThrowError(
      "protocol.codec.invalid",
    );
  });

  it("rejects invalid UTF-8, lone surrogates, and every budget overflow", () => {
    const cases: readonly [unknown, JsonParseLimits][] = [
      [new Uint8Array([0xff]), generous],
      ["\ud800", generous],
      ["\udc00", generous],
      ["\ud800x", generous],
      [new TextEncoder().encode("[]"), { ...generous, maximumBytes: 1 }],
      ["[[]]", { ...generous, maximumDepth: 0 }],
      ["[1]", { ...generous, maximumNodes: 1 }],
      ["[1,2]", { ...generous, maximumArrayItems: 1 }],
      ['{"a":1,"b":2}', { ...generous, maximumObjectKeys: 1 }],
      ['"é"', { ...generous, maximumStringBytes: 1 }],
      ["[]", { ...generous, maximumBytes: 1 }],
      [new Date(), generous],
    ];
    cases.forEach(([value, limits], index) => {
      expect(() => parseBoundedJson(value, limits), String(index)).toThrowError(
        "protocol.codec.invalid",
      );
    });
  });
});

describe("strict OTLP JSON-to-protobuf conversion", () => {
  it("normalizes exact integer exponent and fractional lexical forms", () => {
    expect(normalizeIntegerLexicalForTesting("1.00")).toBe("1");
    expect(normalizeIntegerLexicalForTesting("0.00e-1")).toBe("0");
    expect(normalizeIntegerLexicalForTesting("1e2")).toBe("100");
    expect(normalizeIntegerLexicalForTesting("-0")).toBe("0");
    for (const value of ["1e-2", "0.01", "1e999999999999999999999", "x"]) {
      expect(() => normalizeIntegerLexicalForTesting(value)).toThrowError(
        "protocol.codec.invalid",
      );
    }
  });

  it("converts scalar, oneof, repeated-message, enum, identity, and integer forms", () => {
    const request = requestFrom(`{
      "resourceSpans":[{
        "resource":{"attributes":[
          {"key":"s","value":{"stringValue":"x"}},
          {"key":"b","value":{"boolValue":true}},
          {"key":"i","value":{"intValue":"1.2e3"}},
          {"key":"d","value":{"doubleValue":-1.5}},
          {"key":"x","value":{"bytesValue":"-_8"}},
          {"key":"a","value":{"arrayValue":{"values":[{"stringValue":"v"}]}}}
        ]},
        "scopeSpans":[{"spans":[{
          "traceId":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          "spanId":"BBBBBBBBBBBBBBBB",
          "parentSpanId":"CCCCCCCCCCCCCCCC",
          "name":"operation","kind":1,"startTimeUnixNano":1e3,
          "endTimeUnixNano":"2e3","flags":257
        }]}]
      }]
    }`);
    const span = request.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(bytesToHex(span.traceId)).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(bytesToHex(span.spanId)).toBe("bbbbbbbbbbbbbbbb");
    expect(span.startTimeUnixNano).toBe(1000n);
    expect(span.endTimeUnixNano).toBe(2000n);
    const values = request.resourceSpans[0]!.resource!.attributes.map(
      (entry) => entry.value!.value,
    );
    expect(values.map(({ case: kind }) => kind)).toEqual([
      "stringValue",
      "boolValue",
      "intValue",
      "doubleValue",
      "bytesValue",
      "arrayValue",
    ]);
  });

  it("implements ProtoJSON null, quoted numeric, special float, and bare int64 rules", () => {
    const request = requestFrom(`{
      "resourceSpans":[{"scopeSpans":[{"spans":[{
        "flags":"2.57e2",
        "startTimeUnixNano":9007199254740993,
        "endTimeUnixNano":"9007199254740993",
        "attributes":[
          {"key":"finite","value":{"doubleValue":"1.5"}},
          {"key":"nan","value":{"doubleValue":"NaN"}},
          {"key":"infinity","value":{"doubleValue":"Infinity"}},
          {"key":"negativeInfinity","value":{"doubleValue":"-Infinity"}}
        ],
        "events":null
      }]}]}]
    }`);
    const span = request.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.flags).toBe(257);
    expect(span.startTimeUnixNano).toBe(9_007_199_254_740_992n);
    expect(span.endTimeUnixNano).toBe(9_007_199_254_740_993n);
    expect(span.events).toEqual([]);
    expect(span.attributes.map((entry) => entry.value?.value.value)).toEqual([
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]);
    expect(requestFrom('{"resourceSpans":null}').resourceSpans).toEqual([]);
  });

  it.each([
    '{"resource_spans":[]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"kind":"SPAN_KIND_INTERNAL"}]}]}]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"flags":-1}]}]}]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"startTimeUnixNano":"1.2"}]}]}]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"startTimeUnixNano":"1e999"}]}]}]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"bad"}]}]}]}',
    '{"resourceSpans":[{"resource":{"attributes":[{"key":"x","value":{"stringValue":"x","boolValue":true}}]}}]}',
    "[]",
    '{"resourceSpans":{}}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"kind":1.5}]}]}]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"kind":1e999}]}]}]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"flags":true}]}]}]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"flags":4294967296}]}]}]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"startTimeUnixNano":true}]}]}]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"startTimeUnixNano":1.5}]}]}]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"startTimeUnixNano":"x"}]}]}]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"startTimeUnixNano":"1e101"}]}]}]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"startTimeUnixNano":"1000000000000000000000000000000"}]}]}]}',
    '{"resourceSpans":[{"resource":{"attributes":[{"key":1}]}}]}',
    '{"resourceSpans":[{"resource":{"attributes":[{"key":"x","value":{"boolValue":1}}]}}]}',
    '{"resourceSpans":[{"resource":{"attributes":[{"key":"x","value":{"bytesValue":1}}]}}]}',
    '{"resourceSpans":[{"resource":{"attributes":[{"key":"x","value":{"doubleValue":"not-a-number"}}]}}]}',
    '{"resourceSpans":[{"resource":{"attributes":[{"key":"x","value":{"arrayValue":{"values":{}}}}]}}]}',
    '{"resourceSpans":[null]}',
  ])("rejects non-profile ProtoJSON: %s", (json) => {
    expect(() => requestFrom(json)).toThrowError("protocol.codec.invalid");
  });
});

const protobufLimits = {
  maximumBytes: 1_024,
  maximumDepth: 16,
  maximumFields: 128,
  maximumLengthDelimitedBytes: 1_024,
} as const;

describe("schema-aware protobuf wire compatibility", () => {
  it("accepts valid messages and every supported unknown wire type", () => {
    const valid = toBinary(
      ExportTraceServiceRequestSchema,
      requestFrom('{"resourceSpans":[]}'),
    );
    for (const bytes of [
      valid,
      new Uint8Array([0x78, 0x01]),
      new Uint8Array([0x79, 0, 0, 0, 0, 0, 0, 0, 0]),
      new Uint8Array([0x21, 0, 0, 0, 0, 0, 0, 0, 0]),
      new Uint8Array([0x7a, 0]),
      new Uint8Array([0x7d, 0, 0, 0, 0]),
      new Uint8Array([0x7b, 0x7c]),
      new Uint8Array([0x7b, 0x83, 0x01, 0x84, 0x01, 0x7c]),
    ]) {
      expect(() => {
        preflightProtobufMessage(
          bytes,
          ExportTraceServiceRequestSchema,
          protobufLimits,
        );
      }).not.toThrow();
    }
    expect(() => {
      preflightProtobufMessage(
        new Uint8Array([0x85, 0x01, 0, 0, 0, 0]),
        SpanSchema,
        protobufLimits,
      );
    }).not.toThrow();
    const merged = fromBinary(
      ExportTraceServiceResponseSchema,
      new Uint8Array([0x0a, 0x02, 0x08, 0x02, 0x0a, 0x03, 0x12, 0x01, 0x78]),
      { readUnknownFields: false },
    );
    expect(merged.partialSuccess).toMatchObject({
      rejectedSpans: 2n,
      errorMessage: "x",
    });
  });
});

describe("schema-aware protobuf wire rejection and ownership", () => {
  it.each([
    new Uint8Array([0]),
    new Uint8Array([0x08, 0]),
    new Uint8Array([0x0a, 2, 0]),
    new Uint8Array([0x0b, 0x0c]),
    new Uint8Array([0x7b, 0x84, 0x01]),
    new Uint8Array([0x7b]),
    new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 2]),
    new Uint8Array([0x0a, 0x80]),
    new Uint8Array([0x09, 0]),
    new Uint8Array([0x79, 0]),
    new Uint8Array([0x0d, 0]),
    new Uint8Array([0x7e]),
    new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f, 0]),
    new Uint8Array([
      0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80,
    ]),
  ])("rejects malformed wire bytes", (bytes) => {
    expect(() => {
      preflightProtobufMessage(
        bytes,
        ExportTraceServiceRequestSchema,
        protobufLimits,
      );
    }).toThrowError("protocol.codec.invalid");
  });

  it("accepts protobuf last-wins duplicates and rejects exact resource overflows", () => {
    const duplicate = new Uint8Array([0x0a, 0, 0x0a, 0]);
    expect(() => {
      preflightProtobufMessage(
        duplicate,
        ExportTraceServiceResponseSchema,
        protobufLimits,
      );
    }).not.toThrow();
    expect(() => {
      preflightProtobufMessage(
        new Uint8Array([0x0a, 1, 0x61, 0x10, 1]),
        AnyValueSchema,
        protobufLimits,
      );
    }).not.toThrow();
    expect(
      fromBinary(AnyValueSchema, new Uint8Array([0x0a, 1, 0x61, 0x10, 1]), {
        readUnknownFields: false,
      }).value,
    ).toEqual({ case: "boolValue", value: true });
    const nested = new Uint8Array([0x0a, 0]);
    const constraints = [
      { ...protobufLimits, maximumBytes: 1 },
      { ...protobufLimits, maximumFields: 0 },
      { ...protobufLimits, maximumDepth: 0 },
    ];
    constraints.forEach((constrained, index) => {
      expect(() => {
        preflightProtobufMessage(
          nested,
          ExportTraceServiceRequestSchema,
          constrained,
        );
      }, String(index)).toThrowError("protocol.codec.invalid");
    });
    expect(() => {
      preflightProtobufMessage(
        new Uint8Array([0x7a, 1, 0]),
        ExportTraceServiceRequestSchema,
        { ...protobufLimits, maximumLengthDelimitedBytes: 0 },
      );
    }).toThrowError("protocol.codec.invalid");
    expect(() => {
      preflightProtobufMessage(
        new Uint8Array([0x7b, 0x7c]),
        ExportTraceServiceRequestSchema,
        { ...protobufLimits, maximumDepth: 0 },
      );
    }).toThrowError("protocol.codec.invalid");
  });

  it("snapshots caller-owned protobuf bytes before validation and decoding", () => {
    const source = new Uint8Array([0x0a, 0]);
    const snapshot = snapshotProtobufInput(source, 2);
    source[0] = 0xff;
    expect(snapshot).toEqual(new Uint8Array([0x0a, 0]));
    expect(snapshot.buffer).not.toBe(source.buffer);
    if (typeof SharedArrayBuffer !== "undefined") {
      const shared = new Uint8Array(new SharedArrayBuffer(2));
      shared.set([0x0a, 0]);
      const sharedSnapshot = snapshotProtobufInput(shared, 2);
      shared[0] = 0xff;
      expect(sharedSnapshot).toEqual(new Uint8Array([0x0a, 0]));
      expect(sharedSnapshot.buffer).toBeInstanceOf(ArrayBuffer);
    }
  });
});
