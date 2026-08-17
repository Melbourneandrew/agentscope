import { z } from "zod";

import { deepFreeze } from "./immutable.js";

export const OTLP_GRAPH_LIMITS = deepFreeze({
  resourceSpans: 1,
  scopeSpansPerResource: 1,
  spansPerScope: 256,
  attributesPerResource: 32,
  attributesPerScope: 32,
  attributesPerSpan: 128,
  attributesPerEvent: 64,
  attributesPerLink: 64,
  eventsPerSpan: 256,
  linksPerSpan: 64,
  collectionValues: 64,
  stringLength: 16_384,
  nameLength: 1_024,
  traceStateLength: 512,
  governedFieldsPerSpan: 192,
} as const);

export const OTLP_PROFILE_IDENTITY = deepFreeze({
  graphLimits: OTLP_GRAPH_LIMITS,
  anyValueKinds: [
    "stringValue",
    "boolValue",
    "intValue",
    "doubleValue",
    "bytesValue",
    "scalarArrayValue",
  ],
  spanKinds: [0, 1, 2, 3, 4, 5] as readonly number[],
  statusCodes: [0, 1, 2] as readonly number[],
  identityEncoding: {
    traceIdLength: 32,
    spanIdLength: 16,
    alphabet: "lowercase-hex",
    rejectAllZero: true,
  },
  integerEncoding: {
    signedInt64Minimum: "-9223372036854775808",
    signedInt64Maximum: "9223372036854775807",
    uint64Maximum: "18446744073709551615",
    canonicalSignedPattern: "^(?:0|-?[1-9]\\d*)$",
    canonicalUnsignedPattern: "^(?:0|[1-9]\\d*)$",
  },
  statusMessage: {
    errorCode: 2,
    requireNonempty: true,
    forbiddenForOtherCodes: true,
  },
});

const nonEmptyString = z.string().min(1).max(OTLP_GRAPH_LIMITS.stringLength);
const boundedString = z.string().max(OTLP_GRAPH_LIMITS.stringLength);
const boundedName = z.string().min(1).max(OTLP_GRAPH_LIMITS.nameLength);
const uint32 = z.number().int().min(0).max(4_294_967_295);
const spanKind = z
  .number()
  .int()
  .refine((value) => OTLP_PROFILE_IDENTITY.spanKinds.includes(value));
const statusCode = z
  .number()
  .int()
  .refine((value) => OTLP_PROFILE_IDENTITY.statusCodes.includes(value));

const canonicalBase64 = z
  .string()
  .max(OTLP_GRAPH_LIMITS.stringLength)
  .regex(/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u);
const signedInt64Lexical = new RegExp(
  OTLP_PROFILE_IDENTITY.integerEncoding.canonicalSignedPattern,
  "u",
);
const unsignedInt64Lexical = new RegExp(
  OTLP_PROFILE_IDENTITY.integerEncoding.canonicalUnsignedPattern,
  "u",
);
const signedInt64Minimum = BigInt(
  OTLP_PROFILE_IDENTITY.integerEncoding.signedInt64Minimum,
);
const signedInt64Maximum = BigInt(
  OTLP_PROFILE_IDENTITY.integerEncoding.signedInt64Maximum,
);
const uint64Maximum = BigInt(
  OTLP_PROFILE_IDENTITY.integerEncoding.uint64Maximum,
);
const signedInt64 = z
  .string()
  .regex(signedInt64Lexical)
  .refine(
    (value) => {
      if (!signedInt64Lexical.test(value)) {
        return false;
      }
      const parsed = BigInt(value);
      return parsed >= signedInt64Minimum && parsed <= signedInt64Maximum;
    },
    { message: "Expected a signed 64-bit decimal integer" },
  );
const uint64 = z
  .string()
  .regex(unsignedInt64Lexical)
  .refine(
    (value) =>
      unsignedInt64Lexical.test(value) && BigInt(value) <= uint64Maximum,
    {
      message: "Expected an unsigned 64-bit decimal integer",
    },
  );

const canonicalIdentity = (length: number) =>
  z
    .string()
    .length(length)
    .regex(/^[\da-f]+$/u)
    .refine((value) => !/^0+$/u.test(value), {
      message: "Identity must not be all zeroes",
    });

export const OtlpTraceIdSchema = canonicalIdentity(
  OTLP_PROFILE_IDENTITY.identityEncoding.traceIdLength,
);
export const OtlpSpanIdSchema = canonicalIdentity(
  OTLP_PROFILE_IDENTITY.identityEncoding.spanIdLength,
);

export type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { bytesValue: string }
  | { arrayValue: { values: OtlpScalarValue[] } };

export type OtlpScalarValue = Exclude<OtlpAnyValue, { arrayValue: unknown }>;

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

const uniqueAttributeKeys = (
  attributes: readonly OtlpKeyValue[],
  context: z.RefinementCtx,
) => {
  const seen = new Set<string>();
  attributes.forEach(({ key }, index) => {
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate attribute key: ${key}`,
        path: [index, "key"],
      });
    }
    seen.add(key);
  });
};

export const OtlpScalarValueSchema: z.ZodType<OtlpScalarValue> = z.union([
  z.object({ stringValue: boundedString }).strict(),
  z.object({ boolValue: z.boolean() }).strict(),
  z.object({ intValue: signedInt64 }).strict(),
  z.object({ doubleValue: z.number().finite() }).strict(),
  z.object({ bytesValue: canonicalBase64 }).strict(),
]);

export const OtlpAnyValueSchema: z.ZodType<OtlpAnyValue> = z.union([
  OtlpScalarValueSchema,
  z
    .object({
      arrayValue: z
        .object({
          values: z
            .array(OtlpScalarValueSchema)
            .max(OTLP_GRAPH_LIMITS.collectionValues),
        })
        .strict(),
    })
    .strict(),
]);

export const OtlpKeyValueSchema: z.ZodType<OtlpKeyValue> = z.lazy(() =>
  z
    .object({
      key: nonEmptyString,
      value: OtlpAnyValueSchema,
    })
    .strict(),
);

const attributeList = (maximum: number) =>
  z.array(OtlpKeyValueSchema).max(maximum).superRefine(uniqueAttributeKeys);

const resourceSchema = z
  .object({
    attributes: attributeList(
      OTLP_GRAPH_LIMITS.attributesPerResource,
    ).optional(),
    droppedAttributesCount: uint32.optional(),
  })
  .strict();

const instrumentationScopeSchema = z
  .object({
    name: boundedString.optional(),
    version: boundedString.optional(),
    attributes: attributeList(OTLP_GRAPH_LIMITS.attributesPerScope).optional(),
    droppedAttributesCount: uint32.optional(),
  })
  .strict();

const spanEventSchema = z
  .object({
    timeUnixNano: uint64,
    name: boundedName,
    attributes: attributeList(OTLP_GRAPH_LIMITS.attributesPerEvent).optional(),
    droppedAttributesCount: uint32.optional(),
  })
  .strict();

const spanLinkSchema = z
  .object({
    traceId: OtlpTraceIdSchema,
    spanId: OtlpSpanIdSchema,
    traceState: z.string().max(OTLP_GRAPH_LIMITS.traceStateLength).optional(),
    attributes: attributeList(OTLP_GRAPH_LIMITS.attributesPerLink).optional(),
    droppedAttributesCount: uint32.optional(),
    flags: uint32.optional(),
  })
  .strict();

const statusSchema = z
  .object({
    message: boundedString.optional(),
    code: statusCode,
  })
  .strict();

export const OtlpSpanSchema = z
  .object({
    traceId: OtlpTraceIdSchema,
    spanId: OtlpSpanIdSchema,
    traceState: z.string().max(OTLP_GRAPH_LIMITS.traceStateLength).optional(),
    parentSpanId: OtlpSpanIdSchema.optional(),
    flags: uint32.optional(),
    name: boundedName,
    kind: spanKind,
    startTimeUnixNano: uint64,
    endTimeUnixNano: uint64,
    attributes: attributeList(OTLP_GRAPH_LIMITS.attributesPerSpan).optional(),
    droppedAttributesCount: uint32.optional(),
    events: z
      .array(spanEventSchema)
      .max(OTLP_GRAPH_LIMITS.eventsPerSpan)
      .optional(),
    droppedEventsCount: uint32.optional(),
    links: z
      .array(spanLinkSchema)
      .max(OTLP_GRAPH_LIMITS.linksPerSpan)
      .optional(),
    droppedLinksCount: uint32.optional(),
    status: statusSchema.optional(),
  })
  .strict()
  .superRefine((span, context) => {
    if (
      unsignedInt64Lexical.test(span.startTimeUnixNano) &&
      unsignedInt64Lexical.test(span.endTimeUnixNano) &&
      BigInt(span.endTimeUnixNano) < BigInt(span.startTimeUnixNano)
    ) {
      context.addIssue({
        code: "custom",
        message: "Span end time precedes start time",
        path: ["endTimeUnixNano"],
      });
    }
    if (
      span.status?.message !== undefined &&
      (span.status.code !== OTLP_PROFILE_IDENTITY.statusMessage.errorCode ||
        (OTLP_PROFILE_IDENTITY.statusMessage.requireNonempty &&
          span.status.message.length === 0))
    ) {
      context.addIssue({
        code: "custom",
        message: "Status message is valid only for an Error status",
        path: ["status", "message"],
      });
    }
  });

export const OtlpScopeSpansSchema = z
  .object({
    scope: instrumentationScopeSchema.optional(),
    spans: z.array(OtlpSpanSchema).min(1).max(OTLP_GRAPH_LIMITS.spansPerScope),
    schemaUrl: boundedString.optional(),
  })
  .strict();

export const OtlpResourceSpansSchema = z
  .object({
    resource: resourceSchema.optional(),
    scopeSpans: z
      .array(OtlpScopeSpansSchema)
      .min(1)
      .max(OTLP_GRAPH_LIMITS.scopeSpansPerResource),
    schemaUrl: boundedString.optional(),
  })
  .strict();

export type OtlpSpan = z.infer<typeof OtlpSpanSchema>;
export type OtlpResourceSpans = z.infer<typeof OtlpResourceSpansSchema>;
