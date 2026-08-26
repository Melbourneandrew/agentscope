export {
  CODEX_COMPONENT_EVIDENCE_SLOT,
  CODEX_REPRESENTATIVE_VERSION,
  codexHarnessDescriptor,
} from "./descriptor.js";
export {
  CodexConfigurationError,
  createCodexInternalProviderConfiguration,
} from "./configuration.js";
export {
  CODEX_HOOK_CONFIGURATION_PATH,
  CodexInstallationError,
  createCodexInstallationPlanner,
  encodeCodexPosixHookCommand,
} from "./installation.js";
export {
  CodexMappingError,
  decodeCodexRootHookInput,
  mapCodexSanitizedNativeObservation,
  type CodexCapturedTraceCandidate,
  type CodexMappedNativeObservation,
  type CodexRootHookInput,
  type CodexSanitizedNativeObservation,
} from "./mapping.js";

export const codexHarnessPackageId = "@agentscope/harness-codex" as const;
