import { OpenInferenceSpanKind } from "@arizeai/openinference-semantic-conventions";
import { z } from "zod";

import { standardsManifest } from "../standards/manifest.js";
import {
  EVIDENCE_PROFILE_IDENTITY,
  rootEvidenceAccounting,
  spanEvidenceAccounting,
  validateSpanEvidence,
} from "./canonical-evidence.js";
import {
  CONTEXT_PROFILE_IDENTITY,
  parseFieldProvenance,
  parseFieldUnavailable,
} from "./context.js";
import {
  getAgentscopeExtension,
  type AgentscopeExtensionDescriptor,
  fingerprintCanonicalMaterial,
} from "./extensions.js";
import { deepFreeze } from "./immutable.js";
import {
  isOpenInferenceAttributeKey,
  isOpenInferenceValueValid,
  OPENINFERENCE_SPAN_KINDS,
} from "./openinference.js";
import {
  OTLP_GRAPH_LIMITS,
  OTLP_PROFILE_IDENTITY,
  OtlpResourceSpansSchema,
  type OtlpAnyValue,
  type OtlpKeyValue,
  type OtlpResourceSpans,
  type OtlpSpan,
} from "./otlp.js";
import {
  assertCanonicalInputBudget,
  ProtocolValidationError,
} from "./validation.js";
import {
  TOPOLOGY_PROFILE_IDENTITY,
  validateCanonicalTopology,
} from "./canonical-topology.js";
import {
  FEEDBACK_PROFILE,
  feedbackAttributesAreValid,
} from "./feedback-profile.js";
import {
  getAcceptedSemanticAttributeDescriptor,
  SEMANTIC_PROFILE_IDENTITY,
  semanticProfileDescriptors,
  semanticProfileUpstreamRules,
} from "./semantic-profile.js";

export const CANONICAL_SCOPE = deepFreeze({
  name: "@agentscope/protocol",
  version: String(standardsManifest.protocolContractVersion),
});

export const CANONICAL_RESOURCE_ATTRIBUTES = deepFreeze(
  Object.fromEntries(
    semanticProfileDescriptors.attributes.flatMap((descriptor) =>
      descriptor.key !== undefined &&
      descriptor.support === "accepted" &&
      descriptor.locations.includes("resource")
        ? [
            [
              descriptor.key,
              {
                valueType: descriptor.valueType,
                required:
                  descriptor.key === "agentscope.protocol.manifest_id" ||
                  descriptor.key === "service.name",
                contentClass: descriptor.contentClass,
                sensitivity: descriptor.sensitivity,
                redaction: descriptor.redaction,
              },
            ],
          ]
        : [],
    ),
  ),
);

export const CANONICAL_COMPOUND_RULES = deepFreeze({
  serviceName: "agentscope",
  scope: CANONICAL_SCOPE,
  constructedSpanKind: 1,
  resource: {
    repositoryUrlProtocols: ["http:", "https:"],
    repositoryUrlRejectedSuffix: ".git",
    vcsRefIdentity: "vcs.ref.head.revision",
    vcsRefDescriptions: ["vcs.ref.head.name", "vcs.ref.type"],
    vcsRefTypes: ["branch", "tag"],
    vcsRepositoryIdentity: "vcs.repository.url.full",
    vcsRepositoryDescriptions: ["vcs.repository.name"],
  },
  openInference: {
    rootKind: String(OpenInferenceSpanKind.AGENT),
    spanKindAttribute: semanticProfileUpstreamRules.spanKind.key,
    llmKind: semanticProfileUpstreamRules.llmSystem.openInferenceKind,
    llmRequiredOrUnavailable: [semanticProfileUpstreamRules.llmSystem.key],
    llmAbsentEvidenceStates:
      semanticProfileUpstreamRules.llmSystem.absentStates,
    embeddingKind: semanticProfileUpstreamRules.embeddingName.openInferenceKind,
    embeddingName: semanticProfileUpstreamRules.embeddingName.spanName,
    embeddingForbiddenIdentity: ["llm.system", "llm.provider"],
    standalonePostHocFeedbackRoot: {
      spanCount: 1,
      transport: "post-hoc",
      kindPolicy: "any-valid-openinference-kind",
      agentscopeExtensionApplicability: "root-kind-profile",
    },
  },
  evidence: {
    rootExtensions: [
      "agentscope.harness.name",
      "agentscope.harness.version",
      "agentscope.workspace.directory",
      "agentscope.git.worktree",
      "agentscope.git.repository_root",
    ],
    rootVcs: ["vcs.ref.head.name", "vcs.ref.head.revision", "vcs.ref.type"],
    llmFields: ["llm.model_name", "llm.provider", "llm.invocation_parameters"],
    rootFamilies: {
      toolActivity: "family.tool.activity",
      errorActivity: "family.error.activity",
    },
    llmFamilies: {
      usage: "family.llm.usage",
    },
  },
  context: {
    spanFlags: [0, 1, 256, 257],
    linkFlags: [0, 1, 256, 257, 768, 769],
    exceptionEventName: "exception",
  },
});

type AttributeLocation =
  "resource" | "scope" | "root-span" | "span" | "event" | "link";

export const CANONICAL_PROFILE_IDENTITY = deepFreeze({
  context: CONTEXT_PROFILE_IDENTITY,
  evidence: EVIDENCE_PROFILE_IDENTITY,
  semanticProfile: SEMANTIC_PROFILE_IDENTITY,
  otlp: OTLP_PROFILE_IDENTITY,
  compoundRules: CANONICAL_COMPOUND_RULES,
  topology: TOPOLOGY_PROFILE_IDENTITY,
  feedback: FEEDBACK_PROFILE,
});

export const validateCanonicalProfileIdentity = (material: unknown) => {
  if (
    fingerprintCanonicalMaterial(material) !==
    standardsManifest.canonicalProfile.profileFingerprint
  ) {
    throw new ProtocolValidationError("protocol.schema.invalid", [
      "canonical.profile.identity",
    ]);
  }
};

validateCanonicalProfileIdentity(CANONICAL_PROFILE_IDENTITY);

const isStringValue = (
  value: OtlpAnyValue | undefined,
): value is { stringValue: string } =>
  value !== undefined && "stringValue" in value;

const validateJsonString = (
  descriptor: AgentscopeExtensionDescriptor,
  value: string,
) => {
  if (descriptor.jsonShape === "agentscope.field-provenance.v1") {
    return parseFieldProvenance(value).success;
  }
  return parseFieldUnavailable(value).success;
};

const extensionValueIsValid = (
  descriptor: AgentscopeExtensionDescriptor,
  value: OtlpAnyValue,
) => {
  if (!isStringValue(value) || value.stringValue.length === 0) {
    return false;
  }
  if (
    descriptor.valueType === "json-string" &&
    !validateJsonString(descriptor, value.stringValue)
  ) {
    return false;
  }
  return true;
};

const issue = (
  context: z.RefinementCtx,
  code: string,
  path: readonly (string | number)[] = ["resourceSpans"],
) => {
  context.addIssue({ code: "custom", message: code, path: [...path] });
};

/* eslint-disable max-params -- schema refinement keeps semantic and extension kind authorities explicit */
const validateAgentscopeAttribute = (
  attribute: OtlpKeyValue,
  location: AttributeLocation,
  spanKind: string | undefined,
  context: z.RefinementCtx,
  path: readonly (string | number)[],
) => {
  const descriptor = getAgentscopeExtension(attribute.key);
  if (descriptor === undefined) {
    issue(context, "canonical.extension.unknown", path);
    return;
  }
  const locationMatches =
    descriptor.applicability === location ||
    (descriptor.applicability === "span" && location === "root-span");
  if (!locationMatches) {
    issue(context, "canonical.extension.location", path);
  }
  if (
    descriptor.openInferenceKinds !== undefined &&
    (spanKind === undefined ||
      !descriptor.openInferenceKinds.includes(spanKind))
  ) {
    issue(context, "canonical.extension.span-kind", path);
  }
  if (!extensionValueIsValid(descriptor, attribute.value)) {
    issue(context, "canonical.extension.value", path);
  }
};

const validateAttribute = (
  attribute: OtlpKeyValue,
  location: AttributeLocation,
  spanKind: string | undefined,
  extensionSpanKind: string | undefined,
  context: z.RefinementCtx,
  path: readonly (string | number)[],
) => {
  if (attribute.key.startsWith("agentscope.")) {
    validateAgentscopeAttribute(
      attribute,
      location,
      extensionSpanKind,
      context,
      path,
    );
  } else if (attribute.key.startsWith("gen_ai.")) {
    issue(context, "canonical.attribute.gen-ai-alias", path);
  } else {
    const profile = getAcceptedSemanticAttributeDescriptor(attribute.key);
    if (profile === undefined || !profile.locations.includes(location)) {
      issue(
        context,
        isOpenInferenceAttributeKey(attribute.key)
          ? "canonical.openinference.key"
          : "canonical.attribute.unknown",
        path,
      );
    } else {
      if (!isOpenInferenceValueValid(profile, attribute.value)) {
        issue(
          context,
          profile.standard === "openinference"
            ? "canonical.openinference.value"
            : "canonical.attribute.value",
          path,
        );
      }
      if (
        profile.openInferenceKinds !== undefined &&
        !profile.openInferenceKinds.includes(spanKind ?? "")
      ) {
        issue(context, "canonical.openinference.kind-applicability", path);
      }
    }
  }
};

const attributesAreCanonical = (
  attributes: readonly OtlpKeyValue[] | undefined,
) => {
  const keys = attributes?.map(({ key }) => key) ?? [];
  return keys.every((key, index) => index === 0 || keys[index - 1]! < key);
};

const validateAttributes = (
  attributes: readonly OtlpKeyValue[] | undefined,
  location: AttributeLocation,
  spanKind: string | undefined,
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  extensionSpanKind = spanKind,
) => {
  if (!attributesAreCanonical(attributes)) {
    issue(context, "canonical.attribute.order", path);
  }
  attributes?.forEach((attribute, index) => {
    validateAttribute(
      attribute,
      location,
      spanKind,
      extensionSpanKind,
      context,
      [...path, index],
    );
  });
};
/* eslint-enable max-params */

const findAttribute = (
  attributes: readonly OtlpKeyValue[] | undefined,
  key: string,
) => attributes?.find((attribute) => attribute.key === key);

const getOpenInferenceKind = (span: OtlpSpan) => {
  const value = findAttribute(
    span.attributes,
    semanticProfileUpstreamRules.spanKind.key,
  )?.value;
  return isStringValue(value) ? value.stringValue : undefined;
};

const isStandaloneFeedbackRoot = (
  spans: readonly OtlpSpan[],
  transportRequired: boolean,
) => {
  if (spans.length !== 1) return false;
  const span = spans[0]!;
  const transport = findAttribute(
    span.attributes,
    FEEDBACK_PROFILE.postHoc.transportKey,
  )?.value;
  const explicitPostHoc =
    isStringValue(transport) &&
    transport.stringValue ===
      CANONICAL_COMPOUND_RULES.openInference.standalonePostHocFeedbackRoot
        .transport;
  const tolerantUnclassified = !transportRequired && transport === undefined;
  return (
    (explicitPostHoc || tolerantUnclassified) &&
    feedbackAttributesAreValid(span, transportRequired)
  );
};

const flattenSpans = (resource: OtlpResourceSpans) =>
  resource.scopeSpans.flatMap(({ spans }) => spans);

const isCredentialFreeRepositoryUrl = (value: string) => {
  if (value.trim() !== value) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      CANONICAL_COMPOUND_RULES.resource.repositoryUrlProtocols.includes(
        parsed.protocol,
      ) &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      !parsed.pathname
        .replace(/\/$/u, "")
        .toLowerCase()
        .endsWith(CANONICAL_COMPOUND_RULES.resource.repositoryUrlRejectedSuffix)
    );
  } catch {
    return false;
  }
};

const validateResource = (
  resource: OtlpResourceSpans,
  context: z.RefinementCtx,
) => {
  if (resource.schemaUrl !== undefined) {
    issue(context, "canonical.resource.schema-url");
  }
  const attributes = resource.resource?.attributes;
  validateAttributes(attributes, "resource", undefined, context, [
    "resourceSpans",
    0,
    "resource",
    "attributes",
  ]);
  const manifest = findAttribute(
    attributes,
    "agentscope.protocol.manifest_id",
  )?.value;
  if (
    !isStringValue(manifest) ||
    manifest.stringValue !== standardsManifest.manifestId
  ) {
    issue(context, "canonical.resource.manifest");
  }
  const serviceName = findAttribute(attributes, "service.name")?.value;
  if (
    !isStringValue(serviceName) ||
    serviceName.stringValue !== CANONICAL_COMPOUND_RULES.serviceName
  ) {
    issue(context, "canonical.resource.service");
  }
  const repositoryUrl = findAttribute(
    attributes,
    CANONICAL_COMPOUND_RULES.resource.vcsRepositoryIdentity,
  )?.value;
  if (
    isStringValue(repositoryUrl) &&
    !isCredentialFreeRepositoryUrl(repositoryUrl.stringValue)
  ) {
    issue(context, "canonical.resource.repository-url");
  }
  const revision = findAttribute(
    attributes,
    CANONICAL_COMPOUND_RULES.resource.vcsRefIdentity,
  );
  const refDescriptions =
    CANONICAL_COMPOUND_RULES.resource.vcsRefDescriptions.map((key) =>
      findAttribute(attributes, key),
    );
  const refType = findAttribute(attributes, "vcs.ref.type")?.value;
  if (
    refDescriptions.some((value) => value !== undefined) &&
    revision === undefined
  ) {
    issue(context, "canonical.resource.vcs-ref-identity");
  }
  if (
    isStringValue(refType) &&
    !CANONICAL_COMPOUND_RULES.resource.vcsRefTypes.includes(refType.stringValue)
  ) {
    issue(context, "canonical.resource.vcs-ref-type");
  }
  if (
    CANONICAL_COMPOUND_RULES.resource.vcsRepositoryDescriptions.some(
      (key) => findAttribute(attributes, key) !== undefined,
    ) &&
    repositoryUrl === undefined
  ) {
    issue(context, "canonical.resource.vcs-repository-identity");
  }
};

const validateScope = (
  resource: OtlpResourceSpans,
  context: z.RefinementCtx,
) => {
  const scopeSpans = resource.scopeSpans[0];
  if (
    scopeSpans?.scope?.name !== CANONICAL_COMPOUND_RULES.scope.name ||
    scopeSpans.scope.version !== CANONICAL_COMPOUND_RULES.scope.version
  ) {
    issue(context, "canonical.scope.identity");
  }
  if (
    scopeSpans?.scope?.attributes !== undefined ||
    (scopeSpans?.scope?.droppedAttributesCount ?? 0) !== 0 ||
    scopeSpans?.schemaUrl !== undefined
  ) {
    issue(context, "canonical.scope.extra");
  }
};

const validateLosslessCounts = (
  resource: OtlpResourceSpans,
  context: z.RefinementCtx,
) => {
  if ((resource.resource?.droppedAttributesCount ?? 0) !== 0) {
    issue(context, "canonical.dropped.resource-attributes");
  }
  for (const span of flattenSpans(resource)) {
    if (
      (span.droppedAttributesCount ?? 0) !== 0 ||
      (span.droppedEventsCount ?? 0) !== 0 ||
      (span.droppedLinksCount ?? 0) !== 0
    ) {
      issue(context, "canonical.dropped.span-data");
    }
    if (
      span.traceState !== undefined ||
      !CANONICAL_COMPOUND_RULES.context.spanFlags.includes(span.flags ?? 0)
    ) {
      issue(context, "canonical.span.context");
    }
    span.events?.forEach((event) => {
      if ((event.droppedAttributesCount ?? 0) !== 0) {
        issue(context, "canonical.dropped.event-attributes");
      }
      if (
        event.attributes?.some(({ key }) => key.startsWith("exception.")) ===
          true &&
        event.name !== CANONICAL_COMPOUND_RULES.context.exceptionEventName
      ) {
        issue(context, "canonical.exception.event-name");
      }
    });
    span.links?.forEach((link) => {
      if (
        (link.droppedAttributesCount ?? 0) !== 0 ||
        link.traceState !== undefined ||
        !CANONICAL_COMPOUND_RULES.context.linkFlags.includes(link.flags ?? 0)
      ) {
        issue(context, "canonical.link.context");
      }
    });
  }
};

const validateSpanAttributeLocations = (
  resource: OtlpResourceSpans,
  rootSpanId: string | undefined,
  context: z.RefinementCtx,
  transportRequired: boolean,
) => {
  const spans = resource.scopeSpans[0]!.spans;
  spans.forEach((span, spanIndex) => {
    const path = [
      "resourceSpans",
      0,
      "scopeSpans",
      0,
      "spans",
      spanIndex,
    ] as const;
    const kind = getOpenInferenceKind(span);
    const standaloneFeedback =
      span.spanId === rootSpanId &&
      isStandaloneFeedbackRoot(spans, transportRequired);
    validateAttributes(
      span.attributes,
      span.spanId === rootSpanId ? "root-span" : "span",
      kind,
      context,
      [...path, "attributes"],
      standaloneFeedback
        ? CANONICAL_COMPOUND_RULES.openInference.rootKind
        : kind,
    );
    span.events?.forEach((event, eventIndex) => {
      validateAttributes(event.attributes, "event", kind, context, [
        ...path,
        "events",
        eventIndex,
        "attributes",
      ]);
    });
    span.links?.forEach((link, linkIndex) => {
      validateAttributes(link.attributes, "link", kind, context, [
        ...path,
        "links",
        linkIndex,
        "attributes",
      ]);
    });
  });
};

const validateKinds = (
  spans: readonly OtlpSpan[],
  rootSpanId: string | undefined,
  context: z.RefinementCtx,
  transportRequired: boolean,
) => {
  const rootAllowsAnyKind = isStandaloneFeedbackRoot(spans, transportRequired);
  for (const span of spans) {
    const kind = getOpenInferenceKind(span);
    if (
      kind === undefined ||
      !(OPENINFERENCE_SPAN_KINDS as readonly string[]).includes(kind)
    ) {
      issue(context, "canonical.openinference.span-kind");
    } else if (
      span.spanId === rootSpanId &&
      !rootAllowsAnyKind &&
      kind !== CANONICAL_COMPOUND_RULES.openInference.rootKind
    ) {
      issue(context, "canonical.root.kind");
    }
    if (
      kind === CANONICAL_COMPOUND_RULES.openInference.embeddingKind &&
      CANONICAL_COMPOUND_RULES.openInference.embeddingForbiddenIdentity.some(
        (key) => findAttribute(span.attributes, key) !== undefined,
      )
    ) {
      issue(context, "canonical.openinference.embedding-llm-identity");
    }
    if (
      kind === CANONICAL_COMPOUND_RULES.openInference.embeddingKind &&
      span.name !== CANONICAL_COMPOUND_RULES.openInference.embeddingName
    ) {
      issue(context, "canonical.openinference.embedding-name");
    }
  }
};

const validateFeedback = (
  spans: readonly OtlpSpan[],
  context: z.RefinementCtx,
  transportRequired: boolean,
) => {
  spans.forEach((span, index) => {
    if (!feedbackAttributesAreValid(span, transportRequired)) {
      issue(context, "canonical.openinference.feedback", [
        "resourceSpans",
        0,
        "scopeSpans",
        0,
        "spans",
        index,
      ]);
    }
  });
};

const validateRequiredExtensions = (
  resource: OtlpResourceSpans,
  spans: readonly OtlpSpan[],
  rootSpanId: string | undefined,
  context: z.RefinementCtx,
) => {
  const resourceAttributes = resource.resource?.attributes;
  for (const descriptor of standardsManifest.agentscopeExtensions.entries) {
    if (descriptor.requirementLevel !== "required") {
      continue;
    }
    if (descriptor.applicability === "resource") {
      if (findAttribute(resourceAttributes, descriptor.key) === undefined) {
        issue(context, "canonical.extension.required-resource");
      }
    } else if (descriptor.applicability === "root-span") {
      const root = spans.find(({ spanId }) => spanId === rootSpanId);
      if (findAttribute(root?.attributes, descriptor.key) === undefined) {
        issue(context, "canonical.extension.required-root");
      }
    } else if (
      spans.some(
        (span) => findAttribute(span.attributes, descriptor.key) === undefined,
      )
    ) {
      issue(context, "canonical.extension.required-span");
    }
  }
};

const canonicalTraceGraphBaseSchema = z
  .object({
    resourceSpans: z
      .array(OtlpResourceSpansSchema)
      .length(OTLP_GRAPH_LIMITS.resourceSpans),
  })
  .strict();

const canonicalTraceGraphSchema = (transportRequired: boolean) =>
  canonicalTraceGraphBaseSchema.superRefine(({ resourceSpans }, context) => {
    const resource = resourceSpans[0]!;
    const spans = flattenSpans(resource);
    const rootSpanId = validateCanonicalTopology(spans, context, issue);
    const standalonePostHocFeedbackRoot = isStandaloneFeedbackRoot(
      spans,
      transportRequired,
    );
    validateResource(resource, context);
    validateScope(resource, context);
    validateLosslessCounts(resource, context);
    validateSpanAttributeLocations(
      resource,
      rootSpanId,
      context,
      transportRequired,
    );
    validateKinds(spans, rootSpanId, context, transportRequired);
    validateFeedback(spans, context, transportRequired);
    validateRequiredExtensions(resource, spans, rootSpanId, context);
    const rootResourceFields = new Set(
      (resource.resource?.attributes ?? [])
        .map(({ key }) => key)
        .filter((key) => key.startsWith("vcs.")),
    );
    const descendants = spans.filter(({ spanId }) => spanId !== rootSpanId);
    const descendantBounds =
      descendants.length === 0
        ? undefined
        : {
            start: descendants.reduce(
              (minimum, span) =>
                BigInt(span.startTimeUnixNano) < BigInt(minimum)
                  ? span.startTimeUnixNano
                  : minimum,
              descendants[0]!.startTimeUnixNano,
            ),
            end: descendants.reduce(
              (maximum, span) =>
                BigInt(span.endTimeUnixNano) > BigInt(maximum)
                  ? span.endTimeUnixNano
                  : maximum,
              descendants[0]!.endTimeUnixNano,
            ),
          };
    spans.forEach((span) => {
      validateSpanEvidence(
        span,
        {
          additionalFields:
            span.spanId === rootSpanId ? rootResourceFields : new Set(),
          accountingFields:
            span.spanId === rootSpanId && !standalonePostHocFeedbackRoot
              ? rootEvidenceAccounting(
                  resource,
                  span,
                  spans,
                  CANONICAL_COMPOUND_RULES.evidence,
                )
              : spanEvidenceAccounting(
                  span,
                  CANONICAL_COMPOUND_RULES.evidence,
                  CANONICAL_COMPOUND_RULES.openInference.llmKind,
                ),
          ...(span.spanId === rootSpanId && descendantBounds !== undefined
            ? { descendantBounds }
            : {}),
          isRoot: span.spanId === rootSpanId,
          llmKind: CANONICAL_COMPOUND_RULES.openInference.llmKind,
          llmRequiredOrUnavailable:
            CANONICAL_COMPOUND_RULES.openInference.llmRequiredOrUnavailable,
          llmAbsentEvidenceStates:
            CANONICAL_COMPOUND_RULES.openInference.llmAbsentEvidenceStates,
          resourceFields: new Set(Object.keys(CANONICAL_RESOURCE_ATTRIBUTES)),
        },
        context,
        issue,
      );
    });
  });

const rawCanonicalTraceGraphSchema = canonicalTraceGraphSchema(true);
const tolerantCanonicalTraceGraphSchema = canonicalTraceGraphSchema(false);

export type CanonicalTraceGraph = z.infer<typeof rawCanonicalTraceGraphSchema>;

const parseAgainstSchema = (
  input: unknown,
  schema: typeof rawCanonicalTraceGraphSchema,
): CanonicalTraceGraph => {
  try {
    assertCanonicalInputBudget(input);
    const result = schema.safeParse(input);
    if (result.success) {
      return result.data;
    }
    const stableIssues = result.error.issues.map(({ message }) =>
      message.startsWith("canonical.") ? message : "protocol.schema.invalid",
    );
    throw new ProtocolValidationError("protocol.schema.invalid", stableIssues);
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw error;
    }
  }
  throw new ProtocolValidationError("protocol.schema.invalid");
};

const parseCanonical = (input: unknown): CanonicalTraceGraph =>
  parseAgainstSchema(input, rawCanonicalTraceGraphSchema);

export const safeParseTolerantCanonicalTraceGraph = (input: unknown) => {
  try {
    return {
      success: true as const,
      data: parseAgainstSchema(input, tolerantCanonicalTraceGraphSchema),
    };
  } catch (error) {
    return { success: false as const, error: error as ProtocolValidationError };
  }
};

export const CanonicalTraceGraphSchema = Object.freeze({
  parse: parseCanonical,
  safeParse: (input: unknown) => {
    try {
      return { success: true as const, data: parseCanonical(input) };
    } catch (error) {
      return {
        success: false as const,
        error: error as ProtocolValidationError,
      };
    }
  },
});

export const parseCanonicalTraceGraph = parseCanonical;
export const safeParseCanonicalTraceGraph = CanonicalTraceGraphSchema.safeParse;
