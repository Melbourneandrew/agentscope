import { types } from "node:util";
import {
  readImagePreparationDiagnostic,
  type ImagePreparationDiagnostic,
} from "../image-preparation/preparation.mjs";

export type ControllerStage =
  | "unknown"
  | "clean"
  | "maintainArtifacts"
  | "prepareCandidate"
  | "prepareImages"
  | "prepareModelRoutes"
  | "runScenarios"
  | "select";

type FailureDiagnostic = Readonly<{
  diagnosticVersion: 1;
  trust: "untrusted-diagnostic";
  failure:
    | "integration.controller.failed"
    | "integration.controller.retire-outer-host";
  stage: ControllerStage;
  kind:
    | "unknown"
    | "operation-grace-unsettled"
    | "pull-outcome-unknown"
    | "preparation-failed";
  imagePreparation: ImagePreparationDiagnostic | null;
  cleanup: "none" | "failed" | "not-attempted";
}>;

const projections = new WeakMap<object, FailureDiagnostic>();
const unsettledOperations = new WeakSet<object>();
const knownStages = new Set<unknown>([
  "unknown",
  "clean",
  "maintainArtifacts",
  "prepareCandidate",
  "prepareImages",
  "prepareModelRoutes",
  "runScenarios",
  "select",
]);
const objectKey = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const ownErrorValue = (error: unknown, name: string): unknown => {
  if (!types.isNativeError(error) || types.isProxy(error)) return undefined;
  return Object.getOwnPropertyDescriptor(error, name)?.value as unknown;
};

const imageDiagnostic = (
  error: unknown,
): ImagePreparationDiagnostic | undefined => {
  const direct = readImagePreparationDiagnostic(error);
  if (direct !== undefined) return direct;
  // At most one bounded preparation-entry envelope, never a cause-chain walk.
  // Its cause must still be an actual private error identity in the WeakMap.
  const message = ownErrorValue(error, "message");
  const preparationEnvelope =
    typeof message === "string" &&
    message.length <= 80 &&
    /^integration\.images\.[a-z-]+$/u.test(message);
  return message === "integration.controller.unsettled-operation" ||
    preparationEnvelope
    ? readImagePreparationDiagnostic(ownErrorValue(error, "cause"))
    : undefined;
};

export const markUnsettledOperation = (error: Error): Error => {
  unsettledOperations.add(error);
  return error;
};

export const recordControllerFailureDiagnostic = (
  error: Error,
  input: Readonly<{
    primaryCause: unknown;
    cleanupCause?: unknown;
    cleanupAttempted?: boolean;
    retirementRequired: boolean;
    stage?: ControllerStage;
  }>,
): void => {
  const imagePreparation = imageDiagnostic(input.primaryCause);
  const genericUnsettled =
    objectKey(input.primaryCause) &&
    unsettledOperations.has(input.primaryCause);
  projections.set(
    error,
    Object.freeze({
      diagnosticVersion: 1,
      trust: "untrusted-diagnostic",
      failure: input.retirementRequired
        ? "integration.controller.retire-outer-host"
        : "integration.controller.failed",
      stage: knownStages.has(input.stage)
        ? (input.stage ?? "unknown")
        : "unknown",
      kind:
        imagePreparation?.primary === "pull-outcome-unknown"
          ? "pull-outcome-unknown"
          : imagePreparation === undefined
            ? genericUnsettled
              ? "operation-grace-unsettled"
              : "unknown"
            : "preparation-failed",
      imagePreparation: imagePreparation ?? null,
      cleanup:
        input.cleanupAttempted === false
          ? "not-attempted"
          : input.cleanupCause === undefined
            ? "none"
            : "failed",
    }),
  );
};

const unknownDiagnostic: FailureDiagnostic = Object.freeze({
  diagnosticVersion: 1,
  trust: "untrusted-diagnostic",
  failure: "integration.controller.failed",
  stage: "unknown",
  kind: "unknown",
  imagePreparation: null,
  cleanup: "none",
});

export const readControllerFailureDiagnostic = (
  error: unknown,
): FailureDiagnostic =>
  (objectKey(error) ? projections.get(error) : undefined) ?? unknownDiagnostic;

export const formatControllerFailureDiagnostic = (error: unknown): string => {
  const diagnostic = readControllerFailureDiagnostic(error);
  return `${diagnostic.failure}\n${JSON.stringify(diagnostic)}\n`;
};
