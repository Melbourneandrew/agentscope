import type { OtlpAnyValue } from "./otlp.js";
import {
  getAcceptedSemanticAttributeDescriptor,
  getSemanticAttributeDescriptor,
  isOpenInferenceSemanticNamespace,
  SEMANTIC_PROFILE_IDENTITY,
  semanticProfileDescriptors,
  type SemanticAttributeDescriptor,
} from "./semantic-profile.js";

export type OpenInferenceValueType = SemanticAttributeDescriptor["valueType"];
export type OpenInferenceAttributeProfile = SemanticAttributeDescriptor;
type OpenInferenceValueProfile = Pick<
  SemanticAttributeDescriptor,
  "valueType" | "allowEmpty" | "allowedValues"
> & { readonly kinds?: readonly string[] };

export const OPENINFERENCE_ATTRIBUTE_PROFILE = Object.freeze(
  Object.fromEntries(
    semanticProfileDescriptors.attributes.flatMap((descriptor) =>
      descriptor.standard === "openinference" &&
      descriptor.key !== undefined &&
      descriptor.support === "accepted"
        ? [[descriptor.key, descriptor]]
        : [],
    ),
  ),
);

export const OPENINFERENCE_PROFILE_IDENTITY = SEMANTIC_PROFILE_IDENTITY;

const spanKindDescriptor = getAcceptedSemanticAttributeDescriptor(
  "openinference.span.kind",
)!;
export const OPENINFERENCE_SPAN_KINDS = Object.freeze([
  "AGENT",
  "CHAIN",
  "EMBEDDING",
  "EVALUATOR",
  "GUARDRAIL",
  "LLM",
  "PROMPT",
  "RERANKER",
  "RETRIEVER",
  "TOOL",
] as const);
export type OpenInferenceSpanKindValue =
  (typeof OPENINFERENCE_SPAN_KINDS)[number];
export const validateOpenInferenceSpanKindInventory = (
  allowedValues: readonly string[] | undefined,
) => {
  if (
    JSON.stringify(OPENINFERENCE_SPAN_KINDS) !== JSON.stringify(allowedValues)
  )
    throw new Error("protocol.semantic-profile.kind-drift");
};
validateOpenInferenceSpanKindInventory(spanKindDescriptor.allowedValues);

export const getOpenInferenceAttributeProfile = (
  key: string,
): OpenInferenceAttributeProfile | undefined => {
  const descriptor = getAcceptedSemanticAttributeDescriptor(key);
  return descriptor?.standard === "openinference" ? descriptor : undefined;
};

export const getKnownOpenInferenceAttributeProfile = (key: string) => {
  const descriptor = getSemanticAttributeDescriptor(key);
  return descriptor?.standard === "openinference" ? descriptor : undefined;
};

export const isOpenInferenceAttributeKey = isOpenInferenceSemanticNamespace;

export const isValidOpenInferenceAttributeKey = (key: string) =>
  getOpenInferenceAttributeProfile(key) !== undefined;

const parseJson = (value: string, objectOnly: boolean) => {
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      !objectOnly ||
      (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
    );
  } catch {
    return false;
  }
};

export const isOpenInferenceValueValid = (
  profile: OpenInferenceValueProfile,
  value: OtlpAnyValue,
) => {
  if (profile.valueType === "string" && "stringValue" in value) {
    return (
      (profile.allowEmpty === true || value.stringValue.length > 0) &&
      (profile.allowedValues === undefined ||
        profile.allowedValues.includes(value.stringValue))
    );
  }
  if (profile.valueType === "json-string" && "stringValue" in value) {
    return parseJson(value.stringValue, false);
  }
  if (profile.valueType === "json-object-string" && "stringValue" in value) {
    return parseJson(value.stringValue, true);
  }
  if (profile.valueType === "nonnegative-int" && "intValue" in value) {
    return BigInt(value.intValue) >= 0n;
  }
  if (profile.valueType === "double" && "doubleValue" in value) {
    return true;
  }
  if (profile.valueType === "string-array" && "arrayValue" in value) {
    return value.arrayValue.values.every(
      (item) =>
        "stringValue" in item &&
        (profile.allowEmpty === true || item.stringValue.length > 0),
    );
  }
  if (profile.valueType === "double-array" && "arrayValue" in value) {
    return value.arrayValue.values.every((item) => "doubleValue" in item);
  }
  if (profile.valueType === "string-or-int") {
    return (
      ("stringValue" in value &&
        (profile.allowEmpty === true || value.stringValue.length > 0)) ||
      "intValue" in value
    );
  }
  if (profile.valueType === "number") {
    return "intValue" in value || "doubleValue" in value;
  }
  return profile.valueType === "boolean" && "boolValue" in value;
};

export const isSemanticCandidateValueValid = (
  profile: OpenInferenceValueProfile,
  value: unknown,
): boolean => {
  let otlpValue: OtlpAnyValue;
  if (typeof value === "string") otlpValue = { stringValue: value };
  else if (typeof value === "boolean") otlpValue = { boolValue: value };
  else if (typeof value === "number" && Number.isFinite(value))
    otlpValue =
      Number.isSafeInteger(value) &&
      (profile.valueType === "nonnegative-int" ||
        profile.valueType === "string-or-int")
        ? { intValue: String(value) }
        : { doubleValue: value };
  else if (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string")
  )
    otlpValue = {
      arrayValue: {
        values: value.map((item) => ({ stringValue: String(item) })),
      },
    };
  else if (
    Array.isArray(value) &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  )
    otlpValue = {
      arrayValue: {
        values: value.map((item) => ({ doubleValue: Number(item) })),
      },
    };
  else return false;
  return isOpenInferenceValueValid(profile, otlpValue);
};

export class SemanticValueError extends Error {
  public readonly code = "protocol.semantic-value.invalid";

  public constructor() {
    super("protocol.semantic-value.invalid");
    this.name = "SemanticValueError";
  }
}

const isFiniteNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.every(
    (item: unknown) => typeof item === "number" && Number.isFinite(item),
  );

/** Converts the descriptor's natural Core candidate representation to OTLP. */
export const createSemanticOtlpValue = (
  profile: OpenInferenceValueProfile,
  value: unknown,
): OtlpAnyValue => {
  try {
    let result: OtlpAnyValue;
    if (typeof value === "string") result = { stringValue: value };
    else if (typeof value === "boolean") result = { boolValue: value };
    else if (typeof value === "number" && Number.isFinite(value)) {
      result =
        Number.isSafeInteger(value) &&
        (profile.valueType === "nonnegative-int" ||
          profile.valueType === "string-or-int" ||
          profile.valueType === "number")
          ? { intValue: String(value) }
          : { doubleValue: value };
    } else if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    ) {
      result = {
        arrayValue: { values: value.map((item) => ({ stringValue: item })) },
      };
    } else if (isFiniteNumberArray(value)) {
      result = {
        arrayValue: { values: value.map((item) => ({ doubleValue: item })) },
      };
    } else throw new SemanticValueError();
    if (!isOpenInferenceValueValid(profile, result))
      throw new SemanticValueError();
    return result;
  } catch {
    throw new SemanticValueError();
  }
};
