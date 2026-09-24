/* eslint import-x/no-cycle: "off" -- private in-process controller capability */
/** Prepared image, Docker client, and uncertain-resource retirement. */
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

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
  const validateNetworkInput = (client, { deadline, name, runId }) => {
    const retirementMilliseconds = Math.floor(deadline - performance.now());
    if (
      !state.hasClient(client) ||
      state.clientIsClosing(client) ||
      state.clientIsUncertain(client) ||
      !/^agentscope-int-[a-f\d]{16}-network$/u.test(name ?? "") ||
      !/^[a-f\d]{16}$/u.test(runId ?? "")
    )
      throw fixedError("integration.images.docker-client");
    if (
      !Number.isFinite(deadline) ||
      retirementMilliseconds < 4 ||
      retirementMilliseconds > 30_000
    ) {
      markPreparedDockerClientForOuterHostRetirement(client);
      throw fixedError("integration.images.deadline");
    }
    return preparationPolicy([client.evidence.images[0].image], {
      maximumPreparationMilliseconds: retirementMilliseconds,
      teardownMilliseconds: Math.min(
        preparationTeardownMilliseconds,
        Math.max(1, Math.floor(retirementMilliseconds / 4)),
      ),
    });
  };
  const inspectPreparedNetwork = async ({
    daemon,
    engine,
    name,
    policy,
    runId,
    signal,
  }) => {
    const response = await engineCall(
      { policy, signal, transport: engine },
      {
        expected: [200, 404],
        method: "GET",
        path: `/v${daemon.apiVersion}/networks/${encodeURIComponent(name)}`,
      },
    );
    if (response.statusCode === 404) return undefined;
    const network = JSON.parse(response.body);
    const containers = network?.Containers;
    if (
      !/^[a-f\d]{64}$/u.test(network?.Id ?? "") ||
      network?.Name !== name ||
      typeof network?.Internal !== "boolean" ||
      network?.Labels?.["com.agentscope.integration"] !== "true" ||
      network?.Labels?.["com.agentscope.integration.run"] !== runId ||
      (containers !== null &&
        (typeof containers !== "object" || Array.isArray(containers)))
    )
      throw fixedError("integration.images.containment");
    return network;
  };
  const validateControlVolumeInput = (client, { deadline, name, runId }) => {
    if (
      name !== `agentscope-int-${runId}-control` ||
      !/^[a-f\d]{16}$/u.test(runId ?? "")
    )
      throw fixedError("integration.images.docker-client");
    return validateNetworkInput(client, {
      deadline,
      name: `agentscope-int-${runId}-network`,
      runId,
    });
  };
  const inspectPreparedControlVolume = async ({
    daemon,
    engine,
    name,
    policy,
    runId,
    signal,
  }) => {
    const response = await engineCall(
      { policy, signal, transport: engine },
      {
        expected: [200, 404],
        method: "GET",
        path: `/v${daemon.apiVersion}/volumes/${encodeURIComponent(name)}`,
      },
    );
    if (response.statusCode === 404) return undefined;
    const volume = JSON.parse(response.body);
    if (
      volume?.Name !== name ||
      volume?.Driver !== "local" ||
      volume?.Scope !== "local" ||
      typeof volume?.CreatedAt !== "string" ||
      volume.CreatedAt.length === 0 ||
      typeof volume?.Mountpoint !== "string" ||
      volume.Mountpoint.length === 0 ||
      volume?.Labels?.["com.agentscope.integration"] !== "true" ||
      volume?.Labels?.["com.agentscope.integration.run"] !== runId ||
      (volume?.Options !== null &&
        (typeof volume.Options !== "object" ||
          Array.isArray(volume.Options) ||
          Object.keys(volume.Options).length !== 0))
    )
      throw fixedError("integration.images.containment");
    return Object.freeze({
      name,
      runId,
      createdAt: volume.CreatedAt,
      mountpoint: volume.Mountpoint,
    });
  };
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

  const registerPreparedDockerNetwork = async (
    client,
    { deadline, name, runId, signal },
  ) => {
    const policy = validateNetworkInput(client, { deadline, name, runId });
    if (state.pendingNetwork(client, name) !== undefined)
      throw fixedError("integration.images.docker-client");
    const engine =
      client.engineRequestForTesting ?? engineTransport(client.socket);
    try {
      const daemon = await inspectDaemon(engine, client.socket, policy, signal);
      if (!sameDaemon(client.evidence.dockerDaemon, daemon))
        throw fixedError("integration.images.containment");
      const network = await inspectPreparedNetwork({
        daemon,
        engine,
        name,
        policy,
        runId,
        signal,
      });
      if (
        network === undefined ||
        (network.Containers !== null &&
          Object.keys(network.Containers).length !== 0)
      )
        throw fixedError("integration.images.containment");
      assertSocketCurrentFor(engine, client.socket);
      state.recordPendingNetwork(client, name, {
        networkId: network.Id,
        runId,
      });
      return network.Internal;
    } catch (error) {
      markPreparedDockerClientForOuterHostRetirement(client);
      throw error;
    }
  };

  const retirePreparedDockerNetwork = async (
    client,
    { deadline, name, runId, signal },
  ) => {
    const policy = validateNetworkInput(client, { deadline, name, runId });
    const pending = state.pendingNetwork(client, name);
    if (
      pending?.runId !== runId ||
      !/^[a-f\d]{64}$/u.test(pending?.networkId ?? "")
    )
      throw fixedError("integration.images.docker-client");
    const engine =
      client.engineRequestForTesting ?? engineTransport(client.socket);
    try {
      const daemon = await inspectDaemon(engine, client.socket, policy, signal);
      if (!sameDaemon(client.evidence.dockerDaemon, daemon))
        throw fixedError("integration.images.containment");
      let network;
      for (;;) {
        network = await inspectPreparedNetwork({
          daemon,
          engine,
          name,
          policy,
          runId,
          signal,
        });
        if (network?.Id !== pending.networkId)
          throw fixedError("integration.images.containment");
        if (
          network.Containers === null ||
          Object.keys(network.Containers).length === 0
        )
          break;
        if (performance.now() + 20 >= policy.workDeadline)
          throw fixedError("integration.images.deadline");
        await delay(20, undefined, { signal });
      }
      await engineCall(
        { policy, signal, transport: engine },
        {
          expected: [204],
          method: "DELETE",
          path: `/v${daemon.apiVersion}/networks/${encodeURIComponent(name)}`,
        },
      );
      const terminalPolicy = { ...policy, workDeadline: policy.deadline };
      if (
        (await inspectPreparedNetwork({
          daemon,
          engine,
          name,
          policy: terminalPolicy,
          runId,
          signal,
        })) !== undefined
      )
        throw fixedError("integration.images.containment");
      assertSocketCurrentFor(engine, client.socket);
      if (
        !sameDaemon(
          daemon,
          await inspectDaemon(engine, client.socket, terminalPolicy),
        )
      )
        throw fixedError("integration.images.containment");
      state.completePendingNetwork(client, name);
    } catch (error) {
      markPreparedDockerClientForOuterHostRetirement(client);
      throw error;
    }
  };

  const registerPreparedDockerControlVolume = async (
    client,
    { deadline, name, runId, signal },
  ) => {
    const policy = validateControlVolumeInput(client, {
      deadline,
      name,
      runId,
    });
    if (state.pendingControlVolume(client, name) !== undefined)
      throw fixedError("integration.images.docker-client");
    const engine =
      client.engineRequestForTesting ?? engineTransport(client.socket);
    try {
      const daemon = await inspectDaemon(engine, client.socket, policy, signal);
      if (!sameDaemon(client.evidence.dockerDaemon, daemon))
        throw fixedError("integration.images.containment");
      const volume = await inspectPreparedControlVolume({
        daemon,
        engine,
        name,
        policy,
        runId,
        signal,
      });
      if (volume === undefined)
        throw fixedError("integration.images.containment");
      assertSocketCurrentFor(engine, client.socket);
      state.recordPendingControlVolume(client, name, volume);
      return volume;
    } catch (error) {
      markPreparedDockerClientForOuterHostRetirement(client);
      throw error;
    }
  };

  const retirePreparedDockerControlVolume = async (
    client,
    { deadline, name, runId, signal },
  ) => {
    const policy = validateControlVolumeInput(client, {
      deadline,
      name,
      runId,
    });
    const pending = state.pendingControlVolume(client, name);
    if (pending?.runId !== runId)
      throw fixedError("integration.images.docker-client");
    const engine =
      client.engineRequestForTesting ?? engineTransport(client.socket);
    try {
      const daemon = await inspectDaemon(engine, client.socket, policy, signal);
      if (!sameDaemon(client.evidence.dockerDaemon, daemon))
        throw fixedError("integration.images.containment");
      const current = await inspectPreparedControlVolume({
        daemon,
        engine,
        name,
        policy,
        runId,
        signal,
      });
      if (
        current?.createdAt !== pending.createdAt ||
        current?.mountpoint !== pending.mountpoint
      )
        throw fixedError("integration.images.containment");
      await engineCall(
        { policy, signal, transport: engine },
        {
          expected: [204],
          method: "DELETE",
          path: `/v${daemon.apiVersion}/volumes/${encodeURIComponent(name)}`,
        },
      );
      const terminalPolicy = { ...policy, workDeadline: policy.deadline };
      if (
        (await inspectPreparedControlVolume({
          daemon,
          engine,
          name,
          policy: terminalPolicy,
          runId,
          signal,
        })) !== undefined
      )
        throw fixedError("integration.images.containment");
      assertSocketCurrentFor(engine, client.socket);
      if (
        !sameDaemon(
          daemon,
          await inspectDaemon(engine, client.socket, terminalPolicy),
        )
      )
        throw fixedError("integration.images.containment");
      state.completePendingControlVolume(client, name);
    } catch (error) {
      markPreparedDockerClientForOuterHostRetirement(client);
      throw error;
    }
  };

  const closePreparedDockerClient = (client) => {
    if (
      state.pendingCount(client) !== 0 ||
      state.pendingNetworkCount(client) !== 0 ||
      state.pendingControlVolumeCount(client) !== 0
    ) {
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
    registerPreparedDockerNetwork,
    registerPreparedDockerControlVolume,
    retirePreparedDockerImage,
    retirePreparedDockerNetwork,
    retirePreparedDockerControlVolume,
  });
};
