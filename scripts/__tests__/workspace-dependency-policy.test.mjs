import assert from "node:assert/strict";
import { test } from "vitest";
import { expectedInternalDependenciesFor } from "../verify-workspace-policy.mjs";

test("Codex keeps only its used inward workspace dependencies", () => {
  assert.deepEqual(
    expectedInternalDependenciesFor("@agentscope/harness-codex"),
    ["@agentscope/harnesses-core", "@agentscope/protocol"],
  );
});

test("the Codex exception does not weaken other concrete harnesses", () => {
  for (const harness of [
    "claude-code",
    "gemini-cli",
    "hermes",
    "opencode",
    "openclaw",
    "pi",
  ]) {
    assert.deepEqual(
      expectedInternalDependenciesFor(`@agentscope/harness-${harness}`),
      [
        "@agentscope/core",
        "@agentscope/harnesses-core",
        "@agentscope/protocol",
      ],
    );
  }
});
