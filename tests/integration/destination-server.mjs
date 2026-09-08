import { createServer } from "node:http";
import { createHash } from "node:crypto";

const mode = process.argv[2];
const readControlMode = mode === "--read-control";
const scenarioId = process.env.AGENTSCOPE_SCENARIO_ID;
if (
  !scenarioId ||
  (!readControlMode && mode !== "ingestion" && mode !== "retrieval")
)
  throw new Error("integration.destination.environment");

const entries = [];
let ledgerBytes = 0;
let overflow = false;
let admitted = false;
let sealed = false;
let activeBodyCount = 0;
const append = (entry) => {
  if (overflow) return false;
  const bytes = Buffer.byteLength(JSON.stringify(entry));
  if (entries.length >= 4_096 || ledgerBytes + bytes > 1024 * 1024) {
    overflow = true;
    return false;
  }
  entries.push(entry);
  ledgerBytes += bytes;
  return true;
};
const traces = new Map();
const maximumRequestBytesValue = process.env.AGENTSCOPE_MAXIMUM_REQUEST_BYTES;
if (
  !/^\d+$/u.test(maximumRequestBytesValue ?? "") ||
  Number(maximumRequestBytesValue) !== 1024 * 1024
)
  throw new Error("integration.destination.environment");
const maximumRequestBytes = Number(maximumRequestBytesValue);
const readBody = async (request) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > maximumRequestBytes) {
      request.resume();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};
const sendJson = (response, status, value) => {
  response.writeHead(status, {
    connection: "close",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(value));
};
const record = (request, body, operation, outcome) => {
  return append({
    operation,
    method: request.method ?? "GET",
    path: new URL(request.url ?? "/", "http://destination").pathname,
    bodyBytes: body.byteLength,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    outcome,
  });
};
const requireRecorded = (response, recorded) => {
  if (recorded) return true;
  sendJson(response, 507, {});
  return false;
};
const pendingSockets = new Set();
const socketStates = new WeakMap();
const recordTransport = (socket, outcome) => {
  const state = socketStates.get(socket);
  if (state === undefined || state.transportRecorded) return;
  state.transportRecorded = true;
  append({
    bodyBytes: 0,
    bodySha256: createHash("sha256").digest("hex"),
    method: "TRANSPORT",
    operation: "transport",
    outcome,
    path: "/",
  });
};
const faultFor = (request) => {
  if (request.headers.authorization !== "Bearer DUMMY_DESTINATION_KEY")
    return "auth";
  const fault = request.headers["x-agentscope-fault"];
  return typeof fault === "string" ? fault : undefined;
};
const handleFault = (request, response, body, operation) => {
  const fault = faultFor(request);
  if (fault === "auth") {
    if (
      !requireRecorded(
        response,
        record(request, body, operation, "auth-rejected"),
      )
    )
      return true;
    sendJson(response, 401, {});
    return true;
  }
  if (fault === "rate") {
    if (
      !requireRecorded(
        response,
        record(request, body, operation, "rate-limited"),
      )
    )
      return true;
    sendJson(response, 429, {});
    return true;
  }
  if (fault === "unavailable") {
    if (
      !requireRecorded(
        response,
        record(request, body, operation, "unavailable"),
      )
    )
      return true;
    sendJson(response, 503, {});
    return true;
  }
  if (fault === "malformed") {
    if (
      !requireRecorded(
        response,
        record(request, body, operation, "malformed-response"),
      )
    )
      return true;
    response.writeHead(200, {
      connection: "close",
      "content-type": "application/json",
    });
    response.end("{malformed");
    return true;
  }
  return false;
};

const ingestion = async (request, response, path, body) => {
  const operation = path === "/v1/traces" ? "otlp-ingest" : "langfuse-ingest";
  if (handleFault(request, response, body, operation)) return;
  try {
    JSON.parse(body.toString("utf8"));
  } catch {
    if (
      !requireRecorded(
        response,
        record(request, body, operation, "malformed-request"),
      )
    )
      return;
    sendJson(response, 400, {});
    return;
  }
  if (!requireRecorded(response, record(request, body, operation, "accepted")))
    return;
  sendJson(response, 202, {});
};

const retrieval = async (request, response, path, body) => {
  const operation =
    path === "/seed" ? "seed" : path === "/search" ? "search" : "get";
  if (handleFault(request, response, body, operation)) return;
  if (path === "/seed" && request.method === "POST") {
    let value;
    try {
      value = JSON.parse(body.toString("utf8"));
    } catch {
      if (
        !requireRecorded(
          response,
          record(request, body, operation, "malformed-request"),
        )
      )
        return;
      sendJson(response, 400, {});
      return;
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !==
        "branch,events,model,redaction,tool,traceId" ||
      !/^[a-f\d]{32}$/u.test(value.traceId) ||
      typeof value.branch !== "string" ||
      typeof value.model !== "string" ||
      typeof value.tool !== "string" ||
      value.redaction !== "content-removed" ||
      !Array.isArray(value.events) ||
      value.events.some((event) => typeof event !== "string")
    ) {
      if (
        !requireRecorded(
          response,
          record(request, body, operation, "malformed-request"),
        )
      )
        return;
      sendJson(response, 400, {});
      return;
    }
    if (
      !requireRecorded(response, record(request, body, operation, "accepted"))
    )
      return;
    traces.set(value.traceId, value);
    sendJson(response, 201, {});
    return;
  }
  if (path === "/search" && request.method === "POST") {
    if (
      !requireRecorded(response, record(request, body, operation, "accepted"))
    )
      return;
    sendJson(response, 200, {
      traces: [...traces.values()].map(({ traceId, branch, model, tool }) => ({
        traceId,
        branch,
        model,
        tool,
      })),
    });
    return;
  }
  const traceId = path.startsWith("/trace/") ? path.slice(7) : undefined;
  if (traceId && request.method === "GET" && traces.has(traceId)) {
    if (
      !requireRecorded(response, record(request, body, operation, "accepted"))
    )
      return;
    sendJson(response, 200, traces.get(traceId));
    return;
  }
  if (!requireRecorded(response, record(request, body, operation, "not-found")))
    return;
  sendJson(response, 404, {});
};

const port = mode === "ingestion" ? 4318 : 4319;
const server = createServer(async (request, response) => {
  activeBodyCount += 1;
  const state = socketStates.get(request.socket);
  if (state !== undefined) {
    if (state.requestStarted)
      recordTransport(request.socket, "duplicate-request");
    else state.requestStarted = true;
  }
  const path = new URL(request.url ?? "/", "http://destination").pathname;
  let body;
  try {
    body = await readBody(request);
  } catch {
    activeBodyCount -= 1;
    recordTransport(request.socket, "body-rejected");
    response.destroy();
    return;
  }
  activeBodyCount -= 1;
  if (sealed) {
    sendJson(response, 409, {});
    return;
  }
  if (overflow) {
    sendJson(response, 507, {});
    return;
  }
  if (body === undefined) {
    if (
      !requireRecorded(
        response,
        record(request, Buffer.alloc(0), "oversize", "rejected"),
      )
    )
      return;
    sendJson(response, 413, {});
    return;
  }
  if (request.method === "POST" && path === "/agentscope/admit") {
    if (
      admitted ||
      overflow ||
      entries.length !== 0 ||
      pendingSockets.size !== (pendingSockets.has(request.socket) ? 1 : 0) ||
      body.byteLength !== 0
    ) {
      if (
        !requireRecorded(
          response,
          record(request, body, "admission", "rejected"),
        )
      )
        return;
      sendJson(response, 409, {});
      return;
    }
    admitted = true;
    response.writeHead(204, { connection: "close" });
    response.end();
    return;
  }
  if (!admitted) {
    if (
      !requireRecorded(
        response,
        record(request, body, "pre-admission", "rejected"),
      )
    )
      return;
    sendJson(response, 409, {});
    return;
  }
  if (request.method === "GET" && path === "/health") {
    if (
      !requireRecorded(
        response,
        record(request, Buffer.alloc(0), "health", "accepted"),
      )
    )
      return;
    sendJson(response, 200, { mode });
    return;
  }
  if (
    mode === "ingestion" &&
    request.method === "POST" &&
    (path === "/v1/traces" || path === "/api/public/ingestion")
  ) {
    await ingestion(request, response, path, body);
    return;
  }
  if (mode === "retrieval") {
    await retrieval(request, response, path, body);
    return;
  }
  if (
    !requireRecorded(
      response,
      record(request, Buffer.alloc(0), "unknown", "not-found"),
    )
  )
    return;
  sendJson(response, 404, {});
});
server.on("connection", (socket) => {
  if (sealed) {
    socket.destroy();
    return;
  }
  socketStates.set(socket, { requestStarted: false, transportRecorded: false });
  pendingSockets.add(socket);
  socket.once("close", () => {
    pendingSockets.delete(socket);
    if (!socketStates.get(socket)?.requestStarted)
      recordTransport(socket, "connection-without-request");
  });
});
server.on("clientError", (_error, socket) => {
  if (!sealed) {
    recordTransport(socket, "parser-rejected");
  }
  socket.destroy();
});
const controlServer = createServer(async (request, response) => {
  const body = await readBody(request);
  if (
    body === undefined ||
    body.byteLength !== 0 ||
    request.method !== "POST" ||
    request.url !== "/agentscope/seal" ||
    sealed ||
    pendingSockets.size !== 0 ||
    activeBodyCount !== 0
  ) {
    sendJson(response, 409, {});
    return;
  }
  sealed = true;
  sendJson(response, 200, {
    entries,
    activeBodyCount,
    ledgerVersion: 1,
    overflow,
    pendingConnectionCount: pendingSockets.size,
    scenarioId,
  });
});
const readControl = async () => {
  const response = await fetch("http://127.0.0.1:4321/agentscope/seal", {
    headers: { connection: "close" },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  if (
    response.status !== 200 ||
    Buffer.byteLength(text) < 2 ||
    Buffer.byteLength(text) > 1024 * 1024
  )
    throw new Error("integration.destination.control");
  process.stdout.write(`${JSON.stringify(JSON.parse(text))}\n`);
};
if (readControlMode) await readControl();
else {
  server.listen(port, () =>
    console.log(`Agentscope ${mode} fixture service listening on ${port}`),
  );
  controlServer.listen(4321, "127.0.0.1");
}
