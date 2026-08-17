import descriptorJson from "../standards/feedback-profile.json" with { type: "json" };
import { z } from "zod";
import type { OtlpAnyValue, OtlpKeyValue, OtlpSpan } from "./otlp.js";
import { fingerprintCanonicalMaterial } from "./extensions.js";
import { deepFreeze } from "./immutable.js";
import { standardsManifest } from "../standards/manifest.js";

type FeedbackScope = "span" | "trace" | "session";
type FeedbackNoun = "annotation" | "evaluation";
type FeedbackField =
  | "name"
  | "score"
  | "label"
  | "explanation"
  | "annotator_kind"
  | "identifier"
  | "metadata";

const formSchema = z
  .object({
    scope: z.enum(["span", "trace", "session"]),
    noun: z.enum(["annotation", "evaluation"]),
    prefix: z.string().min(1).max(64),
    object: z.enum(["annotation", "evaluation"]),
  })
  .strict();
const fieldSchema = z
  .object({
    valueType: z.enum(["string", "number", "json-object-string"]),
    required: z.boolean(),
    result: z.literal(true).optional(),
    allowedValuesWhenApplicable: z
      .tuple([z.literal("HUMAN"), z.literal("LLM"), z.literal("CODE")])
      .optional(),
    customValues: z.literal(true).optional(),
    contentClass: z.enum([
      "identifier",
      "telemetry",
      "classification",
      "content",
      "structured-content",
    ]),
    sensitivity: z.enum(["safe", "potentially-sensitive"]),
    redaction: z.enum([
      "retain-structural",
      "identifier-policy",
      "content-policy",
      "structured-content-policy",
    ]),
  })
  .strict();
const descriptorSchema = z
  .object({
    descriptorVersion: z.literal(1),
    descriptorFingerprint: z.string().regex(/^sha256-[\da-f]{64}$/u),
    source: z.literal(
      "openinference@553ff3ae420e6b16cae166d6bff48f70ebacef07/spec/annotations.md",
    ),
    index: z
      .object({
        zeroBased: z.literal(true),
        maximum: z.literal(9999),
        contiguous: z.literal("recommended"),
      })
      .strict(),
    forms: z.array(formSchema).length(6),
    fields: z
      .object({
        name: fieldSchema,
        score: fieldSchema,
        label: fieldSchema,
        explanation: fieldSchema,
        annotator_kind: fieldSchema,
        identifier: fieldSchema,
        metadata: fieldSchema,
      })
      .strict(),
    objectRule: z.literal("name-and-at-least-one-result"),
    missingFieldRule: z.literal("omit"),
    aliasRule: z.literal(
      "same-scope-name-and-identifier-fields-must-match-unambiguous-name-when-identifier-absent",
    ),
    sessionRule: z.literal("carrying-span-requires-session-id"),
    postHoc: z
      .object({
        classification: z.literal(
          "agentscope.feedback.transport-post-hoc-required-on-post-hoc-carrier-absence-means-no-post-hoc-claim",
        ),
        transportKey: z.literal("agentscope.feedback.transport"),
        transportValues: z.tuple([z.literal("inline"), z.literal("post-hoc")]),
        strictProducer: z.literal("transport-required"),
        tolerantReader: z.literal(
          "transport-optional-unclassified-when-absent",
        ),
        spanLinks: z.literal("exactly-one-total"),
        traceLinks: z.literal("exactly-one-total"),
        sessionLinks: z.literal("unrestricted"),
        mixedScopes: z.literal("reject"),
      })
      .strict(),
  })
  .strict();

const expectedForms = [
  {
    scope: "span",
    noun: "annotation",
    prefix: "annotations",
    object: "annotation",
  },
  {
    scope: "span",
    noun: "evaluation",
    prefix: "evaluations",
    object: "evaluation",
  },
  {
    scope: "trace",
    noun: "annotation",
    prefix: "trace.annotations",
    object: "annotation",
  },
  {
    scope: "trace",
    noun: "evaluation",
    prefix: "trace.evaluations",
    object: "evaluation",
  },
  {
    scope: "session",
    noun: "annotation",
    prefix: "session.annotations",
    object: "annotation",
  },
  {
    scope: "session",
    noun: "evaluation",
    prefix: "session.evaluations",
    object: "evaluation",
  },
] as const;

const expectedFields = {
  name: {
    valueType: "string",
    required: true,
    contentClass: "identifier",
    sensitivity: "potentially-sensitive",
    redaction: "identifier-policy",
  },
  score: {
    valueType: "number",
    required: false,
    result: true,
    contentClass: "telemetry",
    sensitivity: "safe",
    redaction: "retain-structural",
  },
  label: {
    valueType: "string",
    required: false,
    result: true,
    contentClass: "identifier",
    sensitivity: "potentially-sensitive",
    redaction: "identifier-policy",
  },
  explanation: {
    valueType: "string",
    required: false,
    result: true,
    contentClass: "content",
    sensitivity: "potentially-sensitive",
    redaction: "content-policy",
  },
  annotator_kind: {
    valueType: "string",
    required: false,
    allowedValuesWhenApplicable: ["HUMAN", "LLM", "CODE"],
    customValues: true,
    contentClass: "identifier",
    sensitivity: "potentially-sensitive",
    redaction: "identifier-policy",
  },
  identifier: {
    valueType: "string",
    required: false,
    contentClass: "identifier",
    sensitivity: "potentially-sensitive",
    redaction: "identifier-policy",
  },
  metadata: {
    valueType: "json-object-string",
    required: false,
    contentClass: "structured-content",
    sensitivity: "potentially-sensitive",
    redaction: "structured-content-policy",
  },
} as const;

const fieldBehaviorIsExact = (
  fields: z.infer<typeof descriptorSchema>["fields"],
) => JSON.stringify(fields) === JSON.stringify(expectedFields);

const withoutFingerprint = (input: typeof descriptorJson) => {
  const material: Partial<typeof descriptorJson> = { ...input };
  delete material.descriptorFingerprint;
  return material;
};

export const validateFeedbackProfileForTesting = (input: unknown) => {
  const parsed = descriptorSchema.safeParse(input);
  if (
    !parsed.success ||
    fingerprintCanonicalMaterial(
      withoutFingerprint(parsed.data as typeof descriptorJson),
    ) !== parsed.data.descriptorFingerprint ||
    parsed.data.descriptorVersion !==
      standardsManifest.canonicalProfile.feedbackDescriptorVersion ||
    parsed.data.descriptorFingerprint !==
      standardsManifest.canonicalProfile.feedbackDescriptorFingerprint
  ) {
    throw new Error("protocol.feedback-profile.invalid");
  }
  /* v8 ignore next -- manifest binding makes coordinated exact-behavior drift unreachable */
  if (
    JSON.stringify(parsed.data.forms) !== JSON.stringify(expectedForms) ||
    !fieldBehaviorIsExact(parsed.data.fields)
  ) {
    /* v8 ignore next -- exact behavior is additionally pinned by the manifest fingerprint */
    throw new Error("protocol.feedback-profile.invalid");
  }
  return deepFreeze(parsed.data);
};

export const FEEDBACK_PROFILE = validateFeedbackProfileForTesting(
  descriptorJson,
) as Readonly<typeof descriptorJson>;
export const FEEDBACK_PROFILE_FINGERPRINT =
  descriptorJson.descriptorFingerprint;

type FeedbackObject = {
  scope: FeedbackScope;
  noun: FeedbackNoun;
  index: number;
  fields: Map<FeedbackField, OtlpAnyValue>;
};

const parseFeedbackKey = (key: string) => {
  const segments = key.split(".");
  for (const form of FEEDBACK_PROFILE.forms) {
    const prefix = form.prefix.split(".");
    if (
      segments.length !== prefix.length + 3 ||
      prefix.some((segment, index) => segment !== segments[index]) ||
      segments[prefix.length + 1] !== form.object
    )
      continue;
    const indexSegment = segments[prefix.length]!;
    const index = Number(indexSegment);
    const canonicalIndex = String(index) === indexSegment;
    const field = segments[prefix.length + 2] as FeedbackField;
    if (
      canonicalIndex &&
      Number.isInteger(index) &&
      index >= 0 &&
      index <= FEEDBACK_PROFILE.index.maximum &&
      Object.hasOwn(FEEDBACK_PROFILE.fields, field)
    )
      return {
        scope: form.scope as FeedbackScope,
        noun: form.noun as FeedbackNoun,
        index,
        field,
      };
  }
  return undefined;
};

export const isFeedbackAttributeKey = (key: string) =>
  parseFeedbackKey(key) !== undefined;

const valueEqual = (left: OtlpAnyValue, right: OtlpAnyValue) => {
  if ("intValue" in left && "intValue" in right)
    return BigInt(left.intValue) === BigInt(right.intValue);
  if ("doubleValue" in left && "doubleValue" in right)
    return left.doubleValue === right.doubleValue;
  if ("intValue" in left && "doubleValue" in right)
    return (
      Number.isSafeInteger(right.doubleValue) &&
      BigInt(left.intValue) === BigInt(right.doubleValue)
    );
  if ("doubleValue" in left && "intValue" in right)
    return (
      Number.isSafeInteger(left.doubleValue) &&
      BigInt(left.doubleValue) === BigInt(right.intValue)
    );
  return JSON.stringify(left) === JSON.stringify(right);
};

const stringField = (object: FeedbackObject, field: FeedbackField) => {
  const value = object.fields.get(field);
  return value !== undefined && "stringValue" in value
    ? value.stringValue
    : undefined;
};

const parseFeedbackObjects = (span: Pick<OtlpSpan, "attributes" | "links">) => {
  const objects = new Map<string, FeedbackObject>();
  for (const attribute of span.attributes ?? []) {
    const match = parseFeedbackKey(attribute.key);
    if (match === undefined) continue;
    const { scope, noun, index, field } = match;
    const key = `${scope}:${noun}:${index}`;
    const object = objects.get(key) ?? {
      scope,
      noun,
      index,
      fields: new Map<FeedbackField, OtlpAnyValue>(),
    };
    if (object.fields.has(field)) return undefined;
    object.fields.set(field, attribute.value);
    objects.set(key, object);
  }
  return objects;
};

const feedbackObjectsAreComplete = (
  objects: ReadonlyMap<string, FeedbackObject>,
) =>
  [...objects.values()].every((object) => {
    const name = object.fields.get("name");
    return (
      name !== undefined &&
      "stringValue" in name &&
      name.stringValue.length > 0 &&
      (["score", "label", "explanation"] as const).some((field) =>
        object.fields.has(field),
      )
    );
  });

type AliasIndex = Map<
  FeedbackScope,
  Map<string, Map<string | undefined, FeedbackObject[]>>
>;

const aliasGroups = (objects: ReadonlyMap<string, FeedbackObject>) => {
  const byScope: AliasIndex = new Map();
  for (const object of objects.values()) {
    const name = stringField(object, "name")!;
    const identifier = stringField(object, "identifier");
    const byName: Map<
      string,
      Map<string | undefined, FeedbackObject[]>
    > = byScope.get(object.scope) ??
    new Map<string, Map<string | undefined, FeedbackObject[]>>();
    const byIdentifier: Map<string | undefined, FeedbackObject[]> =
      byName.get(name) ?? new Map<string | undefined, FeedbackObject[]>();
    const candidates: FeedbackObject[] = byIdentifier.get(identifier) ?? [];
    candidates.push(object);
    byIdentifier.set(identifier, candidates);
    byName.set(name, byIdentifier);
    byScope.set(object.scope, byName);
  }
  return [...byScope.values()].flatMap((byName) =>
    [...byName.values()].flatMap((byIdentifier) => [...byIdentifier.values()]),
  );
};

const aliasesAreValid = (objects: ReadonlyMap<string, FeedbackObject>) =>
  aliasGroups(objects).every((candidates) => {
    const annotations = candidates.filter(({ noun }) => noun === "annotation");
    const evaluations = candidates.filter(({ noun }) => noun === "evaluation");
    if (annotations.length === 0 || evaluations.length === 0) return true;
    if (annotations.length !== 1 || evaluations.length !== 1) return false;
    const left = annotations[0]!;
    const right = evaluations[0]!;
    const fields = new Set([...left.fields.keys(), ...right.fields.keys()]);
    return [...fields].every((field) => {
      const leftValue = left.fields.get(field);
      const rightValue = right.fields.get(field);
      return (
        leftValue !== undefined &&
        rightValue !== undefined &&
        valueEqual(leftValue, rightValue)
      );
    });
  });

/** Validates the compound invariants that cannot be expressed per attribute. */
export const feedbackAttributesAreValid = (
  span: Pick<OtlpSpan, "attributes" | "links">,
  transportRequired = true,
): boolean => {
  const carrierValue = span.attributes?.find(
    ({ key }) => key === FEEDBACK_PROFILE.postHoc.transportKey,
  )?.value;
  const objects = parseFeedbackObjects(span);
  if (objects === undefined) return false;
  if (objects.size === 0) return carrierValue === undefined;
  const scopes = new Set<FeedbackScope>();
  for (const object of objects.values()) scopes.add(object.scope);
  if (!feedbackObjectsAreComplete(objects) || !aliasesAreValid(objects))
    return false;
  const sessionId = span.attributes?.find(
    ({ key }) => key === "session.id",
  )?.value;
  if (
    scopes.has("session") &&
    (sessionId === undefined ||
      !("stringValue" in sessionId) ||
      sessionId.stringValue.length === 0)
  )
    return false;

  if (carrierValue === undefined) return !transportRequired;
  if (
    !("stringValue" in carrierValue) ||
    !FEEDBACK_PROFILE.postHoc.transportValues.includes(carrierValue.stringValue)
  )
    return false;
  if (carrierValue.stringValue === "inline") return true;
  if (scopes.size !== 1) return false;
  const scope = [...scopes][0]!;
  const linkCount = span.links?.length ?? 0;
  return scope === "session" || linkCount === 1;
};

export const feedbackAttribute = (
  key: string,
  value: OtlpAnyValue,
): OtlpKeyValue => ({ key, value });
