/** Controller client for the upstream REST/dashboard/callback boundary. No server. */
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { request } from "node:http";
export {
  projectMockServerRequests,
  assertMockServerFinalLedger,
  snapshotMockServerTraffic,
} from "./mockserver-final-ledger.mjs";

const maximumBytes = 1024 * 1024;
const failure = () => {
  throw new Error("integration.mockserver.control");
};
const runPattern = /^[a-f0-9]{16}$/u;
const ownedKeys = new WeakMap();
export const mockServerTrafficRow = (method, path, role, status, body = "") => {
  if (typeof body !== "string" && !Buffer.isBuffer(body)) failure();
  return Object.freeze({
    method,
    path,
    role,
    status,
    bodyBytes: Buffer.byteLength(body),
    bodySha256: createHash("sha256").update(body).digest("hex"),
  });
};
export const readMockServerBootClock = () => {
  const source = readFileSync("/proc/uptime", "utf8");
  if (source.length > 128 || !/^\d+(?:\.\d+)?\s/u.test(source))
    throw new Error("integration.fixture.service");
  const value = Number(source.split(/\s/u, 1)[0]) * 1000;
  if (!Number.isFinite(value) || value < 0)
    throw new Error("integration.fixture.service");
  return value;
};
export const createMockServerControlMaterial = (runId) => {
  if (!runPattern.test(runId ?? "")) failure();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: runId,
    alg: "RS256",
    use: "sig",
  };
  const result = Object.freeze({
    privateKey: Buffer.from(
      privateKey.export({ format: "pem", type: "pkcs8" }),
    ),
    jwks: Buffer.from(`${JSON.stringify({ keys: [jwk] })}\n`),
  });
  ownedKeys.set(result, { privateKey, runId });
  return result;
};
const token = (privateKey, runId, remaining) => {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "RS256", kid: runId, typ: "JWT" })}.${encode({
    aud: `agentscope:${runId}`,
    runId,
    exp: Math.floor((Date.now() + remaining) / 1000),
  })}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
};
const readPrivateFile = (path, maximum, mode, uid) => {
  const fields = [
    "dev",
    "ino",
    "mode",
    "uid",
    "gid",
    "nlink",
    "size",
    "mtimeMs",
    "ctimeMs",
  ];
  const named = lstatSync(path);
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== uid ||
      (before.mode & 0o7777) !== mode ||
      before.size < 1 ||
      before.size > maximum ||
      fields.some((field) => before[field] !== named[field])
    )
      failure();
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < bytes.length) {
      const count = readSync(
        fd,
        bytes,
        position,
        bytes.length - position,
        position,
      );
      if (count < 1) failure();
      position += count;
    }
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (
      readSync(fd, Buffer.alloc(1), 0, 1, position) !== 0 ||
      fields.some(
        (field) =>
          before[field] !== after[field] || before[field] !== current[field],
      )
    )
      failure();
    return bytes;
  } finally {
    closeSync(fd);
  }
};
const exchangeControlRequest = ({
  host,
  method,
  path,
  headers,
  bytes,
  remaining,
  deadline,
  now,
  upgrade,
}) => {
  return new Promise((resolve, reject) => {
    let result;
    let first;
    let upgraded = false;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (first !== undefined) reject(first);
      else if (now() >= deadline || result === undefined)
        reject(new Error("integration.mockserver.control"));
      else resolve(Object.freeze(result));
    };
    const fail = (error) => {
      first ??= error;
      req.destroy();
    };
    const req = request(
      { hostname: host, port: 1080, method, path, headers, agent: false },
      (response) => {
        const chunks = [];
        let length = 0;
        response.on("data", (chunk) => {
          length += chunk.length;
          if (length > maximumBytes)
            fail(new Error("integration.mockserver.control"));
          else chunks.push(chunk);
        });
        response.once("error", fail);
        response.once("end", () => {
          result = {
            status: response.statusCode,
            bytes: Buffer.concat(chunks, length),
          };
        });
      },
    );
    const timer = setTimeout(
      () => fail(new Error("integration.mockserver.control")),
      remaining,
    );
    req.once("error", (error) => {
      first ??= error;
    });
    req.once("upgrade", (response, socket, head) => {
      upgraded = true;
      if (!upgrade || response.statusCode !== 101 || head.length !== 0)
        first ??= new Error("integration.mockserver.control");
      socket.once("close", () => {
        result = { status: response.statusCode, bytes: Buffer.alloc(0) };
        req.destroy();
        finish();
      });
      socket.destroy();
    });
    req.once("close", () => {
      if (!upgraded) finish();
    });
    req.end(bytes);
  });
};
export const openMockServerControl = ({
  runId,
  host,
  deadline,
  now,
  material,
}) => {
  if (
    !runPattern.test(runId ?? "") ||
    typeof now !== "function" ||
    !Number.isFinite(deadline) ||
    !/^(?:mockserver|(?:\d{1,3}\.){3}\d{1,3})$/u.test(host ?? "")
  )
    failure();
  if (now() >= deadline) failure();
  let privateKey = ownedKeys.get(material)?.privateKey;
  if (material !== undefined && ownedKeys.get(material)?.runId !== runId)
    failure();
  if (material === undefined) {
    const parent = lstatSync("/control/private");
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== 0 ||
      (parent.mode & 0o7777) !== 0o700
    )
      failure();
    privateKey = createPrivateKey(
      readPrivateFile("/control/private/control-private.pem", 4096, 0o600, 0),
    );
  }
  const observations = [];
  const send = (
    method,
    path,
    value,
    authentication = "controller",
    upgrade = false,
  ) => {
    if (
      ![
        "/mockserver/expectation",
        "/mockserver/retrieve?type=REQUESTS",
        "/mockserver/configuration",
        "/mockserver/stop",
        "/mockserver/dashboard",
        "/_mockserver_callback_websocket",
      ].includes(path) ||
      !["GET", "PUT"].includes(method) ||
      !["controller", "absent", "invalid"].includes(authentication)
    )
      failure();
    const remaining = Math.floor(deadline - now());
    if (!Number.isFinite(remaining) || remaining < 1) failure();
    if (observations.length >= 16) failure();
    const bytes =
      value === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(value));
    if (bytes.length > maximumBytes) failure();
    const headers = {
      connection: "close",
      "content-length": String(bytes.length),
      "content-type": "application/json",
    };
    if (authentication !== "absent")
      headers.authorization = `Bearer ${authentication === "invalid" ? "invalid" : token(privateKey, runId, remaining)}`;
    if (upgrade)
      Object.assign(headers, {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "YWdlbnRzY29wZS1wcm9iZQ==",
      });
    return exchangeControlRequest({
      host,
      method,
      path,
      headers,
      bytes,
      remaining,
      deadline,
      now,
      upgrade,
    }).then((result) => {
      observations.push(
        Object.freeze({
          method,
          path: path.split("?")[0],
          role:
            authentication === "controller"
              ? "allowed"
              : result.status === 403
                ? "forbidden"
                : "unauthenticated",
          status: result.status,
          bodyBytes: bytes.length,
          bodySha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      );
      return result;
    });
  };
  return Object.freeze({
    send,
    configure: (expectations) =>
      send("PUT", "/mockserver/expectation", expectations),
    requests: () => send("PUT", "/mockserver/retrieve?type=REQUESTS", {}),
    stop: () => send("PUT", "/mockserver/stop", {}),
    snapshot: () =>
      Object.freeze({ runId, entries: Object.freeze([...observations]) }),
  });
};
export const verifyMockServerControlBoundary = async (control) => {
  for (const [method, path, upgrade] of [
    ["GET", "/mockserver/configuration", false],
    ["GET", "/mockserver/dashboard", false],
    ["GET", "/_mockserver_callback_websocket", true],
  ]) {
    const result = await control.send(
      method,
      path,
      undefined,
      "controller",
      upgrade,
    );
    if (result.status !== (upgrade ? 101 : 200)) failure();
  }
};
/** Called in the selected candidate principal, with no control material. */
export const probeMockServerCandidate = async ({
  runId,
  host,
  deadline,
  now,
}) => {
  if (
    process.getuid() !== 1000 ||
    process.getgid() !== 1000 ||
    !runPattern.test(runId ?? "") ||
    host !== "mockserver" ||
    typeof now !== "function" ||
    !Number.isFinite(deadline)
  )
    failure();
  const entries = [];
  for (const [path, upgrade, invalid] of [
    ["/mockserver/configuration", false, false],
    ["/mockserver/dashboard", false, false],
    ["/_mockserver_callback_websocket", true, false],
    ["/mockserver/configuration", false, true],
  ]) {
    const remaining = Math.floor(deadline - now());
    if (!Number.isFinite(remaining) || remaining < 1) failure();
    const headers = { connection: "close", "content-length": "0" };
    if (invalid) headers.authorization = "Bearer invalid";
    if (upgrade)
      Object.assign(headers, {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "YWdlbnRzY29wZS1wcm9iZQ==",
      });
    const response = await exchangeControlRequest({
      host,
      method: "GET",
      path,
      headers,
      bytes: Buffer.alloc(0),
      remaining,
      deadline,
      now,
      upgrade,
    });
    if (![401, 403].includes(response.status)) failure();
    entries.push(
      Object.freeze({
        method: "GET",
        path,
        role: response.status === 403 ? "forbidden" : "unauthenticated",
        status: response.status,
        bodyBytes: 0,
        bodySha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      }),
    );
  }
  return Object.freeze({ runId, entries: Object.freeze(entries) });
};
/** Fixed ordinary candidate recipe; every readiness attempt consumes ledger room. */
export const observeMockServerCandidateTraffic = async ({
  runId,
  modelRequestCount,
  deadline,
}) => {
  const serviceFailure = () => {
    throw new Error("integration.fixture.service");
  };
  if (
    process.getuid() !== 1000 ||
    process.getgid() !== 1000 ||
    !runPattern.test(runId ?? "") ||
    !Number.isFinite(deadline) ||
    !Number.isSafeInteger(modelRequestCount) ||
    modelRequestCount < 1
  )
    serviceFailure();
  const maximumAttempts = 16 - 4 - 4 - modelRequestCount;
  if (maximumAttempts < 1) serviceFailure();
  const entries = [];
  for (let attempt = 0; ; attempt++) {
    const remaining = Math.floor(deadline - readMockServerBootClock());
    if (attempt >= maximumAttempts || remaining < 1) serviceFailure();
    const response = await fetch("http://mockserver:1080/mockserver/ready", {
      signal: AbortSignal.timeout(Math.min(1000, remaining)),
    });
    if (
      ![200, 503].includes(response.status) ||
      readMockServerBootClock() >= deadline
    )
      serviceFailure();
    entries.push(
      mockServerTrafficRow(
        "GET",
        "/mockserver/ready",
        "readiness",
        response.status,
      ),
    );
    await response.body?.cancel();
    if (response.status === 200) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const candidate = await probeMockServerCandidate({
    runId,
    host: "mockserver",
    deadline,
    now: readMockServerBootClock,
  });
  return Object.freeze([...entries, ...candidate.entries]);
};
/** Call only after exact service join. No marker/snapshot alone proves finality. */
export const readMockServerFinalLedger = ({ directory, deadline, now }) => {
  if (
    typeof directory !== "string" ||
    typeof now !== "function" ||
    !Number.isFinite(deadline) ||
    now() >= deadline
  )
    failure();
  const parent = lstatSync(directory);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid() ||
    (parent.mode & 0o7777) !== 0o700
  )
    failure();
  const receipt = readPrivateFile(
    `${directory}/requests.complete`,
    9,
    0o600,
    process.getuid(),
  );
  if (!receipt.equals(Buffer.from("complete\n"))) failure();
  const bytes = readPrivateFile(
    `${directory}/requests.json`,
    maximumBytes,
    0o600,
    process.getuid(),
  );
  const current = lstatSync(directory);
  if (
    current.dev !== parent.dev ||
    current.ino !== parent.ino ||
    now() >= deadline
  )
    failure();
  return bytes;
};
