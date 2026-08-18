import { randomBytes } from "node:crypto";
import { inspect } from "node:util";

import {
  buildSpanEvidenceLedger,
  deriveIdentityBundle,
  NATIVE_IDENTITY_KINDS,
  getAcceptedSemanticAttributeDescriptor,
  getProvenanceTargets,
  getTimingCompatibilityRule,
  feedbackAttributesAreValid,
  isFeedbackAttributeKey,
  createSemanticOtlpValue,
  isSemanticCandidateUpstreamConstraintValid,
  isSemanticCandidateValueValid,
  isProvenanceGroupField,
  isTimingProvenanceCompatible,
  OPENINFERENCE_SPAN_KINDS,
  type IdentityBundle,
  type SemanticAttributeDescriptor,
} from "@agentscope/protocol";

import type {
  CapturedTrace,
  CapturedTraceCandidate,
  CapturedTraceSummary,
  CapturedValueCandidate,
  CaptureSnapshotIdentity,
  FieldProvenanceCandidate,
  FieldUnavailableCandidate,
  CaptureInvocationContext,
  HarnessCaptureFactory,
  OpenInferenceOperationKind,
  SemanticFieldCandidate,
  SemanticValueCandidate,
  TimingCandidate,
} from "./types.js";
import { FIRST_PARTY_HARNESS_IDS } from "./types.js";
import {
  CAPTURE_LIMITS as LIMITS,
  CapturedTraceError,
  clonePlainData,
  deepFreezePrivate,
} from "./plain-data.js";
import { validateResolvedRedactionPolicy } from "../redaction/policy.js";
const uint64 = /^(?:0|[1-9]\d{0,19})$/u;
const identifier = /^[a-z][a-z\d]*(?:[._:/-][a-z\d]+)*$/u;
const firstPartyHarnesses: ReadonlySet<string> = new Set(
  FIRST_PARTY_HARNESS_IDS,
);
const nativeIdentityKinds: ReadonlySet<string> = new Set(NATIVE_IDENTITY_KINDS);
const boundaryKinds = new Set([
  "hook-invocation",
  "session",
  "transcript-range",
  "turn",
]);
const positionKinds = new Set([
  "byte-offset",
  "event-index",
  "line",
  "sequence",
]);
const operationScopes = new Set(["parent-scoped", "session-global"]);
const harnessProvenanceSources = new Set(["hook-payload", "native-artifact"]);
const coreHarnessIdentitySources = new Set(["harness-config", "process"]);
const unavailableStates = new Set([
  "not-applicable",
  "observed-empty",
  "unavailable",
]);
const harnessUnavailableFamilies = new Set([
  "family.error.activity",
  "family.llm.usage",
  "family.tool.activity",
]);
const forbiddenCanonicalFields = new Set([
  "agentscope.mapping.provenance",
  "agentscope.mapping.unavailable",
  "agentscope.harness.name",
  "agentscope.harness.version",
  "agentscope.protocol.manifest_id",
  "agentscope.redaction.policy_id",
  "agentscope.feedback.transport",
  "openinference.span.kind",
  "service.name",
  "service.version",
  "agentscope.workspace.directory",
  "agentscope.git.worktree",
  "agentscope.git.repository_root",
  "vcs.ref.head.name",
  "vcs.ref.head.revision",
  "vcs.ref.type",
]);
const coreContextFields = new Set([
  "agentscope.workspace.directory",
  "agentscope.git.worktree",
  "agentscope.git.repository_root",
  "vcs.ref.head.name",
  "vcs.ref.head.revision",
  "vcs.ref.type",
]);
const openInferenceKinds: ReadonlySet<string> = new Set(
  OPENINFERENCE_SPAN_KINDS,
);

export { CapturedTraceError } from "./plain-data.js";

const isRecord = (
  value: CapturedValueCandidate,
): value is {
  readonly [key: string]: CapturedValueCandidate;
} => typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = <Required extends string, Optional extends string = never>(
  value: CapturedValueCandidate,
  required: readonly Required[],
  optional: readonly Optional[] = [],
) => {
  if (!isRecord(value)) throw new CapturedTraceError();
  const keys = Object.keys(value);
  if (
    required.some((key) => !(key in value)) ||
    keys.some(
      (key) =>
        !(required as readonly string[]).includes(key) &&
        !(optional as readonly string[]).includes(key),
    )
  )
    throw new CapturedTraceError();
  return value as Record<Required, CapturedValueCandidate> &
    Partial<Record<Optional, CapturedValueCandidate>>;
};

const boundedString = (value: CapturedValueCandidate, maximum = 1_024) => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new CapturedTraceError();
  return value;
};

const safeInteger = (value: CapturedValueCandidate) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new CapturedTraceError();
  return value as number;
};

const dataArray = (
  value: CapturedValueCandidate,
  maximum: number,
): readonly CapturedValueCandidate[] => {
  if (!Array.isArray(value) || value.length > maximum)
    throw new CapturedTraceError();
  return Array.from(value as unknown as readonly CapturedValueCandidate[]);
};

const validateProvenance = (
  value: CapturedValueCandidate,
  expectedField: string,
): FieldProvenanceCandidate => {
  const record = exactKeys(value, ["field", "source"]);
  const field = boundedString(record.field);
  const source = boundedString(record.source);
  if (field !== expectedField || !harnessProvenanceSources.has(source))
    throw new CapturedTraceError();
  return { field, source: source as FieldProvenanceCandidate["source"] };
};

const validateSemanticValue = (
  value: CapturedValueCandidate,
  descriptor: SemanticAttributeDescriptor,
) => {
  if (!isSemanticCandidateValueValid(descriptor, value))
    throw new CapturedTraceError();
};

const validateField = (
  value: CapturedValueCandidate,
  kind: string,
  allowedLocations: ReadonlySet<string>,
  eventName?: string,
): SemanticFieldCandidate => {
  const record = exactKeys(value, ["field", "value", "provenance"]);
  const field = boundedString(record.field);
  const descriptor = getAcceptedSemanticAttributeDescriptor(field);
  if (
    descriptor === undefined ||
    forbiddenCanonicalFields.has(field) ||
    !descriptor.locations.some((location) => allowedLocations.has(location)) ||
    (descriptor.eventName !== undefined &&
      descriptor.eventName !== eventName) ||
    (descriptor.openInferenceKinds !== undefined &&
      !descriptor.openInferenceKinds.includes(kind))
  )
    throw new CapturedTraceError();
  validateSemanticValue(record.value, descriptor);
  return {
    field,
    value: record.value as SemanticValueCandidate,
    provenance: validateProvenance(record.provenance, field),
  };
};

const validateFields = (
  value: CapturedValueCandidate,
  kind: string,
  locations: ReadonlySet<string>,
) => {
  const fields = dataArray(value, LIMITS.maximumFieldsPerContainer).map(
    (entry) => validateField(entry, kind, locations),
  );
  if (new Set(fields.map(({ field }) => field)).size !== fields.length)
    throw new CapturedTraceError();
  return fields;
};

const validateUnavailable = (
  value: CapturedValueCandidate,
  kind: string,
  presentFields: ReadonlySet<string>,
  allowedLocations: ReadonlySet<string>,
): FieldUnavailableCandidate[] => {
  const unavailable = dataArray(value, LIMITS.maximumFieldsPerContainer).map(
    (entry) => {
      const record = exactKeys(entry, ["field", "source", "state", "reason"]);
      const field = boundedString(record.field);
      const source = boundedString(record.source);
      const state = boundedString(record.state);
      const reason = boundedString(record.reason);
      const descriptor = getAcceptedSemanticAttributeDescriptor(field);
      if (
        getProvenanceTargets(field, kind) === undefined ||
        isProvenanceGroupField(field, kind) ||
        forbiddenCanonicalFields.has(field) ||
        (descriptor === undefined && !harnessUnavailableFamilies.has(field)) ||
        (descriptor !== undefined &&
          !descriptor.locations.some((location) =>
            allowedLocations.has(location),
          )) ||
        !harnessProvenanceSources.has(source) ||
        !unavailableStates.has(state) ||
        presentFields.has(field)
      )
        throw new CapturedTraceError();
      return { field, source, state, reason } as FieldUnavailableCandidate;
    },
  );
  if (
    new Set(unavailable.map(({ field }) => field)).size !== unavailable.length
  )
    throw new CapturedTraceError();
  return unavailable;
};

const validateTimestamp = (value: CapturedValueCandidate) => {
  const timestamp = boundedString(value, 20);
  if (
    !uint64.test(timestamp) ||
    BigInt(timestamp) > 18_446_744_073_709_551_615n
  )
    throw new CapturedTraceError();
  return timestamp;
};

const validateTiming = (
  value: CapturedValueCandidate,
  isRoot: boolean,
): TimingCandidate => {
  const record = exactKeys(value, [
    "basis",
    "nativeState",
    "source",
    "startUnixNano",
    "endUnixNano",
  ]);
  const basis = boundedString(record.basis);
  const nativeState = boundedString(record.nativeState);
  const source = boundedString(record.source);
  const startUnixNano = validateTimestamp(record.startUnixNano);
  const endUnixNano = validateTimestamp(record.endUnixNano);
  if (
    (basis !== "native-interval" && basis !== "native-point") ||
    nativeState !== "observed" ||
    !harnessProvenanceSources.has(source) ||
    BigInt(startUnixNano) > BigInt(endUnixNano) ||
    !isTimingProvenanceCompatible({
      source: source as never,
      timingBasis: basis,
      nativeState,
      location: isRoot ? "root-span" : "span",
    }) ||
    (getTimingCompatibilityRule(basis).shape === "point" &&
      startUnixNano !== endUnixNano)
  )
    throw new CapturedTraceError();
  return {
    basis,
    nativeState,
    source: source as "hook-payload" | "native-artifact",
    startUnixNano,
    endUnixNano,
  };
};

const validateEvent = (value: CapturedValueCandidate, kind: string) => {
  const record = exactKeys(value, [
    "name",
    "nameProvenance",
    "timeUnixNano",
    "timeProvenance",
    "fields",
  ]);
  const name = boundedString(record.name);
  const fields = dataArray(record.fields, LIMITS.maximumFieldsPerContainer).map(
    (entry) => validateField(entry, kind, new Set(["event"]), name),
  );
  if (new Set(fields.map(({ field }) => field)).size !== fields.length)
    throw new CapturedTraceError();
  return {
    name,
    nameProvenance: validateProvenance(
      record.nameProvenance,
      "span.event.name",
    ),
    timeUnixNano: validateTimestamp(record.timeUnixNano),
    timeProvenance: validateProvenance(
      record.timeProvenance,
      "span.event.time_unix_nano",
    ),
    fields,
  };
};

const validateLink = (value: CapturedValueCandidate, kind: string) => {
  const record = exactKeys(value, ["target", "targetProvenance", "fields"]);
  const targetRecord = exactKeys(
    record.target,
    ["kind"],
    ["logicalOperationKey", "traceId", "spanId"],
  );
  const target = (() => {
    if (targetRecord.kind === "internal") {
      const internal = exactKeys(record.target, [
        "kind",
        "logicalOperationKey",
      ]);
      return {
        kind: "internal" as const,
        logicalOperationKey: boundedString(internal.logicalOperationKey),
      };
    }
    if (targetRecord.kind === "external") {
      const external = exactKeys(record.target, ["kind", "traceId", "spanId"]);
      const traceId = boundedString(external.traceId, 32);
      const spanId = boundedString(external.spanId, 16);
      if (
        !/^(?!0{32}$)[\da-f]{32}$/u.test(traceId) ||
        !/^(?!0{16}$)[\da-f]{16}$/u.test(spanId)
      )
        throw new CapturedTraceError();
      return { kind: "external" as const, traceId, spanId };
    }
    throw new CapturedTraceError();
  })();
  return {
    target,
    targetProvenance: validateProvenance(
      record.targetProvenance,
      "span.link.target",
    ),
    fields: validateFields(record.fields, kind, new Set(["link"])),
  };
};

const validateLocator = (value: CapturedValueCandidate) => {
  const record = exactKeys(value, ["kind"], ["nativeId", "ordinal"]);
  if (record.kind === "native-operation") {
    const native = exactKeys(value, ["kind", "nativeId"]);
    return {
      kind: "native-operation" as const,
      nativeId: boundedString(native.nativeId),
    };
  }
  if (record.kind === "source-ordinal") {
    const ordinal = exactKeys(value, ["kind", "ordinal"]);
    return {
      kind: "source-ordinal" as const,
      ordinal: safeInteger(ordinal.ordinal),
    };
  }
  throw new CapturedTraceError();
};

const validateOperation = (value: CapturedValueCandidate) => {
  const record = exactKeys(
    value,
    [
      "logicalKey",
      "locator",
      "kind",
      "name",
      "nameProvenance",
      "fields",
      "unavailable",
      "events",
      "links",
    ],
    ["parentLogicalKey", "timing", "feedbackTransport"],
  );
  const logicalKey = boundedString(record.logicalKey);
  const kind = boundedString(record.kind) as OpenInferenceOperationKind;
  const name = boundedString(record.name);
  if (!openInferenceKinds.has(kind)) throw new CapturedTraceError();
  const fields = validateFields(record.fields, kind, new Set(["span"]));
  const feedbackTransport =
    record.feedbackTransport === undefined
      ? undefined
      : boundedString(record.feedbackTransport);
  if (
    (feedbackTransport !== undefined &&
      feedbackTransport !== "inline" &&
      feedbackTransport !== "post-hoc") ||
    fields.some(({ field }) => isFeedbackAttributeKey(field)) !==
      (feedbackTransport !== undefined)
  )
    throw new CapturedTraceError();
  const presentFields = new Set(fields.map(({ field }) => field));
  presentFields.add("span.name");
  const unavailable = validateUnavailable(
    record.unavailable,
    kind,
    presentFields,
    new Set(["span"]),
  );
  if (
    !isSemanticCandidateUpstreamConstraintValid({
      kind,
      spanName: name,
      presentFields: fields.map(({ field }) => field),
      unavailable,
    })
  )
    throw new CapturedTraceError();
  const operation = {
    logicalKey,
    locator: validateLocator(record.locator),
    ...(record.parentLogicalKey === undefined
      ? {}
      : { parentLogicalKey: boundedString(record.parentLogicalKey) }),
    kind,
    ...(feedbackTransport === undefined ? {} : { feedbackTransport }),
    name,
    nameProvenance: validateProvenance(record.nameProvenance, "span.name"),
    ...(record.timing === undefined ? {} : { timingCandidate: record.timing }),
    fields,
    unavailable,
    events: dataArray(record.events, LIMITS.maximumEventsPerOperation).map(
      (entry) => validateEvent(entry, kind),
    ),
    links: dataArray(record.links, LIMITS.maximumLinksPerOperation).map(
      (entry) => validateLink(entry, kind),
    ),
  };
  return operation;
};

type UnvalidatedOperation = ReturnType<typeof validateOperation>;

const validateFeedbackOperation = (
  operation: UnvalidatedOperation,
  correlationFields: readonly UnvalidatedOperation["fields"][number][] = [],
) => {
  if (operation.feedbackTransport !== undefined) {
    const feedbackAttributes = [...operation.fields, ...correlationFields].map(
      (field) => {
        const descriptor = getAcceptedSemanticAttributeDescriptor(field.field);
        /* v8 ignore next -- validateFields already proves every retained semantic descriptor. */
        if (descriptor === undefined) throw new CapturedTraceError();
        return {
          key: field.field,
          value: createSemanticOtlpValue(descriptor, field.value),
        };
      },
    );
    feedbackAttributes.push({
      key: "agentscope.feedback.transport",
      value: { stringValue: operation.feedbackTransport },
    });
    if (
      !feedbackAttributesAreValid({
        attributes: feedbackAttributes,
        links: operation.links.map(() => ({
          traceId: "1".repeat(32),
          spanId: "1".repeat(16),
          attributes: [],
        })),
      })
    )
      throw new CapturedTraceError();
  }
};

type ValidatedOperation = ReturnType<typeof validateOperation> & {
  readonly timing?: ReturnType<typeof validateTiming>;
};

const validateOperationGraph = (operations: readonly ValidatedOperation[]) => {
  if (
    operations.length === 0 ||
    operations.length > LIMITS.maximumOperations ||
    new Set(operations.map(({ logicalKey }) => logicalKey)).size !==
      operations.length
  )
    throw new CapturedTraceError();
  const byKey = new Map(
    operations.map((operation) => [operation.logicalKey, operation]),
  );
  const roots = operations.filter(
    ({ parentLogicalKey }) => parentLogicalKey === undefined,
  );
  const standalonePostHocFeedbackRoot =
    operations.length === 1 && roots[0]?.feedbackTransport === "post-hoc";
  if (
    roots.length !== 1 ||
    (roots[0]!.kind !== "AGENT" && !standalonePostHocFeedbackRoot)
  )
    throw new CapturedTraceError();
  for (const operation of operations) {
    if (
      (operation.parentLogicalKey !== undefined &&
        !byKey.has(operation.parentLogicalKey)) ||
      operation.links.some(
        ({ target }) =>
          target.kind === "internal" && !byKey.has(target.logicalOperationKey),
      )
    )
      throw new CapturedTraceError();
    const seen = new Set<string>();
    let cursor: ValidatedOperation | undefined = operation;
    while (cursor !== undefined) {
      if (seen.has(cursor.logicalKey)) throw new CapturedTraceError();
      seen.add(cursor.logicalKey);
      cursor =
        cursor.parentLogicalKey === undefined
          ? undefined
          : byKey.get(cursor.parentLogicalKey);
    }
  }
  return roots[0]!;
};

const validateBoundary = (value: CapturedValueCandidate) => {
  const record = exactKeys(value, [
    "session",
    "boundaryKind",
    "boundaryId",
    "generation",
    "positionKind",
    "startPosition",
    "exclusiveEndPosition",
  ]);
  const boundaryKind = boundedString(record.boundaryKind);
  const positionKind = boundedString(record.positionKind);
  if (!boundaryKinds.has(boundaryKind) || !positionKinds.has(positionKind))
    throw new CapturedTraceError();
  const session = exactKeys(
    record.session,
    ["kind"],
    ["nativeIdentityKind", "nativeIdentity"],
  );
  const validatedSession = (() => {
    if (session.kind === "native-session") {
      const native = exactKeys(record.session, [
        "kind",
        "nativeIdentityKind",
        "nativeIdentity",
      ]);
      const nativeIdentityKind = boundedString(native.nativeIdentityKind);
      if (!nativeIdentityKinds.has(nativeIdentityKind))
        throw new CapturedTraceError();
      return {
        kind: "native-session" as const,
        nativeIdentityKind,
        nativeIdentity: boundedString(native.nativeIdentity),
      };
    }
    if (session.kind === "boundary-scoped") {
      exactKeys(record.session, ["kind"]);
      return { kind: "boundary-scoped" as const };
    }
    if (session.kind === "attempt-scoped") {
      exactKeys(record.session, ["kind"]);
      return { kind: "attempt-scoped" as const };
    }
    throw new CapturedTraceError();
  })();
  const startPosition = safeInteger(record.startPosition);
  const exclusiveEndPosition = safeInteger(record.exclusiveEndPosition);
  if (exclusiveEndPosition <= startPosition) throw new CapturedTraceError();
  return {
    session: validatedSession,
    boundaryKind,
    boundaryId: boundedString(record.boundaryId),
    generation: safeInteger(record.generation),
    positionKind,
    startPosition,
    exclusiveEndPosition,
  };
};

type ValidatedInvocation = ReturnType<typeof validateInvocation> & {
  readonly invocationNonce: string;
};

const validateSnapshot = (
  value: CapturedValueCandidate,
): CaptureSnapshotIdentity => {
  const record = exactKeys(value, [
    "configurationIdentity",
    "policyIdentity",
    "redactionPolicy",
  ]);
  const configurationIdentity = boundedString(
    record.configurationIdentity,
    256,
  );
  const policyIdentity = boundedString(record.policyIdentity, 256);
  if (
    !identifier.test(configurationIdentity) ||
    !identifier.test(policyIdentity)
  )
    throw new CapturedTraceError();
  const policy = validateResolvedRedactionPolicy(record.redactionPolicy);
  if (policyIdentity !== policy.identity) throw new CapturedTraceError();
  return {
    configurationIdentity,
    policyIdentity,
    redactionPolicy: policy,
  };
};

const validateCoreContext = (value: CapturedValueCandidate, kind: string) => {
  const record = exactKeys(value, ["fields", "unavailable"]);
  const fields = dataArray(record.fields, coreContextFields.size).map(
    (entry) => {
      const fieldRecord = exactKeys(entry, ["field", "value", "provenance"]);
      const field = boundedString(fieldRecord.field);
      const descriptor = getAcceptedSemanticAttributeDescriptor(field);
      const provenance = exactKeys(fieldRecord.provenance, ["field", "source"]);
      const source = boundedString(provenance.source);
      const sourceIsValid =
        field === "agentscope.workspace.directory"
          ? new Set(["hook-payload", "native-artifact", "process"]).has(source)
          : source === "git";
      if (
        !coreContextFields.has(field) ||
        descriptor === undefined ||
        !descriptor.locations.some((location) =>
          new Set(["resource", "root-span"]).has(location),
        ) ||
        (descriptor.openInferenceKinds !== undefined &&
          !descriptor.openInferenceKinds.includes(kind)) ||
        provenance.field !== field ||
        !sourceIsValid
      )
        throw new CapturedTraceError();
      validateSemanticValue(fieldRecord.value, descriptor);
      return {
        field,
        value: fieldRecord.value as SemanticValueCandidate,
        provenance: {
          field,
          source: source as
            "git" | "hook-payload" | "native-artifact" | "process",
        },
      };
    },
  );
  const present = new Set(fields.map(({ field }) => field));
  if (present.size !== fields.length) throw new CapturedTraceError();
  const unavailable = dataArray(record.unavailable, coreContextFields.size).map(
    (entry) => {
      const item = exactKeys(entry, ["field", "source", "state", "reason"]);
      const field = boundedString(item.field);
      const source = boundedString(item.source);
      const state = boundedString(item.state);
      const reason = boundedString(item.reason);
      const sourceIsValid =
        field === "agentscope.workspace.directory"
          ? new Set(["hook-payload", "native-artifact", "process"]).has(source)
          : source === "git";
      if (
        !coreContextFields.has(field) ||
        present.has(field) ||
        !sourceIsValid ||
        !(
          (state === "unavailable" && reason === "resolution-failed") ||
          (field === "vcs.ref.head.name" &&
            source === "git" &&
            state === "not-applicable" &&
            reason === "detached-head")
        )
      )
        throw new CapturedTraceError();
      return {
        field,
        source: source as
          "git" | "hook-payload" | "native-artifact" | "process",
        state,
        reason,
      } as const;
    },
  );
  const accounted = new Set([
    ...fields.map(({ field }) => field),
    ...unavailable.map(({ field }) => field),
  ]);
  if (
    accounted.size !== coreContextFields.size ||
    [...coreContextFields].some((field) => !accounted.has(field))
  )
    throw new CapturedTraceError();
  return { fields, unavailable };
};

const validateInvocation = (value: CapturedValueCandidate) => {
  const record = exactKeys(value, [
    "harnessRegistryId",
    "harnessVersion",
    "snapshot",
    "hookObservedUnixNano",
    "operationIdScope",
    "context",
  ]);
  const harnessRegistryId = boundedString(record.harnessRegistryId);
  if (!firstPartyHarnesses.has(harnessRegistryId))
    throw new CapturedTraceError();
  const versionRecord = exactKeys(
    record.harnessVersion,
    ["state"],
    ["value", "reason", "source"],
  );
  const versionState = boundedString(versionRecord.state);
  const harnessVersion = (() => {
    if (versionState === "observed") {
      const observed = exactKeys(record.harnessVersion, [
        "state",
        "value",
        "source",
      ]);
      const source = boundedString(observed.source);
      if (!coreHarnessIdentitySources.has(source))
        throw new CapturedTraceError();
      return {
        state: "observed" as const,
        value: boundedString(observed.value, 256),
        source: source as "harness-config" | "process",
      };
    }
    if (versionState === "unavailable") {
      const unavailable = exactKeys(record.harnessVersion, [
        "state",
        "reason",
        "source",
      ]);
      const reason = boundedString(unavailable.reason);
      const source = boundedString(unavailable.source);
      if (
        !new Set(["not-emitted", "resolution-failed", "unsupported"]).has(
          reason,
        ) ||
        !coreHarnessIdentitySources.has(source)
      )
        throw new CapturedTraceError();
      return {
        state: "unavailable" as const,
        reason: reason as "not-emitted" | "resolution-failed" | "unsupported",
        source: source as "harness-config" | "process",
      };
    }
    throw new CapturedTraceError();
  })();
  const operationIdScope = boundedString(record.operationIdScope);
  if (!operationScopes.has(operationIdScope)) throw new CapturedTraceError();
  return {
    harnessRegistryId,
    harnessIdentity: {
      name: harnessRegistryId,
      nameSource: "harness-config" as const,
      version: harnessVersion,
    },
    snapshot: validateSnapshot(record.snapshot),
    hookObservedUnixNano: validateTimestamp(record.hookObservedUnixNano),
    operationIdScope: operationIdScope as "parent-scoped" | "session-global",
    context: validateCoreContext(record.context, "AGENT"),
  };
};

const validateOperationEvidence = (operation: ValidatedOperation) => {
  const presentFields = [
    "span.name",
    ...operation.fields.map(({ field }) => field),
    ...(operation.timing === undefined
      ? []
      : ["span.start_time_unix_nano", "span.end_time_unix_nano"]),
  ];
  const provenanceClaims = [
    operation.nameProvenance,
    ...operation.fields.map(({ provenance }) => provenance),
    ...(operation.timing === undefined
      ? []
      : [
          {
            field: "span.start_time_unix_nano",
            source: operation.timing.source,
            timingBasis: operation.timing.basis,
            nativeState: operation.timing.nativeState,
          },
          {
            field: "span.end_time_unix_nano",
            source: operation.timing.source,
            timingBasis: operation.timing.basis,
            nativeState: operation.timing.nativeState,
          },
        ]),
  ];
  buildSpanEvidenceLedger({
    spanKind: operation.kind,
    presentFields,
    provenanceClaims,
    unavailableClaims: operation.unavailable,
  });
};

const validateContextEvidence = (
  kind: string,
  fields: readonly SemanticFieldCandidate[],
  unavailable: readonly FieldUnavailableCandidate[],
) => {
  if (fields.length === 0 && unavailable.length === 0) return;
  buildSpanEvidenceLedger({
    spanKind: kind,
    presentFields: fields.map(({ field }) => field),
    provenanceClaims: fields.map(({ provenance }) => provenance),
    unavailableClaims: unavailable,
  });
};

const validateCandidate = (
  value: CapturedValueCandidate,
  invocation: ValidatedInvocation,
) => {
  const record = exactKeys(value, [
    "captureBoundary",
    "rootContext",
    "operations",
  ]);
  const boundary = validateBoundary(record.captureBoundary);
  const unvalidatedOperations = dataArray(
    record.operations,
    LIMITS.maximumOperations,
  ).map(validateOperation);
  const root = validateOperationGraph(unvalidatedOperations);
  const operations = unvalidatedOperations.map((operation) => ({
    ...operation,
    ...(operation.timingCandidate === undefined
      ? {}
      : {
          timing: validateTiming(
            operation.timingCandidate,
            operation.logicalKey === root.logicalKey,
          ),
        }),
  }));
  operations.forEach(validateOperationEvidence);
  const ordinals = new Set<number>();
  const sessionNativeIds = new Set<string>();
  const parentNativeIds = new Map<string | undefined, Set<string>>();
  for (const operation of operations) {
    if (operation.locator.kind === "source-ordinal") {
      if (ordinals.has(operation.locator.ordinal))
        throw new CapturedTraceError();
      ordinals.add(operation.locator.ordinal);
    } else if (invocation.operationIdScope === "session-global") {
      if (sessionNativeIds.has(operation.locator.nativeId))
        throw new CapturedTraceError();
      sessionNativeIds.add(operation.locator.nativeId);
    } else {
      const siblingIds =
        parentNativeIds.get(operation.parentLogicalKey) ?? new Set<string>();
      if (siblingIds.has(operation.locator.nativeId))
        throw new CapturedTraceError();
      siblingIds.add(operation.locator.nativeId);
      parentNativeIds.set(operation.parentLogicalKey, siblingIds);
    }
  }
  const rootContext = exactKeys(record.rootContext, ["fields", "unavailable"]);
  const contextFields = validateFields(
    rootContext.fields,
    root.kind,
    new Set(["resource", "root-span"]),
  );
  const contextUnavailable = validateUnavailable(
    rootContext.unavailable,
    root.kind,
    new Set(contextFields.map(({ field }) => field)),
    new Set(["resource", "root-span"]),
  );
  if (
    [...contextFields, ...contextUnavailable].some(
      ({ field }) =>
        isFeedbackAttributeKey(field) ||
        field === "agentscope.feedback.transport",
    )
  )
    throw new CapturedTraceError();
  validateContextEvidence(root.kind, contextFields, contextUnavailable);
  const rootOperation = operations.find(
    ({ logicalKey }) => logicalKey === root.logicalKey,
  )!;
  for (const operation of operations)
    validateFeedbackOperation(
      operation,
      operation.logicalKey === root.logicalKey
        ? contextFields.filter(({ field }) => field === "session.id")
        : [],
    );
  const rootOperationClaims = new Set([
    ...rootOperation.fields.map(({ field }) => field),
    ...rootOperation.unavailable.map(({ field }) => field),
  ]);
  if (
    [...contextFields, ...contextUnavailable].some(({ field }) =>
      rootOperationClaims.has(field),
    )
  )
    throw new CapturedTraceError();
  return {
    invocation,
    captureBoundary: {
      ...boundary,
      operationIdScope: invocation.operationIdScope,
    },
    rootContext: {
      fields: contextFields,
      unavailable: contextUnavailable,
    },
    operations,
  };
};

type PrivateCapturedTrace = ReturnType<typeof validateCandidate>;
const privateStore = new WeakMap<object, PrivateCapturedTrace>();
const identityStore = new WeakMap<object, IdentityBundle>();
const capturedTraceSummary = Object.freeze({
  type: "CapturedTrace",
  state: "unredacted",
} as const satisfies CapturedTraceSummary);

class CapturedTraceValue {
  public constructor(value: PrivateCapturedTrace) {
    Object.freeze(this);
    privateStore.set(this, value);
  }

  public toJSON(): CapturedTraceSummary {
    return capturedTraceSummary;
  }

  public [inspect.custom](): CapturedTraceSummary {
    return capturedTraceSummary;
  }

  public get [Symbol.toStringTag](): "CapturedTrace" {
    return "CapturedTrace";
  }
}
Object.freeze(CapturedTraceValue.prototype);

const createCapturedTrace = (
  input: CapturedTraceCandidate,
  invocation: ValidatedInvocation,
): CapturedTrace => {
  try {
    const cloned = clonePlainData(input);
    const validated = deepFreezePrivate(validateCandidate(cloned, invocation));
    return new CapturedTraceValue(validated) as unknown as CapturedTrace;
  } catch {
    throw new CapturedTraceError();
  }
};

const openCaptureInvocation = (input: CaptureInvocationContext) => {
  let active = true;
  let consumed = false;
  let invocation: ValidatedInvocation;
  try {
    const cloned = clonePlainData(input);
    invocation = deepFreezePrivate({
      ...validateInvocation(cloned),
      invocationNonce: randomBytes(32).toString("hex"),
    });
  } catch {
    throw new CapturedTraceError();
  }
  const factory: HarnessCaptureFactory = Object.freeze({
    capture(candidate: CapturedTraceCandidate) {
      if (!active || consumed) throw new CapturedTraceError();
      const captured = createCapturedTrace(candidate, invocation);
      consumed = true;
      return captured;
    },
  });
  return Object.freeze({
    factory,
    close() {
      active = false;
    },
  });
};

export const withCaptureInvocation = async <Result>(
  input: CaptureInvocationContext,
  callback: (factory: HarnessCaptureFactory) => Result | Promise<Result>,
): Promise<Result> => {
  if (typeof callback !== "function") throw new CapturedTraceError();
  const invocation = openCaptureInvocation(input);
  try {
    return await callback(invocation.factory);
  } finally {
    invocation.close();
  }
};

export const withCaptureInvocationSyncForCore = <Result>(
  input: CaptureInvocationContext,
  callback: (factory: HarnessCaptureFactory) => Result,
): Result => {
  if (typeof callback !== "function") throw new CapturedTraceError();
  const invocation = openCaptureInvocation(input);
  try {
    return callback(invocation.factory);
  } finally {
    invocation.close();
  }
};

export const isCapturedTrace = (value: unknown): value is CapturedTrace =>
  typeof value === "object" && value !== null && privateStore.has(value);

export const inspectCapturedTrace = (
  value: CapturedTrace,
): CapturedTraceSummary => {
  if (!isCapturedTrace(value)) throw new CapturedTraceError();
  return capturedTraceSummary;
};

export const readCapturedTraceForCore = (
  value: CapturedTrace,
): PrivateCapturedTrace => {
  const stored =
    typeof value === "object" && value !== null
      ? privateStore.get(value)
      : undefined;
  if (stored === undefined) throw new CapturedTraceError();
  return stored;
};

export const assignCapturedTraceIdentities = (value: CapturedTrace) => {
  try {
    if (typeof value !== "object" || value === null)
      throw new CapturedTraceError();
    const existing = identityStore.get(value);
    if (existing !== undefined) return existing;
    const capture = readCapturedTraceForCore(value);
    const boundary = capture.captureBoundary;
    const result = deriveIdentityBundle({
      harnessRegistryId: capture.invocation.harnessRegistryId,
      session:
        boundary.session.kind === "attempt-scoped"
          ? {
              kind: "attempt-scoped",
              invocationNonce: capture.invocation.invocationNonce,
            }
          : boundary.session,
      boundary: {
        kind: boundary.boundaryKind,
        id: boundary.boundaryId,
        generation: boundary.generation,
        positionKind: boundary.positionKind,
        exclusiveEndPosition: boundary.exclusiveEndPosition,
      },
      operationIdScope: capture.invocation.operationIdScope,
      operations: capture.operations.map((operation) => ({
        logicalKey: operation.logicalKey,
        ...(operation.parentLogicalKey === undefined
          ? {}
          : { parentLogicalKey: operation.parentLogicalKey }),
        locator: operation.locator,
      })),
    });
    identityStore.set(value, result);
    return result;
  } catch {
    throw new CapturedTraceError();
  }
};
