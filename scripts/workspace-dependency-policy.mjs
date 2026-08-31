const expectedInternalDependencies = new Map([
  [
    "agentscope-cli",
    [
      "@agentscope/core",
      "@agentscope/destination-langfuse",
      "@agentscope/destination-local-sqlite",
      "@agentscope/destinations-core",
      "@agentscope/harness-claude-code",
      "@agentscope/harness-codex",
      "@agentscope/harness-gemini-cli",
      "@agentscope/harness-hermes",
      "@agentscope/harness-opencode",
      "@agentscope/harness-openclaw",
      "@agentscope/harness-pi",
      "@agentscope/harnesses-core",
    ],
  ],
  ["@agentscope/docs", []],
  [
    "@agentscope/core",
    ["@agentscope/destinations-core", "@agentscope/protocol"],
  ],
  ["@agentscope/protocol", []],
  [
    "@agentscope/testkit",
    [
      "@agentscope/destinations-core",
      "@agentscope/harnesses-core",
      "@agentscope/protocol",
    ],
  ],
  ["@agentscope/destinations-core", ["@agentscope/protocol"]],
  [
    "@agentscope/destination-langfuse",
    ["@agentscope/destinations-core", "@agentscope/protocol"],
  ],
  [
    "@agentscope/destination-local-sqlite",
    ["@agentscope/destinations-core", "@agentscope/protocol"],
  ],
  ["@agentscope/harnesses-core", ["@agentscope/protocol"]],
  [
    "@agentscope/harness-codex",
    ["@agentscope/harnesses-core", "@agentscope/protocol"],
  ],
  ...["claude-code", "gemini-cli", "hermes", "opencode", "openclaw", "pi"].map(
    (harness) => [
      `@agentscope/harness-${harness}`,
      [
        "@agentscope/core",
        "@agentscope/harnesses-core",
        "@agentscope/protocol",
      ],
    ],
  ),
  ["@agentscope/integration", ["@agentscope/testkit"]],
]);

export function expectedInternalDependenciesFor(name) {
  return [...(expectedInternalDependencies.get(name) ?? [])].sort();
}
