import { describe, expect, it } from "vitest";

import canonicalFixture from "../testing/fixtures/sanitized-canonical-trace.json" with { type: "json" };
import { parseCanonicalTraceGraph } from "./canonical-graph.js";
import { deriveIdentityBundle } from "./identity.js";
import { finalizeRedactedCanonicalTrace } from "./redacted-finalization.js";
import {
  isRedactedCanonicalTrace,
  serializeRedactedCanonicalTrace,
  serializeJsonDataForTesting,
  type CanonicalTraceEnvelope,
  type RedactedCanonicalTrace,
} from "./redacted-envelope.js";

const identityBundle = () =>
  deriveIdentityBundle({
    harnessRegistryId: "codex",
    session: {
      kind: "native-session",
      nativeIdentityKind: "thread",
      nativeIdentity: "fixture-session",
    },
    boundary: {
      kind: "turn",
      id: "fixture-boundary",
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

const graph = (
  bundle = identityBundle(),
  logicalKeys: readonly [string, string, string] = ["root", "model", "tool"],
) => {
  const fixture = structuredClone(canonicalFixture);
  const spans = fixture.resourceSpans[0]?.scopeSpans[0]?.spans;
  if (spans === undefined || spans.length !== 3)
    throw new Error("fixture spans missing");
  const [root, model, tool] = spans;
  if (root === undefined || model === undefined || tool === undefined)
    throw new Error("fixture span missing");
  for (const span of spans) span.traceId = bundle.traceId;
  root.spanId = bundle.spans[logicalKeys[0]]!;
  model.spanId = bundle.spans[logicalKeys[1]]!;
  model.parentSpanId = bundle.spans[logicalKeys[0]]!;
  tool.spanId = bundle.spans[logicalKeys[2]]!;
  tool.parentSpanId = bundle.spans[logicalKeys[0]]!;
  return parseCanonicalTraceGraph(fixture);
};

const keyedGraph = (
  bundle = identityBundle(),
  logicalKeys: readonly [string, string, string] = ["root", "model", "tool"],
) => {
  const value = structuredClone(graph(bundle, logicalKeys));
  const spans = value.resourceSpans[0]!.scopeSpans[0]!.spans;
  Object.assign(spans[0]!, { logicalOperationKey: logicalKeys[0] });
  Object.assign(spans[1]!, { logicalOperationKey: logicalKeys[1] });
  Object.assign(spans[2]!, { logicalOperationKey: logicalKeys[2] });
  for (const span of spans) {
    const attribute = span.attributes?.find(
      ({ key }) => key === "agentscope.mapping.provenance",
    );
    if (attribute === undefined || !("stringValue" in attribute.value))
      throw new Error("fixture provenance missing");
    const ledger = JSON.parse(attribute.value.stringValue) as {
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
    attribute.value.stringValue = JSON.stringify(ledger);
  }
  return value;
};

const input = (bundle = identityBundle()) => ({
  identityBundle: bundle,
  graph: keyedGraph(bundle),
});

const fixedFailure = (value: unknown) => {
  expect(() => finalizeRedactedCanonicalTrace(value as never)).toThrowError(
    "protocol.redacted-trace.invalid",
  );
};

describe("RedactedCanonicalTrace lifecycle", () => {
  it("finalizes one strict recursively frozen envelope and serializes it", () => {
    const value = finalizeRedactedCanonicalTrace(input());
    expect(isRedactedCanonicalTrace(value)).toBe(true);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.delivery)).toBe(true);
    expect(Object.isFrozen(value.graph.resourceSpans[0])).toBe(true);
    const serialized = serializeRedactedCanonicalTrace(value);
    expect(value.delivery).toEqual({
      identity: input().identityBundle.deliveryId,
      stability: "session-stable",
    });
    expect(JSON.parse(serialized)).toEqual(value);
    expect(serialized).toBe(serializeRedactedCanonicalTrace(value));
  });

  it("does not transfer the runtime brand through ordinary object operations", () => {
    const value = finalizeRedactedCanonicalTrace(input());
    const copies = [
      { ...value },
      structuredClone(value),
      JSON.parse(JSON.stringify(value)) as unknown,
      Object.assign(Object.create(Reflect.getPrototypeOf(value)), value),
      graph(),
      { [Symbol.for("agentscope.redacted")]: true },
    ];
    for (const copy of copies) {
      expect(isRedactedCanonicalTrace(copy)).toBe(false);
      expect(() =>
        serializeRedactedCanonicalTrace(copy as RedactedCanonicalTrace),
      ).toThrowError("protocol.redacted-trace.invalid");
    }
  });
});

describe("ASID-bound finalization", () => {
  it("rejects forged bundles and bundle-to-graph identity mismatches", () => {
    const valid = input();
    const invalid = [
      { ...valid, extra: true },
      { ...valid, identityBundle: { ...valid.identityBundle } },
      { ...valid, identityBundle: structuredClone(valid.identityBundle) },
      {
        ...valid,
        identityBundle: JSON.parse(
          JSON.stringify(valid.identityBundle),
        ) as unknown,
      },
      {
        ...valid,
        graph: {
          ...valid.graph,
          resourceSpans: [],
        },
      },
    ];
    for (const value of invalid) fixedFailure(value);

    for (const logicalKeys of [
      ["root", "model", "model"],
      ["root", "model", "unknown"],
    ]) {
      const mismatchedKeys = structuredClone(valid.graph);
      const spans = mismatchedKeys.resourceSpans[0]!.scopeSpans[0]!.spans;
      for (let index = 0; index < spans.length; index += 1)
        Object.assign(spans[index]!, {
          logicalOperationKey: logicalKeys[index],
        });
      fixedFailure({ ...valid, graph: mismatchedKeys });
    }

    const callerIdsAreIgnored = structuredClone(valid.graph);
    const callerSpans =
      callerIdsAreIgnored.resourceSpans[0]!.scopeSpans[0]!.spans;
    callerSpans[0]!.traceId = "f".repeat(32);
    const modelId = callerSpans[1]!.spanId;
    callerSpans[1]!.spanId = callerSpans[2]!.spanId;
    callerSpans[2]!.spanId = modelId;
    const finalized = finalizeRedactedCanonicalTrace({
      ...valid,
      graph: callerIdsAreIgnored,
    });
    const finalizedSpans =
      finalized.graph.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(finalizedSpans[0]!.spanId).toBe(valid.identityBundle.spans.root);
    expect(finalizedSpans[1]!.spanId).toBe(valid.identityBundle.spans.model);
    expect(finalizedSpans[2]!.spanId).toBe(valid.identityBundle.spans.tool);
    expect(finalizedSpans[1]!.parentSpanId).toBe(
      valid.identityBundle.spans.root,
    );

    const mismatched = structuredClone(valid.graph);
    const resource = mismatched.resourceSpans[0];
    if (resource?.resource?.attributes === undefined)
      throw new Error("fixture resource missing");
    const attribute = resource.resource.attributes.find(
      ({ key }) => key === "agentscope.protocol.manifest_id",
    );
    if (attribute === undefined || !("stringValue" in attribute.value))
      throw new Error("fixture manifest missing");
    attribute.value.stringValue = "other";
    fixedFailure({ ...valid, graph: mismatched });

    const conflictingProvenance = structuredClone(valid.graph);
    const root =
      conflictingProvenance.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    const provenanceAttribute = root.attributes?.find(
      ({ key }) => key === "agentscope.mapping.provenance",
    );
    if (
      provenanceAttribute === undefined ||
      !("stringValue" in provenanceAttribute.value)
    )
      throw new Error("fixture provenance missing");
    const ledger = JSON.parse(provenanceAttribute.value.stringValue) as {
      field: string;
      source: string;
    }[];
    const spanId = ledger.find(({ field }) => field === "span.span_id");
    if (spanId === undefined) throw new Error("fixture span ID missing");
    spanId.source = "native-artifact";
    provenanceAttribute.value.stringValue = JSON.stringify(ledger);
    fixedFailure({ ...valid, graph: conflictingProvenance });
  });
});

describe("ASID logical association finalization", () => {
  it("preserves prototype-shaped logical keys in the private association", () => {
    const bundle = deriveIdentityBundle({
      harnessRegistryId: "codex",
      session: {
        kind: "native-session",
        nativeIdentityKind: "thread",
        nativeIdentity: "prototype-key-session",
      },
      boundary: {
        kind: "turn",
        id: "prototype-key-boundary",
        generation: 1,
        positionKind: "event-index",
        exclusiveEndPosition: 3,
      },
      operationIdScope: "session-global",
      operations: [
        {
          logicalKey: "__proto__",
          locator: { kind: "source-ordinal", ordinal: 0 },
        },
        {
          logicalKey: "constructor",
          parentLogicalKey: "__proto__",
          locator: { kind: "native-operation", nativeId: "model-1" },
        },
        {
          logicalKey: "prototype",
          parentLogicalKey: "__proto__",
          locator: { kind: "native-operation", nativeId: "tool-1" },
        },
      ],
    });
    const value = keyedGraph(bundle, ["__proto__", "constructor", "prototype"]);
    expect(
      isRedactedCanonicalTrace(
        finalizeRedactedCanonicalTrace({
          identityBundle: bundle,
          graph: value,
        }),
      ),
    ).toBe(true);
  });

  it("injects internal link identities and rejects ambiguous targets", () => {
    const valid = input();
    const tool = valid.graph.resourceSpans[0]!.scopeSpans[0]!.spans[2]!;
    tool.links = [
      {
        targetLogicalKey: "model",
        traceId: "f".repeat(32),
        spanId: "f".repeat(16),
        flags: 0,
      },
      {
        targetLogicalKey: "model",
        traceId: "e".repeat(32),
        spanId: "e".repeat(16),
        flags: 1,
      },
    ] as never;
    const provenanceAttribute = tool.attributes?.find(
      ({ key }) => key === "agentscope.mapping.provenance",
    );
    if (
      provenanceAttribute === undefined ||
      !("stringValue" in provenanceAttribute.value)
    )
      throw new Error("fixture provenance missing");
    const provenance = JSON.parse(provenanceAttribute.value.stringValue) as {
      field: string;
      source: string;
    }[];
    provenance.push({ field: "span.links", source: "native-artifact" });
    provenance.push({ field: "span.links.0.link", source: "derived" });
    provenance.push({ field: "span.links.0.target_ids", source: "derived" });
    provenance.push({
      field: "span.links.0.relationship",
      source: "native-artifact",
    });
    provenance.push({ field: "span.links.1.link", source: "derived" });
    provenance.push({ field: "span.links.1.target_ids", source: "derived" });
    provenance.push({
      field: "span.links.1.relationship",
      source: "native-artifact",
    });
    provenance.sort((left, right) => (left.field < right.field ? -1 : 1));
    provenanceAttribute.value.stringValue = JSON.stringify(provenance);

    const finalized = finalizeRedactedCanonicalTrace(valid);
    expect(
      finalized.graph.resourceSpans[0]!.scopeSpans[0]!.spans[2]!.links,
    ).toEqual([
      {
        traceId: valid.identityBundle.traceId,
        spanId: valid.identityBundle.spans.model,
        flags: 0,
      },
      {
        traceId: valid.identityBundle.traceId,
        spanId: valid.identityBundle.spans.model,
        flags: 1,
      },
    ]);

    for (const targets of [["unknown"], [null]]) {
      const candidate = structuredClone(valid.graph);
      candidate.resourceSpans[0]!.scopeSpans[0]!.spans[2]!.links = targets.map(
        (targetLogicalKey) =>
          ({
            targetLogicalKey,
            traceId: "f".repeat(32),
            spanId: "f".repeat(16),
          }) as never,
      );
      fixedFailure({ ...valid, graph: candidate });
    }
    const nullLink = structuredClone(valid.graph);
    nullLink.resourceSpans[0]!.scopeSpans[0]!.spans[2]!.links = [null] as never;
    fixedFailure({ ...valid, graph: nullLink });
  });
});

describe("external link identity finalization", () => {
  it("preserves trusted external link identities through finalization", () => {
    const valid = input();
    const tool = valid.graph.resourceSpans[0]!.scopeSpans[0]!.spans[2]!;
    const traceId = "03".repeat(16);
    const spanId = "04".repeat(8);
    tool.links = [{ traceId, spanId }] as never;
    const provenanceAttribute = tool.attributes?.find(
      ({ key }) => key === "agentscope.mapping.provenance",
    );
    if (
      provenanceAttribute === undefined ||
      !("stringValue" in provenanceAttribute.value)
    )
      throw new Error("fixture provenance missing");
    const provenance = JSON.parse(provenanceAttribute.value.stringValue) as {
      field: string;
      source: string;
    }[];
    provenance.push(
      { field: "span.links", source: "derived" },
      { field: "span.links.target_ids", source: "derived" },
      { field: "span.links.0.link", source: "derived" },
      { field: "span.links.0.target_ids", source: "hook-payload" },
      { field: "span.links.0.relationship", source: "hook-payload" },
    );
    provenance.sort((left, right) => (left.field < right.field ? -1 : 1));
    provenanceAttribute.value.stringValue = JSON.stringify(provenance);

    const finalized = finalizeRedactedCanonicalTrace(valid);
    expect(
      finalized.graph.resourceSpans[0]!.scopeSpans[0]!.spans[2]!.links,
    ).toEqual([{ traceId, spanId }]);

    for (const link of [
      { traceId: "0".repeat(32), spanId },
      { traceId, spanId: "0".repeat(16) },
      { traceId: "A3".repeat(16), spanId },
      { traceId },
    ]) {
      const candidate = structuredClone(valid.graph);
      candidate.resourceSpans[0]!.scopeSpans[0]!.spans[2]!.links = [
        link as never,
      ];
      fixedFailure({ ...valid, graph: candidate });
    }
  });
});

describe("RedactedCanonicalTrace hostile boundaries", () => {
  it("is total and content-free for hostile runtime inputs", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const aliased = input() as unknown as Record<string, unknown>;
    aliased.graph = aliased.identityBundle;
    const sparse: unknown[] = [];
    sparse.length = 2;
    const getter = Object.defineProperty({}, "envelopeVersion", {
      enumerable: true,
      get: () => {
        throw new Error("CANARY_SECRET");
      },
    });
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("CANARY_SECRET");
        },
      },
    );
    for (const value of [
      null,
      undefined,
      getter,
      proxy,
      cyclic,
      aliased,
      sparse,
      new Date(),
      { ...input(), symbol: Symbol("CANARY_SECRET") },
      { ...input(), graph: Number.NaN },
    ]) {
      try {
        finalizeRedactedCanonicalTrace(value as never);
        throw new Error("expected rejection");
      } catch (error) {
        expect(String(error)).toBe("Error: protocol.redacted-trace.invalid");
        expect(String(error)).not.toContain("CANARY_SECRET");
      }
    }
  });

  it("keeps the nominal type distinct from the unbranded envelope", () => {
    const value = finalizeRedactedCanonicalTrace(input());
    const raw: CanonicalTraceEnvelope = { ...value };
    // @ts-expect-error A structurally valid DTO is not lifecycle-branded.
    const compileOnly: RedactedCanonicalTrace = raw;
    expect(compileOnly).toBe(raw);
    expect(isRedactedCanonicalTrace(raw)).toBe(false);
  });

  it("rejects malformed identity provenance carriers", () => {
    const malformed: unknown[] = [];
    for (const variant of [
      "not-array",
      "duplicate",
      "missing",
      "null-value",
      "non-string",
      "invalid-json",
    ]) {
      const value = input();
      const root = value.graph.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
      const attribute = root.attributes?.find(
        ({ key }) => key === "agentscope.mapping.provenance",
      );
      if (attribute === undefined)
        throw new Error("fixture provenance missing");
      if (variant === "not-array") root.attributes = null as never;
      else if (variant === "duplicate")
        root.attributes!.push({
          ...attribute,
          value: structuredClone(attribute.value),
        });
      else if (variant === "missing")
        root.attributes = root.attributes!.filter(
          ({ key }) => key !== "agentscope.mapping.provenance",
        );
      else if (variant === "null-value") attribute.value = null as never;
      else if (variant === "non-string")
        attribute.value = { stringValue: 1 } as never;
      else attribute.value = { stringValue: "not-json" };
      malformed.push(value);
    }
    for (const value of malformed) fixedFailure(value);
  });
});

describe("guarded serialization", () => {
  it("serializes every bounded canonical JSON primitive deterministically", () => {
    expect(
      [null, true, false, -0, 1.5, "value", [false], { value: null }].map(
        serializeJsonDataForTesting,
      ),
    ).toEqual([
      "null",
      "true",
      "false",
      "0",
      "1.5",
      '"value"',
      "[false]",
      '{"value":null}',
    ]);
    expect(() => serializeJsonDataForTesting(undefined)).toThrowError(
      "protocol.redacted-trace.invalid",
    );
  });

  it("does not invoke polluted object or array prototypes", () => {
    const value = finalizeRedactedCanonicalTrace(input());
    const objectDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "toJSON",
    );
    const arrayDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "toJSON",
    );
    const mapDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "map",
    );
    const joinDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "join",
    );
    let serialized: string | undefined;
    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        value: () => ({ leaked: "CANARY_SECRET" }),
      });
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        value: () => ["CANARY_SECRET"],
      });
      Object.defineProperty(Array.prototype, "map", {
        configurable: true,
        value: () => ["CANARY_SECRET"],
      });
      Object.defineProperty(Array.prototype, "join", {
        configurable: true,
        value: () => "CANARY_SECRET",
      });
      serialized = serializeRedactedCanonicalTrace(value);
    } finally {
      if (objectDescriptor === undefined)
        Reflect.deleteProperty(Object.prototype, "toJSON");
      else Object.defineProperty(Object.prototype, "toJSON", objectDescriptor);
      if (arrayDescriptor === undefined)
        Reflect.deleteProperty(Array.prototype, "toJSON");
      else Object.defineProperty(Array.prototype, "toJSON", arrayDescriptor);
      if (mapDescriptor !== undefined)
        Object.defineProperty(Array.prototype, "map", mapDescriptor);
      if (joinDescriptor !== undefined)
        Object.defineProperty(Array.prototype, "join", joinDescriptor);
    }
    expect(serialized).not.toContain("CANARY_SECRET");
    expect(serialized).toContain('"envelopeVersion":1');
  });
});

describe("envelope traversal limits", () => {
  it("enforces explicit budgets and property shape", () => {
    let deep: unknown = {};
    for (let index = 0; index < 26; index += 1) deep = { child: deep };
    const symbolKey = { [Symbol("CANARY_SECRET")]: true };
    const wide = Object.fromEntries(
      Array.from({ length: 513 }, (_, index) => [`key${index}`, index]),
    );
    const hiddenArray = [1];
    Object.defineProperty(hiddenArray, "0", {
      value: 1,
      enumerable: false,
    });
    const hiddenObject = { value: true };
    Object.defineProperty(hiddenObject, "value", {
      value: true,
      enumerable: false,
    });
    const bundle = identityBundle();
    const sparseGraph: unknown[] = [];
    sparseGraph.length = 2;
    for (const graphValue of [
      deep,
      "x".repeat(2_000_001),
      symbolKey,
      wide,
      hiddenArray,
      hiddenObject,
      sparseGraph,
      new Date(),
      { ["k".repeat(2_000_001)]: true },
    ]) {
      fixedFailure({ identityBundle: bundle, graph: graphValue });
    }
  });

  it("rejects malformed pre-final topology containers", () => {
    const valid = input();
    const tooFewSpans = structuredClone(valid.graph);
    tooFewSpans.resourceSpans[0]!.scopeSpans[0]!.spans.pop();
    const aliasedGraph = structuredClone(valid.graph);
    aliasedGraph.resourceSpans[0]!.resource = aliasedGraph.resourceSpans[0]!
      .scopeSpans[0] as never;
    const cases = [
      { resourceSpans: "wrong" },
      { resourceSpans: [] },
      { resourceSpans: [{ scopeSpans: "wrong" }] },
      { resourceSpans: [{ scopeSpans: [] }] },
      { resourceSpans: [{ scopeSpans: [{ spans: "wrong" }] }] },
      { resourceSpans: [{ scopeSpans: [{ spans: [null, {}, {}] }] }] },
      tooFewSpans,
      aliasedGraph,
    ];
    for (const graphValue of cases)
      fixedFailure({ ...valid, graph: graphValue });

    const badLinks = structuredClone(valid.graph);
    badLinks.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.links =
      "wrong" as never;
    fixedFailure({ ...valid, graph: badLinks });
  });
});
