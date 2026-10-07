/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

describe("upstream control staging closure", () => {
  it("stages the actual control-to-ledger edge in both fixed projections", () => {
    const root = resolve(import.meta.dirname, "..");
    const source = readFileSync(resolve(root, "run-scenarios.mjs"), "utf8");
    const start = source.indexOf("  const sources = [");
    const end = source.indexOf(
      "].map((name) => [name, resolve(integrationRoot, name)])",
      start,
    );
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const names: string[] = runInNewContext(
      source.slice(source.indexOf("...[", start) + 3, end + 1),
    );
    const copy = source.match(/"COPY runner\.mjs ([^"\n]+) \.\/"/u);
    expect(copy).not.toBeNull();
    const copied = ["runner.mjs", ...copy![1]!.split(" ")];
    const control = readFileSync(
      resolve(root, "mockserver-control.mjs"),
      "utf8",
    );
    expect(control).toContain('from "./mockserver-final-ledger.mjs"');
    const closed = (inventory: readonly string[]) =>
      ["mockserver-control.mjs", "mockserver-final-ledger.mjs"].every((name) =>
        inventory.includes(name),
      );
    for (const inventory of [names, copied]) {
      expect(closed(inventory)).toBe(true);
      for (const omitted of [
        "mockserver-control.mjs",
        "mockserver-final-ledger.mjs",
      ])
        expect(closed(inventory.filter((name) => name !== omitted))).toBe(
          false,
        );
    }
  });
});

describe("fixed sidecar runtime topology", () => {
  it("keeps the two fixed sidecar create/assert/start recipes closed and ordered", async () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../run-scenarios.mjs"),
      "utf8",
    );
    const start = source.indexOf("const startDestinationSidecar =");
    const end = source.indexOf("const startMockServer =", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const calls: unknown[][] = [];
    const limits = {
      collector: { id: "collector" },
      retrieval: { id: "retrieval" },
    };
    const signal = {};
    const plan = {
      collectorName: "collector-name",
      retrievalName: "retrieval-name",
      networkName: "network",
      scenarioId: "scenario",
      imageTag: "image",
    };
    const functions = runInNewContext(
      `${source.slice(start, end)}; ({ startCollector, startRetrieval, startDestinationSidecar })`,
      {
        canonicalImagePlatform: "linux/amd64",
        ISOLATION_EXECUTOR_LIMITS: {
          containers: limits,
          requests: { destinationServerMaximumBytes: 42 },
        },
        labelArguments: () => ["--label", "fixed"],
        sidecarResourceArguments: (limit: { id: string }) => [
          "--resource",
          limit.id,
        ],
        tmpfsArguments: (limit: { id: string }) => ["--tmpfs", limit.id],
        dockerWithSignal: (...args: unknown[]) => {
          calls.push(["docker", ...args]);
        },
        assertContainer: (...args: unknown[]) => {
          calls.push(["assert", ...args]);
        },
      },
    );
    for (const [name, kind, mode] of [
      ["startCollector", "collector", "ingestion"],
      ["startRetrieval", "retrieval", "retrieval"],
    ]) {
      calls.length = 0;
      await functions[name!](plan, signal);
      expect(calls).toEqual([
        [
          "docker",
          [
            "create",
            "--platform",
            "linux/amd64",
            "--name",
            `${kind}-name`,
            "--label",
            "fixed",
            "--network",
            "network",
            "--network-alias",
            kind,
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--resource",
            kind,
            "--user",
            "1000:1000",
            "--tmpfs",
            kind,
            "--env",
            "AGENTSCOPE_SCENARIO_ID=scenario",
            "--env",
            "AGENTSCOPE_MAXIMUM_REQUEST_BYTES=42",
            "image",
            "node",
            "/opt/agentscope/destination-server.mjs",
            mode,
          ],
          signal,
          { mutationCapable: true },
        ],
        [
          "assert",
          plan,
          `${kind}-name`,
          limits[kind as keyof typeof limits],
          signal,
          42,
        ],
        [
          "docker",
          ["start", `${kind}-name`],
          signal,
          { mutationCapable: true },
        ],
      ]);
    }
    calls.length = 0;
    await expect(
      functions.startDestinationSidecar(plan, signal, "caller-route"),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("fixed upstream and candidate environment recipes", () => {
  it("retains all ordered env pairs and property reads at the two existing argv positions", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../run-scenarios.mjs"),
      "utf8",
    );
    const blocks = [
      {
        anchor: '"MOCKSERVER_INITIALIZATION_JSON_PATH=',
        expected: [
          "MOCKSERVER_INITIALIZATION_JSON_PATH=/config/expectations.json",
          "MOCKSERVER_LOG_LEVEL=WARN",
          "MOCKSERVER_CONTROL_PLANE_JWT_AUTHENTICATION_REQUIRED=true",
          "MOCKSERVER_CONTROL_PLANE_JWT_AUTHENTICATION_JWK_SOURCE=/control/private/control-jwks.json",
          "MOCKSERVER_CONTROL_PLANE_JWT_AUTHENTICATION_EXPECTED_AUDIENCE=agentscope:run",
          "MOCKSERVER_CONTROL_PLANE_JWT_AUTHENTICATION_MATCHING_CLAIMS=runId=run",
          "MOCKSERVER_CONTROL_PLANE_JWT_AUTHENTICATION_REQUIRED_CLAIMS=runId",
          "MOCKSERVER_PERSIST_RECORDED_REQUESTS_TO_DISK=true",
          "MOCKSERVER_PERSISTED_RECORDED_REQUESTS_PATH=/control/private/requests.json",
        ],
        reads: ["runId", "runId"],
      },
      {
        anchor: "`HOME=${SCENARIO_HOME}`",
        expected: [
          "HOME=/home",
          "XDG_CONFIG_HOME=/harness-home",
          "HARNESS_HOME=/harness-home",
          "AGENTSCOPE_HOME=/agentscope-home",
          "AGENTSCOPE_WORKTREE=/worktree",
          "AGENTSCOPE_LEDGER=/ledger",
          "AGENTSCOPE_CANDIDATE_ROOT=/opt/agentscope/prepared",
          "AGENTSCOPE_COLLECTOR_URL=http://collector:4318",
          "AGENTSCOPE_INGESTION_URL=http://collector:4318",
          "AGENTSCOPE_RETRIEVAL_URL=http://retrieval:4319",
          "AGENTSCOPE_MODEL_SERVER_URL=http://mockserver:1080",
          "AGENTSCOPE_SCENARIO_ID=scenario",
          "AGENTSCOPE_INTEGRATION_RUN_ID=run",
          "AGENTSCOPE_HEADLESS_OUTER_MONOTONIC_DEADLINE_MS=123",
          "AGENTSCOPE_IMMUTABLE_CANDIDATE_AUTHORITY=authority",
        ],
        reads: ["scenarioId", "runId"],
      },
    ];
    for (const block of blocks) {
      const anchor = source.indexOf(block.anchor);
      const start = source.lastIndexOf("...[", anchor);
      const end = source.indexOf(
        '].flatMap((value) => ["--env", value])',
        start,
      );
      expect(anchor).toBeGreaterThan(0);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(anchor);
      const reads: string[] = [];
      const plan = Object.defineProperties(
        {},
        {
          scenarioId: {
            get() {
              reads.push("scenarioId");
              return "scenario";
            },
          },
          runId: {
            get() {
              reads.push("runId");
              return "run";
            },
          },
        },
      );
      const result = runInNewContext(
        `${source.slice(start + 3, end + 1)}.flatMap(value => ["--env", value])`,
        {
          plan,
          SCENARIO_HOME: "/home",
          outerMonotonicDeadline: 123,
          immutableCandidate: { encoded: "authority" },
        },
      );
      expect(result).toEqual(
        block.expected.flatMap((value) => ["--env", value]),
      );
      expect(reads).toEqual(block.reads);
    }
  });
});
