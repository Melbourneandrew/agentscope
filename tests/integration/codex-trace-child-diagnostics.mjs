import { types } from "node:util";
export const interactivePhases = Object.freeze([
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
export const candidateConfigStages = Object.freeze([
  "render",
  "create",
  "open",
  "prove",
  "closed-marker",
  "publish",
]);
export const createCodexFailureResearchRecord = (
  plan,
  output,
  receipt,
  error,
  [config, gate, pty, projectReceipt, reported, exitPair],
) => ({
  diagnosticVersion: 6,
  untrustedConfigHint: config(output) ?? null,
  untrustedGateHint: gate(output) ?? null,
  untrustedPtyHint: pty(output) ?? null,
  untrustedPtyReceipt: projectReceipt(receipt, 6) ?? null,
  adapterReportedFailure: reported(output, plan.runId) ?? null,
  exitPair: exitPair(receipt?.exitCode, error?.code, plan.scenarioId) ?? null,
});

const adapterFields = Object.freeze([
  "stage",
  "cutoffExpired",
  "workerJoined",
  "watchdogJoined",
  "leaseReleased",
]);
/** Adapter-reported diagnostics only, never process or settlement authority. */
export const projectAdapterReportedFailure = (value) => {
  if (
    value === null ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== adapterFields.length ||
    Object.keys(descriptors).sort().join("\0") !==
      [...adapterFields].sort().join("\0") ||
    adapterFields.some((field) => !("value" in descriptors[field]))
  )
    return undefined;
  const stage = descriptors.stage.value;
  const cutoffExpired = descriptors.cutoffExpired.value;
  const joined = adapterFields
    .slice(2)
    .map((field) => descriptors[field].value);
  if (
    !Number.isInteger(stage) ||
    stage < 1 ||
    stage > 14 ||
    typeof cutoffExpired !== "boolean" ||
    joined.some((fact) => fact !== null && typeof fact !== "boolean")
  )
    return undefined;
  return Object.freeze(
    Object.assign(Object.create(null), {
      stage,
      cutoffExpired,
      workerJoined: joined[0],
      watchdogJoined: joined[1],
      leaseReleased: joined[2],
    }),
  );
};
const adapterFailurePredicate =
  "integration.fixture.codex-verify-trace-get-child-invoke-get";
export const encodeAdapterReportedFailureMarker = (predicate, runId, value) => {
  const projected = projectAdapterReportedFailure(value);
  if (
    predicate !== adapterFailurePredicate ||
    typeof runId !== "string" ||
    !/^[a-f0-9]{16}$/u.test(runId) ||
    projected === undefined
  )
    return undefined;
  const nullable = (fact) => (fact === null ? "n" : fact ? "1" : "0");
  const vector = `${projected.stage.toString(36)}${projected.cutoffExpired ? "1" : "0"}${nullable(projected.workerJoined)}${nullable(projected.watchdogJoined)}${nullable(projected.leaseReleased)}`;
  const marker = `${predicate}|${runId}|${vector}\n`;
  return Buffer.byteLength(marker) <= 128 ? marker : undefined;
};
export const decodeAdapterReportedFailureMarker = (content, runId) => {
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content) > 128 ||
    typeof runId !== "string" ||
    !/^[a-f0-9]{16}$/u.test(runId)
  )
    return undefined;
  const match =
    /^integration\.fixture\.codex-verify-trace-get-child-invoke-get\|([a-f0-9]{16})\|([1-9a-e])([01])([n01])([n01])([n01])\n$/u.exec(
      content,
    );
  if (match === null || match[1] !== runId) return undefined;
  const nullable = (fact) => (fact === "n" ? null : fact === "1");
  const value = projectAdapterReportedFailure({
    stage: Number.parseInt(match[2], 36),
    cutoffExpired: match[3] === "1",
    workerJoined: nullable(match[4]),
    watchdogJoined: nullable(match[5]),
    leaseReleased: nullable(match[6]),
  });
  return value !== undefined &&
    encodeAdapterReportedFailureMarker(
      adapterFailurePredicate,
      runId,
      value,
    ) === content
    ? value
    : undefined;
};
export const extractAdapterReportedFailure = (output, runId) => {
  if (typeof output !== "string") return undefined;
  const prefix = "integration.runner.adapter-reported-failure:";
  const lines = output.split("\n").filter((line) => line.startsWith(prefix));
  return lines.length === 1
    ? decodeAdapterReportedFailureMarker(
        `${lines[0].slice(prefix.length)}\n`,
        runId,
      )
    : undefined;
};
// Content-free child observations only; never acceptance, retries or new windows.
export const codexTraceSearchChildFailureCategory = ({
  code,
  deadlineExpired,
  signal,
  stderrBytes,
  stdoutBytes,
  maximumBytes,
}) => {
  if (
    !Number.isSafeInteger(stderrBytes) ||
    stderrBytes < 0 ||
    !Number.isSafeInteger(stdoutBytes) ||
    stdoutBytes < 0 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    typeof deadlineExpired !== "boolean"
  )
    throw new Error("integration.codex.trace-search-child-observation");
  if (stdoutBytes > maximumBytes || stderrBytes > maximumBytes)
    return "output-limit";
  if (deadlineExpired) return "deadline";
  if (signal !== null) return "signal";
  if (code === 5) return "exit-5";
  if (code !== 0) return "exit-other";
  throw new Error("integration.codex.trace-search-child-observation");
};

const traceGetFailureKinds = new Map([
  ["integration.codex.trace-get-locator-input", "locator-input"],
  ["integration.codex.child-spawn", "child-spawn"],
  ["integration.codex.child-deadline", "child-deadline"],
  ["integration.codex.trace-get-child-deadline", "child-deadline"],
  ["integration.codex.trace-get-child-signal", "child-signal"],
  ["integration.codex.trace-get-child-exit", "child-exit"],
  ["integration.codex.trace-get-child-output-limit", "child-output-limit"],
  ["integration.codex.trace-deadline", "terminal-deadline"],
  ["integration.codex.deadline", "terminal-deadline"],
  ["integration.codex.cli-output", "machine-output"],
  ["integration.codex.trace-get-record-count", "record-count"],
  ["integration.codex.trace-get-locator-result", "locator-result"],
  [
    "integration.codex.trace-get-child-prepare-retriever",
    "child-prepare-retriever",
  ],
  ["integration.codex.trace-get-child-invoke-get", "child-invoke-get"],
]);

export const classifyCodexTraceGetFailure = (message) =>
  typeof message === "string"
    ? (traceGetFailureKinds.get(message) ?? "unclassified")
    : "unclassified";

const invalidUnavailableEnvelope = (value, text) =>
  value === null ||
  typeof value !== "object" ||
  Array.isArray(value) ||
  text !== `${JSON.stringify(value)}\n` ||
  Object.keys(value).sort().join(",") !==
    "category,code,command,facts,schema" ||
  value.schema !== "agentscope.cli.diagnostic.v1" ||
  value.command !== "agentscope traces get" ||
  value.category !== "unavailable" ||
  value.code !== "traces.unavailable";

const invalidReportedFacts = (facts) =>
  facts.retrieverPreparationFailed !== false ||
  facts.retrieverInvocationFailed !== true ||
  !Number.isInteger(facts.retrieverReportedStage) ||
  facts.retrieverReportedStage < 1 ||
  facts.retrieverReportedStage > 14 ||
  typeof facts.retrieverCutoffExpired !== "boolean" ||
  [
    facts.retrieverWorkerJoined,
    facts.retrieverWatchdogJoined,
    facts.retrieverLeaseReleased,
  ].some((fact) => fact !== null && typeof fact !== "boolean");

const unavailableGetPhase = ({ stdout, stderr, stdoutBytes, stderrBytes }) => {
  if (
    !Buffer.isBuffer(stdout) ||
    stdout.length !== 0 ||
    stdout.length !== stdoutBytes ||
    !Buffer.isBuffer(stderr) ||
    stderr.length !== stderrBytes ||
    stderr.length < 1 ||
    stderr.length > 4_096
  )
    return "exit";
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(stderr);
    const value = JSON.parse(text);
    if (invalidUnavailableEnvelope(value, text)) return "exit";
    const facts = value.facts;
    const fields =
      facts && typeof facts === "object"
        ? Object.keys(facts).sort().join(",")
        : "";
    const originalFields =
      "retrieverInvocationFailed,retrieverPreparationFailed";
    const reportedFields =
      "retrieverCutoffExpired,retrieverInvocationFailed,retrieverLeaseReleased,retrieverPreparationFailed,retrieverReportedStage,retrieverWatchdogJoined,retrieverWorkerJoined";
    if (
      facts === null ||
      typeof facts !== "object" ||
      Array.isArray(facts) ||
      ![
        originalFields,
        `${originalFields},retryAfterMilliseconds`,
        reportedFields,
        `${reportedFields},retryAfterMilliseconds`,
      ].includes(fields) ||
      (Object.hasOwn(facts, "retryAfterMilliseconds") &&
        (!Number.isFinite(facts.retryAfterMilliseconds) ||
          facts.retryAfterMilliseconds < 0))
    )
      return "exit";
    const reported = Object.hasOwn(facts, "retrieverReportedStage");
    if (reported && invalidReportedFacts(facts)) return "exit";
    if (
      facts.retrieverPreparationFailed === true &&
      facts.retrieverInvocationFailed === false
    )
      return "prepare-retriever";
    if (
      facts.retrieverPreparationFailed === false &&
      facts.retrieverInvocationFailed === true
    )
      return reported
        ? Object.freeze({
            phase: "invoke-get",
            adapterReported: Object.freeze({
              stage: facts.retrieverReportedStage,
              cutoffExpired: facts.retrieverCutoffExpired,
              workerJoined: facts.retrieverWorkerJoined,
              watchdogJoined: facts.retrieverWatchdogJoined,
              leaseReleased: facts.retrieverLeaseReleased,
            }),
          })
        : "invoke-get";
  } catch {
    // Malformed or noncanonical child bytes have no diagnostic authority.
  }
  return "exit";
};

export const codexTraceGetChildFailureCategory = (observation) => {
  const category = codexTraceSearchChildFailureCategory(observation);
  if (category === "exit-5") {
    const projected = unavailableGetPhase(observation);
    return typeof projected === "string" ? projected : projected.phase;
  }
  return category === "exit-other" ? "exit" : category;
};
/** Optional adapter-reported facts, not controller process or settlement proof. */
export const codexTraceGetAdapterReportedFailure = (observation) => {
  if (codexTraceGetChildFailureCategory(observation) !== "invoke-get")
    return undefined;
  const projected = unavailableGetPhase(observation);
  return typeof projected === "string" ? undefined : projected.adapterReported;
};

export const classifyCodexCollectedChildFailure = (
  observation,
  options,
  retainObservation,
) => {
  const search =
    options.acceptTraceSearchUnavailable === true
      ? codexTraceSearchChildFailureCategory(observation)
      : undefined;
  const get =
    options.traceGetDiagnostic === true
      ? codexTraceGetChildFailureCategory(observation)
      : undefined;
  return {
    message:
      get !== undefined
        ? `integration.codex.trace-get-child-${get}`
        : search === undefined
          ? "integration.codex.child"
          : `integration.codex.trace-search-child-${search}`,
    adapterReportedFailure:
      retainObservation && get === "invoke-get"
        ? codexTraceGetAdapterReportedFailure(observation)
        : undefined,
  };
};
export const codexTraceSearchUnavailable = ({
  code,
  signal,
  stderr,
  stdout,
}) => {
  if (
    code !== 5 ||
    signal !== null ||
    !Buffer.isBuffer(stdout) ||
    stdout.length !== 0 ||
    !Buffer.isBuffer(stderr) ||
    stderr.length < 1 ||
    stderr.length > 4_096
  )
    return false;
  return stderr.equals(
    Buffer.from(
      '{"category":"unavailable","code":"traces.unavailable","command":"agentscope traces search","schema":"agentscope.cli.diagnostic.v1"}\n',
    ),
  );
};

export const codexTraceSearchTimedOut = ({
  code,
  deadlineExpired,
  signal,
  stderr,
  stdout,
}) =>
  deadlineExpired === true &&
  code === null &&
  signal === "SIGKILL" &&
  stdout.length === 0 &&
  stderr.length === 0;

export const codexTraceSearchAttemptDeadlines = ({
  now,
  observationDeadline,
}) => {
  if (observationDeadline - now <= 2_500) return null;
  const attemptDeadline = observationDeadline - 500;
  const childDeadline = attemptDeadline - 250;
  if (childDeadline <= now)
    throw new Error("integration.codex.trace-search-deadline");
  return Object.freeze({ attemptDeadline, childDeadline, observationDeadline });
};

export const extractUntrustedCodexConfigHint = (output) => {
  if (typeof output !== "string" || output.length > 16 * 1024 * 1024)
    return undefined;
  const lines = [
    ...output.matchAll(
      /^integration\.runner\.untrusted-config-hint:[^\n]*$/gmu,
    ),
  ];
  if (lines.length !== 1) return undefined;
  const stage = lines[0]?.[0].match(
    /^integration\.runner\.untrusted-config-hint:(closed-marker|render|create|open|prove|publish)$/u,
  )?.[1];
  return stage;
};

export const codexFailureExitPair = (
  fixtureExit,
  containerExit,
  scenarioId,
) => {
  if (
    scenarioId !== "codex-tui-trace-smoke" ||
    !Number.isSafeInteger(containerExit) ||
    containerExit < 1 ||
    containerExit > 255
  )
    return undefined;
  const fixture =
    Number.isSafeInteger(fixtureExit) && fixtureExit >= 0 && fixtureExit <= 255
      ? String(fixtureExit)
      : "none";
  return `${fixture}:${containerExit}`;
};
