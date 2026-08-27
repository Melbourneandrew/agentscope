import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { CandidateEvidence } from "./artifacts.js";
import {
  compileIsolationEvidence,
  compileIsolationExecutionPolicy,
  createIsolationPlan,
  executeIsolationPlan,
  ISOLATION_EXECUTOR_LIMITS,
  type IsolationDriver,
} from "./isolation.js";
import { compileCapabilityManifest } from "./manifest.js";

const integrationRoot = resolve(import.meta.dirname, "..");
const manifest = compileCapabilityManifest(
  JSON.parse(
    readFileSync(resolve(integrationRoot, "capability-manifest.json"), "utf8"),
  ),
);
const candidate = {
  evidenceVersion: 1,
  bundleIdentity: `sha256-${"1".repeat(64)}`,
  candidateRevision: "2".repeat(40),
  platform: { os: "linux", architecture: "arm64", nodeVersion: "22.0.0" },
  lockfile: {
    fileName: "pnpm-lock.yaml",
    bytes: 1,
    sha256: `sha256-${"3".repeat(64)}`,
  },
  artifacts: [
    {
      id: "agentscope-cli",
      kind: "npm-tarball",
      fileName: "agentscope-cli.tgz",
      bytes: 1,
      sha256: `sha256-${"4".repeat(64)}`,
    },
  ],
  scenarioNetworkPolicy: "offline-no-package-or-registry-download",
} satisfies CandidateEvidence;

const preparedIdentityFor = (image: string, fill: string) => ({
  image,
  platform: { os: "linux", architecture: "amd64" },
  manifestDigest: `sha256:${fill.repeat(64)}`,
  configDigest: `sha256:${fill.toUpperCase().repeat(64)}`.toLowerCase(),
});

const planFor = (token: string) =>
  createIsolationPlan({
    scenario: manifest.scenarios[0]!,
    manifestIdentity: manifest.manifestIdentity,
    candidate,
    runToken: token,
    baseImageIdentity: preparedIdentityFor(manifest.scenarios[0]!.image, "a"),
    mockServerImageIdentity: preparedIdentityFor(
      manifest.scenarios[0]!.mockServerImage,
      "b",
    ),
    selection: {
      selectionVersion: 2,
      manifestIdentity: manifest.manifestIdentity,
      mode: "scenario",
      selector: { scenarioId: manifest.scenarios[0]!.scenarioId },
      scenarioIds: [manifest.scenarios[0]!.scenarioId],
    },
    maximumParallelScenarios: 2,
    scenarioTimeoutMilliseconds: 300_000,
  });

const executionPolicyFor = (scenarioId = "fixture-process-smoke") => ({
  policyVersion: 1,
  runtimeInspection: {
    outcome: "complete",
    identity: {
      executor: "docker",
      clientVersion: "29.0.0",
      engine: {
        kind: "docker-engine",
        product: "Docker Engine - Community",
        version: "29.0.0",
        apiVersion: "1.52",
        operatingSystem: "Ubuntu 24.04 LTS",
        osType: "linux",
        architecture: "x86_64",
      },
      containerRuntime: { name: "runc", version: "1.3.0" },
      containerdVersion: "2.2.0",
    },
  },
  selection: {
    selectionVersion: 2,
    manifestIdentity: manifest.manifestIdentity,
    mode: "scenario",
    selector: { scenarioId },
    scenarioIds: [scenarioId],
  },
  maximumParallelScenarios: 2,
  scenarioTimeoutMilliseconds: 300_000,
  cleanupTimeouts: ISOLATION_EXECUTOR_LIMITS.cleanup,
  containers: ISOLATION_EXECUTOR_LIMITS.containers,
  requests: ISOLATION_EXECUTOR_LIMITS.requests,
});

const emptyCleanupInventory = () => ({
  containers: 0,
  networks: 0,
  images: 0,
  volumes: 0,
  buildContexts: 0,
  activeRunMarkers: 0,
});

const driver = () => {
  const calls: string[] = [];
  const buildImage = vi.fn<IsolationDriver["buildImage"]>(() => {
    calls.push("build");
    return Promise.resolve(`sha256-${"5".repeat(64)}`);
  });
  const runScenario = vi.fn<IsolationDriver["runScenario"]>(() => {
    calls.push("scenario");
    return Promise.resolve();
  });
  const removeContainer = vi.fn<IsolationDriver["removeContainer"]>((name) => {
    calls.push(`container:${name}`);
    return Promise.resolve();
  });
  const inspectExecutionPolicy = vi.fn<
    IsolationDriver["inspectExecutionPolicy"]
  >((plan) => Promise.resolve(executionPolicyFor(plan.scenarioId)));
  const recordEvidence = vi.fn<IsolationDriver["recordEvidence"]>(() => {
    calls.push("evidence");
    return Promise.resolve();
  });
  const inspectCleanup = vi.fn<IsolationDriver["inspectCleanup"]>(() =>
    Promise.resolve(emptyCleanupInventory()),
  );
  const implementation: IsolationDriver = {
    inspectExecutionPolicy,
    buildImage,
    buildMockServerImage: vi.fn(() => {
      calls.push("build-mockserver");
      return Promise.resolve(`sha256-${"6".repeat(64)}`);
    }),
    createNetwork: vi.fn(() => {
      calls.push("network");
      return Promise.resolve();
    }),
    startCollector: vi.fn(() => {
      calls.push("collector");
      return Promise.resolve();
    }),
    startRetrieval: vi.fn(() => {
      calls.push("retrieval");
      return Promise.resolve();
    }),
    startMockServer: vi.fn(() => {
      calls.push("mockserver");
      return Promise.resolve();
    }),
    runScenario,
    recordEvidence,
    removeContainer,
    removeNetwork: vi.fn((name) => {
      calls.push(`remove-network:${name}`);
      return Promise.resolve();
    }),
    removeImage: vi.fn((name) => {
      calls.push(`image:${name}`);
      return Promise.resolve();
    }),
    removeContext: vi.fn((runId) => {
      calls.push(`context:${runId}`);
      return Promise.resolve();
    }),
    inspectCleanup,
  };
  return {
    buildImage,
    calls,
    implementation,
    inspectCleanup,
    inspectExecutionPolicy,
    recordEvidence,
    removeContainer,
    runScenario,
  };
};

describe("scenario isolation", () => {
  it("creates disjoint immutable plans with no host mounts", () => {
    const first = planFor("0123456789abcdef");
    const second = planFor("fedcba9876543210");
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.networkName).not.toBe(second.networkName);
    expect(first.collectorName).not.toBe(second.collectorName);
    expect(first.retrievalName).not.toBe(second.retrievalName);
    expect(first.mockServerName).not.toBe(second.mockServerName);
    expect(first.scenarioName).not.toBe(second.scenarioName);
    expect(first.tmpfsMounts).toEqual([
      "/home/agentscope",
      "/harness-home",
      "/agentscope-home",
      "/worktree",
      "/ledger",
      "/tmp",
    ]);
    expect(() => planFor("not-a-token")).toThrow("integration.isolation.plan");
  });

  it("records digest-bound evidence and always tears down after success", async () => {
    const fixture = driver();
    const evidence = await executeIsolationPlan(
      planFor("0123456789abcdef"),
      fixture.implementation,
      new AbortController().signal,
    );
    expect(evidence.outcome).toBe("passed");
    expect(evidence.evidenceVersion).toBe(2);
    expect(evidence.hostMountCount).toBe(0);
    expect(evidence.readOnlyRootFilesystem).toBe(true);
    expect(evidence.builtImageDigest).toBe(`sha256-${"5".repeat(64)}`);
    expect(evidence.builtMockServerImageDigest).toBe(
      `sha256-${"6".repeat(64)}`,
    );
    expect(evidence.executionPolicy).toEqual(executionPolicyFor());
    expect(evidence.cleanup).toEqual({
      outcome: "complete",
      removalFailureCount: 0,
      remaining: emptyCleanupInventory(),
    });
    expect(fixture.calls).toEqual([
      "build",
      "build-mockserver",
      "network",
      "collector",
      "retrieval",
      "mockserver",
      "scenario",
      "container:agentscope-int-0123456789abcdef-scenario",
      "container:agentscope-int-0123456789abcdef-collector",
      "container:agentscope-int-0123456789abcdef-retrieval",
      "container:agentscope-int-0123456789abcdef-mockserver",
      "remove-network:agentscope-int-0123456789abcdef-network",
      "image:agentscope-int-0123456789abcdef:candidate",
      "image:agentscope-int-0123456789abcdef:mockserver",
      "context:0123456789abcdef",
      "evidence",
    ]);
  });

  it("tears down and records failure and interruption outcomes", async () => {
    const failed = driver();
    failed.runScenario.mockRejectedValueOnce(new Error("scenario failed"));
    await expect(
      executeIsolationPlan(
        planFor("0123456789abcdef"),
        failed.implementation,
        new AbortController().signal,
      ),
    ).rejects.toThrow("scenario failed");
    expect(failed.calls).toContain("evidence");
    const interrupted = driver();
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeIsolationPlan(
        planFor("fedcba9876543210"),
        interrupted.implementation,
        controller.signal,
      ),
    ).rejects.toThrow("integration.isolation.interrupted");
    expect(interrupted.calls).not.toContain("build");
    expect(interrupted.calls.at(-1)).toBe("evidence");
  });

  it("freezes success and failure outcomes before cleanup-only aborts", async () => {
    const passed = driver();
    const passedController = new AbortController();
    passed.removeContainer.mockImplementationOnce(() => {
      passedController.abort();
      return Promise.resolve();
    });
    await expect(
      executeIsolationPlan(
        planFor("0123456789abcdef"),
        passed.implementation,
        passedController.signal,
      ),
    ).resolves.toMatchObject({ outcome: "passed" });
    expect(passed.recordEvidence.mock.calls[0]?.[0].outcome).toBe("passed");

    const failed = driver();
    const failedController = new AbortController();
    failed.runScenario.mockRejectedValueOnce(new Error("scenario failed"));
    failed.removeContainer.mockImplementationOnce(() => {
      failedController.abort();
      return Promise.resolve();
    });
    await expect(
      executeIsolationPlan(
        planFor("fedcba9876543210"),
        failed.implementation,
        failedController.signal,
      ),
    ).rejects.toThrow("scenario failed");
    expect(failed.recordEvidence.mock.calls[0]?.[0].outcome).toBe("failed");
  });
});

describe("scenario cleanup evidence", () => {
  it("records unavailable runtime inspection and still tears down", async () => {
    const fixture = driver();
    fixture.inspectExecutionPolicy.mockRejectedValueOnce(
      new Error("runtime inspection failed"),
    );
    await expect(
      executeIsolationPlan(
        planFor("0123456789abcdef"),
        fixture.implementation,
        new AbortController().signal,
      ),
    ).rejects.toThrow("runtime inspection failed");
    expect(fixture.calls).not.toContain("build");
    expect(fixture.calls).toContain("context:0123456789abcdef");
    expect(fixture.calls.at(-1)).toBe("evidence");
    expect(fixture.recordEvidence.mock.calls[0]?.[0]).toMatchObject({
      builtImageDigest: null,
      builtMockServerImageDigest: null,
      executionPolicy: {
        runtimeInspection: { outcome: "unavailable", identity: null },
      },
      cleanup: { outcome: "complete" },
      outcome: "failed",
    });
  });

  it("surfaces cleanup failures after attempting every teardown step", async () => {
    const fixture = driver();
    fixture.removeContainer.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(
      executeIsolationPlan(
        planFor("0123456789abcdef"),
        fixture.implementation,
        new AbortController().signal,
      ),
    ).rejects.toThrow("integration.isolation.cleanup");
    expect(fixture.calls).toContain(
      "remove-network:agentscope-int-0123456789abcdef-network",
    );
    expect(fixture.calls.at(-1)).toBe("evidence");
    expect(fixture.recordEvidence.mock.calls[0]?.[0].cleanup).toEqual({
      outcome: "failed",
      removalFailureCount: 1,
      remaining: emptyCleanupInventory(),
    });
  });

  it("rejects a non-digest image result and still tears down", async () => {
    const fixture = driver();
    fixture.buildImage.mockResolvedValueOnce("latest");
    await expect(
      executeIsolationPlan(
        planFor("0123456789abcdef"),
        fixture.implementation,
        new AbortController().signal,
      ),
    ).rejects.toThrow("integration.isolation.image-digest");
    expect(fixture.calls.at(-1)).toBe("evidence");
    expect(fixture.recordEvidence.mock.calls[0]?.[0]).toMatchObject({
      builtImageDigest: null,
      builtMockServerImageDigest: null,
      outcome: "failed",
    });
  });

  it("records only the image identity established before a later build failure", async () => {
    const fixture = driver();
    fixture.implementation.buildMockServerImage = vi
      .fn<IsolationDriver["buildMockServerImage"]>()
      .mockRejectedValueOnce(new Error("mock image failed"));
    await expect(
      executeIsolationPlan(
        planFor("0123456789abcdef"),
        fixture.implementation,
        new AbortController().signal,
      ),
    ).rejects.toThrow("mock image failed");
    expect(fixture.recordEvidence.mock.calls[0]?.[0]).toMatchObject({
      builtImageDigest: `sha256-${"5".repeat(64)}`,
      builtMockServerImageDigest: null,
      outcome: "failed",
    });
  });
});

describe("scenario evidence validation", () => {
  it("rejects omitted, substituted, secret-shaped, and unbounded executor policy", async () => {
    const invalidPolicies = [
      { ...executionPolicyFor(), runtimeInspection: undefined },
      {
        ...executionPolicyFor(),
        maximumParallelScenarios: 17,
      },
      {
        ...executionPolicyFor(),
        requests: { destinationServerMaximumBytes: 2 * 1024 * 1024 },
      },
      {
        ...executionPolicyFor(),
        containers: {
          ...ISOLATION_EXECUTOR_LIMITS.containers,
          scenario: {
            ...ISOLATION_EXECUTOR_LIMITS.containers.scenario,
            memoryBytes: 64 * 1024 * 1024,
          },
        },
      },
      {
        ...executionPolicyFor(),
        runtimeInspection: {
          ...executionPolicyFor().runtimeInspection,
          identity: {
            ...executionPolicyFor().runtimeInspection.identity,
            engine: {
              ...executionPolicyFor().runtimeInspection.identity.engine,
              operatingSystem: "/Users/operator/secret",
            },
          },
        },
      },
    ];
    for (const policy of invalidPolicies) {
      const fixture = driver();
      fixture.inspectExecutionPolicy.mockResolvedValueOnce(policy);
      await expect(
        executeIsolationPlan(
          planFor("0123456789abcdef"),
          fixture.implementation,
          new AbortController().signal,
        ),
      ).rejects.toThrow("integration.isolation.runtime-policy");
      expect(fixture.calls).toContain(
        "remove-network:agentscope-int-0123456789abcdef-network",
      );
      expect(fixture.calls.at(-1)).toBe("evidence");
      expect(
        fixture.recordEvidence.mock.calls[0]?.[0].executionPolicy
          .runtimeInspection,
      ).toEqual({ outcome: "unavailable", identity: null });
    }
  });

  it("records cleanup proof failure without inventing survivor counts", async () => {
    const fixture = driver();
    fixture.inspectCleanup.mockRejectedValueOnce(
      new Error("proof unavailable"),
    );
    await expect(
      executeIsolationPlan(
        planFor("0123456789abcdef"),
        fixture.implementation,
        new AbortController().signal,
      ),
    ).rejects.toThrow("integration.isolation.cleanup");
    expect(fixture.recordEvidence.mock.calls[0]?.[0].cleanup).toEqual({
      outcome: "verification-failed",
      removalFailureCount: 0,
      remaining: null,
    });
  });
});

describe("compiled scenario evidence", () => {
  it("accepts distro-qualified container runtime versions", () => {
    const input = executionPolicyFor();
    input.runtimeInspection.identity.containerRuntime.version =
      "1.3.4-0ubuntu1~24.04.1";
    expect(
      compileIsolationExecutionPolicy(input).runtimeInspection.identity,
    ).toMatchObject({
      containerRuntime: { version: "1.3.4-0ubuntu1~24.04.1" },
    });
  });
});

const compiledEvidenceFixture = () => {
  const policy = compileIsolationExecutionPolicy(executionPolicyFor());
  return {
    policy,
    evidence: {
      evidenceVersion: 2,
      runId: "0123456789abcdef",
      scenarioId: "fixture-process-smoke",
      manifestIdentity: manifest.manifestIdentity,
      candidateBundleIdentity: `sha256-${"2".repeat(64)}`,
      candidateRevision: "3".repeat(40),
      baseImage: `node@sha256:${"4".repeat(64)}`,
      mockServerImage: `mockserver@sha256:${"5".repeat(64)}`,
      baseImageIdentity: preparedIdentityFor(
        `node@sha256:${"4".repeat(64)}`,
        "a",
      ),
      mockServerImageIdentity: preparedIdentityFor(
        `mockserver@sha256:${"5".repeat(64)}`,
        "b",
      ),
      builtImageDigest: `sha256-${"6".repeat(64)}`,
      builtMockServerImageDigest: `sha256-${"7".repeat(64)}`,
      networkMode: "internal-only",
      hostMountCount: 0,
      readOnlyRootFilesystem: true,
      tmpfsMounts: [...ISOLATION_EXECUTOR_LIMITS.containers.scenario.tmpfs].map(
        ({ path }) => path,
      ),
      executionPolicy: policy,
      cleanup: {
        outcome: "complete",
        removalFailureCount: 0,
        remaining: emptyCleanupInventory(),
      },
      outcome: "passed",
    },
  };
};
const compileWithPreparedAuthority = (
  input: unknown,
  authority: ReturnType<typeof compiledEvidenceFixture>["evidence"],
) =>
  compileIsolationEvidence(input, {
    baseImageIdentity: authority.baseImageIdentity,
    mockServerImageIdentity: authority.mockServerImageIdentity,
  });

describe("prepared OCI identity evidence", () => {
  it("rejects omission and substitution of the canonical tuple", () => {
    const { evidence } = compiledEvidenceFixture();
    const withoutIdentity = { ...evidence } as Partial<typeof evidence>;
    delete withoutIdentity.baseImageIdentity;
    expect(() =>
      compileWithPreparedAuthority(withoutIdentity, evidence),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...evidence,
          baseImageIdentity: {
            ...evidence.baseImageIdentity,
            image: evidence.mockServerImage,
          },
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...evidence,
          baseImageIdentity: {
            ...evidence.baseImageIdentity,
            manifestDigest: `sha256:${"f".repeat(64)}`,
          },
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
  });
});

describe("compiled scenario evidence", () => {
  it("compiles only the closed evidence and policy envelopes", () => {
    const { evidence, policy } = compiledEvidenceFixture();
    expect(compileWithPreparedAuthority(evidence, evidence)).toEqual(evidence);
    expect(() =>
      compileWithPreparedAuthority(
        { ...evidence, credential: "CANARY_SECRET" },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...evidence,
          scenarioId: "different-scenario",
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...evidence,
          executionPolicy: {
            ...policy,
            selection: {
              ...policy.selection,
              manifestIdentity: `sha256-${"9".repeat(64)}`,
            },
          },
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...evidence,
          outcome: "failed",
          executionPolicy: {
            ...policy,
            runtimeInspection: { outcome: "unavailable", identity: null },
          },
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...evidence,
          builtImageDigest: null,
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...evidence,
          executionPolicy: {
            ...policy,
            runtimeInspection: { outcome: "unavailable", identity: null },
          },
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...evidence,
          outcome: "failed",
          builtImageDigest: null,
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(() =>
      compileWithPreparedAuthority(
        {
          ...evidence,
          cleanup: {
            ...evidence.cleanup,
            remaining: { ...emptyCleanupInventory(), containers: 1 },
          },
        },
        evidence,
      ),
    ).toThrow("integration.isolation.evidence");
    expect(
      compileIsolationExecutionPolicy({
        ...executionPolicyFor(),
        selection: {
          selectionVersion: 2,
          manifestIdentity: manifest.manifestIdentity,
          mode: "full",
          selector: {},
          scenarioIds: ["fixture-process-smoke", "fixture-process-smoke"],
        },
      }).selection.scenarioIds,
    ).toEqual(["fixture-process-smoke", "fixture-process-smoke"]);
  });
});
