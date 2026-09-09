import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { describe, expect, it } from "vitest";

import { runSupervisedProcess } from "../supervisor.mjs";
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
    '"--property=RemainAfterExit=yes"',
    '"/usr/bin/sudo"',
    '"/usr/bin/systemctl"',
    '"/usr/bin/systemd-run"',
    '"cgroup.events"',
    'facts.LoadState === "not-found"',
  ])
    expect(source).toContain(authority);
  expect(source).not.toContain('"--scope"');
});

describe("integration controller supervision", () => {
  it.runIf(
    process.platform === "linux" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted",
  )(
    "contains a detached session in the authenticated systemd unit",
    async () => {
      const directory = mkdtempSync(resolve(tmpdir(), "agentscope-systemd-"));
      const evidence = resolve(directory, "descendant.pid");
      try {
        const result = await runSupervisedProcess({
          arguments_: [
            resolve(
              workspaceRoot,
              "tests/integration/fixtures/stubborn-controller-child.mjs",
            ),
          ],
          containment: "github-systemd",
          environment: {
            AGENTSCOPE_INTEGRATION_SHARD: "0/1",
            AGENTSCOPE_INTEGRATION_REPLAY: "1",
            AGENTSCOPE_SUPERVISOR_DETACHED: "true",
            AGENTSCOPE_SUPERVISOR_EVIDENCE: evidence,
            GITHUB_ACTIONS: "true",
            GITHUB_JOB: "hermetic-platform",
            GITHUB_REPOSITORY: "Melbourneandrew/agentscope",
            GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
            GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
            GITHUB_SHA: process.env.GITHUB_SHA,
            LANG: "C.UTF-8",
            PATH: "/usr/bin:/bin",
            RUNNER_ENVIRONMENT: "github-hosted",
          },
          executable: process.execPath,
          maximumMilliseconds: 15_000,
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
    },
  );

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
    expect(workflow.match(/\$\{\{ runner\.temp \}\}/gu) ?? []).toHaveLength(0);
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
    const lifecycle = actionSource.indexOf("await runSupervisedProcess({");
    const finalize = actionSource.indexOf("finalizeFailureEvidence({");
    expect(preload).toBeGreaterThanOrEqual(0);
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
