import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { CandidateEvidence } from "./artifacts.js";
import {
  createIsolationPlan,
  executeIsolationPlan,
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

const planFor = (token: string) =>
  createIsolationPlan({
    scenario: manifest.scenarios[0]!,
    manifestIdentity: manifest.manifestIdentity,
    candidate,
    runToken: token,
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
  const implementation: IsolationDriver = {
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
    recordEvidence: vi.fn(() => {
      calls.push("evidence");
      return Promise.resolve();
    }),
    removeContainer,
    removeNetwork: vi.fn((name) => {
      calls.push(`remove-network:${name}`);
      return Promise.resolve();
    }),
    removeImage: vi.fn((name) => {
      calls.push(`image:${name}`);
      return Promise.resolve();
    }),
  };
  return { buildImage, calls, implementation, removeContainer, runScenario };
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
    expect(evidence.hostMountCount).toBe(0);
    expect(evidence.readOnlyRootFilesystem).toBe(true);
    expect(evidence.builtImageDigest).toBe(`sha256-${"5".repeat(64)}`);
    expect(evidence.builtMockServerImageDigest).toBe(
      `sha256-${"6".repeat(64)}`,
    );
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
  });
});
