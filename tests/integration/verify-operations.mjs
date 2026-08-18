import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { acquireIntegrationOperationLock } from "./operation-lock.mjs";

const execute = promisify(execFile);
const integrationRoot = import.meta.dirname;
const workspaceRoot = resolve(integrationRoot, "../..");
const artifactsRoot = resolve(workspaceRoot, "artifacts/integration");
const runsRoot = resolve(artifactsRoot, "runs");
const sentinel = resolve(
  workspaceRoot,
  "artifacts",
  `integration-host-sentinel-${process.pid}`,
);
const runDirectories = () =>
  new Set(
    existsSync(runsRoot)
      ? readdirSync(runsRoot, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory() ? [entry.name] : [],
        )
      : [],
  );
const runOnce = (testMode) =>
  execute(process.execPath, [resolve(integrationRoot, "run-scenarios.mjs")], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      AGENTSCOPE_INTEGRATION_CONCURRENCY: "1",
      AGENTSCOPE_INTEGRATION_TIMEOUT_MS: "300000",
      ...(testMode === undefined
        ? {}
        : { AGENTSCOPE_INTEGRATION_TEST_MODE: testMode }),
    },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 6 * 60 * 1000,
  });
const verifySymlinkedRootIsRejected = () => {
  const victim = mkdtempSync(resolve(tmpdir(), "agentscope-clean-victim-"));
  const victimRun = resolve(victim, "runs", "0123456789abcdef");
  mkdirSync(victimRun, { recursive: true });
  writeFileSync(resolve(victimRun, "sentinel"), "VICTIM\n");
  symlinkSync(victim, artifactsRoot, "dir");
  let rejected = false;
  try {
    execFileSync(process.execPath, [resolve(integrationRoot, "clean.mjs")], {
      cwd: workspaceRoot,
      stdio: "pipe",
    });
  } catch {
    rejected = true;
  } finally {
    rmSync(artifactsRoot, { force: true });
  }
  if (
    !rejected ||
    readFileSync(resolve(victimRun, "sentinel"), "utf8") !== "VICTIM\n"
  )
    throw new Error("integration.operations.symlink-root");
  rmSync(victim, { force: true, recursive: true });
};

mkdirSync(resolve(workspaceRoot, "artifacts"), { recursive: true });
writeFileSync(sentinel, "HOST_SENTINEL\n");
try {
  const beforeFailure = runDirectories();
  let sidecarFailureRejected = false;
  try {
    await runOnce("sidecar-failure");
  } catch {
    sidecarFailureRejected = true;
  }
  const failedRuns = [...runDirectories()].filter(
    (name) => !beforeFailure.has(name),
  );
  if (!sidecarFailureRejected || failedRuns.length !== 1)
    throw new Error("integration.operations.failure-evidence");
  const failedDirectory = resolve(runsRoot, failedRuns[0]);
  const failedEvidence = JSON.parse(
    readFileSync(resolve(failedDirectory, "evidence.json"), "utf8"),
  );
  const failedLifecycle = JSON.parse(
    readFileSync(resolve(failedDirectory, "fixture-lifecycle.json"), "utf8"),
  );
  if (
    failedEvidence.outcome !== "failed" ||
    failedLifecycle.resultStatus !== "partial"
  )
    throw new Error("integration.operations.failure-evidence");
  for (const fileName of [
    "evidence.json",
    "model-ledger.json",
    "destination-ledger.json",
    "fixture-lifecycle.json",
  ]) {
    if (!statSync(resolve(failedDirectory, fileName)).isFile())
      throw new Error("integration.operations.failure-evidence");
  }
  const successfulBefore = runDirectories();
  await runOnce();
  await Promise.all([runOnce(), runOnce()]);
  const created = [...runDirectories()].filter(
    (name) => !successfulBefore.has(name),
  );
  if (created.length !== 3 || new Set(created).size !== created.length)
    throw new Error("integration.operations.repetition");
  for (const runId of created) {
    if (!/^[a-f\d]{16}$/u.test(runId))
      throw new Error("integration.operations.repetition");
    const directory = resolve(runsRoot, runId);
    const evidence = JSON.parse(
      readFileSync(resolve(directory, "evidence.json"), "utf8"),
    );
    if (evidence.runId !== runId || evidence.outcome !== "passed")
      throw new Error("integration.operations.repetition");
    for (const fileName of [
      "evidence.json",
      "model-ledger.json",
      "destination-ledger.json",
      "fixture-lifecycle.json",
    ]) {
      const path = resolve(directory, fileName);
      if (!statSync(path).isFile() || statSync(path).size > 1024 * 1024)
        throw new Error("integration.operations.repetition");
    }
  }
  const activeRoot = resolve(artifactsRoot, "active");
  const activeMarker = resolve(activeRoot, "aaaaaaaaaaaaaaaa.json");
  mkdirSync(activeRoot, { recursive: true });
  writeFileSync(
    activeMarker,
    `${JSON.stringify({ activeVersion: 1, runId: "aaaaaaaaaaaaaaaa", pid: process.pid })}\n`,
  );
  for (const operation of ["clean.mjs", "maintain-artifacts.mjs"]) {
    let activeRejected = false;
    try {
      execFileSync(process.execPath, [resolve(integrationRoot, operation)], {
        cwd: workspaceRoot,
        stdio: "pipe",
      });
    } catch {
      activeRejected = true;
    }
    if (!activeRejected || !existsSync(resolve(runsRoot, created[0])))
      throw new Error("integration.operations.active-run");
  }
  const releaseOperationLock = await acquireIntegrationOperationLock(
    workspaceRoot,
    "integration.operations.active-run",
  );
  let registrationRejected = false;
  try {
    await runOnce();
  } catch {
    registrationRejected = true;
  } finally {
    await releaseOperationLock();
  }
  if (!registrationRejected || !existsSync(resolve(runsRoot, created[0])))
    throw new Error("integration.operations.active-run");
  const lockModule = pathToFileURL(
    resolve(integrationRoot, "operation-lock.mjs"),
  ).href;
  const exited = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { acquireIntegrationOperationLock } = await import(${JSON.stringify(lockModule)}); await acquireIntegrationOperationLock(${JSON.stringify(workspaceRoot)}, "integration.operations.stale-lock"); process.exit(0);`,
    ],
    { cwd: workspaceRoot, encoding: "utf8" },
  );
  if (exited.status !== 0) throw new Error("integration.operations.stale-lock");
  const releaseReclaimedLock = await acquireIntegrationOperationLock(
    workspaceRoot,
    "integration.operations.stale-lock",
  );
  await releaseReclaimedLock();
  rmSync(activeMarker);
  rmSync(activeRoot, { recursive: true });
  execFileSync(process.execPath, [resolve(integrationRoot, "clean.mjs")], {
    cwd: workspaceRoot,
    stdio: "inherit",
  });
  verifySymlinkedRootIsRejected();
  if (readFileSync(sentinel, "utf8") !== "HOST_SENTINEL\n")
    throw new Error("integration.operations.sentinel");
  const resources = [
    ["container", "ls", "--all"],
    ["network", "ls"],
    ["image", "ls"],
  ].map(([kind, command, flag]) =>
    execFileSync(
      "docker",
      [
        kind,
        command,
        ...(flag ? [flag] : []),
        "--quiet",
        "--filter",
        "label=com.agentscope.integration=true",
      ],
      { encoding: "utf8" },
    ).trim(),
  );
  if (resources.some(Boolean))
    throw new Error("integration.operations.cleanup");
} finally {
  rmSync(sentinel, { force: true });
}
console.log(
  "Verified sequential and parallel isolation, bounded artifacts, and owned cleanup.",
);
