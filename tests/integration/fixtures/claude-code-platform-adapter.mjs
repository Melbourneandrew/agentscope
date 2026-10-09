import {
  createClaudeCodeExecutionEnvironment,
  decodeClaudeCodeRootHookInput,
} from "@agentscope/harness-claude-code";

export const claudeCodeInteractiveInvocation = (modelEndpoint) =>
  Object.freeze({
    executable: "/usr/local/bin/claude",
    // Present in the authenticated 2.1.245 interactive command definition.
    // This restricts tools without using print mode or bypassing permissions.
    arguments: Object.freeze([
      "--tools",
      "Read",
      "--allowedTools",
      "Read",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
    ]),
    environment: Object.freeze({
      ...createClaudeCodeExecutionEnvironment(modelEndpoint),
      AGENTSCOPE_HOME: "/agentscope-home",
      AGENTSCOPE_LANGFUSE_PUBLIC_KEY: "DUMMY_PUBLIC_KEY",
      AGENTSCOPE_LANGFUSE_SECRET_KEY: "DUMMY_SECRET_KEY",
      HOME: "/home/agentscope",
      CLAUDE_CONFIG_DIR: "/harness-home",
      NODE_EXTRA_CA_CERTS: "/opt/agentscope/collector-ca.pem",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      TERM: "xterm-256color",
    }),
  });

// Native payload validation belongs to the existing component decoder. This
// projection is observation only: a caller-supplied payload is not proof that
// the selected vendor process invoked the installed launcher.
export const translateClaudeCodeHookObservations = (payloads) => {
  if (!Array.isArray(payloads) || payloads.length > 128)
    throw new Error("integration.claude-code.adapter-observation");
  const hooks = payloads.map((bytes) => {
    const hook = decodeClaudeCodeRootHookInput(bytes);
    return Object.freeze({
      eventName: hook.eventName,
      sessionId: hook.sessionId,
      promptId: hook.promptId,
      toolName: hook.toolName,
      toolUseId: hook.toolUseId,
      stopHookActive: hook.stopHookActive,
      model: hook.model,
      durationMilliseconds: hook.durationMilliseconds,
    });
  });
  return Object.freeze(hooks);
};
