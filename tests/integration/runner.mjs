import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  executeSelectedHeadlessProcess,
  executeSelectedPtyProcess,
} from "./testkit/headless-supervisor-kernel.js";
import {
  composeSelectedContainerHeadlessSupervisorCapability,
  createSelectedContainerImmutableCandidateAuthority,
} from "./testkit/internal/headless-supervisor-backend.js";
import {
  compileCandidateInventory,
  compileInstalledPtyFailureReceipt,
  compileInstalledCliPtyReceiptFromExecution,
  decodeImmutableCandidateHandoff,
} from "./immutable-candidate-authority.mjs";
import { runInstalledCliPtyProof } from "./pty-installed-cli-driver.mjs";

const ptyFailurePhases = Object.freeze([
  "runner-bootstrap",
  "candidate-inventory",
  "immutable-candidate",
  "installed-cli",
  "pty-receipt",
]);
let ptyFailurePhase = ptyFailurePhases[0];
let ptyFailureTerminal = false;
const advancePtyFailurePhase = (phase) => {
  const current = ptyFailurePhases.indexOf(ptyFailurePhase);
  const next = ptyFailurePhases.indexOf(phase);
  if (next !== current + 1)
    throw new Error("integration.runner.pty-failure-phase");
  ptyFailurePhase = phase;
};
const defaultPtyFailurePredicate = Object.freeze({
  "candidate-inventory": "candidate-rejected",
  "immutable-candidate": "authority-rejected",
  "installed-cli": "driver-input",
  "pty-receipt": "receipt-rejected",
  "runner-bootstrap": "runner-rejected",
});
const installedDriverPrefix = "integration.pty-installed-cli-driver.";
const emitPtyFailureReceipt = (error) => {
  if (ptyFailureTerminal) return;
  ptyFailureTerminal = true;
  const message = error instanceof Error ? error.message : "";
  const predicate = message.startsWith(installedDriverPrefix)
    ? message.slice(installedDriverPrefix.length)
    : defaultPtyFailurePredicate[ptyFailurePhase];
  let encoded;
  try {
    encoded = compileInstalledPtyFailureReceipt({
      receiptVersion: 1,
      phase: ptyFailurePhase,
      predicate,
    }).encoded;
  } catch {
    encoded = compileInstalledPtyFailureReceipt({
      receiptVersion: 1,
      phase: ptyFailurePhase,
      predicate: defaultPtyFailurePredicate[ptyFailurePhase],
    }).encoded;
  }
  process.stdout.write(`AGENTSCOPE_PTY_FAILURE=${encoded}\n`);
  process.exitCode = 1;
};
if (process.hasUncaughtExceptionCaptureCallback())
  throw new Error("integration.runner.pty-failure-capture");
process.setUncaughtExceptionCaptureCallback(emitPtyFailureReceipt);

const requiredEnvironment = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`integration.runner.environment-${name}`);
  return value;
};
const scenarioId = requiredEnvironment("AGENTSCOPE_SCENARIO_ID");
const candidateRoot = requiredEnvironment("AGENTSCOPE_CANDIDATE_ROOT");
const home = requiredEnvironment("HOME");
const harnessHome = requiredEnvironment("HARNESS_HOME");
const agentscopeHome = requiredEnvironment("AGENTSCOPE_HOME");
const worktree = requiredEnvironment("AGENTSCOPE_WORKTREE");
const ledger = requiredEnvironment("AGENTSCOPE_LEDGER");
const headlessOuterDeadline = Number(
  requiredEnvironment("AGENTSCOPE_HEADLESS_OUTER_MONOTONIC_DEADLINE_MS"),
);
const linuxBootMonotonicMilliseconds = () => {
  const source = readFileSync("/proc/uptime", "utf8");
  if (source.length > 128 || !/^\d+(?:\.\d+)?\s/u.test(source))
    throw new Error("integration.runner.headless-clock");
  const value = Number(source.split(/\s/u, 1)[0]) * 1_000;
  if (!Number.isFinite(value) || value < 0)
    throw new Error("integration.runner.headless-clock");
  return value;
};
const headlessTranslationBootAt = linuxBootMonotonicMilliseconds();
const headlessTranslationLocalAt = performance.now();
if (!Number.isFinite(headlessOuterDeadline))
  throw new Error("integration.runner.headless-authority");
const headlessShutdownDeadline =
  headlessTranslationLocalAt +
  (headlessOuterDeadline - headlessTranslationBootAt);
if (headlessShutdownDeadline <= headlessTranslationLocalAt + 6_000)
  throw new Error("integration.runner.headless-authority");
const digest = (bytes) =>
  `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
const rawSha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fingerprintHeadlessRequest = (request) =>
  `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        runId: request.runId,
        executable: request.executable,
        arguments: request.arguments,
        cwd: request.cwd,
        environment: request.environment,
        stdinBase64: Buffer.from(request.stdin).toString("base64"),
        stdoutLimitBytes: request.stdoutLimitBytes,
        stderrLimitBytes: request.stderrLimitBytes,
        monotonicStartupDeadlineMs: request.monotonicStartupDeadlineMs,
        monotonicExecutionDeadlineMs: request.monotonicExecutionDeadlineMs,
        monotonicShutdownDeadlineMs: request.monotonicShutdownDeadlineMs,
        terminationGraceMs: request.terminationGraceMs,
      }),
    )
    .digest("hex")}`;
const fingerprintSelectedPtyAuthority = (authority) =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(authority))
    .digest("hex")}`;
const assertEmptyDirectory = (path) => {
  if (readdirSync(path).length !== 0)
    throw new Error("integration.runner.home-not-empty");
};
for (const path of [home, harnessHome, agentscopeHome, worktree, ledger])
  assertEmptyDirectory(path);
try {
  writeFileSync("/agentscope-root-write-probe", "forbidden");
  throw new Error("integration.runner.root-writable");
} catch (error) {
  if (error?.message === "integration.runner.root-writable") throw error;
}
mkdirSync(join(worktree, ".git", "refs", "heads"), { recursive: true });
writeFileSync(join(worktree, ".git", "HEAD"), "ref: refs/heads/main\n");
writeFileSync(
  join(worktree, ".git", "config"),
  "[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
);
writeFileSync(join(worktree, "README.md"), "isolated integration worktree\n");

advancePtyFailurePhase("candidate-inventory");
const pointer = JSON.parse(
  readFileSync(join(candidateRoot, "current-candidate.json"), "utf8"),
);
if (
  pointer.pointerVersion !== 1 ||
  !/^sha256-[a-f\d]{64}$/u.test(pointer.bundleIdentity)
)
  throw new Error("integration.runner.candidate-pointer");
const selection = JSON.parse(
  readFileSync("/opt/agentscope/current-selection.json", "utf8"),
);
const manifest = JSON.parse(
  readFileSync("/opt/agentscope/capability-manifest.json", "utf8"),
);
const modelRoutes = JSON.parse(
  readFileSync("/opt/agentscope/current-model-routes.json", "utf8"),
);
const knownScenarios = new Set(
  manifest.scenarios.map(({ scenarioId }) => scenarioId),
);
if (
  selection.selectionVersion !== 2 ||
  selection.manifestIdentity !== manifest.manifestIdentity ||
  typeof selection.selector !== "object" ||
  selection.selector === null ||
  !Array.isArray(selection.scenarioIds) ||
  selection.scenarioIds.length < 1 ||
  selection.scenarioIds.some(
    (scenarioId) =>
      typeof scenarioId !== "string" || !knownScenarios.has(scenarioId),
  )
)
  throw new Error("integration.runner.selection");
const scenario = manifest.scenarios.find(
  (candidate) => candidate.scenarioId === scenarioId,
);
if (
  modelRoutes.routeFixtureVersion !== 1 ||
  !Array.isArray(modelRoutes.routeIds) ||
  !Array.isArray(modelRoutes.routes) ||
  scenario === undefined ||
  !selection.scenarioIds.includes(scenarioId) ||
  scenario.modelRoutes.some(
    (routeId) => !modelRoutes.routeIds.includes(routeId),
  )
)
  throw new Error("integration.runner.model-routes");
const directory = join(candidateRoot, "candidates", pointer.bundleIdentity);
const evidence = JSON.parse(
  readFileSync(join(directory, "evidence.json"), "utf8"),
);
if (
  evidence.bundleIdentity !== pointer.bundleIdentity ||
  evidence.candidateRevision !== pointer.candidateRevision ||
  evidence.scenarioNetworkPolicy !== "offline-no-package-or-registry-download"
)
  throw new Error("integration.runner.candidate-evidence");
if (
  JSON.stringify(readdirSync(directory).sort()) !==
  JSON.stringify(["evidence.json", "files"])
)
  throw new Error("integration.runner.candidate-inventory");
const declared = [evidence.lockfile, ...evidence.artifacts];
if (
  JSON.stringify(readdirSync(join(directory, "files")).sort()) !==
  JSON.stringify(declared.map(({ fileName }) => fileName).sort())
)
  throw new Error("integration.runner.candidate-inventory");
for (const file of declared) {
  const path = join(directory, "files", file.fileName);
  const status = lstatSync(path);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.size !== file.bytes ||
    digest(readFileSync(path)) !== file.sha256
  )
    throw new Error("integration.runner.candidate-file");
}
const candidateInventorySha256 = compileCandidateInventory(evidence).sha256;
advancePtyFailurePhase("immutable-candidate");
const encodedImmutableCandidate = requiredEnvironment(
  "AGENTSCOPE_IMMUTABLE_CANDIDATE_AUTHORITY",
);
if (
  encodedImmutableCandidate.length > 4_096 ||
  !/^[A-Za-z0-9_-]+$/u.test(encodedImmutableCandidate)
)
  throw new Error("integration.runner.immutable-candidate");
const immutableCandidateRecord = decodeImmutableCandidateHandoff(
  encodedImmutableCandidate,
  {
    candidateBundleIdentity: evidence.bundleIdentity,
    candidateInventorySha256,
    candidateRoot,
    runId: requiredEnvironment("AGENTSCOPE_INTEGRATION_RUN_ID"),
    scenarioId,
  },
);
const immutableCandidate = createSelectedContainerImmutableCandidateAuthority(
  immutableCandidateRecord,
);
const headlessCapability = composeSelectedContainerHeadlessSupervisorCapability(
  headlessShutdownDeadline,
  immutableCandidate,
);

advancePtyFailurePhase("installed-cli");
const { receipt: ptyReceipt } = await runInstalledCliPtyProof({
  capability: headlessCapability,
  home,
  runId: requiredEnvironment("AGENTSCOPE_INTEGRATION_RUN_ID"),
  shutdownDeadline: headlessShutdownDeadline,
});
advancePtyFailurePhase("pty-receipt");
const installedCliPtyReceipt = compileInstalledCliPtyReceiptFromExecution({
  receipt: ptyReceipt,
  scenarioId,
  candidateBundleIdentity: evidence.bundleIdentity,
  candidateInventorySha256,
});
console.log(`AGENTSCOPE_PTY_RECEIPT=${installedCliPtyReceipt.encoded}`);
ptyFailureTerminal = true;
process.setUncaughtExceptionCaptureCallback(null);

for (const publicEndpoint of [
  "https://registry.npmjs.org/",
  "https://api.openai.com/",
]) {
  try {
    await fetch(publicEndpoint, { signal: AbortSignal.timeout(750) });
    throw new Error("integration.runner.public-egress");
  } catch (error) {
    if (error?.message === "integration.runner.public-egress") throw error;
  }
}
const cliArtifact = evidence.artifacts.find(
  ({ id }) => id === "agentscope-cli",
);
if (!cliArtifact) throw new Error("integration.runner.fixture-artifact");
let fixtureOutput;
let fixtureFailure;
try {
  const childEnvironment = Object.freeze({
    AGENTSCOPE_HOME: agentscopeHome,
    AGENTSCOPE_CANDIDATE_ROOT: candidateRoot,
    AGENTSCOPE_COLLECTOR_URL: requiredEnvironment("AGENTSCOPE_COLLECTOR_URL"),
    AGENTSCOPE_INGESTION_URL: requiredEnvironment("AGENTSCOPE_INGESTION_URL"),
    AGENTSCOPE_LEDGER: ledger,
    AGENTSCOPE_MODEL_SERVER_URL: requiredEnvironment(
      "AGENTSCOPE_MODEL_SERVER_URL",
    ),
    AGENTSCOPE_RETRIEVAL_URL: requiredEnvironment("AGENTSCOPE_RETRIEVAL_URL"),
    AGENTSCOPE_SCENARIO_ID: scenarioId,
    AGENTSCOPE_WORKTREE: worktree,
    HARNESS_HOME: harnessHome,
    HOME: home,
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    XDG_CONFIG_HOME: requiredEnvironment("XDG_CONFIG_HOME"),
    ...(process.env.AGENTSCOPE_INTEGRATION_TEST_MODE === undefined
      ? {}
      : {
          AGENTSCOPE_INTEGRATION_TEST_MODE:
            process.env.AGENTSCOPE_INTEGRATION_TEST_MODE,
        }),
  });
  const now = performance.now();
  const fixtureScript = "/opt/agentscope/platform-fixture.mjs";
  const fixtureArguments = [
    "--artifact",
    join(directory, "files", cliArtifact.fileName),
  ];
  const request = {
    runId: requiredEnvironment("AGENTSCOPE_INTEGRATION_RUN_ID"),
    executable:
      scenario.executionMode === "interactive"
        ? fixtureScript
        : process.execPath,
    arguments:
      scenario.executionMode === "interactive"
        ? fixtureArguments
        : [fixtureScript, ...fixtureArguments],
    cwd: "/opt/agentscope",
    environment: childEnvironment,
    stdin:
      scenario.executionMode === "interactive"
        ? new TextEncoder().encode("run\n")
        : new Uint8Array(),
    stdoutLimitBytes: 1024 * 1024,
    stderrLimitBytes: 1024 * 1024,
    monotonicStartupDeadlineMs: Math.min(
      now + 10_000,
      headlessShutdownDeadline - 5_000,
    ),
    monotonicExecutionDeadlineMs: headlessShutdownDeadline - 5_000,
    monotonicShutdownDeadlineMs: headlessShutdownDeadline,
    terminationGraceMs: 1_000,
  };
  request.requestFingerprint = fingerprintHeadlessRequest(request);
  const serializedProcessRequest = {
    runId: request.runId,
    executable: request.executable,
    arguments: request.arguments,
    cwd: request.cwd,
    environment: request.environment,
    stdinBase64: Buffer.from(request.stdin).toString("base64"),
    stdoutLimitBytes: request.stdoutLimitBytes,
    stderrLimitBytes: request.stderrLimitBytes,
    monotonicStartupDeadlineMs: request.monotonicStartupDeadlineMs,
    monotonicExecutionDeadlineMs: request.monotonicExecutionDeadlineMs,
    monotonicShutdownDeadlineMs: request.monotonicShutdownDeadlineMs,
    terminationGraceMs: request.terminationGraceMs,
  };
  if (scenario.executionMode === "interactive") {
    if (scenario.outputContract !== "semantic-pty")
      throw new Error("integration.runner.execution-mode");
    const interpreter = {
      path: process.execPath,
      sha256: rawSha256(readFileSync(process.execPath)),
    };
    const scriptSha256 = rawSha256(readFileSync(request.executable));
    const initialGeometry = { columns: 80, rows: 24 };
    const completion = { kind: "semantic-marker" };
    const interaction = {
      trigger: "semantic-ready",
      actions: [
        { action: "resize", geometry: { columns: 100, rows: 30 } },
        {
          action: "input",
          byteLength: 4,
          inputSha256: rawSha256(request.stdin),
        },
        { action: "eof" },
      ],
    };
    const receipt = await executeSelectedPtyProcess(headlessCapability, {
      completion,
      initialGeometry,
      interaction,
      interpreter,
      process: request,
      scriptSha256,
    });
    const returnedAtMs = performance.now();
    const processAuthority = {
      runId: serializedProcessRequest.runId,
      requestFingerprint: receipt.processRequestFingerprint,
      executable: serializedProcessRequest.executable,
      arguments: serializedProcessRequest.arguments,
      cwd: serializedProcessRequest.cwd,
      environment: serializedProcessRequest.environment,
      inputBytes: receipt.inputBytes,
      inputSha256: receipt.inputSha256,
      stdoutLimitBytes: serializedProcessRequest.stdoutLimitBytes,
      stderrLimitBytes: serializedProcessRequest.stderrLimitBytes,
      monotonicStartupDeadlineMs:
        serializedProcessRequest.monotonicStartupDeadlineMs,
      monotonicExecutionDeadlineMs:
        serializedProcessRequest.monotonicExecutionDeadlineMs,
      monotonicShutdownDeadlineMs:
        serializedProcessRequest.monotonicShutdownDeadlineMs,
      terminationGraceMs: serializedProcessRequest.terminationGraceMs,
    };
    const ptyAuthority = {
      processRequestFingerprint: processAuthority.requestFingerprint,
      completion,
      initialGeometry,
      interaction,
      interpreter,
      scriptSha256,
      inputBytes: processAuthority.inputBytes,
      inputSha256: processAuthority.inputSha256,
    };
    if (
      receipt.requestFingerprint !==
      fingerprintSelectedPtyAuthority(ptyAuthority)
    )
      throw new Error("integration.runner.pty-authority");
    const ptyTerminalReceipt = {
      receiptVersion: 1,
      transport: "pty",
      scenarioId,
      runId: receipt.runId,
      requestFingerprint: receipt.requestFingerprint,
      processRequestFingerprint: receipt.processRequestFingerprint,
      processStartIdentity: receipt.processStartIdentity,
      inputBytes: receipt.inputBytes,
      inputSha256: receipt.inputSha256,
      readinessObserved: receipt.readinessObserved,
      actions: receipt.actions,
      outerMonotonicDeadlineMs: headlessOuterDeadline,
      requestConstructedAtMs: now,
      translationBootAtMs: headlessTranslationBootAt,
      translationLocalAtMs: headlessTranslationLocalAt,
      request: {
        process: processAuthority,
        completion,
        initialGeometry,
        interaction,
        interpreter,
        scriptSha256,
      },
      returnedAtMs,
      isTTY: receipt.isTTY,
      observedGeometry: receipt.observedGeometry,
      observedCanonicalMode: receipt.observedCanonicalMode,
      eofByte: receipt.eofByte,
      eofByteWritten: receipt.eofByteWritten,
      inputBytesWritten: receipt.inputBytesWritten,
      outcome: receipt.outcome,
      outputBytes: receipt.outputBytes,
      outputSha256: receipt.outputSha256,
      finalSnapshot: receipt.finalSnapshot,
      exitCode: receipt.exitCode,
      signal: receipt.signal,
      cleanup: receipt.cleanup,
      residualProcessCount: receipt.residualProcessCount,
      processJoined: receipt.processJoined,
      terminalInputJoined: receipt.terminalInputJoined,
      terminalOutputJoined: receipt.terminalOutputJoined,
      terminalTransportClosed: receipt.terminalTransportClosed,
    };
    console.log(
      `AGENTSCOPE_INTERACTIVE_PTY_RECEIPT=${Buffer.from(JSON.stringify(ptyTerminalReceipt)).toString("base64url")}`,
    );
    const fixtureResultPath = join(ledger, "fixture-result.json");
    const fixtureResultStatus = lstatSync(fixtureResultPath);
    if (
      !fixtureResultStatus.isFile() ||
      fixtureResultStatus.isSymbolicLink() ||
      fixtureResultStatus.size < 1 ||
      fixtureResultStatus.size > 1024 * 1024 ||
      (fixtureResultStatus.mode & 0o777) !== 0o600
    )
      throw new Error("integration.runner.fixture-result");
    const retained = JSON.parse(readFileSync(fixtureResultPath, "utf8"));
    if (
      JSON.stringify(Object.keys(retained).sort()) !==
        JSON.stringify(["encodedEvidence", "evidenceVersion", "scenarioId"]) ||
      retained.evidenceVersion !== 1 ||
      retained.scenarioId !== scenarioId ||
      typeof retained.encodedEvidence !== "string" ||
      retained.encodedEvidence.length > 1024 * 1024 ||
      !/^[A-Za-z0-9_-]+$/u.test(retained.encodedEvidence)
    )
      throw new Error("integration.runner.fixture-result");
    fixtureOutput = `AGENTSCOPE_FIXTURE_RESULT=${retained.encodedEvidence}\n`;
    if (
      receipt.outcome !== "completed" ||
      receipt.finalSnapshot.semanticState !== "completed" ||
      receipt.cleanup !== "clean" ||
      receipt.residualProcessCount !== 0 ||
      !receipt.processJoined ||
      !receipt.terminalInputJoined ||
      !receipt.terminalOutputJoined ||
      !receipt.terminalTransportClosed
    )
      fixtureFailure = new Error("integration.runner.fixture-failed");
  } else {
    if (
      scenario.executionMode !== "headless" ||
      scenario.outputContract !== "jsonl"
    )
      throw new Error("integration.runner.execution-mode");
    const trace = await executeSelectedHeadlessProcess(
      headlessCapability,
      request,
    );
    fixtureOutput = new TextDecoder("utf-8", { fatal: true }).decode(
      trace.result.stdout,
    );
    const headlessReceipt = {
      receiptVersion: 1,
      runId: trace.runId,
      requestFingerprint: trace.requestFingerprint,
      outerMonotonicDeadlineMs: headlessOuterDeadline,
      requestConstructedAtMs: now,
      translationBootAtMs: headlessTranslationBootAt,
      translationLocalAtMs: headlessTranslationLocalAt,
      request: serializedProcessRequest,
      returnedAtMs: trace.returnedAtMs,
      outcome: trace.result.outcome,
      exitCode: trace.result.exitCode,
      signal: trace.result.signal,
      cleanup: trace.result.cleanup,
      residualProcessCount: trace.result.residualProcessCount,
      processJoined: trace.observation.processJoined,
      stdinJoined: trace.observation.stdinJoined,
      stdoutJoined: trace.observation.stdoutJoined,
      stderrJoined: trace.observation.stderrJoined,
    };
    console.log(
      `AGENTSCOPE_HEADLESS_RECEIPT=${Buffer.from(JSON.stringify(headlessReceipt)).toString("base64url")}`,
    );
    if (
      trace.result.outcome !== "exited" ||
      trace.result.exitCode !== 0 ||
      trace.result.cleanup !== "clean"
    )
      fixtureFailure = new Error("integration.runner.fixture-failed");
  }
} catch (error) {
  if (scenario.executionMode === "interactive") {
    const diagnostic = `${error?.message ?? ""}`.match(
      /\b(?:integration|testkit)\.[a-z0-9.-]{1,128}\b/u,
    )?.[0];
    process.stderr.write(
      `integration.runner.interactive-diagnostic:${diagnostic ?? "integration.runner.fixture-failed"}\n`,
    );
  }
  fixtureOutput = "";
  fixtureFailure = error;
}
const fixtureResult = fixtureOutput
  .split("\n")
  .filter((line) => line.startsWith("AGENTSCOPE_FIXTURE_RESULT="))
  .at(-1);
if (!fixtureResult) throw new Error("integration.runner.fixture-result");
console.log(fixtureResult);
if (fixtureFailure !== undefined)
  throw new Error("integration.runner.fixture-failed");

if (process.env.AGENTSCOPE_INTEGRATION_TEST_MODE === "failure")
  throw new Error("integration.runner.expected-failure");
if (process.env.AGENTSCOPE_INTEGRATION_TEST_MODE === "interruption")
  await new Promise(() => setInterval(() => {}, 1_000));
writeFileSync(join(ledger, "scenario.json"), '{"status":"passed"}\n');
console.log("Integration scenario passed with public egress denied.");
