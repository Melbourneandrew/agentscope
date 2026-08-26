import { describe, expect, it } from "vitest";

import {
  isCapturedTrace,
  withCaptureInvocation,
} from "../../../core/dist/capture/runtime.js";
import {
  BUILTIN_REDACTION_POLICY_REFERENCES,
  DEFAULT_REDACTION_POLICY_REGISTRY,
  resolveRedactionPolicy,
} from "../../../core/dist/redaction/policy.js";
import {
  CodexMappingError,
  decodeCodexRootHookInput,
  mapCodexSanitizedNativeObservation,
  type CodexSanitizedNativeObservation,
} from "./mapping.js";

const encoder = new TextEncoder();

const hookInput = (value: unknown): Uint8Array =>
  encoder.encode(JSON.stringify(value));

const observation = (
  overrides: Partial<CodexSanitizedNativeObservation> = {},
): CodexSanitizedNativeObservation => ({
  nativeIdentity: "session-component-0001",
  sourceGeneration: 1,
  availableStartPosition: 7,
  boundaryId: "turn-0008",
  exclusiveEndPosition: 11,
  modelSystem: "openai",
  modelProvider: "openai",
  modelName: "gpt-5.2-codex",
  reasoningLevel: "medium",
  promptTokens: 21,
  completionTokens: 13,
  reasoningTokens: 5,
  totalTokens: 34,
  toolName: "exec-command",
  toolId: "tool-0001",
  errorType: null,
  ...overrides,
});

const checkpoint = ({
  availableStartPosition,
}: {
  availableStartPosition: number;
}) => ({
  disposition: "retained" as const,
  startPosition: availableStartPosition,
});

const captureInvocation = () => {
  const redactionPolicy = resolveRedactionPolicy(
    DEFAULT_REDACTION_POLICY_REGISTRY,
    BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
  );
  return {
    harnessRegistryId: "codex" as const,
    harnessVersion: {
      state: "observed" as const,
      value: "0.149.1",
      source: "process" as const,
    },
    snapshot: {
      configurationIdentity: "codex.component",
      policyIdentity: redactionPolicy.identity,
      redactionPolicy,
    },
    hookObservedUnixNano: "100",
    operationIdScope: "session-global" as const,
    context: {
      fields: [],
      unavailable: [
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
      ],
    },
  };
};

describe("Codex root hook input", () => {
  it.each([
    [
      {
        hook_event_name: "SessionStart",
        session_id: "session-1",
        source: "startup",
        transcript_path: "/untrusted/rollout.jsonl",
      },
      {
        eventName: "SessionStart",
        sessionId: "session-1",
        turnId: null,
        model: null,
        transcriptAvailable: true,
      },
    ],
    [
      {
        hook_event_name: "Stop",
        session_id: "session-1",
        turn_id: "turn-1",
        model: "component-model",
        transcript_path: null,
      },
      {
        eventName: "Stop",
        sessionId: "session-1",
        turnId: "turn-1",
        model: "component-model",
        transcriptAvailable: false,
      },
    ],
    [
      {
        hook_event_name: "SessionEnd",
        session_id: "session-1",
        reason: "other",
      },
      {
        eventName: "SessionEnd",
        sessionId: "session-1",
        turnId: null,
        model: null,
        transcriptAvailable: false,
      },
    ],
  ])("retains only bounded categorical root metadata", (input, expected) => {
    const decoded = decodeCodexRootHookInput(hookInput(input));
    expect(decoded).toEqual(expected);
    expect(decoded).not.toHaveProperty("transcript_path");
  });

  it.each([
    {},
    { hook_event_name: "PreToolUse", session_id: "session-1" },
    { hook_event_name: "Stop", session_id: "session-1" },
    {
      hook_event_name: "SessionStart",
      session_id: "session-1",
      source: "unknown",
    },
    {
      hook_event_name: "SessionEnd",
      session_id: "session-1",
      reason: "unknown",
    },
    {
      hook_event_name: "Stop",
      session_id: "Session With Spaces",
      turn_id: "turn-1",
    },
    {
      hook_event_name: "Stop",
      session_id: "session-1",
      turn_id: "turn-1",
      transcript_path: 42,
    },
  ])("rejects invalid lifecycle payload %#", (input) => {
    expect(() => decodeCodexRootHookInput(hookInput(input))).toThrow(
      CodexMappingError,
    );
  });

  it("rejects malformed, oversized, and subclassed byte input", () => {
    expect(() => decodeCodexRootHookInput(encoder.encode("{"))).toThrow(
      CodexMappingError,
    );
    expect(() => decodeCodexRootHookInput(new Uint8Array(65_537))).toThrow(
      CodexMappingError,
    );
    class HostileBytes extends Uint8Array {}
    expect(() => decodeCodexRootHookInput(new HostileBytes([1]))).toThrow(
      CodexMappingError,
    );
  });
});

describe("Codex native OpenInference mapping", () => {
  it("binds checkpoint identity, stable boundary, provenance, and unavailable fields", () => {
    let request: unknown;
    const mapped = mapCodexSanitizedNativeObservation(
      observation(),
      (input) => {
        request = input;
        return { disposition: "retained", startPosition: 8 };
      },
    );
    expect(request).toEqual({
      nativeIdentityKind: "session",
      nativeIdentity: "session-component-0001",
      sourceGeneration: 1,
      positionKind: "sequence",
      availableStartPosition: 7,
    });
    expect(mapped.contract.boundary).toEqual({
      session: {
        kind: "native-session",
        nativeIdentityKind: "session",
        nativeIdentity: "session-component-0001",
      },
      boundaryKind: "turn",
      boundaryId: "turn-0008",
      generation: 1,
      positionKind: "sequence",
      startPosition: 8,
      exclusiveEndPosition: 11,
    });
    expect(mapped.candidate.operations.map(({ kind }) => kind)).toEqual([
      "AGENT",
      "LLM",
      "TOOL",
    ]);
    expect(mapped.contract.unavailable).toEqual([
      {
        field: "error.type",
        source: "native-artifact",
        state: "unavailable",
        reason: "not-emitted",
      },
      {
        field: "exception.message",
        source: "native-artifact",
        state: "unavailable",
        reason: "not-emitted",
      },
    ]);
    expect(mapped.contract.provenance.map(({ field }) => field)).toContain(
      "llm.token_count.completion_details.reasoning",
    );
    expect(mapped.candidate.rootContext).toEqual({
      fields: [],
      unavailable: [],
    });
  });
});

describe("Codex Core runtime and hook correlation", () => {
  it("passes the real Core capture runtime validator", async () => {
    const mapped = mapCodexSanitizedNativeObservation(
      observation(),
      checkpoint,
    );
    const captured = await withCaptureInvocation(
      captureInvocation(),
      (factory) => factory.capture(mapped.candidate),
    );
    expect(isCapturedTrace(captured)).toBe(true);
  });

  it("claims hook model provenance only after exact native correlation", () => {
    const hook = decodeCodexRootHookInput(
      hookInput({
        hook_event_name: "Stop",
        session_id: "session-component-0001",
        turn_id: "turn-0008",
        model: "gpt-5.2-codex",
      }),
    );
    const mapped = mapCodexSanitizedNativeObservation(
      observation(),
      checkpoint,
      hook,
    );
    expect(
      mapped.contract.provenance.find(({ field }) => field === "llm.model_name")
        ?.source,
    ).toBe("hook-payload");

    for (const mismatch of [
      {
        hook_event_name: "Stop",
        session_id: "session-other",
        turn_id: "turn-0008",
        model: "gpt-5.2-codex",
      },
      {
        hook_event_name: "Stop",
        session_id: "session-component-0001",
        turn_id: "turn-other",
        model: "gpt-5.2-codex",
      },
      {
        hook_event_name: "Stop",
        session_id: "session-component-0001",
        turn_id: "turn-0008",
        model: "model-other",
      },
    ]) {
      const candidate = decodeCodexRootHookInput(hookInput(mismatch));
      expect(() =>
        mapCodexSanitizedNativeObservation(
          observation(),
          checkpoint,
          candidate,
        ),
      ).toThrow(CodexMappingError);
    }
    expect(() =>
      mapCodexSanitizedNativeObservation(observation(), checkpoint, {
        ...hook,
      }),
    ).toThrow(CodexMappingError);
  });
});

describe("Codex unavailable native metadata", () => {
  it("preserves unavailable model and usage families without fabrication", () => {
    const mapped = mapCodexSanitizedNativeObservation(
      observation({
        modelSystem: null,
        modelProvider: null,
        modelName: null,
        reasoningLevel: null,
        promptTokens: null,
        completionTokens: null,
        reasoningTokens: null,
        totalTokens: null,
      }),
      checkpoint,
    );
    const llm = mapped.candidate.operations.find(({ kind }) => kind === "LLM");
    expect(llm?.fields).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "llm.model_name" }),
        expect.objectContaining({ field: "llm.token_count.total" }),
      ]),
    );
    expect(mapped.contract.unavailable.map(({ field }) => field)).toEqual(
      expect.arrayContaining([
        "llm.system",
        "llm.provider",
        "llm.model_name",
        "llm.invocation_parameters",
        "llm.token_count.prompt",
        "llm.token_count.completion",
        "llm.token_count.completion_details.reasoning",
        "llm.token_count.total",
      ]),
    );
    const hook = decodeCodexRootHookInput(
      hookInput({
        hook_event_name: "Stop",
        session_id: "session-component-0001",
        turn_id: "turn-0008",
        model: "gpt-5.2-codex",
      }),
    );
    const correlatedUnavailable = mapCodexSanitizedNativeObservation(
      observation({
        modelSystem: null,
        modelProvider: null,
        modelName: null,
        reasoningLevel: null,
      }),
      checkpoint,
      hook,
    );
    expect(correlatedUnavailable.contract.provenance).not.toContainEqual(
      expect.objectContaining({
        field: "llm.model_name",
        source: "hook-payload",
      }),
    );
  });

  it("passes unavailable model and usage evidence through Core", async () => {
    const mapped = mapCodexSanitizedNativeObservation(
      observation({
        modelSystem: null,
        modelProvider: null,
        modelName: null,
        reasoningLevel: null,
        promptTokens: null,
        completionTokens: null,
        reasoningTokens: null,
        totalTokens: null,
      }),
      checkpoint,
    );
    const captured = await withCaptureInvocation(
      captureInvocation(),
      (factory) => factory.capture(mapped.candidate),
    );
    expect(isCapturedTrace(captured)).toBe(true);
  });

  it("maps a categorical native error without inventing a message", () => {
    const mapped = mapCodexSanitizedNativeObservation(
      observation({ errorType: "transport-failure" }),
      ({ availableStartPosition }) => ({
        disposition: "retained",
        startPosition: availableStartPosition,
      }),
    );
    expect(mapped.contract.provenance.map(({ field }) => field)).toContain(
      "error.type",
    );
    expect(mapped.contract.unavailable.map(({ field }) => field)).toEqual([
      "exception.message",
    ]);
  });

  it("records an unavailable tool family without inventing a tool operation", () => {
    const mapped = mapCodexSanitizedNativeObservation(
      observation({ toolName: null, toolId: null }),
      ({ availableStartPosition }) => ({
        disposition: "retained",
        startPosition: availableStartPosition,
      }),
    );
    expect(mapped.candidate.operations.map(({ kind }) => kind)).toEqual([
      "AGENT",
      "LLM",
    ]);
    expect(mapped.contract.unavailable.map(({ field }) => field)).toEqual([
      "error.type",
      "exception.message",
      "tool.name",
      "tool.id",
    ]);
  });
});

describe("Codex native mapping hostile boundaries", () => {
  it.each([
    observation({ totalTokens: 35 }),
    observation({ reasoningTokens: 14 }),
    observation({ exclusiveEndPosition: 7 }),
    observation({ promptTokens: -1 }),
    observation({ toolName: null }),
    observation({ modelName: null }),
    observation({ totalTokens: null }),
    { ...observation(), unexpected: true },
  ])("rejects an inconsistent or expanded native observation", (input) => {
    expect(() =>
      mapCodexSanitizedNativeObservation(input as never, () => ({
        disposition: "retained",
        startPosition: 7,
      })),
    ).toThrow(CodexMappingError);
  });

  it("rejects accessor observations without invoking the accessor", () => {
    let reads = 0;
    const input = observation() as Record<string, unknown>;
    Object.defineProperty(input, "modelName", {
      enumerable: true,
      get() {
        reads += 1;
        return "canary";
      },
    });
    expect(() =>
      mapCodexSanitizedNativeObservation(input as never, () => ({
        disposition: "retained",
        startPosition: 7,
      })),
    ).toThrow(CodexMappingError);
    expect(reads).toBe(0);
  });

  it("contains proxy failures behind the fixed mapping error", () => {
    const hostile = new Proxy(observation(), {
      getPrototypeOf() {
        throw new Error("CANARY");
      },
    });
    expect(() =>
      mapCodexSanitizedNativeObservation(hostile, () => ({
        disposition: "retained",
        startPosition: 7,
      })),
    ).toThrow(CodexMappingError);
  });
});
