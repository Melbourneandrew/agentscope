/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const runtimeSource = () =>
  readFileSync(resolve(import.meta.dirname, "../run-scenarios.mjs"), "utf8");

describe("prepared service image consumption", () => {
  it("builds once before activation and consumes only its exact run-owned image", async () => {
    const source = runtimeSource();
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
    const clients: object[] = [];
    const preparedImageEvidence = {};
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
        preparedImageEvidence,
        createPreparedDockerClient: (...args: unknown[]) => {
          const client = {};
          clients.push(client);
          calls.push(["client", ...args]);
          return client;
        },
        prepareMockServerService: (...args: unknown[]) => {
          calls.push(["prepare", ...args]);
          return { imageId: image.replace("sha256:", "sha256-") };
        },
        preparedDockerClient: {},
        preparedDockerClientRequiresOuterHostRetirement: () => false,
        capability: {
          binding: {
            privateStorage: { root: "/fixed" },
            dockerEnvironment: {},
            dockerExecutable: "/docker",
          },
        },
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
    expect(calls.map(([kind]) => kind)).toEqual(["base", "client", "prepare"]);
    expect(calls[1]?.[1]).toBe(preparedImageEvidence);
    expect((calls[2]?.[1] as { deadline: number }).deadline).toBe(300_100);
    expect((calls[2]?.[1] as { dockerClient: object }).dockerClient).toBe(
      clients[0],
    );
    await expect(functions.buildMockServerImage(plan, signal)).resolves.toBe(
      image.replace("sha256:", "sha256-"),
    );
    expect(calls[3]).toEqual([
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

const lifecycleFixture = () => {
  const source = runtimeSource();
  const start = source.indexOf("const buildImage =");
  const end = source.indexOf("const createNetwork =", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const calls: unknown[][] = [];
  const clients: { pending: boolean; uncertain: boolean }[] = [];
  const globalClient = { pending: false, uncertain: false };
  const state = {
    failCreation: false,
    failPreparation: false,
    failRetirement: false,
    now: 100,
  };
  const failure = new Error("fixed-original-failure");
  const plans = ["0123456789abcdef", "fedcba9876543210"].map((runId) => ({
    runId,
    baseImage: "base",
    imageTag: `${runId}:candidate`,
    mockServerImage: "base",
    mockServerImageTag: `${runId}:mockserver`,
  }));
  const images = new Map();
  const functions = runInNewContext(
    `${source.slice(start, end)}; ({ prepareMockServerImage, buildImage, retireMockServerImage, requireSettledMockServerClients })`,
    {
      preparedDockerClient: globalClient,
      preparedImageEvidence: {},
      preparedImageFor: () => undefined,
      capability: {
        binding: {
          privateStorage: { root: "/fixed" },
          dockerExecutable: "/docker",
          dockerEnvironment: {},
        },
      },
      mockServerControls: new Map(
        plans.map(({ runId }) => [
          runId,
          { material: {}, expectations: Buffer.from("[]") },
        ]),
      ),
      mockServerBuiltImages: images,
      createPreparedDockerClient: () => {
        if (state.failCreation) throw failure;
        const client = { pending: false, uncertain: false };
        clients.push(client);
        return client;
      },
      preparedDockerClientRequiresOuterHostRetirement: (
        client: typeof globalClient,
      ) => client.uncertain,
      markPreparedDockerClientForOuterHostRetirement: (
        client: typeof globalClient,
      ) => {
        client.uncertain = true;
      },
      prepareMockServerService: (input: {
        dockerClient: typeof globalClient;
        runId: string;
      }) => {
        expect(images.get(input.runId)?.client).toBe(input.dockerClient);
        expect(input.dockerClient.pending).toBe(false);
        input.dockerClient.pending = true;
        if (state.failPreparation) throw failure;
        return { imageId: `sha256-${"a".repeat(64)}` };
      },
      stageBuildContext: () => ({
        context: "/fixed",
        requiresHarnessBuildContextBound: false,
      }),
      buildPreparedDockerImage: (client: typeof globalClient) => {
        expect(client).toBe(globalClient);
        expect(client.pending).toBe(false);
        calls.push(["candidate", client]);
        return "candidate-image";
      },
      retirePreparedDockerImage: (
        client: typeof globalClient,
        options: unknown,
      ) => {
        calls.push(["retire", client, options]);
        if (state.failRetirement) throw failure;
        expect(client.pending).toBe(true);
        client.pending = false;
      },
      closePreparedDockerClient: (client: typeof globalClient) => {
        expect(client.pending).toBe(false);
        calls.push(["close", client]);
      },
      performance: { now: () => state.now },
      remainingIntegrationOperationMilliseconds: (value: number) => value,
      scenarioTimeoutMilliseconds: 300_000,
      IMAGE_PREPARATION_LIMITS: {
        maximumPreparationMilliseconds: 300_000,
        maximumTeardownMilliseconds: 5_000,
      },
    },
  );
  return {
    source,
    functions,
    state,
    failure,
    calls,
    clients,
    globalClient,
    plans,
    images,
  };
};

describe("final prepared image retirement timer", () => {
  it("the real timeout rejects a fractional duration before retirement", () => {
    expect(() => AbortSignal.timeout(19.5)).toThrow(RangeError);
  });
  it.each([
    [0, 30_000],
    [0.5, 29_999],
    [29_980.5, 19],
    [29_999.5, null],
    [30_000, null],
    [30_001, null],
  ])(
    "bounds the final timer after %s ms without extending the original deadline",
    async (elapsed, expected) => {
      const source = runtimeSource();
      const start = source.indexOf("  let cleanupError;");
      const end = source.indexOf("  try {\n    for (const material", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const calls: unknown[][] = [];
      const helperStart = source.indexOf("const mockServerRetirementSignal =");
      const helperEnd = source.indexOf(
        "const requireSettledMockServerClients",
        helperStart,
      );
      expect(helperStart).toBeGreaterThan(0);
      expect(helperEnd).toBeGreaterThan(helperStart);
      let clockReads = 0;
      const primary = new Error("fixed-primary");
      const result = await runInNewContext(
        `${source.slice(helperStart, helperEnd)}; (async () => { let primaryError = primary; let retirementRequired = false; ${source.slice(start, end)}; return { primaryError, cleanupError, retirementRequired }; })()`,
        {
          primary,
          plans: ["first", "second"],
          mockServerBuiltImages: new Map([["first", {}]]),
          requireSettledMockServerClients: () => undefined,
          remainingIntegrationOperationMilliseconds: () => 30_000,
          performance: { now: () => 100 + (clockReads++ === 0 ? 0 : elapsed) },
          AbortSignal: {
            timeout: (budget: number) => {
              calls.push(["timer", budget]);
              return AbortSignal.timeout(budget);
            },
          },
          retireMockServerImage: (...args: unknown[]) =>
            calls.push(["retire", ...args]),
        },
      );
      expect(result.primaryError).toBe(primary);
      if (expected === null) {
        expect(calls).toEqual([]);
        expect(result.cleanupError.message).toBe("integration.images.deadline");
        expect(result.retirementRequired).toBe(true);
      } else {
        expect(calls[0]).toEqual(["timer", expected]);
        expect(
          calls
            .slice(1)
            .map(([kind, plan, signal, deadline]) => [
              kind,
              plan,
              signal instanceof AbortSignal,
              deadline,
            ]),
        ).toEqual([
          ["retire", "first", true, 30_100],
          ["retire", "second", true, 30_100],
        ]);
        expect(result.cleanupError).toBeUndefined();
        expect(result.retirementRequired).toBe(false);
      }
    },
  );
});

describe("existing prepared image client lifecycle", () => {
  it("keeps two sequential Mock pending images separate from candidate building and retires before closing", async () => {
    const f = lifecycleFixture();
    const signal = {};
    for (const plan of f.plans)
      await f.functions.prepareMockServerImage(plan, signal);
    expect(f.clients).toHaveLength(2);
    expect(f.clients[0]).not.toBe(f.clients[1]);
    await expect(f.functions.buildImage(f.plans[0], signal)).resolves.toBe(
      "candidate-image",
    );
    for (const plan of f.plans)
      await f.functions.retireMockServerImage(plan, signal, 30_100);
    expect(f.calls.map(([kind]) => kind)).toEqual([
      "candidate",
      "retire",
      "close",
      "retire",
      "close",
    ]);
    for (const [index, client] of f.clients.entries()) {
      expect(f.calls[1 + index * 2]).toEqual([
        "retire",
        client,
        {
          deadline: 25_100,
          imageId: `sha256-${"a".repeat(64)}`,
          signal,
          tag: f.plans[index]!.mockServerImageTag,
        },
      ]);
    }
    expect(f.images.size).toBe(0);
    expect(f.globalClient.uncertain).toBe(false);
  });
  it.each(["failCreation", "failPreparation"] as const)(
    "preserves unknown %s and refuses every sibling retirement or new build",
    async (phase) => {
      const f = lifecycleFixture();
      await f.functions.prepareMockServerImage(f.plans[0], {});
      f.state[phase] = true;
      await expect(
        f.functions.prepareMockServerImage(f.plans[1], {}),
      ).rejects.toBe(f.failure);
      expect(f.globalClient.uncertain).toBe(true);
      for (const plan of f.plans)
        await expect(
          f.functions.retireMockServerImage(plan, {}, 30_100),
        ).rejects.toThrow("integration.controller.unsettled-operation");
      await expect(
        f.functions.prepareMockServerImage(f.plans[0], {}),
      ).rejects.toThrow("integration.controller.unsettled-operation");
      await expect(f.functions.buildImage(f.plans[0], {})).rejects.toThrow(
        "integration.controller.unsettled-operation",
      );
      expect(f.calls).toEqual([]);
      expect(f.images.size).toBe(phase === "failPreparation" ? 2 : 1);
    },
  );
  it("preserves failed retirement identity and forbids subsequent sibling mutation", async () => {
    const f = lifecycleFixture();
    for (const plan of f.plans)
      await f.functions.prepareMockServerImage(plan, {});
    f.state.failRetirement = true;
    await expect(
      f.functions.retireMockServerImage(f.plans[0], {}, 30_100),
    ).rejects.toBe(f.failure);
    await expect(
      f.functions.retireMockServerImage(f.plans[1], {}, 30_100),
    ).rejects.toThrow("integration.controller.unsettled-operation");
    expect(f.calls.map(([kind]) => kind)).toEqual(["retire"]);
    expect(f.images.size).toBe(2);
  });
  it("refuses a settled sibling retirement when any other client is uncertain", async () => {
    const f = lifecycleFixture();
    for (const plan of f.plans)
      await f.functions.prepareMockServerImage(plan, {});
    f.clients[1]!.uncertain = true;
    await expect(
      f.functions.retireMockServerImage(f.plans[0], {}, 30_100),
    ).rejects.toThrow("integration.controller.unsettled-operation");
    expect(f.globalClient.uncertain).toBe(true);
    expect(f.calls).toEqual([]);
    expect(f.images.size).toBe(2);
  });
});

describe("preactivation image settlement", () => {
  it("caps image retirement and closure at the original first-removal cutoff", async () => {
    const source = runtimeSource();
    const start = source.indexOf("  let removalSignal;");
    const end = source.indexOf("  return {", start);
    const removalStart = source.indexOf("    removeImage:", end);
    const removalEnd = source.indexOf("    removeContext:", removalStart);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(removalEnd).toBeGreaterThan(removalStart);
    let now = 100;
    const calls: unknown[][] = [];
    const functions = runInNewContext(
      `(() => { ${source.slice(start, end)}; return { boundedRemovalSignal, ${source.slice(removalStart, removalEnd)} }; })()`,
      {
        performance: { now: () => now },
        ISOLATION_EXECUTOR_LIMITS: { cleanup: { removalMilliseconds: 50_000 } },
        AbortSignal: {
          timeout: (budget: number) => {
            calls.push(["timer", budget]);
            return "signal";
          },
        },
        plan: { mockServerImageTag: "mock" },
        remainingIntegrationOperationMilliseconds: () => 30_000,
        retireMockServerImage: (...args: unknown[]) => {
          calls.push(["retire", ...args]);
        },
        ignoreMissing: () => {
          throw new Error("unexpected-raw-removal");
        },
      },
    );
    functions.boundedRemovalSignal();
    now = 49_100;
    await functions.removeImage("mock");
    expect(calls).toEqual([
      ["timer", 50_000],
      ["retire", { mockServerImageTag: "mock" }, "signal", 50_100],
    ]);
  });
  it("drains a settled preactivation prefix under one unchanged terminal deadline without replacing its primary failure", async () => {
    const f = lifecycleFixture();
    for (const plan of f.plans)
      await f.functions.prepareMockServerImage(plan, {});
    const start = f.source.indexOf("  let cleanupError;");
    const end = f.source.indexOf("  try {\n    for (const material", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const deadlines: number[] = [];
    const helperStart = f.source.indexOf("const mockServerRetirementSignal =");
    const helperEnd = f.source.indexOf(
      "const requireSettledMockServerClients",
      helperStart,
    );
    const result = await runInNewContext(
      `${f.source.slice(helperStart, helperEnd)}; (async () => { let primaryError = failure; let retirementRequired = false; ${f.source.slice(start, end)}; return {primaryError, cleanupError, retirementRequired}; })()`,
      {
        failure: f.failure,
        plans: f.plans,
        mockServerBuiltImages: f.images,
        requireSettledMockServerClients:
          f.functions.requireSettledMockServerClients,
        retireMockServerImage: f.functions.retireMockServerImage,
        remainingIntegrationOperationMilliseconds: (
          budget: number,
          terminal: boolean,
        ) => {
          expect(terminal).toBe(true);
          deadlines.push(budget);
          return budget;
        },
        performance: { now: () => f.state.now },
        AbortSignal: {
          timeout: (budget: number) => {
            expect(budget).toBe(30_000);
            return "terminal-signal";
          },
        },
      },
    );
    expect(result.primaryError).toBe(f.failure);
    expect(result.cleanupError).toBeUndefined();
    expect(result.retirementRequired).toBe(false);
    expect(deadlines).toEqual([30_000]);
    expect(f.calls.map(([kind]) => kind)).toEqual([
      "retire",
      "close",
      "retire",
      "close",
    ]);
    expect(
      f.calls
        .filter(([kind]) => kind === "retire")
        .map(([, , options]) => (options as { deadline: number }).deadline),
    ).toEqual([25_100, 25_100]);
    expect(f.images.size).toBe(0);
  });
});
