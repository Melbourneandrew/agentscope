import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { normalizeIssues } from "./graph.mjs";

const executeFile = promisify(execFile);
const DASHBOARD_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(DASHBOARD_DIRECTORY, "../..");
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/graph.mjs", ["graph.mjs", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

export const BD_LIST_ARGUMENTS = ["list", "--all", "--flat", "--limit", "0", "--json", "--readonly"];
export const BD_READY_ARGUMENTS = ["ready", "--limit", "0", "--json", "--readonly"];

export async function loadGraph(run = executeFile) {
  const options = {
    cwd: REPOSITORY_DIRECTORY,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 20_000,
  };
  const { stdout: listOutput } = await run("bd", BD_LIST_ARGUMENTS, options);
  const { stdout: readyOutput } = await run("bd", BD_READY_ARGUMENTS, options);
  let decodedList;
  let decodedReady;
  try {
    decodedList = JSON.parse(listOutput);
    decodedReady = JSON.parse(readyOutput);
  } catch {
    throw new Error("bd returned malformed JSON");
  }
  if (!Array.isArray(decodedReady)) throw new Error("bd ready returned malformed JSON");
  const readyIds = decodedReady
    .filter((issue) => issue && typeof issue === "object" && !Array.isArray(issue) && typeof issue.id === "string")
    .map((issue) => issue.id);
  return normalizeIssues(decodedList, { readyIds });
}

function send(response, status, contentType, body) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

export function createDashboardServer({ graphLoader = loadGraph } = {}) {
  let inFlightGraph = null;
  const coalescedGraphLoader = () => {
    if (!inFlightGraph) {
      inFlightGraph = Promise.resolve()
        .then(graphLoader)
        .finally(() => {
          inFlightGraph = null;
        });
    }
    return inFlightGraph;
  };
  const server = createServer(async (request, response) => {
    const address = server.address();
    const expectedAuthority = address && typeof address === "object" ? `127.0.0.1:${address.port}` : "";
    const expectedOrigin = `http://${expectedAuthority}`;
    if (request.headers.host !== expectedAuthority) {
      send(response, 421, "application/json; charset=utf-8", JSON.stringify({ error: "invalid-authority" }));
      return;
    }
    const origin = request.headers.origin;
    if ((origin && origin !== expectedOrigin) || request.headers["sec-fetch-site"] === "cross-site") {
      send(response, 403, "application/json; charset=utf-8", JSON.stringify({ error: "cross-origin-request" }));
      return;
    }
    if (request.method !== "GET") {
      send(response, 405, "application/json; charset=utf-8", JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    let parsedTarget;
    try {
      parsedTarget = new URL(request.url ?? "/", expectedOrigin);
    } catch {
      send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: "invalid-request-target" }));
      return;
    }
    if (parsedTarget.origin !== expectedOrigin) {
      send(response, 421, "application/json; charset=utf-8", JSON.stringify({ error: "invalid-authority" }));
      return;
    }
    const pathname = parsedTarget.pathname;
    if (pathname === "/api/issues") {
      try {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify(await coalescedGraphLoader()));
      } catch {
        process.stderr.write("Beads dashboard refresh failed.\n");
        send(response, 500, "application/json; charset=utf-8", JSON.stringify({ error: "beads-read-failed" }));
      }
      return;
    }
    const staticFile = STATIC_FILES.get(pathname);
    if (!staticFile) {
      send(response, 404, "text/plain; charset=utf-8", "Not found\n");
      return;
    }
    try {
      send(response, 200, staticFile[1], await readFile(path.join(DASHBOARD_DIRECTORY, staticFile[0])));
    } catch {
      send(response, 500, "text/plain; charset=utf-8", "Dashboard asset unavailable\n");
    }
  });
  return server;
}

export function parsePort(arguments_) {
  if (arguments_.length === 0) return 4173;
  if (arguments_.length !== 2 || arguments_[0] !== "--port" || !/^\d{1,5}$/.test(arguments_[1])) {
    throw new Error("Usage: node .beads/dashboard/server.mjs [--port 1-65535]");
  }
  const port = Number(arguments_[1]);
  if (port < 1 || port > 65_535) throw new Error("Port must be between 1 and 65535");
  return port;
}

async function main() {
  const port = parsePort(process.argv.slice(2));
  const server = createDashboardServer();
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`Beads dashboard: http://127.0.0.1:${port}\n`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
