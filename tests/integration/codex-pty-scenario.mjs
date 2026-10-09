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
import { basename, join } from "node:path";
import { encodeAdapterReportedFailureMarker } from "./codex-pty-research.mjs";
import {
  interactivePhases,
  classifyCodexCollectedChildFailure,
} from "./codex-trace-child-diagnostics.mjs";
import {
  codexArmPendingResearchHint,
  codexProjectionFailureDiagnostic,
  codexUninstallFailureDiagnostic,
  codexUninstallUnclassifiedStageDiagnostic,
  decodeCodexJoinDeadlineExitCode,
  encodeCodexJoinDeadlineExitCode,
  encodeInteractiveFailureExitCode,
  parseCodexMachineOutput as parseMachine,
} from "./immutable-candidate-authority.mjs";

import {
  openMockServerControl,
  projectMockServerRequests,
  snapshotMockServerTraffic,
} from "./mockserver-control.mjs";

let ledger;
let terminalCompletionMarker = "AGENTSCOPE_PTY_COMPLETE";
let interactiveFailurePhase = "bootstrap";
let interactiveFailurePhaseIndex = 0;
let preCheckpointFailureDiagnostic;
let candidateConfigStage;
let adapterReportedFailure;
let modelControlFailureHint;
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
const advanceInteractivePhase = (phase) => {
  const phaseIndex = interactivePhases.indexOf(phase);
  if (phaseIndex <= interactiveFailurePhaseIndex)
    throw new Error("integration.codex.failure-phase");
  interactiveFailurePhase = phase;
  interactiveFailurePhaseIndex = phaseIndex;
};
if (process.hasUncaughtExceptionCaptureCallback())
  throw new Error("integration.codex.failure-capture");
const postTraceFailureDiagnostic = (error) => {
  if (interactiveFailurePhase === "verify-projection")
    return codexProjectionFailureDiagnostic(error?.message);
  if (interactiveFailurePhase === "verify-uninstall")
    return (
      codexUninstallFailureDiagnostic(error?.message) ??
      codexUninstallUnclassifiedStageDiagnostic(uninstallVerificationStep)
    );
  return undefined;
};
process.setUncaughtExceptionCaptureCallback((error) => {
  let exitCode = 64 + interactiveFailurePhaseIndex;
  const candidateConfigDiagnostic =
    interactiveFailurePhase === "control-plane-closed" &&
    candidateConfigStage !== undefined
      ? `integration.fixture.codex-candidate-config-${candidateConfigStage}`
      : undefined;
  const gateResearchDiagnostic =
    interactiveFailurePhase === "verify-gate" &&
    modelControlFailureHint !== undefined
      ? `integration.fixture.codex-gate-research-${modelControlFailureHint}`
      : interactiveFailurePhase === "model-gate-arm-health-pending"
        ? `integration.fixture.codex-gate-research-${codexArmPendingResearchHint(error)}`
        : undefined;
  const ownedDiagnostic =
    preCheckpointFailureDiagnostic ??
    candidateConfigDiagnostic ??
    postTraceFailureDiagnostic(error);
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
    const diagnostic =
      preCheckpointFailureDiagnostic ??
      ownedDiagnostic ??
      gateResearchDiagnostic ??
      (interactiveFailurePhase === "tui-join-deadline"
        ? (decodeCodexJoinDeadlineExitCode(exitCode) ??
          "integration.fixture.codex-tui-join-deadline")
        : `integration.fixture.codex-${interactiveFailurePhase}`);
    if (ledger !== undefined && preCheckpointFailureDiagnostic === undefined)
      writeFileSync(
        join(ledger, "interactive-failure.txt"),
        encodeAdapterReportedFailureMarker(
          diagnostic,
          integrationRunId,
          adapterReportedFailure,
        ) ?? `${diagnostic}\n`,
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
        if (
          deadlineExpired ||
          code !== 0 ||
          signal !== null ||
          stdout.length > maximumOutput ||
          stderr.length > maximumOutput
        ) {
          const failureObservation = {
            code,
            deadlineExpired,
            signal,
            stderrBytes: stderr.length,
            stdoutBytes: stdout.length,
            maximumBytes: maximumOutput,
            stderr,
            stdout,
          };
          const selected = classifyCodexCollectedChildFailure(
            failureObservation,
            options,
            adapterReportedFailure === undefined,
          );
          if (adapterReportedFailure === undefined)
            adapterReportedFailure = selected.adapterReportedFailure;
          return reject(new Error(selected.message));
        }
        resolve({ stderr, stdout });
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
let codexDiagnosticLogDirectoryDescriptor;
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
  inspectCodexRootHookLifecycle,
  codexSessionIdentity,
  projectCodexPostJoinTranscript,
  codexTurnTerminalIdAfterBaseline,
  codexTurnTerminalObservedAfterBaseline,
  inspectDiagnosticBeforeDeadline,
  publishTerminalCompletionBeforeDeadline,
  recordTerminalObservationBeforeDeadline,
  readCodexSessionLedgerRecords,
  terminalObservationBeforeDeadline,
  waitWithinObservationDeadline,
} = evidenceModule;
const { correlateCodexNativeObservations } = oracleModule;
const { translateCodexNativeObservations } = adapterModule;

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
    {
      ...options,
      env: {
        ...process.env,
        AGENTSCOPE_LANGFUSE_PUBLIC_KEY: "DUMMY_PUBLIC_KEY",
        AGENTSCOPE_LANGFUSE_SECRET_KEY: "DUMMY_SECRET_KEY",
        NODE_EXTRA_CA_CERTS: "/opt/agentscope/collector-ca.pem",
      },
      candidatePrincipal: true,
    },
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
let upstreamControl;
let candidateTraffic;
let upstreamTraffic;
const readModelRequests = async () => {
  // Compare the current configuration, candidate denials and controller
  // retrievals without changing the existing controller-call ceiling.
  if (upstreamControl.snapshot().entries.length >= 7) {
    modelControlFailureHint ??= "model-budget";
    throw new Error("integration.codex.model-control");
  }
  const response = await upstreamControl.requests();
  if (response.status !== 200) {
    modelControlFailureHint ??= "model-http-status";
    throw new Error("integration.codex.model-control");
  }
  let observed;
  try {
    observed = projectMockServerRequests(response.bytes, promptSha256);
  } catch (error) {
    modelControlFailureHint ??= "model-projection";
    throw error;
  }
  const sent = upstreamControl.snapshot().entries;
  const controls = [sent[0], ...candidateTraffic.entries, ...sent.slice(1)];
  let controlIndex = 0;
  const entries = observed.map((row) => {
    if (row.role === undefined || row.role === "data-plane")
      return {
        method: row.method,
        path: row.path,
        role: "data-plane",
        status: 200,
        bodyBytes: row.bodyBytes,
        bodySha256: row.bodySha256,
      };
    const client = controls[controlIndex++];
    if (
      client === undefined ||
      ["method", "path", "role", "status", "bodyBytes", "bodySha256"].some(
        (key) => row[key] !== client[key],
      )
    ) {
      modelControlFailureHint ??= "model-control-order";
      throw new Error("integration.codex.model-control");
    }
    return client;
  });
  if (controlIndex !== controls.length) {
    modelControlFailureHint ??= "model-control-count";
    throw new Error("integration.codex.model-control");
  }
  upstreamTraffic = snapshotMockServerTraffic(
    { runId: integrationRunId, entries },
    integrationRunId,
  );
  try {
    return boundedRequestLedger(
      observed.filter(
        (row) => row.role === undefined || row.role === "data-plane",
      ),
    );
  } catch (error) {
    modelControlFailureHint ??= "model-ledger";
    throw error;
  }
};
const configureModelGate = async (preparationCutoff, traceDeadline) => {
  const endpoint = new URL(modelEndpoint);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "mockserver" ||
    endpoint.port !== "1080" ||
    endpoint.pathname !== "/"
  )
    throw new Error("integration.codex.model-control");
  upstreamControl = openMockServerControl({
    runId: integrationRunId,
    host: "mockserver",
    deadline: traceDeadline,
    now: bootNow,
  });
  const routeAuthority = JSON.parse(
    readFileSync("/opt/agentscope/current-model-routes.json", "utf8"),
  );
  const routeIndex = routeAuthority.routeIds?.indexOf("codex-tui-responses");
  const route =
    Number.isInteger(routeIndex) && routeIndex >= 0
      ? routeAuthority.routes?.[routeIndex]
      : undefined;
  const expectation = routeAuthority.mockServerInitialization?.[routeIndex];
  const body = route?.responseBodyText;
  if (
    routeAuthority.routeIds?.lastIndexOf("codex-tui-responses") !==
      routeIndex ||
    route?.method !== "POST" ||
    route?.path !== "/v1/responses" ||
    typeof body !== "string" ||
    body.split("AGENTSCOPE_PTY_COMPLETE").length !== 2 ||
    body.includes(expectedAssistantMessage) ||
    expectation?.httpRequest?.method !== "POST" ||
    expectation.httpRequest.path !== "/v1/responses" ||
    expectation?.httpResponse?.body !== body
  )
    throw new Error("integration.codex.model-control");
  const response = await upstreamControl.configure(
    {
      ...expectation,
      httpResponse: {
        ...expectation.httpResponse,
        body: body.replace("AGENTSCOPE_PTY_COMPLETE", expectedAssistantMessage),
      },
    },
    preparationCutoff,
  );
  if (response.status !== 201 || bootNow() >= preparationCutoff)
    throw new Error("integration.codex.model-control");
  const candidate = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { probeMockServerCandidate, readMockServerBootClock as now } from "/opt/agentscope/mockserver-control.mjs";
console.log(JSON.stringify(await probeMockServerCandidate({runId:${JSON.stringify(integrationRunId)},host:"mockserver",deadline:${preparationCutoff},now})));`,
    ],
    { candidatePrincipal: true, monotonicDeadline: preparationCutoff },
  );
  candidateTraffic = snapshotMockServerTraffic(
    JSON.parse(candidate.stdout.toString("utf8")),
    integrationRunId,
  );
};
const recordModelBaseline = (records) => {
  if (records.length !== 1) throw new Error("integration.codex.session-ledger");
  codexSessionId = codexSessionIdentity(records);
  const newline = records[0].content.indexOf("\n");
  if (newline < 0) throw new Error("integration.codex.session-ledger");
  const prefix = records[0].content.slice(0, newline + 1);
  if (JSON.parse(prefix).type !== "session_meta")
    throw new Error("integration.codex.session-ledger");
  // Actual byte-zero metadata prefix of a newly created authenticated inode;
  // not a claim that this sample preceded the model request.
  codexLedgerBaseline = [{ ...records[0], content: prefix }];
  if (
    codexSessionIdentity(codexLedgerBaseline) !== codexSessionId ||
    codexTurnTerminalObservedAfterBaseline(
      codexLedgerBaseline,
      codexLedgerBaseline,
      expectedAssistantMessage,
    )
  )
    throw new Error("integration.codex.session-ledger");
};
// Retrieval is provisional. The outer controller accepts the full ledger only
// after the original stop barrier and exact container join.
const readTerminalModelRequests = async () => readModelRequests();
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
const waitForCodexTurnTerminal = async (traceDeadline) => {
  while (true) {
    if (bootNow() >= traceDeadline)
      throw new Error("integration.codex.trace-deadline");
    const records = readCodexSessionLedgerRecords(homeDescriptor);
    // A fresh Codex rollout is materialized by the first submitted turn,
    // not by idle readiness or the process-topology checkpoint. Bind its
    // actual byte-zero metadata only inside this existing observation path.
    // An authenticated empty observation can precede first materialization.
    // Once bound, disappearance still goes through strict evolution checks.
    if (codexLedgerBaseline === undefined && records.length !== 0)
      recordModelBaseline(records);
    const turnId =
      codexLedgerBaseline === undefined
        ? null
        : codexTurnTerminalIdAfterBaseline(
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
let completed = false;
let codexLedgerBaseline;
let codexTerminalLedger;
let codexSessionId;
let codexTurnId;
try {
  recordInteractivePhase("init");
  await cli(["init", "--yes"], "agentscope init");
  recordInteractivePhase("destination");
  await cli(
    [
      "destination",
      "configure",
      "langfuse",
      "--name",
      "collector",
      "--yes",
      "--settings",
      JSON.stringify({ endpoint: "https://collector:4318" }),
      "--credential-env",
      "public-key=AGENTSCOPE_LANGFUSE_PUBLIC_KEY",
      "secret-key=AGENTSCOPE_LANGFUSE_SECRET_KEY",
    ],
    "agentscope destination configure",
    {
      env: {
        ...process.env,
        AGENTSCOPE_LANGFUSE_PUBLIC_KEY: "DUMMY_PUBLIC_KEY",
        AGENTSCOPE_LANGFUSE_SECRET_KEY: "DUMMY_SECRET_KEY",
        NODE_EXTRA_CA_CERTS: "/opt/agentscope/collector-ca.pem",
      },
    },
  );
  recordInteractivePhase("routing");
  await cli(["routing", "set", "collector"], "agentscope routing set");
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
  const preparationCutoff = Math.floor(deadline - 5_000);
  const traceDeadline = deadline - 3_000;
  if (
    !Number.isSafeInteger(preparationCutoff) ||
    preparationCutoff <= bootNow()
  )
    throw new Error("integration.codex.model-gate");
  await configureModelGate(preparationCutoff, traceDeadline);
  recordInteractivePhase("model-gate-configured");
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
  if (readCodexSessionLedgerRecords(homeDescriptor).length !== 0)
    throw new Error("integration.codex.session-ledger");
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
        AGENTSCOPE_LANGFUSE_PUBLIC_KEY: "DUMMY_PUBLIC_KEY",
        AGENTSCOPE_LANGFUSE_SECRET_KEY: "DUMMY_SECRET_KEY",
        NODE_EXTRA_CA_CERTS: "/opt/agentscope/collector-ca.pem",
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
  armPending = false;
  recordInteractivePhase("model-gate-arm-complete");
  // Codex 0.149.1 deliberately excludes transient hook lifecycle events from
  // its rollout. Prove the installed hook through the durable trace and exact
  // rollout session identity below, after the sole challenged turn completes
  // and Testkit joins Codex so its vendor Stop hook has run.
  ({ turnId: codexTurnId, records: codexTerminalLedger } =
    await waitForCodexTurnTerminal(traceDeadline));
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
  const nativeTranscriptRange = inspectDiagnosticBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    inspect: () =>
      projectCodexPostJoinTranscript({
        records: readCodexSessionLedgerRecords(homeDescriptor),
        baseline: codexLedgerBaseline,
        observedRecords: codexTerminalLedger,
        expectedMessage: expectedAssistantMessage,
        sessionId: codexSessionId,
        turnId: codexTurnId,
        modelName: "fixture-model",
      }),
  });
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
  recordTerminalObservationBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    record: () => recordInteractivePhase("trace-settlement"),
  });
  const sessionStartCommandDurationMilliseconds =
    rootHookLifecycle.sessionStartDurationMilliseconds;
  recordTerminalObservationBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    record: () => recordInteractivePhase("verify"),
  });
  recordInteractivePhase("verify-config");
  if (readFileSync(hookPath, "utf8") !== originalHooks)
    throw new Error("integration.codex.hook-configuration");
  recordInteractivePhase("verify-gate");
  const modelRequests = await readTerminalModelRequests();
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
  const translated = translateCodexNativeObservations({
    scenarioId,
    prompt,
    promptSha256,
    mediation: { sessionStartCommandDurationMilliseconds },
    modelRequests,
    native: {
      sessionId: codexSessionId,
      turnId: codexTurnId,
      modelName: "fixture-model",
      nativeTranscriptRange,
    },
    doctor: { completion: "complete", ...doctor },
    uninstall: {
      completion: "complete",
      installedStatus,
      uninstall,
      uninstalledStatus,
    },
  });
  const evidence = correlateCodexNativeObservations(translated, {
    artifactFileName: basename(artifactPath),
    expectedPromptSha256: promptSha256,
    scenarioId,
  });
  recordInteractivePhase("verify-evidence");
  const encodedEvidence = Buffer.from(
    JSON.stringify({ ...evidence, mockServerTraffic: upstreamTraffic }),
  ).toString("base64url");
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
  if (codexDiagnosticLogDirectoryDescriptor !== undefined)
    closeSync(codexDiagnosticLogDirectoryDescriptor);
  closeSync(homeDescriptor);
  if (!completed) {
    try {
      rmSync(join(ledger, "fixture-result.json"));
    } catch {
      // The selected execution kernel owns terminal descendant settlement.
    }
  }
}
