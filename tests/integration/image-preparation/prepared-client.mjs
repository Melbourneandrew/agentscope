/* eslint import-x/no-cycle: "off" -- existing private controller capability */
/** Construction only; lifecycle authority stays in the existing facade state. */
import { performance } from "node:perf_hooks";
import {
  fixedError,
  preparationTeardownMilliseconds,
  productionDockerEnvironment,
  productionDockerExecutable,
  resolveBuildxExecutable,
  resolveDockerExecutable,
  sameSocket,
  socketRecord,
  validEvidenceDaemon,
  validSocketEvidence,
  BUILDKIT_IMAGE,
} from "./boundary.mjs";
import {
  cleanupPrivateClient,
  createPrivateClientRoot,
} from "./private-storage.mjs";
import {
  readImagePreparationDiagnostic,
  recordClientSetupCleanupFailure,
} from "./preparation.mjs";

export const createPreparedClient = (state, evidence, options = {}) => {
  // Capture the fallback before validation and filesystem work, not in catch.
  const enteredAt = performance.now();
  const setupDeadline = enteredAt + preparationTeardownMilliseconds;
  const lifecycleDeadline = options.deadline;
  let privateClient;
  try {
    if (
      lifecycleDeadline !== undefined &&
      (!Number.isFinite(lifecycleDeadline) ||
        lifecycleDeadline <= enteredAt ||
        lifecycleDeadline - enteredAt > 300_000)
    )
      throw fixedError("integration.images.deadline");
    if (
      typeof evidence !== "object" ||
      evidence === null ||
      !validSocketEvidence(evidence.dockerSocket) ||
      !validEvidenceDaemon(evidence.dockerDaemon) ||
      !Array.isArray(evidence.images) ||
      evidence.images.length === 0
    )
      throw fixedError("integration.images.docker-client");
    const socket =
      options.socketIdentityForTesting === undefined
        ? socketRecord(evidence.dockerSocket.path)
        : Object.freeze({ ...options.socketIdentityForTesting });
    if (!sameSocket(socket, evidence.dockerSocket))
      throw fixedError("integration.images.docker-client");
    const executable =
      options.dockerExecutable === undefined
        ? resolveDockerExecutable(options.dockerExecutableForTesting)
        : productionDockerExecutable(options.dockerExecutable);
    const requestedBuildxExecutable =
      options.buildxExecutable ?? options.buildxExecutableForTesting;
    const buildxExecutable =
      requestedBuildxExecutable === undefined
        ? undefined
        : resolveBuildxExecutable(requestedBuildxExecutable);
    const environment =
      options.dockerEnvironment === undefined
        ? Object.freeze({})
        : productionDockerEnvironment(options.dockerEnvironment, socket);
    privateClient = createPrivateClientRoot(
      options,
      setupDeadline,
      Object.freeze({ deadline: lifecycleDeadline }),
    );
    const client = Object.freeze({
      evidence,
      buildxExecutable,
      buildkitImage: options.buildkitImageForTesting ?? BUILDKIT_IMAGE,
      buildxRunForTesting: options.buildxRunForTesting,
      executable,
      environment,
      privateClient,
      socket,
      engineRequestForTesting: options.engineRequestForTesting,
    });
    state.admitClient(client);
    return client;
  } catch (error) {
    if (privateClient !== undefined) {
      try {
        cleanupPrivateClient(
          privateClient,
          Math.min(setupDeadline, privateClient.lifecycleDeadline ?? Infinity),
        );
      } catch (cleanupError) {
        throw recordClientSetupCleanupFailure(error, cleanupError);
      }
    }
    // Preserve the actual diagnostic identity from a failed creation prefix.
    if (readImagePreparationDiagnostic(error) !== undefined) throw error;
    throw fixedError("integration.images.docker-client");
  }
};
