import { z } from "zod";

import rawSemanticProfile from "../standards/semantic-profile.json" with { type: "json" };
import { standardsManifest } from "../standards/manifest.js";
import {
  agentscopeExtensionRegistry,
  fingerprintCanonicalMaterial,
  type AgentscopeExtensionDescriptor,
} from "./extensions.js";
import { deepFreeze } from "./immutable.js";
import { FEEDBACK_PROFILE } from "./feedback-profile.js";

const attributeValueTypeSchema = z.enum([
  "string",
  "json-string",
  "json-object-string",
  "nonnegative-int",
  "double",
  "string-array",
  "double-array",
  "string-or-int",
  "number",
  "boolean",
]);
const structuralValueTypeSchema = z.enum([
  "string",
  "trace-id",
  "span-id",
  "span-kind",
  "flags",
  "timestamp",
  "status-code",
  "uint32",
]);
const locationSchema = z.enum([
  "resource",
  "scope",
  "root-span",
  "span",
  "event",
  "link",
]);
const contentClassSchema = z.enum([
  "fixed-structural",
  "telemetry",
  "classification",
  "identifier",
  "location",
  "content",
  "structured-content",
  "derived-metadata",
  "opaque-provider-artifact",
  "embedding-vector",
]);
const sensitivitySchema = z.enum(["safe", "potentially-sensitive"]);
const redactionRouteSchema = z.enum([
  "retain-structural",
  "identifier-policy",
  "path-policy",
  "content-policy",
  "structured-content-policy",
  "uri-media-policy",
  "opaque-drop",
  "embedding-restricted",
]);
const REDACTION_TRANSFORM_NAMES = [
  "bound",
  "secret-scan",
  "retain",
  "absolute-path-scan",
  "identifier-policy",
  "path-policy",
  "content-policy",
  "parse-json",
  "recursive-secret-scan",
  "recursive-absolute-path-scan",
  "deterministic-json",
  "reject-data-uri",
  "reject-userinfo",
  "drop-query",
  "drop-fragment",
  "uri-policy",
  "drop",
] as const;
const redactionOutcomeSchema = z.enum([
  "retain",
  "suppress-trace",
  "replace-non-content",
  "omit-redacted",
  "omit",
  "omit-event",
]);
export type RedactionRoute = z.infer<typeof redactionRouteSchema>;
export type RedactionTransform = (typeof REDACTION_TRANSFORM_NAMES)[number];
export const REDACTION_TRANSFORMS = deepFreeze(REDACTION_TRANSFORM_NAMES);
export type RedactionOutcome = z.infer<typeof redactionOutcomeSchema>;
const supportSchema = z.enum(["accepted", "rejected"]);
const boundedIdentifier = z.string().min(1).max(128);
const boundedString = z.string().min(1).max(1_024);

const commonDescriptorShape = {
  support: supportSchema,
  valueType: attributeValueTypeSchema,
  locations: z.array(locationSchema).min(1).max(6),
  openInferenceKinds: z.array(boundedIdentifier).min(1).max(10).optional(),
  allowEmpty: z.boolean().optional(),
  allowedValues: z.array(boundedString).min(1).max(32).optional(),
  eventName: boundedString.optional(),
  contentClass: contentClassSchema,
  sensitivity: sensitivitySchema,
  redaction: redactionRouteSchema,
  sourceReference: boundedString.optional(),
  sourceStatus: boundedString.optional(),
  rejectionReason: boundedString.optional(),
};

const directGroupSchema = z
  .object({
    keys: z.array(boundedIdentifier).min(1).max(64),
    ...commonDescriptorShape,
  })
  .strict();
const templateSegmentSchema = z.union([
  z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z\d_]*$/u),
  z.object({ index: z.literal(true) }).strict(),
  z
    .object({
      oneOf: z
        .array(
          z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-z][a-z\d_]*$/u),
        )
        .min(1)
        .max(16),
    })
    .strict(),
  z
    .object({
      identifier: z
        .object({
          style: z.literal("lower-snake"),
          maxLength: z.number().int().min(1).max(64),
        })
        .strict(),
    })
    .strict(),
]);
const templateMatchSchema = z
  .object({
    alternatives: z
      .array(z.array(templateSegmentSchema).min(1).max(24))
      .min(1)
      .max(16),
  })
  .strict();
const templateSchema = z
  .object({
    id: boundedIdentifier,
    match: templateMatchSchema,
    ...commonDescriptorShape,
  })
  .strict();
const structuralLeafSchema = z
  .object({
    support: z.literal("accepted"),
    key: boundedIdentifier,
    valueType: structuralValueTypeSchema,
    contentClass: contentClassSchema,
    sensitivity: sensitivitySchema,
    redaction: redactionRouteSchema,
    allowedOutcomes: z.array(redactionOutcomeSchema).min(1).max(8),
  })
  .strict();
const packageBindingSchema = z
  .object({
    exportName: boundedIdentifier,
    containerName: boundedIdentifier.optional(),
    key: boundedIdentifier,
  })
  .strict();
const upstreamConstraintSchema = z.discriminatedUnion("rule", [
  z
    .object({
      id: z.literal("openinference-span-kind-required"),
      source: boundedString,
      rule: z.literal("required-attribute"),
      key: z.literal("openinference.span.kind"),
      scope: z.literal("every-span"),
    })
    .strict(),
  z
    .object({
      id: z.literal("llm-system-required-or-explicitly-incomplete"),
      source: boundedString,
      rule: z.literal("required-or-absent-evidence"),
      key: z.literal("llm.system"),
      openInferenceKind: z.literal("LLM"),
      absentStates: z.tuple([z.literal("unavailable"), z.literal("redacted")]),
    })
    .strict(),
  z
    .object({
      id: z.literal("embedding-operation-name"),
      source: boundedString,
      rule: z.literal("required-span-name"),
      openInferenceKind: z.literal("EMBEDDING"),
      spanName: z.literal("CreateEmbeddings"),
    })
    .strict(),
]);
type UpstreamConstraint = z.infer<typeof upstreamConstraintSchema>;

const semanticProfileSchema = z
  .object({
    descriptorVersion: z.number().int().positive(),
    profileId: boundedIdentifier,
    upstream: z
      .object({
        openInferenceSemanticConventionsVersion: boundedIdentifier,
        openInferenceRepositorySnapshot: z.string().regex(/^[\da-f]{40}$/u),
        openTelemetrySemanticConventionsVersion: boundedIdentifier,
      })
      .strict(),
    upgradePolicy: z.literal("manual-review-required"),
    canonicalIndex: z
      .object({
        zeroBased: z.literal(true),
        noLeadingZero: z.literal(true),
        maximum: z.literal(9_999),
      })
      .strict(),
    diagnosticExposure: z.literal("never"),
    matchPrecedence: z.literal("exact-before-template-reject-ambiguity"),
    openInferenceRoots: z.array(boundedIdentifier).min(1).max(32),
    openTelemetryAttributeKeys: z.array(boundedIdentifier).min(1).max(64),
    redactionRoutes: z
      .object({
        "retain-structural": z.tuple([
          z.literal("bound"),
          z.literal("secret-scan"),
          z.literal("retain"),
        ]),
        "identifier-policy": z.tuple([
          z.literal("bound"),
          z.literal("secret-scan"),
          z.literal("absolute-path-scan"),
          z.literal("identifier-policy"),
        ]),
        "path-policy": z.tuple([
          z.literal("bound"),
          z.literal("secret-scan"),
          z.literal("path-policy"),
        ]),
        "content-policy": z.tuple([
          z.literal("bound"),
          z.literal("secret-scan"),
          z.literal("absolute-path-scan"),
          z.literal("content-policy"),
        ]),
        "structured-content-policy": z.tuple([
          z.literal("bound"),
          z.literal("parse-json"),
          z.literal("recursive-secret-scan"),
          z.literal("recursive-absolute-path-scan"),
          z.literal("deterministic-json"),
          z.literal("content-policy"),
        ]),
        "uri-media-policy": z.tuple([
          z.literal("bound"),
          z.literal("reject-data-uri"),
          z.literal("reject-userinfo"),
          z.literal("drop-query"),
          z.literal("drop-fragment"),
          z.literal("secret-scan"),
          z.literal("absolute-path-scan"),
          z.literal("uri-policy"),
        ]),
        "opaque-drop": z.tuple([z.literal("drop")]),
        "embedding-restricted": z.tuple([z.literal("drop")]),
      })
      .strict(),
    allowedOutcomesByRoute: z
      .object({
        "retain-structural": z.tuple([
          z.literal("retain"),
          z.literal("suppress-trace"),
        ]),
        "identifier-policy": z.tuple([
          z.literal("retain"),
          z.literal("replace-non-content"),
          z.literal("omit-redacted"),
          z.literal("suppress-trace"),
        ]),
        "path-policy": z.tuple([
          z.literal("retain"),
          z.literal("replace-non-content"),
          z.literal("omit-redacted"),
          z.literal("suppress-trace"),
        ]),
        "content-policy": z.tuple([
          z.literal("retain"),
          z.literal("replace-non-content"),
          z.literal("omit-redacted"),
          z.literal("suppress-trace"),
        ]),
        "structured-content-policy": z.tuple([
          z.literal("retain"),
          z.literal("replace-non-content"),
          z.literal("omit-redacted"),
          z.literal("suppress-trace"),
        ]),
        "uri-media-policy": z.tuple([
          z.literal("retain"),
          z.literal("replace-non-content"),
          z.literal("omit-redacted"),
          z.literal("suppress-trace"),
        ]),
        "opaque-drop": z.tuple([
          z.literal("omit-redacted"),
          z.literal("suppress-trace"),
        ]),
        "embedding-restricted": z.tuple([
          z.literal("omit-redacted"),
          z.literal("suppress-trace"),
        ]),
      })
      .strict(),
    classRouteCompatibility: z
      .object({
        "fixed-structural": z.tuple([z.literal("retain-structural")]),
        telemetry: z.tuple([z.literal("retain-structural")]),
        classification: z.tuple([
          z.literal("retain-structural"),
          z.literal("identifier-policy"),
        ]),
        identifier: z.tuple([
          z.literal("retain-structural"),
          z.literal("identifier-policy"),
        ]),
        location: z.tuple([
          z.literal("path-policy"),
          z.literal("uri-media-policy"),
        ]),
        content: z.tuple([z.literal("content-policy")]),
        "structured-content": z.tuple([z.literal("structured-content-policy")]),
        "derived-metadata": z.tuple([z.literal("retain-structural")]),
        "opaque-provider-artifact": z.tuple([z.literal("opaque-drop")]),
        "embedding-vector": z.tuple([z.literal("embedding-restricted")]),
      })
      .strict(),
    structuralLeaves: z.array(structuralLeafSchema).min(1).max(64),
    upstreamConstraints: z.array(upstreamConstraintSchema).min(1).max(32),
    directGroups: z.array(directGroupSchema).min(1).max(128),
    templates: z.array(templateSchema).min(1).max(128),
    packageConstantBindings: z.array(packageBindingSchema).min(1).max(256),
    packageExportDispositions: z.record(
      boundedIdentifier,
      z.record(boundedIdentifier, boundedString),
    ),
    packageEnumBindings: z.record(
      boundedIdentifier,
      z.record(boundedIdentifier, boundedString),
    ),
    openEnumPolicy: z.array(boundedIdentifier).max(16),
  })
  .strict();

type RawSemanticProfile = z.infer<typeof semanticProfileSchema>;
export type SemanticAttributeDescriptor = Omit<
  z.infer<typeof directGroupSchema>,
  "keys" | "locations" | "openInferenceKinds" | "allowedValues"
> & {
  readonly locations: readonly z.infer<typeof locationSchema>[];
  readonly openInferenceKinds?: readonly string[] | undefined;
  readonly allowedValues?: readonly string[] | undefined;
  readonly key?: string;
  readonly templateId?: string;
  readonly match?: z.infer<typeof templateMatchSchema>;
  readonly expandedPattern?: string;
  readonly standard: "openinference" | "opentelemetry" | "agentscope";
  readonly mandatoryTransforms: readonly string[];
  readonly allowedOutcomes: readonly string[];
  readonly diagnosticExposure: "never";
};

export type StructuralSemanticDescriptor = z.infer<
  typeof structuralLeafSchema
> & {
  readonly mandatoryTransforms: readonly string[];
  readonly diagnosticExposure: "never";
};

export class SemanticProfileError extends Error {
  public constructor(code: string) {
    super(code);
    this.name = "SemanticProfileError";
  }
}

const unique = (values: readonly string[], code: string) => {
  if (new Set(values).size !== values.length) {
    throw new SemanticProfileError(code);
  }
};

export const compareCanonicalStringsForTesting = (
  left: string,
  right: string,
) => (left < right ? -1 : left > right ? 1 : 0);

const sorted = <T>(values: readonly T[], key: (value: T) => string) =>
  [...values].sort((left, right) =>
    compareCanonicalStringsForTesting(key(left), key(right)),
  );

const canonicalRecord = <T>(record: Readonly<Record<string, T>>) =>
  Object.fromEntries(
    Object.entries(record).sort(([left], [right]) =>
      compareCanonicalStringsForTesting(left, right),
    ),
  );

const validateBaseline = (profile: RawSemanticProfile) => {
  const openInference = standardsManifest.artifacts.openInference;
  const openTelemetry =
    standardsManifest.artifacts.openTelemetrySemanticConventions;
  if (
    profile.upstream.openInferenceSemanticConventionsVersion !==
      openInference.semanticConventionsVersion ||
    profile.upstream.openInferenceRepositorySnapshot !==
      openInference.repositorySnapshot ||
    `v${profile.upstream.openTelemetrySemanticConventionsVersion}` !==
      openTelemetry.release
  ) {
    throw new SemanticProfileError("semantic.profile.baseline");
  }
};

export type TemplateSegment =
  | string
  | { readonly index: true }
  | { readonly oneOf: readonly string[] }
  | {
      readonly identifier: {
        readonly style: "lower-snake";
        readonly maxLength: number;
      };
    };
type TemplateMatch = z.infer<typeof templateMatchSchema>;

const escapeRegularExpression = (value: string) =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const segmentPattern = (segment: TemplateSegment) => {
  if (typeof segment === "string") return escapeRegularExpression(segment);
  if ("index" in segment) return "(?:0|[1-9]\\d{0,3})";
  if ("oneOf" in segment) {
    return `(?:${segment.oneOf.map(escapeRegularExpression).join("|")})`;
  }
  return `[a-z][a-z\\d_]{0,${segment.identifier.maxLength - 1}}`;
};

const compileTemplateMatch = (match: TemplateMatch) => {
  const expanded = `^(?:${match.alternatives
    .map((alternative) => alternative.map(segmentPattern).join("\\."))
    .join("|")})$`;
  return { expanded, regularExpression: new RegExp(expanded, "u") };
};

const literalMatchesSegment = (literal: string, segment: TemplateSegment) => {
  if (typeof segment === "string") return literal === segment;
  if ("index" in segment) return /^(?:0|[1-9]\d{0,3})$/u.test(literal);
  if ("oneOf" in segment) return segment.oneOf.includes(literal);
  return (
    literal.length <= segment.identifier.maxLength &&
    /^[a-z][a-z\d_]*$/u.test(literal)
  );
};

export const templateSegmentsOverlapForTesting = (
  left: TemplateSegment,
  right: TemplateSegment,
) => {
  if (typeof left === "string") return literalMatchesSegment(left, right);
  if (typeof right === "string") return literalMatchesSegment(right, left);
  if ("oneOf" in left) {
    return left.oneOf.some((literal) => literalMatchesSegment(literal, right));
  }
  if ("oneOf" in right) {
    return right.oneOf.some((literal) => literalMatchesSegment(literal, left));
  }
  return "index" in left === "index" in right;
};

const alternativesOverlap = (
  left: readonly TemplateSegment[],
  right: readonly TemplateSegment[],
) =>
  left.length === right.length &&
  left.every((segment, index) =>
    templateSegmentsOverlapForTesting(segment, right[index]!),
  );

const matchesOverlap = (left: TemplateMatch, right: TemplateMatch) =>
  left.alternatives.some((leftAlternative) =>
    right.alternatives.some((rightAlternative) =>
      alternativesOverlap(leftAlternative, rightAlternative),
    ),
  );

const matchHasInternalOverlap = (match: TemplateMatch) =>
  match.alternatives.some((alternative, index) =>
    match.alternatives
      .slice(index + 1)
      .some((candidate) => alternativesOverlap(alternative, candidate)),
  );

const validateProfileCollections = (profile: RawSemanticProfile) => {
  unique(
    profile.directGroups.flatMap(({ keys }) => keys),
    "semantic.profile.duplicate-key",
  );
  unique(
    profile.templates.map(({ id }) => id),
    "semantic.profile.duplicate-template-id",
  );
  unique(
    profile.templates.map(({ match }) => JSON.stringify(match)),
    "semantic.profile.duplicate-template-pattern",
  );
  for (const template of profile.templates) {
    for (const alternative of template.match.alternatives) {
      for (const segment of alternative) {
        if (typeof segment !== "string" && "oneOf" in segment) {
          unique(segment.oneOf, "semantic.profile.duplicate-template-choice");
        }
      }
    }
    if (matchHasInternalOverlap(template.match)) {
      throw new SemanticProfileError("semantic.profile.ambiguous-template");
    }
  }
  for (const [index, template] of profile.templates.entries()) {
    if (
      profile.templates
        .slice(index + 1)
        .some((candidate) => matchesOverlap(template.match, candidate.match))
    ) {
      throw new SemanticProfileError("semantic.profile.ambiguous-template");
    }
  }
  unique(
    profile.structuralLeaves.map(({ key }) => key),
    "semantic.profile.duplicate-structural-key",
  );
  unique(
    profile.upstreamConstraints.map(({ id }) => id),
    "semantic.profile.duplicate-upstream-constraint",
  );
  if (
    profile.upstreamConstraints
      .map(({ rule }) => rule)
      .sort(compareCanonicalStringsForTesting)
      .join(",") !==
    "required-attribute,required-or-absent-evidence,required-span-name"
  ) {
    throw new SemanticProfileError("semantic.profile.upstream-constraints");
  }
  unique(
    profile.packageConstantBindings.map(({ exportName }) => exportName),
    "semantic.profile.duplicate-package-binding",
  );
  unique(
    [
      ...profile.packageConstantBindings.map(({ exportName }) => exportName),
      ...Object.values(profile.packageExportDispositions).flatMap((entries) =>
        Object.keys(entries),
      ),
    ],
    "semantic.profile.duplicate-package-disposition",
  );
};

const validateDescriptorRoutes = (profile: RawSemanticProfile) => {
  const descriptors = [
    ...profile.directGroups,
    ...profile.templates,
    ...profile.structuralLeaves,
  ];
  for (const descriptor of descriptors) {
    const permitted: readonly RedactionRoute[] =
      profile.classRouteCompatibility[descriptor.contentClass];
    if (
      !permitted.includes(descriptor.redaction) ||
      (descriptor.sensitivity === "safe" &&
        descriptor.redaction !== "retain-structural") ||
      (descriptor.sensitivity === "potentially-sensitive" &&
        descriptor.redaction === "retain-structural")
    ) {
      throw new SemanticProfileError("semantic.profile.class-route");
    }
  }
};

export const validateRedactionTransformInventoryForTesting = (
  routes: Readonly<Record<string, readonly string[]>>,
  transforms: readonly string[] = REDACTION_TRANSFORMS,
) => {
  const used = [...new Set(Object.values(routes).flat())].sort(
    compareCanonicalStringsForTesting,
  );
  const governed = [...new Set(transforms)].sort(
    compareCanonicalStringsForTesting,
  );
  if (
    new Set(transforms).size !== transforms.length ||
    used.join(",") !== governed.join(",")
  ) {
    throw new SemanticProfileError("semantic.profile.transform-inventory");
  }
};

const compileProfile = (input: unknown) => {
  const parsed = semanticProfileSchema.safeParse(input);
  if (!parsed.success) {
    throw new SemanticProfileError("semantic.profile.schema");
  }
  const profile = parsed.data;
  validateBaseline(profile);
  validateProfileCollections(profile);
  validateRedactionTransformInventoryForTesting(profile.redactionRoutes);
  validateDescriptorRoutes(profile);
  const descriptors = profile.directGroups.flatMap(({ keys, ...descriptor }) =>
    keys.map((key) => ({ key, ...descriptor })),
  );
  const otelKeys = new Set(profile.openTelemetryAttributeKeys);
  const direct = descriptors.map((descriptor): SemanticAttributeDescriptor => ({
    ...descriptor,
    standard: otelKeys.has(descriptor.key) ? "opentelemetry" : "openinference",
    mandatoryTransforms: profile.redactionRoutes[descriptor.redaction],
    allowedOutcomes: profile.allowedOutcomesByRoute[descriptor.redaction],
    diagnosticExposure: profile.diagnosticExposure,
  }));
  const templates = profile.templates.map(
    ({
      id,
      match,
      ...descriptor
    }): SemanticAttributeDescriptor & {
      readonly regularExpression: RegExp;
    } => {
      const { expanded, regularExpression } = compileTemplateMatch(match);
      return {
        ...descriptor,
        templateId: id,
        match,
        expandedPattern: expanded,
        regularExpression,
        standard: "openinference" as const,
        mandatoryTransforms: profile.redactionRoutes[descriptor.redaction],
        allowedOutcomes: profile.allowedOutcomesByRoute[descriptor.redaction],
        diagnosticExposure: profile.diagnosticExposure,
      };
    },
  );
  const structural = profile.structuralLeaves.map(
    (descriptor): StructuralSemanticDescriptor => ({
      ...descriptor,
      mandatoryTransforms: profile.redactionRoutes[descriptor.redaction],
      diagnosticExposure: profile.diagnosticExposure,
    }),
  );
  const identity = {
    descriptorVersion: profile.descriptorVersion,
    profileId: profile.profileId,
    upstream: profile.upstream,
    upgradePolicy: profile.upgradePolicy,
    canonicalIndex: profile.canonicalIndex,
    diagnosticExposure: profile.diagnosticExposure,
    matchPrecedence: profile.matchPrecedence,
    openInferenceRoots: [...profile.openInferenceRoots].sort(),
    openTelemetryAttributeKeys: [...profile.openTelemetryAttributeKeys].sort(),
    redactionRoutes: canonicalRecord(profile.redactionRoutes),
    allowedOutcomesByRoute: canonicalRecord(profile.allowedOutcomesByRoute),
    classRouteCompatibility: canonicalRecord(profile.classRouteCompatibility),
    structuralLeaves: sorted(profile.structuralLeaves, ({ key }) => key),
    upstreamConstraints: sorted(profile.upstreamConstraints, ({ id }) => id),
    direct: sorted(descriptors, ({ key }) => key),
    templates: sorted(profile.templates, ({ id }) => id),
    packageConstantBindings: sorted(
      profile.packageConstantBindings,
      ({ exportName }) => exportName,
    ),
    packageExportDispositions: canonicalRecord(
      Object.fromEntries(
        Object.entries(profile.packageExportDispositions).map(
          ([key, values]) => [key, canonicalRecord(values)],
        ),
      ),
    ),
    packageEnumBindings: canonicalRecord(
      Object.fromEntries(
        Object.entries(profile.packageEnumBindings).map(([key, value]) => [
          key,
          canonicalRecord(value),
        ]),
      ),
    ),
    openEnumPolicy: [...profile.openEnumPolicy].sort(),
  };
  return deepFreeze({ profile, direct, templates, structural, identity });
};

const compiled = compileProfile(rawSemanticProfile);

export const SEMANTIC_PROFILE_IDENTITY = compiled.identity;
export const SEMANTIC_PROFILE_FINGERPRINT = fingerprintCanonicalMaterial(
  SEMANTIC_PROFILE_IDENTITY,
);
export const validateSemanticProfileIdentity = (
  descriptorVersion: number,
  identity: unknown,
) => {
  if (
    descriptorVersion !==
      standardsManifest.canonicalProfile.semanticDescriptorVersion ||
    fingerprintCanonicalMaterial(identity) !==
      standardsManifest.canonicalProfile.semanticDescriptorFingerprint
  ) {
    throw new SemanticProfileError("semantic.profile.identity");
  }
};
validateSemanticProfileIdentity(
  compiled.profile.descriptorVersion,
  SEMANTIC_PROFILE_IDENTITY,
);
export const semanticProfilePackageBindings = deepFreeze(
  compiled.profile.packageConstantBindings,
);
export const semanticProfilePackageExportDispositions = deepFreeze(
  compiled.profile.packageExportDispositions,
);
export const semanticProfilePackageEnumBindings = deepFreeze(
  compiled.profile.packageEnumBindings,
);
export const semanticProfileOpenEnumPolicy = deepFreeze(
  compiled.profile.openEnumPolicy,
);
const spanKindRule = compiled.profile.upstreamConstraints.find(
  (
    constraint,
  ): constraint is Extract<
    UpstreamConstraint,
    { rule: "required-attribute" }
  > => constraint.rule === "required-attribute",
)!;
const llmSystemRule = compiled.profile.upstreamConstraints.find(
  (
    constraint,
  ): constraint is Extract<
    UpstreamConstraint,
    { rule: "required-or-absent-evidence" }
  > => constraint.rule === "required-or-absent-evidence",
)!;
const embeddingNameRule = compiled.profile.upstreamConstraints.find(
  (
    constraint,
  ): constraint is Extract<
    UpstreamConstraint,
    { rule: "required-span-name" }
  > => constraint.rule === "required-span-name",
)!;
export const semanticProfileUpstreamRules = deepFreeze({
  spanKind: spanKindRule,
  llmSystem: llmSystemRule,
  embeddingName: embeddingNameRule,
});

export const isSemanticCandidateUpstreamConstraintValid = (input: {
  readonly kind: string;
  readonly spanName: string;
  readonly presentFields: readonly string[];
  readonly unavailable: readonly {
    readonly field: string;
    readonly state: string;
  }[];
}): boolean => {
  if (
    input.kind ===
      semanticProfileUpstreamRules.embeddingName.openInferenceKind &&
    input.spanName !== semanticProfileUpstreamRules.embeddingName.spanName
  )
    return false;
  if (input.kind !== semanticProfileUpstreamRules.llmSystem.openInferenceKind)
    return true;
  const present = input.presentFields.includes(
    semanticProfileUpstreamRules.llmSystem.key,
  );
  const absentEvidence = input.unavailable.filter(
    ({ field }) => field === semanticProfileUpstreamRules.llmSystem.key,
  );
  return (
    (present && absentEvidence.length === 0) ||
    (!present &&
      absentEvidence.length === 1 &&
      semanticProfileUpstreamRules.llmSystem.absentStates.includes(
        absentEvidence[0]!.state as "redacted" | "unavailable",
      ))
  );
};

const directByKey = new Map(
  compiled.direct.map((value) => [value.key!, value]),
);
const structuralByKey = new Map(
  compiled.structural.map((value) => [value.key, value]),
);

const extensionRoute = (extension: AgentscopeExtensionDescriptor) =>
  extension.redaction === "retain" ? "retain-structural" : extension.redaction;

const extensionDescriptor = (
  extension: AgentscopeExtensionDescriptor,
): SemanticAttributeDescriptor => {
  const redaction = extensionRoute(extension);
  const contentClass =
    extension.contentClass === "structured-metadata"
      ? "derived-metadata"
      : extension.contentClass;
  return deepFreeze({
    support: "accepted",
    key: extension.key,
    valueType:
      extension.valueType === "json-string"
        ? "json-object-string"
        : extension.valueType,
    locations: [extension.applicability],
    ...(extension.openInferenceKinds === undefined
      ? {}
      : { openInferenceKinds: extension.openInferenceKinds }),
    contentClass,
    sensitivity: extension.sensitivity,
    redaction,
    standard: "agentscope",
    mandatoryTransforms: compiled.profile.redactionRoutes[redaction],
    allowedOutcomes: compiled.profile.allowedOutcomesByRoute[redaction],
    diagnosticExposure: "never",
  });
};

const extensionByKey = new Map(
  agentscopeExtensionRegistry.map((extension) => [
    extension.key,
    extensionDescriptor(extension),
  ]),
);

export const getSemanticAttributeDescriptor = (
  key: string,
): SemanticAttributeDescriptor | undefined => {
  const exact = directByKey.get(key) ?? extensionByKey.get(key);
  if (exact !== undefined) return exact;
  const matches = compiled.templates.filter(({ regularExpression }) =>
    regularExpression.test(key),
  );
  return matches.length === 1 ? matches[0] : undefined;
};

export const getAcceptedSemanticAttributeDescriptor = (key: string) => {
  const descriptor = getSemanticAttributeDescriptor(key);
  return descriptor?.support === "accepted" ? descriptor : undefined;
};

const validateFeedbackSemanticBinding = () => {
  let terminals = 0;
  for (const form of FEEDBACK_PROFILE.forms) {
    for (const [field, privacy] of Object.entries(FEEDBACK_PROFILE.fields)) {
      terminals += 1;
      const descriptor = getAcceptedSemanticAttributeDescriptor(
        `${form.prefix}.0.${form.object}.${field}`,
      );
      /* v8 ignore next -- startup binding failure is unreachable after descriptor compilation */
      if (
        descriptor?.standard !== "openinference" ||
        descriptor.valueType !== privacy.valueType ||
        descriptor.contentClass !== privacy.contentClass ||
        descriptor.sensitivity !== privacy.sensitivity ||
        descriptor.redaction !== privacy.redaction ||
        descriptor.sourceReference !==
          "openinference@553ff3a/spec/annotations.md"
      ) {
        /* v8 ignore next -- startup cross-binding; mutation coverage lives in feedback-profile tests */
        throw new SemanticProfileError("semantic.profile.feedback-binding");
      }
    }
  }
  /* v8 ignore next 2 -- the exact six-by-seven inventory is compiler-constructed */
  if (terminals !== 42)
    throw new SemanticProfileError("semantic.profile.feedback-binding");
};
validateFeedbackSemanticBinding();

export const getStructuralSemanticDescriptor = (key: string) =>
  structuralByKey.get(key);

export const isOpenInferenceSemanticNamespace = (key: string) =>
  compiled.profile.openInferenceRoots.includes(key.split(".")[0]!);

export const semanticProfileDescriptors = deepFreeze({
  attributes: [
    ...compiled.direct,
    ...compiled.templates,
    ...extensionByKey.values(),
  ] as readonly SemanticAttributeDescriptor[],
  structural: compiled.structural,
});

export const validateSemanticProfileForTesting = compileProfile;
