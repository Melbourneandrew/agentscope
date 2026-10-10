import { types } from "node:util";
import { performance } from "node:perf_hooks";
import {
  fixedError,
  jsonRecord,
  maximumEvidenceBytes,
  maximumManifestBytes,
  maximumResponseBytes,
  preparationPolicy,
  productionDockerSocket,
  resolveDockerSocket,
  validSocketEvidence,
  readImageRequestDiagnostic,
} from "./boundary.mjs";
import { registryTransport } from "./registry.mjs";

// These projections are diagnostic hints, never mutation or cleanup authority.
const diagnostics = new WeakMap();
const engineFailures = new WeakMap();
const objectKey = (value) =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const ownErrorValue = (error, name) => {
  if (!types.isNativeError(error) || types.isProxy(error)) return undefined;
  return Object.getOwnPropertyDescriptor(error, name)?.value;
};

export const readImagePreparationDiagnostic = (error) =>
  objectKey(error) ? diagnostics.get(error) : undefined;

// Preserve the setup primary and cleanup uncertainty without exposing either
// exception's arbitrary message or inventing mutation/retirement authority.
export const recordClientSetupCleanupFailure = (primary, cleanup) => {
  const failure = fixedError("integration.images.cleanup");
  diagnostics.set(
    failure,
    Object.freeze({
      primary: "preparation-failed",
      cleanup: "private-cleanup-failed",
      trigger:
        ownErrorValue(primary, "message") === "integration.images.deadline"
          ? "timeout"
          : "unknown",
      reconciliation: "not-attempted",
    }),
  );
  // Keep the cleanup's bounded inventory projection when it exists; it is
  // diagnostic data only and never read as a cleanup capability.
  const detail = ownErrorValue(cleanup, "privateCleanupDiagnostic");
  if (detail !== undefined) failure.privateCleanupDiagnostic = detail;
  return failure;
};

export const recordUnexpectedEngineStatus = (error) => {
  engineFailures.set(error, "unexpected-status");
  return error;
};

const transportTrigger = (error) => {
  if (objectKey(error) && engineFailures.has(error))
    return engineFailures.get(error);
  const message = ownErrorValue(error, "message");
  if (message === "integration.images.interrupted") return "abort";
  if (
    message === "integration.images.timeout" ||
    ownErrorValue(error, "code") === "ETIMEDOUT"
  )
    return "timeout";
  if (message === "integration.images.transport") return "transport";
  return "unknown";
};

export const createPullOperation =
  ({ engineCall, inspectLocalImage, platformText }) =>
  async ({ daemon, image, platform, policy, signal, transport }) => {
    const separator = image.lastIndexOf("@");
    const repository = image.slice(0, separator);
    const digest = image.slice(separator + 1);
    let trigger;
    try {
      const response = await engineCall(
        { policy, signal, transport },
        {
          expected: [200],
          method: "POST",
          path: `/v${daemon.apiVersion}/images/create?fromImage=${encodeURIComponent(repository)}&tag=${encodeURIComponent(digest)}&platform=${encodeURIComponent(platformText(platform))}`,
          requestPhase: "image-pull",
        },
      );
      const lines = response.body
        .toString("utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      if (lines.length === 0) {
        trigger = "empty-events";
        throw fixedError("integration.images.daemon");
      }
      for (const line of lines) {
        let event;
        try {
          event = jsonRecord(line, "integration.images.daemon");
        } catch (error) {
          trigger = "malformed-event";
          throw error;
        }
        if (event.error !== undefined || event.errorDetail !== undefined) {
          trigger = "daemon-error-event";
          throw fixedError("integration.images.daemon");
        }
      }
    } catch (error) {
      trigger ??= transportTrigger(error);
      let reconciliation = "completed";
      try {
        await inspectLocalImage({
          daemon,
          image,
          missingAllowed: true,
          policy: { ...policy, workDeadline: policy.reconciliationDeadline },
          signal: undefined,
          transport,
        });
      } catch {
        reconciliation = "failed";
      }
      // Preserve the original controlling failure and timeout classification.
      const failure = fixedError(
        error instanceof Error &&
          error.message === "integration.images.interrupted"
          ? "integration.images.interrupted-uncertain"
          : "integration.images.daemon-uncertain",
        error?.code === "ETIMEDOUT",
      );
      diagnostics.set(
        failure,
        Object.freeze({
          primary: "pull-outcome-unknown",
          cleanup: "none",
          trigger,
          reconciliation,
          ...(readImageRequestDiagnostic(error) === undefined
            ? {}
            : { request: readImageRequestDiagnostic(error) }),
        }),
      );
      throw failure;
    }
  };

const preparationFailure = (error) =>
  error instanceof Error &&
  /^integration\.images\.[a-z-]+$/u.test(error.message)
    ? error
    : fixedError("integration.images.setup");

export const prepareImageOperation = async (
  state,
  dependencies,
  images,
  options = {},
) => {
  const policy = preparationPolicy(images, options);
  let privateClient;
  let prepared;
  let failure;
  let primaryDiagnostic;
  try {
    const socket =
      options.socketIdentityForTesting === undefined
        ? options.dockerSocket === undefined
          ? resolveDockerSocket(options.dockerSocketForTesting)
          : productionDockerSocket(options.dockerSocket)
        : Object.freeze({ ...options.socketIdentityForTesting });
    if (!validSocketEvidence(socket))
      throw fixedError("integration.images.socket");
    privateClient = dependencies.createPrivateClientRoot(
      options,
      policy.deadline,
    );
    const engine =
      options.engineRequestForTesting === undefined
        ? dependencies.engineTransport(socket)
        : options.engineRequestForTesting;
    const registry = options.registryRequestForTesting ?? registryTransport;
    prepared = await dependencies.prepareImageSet({
      engine,
      images,
      policy,
      registry,
      signal: options.signal,
      socket,
    });
    if (performance.now() >= policy.workDeadline)
      throw fixedError("integration.images.timeout", true);
  } catch (error) {
    failure = preparationFailure(error);
    primaryDiagnostic =
      readImagePreparationDiagnostic(error) ??
      Object.freeze({
        primary: "preparation-failed",
        cleanup: "none",
        trigger: "unknown",
        reconciliation: "not-attempted",
        ...(readImageRequestDiagnostic(error) === undefined
          ? {}
          : { request: readImageRequestDiagnostic(error) }),
      });
    diagnostics.set(failure, primaryDiagnostic);
  }
  if (privateClient !== undefined) {
    try {
      options.beforePrivateCleanupForTesting?.(privateClient.root);
      dependencies.cleanupPrivateClient(privateClient, policy.deadline);
    } catch {
      // Cleanup remains the controlling error, exactly as before this diagnostic.
      failure = fixedError("integration.images.cleanup");
      diagnostics.set(
        failure,
        Object.freeze({
          ...(primaryDiagnostic ?? {
            primary: "none",
            trigger: "unknown",
            reconciliation: "not-attempted",
          }),
          cleanup: "private-cleanup-failed",
        }),
      );
    }
  }
  if (failure !== undefined) throw failure;
  if (performance.now() >= policy.deadline)
    throw fixedError("integration.images.timeout", true);
  const completed = Object.freeze({
    ...prepared,
    preparationPolicy: Object.freeze({
      maximumPreparationMilliseconds: policy.maximumPreparationMilliseconds,
      teardownMilliseconds: policy.teardownMilliseconds,
      maximumResponseBytes,
      maximumManifestBytes,
      maximumEvidenceBytes,
    }),
    terminalCleanup: Object.freeze({
      daemon: "stable",
      handles: "settled",
      privateState: "retained-for-outer-host-retirement",
    }),
  });
  state.admitPreparedSet(completed);
  return completed;
};
