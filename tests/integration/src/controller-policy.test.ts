import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  SystemdAdmissionMainPidReason,
  SystemdTerminalWaitCgroupReason,
  SystemdUnitAdmissionDiagnosticReason,
} from "../supervisor.mjs";

import {
  advanceToolForceState,
  authenticateCgroup,
  cgroupObservationSettled,
  exactPathIsAbsent,
  exerciseSystemdToolFailurePreservationForTesting,
  classifySystemdUnitAuthority,
  classifySystemdAdmissionMainPid,
  classifyTerminalSystemdUnitAuthority,
  classifyTerminalCgroupTransitionFailure,
  exerciseTerminalCgroupDiagnosticForTesting,
  classifyRetirementSystemdUnitAuthority,
  classifyToolSettlement,
  closeDescriptorSet,
  closePreparedGithubSystemdSupervision,
  parseSystemdMainExitStatus,
  parseSystemdTerminalExit,
  prepareGithubSystemdSupervision,
  rootPid1ProbeRequired,
  rootToolHasPreparationBudget,
  systemdMainProcessIsTerminal,
  systemdConsumptionDeadlines,
  runSupervisedProcess,
  sameSystemdArguments,
  sameSystemdEnvironment,
  snapshotSystemdArguments,
  snapshotSystemdEnvironment,
  systemdToolFailureStage,
  transferDescriptorAuthority,
  validSystemdLifecyclePredicate,
  validateLiveMappedExecutable,
  validateMainProcessMembership,
  validatePythonAuthority,
  validateRootPid1Probe,
  validateRootToolReceipt,
  validateToolLeaderSnapshot,
} from "../supervisor.mjs";
import { ISOLATION_EXECUTOR_LIMITS } from "./isolation.js";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const fixtureCapabilityManifest = JSON.parse(
  readFileSync(
    resolve(workspaceRoot, "tests/integration/capability-manifest.json"),
    "utf8",
  ),
) as {
  manifestIdentity: string;
  scenarios: Array<{
    image: string;
    mockServerImage: string;
    modelRoutes: string[];
    scenarioId: string;
  }>;
};
const fixtureScenario = fixtureCapabilityManifest.scenarios[0]!;
const manifest = (path: string) =>
  JSON.parse(readFileSync(resolve(workspaceRoot, path), "utf8")) as {
    scripts: Record<string, string>;
  };
const failureVerifierSource = (workflow: string) => {
  if (!workflow.includes("uses: ./tests/integration"))
    throw new Error("missing failure verifier action");
  const action = readFileSync(
    resolve(workspaceRoot, "tests/integration/upload-failure-evidence.mjs"),
    "utf8",
  );
  const marker = "export const finalizeFailureEvidence = async ({\n";
  const start = action.indexOf(marker);
  const end = action.indexOf(
    "\n};\n/* eslint-enable complexity, max-lines-per-function */",
    start,
  );
  if (start < 0 || end < 0)
    throw new Error("malformed failure verifier action");
  const functionBody = action.slice(
    action.indexOf("}) => {\n", start) + "}) => {\n".length,
    end,
  );
  const tailStart = functionBody.indexOf("  const deadline =");
  const retirementStart = functionBody.indexOf(
    "  const retireUploadedFailureEvidence =",
    tailStart,
  );
  if (tailStart < 0 || retirementStart < 0)
    throw new Error("malformed failure verifier action");
  const syntheticUpload = `  const uploader = spawnSync("fixture", [], {
    input: bundle,
    maxBuffer: 4096,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (
    uploader.error !== undefined ||
    uploader.status !== 0 ||
    uploader.signal !== null ||
    uploader.stderr.length !== 0 ||
    uploader.stdout.length < 1 ||
    uploader.stdout.length > 1024
  ) fail();
  const receipt = JSON.parse(uploader.stdout.toString("utf8"));
  if (
    !exactKeys(receipt, ["artifactDigest", "artifactId", "artifactSize", "status"]) ||
    receipt.status !== "uploaded" ||
    !Number.isSafeInteger(receipt.artifactId) ||
    receipt.artifactId < 1 ||
    !Number.isSafeInteger(receipt.artifactSize) ||
    receipt.artifactSize < 1 ||
    !/^sha256:[a-f0-9]{64}$/u.test(receipt.artifactDigest)
  ) fail();
  const canonicalReceipt = JSON.stringify({ artifactDigest: receipt.artifactDigest, artifactId: receipt.artifactId, artifactSize: receipt.artifactSize, status: "uploaded" }) + "\\n";
  if (uploader.stdout.toString("utf8") !== canonicalReceipt) fail();
`;
  const body = (
    functionBody.slice(0, tailStart) +
    syntheticUpload +
    functionBody.slice(retirementStart)
  )
    .split("\n")
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n");
  return `import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { compileCapabilityManifest, compileIsolationEvidence } from ${JSON.stringify(
    pathToFileURL(resolve(workspaceRoot, "tests/integration/dist/index.js"))
      .href,
  )};
${body}`;
};
const failureReceiptValidatorSource = (workflow: string) => {
  const source = failureVerifierSource(workflow);
  const start = source.indexOf("const ptyFailurePredicates =");
  const end = source.indexOf("const readBounded =", start);
  if (start < 0 || end < 0)
    throw new Error("missing failure receipt validator");
  return `const exactKeys = (value, keys) => typeof value === "object" && value !== null && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());\n${source.slice(start, end)}`;
};
const cleanupFailureValidatorSource = () => {
  const source = readFileSync(
    resolve(workspaceRoot, "tests/integration/clean.mjs"),
    "utf8",
  );
  const start = source.indexOf("const installedPtyFailurePredicates =");
  const end = source.indexOf("const addDirectory =", start);
  if (start < 0 || end < 0) throw new Error("missing cleanup validator");
  return source.slice(start, end);
};
const cleanupRetentionCompilerSource = () => {
  const source = readFileSync(
    resolve(workspaceRoot, "tests/integration/clean.mjs"),
    "utf8",
  );
  const start = source.indexOf("const failureRetainedArtifactNames =");
  const end = source.indexOf("const installedPtyFailurePredicates =", start);
  if (start < 0 || end < 0)
    throw new Error("missing failure retention compiler");
  return source.slice(start, end);
};
const writeRetainedFailureInputs = (directory: string) => {
  const artifacts = resolve(directory, "artifacts/integration");
  mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const manifestIdentity = fixtureCapabilityManifest.manifestIdentity;
  const bundleIdentity = `sha256-${"b".repeat(64)}`;
  const candidateRevision = "c".repeat(40);
  const baseImage = fixtureScenario.image;
  const mockImage = fixtureScenario.mockServerImage;
  const imageIdentity = (image: string, seed: string) => ({
    configDigest: `sha256:${seed.repeat(64)}`,
    image,
    manifestDigest: `sha256:${seed.repeat(64)}`,
    platform: { architecture: "amd64", os: "linux" },
  });
  const inputs = {
    "current-candidate.json": {
      bundleIdentity,
      candidateRevision,
      pointerVersion: 1,
    },
    "current-images.json": {
      dockerDaemon: {},
      dockerSocket: {},
      imageEvidenceVersion: 2,
      images: [imageIdentity(baseImage, "1"), imageIdentity(mockImage, "2")],
      manifestIdentity,
      preparationPolicy: {},
      terminalCleanup: {},
    },
    "current-model-routes.json": {
      mockServerInitialization: [],
      routeFixtureVersion: 1,
      routeIds: fixtureScenario.modelRoutes,
      routes: [],
    },
    "current-selection.json": {
      manifestIdentity,
      scenarioIds: [fixtureScenario.scenarioId],
      selectionMode: "full",
      selectionVersion: 2,
      selector: {},
    },
  };
  for (const [fileName, value] of Object.entries(inputs))
    writeFileSync(resolve(artifacts, fileName), `${JSON.stringify(value)}\n`, {
      mode: fileName === "current-images.json" ? 0o600 : 0o644,
    });
  const integration = resolve(directory, "tests/integration");
  mkdirSync(integration, { recursive: true, mode: 0o700 });
  writeFileSync(
    resolve(integration, "capability-manifest.json"),
    `${JSON.stringify(fixtureCapabilityManifest)}\n`,
    { mode: 0o644 },
  );
  const digest = (path: string) =>
    `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  return {
    "capability-manifest.json": digest(
      resolve(integration, "capability-manifest.json"),
    ),
    "current-candidate.json": digest(
      resolve(artifacts, "current-candidate.json"),
    ),
    "current-images.json": digest(resolve(artifacts, "current-images.json")),
    "current-model-routes.json": digest(
      resolve(artifacts, "current-model-routes.json"),
    ),
    "current-selection.json": digest(
      resolve(artifacts, "current-selection.json"),
    ),
  };
};
const writeRetainedRunEvidence = (
  run: string,
  runId: string,
  outcome: string,
) => {
  const files = {
    "destination-ledger.json": {
      ingestion: { status: "uncertain" },
      retrieval: { status: "uncertain" },
    },
    "evidence.json": {
      baseImage: fixtureScenario.image,
      baseImageIdentity: {
        configDigest: `sha256:${"1".repeat(64)}`,
        image: fixtureScenario.image,
        manifestDigest: `sha256:${"1".repeat(64)}`,
        platform: { architecture: "amd64", os: "linux" },
      },
      builtImageDigest: null,
      builtMockServerImageDigest: null,
      candidateBundleIdentity: `sha256-${"b".repeat(64)}`,
      candidateRevision: "c".repeat(40),
      cleanup: {
        outcome: "verification-failed",
        removalFailureCount: 0,
        remaining: null,
      },
      evidenceVersion: 2,
      executionPolicy: {
        policyVersion: 1,
        runtimeInspection: { outcome: "unavailable", identity: null },
        selection: {
          selectionVersion: 2,
          manifestIdentity: fixtureCapabilityManifest.manifestIdentity,
          mode: "full",
          selector: {},
          scenarioIds: [fixtureScenario.scenarioId],
        },
        maximumParallelScenarios: 2,
        scenarioTimeoutMilliseconds: 300_000,
        cleanupTimeouts: ISOLATION_EXECUTOR_LIMITS.cleanup,
        containers: ISOLATION_EXECUTOR_LIMITS.containers,
        requests: ISOLATION_EXECUTOR_LIMITS.requests,
      },
      headlessTerminalReceipt: null,
      hostMountCount: 0,
      installedCliContractEvidence: null,
      manifestIdentity: fixtureCapabilityManifest.manifestIdentity,
      mockServerImage: fixtureScenario.mockServerImage,
      mockServerImageIdentity: {
        configDigest: `sha256:${"2".repeat(64)}`,
        image: fixtureScenario.mockServerImage,
        manifestDigest: `sha256:${"2".repeat(64)}`,
        platform: { architecture: "amd64", os: "linux" },
      },
      networkMode: "internal-only",
      outcome,
      readOnlyRootFilesystem: true,
      runId,
      scenarioId: fixtureScenario.scenarioId,
      tmpfsMounts: ISOLATION_EXECUTOR_LIMITS.containers.scenario.tmpfs.map(
        ({ path }) => path,
      ),
    },
    "fixture-lifecycle.json": {
      evidenceVersion: 1,
      ledgerObservation: {
        ingestion: "uncertain",
        model: "uncertain",
        retrieval: "uncertain",
      },
      resultStatus: "unavailable",
      scenarioId: fixtureScenario.scenarioId,
    },
    "model-ledger.json": { status: "uncertain" },
  };
  return Object.fromEntries(
    Object.entries(files).map(([name, value]) => {
      const content = `${JSON.stringify(value)}\n`;
      writeFileSync(resolve(run, name), content, { mode: 0o600 });
      return [
        name,
        `sha256:${createHash("sha256").update(content).digest("hex")}`,
      ];
    }),
  );
};
const runFailureVerifier = (
  source: string,
  directory: string,
  fault?: "digest" | "helper" | "identity" | "receipt" | "terminal",
  retire = false,
) => {
  const runnerTemp = mkdtempSync(resolve(directory, "runner-temp-"));
  const bundleOutput = resolve(runnerTemp, "fixture-bundle.json");
  const fixtureSpawn = `import { writeFileSync } from "node:fs";
          const spawnSync = (_executable, arguments_, options) => {
            writeFileSync(process.env.FIXTURE_BUNDLE, options.input);
            const receipt = { artifactDigest: "sha256:" + "a".repeat(64), artifactId: 17, artifactSize: 321, status: "uploaded" };
            return { error: undefined, signal: null, status: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(JSON.stringify(receipt) + "\\n") };
          };`;
  let fixtureSource = source.replace(
    'import { spawnSync } from "node:child_process";',
    fixtureSpawn,
  );
  if (fault === "helper")
    fixtureSource = fixtureSource.replace("status: 0", "status: 1");
  if (fault === "identity")
    fixtureSource = fixtureSource.replace("artifactId: 17", "artifactId: 0");
  if (fault === "digest")
    fixtureSource = fixtureSource.replace(
      '"sha256:" + "a".repeat(64)',
      '"sha256:" + "0".repeat(63)',
    );
  if (fault === "terminal")
    fixtureSource = fixtureSource.replace(
      'status: "uploaded"',
      'status: "failed"',
    );
  if (fault === "receipt")
    fixtureSource = fixtureSource.replace(
      'Buffer.from(JSON.stringify(receipt) + "\\n")',
      'Buffer.from(JSON.stringify(receipt) + " \\n")',
    );
  if (!retire)
    fixtureSource = fixtureSource.replace(
      "retireUploadedFailureEvidence();",
      "for (const { descriptor } of authenticatedDescriptors.splice(0)) closeSync(descriptor);",
    );
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", fixtureSource],
    {
      cwd: directory,
      env: {
        AGENTSCOPE_INTEGRATION_OUTER_DEADLINE_MONOTONIC_MS: String(
          Number(process.hrtime.bigint() / 1_000_000n) + 600_000,
        ),
        AGENTSCOPE_FAILURE_ARTIFACT_NAME: "integration-0-of-1-1",
        ACTIONS_RESULTS_URL:
          "https://results-receiver.actions.githubusercontent.com/",
        ACTIONS_RUNTIME_TOKEN: "fixture-token",
        FIXTURE_BUNDLE: bundleOutput,
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_WORKSPACE: directory,
      },
    },
  );
  return { bundleOutput, runnerTemp, status: result.status };
};
const removeFailureVerifierFixture = (directory: string) => {
  rmSync(directory, { force: true, recursive: true });
};
const writeFailureManifestFixture = (directory: string, runIds: string[]) => {
  const artifacts = resolve(directory, "artifacts/integration");
  const retainedInputs = writeRetainedFailureInputs(directory);
  const failureEvidence = runIds.map((runId) => {
    const run = resolve(artifacts, "runs", runId);
    mkdirSync(run, { recursive: true, mode: 0o700 });
    const path = resolve(run, "controller-failure.json");
    const content = `${JSON.stringify({
      controllerFailureEvidenceVersion: 2,
      runId,
      scenarioOutcome: "failed",
      scenarioFailure: null,
      controllerOutcome: "retired-failure",
      primaryFailure: "integration.controller.failed",
      cleanupFailure: null,
      scenarioSecondaryFailures: [],
      installedPtyFailure: null,
      privateCleanup: null,
      retainedEvidence: writeRetainedRunEvidence(run, runId, "failed"),
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
      runIds,
      failureEvidence,
      retainedInputs,
    })}\n`,
    { mode: 0o600 },
  );
  return artifacts;
};
const writeFailureTerminalFixture = (
  directory: string,
  terminal: Record<string, unknown>,
) => {
  const artifacts = resolve(directory, "artifacts/integration");
  mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  writeFileSync(
    resolve(artifacts, "controller-failure-terminal.json"),
    `${JSON.stringify(terminal)}\n`,
    { mode: 0o600 },
  );
};
const executeFailureVerifier = (
  source: string,
  installedPtyFailure: unknown,
  mutateEvidence?: (evidence: Record<string, unknown>) => void,
  fault?: "digest" | "helper" | "identity" | "receipt" | "terminal",
) => {
  const directory = mkdtempSync(resolve(tmpdir(), "agentscope-evidence-"));
  const artifacts = resolve(directory, "artifacts/integration");
  const runId = "0123456789abcdef";
  const run = resolve(artifacts, "runs", runId);
  mkdirSync(run, { recursive: true, mode: 0o700 });
  try {
    const retainedInputs = writeRetainedFailureInputs(directory);
    const path = resolve(run, "controller-failure.json");
    const retainedEvidence = writeRetainedRunEvidence(run, runId, "failed");
    if (mutateEvidence !== undefined) {
      const evidencePath = resolve(run, "evidence.json");
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<
        string,
        unknown
      >;
      mutateEvidence(evidence);
      const evidenceContent = `${JSON.stringify(evidence)}\n`;
      writeFileSync(evidencePath, evidenceContent, { mode: 0o600 });
      retainedEvidence["evidence.json"] = `sha256:${createHash("sha256")
        .update(evidenceContent)
        .digest("hex")}`;
    }
    const content = `${JSON.stringify({
      controllerFailureEvidenceVersion: 2,
      runId,
      scenarioOutcome: "failed",
      scenarioFailure: "integration.isolation.scenario-failed",
      controllerOutcome: "retired-failure",
      primaryFailure: "integration.controller.unsettled-operation",
      cleanupFailure: null,
      scenarioSecondaryFailures: [],
      installedPtyFailure,
      privateCleanup: null,
      retainedEvidence,
    })}\n`;
    writeFileSync(path, content, { mode: 0o600 });
    const status = lstatSync(path);
    writeFileSync(
      resolve(artifacts, "controller-failure-manifest.json"),
      `${JSON.stringify({
        controllerFailureManifestVersion: 1,
        controllerAuthorityDigest: `sha256:${"a".repeat(64)}`,
        runIds: [runId],
        failureEvidence: [
          {
            dev: status.dev,
            digest: `sha256:${createHash("sha256")
              .update(content)
              .digest("hex")}`,
            ino: status.ino,
            runId,
            size: status.size,
          },
        ],
        retainedInputs,
      })}\n`,
      { mode: 0o600 },
    );
    const sealingStart = source.indexOf("const bundle = Buffer.from");
    if (sealingStart < 0) throw new Error("missing sealed bundle boundary");
    const verifierSource =
      fault === undefined
        ? `${source.slice(0, sealingStart)}for (const { descriptor } of authenticatedDescriptors.splice(0)) closeSync(descriptor);`
        : source;
    return runFailureVerifier(verifierSource, directory, fault).status;
  } finally {
    removeFailureVerifierFixture(directory);
  }
};
const installedContractAdmitted = {
  "aggregate-evaluation": ["evaluation-rejected"],
  "artifact-install": [
    "candidate-rejected",
    "egress-rejected",
    "install-rejected",
    "manifest-rejected",
    "plan-rejected",
    "toolchain-rejected",
  ],
  "case-execution": [
    "narrow-help-rejected",
    "setup-rejected",
    "state-rejected",
    "testkit.headless.aborted",
    "testkit.headless.backend.receipt",
    "testkit.headless.capability",
    "testkit.headless.kernel.failure",
    "testkit.headless.kernel.options",
    "testkit.headless.kernel.request",
    "testkit.headless.kernel.spawn",
    "testkit.headless.observer.identity",
    "testkit.headless.observer.read",
    "testkit.headless.observer.reap",
    "testkit.headless.observer.root",
    "testkit.headless.observer.signal",
    "testkit.headless.reconciliation.deadline",
    "testkit.headless.startup.deadline",
    "testkit.pty.immutable-candidate",
  ],
  "receipt-finalization": ["receipt-rejected"],
} as const;

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
    expect(source).toContain("assertFailureRetention(");
    expect(source).toContain("if (!retainedArtifactFiles.has(name))");
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

describe("integration cleanup failure retention", () => {
  it("retains only exact manifest-bound failure inputs", () => {
    const digest = (seed: string) => `sha256:${seed.repeat(64)}`;
    const runId = "0123456789abcdef";
    const failureEvidence = [
      {
        dev: 1,
        digest: digest("a"),
        ino: 2,
        runId,
        size: 3,
      },
    ];
    const retainedInputs = {
      "capability-manifest.json": digest("1"),
      "current-candidate.json": digest("2"),
      "current-images.json": digest("3"),
      "current-model-routes.json": digest("4"),
      "current-selection.json": digest("5"),
    };
    const manifest = {
      controllerAuthorityDigest: digest("b"),
      controllerFailureManifestVersion: 1,
      failureEvidence,
      retainedInputs,
      runIds: [runId],
    };
    const compile = (
      candidateManifest: unknown,
      candidateRuns: unknown = [runId],
      candidateEvidence: unknown = failureEvidence,
      candidateInputs: unknown = retainedInputs,
      candidateAuthority: unknown = digest("b"),
    ) =>
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `${cleanupRetentionCompilerSource()}\ntry { const result = compileFailureRetention(...JSON.parse(process.argv[1])); process.stdout.write(JSON.stringify([...result].sort())); } catch { process.exit(1); }`,
          JSON.stringify([
            candidateManifest,
            candidateRuns,
            candidateEvidence,
            candidateInputs,
            candidateAuthority,
          ]),
        ],
        { encoding: "utf8" },
      );
    const accepted = compile(manifest);
    expect(accepted.status).toBe(0);
    expect(JSON.parse(accepted.stdout)).toEqual([
      "current-candidate.json",
      "current-images.json",
      "current-model-routes.json",
      "current-selection.json",
    ]);
    for (const rejected of [
      () => compile({ ...manifest, runIds: [] }),
      () => compile({ ...manifest, extra: true }),
      () =>
        compile({
          ...manifest,
          retainedInputs: {
            ...retainedInputs,
            "current-images.json": digest("9"),
          },
        }),
      () => compile(manifest, ["fedcba9876543210"]),
      () => compile(manifest, [runId], [{ ...failureEvidence[0], ino: 7 }]),
      () =>
        compile(manifest, [runId], failureEvidence, {
          ...retainedInputs,
          "current-selection.json": digest("8"),
        }),
      () =>
        compile(
          manifest,
          [runId],
          failureEvidence,
          retainedInputs,
          digest("c"),
        ),
    ])
      expect(rejected().status).not.toBe(0);
  });
});

it("pins the credentialed lifecycle to a nondelegated whole-unit authority", () => {
  const source = readFileSync(
    resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
    "utf8",
  );
  for (const authority of [
    '"--property=Delegate=no"',
    '"--property=KillMode=control-group"',
    '"--property=NoNewPrivileges=yes"',
    '"--property=RestrictSUIDSGID=yes"',
    '"--property=CapabilityBoundingSet="',
    '"--property=AmbientCapabilities="',
    '"--property=ProtectControlGroups=yes"',
    '"/run/dbus/system_bus_socket /run/systemd/private /run/user /var/run/dbus/system_bus_socket"',
    '"--property=RemainAfterExit=yes"',
    '"/usr/bin/sudo"',
    '"/usr/bin/systemctl"',
    '"/usr/bin/systemd-run"',
    '"/usr/bin/readlink"',
    '"/usr/bin/sha256sum"',
    '"/usr/bin/stat"',
    '"cgroup.events"',
    'facts.LoadState === "not-found"',
  ])
    expect(source).toContain(authority);
  expect(source).not.toContain('"--scope"');
});

it("classifies retirement authority drift without relaxing immutable facts", () => {
  const authority = {
    cgroup: "/system.slice/agentscope-test.service",
    gid: 1001,
    groups: [4, 1001],
    uid: 1001,
    unit: "agentscope-test.service",
  };
  const facts = {
    ActiveState: "active",
    AmbientCapabilities: "",
    CapabilityBoundingSet: "",
    ControlGroup: authority.cgroup,
    Delegate: "no",
    ExecMainCode: "1",
    ExecMainStatus: "0",
    Group: String(authority.gid),
    Id: authority.unit,
    InaccessiblePaths:
      "/run/dbus/system_bus_socket /run/systemd/private /run/user /var/run/dbus/system_bus_socket",
    KillMode: "control-group",
    LoadState: "loaded",
    NoNewPrivileges: "yes",
    ProtectControlGroups: "yes",
    RemainAfterExit: "yes",
    Result: "success",
    RestrictSUIDSGID: "yes",
    SupplementaryGroups: authority.groups.join(" "),
    SubState: "running",
    User: String(authority.uid),
  };
  expect(classifySystemdUnitAuthority(facts, authority)).toBeUndefined();
  for (const [field, value, reason] of [
    ["LoadState", "masked", "load"],
    ["Id", "agentscope-other.service", "identity"],
    ["ControlGroup", "/system.slice/agentscope-other.service", "cgroup"],
    ["NoNewPrivileges", "no", "hardening"],
    ["User", "1002", "principal"],
  ] as const)
    expect(
      classifySystemdUnitAuthority({ ...facts, [field]: value }, authority),
    ).toBe(reason);

  const present = { absent: false, empty: true };
  const absent = { absent: true, empty: true };
  expect(
    classifyRetirementSystemdUnitAuthority(facts, authority, present, present),
  ).toBeUndefined();
  expect(
    classifyRetirementSystemdUnitAuthority(
      { ...facts, ControlGroup: "" },
      authority,
      absent,
      absent,
    ),
  ).toBeUndefined();
  expect(
    classifyRetirementSystemdUnitAuthority(facts, authority, absent, absent),
  ).toBeUndefined();
  for (const [before, after, controlGroup] of [
    [present, present, ""],
    [present, absent, ""],
    [absent, present, ""],
    [present, { absent: false, empty: false }, authority.cgroup],
    [{ absent: false, empty: false }, present, authority.cgroup],
    [{ absent: true, empty: false }, absent, ""],
    [absent, { absent: true, empty: false }, ""],
    [absent, absent, "/system.slice/agentscope-other.service"],
  ] as const)
    expect(
      classifyRetirementSystemdUnitAuthority(
        { ...facts, ControlGroup: controlGroup },
        authority,
        before,
        after,
      ),
    ).toBe("cgroup");
  expect(
    classifyRetirementSystemdUnitAuthority(
      { ...facts, ControlGroup: "", User: "1002" },
      authority,
      absent,
      absent,
    ),
  ).toBe("principal");
});

it("carries terminal cgroup disappearance into retirement", () => {
  const authority = {
    cgroup: "/system.slice/agentscope-test.service",
    gid: 1001,
    groups: [4, 1001],
    uid: 1001,
    unit: "agentscope-test.service",
  };
  const terminal = {
    ActiveState: "active",
    AmbientCapabilities: "",
    CapabilityBoundingSet: "",
    ControlGroup: "",
    Delegate: "no",
    ExecMainCode: "1",
    ExecMainStatus: "0",
    Group: "1001",
    Id: authority.unit,
    InaccessiblePaths:
      "/run/dbus/system_bus_socket /run/systemd/private /run/user /var/run/dbus/system_bus_socket",
    KillMode: "control-group",
    LoadState: "loaded",
    NoNewPrivileges: "yes",
    ProtectControlGroups: "yes",
    RemainAfterExit: "yes",
    Result: "success",
    RestrictSUIDSGID: "yes",
    SubState: "running",
    SupplementaryGroups: "4 1001",
    User: "1001",
  };
  const absent = { absent: true, empty: true };
  const presentEmpty = { absent: false, empty: true };
  const presentPopulated = { absent: false, empty: false };
  for (const [controlGroup, before, after] of [
    [authority.cgroup, presentPopulated, presentPopulated],
    [authority.cgroup, absent, absent],
    ["", absent, absent],
    ["", presentEmpty, presentEmpty],
  ] as const)
    expect(
      classifyTerminalSystemdUnitAuthority(
        { ...terminal, ControlGroup: controlGroup },
        authority,
        before,
        after,
      ),
    ).toBeUndefined();
  for (const [before, after, controlGroup] of [
    [presentPopulated, presentPopulated, ""],
    [presentEmpty, absent, ""],
    [absent, presentEmpty, ""],
    [presentPopulated, absent, authority.cgroup],
    [absent, presentEmpty, authority.cgroup],
    [absent, absent, "/system.slice/agentscope-other.service"],
    [{ absent: true, empty: false }, absent, ""],
    [absent, { absent: true, empty: false }, ""],
  ] as const)
    expect(
      classifyTerminalSystemdUnitAuthority(
        { ...terminal, ControlGroup: controlGroup },
        authority,
        before,
        after,
      ),
    ).toBe("cgroup");
  expect(
    classifyTerminalSystemdUnitAuthority(
      { ...terminal, ExecMainStatus: "" },
      authority,
      absent,
      absent,
    ),
  ).toBe("cgroup");
  for (let phase = 0; phase < 2; phase += 1)
    expect(
      classifyTerminalSystemdUnitAuthority(terminal, authority, absent, absent),
    ).toBeUndefined();
  for (const controlGroup of ["", authority.cgroup]) {
    const retained = { ...terminal, ControlGroup: controlGroup };
    expect(
      classifyTerminalSystemdUnitAuthority(retained, authority, absent, absent),
    ).toBeUndefined();
    expect(
      classifyRetirementSystemdUnitAuthority(
        retained,
        authority,
        absent,
        absent,
      ),
    ).toBeUndefined();
  }
});

it("treats a retired cgroup disappearance only as input to collection proof", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "agentscope-cgroup-race-"));
  try {
    const identity = {
      descriptors: [96, 97, 98, 99],
      identities: [
        { dev: 1, gid: 0, ino: 2, mode: 0o040755, uid: 0 },
        { dev: 1, gid: 0, ino: 3, mode: 0o040755, uid: 0 },
        { dev: 1, gid: 0, ino: 4, mode: 0o100444, uid: 0 },
        { dev: 1, gid: 0, ino: 5, mode: 0o100444, uid: 0 },
      ],
    } as const;
    writeFileSync(resolve(directory, "cgroup.events"), "populated 1\n");
    writeFileSync(resolve(directory, "cgroup.procs"), "");
    expect(() => cgroupObservationSettled(directory, identity)).toThrow();
    expect(() => authenticateCgroup(directory)).toThrow();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
  expect(() =>
    cgroupObservationSettled(directory, {
      descriptors: [96, 97, 98, 99],
      identities: [
        { dev: 1, gid: 0, ino: 2, mode: 0o040755, uid: 0 },
        { dev: 1, gid: 0, ino: 3, mode: 0o040755, uid: 0 },
        { dev: 1, gid: 0, ino: 4, mode: 0o100444, uid: 0 },
        { dev: 1, gid: 0, ino: 5, mode: 0o100444, uid: 0 },
      ],
    }),
  ).toThrow();

  const deniedRoot = mkdtempSync(
    resolve(tmpdir(), "agentscope-cgroup-denied-"),
  );
  const deniedChild = resolve(deniedRoot, "child");
  mkdirSync(deniedChild);
  chmodSync(deniedRoot, 0o000);
  try {
    expect(() => exactPathIsAbsent(resolve(deniedChild, "missing"))).toThrow();
  } finally {
    chmodSync(deniedRoot, 0o700);
    rmSync(deniedRoot, { force: true, recursive: true });
  }

  const symlinkRoot = mkdtempSync(resolve(tmpdir(), "agentscope-cgroup-link-"));
  try {
    symlinkSync(symlinkRoot, resolve(symlinkRoot, "linked"));
    expect(() => authenticateCgroup(resolve(symlinkRoot, "linked"))).toThrow();
  } finally {
    rmSync(symlinkRoot, { force: true, recursive: true });
  }

  const supervisor = readFileSync(
    resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
    "utf8",
  );
  const retirement = supervisor.slice(
    supervisor.indexOf("const retireAndCollectSystemdUnit ="),
    supervisor.indexOf("const runSystemdSupervised ="),
  );
  expect(retirement).toContain("!observeCgroupSettlement(");
  expect(retirement.indexOf("await retireUnit(")).toBeLessThan(
    retirement.indexOf("await proveCollected("),
  );
});

it("classifies exact cgroup disappearance before touching retired event descriptors", () => {
  const parent = mkdtempSync(resolve(tmpdir(), "agentscope-cgroup-retained-"));
  const cgroup = resolve(parent, "unit.service");
  const procs = resolve(cgroup, "cgroup.procs");
  const events = resolve(cgroup, "cgroup.events");
  mkdirSync(cgroup);
  writeFileSync(procs, "");
  writeFileSync(events, "populated 0\n");
  const paths = [parent, cgroup, procs, events];
  const openedDescriptors = paths.map((path, index) =>
    openSync(
      path,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        (index < 2 ? constants.O_DIRECTORY : 0),
    ),
  );
  const [
    parentDescriptor,
    cgroupDescriptor,
    procsDescriptor,
    eventsDescriptor,
  ] = openedDescriptors;
  if (
    parentDescriptor === undefined ||
    cgroupDescriptor === undefined ||
    procsDescriptor === undefined ||
    eventsDescriptor === undefined
  )
    throw new Error("missing fixture descriptor");
  const descriptors = [
    parentDescriptor,
    cgroupDescriptor,
    procsDescriptor,
    eventsDescriptor,
  ] as const;
  const identityFor = (descriptor: number) => {
    const status = fstatSync(descriptor);
    return {
      dev: status.dev,
      gid: status.gid,
      ino: status.ino,
      mode: status.mode,
      uid: status.uid,
    };
  };
  const identities = [
    identityFor(parentDescriptor),
    identityFor(cgroupDescriptor),
    identityFor(procsDescriptor),
    identityFor(eventsDescriptor),
  ] as const;
  const authority = { descriptors, identities };
  try {
    expect(cgroupObservationSettled(cgroup, authority)).toBe(true);
    unlinkSync(events);
    unlinkSync(procs);
    rmdirSync(cgroup);
    closeSync(descriptors[3]);
    closeSync(descriptors[2]);
    expect(cgroupObservationSettled(cgroup, authority)).toBe(true);

    mkdirSync(cgroup);
    writeFileSync(procs, "");
    expect(() => cgroupObservationSettled(cgroup, authority)).toThrow(
      "integration.controller.systemd-containment",
    );
    writeFileSync(events, "populated 0\n");
    expect(() => cgroupObservationSettled(cgroup, authority)).toThrow(
      "integration.controller.systemd-containment",
    );
  } finally {
    closeSync(descriptors[1]);
    closeSync(descriptors[0]);
    rmSync(parent, { force: true, recursive: true });
  }
});

it("attempts every retained cgroup descriptor close exactly once", () => {
  for (const failing of [13, 12, 10]) {
    const attempted: number[] = [];
    expect(
      closeDescriptorSet([10, 11, 12, 13], (descriptor) => {
        attempted.push(descriptor);
        if (descriptor === failing) throw new Error("close");
      }),
    ).toBe(false);
    expect(attempted).toEqual([13, 12, 11, 10]);
  }
  const attempted: number[] = [];
  expect(
    closeDescriptorSet([10, 11, 12, 13], (descriptor) => {
      attempted.push(descriptor);
    }),
  ).toBe(true);
  expect(attempted).toEqual([13, 12, 11, 10]);
  expect(() => closeDescriptorSet([10, 11, 10], () => undefined)).toThrow(
    "integration.controller.systemd-containment",
  );

  const supervisor = readFileSync(
    resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
    "utf8",
  );
  const authentication = supervisor.slice(
    supervisor.indexOf("export const authenticateCgroup ="),
    supervisor.indexOf("const sameCgroupIdentity ="),
  );
  expect(authentication).toContain("closeDescriptorSet(descriptors)");
  expect(
    authentication.indexOf("closeDescriptorSet(descriptors)"),
  ).toBeLessThan(authentication.indexOf("throw error;"));

  const lifecycle = supervisor.slice(
    supervisor.indexOf("const runSystemdSupervised ="),
    supervisor.indexOf("export const runSupervisedProcess ="),
  );
  expect(lifecycle).toContain("if (!closed && !lifecycleFailed)");
  expect(lifecycle.indexOf("result = {")).toBeLessThan(
    lifecycle.indexOf("const closed = await closePrepared"),
  );
  expect(lifecycle.indexOf("const closed = await closePrepared")).toBeLessThan(
    lifecycle.indexOf("return result;"),
  );
});

it("accepts only exact numeric systemd exit terminal facts", () => {
  const successful = {
    ActiveState: "active",
    ExecMainCode: "1",
    ExecMainStatus: "0",
    Result: "success",
    SubState: "exited",
  };
  const failed = {
    ActiveState: "failed",
    ExecMainCode: "1",
    ExecMainStatus: "17",
    Result: "exit-code",
    SubState: "failed",
  };
  expect(parseSystemdTerminalExit(successful)).toBe(0);
  expect(parseSystemdTerminalExit(failed)).toBe(17);
  for (const substituted of [
    { ...successful, ExecMainCode: "exited" },
    { ...successful, ExecMainCode: "2" },
    { ...successful, ExecMainCode: "3" },
    { ...successful, ExecMainStatus: "00" },
    { ...successful, ExecMainStatus: "256" },
    { ...successful, ExecMainStatus: "" },
    { ...successful, Result: "exit-code" },
    { ...successful, ActiveState: "inactive" },
    { ...successful, SubState: "dead" },
    { ...failed, ExecMainStatus: "0" },
    { ...failed, Result: "success" },
    { ...failed, ActiveState: "active" },
    { ...failed, SubState: "exited" },
  ])
    expect(parseSystemdTerminalExit(substituted)).toBeUndefined();
});

it("observes exact main exit facts before retiring retained descendants", () => {
  const retainedDescendant = {
    ActiveState: "active",
    ExecMainCode: "1",
    ExecMainStatus: "0",
    Result: "success",
    SubState: "running",
  };
  const deactivatingDescendant = {
    ...retainedDescendant,
    ActiveState: "deactivating",
    SubState: "stop-sigterm",
  };
  const failedMainWithRetainedDescendant = {
    ...retainedDescendant,
    ExecMainStatus: "17",
    Result: "exit-code",
  };
  expect(parseSystemdMainExitStatus(retainedDescendant)).toBe(0);
  expect(parseSystemdMainExitStatus(deactivatingDescendant)).toBe(0);
  expect(parseSystemdMainExitStatus(failedMainWithRetainedDescendant)).toBe(17);
  expect(
    parseSystemdMainExitStatus({
      ...failedMainWithRetainedDescendant,
      ActiveState: "deactivating",
      SubState: "stop-sigterm",
    }),
  ).toBe(17);
  expect(systemdMainProcessIsTerminal(retainedDescendant)).toBe(true);
  expect(systemdMainProcessIsTerminal(deactivatingDescendant)).toBe(true);
  for (const substituted of [
    { ...retainedDescendant, ExecMainCode: "0" },
    { ...retainedDescendant, ExecMainCode: "2" },
    { ...retainedDescendant, ExecMainStatus: "00" },
    { ...retainedDescendant, ExecMainStatus: "256" },
    { ...retainedDescendant, ExecMainStatus: "" },
    { ...retainedDescendant, ExecMainStatus: "17" },
    { ...retainedDescendant, Result: "exit-code" },
    { ...retainedDescendant, ActiveState: "inactive" },
    { ...retainedDescendant, ActiveState: "deactivating" },
    { ...retainedDescendant, SubState: "stop-sigterm" },
    { ...retainedDescendant, Result: "timeout" },
    { ...retainedDescendant, Result: "signal" },
    { ...deactivatingDescendant, ActiveState: "active" },
    { ...deactivatingDescendant, SubState: "running" },
    { ...deactivatingDescendant, Result: "timeout" },
    { ...deactivatingDescendant, ExecMainStatus: "17" },
    { ...failedMainWithRetainedDescendant, Result: "success" },
    { ...failedMainWithRetainedDescendant, Result: "timeout" },
  ]) {
    expect(parseSystemdMainExitStatus(substituted)).toBeUndefined();
    expect(systemdMainProcessIsTerminal(substituted)).toBe(false);
  }

  const supervisor = readFileSync(
    resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
    "utf8",
  );
  const terminalWait = supervisor.slice(
    supervisor.indexOf("const waitForTerminal ="),
    supervisor.indexOf("const systemdSignal ="),
  );
  const terminalObservation = supervisor.slice(
    supervisor.indexOf("const observeTerminalSystemdUnit ="),
    supervisor.indexOf("const waitForTerminal ="),
  );
  expect(terminalWait).toContain('"terminal-wait", "unit-show"');
  expect(terminalWait).toContain('"terminal-wait", "unit-parse"');
  expect(terminalObservation).toContain("`authority-${mismatch}`");
  expect(terminalObservation).toContain(
    "classifyTerminalSystemdUnitAuthority(",
  );
  expect(terminalObservation).toContain(
    'reason !== "cgroup-transition-main-nonterminal"',
  );
  expect(terminalWait).toContain(
    "rethrowAuthenticatedSystemdToolFailure(error);",
  );
  expect(
    terminalWait.indexOf("rethrowAuthenticatedSystemdToolFailure(error)"),
  ).toBeLessThan(terminalWait.indexOf('"terminal-wait", "unit-show"'));
  expect(terminalWait).toContain("systemdMainProcessIsTerminal(facts)");
  expect(terminalWait).toContain(
    "rootToolHasPreparationBudget(state.executionDeadline, performance.now())",
  );
  expect(terminalWait).toContain(
    "remainingMilliseconds(state.executionDeadline)",
  );
  expect(terminalWait).not.toContain(
    'facts.ActiveState === "active" && facts.SubState === "exited"',
  );
  const terminalAuthority = supervisor.slice(
    supervisor.indexOf("const authenticateTerminalSystemdUnit ="),
    supervisor.indexOf("const observeSystemdCgroup ="),
  );
  expect(terminalAuthority).toContain("classifyTerminalSystemdUnitAuthority(");
  expect(terminalAuthority).toContain("authoritativeCode !== expectedCode");
  expect(terminalAuthority).toContain(
    "state.terminalCgroupObservation = after;",
  );
  expect(terminalAuthority).toContain("if (!after.absent)");
  expect(terminalWait).toContain(
    "observeAuthenticatedCgroup(state.cgroupPath, state.cgroupIdentity)",
  );
});

it("binds the root-mediated PID 1 probe to one stable manager identity", () => {
  const snapshot = {
    bootId: "01234567-89ab-cdef-0123-456789abcdef",
    startTime: "123456",
  };
  const manager = {
    dev: 42,
    digest: "a".repeat(64),
    gid: 0,
    ino: 84,
    mode: 0o100755,
    size: 4096,
    uid: 0,
  };
  const probe = {
    after: snapshot,
    before: snapshot,
    digestOutput: `${manager.digest} */proc/1/exe\0`,
    firstTarget: "/usr/lib/systemd/systemd\n",
    manager,
    secondTarget: "/usr/lib/systemd/systemd\n",
    statOutput: `${manager.dev}:${manager.ino}:${manager.mode.toString(16)}:0:0:${manager.size}\n`,
  };
  expect(validateRootPid1Probe(probe)).toBe(true);
  for (const substituted of [
    { ...probe, before: { ...snapshot, startTime: "123455" } },
    {
      ...probe,
      after: { ...snapshot, bootId: snapshot.bootId.replace("0", "1") },
    },
    { ...probe, firstTarget: "/usr/bin/false\n" },
    { ...probe, secondTarget: "/usr/bin/false\n" },
    { ...probe, statOutput: probe.statOutput.replace(":84:", ":85:") },
    { ...probe, manager: { ...manager, uid: 1 } },
    { ...probe, manager: { ...manager, gid: 1 } },
    { ...probe, manager: { ...manager, mode: 0o100777 } },
    { ...probe, manager: { ...manager, size: 4095 } },
    { ...probe, statOutput: `${probe.statOutput}extra\n` },
    { ...probe, digestOutput: `${"b".repeat(64)} */proc/1/exe\0` },
    { ...probe, digestOutput: `${probe.digestOutput}\n` },
  ])
    expect(validateRootPid1Probe(substituted)).toBe(false);
  expect(rootPid1ProbeRequired({ code: "EACCES" })).toBe(true);
  expect(rootPid1ProbeRequired({ code: "EPERM" })).toBe(true);
  for (const error of [undefined, null, {}, { code: "ENOENT" }, "EACCES"])
    expect(rootPid1ProbeRequired(error)).toBe(false);
});

it("binds the live Node mapping across systemd admission", () => {
  const executable = {
    dev: 42,
    digest: "a".repeat(64),
    gid: 1001,
    ino: 84,
    mode: 0o100777,
    size: 125_000_000,
    uid: 1001,
  };
  const before = {
    bootId: "01234567-89ab-cdef-0123-456789abcdef",
    executable,
    pid: 1234,
    startTime: "5678",
  };
  expect(validateLiveMappedExecutable({ after: before, before })).toBe(true);
  for (const after of [
    { ...before, pid: 1235 },
    { ...before, startTime: "5679" },
    { ...before, bootId: before.bootId.replace("0", "1") },
    { ...before, executable: { ...executable, dev: 43 } },
    { ...before, executable: { ...executable, ino: 85 } },
    { ...before, executable: { ...executable, mode: 0o100755 } },
    { ...before, executable: { ...executable, uid: 1002 } },
    { ...before, executable: { ...executable, gid: 1002 } },
    { ...before, executable: { ...executable, size: executable.size + 1 } },
    { ...before, executable: { ...executable, digest: "b".repeat(64) } },
  ])
    expect(validateLiveMappedExecutable({ after, before })).toBe(false);
  expect(
    validateLiveMappedExecutable({
      after: before,
      before: { ...before, pid: 1 },
    }),
  ).toBe(false);
});

it("binds the canonical hosted Python identity and exact helper capabilities", () => {
  const source = readFileSync(
    resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
    "utf8",
  );
  const executable = {
    canonical: "/usr/bin/python3.12",
    dev: 42,
    digest: "a".repeat(64),
    gid: 0,
    ino: 84,
    mode: 0o100755,
    size: 6_000_000,
    uid: 0,
  };
  const receipt = "agentscope-python-helper-v1\n";
  expect(
    validatePythonAuthority({
      after: executable,
      before: executable,
      probe: receipt,
    }),
  ).toBe(true);
  const nextRunnerExecutable = {
    ...executable,
    canonical: "/usr/bin/python3.13",
    digest: "b".repeat(64),
    ino: 85,
  };
  expect(
    validatePythonAuthority({
      after: nextRunnerExecutable,
      before: nextRunnerExecutable,
      probe: receipt,
    }),
  ).toBe(true);
  for (const [after, probe] of [
    [{ ...executable, canonical: "/tmp/python3" }, receipt],
    [{ ...executable, dev: 43 }, receipt],
    [{ ...executable, ino: 85 }, receipt],
    [{ ...executable, mode: 0o100777 }, receipt],
    [{ ...executable, uid: 1001 }, receipt],
    [{ ...executable, gid: 1001 }, receipt],
    [{ ...executable, size: executable.size + 1 }, receipt],
    [{ ...executable, digest: "b".repeat(64) }, receipt],
    [executable, ""],
    [executable, `${receipt}extra`],
  ] as const)
    expect(validatePythonAuthority({ after, before: executable, probe })).toBe(
      false,
    );
  expect(source).toContain('const pythonPath = "/usr/bin/python3";');
  expect(source).not.toContain('readlinkSync(pythonPath) !== "python3.12"');
  expect(source).toContain("authenticateRootOwnedComponents(current)");
  expect(source).toContain("await authenticatePython(deadline)");
  expect(source).toContain("pythonCapabilitySource");
});

it("snapshots a closed systemd environment and rejects valid-form drift", () => {
  const environment = {
    AGENTSCOPE_INTEGRATION_REPLAY: "1",
    AGENTSCOPE_INTEGRATION_SHARD: "0/1",
    GITHUB_ACTIONS: "true",
    GITHUB_JOB: "hermetic-platform",
    GITHUB_REPOSITORY: "Melbourneandrew/agentscope",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "1234",
    GITHUB_SHA: "a".repeat(40),
    LANG: "C.UTF-8",
    PATH: "/usr/bin:/bin",
    RUNNER_ENVIRONMENT: "github-hosted",
  };
  const snapshot = snapshotSystemdEnvironment(environment);
  expect(snapshot).not.toBe(environment);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(sameSystemdEnvironment(snapshot, environment)).toBe(true);
  for (const substitution of [
    { ...environment, GITHUB_SHA: "b".repeat(40) },
    { ...environment, AGENTSCOPE_INTEGRATION_REPLAY: "2" },
    { ...environment, AGENTSCOPE_INTEGRATION_SHARD: "1/2" },
    { ...environment, EXTRA_AUTHORITY: "present" },
  ])
    expect(sameSystemdEnvironment(snapshot, substitution)).toBe(false);
  const removed = { ...environment };
  delete (removed as Partial<typeof environment>).LANG;
  expect(sameSystemdEnvironment(snapshot, removed)).toBe(false);
  expect(() =>
    snapshotSystemdEnvironment(
      Object.defineProperty({}, "GITHUB_SHA", { get: () => "a".repeat(40) }),
    ),
  ).toThrow("integration.controller.systemd-containment");
});

it("snapshots systemd arguments from one closed descriptor inventory", () => {
  const arguments_ = ["fixture.mjs", "--mode=stubborn"];
  const snapshot = snapshotSystemdArguments(arguments_);
  expect(snapshot).not.toBe(arguments_);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(snapshot).toEqual(arguments_);
  expect(sameSystemdArguments(snapshot, arguments_)).toBe(true);
  expect(
    sameSystemdArguments(snapshot, ["fixture.mjs", "--mode=substituted"]),
  ).toBe(false);

  const accessor: string[] = [];
  Object.defineProperty(accessor, "0", {
    configurable: true,
    enumerable: true,
    get: () => "fixture.mjs",
  });
  accessor.length = 1;
  expect(() => snapshotSystemdArguments(accessor)).toThrow(
    "integration.controller.systemd-containment",
  );

  const sparse = Array<string>(1);
  expect(() => snapshotSystemdArguments(sparse)).toThrow(
    "integration.controller.systemd-containment",
  );

  const symbolized = ["fixture.mjs"];
  Object.defineProperty(symbolized, Symbol("authority"), {
    value: "substituted",
  });
  expect(() => snapshotSystemdArguments(symbolized)).toThrow(
    "integration.controller.systemd-containment",
  );

  const extended = ["fixture.mjs"] as string[] & { authority?: string };
  extended.authority = "substituted";
  expect(() => snapshotSystemdArguments(extended)).toThrow(
    "integration.controller.systemd-containment",
  );

  let descriptorReads = 0;
  const stateful = new Proxy(["fixture.mjs"], {
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property !== "0" || descriptor === undefined) return descriptor;
      descriptorReads += 1;
      return {
        ...descriptor,
        value: descriptorReads === 1 ? "fixture.mjs" : "substituted.mjs",
      };
    },
  });
  const statefulSnapshot = snapshotSystemdArguments(stateful);
  expect(statefulSnapshot).toEqual(["fixture.mjs"]);
  expect(descriptorReads).toBe(1);
  expect(sameSystemdArguments(statefulSnapshot, stateful)).toBe(false);
  expect(descriptorReads).toBe(2);
});

it("separates bounded preparation from the consumed execution deadline", () => {
  const supervisorSource = readFileSync(
    resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
    "utf8",
  );
  const preparationStart = supervisorSource.indexOf(
    "export const prepareGithubSystemdSupervision = async",
  );
  const preparationEnd = supervisorSource.indexOf(
    "const closePreparedSystemdState = async",
  );
  const start = supervisorSource.indexOf("const systemdLifecycleReason =");
  const end = supervisorSource.indexOf(
    "export const runSupervisedProcess",
    start,
  );
  const lifecycle = supervisorSource.slice(start, end);
  const preparation = supervisorSource.slice(preparationStart, preparationEnd);
  expect(supervisorSource).toContain(
    "const containmentProofMilliseconds = 5_000;",
  );
  expect(preparation).toContain(
    "const preparationDeadline =\n    performance.now() + systemdPreparationMilliseconds;",
  );
  expect(supervisorSource).toContain(
    "const systemdPreparationMilliseconds = 15_000;",
  );
  expect(preparation.match(/captureLiveMappedExecutable\(/gu)).toHaveLength(1);
  expect(preparation.match(/recheckLiveMappedExecutable\(/gu)).toHaveLength(1);
  expect(lifecycle.match(/recheckLiveMappedExecutable\(/gu)).toHaveLength(3);
  expect(preparation).not.toContain("systemdStartArguments({");
  expect(lifecycle).toContain("systemdStartArguments({");
  expect(preparation).toContain("await closePreparedSystemdState(state)");
  expect(preparation).not.toContain("state.unitMayExist = true;");
  expect(lifecycle).toContain("state.unitMayExist = true;");
  expect(lifecycle).toContain(
    'mutationDeadline: executionDeadline,\n        operation: "systemd-submit",\n        unit: authority.unit,',
  );
  expect(preparation).not.toContain('operation: "systemd-submit"');
  expect(preparation).not.toContain('"unit-admission"');
  expect(preparation).toContain("preparationDeadline,");
  expect(preparation).toContain(
    "const arguments_ = snapshotSystemdArguments(suppliedArguments);",
  );
  expect(lifecycle).toContain(
    "!sameSystemdArguments(state.arguments_, suppliedArguments)",
  );
  expect(lifecycle).toContain(
    "({ deadline, executionDeadline } = systemdConsumptionDeadlines(\n      maximumMilliseconds,\n      performance.now(),\n    ));",
  );
  expect(
    lifecycle.indexOf("state.preparationDeadline <= performance.now()"),
  ).toBeLessThan(lifecycle.indexOf("systemdConsumptionDeadlines("));
  expect(lifecycle).toContain(
    "const grace = Math.min(\n      state.deadline,\n      performance.now() + systemdTerminationGraceMilliseconds,",
  );
  expect(lifecycle).toContain(
    "closePreparedGithubSystemdSupervision(prepared)",
  );
  const capture = supervisorSource.slice(
    supervisorSource.indexOf("const captureLiveMappedExecutable ="),
    supervisorSource.indexOf("const recheckLiveMappedExecutable ="),
  );
  expect(capture.match(/digestRetainedExecutable\(/gu)).toHaveLength(1);
  expect(capture).toContain(
    "Linux binds an open file description to the mapped executable inode",
  );
  expect(capture).toContain(
    "openSync(`/proc/${process.pid}/exe`, constants.O_RDONLY)",
  );
});

it("starts the full execution budget only when preparation is consumed", () => {
  const maximumMilliseconds = 15_000;
  const preparationStarted = 1_000;
  const consumedAfterDelayedPreparation = 14_750;
  const deadlines = systemdConsumptionDeadlines(
    maximumMilliseconds,
    consumedAfterDelayedPreparation,
  );
  expect(deadlines).toEqual({
    deadline: 29_750,
    executionDeadline: 24_750,
  });
  expect(deadlines.deadline - consumedAfterDelayedPreparation).toBe(
    maximumMilliseconds,
  );
  expect(deadlines.deadline).not.toBe(preparationStarted + maximumMilliseconds);
  const productionNow = performance.now();
  expect(
    systemdConsumptionDeadlines(maximumMilliseconds, productionNow),
  ).toEqual({
    deadline: Math.floor(productionNow) + maximumMilliseconds,
    executionDeadline: Math.floor(productionNow) + maximumMilliseconds - 5_000,
  });
  expect(systemdConsumptionDeadlines(maximumMilliseconds, 0.25)).toEqual({
    deadline: 15_000,
    executionDeadline: 10_000,
  });
  expect(systemdConsumptionDeadlines(maximumMilliseconds, 12_345.6789)).toEqual(
    {
      deadline: 27_345,
      executionDeadline: 22_345,
    },
  );
  expect(systemdConsumptionDeadlines(maximumMilliseconds, 123_456.789)).toEqual(
    {
      deadline: 138_456,
      executionDeadline: 133_456,
    },
  );
  const shortened = systemdConsumptionDeadlines(maximumMilliseconds, 0.999);
  expect(shortened.deadline).toBeLessThan(0.999 + maximumMilliseconds);
  expect(shortened.deadline).toBe(Math.floor(0.999) + maximumMilliseconds);
  expect(shortened.deadline - Math.floor(0.999)).toBe(maximumMilliseconds);
  expect(() => systemdConsumptionDeadlines(5_000, 1_000)).toThrow(
    "integration.controller.systemd-containment",
  );
  for (const invalidNow of [
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    -0.001,
    Number.MAX_SAFE_INTEGER - maximumMilliseconds + 1,
    Number.MAX_SAFE_INTEGER,
  ])
    expect(() =>
      systemdConsumptionDeadlines(maximumMilliseconds, invalidNow),
    ).toThrow("integration.controller.systemd-containment");
});

it("binds root helpers to one absolute boottime authority", () => {
  const supervisorSource = readFileSync(
    resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
    "utf8",
  );
  const preparationStart = supervisorSource.indexOf(
    "export const prepareGithubSystemdSupervision = async",
  );
  const preparationEnd = supervisorSource.indexOf(
    "const closePreparedSystemdState = async",
  );
  const lifecycleStart = supervisorSource.indexOf(
    "const systemdLifecycleReason =",
  );
  const lifecycleEnd = supervisorSource.indexOf(
    "export const runSupervisedProcess",
    lifecycleStart,
  );
  const preparation = supervisorSource.slice(preparationStart, preparationEnd);
  const lifecycle = supervisorSource.slice(lifecycleStart, lifecycleEnd);
  const tool = supervisorSource.slice(
    supervisorSource.indexOf("const runTool ="),
    supervisorSource.indexOf("const rootTool ="),
  );
  expect(
    tool.indexOf("const timeout = remainingMilliseconds(deadline);"),
  ).toBeLessThan(tool.indexOf("const child = spawn("));
  expect(tool).toContain('child.once("close", (code, signal) => {');
  expect(supervisorSource).toContain(
    "authenticateExecutable(timeoutPath, 0o111);",
  );
  const rootTool = supervisorSource.slice(
    supervisorSource.indexOf("const rootTool ="),
    supervisorSource.indexOf("const exactUnitFacts ="),
  );
  expect(rootTool).toContain(
    "rootToolKillAfterMilliseconds + rootToolJoinReserveMilliseconds",
  );
  expect(rootTool).toContain(
    "const observationDeadline = deadline + rootToolJoinReserveMilliseconds;",
  );
  expect(rootTool).toContain(
    "const rootTimeoutSeconds = `${(timeout / 1_000).toFixed(3)}s`;",
  );
  expect(rootTool).toContain(
    'timeoutPath,\n      "--signal=TERM",\n      `--kill-after=${killAfterSeconds}`,\n      rootTimeoutSeconds,',
  );
  expect(rootTool).toContain(
    'pythonPath,\n      "-I",\n      "-S",\n      "-c",\n      rootHelperSource,',
  );
  expect(rootTool).toContain("absoluteBoottimeDeadline(deadline)");
  expect(rootTool).toContain(
    "observationDeadline,\n    { acceptClosedFailure: true, forceDeadline },",
  );
  expect(rootTool).not.toContain(
    "absoluteBoottimeDeadline(observationDeadline)",
  );
  expect(rootTool).toContain(
    "absoluteBoottimeDeadline(\n    effectiveMutationDeadline,",
  );
  const rootHelper = supervisorSource.slice(
    supervisorSource.indexOf("const rootHelperSource ="),
    supervisorSource.indexOf("const cgroupRoot ="),
  );
  expect(rootHelper).toContain(
    "if OPERATION not in OPERATIONS or tool!=OPERATIONS[OPERATION]",
  );
  expect(rootHelper).toContain("leader,expected,control=create_group()");
  expect(rootHelper).toContain("inherited_group=os.getpgrp()");
  expect(rootHelper).toContain("expected_start=observed[0]");
  expect(rootHelper).toContain("os.setpgid(leader,leader)");
  expect(rootHelper).toContain("error.errno!=errno.EACCES");
  expect(rootHelper).not.toContain("now()+250000000\n expected=None");
  expect(rootHelper).toContain("observed[1]!=inherited_group");
  expect(rootHelper).toContain('def emit(status,output=b""):');
  expect(rootHelper).toContain(
    'if now()>=cutoff or now()>=DEADLINE: raise RuntimeError("cutoff")',
  );
  expect(
    rootHelper.indexOf("leader,expected,control=create_group()"),
  ).toBeLessThan(
    rootHelper.indexOf(
      'if now()>=cutoff or now()>=DEADLINE: raise RuntimeError("cutoff")',
    ),
  );
  expect(
    rootHelper.indexOf(
      'if now()>=cutoff or now()>=DEADLINE: raise RuntimeError("cutoff")',
    ),
  ).toBeLessThan(rootHelper.indexOf("child=subprocess.Popen("));
  expect(rootHelper).toContain("process_group=leader,close_fds=True");
  expect(rootHelper).toContain("signal.signal(signal.SIGTERM,signal.SIG_IGN)");
  expect(rootHelper).toContain("os.killpg(leader,signal.SIGTERM)");
  expect(rootHelper).toContain("os.killpg(leader,signal.SIGKILL)");
  expect(rootHelper).toContain("os.waitpid(leader,os.WNOHANG)");
  expect(rootHelper).not.toContain("os.waitpid(leader,0)");
  expect(rootHelper.indexOf("os.waitpid(leader,os.WNOHANG)")).toBeLessThan(
    rootHelper.indexOf(
      "if not leader_reaped or group_present(leader) or child.returncode is None",
    ),
  );
  expect(rootHelper).toContain("if not reconcile(unit): uncertain=True");
  expect(rootHelper).toContain("failed_reason=REASON");
  expect(rootHelper.indexOf("failed_reason=REASON")).toBeLessThan(
    rootHelper.indexOf("if not reconcile(unit): uncertain=True"),
  );
  expect(
    rootHelper.indexOf("if not reconcile(unit): uncertain=True"),
  ).toBeLessThan(rootHelper.lastIndexOf("REASON=failed_reason"));
  expect(preparation).not.toContain('operation: "systemd-submit"');
  expect(preparation).not.toContain('"unit-admission"');
  expect(lifecycle).toContain('operation: "systemd-submit"');
  expect(lifecycle).toContain('executionDeadline,\n      "unit-admission",');
  expect(lifecycle).toContain(
    'executionDeadline,\n      "unit-authoritative",',
  );
  expect(lifecycle).not.toContain(
    "const authoritative = await showUnit(authority.unit, deadline);",
  );
});

it("bounds root-wrapper force and group settlement inside the join reserve", () => {
  const supervisorSource = readFileSync(
    resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
    "utf8",
  );
  const tool = supervisorSource.slice(
    supervisorSource.indexOf("const runTool ="),
    supervisorSource.indexOf("const rootTool ="),
  );
  const rootTool = supervisorSource.slice(
    supervisorSource.indexOf("const rootTool ="),
    supervisorSource.indexOf("const exactUnitFacts ="),
  );
  expect(supervisorSource).toContain(
    "const rootToolKillAfterMilliseconds = 250;",
  );
  expect(supervisorSource).toContain(
    "const rootToolJoinReserveMilliseconds = 500;",
  );
  expect(supervisorSource).toContain(
    "const rootToolSentinelPreparationMilliseconds = 500;",
  );
  expect(supervisorSource).toContain(
    "const rootToolHelperTeardownReserveMilliseconds = 750;",
  );
  expect(rootTool).toContain(
    "const forceDeadline = deadline + rootToolKillAfterMilliseconds;",
  );
  expect(tool).toContain(
    "const boundedForceDeadline = forceDeadline ?? deadline;",
  );
  expect(tool).toContain(
    "if (!validateToolLeaderSnapshot(leader, observed)) failSystemd();",
  );
  expect(tool).toContain(
    "forced = forceState.forceAttempted;\n      if (forceState.reappeared) authorityUncertain = true;\n      if (forceState.shouldForce) {\n        authorityUncertain = true;",
  );
  expect(tool).toContain("absent = groupIsAbsent(child.pid);");
  expect(tool).toContain('if (decision === "terminal") {');
  expect(tool.indexOf('signalGroup(child.pid, "SIGKILL");')).toBeLessThan(
    tool.indexOf('if (decision === "failure")'),
  );
  expect(tool.indexOf('child.once("close",')).toBeLessThan(
    tool.lastIndexOf("const observed = readProcessSnapshot(child.pid);"),
  );
  expect(tool).toContain(
    "initial identity uncertainty must use\n      // the same bounded close/absence envelope rather than rejecting early.",
  );
});

it("reserves sentinel preparation without extending mutation authority", () => {
  const supervisorSource = readFileSync(
    resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
    "utf8",
  );
  const rootHelper = supervisorSource.slice(
    supervisorSource.indexOf("const rootHelperSource ="),
    supervisorSource.indexOf("const cgroupRoot ="),
  );
  expect(rootHelper).toContain("SENTINEL_PREPARATION=500000000");
  expect(rootHelper).toContain("TEARDOWN_RESERVE=750000000");
  expect(rootHelper).toContain("sentinel_started=now()");
  expect(rootHelper).toContain(
    "boundary=min(sentinel_started+SENTINEL_PREPARATION,DEADLINE-TEARDOWN_RESERVE)",
  );
  expect(rootHelper).not.toContain("boundary=min(CUTOFF,");
  expect(rootHelper).toContain('STAGE="cutoff"\n  REASON=""');
  expect(rootToolHasPreparationBudget(2_000, 749)).toBe(true);
  expect(rootToolHasPreparationBudget(2_000, 750)).toBe(false);
  expect(rootToolHasPreparationBudget(2_000, 751)).toBe(false);
  expect(rootToolHasPreparationBudget(Number.POSITIVE_INFINITY, 0)).toBe(false);
});

it("observes root-wrapper close and group absence in either order", () => {
  const initial = {
    deadline: 1_500,
    forceAttempted: false,
    groupAbsent: false,
    now: 1_000,
    terminalObserved: false,
  };
  expect(classifyToolSettlement({ ...initial, groupAbsent: true })).toBe(
    "wait",
  );
  expect(classifyToolSettlement({ ...initial, terminalObserved: true })).toBe(
    "wait",
  );
  expect(
    classifyToolSettlement({
      ...initial,
      groupAbsent: true,
      now: 1_499,
      terminalObserved: true,
    }),
  ).toBe("terminal");
  expect(
    classifyToolSettlement({
      ...initial,
      forceAttempted: true,
      groupAbsent: true,
      now: 1_499,
      terminalObserved: true,
    }),
  ).toBe("failure");
  expect(
    classifyToolSettlement({
      ...initial,
      groupAbsent: true,
      now: 1_500,
      terminalObserved: true,
    }),
  ).toBe("failure");
  expect(
    classifyToolSettlement({
      ...initial,
      groupAbsent: true,
      now: 1_501,
      terminalObserved: true,
    }),
  ).toBe("failure");
  expect(
    classifyToolSettlement({
      ...initial,
      groupAbsent: true,
      now: 1_500,
    }),
  ).toBe("failure");
});

it("retains pre-force absence through bounded receipt drain", () => {
  const initial = {
    absenceProved: false,
    forceAttempted: false,
    forceDeadline: 1_250,
    groupAbsent: true,
    now: 1_200,
  };
  const absentBeforeForce = advanceToolForceState(initial);
  expect(absentBeforeForce).toEqual({
    absenceProved: true,
    forceAttempted: false,
    reappeared: false,
    shouldForce: false,
  });
  const stillAbsentAtForce = advanceToolForceState({
    ...initial,
    ...absentBeforeForce,
    now: 1_250,
  });
  expect(stillAbsentAtForce.forceAttempted).toBe(false);
  expect(
    classifyToolSettlement({
      deadline: 1_500,
      forceAttempted: stillAbsentAtForce.forceAttempted,
      groupAbsent: true,
      now: 1_300,
      terminalObserved: true,
    }),
  ).toBe("terminal");
  expect(
    advanceToolForceState({
      ...initial,
      ...absentBeforeForce,
      groupAbsent: false,
      now: 1_250,
    }),
  ).toMatchObject({ forceAttempted: true, reappeared: true });
  expect(advanceToolForceState({ ...initial, now: 1_250 })).toMatchObject({
    absenceProved: false,
    forceAttempted: true,
    shouldForce: true,
  });
});

it("rejects root-wrapper leader reuse and group substitution", () => {
  const leader = {
    bootId: "00000000-0000-0000-0000-000000000001",
    pid: 71,
    processGroup: 71,
    startTime: "900",
  };
  expect(validateToolLeaderSnapshot(leader, { ...leader })).toBe(true);
  expect(
    validateToolLeaderSnapshot(leader, { ...leader, startTime: "901" }),
  ).toBe(false);
  expect(
    validateToolLeaderSnapshot(leader, { ...leader, processGroup: 72 }),
  ).toBe(false);
  expect(
    validateToolLeaderSnapshot(leader, {
      ...leader,
      bootId: "00000000-0000-0000-0000-000000000002",
    }),
  ).toBe(false);
});

it("revokes helper control before joining only its authenticated process set", () => {
  const supervisorSource = readFileSync(
    resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
    "utf8",
  );
  const rootHelper = supervisorSource.slice(
    supervisorSource.indexOf("const rootHelperSource ="),
    supervisorSource.indexOf("const cgroupRoot ="),
  );
  expect(rootHelper).toContain(
    'if not progressed: raise RuntimeError("residual")',
  );
  expect(rootHelper).toContain(
    "if child_record is None or child_record[1]!=leader or child_record[2]!=os.getpid()",
  );
  expect(rootHelper).toContain(
    "expected_members={leader:leader_record,child.pid:child_record}",
  );
  expect(rootHelper).toContain(
    "parent is not None and parent_record is not None and parent_record==parent",
  );
  expect(rootHelper).toContain("admit_group_members(leader,expected_members)");
  expect(rootHelper).toContain("settle_boundary=DEADLINE-750000000");
  expect(rootHelper).toContain(
    'REASON="identity-drift"\n observed_before_revoke=',
  );
  expect(rootHelper).toContain(
    'if observed_before_revoke!=expected: raise RuntimeError("identity")',
  );
  expect(rootHelper).toContain(
    'REASON="control-close"\n if os.write(control,b"\\x00")!=1',
  );
  expect(rootHelper).toContain(
    'if os.read(control_read,1)!=b"\\x00": raise RuntimeError("control-revoke")',
  );
  expect(rootHelper).toContain("while any(pid!=leader for pid in records):");
  expect(rootHelper).toContain(
    'if now()>=settle_boundary: raise RuntimeError("residual")',
  );
  expect(
    rootHelper.indexOf("admit_group_members(leader,expected_members)"),
  ).toBeLessThan(rootHelper.indexOf('os.write(control,b"\\x00")'));
  expect(rootHelper.indexOf('os.write(control,b"\\x00")')).toBeLessThan(
    rootHelper.indexOf("while any(pid!=leader for pid in records):"),
  );
  expect(
    rootHelper.indexOf("while any(pid!=leader for pid in records):"),
  ).toBeLessThan(
    rootHelper.indexOf('REASON="control-close"\n try: os.close(control)'),
  );
  expect(
    rootHelper.indexOf('REASON="control-close"\n try: os.close(control)'),
  ).toBeLessThan(
    rootHelper.indexOf(
      "while now()<DEADLINE:",
      rootHelper.indexOf("def close_group"),
    ),
  );
});

it.runIf(existsSync("/usr/bin/python3"))(
  "accepts only the canonical bounded proc stat record framing",
  () => {
    const supervisorSource = readFileSync(
      resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
      "utf8",
    );
    const helperPrefix = "const rootHelperSource = String.raw`";
    const helperStart =
      supervisorSource.indexOf(helperPrefix) + helperPrefix.length;
    const helperEnd = supervisorSource.indexOf(
      "`;\nconst cgroupRoot =",
      helperStart,
    );
    const helper = supervisorSource.slice(helperStart, helperEnd);
    const parserStart = helper.indexOf("def parse_process_fields(data,pid):");
    const parserEnd = helper.indexOf("def group_members(group):", parserStart);
    expect(parserStart).toBeGreaterThanOrEqual(0);
    expect(parserEnd).toBeGreaterThan(parserStart);
    const parser = helper.slice(parserStart, parserEnd);
    const invoke = (record: Buffer) =>
      spawnSync(
        "/usr/bin/python3",
        [
          "-I",
          "-S",
          "-c",
          `import base64,sys\n${parser}\ntry:\n result=parse_process_identity(base64.urlsafe_b64decode(sys.argv[1]),123)\nexcept Exception:\n sys.exit(17)\nif result!=(b"456",123): sys.exit(18)`,
          record.toString("base64url"),
        ],
        { encoding: "utf8", env: {}, timeout: 3_000 },
      );
    const fields = [
      "S",
      "1",
      "123",
      ...Array.from({ length: 16 }, () => "0"),
      "456",
    ];
    const canonical = Buffer.from(`123 (fixture comm) ${fields.join(" ")}\n`);
    expect(invoke(canonical)).toMatchObject({
      status: 0,
      signal: null,
      stderr: "",
    });
    for (const rejected of [
      canonical.subarray(0, -1),
      Buffer.concat([canonical, Buffer.from("\n")]),
      Buffer.concat([canonical.subarray(0, -2), Buffer.from("\n0\n")]),
      Buffer.from(canonical.toString("utf8").replace("fixture", "fix\rture")),
      Buffer.concat([
        canonical.subarray(0, 8),
        Buffer.from([0]),
        canonical.subarray(8),
      ]),
      Buffer.concat([
        Buffer.from("123 ("),
        Buffer.alloc(4090, 97),
        Buffer.from(") S 1 123 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 456\n"),
      ]),
    ])
      expect(invoke(rejected)).toMatchObject({
        status: 17,
        signal: null,
        stderr: "",
      });
  },
);

it.runIf(existsSync("/usr/bin/python3"))(
  "admits only identity-bound live descendants into the helper process set",
  () => {
    const supervisorSource = readFileSync(
      resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
      "utf8",
    );
    const helperPrefix = "const rootHelperSource = String.raw`";
    const helperStart =
      supervisorSource.indexOf(helperPrefix) + helperPrefix.length;
    const helperEnd = supervisorSource.indexOf(
      "`;\nconst cgroupRoot =",
      helperStart,
    );
    const helper = supervisorSource.slice(helperStart, helperEnd);
    const admissionStart = helper.indexOf(
      "def admit_group_members(group,expected_members):",
    );
    const admissionEnd = helper.indexOf("def create_group():", admissionStart);
    expect(admissionStart).toBeGreaterThanOrEqual(0);
    expect(admissionEnd).toBeGreaterThan(admissionStart);
    const admission = helper.slice(admissionStart, admissionEnd);
    const invoke = (records: Record<string, [string, number, number]>) =>
      spawnSync(
        "/usr/bin/python3",
        [
          "-I",
          "-S",
          "-c",
          `import json,sys\nrecords={int(key):(value[0].encode("ascii"),value[1],value[2]) for key,value in json.loads(sys.argv[1]).items()}\ndef group_records(group,expected_members=None): return records\n${admission}\nexpected={10:(b"100",10,1),11:(b"110",10,1)}\ntry:\n admit_group_members(10,expected)\nexcept Exception:\n sys.exit(17)\nif expected!={10:(b"100",10,1),11:(b"110",10,1),12:(b"120",10,11)}: sys.exit(18)`,
          JSON.stringify(records),
        ],
        { encoding: "utf8", env: {}, timeout: 3_000 },
      );
    expect(
      invoke({
        10: ["100", 10, 1],
        11: ["110", 10, 1],
        12: ["120", 10, 11],
      }),
    ).toMatchObject({ status: 0, signal: null, stderr: "" });
    for (const rejected of [
      {
        10: ["100", 10, 1],
        12: ["120", 10, 11],
      },
      {
        10: ["100", 10, 1],
        11: ["substituted", 10, 1],
        12: ["120", 10, 11],
      },
      {
        10: ["100", 10, 1],
        11: ["110", 10, 1],
        12: ["120", 10, 99],
      },
    ] as Array<Record<string, [string, number, number]>>)
      expect(invoke(rejected)).toMatchObject({
        status: 17,
        signal: null,
        stderr: "",
      });
  },
);

it.runIf(existsSync("/usr/bin/python3"))(
  "parses PID 1 and target-group parent identity without weakening framing",
  () => {
    const supervisorSource = readFileSync(
      resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
      "utf8",
    );
    const helperPrefix = "const rootHelperSource = String.raw`";
    const helperStart =
      supervisorSource.indexOf(helperPrefix) + helperPrefix.length;
    const helperEnd = supervisorSource.indexOf(
      "`;\nconst cgroupRoot =",
      helperStart,
    );
    const helper = supervisorSource.slice(helperStart, helperEnd);
    const parserStart = helper.indexOf("def parse_process_fields(data,pid):");
    const parserEnd = helper.indexOf("def process_record(pid):", parserStart);
    const parser = helper.slice(parserStart, parserEnd);
    const invoke = (pid: number, ppid: string, pgrp: string) => {
      const fields = [
        "S",
        ppid,
        pgrp,
        ...Array.from({ length: 16 }, () => "0"),
        "456",
      ];
      const record = Buffer.from(`${pid} (fixture) ${fields.join(" ")}\n`);
      return spawnSync(
        "/usr/bin/python3",
        [
          "-I",
          "-S",
          "-c",
          `import base64,sys\n${parser}\nraw=sys.argv[1]\ntry:\n result=parse_process_record(base64.urlsafe_b64decode(raw+"="*((4-len(raw)%4)%4)),${pid})\nexcept Exception:\n sys.exit(17)\nif result!=(b"456",${pgrp},${/^\d+$/u.test(ppid) ? ppid : "0"}): sys.exit(18)`,
          record.toString("base64url"),
        ],
        { encoding: "utf8", env: {}, timeout: 3_000 },
      );
    };
    expect(invoke(1, "0", "1")).toMatchObject({
      status: 0,
      signal: null,
      stderr: "",
    });
    expect(invoke(123, "11", "123")).toMatchObject({
      status: 0,
      signal: null,
      stderr: "",
    });
    expect(invoke(2, "0", "0")).toMatchObject({
      status: 17,
      signal: null,
      stderr: "",
    });
    for (const ppid of ["-1", "+1", "x", "1x"])
      expect(invoke(123, ppid, "123")).toMatchObject({
        status: 17,
        signal: null,
        stderr: "",
      });
  },
);

it.runIf(existsSync("/usr/bin/python3"))(
  "filters fully framed foreign process groups before target admission",
  () => {
    const supervisorSource = readFileSync(
      resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
      "utf8",
    );
    const helperPrefix = "const rootHelperSource = String.raw`";
    const helperStart =
      supervisorSource.indexOf(helperPrefix) + helperPrefix.length;
    const helperEnd = supervisorSource.indexOf(
      "`;\nconst cgroupRoot =",
      helperStart,
    );
    const helper = supervisorSource.slice(helperStart, helperEnd);
    const parserStart = helper.indexOf("def parse_process_fields(data,pid):");
    const parserEnd = helper.indexOf("def group_members(group):", parserStart);
    const parser = helper.slice(parserStart, parserEnd);
    const record = (pid: number, ppid: string, pgrp: string, start = "456") =>
      Buffer.from(
        `${pid} (fixture) ${[
          "S",
          ppid,
          pgrp,
          ...Array.from({ length: 16 }, () => "0"),
          start,
        ].join(" ")}\n`,
      ).toString("base64url");
    const invoke = (
      records: Record<string, string>,
      entries: string[],
      expectedMembers?: Record<string, [string, number, number]>,
      expectedResult: Record<string, [string, number, number]> = {
        "10": ["456", 10, 1],
      },
    ) =>
      spawnSync(
        "/usr/bin/python3",
        [
          "-I",
          "-S",
          "-c",
          `import base64,io,json,sys,types
payload=json.loads(sys.argv[1])
records={key:base64.urlsafe_b64decode(value+"="*((4-len(value)%4)%4)) for key,value in payload["records"].items()}
os=types.SimpleNamespace(listdir=lambda path:payload["entries"])
def open(path,mode): return io.BytesIO(records[path.split("/")[2]])
${parser}
try:
 expected=None if payload.get("expected") is None else {int(key):(value[0].encode("ascii"),value[1],value[2]) for key,value in payload["expected"].items()}
 result=group_records(10,expected)
except Exception:
 sys.exit(17)
expected_result={int(key):(value[0].encode("ascii"),value[1],value[2]) for key,value in payload["result"].items()}
if result!=expected_result: sys.exit(18)`,
          JSON.stringify({
            entries,
            expected: expectedMembers,
            records,
            result: expectedResult,
          }),
        ],
        { encoding: "utf8", env: {}, timeout: 3_000 },
      );
    expect(
      invoke({ "1": record(1, "0", "0"), "10": record(10, "1", "10") }, [
        "1",
        "10",
      ]),
    ).toMatchObject({ status: 0, signal: null, stderr: "" });
    expect(
      invoke(
        { "10": record(10, "1", "10"), "11": record(11, "10", "10") },
        ["10"],
        { "10": ["456", 10, 1], "11": ["456", 10, 10] },
        { "10": ["456", 10, 1], "11": ["456", 10, 10] },
      ),
    ).toMatchObject({ status: 0, signal: null, stderr: "" });
    for (const rejected of [
      { "1": record(1, "0", "x"), "10": record(10, "1", "10") },
      { "1": record(1, "0", "0"), "10": record(10, "1", "10", "0") },
    ])
      expect(invoke(rejected, ["1", "10"])).toMatchObject({
        status: 17,
        signal: null,
        stderr: "",
      });
    expect(invoke({ "10": record(10, "1", "10") }, ["10", "10"])).toMatchObject(
      { status: 17, signal: null, stderr: "" },
    );
    expect(
      invoke(
        { "10": record(10, "1", "10"), "11": record(11, "10", "11") },
        ["10", "11"],
        { "10": ["456", 10, 1], "11": ["456", 10, 10] },
      ),
    ).toMatchObject({ status: 17, signal: null, stderr: "" });
    for (const changed of [
      record(11, "10", "10", "789"),
      record(11, "1", "10"),
    ])
      expect(
        invoke({ "10": record(10, "1", "10"), "11": changed }, ["10", "11"], {
          "10": ["456", 10, 1],
          "11": ["456", 10, 10],
        }),
      ).toMatchObject({ status: 17, signal: null, stderr: "" });
    expect(
      invoke(
        { "10": record(10, "1", "10"), "11": record(11, "10", "11") },
        ["10"],
        { "10": ["456", 10, 1], "11": ["456", 10, 10] },
      ),
    ).toMatchObject({ status: 17, signal: null, stderr: "" });
  },
);

const syntheticClientRunGlobalBoundary =
  "def run(argv,cutoff,operation_stage):\n global STAGE,REASON\n";
const syntheticClientSpawnBoundary =
  '  child=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env={"LANG":"C.UTF-8","PATH":"/usr/bin:/bin"},process_group=leader,close_fds=True)\n';
const syntheticGatedChildSource = [
  "import json,os,sys",
  'if sys.stdin.buffer.read(1)!=b"x": sys.exit(125)',
  "args=json.loads(sys.argv[1])",
  'os.execve(args[0],args,{"LANG":"C.UTF-8","PATH":"/usr/bin:/bin"})',
].join("\n");
const syntheticPreparationMilliseconds = 15_000;
const syntheticObservationReserveMilliseconds = 5_000;
const syntheticPreparationNanoseconds =
  syntheticPreparationMilliseconds * 1_000_000;
const syntheticObservationMilliseconds =
  syntheticPreparationMilliseconds + syntheticObservationReserveMilliseconds;
const syntheticDiagnosticOperations = new Set([
  "synthetic-client-cutoff",
  "synthetic-client-cutoff-cleanup-failure",
  "synthetic-client-deadline",
  "synthetic-client-leader-identity",
  "synthetic-client-child-admission",
  "synthetic-client-member-identity",
  "synthetic-client-output-read",
  "synthetic-client-output-bound",
  "synthetic-client-nonzero",
  "synthetic-client-internal",
]);
const syntheticDiagnosticReasonsByStage = new Map<string, ReadonlySet<string>>([
  ["startup", new Set([""])],
  ["cutoff", new Set([""])],
  [
    "sentinel",
    new Set([
      "child-exit",
      "start-identity",
      "inherited-group",
      "transition-timeout",
      "kill",
      "reap-join",
      "residual",
      "internal-unknown",
    ]),
  ],
  ["tool-spawn", new Set([""])],
  [
    "client-terminal",
    new Set([
      "cutoff",
      "deadline",
      "leader-identity",
      "child-admission",
      "member-identity",
      "output-read",
      "output-bound",
      "nonzero-terminal",
      "internal-unknown",
    ]),
  ],
  ["unit-admission", new Set([""])],
  ["retirement", new Set([""])],
  [
    "join",
    new Set([
      "leader-identity",
      "preclose-residual",
      "control-close",
      "reap-timeout",
      "identity-drift",
      "postreap-residual",
      "internal-unknown",
    ]),
  ],
]);
const syntheticDiagnosticReceiptPattern =
  /^\{"mac":"[0-9a-f]{64}","output":"","reason":"([a-z-]*)","stage":"(startup|cutoff|sentinel|tool-spawn|client-terminal|unit-admission|retirement|join)","status":"(error|uncertain)"\}$/;

const syntheticReadinessFailure = (operation: string, stdout: string) => {
  const admittedOperation = syntheticDiagnosticOperations.has(operation)
    ? operation
    : "unknown-operation";
  let stage = "malformed";
  let reason = "none";
  const match = syntheticDiagnosticReceiptPattern.exec(stdout);
  if (match) {
    const [, candidateReason, candidateStage] = match;
    if (
      candidateReason !== undefined &&
      candidateStage !== undefined &&
      syntheticDiagnosticReasonsByStage
        .get(candidateStage)
        ?.has(candidateReason)
    ) {
      stage = candidateStage;
      reason = candidateReason || "none";
    }
  }
  return new Error(
    `synthetic helper readiness missing:${admittedOperation}:${stage}:${reason}`,
  );
};

const synchronizeSyntheticClientDeadlines = (helper: string) => {
  const deadlineArm =
    " DEADLINE=int(sys.argv[1]); CUTOFF=int(sys.argv[2]); OPERATION=sys.argv[3]\n tool=sys.argv[4]; raw=sys.argv[5]; unit=sys.argv[6]; KEY=sys.argv[7]\n";
  const readinessSynchronizedHelper = helper.replace(
    deadlineArm,
    deadlineArm +
      ' if OPERATION.startswith("synthetic-client-"):\n' +
      "  armed=now()\n" +
      `  DEADLINE=armed+${syntheticPreparationNanoseconds}\n` +
      `  CUTOFF=armed+${syntheticPreparationNanoseconds}\n` +
      " TEST_READY=False\n" +
      " TEST_CHILD=None\n" +
      " def test_ready(leader,expected):\n" +
      "  global TEST_READY,TEST_CHILD\n" +
      '  if TEST_READY: raise RuntimeError("readiness")\n' +
      '  if TEST_CHILD is None or TEST_CHILD.stdin is None: raise RuntimeError("readiness")\n' +
      '  os.write(3,(str(leader)+":"+str(expected[0])+":"+str(DEADLINE)+":"+str(CUTOFF)+"\\n").encode("ascii"))\n' +
      '  TEST_CHILD.stdin.write(b"x")\n' +
      "  TEST_CHILD.stdin.flush()\n" +
      "  TEST_CHILD.stdin.close()\n" +
      "  TEST_READY=True\n",
  );
  const syntheticRunHelper = readinessSynchronizedHelper.replace(
    syntheticClientRunGlobalBoundary,
    "def run(argv,cutoff,operation_stage):\n global STAGE,REASON,TEST_CHILD\n",
  );
  const gatedChildHelper = syntheticRunHelper.replace(
    syntheticClientSpawnBoundary,
    '  if OPERATION.startswith("synthetic-client-"):\n' +
      `   argv=["/usr/bin/python3","-I","-S","-c",${JSON.stringify(syntheticGatedChildSource)},json.dumps(argv,separators=(",",":"))]\n` +
      '  child=subprocess.Popen(argv,stdin=subprocess.PIPE if OPERATION.startswith("synthetic-client-") else subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env={"LANG":"C.UTF-8","PATH":"/usr/bin:/bin"},process_group=leader,close_fds=True)\n' +
      '  if OPERATION.startswith("synthetic-client-"): TEST_CHILD=child\n',
  );
  const groupEstablishedBoundary =
    " leader,expected,control=create_group()\n child=None\n";
  const childAdmissionBoundary =
    '  child_record=None if OPERATION=="synthetic-client-child-admission" else process_record(child.pid)\n';
  const childSynchronizedHelper = gatedChildHelper.replace(
    childAdmissionBoundary,
    '  if OPERATION=="synthetic-client-child-admission": test_ready(leader,expected)\n' +
      childAdmissionBoundary,
  );
  const memberIdentityBoundary =
    '  if OPERATION=="synthetic-client-member-identity": expected_members[child.pid]=("0",child_record[1],child_record[2])\n';
  const identitySynchronizedHelper = childSynchronizedHelper.replace(
    memberIdentityBoundary,
    '  if OPERATION in {"synthetic-client-leader-identity","synthetic-client-member-identity","synthetic-client-internal"}: test_ready(leader,expected)\n' +
      memberIdentityBoundary,
  );
  const postAdmissionBoundary =
    '  if OPERATION=="synthetic-client-output-read": child.stdout.close()\n  while child.poll() is None:\n';
  const synchronizedHelper = identitySynchronizedHelper.replace(
    postAdmissionBoundary,
    '  if OPERATION.startswith("synthetic-client-") and OPERATION not in {"synthetic-client-leader-identity","synthetic-client-child-admission","synthetic-client-member-identity","synthetic-client-internal"}:\n' +
      "   admit_group_members(leader,expected_members)\n" +
      '   if OPERATION=="synthetic-client-deadline": DEADLINE=now()-1\n' +
      '   elif OPERATION in {"synthetic-client-cutoff","synthetic-client-cutoff-cleanup-failure"}: CUTOFF=now()-1\n' +
      "   test_ready(leader,expected)\n" +
      '  if OPERATION=="synthetic-client-output-read": child.stdout.close()\n' +
      "  while child.poll() is None:\n",
  );
  return {
    childAdmissionBoundary,
    childSpawnBoundary: syntheticClientSpawnBoundary,
    deadlineArm,
    gatedChildHelper,
    groupEstablishedBoundary,
    runGlobalBoundary: syntheticClientRunGlobalBoundary,
    childSynchronizedHelper,
    identitySynchronizedHelper,
    postAdmissionBoundary,
    readinessSynchronizedHelper,
    synchronizedHelper,
  };
};

const parseSyntheticClientReadiness = (
  readiness: unknown,
  expected?: Readonly<{ leader: string; start: string }>,
) => {
  if (
    typeof readiness !== "string" ||
    !/^[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]{6,19}:[1-9][0-9]{6,19}\n$/u.test(
      readiness,
    )
  )
    return undefined;
  const [leader, start, deadline, cutoff] = readiness.trimEnd().split(":") as [
    string,
    string,
    string,
    string,
  ];
  if (
    ![leader, start].every(
      (value) =>
        value !== undefined &&
        Number.isSafeInteger(Number(value)) &&
        Number(value) > 0,
    ) ||
    ![deadline, cutoff].every(
      (value) => value !== undefined && BigInt(value) > 0n,
    )
  )
    return undefined;
  if (
    expected !== undefined &&
    (leader !== expected.leader || start !== expected.start)
  )
    return undefined;
  return Object.freeze({ cutoff, deadline, leader, start });
};

it("bounds synthetic readiness observation beyond its cleanup authority", () => {
  expect(syntheticObservationMilliseconds).toBe(
    syntheticPreparationMilliseconds + syntheticObservationReserveMilliseconds,
  );
  expect(syntheticObservationReserveMilliseconds).toBeGreaterThan(0);
  expect(syntheticObservationMilliseconds).toBeLessThan(30_000);
});

it("accepts only exact post-precondition synthetic client readiness", () => {
  const valid = "123:456:1000000:2000000\n";
  expect(
    parseSyntheticClientReadiness(valid, { leader: "123", start: "456" }),
  ).toEqual({
    cutoff: "2000000",
    deadline: "1000000",
    leader: "123",
    start: "456",
  });
  expect(
    parseSyntheticClientReadiness(
      "123:456:10000000000000000:10000000000000001\n",
    ),
  ).toEqual({
    cutoff: "10000000000000001",
    deadline: "10000000000000000",
    leader: "123",
    start: "456",
  });
  for (const invalid of [
    "",
    "123:456\n",
    "123::1000000:2000000\n",
    "0:456:1000000:2000000\n",
    "123:456:1000000:2000000:extra\n",
    "123:substituted:1000000:2000000\n",
  ])
    expect(parseSyntheticClientReadiness(invalid)).toBeUndefined();
  expect(
    parseSyntheticClientReadiness(valid, { leader: "124", start: "456" }),
  ).toBeUndefined();
  expect(
    parseSyntheticClientReadiness(valid, { leader: "123", start: "457" }),
  ).toBeUndefined();
  expect(
    syntheticReadinessFailure(
      "synthetic-client-cutoff",
      `{"mac":"${"a".repeat(64)}","output":"","reason":"cutoff","stage":"client-terminal","status":"error"}`,
    ).message,
  ).toBe(
    "synthetic helper readiness missing:synthetic-client-cutoff:client-terminal:cutoff",
  );
  for (const [
    admittedStage,
    admittedReasons,
  ] of syntheticDiagnosticReasonsByStage)
    for (const admittedReason of admittedReasons)
      for (const admittedStatus of ["error", "uncertain"])
        expect(
          syntheticReadinessFailure(
            "synthetic-client-internal",
            `{"mac":"${"b".repeat(64)}","output":"","reason":"${admittedReason}","stage":"${admittedStage}","status":"${admittedStatus}"}`,
          ).message,
        ).toBe(
          `synthetic helper readiness missing:synthetic-client-internal:${admittedStage}:${admittedReason || "none"}`,
        );
  expect(
    syntheticReadinessFailure(
      "raw:\nvalue",
      `{"mac":"${"a".repeat(64)}","output":"","reason":"cutoff","stage":"client-terminal","status":"error"}`,
    ).message,
  ).toBe(
    "synthetic helper readiness missing:unknown-operation:client-terminal:cutoff",
  );
  for (const substituted of [
    "{}",
    `{"mac":"${"a".repeat(64)}","output":"","reason":"unknown","stage":"client-terminal","status":"error"}`,
    `{"mac":"${"a".repeat(64)}","output":"","reason":"cutoff","stage":"startup","status":"error"}`,
    `{"mac":"${"a".repeat(64)}","output":"","reason":"cutoff","stage":"client-terminal","stage":"client-terminal","status":"error"}`,
    `{"mac":"${"a".repeat(64)}","output":"","reason":"cutoff","stage":"client-terminal","status":"error","extra":true}`,
    `{"output":"","mac":"${"a".repeat(64)}","reason":"cutoff","stage":"client-terminal","status":"error"}`,
    `{"mac":"${"a".repeat(64)}","output":"data","reason":"cutoff","stage":"client-terminal","status":"error"}`,
    `{"mac":"${"a".repeat(64)}","output":"","reason":"cutoff","stage":"client-terminal","status":"ok"}`,
    "truncated",
  ])
    expect(
      syntheticReadinessFailure("synthetic-client-cutoff", substituted).message,
    ).toBe(
      "synthetic helper readiness missing:synthetic-client-cutoff:malformed:none",
    );
});

it.runIf(process.platform === "linux" && existsSync("/usr/bin/python3"))(
  "admits the canonical PID 1 parent identity while inventorying proc",
  () => {
    const supervisorSource = readFileSync(
      resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
      "utf8",
    );
    const helperPrefix = "const rootHelperSource = String.raw`";
    const helperStart =
      supervisorSource.indexOf(helperPrefix) + helperPrefix.length;
    const helperEnd = supervisorSource.indexOf(
      "`;\nconst cgroupRoot =",
      helperStart,
    );
    const helper = supervisorSource.slice(helperStart, helperEnd);
    const parserStart = helper.indexOf("def parse_process_fields(data,pid):");
    const parserEnd = helper.indexOf("def create_group():", parserStart);
    const procInventory = helper.slice(parserStart, parserEnd);
    const terminal = spawnSync(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-c",
        `import os\n${procInventory}\nrecord=process_record(1)\nif record is None or record[2]!=0: raise SystemExit(17)\ngroup_records(2147483647)`,
      ],
      { encoding: "utf8", env: {}, timeout: 3_000 },
    );
    expect(terminal).toMatchObject({ status: 0, signal: null, stderr: "" });
  },
);

it.runIf(process.platform === "linux" && existsSync("/usr/bin/python3"))(
  "preserves an originating join reason across successful and uncertain cleanup",
  () => {
    const supervisorSource = readFileSync(
      resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
      "utf8",
    );
    const prefix = "const rootHelperSource = String.raw`";
    const start = supervisorSource.indexOf(prefix) + prefix.length;
    const end = supervisorSource.indexOf("`;\nconst cgroupRoot =", start);
    const helper = supervisorSource.slice(start, end);
    expect(
      helper.match(/\n[ ]{4}terminate\(child,leader,expected,control\)/gu),
    ).toHaveLength(1);
    const encodedArguments = Buffer.from(
      JSON.stringify(["-I", "-S", "-c", "import sys; sys.exit(0)"]),
    ).toString("base64url");
    for (const [operation, status, reason] of [
      ["synthetic-join-failure", "error", "preclose-residual"],
      ["synthetic-join-cleanup-failure", "uncertain", "preclose-residual"],
      ["synthetic-join-identity-drift", "error", "identity-drift"],
    ] as const) {
      const uptime = readFileSync("/proc/uptime", "utf8").split(" ")[0];
      if (uptime === undefined || !/^\d+\.\d+$/u.test(uptime))
        throw new Error("invalid synthetic boottime authority");
      const [seconds, fraction] = uptime.split(".");
      if (seconds === undefined || fraction === undefined)
        throw new Error("invalid synthetic boottime authority");
      const now =
        BigInt(seconds) * 1_000_000_000n +
        BigInt(fraction.slice(0, 2).padEnd(2, "0")) * 10_000_000n;
      const deadline = String(now + 2_000_000_000n);
      const cutoff = String(now + 1_000_000_000n);
      const key = operation.endsWith("cleanup-failure")
        ? "8".repeat(64)
        : "7".repeat(64);
      const terminal = spawnSync(
        "/usr/bin/python3",
        [
          "-I",
          "-S",
          "-c",
          helper,
          deadline,
          cutoff,
          operation,
          "/usr/bin/python3",
          encodedArguments,
          "",
          key,
        ],
        {
          encoding: "utf8",
          env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
          timeout: 3_000,
        },
      );
      expect(terminal).toMatchObject({ status: 1, signal: null, stderr: "" });
      expect(
        validateRootToolReceipt({
          identity: { cutoff, deadline, operation, unit: "" },
          key,
          receipt: terminal.stdout,
        }),
      ).toEqual({
        output: "",
        reason,
        stage: "join",
        status,
      });
    }
  },
);

it.runIf(process.platform === "linux" && existsSync("/usr/bin/python3"))(
  "retains the helper group leader until a fast leader descendant is joined",
  () => {
    const supervisorSource = readFileSync(
      resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
      "utf8",
    );
    const prefix = "const rootHelperSource = String.raw`";
    const start = supervisorSource.indexOf(prefix) + prefix.length;
    const end = supervisorSource.indexOf("`;\nconst cgroupRoot =", start);
    expect(start).toBeGreaterThan(prefix.length);
    expect(end).toBeGreaterThan(start);
    const helper = supervisorSource.slice(start, end);
    const testCode =
      'import signal,subprocess,sys,time; subprocess.Popen([sys.executable,"-I","-S","-c","import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(30)","agentscope-root-helper-descendant"],stdout=sys.stdout,stderr=subprocess.DEVNULL); sys.exit(0)';
    const encodedArguments = Buffer.from(
      JSON.stringify(["-I", "-S", "-c", testCode]),
    ).toString("base64url");
    const uptime = readFileSync("/proc/uptime", "utf8").split(" ")[0];
    if (uptime === undefined || !/^\d+\.\d+$/u.test(uptime))
      throw new Error("invalid synthetic boottime authority");
    const [seconds, fraction] = uptime.split(".");
    if (seconds === undefined || fraction === undefined)
      throw new Error("invalid synthetic boottime authority");
    const now =
      BigInt(seconds) * 1_000_000_000n +
      BigInt(fraction.slice(0, 2).padEnd(2, "0")) * 10_000_000n;
    const deadline = String(now + 2_000_000_000n);
    const cutoff = String(now + 500_000_000n);
    const key = "a".repeat(64);
    const terminal = spawnSync(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-c",
        helper,
        deadline,
        cutoff,
        "synthetic-descendant",
        "/usr/bin/python3",
        encodedArguments,
        "",
        key,
      ],
      {
        encoding: "utf8",
        env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
        timeout: 3_000,
      },
    );
    expect(terminal).toMatchObject({ signal: null, status: 1, stderr: "" });
    expect(
      validateRootToolReceipt({
        identity: {
          cutoff,
          deadline,
          operation: "synthetic-descendant",
          unit: "",
        },
        key,
        receipt: terminal.stdout,
      }),
    ).toMatchObject({ output: "", status: "error" });
    const survivors = readdirSync("/proc").filter((entry) => {
      if (!/^\d+$/u.test(entry)) return false;
      try {
        return readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(
          "agentscope-root-helper-descendant",
        );
      } catch {
        return false;
      }
    });
    expect(survivors).toEqual([]);
  },
);

it.runIf(process.platform === "linux" && existsSync("/usr/bin/python3"))(
  "admits a delayed sentinel transition under the original absolute cutoff",
  () => {
    const supervisorSource = readFileSync(
      resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
      "utf8",
    );
    const prefix = "const rootHelperSource = String.raw`";
    const start = supervisorSource.indexOf(prefix) + prefix.length;
    const end = supervisorSource.indexOf("`;\nconst cgroupRoot =", start);
    const helper = supervisorSource.slice(start, end);
    const testCode = "import sys; sys.exit(0)";
    const encodedArguments = Buffer.from(
      JSON.stringify(["-I", "-S", "-c", testCode]),
    ).toString("base64url");
    const uptime = readFileSync("/proc/uptime", "utf8").split(" ")[0];
    if (uptime === undefined || !/^\d+\.\d+$/u.test(uptime))
      throw new Error("invalid synthetic boottime authority");
    const [seconds, fraction] = uptime.split(".");
    if (seconds === undefined || fraction === undefined)
      throw new Error("invalid synthetic boottime authority");
    const now =
      BigInt(seconds) * 1_000_000_000n +
      BigInt(fraction.slice(0, 2).padEnd(2, "0")) * 10_000_000n;
    const deadline = String(now + 3_000_000_000n);
    const cutoff = String(now + 1_500_000_000n);
    const key = "c".repeat(64);
    const terminal = spawnSync(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-c",
        helper,
        deadline,
        cutoff,
        "synthetic-delayed-sentinel",
        "/usr/bin/python3",
        encodedArguments,
        "",
        key,
      ],
      {
        encoding: "utf8",
        env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
        timeout: 4_000,
      },
    );
    expect(terminal).toMatchObject({ signal: null, status: 0, stderr: "" });
    expect(
      validateRootToolReceipt({
        identity: {
          cutoff,
          deadline,
          operation: "synthetic-delayed-sentinel",
          unit: "",
        },
        key,
        receipt: terminal.stdout,
      }),
    ).toEqual({
      output: "",
      reason: "",
      stage: "client-terminal",
      status: "ok",
    });
  },
);

it.runIf(process.platform === "linux" && existsSync("/usr/bin/python3"))(
  "classifies setpgid EACCES and non-EACCES branches without unknown state",
  () => {
    const supervisorSource = readFileSync(
      resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
      "utf8",
    );
    const prefix = "const rootHelperSource = String.raw`";
    const start = supervisorSource.indexOf(prefix) + prefix.length;
    const end = supervisorSource.indexOf("`;\nconst cgroupRoot =", start);
    const helper = supervisorSource.slice(start, end);
    const encodedArguments = Buffer.from(
      JSON.stringify(["-I", "-S", "-c", "import sys; sys.exit(0)"]),
    ).toString("base64url");
    for (const [operation, expected] of [
      [
        "synthetic-setpgid-eacces",
        { reason: "", stage: "client-terminal", status: "ok" },
      ],
      [
        "synthetic-setpgid-non-eacces",
        { reason: "inherited-group", stage: "sentinel", status: "error" },
      ],
    ] as const) {
      const uptime = readFileSync("/proc/uptime", "utf8").split(" ")[0];
      if (uptime === undefined || !/^\d+\.\d+$/u.test(uptime))
        throw new Error("invalid synthetic boottime authority");
      const [seconds, fraction] = uptime.split(".");
      if (seconds === undefined || fraction === undefined)
        throw new Error("invalid synthetic boottime authority");
      const now =
        BigInt(seconds) * 1_000_000_000n +
        BigInt(fraction.slice(0, 2).padEnd(2, "0")) * 10_000_000n;
      const deadline = String(now + 3_000_000_000n);
      const cutoff = String(now + 1_500_000_000n);
      const key = operation.endsWith("eacces")
        ? "4".repeat(64)
        : "5".repeat(64);
      const terminal = spawnSync(
        "/usr/bin/python3",
        [
          "-I",
          "-S",
          "-c",
          helper,
          deadline,
          cutoff,
          operation,
          "/usr/bin/python3",
          encodedArguments,
          "",
          key,
        ],
        {
          encoding: "utf8",
          env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
          timeout: 4_000,
        },
      );
      expect(terminal).toMatchObject({
        signal: null,
        status: expected.status === "ok" ? 0 : 1,
        stderr: "",
      });
      expect(
        validateRootToolReceipt({
          identity: { cutoff, deadline, operation, unit: "" },
          key,
          receipt: terminal.stdout,
        }),
      ).toEqual({ output: "", ...expected });
      expect(terminal.stdout).not.toContain("internal-unknown");
    }
  },
);

it.runIf(process.platform === "linux" && existsSync("/usr/bin/python3"))(
  "establishes the sentinel before rejecting expired mutation authority",
  () => {
    const supervisorSource = readFileSync(
      resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
      "utf8",
    );
    const prefix = "const rootHelperSource = String.raw`";
    const start = supervisorSource.indexOf(prefix) + prefix.length;
    const end = supervisorSource.indexOf("`;\nconst cgroupRoot =", start);
    const helper = supervisorSource.slice(start, end);
    const encodedArguments = Buffer.from(
      JSON.stringify(["-I", "-S", "-c", "import sys; sys.exit(0)"]),
    ).toString("base64url");
    const uptime = readFileSync("/proc/uptime", "utf8").split(" ")[0];
    if (uptime === undefined || !/^\d+\.\d+$/u.test(uptime))
      throw new Error("invalid synthetic boottime authority");
    const [seconds, fraction] = uptime.split(".");
    if (seconds === undefined || fraction === undefined)
      throw new Error("invalid synthetic boottime authority");
    const now =
      BigInt(seconds) * 1_000_000_000n +
      BigInt(fraction.slice(0, 2).padEnd(2, "0")) * 10_000_000n;
    const deadline = String(now + 3_000_000_000n);
    const cutoff = String(now + 200_000_000n);
    const key = "d".repeat(64);
    const terminal = spawnSync(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-c",
        helper,
        deadline,
        cutoff,
        "synthetic-delayed-sentinel",
        "/usr/bin/python3",
        encodedArguments,
        "",
        key,
      ],
      {
        encoding: "utf8",
        env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
        timeout: 4_000,
      },
    );
    expect(terminal).toMatchObject({ signal: null, status: 1, stderr: "" });
    expect(
      validateRootToolReceipt({
        identity: {
          cutoff,
          deadline,
          operation: "synthetic-delayed-sentinel",
          unit: "",
        },
        key,
        receipt: terminal.stdout,
      }),
    ).toEqual({
      output: "",
      reason: "",
      stage: "cutoff",
      status: "error",
    });
  },
);

it.runIf(process.platform === "linux" && existsSync("/usr/bin/python3"))(
  "retains the primary sentinel reason when cleanup is uncertain",
  () => {
    const supervisorSource = readFileSync(
      resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
      "utf8",
    );
    const prefix = "const rootHelperSource = String.raw`";
    const start = supervisorSource.indexOf(prefix) + prefix.length;
    const end = supervisorSource.indexOf("`;\nconst cgroupRoot =", start);
    const helper = supervisorSource.slice(start, end);
    const encodedArguments = Buffer.from(
      JSON.stringify(["-I", "-S", "-c", "import sys; sys.exit(0)"]),
    ).toString("base64url");
    const uptime = readFileSync("/proc/uptime", "utf8").split(" ")[0];
    if (uptime === undefined || !/^\d+\.\d+$/u.test(uptime))
      throw new Error("invalid synthetic boottime authority");
    const [seconds, fraction] = uptime.split(".");
    if (seconds === undefined || fraction === undefined)
      throw new Error("invalid synthetic boottime authority");
    const now =
      BigInt(seconds) * 1_000_000_000n +
      BigInt(fraction.slice(0, 2).padEnd(2, "0")) * 10_000_000n;
    const deadline = String(now + 3_000_000_000n);
    const cutoff = String(now + 200_000_000n);
    const key = "e".repeat(64);
    const terminal = spawnSync(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-c",
        helper,
        deadline,
        cutoff,
        "synthetic-sentinel-cleanup-failure",
        "/usr/bin/python3",
        encodedArguments,
        "",
        key,
      ],
      {
        encoding: "utf8",
        env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
        timeout: 4_000,
      },
    );
    expect(terminal).toMatchObject({ signal: null, status: 1, stderr: "" });
    expect(
      validateRootToolReceipt({
        identity: {
          cutoff,
          deadline,
          operation: "synthetic-sentinel-cleanup-failure",
          unit: "",
        },
        key,
        receipt: terminal.stdout,
      }),
    ).toEqual({
      output: "",
      reason: "transition-timeout",
      stage: "sentinel",
      status: "uncertain",
    });
  },
);

it.runIf(process.platform === "linux" && existsSync("/usr/bin/python3"))(
  "retains the originating stage when helper cleanup is uncertain",
  () => {
    const supervisorSource = readFileSync(
      resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
      "utf8",
    );
    const prefix = "const rootHelperSource = String.raw`";
    const start = supervisorSource.indexOf(prefix) + prefix.length;
    const end = supervisorSource.indexOf("`;\nconst cgroupRoot =", start);
    const helper = supervisorSource.slice(start, end);
    const testCode = "import sys; sys.exit(17)";
    const encodedArguments = Buffer.from(
      JSON.stringify(["-I", "-S", "-c", testCode]),
    ).toString("base64url");
    const uptime = readFileSync("/proc/uptime", "utf8").split(" ")[0];
    if (uptime === undefined || !/^\d+\.\d+$/u.test(uptime))
      throw new Error("invalid synthetic boottime authority");
    const [seconds, fraction] = uptime.split(".");
    if (seconds === undefined || fraction === undefined)
      throw new Error("invalid synthetic boottime authority");
    const now =
      BigInt(seconds) * 1_000_000_000n +
      BigInt(fraction.slice(0, 2).padEnd(2, "0")) * 10_000_000n;
    const deadline = String(now + 2_000_000_000n);
    const cutoff = String(now + 500_000_000n);
    const key = "b".repeat(64);
    const terminal = spawnSync(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-c",
        helper,
        deadline,
        cutoff,
        "synthetic-cleanup-failure",
        "/usr/bin/python3",
        encodedArguments,
        "",
        key,
      ],
      {
        encoding: "utf8",
        env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
        timeout: 3_000,
      },
    );
    expect(terminal).toMatchObject({ signal: null, status: 1, stderr: "" });
    expect(
      validateRootToolReceipt({
        identity: {
          cutoff,
          deadline,
          operation: "synthetic-cleanup-failure",
          unit: "",
        },
        key,
        receipt: terminal.stdout,
      }),
    ).toEqual({
      output: "",
      reason: "nonzero-terminal",
      stage: "client-terminal",
      status: "uncertain",
    });
  },
);

it("authenticates a closed root-helper stage receipt against its operation identity", () => {
  const stages = [
    "startup",
    "cutoff",
    "sentinel",
    "tool-spawn",
    "unit-admission",
    "retirement",
    "join",
  ] as const;
  const key = "1".repeat(64);
  const identity = {
    cutoff: "100",
    deadline: "200",
    operation: "unit-admission",
    unit: "agentscope-test.service",
  };
  const reasonForStage = (stage: string) =>
    stage === "sentinel"
      ? "transition-timeout"
      : stage === "join"
        ? "leader-identity"
        : "";
  const receiptFor = (
    stage: string,
    status = "error",
    output = "",
    reason = reasonForStage(stage),
  ) => {
    const mac = createHmac("sha256", Buffer.from(key, "hex"))
      .update(
        JSON.stringify({
          cutoff: identity.cutoff,
          deadline: identity.deadline,
          operation: identity.operation,
          output,
          reason,
          stage,
          status,
          unit: identity.unit,
        }),
      )
      .digest("hex");
    return JSON.stringify({ mac, output, reason, stage, status });
  };
  for (const stage of stages)
    expect(
      validateRootToolReceipt({
        identity,
        key,
        receipt: receiptFor(stage),
      }),
    ).toEqual({
      output: "",
      reason: reasonForStage(stage),
      stage,
      status: "error",
    });

  expect(
    validateRootToolReceipt({
      identity,
      key,
      receipt: receiptFor("unknown"),
    }),
  ).toBeUndefined();
  const valid = receiptFor("unit-admission");
  for (const substitutedIdentity of [
    { ...identity, operation: "unit-monitor" },
    { ...identity, unit: "agentscope-other.service" },
    { ...identity, deadline: "201" },
    { ...identity, cutoff: "101" },
  ])
    expect(
      validateRootToolReceipt({
        identity: substitutedIdentity,
        key,
        receipt: valid,
      }),
    ).toBeUndefined();
  expect(
    validateRootToolReceipt({ identity, key, receipt: valid.slice(0, -1) }),
  ).toBeUndefined();
  expect(
    validateRootToolReceipt({
      identity,
      key,
      receipt: valid.replace('"output":""', '"output":"","output":""'),
    }),
  ).toBeUndefined();
  for (const substituted of [
    valid.replace('"status":"error"', '"status":"unknown"'),
    valid.replace('"output":""', '"output":"YQ"'),
    valid.replace('"stage":"unit-admission"', '"stage":"join"'),
    valid.replace('"reason":""', '"reason":"unknown"'),
    valid.replace(/\}$/u, ',"extra":false}'),
  ])
    expect(
      validateRootToolReceipt({ identity, key, receipt: substituted }),
    ).toBeUndefined();
  expect(
    validateRootToolReceipt({
      identity: { ...identity, operation: "unknown" },
      key,
      receipt: valid,
    }),
  ).toBeUndefined();
  expect(
    validateRootToolReceipt({
      identity,
      key: "2".repeat(64),
      receipt: valid,
    }),
  ).toBeUndefined();
  expect(
    systemdToolFailureStage(
      new Error("integration.controller.systemd-tool:unit-admission"),
    ),
  ).toBeUndefined();
});

it("admits only the closed systemd lifecycle diagnostic inventory", () => {
  const phases = [
    "mapped-executable-pre-submit",
    "unit-admission",
    "terminal-wait",
    "unit-authoritative",
    "cgroup-observation",
    "termination",
    "retirement",
    "collection",
  ] as const;
  const reasons = [
    "deadline",
    "interrupted",
    "authority",
    "malformed",
    "internal",
  ] as const;
  for (const phase of phases)
    for (const reason of reasons)
      expect(
        validSystemdLifecyclePredicate(`lifecycle:${phase}:${reason}`),
      ).toBe(true);
  for (const reason of [
    "authority-load",
    "authority-identity",
    "authority-cgroup",
    "authority-hardening",
    "authority-principal",
    "cgroup-retained",
    "cgroup-path",
    "unit-show",
    "unit-command",
    "descriptor-close",
  ]) {
    expect(
      validSystemdLifecyclePredicate(`lifecycle:retirement:${reason}`),
    ).toBe(true);
    expect(
      validSystemdLifecyclePredicate(`lifecycle:unit-authoritative:${reason}`),
    ).toBe(false);
  }
  for (const reason of [
    "unit-show",
    "unit-facts",
    "load-state",
    "cgroup-absence",
  ]) {
    expect(
      validSystemdLifecyclePredicate(`lifecycle:collection:${reason}`),
    ).toBe(true);
    expect(
      validSystemdLifecyclePredicate(`lifecycle:terminal-wait:${reason}`),
    ).toBe(reason === "unit-show");
  }
  for (const rejected of [
    undefined,
    "",
    "lifecycle:unknown:deadline",
    "lifecycle:terminal-wait:unknown",
    "lifecycle:terminal-wait:deadline:extra",
    "lifecycle:retirement:cgroup-retained:extra",
    "lifecycle:retirement:unknown",
    "lifecycle:collection:unknown",
    "lifecycle:collection:unit-show:extra",
    "lifecycle::deadline",
    "lifecycle:terminal-wait:",
    "lifecycle:terminal-wait:deadline\nlifecycle:collection:deadline",
  ])
    expect(validSystemdLifecyclePredicate(rejected)).toBe(false);
  expect(
    systemdToolFailureStage(
      new Error(
        "integration.controller.systemd-tool:lifecycle:terminal-wait:deadline",
      ),
    ),
  ).toBeUndefined();

  const supervisor = readFileSync(
    resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
    "utf8",
  );
  const retirement = supervisor.slice(
    supervisor.indexOf("const retireAndCollectSystemdUnit ="),
    supervisor.indexOf("const runSystemdSupervised ="),
  );
  expect(retirement).toContain("state.retirementDiagnosticReason = reason;");
  expect(retirement.indexOf("markDiagnostic,")).toBeLessThan(
    retirement.indexOf("await retireUnit("),
  );
  const retireUnit = supervisor.slice(
    supervisor.indexOf("const retireUnit ="),
    supervisor.indexOf("const systemdEnvironmentArguments ="),
  );
  expect(retireUnit.indexOf('"unit-show"')).toBeLessThan(
    retireUnit.indexOf("await showUnit("),
  );
  expect(retireUnit.indexOf('"unit-command"')).toBeLessThan(
    retireUnit.indexOf('if (facts.ActiveState === "failed")'),
  );
  expect(supervisor).toContain(
    'state.retirementDiagnosticReason = "descriptor-close";',
  );
  for (const phase of phases)
    expect(supervisor).toContain(`state.lifecyclePhase = "${phase}"`);
  expect(supervisor).toContain(
    "if (systemdToolFailureStage(error) !== undefined) throw error;",
  );
  expect(supervisor).toContain("executionDeadline: state.executionDeadline,");
  expect(supervisor).toContain("deadline: state.deadline,");

  const action = readFileSync(
    resolve(workspaceRoot, "tests/integration/upload-failure-evidence.mjs"),
    "utf8",
  );
  expect(action).toContain("const stage = systemdToolFailureStage(error);");
  expect(action).toContain(
    "`::error::integration.controller.systemd-tool:${stage}\\n`",
  );
  expect(action).not.toContain("error.message");
  expect(action).not.toContain("error.stack");
});

it("admits only the closed unit-admission diagnostic inventory", () => {
  const reasons = [
    "mapped-executable",
    "unit-facts",
    "authority-load",
    "authority-identity",
    "authority-cgroup",
    "authority-hardening",
    "authority-principal",
    "cgroup-authentication",
    "main-pid-unavailable",
    "main-pid-malformed",
    "main-pid-mismatch",
    "main-pid-terminal-unit-state",
    "main-snapshot-before",
    "main-members",
    "main-snapshot-after",
    "main-identity",
  ] as const satisfies readonly SystemdUnitAdmissionDiagnosticReason[];
  const exhaustive: Exclude<
    SystemdUnitAdmissionDiagnosticReason,
    (typeof reasons)[number]
  > extends never
    ? true
    : false = true;
  expect(exhaustive).toBe(true);
  for (const reason of reasons)
    expect(
      validSystemdLifecyclePredicate(`lifecycle:unit-admission:${reason}`),
    ).toBe(true);
  for (const reason of [
    "mapped-executable-substituted",
    "cgroup",
    "membership",
  ])
    expect(
      validSystemdLifecyclePredicate(`lifecycle:unit-admission:${reason}`),
    ).toBe(false);

  const supervisor = readFileSync(
    resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
    "utf8",
  );
  const admission = supervisor.slice(
    supervisor.indexOf("const admitSystemdUnit ="),
    supervisor.indexOf("const observeSystemdTerminal ="),
  );
  for (const [reason, boundary] of [
    ['"mapped-executable"', "recheckLiveMappedExecutable("],
    ['"unit-facts"', "await showUnit("],
    ["`authority-${authorityMismatch}`", "failSystemd();"],
    ['"cgroup-authentication"', "authenticateCgroup("],
    ['"main-pid-malformed"', "captureMainProcessMembership("],
  ] as const)
    expect(admission.indexOf(reason)).toBeLessThan(admission.indexOf(boundary));
  const membershipStart = supervisor.indexOf(
    "const captureMainProcessMembership =",
  );
  const membershipEnd = supervisor.indexOf(
    "const retainedCgroupIsEmpty =",
    membershipStart,
  );
  expect(membershipStart).toBeGreaterThan(-1);
  expect(membershipEnd).toBeGreaterThan(membershipStart);
  const membership = supervisor.slice(membershipStart, membershipEnd);
  let boundary = -1;
  for (const token of [
    'markDiagnostic?.("main-pid-malformed")',
    "classifySystemdAdmissionMainPid(facts)",
    "const pid = Number(facts.MainPID)",
    "if (!Number.isSafeInteger(pid)) failSystemd()",
    'markDiagnostic?.("main-snapshot-before")',
    "const before = readProcessSnapshot(pid)",
    'markDiagnostic?.("main-members")',
    "const members = retainedCgroupMembers(cgroupIdentity)",
    'markDiagnostic?.("main-snapshot-after")',
    "const after = readProcessSnapshot(pid)",
    'markDiagnostic?.("main-identity")',
    "validateMainProcessMembership(",
  ]) {
    const next = membership.indexOf(token, boundary + 1);
    expect(next, token).toBeGreaterThan(boundary);
    boundary = next;
  }
  expect(admission).toContain("systemdUnitAdmissionDiagnosticReasons.has(");
});

it("keeps terminal cgroup diagnostic declarations exhaustive", () => {
  const reasons = [
    "cgroup-observe-before",
    "cgroup-observe-after",
    "cgroup-transition-retained",
    "cgroup-transition-monotonic-removal-empty",
    "cgroup-transition-empty-populated",
    "cgroup-transition-reappeared",
    "cgroup-transition-third-controlgroup",
    "cgroup-transition-main-nonterminal",
    "cgroup-transition-observation-shape",
  ] as const satisfies readonly SystemdTerminalWaitCgroupReason[];
  const exhaustive: Exclude<
    SystemdTerminalWaitCgroupReason,
    (typeof reasons)[number]
  > extends never
    ? true
    : false = true;
  expect(exhaustive).toBe(true);
  for (const reason of reasons)
    expect(
      validSystemdLifecyclePredicate(`lifecycle:terminal-wait:${reason}`),
    ).toBe(true);
});

it("admits only closed terminal-wait authority diagnostics", () => {
  for (const reason of [
    "unit-show",
    "unit-parse",
    "cgroup-observe-before",
    "cgroup-observe-after",
    "cgroup-transition-retained",
    "cgroup-transition-monotonic-removal-empty",
    "cgroup-transition-empty-populated",
    "cgroup-transition-reappeared",
    "cgroup-transition-third-controlgroup",
    "cgroup-transition-main-nonterminal",
    "cgroup-transition-observation-shape",
    "authority-load",
    "authority-identity",
    "authority-cgroup",
    "authority-hardening",
    "authority-principal",
  ]) {
    expect(
      validSystemdLifecyclePredicate(`lifecycle:terminal-wait:${reason}`),
    ).toBe(true);
    expect(
      validSystemdLifecyclePredicate(`lifecycle:unit-authoritative:${reason}`),
    ).toBe(false);
  }
  for (const rejected of [
    "lifecycle:terminal-wait:show-output",
    "lifecycle:terminal-wait:authority-unknown",
    "lifecycle:terminal-wait:unit-show:extra",
  ])
    expect(validSystemdLifecyclePredicate(rejected)).toBe(false);
});

const expectNonterminalCgroupTransitionClosure = (
  terminal: Record<string, string>,
  authority: {
    cgroup: string;
    gid: number;
    groups: readonly number[];
    uid: number;
    unit: string;
  },
  absent: { absent: boolean; empty: boolean },
) => {
  const present = { absent: false, empty: false };
  const nonterminal = { ...terminal, ExecMainStatus: "" };
  expect(
    classifyTerminalCgroupTransitionFailure(
      nonterminal,
      authority,
      present,
      present,
    ),
  ).toBe("cgroup-transition-main-nonterminal");
  for (const [facts, before, after, reason] of [
    [nonterminal, absent, absent, "cgroup-transition-observation-shape"],
    [nonterminal, absent, present, "cgroup-transition-reappeared"],
    [
      { ...nonterminal, ControlGroup: "" },
      present,
      absent,
      "cgroup-transition-monotonic-removal-empty",
    ],
    [
      { ...nonterminal, ControlGroup: "" },
      present,
      present,
      "cgroup-transition-empty-populated",
    ],
    [
      { ...nonterminal, ControlGroup: "/system.slice/other.service" },
      present,
      present,
      "cgroup-transition-third-controlgroup",
    ],
    [
      nonterminal,
      { absent: true, empty: false },
      absent,
      "cgroup-transition-observation-shape",
    ],
  ] as const)
    expect(
      classifyTerminalCgroupTransitionFailure(facts, authority, before, after),
    ).toBe(reason);
};

it("binds transient main membership to exact PID and start identity", () => {
  const facts = { MainPID: "712" };
  const identity = { bootId: "boot", pid: 712, startTime: "991" };
  expect(
    validateMainProcessMembership({
      after: identity,
      before: identity,
      expected: identity,
      facts,
      members: [712, 713],
    }),
  ).toBe(true);
  for (const replacement of [
    { after: { ...identity, startTime: "992" } },
    { before: { ...identity, bootId: "other" } },
    { expected: { ...identity, pid: 713 } },
    { facts: { MainPID: "0712" } },
    { facts: { MainPID: "713" } },
    { members: [713] },
    { members: [712, Number.NaN] },
  ])
    expect(
      validateMainProcessMembership({
        after: identity,
        before: identity,
        expected: identity,
        facts,
        members: [712],
        ...replacement,
      }),
    ).toBe(false);
});

it("classifies MainPID admission transitions without widening the deadline", () => {
  const reasons = [
    "main-pid-unavailable",
    "main-pid-malformed",
    "main-pid-mismatch",
    "main-pid-terminal-unit-state",
  ] as const satisfies readonly SystemdAdmissionMainPidReason[];
  const exhaustive: Exclude<
    SystemdAdmissionMainPidReason,
    (typeof reasons)[number]
  > extends never
    ? true
    : false = true;
  expect(exhaustive).toBe(true);
  expect(reasons).toHaveLength(4);
  for (const subState of ["start-pre", "start", "start-post"]) {
    expect(
      classifySystemdAdmissionMainPid({
        ActiveState: "activating",
        SubState: subState,
      }),
    ).toBe("main-pid-unavailable");
    for (const mainPid of ["", "0"])
      expect(
        classifySystemdAdmissionMainPid({
          ActiveState: "activating",
          MainPID: mainPid,
          SubState: subState,
        }),
      ).toBe("main-pid-unavailable");
  }
  for (const mainPid of [
    "-1",
    "01",
    "1.0",
    "x",
    String(Number.MAX_SAFE_INTEGER + 1),
  ])
    expect(
      classifySystemdAdmissionMainPid({
        ActiveState: "active",
        MainPID: mainPid,
      }),
    ).toBe("main-pid-malformed");
  for (const activeState of ["active", "inactive", "failed", "deactivating"])
    expect(
      classifySystemdAdmissionMainPid({
        ActiveState: activeState,
        MainPID: "0",
      }),
    ).toBe("main-pid-terminal-unit-state");
  expect(
    classifySystemdAdmissionMainPid({
      ActiveState: "active",
      ExecMainCode: "1",
      ExecMainStatus: "0",
      MainPID: "0",
      Result: "success",
      SubState: "exited",
    }),
  ).toBe("main-pid-terminal-unit-state");
  expect(
    classifySystemdAdmissionMainPid({ ActiveState: "active", MainPID: "712" }),
  ).toBeUndefined();
  expect(
    classifySystemdAdmissionMainPid(
      { ActiveState: "active", MainPID: "713" },
      712,
    ),
  ).toBe("main-pid-mismatch");
  expect(
    classifySystemdAdmissionMainPid(
      { ActiveState: "active", MainPID: "712" },
      712,
    ),
  ).toBeUndefined();

  const supervisor = readFileSync(
    resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
    "utf8",
  );
  const admission = supervisor.slice(
    supervisor.indexOf("const admitSystemdUnit ="),
    supervisor.indexOf("const observeSystemdTerminal ="),
  );
  expect(admission).toContain(
    'while (mainPidReason === "main-pid-unavailable")',
  );
  expect(admission).toContain("state.executionDeadline");
  expect(admission).toContain("classifySystemdUnitAuthority(");
  expect(admission).toContain(
    "recheckCgroupAuthority(state.cgroupPath, state.cgroupIdentity)",
  );
  expect(admission).not.toContain("Date.now()");
});

it("classifies terminal cgroup transition failures without exposing authority values", () => {
  const authority = {
    cgroup: "/system.slice/agentscope-run.service",
    gid: 1001,
    groups: [4, 1001],
    uid: 1001,
    unit: "agentscope-run.service",
  };
  const terminal = {
    ActiveState: "active",
    AmbientCapabilities: "",
    CapabilityBoundingSet: "",
    ControlGroup: authority.cgroup,
    Delegate: "no",
    ExecMainCode: "1",
    ExecMainStatus: "0",
    Group: "1001",
    Id: authority.unit,
    InaccessiblePaths:
      "/run/dbus/system_bus_socket /run/systemd/private /run/user /var/run/dbus/system_bus_socket",
    KillMode: "control-group",
    LoadState: "loaded",
    NoNewPrivileges: "yes",
    ProtectControlGroups: "yes",
    RemainAfterExit: "yes",
    Result: "success",
    RestrictSUIDSGID: "yes",
    SubState: "exited",
    SupplementaryGroups: "4 1001",
    User: "1001",
  };
  const absent = { absent: true, empty: true };
  expect(
    classifyTerminalCgroupTransitionFailure(
      terminal,
      authority,
      { absent: false, empty: false },
      absent,
    ),
  ).toBe("cgroup-transition-retained");
  for (const [facts, before, after, reason] of [
    [
      { ...terminal, ControlGroup: "" },
      { absent: false, empty: false },
      absent,
      "cgroup-transition-monotonic-removal-empty",
    ],
    [
      { ...terminal, ControlGroup: "" },
      { absent: false, empty: false },
      { absent: false, empty: false },
      "cgroup-transition-empty-populated",
    ],
    [
      terminal,
      absent,
      { absent: false, empty: true },
      "cgroup-transition-reappeared",
    ],
    [
      { ...terminal, ExecMainStatus: "" },
      absent,
      absent,
      "cgroup-transition-observation-shape",
    ],
    [
      { ...terminal, ControlGroup: "/system.slice/other.service" },
      absent,
      absent,
      "cgroup-transition-third-controlgroup",
    ],
    [
      terminal,
      { absent: true, empty: false },
      absent,
      "cgroup-transition-observation-shape",
    ],
  ] as const)
    expect(
      classifyTerminalCgroupTransitionFailure(facts, authority, before, after),
    ).toBe(reason);
  expectNonterminalCgroupTransitionClosure(terminal, authority, absent);
});

it("binds every terminal cgroup diagnostic through one cleanup path", async () => {
  for (const [mode, reason] of [
    ["observe-before", "cgroup-observe-before"],
    ["observe-after", "cgroup-observe-after"],
    ["transition-retained", "cgroup-transition-retained"],
    ["transition-empty-populated", "cgroup-transition-empty-populated"],
    ["transition-reappeared", "cgroup-transition-reappeared"],
    ["transition-third-controlgroup", "cgroup-transition-third-controlgroup"],
    ["transition-observation-shape", "cgroup-transition-observation-shape"],
  ] as const)
    await expect(
      exerciseTerminalCgroupDiagnosticForTesting(mode),
    ).resolves.toEqual({
      cleanupAttempts: 1,
      predicate: `lifecycle:terminal-wait:${reason}`,
    });
  await expect(
    exerciseTerminalCgroupDiagnosticForTesting(
      "transition-monotonic-removal-empty",
    ),
  ).resolves.toEqual({ cleanupAttempts: 1, predicate: undefined });
  await expect(
    exerciseTerminalCgroupDiagnosticForTesting("transition-main-nonterminal"),
  ).resolves.toEqual({ cleanupAttempts: 1, predicate: undefined });
  for (const forged of [
    "lifecycle:terminal-wait:cgroup-observe-before:extra",
    "lifecycle:terminal-wait:cgroup-observe-unknown",
    "lifecycle:terminal-wait:cgroup-transition-retained-substituted",
  ])
    expect(validSystemdLifecyclePredicate(forged)).toBe(false);
});

it("preserves authenticated terminal tool failure identity through cleanup", () => {
  expect(exerciseSystemdToolFailurePreservationForTesting()).toEqual({
    authenticatedIdentityPreserved: true,
    cleanupAttempts: 1,
    forgedRejected: true,
  });
});

it("preserves authenticated root-tool failure authority during collection", () => {
  const supervisor = readFileSync(
    resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
    "utf8",
  );
  const collection = supervisor.slice(
    supervisor.indexOf("const proveCollected ="),
    supervisor.indexOf("const retireUnit ="),
  );
  expect(collection).toContain(
    "if (systemdToolFailureStage(error) !== undefined) throw error;",
  );
  expect(collection.indexOf("systemdToolFailureStage(error)")).toBeLessThan(
    collection.indexOf(
      'failSystemdLifecycle(state, "collection", "unit-show")',
    ),
  );
  expect(
    systemdToolFailureStage(
      new Error("integration.controller.systemd-tool:client-terminal:deadline"),
    ),
  ).toBeUndefined();
  expect(supervisor).toContain(
    'if child.returncode!=0 and not (OPERATION=="unit-collection" and child.returncode==4):',
  );
  expect(supervisor).toContain(
    'operation_stage="unit-admission" if OPERATION=="unit-admission" else "retirement" if OPERATION in {"unit-retirement","unit-kill-term","unit-kill-kill","unit-stop","unit-reset"} else "client-terminal"',
  );
  expect(supervisor).not.toContain(
    'else "join" if OPERATION=="unit-collection"',
  );
  expect(supervisor).not.toContain(
    'if child.returncode!=0 and not (OPERATION=="unit-retirement" and child.returncode==4):',
  );
  expect(collection).toContain('!Object.hasOwn(facts, "LoadState")');
  expect(collection).toContain(
    "keys.some((key) => !unitProperties.includes(key))",
  );
});

it("authenticates only the closed sentinel reason inventory", () => {
  const key = "3".repeat(64);
  const identity = {
    cutoff: "100",
    deadline: "200",
    operation: "unit-admission",
    unit: "agentscope-test.service",
  };
  const receiptFor = (reason: string) => {
    const fields = {
      cutoff: identity.cutoff,
      deadline: identity.deadline,
      operation: identity.operation,
      output: "",
      reason,
      stage: "sentinel",
      status: "error",
      unit: identity.unit,
    };
    const mac = createHmac("sha256", Buffer.from(key, "hex"))
      .update(JSON.stringify(fields))
      .digest("hex");
    return JSON.stringify({
      mac,
      output: "",
      reason,
      stage: "sentinel",
      status: "error",
    });
  };
  for (const reason of [
    "child-exit",
    "start-identity",
    "inherited-group",
    "transition-timeout",
    "kill",
    "reap-join",
    "residual",
    "internal-unknown",
  ])
    expect(
      validateRootToolReceipt({ identity, key, receipt: receiptFor(reason) }),
    ).toEqual({ output: "", reason, stage: "sentinel", status: "error" });
  expect(
    validateRootToolReceipt({
      identity,
      key,
      receipt: receiptFor("unknown"),
    }),
  ).toBeUndefined();
  expect(
    validateRootToolReceipt({
      identity,
      key,
      receipt: receiptFor("child-exit").replace(
        '"reason":"child-exit"',
        '"reason":"child-exit","reason":"child-exit"',
      ),
    }),
  ).toBeUndefined();
});

it("authenticates only the closed join reason inventory", () => {
  const key = "6".repeat(64);
  const identity = {
    cutoff: "100",
    deadline: "200",
    operation: "unit-admission",
    unit: "agentscope-test.service",
  };
  const receiptFor = (reason: string) => {
    const fields = {
      cutoff: identity.cutoff,
      deadline: identity.deadline,
      operation: identity.operation,
      output: "",
      reason,
      stage: "join",
      status: "error",
      unit: identity.unit,
    };
    const mac = createHmac("sha256", Buffer.from(key, "hex"))
      .update(JSON.stringify(fields))
      .digest("hex");
    return JSON.stringify({
      mac,
      output: "",
      reason,
      stage: "join",
      status: "error",
    });
  };
  for (const reason of [
    "leader-identity",
    "preclose-residual",
    "control-close",
    "reap-timeout",
    "identity-drift",
    "postreap-residual",
    "internal-unknown",
  ])
    expect(
      validateRootToolReceipt({ identity, key, receipt: receiptFor(reason) }),
    ).toEqual({ output: "", reason, stage: "join", status: "error" });
  for (const receipt of [
    receiptFor("unknown"),
    receiptFor("leader-identity").slice(0, -1),
    receiptFor("leader-identity").replace(
      '"reason":"leader-identity"',
      '"reason":"leader-identity","reason":"leader-identity"',
    ),
  ])
    expect(validateRootToolReceipt({ identity, key, receipt })).toBeUndefined();
  expect(
    validateRootToolReceipt({
      identity: { ...identity, operation: "unit-monitor" },
      key,
      receipt: receiptFor("leader-identity"),
    }),
  ).toBeUndefined();

  const supervisor = readFileSync(
    resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
    "utf8",
  );
  for (const boundary of [
    'REASON="leader-identity"\n if process_identity(leader)!=expected',
    'REASON="preclose-residual"',
    'REASON="control-close"\n try: os.close(control)',
    'REASON="reap-timeout"\n while now()<DEADLINE',
    'REASON="identity-drift"; raise RuntimeError("identity")',
    'REASON="postreap-residual"\n if group_present(leader)',
  ])
    expect(supervisor).toContain(boundary);
  expect(supervisor).toContain(
    'if not progressed: raise RuntimeError("residual")',
  );
  expect(supervisor).toContain(
    "member=expected_members.get(pid)\n   if member is None or record!=member",
  );
  expect(supervisor).toContain("if leader_reaped and not records: break");
  expect(supervisor).toContain("STAGE=failed_stage\n   REASON=failed_reason");
});

it("authenticates only the closed client-terminal reason inventory", () => {
  const key = "9".repeat(64);
  const identity = {
    cutoff: "100",
    deadline: "200",
    operation: "synthetic-client-internal",
    unit: "",
  };
  const receiptFor = (reason: string) => {
    const fields = {
      cutoff: identity.cutoff,
      deadline: identity.deadline,
      operation: identity.operation,
      output: "",
      reason,
      stage: "client-terminal",
      status: "error",
      unit: identity.unit,
    };
    const mac = createHmac("sha256", Buffer.from(key, "hex"))
      .update(JSON.stringify(fields))
      .digest("hex");
    return JSON.stringify({
      mac,
      output: "",
      reason,
      stage: "client-terminal",
      status: "error",
    });
  };
  for (const reason of [
    "cutoff",
    "deadline",
    "leader-identity",
    "child-admission",
    "member-identity",
    "output-read",
    "output-bound",
    "nonzero-terminal",
    "internal-unknown",
  ])
    expect(
      validateRootToolReceipt({ identity, key, receipt: receiptFor(reason) }),
    ).toEqual({
      output: "",
      reason,
      stage: "client-terminal",
      status: "error",
    });
  for (const receipt of [
    receiptFor("unknown"),
    receiptFor("cutoff").slice(0, -1),
    receiptFor("cutoff").replace(
      '"reason":"cutoff"',
      '"reason":"cutoff","reason":"cutoff"',
    ),
  ])
    expect(validateRootToolReceipt({ identity, key, receipt })).toBeUndefined();
  expect(
    validateRootToolReceipt({
      identity: { ...identity, operation: "synthetic-client-nonzero" },
      key,
      receipt: receiptFor("cutoff"),
    }),
  ).toBeUndefined();
});

it.runIf(process.platform === "linux" && existsSync("/usr/bin/python3"))(
  "executes every closed client-terminal failure branch without raw diagnostics",
  () => {
    const supervisorSource = readFileSync(
      resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
      "utf8",
    );
    const prefix = "const rootHelperSource = String.raw`";
    const start = supervisorSource.indexOf(prefix) + prefix.length;
    const end = supervisorSource.indexOf("`;\nconst cgroupRoot =", start);
    const helper = supervisorSource.slice(start, end);
    const sync = synchronizeSyntheticClientDeadlines(helper);
    const { synchronizedHelper } = sync;
    for (const boundary of [
      sync.deadlineArm,
      sync.groupEstablishedBoundary,
      sync.childAdmissionBoundary,
      sync.childSpawnBoundary,
      sync.runGlobalBoundary,
      sync.postAdmissionBoundary,
    ])
      expect(helper).toContain(boundary);
    expect(sync.readinessSynchronizedHelper).not.toBe(helper);
    expect(sync.gatedChildHelper).not.toBe(sync.readinessSynchronizedHelper);
    expect(sync.childSynchronizedHelper).not.toBe(sync.gatedChildHelper);
    expect(sync.identitySynchronizedHelper).not.toBe(
      sync.childSynchronizedHelper,
    );
    expect(synchronizedHelper).not.toBe(sync.identitySynchronizedHelper);
    const delayArguments = ["-I", "-S", "-c", "import sys; sys.exit(0)"];
    const sleepArguments = ["-I", "-S", "-c", "import time; time.sleep(5)"];
    const cases = [
      ["synthetic-client-cutoff", "cutoff", sleepArguments, "error"],
      [
        "synthetic-client-cutoff-cleanup-failure",
        "cutoff",
        sleepArguments,
        "uncertain",
      ],
      ["synthetic-client-deadline", "deadline", sleepArguments, "uncertain"],
      [
        "synthetic-client-leader-identity",
        "leader-identity",
        delayArguments,
        "error",
      ],
      [
        "synthetic-client-child-admission",
        "child-admission",
        delayArguments,
        "error",
      ],
      [
        "synthetic-client-member-identity",
        "member-identity",
        sleepArguments,
        "error",
      ],
      ["synthetic-client-output-read", "output-read", sleepArguments, "error"],
      [
        "synthetic-client-output-bound",
        "output-bound",
        ["-I", "-S", "-c", 'import os; os.write(1,b"x"*65537)'],
        "error",
      ],
      [
        "synthetic-client-nonzero",
        "nonzero-terminal",
        ["-I", "-S", "-c", "import sys; sys.exit(17)"],
        "error",
      ],
      [
        "synthetic-client-internal",
        "internal-unknown",
        delayArguments,
        "error",
      ],
    ] as const;
    for (const [operation, reason, arguments_, status] of cases) {
      const key = createHash("sha256").update(operation).digest("hex");
      const terminal = spawnSync(
        "/usr/bin/python3",
        [
          "-I",
          "-S",
          "-c",
          synchronizedHelper,
          "1",
          "1",
          operation,
          "/usr/bin/python3",
          Buffer.from(JSON.stringify(arguments_)).toString("base64url"),
          "",
          key,
        ],
        {
          encoding: "utf8",
          env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
          stdio: ["ignore", "pipe", "pipe", "pipe"],
          timeout: syntheticObservationMilliseconds,
        },
      );
      expect(terminal).toMatchObject({ signal: null, status: 1, stderr: "" });
      const readiness = parseSyntheticClientReadiness(terminal.output[3]);
      if (readiness === undefined) {
        throw syntheticReadinessFailure(operation, terminal.stdout);
      }
      const { cutoff, deadline } = readiness;
      const receipt = validateRootToolReceipt({
        identity: { cutoff, deadline, operation, unit: "" },
        key,
        receipt: terminal.stdout,
      });
      expect(receipt).toMatchObject({
        output: "",
        reason,
        stage: "client-terminal",
        status,
      });
      expect(terminal.stdout).not.toContain("Traceback");
    }
  },
  30_000,
);

it("emits only an authenticated closed systemd-tool stage annotation", () => {
  const action = readFileSync(
    resolve(workspaceRoot, "tests/integration/upload-failure-evidence.mjs"),
    "utf8",
  );
  expect(action).toContain("systemdToolFailureStage(error)");
  expect(action).toContain(
    "`::error::integration.controller.systemd-tool:${stage}\\n`",
  );
  expect(action).not.toContain("error.message");
  expect(action).not.toContain("error.stack");
  const supervisor = readFileSync(
    resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
    "utf8",
  );
  for (const operation of [
    "pid1-readlink-1",
    "pid1-stat",
    "pid1-digest",
    "pid1-readlink-2",
    "systemd-submit",
    "unit-admission",
    "unit-monitor",
    "unit-authoritative",
    "unit-collection",
    "unit-retirement",
    "unit-kill-term",
    "unit-kill-kill",
    "unit-stop",
    "unit-reset",
  ])
    expect(supervisor).toContain(`"${operation}"`);
  expect(supervisor).toContain(
    "systemdToolFailures.set(error, Object.freeze({ predicate }))",
  );
  expect(supervisor).toContain(
    "new Error(`integration.controller.systemd-tool:${predicate}`)",
  );
});

it("latches closed outer-controller stages before every authority boundary", () => {
  const action = readFileSync(
    resolve(workspaceRoot, "tests/integration/upload-failure-evidence.mjs"),
    "utf8",
  );
  const outer = action.slice(
    action.indexOf("const outerControllerMain ="),
    action.indexOf("const bootstrapMain ="),
  );
  for (const [stage, boundary] of [
    ['outerStage = "prepare-systemd"', "prepareGithubSystemdSupervision("],
    ['outerStage = "run-systemd"', "runSupervisedProcess("],
    [
      'outerStage = "revalidate-sealer"',
      "revalidateCredentialedSource(sealer)",
    ],
    ['outerStage = "finalize-evidence"', "finalizeFailureEvidence("],
    ['outerStage = "descriptor-close"', "for (const descriptor of"],
  ] as const)
    expect(outer.indexOf(stage)).toBeLessThan(outer.indexOf(boundary));
  expect(action).toContain(
    "`::error::integration.controller.outer:${outerStage}\\n`",
  );
  expect(action).not.toContain("integration.controller.outer:${error");
});

it("closes retained descriptor authority exactly once on capture failure", () => {
  const closed: number[] = [];
  for (const [index, phase] of ["digest", "fstat", "snapshot"].entries()) {
    const descriptor = 42 + index;
    expect(() =>
      transferDescriptorAuthority({
        close: (owned) => closed.push(owned),
        construct: () => {
          throw new Error(`synthetic ${phase} failure`);
        },
        open: () => descriptor,
      }),
    ).toThrow(`synthetic ${phase} failure`);
    expect(closed).toEqual(
      Array.from({ length: index + 1 }, (_, offset) => 42 + offset),
    );
  }

  const authority = transferDescriptorAuthority({
    close: (descriptor) => closed.push(descriptor),
    construct: (descriptor) => ({ descriptor }),
    open: () => 45,
  });
  expect(authority).toEqual({ descriptor: 45 });
  expect(closed).toEqual([42, 43, 44]);
});

type GithubSystemdSetup = {
  arguments_: readonly string[];
  directory: string;
  environment: NodeJS.ProcessEnv;
  escapeEvidence: string;
  escapeUnit: string;
  evidence: string;
  losingEvidence: string;
  preparation: Awaited<ReturnType<typeof prepareGithubSystemdSupervision>>;
};

const prepareGithubSystemdFixture = async (): Promise<GithubSystemdSetup> => {
  const directory = mkdtempSync(resolve(tmpdir(), "agentscope-systemd-"));
  const evidence = resolve(directory, "descendant.pid");
  const escapeEvidence = resolve(directory, "escape.json");
  const losingEvidence = resolve(directory, "losing.txt");
  const escapeUnit = `agentscope-escape-${createHash("sha256")
    .update(directory)
    .digest("hex")
    .slice(0, 32)}.service`;
  const environment = {
    AGENTSCOPE_INTEGRATION_SHARD: "0/1",
    AGENTSCOPE_INTEGRATION_REPLAY: "1",
    AGENTSCOPE_SUPERVISOR_DETACHED: "true",
    AGENTSCOPE_SUPERVISOR_EVIDENCE: evidence,
    AGENTSCOPE_SUPERVISOR_ESCAPE_EVIDENCE: escapeEvidence,
    AGENTSCOPE_SUPERVISOR_ESCAPE_UNIT: escapeUnit,
    GITHUB_ACTIONS: "true",
    GITHUB_JOB: "hermetic-platform",
    GITHUB_REPOSITORY: "Melbourneandrew/agentscope",
    GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
    GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
    GITHUB_SHA: process.env.GITHUB_SHA,
    LANG: "C.UTF-8",
    PATH: "/usr/bin:/bin",
    RUNNER_ENVIRONMENT: "github-hosted",
  };
  const arguments_ = [
    resolve(
      workspaceRoot,
      "tests/integration/fixtures/stubborn-controller-child.mjs",
    ),
  ];
  try {
    const preparation = await prepareGithubSystemdSupervision({
      arguments_,
      environment,
      executable: process.execPath,
      maximumMilliseconds: 15_000,
      stdio: "ignore",
    });
    return {
      arguments_,
      directory,
      environment,
      escapeEvidence,
      escapeUnit,
      evidence,
      losingEvidence,
      preparation,
    };
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
};

const rejectPreparedSystemdSubstitution = async (
  current: GithubSystemdSetup,
  substitution: "arguments" | "environment",
) => {
  await expect(
    runSupervisedProcess({
      arguments_:
        substitution === "arguments"
          ? [...current.arguments_, "substituted"]
          : current.arguments_,
      containment: "github-systemd",
      environment:
        substitution === "environment"
          ? { ...current.environment, LANG: "C" }
          : current.environment,
      executable: process.execPath,
      maximumMilliseconds: 15_000,
      preparation: current.preparation,
      stdio: "ignore",
    }),
  ).rejects.toThrow("integration.controller.systemd-containment");
  expect(await closePreparedGithubSystemdSupervision(current.preparation)).toBe(
    false,
  );
};

describe.runIf(
  process.platform === "linux" &&
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.RUNNER_ENVIRONMENT === "github-hosted",
)("GitHub systemd containment", () => {
  let setup: GithubSystemdSetup | undefined;

  beforeEach(async () => {
    setup = await prepareGithubSystemdFixture();
  }, 15_000);

  afterEach(async () => {
    if (setup === undefined) return;
    await closePreparedGithubSystemdSupervision(setup.preparation);
    rmSync(setup.directory, { force: true, recursive: true });
    setup = undefined;
  });

  it("closes prepared authority before a weaker route starts", async () => {
    if (setup === undefined) throw new Error("missing systemd preparation");
    const current = setup;
    expect(Object.isFrozen(current.preparation)).toBe(true);
    expect(Object.keys(current.preparation)).toEqual([]);
    expect(Object.getOwnPropertySymbols(current.preparation)).toEqual([]);
    expect(() =>
      Object.assign(current.preparation, { deadline: Number.MAX_SAFE_INTEGER }),
    ).toThrow();
    expect(existsSync(current.evidence)).toBe(false);
    const losingRoute = {
      arguments_: [
        "--input-type=module",
        "--eval",
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(current.losingEvidence)}, "started");`,
      ],
      environment: current.environment,
      executable: process.execPath,
      maximumMilliseconds: 15_000,
      preparation: current.preparation,
      stdio: "ignore" as const,
    };
    await expect(
      runSupervisedProcess(
        losingRoute as unknown as Parameters<typeof runSupervisedProcess>[0],
      ),
    ).rejects.toThrow("integration.controller.systemd-containment");
    expect(
      await closePreparedGithubSystemdSupervision(current.preparation),
    ).toBe(false);
    expect(existsSync(current.losingEvidence)).toBe(false);
    expect(existsSync(current.evidence)).toBe(false);
  });

  it.each(["arguments", "environment"] as const)(
    "rejects prepared %s substitution and closes the running unit",
    async (substitution) => {
      if (setup === undefined) throw new Error("missing systemd preparation");
      await rejectPreparedSystemdSubstitution(setup, substitution);
    },
  );

  it("contains a detached session in the authenticated systemd unit", async () => {
    if (setup === undefined) throw new Error("missing systemd preparation");
    const result = await runSupervisedProcess({
      arguments_: setup.arguments_,
      containment: "github-systemd",
      environment: setup.environment,
      executable: process.execPath,
      maximumMilliseconds: 15_000,
      preparation: setup.preparation,
      stdio: "ignore",
    });
    expect(result).toMatchObject({
      code: 1,
      contained: true,
      residualWorkObserved: true,
    });
    expect(JSON.parse(readFileSync(setup.escapeEvidence, "utf8"))).toEqual({
      cgroupMigration: false,
      directSystemUnit: false,
      systemUnit: false,
      userUnit: false,
    });
    const descendant = Number(readFileSync(setup.evidence, "utf8"));
    expect(() => process.kill(descendant, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
    const escapedUnit = spawnSync(
      "/usr/bin/sudo",
      [
        "-n",
        "--",
        "/usr/bin/systemctl",
        "show",
        "--no-pager",
        "--property=LoadState",
        setup.escapeUnit,
      ],
      {
        encoding: "utf8",
        env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
        timeout: 5_000,
      },
    );
    expect(escapedUnit).toMatchObject({
      signal: null,
      status: 0,
      stdout: "LoadState=not-found\n",
    });
    await expect(
      runSupervisedProcess({
        arguments_: setup.arguments_,
        containment: "github-systemd",
        environment: setup.environment,
        executable: process.execPath,
        maximumMilliseconds: 15_000,
        preparation: setup.preparation,
        stdio: "ignore",
      }),
    ).rejects.toThrow("integration.controller.systemd-containment");
  }, 20_000);
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

function expectClosedOuterGitConfiguration(workflow: string) {
  expect(
    workflow.match(
      /if \[\[ "\$RUNNER_TEMP" != \/\* \|\| \$\{#RUNNER_TEMP\} -gt 1024/gu,
    ),
  ).toHaveLength(2);
  expect(workflow.match(/"\$RUNNER_TEMP" == \*\$'\\n'\*/gu)).toHaveLength(2);
  expect(workflow.match(/"\$RUNNER_TEMP" == \*\$'\\r'\*/gu)).toHaveLength(2);
  expect(
    workflow.match(
      /git_config="\$RUNNER_TEMP\/agentscope-global\.gitconfig"/gu,
    ),
  ).toHaveLength(2);
  expect(
    workflow.match(/install -m 600 \/dev\/null "\$git_config"/gu),
  ).toHaveLength(2);
  expect(
    workflow.match(/echo "GIT_CONFIG_GLOBAL=\$git_config" >> "\$GITHUB_ENV"/gu),
  ).toHaveLength(2);
  expect(
    workflow.match(
      /\[\[ -f "\$git_config" && ! -L "\$git_config" && "\$\(stat -c '%a' "\$git_config"\)" == 600 \]\]/gu,
    ),
  ).toHaveLength(2);
  expect(workflow).not.toContain("${{ runner.temp }}");
  expect(workflow).not.toMatch(/GIT_CONFIG_GLOBAL: \/dev\/null/gu);
  expect(workflow).not.toMatch(/(?:rm|unlink).*agentscope-global\.gitconfig/gu);
  for (const [job, followingJob] of [
    ["prepare-candidate:", "  hermetic-platform:"],
    ["hermetic-platform:", "  hermetic-integration:"],
  ] as const) {
    const start = workflow.indexOf(job);
    const body = workflow.slice(start, workflow.indexOf(followingJob, start));
    expect(body.indexOf("Initialize closed npm configuration")).toBeLessThan(
      body.indexOf("uses: actions/checkout@v4"),
    );
    expect(body.indexOf('install -m 600 /dev/null "$git_config"')).toBe(
      body.lastIndexOf('install -m 600 /dev/null "$git_config"'),
    );
  }
  const controller = readFileSync(
    resolve(workspaceRoot, "tests/integration/src/controller.ts"),
    "utf8",
  );
  expect(controller).toContain('GIT_CONFIG_GLOBAL: "/dev/null"');
}

function expectHermeticCopyInstall(workflow: string) {
  expect(workflow.match(/runs-on: ubuntu-24\.04/gu)).toHaveLength(1);
  expect(
    workflow.match(/run: pnpm install --frozen-lockfile$/gmu),
  ).toHaveLength(1);
  expect(
    workflow.match(
      /run: pnpm install --frozen-lockfile --package-import-method=copy$/gmu,
    ),
  ).toHaveLength(1);
  const hermeticJob = workflow.slice(
    workflow.indexOf("  hermetic-platform:"),
    workflow.indexOf("  hermetic-integration:"),
  );
  expect(
    hermeticJob.indexOf(
      "pnpm install --frozen-lockfile --package-import-method=copy",
    ),
  ).toBeLessThan(hermeticJob.indexOf("uses: ./tests/integration"));
}

describe("integration workflow routing policy", () => {
  it("routes both CI phases through the same command", () => {
    const workflow = readFileSync(
      resolve(workspaceRoot, ".github/workflows/integration.yml"),
      "utf8",
    );
    expect(workflow.match(/pnpm test:integration/gu)).toHaveLength(1);
    expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(2);
    expectHermeticCopyInstall(workflow);
    expect(
      workflow.match(/NPM_CONFIG_GLOBALCONFIG=.*agentscope-global\.npmrc/gu),
    ).toHaveLength(2);
    expect(
      workflow.match(/NPM_CONFIG_USERCONFIG=.*agentscope-user\.npmrc/gu),
    ).toHaveLength(2);
    expect(
      workflow.match(/Initialize closed npm configuration/gu),
    ).toHaveLength(2);
    expectClosedOuterGitConfiguration(workflow);
    expect(
      workflow.match(/AGENTSCOPE_INTEGRATION_OUTER_DEADLINE_MONOTONIC_MS/gu),
    ).toHaveLength(2);
    expect(workflow).not.toMatch(
      /prepare:candidate|prepare:images|prepare:model-routes|run:scenarios|test:integration:clean/gu,
    );
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).not.toContain("if-no-files-found: ignore");
    expect(workflow).toContain(
      "Run the private integration lifecycle and retain failure evidence",
    );
    expect(workflow).toContain("id: integration_lifecycle");
    const upload = workflow.slice(
      workflow.indexOf(
        "- name: Run the private integration lifecycle and retain failure evidence",
      ),
      workflow.indexOf("  hermetic-integration:"),
    );
    expect(upload).not.toContain("actions/upload-artifact");
    expect(upload).toContain("uses: ./tests/integration");
    expect(upload).not.toContain("run:");
    expect(upload).not.toContain("with:");
    const action = readFileSync(
      resolve(workspaceRoot, "tests/integration/action.yml"),
      "utf8",
    );
    expect(action).toContain("using: node24");
    expect(action).toContain("main: upload-failure-evidence.mjs");
    expect(action).not.toContain("inputs:");
    const actionSource = readFileSync(
      resolve(workspaceRoot, "tests/integration/upload-failure-evidence.mjs"),
      "utf8",
    );
    expect(actionSource).toContain('"controller-failure-manifest.json"');
    expect(actionSource).toContain(
      "tests/integration/seal-failure-evidence.py",
    );
    expect(actionSource).toContain("ACTIONS_RUNTIME_TOKEN");
    expect(actionSource).toContain("ACTIONS_RESULTS_URL");
    expect(actionSource).toContain("const environment = Object.fromEntries(");
    expect(actionSource).not.toContain("{ ...sourceEnvironment }");
    expect(actionSource).toContain('"AGENTSCOPE_INTEGRATION_CONCURRENCY"');
    expect(actionSource).toContain('"RUNNER_ENVIRONMENT"');
    const preload = actionSource.indexOf(
      "const sealer = preloadCredentialedSource(",
    );
    const preparation = actionSource.indexOf(
      "await prepareGithubSystemdSupervision({",
    );
    const lifecycle = actionSource.indexOf("await runSupervisedProcess({");
    const finalize = actionSource.indexOf("finalizeFailureEvidence({");
    expect(preload).toBeGreaterThanOrEqual(0);
    expect(preparation).toBeGreaterThan(preload);
    expect(lifecycle).toBeGreaterThan(preparation);
    expect(lifecycle).toBeGreaterThan(preload);
    expect(finalize).toBeGreaterThan(lifecycle);
    expect(actionSource).not.toContain('await import("@actions/artifact")');
    expect(upload).not.toMatch(
      /GITHUB_OUTPUT|bundle_keeper|failure-evidence-keeper|RUNNER_TEMP|sudo|tee/gu,
    );
    expect(actionSource).toContain("runDirectories.length !== expected.size");
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
    expect(required).toBeGreaterThanOrEqual(0);
    expect(finalized).toBeGreaterThan(required);
    expect(manifest).toBeGreaterThan(finalized);
    expect(finalized).toBeGreaterThanOrEqual(0);
    expect(propagated).toBeGreaterThan(finalized);
    expect(scenarios).toContain("const before = fstatSync(descriptor)");
    expect(scenarios).toContain("const after = fstatSync(descriptor)");
    expect(scenarios).toContain("JSON.parse(identity.content.toString");
    expect(scenarios).toContain(
      'name === "current-images.json" ? 0o600 : 0o644',
    );
    const receiptCapture = scenarios.indexOf("captureInstalledPtyFailure(");
    const ledgerObservation = scenarios.indexOf(
      "await captureFailureFixtureLedgerObservations(",
    );
    expect(receiptCapture).toBeGreaterThanOrEqual(0);
    expect(ledgerObservation).toBeGreaterThan(receiptCapture);
    expect(scenarios).toContain(
      '"require-evidence": Object.freeze(["authority-rejected"])',
    );
    expect(scenarios).toContain('"retained-evidence-unavailable"');
    expect(scenarios).toContain('"run-finalization-rejected"');
    expect(scenarios).toContain('"manifest-publication-rejected"');
    expect(scenarios).not.toContain(
      "always-run exact verifier independently fails if evidence is absent",
    );
  });
});

describe("integration workflow terminal failure evidence", () => {
  const canonicalTerminal = {
    controllerFailureTerminalVersion: 1,
    predicate: "authority-rejected",
    stage: "require-evidence",
  };
  const admitted = [
    ["require-evidence", "authority-rejected"],
    ["finalize-run", "retained-evidence-unavailable"],
    ["finalize-run", "run-finalization-rejected"],
    ["publish-manifest", "manifest-publication-rejected"],
  ] as const;

  it.each(admitted)(
    "authenticates %s/%s while preserving the failed job",
    (stage, predicate) => {
      const workflow = readFileSync(
        resolve(workspaceRoot, ".github/workflows/integration.yml"),
        "utf8",
      );
      const source = failureVerifierSource(workflow).replace(
        "process.exit(1);",
        "process.exit(42);",
      );
      const directory = mkdtempSync(resolve(tmpdir(), "agentscope-terminal-"));
      try {
        writeFailureTerminalFixture(directory, {
          ...canonicalTerminal,
          predicate,
          stage,
        });
        expect(runFailureVerifier(source, directory).status).toBe(42);
      } finally {
        removeFailureVerifierFixture(directory);
      }
    },
  );

  it.each([
    {},
    { ...canonicalTerminal, stage: "unknown" },
    { ...canonicalTerminal, predicate: "unknown" },
    { ...canonicalTerminal, extra: true },
    { ...canonicalTerminal, stage: 1 },
    { ...canonicalTerminal, predicate: ["authority-rejected"] },
  ])(
    "rejects a missing, unknown, substituted, or malformed terminal %#",
    (terminal) => {
      const workflow = readFileSync(
        resolve(workspaceRoot, ".github/workflows/integration.yml"),
        "utf8",
      );
      const source = failureVerifierSource(workflow).replace(
        "process.exit(1);",
        "process.exit(42);",
      );
      const directory = mkdtempSync(resolve(tmpdir(), "agentscope-terminal-"));
      try {
        writeFailureTerminalFixture(directory, terminal);
        expect(runFailureVerifier(source, directory).status).not.toBe(42);
      } finally {
        removeFailureVerifierFixture(directory);
      }
    },
  );

  it("rejects missing, duplicate, and substituted evidence authorities", () => {
    const workflow = readFileSync(
      resolve(workspaceRoot, ".github/workflows/integration.yml"),
      "utf8",
    );
    const source = failureVerifierSource(workflow).replace(
      "process.exit(1);",
      "process.exit(42);",
    );
    const directory = mkdtempSync(resolve(tmpdir(), "agentscope-terminal-"));
    try {
      expect(runFailureVerifier(source, directory).status).not.toBe(42);
      writeFailureTerminalFixture(directory, canonicalTerminal);
      writeFailureManifestFixture(directory, ["0123456789abcdef"]);
      expect(runFailureVerifier(source, directory).status).not.toBe(42);
      writeFileSync(
        resolve(
          directory,
          "artifacts/integration/controller-failure-terminal.json",
        ),
        `${JSON.stringify({
          ...canonicalTerminal,
          predicate: "manifest-publication-rejected",
          stage: "publish-manifest",
        })}\n`,
        { mode: 0o600 },
      );
      expect(runFailureVerifier(source, directory).status).toBe(42);
      rmSync(
        resolve(
          directory,
          "artifacts/integration/controller-failure-manifest.json",
        ),
      );
      chmodSync(
        resolve(
          directory,
          "artifacts/integration/controller-failure-terminal.json",
        ),
        0o644,
      );
      expect(runFailureVerifier(source, directory).status).not.toBe(42);
    } finally {
      removeFailureVerifierFixture(directory);
    }
  });
});

describe("integration workflow anonymous failure artifact policy", () => {
  it("hands only a complete canonical sanitized bundle to the same-process uploader", () => {
    const workflow = readFileSync(
      resolve(workspaceRoot, ".github/workflows/integration.yml"),
      "utf8",
    );
    const source = failureVerifierSource(workflow);
    const directory = mkdtempSync(resolve(tmpdir(), "agentscope-evidence-"));
    const runIds = ["0123456789abcdef", "fedcba9876543210"].sort();
    try {
      const artifacts = writeFailureManifestFixture(directory, runIds);
      const sealedRun = runFailureVerifier(source, directory);
      expect(sealedRun.status).toBe(0);
      const bundle = readFileSync(sealedRun.bundleOutput, "utf8");
      expect(bundle).not.toMatch(
        /executionPolicy|headlessTerminalReceipt|privateCleanup|dockerSocket|dockerDaemon/gu,
      );
      const parsed = JSON.parse(bundle) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual([
        "bundleVersion",
        "controllerAuthorityDigest",
        "preparedInput",
        "retainedInputs",
        "runs",
      ]);
      expect(parsed.preparedInput).toBeTypeOf("object");
      expect(
        Object.keys(parsed.preparedInput as Record<string, unknown>).sort(),
      ).toEqual(["candidate", "images", "manifest", "routes", "selection"]);
      for (const value of Object.values(
        parsed.preparedInput as Record<string, unknown>,
      )) {
        expect(value).toBeTypeOf("object");
        expect(value).not.toBeNull();
      }
      chmodSync(resolve(artifacts, "current-images.json"), 0o644);
      expect(runFailureVerifier(source, directory).status).not.toBe(0);
      chmodSync(resolve(artifacts, "current-images.json"), 0o600);
      writeFileSync(
        resolve(artifacts, "runs", runIds[0]!, "model-ledger.json"),
        '{"substituted":true}\n',
        { mode: 0o600 },
      );
      expect(runFailureVerifier(source, directory).status).not.toBe(0);
      rmSync(resolve(artifacts, "runs", runIds[1]!), {
        recursive: true,
      });
      expect(runFailureVerifier(source, directory).status).not.toBe(0);
    } finally {
      removeFailureVerifierFixture(directory);
    }
  });

  it("retires only authenticated retained evidence after upload terminal", () => {
    const workflow = readFileSync(
      resolve(workspaceRoot, ".github/workflows/integration.yml"),
      "utf8",
    );
    const source = failureVerifierSource(workflow);
    const directory = mkdtempSync(resolve(tmpdir(), "agentscope-evidence-"));
    const runId = "0123456789abcdef";
    try {
      const artifacts = writeFailureManifestFixture(directory, [runId]);
      expect(
        runFailureVerifier(source, directory, undefined, true).status,
      ).toBe(0);
      for (const name of [
        "controller-failure-manifest.json",
        "current-candidate.json",
        "current-images.json",
        "current-model-routes.json",
        "current-selection.json",
      ])
        expect(existsSync(resolve(artifacts, name)), name).toBe(false);
      expect(existsSync(resolve(artifacts, "runs"))).toBe(false);
      expect(
        existsSync(
          resolve(directory, "tests/integration/capability-manifest.json"),
        ),
      ).toBe(true);
    } finally {
      removeFailureVerifierFixture(directory);
    }
  });
});

describe("installed-contract workflow failure evidence", () => {
  it("accepts only the closed remaining-contract failure predicates", () => {
    const workflow = readFileSync(
      resolve(workspaceRoot, ".github/workflows/integration.yml"),
      "utf8",
    );
    const source = failureVerifierSource(workflow);
    const executeVerifier = (
      installedPtyFailure: unknown,
      mutateEvidence?: (evidence: Record<string, unknown>) => void,
    ) => executeFailureVerifier(source, installedPtyFailure, mutateEvidence);
    const admitted = installedContractAdmitted;
    const receiptFor = (phase: string, predicate: string) => ({
      ...(phase === "case-execution"
        ? {
            caseOrdinal: 122,
            contractInventorySha256:
              "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a",
          }
        : {}),
      receiptVersion: 1,
      phase,
      predicate,
    });
    const admittedReceipts = Object.entries(admitted).flatMap(
      ([phase, predicates]) =>
        predicates.map((predicate) => receiptFor(phase, predicate)),
    );
    const rejected = [
      {},
      { receiptVersion: 1, phase: "unknown", predicate: "setup-rejected" },
      {
        caseOrdinal: 0,
        contractInventorySha256:
          "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a",
        receiptVersion: 1,
        phase: "case-execution",
        predicate: "unknown",
      },
      {
        caseOrdinal: 0,
        contractInventorySha256:
          "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a",
        receiptVersion: 1,
        phase: "case-execution",
        predicate: "setup-rejected",
        detail: "forbidden",
      },
      { receiptVersion: 1, phase: "artifact-install", predicate: 1 },
    ];
    const validation = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `${failureReceiptValidatorSource(workflow)}\nconst admitted = JSON.parse(process.argv[1]); const rejected = JSON.parse(process.argv[2]); process.exit(admitted.every(validPtyFailure) && rejected.every((value) => !validPtyFailure(value)) ? 0 : 1);`,
        JSON.stringify(admittedReceipts),
        JSON.stringify(rejected),
      ],
      { stdio: "ignore" },
    );
    expect(validation.status).toBe(0);
    expect(executeVerifier(admittedReceipts.at(-1))).toBe(0);
    expect(
      executeVerifier(null, (evidence) => {
        evidence.cleanup = {};
      }),
    ).not.toBe(0);
    expect(
      executeVerifier(null, (evidence) => {
        evidence.executionPolicy = {};
      }),
    ).not.toBe(0);
    expect(
      executeVerifier(null, (evidence) => {
        evidence.tmpfsMounts = [];
      }),
    ).not.toBe(0);
  });

  it.each(["digest", "helper", "identity", "receipt", "terminal"] as const)(
    "fails closed on uploader %s authority",
    (fault) => {
      const workflow = readFileSync(
        resolve(workspaceRoot, ".github/workflows/integration.yml"),
        "utf8",
      );
      expect(
        executeFailureVerifier(
          failureVerifierSource(workflow),
          null,
          undefined,
          fault,
        ),
      ).not.toBe(0);
    },
  );
});

describe("installed-contract cleanup failure evidence", () => {
  it("accepts every closed predicate and rejects substitutions", () => {
    const source = cleanupFailureValidatorSource();
    const validate = (value: unknown) =>
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `${source}\nprocess.exit(validInstalledPtyFailure(JSON.parse(process.argv[1])) ? 0 : 1);`,
          JSON.stringify(value),
        ],
        { encoding: "utf8" },
      ).status;
    const admitted = installedContractAdmitted;
    const receiptFor = (phase: string, predicate: string) => ({
      ...(phase === "case-execution"
        ? {
            caseOrdinal: 0,
            contractInventorySha256:
              "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a",
          }
        : {}),
      receiptVersion: 1,
      phase,
      predicate,
    });
    for (const [phase, predicates] of Object.entries(admitted))
      for (const predicate of predicates)
        expect(validate(receiptFor(phase, predicate))).toBe(0);
    for (const rejected of [
      {},
      { receiptVersion: 1, phase: "unknown", predicate: "setup-rejected" },
      {
        caseOrdinal: 0,
        contractInventorySha256:
          "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a",
        receiptVersion: 1,
        phase: "artifact-install",
        predicate: "setup-rejected",
      },
      {
        caseOrdinal: 0,
        contractInventorySha256:
          "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a",
        receiptVersion: 1,
        phase: "case-execution",
        predicate: "setup-rejected",
        extra: true,
      },
      { receiptVersion: "1", phase: "case-execution", predicate: 1 },
    ])
      expect(validate(rejected)).not.toBe(0);
  });
});

describe("model control-plane isolation", () => {
  it("binds disjoint candidate/control networks and the one-shot proxy", () => {
    const source = readFileSync(
      resolve(workspaceRoot, "tests/integration/run-scenarios.mjs"),
      "utf8",
    );
    expect(source).toContain(
      "for (const network of [plan.networkName, plan.controlNetworkName])",
    );
    expect(source).toContain('"mockserver-control"');
    expect(source).toContain('"model-proxy"');
    expect(source).toContain(
      '"AGENTSCOPE_MODEL_CONTROL_URL=http://mockserver-control:1080"',
    );
    expect(source).toContain(
      '"AGENTSCOPE_MODEL_SERVER_URL=http://model-proxy:4320"',
    );
    expect(source).not.toContain(
      '"AGENTSCOPE_MODEL_SERVER_URL=http://mockserver:1080"',
    );
    expect(source).toContain('"/opt/agentscope/model-server-proxy.mjs"');
    expect(source).toContain('"--read-control"');
    expect(source).toContain("authenticateModelProxyLedger");
    const proxy = readFileSync(
      resolve(workspaceRoot, "tests/integration/model-server-proxy.mjs"),
      "utf8",
    );
    expect(proxy).toContain('.listen(4321, "127.0.0.1")');
    expect(proxy).toContain("const controlHandler = async");
    const adapter = readFileSync(
      resolve(
        workspaceRoot,
        "tests/integration/fixtures/process-platform-adapter.mjs",
      ),
      "utf8",
    );
    expect(adapter).not.toContain("/mockserver/retrieve");
    expect(adapter).not.toContain("/ledger");
    const platformFixture = readFileSync(
      resolve(workspaceRoot, "tests/integration/platform-fixture.mjs"),
      "utf8",
    );
    expect(platformFixture).toContain("/agentscope/ready");
    expect(platformFixture).not.toContain("ACTIVE_EXPECTATIONS");
    const cleanup = readFileSync(
      resolve(workspaceRoot, "tests/integration/clean.mjs"),
      "utf8",
    );
    expect(cleanup).toContain("mockserver|model-proxy");
    expect(cleanup).toContain("network|control-network");
    expect(source).toContain("authenticateDestinationLedgers");
  });
});
