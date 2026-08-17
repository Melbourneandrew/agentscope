import { create, toBinary } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import canonicalFixture from "../testing/fixtures/sanitized-canonical-trace.json" with { type: "json" };
import historicalV1Fixture from "../testing/fixtures/history/sanitized-canonical-trace-v1.json" with { type: "json" };
import historicalV1Manifest from "../standards/history/manifest-v1.json" with { type: "json" };
import {
  ExportTraceServiceRequestSchema,
  ExportTracePartialSuccessSchema,
  ExportTraceServiceResponseSchema,
} from "../generated/otlp/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";
import { deriveIdentityBundle } from "../schema/identity.js";
import { SUPPORTED_PROTOCOL_GENERATIONS } from "../schema/compatibility-profile.js";
import { finalizeRedactedCanonicalTrace } from "../schema/redacted-finalization.js";
import {
  isRedactedCanonicalTrace,
  serializeRedactedCanonicalTrace,
} from "../schema/redacted-envelope.js";
import { standardsManifest } from "../standards/manifest.js";
import {
  CODEC_PROFILE,
  codecProfileBehaviorIsValidForTesting,
  validateCodecProfile,
} from "./codec-profile.js";
import {
  encodeOtlpJson,
  encodeOtlpProtobuf,
  otlpRequestForGraphForTesting,
} from "./otlp-producer.js";
import type { CanonicalTraceGraph } from "../schema/canonical-graph.js";
import {
  readExternalOtlpJson,
  readExternalOtlpProtobuf,
} from "./otlp-reader.js";
import {
  readOtlpExportJsonResponse,
  readOtlpExportProtobufResponse,
} from "./otlp-response.js";
import {
  readPersistedCanonicalEnvelope,
  SUPPORTED_PERSISTED_MANIFEST_IDS,
} from "./persisted-reader.js";
import {
  PERSISTED_ENVELOPE_SOURCE_SCHEMA_DESCRIPTOR,
  validatePersistedSourceSchemaDescriptorForTesting,
} from "./persisted-source.js";
import { preflightProtobufMessage } from "./protobuf-preflight.js";

const identityBundle = () =>
  deriveIdentityBundle({
    harnessRegistryId: "codex",
    session: {
      kind: "native-session",
      nativeIdentityKind: "thread",
      nativeIdentity: "codec-fixture-session",
    },
    boundary: {
      kind: "turn",
      id: "codec-fixture-boundary",
      generation: 1,
      positionKind: "event-index",
      exclusiveEndPosition: 3,
    },
    operationIdScope: "session-global",
    operations: [
      { logicalKey: "root", locator: { kind: "source-ordinal", ordinal: 0 } },
      {
        logicalKey: "model",
        parentLogicalKey: "root",
        locator: { kind: "native-operation", nativeId: "model-1" },
      },
      {
        logicalKey: "tool",
        parentLogicalKey: "root",
        locator: { kind: "native-operation", nativeId: "tool-1" },
      },
    ],
  });

const brandedFixture = () => {
  const bundle = identityBundle();
  const fixture = structuredClone(canonicalFixture);
  const spans = fixture.resourceSpans[0]!.scopeSpans[0]!.spans;
  const keys = ["root", "model", "tool"] as const;
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!;
    span.traceId = bundle.traceId;
    span.spanId = bundle.spans[keys[index]!]!;
    if (index > 0) span.parentSpanId = bundle.spans.root!;
    Object.assign(span, { logicalOperationKey: keys[index] });
    const provenance = span.attributes?.find(
      ({ key }) => key === "agentscope.mapping.provenance",
    );
    if (provenance === undefined || !("stringValue" in provenance.value))
      throw new Error("fixture");
    const ledger = JSON.parse(provenance.value.stringValue) as {
      field: string;
      source: string;
    }[];
    for (const entry of ledger) {
      if (
        entry.field === "span.trace_id" ||
        entry.field === "span.span_id" ||
        entry.field === "span.parent_span_id"
      )
        entry.source = "derived";
    }
    provenance.value.stringValue = JSON.stringify(ledger);
  }
  return finalizeRedactedCanonicalTrace({
    identityBundle: bundle,
    graph: fixture,
  });
};

const markerlessFeedbackGraph = (
  scope: "span" | "trace" | "session",
  kind: "EVALUATOR" | "TOOL",
  standalone = true,
) => {
  const value = structuredClone(canonicalFixture) as CanonicalTraceGraph;
  const allSpans = value.resourceSpans[0]!.scopeSpans[0]!.spans;
  const carrier = standalone ? allSpans[0]! : allSpans[2]!;
  if (standalone) allSpans.splice(1);
  const kindAttribute = carrier.attributes!.find(
    ({ key }) => key === "openinference.span.kind",
  )!;
  kindAttribute.value = { stringValue: kind };
  carrier.links = [];
  const prefix = scope === "span" ? "" : `${scope}.`;
  const noun = scope === "trace" ? "evaluation" : "annotation";
  const plural = `${noun}s`;
  const feedbackKeys = [
    `${prefix}${plural}.7.${noun}.name`,
    `${prefix}${plural}.7.${noun}.label`,
    `${prefix}${plural}.7.${noun}.annotator_kind`,
  ];
  carrier.attributes!.push(
    { key: feedbackKeys[0]!, value: { stringValue: "quality" } },
    { key: feedbackKeys[1]!, value: { stringValue: "good" } },
    { key: feedbackKeys[2]!, value: { stringValue: "CUSTOM_REVIEWER" } },
  );
  if (scope === "session") {
    feedbackKeys.push("session.id");
    carrier.attributes!.push({
      key: "session.id",
      value: { stringValue: "session-123" },
    });
  }
  const provenanceAttribute = carrier.attributes!.find(
    ({ key }) => key === "agentscope.mapping.provenance",
  )!;
  const provenanceValue = provenanceAttribute.value;
  if (!("stringValue" in provenanceValue)) throw new Error("fixture ledger");
  const rootOnly = new Set([
    "agentscope.harness.name",
    "agentscope.harness.version",
    "agentscope.workspace.directory",
    "agentscope.git.worktree",
    "agentscope.git.repository_root",
  ]);
  let ledger = JSON.parse(provenanceValue.stringValue) as {
    field: string;
    source: string;
  }[];
  if (standalone) {
    carrier.attributes = carrier.attributes!.filter(
      ({ key }) =>
        !rootOnly.has(key) && key !== "agentscope.mapping.unavailable",
    );
    ledger = ledger.filter(
      ({ field }) =>
        !rootOnly.has(field) &&
        field !== "family.error.activity" &&
        field !== "family.tool.activity",
    );
  }
  ledger.push(
    ...feedbackKeys.map((field) => ({
      field,
      source: "native-artifact",
    })),
  );
  ledger.sort((left, right) => (left.field < right.field ? -1 : 1));
  provenanceAttribute.value = { stringValue: JSON.stringify(ledger) };
  carrier.attributes!.sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
  return value;
};

describe("manifest-pinned OTLP producer codecs", () => {
  it("encodes only a runtime-branded graph with stable JSON and protobuf", () => {
    const trace = brandedFixture();
    const json = encodeOtlpJson(trace);
    const protobuf = encodeOtlpProtobuf(trace);
    preflightProtobufMessage(protobuf, ExportTraceServiceRequestSchema, {
      maximumBytes: 4_194_304,
      maximumDepth: 24,
      maximumFields: 262_144,
      maximumLengthDelimitedBytes: 4_194_304,
    });
    expect(json).toBe(encodeOtlpJson(trace));
    expect(protobuf).toEqual(encodeOtlpProtobuf(trace));
    expect(JSON.parse(json)).toEqual({
      resourceSpans: trace.graph.resourceSpans,
    });
    expect(createHash("sha256").update(protobuf).digest("hex")).toBe(
      "bffcb41f92220e751334ff5cbe86871a327118ef137ddc78d8f5a009a6383b35",
    );
    expect(() => encodeOtlpJson(structuredClone(trace))).toThrowError(
      "protocol.codec.invalid",
    );
    expect(() => encodeOtlpProtobuf(trace.graph as never)).toThrowError(
      "protocol.codec.invalid",
    );
  });

  it("round-trips into a distinct unbranded external batch", () => {
    const trace = brandedFixture();
    for (const result of [
      readExternalOtlpJson(encodeOtlpJson(trace)),
      readExternalOtlpProtobuf(encodeOtlpProtobuf(trace)),
    ]) {
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.batch.units).toHaveLength(1);
      const unit = result.batch.units[0]!;
      expect(unit.status).toBe("canonical");
      if (unit.status === "canonical") {
        expect(unit.graph).toEqual(trace.graph);
        expect(isRedactedCanonicalTrace(unit.graph)).toBe(false);
      }
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.batch.units)).toBe(true);
    }
    const protobuf = encodeOtlpProtobuf(trace);
    const withUnknown = new Uint8Array(protobuf.length + 2);
    withUnknown.set(protobuf);
    withUnknown.set([0x78, 1], protobuf.length);
    expect(readExternalOtlpProtobuf(withUnknown)).toEqual(
      readExternalOtlpProtobuf(protobuf),
    );
    const withUnknownGroup = new Uint8Array(protobuf.length + 2);
    withUnknownGroup.set(protobuf);
    withUnknownGroup.set([0x7b, 0x7c], protobuf.length);
    expect(readExternalOtlpProtobuf(withUnknownGroup)).toEqual(
      readExternalOtlpProtobuf(protobuf),
    );
  });
});

describe("bounded tolerant OTLP readers", () => {
  it("accepts markerless upstream feedback in JSON and protobuf without classifying transport", () => {
    const cases = [
      markerlessFeedbackGraph("span", "EVALUATOR"),
      markerlessFeedbackGraph("trace", "TOOL"),
      markerlessFeedbackGraph("session", "EVALUATOR"),
      markerlessFeedbackGraph("span", "TOOL", false),
    ];
    for (const graph of cases) {
      const request = otlpRequestForGraphForTesting(graph);
      for (const result of [
        readExternalOtlpJson(
          JSON.stringify({ resourceSpans: graph.resourceSpans }),
        ),
        readExternalOtlpProtobuf(
          toBinary(ExportTraceServiceRequestSchema, request),
        ),
      ]) {
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        const unit = result.batch.units[0]!;
        expect(unit.status).toBe("canonical");
        if (unit.status !== "canonical") continue;
        expect(JSON.stringify(unit.graph)).not.toContain(
          "agentscope.feedback.transport",
        );
      }
    }
  });

  it("normalizes case-insensitive identities and exact exponent integers", () => {
    const trace = brandedFixture();
    const parsed = JSON.parse(encodeOtlpJson(trace)) as {
      resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    };
    const span = parsed.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    span.traceId = String(span.traceId).toUpperCase();
    span.spanId = String(span.spanId).toUpperCase();
    span.startTimeUnixNano = 1e9;
    span.endTimeUnixNano = "4e9";
    const result = readExternalOtlpJson(JSON.stringify(parsed));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const unit = result.batch.units[0]!;
      expect(unit.status).toBe("canonical");
      if (unit.status === "canonical") {
        const normalized =
          unit.graph.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
        expect(normalized.traceId).toBe(String(span.traceId).toLowerCase());
        expect(normalized.spanId).toBe(String(span.spanId).toLowerCase());
        expect(normalized.startTimeUnixNano).toBe("1000000000");
        expect(normalized.endTimeUnixNano).toBe("4000000000");
      }
    }
  });

  it("ignores unknown names, uses last duplicate, and rejects known snake-case aliases", () => {
    const json = encodeOtlpJson(brandedFixture());
    for (const key of ["futureField", "future_field"]) {
      const withUnknown = json.replace("{", `{"${key}":{"x":1},`);
      expect(readExternalOtlpJson(withUnknown).ok).toBe(true);
    }
    const duplicate = json.replace("{", '{"resourceSpans":[],');
    expect(readExternalOtlpJson(duplicate)).toEqual(readExternalOtlpJson(json));
    expect(readExternalOtlpJson('{"resource_spans":[]}')).toEqual({
      ok: false,
      code: "protocol.reader.invalid",
    });
  });

  it("fails safely for malformed, hostile, deep, and oversized inputs", () => {
    const maximum = CODEC_PROFILE.externalReceiver.budgets.maximumJsonBytes;
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error("CANARY_SECRET");
        },
      },
    );
    for (const value of [
      null,
      hostile,
      new Uint8Array([0x0a, 0x80]),
      '{"x":"\\ud800"}',
      `[${"[".repeat(30)}0${"]".repeat(30)}]`,
      `"${"x".repeat(maximum)}"`,
    ]) {
      const json = readExternalOtlpJson(value);
      const protobuf = readExternalOtlpProtobuf(value);
      expect(JSON.stringify([json, protobuf])).not.toContain("CANARY_SECRET");
    }
    expect(readExternalOtlpProtobuf(new Uint8Array([0x0a, 0x80]))).toEqual({
      ok: false,
      code: "protocol.reader.invalid",
    });
  });

  it("is total over deterministic arbitrary bytes and JSON token streams", () => {
    let state = 0x9e37_79b9;
    const next = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state & 255;
    };
    for (let iteration = 0; iteration < 256; iteration += 1) {
      const bytes = Uint8Array.from({ length: iteration % 65 }, () => next());
      const json = String.fromCharCode(...bytes);
      for (const result of [
        readExternalOtlpProtobuf(bytes),
        readExternalOtlpJson(json),
      ]) {
        expect(Object.isFrozen(result)).toBe(true);
        expect(JSON.stringify(result)).not.toContain("Error");
      }
    }
  });
});

describe("persisted envelope and response readers", () => {
  it("reads the current exact manifest into an unbranded frozen value", () => {
    const trace = brandedFixture();
    const result = readPersistedCanonicalEnvelope(
      serializeRedactedCanonicalTrace(trace),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope).toEqual(trace);
      expect(isRedactedCanonicalTrace(result.envelope)).toBe(false);
      expect(Object.isFrozen(result.envelope.graph)).toBe(true);
    }
    const unknown = JSON.parse(
      serializeRedactedCanonicalTrace(trace),
    ) as Record<string, unknown>;
    unknown.protocolManifestId = "agentscope-protocol-unknown";
    expect(readPersistedCanonicalEnvelope(JSON.stringify(unknown))).toEqual({
      ok: false,
      code: "protocol.reader.unsupported",
    });
    unknown.protocolManifestId = standardsManifest.manifestId;
    unknown.extra = true;
    expect(readPersistedCanonicalEnvelope(JSON.stringify(unknown))).toEqual({
      ok: false,
      code: "protocol.reader.invalid",
    });
  });

  it("migrates the exact v1 source freshly without fabricating feedback", () => {
    const source = {
      envelopeVersion: 1,
      protocolManifestId: historicalV1Manifest.manifestId,
      delivery: {
        identity: "ab".repeat(32),
        stability: "session-stable",
      },
      graph: historicalV1Fixture,
    };
    const result = readPersistedCanonicalEnvelope(JSON.stringify(source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.protocolManifestId).toBe(
      standardsManifest.manifestId,
    );
    expect(result.envelope.graph).toEqual(canonicalFixture);
    expect(result.envelope.graph).not.toBe(source.graph);
    expect(JSON.stringify(result.envelope.graph)).not.toMatch(
      /(?:annotations|evaluations)\./u,
    );

    const hostile = structuredClone(source);
    hostile.graph.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes.push({
      key: "annotations.0.annotation.name",
      value: { stringValue: "fabricated" },
    });
    expect(readPersistedCanonicalEnvelope(JSON.stringify(hostile))).toEqual({
      ok: false,
      code: "protocol.reader.invalid",
    });
    const wrongScope = structuredClone(source);
    wrongScope.graph.resourceSpans[0]!.scopeSpans[0]!.scope.version = "2";
    expect(readPersistedCanonicalEnvelope(JSON.stringify(wrongScope))).toEqual({
      ok: false,
      code: "protocol.reader.invalid",
    });
  });
});

describe("response readers and codec profile", () => {
  it("decodes response structure without exposing the error message", () => {
    const response = create(ExportTraceServiceResponseSchema, {
      partialSuccess: create(ExportTracePartialSuccessSchema, {
        rejectedSpans: 0n,
        errorMessage: "CANARY_SECRET",
      }),
    });
    const protobuf = toBinary(ExportTraceServiceResponseSchema, response);
    for (const result of [
      readOtlpExportProtobufResponse(protobuf),
      readOtlpExportJsonResponse(
        '{"partialSuccess":{"rejectedSpans":"0","errorMessage":"CANARY_SECRET"}}',
      ),
    ]) {
      expect(result).toEqual({
        ok: true,
        response: {
          kind: "otlp-export-response",
          partialSuccessPresent: true,
          rejectedSpans: "0",
          warningPresent: true,
        },
      });
      expect(JSON.stringify(result)).not.toContain("CANARY_SECRET");
    }
  });

  it("binds codec behavior and supply-chain material to the manifest", () => {
    expect(Object.isFrozen(CODEC_PROFILE)).toBe(true);
    expect(() => {
      validateCodecProfile({
        ...CODEC_PROFILE,
        producer: { ...CODEC_PROFILE.producer, input: "untrusted" },
      });
    }).toThrowError("protocol.codec.profile.invalid");
    expect(CODEC_PROFILE.persistedEnvelopeReader.supportedManifests).toEqual([
      {
        selector: "manifest",
        envelopeVersion: 1,
        migration: "v1-to-v2-strict-feedback-empty",
      },
      {
        selector: "current",
        envelopeVersion: 1,
        migration: "identity-strict-v2",
      },
    ]);
    expect(() => {
      validateCodecProfile({
        ...CODEC_PROFILE,
        persistedEnvelopeReader: {
          ...CODEC_PROFILE.persistedEnvelopeReader,
          supportedManifests: [
            {
              selector: "numeric-range",
              envelopeVersion: 1,
              migration: "identity-strict-v1",
            },
          ],
        },
      });
    }).toThrowError("protocol.codec.profile.invalid");
    const mutations = [
      {
        ...CODEC_PROFILE,
        response: { ...CODEC_PROFILE.response, errorMessage: "echo" },
      },
      {
        ...CODEC_PROFILE,
        externalReceiver: {
          ...CODEC_PROFILE.externalReceiver,
          unknownJsonFields: "reject",
        },
      },
      {
        ...CODEC_PROFILE,
        externalReceiver: {
          ...CODEC_PROFILE.externalReceiver,
          json: {
            ...CODEC_PROFILE.externalReceiver.json,
            invalidUtf8: "replace",
          },
        },
      },
      {
        ...CODEC_PROFILE,
        producer: {
          ...CODEC_PROFILE.producer,
          json: { ...CODEC_PROFILE.producer.json, bytes: "urlsafe" },
        },
      },
    ];
    for (const mutation of mutations)
      expect(codecProfileBehaviorIsValidForTesting(mutation)).toBe(false);
    expect(codecProfileBehaviorIsValidForTesting(null)).toBe(false);
    expect(codecProfileBehaviorIsValidForTesting(CODEC_PROFILE)).toBe(true);
  });
});

describe("persisted source descriptor", () => {
  it("rejects coordinated load-bearing policy mutations", () => {
    expect(SUPPORTED_PERSISTED_MANIFEST_IDS).toEqual(
      SUPPORTED_PROTOCOL_GENERATIONS.map(({ manifestId }) => manifestId),
    );
    expect(
      validatePersistedSourceSchemaDescriptorForTesting(
        PERSISTED_ENVELOPE_SOURCE_SCHEMA_DESCRIPTOR,
      ),
    ).toBe(PERSISTED_ENVELOPE_SOURCE_SCHEMA_DESCRIPTOR);
    for (const mutation of [
      { deliveryIdentityAllZero: "accept" },
      { unknownFields: "accept" },
      { manifestBinding: "outer-only" },
      { graphValidation: "tolerant" },
      { canonicalProfileFingerprint: `sha256-${"00".repeat(32)}` },
    ]) {
      const descriptor = structuredClone(
        PERSISTED_ENVELOPE_SOURCE_SCHEMA_DESCRIPTOR,
      ) as Record<string, unknown> & {
        envelope: Record<string, unknown>;
      };
      if ("deliveryIdentityAllZero" in mutation)
        descriptor.envelope.deliveryIdentityAllZero =
          mutation.deliveryIdentityAllZero;
      else Object.assign(descriptor, mutation);
      expect(() =>
        validatePersistedSourceSchemaDescriptorForTesting(descriptor),
      ).toThrowError("protocol.persisted-source.invalid");
    }
  });
});
