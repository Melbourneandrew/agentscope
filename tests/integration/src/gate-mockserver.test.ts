import { spawn, type ChildProcess } from "node:child_process";
import { Agent, request as httpRequest } from "node:http";
import { createConnection, createServer, type Socket } from "node:net";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const integrationRoot = resolve(import.meta.dirname, "..");
const source = resolve(integrationRoot, "gate-mockserver.mjs");
const challenge = "a".repeat(64);
const runId = "gate-test";
const responseText =
  'data: {"type":"response.completed","response":{"output":[]}}\n\n';
const children = new Set<ChildProcess>();
const agents = new Map<number, Agent>();

const bootNow = () => Number(process.hrtime.bigint() / 1_000_000n);
const availablePort = async () => {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("gate-test.port");
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => {
      if (error === undefined) resolvePromise();
      else reject(error);
    }),
  );
  return address.port;
};
const request = async (
  controlPort: number,
  path: string,
  body?: unknown,
  token = challenge,
  method = body === undefined ? "GET" : "POST",
) => {
  const agent = agents.get(controlPort);
  if (agent === undefined) throw new Error("gate-test.agent");
  return new Promise<{
    status: number;
    value: Record<string, unknown>;
  }>((resolvePromise, reject) => {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const controlRequest = httpRequest(
      `http://127.0.0.1:${controlPort}${path}`,
      {
        agent,
        headers:
          bytes === undefined
            ? undefined
            : {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
        method,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Uint8Array) =>
          chunks.push(Buffer.from(chunk)),
        );
        response.once("end", () => {
          try {
            resolvePromise({
              status: response.statusCode ?? 0,
              value: JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
              ) as Record<string, unknown>,
            });
          } catch (error) {
            reject(
              error instanceof Error ? error : new Error("gate-test.json"),
            );
          }
        });
      },
    );
    controlRequest.once("error", reject);
    controlRequest.end(bytes);
  });
};
const startGate = async () => {
  const modelPort = await availablePort();
  const controlPort = await availablePort();
  const child = spawn(
    process.execPath,
    [
      source,
      "--model-port",
      String(modelPort),
      "--control-port",
      String(controlPort),
    ],
    {
      env: { LANG: "C.UTF-8", PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  agents.set(controlPort, new Agent({ keepAlive: true, maxSockets: 1 }));
  return { child, controlPort, modelPort };
};
const configure = async (controlPort: number, cutoff = bootNow() + 5_000) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await request(controlPort, "/configure", {
        challenge,
        cutoff,
        responseText,
        runId,
      });
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  throw new Error("gate-test.configure");
};
const connect = async (port: number) => {
  const socket = await new Promise<Socket>((resolvePromise, reject) => {
    const value = createConnection({ host: "127.0.0.1", port });
    value.once("error", reject);
    value.once("connect", () => {
      resolvePromise(value);
    });
  });
  return socket;
};
const expectConnectionRefused = (port: number) =>
  new Promise<void>((resolvePromise, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("gate-test.control-open"));
    });
    socket.once("error", () => {
      resolvePromise();
    });
  });
const exactRequest = () => {
  const body = Buffer.from('{"model":"fixture"}');
  return Buffer.concat([
    Buffer.from(
      `POST /v1/responses HTTP/1.1\r\nHost: model\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
    ),
    body,
  ]);
};
const collect = (socket: Socket) =>
  new Promise<Buffer>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("error", reject);
    socket.once("close", () => {
      resolvePromise(Buffer.concat(chunks));
    });
  });
const terminal = (child: ChildProcess) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise) =>
      child.once("exit", (code, signal) => {
        resolvePromise({ code, signal });
      }),
  );

afterEach(async () => {
  for (const agent of agents.values()) agent.destroy();
  agents.clear();
  const active = [...children];
  children.clear();
  await Promise.all(
    active.map(
      (child) =>
        new Promise<void>((resolvePromise) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolvePromise();
            return;
          }
          child.once("exit", () => {
            resolvePromise();
          });
          child.kill("SIGKILL");
        }),
    ),
  );
});

// eslint-disable-next-line max-lines-per-function -- closed adversarial state-machine matrix
describe("gate-capable exact-build MockServer", () => {
  it("holds the first socket below HTTP parsing until the exact span is armed", async () => {
    const { child, controlPort, modelPort } = await startGate();
    const childTerminal = terminal(child);
    expect(await configure(controlPort)).toMatchObject({
      status: 200,
      value: { runId, state: "pending" },
    });
    await expectConnectionRefused(controlPort);
    const socket = await connect(modelPort);
    const completion = collect(socket);
    socket.write(exactRequest());
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    expect(
      await request(controlPort, "/requests", {}, challenge, "PUT"),
    ).toMatchObject({
      status: 200,
      value: { ledger: [] },
    });
    const span = "b".repeat(64);
    expect(
      await request(controlPort, "/arm", {
        runId,
        sessionStartSpanSha256: span,
      }),
    ).toMatchObject({ status: 200, value: { state: "armed" } });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await request(
        controlPort,
        "/requests",
        {},
        challenge,
        "PUT",
      );
      if ((observed.value.ledger as unknown[]).length === 1) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    expect(await request(controlPort, "/release", { runId })).toMatchObject({
      status: 200,
      value: { state: "admitted" },
    });
    expect((await completion).toString("utf8")).toContain(responseText);
    const sealed = await request(controlPort, "/seal", { runId });
    expect(sealed.status).toBe(200);
    expect(sealed.value).toMatchObject({
      ledger: [{ method: "POST", path: "/v1/responses" }],
      receipt: {
        challengeSha256:
          "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
        connectionCount: 1,
        ledgerCount: 1,
        parserFailures: 0,
        runId,
        sessionStartSpanSha256: span,
        state: "draining",
      },
    });
    expect(await childTerminal).toEqual({ code: 0, signal: null });
  });

  it("rejects substituted control authority and duplicate initial sockets", async () => {
    const { controlPort, modelPort } = await startGate();
    await configure(controlPort);
    const first = await connect(modelPort);
    const second = await connect(modelPort);
    await new Promise<void>((resolvePromise) =>
      second.once("close", resolvePromise),
    );
    expect(
      await request(
        controlPort,
        "/arm",
        { runId, sessionStartSpanSha256: "b".repeat(64) },
        "c".repeat(64),
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await request(controlPort, "/arm", {
        runId,
        sessionStartSpanSha256: "b".repeat(64),
      }),
    ).toMatchObject({ status: 409 });
    expect(await request(controlPort, "/deny", { runId })).toMatchObject({
      status: 200,
      value: {
        receipt: {
          connectionCount: 2,
          connections: [
            { admission: "rejected", closed: true },
            { admission: "rejected", closed: true },
          ],
          state: "denied",
        },
      },
    });
    first.destroy();
  });

  it("denies a partial request at the absolute cutoff without admitting work", async () => {
    const { controlPort, modelPort } = await startGate();
    await configure(controlPort, bootNow() + 200);
    const socket = await connect(modelPort);
    const completion = collect(socket);
    expect(
      await request(controlPort, "/arm", {
        runId,
        sessionStartSpanSha256: "b".repeat(64),
      }),
    ).toMatchObject({ status: 200 });
    socket.write(
      "POST /v1/responses HTTP/1.1\r\nHost: model\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
    );
    await completion;
    expect(await request(controlPort, "/deny", { runId })).toMatchObject({
      status: 200,
      value: {
        ledger: [],
        receipt: { ledgerCount: 0, state: "denied" },
      },
    });
  });

  it("permanently denies a second socket during provisional parsing", async () => {
    const { controlPort, modelPort } = await startGate();
    await configure(controlPort);
    const first = await connect(modelPort);
    const firstCompletion = collect(first);
    await request(controlPort, "/arm", {
      runId,
      sessionStartSpanSha256: "b".repeat(64),
    });
    first.write(
      "POST /v1/responses HTTP/1.1\r\nHost: model\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    const second = await connect(modelPort);
    await collect(second);
    await firstCompletion;
    expect(await request(controlPort, "/health")).toMatchObject({
      status: 200,
      value: { state: "denied" },
    });
    expect(await request(controlPort, "/deny", { runId })).toMatchObject({
      status: 200,
      value: {
        ledger: [],
        receipt: {
          connectionCount: 2,
          connections: [
            {
              admission: "canceled",
              closed: true,
              parserOutcome: "rejected",
            },
            {
              admission: "rejected",
              closed: true,
              parserOutcome: "not-parsed",
            },
          ],
          state: "denied",
        },
      },
    });
  });

  it("drains work admitted before cutoff while refusing later admission", async () => {
    const { controlPort, modelPort } = await startGate();
    await configure(controlPort, bootNow() + 300);
    const socket = await connect(modelPort);
    const completion = collect(socket);
    await request(controlPort, "/arm", {
      runId,
      sessionStartSpanSha256: "b".repeat(64),
    });
    socket.write(exactRequest());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await request(
        controlPort,
        "/requests",
        {},
        challenge,
        "PUT",
      );
      if ((observed.value.ledger as unknown[]).length === 1) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 320));
    await expectConnectionRefused(modelPort);
    expect(await request(controlPort, "/release", { runId })).toMatchObject({
      status: 200,
      value: { state: "draining" },
    });
    expect((await completion).toString("utf8")).toContain(responseText);
    expect(await request(controlPort, "/seal", { runId })).toMatchObject({
      status: 200,
      value: {
        receipt: {
          connections: [
            {
              admission: "admitted",
              closed: true,
              parserOutcome: "accepted",
            },
          ],
          state: "draining",
        },
      },
    });
  });

  it("rejects an idle later socket when cutoff wins before its request", async () => {
    const { controlPort, modelPort } = await startGate();
    await configure(controlPort, bootNow() + 500);
    const first = await connect(modelPort);
    const firstCompletion = collect(first);
    await request(controlPort, "/arm", {
      runId,
      sessionStartSpanSha256: "b".repeat(64),
    });
    first.write(exactRequest());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await request(
        controlPort,
        "/requests",
        {},
        challenge,
        "PUT",
      );
      if ((observed.value.ledger as unknown[]).length === 1) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    await request(controlPort, "/release", { runId });
    await firstCompletion;
    const idle = await connect(modelPort);
    const idleCompletion = collect(idle);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 520));
    await idleCompletion;
    expect(await request(controlPort, "/seal", { runId })).toMatchObject({
      status: 200,
      value: {
        receipt: {
          connectionCount: 2,
          connections: [
            { admission: "admitted", parserOutcome: "accepted" },
            {
              admission: "rejected",
              closed: true,
              parserOutcome: "not-parsed",
            },
          ],
          ledgerCount: 1,
          state: "draining",
        },
      },
    });
  });

  it("accounts for partial framing admitted before cutoff", async () => {
    const { controlPort, modelPort } = await startGate();
    await configure(controlPort, bootNow() + 700);
    const first = await connect(modelPort);
    const firstCompletion = collect(first);
    await request(controlPort, "/arm", {
      runId,
      sessionStartSpanSha256: "b".repeat(64),
    });
    first.write(exactRequest());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await request(
        controlPort,
        "/requests",
        {},
        challenge,
        "PUT",
      );
      if ((observed.value.ledger as unknown[]).length === 1) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    await request(controlPort, "/release", { runId });
    await firstCompletion;
    const partial = await connect(modelPort);
    const partialCompletion = collect(partial);
    partial.write("POST /v1/responses HTTP/1.1\r\nHost: model\r\n");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 720));
    partial.end();
    await partialCompletion;
    expect(await request(controlPort, "/seal", { runId })).toMatchObject({
      status: 200,
      value: {
        receipt: {
          connectionCount: 2,
          connections: [
            { admission: "admitted", parserOutcome: "accepted" },
            {
              admission: "admitted",
              closed: true,
              parserOutcome: "rejected",
            },
          ],
          ledgerCount: 1,
          parserFailures: 1,
          state: "draining",
        },
      },
    });
  });

  it("rejects a request-ready callback delayed past cutoff", async () => {
    const { child, controlPort, modelPort } = await startGate();
    await configure(controlPort, bootNow() + 1_200);
    const first = await connect(modelPort);
    const firstCompletion = collect(first);
    await request(controlPort, "/arm", {
      runId,
      sessionStartSpanSha256: "b".repeat(64),
    });
    first.write(exactRequest());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await request(
        controlPort,
        "/requests",
        {},
        challenge,
        "PUT",
      );
      if ((observed.value.ledger as unknown[]).length === 1) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    await request(controlPort, "/release", { runId });
    await firstCompletion;
    const delayed = await connect(modelPort);
    const delayedCompletion = collect(delayed).then(
      () => "closed",
      (error: NodeJS.ErrnoException) => error.code ?? "error",
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    expect(child.kill("SIGSTOP")).toBe(true);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    delayed.write("POST /v1/responses HTTP/1.1\r\n");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_220));
    expect(child.kill("SIGCONT")).toBe(true);
    expect(["closed", "ECONNRESET"]).toContain(await delayedCompletion);
    expect(await request(controlPort, "/seal", { runId })).toMatchObject({
      status: 200,
      value: {
        receipt: {
          connectionCount: 2,
          connections: [
            { admission: "admitted", parserOutcome: "accepted" },
            {
              admission: "rejected",
              closed: true,
              parserOutcome: "not-parsed",
            },
          ],
          ledgerCount: 1,
          state: "draining",
        },
      },
    });
  });
});
