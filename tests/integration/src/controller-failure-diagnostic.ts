import { types } from "node:util";
import { SUBSTRATE_CERTIFICATION_PRIMARY_FAILURES } from "./substrate-certification.js";
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
  firstCodes?: Readonly<{ primary: string; causal: string; cleanup: string }>;
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

const cleanupCodes = [
  "scenario-container",
  "collector-container",
  "retrieval-container",
  "mock-server-container",
  "network",
  "network-remove",
  "control-volume",
  "scenario-image",
  "mock-server-image",
  "context",
  "inventory",
  "remaining",
].map((operation) => `integration.isolation.cleanup-${operation}`);
const materialPhaseCodes = [
  "preflight",
  "validate-package",
  "validate-descriptors",
  "download-key",
  "download-manifest",
  "download-signature",
  "download-platform-package",
  "integrity",
  "download-binary",
  "download-tarball",
  "download-attestation",
  "compile-audit",
  "verify",
  "verify-context",
  "verify-build",
  "verify-build-input",
  "verify-build-context",
  "verify-build-authority",
  "verify-build-preflight",
  "verify-build-create",
  "verify-build-bootstrap",
  "verify-build-image-build",
  "verify-build-containment",
  "verify-build-timeout",
  "verify-retire",
  "compile-authority",
  "publish",
].map((phase) => `integration.harness-material.${phase}`);
// Exact existing settledBuildFailure producer vocabulary, not a prefix policy.
const settledBuildCodes = [
  "preflight",
  "builder-create",
  "builder-bootstrap",
  "image-build",
  "unknown-operation",
].flatMap((operation) =>
  [
    "resource-conflict",
    "build-failed",
    "bootstrap-failed",
    "permission-denied",
    "unknown",
  ].map((outcome) => `integration.images.build.${operation}.${outcome}`),
);
const knownFailureCodes = new Set([
  ...Object.values(SUBSTRATE_CERTIFICATION_PRIMARY_FAILURES),
  "integration.controller.deadline",
  "integration.controller.unsettled-operation",
  "integration.controller.failure-evidence",
  "integration.isolation.context",
  "integration.isolation.base-image",
  "integration.images.build",
  "integration.images.socket",
  "integration.images.executable",
  "integration.images.interrupted",
  "integration.images.output",
  "integration.images.teardown",
  "integration.images.build.context",
  "integration.images.build.authority",
  ...settledBuildCodes,
  "integration.images.build.input",
  "integration.images.build.base",
  "integration.images.build.artifact",
  "integration.images.build.context-header",
  "integration.images.build.context-path",
  "integration.images.build.context-file-type",
  "integration.images.build.context-file-identity",
  "integration.images.build.context-aggregate-size",
  "integration.images.build.context-file-length",
  "integration.images.build.context-file-race",
  "integration.images.build.context-directory",
  "integration.images.build.context-symlink",
  "integration.images.build.context-special",
  "integration.images.build.context-policy",
  "integration.images.build.context-root",
  "integration.images.build.context-size",
  "integration.images.build.context-entries",
  "integration.images.build.context-unknown",
  "integration.images.build.context-file-size-harness-material-default",
  "integration.images.build.context-file-size-harness-material-harness",
  "integration.images.build.context-file-size-candidate-default",
  "integration.images.build.context-file-size-candidate-harness",
  "integration.images.build.context-file-size-testkit-default",
  "integration.images.build.context-file-size-testkit-harness",
  "integration.images.build.context-file-size-runtime-default",
  "integration.images.build.context-file-size-runtime-harness",
  "integration.images.build.context-file-size-controller-default",
  "integration.images.build.context-file-size-controller-harness",
  "integration.isolation.immutable-candidate",
  "integration.isolation.image-digest",
  "integration.isolation.network",
  "integration.isolation.control-volume",
  "integration.isolation.collector-create",
  "integration.isolation.collector-terminal",
  "integration.isolation.collector-native",
  "integration.isolation.mockserver-image",
  "integration.isolation.mockserver-network",
  "integration.isolation.mockserver-terminal",
  "integration.isolation.child-failure",
  "integration.isolation.fixture-result",
  "integration.isolation.headless-authority",
  "integration.isolation.headless-receipt",
  "integration.isolation.pty-receipt",
  "integration.isolation.scenario-failed",
  "integration.isolation.interrupted",
  "integration.mockserver.control",
  "integration.operations.fixture-result",
  "integration.certification.predicate",
  "integration.harness-material.failed",
  "integration.harness-scenario-admission.invalid",
  "integration.harness-admission.invalid",
  "integration.images.transport",
  "integration.images.timeout",
  "integration.images.deadline",
  "integration.images.daemon",
  "integration.images.daemon-uncertain",
  "integration.images.interrupted-uncertain",
  "integration.images.command",
  "integration.images.containment",
  "integration.images.docker-client",
  "integration.images.cleanup",
  ...cleanupCodes,
  ...materialPhaseCodes,
]);
const causalEnvelopes = new Set([
  "integration.controller.unsettled-operation",
  "integration.harness-material.failed",
  "integration.isolation.child-failure",
  ...cleanupCodes,
]);
export const knownFailureCode = (error: unknown): string => {
  const value = ownErrorValue(error, "message");
  return typeof value === "string" &&
    value.length <= 96 &&
    knownFailureCodes.has(value)
    ? value
    : "unknown";
};
const firstFailureCodes = (primaryCause: unknown, cleanupCause: unknown) => {
  const primary = knownFailureCode(primaryCause);
  const causal = causalEnvelopes.has(primary)
    ? knownFailureCode(ownErrorValue(primaryCause, "cause"))
    : "unknown";
  const cleanup = knownFailureCode(cleanupCause);
  return primary === "unknown" && causal === "unknown" && cleanup === "unknown"
    ? undefined
    : Object.freeze({ primary, causal, cleanup });
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
  const firstCodes = firstFailureCodes(input.primaryCause, input.cleanupCause);
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
      ...(firstCodes === undefined ? {} : { firstCodes }),
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
