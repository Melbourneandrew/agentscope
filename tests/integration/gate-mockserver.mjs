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
const ledger = [];

const modelServer = createHttpServer(async (request, response) => {
  const firstRequest = state === "armed";
  parserWork += 1;
  mutationGeneration += 1;
  try {
    if (!firstRequest && state !== "admitted")
      throw new Error("integration.mockserver.state");
    if (firstRequest) state = "parsing-first";
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
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (ledger.length >= maximumLedgerEntries)
      throw new Error("integration.mockserver.ledger");
    ledger.push(
      Object.freeze({
        bodyBytes: body.length,
        bodySha256: digest(body),
        method: request.method,
        path: request.url,
      }),
    );
    mutationGeneration += 1;
    if (firstRequest) {
      if (state !== "parsing-first" || bootNow() >= cutoff)
        throw new Error("integration.mockserver.cutoff");
      state = "admitted";
    }
    await releasePromise;
    if (state !== "admitted") throw new Error("integration.mockserver.release");
    response.writeHead(200, {
      connection: "close",
      "content-type": "text/event-stream",
    });
    response.end(responseText);
  } catch {
    parserFailures += 1;
    mutationGeneration += 1;
    if (state === "armed" || state === "parsing-first") state = "denied";
    response.statusCode = 502;
    response.end();
  } finally {
    parserWork -= 1;
    mutationGeneration += 1;
  }
});
modelServer.on("clientError", (_error, socket) => {
  parserFailures += 1;
  mutationGeneration += 1;
  socket.destroy();
});

const admitSocket = (socket) => {
  if (bootNow() >= cutoff || (state !== "armed" && state !== "admitted")) {
    socket.destroy();
    return;
  }
  const generation = ++connectionGeneration;
  connections.set(generation, { closed: false, socket });
  socket.once("close", () => {
    const record = connections.get(generation);
    if (record !== undefined) record.closed = true;
    mutationGeneration += 1;
  });
  mutationGeneration += 1;
  modelServer.emit("connection", socket);
  socket.resume();
};
const transportServer = createNetServer({ pauseOnConnect: true }, (socket) => {
  if (state === "pending" || state === "unconfigured") {
    if (initialSocket !== undefined) {
      socket.destroy();
      state = "denied";
      mutationGeneration += 1;
      return;
    }
    initialSocket = socket;
    return;
  }
  admitSocket(socket);
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
  } else if (state === "admitted") state = "draining";
  else return;
  mutationGeneration += 1;
  closeTransportAdmission();
};
const configure = async (request, response) => {
  if (state !== "unconfigured") throw new Error("state");
  const value = await boundedJson(request);
  if (
    !exactKeys(value, ["challenge", "cutoff", "responseText", "runId"]) ||
    typeof value.challenge !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.challenge) ||
    typeof value.runId !== "string" ||
    value.runId.length < 1 ||
    value.runId.length > 128 ||
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
  if (socket !== undefined) admitSocket(socket);
  json(response, 200, { runId, state });
};
const release = async (request, response) => {
  const value = await boundedJson(request);
  if (
    !exactKeys(value, ["runId"]) ||
    value.runId !== runId ||
    state !== "admitted" ||
    releaseResponse !== undefined
  )
    throw new Error("release");
  releaseResponse = Object.freeze({ runId, state: "admitted" });
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
  if ([...connections.values()].some(({ closed }) => !closed))
    throw new Error("connections");
  terminalReceipt = Object.freeze({
    challengeSha256: digest(challenge),
    connectionCount: connections.size,
    ledgerCount: ledger.length,
    mutationGeneration,
    parserFailures,
    runId,
    sessionStartSpanSha256,
    state: "draining",
  });
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
  terminalReceipt = Object.freeze({
    challengeSha256: digest(challenge),
    connectionCount: connections.size,
    ledgerCount: ledger.length,
    mutationGeneration,
    parserFailures,
    runId,
    sessionStartSpanSha256: sessionStartSpanSha256 ?? null,
    state: "denied",
  });
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

const controlServer = createHttpServer(async (request, response) => {
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

transportServer.listen(modelPort, "0.0.0.0");
controlServer.listen(controlPort, "0.0.0.0");
