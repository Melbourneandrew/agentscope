import {
  AGENT_NAME,
  LLM_MODEL_NAME,
  OpenInferenceSpanKind,
  SemanticConventions,
  TOOL_NAME,
} from "@arizeai/openinference-semantic-conventions";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { protocolPackageId, standardsManifest } from "../index.js";

const traceId = "0123456789abcdef0123456789abcdef";
const agentSpanId = "0123456789abcdef";
const llmSpanId = "1111111111111111";
const toolSpanId = "2222222222222222";

const stringAttribute = (key: string, value: string) => ({
  key,
  value: { stringValue: value },
});

const binaryAttribute = (key: string, value: string) => ({
  key,
  value: { bytesValue: value },
});

const kindAttribute = (kind: OpenInferenceSpanKind) =>
  stringAttribute(SemanticConventions.OPENINFERENCE_SPAN_KIND, kind);

const expectCanonicalHexId = (value: string, characterLength: number) => {
  expect(value).toHaveLength(characterLength);
  expect(value).toMatch(/^[0-9a-f]+$/u);
  expect(value).not.toMatch(/^0+$/u);
};

const expectCanonicalBase64Bytes = (value: string) => {
  const decoded = Buffer.from(value, "base64");

  expect(decoded.toString("base64")).toBe(value);
};

// Standards spike for AC-OVR-001.1. The production bounded schema and codecs
// are owned by agentscope-vah.3.2 and agentscope-vah.3.4 respectively.
const prototypeGraph = {
  resourceSpans: [
    {
      resource: {
        attributes: [stringAttribute("service.name", "agentscope")],
      },
      scopeSpans: [
        {
          scope: { name: "@agentscope/protocol", version: "0.1.0" },
          spans: [
            {
              traceId,
              spanId: agentSpanId,
              name: "coding-agent session",
              kind: 1,
              startTimeUnixNano: "1000000000",
              endTimeUnixNano: "4000000000",
              attributes: [
                kindAttribute(OpenInferenceSpanKind.AGENT),
                stringAttribute(AGENT_NAME, "task-orchestrator"),
                binaryAttribute("prototype.bytes", "AQID"),
              ],
              status: { code: 1 },
            },
            {
              traceId,
              spanId: llmSpanId,
              parentSpanId: agentSpanId,
              name: "model response",
              kind: 3,
              startTimeUnixNano: "1500000000",
              endTimeUnixNano: "2500000000",
              attributes: [
                kindAttribute(OpenInferenceSpanKind.LLM),
                stringAttribute(LLM_MODEL_NAME, "example-model"),
              ],
              status: { code: 1 },
            },
            {
              traceId,
              spanId: toolSpanId,
              parentSpanId: agentSpanId,
              name: "read_file",
              kind: 1,
              startTimeUnixNano: "2600000000",
              endTimeUnixNano: "3000000000",
              attributes: [
                kindAttribute(OpenInferenceSpanKind.TOOL),
                stringAttribute(TOOL_NAME, "read_file"),
              ],
              status: { code: 1 },
            },
          ],
        },
      ],
    },
  ],
} as const;

describe("standards baseline", () => {
  it("pins immutable official artifacts and an explicit upgrade policy", () => {
    expect(protocolPackageId).toBe("@agentscope/protocol");
    expect(standardsManifest).toMatchObject({
      manifestVersion: 1,
      manifestId:
        "agentscope-protocol-2_otel-1.60.0_otlp-1.11.0_otel-semconv-1.44.0_openinference-js-2.7.0_profile-2-sha256-682b98c09e5f1e2c5827d2eb06885968d5cd1610c57a2ddc28022d0fdd37165d_identity-1-sha256-2c10f312f8e0bf8e6e040843cf88bc5d384993609a4843038fd8e2ed27d8f66b_extensions-2-sha256-691b475677538ec480cc5db480e4d95a2242c06a0ad5517b34dc8da7000a830c_codec-1-sha256-37cd4d040eab9d914496acd83545ca46e7fa3dd78314aa067407d999e966e278_compatibility-1-sha256-86d3c71d7f25f75da3af52cf46ec4ac1ba104684f55146c87db02c1d8de444ca",
      codecProfile: {
        profileFile: "codec-profile.json",
        profileVersion: 1,
        profileFingerprint:
          "sha256-37cd4d040eab9d914496acd83545ca46e7fa3dd78314aa067407d999e966e278",
      },
      compatibilityProfile: {
        profileFile: "compatibility-profile.json",
        profileVersion: 1,
        profileFingerprint:
          "sha256-86d3c71d7f25f75da3af52cf46ec4ac1ba104684f55146c87db02c1d8de444ca",
      },
      canonicalProfile: {
        semanticDescriptorFile: "semantic-profile.json",
        semanticDescriptorVersion: 2,
        semanticDescriptorFingerprint:
          "sha256-c81f99ac1031c4f2b82e769f080b3a3ff00a5961ad737a78bae3693fc07e22ec",
        timingDescriptorFile: "timing-profile.json",
        timingDescriptorVersion: 1,
        timingDescriptorFingerprint:
          "sha256-93a27c841faad019d03dfe7ccc067995e6673c7ba35986d7a36bac2ad15d420b",
      },
      artifacts: {
        openTelemetrySpecification: {
          release: "v1.60.0",
          commit: "29ae8c7710d2ea52e21a5ff81fb1cd657bcd3306",
        },
        otlpProtocol: {
          release: "v1.11.0",
          commit: "790608c4d51e6ffc12210b541e8514cbed9e91a4",
        },
        openTelemetrySemanticConventions: {
          release: "v1.44.0",
          commit: "e10a930844c6951757a43b849d364f7d056ac32b",
        },
        openInference: {
          semanticConventionsVersion: "2.7.0",
          repositorySnapshot: "553ff3ae420e6b16cae166d6bff48f70ebacef07",
        },
      },
      typescriptLibraries: {
        openInferenceSemanticConventions: {
          version: "2.7.0",
          integrity:
            "sha512-POJ0LN6akXRsZnx5KPOyYY19zzOeBUlKx4Sg8zQCgmL12uCPxygagjfa+xGWf76NvIqwZ0bYzDxjICk5JbxHMw==",
        },
      },
    });
    expect(standardsManifest.compatibility.upgradeProcedure).toHaveLength(5);
    expect(
      standardsManifest.typescriptLibraries.openTelemetrySemanticConventions,
    ).toMatchObject({
      inspectedVersion: "1.43.0",
      role: "not-adopted-source-release-lags",
    });
  });
});

describe("standards shape prototype", () => {
  it("preserves one AGENT with sibling LLM and TOOL spans through JSON serialization", () => {
    const encoded = new TextEncoder().encode(JSON.stringify(prototypeGraph));
    const decoded: unknown = JSON.parse(new TextDecoder().decode(encoded));

    expect(decoded).toEqual(prototypeGraph);
    const spans = prototypeGraph.resourceSpans[0].scopeSpans[0].spans;
    expectCanonicalHexId(traceId, 32);
    for (const span of spans) {
      expectCanonicalHexId(span.spanId, 16);
      if ("parentSpanId" in span) {
        expectCanonicalHexId(span.parentSpanId, 16);
      }
      expect(span.traceId).toBe(traceId);
      expect(Number.isInteger(span.kind)).toBe(true);
      expect(Number.isInteger(span.status.code)).toBe(true);
      expect(span.startTimeUnixNano).toMatch(/^\d+$/u);
      expect(span.endTimeUnixNano).toMatch(/^\d+$/u);
    }
    expect(spans.map(({ kind }) => kind)).toEqual([1, 3, 1]);
    expect(spans.map(({ status }) => status.code)).toEqual([1, 1, 1]);
    expect(
      spans.map((span) => ("parentSpanId" in span ? span.parentSpanId : null)),
    ).toEqual([null, agentSpanId, agentSpanId]);
    const binaryValue =
      prototypeGraph.resourceSpans[0].scopeSpans[0].spans[0].attributes.find(
        ({ key }) => key === "prototype.bytes",
      )?.value;
    expect(binaryValue).toEqual({ bytesValue: "AQID" });
    if (binaryValue !== undefined && "bytesValue" in binaryValue) {
      expectCanonicalBase64Bytes(binaryValue.bytesValue);
    }
    expect(
      spans.flatMap(({ attributes }) =>
        attributes.flatMap(({ key, value }) =>
          key === SemanticConventions.OPENINFERENCE_SPAN_KIND &&
          "stringValue" in value
            ? [value.stringValue]
            : [],
        ),
      ),
    ).toEqual([
      OpenInferenceSpanKind.AGENT,
      OpenInferenceSpanKind.LLM,
      OpenInferenceSpanKind.TOOL,
    ]);
    expect(
      spans.every(
        ({ attributes }) =>
          attributes.filter(
            ({ key }) => key === SemanticConventions.OPENINFERENCE_SPAN_KIND,
          ).length === 1,
      ),
    ).toBe(true);
  });

  it("uses OpenInference fields without inventing Agentscope duplicates", () => {
    const keys = prototypeGraph.resourceSpans[0].scopeSpans[0].spans.flatMap(
      ({ attributes }) => attributes.map(({ key }) => key),
    );

    expect(keys).toContain(AGENT_NAME);
    expect(keys).toContain(LLM_MODEL_NAME);
    expect(keys).toContain(TOOL_NAME);
    expect(keys.some((key) => key.startsWith("agentscope."))).toBe(false);
  });
});
