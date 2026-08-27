import { createHash } from "node:crypto";

import type {
  HarnessInstallationPlanner,
  HarnessTargetInspection,
} from "@agentscope/harnesses-core";
import {
  deriveHarnessComponentEvidenceDigest,
  parseHarnessSanitizedFixture,
  type HarnessComponentContractAdapter,
  type HarnessComponentEvidence,
  type HarnessContractContextEvidence,
  type HarnessHookTestBehavior,
  type HarnessSanitizedFixture,
  type HarnessScenarioAdapter,
} from "@agentscope/harnesses-core/testing";

import {
  CODEX_COMPONENT_EVIDENCE_SLOT,
  CODEX_REPRESENTATIVE_VERSION,
  codexHarnessDescriptor,
} from "./descriptor.js";
import { createCodexInstallationPlanner } from "./installation.js";
import { mapCodexSanitizedNativeObservation } from "./mapping.js";

const componentSha256 = (value: unknown): `sha256-${string}` =>
  `sha256-${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

const contractOverlapSentinel = "vendor-observability-hook";
const contractDecoder = new TextDecoder("utf-8", { fatal: true });
const contractEncoder = new TextEncoder();
const governedContractOverlap = contractEncoder.encode(
  JSON.stringify({
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume|clear",
          hooks: [
            {
              type: "command",
              command: "'/vendor/bin/observability-hook'",
              timeout: 3,
              statusMessage: "Vendor observability",
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "'/vendor/bin/observability-hook'",
              timeout: 3,
              statusMessage: "Vendor observability",
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: "command",
              command: "'/vendor/bin/observability-hook'",
              timeout: 3,
              statusMessage: "Vendor observability",
            },
          ],
        },
      ],
    },
  }),
);

const isContractOverlapSentinel = (
  target: HarnessTargetInspection,
): boolean => {
  if (!target.exists || target.bytes === null) return false;
  try {
    return contractDecoder.decode(target.bytes) === contractOverlapSentinel;
  } catch {
    return false;
  }
};

const createContractInstallationPlanner: HarnessComponentContractAdapter["createInstallationPlanner"] =
  (operation, invocation): HarnessInstallationPlanner => {
    const productionPlanner = createCodexInstallationPlanner(
      operation,
      invocation,
    );
    return (target) =>
      productionPlanner(
        isContractOverlapSentinel(target)
          ? { ...target, bytes: governedContractOverlap }
          : target,
      );
  };

export const codexSanitizedFixture: HarnessSanitizedFixture =
  parseHarnessSanitizedFixture({
    fixtureVersion: 1,
    fixtureId: "codex-stop-v1",
    harnessId: "codex",
    harnessVersion: CODEX_REPRESENTATIVE_VERSION,
    governance: {
      provenance: {
        captureKind: "synthetic",
        sourceReference: "urn:agentscope:synthetic:codex-stop-v1",
        artifactAuthority: {
          status: "unresolved",
          reason: "independent-integrity-unavailable",
        },
        captureRecipe: "codex-synthetic-stop-v1",
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
        records: ["pending:privacy-review", "pending:redistribution-review"],
      },
      representative: {
        scenarioId: "codex-exec-jsonl-v1",
        representativeVersion: CODEX_REPRESENTATIVE_VERSION,
        evidenceSlot: CODEX_COMPONENT_EVIDENCE_SLOT,
      },
    },
    nativeIdentityKind: "session",
    nativeIdentity: "session-component-0001",
    sourceGeneration: 1,
    positionKind: "sequence",
    availableStartPosition: 7,
    boundaryKind: "turn",
    boundaryId: "turn-0008",
    exclusiveEndPosition: 11,
    expectedFields: [
      "error.type",
      "exception.message",
      "llm.invocation_parameters",
      "llm.model_name",
      "llm.provider",
      "llm.system",
      "llm.token_count.completion",
      "llm.token_count.completion_details.reasoning",
      "llm.token_count.prompt",
      "llm.token_count.total",
      "span.name",
      "tool.id",
      "tool.name",
    ],
    sanitizedPayload: {
      "input-units": 21,
      "output-units": 13,
      "error-present": false,
      "model-name": "gpt-5.2-codex",
      "model-provider": "openai",
      "model-system": "openai",
      "reasoning-level": "medium",
      "reasoning-units": 5,
      "tool-id": "tool-0001",
      "tool-name": "exec-command",
      "total-units": 34,
    },
  });

export const codexComponentScenario: HarnessScenarioAdapter = Object.freeze({
  scenarioVersion: 1,
  scenarioId: "codex-exec-jsonl-v1",
  harnessId: "codex",
  harnessPackage: codexHarnessDescriptor.harnessType,
  representativeVersion: CODEX_REPRESENTATIVE_VERSION,
  fixtureId: codexSanitizedFixture.fixtureId,
  tags: Object.freeze(["component", "synthetic", "native-mapping"]),
  commandArguments: Object.freeze(["exec", "--json", "component-contract"]),
});

export const codexContractContextEvidence: HarnessContractContextEvidence =
  Object.freeze({
    evidenceVersion: 1,
    mappingArtifactDigest: componentSha256({
      artifact: "codex-native-mapping",
      version: 1,
    }),
    contextDigest: componentSha256({
      blueprint: "codex-vendor-shell-containment-v1",
      officialSourceCommit: "ff29a44391deccde0aba0f8390337d7f3c319ea4",
      representativeVersion: CODEX_REPRESENTATIVE_VERSION,
    }),
  });

export const codexComponentEvidence: HarnessComponentEvidence = Object.freeze({
  evidenceVersion: 1,
  harnessType: codexHarnessDescriptor.harnessType,
  testedVersion: CODEX_REPRESENTATIVE_VERSION,
  fixtureId: codexSanitizedFixture.fixtureId,
  scenarioId: codexComponentScenario.scenarioId,
  evidenceSlot: CODEX_COMPONENT_EVIDENCE_SLOT,
  componentDigest: deriveHarnessComponentEvidenceDigest(
    codexSanitizedFixture,
    codexComponentScenario,
    codexHarnessDescriptor,
    codexContractContextEvidence,
  ),
});

const payloadString = (key: string): string => {
  const value = codexSanitizedFixture.sanitizedPayload[key];
  if (typeof value !== "string") throw new TypeError("codex.fixture.invalid");
  return value;
};

const payloadNumber = (key: string): number => {
  const value = codexSanitizedFixture.sanitizedPayload[key];
  if (typeof value !== "number") throw new TypeError("codex.fixture.invalid");
  return value;
};

const payloadBoolean = (key: string): boolean => {
  const value = codexSanitizedFixture.sanitizedPayload[key];
  if (typeof value !== "boolean") throw new TypeError("codex.fixture.invalid");
  return value;
};

const runSyntheticHook = async (
  behavior: HarnessHookTestBehavior,
  signal: AbortSignal,
): Promise<"completed" | "failed-open"> => {
  if (behavior === "success") return "completed";
  if (behavior === "failure" || signal.aborted) return "failed-open";
  await new Promise<void>((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
  return "failed-open";
};

export const codexComponentContractAdapter: HarnessComponentContractAdapter =
  Object.freeze({
    descriptor: codexHarnessDescriptor,
    componentEvidence: codexComponentEvidence,
    compatibleVersion: CODEX_REPRESENTATIVE_VERSION,
    fixture: codexSanitizedFixture,
    scenario: codexComponentScenario,
    contextEvidence: codexContractContextEvidence,
    mapFixture: (resolver) =>
      mapCodexSanitizedNativeObservation(
        {
          nativeIdentity: codexSanitizedFixture.nativeIdentity,
          sourceGeneration: codexSanitizedFixture.sourceGeneration,
          availableStartPosition: codexSanitizedFixture.availableStartPosition,
          boundaryId: codexSanitizedFixture.boundaryId,
          exclusiveEndPosition: codexSanitizedFixture.exclusiveEndPosition,
          modelSystem: payloadString("model-system"),
          modelProvider: payloadString("model-provider"),
          modelName: payloadString("model-name"),
          reasoningLevel: payloadString("reasoning-level"),
          promptTokens: payloadNumber("input-units"),
          completionTokens: payloadNumber("output-units"),
          reasoningTokens: payloadNumber("reasoning-units"),
          totalTokens: payloadNumber("total-units"),
          toolName: payloadString("tool-name"),
          toolId: payloadString("tool-id"),
          errorType: payloadBoolean("error-present") ? "component-error" : null,
        },
        resolver,
      ).contract,
    createInstallationPlanner: createContractInstallationPlanner,
    runHook: runSyntheticHook,
  });
