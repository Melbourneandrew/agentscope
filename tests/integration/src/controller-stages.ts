import {
  markUnsettledOperation,
  recordControllerFailureDiagnostic,
  type ControllerStage,
} from "./controller-failure-diagnostic.js";

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

export class IntegrationControllerFailure extends Error {
  readonly cleanupCause: unknown;
  readonly primaryCause: unknown;
  readonly retirementRequired: boolean;

  constructor(input: {
    cleanupCause?: unknown;
    cleanupAttempted?: boolean;
    primaryCause: unknown;
    retirementRequired: boolean;
    stage?: ControllerStage;
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
    recordControllerFailureDiagnostic(this, input);
  }
}

export const settleAbortableOperation = async (
  remaining: number,
  operation: (signal: AbortSignal) => Promise<void>,
  settlementGrace = 5_000,
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
    throw markUnsettledOperation(
      new Error("integration.controller.unsettled-operation"),
    );
  if (!terminal.ok) throw terminal.error;
  throw new Error("integration.controller.deadline");
};

export const runIntegrationStages = async (
  mode: IntegrationControllerMode,
  dependencies: IntegrationStageDependencies,
  research?: "mockserver-supplier",
): Promise<void | "mockserver-research-cleaned"> => {
  if (
    research !== undefined &&
    (research !== "mockserver-supplier" || mode !== "lifecycle")
  )
    throw new Error("integration.mockserver-material.research-request");
  let stage: ControllerStage = "prepareCandidate";
  if (mode === "candidate") {
    try {
      await dependencies.prepareCandidate();
      stage = "maintainArtifacts";
      await dependencies.maintainArtifacts();
    } catch (error) {
      throw new IntegrationControllerFailure({
        primaryCause: error,
        cleanupAttempted: false,
        retirementRequired: true,
        stage,
      });
    }
    return;
  }
  let primaryCause: unknown;
  try {
    if (mode === "crabbox") await dependencies.prepareCandidate();
    stage = "select";
    await dependencies.select();
    stage = "prepareImages";
    await dependencies.prepareImages();
    stage = "prepareModelRoutes";
    await dependencies.prepareModelRoutes();
    if (research === undefined) {
      stage = "runScenarios";
      await dependencies.runScenarios();
      stage = "maintainArtifacts";
      await dependencies.maintainArtifacts();
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "integration.controller.unsettled-operation"
    )
      throw new IntegrationControllerFailure({
        cleanupCause: error,
        cleanupAttempted: false,
        primaryCause: error,
        retirementRequired: true,
        stage,
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
      cleanupAttempted: true,
      primaryCause: primaryCause ?? cleanupCause,
      retirementRequired: true,
      stage: primaryCause === undefined ? "clean" : stage,
    });
  if (research === "mockserver-supplier") return "mockserver-research-cleaned";
};
