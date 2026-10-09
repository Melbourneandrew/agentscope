import assert from "node:assert/strict";
import { test } from "vitest";
import { expectedInternalDependenciesFor } from "../workspace-dependency-policy.mjs";

test.each([
  [
    "@agentscope/harness-claude-code",
    ["@agentscope/harnesses-core", "@agentscope/protocol"],
  ],
  [
    "@agentscope/harness-gemini-cli",
    ["@agentscope/core", "@agentscope/harnesses-core", "@agentscope/protocol"],
  ],
  [
    "@agentscope/integration",
    [
      "@agentscope/destination-langfuse",
      "@agentscope/harnesses-core",
      "@agentscope/protocol",
      "@agentscope/testkit",
    ],
  ],
])("binds exact public dependency closure for %s", (name, dependencies) => {
  assert.deepEqual(expectedInternalDependenciesFor(name), dependencies);
});
