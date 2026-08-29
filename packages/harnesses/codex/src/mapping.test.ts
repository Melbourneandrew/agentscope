import { describe, expect, it } from "vitest";

import { semanticProfileDescriptors } from "@agentscope/protocol";

import {
  CODEX_0_149_1_ROOT_HOOK_SCHEMA_AUTHORITY,
  CodexMappingError,
  decodeCodexRootHookInput,
  mapCodexSanitizedNativeObservation,
  type CodexMappedNativeObservation,
  type CodexSanitizedNativeObservation,
} from "./mapping.js";

const encoder = new TextEncoder();

const hookInput = (value: unknown): Uint8Array =>
  encoder.encode(JSON.stringify(value));

const completeHookInput = (
  value: Record<string, unknown> & { hook_event_name: string },
): Uint8Array => {
  const common = {
    cwd: "/untrusted/workspace",
    session_id: "session-1",
    transcript_path: null,
  };
  if (value.hook_event_name === "SessionStart")
    return hookInput({
      ...common,
      model: "component-model",
      permission_mode: "default",
      source: "startup",
      ...value,
    });
  if (value.hook_event_name === "Stop")
    return hookInput({
      ...common,
      last_assistant_message: null,
      model: "component-model",
      permission_mode: "default",
      stop_hook_active: false,
      turn_id: "turn-1",
      ...value,
    });
  return hookInput({
    ...common,
    reason: "other",
    ...value,
  });
};

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

// Core generically governs capture persistence for operation-unavailable data in
// packages/core/src/capture/runtime.test.ts. This package owns only the concrete
// Codex mapping fixture and proves its candidate/contract structural parity.
const expectUnavailableParity = (
  mapped: CodexMappedNativeObservation,
): void => {
  const key = (value: (typeof mapped.contract.unavailable)[number]): string =>
    JSON.stringify(value);
  const candidateUnavailable = [
    ...mapped.candidate.rootContext.unavailable,
    ...mapped.candidate.operations.flatMap(({ unavailable }) => unavailable),
  ];
  const candidateKeys = candidateUnavailable.map(key);
  const contractKeys = mapped.contract.unavailable.map(key);
  expect(new Set(candidateKeys).size).toBe(candidateKeys.length);
  expect(new Set(contractKeys).size).toBe(contractKeys.length);
  expect(candidateKeys.sort()).toEqual(contractKeys.sort());
};

const expectProtocolValidCandidateSemantics = (
  mapped: CodexMappedNativeObservation,
): void => {
  const descriptors = new Map(
    semanticProfileDescriptors.attributes.map((descriptor) => [
      descriptor.key,
      descriptor,
    ]),
  );
  for (const operation of mapped.candidate.operations) {
    const location =
      operation.parentLogicalKey === undefined ? "root-span" : "span";
    for (const { field } of [...operation.fields, ...operation.unavailable]) {
      const descriptor = descriptors.get(field);
      expect(descriptor?.locations).toContain(location);
      if (descriptor?.openInferenceKinds !== undefined)
        expect(descriptor.openInferenceKinds).toContain(operation.kind);
    }
  }
};

describe("Codex root hook schema authority", () => {
  it("pins the exact closed 0.149.1 root hook schema authority", () => {
    const authority = CODEX_0_149_1_ROOT_HOOK_SCHEMA_AUTHORITY;
    expect(authority.representativeVersion).toBe("0.149.1");
    expect(authority.sourceCommit).toBe(
      "ff29a44391deccde0aba0f8390337d7f3c319ea4",
    );
    expect(authority.schemas.SessionStart.sourceSha256).toBe(
      "690c0eef7c9f3ddcd41e24207b81b362101a300b4abec076b990a1cd79a66e20",
    );
    expect(authority.schemas.SessionStart.requiredKeys).toEqual([
      "cwd",
      "hook_event_name",
      "model",
      "permission_mode",
      "session_id",
      "source",
      "transcript_path",
    ]);
    expect(authority.schemas.Stop.sourceSha256).toBe(
      "7db4793c404b5c46b230c27b9507eb1a558fd958689d8715221c5dd81351a06a",
    );
    expect(authority.schemas.Stop.requiredKeys).toEqual([
      "cwd",
      "hook_event_name",
      "last_assistant_message",
      "model",
      "permission_mode",
      "session_id",
      "stop_hook_active",
      "transcript_path",
      "turn_id",
    ]);
    expect(authority.schemas.SessionEnd.sourceSha256).toBe(
      "23b1b69f92fa8ac29f8319478984b5aa5aaf09e5ca355ce90aa010452937e41c",
    );
    expect(authority.schemas.SessionEnd.requiredKeys).toEqual([
      "cwd",
      "hook_event_name",
      "reason",
      "session_id",
      "transcript_path",
    ]);
  });
});

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
        model: "component-model",
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
    const decoded = decodeCodexRootHookInput(completeHookInput(input));
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
});

describe("Codex closed hook schema", () => {
  it.each(["startup", "resume", "clear", "compact"])(
    "accepts the pinned SessionStart source %s",
    (source) => {
      expect(
        decodeCodexRootHookInput(
          completeHookInput({ hook_event_name: "SessionStart", source }),
        ).eventName,
      ).toBe("SessionStart");
    },
  );

  it.each(["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"])(
    "accepts the pinned permission mode %s",
    (permission_mode) => {
      expect(
        decodeCodexRootHookInput(
          completeHookInput({ hook_event_name: "Stop", permission_mode }),
        ).eventName,
      ).toBe("Stop");
    },
  );

  it("accepts the complete Stop nullable fields and boolean state", () => {
    expect(
      decodeCodexRootHookInput(
        completeHookInput({
          hook_event_name: "Stop",
          last_assistant_message: "bounded-message",
          stop_hook_active: true,
          transcript_path: "/untrusted/transcript.jsonl",
        }),
      ).transcriptAvailable,
    ).toBe(true);
  });

  it.each([
    { hook_event_name: "SessionStart", cwd: 42 },
    { hook_event_name: "SessionStart", permission_mode: "invalid" },
    { hook_event_name: "SessionStart", transcript_path: 42 },
    { hook_event_name: "SessionStart", transcript_path: "x".repeat(4_097) },
    { hook_event_name: "Stop", last_assistant_message: 42 },
    { hook_event_name: "Stop", stop_hook_active: "false" },
    { hook_event_name: "SessionEnd", reason: "shutdown" },
  ])("rejects a value outside the pinned schema %#", (value) => {
    expect(() => decodeCodexRootHookInput(completeHookInput(value))).toThrow(
      CodexMappingError,
    );
  });

  it("rejects missing, additional, and inherited closed-schema fields", () => {
    expect(() =>
      decodeCodexRootHookInput(
        completeHookInput({ hook_event_name: "Stop", extra: true }),
      ),
    ).toThrow(CodexMappingError);
    expect(() =>
      decodeCodexRootHookInput(
        hookInput({
          cwd: "/untrusted/workspace",
          hook_event_name: "SessionStart",
          model: "component-model",
          permission_mode: "default",
          source: "startup",
          transcript_path: null,
        }),
      ),
    ).toThrow(CodexMappingError);
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "session_id",
    );
    Object.defineProperty(Object.prototype, "session_id", {
      value: "inherited-session",
      configurable: true,
      writable: true,
    });
    let rejected = false;
    try {
      decodeCodexRootHookInput(
        hookInput({
          cwd: "/untrusted/workspace",
          hook_event_name: "SessionStart",
          model: "component-model",
          permission_mode: "default",
          source: "startup",
          transcript_path: null,
        }),
      );
    } catch (error) {
      rejected = error instanceof CodexMappingError;
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(Object.prototype, "session_id");
      else Object.defineProperty(Object.prototype, "session_id", previous);
    }
    expect(rejected).toBe(true);
  });
});

describe("Codex root hook input rejection", () => {
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

  it.each([
    '{"hook_event_name":"Stop","session_id":"session-1","session_id":"session-2","turn_id":"turn-1"}',
    '{"hook_event_name":"Stop","session_id":"session-1","turn_id":"turn-1","turn_id":"turn-2"}',
    '{"hook_event_name":"Stop","session_id":"session-1","turn_id":"turn-1","model":"a","model":"b"}',
    '{"hook_event_name":"Stop","session_id":"session-1","turn_id":"turn-1","extra":{"key":1,"key":2}}',
  ])("rejects duplicate keys before hook authority is branded", (raw) => {
    expect(() => decodeCodexRootHookInput(encoder.encode(raw))).toThrow(
      CodexMappingError,
    );
  });

  it("rejects inherited identity authority from a __proto__ member", () => {
    const raw =
      '{"hook_event_name":"Stop","__proto__":{"session_id":"session-1","turn_id":"turn-1","model":"component-model"}}';
    expect(() => decodeCodexRootHookInput(encoder.encode(raw))).toThrow(
      CodexMappingError,
    );
  });
});

describe("Codex hook parser prototype boundary", () => {
  it("rejects duplicate hook identity independently of mutable Set callbacks", () => {
    const previous = Object.getOwnPropertyDescriptor(Set.prototype, "has");
    let rejected = false;
    Object.defineProperty(Set.prototype, "has", {
      value: () => false,
      configurable: true,
      writable: true,
    });
    try {
      decodeCodexRootHookInput(
        encoder.encode(
          '{"hook_event_name":"Stop","session_id":"session-1","session_id":"session-2","turn_id":"turn-1"}',
        ),
      );
    } catch (error) {
      rejected = error instanceof CodexMappingError;
    } finally {
      if (previous === undefined)
        delete (Set.prototype as { has?: unknown }).has;
      else Object.defineProperty(Set.prototype, "has", previous);
    }
    expect(rejected).toBe(true);
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
    ]);
    expect(mapped.contract.provenance.map(({ field }) => field)).toContain(
      "llm.token_count.completion_details.reasoning",
    );
    expect(mapped.candidate.rootContext).toEqual({
      fields: [],
      unavailable: [],
    });
    expectUnavailableParity(mapped);
    expectProtocolValidCandidateSemantics(mapped);
  });

  it("encodes invocation parameters without inherited callbacks", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "toJSON",
    );
    let mapped: CodexMappedNativeObservation;
    Object.defineProperty(Object.prototype, "toJSON", {
      value: () => ({ prototypeCanary: true }),
      configurable: true,
      writable: true,
    });
    try {
      mapped = mapCodexSanitizedNativeObservation(observation(), checkpoint);
    } finally {
      if (previous === undefined)
        delete (Object.prototype as { toJSON?: unknown }).toJSON;
      else Object.defineProperty(Object.prototype, "toJSON", previous);
    }
    const invocationParameters = mapped.candidate.operations
      .flatMap(({ fields }) => fields)
      .find(({ field }) => field === "llm.invocation_parameters");
    expect(invocationParameters?.value).toBe('{"reasoning_effort":"medium"}');
  });
});

describe("Codex hook correlation", () => {
  it("claims hook model provenance only after exact native correlation", () => {
    const hook = decodeCodexRootHookInput(
      completeHookInput({
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
      const candidate = decodeCodexRootHookInput(completeHookInput(mismatch));
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

describe("Codex mapping prototype boundary", () => {
  it("retains unavailable and provenance ledgers without inherited array callbacks", () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "map");
    const previousNumeric = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "0",
    );
    let numericSetterCalls = 0;
    let mapped: CodexMappedNativeObservation;
    Object.defineProperty(Array.prototype, "map", {
      value: () => [],
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Array.prototype, "0", {
      set() {
        numericSetterCalls += 1;
      },
      configurable: true,
    });
    try {
      mapped = mapCodexSanitizedNativeObservation(
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
    } finally {
      if (previous === undefined)
        delete (Array.prototype as { map?: unknown }).map;
      else Object.defineProperty(Array.prototype, "map", previous);
      if (previousNumeric === undefined)
        Reflect.deleteProperty(Array.prototype, "0");
      else Object.defineProperty(Array.prototype, "0", previousNumeric);
    }
    expect(numericSetterCalls).toBe(0);
    expect(mapped.contract.unavailable).toHaveLength(9);
    expect(mapped.contract.provenance.length).toBeGreaterThan(0);
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
      completeHookInput({
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
    expectUnavailableParity(mapped);
    expectUnavailableParity(correlatedUnavailable);
    expectProtocolValidCandidateSemantics(mapped);
    expectProtocolValidCandidateSemantics(correlatedUnavailable);
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
    expect(mapped.contract.unavailable).toEqual([]);
    expect(
      mapped.candidate.operations.find(({ kind }) => kind === "LLM")
        ?.unavailable,
    ).toEqual(mapped.contract.unavailable);
    expectUnavailableParity(mapped);
    expectProtocolValidCandidateSemantics(mapped);
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
    ]);
    const root = mapped.candidate.operations.find(
      ({ logicalKey }) => logicalKey === "codex-turn",
    );
    const llm = mapped.candidate.operations.find(({ kind }) => kind === "LLM");
    expect(root?.unavailable).toEqual([]);
    expect(llm?.unavailable.map(({ field }) => field)).toEqual(["error.type"]);
    expectUnavailableParity(mapped);
    expectProtocolValidCandidateSemantics(mapped);
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
