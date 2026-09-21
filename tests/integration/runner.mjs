import { createHash, randomBytes } from "node:crypto";
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
  decodeImmutableCandidateHandoff,
  encodeInteractiveFailureExitCode,
} from "./immutable-candidate-authority.mjs";
import { compileInteractivePtyActions } from "./dist/interactive-pty-actions.js";
import { readRetainedFixtureOutput } from "./retained-fixture-result.mjs";
import { parseSubstrateCertificationCaseValue } from "./substrate-certification.js";

const substrateCertificationCase = parseSubstrateCertificationCaseValue(
  process.env.AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE,
);

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
  "tui-start",
  "tui-run-created",
  "tui-readiness-challenge-published",
  "tui-checkpoint",
  "model-gate-arm-start",
  "tui-exit-before-arm",
  "model-gate-arm-complete",
  "model-request-observed",
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
]);
const retainedInteractivePhase = (ledger) => {
  let retained;
  for (const phase of interactivePhases) {
    const path = join(ledger, `interactive-phase-${phase}.txt`);
    try {
      const status = lstatSync(path);
      const content = readFileSync(path, "utf8");
      if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.size !== Buffer.byteLength(content) ||
        content !== `integration.fixture.codex-${phase}\n`
      )
        throw new Error("integration.runner.interactive-phase");
      retained = content.trim();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return retained;
};
const decodeScenarioFailureExitCode = (exitCode) => {
  if (!Number.isSafeInteger(exitCode)) return undefined;
  const phase = interactivePhases[exitCode - 64];
  return phase === undefined ? undefined : `integration.fixture.codex-${phase}`;
};

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
// eslint-disable-next-line complexity -- closed manifest-to-kernel readiness mapping
const compileNativeReadiness = (scenario, challenge) => {
  const readiness = scenario.nativeReadiness;
  if (
    readiness?.kind === "challenge-process-topology" &&
    scenario.harnessEvidenceId === "codex-0-149-1" &&
    JSON.stringify(Object.keys(readiness).sort()) ===
      JSON.stringify(["kind"]) &&
    typeof challenge === "string" &&
    /^[a-f0-9]{64}$/u.test(challenge)
  )
    return Object.freeze({ kind: "challenge-process-topology", challenge });
  if (
    readiness?.kind === "challenge-marker" &&
    scenario.harnessEvidenceId === "codex-0-149-1" &&
    JSON.stringify(Object.keys(readiness).sort()) ===
      JSON.stringify(["kind"]) &&
    typeof challenge === "string" &&
    /^[a-f0-9]{64}$/u.test(challenge)
  )
    return Object.freeze({ kind: "challenge-marker", challenge });
  if (
    readiness?.kind === "codex-challenge-idle-prompt" &&
    scenario.harnessEvidenceId === "codex-0-149-1" &&
    typeof challenge === "string" &&
    /^[a-f0-9]{64}$/u.test(challenge) &&
    readiness.harness === "codex" &&
    readiness.exactHarnessVersion === "0.149.1" &&
    readiness.text === "›" &&
    readiness.bold === true &&
    readiness.dim === false
  )
    return Object.freeze({
      kind: "challenge-styled-text",
      challenge,
      text: "›",
      requiredText: "Ask Codex to do anything",
      requiredTerminalProtocol: "csi-u-flags-7-query-v1",
      bold: true,
      dim: false,
    });
  if (
    readiness?.kind === "semantic-marker" &&
    JSON.stringify(Object.keys(readiness).sort()) === JSON.stringify(["kind"])
  )
    return Object.freeze({ kind: "semantic-marker" });
  if (
    readiness?.kind === "codex-idle-prompt" &&
    scenario.harnessEvidenceId === "codex-0-149-1" &&
    JSON.stringify(Object.keys(readiness).sort()) ===
      JSON.stringify([
        "bold",
        "dim",
        "exactHarnessVersion",
        "harness",
        "kind",
        "text",
      ]) &&
    readiness.harness === "codex" &&
    readiness.exactHarnessVersion === "0.149.1" &&
    readiness.text === "›" &&
    readiness.bold === true &&
    readiness.dim === false
  )
    return Object.freeze({
      kind: "styled-text-after-completion",
      text: "›",
      bold: true,
      dim: false,
    });
  throw new Error("integration.runner.native-readiness");
};
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
let interactiveFailureDiagnostic;
const recoverRetainedFixtureOutput = () =>
  readRetainedFixtureOutput(join(ledger, "fixture-result.json"), scenarioId);
try {
  const childEnvironment = Object.freeze({
    AGENTSCOPE_HOME: agentscopeHome,
    AGENTSCOPE_CANDIDATE_ROOT: candidateRoot,
    AGENTSCOPE_COLLECTOR_URL: requiredEnvironment("AGENTSCOPE_COLLECTOR_URL"),
    AGENTSCOPE_INGESTION_URL: requiredEnvironment("AGENTSCOPE_INGESTION_URL"),
    AGENTSCOPE_INTEGRATION_RUN_ID: requiredEnvironment(
      "AGENTSCOPE_INTEGRATION_RUN_ID",
    ),
    AGENTSCOPE_LEDGER: ledger,
    AGENTSCOPE_MODEL_SERVER_URL: requiredEnvironment(
      "AGENTSCOPE_MODEL_SERVER_URL",
    ),
    AGENTSCOPE_RETRIEVAL_URL: requiredEnvironment("AGENTSCOPE_RETRIEVAL_URL"),
    AGENTSCOPE_SCENARIO_ID: scenarioId,
    AGENTSCOPE_SCENARIO_BOOT_DEADLINE_MS: String(headlessOuterDeadline - 5_000),
    AGENTSCOPE_WORKTREE: worktree,
    HARNESS_HOME: harnessHome,
    HOME: home,
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    PATH:
      manifest.evidence.find(
        ({ evidenceId }) => evidenceId === scenario.harnessEvidenceId,
      )?.material.kind === "npm"
        ? "/opt/agentscope/harness/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"
        : "/usr/local/bin:/usr/bin:/bin",
    XDG_CONFIG_HOME: requiredEnvironment("XDG_CONFIG_HOME"),
    ...(scenario.executionMode === "interactive"
      ? { TERM: "xterm-256color" }
      : {}),
    ...(process.env.AGENTSCOPE_INTEGRATION_TEST_MODE === undefined
      ? {}
      : {
          AGENTSCOPE_INTEGRATION_TEST_MODE:
            process.env.AGENTSCOPE_INTEGRATION_TEST_MODE,
        }),
    ...(substrateCertificationCase === undefined
      ? {}
      : {
          AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE: substrateCertificationCase,
        }),
  });
  const now = performance.now();
  const fixtureScript = "/opt/agentscope/scenario-process.mjs";
  const scenarioProcessSha256 = rawSha256(readFileSync(fixtureScript));
  if (scenarioProcessSha256 !== scenario.scenarioProcess.sha256)
    throw new Error("integration.runner.fixture-artifact");
  const selectedArtifact =
    substrateCertificationCase === "mixed-artifact-digest"
      ? evidence.lockfile
      : cliArtifact;
  const fixtureArguments = [
    "--artifact",
    join(directory, "files", selectedArtifact.fileName),
  ];
  const readinessChallenge =
    scenario.executionMode === "interactive" &&
    (scenario.nativeReadiness?.kind === "challenge-process-topology" ||
      scenario.nativeReadiness?.kind === "challenge-marker" ||
      scenario.nativeReadiness?.kind === "codex-challenge-idle-prompt")
      ? randomBytes(32).toString("hex")
      : undefined;
  const terminalInput = Buffer.from(scenario.terminalInputBase64, "base64");
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
    cwd:
      substrateCertificationCase === "wrong-cwd" ? "/tmp" : "/opt/agentscope",
    environment:
      substrateCertificationCase === "wrong-environment"
        ? Object.freeze({ ...childEnvironment, AGENTSCOPE_UNEXPECTED: "1" })
        : childEnvironment,
    stdin:
      scenario.executionMode === "interactive"
        ? new Uint8Array(
            readinessChallenge === undefined
              ? terminalInput
              : Buffer.concat([
                  Buffer.from(`${readinessChallenge}\n`),
                  terminalInput,
                ]),
          )
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
  if (substrateCertificationCase === "wrong-argv")
    request.arguments = [...request.arguments, "--unexpected"];
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
    const scriptSha256 = scenarioProcessSha256;
    const initialGeometry = { columns: 80, rows: 24 };
    const completion = { kind: "semantic-marker" };
    const readiness = compileNativeReadiness(scenario, readinessChallenge);
    const interaction = {
      actions: compileInteractivePtyActions(scenario, request.stdin),
      trigger:
        readiness.kind === "challenge-process-topology" ||
        readiness.kind === "challenge-marker" ||
        readiness.kind === "challenge-styled-text"
          ? "immediate"
          : "semantic-ready",
    };
    const receipt = await executeSelectedPtyProcess(headlessCapability, {
      completion,
      readiness,
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
      readiness,
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
        readiness,
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
    fixtureOutput = recoverRetainedFixtureOutput();
    if (
      receipt.outcome !== "completed" ||
      receipt.finalSnapshot.semanticState !== "completed" ||
      receipt.cleanup !== "clean" ||
      receipt.residualProcessCount !== 0 ||
      !receipt.processJoined ||
      !receipt.terminalInputJoined ||
      !receipt.terminalOutputJoined ||
      !receipt.terminalTransportClosed
    ) {
      const diagnostic =
        decodeScenarioFailureExitCode(receipt.exitCode) ??
        retainedInteractivePhase(ledger);
      interactiveFailureDiagnostic = diagnostic;
      if (diagnostic !== undefined)
        process.stdout.write(
          `integration.runner.interactive-diagnostic:${diagnostic}\n`,
        );
      fixtureFailure = new Error("integration.runner.fixture-failed");
    }
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
      termRequested: trace.result.termRequested,
      killRequested: trace.result.killRequested,
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
      trace.result.cleanup !== "clean" ||
      trace.result.termRequested ||
      trace.result.killRequested
    )
      fixtureFailure = new Error("integration.runner.fixture-failed");
  }
} catch (error) {
  if (scenario.executionMode === "interactive") {
    let diagnostic = `${error?.message ?? ""}`.match(
      /\b(?:integration|testkit)\.[a-z0-9.-]{1,128}\b/u,
    )?.[0];
    const failurePath = join(ledger, "interactive-failure.txt");
    try {
      const status = lstatSync(failurePath);
      const content = readFileSync(failurePath, "utf8");
      if (
        status.isFile() &&
        !status.isSymbolicLink() &&
        status.size === Buffer.byteLength(content) &&
        /^integration\.fixture\.[a-z0-9-]{1,96}\n$/u.test(content)
      )
        diagnostic = content.trim();
    } catch {
      // The selected PTY error remains the diagnostic if no fixture record exists.
    }
    diagnostic = retainedInteractivePhase(ledger) ?? diagnostic;
    interactiveFailureDiagnostic = diagnostic;
    process.stdout.write(
      `integration.runner.interactive-diagnostic:${diagnostic ?? "integration.runner.fixture-failed"}\n`,
    );
  }
  if (
    scenario.executionMode === "headless" &&
    substrateCertificationCase === "leaked-child"
  ) {
    try {
      fixtureOutput = recoverRetainedFixtureOutput();
    } catch {
      fixtureOutput = "";
    }
  } else fixtureOutput = "";
  fixtureFailure = error;
}
const fixtureResult = fixtureOutput
  .split("\n")
  .filter((line) => line.startsWith("AGENTSCOPE_FIXTURE_RESULT="))
  .at(-1);
const interactiveFailureExitCode =
  scenario.executionMode === "interactive" && fixtureFailure !== undefined
    ? encodeInteractiveFailureExitCode(interactiveFailureDiagnostic)
    : undefined;
if (!fixtureResult && interactiveFailureExitCode === undefined)
  throw new Error("integration.runner.fixture-result");
if (fixtureResult) console.log(fixtureResult);
if (fixtureFailure !== undefined) {
  if (interactiveFailureExitCode === undefined)
    throw new Error("integration.runner.fixture-failed");
  process.exitCode = interactiveFailureExitCode;
} else {
  if (process.env.AGENTSCOPE_INTEGRATION_TEST_MODE === "failure")
    throw new Error("integration.runner.expected-failure");
  if (process.env.AGENTSCOPE_INTEGRATION_TEST_MODE === "interruption")
    await new Promise(() => setInterval(() => {}, 1_000));
  writeFileSync(join(ledger, "scenario.json"), '{"status":"passed"}\n');
  console.log("Integration scenario passed with public egress denied.");
}
