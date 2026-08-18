import { z } from "zod";

import type { CandidateEvidence } from "./artifacts.js";
import { deepFreeze } from "./canonical.js";
import type { CapabilityScenario } from "./manifest.js";

const runToken = z.string().regex(/^[a-f\d]{16}$/u);
const digest = z.string().regex(/^sha256-[a-f\d]{64}$/u);
const imageReference = z
  .string()
  .regex(/^[a-z0-9][a-z0-9./_-]{0,159}@sha256:[a-f\d]{64}$/u);

export const SCENARIO_TMPFS_MOUNTS = deepFreeze([
  "/home/agentscope",
  "/harness-home",
  "/agentscope-home",
  "/worktree",
  "/ledger",
  "/tmp",
] as const);

export interface IsolationPlan {
  readonly runId: string;
  readonly scenarioId: string;
  readonly manifestIdentity: string;
  readonly candidateBundleIdentity: string;
  readonly candidateRevision: string;
  readonly baseImage: string;
  readonly mockServerImage: string;
  readonly imageTag: string;
  readonly mockServerImageTag: string;
  readonly networkName: string;
  readonly collectorName: string;
  readonly retrievalName: string;
  readonly mockServerName: string;
  readonly scenarioName: string;
  readonly tmpfsMounts: readonly string[];
}

export interface IsolationEvidence {
  readonly evidenceVersion: 1;
  readonly runId: string;
  readonly scenarioId: string;
  readonly manifestIdentity: string;
  readonly candidateBundleIdentity: string;
  readonly candidateRevision: string;
  readonly baseImage: string;
  readonly mockServerImage: string;
  readonly builtImageDigest: string;
  readonly builtMockServerImageDigest: string;
  readonly networkMode: "internal-only";
  readonly hostMountCount: 0;
  readonly readOnlyRootFilesystem: true;
  readonly tmpfsMounts: readonly string[];
  readonly outcome: "passed" | "failed" | "interrupted";
}

export interface IsolationDriver {
  buildImage(plan: IsolationPlan): Promise<string>;
  buildMockServerImage(plan: IsolationPlan): Promise<string>;
  createNetwork(plan: IsolationPlan): Promise<void>;
  startCollector(plan: IsolationPlan): Promise<void>;
  startRetrieval(plan: IsolationPlan): Promise<void>;
  startMockServer(plan: IsolationPlan): Promise<void>;
  runScenario(plan: IsolationPlan, signal: AbortSignal): Promise<void>;
  recordEvidence(evidence: IsolationEvidence): Promise<void>;
  removeContainer(name: string): Promise<void>;
  removeNetwork(name: string): Promise<void>;
  removeImage(tag: string): Promise<void>;
}

export const createIsolationPlan = (input: {
  readonly scenario: CapabilityScenario;
  readonly manifestIdentity: string;
  readonly candidate: CandidateEvidence;
  readonly runToken: string;
}): Readonly<IsolationPlan> => {
  const parsedToken = runToken.safeParse(input.runToken);
  if (
    !parsedToken.success ||
    !digest.safeParse(input.manifestIdentity).success ||
    !imageReference.safeParse(input.scenario.image).success ||
    !imageReference.safeParse(input.scenario.mockServerImage).success
  )
    throw new Error("integration.isolation.plan");
  const prefix = `agentscope-int-${parsedToken.data}`;
  return deepFreeze({
    runId: parsedToken.data,
    scenarioId: input.scenario.scenarioId,
    manifestIdentity: input.manifestIdentity,
    candidateBundleIdentity: input.candidate.bundleIdentity,
    candidateRevision: input.candidate.candidateRevision,
    baseImage: input.scenario.image,
    mockServerImage: input.scenario.mockServerImage,
    imageTag: `${prefix}:candidate`,
    mockServerImageTag: `${prefix}:mockserver`,
    networkName: `${prefix}-network`,
    collectorName: `${prefix}-collector`,
    retrievalName: `${prefix}-retrieval`,
    mockServerName: `${prefix}-mockserver`,
    scenarioName: `${prefix}-scenario`,
    tmpfsMounts: SCENARIO_TMPFS_MOUNTS,
  });
};

const cleanup = async (
  plan: IsolationPlan,
  driver: IsolationDriver,
): Promise<void> => {
  const operations = [
    () => driver.removeContainer(plan.scenarioName),
    () => driver.removeContainer(plan.collectorName),
    () => driver.removeContainer(plan.retrievalName),
    () => driver.removeContainer(plan.mockServerName),
    () => driver.removeNetwork(plan.networkName),
    () => driver.removeImage(plan.imageTag),
    () => driver.removeImage(plan.mockServerImageTag),
  ];
  const failures: unknown[] = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new Error("integration.isolation.cleanup");
};

const outcomeFor = (
  signal: AbortSignal,
  error: unknown,
): IsolationEvidence["outcome"] => {
  if (signal.aborted) return "interrupted";
  return error === undefined ? "passed" : "failed";
};

export const executeIsolationPlan = async (
  plan: IsolationPlan,
  driver: IsolationDriver,
  signal: AbortSignal,
): Promise<Readonly<IsolationEvidence>> => {
  let imageDigest: string | undefined;
  let mockServerImageDigest: string | undefined;
  let failure: unknown;
  try {
    if (signal.aborted) throw new Error("integration.isolation.interrupted");
    imageDigest = await driver.buildImage(plan);
    if (!digest.safeParse(imageDigest).success)
      throw new Error("integration.isolation.image-digest");
    mockServerImageDigest = await driver.buildMockServerImage(plan);
    if (!digest.safeParse(mockServerImageDigest).success)
      throw new Error("integration.isolation.image-digest");
    if (signal.aborted) throw new Error("integration.isolation.interrupted");
    await driver.createNetwork(plan);
    await driver.startCollector(plan);
    await driver.startRetrieval(plan);
    await driver.startMockServer(plan);
    await driver.runScenario(plan, signal);
  } catch (error) {
    failure = error;
  }
  const evidence = deepFreeze({
    evidenceVersion: 1 as const,
    runId: plan.runId,
    scenarioId: plan.scenarioId,
    manifestIdentity: plan.manifestIdentity,
    candidateBundleIdentity: plan.candidateBundleIdentity,
    candidateRevision: plan.candidateRevision,
    baseImage: plan.baseImage,
    mockServerImage: plan.mockServerImage,
    builtImageDigest: imageDigest ?? `sha256-${"0".repeat(64)}`,
    builtMockServerImageDigest:
      mockServerImageDigest ?? `sha256-${"0".repeat(64)}`,
    networkMode: "internal-only" as const,
    hostMountCount: 0 as const,
    readOnlyRootFilesystem: true as const,
    tmpfsMounts: plan.tmpfsMounts,
    outcome: outcomeFor(signal, failure),
  });
  let cleanupFailure: unknown;
  try {
    await cleanup(plan, driver);
  } catch (error) {
    cleanupFailure = error;
  }
  await driver.recordEvidence(evidence);
  if (cleanupFailure !== undefined) {
    if (cleanupFailure instanceof Error) throw cleanupFailure;
    throw new Error("integration.isolation.cleanup");
  }
  if (failure !== undefined) {
    if (failure instanceof Error) throw failure;
    throw new Error("integration.isolation.failed");
  }
  return evidence;
};
