import { createServer } from "node:http";

const mode = process.argv[2];
const scenarioId = process.env.AGENTSCOPE_SCENARIO_ID;
if (!scenarioId || (mode !== "ingestion" && mode !== "retrieval"))
  throw new Error("integration.destination.environment");

const entries = [];
const traces = new Map();
const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};
const sendJson = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
const record = (request, body, operation, outcome) => {
  entries.push({
    operation,
    method: request.method ?? "GET",
    path: new URL(request.url ?? "/", "http://destination").pathname,
    bodyBytes: body.byteLength,
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
    record(request, body, operation, "auth-rejected");
    sendJson(response, 401, {});
    return true;
  }
  if (fault === "rate") {
    record(request, body, operation, "rate-limited");
    sendJson(response, 429, {});
    return true;
  }
  if (fault === "unavailable") {
    record(request, body, operation, "unavailable");
    sendJson(response, 503, {});
    return true;
  }
  if (fault === "malformed") {
    record(request, body, operation, "malformed-response");
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{malformed");
    return true;
  }
  return false;
};

const ingestion = async (request, response, path) => {
  const body = await readBody(request);
  const operation = path === "/v1/traces" ? "otlp-ingest" : "langfuse-ingest";
  if (handleFault(request, response, body, operation)) return;
  try {
    JSON.parse(body.toString("utf8"));
  } catch {
    record(request, body, operation, "malformed-request");
    sendJson(response, 400, {});
    return;
  }
  record(request, body, operation, "accepted");
  sendJson(response, 202, {});
};

const retrieval = async (request, response, path) => {
  const body = await readBody(request);
  const operation =
    path === "/seed" ? "seed" : path === "/search" ? "search" : "get";
  if (handleFault(request, response, body, operation)) return;
  if (path === "/seed" && request.method === "POST") {
    const value = JSON.parse(body.toString("utf8"));
    traces.set(value.traceId, value);
    record(request, body, operation, "accepted");
    sendJson(response, 201, {});
    return;
  }
  if (path === "/search" && request.method === "POST") {
    record(request, body, operation, "accepted");
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
    record(request, body, operation, "accepted");
    sendJson(response, 200, traces.get(traceId));
    return;
  }
  record(request, body, operation, "not-found");
  sendJson(response, 404, {});
};

const port = mode === "ingestion" ? 4318 : 4319;
createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://destination").pathname;
  if (request.method === "GET" && path === "/health") {
    sendJson(response, 200, { mode });
    return;
  }
  if (request.method === "GET" && path === "/ledger") {
    sendJson(response, 200, { ledgerVersion: 1, scenarioId, entries });
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
}).listen(port, () =>
  console.log(`Agentscope ${mode} fixture service listening on ${port}`),
);
