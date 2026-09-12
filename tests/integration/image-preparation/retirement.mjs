/* eslint import-x/no-cycle: "off" -- private in-process controller capability */
/** Prepared image, Docker client, and uncertain-resource retirement. */
import { performance } from "node:perf_hooks";

import {
  diagnosticDigest,
  fixedError,
  preparationPolicy,
  preparationTeardownMilliseconds,
  sameDaemon,
} from "./boundary.mjs";
import { cleanupPrivateClient } from "./private-storage.mjs";

// eslint-disable-next-line max-lines-per-function -- one private closure owns retirement transitions over the facade's unexported lifecycle state.
export const createRetirementOperations = (state, docker) => {
  const {
    assertSocketCurrentFor,
    engineCall,
    engineTransport,
    inspectDaemon,
    inspectEngineObject,
  } = docker;
  const retirePreparedDockerImage = async (
    client,
    { deadline, imageId, signal, tag },
  ) => {
    const retirementMilliseconds = Math.floor(deadline - performance.now());
    if (
      !state.hasClient(client) ||
      state.clientIsClosing(client) ||
      state.clientIsUncertain(client) ||
      !/^sha256-[a-f\d]{64}$/u.test(imageId ?? "") ||
      !/^[a-z\d][a-z\d._/-]{0,127}:[a-z\d][a-z\d._-]{0,127}$/u.test(tag ?? "")
    )
      throw fixedError("integration.images.docker-client");
    if (state.pendingImageId(client, tag) !== imageId)
      throw fixedError("integration.images.docker-client");
    if (
      !Number.isFinite(deadline) ||
      retirementMilliseconds < 4 ||
      retirementMilliseconds > 30_000
    ) {
      markPreparedDockerClientForOuterHostRetirement(client);
      throw fixedError("integration.images.deadline");
    }
    const policy = preparationPolicy([client.evidence.images[0].image], {
      maximumPreparationMilliseconds: retirementMilliseconds,
      teardownMilliseconds: Math.min(
        preparationTeardownMilliseconds,
        Math.max(1, Math.floor(retirementMilliseconds / 4)),
      ),
    });
    const engine =
      client.engineRequestForTesting ?? engineTransport(client.socket);
    try {
      const daemon = await inspectDaemon(engine, client.socket, policy, signal);
      if (!sameDaemon(client.evidence.dockerDaemon, daemon))
        throw fixedError("integration.images.containment");
      const current = await inspectEngineObject({
        daemon,
        engine,
        name: tag,
        policy,
        signal,
        type: "images",
      });
      if (current?.Id?.replace(":", "-") !== imageId)
        throw fixedError("integration.images.containment");
      const removal = await engineCall(
        { policy, signal, transport: engine },
        {
          expected: [200],
          method: "DELETE",
          path: `/v${daemon.apiVersion}/images/${encodeURIComponent(tag)}?force=1&noprune=0`,
        },
      );
      const terminalPolicy = { ...policy, workDeadline: policy.deadline };
      const removalReceipt = JSON.parse(removal.body);
      if (
        !Array.isArray(removalReceipt) ||
        !removalReceipt.some(
          (entry) => entry?.Deleted?.replace(":", "-") === imageId,
        ) ||
        !removalReceipt.some((entry) => entry?.Untagged === tag)
      )
        throw fixedError("integration.images.containment");
      const tagged = await inspectEngineObject({
        daemon,
        engine,
        name: tag,
        policy: terminalPolicy,
        type: "images",
      });
      if (tagged !== undefined)
        throw fixedError("integration.images.containment");
      assertSocketCurrentFor(engine, client.socket);
      if (
        !sameDaemon(
          daemon,
          await inspectDaemon(engine, client.socket, terminalPolicy),
        )
      )
        throw fixedError("integration.images.containment");
      state.completePendingImage(client, tag);
    } catch (error) {
      markPreparedDockerClientForOuterHostRetirement(client);
      throw error;
    }
  };

  const closePreparedDockerClient = (client) => {
    if (state.pendingCount(client) !== 0) {
      if (state.hasClient(client))
        markPreparedDockerClientForOuterHostRetirement(client);
      throw fixedError("integration.images.docker-client");
    }
    if (!state.hasClient(client) || state.clientIsUncertain(client))
      throw fixedError("integration.images.docker-client");
    state.beginClose(client);
    try {
      cleanupPrivateClient(
        client.privateClient,
        performance.now() + preparationTeardownMilliseconds,
      );
      state.finishClose(client);
    } catch (error) {
      state.markUncertain(client);
      if (error?.privateCleanupDiagnostic !== undefined)
        state.recordDiagnostic(client, error.privateCleanupDiagnostic);
      throw error;
    } finally {
      state.endClose(client);
    }
  };

  const preparedDockerClientRequiresOuterHostRetirement = (client) =>
    state.clientIsUncertain(client);

  const markPreparedDockerClientForOuterHostRetirement = (client) => {
    if (!state.hasClient(client))
      throw fixedError("integration.images.docker-client");
    if (!state.hasDiagnostic(client))
      state.recordDiagnostic(
        client,
        Object.freeze({
          diagnosticVersion: 1,
          stage: "scenario-operation",
          authorityDigests: Object.freeze({
            daemon: diagnosticDigest(client.evidence.dockerDaemon),
            images: diagnosticDigest(client.evidence.images),
            socket: diagnosticDigest(client.evidence.dockerSocket),
          }),
          outcome: "retired-failure",
          retirementReason: "mutation-outcome-unknown",
        }),
      );
    state.markUncertain(client);
  };

  const definiteMissingDockerResource = (error) => {
    if (
      !Number.isSafeInteger(error?.code) ||
      error.code < 1 ||
      error?.signal != null ||
      error?.killed === true ||
      error?.name === "AbortError" ||
      (error?.stdout ?? "") !== "" ||
      typeof error?.stderr !== "string"
    )
      return false;
    return /^(?:Error response from daemon: )?(?:No such (?:container|image): [^\r\n]+|network [^\r\n]+ not found)\r?\n?$/u.test(
      error.stderr,
    );
  };

  const handlePreparedDockerCleanupFailure = (client, error) => {
    if (definiteMissingDockerResource(error)) return;
    markPreparedDockerClientForOuterHostRetirement(client);
    throw error;
  };

  return Object.freeze({
    closePreparedDockerClient,
    handlePreparedDockerCleanupFailure,
    markPreparedDockerClientForOuterHostRetirement,
    preparedDockerClientRequiresOuterHostRetirement,
    retirePreparedDockerImage,
  });
};
