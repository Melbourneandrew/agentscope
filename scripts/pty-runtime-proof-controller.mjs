import { createHash, randomBytes } from "node:crypto";
import { lstatSync, writeSync } from "node:fs";
import { request as httpRequest } from "node:http";
import process from "node:process";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

const dockerSocket = "/var/run/docker.sock";
const repositoryPath = "/home/runner/work/agentscope/agentscope";
const api = "/v1.45";
const imageRepository = "node";
const imageManifest =
  "sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c";
const image = `${imageRepository}@${imageManifest}`;
const imageId =
  "sha256:395425e54d98ebbd748d388685a0c2de151a30fa92fffc10ba30fa63f3db64d6";
const innerReceipt = Buffer.from('{"version":1,"status":"passed"}\n');
const innerReceiptDigest =
  "709d35b6bbb00dad49454715be8809fda10f96a50219caca8fbed53594b488d1";
const maximumBodyBytes = 256 * 1024;
const maximumRequestBytes = 32 * 1024;
const totalMilliseconds = 90_000;
const teardownReserveMilliseconds = 7_000;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoded = (value) => encodeURIComponent(value);

class ControllerFailure extends Error {
  constructor(code, outcome = "failure") {
    super(code);
    this.code = code;
    this.outcome = outcome;
  }
}

const remainingMilliseconds = (deadline) =>
  Math.max(0, Math.floor(deadline - performance.now()));
const exactObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const parseJson = (body, code) => {
  if (!Buffer.isBuffer(body) || body.length === 0)
    throw new ControllerFailure(code);
  try {
    return JSON.parse(decoder.decode(body));
  } catch {
    throw new ControllerFailure(code);
  }
};
const socketRecord = (path, owner) => {
  const value = lstatSync(path, { bigint: true });
  if (
    !value.isSocket() ||
    value.isSymbolicLink() ||
    value.uid !== owner ||
    ![0o600n, 0o660n].includes(value.mode & 0o777n)
  )
    throw new ControllerFailure("socket-identity-invalid", "uncertain");
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    uid: value.uid,
  });
};
const sameSocket = (left, right) =>
  ["dev", "ino", "mode", "uid"].every((key) => left[key] === right[key]);
const exactHeaders = (headers) => {
  const result = {};
  for (const [name, raw] of Object.entries(headers)) {
    const value = Array.isArray(raw) ? raw.join(",") : raw;
    if (typeof value !== "string" || value.length > 1024)
      throw new ControllerFailure("engine-response-invalid", "uncertain");
    result[name.toLowerCase()] = value;
  }
  return Object.freeze(result);
};
const containerIdPattern = "[0-9a-f]{64}";
const containerNamePattern = "agentscope-pty-runtime-proof-[0-9a-f]{32}";
const exactListPath = `${api}/containers/json?all=1&filters=${encoded(
  JSON.stringify({ name: ["^/agentscope-pty-runtime-proof-"] }),
)}`;
const validEngineRoute = (method, path) =>
  (method === "POST" &&
    path ===
      `${api}/images/create?fromImage=node&tag=${encoded(imageManifest)}&platform=linux%2Famd64`) ||
  (method === "GET" && path === `${api}/images/${encoded(imageId)}/json`) ||
  (method === "GET" && path === exactListPath) ||
  (method === "POST" &&
    new RegExp(
      `^${api}/containers/create\\?name=${containerNamePattern}&platform=linux%2Famd64$`,
      "u",
    ).test(path)) ||
  (method === "POST" &&
    new RegExp(`^${api}/containers/${containerIdPattern}/start$`, "u").test(
      path,
    )) ||
  (method === "POST" &&
    new RegExp(
      `^${api}/containers/${containerIdPattern}/wait\\?condition=not-running$`,
      "u",
    ).test(path)) ||
  (method === "GET" &&
    new RegExp(
      `^${api}/containers/${containerIdPattern}/logs\\?stdout=1&stderr=1$`,
      "u",
    ).test(path)) ||
  (method === "GET" &&
    new RegExp(`^${api}/containers/${containerIdPattern}/json$`, "u").test(
      path,
    )) ||
  (method === "DELETE" &&
    new RegExp(
      `^${api}/containers/${containerIdPattern}\\?force=1&v=0$`,
      "u",
    ).test(path));
const validExpectedStatus = (method, path, expected) => {
  if (!Array.isArray(expected) || expected.length !== 1) return false;
  if (
    method === "GET" &&
    new RegExp(`^${api}/containers/${containerIdPattern}/json$`, "u").test(path)
  )
    return [200, 404].includes(expected[0]);
  const required =
    method === "POST" && path.includes("/containers/create?")
      ? 201
      : (method === "POST" && path.endsWith("/start")) || method === "DELETE"
        ? 204
        : 200;
  return expected[0] === required;
};
const isMutationRoute = (method, path) =>
  method === "DELETE" ||
  (method === "POST" &&
    (path.includes("/images/create?") ||
      path.includes("/containers/create?") ||
      path.endsWith("/start")));

/* eslint-disable max-lines-per-function -- The client keeps one request, uncertainty latch, socket identity, and deadline in a single closure. */
export const createEngineClient = ({
  absoluteDeadline,
  socketPath = dockerSocket,
  requestFactory = httpRequest,
  socketOwner = 0n,
}) => {
  let socketIdentity;
  let uncertain = false;
  let activeRequest;
  const interrupt = () => {
    uncertain = true;
    activeRequest?.destroy();
  };
  const request = ({
    body,
    cleanup = false,
    expected,
    method,
    path,
    maximumBytes = maximumBodyBytes,
    mutation = false,
  }) =>
    new Promise((resolveRequest, rejectRequest) => {
      if (
        uncertain ||
        !["GET", "POST", "DELETE"].includes(method) ||
        typeof path !== "string" ||
        !validEngineRoute(method, path) ||
        !validExpectedStatus(method, path, expected) ||
        mutation !== isMutationRoute(method, path) ||
        path.includes("\0") ||
        path.includes("/containers/create?") !== Buffer.isBuffer(body) ||
        (body !== undefined &&
          (!Buffer.isBuffer(body) || body.length > maximumRequestBytes))
      ) {
        rejectRequest(
          new ControllerFailure("engine-request-invalid", "uncertain"),
        );
        return;
      }
      const remaining = remainingMilliseconds(absoluteDeadline);
      const budget = cleanup
        ? remaining
        : remaining - teardownReserveMilliseconds;
      if (budget < 1) {
        uncertain = true;
        rejectRequest(new ControllerFailure("engine-timeout", "uncertain"));
        return;
      }
      try {
        const currentSocket = socketRecord(socketPath, socketOwner);
        if (
          socketIdentity !== undefined &&
          !sameSocket(socketIdentity, currentSocket)
        )
          throw new ControllerFailure(
            "socket-identity-substituted",
            "uncertain",
          );
        socketIdentity ??= currentSocket;
      } catch (error) {
        uncertain = true;
        rejectRequest(
          error instanceof ControllerFailure
            ? error
            : new ControllerFailure("socket-identity-invalid", "uncertain"),
        );
        return;
      }
      let settled = false;
      let ended = false;
      let bytes = 0;
      const chunks = [];
      let responseValue;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        activeRequest = undefined;
        if (error !== undefined) {
          if (mutation) uncertain = true;
          rejectRequest(error);
        } else resolveRequest(value);
      };
      const fail = (code) => {
        uncertain = true;
        activeRequest?.destroy();
        finish(new ControllerFailure(code, "uncertain"));
      };
      const timer = setTimeout(() => fail("engine-timeout"), budget);
      try {
        activeRequest = requestFactory(
          {
            agent: false,
            headers: {
              Accept: "application/json",
              "Content-Length": body?.length ?? 0,
              ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            },
            maxHeaderSize: 8 * 1024,
            method,
            path,
            socketPath,
          },
          (response) => {
            response.on("data", (chunk) => {
              bytes += chunk.length;
              if (bytes > maximumBytes) {
                chunks.length = 0;
                fail("engine-response-oversize");
              } else chunks.push(chunk);
            });
            response.once("error", () => fail("engine-response-error"));
            response.once("aborted", () => fail("engine-response-truncated"));
            response.once("end", () => {
              ended = true;
              try {
                if (
                  !sameSocket(
                    socketIdentity,
                    socketRecord(socketPath, socketOwner),
                  )
                )
                  throw new ControllerFailure(
                    "socket-identity-substituted",
                    "uncertain",
                  );
                responseValue = Object.freeze({
                  body: Buffer.concat(chunks),
                  headers: exactHeaders(response.headers),
                  status: response.statusCode ?? 0,
                });
              } catch (error) {
                fail(
                  error instanceof ControllerFailure
                    ? error.code
                    : "socket-identity-invalid",
                );
              }
            });
          },
        );
      } catch {
        fail("engine-connect-failed");
        return;
      }
      activeRequest.once("error", () => fail("engine-transport-error"));
      activeRequest.once("close", () => {
        if (!ended || responseValue === undefined) {
          fail("engine-response-truncated");
          return;
        }
        if (!expected.includes(responseValue.status)) {
          finish(
            new ControllerFailure(
              "engine-status-invalid",
              mutation ? "uncertain" : "failure",
            ),
          );
          return;
        }
        finish(undefined, responseValue);
      });
      if (body !== undefined) activeRequest.write(body);
      activeRequest.end();
    });
  return Object.freeze({ interrupt, request, uncertain: () => uncertain });
};
/* eslint-enable max-lines-per-function */

const exactContainerId = (value) => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))
    throw new ControllerFailure("container-identity-invalid");
  return value;
};
const exactArray = (body, code) => {
  const value = parseJson(body, code);
  if (!Array.isArray(value)) throw new ControllerFailure(code);
  return value;
};
/* eslint-disable max-lines-per-function -- One object owns the exact Engine lifecycle and uncertainty latch. */
export const createProductionOperations = ({
  absoluteDeadline,
  repositoryRoot = repositoryPath,
  socketOwner = 0n,
  socketPath = dockerSocket,
}) => {
  const engine = createEngineClient({
    absoluteDeadline,
    socketOwner,
    socketPath,
  });
  let containerId;
  let containerName;
  let createAttempted = false;
  let signalLatch = () => false;
  const call = (request) => engine.request(request);
  const jsonCall = async (request, code) => {
    const response = await call(request);
    try {
      return parseJson(response.body, code);
    } catch (error) {
      if (request.mutation) engine.interrupt();
      throw error;
    }
  };
  const installSignalHandlers = (latch) => {
    signalLatch = latch;
    const handler = (signal) => {
      if (signalLatch(signal)) engine.interrupt();
    };
    const interrupt = () => handler("SIGINT");
    const terminate = () => handler("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    return () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
  };
  const inspectContainer = async (id) => {
    const value = await jsonCall(
      { expected: [200], method: "GET", path: `${api}/containers/${id}/json` },
      "container-inspect-invalid",
    );
    if (!exactObject(value))
      throw new ControllerFailure("container-inspect-invalid");
    return value;
  };
  const exactOwnedContainer = (value, id) =>
    value.Id === id &&
    value.Name === `/${containerName}` &&
    value.Image === imageId &&
    exactObject(value.HostConfig) &&
    value.HostConfig.NetworkMode === "none" &&
    value.HostConfig.ReadonlyRootfs === true;
  return {
    installSignalHandlers,
    async setup() {},
    async inputIdentity() {
      if (process.cwd() !== repositoryRoot)
        throw new ControllerFailure("repository-identity-invalid");
      const existing = exactArray(
        (
          await call({
            expected: [200],
            method: "GET",
            path: exactListPath,
          })
        ).body,
        "container-list-invalid",
      );
      if (existing.length !== 0)
        throw new ControllerFailure("preexisting-container");
    },
    async imageIdentity() {
      const pull = await call({
        expected: [200],
        method: "POST",
        mutation: true,
        path: `${api}/images/create?fromImage=${encoded(imageRepository)}&tag=${encoded(imageManifest)}&platform=linux%2Famd64`,
      });
      const lines = decoder.decode(pull.body).trimEnd().split("\n");
      if (lines.length === 0 || lines.length > 4096) {
        engine.interrupt();
        throw new ControllerFailure("image-pull-invalid", "uncertain");
      }
      let digestAuthenticated = false;
      let terminalAuthenticated = false;
      for (const line of lines) {
        let value;
        try {
          value = parseJson(Buffer.from(line), "image-pull-invalid");
        } catch (error) {
          engine.interrupt();
          throw error;
        }
        if (
          !exactObject(value) ||
          Object.keys(value).some(
            (key) =>
              !["id", "progress", "progressDetail", "status"].includes(key),
          ) ||
          typeof value.status !== "string" ||
          value.status.length > 512 ||
          (value.id !== undefined && typeof value.id !== "string") ||
          (value.progress !== undefined &&
            typeof value.progress !== "string") ||
          (value.progressDetail !== undefined &&
            !exactObject(value.progressDetail))
        ) {
          engine.interrupt();
          throw new ControllerFailure("image-pull-invalid", "uncertain");
        }
        if (value.status === `Digest: ${imageManifest}`)
          digestAuthenticated = true;
        if (
          [
            `Status: Downloaded newer image for ${image}`,
            `Status: Image is up to date for ${image}`,
          ].includes(value.status)
        )
          terminalAuthenticated = true;
      }
      if (
        lines.length === 0 ||
        lines.length > 4096 ||
        !digestAuthenticated ||
        !terminalAuthenticated ||
        !pull.body.subarray(-1).equals(Buffer.from("\n"))
      ) {
        engine.interrupt();
        throw new ControllerFailure("image-pull-invalid", "uncertain");
      }
      const value = await jsonCall(
        {
          expected: [200],
          method: "GET",
          path: `${api}/images/${encoded(imageId)}/json`,
        },
        "image-inspect-invalid",
      );
      if (
        !exactObject(value) ||
        value.Id !== imageId ||
        value.Os !== "linux" ||
        value.Architecture !== "amd64"
      )
        throw new ControllerFailure("image-identity-invalid");
    },
    async create() {
      containerName = `agentscope-pty-runtime-proof-${randomBytes(16).toString("hex")}`;
      const body = Buffer.from(
        JSON.stringify({
          AttachStderr: true,
          AttachStdout: true,
          Cmd: [
            "/usr/local/bin/node",
            "/workspace/packages/testkit/scripts/verify-pty-runtime.mjs",
            "--runtime-proof",
          ],
          HostConfig: {
            Binds: [
              `${repositoryRoot}/packages/testkit/pty-runtime/node127-linux-x64-musl/pty.node:/runtime/production.node:ro`,
              `${repositoryRoot}/packages/testkit/fixtures/pty-runtime-faults/node127-linux-x64-musl/pty.node:/runtime/faults.node:ro`,
              `${repositoryRoot}:/workspace:ro`,
            ],
            NetworkMode: "none",
            ReadonlyRootfs: true,
            Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,mode=0700,size=16m" },
          },
          Image: imageId,
          OpenStdin: false,
          StdinOnce: false,
          Tty: false,
        }),
      );
      createAttempted = true;
      const value = await jsonCall(
        {
          body,
          expected: [201],
          method: "POST",
          mutation: true,
          path: `${api}/containers/create?name=${encoded(containerName)}&platform=linux%2Famd64`,
        },
        "container-create-invalid",
      );
      if (
        !exactObject(value) ||
        Object.keys(value).sort().join(",") !== "Id,Warnings" ||
        !Array.isArray(value.Warnings) ||
        value.Warnings.length !== 0
      ) {
        engine.interrupt();
        throw new ControllerFailure("container-create-invalid", "uncertain");
      }
      try {
        containerId = exactContainerId(value.Id);
      } catch (error) {
        engine.interrupt();
        throw error;
      }
      const authority = await inspectContainer(containerId);
      if (!exactOwnedContainer(authority, containerId))
        throw new ControllerFailure("container-authority-invalid", "uncertain");
    },
    async runtimeReceipt() {
      await call({
        expected: [204],
        method: "POST",
        mutation: true,
        path: `${api}/containers/${containerId}/start`,
      });
      const terminal = await jsonCall(
        {
          expected: [200],
          method: "POST",
          path: `${api}/containers/${containerId}/wait?condition=not-running`,
        },
        "container-wait-invalid",
      );
      if (
        !exactObject(terminal) ||
        terminal.StatusCode !== 0 ||
        ![null, undefined].includes(terminal.Error)
      )
        throw new ControllerFailure("container-wait-invalid");
      const logs = (
        await call({
          expected: [200],
          maximumBytes: innerReceipt.length + 8,
          method: "GET",
          path: `${api}/containers/${containerId}/logs?stdout=1&stderr=1`,
        })
      ).body;
      if (
        logs.length !== innerReceipt.length + 8 ||
        logs[0] !== 1 ||
        !logs.subarray(1, 4).equals(Buffer.alloc(3)) ||
        logs.readUInt32BE(4) !== innerReceipt.length ||
        createHash("sha256").update(logs.subarray(8)).digest("hex") !==
          innerReceiptDigest ||
        !logs.subarray(8).equals(innerReceipt)
      )
        throw new ControllerFailure("runtime-receipt-invalid");
    },
    async terminalJoin() {
      const value = await inspectContainer(containerId);
      if (
        !exactOwnedContainer(value, containerId) ||
        !exactObject(value.State) ||
        value.State.Status !== "exited" ||
        value.State.ExitCode !== 0 ||
        value.State.Running !== false ||
        value.State.Pid !== 0
      )
        throw new ControllerFailure("terminal-join-invalid");
    },
    async finalAssertion() {},
    async cleanup() {
      if (engine.uncertain()) return false;
      if (!createAttempted) return true;
      if (containerId === undefined) return false;
      try {
        const authority = await inspectContainer(containerId);
        if (!exactOwnedContainer(authority, containerId)) return false;
        await call({
          cleanup: true,
          expected: [204],
          method: "DELETE",
          mutation: true,
          path: `${api}/containers/${containerId}?force=1&v=0`,
        });
        const absent = await call({
          cleanup: true,
          expected: [404],
          method: "GET",
          path: `${api}/containers/${containerId}/json`,
        });
        const error = parseJson(absent.body, "container-absence-invalid");
        return (
          exactObject(error) &&
          Object.keys(error).join(",") === "message" &&
          error.message === `No such container: ${containerId}` &&
          remainingMilliseconds(absoluteDeadline) > 0
        );
      } catch {
        return false;
      }
    },
  };
};
/* eslint-enable max-lines-per-function */

export const executeController = async ({
  absoluteDeadline = performance.now() + totalMilliseconds,
  operations = createProductionOperations({ absoluteDeadline }),
} = {}) => {
  let stage = "setup";
  let originalOutcome = "success";
  let runtimeReceiptAuthenticated = false;
  let failureStage;
  let signal = null;
  let cleanupProved;
  let settled = false;
  const latchSignal = (value) => {
    if (settled || signal !== null) return false;
    signal = value === "SIGINT" ? "SIGINT" : "SIGTERM";
    originalOutcome = "signal";
    return true;
  };
  const uninstall =
    operations.installSignalHandlers?.(latchSignal) ?? (() => {});
  try {
    for (const [nextStage, action] of [
      ["setup", "setup"],
      ["input-identity", "inputIdentity"],
      ["image-identity", "imageIdentity"],
      ["create", "create"],
      ["runtime-receipt", "runtimeReceipt"],
      ["terminal-join", "terminalJoin"],
      ["final-assertion", "finalAssertion"],
    ]) {
      stage = nextStage;
      if (signal !== null) throw new ControllerFailure("signal", "signal");
      if (remainingMilliseconds(absoluteDeadline) === 0)
        throw new ControllerFailure("deadline", "timeout");
      await operations[action]();
      if (nextStage === "runtime-receipt") runtimeReceiptAuthenticated = true;
    }
  } catch (error) {
    failureStage = stage;
    if (originalOutcome !== "signal")
      originalOutcome =
        error instanceof ControllerFailure ? error.outcome : "failure";
  } finally {
    try {
      cleanupProved = (await operations.cleanup()) === true;
    } catch {
      cleanupProved = false;
    }
    if (!cleanupProved && originalOutcome === "success")
      originalOutcome = "uncertain";
    stage = cleanupProved
      ? originalOutcome === "success"
        ? "final-assertion"
        : (failureStage ?? "cleanup")
      : "cleanup";
    settled = true;
    uninstall();
  }
  const status =
    originalOutcome === "success" &&
    runtimeReceiptAuthenticated &&
    cleanupProved === true
      ? "passed"
      : "failed";
  return Object.freeze({
    exitCode:
      originalOutcome === "signal"
        ? signal === "SIGINT"
          ? 130
          : 143
        : status === "passed"
          ? 0
          : 1,
    receipt: Object.freeze({
      version: 1,
      stage,
      status,
      runtimeReceiptAuthenticated,
      cleanupProved: cleanupProved === true,
      originalOutcome,
      signal,
    }),
  });
};

const main = async () => {
  let terminalSignal = null;
  const latch = (signal) => {
    terminalSignal ??= signal;
  };
  const interrupt = () => latch("SIGINT");
  const terminate = () => latch("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let result = await executeController();
  if (terminalSignal !== null && result.exitCode === 0) {
    result = {
      exitCode: terminalSignal === "SIGINT" ? 130 : 143,
      receipt: {
        ...result.receipt,
        originalOutcome: "signal",
        signal: terminalSignal,
        status: "failed",
      },
    };
  }
  writeSync(1, Buffer.from(`${JSON.stringify(result.receipt)}\n`));
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  process.exitCode = result.exitCode;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
