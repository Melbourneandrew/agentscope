import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  chmodSync,
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
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closePreparedGithubSystemdSupervision,
  parseSystemdTerminalExit,
  prepareGithubSystemdSupervision,
  rootPid1ProbeRequired,
  runSupervisedProcess,
  sameSystemdArguments,
  sameSystemdEnvironment,
  snapshotSystemdArguments,
  snapshotSystemdEnvironment,
  systemdToolFailureStage,
  transferDescriptorAuthority,
  validateLiveMappedExecutable,
  validatePythonAuthority,
  validateRootPid1Probe,
  validateRootToolReceipt,
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

it("digests one retained Node descriptor under the original deadline", () => {
  const supervisorSource = readFileSync(
    resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
    "utf8",
  );
  const preparationStart = supervisorSource.indexOf(
    "export const prepareGithubSystemdSupervision = async",
  );
  const start = supervisorSource.indexOf("const runSystemdSupervised = async");
  const end = supervisorSource.indexOf(
    "export const runSupervisedProcess",
    start,
  );
  const lifecycle = supervisorSource.slice(start, end);
  const preparation = supervisorSource.slice(preparationStart, start);
  expect(supervisorSource).toContain(
    "const containmentProofMilliseconds = 5_000;",
  );
  expect(preparation).toContain(
    "const deadline = performance.now() + maximumMilliseconds;",
  );
  expect(preparation.match(/captureLiveMappedExecutable\(/gu)).toHaveLength(1);
  expect(preparation.match(/recheckLiveMappedExecutable\(/gu)).toHaveLength(2);
  expect(lifecycle.match(/recheckLiveMappedExecutable\(/gu)).toHaveLength(1);
  expect(preparation).toContain("systemdStartArguments({");
  expect(lifecycle).not.toContain("systemdStartArguments({");
  expect(preparation.indexOf("systemdStartArguments({")).toBeLessThan(
    preparation.indexOf("systemdPreparations.set(preparation, state)"),
  );
  expect(preparation).toContain("await closePreparedSystemdState(state)");
  expect(preparation).toContain("state.unitMayExist = true;");
  expect(preparation).toContain(
    'mutationDeadline: executionDeadline,\n        operation: "systemd-submit",\n        unit: authority.unit,',
  );
  expect(preparation).toContain('executionDeadline,\n      "unit-admission",');
  expect(preparation).toContain(
    "const arguments_ = snapshotSystemdArguments(suppliedArguments);",
  );
  expect(lifecycle).toContain(
    "!sameSystemdArguments(state.arguments_, suppliedArguments)",
  );
  expect(
    supervisorSource.match(
      /const deadline = performance\.now\(\) \+ maximumMilliseconds;/gu,
    ),
  ).toHaveLength(1);
  expect(lifecycle).not.toContain(
    "const deadline = performance.now() + maximumMilliseconds;",
  );
  expect(lifecycle).toContain(
    "const grace = Math.min(\n        deadline,\n        performance.now() + systemdTerminationGraceMilliseconds,",
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

it("binds root helpers to one absolute boottime authority", () => {
  const supervisorSource = readFileSync(
    resolve(workspaceRoot, "tests/integration/supervisor.mjs"),
    "utf8",
  );
  const preparationStart = supervisorSource.indexOf(
    "export const prepareGithubSystemdSupervision = async",
  );
  const lifecycleStart = supervisorSource.indexOf(
    "const runSystemdSupervised = async",
  );
  const lifecycleEnd = supervisorSource.indexOf(
    "export const runSupervisedProcess",
    lifecycleStart,
  );
  const preparation = supervisorSource.slice(preparationStart, lifecycleStart);
  const lifecycle = supervisorSource.slice(lifecycleStart, lifecycleEnd);
  const tool = supervisorSource.slice(
    supervisorSource.indexOf("const runTool ="),
    supervisorSource.indexOf("const rootTool ="),
  );
  expect(
    tool.indexOf("const timeout = remainingMilliseconds(deadline);"),
  ).toBeLessThan(tool.indexOf("const child = spawn("));
  expect(tool).toContain("}, timeout);");
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
    'timeoutPath,\n      "--signal=TERM",\n      `--kill-after=${killAfterSeconds}`,\n      rootTimeoutSeconds,',
  );
  expect(rootTool).toContain(
    'pythonPath,\n      "-I",\n      "-S",\n      "-c",\n      rootHelperSource,',
  );
  expect(rootTool).toContain("absoluteBoottimeDeadline(deadline)");
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
  expect(rootHelper).toContain("boundary=min(CUTOFF,DEADLINE-750000000)");
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
  expect(rootHelper).toContain("if group_members(leader)!=[leader]");
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
  expect(preparation).toContain('operation: "systemd-submit"');
  expect(preparation).toContain('executionDeadline,\n      "unit-admission",');
  expect(lifecycle).toContain('executionDeadline,\n      "unit-admission",');
  expect(lifecycle).toContain(
    'executionDeadline,\n      "unit-authoritative",',
  );
  expect(lifecycle).not.toContain(
    "const authoritative = await showUnit(authority.unit, deadline);",
  );
});

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
  "rejects a delayed sentinel transition at the original cutoff",
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
      reason: "transition-timeout",
      stage: "sentinel",
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
      reason: "",
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
    "client-terminal",
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
  const receiptFor = (
    stage: string,
    status = "error",
    output = "",
    reason = stage === "sentinel" ? "transition-timeout" : "",
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
      reason: stage === "sentinel" ? "transition-timeout" : "",
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
  expect(supervisor).toContain("systemdToolFailures.set(error, predicate)");
  expect(supervisor).toContain(
    "new Error(`integration.controller.systemd-tool:${predicate}`)",
  );
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

describe("integration workflow routing policy", () => {
  it("routes both CI phases through the same command", () => {
    const workflow = readFileSync(
      resolve(workspaceRoot, ".github/workflows/integration.yml"),
      "utf8",
    );
    expect(workflow.match(/pnpm test:integration/gu)).toHaveLength(1);
    expect(workflow.match(/runs-on: ubuntu-24\.04/gu)).toHaveLength(1);
    expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(2);
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
