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
  expect(recorder.needs).toEqual([
    "verify-candidate",
    "prepare-draft",
    "stage-candidate",
  ]);
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
    "verify-publication",
    "continue-publication",
  ]);
  expect(workflow.on.workflow_dispatch.inputs.operation.options).toEqual([
    "prepare-draft",
    "prepare-candidate",
    "consume-intent",
    "prepare-probe",
    "consume-probe",
    "reconcile-probe",
    "prepare-publication",
    "consume-publication",
    "record-approval",
    "continue-publication",
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
    "inputs.operation != 'prepare-candidate' && inputs.operation != 'prepare-probe' && inputs.operation != 'continue-publication'",
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
  expect(steps[0].env).toEqual({ GITHUB_TOKEN: "${{ github.token }}" });
};
test("semantic admission receives no administrative or publication credential", () => {
  requireNonprivilegedAdmission(parse(source));
  for (const replacement of [
    {},
    undefined,
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
test("missing actual semantic evidence stops before protected store mutation", () => {
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
  expect(entry).toContain("return requireActualSemanticAdmission(accepted)");
  expect(entry).toContain("bindScenarioEvidence(");
  expect(entry).toMatch(/"@agentscope\/harness-claude-code":\s*"claude-code"/u);
  expect(entry).toMatch(
    /readBounded\(\s*"tests\/integration\/capability-manifest.json"/u,
  );
  expect(entry).toContain('fixtureBytes: componentBytes("fixture")');
  expect(entry).toContain('adapterBytes: componentBytes("adapterArtifact")');
  expect(entry).toContain('mappingBytes: componentBytes("mappingArtifact")');
  expect(entry).not.toContain("requireActualSemanticAdmission(event.inputs");
  expect(
    entry.indexOf('process.argv[2] === "--verify-admission"'),
  ).toBeLessThan(entry.indexOf("createGitHubReleaseStore({"));
});

const requireSemanticAcquisition = (workflow) => {
  const steps = workflow.jobs["verify-candidate"].steps;
  const auth = steps.findIndex((step) => step.id === "admission-artifacts");
  expect(steps[auth].run).toBe(
    "node scripts/record-release-stage.mjs --prepare-admission",
  );
  expect(steps[auth].env).toEqual({ GITHUB_TOKEN: "${{ github.token }}" });
  const verify = steps.findIndex(
    (step) =>
      step.run === "node scripts/record-release-stage.mjs --verify-admission",
  );
  for (const [offset, output, path] of [
    [1, "candidate", "artifacts/semantic-candidate"],
    [2, "scenario", "artifacts/semantic-scenarios"],
  ]) {
    expect(auth + offset).toBeLessThan(verify);
    expect(steps[auth + offset].with).toEqual({
      "artifact-ids": `\${{ steps.admission-artifacts.outputs.${output}-artifact-id }}`,
      path,
      "run-id": "${{ inputs.candidate-run-id }}",
      "github-token": "${{ github.token }}",
      "merge-multiple": true,
    });
  }
  for (const job of Object.values(workflow.jobs))
    expect(
      job.steps.filter((step) => step.run === "pnpm build:release-admission"),
    ).toHaveLength(1);
};
test("bounded admission downloads immutable IDs before guard without publication credentials", () => {
  requireSemanticAcquisition(parse(source));
  for (const change of [
    (w) => {
      w.jobs["verify-candidate"].steps.find(
        (s) => s.name === "Download bounded scenario evidence",
      ).with["artifact-ids"] = "${{ inputs.stage-tuple }}";
    },
    (w) => {
      w.jobs["verify-candidate"].steps.find(
        (s) => s.name === "Download exact prepared candidate",
      ).with["run-id"] = "${{ github.run_id }}";
    },
    (w) => {
      w.jobs["verify-candidate"].steps.find(
        (s) => s.id === "admission-artifacts",
      ).env.GITHUB_TOKEN = "${{ secrets.NPM_TOKEN }}";
    },
  ]) {
    const workflow = parse(source);
    change(workflow);
    expect(() => requireSemanticAcquisition(workflow)).toThrow();
  }
});
test("Integration success retains only bounded existing files and preserves certification fan-in", () => {
  const integration = parse(
    readFileSync(
      new URL("../../.github/workflows/integration.yml", import.meta.url),
      "utf8",
    ),
  );
  const steps = integration.jobs["hermetic-platform"].steps;
  const success = steps.find(
    (step) => step.name === "Upload bounded successful scenario evidence",
  );
  expect(success.if).toBe("success()");
  expect(success.with.name).toBe(
    "integration-${{ matrix.shard.name }}-${{ matrix.replay }}",
  );
  expect(success.with["if-no-files-found"]).toBe("error");
  expect(success.with.path.trim().split("\n")).toEqual([
    "artifacts/integration/certification/replay-${{ matrix.replay }}.json",
    "artifacts/integration/harness-support-evidence.json",
    ...[
      "evidence",
      "harness-observation",
      "model-ledger",
      "destination-ledger",
      "fixture-lifecycle",
    ].map((name) => `artifacts/integration/runs/*/${name}.json`),
  ]);
  const failure = steps.find(
    (step) => step.name === "Upload sanitized failure evidence",
  );
  expect(failure.if).toBe(
    "failure() && steps.failure_evidence.outcome == 'success'",
  );
  expect(failure.with.name).toBe(success.with.name);
  const certification = steps.find(
    (step) => step.name === "Upload clean certification receipt",
  );
  expect(certification.with.path).toBe(
    "artifacts/integration/certification/replay-${{ matrix.replay }}.json",
  );
  expect(certification.with.name).toBe(
    "substrate-certification-replay-${{ matrix.replay }}-${{ github.sha }}",
  );
});

const requirePublicationSeparation = (workflow) => {
  const verify = workflow.jobs["verify-publication"];
  const publish = workflow.jobs["continue-publication"];
  expect(verify.permissions).toEqual({ contents: "read", actions: "read" });
  expect(verify.needs).toBe("verify-candidate");
  expect(verify.environment).toBeUndefined();
  expect(publish.permissions).toEqual({ contents: "write", actions: "read" });
  expect(publish.environment).toBe("npm-release");
  expect(publish.needs).toEqual(["verify-candidate", "verify-publication"]);
  for (const job of [verify, publish])
    expect(job.if).toBe(
      "inputs.operation == 'continue-publication' && github.ref == 'refs/tags/v0.1.0'",
    );
  const publisher = publish.steps.find(
    (step) => step.run === "node scripts/record-release-stage.mjs",
  );
  expect(publisher.env.RELEASE_REGISTRY_RESULT).toBe(
    "${{ needs.verify-publication.outputs.registry-result }}",
  );
  expect(JSON.stringify(publish)).not.toMatch(
    /--verify-publication|\bnpm (?:install|stage|publish)|id-token/u,
  );
  expect(verify.outputs).toEqual({
    "registry-result": "${{ steps.verify.outputs.registry-result }}",
  });
};
test("installed registry verification is separate from no-OIDC same-tag publication", () => {
  requirePublicationSeparation(parse(source));
  for (const mutate of [
    (w) => {
      w.jobs["verify-publication"].permissions.contents = "write";
    },
    (w) => {
      w.jobs["continue-publication"].permissions["id-token"] = "write";
    },
    (w) => {
      w.jobs["continue-publication"].if = "github.ref == 'refs/heads/main'";
    },
    (w) => {
      w.jobs["continue-publication"].steps.find(
        (s) => s.run === "node scripts/record-release-stage.mjs",
      ).env.RELEASE_REGISTRY_RESULT = "${{ inputs.owner-observation }}";
    },
  ]) {
    const workflow = parse(source);
    mutate(workflow);
    expect(() => requirePublicationSeparation(workflow)).toThrow();
  }
});

test("protected-main assembly retains the exact candidate before any protected job", () => {
  const workflow = parse(source);
  const verifier = workflow.jobs["verify-candidate"];
  expect(verifier.if).toContain('"prepare-candidate"');
  expect(verifier.environment).toBeUndefined();
  expect(verifier.permissions).toEqual({ contents: "read", actions: "read" });
  const upload = verifier.steps.find(
    (step) => step.with?.name === "release-certified-candidate",
  );
  expect(upload.if).toBe("inputs.operation == 'prepare-candidate'");
  expect(upload.with).toEqual({
    name: "release-certified-candidate",
    path: "artifacts/release-candidate",
    "if-no-files-found": "error",
  });
  expect(verifier.steps.indexOf(upload)).toBeGreaterThan(
    verifier.steps.findIndex((step) =>
      step.run?.endsWith("--verify-admission"),
    ),
  );
  expect(workflow.jobs["prepare-draft"].if).toContain(
    "inputs.operation != 'prepare-candidate'",
  );
  for (const name of [
    "prepare-draft",
    "stage-candidate",
    "record-stage",
    "verify-publication",
    "continue-publication",
  ]) {
    const steps = workflow.jobs[name].steps;
    const retained = steps.find(
      (step) => step.with?.path === "artifacts/release-candidate",
    );
    expect(retained.with["artifact-ids"]).toBe(
      "${{ needs.verify-candidate.outputs.candidate-artifact-id }}",
    );
    expect(retained.with["run-id"]).toBe("${{ inputs.candidate-run-id }}");
    expect(steps.some((step) => step.run?.endsWith("--prepare-semantic"))).toBe(
      true,
    );
    for (const path of [
      "artifacts/semantic-candidate",
      "artifacts/semantic-scenarios",
    ]) {
      const download = steps.find((step) => step.with?.path === path);
      expect(download.with["run-id"]).toBe(
        "${{ steps.semantic-artifacts.outputs.integration-run-id }}",
      );
      expect(download.if).toBe("github.ref == 'refs/tags/v0.1.0'");
    }
  }
});
