import { describe, expect, it } from "vitest";

import {
  encodeOtlpJson,
  type OtlpResourceSpans,
  type OtlpSpan,
} from "@agentscope/protocol";
import { createSanitizedRedactedCanonicalTraceFixture } from "@agentscope/protocol/testing";

import {
  appendLangfuseGraphCapsule,
  deriveLangfuseCapsuleSpanId,
  LangfuseCapsuleError,
  LANGFUSE_CAPSULE_CONTRACT,
} from "./capsule.js";

type MutableResource = Omit<OtlpResourceSpans, "scopeSpans"> & {
  scopeSpans: {
    scope?: OtlpResourceSpans["scopeSpans"][number]["scope"];
    schemaUrl?: string;
    spans: OtlpSpan[];
  }[];
};

const resource = (): MutableResource => {
  const trace = createSanitizedRedactedCanonicalTraceFixture();
  return (
    JSON.parse(encodeOtlpJson(trace)) as {
      resourceSpans: MutableResource[];
    }
  ).resourceSpans[0]!;
};

describe("Langfuse graph capsule", () => {
  it("derives domain-separated deterministic header and carrier IDs", () => {
    const traceId = "0123456789abcdef0123456789abcdef";
    const nonce = "1".repeat(32);
    const header = deriveLangfuseCapsuleSpanId(traceId, nonce, "header", 0);
    expect(header).toMatch(/^[\da-f]{16}$/u);
    expect(deriveLangfuseCapsuleSpanId(traceId, nonce, "header", 0)).toBe(
      header,
    );
    expect(deriveLangfuseCapsuleSpanId(traceId, nonce, "carrier", 0)).not.toBe(
      header,
    );
    expect(deriveLangfuseCapsuleSpanId(traceId, nonce, "carrier", 1)).not.toBe(
      header,
    );
  });

  it("moves only Langfuse projection fields to one closed capsule scope", () => {
    const value = resource();
    const root = value.scopeSpans
      .flatMap((scope) => scope.spans)
      .find((span) => span.parentSpanId === undefined)!;
    root.attributes = [
      ...(root.attributes ?? []),
      {
        key: "langfuse.observation.metadata.agentscope_root",
        value: { stringValue: "true" },
      },
    ];
    const result = appendLangfuseGraphCapsule(value, '{"resourceSpans":[]}');
    expect(result.nonce).toMatch(/^[\da-f]{32}$/u);
    expect(result.carrierCount).toBe(1);
    expect(root.attributes).not.toContainEqual(
      expect.objectContaining({
        key: "langfuse.observation.metadata.agentscope_root",
      }),
    );
    const scope = result.resourceSpans.scopeSpans[0]!;
    expect(scope.scope?.name).toBe(LANGFUSE_CAPSULE_CONTRACT.scopeName);
    expect(scope.spans.map((span) => span.name)).toEqual([
      LANGFUSE_CAPSULE_CONTRACT.headerName,
      LANGFUSE_CAPSULE_CONTRACT.carrierName,
    ]);
    expect(
      result.resourceSpans.resource?.attributes?.map(({ key }) => key),
    ).toEqual(["agentscope.protocol.manifest_id", "service.name"]);
    expect(result.resourceSpans.resource?.droppedAttributesCount).toBe(0);
  });

  it("supports an attribute-free root without inventing a session", () => {
    const value = resource();
    delete value.resource;
    const root = value.scopeSpans
      .flatMap((scope) => scope.spans)
      .find((span) => span.parentSpanId === undefined)!;
    delete root.attributes;
    const result = appendLangfuseGraphCapsule(value, "{}");
    const header = result.resourceSpans.scopeSpans[0]!.spans[0]!;
    expect(header.attributes).not.toContainEqual(
      expect.objectContaining({ key: "session.id" }),
    );
    expect(result.resourceSpans.resource?.attributes).toEqual([]);
  });

  it.each(["", "x".repeat(LANGFUSE_CAPSULE_CONTRACT.maximumGraphBytes + 1)])(
    "rejects a graph outside the exact byte bound",
    (graphJson) => {
      expect(() =>
        appendLangfuseGraphCapsule(resource(), graphJson),
      ).toThrowError(LangfuseCapsuleError);
    },
  );

  it.each([
    LANGFUSE_CAPSULE_CONTRACT.maximumGraphBytes - 1,
    LANGFUSE_CAPSULE_CONTRACT.maximumGraphBytes,
  ])("binds the exact graph/chunk/carrier formula at %i bytes", (bytes) => {
    const value = resource();
    const result = appendLangfuseGraphCapsule(value, "x".repeat(bytes));
    const encodedCharacters = Math.ceil((bytes * 8) / 6);
    const chunks = Math.ceil(
      encodedCharacters / LANGFUSE_CAPSULE_CONTRACT.chunkCharacters,
    );
    const carriers = Math.ceil(
      chunks / LANGFUSE_CAPSULE_CONTRACT.maximumChunksPerCarrier,
    );
    expect(result.carrierCount).toBe(carriers);
    expect(carriers).toBe(LANGFUSE_CAPSULE_CONTRACT.maximumCarriers);
    const carrierSpans = result.resourceSpans.scopeSpans[0]!.spans.slice(1);
    expect(carrierSpans).toHaveLength(carriers);
    expect(
      carrierSpans.flatMap((span) => {
        const attribute = span.attributes?.find((entry) =>
          entry.key.endsWith(LANGFUSE_CAPSULE_CONTRACT.keys.chunks),
        );
        if (attribute === undefined || !("arrayValue" in attribute.value))
          throw new Error("capsule fixture lacks chunks");
        return attribute.value.arrayValue.values;
      }),
    ).toHaveLength(chunks);
  });

  it("rejects missing and ambiguous canonical roots", () => {
    const missing = resource();
    for (const span of missing.scopeSpans.flatMap((scope) => scope.spans))
      span.parentSpanId = "0123456789abcdef";
    expect(() => appendLangfuseGraphCapsule(missing, "{}")).toThrowError(
      LangfuseCapsuleError,
    );
    const duplicate = resource();
    const spans = duplicate.scopeSpans.flatMap((scope) => scope.spans);
    delete spans[1]!.parentSpanId;
    expect(() => appendLangfuseGraphCapsule(duplicate, "{}")).toThrowError(
      LangfuseCapsuleError,
    );
  });
});
