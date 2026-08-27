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
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";
import { get as httpsGet, createServer as createHttpsServer } from "node:https";
import type { Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { PreparedDockerImageSet } from "../image-preparation.mjs";

import {
  buildPreparedDockerImage,
  closePreparedDockerClient,
  createBoundedBuildContext,
  createPreparedDockerClient,
  IMAGE_PREPARATION_LIMITS,
  prepareDockerInvocation,
  preparePinnedDockerImages,
  publishPreparedImageEvidence,
  probePinnedRegistryTlsForTesting,
  readPreparedImageEvidence,
  revalidatePreparedImageAdmission,
  retirePreparedImageEvidence,
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
  osType: "linux",
  architecture: "amd64",
});
const version = JSON.stringify({
  Version: daemon.serverVersion,
  ApiVersion: daemon.apiVersion,
});
const info = JSON.stringify({
  ID: daemon.id,
  OSType: daemon.osType,
  Architecture: daemon.architecture,
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

const engineFixture = ({
  buildFailure = false,
  buildTag,
  daemonSwitch = false,
  localValue = local,
  localInitiallyPresent = true,
  pullCompletesThenDisconnect = false,
  pullFailure = false,
}: {
  buildFailure?: boolean;
  buildTag?: string;
  daemonSwitch?: boolean;
  localValue?: string;
  localInitiallyPresent?: boolean;
  pullCompletesThenDisconnect?: boolean;
  pullFailure?: boolean;
} = {}) => {
  const requests: Request[] = [];
  let infoCount = 0;
  let pulled = localInitiallyPresent;
  const request = async (entry: Request): Promise<Response> => {
    await Promise.resolve();
    requests.push(entry);
    if (entry.signal?.aborted)
      throw new Error("integration.images.interrupted");
    if (entry.path === "/version") return { statusCode: 200, body: version };
    if (entry.path === "/v1.50/info") {
      infoCount += 1;
      return {
        statusCode: 200,
        body:
          daemonSwitch && infoCount > 1
            ? JSON.stringify({
                ID: "other-daemon",
                OSType: "linux",
                Architecture: "amd64",
              })
            : info,
      };
    }
    if (entry.path.startsWith("/v1.50/build?"))
      return buildFailure
        ? { statusCode: 200, body: '{"error":"fixture build failed"}\n' }
        : { statusCode: 200, body: '{"stream":"fixture build complete"}\n' };
    if (
      buildTag !== undefined &&
      entry.path === `/v1.50/images/${encodeURIComponent(buildTag)}/json`
    )
      return {
        statusCode: 200,
        body: JSON.stringify({ Id: configDigest, RepoTags: [buildTag] }),
      };
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
  return { request, requests };
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

  it("derives the fixed Desktop socket fallback from OS-owned identity", () => {
    const prior = process.env.HOME;
    process.env.HOME = "/private/tmp/agentscope-home-canary";
    try {
      expect(userInfo().homedir).not.toBe(process.env.HOME);
    } finally {
      if (prior === undefined) delete process.env.HOME;
      else process.env.HOME = prior;
    }
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
      `/v1.50/images/create?fromImage=fixture&tag=${encodeURIComponent(image.split("@")[1]!)}`,
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
  });

  it("reconciles only on a later attempt after a completed pull response is lost", async () => {
    const engine = engineFixture({
      localInitiallyPresent: false,
      pullCompletesThenDisconnect: true,
    });
    await expect(
      preparePinnedDockerImages([image], options(engine)),
    ).rejects.toThrow("integration.images.daemon-uncertain");
    await expect(
      preparePinnedDockerImages([image], options(engine)),
    ).resolves.toMatchObject({ images: [{ image, configDigest }] });
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
});

describe("prepared Docker client terminal authority", () => {
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

describe("authenticated Engine build consumption", () => {
  const buildContext = () => {
    const directory = root();
    writeFileSync(resolve(directory, "Dockerfile"), "FROM scratch\n");
    mkdirSync(resolve(directory, "nested"));
    writeFileSync(resolve(directory, "nested/input.txt"), "fixture\n");
    return directory;
  };
  const buildTag = "agentscope-int-fixture:candidate";

  it("sends one bounded deterministic context and verifies the built tag", async () => {
    const context = buildContext();
    expect(createBoundedBuildContext(context)).toEqual(
      createBoundedBuildContext(context),
    );
    const engine = engineFixture({ buildTag });
    const client = createPreparedDockerClient(
      validatePreparedImageEvidence(prepared(), manifestIdentity),
      {
        dockerExecutableForTesting: process.execPath,
        socketIdentityForTesting: socket,
        engineRequestForTesting: engine.request,
      },
    );
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
      const request = engine.requests.find(({ path }) =>
        path.startsWith("/v1.50/build?"),
      );
      expect(request).toMatchObject({
        method: "POST",
        headers: {
          "Content-Type": "application/x-tar",
        },
      });
      expect(request?.body).toBeInstanceOf(Buffer);
      expect(request?.body?.subarray(-1024).equals(Buffer.alloc(1024))).toBe(
        true,
      );
      expect(request?.body?.byteLength).toBeLessThanOrEqual(64 * 1024 * 1024);
    } finally {
      closePreparedDockerClient(client);
    }
  });

  it.each([
    { buildFailure: true, daemonSwitch: false },
    { buildFailure: false, daemonSwitch: true },
  ])(
    "fails uncertain on malformed result or daemon substitution %#",
    async (fixtureOptions) => {
      const engine = engineFixture({ buildTag, ...fixtureOptions });
      const client = createPreparedDockerClient(
        validatePreparedImageEvidence(prepared(), manifestIdentity),
        {
          dockerExecutableForTesting: process.execPath,
          socketIdentityForTesting: socket,
          engineRequestForTesting: engine.request,
        },
      );
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
        ).rejects.toThrow("integration.images.build-uncertain");
      } finally {
        closePreparedDockerClient(client);
      }
    },
  );
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
