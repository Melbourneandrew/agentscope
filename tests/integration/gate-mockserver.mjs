#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";

const maximumBodyBytes = 1024 * 1024;
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
const parsePorts = () => {
  if (process.argv.length === 2) return [1080, 1081];
  if (
    process.argv.length !== 6 ||
    process.argv[2] !== "--model-port" ||
    process.argv[4] !== "--control-port" ||
    !/^\d{1,5}$/u.test(process.argv[3]) ||
    !/^\d{1,5}$/u.test(process.argv[5])
  )
    throw new Error("integration.mockserver.arguments");
  const ports = [Number(process.argv[3]), Number(process.argv[5])];
  if (ports.some((port) => port < 1 || port > 65_535) || ports[0] === ports[1])
    throw new Error("integration.mockserver.arguments");
  return ports;
};
const [modelPort, controlPort] = parsePorts();
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
  parserWork += 1;
  mutationGeneration += 1;
  try {
    if (
      connection === undefined ||
      (!firstRequest && connection.admission !== "admitted") ||
      (!firstRequest && state !== "admitted" && state !== "draining")
    )
      throw new Error("integration.mockserver.state");
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
    admission: "held",
    closed: false,
    eof: false,
    generation,
    parserOutcome: "not-parsed",
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
    mutationGeneration += 1;
  });
  mutationGeneration += 1;
  return connection;
};
const rejectSocket = (connection) => {
  if (connection.requestReady !== undefined) {
    connection.socket.off("readable", connection.requestReady);
    connection.requestReady = undefined;
  }
  connection.admission = "rejected";
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
    modelServer.emit("connection", socket);
    socket.resume();
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
    modelServer.emit("connection", socket);
    socket.resume();
  };
  socket.once("readable", connection.requestReady);
  mutationGeneration += 1;
};
const transportServer = createNetServer({ pauseOnConnect: true }, (socket) => {
  const connection = registerSocket(socket);
  if (state === "pending" || state === "unconfigured") {
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
const enforceCutoff = () => {
  if (state === "pending" || state === "armed" || state === "parsing-first") {
    state = "denied";
    initialSocket?.destroy();
    initialSocket = undefined;
    for (const { socket } of connections.values()) socket.destroy();
  } else if (state === "admitted") {
    state = "draining";
    for (const connection of connections.values())
      if (connection.admission === "awaiting-request") rejectSocket(connection);
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
  parserWork === 0 && [...connections.values()].every(({ closed }) => closed);
const waitForSettlement = async () => {
  const settlementDeadline = cutoff + 5_000;
  while (!settledConnections() && bootNow() < settlementDeadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  if (!settledConnections()) throw new Error("settlement");
};
const connectionReceipt = () =>
  [...connections.values()].map(
    ({ admission, closed, eof, generation, parserOutcome }) => ({
      admission,
      closed,
      eof,
      generation,
      parserOutcome,
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
  state = "armed";
  sessionStartSpanSha256 = value.sessionStartSpanSha256;
  mutationGeneration += 1;
  const socket = initialSocket;
  initialSocket = undefined;
  if (socket !== undefined) {
    const connection = connectionBySocket.get(socket);
    if (connection === undefined) throw new Error("arm");
    admitSocket(connection);
  }
  json(response, 200, { runId, state });
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
  if ((state !== "admitted" && state !== "draining") || parserWork !== 0)
    throw new Error("seal");
  state = "draining";
  mutationGeneration += 1;
  if (cutoffTimer !== undefined) clearTimeout(cutoffTimer);
  if (transportServer.listening)
    await new Promise((resolve, reject) =>
      transportServer.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  await waitForSettlement();
  terminalReceipt = Object.freeze({
    challengeSha256: digest(challenge),
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
controlServer.listen(controlPort, "0.0.0.0");
