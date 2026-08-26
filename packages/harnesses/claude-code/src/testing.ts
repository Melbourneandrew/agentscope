import { createHash } from "node:crypto";

import {
  deriveHarnessComponentEvidenceDigest,
  type HarnessComponentContractAdapter,
  type HarnessContractContextEvidence,
  type HarnessFixtureMapping,
  type HarnessHookTestBehavior,
  type HarnessSanitizedFixture,
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
import { createClaudeCodeInstallationPlanner } from "./lifecycle.js";
import { mapClaudeCodeCapture } from "./mapping.js";

export {
  CLAUDE_CODE_FIXTURE_ID,
  CLAUDE_CODE_SCENARIO_ID,
  claudeCodeFixture,
} from "./fixture.js";

export type ClaudeCodeHookBehavior = "success" | "failure" | "hang";

type ExactType<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
type AssertTrue<Value extends true> = Value;
type ClaudeCodeHookBehaviorExact = AssertTrue<
  ExactType<ClaudeCodeHookBehavior, HarnessHookTestBehavior>
>;

export type ClaudeCodeHookBehaviorContract =
  ClaudeCodeHookBehaviorExact extends true ? ClaudeCodeHookBehavior : never;

const governedFixture: HarnessSanitizedFixture = claudeCodeFixture;

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
}) satisfies HarnessContractContextEvidence;

const governedFixtureMapping: (
  resolver: Parameters<HarnessComponentContractAdapter["mapFixture"]>[0],
) => HarnessFixtureMapping = (resolver) =>
  mapClaudeCodeCapture(claudeCodeFixture, resolver);

export const runClaudeCodeHook = async (
  behavior: ClaudeCodeHookBehavior,
  signal: AbortSignal,
): Promise<"completed" | "failed-open"> => {
  if (behavior === "success") return "completed";
  if (behavior === "failure" || signal.aborted) return "failed-open";
  return new Promise((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve("failed-open");
      },
      { once: true },
    );
  });
};

const sharedContractMarker = "vendor-observability-hook";
const markerDecoder = new TextDecoder();
const testingPluginInventory = Object.freeze({
  settingsLayers: Object.freeze([]),
  installedPlugins: Object.freeze([]),
});
const isSharedContractMarker = (bytes: Uint8Array | null): boolean =>
  bytes !== null && markerDecoder.decode(bytes) === sharedContractMarker;

const createTestingInstallationPlanner: HarnessComponentContractAdapter["createInstallationPlanner"] =
  (operation, invocation) => {
    const productionPlanner = createClaudeCodeInstallationPlanner(
      operation,
      invocation,
      testingPluginInventory,
    );
    const installPlanner = createClaudeCodeInstallationPlanner(
      "install",
      invocation,
      testingPluginInventory,
    );
    return (target) => {
      if (!isSharedContractMarker(target.bytes))
        return productionPlanner(target);
      if (operation === "uninstall") return { kind: "unchanged" };
      if (operation === "install") return { kind: "conflict" };
      return installPlanner({ ...target, exists: false, bytes: null });
    };
  };

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
    fixture: governedFixture,
    scenario: claudeCodeScenario,
    contextEvidence: claudeCodeContextEvidence,
    mapFixture: governedFixtureMapping,
    createInstallationPlanner: createTestingInstallationPlanner,
    runHook: runClaudeCodeHook,
  });
