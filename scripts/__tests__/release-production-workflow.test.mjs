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
  expect(stage.if).toBe(
    "inputs.operation == 'consume-intent' || inputs.operation == 'consume-probe'",
  );
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
    "always() && (inputs.operation == 'consume-intent' || inputs.operation == 'consume-probe') && needs.prepare-draft.result == 'success'",
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
      w.jobs["record-stage"].steps.find(
        (s) => s.run === "node scripts/record-release-stage.mjs --record-stage",
      ).env.RELEASE_STAGE_RESULT = "${{ inputs.stage-tuple }}";
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
const requireProbeGraph = (workflow) => {
  expect(Object.keys(workflow.jobs)).toEqual([
    "verify-candidate",
    "prepare-draft",
    "stage-candidate",
    "record-stage",
  ]);
  expect(workflow.on.workflow_dispatch.inputs.operation.options).toEqual([
    "prepare-draft",
    "consume-intent",
    "prepare-probe",
    "consume-probe",
    "reconcile-probe",
  ]);
  expect(workflow.jobs["verify-candidate"].if).toContain("refs/heads/main");
  const verify = workflow.jobs["verify-candidate"].steps;
  const pack = verify.filter((step) => step.run?.startsWith("npm pack "));
  expect(pack).toHaveLength(1);
  expect(pack[0]).toEqual({
    if: "inputs.operation == 'prepare-probe'",
    run: "npm pack ./artifacts/release-probe-source --ignore-scripts --json --pack-destination ./artifacts/release-probe",
  });
  expect(workflow.jobs["prepare-draft"].if).toBe(
    "inputs.operation != 'prepare-probe'",
  );
  for (const name of ["stage-candidate", "record-stage"]) {
    const intent = workflow.jobs[name].steps.find(
      (step) =>
        step.with?.name === "release-probe-intent-${{ github.run_attempt }}",
    );
    expect(intent.uses).toBe(
      "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    );
    expect(intent.if).toBe("inputs.operation == 'consume-probe'");
    expect(intent.with).toEqual({
      name: "release-probe-intent-${{ github.run_attempt }}",
      path: "artifacts/retained-probe",
    });
  }
  const prepared = workflow.jobs["stage-candidate"].steps.find(
    (step) => step.with?.name === "release-inert-probe",
  );
  expect(prepared.with["run-id"]).toBe("${{ inputs.candidate-run-id }}");
  expect(prepared.if).toBe("inputs.operation == 'consume-probe'");
  for (const name of ["verify-candidate", "prepare-draft"]) {
    const retained = workflow.jobs[name].steps.find((step) =>
      step.with?.name?.startsWith("release-probe-stage-"),
    );
    expect(retained.if).toBe("inputs.operation == 'reconcile-probe'");
    expect(retained.with).toEqual({
      name: "release-probe-stage-${{ fromJSON(fromJSON(inputs.owner-observation).probePacket).runAttempt }}",
      path: "artifacts/reconciled-probe",
      "run-id": "${{ inputs.candidate-run-id }}",
      "github-token": "${{ github.token }}",
    });
  }
};
test("closed protected-main probe preparation uses the same stage/recorder, not another publisher", () => {
  requireProbeGraph(parse(source));
  for (const mutate of [
    (w) => {
      w.jobs["stage-candidate"].steps.find(
        (s) =>
          s.with?.name === "release-probe-intent-${{ github.run_attempt }}",
      ).with["run-id"] = "${{ inputs.candidate-run-id }}";
    },
    (w) => {
      w.jobs["verify-candidate"].steps.find((s) =>
        s.run?.startsWith("npm pack "),
      ).run = "npm pack --json";
    },
    (w) => {
      w.jobs["probe-publisher"] = w.jobs["stage-candidate"];
    },
    (w) => {
      w.jobs["prepare-draft"].steps.find((s) =>
        s.with?.name?.startsWith("release-probe-stage-"),
      ).with["run-id"] = "${{ github.run_id }}";
    },
  ]) {
    const workflow = parse(source);
    mutate(workflow);
    expect(() => requireProbeGraph(workflow)).toThrow();
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
