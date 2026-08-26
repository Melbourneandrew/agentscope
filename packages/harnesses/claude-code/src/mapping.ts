import {
  completeNativeCaptureBoundary,
  createNativeFieldProvenance,
  createNativeUnavailableField,
  resolveNativeCaptureStart,
  type NativeBoundaryKind,
  type NativeCheckpointResolver,
  type NativePositionKind,
} from "@agentscope/harnesses-core";
import type { NativeIdentityKind } from "@agentscope/protocol";

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
