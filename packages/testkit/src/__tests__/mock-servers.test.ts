import assert from "node:assert/strict";
import test from "node:test";
import {
  MockModelServer,
  MockTelemetryCollector,
  assertHarnessExit,
  runHarnessScenario,
} from "../index.js";

test("mock model server records OpenAI-compatible requests", async () => {
  const server = new MockModelServer();
  const url = await server.start();
  try {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "agentscope-test" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(
      payload.choices[0].message.content,
      "AGENTSCOPE_MOCK_RESPONSE",
    );
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
