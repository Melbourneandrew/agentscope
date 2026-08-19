import { describe, expect, it } from "vitest";

import { runOperationalCoordinatorForTesting } from "./operational-coordinator.js";

const emptySnapshot = Object.freeze({
  version: 1 as const,
  nextSequence: 0,
  losses: Object.freeze({ diagnostics: 0, health: 0, checkpoints: 0 }),
  diagnostics: Object.freeze([]),
  health: Object.freeze([]),
  checkpoints: Object.freeze([]),
});

const preloadRequest = Object.freeze({
  kind: "preload" as const,
  homeRoot: "/tmp/agentscope-operational-coordinator-test",
  platform: process.platform,
});

const emit = (value: unknown): string =>
  `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(
    JSON.stringify(value),
  )}));`;

const processIsGone = (processId: number): boolean => {
  try {
    process.kill(processId, 0);
    return false;
  } catch {
    return true;
  }
};

describe("owned operational coordinator process", () => {
  it("reconstructs exact preload and commit responses", async () => {
    await expect(
      runOperationalCoordinatorForTesting(preloadRequest, 1_000, {
        program: emit({ kind: "preload", value: emptySnapshot }),
      }),
    ).resolves.toEqual(emptySnapshot);

    const evidence = Object.freeze({
      diagnostics: Object.freeze([]),
      health: Object.freeze([
        Object.freeze({
          scope: "hook" as const,
          stage: "routing" as const,
          outcome: "no-route" as const,
          configurationGeneration: 0,
          policyMode: "baseline" as const,
          receipt: null,
        }),
      ]),
      checkpoints: Object.freeze([]),
    });
    const result = Object.freeze({
      recorded: true,
      code: "recorded" as const,
      losses: Object.freeze({ diagnostics: 0, health: 0, checkpoints: 0 }),
      checkpoints: Object.freeze([
        Object.freeze({
          connectionId:
            "destination-connection-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          advanced: true,
          code: "advanced" as const,
          acknowledgedExclusivePosition: 1,
        }),
      ]),
      diagnostics: Object.freeze([
        Object.freeze({
          code: "no-route" as const,
          severity: "info" as const,
          configurationGeneration: 0,
        }),
      ]),
    });
    await expect(
      runOperationalCoordinatorForTesting(
        Object.freeze({
          kind: "commit" as const,
          homeRoot: preloadRequest.homeRoot,
          platform: process.platform,
          evidence,
        }),
        1_000,
        { program: emit({ kind: "commit", value: result }) },
      ),
    ).resolves.toEqual(result);
    const unavailableResult = Object.freeze({
      recorded: false,
      code: "unavailable" as const,
      losses: Object.freeze({ diagnostics: 0, health: 0, checkpoints: 0 }),
      checkpoints: Object.freeze([]),
      diagnostics: Object.freeze([]),
    });
    await expect(
      runOperationalCoordinatorForTesting(
        Object.freeze({
          kind: "commit" as const,
          homeRoot: preloadRequest.homeRoot,
          platform: process.platform,
          evidence,
        }),
        1_000,
        { program: emit({ kind: "commit", value: unavailableResult }) },
      ),
    ).resolves.toEqual(unavailableResult);
  });
});

describe("operational coordinator containment", () => {
  it("kills and joins hanging, aborted, malformed, and oversized children", async () => {
    let hangingProcessId = 0;
    await expect(
      runOperationalCoordinatorForTesting(preloadRequest, 20, {
        program: "process.stdin.resume(); setInterval(() => {}, 1000);",
        onSpawn: (value) => {
          hangingProcessId = value ?? 0;
        },
      }),
    ).rejects.toThrow("core.operational-coordinator.unavailable");
    const hostileSignal = {
      aborted: false,
      addEventListener() {},
      removeEventListener() {
        throw new Error("CANARY_SECRET");
      },
    } as unknown as AbortSignal;
    await expect(
      runOperationalCoordinatorForTesting(
        preloadRequest,
        1_000,
        { program: emit({ kind: "preload", value: emptySnapshot }) },
        hostileSignal,
      ),
    ).rejects.toThrow("core.operational-coordinator.unavailable");
    expect(hangingProcessId).toBeGreaterThan(0);
    expect(processIsGone(hangingProcessId)).toBe(true);

    const controller = new AbortController();
    let abortedProcessId = 0;
    const aborted = runOperationalCoordinatorForTesting(
      preloadRequest,
      1_000,
      {
        program: "process.stdin.resume(); setInterval(() => {}, 1000);",
        onSpawn: (value) => {
          abortedProcessId = value ?? 0;
        },
      },
      controller.signal,
    );
    controller.abort();
    await expect(aborted).rejects.toThrow(
      "core.operational-coordinator.unavailable",
    );
    expect(processIsGone(abortedProcessId)).toBe(true);
  });
});

describe("operational coordinator message containment", () => {
  it("rejects malformed, inconsistent, and oversized messages", async () => {
    await expect(
      runOperationalCoordinatorForTesting(
        {
          kind: "commit",
          homeRoot: preloadRequest.homeRoot,
          platform: process.platform,
          evidence: "x".repeat(600_000),
        } as never,
        1_000,
        {},
      ),
    ).rejects.toThrow("core.operational-coordinator.unavailable");
    for (const field of ["checkpoints", "diagnostics"] as const) {
      await expect(
        runOperationalCoordinatorForTesting(
          {
            kind: "commit",
            homeRoot: preloadRequest.homeRoot,
            platform: process.platform,
            evidence: { diagnostics: [], health: [], checkpoints: [] },
          },
          1_000,
          {
            program: emit({
              kind: "commit",
              value: {
                recorded: false,
                code: "unavailable",
                losses: { diagnostics: 0, health: 0, checkpoints: 0 },
                checkpoints:
                  field === "checkpoints"
                    ? [
                        {
                          connectionId:
                            "destination-connection-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                          advanced: false,
                          code: "unavailable",
                          acknowledgedExclusivePosition: null,
                        },
                      ]
                    : [],
                diagnostics:
                  field === "diagnostics"
                    ? [
                        {
                          code: "no-route",
                          severity: "info",
                          configurationGeneration: 0,
                        },
                      ]
                    : [],
              },
            }),
          },
        ),
      ).rejects.toThrow("core.operational-coordinator.unavailable");
    }
    await expect(
      runOperationalCoordinatorForTesting(preloadRequest, 1_000, {
        program: emit({ kind: "preload", value: { version: 2 } }),
      }),
    ).rejects.toThrow("core.operational-coordinator.unavailable");
    await expect(
      runOperationalCoordinatorForTesting(preloadRequest, 1_000, {
        program: emit(null),
      }),
    ).rejects.toThrow("core.operational-coordinator.unavailable");
    await expect(
      runOperationalCoordinatorForTesting(preloadRequest, 1_000, {
        program: emit({ kind: "commit", value: emptySnapshot }),
      }),
    ).rejects.toThrow("core.operational-coordinator.unavailable");
    await expect(
      runOperationalCoordinatorForTesting(
        {
          kind: "commit",
          homeRoot: preloadRequest.homeRoot,
          platform: process.platform,
          evidence: {
            diagnostics: [],
            health: [],
            checkpoints: [],
          },
        },
        1_000,
        {
          program: emit({
            kind: "commit",
            value: {
              recorded: true,
              code: "unavailable",
              losses: { diagnostics: 0, health: 0, checkpoints: 0 },
              checkpoints: [],
              diagnostics: [],
            },
          }),
        },
      ),
    ).rejects.toThrow("core.operational-coordinator.unavailable");
    await expect(
      runOperationalCoordinatorForTesting(preloadRequest, 1_000, {
        program:
          'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("x".repeat(600000)));',
      }),
    ).rejects.toThrow("core.operational-coordinator.unavailable");
  });
});

describe("operational coordinator admission", () => {
  it("rejects invalid admission without spawning work", async () => {
    let spawnCalls = 0;
    await expect(
      runOperationalCoordinatorForTesting(preloadRequest, 0, {
        onSpawn: () => {
          spawnCalls += 1;
        },
      }),
    ).rejects.toThrow("core.operational-coordinator.unavailable");
    const controller = new AbortController();
    controller.abort();
    await expect(
      runOperationalCoordinatorForTesting(
        preloadRequest,
        1_000,
        {
          onSpawn: () => {
            spawnCalls += 1;
          },
        },
        controller.signal,
      ),
    ).rejects.toThrow("core.operational-coordinator.unavailable");
    const hostileSignal = Object.defineProperty({}, "aborted", {
      get() {
        throw new Error("CANARY_SECRET");
      },
    }) as AbortSignal;
    await expect(
      runOperationalCoordinatorForTesting(
        preloadRequest,
        1_000,
        {},
        hostileSignal,
      ),
    ).rejects.toThrow("core.operational-coordinator.unavailable");
    expect(spawnCalls).toBe(0);
  });
});
