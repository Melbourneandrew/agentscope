/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

describe("upstream control staging closure", () => {
  it("retains inherited helper exclusions and the Mock helper while preserving canonical test includes", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../../vitest.config.ts"),
      "utf8",
    );
    const start = source.indexOf("export default defineConfig({");
    expect(start).toBeGreaterThan(0);
    const definition = runInNewContext(
      source.slice(start).replace("export default ", ""),
      {
        defineConfig: (value: unknown) => value,
        process: { cwd: () => "/fixture" },
        thresholds: undefined,
      },
    );
    expect(definition.test.include).toEqual([
      "src/**/*.{test,spec}.{ts,tsx}",
      "src/**/__tests__/**/*.{ts,tsx}",
      "scripts/__tests__/**/*.test.mjs",
    ]);
    expect(definition.test.exclude).toEqual([
      "**/dist/**",
      "**/node_modules/**",
      "src/__tests__/claude-plugin-context-fixture.ts",
      "src/__tests__/product-harness-fixture.ts",
      "src/__tests__/product-installation-fixture.ts",
      "src/discovery/__tests__/discovery-fixture.ts",
      "src/__tests__/fixtures/mockserver-supplier-command.ts",
    ]);
    expect(definition.test.exclude).not.toContain(
      "src/mockserver-supplier-command.test.ts",
    );
    expect(definition.test.coverage.exclude).toContain("src/**/__tests__/**");
  });
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

describe("trusted service preparation precedes scenario authority", () => {
  it("settles actual orchestration preparation before creating any scenario cutoff", async () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../run-scenarios.mjs"),
      "utf8",
    );
    const start = source.indexOf(
      "  for (const plan of plans) {\n    prepareMockServerControl(plan);",
    );
    const end = source.indexOf(
      "  if (substrateCertificationCase !== undefined)",
      start,
    );
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const plans = [{ runId: "first" }, { runId: "second" }];
    const calls: unknown[][] = [];
    const failure = new Error("fixed-preparation-failure");
    let fail = false;
    const run = () =>
      runInNewContext(
        `(async () => { ${source.slice(start, end)}; return evidence; })()`,
        {
          plans,
          prepareMockServerControl: (plan: { runId: string }) =>
            calls.push(["control", plan.runId]),
          prepareMockServerImage: (plan: { runId: string }) => {
            calls.push(["prepare", plan.runId]);
            if (fail) throw failure;
            return Promise.resolve();
          },
          integrationStageSignal: () => "stage-signal",
          activateRuns: () => calls.push(["activate"]),
          scenarioConcurrency: 1,
          scenarioTimeoutMilliseconds: 300_000,
          controller: { signal: "controller-signal" },
          createDriver: (plan: { runId: string }) => plan,
          executeIsolationPlan: (plan: { runId: string }) => {
            calls.push(["scenario", plan.runId]);
            return plan.runId;
          },
          AbortSignal: {
            any: (signals: unknown[]) => signals,
            timeout: (budget: number) => {
              calls.push(["cutoff", budget]);
              return "scenario-signal";
            },
          },
          mapWithConcurrency: async (
            values: unknown[],
            _limit: number,
            work: (value: unknown) => unknown,
          ) => {
            const results = [];
            for (const value of values) results.push(await work(value));
            return results;
          },
        },
      ) as Promise<unknown>;
    await expect(run()).resolves.toEqual(["first", "second"]);
    expect(calls).toEqual([
      ["control", "first"],
      ["prepare", "first"],
      ["control", "second"],
      ["prepare", "second"],
      ["activate"],
      ["cutoff", 300_000],
      ["scenario", "first"],
      ["cutoff", 300_000],
      ["scenario", "second"],
    ]);
    calls.length = 0;
    fail = true;
    await expect(run()).rejects.toBe(failure);
    expect(calls).toEqual([
      ["control", "first"],
      ["prepare", "first"],
    ]);
  });
});

describe("prepared service image consumption", () => {
  it("builds once before activation and consumes only its exact run-owned image", async () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../run-scenarios.mjs"),
      "utf8",
    );
    const preparation = source.indexOf(
      "  for (const plan of plans) {\n    prepareMockServerControl(plan);",
    );
    const activation = source.indexOf(
      "  await activateRuns(plans);",
      preparation,
    );
    const scenarioCutoff = source.indexOf(
      "AbortSignal.timeout(scenarioTimeoutMilliseconds)",
      activation,
    );
    expect(preparation).toBeGreaterThan(0);
    expect(activation).toBeGreaterThan(preparation);
    expect(scenarioCutoff).toBeGreaterThan(activation);
    const start = source.indexOf("const prepareMockServerImage =");
    const end = source.indexOf("const createNetwork =", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const runId = "0123456789abcdef";
    const image = `sha256:${"a".repeat(64)}`;
    const signal = {};
    const calls: unknown[][] = [];
    let inspected = image;
    let inspectedRun = runId;
    const functions = runInNewContext(
      `${source.slice(start, end)}; ({ prepareMockServerImage, buildMockServerImage })`,
      {
        preparedImageFor: (...args: unknown[]) => calls.push(["base", ...args]),
        mockServerControls: new Map([
          [runId, { material: {}, expectations: Buffer.from("[]") }],
        ]),
        mockServerBuiltImages: new Map(),
        prepareMockServerService: (...args: unknown[]) => {
          calls.push(["prepare", ...args]);
          return { imageId: image.replace("sha256:", "sha256-") };
        },
        preparedDockerClient: {},
        capability: { binding: { privateStorage: { root: "/fixed" } } },
        performance: { now: () => 100 },
        remainingIntegrationOperationMilliseconds: (value: number) => value,
        scenarioTimeoutMilliseconds: 300_000,
        IMAGE_PREPARATION_LIMITS: { maximumPreparationMilliseconds: 300_000 },
        dockerWithSignal: (...args: unknown[]) => {
          calls.push(["inspect", ...args]);
          return {
            stdout: JSON.stringify([
              {
                Id: inspected,
                Config: {
                  Labels: { "com.agentscope.integration.run": inspectedRun },
                },
              },
            ]),
          };
        },
      },
    );
    const plan = {
      runId,
      mockServerImage: "base",
      mockServerImageTag: "run-tag",
    };
    await expect(functions.buildMockServerImage(plan, signal)).rejects.toThrow(
      "integration.isolation.context",
    );
    expect(calls).toEqual([]);
    await functions.prepareMockServerImage(plan, signal);
    expect(calls.map(([kind]) => kind)).toEqual(["base", "prepare"]);
    expect((calls[1]?.[1] as { deadline: number }).deadline).toBe(300_100);
    await expect(functions.buildMockServerImage(plan, signal)).resolves.toBe(
      image.replace("sha256:", "sha256-"),
    );
    expect(calls[2]).toEqual([
      "inspect",
      ["image", "inspect", "run-tag"],
      signal,
    ]);
    expect(calls.filter(([kind]) => kind === "prepare")).toHaveLength(1);
    inspected = `sha256:${"b".repeat(64)}`;
    await expect(functions.buildMockServerImage(plan, signal)).rejects.toThrow(
      "integration.isolation.image-digest",
    );
    inspected = image;
    inspectedRun = "another-run";
    await expect(functions.buildMockServerImage(plan, signal)).rejects.toThrow(
      "integration.isolation.image-digest",
    );
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
