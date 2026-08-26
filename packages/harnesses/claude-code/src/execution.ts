export const CLAUDE_CODE_INTERNAL_AUTH_SENTINEL =
  "DUMMY_INTERNAL_MOCK_TOKEN" as const;

export const CLAUDE_CODE_DOCUMENTED_INTERFACES = Object.freeze([
  Object.freeze({
    mode: "interactive" as const,
    outputContract: "semantic-pty" as const,
  }),
  Object.freeze({ mode: "print" as const, outputContract: "text" as const }),
  Object.freeze({ mode: "print" as const, outputContract: "json" as const }),
  Object.freeze({
    mode: "print" as const,
    outputContract: "stream-json" as const,
  }),
]);

export type ClaudeCodeExecutionEnvironment = Readonly<{
  ANTHROPIC_AUTH_TOKEN: typeof CLAUDE_CODE_INTERNAL_AUTH_SENTINEL;
  ANTHROPIC_BASE_URL: string;
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1";
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1";
  DISABLE_UPDATES: "1";
}>;

const internalHost = (hostname: string): boolean =>
  hostname === "127.0.0.1" ||
  hostname === "[::1]" ||
  hostname === "::1" ||
  hostname === "localhost" ||
  hostname.endsWith(".agentscope.internal");

export const createClaudeCodeExecutionEnvironment = (
  internalAnthropicBaseUrl: string,
): ClaudeCodeExecutionEnvironment => {
  let endpoint: URL;
  try {
    endpoint = new URL(internalAnthropicBaseUrl);
  } catch {
    throw new Error("claude-code.execution.internal-endpoint");
  }
  if (
    endpoint.protocol !== "http:" ||
    !internalHost(endpoint.hostname) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.pathname !== "/"
  )
    throw new Error("claude-code.execution.internal-endpoint");
  return Object.freeze({
    ANTHROPIC_AUTH_TOKEN: CLAUDE_CODE_INTERNAL_AUTH_SENTINEL,
    ANTHROPIC_BASE_URL: endpoint.origin,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
    DISABLE_UPDATES: "1",
  });
};
