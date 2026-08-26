export const claudeCodeHarnessPackageId =
  "@agentscope/harness-claude-code" as const;

export {
  CLAUDE_CODE_COMPONENT_VERSION,
  CLAUDE_CODE_EVIDENCE_SLOT,
  claudeCodeDescriptor,
} from "./descriptor.js";
export {
  CLAUDE_CODE_DOCUMENTED_INTERFACES,
  CLAUDE_CODE_INTERNAL_AUTH_SENTINEL,
  createClaudeCodeExecutionEnvironment,
  type ClaudeCodeExecutionEnvironment,
} from "./execution.js";
export {
  CLAUDE_CODE_LIFECYCLE_EVENTS,
  CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST,
  CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST,
  CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID,
  createClaudeCodeInstallationPlanner,
  inspectClaudeCodePluginOverlap,
  runClaudeCodeHook,
  type ClaudeCodeHookBehavior,
  type ClaudeCodeInstalledPlugin,
  type ClaudeCodePluginInventory,
  type ClaudeCodePluginOverlap,
  type ClaudeCodePluginSettingsLayer,
} from "./lifecycle.js";
export { claudeCodeContextEvidence, mapClaudeCodeFixture } from "./mapping.js";
