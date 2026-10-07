import assert from "node:assert/strict";

function traceSearchUnavailable(result) {
  if (result.status !== 5 || result.stdout !== "") return false;
  try {
    const diagnostic = JSON.parse(result.stderr);
    return (
      Object.keys(diagnostic).sort().join(",") ===
        "category,code,command,schema" &&
      diagnostic.category === "unavailable" &&
      diagnostic.code === "traces.unavailable" &&
      diagnostic.command === "agentscope traces search" &&
      diagnostic.schema === "agentscope.cli.diagnostic.v1"
    );
  } catch {
    return false;
  }
}

export function runTraceSearchUntilAvailable(
  runRaw,
  command,
  arguments_,
  options = {},
) {
  const deadline = performance.now() + 5_000;
  while (true) {
    const remainingBeforeAttempt = deadline - performance.now();
    assert.ok(remainingBeforeAttempt > 0);
    const result = runRaw(command, arguments_, {
      ...options,
      timeout: Math.max(1, Math.ceil(remainingBeforeAttempt)),
    });
    const remainingMilliseconds = deadline - performance.now();
    if (result.status === 0 || !traceSearchUnavailable(result))
      return { result, timely: remainingMilliseconds > 0 };
    if (remainingMilliseconds <= 0) return { result, timely: false };
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      Math.min(25, remainingMilliseconds),
    );
  }
}

// Never reflect argv, trace locators, stream contents, or native error text.
const reportedKeys = [
  "retrieverReportedStage",
  "retrieverCutoffExpired",
  "retrieverWorkerJoined",
  "retrieverWatchdogJoined",
  "retrieverLeaseReleased",
];
const validReportedFacts = (facts) => {
  const present = reportedKeys.filter((key) => Object.hasOwn(facts, key));
  return (
    present.length === 0 ||
    (present.length === 5 &&
      Number.isInteger(facts.retrieverReportedStage) &&
      facts.retrieverReportedStage >= 1 &&
      facts.retrieverReportedStage <= 14 &&
      typeof facts.retrieverCutoffExpired === "boolean" &&
      reportedKeys
        .slice(2)
        .every(
          (key) => facts[key] === null || typeof facts[key] === "boolean",
        ) &&
      facts.retrieverPreparationFailed === false &&
      facts.retrieverInvocationFailed === true)
  );
};
export function traceGetFailureSummary(result) {
  const status = Number.isInteger(result.status) ? result.status : "absent";
  let phase = "unclassified";
  let observation = "";
  if (
    result.status === 5 &&
    result.stdout === "" &&
    typeof result.stderr === "string" &&
    result.stderr.length <= 4096
  ) {
    try {
      const value = JSON.parse(result.stderr);
      const facts = value.facts;
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).sort().join(",") ===
          "category,code,command,facts,schema" &&
        value.schema === "agentscope.cli.diagnostic.v1" &&
        value.command === "agentscope traces get" &&
        value.category === "unavailable" &&
        value.code === "traces.unavailable" &&
        facts !== null &&
        typeof facts === "object" &&
        !Array.isArray(facts) &&
        Object.keys(facts).every((name) =>
          [
            "retrieverPreparationFailed",
            "retrieverInvocationFailed",
            "retryAfterMilliseconds",
            ...reportedKeys,
          ].includes(name),
        ) &&
        validReportedFacts(facts) &&
        (facts.retryAfterMilliseconds === undefined ||
          (typeof facts.retryAfterMilliseconds === "number" &&
            Number.isFinite(facts.retryAfterMilliseconds) &&
            facts.retryAfterMilliseconds >= 0))
      ) {
        if (
          facts.retrieverPreparationFailed === true &&
          facts.retrieverInvocationFailed === false
        )
          phase = "prepare-retriever";
        if (
          facts.retrieverPreparationFailed === false &&
          facts.retrieverInvocationFailed === true
        ) {
          phase = "invoke-get";
          observation = Object.hasOwn(facts, "retrieverReportedStage")
            ? `; adapterReportedStage=${facts.retrieverReportedStage}; cutoffExpired=${facts.retrieverCutoffExpired}; workerJoined=${facts.retrieverWorkerJoined}; watchdogJoined=${facts.retrieverWatchdogJoined}; leaseReleased=${facts.retrieverLeaseReleased}`
            : "";
        }
      }
    } catch {
      /* Malformed output has no diagnostic authority. */
    }
  }
  return `installed trace get failed; status=${status}; retrievalPhase=${phase}${observation}`;
}
