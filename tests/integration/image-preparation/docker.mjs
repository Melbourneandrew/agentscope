/* eslint import-x/no-cycle: "off" -- private in-process controller capability */
/** Docker Engine and buildx preparation using one frozen client snapshot. */
import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  BUILDKIT_IMAGE,
  IMAGE_PREPARATION_EXECUTION_POLICY,
  apiVersionPattern,
  assertSocketCurrent,
  boundedRequest,
  boundedText,
  daemonIdentity,
  defaultMaximumBuildContextBytes,
  diagnosticDigest,
  digestPattern,
  exactKeys,
  executableRecord,
  fixedError,
  jsonRecord,
  localImageRecord,
  maximumEvidenceBytes,
  maximumManifestBytes,
  maximumResponseBytes,
  normalizePlatform,
  preparationPolicy,
  preparationTeardownMilliseconds,
  productionDockerEnvironment,
  productionDockerExecutable,
  productionDockerSocket,
  requestWith,
  resolveBuildxExecutable,
  resolveDockerExecutable,
  resolveDockerSocket,
  runOwnedImageCommandForTesting,
  sameDaemon,
  sameExecutable,
  samePlatform,
  sameSocket,
  socketRecord,
  validEvidenceDaemon,
  validSocketEvidence,
  readImageProcessDiagnostic,
} from "./boundary.mjs";
import { createBoundedBuildContext } from "./build-context.mjs";
import { evidenceImage } from "./evidence.mjs";
import {
  cleanupPrivateClient,
  createPrivateClientRoot,
} from "./private-storage.mjs";
import { acquireManifestProof, registryTransport } from "./registry.mjs";
// eslint-disable-next-line max-lines-per-function -- one private closure owns the complete client lifecycle authority without exporting mutable stores.
export const createDockerOperations = (state) => {
  const engineTransport = (socket) => {
    const transport = (request) => {
      assertSocketCurrent(socket);
      return boundedRequest({ ...request, socketPath: socket.path });
    };
    transport.production = true;
    return transport;
  };
  const engineCall = async (
    { policy, signal, transport },
    { body, expected, headers, method, path, maximumBytes },
  ) => {
    const response = await requestWith(transport, {
      deadline: policy.workDeadline,
      headers: Object.freeze({ Accept: "application/json", ...headers }),
      method,
      path,
      signal,
      maximumBytes: maximumBytes ?? maximumResponseBytes,
      ...(body === undefined ? {} : { body }),
    });
    if (!expected.includes(response.statusCode))
      throw fixedError("integration.images.daemon");
    return response;
  };
  const inspectDaemon = async (transport, socket, policy, signal) => {
    const context = { policy, signal, transport };
    const versionResponse = await engineCall(context, {
      expected: [200],
      method: "GET",
      path: "/version",
    });
    const version = jsonRecord(
      versionResponse.body,
      "integration.images.daemon",
    );
    if (!apiVersionPattern.test(version.ApiVersion ?? ""))
      throw fixedError("integration.images.daemon");
    const infoResponse = await engineCall(context, {
      expected: [200],
      method: "GET",
      path: `/v${version.ApiVersion}/info`,
    });
    return daemonIdentity(socket, version, infoResponse.body);
  };
  const inspectLocalImage = async ({
    daemon,
    image,
    missingAllowed = false,
    policy,
    signal,
    transport,
  }) => {
    const response = await engineCall(
      { policy, signal, transport },
      {
        expected: missingAllowed ? [200, 404] : [200],
        method: "GET",
        path: `/v${daemon.apiVersion}/images/${encodeURIComponent(image)}/json`,
      },
    );
    return response.statusCode === 404
      ? undefined
      : localImageRecord(response.body, image);
  };

  const pullImage = async ({
    daemon,
    image,
    platform,
    policy,
    signal,
    transport,
  }) => {
    const separator = image.lastIndexOf("@");
    const repository = image.slice(0, separator);
    const digest = image.slice(separator + 1);
    try {
      const response = await engineCall(
        { policy, signal, transport },
        {
          expected: [200],
          method: "POST",
          path: `/v${daemon.apiVersion}/images/create?fromImage=${encodeURIComponent(repository)}&tag=${encodeURIComponent(digest)}&platform=${encodeURIComponent(platformText(platform))}`,
        },
      );
      const lines = response.body
        .toString("utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      if (lines.length === 0) throw fixedError("integration.images.daemon");
      for (const line of lines) {
        const event = jsonRecord(line, "integration.images.daemon");
        if (event.error !== undefined || event.errorDetail !== undefined)
          throw fixedError("integration.images.daemon");
      }
    } catch (error) {
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
        // The current attempt remains failed even if exact reconciliation fails.
      }
      throw fixedError(
        error instanceof Error &&
          error.message === "integration.images.interrupted"
          ? "integration.images.interrupted-uncertain"
          : "integration.images.daemon-uncertain",
        error?.code === "ETIMEDOUT",
      );
    }
  };

  const assertSocketCurrentFor = (engine, socket) => {
    if (engine.production === true) assertSocketCurrent(socket);
  };
  const prepareImageSet = async ({
    engine,
    images,
    policy,
    registry,
    signal,
    socket,
  }) => {
    const initialDaemon = await inspectDaemon(engine, socket, policy, signal);
    const canonicalPlatform = normalizePlatform(
      IMAGE_PREPARATION_EXECUTION_POLICY.platform,
    );
    const tokenCache = new Map();
    const preparedImages = [];
    let evidenceBytes = 2;
    for (const image of images) {
      const proof = await acquireManifestProof({
        image,
        platform: canonicalPlatform,
        policy,
        signal,
        tokenCache,
        transport: registry,
      });
      let local = await inspectLocalImage({
        daemon: initialDaemon,
        image,
        missingAllowed: true,
        policy,
        signal,
        transport: engine,
      });
      if (local === undefined) {
        await pullImage({
          daemon: initialDaemon,
          image,
          platform: canonicalPlatform,
          policy,
          signal,
          transport: engine,
        });
        local = await inspectLocalImage({
          daemon: initialDaemon,
          image,
          policy,
          signal,
          transport: engine,
        });
      }
      if (
        !samePlatform(local.platform, proof.platform) ||
        local.configDigest !== proof.configDigest
      )
        throw fixedError("integration.images.config");
      const preparedImage = Object.freeze({ image, ...proof });
      evidenceBytes +=
        Buffer.byteLength(JSON.stringify(preparedImage), "utf8") + 1;
      if (evidenceBytes > maximumEvidenceBytes)
        throw fixedError("integration.images.output");
      preparedImages.push(preparedImage);
    }
    assertSocketCurrentFor(engine, socket);
    const finalDaemon = await inspectDaemon(engine, socket, policy, signal);
    if (!sameDaemon(initialDaemon, finalDaemon))
      throw fixedError("integration.images.daemon");
    return Object.freeze({
      dockerSocket: socket,
      dockerDaemon: initialDaemon,
      images: Object.freeze(preparedImages),
    });
  };

  const preparationFailure = (error) =>
    error instanceof Error &&
    /^integration\.images\.[a-z-]+$/u.test(error.message)
      ? error
      : fixedError("integration.images.setup");

  const imagePreparationFailureRequiresOuterHostRetirement = (error) =>
    error instanceof Error &&
    [
      "integration.images.daemon-uncertain",
      "integration.images.interrupted-uncertain",
    ].includes(error.message);

  const preparePinnedDockerImages = async (images, options = {}) => {
    const policy = preparationPolicy(images, options);
    let privateClient;
    let prepared;
    let failure;
    try {
      const socket =
        options.socketIdentityForTesting === undefined
          ? options.dockerSocket === undefined
            ? resolveDockerSocket(options.dockerSocketForTesting)
            : productionDockerSocket(options.dockerSocket)
          : Object.freeze({ ...options.socketIdentityForTesting });
      if (!validSocketEvidence(socket))
        throw fixedError("integration.images.socket");
      privateClient = createPrivateClientRoot(options);
      const engine =
        options.engineRequestForTesting === undefined
          ? engineTransport(socket)
          : options.engineRequestForTesting;
      const registry = options.registryRequestForTesting ?? registryTransport;
      prepared = await prepareImageSet({
        engine,
        images,
        policy,
        registry,
        signal: options.signal,
        socket,
      });
    } catch (error) {
      failure = preparationFailure(error);
    }
    if (privateClient !== undefined) {
      try {
        options.beforePrivateCleanupForTesting?.(privateClient.root);
        cleanupPrivateClient(privateClient, policy.deadline);
      } catch {
        failure = fixedError("integration.images.cleanup");
      }
    }
    if (failure !== undefined) throw failure;
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

  const revalidatePreparedImageAdmission = async (
    evidence,
    image,
    options = {},
  ) => {
    try {
      const prepared = evidence.images.find((entry) => entry.image === image);
      if (prepared === undefined) return false;
      const proof = evidenceImage(prepared);
      const policy = preparationPolicy([image], {
        maximumPreparationMilliseconds:
          options.maximumPreparationMilliseconds ?? 30_000,
        teardownMilliseconds: options.teardownMilliseconds ?? 1_000,
      });
      const socket =
        options.socketIdentityForTesting === undefined
          ? socketRecord(evidence.dockerSocket.path)
          : Object.freeze({ ...options.socketIdentityForTesting });
      if (!sameSocket(socket, evidence.dockerSocket)) return false;
      const engine =
        options.engineRequestForTesting === undefined
          ? engineTransport(socket)
          : options.engineRequestForTesting;
      const daemon = await inspectDaemon(
        engine,
        socket,
        policy,
        options.signal,
      );
      const local = await inspectLocalImage({
        daemon,
        image,
        policy,
        signal: options.signal,
        transport: engine,
      });
      assertSocketCurrentFor(engine, socket);
      const finalDaemon = await inspectDaemon(
        engine,
        socket,
        policy,
        options.signal,
      );
      return (
        sameDaemon(evidence.dockerDaemon, daemon) &&
        sameDaemon(daemon, finalDaemon) &&
        samePlatform(proof.platform, local.platform) &&
        proof.configDigest === local.configDigest
      );
    } catch {
      return false;
    }
  };

  const createPreparedDockerClient = (evidence, options = {}) => {
    let privateClient;
    try {
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
      privateClient = createPrivateClientRoot(options);
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
    } catch {
      if (privateClient !== undefined)
        cleanupPrivateClient(
          privateClient,
          performance.now() + preparationTeardownMilliseconds,
        );
      throw fixedError("integration.images.docker-client");
    }
  };

  const prepareDockerInvocation = async (client, arguments_, signal) => {
    if (
      !state.clientIsUsable(client) ||
      !Array.isArray(arguments_) ||
      arguments_.length === 0 ||
      arguments_.length > 256 ||
      arguments_.some(
        (argument) =>
          typeof argument !== "string" ||
          argument.length === 0 ||
          argument.length > 4_096 ||
          argument.includes("\0"),
      )
    )
      throw fixedError("integration.images.docker-client");
    const policy = preparationPolicy([client.evidence.images[0].image], {
      maximumPreparationMilliseconds: 30_000,
      teardownMilliseconds: 1_000,
    });
    const engine =
      client.engineRequestForTesting === undefined
        ? engineTransport(client.socket)
        : client.engineRequestForTesting;
    const initialDaemon = await inspectDaemon(
      engine,
      client.socket,
      policy,
      signal,
    );
    assertSocketCurrentFor(engine, client.socket);
    const finalDaemon = await inspectDaemon(
      engine,
      client.socket,
      policy,
      signal,
    );
    if (
      !sameDaemon(client.evidence.dockerDaemon, initialDaemon) ||
      !sameDaemon(initialDaemon, finalDaemon) ||
      !sameExecutable(
        client.executable,
        executableRecord(client.executable.path),
      )
    )
      throw fixedError("integration.images.docker-client");
    return Object.freeze({
      executable: client.executable.path,
      arguments: Object.freeze([
        "--host",
        `unix://${client.socket.path}`,
        "--config",
        resolve(client.privateClient.root, "docker"),
        ...arguments_,
      ]),
      environment: client.environment,
    });
  };
  const validBuildMap = (value) =>
    exactKeys(value, Object.keys(value ?? {})) &&
    Object.entries(value).every(
      ([name, entry]) => boundedText(name, 128) && boundedText(entry, 1_024),
    );
  const buildxEnvironment = (client) =>
    Object.freeze({
      BUILDX_CONFIG: resolve(client.privateClient.root, "buildx"),
      DOCKER_CONFIG: resolve(client.privateClient.root, "docker"),
      DOCKER_HOST: `unix://${client.socket.path}`,
      HOME: resolve(client.privateClient.root, "home"),
      TMPDIR: resolve(client.privateClient.root, "tmp"),
      XDG_CONFIG_HOME: resolve(client.privateClient.root, "xdg"),
    });
  const platformText = (platform) =>
    `${platform.os}/${platform.architecture}${
      platform.variant === undefined ? "" : `/${platform.variant}`
    }`;
  const builderResources = (builder) =>
    Object.freeze({
      container: `buildx_buildkit_${builder}0`,
      volume: `buildx_buildkit_${builder}0_state`,
    });
  const inspectEngineObject = async ({
    daemon,
    engine,
    name,
    policy,
    signal,
    type,
  }) => {
    const response = await engineCall(
      { policy, signal, transport: engine },
      {
        expected: [200, 404],
        method: "GET",
        path: `/v${daemon.apiVersion}/${type}/${encodeURIComponent(name)}${
          type === "volumes" ? "" : "/json"
        }`,
      },
    );
    return response.statusCode === 404
      ? undefined
      : jsonRecord(response.body, "integration.images.build");
  };
  const removeBuilderResources = async ({
    authority,
    identity,
    policy,
    resources,
  }) => {
    const { client, daemon, engine } = authority;
    if (identity.container !== undefined) {
      const current = await inspectEngineObject({
        daemon,
        engine,
        name: resources.container,
        policy,
        type: "containers",
      });
      const authenticated = authenticateBuilderResources(
        authority,
        resources,
        current,
        undefined,
        false,
      );
      if (authenticated.container === undefined)
        throw fixedError("integration.images.containment");
      await engineCall(
        { policy, signal: undefined, transport: engine },
        {
          expected: [204, 404],
          method: "DELETE",
          path: `/v${daemon.apiVersion}/containers/${authenticated.container.id}?force=1&v=1`,
        },
      );
    }
    if (identity.volume !== undefined) {
      const current = await inspectEngineObject({
        daemon,
        engine,
        name: resources.volume,
        policy,
        type: "volumes",
      });
      const authenticated = authenticateBuilderResources(
        authority,
        resources,
        undefined,
        current,
        false,
      );
      if (authenticated.volume === undefined)
        throw fixedError("integration.images.containment");
      await engineCall(
        { policy, signal: undefined, transport: engine },
        {
          expected: [204, 404],
          method: "DELETE",
          path: `/v${daemon.apiVersion}/volumes/${encodeURIComponent(resources.volume)}?force=1`,
        },
      );
    }
    assertSocketCurrentFor(engine, client.socket);
    const [container, containerIdentity, volume] = await Promise.all([
      inspectEngineObject({
        daemon,
        engine,
        name: resources.container,
        policy,
        type: "containers",
      }),
      identity.container === undefined
        ? undefined
        : inspectEngineObject({
            daemon,
            engine,
            name: identity.container.id,
            policy,
            type: "containers",
          }),
      inspectEngineObject({
        daemon,
        engine,
        name: resources.volume,
        policy,
        type: "volumes",
      }),
    ]);
    if (
      container !== undefined ||
      containerIdentity !== undefined ||
      volume !== undefined
    )
      throw fixedError("integration.images.containment");
  };
  const validBuilderMount = (container, resources) =>
    Array.isArray(container?.Mounts) &&
    container.Mounts.length === 1 &&
    container.Mounts[0]?.Type === "volume" &&
    container.Mounts[0]?.Name === resources.volume &&
    container.Mounts[0]?.Destination === "/var/lib/buildkit" &&
    container.Mounts[0]?.RW === true;
  const builderContainerFailureReason = (
    container,
    { buildkit, buildkitImage, requireRunning, resources },
  ) => {
    if (!/^[a-f\d]{64}$/u.test(container?.Id ?? "")) return "id";
    if (
      typeof container?.Created !== "string" ||
      container.Created.length === 0 ||
      container.Created.length > 128
    )
      return "created";
    if (container?.Name !== `/${resources.container}`) return "name";
    if (container.Image !== buildkit.configDigest) return "image-id";
    if (container.Config?.Image !== buildkitImage) return "image-reference";
    if (container.Platform !== buildkit.platform.os) return "platform";
    if (container.HostConfig?.NetworkMode !== "bridge") return "network-mode";
    if (
      JSON.stringify(Object.keys(container.NetworkSettings?.Networks ?? {})) !==
      JSON.stringify(["bridge"])
    )
      return "network-attachment";
    if (!validBuilderMount(container, resources)) return "mount";
    if (
      (requireRunning && container.State?.Running !== true) ||
      typeof container.State?.Running !== "boolean"
    )
      return "running-state";
    return "matched";
  };
  const assertBuilderContainer = (
    container,
    { buildkit, buildkitImage, requireRunning, resources },
  ) => {
    if (
      builderContainerFailureReason(container, {
        buildkit,
        buildkitImage,
        requireRunning,
        resources,
      }) !== "matched"
    )
      throw fixedError("integration.images.build");
    return Object.freeze({ id: container.Id, createdAt: container.Created });
  };
  const builderVolumeFailureReason = (volume, resources) => {
    if (
      typeof volume?.CreatedAt !== "string" ||
      volume.CreatedAt.length === 0 ||
      volume.CreatedAt.length > 128
    )
      return "created";
    if (volume?.Name !== resources.volume) return "name";
    if (volume.Driver !== "local") return "driver";
    if (volume.Scope !== "local") return "scope";
    if (typeof volume.Mountpoint !== "string" || !isAbsolute(volume.Mountpoint))
      return "mountpoint";
    if (!(
      volume.Labels === null ||
      (typeof volume.Labels === "object" &&
        volume.Labels !== null &&
        Object.keys(volume.Labels).length === 0)
    ))
      return "labels";
    return "matched";
  };
  const assertBuilderVolume = (volume, resources) => {
    if (builderVolumeFailureReason(volume, resources) !== "matched")
      throw fixedError("integration.images.build");
    return Object.freeze({
      createdAt: volume.CreatedAt,
      mountpoint: volume.Mountpoint,
    });
  };
  const inspectBuilderResources = async (
    authority,
    resources,
    signal,
    policy = authority.policy,
  ) => {
    const observed = await Promise.all([
      inspectEngineObject({
        daemon: authority.daemon,
        engine: authority.engine,
        name: resources.container,
        policy,
        signal,
        type: "containers",
      }),
      inspectEngineObject({
        daemon: authority.daemon,
        engine: authority.engine,
        name: resources.volume,
        policy,
        signal,
        type: "volumes",
      }),
    ]);
    authority.lastResourceObservation = Object.freeze({
      responseBytes: observed.reduce(
        (total, value) =>
          total +
          (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value))),
        0,
      ),
      observedCount: observed.filter((value) => value !== undefined).length,
      observedDigest: diagnosticDigest(
        observed.map((value) =>
          value === undefined ? null : diagnosticDigest(value),
        ),
      ),
    });
    return observed;
  };
  const authenticateBuilderResources = (
    authority,
    resources,
    container,
    volume,
    requireRunning,
  ) => {
    const containerReason =
      container === undefined
        ? "absent"
        : builderContainerFailureReason(container, {
            buildkit: authority.buildkit,
            buildkitImage: authority.client.buildkitImage,
            requireRunning,
            resources,
          });
    const volumeReason =
      volume === undefined
        ? "absent"
        : builderVolumeFailureReason(volume, resources);
    authority.reconciliationReasons = Object.freeze({
      builderContainer: containerReason,
      builderVolume: volumeReason,
      builtTag: authority.reconciliationReasons?.builtTag ?? "not-observed",
    });
    const identity = Object.freeze({
      container:
        container === undefined
          ? undefined
          : assertBuilderContainer(container, {
              buildkit: authority.buildkit,
              buildkitImage: authority.client.buildkitImage,
              requireRunning,
              resources,
            }),
      volume:
        volume === undefined
          ? undefined
          : assertBuilderVolume(volume, resources),
    });
    const prior = authority.resourceIdentity;
    if (
      prior !== undefined &&
      ((identity.container !== undefined &&
        JSON.stringify(identity.container) !==
          JSON.stringify(prior.container)) ||
        (identity.volume !== undefined &&
          JSON.stringify(identity.volume) !== JSON.stringify(prior.volume)))
    ) {
      authority.reconciliationReasons = Object.freeze({
        builderContainer:
          identity.container !== undefined &&
          JSON.stringify(identity.container) !== JSON.stringify(prior.container)
            ? "identity-substitution"
            : containerReason,
        builderVolume:
          identity.volume !== undefined &&
          JSON.stringify(identity.volume) !== JSON.stringify(prior.volume)
            ? "identity-substitution"
            : volumeReason,
        builtTag: authority.reconciliationReasons.builtTag,
      });
      throw fixedError("integration.images.containment");
    }
    return identity;
  };
  const inspectBuiltTag = async (
    engine,
    daemon,
    policy,
    signal,
    { labels, platform, tag },
  ) => {
    const built = await inspectEngineObject({
      daemon,
      engine,
      name: tag,
      policy,
      signal,
      type: "images",
    });
    if (
      built === undefined ||
      !digestPattern.test(built.Id ?? "") ||
      !Array.isArray(built.RepoTags) ||
      !built.RepoTags.includes(tag) ||
      !Object.entries(labels).every(
        ([name, value]) => built.Config?.Labels?.[name] === value,
      ) ||
      !samePlatform(
        platform,
        normalizePlatform({
          os: built.Os,
          architecture: built.Architecture,
          variant: built.Variant,
        }),
      )
    )
      throw fixedError("integration.images.build");
    return built;
  };
  const buildArgumentsFor = ({
    buildArguments,
    builder,
    dockerfile,
    labels,
    platform,
    tag,
  }) => {
    const result = [
      "build",
      "--builder",
      builder,
      "--file",
      dockerfile,
      "--load",
      "--network",
      "default",
      "--platform",
      platformText(platform),
      "--pull=false",
      "--tag",
      tag,
    ];
    for (const [name, value] of Object.entries(buildArguments).sort())
      result.push("--build-arg", `${name}=${value}`);
    for (const [name, value] of Object.entries(labels).sort())
      result.push("--label", `${name}=${value}`);
    result.push("-");
    return result;
  };
  const createBuildAuthority = async (
    client,
    policy,
    signal,
    runGeneration,
  ) => {
    const engine =
      client.engineRequestForTesting ?? engineTransport(client.socket);
    const daemon = await inspectDaemon(engine, client.socket, policy, signal);
    if (!sameDaemon(client.evidence.dockerDaemon, daemon))
      throw fixedError("integration.images.build");
    const buildkit = client.evidence.images
      .map(evidenceImage)
      .find((entry) => entry.image === client.buildkitImage);
    if (buildkit === undefined) throw fixedError("integration.images.build");
    const buildxExecutable =
      client.buildxExecutable ?? resolveBuildxExecutable();
    const local = await inspectLocalImage({
      daemon,
      image: client.buildkitImage,
      policy,
      signal,
      transport: engine,
    });
    if (
      local.configDigest !== buildkit.configDigest ||
      !samePlatform(local.platform, buildkit.platform)
    )
      throw fixedError("integration.images.build");
    const builder = /^[a-f0-9]{16}$/u.test(runGeneration ?? "")
      ? `agentscope-${runGeneration}`
      : `agentscope-${randomBytes(8).toString("hex")}`;
    const run = (arguments_, input, deadline = policy.workDeadline) => {
      if (
        !sameExecutable(
          buildxExecutable,
          executableRecord(buildxExecutable.path),
        )
      )
        throw fixedError("integration.images.executable");
      const options = {
        deadline,
        environment: buildxEnvironment(client),
        input,
        observeProcess: (diagnostic) => {
          authority.lastProcessObservation = Object.freeze({
            operationKind: authority.currentOperationKind,
            process: diagnostic,
          });
        },
        signal,
        teardownMilliseconds: policy.teardownMilliseconds,
      };
      return client.buildxRunForTesting === undefined
        ? runOwnedImageCommandForTesting(
            buildxExecutable.path,
            arguments_,
            options,
          )
        : client.buildxRunForTesting(arguments_, options);
    };
    const authority = {
      builder,
      buildkit,
      client,
      daemon,
      engine,
      policy,
      run,
      signal,
      currentOperationKind: "preflight",
      reconciliationReasons: Object.freeze({
        builderContainer: "not-observed",
        builderVolume: "not-observed",
        builtTag: "not-observed",
      }),
    };
    return authority;
  };
  const executeBuilderBuild = async (authority, options, archive) => {
    const { builder, buildkit, client, daemon, engine, policy, run, signal } =
      authority;
    const resources = builderResources(builder);
    const [priorContainer, priorVolume] = await inspectBuilderResources(
      authority,
      resources,
      signal,
    );
    if (priorContainer !== undefined || priorVolume !== undefined)
      throw fixedError("integration.images.containment");
    const priorTag = await inspectEngineObject({
      daemon,
      engine,
      name: options.tag,
      policy,
      signal,
      type: "images",
    });
    if (priorTag !== undefined)
      throw fixedError("integration.images.containment");
    authority.resourcePreflightComplete = true;
    authority.tagPreflightComplete = true;
    authority.requestCapable = true;
    authority.currentOperationKind = "builder-create";
    await run([
      "create",
      "--name",
      builder,
      "--driver",
      "docker-container",
      "--driver-opt",
      `image=${client.buildkitImage}`,
      "--driver-opt",
      "network=bridge",
      "--platform",
      platformText(buildkit.platform),
      `unix://${client.socket.path}`,
    ]);
    authority.currentOperationKind = "builder-bootstrap";
    await run(["inspect", "--builder", builder, "--bootstrap"]);
    const [container, volume] = await inspectBuilderResources(
      authority,
      resources,
      signal,
    );
    authority.resourceIdentity = authenticateBuilderResources(
      authority,
      resources,
      container,
      volume,
      true,
    );
    authority.currentOperationKind = "image-build";
    await run(
      buildArgumentsFor({
        ...options,
        builder,
        platform: buildkit.platform,
      }),
      archive,
    );
    const built = await inspectBuiltTag(engine, daemon, policy, signal, {
      labels: options.labels,
      platform: buildkit.platform,
      tag: options.tag,
    });
    assertSocketCurrentFor(engine, client.socket);
    if (
      !sameDaemon(
        daemon,
        await inspectDaemon(engine, client.socket, policy, signal),
      )
    )
      throw fixedError("integration.images.build");
    return built;
  };
  const settleBuiltTag = async (
    authority,
    options,
    built,
    failed,
    reconciliationPolicy,
  ) => {
    const { daemon, engine, policy } = authority;
    if (!failed) {
      const terminal = await inspectBuiltTag(
        engine,
        daemon,
        { ...policy, workDeadline: policy.deadline },
        undefined,
        {
          labels: options.labels,
          platform: authority.buildkit.platform,
          tag: options.tag,
        },
      );
      if (terminal.Id !== built.Id)
        throw fixedError("integration.images.containment");
      authority.reconciliationReasons = Object.freeze({
        ...authority.reconciliationReasons,
        builtTag: "matched",
      });
      return;
    }
    const candidate = await inspectEngineObject({
      daemon,
      engine,
      name: options.tag,
      policy: reconciliationPolicy,
      type: "images",
    });
    authority.reconciliationReasons = Object.freeze({
      ...authority.reconciliationReasons,
      builtTag: candidate === undefined ? "absent" : "matched",
    });
    if (candidate !== undefined) {
      if (!authority.tagPreflightComplete)
        throw fixedError("integration.images.containment");
      await inspectBuiltTag(engine, daemon, reconciliationPolicy, undefined, {
        labels: options.labels,
        platform: authority.buildkit.platform,
        tag: options.tag,
      });
      await engineCall(
        { policy: reconciliationPolicy, signal: undefined, transport: engine },
        {
          expected: [200, 404],
          method: "DELETE",
          path: `/v${daemon.apiVersion}/images/${encodeURIComponent(options.tag)}?force=1&noprune=0`,
        },
      );
    }
    const late = await inspectEngineObject({
      daemon,
      engine,
      name: options.tag,
      policy: { ...policy, workDeadline: policy.deadline },
      type: "images",
    });
    if (late !== undefined) {
      authority.reconciliationReasons = Object.freeze({
        ...authority.reconciliationReasons,
        builtTag: "late-publication",
      });
      throw fixedError("integration.images.containment");
    }
  };
  const settleBuilderBuild = async (authority, options, built, failed) => {
    const { builder, client, daemon, engine, policy, run } = authority;
    try {
      const resources = builderResources(builder);
      const reconciliationPolicy = {
        ...policy,
        workDeadline: policy.reconciliationDeadline,
      };
      const currentDaemon = await inspectDaemon(
        engine,
        client.socket,
        reconciliationPolicy,
        undefined,
      );
      if (!sameDaemon(daemon, currentDaemon))
        throw fixedError("integration.images.containment");
      let [container, volume] = await inspectBuilderResources(
        authority,
        resources,
        undefined,
        reconciliationPolicy,
      );
      let identity;
      if (container !== undefined || volume !== undefined) {
        if (!authority.resourcePreflightComplete)
          throw fixedError("integration.images.containment");
        identity = authenticateBuilderResources(
          authority,
          resources,
          container,
          volume,
          false,
        );
        if (
          authority.resourceIdentity !== undefined &&
          (identity.container === undefined || identity.volume === undefined)
        )
          throw fixedError("integration.images.containment");
      }
      if (identity?.container !== undefined && identity.volume !== undefined) {
        await run(
          ["rm", "--force", builder],
          undefined,
          reconciliationPolicy.workDeadline,
        ).catch(() => undefined);
        [container, volume] = await inspectBuilderResources(
          authority,
          resources,
          undefined,
          reconciliationPolicy,
        );
        identity = authenticateBuilderResources(
          authority,
          resources,
          container,
          volume,
          false,
        );
      }
      if (identity?.container !== undefined || identity?.volume !== undefined)
        await removeBuilderResources({
          authority,
          identity,
          policy: reconciliationPolicy,
          resources,
        });
      await settleBuiltTag(
        authority,
        options,
        built,
        failed,
        reconciliationPolicy,
      );
      const finalDaemon = await inspectDaemon(
        engine,
        client.socket,
        { ...policy, workDeadline: policy.deadline },
        undefined,
      );
      if (!sameDaemon(daemon, finalDaemon))
        throw fixedError("integration.images.containment");
    } catch {
      throw fixedError("integration.images.containment");
    }
  };
  const unavailableProcessDiagnostic = (failure) =>
    Object.freeze({
      observed: false,
      exited: false,
      signaled: false,
      timedOut: failure?.code === "ETIMEDOUT",
      joined: false,
      outputBytes: 0,
      outputTruncated: false,
      stderrClass: "unknown",
    });
  const captureFirstBuildFailure = (authority, failure) => {
    if (authority.firstFailureDiagnostic !== undefined) return;
    authority.firstFailureDiagnostic = Object.freeze({
      operationKind: authority.currentOperationKind,
      process:
        readImageProcessDiagnostic(failure) ??
        (authority.lastProcessObservation?.operationKind ===
        authority.currentOperationKind
          ? authority.lastProcessObservation.process
          : undefined) ??
        unavailableProcessDiagnostic(failure),
    });
  };
  const recordPreparedDockerDiagnostic = (
    client,
    authority,
    labels,
    failure,
  ) => {
    if (state.hasDiagnostic(client)) return;
    const resources = builderResources(authority.builder);
    const observation = authority.lastResourceObservation ?? {
      responseBytes: 0,
      observedCount: 0,
      observedDigest: diagnosticDigest([]),
    };
    captureFirstBuildFailure(authority, failure);
    const firstFailure = authority.firstFailureDiagnostic;
    state.recordDiagnostic(
      client,
      Object.freeze({
        diagnosticVersion: 1,
        stage: "builder-reconciliation",
        operationKind: firstFailure.operationKind,
        identityDigests: Object.freeze({
          daemon: diagnosticDigest(authority.daemon),
          builder: diagnosticDigest(authority.builder),
          image: diagnosticDigest({
            image: authority.buildkit.image,
            configDigest: authority.buildkit.configDigest,
          }),
          platform: diagnosticDigest(authority.buildkit.platform),
          runGeneration: diagnosticDigest(
            labels["com.agentscope.integration.run"] ?? "unbound",
          ),
        }),
        process: Object.freeze({ ...firstFailure.process }),
        responseBytes: observation.responseBytes,
        responseTruncated: false,
        expectedResourceCount: 2,
        observedResourceCount: observation.observedCount,
        expectedResourceDigest: diagnosticDigest([
          resources.container,
          resources.volume,
        ]),
        observedResourceDigest: observation.observedDigest,
        reconciliationReasons: authority.reconciliationReasons,
        outcome: "retired-failure",
      }),
    );
  };

  const preparedDockerClientDiagnostic = (client) =>
    state.readDiagnostic(client);

  const buildPreparedDockerImage = async (
    client,
    {
      buildArguments,
      afterBuildContextEntryForTesting,
      context,
      dockerfile,
      labels,
      maximumMilliseconds,
      maximumBuildContextBytes,
      retirementRequired = false,
      signal,
      tag,
    },
  ) => {
    if (
      !state.clientIsUsable(client) ||
      typeof context !== "string" ||
      typeof dockerfile !== "string" ||
      !/^(?:[A-Za-z\d][A-Za-z\d._-]{0,127}\.Dockerfile|Dockerfile)$/u.test(
        dockerfile,
      ) ||
      typeof tag !== "string" ||
      !/^[a-z\d][a-z\d._/-]{0,127}:[a-z\d][a-z\d._-]{0,127}$/u.test(tag) ||
      !validBuildMap(buildArguments) ||
      !validBuildMap(labels) ||
      typeof retirementRequired !== "boolean" ||
      state.pendingCount(client) !== 0
    )
      throw fixedError("integration.images.build");
    const policy = preparationPolicy([client.evidence.images[0].image], {
      maximumPreparationMilliseconds: maximumMilliseconds,
      teardownMilliseconds: Math.min(
        preparationTeardownMilliseconds,
        Math.floor(maximumMilliseconds / 4),
      ),
    });
    const archive = createBoundedBuildContext(context, {
      afterEntryForTesting: afterBuildContextEntryForTesting,
      deadline: policy.workDeadline,
      maximumBytes: maximumBuildContextBytes ?? defaultMaximumBuildContextBytes,
      signal,
    });
    const authority = await createBuildAuthority(
      client,
      policy,
      signal,
      labels["com.agentscope.integration.run"],
    );
    let built;
    let failure;
    try {
      built = await executeBuilderBuild(
        authority,
        { buildArguments, dockerfile, labels, tag },
        archive,
      );
    } catch (error) {
      failure = error;
      captureFirstBuildFailure(authority, error);
    }
    if (
      failure?.containmentProved === false ||
      (authority.requestCapable === true &&
        (failure?.code === "ETIMEDOUT" ||
          [
            "integration.images.interrupted",
            "integration.images.output",
          ].includes(failure?.message)))
    ) {
      state.markUncertain(client);
      recordPreparedDockerDiagnostic(client, authority, labels, failure);
      throw failure;
    }
    try {
      await settleBuilderBuild(
        authority,
        { labels, tag },
        built,
        failure !== undefined,
      );
    } catch (error) {
      if (authority.requestCapable === true) {
        captureFirstBuildFailure(authority, error);
        state.markUncertain(client);
        recordPreparedDockerDiagnostic(client, authority, labels, error);
      }
      throw error;
    }
    if (failure !== undefined)
      throw [
        "integration.images.executable",
        "integration.images.interrupted",
        "integration.images.output",
        "integration.images.timeout",
      ].includes(failure?.message)
        ? failure
        : fixedError("integration.images.build", failure?.code === "ETIMEDOUT");
    const imageId = built.Id.replace(":", "-");
    if (retirementRequired) state.recordPendingImage(client, tag, imageId);
    return imageId;
  };

  return Object.freeze({
    assertSocketCurrentFor,
    buildPreparedDockerImage,
    createPreparedDockerClient,
    engineCall,
    engineTransport,
    imagePreparationFailureRequiresOuterHostRetirement,
    inspectDaemon,
    inspectEngineObject,
    prepareDockerInvocation,
    preparePinnedDockerImages,
    preparedDockerClientDiagnostic,
    revalidatePreparedImageAdmission,
  });
};
