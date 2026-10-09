import { createHash } from "node:crypto";

import { LANGFUSE_COMPATIBILITY_MANIFEST } from "@agentscope/destination-langfuse";
import { createLangfuseReporterTestHarness } from "@agentscope/destination-langfuse/testing";
import { createSanitizedRedactedCanonicalTraceFixture } from "@agentscope/protocol/testing";
import { safeParseCanonicalTraceGraph } from "@agentscope/protocol";
import { describe, expect, it } from "vitest";

import {
  observeSelectedWriterOtlp,
  type SelectedOtlpExpectation,
} from "./selected-otlp-observation.js";

const contract = LANGFUSE_COMPATIBILITY_MANIFEST.capsule;
const projection = LANGFUSE_COMPATIBILITY_MANIFEST.projection;
const value = (stringValue: string) => ({ stringValue });
const attribute = (key: string, text: string) => ({ key, value: value(text) });
const metadata = (key: string, text: string) =>
  attribute(`${projection.wire.observationMetadataPrefix}${key}`, text);
const sha = (input: string | Uint8Array) =>
  createHash("sha256").update(input).digest("hex");
const fixtureOverlays = (routing: Record<string, string>, spanCount: number) =>
  [
    [projection.root, "true"],
    [projection.status, "ok"],
    [projection.spanCount, String(spanCount)],
    [projection.modelCount, "1"],
    [projection.tagCount, "0"],
    [projection.session, "independent-session"],
    [projection.harness, "codex"],
    ...(routing["vcs.ref.head.name"] === undefined
      ? []
      : [[projection.branch, routing["vcs.ref.head.name"]]]),
    [projection.repository, routing["vcs.repository.name"]!],
    [`${projection.modelIndexPrefix}00`, "fixture-model"],
    [
      `${projection.modelFilterKeyPrefix}${sha("fixture-model")}`,
      "fixture-model",
    ],
  ].flatMap(([key, text]) => [
    metadata(key!, text!),
    attribute(`${projection.wire.traceMetadataPrefix}${key}`, text!),
  ]);
type FixtureRoot = ReturnType<
  typeof createSanitizedRedactedCanonicalTraceFixture
>["graph"]["resourceSpans"][number]["scopeSpans"][number]["spans"][number];
const transportSpan = (
  root: FixtureRoot,
  name: string,
  index: number,
  attributes: unknown[],
) => ({
  traceId: root.traceId,
  spanId: String(index + 1).padStart(16, "a"),
  parentSpanId: root.spanId,
  name,
  kind: 1,
  startTimeUnixNano: root.startTimeUnixNano,
  endTimeUnixNano: root.startTimeUnixNano,
  attributes,
  droppedAttributesCount: 0,
  events: [],
  droppedEventsCount: 0,
  links: [],
  droppedLinksCount: 0,
  flags: 0,
  status: { code: 0 },
});
const unavailableGit = [
  "agentscope.git.worktree",
  "agentscope.git.repository_root",
  "vcs.ref.head.name",
  "vcs.ref.head.revision",
  "vcs.ref.type",
];
const makeUnversioned = (
  graph: ReturnType<
    typeof createSanitizedRedactedCanonicalTraceFixture
  >["graph"],
) => {
  const primary = graph.resourceSpans[0]!;
  const root = primary.scopeSpans[0]!.spans[0]!;
  const fields = new Set(unavailableGit);
  primary.resource!.attributes = primary.resource!.attributes!.filter(
    ({ key }) => !fields.has(key),
  );
  root.attributes = root.attributes!.filter(({ key }) => !fields.has(key));
  const provenance = root.attributes.find(
    ({ key }) => key === "agentscope.mapping.provenance",
  )!;
  const unavailable = root.attributes.find(
    ({ key }) => key === "agentscope.mapping.unavailable",
  )!;
  const provenanceEntries = JSON.parse(
    (provenance.value as { stringValue: string }).stringValue,
  ) as { field: string; source: string }[];
  const unavailableEntries = JSON.parse(
    (unavailable.value as { stringValue: string }).stringValue,
  ) as { field: string; state: string; reason: string }[];
  provenance.value = value(
    JSON.stringify(
      [
        ...provenanceEntries.filter(({ field }) => !fields.has(field)),
        ...unavailableGit.map((field) => ({ field, source: "git" })),
      ].sort((left, right) => (left.field < right.field ? -1 : 1)),
    ),
  );
  unavailable.value = value(
    JSON.stringify(
      [
        ...unavailableEntries.filter(({ field }) => !fields.has(field)),
        ...unavailableGit.map((field) => ({
          field,
          state: "unavailable",
          reason: "resolution-failed",
        })),
      ].sort((left, right) => (left.field < right.field ? -1 : 1)),
    ),
  );
};
const fixture = (longNames = false, unversioned = false) => {
  const graph = structuredClone(
    createSanitizedRedactedCanonicalTraceFixture({
      sessionId: "independent-session",
      modelName: "fixture-model",
      harnessName: "codex",
    }).graph,
  );
  const primary = graph.resourceSpans[0]!;
  if (unversioned) makeUnversioned(graph);
  if (longNames)
    for (const item of primary.scopeSpans[0]!.spans)
      item.name = "n".repeat(1024);
  const root = primary.scopeSpans[0]!.spans[0]!;
  const rootAttrs = Object.fromEntries(
    root.attributes!.map((entry) => [
      entry.key,
      "stringValue" in entry.value ? entry.value.stringValue : "",
    ]),
  );
  const bytes = Buffer.from(JSON.stringify({ resourceSpans: [primary] }));
  const encoded = bytes.toString("base64url");
  const chunks = Array.from(
    { length: Math.ceil(encoded.length / contract.chunkCharacters) },
    (_, index) =>
      encoded.slice(
        index * contract.chunkCharacters,
        (index + 1) * contract.chunkCharacters,
      ),
  );
  const nonce = "a".repeat(32);
  const graphDigest = sha(bytes);
  const carrierCount = Math.ceil(
    chunks.length / contract.maximumChunksPerCarrier,
  );
  const routing = Object.fromEntries(
    primary.resource!.attributes!.map((entry) => [
      entry.key,
      "stringValue" in entry.value ? entry.value.stringValue : "",
    ]),
  );
  const overlays = fixtureOverlays(
    routing,
    primary.scopeSpans[0]!.spans.length,
  );
  const capsule = {
    resource: {
      attributes: primary.resource!.attributes!.filter((entry) =>
        contract.transportSpan.resourceAttributeKeys.some(
          (key) => key === entry.key,
        ),
      ),
      droppedAttributesCount: 0,
    },
    scopeSpans: [
      {
        scope: { name: contract.scopeName },
        spans: [
          transportSpan(root, contract.headerName, 0, [
            ...overlays,
            attribute("session.id", "independent-session"),
            metadata(contract.keys.marker, contract.marker),
            metadata(contract.keys.nonce, nonce),
            metadata(contract.keys.version, contract.version),
            metadata(contract.keys.graphBytes, String(bytes.length)),
            metadata(contract.keys.graphDigest, graphDigest),
            metadata(contract.keys.carrierCount, String(carrierCount)),
            metadata(contract.keys.chunkCount, String(chunks.length)),
          ]),
          ...Array.from({ length: carrierCount }, (_, index) =>
            transportSpan(root, contract.carrierName, index + 1, [
              metadata(contract.keys.nonce, nonce),
              metadata(contract.keys.version, contract.version),
              metadata(contract.keys.graphDigest, graphDigest),
              metadata(contract.keys.carrierIndex, String(index)),
              {
                key: `${projection.wire.observationMetadataPrefix}${contract.keys.chunks}`,
                value: {
                  arrayValue: {
                    values: chunks
                      .slice(
                        index * contract.maximumChunksPerCarrier,
                        (index + 1) * contract.maximumChunksPerCarrier,
                      )
                      .map(value),
                  },
                },
              },
            ]),
          ),
        ],
      },
    ],
  };
  const expected: SelectedOtlpExpectation = {
    harness: {
      name: "codex",
      version: rootAttrs["agentscope.harness.version"]!,
    },
    sessionId: "independent-session",
    modelName: "fixture-model",
    identity: {
      traceId: root.traceId,
      spanIds: primary.scopeSpans[0]!.spans.map((item) => item.spanId),
    },
  };
  const batch = { resourceSpans: [primary, capsule] };
  return {
    graph,
    primary,
    capsule,
    expected,
    batch,
    header: capsule.scopeSpans[0]!.spans[0]!,
    carriers: capsule.scopeSpans[0]!.spans.slice(1),
    bytes: () => Buffer.from(JSON.stringify(batch)),
  };
};
const observe = (input: ReturnType<typeof fixture>) =>
  observeSelectedWriterOtlp(input.bytes(), ["PRIVATE_CANARY"], input.expected);

describe("selected Langfuse wire independent canonical observation", () => {
  it("accounts the actual production writer through an inert public executor", async () => {
    let wire: Buffer | undefined;
    const harness = createLangfuseReporterTestHarness({
      executor: (request) => {
        wire = Buffer.from(request.body!);
        return Promise.resolve({
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from("{}"),
        });
      },
    });
    await expect(
      harness.report({
        trace: {
          sessionId: "independent-session",
          modelName: "fixture-model",
          harnessName: "codex",
        },
      }),
    ).resolves.toEqual({ outcome: "accepted" });
    const input = fixture();
    const result = observeSelectedWriterOtlp(
      wire!,
      ["PRIVATE_CANARY"],
      input.expected,
    );
    expect(result.graph).toEqual(input.graph);
    expect(result.canonicalSpanCount).toBe(3);
    expect(result.resourceCount).toBe(2);
  });
  it("returns the actual frozen graph/context and accounts every transport span", () => {
    const input = fixture();
    const result = observe(input);
    expect(result.graph).toEqual(input.graph);
    expect(result.context.models).toContain("fixture-model");
    expect(result.context.rootContext["session.id"]).toBe(
      "independent-session",
    );
    expect(result.resourceCount).toBe(2);
    expect(result.canonicalSpanCount).toBe(3);
    expect(result.transportSpanCount).toBe(input.carriers.length + 1);
    expect(result.transport.graphSha256).toBe(
      sha(JSON.stringify({ resourceSpans: [input.primary] })),
    );
    expect(Object.isFrozen(result.graph.resourceSpans[0])).toBe(true);
  });
  it("accounts reordered resources/carriers without relying on provider order", () => {
    const input = fixture();
    input.batch.resourceSpans.reverse();
    input.capsule.scopeSpans[0]!.spans.reverse();
    expect(observe(input).graph).toEqual(input.graph);
  });
  it("accepts manifest-bounded carrier arrays larger than canonical scalar arrays", () => {
    const input = fixture(true);
    const chunks = input.carriers[0]!.attributes.at(-1) as {
      value: { arrayValue: { values: unknown[] } };
    };
    expect(chunks.value.arrayValue.values.length).toBeGreaterThan(64);
    expect(chunks.value.arrayValue.values.length).toBeLessThanOrEqual(96);
    expect(observe(input).graph).toEqual(input.graph);
  });
  it.each(["session", "model", "harness", "version", "trace", "span"])(
    "refuses independently expected %s mismatch",
    (field) => {
      const input = fixture();
      if (field === "session") input.expected.sessionId = "other";
      if (field === "model") input.expected.modelName = "other";
      if (field === "harness") input.expected.harness.name = "other";
      if (field === "version") input.expected.harness.version = "other";
      if (field === "trace") input.expected.identity!.traceId = "b".repeat(32);
      if (field === "span") input.expected.identity!.spanIds.reverse();
      expect(() => observe(input)).toThrow(
        "integration.operations.otlp-observation",
      );
    },
  );
  it("returns Git context and only compares actual independently supplied fields", () => {
    const input = fixture();
    const observed = observe(input);
    const key = "vcs.ref.head.revision";
    const revision = observed.context.resourceContext[key]!;
    expect(revision).toBeTypeOf("string");
    input.expected.resourceContext = [{ key, value: revision }];
    expect(observe(input).context.resourceContext[key]).toBe(revision);
    input.expected.resourceContext[0]!.value = "other";
    expect(() => observe(input)).toThrow(
      "integration.operations.otlp-observation",
    );
  });
  it("returns all unavailable/provenance entries and refuses an invented absent context", () => {
    const input = fixture();
    const observed = observe(input);
    expect(observed.context.unavailable).toEqual(
      JSON.parse(
        observed.context.rootContext["agentscope.mapping.unavailable"]!,
      ),
    );
    input.expected.unavailableContext = [
      {
        field: "vcs.ref.head.revision",
        source: "git",
        state: "unavailable",
        reason: "resolution-failed",
      },
    ];
    expect(() => observe(input)).toThrow(
      "integration.operations.otlp-observation",
    );
  });
});

describe("selected unversioned context", () => {
  it("accepts explicit unversioned Git absence without inventing a branch or revision", () => {
    const input = fixture(false, true);
    const parsed = safeParseCanonicalTraceGraph(input.graph);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    input.expected.unavailableContext = unavailableGit.map((field) => ({
      field,
      source: "git",
      state: "unavailable",
      reason: "resolution-failed",
    }));
    const actual = observe(input);
    for (const field of unavailableGit) {
      expect(actual.context.resourceContext[field]).toBeUndefined();
      expect(actual.context.rootContext[field]).toBeUndefined();
    }
    input.expected.unavailableContext[0]!.reason = "policy-redacted";
    expect(() => observe(input)).toThrow(
      "integration.operations.otlp-observation",
    );
  });
});

describe("selected writer rejects accounting loss", () => {
  it.each([
    "missing",
    "extra",
    "scope",
    "metadata",
    "parent",
    "timing",
    "status",
    "event",
    "id",
  ])("refuses %s transport divergence", (field) => {
    const input = fixture();
    if (field === "missing") input.capsule.scopeSpans[0]!.spans.pop();
    if (field === "extra") input.batch.resourceSpans.push(input.primary);
    if (field === "scope")
      Object.assign(input.capsule.scopeSpans[0]!.scope, { name: "unknown" });
    if (field === "metadata")
      input.header.attributes.push(attribute("unknown", "ordinary"));
    if (field === "parent") input.header.parentSpanId = "b".repeat(16);
    if (field === "timing") input.header.endTimeUnixNano = "999";
    if (field === "status") input.header.status.code = 1;
    if (field === "event")
      Object.assign(input.header, { events: [{ name: "event" }] });
    if (field === "id")
      input.header.spanId = input.primary.scopeSpans[0]!.spans[0]!.spanId;
    expect(() => observe(input)).toThrow(
      "integration.operations.otlp-observation",
    );
  });
  it.each([
    "digest",
    "bytes",
    "chunks",
    "index",
    "nonce",
    "duplicate",
    "overlay",
  ])("refuses changed %s while preserving primary semantics", (field) => {
    const input = fixture();
    const target =
      field === "index" || field === "chunks"
        ? input.carriers[0]!
        : input.header;
    const keys = {
      digest: contract.keys.graphDigest,
      bytes: contract.keys.graphBytes,
      index: contract.keys.carrierIndex,
      nonce: contract.keys.nonce,
    };
    if (field in keys) {
      const key = keys[field as keyof typeof keys];
      const entry = target.attributes.find((item) =>
        (item as { key: string }).key.endsWith(key),
      ) as { value: unknown };
      entry.value = value(field === "digest" ? "0".repeat(64) : "999");
    }
    if (field === "chunks") {
      const entry = target.attributes.at(-1) as { value: unknown };
      entry.value = { arrayValue: { values: [value("tampered")] } };
    }
    if (field === "duplicate")
      input.capsule.scopeSpans[0]!.spans.push(input.carriers[0]!);
    if (field === "overlay")
      input.header.attributes.push(
        metadata(`${projection.modelIndexPrefix}31`, "extra"),
      );
    expect(() => observe(input)).toThrow(
      "integration.operations.otlp-observation",
    );
  });
  it("scans unknown fields before strict validation or transport partition", () => {
    const input = fixture();
    Object.assign(input.capsule, { unknown: "PRIVATE_CANARY" });
    expect(() => observe(input)).toThrow(
      "integration.operations.otlp-observation",
    );
    Object.assign(input.primary, { unknown: "ordinary" });
    expect(() => observe(input)).toThrow(
      "integration.operations.otlp-observation",
    );
  });
  it("rejects unexpected top-level and primary attributes rather than tolerant dropping", () => {
    const input = fixture();
    Object.assign(input.batch, { unknown: false });
    expect(() => observe(input)).toThrow(
      "integration.operations.otlp-observation",
    );
    const other = fixture();
    other.primary.scopeSpans[0]!.spans[0]!.attributes!.push(
      attribute("unregistered.value", "ordinary"),
    );
    expect(() => observe(other)).toThrow(
      "integration.operations.otlp-observation",
    );
  });
});
