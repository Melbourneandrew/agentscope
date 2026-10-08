import { readFileSync } from "node:fs";
import { test, expect } from "vitest";
import { parse } from "yaml";
const source = readFileSync(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
test("durable candidate preparation has no npm or OIDC authority", () => {
  expect(source).not.toContain("id-token:");
  expect(source).not.toMatch(/npm (?:stage|publish)|NPM_TOKEN/u);
  expect(source).toContain("group: agentscope-release-records");
  expect(source).toContain("cancel-in-progress: false");
  expect(source).toContain("environment: npm-release");
  expect(source).toContain("needs: verify-candidate");
  expect(source).toContain("refs/tags/v0.1.0");
  expect(source).toContain(
    "node scripts/record-release-stage.mjs --verify-admission",
  );
});
const requireNonprivilegedAdmission = (workflow) => {
  const job = workflow.jobs["verify-candidate"];
  expect(job.permissions).toEqual({ contents: "read", actions: "read" });
  const steps = job.steps.filter(
    (step) =>
      step.run === "node scripts/record-release-stage.mjs --verify-admission",
  );
  expect(steps).toHaveLength(1);
  expect(steps[0].env).toBeUndefined();
};
test("semantic admission receives no administrative or publication credential", () => {
  requireNonprivilegedAdmission(parse(source));
  for (const replacement of [
    {},
    { GITHUB_TOKEN: "${{ github.token }}" },
    { GITHUB_TOKEN: "${{ secrets.NPM_TOKEN }}" },
  ]) {
    const workflow = parse(source);
    const step = workflow.jobs["verify-candidate"].steps.find(
      (item) =>
        item.run === "node scripts/record-release-stage.mjs --verify-admission",
    );
    step.env = replacement;
    expect(() => requireNonprivilegedAdmission(workflow)).toThrow();
  }
  const writable = parse(source);
  writable.jobs["verify-candidate"].permissions.contents = "write";
  expect(() => requireNonprivilegedAdmission(writable)).toThrow();
});
test("missing actual semantic evidence stops before token or API acquisition", () => {
  const entry = readFileSync(
    new URL("../record-release-stage.mjs", import.meta.url),
    "utf8",
  );
  expect(entry.indexOf("requireActualSemanticAdmission();")).toBeLessThan(
    entry.indexOf("createGitHubReleaseStore({"),
  );
  expect(entry).toContain('from "./release-lane/admission.mjs"');
  expect(entry.indexOf("requireActualSemanticAdmission();")).toBeLessThan(
    entry.indexOf("await prepareDraft("),
  );
  expect(entry).not.toContain("inspectReleaseControls");
  expect(
    entry.indexOf('process.argv[2] === "--verify-admission"'),
  ).toBeLessThan(entry.indexOf("createGitHubReleaseStore({"));
});
