import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import {
  git,
  hasCredentialGitState,
  inferModeAndIdentity,
  publishCredentialPreflightFailure,
} from "./controller-host-identity.js";
import {
  parseMockServerResearchRequest,
  type MockServerResearchRequest,
} from "./mockserver-research-request.js";
import { retainMockServerResearch } from "../mockserver-material/research-retention.mjs";
import type { MockServerResearchObservation } from "../mockserver-material/research-stage.mjs";
import {
  runIntegrationStages,
  settleAbortableOperation,
  type IntegrationControllerMode,
  type IntegrationStageDependencies,
} from "./controller-stages.js";
export {
  IntegrationControllerFailure,
  runIntegrationStages,
  settleAbortableOperation,
  type IntegrationControllerMode,
  type IntegrationStageDependencies,
} from "./controller-stages.js";

import {
  createHarnessAdmissionKernel,
  type AuthenticatedHarnessMaterialAuthority,
  type AuthenticatedHarnessTerminalAuthority,
  type HarnessAdmissionAuthority,
  type HarnessSupportEvidenceManifest,
} from "./harness-admission.js";
import {
  compileSubstrateCertificationProjection,
  compileSubstrateCertificationReceipt,
  parseSubstrateCertificationRequest,
  providerCredentialEnvironmentIsClear,
  SUBSTRATE_CERTIFICATION_PREDICATES,
  type SubstrateCertificationCase,
  type SubstrateCertificationProjection,
  type SubstrateCertificationRequest,
} from "./substrate-certification.js";

export type DisposableOuterHostBinding = Readonly<{
  cleanupStartMonotonicMilliseconds: number;
  deadlineMonotonicMilliseconds: number;
  dockerEndpoint: `unix://${string}`;
  dockerEnvironment: Readonly<NodeJS.ProcessEnv>;
  dockerExecutable: "/usr/bin/docker";
  hostKind: "crabbox" | "github-hosted";
  privateStorage: Readonly<{
    authorityDigest: `sha256:${string}`;
    parent: string;
    parentDev: number;
    parentGid: number;
    parentIno: number;
    parentMode: number;
    parentUid: number;
    root: string;
    rootDev: number;
    rootGid: number;
    rootIno: number;
    rootMode: 448;
    rootUid: number;
  }>;
  suppliedIdentity: Readonly<Record<string, string>>;
  workspaceRevision: string;
  workspaceRoot: string;
}>;

export type DisposableOuterHostCapability = Readonly<{
  binding: DisposableOuterHostBinding;
}>;

type CapabilityState = {
  active: boolean;
  researchRequest: MockServerResearchRequest;
  sourceTree: string;
  researchObservation?: MockServerResearchObservation;
  artifactFiles: Set<string>;
  candidateIdentities: Set<string>;
  failureEvidence: Map<
    string,
    Readonly<{
      dev: number;
      digest: `sha256:${string}`;
      ino: number;
      runId: string;
      size: number;
    }>
  >;
  headlessReceipts: Map<
    string,
    Readonly<{
      requestFingerprint: `sha256:${string}`;
      returnedAtMs: number;
      outerReceivedAtMs: number;
    }>
  >;
  ptyReceipts: Map<
    string,
    Readonly<{
      requestFingerprint: `sha256:${string}`;
      returnedAtMs: number;
      outerReceivedAtMs: number;
    }>
  >;
  requiredFailureEvidence: Set<string>;
  substrateCertificationPredicates: Map<string, string>;
  substrateCertificationProjection?: SubstrateCertificationProjection;
  substrateCertificationRequest: SubstrateCertificationRequest;
  privateStorageRetirements: Map<
    number,
    Readonly<{
      authorityDigest: `sha256:${string}`;
      dev: number;
      entryCount: number;
      entrySetDigest: `sha256:${string}`;
      ino: number;
      path: string;
      totalBytes: number;
    }>
  >;
  signal: AbortSignal;
  runIds: Set<string>;
};

const totalLifecycleMilliseconds = 23 * 60 * 1000;
const cleanupReserveMilliseconds = 60 * 1000;
const supervisorReserveMilliseconds = 60 * 1000;
const runTokenPattern = /^[a-f0-9]{16}$/u;
const candidatePattern = /^sha256-[a-f0-9]{64}$/u;
const artifactFiles = new Set([
  "current-candidate.json",
  "current-images.json",
  "current-model-routes.json",
  "current-selection.json",
  "harness-support-evidence.json",
]);
const capabilityContext =
  new AsyncLocalStorage<DisposableOuterHostCapability>();
const stageContext = new AsyncLocalStorage<
  keyof IntegrationStageDependencies
>();
const capabilityStates = new WeakMap<
  DisposableOuterHostCapability,
  CapabilityState
>();
type HarnessAdmissionSources = Readonly<{
  authenticateMaterial: (
    authority: AuthenticatedHarnessMaterialAuthority,
  ) => unknown;
  authenticateTerminal: (
    authority: AuthenticatedHarnessTerminalAuthority,
  ) => unknown;
}>;
let harnessAdmissionSources: HarnessAdmissionSources | undefined;

export const harnessAdmissionSourcesFitOwnerForTesting = (
  stageName: string | undefined,
  alreadyConfigured: boolean,
  sources: unknown,
): sources is HarnessAdmissionSources => {
  try {
    if (
      stageName !== "runScenarios" ||
      alreadyConfigured ||
      typeof sources !== "object" ||
      sources === null ||
      !Object.isFrozen(sources) ||
      Object.getPrototypeOf(sources) !== Object.prototype
    )
      return false;
    const descriptors = Object.getOwnPropertyDescriptors(sources);
    return (
      Reflect.ownKeys(descriptors).length === 2 &&
      typeof descriptors.authenticateMaterial?.value === "function" &&
      typeof descriptors.authenticateTerminal?.value === "function"
    );
  } catch {
    return false;
  }
};
/* v8 ignore start -- the executable controller alone owns these source
   callbacks; the kernel's provider boundaries are covered with injected
   opaque authorities in harness-admission.test.ts. */
const harnessAdmissionKernel = createHarnessAdmissionKernel(
  (capability: DisposableOuterHostCapability) => {
    const state = capabilityStates.get(capability);
    if (state?.active !== true) return undefined;
    const receipts = new Map<
      string,
      Readonly<{
        requestFingerprint: string;
        transport: "headless" | "pty";
      }>
    >();
    for (const [runId, receipt] of state.headlessReceipts)
      receipts.set(
        runId,
        Object.freeze({
          requestFingerprint: receipt.requestFingerprint,
          transport: "headless" as const,
        }),
      );
    for (const [runId, receipt] of state.ptyReceipts)
      receipts.set(
        runId,
        Object.freeze({
          requestFingerprint: receipt.requestFingerprint,
          transport: "pty" as const,
        }),
      );
    return Object.freeze({
      active: true,
      authorityIdentity: capability.binding.privateStorage.authorityDigest,
      candidateIdentities: state.candidateIdentities,
      hostKind: capability.binding.hostKind,
      receipts,
      runIds: state.runIds,
      workspaceRevision: capability.binding.workspaceRevision,
    });
  },
  (_capability, authority) =>
    harnessAdmissionSources?.authenticateMaterial(authority),
  (_capability, authority) =>
    harnessAdmissionSources?.authenticateTerminal(authority),
);
/* v8 ignore stop */
let controllerConsumed = false;

export const failureEvidenceCoverageIsExact = (
  runIds: readonly string[],
  requiredRunIds: readonly string[],
  recordedRunIds: readonly string[],
): boolean => {
  const runs = new Set(runIds);
  const required = new Set(requiredRunIds);
  const recorded = new Set(recordedRunIds);
  return (
    runs.size === runIds.length &&
    required.size === requiredRunIds.length &&
    recorded.size === recordedRunIds.length &&
    runIds.length <= 256 &&
    runIds.every((runId) => runTokenPattern.test(runId)) &&
    [...required].every((runId) => runs.has(runId)) &&
    [...recorded].every((runId) => runs.has(runId)) &&
    required.size === recorded.size &&
    [...required].every((runId) => recorded.has(runId))
  );
};

/* v8 ignore start -- executable capability wiring is covered by disposable-host runs */

type ControllerBinding = {
  binding: DisposableOuterHostBinding;
  mode: IntegrationControllerMode;
  researchRequest: MockServerResearchRequest;
  sourceTree: string;
  substrateCertificationRequest: SubstrateCertificationRequest;
};
const createBinding = (
  environment: NodeJS.ProcessEnv,
  now = performance.now(),
): ControllerBinding => {
  const { hostKind, identity, mode } = inferModeAndIdentity(environment);
  const researchRequest = parseMockServerResearchRequest(
    environment,
    hostKind,
    mode,
  );
  if (!providerCredentialEnvironmentIsClear(environment))
    throw new Error("integration.controller.provider-credentials");
  const substrateCertificationRequest = parseSubstrateCertificationRequest(
    environment,
    hostKind,
    mode,
  );
  const workspaceRoot = resolve(import.meta.dirname, "../../..");
  const workspaceRevision = git(workspaceRoot, ["rev-parse", "HEAD"]);
  const sourceTree = git(workspaceRoot, ["rev-parse", "HEAD^{tree}"]);
  if (hostKind === "github-hosted" && workspaceRevision !== identity.GITHUB_SHA)
    throw new Error("integration.controller.workspace-revision");
  if (hasCredentialGitState(workspaceRoot))
    throw new Error("integration.controller.git-credentials");
  const suppliedOuterDeadline =
    environment.AGENTSCOPE_INTEGRATION_OUTER_DEADLINE_MONOTONIC_MS;
  let lifecycleMilliseconds = totalLifecycleMilliseconds;
  if (suppliedOuterDeadline !== undefined) {
    if (!/^\d{7,15}$/u.test(suppliedOuterDeadline))
      throw new Error("integration.controller.outer-deadline");
    lifecycleMilliseconds = Math.min(
      lifecycleMilliseconds,
      Number(suppliedOuterDeadline) -
        Number(readFileSync("/proc/uptime", "utf8").split(" ", 1)[0]) * 1000 -
        supervisorReserveMilliseconds,
    );
  }
  if (lifecycleMilliseconds < 2 * cleanupReserveMilliseconds)
    throw new Error("integration.controller.outer-deadline");
  const deadlineMonotonicMilliseconds = now + lifecycleMilliseconds;
  const dockerEndpoint =
    `unix://${realpathSync("/var/run/docker.sock")}` as const;
  const dockerEnvironment = Object.freeze({
    LANG: "C.UTF-8",
    PATH: "/usr/bin:/bin",
    DOCKER_HOST: dockerEndpoint,
  });
  const privateStorageParent = realpathSync("/tmp");
  const parentStatus = lstatSync(privateStorageParent);
  if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink())
    throw new Error("integration.controller.private-storage");
  const privateStorageRoot = mkdtempSync(
    resolve(privateStorageParent, "agentscope-integration-controller-"),
  );
  chmodSync(privateStorageRoot, 0o700);
  const rootStatus = lstatSync(privateStorageRoot);
  if (
    !rootStatus.isDirectory() ||
    rootStatus.isSymbolicLink() ||
    (rootStatus.mode & 0o7777) !== 0o700 ||
    rootStatus.uid !== process.getuid?.() ||
    rootStatus.gid !== process.getgid?.()
  )
    throw new Error("integration.controller.private-storage");
  const authorityDigest = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        hostKind,
        identity: Object.entries(identity).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
        privateStorage: {
          dev: rootStatus.dev,
          gid: rootStatus.gid,
          ino: rootStatus.ino,
          mode: rootStatus.mode & 0o7777,
          path: privateStorageRoot,
          uid: rootStatus.uid,
        },
        workspaceRevision,
      }),
    )
    .digest("hex")}` as const;
  return {
    mode,
    researchRequest,
    sourceTree,
    substrateCertificationRequest,
    binding: Object.freeze({
      cleanupStartMonotonicMilliseconds:
        deadlineMonotonicMilliseconds - cleanupReserveMilliseconds,
      deadlineMonotonicMilliseconds,
      dockerEndpoint,
      dockerEnvironment,
      dockerExecutable: "/usr/bin/docker",
      hostKind,
      privateStorage: Object.freeze({
        authorityDigest,
        parent: privateStorageParent,
        parentDev: parentStatus.dev,
        parentGid: parentStatus.gid,
        parentIno: parentStatus.ino,
        parentMode: parentStatus.mode & 0o7777,
        parentUid: parentStatus.uid,
        root: privateStorageRoot,
        rootDev: rootStatus.dev,
        rootGid: rootStatus.gid,
        rootIno: rootStatus.ino,
        rootMode: 0o700,
        rootUid: rootStatus.uid,
      }),
      suppliedIdentity: identity,
      workspaceRevision,
      workspaceRoot,
    }),
  };
};

export const requireDisposableOuterHostCapability =
  (): DisposableOuterHostCapability => {
    const capability = capabilityContext.getStore();
    const state =
      capability === undefined ? undefined : capabilityStates.get(capability);
    if (
      capability === undefined ||
      state?.active !== true ||
      Object.entries(capability.binding.suppliedIdentity).some(
        ([name, value]) => process.env[name] !== value,
      )
    )
      throw new Error("integration.outer-host.capability-required");
    return capability;
  };

export const integrationStageSignal = (): AbortSignal => {
  const capability = requireDisposableOuterHostCapability();
  return capabilityStates.get(capability)!.signal;
};

export const requireMockServerResearchRequest = () => {
  const capability = requireDisposableOuterHostCapability();
  const state = capabilityStates.get(capability)!;
  if (stageContext.getStore() !== "prepareModelRoutes")
    throw new Error("integration.mockserver-material.research-request");
  return state.researchRequest.kind === "supplier"
    ? Object.freeze({
        request: state.researchRequest,
        sourceTree: state.sourceTree,
      })
    : undefined;
};

export const registerMockServerResearchObservation = (
  observation: MockServerResearchObservation,
): void => {
  const capability = requireDisposableOuterHostCapability();
  const state = capabilityStates.get(capability)!;
  if (
    stageContext.getStore() !== "prepareModelRoutes" ||
    state.researchRequest.kind !== "supplier" ||
    state.researchObservation !== undefined
  )
    throw new Error("integration.mockserver-material.research-request");
  state.researchObservation = observation;
};

export const requireSubstrateCertificationCase = ():
  SubstrateCertificationCase | undefined => {
  const capability = requireDisposableOuterHostCapability();
  const state = capabilityStates.get(capability)!;
  if (stageContext.getStore() !== "runScenarios")
    throw new Error("integration.certification.authority");
  return state.substrateCertificationRequest.kind === "negative"
    ? state.substrateCertificationRequest.case
    : undefined;
};

export const requireSubstrateCertificationReplay = ():
  1 | 2 | 3 | undefined => {
  const capability = requireDisposableOuterHostCapability();
  const state = capabilityStates.get(capability)!;
  if (stageContext.getStore() !== "runScenarios")
    throw new Error("integration.certification.authority");
  return state.substrateCertificationRequest.kind === "replay"
    ? state.substrateCertificationRequest.ordinal
    : undefined;
};

export const registerSubstrateCertificationPredicate = (
  runId: string,
  predicate: string,
): void => {
  const capability = requireDisposableOuterHostCapability();
  const state = capabilityStates.get(capability)!;
  const request = state.substrateCertificationRequest;
  if (
    stageContext.getStore() !== "runScenarios" ||
    request.kind !== "negative" ||
    !state.runIds.has(runId) ||
    predicate !== SUBSTRATE_CERTIFICATION_PREDICATES[request.case] ||
    state.substrateCertificationPredicates.has(runId)
  )
    throw new Error("integration.certification.predicate");
  state.substrateCertificationPredicates.set(runId, predicate);
};

export const registerSubstrateCertificationProjection = (
  projection: SubstrateCertificationProjection,
): void => {
  const capability = requireDisposableOuterHostCapability();
  const state = capabilityStates.get(capability)!;
  if (
    stageContext.getStore() !== "runScenarios" ||
    state.substrateCertificationRequest.kind !== "replay" ||
    state.substrateCertificationProjection !== undefined
  )
    throw new Error("integration.certification.projection");
  state.substrateCertificationProjection =
    compileSubstrateCertificationProjection(projection);
};

export const integrationPrivateStorageAuthority = () =>
  requireDisposableOuterHostCapability().binding.privateStorage;

export const remainingIntegrationOperationMilliseconds = (
  maximumMilliseconds: number,
  terminal = false,
): number => {
  const capability = requireDisposableOuterHostCapability();
  const boundary = terminal
    ? capability.binding.deadlineMonotonicMilliseconds
    : capability.binding.cleanupStartMonotonicMilliseconds;
  const remaining = Math.floor(boundary - performance.now());
  if (
    !Number.isSafeInteger(maximumMilliseconds) ||
    maximumMilliseconds < 1 ||
    remaining < 1
  )
    throw new Error("integration.controller.deadline");
  return Math.min(maximumMilliseconds, remaining);
};

export const registerIntegrationRunIds = (runIds: readonly string[]): void => {
  const capability = requireDisposableOuterHostCapability();
  if (
    runIds.length < 1 ||
    runIds.length > 256 ||
    new Set(runIds).size !== runIds.length ||
    runIds.some((runId) => !runTokenPattern.test(runId))
  )
    throw new Error("integration.controller.run-identity");
  const state = capabilityStates.get(capability)!;
  for (const runId of runIds) state.runIds.add(runId);
};

export const registerIntegrationCandidateIdentity = (
  identity: string,
): void => {
  const capability = requireDisposableOuterHostCapability();
  if (!candidatePattern.test(identity))
    throw new Error("integration.controller.candidate-identity");
  capabilityStates.get(capability)!.candidateIdentities.add(identity);
};

export const beginRealHarnessAdmission = (
  material: AuthenticatedHarnessMaterialAuthority,
): HarnessAdmissionAuthority => {
  const capability = requireDisposableOuterHostCapability();
  return harnessAdmissionKernel.begin(capability, material);
};

export const configureRealHarnessAdmissionSources = (
  sources: HarnessAdmissionSources,
): void => {
  requireDisposableOuterHostCapability();
  if (
    !harnessAdmissionSourcesFitOwnerForTesting(
      stageContext.getStore(),
      harnessAdmissionSources !== undefined,
      sources,
    )
  )
    throw new Error("integration.harness-admission.sources");
  harnessAdmissionSources = sources;
};

export const completeRealHarnessAdmission = (
  authority: HarnessAdmissionAuthority,
  terminal: AuthenticatedHarnessTerminalAuthority,
): void => {
  const capability = requireDisposableOuterHostCapability();
  harnessAdmissionKernel.complete(capability, authority, terminal);
};

export const compileRealHarnessSupportEvidence = (
  authorities: readonly HarnessAdmissionAuthority[],
): HarnessSupportEvidenceManifest => {
  const capability = requireDisposableOuterHostCapability();
  return harnessAdmissionKernel.compile(capability, authorities);
};

export const registerIntegrationArtifactFile = (name: string): void => {
  const capability = requireDisposableOuterHostCapability();
  if (!artifactFiles.has(name))
    throw new Error("integration.controller.artifact-identity");
  capabilityStates.get(capability)!.artifactFiles.add(name);
};

export const registerIntegrationFailureEvidence = (
  evidence: Readonly<{
    dev: number;
    digest: `sha256:${string}`;
    ino: number;
    runId: string;
    size: number;
  }>,
): void => {
  const capability = requireDisposableOuterHostCapability();
  const state = capabilityStates.get(capability)!;
  if (
    !runTokenPattern.test(evidence.runId) ||
    !state.runIds.has(evidence.runId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(evidence.digest) ||
    !Number.isSafeInteger(evidence.dev) ||
    !Number.isSafeInteger(evidence.ino) ||
    !Number.isSafeInteger(evidence.size) ||
    evidence.dev < 0 ||
    evidence.ino < 1 ||
    evidence.size < 1 ||
    evidence.size > 16_384 ||
    state.failureEvidence.has(evidence.runId)
  )
    throw new Error("integration.controller.failure-evidence");
  state.failureEvidence.set(evidence.runId, Object.freeze({ ...evidence }));
};

export const registerIntegrationHeadlessReceipt = (
  receipt: Readonly<{
    runId: string;
    requestFingerprint: `sha256:${string}`;
    returnedAtMs: number;
    request: Readonly<{ monotonicShutdownDeadlineMs: number }>;
  }>,
  outerReceivedAtMs: number,
): void => {
  const capability = requireDisposableOuterHostCapability();
  const state = capabilityStates.get(capability)!;
  if (
    !headlessReceiptFitsOuterAuthority(
      receipt,
      outerReceivedAtMs,
      capability.binding.cleanupStartMonotonicMilliseconds,
      state.runIds,
    ) ||
    state.headlessReceipts.has(receipt.runId) ||
    state.ptyReceipts.has(receipt.runId)
  )
    throw new Error("integration.controller.headless-receipt");
  state.headlessReceipts.set(
    receipt.runId,
    Object.freeze({
      requestFingerprint: receipt.requestFingerprint,
      returnedAtMs: receipt.returnedAtMs,
      outerReceivedAtMs,
    }),
  );
};

export const registerIntegrationPtyReceipt = (
  receipt: Readonly<{
    runId: string;
    requestFingerprint: `sha256:${string}`;
    returnedAtMs: number;
    request: Readonly<{
      process: Readonly<{ monotonicShutdownDeadlineMs: number }>;
    }>;
  }>,
  outerReceivedAtMs: number,
): void => {
  const capability = requireDisposableOuterHostCapability();
  const state = capabilityStates.get(capability)!;
  if (
    !ptyReceiptFitsOuterAuthority(
      receipt,
      outerReceivedAtMs,
      capability.binding.cleanupStartMonotonicMilliseconds,
      state.runIds,
    ) ||
    state.ptyReceipts.has(receipt.runId) ||
    state.headlessReceipts.has(receipt.runId)
  )
    throw new Error("integration.controller.pty-receipt");
  state.ptyReceipts.set(
    receipt.runId,
    Object.freeze({
      requestFingerprint: receipt.requestFingerprint,
      returnedAtMs: receipt.returnedAtMs,
      outerReceivedAtMs,
    }),
  );
};

export const headlessReceiptFitsOuterAuthority = (
  receipt: Readonly<{
    runId: string;
    requestFingerprint: string;
    returnedAtMs: number;
    request: Readonly<{ monotonicShutdownDeadlineMs: number }>;
  }>,
  outerReceivedAtMs: number,
  cleanupStartMonotonicMilliseconds: number,
  runIds: ReadonlySet<string>,
): boolean =>
  runTokenPattern.test(receipt.runId) &&
  runIds.has(receipt.runId) &&
  /^sha256:[a-f0-9]{64}$/u.test(receipt.requestFingerprint) &&
  Number.isFinite(receipt.returnedAtMs) &&
  Number.isFinite(receipt.request.monotonicShutdownDeadlineMs) &&
  Number.isFinite(outerReceivedAtMs) &&
  receipt.returnedAtMs >= 0 &&
  receipt.returnedAtMs <= receipt.request.monotonicShutdownDeadlineMs &&
  outerReceivedAtMs >= 0 &&
  outerReceivedAtMs < cleanupStartMonotonicMilliseconds;

export const ptyReceiptFitsOuterAuthority = (
  receipt: Readonly<{
    runId: string;
    requestFingerprint: string;
    returnedAtMs: number;
    request: Readonly<{
      process: Readonly<{ monotonicShutdownDeadlineMs: number }>;
    }>;
  }>,
  outerReceivedAtMs: number,
  cleanupStartMonotonicMilliseconds: number,
  runIds: ReadonlySet<string>,
): boolean =>
  headlessReceiptFitsOuterAuthority(
    {
      runId: receipt.runId,
      requestFingerprint: receipt.requestFingerprint,
      returnedAtMs: receipt.returnedAtMs,
      request: receipt.request.process,
    },
    outerReceivedAtMs,
    cleanupStartMonotonicMilliseconds,
    runIds,
  );

export const registerIntegrationPrivateStorageRetirement = (
  retirement: Readonly<{
    authorityDigest: `sha256:${string}`;
    dev: number;
    entryCount: number;
    entrySetDigest: `sha256:${string}`;
    ino: number;
    path: string;
    totalBytes: number;
  }>,
): void => {
  const capability = requireDisposableOuterHostCapability();
  const state = capabilityStates.get(capability)!;
  const storage = capability.binding.privateStorage;
  if (
    retirement.authorityDigest !== storage.authorityDigest ||
    !retirement.path.startsWith(`${storage.root}/docker-client-`) ||
    !/^sha256:[a-f0-9]{64}$/u.test(retirement.entrySetDigest) ||
    !Number.isSafeInteger(retirement.dev) ||
    !Number.isSafeInteger(retirement.ino) ||
    !Number.isSafeInteger(retirement.entryCount) ||
    !Number.isSafeInteger(retirement.totalBytes) ||
    retirement.dev < 0 ||
    retirement.ino < 1 ||
    retirement.entryCount < 1 ||
    retirement.entryCount > 4_096 ||
    retirement.totalBytes < 0 ||
    retirement.totalBytes > 64 * 1024 * 1024 ||
    state.privateStorageRetirements.has(retirement.ino)
  )
    throw new Error("integration.controller.private-storage");
  state.privateStorageRetirements.set(
    retirement.ino,
    Object.freeze({ ...retirement }),
  );
};

export const requireIntegrationFailureEvidence = (
  runIds: readonly string[],
): void => {
  const capability = requireDisposableOuterHostCapability();
  const state = capabilityStates.get(capability)!;
  if (
    runIds.length < 1 ||
    runIds.length > 256 ||
    new Set(runIds).size !== runIds.length ||
    runIds.some(
      (runId) => !runTokenPattern.test(runId) || !state.runIds.has(runId),
    ) ||
    state.requiredFailureEvidence.size !== 0
  )
    throw new Error("integration.controller.failure-evidence");
  for (const runId of runIds) state.requiredFailureEvidence.add(runId);
};

export const ownedIntegrationResources = (): Readonly<{
  artifactFiles: readonly string[];
  candidateIdentities: readonly string[];
  failureEvidence: readonly Readonly<{
    dev: number;
    digest: `sha256:${string}`;
    ino: number;
    runId: string;
    size: number;
  }>[];
  requiredFailureEvidence: readonly string[];
  privateStorageRetirements: readonly Readonly<{
    authorityDigest: `sha256:${string}`;
    dev: number;
    entryCount: number;
    entrySetDigest: `sha256:${string}`;
    ino: number;
    path: string;
    totalBytes: number;
  }>[];
  headlessReceipts: readonly Readonly<{
    requestFingerprint: `sha256:${string}`;
    returnedAtMs: number;
    runId: string;
    outerReceivedAtMs: number;
  }>[];
  ptyReceipts: readonly Readonly<{
    requestFingerprint: `sha256:${string}`;
    returnedAtMs: number;
    runId: string;
    outerReceivedAtMs: number;
  }>[];
  runIds: readonly string[];
}> => {
  const capability = requireDisposableOuterHostCapability();
  const state = capabilityStates.get(capability)!;
  return Object.freeze({
    artifactFiles: Object.freeze([...state.artifactFiles].sort()),
    candidateIdentities: Object.freeze([...state.candidateIdentities].sort()),
    failureEvidence: Object.freeze(
      [...state.failureEvidence.values()].sort((left, right) =>
        left.runId.localeCompare(right.runId),
      ),
    ),
    requiredFailureEvidence: Object.freeze(
      [...state.requiredFailureEvidence].sort(),
    ),
    privateStorageRetirements: Object.freeze(
      [...state.privateStorageRetirements.values()].sort(
        (left, right) => left.ino - right.ino,
      ),
    ),
    headlessReceipts: Object.freeze(
      [...state.headlessReceipts.entries()]
        .map(([runId, receipt]) => Object.freeze({ runId, ...receipt }))
        .sort((left, right) => left.runId.localeCompare(right.runId)),
    ),
    ptyReceipts: Object.freeze(
      [...state.ptyReceipts.entries()]
        .map(([runId, receipt]) => Object.freeze({ runId, ...receipt }))
        .sort((left, right) => left.runId.localeCompare(right.runId)),
    ),
    runIds: Object.freeze([...state.runIds].sort()),
  });
};
/* v8 ignore stop */

const runCapabilityStage = async (
  capability: DisposableOuterHostCapability,
  stageName: keyof IntegrationStageDependencies,
  operation: () => Promise<void>,
  terminal = false,
): Promise<void> => {
  const state = capabilityStates.get(capability);
  if (state?.active !== true)
    throw new Error("integration.outer-host.capability-required");
  const boundary = terminal
    ? capability.binding.deadlineMonotonicMilliseconds
    : capability.binding.cleanupStartMonotonicMilliseconds;
  const remaining = Math.floor(boundary - performance.now());
  await settleAbortableOperation(remaining, async (signal) => {
    state.signal = signal;
    await stageContext.run(stageName, operation);
  });
};

/* v8 ignore start -- executable-only imports are checked by policy tests */
const stageDependencies = (
  capability: DisposableOuterHostCapability,
): IntegrationStageDependencies => {
  const stage =
    (
      stageName: keyof IntegrationStageDependencies,
      operation: () => Promise<void>,
      terminal = false,
    ) =>
    () =>
      runCapabilityStage(capability, stageName, operation, terminal);
  return {
    clean: stage(
      "clean",
      async () => {
        // @ts-expect-error Private executable stage has no public type API.
        await import("../clean.mjs");
      },
      true,
    ),
    maintainArtifacts: stage("maintainArtifacts", async () => {
      // @ts-expect-error Private executable stage has no public type API.
      await import("../maintain-artifacts.mjs");
    }),
    prepareCandidate: stage("prepareCandidate", async () => {
      // @ts-expect-error Executable verifier has no public type API.
      await import("../../../apps/cli/verify-artifact.mjs");
      // @ts-expect-error Private executable stage has no public type API.
      await import("../prepare-cli.mjs");
    }),
    prepareImages: stage("prepareImages", async () => {
      // @ts-expect-error Private executable stage has no public type API.
      await import("../prepare-images.mjs");
    }),
    prepareModelRoutes: stage("prepareModelRoutes", async () => {
      // @ts-expect-error Private executable stage has no public type API.
      await import("../prepare-model-routes.mjs");
    }),
    runScenarios: stage("runScenarios", async () => {
      // @ts-expect-error Private executable stage has no public type API.
      await import("../run-scenarios.mjs");
    }),
    select: stage("select", async () => {
      // @ts-expect-error Private executable stage has no public type API.
      await import("../select.mjs");
    }),
  };
};

const publishSubstrateCertificationReceipt = (
  binding: DisposableOuterHostBinding,
  request: SubstrateCertificationRequest,
  projection: SubstrateCertificationProjection | undefined,
): void => {
  if (request.kind !== "replay") return;
  if (projection === undefined)
    throw new Error("integration.certification.projection");
  const githubSha = binding.suppliedIdentity.GITHUB_SHA;
  if (githubSha === undefined)
    throw new Error("integration.certification.receipt");
  const serialized = `${JSON.stringify(
    compileSubstrateCertificationReceipt({
      githubSha,
      projection,
      replayOrdinal: request.ordinal,
    }),
    undefined,
    2,
  )}\n`;
  if (Buffer.byteLength(serialized, "utf8") > 65_536)
    throw new Error("integration.certification.receipt");
  const directory = resolve(
    binding.workspaceRoot,
    "artifacts/integration/certification",
  );
  const target = resolve(directory, `replay-${request.ordinal}.json`);
  const temporary = resolve(
    directory,
    `.replay-${request.ordinal}.${process.pid}.tmp`,
  );
  let descriptor: number | undefined;
  let directoryDescriptor: number | undefined;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStatus = lstatSync(directory);
    if (
      !directoryStatus.isDirectory() ||
      directoryStatus.isSymbolicLink() ||
      (directoryStatus.mode & 0o7777) !== 0o700
    )
      throw new Error("integration.certification.receipt");
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    writeFileSync(descriptor, serialized);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, target);
    rmSync(temporary);
    directoryDescriptor = openSync(directory, constants.O_RDONLY);
    fsyncSync(directoryDescriptor);
    const status = lstatSync(target);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      status.size !== Buffer.byteLength(serialized, "utf8") ||
      (status.mode & 0o7777) !== 0o600
    )
      throw new Error("integration.certification.receipt");
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error("integration.certification.receipt", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
  }
};

export const executeIntegrationController = async (): Promise<
  void | "mockserver-research-complete"
> => {
  if (controllerConsumed) throw new Error("integration.controller.single-use");
  controllerConsumed = true;
  let controllerBinding: ReturnType<typeof createBinding>;
  try {
    controllerBinding = createBinding(process.env);
  } catch (error) {
    publishCredentialPreflightFailure(process.env, error);
    throw error;
  }
  const {
    binding,
    mode,
    researchRequest,
    sourceTree,
    substrateCertificationRequest,
  } = controllerBinding;
  const capability = Object.freeze({ binding });
  const state: CapabilityState = {
    active: true,
    researchRequest,
    sourceTree,
    artifactFiles: new Set(),
    candidateIdentities: new Set(),
    failureEvidence: new Map(),
    headlessReceipts: new Map(),
    ptyReceipts: new Map(),
    requiredFailureEvidence: new Set(),
    substrateCertificationPredicates: new Map(),
    substrateCertificationRequest,
    privateStorageRetirements: new Map(),
    runIds: new Set(),
    signal: new AbortController().signal,
  };
  capabilityStates.set(capability, state);
  try {
    return await capabilityContext.run(capability, async () => {
      const disposition = await runIntegrationStages(
        mode,
        stageDependencies(capability),
        researchRequest.kind === "supplier" ? "mockserver-supplier" : undefined,
      );
      if (researchRequest.kind === "supplier") {
        if (
          disposition !== "mockserver-research-cleaned" ||
          state.researchObservation === undefined
        )
          throw new Error("integration.mockserver-material.research-retention");
        retainMockServerResearch({
          ...state.researchObservation,
          parent: resolve(binding.workspaceRoot, "artifacts/integration"),
          deadline: binding.deadlineMonotonicMilliseconds,
          signal: state.signal,
        });
        return "mockserver-research-complete" as const;
      }
      if (substrateCertificationRequest.kind === "negative")
        throw new Error("integration.certification.unexpected-success");
      publishSubstrateCertificationReceipt(
        binding,
        substrateCertificationRequest,
        state.substrateCertificationProjection,
      );
      return undefined;
    });
  } finally {
    state.active = false;
  }
};
/* v8 ignore stop */
