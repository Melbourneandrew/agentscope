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
import { writeExactRegularFile } from "../exact-file.mjs";
import { SUBSTRATE_CERTIFICATION_CASES } from "./substrate-certification.js";

const expectCodexSettlementBeforeTraceSearch = (scenario: string): void => {
  const reporterSettlement = scenario.indexOf(
    "const reporterSettled = localSqliteReporterSettled(",
  );
  const settlementGate = scenario.indexOf(
    'hookCommandObservation?.outcome !== "completed" ||',
    reporterSettlement,
  );
  const traceSearchAdmission = scenario.indexOf(
    "const traceSearchDeadlines = codexTraceSearchAttemptDeadlines({",
    settlementGate,
  );
  expect(reporterSettlement).toBeGreaterThan(-1);
  expect(settlementGate).toBeGreaterThan(reporterSettlement);
  expect(traceSearchAdmission).toBeGreaterThan(settlementGate);
};

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

  it("keeps external-material verification inside the selected disposable daemon", () => {
    const material = readFileSync(
      resolve(workspaceRoot, "tests/integration/harness-material.mjs"),
      "utf8",
    );
    const command = readFileSync(
      resolve(workspaceRoot, "tests/integration/harness-material-command.mjs"),
      "utf8",
    );
    expect(material).toContain("buildPreparedDockerImage(client");
    expect(material).toContain("retirePreparedDockerImage(client");
    expect(material).toContain('RUN --network=${operation === "gpg-verify"');
    expect(material).not.toContain("runSupervisedProcess");
    expect(command).toContain('root !== "/verify"');
    expect(command).toContain('NPM_CONFIG_IGNORE_SCRIPTS: "true"');
    expect(command).toContain(
      "npmVersion !== `${policy.verifierNpmVersion}\\n`",
    );
    expect(command).toContain("verified.attestationBundles");
    expect(command).toContain('"--no-auto-key-retrieve"');
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
    expect(source).toContain('"harness-support-evidence.json": 1_048_576');
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

// eslint-disable-next-line max-lines-per-function -- closed integration authority matrix
describe("integration cleanup authority", () => {
  it("preserves the causal interactive child diagnostic over a later generic receipt failure", () => {
    const source = readFileSync(
      resolve(workspaceRoot, "tests/integration/run-scenarios.mjs"),
      "utf8",
    );
    const recorder = source.slice(
      source.indexOf("const recordInteractiveReceiptFailure ="),
      source.indexOf("const recordInteractiveExecutionFailure ="),
    );
    expect(recorder).toContain("installedPtyFailures.has(plan.runId)");
    expect(
      recorder.indexOf("installedPtyFailures.has(plan.runId)"),
    ).toBeLessThan(recorder.indexOf("installedPtyFailures.set(plan.runId"));
  });

  it("carries a semantically nonzero PTY receipt phase into the authenticated exit channel", () => {
    const source = readFileSync(
      resolve(workspaceRoot, "tests/integration/runner.mjs"),
      "utf8",
    );
    expect(source).toContain("interactiveFailureDiagnostic = diagnostic;");
    expect(
      source.indexOf("interactiveFailureDiagnostic = diagnostic;"),
    ).toBeLessThan(
      source.indexOf(
        'fixtureFailure = new Error("integration.runner.fixture-failed")',
      ),
    );
    expect(source).toContain("decodeScenarioFailureExitCode(receipt.exitCode)");

    const scenario = readFileSync(
      resolve(workspaceRoot, "tests/integration/codex-pty-scenario.mjs"),
      "utf8",
    );
    expect(scenario).toContain("exitCode = 64 + interactiveFailurePhaseIndex;");
    expect(scenario).toContain(
      "process.stdout.write(`${terminalCompletionMarker}\\r\\n`, (error)",
    );
    expect(
      scenario.indexOf(
        "process.stdout.write(`${terminalCompletionMarker}\\r\\n`, (error)",
      ),
    ).toBeLessThan(scenario.indexOf("settle(error === null"));
    expect(scenario).toContain(
      "const timer = setTimeout(() => settle(1), 1_000)",
    );
    expect(source).toContain(
      'AGENTSCOPE_INTEGRATION_RUN_ID: requiredEnvironment(\n      "AGENTSCOPE_INTEGRATION_RUN_ID",\n    )',
    );
  });

  it("keeps Codex trace diagnosis split across terminal, settlement, and search", () => {
    const scenario = readFileSync(
      resolve(workspaceRoot, "tests/integration/codex-pty-scenario.mjs"),
      "utf8",
    );
    const authority = readFileSync(
      resolve(
        workspaceRoot,
        "tests/integration/immutable-candidate-authority.mjs",
      ),
      "utf8",
    );
    for (const phase of [
      "trace-terminal",
      "trace-settlement",
      "trace-acceptance",
      "trace-reporter-settled",
      "trace-search",
      "trace-search-result",
    ]) {
      expect(scenario).toContain(`recordInteractivePhase("${phase}")`);
      expect(authority).toContain(`"integration.fixture.codex-${phase}"`);
    }
    for (const phase of [
      "hook-command-timeout",
      "hook-command-spawn-error",
      "hook-command-stdin-error",
      "hook-command-wait-error",
      "hook-command-missing",
      "hook-command-completed-before-budget-boundary",
      "hook-command-completed-near-budget-boundary",
      "hook-no-operational-state-subsecond",
      "hook-no-operational-state-low-latency",
      "hook-no-operational-state-mid-latency",
      "hook-no-operational-state-high-latency",
      "hook-no-operational-state-near-deadline",
      "hook-start-suppressed",
      "hook-start-deadline",
      "hook-capture-suppressed",
      "hook-capture-deadline",
      "hook-redaction-suppressed",
      "hook-redaction-deadline",
      "hook-routing-no-route",
      "hook-delivery-rejected",
      "hook-delivery-unavailable",
      "hook-delivery-deadline",
      "hook-delivery-unknown",
      "hook-accepted-without-trace",
      "hook-operational-unclassified",
    ]) {
      expect(scenario).toContain(`"${phase}"`);
      expect(authority).toContain(`"integration.fixture.codex-${phase}"`);
    }
    expect(scenario).toContain("inspectDiagnosticBeforeDeadline({");
    expect(scenario).toContain("recordTerminalObservationBeforeDeadline({");
    expect(scenario.indexOf("inspectDiagnosticBeforeDeadline({")).toBeLessThan(
      scenario.indexOf("const reporterSettled = localSqliteReporterSettled("),
    );
    expect(
      scenario.indexOf("const reporterSettled = localSqliteReporterSettled("),
    ).toBeLessThan(
      scenario.indexOf("await readTraceSummary(traceSearchDeadlines)"),
    );
    expect(scenario).toContain("codexTraceSearchAttemptDeadlines({");
    expect(scenario).toContain(
      "const terminalCut = classifyCodexSettledTraceObservation({",
    );
    expect(scenario).toContain("traceGraph.sessionId !== codexSessionId");
    for (const phase of ["hook-missing", "hook-failed", "hook-completed"])
      expect(authority).not.toContain(`"integration.fixture.codex-${phase}"`);
    expect(authority).not.toContain('"integration.fixture.codex-trace"');
  });

  it("gives only interactive fixtures one exact capable terminal identity", () => {
    const scenarios = readFileSync(
      resolve(workspaceRoot, "tests/integration/run-scenarios.mjs"),
      "utf8",
    );
    const runner = readFileSync(
      resolve(workspaceRoot, "tests/integration/runner.mjs"),
      "utf8",
    );
    expect(scenarios).toContain(
      '...(plan.executionMode === "interactive" ? { TERM: "xterm-256color" } : {})',
    );
    expect(runner).toContain(
      '...(scenario.executionMode === "interactive"\n      ? { TERM: "xterm-256color" }\n      : {})',
    );
    expect(scenarios.match(/TERM: "xterm-256color"/gu)).toHaveLength(1);
    expect(runner.match(/TERM: "xterm-256color"/gu)).toHaveLength(1);
  });

  it("reserves the terminal controller window for Docker cleanup only", () => {
    const source = readFileSync(
      resolve(workspaceRoot, "tests/integration/run-scenarios.mjs"),
      "utf8",
    );
    expect(source).toContain(
      "remainingIntegrationOperationMilliseconds(30_000, true)",
    );
    expect(source).toContain("terminal: true");
    expect(source).toContain(
      "remainingIntegrationOperationMilliseconds(\n        scenarioTimeoutMilliseconds,\n        terminal,\n      )",
    );
  });

  it("does not reset a scenario deadline after preparation", () => {
    const source = readFileSync(
      resolve(workspaceRoot, "tests/integration/run-scenarios.mjs"),
      "utf8",
    );
    expect(source).toContain(
      "const scenarioDeadline = performance.now() + scenarioTimeoutMilliseconds;",
    );
    expect(source).toContain(
      "runScenario(selectedPlan, signal, scenarioDeadline)",
    );
    expect(source).toContain("scenarioDeadline - performance.now()");
    expect(source).not.toContain(
      "const remainingOuterMilliseconds = Math.min(\n    scenarioTimeoutMilliseconds,",
    );
  });

  it("uses distinct closed npm configuration files for offline harness installation", () => {
    const source = readFileSync(
      resolve(workspaceRoot, "tests/integration/run-scenarios.mjs"),
      "utf8",
    );
    expect(source).toContain(
      '"--userconfig=/opt/agentscope/harness/npm-userconfig", "--globalconfig=/opt/agentscope/harness/npm-globalconfig"',
    );
    expect(source).toContain('resolve(context, "harness/npm-userconfig")');
    expect(source).toContain('resolve(context, "harness/npm-globalconfig")');
    expect(source).not.toContain(
      '"--userconfig=/dev/null", "--globalconfig=/dev/null"',
    );
  });

  it("settles empty npm configuration identity despite a restrictive umask", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "agentscope-npm-config-"));
    const target = resolve(directory, "npm-userconfig");
    const priorUmask = process.umask(0o777);
    try {
      writeExactRegularFile(target, Buffer.alloc(0), 0o600);
      const status = lstatSync(target);
      expect(status.isFile()).toBe(true);
      expect(status.isSymbolicLink()).toBe(false);
      expect(status.size).toBe(0);
      expect(status.mode & 0o777).toBe(0o600);
    } finally {
      process.umask(priorUmask);
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

// eslint-disable-next-line max-lines-per-function -- closed diagnostic phase order
describe("Codex interactive diagnostic order", () => {
  // eslint-disable-next-line max-lines-per-function -- closed diagnostic phase order
  it("keeps retained phases in the writer's strict lifecycle order", () => {
    const scenario = readFileSync(
      resolve(workspaceRoot, "tests/integration/codex-pty-scenario.mjs"),
      "utf8",
    );
    const runner = readFileSync(
      resolve(workspaceRoot, "tests/integration/runner.mjs"),
      "utf8",
    );
    const expected = [
      "bootstrap",
      "bootstrap-arguments",
      "bootstrap-deadline",
      "bootstrap-readiness",
      "bootstrap-environment",
      "bootstrap-modules",
      "bootstrap-artifact",
      "bootstrap-pty",
      "init",
      "destination",
      "routing",
      "install",
      "model-gate-start",
      "model-gate-routes-read",
      "model-gate-route-validated",
      "model-gate-control-response",
      "model-gate-control-ended",
      "model-gate-control-status-ok",
      "model-gate-control-json",
      "model-gate-request-complete",
      "model-gate-configured",
      "control-plane-closed",
      "tui-start",
      "model-request",
      "trace-terminal",
      "tui-exit",
      "trace-settlement",
      "trace-search",
      "hook-command-timeout",
      "hook-command-spawn-error",
      "hook-command-stdin-error",
      "hook-command-wait-error",
      "hook-command-missing",
      "hook-command-completed-before-budget-boundary",
      "hook-command-completed-near-budget-boundary",
      "hook-no-operational-state-subsecond",
      "hook-no-operational-state-low-latency",
      "hook-no-operational-state-mid-latency",
      "hook-no-operational-state-high-latency",
      "hook-no-operational-state-near-deadline",
      "hook-start-suppressed",
      "hook-start-deadline",
      "hook-capture-suppressed",
      "hook-capture-deadline",
      "hook-redaction-suppressed",
      "hook-redaction-deadline",
      "hook-routing-no-route",
      "hook-delivery-rejected",
      "hook-delivery-unavailable",
      "hook-delivery-deadline",
      "hook-delivery-unknown",
      "hook-accepted-without-trace",
      "hook-operational-unclassified",
      "trace-search-record-count",
      "trace-search-shape",
      "trace-search-ambiguous",
      "trace-search-harness",
      "trace-search-locator",
      "trace-reporter-settled",
      "trace-acceptance",
      "trace-search-result",
      "verify",
    ];
    const phases = (source: string) => {
      const declaration = source.slice(
        source.indexOf("const interactivePhases = Object.freeze(["),
        source.indexOf("]);", source.indexOf("const interactivePhases")) + 3,
      );
      return [...declaration.matchAll(/^ {2}"([a-z-]+)",$/gmu)].map(
        (match) => match[1],
      );
    };
    expect(phases(scenario)).toEqual(expected);
    expect(phases(runner)).toEqual(expected);
    expect(scenario).toContain(
      "if (phaseIndex <= interactiveFailurePhaseIndex)",
    );
    expect(scenario).not.toContain("recordInteractivePhase(classification)");
    expectCodexSettlementBeforeTraceSearch(scenario);
    const modelRequestObservation = scenario.indexOf(
      "await waitForModelRequestBeforeDeadline({",
    );
    const modelRequestPhase = scenario.indexOf(
      'recordInteractivePhase("model-request")',
      modelRequestObservation,
    );
    const settlementPhase = scenario.indexOf(
      'recordInteractivePhase("trace-settlement")',
      modelRequestPhase,
    );
    const traceObservation = scenario.indexOf(
      "await waitForTraceSummary(traceDeadline)",
      modelRequestPhase,
    );
    const terminalLedgerRead = scenario.indexOf(
      "const records = readCodexSessionLedgerRecords(homeDescriptor);",
    );
    const terminalDeadlinePrecheck = scenario.lastIndexOf(
      "if (bootNow() >= traceDeadline)",
      terminalLedgerRead,
    );
    const terminalObservation = scenario.indexOf(
      "await waitForCodexTurnTerminal(traceDeadline)",
      terminalLedgerRead,
    );
    const sessionCorrelation = scenario.indexOf(
      "traceGraph.sessionId !== codexSessionId",
      terminalObservation,
    );
    expect(modelRequestPhase).toBeGreaterThan(modelRequestObservation);
    expect(terminalDeadlinePrecheck).toBeGreaterThan(-1);
    expect(terminalLedgerRead).toBeGreaterThan(terminalDeadlinePrecheck);
    expect(terminalObservation).toBeGreaterThan(terminalLedgerRead);
    expect(sessionCorrelation).toBeGreaterThan(terminalObservation);
    expect(settlementPhase).toBeGreaterThan(modelRequestPhase);
    expect(traceObservation).toBeGreaterThan(terminalObservation);
    expect(settlementPhase).toBeLessThan(traceObservation);
    for (let index = 0; index < expected.length; index += 1)
      expect(expected.slice(0, index + 1).at(-1)).toBe(expected[index]);
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
  // eslint-disable-next-line max-lines-per-function -- one closed workflow and staged-runtime inventory
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
    const exactFile = readFileSync(
      resolve(workspaceRoot, "tests/integration/exact-file.mjs"),
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
    const causalDiagnostic = scenarios.indexOf(
      "integration.controller.causal-diagnostic:${failureCode(error)}",
    );
    expect(scenarios).toContain(
      '({ stdout } = await dockerWithSignal(\n      ["start", "--attach", plan.scenarioName],\n      signal,\n    ))',
    );
    expect(scenarios).toContain(
      "terminalMutationProved = await proveFailedAttachSettled(",
    );
    const attachStart = scenarios.indexOf(
      '({ stdout } = await dockerWithSignal(\n      ["start", "--attach", plan.scenarioName]',
    );
    const attachCatch = scenarios.indexOf("  } catch (error) {", attachStart);
    const successfulReceipt = scenarios.indexOf(
      '  const receipt =\n    plan.executionMode === "interactive"',
      attachCatch,
    );
    const rejectedAttachProof = scenarios.indexOf(
      "terminalMutationProved = await proveFailedAttachSettled(",
      attachCatch,
    );
    const rejectedAttachOutput = scenarios.indexOf(
      'const output = `${error?.stdout ?? ""}`;',
      attachCatch,
    );
    expect(attachStart).toBeGreaterThan(-1);
    expect(attachCatch).toBeGreaterThan(attachStart);
    expect(successfulReceipt).toBeGreaterThan(attachCatch);
    expect(rejectedAttachProof).toBeGreaterThan(attachCatch);
    expect(rejectedAttachOutput).toBeGreaterThan(rejectedAttachProof);
    expect(
      scenarios
        .slice(attachStart, attachCatch)
        .includes("captureHeadlessReceipt"),
    ).toBe(false);
    expect(scenarios).toContain('["container", "wait", containerId]');
    expect(scenarios).toContain('["container", "inspect", containerId]');
    expect(scenarios).toContain('"COPY dist ./dist"');
    expect(scenarios).toContain(
      'const packageBoundaryPath = resolve(context, "dist/package.json")',
    );
    expect(scenarios).toContain(
      "writeExactRegularFile(packageBoundaryPath, packageBoundaryBytes, 0o644)",
    );
    expect(exactFile).toContain("fchmodSync(descriptor, mode)");
    expect(exactFile).toContain("constants.O_NOFOLLOW");
    expect(exactFile).toContain("descriptorStatus.ino !== pathStatus.ino");
    expect(scenarios.indexOf('"COPY dist ./dist"')).toBeLessThan(
      scenarios.indexOf('"USER node"'),
    );
    expect(required).toBeGreaterThanOrEqual(0);
    expect(causalDiagnostic).toBeGreaterThanOrEqual(0);
    expect(causalDiagnostic).toBeLessThan(required);
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
          causalFailure: null,
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
  it("separates unsettled retirement evidence from witnessed certification", () => {
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
    const writeEvidence = (
      privateCleanup: unknown,
      certification = {
        certificationCase: null as string | null,
        certificationPredicate: null as string | null,
        primaryFailure: "integration.controller.unsettled-operation",
      },
    ) => {
      const content = `${JSON.stringify({
        controllerFailureEvidenceVersion: 2,
        runId,
        certificationCase: certification.certificationCase,
        certificationPredicate: certification.certificationPredicate,
        certificationReadiness: null,
        scenarioOutcome: "failed",
        controllerOutcome: "retired-failure",
        primaryFailure: certification.primaryFailure,
        causalFailure: null,
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
          certificationCase: certification.certificationCase,
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
    const verify = (mode = "failure", certificationCase?: string) =>
      spawnSync(
        process.execPath,
        [
          resolve(
            workspaceRoot,
            "tests/integration/verify-substrate-certification.mjs",
          ),
          mode,
        ],
        {
          cwd: directory,
          env: {
            ...(certificationCase === undefined
              ? {}
              : {
                  AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE: certificationCase,
                }),
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
      const witnessedWrongArgv = {
        certificationCase: "wrong-argv",
        certificationPredicate: "request-argv-mismatch",
        primaryFailure: "integration.certification.wrong-argv",
      };
      writeEvidence(null, witnessedWrongArgv);
      expect(verify("negative", "wrong-argv")).toBe(0);
      writeEvidence(diagnostic, {
        ...witnessedWrongArgv,
        primaryFailure: "integration.controller.unsettled-operation",
      });
      expect(verify("negative", "wrong-argv")).not.toBe(0);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
