import type { z } from "zod";

import type { OtlpSpan } from "./otlp.js";
import { deepFreeze } from "./immutable.js";

type Issue = (
  context: z.RefinementCtx,
  code: string,
  path?: readonly (string | number)[],
) => void;

export const TOPOLOGY_PROFILE_IDENTITY = deepFreeze({
  traceCount: 1,
  rootCount: 1,
  requireUniqueSpanIds: true,
  requireAllParentsPresent: true,
  requireConnectedAcyclicGraph: true,
  order: ["root-first", "start-time-ascending", "span-id-binary-ascending"],
  rootTimeContainsAllSpans: true,
});

const validateConnections = (
  spans: readonly OtlpSpan[],
  rootSpanId: string,
  context: z.RefinementCtx,
  issue: Issue,
) => {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const connected = new Set([rootSpanId]);
  const invalid = new Set<string>();
  const visiting = new Set<string>();
  const visit = (initial: OtlpSpan) => {
    if (connected.has(initial.spanId) || invalid.has(initial.spanId)) {
      return;
    }
    const path: OtlpSpan[] = [];
    let current: OtlpSpan | undefined = initial;
    let reported = false;
    while (
      current !== undefined &&
      !connected.has(current.spanId) &&
      !invalid.has(current.spanId)
    ) {
      if (visiting.has(current.spanId) || current.parentSpanId === undefined) {
        issue(context, "canonical.topology.disconnected");
        path.forEach(({ spanId }) => invalid.add(spanId));
        reported = true;
        break;
      }
      visiting.add(current.spanId);
      path.push(current);
      current = byId.get(current.parentSpanId);
    }
    const terminatesAtRoot =
      current !== undefined && connected.has(current.spanId);
    if (!terminatesAtRoot && !reported) {
      issue(context, "canonical.topology.disconnected");
      path.forEach(({ spanId }) => invalid.add(spanId));
    }
    path.forEach(({ spanId }) => {
      visiting.delete(spanId);
      if (terminatesAtRoot) {
        connected.add(spanId);
      }
    });
  };
  spans.forEach(visit);
};

const compareSpans = (left: OtlpSpan, right: OtlpSpan) => {
  const time = BigInt(left.startTimeUnixNano) - BigInt(right.startTimeUnixNano);
  return time === 0n
    ? left.spanId < right.spanId
      ? -1
      : 1
    : time < 0n
      ? -1
      : 1;
};

const validateOrder = (
  spans: readonly OtlpSpan[],
  rootSpanId: string | undefined,
  context: z.RefinementCtx,
  issue: Issue,
) => {
  const root = spans.find(({ spanId }) => spanId === rootSpanId);
  const expected = [
    ...(root === undefined ? [] : [root]),
    ...spans.filter(({ spanId }) => spanId !== rootSpanId).sort(compareSpans),
  ];
  if (expected.some((span, index) => span !== spans[index])) {
    issue(context, "canonical.span.order");
  }
};

const validateRootTime = (
  spans: readonly OtlpSpan[],
  rootSpanId: string,
  context: z.RefinementCtx,
  issue: Issue,
) => {
  const root = spans.find(({ spanId }) => spanId === rootSpanId)!;
  const rootStart = BigInt(root.startTimeUnixNano);
  const rootEnd = BigInt(root.endTimeUnixNano);
  if (
    spans.some(
      (span) =>
        BigInt(span.startTimeUnixNano) < rootStart ||
        BigInt(span.endTimeUnixNano) > rootEnd,
    )
  ) {
    issue(context, "canonical.root.time-range");
  }
};

export const validateCanonicalTopology = (
  spans: readonly OtlpSpan[],
  context: z.RefinementCtx,
  issue: Issue,
): string | undefined => {
  if (
    new Set(spans.map(({ traceId }) => traceId)).size !==
    TOPOLOGY_PROFILE_IDENTITY.traceCount
  ) {
    issue(context, "canonical.topology.trace-count");
  }
  const spanIds = spans.map(({ spanId }) => spanId);
  if (new Set(spanIds).size !== spanIds.length) {
    issue(context, "canonical.topology.duplicate-span");
  }
  const roots = spans.filter(({ parentSpanId }) => parentSpanId === undefined);
  if (
    roots.length !== TOPOLOGY_PROFILE_IDENTITY.rootCount ||
    roots[0] === undefined
  ) {
    issue(context, "canonical.topology.root-count");
    validateOrder(spans, undefined, context, issue);
    return undefined;
  }
  const rootSpanId = roots[0].spanId;
  validateConnections(spans, rootSpanId, context, issue);
  validateOrder(spans, rootSpanId, context, issue);
  validateRootTime(spans, rootSpanId, context, issue);
  return rootSpanId;
};
