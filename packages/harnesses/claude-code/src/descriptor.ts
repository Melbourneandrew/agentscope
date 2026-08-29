import {
  defineHarnessDescriptor,
  type HarnessDescriptor,
} from "@agentscope/harnesses-core";

export const CLAUDE_CODE_COMPONENT_VERSION = "2.1.245" as const;
export const CLAUDE_CODE_EVIDENCE_SLOT =
  "claude-code-2-1-245-component" as const;

export const claudeCodeDescriptor: HarnessDescriptor = defineHarnessDescriptor({
  descriptorVersion: 1,
  harnessType: "@agentscope/harness-claude-code",
  executable: {
    names: ["claude"],
    versionArguments: ["--version"],
    versionPrefix: "",
    versionSuffix: " (Claude Code)",
  },
  configuration: {
    locationSegments: [[".claude", "settings.json"]],
  },
  compatibility: [
    {
      minimumInclusive: CLAUDE_CODE_COMPONENT_VERSION,
      maximumExclusive: "2.1.246",
      evidenceSlot: CLAUDE_CODE_EVIDENCE_SLOT,
    },
  ],
  nativeSource: {
    sourceKind: "claude-hook-lifecycle",
    continuityVersion: 1,
  },
});
