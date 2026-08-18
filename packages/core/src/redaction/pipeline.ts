import {
  CANONICAL_COMPOUND_RULES,
  buildSpanEvidenceLedger,
  createSemanticOtlpValue,
  createTimingProvenanceValue,
  getAcceptedSemanticAttributeDescriptor,
  getStructuralSemanticDescriptor,
  standardsManifest,
  type OtlpKeyValue,
  type OtlpSpan,
  type ProvenanceSource,
  type RedactedCanonicalTrace,
  type TimingBasis,
} from "@agentscope/protocol";
import { finalizeRedactedCanonicalTrace } from "@agentscope/protocol/core-finalization";
import { isAbsolute, relative } from "node:path";

import type { CapturedTrace } from "../capture/types.js";
import {
  assignCapturedTraceIdentities,
  readCapturedTraceForCore,
} from "../capture/runtime.js";
import { applyDescriptorRedaction, CoreRedactionError } from "./transforms.js";
import type { ResolvedRedactionPolicy } from "./policy.js";
export { CoreRedactionError } from "./transforms.js";

type EvidenceClaim = {
  field: string;
  source: ProvenanceSource;
  timingBasis?: TimingBasis;
  nativeState?: "observed" | "unavailable";
};
type UnavailableClaim = {
  field: string;
  source: ProvenanceSource;
  state: "unavailable" | "not-applicable" | "observed-empty" | "redacted";
  reason:
    | "not-emitted"
    | "resolution-failed"
    | "unsupported"
    | "not-applicable"
    | "detached-head"
    | "empty-native-value"
    | "policy-redacted";
};

const compareKey = (left: { key: string }, right: { key: string }) =>
  left.key < right.key
    ? -1
    : left.key > right.key
      ? 1
      : /* v8 ignore next -- canonical attributes are unique by key. */ 0;
const stringValue = (key: string, value: string): OtlpKeyValue => ({
  key,
  value: { stringValue: value },
});

const projectRepositoryRelativePaths = <
  T extends Readonly<{
    field: string;
    value: unknown;
    provenance: Readonly<{ field: string; source: ProvenanceSource }>;
  }>,
>(
  fields: readonly T[],
): readonly T[] => {
  const repositoryRoot = fields.find(
    ({ field }) => field === "agentscope.git.repository_root",
  )?.value;
  if (typeof repositoryRoot !== "string" || !isAbsolute(repositoryRoot))
    return fields;
  return fields.map((field) => {
    if (
      ![
        "agentscope.workspace.directory",
        "agentscope.git.worktree",
        "agentscope.git.repository_root",
      ].includes(field.field) ||
      typeof field.value !== "string" ||
      !isAbsolute(field.value)
    )
      return field;
    const projected = relative(repositoryRoot, field.value);
    if (projected.startsWith("..") || isAbsolute(projected)) return field;
    return {
      ...field,
      value: projected === "" ? "." : projected,
      provenance: { field: field.field, source: "derived" as const },
    };
  });
};

const redactField = (
  field: {
    field: string;
    value: unknown;
    provenance: { source: ProvenanceSource };
  },
  policy: ResolvedRedactionPolicy,
  spanKind: ReturnType<
    typeof readCapturedTraceForCore
  >["operations"][number]["kind"],
) => {
  const descriptor = getAcceptedSemanticAttributeDescriptor(field.field);
  /* v8 ignore next -- capture construction already proves descriptor ownership. */
  if (descriptor === undefined) throw new CoreRedactionError();
  const result = applyDescriptorRedaction(
    descriptor,
    field.value,
    policy,
    undefined,
    {
      semanticKey: field.field,
      spanKind,
    },
  );
  if (result.outcome === "omit-redacted") {
    return {
      unavailable: {
        field: field.field,
        source: field.provenance.source,
        state: "redacted" as const,
        reason: "policy-redacted" as const,
      },
    };
  }
  /* v8 ignore next -- closed routes return only the handled outcomes. */
  if (result.outcome !== "retain" || result.value === undefined)
    throw new CoreRedactionError();
  return {
    attribute: {
      key: field.field,
      value: createSemanticOtlpValue(descriptor, result.value),
    },
    claim: {
      field: field.field,
      source: result.transformed
        ? ("derived" as const)
        : field.provenance.source,
    },
  };
};

const buildTiming = (
  operation: ReturnType<typeof readCapturedTraceForCore>["operations"][number],
  hookObservedUnixNano: string,
  rootBounds: { start: string; end: string } | undefined,
  isRoot: boolean,
) => {
  if (isRoot && rootBounds !== undefined) {
    const native = operation.timing;
    if (
      native !== undefined &&
      (BigInt(native.startUnixNano) > BigInt(rootBounds.start) ||
        BigInt(native.endUnixNano) < BigInt(rootBounds.end))
    )
      throw new CoreRedactionError();
    if (native === undefined) {
      const provenance = createTimingProvenanceValue({
        source: "derived",
        timingBasis: "derived-child-envelope",
        location: "root-span",
      });
      return { start: rootBounds.start, end: rootBounds.end, provenance };
    }
  }
  if (operation.timing !== undefined) {
    const provenance = createTimingProvenanceValue({
      source: operation.timing.source,
      timingBasis: operation.timing.basis,
      location: isRoot ? "root-span" : "span",
    });
    return {
      start: operation.timing.startUnixNano,
      end: operation.timing.endUnixNano,
      provenance,
    };
  }
  const provenance = createTimingProvenanceValue({
    source: "process",
    timingBasis: "hook-observed-point",
    location: isRoot ? "root-span" : "span",
  });
  return {
    start: hookObservedUnixNano,
    end: hookObservedUnixNano,
    provenance,
  };
};

// Span construction is one fail-closed transaction over attributes and evidence.
/* eslint-disable max-lines-per-function, complexity */
const createSpan = (
  operation: ReturnType<typeof readCapturedTraceForCore>["operations"][number],
  options: {
    isRoot: boolean;
    standaloneFeedbackRoot: boolean;
    policy: ResolvedRedactionPolicy;
    hookObservedUnixNano: string;
    rootBounds?: { start: string; end: string };
    rootContextFields: readonly Readonly<{
      field: string;
      value: unknown;
      provenance: Readonly<{ field: string; source: ProvenanceSource }>;
    }>[];
    rootContextUnavailable: readonly UnavailableClaim[];
    harness: ReturnType<
      typeof readCapturedTraceForCore
    >["invocation"]["harnessIdentity"];
    policyIdentity: string;
    hasTool: boolean;
    errorActivity: "present" | "redacted" | "empty";
  },
): OtlpSpan & { logicalOperationKey: string } => {
  const attributes: OtlpKeyValue[] = [];
  const present: string[] = [];
  const claims: EvidenceClaim[] = [];
  const unavailable: UnavailableClaim[] = [];
  const addAttribute = (attribute: OtlpKeyValue, claim: EvidenceClaim) => {
    attributes.push(attribute);
    present.push(attribute.key);
    claims.push(claim);
  };
  addAttribute(stringValue("openinference.span.kind", operation.kind), {
    field: "openinference.span.kind",
    source: "derived",
  });
  if (operation.feedbackTransport !== undefined)
    addAttribute(
      stringValue("agentscope.feedback.transport", operation.feedbackTransport),
      { field: "agentscope.feedback.transport", source: "derived" },
    );
  if (options.isRoot && !options.standaloneFeedbackRoot) {
    const harnessName = redactField(
      {
        field: "agentscope.harness.name",
        value: options.harness.name,
        provenance: { source: options.harness.nameSource },
      },
      options.policy,
      operation.kind,
    );
    if (harnessName.attribute !== undefined && harnessName.claim !== undefined)
      addAttribute(harnessName.attribute, harnessName.claim);
    else unavailable.push(harnessName.unavailable);
    const version = options.harness.version;
    if (version.state === "observed") {
      const harnessVersion = redactField(
        {
          field: "agentscope.harness.version",
          value: version.value,
          provenance: { source: version.source },
        },
        options.policy,
        operation.kind,
      );
      if (
        harnessVersion.attribute !== undefined &&
        harnessVersion.claim !== undefined
      )
        addAttribute(harnessVersion.attribute, harnessVersion.claim);
      else unavailable.push(harnessVersion.unavailable);
    } else
      unavailable.push({
        field: "agentscope.harness.version",
        source: version.source,
        state: "unavailable",
        reason: version.reason,
      });
  }
  if (options.isRoot)
    attributes.push(
      stringValue("agentscope.redaction.policy_id", options.policyIdentity),
    );
  const semanticFields = [
    ...operation.fields,
    ...(options.isRoot && !options.standaloneFeedbackRoot
      ? options.rootContextFields.filter(
          ({ field }) =>
            !getAcceptedSemanticAttributeDescriptor(field)?.locations.includes(
              "resource",
            ),
        )
      : []),
  ];
  for (const field of semanticFields) {
    const redacted = redactField(field, options.policy, operation.kind);
    if (redacted.attribute !== undefined && redacted.claim !== undefined)
      addAttribute(redacted.attribute, redacted.claim);
    if (redacted.unavailable !== undefined)
      unavailable.push(redacted.unavailable);
  }
  unavailable.push(
    ...operation.unavailable,
    ...(options.isRoot && !options.standaloneFeedbackRoot
      ? options.rootContextUnavailable
      : []),
  );
  if (options.isRoot) {
    for (const field of options.rootContextFields.filter(({ field }) =>
      getAcceptedSemanticAttributeDescriptor(field)?.locations.includes(
        "resource",
      ),
    )) {
      const redacted = redactField(field, options.policy, operation.kind);
      if (redacted.attribute !== undefined && redacted.claim !== undefined) {
        present.push(field.field);
        claims.push(redacted.claim);
      }
      if (redacted.unavailable !== undefined)
        unavailable.push(redacted.unavailable);
    }
  }

  if (options.isRoot && !options.standaloneFeedbackRoot) {
    if (options.hasTool) {
      claims.push({ field: "family.tool.activity", source: "derived" });
      present.push("family.tool.activity");
    } else
      unavailable.push({
        field: "family.tool.activity",
        source: "derived",
        state: "observed-empty",
        reason: "empty-native-value",
      });
    if (options.errorActivity === "present") {
      claims.push({ field: "family.error.activity", source: "derived" });
      present.push("family.error.activity");
    } else
      unavailable.push({
        field: "family.error.activity",
        source: "derived",
        state:
          options.errorActivity === "redacted" ? "redacted" : "observed-empty",
        reason:
          options.errorActivity === "redacted"
            ? "policy-redacted"
            : "empty-native-value",
      });
  }
  if (operation.kind === "LLM") {
    const accounted = new Set([
      ...present,
      ...unavailable.map(({ field }) => field),
    ]);
    if (
      operation.fields.some(({ field }) => field.startsWith("llm.token_count."))
    ) {
      present.push("family.llm.usage");
      claims.push({ field: "family.llm.usage", source: "derived" });
      accounted.add("family.llm.usage");
    }
    for (const field of [
      "llm.system",
      "llm.model_name",
      "llm.provider",
      "llm.invocation_parameters",
      "family.llm.usage",
    ])
      if (!accounted.has(field))
        unavailable.push({
          field,
          source: "derived",
          state: "unavailable",
          reason: "not-emitted",
        });
  }

  const nameDescriptor = getStructuralSemanticDescriptor("span.name");
  /* v8 ignore next -- startup validates the required structural descriptor. */
  if (nameDescriptor === undefined) throw new CoreRedactionError();
  const nameResult = applyDescriptorRedaction(
    nameDescriptor,
    operation.name,
    options.policy,
    undefined,
    { semanticKey: "span.name", spanKind: operation.kind },
  );
  /* v8 ignore next 6 -- the fingerprinted span-name descriptor permits only string retention or replacement. */
  if (
    (nameResult.outcome !== "retain" &&
      nameResult.outcome !== "replace-non-content") ||
    typeof nameResult.value !== "string"
  )
    throw new CoreRedactionError();
  const timing = buildTiming(
    operation,
    options.hookObservedUnixNano,
    options.rootBounds,
    options.isRoot,
  );
  for (const field of ["span.trace_id", "span.span_id", "span.kind"]) {
    present.push(field);
    claims.push({ field, source: "derived" });
  }
  if (!options.isRoot) {
    present.push("span.parent_span_id");
    claims.push({ field: "span.parent_span_id", source: "derived" });
  }
  present.push(
    "span.name",
    "span.start_time_unix_nano",
    "span.end_time_unix_nano",
  );
  claims.push(
    {
      field: "span.name",
      source: nameResult.transformed
        ? "derived"
        : operation.nameProvenance.source,
    },
    { field: "span.start_time_unix_nano", ...timing.provenance },
    { field: "span.end_time_unix_nano", ...timing.provenance },
  );

  const events = operation.events
    .map((event, eventIndex) => {
      const descriptor = getStructuralSemanticDescriptor("span.event.name");
      /* v8 ignore next -- startup validates the required structural descriptor. */
      if (descriptor === undefined) throw new CoreRedactionError();
      const result = applyDescriptorRedaction(
        descriptor,
        event.name,
        options.policy,
        undefined,
        { semanticKey: "span.event.name", spanKind: operation.kind },
      );
      if (result.outcome === "omit-event") {
        unavailable.push({
          field: `span.events.${eventIndex}.event`,
          source: event.nameProvenance.source,
          state: "redacted",
          reason: "policy-redacted",
        });
        return undefined;
      }
      /* v8 ignore next -- event-name routes return retain or omit-event. */
      if (result.outcome !== "retain" || typeof result.value !== "string")
        throw new CoreRedactionError();
      present.push(
        `span.events.${eventIndex}.event`,
        `span.events.${eventIndex}.name`,
        `span.events.${eventIndex}.time_unix_nano`,
      );
      claims.push(
        { field: `span.events.${eventIndex}.event`, source: "derived" },
        {
          field: `span.events.${eventIndex}.name`,
          source:
            /* v8 ignore next -- transformed event names are omitted atomically. */
            result.transformed ? "derived" : event.nameProvenance.source,
        },
        {
          field: `span.events.${eventIndex}.time_unix_nano`,
          source: event.timeProvenance.source,
        },
      );
      const eventAttributes = event.fields.flatMap((field) => {
        const redacted = redactField(field, options.policy, operation.kind);
        const evidenceField = `span.events.${eventIndex}.attributes.${field.field}`;
        if (redacted.unavailable !== undefined) {
          unavailable.push({ ...redacted.unavailable, field: evidenceField });
          return [];
        }
        /* v8 ignore next -- redactField returns an atomic attribute/claim pair. */
        if (redacted.attribute === undefined || redacted.claim === undefined)
          throw new CoreRedactionError();
        present.push(evidenceField);
        claims.push({ ...redacted.claim, field: evidenceField });
        return [redacted.attribute];
      });
      eventAttributes.sort(compareKey);
      return {
        name: result.value,
        timeUnixNano: event.timeUnixNano,
        attributes: eventAttributes,
      };
    })
    .filter((event): event is NonNullable<typeof event> => event !== undefined);
  if (events.length > 0) {
    present.push("span.events");
    claims.push({ field: "span.events", source: "derived" });
  } else if (operation.events.length > 0)
    unavailable.push({
      field: "span.events",
      source: "derived",
      state: "redacted",
      reason: "policy-redacted",
    });
  const links = operation.links.map((link, linkIndex) => {
    present.push(
      `span.links.${linkIndex}.link`,
      `span.links.${linkIndex}.target_ids`,
      `span.links.${linkIndex}.relationship`,
    );
    claims.push(
      { field: `span.links.${linkIndex}.link`, source: "derived" },
      {
        field: `span.links.${linkIndex}.target_ids`,
        source:
          link.target.kind === "internal"
            ? "derived"
            : link.targetProvenance.source,
      },
      {
        field: `span.links.${linkIndex}.relationship`,
        source: link.targetProvenance.source,
      },
    );
    /* v8 ignore start -- current pinned profile has no link attributes. */
    const linkAttributes = link.fields.flatMap((field) => {
      const redacted = redactField(field, options.policy, operation.kind);
      const evidenceField = `span.links.${linkIndex}.attributes.${field.field}`;
      if (redacted.unavailable !== undefined) {
        unavailable.push({ ...redacted.unavailable, field: evidenceField });
        return [];
      }
      /* v8 ignore next -- redactField returns an atomic attribute/claim pair. */
      if (redacted.attribute === undefined || redacted.claim === undefined)
        throw new CoreRedactionError();
      present.push(evidenceField);
      claims.push({ ...redacted.claim, field: evidenceField });
      return [redacted.attribute];
    });
    /* v8 ignore stop */
    linkAttributes.sort(compareKey);
    return {
      ...(link.target.kind === "internal"
        ? {
            targetLogicalKey: link.target.logicalOperationKey,
            traceId: "1".repeat(32),
            spanId: "1".repeat(16),
          }
        : { traceId: link.target.traceId, spanId: link.target.spanId }),
      attributes: linkAttributes,
    };
  });
  if (links.length > 0) {
    present.push("span.links", "span.links.target_ids");
    claims.push(
      { field: "span.links", source: "derived" },
      { field: "span.links.target_ids", source: "derived" },
    );
  }
  const ledger = buildSpanEvidenceLedger({
    spanKind: operation.kind,
    presentFields: present,
    provenanceClaims: claims,
    unavailableClaims: unavailable,
  });
  attributes.push(
    stringValue(
      "agentscope.mapping.provenance",
      JSON.stringify(ledger.provenance),
    ),
  );
  if (ledger.unavailable.length > 0)
    attributes.push(
      stringValue(
        "agentscope.mapping.unavailable",
        JSON.stringify(ledger.unavailable),
      ),
    );
  attributes.sort(compareKey);
  return {
    logicalOperationKey: operation.logicalKey,
    traceId: "1".repeat(32),
    spanId: "1".repeat(16),
    ...(options.isRoot ? {} : { parentSpanId: "1".repeat(16) }),
    name: nameResult.value,
    kind: CANONICAL_COMPOUND_RULES.constructedSpanKind,
    startTimeUnixNano: timing.start,
    endTimeUnixNano: timing.end,
    attributes,
    ...(events.length === 0 ? {} : { events }),
    ...(links.length === 0 ? {} : { links }),
  };
};
/* eslint-enable max-lines-per-function, complexity */

// Trace construction remains one catch-to-fixed-error transaction.
/* eslint-disable max-lines-per-function */
export const redactCapturedTrace = (
  value: CapturedTrace,
): RedactedCanonicalTrace => {
  try {
    const capture = readCapturedTraceForCore(value);
    const identityBundle = assignCapturedTraceIdentities(value);
    const policy = capture.invocation.snapshot.redactionPolicy;
    const root = capture.operations.find(
      ({ parentLogicalKey }) => parentLogicalKey === undefined,
    )!;
    let rootContextFields = projectRepositoryRelativePaths([
      ...capture.invocation.context.fields,
      ...capture.rootContext.fields,
    ]);
    const rootContextUnavailable: UnavailableClaim[] = [
      ...capture.invocation.context.unavailable,
      ...capture.rootContext.unavailable,
    ];
    for (const [identity, dependents] of [
      ["vcs.ref.head.revision", ["vcs.ref.head.name", "vcs.ref.type"]],
      ["vcs.repository.url.full", ["vcs.repository.name"]],
    ] as const) {
      const identityField = rootContextFields.find(
        ({ field }) => field === identity,
      );
      const identityRetained =
        identityField !== undefined &&
        redactField(identityField, policy, root.kind).attribute !== undefined;
      if (!identityRetained) {
        const removed = rootContextFields.filter(({ field }) =>
          dependents.includes(field as never),
        );
        rootContextFields = rootContextFields.filter(
          ({ field }) => !dependents.includes(field as never),
        );
        for (const dependent of removed)
          rootContextUnavailable.push({
            field: dependent.field,
            source: dependent.provenance.source,
            state: identityField === undefined ? "unavailable" : "redacted",
            reason:
              identityField === undefined
                ? "resolution-failed"
                : "policy-redacted",
          });
      }
    }
    const nonRootTimes = capture.operations
      .filter(({ logicalKey }) => logicalKey !== root.logicalKey)
      .map((operation) =>
        operation.timing === undefined
          ? {
              start: capture.invocation.hookObservedUnixNano,
              end: capture.invocation.hookObservedUnixNano,
            }
          : {
              start: operation.timing.startUnixNano,
              end: operation.timing.endUnixNano,
            },
      );
    const rootBounds =
      nonRootTimes.length === 0
        ? undefined
        : {
            start: nonRootTimes.reduce(
              (minimum, item) =>
                BigInt(item.start) < BigInt(minimum) ? item.start : minimum,
              nonRootTimes[0]!.start,
            ),
            end: nonRootTimes.reduce(
              (maximum, item) =>
                BigInt(item.end) > BigInt(maximum) ? item.end : maximum,
              nonRootTimes[0]!.end,
            ),
          };
    const hasTool = capture.operations.some(({ kind }) => kind === "TOOL");
    const hasRetainedException = capture.operations.some(({ events }) =>
      events.some(({ name }) => name === "exception"),
    );
    const capturedErrorTypes = capture.operations.flatMap((operation) =>
      operation.fields
        .filter(({ field }) => field === "error.type")
        .map((field) => ({ field, kind: operation.kind })),
    );
    const hasRetainedErrorType = capturedErrorTypes.some(
      ({ field, kind }) =>
        redactField(field, policy, kind).attribute !== undefined,
    );
    const errorActivity =
      hasRetainedException || hasRetainedErrorType
        ? ("present" as const)
        : capturedErrorTypes.length > 0
          ? ("redacted" as const)
          : ("empty" as const);
    const spans = capture.operations.map((operation) =>
      createSpan(operation, {
        isRoot: operation.logicalKey === root.logicalKey,
        standaloneFeedbackRoot:
          capture.operations.length === 1 &&
          operation.feedbackTransport === "post-hoc",
        policy,
        hookObservedUnixNano: capture.invocation.hookObservedUnixNano,
        ...(operation.logicalKey === root.logicalKey && rootBounds !== undefined
          ? { rootBounds }
          : {}),
        rootContextFields,
        rootContextUnavailable,
        harness: capture.invocation.harnessIdentity,
        policyIdentity: capture.invocation.snapshot.policyIdentity,
        hasTool,
        errorActivity,
      }),
    );
    const rootSpan = spans.find(
      ({ logicalOperationKey }) => logicalOperationKey === root.logicalKey,
    )!;
    const orderedChildren = spans
      .filter(
        ({ logicalOperationKey }) => logicalOperationKey !== root.logicalKey,
      )
      .sort((left, right) => {
        const leftStart = BigInt(left.startTimeUnixNano);
        const rightStart = BigInt(right.startTimeUnixNano);
        if (leftStart < rightStart) return -1;
        if (leftStart > rightStart) return 1;
        return identityBundle.spans[left.logicalOperationKey]! <
          identityBundle.spans[right.logicalOperationKey]!
          ? -1
          : 1;
      });
    spans.splice(0, spans.length, rootSpan, ...orderedChildren);
    const resourceFields = rootContextFields.filter((field) =>
      getAcceptedSemanticAttributeDescriptor(field.field)?.locations.includes(
        "resource",
      ),
    );
    const resourceAttributes: OtlpKeyValue[] = [
      stringValue(
        "agentscope.protocol.manifest_id",
        standardsManifest.manifestId,
      ),
      stringValue("service.name", CANONICAL_COMPOUND_RULES.serviceName),
    ];
    for (const field of resourceFields) {
      const redacted = redactField(field, policy, root.kind);
      if (redacted.attribute !== undefined)
        resourceAttributes.push(redacted.attribute);
    }
    resourceAttributes.sort(compareKey);
    return finalizeRedactedCanonicalTrace({
      identityBundle,
      graph: {
        resourceSpans: [
          {
            resource: { attributes: resourceAttributes },
            scopeSpans: [{ scope: CANONICAL_COMPOUND_RULES.scope, spans }],
          },
        ],
      },
    });
  } catch {
    throw new CoreRedactionError();
  }
};
/* eslint-enable max-lines-per-function */
