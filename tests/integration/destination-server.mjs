import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";

const mode = process.argv[2];
const scenarioId = process.env.AGENTSCOPE_SCENARIO_ID;
if (!scenarioId || (mode !== "ingestion" && mode !== "retrieval"))
  throw new Error("integration.destination.environment");

const entries = [];
const traces = new Map();
const eventKindSets = [];
const tlsCertificate = process.env.AGENTSCOPE_COLLECTOR_TLS_CERT;
const tlsKey = process.env.AGENTSCOPE_COLLECTOR_TLS_KEY;
const secureCollector = mode === "ingestion" && tlsCertificate !== undefined;
if (
  (tlsCertificate === undefined) !== (tlsKey === undefined) ||
  (mode !== "ingestion" && tlsCertificate !== undefined)
)
  throw new Error("integration.destination.environment");
const otlpBatches = [];
const admittedHandlers = new Set();
let aggregateOtlpBytes = 0;
let otlpRequestCount = 0;
let ingressOpen = true;
let collectorFailed = false;
const maximumRequestBytesValue = process.env.AGENTSCOPE_MAXIMUM_REQUEST_BYTES;
if (
  !/^\d+$/u.test(maximumRequestBytesValue ?? "") ||
  Number(maximumRequestBytesValue) !== 1024 * 1024
)
  throw new Error("integration.destination.environment");
const maximumRequestBytes = Number(maximumRequestBytesValue);
const readBody = async (request, drainOverflow = false) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > maximumRequestBytes) {
      if (!drainOverflow) {
        request.resume();
        return undefined;
      }
      continue;
    }
    chunks.push(value);
  }
  return bytes > maximumRequestBytes ? undefined : Buffer.concat(chunks);
};
const sendJson = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
const record = (request, bodyBytes, operation, outcome) => {
  entries.push({
    operation,
    method: request.method ?? "GET",
    path: new URL(request.url ?? "/", "http://destination").pathname,
    bodyBytes,
    outcome,
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
    record(request, body.byteLength, operation, "auth-rejected");
    sendJson(response, 401, {});
    return true;
  }
  if (fault === "rate") {
    record(request, body.byteLength, operation, "rate-limited");
    sendJson(response, 429, {});
    return true;
  }
  if (fault === "unavailable") {
    record(request, body.byteLength, operation, "unavailable");
    sendJson(response, 503, {});
    return true;
  }
  if (fault === "malformed") {
    record(request, body.byteLength, operation, "malformed-response");
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{malformed");
    return true;
  }
  return false;
};

const ingestion = async (request, response, path) => {
  const body = await readBody(request);
  const operation = path === "/v1/traces" ? "otlp-ingest" : "langfuse-ingest";
  if (body === undefined) {
    record(request, maximumRequestBytes + 1, operation, "request-too-large");
    sendJson(response, 413, {});
    return;
  }
  if (handleFault(request, response, body, operation)) return;
  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    record(request, body.byteLength, operation, "malformed-request");
    sendJson(response, 400, {});
    return;
  }
  const eventKinds =
    value?.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.events;
  eventKindSets.push(Array.isArray(eventKinds) ? [...eventKinds] : null);
  record(request, body.byteLength, operation, "accepted");
  sendJson(response, 202, {});
};

const ingestLangfuse = async (request, response) => {
  if (otlpRequestCount >= 8) {
    collectorFailed = true;
    request.resume();
    sendJson(response, 413, {});
    return;
  }
  otlpRequestCount += 1;
  let body;
  try {
    body = await readBody(request, true);
  } catch {
    collectorFailed = true;
    sendJson(response, 400, {});
    return;
  }
  if (
    body === undefined ||
    otlpBatches.length >= 8 ||
    aggregateOtlpBytes + body.byteLength > 8 * 1024 * 1024
  ) {
    collectorFailed = true;
    sendJson(response, 413, {});
    return;
  }
  if (
    request.headers.authorization !==
      `Basic ${Buffer.from("DUMMY_PUBLIC_KEY:DUMMY_SECRET_KEY").toString("base64")}` ||
    request.headers["content-type"] !== "application/json" ||
    request.headers["content-encoding"] !== undefined ||
    request.headers["x-langfuse-ingestion-version"] !== "4"
  ) {
    collectorFailed = true;
    sendJson(response, 400, {});
    return;
  }
  // Retain the bounded original bytes only in this independent process. The
  // outer controller scans redaction canaries before Protocol normalization.
  aggregateOtlpBytes += body.byteLength;
  otlpBatches.push(body);
  record(request, body.byteLength, "otlp-ingest", "accepted");
  sendJson(response, 200, {});
};

const closeCollector = async (request, response) => {
  if (
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      request.socket.remoteAddress,
    )
  ) {
    sendJson(response, 403, {});
    return;
  }
  if (!ingressOpen) {
    sendJson(response, 409, {});
    return;
  }
  ingressOpen = false;
  await Promise.allSettled([...admittedHandlers]);
  sendJson(response, collectorFailed ? 409 : 200, {
    observationVersion: 2,
    scenarioId,
    batches: collectorFailed
      ? []
      : otlpBatches.map((body) => body.toString("base64")),
    aggregateBytes: aggregateOtlpBytes,
  });
  server.close();
};

const retrieval = async (request, response, path) => {
  const body = await readBody(request);
  const operation =
    path === "/seed" ? "seed" : path === "/search" ? "search" : "get";
  if (body === undefined) {
    record(request, maximumRequestBytes + 1, operation, "request-too-large");
    sendJson(response, 413, {});
    return;
  }
  if (handleFault(request, response, body, operation)) return;
  if (path === "/seed" && request.method === "POST") {
    const value = JSON.parse(body.toString("utf8"));
    traces.set(value.traceId, value);
    record(request, body.byteLength, operation, "accepted");
    sendJson(response, 201, {});
    return;
  }
  if (path === "/search" && request.method === "POST") {
    record(request, body.byteLength, operation, "accepted");
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
    record(request, body.byteLength, operation, "accepted");
    sendJson(response, 200, traces.get(traceId));
    return;
  }
  record(request, body.byteLength, operation, "not-found");
  sendJson(response, 404, {});
};

const port = mode === "ingestion" ? 4318 : 4319;
const handleRequest = async (request, response) => {
  const path = new URL(request.url ?? "/", "http://destination").pathname;
  if (secureCollector && path === "/observations") {
    if (request.method !== "GET") {
      sendJson(response, 405, {});
      return;
    }
    await closeCollector(request, response);
    return;
  }
  if (secureCollector && !ingressOpen) {
    sendJson(response, 409, {});
    return;
  }
  if (secureCollector && path === "/ledger") {
    sendJson(response, 403, {});
    return;
  }
  if (
    secureCollector &&
    path === "/api/public/otel/v1/traces" &&
    request.method !== "POST"
  ) {
    // Ordinary Langfuse doctor probes this exact reporter endpoint with GET.
    // Method refusal proves reachability without ingesting or exposing data.
    sendJson(response, 405, {});
    return;
  }
  if (request.method === "GET" && path === "/health") {
    sendJson(response, 200, { mode });
    return;
  }
  if (request.method === "GET" && path === "/ledger") {
    sendJson(response, 200, { ledgerVersion: 1, scenarioId, entries });
    return;
  }
  if (
    secureCollector &&
    request.method === "POST" &&
    path === "/api/public/otel/v1/traces"
  ) {
    const handler = ingestLangfuse(request, response);
    admittedHandlers.add(handler);
    try {
      await handler;
    } finally {
      admittedHandlers.delete(handler);
    }
    return;
  }
  if (secureCollector) {
    sendJson(response, 404, {});
    return;
  }
  if (
    mode === "ingestion" &&
    request.method === "GET" &&
    path === "/observations"
  ) {
    sendJson(response, 200, {
      observationVersion: 1,
      scenarioId,
      eventKindSets,
    });
    return;
  }
  if (
    mode === "ingestion" &&
    request.method === "POST" &&
    (path === "/v1/traces" || path === "/api/public/ingestion")
  ) {
    await ingestion(request, response, path);
    return;
  }
  if (mode === "retrieval") {
    await retrieval(request, response, path);
    return;
  }
  sendJson(response, 404, {});
};
let server;
const dispatch = (request, response) => {
  handleRequest(request, response).catch(() => {
    collectorFailed = true;
    if (!response.headersSent) sendJson(response, 500, {});
    else response.destroy();
  });
};
try {
  server = secureCollector
    ? createSecureServer({ cert: tlsCertificate, key: tlsKey }, dispatch)
    : createServer(dispatch);
} catch {
  throw new Error("integration.destination.tls");
}
server.listen(port, () =>
  console.log(`Agentscope ${mode} fixture service listening on ${port}`),
);
