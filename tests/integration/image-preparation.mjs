import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { userInfo } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { rootCertificates } from "node:tls";

const maximumPreparationMilliseconds = 300_000;
const preparationTeardownMilliseconds = 5_000;
const maximumResponseBytes = 1_048_576;
const maximumManifestBytes = 1_048_576;
const maximumEvidenceBytes = 8_388_608;
const maximumTokenBytes = 16_384;
const maximumHeaderBytes = 16_384;
const maximumBuildContextBytes = 64 * 1024 * 1024;
const maximumBuildOutputBytes = 16 * 1024 * 1024;
const digestPattern = /^sha256:[a-f\d]{64}$/u;
const imagePattern = /^[^\s@]{1,448}@sha256:[a-f\d]{64}$/u;
const manifestIdentityPattern = /^sha256-[a-f\d]{64}$/u;
const platformValuePattern = /^[a-z\d][a-z\d._-]{0,63}$/u;
const apiVersionPattern = /^\d{1,3}\.\d{1,3}$/u;
const indexMediaTypes = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const manifestMediaTypes = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const configMediaTypes = new Set([
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
]);
const manifestAccept = [...indexMediaTypes, ...manifestMediaTypes].join(", ");
const dockerSocketCandidates = Object.freeze([
  "/var/run/docker.sock",
  resolve(userInfo().homedir, ".docker/run/docker.sock"),
]);
const dockerExecutableCandidates = Object.freeze([
  "/usr/bin/docker",
  "/usr/local/bin/docker",
  "/opt/homebrew/bin/docker",
  "/Applications/Docker.app/Contents/Resources/bin/docker",
]);
const preparedSets = new WeakSet();
const preparedDockerClients = new WeakSet();
const closingPreparedDockerClients = new WeakSet();

const fixedError = (code, timedOut = false) => {
  const error = new Error(code);
  if (timedOut) error.code = "ETIMEDOUT";
  return error;
};
const boundedText = (value, maximum = 256) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  /^[\x20-\x7e]+$/u.test(value);
const exactKeys = (value, keys) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());
const digestBytes = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const jsonRecord = (value, code) => {
  try {
    const parsed =
      Buffer.isBuffer(value) || typeof value === "string"
        ? JSON.parse(value.toString("utf8"))
        : value;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error(code);
    return parsed;
  } catch {
    throw fixedError(code);
  }
};

const canonicalArchitecture = (rawArchitecture, rawVariant) => {
  let architecture = rawArchitecture.toLowerCase();
  let variant = rawVariant?.toLowerCase() ?? "";
  const aliases = new Map([
    ["aarch64", "arm64"],
    ["x86_64", "amd64"],
    ["x86-64", "amd64"],
    ["i386", "386"],
  ]);
  architecture = aliases.get(architecture) ?? architecture;
  if (architecture === "armhf") {
    architecture = "arm";
    variant ||= "v7";
  } else if (architecture === "armel") {
    architecture = "arm";
    variant ||= "v6";
  }
  if (
    (architecture === "arm" || architecture === "arm64") &&
    /^\d/u.test(variant)
  )
    variant = `v${variant}`;
  const commonVariant =
    (architecture === "arm" && variant === "v7") ||
    (architecture === "arm64" && variant === "v8") ||
    (architecture === "amd64" && variant === "v1");
  return Object.freeze({ architecture, variant: commonVariant ? "" : variant });
};
const normalizePlatform = (value) => {
  const { os, architecture, variant } = value ?? {};
  if (
    typeof os !== "string" ||
    typeof architecture !== "string" ||
    !platformValuePattern.test(os.toLowerCase()) ||
    !platformValuePattern.test(architecture.toLowerCase()) ||
    !(
      variant === undefined ||
      variant === "" ||
      (typeof variant === "string" &&
        platformValuePattern.test(variant.toLowerCase()))
    )
  )
    throw fixedError("integration.images.platform-identity");
  const normalizedOs =
    os.toLowerCase() === "macos" ? "darwin" : os.toLowerCase();
  const canonical = canonicalArchitecture(architecture, variant);
  return Object.freeze({
    os: normalizedOs,
    architecture: canonical.architecture,
    ...(canonical.variant === "" ? {} : { variant: canonical.variant }),
  });
};
const samePlatform = (left, right) =>
  left.os === right.os &&
  left.architecture === right.architecture &&
  (left.variant ?? "") === (right.variant ?? "");

const socketRecord = (path) => {
  if (typeof path !== "string" || !isAbsolute(path))
    throw fixedError("integration.images.socket");
  try {
    const canonicalPath = realpathSync(path);
    const link = lstatSync(canonicalPath);
    const status = statSync(canonicalPath, { bigint: true });
    accessSync(canonicalPath, constants.R_OK | constants.W_OK);
    if (!link.isSocket() || !status.isSocket())
      throw fixedError("integration.images.socket");
    return Object.freeze({
      path: canonicalPath,
      device: String(status.dev),
      inode: String(status.ino),
      mode: String(status.mode),
      owner: String(status.uid),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "integration.images.socket")
      throw error;
    throw fixedError("integration.images.socket");
  }
};
const sameSocket = (left, right) =>
  left.path === right.path &&
  left.device === right.device &&
  left.inode === right.inode &&
  left.mode === right.mode &&
  left.owner === right.owner;
const executableRecord = (path) => {
  if (typeof path !== "string" || !isAbsolute(path))
    throw fixedError("integration.images.executable");
  try {
    const canonicalPath = realpathSync(path);
    const status = statSync(canonicalPath, { bigint: true });
    accessSync(canonicalPath, constants.X_OK);
    const currentUser = process.getuid?.();
    if (
      !status.isFile() ||
      (status.mode & 0o22n) !== 0n ||
      !(
        status.uid === 0n ||
        (currentUser !== undefined && status.uid === BigInt(currentUser))
      )
    )
      throw fixedError("integration.images.executable");
    return Object.freeze({
      path: canonicalPath,
      device: String(status.dev),
      inode: String(status.ino),
      mode: String(status.mode),
      owner: String(status.uid),
      size: String(status.size),
      ctimeNanoseconds: String(status.ctimeNs),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "integration.images.executable"
    )
      throw error;
    throw fixedError("integration.images.executable");
  }
};
const sameExecutable = (left, right) =>
  left.path === right.path &&
  left.device === right.device &&
  left.inode === right.inode &&
  left.mode === right.mode &&
  left.owner === right.owner &&
  left.size === right.size &&
  left.ctimeNanoseconds === right.ctimeNanoseconds;
const resolveDockerExecutable = (requested) => {
  if (requested !== undefined) return executableRecord(requested);
  for (const candidate of dockerExecutableCandidates) {
    try {
      return executableRecord(candidate);
    } catch {
      // The fixed absolute executable list is authoritative.
    }
  }
  throw fixedError("integration.images.executable");
};
const resolveDockerSocket = (requested) => {
  if (requested !== undefined) return socketRecord(requested);
  for (const candidate of dockerSocketCandidates) {
    try {
      return socketRecord(candidate);
    } catch {
      // The closed physical socket list is authoritative.
    }
  }
  throw fixedError("integration.images.socket");
};
const assertSocketCurrent = (identity) => {
  if (!sameSocket(identity, socketRecord(identity.path)))
    throw fixedError("integration.images.socket");
};
const validSocketEvidence = (value) =>
  exactKeys(value, ["device", "inode", "mode", "owner", "path"]) &&
  isAbsolute(value.path ?? "") &&
  boundedText(value.path, 1024) &&
  ["device", "inode", "mode", "owner"].every((key) =>
    /^\d{1,32}$/u.test(value[key] ?? ""),
  );

const normalizedHeaders = (headers) =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(headers ?? {}).map(([name, value]) => [
        name.toLowerCase(),
        Array.isArray(value) ? value.join(", ") : String(value ?? ""),
      ]),
    ),
  );
const boundedRequest = ({
  body,
  deadline,
  headers,
  method,
  origin,
  path,
  signal,
  socketPath,
  maximumBytes,
}) =>
  new Promise((resolveRequest, rejectRequest) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) {
      rejectRequest(fixedError("integration.images.timeout", true));
      return;
    }
    let settled = false;
    let responseEnded = false;
    let responseValue;
    let request;
    let terminalError;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolveRequest(value);
      else rejectRequest(error);
    };
    const fail = (code, timedOut = false) => {
      terminalError ??= fixedError(code, timedOut);
      request?.destroy();
      if (request === undefined) finish(terminalError);
    };
    const onAbort = () => fail("integration.images.interrupted");
    const timer = setTimeout(
      () => fail("integration.images.timeout", true),
      Math.max(1, remaining),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    const requestOptions = {
      agent: false,
      headers,
      maxHeaderSize: maximumHeaderBytes,
      method,
      path,
      ...(socketPath === undefined
        ? {
            ca: rootCertificates,
            hostname: origin.hostname,
            port: origin.port || 443,
            protocol: "https:",
            rejectUnauthorized: true,
            servername: origin.hostname,
          }
        : { socketPath }),
    };
    const factory = socketPath === undefined ? httpsRequest : httpRequest;
    request = factory(requestOptions, (response) => {
      let bytes = 0;
      const chunks = [];
      response.on("data", (chunk) => {
        bytes += chunk.byteLength;
        if (bytes > maximumBytes) {
          chunks.length = 0;
          fail("integration.images.output");
        } else chunks.push(chunk);
      });
      response.once("error", () => fail("integration.images.transport"));
      response.once("end", () => {
        responseEnded = true;
        responseValue = Object.freeze({
          body: Buffer.concat(chunks),
          headers: normalizedHeaders(response.headers),
          statusCode: response.statusCode ?? 0,
        });
      });
    });
    request.once("error", () => fail("integration.images.transport"));
    request.once("close", () => {
      if (terminalError !== undefined) finish(terminalError);
      else if (!responseEnded)
        finish(fixedError("integration.images.transport"));
      else finish(undefined, responseValue);
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
const responseRecord = (value) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isSafeInteger(value.statusCode) ||
    value.statusCode < 100 ||
    value.statusCode > 599 ||
    !(Buffer.isBuffer(value.body) || typeof value.body === "string")
  )
    throw fixedError("integration.images.transport");
  const body = Buffer.isBuffer(value.body)
    ? Buffer.from(value.body)
    : Buffer.from(value.body, "utf8");
  return Object.freeze({
    statusCode: value.statusCode,
    headers: normalizedHeaders(value.headers),
    body,
  });
};
const requestWith = async (transport, request) => {
  const response = responseRecord(await transport(request));
  if (response.body.byteLength > request.maximumBytes)
    throw fixedError("integration.images.output");
  return response;
};

const daemonIdentity = (socket, versionValue, infoValue) => {
  const version = jsonRecord(versionValue, "integration.images.daemon");
  const info = jsonRecord(infoValue, "integration.images.daemon");
  const identity = {
    endpoint: socket.path,
    socketDevice: socket.device,
    socketInode: socket.inode,
    id: info.ID,
    serverVersion: version.Version,
    apiVersion: version.ApiVersion,
    osType: info.OSType,
    architecture: info.Architecture,
  };
  if (
    !boundedText(identity.endpoint, 1024) ||
    !boundedText(identity.id, 128) ||
    !boundedText(identity.serverVersion, 64) ||
    !apiVersionPattern.test(identity.apiVersion ?? "") ||
    !platformValuePattern.test(identity.osType ?? "") ||
    !platformValuePattern.test(identity.architecture ?? "")
  )
    throw fixedError("integration.images.daemon");
  return Object.freeze(identity);
};
const sameDaemon = (left, right) =>
  left.endpoint === right.endpoint &&
  left.socketDevice === right.socketDevice &&
  left.socketInode === right.socketInode &&
  left.id === right.id &&
  left.serverVersion === right.serverVersion &&
  left.apiVersion === right.apiVersion &&
  left.osType === right.osType &&
  left.architecture === right.architecture;
const validEvidenceDaemon = (value) =>
  exactKeys(value, [
    "apiVersion",
    "architecture",
    "endpoint",
    "id",
    "osType",
    "serverVersion",
    "socketDevice",
    "socketInode",
  ]) &&
  isAbsolute(value.endpoint ?? "") &&
  boundedText(value.endpoint, 1024) &&
  /^\d{1,32}$/u.test(value.socketDevice ?? "") &&
  /^\d{1,32}$/u.test(value.socketInode ?? "") &&
  boundedText(value.id, 128) &&
  boundedText(value.serverVersion, 64) &&
  apiVersionPattern.test(value.apiVersion ?? "") &&
  platformValuePattern.test(value.osType ?? "") &&
  platformValuePattern.test(value.architecture ?? "");
const validPreparationPolicy = (value) =>
  exactKeys(value, [
    "maximumManifestBytes",
    "maximumEvidenceBytes",
    "maximumPreparationMilliseconds",
    "maximumResponseBytes",
    "teardownMilliseconds",
  ]) &&
  Number.isSafeInteger(value.maximumPreparationMilliseconds) &&
  value.maximumPreparationMilliseconds >= 4 &&
  value.maximumPreparationMilliseconds <= maximumPreparationMilliseconds &&
  Number.isSafeInteger(value.teardownMilliseconds) &&
  value.teardownMilliseconds >= 1 &&
  value.teardownMilliseconds <= preparationTeardownMilliseconds &&
  value.maximumPreparationMilliseconds > value.teardownMilliseconds * 3 &&
  value.maximumResponseBytes === maximumResponseBytes &&
  value.maximumManifestBytes === maximumManifestBytes &&
  value.maximumEvidenceBytes === maximumEvidenceBytes;
const validTerminalCleanup = (value) =>
  exactKeys(value, ["daemon", "handles", "privateState"]) &&
  value.daemon === "stable" &&
  value.handles === "settled" &&
  value.privateState === "absent";

const descriptor = (value) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !digestPattern.test(value.digest ?? "") ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    !boundedText(value.mediaType, 128)
  )
    throw fixedError("integration.images.manifest");
  return value;
};
const parseManifest = (raw) => {
  const value = jsonRecord(raw, "integration.images.manifest");
  if (
    value.schemaVersion !== 2 ||
    !manifestMediaTypes.has(value.mediaType) ||
    !Array.isArray(value.layers)
  )
    throw fixedError("integration.images.manifest");
  const config = descriptor(value.config);
  if (!configMediaTypes.has(config.mediaType))
    throw fixedError("integration.images.manifest");
  return Object.freeze({ value, config });
};
const decodeProof = (encoded) => {
  if (
    typeof encoded !== "string" ||
    encoded.length === 0 ||
    encoded.length > Math.ceil(maximumManifestBytes / 3) * 4 ||
    !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(
      encoded,
    )
  )
    throw fixedError("integration.images.evidence");
  const raw = Buffer.from(encoded, "base64");
  if (
    raw.byteLength < 1 ||
    raw.byteLength > maximumManifestBytes ||
    raw.toString("base64") !== encoded
  )
    throw fixedError("integration.images.evidence");
  return raw;
};
const deriveManifestProof = ({
  configRaw,
  image,
  platform,
  rootRaw,
  selectedRaw,
}) => {
  if (!imagePattern.test(image))
    throw fixedError("integration.images.manifest");
  const normalizedPlatform = normalizePlatform(platform);
  const rootDigest = image.slice(image.lastIndexOf("@") + 1);
  if (digestBytes(rootRaw) !== rootDigest)
    throw fixedError("integration.images.manifest");
  const root = jsonRecord(rootRaw, "integration.images.manifest");
  let manifestDigest = rootDigest;
  let authoritativeRaw = rootRaw;
  if (Array.isArray(root.manifests)) {
    if (root.schemaVersion !== 2 || !indexMediaTypes.has(root.mediaType))
      throw fixedError("integration.images.manifest");
    const matches = root.manifests.filter((candidate) => {
      try {
        return (
          manifestMediaTypes.has(descriptor(candidate).mediaType) &&
          samePlatform(
            normalizePlatform(candidate.platform),
            normalizedPlatform,
          )
        );
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) throw fixedError("integration.images.manifest");
    const selected = descriptor(matches[0]);
    if (
      selectedRaw.byteLength !== selected.size ||
      digestBytes(selectedRaw) !== selected.digest
    )
      throw fixedError("integration.images.manifest");
    manifestDigest = selected.digest;
    authoritativeRaw = selectedRaw;
  } else if (!rootRaw.equals(selectedRaw)) {
    throw fixedError("integration.images.manifest");
  }
  const manifest = parseManifest(authoritativeRaw);
  if (
    configRaw.byteLength !== manifest.config.size ||
    digestBytes(configRaw) !== manifest.config.digest
  )
    throw fixedError("integration.images.config");
  return Object.freeze({
    platform: normalizedPlatform,
    manifestDigest,
    configDigest: manifest.config.digest,
    configBlob: configRaw.toString("base64"),
    rootManifest: rootRaw.toString("base64"),
    selectedManifest: selectedRaw.toString("base64"),
  });
};

const evidenceImage = (value) => {
  if (
    !exactKeys(value, [
      "configDigest",
      "configBlob",
      "image",
      "manifestDigest",
      "platform",
      "rootManifest",
      "selectedManifest",
    ]) ||
    !imagePattern.test(value.image ?? "") ||
    !digestPattern.test(value.manifestDigest ?? "") ||
    !digestPattern.test(value.configDigest ?? "")
  )
    throw fixedError("integration.images.evidence");
  let derived;
  try {
    derived = deriveManifestProof({
      image: value.image,
      platform: value.platform,
      configRaw: decodeProof(value.configBlob),
      rootRaw: decodeProof(value.rootManifest),
      selectedRaw: decodeProof(value.selectedManifest),
    });
  } catch {
    throw fixedError("integration.images.evidence");
  }
  if (
    value.manifestDigest !== derived.manifestDigest ||
    value.configDigest !== derived.configDigest ||
    !samePlatform(value.platform, derived.platform) ||
    !exactKeys(
      value.platform,
      derived.platform.variant === undefined
        ? ["architecture", "os"]
        : ["architecture", "os", "variant"],
    )
  )
    throw fixedError("integration.images.evidence");
  return Object.freeze({ image: value.image, ...derived });
};

const serializePreparedImageEvidence = (
  value,
  maximumBytes = maximumEvidenceBytes,
) => {
  let serialized;
  try {
    serialized = `${JSON.stringify(value, undefined, 2)}\n`;
  } catch {
    throw fixedError("integration.images.evidence");
  }
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > maximumEvidenceBytes ||
    Buffer.byteLength(serialized, "utf8") > maximumBytes
  )
    throw fixedError("integration.images.evidence");
  return serialized;
};

export const validatePreparedImageEvidence = (value, manifestIdentity) => {
  serializePreparedImageEvidence(value);
  if (
    !exactKeys(value, [
      "dockerDaemon",
      "dockerSocket",
      "imageEvidenceVersion",
      "images",
      "manifestIdentity",
      "preparationPolicy",
      "terminalCleanup",
    ]) ||
    value.imageEvidenceVersion !== 2 ||
    value.manifestIdentity !== manifestIdentity ||
    !manifestIdentityPattern.test(value.manifestIdentity ?? "") ||
    !validSocketEvidence(value.dockerSocket) ||
    !validEvidenceDaemon(value.dockerDaemon) ||
    !validPreparationPolicy(value.preparationPolicy) ||
    !validTerminalCleanup(value.terminalCleanup) ||
    value.dockerDaemon.endpoint !== value.dockerSocket.path ||
    value.dockerDaemon.socketDevice !== value.dockerSocket.device ||
    value.dockerDaemon.socketInode !== value.dockerSocket.inode ||
    !Array.isArray(value.images) ||
    value.images.length === 0 ||
    value.images.length > 256
  )
    throw fixedError("integration.images.evidence");
  const images = value.images.map(evidenceImage);
  if (
    new Set(images.map(({ image }) => image)).size !== images.length ||
    Buffer.byteLength(JSON.stringify(images), "utf8") > maximumEvidenceBytes
  )
    throw fixedError("integration.images.evidence");
  return Object.freeze({
    imageEvidenceVersion: 2,
    manifestIdentity,
    dockerSocket: Object.freeze({ ...value.dockerSocket }),
    dockerDaemon: Object.freeze({ ...value.dockerDaemon }),
    preparationPolicy: Object.freeze({ ...value.preparationPolicy }),
    terminalCleanup: Object.freeze({ ...value.terminalCleanup }),
    images: Object.freeze(images),
  });
};

export const readPreparedImageEvidence = (path, manifestIdentity) => {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.size < 1 ||
      status.size > maximumEvidenceBytes
    )
      throw fixedError("integration.images.evidence");
    const body = readFileSync(descriptor);
    if (body.byteLength !== status.size)
      throw fixedError("integration.images.evidence");
    return validatePreparedImageEvidence(
      JSON.parse(body.toString("utf8")),
      manifestIdentity,
    );
  } catch {
    throw fixedError("integration.images.evidence");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const localImageRecord = (value, image) => {
  const record = jsonRecord(value, "integration.images.digest");
  if (
    !digestPattern.test(record.Id ?? "") ||
    !Array.isArray(record.RepoDigests) ||
    !record.RepoDigests.includes(image)
  )
    throw fixedError("integration.images.digest");
  return Object.freeze({
    configDigest: record.Id,
    platform: normalizePlatform({
      os: record.Os,
      architecture: record.Architecture,
      variant: record.Variant,
    }),
  });
};

const preparationPolicy = (images, options) => {
  const preparationMilliseconds =
    options.maximumPreparationMilliseconds ?? maximumPreparationMilliseconds;
  const teardownMilliseconds =
    options.teardownMilliseconds ?? preparationTeardownMilliseconds;
  if (
    !Number.isSafeInteger(preparationMilliseconds) ||
    preparationMilliseconds < 4 ||
    preparationMilliseconds > maximumPreparationMilliseconds ||
    !Number.isSafeInteger(teardownMilliseconds) ||
    teardownMilliseconds < 1 ||
    teardownMilliseconds > preparationTeardownMilliseconds ||
    preparationMilliseconds <= teardownMilliseconds * 3
  )
    throw fixedError("integration.images.deadline");
  if (
    !Array.isArray(images) ||
    images.length === 0 ||
    images.some((image) => !imagePattern.test(image)) ||
    new Set(images).size !== images.length
  )
    throw fixedError("integration.images.digest");
  const deadline = performance.now() + preparationMilliseconds;
  return Object.freeze({
    deadline,
    workDeadline: deadline - teardownMilliseconds,
    reconciliationDeadline: deadline - Math.floor(teardownMilliseconds / 2),
    maximumPreparationMilliseconds: preparationMilliseconds,
    teardownMilliseconds,
  });
};

const createPrivateClientRoot = (options) => {
  const root = mkdtempSync(
    resolve(realpathSync("/tmp"), "agentscope-image-preparation-"),
  );
  const owned = { root, directories: [], files: [] };
  try {
    chmodSync(root, 0o700);
    options.afterPrivateRootCreatedForTesting?.(root);
    for (const name of ["docker", "home", "tmp", "xdg", "npm-cache"]) {
      const path = resolve(root, name);
      mkdirSync(path, { mode: 0o700 });
      owned.directories.push(path);
    }
    for (const [name, content] of [
      ["docker/config.json", '{"auths":{}}\n'],
      ["gitconfig", ""],
      ["npmrc", ""],
    ]) {
      const path = resolve(root, name);
      writeFileSync(path, content, { flag: "wx", mode: 0o600 });
      owned.files.push(path);
    }
    return owned;
  } catch (error) {
    cleanupPrivateClient(owned, Number.POSITIVE_INFINITY);
    throw error;
  }
};
const cleanupPrivateClient = (owned, deadline) => {
  const removeOwned = (operation) => {
    try {
      operation();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
  try {
    for (const path of [...owned.files].reverse()) {
      if (performance.now() > deadline)
        throw fixedError("integration.images.cleanup", true);
      removeOwned(() => unlinkSync(path));
    }
    for (const path of [...owned.directories].reverse()) {
      if (performance.now() > deadline)
        throw fixedError("integration.images.cleanup", true);
      removeOwned(() => rmdirSync(path));
    }
    if (performance.now() > deadline)
      throw fixedError("integration.images.cleanup", true);
    removeOwned(() => rmdirSync(owned.root));
    if (performance.now() > deadline)
      throw fixedError("integration.images.cleanup", true);
  } catch {
    throw fixedError("integration.images.cleanup");
  }
};

const writeTarText = (header, offset, length, value) => {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > length) throw fixedError("integration.images.build");
  encoded.copy(header, offset);
};
const writeTarOctal = (header, offset, length, value) => {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) throw fixedError("integration.images.build");
  writeTarText(header, offset, length, `${encoded}\0`);
};
const tarPath = (relative) => {
  const bytes = Buffer.byteLength(relative, "utf8");
  if (bytes <= 100) return { name: relative, prefix: "" };
  for (let index = relative.lastIndexOf("/"); index > 0;) {
    const prefix = relative.slice(0, index);
    const name = relative.slice(index + 1);
    if (
      Buffer.byteLength(prefix, "utf8") <= 155 &&
      Buffer.byteLength(name, "utf8") <= 100
    )
      return { name, prefix };
    index = relative.lastIndexOf("/", index - 1);
  }
  throw fixedError("integration.images.build");
};
const tarHeader = (relative, status, directory) => {
  const header = Buffer.alloc(512);
  const split = tarPath(relative);
  writeTarText(header, 0, 100, split.name);
  writeTarOctal(
    header,
    100,
    8,
    directory ? 0o755 : (status.mode & 0o111) === 0 ? 0o644 : 0o755,
  );
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, directory ? 0 : status.size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeTarText(header, 156, 1, directory ? "5" : "0");
  writeTarText(header, 257, 6, "ustar\0");
  writeTarText(header, 263, 2, "00");
  writeTarText(header, 345, 155, split.prefix);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
};
const boundedBuildContext = (root) => {
  const canonicalRoot = realpathSync(root);
  const chunks = [];
  let total = 0;
  let entries = 0;
  const append = (chunk) => {
    total += chunk.byteLength;
    if (total > maximumBuildContextBytes)
      throw fixedError("integration.images.build");
    chunks.push(chunk);
  };
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      entries += 1;
      if (entries > 8_192 || entry.isSymbolicLink())
        throw fixedError("integration.images.build");
      const absolute = resolve(directory, entry.name);
      const status = lstatSync(absolute);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        const physical = realpathSync(absolute);
        if (!physical.startsWith(`${canonicalRoot}/`))
          throw fixedError("integration.images.build");
        append(tarHeader(`${relative}/`, status, true));
        visit(physical, relative);
      } else if (entry.isFile()) {
        let descriptor;
        let body;
        try {
          descriptor = openSync(
            absolute,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          const current = fstatSync(descriptor);
          if (
            !current.isFile() ||
            current.dev !== status.dev ||
            current.ino !== status.ino ||
            current.size !== status.size
          )
            throw fixedError("integration.images.build");
          body = readFileSync(descriptor);
          if (body.byteLength !== current.size)
            throw fixedError("integration.images.build");
        } finally {
          if (descriptor !== undefined) closeSync(descriptor);
        }
        append(tarHeader(relative, status, false));
        append(body);
        const padding = (512 - (body.byteLength % 512)) % 512;
        if (padding > 0) append(Buffer.alloc(padding));
      } else throw fixedError("integration.images.build");
    }
  };
  visit(canonicalRoot, "");
  append(Buffer.alloc(1024));
  return Buffer.concat(chunks);
};
export const createBoundedBuildContext = (root) => {
  try {
    return boundedBuildContext(root);
  } catch {
    throw fixedError("integration.images.build");
  }
};

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
  const version = jsonRecord(versionResponse.body, "integration.images.daemon");
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

const parseImageReference = (image) => {
  const repository = image.slice(0, image.lastIndexOf("@"));
  const digest = image.slice(image.lastIndexOf("@") + 1);
  const parts = repository.split("/");
  const explicitRegistry =
    parts.length > 1 && /[.:]/u.test(parts[0]) ? parts.shift() : undefined;
  if (explicitRegistry !== undefined && explicitRegistry !== "docker.io")
    throw fixedError("integration.images.registry");
  let name = parts.join("/");
  if (!name.includes("/")) name = `library/${name}`;
  if (
    !/^[a-z\d]+(?:[._-][a-z\d]+)*(?:\/[a-z\d]+(?:[._-][a-z\d]+)*)+$/u.test(name)
  )
    throw fixedError("integration.images.registry");
  return Object.freeze({
    digest,
    name,
    origin: new URL("https://registry-1.docker.io"),
  });
};
const registryTransport = (request) =>
  boundedRequest({ ...request, origin: request.origin });
export const probePinnedRegistryTlsForTesting = async (origin) => {
  if (
    !(origin instanceof URL) ||
    origin.protocol !== "https:" ||
    !["127.0.0.1", "::1"].includes(origin.hostname)
  )
    throw fixedError("integration.images.registry");
  return registryTransport({
    deadline: performance.now() + 1_000,
    headers: Object.freeze({ Accept: "application/json" }),
    method: "GET",
    origin,
    path: "/",
    maximumBytes: 1_024,
  });
};
const allowedBlobRedirect = (rawLocation) => {
  if (typeof rawLocation !== "string" || rawLocation.length > 4_096)
    throw fixedError("integration.images.registry");
  let location;
  try {
    location = new URL(rawLocation);
  } catch {
    throw fixedError("integration.images.registry");
  }
  const allowedHost =
    location.hostname === "production.cloudflare.docker.com" ||
    location.hostname === "production.cloudfront.docker.com" ||
    location.hostname.endsWith(".r2.cloudflarestorage.com");
  if (
    location.protocol !== "https:" ||
    (location.port !== "" && location.port !== "443") ||
    location.username !== "" ||
    location.password !== "" ||
    !allowedHost
  )
    throw fixedError("integration.images.registry");
  return location;
};
const bearerChallenge = (header, name) => {
  const match =
    /^Bearer realm="([^"]+)",service="([^"]+)",scope="([^"]+)"$/u.exec(
      header ?? "",
    );
  const expectedScope = `repository:${name}:pull`;
  if (
    match === null ||
    match[1] !== "https://auth.docker.io/token" ||
    match[2] !== "registry.docker.io" ||
    match[3] !== expectedScope
  )
    throw fixedError("integration.images.registry");
  return Object.freeze({
    origin: new URL("https://auth.docker.io"),
    path: `/token?service=registry.docker.io&scope=${encodeURIComponent(expectedScope)}`,
  });
};

const fetchRegistryManifest = async (
  transport,
  policy,
  signal,
  reference,
  tokenCache,
) => {
  const parsed = parseImageReference(reference);
  const path = `/v2/${parsed.name}/manifests/${parsed.digest}`;
  const perform = (token) =>
    requestWith(transport, {
      deadline: policy.workDeadline,
      headers: Object.freeze({
        Accept: manifestAccept,
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      }),
      method: "GET",
      origin: parsed.origin,
      path,
      signal,
      maximumBytes: maximumManifestBytes,
    });
  let token = tokenCache.get(parsed.name);
  let response = await perform(token);
  if (response.statusCode === 401 && token === undefined) {
    const challenge = bearerChallenge(
      response.headers["www-authenticate"],
      parsed.name,
    );
    const tokenResponse = await requestWith(transport, {
      deadline: policy.workDeadline,
      headers: Object.freeze({ Accept: "application/json" }),
      method: "GET",
      origin: challenge.origin,
      path: challenge.path,
      signal,
      maximumBytes: maximumTokenBytes,
    });
    if (tokenResponse.statusCode !== 200)
      throw fixedError("integration.images.registry");
    const tokenValue = jsonRecord(
      tokenResponse.body,
      "integration.images.registry",
    );
    token = tokenValue.token ?? tokenValue.access_token;
    if (!boundedText(token, 8_192))
      throw fixedError("integration.images.registry");
    tokenCache.set(parsed.name, token);
    response = await perform(token);
  }
  if (response.statusCode !== 200)
    throw fixedError("integration.images.registry");
  const contentType = response.headers["content-type"]?.split(";", 1)[0];
  if (![...indexMediaTypes, ...manifestMediaTypes].includes(contentType))
    throw fixedError("integration.images.manifest");
  if (
    jsonRecord(response.body, "integration.images.manifest").mediaType !==
    contentType
  )
    throw fixedError("integration.images.manifest");
  const advertised = response.headers["docker-content-digest"];
  if (advertised !== undefined && advertised !== digestBytes(response.body))
    throw fixedError("integration.images.manifest");
  return response.body;
};

const fetchRegistryBlob = async ({
  digest,
  image,
  policy,
  signal,
  tokenCache,
  transport,
}) => {
  const parsed = parseImageReference(image);
  const token = tokenCache.get(parsed.name);
  if (token === undefined) throw fixedError("integration.images.registry");
  let response = await requestWith(transport, {
    deadline: policy.workDeadline,
    headers: Object.freeze({
      Accept: "application/octet-stream",
      Authorization: `Bearer ${token}`,
    }),
    method: "GET",
    origin: parsed.origin,
    path: `/v2/${parsed.name}/blobs/${digest}`,
    signal,
    maximumBytes: maximumManifestBytes,
  });
  if (response.statusCode === 302 || response.statusCode === 307) {
    const location = allowedBlobRedirect(response.headers.location);
    response = await requestWith(transport, {
      deadline: policy.workDeadline,
      headers: Object.freeze({ Accept: "application/octet-stream" }),
      method: "GET",
      origin: location,
      path: `${location.pathname}${location.search}`,
      signal,
      maximumBytes: maximumManifestBytes,
    });
  }
  if (
    response.statusCode !== 200 ||
    response.headers["content-type"]?.split(";", 1)[0] !==
      "application/octet-stream" ||
    digestBytes(response.body) !== digest ||
    (response.headers["docker-content-digest"] !== undefined &&
      response.headers["docker-content-digest"] !== digest)
  )
    throw fixedError("integration.images.config");
  return response.body;
};

const acquireManifestProof = async ({
  image,
  platform,
  policy,
  signal,
  tokenCache,
  transport,
}) => {
  const rootRaw = await fetchRegistryManifest(
    transport,
    policy,
    signal,
    image,
    tokenCache,
  );
  const root = jsonRecord(rootRaw, "integration.images.manifest");
  let selectedRaw = rootRaw;
  if (Array.isArray(root.manifests)) {
    const matches = root.manifests.filter((candidate) => {
      try {
        return (
          manifestMediaTypes.has(descriptor(candidate).mediaType) &&
          samePlatform(normalizePlatform(candidate.platform), platform)
        );
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) throw fixedError("integration.images.manifest");
    const selected = descriptor(matches[0]);
    const repository = image.slice(0, image.lastIndexOf("@"));
    selectedRaw = await fetchRegistryManifest(
      transport,
      policy,
      signal,
      `${repository}@${selected.digest}`,
      tokenCache,
    );
  }
  const selectedManifest = parseManifest(selectedRaw);
  const configRaw = await fetchRegistryBlob({
    digest: selectedManifest.config.digest,
    image,
    policy,
    signal,
    tokenCache,
    transport,
  });
  return deriveManifestProof({
    configRaw,
    image,
    platform,
    rootRaw,
    selectedRaw,
  });
};

const pullImage = async (transport, daemon, policy, signal, image) => {
  const separator = image.lastIndexOf("@");
  const repository = image.slice(0, separator);
  const digest = image.slice(separator + 1);
  try {
    const response = await engineCall(
      { policy, signal, transport },
      {
        expected: [200],
        method: "POST",
        path: `/v${daemon.apiVersion}/images/create?fromImage=${encodeURIComponent(repository)}&tag=${encodeURIComponent(digest)}`,
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
  const daemonPlatform = normalizePlatform({
    os: initialDaemon.osType,
    architecture: initialDaemon.architecture,
  });
  const tokenCache = new Map();
  const preparedImages = [];
  let evidenceBytes = 2;
  for (const image of images) {
    const proof = await acquireManifestProof({
      image,
      platform: daemonPlatform,
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
      await pullImage(engine, initialDaemon, policy, signal, image);
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

export const preparePinnedDockerImages = async (images, options = {}) => {
  const policy = preparationPolicy(images, options);
  let privateClient;
  let prepared;
  let failure;
  try {
    const socket =
      options.socketIdentityForTesting === undefined
        ? resolveDockerSocket(options.dockerSocketForTesting)
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
      privateState: "absent",
    }),
  });
  preparedSets.add(completed);
  return completed;
};

export const revalidatePreparedImageAdmission = async (
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
    const daemon = await inspectDaemon(engine, socket, policy, options.signal);
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

export const createPreparedDockerClient = (evidence, options = {}) => {
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
    const executable = resolveDockerExecutable(
      options.dockerExecutableForTesting,
    );
    privateClient = createPrivateClientRoot({});
    const client = Object.freeze({
      evidence,
      executable,
      privateClient,
      socket,
      engineRequestForTesting: options.engineRequestForTesting,
    });
    preparedDockerClients.add(client);
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

export const prepareDockerInvocation = async (client, arguments_, signal) => {
  if (
    !preparedDockerClients.has(client) ||
    closingPreparedDockerClients.has(client) ||
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
    !sameExecutable(client.executable, executableRecord(client.executable.path))
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
    environment: Object.freeze({}),
  });
};
const validBuildMap = (value) =>
  exactKeys(value, Object.keys(value ?? {})) &&
  Object.entries(value).every(
    ([name, entry]) => boundedText(name, 128) && boundedText(entry, 1_024),
  );

export const buildPreparedDockerImage = async (
  client,
  {
    buildArguments,
    context,
    dockerfile,
    labels,
    maximumMilliseconds,
    signal,
    tag,
  },
) => {
  if (
    !preparedDockerClients.has(client) ||
    closingPreparedDockerClients.has(client) ||
    typeof context !== "string" ||
    typeof dockerfile !== "string" ||
    !/^(?:[A-Za-z\d][A-Za-z\d._-]{0,127}\.Dockerfile|Dockerfile)$/u.test(
      dockerfile,
    ) ||
    typeof tag !== "string" ||
    !/^[a-z\d][a-z\d._/-]{0,127}:[a-z\d][a-z\d._-]{0,127}$/u.test(tag) ||
    !validBuildMap(buildArguments) ||
    !validBuildMap(labels)
  )
    throw fixedError("integration.images.build");
  const policy = preparationPolicy([client.evidence.images[0].image], {
    maximumPreparationMilliseconds: maximumMilliseconds,
    teardownMilliseconds: Math.min(
      preparationTeardownMilliseconds,
      Math.floor(maximumMilliseconds / 4),
    ),
  });
  const archive = createBoundedBuildContext(context);
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
  if (!sameDaemon(client.evidence.dockerDaemon, initialDaemon))
    throw fixedError("integration.images.build");
  const query = new URLSearchParams({
    buildargs: JSON.stringify(buildArguments),
    dockerfile,
    forcerm: "1",
    labels: JSON.stringify(labels),
    networkmode: "none",
    pull: "0",
    rm: "1",
    t: tag,
  });
  let buildStarted = false;
  try {
    buildStarted = true;
    const response = await engineCall(
      { policy, signal, transport: engine },
      {
        body: archive,
        expected: [200],
        headers: Object.freeze({
          "Content-Length": String(archive.byteLength),
          "Content-Type": "application/x-tar",
        }),
        maximumBytes: maximumBuildOutputBytes,
        method: "POST",
        path: `/v${initialDaemon.apiVersion}/build?${query.toString()}`,
      },
    );
    const lines = response.body
      .toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    if (lines.length === 0) throw fixedError("integration.images.build");
    for (const line of lines) {
      const event = jsonRecord(line, "integration.images.build");
      if (event.error !== undefined || event.errorDetail !== undefined)
        throw fixedError("integration.images.build");
    }
    const inspection = await engineCall(
      { policy, signal, transport: engine },
      {
        expected: [200],
        method: "GET",
        path: `/v${initialDaemon.apiVersion}/images/${encodeURIComponent(tag)}/json`,
      },
    );
    const built = jsonRecord(inspection.body, "integration.images.build");
    if (
      !digestPattern.test(built.Id ?? "") ||
      !Array.isArray(built.RepoTags) ||
      !built.RepoTags.includes(tag)
    )
      throw fixedError("integration.images.build");
    assertSocketCurrentFor(engine, client.socket);
    const finalDaemon = await inspectDaemon(
      engine,
      client.socket,
      policy,
      signal,
    );
    if (!sameDaemon(initialDaemon, finalDaemon))
      throw fixedError("integration.images.build");
    return built.Id.replace(":", "-");
  } catch (error) {
    throw fixedError(
      buildStarted
        ? "integration.images.build-uncertain"
        : "integration.images.build",
      error?.code === "ETIMEDOUT",
    );
  }
};

export const closePreparedDockerClient = (client) => {
  if (!preparedDockerClients.has(client))
    throw fixedError("integration.images.docker-client");
  closingPreparedDockerClients.add(client);
  cleanupPrivateClient(
    client.privateClient,
    performance.now() + preparationTeardownMilliseconds,
  );
  preparedDockerClients.delete(client);
  closingPreparedDockerClients.delete(client);
};

export const publishPreparedImageEvidence = (
  target,
  manifestIdentity,
  prepared,
  options = {},
) => {
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    if (!preparedSets.has(prepared))
      throw fixedError("integration.images.publication");
    const evidence = {
      imageEvidenceVersion: 2,
      manifestIdentity,
      ...prepared,
    };
    validatePreparedImageEvidence(evidence, manifestIdentity);
    const serialized = serializePreparedImageEvidence(
      evidence,
      options.maximumEvidenceBytesForTesting,
    );
    const descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      writeFileSync(descriptor, serialized);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, target);
  } catch {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT")
        throw fixedError("integration.images.cleanup");
    }
    throw fixedError("integration.images.publication");
  }
};

export const retirePreparedImageEvidence = (target) => {
  try {
    unlinkSync(target);
  } catch (error) {
    if (error?.code !== "ENOENT")
      throw fixedError("integration.images.retirement");
  }
};

export const IMAGE_PREPARATION_LIMITS = Object.freeze({
  maximumPreparationMilliseconds,
  maximumTeardownMilliseconds: preparationTeardownMilliseconds,
  maximumResponseBytes,
  maximumManifestBytes,
  maximumEvidenceBytes,
});
