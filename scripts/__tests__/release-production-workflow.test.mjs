import { readFileSync } from "node:fs";
import { test, expect } from "vitest";
import { parse } from "yaml";
const source = readFileSync(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
test("durable candidate preparation has no npm or OIDC authority", () => {
  const writer = parse(source).jobs["prepare-draft"];
  expect(writer.permissions).toEqual({ contents: "write", actions: "read" });
  expect(JSON.stringify(writer)).not.toMatch(
    /npm (?:stage|publish)|NPM_TOKEN|id-token/u,
  );
  expect(source).toContain("group: agentscope-release-records");
  expect(source).toContain("cancel-in-progress: false");
  expect(source).toContain("environment: npm-release");
  expect(source).toContain("needs: verify-candidate");
  expect(source).toContain("refs/tags/v0.1.0");
  expect(source).toContain(
    "node scripts/record-release-stage.mjs --verify-admission",
  );
});
const requireSeparatedProductJobs = (workflow) => {
  const jobs = workflow.jobs;
  const stage = jobs["stage-candidate"];
  const recorder = jobs["record-stage"];
  expect(stage.permissions).toEqual({
    contents: "read",
    actions: "read",
    "id-token": "write",
  });
  expect(stage.environment).toBe("npm-release");
  expect(stage.needs).toEqual(["verify-candidate", "prepare-draft"]);
  expect(stage.if).toBe("inputs.operation == 'consume-intent'");
  expect(
    stage.steps.filter(
      (step) => step.run === "npm install -g npm@11.17.0 --ignore-scripts",
    ),
  ).toHaveLength(1);
  const producer = stage.steps.find((step) => step.id === "stage");
  expect(producer.run).toBe("node scripts/record-release-stage.mjs --stage");
  expect(producer.env).toEqual({
    GITHUB_TOKEN: "${{ github.token }}",
    RELEASE_INTENT_DIGEST: "${{ needs.prepare-draft.outputs.intent-digest }}",
  });
  expect(jobs["prepare-draft"].outputs).toEqual({
    "intent-digest": "${{ steps.record.outputs.intent-digest }}",
  });
  expect(stage.outputs).toEqual({
    "stage-result": "${{ steps.stage.outputs.stage-result }}",
  });
  expect(recorder.permissions).toEqual({ contents: "write", actions: "read" });
  expect(recorder.needs).toEqual(["prepare-draft", "stage-candidate"]);
  expect(recorder.if).toBe(
    "always() && inputs.operation == 'consume-intent' && needs.prepare-draft.result == 'success'",
  );
  const step = recorder.steps.find(
    (item) =>
      item.run === "node scripts/record-release-stage.mjs --record-stage",
  );
  expect(step.env).toEqual({
    GITHUB_TOKEN: "${{ github.token }}",
    RELEASE_INTENT_DIGEST: "${{ needs.prepare-draft.outputs.intent-digest }}",
    RELEASE_STAGE_RESULT: "${{ needs.stage-candidate.outputs.stage-result }}",
  });
  expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toHaveLength(10);
  expect(source).not.toContain("NPM_TOKEN");
};
test("fixed stage output reaches a separate no-OIDC recorder without dispatch authority", () => {
  requireSeparatedProductJobs(parse(source));
  for (const mutate of [
    (w) => {
      w.jobs["stage-candidate"].permissions.contents = "write";
    },
    (w) => {
      w.jobs["record-stage"].permissions["id-token"] = "write";
    },
    (w) => {
      w.jobs["stage-candidate"].needs = ["verify-candidate"];
    },
    (w) => {
      w.jobs["record-stage"].if = "success()";
    },
    (w) => {
      w.jobs["record-stage"].steps.at(-1).env.RELEASE_STAGE_RESULT =
        "${{ inputs.stage-tuple }}";
    },
    (w) => {
      w.jobs["stage-candidate"].steps.find(
        (s) => s.id === "stage",
      ).env.RELEASE_INTENT_DIGEST = "${{ inputs.expected-prior-digest }}";
    },
  ]) {
    const workflow = parse(source);
    mutate(workflow);
    expect(() => requireSeparatedProductJobs(workflow)).toThrow();
  }
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
