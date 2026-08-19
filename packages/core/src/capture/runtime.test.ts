import { inspect } from "node:util";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  CapturedTraceCandidate,
  CaptureInvocationContext,
  HarnessCaptureFactory,
  OpenInferenceOperationKind,
  OperationCandidate,
  SemanticValueCandidate,
} from "./types.js";
import {
  CapturedTraceError,
  assignCapturedTraceIdentities,
  inspectCapturedTrace,
  isCapturedTrace,
  readCapturedTraceForCore,
  withCaptureInvocation,
} from "./runtime.js";
import {
  BUILTIN_REDACTION_POLICY_REFERENCES,
  DEFAULT_REDACTION_POLICY_REGISTRY,
  resolveRedactionPolicy,
} from "../redaction/policy.js";

// Capture-side enforcement evidence for AC-CAP-001.3 and AC-CAP-002.7.

const resolvedPolicy = (mode: "baseline" | "strict" = "baseline") =>
  resolveRedactionPolicy(
    DEFAULT_REDACTION_POLICY_REGISTRY,
    BUILTIN_REDACTION_POLICY_REFERENCES[mode],
  );

const unavailableContext = Object.freeze({
  fields: Object.freeze([]),
  unavailable: Object.freeze([
    {
      field: "agentscope.workspace.directory",
      source: "process" as const,
      state: "unavailable" as const,
      reason: "resolution-failed" as const,
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
  ]),
});

const invocation = (): CaptureInvocationContext => {
  const policy = resolvedPolicy();
  return {
    harnessRegistryId: "codex",
    harnessVersion: {
      state: "observed",
      value: "1.2.3",
      source: "process",
    },
    snapshot: {
      configurationIdentity: "config.v1",
      policyIdentity: policy.identity,
      redactionPolicy: policy,
    },
    hookObservedUnixNano: "100",
    operationIdScope: "session-global",
    context: unavailableContext,
  };
};

const operation = (
  logicalKey = "root",
  parentLogicalKey?: string,
  ordinal = 0,
  kind: OpenInferenceOperationKind = "AGENT",
): OperationCandidate => ({
  logicalKey,
  locator: { kind: "source-ordinal", ordinal },
  ...(parentLogicalKey === undefined ? {} : { parentLogicalKey }),
  kind,
  name:
    kind === "EMBEDDING"
      ? "CreateEmbeddings"
      : `${kind.toLowerCase()}-operation`,
  nameProvenance: { field: "span.name", source: "native-artifact" },
  timing: {
    basis: "native-interval",
    nativeState: "observed",
    source: "native-artifact",
    startUnixNano: "1",
    endUnixNano: "2",
  },
  fields: [],
  unavailable: [],
  events: [],
  links: [],
});

const field = (semantic: string, value: SemanticValueCandidate) => ({
  field: semantic,
  value,
  provenance: { field: semantic, source: "native-artifact" as const },
});

const candidate = (): CapturedTraceCandidate => ({
  captureBoundary: {
    session: {
      kind: "native-session",
      nativeIdentityKind: "thread",
      nativeIdentity: "native-secret-session",
    },
    boundaryKind: "turn",
    boundaryId: "native-secret-boundary",
    generation: 0,
    positionKind: "event-index",
    startPosition: 0,
    exclusiveEndPosition: 2,
  },
  rootContext: { fields: [], unavailable: [] },
  operations: [operation()],
});

const capture = async (value = candidate()) =>
  withCaptureInvocation(invocation(), (factory) => factory.capture(value));

const fixedFailure = async (value: unknown) => {
  await expect(
    withCaptureInvocation(invocation(), (factory) =>
      factory.capture(value as never),
    ),
  ).rejects.toMatchObject({
    name: "CapturedTraceError",
    message: "core.capture.invalid",
    code: "core.capture.invalid",
  });
};

describe("captured trace safe runtime surface", () => {
  it("exposes only a fixed marker through every ordinary inspection path", async () => {
    const trace = await capture();
    const outputs = [
      JSON.stringify(trace),
      Object.prototype.toString.call(trace),
      inspect(trace),
      inspect(trace, { showHidden: true }),
      JSON.stringify({ ...trace }),
      JSON.stringify(Object.getOwnPropertyDescriptors(trace)),
      JSON.stringify(inspectCapturedTrace(trace)),
    ];
    expect(outputs.join(" ")).not.toContain("native-secret");
    expect(JSON.parse(JSON.stringify(trace))).toEqual({
      type: "CapturedTrace",
      state: "unredacted",
    });
    expect(Object.keys(trace)).toEqual([]);
    expect(Object.isFrozen(trace)).toBe(true);
    expect(Object.isFrozen(Reflect.getPrototypeOf(trace))).toBe(true);
    expect(isCapturedTrace(trace)).toBe(true);
  });

  it("keeps the shared prototype and inspection output immutable", async () => {
    const trace = await capture();
    const prototype = Reflect.getPrototypeOf(trace) as object;
    expect(
      Reflect.set(prototype, "toJSON", () => ({ content: "CANARY_SECRET" })),
    ).toBe(false);
    expect(Reflect.deleteProperty(prototype, "toJSON")).toBe(false);
    expect(() =>
      Object.defineProperty(prototype, "toJSON", {
        value: () => ({ content: "CANARY_SECRET" }),
      }),
    ).toThrow(TypeError);
    expect(JSON.stringify(trace)).toBe(
      '{"type":"CapturedTrace","state":"unredacted"}',
    );
    expect(inspectCapturedTrace(trace)).toEqual({
      type: "CapturedTrace",
      state: "unredacted",
    });
  });

  it("is nominal, rejects forgeries, and keeps private data frozen", async () => {
    const input = candidate();
    const trace = await capture(input);
    Reflect.set(input.operations[0]!, "name", "mutated");
    const stored = readCapturedTraceForCore(trace);
    expect(stored.operations[0]!.name).toBe("agent-operation");
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.operations)).toBe(true);

    for (const forgery of [
      {},
      { ...trace },
      Object.create(Reflect.getPrototypeOf(trace)),
      JSON.parse(JSON.stringify(trace)) as unknown as object,
    ]) {
      expect(isCapturedTrace(forgery)).toBe(false);
      expect(() => readCapturedTraceForCore(forgery as never)).toThrowError(
        "core.capture.invalid",
      );
    }
    const cloned = structuredClone(trace);
    expect(JSON.stringify(cloned)).not.toContain("native-secret");
    expect(isCapturedTrace(cloned)).toBe(false);
    expect(() => inspectCapturedTrace({} as never)).toThrow(CapturedTraceError);
    expect(() => readCapturedTraceForCore(null as never)).toThrow(
      CapturedTraceError,
    );
  });
});

describe("snapshot-bound capture factory", () => {
  it("assigns stable session trace span boundary and delivery identities", async () => {
    const base = candidate();
    const first = await capture({
      ...base,
      operations: [base.operations[0]!, operation("child", "root", 1, "TOOL")],
    });
    const appended = await capture({
      ...base,
      captureBoundary: { ...base.captureBoundary, exclusiveEndPosition: 3 },
      operations: [base.operations[0]!, operation("child", "root", 1, "TOOL")],
    });
    const firstIds = assignCapturedTraceIdentities(first);
    const appendedIds = assignCapturedTraceIdentities(appended);
    expect(appendedIds.traceId).toEqual(firstIds.traceId);
    expect(appendedIds.spans).toEqual(firstIds.spans);
    expect(appendedIds.boundaryId).not.toBe(firstIds.boundaryId);
    expect(appendedIds.deliveryId).not.toBe(firstIds.deliveryId);
    expect(Object.isFrozen(firstIds)).toBe(true);
    expect(assignCapturedTraceIdentities(first)).toBe(firstIds);
    expect(() => assignCapturedTraceIdentities({} as never)).toThrow(
      CapturedTraceError,
    );
    expect(() => assignCapturedTraceIdentities(null as never)).toThrow(
      CapturedTraceError,
    );
  });

  it("applies explicit fallback stability with a Core-owned attempt nonce", async () => {
    const boundaryCandidate = {
      ...candidate(),
      captureBoundary: {
        ...candidate().captureBoundary,
        session: { kind: "boundary-scoped" as const },
      },
    };
    const boundaryFirst = assignCapturedTraceIdentities(
      await capture(boundaryCandidate),
    );
    const boundaryMoved = assignCapturedTraceIdentities(
      await capture({
        ...boundaryCandidate,
        captureBoundary: {
          ...boundaryCandidate.captureBoundary,
          generation: 2,
          exclusiveEndPosition: 7,
        },
      }),
    );
    expect(boundaryMoved.traceId).toBe(boundaryFirst.traceId);
    expect(boundaryMoved.boundaryId).not.toBe(boundaryFirst.boundaryId);

    const attemptCandidate = {
      ...candidate(),
      captureBoundary: {
        ...candidate().captureBoundary,
        session: { kind: "attempt-scoped" as const },
      },
    };
    const attemptFirst = assignCapturedTraceIdentities(
      await capture(attemptCandidate),
    );
    const attemptSecond = assignCapturedTraceIdentities(
      await capture(attemptCandidate),
    );
    expect(attemptFirst.stability).toBe("attempt-scoped-at-least-once");
    expect(attemptSecond.traceId).not.toBe(attemptFirst.traceId);
  });
});

describe("identity privacy exclusions", () => {
  it("excludes semantic content policy and observation metadata from identity", async () => {
    const first = await capture();
    const changedOperation = {
      ...operation("root", undefined, 0, "AGENT"),
      name: "renamed-secret-operation",
      timing: {
        ...operation().timing!,
        startUnixNano: "20",
        endUnixNano: "30",
      },
    };
    const strict = resolvedPolicy("strict");
    const changed = await withCaptureInvocation(
      {
        ...invocation(),
        harnessVersion: {
          state: "observed",
          value: "99.0.0",
          source: "process",
        },
        snapshot: {
          configurationIdentity: "config.changed",
          policyIdentity: strict.identity,
          redactionPolicy: strict,
        },
        hookObservedUnixNano: "999",
      },
      (factory) =>
        factory.capture({ ...candidate(), operations: [changedOperation] }),
    );
    expect(assignCapturedTraceIdentities(changed)).toEqual(
      assignCapturedTraceIdentities(first),
    );
  });
});

describe("snapshot-bound capture lifecycle", () => {
  it("is single-use and revoked in finally", async () => {
    let retained: HarnessCaptureFactory | undefined;
    const trace = await withCaptureInvocation(invocation(), (factory) => {
      retained = factory;
      const value = factory.capture(candidate());
      expect(() => factory.capture(candidate())).toThrow(CapturedTraceError);
      return value;
    });
    expect(isCapturedTrace(trace)).toBe(true);
    expect(() => retained!.capture(candidate())).toThrow(CapturedTraceError);
  });

  it("revokes after rejection and late asynchronous work", async () => {
    let retained: HarnessCaptureFactory | undefined;
    await expect(
      withCaptureInvocation(invocation(), (factory) => {
        retained = factory;
        throw new Error("adapter failure");
      }),
    ).rejects.toThrow("adapter failure");
    expect(() => retained!.capture(candidate())).toThrow(CapturedTraceError);

    let late: (() => void) | undefined;
    await withCaptureInvocation(invocation(), (factory) => {
      late = () => {
        factory.capture(candidate());
      };
    });
    expect(late).toThrow(CapturedTraceError);
  });
});

describe("snapshot-bound invocation rejection", () => {
  it("rejects hostile or invalid Core-owned invocation context", async () => {
    for (const context of [
      null,
      { ...invocation(), harnessRegistryId: "third-party" },
      { ...invocation(), hookObservedUnixNano: "invalid" },
      { ...invocation(), harnessVersion: { state: "observed", value: "1" } },
      {
        ...invocation(),
        harnessVersion: {
          state: "observed",
          value: "1",
          source: "native-artifact",
        },
      },
      {
        ...invocation(),
        harnessVersion: {
          state: "unavailable",
          reason: "bad",
          source: "process",
        },
      },
      {
        ...invocation(),
        harnessVersion: { state: "attacker", source: "process" },
      },
      { ...invocation(), snapshot: { policyIdentity: "x" } },
      { ...invocation(), context: { fields: [], unavailable: [] } },
      {
        ...invocation(),
        context: {
          fields: [
            {
              field: "agentscope.workspace.directory",
              value: "workspace",
              provenance: {
                field: "agentscope.workspace.directory",
                source: "git",
              },
            },
          ],
          unavailable: unavailableContext.unavailable.slice(1),
        },
      },
      {
        ...invocation(),
        context: {
          fields: [],
          unavailable: unavailableContext.unavailable.map((entry, index) =>
            index === 1
              ? { ...entry, state: "not-applicable", reason: "detached-head" }
              : entry,
          ),
        },
      },
      {
        ...invocation(),
        context: {
          fields: [
            {
              field: "agentscope.workspace.directory",
              value: "workspace",
              provenance: {
                field: "agentscope.workspace.directory",
                source: "process",
              },
            },
            {
              field: "agentscope.workspace.directory",
              value: "workspace",
              provenance: {
                field: "agentscope.workspace.directory",
                source: "process",
              },
            },
          ],
          unavailable: unavailableContext.unavailable.slice(1),
        },
      },
      {
        ...invocation(),
        context: {
          fields: [
            {
              field: "agentscope.workspace.directory",
              value: "workspace",
              provenance: {
                field: "agentscope.workspace.directory",
                source: "process",
              },
            },
          ],
          unavailable: unavailableContext.unavailable,
        },
      },
    ]) {
      await expect(
        withCaptureInvocation(context as never, () => undefined),
      ).rejects.toThrowError("core.capture.invalid");
    }
    await expect(
      withCaptureInvocation(invocation(), null as never),
    ).rejects.toThrowError("core.capture.invalid");
  });
});

describe("Core-owned harness identity evidence", () => {
  it("accepts exact detached-head unavailability without inventing a name", async () => {
    const value = invocation();
    const detached: CaptureInvocationContext = {
      ...value,
      context: {
        fields: value.context.fields,
        unavailable: value.context.unavailable.map((entry) =>
          entry.field === "vcs.ref.head.name"
            ? {
                ...entry,
                state: "not-applicable",
                reason: "detached-head",
              }
            : entry,
        ),
      },
    };
    await expect(
      withCaptureInvocation(detached, (factory) =>
        factory.capture(candidate()),
      ),
    ).resolves.toBeDefined();
  });

  it("binds observed or explicitly unavailable harness version evidence", async () => {
    const observed = await withCaptureInvocation(invocation(), (factory) =>
      factory.capture(candidate()),
    );
    expect(
      readCapturedTraceForCore(observed).invocation.harnessIdentity,
    ).toEqual({
      name: "codex",
      nameSource: "harness-config",
      version: {
        state: "observed",
        value: "1.2.3",
        source: "process",
      },
    });
    const unavailable = await withCaptureInvocation(
      {
        ...invocation(),
        harnessVersion: {
          state: "unavailable",
          reason: "resolution-failed",
          source: "harness-config",
        },
      },
      (factory) => factory.capture(candidate()),
    );
    expect(
      readCapturedTraceForCore(unavailable).invocation.harnessIdentity.version,
    ).toEqual({
      state: "unavailable",
      reason: "resolution-failed",
      source: "harness-config",
    });
  });
});

describe("candidate semantics and graph", () => {
  it("accepts every pinned operation kind and first-party harness", async () => {
    const kinds: readonly OpenInferenceOperationKind[] = [
      "AGENT",
      "CHAIN",
      "EMBEDDING",
      "EVALUATOR",
      "GUARDRAIL",
      "LLM",
      "PROMPT",
      "RERANKER",
      "RETRIEVER",
      "TOOL",
    ];
    const value: CapturedTraceCandidate = {
      ...candidate(),
      operations: [
        operation(),
        ...kinds.slice(1).map((kind, index) => {
          const value = operation(`child-${index}`, "root", index + 1, kind);
          return kind === "LLM"
            ? {
                ...value,
                unavailable: [
                  {
                    field: "llm.system",
                    source: "native-artifact" as const,
                    state: "unavailable" as const,
                    reason: "not-emitted" as const,
                  },
                ],
              }
            : value;
        }),
      ],
    };
    for (const harnessRegistryId of [
      "claude-code",
      "codex",
      "gemini-cli",
      "hermes",
      "openclaw",
      "opencode",
      "pi",
    ] as const) {
      const trace = await withCaptureInvocation(
        { ...invocation(), harnessRegistryId },
        (factory) => factory.capture(value),
      );
      expect(isCapturedTrace(trace)).toBe(true);
    }
  });

  it("accepts descriptor-shaped values and explicit unavailable evidence", async () => {
    const base = candidate();
    const value: CapturedTraceCandidate = {
      ...base,
      operations: [
        {
          ...base.operations[0]!,
          fields: [
            {
              field: "input.value",
              value: "prompt",
              provenance: { field: "input.value", source: "hook-payload" },
            },
            {
              field: "tag.tags",
              value: ["one", "two"],
              provenance: { field: "tag.tags", source: "native-artifact" },
            },
          ],
          unavailable: [
            {
              field: "family.tool.activity",
              source: "native-artifact",
              state: "observed-empty",
              reason: "empty-native-value",
            },
          ],
        },
      ],
    };
    expect(isCapturedTrace(await capture(value))).toBe(true);
  });

  it("accepts missing native timing and session-global native locators", async () => {
    const base = candidate();
    const root = operation();
    Reflect.deleteProperty(root, "timing");
    Reflect.set(root, "locator", {
      kind: "native-operation",
      nativeId: "root-native",
    });
    expect(
      isCapturedTrace(await capture({ ...base, operations: [root] })),
    ).toBe(true);
  });
});

describe("external link authority", () => {
  it("accepts trusted lowercase nonzero external link identities", async () => {
    const base = candidate();
    const value: CapturedTraceCandidate = {
      ...base,
      operations: [
        {
          ...base.operations[0]!,
          links: [
            {
              target: {
                kind: "external",
                traceId: "03".repeat(16),
                spanId: "04".repeat(8),
              },
              targetProvenance: {
                field: "span.link.target",
                source: "hook-payload",
              },
              fields: [],
            },
          ],
        },
      ],
    };
    expect(isCapturedTrace(await capture(value))).toBe(true);
  });
});

describe("descriptor value candidates", () => {
  it("accepts every descriptor value class on its applicable operation", async () => {
    const base = candidate();
    const operations: OperationCandidate[] = [
      {
        ...base.operations[0]!,
        fields: [
          field("input.value", ""),
          field("metadata", '{"safe":true}'),
          field("tag.tags", ["one", "two"]),
        ],
        events: [
          {
            name: "exception",
            nameProvenance: {
              field: "span.event.name",
              source: "native-artifact",
            },
            timeUnixNano: "1",
            timeProvenance: {
              field: "span.event.time_unix_nano",
              source: "native-artifact",
            },
            fields: [
              field("exception.escaped", false),
              field("exception.message", "safe"),
            ],
          },
        ],
      },
      {
        ...operation("llm", "root", 1, "LLM"),
        fields: [
          field("llm.system", "custom-system"),
          field("llm.invocation_parameters", '{"temperature":0}'),
          field("llm.token_count.total", 3),
          field("llm.cost.total", 0.01),
        ],
      },
      {
        ...operation("embedding", "root", 2, "EMBEDDING"),
        fields: [field("embedding.embeddings.0.embedding.vector", [0.1, 0.2])],
      },
      {
        ...operation("retriever", "root", 3, "RETRIEVER"),
        fields: [field("retrieval.documents.0.document.id", 7)],
      },
    ];
    operations[0] = {
      ...operations[0]!,
      links: [
        {
          target: { kind: "internal", logicalOperationKey: "llm" },
          targetProvenance: {
            field: "span.link.target",
            source: "native-artifact",
          },
          fields: [],
        },
      ],
    };
    const value: CapturedTraceCandidate = {
      ...base,
      operations,
    };
    expect(isCapturedTrace(await capture(value))).toBe(true);
  });

  it("accepts ordinary high-dimensional vectors within the raw budget", async () => {
    for (const dimensions of [1_536, 3_072]) {
      const base = candidate();
      const value: CapturedTraceCandidate = {
        ...base,
        operations: [
          base.operations[0]!,
          {
            ...operation("embedding", "root", 1, "EMBEDDING"),
            fields: [
              field(
                "embedding.embeddings.0.embedding.vector",
                Array.from({ length: dimensions }, () => 0.25),
              ),
            ],
          },
        ],
      };
      expect(isCapturedTrace(await capture(value))).toBe(true);
    }
  });
});

describe("boundary candidate variants", () => {
  it("accepts each session mode, boundary enum, native locator, and point timing", async () => {
    const sessions = [
      { kind: "boundary-scoped" as const },
      { kind: "attempt-scoped" as const },
    ];
    const boundaryKinds = [
      "hook-invocation",
      "session",
      "transcript-range",
      "turn",
    ] as const;
    const positionKinds = [
      "byte-offset",
      "event-index",
      "line",
      "sequence",
    ] as const;
    for (const [index, boundaryKind] of boundaryKinds.entries()) {
      const base = candidate();
      const value: CapturedTraceCandidate = {
        ...base,
        captureBoundary: {
          ...base.captureBoundary,
          session: sessions[index % sessions.length]!,
          boundaryKind,
          positionKind: positionKinds[index]!,
        },
        operations: [
          {
            ...base.operations[0]!,
            locator: { kind: "native-operation", nativeId: "root-native" },
            timing: {
              basis: "native-point",
              nativeState: "observed",
              source: "hook-payload",
              startUnixNano: "5",
              endUnixNano: "5",
            },
          },
        ],
      };
      expect(isCapturedTrace(await capture(value))).toBe(true);
    }
  });

  it("keeps parent-scoped native identities structurally distinct", async () => {
    const base = candidate();
    const native = (
      logicalKey: string,
      parentLogicalKey: string | undefined,
      nativeId: string,
    ): OperationCandidate => ({
      ...operation(logicalKey, parentLogicalKey),
      locator: { kind: "native-operation", nativeId },
    });
    const value: CapturedTraceCandidate = {
      ...base,
      operations: [
        native("root", undefined, "x"),
        native("same-id-child", "root", "x"),
        native("a:b", "root", "parent-one"),
        native("a", "root", "parent-two"),
        native("colon-child-one", "a:b", "c"),
        native("colon-child-two", "a", "b:c"),
      ],
    };
    expect(
      isCapturedTrace(
        await withCaptureInvocation(
          { ...invocation(), operationIdScope: "parent-scoped" },
          (factory) => factory.capture(value),
        ),
      ),
    ).toBe(true);
  });
});

describe("external link target rejection", () => {
  it("rejects malformed, zero, ambiguous, and noncanonical external link targets", async () => {
    const base = candidate();
    const external = (target: unknown): CapturedTraceCandidate => ({
      ...base,
      operations: [
        {
          ...base.operations[0]!,
          links: [
            {
              target: target as never,
              targetProvenance: {
                field: "span.link.target",
                source: "native-artifact",
              },
              fields: [],
            },
          ],
        },
      ],
    });
    for (const target of [
      { kind: "external", traceId: "0".repeat(32), spanId: "04".repeat(8) },
      { kind: "external", traceId: "03".repeat(16), spanId: "0".repeat(16) },
      { kind: "external", traceId: "A3".repeat(16), spanId: "04".repeat(8) },
      { kind: "external", traceId: "03".repeat(16) },
      {
        kind: "external",
        traceId: "03".repeat(16),
        spanId: "04".repeat(8),
        logicalOperationKey: "root",
      },
      {
        kind: "internal",
        logicalOperationKey: "root",
        traceId: "03".repeat(16),
      },
      { kind: "attacker" },
    ])
      await fixedFailure(external(target));
  });
});

describe("candidate rejection", () => {
  it("rejects unknown, canonical-owned, mismatched, and raw DTO fields", async () => {
    for (const field of [
      "attacker.secret",
      "agentscope.mapping.provenance",
      "agentscope.mapping.unavailable",
      "agentscope.harness.name",
      "agentscope.harness.version",
      "agentscope.protocol.manifest_id",
      "agentscope.redaction.policy_id",
      "agentscope.feedback.transport",
      "openinference.span.kind",
      "service.name",
      "langfuse.trace.id",
    ]) {
      const base = candidate();
      const value: CapturedTraceCandidate = {
        ...base,
        operations: [
          {
            ...base.operations[0]!,
            fields: [
              {
                field,
                value: "x",
                provenance: { field, source: "native-artifact" },
              },
            ],
          },
        ],
      };
      await fixedFailure(value);
    }
    await fixedFailure({ provider: "codex", messages: [], sources: [] });
    await fixedFailure({ resourceSpans: [] });
  });
});

describe("feedback carrier capture", () => {
  it("accepts only typed transport intent paired with valid native feedback", async () => {
    const feedbackFields = [
      field("annotations.0.annotation.name", "quality"),
      field("annotations.0.annotation.label", "good"),
    ];
    await expect(
      capture({
        ...candidate(),
        operations: [
          {
            ...operation(),
            feedbackTransport: "inline",
            fields: feedbackFields,
          },
        ],
      }),
    ).resolves.toBeDefined();
    await fixedFailure({
      ...candidate(),
      operations: [{ ...operation(), fields: feedbackFields }],
    });
    await fixedFailure({
      ...candidate(),
      operations: [{ ...operation(), feedbackTransport: "inline" }],
    });
    await fixedFailure({
      ...candidate(),
      operations: [
        {
          ...operation(),
          feedbackTransport: "external" as never,
          fields: feedbackFields,
        },
      ],
    });
  });

  it("rejects contradictory aliases before redaction can normalize them", async () => {
    await fixedFailure({
      ...candidate(),
      operations: [
        {
          ...operation(),
          feedbackTransport: "inline",
          fields: [
            field("annotations.0.annotation.name", "quality"),
            field("annotations.0.annotation.explanation", "secret-left"),
            field("evaluations.7.evaluation.name", "quality"),
            field("evaluations.7.evaluation.explanation", "secret-right"),
          ],
        },
      ],
    });
  });

  it("keeps feedback operation-owned while merging root session correlation", async () => {
    const sessionFeedback = [
      field("session.evaluations.4.evaluation.name", "quality"),
      field("session.evaluations.4.evaluation.label", "good"),
    ];
    await expect(
      capture({
        ...candidate(),
        rootContext: {
          fields: [field("session.id", "session-123")],
          unavailable: [],
        },
        operations: [
          {
            ...operation(),
            feedbackTransport: "inline",
            fields: sessionFeedback,
          },
        ],
      }),
    ).resolves.toBeDefined();
    await fixedFailure({
      ...candidate(),
      rootContext: { fields: sessionFeedback, unavailable: [] },
    });
  });
});

describe("candidate topology rejection", () => {
  it("rejects every malformed topology and duplicate native locator", async () => {
    const cases: OperationCandidate[][] = [
      [],
      [operation(), operation()],
      [operation(), operation("root", undefined, 1)],
      [operation(), operation("child", "missing", 1)],
      [
        { ...operation(), parentLogicalKey: "child" },
        operation("child", "root", 1),
      ],
      [operation(), operation("child", "child", 1)],
      [operation(), operation("child", "root", 0)],
      [operation("root", undefined, 0, "TOOL")],
    ];
    for (const operations of cases) {
      const value: CapturedTraceCandidate = { ...candidate(), operations };
      await fixedFailure(value);
    }
    const base = candidate();
    const duplicateNative: CapturedTraceCandidate = {
      ...base,
      operations: [
        {
          ...base.operations[0]!,
          locator: { kind: "native-operation", nativeId: "duplicate" },
        },
        {
          ...operation("child", "root", 1),
          locator: { kind: "native-operation", nativeId: "duplicate" },
        },
      ],
    };
    await fixedFailure(duplicateNative);
    const parentDuplicate: CapturedTraceCandidate = {
      ...base,
      operations: [
        base.operations[0]!,
        {
          ...operation("first", "root", 1),
          locator: { kind: "native-operation", nativeId: "duplicate" },
        },
        {
          ...operation("second", "root", 2),
          locator: { kind: "native-operation", nativeId: "duplicate" },
        },
      ],
    };
    await expect(
      withCaptureInvocation(
        { ...invocation(), operationIdScope: "parent-scoped" },
        (factory) => factory.capture(parentDuplicate),
      ),
    ).rejects.toThrow(CapturedTraceError);
    const missingLink: CapturedTraceCandidate = {
      ...base,
      operations: [
        {
          ...base.operations[0]!,
          links: [
            {
              target: {
                kind: "internal",
                logicalOperationKey: "missing",
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
    await fixedFailure(missingLink);
  });
});

describe("semantic candidate rejection", () => {
  it("rejects invalid semantic values, provenance, and absence", async () => {
    const invalidOperations: OperationCandidate[] = [
      { ...operation(), kind: "ATTACKER" as never },
      { ...operation("llm", undefined, 0, "LLM") },
      {
        ...operation("embedding", undefined, 0, "EMBEDDING"),
        name: "embedding-operation",
      },
      { ...operation(), name: "" },
      {
        ...operation(),
        nameProvenance: { field: "span.name", source: "process" as never },
      },
      {
        ...operation(),
        fields: [field("tag.tags", ["ok", 1] as never)] as never,
      },
      { ...operation(), fields: [field("llm.token_count.total", -1)] },
      { ...operation(), fields: [field("metadata", { raw: true } as never)] },
      { ...operation(), fields: [field("metadata", "not-json")] },
      { ...operation(), fields: [field("metadata", "[]")] },
      {
        ...operation(),
        unavailable: [
          {
            field: "span.name",
            source: "native-artifact",
            state: "unavailable",
            reason: "not-emitted",
          },
        ],
      },
      {
        ...operation(),
        unavailable: [
          {
            field: "span.trace_id",
            source: "native-artifact",
            state: "unavailable",
            reason: "not-emitted",
          },
        ],
      },
      {
        ...operation(),
        unavailable: [
          {
            field: "vcs.ref.head.name",
            source: "native-artifact",
            state: "unavailable",
            reason: "not-emitted",
          },
        ],
      },
      {
        ...operation(),
        unavailable: [
          {
            field: "llm.input_messages.0",
            source: "native-artifact",
            state: "unavailable",
            reason: "not-emitted",
          },
        ],
      },
    ];
    for (const invalid of invalidOperations) {
      await fixedFailure({ ...candidate(), operations: [invalid] });
    }
    const lifecycleBase = candidate();
    const lifecycleUnavailable: CapturedTraceCandidate = {
      ...lifecycleBase,
      rootContext: {
        fields: [],
        unavailable: [
          {
            field: "agentscope.redaction.policy_id",
            source: "native-artifact",
            state: "unavailable",
            reason: "not-emitted",
          },
        ],
      },
    };
    await fixedFailure(lifecycleUnavailable);

    const childRootOnlyBase = candidate();
    await fixedFailure({
      ...childRootOnlyBase,
      operations: [
        childRootOnlyBase.operations[0]!,
        {
          ...operation("child", "root", 1),
          fields: [field("agentscope.harness.name", "codex")],
        },
      ],
    });

    const duplicateContextBase = candidate();
    await fixedFailure({
      ...duplicateContextBase,
      rootContext: {
        fields: [field("input.value", "context")],
        unavailable: [],
      },
      operations: [
        {
          ...duplicateContextBase.operations[0]!,
          fields: [field("input.value", "operation")],
        },
      ],
    });
  });
});

describe("semantic absence pair rejection", () => {
  it("accepts every governed unavailable state family", async () => {
    const base = candidate();
    await expect(
      capture({
        ...base,
        operations: [
          {
            ...base.operations[0]!,
            unavailable: [
              {
                field: "input.value",
                source: "native-artifact",
                state: "observed-empty",
                reason: "empty-native-value",
              },
              {
                field: "output.value",
                source: "native-artifact",
                state: "not-applicable",
                reason: "not-applicable",
              },
              {
                field: "family.tool.activity",
                source: "native-artifact",
                state: "unavailable",
                reason: "unsupported",
              },
            ],
          },
        ],
      }),
    ).resolves.toSatisfy(isCapturedTrace);
  });

  it("rejects mismatched unavailable state and reason pairs", async () => {
    for (const unavailable of [
      {
        field: "family.tool.activity",
        source: "native-artifact" as const,
        state: "observed-empty" as const,
        reason: "not-emitted" as const,
      },
      {
        field: "family.tool.activity",
        source: "native-artifact" as const,
        state: "unavailable" as const,
        reason: "empty-native-value" as const,
      },
    ])
      await fixedFailure({
        ...candidate(),
        operations: [{ ...operation(), unavailable: [unavailable] }],
      });
  });
});

describe("harness timing authority", () => {
  it("rejects non-native bases, states, sources, and malformed points", async () => {
    const invalidTimings = [
      {
        basis: "native-point",
        nativeState: "observed",
        source: "native-artifact",
        startUnixNano: "1",
        endUnixNano: "2",
      },
      {
        basis: "hook-observed-point",
        nativeState: "unavailable",
        source: "process",
        startUnixNano: "1",
        endUnixNano: "1",
      },
      {
        basis: "artifact-point",
        nativeState: "unavailable",
        source: "native-artifact",
        startUnixNano: "1",
        endUnixNano: "1",
      },
      {
        basis: "hook-observed-point",
        nativeState: "observed",
        source: "process",
        startUnixNano: "1",
        endUnixNano: "1",
      },
    ];
    for (const timing of invalidTimings)
      await fixedFailure({
        ...candidate(),
        operations: [{ ...operation(), timing }],
      });
  });
});

describe("semantic claim uniqueness", () => {
  it("rejects duplicate field and unavailable claims", async () => {
    const base = candidate();
    const duplicate = field("input.value", "x");
    const unavailable = {
      field: "family.tool.activity",
      source: "native-artifact" as const,
      state: "observed-empty" as const,
      reason: "empty-native-value" as const,
    };
    const duplicateEventField = field("exception.message", "safe");
    for (const operationValue of [
      {
        ...base.operations[0]!,
        fields: [
          duplicate,
          { ...duplicate, provenance: { ...duplicate.provenance } },
        ],
      },
      {
        ...base.operations[0]!,
        unavailable: [unavailable, { ...unavailable }],
      },
      {
        ...base.operations[0]!,
        events: [
          {
            name: "exception",
            nameProvenance: {
              field: "span.event.name",
              source: "native-artifact" as const,
            },
            timeUnixNano: "1",
            timeProvenance: {
              field: "span.event.time_unix_nano",
              source: "native-artifact" as const,
            },
            fields: [
              duplicateEventField,
              {
                ...duplicateEventField,
                provenance: { ...duplicateEventField.provenance },
              },
            ],
          },
        ],
      },
    ])
      await fixedFailure({ ...base, operations: [operationValue] });
  });
});

describe("boundary candidate rejection", () => {
  it("rejects malformed boundary, session, locator, and snapshot values", async () => {
    const boundaries = [
      { ...candidate().captureBoundary, boundaryKind: "invalid" },
      { ...candidate().captureBoundary, positionKind: "invalid" },
      { ...candidate().captureBoundary, operationIdScope: "invalid" },
      { ...candidate().captureBoundary, generation: -1 },
      { ...candidate().captureBoundary, exclusiveEndPosition: 1.5 },
      {
        ...candidate().captureBoundary,
        startPosition: 2,
        exclusiveEndPosition: 2,
      },
      { ...candidate().captureBoundary, session: { kind: "invalid" } },
      {
        ...candidate().captureBoundary,
        session: {
          kind: "native-session",
          nativeIdentityKind: "codex-thread",
          nativeIdentity: "native-secret-session",
        },
      },
      {
        ...candidate().captureBoundary,
        session: { kind: "attempt-scoped", invocationNonce: "bad" },
      },
    ];
    for (const captureBoundary of boundaries)
      await fixedFailure({ ...candidate(), captureBoundary });

    for (const locator of [
      { kind: "invalid" },
      { kind: "native-operation", nativeId: "" },
      { kind: "source-ordinal", ordinal: -1 },
    ]) {
      const base = candidate();
      await fixedFailure({
        ...base,
        operations: [{ ...base.operations[0]!, locator }],
      });
    }
    for (const snapshot of [
      { configurationIdentity: "UPPER", policyIdentity: "policy.v1" },
      {
        configurationIdentity: "config.v1",
        policyIdentity: "bad space",
        redactionPolicy: { version: 1, mode: "baseline" },
      },
      {
        configurationIdentity: "config.v1",
        policyIdentity: resolvedPolicy("baseline").identity,
        redactionPolicy: resolvedPolicy("strict"),
      },
    ]) {
      await expect(
        withCaptureInvocation(
          { ...invocation(), snapshot } as never,
          (factory) => factory.capture(candidate()),
        ),
      ).rejects.toThrow(CapturedTraceError);
    }
    await expect(
      withCaptureInvocation(
        { ...invocation(), invocationNonce: "attacker" } as never,
        () => undefined,
      ),
    ).rejects.toThrow(CapturedTraceError);
    await expect(
      withCaptureInvocation(
        { ...invocation(), operationIdScope: "attacker" as never },
        () => undefined,
      ),
    ).rejects.toThrow(CapturedTraceError);
  });
});

describe("hostile plain-data preflight", () => {
  it("rejects proxies and accessors without invoking or leaking them", async () => {
    const canary = "CANARY_SECRET";
    let getterInvoked = false;
    const accessor = candidate();
    Object.defineProperty(accessor, "operations", {
      enumerable: true,
      get() {
        getterInvoked = true;
        throw new Error(canary);
      },
    });
    const proxy = new Proxy(candidate(), {
      ownKeys() {
        throw new Error(canary);
      },
    });
    for (const value of [accessor, proxy]) {
      try {
        await capture(value);
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(CapturedTraceError);
        expect(String(error)).not.toContain(canary);
      }
    }
    expect(getterInvoked).toBe(false);
  });

  it("rejects nonplain, cyclic, aliased, sparse, symbolic, and invalid values", async () => {
    const cyclic = candidate() as CapturedTraceCandidate & { self?: unknown };
    cyclic.self = cyclic;
    const shared = {
      field: "input.value",
      value: "x",
      provenance: { field: "input.value", source: "native-artifact" },
    };
    const aliasBase = candidate();
    const aliased: CapturedTraceCandidate = {
      ...aliasBase,
      operations: [
        { ...aliasBase.operations[0]!, fields: [shared, shared] as never },
      ],
    };
    const sparse: CapturedTraceCandidate = {
      ...candidate(),
      operations: new Array(1),
    };
    const symbolic = candidate();
    Object.defineProperty(symbolic, Symbol("hidden"), { value: "secret" });
    for (const value of [
      new Date(),
      new Map(),
      new Set(),
      Buffer.from("secret"),
      new Uint8Array([1]),
      cyclic,
      aliased,
      sparse,
      symbolic,
      { ...candidate(), invalid: undefined },
      { ...candidate(), invalid: 1n },
      { ...candidate(), invalid: Symbol("x") },
      { ...candidate(), invalid: () => undefined },
      { ...candidate(), invalid: Number.NaN },
      { ...candidate(), invalid: Number.POSITIVE_INFINITY },
    ]) {
      await fixedFailure(value);
    }
  });
});

describe("capture input budgets", () => {
  it("rejects deep, wide, oversized, and over-count inputs", async () => {
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 12; index += 1) deep = { child: deep };
    const tooDeep = candidate() as CapturedTraceCandidate & { extra?: unknown };
    tooDeep.extra = deep;
    const wide = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`key${index}`, index]),
    );
    const tooWide = candidate() as CapturedTraceCandidate & { extra?: unknown };
    tooWide.extra = wide;
    const largeBase = candidate();
    const tooLarge: CapturedTraceCandidate = {
      ...largeBase,
      operations: [{ ...largeBase.operations[0]!, name: "x".repeat(65_537) }],
    };
    const tooMany: CapturedTraceCandidate = {
      ...candidate(),
      operations: Array.from({ length: 257 }, (_, index) =>
        index === 0 ? operation() : operation(`child-${index}`, "root", index),
      ),
    };
    const largeKeys = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [
        `${String(index).padStart(3, "0")}${"k".repeat(4_100)}`,
        true,
      ]),
    );
    const tooManyKeyBytes = candidate() as CapturedTraceCandidate & {
      extra?: unknown;
    };
    tooManyKeyBytes.extra = largeKeys;
    const malformedArray = [operation()] as OperationCandidate[] & {
      extra?: string;
    };
    malformedArray.extra = "x";
    const notAnArray = { ...candidate(), operations: {} };
    const tooManyFieldsBase = candidate();
    const tooManyFields = {
      ...tooManyFieldsBase,
      operations: [
        {
          ...tooManyFieldsBase.operations[0]!,
          fields: Array.from({ length: 193 }, (_, index) =>
            field(`llm.token_count.prompt_details.custom_${index}`, index),
          ),
        },
      ],
    };
    const vectorBase = candidate();
    const tooManyVectorItems: CapturedTraceCandidate = {
      ...vectorBase,
      operations: [
        vectorBase.operations[0]!,
        {
          ...operation("embedding", "root", 1, "EMBEDDING"),
          fields: [
            field(
              "embedding.embeddings.0.embedding.vector",
              Array.from({ length: 8_193 }, () => 0.25),
            ),
          ],
        },
      ],
    };
    for (const value of [
      tooDeep,
      tooWide,
      tooLarge,
      tooMany,
      tooManyKeyBytes,
      { ...candidate(), operations: malformedArray },
      notAnArray,
      tooManyFields,
      tooManyVectorItems,
    ])
      await fixedFailure(value);
  });
});

describe("compile boundary", () => {
  it("exposes only the nominal candidate/factory contract", () => {
    expectTypeOf<HarnessCaptureFactory["capture"]>()
      .parameter(0)
      .toEqualTypeOf<CapturedTraceCandidate>();
    expectTypeOf<
      HarnessCaptureFactory["capture"]
    >().returns.not.toEqualTypeOf<CapturedTraceCandidate>();
  });

  it("publishes only root and type-only capture seams and has no lifecycle imports", () => {
    const captureDirectory = dirname(fileURLToPath(import.meta.url));
    const packageRoot = join(captureDirectory, "..", "..");
    const packageJson = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };
    expect(Object.keys(packageJson.exports)).toEqual([
      ".",
      "./harness-capture",
    ]);

    const productionSource = readdirSync(captureDirectory)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => readFileSync(join(captureDirectory, name), "utf8"))
      .join("\n");
    for (const forbidden of [
      '"node:fs"',
      '"node:http"',
      '"node:https"',
      "@agentscope/destinations",
      "RawSourcePointer",
      "NativeAgentTrace",
      "TraceBatch",
      "TraceSource",
      "TraceReporter",
    ])
      expect(productionSource).not.toContain(forbidden);
  });
});
