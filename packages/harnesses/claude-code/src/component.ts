import {
  deriveHarnessComponentEvidenceDigest,
  type HarnessComponentContractAdapter,
  type HarnessScenarioAdapter,
} from "@agentscope/harnesses-core/testing";

import {
  CLAUDE_CODE_COMPONENT_VERSION,
  CLAUDE_CODE_EVIDENCE_SLOT,
  claudeCodeDescriptor,
} from "./descriptor.js";
import {
  CLAUDE_CODE_FIXTURE_ID,
  CLAUDE_CODE_SCENARIO_ID,
  claudeCodeFixture,
} from "./fixture.js";
import {
  createClaudeCodeInstallationPlanner,
  runClaudeCodeHook,
} from "./lifecycle.js";
import { claudeCodeContextEvidence, mapClaudeCodeFixture } from "./mapping.js";

export const claudeCodeScenario = Object.freeze({
  scenarioVersion: 1,
  scenarioId: CLAUDE_CODE_SCENARIO_ID,
  harnessId: "claude-code",
  harnessPackage: "@agentscope/harness-claude-code",
  representativeVersion: CLAUDE_CODE_COMPONENT_VERSION,
  fixtureId: CLAUDE_CODE_FIXTURE_ID,
  tags: Object.freeze(["claude-code", "print", "stream-json"]),
  commandArguments: Object.freeze([
    "-p",
    "--output-format",
    "stream-json",
    "--include-hook-events",
    "--setting-sources",
    "user",
  ]),
}) satisfies HarnessScenarioAdapter;

const componentDigest = deriveHarnessComponentEvidenceDigest(
  claudeCodeFixture,
  claudeCodeScenario,
  claudeCodeDescriptor,
  claudeCodeContextEvidence,
);

export const claudeCodeComponentAdapter: HarnessComponentContractAdapter =
  Object.freeze({
    descriptor: claudeCodeDescriptor,
    componentEvidence: Object.freeze({
      evidenceVersion: 1,
      harnessType: claudeCodeDescriptor.harnessType,
      testedVersion: CLAUDE_CODE_COMPONENT_VERSION,
      fixtureId: CLAUDE_CODE_FIXTURE_ID,
      scenarioId: CLAUDE_CODE_SCENARIO_ID,
      evidenceSlot: CLAUDE_CODE_EVIDENCE_SLOT,
      componentDigest,
    }),
    compatibleVersion: CLAUDE_CODE_COMPONENT_VERSION,
    fixture: claudeCodeFixture,
    scenario: claudeCodeScenario,
    contextEvidence: claudeCodeContextEvidence,
    mapFixture: mapClaudeCodeFixture,
    createInstallationPlanner: createClaudeCodeInstallationPlanner,
    runHook: runClaudeCodeHook,
  });
