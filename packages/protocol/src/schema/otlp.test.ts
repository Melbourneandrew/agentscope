import { describe, expect, it } from "vitest";

import {
  OTLP_GRAPH_LIMITS,
  OtlpAnyValueSchema,
  OtlpResourceSpansSchema,
  OtlpSpanIdSchema,
  OtlpSpanSchema,
  OtlpTraceIdSchema,
} from "./otlp.js";

const validSpan = () => ({
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  name: "fixture",
  kind: 1,
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
});

describe("bounded OTLP producer DTOs", () => {
  it.each([
    { stringValue: "text" },
    { boolValue: true },
    { intValue: "-9223372036854775808" },
    { intValue: "9223372036854775807" },
    { doubleValue: 0.5 },
    { bytesValue: "AQID" },
    {
      arrayValue: {
        values: [
          { stringValue: "text" },
          { intValue: "1" },
          { doubleValue: 0.5 },
        ],
      },
    },
  ])("accepts canonical scalar/simple-array AnyValue %#", (value) => {
    expect(OtlpAnyValueSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    { intValue: "not-an-integer" },
    { intValue: "01" },
    { intValue: "9223372036854775808" },
    { intValue: "-9223372036854775809" },
    { doubleValue: Number.POSITIVE_INFINITY },
    { bytesValue: "not canonical base64!" },
    { stringValue: "x", boolValue: true },
    { kvlistValue: { values: [] } },
    { arrayValue: { values: [{ arrayValue: { values: [] } }] } },
    {
      arrayValue: {
        values: Array.from(
          { length: OTLP_GRAPH_LIMITS.collectionValues + 1 },
          () => ({ boolValue: true }),
        ),
      },
    },
  ])("rejects hostile or non-canonical AnyValue %#", (value) => {
    expect(() => OtlpAnyValueSchema.safeParse(value)).not.toThrow();
    expect(OtlpAnyValueSchema.safeParse(value).success).toBe(false);
  });

  it("rejects cyclic AnyValue without recursing", () => {
    const value: { arrayValue: { values: unknown[] } } = {
      arrayValue: { values: [] },
    };
    value.arrayValue.values.push(value);
    expect(() => OtlpAnyValueSchema.safeParse(value)).not.toThrow();
    expect(OtlpAnyValueSchema.safeParse(value).success).toBe(false);
  });

  it("enforces canonical nonzero lowercase trace and span identities", () => {
    expect(
      OtlpTraceIdSchema.safeParse("0123456789abcdef0123456789abcdef").success,
    ).toBe(true);
    expect(OtlpTraceIdSchema.safeParse("0".repeat(32)).success).toBe(false);
    expect(
      OtlpTraceIdSchema.safeParse("0123456789ABCDEF0123456789ABCDEF").success,
    ).toBe(false);
    expect(OtlpSpanIdSchema.safeParse("0123456789abcdef").success).toBe(true);
    expect(OtlpSpanIdSchema.safeParse("0".repeat(16)).success).toBe(false);
  });

  it("keeps malformed timestamps and integer values total", () => {
    for (const value of ["not-a-time", "-1", "01", "18446744073709551616"]) {
      const span = { ...validSpan(), startTimeUnixNano: value };
      expect(() => OtlpSpanSchema.safeParse(span)).not.toThrow();
      expect(OtlpSpanSchema.safeParse(span).success).toBe(false);
    }
  });

  it("enforces known producer enums, time order, and status-message semantics", () => {
    expect(OtlpSpanSchema.safeParse({ ...validSpan(), kind: 6 }).success).toBe(
      false,
    );
    expect(
      OtlpSpanSchema.safeParse({ ...validSpan(), endTimeUnixNano: "0" })
        .success,
    ).toBe(false);
    expect(
      OtlpSpanSchema.safeParse({ ...validSpan(), status: { code: 3 } }).success,
    ).toBe(false);
    expect(
      OtlpSpanSchema.safeParse({
        ...validSpan(),
        status: { code: 1, message: "not allowed" },
      }).success,
    ).toBe(false);
    expect(
      OtlpSpanSchema.safeParse({
        ...validSpan(),
        status: { code: 2, message: "" },
      }).success,
    ).toBe(false);
    expect(
      OtlpSpanSchema.safeParse({
        ...validSpan(),
        status: { code: 2, message: "fixture error" },
      }).success,
    ).toBe(true);
  });

  it("accepts the bounded ResourceSpans shape and rejects duplicate attributes", () => {
    const resource = {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "agentscope" } },
        ],
      },
      scopeSpans: [{ spans: [validSpan()] }],
    };
    expect(OtlpResourceSpansSchema.safeParse(resource).success).toBe(true);
    resource.resource.attributes.push({
      key: "service.name",
      value: { stringValue: "duplicate" },
    });
    expect(OtlpResourceSpansSchema.safeParse(resource).success).toBe(false);
  });
});
