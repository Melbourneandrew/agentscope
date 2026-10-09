import { createHash } from "node:crypto";

import { LANGFUSE_COMPATIBILITY_MANIFEST } from "@agentscope/destination-langfuse";
import { createLangfuseReporterTestHarness } from "@agentscope/destination-langfuse/testing";
import {
  safeParseCanonicalTraceGraph,
  type CanonicalTraceGraph,
  type OtlpKeyValue,
} from "@agentscope/protocol";
import { createSanitizedRedactedCanonicalTraceFixture } from "@agentscope/protocol/testing";
import { describe, expect, it } from "vitest";

import {
  observeSelectedWriterOtlp,
  type SelectedOtlpExpectation,
} from "./selected-otlp-observation.js";

const capsule = LANGFUSE_COMPATIBILITY_MANIFEST.capsule;
const prefix =
  LANGFUSE_COMPATIBILITY_MANIFEST.projection.wire.observationMetadataPrefix;
const options = {
  sessionId: "held-session",
  harnessName: "claude-code",
  modelName: "held-model",
};
const text = (attribute: OtlpKeyValue) => {
  if (!("stringValue" in attribute.value)) throw new Error("fixture-string");
  return attribute.value.stringValue;
};
const field = (attributes: OtlpKeyValue[], key: string) => {
  const result = attributes.find((attribute) => attribute.key === key);
  if (result === undefined) throw new Error("fixture-field");
  return result;
};

// Start with actual production-writer bytes. The absent-model variant is an
// explicitly synthetic canonical fixture transformation, not a native run.
const fixture = async (absent = false, ledger = true) => {
  let body: Buffer | undefined;
  const reporter = createLangfuseReporterTestHarness({
    executor: (request) => {
      body = Buffer.from(request.body!);
      return Promise.resolve({
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from("{}"),
      });
    },
  });
  await expect(reporter.report({ trace: options })).resolves.toEqual({
    outcome: "accepted",
  });
  if (body === undefined) throw new Error("fixture-body");
  const batch = JSON.parse(body.toString()) as CanonicalTraceGraph;
  const primary = batch.resourceSpans[0]!;
  const transport = batch.resourceSpans[1]!;
  expect(transport.scopeSpans[0]!.scope!.name).toBe(capsule.scopeName);
  if (absent)
    for (const span of primary.scopeSpans[0]!.spans) {
      const attributes = span.attributes!;
      if (!attributes.some((attribute) => attribute.key === "llm.model_name"))
        continue;
      span.attributes = attributes.filter(
        (attribute) => attribute.key !== "llm.model_name",
      );
      if (ledger) {
        const unavailable = field(
          span.attributes,
          "agentscope.mapping.unavailable",
        );
        const entries = JSON.parse(text(unavailable)) as {
          field: string;
          state: string;
          reason: string;
        }[];
        entries.push({
          field: "llm.model_name",
          state: "unavailable",
          reason: "not-emitted",
        });
        entries.sort((left, right) => left.field.localeCompare(right.field));
        unavailable.value = { stringValue: JSON.stringify(entries) };
      }
    }
  if (absent) {
    const bytes = Buffer.from(JSON.stringify({ resourceSpans: [primary] }));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const encoded = bytes.toString("base64url");
    const chunks = Array.from(
      { length: Math.ceil(encoded.length / capsule.chunkCharacters) },
      (_, index) =>
        encoded.slice(
          index * capsule.chunkCharacters,
          (index + 1) * capsule.chunkCharacters,
        ),
    );
    const spans = transport.scopeSpans[0]!.spans;
    expect(spans.length - 1).toBe(
      Math.ceil(chunks.length / capsule.maximumChunksPerCarrier),
    );
    for (const span of spans)
      field(span.attributes!, `${prefix}${capsule.keys.graphDigest}`).value = {
        stringValue: digest,
      };
    for (const [key, value] of [
      [capsule.keys.graphBytes, String(bytes.length)],
      [capsule.keys.chunkCount, String(chunks.length)],
    ] as const)
      field(spans[0]!.attributes!, `${prefix}${key}`).value = {
        stringValue: value,
      };
    for (const [index, span] of spans.slice(1).entries())
      field(span.attributes!, `${prefix}${capsule.keys.chunks}`).value = {
        arrayValue: {
          values: chunks
            .slice(
              index * capsule.maximumChunksPerCarrier,
              (index + 1) * capsule.maximumChunksPerCarrier,
            )
            .map((stringValue) => ({ stringValue })),
        },
      };
  }
  const sourceGraph =
    createSanitizedRedactedCanonicalTraceFixture(options).graph;
  const version = text(
    field(
      sourceGraph.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes!,
      "agentscope.harness.version",
    ),
  );
  const expected: SelectedOtlpExpectation = {
    harness: { name: options.harnessName, version },
    sessionId: options.sessionId,
    ...(absent ? {} : { modelName: options.modelName }),
  };
  return {
    batch,
    expected,
    graph: { resourceSpans: [primary] },
    bytes: () => Buffer.from(JSON.stringify(batch)),
  };
};

describe("selected writer native model unavailability", () => {
  it("preserves the production writer's independently expected emitted model", async () => {
    const input = await fixture();
    expect(
      observeSelectedWriterOtlp(
        input.bytes(),
        ["PRIVATE_CANARY"],
        input.expected,
      ).context.models,
    ).toEqual([options.modelName]);
    delete input.expected.modelName;
    expect(() =>
      observeSelectedWriterOtlp(
        input.bytes(),
        ["PRIVATE_CANARY"],
        input.expected,
      ),
    ).toThrow();
  });
  it("accepts no model only with a Protocol-valid unavailable field ledger", async () => {
    const input = await fixture(true);
    expect(safeParseCanonicalTraceGraph(input.graph).success).toBe(true);
    expect(
      observeSelectedWriterOtlp(
        input.bytes(),
        ["PRIVATE_CANARY"],
        input.expected,
      ).context.models,
    ).toEqual([]);
    input.expected.modelName = options.modelName;
    expect(() =>
      observeSelectedWriterOtlp(
        input.bytes(),
        ["PRIVATE_CANARY"],
        input.expected,
      ),
    ).toThrow();
  });
  it("refuses missing unavailable metadata instead of fabricating model facts", async () => {
    const input = await fixture(true, false);
    expect(safeParseCanonicalTraceGraph(input.graph).success).toBe(false);
    expect(() =>
      observeSelectedWriterOtlp(
        input.bytes(),
        ["PRIVATE_CANARY"],
        input.expected,
      ),
    ).toThrow();
  });
});
