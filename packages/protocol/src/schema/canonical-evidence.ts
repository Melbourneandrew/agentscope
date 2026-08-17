import {
  OpenInferenceSpanKind,
  SemanticConventions,
} from "@arizeai/openinference-semantic-conventions";
import type { z } from "zod";

import {
  parseFieldProvenance,
  parseFieldUnavailable,
  type FieldProvenance,
  type FieldUnavailable,
} from "./context.js";
import { getAgentscopeExtension } from "./extensions.js";
import { deepFreeze } from "./immutable.js";
import { getOpenInferenceAttributeProfile } from "./openinference.js";
import {
  getProvenanceTargets,
  isProvenanceGroupField,
  PROVENANCE_GROUP_PROFILE_IDENTITY,
  PROVENANCE_STRUCTURAL_FIELDS,
  resolveFieldProvenance,
} from "./provenance-groups.js";
import {
  getTimingCompatibilityRule,
  isTimingProvenanceCompatible,
} from "./timing-profile.js";
import {
  OTLP_GRAPH_LIMITS,
  type OtlpAnyValue,
  type OtlpKeyValue,
  type OtlpResourceSpans,
  type OtlpSpan,
} from "./otlp.js";

type Issue = (context: z.RefinementCtx, code: string) => void;

const findAttribute = (
  attributes: readonly OtlpKeyValue[] | undefined,
  key: string,
) => attributes?.find((attribute) => attribute.key === key);

const isStringValue = (
  value: OtlpAnyValue | undefined,
): value is { stringValue: string } =>
  value !== undefined && "stringValue" in value;

const getOpenInferenceKind = (span: OtlpSpan) => {
  const value = findAttribute(
    span.attributes,
    SemanticConventions.OPENINFERENCE_SPAN_KIND,
  )?.value;
  return isStringValue(value) ? value.stringValue : undefined;
};

const parseSpanLedger = (
  span: OtlpSpan,
): { provenance?: FieldProvenance; unavailable: FieldUnavailable } => {
  const provenanceValue = findAttribute(
    span.attributes,
    "agentscope.mapping.provenance",
  )?.value;
  const unavailableValue = findAttribute(
    span.attributes,
    "agentscope.mapping.unavailable",
  )?.value;
  const provenance = isStringValue(provenanceValue)
    ? parseFieldProvenance(provenanceValue.stringValue)
    : undefined;
  const unavailable = isStringValue(unavailableValue)
    ? parseFieldUnavailable(unavailableValue.stringValue)
    : undefined;
  return {
    ...(provenance?.success === true ? { provenance: provenance.data } : {}),
    unavailable: unavailable?.success === true ? unavailable.data : [],
  };
};

export const EVIDENCE_PROFILE_IDENTITY = deepFreeze({
  provenanceGroups: PROVENANCE_GROUP_PROFILE_IDENTITY,
  structuralFields: PROVENANCE_STRUCTURAL_FIELDS,
});

const requiredSpanFields = (
  span: OtlpSpan,
  additionalFields: ReadonlySet<string>,
) => {
  const fields = new Set([
    "span.trace_id",
    "span.span_id",
    "span.kind",
    "span.name",
    "span.start_time_unix_nano",
    "span.end_time_unix_nano",
    ...additionalFields,
  ]);
  if (span.parentSpanId !== undefined) fields.add("span.parent_span_id");
  if (span.flags !== undefined) fields.add("span.flags");
  // A successful provenance-ledger parse proves attributes are present.
  for (const { key } of span.attributes!) {
    if (
      key !== "agentscope.mapping.provenance" &&
      key !== "agentscope.mapping.unavailable" &&
      key !== "agentscope.redaction.policy_id"
    ) {
      fields.add(key);
    }
  }
  if (span.status !== undefined) {
    fields.add("span.status.code");
    if (span.status.message !== undefined) fields.add("span.status.message");
  }
  if ((span.events?.length ?? 0) > 0) fields.add("span.events");
  if ((span.links?.length ?? 0) > 0) {
    fields.add("span.links");
    fields.add("span.links.target_ids");
  }
  return fields;
};

const EXACT_GOVERNED_FIELDS = new Set([
  "span.name",
  "span.trace_id",
  "span.span_id",
  "span.parent_span_id",
  "span.kind",
  "span.flags",
  "span.start_time_unix_nano",
  "span.end_time_unix_nano",
  "span.status.code",
  "span.status.message",
  "span.events",
  "span.links",
  "span.links.target_ids",
  "family.tool.activity",
  "family.error.activity",
  "family.llm.usage",
  "error.type",
]);

const isGovernedField = (
  field: string,
  spanKind: string | undefined,
  isRoot: boolean,
  resourceFields: ReadonlySet<string>,
) => {
  if (
    spanKind !== undefined &&
    getProvenanceTargets(field, spanKind) !== undefined
  )
    return true;
  if (EXACT_GOVERNED_FIELDS.has(field)) return true;
  if (spanKind !== undefined && isProvenanceGroupField(field, spanKind))
    return true;
  if (field.startsWith("vcs.")) return isRoot && resourceFields.has(field);
  const openInference = getOpenInferenceAttributeProfile(field);
  if (openInference !== undefined) {
    return (
      openInference.openInferenceKinds === undefined ||
      openInference.openInferenceKinds.includes(spanKind ?? "")
    );
  }
  const extension = getAgentscopeExtension(field);
  if (
    extension === undefined ||
    field === "agentscope.mapping.provenance" ||
    field === "agentscope.mapping.unavailable" ||
    extension.applicability === "resource"
  )
    return false;
  return extension.applicability === "span" || isRoot;
};

// The schema boundary keeps its issue sink explicit.
/* eslint-disable max-params */
const addIndexedMemberEvidence = (
  span: OtlpSpan,
  spanKind: string,
  provenanceFields: ReadonlySet<string>,
  required: Set<string>,
  context: z.RefinementCtx,
  issue: Issue,
) => {
  const validateCollection = (
    collection: "events" | "links",
    values: readonly {
      attributes?: readonly OtlpKeyValue[] | undefined;
    }[],
    existence: "event" | "link",
  ) => {
    const expression = new RegExp(
      `^span\\.${collection}\\.(0|[1-9]\\d{0,3})\\.${existence}$`,
      "u",
    );
    const indices = [...provenanceFields]
      .flatMap((field) => {
        const match = expression.exec(field);
        return match === null ? [] : [Number(match[1])];
      })
      .sort((left, right) => left - right);
    if (
      indices.length !== values.length ||
      new Set(indices).size !== indices.length
    ) {
      issue(context, "canonical.provenance.member-order");
      return;
    }
    for (let position = 0; position < values.length; position += 1) {
      const index = indices[position]!;
      const prefix = `span.${collection}.${index}`;
      required.add(`${prefix}.${existence}`);
      if (collection === "events") {
        required.add(`${prefix}.name`);
        required.add(`${prefix}.time_unix_nano`);
      } else {
        required.add(`${prefix}.relationship`);
        required.add(`${prefix}.target_ids`);
      }
      for (const attribute of values[position]!.attributes ?? [])
        required.add(`${prefix}.attributes.${attribute.key}`);
    }
  };
  validateCollection("events", span.events ?? [], "event");
  validateCollection("links", span.links ?? [], "link");
  for (const field of required)
    if (field.startsWith("span.events.") || field.startsWith("span.links."))
      if (getProvenanceTargets(field, spanKind) === undefined)
        issue(context, "canonical.provenance.member-field");
};
/* eslint-enable max-params */

const entriesAreOrdered = (entries: readonly { field: string }[]) =>
  entries.every(
    ({ field }, index) => index === 0 || entries[index - 1]!.field < field,
  );

const validateTiming = (
  span: OtlpSpan,
  provenanceByField: ReadonlyMap<string, FieldProvenance[number]>,
  timingContext: {
    descendantBounds?: { start: string; end: string };
    isRoot: boolean;
  },
  context: z.RefinementCtx,
  issue: Issue,
) => {
  const start = provenanceByField.get("span.start_time_unix_nano");
  const end = provenanceByField.get("span.end_time_unix_nano");
  if (
    start?.timingBasis === undefined ||
    start.nativeState === undefined ||
    start.timingBasis !== end?.timingBasis ||
    start.nativeState !== end.nativeState ||
    start.source !== end.source
  ) {
    issue(context, "canonical.provenance.timing");
    return;
  }
  if (
    !isTimingProvenanceCompatible({
      source: start.source,
      timingBasis: start.timingBasis,
      nativeState: start.nativeState,
      location: timingContext.isRoot ? "root-span" : "span",
    })
  )
    issue(context, "canonical.provenance.timing-source");
  const rule = getTimingCompatibilityRule(start.timingBasis);
  if (rule.shape === "point" && span.startTimeUnixNano !== span.endTimeUnixNano)
    issue(context, "canonical.provenance.point-time");
  if (
    rule.construction === "descendant-min-max" &&
    (timingContext.descendantBounds === undefined ||
      span.startTimeUnixNano !== timingContext.descendantBounds.start ||
      span.endTimeUnixNano !== timingContext.descendantBounds.end)
  )
    issue(context, "canonical.provenance.timing-envelope");
};

const validatePresentAndUnavailableEvidence = (
  options: {
    required: ReadonlySet<string>;
    spanKind: string;
    provenanceByField: ReadonlyMap<string, FieldProvenance[number]>;
    unavailableFields: ReadonlySet<string>;
  },
  context: z.RefinementCtx,
  issue: Issue,
) => {
  const { spanKind, provenanceByField, required, unavailableFields } = options;
  for (const field of required) {
    let resolved: ReturnType<typeof resolveFieldProvenance>;
    try {
      resolved = resolveFieldProvenance({
        spanKind,
        field,
        provenance: [...provenanceByField.values()],
      });
    } catch {
      resolved = undefined;
    }
    if (resolved === undefined || unavailableFields.has(field)) {
      issue(context, "canonical.provenance.present-field");
    }
  }
  for (const field of unavailableFields) {
    if (
      !provenanceByField.has(field) ||
      required.has(field) ||
      isProvenanceGroupField(field)
    ) {
      issue(context, "canonical.provenance.unavailable-field");
    }
  }
};

// Evidence closure is intentionally one ordered validation transaction.
/* eslint-disable max-lines-per-function */
export const validateSpanEvidence = (
  span: OtlpSpan,
  options: {
    additionalFields: ReadonlySet<string>;
    accountingFields: ReadonlyMap<string, boolean>;
    descendantBounds?: { start: string; end: string };
    isRoot: boolean;
    resourceFields: ReadonlySet<string>;
    llmKind: string;
    llmRequiredOrUnavailable: readonly string[];
    llmAbsentEvidenceStates: readonly string[];
  },
  context: z.RefinementCtx,
  issue: Issue,
) => {
  const { accountingFields, additionalFields, isRoot, resourceFields } =
    options;
  const ledger = parseSpanLedger(span);
  if (ledger.provenance === undefined) {
    issue(context, "canonical.provenance.required");
    return;
  }
  const provenanceLedger = ledger.provenance;
  if (
    !entriesAreOrdered(ledger.provenance) ||
    !entriesAreOrdered(ledger.unavailable)
  ) {
    issue(context, "canonical.provenance.order");
  }
  const provenanceByField = new Map(
    ledger.provenance.map((entry) => [entry.field, entry]),
  );
  const unavailableByField = new Map(
    ledger.unavailable.map((entry) => [entry.field, entry]),
  );
  const unavailableFields = new Set(unavailableByField.keys());
  const required = requiredSpanFields(span, additionalFields);
  const spanKind = getOpenInferenceKind(span);
  if (spanKind !== undefined)
    addIndexedMemberEvidence(
      span,
      spanKind,
      new Set(
        [...provenanceByField.keys()].filter(
          (field) => !unavailableFields.has(field),
        ),
      ),
      required,
      context,
      issue,
    );
  for (const [field, present] of accountingFields) {
    if (present) required.add(field);
    else if (!unavailableFields.has(field))
      issue(context, "canonical.provenance.unaccounted-field");
  }
  if (
    required.size > OTLP_GRAPH_LIMITS.governedFieldsPerSpan ||
    provenanceByField.size + unavailableByField.size >
      OTLP_GRAPH_LIMITS.governedFieldsPerSpan
  ) {
    issue(context, "canonical.provenance.field-budget");
  }
  if (spanKind === options.llmKind) {
    for (const field of options.llmRequiredOrUnavailable) {
      if (
        findAttribute(span.attributes, field) === undefined &&
        !options.llmAbsentEvidenceStates.includes(
          unavailableByField.get(field)?.state ?? "",
        )
      ) {
        issue(context, "canonical.openinference.llm-system-accounting");
      }
    }
  }
  validatePresentAndUnavailableEvidence(
    {
      spanKind: spanKind ?? "",
      provenanceByField,
      required,
      unavailableFields,
    },
    context,
    issue,
  );
  for (const { field, timingBasis, nativeState } of ledger.provenance) {
    const isTime =
      field === "span.start_time_unix_nano" ||
      field === "span.end_time_unix_nano";
    if (!isTime && (timingBasis !== undefined || nativeState !== undefined)) {
      issue(context, "canonical.provenance.non-time-basis");
    }
    const isGroup =
      spanKind !== undefined && isProvenanceGroupField(field, spanKind);
    const groupHasPresentMember =
      isGroup &&
      [...required].some((requiredField) => {
        try {
          return (
            resolveFieldProvenance({
              spanKind,
              field: requiredField,
              provenance: provenanceLedger,
            })?.matchedField === field
          );
        } catch {
          return false;
        }
      });
    if (
      !required.has(field) &&
      !unavailableFields.has(field) &&
      !groupHasPresentMember
    ) {
      issue(context, "canonical.provenance.unknown-field");
    }
    if (!isGovernedField(field, spanKind, isRoot, resourceFields)) {
      issue(context, "canonical.provenance.ungoverned-field");
    }
  }
  validateTiming(
    span,
    provenanceByField,
    {
      isRoot,
      ...(options.descendantBounds === undefined
        ? {}
        : { descendantBounds: options.descendantBounds }),
    },
    context,
    issue,
  );
};
/* eslint-enable max-lines-per-function */

export const rootEvidenceAccounting = (
  resource: OtlpResourceSpans,
  root: OtlpSpan,
  spans: readonly OtlpSpan[],
  profile: {
    rootExtensions: readonly string[];
    rootVcs: readonly string[];
    rootFamilies: {
      toolActivity: string;
      errorActivity: string;
    };
  },
) => {
  const fields = new Map<string, boolean>();
  for (const field of profile.rootExtensions)
    fields.set(field, findAttribute(root.attributes, field) !== undefined);
  for (const field of profile.rootVcs) {
    fields.set(
      field,
      findAttribute(resource.resource?.attributes, field) !== undefined,
    );
  }
  fields.set(
    profile.rootFamilies.toolActivity,
    spans.some(
      (span) => getOpenInferenceKind(span) === OpenInferenceSpanKind.TOOL,
    ),
  );
  fields.set(
    profile.rootFamilies.errorActivity,
    spans.some(
      (span) =>
        span.status?.code === 2 ||
        findAttribute(span.attributes, "error.type") !== undefined ||
        span.events?.some((event) => event.name === "exception") === true,
    ),
  );
  return fields;
};

export const spanEvidenceAccounting = (
  span: OtlpSpan,
  profile: {
    llmFields: readonly string[];
    llmFamilies: { usage: string };
  },
  llmKind: string,
) => {
  const fields = new Map<string, boolean>();
  if (getOpenInferenceKind(span) === llmKind) {
    for (const field of profile.llmFields) {
      fields.set(field, findAttribute(span.attributes, field) !== undefined);
    }
    fields.set(
      profile.llmFamilies.usage,
      span.attributes?.some(({ key }) => key.startsWith("llm.token_count.")) ===
        true,
    );
  }
  return fields;
};
