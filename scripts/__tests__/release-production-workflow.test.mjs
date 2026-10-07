import { readFileSync } from "node:fs";
import { test, expect } from "vitest";
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
test("unimplemented admission stops before any token or API acquisition", () => {
  const entry = readFileSync(
    new URL("../record-release-stage.mjs", import.meta.url),
    "utf8",
  );
  expect(entry.indexOf("requireProductionAdmission();")).toBeLessThan(
    entry.indexOf("createGitHubReleaseStore({"),
  );
  expect(entry).toContain('throw new Error("release.admission.unimplemented")');
  expect(entry.indexOf("requireProductionAdmission();")).toBeLessThan(
    entry.indexOf("await prepareDraft("),
  );
});
