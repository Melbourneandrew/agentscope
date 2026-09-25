#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { Duplex } from "node:stream";

const maximumBodyBytes = 1024 * 1024;
const maximumWireBytes = maximumBodyBytes + 64 * 1024;
const maximumLedgerEntries = 16;
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const bootNow = () => {
  if (!existsSync("/proc/uptime"))
    return Number(process.hrtime.bigint() / 1_000_000n);
  const source = readFileSync("/proc/uptime", "utf8");
  if (source.length > 128 || !/^\d+(?:\.\d+)?\s/u.test(source))
    throw new Error("integration.mockserver.clock");
  return Number(source.split(/\s/u, 1)[0]) * 1_000;
};
const parseEndpoints = () => {
  if (process.argv.length === 2)
    return {
      modelPort: 1080,
      controlSocket: "/control/private/gate.sock",
      production: true,
    };
  if (
    process.argv.length !== 6 ||
    process.argv[2] !== "--model-port" ||
    process.argv[4] !== "--control-socket" ||
    !/^\d{1,5}$/u.test(process.argv[3]) ||
    !isAbsolute(process.argv[5]) ||
    process.argv[5].length > 100 ||
    process.argv[5].includes("\0") ||
    process.argv[5].split("/").some((part) => part === "..")
  )
    throw new Error("integration.mockserver.arguments");
  const modelPort = Number(process.argv[3]);
  if (modelPort < 1 || modelPort > 65_535)
    throw new Error("integration.mockserver.arguments");
  return { modelPort, controlSocket: process.argv[5], production: false };
};
const { modelPort, controlSocket, production } = parseEndpoints();
const controlDirectory = dirname(controlSocket);
if (production) {
  const parent = lstatSync("/control");
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== 0 ||
    (parent.mode & 0o777) !== 0o755
  )
    throw new Error("integration.mockserver.control-parent");
  mkdirSync(controlDirectory, { mode: 0o700 });
}
const controlDirectoryStatus = lstatSync(controlDirectory);
if (
  !controlDirectoryStatus.isDirectory() ||
  controlDirectoryStatus.isSymbolicLink() ||
  (controlDirectoryStatus.mode & 0o777) !== 0o700 ||
  controlDirectoryStatus.uid !== process.getuid()
)
  throw new Error("integration.mockserver.control-directory");
try {
  lstatSync(controlSocket);
  throw new Error("integration.mockserver.control-socket-exists");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
process.umask(0o177);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const promptOccurrences = (value, promptSha256) => {
  const pending = [value];
  let visited = 0;
  let matches = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    if (visited > 8_192) throw new Error("integration.mockserver.request");
    if (typeof current === "string") {
      if (digest(current) === promptSha256) matches += 1;
    } else if (Array.isArray(current)) {
      if (pending.length + current.length > 8_192)
        throw new Error("integration.mockserver.request");
      for (const child of current) pending.push(child);
    } else if (current !== null && typeof current === "object") {
      const children = Object.values(current);
      if (pending.length + children.length > 8_192)
        throw new Error("integration.mockserver.request");
      for (const child of children) pending.push(child);
    }
  }
  return matches;
};
const boundedJson = async (request, maximum = 16 * 1024) => {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    length += value.length;
    if (length > maximum) throw new Error("integration.mockserver.body");
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks, length);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
};
const authorized = (request, challenge) => {
  const value = request.headers.authorization;
  if (
    typeof value !== "string" ||
    !value.startsWith("Bearer ") ||
    challenge === undefined
  )
    return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(challenge);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
};
const json = (response, status, value) => {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    "content-length": String(body.length),
    "content-type": "application/json",
  });
  response.end(body);
};

let state = "unconfigured";
let challenge;
let runId;
let cutoff;
let responseText;
let promptSha256;
let sessionStartSpanSha256;
let armGeneration;
let ackPending = false;
let cutoffUnsettled = false;
let initialSocket;
let connectionGeneration = 0;
let mutationGeneration = 0;
let parserWork = 0;
let parserFailures = 0;
let releaseResponse;
let releasePromise;
let releaseResolve;
let terminalReceipt;
let cutoffTimer;
const connections = new Map();
const connectionBySocket = new WeakMap();
const ledger = [];

const modelServer = createHttpServer(async (request, response) => {
  const firstRequest = state === "armed";
  const connection = connectionBySocket.get(request.socket);
  if (
    connection === undefined ||
    bootNow() >= cutoff ||
    (!firstRequest &&
      (state !== "admitted" || connection.admission !== "admitted"))
  ) {
    parserFailures += 1;
    mutationGeneration += 1;
    if (connection !== undefined) connection.parserOutcome = "rejected";
    response.statusCode = 502;
    response.end();
    request.socket.destroy();
    return;
  }
  parserWork += 1;
  connection.activeRequests += 1;
  mutationGeneration += 1;
  try {
    connection.parserOutcome = "parsing";
    if (firstRequest) {
      state = "parsing-first";
      connection.admission = "provisional";
    }
    if (
      request.method !== "POST" ||
      request.url !== "/v1/responses" ||
      request.headers["content-type"] !== "application/json"
    )
      throw new Error("integration.mockserver.request");
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      const value = Buffer.from(chunk);
      length += value.length;
      if (length > maximumBodyBytes)
        throw new Error("integration.mockserver.request");
      chunks.push(value);
    }
    const body = Buffer.concat(chunks, length);
    const parsedBody = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    );
    if (ledger.length >= maximumLedgerEntries)
      throw new Error("integration.mockserver.ledger");
    const occurrenceCount = promptOccurrences(parsedBody, promptSha256);
    ledger.push(
      Object.freeze({
        bodyBytes: body.length,
        bodySha256: digest(body),
        credentialHeaderCount: Object.keys(request.headers).filter((name) =>
          /^(?:authorization|api-key|x-api-key)$/iu.test(name),
        ).length,
        method: request.method,
        modelSha256:
          typeof parsedBody?.model === "string"
            ? digest(parsedBody.model)
            : null,
        path: request.url,
        promptOccurrenceCount: occurrenceCount,
      }),
    );
    mutationGeneration += 1;
    if (firstRequest) {
      if (state !== "parsing-first" || bootNow() >= cutoff)
        throw new Error("integration.mockserver.cutoff");
      state = "admitted";
      connection.admission = "admitted";
    }
    connection.parserOutcome = "accepted-pending-release";
    await releasePromise;
    if (state !== "admitted" && state !== "draining")
      throw new Error("integration.mockserver.release");
    response.writeHead(200, {
      connection: "close",
      "content-type": "text/event-stream",
    });
    response.end(responseText);
    connection.parserOutcome = "accepted";
  } catch {
    parserFailures += 1;
    mutationGeneration += 1;
    if (connection !== undefined) connection.parserOutcome = "rejected";
    if (state === "armed" || state === "parsing-first") enforceCutoff();
    response.statusCode = 502;
    response.end();
  } finally {
    parserWork -= 1;
    connection.activeRequests -= 1;
    mutationGeneration += 1;
  }
});
modelServer.on("clientError", (_error, socket) => {
  const connection = connectionBySocket.get(socket);
  if (connection !== undefined) connection.parserOutcome = "rejected";
  parserFailures += 1;
  mutationGeneration += 1;
  if (state === "armed" || state === "parsing-first") enforceCutoff();
  socket.destroy();
});

const registerSocket = (socket) => {
  const generation = ++connectionGeneration;
  const connection = {
    activeRequests: 0,
    admission: "held",
    closed: false,
    eof: false,
    generation,
    parserOutcome: "not-parsed",
    parserTransport: undefined,
    parserTransportClosed: true,
    rawForwardedBytes: 0,
    rawRejectedBytes: 0,
    responseBytes: 0,
    requestReady: undefined,
    socket,
  };
  connections.set(generation, connection);
  connectionBySocket.set(socket, connection);
  socket.once("end", () => {
    connection.eof = true;
    mutationGeneration += 1;
  });
  socket.once("close", () => {
    connection.closed = true;
    connection.parserTransport?.destroy();
    mutationGeneration += 1;
  });
  socket.once("error", () => {
    cutoffUnsettled = true;
    connection.parserTransport?.destroy();
  });
  mutationGeneration += 1;
  return connection;
};
const attachParserTransport = (connection) => {
  const { socket } = connection;
  if (connection.parserTransport !== undefined)
    throw new Error("integration.mockserver.parser-transport");
  const parserTransport = new Duplex({
    readableHighWaterMark: maximumWireBytes,
    read() {
      if (!socket.destroyed) socket.resume();
    },
    write(bytes, _encoding, callback) {
      if (socket.destroyed || !Buffer.isBuffer(bytes)) {
        callback(new Error("integration.mockserver.parser-output"));
        return;
      }
      connection.responseBytes += bytes.length;
      if (connection.responseBytes > maximumWireBytes) {
        cutoffUnsettled = true;
        callback(new Error("integration.mockserver.parser-output"));
        return;
      }
      socket.write(bytes, callback);
    },
    final(callback) {
      socket.end(callback);
    },
    destroy(error, callback) {
      socket.destroy();
      callback(error);
    },
  });
  parserTransport.setTimeout = () => parserTransport;
  parserTransport.setNoDelay = () => parserTransport;
  parserTransport.setKeepAlive = () => parserTransport;
  connection.parserTransport = parserTransport;
  connection.parserTransportClosed = false;
  connectionBySocket.set(parserTransport, connection);
  parserTransport.once("close", () => {
    connection.parserTransportClosed = true;
    mutationGeneration += 1;
  });
  parserTransport.once("error", () => {
    cutoffUnsettled = true;
    socket.destroy();
  });
  socket.on("data", (bytes) => {
    if (
      !Buffer.isBuffer(bytes) ||
      bootNow() >= cutoff ||
      state === "draining" ||
      state === "denied"
    ) {
      cutoffUnsettled = true;
      if (Buffer.isBuffer(bytes)) connection.rawRejectedBytes += bytes.length;
      mutationGeneration += 1;
      parserTransport.destroy();
      enforceCutoff();
      return;
    }
    if (connection.rawForwardedBytes + bytes.length > maximumWireBytes) {
      connection.rawRejectedBytes += bytes.length;
      cutoffUnsettled = true;
      parserTransport.destroy();
      return;
    }
    connection.rawForwardedBytes += bytes.length;
    mutationGeneration += 1;
    if (!parserTransport.push(bytes)) {
      cutoffUnsettled = true;
      parserTransport.destroy();
    }
  });
  socket.once("end", () => parserTransport.push(null));
  modelServer.emit("connection", parserTransport);
  socket.resume();
};
const rejectSocket = (connection) => {
  if (connection.requestReady !== undefined) {
    connection.socket.off("readable", connection.requestReady);
    connection.requestReady = undefined;
  }
  connection.admission = "rejected";
  connection.parserTransport?.destroy();
  connection.socket.destroy();
  mutationGeneration += 1;
};
const admitSocket = (connection) => {
  const { socket } = connection;
  if (
    state === "parsing-first" ||
    (state === "armed" &&
      [...connections.values()].some(
        (candidate) =>
          candidate !== connection && candidate.admission !== "rejected",
      ))
  ) {
    rejectSocket(connection);
    enforceCutoff();
    return;
  }
  if (bootNow() >= cutoff || (state !== "armed" && state !== "admitted")) {
    rejectSocket(connection);
    return;
  }
  if (state === "armed") {
    mutationGeneration += 1;
    attachParserTransport(connection);
    return;
  }
  connection.admission = "awaiting-request";
  connection.requestReady = () => {
    connection.requestReady = undefined;
    if (state !== "admitted" || bootNow() >= cutoff) {
      rejectSocket(connection);
      if (state === "admitted") enforceCutoff();
      return;
    }
    connection.admission = "admitted";
    connection.parserOutcome = "framing";
    mutationGeneration += 1;
    attachParserTransport(connection);
  };
  socket.once("readable", connection.requestReady);
  mutationGeneration += 1;
};
const transportServer = createNetServer({ pauseOnConnect: true }, (socket) => {
  const connection = registerSocket(socket);
  if (
    state === "pending" ||
    state === "awaiting-ack" ||
    state === "unconfigured"
  ) {
    if (initialSocket !== undefined) {
      const initialConnection = connectionBySocket.get(initialSocket);
      if (initialConnection !== undefined) rejectSocket(initialConnection);
      initialSocket.destroy();
      initialSocket = undefined;
      rejectSocket(connection);
      state = "denied";
      mutationGeneration += 1;
      closeTransportAdmission();
      return;
    }
    initialSocket = socket;
    return;
  }
  admitSocket(connection);
});
const closeTransportAdmission = () => {
  if (transportServer.listening) transportServer.close(() => undefined);
};
const rejectOpenConnectionAtCutoff = (connection) => {
  if (connection.closed) return;
  if (connection.admission === "awaiting-request") {
    rejectSocket(connection);
    return;
  }
  if (connection.parserOutcome === "framing") {
    parserFailures += 1;
    connection.parserOutcome = "rejected";
  } else if (connection.admission === "admitted") {
    // A completed request's live HTTP socket may conceal pipelined framing.
    // Closing it cannot prove every raw-byte disposition.
    cutoffUnsettled = true;
  }
  connection.socket.destroy();
  connection.parserTransport?.destroy();
};
const enforceCutoff = () => {
  if (
    state === "pending" ||
    state === "awaiting-ack" ||
    state === "armed" ||
    state === "parsing-first"
  ) {
    state = "denied";
    initialSocket?.destroy();
    initialSocket = undefined;
    for (const { socket } of connections.values()) socket.destroy();
  } else if (state === "admitted") {
    state = "draining";
    for (const connection of connections.values())
      rejectOpenConnectionAtCutoff(connection);
  } else return;
  for (const connection of connections.values())
    if (
      connection.admission !== "admitted" &&
      connection.admission !== "rejected"
    ) {
      connection.admission = "canceled";
      connection.socket.destroy();
    }
  mutationGeneration += 1;
  closeTransportAdmission();
};
const settledConnections = () =>
  parserWork === 0 &&
  [...connections.values()].every(
    ({ closed, parserTransportClosed }) => closed && parserTransportClosed,
  );
const waitForSettlement = async () => {
  const settlementDeadline = cutoff + 5_000;
  while (!settledConnections() && bootNow() < settlementDeadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  if (!settledConnections()) throw new Error("settlement");
};
const connectionReceipt = () =>
  [...connections.values()].map(
    ({
      admission,
      closed,
      eof,
      generation,
      parserOutcome,
      parserTransportClosed,
      rawForwardedBytes,
      rawRejectedBytes,
      responseBytes,
    }) => ({
      admission,
      closed,
      eof,
      generation,
      parserOutcome,
      parserTransportClosed,
      rawForwardedBytes,
      rawRejectedBytes,
      responseBytes,
    }),
  );
const configure = async (request, response) => {
  if (state !== "unconfigured") throw new Error("state");
  const value = await boundedJson(request);
  if (
    !exactKeys(value, [
      "challenge",
      "cutoff",
      "promptSha256",
      "responseText",
      "runId",
    ]) ||
    typeof value.challenge !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.challenge) ||
    typeof value.runId !== "string" ||
    value.runId.length < 1 ||
    value.runId.length > 128 ||
    typeof value.promptSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.promptSha256) ||
    !Number.isSafeInteger(value.cutoff) ||
    value.cutoff <= bootNow() ||
    typeof value.responseText !== "string" ||
    Buffer.byteLength(value.responseText) > maximumBodyBytes
  )
    throw new Error("configuration");
  challenge = value.challenge;
  runId = value.runId;
  cutoff = value.cutoff;
  responseText = value.responseText;
  promptSha256 = value.promptSha256;
  releasePromise = new Promise((resolve) => {
    releaseResolve = resolve;
  });
  state = "pending";
  mutationGeneration += 1;
  cutoffTimer = setTimeout(
    enforceCutoff,
    Math.max(1, Math.floor(cutoff - bootNow())),
  );
  json(response, 200, { runId, state });
};
const arm = async (request, response) => {
  const value = await boundedJson(request);
  if (
    !exactKeys(value, ["runId", "sessionStartSpanSha256"]) ||
    value.runId !== runId ||
    typeof value.sessionStartSpanSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sessionStartSpanSha256) ||
    state !== "pending" ||
    bootNow() >= cutoff
  )
    throw new Error("arm");
  state = "awaiting-ack";
  sessionStartSpanSha256 = value.sessionStartSpanSha256;
  armGeneration = digest(`${challenge}:${runId}:${sessionStartSpanSha256}:1`);
  mutationGeneration += 1;
  json(response, 200, {
    challengeSha256: digest(challenge),
    generation: armGeneration,
    runId,
    state,
  });
};
const acknowledgeArm = async (request, response) => {
  const value = await boundedJson(request);
  if (
    !exactKeys(value, ["challengeSha256", "generation", "runId"]) ||
    value.challengeSha256 !== digest(challenge) ||
    value.generation !== armGeneration ||
    value.runId !== runId ||
    state !== "awaiting-ack" ||
    ackPending ||
    bootNow() >= cutoff
  )
    throw new Error("ack");
  ackPending = true;
  const socket = initialSocket;
  response.once("finish", () => {
    if (state !== "awaiting-ack" || bootNow() >= cutoff) {
      enforceCutoff();
      return;
    }
    state = "armed";
    mutationGeneration += 1;
    initialSocket = undefined;
    if (socket === undefined) return;
    const connection = connectionBySocket.get(socket);
    if (connection === undefined) {
      enforceCutoff();
      return;
    }
    admitSocket(connection);
  });
  json(response, 200, { runId, state: "armed", generation: armGeneration });
};
const release = async (request, response) => {
  const value = await boundedJson(request);
  if (
    !exactKeys(value, ["runId"]) ||
    value.runId !== runId ||
    (state !== "admitted" && state !== "draining") ||
    releaseResponse !== undefined
  )
    throw new Error("release");
  releaseResponse = Object.freeze({ runId, state });
  releaseResolve();
  json(response, 200, releaseResponse);
};
const seal = async (request, response) => {
  const value = await boundedJson(request);
  if (!exactKeys(value, ["runId"]) || value.runId !== runId)
    throw new Error("seal");
  if (
    (state !== "admitted" && state !== "draining") ||
    parserWork !== 0 ||
    cutoffUnsettled
  )
    throw new Error("seal");
  state = "draining";
  mutationGeneration += 1;
  if (cutoffTimer !== undefined) clearTimeout(cutoffTimer);
  closeTransportAdmission();
  for (const connection of connections.values())
    if (!connection.closed && connection.activeRequests === 0) {
      if (connection.parserOutcome === "framing") {
        parserFailures += 1;
        connection.parserOutcome = "rejected";
        mutationGeneration += 1;
      }
      connection.socket.destroy();
    }
  await waitForSettlement();
  terminalReceipt = Object.freeze({
    challengeSha256: digest(challenge),
    cutoffUnsettled,
    connectionCount: connections.size,
    connections: connectionReceipt(),
    ledgerCount: ledger.length,
    mutationGeneration,
    parserFailures,
    runId,
    sessionStartSpanSha256,
    state: "draining",
  });
  response.once("finish", () => selectedControlSocket?.destroy());
  json(response, 200, { ledger, receipt: terminalReceipt });
};
const deny = async (request, response) => {
  const value = await boundedJson(request);
  if (
    !exactKeys(value, ["runId"]) ||
    value.runId !== runId ||
    terminalReceipt !== undefined
  )
    throw new Error("deny");
  enforceCutoff();
  if (state !== "denied" && state !== "draining") throw new Error("deny");
  if (cutoffTimer !== undefined) clearTimeout(cutoffTimer);
  releaseResolve?.();
  for (const { socket } of connections.values()) socket.destroy();
  await waitForSettlement();
  terminalReceipt = Object.freeze({
    challengeSha256: digest(challenge),
    cutoffUnsettled,
    connectionCount: connections.size,
    connections: connectionReceipt(),
    ledgerCount: ledger.length,
    mutationGeneration,
    parserFailures,
    runId,
    sessionStartSpanSha256: sessionStartSpanSha256 ?? null,
    state,
  });
  response.once("finish", () => selectedControlSocket?.destroy());
  json(response, 200, { ledger, receipt: terminalReceipt });
};
const authorizedRoute = async (request, response, pathname) => {
  if (request.method === "POST" && pathname === "/arm")
    return arm(request, response);
  if (request.method === "POST" && pathname === "/ack")
    return acknowledgeArm(request, response);
  if (request.method === "POST" && pathname === "/release")
    return release(request, response);
  if (request.method === "POST" && pathname === "/seal")
    return seal(request, response);
  if (request.method === "POST" && pathname === "/deny")
    return deny(request, response);
  if (request.method === "PUT" && pathname === "/requests") {
    json(response, 200, { ledger });
    return;
  }
  if (request.method === "PUT" && pathname === "/connection-count") {
    const latest = [...connections.values()].at(-1);
    json(response, 200, {
      connectionCount: connections.size,
      latestAdmission: latest?.admission ?? null,
      latestRawForwardedBytes: latest?.rawForwardedBytes ?? 0,
    });
    return;
  }
  if (request.method === "PUT" && pathname === "/ledger") {
    if (terminalReceipt === undefined) throw new Error("ledger");
    json(response, 200, { ledger, receipt: terminalReceipt });
    return;
  }
  json(response, 404, { error: "not-found" });
};

const controlApplication = createHttpServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { state });
      return;
    }
    if (request.method === "POST" && url.pathname === "/configure") {
      await configure(request, response);
      return;
    }
    if (!authorized(request, challenge)) {
      json(response, 403, { error: "forbidden" });
      return;
    }
    await authorizedRoute(request, response, url.pathname);
  } catch {
    json(response, 409, { error: "rejected" });
  }
});
// One protected, non-reconnectable control socket must survive the whole turn.
controlApplication.keepAliveTimeout = 0;
let selectedControlSocket;
const controlServer = createNetServer({ pauseOnConnect: true }, (socket) => {
  if (selectedControlSocket !== undefined) {
    socket.destroy();
    return;
  }
  selectedControlSocket = socket;
  controlServer.close(() => undefined);
  controlApplication.emit("connection", socket);
  socket.resume();
});

transportServer.listen(modelPort, "0.0.0.0");
controlServer.listen(controlSocket, () => {
  const status = lstatSync(controlSocket);
  if (
    !status.isSocket() ||
    status.isSymbolicLink() ||
    (status.mode & 0o777) !== 0o600 ||
    status.uid !== process.getuid()
  )
    throw new Error("integration.mockserver.control-socket");
});
