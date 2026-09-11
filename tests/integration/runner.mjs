import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { executeSelectedHeadlessProcess } from "./testkit/headless-supervisor-kernel.js";
import { HeadlessSupervisorError } from "./testkit/headless-supervisor.js";
import {
  composeSelectedContainerHeadlessSupervisorCapability,
  createSelectedContainerImmutableCandidateAuthority,
} from "./testkit/internal/headless-supervisor-backend.js";
import {
  compileCandidateInventory,
  compileInstalledContractFailureReceipt,
  compileInstalledPtyFailureReceipt,
  compileInstalledCliPtyReceiptFromExecution,
  decodeImmutableCandidateHandoff,
  digestInstalledContractWritableAuthority,
  installedContractFailurePredicates,
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
const writableAuthorityRoots = Object.freeze([
  home,
  harnessHome,
  agentscopeHome,
  worktree,
  ledger,
  "/tmp",
]);
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
const installedContractDriverPath =
  "/opt/agentscope/installed-contract-driver.mjs";
const installedContractDriverBytes = readFileSync(installedContractDriverPath);
if (
  installedContractDriverBytes.byteLength < 1 ||
  installedContractDriverBytes.byteLength > 128 * 1024 ||
  `sha256:${createHash("sha256")
    .update(installedContractDriverBytes)
    .digest("hex")}` !==
    requiredEnvironment("AGENTSCOPE_INSTALLED_CONTRACT_DRIVER_DIGEST")
)
  throw new Error("integration.runner.installed-contract-driver");
const installedContractOracle =
  await import("/opt/agentscope/installed-contract-driver.mjs");
const digest = (bytes) =>
  `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
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

const installedContractFailurePhases = Object.freeze([
  "artifact-install",
  "case-execution",
  "aggregate-evaluation",
  "receipt-finalization",
]);
let installedContractFailurePhase = installedContractFailurePhases[0];
let installedContractFailurePredicate = "egress-rejected";
let installedContractFailureCase;
let installedContractFailureTerminal = false;
let selectedHeadlessExecutionPending = false;
const setInstalledContractFailureBoundary = (phase, predicate, caseFailure) => {
  const current = installedContractFailurePhases.indexOf(
    installedContractFailurePhase,
  );
  const next = installedContractFailurePhases.indexOf(phase);
  if (
    next < current ||
    next > current + 1 ||
    !Object.hasOwn(installedContractFailurePredicates, phase) ||
    !installedContractFailurePredicates[phase].includes(predicate) ||
    (phase === "case-execution") !== (caseFailure !== undefined) ||
    (caseFailure !== undefined &&
      (!Number.isSafeInteger(caseFailure.caseOrdinal) ||
        caseFailure.caseOrdinal < 0 ||
        caseFailure.caseOrdinal >= caseFailure.caseCount ||
        !/^sha256:[a-f0-9]{64}$/u.test(caseFailure.caseIdsDigest)))
  )
    throw new Error("integration.runner.installed-contract-failure-phase");
  installedContractFailurePhase = phase;
  installedContractFailurePredicate = predicate;
  installedContractFailureCase = caseFailure;
};
const emitInstalledContractFailureReceipt = (error) => {
  if (installedContractFailureTerminal) return;
  installedContractFailureTerminal = true;
  if (selectedHeadlessExecutionPending) {
    if (
      !(error instanceof HeadlessSupervisorError) ||
      !installedContractFailurePredicates["case-execution"].includes(error.code)
    ) {
      process.exitCode = 1;
      return;
    }
    installedContractFailurePredicate = error.code;
  }
  const encoded = compileInstalledContractFailureReceipt({
    receiptVersion: 1,
    phase: installedContractFailurePhase,
    predicate: installedContractFailurePredicate,
    ...(installedContractFailureCase === undefined
      ? {}
      : {
          caseOrdinal: installedContractFailureCase.caseOrdinal,
          contractInventorySha256: installedContractFailureCase.caseIdsDigest,
        }),
  }).encoded;
  process.stdout.write(`AGENTSCOPE_INSTALLED_CONTRACT_FAILURE=${encoded}\n`);
  process.exitCode = 1;
};
if (process.hasUncaughtExceptionCaptureCallback())
  throw new Error("integration.runner.installed-contract-failure-capture");
process.setUncaughtExceptionCaptureCallback(
  emitInstalledContractFailureReceipt,
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
setInstalledContractFailureBoundary("artifact-install", "candidate-rejected");
const cliArtifact = evidence.artifacts.find(
  ({ id }) => id === "agentscope-cli",
);
if (!cliArtifact) throw new Error("integration.runner.fixture-artifact");

const installedContractReceipts = [];
const invokeSelected = async ({
  arguments: arguments_,
  caseId,
  cwd,
  environment,
  executable,
  executionTimeoutMilliseconds = 15_000,
  input = "",
  shutdownTimeoutMilliseconds = 20_000,
  contractCaseExecution = false,
  setupFailureCase,
}) => {
  if (setupFailureCase !== undefined)
    setInstalledContractFailureBoundary(
      "case-execution",
      "setup-deadline",
      setupFailureCase,
    );
  const constructedAtMs = performance.now();
  const monotonicShutdownDeadlineMs = Math.min(
    constructedAtMs + shutdownTimeoutMilliseconds,
    headlessShutdownDeadline,
  );
  const monotonicExecutionDeadlineMs = Math.min(
    constructedAtMs + executionTimeoutMilliseconds,
    monotonicShutdownDeadlineMs - 2_000,
  );
  const monotonicStartupDeadlineMs = Math.min(
    constructedAtMs + 5_000,
    monotonicExecutionDeadlineMs,
  );
  if (
    monotonicStartupDeadlineMs <= constructedAtMs ||
    monotonicExecutionDeadlineMs + 1_000 >= monotonicShutdownDeadlineMs
  )
    throw new Error("integration.runner.installed-contract-deadline");
  if (setupFailureCase !== undefined)
    setInstalledContractFailureBoundary(
      "case-execution",
      "setup-cwd-env-config",
      setupFailureCase,
    );
  const request = {
    runId: requiredEnvironment("AGENTSCOPE_INTEGRATION_RUN_ID"),
    executable,
    arguments: arguments_,
    cwd,
    environment,
    stdin: new TextEncoder().encode(input),
    stdoutLimitBytes: 64 * 1024,
    stderrLimitBytes: 64 * 1024,
    monotonicStartupDeadlineMs,
    monotonicExecutionDeadlineMs,
    monotonicShutdownDeadlineMs,
    terminationGraceMs: 1_000,
  };
  request.requestFingerprint = fingerprintHeadlessRequest(request);
  if (setupFailureCase !== undefined)
    setInstalledContractFailureBoundary(
      "case-execution",
      "setup-candidate-bin-identity",
      setupFailureCase,
    );
  if (contractCaseExecution) selectedHeadlessExecutionPending = true;
  const trace = await executeSelectedHeadlessProcess(
    headlessCapability,
    request,
  );
  if (contractCaseExecution) selectedHeadlessExecutionPending = false;
  const receipt = {
    caseId,
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
  installedContractReceipts.push(receipt);
  if (
    trace.result.cleanup !== "clean" ||
    trace.result.residualProcessCount !== 0 ||
    !trace.observation.processJoined ||
    !trace.observation.stdinJoined ||
    !trace.observation.stdoutJoined ||
    !trace.observation.stderrJoined
  )
    throw new Error("integration.runner.installed-contract-containment");
  const decode = (bytes) =>
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return Object.freeze({
    outcome: trace.result.outcome,
    signal: trace.result.signal,
    status: trace.result.exitCode,
    stderr: decode(trace.result.stderr),
    stdout: decode(trace.result.stdout),
  });
};
const invokeSelectedNarrowPty = async ({ caseId, home }) => {
  const { receipt } = await runInstalledCliPtyProof({
    capability: headlessCapability,
    home,
    proof: "narrow-help",
    runId: requiredEnvironment("AGENTSCOPE_INTEGRATION_RUN_ID"),
    shutdownDeadline: headlessShutdownDeadline,
  });
  installedContractReceipts.push({
    caseId,
    outcome: "exited",
    exitCode: receipt.exitCode,
    signal: receipt.signal,
    cleanup: receipt.cleanup,
    residualProcessCount: receipt.residualProcessCount,
    processJoined: receipt.processJoined,
    stdinJoined: receipt.terminalInputJoined,
    stdoutJoined: receipt.terminalOutputJoined,
    stderrJoined: receipt.terminalTransportClosed,
  });
  return Object.freeze({
    outcome: "exited",
    signal: receipt.signal,
    status: receipt.exitCode,
    stderr: "",
    stdout: "",
    pty: Object.freeze({
      cleanup: receipt.cleanup,
      initialGeometry: receipt.initialGeometry,
      isTTY: receipt.isTTY,
      observedGeometry: receipt.observedGeometry,
      outputBytes: receipt.outputBytes,
      outputSha256: `sha256:${receipt.outputSha256}`,
      processJoined: receipt.processJoined,
      residualProcessCount: receipt.residualProcessCount,
      terminalInputJoined: receipt.terminalInputJoined,
      terminalOutputJoined: receipt.terminalOutputJoined,
      terminalTransportClosed: receipt.terminalTransportClosed,
    }),
  });
};

const contractRoot = "/tmp/agentscope-installed-contract";
setInstalledContractFailureBoundary("artifact-install", "install-rejected");
rmSync(contractRoot, { force: true, recursive: true });
mkdirSync(contractRoot, { mode: 0o700 });
const installRoot = join(contractRoot, "install");
const installHome = join(contractRoot, "install-home");
mkdirSync(installRoot);
mkdirSync(installHome);
writeFileSync(join(installRoot, "package.json"), '{"private":true}\n');
writeFileSync(join(installHome, "empty-npmrc"), "");
const candidateTarball = join(directory, "files", cliArtifact.fileName);
const npmCli = "/usr/local/lib/node_modules/npm/bin/npm-cli.js";
setInstalledContractFailureBoundary("artifact-install", "toolchain-rejected");
const npmCliStatus = lstatSync(npmCli);
if (!npmCliStatus.isFile() || npmCliStatus.isSymbolicLink())
  throw new Error("integration.runner.installed-contract-toolchain");
setInstalledContractFailureBoundary("artifact-install", "install-rejected");
const npmResult = await invokeSelected({
  arguments: [
    npmCli,
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--offline",
    candidateTarball,
  ],
  caseId: "artifact.install",
  cwd: installRoot,
  environment: Object.freeze({
    HOME: installHome,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    USERPROFILE: installHome,
    NPM_CONFIG_CACHE: join(installHome, "npm-cache"),
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_USERCONFIG: join(installHome, "empty-npmrc"),
  }),
  executable: process.execPath,
});
if (npmResult.status !== 0 || npmResult.signal !== null)
  throw new Error("integration.runner.installed-contract-install");
const runtimeInstalledPackageRoot = join(
  installRoot,
  "node_modules/agentscope-cli",
);
setInstalledContractFailureBoundary("artifact-install", "manifest-rejected");
const runtimeInstalledManifest = JSON.parse(
  readFileSync(join(runtimeInstalledPackageRoot, "package.json"), "utf8"),
);
const installedPackageRoot =
  "/opt/agentscope/installed/node_modules/agentscope-cli";
const installedManifest = JSON.parse(
  readFileSync(join(installedPackageRoot, "package.json"), "utf8"),
);
if (
  JSON.stringify(runtimeInstalledManifest) !== JSON.stringify(installedManifest)
)
  throw new Error("integration.runner.installed-contract-install");
const installedExecutable =
  "/opt/agentscope/installed/node_modules/.bin/agentscope";
setInstalledContractFailureBoundary("artifact-install", "plan-rejected");
const contractPlan = installedContractOracle.createInstalledCliContractPlan(
  installedManifest.version,
  {
    architecture: process.arch,
    modules: process.versions.modules,
    platform: process.platform,
  },
);
const contractObservations = [];
const selectedInvocationFor = (contractStep, caseRoot) => {
  if (contractStep.executionMode === "direct")
    return {
      arguments: contractStep.args,
      executable: installedExecutable,
      input: contractStep.input,
    };
  if (contractStep.executionMode === "stdout-closed")
    return {
      arguments: [
        "-c",
        'exec 1>&-; exec "$@"',
        "agentscope-broken-pipe",
        installedExecutable,
        ...contractStep.args,
      ],
      executable: "/bin/sh",
    };
  if (
    contractStep.executionMode === "signal-int" ||
    contractStep.executionMode === "signal-term"
  )
    return {
      arguments: [
        "-c",
        'signal="$1"; cli="$2"; fifo="$3"; shift 3; /usr/bin/mkfifo "$fifo"; /usr/bin/tail -f /dev/null >"$fifo" & feeder=$!; "$cli" "$@" <"$fifo" >/dev/null 2>/dev/null & target=$!; /usr/bin/sleep 0.1; kill "-$signal" "$target"; wait "$target"; result=$?; kill -TERM "$feeder" 2>/dev/null; wait "$feeder" 2>/dev/null; /bin/rm -f "$fifo"; exit "$result"',
        "agentscope-signal",
        contractStep.executionMode === "signal-int" ? "INT" : "TERM",
        installedExecutable,
        join(caseRoot, "input.pipe"),
        ...contractStep.args,
      ],
      executable: "/bin/sh",
    };
  return {
    arguments: [
      "-c",
      'trap "" TERM; cli="$1"; shift; "$cli" "$@" >/dev/null 2>/dev/null; /usr/bin/sleep 60 & wait',
      "agentscope-deadline-child",
      installedExecutable,
      ...contractStep.args,
    ],
    executable: "/bin/sh",
    executionTimeoutMilliseconds: 250,
    shutdownTimeoutMilliseconds: 5_000,
  };
};
const contractFailureCase = (caseOrdinal) =>
  Object.freeze({
    caseCount: contractPlan.cases.length,
    caseIdsDigest: contractPlan.caseIdsDigest,
    caseOrdinal,
  });
const setupDescriptorErrorCodes = new Set([
  "EACCES",
  "EBADF",
  "EMFILE",
  "ENFILE",
  "EPERM",
]);
const performInstalledContractSetupOperation = (
  predicate,
  caseFailure,
  operation,
) => {
  setInstalledContractFailureBoundary("case-execution", predicate, caseFailure);
  try {
    return operation();
  } catch (error) {
    if (setupDescriptorErrorCodes.has(error?.code))
      setInstalledContractFailureBoundary(
        "case-execution",
        "setup-descriptor-permission",
        caseFailure,
      );
    throw error;
  }
};
setInstalledContractFailureBoundary(
  "case-execution",
  "setup-workspace-root-authority",
  contractFailureCase(0),
);
// The offline install above is an authentication probe, not case state. npm
// necessarily creates a node_modules/.bin symlink for the CLI. Remove the
// completed probe before taking the complete writable-root snapshot so the
// authority never has to admit a mutable symlink outside the case root.
rmSync(installRoot, { force: true, recursive: true });
rmSync(installHome, { force: true, recursive: true });
for (let caseIndex = 0; caseIndex < contractPlan.cases.length; caseIndex += 1) {
  const caseFailure = contractFailureCase(caseIndex);
  setInstalledContractFailureBoundary(
    "case-execution",
    "setup-workspace-root-authority",
    caseFailure,
  );
  const contractCase = contractPlan.cases[caseIndex];
  const caseRoot = join(contractRoot, "cases", String(caseIndex));
  const caseHome = join(caseRoot, "user home with spaces — 测试");
  const caseCwd = join(caseRoot, "workspace with spaces — café");
  const temporary = join(caseRoot, "temporary files");
  performInstalledContractSetupOperation(
    "setup-fixture-input-creation",
    caseFailure,
    () => {
      mkdirSync(caseHome, { recursive: true });
      mkdirSync(caseCwd);
      mkdirSync(temporary);
    },
  );
  const externalWritableAuthority = {
    excludedPaths: [caseRoot],
    roots: writableAuthorityRoots,
  };
  setInstalledContractFailureBoundary(
    "case-execution",
    "setup-cwd-env-config",
    caseFailure,
  );
  const caseEnvironment = Object.freeze({
    COLUMNS: "7",
    HOME: caseHome,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    PATH: "/usr/local/bin",
    ROWS: "4",
    TMPDIR: temporary,
    USERPROFILE: caseHome,
  });
  let setupResult;
  const externalBeforeSetup = performInstalledContractSetupOperation(
    "setup-workspace-root-authority",
    caseFailure,
    () => digestInstalledContractWritableAuthority(externalWritableAuthority),
  );
  if (contractCase.setup === "initialized") {
    setupResult = await invokeSelected({
      arguments: ["init", "--yes", "--output", "json"],
      caseId: `${contractCase.caseId}.setup`,
      contractCaseExecution: true,
      cwd: caseCwd,
      environment: caseEnvironment,
      executable: installedExecutable,
      setupFailureCase: caseFailure,
    });
  } else if (contractCase.setup === "invalid-configuration") {
    performInstalledContractSetupOperation(
      "setup-fixture-input-creation",
      caseFailure,
      () => {
        mkdirSync(join(caseHome, ".agentscope"));
        writeFileSync(join(caseHome, ".agentscope/config.json"), "{invalid");
      },
    );
  }
  const externalAfterSetup = performInstalledContractSetupOperation(
    "setup-workspace-root-authority",
    caseFailure,
    () => digestInstalledContractWritableAuthority(externalWritableAuthority),
  );
  if (externalAfterSetup !== externalBeforeSetup)
    throw new Error("integration.runner.installed-contract-side-effect");
  const stateRoots = writableAuthorityRoots;
  const stateAuthority = { excludedPaths: [], roots: [caseRoot] };
  setInstalledContractFailureBoundary(
    "case-execution",
    "state-rejected",
    caseFailure,
  );
  const beforeStateDigest =
    digestInstalledContractWritableAuthority(stateAuthority);
  const results = [];
  const afterStateDigests = [];
  for (
    let stepIndex = 0;
    stepIndex < contractCase.steps.length;
    stepIndex += 1
  ) {
    const contractStep = contractCase.steps[stepIndex];
    const caseId = `${contractCase.caseId}.${stepIndex}`;
    const externalBeforeStep = digestInstalledContractWritableAuthority({
      excludedPaths: [caseRoot],
      roots: stateRoots,
    });
    if (contractStep.executionMode === "pty-narrow") {
      setInstalledContractFailureBoundary(
        "case-execution",
        "narrow-help-rejected",
        caseFailure,
      );
      results.push(await invokeSelectedNarrowPty({ caseId, home: caseHome }));
    } else {
      const selectedInvocation = selectedInvocationFor(contractStep, caseRoot);
      results.push(
        await invokeSelected({
          ...selectedInvocation,
          caseId,
          contractCaseExecution: true,
          cwd: caseCwd,
          environment: caseEnvironment,
        }),
      );
    }
    if (
      digestInstalledContractWritableAuthority({
        excludedPaths: [caseRoot],
        roots: stateRoots,
      }) !== externalBeforeStep
    )
      throw new Error("integration.runner.installed-contract-side-effect");
    setInstalledContractFailureBoundary(
      "case-execution",
      "state-rejected",
      caseFailure,
    );
    afterStateDigests.push(
      digestInstalledContractWritableAuthority(stateAuthority),
    );
  }
  contractObservations.push({
    afterStateDigests,
    beforeStateDigest,
    caseId: contractCase.caseId,
    results,
    ...(setupResult === undefined ? {} : { setupResult }),
  });
  rmSync(caseRoot, { force: true, recursive: true });
}
setInstalledContractFailureBoundary(
  "aggregate-evaluation",
  "aggregate-count-order-digest",
);
let installedContractEvidence;
try {
  installedContractEvidence =
    installedContractOracle.evaluateInstalledCliContract(
      contractPlan,
      {
        bin: installedManifest.bin,
        candidateDigest: `sha256:${createHash("sha256")
          .update(readFileSync(candidateTarball))
          .digest("hex")}`,
        executableRealPath: realpathSync(installedExecutable),
        installedPackageRootRealPath: realpathSync(installedPackageRoot),
        package: installedManifest.name,
        version: installedManifest.version,
      },
      contractObservations,
    );
} catch (error) {
  const reason =
    installedContractOracle.installedContractEvaluationFailureReason(error);
  if (
    typeof reason !== "string" ||
    !installedContractFailurePredicates["aggregate-evaluation"].includes(reason)
  ) {
    installedContractFailureTerminal = true;
    throw error;
  }
  setInstalledContractFailureBoundary("aggregate-evaluation", reason);
  throw error;
}
setInstalledContractFailureBoundary("receipt-finalization", "receipt-rejected");
const receiptCaseIds = installedContractReceipts.map(({ caseId }) => caseId);
if (
  new Set(receiptCaseIds).size !== receiptCaseIds.length ||
  JSON.stringify(receiptCaseIds) !== JSON.stringify(contractPlan.receiptCaseIds)
)
  throw new Error("integration.runner.installed-contract-receipt");
const installedContractAggregate = Object.freeze({
  aggregateVersion: 1,
  ...installedContractEvidence,
  driverDigest: requiredEnvironment(
    "AGENTSCOPE_INSTALLED_CONTRACT_DRIVER_DIGEST",
  ),
  receiptDigest: digest(JSON.stringify(installedContractReceipts)),
});
console.log(
  `AGENTSCOPE_INSTALLED_CONTRACT_EVIDENCE=${Buffer.from(
    JSON.stringify({
      aggregate: installedContractAggregate,
      receipts: installedContractReceipts,
    }),
  ).toString("base64url")}`,
);
installedContractFailureTerminal = true;
process.setUncaughtExceptionCaptureCallback(null);
rmSync(contractRoot, { force: true, recursive: true });
const admissionResponses = await Promise.all(
  [
    requiredEnvironment("AGENTSCOPE_MODEL_SERVER_URL"),
    requiredEnvironment("AGENTSCOPE_INGESTION_URL"),
    requiredEnvironment("AGENTSCOPE_RETRIEVAL_URL"),
  ].map((endpoint) =>
    fetch(`${endpoint}/agentscope/admit`, {
      headers: { connection: "close" },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(
        Math.max(1, Math.floor(headlessShutdownDeadline - performance.now())),
      ),
    }),
  ),
);
if (admissionResponses.some(({ status }) => status !== 204))
  throw new Error("integration.runner.egress-authority");
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
  const request = {
    runId: requiredEnvironment("AGENTSCOPE_INTEGRATION_RUN_ID"),
    executable: process.execPath,
    arguments: [
      "/opt/agentscope/platform-fixture.mjs",
      "--artifact",
      join(directory, "files", cliArtifact.fileName),
    ],
    cwd: "/opt/agentscope",
    environment: childEnvironment,
    stdin: new Uint8Array(),
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
    request: {
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
    },
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
} catch (error) {
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
