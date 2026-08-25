import canonicalFixture from "./testing/fixtures/sanitized-canonical-trace.json" with { type: "json" };

import { deriveIdentityBundle } from "./schema/identity.js";
import { finalizeRedactedCanonicalTrace } from "./schema/redacted-finalization.js";
import type { RedactedCanonicalTrace } from "./schema/redacted-envelope.js";

const serializedCanonicalFixture = JSON.stringify(canonicalFixture);

export const createSanitizedCanonicalTraceFixture = (): unknown =>
  JSON.parse(serializedCanonicalFixture) as unknown;

export type SanitizedRedactedTraceFixtureOptions = Readonly<{
  branchName?: string;
  harnessName?: string;
  sequence?: number;
  sessionId?: string;
  startTimeUnixNano?: string;
  tags?: readonly string[];
  modelName?: string;
}>;

const updateProvenance = (
  attributes: { key: string; value: Record<string, unknown> }[],
  fields: readonly string[],
): void => {
  const provenance = attributes.find(
    ({ key }) => key === "agentscope.mapping.provenance",
  );
  /* v8 ignore next 5 -- the versioned embedded fixture is validated in Protocol source tests; this test-only constructor never accepts a caller graph. */
  if (
    provenance === undefined ||
    typeof provenance.value.stringValue !== "string"
  )
    throw new Error("protocol.testing.fixture.invalid");
  const ledger = JSON.parse(provenance.value.stringValue) as {
    field: string;
    source: string;
  }[];
  for (const entry of ledger)
    if (
      entry.field === "span.trace_id" ||
      entry.field === "span.span_id" ||
      entry.field === "span.parent_span_id"
    )
      entry.source = "derived";
  for (const field of fields) ledger.push({ field, source: "derived" });
  ledger.sort((left, right) => left.field.localeCompare(right.field));
  provenance.value.stringValue = JSON.stringify(ledger);
};

/* eslint-disable max-lines-per-function -- one closed fixture compiler keeps
 * identity, timing, and semantic provenance updates causally adjacent. */
export const createSanitizedRedactedCanonicalTraceFixture = (
  options: SanitizedRedactedTraceFixtureOptions = {},
): RedactedCanonicalTrace => {
  const sequence = options.sequence === undefined ? 0 : options.sequence;
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 31)
    throw new Error("protocol.testing.fixture.invalid");
  const bundle = deriveIdentityBundle({
    harnessRegistryId: "codex",
    session: {
      kind: "native-session",
      nativeIdentityKind: "thread",
      nativeIdentity: `testing-fixture-session-${sequence}`,
    },
    boundary: {
      kind: "turn",
      id: `testing-fixture-boundary-${sequence}`,
      generation: 1,
      positionKind: "event-index",
      exclusiveEndPosition: 3,
    },
    operationIdScope: "session-global",
    operations: [
      { logicalKey: "root", locator: { kind: "source-ordinal", ordinal: 0 } },
      {
        logicalKey: "model",
        parentLogicalKey: "root",
        locator: { kind: "native-operation", nativeId: "model-1" },
      },
      {
        logicalKey: "tool",
        parentLogicalKey: "root",
        locator: { kind: "native-operation", nativeId: "tool-1" },
      },
    ],
  });
  const fixture = JSON.parse(serializedCanonicalFixture) as {
    resourceSpans: {
      resource?: {
        attributes: { key: string; value: Record<string, unknown> }[];
      };
      scopeSpans: {
        spans: {
          traceId: string;
          spanId: string;
          parentSpanId?: string;
          startTimeUnixNano: string;
          endTimeUnixNano?: string;
          attributes: { key: string; value: Record<string, unknown> }[];
          logicalOperationKey?: string;
        }[];
      }[];
    }[];
  };
  const spans = fixture.resourceSpans[0]?.scopeSpans[0]?.spans;
  /* v8 ignore next 2 -- the versioned embedded fixture has exactly the three operations bound by the fixed identity input above. */
  if (spans === undefined || spans.length !== 3)
    throw new Error("protocol.testing.fixture.invalid");
  const logicalKeys = ["root", "model", "tool"] as const;
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!;
    span.traceId = bundle.traceId;
    span.spanId = bundle.spans[logicalKeys[index]!]!;
    if (index > 0) span.parentSpanId = bundle.spans.root!;
    span.logicalOperationKey = logicalKeys[index]!;
    updateProvenance(span.attributes, []);
  }
  const root = spans[0]!;
  const addedRootFields: string[] = [];
  if (options.startTimeUnixNano !== undefined) {
    const target = BigInt(options.startTimeUnixNano);
    const delta = target - BigInt(root.startTimeUnixNano);
    for (const span of spans) {
      span.startTimeUnixNano = (
        BigInt(span.startTimeUnixNano) + delta
      ).toString();
      /* v8 ignore else -- every span in the embedded closed fixture has an end. */
      if (span.endTimeUnixNano !== undefined)
        span.endTimeUnixNano = (
          BigInt(span.endTimeUnixNano) + delta
        ).toString();
    }
  }
  if (options.harnessName !== undefined) {
    const harness = root.attributes.find(
      ({ key }) => key === "agentscope.harness.name",
    );
    /* v8 ignore next 2 -- the embedded fixture owns the required harness attribute. */
    if (harness === undefined)
      throw new Error("protocol.testing.fixture.invalid");
    harness.value = { stringValue: options.harnessName };
  }
  if (options.branchName !== undefined) {
    const attributes = fixture.resourceSpans[0]!.resource!.attributes;
    const branch = attributes.find(({ key }) => key === "vcs.ref.head.name");
    /* v8 ignore next 2 -- the embedded fixture owns the required VCS branch attribute. */
    if (branch === undefined)
      throw new Error("protocol.testing.fixture.invalid");
    branch.value = { stringValue: options.branchName };
  }
  if (options.sessionId !== undefined) {
    root.attributes.push({
      key: "session.id",
      value: { stringValue: options.sessionId },
    });
    addedRootFields.push("session.id");
  }
  if (options.tags !== undefined) {
    root.attributes.push({
      key: "tag.tags",
      value: {
        arrayValue: {
          values: options.tags.map((value) => ({ stringValue: value })),
        },
      },
    });
    addedRootFields.push("tag.tags");
  }
  updateProvenance(root.attributes, addedRootFields);
  if (options.modelName !== undefined) {
    const model = spans[1]!.attributes.find(
      ({ key }) => key === "llm.model_name",
    );
    /* v8 ignore next 2 -- the embedded fixture's fixed model operation owns this canonical attribute. */
    if (model === undefined)
      throw new Error("protocol.testing.fixture.invalid");
    model.value = { stringValue: options.modelName };
  }
  return finalizeRedactedCanonicalTrace({
    identityBundle: bundle,
    graph: fixture,
  });
};
/* eslint-enable max-lines-per-function */

export {
  CompatibilityProfileError,
  compileCompatibilityProfileForTesting,
  computeCompatibilitySourceFingerprintsForTesting,
  CURRENT_SOURCE_ARTIFACTS_FOR_TESTING,
  migrateSyntheticEnvelopeForTesting,
  selectCurrentGenerationForTesting,
  SYNTHETIC_SOURCE_SCHEMA_DESCRIPTOR_FOR_TESTING,
  validateProductionReaderWindowForTesting,
  type CompatibilityExtensionSnapshotInput,
  type CompatibilityProfileInput,
} from "./schema/compatibility-profile-test-support.js";
export { validateFeedbackProfileForTesting } from "./schema/feedback-profile-test-support.js";
