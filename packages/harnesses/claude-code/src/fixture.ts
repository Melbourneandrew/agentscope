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
        "https://github.com/Melbourneandrew/agentscope/blob/7a2743b901ae43db1125b1ec8b87343207be16aa/packages/harnesses/core/NATIVE_FIXTURES.md#licenseref-agentscope-synthetic",
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
      records: [
        {
          role: "privacy",
          reviewTaskIdentity: "/root/claude_fixture_privacy_review",
          reviewExecutionIdentity: "01a04414-c0d1-7400-92c3-bcdb35e17cdd",
          reviewedHeadSha: "25dbf34b89725a7f0b2df6f1065dbd892c6eff5b",
          reviewedFixtureBlobSha: "e0283cb19c0e638099174c9cedb3e58c1e1439da",
          submittedAt: "2026-08-27T16:40:38.000Z",
          reference:
            "https://github.com/Melbourneandrew/agentscope/pull/94#pullrequestreview-5043279170",
        },
        {
          role: "redistribution",
          reviewTaskIdentity: "/root/claude_fixture_redistribution_review",
          reviewExecutionIdentity: "01a04419-599e-7ac0-9eb8-dee9cedc3679",
          reviewedHeadSha: "25dbf34b89725a7f0b2df6f1065dbd892c6eff5b",
          reviewedFixtureBlobSha: "e0283cb19c0e638099174c9cedb3e58c1e1439da",
          submittedAt: "2026-08-27T16:45:59.000Z",
          reference:
            "https://github.com/Melbourneandrew/agentscope/pull/94#pullrequestreview-5043329394",
        },
      ],
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
