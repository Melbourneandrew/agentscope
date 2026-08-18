import {
  getAcceptedSemanticAttributeDescriptor,
  getStructuralSemanticDescriptor,
  parseCanonicalTraceGraph,
  type CanonicalTraceGraph,
  type OpenInferenceSpanKindValue,
  type OtlpAnyValue,
} from "@agentscope/protocol";
import type {
  RetrievedTrace,
  TraceSummary,
} from "@agentscope/destinations-core";

import { applyDescriptorRedaction } from "../redaction/transforms.js";
import type { ResolvedRedactionPolicy } from "../redaction/policy.js";

export class RetrievalGovernanceError extends Error {
  public readonly code = "core.retrieval.incompatible-trace";

  public constructor() {
    super("core.retrieval.incompatible-trace");
    this.name = "RetrievalGovernanceError";
  }
}

const incompatible = (): never => {
  throw new RetrievalGovernanceError();
};

const naturalValue = (value: OtlpAnyValue): unknown => {
  if ("intValue" in value) {
    const numeric = Number(value.intValue);
    return Number.isSafeInteger(numeric) ? numeric : incompatible();
  }
  if ("arrayValue" in value)
    return value.arrayValue.values.map((member) => naturalValue(member));
  /* v8 ignore next 3 -- strict canonical semantic attributes cannot carry bytes. */
  if ("bytesValue" in value) {
    return incompatible();
  }
  return Object.values(value)[0];
};

const unchanged = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const retainedValue = (
  semanticKey: string,
  value: unknown,
  policy: ResolvedRedactionPolicy,
  spanKind?: OpenInferenceSpanKindValue,
): unknown => {
  const descriptor = getAcceptedSemanticAttributeDescriptor(semanticKey);
  /* v8 ignore next -- strict canonical parsing binds every retained attribute to the accepted profile. */
  if (!descriptor) return incompatible();
  const result = applyDescriptorRedaction(
    descriptor,
    value,
    policy,
    undefined,
    {
      semanticKey,
      ...(spanKind === undefined ? {} : { spanKind }),
    },
  );
  if (result.outcome === "retain") return result.value;
  return undefined;
};

const spanKind = (
  attributes: CanonicalTraceGraph["resourceSpans"][number]["scopeSpans"][number]["spans"][number]["attributes"],
): OpenInferenceSpanKindValue | undefined => {
  const value = attributes?.find(
    ({ key }) => key === "openinference.span.kind",
  )?.value;
  /* v8 ignore next 3 -- strict canonical graphs require the span-kind attribute on every span. */
  return value && "stringValue" in value
    ? (value.stringValue as OpenInferenceSpanKindValue)
    : undefined;
};

const assertNameSafe = (
  descriptorKey: "span.name" | "span.event.name",
  value: string,
  policy: ResolvedRedactionPolicy,
  kind?: OpenInferenceSpanKindValue,
): void => {
  const descriptor = getStructuralSemanticDescriptor(descriptorKey);
  /* v8 ignore next -- startup profile compilation always supplies both structural descriptors. */
  if (!descriptor) return incompatible();
  const result = applyDescriptorRedaction(
    descriptor,
    value,
    policy,
    undefined,
    {
      /* v8 ignore next -- strict canonical graphs always supply the span kind. */
      ...(kind === undefined ? {} : { spanKind: kind }),
    },
  );
  if (result.outcome !== "retain") return incompatible();
  /* v8 ignore next 2 -- retained structural names have no transforming route. */
  if (result.transformed) return incompatible();
};

const assertAttributesSafe = (
  attributes: readonly Readonly<{ key: string; value: OtlpAnyValue }>[] = [],
  policy: ResolvedRedactionPolicy,
  kind?: OpenInferenceSpanKindValue,
): void => {
  for (const attribute of attributes) {
    const value = naturalValue(attribute.value);
    const retained = retainedValue(attribute.key, value, policy, kind);
    if (retained === undefined || !unchanged(retained, value))
      return incompatible();
  }
};

const assertSpanSafe = (
  span: CanonicalTraceGraph["resourceSpans"][number]["scopeSpans"][number]["spans"][number],
  policy: ResolvedRedactionPolicy,
): void => {
  const kind = spanKind(span.attributes);
  assertNameSafe("span.name", span.name, policy, kind);
  if (span.status?.message !== undefined) {
    const retained = retainedValue(
      "span.status.message",
      span.status.message,
      policy,
      kind,
    );
    /* v8 ignore next 2 -- status policy either retains unchanged or throws fixed suppression. */
    if (retained === undefined || !unchanged(retained, span.status.message))
      return incompatible();
  }
  assertAttributesSafe(span.attributes, policy, kind);
  for (const event of span.events ?? []) {
    assertNameSafe("span.event.name", event.name, policy, kind);
    assertAttributesSafe(event.attributes, policy, kind);
  }
  for (const link of span.links ?? [])
    assertAttributesSafe(link.attributes, policy, kind);
};

export const governRetrievedTrace = (
  retrieved: RetrievedTrace,
  policy: ResolvedRedactionPolicy,
): CanonicalTraceGraph => {
  try {
    const source =
      retrieved.representation.kind === "persisted-envelope"
        ? retrieved.representation.envelope.graph
        : retrieved.representation.graph;
    const graph = parseCanonicalTraceGraph(structuredClone(source));
    for (const resource of graph.resourceSpans) {
      assertAttributesSafe(resource.resource?.attributes, policy);
      for (const scope of resource.scopeSpans) {
        assertAttributesSafe(scope.scope?.attributes, policy);
        for (const span of scope.spans) assertSpanSafe(span, policy);
      }
    }
    return graph;
  } catch {
    return incompatible();
  }
};

const optionalSummaryText = (
  semanticKey: string,
  value: string | undefined,
  policy: ResolvedRedactionPolicy,
): string | undefined => {
  if (value === undefined) return undefined;
  const retained = retainedValue(semanticKey, value, policy);
  return typeof retained === "string" ? retained : undefined;
};

const optionalSummaryList = (
  semanticKey: string,
  value: readonly string[],
  policy: ResolvedRedactionPolicy,
): readonly string[] => {
  const retained = retainedValue(semanticKey, value, policy);
  return Array.isArray(retained) &&
    retained.every((member) => typeof member === "string")
    ? Object.freeze([...retained])
    : Object.freeze([]);
};

const optionalSummaryMembers = (
  semanticKey: string,
  values: readonly string[],
  policy: ResolvedRedactionPolicy,
): readonly string[] =>
  Object.freeze(
    values.flatMap((value) => {
      const retained = optionalSummaryText(semanticKey, value, policy);
      return retained === undefined ? [] : [retained];
    }),
  );

export type GovernedTraceSummary = Readonly<{
  locator: TraceSummary["locator"];
  startTime: string;
  endTime?: string;
  harness?: string;
  branch?: string;
  repositoryIdentity?: string;
  models: readonly string[];
  status: TraceSummary["status"];
  spanCount: number;
  tags: readonly string[];
}>;

export const governTraceSummary = (
  summary: TraceSummary,
  policy: ResolvedRedactionPolicy,
): GovernedTraceSummary => {
  const harness = optionalSummaryText(
    "agentscope.harness.name",
    summary.harness,
    policy,
  );
  const branch = optionalSummaryText(
    "vcs.ref.head.name",
    summary.branch,
    policy,
  );
  const repositoryIdentity = optionalSummaryText(
    "vcs.repository.name",
    summary.repositoryIdentity,
    policy,
  );
  return Object.freeze({
    locator: summary.locator,
    startTime: summary.startTime,
    ...(summary.endTime === undefined ? {} : { endTime: summary.endTime }),
    ...(harness === undefined ? {} : { harness }),
    ...(branch === undefined ? {} : { branch }),
    ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }),
    models: optionalSummaryMembers("llm.model_name", summary.models, policy),
    status: summary.status,
    spanCount: summary.spanCount,
    tags: optionalSummaryList("tag.tags", summary.tags, policy),
  });
};
