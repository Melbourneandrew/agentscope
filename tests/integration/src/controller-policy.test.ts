import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { runSupervisedProcess } from "../supervisor.mjs";
import { SUBSTRATE_CERTIFICATION_CASES } from "./substrate-certification.js";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const manifest = (path: string) =>
  JSON.parse(readFileSync(resolve(workspaceRoot, path), "utf8")) as {
    scripts: Record<string, string>;
  };
describe("integration controller policy", () => {
  it("exposes one integration command and no public stage aliases", () => {
    const root = manifest("package.json");
    const integration = manifest("tests/integration/package.json");
    expect(root.scripts["test:integration"]).toBe(
      "pnpm --filter @agentscope/integration integration",
    );
    expect(integration.scripts.integration).toBe("node controller.mjs");
    for (const name of [
      "prepare:candidate",
      "prepare:images",
      "prepare:model-routes",
      "run:scenarios",
      "test:integration:clean",
      "test:integration:runner",
    ]) {
      expect(root.scripts).not.toHaveProperty(name);
      expect(integration.scripts).not.toHaveProperty(name);
    }
  });

  it("removes the validation lease without creating an outer-host platform", () => {
    expect(
      existsSync(resolve(workspaceRoot, "scripts/validation-lease.py")),
    ).toBe(false);
    expect(
      existsSync(
        resolve(workspaceRoot, "scripts/__tests__/validation-lease.test.mjs"),
      ),
    ).toBe(false);
    const source = readFileSync(
      resolve(workspaceRoot, "tests/integration/src/controller.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /OIDC|attestation|bootstrap-manifest|PNPM_HOME|validation lease/iu,
    );
    expect(source).toMatch(
      /const dockerEndpoint =\s*`unix:\/\/\$\{realpathSync\("\/var\/run\/docker\.sock"\)\}`/u,
    );
    expect(source).toContain(
      'resolve(privateStorageParent, "agentscope-integration-controller-")',
    );
    expect(source).toContain("rootMode: 0o700");
  });

  it("does not retain workstation-local substrate evidence", () => {
    const evidenceRoot = resolve(workspaceRoot, "tests/integration/evidence");
    expect(existsSync(evidenceRoot) ? readdirSync(evidenceRoot) : []).toEqual(
      [],
    );
  });

  it("retains narrow cleanup ceilings for controller-owned artifacts", () => {
    const source = readFileSync(
      resolve(workspaceRoot, "tests/integration/clean.mjs"),
      "utf8",
    );
    expect(source).toContain(
      '"current-images.json": IMAGE_PREPARATION_LIMITS.maximumEvidenceBytes',
    );
    expect(source).toContain('"current-candidate.json": 16_384');
    expect(source).toContain('"current-model-routes.json": 16_384');
    expect(source).toContain('"current-selection.json": 16_384');
    expect(source).toContain(
      "const addFile = (targets, relative, maximumBytes = 16_384)",
    );
    expect(source).toContain("requiredFailureEvidence.has(runId)");
    expect(source).toContain(
      "assertFailureEvidence(failureEvidenceByRunId.get(runId))",
    );
    expect(source).toContain("failureEvidenceCoverageIsExact(");
  });

  it("rejects direct execution of every mutation stage", () => {
    for (const stage of [
      "clean.mjs",
      "maintain-artifacts.mjs",
      "prepare-cli.mjs",
      "prepare-images.mjs",
      "prepare-model-routes.mjs",
      "run-scenarios.mjs",
      "select.mjs",
    ]) {
      const result = spawnSync(process.execPath, [stage], {
        cwd: resolve(workspaceRoot, "tests/integration"),
        encoding: "utf8",
        env: { LANG: "C.UTF-8", PATH: process.env.PATH },
      });
      expect(result.status, stage).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`, stage).toContain(
        "integration.outer-host.capability-required",
      );
    }
  });
});

describe("integration controller supervision", () => {
  it("kills and proves absence of descendants after the leader exits", async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(resolve(tmpdir(), "agentscope-supervisor-"));
    const evidence = resolve(directory, "descendant.pid");
    try {
      const result = await runSupervisedProcess({
        arguments_: [
          resolve(
            workspaceRoot,
            "tests/integration/fixtures/stubborn-controller-child.mjs",
          ),
        ],
        environment: {
          AGENTSCOPE_SUPERVISOR_EVIDENCE: evidence,
          LANG: "C.UTF-8",
          PATH: "/usr/bin:/bin",
        },
        executable: process.execPath,
        maximumMilliseconds: 5_000,
        stdio: "ignore",
      });
      expect(result).toMatchObject({
        code: 1,
        contained: true,
        residualWorkObserved: true,
      });
      const descendant = Number(readFileSync(evidence, "utf8"));
      expect(() => process.kill(descendant, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("does not upgrade a successful leader with residual work", async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(resolve(tmpdir(), "agentscope-supervisor-"));
    const evidence = resolve(directory, "descendant.pid");
    try {
      const result = await runSupervisedProcess({
        arguments_: [
          resolve(
            workspaceRoot,
            "tests/integration/fixtures/stubborn-controller-child.mjs",
          ),
        ],
        environment: {
          AGENTSCOPE_SUPERVISOR_EVIDENCE: evidence,
          AGENTSCOPE_SUPERVISOR_LEADER_EXIT: "0",
          LANG: "C.UTF-8",
          PATH: "/usr/bin:/bin",
        },
        executable: process.execPath,
        maximumMilliseconds: 5_000,
        stdio: "ignore",
      });
      expect(result).toMatchObject({
        code: 0,
        contained: true,
        residualWorkObserved: true,
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

// The workflow policy inventory is kept in one closed review surface.
// eslint-disable-next-line max-lines-per-function
describe("integration workflow policy", () => {
  it("routes candidate, clean replay, and controlled rejection through one command", () => {
    const workflow = readFileSync(
      resolve(workspaceRoot, ".github/workflows/integration.yml"),
      "utf8",
    );
    expect(workflow.match(/pnpm test:integration/gu)).toHaveLength(3);
    expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(4);
    expect(
      workflow.match(/NPM_CONFIG_GLOBALCONFIG=.*agentscope-global\.npmrc/gu),
    ).toHaveLength(3);
    expect(
      workflow.match(/NPM_CONFIG_USERCONFIG=.*agentscope-user\.npmrc/gu),
    ).toHaveLength(3);
    expect(
      workflow.match(/Initialize closed npm configuration/gu),
    ).toHaveLength(3);
    expect(workflow).not.toMatch(/\$\{\{ runner\.temp \}\}/gu);
    expect(
      workflow.match(/AGENTSCOPE_INTEGRATION_OUTER_DEADLINE_MONOTONIC_MS/gu),
    ).toHaveLength(3);
    expect(workflow).not.toMatch(
      /prepare:candidate|prepare:images|prepare:model-routes|run:scenarios|test:integration:clean/gu,
    );
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).not.toContain("if-no-files-found: ignore");
    expect(workflow).toContain("Verify complete sanitized failure evidence");
    expect(workflow).toContain("id: failure_evidence");
    expect(workflow).toContain(
      "if: failure() && steps.failure_evidence.outcome == 'success'",
    );
    expect(workflow).toContain(
      "artifacts/integration/controller-failure-manifest.json",
    );
    expect(workflow).toContain(
      "artifacts/integration/runs/*/controller-failure.json",
    );
    expect(workflow).toContain("replay: [1, 2, 3]");
    expect(workflow).toContain(
      "node tests/integration/verify-substrate-certification.mjs failure",
    );
    expect(workflow).toContain("continue-on-error: true");
    expect(workflow).toContain(
      'test "$CONTROLLED_REJECTION_OUTCOME" = failure',
    );
    expect(workflow).toContain(
      "node tests/integration/verify-substrate-certification.mjs negative",
    );
    expect(workflow).toContain(
      "export OPENAI_API_KEY=AGENTSCOPE_SYNTHETIC_CANARY",
    );
    expect(workflow).toContain(
      "artifacts/integration/controller-preflight-failure.json",
    );
    expect(workflow).toContain(
      "node tests/integration/verify-substrate-certification.mjs fan-in",
    );
    for (const certificationCase of SUBSTRATE_CERTIFICATION_CASES)
      expect(workflow).toContain(`          - ${certificationCase}`);
    const scenarios = readFileSync(
      resolve(workspaceRoot, "tests/integration/run-scenarios.mjs"),
      "utf8",
    );
    const finalized = scenarios.indexOf(
      "finalizeControllerFailureEvidence(plan",
    );
    const required = scenarios.indexOf(
      "requireIntegrationFailureEvidence(plans.map",
    );
    const propagated = scenarios.indexOf("throw primaryError");
    const manifest = scenarios.lastIndexOf("publishControllerFailureManifest");
    const readinessReleased = scenarios.lastIndexOf("fixtureResults.delete");
    expect(required).toBeGreaterThanOrEqual(0);
    expect(finalized).toBeGreaterThan(required);
    expect(manifest).toBeGreaterThan(finalized);
    expect(readinessReleased).toBeGreaterThan(manifest);
    expect(finalized).toBeGreaterThanOrEqual(0);
    expect(propagated).toBeGreaterThan(finalized);
  });

  it("rejects partial current-run failure evidence before upload", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "agentscope-evidence-"));
    const artifacts = resolve(directory, "artifacts/integration");
    const runIds = ["0123456789abcdef", "fedcba9876543210"].sort();
    try {
      const failureEvidence = runIds.map((runId) => {
        const run = resolve(artifacts, "runs", runId);
        mkdirSync(run, { recursive: true, mode: 0o700 });
        const path = resolve(run, "controller-failure.json");
        const content = `${JSON.stringify({
          controllerFailureEvidenceVersion: 2,
          runId,
          certificationCase: null,
          certificationPredicate: null,
          certificationReadiness: null,
          scenarioOutcome: "not-complete",
          controllerOutcome: "retired-failure",
          primaryFailure: "integration.controller.failed",
          cleanupFailure: null,
          installedPtyFailure: null,
          privateCleanup: null,
        })}\n`;
        writeFileSync(path, content, { mode: 0o600 });
        const status = lstatSync(path);
        return {
          dev: status.dev,
          digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
          ino: status.ino,
          runId,
          size: status.size,
        };
      });
      writeFileSync(
        resolve(artifacts, "controller-failure-manifest.json"),
        `${JSON.stringify({
          controllerFailureManifestVersion: 1,
          controllerAuthorityDigest: `sha256:${"a".repeat(64)}`,
          certificationCase: null,
          preparedAuthorityDigests: {
            buildkitImage: `sha256:${"b".repeat(64)}`,
            buildkitPlatform: `sha256:${"c".repeat(64)}`,
            daemon: `sha256:${"d".repeat(64)}`,
            images: `sha256:${"e".repeat(64)}`,
            socket: `sha256:${"f".repeat(64)}`,
          },
          runIds,
          failureEvidence,
        })}\n`,
        { mode: 0o600 },
      );
      expect(
        spawnSync(
          process.execPath,
          [
            resolve(
              workspaceRoot,
              "tests/integration/verify-substrate-certification.mjs",
            ),
            "failure",
          ],
          { cwd: directory },
        ).status,
      ).toBe(0);
      rmSync(resolve(artifacts, "runs", runIds[1]!), {
        recursive: true,
      });
      expect(
        spawnSync(
          process.execPath,
          [
            resolve(
              workspaceRoot,
              "tests/integration/verify-substrate-certification.mjs",
            ),
            "failure",
          ],
          { cwd: directory },
        ).status,
      ).not.toBe(0);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("accepts only exact pre-mutation credential rejection evidence", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "agentscope-preflight-"));
    const artifacts = resolve(directory, "artifacts/integration");
    const githubSha = "d".repeat(40);
    const evidence = {
      certificationCase: "credential-presence",
      certificationPredicate: "credential-environment",
      controllerPreflightFailureVersion: 1,
      githubSha,
      mutationAuthority: "not-created",
      primaryFailure: "integration.controller.provider-credentials",
    };
    try {
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(
        resolve(artifacts, "controller-preflight-failure.json"),
        `${JSON.stringify(evidence)}\n`,
        { mode: 0o600 },
      );
      const verify = () =>
        spawnSync(
          process.execPath,
          [
            resolve(
              workspaceRoot,
              "tests/integration/verify-substrate-certification.mjs",
            ),
            "negative",
          ],
          {
            cwd: directory,
            env: {
              AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE: "credential-presence",
              GITHUB_SHA: githubSha,
              PATH: process.env.PATH,
            },
          },
        ).status;
      expect(verify()).toBe(0);
      mkdirSync(resolve(artifacts, "runs"));
      expect(verify()).not.toBe(0);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  // The fixture must rewrite one exact manifest repeatedly to prove every
  // cross-bound substitution against the same file identities.
  // eslint-disable-next-line max-lines-per-function
  it("requires retirement-bound negatives to retain exact private authority evidence", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "agentscope-retirement-"));
    const artifacts = resolve(directory, "artifacts/integration");
    const runId = "0123456789abcdef";
    const run = resolve(artifacts, "runs", runId);
    const diagnostic = {
      diagnosticVersion: 1,
      stage: "scenario-operation",
      authorityDigests: {
        daemon: `sha256:${"a".repeat(64)}`,
        images: `sha256:${"b".repeat(64)}`,
        socket: `sha256:${"c".repeat(64)}`,
      },
      outcome: "retired-failure",
      retirementReason: "mutation-outcome-unknown",
    };
    const preparedAuthorityDigests = {
      buildkitImage: `sha256:${"d".repeat(64)}`,
      buildkitPlatform: `sha256:${"e".repeat(64)}`,
      daemon: diagnostic.authorityDigests.daemon,
      images: diagnostic.authorityDigests.images,
      socket: diagnostic.authorityDigests.socket,
    };
    const writeEvidence = (privateCleanup: unknown) => {
      const content = `${JSON.stringify({
        controllerFailureEvidenceVersion: 2,
        runId,
        certificationCase: "wrong-argv",
        certificationPredicate: "request-argv-mismatch",
        certificationReadiness: null,
        scenarioOutcome: "failed",
        controllerOutcome: "retired-failure",
        primaryFailure: "integration.controller.unsettled-operation",
        cleanupFailure: null,
        installedPtyFailure: null,
        privateCleanup,
      })}\n`;
      writeFileSync(resolve(run, "controller-failure.json"), content, {
        mode: 0o600,
      });
      const status = lstatSync(resolve(run, "controller-failure.json"));
      writeFileSync(
        resolve(artifacts, "controller-failure-manifest.json"),
        `${JSON.stringify({
          controllerFailureManifestVersion: 1,
          controllerAuthorityDigest: `sha256:${"d".repeat(64)}`,
          certificationCase: "wrong-argv",
          preparedAuthorityDigests,
          runIds: [runId],
          failureEvidence: [
            {
              dev: status.dev,
              digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
              ino: status.ino,
              runId,
              size: status.size,
            },
          ],
        })}\n`,
        { mode: 0o600 },
      );
    };
    const verify = () =>
      spawnSync(
        process.execPath,
        [
          resolve(
            workspaceRoot,
            "tests/integration/verify-substrate-certification.mjs",
          ),
          "negative",
        ],
        {
          cwd: directory,
          env: {
            AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE: "wrong-argv",
            PATH: process.env.PATH,
          },
        },
      ).status;
    try {
      mkdirSync(run, { recursive: true, mode: 0o700 });
      writeEvidence(diagnostic);
      expect(verify()).toBe(0);
      writeEvidence(null);
      expect(verify()).not.toBe(0);
      writeEvidence({ ...diagnostic, outcome: "retired-success" });
      expect(verify()).not.toBe(0);
      writeEvidence({
        ...diagnostic,
        authorityDigests: {
          ...diagnostic.authorityDigests,
          daemon: `sha256:${"f".repeat(64)}`,
        },
      });
      expect(verify()).not.toBe(0);
      const digestJson = (value: unknown) =>
        `sha256:${createHash("sha256")
          .update(JSON.stringify(value))
          .digest("hex")}`;
      const builderCleanup = {
        diagnosticVersion: 1,
        stage: "builder-reconciliation",
        operationKind: "image-build",
        identityDigests: {
          builder: digestJson(`agentscope-${runId}`),
          daemon: preparedAuthorityDigests.daemon,
          image: preparedAuthorityDigests.buildkitImage,
          platform: preparedAuthorityDigests.buildkitPlatform,
          runGeneration: digestJson(runId),
        },
        process: {
          observed: true,
          exited: false,
          signaled: true,
          timedOut: true,
          joined: false,
          outputBytes: 1,
          outputTruncated: false,
          stderrClass: "unknown",
        },
        responseBytes: 1,
        responseTruncated: false,
        expectedResourceCount: 2,
        observedResourceCount: 1,
        expectedResourceDigest: digestJson([
          `buildx_buildkit_agentscope-${runId}0`,
          `buildx_buildkit_agentscope-${runId}0_state`,
        ]),
        observedResourceDigest: `sha256:${"f".repeat(64)}`,
        reconciliationReasons: {
          builderContainer: "matched",
          builderVolume: "absent",
          builtTag: "not-observed",
        },
        outcome: "retired-failure",
      };
      writeEvidence(builderCleanup);
      expect(verify()).toBe(0);
      writeEvidence({
        ...builderCleanup,
        identityDigests: {
          ...builderCleanup.identityDigests,
          runGeneration: `sha256:${"f".repeat(64)}`,
        },
      });
      expect(verify()).not.toBe(0);
      writeEvidence({ ...builderCleanup, expectedResourceCount: 3 });
      expect(verify()).not.toBe(0);
      writeEvidence({ ...builderCleanup, responseTruncated: true });
      expect(verify()).not.toBe(0);
      writeEvidence({
        ...builderCleanup,
        expectedResourceDigest: `sha256:${"a".repeat(64)}`,
      });
      expect(verify()).not.toBe(0);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
