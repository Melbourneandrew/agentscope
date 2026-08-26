import { createHash } from "node:crypto";

import {
  completeNativeCaptureBoundary,
  createNativeFieldProvenance,
  createNativeUnavailableField,
  resolveNativeCaptureStart,
  type NativeCheckpointResolver,
} from "@agentscope/harnesses-core";

import { claudeCodeFixture } from "./fixture.js";

const sha256 = (value: string): `sha256-${string}` =>
  `sha256-${createHash("sha256").update(value).digest("hex")}`;

const mappingArtifact = [
  "error.type:hook-payload:unavailable:not-applicable",
  "llm.model_name:native-artifact:unavailable:not-emitted",
  "llm.provider:hook-payload",
  "llm.system:hook-payload",
  "tool.id:hook-payload:unavailable:not-emitted",
  "tool.name:hook-payload",
].join("\n");

const adapterContext = [
  "claude-code:2.1.245",
  "hooks:SessionStart,PreToolUse,PostToolUse,Stop,SessionEnd",
  "interface:print:stream-json",
  "routing:internal-anthropic-base-url:synthetic-auth:nonessential-traffic-disabled",
  "transcript:supplementary-version-specific",
].join("\n");

export const claudeCodeContextEvidence = Object.freeze({
  evidenceVersion: 1 as const,
  mappingArtifactDigest: sha256(mappingArtifact),
  contextDigest: sha256(adapterContext),
});

export const mapClaudeCodeFixture = (resolver: NativeCheckpointResolver) => {
  const fixture = claudeCodeFixture;
  const start = resolveNativeCaptureStart(
    {
      nativeIdentityKind: fixture.nativeIdentityKind,
      nativeIdentity: fixture.nativeIdentity,
      sourceGeneration: fixture.sourceGeneration,
      positionKind: fixture.positionKind,
      availableStartPosition: fixture.availableStartPosition,
    },
    resolver,
  );
  return Object.freeze({
    boundary: completeNativeCaptureBoundary(start, {
      boundaryKind: fixture.boundaryKind,
      boundaryId: fixture.boundaryId,
      exclusiveEndPosition: fixture.exclusiveEndPosition,
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
