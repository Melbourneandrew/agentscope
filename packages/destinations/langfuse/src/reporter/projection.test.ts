import { createSanitizedCanonicalTraceFixture } from "@agentscope/protocol/testing";
import { describe, expect, it } from "vitest";

import { deriveLangfuseProjectionFilterKey } from "../compatibility.js";
import { LangfuseProjectionError, projectLangfuseRoot } from "./projection.js";

type Resource = Parameters<typeof projectLangfuseRoot>[0];
type Attribute = NonNullable<
  NonNullable<
    Resource["scopeSpans"][number]["spans"][number]["attributes"]
  >[number]
>;

const resource = (): Resource =>
  (
    createSanitizedCanonicalTraceFixture() as {
      resourceSpans: Resource[];
    }
  ).resourceSpans[0]!;

const spans = (value: Resource) =>
  value.scopeSpans.flatMap((scope) => scope.spans);

const root = (value: Resource) =>
  spans(value).find((span) => span.parentSpanId === undefined)!;

const attribute = (key: string, value: Attribute["value"]): Attribute => ({
  key,
  value,
});

const setTags = (value: Resource, tags: readonly string[]): void => {
  root(value).attributes ??= [];
  root(value).attributes!.push(
    attribute("tag.tags", {
      arrayValue: { values: tags.map((tag) => ({ stringValue: tag })) },
    }),
  );
};

const expectInvalid = (value: Resource): void => {
  expect(() => projectLangfuseRoot(value)).toThrowError(
    LangfuseProjectionError,
  );
};

describe("Langfuse root projection boundaries", () => {
  it.each([
    [1, "ok"],
    [2, "error"],
  ] as const)("projects canonical status code %i as %s", (code, status) => {
    const value = resource();
    root(value).status = { code };
    expect(projectLangfuseRoot(value).metadata.agentscope_status).toBe(status);
  });

  it("omits absent optional fields and keeps duplicate values once", () => {
    const value = resource();
    delete value.resource;
    delete root(value).attributes;
    const model = spans(value)[1]!;
    model.attributes = model.attributes!.filter(
      ({ key }) => key !== "llm.model_name",
    );
    setTags(value, ["same", "same"]);
    const result = projectLangfuseRoot(value);
    expect(result).toEqual({
      metadata: {
        agentscope_models_count: "0",
        agentscope_root: "true",
        agentscope_span_count: "3",
        agentscope_status: "unset",
        agentscope_tag_00: "same",
        [deriveLangfuseProjectionFilterKey("tag", "same")]: "same",
        agentscope_tags_count: "1",
      },
      tags: ["same"],
    });
  });

  it("omits the tag overlay and creates attributes for an attribute-free root", () => {
    const value = resource();
    delete value.resource;
    const valueSpans = spans(value);
    for (const span of valueSpans) {
      if (span.attributes !== undefined)
        span.attributes = span.attributes.filter(
          ({ key }) => key !== "llm.model_name" && key !== "tag.tags",
        );
    }
    delete root(value).attributes;
    const result = projectLangfuseRoot(value);
    expect(result.tags).toEqual([]);
    expect(root(value).attributes).not.toContainEqual(
      expect.objectContaining({ key: "langfuse.trace.tags" }),
    );
  });

  it("projects every governed model attribute in canonical first-occurrence order", () => {
    const value = resource();
    for (const span of spans(value))
      span.attributes = (span.attributes ?? []).filter(
        ({ key }) =>
          ![
            "llm.model_name",
            "embedding.model_name",
            "reranker.model_name",
          ].includes(key),
      );
    root(value).attributes!.push(
      attribute("embedding.model_name", { stringValue: "embedding-model" }),
    );
    spans(value)[1]!.attributes!.push(
      attribute("llm.model_name", { stringValue: "llm-model" }),
      attribute("reranker.model_name", { stringValue: "reranker-model" }),
      attribute("embedding.model_name", { stringValue: "embedding-model" }),
    );
    expect(projectLangfuseRoot(value)).toMatchObject({
      metadata: {
        agentscope_models_count: "3",
        agentscope_model_00: "embedding-model",
        agentscope_model_01: "llm-model",
        agentscope_model_02: "reranker-model",
      },
      tags: [
        "agentscope:model:embedding-model",
        "agentscope:model:llm-model",
        "agentscope:model:reranker-model",
      ],
    });
  });

  it("rejects malformed tag shapes and non-string members", () => {
    const scalar = resource();
    root(scalar).attributes!.push(
      attribute("tag.tags", { stringValue: "not-an-array" }),
    );
    expectInvalid(scalar);
    const member = resource();
    root(member).attributes!.push(
      attribute("tag.tags", {
        arrayValue: { values: [{ boolValue: true }] },
      }),
    );
    expectInvalid(member);
  });

  it("rejects preexisting provider-owned projection attributes", () => {
    for (const key of [
      "langfuse.observation.metadata.agentscope_root",
      "langfuse.trace.metadata.agentscope_root",
      "langfuse.observation.metadata.agentscope_model_31",
      "langfuse.trace.metadata.agentscope_tag_31",
      "langfuse.observation.metadata.agentscope_model_exact_caller",
      "langfuse.trace.metadata.agentscope_tag_exact_caller",
      "langfuse.trace.tags",
    ]) {
      const value = resource();
      root(value).attributes!.push(attribute(key, { stringValue: "caller" }));
      expectInvalid(value);
    }
    const child = resource();
    spans(child)[1]!.attributes!.push(
      attribute("langfuse.trace.tags", { stringValue: "caller" }),
    );
    expectInvalid(child);
  });
});

describe("Langfuse root projection limits", () => {
  it.each(["\ud800", "\udc00", "", "e\u0301", "x".repeat(201)])(
    "rejects the noncanonical projection value %j",
    (tag) => {
      const value = resource();
      setTags(value, [tag]);
      expectInvalid(value);
    },
  );

  it("rejects excess values and the aggregate projection byte ceiling", () => {
    const excess = resource();
    setTags(
      excess,
      Array.from({ length: 33 }, (_, index) => `tag-${index}`),
    );
    expectInvalid(excess);
    const oversized = resource();
    setTags(
      oversized,
      Array.from(
        { length: 32 },
        (_, index) => `${index.toString().padStart(2, "0")}${"😀".repeat(198)}`,
      ),
    );
    expectInvalid(oversized);
  });

  it("rejects missing, duplicate, empty, and oversized root topology", () => {
    const missing = resource();
    for (const span of spans(missing)) span.parentSpanId = "a".repeat(16);
    expectInvalid(missing);
    const duplicate = resource();
    delete spans(duplicate)[1]!.parentSpanId;
    expectInvalid(duplicate);
    const empty = resource();
    empty.scopeSpans[0]!.spans = [];
    expectInvalid(empty);
    const oversized = resource();
    const exemplar = spans(oversized)[1]!;
    oversized.scopeSpans[0]!.spans = [
      root(oversized),
      ...Array.from({ length: 256 }, () => structuredClone(exemplar)),
    ];
    expectInvalid(oversized);
  });

  it("treats a malformed model value as absent at this post-brand helper seam", () => {
    const value = resource();
    const model = spans(value)[1]!;
    const entry = model.attributes!.find(
      ({ key }) => key === "llm.model_name",
    )!;
    entry.value = { intValue: "1" };
    expect(projectLangfuseRoot(value).metadata).toMatchObject({
      agentscope_models_count: "0",
    });
  });
});
