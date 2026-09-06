import { performance } from "node:perf_hooks";

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

type DisposableOuterHostCapability = Readonly<{
  deadlineMonotonicMilliseconds: number;
}>;

const activeCapabilities = new WeakSet<DisposableOuterHostCapability>();
const totalLifecycleMilliseconds = 23 * 60 * 1000;

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

const requireCapability = (capability: DisposableOuterHostCapability): void => {
  if (!activeCapabilities.has(capability))
    throw new Error("integration.controller.capability-required");
  if (performance.now() >= capability.deadlineMonotonicMilliseconds)
    throw new Error("integration.controller.deadline");
};

const runStage = async (
  capability: DisposableOuterHostCapability,
  operation: () => Promise<void>,
): Promise<void> => {
  requireCapability(capability);
  const remaining = Math.floor(
    capability.deadlineMonotonicMilliseconds - performance.now(),
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("integration.controller.deadline"));
        }, remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const inferMode = (
  environment: NodeJS.ProcessEnv,
): IntegrationControllerMode => {
  if (environment.AGENTSCOPE_INTEGRATION_EXECUTOR === "crabbox")
    return "crabbox";
  if (
    environment.GITHUB_ACTIONS === "true" &&
    environment.RUNNER_ENVIRONMENT === "github-hosted"
  )
    return environment.AGENTSCOPE_INTEGRATION_MODE === "candidate"
      ? "candidate"
      : "lifecycle";
  throw new Error("integration.controller.disposable-host-required");
};

export const runIntegrationStages = async (
  mode: IntegrationControllerMode,
  dependencies: IntegrationStageDependencies,
  now = performance.now(),
): Promise<void> => {
  const capability = Object.freeze({
    deadlineMonotonicMilliseconds: now + totalLifecycleMilliseconds,
  });
  activeCapabilities.add(capability);
  let mutationRequested = false;
  let primaryCause: unknown;
  let cleanupCause: unknown;
  try {
    if (mode === "candidate" || mode === "crabbox") {
      await runStage(capability, dependencies.prepareCandidate);
      if (mode === "candidate") {
        await runStage(capability, dependencies.maintainArtifacts);
        return;
      }
    }
    await runStage(capability, dependencies.select);
    mutationRequested = true;
    await runStage(capability, dependencies.prepareImages);
    await runStage(capability, dependencies.prepareModelRoutes);
    await runStage(capability, dependencies.runScenarios);
    await runStage(capability, dependencies.maintainArtifacts);
  } catch (error) {
    primaryCause = error;
  } finally {
    if (mode !== "candidate") {
      try {
        await runStage(capability, dependencies.clean);
      } catch (error) {
        cleanupCause = error;
      }
    }
    activeCapabilities.delete(capability);
  }
  if (primaryCause !== undefined || cleanupCause !== undefined)
    throw new IntegrationControllerFailure({
      cleanupCause,
      primaryCause: primaryCause ?? cleanupCause,
      retirementRequired:
        mutationRequested || cleanupCause !== undefined || mode === "crabbox",
    });
};

/* v8 ignore start -- executable-only imports are checked by controller-policy tests */
const stageDependencies = (): IntegrationStageDependencies => ({
  clean: async () => {
    // @ts-expect-error Private executable stage has no public type API.
    await import("../clean.mjs");
  },
  maintainArtifacts: async () => {
    // @ts-expect-error Private executable stage has no public type API.
    await import("../maintain-artifacts.mjs");
  },
  prepareCandidate: async () => {
    // @ts-expect-error Executable verifier has no public type API.
    await import("../../../apps/cli/verify-artifact.mjs");
    // @ts-expect-error Private executable stage has no public type API.
    await import("../prepare-cli.mjs");
  },
  prepareImages: async () => {
    // @ts-expect-error Private executable stage has no public type API.
    await import("../prepare-images.mjs");
  },
  prepareModelRoutes: async () => {
    // @ts-expect-error Private executable stage has no public type API.
    await import("../prepare-model-routes.mjs");
  },
  runScenarios: async () => {
    // @ts-expect-error Private executable stage has no public type API.
    await import("../run-scenarios.mjs");
  },
  select: async () => {
    // @ts-expect-error Private executable stage has no public type API.
    await import("../select.mjs");
  },
});

export const executeIntegrationController = async (): Promise<void> => {
  await runIntegrationStages(inferMode(process.env), stageDependencies());
};
/* v8 ignore stop */
