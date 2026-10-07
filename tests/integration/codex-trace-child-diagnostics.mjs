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
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      text !== `${JSON.stringify(value)}\n` ||
      Object.keys(value).sort().join(",") !==
        "category,code,command,facts,schema" ||
      value.schema !== "agentscope.cli.diagnostic.v1" ||
      value.command !== "agentscope traces get" ||
      value.category !== "unavailable" ||
      value.code !== "traces.unavailable"
    )
      return "exit";
    const facts = value.facts;
    if (
      facts === null ||
      typeof facts !== "object" ||
      Array.isArray(facts) ||
      ![
        "retrieverInvocationFailed,retrieverPreparationFailed",
        "retrieverInvocationFailed,retrieverPreparationFailed,retryAfterMilliseconds",
      ].includes(Object.keys(facts).sort().join(",")) ||
      (Object.hasOwn(facts, "retryAfterMilliseconds") &&
        (!Number.isFinite(facts.retryAfterMilliseconds) ||
          facts.retryAfterMilliseconds < 0))
    )
      return "exit";
    if (
      facts.retrieverPreparationFailed === true &&
      facts.retrieverInvocationFailed === false
    )
      return "prepare-retriever";
    if (
      facts.retrieverPreparationFailed === false &&
      facts.retrieverInvocationFailed === true
    )
      return "invoke-get";
  } catch {
    // Malformed or noncanonical child bytes have no diagnostic authority.
  }
  return "exit";
};

export const codexTraceGetChildFailureCategory = (observation) => {
  const category = codexTraceSearchChildFailureCategory(observation);
  if (category === "exit-5") return unavailableGetPhase(observation);
  return category === "exit-other" ? "exit" : category;
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
