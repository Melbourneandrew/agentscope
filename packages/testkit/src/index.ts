import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export * from "./harness.js";
export * from "./model-routes.js";

export interface MockRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export class MockModelServer {
  readonly requests: MockRequest[] = [];
  private server?: Server;

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.recordAndRespond(request, response);
    });
    await listen(this.server);
    return addressOf(this.server);
  }

  private async recordAndRespond(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    this.requests.push({
      method: request.method ?? "GET",
      path: request.url ?? "/",
      headers: request.headers,
      body: await readJson(request),
    });
    const path = request.url ?? "/";
    if (path.endsWith("/chat/completions")) {
      send(response, {
        choices: [
          {
            message: {
              role: "assistant",
              content: "AGENTSCOPE_MOCK_RESPONSE",
            },
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      });
      return;
    }
    if (path.endsWith("/responses")) {
      send(response, {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "AGENTSCOPE_MOCK_RESPONSE" },
            ],
          },
        ],
        usage: { input_tokens: 11, output_tokens: 3 },
      });
      return;
    }
    if (path.endsWith("/messages")) {
      send(response, {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "AGENTSCOPE_MOCK_RESPONSE" }],
        usage: { input_tokens: 11, output_tokens: 3 },
      });
      return;
    }
    if (path.includes(":generateContent")) {
      send(response, {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "AGENTSCOPE_MOCK_RESPONSE" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3 },
      });
      return;
    }
    send(response, { error: `Unsupported mock-model path: ${path}` }, 404);
  }

  async stop(): Promise<void> {
    await close(this.server);
    delete this.server;
  }
}

/** Records OTLP and Langfuse-compatible ingestion requests for exact assertions. */
export class MockTelemetryCollector {
  readonly requests: MockRequest[] = [];
  private server?: Server;

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.recordRequest(request, response);
    });
    await listen(this.server);
    return addressOf(this.server);
  }

  private async recordRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    this.requests.push({
      method: request.method ?? "GET",
      path: request.url ?? "/",
      headers: request.headers,
      body: await readJson(request),
    });
    send(response, {});
  }

  async stop(): Promise<void> {
    await close(this.server);
    delete this.server;
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
function send(response: ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}
function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
function close(server?: Server): Promise<void> {
  return !server
    ? Promise.resolve()
    : new Promise((resolve, reject) =>
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
}
function addressOf(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Mock server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}
