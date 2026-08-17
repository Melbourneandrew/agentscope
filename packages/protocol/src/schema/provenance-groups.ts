import { OpenInferenceSpanKind } from "@arizeai/openinference-semantic-conventions";

import {
  CONTEXT_PROFILE_IDENTITY,
  FieldProvenanceSchema,
  FieldUnavailableSchema,
  type FieldProvenance,
  type FieldUnavailable,
} from "./context.js";
import { deepFreeze } from "./immutable.js";
import {
  getAcceptedSemanticAttributeDescriptor,
  semanticProfileDescriptors,
  type TemplateSegment,
} from "./semantic-profile.js";

export type ProvenanceGroupSegment =
  string | { readonly index: true } | { readonly oneOf: readonly string[] };
type GroupLevel = "outer-object" | "nested-object";
const ANY_OPENINFERENCE_KIND = "any-openinference-kind";
export type ProvenanceGroupSpec = {
  readonly id: string;
  readonly level: GroupLevel;
  readonly kind: string;
  readonly segments: readonly ProvenanceGroupSegment[];
  readonly templateIds: readonly string[];
};

export const PROVENANCE_GROUP_SPECS = deepFreeze([
  {
    id: "llm-message",
    level: "outer-object",
    kind: String(OpenInferenceSpanKind.LLM),
    segments: [
      "llm",
      { oneOf: ["input_messages", "output_messages"] },
      { index: true },
    ],
    templateIds: [
      "llm-message-content",
      "llm-message-identity",
      "llm-message-function-arguments",
      "llm-message-content-text",
      "llm-message-content-id",
      "llm-message-content-opaque",
      "llm-message-content-type",
      "llm-message-image-url",
      "llm-input-message-audio-url",
      "llm-message-tool-call-identity",
      "llm-message-tool-call-reasoning-signature",
      "llm-message-tool-call-arguments",
    ],
  },
  {
    id: "llm-message-content-item",
    level: "nested-object",
    kind: String(OpenInferenceSpanKind.LLM),
    segments: [
      "llm",
      { oneOf: ["input_messages", "output_messages"] },
      { index: true },
      "message",
      "contents",
      { index: true },
    ],
    templateIds: [
      "llm-message-content-text",
      "llm-message-content-id",
      "llm-message-content-opaque",
      "llm-message-content-type",
      "llm-message-image-url",
      "llm-input-message-audio-url",
      "llm-message-tool-call-identity",
      "llm-message-tool-call-reasoning-signature",
      "llm-message-tool-call-arguments",
    ],
  },
  {
    id: "llm-message-tool-call-item",
    level: "nested-object",
    kind: String(OpenInferenceSpanKind.LLM),
    segments: [
      "llm",
      { oneOf: ["input_messages", "output_messages"] },
      { index: true },
      "message",
      "tool_calls",
      { index: true },
    ],
    templateIds: [
      "llm-message-tool-call-identity",
      "llm-message-tool-call-reasoning-signature",
      "llm-message-tool-call-arguments",
    ],
  },
  {
    id: "llm-tool",
    level: "outer-object",
    kind: String(OpenInferenceSpanKind.LLM),
    segments: ["llm", "tools", { index: true }],
    templateIds: ["llm-tool-schema"],
  },
  {
    id: "llm-prompt",
    level: "outer-object",
    kind: String(OpenInferenceSpanKind.LLM),
    segments: ["llm", "prompts", { index: true }],
    templateIds: ["llm-prompt-text"],
  },
  {
    id: "llm-choice",
    level: "outer-object",
    kind: String(OpenInferenceSpanKind.LLM),
    segments: ["llm", "choices", { index: true }],
    templateIds: ["llm-choice-text"],
  },
  {
    id: "embedding",
    level: "outer-object",
    kind: String(OpenInferenceSpanKind.EMBEDDING),
    segments: ["embedding", "embeddings", { index: true }],
    templateIds: ["embedding-text", "embedding-vector"],
  },
  {
    id: "retrieval-document",
    level: "outer-object",
    kind: String(OpenInferenceSpanKind.RETRIEVER),
    segments: ["retrieval", "documents", { index: true }],
    templateIds: [
      "retrieval-document-id",
      "retrieval-document-content",
      "retrieval-document-score",
      "retrieval-document-metadata",
    ],
  },
  {
    id: "reranker-document",
    level: "outer-object",
    kind: String(OpenInferenceSpanKind.RERANKER),
    segments: [
      "reranker",
      { oneOf: ["input_documents", "output_documents"] },
      { index: true },
    ],
    templateIds: [
      "reranker-document-id",
      "reranker-document-content",
      "reranker-document-score",
      "reranker-document-metadata",
    ],
  },
  {
    id: "span-annotation-feedback",
    level: "outer-object",
    kind: ANY_OPENINFERENCE_KIND,
    segments: ["annotations", { index: true }],
    templateIds: [
      "feedback-identifier",
      "feedback-score",
      "feedback-explanation",
      "feedback-metadata",
    ],
  },
  {
    id: "span-evaluation-feedback",
    level: "outer-object",
    kind: ANY_OPENINFERENCE_KIND,
    segments: ["evaluations", { index: true }],
    templateIds: [
      "feedback-identifier",
      "feedback-score",
      "feedback-explanation",
      "feedback-metadata",
    ],
  },
  {
    id: "trace-annotation-feedback",
    level: "outer-object",
    kind: ANY_OPENINFERENCE_KIND,
    segments: ["trace", "annotations", { index: true }],
    templateIds: [
      "feedback-identifier",
      "feedback-score",
      "feedback-explanation",
      "feedback-metadata",
    ],
  },
  {
    id: "trace-evaluation-feedback",
    level: "outer-object",
    kind: ANY_OPENINFERENCE_KIND,
    segments: ["trace", "evaluations", { index: true }],
    templateIds: [
      "feedback-identifier",
      "feedback-score",
      "feedback-explanation",
      "feedback-metadata",
    ],
  },
  {
    id: "session-annotation-feedback",
    level: "outer-object",
    kind: ANY_OPENINFERENCE_KIND,
    segments: ["session", "annotations", { index: true }],
    templateIds: [
      "feedback-identifier",
      "feedback-score",
      "feedback-explanation",
      "feedback-metadata",
    ],
  },
  {
    id: "session-evaluation-feedback",
    level: "outer-object",
    kind: ANY_OPENINFERENCE_KIND,
    segments: ["session", "evaluations", { index: true }],
    templateIds: [
      "feedback-identifier",
      "feedback-score",
      "feedback-explanation",
      "feedback-metadata",
    ],
  },
] as const satisfies readonly ProvenanceGroupSpec[]);

const MAXIMUM_CLAIMS = 192;
const MAXIMUM_FIELD_CODE_UNITS = 1_024;
const canonicalIndex = /^(?:0|[1-9]\d{0,3})$/u;
export const PROVENANCE_SPAN_KINDS = deepFreeze(
  (() => {
    const values = getAcceptedSemanticAttributeDescriptor(
      "openinference.span.kind",
    )?.allowedValues;
    /* v8 ignore next -- module-load invariant checked by semantic profile tests */
    if (values === undefined) throw new Error("protocol.profile.invalid");
    return [...values].sort();
  })(),
);
const provenanceSpanKinds = new Set(PROVENANCE_SPAN_KINDS);
export const PROVENANCE_STRUCTURAL_FIELDS = deepFreeze([
  "span.trace_id",
  "span.span_id",
  "span.parent_span_id",
  "span.kind",
  "span.flags",
  "span.name",
  "span.start_time_unix_nano",
  "span.end_time_unix_nano",
  "span.status.code",
  "span.status.message",
  "span.events",
  "span.links",
  "span.links.target_ids",
] as const);
export const PROVENANCE_MEMBER_EVIDENCE = deepFreeze({
  maximumIndex: 9_999,
  indexGrammar: "0|[1-9]\\d{0,3}",
  event: {
    prefix: "span.events",
    structuralTerminals: ["event", "name", "time_unix_nano"],
    attributeMarker: "attributes",
    location: "event",
  },
  link: {
    prefix: "span.links",
    structuralTerminals: ["link", "relationship", "target_ids"],
    attributeMarker: "attributes",
    location: "link",
  },
  retainedOrdering: "ascending-original-index",
  omittedIndexPolicy: "exact-unavailable-preserve-hole",
});
const structuralFields = new Set<string>(PROVENANCE_STRUCTURAL_FIELDS);
export const PROVENANCE_FAMILY_KINDS = deepFreeze({
  "family.tool.activity": String(OpenInferenceSpanKind.AGENT),
  "family.error.activity": String(OpenInferenceSpanKind.AGENT),
  "family.llm.usage": String(OpenInferenceSpanKind.LLM),
});
const familyKinds = new Map(Object.entries(PROVENANCE_FAMILY_KINDS));
const memberEvidencePattern =
  /^span\.(events|links)\.(0|[1-9]\d{0,3})\.(event|name|time_unix_nano|link|relationship|target_ids|attributes\.(.+))$/u;

const memberEvidenceIsGoverned = (field: string, spanKind: string) => {
  const match = memberEvidencePattern.exec(field);
  if (match === null) return false;
  const collection = match[1]!;
  const terminal = match[3]!;
  if (collection === "events") {
    if (["event", "name", "time_unix_nano"].includes(terminal)) return true;
  } else if (["link", "relationship", "target_ids"].includes(terminal))
    return true;
  if (!terminal.startsWith("attributes.")) return false;
  const semanticKey = match[4]!;
  const descriptor = getAcceptedSemanticAttributeDescriptor(semanticKey);
  const location = collection === "events" ? "event" : "link";
  if (descriptor === undefined || !descriptor.locations.includes(location))
    return false;
  /* v8 ignore next -- pinned event/link descriptors are kind-open. */
  return (
    descriptor.openInferenceKinds === undefined ||
    descriptor.openInferenceKinds.includes(spanKind)
  );
};

export class ProvenanceLedgerError extends Error {
  readonly code = "protocol.provenance-ledger.invalid";

  constructor() {
    super("protocol.provenance-ledger.invalid");
    this.name = "ProvenanceLedgerError";
  }
}

const readDataRecord = (
  value: unknown,
  required: readonly string[],
  allowed: readonly string[],
) => {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new ProvenanceLedgerError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (
    required.some((key) => descriptors[key] === undefined) ||
    keys.some((key) => !allowed.includes(key)) ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return (
        descriptor === undefined || "get" in descriptor || "set" in descriptor
      );
    })
  )
    throw new ProvenanceLedgerError();
  return Object.fromEntries(
    keys.map((key) => [key, descriptors[key]!.value]),
  ) as Record<string, unknown>;
};

const readDataArray = (value: unknown, maximum: number) => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    throw new ProvenanceLedgerError();
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >;
  const length: unknown = descriptors.length?.value;
  if (
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < 0 ||
    length > maximum
  )
    throw new ProvenanceLedgerError();
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || "get" in descriptor || "set" in descriptor)
      throw new ProvenanceLedgerError();
    result.push(descriptor.value);
  }
  if (
    Object.keys(descriptors).some(
      (key) => key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key),
    )
  )
    throw new ProvenanceLedgerError();
  return result;
};

const readProvenanceClaim = (value: unknown): FieldProvenance[number] => {
  const record = readDataRecord(
    value,
    ["field", "source"],
    ["field", "source", "timingBasis", "nativeState"],
  );
  const parsed = FieldProvenanceSchema.element.safeParse(record);
  if (!parsed.success) throw new ProvenanceLedgerError();
  return parsed.data;
};

const readUnavailableClaim = (value: unknown): UnavailableProvenanceClaim => {
  const record = readDataRecord(
    value,
    ["field", "source", "state", "reason"],
    ["field", "source", "state", "reason"],
  );
  const provenance = readProvenanceClaim({
    field: record.field,
    source: record.source,
  });
  const unavailable = FieldUnavailableSchema.element.safeParse({
    field: record.field,
    state: record.state,
    reason: record.reason,
  });
  if (!unavailable.success) throw new ProvenanceLedgerError();
  return { ...unavailable.data, source: provenance.source };
};

const segmentMatches = (pattern: ProvenanceGroupSegment, value: string) => {
  if (typeof pattern === "string") return pattern === value;
  if ("index" in pattern) return canonicalIndex.test(value);
  return pattern.oneOf.includes(value);
};

const segmentsOverlap = (
  left: ProvenanceGroupSegment,
  right: TemplateSegment,
) => {
  if (typeof left === "string") {
    if (typeof right === "string") return left === right;
    if ("index" in right) return canonicalIndex.test(left);
    if ("oneOf" in right) return right.oneOf.includes(left);
    return false;
  }
  if (typeof right === "string") return segmentMatches(left, right);
  if ("index" in left) return "index" in right;
  if ("oneOf" in right)
    return left.oneOf.some((value) => right.oneOf.includes(value));
  return false;
};
export const provenanceSegmentsOverlapForTesting = segmentsOverlap;

const segmentCovers = (
  group: ProvenanceGroupSegment,
  template: TemplateSegment,
) => {
  if (typeof template === "string") return segmentMatches(group, template);
  if (typeof group === "string") return false;
  if ("index" in template) return "index" in group;
  if ("index" in group) return false;
  if ("oneOf" in template)
    return template.oneOf.every((value) => group.oneOf.includes(value));
  return false;
};
export const provenanceSegmentCoversForTesting = segmentCovers;

const groupMatchesAlternative = (
  group: ProvenanceGroupSpec,
  alternative: readonly TemplateSegment[],
) =>
  group.segments.length < alternative.length &&
  group.segments.every((segment, index) =>
    segmentCovers(segment, alternative[index]!),
  );

const groupPatternsOverlap = (
  left: ProvenanceGroupSpec,
  right: ProvenanceGroupSpec,
) =>
  left.kind === right.kind &&
  left.segments.length === right.segments.length &&
  left.segments.every((segment, index) =>
    segmentsOverlap(segment, right.segments[index]!),
  );

const validateGroupSpecs = (specs: readonly ProvenanceGroupSpec[]) => {
  const acceptedIndexed = semanticProfileDescriptors.attributes.filter(
    (descriptor) =>
      descriptor.standard === "openinference" &&
      descriptor.support === "accepted" &&
      descriptor.templateId !== undefined &&
      descriptor.match?.alternatives.some((alternative) =>
        alternative.some(
          (segment) => typeof segment !== "string" && "index" in segment,
        ),
      ) === true,
  );
  const byId = new Map(
    acceptedIndexed.map((descriptor) => [descriptor.templateId!, descriptor]),
  );
  if (
    new Set(specs.map(({ id }) => id)).size !== specs.length ||
    specs.some(
      (group) =>
        group.id.length === 0 ||
        group.segments.length === 0 ||
        group.templateIds.length === 0 ||
        new Set(group.templateIds).size !== group.templateIds.length,
    )
  )
    throw new ProvenanceLedgerError();
  for (const group of specs) {
    for (const templateId of group.templateIds) {
      const descriptor = byId.get(templateId);
      if (
        descriptor === undefined ||
        (group.kind === ANY_OPENINFERENCE_KIND
          ? descriptor.openInferenceKinds?.length !==
              PROVENANCE_SPAN_KINDS.length ||
            descriptor.openInferenceKinds.some(
              (kind) => !provenanceSpanKinds.has(kind),
            )
          : descriptor.openInferenceKinds?.includes(group.kind) !== true) ||
        descriptor.match?.alternatives.some((alternative) =>
          groupMatchesAlternative(group, alternative),
        ) !== true
      )
        throw new ProvenanceLedgerError();
    }
  }
  for (const descriptor of acceptedIndexed) {
    for (const alternative of descriptor.match!.alternatives) {
      const owners = specs.filter(
        (group) =>
          group.level === "outer-object" &&
          group.templateIds.includes(descriptor.templateId as never) &&
          groupMatchesAlternative(group, alternative),
      );
      if (owners.length !== 1) throw new ProvenanceLedgerError();
    }
  }
  for (const [index, group] of specs.entries()) {
    if (
      specs
        .slice(index + 1)
        .some((candidate) => groupPatternsOverlap(group, candidate))
    )
      throw new ProvenanceLedgerError();
  }
};

validateGroupSpecs(PROVENANCE_GROUP_SPECS);
export const validateProvenanceGroupSpecsForTesting = (
  specs: readonly ProvenanceGroupSpec[],
) => {
  validateGroupSpecs(specs);
};

export const PROVENANCE_GROUP_PROFILE_IDENTITY = deepFreeze({
  specs: PROVENANCE_GROUP_SPECS,
  precedence: ["exact-terminal", "deepest-claimed-group", "ancestor-group"],
  groupPurpose: "present-member-compression-default-only",
  unavailablePolicy: "exact-terminal-only",
  canonicalIndex: { minimum: 0, maximum: 9999, leadingZero: "reject" },
  maximumClaims: MAXIMUM_CLAIMS,
  maximumFieldCodeUnits: MAXIMUM_FIELD_CODE_UNITS,
  spanKinds: PROVENANCE_SPAN_KINDS,
  structuralFields: PROVENANCE_STRUCTURAL_FIELDS,
  memberEvidence: PROVENANCE_MEMBER_EVIDENCE,
  familyKinds: PROVENANCE_FAMILY_KINDS,
});

const matchConcreteGroup = (field: string, spanKind?: string) => {
  const values = field.split(".");
  return PROVENANCE_GROUP_SPECS.filter(
    (group) =>
      (spanKind === undefined ||
        group.kind === spanKind ||
        group.kind === ANY_OPENINFERENCE_KIND) &&
      values.length === group.segments.length &&
      group.segments.every((segment, index) =>
        segmentMatches(segment, values[index]!),
      ),
  );
};

export const isProvenanceGroupField = (field: string, spanKind?: string) => {
  if (
    typeof field !== "string" ||
    (spanKind !== undefined && typeof spanKind !== "string")
  )
    return false;
  return matchConcreteGroup(field, spanKind).length === 1;
};

const targetsForField = (field: string, spanKind: string) => {
  if (
    !provenanceSpanKinds.has(spanKind) ||
    field.length === 0 ||
    field.length > MAXIMUM_FIELD_CODE_UNITS
  )
    return undefined;
  const descriptor = getAcceptedSemanticAttributeDescriptor(field);
  if (descriptor === undefined) {
    if (
      structuralFields.has(field) ||
      familyKinds.get(field) === spanKind ||
      memberEvidenceIsGoverned(field, spanKind)
    )
      return { exact: field, groups: [] as string[] };
    return undefined;
  }
  if (
    descriptor.openInferenceKinds !== undefined &&
    !descriptor.openInferenceKinds.includes(spanKind)
  )
    return undefined;
  if (
    descriptor.templateId === undefined ||
    descriptor.match?.alternatives.every((alternative) =>
      alternative.every(
        (segment) => typeof segment === "string" || !("index" in segment),
      ),
    ) === true
  )
    return { exact: field, groups: [] as string[] };
  const values = field.split(".");
  const groups = PROVENANCE_GROUP_SPECS.flatMap((group) =>
    (group.kind === spanKind || group.kind === ANY_OPENINFERENCE_KIND) &&
    group.templateIds.includes(descriptor.templateId as never) &&
    values.length > group.segments.length &&
    group.segments.every((segment, index) =>
      segmentMatches(segment, values[index]!),
    )
      ? [values.slice(0, group.segments.length).join(".")]
      : [],
  ).sort((left, right) => right.split(".").length - left.split(".").length);
  /* v8 ignore next -- group/profile startup cross-validation proves ownership */
  return groups.length === 0 ? undefined : { exact: field, groups };
};

export const getProvenanceTargets = (field: string, spanKind: string) => {
  if (typeof field !== "string" || typeof spanKind !== "string")
    return undefined;
  const targets = targetsForField(field, spanKind);
  return targets === undefined ? undefined : deepFreeze(targets);
};

export type UnavailableProvenanceClaim = FieldUnavailable[number] & {
  source: FieldProvenance[number]["source"];
};

const unique = (values: readonly string[]) =>
  new Set(values).size === values.length;
const compareFields = (left: { field: string }, right: { field: string }) =>
  left.field < right.field ? -1 : 1;
const provenanceValueKey = (value: FieldProvenance[number]) =>
  JSON.stringify([value.source, value.timingBasis, value.nativeState]);

type LedgerBuilderInput = {
  spanKind: string;
  presentFields: readonly string[];
  provenanceClaims: readonly FieldProvenance[number][];
  unavailableClaims: readonly UnavailableProvenanceClaim[];
};

const isTimingField = (field: string) =>
  field === "span.start_time_unix_nano" || field === "span.end_time_unix_nano";

const validateClaimShape = (claim: FieldProvenance[number]) => {
  const hasTiming =
    claim.timingBasis !== undefined || claim.nativeState !== undefined;
  if (
    (claim.timingBasis === undefined) !== (claim.nativeState === undefined) ||
    (hasTiming && !isTimingField(claim.field))
  )
    throw new ProvenanceLedgerError();
  return claim;
};

const readBuilderInput = (value: unknown): LedgerBuilderInput => {
  const record = readDataRecord(
    value,
    ["spanKind", "presentFields", "provenanceClaims", "unavailableClaims"],
    ["spanKind", "presentFields", "provenanceClaims", "unavailableClaims"],
  );
  if (typeof record.spanKind !== "string") throw new ProvenanceLedgerError();
  const presentFields = readDataArray(record.presentFields, MAXIMUM_CLAIMS).map(
    (field) => {
      if (typeof field !== "string") throw new ProvenanceLedgerError();
      return field;
    },
  );
  const provenanceClaims = readDataArray(
    record.provenanceClaims,
    MAXIMUM_CLAIMS,
  ).map((entry) => validateClaimShape(readProvenanceClaim(entry)));
  const unavailableClaims = readDataArray(
    record.unavailableClaims,
    MAXIMUM_CLAIMS,
  ).map(readUnavailableClaim);
  return {
    spanKind: record.spanKind,
    presentFields,
    provenanceClaims,
    unavailableClaims,
  };
};

const readResolverInput = (value: unknown) => {
  const record = readDataRecord(
    value,
    ["spanKind", "field", "provenance"],
    ["spanKind", "field", "provenance"],
  );
  if (typeof record.spanKind !== "string" || typeof record.field !== "string")
    throw new ProvenanceLedgerError();
  const provenance = readDataArray(record.provenance, MAXIMUM_CLAIMS).map(
    (entry) => validateClaimShape(readProvenanceClaim(entry)),
  );
  return { spanKind: record.spanKind, field: record.field, provenance };
};

const validateBuilderInput = (input: LedgerBuilderInput) => {
  if (
    input.presentFields.length > MAXIMUM_CLAIMS ||
    input.provenanceClaims.length + input.unavailableClaims.length >
      MAXIMUM_CLAIMS ||
    !unique(input.presentFields) ||
    !unique(input.provenanceClaims.map(({ field }) => field)) ||
    !unique(input.unavailableClaims.map(({ field }) => field))
  )
    throw new ProvenanceLedgerError();
  const present = new Set(input.presentFields);
  const unavailable = new Set(
    input.unavailableClaims.map(({ field }) => field),
  );
  if ([...present].some((field) => unavailable.has(field)))
    throw new ProvenanceLedgerError();
  for (const field of [...present, ...unavailable]) {
    if (
      targetsForField(field, input.spanKind) === undefined ||
      matchConcreteGroup(field).length > 0
    )
      throw new ProvenanceLedgerError();
  }
  const claims = new Map(
    input.provenanceClaims.map((claim) => [claim.field, { ...claim }]),
  );
  if (
    input.provenanceClaims.some(({ field }) => !present.has(field)) ||
    [...present].some((field) => !claims.has(field))
  )
    throw new ProvenanceLedgerError();
  for (const claim of input.unavailableClaims) {
    claims.set(claim.field, { field: claim.field, source: claim.source });
  }
  return { claims, present };
};

const selectGroupDefault = (
  members: readonly string[],
  claims: ReadonlyMap<string, FieldProvenance[number]>,
) => {
  const counts = new Map<
    string,
    { count: number; value: FieldProvenance[number] }
  >();
  for (const member of members) {
    const value = claims.get(member)!;
    const key = provenanceValueKey(value);
    const current = counts.get(key);
    counts.set(key, { count: (current?.count ?? 0) + 1, value });
  }
  const ranked = [...counts.values()].sort(
    (left, right) => right.count - left.count,
  );
  return ranked[0]!.count >= 2 && ranked[0]!.count !== ranked[1]?.count
    ? ranked[0]!.value
    : undefined;
};

const compressClaims = (
  spanKind: string,
  present: ReadonlySet<string>,
  claims: ReadonlyMap<string, FieldProvenance[number]>,
) => {
  const output = new Map(claims);
  const concreteGroups = new Map<string, string[]>();
  for (const field of present) {
    for (const group of targetsForField(field, spanKind)!.groups) {
      concreteGroups.set(group, [...(concreteGroups.get(group) ?? []), field]);
    }
  }
  const orderedGroups = [...concreteGroups].sort(
    ([left], [right]) => left.split(".").length - right.split(".").length,
  );
  for (const [group, members] of orderedGroups) {
    const selected = selectGroupDefault(members, claims);
    if (selected === undefined) continue;
    const inherited = getProvenanceTargets(members[0]!, spanKind)!
      .groups.filter(
        (candidate) =>
          candidate !== group &&
          candidate.split(".").length < group.split(".").length,
      )
      .map((candidate) => output.get(candidate))
      .find((candidate) => candidate !== undefined);
    const addsOverride =
      inherited === undefined ||
      provenanceValueKey(inherited) !== provenanceValueKey(selected);
    if (addsOverride) output.set(group, { ...selected, field: group });
    for (const member of members) {
      if (
        provenanceValueKey(claims.get(member)!) === provenanceValueKey(selected)
      )
        output.delete(member);
      else if (addsOverride) output.set(member, claims.get(member)!);
    }
  }
  return [...output.values()].sort(compareFields);
};

const parseBuiltLedger = (
  provenance: FieldProvenance,
  unavailableLedger: FieldUnavailable,
) => {
  const parsedProvenance = FieldProvenanceSchema.safeParse(provenance);
  const parsedUnavailable =
    unavailableLedger.length === 0
      ? { success: true as const, data: [] as FieldUnavailable }
      : FieldUnavailableSchema.safeParse(unavailableLedger);
  if (
    !parsedProvenance.success ||
    !parsedUnavailable.success ||
    provenance.length + unavailableLedger.length > MAXIMUM_CLAIMS ||
    JSON.stringify(provenance).length >
      CONTEXT_PROFILE_IDENTITY.maximumLedgerJsonCodeUnits ||
    JSON.stringify(unavailableLedger).length >
      CONTEXT_PROFILE_IDENTITY.maximumLedgerJsonCodeUnits
  )
    throw new ProvenanceLedgerError();
  return deepFreeze({
    provenance: parsedProvenance.data,
    unavailable: parsedUnavailable.data,
  });
};

export const buildSpanEvidenceLedger = (unsafeInput: LedgerBuilderInput) => {
  try {
    const input = readBuilderInput(unsafeInput);
    const { claims, present } = validateBuilderInput(input);
    const provenance = compressClaims(input.spanKind, present, claims);
    const unavailable = input.unavailableClaims
      .map(({ field, state, reason }) => ({ field, state, reason }))
      .sort(compareFields);
    return parseBuiltLedger(provenance, unavailable);
  } catch {
    throw new ProvenanceLedgerError();
  }
};

export const resolveFieldProvenance = (unsafeInput: {
  spanKind: string;
  field: string;
  provenance: readonly FieldProvenance[number][];
}) => {
  try {
    const input = readResolverInput(unsafeInput);
    const targets = targetsForField(input.field, input.spanKind);
    if (targets === undefined) throw new ProvenanceLedgerError();
    const exact = input.provenance.filter(
      ({ field }) => field === targets.exact,
    );
    if (exact.length > 1) throw new ProvenanceLedgerError();
    if (exact[0] !== undefined)
      return deepFreeze({
        value: exact[0],
        matchedField: exact[0].field,
        match: "exact" as const,
        specificity: exact[0].field.split(".").length,
      });
    const matches = targets.groups.flatMap((group) =>
      input.provenance.filter(({ field }) => field === group),
    );
    if (
      matches.length > 1 &&
      matches[0]!.field.split(".").length ===
        matches[1]!.field.split(".").length
    )
      throw new ProvenanceLedgerError();
    const value = matches[0];
    return value === undefined
      ? undefined
      : deepFreeze({
          value,
          matchedField: value.field,
          match: "group" as const,
          specificity: value.field.split(".").length,
        });
  } catch {
    throw new ProvenanceLedgerError();
  }
};
