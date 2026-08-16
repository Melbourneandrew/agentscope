import { createServer, type IncomingMessage, type Server } from "node:http";

export * from "./harness.js";

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
    this.server = createServer(async (request, response) => {
      this.requests.push({
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers: request.headers,
        body: await readJson(request),
      });
      const path = request.url ?? "/";
      if (path.endsWith("/chat/completions"))
        return send(response, {
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
      if (path.endsWith("/responses"))
        return send(response, {
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
      if (path.endsWith("/messages"))
        return send(response, {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "AGENTSCOPE_MOCK_RESPONSE" }],
          usage: { input_tokens: 11, output_tokens: 3 },
        });
      if (path.includes(":generateContent"))
        return send(response, {
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
      return send(
        response,
        { error: `Unsupported mock-model path: ${path}` },
        404,
      );
    });
    await listen(this.server);
    return addressOf(this.server);
  }

  async stop(): Promise<void> {
    await close(this.server);
    this.server = undefined;
  }
}

/** Records OTLP and Langfuse-compatible ingestion requests for exact assertions. */
export class MockTelemetryCollector {
  readonly requests: MockRequest[] = [];
  private server?: Server;

  async start(): Promise<string> {
    this.server = createServer(async (request, response) => {
      this.requests.push({
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers: request.headers,
        body: await readJson(request),
      });
      send(response, {});
    });
    await listen(this.server);
    return addressOf(this.server);
  }

  async stop(): Promise<void> {
    await close(this.server);
    this.server = undefined;
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
function send(
  response: import("node:http").ServerResponse,
  payload: unknown,
  status = 200,
): void {
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
        server.close((error) => (error ? reject(error) : resolve())),
      );
}
function addressOf(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Mock server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}
