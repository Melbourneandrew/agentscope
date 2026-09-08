/* eslint-disable complexity, max-lines-per-function -- one closed admission/request ledger state machine */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const maximumBodyBytes = 1024 * 1024;
const maximumLedgerBytes = 1024 * 1024;
const maximumLedgerEntries = 4_096;
const send = (response, status, value) => {
  response.writeHead(status, {
    connection: "close",
    "content-type": "application/json",
  });
  response.end(status === 204 ? undefined : JSON.stringify(value));
};
const readBody = async (request) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > maximumBodyBytes) {
      request.resume();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};
const transportHeaders = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "connection",
  "content-length",
  "host",
  "sec-fetch-mode",
  "user-agent",
]);

export const createModelProxy = ({
  fetchImpl,
  routes,
  scenarioId,
  upstream,
}) => {
  if (
    typeof fetchImpl !== "function" ||
    !Array.isArray(routes) ||
    routes.length < 1 ||
    typeof scenarioId !== "string" ||
    !/^[a-z0-9.-]{1,128}$/u.test(scenarioId) ||
    upstream !== "http://mockserver-control:1080"
  )
    throw new Error("integration.model-proxy.authority");
  const entries = [];
  const pendingSockets = new Set();
  const socketStates = new WeakMap();
  let ledgerBytes = 0;
  let overflow = false;
  let admitted = false;
  let sealed = false;
  let inFlightRequestCount = 0;
  let activeBodyCount = 0;
  const canAppend = (entry) =>
    !overflow &&
    entries.length < maximumLedgerEntries &&
    ledgerBytes + Buffer.byteLength(JSON.stringify(entry)) <=
      maximumLedgerBytes;
  const append = (entry) => {
    if (!canAppend(entry)) {
      overflow = true;
      return false;
    }
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    entries.push(Object.freeze(entry));
    ledgerBytes += bytes;
    return true;
  };
  const recordTransport = (socket, outcome) => {
    const state = socketStates.get(socket);
    if (state === undefined || state.transportRecorded) return;
    state.transportRecorded = true;
    append({ method: "TRANSPORT", outcome, path: "/" });
  };
  const observeConnection = (socket) => {
    if (
      socket === null ||
      typeof socket !== "object" ||
      socketStates.has(socket) ||
      typeof socket.once !== "function"
    )
      throw new Error("integration.model-proxy.transport");
    if (sealed) {
      socket.destroy();
      return;
    }
    socketStates.set(socket, {
      requestStarted: false,
      transportRecorded: false,
    });
    pendingSockets.add(socket);
    socket.once("close", () => {
      pendingSockets.delete(socket);
      if (!socketStates.get(socket)?.requestStarted)
        recordTransport(socket, "connection-without-request");
    });
  };
  const observeRequest = (request) => {
    const state = socketStates.get(request.socket);
    if (state === undefined) return;
    if (state.requestStarted) {
      recordTransport(request.socket, "duplicate-request");
      return;
    }
    state.requestStarted = true;
  };
  const observeClientError = (_error, socket) => {
    if (!sealed) {
      recordTransport(socket, "parser-rejected");
    }
    socket.destroy();
  };
  const candidateHandler = async (request, response) => {
    activeBodyCount += 1;
    observeRequest(request);
    const url = new URL(request.url ?? "/", "http://model-proxy");
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
    if (sealed) return send(response, 409, {});
    if (body === undefined) {
      append({
        method: request.method ?? "GET",
        outcome: "oversize",
        path: url.pathname,
      });
      return send(response, 413, {});
    }
    if (request.method === "POST" && url.pathname === "/agentscope/admit") {
      if (
        admitted ||
        overflow ||
        entries.length !== 0 ||
        pendingSockets.size !== (pendingSockets.has(request.socket) ? 1 : 0) ||
        body.byteLength !== 0
      ) {
        append({
          method: "POST",
          outcome: "admission-rejected",
          path: url.pathname,
        });
        return send(response, 409, {});
      }
      admitted = true;
      return send(response, 204, {});
    }
    if (!admitted) {
      append({
        method: request.method ?? "GET",
        outcome: "pre-admission",
        path: url.pathname,
      });
      return send(response, 409, {});
    }
    if (request.method === "GET" && url.pathname === "/agentscope/ready")
      return send(response, overflow ? 503 : 200, { ready: !overflow });
    if (overflow) return send(response, 507, {});
    if (request.method === "GET" && url.pathname === "/agentscope-unmatched") {
      append({
        bodyBytes: 0,
        method: "GET",
        path: url.pathname,
        provider: "none",
        routeId: "unmatched",
      });
      return send(response, 404, {});
    }
    let parsedBody;
    try {
      parsedBody = JSON.parse(body.toString("utf8"));
    } catch {
      parsedBody = undefined;
    }
    const route = routes.find(
      (candidate) =>
        candidate.method === request.method &&
        candidate.path === url.pathname &&
        new URLSearchParams(candidate.query ?? {}).toString() ===
          url.searchParams.toString() &&
        Object.entries(candidate.headers).every(
          ([name, value]) => request.headers[name] === value,
        ) &&
        Object.keys(request.headers).every(
          (name) =>
            Object.hasOwn(candidate.headers, name) ||
            transportHeaders.has(name),
        ) &&
        JSON.stringify(candidate.requestBody) === JSON.stringify(parsedBody),
    );
    if (route === undefined) {
      append({
        method: request.method ?? "GET",
        outcome: "rejected",
        path: url.pathname,
      });
      return send(response, 404, {});
    }
    const acceptedEntry = {
      bodyBytes: body.byteLength,
      method: request.method,
      path: url.pathname,
      provider: route.provider,
      routeId: route.routeId,
    };
    if (!canAppend(acceptedEntry)) {
      overflow = true;
      return send(response, 507, {});
    }
    inFlightRequestCount += 1;
    let upstreamResponse;
    try {
      upstreamResponse = await fetchImpl(
        `${upstream}${url.pathname}${url.search}`,
        {
          body,
          headers: request.headers,
          method: request.method,
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        },
      );
    } catch {
      inFlightRequestCount -= 1;
      append({
        method: request.method,
        outcome: "upstream-unavailable",
        path: url.pathname,
      });
      return send(response, 502, {});
    }
    let responseText;
    try {
      responseText = await upstreamResponse.text();
    } catch {
      inFlightRequestCount -= 1;
      append({
        method: request.method,
        outcome: "upstream-unavailable",
        path: url.pathname,
      });
      return send(response, 502, {});
    }
    let responseBody;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = undefined;
    }
    if (
      upstreamResponse.status !== 200 ||
      Buffer.byteLength(responseText) > maximumBodyBytes ||
      JSON.stringify(responseBody) !== JSON.stringify(route.responseBody)
    ) {
      inFlightRequestCount -= 1;
      append({
        method: request.method,
        outcome: "upstream-rejected",
        path: url.pathname,
      });
      return send(response, 502, {});
    }
    const recorded = append(acceptedEntry);
    inFlightRequestCount -= 1;
    if (!recorded) return send(response, 502, {});
    response.writeHead(200, {
      connection: "close",
      "content-type": "application/json",
    });
    response.end(JSON.stringify(responseBody));
  };
  const controlHandler = async (request, response) => {
    const body = await readBody(request);
    if (
      body === undefined ||
      body.byteLength !== 0 ||
      request.method !== "POST" ||
      request.url !== "/agentscope/seal" ||
      sealed ||
      pendingSockets.size !== 0 ||
      activeBodyCount !== 0 ||
      inFlightRequestCount !== 0
    )
      return send(response, 409, {});
    sealed = true;
    return send(response, 200, {
      entries,
      activeBodyCount,
      ledgerVersion: 1,
      inFlightRequestCount,
      overflow,
      pendingConnectionCount: pendingSockets.size,
      scenarioId,
    });
  };
  return Object.freeze({
    candidateHandler,
    controlHandler,
    observeClientError,
    observeConnection,
  });
};

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
    !response.headers.get("content-type")?.startsWith("application/json") ||
    Buffer.byteLength(text) < 2 ||
    Buffer.byteLength(text) > maximumLedgerBytes
  )
    throw new Error("integration.model-proxy.control");
  process.stdout.write(`${JSON.stringify(JSON.parse(text))}\n`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === "--read-control") {
    await readControl();
  } else {
    if (process.argv.length !== 2)
      throw new Error("integration.model-proxy.arguments");
    const fixture = JSON.parse(
      readFileSync("/opt/agentscope/current-model-routes.json", "utf8"),
    );
    const proxy = createModelProxy({
      fetchImpl: fetch,
      routes: fixture.routes,
      scenarioId: process.env.AGENTSCOPE_SCENARIO_ID,
      upstream: process.env.AGENTSCOPE_MODEL_CONTROL_URL,
    });
    const candidateServer = createServer(proxy.candidateHandler);
    candidateServer.on("connection", proxy.observeConnection);
    candidateServer.on("clientError", proxy.observeClientError);
    candidateServer.listen(4320);
    createServer(proxy.controlHandler).listen(4321, "127.0.0.1");
  }
}
