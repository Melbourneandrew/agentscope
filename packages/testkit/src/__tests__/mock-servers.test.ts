import assert from "node:assert/strict";
import { test } from "vitest";
import {
  MockModelServer,
  MockTelemetryCollector,
  assertHarnessExit,
  composeHarnessScenario,
  runHarnessScenario,
} from "../index.js";

test("generic scenario composition runs family adapter data without runner changes", async () => {
  const scenario = composeHarnessScenario(
    {
      scenarioVersion: 1,
      scenarioId: "reference-v1",
      harnessId: "reference",
      harnessPackage: "@agentscope/harness-reference",
      representativeVersion: "1.2.3",
      fixtureId: "reference-session-v1",
      tags: ["contract"],
      commandArguments: ["-e", "process.stdout.write('reference-fixture')"],
    },
    {
      command: process.execPath,
      cwd: process.cwd(),
      env: { AGENTSCOPE_SCENARIO: "reference-v1" },
      timeoutMs: 1_000,
      expect: {
        modelPaths: ["/v1/responses"],
        telemetryPaths: ["/v1/traces"],
        exitCode: 0,
      },
    },
  );
  assert.deepEqual(
    { id: scenario.id, harness: scenario.harness, args: scenario.args },
    {
      id: "reference-v1",
      harness: "reference",
      args: ["-e", "process.stdout.write('reference-fixture')"],
    },
  );
  assert.equal(Object.isFrozen(scenario), true);
  assert.equal(Object.isFrozen(scenario.args), true);
  assert.equal(Object.isFrozen(scenario.env), true);
  assert.equal(Object.isFrozen(scenario.expect), true);
  const result = await runHarnessScenario(scenario);
  assertHarnessExit(result, scenario);
  assert.equal(result.stdout, "reference-fixture");
});

test("mock model server records OpenAI-compatible requests", async () => {
  const server = new MockModelServer();
  const url = await server.start();
  try {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "agentscope-test" }),
    });
    const payload: unknown = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      choices: [
        {
          message: {
            role: "assistant",
            content: "AGENTSCOPE_MOCK_RESPONSE",
          },
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    });
    assert.equal(server.requests[0]?.path, "/v1/chat/completions");
  } finally {
    await server.stop();
  }
});

test("mock telemetry collector records OTLP ingestion", async () => {
  const collector = new MockTelemetryCollector();
  const url = await collector.start();
  try {
    const response = await fetch(`${url}/v1/traces`, {
      method: "POST",
      body: JSON.stringify({ resourceSpans: [] }),
    });
    assert.equal(response.status, 200);
    assert.equal(collector.requests[0]?.path, "/v1/traces");
  } finally {
    await collector.stop();
  }
});

test("harness runner executes a real child process with an isolated environment", async () => {
  const result = await runHarnessScenario({
    id: "runner-smoke",
    harness: "test-node",
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.env.AGENTSCOPE_TEST_VALUE)"],
    cwd: process.cwd(),
    env: { AGENTSCOPE_TEST_VALUE: "isolated" },
    expect: { modelPaths: [], telemetryPaths: [] },
  });
  assertHarnessExit(result, {
    id: "runner-smoke",
    harness: "test-node",
    command: process.execPath,
    args: [],
    cwd: process.cwd(),
    env: {},
    expect: { modelPaths: [], telemetryPaths: [] },
  });
  assert.equal(result.stdout, "isolated");
});
