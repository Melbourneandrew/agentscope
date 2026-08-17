import { OpenInferenceSpanKind } from "@arizeai/openinference-semantic-conventions";
import { describe, expect, it } from "vitest";

import {
  createSemanticOtlpValue,
  getOpenInferenceAttributeProfile,
  getKnownOpenInferenceAttributeProfile,
  isOpenInferenceAttributeKey,
  isOpenInferenceValueValid,
  isSemanticCandidateValueValid,
  isValidOpenInferenceAttributeKey,
  OPENINFERENCE_SPAN_KINDS,
  SemanticValueError,
  validateOpenInferenceSpanKindInventory,
} from "./openinference.js";
import { getAcceptedSemanticAttributeDescriptor } from "./semantic-profile.js";

const profileFor = (key: string) => {
  const profile = getOpenInferenceAttributeProfile(key);
  expect(profile).toBeDefined();
  return profile!;
};
const candidateProfileFor = (key: string) => {
  const profile = getAcceptedSemanticAttributeDescriptor(key);
  expect(profile).toBeDefined();
  return profile!;
};

describe("pinned OpenInference attribute profile", () => {
  it("binds the typed kind tuple exactly to the pinned descriptor", () => {
    expect(OPENINFERENCE_SPAN_KINDS).toEqual(
      getAcceptedSemanticAttributeDescriptor("openinference.span.kind")
        ?.allowedValues,
    );
    expect(Object.isFrozen(OPENINFERENCE_SPAN_KINDS)).toBe(true);
    expect(() => {
      validateOpenInferenceSpanKindInventory(["ATTACKER"]);
    }).toThrow("protocol.semantic-profile.kind-drift");
  });

  it("validates logical candidate values before OTLP construction", () => {
    const valid = [
      ["input.value", ""],
      ["metadata", '{"safe":true}'],
      ["llm.token_count.total", 3],
      ["llm.cost.total", 0.25],
      ["exception.escaped", false],
      ["tag.tags", ["one"]],
      ["embedding.embeddings.0.embedding.vector", [0.1, 0.2]],
      ["retrieval.documents.0.document.id", "document"],
      ["retrieval.documents.0.document.id", 7],
    ] as const;
    for (const [key, value] of valid)
      expect(
        isSemanticCandidateValueValid(candidateProfileFor(key), value),
      ).toBe(true);
    for (const value of ["not-json", "[]", "null", "1"])
      expect(
        isSemanticCandidateValueValid(candidateProfileFor("metadata"), value),
      ).toBe(false);
    for (const value of [
      null,
      { raw: true },
      Number.POSITIVE_INFINITY,
      ["one", 2],
    ])
      expect(
        isSemanticCandidateValueValid(candidateProfileFor("tag.tags"), value),
      ).toBe(false);
  });

  it.each([
    "llm.input_messages.0.message.role",
    "llm.output_messages.12.message.contents.3.message_content.image.image.url",
    "llm.input_messages.2.message.contents.4.message_content.audio.audio.url",
    "llm.input_messages.2.message.contents.4.tool_call.function.arguments",
    "llm.input_messages.2.message.contents.4.tool_call.function.name",
    "llm.output_messages.1.message.tool_calls.7.tool_call.id",
    "llm.prompts.0.prompt.text",
    "llm.choices.9.completion.text",
    "llm.tools.3.tool.json_schema",
    "embedding.embeddings.0.embedding.vector",
    "retrieval.documents.4.document.metadata",
    "reranker.output_documents.2.document.score",
    "llm.token_count.prompt_details.vendor_cache",
  ])("accepts exact flattened terminal %s", (key) => {
    expect(isValidOpenInferenceAttributeKey(key)).toBe(true);
  });

  it.each([
    "llm.input_messages",
    "llm.input_messages.01.message.role",
    "llm.input_messages.10000.message.role",
    "llm.prompts.0",
    "llm.prompts.0.prompt",
    "llm.tools.0.tool.name",
    "embedding.text",
    "embedding.embeddings.0.embedding.model_name",
    "llm.input_messages.0.message.contents.0.message_content.image.url",
    "llm.output_messages.0.message.contents.0.message_content.audio.audio.url",
    "llm.input_messages.0.message.contents.0.message_content.audio.audio.mime_type",
    "llm.input_messages.0.message.contents.0.tool_call.id.name",
    "annotations.00.annotation.name",
    "llm.token_count.prompt_details.Bad-Key",
  ])("rejects prefix, fragment, or malformed terminal %s", (key) => {
    expect(isValidOpenInferenceAttributeKey(key)).toBe(false);
  });

  it("distinguishes OpenInference namespaces from unrelated attributes", () => {
    expect(isOpenInferenceAttributeKey("llm.model_name")).toBe(true);
    expect(isOpenInferenceAttributeKey("custom.model_name")).toBe(false);
    expect(isOpenInferenceAttributeKey("")).toBe(false);
    expect(
      getKnownOpenInferenceAttributeProfile(
        "annotations.0.annotation.explanation",
      )?.support,
    ).toBe("accepted");
    expect(
      getKnownOpenInferenceAttributeProfile("service.name"),
    ).toBeUndefined();
  });
});

describe("pinned graph parent value profile", () => {
  it("permits the pinned empty graph parent root marker", () => {
    expect(
      isOpenInferenceValueValid(profileFor("graph.node.parent_id"), {
        stringValue: "",
      }),
    ).toBe(true);
  });
});

describe("pinned OpenInference value profiles", () => {
  it("validates direct and flattened value categories", () => {
    expect(
      isOpenInferenceValueValid(profileFor("input.value"), { stringValue: "" }),
    ).toBe(true);
    expect(
      isOpenInferenceValueValid(profileFor("llm.system"), { stringValue: "" }),
    ).toBe(false);
    expect(
      isOpenInferenceValueValid(profileFor("llm.invocation_parameters"), {
        stringValue: '{"temperature":0}',
      }),
    ).toBe(true);
    expect(
      isOpenInferenceValueValid(profileFor("llm.invocation_parameters"), {
        stringValue: "not-json",
      }),
    ).toBe(false);
    expect(
      isOpenInferenceValueValid(profileFor("metadata"), {
        stringValue: "[]",
      }),
    ).toBe(false);
    expect(
      isOpenInferenceValueValid(profileFor("llm.token_count.total"), {
        intValue: "3",
      }),
    ).toBe(true);
    expect(
      isOpenInferenceValueValid(profileFor("llm.token_count.total"), {
        intValue: "-1",
      }),
    ).toBe(false);
    expect(
      isOpenInferenceValueValid(profileFor("llm.cost.total"), {
        doubleValue: 0.5,
      }),
    ).toBe(true);
    expect(
      isOpenInferenceValueValid(profileFor("tag.tags"), {
        arrayValue: { values: [{ stringValue: "fixture" }] },
      }),
    ).toBe(true);
    expect(
      isOpenInferenceValueValid(profileFor("tag.tags"), {
        arrayValue: { values: [{ stringValue: "" }] },
      }),
    ).toBe(false);
    expect(
      isOpenInferenceValueValid(
        profileFor("embedding.embeddings.0.embedding.vector"),
        { arrayValue: { values: [{ doubleValue: 0.25 }] } },
      ),
    ).toBe(true);
    expect(
      isOpenInferenceValueValid(
        profileFor("retrieval.documents.0.document.id"),
        { intValue: "1" },
      ),
    ).toBe(true);
    expect(
      isOpenInferenceValueValid(
        profileFor("retrieval.documents.0.document.id"),
        { stringValue: "" },
      ),
    ).toBe(false);
    expect(
      isOpenInferenceValueValid({ valueType: "number" }, { doubleValue: 0.75 }),
    ).toBe(true);
    expect(
      isOpenInferenceValueValid(
        { valueType: "string", kinds: [OpenInferenceSpanKind.LLM] },
        { boolValue: true },
      ),
    ).toBe(false);
  });
});

describe("invalid OpenInference value categories", () => {
  it("rejects every mismatched value category and invalid JSON shape", () => {
    expect(
      isOpenInferenceValueValid(profileFor("openinference.span.kind"), {
        stringValue: "FUTURE_KIND",
      }),
    ).toBe(false);
    expect(
      isOpenInferenceValueValid(profileFor("metadata"), {
        stringValue: "null",
      }),
    ).toBe(false);
    expect(
      isOpenInferenceValueValid(profileFor("metadata"), {
        stringValue: "{invalid",
      }),
    ).toBe(false);
    expect(
      isOpenInferenceValueValid(profileFor("llm.invocation_parameters"), {
        boolValue: true,
      }),
    ).toBe(false);
    expect(
      isOpenInferenceValueValid(profileFor("llm.token_count.total"), {
        doubleValue: 1,
      }),
    ).toBe(false);
    expect(
      isOpenInferenceValueValid(profileFor("llm.cost.total"), {
        intValue: "1",
      }),
    ).toBe(false);
    expect(
      isOpenInferenceValueValid(profileFor("tag.tags"), {
        arrayValue: { values: [{ boolValue: true }] },
      }),
    ).toBe(false);
    expect(
      isOpenInferenceValueValid(
        profileFor("embedding.embeddings.0.embedding.vector"),
        { arrayValue: { values: [{ intValue: "1" }] } },
      ),
    ).toBe(false);
    expect(
      isOpenInferenceValueValid(
        profileFor("retrieval.documents.0.document.id"),
        { boolValue: true },
      ),
    ).toBe(false);
    expect(
      isOpenInferenceValueValid({ valueType: "number" }, { boolValue: true }),
    ).toBe(false);
  });
});

describe("natural semantic value construction", () => {
  it("constructs every natural scalar and collection representation", () => {
    expect(createSemanticOtlpValue(profileFor("input.value"), "text")).toEqual({
      stringValue: "text",
    });
    expect(createSemanticOtlpValue({ valueType: "boolean" }, true)).toEqual({
      boolValue: true,
    });
    expect(
      createSemanticOtlpValue(profileFor("llm.token_count.total"), 2),
    ).toEqual({ intValue: "2" });
    expect(createSemanticOtlpValue(profileFor("llm.cost.total"), 2.5)).toEqual({
      doubleValue: 2.5,
    });
    expect(createSemanticOtlpValue(profileFor("tag.tags"), ["a", "b"])).toEqual(
      {
        arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] },
      },
    );
    expect(
      createSemanticOtlpValue(
        profileFor("embedding.embeddings.0.embedding.vector"),
        [1, 2],
      ),
    ).toEqual({
      arrayValue: { values: [{ doubleValue: 1 }, { doubleValue: 2 }] },
    });
    expect(
      createSemanticOtlpValue(
        profileFor("retrieval.documents.0.document.id"),
        3,
      ),
    ).toEqual({ intValue: "3" });
    expect(createSemanticOtlpValue({ valueType: "number" }, 4)).toEqual({
      intValue: "4",
    });
  });

  it("fails totally with one fixed error for invalid values", () => {
    for (const value of [null, {}, [true], Number.NaN, -1])
      expect(() =>
        createSemanticOtlpValue(profileFor("llm.token_count.total"), value),
      ).toThrow(SemanticValueError);
    expect(new SemanticValueError()).toMatchObject({
      code: "protocol.semantic-value.invalid",
      message: "protocol.semantic-value.invalid",
      name: "SemanticValueError",
    });
  });
});
