import { describe, expect, it } from "vitest";

import {
  isRedactedCanonicalTrace,
  serializeRedactedCanonicalTrace,
} from "@agentscope/protocol";

import type {
  CaptureInvocationContext,
  CapturedTraceCandidate,
  OperationCandidate,
} from "../capture/types.js";
import { withCaptureInvocation } from "../capture/runtime.js";
import { CoreRedactionError, redactCapturedTrace } from "./pipeline.js";
import {
  BUILTIN_REDACTION_POLICY_REFERENCES,
  compileRedactionPolicyRegistry,
  DEFAULT_REDACTION_POLICY_REGISTRY,
  resolveRedactionPolicy,
} from "./policy.js";

// Redaction pipeline evidence for AC-GOV-001.1, AC-GOV-001.2,
// AC-GOV-001.4, and AC-GOV-001.5.

const invocation = (
  mode: "baseline" | "strict" = "baseline",
): CaptureInvocationContext => {
  const policy = resolveRedactionPolicy(
    DEFAULT_REDACTION_POLICY_REGISTRY,
    BUILTIN_REDACTION_POLICY_REFERENCES[mode],
  );
  return {
    harnessRegistryId: "codex",
    harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
    snapshot: {
      configurationIdentity: "config.v1",
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
};

const operation = (
  logicalKey = "root",
  parentLogicalKey?: string,
  ordinal = 0,
): OperationCandidate => ({
  logicalKey,
  locator: { kind: "source-ordinal", ordinal },
  ...(parentLogicalKey === undefined ? {} : { parentLogicalKey }),
  kind: "AGENT",
  name: "agent-operation",
  nameProvenance: { field: "span.name", source: "native-artifact" },
  timing: {
    basis: "native-interval",
    nativeState: "observed",
    source: "native-artifact",
    startUnixNano: parentLogicalKey === undefined ? "1" : "3",
    endUnixNano: parentLogicalKey === undefined ? "20" : "4",
  },
  fields: [],
  unavailable: [],
  events: [],
  links: [],
});

const field = (
  semantic: string,
  value: string | number | readonly number[],
) => ({
  field: semantic,
  value,
  provenance: { field: semantic, source: "native-artifact" as const },
});

const candidate = (): CapturedTraceCandidate => ({
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
  operations: [operation()],
});

const capture = (
  value = candidate(),
  mode: "baseline" | "strict" = "baseline",
  context: CaptureInvocationContext["context"] = invocation(mode).context,
) =>
  withCaptureInvocation({ ...invocation(mode), context }, (factory) =>
    factory.capture(value),
  );

const coreContext = (
  fields: readonly Readonly<{ field: string; value: string }>[],
): CaptureInvocationContext["context"] => {
  const present = new Set(fields.map(({ field }) => field));
  return {
    fields: fields.map(({ field, value }) => ({
      field,
      value,
      provenance: {
        field,
        source:
          field === "agentscope.workspace.directory"
            ? ("process" as const)
            : ("git" as const),
      },
    })),
    unavailable: invocation().context.unavailable.filter(
      ({ field }) => !present.has(field),
    ),
  };
};

describe("descriptor-driven redaction pipeline", () => {
  it("constructs, validates, freezes, and brands a fresh canonical envelope", async () => {
    const trace = await capture();
    const result = redactCapturedTrace(trace);
    expect(isRedactedCanonicalTrace(result)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    const serialized = serializeRedactedCanonicalTrace(result);
    expect(serialized).toContain("agentscope.redaction.effective.v1.baseline");
    expect(serialized).not.toContain("thread-1");
  });

  it("composes user omission with baseline while retaining unaffected siblings", async () => {
    const policy = resolveRedactionPolicy(
      compileRedactionPolicyRegistry([
        {
          version: 1,
          reference: "omit-input-v1",
          mode: "baseline",
          rules: [
            {
              selector: { kind: "semantic-key", value: "input.value" },
              action: "omit",
            },
          ],
        },
      ]),
      "omit-input-v1",
    );
    const base = candidate();
    const captured = await withCaptureInvocation(
      {
        ...invocation(),
        snapshot: {
          configurationIdentity: "config.user-policy.v1",
          policyIdentity: policy.identity,
          redactionPolicy: policy,
        },
      },
      (factory) =>
        factory.capture({
          ...base,
          operations: [
            {
              ...base.operations[0]!,
              fields: [
                field("input.value", "safe input"),
                field("output.value", "safe output"),
              ],
            },
          ],
        }),
    );
    const serialized = serializeRedactedCanonicalTrace(
      redactCapturedTrace(captured),
    );
    expect(serialized).not.toContain("safe input");
    expect(serialized).toContain("safe output");
    expect(serialized).toContain(policy.identity);
  });
});

describe("feedback carrier redaction", () => {
  it("derives trusted inline and post-hoc feedback markers with evidence", async () => {
    for (const transport of ["inline", "post-hoc"] as const) {
      const base = candidate();
      const feedback: OperationCandidate = {
        ...operation("feedback", "root", 1),
        kind: "EVALUATOR",
        feedbackTransport: transport,
        fields: [
          field("annotations.0.annotation.name", "quality"),
          field("annotations.0.annotation.label", "good"),
        ],
        links:
          transport === "post-hoc"
            ? [
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
              ]
            : [],
      };
      const result = redactCapturedTrace(
        await capture({ ...base, operations: [base.operations[0]!, feedback] }),
      );
      const span = result.graph.resourceSpans[0]!.scopeSpans[0]!.spans[1]!;
      expect(
        span.attributes?.find(
          ({ key }) => key === "agentscope.feedback.transport",
        )?.value,
      ).toEqual({ stringValue: transport });
      const ledgerValue = span.attributes?.find(
        ({ key }) => key === "agentscope.mapping.provenance",
      )?.value;
      expect(ledgerValue).toHaveProperty("stringValue");
      expect(
        JSON.parse((ledgerValue as { stringValue: string }).stringValue),
      ).toContainEqual({
        field: "agentscope.feedback.transport",
        source: "derived",
      });
    }
  });

  it("constructs a standalone non-AGENT post-hoc feedback root", async () => {
    const standalone: OperationCandidate = {
      ...operation(),
      kind: "TOOL",
      feedbackTransport: "post-hoc",
      fields: [
        field("trace.evaluations.3.evaluation.name", "quality"),
        field("trace.evaluations.3.evaluation.score", 1),
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
    };
    const result = redactCapturedTrace(
      await capture({ ...candidate(), operations: [standalone] }),
    );
    const span = result.graph.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(
      span.attributes?.find(
        ({ key }) => key === "agentscope.feedback.transport",
      )?.value,
    ).toEqual({ stringValue: "post-hoc" });
  });

  it("merges root-context session identity into root feedback correlation", async () => {
    const result = redactCapturedTrace(
      await capture({
        ...candidate(),
        rootContext: {
          fields: [field("session.id", "session-123")],
          unavailable: [],
        },
        operations: [
          {
            ...operation(),
            feedbackTransport: "inline",
            fields: [
              field("session.annotations.2.annotation.name", "quality"),
              field("session.annotations.2.annotation.label", "good"),
            ],
          },
        ],
      }),
    );
    const root = result.graph.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(
      root.attributes?.find(({ key }) => key === "session.id")?.value,
    ).toEqual({ stringValue: "session-123" });
  });
});

describe("descriptor-driven redaction transformations", () => {
  it("replaces unsafe required names without losing safe topology", async () => {
    const base = candidate();
    const value = {
      ...base,
      operations: [{ ...base.operations[0]!, name: "password=CANARY_SECRET" }],
    };
    const trace = await capture(value);
    const serialized = serializeRedactedCanonicalTrace(
      redactCapturedTrace(trace),
    );
    expect(serialized).toContain('"name":"redacted"');
    expect(serialized).not.toContain("CANARY_SECRET");
  });

  it("derives a root envelope for descendants without native root timing", async () => {
    const { timing: rootTiming, ...rootWithoutTiming } = operation();
    void rootTiming;
    const value = {
      ...candidate(),
      operations: [rootWithoutTiming, operation("child", "root", 1)],
    };
    expect(
      isRedactedCanonicalTrace(redactCapturedTrace(await capture(value))),
    ).toBe(true);
  });

  it("preserves ordered event/link member evidence and injects link identities", async () => {
    const root = operation();
    const child = operation("child", "root", 1);
    const value = {
      ...candidate(),
      operations: [
        {
          ...root,
          events: [
            {
              name: "checkpoint",
              nameProvenance: {
                field: "span.event.name" as const,
                source: "hook-payload" as const,
              },
              timeUnixNano: "5",
              timeProvenance: {
                field: "span.event.time_unix_nano" as const,
                source: "hook-payload" as const,
              },
              fields: [],
            },
          ],
          links: [
            {
              target: {
                kind: "internal" as const,
                logicalOperationKey: "child",
              },
              targetProvenance: {
                field: "span.link.target" as const,
                source: "native-artifact" as const,
              },
              fields: [],
            },
          ],
        },
        child,
      ],
    };
    const result = redactCapturedTrace(await capture(value));
    const serialized = serializeRedactedCanonicalTrace(result);
    expect(serialized).toContain("span.events.0.event");
    expect(serialized).toContain("span.links.0.relationship");
    expect(serialized).toContain("span.links.target_ids");
  });
});

describe("descriptor-driven redaction context construction", () => {
  it("accounts for LLM, TOOL, error, resource, and transformed field families", async () => {
    const root = {
      ...operation(),
      fields: [field("error.type", "safe.error")],
    };
    const llm: OperationCandidate = {
      ...operation("llm", "root", 1),
      kind: "LLM",
      name: "model-call",
      fields: [
        field("llm.system", "openai"),
        field("llm.model_name", "model-safe"),
        field("llm.provider", "provider-safe"),
        field("llm.invocation_parameters", '{"temperature":0}'),
        field("llm.token_count.total", 5),
        field("image.url", "https://example.test/a.png?signature=removed"),
      ],
    };
    const tool: OperationCandidate = {
      ...operation("tool", "root", 2),
      kind: "TOOL",
      name: "safe-tool",
      fields: [field("tool.name", "safe-tool")],
    };
    const base = candidate();
    const value: CapturedTraceCandidate = {
      ...base,
      operations: [root, llm, tool],
    };
    const serialized = serializeRedactedCanonicalTrace(
      redactCapturedTrace(
        await capture(
          value,
          "baseline",
          coreContext([
            {
              field: "agentscope.workspace.directory",
              value: "workspace/project",
            },
            { field: "vcs.ref.head.revision", value: "abcdef1" },
            { field: "vcs.ref.head.name", value: "main" },
            { field: "vcs.ref.type", value: "branch" },
          ]),
        ),
      ),
    );
    expect(serialized).toContain("family.llm.usage");
    expect(serialized).toContain("family.tool.activity");
    expect(serialized).toContain("family.error.activity");
    expect(serialized).toContain("https://example.test/a.png");
    expect(serialized).not.toContain("signature=removed");
    expect(serialized).toContain(
      '{\\"field\\":\\"image.url\\",\\"source\\":\\"derived\\"}',
    );
    expect(serialized).toContain(
      '{\\"field\\":\\"llm.invocation_parameters\\",\\"source\\":\\"native-artifact\\"}',
    );
  });

  it("keeps redacted member holes and safe siblings without compacting indices", async () => {
    const root = {
      ...operation(),
      events: [
        {
          name: "password=CANARY_SECRET",
          nameProvenance: {
            field: "span.event.name" as const,
            source: "native-artifact" as const,
          },
          timeUnixNano: "3",
          timeProvenance: {
            field: "span.event.time_unix_nano" as const,
            source: "native-artifact" as const,
          },
          fields: [],
        },
        {
          name: "exception",
          nameProvenance: {
            field: "span.event.name" as const,
            source: "hook-payload" as const,
          },
          timeUnixNano: "4",
          timeProvenance: {
            field: "span.event.time_unix_nano" as const,
            source: "hook-payload" as const,
          },
          fields: [field("exception.message", "password=CANARY_SECRET")],
        },
      ],
    };
    const serialized = serializeRedactedCanonicalTrace(
      redactCapturedTrace(
        await capture({ ...candidate(), operations: [root] }),
      ),
    );
    expect(serialized).toContain("span.events.0.event");
    expect(serialized).toContain("span.events.1.event");
    expect(serialized).toContain("span.events.1.attributes.exception.message");
    expect(serialized).not.toContain("CANARY_SECRET");
  });
});

describe("descriptor-driven redaction policy and closure", () => {
  it("replaces strict-policy required names and rejects forged captures", async () => {
    const serialized = serializeRedactedCanonicalTrace(
      redactCapturedTrace(await capture(candidate(), "strict")),
    );
    expect(serialized).toContain('"name":"redacted"');
    expect(serialized).toContain(
      '\\"field\\":\\"span.name\\",\\"source\\":\\"derived\\"',
    );
    expect(() => redactCapturedTrace({} as never)).toThrow(CoreRedactionError);
  });

  it("records unavailable harness identity and hook-observed point timing", async () => {
    const context: CaptureInvocationContext = {
      ...invocation(),
      harnessVersion: {
        state: "unavailable",
        source: "process",
        reason: "not-emitted",
      },
    };
    const { timing, ...withoutTiming } = operation();
    void timing;
    const trace = await withCaptureInvocation(context, (factory) =>
      factory.capture({ ...candidate(), operations: [withoutTiming] }),
    );
    const serialized = serializeRedactedCanonicalTrace(
      redactCapturedTrace(trace),
    );
    expect(serialized).toContain("hook-observed-point");
    expect(serialized).toContain("agentscope.harness.version");
  });

  it("closes redacted VCS identities and canonicalizes repository URLs", async () => {
    const base = candidate();
    const value: CapturedTraceCandidate = {
      ...base,
      rootContext: {
        fields: [
          field("vcs.repository.url.full", "https://example.test/org/repo.git"),
          field("vcs.repository.name", "repo"),
        ],
        unavailable: [],
      },
    };
    const serialized = serializeRedactedCanonicalTrace(
      redactCapturedTrace(
        await capture(
          value,
          "baseline",
          coreContext([
            {
              field: "vcs.ref.head.revision",
              value: "password=CANARY_SECRET",
            },
            { field: "vcs.ref.head.name", value: "main" },
            { field: "vcs.ref.type", value: "branch" },
          ]),
        ),
      ),
    );
    expect(serialized).not.toContain("CANARY_SECRET");
    expect(serialized).not.toContain('vcs.ref.head.name\\",\\"value');
    expect(serialized).toContain("https://example.test/org/repo");
    expect(serialized).not.toContain("repo.git");
  });
});

describe("descriptor-driven redaction graph closure", () => {
  it("projects trusted local paths to safe repository-relative context", async () => {
    const serialized = serializeRedactedCanonicalTrace(
      redactCapturedTrace(
        await capture(
          candidate(),
          "baseline",
          coreContext([
            {
              field: "agentscope.workspace.directory",
              value: "/Users/alice/project/packages/core",
            },
            {
              field: "agentscope.git.worktree",
              value: "/Users/alice/project",
            },
            {
              field: "agentscope.git.repository_root",
              value: "/Users/alice/project",
            },
            { field: "vcs.ref.head.name", value: "main" },
            { field: "vcs.ref.head.revision", value: "a".repeat(40) },
            { field: "vcs.ref.type", value: "branch" },
          ]),
        ),
      ),
    );
    expect(serialized).toContain("packages/core");
    expect(serialized).not.toContain("/Users/alice");
    expect(serialized).toContain(
      '\\"field\\":\\"agentscope.workspace.directory\\",\\"source\\":\\"derived\\"',
    );
    const linkedWorktree = serializeRedactedCanonicalTrace(
      redactCapturedTrace(
        await capture(
          candidate(),
          "baseline",
          coreContext([
            {
              field: "agentscope.workspace.directory",
              value: "/Volumes/worktrees/project/packages/core",
            },
            {
              field: "agentscope.git.worktree",
              value: "/Volumes/worktrees/project",
            },
            {
              field: "agentscope.git.repository_root",
              value: "/Users/alice/project",
            },
            { field: "vcs.ref.head.name", value: "main" },
            { field: "vcs.ref.head.revision", value: "a".repeat(40) },
            { field: "vcs.ref.type", value: "branch" },
          ]),
        ),
      ),
    );
    expect(linkedWorktree).not.toContain("/Volumes/worktrees");
    expect(linkedWorktree).toContain("policy-redacted");
  });
});

describe("descriptor-driven redaction timing and family closure", () => {
  it("uses hook points for untimed children and suppresses a narrow native root", async () => {
    const child = operation("child", "root", 1);
    const { timing, ...untimedChild } = child;
    void timing;
    expect(
      isRedactedCanonicalTrace(
        redactCapturedTrace(
          await capture({
            ...candidate(),
            operations: [operation(), untimedChild],
          }),
        ),
      ),
    ).toBe(true);
    const narrowRoot = {
      ...operation(),
      timing: { ...operation().timing!, endUnixNano: "2" },
    };
    const trace = await capture({
      ...candidate(),
      operations: [narrowRoot, operation("child", "root", 1)],
    });
    expect(() => redactCapturedTrace(trace)).toThrow(CoreRedactionError);
  });

  it("accounts absent LLM evidence and an entirely omitted event collection", async () => {
    const llm: OperationCandidate = {
      ...operation("llm", "root", 1),
      kind: "LLM",
      name: "model-call",
      unavailable: [
        {
          field: "llm.system",
          source: "native-artifact",
          state: "unavailable",
          reason: "not-emitted",
        },
      ],
    };
    const root = {
      ...operation(),
      events: [
        {
          name: "password=CANARY_SECRET",
          nameProvenance: {
            field: "span.event.name" as const,
            source: "native-artifact" as const,
          },
          timeUnixNano: "3",
          timeProvenance: {
            field: "span.event.time_unix_nano" as const,
            source: "native-artifact" as const,
          },
          fields: [],
        },
      ],
    };
    const serialized = serializeRedactedCanonicalTrace(
      redactCapturedTrace(
        await capture({ ...candidate(), operations: [root, llm] }),
      ),
    );
    expect(serialized).toContain("span.events");
    expect(serialized).toContain("family.llm.usage");
    expect(serialized).not.toContain("CANARY_SECRET");
  });
});

describe("descriptor-driven redaction failure closure", () => {
  it.each([
    "openaiApiKey=CANARY_SECRET",
    "githubToken=CANARY_SECRET",
    "authToken=CANARY_SECRET",
    "sessionToken=CANARY_SECRET",
    "anthropicApiKey: CANARY_SECRET",
    "databasePassword=CANARY_SECRET",
    "dbPassword=CANARY_SECRET",
    "stripeToken=CANARY_SECRET",
    "serviceSecret=CANARY_SECRET",
    "credential=CANARY_SECRET",
    "files=[C:\\Users\\alice\\CANARY.txt]",
    "prefix,C:\\Users\\alice\\CANARY.txt",
    "prefix,file:///Users/alice/CANARY",
  ])("redacts sensitive assignment or path %s", async (value) => {
    const root = {
      ...operation(),
      fields: [field("input.value", value)],
    };
    const serialized = serializeRedactedCanonicalTrace(
      redactCapturedTrace(
        await capture({ ...candidate(), operations: [root] }),
      ),
    );
    expect(serialized).not.toContain("CANARY_SECRET");
    expect(serialized).toContain("policy-redacted");
  });

  it("redacts Core-supplied harness identity through the descriptor route", async () => {
    const context: CaptureInvocationContext = {
      ...invocation(),
      harnessVersion: {
        state: "observed",
        value: "accessToken=CANARY_SECRET",
        source: "process",
      },
    };
    const trace = await withCaptureInvocation(context, (factory) =>
      factory.capture(candidate()),
    );
    const serialized = serializeRedactedCanonicalTrace(
      redactCapturedTrace(trace),
    );
    expect(serialized).not.toContain("CANARY_SECRET");
    expect(serialized).toContain("agentscope.harness.version");
    expect(serialized).toContain("policy-redacted");
  });

  it("preserves mixed aggregate link relationship sources", async () => {
    const child = operation("child", "root", 1);
    const root = {
      ...operation(),
      links: ["native-artifact", "hook-payload"].map((source) => ({
        target: {
          kind: "internal" as const,
          logicalOperationKey: "child",
        },
        targetProvenance: {
          field: "span.link.target" as const,
          source: source as "native-artifact" | "hook-payload",
        },
        fields: [],
      })),
    };
    const serialized = serializeRedactedCanonicalTrace(
      redactCapturedTrace(
        await capture({
          ...candidate(),
          operations: [root, child],
        }),
      ),
    );
    expect(serialized).toContain("span.links.0.relationship");
    expect(serialized).toContain("span.links.1.relationship");
    expect(serialized).toContain("hook-payload");
    expect(serialized).toContain("native-artifact");
  });
});

describe("external link redaction authority", () => {
  it("preserves trusted external link IDs and their observed target evidence", async () => {
    const base = candidate();
    const traceId = "03".repeat(16);
    const spanId = "04".repeat(8);
    const result = redactCapturedTrace(
      await capture({
        ...base,
        operations: [
          {
            ...base.operations[0]!,
            links: [
              {
                target: { kind: "external", traceId, spanId },
                targetProvenance: {
                  field: "span.link.target",
                  source: "hook-payload",
                },
                fields: [],
              },
            ],
          },
        ],
      }),
    );
    const root = result.graph.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(root.links).toEqual([{ traceId, spanId, attributes: [] }]);
    const provenance = root.attributes?.find(
      ({ key }) => key === "agentscope.mapping.provenance",
    )?.value;
    expect(provenance).toHaveProperty("stringValue");
    const ledger = JSON.parse(
      (provenance as { stringValue: string }).stringValue,
    ) as { field: string; source: string }[];
    expect(ledger).toContainEqual({
      field: "span.links.0.target_ids",
      source: "hook-payload",
    });
    expect(ledger).toContainEqual({
      field: "span.links.0.link",
      source: "derived",
    });
  });
});

describe("descriptor-driven redaction failure closure", () => {
  it("omits a secret root field and retains a safe event sibling attribute", async () => {
    const root = {
      ...operation(),
      fields: [field("input.value", "password=CANARY_SECRET")],
      events: [
        {
          name: "exception",
          nameProvenance: {
            field: "span.event.name" as const,
            source: "native-artifact" as const,
          },
          timeUnixNano: "3",
          timeProvenance: {
            field: "span.event.time_unix_nano" as const,
            source: "native-artifact" as const,
          },
          fields: [field("exception.type", "SafeError")],
        },
      ],
    };
    const serialized = serializeRedactedCanonicalTrace(
      redactCapturedTrace(
        await capture({ ...candidate(), operations: [root] }),
      ),
    );
    expect(serialized).not.toContain("CANARY_SECRET");
    expect(serialized).toContain("SafeError");
  });

  it("preserves safe fields when the only error indicator is redacted", async () => {
    const root = {
      ...operation(),
      fields: [
        field("error.type", "accessToken=CANARY_SECRET"),
        field("input.value", "safe sibling"),
      ],
    };
    const serialized = serializeRedactedCanonicalTrace(
      redactCapturedTrace(
        await capture({ ...candidate(), operations: [root] }),
      ),
    );
    expect(serialized).not.toContain("CANARY_SECRET");
    expect(serialized).toContain("safe sibling");
    expect(serialized).toContain("family.error.activity");
    expect(serialized).toContain("policy-redacted");
  });
});

describe("descriptor-driven redaction ordering", () => {
  it("removes orphan VCS descriptions and orders mixed child times", async () => {
    const base = candidate();
    const childA = {
      ...operation("a", "root", 1),
      name: "a",
      timing: {
        ...operation("a", "root", 1).timing!,
        startUnixNano: "10",
        endUnixNano: "11",
      },
    };
    const childB = {
      ...operation("b", "root", 2),
      name: "b",
      timing: {
        ...operation("b", "root", 2).timing!,
        startUnixNano: "3",
        endUnixNano: "4",
      },
    };
    const childC = {
      ...operation("c", "root", 3),
      name: "c",
      timing: {
        ...operation("c", "root", 3).timing!,
        startUnixNano: "3",
        endUnixNano: "4",
      },
    };
    const value: CapturedTraceCandidate = {
      ...base,
      operations: [operation(), childB, childA, childC],
    };
    const serialized = serializeRedactedCanonicalTrace(
      redactCapturedTrace(
        await capture(
          value,
          "baseline",
          coreContext([{ field: "vcs.ref.head.name", value: "main" }]),
        ),
      ),
    );
    expect(serialized).toContain("resolution-failed");
    expect(serialized).not.toContain('\\"vcs.ref.head.name\\",\\"value');
    expect(serialized.indexOf('"name":"b"')).toBeLessThan(
      serialized.indexOf('"name":"a"'),
    );
    for (const operations of [
      [childA, childB, childC, operation()],
      [operation(), childC, childB, childA],
    ])
      expect(
        serializeRedactedCanonicalTrace(
          redactCapturedTrace(
            await capture(
              { ...value, operations },
              "baseline",
              coreContext([{ field: "vcs.ref.head.name", value: "main" }]),
            ),
          ),
        ),
      ).toBe(serialized);
  });
});
