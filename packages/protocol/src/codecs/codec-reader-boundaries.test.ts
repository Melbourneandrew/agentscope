import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import canonicalFixture from "../testing/fixtures/sanitized-canonical-trace.json" with { type: "json" };
import {
  ExportTraceServiceRequestSchema,
  ExportTracePartialSuccessSchema,
  ExportTraceServiceResponseSchema,
} from "../generated/otlp/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";
import { standardsManifest } from "../standards/manifest.js";
import { CODEC_PROFILE } from "./codec-profile.js";
import { parseBoundedJson } from "./json-parser.js";
import { protobufMessageFromParsedJson } from "./json-to-protobuf.js";
import {
  readExternalOtlpJson,
  readExternalOtlpProtobuf,
} from "./otlp-reader.js";
import {
  readOtlpExportJsonResponse,
  readOtlpExportProtobufResponse,
} from "./otlp-response.js";
import { readPersistedCanonicalEnvelope } from "./persisted-reader.js";

const graphJson = () =>
  structuredClone({ resourceSpans: canonicalFixture.resourceSpans });

const envelope = () => ({
  envelopeVersion: 1,
  protocolManifestId: standardsManifest.manifestId,
  delivery: {
    identity: "ab".repeat(32),
    stability: "session-stable",
  },
  graph: graphJson(),
});

describe("external OTLP trace dispositions", () => {
  it("rejects an over-budget request as one invalid read", () => {
    const resources = Array.from(
      {
        length: CODEC_PROFILE.externalReceiver.budgets.maximumResourceSpans + 1,
      },
      () => ({}),
    );
    expect(
      readExternalOtlpJson(JSON.stringify({ resourceSpans: resources })),
    ).toEqual({ ok: false, code: "protocol.reader.invalid" });
  });

  it("returns separate invalid and unsupported trace units in one batch", () => {
    const request = graphJson();
    const spans = request.resourceSpans[0]!.scopeSpans[0]!.spans;
    const invalid = structuredClone(spans[0]!);
    invalid.traceId = "aa".repeat(16);
    invalid.spanId = "00".repeat(8);
    const unsupported = structuredClone(spans[0]!);
    unsupported.traceId = "bb".repeat(16);
    unsupported.spanId = "cc".repeat(8);
    unsupported.attributes.push({
      key: "input.value",
      value: { kvlistValue: { values: [] } },
    } as never);
    spans.push(invalid, unsupported);
    const result = readExternalOtlpJson(JSON.stringify(request));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.batch.units.map((unit) => unit.status)).toEqual([
        "canonical",
        "rejected",
        "rejected",
      ]);
      expect(result.batch.units.slice(1)).toEqual([
        { status: "rejected", reason: "invalid" },
        { status: "rejected", reason: "unsupported" },
      ]);
    }
  });

  it("rejects a trace split across resource or scope ownership", () => {
    const request = graphJson();
    const duplicate = structuredClone(request.resourceSpans[0]!);
    duplicate.scopeSpans[0]!.spans = [
      structuredClone(request.resourceSpans[0]!.scopeSpans[0]!.spans[0]!),
    ];
    request.resourceSpans.push(duplicate);
    const result = readExternalOtlpJson(JSON.stringify(request));
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.batch.units).toEqual([
        { status: "rejected", reason: "invalid" },
      ]);
  });

  it("omits non-Profiling string-table references without rejecting the trace as unsupported", () => {
    const request = graphJson();
    const attributes =
      request.resourceSpans[0]!.scopeSpans[0]!.spans[1]!.attributes;
    const input = attributes.find(({ key }) => key === "llm.model_name");
    if (input === undefined) throw new Error("fixture");
    input.value = { stringValueStrindex: 1 } as never;
    const json = JSON.stringify(request);
    const protobuf = toBinary(
      ExportTraceServiceRequestSchema,
      protobufMessageFromParsedJson(
        ExportTraceServiceRequestSchema,
        parseBoundedJson(json, {
          maximumBytes: 4_194_304,
          maximumDepth: 24,
          maximumNodes: 262_144,
          maximumObjectKeys: 1_024,
          maximumArrayItems: 65_536,
          maximumStringBytes: 65_536,
        }),
      ),
    );
    for (const result of [
      readExternalOtlpJson(json),
      readExternalOtlpProtobuf(protobuf),
    ]) {
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.batch.units).not.toContainEqual({
          status: "rejected",
          reason: "unsupported",
        });
    }
  });

  it("classifies nonfinite governed AnyValue as trace-local unsupported", () => {
    const request = graphJson();
    const attributes =
      request.resourceSpans[0]!.scopeSpans[0]!.spans[1]!.attributes;
    const input = attributes.find(({ key }) => key === "llm.model_name");
    if (input === undefined) throw new Error("fixture");
    input.value = { doubleValue: "NaN" } as never;
    const result = readExternalOtlpJson(JSON.stringify(request));
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.batch.units).toContainEqual({
        status: "rejected",
        reason: "unsupported",
      });
  });
});

describe("OTLP response structural reading", () => {
  it("distinguishes absent, rejected, warning, and malformed responses", () => {
    expect(readOtlpExportJsonResponse("{}")).toMatchObject({
      ok: true,
      response: {
        partialSuccessPresent: false,
        rejectedSpans: "0",
        warningPresent: false,
      },
    });
    expect(
      readOtlpExportJsonResponse(
        '{"partialSuccess":{"rejectedSpans":"2","errorMessage":"ignored"}}',
      ),
    ).toMatchObject({
      ok: true,
      response: {
        partialSuccessPresent: true,
        rejectedSpans: "2",
        warningPresent: false,
      },
    });
    expect(
      readOtlpExportJsonResponse('{"partialSuccess":{"rejectedSpans":"-1"}}'),
    ).toEqual({ ok: false, code: "protocol.reader.invalid" });
    expect(readOtlpExportJsonResponse("{")).toEqual({
      ok: false,
      code: "protocol.reader.invalid",
    });
    expect(
      readOtlpExportProtobufResponse(new Uint8Array([0x0a, 0x80])),
    ).toEqual({ ok: false, code: "protocol.reader.invalid" });
    const rejected = create(ExportTraceServiceResponseSchema, {
      partialSuccess: create(ExportTracePartialSuccessSchema, {
        rejectedSpans: 2n,
      }),
    });
    expect(
      readOtlpExportProtobufResponse(
        toBinary(ExportTraceServiceResponseSchema, rejected),
      ),
    ).toMatchObject({ ok: true, response: { rejectedSpans: "2" } });
    expect(
      readOtlpExportProtobufResponse(
        new Uint8Array([0x0a, 0x02, 0x08, 0x02, 0x0a, 0x03, 0x12, 0x01, 0x78]),
      ),
    ).toMatchObject({
      ok: true,
      response: { rejectedSpans: "2", warningPresent: false },
    });
  });
});

describe("persisted envelope version dispatch", () => {
  it("rejects every malformed authority field and canonical graph", () => {
    const cases: unknown[] = [
      null,
      [],
      { ...envelope(), envelopeVersion: "1" },
      { ...envelope(), envelopeVersion: 1.5 },
      { ...envelope(), delivery: null },
      {
        ...envelope(),
        delivery: { identity: "ab", stability: "session-stable" },
      },
      {
        ...envelope(),
        delivery: { identity: "00".repeat(32), stability: "session-stable" },
      },
      {
        ...envelope(),
        delivery: { identity: "AB".repeat(32), stability: "session-stable" },
      },
      {
        ...envelope(),
        delivery: { identity: "ab".repeat(32), stability: "future" },
      },
      { ...envelope(), graph: { resourceSpans: [] } },
    ];
    for (const value of cases)
      expect(readPersistedCanonicalEnvelope(JSON.stringify(value))).toEqual({
        ok: false,
        code: "protocol.reader.invalid",
      });
    const nonfiniteGraph = JSON.stringify(envelope()).replace(
      '"kind":1',
      '"kind":1e999',
    );
    expect(readPersistedCanonicalEnvelope(nonfiniteGraph)).toEqual({
      ok: false,
      code: "protocol.reader.invalid",
    });
  });

  it("separates unsupported version or manifest from malformed input", () => {
    for (const value of [
      { ...envelope(), envelopeVersion: 2 },
      { ...envelope(), protocolManifestId: "future" },
    ]) {
      expect(readPersistedCanonicalEnvelope(JSON.stringify(value))).toEqual({
        ok: false,
        code: "protocol.reader.unsupported",
      });
    }
    const oversized = `"${"x".repeat(CODEC_PROFILE.persistedEnvelopeReader.maximumBytes)}"`;
    expect(readPersistedCanonicalEnvelope(oversized)).toEqual({
      ok: false,
      code: "protocol.reader.invalid",
    });
  });
});
