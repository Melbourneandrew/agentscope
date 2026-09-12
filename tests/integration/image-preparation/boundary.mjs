/** Exact platform, socket, process, and bounded transport boundary primitives. */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { rootCertificates } from "node:tls";

const maximumPreparationMilliseconds = 300_000;
export const preparationTeardownMilliseconds = 5_000;
export const maximumResponseBytes = 1_048_576;
export const maximumManifestBytes = 1_048_576;
export const maximumEvidenceBytes = 8_388_608;
export const maximumTokenBytes = 16_384;
const maximumHeaderBytes = 16_384;
export const defaultMaximumBuildContextBytes = 64 * 1024 * 1024;
export const maximumHarnessBuildContextBytes = 384 * 1024 * 1024;
const maximumBuildOutputBytes = 16 * 1024 * 1024;
const maximumProcessInspectionBytes = 1_048_576;
export const maximumPrivateStateEntries = 4_096;
export const maximumPrivateStateDepth = 16;
export const maximumPrivateStateFileBytes = 8 * 1024 * 1024;
export const maximumPrivateStateTotalBytes = 64 * 1024 * 1024;
const processAbsencePollMilliseconds = 10;
const processDiagnostics = new WeakMap();
export const digestPattern = /^sha256:[a-f\d]{64}$/u;
export const imagePattern = /^[^\s@]{1,448}@sha256:[a-f\d]{64}$/u;
export const manifestIdentityPattern = /^sha256-[a-f\d]{64}$/u;
const platformValuePattern = /^[a-z\d][a-z\d._-]{0,63}$/u;
export const apiVersionPattern = /^\d{1,3}\.\d{1,3}$/u;
export const IMAGE_PREPARATION_EXECUTION_POLICY = Object.freeze({
  platform: Object.freeze({
    os: "linux",
    architecture: "amd64",
    variant: "",
  }),
  socket: "/var/run/docker.sock",
  dockerExecutables: Object.freeze(["/usr/bin/docker"]),
  buildxExecutables: Object.freeze([
    "/usr/lib/docker/cli-plugins/docker-buildx",
    "/usr/libexec/docker/cli-plugins/docker-buildx",
  ]),
});
export const BUILDKIT_IMAGE =
  "moby/buildkit@sha256:6eceb8971ce4fceb3daca562832642706238b7eea72941fcf9896c93c3c4a53e";

export const fixedError = (code, timedOut = false) => {
  const error = new Error(code);
  if (timedOut) error.code = "ETIMEDOUT";
  return error;
};
export const diagnosticDigest = (value) =>
  digestBytes(Buffer.from(JSON.stringify(value), "utf8"));
const buildxStderrClassifiers = Object.freeze([
  ["resource-conflict", /(?:already exists|existing instance)/iu],
  ["build-failed", /(?:failed to solve|failed to build)/iu],
  [
    "bootstrap-failed",
    /(?:failed to boot|bootstrap|connection refused|unavailable)/iu,
  ],
  ["permission-denied", /(?:permission denied|operation not permitted)/iu],
]);
const classifyBuildxStderr = (value) => {
  if (typeof value !== "string" || value.length > maximumHeaderBytes)
    return "unknown";
  return (
    buildxStderrClassifiers.find(([, pattern]) => pattern.test(value))?.[0] ??
    "unknown"
  );
};
export const classifyBuildxStderrForTesting = classifyBuildxStderr;
export const boundedText = (value, maximum = 256) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  /^[\x20-\x7e]+$/u.test(value);
export const exactKeys = (value, keys) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());
export const digestBytes = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const jsonRecord = (value, code) => {
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
export const normalizePlatform = (value) => {
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
export const samePlatform = (left, right) =>
  left.os === right.os &&
  left.architecture === right.architecture &&
  (left.variant ?? "") === (right.variant ?? "");

export const socketRecord = (path) => {
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
export const sameSocket = (left, right) =>
  left.path === right.path &&
  left.device === right.device &&
  left.inode === right.inode &&
  left.mode === right.mode &&
  left.owner === right.owner;
export const executableRecord = (path) => {
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
export const sameExecutable = (left, right) =>
  left.path === right.path &&
  left.device === right.device &&
  left.inode === right.inode &&
  left.mode === right.mode &&
  left.owner === right.owner &&
  left.size === right.size &&
  left.ctimeNanoseconds === right.ctimeNanoseconds;
const assertProductionPlatform = (platform) => {
  if (platform !== IMAGE_PREPARATION_EXECUTION_POLICY.platform.os)
    throw fixedError("integration.images.platform");
};
export const assertImagePreparationPlatformForTesting = (platform) =>
  assertProductionPlatform(platform);
export const resolveDockerExecutable = (requested) => {
  if (requested !== undefined) return executableRecord(requested);
  assertProductionPlatform(process.platform);
  for (const candidate of IMAGE_PREPARATION_EXECUTION_POLICY.dockerExecutables) {
    try {
      return executableRecord(candidate);
    } catch {
      // The fixed absolute executable list is authoritative.
    }
  }
  throw fixedError("integration.images.executable");
};
export const productionDockerExecutable = (requested) => {
  if (!IMAGE_PREPARATION_EXECUTION_POLICY.dockerExecutables.includes(requested))
    throw fixedError("integration.images.executable");
  assertProductionPlatform(process.platform);
  return executableRecord(requested);
};
export const resolveBuildxExecutable = (requested) => {
  if (requested !== undefined) return executableRecord(requested);
  assertProductionPlatform(process.platform);
  for (const candidate of IMAGE_PREPARATION_EXECUTION_POLICY.buildxExecutables) {
    try {
      return executableRecord(candidate);
    } catch {
      // The fixed absolute executable list is authoritative.
    }
  }
  throw fixedError("integration.images.executable");
};
const processInspectionExecutable =
  process.platform === "darwin"
    ? "/bin/ps"
    : process.platform === "linux"
      ? "/usr/bin/ps"
      : undefined;
const processGroupState = (processGroup, deadline) => {
  const remaining = Math.floor(deadline - performance.now());
  if (processInspectionExecutable === undefined || remaining < 1)
    return "unavailable";
  try {
    const output = execFileSync(
      processInspectionExecutable,
      ["-axo", "pid=,pgid=,state="],
      {
        encoding: "utf8",
        maxBuffer: maximumProcessInspectionBytes,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: remaining,
      },
    );
    const states = output
      .trimEnd()
      .split("\n")
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(line))
      .filter((match) => match !== null && Number(match[2]) === processGroup)
      .map((match) => match[3]);
    if (states.length === 0) return "absent";
    return states.every((state) => state.startsWith("Z"))
      ? "zombie-only"
      : "live";
  } catch {
    return "unavailable";
  }
};
const killProcessGroup = (processGroup) => {
  try {
    process.kill(-processGroup, "SIGKILL");
    return true;
  } catch (error) {
    return error?.code === "ESRCH";
  }
};
const processGroupIsAbsent = (processGroup) => {
  try {
    process.kill(-processGroup, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
};
const waitForProcessGroupAbsence = async (processGroup, deadline) => {
  for (;;) {
    if (processGroupIsAbsent(processGroup)) return true;
    if (performance.now() >= deadline) return false;
    await new Promise((resolveWait) =>
      setTimeout(
        resolveWait,
        Math.min(
          processAbsencePollMilliseconds,
          Math.max(1, deadline - performance.now()),
        ),
      ),
    );
  }
};
const commandPhaseDeadlines = (deadline, teardownMilliseconds) => {
  const workDeadline = deadline - teardownMilliseconds;
  const closeDeadline =
    workDeadline + Math.max(1, Math.floor(teardownMilliseconds / 2));
  const inspectionReserve = Math.min(
    250,
    Math.max(1, Math.floor(teardownMilliseconds / 4)),
  );
  return {
    absenceDeadline: deadline - inspectionReserve,
    closeDeadline,
    teardownDeadline: deadline,
    workDeadline,
  };
};
// The spawn-through-terminal-join path is one indivisible process authority.
/* eslint-disable max-lines-per-function */
const runOwnedCommand = async (
  executable,
  arguments_,
  {
    closeBarrierForTesting,
    deadline,
    environment,
    input,
    observeProcess,
    signal,
    teardownMilliseconds,
  },
) => {
  if (process.platform === "win32" || processInspectionExecutable === undefined)
    throw fixedError("integration.images.platform");
  if (signal?.aborted) throw fixedError("integration.images.interrupted");
  const executableIdentity = executableRecord(executable.path);
  if (!sameExecutable(executable, executableIdentity))
    throw fixedError("integration.images.executable");
  const { absenceDeadline, closeDeadline, teardownDeadline, workDeadline } =
    commandPhaseDeadlines(deadline, teardownMilliseconds);
  if (performance.now() >= workDeadline)
    throw fixedError("integration.images.timeout", true);
  const child = spawn(executableIdentity.path, arguments_, {
    detached: true,
    env: environment,
    shell: false,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const processGroup = child.pid;
  if (!Number.isSafeInteger(processGroup) || processGroup < 1) {
    child.kill("SIGKILL");
    throw fixedError("integration.images.command");
  }
  let bytes = 0;
  const output = [];
  const diagnosticStderr = [];
  let diagnosticStderrBytes = 0;
  let outputTruncated = false;
  let failure;
  const fail = (code, timedOut = false) => {
    failure ??= fixedError(code, timedOut);
    killProcessGroup(processGroup);
  };
  const consume = (chunk, retain) => {
    bytes += chunk.byteLength;
    if (bytes > maximumBuildOutputBytes) {
      outputTruncated = true;
      fail("integration.images.output");
    } else if (retain) output.push(chunk);
    else if (diagnosticStderrBytes < maximumHeaderBytes) {
      const retained = chunk.subarray(
        0,
        Math.max(0, maximumHeaderBytes - diagnosticStderrBytes),
      );
      diagnosticStderr.push(retained);
      diagnosticStderrBytes += retained.byteLength;
      if (retained.byteLength !== chunk.byteLength) outputTruncated = true;
    } else outputTruncated = true;
  };
  child.stdout.on("data", (chunk) => consume(chunk, true));
  child.stderr.on("data", (chunk) => consume(chunk, false));
  const onAbort = () => fail("integration.images.interrupted");
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => fail("integration.images.timeout", true),
    Math.max(1, workDeadline - performance.now()),
  );
  const closed = new Promise((resolveClose) => {
    child.once("error", () => fail("integration.images.command"));
    child.once("close", (code, childSignal) =>
      resolveClose({ code, childSignal }),
    );
  });
  const observedClose = closed.then(async (result) => {
    await closeBarrierForTesting?.(processGroup);
    return result;
  });
  if (input !== undefined) {
    child.stdin.on("error", () => fail("integration.images.command"));
    child.stdin.end(input);
  }
  try {
    const result = await Promise.race([
      observedClose,
      new Promise((resolveClose) =>
        setTimeout(
          () => resolveClose(undefined),
          Math.max(1, closeDeadline - performance.now()),
        ).unref(),
      ),
    ]);
    if (result === undefined) {
      failure = fixedError("integration.images.containment", true);
      killProcessGroup(processGroup);
    }
    if (
      result !== undefined &&
      failure === undefined &&
      (result.code !== 0 || result.childSignal !== null)
    )
      failure = fixedError("integration.images.command");
    if (failure === undefined && !processGroupIsAbsent(processGroup))
      failure = fixedError("integration.images.containment");
    if (!killProcessGroup(processGroup))
      failure = fixedError("integration.images.containment", true);
    const absent = await waitForProcessGroupAbsence(
      processGroup,
      Math.max(performance.now(), absenceDeadline),
    );
    const state = absent
      ? "absent"
      : processGroupState(processGroup, teardownDeadline);
    const processDiagnostic = Object.freeze({
      observed: true,
      exited: result !== undefined && result.code !== null,
      signaled: result !== undefined && result.childSignal !== null,
      timedOut: failure?.code === "ETIMEDOUT",
      joined: state === "absent",
      outputBytes: bytes,
      outputTruncated,
      stderrClass: classifyBuildxStderr(
        Buffer.concat(diagnosticStderr).toString("utf8"),
      ),
    });
    observeProcess?.(processDiagnostic);
    if (failure instanceof Error)
      processDiagnostics.set(failure, processDiagnostic);
    if (state !== "absent") {
      const error = fixedError(
        state === "zombie-only"
          ? "integration.images.teardown"
          : "integration.images.containment",
        true,
      );
      error.containmentProved = false;
      processDiagnostics.set(error, processDiagnostic);
      throw error;
    }
    if (failure !== undefined) throw failure;
    return Buffer.concat(output).toString("utf8");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    killProcessGroup(processGroup);
  }
};
/* eslint-enable max-lines-per-function */
const runOwnedImageCommand = (executable, arguments_, options) =>
  runOwnedCommand(executableRecord(executable), arguments_, {
    ...options,
    environment: options.environment ?? {},
    teardownMilliseconds:
      options.teardownMilliseconds ?? preparationTeardownMilliseconds,
  });
export const readImageProcessDiagnostic = (error) =>
  processDiagnostics.get(error);
export const runOwnedImageCommandForTesting = (
  executable,
  arguments_,
  options,
) => runOwnedImageCommand(executable, arguments_, options);
export const resolveDockerSocket = (requested) => {
  if (requested !== undefined) return socketRecord(requested);
  if (process.platform !== IMAGE_PREPARATION_EXECUTION_POLICY.platform.os)
    throw fixedError("integration.images.platform");
  return socketRecord(IMAGE_PREPARATION_EXECUTION_POLICY.socket);
};
const authenticateDockerSocket = (policyPath, requested) => {
  const policySocket = socketRecord(policyPath);
  if (requested !== policySocket.path)
    throw fixedError("integration.images.socket");
  const socket = socketRecord(requested);
  if (!sameSocket(socket, policySocket))
    throw fixedError("integration.images.socket");
  return socket;
};
export const productionDockerSocket = (requested) => {
  assertProductionPlatform(process.platform);
  return authenticateDockerSocket(
    IMAGE_PREPARATION_EXECUTION_POLICY.socket,
    requested,
  );
};
export const authenticateDockerSocketAliasForTesting = authenticateDockerSocket;
export const productionDockerEnvironment = (environment, socket) => {
  const expected = {
    DOCKER_HOST: `unix://${socket.path}`,
    LANG: "C.UTF-8",
    PATH: "/usr/bin:/bin",
  };
  if (
    typeof environment !== "object" ||
    environment === null ||
    JSON.stringify(Object.keys(environment).sort()) !==
      JSON.stringify(Object.keys(expected).sort()) ||
    Object.entries(expected).some(
      ([name, value]) => environment[name] !== value,
    )
  )
    throw fixedError("integration.images.environment");
  return Object.freeze({ ...expected });
};
export const assertSocketCurrent = (identity) => {
  if (!sameSocket(identity, socketRecord(identity.path)))
    throw fixedError("integration.images.socket");
};
export const validSocketEvidence = (value) =>
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
export const boundedRequest = ({
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
export const requestWith = async (transport, request) => {
  const response = responseRecord(await transport(request));
  if (response.body.byteLength > request.maximumBytes)
    throw fixedError("integration.images.output");
  return response;
};

export const daemonIdentity = (socket, versionValue, infoValue) => {
  const version = jsonRecord(versionValue, "integration.images.daemon");
  const info = jsonRecord(infoValue, "integration.images.daemon");
  const identity = {
    endpoint: socket.path,
    socketDevice: socket.device,
    socketInode: socket.inode,
    id: info.ID,
    serverVersion: version.Version,
    apiVersion: version.ApiVersion,
    product: version.Platform?.Name,
    operatingSystem: info.OperatingSystem,
    osType: info.OSType,
    architecture: info.Architecture,
  };
  if (
    !boundedText(identity.endpoint, 1024) ||
    !boundedText(identity.id, 128) ||
    !boundedText(identity.serverVersion, 64) ||
    !apiVersionPattern.test(identity.apiVersion ?? "") ||
    !boundedText(identity.product, 96) ||
    !boundedText(identity.operatingSystem, 96) ||
    /docker desktop/iu.test(
      `${identity.product} ${identity.operatingSystem}`,
    ) ||
    !platformValuePattern.test(identity.osType ?? "") ||
    !platformValuePattern.test(identity.architecture ?? "")
  )
    throw fixedError("integration.images.daemon");
  return Object.freeze(identity);
};
export const sameDaemon = (left, right) =>
  left.endpoint === right.endpoint &&
  left.socketDevice === right.socketDevice &&
  left.socketInode === right.socketInode &&
  left.id === right.id &&
  left.serverVersion === right.serverVersion &&
  left.apiVersion === right.apiVersion &&
  left.product === right.product &&
  left.operatingSystem === right.operatingSystem &&
  left.osType === right.osType &&
  left.architecture === right.architecture;
export const validEvidenceDaemon = (value) =>
  exactKeys(value, [
    "apiVersion",
    "architecture",
    "endpoint",
    "id",
    "operatingSystem",
    "osType",
    "product",
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
  boundedText(value.product, 96) &&
  boundedText(value.operatingSystem, 96) &&
  !/docker desktop/iu.test(`${value.product} ${value.operatingSystem}`) &&
  platformValuePattern.test(value.osType ?? "") &&
  platformValuePattern.test(value.architecture ?? "");
export const validPreparationPolicy = (value) =>
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
export const validTerminalCleanup = (value) =>
  exactKeys(value, ["daemon", "handles", "privateState"]) &&
  value.daemon === "stable" &&
  value.handles === "settled" &&
  value.privateState === "retained-for-outer-host-retirement";

export const localImageRecord = (value, image) => {
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

export const preparationPolicy = (images, options) => {
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

export const IMAGE_PREPARATION_LIMITS = Object.freeze({
  maximumPreparationMilliseconds,
  maximumTeardownMilliseconds: preparationTeardownMilliseconds,
  maximumResponseBytes,
  maximumManifestBytes,
  maximumEvidenceBytes,
  defaultMaximumBuildContextBytes,
  maximumHarnessBuildContextBytes,
  maximumPrivateStateEntries,
  maximumPrivateStateDepth,
  maximumPrivateStateFileBytes,
  maximumPrivateStateTotalBytes,
});
