import {
  CLAUDE_CODE_COMPONENT_VERSION,
  CLAUDE_CODE_EVIDENCE_SLOT,
} from "./descriptor.js";

export const CLAUDE_CODE_FIXTURE_ID = "claude-code-lifecycle-v1" as const;
export const CLAUDE_CODE_SCENARIO_ID = "claude-code-print-v1" as const;

export const claudeCodeFixture = {
  fixtureVersion: 1,
  fixtureId: CLAUDE_CODE_FIXTURE_ID,
  harnessId: "claude-code",
  harnessVersion: CLAUDE_CODE_COMPONENT_VERSION,
  governance: {
    provenance: {
      captureKind: "synthetic",
      sourceReference: "urn:agentscope:synthetic:claude-code-lifecycle-v1",
      artifactAuthority: {
        status: "unresolved",
        reason: "independent-integrity-unavailable",
      },
      captureRecipe: "claude-code-lifecycle-v1",
    },
    license: {
      reviewedLicenseId: "LicenseRef-Agentscope-Synthetic",
      redistribution: "reviewed-for-repository",
      sourceReference:
        "https://github.com/Melbourneandrew/agentscope/blob/46080a0ecf1030dff425030b893e8d29d8c49a22/packages/harnesses/core/NATIVE_FIXTURES.md#licenseref-agentscope-synthetic",
    },
    redaction: {
      profileVersion: 1,
      classification: "sanitized-native-fixture",
      rawContentRetained: false,
      removedCategories: [
        "credentials",
        "raw-transcript",
        "terminal-output",
        "user-content",
        "user-paths",
      ],
    },
    review: {
      status: "approved",
      reviewedAt: "2026-08-26",
    },
    representative: {
      scenarioId: CLAUDE_CODE_SCENARIO_ID,
      representativeVersion: CLAUDE_CODE_COMPONENT_VERSION,
      evidenceSlot: CLAUDE_CODE_EVIDENCE_SLOT,
    },
  },
  nativeIdentityKind: "session",
  nativeIdentity: "claude-session-v1",
  sourceGeneration: 1,
  positionKind: "sequence",
  availableStartPosition: 0,
  boundaryKind: "session",
  boundaryId: "claude-session-v1",
  exclusiveEndPosition: 5,
  expectedFields: [
    "error.type",
    "llm.model_name",
    "llm.provider",
    "llm.system",
    "tool.id",
    "tool.name",
  ],
  sanitizedPayload: {
    hook_event_count: 5,
    interface: "print-stream-json",
    lifecycle: "session-turn-tool",
    model_provider: "anthropic",
  },
} as const;
