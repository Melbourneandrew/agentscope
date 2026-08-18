import {
  createDestinationConnectionId,
  createDestinationTypeId,
  createRetrievedTrace,
  createTraceLocator,
} from "@agentscope/destinations-core";
import { safeParseCanonicalTraceGraph } from "@agentscope/protocol";
import { describe, expect, it } from "vitest";

import { withCaptureInvocation } from "../capture/runtime.js";
import type {
  CaptureInvocationContext,
  CapturedTraceCandidate,
} from "../capture/types.js";
import { redactCapturedTrace } from "../redaction/pipeline.js";
import {
  BUILTIN_REDACTION_POLICY_REFERENCES,
  compileRedactionPolicyRegistry,
  DEFAULT_REDACTION_POLICY_REGISTRY,
  resolveRedactionPolicy,
} from "../redaction/policy.js";
import { governRetrievedTrace } from "./governance.js";

const policy = resolveRedactionPolicy(
  DEFAULT_REDACTION_POLICY_REGISTRY,
  BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
);

const invocation: CaptureInvocationContext = {
  harnessRegistryId: "codex",
  harnessVersion: { state: "observed", value: "1", source: "process" },
  snapshot: {
    configurationIdentity: "configuration-v2-test",
    policyIdentity: policy.identity,
    redactionPolicy: policy,
  },
  hookObservedUnixNano: "10",
  operationIdScope: "session-global",
  context: {
    fields: [],
    unavailable: [
      {
        field: "agentscope.workspace.directory",
        source: "process",
        state: "unavailable",
        reason: "resolution-failed",
      },
      ...[
        "agentscope.git.worktree",
        "agentscope.git.repository_root",
        "vcs.ref.head.name",
        "vcs.ref.head.revision",
        "vcs.ref.type",
      ].map((field) => ({
        field,
        source: "git" as const,
        state: "unavailable" as const,
        reason: "resolution-failed" as const,
      })),
    ],
  },
};

const candidate: CapturedTraceCandidate = {
  captureBoundary: {
    session: {
      kind: "native-session",
      nativeIdentityKind: "thread",
      nativeIdentity: "thread-1",
    },
    boundaryKind: "turn",
    boundaryId: "turn-1",
    generation: 0,
    positionKind: "event-index",
    startPosition: 0,
    exclusiveEndPosition: 1,
  },
  rootContext: { fields: [], unavailable: [] },
  operations: [
    {
      logicalKey: "root",
      locator: { kind: "source-ordinal", ordinal: 0 },
      kind: "AGENT",
      name: "agent-operation",
      nameProvenance: { field: "span.name", source: "native-artifact" },
      timing: {
        basis: "native-interval",
        nativeState: "observed",
        source: "native-artifact",
        startUnixNano: "1",
        endUnixNano: "2",
      },
      fields: [
        {
          field: "tag.tags",
          value: ["safe"],
          provenance: { field: "tag.tags", source: "native-artifact" },
        },
        {
          field: "trace.evaluations.0.evaluation.name",
          value: "quality",
          provenance: {
            field: "trace.evaluations.0.evaluation.name",
            source: "native-artifact",
          },
        },
        {
          field: "trace.evaluations.0.evaluation.score",
          value: 0.5,
          provenance: {
            field: "trace.evaluations.0.evaluation.score",
            source: "native-artifact",
          },
        },
      ],
      feedbackTransport: "inline",
      unavailable: [],
      events: [
        {
          name: "exception",
          nameProvenance: {
            field: "span.event.name",
            source: "native-artifact",
          },
          timeUnixNano: "2",
          timeProvenance: {
            field: "span.event.time_unix_nano",
            source: "native-artifact",
          },
          fields: [
            {
              field: "exception.message",
              value: "safe error",
              provenance: {
                field: "exception.message",
                source: "native-artifact",
              },
            },
            {
              field: "exception.escaped",
              value: false,
              provenance: {
                field: "exception.escaped",
                source: "native-artifact",
              },
            },
          ],
        },
      ],
      links: [
        {
          target: {
            kind: "external",
            traceId: "03".repeat(16),
            spanId: "04".repeat(8),
          },
          targetProvenance: {
            field: "span.link.target",
            source: "native-artifact",
          },
          fields: [],
        },
      ],
    },
  ],
};

/* eslint-disable max-lines-per-function -- hostile graph variants share one Core-minted canonical fixture. */
describe("retrieval graph governance", () => {
  it("revalidates events and links through current policy", async () => {
    const redacted = redactCapturedTrace(
      await withCaptureInvocation(invocation, (factory) =>
        factory.capture(candidate),
      ),
    );
    const graph = redacted.graph;
    const traceId = graph.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.traceId;
    const locator = createTraceLocator({
      connectionId: createDestinationConnectionId(
        `destination-connection-v1-${"a".repeat(64)}`,
      ),
      destinationType: createDestinationTypeId(
        "@agentscope/destination-retrieval-test",
      ),
      traceId,
    });
    const retrieved = createRetrievedTrace({
      locator,
      representation: { kind: "canonical-graph", graph },
      consistency: "snapshot",
    });
    const governed = governRetrievedTrace(retrieved, policy);
    const span = governed.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.events).toHaveLength(1);
    expect(span.links).toHaveLength(1);
  });

  it("rejects a graph newly excluded by the current policy", async () => {
    const redacted = redactCapturedTrace(
      await withCaptureInvocation(invocation, (factory) =>
        factory.capture(candidate),
      ),
    );
    const traceId =
      redacted.graph.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.traceId;
    const locator = createTraceLocator({
      connectionId: createDestinationConnectionId(
        `destination-connection-v1-${"b".repeat(64)}`,
      ),
      destinationType: createDestinationTypeId(
        "@agentscope/destination-retrieval-test",
      ),
      traceId,
    });
    const retrieved = createRetrievedTrace({
      locator,
      representation: { kind: "canonical-graph", graph: redacted.graph },
      consistency: "snapshot",
    });
    const registry = compileRedactionPolicyRegistry([
      {
        version: 1,
        reference: "retrieval-omit-tags",
        mode: "baseline",
        rules: [
          {
            selector: { kind: "semantic-key", value: "tag.tags" },
            action: "omit",
          },
        ],
      },
    ]);
    expect(() =>
      governRetrievedTrace(
        retrieved,
        resolveRedactionPolicy(registry, "retrieval-omit-tags"),
      ),
    ).toThrowError("core.retrieval.incompatible-trace");

    const eventRegistry = compileRedactionPolicyRegistry([
      {
        version: 1,
        reference: "retrieval-omit-event",
        mode: "baseline",
        rules: [
          {
            selector: {
              kind: "semantic-key",
              value: "exception.message",
            },
            action: "omit",
          },
        ],
      },
    ]);
    expect(() =>
      governRetrievedTrace(
        retrieved,
        resolveRedactionPolicy(eventRegistry, "retrieval-omit-event"),
      ),
    ).toThrowError("core.retrieval.incompatible-trace");

    const unsafeIntegerGraph = structuredClone(redacted.graph);
    const integer = unsafeIntegerGraph.resourceSpans[0]!.scopeSpans.flatMap(
      ({ spans }) => spans,
    )
      .flatMap(({ attributes }) => attributes ?? [])
      .find(({ key }) => key.endsWith("evaluation.score"));
    expect(integer).toBeDefined();
    if (integer) integer.value = { intValue: "9007199254740993" };
    const unsafeInteger = createRetrievedTrace({
      locator,
      representation: {
        kind: "canonical-graph",
        graph: unsafeIntegerGraph,
      },
      consistency: "snapshot",
    });
    expect(() => governRetrievedTrace(unsafeInteger, policy)).toThrowError(
      "core.retrieval.incompatible-trace",
    );

    const replaceGraph = structuredClone(redacted.graph);
    const feedbackName = replaceGraph.resourceSpans[0]!.scopeSpans.flatMap(
      ({ spans }) => spans,
    )
      .flatMap(({ attributes }) => attributes ?? [])
      .find(({ key }) => key.endsWith("evaluation.name"));
    expect(feedbackName).toBeDefined();
    if (feedbackName)
      feedbackName.value = { stringValue: "Bearer CANARY_SECRET" };
    const replaced = createRetrievedTrace({
      locator,
      representation: { kind: "canonical-graph", graph: replaceGraph },
      consistency: "snapshot",
    });
    expect(() => governRetrievedTrace(replaced, policy)).toThrowError(
      "core.retrieval.incompatible-trace",
    );

    const unsafeStatusGraph = structuredClone(redacted.graph);
    const unsafeStatusSpan =
      unsafeStatusGraph.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    unsafeStatusSpan.status = {
      code: 2,
      message: "Bearer CANARY_SECRET",
    };
    const statusProvenance = unsafeStatusSpan.attributes?.find(
      ({ key }) => key === "agentscope.mapping.provenance",
    )?.value;
    expect(statusProvenance).toBeDefined();
    if (statusProvenance && "stringValue" in statusProvenance) {
      const members = JSON.parse(statusProvenance.stringValue) as Array<{
        field: string;
        source: string;
      }>;
      members.push(
        { field: "span.status.code", source: "native-artifact" },
        { field: "span.status.message", source: "native-artifact" },
      );
      members.sort((left, right) => left.field.localeCompare(right.field));
      statusProvenance.stringValue = JSON.stringify(members);
    }
    expect(safeParseCanonicalTraceGraph(unsafeStatusGraph)).toMatchObject({
      success: true,
    });
    const unsafeStatus = createRetrievedTrace({
      locator,
      representation: {
        kind: "canonical-graph",
        graph: unsafeStatusGraph,
      },
      consistency: "snapshot",
    });
    expect(() => governRetrievedTrace(unsafeStatus, policy)).toThrowError(
      "core.retrieval.incompatible-trace",
    );
  });
});
/* eslint-enable max-lines-per-function */
