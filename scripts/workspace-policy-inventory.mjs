export const processAuthorityFiles = Object.freeze([
  "code-quality-policy.test.mjs",
  "native-ci-closure.test.mjs",
  "nx-cache-policy.test.mjs",
  "prepush.test.mjs",
  "pty-runtime-proof-controller.test.mjs",
  "review-skill.test.mjs",
  "workspace-target-policy.test.mjs",
]);

export const purePolicyFiles = Object.freeze([
  "acceptance-evidence.test.mjs",
  "cli-hook-artifact-budget.test.mjs",
  "documentation-policy.test.mjs",
  "native-ci-policy.test.mjs",
  "nx-cache-diagnostics.test.mjs",
  "packed-cli-retrieval-diagnostics.test.mjs",
  "release-lane-substrate.test.mjs",
  "restricted-import-policy.test.mjs",
  "workspace-cleanup-fixture.test.mjs",
  "workspace-dependency-policy.test.mjs",
  "workspace-policy-runner.test.mjs",
]);

export const requiredPolicyFiles = Object.freeze([
  ...purePolicyFiles,
  "code-quality-policy.test.mjs",
  "native-ci-closure.test.mjs",
  "nx-cache-policy.test.mjs",
  "review-skill.test.mjs",
  "workspace-target-policy.test.mjs",
]);
