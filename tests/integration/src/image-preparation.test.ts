import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createServer } from "node:http";
import { get as httpsGet, createServer as createHttpsServer } from "node:https";
import type { Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { PreparedDockerImageSet } from "../image-preparation.mjs";

import {
  assertImagePreparationPlatformForTesting,
  BUILDKIT_IMAGE,
  buildPreparedDockerImage,
  closePreparedDockerClient,
  createBoundedBuildContext,
  createPreparedDockerClient,
  IMAGE_PREPARATION_LIMITS,
  IMAGE_PREPARATION_EXECUTION_POLICY,
  imagePreparationFailureRequiresOuterHostRetirement,
  markPreparedDockerClientForOuterHostRetirement,
  prepareDockerInvocation,
  preparedDockerClientRequiresOuterHostRetirement,
  preparePinnedDockerImages,
  publishPreparedImageEvidence,
  probePinnedRegistryTlsForTesting,
  readPreparedImageEvidence,
  revalidatePreparedImageAdmission,
  retirePreparedImageEvidence,
  runOwnedImageCommandForTesting,
  validatePreparedImageEvidence,
} from "../image-preparation.mjs";

const derLength = (length: number) => {
  if (length < 128) return Buffer.from([length]);
  const bytes = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8)
    bytes.unshift(remaining & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const der = (tag: number, ...values: Buffer[]) => {
  const value = Buffer.concat(values);
  return Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
};
const signatureAlgorithm = der(
  0x30,
  der(0x06, Buffer.from("2a864886f70d01010b", "hex")),
  der(0x05),
);
const certificateName = der(
  0x30,
  der(
    0x31,
    der(
      0x30,
      der(0x06, Buffer.from("550403", "hex")),
      der(0x0c, Buffer.from("127.0.0.1")),
    ),
  ),
);
const certificateExtensions = der(
  0xa3,
  der(
    0x30,
    der(
      0x30,
      der(0x06, Buffer.from("551d13", "hex")),
      der(0x01, Buffer.from([0xff])),
      der(0x04, der(0x30)),
    ),
    der(
      0x30,
      der(0x06, Buffer.from("551d0f", "hex")),
      der(0x01, Buffer.from([0xff])),
      der(0x04, der(0x03, Buffer.from([5, 0xa0]))),
    ),
    der(
      0x30,
      der(0x06, Buffer.from("551d25", "hex")),
      der(
        0x04,
        der(0x30, der(0x06, Buffer.from("2b06010505070301", "hex"))),
      ),
    ),
    der(
      0x30,
      der(0x06, Buffer.from("551d11", "hex")),
      der(0x04, der(0x30, der(0x87, Buffer.from([127, 0, 0, 1])))),
    ),
  ),
);
const pem = (label: string, value: Buffer) => {
  const body = value.toString("base64").match(/.{1,64}/gu)?.join("\n");
  if (body === undefined) throw new Error("fixture PEM encoding failed");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
};
const createSelfSignedTlsFixture = () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const subjectPublicKey = publicKey.export({ format: "der", type: "spki" });
  const validity = der(
    0x30,
    der(0x17, Buffer.from("200101000000Z")),
    der(0x17, Buffer.from("491231235959Z")),
  );
  const certificateBody = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    signatureAlgorithm,
    certificateName,
    validity,
    certificateName,
    subjectPublicKey,
    certificateExtensions,
  );
  const signature = sign("sha256", certificateBody, privateKey);
  return {
    key: privateKey.export({ format: "pem", type: "pkcs8" }),
    certificate: pem(
      "CERTIFICATE",
      der(
        0x30,
        certificateBody,
        signatureAlgorithm,
        der(0x03, Buffer.from([0]), signature),
      ),
    ),
  };
};
const selfSignedTls = createSelfSignedTlsFixture();
const requestTrustedSelfSignedFixture = async (port: number) => {
  const signal = AbortSignal.timeout(5_000);
  let request: ReturnType<typeof httpsGet> | undefined;
  try {
    await new Promise<void>((resolveRequest, rejectRequest) => {
      request = httpsGet(
        {
          ca: selfSignedTls.certificate,
          hostname: "127.0.0.1",
          path: "/",
          port,
          rejectUnauthorized: true,
          signal,
        },
        (response) => {
          response.resume();
          response.once("end", () => {
            if (response.statusCode === 200) resolveRequest();
            else rejectRequest(new Error("fixture TLS response failed"));
          });
        },
      );
      request.once("error", rejectRequest);
    });
  } finally {
    request?.destroy();
  }
};

const sha256 = (value: Buffer | string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const configBlob = Buffer.from(
  JSON.stringify({ architecture: "amd64", os: "linux", rootfs: {} }),
);
const configDigest = sha256(configBlob);
const selectedManifest = Buffer.from(
  JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: configDigest,
      size: configBlob.byteLength,
    },
    layers: [],
  }),
);
const selectedManifestDigest = sha256(selectedManifest);
const imageIndex = Buffer.from(
  JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: selectedManifestDigest,
        size: selectedManifest.byteLength,
        platform: { os: "linux", architecture: "amd64" },
      },
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: `sha256:${"c".repeat(64)}`,
        size: 321,
        platform: { os: "linux", architecture: "arm64", variant: "v8" },
      },
    ],
  }),
);
const image = `fixture@${sha256(imageIndex)}`;
const manifestIdentity = `sha256-${"f".repeat(64)}`;
const socket = Object.freeze({
  path: "/var/run/docker.sock",
  device: "1",
  inode: "2",
  mode: "49663",
  owner: "0",
});
const daemon = Object.freeze({
  endpoint: socket.path,
  socketDevice: socket.device,
  socketInode: socket.inode,
  id: "fixture-daemon",
  serverVersion: "fixture-server",
  apiVersion: "1.50",
  product: "Docker Engine - Community",
  operatingSystem: "Ubuntu 24.04 LTS",
  osType: "linux",
  architecture: "amd64",
});
const version = JSON.stringify({
  Version: daemon.serverVersion,
  ApiVersion: daemon.apiVersion,
  Platform: { Name: daemon.product },
});
const local = JSON.stringify({
  Id: configDigest,
  Os: "linux",
  Architecture: "amd64",
  Variant: "",
  RepoDigests: [image],
});
const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(resolve(tmpdir(), "agentscope-image-test-"));
  roots.push(value);
  return value;
};

type Request = {
  body?: Buffer;
  method: string;
  origin?: URL;
  path: string;
  headers: Record<string, string>;
  maximumBytes: number;
  signal?: AbortSignal;
};
type Response = {
  statusCode: number;
  headers?: Record<string, string>;
  body: Buffer | string;
};
const builderInspection = (
  name: string,
  {
    createdAt,
    mismatched = false,
    wrongMount = false,
  }: {
    createdAt: string;
    mismatched?: boolean;
    wrongMount?: boolean;
  },
) => ({
  statusCode: 200,
  body: JSON.stringify({
    Id: "c".repeat(64),
    Created: createdAt,
    Name: `/${name}`,
    Image: mismatched ? `sha256:${"f".repeat(64)}` : configDigest,
    Config: {
      Image: image,
    },
    State: { Running: true },
    Platform: "linux",
    HostConfig: { NetworkMode: "default" },
    NetworkSettings: { Networks: { bridge: {} } },
    Mounts: [
      {
        Type: "volume",
        Name: wrongMount ? "shared-state" : `${name}_state`,
        Destination: "/var/lib/buildkit",
        RW: true,
      },
    ],
  }),
});
const runFixtureBuildx = async (
  state: {
    buildFailure: boolean;
    builderContainer: string | undefined;
    builderVolume: string | undefined;
    built: boolean;
    calls: Array<{ arguments_: readonly string[]; input?: Buffer }>;
    cleanupLeak: boolean;
    createFailureCollision: boolean;
    createTimeoutAfterResources: boolean;
    unprovedContainment: boolean;
  },
  arguments_: readonly string[],
  options: { input?: Buffer },
) => {
  await Promise.resolve();
  state.calls.push({
    arguments_,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  const command = arguments_[0];
  if (command === "create") {
    const builder = arguments_[arguments_.indexOf("--name") + 1];
    if (builder === undefined) throw new Error("missing builder name");
    state.builderContainer = `buildx_buildkit_${builder}0`;
    state.builderVolume = `${state.builderContainer}_state`;
    if (state.unprovedContainment) {
      const error = new Error("integration.images.containment");
      Object.assign(error, { code: "ETIMEDOUT", containmentProved: false });
      throw error;
    }
    if (state.createFailureCollision)
      throw new Error("integration.images.command");
    if (state.createTimeoutAfterResources) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 310));
      const error = new Error("integration.images.timeout");
      Object.assign(error, { code: "ETIMEDOUT" });
      throw error;
    }
    return builder;
  }
  if (command === "inspect") return "fixture builder\n";
  if (command === "build") {
    if (state.buildFailure) throw new Error("integration.images.command");
    state.built = true;
    return "fixture build complete\n";
  }
  if (command === "rm") {
    if (state.createTimeoutAfterResources) {
      const error = new Error("integration.images.timeout");
      Object.assign(error, { code: "ETIMEDOUT" });
      throw error;
    }
    state.builderContainer = undefined;
    if (!state.cleanupLeak) state.builderVolume = undefined;
    return "";
  }
  throw new Error("unexpected buildx command");
};

// The simulated daemon keeps one coherent mutable lifecycle across all endpoints.
const engineFixture = ({
  builderMismatch = false,
  buildFailure = false,
  buildTag,
  cleanupLeak = false,
  createdAt = new Date().toISOString(),
  createFailureCollision = false,
  createTimeoutAfterResources = false,
  daemonArchitecture = daemon.architecture,
  daemonSwitch = false,
  dockerDesktop = false,
  lateTagAfterDelete = false,
  localValue = local,
  localInitiallyPresent = true,
  preexistingVolume = false,
  preexistingTag = false,
  pullCompletesThenDisconnect = false,
  pullFailure = false,
  substituteAfterBuild = false,
  unprovedContainment = false,
  wrongMount = false,
  wrongVolume = false,
  wrongVolumeLabels = false,
}: {
  builderMismatch?: boolean;
  buildFailure?: boolean;
  buildTag?: string;
  cleanupLeak?: boolean;
  createdAt?: string;
  createFailureCollision?: boolean;
  createTimeoutAfterResources?: boolean;
  daemonArchitecture?: string;
  daemonSwitch?: boolean;
  dockerDesktop?: boolean;
  lateTagAfterDelete?: boolean;
  localValue?: string;
  localInitiallyPresent?: boolean;
  preexistingVolume?: boolean;
  preexistingTag?: boolean;
  pullCompletesThenDisconnect?: boolean;
  pullFailure?: boolean;
  substituteAfterBuild?: boolean;
  unprovedContainment?: boolean;
  wrongMount?: boolean;
  wrongVolume?: boolean;
  wrongVolumeLabels?: boolean;
  // eslint-disable-next-line max-lines-per-function
} = {}) => {
  const requests: Request[] = [];
  let infoCount = 0;
  let pulled = localInitiallyPresent;
  const fixtureCreatedAt = createdAt;
  const state: {
    buildFailure: boolean;
    builderContainer: string | undefined;
    builderVolume: string | undefined;
    built: boolean;
    calls: Array<{ arguments_: readonly string[]; input?: Buffer }>;
    cleanupLeak: boolean;
    createFailureCollision: boolean;
    createTimeoutAfterResources: boolean;
    imageDeleted: boolean;
    tagInspectionCount: number;
    unprovedContainment: boolean;
  } = {
    buildFailure,
    builderContainer: undefined,
    builderVolume: undefined,
    built: false,
    calls: [],
    cleanupLeak,
    createFailureCollision,
    createTimeoutAfterResources,
    imageDeleted: false,
    tagInspectionCount: 0,
    unprovedContainment,
  };
  // One stateful endpoint matrix intentionally models cross-request races.
  // eslint-disable-next-line complexity, max-lines-per-function -- one stateful daemon lifecycle fixture
  const request = async (entry: Request): Promise<Response> => {
    await Promise.resolve();
    requests.push(entry);
    if (entry.signal?.aborted)
      throw new Error("integration.images.interrupted");
    if (entry.path === "/version")
      return {
        statusCode: 200,
        body: dockerDesktop
          ? JSON.stringify({
              Version: daemon.serverVersion,
              ApiVersion: daemon.apiVersion,
              Platform: { Name: "Docker Desktop" },
            })
          : version,
      };
    if (entry.path === "/v1.50/info") {
      infoCount += 1;
      return {
        statusCode: 200,
        body:
          daemonSwitch && infoCount > 1
            ? JSON.stringify({
                ID: "other-daemon",
                OperatingSystem: daemon.operatingSystem,
                OSType: "linux",
                Architecture: daemonArchitecture,
              })
            : dockerDesktop
              ? JSON.stringify({
                  ID: daemon.id,
                  OperatingSystem: "Docker Desktop",
                  OSType: daemon.osType,
                  Architecture: daemonArchitecture,
                })
              : JSON.stringify({
                  ID: daemon.id,
                  OperatingSystem: daemon.operatingSystem,
                  OSType: daemon.osType,
                  Architecture: daemonArchitecture,
                }),
      };
    }
    if (
      state.builderContainer !== undefined &&
      entry.path ===
        `/v1.50/containers/${encodeURIComponent(state.builderContainer)}/json`
    )
      return builderInspection(state.builderContainer, {
        createdAt: fixtureCreatedAt,
        mismatched: builderMismatch || (state.built && substituteAfterBuild),
        wrongMount,
      });
    if (
      preexistingVolume &&
      state.builderVolume === undefined &&
      entry.method === "GET" &&
      entry.path.includes("/volumes/buildx_buildkit_agentscope-")
    )
      return {
        statusCode: 200,
        body: JSON.stringify({
          Name: decodeURIComponent(entry.path.split("/volumes/")[1]!),
          Driver: "local",
          Scope: "local",
          Labels: null,
          CreatedAt: fixtureCreatedAt,
          Mountpoint: `/var/lib/docker/volumes/${state.builderVolume}/_data`,
        }),
      };
    if (
      state.builderVolume !== undefined &&
      entry.path === `/v1.50/volumes/${encodeURIComponent(state.builderVolume)}`
    )
      return {
        statusCode: 200,
        body: JSON.stringify({
          Name: state.builderVolume,
          Driver: wrongVolume ? "shared" : "local",
          Scope: "local",
          Labels: wrongVolumeLabels ? { foreign: "true" } : null,
          CreatedAt: fixtureCreatedAt,
          Mountpoint: `/var/lib/docker/volumes/${state.builderVolume}/_data`,
        }),
      };
    if (
      buildTag !== undefined &&
      entry.path === `/v1.50/images/${encodeURIComponent(buildTag)}/json`
    ) {
      state.tagInspectionCount += 1;
      if (lateTagAfterDelete && state.tagInspectionCount >= 3)
        state.built = true;
      return state.built || preexistingTag
        ? {
            statusCode: 200,
            body: JSON.stringify({
              Id: configDigest,
              Created: preexistingTag
                ? "2000-01-01T00:00:00.000Z"
                : fixtureCreatedAt,
              RepoTags: [buildTag],
              Config: {
                Labels: { "com.agentscope.integration": "true" },
              },
              Os: "linux",
              Architecture: "amd64",
              Variant: "",
            }),
          }
        : { statusCode: 404, body: "{}" };
    }
    if (entry.method === "DELETE") {
      if (entry.path.includes("/containers/"))
        state.builderContainer = undefined;
      if (entry.path.includes("/volumes/") && !cleanupLeak)
        state.builderVolume = undefined;
      if (entry.path.includes("/images/")) {
        state.built = false;
        state.imageDeleted = true;
        return { statusCode: 200, body: "[]" };
      }
      return { statusCode: 204, body: "" };
    }
    if (
      entry.method === "GET" &&
      (entry.path.includes("/containers/") || entry.path.includes("/volumes/"))
    )
      return { statusCode: 404, body: "{}" };
    if (entry.method === "POST") {
      if (pullCompletesThenDisconnect) {
        pulled = true;
        throw new Error("response lost after daemon completion");
      }
      if (pullFailure) throw new Error("transport disconnected");
      pulled = true;
      return { statusCode: 200, body: '{"status":"pulled"}\n' };
    }
    if (entry.path.includes("/images/"))
      return pulled
        ? { statusCode: 200, body: localValue }
        : { statusCode: 404, body: "{}" };
    throw new Error(`unexpected engine path ${entry.path}`);
  };
  return {
    buildxCalls: state.calls,
    buildxRun: (
      arguments_: readonly string[],
      runOptions: { input?: Buffer },
    ) => runFixtureBuildx(state, arguments_, runOptions),
    request,
    requests,
  };
};

const registryFixture = ({
  config = configBlob,
  redirectConfig = false,
  rootManifest = imageIndex,
  selected = selectedManifest,
}: {
  config?: Buffer;
  redirectConfig?: boolean;
  rootManifest?: Buffer;
  selected?: Buffer;
} = {}) => {
  const requests: Request[] = [];
  const request = async (entry: Request): Promise<Response> => {
    await Promise.resolve();
    requests.push(entry);
    expect(entry.origin?.protocol).toBe("https:");
    expect(entry.origin?.hostname).toMatch(
      /^(?:(?:registry-1|auth)\.docker\.io|production\.(?:cloudflare|cloudfront)\.docker\.com)$/u,
    );
    if (entry.origin?.hostname === "production.cloudfront.docker.com")
      return {
        statusCode: 200,
        headers: { "content-type": "application/octet-stream" },
        body: config,
      };
    if (entry.origin?.hostname === "auth.docker.io")
      return { statusCode: 200, body: '{"token":"fixture-token"}' };
    if (entry.headers.Authorization === undefined)
      return {
        statusCode: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/fixture:pull"',
        },
        body: "",
      };
    if (entry.path.endsWith(`/manifests/${image.split("@")[1]}`))
      return {
        statusCode: 200,
        headers: {
          "content-type": "application/vnd.oci.image.index.v1+json",
          "docker-content-digest": sha256(rootManifest),
        },
        body: rootManifest,
      };
    if (entry.path.endsWith(`/manifests/${selectedManifestDigest}`))
      return {
        statusCode: 200,
        headers: {
          "content-type": "application/vnd.oci.image.manifest.v1+json",
          "docker-content-digest": sha256(selected),
        },
        body: selected,
      };
    if (entry.path.endsWith(`/blobs/${configDigest}`))
      if (redirectConfig)
        return {
          statusCode: 307,
          headers: {
            location:
              "https://production.cloudfront.docker.com/registry-v2/docker/registry/v2/blobs/config?sig=fixed",
          },
          body: "",
        };
      else
        return {
          statusCode: 200,
          headers: {
            "content-type": "application/octet-stream",
            "docker-content-digest": sha256(config),
          },
          body: config,
        };
    throw new Error(`unexpected registry path ${entry.path}`);
  };
  return { request, requests };
};

const options = (engine = engineFixture(), registry = registryFixture()) => ({
  socketIdentityForTesting: socket,
  engineRequestForTesting: engine.request,
  registryRequestForTesting: registry.request,
  maximumPreparationMilliseconds: 4_000,
  teardownMilliseconds: 500,
});
const prepared = () => ({
  imageEvidenceVersion: 2,
  manifestIdentity,
  dockerSocket: socket,
  dockerDaemon: daemon,
  preparationPolicy: {
    maximumPreparationMilliseconds: 4_000,
    teardownMilliseconds: 500,
    maximumResponseBytes: 1_048_576,
    maximumManifestBytes: 1_048_576,
    maximumEvidenceBytes: 8_388_608,
  },
  terminalCleanup: {
    daemon: "stable",
    handles: "settled",
    privateState: "absent",
  },
  images: [
    {
      image,
      platform: { os: "linux", architecture: "amd64" },
      manifestDigest: selectedManifestDigest,
      configDigest,
      rootManifest: imageIndex.toString("base64"),
      selectedManifest: selectedManifest.toString("base64"),
      configBlob: configBlob.toString("base64"),
    },
  ],
});

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { force: true, recursive: true });
});

describe("subprocess-free pinned image preparation", () => {
  it("uses only the authenticated Engine socket and fixed HTTPS origins", async () => {
    const engine = engineFixture();
    const registry = registryFixture();
    const before = new Set(
      readdirSync(realpathSync("/tmp")).filter((entry) =>
        entry.startsWith("agentscope-image-preparation-"),
      ),
    );
    const prior = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://CANARY.invalid";
    try {
      await expect(
        preparePinnedDockerImages([image], options(engine, registry)),
      ).resolves.toEqual({
        dockerSocket: socket,
        dockerDaemon: daemon,
        preparationPolicy: prepared().preparationPolicy,
        terminalCleanup: prepared().terminalCleanup,
        images: prepared().images,
      });
    } finally {
      if (prior === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = prior;
    }
    expect(engine.requests.every(({ origin }) => origin === undefined)).toBe(
      true,
    );
    expect(
      registry.requests.every(
        ({ origin }) => origin?.hostname !== "CANARY.invalid",
      ),
    ).toBe(true);
    expect(
      new Set(
        readdirSync(realpathSync("/tmp")).filter((entry) =>
          entry.startsWith("agentscope-image-preparation-"),
        ),
      ),
    ).toEqual(before);
  });

  it("admits only the closed disposable-Linux host defaults", () => {
    expect(IMAGE_PREPARATION_EXECUTION_POLICY).toEqual({
      platform: { os: "linux", architecture: "amd64", variant: "" },
      socket: "/var/run/docker.sock",
      dockerExecutables: ["/usr/bin/docker"],
      buildxExecutables: [
        "/usr/lib/docker/cli-plugins/docker-buildx",
        "/usr/libexec/docker/cli-plugins/docker-buildx",
      ],
    });
    expect(JSON.stringify(IMAGE_PREPARATION_EXECUTION_POLICY)).not.toMatch(
      /Docker\.app|homebrew|\/usr\/local|\.docker\/run/u,
    );
    expect(() => {
      assertImagePreparationPlatformForTesting("linux");
    }).not.toThrow();
    expect(() => {
      assertImagePreparationPlatformForTesting("darwin");
    }).toThrow("integration.images.platform");
  });

  it("rejects Docker Desktop even when it presents the Linux socket shape", async () => {
    await expect(
      preparePinnedDockerImages(
        [image],
        options(engineFixture({ dockerDesktop: true })),
      ),
    ).rejects.toThrow("integration.images.daemon");
  });

  it("rejects a self-signed registry despite ambient TLS disablement", async () => {
    let handledRequests = 0;
    const server = createHttpsServer(
      { key: selfSignedTls.key, cert: selfSignedTls.certificate },
      (_request, response) => {
        handledRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}\n");
      },
    );
    const prior = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        const failed = (error: Error) => {
          rejectListen(error);
        };
        server.once("error", failed);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", failed);
          resolveListen();
        });
      });
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("fixture TLS address unavailable");
      await expect(
        requestTrustedSelfSignedFixture(address.port),
      ).resolves.toBeUndefined();
      expect(handledRequests).toBe(1);
      handledRequests = 0;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      await expect(
        probePinnedRegistryTlsForTesting(
          new URL(`https://127.0.0.1:${address.port}`),
        ),
      ).rejects.toThrow();
      expect(handledRequests).toBe(0);
    } finally {
      if (prior === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prior;
      await new Promise<void>((resolveClose) => {
        if (!server.listening) resolveClose();
        else
          server.close(() => {
            resolveClose();
          });
      });
    }
  });
});

describe("Engine image reconciliation", () => {
  it("reconciles an exact existing digest without issuing a pull", async () => {
    const engine = engineFixture({ localInitiallyPresent: true });
    await preparePinnedDockerImages([image], options(engine));
    expect(engine.requests.some(({ method }) => method === "POST")).toBe(false);
  });

  it("pulls only after exact inspection proves the digest absent", async () => {
    const engine = engineFixture({ localInitiallyPresent: false });
    await preparePinnedDockerImages([image], options(engine));
    expect(
      engine.requests.filter(({ method }) => method === "POST"),
    ).toHaveLength(1);
    expect(engine.requests.find(({ method }) => method === "POST")?.path).toBe(
      `/v1.50/images/create?fromImage=fixture&tag=${encodeURIComponent(image.split("@")[1]!)}&platform=linux%2Famd64`,
    );
  });

  it("selects and pulls the canonical platform instead of the daemon architecture", async () => {
    const engine = engineFixture({
      daemonArchitecture: "arm64",
      localInitiallyPresent: false,
    });
    await expect(
      preparePinnedDockerImages([image], options(engine)),
    ).resolves.toMatchObject({
      dockerDaemon: { architecture: "arm64" },
      images: [{ platform: { os: "linux", architecture: "amd64" } }],
    });
    expect(engine.requests.find(({ method }) => method === "POST")?.path).toBe(
      `/v1.50/images/create?fromImage=fixture&tag=${encodeURIComponent(image.split("@")[1]!)}&platform=linux%2Famd64`,
    );
  });

  it("permits one credential-free config redirect to the closed CDN origin", async () => {
    const registry = registryFixture({ redirectConfig: true });
    await expect(
      preparePinnedDockerImages([image], options(engineFixture(), registry)),
    ).resolves.toMatchObject({ images: [{ configDigest }] });
    expect(
      registry.requests.some(
        ({ origin }) => origin?.hostname === "production.cloudfront.docker.com",
      ),
    ).toBe(true);
  });

  it("fails outcome-unknown after a disconnected pull and never adopts in-run", async () => {
    const engine = engineFixture({
      localInitiallyPresent: false,
      pullFailure: true,
    });
    await expect(
      preparePinnedDockerImages([image], options(engine)),
    ).rejects.toThrow("integration.images.daemon-uncertain");
    expect(
      engine.requests.filter(
        ({ method, path }) => method === "GET" && path.includes("/images/"),
      ),
    ).toHaveLength(2);
    expect(
      imagePreparationFailureRequiresOuterHostRetirement(
        new Error("integration.images.daemon-uncertain"),
      ),
    ).toBe(true);
    expect(
      imagePreparationFailureRequiresOuterHostRetirement(
        new Error("integration.images.timeout"),
      ),
    ).toBe(false);
  });

  it("never adopts a completed pull whose response was lost", async () => {
    const engine = engineFixture({
      localInitiallyPresent: false,
      pullCompletesThenDisconnect: true,
    });
    await expect(
      preparePinnedDockerImages([image], options(engine)),
    ).rejects.toThrow("integration.images.daemon-uncertain");
    expect(
      engine.requests.filter(({ method }) => method === "POST"),
    ).toHaveLength(1);
  });

  it("rejects daemon replacement before evidence can return", async () => {
    await expect(
      preparePinnedDockerImages(
        [image],
        options(engineFixture({ daemonSwitch: true })),
      ),
    ).rejects.toThrow("integration.images.daemon");
  });
});

describe("bounded image preparation request and cleanup handles", () => {
  it("bounds response bodies before parsing them", async () => {
    const registry = registryFixture();
    registry.request = () =>
      Promise.resolve({
        statusCode: 200,
        body: Buffer.alloc(IMAGE_PREPARATION_LIMITS.maximumManifestBytes + 1),
      });
    await expect(
      preparePinnedDockerImages([image], options(engineFixture(), registry)),
    ).rejects.toThrow("integration.images.output");
  });

  it("rolls back a deterministic post-mkdtemp setup failure", async () => {
    let ownedRoot: string | undefined;
    await expect(
      preparePinnedDockerImages([image], {
        ...options(),
        afterPrivateRootCreatedForTesting: (value: string) => {
          ownedRoot = value;
          throw new Error("injected setup failure");
        },
      }),
    ).rejects.toThrow("integration.images.setup");
    expect(existsSync(ownedRoot ?? "")).toBe(false);
  });

  it("settles a nonresponding Engine socket before timeout rejection", async () => {
    const directory = root();
    const socketPath = resolve(directory, "engine.sock");
    const connections = new Set<Socket>();
    const server = createServer(() => {
      // Deliberately never send headers or a body.
    });
    server.on("connection", (connection) => {
      connections.add(connection);
      connection.once("close", () => connections.delete(connection));
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, resolveListen);
    });
    try {
      await expect(
        preparePinnedDockerImages([image], {
          dockerSocketForTesting: socketPath,
          registryRequestForTesting: registryFixture().request,
          maximumPreparationMilliseconds: 500,
          teardownMilliseconds: 100,
        }),
      ).rejects.toMatchObject({
        code: "ETIMEDOUT",
        message: "integration.images.timeout",
      });
      expect(connections.size).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
      });
    }
  });

  it("fails closed and preserves a partial-cleanup root", async () => {
    let ownedRoot: string | undefined;
    await expect(
      preparePinnedDockerImages([image], {
        ...options(),
        beforePrivateCleanupForTesting: (value: string) => {
          ownedRoot = value;
          mkdirSync(resolve(value, "unexpected"));
        },
      }),
    ).rejects.toThrow("integration.images.cleanup");
    expect(existsSync(ownedRoot ?? "")).toBe(true);
    if (ownedRoot !== undefined)
      rmSync(ownedRoot, { force: true, recursive: true });
  });
});

describe("self-authenticating v2 image evidence", () => {
  it("accepts the exact pinned root, selected manifest, and config bytes", () => {
    expect(validatePreparedImageEvidence(prepared(), manifestIdentity)).toEqual(
      prepared(),
    );
  });

  it.each([
    { imageEvidenceVersion: 1 },
    { dockerSocket: { ...socket, inode: "3" } },
    { dockerDaemon: { ...daemon, id: "" } },
    {
      images: [
        {
          ...prepared().images[0],
          manifestDigest: `sha256:${"b".repeat(64)}`,
        },
      ],
    },
    {
      images: [
        {
          ...prepared().images[0],
          configBlob: Buffer.from("substituted").toString("base64"),
        },
      ],
    },
    {
      images: [
        {
          ...prepared().images[0],
          rootManifest: Buffer.from("{}").toString("base64"),
        },
      ],
    },
  ])("rejects caller-claimed or substituted authority %#", (replacement) => {
    expect(() =>
      validatePreparedImageEvidence(
        { ...prepared(), ...replacement },
        manifestIdentity,
      ),
    ).toThrow("integration.images.evidence");
  });

  it("refuses to publish an unbranded caller-constructed record", () => {
    const directory = root();
    expect(() => {
      publishPreparedImageEvidence(
        resolve(directory, "current-images.json"),
        manifestIdentity,
        prepared() as unknown as PreparedDockerImageSet,
      );
    }).toThrow("integration.images.publication");
  });

  it("bounds the persisted envelope before JSON proof decoding", () => {
    const directory = root();
    const target = resolve(directory, "current-images.json");
    writeFileSync(target, JSON.stringify(prepared()));
    expect(readPreparedImageEvidence(target, manifestIdentity)).toEqual(
      prepared(),
    );
    writeFileSync(
      target,
      JSON.stringify({
        ...prepared(),
        surplus: "A".repeat(IMAGE_PREPARATION_LIMITS.maximumEvidenceBytes),
      }),
    );
    expect(() => readPreparedImageEvidence(target, manifestIdentity)).toThrow(
      "integration.images.evidence",
    );
  });
});

describe("prepared image runtime admission and publication", () => {
  it("fences every consuming Docker call to one executable and daemon", async () => {
    const admitted = validatePreparedImageEvidence(
      prepared(),
      manifestIdentity,
    );
    const engine = engineFixture();
    const prior = {
      PATH: process.env.PATH,
      DOCKER_HOST: process.env.DOCKER_HOST,
      DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
      DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    };
    Object.assign(process.env, {
      PATH: "/private/tmp/CANARY",
      DOCKER_HOST: "tcp://CANARY.invalid:2375",
      DOCKER_CONTEXT: "CANARY",
      DOCKER_CONFIG: "/private/tmp/CANARY-config",
    });
    const client = createPreparedDockerClient(admitted, {
      dockerExecutableForTesting: process.execPath,
      socketIdentityForTesting: socket,
      engineRequestForTesting: engine.request,
    });
    let configDirectory: string | undefined;
    try {
      const invocation = await prepareDockerInvocation(
        client,
        ["image", "inspect", image],
        new AbortController().signal,
      );
      configDirectory = invocation.arguments[3];
      expect(invocation).toEqual({
        executable: realpathSync(process.execPath),
        arguments: [
          "--host",
          `unix://${socket.path}`,
          "--config",
          configDirectory,
          "image",
          "inspect",
          image,
        ],
        environment: {},
      });
      expect(
        readFileSync(resolve(configDirectory!, "config.json"), "utf8"),
      ).toBe('{"auths":{}}\n');
      expect(
        engine.requests.filter(({ path }) => path === "/version"),
      ).toHaveLength(2);
    } finally {
      closePreparedDockerClient(client);
      for (const [name, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(existsSync(configDirectory ?? "")).toBe(false);
  });

  it("rejects a consuming invocation after daemon identity changes", async () => {
    const admitted = validatePreparedImageEvidence(
      prepared(),
      manifestIdentity,
    );
    const client = createPreparedDockerClient(admitted, {
      dockerExecutableForTesting: process.execPath,
      socketIdentityForTesting: socket,
      engineRequestForTesting: engineFixture({ daemonSwitch: true }).request,
    });
    try {
      await expect(
        prepareDockerInvocation(client, ["version"]),
      ).rejects.toThrow("integration.images.docker-client");
    } finally {
      closePreparedDockerClient(client);
    }
  });

  it("uses only the controller-supplied closed Docker environment", async () => {
    const admitted = validatePreparedImageEvidence(
      prepared(),
      manifestIdentity,
    );
    const dockerEnvironment = {
      DOCKER_HOST: "unix:///var/run/docker.sock",
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    };
    const client = createPreparedDockerClient(admitted, {
      dockerEnvironment,
      dockerExecutableForTesting: process.execPath,
      socketIdentityForTesting: socket,
      engineRequestForTesting: engineFixture().request,
    });
    try {
      await expect(
        prepareDockerInvocation(client, ["version"]),
      ).resolves.toMatchObject({ environment: dockerEnvironment });
    } finally {
      closePreparedDockerClient(client);
    }
    expect(() =>
      createPreparedDockerClient(admitted, {
        dockerEnvironment: { ...dockerEnvironment, HTTP_PROXY: "CANARY" },
        dockerExecutableForTesting: process.execPath,
        socketIdentityForTesting: socket,
        engineRequestForTesting: engineFixture().request,
      }),
    ).toThrow("integration.images.docker-client");
  });
});

describe("prepared Docker client terminal authority", () => {
  it("fences every later invocation after a mutation requires host retirement", async () => {
    const client = createPreparedDockerClient(
      validatePreparedImageEvidence(prepared(), manifestIdentity),
      {
        dockerExecutableForTesting: process.execPath,
        socketIdentityForTesting: socket,
        engineRequestForTesting: engineFixture().request,
      },
    );
    const privateRoot = (
      client as unknown as { privateClient: { root: string } }
    ).privateClient.root;
    markPreparedDockerClientForOuterHostRetirement(client);
    expect(preparedDockerClientRequiresOuterHostRetirement(client)).toBe(true);
    await expect(prepareDockerInvocation(client, ["version"])).rejects.toThrow(
      "integration.images.docker-client",
    );
    expect(() => {
      closePreparedDockerClient(client);
    }).toThrow("integration.images.docker-client");
    rmSync(privateRoot, { force: true, recursive: true });
  });

  it("rejects executable replacement adjacent to consuming invocation", async () => {
    const directory = root();
    const executable = resolve(directory, "docker-fixture");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);
    const engine = engineFixture();
    let infoCount = 0;
    const client = createPreparedDockerClient(
      validatePreparedImageEvidence(prepared(), manifestIdentity),
      {
        dockerExecutableForTesting: executable,
        socketIdentityForTesting: socket,
        engineRequestForTesting: async (request) => {
          const response = await engine.request(request);
          if (request.path === "/v1.50/info") {
            infoCount += 1;
            if (infoCount === 2)
              writeFileSync(executable, "#!/bin/sh\nexit 99\n");
          }
          return response;
        },
      },
    );
    try {
      await expect(
        prepareDockerInvocation(client, ["version"]),
      ).rejects.toThrow("integration.images.docker-client");
    } finally {
      closePreparedDockerClient(client);
    }
  });

  it("keeps cleanup authority when a shared prepared image is absent", async () => {
    const admitted = validatePreparedImageEvidence(
      prepared(),
      manifestIdentity,
    );
    const client = createPreparedDockerClient(admitted, {
      dockerExecutableForTesting: process.execPath,
      socketIdentityForTesting: socket,
      engineRequestForTesting: engineFixture({
        localInitiallyPresent: false,
      }).request,
    });
    const invocation = await prepareDockerInvocation(client, ["rm", "owned"]);
    const privateRoot = dirname(invocation.arguments[3]!);
    mkdirSync(resolve(privateRoot, "unexpected"));
    expect(() => {
      closePreparedDockerClient(client);
    }).toThrow("integration.images.cleanup");
    rmSync(resolve(privateRoot, "unexpected"), { recursive: true });
    expect(() => {
      closePreparedDockerClient(client);
    }).not.toThrow();
    expect(existsSync(privateRoot)).toBe(false);
  });
});

const buildContext = () => {
  const directory = root();
  writeFileSync(resolve(directory, "Dockerfile"), "FROM scratch\n");
  mkdirSync(resolve(directory, "nested"));
  writeFileSync(resolve(directory, "nested/input.txt"), "fixture\n");
  return directory;
};
const buildTag = "agentscope-int-fixture:candidate";
const buildClient = (engine: ReturnType<typeof engineFixture>) =>
  createPreparedDockerClient(
    validatePreparedImageEvidence(prepared(), manifestIdentity),
    {
      buildkitImageForTesting: image,
      buildxExecutableForTesting: process.execPath,
      buildxRunForTesting: engine.buildxRun,
      dockerExecutableForTesting: process.execPath,
      socketIdentityForTesting: socket,
      engineRequestForTesting: engine.request,
    },
  );

describe("bounded build-context acquisition", () => {
  it("rejects symlink and pre-read size authority violations", () => {
    const context = buildContext();
    const links = root();
    const rootLink = resolve(links, "context-link");
    symlinkSync(context, rootLink);
    expect(() => createBoundedBuildContext(rootLink)).toThrow(
      "integration.images.build",
    );
    symlinkSync(resolve(context, "nested"), resolve(context, "nested-link"));
    expect(() => createBoundedBuildContext(context)).toThrow(
      "integration.images.build",
    );
    rmSync(resolve(context, "nested-link"));
    writeFileSync(resolve(context, "oversized"), "");
    truncateSync(resolve(context, "oversized"), 64 * 1024 * 1024 + 1);
    expect(() => createBoundedBuildContext(context)).toThrow(
      "integration.images.build",
    );
  });

  it("rejects same-inode mutation during context acquisition", () => {
    const context = buildContext();
    expect(() =>
      createBoundedBuildContext(context, {
        afterEntryForTesting: (entryCount) => {
          if (entryCount === 1)
            writeFileSync(resolve(context, "Dockerfile"), "FROM invalid\n");
        },
      }),
    ).toThrow("integration.images.build");
  });
});

describe("owned buildx process execution", () => {
  const fixture = resolve(
    import.meta.dirname,
    "../fixtures/image-preparation-process.mjs",
  );

  it.each([
    ["hang-descendant", "integration.images.timeout"],
    ["close-descendant", "integration.images.containment"],
  ])("kills and joins the exact process group for %s", async (mode, code) => {
    const directory = root();
    const error = await runOwnedImageCommandForTesting(
      process.execPath,
      [fixture],
      {
        deadline: performance.now() + 500,
        environment: {
          AGENTSCOPE_IMAGE_FIXTURE_MODE: mode,
          AGENTSCOPE_IMAGE_FIXTURE_ROOT: directory,
        },
        teardownMilliseconds: 250,
      },
    ).catch((failure: unknown) => failure);
    if (mode === "hang-descendant") {
      expect(error).toMatchObject({ code: "ETIMEDOUT" });
      expect([
        "integration.images.timeout",
        "integration.images.containment",
      ]).toContain((error as Error).message);
    } else expect(error).toEqual(expect.objectContaining({ message: code }));
    const descendant = Number(
      readFileSync(resolve(directory, "ready"), "utf8"),
    );
    expect(() => process.kill(descendant, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });

  it("fails closed when close observation exhausts the teardown reserve", async () => {
    const directory = root();
    let processGroup: number | undefined;
    const error = await runOwnedImageCommandForTesting(
      process.execPath,
      [fixture],
      {
        closeBarrierForTesting: (ownedProcessGroup) => {
          processGroup = ownedProcessGroup;
          return new Promise(() => {});
        },
        deadline: performance.now() + 500,
        environment: {
          AGENTSCOPE_IMAGE_FIXTURE_MODE: "hang-descendant",
          AGENTSCOPE_IMAGE_FIXTURE_ROOT: directory,
        },
        teardownMilliseconds: 250,
      },
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: "ETIMEDOUT",
      message: "integration.images.containment",
    });
    expect(processGroup).toEqual(expect.any(Number));
    expect(() => process.kill(-processGroup!, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
    const descendant = Number(
      readFileSync(resolve(directory, "ready"), "utf8"),
    );
    expect(() => process.kill(descendant, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });
});

// These cases share the exact builder fixture and exercise one lifecycle matrix.
// eslint-disable-next-line max-lines-per-function
describe("authenticated buildx consumption", () => {
  it("rejects buildx executable replacement before the first invocation", async () => {
    const executable = resolve(root(), "buildx");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const engine = engineFixture({ buildTag });
    const client = createPreparedDockerClient(
      validatePreparedImageEvidence(prepared(), manifestIdentity),
      {
        buildkitImageForTesting: image,
        buildxExecutableForTesting: executable,
        buildxRunForTesting: engine.buildxRun,
        dockerExecutableForTesting: process.execPath,
        socketIdentityForTesting: socket,
        engineRequestForTesting: engine.request,
      },
    );
    unlinkSync(executable);
    writeFileSync(executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    try {
      await expect(
        buildPreparedDockerImage(client, {
          buildArguments: { BASE_IMAGE: image },
          context: buildContext(),
          dockerfile: "Dockerfile",
          labels: { "com.agentscope.integration": "true" },
          maximumMilliseconds: 4_000,
          tag: buildTag,
        }),
      ).rejects.toThrow("integration.images.executable");
      expect(engine.buildxCalls).toEqual([]);
    } finally {
      closePreparedDockerClient(client);
    }
  });

  it("sends one bounded deterministic context and verifies the built tag", async () => {
    const context = buildContext();
    expect(createBoundedBuildContext(context)).toEqual(
      createBoundedBuildContext(context),
    );
    const engine = engineFixture({ buildTag });
    const client = buildClient(engine);
    try {
      await expect(
        buildPreparedDockerImage(client, {
          buildArguments: { BASE_IMAGE: image },
          context,
          dockerfile: "Dockerfile",
          labels: { "com.agentscope.integration": "true" },
          maximumMilliseconds: 4_000,
          tag: buildTag,
        }),
      ).resolves.toBe(configDigest.replace(":", "-"));
      expect(engine.requests.some(({ path }) => path.includes("/build?"))).toBe(
        false,
      );
      const create = engine.buildxCalls.find(
        ({ arguments_ }) => arguments_[0] === "create",
      );
      expect(create?.arguments_).toContain("docker-container");
      expect(create?.arguments_).not.toContain(BUILDKIT_IMAGE);
      const build = engine.buildxCalls.find(
        ({ arguments_ }) => arguments_[0] === "build",
      );
      expect(build?.arguments_).toContain("--platform");
      expect(build?.arguments_).toContain("linux/amd64");
      expect(build?.input?.subarray(-1024).equals(Buffer.alloc(1024))).toBe(
        true,
      );
      expect(build?.input?.byteLength).toBeLessThanOrEqual(64 * 1024 * 1024);
    } finally {
      closePreparedDockerClient(client);
    }
  });

  it.each(["2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z"])(
    "does not treat the daemon clock %s as controller authority",
    async (createdAt) => {
      const engine = engineFixture({ buildTag, createdAt });
      const client = buildClient(engine);
      try {
        await expect(
          buildPreparedDockerImage(client, {
            buildArguments: { BASE_IMAGE: image },
            context: buildContext(),
            dockerfile: "Dockerfile",
            labels: { "com.agentscope.integration": "true" },
            maximumMilliseconds: 4_000,
            tag: buildTag,
          }),
        ).resolves.toBe(configDigest.replace(":", "-"));
      } finally {
        closePreparedDockerClient(client);
      }
    },
  );

  it.each([
    {
      buildFailure: true,
      daemonSwitch: false,
      expected: "integration.images.build",
      noDestructiveCleanup: false,
    },
    {
      buildFailure: false,
      daemonSwitch: true,
      expected: "integration.images.containment",
      expectRetirement: true,
      noDestructiveCleanup: true,
    },
    {
      builderMismatch: true,
      buildFailure: false,
      daemonSwitch: false,
      expected: "integration.images.containment",
      expectRetirement: true,
      noDestructiveCleanup: true,
    },
    {
      buildFailure: false,
      cleanupLeak: true,
      daemonSwitch: false,
      expected: "integration.images.containment",
      expectRetirement: true,
      noDestructiveCleanup: false,
    },
    {
      buildFailure: true,
      daemonSwitch: false,
      expected: "integration.images.containment",
      expectRetirement: true,
      lateTagAfterDelete: true,
      noDestructiveCleanup: false,
    },
    {
      buildFailure: false,
      daemonSwitch: false,
      expected: "integration.images.containment",
      expectRetirement: true,
      noDestructiveCleanup: true,
      wrongMount: true,
    },
    {
      buildFailure: false,
      daemonSwitch: false,
      expected: "integration.images.containment",
      expectRetirement: true,
      noDestructiveCleanup: true,
      wrongVolume: true,
    },
    {
      buildFailure: false,
      daemonSwitch: false,
      expected: "integration.images.containment",
      expectRetirement: true,
      noDestructiveCleanup: true,
      wrongVolumeLabels: true,
    },
    {
      buildFailure: false,
      createFailureCollision: true,
      daemonSwitch: false,
      expected: "integration.images.containment",
      expectRetirement: true,
      noDestructiveCleanup: true,
      wrongVolume: true,
    },
    {
      buildFailure: false,
      daemonSwitch: false,
      expected: "integration.images.containment",
      noDestructiveCleanup: true,
      preexistingVolume: true,
    },
    {
      buildFailure: false,
      daemonSwitch: false,
      expected: "integration.images.containment",
      expectRetirement: true,
      noDestructiveCleanup: true,
      substituteAfterBuild: true,
    },
    {
      buildFailure: false,
      daemonSwitch: false,
      expected: "integration.images.containment",
      noDestructiveCleanup: true,
      preexistingTag: true,
    },
    {
      buildFailure: false,
      createTimeoutAfterResources: true,
      daemonSwitch: false,
      expected: "integration.images.timeout",
      expectRetirement: true,
      maximumMilliseconds: 400,
      noDestructiveCleanup: true,
    },
  ])(
    "joins its dedicated builder on command failure or daemon substitution %#",
    async ({
      expected,
      expectRetirement = false,
      maximumMilliseconds = 4_000,
      noDestructiveCleanup,
      ...fixtureOptions
    }) => {
      const engine = engineFixture({ buildTag, ...fixtureOptions });
      const client = buildClient(engine);
      const privateRoot = (
        client as unknown as { privateClient: { root: string } }
      ).privateClient.root;
      try {
        await expect(
          buildPreparedDockerImage(client, {
            buildArguments: { BASE_IMAGE: image },
            context: buildContext(),
            dockerfile: "Dockerfile",
            labels: { "com.agentscope.integration": "true" },
            maximumMilliseconds,
            tag: buildTag,
          }),
        ).rejects.toThrow(expected);
        if (noDestructiveCleanup) {
          expect(
            engine.requests.filter(({ method }) => method === "DELETE"),
          ).toEqual([]);
          expect(
            engine.buildxCalls.some(({ arguments_ }) => arguments_[0] === "rm"),
          ).toBe(false);
        }
      } finally {
        if (expectRetirement) {
          expect(preparedDockerClientRequiresOuterHostRetirement(client)).toBe(
            true,
          );
          expect(() => {
            closePreparedDockerClient(client);
          }).toThrow("integration.images.docker-client");
          rmSync(privateRoot, { force: true, recursive: true });
        } else {
          closePreparedDockerClient(client);
        }
      }
    },
  );

  it("fences the client and private state when process-set absence is unproved", async () => {
    const engine = engineFixture({ buildTag, unprovedContainment: true });
    const client = buildClient(engine);
    const privateRoot = (
      client as unknown as { privateClient: { root: string } }
    ).privateClient.root;
    await expect(
      buildPreparedDockerImage(client, {
        buildArguments: { BASE_IMAGE: image },
        context: buildContext(),
        dockerfile: "Dockerfile",
        labels: { "com.agentscope.integration": "true" },
        maximumMilliseconds: 4_000,
        tag: buildTag,
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      containmentProved: false,
      message: "integration.images.containment",
    });
    expect(engine.requests.filter(({ method }) => method === "DELETE")).toEqual(
      [],
    );
    expect(
      engine.buildxCalls.some(({ arguments_ }) => arguments_[0] === "rm"),
    ).toBe(false);
    expect(() => {
      closePreparedDockerClient(client);
    }).toThrow("integration.images.docker-client");
    expect(existsSync(privateRoot)).toBe(true);
    rmSync(privateRoot, { force: true, recursive: true });
  });

  it("expires during context acquisition before any Engine request", async () => {
    const engine = engineFixture({ buildTag });
    const client = buildClient(engine);
    try {
      await expect(
        buildPreparedDockerImage(client, {
          afterBuildContextEntryForTesting: () => {
            const releaseAt = performance.now() + 10;
            while (performance.now() < releaseAt) {
              // Deterministically expire the one build deadline mid-packing.
            }
          },
          buildArguments: { BASE_IMAGE: image },
          context: buildContext(),
          dockerfile: "Dockerfile",
          labels: { "com.agentscope.integration": "true" },
          maximumMilliseconds: 4,
          tag: buildTag,
        }),
      ).rejects.toMatchObject({
        code: "ETIMEDOUT",
        message: "integration.images.timeout",
      });
      expect(engine.requests).toEqual([]);
    } finally {
      closePreparedDockerClient(client);
    }
  });
});

describe("prepared image admission and publication", () => {
  it("recomputes proof and daemon/config identity at runtime admission", async () => {
    const admitted = validatePreparedImageEvidence(
      prepared(),
      manifestIdentity,
    );
    const engine = engineFixture();
    await expect(
      revalidatePreparedImageAdmission(admitted, image, {
        socketIdentityForTesting: socket,
        engineRequestForTesting: engine.request,
      }),
    ).resolves.toBe(true);
    await expect(
      revalidatePreparedImageAdmission(admitted, image, {
        socketIdentityForTesting: socket,
        engineRequestForTesting: engineFixture({
          localValue: JSON.stringify({
            ...JSON.parse(local),
            Id: `sha256:${"e".repeat(64)}`,
          }),
        }).request,
      }),
    ).resolves.toBe(false);
  });

  it("fails admission after exact socket or daemon rebinding", async () => {
    const admitted = validatePreparedImageEvidence(
      prepared(),
      manifestIdentity,
    );
    await expect(
      revalidatePreparedImageAdmission(admitted, image, {
        socketIdentityForTesting: { ...socket, inode: "999" },
        engineRequestForTesting: engineFixture().request,
      }),
    ).resolves.toBe(false);
    await expect(
      revalidatePreparedImageAdmission(admitted, image, {
        socketIdentityForTesting: socket,
        engineRequestForTesting: engineFixture({ daemonSwitch: true }).request,
      }),
    ).resolves.toBe(false);
  });

  it("removes failed publication staging and preserves the target", async () => {
    const directory = root();
    const target = resolve(directory, "current-images.json");
    mkdirSync(target);
    const trusted = await preparePinnedDockerImages([image], options());
    expect(() => {
      publishPreparedImageEvidence(target, manifestIdentity, trusted);
    }).toThrow("integration.images.publication");
    expect(readdirSync(directory)).toEqual(["current-images.json"]);
    expect(readdirSync(target)).toEqual([]);
  });

  it("bounds the exact persisted encoding before replacing prior evidence", async () => {
    const directory = root();
    const target = resolve(directory, "current-images.json");
    writeFileSync(target, "prior-authority\n");
    const trusted = await preparePinnedDockerImages([image], options());
    const evidence = {
      imageEvidenceVersion: 2,
      manifestIdentity,
      ...trusted,
    };
    const compactBytes = Buffer.byteLength(JSON.stringify(evidence), "utf8");
    const persistedBytes = Buffer.byteLength(
      `${JSON.stringify(evidence, undefined, 2)}\n`,
      "utf8",
    );
    expect(persistedBytes).toBeGreaterThan(compactBytes);
    expect(() => {
      publishPreparedImageEvidence(target, manifestIdentity, trusted, {
        maximumEvidenceBytesForTesting: compactBytes,
      });
    }).toThrow("integration.images.publication");
    expect(readFileSync(target, "utf8")).toBe("prior-authority\n");
    publishPreparedImageEvidence(target, manifestIdentity, trusted);
    expect(readPreparedImageEvidence(target, manifestIdentity)).toEqual(
      evidence,
    );
    expect(readFileSync(target).byteLength).toBe(persistedBytes);
  });

  it("retires stale authority before later preparation work can fail", async () => {
    const directory = root();
    const target = resolve(directory, "current-images.json");
    rmSync(target, { force: true });
    // A missing pointer is already fail-closed and is idempotent.
    retirePreparedImageEvidence(target);
    const trusted = await preparePinnedDockerImages([image], options());
    publishPreparedImageEvidence(target, manifestIdentity, trusted);
    expect(JSON.parse(readFileSync(target, "utf8"))).toMatchObject({
      imageEvidenceVersion: 2,
    });
    retirePreparedImageEvidence(target);
    expect(existsSync(target)).toBe(false);
    retirePreparedImageEvidence(target);
  });

  it("publishes the fixed request and manifest ceilings", () => {
    expect(IMAGE_PREPARATION_LIMITS).toEqual({
      maximumPreparationMilliseconds: 300_000,
      maximumTeardownMilliseconds: 5_000,
      maximumResponseBytes: 1_048_576,
      maximumManifestBytes: 1_048_576,
      maximumEvidenceBytes: 8_388_608,
    });
  });
});
