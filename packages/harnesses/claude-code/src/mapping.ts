import {
  completeNativeCaptureBoundary,
  COMMON_NATIVE_SEMANTIC_FIELDS,
  createEphemeralCaptureBoundary,
  createNativeFieldProvenance,
  createNativeUnavailableField,
  resolveNativeCaptureStart,
  type NativeBoundaryKind,
  type NativeCheckpointResolver,
  type NativePositionKind,
} from "@agentscope/harnesses-core";
import type { NativeIdentityKind } from "@agentscope/protocol";
import {
  requireDecodedClaudeCodeRootHook,
  type ClaudeCodeRootHookInput,
} from "./root-hook.js";

export type ClaudeCodeNativeCapture = Readonly<{
  nativeIdentityKind: NativeIdentityKind;
  nativeIdentity: string;
  sourceGeneration: number;
  positionKind: NativePositionKind;
  availableStartPosition: number;
  boundaryKind: NativeBoundaryKind;
  boundaryId: string;
  exclusiveEndPosition: number;
}>;

export const mapClaudeCodeCapture = (
  capture: ClaudeCodeNativeCapture,
  resolver: NativeCheckpointResolver,
) => {
  const start = resolveNativeCaptureStart(
    {
      nativeIdentityKind: capture.nativeIdentityKind,
      nativeIdentity: capture.nativeIdentity,
      sourceGeneration: capture.sourceGeneration,
      positionKind: capture.positionKind,
      availableStartPosition: capture.availableStartPosition,
    },
    resolver,
  );
  return Object.freeze({
    boundary: completeNativeCaptureBoundary(start, {
      boundaryKind: capture.boundaryKind,
      boundaryId: capture.boundaryId,
      exclusiveEndPosition: capture.exclusiveEndPosition,
    }),
    provenance: Object.freeze([
      createNativeFieldProvenance("llm.provider", "hook-payload"),
      createNativeFieldProvenance("llm.system", "hook-payload"),
      createNativeFieldProvenance("tool.name", "hook-payload"),
    ]),
    unavailable: Object.freeze([
      createNativeUnavailableField({
        field: "error.type",
        source: "hook-payload",
        state: "not-applicable",
        reason: "not-applicable",
      }),
      createNativeUnavailableField({
        field: "llm.model_name",
        source: "native-artifact",
        state: "unavailable",
        reason: "not-emitted",
      }),
      createNativeUnavailableField({
        field: "tool.id",
        source: "hook-payload",
        state: "unavailable",
        reason: "not-emitted",
      }),
    ]),
  });
};

const hookField = (field: string, value: string) =>
  Object.freeze({
    field,
    value,
    provenance: createNativeFieldProvenance(field, "hook-payload"),
  });
const unavailableHookField = (field: string) =>
  createNativeUnavailableField({
    field,
    source: "hook-payload",
    state: "unavailable",
    reason: "not-emitted",
  });

export const mapClaudeCodeRootHookCapture = (
  input: ClaudeCodeRootHookInput,
) => {
  const hook = requireDecodedClaudeCodeRootHook(input);
  const tool = hook.toolName !== null && hook.toolUseId !== null;
  const response = hook.eventName === "Stop";
  const fields = tool
    ? [
        hookField("tool.name", hook.toolName),
        hookField("tool.id", hook.toolUseId),
        hookField("input.value", JSON.stringify(hook.toolInput)),
        hookField("input.mime_type", "application/json"),
        ...(hook.toolResponsePresent
          ? [
              hookField("output.value", JSON.stringify(hook.toolResponse)),
              hookField("output.mime_type", "application/json"),
            ]
          : []),
      ]
    : response && hook.assistantMessage !== null
      ? [hookField("output.value", hook.assistantMessage)]
      : [];
  const unavailable = response
    ? Object.values(COMMON_NATIVE_SEMANTIC_FIELDS)
        .filter((field) => field.startsWith("llm.") || field === "error.type")
        .map(unavailableHookField)
    : [];
  return Object.freeze({
    // These positions/locators describe one adapter observation, not vendor
    // transcript positions, a turn identity or a durable resume checkpoint.
    captureBoundary: createEphemeralCaptureBoundary({
      scope: "attempt-scoped",
      boundaryKind: "hook-invocation",
      boundaryId: "claude-hook",
      generation: 0,
      positionKind: "sequence",
      startPosition: 0,
      exclusiveEndPosition: 1,
    }),
    rootContext: Object.freeze({
      fields: Object.freeze([hookField("session.id", hook.sessionId)]),
      unavailable: Object.freeze([]),
    }),
    operations: Object.freeze([
      Object.freeze({
        logicalKey: "claude-observation",
        locator: tool
          ? Object.freeze({
              kind: "native-operation" as const,
              nativeId: `claude-tool:${hook.toolUseId}`,
            })
          : Object.freeze({ kind: "source-ordinal" as const, ordinal: 0 }),
        kind: tool
          ? ("TOOL" as const)
          : response
            ? ("LLM" as const)
            : ("AGENT" as const),
        name: tool ? hook.toolName : `claude.${hook.eventName}`,
        nameProvenance: createNativeFieldProvenance(
          "span.name",
          "hook-payload",
        ),
        fields: Object.freeze(fields),
        unavailable: Object.freeze(unavailable),
        events: Object.freeze([]),
        links: Object.freeze([]),
      }),
    ]),
  });
};
