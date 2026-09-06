import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

export type IntegrationControllerMode = "candidate" | "crabbox" | "lifecycle";

export type IntegrationStageDependencies = Readonly<{
  clean: () => Promise<void>;
  maintainArtifacts: () => Promise<void>;
  prepareCandidate: () => Promise<void>;
  prepareImages: () => Promise<void>;
  prepareModelRoutes: () => Promise<void>;
  runScenarios: () => Promise<void>;
  select: () => Promise<void>;
}>;

export type DisposableOuterHostBinding = Readonly<{
  cleanupStartMonotonicMilliseconds: number;
  deadlineMonotonicMilliseconds: number;
  dockerEndpoint: `unix://${string}`;
  dockerEnvironment: Readonly<NodeJS.ProcessEnv>;
  dockerExecutable: "/usr/bin/docker";
  hostKind: "crabbox" | "github-hosted";
  suppliedIdentity: Readonly<Record<string, string>>;
  workspaceRevision: string;
  workspaceRoot: string;
}>;

export type DisposableOuterHostCapability = Readonly<{
  binding: DisposableOuterHostBinding;
}>;

type CapabilityState = {
  active: boolean;
  artifactFiles: Set<string>;
  candidateIdentities: Set<string>;
  signal: AbortSignal;
  runIds: Set<string>;
};

const totalLifecycleMilliseconds = 23 * 60 * 1000;
const cleanupReserveMilliseconds = 60 * 1000;
const settlementGraceMilliseconds = 5_000;
const supervisorReserveMilliseconds = 60 * 1000;
const runTokenPattern = /^[a-f0-9]{16}$/u;
const candidatePattern = /^sha256-[a-f0-9]{64}$/u;
const artifactFiles = new Set([
  "current-candidate.json",
  "current-images.json",
  "current-model-routes.json",
  "current-selection.json",
]);
const capabilityContext =
  new AsyncLocalStorage<DisposableOuterHostCapability>();
const capabilityStates = new WeakMap<
  DisposableOuterHostCapability,
  CapabilityState
>();
let controllerConsumed = false;

export class IntegrationControllerFailure extends Error {
  readonly cleanupCause: unknown;
  readonly primaryCause: unknown;
  readonly retirementRequired: boolean;

  constructor(input: {
    cleanupCause?: unknown;
    primaryCause: unknown;
    retirementRequired: boolean;
  }) {
    super(
      input.retirementRequired
        ? "integration.controller.retire-outer-host"
        : "integration.controller.failed",
      { cause: input.primaryCause },
    );
    this.name = "IntegrationControllerFailure";
    this.cleanupCause = input.cleanupCause;
    this.primaryCause = input.primaryCause;
    this.retirementRequired = input.retirementRequired;
  }
}

/* v8 ignore start -- executable capability wiring is covered by disposable-host runs */
const supplied = (
  environment: NodeJS.ProcessEnv,
  names: readonly string[],
): Readonly<Record<string, string>> =>
  Object.freeze(
    Object.fromEntries(
      names.map((name) => {
        const value = environment[name];
        if (value === undefined || value.length < 1 || value.length > 1024)
          throw new Error("integration.controller.disposable-host-identity");
        return [name, value];
      }),
    ),
  );

const inferModeAndIdentity = (
  environment: NodeJS.ProcessEnv,
): {
  identity: Readonly<Record<string, string>>;
  mode: IntegrationControllerMode;
  hostKind: DisposableOuterHostBinding["hostKind"];
} => {
  if (environment.AGENTSCOPE_INTEGRATION_EXECUTOR === "crabbox") {
    const identity = supplied(environment, [
      "CRABBOX_LEASE_ID",
      "CRABBOX_RUN_ID",
      "CRABBOX_SLUG",
    ]);
    if (
      !/^cbx_[A-Za-z0-9_-]+$/u.test(identity.CRABBOX_LEASE_ID!) ||
      !/^run_[A-Za-z0-9_-]+$/u.test(identity.CRABBOX_RUN_ID!) ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(identity.CRABBOX_SLUG!)
    )
      throw new Error("integration.controller.disposable-host-identity");
    return { hostKind: "crabbox", identity, mode: "crabbox" };
  }
  if (
    environment.GITHUB_ACTIONS === "true" &&
    environment.RUNNER_ENVIRONMENT === "github-hosted"
  ) {
    const identity = supplied(environment, [
      "GITHUB_JOB",
      "GITHUB_REPOSITORY",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_RUN_ID",
      "GITHUB_SHA",
      "RUNNER_NAME",
      "AGENTSCOPE_INTEGRATION_OUTER_DEADLINE_MONOTONIC_MS",
    ]);
    if (
      !/^\d+$/u.test(identity.GITHUB_RUN_ID!) ||
      !/^\d+$/u.test(identity.GITHUB_RUN_ATTEMPT!) ||
      !/^[a-f0-9]{40}$/u.test(identity.GITHUB_SHA!)
    )
      throw new Error("integration.controller.disposable-host-identity");
    return {
      hostKind: "github-hosted",
      identity,
      mode:
        environment.AGENTSCOPE_INTEGRATION_MODE === "candidate"
          ? "candidate"
          : "lifecycle",
    };
  }
  throw new Error("integration.controller.disposable-host-required");
};

const git = (workspaceRoot: string, arguments_: readonly string[]): string =>
  execFileSync("/usr/bin/git", [...arguments_], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    },
    timeout: 30_000,
  }).trim();

const hasCredentialGitState = (workspaceRoot: string): boolean => {
  const entries = git(workspaceRoot, ["config", "--local", "--null", "--list"])
    .split("\0")
    .filter(Boolean);
  return entries.some((entry) => {
    const newline = entry.indexOf("\n");
    const key = (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase();
    const value = newline < 0 ? "" : entry.slice(newline + 1);
    return (
      /^(?:credential\.|http\.|include\.|includeif\.|url\.)/u.test(key) ||
      key === "core.sshcommand" ||
      /:\/\/[^/@\s]+@/u.test(value)
    );
  });
};

const createBinding = (
  environment: NodeJS.ProcessEnv,
  now = performance.now(),
): { binding: DisposableOuterHostBinding; mode: IntegrationControllerMode } => {
  const { hostKind, identity, mode } = inferModeAndIdentity(environment);
  const workspaceRoot = resolve(import.meta.dirname, "../../..");
  const workspaceRevision = git(workspaceRoot, ["rev-parse", "HEAD"]);
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
  return {
    mode,
    binding: Object.freeze({
      cleanupStartMonotonicMilliseconds:
        deadlineMonotonicMilliseconds - cleanupReserveMilliseconds,
      deadlineMonotonicMilliseconds,
      dockerEndpoint,
      dockerEnvironment,
      dockerExecutable: "/usr/bin/docker",
      hostKind,
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

export const registerIntegrationArtifactFile = (name: string): void => {
  const capability = requireDisposableOuterHostCapability();
  if (!artifactFiles.has(name))
    throw new Error("integration.controller.artifact-identity");
  capabilityStates.get(capability)!.artifactFiles.add(name);
};

export const ownedIntegrationResources = (): Readonly<{
  artifactFiles: readonly string[];
  candidateIdentities: readonly string[];
  runIds: readonly string[];
}> => {
  const capability = requireDisposableOuterHostCapability();
  const state = capabilityStates.get(capability)!;
  return Object.freeze({
    artifactFiles: Object.freeze([...state.artifactFiles].sort()),
    candidateIdentities: Object.freeze([...state.candidateIdentities].sort()),
    runIds: Object.freeze([...state.runIds].sort()),
  });
};
/* v8 ignore stop */

export const settleAbortableOperation = async (
  remaining: number,
  operation: (signal: AbortSignal) => Promise<void>,
  settlementGrace = settlementGraceMilliseconds,
): Promise<void> => {
  if (
    !Number.isSafeInteger(remaining) ||
    remaining < 1 ||
    !Number.isSafeInteger(settlementGrace) ||
    settlementGrace < 1
  )
    throw new Error("integration.controller.deadline");
  const controller = new AbortController();
  let deadlineTimer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  const settled = Promise.resolve()
    .then(() => operation(controller.signal))
    .then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ error, ok: false as const }),
    );
  const first = await Promise.race([
    settled,
    new Promise<undefined>((resolveDeadline) => {
      deadlineTimer = setTimeout(() => {
        controller.abort();
        resolveDeadline(undefined);
      }, remaining);
    }),
  ]);
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  if (first !== undefined) {
    if (!first.ok) throw first.error;
    return;
  }
  const terminal = await Promise.race([
    settled,
    new Promise<undefined>((resolveGrace) => {
      graceTimer = setTimeout(() => {
        resolveGrace(undefined);
      }, settlementGrace);
    }),
  ]);
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  if (terminal === undefined)
    throw new Error("integration.controller.unsettled-operation");
  if (!terminal.ok) throw terminal.error;
  throw new Error("integration.controller.deadline");
};

const runCapabilityStage = async (
  capability: DisposableOuterHostCapability,
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
    await operation();
  });
};

export const runIntegrationStages = async (
  mode: IntegrationControllerMode,
  dependencies: IntegrationStageDependencies,
): Promise<void> => {
  if (mode === "candidate") {
    try {
      await dependencies.prepareCandidate();
      await dependencies.maintainArtifacts();
    } catch (error) {
      throw new IntegrationControllerFailure({
        primaryCause: error,
        retirementRequired: true,
      });
    }
    return;
  }
  let primaryCause: unknown;
  try {
    if (mode === "crabbox") await dependencies.prepareCandidate();
    await dependencies.select();
    await dependencies.prepareImages();
    await dependencies.prepareModelRoutes();
    await dependencies.runScenarios();
    await dependencies.maintainArtifacts();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "integration.controller.unsettled-operation"
    )
      throw new IntegrationControllerFailure({
        cleanupCause: error,
        primaryCause: error,
        retirementRequired: true,
      });
    primaryCause = error;
  }
  let cleanupCause: unknown;
  try {
    await dependencies.clean();
  } catch (error) {
    cleanupCause = error;
  }
  if (primaryCause !== undefined || cleanupCause !== undefined)
    throw new IntegrationControllerFailure({
      cleanupCause,
      primaryCause: primaryCause ?? cleanupCause,
      retirementRequired: true,
    });
};

/* v8 ignore start -- executable-only imports are checked by policy tests */
const stageDependencies = (
  capability: DisposableOuterHostCapability,
): IntegrationStageDependencies => {
  const stage =
    (operation: () => Promise<void>, terminal = false) =>
    () =>
      runCapabilityStage(capability, operation, terminal);
  return {
    clean: stage(async () => {
      // @ts-expect-error Private executable stage has no public type API.
      await import("../clean.mjs");
    }, true),
    maintainArtifacts: stage(async () => {
      // @ts-expect-error Private executable stage has no public type API.
      await import("../maintain-artifacts.mjs");
    }),
    prepareCandidate: stage(async () => {
      // @ts-expect-error Executable verifier has no public type API.
      await import("../../../apps/cli/verify-artifact.mjs");
      // @ts-expect-error Private executable stage has no public type API.
      await import("../prepare-cli.mjs");
    }),
    prepareImages: stage(async () => {
      // @ts-expect-error Private executable stage has no public type API.
      await import("../prepare-images.mjs");
    }),
    prepareModelRoutes: stage(async () => {
      // @ts-expect-error Private executable stage has no public type API.
      await import("../prepare-model-routes.mjs");
    }),
    runScenarios: stage(async () => {
      // @ts-expect-error Private executable stage has no public type API.
      await import("../run-scenarios.mjs");
    }),
    select: stage(async () => {
      // @ts-expect-error Private executable stage has no public type API.
      await import("../select.mjs");
    }),
  };
};

export const executeIntegrationController = async (): Promise<void> => {
  if (controllerConsumed) throw new Error("integration.controller.single-use");
  controllerConsumed = true;
  const { binding, mode } = createBinding(process.env);
  const capability = Object.freeze({ binding });
  const state: CapabilityState = {
    active: true,
    artifactFiles: new Set(),
    candidateIdentities: new Set(),
    runIds: new Set(),
    signal: new AbortController().signal,
  };
  capabilityStates.set(capability, state);
  try {
    await capabilityContext.run(capability, async () => {
      await runIntegrationStages(mode, stageDependencies(capability));
    });
  } finally {
    state.active = false;
  }
};
/* v8 ignore stop */
