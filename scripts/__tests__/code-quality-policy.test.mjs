import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { test } from "vitest";
import {
  auditCodeQualityPolicy,
  auditCoverageRatchet,
} from "../code-quality-policy.mjs";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
// In-process typed lint measured 3.5s under 12-of-16-core load. This is a
// test-only ceiling, not a retry or a workspace-wide timeout.
const eslintPolicyPhaseDeadlineMs = 25_000;
const eslintPolicyTestDeadlineMs = eslintPolicyPhaseDeadlineMs + 1_000;
// Two concurrent coverage seed runs completed in 5.62s under the reproduced
// contention. The 15s phase authority is measured headroom plus a 5s join and
// assertion reserve; it is not inherited from Vitest's ineffective 5s timer.
const coveragePolicyPhaseDeadlineMs = 15_000;
const coveragePolicyTeardownMilliseconds = 5_000;
const coveragePolicyTestDeadlineMs =
  coveragePolicyPhaseDeadlineMs + coveragePolicyTeardownMilliseconds + 1_000;
const coveragePolicyOutputBytes = 512 * 1024;
const vitestModuleUrl = import.meta.resolve("vitest/node");
const coverageFixtureReadinessMilliseconds = 2_000;
const coverageFixtureTeardownMilliseconds = 1_000;

function coverageWorkerError(message, workerJoined = true) {
  const error = new Error(message);
  error.workerJoined = workerJoined;
  return error;
}

function coverageGroupIsAbsent(pid) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw coverageWorkerError(
      "Vitest coverage policy containment failed",
      false,
    );
  }
}

function killCoverageGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH")
      throw coverageWorkerError(
        "Vitest coverage policy containment failed",
        false,
      );
  }
}

async function stopUncontainedCoverageOwner() {
  try {
    process.kill(process.pid, "SIGKILL");
  } catch {
    process.abort();
  }
  await new Promise(() => {});
}

async function waitForCoverageContainment(
  child,
  closed,
  deadlineAt,
  groupIsAbsent,
) {
  let closeValue;
  void closed.then((value) => {
    closeValue = value;
  });
  while (performance.now() < deadlineAt) {
    if (closeValue !== undefined && groupIsAbsent(child.pid)) return closeValue;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  return undefined;
}

const coverageWorkerSource = String.raw`
  const { Writable } = require("node:stream");
  const { existsSync } = require("node:fs");
  const { spawn } = require("node:child_process");
  let workerData;
  let closeCoverage;
  let cancelRequested = false;

  const publish = (value) => {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    process.send(
      bytes > workerData.maximumOutputBytes
        ? { kind: "output-overflow" }
        : { kind: "result", value },
    );
  };

  const run = async () => {
    if (workerData.mode === "fail")
      throw new Error("SENSITIVE_COVERAGE_WORKER_FAILURE");
    if (workerData.mode === "success") {
      publish({ status: 0, stdout: "", stderr: "" });
      return;
    }
    if (
      workerData.mode === "success-with-descendant" ||
      workerData.mode === "combined-output-overflow"
    ) {
      const descendant = spawn(
        process.execPath,
        [
          "--eval",
          'const { appendFileSync } = require("node:fs");' +
            'const path = process.argv[1];' +
            'appendFileSync(path, "ready\\n");' +
            'setInterval(() => appendFileSync(path, "tick\\n"), 5);',
          workerData.readinessPath,
        ],
        { stdio: "ignore" },
      );
      descendant.unref();
      while (!existsSync(workerData.readinessPath))
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      if (workerData.mode === "combined-output-overflow") {
        const sourceBytes = Math.floor(workerData.maximumOutputBytes * 0.55);
        const streamOutput =
          "SENSITIVE_COMBINED_STREAM_OUTPUT".padEnd(sourceBytes, "S");
        const messageResult = {
          status: 0,
          stdout: "SENSITIVE_COMBINED_MESSAGE_OUTPUT".padEnd(sourceBytes, "M"),
          stderr: "",
        };
        const streamBytes = Buffer.byteLength(streamOutput, "utf8");
        const messageBytes = Buffer.byteLength(
          JSON.stringify(messageResult),
          "utf8",
        );
        if (
          streamBytes >= workerData.maximumOutputBytes ||
          messageBytes >= workerData.maximumOutputBytes ||
          streamBytes + messageBytes <= workerData.maximumOutputBytes
        )
          throw new Error(
            "combined output fixture does not cross only the aggregate ceiling",
          );
        process.stdout.write(streamOutput);
        publish(messageResult);
        await new Promise(() => {});
      }
      publish({ status: 0, stdout: "", stderr: "" });
      return;
    }
    if (workerData.mode === "message-overflow") {
      publish({
        status: 1,
        stdout: "SENSITIVE_COVERAGE_MESSAGE_OUTPUT".repeat(
          workerData.maximumOutputBytes,
        ),
        stderr: "",
      });
      return;
    }
    if (workerData.mode === "stream-overflow") {
      process.stdout.write(
        "SENSITIVE_COVERAGE_STREAM_OUTPUT".repeat(workerData.maximumOutputBytes),
      );
      await new Promise(() => {});
    }
    let output = "";
    let outputBytes = 0;
    let outputOverflow = false;
    const writer = new Writable({
      write(chunk, _encoding, callback) {
        const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        const valueBytes = Buffer.byteLength(value, "utf8");
        if (outputBytes + valueBytes > workerData.maximumOutputBytes) {
          if (!outputOverflow) process.send({ kind: "output-overflow" });
          outputOverflow = true;
        } else if (!outputOverflow) {
          output += value;
          outputBytes += valueBytes;
        }
        callback();
      },
    });
    process.exitCode = 0;
    const { createVitest } = await import(workerData.vitestModuleUrl);
    const originalConsoleError = console.error;
    let testFilesPassed = false;
    let unhandledErrorCount = 0;
    console.error = (...values) => writer.write(values.join(" ") + "\n");
    try {
      const context = await createVitest(
        "test",
        {
          root: workerData.packageRoot,
          config: workerData.configPath,
          run: true,
          pool: "threads",
          ...(workerData.testFilters.length > 0
            ? { include: workerData.testFilters }
            : {}),
          coverage: {
            enabled: true,
            provider: "v8",
            reporter: [["text", { skipFull: false }]],
            reportsDirectory: workerData.reportRoot,
            include: workerData.coverageIncludes,
            exclude: [
              "src/bin/**",
              "src/**/*.{test,spec}.{ts,tsx}",
              "src/**/__tests__/**",
              "src/**/*.d.ts",
            ],
            thresholds: workerData.thresholds,
          },
        },
        undefined,
        { stdout: writer, stderr: writer },
      );
      let closing;
      const close = () =>
        (closing ??=
          workerData.mode === "coverage-close-hang"
            ? new Promise(() => {})
            : context.close());
      closeCoverage = close;
      const cancel = (message) => {
        if (message?.kind === "cancel") void close();
      };
      process.on("message", cancel);
      if (cancelRequested) void close();
      const running = context.start(workerData.testFilters);
      if (workerData.mode === "coverage-active-overflow") {
        while (!existsSync(workerData.readinessPath))
          await new Promise((resolveWait) => setTimeout(resolveWait, 5));
        writer.write(
          "SENSITIVE_ACTIVE_COVERAGE_OUTPUT".repeat(
            workerData.maximumOutputBytes,
          ),
        );
      }
      try {
        await running;
        testFilesPassed =
          context.state.getFiles().length > 0 &&
          context.state
            .getFiles()
            .every((file) => file.result?.state === "pass");
        unhandledErrorCount = context.state.getUnhandledErrors().length;
      } finally {
        await close();
        process.off("message", cancel);
        closeCoverage = undefined;
      }
    } finally {
      console.error = originalConsoleError;
    }
    if (outputOverflow) {
      process.send({ kind: "output-overflow" });
      process.exitCode = 0;
      return;
    }
    const status = process.exitCode ?? 0;
    process.exitCode = 0;
    publish({
      status,
      stdout: output,
      stderr: "",
      testFilesPassed,
      unhandledErrorCount,
    });
  };

  process.on("message", (message) => {
    if (message?.kind === "cancel") {
      cancelRequested = true;
      if (closeCoverage) void closeCoverage();
    }
  });
  process.once("message", (message) => {
    if (message?.kind !== "start") return;
    workerData = message.workerData;
    run()
      .catch(() => {
        process.send({ kind: "worker-failure" });
        process.exitCode = 1;
      })
      .finally(() => process.disconnect());
  });
`;

const coverageHeartbeatFixtureSource = String.raw`
  const { appendFileSync } = require("node:fs");
  const [heartbeatPath, token, startIdentity, mode] = process.argv.slice(1);
  const ready = {
    kind: "ready",
    token,
    startIdentity,
    pid: process.pid,
    groupPid: process.pid,
  };
  if (mode === "missing") process.send(ready);
  else if (mode === "substituted") {
    appendFileSync(
      heartbeatPath,
      "ready:" + token + ":" + process.pid + ":" + startIdentity + "\n",
    );
    process.send({ ...ready, pid: process.pid + 1 });
  } else if (mode === "unrelated-token") {
    appendFileSync(
      heartbeatPath,
      "ready:unrelated:" + process.pid + ":" + startIdentity + "\n",
    );
    process.send({ ...ready, token: "unrelated" });
  } else if (mode === "valid") {
    appendFileSync(
      heartbeatPath,
      "ready:" + token + ":" + process.pid + ":" + startIdentity + "\n",
    );
    process.send(ready);
  }
  setInterval(
    () => appendFileSync(heartbeatPath, "tick:" + token + "\n"),
    5,
  );
`;

function createCoverageOutputBudget(maximumOutputBytes, overflow) {
  let retainedBytes = 0;
  let overflowed = false;
  const markOverflowed = () => {
    if (overflowed) return;
    retainedBytes = 0;
    overflowed = true;
    overflow();
  };
  return {
    retain(byteLength) {
      if (overflowed) return false;
      if (retainedBytes + byteLength <= maximumOutputBytes) {
        retainedBytes += byteLength;
        return true;
      }
      markOverflowed();
      return false;
    },
    overflow: markOverflowed,
    overflowed: () => overflowed,
  };
}

function observeCoverageWorkerOutput(worker, outputBudget) {
  let workerStdout = "";
  let workerStderr = "";
  const observe = (stream) => (chunk) => {
    const value = Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : String(chunk);
    const byteLength = Buffer.isBuffer(chunk)
      ? chunk.byteLength
      : Buffer.byteLength(value, "utf8");
    if (outputBudget.retain(byteLength)) {
      if (stream === "stdout") workerStdout += value;
      else workerStderr += value;
    }
  };
  worker.stdout.on("data", observe("stdout"));
  worker.stderr.on("data", observe("stderr"));
  const streamsDrained = Promise.all([
    new Promise((resolveEnd) => worker.stdout.once("end", resolveEnd)),
    new Promise((resolveEnd) => worker.stderr.once("end", resolveEnd)),
  ]);
  return {
    streamsDrained,
    discard() {
      workerStdout = "";
      workerStderr = "";
    },
    read: () => ({ workerStdout, workerStderr }),
  };
}

async function runCoveragePolicyWorker({
  reportRoot,
  thresholds,
  testFilters = [],
  coverageIncludes = ["src/**/*.{ts,tsx}"],
  phaseDeadlineMs = coveragePolicyPhaseDeadlineMs,
  mode = "coverage",
  maximumOutputBytes = coveragePolicyOutputBytes,
  readinessPath,
  groupIsAbsent = coverageGroupIsAbsent,
  killGroup = killCoverageGroup,
  containmentFailure = stopUncontainedCoverageOwner,
  teardownMilliseconds = coveragePolicyTeardownMilliseconds,
}) {
  const startedAt = performance.now();
  const deadlineAt = startedAt + phaseDeadlineMs;
  if (process.platform === "win32")
    throw coverageWorkerError(
      "Vitest coverage policy requires POSIX process-group containment",
    );
  let worker;
  const workerData = {
    mode,
    packageRoot: join(repositoryRoot, "packages/testkit"),
    configPath: join(repositoryRoot, "vitest.config.ts"),
    reportRoot,
    thresholds,
    testFilters,
    coverageIncludes,
    vitestModuleUrl,
    maximumOutputBytes,
    readinessPath,
  };
  try {
    worker = spawn(
      process.execPath,
      [
        "--max-old-space-size=512",
        "--input-type=commonjs",
        "--eval",
        coverageWorkerSource,
      ],
      {
        cwd: repositoryRoot,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    worker.send({
      kind: "start",
      workerData,
    });
  } catch {
    throw coverageWorkerError("Vitest coverage policy worker failed to start");
  }
  return await settleCoveragePolicyWorker({
    worker,
    startedAt,
    deadlineAt,
    phaseDeadlineMs,
    maximumOutputBytes,
    groupIsAbsent,
    killGroup,
    containmentFailure,
    teardownMilliseconds,
  });
}

async function settleCoveragePolicyWorker({
  worker,
  startedAt,
  deadlineAt,
  phaseDeadlineMs,
  maximumOutputBytes,
  groupIsAbsent,
  killGroup,
  containmentFailure,
  teardownMilliseconds,
}) {
  let message;
  let workerFailure = false;
  let output;
  let resolveOutputOverflow;
  const outputOverflow = new Promise((resolveOverflow) => {
    resolveOutputOverflow = resolveOverflow;
  });
  const outputBudget = createCoverageOutputBudget(maximumOutputBytes, () => {
    message = undefined;
    output?.discard();
    resolveOutputOverflow({ kind: "output-overflow" });
  });
  output = observeCoverageWorkerOutput(worker, outputBudget);
  const closed = new Promise((resolveClose) => {
    worker.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  worker.on("message", (value) => {
    if (value?.kind === "output-overflow") {
      outputBudget.overflow();
      return;
    }
    if (
      value?.kind === "result" &&
      outputBudget.retain(
        Buffer.byteLength(JSON.stringify(value.value), "utf8"),
      )
    )
      message = value;
  });
  worker.once("error", () => {
    workerFailure = true;
  });
  let deadlineTimer;
  const deadline = new Promise((resolveDeadline) => {
    deadlineTimer = setTimeout(
      () => resolveDeadline({ kind: "deadline" }),
      Math.max(1, deadlineAt - performance.now()),
    );
  });
  try {
    const first = await Promise.race([
      closed.then((value) => ({ kind: "close", value })),
      deadline,
      outputOverflow,
    ]);
    if (first.kind === "output-overflow") {
      await terminateCoverageChild({
        child: worker,
        closed,
        deadlineAt,
        groupIsAbsent,
        killGroup,
        teardownMilliseconds,
      });
      throw coverageWorkerError(
        "Vitest coverage policy output exceeded its byte ceiling; worker joined",
      );
    }
    if (first.kind === "deadline" || performance.now() >= deadlineAt) {
      if (first.kind !== "close" || !groupIsAbsent(worker.pid))
        await terminateCoverageChild({
          child: worker,
          closed,
          deadlineAt,
          groupIsAbsent,
          killGroup,
          teardownMilliseconds,
        });
      const elapsedMs = Math.ceil(performance.now() - startedAt);
      throw coverageWorkerError(
        `Vitest coverage policy exceeded its ${phaseDeadlineMs}ms phase deadline; worker joined after ${elapsedMs}ms`,
      );
    }
    if (!groupIsAbsent(worker.pid)) {
      await terminateCoverageChild({
        child: worker,
        closed,
        deadlineAt,
        groupIsAbsent,
        killGroup,
        teardownMilliseconds,
      });
      throw coverageWorkerError("Vitest coverage policy worker failed");
    }
    if (outputBudget.overflowed()) {
      throw coverageWorkerError(
        "Vitest coverage policy output exceeded its byte ceiling; worker joined",
      );
    }
    if (
      workerFailure ||
      first.value.code !== 0 ||
      (message?.kind !== "result" && message?.kind !== "output-overflow")
    ) {
      throw coverageWorkerError("Vitest coverage policy worker failed");
    }
    const { workerStdout, workerStderr } = output.read();
    return {
      ...message.value,
      stdout: `${message.value.stdout}${workerStdout}`,
      stderr: `${message.value.stderr}${workerStderr}`,
    };
  } catch (error) {
    if (error?.workerJoined === false) await containmentFailure();
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
  }
}

async function terminateCoverageChild({
  child,
  closed,
  deadlineAt,
  groupIsAbsent,
  killGroup,
  teardownMilliseconds,
}) {
  const teardownDeadlineAt = deadlineAt + teardownMilliseconds;
  if (child.connected) child.send({ kind: "cancel" });
  const cooperativeDeadlineAt = Math.min(
    teardownDeadlineAt,
    performance.now() + 500,
  );
  const cooperative = await waitForCoverageContainment(
    child,
    closed,
    cooperativeDeadlineAt,
    groupIsAbsent,
  );
  if (cooperative !== undefined) return cooperative;
  killGroup(child.pid);
  const forced = await waitForCoverageContainment(
    child,
    closed,
    teardownDeadlineAt,
    groupIsAbsent,
  );
  if (forced === undefined)
    throw coverageWorkerError(
      "Vitest coverage policy containment failed",
      false,
    );
  return forced;
}

async function lintPolicySeed(path) {
  // Workspace lint configuration and plugins are trusted test code; this
  // helper owns only direct, non-concurrent programmatic invocation.
  const [result] = await new ESLint({
    cwd: repositoryRoot,
    concurrency: "off",
  }).lintFiles([path]);
  return result;
}

function lintRuleIds(result) {
  return new Set(result.messages.map((message) => message.ruleId));
}

function createCoverageHangFixture() {
  let fixtureRoot;
  let reportRoot;
  let heartbeatRoot;
  try {
    fixtureRoot = mkdtempSync(
      join(repositoryRoot, "packages/testkit/.coverage-policy-hang-"),
    );
    reportRoot = mkdtempSync(
      join(tmpdir(), "agentscope-coverage-policy-timeout-report-"),
    );
    heartbeatRoot = mkdtempSync(
      join(tmpdir(), "agentscope-coverage-policy-heartbeat-"),
    );
    const heartbeatPath = join(heartbeatRoot, "heartbeat");
    const testPath = join(fixtureRoot, "hang.test.ts");
    const lines = [
      'import { appendFileSync } from "node:fs";',
      'import { test } from "vitest";',
      'test("controlled nested hang", async () => {',
      `  const heartbeatPath = ${JSON.stringify(heartbeatPath)};`,
      '  appendFileSync(heartbeatPath, "ready\\n");',
    ];
    lines.push(
      '  setInterval(() => appendFileSync(heartbeatPath, "tick\\n"), 5);',
      "  await new Promise(() => {});",
      "});",
      "",
    );
    writeFileSync(testPath, lines.join("\n"));
    const qualityPolicy = JSON.parse(
      readFileSync(join(repositoryRoot, "quality-policy.json"), "utf8"),
    );
    return {
      fixtureRoot,
      heartbeatRoot,
      heartbeatPath,
      reportRoot,
      readinessToken: randomBytes(32).toString("hex"),
      testPath,
      thresholds: qualityPolicy.packages["packages/testkit"].coverage,
      cleanup() {
        try {
          rmSync(fixtureRoot, { recursive: true, force: true });
        } finally {
          try {
            rmSync(reportRoot, { recursive: true, force: true });
          } finally {
            rmSync(heartbeatRoot, { recursive: true, force: true });
          }
        }
      },
    };
  } catch (error) {
    try {
      if (fixtureRoot !== undefined)
        rmSync(fixtureRoot, { recursive: true, force: true });
    } finally {
      try {
        if (reportRoot !== undefined)
          rmSync(reportRoot, { recursive: true, force: true });
      } finally {
        if (heartbeatRoot !== undefined)
          rmSync(heartbeatRoot, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

function coverageFixtureReadinessMatches(message, owner, fixture) {
  if (
    message?.kind !== "ready" ||
    message.token !== fixture.readinessToken ||
    message.startIdentity !== owner.startIdentity ||
    message.pid !== owner.child.pid ||
    message.groupPid !== owner.child.pid ||
    !existsSync(fixture.heartbeatPath) ||
    !statSync(fixture.heartbeatPath).isFile()
  )
    return false;
  const [readyLine] = readFileSync(fixture.heartbeatPath, "utf8").split("\n");
  return (
    readyLine ===
      `ready:${fixture.readinessToken}:${owner.child.pid}:${owner.startIdentity}` &&
    !coverageGroupIsAbsent(owner.child.pid)
  );
}

async function stopCoverageHeartbeatOwner(owner) {
  try {
    process.kill(-owner.child.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH")
      throw coverageWorkerError(
        "Coverage heartbeat fixture readiness failed",
        false,
      );
  }
  const cooperative = await waitForCoverageContainment(
    owner.child,
    owner.closed,
    Math.min(owner.outerDeadlineAt, performance.now() + 100),
    coverageGroupIsAbsent,
  );
  if (cooperative !== undefined) return;
  killCoverageGroup(owner.child.pid);
  const forced = await waitForCoverageContainment(
    owner.child,
    owner.closed,
    owner.outerDeadlineAt,
    coverageGroupIsAbsent,
  );
  if (forced === undefined)
    throw coverageWorkerError(
      "Coverage heartbeat fixture readiness failed",
      false,
    );
}

async function waitForCoverageFixtureReadiness(
  owner,
  fixture,
  observeReadinessAt,
) {
  let readinessTimer;
  let fail;
  let ready;
  try {
    await new Promise((resolveReady, rejectReady) => {
      fail = () =>
        rejectReady(
          coverageWorkerError("Coverage heartbeat fixture readiness failed"),
        );
      ready = (message) => {
        try {
          const observedAt = observeReadinessAt(owner);
          if (
            !Number.isFinite(observedAt) ||
            observedAt >= owner.readinessDeadlineAt ||
            !coverageFixtureReadinessMatches(message, owner, fixture)
          ) {
            fail();
            return;
          }
        } catch {
          fail();
          return;
        }
        resolveReady();
      };
      owner.child.once("message", ready);
      owner.child.once("error", fail);
      owner.child.once("close", fail);
      readinessTimer = setTimeout(
        fail,
        Math.max(1, owner.readinessDeadlineAt - performance.now()),
      );
    });
  } finally {
    clearTimeout(readinessTimer);
    owner.child.off("message", ready);
    owner.child.off("error", fail);
    owner.child.off("close", fail);
  }
}

async function startCoverageHeartbeatOwner(
  fixture,
  mode = "valid",
  observeReadinessAt = () => performance.now(),
) {
  const startedAt = performance.now();
  const readinessDeadlineAt = startedAt + coverageFixtureReadinessMilliseconds;
  const outerDeadlineAt =
    readinessDeadlineAt + coverageFixtureTeardownMilliseconds;
  const startIdentity = randomBytes(32).toString("hex");
  const child = spawn(
    process.execPath,
    [
      "--input-type=commonjs",
      "--eval",
      coverageHeartbeatFixtureSource,
      fixture.heartbeatPath,
      fixture.readinessToken,
      startIdentity,
      mode,
    ],
    {
      cwd: repositoryRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const closed = new Promise((resolveClose) => {
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  const owner = {
    child,
    closed,
    outerDeadlineAt,
    readinessDeadlineAt,
    startIdentity,
  };
  try {
    await waitForCoverageFixtureReadiness(owner, fixture, observeReadinessAt);
    return owner;
  } catch {
    await stopCoverageHeartbeatOwner(owner);
    try {
      fixture.cleanup();
    } catch {
      throw coverageWorkerError("Coverage heartbeat fixture readiness failed");
    }
    throw coverageWorkerError("Coverage heartbeat fixture readiness failed");
  }
}

function createCoverageProbeFixture() {
  let fixtureRoot;
  let markerRoot;
  try {
    fixtureRoot = mkdtempSync(
      join(repositoryRoot, "packages/testkit/src/coverage-policy-probe-"),
    );
    markerRoot = mkdtempSync(
      join(tmpdir(), "agentscope-coverage-policy-unrelated-"),
    );
    const markerPath = join(markerRoot, "started");
    const probePath = join(fixtureRoot, "probe.test.ts");
    writeFileSync(
      join(fixtureRoot, "probe.ts"),
      "export const coveredCoverageProbe = () => true;\n",
    );
    writeFileSync(
      probePath,
      [
        'import { expect, test } from "vitest";',
        'import { coveredCoverageProbe } from "./probe";',
        'test("controlled coverage probe", () =>',
        "  expect(coveredCoverageProbe()).toBe(true),",
        ");",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(fixtureRoot, "unrelated.test.ts"),
      [
        'import { writeFileSync } from "node:fs";',
        'import { test } from "vitest";',
        'test("unrelated package test", () => {',
        `  writeFileSync(${JSON.stringify(markerPath)}, "started");`,
        "});",
        "",
      ].join("\n"),
    );
    return {
      fixtureRoot,
      markerPath,
      probePath,
      cleanup() {
        try {
          rmSync(fixtureRoot, { recursive: true, force: true });
        } finally {
          rmSync(markerRoot, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      if (fixtureRoot !== undefined)
        rmSync(fixtureRoot, { recursive: true, force: true });
    } finally {
      if (markerRoot !== undefined)
        rmSync(markerRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

async function assertHeartbeatStopped(heartbeatPath) {
  assert.equal(existsSync(heartbeatPath), true);
  const heartbeatBytesAtReturn = statSync(heartbeatPath).size;
  assert.ok(heartbeatBytesAtReturn > 0);
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  assert.equal(statSync(heartbeatPath).size, heartbeatBytesAtReturn);
}

function cleanupCoverageSeed({ seedRoot, reportRoot, probeFixture }) {
  let cleanupError;
  const cleanups = [
    () => {
      if (seedRoot !== undefined)
        rmSync(seedRoot, { recursive: true, force: true });
    },
    () => {
      if (reportRoot !== undefined)
        rmSync(reportRoot, { recursive: true, force: true });
    },
    () => probeFixture?.cleanup(),
  ];
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError !== undefined) throw cleanupError;
}

function coverageTableColumns(line) {
  return line.split("|").map((column) => column.trim());
}

function coverageTableFileMatchesSeed(fileColumn, seedDirectoryName) {
  if (fileColumn === seedDirectoryName) return true;
  const visibleSuffix = fileColumn.startsWith("...")
    ? fileColumn.slice(3)
    : fileColumn.startsWith("…")
      ? fileColumn.slice(1)
      : "";
  const seedIdentityIndex = seedDirectoryName.lastIndexOf("seed-");
  if (seedIdentityIndex === -1) return false;
  const seedIdentity = seedDirectoryName.slice(seedIdentityIndex);
  return (
    visibleSuffix.length >= seedIdentity.length &&
    visibleSuffix.endsWith(seedIdentity) &&
    seedDirectoryName.endsWith(visibleSuffix)
  );
}

function coverageTableFileMatchesProbe(fileColumn, probeDirectoryName) {
  if (fileColumn === probeDirectoryName) return true;
  const visibleSuffix = fileColumn.startsWith("...")
    ? fileColumn.slice(3)
    : fileColumn.startsWith("…")
      ? fileColumn.slice(1)
      : "";
  const probeIdentityIndex = probeDirectoryName.lastIndexOf("probe-");
  if (probeIdentityIndex === -1) return false;
  const probeIdentity = probeDirectoryName.slice(probeIdentityIndex);
  return (
    visibleSuffix.length >= probeIdentity.length &&
    visibleSuffix.endsWith(probeIdentity) &&
    probeDirectoryName.endsWith(visibleSuffix)
  );
}

function coverageMetricValue(value) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const percentage = Number(value);
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100)
    return undefined;
  return percentage;
}

function coverageMetricEquals(value, expected) {
  return coverageMetricValue(value) === expected;
}

function assertSeededCoverageGateFailure(
  result,
  seedRoot,
  thresholds,
  probeRoot,
) {
  assert.notEqual(result.status, 0);
  assert.equal(result.testFilesPassed, true);
  assert.equal(result.unhandledErrorCount, 0);
  const metricNames = ["statements", "branches", "functions", "lines"];
  for (const metric of metricNames) assert.ok(Number(thresholds[metric]) > 0);
  const outputLines = `${result.stdout}${result.stderr}`
    .replaceAll("\r\n", "\n")
    .split("\n");
  const expectedHeader = [
    "File",
    "% Stmts",
    "% Branch",
    "% Funcs",
    "% Lines",
    "Uncovered Line #s",
  ];
  const headerIndex = outputLines.findIndex((line) => {
    const columns = coverageTableColumns(line);
    return (
      columns.length === expectedHeader.length &&
      columns.every((column, index) => column === expectedHeader[index])
    );
  });
  assert.notEqual(headerIndex, -1);
  const allFilesRowIndex = outputLines.findIndex(
    (line, index) =>
      index > headerIndex && coverageTableColumns(line)[0] === "All files",
  );
  assert.notEqual(allFilesRowIndex, -1);
  const allFilesColumns = coverageTableColumns(outputLines[allFilesRowIndex]);
  assert.equal(allFilesColumns.length, 6);
  const allFilesMetrics = allFilesColumns.slice(1, 5).map(coverageMetricValue);
  assert.equal(
    allFilesMetrics.every((metric) => metric !== undefined),
    true,
  );
  assert.equal(
    allFilesMetrics.some(
      (coverage, index) => coverage < Number(thresholds[metricNames[index]]),
    ),
    true,
  );
  const seedDirectoryName = basename(seedRoot);
  const seedRowIndex = outputLines.findIndex((line, index) => {
    if (index <= allFilesRowIndex) return false;
    const columns = coverageTableColumns(line);
    if (columns.length !== 6) return false;
    const [file, statements, branches, functions, lines, uncovered] = columns;
    return (
      coverageTableFileMatchesSeed(file, seedDirectoryName) &&
      coverageMetricEquals(statements, 0) &&
      coverageMetricValue(branches) !== undefined &&
      coverageMetricEquals(functions, 0) &&
      coverageMetricEquals(lines, 0) &&
      uncovered === ""
    );
  });
  assert.notEqual(seedRowIndex, -1);
  const nestedSeedColumns = coverageTableColumns(
    outputLines[seedRowIndex + 1] ?? "",
  );
  assert.equal(nestedSeedColumns.length, 6);
  const [file, statements, branches, functions, lines, uncovered] =
    nestedSeedColumns;
  assert.equal(file, "index.ts");
  assert.equal(coverageMetricEquals(statements, 0), true);
  assert.equal(coverageMetricValue(branches) !== undefined, true);
  assert.equal(coverageMetricEquals(functions, 0), true);
  assert.equal(coverageMetricEquals(lines, 0), true);
  assert.equal(uncovered, "1-120");
  if (probeRoot === undefined) return;
  const probeDirectoryName = basename(probeRoot);
  const probeRowIndex = outputLines.findIndex((line, index) => {
    if (index <= allFilesRowIndex) return false;
    const columns = coverageTableColumns(line);
    return (
      columns.length === 6 &&
      coverageTableFileMatchesProbe(columns[0], probeDirectoryName) &&
      columns
        .slice(1, 5)
        .every((metric) => coverageMetricEquals(metric, 100)) &&
      columns[5] === ""
    );
  });
  assert.notEqual(probeRowIndex, -1);
  const nestedProbeColumns = coverageTableColumns(
    outputLines[probeRowIndex + 1] ?? "",
  );
  assert.equal(nestedProbeColumns.length, 6);
  assert.equal(nestedProbeColumns[0], "probe.ts");
  assert.equal(
    nestedProbeColumns
      .slice(1, 5)
      .every((metric) => coverageMetricEquals(metric, 100)),
    true,
  );
  assert.equal(nestedProbeColumns[5], "");
}

function createPackage(root, path, name, dependencies = {}) {
  const packageRoot = join(root, path);
  mkdirSync(join(packageRoot, "src/__tests__"), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name,
      type: "module",
      exports: "./dist/index.js",
      dependencies,
      scripts: {
        test: "vitest run",
        coverage: "vitest run --coverage",
      },
    }),
  );
  writeFileSync(join(packageRoot, "src/index.ts"), "export const value = 1;\n");
  writeFileSync(
    join(packageRoot, "src/__tests__/index.test.ts"),
    'import { test } from "vitest";\ntest("value", () => {});\n',
  );
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentscope-quality-policy-"));
  createPackage(root, "packages/a", "@agentscope/a");
  createPackage(root, "packages/b", "@agentscope/b", {
    "@agentscope/a": "workspace:*",
  });
  return {
    root,
    workspaceRoot: root,
    expectedPackages: new Map([
      ["packages/a", "@agentscope/a"],
      ["packages/b", "@agentscope/b"],
    ]),
    policy: {
      version: 1,
      packages: {
        "packages/a": {
          role: "protocol-root",
          unitTests: "required",
          coverage: { statements: 70, branches: 60, functions: 70, lines: 70 },
        },
        "packages/b": {
          role: "consumer",
          unitTests: "required",
          coverage: { statements: 70, branches: 60, functions: 70, lines: 70 },
        },
      },
    },
  };
}

test("rejects package-private source imports", () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.root, "packages/b/src/index.ts"),
      'export { value } from "@agentscope/a/src/index.js";\n',
    );
    assert.throws(() => auditCodeQualityPolicy(value), /private source/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects workspace dependency cycles", () => {
  const value = fixture();
  try {
    const manifestPath = join(value.root, "packages/a/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dependencies = { "@agentscope/b": "workspace:*" };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => auditCodeQualityPolicy(value), /dependency cycle/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects production packages without real tests", () => {
  const value = fixture();
  try {
    rmSync(join(value.root, "packages/b/src/__tests__"), {
      recursive: true,
      force: true,
    });
    assert.throws(() => auditCodeQualityPolicy(value), /no unit tests/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects dead production modules outside public entry graphs", () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.root, "packages/b/src/orphan.ts"),
      "export const orphan = true;\n",
    );
    assert.throws(
      () => auditCodeQualityPolicy(value),
      /Dead production module/,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects source module cycles", () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.root, "packages/b/src/index.ts"),
      'export { nested } from "./nested.js";\n',
    );
    writeFileSync(
      join(value.root, "packages/b/src/nested.ts"),
      'export { value as nested } from "./index.js";\n',
    );
    assert.throws(() => auditCodeQualityPolicy(value), /Source module cycle/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects coverage threshold decreases", () => {
  const value = fixture();
  const baseline = structuredClone(value.policy);
  value.policy.packages["packages/a"].coverage.lines = 69;
  assert.throws(
    () => auditCoverageRatchet(value.policy, baseline),
    /coverage.lines may not decrease/,
  );
  rmSync(value.root, { recursive: true, force: true });
});

test(
  "test linting rejects package boundaries, duplicate imports, unsafe values, floating promises, and excessive complexity",
  async () => {
    const seedRoot = mkdtempSync(
      join(repositoryRoot, "packages/protocol/src/quality-seed-"),
    );
    const path = join(seedRoot, "index.test.ts");
    const branches = Array.from(
      { length: 31 },
      (_, index) => `  if (value === ${index}) value += 1;`,
    ).join("\n");
    try {
      writeFileSync(
        path,
        [
          'import { agentscope } from "@agentscope/core";',
          'import { AgentTraceSpecVersion } from "@agentscope/core";',
          "declare function unsafeValue(): any;",
          "async function violation(value: number) {",
          "  const unsafe = unsafeValue();",
          "  Promise.resolve(value);",
          branches,
          "  return unsafe.member;",
          "}",
          "void agentscope;",
          "void AgentTraceSpecVersion;",
          "void violation(0);",
          "",
        ].join("\n"),
      );
      const result = await lintPolicySeed(path);
      const ruleIds = lintRuleIds(result);
      assert.ok(result.errorCount > 0);
      assert.ok(ruleIds.has("@typescript-eslint/no-unsafe-assignment"));
      assert.ok(ruleIds.has("@typescript-eslint/no-unsafe-member-access"));
      assert.ok(ruleIds.has("@typescript-eslint/no-unsafe-return"));
      assert.ok(ruleIds.has("@typescript-eslint/no-floating-promises"));
      assert.ok(ruleIds.has("complexity"));
      assert.ok(ruleIds.has("no-restricted-imports"));
      assert.ok(ruleIds.has("import-x/no-duplicates"));
    } finally {
      rmSync(seedRoot, { recursive: true, force: true });
    }
  },
  eslintPolicyTestDeadlineMs,
);

test("Prettier rejects a seeded formatting violation", () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-format-seed-"));
  const path = join(root, "bad.ts");
  try {
    writeFileSync(path, "export const badlyFormatted={value:1}\n");
    const result = spawnSync("pnpm", ["exec", "prettier", "--check", path], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /Code style issues/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "lint rejects Protocol finalization authority outside Core",
  async () => {
    const seedRoot = mkdtempSync(
      join(repositoryRoot, "packages/destinations/core/src/finalization-seed-"),
    );
    const path = join(seedRoot, "index.test.ts");
    try {
      writeFileSync(
        path,
        'import { finalizeRedactedCanonicalTrace } from "@agentscope/protocol/core-finalization";\nvoid finalizeRedactedCanonicalTrace;\n',
      );
      const result = await lintPolicySeed(path);
      assert.ok(result.errorCount > 0);
      assert.deepEqual([...lintRuleIds(result)], ["no-restricted-imports"]);
      assert.ok(
        result.messages.some(
          (message) =>
            message.ruleId === "no-restricted-imports" &&
            message.message.includes("Only Core"),
        ),
      );
    } finally {
      rmSync(seedRoot, { recursive: true, force: true });
    }
  },
  eslintPolicyTestDeadlineMs,
);

test("seeded coverage oracle is semantic across Vitest table variants", () => {
  const seedRoot = join(tmpdir(), "coverage-policy-seed-Ab12Cd");
  const thresholds = {
    statements: 70,
    branches: 45,
    functions: 85,
    lines: 70,
  };
  const header =
    "File | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s";
  const failingSummaryRow = "All files | 26.27 | 66.12 | 22.15 | 38.86 |";
  const nestedSeedRow = "index.ts | 0 | 100 | 0 | 0 | 1-120";
  const nonFiniteMetric = "9".repeat(400);
  const result = (output, overrides = {}) => ({
    status: 1,
    stdout: output,
    stderr: "",
    testFilesPassed: true,
    unhandledErrorCount: 0,
    ...overrides,
  });
  const macosOutput = [
    "Coverage summary",
    header,
    failingSummaryRow,
    "coverage-policy-seed-Ab12Cd | 0 | 100 | 0 | 0 |",
    nestedSeedRow,
  ].join("\n");
  const linuxOutput = [
    "Coverage enabled with v8",
    header,
    failingSummaryRow,
    "...cy-seed-Ab12Cd | 0 | 100 | 0 | 0 |",
    nestedSeedRow,
  ].join("\n");
  assert.doesNotThrow(() =>
    assertSeededCoverageGateFailure(result(macosOutput), seedRoot, thresholds),
  );
  assert.doesNotThrow(() =>
    assertSeededCoverageGateFailure(result(linuxOutput), seedRoot, thresholds),
  );

  const rejected = [
    result(`File | Statements | Branches\n${nestedSeedRow}`),
    result(`${header}\n${failingSummaryRow}\n${nestedSeedRow}`),
    result(
      `${header}\n${failingSummaryRow}\n...cy-seed-Wrong1 | 0 | 100 | 0 | 0 |\n${nestedSeedRow}`,
    ),
    result(
      `${header}\n${failingSummaryRow}\n...cy-seed-Ab12Cd | 0 | 100 | 0 | 0 |\nindex.ts | 0.1 | 100 | 0 | 0 | 1-120`,
    ),
    result(
      `${header}\n${failingSummaryRow}\n... | 0 | 100 | 0 | 0 |\n${nestedSeedRow}`,
    ),
    result(
      `${header}\n${failingSummaryRow}\n… | 0 | 100 | 0 | 0 |\n${nestedSeedRow}`,
    ),
    result(
      `${header}\n${failingSummaryRow}\n...cy-seed-Ab12Cd | 0 | 100 | 0 | 0 | | surplus\n${nestedSeedRow}`,
    ),
    result(
      `${header}\n${failingSummaryRow}\n...cy-seed-Ab12Cd | 0 | 100 | 0 | 0 |\n${nestedSeedRow} | surplus`,
    ),
    result(
      `${header}\nAll files | 100 | 100 | 100 | 100 |\n...cy-seed-Ab12Cd | 0 | 100 | 0 | 0 |\n${nestedSeedRow}`,
    ),
    result(
      `${header}\nAll files | | 66.12 | 22.15 | 38.86 |\n...cy-seed-Ab12Cd | 0 | 100 | 0 | 0 |\n${nestedSeedRow}`,
    ),
    result(
      `${header}\n${failingSummaryRow} | surplus\n...cy-seed-Ab12Cd | 0 | 100 | 0 | 0 |\n${nestedSeedRow}`,
    ),
    result(
      `${header}\nAll files | 26.27 | 101 | 22.15 | 38.86 |\n...cy-seed-Ab12Cd | 0 | 100 | 0 | 0 |\n${nestedSeedRow}`,
    ),
    result(
      `${header}\nAll files | 26.27 | ${nonFiniteMetric} | 22.15 | 38.86 |\n...cy-seed-Ab12Cd | 0 | 100 | 0 | 0 |\n${nestedSeedRow}`,
    ),
    result(
      `${header}\n${failingSummaryRow}\n...cy-seed-Ab12Cd | 0 | 101 | 0 | 0 |\n${nestedSeedRow}`,
    ),
    result(
      `${header}\n${failingSummaryRow}\n...cy-seed-Ab12Cd | 0 | 100 | 0 | 0 |\nindex.ts | 0 | ${nonFiniteMetric} | 0 | 0 | 1-120`,
    ),
    result(linuxOutput, { status: 0 }),
    result(linuxOutput, { testFilesPassed: false }),
    result(linuxOutput, { unhandledErrorCount: 1 }),
  ];
  for (const rejectedResult of rejected)
    assert.throws(() =>
      assertSeededCoverageGateFailure(rejectedResult, seedRoot, thresholds),
    );
  assert.throws(() =>
    assertSeededCoverageGateFailure(result(linuxOutput), seedRoot, {
      statements: 0,
      branches: 0,
      functions: 0,
      lines: 0,
    }),
  );
});

test(
  "Vitest coverage rejects a seeded untested production module",
  async () => {
    let seedRoot;
    let reportRoot;
    let probeFixture;
    let cleanupAllowed = true;
    try {
      seedRoot = mkdtempSync(
        join(repositoryRoot, "packages/testkit/src/coverage-policy-seed-"),
      );
      reportRoot = mkdtempSync(
        join(tmpdir(), "agentscope-coverage-policy-report-"),
      );
      probeFixture = createCoverageProbeFixture();
      const path = join(seedRoot, "index.ts");
      writeFileSync(
        path,
        Array.from(
          { length: 120 },
          (_, index) => `export const uncovered${index} = () => ${index};`,
        ).join("\n"),
      );
      const qualityPolicy = JSON.parse(
        readFileSync(join(repositoryRoot, "quality-policy.json"), "utf8"),
      );
      const result = await runCoveragePolicyWorker({
        reportRoot,
        thresholds: qualityPolicy.packages["packages/testkit"].coverage,
        testFilters: [probeFixture.probePath],
        coverageIncludes: [
          `src/${basename(probeFixture.fixtureRoot)}/probe.ts`,
          `src/${basename(seedRoot)}/index.ts`,
        ],
      });
      assertSeededCoverageGateFailure(
        result,
        seedRoot,
        qualityPolicy.packages["packages/testkit"].coverage,
        probeFixture.fixtureRoot,
      );
      assert.equal(existsSync(probeFixture.markerPath), false);
    } catch (error) {
      cleanupAllowed = error?.workerJoined !== false;
      throw error;
    } finally {
      if (cleanupAllowed)
        cleanupCoverageSeed({ seedRoot, reportRoot, probeFixture });
    }
  },
  coveragePolicyTestDeadlineMs,
);

test("coverage worker stream overflow is content-free and joined", async () => {
  const failure = await runCoveragePolicyWorker({
    mode: "stream-overflow",
    phaseDeadlineMs: 2_000,
    maximumOutputBytes: 1_024,
  }).then(
    () => assert.fail("streaming coverage worker unexpectedly succeeded"),
    (error) => error,
  );
  assert.equal(failure.workerJoined, true);
  assert.equal(
    failure.message,
    "Vitest coverage policy output exceeded its byte ceiling; worker joined",
  );
  assert.doesNotMatch(failure.message, /SENSITIVE_COVERAGE_STREAM_OUTPUT/);
});

test("coverage worker message overflow is content-free and joined", async () => {
  const failure = await runCoveragePolicyWorker({
    mode: "message-overflow",
    phaseDeadlineMs: 2_000,
    maximumOutputBytes: 1_024,
  }).then(
    () => assert.fail("overflowing coverage message unexpectedly succeeded"),
    (error) => error,
  );
  assert.equal(failure.workerJoined, true);
  assert.equal(
    failure.message,
    "Vitest coverage policy output exceeded its byte ceiling; worker joined",
  );
  assert.doesNotMatch(failure.message, /SENSITIVE_COVERAGE_MESSAGE_OUTPUT/);
});

test("coverage worker enforces one output budget across IPC and streams", async () => {
  const fixture = createCoverageHangFixture();
  let cleanupAllowed = true;
  try {
    const failure = await runCoveragePolicyWorker({
      mode: "combined-output-overflow",
      phaseDeadlineMs: 2_000,
      maximumOutputBytes: 1_024,
      readinessPath: fixture.heartbeatPath,
    }).then(
      () => assert.fail("combined coverage output unexpectedly succeeded"),
      (error) => error,
    );
    assert.equal(failure.workerJoined, true);
    assert.equal(
      failure.message,
      "Vitest coverage policy output exceeded its byte ceiling; worker joined",
    );
    assert.doesNotMatch(
      failure.message,
      /SENSITIVE_COMBINED_(?:MESSAGE|STREAM)/,
    );
    await assertHeartbeatStopped(fixture.heartbeatPath);
  } catch (error) {
    cleanupAllowed = error?.workerJoined !== false;
    throw error;
  } finally {
    if (cleanupAllowed) fixture.cleanup();
  }
});

test("coverage worker failure is content-free and joined", async () => {
  const failure = await runCoveragePolicyWorker({
    mode: "fail",
    phaseDeadlineMs: 2_000,
    maximumOutputBytes: 1_024,
  }).then(
    () => assert.fail("failing coverage worker unexpectedly succeeded"),
    (error) => error,
  );
  assert.equal(failure.workerJoined, true);
  assert.equal(failure.message, "Vitest coverage policy worker failed");
  assert.doesNotMatch(failure.message, /SENSITIVE_COVERAGE_WORKER_FAILURE/);
});

test("coverage worker rejects a successful leader with a live descendant", async () => {
  const fixture = createCoverageHangFixture();
  let cleanupAllowed = true;
  try {
    const failure = await runCoveragePolicyWorker({
      mode: "success-with-descendant",
      phaseDeadlineMs: 2_000,
      maximumOutputBytes: 1_024,
      readinessPath: fixture.heartbeatPath,
    }).then(
      () => assert.fail("coverage worker accepted a surviving descendant"),
      (error) => error,
    );
    assert.equal(failure.workerJoined, true);
    assert.equal(failure.message, "Vitest coverage policy worker failed");
    await assertHeartbeatStopped(fixture.heartbeatPath);
  } catch (error) {
    cleanupAllowed = error?.workerJoined !== false;
    throw error;
  } finally {
    if (cleanupAllowed) fixture.cleanup();
  }
});

test("unproved coverage containment preserves owned fixture evidence", async () => {
  const fixture = createCoverageHangFixture();
  let cleanupAllowed = false;
  try {
    const owner = await startCoverageHeartbeatOwner(fixture);
    let containmentFailureInvoked = false;
    const containmentStartedAt = performance.now();
    const containmentDeadlineAt = performance.now() + 200;
    const outcome = await settleCoveragePolicyWorker({
      worker: owner.child,
      startedAt: containmentStartedAt,
      deadlineAt: containmentDeadlineAt,
      phaseDeadlineMs: 200,
      maximumOutputBytes: 1_024,
      groupIsAbsent: () => false,
      killGroup: killCoverageGroup,
      containmentFailure: async () => {
        containmentFailureInvoked = true;
      },
      teardownMilliseconds: 100,
    }).then(
      (value) => ({ kind: "success", value }),
      (error) => ({ error, kind: "failure" }),
    );
    const contained = await waitForCoverageContainment(
      owner.child,
      owner.closed,
      owner.outerDeadlineAt,
      coverageGroupIsAbsent,
    );
    if (contained === undefined)
      throw coverageWorkerError(
        "Vitest coverage policy containment failed",
        false,
      );
    cleanupAllowed = true;
    assert.equal(outcome.kind, "failure");
    assert.equal(outcome.error.workerJoined, false);
    assert.equal(
      outcome.error.message,
      "Vitest coverage policy containment failed",
    );
    assert.equal(containmentFailureInvoked, true);
    assert.equal(existsSync(fixture.testPath), true);
    assert.equal(existsSync(fixture.reportRoot), true);
    await assertHeartbeatStopped(fixture.heartbeatPath);
  } finally {
    if (cleanupAllowed) fixture.cleanup();
  }
});

test.each([
  ["missing", "missing"],
  ["substituted", "substituted"],
  ["unready", "unready"],
  ["unrelated-token", "unrelated-token"],
  ["late", "valid", (owner) => owner.readinessDeadlineAt],
])(
  "coverage heartbeat readiness rejects %s evidence",
  async (_label, mode, observeReadinessAt) => {
    const fixture = createCoverageHangFixture();
    const failure = await startCoverageHeartbeatOwner(
      fixture,
      mode,
      observeReadinessAt,
    ).then(
      () => assert.fail("coverage heartbeat accepted invalid readiness"),
      (error) => error,
    );
    assert.equal(failure.workerJoined, true);
    assert.equal(
      failure.message,
      "Coverage heartbeat fixture readiness failed",
    );
    assert.equal(existsSync(fixture.fixtureRoot), false);
    assert.equal(existsSync(fixture.reportRoot), false);
    assert.equal(existsSync(fixture.heartbeatRoot), false);
  },
);

test("coverage result observed after its deadline is rejected", async () => {
  const pending = runCoveragePolicyWorker({
    mode: "success",
    phaseDeadlineMs: 20,
    maximumOutputBytes: 1_024,
  });
  const blockedUntil = performance.now() + 50;
  while (performance.now() < blockedUntil) {
    // Causally hold the parent past the worker's absolute deadline.
  }
  const failure = await pending.then(
    () => assert.fail("late coverage worker result was accepted"),
    (error) => error,
  );
  assert.equal(failure.workerJoined, true);
  assert.match(failure.message, /phase deadline; worker joined/);
});

test("coverage deadline joins nested threads before fixture cleanup", async () => {
  const fixture = createCoverageHangFixture();
  let cleanupAllowed = true;
  try {
    const failure = await runCoveragePolicyWorker({
      reportRoot: fixture.reportRoot,
      thresholds: fixture.thresholds,
      testFilters: [fixture.testPath],
      phaseDeadlineMs: 2_000,
    }).then(
      () => assert.fail("hanging coverage worker unexpectedly succeeded"),
      (error) => error,
    );
    assert.equal(failure.workerJoined, true);
    assert.match(failure.message, /phase deadline; worker joined/);
    await assertHeartbeatStopped(fixture.heartbeatPath);
  } catch (error) {
    cleanupAllowed = error?.workerJoined !== false;
    throw error;
  } finally {
    if (cleanupAllowed) fixture.cleanup();
  }
}, 10_000);

test("coverage deadline force-contains a non-settling close", async () => {
  const fixture = createCoverageHangFixture();
  let cleanupAllowed = true;
  try {
    const failure = await runCoveragePolicyWorker({
      mode: "coverage-close-hang",
      reportRoot: fixture.reportRoot,
      thresholds: fixture.thresholds,
      testFilters: [fixture.testPath],
      phaseDeadlineMs: 2_000,
    }).then(
      () => assert.fail("non-settling coverage close unexpectedly succeeded"),
      (error) => error,
    );
    assert.equal(failure.workerJoined, true);
    assert.match(failure.message, /phase deadline; worker joined/);
    await assertHeartbeatStopped(fixture.heartbeatPath);
  } catch (error) {
    cleanupAllowed = error?.workerJoined !== false;
    throw error;
  } finally {
    if (cleanupAllowed) fixture.cleanup();
  }
}, 10_000);

test("active coverage output overflow contains nested work", async () => {
  const fixture = createCoverageHangFixture();
  let cleanupAllowed = true;
  try {
    const failure = await runCoveragePolicyWorker({
      mode: "coverage-active-overflow",
      reportRoot: fixture.reportRoot,
      thresholds: fixture.thresholds,
      testFilters: [fixture.testPath],
      phaseDeadlineMs: 5_000,
      maximumOutputBytes: 1_024,
      readinessPath: fixture.heartbeatPath,
    }).then(
      () => assert.fail("active coverage overflow unexpectedly succeeded"),
      (error) => error,
    );
    assert.equal(failure.workerJoined, true);
    assert.equal(
      failure.message,
      "Vitest coverage policy output exceeded its byte ceiling; worker joined",
    );
    assert.doesNotMatch(failure.message, /SENSITIVE_ACTIVE_COVERAGE_OUTPUT/);
    await assertHeartbeatStopped(fixture.heartbeatPath);
  } catch (error) {
    cleanupAllowed = error?.workerJoined !== false;
    throw error;
  } finally {
    if (cleanupAllowed) fixture.cleanup();
  }
}, 10_000);
