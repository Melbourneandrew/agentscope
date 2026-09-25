#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Agent, request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import {
  codexProjectionFailureDiagnostic,
  codexUninstallFailureDiagnostic,
  codexUninstallUnclassifiedStageDiagnostic,
  decodeCodexJoinDeadlineExitCode,
  encodeCodexJoinDeadlineExitCode,
  encodeInteractiveFailureExitCode,
  parseCodexMachineOutput as parseMachine,
} from "./immutable-candidate-authority.mjs";

let ledger;
let terminalCompletionMarker = "AGENTSCOPE_PTY_COMPLETE";
let interactiveFailurePhase = "bootstrap";
let interactiveFailurePhaseIndex = 0;
let preCheckpointFailureDiagnostic;
let candidateConfigStage;
const candidateConfigStages = Object.freeze([
  "closed-marker",
  "render",
  "create",
  "open",
  "prove",
  "publish",
]);
let uninstallVerificationStep = "cli";
let joinDeadlineHookState;
const interactivePhases = Object.freeze([
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
  "model-gate-configured",
  "control-plane-closed",
  "tui-readiness-challenge-published",
  "tui-start",
  "tui-run-created",
  "tui-checkpoint",
  "model-gate-arm-start",
  "model-gate-arm-health-pending",
  "model-gate-arm-session-start",
  "tui-exit-before-arm",
  "model-gate-arm-complete",
  "model-request-observed",
  "model-request",
  "trace-terminal",
  "tui-exit-published",
  "tui-join-deadline",
  "tui-child-rejected",
  "tui-joined",
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
  "trace-search-result",
  "verify",
  "verify-config",
  "verify-gate",
  "verify-trace-get",
  "verify-correlation",
  "verify-doctor",
  "verify-uninstall",
  "verify-status",
  "verify-projection",
  "verify-evidence",
]);
const advanceInteractivePhase = (phase) => {
  const phaseIndex = interactivePhases.indexOf(phase);
  if (phaseIndex <= interactiveFailurePhaseIndex)
    throw new Error("integration.codex.failure-phase");
  interactiveFailurePhase = phase;
  interactiveFailurePhaseIndex = phaseIndex;
};
if (process.hasUncaughtExceptionCaptureCallback())
  throw new Error("integration.codex.failure-capture");
process.setUncaughtExceptionCaptureCallback((error) => {
  let exitCode = 64 + interactiveFailurePhaseIndex;
  const projectionDiagnostic =
    interactiveFailurePhase === "verify-projection"
      ? codexProjectionFailureDiagnostic(error?.message)
      : undefined;
  const uninstallDiagnostic =
    interactiveFailurePhase === "verify-uninstall"
      ? (codexUninstallFailureDiagnostic(error?.message) ??
        codexUninstallUnclassifiedStageDiagnostic(uninstallVerificationStep))
      : undefined;
  const candidateConfigDiagnostic =
    interactiveFailurePhase === "control-plane-closed" &&
    candidateConfigStage !== undefined
      ? `integration.fixture.codex-candidate-config-${candidateConfigStage}`
      : undefined;
  const ownedDiagnostic =
    preCheckpointFailureDiagnostic ??
    candidateConfigDiagnostic ??
    projectionDiagnostic ??
    uninstallDiagnostic;
  if (ownedDiagnostic !== undefined) {
    const diagnosticCode = encodeInteractiveFailureExitCode(
      ownedDiagnostic,
      "codex-tui-trace-smoke",
    );
    if (diagnosticCode !== undefined) exitCode = diagnosticCode;
  }
  if (interactiveFailurePhase === "tui-join-deadline") {
    const diagnosticCode = encodeCodexJoinDeadlineExitCode(
      joinDeadlineHookState,
    );
    if (diagnosticCode !== undefined) exitCode = diagnosticCode;
  }
  try {
    const traceFailure = [
      "trace-search",
      "hook-command-completed-before-budget-boundary",
      "hook-command-completed-near-budget-boundary",
    ].includes(interactiveFailurePhase);
    const diagnostic =
      preCheckpointFailureDiagnostic ??
      ownedDiagnostic ??
      (interactiveFailurePhase === "tui-join-deadline"
        ? (decodeCodexJoinDeadlineExitCode(exitCode) ??
          "integration.fixture.codex-tui-join-deadline")
        : traceFailure
          ? `integration.fixture.codex-trace-await-${classifyCodexTraceFailureHint(
              {
                errorMessage: error?.message,
                hookCompleted: traceWaitHookCompleted,
                reporterSettled: traceWaitReporterSettled,
              },
            )}`
          : `integration.fixture.codex-${interactiveFailurePhase}`);
    if (ledger !== undefined && preCheckpointFailureDiagnostic === undefined)
      writeFileSync(
        join(ledger, "interactive-failure.txt"),
        `${diagnostic}\n`,
        {
          flag: "wx",
          mode: 0o600,
        },
      );
  } catch {
    if (joinDeadlineHookState === undefined) exitCode = 64;
  }
  let settled = false;
  const settle = (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    process.exit(code);
  };
  const timer = setTimeout(() => settle(1), 1_000);
  try {
    process.stdout.write(`${terminalCompletionMarker}\r\n`, (error) =>
      settle(error === null || error === undefined ? exitCode : 1),
    );
  } catch {
    settle(1);
  }
});

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`integration.codex.environment-${name}`);
  return value;
};
advanceInteractivePhase("bootstrap-arguments");
if (process.argv.length !== 4 || process.argv[2] !== "--artifact")
  throw new Error("integration.codex.arguments");
const artifactPath = process.argv[3];

const bootNow = () => {
  const source = readFileSync("/proc/uptime", "utf8");
  if (source.length > 128 || !/^\d+(?:\.\d+)?\s/u.test(source))
    throw new Error("integration.codex.clock");
  return Number(source.split(/\s/u, 1)[0]) * 1_000;
};
advanceInteractivePhase("bootstrap-deadline");
const deadline = Number(required("AGENTSCOPE_SCENARIO_BOOT_DEADLINE_MS"));
if (!Number.isFinite(deadline) || deadline <= bootNow())
  throw new Error("integration.codex.deadline");
const remaining = () => {
  const value = deadline - bootNow();
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("integration.codex.deadline");
  return value;
};
const observeBeforeDiagnosticDeadline = async (completion, cutoff) => {
  const milliseconds = Math.floor(cutoff - bootNow());
  if (milliseconds <= 0)
    throw new Error("integration.codex.diagnostic-deadline");
  let timer;
  try {
    await Promise.race([
      completion,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("integration.codex.diagnostic-deadline")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
const readReadinessChallenge = () =>
  new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    let timer;
    const settle = (error, value) => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      process.stdin.pause();
      if (timer !== undefined) clearTimeout(timer);
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const onEnd = () => settle(new Error("integration.codex.readiness"));
    const onError = () => settle(new Error("integration.codex.readiness"));
    const onData = (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 65)
        return settle(new Error("integration.codex.readiness"));
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) return;
      const challenge = bytes.subarray(0, newline).toString("utf8");
      if (
        newline !== 64 ||
        bytes.length !== 65 ||
        !/^[a-f0-9]{64}$/u.test(challenge)
      )
        return settle(new Error("integration.codex.readiness"));
      settle(undefined, challenge);
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
    process.stdin.resume();
    timer = setTimeout(
      () => settle(new Error("integration.codex.readiness")),
      Math.min(10_000, remaining()),
    );
  });
advanceInteractivePhase("bootstrap-readiness");
const readinessChallenge = await readReadinessChallenge();
const expectedAssistantMessage = `AGENTSCOPE_CODEX_RESPONSE:${readinessChallenge}`;
terminalCompletionMarker = `AGENTSCOPE_PTY_COMPLETE:${readinessChallenge}`;
const rootStartIdentity = () => {
  const source = readFileSync("/proc/self/stat", "utf8");
  const close = source.lastIndexOf(")");
  const start = source
    .slice(close + 2)
    .trim()
    .split(/\s+/u)[19];
  if (source.length > 4096 || close < 1 || !/^\d+$/u.test(start ?? ""))
    throw new Error("integration.codex.process-checkpoint");
  return `${process.pid}:${start}`;
};
const checkpointPath = () =>
  `/control/private/checkpoint-${integrationRunId}.json`;
const waitForCheckpointWitness = async () => {
  const cutoff = bootNow() + Math.min(5_000, remaining());
  const expectedStart = rootStartIdentity();
  while (bootNow() < cutoff) {
    let descriptor;
    try {
      descriptor = openSync(
        checkpointPath(),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const before = fstatSync(descriptor);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.uid !== 0 ||
        (before.mode & 0o777) !== 0o600 ||
        before.size < 1 ||
        before.size > 4096
      )
        throw new Error("integration.codex.process-checkpoint");
      const bytes = readFileSync(descriptor, "utf8");
      const after = fstatSync(descriptor);
      const value = JSON.parse(bytes);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        Object.keys(value).sort().join("\0") !==
          "challenge\0processSetSha256\0rootPid\0rootStartIdentity\0runId\0witnessVersion" ||
        bytes !== `${JSON.stringify(value)}\n` ||
        value.witnessVersion !== 1 ||
        value.runId !== integrationRunId ||
        value.challenge !== readinessChallenge ||
        value.rootPid !== process.pid ||
        value.rootStartIdentity !== expectedStart ||
        !/^[a-f0-9]{64}$/u.test(value.processSetSha256)
      )
        throw new Error("integration.codex.process-checkpoint");
      return value;
    } catch (error) {
      if (error?.code !== "ENOENT")
        throw new Error("integration.codex.process-checkpoint", {
          cause: error,
        });
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("integration.codex.process-checkpoint");
};

const maximumOutput = 1024 * 1024;
const run = (executable, arguments_, options = {}) => {
  let childPid;
  const completion = new Promise((resolve, reject) => {
    remaining();
    const timeoutMilliseconds =
      options.monotonicDeadline === undefined
        ? undefined
        : Math.floor(options.monotonicDeadline - bootNow());
    if (timeoutMilliseconds !== undefined && timeoutMilliseconds <= 0) {
      reject(new Error("integration.codex.child-deadline"));
      return;
    }
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      ...(options.candidatePrincipal === true ? { uid: 1000, gid: 1000 } : {}),
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    childPid = child.pid;
    let deadlineExpired = false;
    const timer =
      timeoutMilliseconds === undefined
        ? undefined
        : setTimeout(() => {
            deadlineExpired = true;
            child.kill("SIGKILL");
          }, timeoutMilliseconds);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    if (!options.inherit) {
      child.stdout.on("data", (chunk) => {
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > maximumOutput) child.stdout.destroy();
      });
      child.stderr.on("data", (chunk) => {
        stderr = Buffer.concat([stderr, chunk]);
        if (stderr.length > maximumOutput) child.stderr.destroy();
      });
    }
    child.once("error", () =>
      reject(new Error("integration.codex.child-spawn")),
    );
    child.once("close", (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      try {
        remaining();
        const traceUnavailable =
          options.acceptTraceSearchUnavailable === true &&
          codexTraceSearchUnavailable({ code, signal, stderr, stdout });
        const traceTimedOut =
          options.acceptTraceSearchUnavailable === true &&
          codexTraceSearchTimedOut({
            code,
            deadlineExpired,
            signal,
            stderr,
            stdout,
          });
        if (
          (!traceUnavailable &&
            !traceTimedOut &&
            (deadlineExpired || code !== 0 || signal !== null)) ||
          stdout.length > maximumOutput ||
          stderr.length > maximumOutput
        ) {
          const traceFailureKind =
            options.acceptTraceSearchUnavailable === true
              ? codexTraceSearchChildFailureCategory({
                  code,
                  deadlineExpired,
                  signal,
                  stderrBytes: stderr.length,
                  stdoutBytes: stdout.length,
                  maximumBytes: maximumOutput,
                })
              : undefined;
          return reject(
            new Error(
              traceFailureKind === undefined
                ? "integration.codex.child"
                : `integration.codex.trace-search-child-${traceFailureKind}`,
            ),
          );
        }
        resolve({ stderr, stdout, traceTimedOut, traceUnavailable });
      } catch (error) {
        reject(error);
      }
    });
  });
  Object.defineProperty(completion, "childPid", {
    configurable: false,
    enumerable: false,
    value: childPid,
    writable: false,
  });
  return completion;
};
const agentscope = "/opt/agentscope/installed/node_modules/.bin/agentscope";
advanceInteractivePhase("bootstrap-environment");
const home = required("HOME");
const codexHome = join(home, ".codex");
const agentscopeHome = required("AGENTSCOPE_HOME");
const worktree = required("AGENTSCOPE_WORKTREE");
ledger = required("AGENTSCOPE_LEDGER");
const scenarioId = required("AGENTSCOPE_SCENARIO_ID");
const integrationRunId = required("AGENTSCOPE_INTEGRATION_RUN_ID");
const modelEndpoint = required("AGENTSCOPE_MODEL_SERVER_URL");
if (worktree !== "/worktree")
  throw new Error("integration.codex.environment-AGENTSCOPE_WORKTREE");
for (const directory of [home, agentscopeHome, worktree, ledger])
  mkdirSync(directory, { recursive: true });
if (ledger !== "/ledger")
  throw new Error("integration.codex.environment-AGENTSCOPE_LEDGER");
const ledgerDescriptor = openSync(
  ledger,
  constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK,
);
try {
  const before = fstatSync(ledgerDescriptor);
  const pathBefore = lstatSync(ledger);
  if (
    !before.isDirectory() ||
    !pathBefore.isDirectory() ||
    before.dev !== pathBefore.dev ||
    before.ino !== pathBefore.ino ||
    before.uid !== 1000 ||
    before.gid !== 1000 ||
    before.nlink !== 2
  )
    throw new Error("integration.codex.ledger-authority");
  fchownSync(ledgerDescriptor, 0, 0);
  fchmodSync(ledgerDescriptor, 0o700);
  const after = fstatSync(ledgerDescriptor);
  const pathAfter = lstatSync(ledger);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    pathAfter.dev !== before.dev ||
    pathAfter.ino !== before.ino ||
    after.uid !== 0 ||
    after.gid !== 0 ||
    (after.mode & 0o7777) !== 0o700 ||
    pathAfter.uid !== 0 ||
    pathAfter.gid !== 0 ||
    (pathAfter.mode & 0o7777) !== 0o700
  )
    throw new Error("integration.codex.ledger-authority");
} finally {
  closeSync(ledgerDescriptor);
}
const codexDiagnosticLogDirectory = join(codexHome, "diagnostic-log");
const homeDescriptor = openSync(
  home,
  constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK,
);
let localSqliteLifecycleDescriptor;
let operationalStateHealthDescriptor;
let operationalStateBaseline;
let codexDiagnosticLogDirectoryDescriptor;
let sessionStartBeforeFirstModelRequestAdmission;
let traceWaitHookCompleted = false;
let traceWaitReporterSettled = false;
const recordInteractivePhase = (phase) => {
  advanceInteractivePhase(phase);
  writeFileSync(
    join(ledger, `interactive-phase-${phase}.txt`),
    `integration.fixture.codex-${phase}\n`,
    { flag: "wx", mode: 0o600 },
  );
};
const recordCandidateConfigStage = (stage) => {
  if (!candidateConfigStages.includes(stage))
    throw new Error("integration.codex.candidate-config-stage");
  candidateConfigStage = stage;
  writeFileSync(
    join(ledger, `candidate-config-${stage}.txt`),
    `integration.fixture.codex-candidate-config-${stage}\n`,
    { flag: "wx", mode: 0o600 },
  );
};
const recordPreCheckpointFailure = (kind) => {
  if (
    (kind !== "tui-exit-before-checkpoint" &&
      kind !== "tui-checkpoint-not-witnessed") ||
    preCheckpointFailureDiagnostic !== undefined
  )
    throw new Error("integration.codex.process-checkpoint");
  preCheckpointFailureDiagnostic = `integration.fixture.codex-${kind}`;
  writeFileSync(
    join(ledger, "interactive-failure.txt"),
    `${preCheckpointFailureDiagnostic}\n`,
    { flag: "wx", mode: 0o600 },
  );
};
const recordModelGateArmFailure = (predicate) => {
  if (
    ![
      "control",
      "hook-log",
      "hook-mediation",
      "session-start-missing",
    ].includes(predicate)
  )
    throw new Error("integration.codex.model-gate-arm-diagnostic");
  writeFileSync(
    join(ledger, "interactive-failure.txt"),
    `integration.fixture.codex-model-gate-arm-${predicate}\n`,
    { flag: "wx", mode: 0o600 },
  );
};
const codexStopHookCommandFailure = (outcome) => {
  let phase;
  if (outcome === "timeout") phase = "hook-command-timeout";
  else if (outcome === "spawn_error") phase = "hook-command-spawn-error";
  else if (outcome === "stdin_error") phase = "hook-command-stdin-error";
  else if (outcome === "wait_error") phase = "hook-command-wait-error";
  else throw new Error("integration.codex.hook-command-outcome");
  return { error: `integration.codex.hook-command-${outcome}`, phase };
};
advanceInteractivePhase("bootstrap-modules");
const [configurationModule, evidenceModule, oracleModule, adapterModule] =
  await Promise.all([
    import("./runtime/codex-configuration.js"),
    import("./runtime/codex-runtime-evidence.mjs"),
    import("./scenario-oracle.mjs"),
    import("./scenario-adapter.mjs"),
  ]);
const { createCodexInternalProviderConfiguration } = configurationModule;
const {
  boundedRequestLedger,
  classifyCodexShutdownAtJoinDeadline,
  codexStopHookReadyForExit,
  classifyLocalSqliteOutcomeAfterBaseline,
  classifyMissingOperationalStateByHookDuration,
  classifyCodexSettledTraceObservation,
  classifyCodexTraceFailureHint,
  codexTraceSearchChildFailureCategory,
  codexTraceSearchAttemptDeadlines,
  codexTraceSearchUnavailable,
  codexTraceSearchTimedOut,
  codexSessionStartCheckpointMatchesLifecycle,
  inspectCodexRootHookLifecycle,
  inspectCodexSessionStartBeforeFirstModelRequestAdmission,
  inspectCodexStopHookCommand,
  classifyTraceSearchRecordsBeforeDeadline,
  codexSessionIdentity,
  codexTurnTerminalIdAfterBaseline,
  codexTurnTerminalObservedAfterBaseline,
  localSqliteReporterSettled,
  localSqliteAcceptanceBaseline,
  openLocalSqliteLifecycle,
  openOperationalStateHealth,
  inspectDiagnosticBeforeDeadline,
  publishTerminalCompletionBeforeDeadline,
  recordTerminalObservationBeforeDeadline,
  readCodexSessionLedgerRecords,
  terminalObservationBeforeDeadline,
  traceSummaryBeforeDeadline,
  waitForModelRequestBeforeDeadline,
  waitWithinObservationDeadline,
} = evidenceModule;
const { correlateCodexPlatformObservations } = oracleModule;
const { translateCodexPlatformObservations } = adapterModule;

advanceInteractivePhase("bootstrap-artifact");
const artifactStatus = lstatSync(artifactPath);
if (!artifactStatus.isFile() || artifactStatus.isSymbolicLink())
  throw new Error("integration.codex.artifact");
advanceInteractivePhase("bootstrap-pty");
if (process.stdin.isTTY !== true || process.stdout.isTTY !== true)
  throw new Error("integration.codex.pty");

const cli = async (arguments_, command, options) => {
  const { stdout } = await run(
    agentscope,
    [...arguments_, "--output", "json"],
    { ...options, candidatePrincipal: true },
  );
  const monotonicDeadline = options?.monotonicDeadline;
  if (
    monotonicDeadline !== undefined &&
    !terminalObservationBeforeDeadline({
      observed: true,
      deadline: monotonicDeadline,
      now: bootNow,
    })
  )
    throw new Error("integration.codex.trace-deadline");
  const records = parseMachine(stdout, command);
  if (
    monotonicDeadline !== undefined &&
    !terminalObservationBeforeDeadline({
      observed: true,
      deadline: monotonicDeadline,
      now: bootNow,
    })
  )
    throw new Error("integration.codex.trace-deadline");
  return records;
};

const prompt = "Reply with one short confirmation and do not use tools.";
const promptSha256 = createHash("sha256").update(prompt).digest("hex");
const exactKeys = (value, keys) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());
const installedLauncher = (hookConfiguration) => {
  if (
    !exactKeys(hookConfiguration, ["hooks"]) ||
    !exactKeys(hookConfiguration.hooks, ["SessionStart", "Stop", "SessionEnd"])
  )
    throw new Error("integration.codex.hook-configuration");
  const commands = ["SessionStart", "Stop", "SessionEnd"].map((event) => {
    const groups = hookConfiguration.hooks[event];
    const group = groups?.[0];
    const handler = group?.hooks?.[0];
    const expectedGroupKeys =
      event === "SessionStart" ? ["hooks", "matcher"] : ["hooks"];
    if (
      !Array.isArray(groups) ||
      groups.length !== 1 ||
      !exactKeys(group, expectedGroupKeys) ||
      !Array.isArray(group.hooks) ||
      group.hooks.length !== 1 ||
      (event === "SessionStart" && group.matcher !== "startup|resume|clear") ||
      !exactKeys(handler, ["command", "statusMessage", "timeout", "type"]) ||
      handler.type !== "command" ||
      handler.timeout !== 7 ||
      handler.statusMessage !== "Agentscope trace capture"
    )
      throw new Error("integration.codex.hook-configuration");
    return handler.command;
  });
  if (
    commands.some((command) => typeof command !== "string") ||
    new Set(commands).size !== 1 ||
    !/^'[^']+'$/u.test(commands[0])
  )
    throw new Error("integration.codex.hook-configuration");
  return commands[0].slice(1, -1);
};
const modelControlSocket = "/control/private/gate.sock";
const assertPrivateControlSocket = () => {
  const directory = lstatSync("/control/private");
  const socket = lstatSync(modelControlSocket);
  if (
    process.getuid() !== 0 ||
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== 0 ||
    (directory.mode & 0o777) !== 0o700 ||
    !socket.isSocket() ||
    socket.isSymbolicLink() ||
    socket.uid !== 0 ||
    (socket.mode & 0o777) !== 0o600
  )
    throw new Error("integration.codex.model-gate-control-identity");
};
const modelControlAgent = new Agent({ keepAlive: true, maxSockets: 1 });
let modelGateCutoff;
const gateHeaders = Object.freeze({
  authorization: `Bearer ${readinessChallenge}`,
  "content-type": "application/json",
});
const controlRequest = (path, method, value, signal) => {
  const operationDeadline =
    path === "/seal" || path === "/deny"
      ? deadline
      : (modelGateCutoff ?? deadline);
  const operationRemaining = Math.floor(operationDeadline - bootNow());
  if (operationRemaining <= 0)
    throw new Error("integration.codex.model-gate-deadline");
  const boundedSignal = AbortSignal.timeout(operationRemaining);
  const selectedSignal =
    signal === undefined
      ? boundedSignal
      : AbortSignal.any([signal, boundedSignal]);
  return new Promise((resolve, reject) => {
    const body = value === undefined ? undefined : JSON.stringify(value);
    const request = httpRequest(
      {
        agent: modelControlAgent,
        headers:
          body === undefined
            ? gateHeaders
            : { ...gateHeaders, "content-length": Buffer.byteLength(body) },
        method,
        path,
        signal: selectedSignal,
        socketPath: modelControlSocket,
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 64 * 1024) request.destroy();
          else chunks.push(Buffer.from(chunk));
        });
        response.once("end", () => {
          try {
            if (response.statusCode !== 200)
              throw new Error("integration.codex.model-gate");
            const decoded = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(chunks, bytes),
              ),
            );
            resolve(decoded);
          } catch {
            reject(new Error("integration.codex.model-gate"));
          }
        });
      },
    );
    request.once("error", () =>
      reject(new Error("integration.codex.model-gate")),
    );
    request.end(body);
  });
};
const readModelRequests = async (signal) => {
  const value = await controlRequest("/requests", "PUT", {}, signal);
  if (!exactKeys(value, ["ledger"]))
    throw new Error("integration.codex.model-gate");
  return boundedRequestLedger(value.ledger);
};
const inspectSessionStartBeforeFirstModelRequestAdmission = () => {
  sessionStartBeforeFirstModelRequestAdmission =
    inspectCodexSessionStartBeforeFirstModelRequestAdmission({
      directoryDescriptor: codexDiagnosticLogDirectoryDescriptor,
      directoryPath: codexDiagnosticLogDirectory,
    });
  return sessionStartBeforeFirstModelRequestAdmission;
};
const gateRequest = (path, value, signal) =>
  controlRequest(path, "POST", value, signal);
const proveControlPlaneClosed = async () => {
  const endpoint = new URL(modelEndpoint);
  if (endpoint.protocol !== "http:" || endpoint.pathname !== "/")
    throw new Error("integration.codex.model-gate");
  endpoint.port = "1081";
  await new Promise((resolve, reject) => {
    const socket = createConnection({
      host: endpoint.hostname,
      port: Number(endpoint.port),
    });
    const timer = setTimeout(
      () => {
        socket.destroy();
        reject(new Error("integration.codex.model-gate-control-open"));
      },
      Math.min(250, remaining()),
    );
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("integration.codex.model-gate-control-open"));
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
};
const configureModelGate = async (modelAdmissionCutoff) => {
  modelGateCutoff = modelAdmissionCutoff;
  assertPrivateControlSocket();
  const routeAuthority = JSON.parse(
    readFileSync("/opt/agentscope/current-model-routes.json", "utf8"),
  );
  const routeIndex = routeAuthority.routeIds?.indexOf("codex-tui-responses");
  const route =
    Number.isInteger(routeIndex) && routeIndex >= 0
      ? routeAuthority.routes?.[routeIndex]
      : undefined;
  const body = route?.responseBodyText;
  if (
    routeAuthority.routeIds?.lastIndexOf("codex-tui-responses") !==
      routeIndex ||
    route?.method !== "POST" ||
    route?.path !== "/v1/responses" ||
    typeof body !== "string" ||
    body.split("AGENTSCOPE_PTY_COMPLETE").length !== 2 ||
    body.includes(expectedAssistantMessage)
  )
    throw new Error("integration.codex.model-gate");
  const response = await controlRequest(
    "/configure",
    "POST",
    {
      challenge: readinessChallenge,
      cutoff: modelAdmissionCutoff,
      promptSha256,
      responseText: body.replace(
        "AGENTSCOPE_PTY_COMPLETE",
        expectedAssistantMessage,
      ),
      runId: integrationRunId,
    },
    AbortSignal.timeout(Math.min(1_000, remaining())),
  );
  if (
    !exactKeys(response, ["runId", "state"]) ||
    response.runId !== integrationRunId ||
    response.state !== "pending"
  )
    throw new Error("integration.codex.model-gate");
};
const armModelGate = async (modelAdmissionCutoff) => {
  let observedPendingHealth = false;
  while (bootNow() < modelAdmissionCutoff) {
    let checkpoint;
    try {
      checkpoint = inspectSessionStartBeforeFirstModelRequestAdmission();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      recordModelGateArmFailure(
        message === "integration.codex.hook-mediation"
          ? "hook-mediation"
          : "hook-log",
      );
      throw error;
    }
    if (checkpoint !== undefined) {
      recordInteractivePhase("model-gate-arm-session-start");
      let response;
      try {
        response = await gateRequest("/arm", {
          runId: integrationRunId,
          sessionStartSpanSha256: checkpoint.spanSha256,
        });
      } catch (error) {
        recordModelGateArmFailure("control");
        throw error;
      }
      if (
        !exactKeys(response, [
          "challengeSha256",
          "generation",
          "runId",
          "state",
        ]) ||
        response.challengeSha256 !==
          createHash("sha256").update(readinessChallenge).digest("hex") ||
        typeof response.generation !== "string" ||
        !/^[a-f0-9]{64}$/u.test(response.generation) ||
        response.runId !== integrationRunId ||
        response.state !== "awaiting-ack"
      ) {
        recordModelGateArmFailure("control");
        throw new Error("integration.codex.model-gate");
      }
      const acknowledged = await gateRequest("/ack", {
        challengeSha256: response.challengeSha256,
        generation: response.generation,
        runId: integrationRunId,
      });
      if (
        !exactKeys(acknowledged, ["generation", "runId", "state"]) ||
        acknowledged.generation !== response.generation ||
        acknowledged.runId !== integrationRunId ||
        acknowledged.state !== "armed"
      ) {
        recordModelGateArmFailure("control");
        throw new Error("integration.codex.model-gate");
      }
      return checkpoint;
    }
    let health;
    try {
      health = await controlRequest(
        "/health",
        "GET",
        undefined,
        AbortSignal.timeout(Math.min(250, remaining())),
      );
    } catch (error) {
      recordModelGateArmFailure("control");
      throw error;
    }
    if (!exactKeys(health, ["state"]) || typeof health.state !== "string") {
      recordModelGateArmFailure("control");
      throw new Error("integration.codex.model-gate");
    }
    if (health.state === "denied") {
      recordInteractivePhase("model-request-observed");
      throw new Error("integration.codex.model-request-before-session-start");
    }
    if (health.state !== "pending") {
      recordModelGateArmFailure("control");
      throw new Error("integration.codex.model-gate");
    }
    if (!observedPendingHealth) {
      recordInteractivePhase("model-gate-arm-health-pending");
      observedPendingHealth = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  recordModelGateArmFailure("session-start-missing");
  throw new Error("integration.codex.hook-session-start-missing");
};
const releaseModelResponse = async () => {
  codexLedgerBaseline = readCodexSessionLedgerRecords(homeDescriptor);
  if (codexLedgerBaseline.length !== 1)
    throw new Error("integration.codex.session-ledger");
  codexSessionId = codexSessionIdentity(codexLedgerBaseline);
  if (
    codexTurnTerminalObservedAfterBaseline(
      codexLedgerBaseline,
      codexLedgerBaseline,
      expectedAssistantMessage,
    )
  )
    throw new Error("integration.codex.session-ledger");
  const response = await gateRequest("/release", { runId: integrationRunId });
  if (
    !exactKeys(response, ["runId", "state"]) ||
    response.runId !== integrationRunId ||
    (response.state !== "admitted" && response.state !== "draining")
  )
    throw new Error("integration.codex.model-gate");
};
const sealModelGate = async (checkpoint) => {
  const value = await gateRequest("/seal", { runId: integrationRunId });
  if (!exactKeys(value, ["ledger", "receipt"]))
    throw new Error("integration.codex.model-gate");
  const receipt = value.receipt;
  if (
    !exactKeys(receipt, [
      "challengeSha256",
      "connectionCount",
      "connections",
      "cutoffUnsettled",
      "ledgerCount",
      "mutationGeneration",
      "parserFailures",
      "runId",
      "sessionStartSpanSha256",
      "state",
    ]) ||
    receipt.challengeSha256 !==
      createHash("sha256").update(readinessChallenge).digest("hex") ||
    receipt.connectionCount !== 1 ||
    receipt.cutoffUnsettled !== false ||
    !Array.isArray(receipt.connections) ||
    receipt.connections.length !== 1 ||
    !exactKeys(receipt.connections[0], [
      "admission",
      "closed",
      "eof",
      "generation",
      "parserOutcome",
      "parserTransportClosed",
      "rawForwardedBytes",
      "rawRejectedBytes",
      "responseBytes",
    ]) ||
    receipt.connections[0].admission !== "admitted" ||
    receipt.connections[0].closed !== true ||
    receipt.connections[0].generation !== 1 ||
    receipt.connections[0].parserOutcome !== "accepted" ||
    receipt.connections[0].parserTransportClosed !== true ||
    !Number.isSafeInteger(receipt.connections[0].rawForwardedBytes) ||
    receipt.connections[0].rawForwardedBytes <= 0 ||
    receipt.connections[0].rawRejectedBytes !== 0 ||
    !Number.isSafeInteger(receipt.connections[0].responseBytes) ||
    receipt.connections[0].responseBytes <= 0 ||
    receipt.ledgerCount !== 1 ||
    !Number.isSafeInteger(receipt.mutationGeneration) ||
    receipt.mutationGeneration < 1 ||
    receipt.parserFailures !== 0 ||
    receipt.runId !== integrationRunId ||
    receipt.sessionStartSpanSha256 !== checkpoint.spanSha256 ||
    receipt.state !== "draining"
  )
    throw new Error("integration.codex.model-gate");
  return boundedRequestLedger(value.ledger);
};
const projectHarnessStatus = (
  records,
  installation,
  configurationPresentCount,
) => {
  const value = records?.[0];
  if (records.length !== 1 || value?.installation !== installation)
    throw new Error("integration.codex.harness-status");
  if (
    value?.discovery?.harness !== "codex" ||
    value.discovery.harnessType !== "@agentscope/harness-codex" ||
    value.discovery.version !== "0.149.1"
  )
    throw new Error("integration.codex.harness-status");
  if (
    value.discovery.state !== "installed" ||
    value.discovery.reason !== "compatible"
  )
    throw new Error("integration.codex.harness-status");
  if (value.discovery.configurationLocationCount !== 2)
    throw new Error("integration.codex.harness-status");
  if (value.discovery.configurationPresentCount !== configurationPresentCount)
    throw new Error("integration.codex.harness-status");
  return { installation, configurationPresentCount };
};
const projectDoctor = (records) => {
  const report = records?.[0];
  if (
    records.length !== 1 ||
    report?.fixed !== false ||
    !Array.isArray(report.repairs) ||
    report.repairs.length !== 0 ||
    !Array.isArray(report.findings) ||
    report.findings.length < 1 ||
    report.findings.length > 1_159 ||
    report.summary?.errors !== 0 ||
    report.findings.some(({ severity }) => severity === "error")
  )
    throw new Error("integration.codex.doctor");
  for (const [code, state] of [
    ["doctor.harness.installed", "installed"],
    ["doctor.hook.unchanged", "unchanged"],
  ]) {
    const matches = report.findings.filter(
      (finding) =>
        finding?.code === code &&
        finding?.evidence?.state === state &&
        finding.evidence.subject === "codex" &&
        finding.severity === "info" &&
        finding.suggestedAction === "none",
    );
    if (matches.length !== 1) throw new Error("integration.codex.doctor");
  }
  return {
    findingCount: report.findings.length,
    errors: report.summary.errors,
    warnings: report.summary.warnings,
  };
};
const projectUninstall = (records) => {
  const value = records?.[0];
  if (
    records.length !== 1 ||
    value?.applied !== true ||
    value.changedTargetCount !== 3 ||
    value.disposition !== "committed" ||
    value.harness !== "codex" ||
    value.operation !== "uninstall" ||
    value.targetCount !== 3
  )
    throw new Error("integration.codex.uninstall");
  return {
    disposition: value.disposition,
    changedTargetCount: 3,
    targetCount: 3,
  };
};
const projectTraceGraph = (graph, traceId) => {
  if (!Array.isArray(graph?.resourceSpans) || graph.resourceSpans.length < 1)
    throw new Error("integration.codex.trace-get");
  const spans = graph.resourceSpans.flatMap((resource) =>
    Array.isArray(resource?.scopeSpans)
      ? resource.scopeSpans.flatMap((scope) =>
          Array.isArray(scope?.spans) ? scope.spans : [],
        )
      : [],
  );
  const root = spans.find(({ name }) => name === "codex.turn");
  const model = spans.find(({ name }) => name === "codex.response");
  const stringAttribute = (span, key) => {
    const matches = Array.isArray(span?.attributes)
      ? span.attributes.filter((attribute) => attribute?.key === key)
      : [];
    return matches.length === 1 &&
      typeof matches[0]?.value?.stringValue === "string"
      ? matches[0].value.stringValue
      : null;
  };
  if (
    spans.length !== 2 ||
    root?.traceId !== traceId ||
    model?.traceId !== traceId ||
    typeof root.spanId !== "string" ||
    root.spanId.length !== 16 ||
    model?.parentSpanId !== root.spanId ||
    (root.parentSpanId !== undefined && root.parentSpanId !== "")
  )
    throw new Error("integration.codex.trace-get");
  return {
    resourceSpanCount: graph.resourceSpans.length,
    spanNames: [root.name, model.name],
    parentLinked: true,
    sessionId: stringAttribute(root, "session.id"),
    modelName: stringAttribute(model, "llm.model_name"),
  };
};
const readTraceSummary = async ({
  attemptDeadline,
  childDeadline,
  observationDeadline,
}) => {
  if (codexSessionId === undefined)
    throw new Error("integration.codex.session-ledger");
  const { stdout, traceTimedOut, traceUnavailable } = await run(
    agentscope,
    [
      "traces",
      "search",
      "--destination",
      "local",
      "--harness",
      "codex",
      "--limit",
      "50",
      "--output",
      "json",
    ],
    {
      acceptTraceSearchUnavailable: true,
      monotonicDeadline: childDeadline,
    },
  );
  if (traceTimedOut) {
    if (
      !terminalObservationBeforeDeadline({
        observed: true,
        deadline: observationDeadline,
        now: bootNow,
      })
    )
      throw new Error("integration.codex.trace-deadline");
    return null;
  }
  if (
    !terminalObservationBeforeDeadline({
      observed: true,
      deadline: attemptDeadline,
      now: bootNow,
    })
  )
    throw new Error("integration.codex.trace-deadline");
  if (traceUnavailable) return null;
  const records = parseMachine(stdout, "agentscope traces search");
  return classifyTraceSearchRecordsBeforeDeadline({
    records,
    deadline: attemptDeadline,
    now: bootNow,
    record: recordInteractivePhase,
  });
};
const waitForCodexTurnTerminal = async (traceDeadline) => {
  if (codexLedgerBaseline === undefined)
    throw new Error("integration.codex.session-ledger");
  while (true) {
    if (bootNow() >= traceDeadline)
      throw new Error("integration.codex.trace-deadline");
    const records = readCodexSessionLedgerRecords(homeDescriptor);
    const turnId = codexTurnTerminalIdAfterBaseline(
      records,
      codexLedgerBaseline,
      expectedAssistantMessage,
    );
    if (
      terminalObservationBeforeDeadline({
        observed: turnId !== null,
        deadline: traceDeadline,
        now: bootNow,
      })
    )
      return { records, turnId };
    await waitWithinObservationDeadline({
      deadline: traceDeadline,
      maximumWaitMilliseconds: 100,
      now: bootNow,
      wait: (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
    });
    remaining();
  }
};
const waitForCodexStopBeforeExit = async (traceDeadline) => {
  while (true) {
    if (bootNow() >= traceDeadline)
      throw new Error("integration.codex.trace-deadline");
    const state = classifyCodexShutdownAtJoinDeadline({
      directoryDescriptor: codexDiagnosticLogDirectoryDescriptor,
      directoryPath: codexDiagnosticLogDirectory,
    });
    if (codexStopHookReadyForExit(state)) return;
    await waitWithinObservationDeadline({
      deadline: traceDeadline,
      maximumWaitMilliseconds: 20,
      now: bootNow,
      wait: (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
    });
    remaining();
  }
};
const waitForTraceObservation = (traceDeadline) =>
  waitWithinObservationDeadline({
    deadline: traceDeadline,
    maximumWaitMilliseconds: 20,
    now: bootNow,
    wait: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });
const recordCompletedHookDuration = (observation) => {
  if (observation === undefined) return;
  recordInteractivePhase(
    observation.durationMilliseconds >= 4_900
      ? "hook-command-completed-near-budget-boundary"
      : "hook-command-completed-before-budget-boundary",
  );
};
const waitForTraceObservationOrRecord = async (deadline, observation) => {
  try {
    await waitForTraceObservation(deadline);
  } catch (error) {
    recordCompletedHookDuration(observation);
    throw error;
  }
};
const waitForTraceSummary = async (traceDeadline) => {
  if (bootNow() >= traceDeadline)
    throw new Error("integration.codex.trace-deadline");
  recordTerminalObservationBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    record: () => recordInteractivePhase("trace-search"),
  });
  let summary;
  let lastCompletedHookCommand;
  while (summary === undefined) {
    const hookCommandObservation = inspectDiagnosticBeforeDeadline({
      deadline: traceDeadline,
      now: bootNow,
      inspect: () =>
        inspectCodexStopHookCommand({
          directoryDescriptor: codexDiagnosticLogDirectoryDescriptor,
          directoryPath: codexDiagnosticLogDirectory,
        }),
    });
    if (hookCommandObservation?.outcome === "completed")
      lastCompletedHookCommand = hookCommandObservation;
    traceWaitHookCompleted = hookCommandObservation?.outcome === "completed";
    if (
      hookCommandObservation !== undefined &&
      hookCommandObservation.outcome !== "completed"
    ) {
      const failure = codexStopHookCommandFailure(
        hookCommandObservation.outcome,
      );
      recordTerminalObservationBeforeDeadline({
        deadline: traceDeadline,
        now: bootNow,
        record: () => recordInteractivePhase(failure.phase),
      });
      throw new Error(failure.error);
    }
    const reporterSettled = localSqliteReporterSettled(
      localSqliteLifecycleDescriptor,
    );
    traceWaitReporterSettled = traceWaitHookCompleted && reporterSettled;
    if (hookCommandObservation?.outcome !== "completed" || !reporterSettled) {
      await waitForTraceObservationOrRecord(
        traceDeadline,
        lastCompletedHookCommand,
      );
      continue;
    }
    const traceSearchDeadlines = codexTraceSearchAttemptDeadlines({
      now: bootNow(),
      observationDeadline: traceDeadline,
    });
    const observationClosed = traceSearchDeadlines === null;
    const candidate = traceSummaryBeforeDeadline({
      summary:
        traceSearchDeadlines === null
          ? null
          : await readTraceSummary(traceSearchDeadlines),
      deadline: traceDeadline,
      now: bootNow,
    });
    const terminalCut = classifyCodexSettledTraceObservation({
      hookCompleted: true,
      observationClosed,
      reporterSettled: true,
      tracePresent: candidate !== null,
    });
    if (terminalCut === "accepted") {
      summary = candidate;
      break;
    }
    if (terminalCut === "missing") {
      const operationalPhase = classifyLocalSqliteOutcomeAfterBaseline(
        operationalStateHealthDescriptor,
        operationalStateBaseline,
      );
      if (operationalPhase === "pending") {
        await waitForTraceObservationOrRecord(
          traceDeadline,
          lastCompletedHookCommand,
        );
        continue;
      }
      const phase =
        operationalPhase === "no-operational-state"
          ? classifyMissingOperationalStateByHookDuration(
              hookCommandObservation.durationMilliseconds,
            )
          : operationalPhase;
      recordTerminalObservationBeforeDeadline({
        deadline: traceDeadline,
        now: bootNow,
        record: () => recordInteractivePhase(phase),
      });
      throw new Error(`integration.codex.${phase}`);
    }
    await waitWithinObservationDeadline({
      deadline: traceDeadline,
      maximumWaitMilliseconds: 100,
      now: bootNow,
      wait: (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
    });
    remaining();
  }
  recordTerminalObservationBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    record: () => recordInteractivePhase("trace-reporter-settled"),
  });
  recordTerminalObservationBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    record: () => recordInteractivePhase("trace-search-result"),
  });
  return summary;
};

let completed = false;
let codexLedgerBaseline;
let codexSessionId;
try {
  recordInteractivePhase("init");
  await cli(["init", "--yes"], "agentscope init");
  recordInteractivePhase("destination");
  await cli(
    ["destination", "configure", "local-sqlite", "--name", "local", "--yes"],
    "agentscope destination configure",
  );
  recordInteractivePhase("routing");
  await cli(["routing", "set", "local"], "agentscope routing set");
  recordInteractivePhase("install");
  await cli(["install", "codex", "--yes"], "agentscope install");
  const codexHomeStatus = lstatSync(codexHome);
  if (
    !codexHomeStatus.isDirectory() ||
    codexHomeStatus.isSymbolicLink() ||
    codexHomeStatus.uid !== 1000 ||
    codexHomeStatus.gid !== 1000 ||
    (codexHomeStatus.mode & 0o7777) !== 0o700
  )
    throw new Error("integration.codex.candidate-home");
  const hookPath = join(codexHome, "hooks.json");
  const hookStatus = lstatSync(hookPath);
  if (
    !hookStatus.isFile() ||
    hookStatus.isSymbolicLink() ||
    hookStatus.nlink !== 1 ||
    hookStatus.uid !== 1000 ||
    hookStatus.gid !== 1000 ||
    (hookStatus.mode & 0o7777) !== 0o600
  )
    throw new Error("integration.codex.candidate-home");
  const originalHooks = readFileSync(hookPath, "utf8");
  const launcher = installedLauncher(JSON.parse(originalHooks));
  if (!/\/agentscope-hook-v1-[a-f0-9]{64}-d5000$/u.test(launcher))
    throw new Error("integration.codex.hook-deadline");
  const launcherStatus = lstatSync(launcher);
  if (
    !launcherStatus.isFile() ||
    launcherStatus.isSymbolicLink() ||
    launcherStatus.nlink !== 1 ||
    launcherStatus.uid !== 1000 ||
    launcherStatus.gid !== 1000 ||
    (launcherStatus.mode & 0o7777) !== 0o700
  )
    throw new Error("integration.codex.hook-configuration");
  localSqliteLifecycleDescriptor = openLocalSqliteLifecycle(homeDescriptor);
  operationalStateHealthDescriptor = openOperationalStateHealth(homeDescriptor);
  operationalStateBaseline = localSqliteAcceptanceBaseline(
    operationalStateHealthDescriptor,
  );
  const { stdout: installedStatusOutput } = await run(
    agentscope,
    ["harness", "status", "codex", "--output", "json"],
    { candidatePrincipal: true },
  );
  const installedStatusRecords = parseMachine(
    installedStatusOutput,
    "agentscope harness status",
  );
  const installedStatus = projectHarnessStatus(
    installedStatusRecords,
    "unchanged",
    1,
  );
  mkdirSync(codexDiagnosticLogDirectory, { mode: 0o700 });
  codexDiagnosticLogDirectoryDescriptor = openSync(
    codexDiagnosticLogDirectory,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  const diagnosticBefore = fstatSync(codexDiagnosticLogDirectoryDescriptor);
  if (
    !diagnosticBefore.isDirectory() ||
    diagnosticBefore.uid !== 0 ||
    diagnosticBefore.gid !== 0 ||
    (diagnosticBefore.mode & 0o7777) !== 0o700
  )
    throw new Error("integration.codex.candidate-home");
  fchownSync(codexDiagnosticLogDirectoryDescriptor, 1000, 1000);
  const diagnosticAfter = fstatSync(codexDiagnosticLogDirectoryDescriptor);
  if (
    diagnosticAfter.dev !== diagnosticBefore.dev ||
    diagnosticAfter.ino !== diagnosticBefore.ino ||
    diagnosticAfter.uid !== 1000 ||
    diagnosticAfter.gid !== 1000 ||
    (diagnosticAfter.mode & 0o7777) !== 0o700
  )
    throw new Error("integration.codex.candidate-home");
  recordInteractivePhase("model-gate-start");
  const modelAdmissionCutoff = Math.floor(deadline - 5_000);
  if (
    !Number.isSafeInteger(modelAdmissionCutoff) ||
    modelAdmissionCutoff <= bootNow()
  )
    throw new Error("integration.codex.model-gate");
  await configureModelGate(modelAdmissionCutoff);
  recordInteractivePhase("model-gate-configured");
  await proveControlPlaneClosed();
  recordCandidateConfigStage("closed-marker");
  recordInteractivePhase("control-plane-closed");
  recordCandidateConfigStage("render");
  // TOML has no syntax for returning to the root table. Keep every root key
  // ahead of the first table emitted by the provider configuration; appending
  // log_dir after it would silently make the key part of model_providers.
  const configuration = `log_dir = ${JSON.stringify(codexDiagnosticLogDirectory)}\n${createCodexInternalProviderConfiguration(
    {
      baseUrl: `${modelEndpoint}/v1`,
      model: "fixture-model",
    },
  )}\n[projects."/worktree"]\ntrust_level = "trusted"\n`;
  recordCandidateConfigStage("create");
  const configurationPath = join(codexHome, "config.toml");
  writeFileSync(configurationPath, configuration, {
    flag: "wx",
    mode: 0o600,
  });
  recordCandidateConfigStage("open");
  const configurationDescriptor = openSync(
    configurationPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  recordCandidateConfigStage("prove");
  try {
    const before = fstatSync(configurationDescriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== 0 ||
      before.gid !== 0 ||
      before.size !== Buffer.byteLength(configuration) ||
      (before.mode & 0o7777) !== 0o600
    )
      throw new Error("integration.codex.candidate-home");
    fchmodSync(configurationDescriptor, 0o600);
    // The closed container has CAP_CHOWN, not CAP_FOWNER. Normalize mode
    // while root still owns the inode, then transfer ownership exactly once.
    fchownSync(configurationDescriptor, 1000, 1000);
    const after = fstatSync(configurationDescriptor);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.uid !== 1000 ||
      after.gid !== 1000 ||
      after.size !== before.size ||
      (after.mode & 0o7777) !== 0o600
    )
      throw new Error("integration.codex.candidate-home");
  } finally {
    closeSync(configurationDescriptor);
  }
  recordCandidateConfigStage("publish");
  const traceDeadline = deadline - 3_000;
  await new Promise((resolve, reject) => {
    process.stdout.write(
      `AGENTSCOPE_PTY_READY:${readinessChallenge}\r\n`,
      (error) =>
        error === null || error === undefined ? resolve() : reject(error),
    );
  });
  candidateConfigStage = undefined;
  recordInteractivePhase("tui-readiness-challenge-published");
  recordInteractivePhase("tui-start");
  const codexRun = run(
    "/usr/local/bin/node",
    ["/opt/agentscope/codex-candidate-dropper.mjs"],
    {
      cwd: worktree,
      env: {
        HOME: home,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        TERM: "xterm-256color",
        XDG_CONFIG_HOME: "/harness-home",
        AGENTSCOPE_HOME: agentscopeHome,
        CODEX_HOME: codexHome,
        // The pinned Codex source emits the command authority span from this
        // exact module target. Select it directly: accepting a broader crate
        // prefix made the evidence depend on EnvFilter prefix behaviour rather
        // than the authenticated producer identity.
        RUST_LOG: "codex_hooks::engine::command_runner=trace",
        AGENTSCOPE_CANDIDATE_RUN_ID: integrationRunId,
      },
      inherit: true,
    },
  );
  recordInteractivePhase("tui-run-created");
  // The fixed witness window starts only after the exact candidate child has
  // been launched; setup and PTY publication cannot consume its authority.
  const checkpointWitness = waitForCheckpointWitness();
  let armPending = true;
  let preArmExitPhase = "tui-exit-before-checkpoint";
  const earlyCodexExit = codexRun.then(
    () => {
      if (!armPending) return;
      if (preArmExitPhase === "tui-exit-before-checkpoint")
        recordPreCheckpointFailure(preArmExitPhase);
      else recordInteractivePhase(preArmExitPhase);
      throw new Error(`integration.codex.${preArmExitPhase}`);
    },
    () => {
      if (!armPending) return;
      // A rejected child promise includes spawn failure and nonzero exit; it
      // cannot truthfully assert that an installed TUI process ever exited.
      recordInteractivePhase("tui-child-rejected");
      throw new Error("integration.codex.tui-child-rejected");
    },
  );
  try {
    await Promise.race([checkpointWitness, earlyCodexExit]);
  } catch (error) {
    if (error?.message === "integration.codex.process-checkpoint")
      recordPreCheckpointFailure("tui-checkpoint-not-witnessed");
    throw error;
  }
  recordInteractivePhase("tui-checkpoint");
  preArmExitPhase = "tui-exit-before-arm";
  recordInteractivePhase("model-gate-arm-start");
  const gateArm = armModelGate(modelAdmissionCutoff);
  sessionStartBeforeFirstModelRequestAdmission = await Promise.race([
    gateArm,
    earlyCodexExit,
  ]);
  armPending = false;
  recordInteractivePhase("model-gate-arm-complete");
  await waitForModelRequestBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    request: readModelRequests,
    wait: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });
  recordInteractivePhase("model-request-observed");
  recordInteractivePhase("model-request");
  await releaseModelResponse();
  // Codex 0.149.1 deliberately excludes transient hook lifecycle events from
  // its rollout. Prove the installed hook through the durable trace and exact
  // rollout session identity below, after the sole challenged turn completes
  // and Testkit joins Codex so its vendor Stop hook has run.
  await waitForCodexTurnTerminal(traceDeadline);
  recordInteractivePhase("trace-terminal");
  // The rollout can record a completed turn while Codex is still executing
  // its Stop hook. Releasing /exit at that point can race the TUI composer.
  // Consume the same deadline and require the exact Stop completion first;
  // the final lifecycle remains independently checked after process join.
  await waitForCodexStopBeforeExit(traceDeadline);
  await publishTerminalCompletionBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    record: () => remaining(),
    publish: () =>
      new Promise((resolve, reject) => {
        process.stdout.write(
          `\u001b]2;${terminalCompletionMarker}\u001b\\`,
          (error) =>
            error === null || error === undefined ? resolve() : reject(error),
        );
      }),
  });
  recordInteractivePhase("tui-exit-published");
  try {
    await observeBeforeDiagnosticDeadline(codexRun, traceDeadline);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "integration.codex.diagnostic-deadline") {
      recordInteractivePhase("tui-join-deadline");
      try {
        joinDeadlineHookState = classifyCodexShutdownAtJoinDeadline({
          directoryDescriptor: codexDiagnosticLogDirectoryDescriptor,
          directoryPath: codexDiagnosticLogDirectory,
        });
      } catch {
        joinDeadlineHookState = "hook-log-invalid";
      }
    } else if (message === "integration.codex.child")
      recordInteractivePhase("tui-child-rejected");
    throw error;
  }
  recordInteractivePhase("tui-joined");
  const rootHookLifecycle = inspectDiagnosticBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    inspect: () =>
      inspectCodexRootHookLifecycle({
        directoryDescriptor: codexDiagnosticLogDirectoryDescriptor,
        directoryPath: codexDiagnosticLogDirectory,
      }),
  });
  if (rootHookLifecycle === undefined) {
    recordInteractivePhase("hook-command-missing");
    throw new Error("integration.codex.hook-command-missing");
  }
  if (
    !codexSessionStartCheckpointMatchesLifecycle(
      sessionStartBeforeFirstModelRequestAdmission,
      rootHookLifecycle,
    )
  )
    throw new Error("integration.codex.hook-lifecycle");
  recordTerminalObservationBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    record: () => recordInteractivePhase("trace-settlement"),
  });
  const sessionStartCommandDurationMilliseconds =
    rootHookLifecycle.sessionStartDurationMilliseconds;
  const summary = await waitForTraceSummary(traceDeadline);
  recordTerminalObservationBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    record: () => recordInteractivePhase("verify"),
  });
  recordInteractivePhase("verify-config");
  if (readFileSync(hookPath, "utf8") !== originalHooks)
    throw new Error("integration.codex.hook-configuration");
  recordInteractivePhase("verify-gate");
  const modelRequests = await sealModelGate(
    sessionStartBeforeFirstModelRequestAdmission,
  );
  recordInteractivePhase("verify-trace-get");
  const traceId = summary?.locator?.traceId;
  if (summary?.harness !== "codex" || typeof traceId !== "string")
    throw new Error("integration.codex.trace-search");
  const getRecords = await cli(
    [
      "traces",
      "get",
      "--destination",
      "local",
      "--trace-ref",
      JSON.stringify(summary.locator),
    ],
    "agentscope traces get",
    { monotonicDeadline: traceDeadline },
  );
  if (getRecords.length !== 1 || getRecords[0]?.locator?.traceId !== traceId)
    throw new Error("integration.codex.trace-get");
  recordInteractivePhase("verify-correlation");
  const traceGraph = projectTraceGraph(getRecords[0].graph, traceId);
  if (codexSessionId === undefined || traceGraph.sessionId !== codexSessionId)
    throw new Error("integration.codex.trace-correlation");
  recordInteractivePhase("verify-doctor");
  const doctor = projectDoctor(
    await cli(["doctor"], "agentscope doctor", {
      monotonicDeadline: traceDeadline,
    }),
  );
  recordInteractivePhase("verify-uninstall");
  const uninstallRecords = await cli(
    ["uninstall", "codex", "--yes"],
    "agentscope uninstall",
    { monotonicDeadline: traceDeadline },
  );
  uninstallVerificationStep = "result";
  const uninstall = projectUninstall(uninstallRecords);
  uninstallVerificationStep = "hook";
  if (existsSync(hookPath)) throw new Error("integration.codex.uninstall");
  recordInteractivePhase("verify-status");
  const uninstalledStatus = projectHarnessStatus(
    await cli(["harness", "status", "codex"], "agentscope harness status", {
      monotonicDeadline: traceDeadline,
    }),
    "ready",
    1,
  );
  recordInteractivePhase("verify-projection");
  const translated = translateCodexPlatformObservations({
    scenarioId,
    prompt,
    promptSha256,
    mediation: { sessionStartCommandDurationMilliseconds },
    modelRequests,
    search: {
      completion: "complete",
      harness: summary.harness,
      spanCount: summary.spanCount,
      traceId,
    },
    retrieval: {
      completion: "complete",
      ...traceGraph,
      traceId,
    },
    doctor: { completion: "complete", ...doctor },
    uninstall: {
      completion: "complete",
      installedStatus,
      uninstall,
      uninstalledStatus,
    },
  });
  const evidence = correlateCodexPlatformObservations(translated, {
    artifactFileName: basename(artifactPath),
    expectedPromptSha256: promptSha256,
    scenarioId,
  });
  recordInteractivePhase("verify-evidence");
  const encodedEvidence = Buffer.from(JSON.stringify(evidence)).toString(
    "base64url",
  );
  recordTerminalObservationBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    record: () =>
      writeFileSync(
        join(ledger, "fixture-result.json"),
        `${JSON.stringify({ evidenceVersion: 1, scenarioId, encodedEvidence })}\n`,
        { flag: "wx", mode: 0o600 },
      ),
  });
  completed = true;
} finally {
  if (!completed) {
    try {
      await gateRequest(
        "/deny",
        { runId: integrationRunId },
        AbortSignal.timeout(Math.min(1_000, Math.max(1, deadline - bootNow()))),
      );
    } catch {
      // The outer controller retains the causal failure and retires the exact
      // sidecar when the in-container denial receipt cannot be completed.
    }
  }
  modelControlAgent.destroy();
  if (localSqliteLifecycleDescriptor !== undefined)
    closeSync(localSqliteLifecycleDescriptor);
  if (codexDiagnosticLogDirectoryDescriptor !== undefined)
    closeSync(codexDiagnosticLogDirectoryDescriptor);
  if (operationalStateHealthDescriptor !== undefined)
    closeSync(operationalStateHealthDescriptor);
  closeSync(homeDescriptor);
  if (!completed) {
    try {
      rmSync(join(ledger, "fixture-result.json"));
    } catch {
      // The selected execution kernel owns terminal descendant settlement.
    }
  }
}
