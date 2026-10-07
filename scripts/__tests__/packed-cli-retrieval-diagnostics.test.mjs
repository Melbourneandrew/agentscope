import assert from "node:assert/strict";
import { test } from "vitest";
import {
  runTraceSearchUntilAvailable,
  traceGetFailureSummary,
} from "../../apps/cli/scripts/artifact-retrieval.mjs";

const diagnostic = (facts) => ({
  status: 5,
  stdout: "",
  stderr: JSON.stringify({
    schema: "agentscope.cli.diagnostic.v1",
    command: "agentscope traces get",
    category: "unavailable",
    code: "traces.unavailable",
    facts,
  }),
});

test("get summary retains only the complete closed adapter-reported scalar observation", () => {
  const facts = {
    retrieverPreparationFailed: false,
    retrieverInvocationFailed: true,
    retrieverReportedStage: 11,
    retrieverCutoffExpired: false,
    retrieverWorkerJoined: true,
    retrieverWatchdogJoined: false,
    retrieverLeaseReleased: null,
  };
  assert.equal(
    traceGetFailureSummary(diagnostic(facts)),
    "installed trace get failed; status=5; retrievalPhase=invoke-get; adapterReportedStage=11; cutoffExpired=false; workerJoined=true; watchdogJoined=false; leaseReleased=null",
  );
  for (const invalid of [
    { ...facts, retrieverReportedStage: 15 },
    { ...facts, retrieverReportedStage: 1.5 },
    { ...facts, retrieverCutoffExpired: "CANARY" },
    { ...facts, retrieverLeaseReleased: 1 },
    { ...facts, extra: "CANARY" },
    { ...facts, retrieverPreparationFailed: true },
    { ...facts, retrieverWatchdogJoined: undefined },
  ]) {
    const summary = traceGetFailureSummary(diagnostic(invalid));
    assert.match(summary, /retrievalPhase=unclassified$/u);
    assert.equal(summary.includes("CANARY"), false);
  }
});

test("get summary projects only exact owned phase boolean pairs", () => {
  assert.equal(
    traceGetFailureSummary(
      diagnostic({
        retrieverPreparationFailed: true,
        retrieverInvocationFailed: false,
      }),
    ),
    "installed trace get failed; status=5; retrievalPhase=prepare-retriever",
  );
  assert.equal(
    traceGetFailureSummary(
      diagnostic({
        retrieverPreparationFailed: false,
        retrieverInvocationFailed: true,
      }),
    ),
    "installed trace get failed; status=5; retrievalPhase=invoke-get",
  );
});

test("ambiguous, missing, malformed and substituted diagnostics disclose no content", () => {
  const canary = "TRACE_CONTENT_SECRET_CANARY";
  const cases = [
    diagnostic(undefined),
    diagnostic({
      retrieverPreparationFailed: true,
      retrieverInvocationFailed: true,
    }),
    diagnostic({
      retrieverPreparationFailed: canary,
      retrieverInvocationFailed: false,
    }),
    { status: null, stdout: canary, stderr: canary },
    {
      ...diagnostic({
        retrieverPreparationFailed: true,
        retrieverInvocationFailed: false,
      }),
      stdout: canary,
    },
    { status: 5, stdout: "", stderr: "x".repeat(4097) },
    {
      status: 5,
      stdout: "",
      stderr: JSON.stringify({
        schema: "foreign",
        facts: {
          retrieverPreparationFailed: true,
          retrieverInvocationFailed: false,
        },
        cause: canary,
      }),
    },
  ];
  for (const value of cases) {
    const summary = traceGetFailureSummary(value);
    assert.match(summary, /retrievalPhase=unclassified$/u);
    assert.equal(summary.includes(canary), false);
  }
});

test("search helper preserves one terminal success or unrelated failure with its bounded timeout", () => {
  for (const status of [0, 2, 5]) {
    let calls = 0;
    const result = { status, stdout: "bounded", stderr: "unrelated" };
    const observed = runTraceSearchUntilAvailable(
      (command, args, options) => {
        calls++;
        assert.equal(command, "closed-command");
        assert.deepEqual(args, ["search"]);
        assert.ok(options.timeout > 0 && options.timeout <= 5000);
        return result;
      },
      "closed-command",
      ["search"],
    );
    assert.equal(calls, 1);
    assert.equal(observed.result, result);
    assert.equal(observed.timely, true);
  }
});
