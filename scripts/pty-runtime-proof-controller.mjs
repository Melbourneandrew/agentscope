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
  "image-pull-count-invalid",
  "image-pull-daemon-error",
  "image-pull-digest-duplicate",
  "image-pull-digest-mismatch",
  "image-pull-digest-missing",
  "image-pull-encoding-invalid",
  "image-pull-framing-invalid",
  "image-pull-json-duplicate-key",
  "image-pull-json-invalid",
  "image-pull-record-shape-invalid",
  "image-pull-order-invalid",
  "image-pull-terminal-duplicate",
  "image-pull-terminal-mismatch",
  "image-pull-terminal-missing",
  "image-pull-trailing-record",
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
const assertClosedJsonGrammar = (text, code, duplicateCode = code) => {
  let cursor = 0;
  const skipWhitespace = () => {
    while (/[\t\n\r ]/u.test(text[cursor] ?? "")) cursor += 1;
  };
  const readString = () => {
    const start = cursor;
    if (text[cursor++] !== '"') throw new ControllerFailure(code);
    while (cursor < text.length) {
      const character = text[cursor++];
      if (character === '"') {
        try {
          return JSON.parse(text.slice(start, cursor));
        } catch {
          throw new ControllerFailure(code);
        }
      }
      if (character === "\\") cursor += 1;
      else if (character.charCodeAt(0) < 0x20)
        throw new ControllerFailure(code);
    }
    throw new ControllerFailure(code);
  };
  const readValue = (depth = 0) => {
    if (depth > 64) throw new ControllerFailure(code);
    skipWhitespace();
    if (text[cursor] === '"') {
      readString();
      return;
    }
    if (text[cursor] === "{") {
      cursor += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[cursor] === "}") {
        cursor += 1;
        return;
      }
      for (;;) {
        const key = readString();
        if (keys.has(key)) throw new ControllerFailure(duplicateCode);
        keys.add(key);
        skipWhitespace();
        if (text[cursor++] !== ":") throw new ControllerFailure(code);
        readValue(depth + 1);
        skipWhitespace();
        const separator = text[cursor++];
        if (separator === "}") return;
        if (separator !== ",") throw new ControllerFailure(code);
        skipWhitespace();
      }
    }
    if (text[cursor] === "[") {
      cursor += 1;
      skipWhitespace();
      if (text[cursor] === "]") {
        cursor += 1;
        return;
      }
      for (;;) {
        readValue(depth + 1);
        skipWhitespace();
        const separator = text[cursor++];
        if (separator === "]") return;
        if (separator !== ",") throw new ControllerFailure(code);
      }
    }
    const remainder = text.slice(cursor);
    const token =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(
        remainder,
      )?.[0];
    if (token === undefined) throw new ControllerFailure(code);
    cursor += token.length;
  };
  readValue();
  skipWhitespace();
  if (cursor !== text.length) throw new ControllerFailure(code);
};
const parseJson = (body, code, duplicateCode = code) => {
  if (!Buffer.isBuffer(body) || body.length === 0)
    throw new ControllerFailure(code);
  try {
    const text = decoder.decode(body);
    assertClosedJsonGrammar(text, code, duplicateCode);
    return JSON.parse(text);
  } catch (error) {
    throw error instanceof ControllerFailure
      ? error
      : new ControllerFailure(code);
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
const assertPullRecordShape = (value) => {
  if (
    !exactObject(value) ||
    Object.keys(value).some(
      (key) => !["id", "progress", "progressDetail", "status"].includes(key),
    ) ||
    typeof value.status !== "string" ||
    value.status.length > 512 ||
    (value.id !== undefined && typeof value.id !== "string") ||
    (value.progress !== undefined && typeof value.progress !== "string") ||
    (value.progressDetail !== undefined &&
      (!exactObject(value.progressDetail) ||
        Object.keys(value.progressDetail).some(
          (key) => !["current", "total"].includes(key),
        ) ||
        Object.values(value.progressDetail).some(
          (number) => !Number.isSafeInteger(number) || number < 0,
        )))
  )
    throw new ControllerFailure("image-pull-record-shape-invalid");
};
export const parseImagePullReceipt = (body) => {
  let text;
  try {
    text = decoder.decode(body);
  } catch {
    throw new ControllerFailure("image-pull-encoding-invalid");
  }
  if (!text.endsWith("\n") || text.includes("\r"))
    throw new ControllerFailure("image-pull-framing-invalid");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.length > 4096)
    throw new ControllerFailure("image-pull-count-invalid");
  let digestAuthenticated = false;
  let terminalAuthenticated = false;
  let terminalIndex = -1;
  for (const [index, line] of lines.entries()) {
    const value = parseJson(
      Buffer.from(line),
      "image-pull-json-invalid",
      "image-pull-json-duplicate-key",
    );
    if (
      exactObject(value) &&
      (Object.hasOwn(value, "error") || Object.hasOwn(value, "errorDetail"))
    )
      throw new ControllerFailure("image-pull-daemon-error");
    assertPullRecordShape(value);
    if (value.status.startsWith("Digest: ")) {
      if (terminalAuthenticated)
        throw new ControllerFailure("image-pull-order-invalid");
      if (digestAuthenticated)
        throw new ControllerFailure("image-pull-digest-duplicate");
      if (value.status !== `Digest: ${imageManifest}`)
        throw new ControllerFailure("image-pull-digest-mismatch");
      digestAuthenticated = true;
    }
    if (
      value.status.startsWith("Status: Downloaded newer image for ") ||
      value.status.startsWith("Status: Image is up to date for ")
    ) {
      if (!digestAuthenticated)
        throw new ControllerFailure("image-pull-order-invalid");
      if (terminalAuthenticated)
        throw new ControllerFailure("image-pull-terminal-duplicate");
      if (
        ![
          `Status: Downloaded newer image for ${image}`,
          `Status: Image is up to date for ${image}`,
        ].includes(value.status)
      )
        throw new ControllerFailure("image-pull-terminal-mismatch");
      terminalAuthenticated = true;
      terminalIndex = index;
    }
  }
  if (!digestAuthenticated)
    throw new ControllerFailure("image-pull-digest-missing");
  if (!terminalAuthenticated)
    throw new ControllerFailure("image-pull-terminal-missing");
  if (terminalIndex !== lines.length - 1)
    throw new ControllerFailure("image-pull-trailing-record");
  return Object.freeze({ digestAuthenticated, terminalAuthenticated });
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
  const uncertainFailure = (code) => {
    engine.interrupt();
    throw new ControllerFailure(code, "uncertain");
  };
  const jsonCall = async (request, code, uncertainOnInvalid = false) => {
    try {
      const response = await call(request);
      return parseJson(response.body, code);
    } catch (error) {
      if (request.mutation || uncertainOnInvalid) {
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
    try {
      const value = await jsonCall(
        {
          expected: [200],
          method: "GET",
          path: `${api}/containers/${id}/json`,
        },
        "container-inspect-invalid",
      );
      if (!exactObject(value)) uncertainFailure("container-inspect-invalid");
      return value;
    } catch (error) {
      uncertainFailure(
        controllerFailureCode(error, "container-inspect-invalid"),
      );
    }
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
      try {
        parseImagePullReceipt(pull.body);
      } catch (error) {
        engine.interrupt();
        throw new ControllerFailure(
          controllerFailureCode(error, "image-pull-json-invalid"),
          "uncertain",
        );
      }
      const value = await jsonCall(
        {
          expected: [200],
          method: "GET",
          path: `${api}/images/${encoded(imageId)}/json`,
        },
        "image-inspect-invalid",
        true,
      );
      if (
        !exactObject(value) ||
        value.Id !== imageId ||
        value.Os !== "linux" ||
        value.Architecture !== "amd64"
      )
        uncertainFailure("image-identity-invalid");
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
        throw new ControllerFailure(
          controllerFailureCode(error, "container-identity-invalid"),
          "uncertain",
        );
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
        true,
      );
      if (
        !exactObject(terminal) ||
        terminal.StatusCode !== 0 ||
        ![null, undefined].includes(terminal.Error)
      )
        uncertainFailure("container-wait-invalid");
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
        uncertainFailure("terminal-join-invalid");
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
    outcomes: ["uncertain"],
    stages: ["create"],
  }),
  "container-inspect-invalid": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["create", "terminal-join"],
  }),
  "container-list-invalid": Object.freeze({
    outcomes: ["failure"],
    stages: ["input-identity"],
  }),
  "container-wait-invalid": Object.freeze({
    outcomes: ["uncertain"],
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
      ["image-identity", "uncertain"],
      ["create", "uncertain"],
      ["runtime-receipt", "uncertain"],
      ["terminal-join", "uncertain"],
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
    outcomes: ["uncertain"],
    stages: ["image-identity"],
  }),
  "image-inspect-invalid": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["image-identity"],
  }),
  "image-pull-count-invalid": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["image-identity"],
  }),
  "image-pull-daemon-error": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["image-identity"],
  }),
  "image-pull-digest-duplicate": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["image-identity"],
  }),
  "image-pull-digest-mismatch": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["image-identity"],
  }),
  "image-pull-digest-missing": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["image-identity"],
  }),
  "image-pull-encoding-invalid": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["image-identity"],
  }),
  "image-pull-framing-invalid": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["image-identity"],
  }),
  "image-pull-json-duplicate-key": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["image-identity"],
  }),
  "image-pull-json-invalid": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["image-identity"],
  }),
  "image-pull-record-shape-invalid": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["image-identity"],
  }),
  "image-pull-order-invalid": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["image-identity"],
  }),
  "image-pull-terminal-duplicate": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["image-identity"],
  }),
  "image-pull-terminal-mismatch": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["image-identity"],
  }),
  "image-pull-terminal-missing": Object.freeze({
    outcomes: ["uncertain"],
    stages: ["image-identity"],
  }),
  "image-pull-trailing-record": Object.freeze({
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
    outcomes: ["uncertain"],
    stages: ["terminal-join"],
  }),
  "unexpected-failure": Object.freeze({
    outcomes: ["failure"],
    stages: lifecycleStages.filter((stage) => stage !== "cleanup"),
  }),
});
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
  "image-pull-count-invalid",
  "image-pull-daemon-error",
  "image-pull-digest-duplicate",
  "image-pull-digest-mismatch",
  "image-pull-digest-missing",
  "image-pull-encoding-invalid",
  "image-pull-framing-invalid",
  "image-pull-json-duplicate-key",
  "image-pull-json-invalid",
  "image-pull-record-shape-invalid",
  "image-pull-order-invalid",
  "image-pull-terminal-duplicate",
  "image-pull-terminal-mismatch",
  "image-pull-terminal-missing",
  "image-pull-trailing-record",
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
const receiptKey = ({
  cleanupProved,
  errorCode,
  originalOutcome,
  signal,
  stage,
}) =>
  JSON.stringify([stage, errorCode, originalOutcome, cleanupProved, signal]);
const terminalReceiptTable = new Map();
const addTerminalReceipt = ({
  cleanupProved,
  errorCode,
  originalOutcome,
  signal,
  stage,
}) => {
  const receipt = Object.freeze({
    version: 1,
    stage,
    status: errorCode === null ? "passed" : "failed",
    errorCode,
    runtimeReceiptAuthenticated: [
      "terminal-join",
      "final-assertion",
      "cleanup",
    ].includes(stage),
    cleanupProved,
    originalOutcome,
    signal,
  });
  terminalReceiptTable.set(receiptKey(receipt), receipt);
};
const addSignalTerminalReceipts = ({ errorCode, originalOutcome, stage }) => {
  for (const signal of ["SIGINT", "SIGTERM"])
    for (const cleanupProved of stage === "final-assertion"
      ? [false, true]
      : [false])
      addTerminalReceipt({
        cleanupProved,
        errorCode,
        originalOutcome,
        signal,
        stage,
      });
};
addTerminalReceipt({
  cleanupProved: true,
  errorCode: null,
  originalOutcome: "success",
  signal: null,
  stage: "final-assertion",
});
for (const [errorCode, authority] of Object.entries(receiptErrorAuthorities)) {
  const tuples =
    authority.tuples ??
    authority.stages.flatMap((stage) =>
      authority.outcomes.map((outcome) => [stage, outcome]),
    );
  for (const [stage, originalOutcome] of tuples) {
    let cleanupStates = [true, false];
    if (
      errorCode === "cleanup-unproved" ||
      cleanupFalseErrorCodes.has(errorCode) ||
      originalOutcome === "uncertain"
    )
      cleanupStates = [false];
    else if (
      cleanupTrueErrorCodes.has(errorCode) ||
      (errorCode === "engine-status-invalid" && preCreateStages.has(stage))
    )
      cleanupStates = [true];
    if (errorCode === "signal") {
      addSignalTerminalReceipts({ errorCode, originalOutcome, stage });
      continue;
    }
    for (const cleanupProved of cleanupStates)
      addTerminalReceipt({
        cleanupProved,
        errorCode,
        originalOutcome,
        signal: null,
        stage,
      });
    if (errorCode !== "cleanup-unproved")
      for (const signal of ["SIGINT", "SIGTERM"])
        addTerminalReceipt({
          cleanupProved: false,
          errorCode,
          originalOutcome,
          signal,
          stage,
        });
  }
}
export const canonicalTerminalReceipts = Object.freeze([
  ...terminalReceiptTable.values(),
]);
export const createLifecycleState = () =>
  Object.freeze({
    cause: null,
    cleanupProved: null,
    phase: "running",
    runtimeReceiptAuthenticated: false,
    signal: null,
    stage: "setup",
  });
const canAuthenticateRuntime = (state) =>
  state.phase === "running" &&
  state.stage === "runtime-receipt" &&
  state.cause === null &&
  state.signal === null;
export const reduceLifecycleState = (state, event) => {
  if (!exactObject(state) || !exactObject(event) || state.phase === "terminal")
    throw new ControllerFailure("unexpected-failure");
  if (event.type === "enter") {
    const current = lifecycleStages.indexOf(state.stage);
    const next = lifecycleStages.indexOf(event.stage);
    if (
      state.phase !== "running" ||
      next < 0 ||
      next > lifecycleStages.length - 2 ||
      ![current, current + 1].includes(next)
    )
      throw new ControllerFailure("unexpected-failure");
    return Object.freeze({ ...state, stage: event.stage });
  }
  if (event.type === "runtime-authenticated") {
    if (!canAuthenticateRuntime(state))
      throw new ControllerFailure("unexpected-failure");
    return Object.freeze({ ...state, runtimeReceiptAuthenticated: true });
  }
  if (event.type === "failure") {
    if (
      state.phase !== "running" ||
      state.cause !== null ||
      !controllerErrorCodes.has(event.errorCode) ||
      !["failure", "uncertain", "timeout"].includes(event.originalOutcome)
    )
      throw new ControllerFailure("unexpected-failure");
    return Object.freeze({
      ...state,
      cause: Object.freeze({
        errorCode: event.errorCode,
        originalOutcome: event.originalOutcome,
        stage: state.stage,
      }),
    });
  }
  if (event.type === "signal") {
    if (!["SIGINT", "SIGTERM"].includes(event.signal))
      throw new ControllerFailure("unexpected-failure");
    if (state.signal !== null) return state;
    return Object.freeze({
      ...state,
      cause:
        state.cause ??
        Object.freeze({
          errorCode: "signal",
          originalOutcome: "signal",
          stage: state.phase === "cleanup" ? "cleanup" : state.stage,
        }),
      signal: event.signal,
    });
  }
  if (event.type === "begin-cleanup") {
    if (state.phase !== "running")
      throw new ControllerFailure("unexpected-failure");
    return Object.freeze({ ...state, phase: "cleanup" });
  }
  if (event.type === "finish-cleanup") {
    if (state.phase !== "cleanup" || typeof event.proved !== "boolean")
      throw new ControllerFailure("unexpected-failure");
    const cleanupProved = state.signal === null && event.proved;
    return Object.freeze({
      ...state,
      cause:
        state.cause ??
        (cleanupProved
          ? null
          : Object.freeze({
              errorCode: "cleanup-unproved",
              originalOutcome: "uncertain",
              stage: "cleanup",
            })),
      cleanupProved,
      phase: "terminal",
    });
  }
  throw new ControllerFailure("unexpected-failure");
};
export const serializeLifecycleState = (state) => {
  if (state.phase !== "terminal" || typeof state.cleanupProved !== "boolean")
    throw new ControllerFailure("unexpected-failure");
  const tuple =
    state.cause ??
    Object.freeze({
      errorCode: null,
      originalOutcome: "success",
      stage: "final-assertion",
    });
  const receipt = terminalReceiptTable.get(
    receiptKey({
      ...tuple,
      cleanupProved: state.cleanupProved,
      signal: state.signal,
    }),
  );
  if (
    receipt === undefined ||
    receipt.runtimeReceiptAuthenticated !== state.runtimeReceiptAuthenticated
  )
    throw new ControllerFailure("unexpected-failure");
  return receipt;
};
export const executeController = async ({
  absoluteDeadline = performance.now() + totalMilliseconds,
  operations = createProductionOperations({ absoluteDeadline }),
} = {}) => {
  let state = createLifecycleState();
  const latchSignal = (value) => {
    if (state.phase === "terminal" || state.signal !== null) return false;
    state = reduceLifecycleState(state, {
      signal: value === "SIGINT" ? "SIGINT" : "SIGTERM",
      type: "signal",
    });
    return true;
  };
  const uninstall =
    operations.installSignalHandlers?.(latchSignal) ?? (() => {});
  try {
    for (const [stage, action] of [
      ["setup", "setup"],
      ["input-identity", "inputIdentity"],
      ["image-identity", "imageIdentity"],
      ["create", "create"],
      ["runtime-receipt", "runtimeReceipt"],
      ["terminal-join", "terminalJoin"],
      ["final-assertion", "finalAssertion"],
    ]) {
      state = reduceLifecycleState(state, { stage, type: "enter" });
      if (state.signal !== null)
        throw new ControllerFailure("signal", "signal");
      if (remainingMilliseconds(absoluteDeadline) === 0)
        throw new ControllerFailure("deadline", "timeout");
      await operations[action]();
      if (state.signal !== null)
        throw new ControllerFailure("signal", "signal");
      if (stage === "runtime-receipt")
        state = reduceLifecycleState(state, { type: "runtime-authenticated" });
    }
  } catch (error) {
    if (state.cause === null)
      state = reduceLifecycleState(state, {
        errorCode:
          error instanceof ControllerFailure &&
          controllerErrorCodes.has(error.code)
            ? error.code
            : "unexpected-failure",
        originalOutcome:
          error instanceof ControllerFailure ? error.outcome : "failure",
        type: "failure",
      });
  } finally {
    state = reduceLifecycleState(state, { type: "begin-cleanup" });
    let proved = false;
    try {
      proved = (await operations.cleanup()) === true;
    } catch {
      // The initialized false value is the closed cleanup-uncertainty result.
    }
    state = reduceLifecycleState(state, { proved, type: "finish-cleanup" });
    uninstall();
  }
  const receipt = serializeLifecycleState(state);
  return Object.freeze({
    exitCode:
      receipt.originalOutcome === "signal"
        ? receipt.signal === "SIGINT"
          ? 130
          : 143
        : receipt.status === "passed"
          ? 0
          : 1,
    receipt,
  });
};

const nextTurn = () => new Promise((resolveTurn) => setImmediate(resolveTurn));
const signalExit = (signal) => (signal === "SIGINT" ? 130 : 143);
export const validateTerminalReceipt = (receipt) => {
  if (!exactObject(receipt)) throw new ControllerFailure("unexpected-failure");
  const canonical = terminalReceiptTable.get(receiptKey(receipt));
  if (
    canonical === undefined ||
    JSON.stringify(canonical) !== JSON.stringify(receipt)
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
