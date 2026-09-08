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
const lifecycleStages = Object.freeze([
  "setup",
  "input-identity",
  "image-identity",
  "create",
  "runtime-receipt",
  "terminal-join",
  "final-assertion",
  "cleanup",
]);
const controllerErrorCodes = new Set([
  "cleanup-unproved",
  "container-absence-invalid",
  "container-authority-invalid",
  "container-create-invalid",
  "container-identity-invalid",
  "container-inspect-invalid",
  "container-list-invalid",
  "container-wait-invalid",
  "deadline",
  "engine-connect-failed",
  "engine-request-invalid",
  "engine-response-error",
  "engine-response-invalid",
  "engine-response-oversize",
  "engine-response-truncated",
  "engine-status-invalid",
  "engine-timeout",
  "engine-transport-error",
  "image-identity-invalid",
  "image-inspect-invalid",
  "image-pull-invalid",
  "preexisting-container",
  "repository-identity-invalid",
  "runtime-receipt-invalid",
  "signal",
  "socket-identity-invalid",
  "socket-identity-substituted",
  "terminal-join-invalid",
  "unexpected-failure",
]);

class ControllerFailure extends Error {
  constructor(code, outcome = "failure") {
    super(code);
    this.code = code;
    this.outcome = outcome;
  }
}
const controllerFailureCode = (error, fallback) =>
  error instanceof ControllerFailure ? error.code : fallback;

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
        uncertain = true;
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
      if (request.mutation) {
        engine.interrupt();
        throw new ControllerFailure(
          controllerFailureCode(error, code),
          "uncertain",
        );
      }
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
      let pullText;
      try {
        pullText = decoder.decode(pull.body);
      } catch {
        engine.interrupt();
        throw new ControllerFailure("image-pull-invalid", "uncertain");
      }
      if (!pullText.endsWith("\n") || pullText.includes("\r")) {
        engine.interrupt();
        throw new ControllerFailure("image-pull-invalid", "uncertain");
      }
      const lines = pullText.slice(0, -1).split("\n");
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
          throw new ControllerFailure(
            controllerFailureCode(error, "image-pull-invalid"),
            "uncertain",
          );
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
            (!exactObject(value.progressDetail) ||
              Object.keys(value.progressDetail).some(
                (key) => !["current", "total"].includes(key),
              ) ||
              Object.values(value.progressDetail).some(
                (number) => !Number.isSafeInteger(number) || number < 0,
              )))
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
        !terminalAuthenticated
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
      if (!exactOwnedContainer(authority, containerId)) {
        engine.interrupt();
        throw new ControllerFailure("container-authority-invalid", "uncertain");
      }
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
  let errorCode = null;
  let signal = null;
  let cleanupProved;
  let settled = false;
  const latchSignal = (value) => {
    if (settled || signal !== null) return false;
    signal = value === "SIGINT" ? "SIGINT" : "SIGTERM";
    if (failureStage === undefined && originalOutcome === "success")
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
    if (originalOutcome === "signal") errorCode = "signal";
    else {
      originalOutcome =
        error instanceof ControllerFailure ? error.outcome : "failure";
      errorCode =
        error instanceof ControllerFailure &&
        controllerErrorCodes.has(error.code)
          ? error.code
          : "unexpected-failure";
    }
  } finally {
    try {
      cleanupProved = (await operations.cleanup()) === true;
    } catch {
      cleanupProved = false;
    }
    if (signal !== null) cleanupProved = false;
    if (signal !== null && originalOutcome === "success") {
      originalOutcome = "signal";
      errorCode = "signal";
      failureStage ??= "cleanup";
    } else if (!cleanupProved && originalOutcome === "success") {
      originalOutcome = "uncertain";
      errorCode = "cleanup-unproved";
      failureStage = "cleanup";
    }
    stage =
      originalOutcome === "success"
        ? "final-assertion"
        : (failureStage ?? "cleanup");
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
      errorCode,
      runtimeReceiptAuthenticated,
      cleanupProved: cleanupProved === true,
      originalOutcome,
      signal,
    }),
  });
};

const nextTurn = () => new Promise((resolveTurn) => setImmediate(resolveTurn));
const signalExit = (signal) => (signal === "SIGINT" ? 130 : 143);
const engineStages = Object.freeze([
  "input-identity",
  "image-identity",
  "create",
  "runtime-receipt",
  "terminal-join",
]);
const receiptErrorAuthorities = Object.freeze({
  "cleanup-unproved": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["cleanup"],
  }),
  "container-authority-invalid": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["create"],
  }),
  "container-create-invalid": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["create"],
  }),
  "container-identity-invalid": Object.freeze({
    outcomes: ["failure"],
    stages: ["create"],
  }),
  "container-inspect-invalid": Object.freeze({
    outcomes: ["failure"],
    stages: ["create", "terminal-join"],
  }),
  "container-list-invalid": Object.freeze({
    outcomes: ["failure"],
    stages: ["input-identity"],
  }),
  "container-wait-invalid": Object.freeze({
    outcomes: ["failure"],
    stages: ["runtime-receipt"],
  }),
  deadline: Object.freeze({
    outcomes: ["timeout"],
    stages: lifecycleStages.filter((stage) => stage !== "cleanup"),
  }),
  "engine-connect-failed": Object.freeze({
    outcomes: ["uncertain"],
    stages: engineStages,
  }),
  "engine-request-invalid": Object.freeze({
    outcomes: ["uncertain"],
    stages: engineStages,
  }),
  "engine-response-error": Object.freeze({
    outcomes: ["uncertain"],
    stages: engineStages,
  }),
  "engine-response-invalid": Object.freeze({
    outcomes: ["uncertain"],
    stages: engineStages,
  }),
  "engine-response-oversize": Object.freeze({
    outcomes: ["uncertain"],
    stages: engineStages,
  }),
  "engine-response-truncated": Object.freeze({
    outcomes: ["uncertain"],
    stages: engineStages,
  }),
  "engine-status-invalid": Object.freeze({
    tuples: Object.freeze([
      ["input-identity", "failure"],
      ["image-identity", "failure"],
      ["image-identity", "uncertain"],
      ["create", "failure"],
      ["create", "uncertain"],
      ["runtime-receipt", "failure"],
      ["runtime-receipt", "uncertain"],
      ["terminal-join", "failure"],
    ]),
  }),
  "engine-timeout": Object.freeze({
    outcomes: ["uncertain"],
    stages: engineStages,
  }),
  "engine-transport-error": Object.freeze({
    outcomes: ["uncertain"],
    stages: engineStages,
  }),
  "image-identity-invalid": Object.freeze({
    outcomes: ["failure"],
    stages: ["image-identity"],
  }),
  "image-inspect-invalid": Object.freeze({
    outcomes: ["failure"],
    stages: ["image-identity"],
  }),
  "image-pull-invalid": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["image-identity"],
  }),
  "preexisting-container": Object.freeze({
    outcomes: ["failure"],
    stages: ["input-identity"],
  }),
  "repository-identity-invalid": Object.freeze({
    outcomes: ["failure"],
    stages: ["input-identity"],
  }),
  "runtime-receipt-invalid": Object.freeze({
    outcomes: ["failure"],
    stages: ["runtime-receipt"],
  }),
  signal: Object.freeze({
    outcomes: ["signal"],
    stages: lifecycleStages,
  }),
  "socket-identity-invalid": Object.freeze({
    outcomes: ["uncertain"],
    stages: engineStages,
  }),
  "socket-identity-substituted": Object.freeze({
    outcomes: ["uncertain"],
    stages: engineStages,
  }),
  "terminal-join-invalid": Object.freeze({
    outcomes: ["failure"],
    stages: ["terminal-join"],
  }),
  "unexpected-failure": Object.freeze({
    outcomes: ["failure"],
    stages: lifecycleStages.filter((stage) => stage !== "cleanup"),
  }),
});
const validReceiptEnvelope = (receipt) =>
  exactObject(receipt) &&
  Object.keys(receipt).sort().join(",") ===
    "cleanupProved,errorCode,originalOutcome,runtimeReceiptAuthenticated,signal,stage,status,version" &&
  receipt.version === 1 &&
  lifecycleStages.includes(receipt.stage) &&
  ["passed", "failed"].includes(receipt.status) &&
  typeof receipt.runtimeReceiptAuthenticated === "boolean" &&
  typeof receipt.cleanupProved === "boolean" &&
  ["success", "failure", "uncertain", "timeout", "signal"].includes(
    receipt.originalOutcome,
  ) &&
  [null, "SIGINT", "SIGTERM"].includes(receipt.signal) &&
  (receipt.errorCode === null ||
    (typeof receipt.errorCode === "string" &&
      controllerErrorCodes.has(receipt.errorCode)));
const isSuccessReceipt = (receipt) =>
  receipt?.status === "passed" &&
  receipt?.stage === "final-assertion" &&
  receipt?.originalOutcome === "success" &&
  receipt?.errorCode === null &&
  receipt?.signal === null &&
  receipt?.runtimeReceiptAuthenticated === true &&
  receipt?.cleanupProved === true;
const isCausalFailureReceipt = (receipt) => {
  const authority = receiptErrorAuthorities[receipt?.errorCode];
  const tupleAdmitted = authority?.tuples?.some(
    ([stage, outcome]) =>
      stage === receipt?.stage && outcome === receipt?.originalOutcome,
  );
  const productAdmitted =
    authority?.stages?.includes(receipt?.stage) &&
    authority?.outcomes?.includes(receipt?.originalOutcome);
  return (
    receipt?.status === "failed" &&
    authority !== undefined &&
    (tupleAdmitted === true || productAdmitted === true) &&
    cleanupEvidenceMatches(receipt) &&
    (receipt.errorCode !== "cleanup-unproved" ||
      receipt.cleanupProved === false) &&
    (receipt.errorCode !== "signal" ||
      ["SIGINT", "SIGTERM"].includes(receipt.signal))
  );
};
const cleanupFalseErrorCodes = new Set([
  "container-authority-invalid",
  "container-create-invalid",
  "container-identity-invalid",
  "engine-connect-failed",
  "engine-request-invalid",
  "engine-response-error",
  "engine-response-invalid",
  "engine-response-oversize",
  "engine-response-truncated",
  "engine-timeout",
  "engine-transport-error",
  "image-pull-invalid",
  "socket-identity-invalid",
  "socket-identity-substituted",
]);
const cleanupTrueErrorCodes = new Set([
  "container-list-invalid",
  "image-identity-invalid",
  "image-inspect-invalid",
  "preexisting-container",
  "repository-identity-invalid",
]);
const preCreateStages = new Set([
  "setup",
  "input-identity",
  "image-identity",
  "create",
]);
function cleanupEvidenceMatches(receipt) {
  if (
    receipt.signal !== null &&
    receipt.errorCode !== "signal" &&
    receipt.cleanupProved
  )
    return false;
  if (receipt.errorCode === "cleanup-unproved")
    return receipt.cleanupProved === false && receipt.signal === null;
  if (receipt.errorCode === "signal")
    return !receipt.cleanupProved || receipt.stage === "final-assertion";
  if (cleanupFalseErrorCodes.has(receipt.errorCode))
    return receipt.cleanupProved === false;
  if (cleanupTrueErrorCodes.has(receipt.errorCode))
    return receipt.cleanupProved === true;
  if (receipt.errorCode === "engine-status-invalid") {
    if (receipt.originalOutcome === "uncertain")
      return receipt.cleanupProved === false;
    if (["input-identity", "image-identity"].includes(receipt.stage))
      return receipt.cleanupProved === true;
  }
  if (
    ["deadline", "unexpected-failure"].includes(receipt.errorCode) &&
    preCreateStages.has(receipt.stage)
  )
    return receipt.cleanupProved === true;
  return true;
}
export const validateTerminalReceipt = (receipt) => {
  const stageHasRuntimeReceipt = [
    "terminal-join",
    "final-assertion",
    "cleanup",
  ].includes(receipt?.stage);
  if (
    !validReceiptEnvelope(receipt) ||
    stageHasRuntimeReceipt !== receipt.runtimeReceiptAuthenticated ||
    !(isSuccessReceipt(receipt) || isCausalFailureReceipt(receipt))
  )
    throw new ControllerFailure("unexpected-failure");
  return receipt;
};
export const parseTerminalReceipt = (bytes) => {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 2048)
    throw new ControllerFailure("unexpected-failure");
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new ControllerFailure("unexpected-failure");
  }
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n"))
    throw new ControllerFailure("unexpected-failure");
  const body = text.slice(0, -1);
  try {
    const receipt = JSON.parse(body);
    if (body !== JSON.stringify(receipt))
      throw new ControllerFailure("unexpected-failure");
    return validateTerminalReceipt(receipt);
  } catch {
    throw new ControllerFailure("unexpected-failure");
  }
};
export const publishTerminalResult = async (
  result,
  {
    getSignal,
    writeReceipt = (receipt) =>
      writeSync(1, Buffer.from(`${JSON.stringify(receipt)}\n`)),
  },
) => {
  await nextTurn();
  const beforePublication = getSignal();
  let published =
    beforePublication === null || result.exitCode !== 0
      ? result
      : {
          exitCode: signalExit(beforePublication),
          receipt: {
            ...result.receipt,
            errorCode: "signal",
            originalOutcome: "signal",
            signal: beforePublication,
            status: "failed",
          },
        };
  validateTerminalReceipt(published.receipt);
  process.exitCode = published.exitCode;
  writeReceipt(published.receipt);
  await nextTurn();
  const afterPublication = getSignal();
  if (afterPublication !== null && published.exitCode === 0) {
    process.exitCode = signalExit(afterPublication);
    published = { ...published, exitCode: process.exitCode };
  }
  await nextTurn();
  return published;
};

const main = async () => {
  let terminalSignal = null;
  let publicationActive = false;
  const latch = (signal) => {
    terminalSignal ??= signal;
    if (publicationActive) process.exitCode = signalExit(terminalSignal);
  };
  const interrupt = () => latch("SIGINT");
  const terminate = () => latch("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const result = await executeController();
  publicationActive = true;
  await publishTerminalResult(result, {
    getSignal: () => terminalSignal,
  });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
