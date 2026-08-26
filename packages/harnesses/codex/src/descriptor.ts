import {
  defineHarnessDescriptor,
  type HarnessDescriptor,
} from "@agentscope/harnesses-core";

export const CODEX_REPRESENTATIVE_VERSION = "0.149.1" as const;
export const CODEX_COMPONENT_EVIDENCE_SLOT = "codex-0-149-1" as const;

export const codexHarnessDescriptor: HarnessDescriptor =
  defineHarnessDescriptor({
    descriptorVersion: 1,
    harnessType: "@agentscope/harness-codex",
    executable: {
      names: ["codex"],
      versionArguments: ["--version"],
      versionPrefix: "codex-cli ",
      versionSuffix: "",
    },
    configuration: {
      locationSegments: [
        [".codex", "hooks.json"],
        [".codex", "config.toml"],
      ],
    },
    compatibility: [
      {
        minimumInclusive: CODEX_REPRESENTATIVE_VERSION,
        maximumExclusive: "0.149.2",
        evidenceSlot: CODEX_COMPONENT_EVIDENCE_SLOT,
      },
    ],
    nativeSource: {
      sourceKind: "codex-hook-json",
      continuityVersion: 1,
    },
  });
