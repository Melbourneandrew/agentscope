import { createHash } from "node:crypto";

const fail = () => {
  throw new Error("integration.immutable-candidate.authority");
};
export const ptyExecutionFailurePredicates = Object.freeze([
  "child-failure",
  "integration.fixture.codex-bootstrap",
  "integration.fixture.codex-bootstrap-arguments",
  "integration.fixture.codex-bootstrap-artifact",
  "integration.fixture.codex-bootstrap-deadline",
  "integration.fixture.codex-bootstrap-environment",
  "integration.fixture.codex-bootstrap-modules",
  "integration.fixture.codex-bootstrap-pty",
  "integration.fixture.codex-bootstrap-readiness",
  "integration.fixture.codex-model-gate-start",
  "integration.fixture.codex-model-gate-configured",
  "integration.fixture.codex-control-plane-closed",
  "integration.fixture.codex-tui-run-created",
  "integration.fixture.codex-tui-readiness-challenge-published",
  "integration.fixture.codex-tui-checkpoint",
  "integration.fixture.codex-model-gate-arm-start",
  "integration.fixture.codex-model-gate-arm-health-pending",
  "integration.fixture.codex-model-gate-arm-session-start",
  "integration.fixture.codex-model-gate-arm-hook-log",
  "integration.fixture.codex-model-gate-arm-hook-mediation",
  "integration.fixture.codex-model-gate-arm-control",
  "integration.fixture.codex-model-gate-arm-session-start-missing",
  "integration.fixture.codex-tui-exit-before-arm",
  "integration.fixture.codex-model-gate-arm-complete",
  "integration.fixture.codex-model-request-observed",
  "integration.fixture.codex-destination",
  "integration.fixture.codex-install",
  "integration.fixture.codex-hook-command-spawn-error",
  "integration.fixture.codex-hook-command-stdin-error",
  "integration.fixture.codex-hook-command-timeout",
  "integration.fixture.codex-hook-command-wait-error",
  "integration.fixture.codex-hook-command-missing",
  "integration.fixture.codex-hook-command-completed-before-budget-boundary",
  "integration.fixture.codex-hook-command-completed-near-budget-boundary",
  "integration.fixture.codex-hook-no-operational-state-subsecond",
  "integration.fixture.codex-hook-no-operational-state-low-latency",
  "integration.fixture.codex-hook-no-operational-state-mid-latency",
  "integration.fixture.codex-hook-no-operational-state-high-latency",
  "integration.fixture.codex-hook-no-operational-state-near-deadline",
  "integration.fixture.codex-hook-start-suppressed",
  "integration.fixture.codex-hook-start-deadline",
  "integration.fixture.codex-hook-capture-suppressed",
  "integration.fixture.codex-hook-capture-deadline",
  "integration.fixture.codex-hook-redaction-suppressed",
  "integration.fixture.codex-hook-redaction-deadline",
  "integration.fixture.codex-hook-routing-no-route",
  "integration.fixture.codex-hook-delivery-rejected",
  "integration.fixture.codex-hook-delivery-unavailable",
  "integration.fixture.codex-hook-delivery-deadline",
  "integration.fixture.codex-hook-delivery-unknown",
  "integration.fixture.codex-hook-accepted-without-trace",
  "integration.fixture.codex-hook-operational-unclassified",
  "integration.fixture.codex-init",
  "integration.fixture.codex-routing",
  "integration.fixture.codex-model-request",
  "integration.fixture.codex-trace-search",
  "integration.fixture.codex-trace-search-ambiguous",
  "integration.fixture.codex-trace-search-harness",
  "integration.fixture.codex-trace-search-locator",
  "integration.fixture.codex-trace-search-record-count",
  "integration.fixture.codex-trace-search-shape",
  "integration.fixture.codex-trace-search-result",
  "integration.fixture.codex-trace-reporter-settled",
  "integration.fixture.codex-trace-settlement",
  "integration.fixture.codex-trace-terminal",
  "integration.fixture.codex-tui-exit-published",
  "integration.fixture.codex-tui-join-deadline",
  "integration.fixture.codex-tui-join-deadline-log-unavailable",
  "integration.fixture.codex-tui-join-deadline-hook-log-invalid",
  "integration.fixture.codex-tui-join-deadline-stop-unseen",
  "integration.fixture.codex-tui-join-deadline-stop-active",
  "integration.fixture.codex-tui-join-deadline-stop-completed",
  "integration.fixture.codex-tui-join-deadline-session-end-active",
  "integration.fixture.codex-tui-join-deadline-session-end-completed",
  "integration.fixture.codex-tui-child-rejected",
  "integration.fixture.codex-tui-joined",
  "integration.fixture.codex-tui-start",
  "integration.fixture.codex-verify",
  "integration.runner.fixture-failed",
  "integration.runner.fixture-result",
  "integration.runner.pty-authority",
  "testkit.headless.kernel.failure",
  "testkit.pty.geometry",
  "testkit.pty.immutable-candidate",
  "testkit.pty.receipt-completion-state",
  "testkit.pty.receipt-actions",
  "testkit.pty.receipt-cleanup",
  "testkit.pty.receipt-identity",
  "testkit.pty.receipt-input",
  "testkit.pty.receipt-outcome",
  "testkit.pty.receipt-output",
  "testkit.pty.receipt-output-state",
  "testkit.pty.receipt-readiness",
  "testkit.pty.receipt-signal",
  "testkit.pty.receipt-signal-identity",
  "testkit.pty.receipt-snapshot",
  "testkit.pty.receipt-terminal",
  "testkit.pty.receipt-terminal-action",
  "testkit.pty.receipt-terminal-status",
  "testkit.pty.request",
  "testkit.pty.runtime.identity",
  "testkit.pty.transport",
  "testkit.pty.transport.exit",
  "testkit.pty.transport.initialization",
  "testkit.pty.transport.semantic-credential-prompt",
  "testkit.pty.transport.semantic-incomplete",
  "testkit.pty.transport.semantic-malformed-control-limit",
  "testkit.pty.transport.semantic-malformed-csi-byte",
  "testkit.pty.transport.semantic-malformed-csi-parameters",
  "testkit.pty.transport.semantic-malformed-escape",
  "testkit.pty.transport.semantic-malformed-ground-control",
  "testkit.pty.transport.semantic-malformed-trailing-control",
  "testkit.pty.transport.semantic-malformed-unknown",
  "testkit.pty.transport.semantic-malformed-utf8",
  "testkit.pty.transport.semantic-missing-readiness",
  "testkit.pty.transport.semantic-missing-readiness-no-output",
  "testkit.pty.transport.semantic-missing-readiness-with-output",
  "testkit.pty.transport.semantic-nonzero",
  "testkit.pty.transport.semantic-unsupported-csi",
  "testkit.pty.transport.semantic-unsupported-extended-csi",
  "testkit.pty.transport.semantic-unsupported-osc",
  "testkit.pty.transport.semantic-unsupported-unknown",
]);

export const selectInteractiveFailureDiagnostic = (
  fixtureFailure,
  retainedPhase,
  selectedError,
) =>
  [fixtureFailure, retainedPhase, selectedError].find(
    (value) =>
      typeof value === "string" &&
      ptyExecutionFailurePredicates.includes(value) &&
      value !== "integration.fixture.codex-tui-join-deadline" &&
      value !== "integration.fixture.codex-tui-child-rejected",
  );
export const interactivePtyReceiptFailed = (receipt) =>
  receipt.outcome !== "completed" ||
  receipt.finalSnapshot.semanticState !== "completed" ||
  receipt.exitCode !== 0 ||
  receipt.signal !== null ||
  receipt.cleanup !== "clean" ||
  receipt.residualProcessCount !== 0 ||
  !receipt.processJoined ||
  !receipt.terminalInputJoined ||
  !receipt.terminalOutputJoined ||
  !receipt.terminalTransportClosed;

export const interactivePtyReceiptAuthorityMatches = (
  receipt,
  checks,
  failed = false,
) =>
  checks?.envelope === true &&
  checks.process === true &&
  checks.geometry === true &&
  checks.artifact === true &&
  checks.fingerprint === true &&
  (failed
    ? interactivePtyReceiptFailed(receipt)
    : receipt?.returnedAtMs <=
        receipt?.request?.process?.monotonicShutdownDeadlineMs &&
      receipt?.finalSnapshot?.semanticState === "completed");

export const interactivePtyEnvelopeDeadlineMatches = (
  observedDeadline,
  expectedDeadline,
  observationNow,
  failed = false,
) =>
  observedDeadline === expectedDeadline &&
  (failed || observationNow < expectedDeadline);

const interactivePtyEnvelopeFields = Object.freeze([
  "identity",
  "deadline",
  "completion",
  "readiness",
  "trigger",
  "requested-actions",
  "observed-actions",
  "terminal-action",
  "tty",
  "canonical-mode",
]);

export const interactivePtyEnvelopeRejectionCode = (predicates) => {
  for (const field of interactivePtyEnvelopeFields)
    if (predicates?.[field]?.() !== true) return field;
  return null;
};

export const interactivePtyObservedActionsMatch = (
  observedActions,
  expectedActions,
  failed = false,
) => {
  if (
    !Array.isArray(observedActions) ||
    !Array.isArray(expectedActions) ||
    observedActions.length > expectedActions.length ||
    (!failed && observedActions.length !== expectedActions.length) ||
    observedActions.some((entry) => typeof entry?.action !== "string") ||
    expectedActions.some((entry) => typeof entry?.action !== "string")
  )
    return false;
  return (
    JSON.stringify(observedActions.map(({ action }) => action)) ===
    JSON.stringify(
      expectedActions
        .slice(0, observedActions.length)
        .map(({ action }) => action),
    )
  );
};

export const interactivePtyArtifactReadinessMatches = (
  receipt,
  failed = false,
) =>
  receipt?.readinessObserved === true ||
  (failed &&
    receipt?.readinessObserved === false &&
    interactivePtyReceiptFailed(receipt));

const interactivePtyArtifactFields = Object.freeze([
  "process-fingerprint",
  "input-bytes",
  "input-digest",
  "readiness",
  "interpreter",
  "script-digest",
]);

export const interactivePtyArtifactRejectionCode = (predicates) => {
  for (const field of interactivePtyArtifactFields)
    if (predicates?.[field]?.() !== true) return field;
  return null;
};

// Failure-only diagnostics: never include receipt fields or terminal output.
export const interactivePtyReceiptRejectionCode = (
  receipt,
  checks,
  failed = false,
) => {
  for (const key of [
    "envelope",
    "process",
    "geometry",
    "artifact",
    "fingerprint",
  ])
    if (checks?.[key] !== true) return key;
  try {
    if (failed)
      return interactivePtyReceiptFailed(receipt) ? null : "terminal-state";
    return receipt?.returnedAtMs <=
      receipt?.request?.process?.monotonicShutdownDeadlineMs &&
      receipt?.finalSnapshot?.semanticState === "completed"
      ? null
      : "terminal-state";
  } catch {
    return "terminal-state";
  }
};
const plainRecord = (value) =>
  typeof value === "object" &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, expected) =>
  plainRecord(value) &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort());
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const installedPtyFailurePredicates = Object.freeze({
  "pty-receipt": Object.freeze([
    "cleanup",
    "completion-state",
    "eof-action",
    "exit-code",
    "fixture-result",
    "process-join",
    "receipt-rejected",
    "residual-process",
    "signal",
    "terminal-input-join",
    "terminal-output-join",
    "transport-close",
  ]),
  "pty-execution": ptyExecutionFailurePredicates,
});

const interactiveFixtureFailurePredicates = Object.freeze(
  ptyExecutionFailurePredicates.filter(
    (value) =>
      value.startsWith("integration.fixture.codex-") &&
      !value.startsWith("integration.fixture.codex-model-gate-arm-") &&
      !value.startsWith("integration.fixture.codex-tui-join-deadline-"),
  ),
);
const interactiveFailureExitCodeBase = 64;

const codexJoinDeadlineDiagnosticStates = Object.freeze([
  "log-unavailable",
  "hook-log-invalid",
  "stop-unseen",
  "stop-active",
  "stop-completed",
  "session-end-active",
  "session-end-completed",
]);
const codexJoinDeadlineExitCodeBase = 32;

export const encodeCodexJoinDeadlineExitCode = (state) => {
  const index = codexJoinDeadlineDiagnosticStates.indexOf(state);
  return index < 0 ? undefined : codexJoinDeadlineExitCodeBase + index;
};

export const decodeCodexJoinDeadlineExitCode = (exitCode) => {
  if (!Number.isSafeInteger(exitCode)) return undefined;
  const state =
    codexJoinDeadlineDiagnosticStates[exitCode - codexJoinDeadlineExitCodeBase];
  return state === undefined
    ? undefined
    : `integration.fixture.codex-tui-join-deadline-${state}`;
};

export const selectInteractiveExecutionFailurePredicate = (
  candidate,
  retainedDiagnostic,
  scenarioId,
) => {
  const diagnostic = retainedDiagnostic ?? candidate;
  if (typeof diagnostic !== "string") return "child-failure";
  if (
    diagnostic.startsWith("integration.fixture.codex-tui-join-deadline-") &&
    (scenarioId !== "codex-tui-trace-smoke" ||
      retainedDiagnostic !== diagnostic)
  )
    return "child-failure";
  return ptyExecutionFailurePredicates.includes(diagnostic)
    ? diagnostic
    : "child-failure";
};

export const encodeInteractiveFailureExitCode = (diagnostic, scenarioId) => {
  if (
    scenarioId === "codex-tui-trace-smoke" &&
    typeof diagnostic === "string"
  ) {
    const prefix = "integration.fixture.codex-tui-join-deadline-";
    if (diagnostic.startsWith(prefix))
      return encodeCodexJoinDeadlineExitCode(diagnostic.slice(prefix.length));
  }
  const index = interactiveFixtureFailurePredicates.indexOf(diagnostic);
  return index < 0 ? undefined : interactiveFailureExitCodeBase + index;
};

export const decodeInteractiveFailureExitCode = (exitCode, scenarioId) => {
  if (!Number.isSafeInteger(exitCode)) return undefined;
  if (scenarioId === "codex-tui-trace-smoke") {
    const joinDeadlineDiagnostic = decodeCodexJoinDeadlineExitCode(exitCode);
    if (joinDeadlineDiagnostic !== undefined) return joinDeadlineDiagnostic;
  }
  return interactiveFixtureFailurePredicates[
    exitCode - interactiveFailureExitCodeBase
  ];
};

export const extractInteractiveChildDiagnostic = (output) => {
  if (typeof output !== "string" || output.length > 16 * 1024 * 1024)
    return undefined;
  const matches = [
    ...output.matchAll(
      /^integration\.runner\.interactive-diagnostic:((?:integration|testkit)\.[a-z0-9.-]{1,128})$/gmu,
    ),
  ];
  if (matches.length !== 1) return undefined;
  const diagnostic = matches[0]?.[1];
  return diagnostic !== undefined &&
    ptyExecutionFailurePredicates.includes(diagnostic)
    ? diagnostic
    : undefined;
};

export const decodeInteractivePtyReceipt = (output) => {
  if (typeof output !== "string" || output.length > 2 * 1024 * 1024)
    return fail();
  const prefix = "AGENTSCOPE_INTERACTIVE_PTY_RECEIPT=";
  const lines = output.split("\n").filter((line) => line.startsWith(prefix));
  if (lines.length !== 1 || lines[0].length > 32_768) return fail();
  try {
    const encoded = lines[0].slice(prefix.length);
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return fail();
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) return fail();
    const serialized = bytes.toString("utf8");
    const receipt = JSON.parse(serialized);
    if (!plainRecord(receipt) || JSON.stringify(receipt) !== serialized)
      return fail();
    return Object.freeze(receipt);
  } catch {
    return fail();
  }
};

export const selectedRuntimeFiles = Object.freeze([
  "testkit/bounded-terminal-emulator.js",
  "testkit/headless-supervisor-contract.js",
  "testkit/headless-supervisor-kernel.js",
  "testkit/headless-supervisor.js",
  "testkit/internal/headless-supervisor-backend.js",
  "testkit/pty-terminal-contract.js",
  "testkit/pty-runtime/node127-linux-x64-glibc/pty.node",
  "testkit/pty-runtime/node127-linux-x64-musl/pty.node",
]);

export const compileCandidateInventory = (candidate) => {
  if (
    !plainRecord(candidate) ||
    !exactKeys(candidate, [
      "artifacts",
      "bundleIdentity",
      "candidateRevision",
      "evidenceVersion",
      "lockfile",
      "platform",
      "scenarioNetworkPolicy",
    ]) ||
    candidate.evidenceVersion !== 1 ||
    !/^sha256-[a-f0-9]{64}$/u.test(candidate.bundleIdentity) ||
    !/^[a-f0-9]{40,64}$/u.test(candidate.candidateRevision) ||
    !exactKeys(candidate.platform, ["architecture", "nodeVersion", "os"]) ||
    !/^[a-z0-9-]{1,32}$/u.test(candidate.platform.os) ||
    !/^[a-z0-9-]{1,32}$/u.test(candidate.platform.architecture) ||
    !/^\d+\.\d+\.\d+$/u.test(candidate.platform.nodeVersion) ||
    !plainRecord(candidate.lockfile) ||
    !exactKeys(candidate.lockfile, ["bytes", "fileName", "sha256"]) ||
    candidate.lockfile.fileName !== "pnpm-lock.yaml" ||
    !Number.isSafeInteger(candidate.lockfile.bytes) ||
    candidate.lockfile.bytes < 1 ||
    candidate.lockfile.bytes > 256 * 1024 * 1024 ||
    !/^sha256-[a-f0-9]{64}$/u.test(candidate.lockfile.sha256) ||
    candidate.scenarioNetworkPolicy !==
      "offline-no-package-or-registry-download" ||
    !Array.isArray(candidate.artifacts) ||
    candidate.artifacts.length < 1 ||
    candidate.artifacts.length > 32
  )
    return fail();
  const artifacts = candidate.artifacts
    .map((file) => {
      if (
        !plainRecord(file) ||
        !exactKeys(file, ["bytes", "fileName", "id", "kind", "sha256"]) ||
        !/^[a-z][a-z0-9-]{0,63}$/u.test(file.id) ||
        !["npm-tarball", "runtime-archive", "runtime-binary"].includes(
          file.kind,
        ) ||
        typeof file.fileName !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(file.fileName) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 ||
        file.bytes > 256 * 1024 * 1024 ||
        !/^sha256-[a-f0-9]{64}$/u.test(file.sha256)
      )
        return fail();
      return {
        id: file.id,
        kind: file.kind,
        fileName: file.fileName,
        bytes: file.bytes,
        sha256: file.sha256,
      };
    })
    .sort((left, right) =>
      left.fileName < right.fileName
        ? -1
        : left.fileName > right.fileName
          ? 1
          : 0,
    );
  const files = [
    {
      fileName: candidate.lockfile.fileName,
      bytes: candidate.lockfile.bytes,
      sha256: candidate.lockfile.sha256,
    },
    ...artifacts,
  ].sort((left, right) =>
    left.fileName < right.fileName
      ? -1
      : left.fileName > right.fileName
        ? 1
        : 0,
  );
  if (new Set(files.map(({ fileName }) => fileName)).size !== files.length)
    return fail();
  if (
    new Set(artifacts.map(({ id }) => id)).size !== artifacts.length ||
    artifacts.filter(
      ({ id, kind }) => id === "agentscope-cli" && kind === "npm-tarball",
    ).length !== 1
  )
    return fail();
  const inventory = {
    evidenceVersion: candidate.evidenceVersion,
    bundleIdentity: candidate.bundleIdentity,
    candidateRevision: candidate.candidateRevision,
    platform: { ...candidate.platform },
    files,
    scenarioNetworkPolicy: candidate.scenarioNetworkPolicy,
  };
  return Object.freeze({
    inventory,
    sha256: sha256(JSON.stringify(inventory)),
  });
};

export const compileImmutableCandidateHandoff = ({
  candidate,
  image,
  plan,
}) => {
  const compiled = compileCandidateInventory(candidate);
  if (
    !exactKeys(plan, ["runId", "scenarioId"]) ||
    !/^[a-f0-9]{16}$/u.test(plan.runId) ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(plan.scenarioId) ||
    !plainRecord(image) ||
    !/^sha256:[a-f0-9]{64}$/u.test(image.Id) ||
    !plainRecord(image.Config)
  )
    return fail();
  const record = {
    authorityVersion: 1,
    candidateBundleIdentity: candidate.bundleIdentity,
    candidateInventorySha256: compiled.sha256,
    candidateRoot: "/opt/agentscope/prepared",
    imageConfigSha256: sha256(JSON.stringify(image.Config)),
    imageId: image.Id,
    runId: plan.runId,
    scenarioId: plan.scenarioId,
  };
  return Object.freeze({
    ...record,
    encoded: Buffer.from(JSON.stringify(record)).toString("base64url"),
  });
};

export const decodeImmutableCandidateHandoff = (encoded, expected) => {
  if (
    typeof encoded !== "string" ||
    encoded.length < 1 ||
    encoded.length > 4_096 ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded) ||
    !exactKeys(expected, [
      "candidateBundleIdentity",
      "candidateInventorySha256",
      "candidateRoot",
      "runId",
      "scenarioId",
    ])
  )
    return fail();
  let record;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) return fail();
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    return fail();
  }
  if (
    !exactKeys(record, [
      "authorityVersion",
      "candidateBundleIdentity",
      "candidateInventorySha256",
      "candidateRoot",
      "imageConfigSha256",
      "imageId",
      "runId",
      "scenarioId",
    ]) ||
    record.authorityVersion !== 1 ||
    !/^[a-f0-9]{64}$/u.test(record.imageConfigSha256) ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.imageId) ||
    Object.entries(expected).some(([key, value]) => record[key] !== value)
  )
    return fail();
  return Object.freeze(record);
};

export const validateImmutableScenarioContainer = ({
  container,
  handoff,
  image,
  networkName,
  tmpfs,
}) => {
  if (
    !plainRecord(container) ||
    !plainRecord(handoff) ||
    !plainRecord(image) ||
    image.Id !== handoff.imageId ||
    sha256(JSON.stringify(image.Config)) !== handoff.imageConfigSha256 ||
    container.Image !== handoff.imageId ||
    container.Config?.User !== "1000:1000" ||
    !Array.isArray(container.Config?.Env) ||
    !container.Config.Env.includes(
      `AGENTSCOPE_IMMUTABLE_CANDIDATE_AUTHORITY=${handoff.encoded}`,
    ) ||
    container.HostConfig?.ReadonlyRootfs !== true ||
    container.HostConfig?.NetworkMode !== networkName ||
    JSON.stringify(container.HostConfig?.CapDrop) !== JSON.stringify(["ALL"]) ||
    !Array.isArray(container.HostConfig?.SecurityOpt) ||
    !container.HostConfig.SecurityOpt.includes("no-new-privileges") ||
    !Array.isArray(container.Mounts) ||
    container.Mounts.length !== 0 ||
    !plainRecord(container.HostConfig?.Tmpfs) ||
    JSON.stringify(container.HostConfig.Tmpfs) !== JSON.stringify(tmpfs)
  )
    return fail();
  return true;
};
