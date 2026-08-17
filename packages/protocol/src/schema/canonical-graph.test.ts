import { describe, expect, it } from "vitest";

import fixture from "../testing/fixtures/sanitized-canonical-trace.json" with { type: "json" };
import { standardsManifest } from "../standards/manifest.js";
import {
  CANONICAL_COMPOUND_RULES,
  CanonicalTraceGraphSchema,
  CANONICAL_PROFILE_IDENTITY,
  parseCanonicalTraceGraph,
  safeParseCanonicalTraceGraph,
  safeParseTolerantCanonicalTraceGraph,
  validateCanonicalProfileIdentity,
  type CanonicalTraceGraph,
} from "./canonical-graph.js";
import type { FieldProvenance, FieldUnavailable } from "./context.js";
import type { OtlpKeyValue, OtlpSpan } from "./otlp.js";
import {
  getTimingCompatibilityRule,
  isTimingProvenanceCompatible,
  NATIVE_STATES,
  PROVENANCE_SOURCES,
  TIMING_BASES,
  type NativeState,
  type ProvenanceSource,
  type TimingBasis,
} from "./timing-profile.js";

// Component-contract traceability for AC-OVR-001.1 and AC-CAP-002.1 through
// AC-CAP-002.7. These tests prove the normalized producer shape and accounting
// rules only; end-to-end harness normalization remains planned evidence.

const graph = (): CanonicalTraceGraph =>
  structuredClone(parseCanonicalTraceGraph(fixture));

const resource = (value: CanonicalTraceGraph) => value.resourceSpans[0]!;
const spans = (value: CanonicalTraceGraph) =>
  resource(value).scopeSpans[0]!.spans;
const root = (value: CanonicalTraceGraph) => spans(value)[0]!;
const llm = (value: CanonicalTraceGraph) => spans(value)[1]!;
const tool = (value: CanonicalTraceGraph) => spans(value)[2]!;

const attribute = (
  attributes: readonly OtlpKeyValue[] | undefined,
  key: string,
) => attributes?.find((candidate) => candidate.key === key);

const removeAttribute = (
  attributes: OtlpKeyValue[] | undefined,
  key: string,
) => {
  if (attributes === undefined) {
    return;
  }
  const index = attributes.findIndex((candidate) => candidate.key === key);
  if (index >= 0) {
    attributes.splice(index, 1);
  }
};

const stringAttribute = (key: string, value: string): OtlpKeyValue => ({
  key,
  value: { stringValue: value },
});

const sortAttributes = (span: OtlpSpan) => {
  span.attributes?.sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
};

const readJsonAttribute = <T>(span: OtlpSpan, key: string): T => {
  const value = attribute(span.attributes, key)?.value;
  if (value === undefined || !("stringValue" in value)) {
    throw new Error("fixture ledger is missing");
  }
  return JSON.parse(value.stringValue) as T;
};

const writeJsonAttribute = (span: OtlpSpan, key: string, value: unknown) => {
  const existing = attribute(span.attributes, key);
  const encoded = JSON.stringify(value);
  if (existing === undefined) {
    span.attributes ??= [];
    span.attributes.push(stringAttribute(key, encoded));
    sortAttributes(span);
  } else {
    existing.value = { stringValue: encoded };
  }
};

const provenance = (span: OtlpSpan) =>
  readJsonAttribute<FieldProvenance>(span, "agentscope.mapping.provenance");
const unavailable = (span: OtlpSpan) =>
  readJsonAttribute<FieldUnavailable>(span, "agentscope.mapping.unavailable");

const standalonePostHocToolFeedback = () => {
  const value = graph();
  const carrier = root(value);
  resource(value).scopeSpans[0]!.spans.splice(1);
  attribute(carrier.attributes, "openinference.span.kind")!.value = {
    stringValue: "TOOL",
  };
  carrier.links = [{ traceId: "03".repeat(16), spanId: "04".repeat(8) }];
  carrier.attributes!.push(
    stringAttribute("agentscope.feedback.transport", "post-hoc"),
    stringAttribute("annotations.0.annotation.label", "pass"),
    stringAttribute("annotations.0.annotation.name", "quality"),
  );
  for (const key of CANONICAL_COMPOUND_RULES.evidence.rootExtensions) {
    removeAttribute(carrier.attributes, key);
  }
  sortAttributes(carrier);
  const ledger = provenance(carrier).filter(
    ({ field }) =>
      field !== "family.error.activity" &&
      field !== "family.tool.activity" &&
      !CANONICAL_COMPOUND_RULES.evidence.rootExtensions.includes(field),
  );
  ledger.push(
    { field: "agentscope.feedback.transport", source: "derived" },
    { field: "annotations.0.annotation.label", source: "native-artifact" },
    { field: "annotations.0.annotation.name", source: "native-artifact" },
    { field: "span.links", source: "derived" },
    { field: "span.links.target_ids", source: "derived" },
    { field: "span.links.0.link", source: "derived" },
    { field: "span.links.0.target_ids", source: "hook-payload" },
    { field: "span.links.0.relationship", source: "hook-payload" },
  );
  ledger.sort((left, right) => (left.field < right.field ? -1 : 1));
  writeJsonAttribute(carrier, "agentscope.mapping.provenance", ledger);
  removeAttribute(carrier.attributes, "agentscope.mapping.unavailable");
  return value;
};

const setSpanTiming = (
  span: OtlpSpan,
  timingBasis: TimingBasis,
  nativeState: NativeState,
  source: ProvenanceSource,
) => {
  const ledger = provenance(span).map((item) =>
    item.field.endsWith("time_unix_nano")
      ? { ...item, timingBasis, nativeState, source }
      : item,
  );
  writeJsonAttribute(span, "agentscope.mapping.provenance", ledger);
};

const graphWithTiming = (
  timingBasis: TimingBasis,
  nativeState: NativeState,
  source: ProvenanceSource,
) => {
  const candidate = graph();
  setSpanTiming(tool(candidate), timingBasis, nativeState, source);
  if (getTimingCompatibilityRule(timingBasis).shape === "point") {
    tool(candidate).endTimeUnixNano = tool(candidate).startTimeUnixNano;
  }
  return candidate;
};

const issues = (value: unknown) => {
  const result = safeParseCanonicalTraceGraph(value);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues;
};

describe("pinned graph-node root semantics", () => {
  it("accepts the pinned empty graph parent identifier for an AGENT root", () => {
    const value = graph();
    root(value).attributes!.push(stringAttribute("graph.node.parent_id", ""));
    sortAttributes(root(value));
    const rootProvenance = provenance(root(value));
    rootProvenance.push({
      field: "graph.node.parent_id",
      source: "native-artifact",
    });
    rootProvenance.sort((left, right) => (left.field < right.field ? -1 : 1));
    writeJsonAttribute(
      root(value),
      "agentscope.mapping.provenance",
      rootProvenance,
    );
    expect(safeParseCanonicalTraceGraph(value).success).toBe(true);
  });
});

describe("strict canonical producer graph", () => {
  it("accepts the sanitized golden AGENT → LLM + TOOL graph", () => {
    const parsed = parseCanonicalTraceGraph(fixture);
    expect(parsed.resourceSpans).toHaveLength(1);
    expect(spans(parsed).map(({ name }) => name)).toEqual([
      "coding-agent session",
      "model response",
      "read_file",
    ]);
    expect(JSON.stringify(parsed)).not.toMatch(/api[_-]?key|secret|bearer/iu);
  });

  it("exposes the same total parse and safeParse producer contract", () => {
    expect(CanonicalTraceGraphSchema.parse(fixture)).toEqual(fixture);
    expect(CanonicalTraceGraphSchema.safeParse(fixture).success).toBe(true);
    expect(() => parseCanonicalTraceGraph({ invalid: true })).toThrow(
      "protocol.schema.invalid",
    );
  });

  it("binds the curated standard profile to the manifest identity", () => {
    expect(() => {
      validateCanonicalProfileIdentity(CANONICAL_PROFILE_IDENTITY);
    }).not.toThrow();
    expect(() => {
      validateCanonicalProfileIdentity({
        ...CANONICAL_PROFILE_IDENTITY,
        topology: {
          ...CANONICAL_PROFILE_IDENTITY.topology,
          rootCount: 2,
        },
      });
    }).toThrow("protocol.schema.invalid");
  });

  it("deep-freezes every exported contract input used by validation", () => {
    const invalidFlags = graph();
    tool(invalidFlags).flags = 2;
    expect(issues(invalidFlags)).toContain("canonical.span.context");

    expect(Object.isFrozen(CANONICAL_COMPOUND_RULES.context.spanFlags)).toBe(
      true,
    );
    expect(() => {
      Object.assign(CANONICAL_COMPOUND_RULES.context.spanFlags, { 4: 2 });
    }).toThrow(TypeError);
    expect(() => {
      Object.assign(standardsManifest, { manifestId: "attacker-contract" });
    }).toThrow(TypeError);
    expect(issues(invalidFlags)).toContain("canonical.span.context");
    expect(standardsManifest.manifestId).not.toBe("attacker-contract");
  });

  it("rejects cyclic, accessor, non-plain, deep, wide, and oversized inputs safely", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(issues(cyclic)).toContain("protocol.input.cyclic");

    let getterCalled = false;
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return "not-read";
      },
    });
    expect(issues(accessor)).toContain("protocol.input.object-shape");
    expect(getterCalled).toBe(false);
    expect(issues(new Date(0))).toContain("protocol.input.object-shape");

    let deep: unknown = "leaf";
    for (let index = 0; index < 30; index += 1) {
      deep = [deep];
    }
    expect(issues(deep)).toContain("protocol.input.depth");
    expect(issues(Array.from({ length: 513 }, () => null))).toContain(
      "protocol.input.object-keys",
    );
    expect(issues("x".repeat(2_000_001))).toContain("protocol.input.strings");
    const manyNodes = Array.from({ length: 400 }, () =>
      Array.from({ length: 400 }, () => null),
    );
    expect(issues(manyNodes)).toContain("protocol.input.nodes");

    const keyHeavy = Array.from({ length: 100 }, (_, group) =>
      Object.fromEntries(
        Array.from({ length: 500 }, (_, key) => [
          `${group}-${key}-${"x".repeat(40)}`,
          null,
        ]),
      ),
    );
    expect(issues(keyHeavy)).toContain("protocol.input.strings");

    const throwingProxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error("hostile proxy");
        },
      },
    );
    expect(issues(throwingProxy)).toEqual(["protocol.schema.invalid"]);
  });

  it("requires one owned ResourceSpans and one deterministic Protocol scope", () => {
    const multiple = graph();
    multiple.resourceSpans.push(structuredClone(resource(multiple)));
    expect(issues(multiple)).toContain("protocol.schema.invalid");

    const wrongScope = graph();
    resource(wrongScope).scopeSpans[0]!.scope!.name = "foreign-scope";
    expect(issues(wrongScope)).toContain("canonical.scope.identity");

    const scopeExtras = graph();
    resource(scopeExtras).scopeSpans[0]!.scope!.attributes = [
      stringAttribute("scope.secret", "value"),
    ];
    expect(issues(scopeExtras)).toContain("canonical.scope.extra");

    const schemaUrl = graph();
    resource(schemaUrl).schemaUrl = "https://example.invalid/schema";
    expect(issues(schemaUrl)).toContain("canonical.resource.schema-url");
  });
});

describe("canonical resource attributes", () => {
  it("enforces the explicit resource allowlist, identity, values, and order", () => {
    const unknown = graph();
    resource(unknown).resource!.attributes!.push(
      stringAttribute("host.name", "developer-machine"),
    );
    expect(issues(unknown)).toContain("canonical.attribute.unknown");

    const wrongManifest = graph();
    attribute(
      resource(wrongManifest).resource?.attributes,
      "agentscope.protocol.manifest_id",
    )!.value = { stringValue: "wrong" };
    expect(issues(wrongManifest)).toContain("canonical.resource.manifest");

    const wrongService = graph();
    attribute(
      resource(wrongService).resource?.attributes,
      "service.name",
    )!.value = {
      stringValue: "not-agentscope",
    };
    expect(issues(wrongService)).toContain("canonical.resource.service");

    const wrongType = graph();
    attribute(resource(wrongType).resource?.attributes, "vcs.ref.type")!.value =
      {
        boolValue: true,
      };
    expect(issues(wrongType)).toContain("canonical.attribute.value");

    const emptyRevision = graph();
    attribute(
      resource(emptyRevision).resource?.attributes,
      "vcs.ref.head.revision",
    )!.value = { stringValue: "" };
    expect(issues(emptyRevision)).toContain("canonical.attribute.value");

    const unordered = graph();
    resource(unordered).resource!.attributes!.reverse();
    expect(issues(unordered)).toContain("canonical.attribute.order");
  });

  it.each([
    "https://user:password@example.invalid/repository",
    "https://example.invalid/repository?token=fixture",
    "https://example.invalid/repository#fragment",
    "ssh://example.invalid/repository",
    "https://example.invalid/repository.git",
    "https://example.invalid/repository.GIT/",
    " https://example.invalid/repository",
    "not-a-url",
  ])("rejects non-canonical repository URL %s", (url) => {
    const value = graph();
    attribute(
      resource(value).resource?.attributes,
      "vcs.repository.url.full",
    )!.value = { stringValue: url };
    expect(issues(value)).toContain("canonical.resource.repository-url");
  });
});

describe("canonical topology and semantic attributes", () => {
  it("enforces VCS entity identity and supports explicit detached HEAD", () => {
    const orphanRef = graph();
    removeAttribute(
      resource(orphanRef).resource?.attributes,
      "vcs.ref.head.revision",
    );
    expect(issues(orphanRef)).toContain("canonical.resource.vcs-ref-identity");

    const orphanRepository = graph();
    removeAttribute(
      resource(orphanRepository).resource?.attributes,
      "vcs.repository.url.full",
    );
    expect(issues(orphanRepository)).toContain(
      "canonical.resource.vcs-repository-identity",
    );

    const invalidRefType = graph();
    attribute(
      resource(invalidRefType).resource?.attributes,
      "vcs.ref.type",
    )!.value = { stringValue: "custom" };
    expect(issues(invalidRefType)).toContain("canonical.resource.vcs-ref-type");

    const detached = graph();
    removeAttribute(
      resource(detached).resource?.attributes,
      "vcs.ref.head.name",
    );
    const rootUnavailable = unavailable(root(detached));
    rootUnavailable.push({
      field: "vcs.ref.head.name",
      state: "not-applicable",
      reason: "detached-head",
    });
    rootUnavailable.sort((left, right) => (left.field < right.field ? -1 : 1));
    writeJsonAttribute(
      root(detached),
      "agentscope.mapping.unavailable",
      rootUnavailable,
    );
    expect(safeParseCanonicalTraceGraph(detached).success).toBe(true);
  });

  it("enforces one trace, unique spans, one root, connected acyclic parents", () => {
    const twoTraces = graph();
    tool(twoTraces).traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(issues(twoTraces)).toContain("canonical.topology.trace-count");

    const duplicate = graph();
    tool(duplicate).spanId = llm(duplicate).spanId;
    expect(issues(duplicate)).toContain("canonical.topology.duplicate-span");

    const twoRoots = graph();
    delete tool(twoRoots).parentSpanId;
    expect(issues(twoRoots)).toContain("canonical.topology.root-count");

    const missingParent = graph();
    tool(missingParent).parentSpanId = "aaaaaaaaaaaaaaaa";
    expect(issues(missingParent)).toContain("canonical.topology.disconnected");

    const cycle = graph();
    llm(cycle).parentSpanId = tool(cycle).spanId;
    tool(cycle).parentSpanId = llm(cycle).spanId;
    expect(issues(cycle)).toContain("canonical.topology.disconnected");
  });

  it("enforces deterministic span order and root time containment", () => {
    const unordered = graph();
    spans(unordered).splice(1, 2, tool(unordered), llm(unordered));
    expect(issues(unordered)).toContain("canonical.span.order");

    const outsideRoot = graph();
    tool(outsideRoot).endTimeUnixNano = "5000000000";
    expect(issues(outsideRoot)).toContain("canonical.root.time-range");

    const tied = graph();
    tool(tied).startTimeUnixNano = llm(tied).startTimeUnixNano;
    expect(safeParseCanonicalTraceGraph(tied).success).toBe(true);

    const reverseTied = graph();
    tool(reverseTied).startTimeUnixNano = llm(reverseTied).startTimeUnixNano;
    spans(reverseTied).splice(1, 2, tool(reverseTied), llm(reverseTied));
    expect(issues(reverseTied)).toContain("canonical.span.order");
  });

  it("rejects unknown/colliding attributes and invalid OpenInference profiles", () => {
    const unknown = graph();
    tool(unknown).attributes!.push(
      stringAttribute("agentscope.tool.name", "x"),
    );
    sortAttributes(tool(unknown));
    expect(issues(unknown)).toContain("canonical.extension.unknown");

    const genAi = graph();
    tool(genAi).attributes!.push(stringAttribute("gen_ai.request.model", "x"));
    sortAttributes(tool(genAi));
    expect(issues(genAi)).toContain("canonical.attribute.gen-ai-alias");

    const prefix = graph();
    tool(prefix).attributes!.push(stringAttribute("llm.input_messages", "x"));
    sortAttributes(tool(prefix));
    expect(issues(prefix)).toContain("canonical.openinference.key");

    const wrongValue = graph();
    attribute(llm(wrongValue).attributes, "llm.model_name")!.value = {
      boolValue: true,
    };
    expect(issues(wrongValue)).toContain("canonical.openinference.value");

    const wrongKind = graph();
    tool(wrongKind).attributes!.push(
      stringAttribute("llm.model_name", "model"),
    );
    sortAttributes(tool(wrongKind));
    expect(issues(wrongKind)).toContain(
      "canonical.openinference.kind-applicability",
    );
  });
});

describe("redacted required OpenInference evidence", () => {
  it("accepts truthful redacted llm.system accounting without a sentinel", () => {
    const redacted = graph();
    removeAttribute(llm(redacted).attributes, "llm.system");
    const redactedUnavailable = unavailable(llm(redacted));
    redactedUnavailable.push({
      field: "llm.system",
      state: "redacted",
      reason: "policy-redacted",
    });
    redactedUnavailable.sort((left, right) =>
      left.field < right.field ? -1 : 1,
    );
    writeJsonAttribute(
      llm(redacted),
      "agentscope.mapping.unavailable",
      redactedUnavailable,
    );
    expect(safeParseCanonicalTraceGraph(redacted).success).toBe(true);
  });
});

describe("canonical evidence accounting", () => {
  it("accepts explicit unavailable llm.system/provider but rejects ambiguity", () => {
    const incomplete = graph();
    removeAttribute(llm(incomplete).attributes, "llm.system");
    const llmUnavailable = unavailable(llm(incomplete));
    llmUnavailable.push({
      field: "llm.system",
      state: "unavailable",
      reason: "not-emitted",
    });
    llmUnavailable.sort((left, right) => (left.field < right.field ? -1 : 1));
    writeJsonAttribute(
      llm(incomplete),
      "agentscope.mapping.unavailable",
      llmUnavailable,
    );
    expect(safeParseCanonicalTraceGraph(incomplete).success).toBe(true);

    const absent = graph();
    removeAttribute(llm(absent).attributes, "llm.system");
    expect(issues(absent)).toContain(
      "canonical.openinference.llm-system-accounting",
    );

    const empty = graph();
    attribute(llm(empty).attributes, "llm.system")!.value = { stringValue: "" };
    expect(issues(empty)).toContain("canonical.openinference.value");

    const contradictory = graph();
    const values = unavailable(llm(contradictory));
    values.push({
      field: "llm.system",
      state: "unavailable",
      reason: "not-emitted",
    });
    values.sort((left, right) => (left.field < right.field ? -1 : 1));
    writeJsonAttribute(
      llm(contradictory),
      "agentscope.mapping.unavailable",
      values,
    );
    expect(issues(contradictory)).toContain(
      "canonical.provenance.present-field",
    );
  });

  it("enforces per-field provenance, ordering, governed scope, and timing basis", () => {
    const missing = graph();
    const llmProvenance = provenance(llm(missing));
    llmProvenance.splice(
      llmProvenance.findIndex(({ field }) => field === "llm.model_name"),
      1,
    );
    writeJsonAttribute(
      llm(missing),
      "agentscope.mapping.provenance",
      llmProvenance,
    );
    expect(issues(missing)).toContain("canonical.provenance.present-field");

    const unordered = graph();
    const values = provenance(tool(unordered)).reverse();
    writeJsonAttribute(
      tool(unordered),
      "agentscope.mapping.provenance",
      values,
    );
    expect(issues(unordered)).toContain("canonical.provenance.order");

    const unknown = graph();
    const unknownValues = provenance(tool(unknown));
    unknownValues.push({ field: "service.secret", source: "derived" });
    unknownValues.sort((left, right) => (left.field < right.field ? -1 : 1));
    writeJsonAttribute(
      tool(unknown),
      "agentscope.mapping.provenance",
      unknownValues,
    );
    expect(issues(unknown)).toContain("canonical.provenance.ungoverned-field");

    const mismatchedTiming = graph();
    const timing = provenance(tool(mismatchedTiming));
    const start = timing.find(
      ({ field }) => field === "span.start_time_unix_nano",
    )!;
    start.timingBasis = "hook-observed-point";
    start.nativeState = "unavailable";
    writeJsonAttribute(
      tool(mismatchedTiming),
      "agentscope.mapping.provenance",
      timing,
    );
    expect(issues(mismatchedTiming)).toContain("canonical.provenance.timing");

    const point = graph();
    const pointTiming = provenance(tool(point));
    for (const item of pointTiming) {
      if (item.field.endsWith("time_unix_nano")) {
        item.timingBasis = "hook-observed-point";
        item.nativeState = "unavailable";
        item.source = "process";
      }
    }
    tool(point).endTimeUnixNano = tool(point).startTimeUnixNano;
    writeJsonAttribute(
      tool(point),
      "agentscope.mapping.provenance",
      pointTiming,
    );
    expect(safeParseCanonicalTraceGraph(point).success).toBe(true);
  });
});

describe("canonical structured evidence", () => {
  it("accounts indexed objects, flags, status, and all timing source states", () => {
    const noAttributes = graph();
    delete tool(noAttributes).attributes;
    expect(issues(noAttributes)).toContain("canonical.provenance.required");

    const indexed = graph();
    llm(indexed).attributes!.push(
      stringAttribute("llm.input_messages.3.message.role", "user"),
    );
    sortAttributes(llm(indexed));
    const indexedProvenance = provenance(llm(indexed));
    indexedProvenance.push({
      field: "llm.input_messages.3",
      source: "native-artifact",
    });
    indexedProvenance.sort((left, right) =>
      left.field < right.field ? -1 : 1,
    );
    writeJsonAttribute(
      llm(indexed),
      "agentscope.mapping.provenance",
      indexedProvenance,
    );
    expect(safeParseCanonicalTraceGraph(indexed).success).toBe(true);

    const structural = graph();
    tool(structural).flags = 1;
    tool(structural).status = { code: 2, message: "fixture failure" };
    const structuralProvenance = provenance(tool(structural));
    structuralProvenance.push(
      { field: "span.flags", source: "native-artifact" },
      { field: "span.status.code", source: "native-artifact" },
      { field: "span.status.message", source: "native-artifact" },
    );
    structuralProvenance.sort((left, right) =>
      left.field < right.field ? -1 : 1,
    );
    writeJsonAttribute(
      tool(structural),
      "agentscope.mapping.provenance",
      structuralProvenance,
    );
    removeAttribute(
      root(structural).attributes,
      "agentscope.mapping.unavailable",
    );
    expect(safeParseCanonicalTraceGraph(structural).success).toBe(true);

    const statusWithoutMessage = graph();
    tool(statusWithoutMessage).status = { code: 1 };
    const statusProvenance = provenance(tool(statusWithoutMessage));
    statusProvenance.push({
      field: "span.status.code",
      source: "native-artifact",
    });
    statusProvenance.sort((left, right) => (left.field < right.field ? -1 : 1));
    writeJsonAttribute(
      tool(statusWithoutMessage),
      "agentscope.mapping.provenance",
      statusProvenance,
    );
    expect(safeParseCanonicalTraceGraph(statusWithoutMessage).success).toBe(
      true,
    );
  });
});

describe("canonical evidence boundaries", () => {
  it("supports group defaults with exact mixed-source terminal overrides", () => {
    const mixed = graph();
    llm(mixed).attributes!.push(
      stringAttribute("llm.input_messages.3.message.content", "redacted"),
      stringAttribute("llm.input_messages.3.message.role", "user"),
    );
    sortAttributes(llm(mixed));
    const mixedLedger = provenance(llm(mixed));
    mixedLedger.push(
      { field: "llm.input_messages.3", source: "native-artifact" },
      {
        field: "llm.input_messages.3.message.content",
        source: "derived",
      },
    );
    mixedLedger.sort((left, right) => (left.field < right.field ? -1 : 1));
    writeJsonAttribute(
      llm(mixed),
      "agentscope.mapping.provenance",
      mixedLedger,
    );
    expect(safeParseCanonicalTraceGraph(mixed).success).toBe(true);

    const exactOnly = graph();
    llm(exactOnly).attributes!.push(
      stringAttribute("llm.input_messages.3.message.content", "redacted"),
      stringAttribute("llm.input_messages.3.message.role", "user"),
    );
    sortAttributes(llm(exactOnly));
    const exactLedger = provenance(llm(exactOnly));
    exactLedger.push(
      {
        field: "llm.input_messages.3.message.content",
        source: "derived",
      },
      {
        field: "llm.input_messages.3.message.role",
        source: "native-artifact",
      },
    );
    exactLedger.sort((left, right) => (left.field < right.field ? -1 : 1));
    writeJsonAttribute(
      llm(exactOnly),
      "agentscope.mapping.provenance",
      exactLedger,
    );
    expect(safeParseCanonicalTraceGraph(exactOnly).success).toBe(true);

    exactLedger.splice(
      exactLedger.findIndex(({ field }) => field.endsWith("message.role")),
      1,
    );
    writeJsonAttribute(
      llm(exactOnly),
      "agentscope.mapping.provenance",
      exactLedger,
    );
    expect(issues(exactOnly)).toContain("canonical.provenance.present-field");
  });
});

describe("canonical provenance group resolution", () => {
  it("accepts ancestor, deepest-group, and exact-terminal precedence", () => {
    const value = graph();
    llm(value).attributes!.push(
      stringAttribute("llm.input_messages.3.message.role", "user"),
      stringAttribute(
        "llm.input_messages.3.message.contents.2.message_content.text",
        "redacted",
      ),
      stringAttribute(
        "llm.input_messages.3.message.contents.2.message_content.type",
        "text",
      ),
      stringAttribute(
        "llm.input_messages.3.message.contents.2.message_content.id",
        "content-id",
      ),
    );
    sortAttributes(llm(value));
    const ledger = provenance(llm(value));
    ledger.push(
      { field: "llm.input_messages.3", source: "native-artifact" },
      {
        field: "llm.input_messages.3.message.contents.2",
        source: "derived",
      },
      {
        field: "llm.input_messages.3.message.contents.2.message_content.id",
        source: "hook-payload",
      },
    );
    ledger.sort((left, right) => (left.field < right.field ? -1 : 1));
    writeJsonAttribute(llm(value), "agentscope.mapping.provenance", ledger);
    const positive = safeParseCanonicalTraceGraph(value);
    expect(positive.success ? [] : positive.error.issues).toEqual([]);
  });

  it("rejects groups without present members and groups in unavailable", () => {
    const withoutMember = graph();
    const ledger = provenance(llm(withoutMember));
    ledger.push({
      field: "llm.input_messages.9",
      source: "native-artifact",
    });
    ledger.sort((left, right) => (left.field < right.field ? -1 : 1));
    writeJsonAttribute(
      llm(withoutMember),
      "agentscope.mapping.provenance",
      ledger,
    );
    expect(issues(withoutMember)).toContain(
      "canonical.provenance.unknown-field",
    );

    const unavailableGroup = graph();
    const unavailableLedger = provenance(llm(unavailableGroup));
    unavailableLedger.push({
      field: "llm.input_messages.9",
      source: "native-artifact",
    });
    unavailableLedger.sort((left, right) =>
      left.field < right.field ? -1 : 1,
    );
    writeJsonAttribute(
      llm(unavailableGroup),
      "agentscope.mapping.provenance",
      unavailableLedger,
    );
    writeJsonAttribute(
      llm(unavailableGroup),
      "agentscope.mapping.unavailable",
      [
        {
          field: "llm.input_messages.9",
          state: "unavailable",
          reason: "not-emitted",
        },
      ],
    );
    expect(issues(unavailableGroup)).toContain(
      "canonical.provenance.unavailable-field",
    );
  });

  it("rejects a group wholly shadowed by exact terminal claims", () => {
    const value = graph();
    llm(value).attributes!.push(
      stringAttribute("llm.input_messages.3.message.role", "user"),
      stringAttribute("llm.input_messages.3.message.name", "assistant"),
    );
    sortAttributes(llm(value));
    const ledger = provenance(llm(value));
    ledger.push(
      { field: "llm.input_messages.3", source: "derived" },
      {
        field: "llm.input_messages.3.message.name",
        source: "native-artifact",
      },
      {
        field: "llm.input_messages.3.message.role",
        source: "native-artifact",
      },
    );
    ledger.sort((left, right) => (left.field < right.field ? -1 : 1));
    writeJsonAttribute(llm(value), "agentscope.mapping.provenance", ledger);
    expect(issues(value)).toContain("canonical.provenance.unknown-field");
  });
});

describe("canonical timing compatibility", () => {
  it("enforces every descriptor-defined timing source combination", () => {
    const combinations = TIMING_BASES.flatMap((timingBasis) =>
      NATIVE_STATES.flatMap((nativeState) =>
        PROVENANCE_SOURCES.map((source) => ({
          timingBasis,
          nativeState,
          source,
          location: "span" as const,
        })),
      ),
    );
    for (const combination of combinations) {
      expect(
        safeParseCanonicalTraceGraph(
          graphWithTiming(
            combination.timingBasis,
            combination.nativeState,
            combination.source,
          ),
        ).success,
      ).toBe(isTimingProvenanceCompatible(combination));
    }
  });

  it("builds a truthful derived root envelope from mixed child timing", () => {
    const value = graph();
    llm(value).endTimeUnixNano = llm(value).startTimeUnixNano;
    setSpanTiming(llm(value), "native-point", "observed", "native-artifact");
    tool(value).endTimeUnixNano = tool(value).startTimeUnixNano;
    setSpanTiming(
      tool(value),
      "artifact-point",
      "unavailable",
      "native-artifact",
    );
    root(value).startTimeUnixNano = llm(value).startTimeUnixNano;
    root(value).endTimeUnixNano = tool(value).endTimeUnixNano;
    setSpanTiming(
      root(value),
      "derived-child-envelope",
      "unavailable",
      "derived",
    );
    expect(safeParseCanonicalTraceGraph(value).success).toBe(true);

    root(value).endTimeUnixNano = "2700000000";
    expect(issues(value)).toContain("canonical.provenance.timing-envelope");
  });

  it("rejects a derived envelope when the root has no children", () => {
    const value = graph();
    resource(value).scopeSpans[0]!.spans = [root(value)];
    setSpanTiming(
      root(value),
      "derived-child-envelope",
      "unavailable",
      "derived",
    );
    expect(issues(value)).toContain("canonical.provenance.timing-envelope");
  });
});

describe("canonical evidence limits and kinds", () => {
  it("rejects inconsistent timing states and evidence ledger overflow", () => {
    for (const [basis, state] of [
      ["native-point", "unavailable"],
      ["artifact-point", "observed"],
    ] as const) {
      const invalidTiming = graph();
      const ledger = provenance(tool(invalidTiming));
      for (const item of ledger) {
        if (item.field.endsWith("time_unix_nano")) {
          item.timingBasis = basis;
          item.nativeState = state;
        }
      }
      tool(invalidTiming).endTimeUnixNano =
        tool(invalidTiming).startTimeUnixNano;
      writeJsonAttribute(
        tool(invalidTiming),
        "agentscope.mapping.provenance",
        ledger,
      );
      expect(issues(invalidTiming)).toContain(
        "canonical.provenance.timing-source",
      );
    }

    const pointInterval = graph();
    const pointIntervalLedger = provenance(tool(pointInterval));
    for (const item of pointIntervalLedger) {
      if (item.field.endsWith("time_unix_nano")) {
        item.timingBasis = "hook-observed-point";
        item.nativeState = "unavailable";
        item.source = "process";
      }
    }
    writeJsonAttribute(
      tool(pointInterval),
      "agentscope.mapping.provenance",
      pointIntervalLedger,
    );
    expect(issues(pointInterval)).toContain("canonical.provenance.point-time");

    const nonTimeBasis = graph();
    const nonTimeLedger = provenance(llm(nonTimeBasis));
    const model = nonTimeLedger.find(
      ({ field }) => field === "llm.model_name",
    )!;
    model.timingBasis = "native-point";
    model.nativeState = "observed";
    writeJsonAttribute(
      llm(nonTimeBasis),
      "agentscope.mapping.provenance",
      nonTimeLedger,
    );
    expect(issues(nonTimeBasis)).toContain(
      "canonical.provenance.non-time-basis",
    );

    const overBudget = graph();
    const overBudgetProvenance = provenance(tool(overBudget));
    const overBudgetUnavailable: FieldUnavailable = [];
    for (let index = 0; index < 100; index += 1) {
      const field = `llm.input_messages.${index}`;
      overBudgetProvenance.push({ field, source: "derived" });
      overBudgetUnavailable.push({
        field,
        state: "unavailable",
        reason: "not-emitted",
      });
    }
    overBudgetProvenance.sort((left, right) =>
      left.field < right.field ? -1 : 1,
    );
    overBudgetUnavailable.sort((left, right) =>
      left.field < right.field ? -1 : 1,
    );
    writeJsonAttribute(
      tool(overBudget),
      "agentscope.mapping.provenance",
      overBudgetProvenance,
    );
    writeJsonAttribute(
      tool(overBudget),
      "agentscope.mapping.unavailable",
      overBudgetUnavailable,
    );
    expect(issues(overBudget)).toContain("canonical.provenance.field-budget");
  });

  it.each([
    ["embedding.embeddings.0", "EMBEDDING"],
    ["retrieval.documents.0", "RETRIEVER"],
    ["reranker.input_documents.0", "RERANKER"],
  ] as const)("kind-scopes grouped evidence %s to %s", (field, kind) => {
    const value = graph();
    attribute(tool(value).attributes, "openinference.span.kind")!.value = {
      stringValue: kind,
    };
    if (kind === "EMBEDDING") tool(value).name = "CreateEmbeddings";
    const ledger = provenance(tool(value));
    ledger.push({ field, source: "native-artifact" });
    ledger.sort((left, right) => (left.field < right.field ? -1 : 1));
    writeJsonAttribute(tool(value), "agentscope.mapping.provenance", ledger);
    expect(issues(value)).toContain("canonical.provenance.unknown-field");
  });
});

describe("canonical OTLP data-loss policy", () => {
  it("aligns retained event members to original indices and validates attribute suffixes", () => {
    const value = graph();
    tool(value).events = [
      {
        name: "exception",
        timeUnixNano: "2700000000",
        attributes: [stringAttribute("exception.type", "SafeError")],
      },
    ];
    const entries = provenance(tool(value));
    entries.push(
      { field: "span.events", source: "derived" },
      { field: "span.events.2.event", source: "derived" },
      { field: "span.events.2.name", source: "native-artifact" },
      {
        field: "span.events.2.time_unix_nano",
        source: "native-artifact",
      },
      {
        field: "span.events.2.attributes.exception.type",
        source: "native-artifact",
      },
    );
    entries.sort((left, right) => (left.field < right.field ? -1 : 1));
    writeJsonAttribute(tool(value), "agentscope.mapping.provenance", entries);
    const rootEntries = provenance(root(value));
    rootEntries.sort((left, right) => (left.field < right.field ? -1 : 1));
    writeJsonAttribute(
      root(value),
      "agentscope.mapping.provenance",
      rootEntries,
    );
    const remainingUnavailable = unavailable(root(value)).filter(
      ({ field }) => field !== "family.error.activity",
    );
    if (remainingUnavailable.length === 0)
      removeAttribute(root(value).attributes, "agentscope.mapping.unavailable");
    else
      writeJsonAttribute(
        root(value),
        "agentscope.mapping.unavailable",
        remainingUnavailable,
      );
    const memberPositive = safeParseCanonicalTraceGraph(value);
    expect(memberPositive.success ? [] : memberPositive.error.issues).toEqual(
      [],
    );

    const missingExistence = structuredClone(value);
    writeJsonAttribute(
      tool(missingExistence),
      "agentscope.mapping.provenance",
      provenance(tool(missingExistence)).filter(
        ({ field }) => field !== "span.events.2.event",
      ),
    );
    expect(issues(missingExistence)).toContain(
      "canonical.provenance.member-order",
    );

    const invalidSuffix = structuredClone(value);
    tool(invalidSuffix).events![0]!.attributes = [
      stringAttribute("input.value", "safe"),
    ];
    const invalidEntries = provenance(tool(invalidSuffix)).filter(
      ({ field }) => field !== "span.events.2.attributes.exception.type",
    );
    invalidEntries.push({
      field: "span.events.2.attributes.input.value",
      source: "native-artifact",
    });
    invalidEntries.sort((left, right) => (left.field < right.field ? -1 : 1));
    writeJsonAttribute(
      tool(invalidSuffix),
      "agentscope.mapping.provenance",
      invalidEntries,
    );
    expect(issues(invalidSuffix)).toContain(
      "canonical.provenance.member-field",
    );
  });
});

describe("canonical OTLP loss-signal rejection", () => {
  it("rejects dropped data, invalid context flags, and malformed exception events", () => {
    const dropped = graph();
    tool(dropped).droppedEventsCount = 1;
    expect(issues(dropped)).toContain("canonical.dropped.span-data");

    const traceState = graph();
    tool(traceState).traceState = "vendor=value";
    expect(issues(traceState)).toContain("canonical.span.context");

    const badLink = graph();
    tool(badLink).links = [
      {
        traceId: tool(badLink).traceId,
        spanId: root(badLink).spanId,
        flags: 512,
      },
    ];
    expect(issues(badLink)).toContain("canonical.link.context");

    const remoteLink = graph();
    tool(remoteLink).links = [
      {
        traceId: tool(remoteLink).traceId,
        spanId: root(remoteLink).spanId,
        flags: 768,
      },
    ];
    const linkProvenance = provenance(tool(remoteLink));
    linkProvenance.push({ field: "span.links", source: "native-artifact" });
    linkProvenance.push({
      field: "span.links.0.link",
      source: "native-artifact",
    });
    linkProvenance.push({
      field: "span.links.0.relationship",
      source: "native-artifact",
    });
    linkProvenance.push({
      field: "span.links.0.target_ids",
      source: "native-artifact",
    });
    linkProvenance.push({
      field: "span.links.target_ids",
      source: "native-artifact",
    });
    linkProvenance.sort((left, right) => (left.field < right.field ? -1 : 1));
    writeJsonAttribute(
      tool(remoteLink),
      "agentscope.mapping.provenance",
      linkProvenance,
    );
    expect(safeParseCanonicalTraceGraph(remoteLink).success).toBe(true);

    const badEvent = graph();
    tool(badEvent).events = [
      {
        timeUnixNano: "2700000000",
        name: "wrong-name",
        attributes: [stringAttribute("exception.type", "FixtureError")],
      },
    ];
    expect(issues(badEvent)).toContain("canonical.exception.event-name");
  });
});

describe("canonical remote-context loss rejection", () => {
  it("rejects every dropped-data and remote-context loss signal", () => {
    const resourceDropped = graph();
    resource(resourceDropped).resource!.droppedAttributesCount = 1;
    expect(issues(resourceDropped)).toContain(
      "canonical.dropped.resource-attributes",
    );

    const eventDropped = graph();
    tool(eventDropped).events = [
      {
        timeUnixNano: "2700000000",
        name: "fixture",
        droppedAttributesCount: 1,
      },
    ];
    expect(issues(eventDropped)).toContain(
      "canonical.dropped.event-attributes",
    );

    const linkDropped = graph();
    tool(linkDropped).links = [
      {
        traceId: tool(linkDropped).traceId,
        spanId: root(linkDropped).spanId,
        droppedAttributesCount: 1,
        traceState: "vendor=value",
      },
    ];
    expect(issues(linkDropped)).toContain("canonical.link.context");

    const defaultLinkFlags = graph();
    tool(defaultLinkFlags).links = [
      {
        traceId: tool(defaultLinkFlags).traceId,
        spanId: root(defaultLinkFlags).spanId,
      },
    ];
    const defaultLinkProvenance = provenance(tool(defaultLinkFlags));
    defaultLinkProvenance.push({
      field: "span.links",
      source: "native-artifact",
    });
    defaultLinkProvenance.push({
      field: "span.links.0.link",
      source: "native-artifact",
    });
    defaultLinkProvenance.push({
      field: "span.links.0.relationship",
      source: "native-artifact",
    });
    defaultLinkProvenance.push({
      field: "span.links.0.target_ids",
      source: "native-artifact",
    });
    defaultLinkProvenance.push({
      field: "span.links.target_ids",
      source: "native-artifact",
    });
    defaultLinkProvenance.sort((left, right) =>
      left.field < right.field ? -1 : 1,
    );
    writeJsonAttribute(
      tool(defaultLinkFlags),
      "agentscope.mapping.provenance",
      defaultLinkProvenance,
    );
    expect(safeParseCanonicalTraceGraph(defaultLinkFlags).success).toBe(true);
  });
});

describe("canonical required extensions and applicability", () => {
  it("rejects missing required resource, root, and per-span extensions", () => {
    const missingResourceMessage = graph();
    delete resource(missingResourceMessage).resource;
    expect(issues(missingResourceMessage)).toContain(
      "canonical.resource.manifest",
    );

    const missingResource = graph();
    removeAttribute(
      resource(missingResource).resource?.attributes,
      "agentscope.protocol.manifest_id",
    );
    expect(issues(missingResource)).toContain(
      "canonical.extension.required-resource",
    );

    const missingRoot = graph();
    removeAttribute(
      root(missingRoot).attributes,
      "agentscope.redaction.policy_id",
    );
    expect(issues(missingRoot)).toContain("canonical.extension.required-root");

    const missingSpan = graph();
    removeAttribute(
      tool(missingSpan).attributes,
      "agentscope.mapping.provenance",
    );
    expect(issues(missingSpan)).toContain("canonical.extension.required-span");
    expect(issues(missingSpan)).toContain("canonical.provenance.required");
  });

  it("enforces extension location, span kind, scalar type, and JSON shape", () => {
    const wrongLocation = graph();
    tool(wrongLocation).attributes!.push(
      stringAttribute("agentscope.harness.name", "fixture"),
    );
    sortAttributes(tool(wrongLocation));
    expect(issues(wrongLocation)).toContain("canonical.extension.location");
    expect(issues(wrongLocation)).toContain("canonical.extension.span-kind");

    const wrongScalar = graph();
    attribute(root(wrongScalar).attributes, "agentscope.harness.name")!.value =
      {
        boolValue: true,
      };
    expect(issues(wrongScalar)).toContain("canonical.extension.value");

    const wrongJson = graph();
    attribute(
      root(wrongJson).attributes,
      "agentscope.mapping.unavailable",
    )!.value = { stringValue: "not-json" };
    expect(issues(wrongJson)).toContain("canonical.extension.value");
  });

  it("rejects missing, wrong-root, and embedding-specific OI semantics", () => {
    const missingKind = graph();
    removeAttribute(root(missingKind).attributes, "openinference.span.kind");
    expect(issues(missingKind)).toContain("canonical.openinference.span-kind");
    expect(issues(missingKind)).toContain("canonical.extension.span-kind");

    const missingLlmKind = graph();
    removeAttribute(llm(missingLlmKind).attributes, "openinference.span.kind");
    expect(issues(missingLlmKind)).toContain(
      "canonical.provenance.ungoverned-field",
    );

    const wrongRoot = graph();
    attribute(root(wrongRoot).attributes, "openinference.span.kind")!.value = {
      stringValue: "TOOL",
    };
    expect(issues(wrongRoot)).toContain("canonical.root.kind");

    const embedding = graph();
    attribute(tool(embedding).attributes, "openinference.span.kind")!.value = {
      stringValue: "EMBEDDING",
    };
    tool(embedding).attributes!.push(
      stringAttribute("llm.provider", "fixture"),
    );
    sortAttributes(tool(embedding));
    expect(issues(embedding)).toContain(
      "canonical.openinference.embedding-llm-identity",
    );
    expect(issues(embedding)).toContain(
      "canonical.openinference.embedding-name",
    );
  });
});

describe("standalone post-hoc feedback root", () => {
  it("allows any valid OI kind only for a standalone strict post-hoc feedback root", () => {
    expect(() =>
      parseCanonicalTraceGraph(standalonePostHocToolFeedback()),
    ).not.toThrow();

    const inline = standalonePostHocToolFeedback();
    attribute(root(inline).attributes, "agentscope.feedback.transport")!.value =
      { stringValue: "inline" };
    expect(issues(inline)).toContain("canonical.root.kind");

    const incomplete = standalonePostHocToolFeedback();
    removeAttribute(
      root(incomplete).attributes,
      "annotations.0.annotation.label",
    );
    expect(issues(incomplete)).toContain("canonical.root.kind");

    const ordinaryGraph = graph();
    attribute(
      root(ordinaryGraph).attributes,
      "openinference.span.kind",
    )!.value = { stringValue: "TOOL" };
    expect(issues(ordinaryGraph)).toContain("canonical.root.kind");
  });

  it("accepts complete markerless standalone feedback only at the tolerant seam", () => {
    const markerless = standalonePostHocToolFeedback();
    const carrier = root(markerless);
    removeAttribute(carrier.attributes, "agentscope.feedback.transport");
    writeJsonAttribute(
      carrier,
      "agentscope.mapping.provenance",
      provenance(carrier).filter(
        ({ field }) => field !== "agentscope.feedback.transport",
      ),
    );
    expect(safeParseCanonicalTraceGraph(markerless).success).toBe(false);
    const tolerant = safeParseTolerantCanonicalTraceGraph(markerless);
    expect(
      tolerant,
      tolerant.success ? "" : tolerant.error.issues.join(","),
    ).toMatchObject({ success: true });
  });
});

describe("canonical required extensions and applicability", () => {
  it("validates adopted exception and error attributes", () => {
    const invalidEscaped = graph();
    tool(invalidEscaped).events = [
      {
        timeUnixNano: "2700000000",
        name: "exception",
        attributes: [stringAttribute("exception.escaped", "true")],
      },
    ];
    expect(issues(invalidEscaped)).toContain("canonical.attribute.value");

    const errorType = graph();
    tool(errorType).attributes!.push(
      stringAttribute("error.type", "FixtureError"),
    );
    sortAttributes(tool(errorType));
    const errorProvenance = provenance(tool(errorType));
    errorProvenance.push({ field: "error.type", source: "native-artifact" });
    errorProvenance.sort((left, right) => (left.field < right.field ? -1 : 1));
    writeJsonAttribute(
      tool(errorType),
      "agentscope.mapping.provenance",
      errorProvenance,
    );
    removeAttribute(
      root(errorType).attributes,
      "agentscope.mapping.unavailable",
    );
    const rootProvenance = provenance(root(errorType));
    const activity = rootProvenance.find(
      ({ field }) => field === "family.error.activity",
    );
    expect(activity).toBeDefined();
    expect(safeParseCanonicalTraceGraph(errorType).success).toBe(true);
  });
});
