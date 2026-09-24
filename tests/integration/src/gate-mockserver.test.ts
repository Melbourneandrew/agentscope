import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { Agent, request as httpRequest } from "node:http";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const integrationRoot = resolve(import.meta.dirname, "..");
const source = resolve(integrationRoot, "gate-mockserver.mjs");
const challenge = "a".repeat(64);
const runId = "gate-test";
const responseText =
  'data: {"type":"response.completed","response":{"output":[]}}\n\n';
const prompt = "fixture prompt";
const promptSha256 = createHash("sha256").update(prompt).digest("hex");
const children = new Set<ChildProcess>();
const agents = new Map<string, Agent>();
const controlRoots = new Set<string>();

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
  controlSocket: string,
  path: string,
  body?: unknown,
  token = challenge,
  method = body === undefined ? "GET" : "POST",
) => {
  const agent = agents.get(controlSocket);
  if (agent === undefined) throw new Error("gate-test.agent");
  return new Promise<{
    status: number;
    value: Record<string, unknown>;
  }>((resolvePromise, reject) => {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const controlRequest = httpRequest(
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
        path,
        socketPath: controlSocket,
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
const startGate = async ({ delayCutoffTimer = false } = {}) => {
  const modelPort = await availablePort();
  const controlRoot = mkdtempSync(join(tmpdir(), "agentscope-gate-"));
  controlRoots.add(controlRoot);
  const controlSocket = join(controlRoot, "gate.sock");
  const child = spawn(
    process.execPath,
    [
      ...(delayCutoffTimer
        ? [
            "--import",
            resolve(integrationRoot, "fixtures/delay-gate-cutoff-timer.mjs"),
          ]
        : []),
      source,
      "--model-port",
      String(modelPort),
      "--control-socket",
      controlSocket,
    ],
    {
      env: { LANG: "C.UTF-8", PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  agents.set(controlSocket, new Agent({ keepAlive: true, maxSockets: 1 }));
  return { child, controlSocket, modelPort };
};
const configure = async (
  controlSocket: string,
  cutoffWindowMs = 5_000,
  clock: () => number = bootNow,
  configureRequest: typeof request = request,
) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const health = await request(controlSocket, "/health");
      if (health.status === 200) break;
    } catch {
      // The fixture owns this bounded startup readiness phase.
    }
    if (attempt === 99) throw new Error("gate-test.readiness");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  const cutoff = clock() + cutoffWindowMs;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await configureRequest(controlSocket, "/configure", {
        challenge,
        cutoff,
        promptSha256,
        responseText,
        runId,
      });
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  throw new Error("gate-test.configure");
};
const armGate = async (controlSocket: string, span = "b".repeat(64)) => {
  const arm = await request(controlSocket, "/arm", {
    runId,
    sessionStartSpanSha256: span,
  });
  expect(arm).toMatchObject({
    status: 200,
    value: {
      challengeSha256: createHash("sha256").update(challenge).digest("hex"),
      runId,
      state: "awaiting-ack",
    },
  });
  const generation = arm.value.generation;
  expect(generation).toMatch(/^[a-f0-9]{64}$/u);
  const ack = await request(controlSocket, "/ack", {
    challengeSha256: arm.value.challengeSha256,
    generation,
    runId,
  });
  expect(ack).toMatchObject({
    status: 200,
    value: { generation, runId, state: "armed" },
  });
  return ack;
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
const expectConnectionRefused = (endpoint: number | string) =>
  new Promise<void>((resolvePromise, reject) => {
    const socket =
      typeof endpoint === "string"
        ? createConnection(endpoint)
        : createConnection({ host: "127.0.0.1", port: endpoint });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("gate-test.control-open"));
    });
    socket.once("error", () => {
      resolvePromise();
    });
  });
const exactRequest = (
  bodyValue: unknown = { model: "fixture", input: prompt },
  extraHeaders = "",
) => {
  const body = Buffer.from(JSON.stringify(bodyValue));
  return Buffer.concat([
    Buffer.from(
      `POST /v1/responses HTTP/1.1\r\nHost: model\r\nContent-Type: application/json\r\n${extraHeaders}Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
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
  for (const controlRoot of controlRoots)
    rmSync(controlRoot, { recursive: true });
  controlRoots.clear();
});

// eslint-disable-next-line max-lines-per-function -- closed adversarial state-machine matrix
describe("gate-capable exact-build MockServer", () => {
  it("refuses to create its own control authority directory", async () => {
    const modelPort = await availablePort();
    const controlRoot = mkdtempSync(join(tmpdir(), "agentscope-gate-"));
    controlRoots.add(controlRoot);
    const child = spawn(
      process.execPath,
      [
        source,
        "--model-port",
        String(modelPort),
        "--control-socket",
        join(controlRoot, "missing", "gate.sock"),
      ],
      { env: { LANG: "C.UTF-8", PATH: process.env.PATH }, stdio: "ignore" },
    );
    children.add(child);
    expect(await terminal(child)).toMatchObject({ code: 1, signal: null });
    expect(() => lstatSync(join(controlRoot, "missing"))).toThrow();
  });

  it("owns a private Unix control listener before one-use selection", async () => {
    const { controlSocket } = await startGate();
    let socket;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        socket = lstatSync(controlSocket);
        break;
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT" ||
          attempt === 99
        )
          throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
    }
    const directory = lstatSync(resolve(controlSocket, ".."));
    if (socket === undefined) throw new Error("gate-test.control-readiness");
    expect(directory.isDirectory()).toBe(true);
    expect(directory.isSymbolicLink()).toBe(false);
    expect(directory.mode & 0o777).toBe(0o700);
    expect(socket.isSocket()).toBe(true);
    expect(socket.isSymbolicLink()).toBe(false);
    expect(socket.mode & 0o777).toBe(0o600);
    expect(socket.uid).toBe(process.getuid?.());
    expect((await configure(controlSocket)).status).toBe(200);
  });

  it("fixes one absolute cutoff after health readiness", async () => {
    const { controlSocket } = await startGate();
    const clock = vi.fn(bootNow);
    const observedCutoffs: unknown[] = [];
    let configureAttempts = 0;
    const retryingRequest: typeof request = async (...arguments_) => {
      const body = arguments_[2] as { cutoff?: unknown } | undefined;
      observedCutoffs.push(body?.cutoff);
      configureAttempts += 1;
      if (configureAttempts === 1) throw new Error("gate-test.retry");
      return request(...arguments_);
    };

    expect(
      await configure(controlSocket, 5_000, clock, retryingRequest),
    ).toMatchObject({
      status: 200,
      value: { runId, state: "pending" },
    });
    expect(clock).toHaveBeenCalledTimes(1);
    expect(observedCutoffs).toHaveLength(2);
    expect(observedCutoffs[1]).toBe(observedCutoffs[0]);
  });

  it("holds the first socket below HTTP parsing until the exact span is armed", async () => {
    const { child, controlSocket, modelPort } = await startGate();
    const childTerminal = terminal(child);
    expect(await configure(controlSocket)).toMatchObject({
      status: 200,
      value: { runId, state: "pending" },
    });
    await expectConnectionRefused(controlSocket);
    const socket = await connect(modelPort);
    const completion = collect(socket);
    socket.write(exactRequest());
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    expect(
      await request(controlSocket, "/requests", {}, challenge, "PUT"),
    ).toMatchObject({
      status: 200,
      value: { ledger: [] },
    });
    const span = "b".repeat(64);
    expect(await armGate(controlSocket, span)).toMatchObject({
      status: 200,
      value: { state: "armed" },
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await request(
        controlSocket,
        "/requests",
        {},
        challenge,
        "PUT",
      );
      if ((observed.value.ledger as unknown[]).length === 1) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    expect(await request(controlSocket, "/release", { runId })).toMatchObject({
      status: 200,
      value: { state: "admitted" },
    });
    expect((await completion).toString("utf8")).toContain(responseText);
    const sealed = await request(controlSocket, "/seal", { runId });
    expect(sealed.status).toBe(200);
    const nativeRequest = (sealed.value.ledger as Record<string, unknown>[])[0];
    expect(nativeRequest).toBeDefined();
    expect(Object.keys(nativeRequest!).sort()).toEqual([
      "bodyBytes",
      "bodySha256",
      "credentialHeaderCount",
      "method",
      "modelSha256",
      "path",
      "promptOccurrenceCount",
    ]);
    expect(JSON.stringify(nativeRequest)).not.toContain(prompt);
    expect(sealed.value).toMatchObject({
      ledger: [
        {
          method: "POST",
          path: "/v1/responses",
          bodyBytes: Buffer.byteLength(
            JSON.stringify({ model: "fixture", input: prompt }),
          ),
          modelSha256: createHash("sha256").update("fixture").digest("hex"),
          promptOccurrenceCount: 1,
          credentialHeaderCount: 0,
        },
      ],
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

  it("requires a challenge-bound single-use acknowledgement before parsing", async () => {
    const { controlSocket, modelPort } = await startGate();
    await configure(controlSocket);
    const socket = await connect(modelPort);
    const completion = collect(socket);
    socket.write(exactRequest());
    const arm = await request(controlSocket, "/arm", {
      runId,
      sessionStartSpanSha256: "b".repeat(64),
    });
    expect(arm).toMatchObject({
      status: 200,
      value: { runId, state: "awaiting-ack" },
    });
    expect(
      await request(controlSocket, "/requests", {}, challenge, "PUT"),
    ).toMatchObject({ value: { ledger: [] } });
    expect(
      await request(controlSocket, "/ack", {
        challengeSha256: arm.value.challengeSha256,
        generation: "0".repeat(64),
        runId,
      }),
    ).toMatchObject({ status: 409 });
    expect(
      await request(controlSocket, "/requests", {}, challenge, "PUT"),
    ).toMatchObject({ value: { ledger: [] } });
    expect(
      await request(controlSocket, "/ack", {
        challengeSha256: arm.value.challengeSha256,
        generation: arm.value.generation,
        runId,
      }),
    ).toMatchObject({ status: 200, value: { state: "armed" } });
    expect(
      await request(controlSocket, "/ack", {
        challengeSha256: arm.value.challengeSha256,
        generation: arm.value.generation,
        runId,
      }),
    ).toMatchObject({ status: 409 });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await request(
        controlSocket,
        "/requests",
        {},
        challenge,
        "PUT",
      );
      if ((observed.value.ledger as unknown[]).length === 1) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    expect(await request(controlSocket, "/release", { runId })).toMatchObject({
      status: 200,
    });
    await completion;
    expect(await request(controlSocket, "/seal", { runId })).toMatchObject({
      status: 200,
      value: { receipt: { ledgerCount: 1 } },
    });
  });

  it.each([
    ["missing prompt", { model: "fixture", input: "other" }, "", 0, 0],
    [
      "duplicate prompt",
      { model: "fixture", input: [prompt, prompt] },
      "",
      2,
      0,
    ],
    [
      "credential header",
      { model: "fixture", input: prompt },
      "Authorization: Bearer secret-canary\r\n",
      1,
      1,
    ],
    [
      "long model field",
      { model: "secret-canary".repeat(20_000), input: prompt },
      "",
      1,
      0,
    ],
  ] as const)(
    "projects %s from the admitted native request without retaining raw text",
    async (
      _name,
      body,
      extraHeaders,
      expectedPromptCount,
      expectedCredentialCount,
    ) => {
      const { child, controlSocket, modelPort } = await startGate();
      const childTerminal = terminal(child);
      expect(await configure(controlSocket)).toMatchObject({ status: 200 });
      const socket = await connect(modelPort);
      const completion = collect(socket);
      socket.write(exactRequest(body, extraHeaders));
      expect(await armGate(controlSocket)).toMatchObject({ status: 200 });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const observed = await request(
          controlSocket,
          "/requests",
          {},
          challenge,
          "PUT",
        );
        if ((observed.value.ledger as unknown[]).length === 1) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      expect(await request(controlSocket, "/release", { runId })).toMatchObject(
        {
          status: 200,
        },
      );
      await completion;
      const sealed = await request(controlSocket, "/seal", { runId });
      expect(sealed.status).toBe(200);
      const receipt = sealed.value.receipt as {
        connections: {
          closed: boolean;
          parserTransportClosed: boolean;
          rawForwardedBytes: number;
          rawRejectedBytes: number;
          responseBytes: number;
        }[];
      };
      expect(receipt.connections).toHaveLength(1);
      expect(receipt.connections[0]?.closed).toBe(true);
      expect(receipt.connections[0]?.parserTransportClosed).toBe(true);
      expect(receipt.connections[0]?.rawForwardedBytes).toBeGreaterThan(0);
      expect(receipt.connections[0]?.rawRejectedBytes).toBe(0);
      expect(receipt.connections[0]?.responseBytes).toBeGreaterThan(0);
      const retained = (sealed.value.ledger as Record<string, unknown>[])[0];
      expect(retained).toMatchObject({
        promptOccurrenceCount: expectedPromptCount,
        credentialHeaderCount: expectedCredentialCount,
      });
      expect(JSON.stringify(sealed.value)).not.toContain("secret-canary");
      expect(JSON.stringify(sealed.value)).not.toContain(prompt);
      expect(await childTerminal).toEqual({ code: 0, signal: null });
    },
  );

  it("rejects substituted control authority and duplicate initial sockets", async () => {
    const { controlSocket, modelPort } = await startGate();
    await configure(controlSocket);
    const first = await connect(modelPort);
    const second = await connect(modelPort);
    await new Promise<void>((resolvePromise) =>
      second.once("close", resolvePromise),
    );
    expect(
      await request(
        controlSocket,
        "/arm",
        { runId, sessionStartSpanSha256: "b".repeat(64) },
        "c".repeat(64),
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await request(controlSocket, "/arm", {
        runId,
        sessionStartSpanSha256: "b".repeat(64),
      }),
    ).toMatchObject({ status: 409 });
    expect(await request(controlSocket, "/deny", { runId })).toMatchObject({
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
    const { controlSocket, modelPort } = await startGate();
    await configure(controlSocket, 200);
    const socket = await connect(modelPort);
    const completion = collect(socket);
    expect(await armGate(controlSocket)).toMatchObject({ status: 200 });
    socket.write(
      "POST /v1/responses HTTP/1.1\r\nHost: model\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
    );
    await completion;
    expect(await request(controlSocket, "/deny", { runId })).toMatchObject({
      status: 200,
      value: {
        ledger: [],
        receipt: { ledgerCount: 0, state: "denied" },
      },
    });
  });

  it("permanently denies a second socket during provisional parsing", async () => {
    const { controlSocket, modelPort } = await startGate();
    await configure(controlSocket);
    const first = await connect(modelPort);
    const firstCompletion = collect(first);
    await armGate(controlSocket);
    first.write(
      "POST /v1/responses HTTP/1.1\r\nHost: model\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    const second = await connect(modelPort);
    await collect(second);
    await firstCompletion;
    expect(await request(controlSocket, "/health")).toMatchObject({
      status: 200,
      value: { state: "denied" },
    });
    expect(await request(controlSocket, "/deny", { runId })).toMatchObject({
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

  it("fails closed when an admitted response still owns a live socket at cutoff", async () => {
    const { controlSocket, modelPort } = await startGate();
    await configure(controlSocket, 300);
    const socket = await connect(modelPort);
    const completion = collect(socket);
    await armGate(controlSocket);
    socket.write(exactRequest());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await request(
        controlSocket,
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
    expect(await request(controlSocket, "/release", { runId })).toMatchObject({
      status: 200,
      value: { state: "draining" },
    });
    expect((await completion).toString("utf8")).not.toContain(responseText);
    expect(await request(controlSocket, "/seal", { runId })).toMatchObject({
      status: 409,
    });
    expect(await request(controlSocket, "/deny", { runId })).toMatchObject({
      status: 200,
      value: {
        receipt: {
          cutoffUnsettled: true,
          connections: [
            {
              admission: "admitted",
              closed: true,
            },
          ],
          state: "draining",
        },
      },
    });
  });

  it("rejects an idle later socket when cutoff wins before its request", async () => {
    const { controlSocket, modelPort } = await startGate();
    await configure(controlSocket, 500);
    const first = await connect(modelPort);
    const firstCompletion = collect(first);
    await armGate(controlSocket);
    first.write(exactRequest());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await request(
        controlSocket,
        "/requests",
        {},
        challenge,
        "PUT",
      );
      if ((observed.value.ledger as unknown[]).length === 1) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    await request(controlSocket, "/release", { runId });
    await firstCompletion;
    const idle = await connect(modelPort);
    const idleCompletion = collect(idle);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 520));
    await idleCompletion;
    expect(await request(controlSocket, "/seal", { runId })).toMatchObject({
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
    const { controlSocket, modelPort } = await startGate();
    await configure(controlSocket, 700);
    const first = await connect(modelPort);
    const firstCompletion = collect(first);
    await armGate(controlSocket);
    first.write(exactRequest());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await request(
        controlSocket,
        "/requests",
        {},
        challenge,
        "PUT",
      );
      if ((observed.value.ledger as unknown[]).length === 1) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    await request(controlSocket, "/release", { runId });
    await firstCompletion;
    const partial = await connect(modelPort);
    const partialCompletion = collect(partial).then(
      () => "closed",
      (error: NodeJS.ErrnoException) => error.code ?? "error",
    );
    partial.write("POST /v1/responses HTTP/1.1\r\nHost: model\r\n");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 720));
    partial.end();
    expect(["closed", "ECONNRESET"]).toContain(await partialCompletion);
    expect(await request(controlSocket, "/seal", { runId })).toMatchObject({
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
    const { child, controlSocket, modelPort } = await startGate();
    await configure(controlSocket, 1_200);
    const first = await connect(modelPort);
    const firstCompletion = collect(first);
    await armGate(controlSocket);
    first.write(exactRequest());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await request(
        controlSocket,
        "/requests",
        {},
        challenge,
        "PUT",
      );
      if ((observed.value.ledger as unknown[]).length === 1) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    await request(controlSocket, "/release", { runId });
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
    expect(await request(controlSocket, "/seal", { runId })).toMatchObject({
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

  it("rejects a later request on an already-admitted socket after cutoff", async () => {
    const { controlSocket, modelPort } = await startGate();
    await configure(controlSocket, 400);
    const socket = await connect(modelPort);
    const completion = collect(socket);
    await armGate(controlSocket);
    socket.write(exactRequest());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await request(
        controlSocket,
        "/requests",
        {},
        challenge,
        "PUT",
      );
      if ((observed.value.ledger as unknown[]).length === 1) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 450));
    expect(socket.destroyed).toBe(true);
    await request(controlSocket, "/release", { runId });
    await completion;
    expect(await request(controlSocket, "/seal", { runId })).toMatchObject({
      status: 409,
    });
    expect(await request(controlSocket, "/deny", { runId })).toMatchObject({
      status: 200,
      value: {
        receipt: { cutoffUnsettled: true, ledgerCount: 1, state: "draining" },
      },
    });
  });

  it("rejects post-cutoff raw input before HTTP parsing when the timer is delayed", async () => {
    const { controlSocket, modelPort } = await startGate({
      delayCutoffTimer: true,
    });
    await configure(controlSocket, 400);
    const socket = await connect(modelPort);
    const completion = collect(socket).then(
      () => "closed",
      (error: NodeJS.ErrnoException) => error.code ?? "error",
    );
    await armGate(controlSocket);
    socket.write(exactRequest());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await request(
        controlSocket,
        "/requests",
        {},
        challenge,
        "PUT",
      );
      if ((observed.value.ledger as unknown[]).length === 1) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 450));
    socket.write(exactRequest({ model: "late", input: "late" }));
    expect(["closed", "ECONNRESET"]).toContain(await completion);
    expect(await request(controlSocket, "/seal", { runId })).toMatchObject({
      status: 409,
    });
    expect(await request(controlSocket, "/deny", { runId })).toMatchObject({
      status: 200,
      value: {
        ledger: [{}],
        receipt: {
          cutoffUnsettled: true,
          ledgerCount: 1,
          connections: [
            {
              rawRejectedBytes: exactRequest({ model: "late", input: "late" })
                .length,
            },
          ],
        },
      },
    });
  });

  it("seals within the original reserve despite an incomplete later socket", async () => {
    const { controlSocket, modelPort } = await startGate();
    await configure(controlSocket, 1_500);
    const first = await connect(modelPort);
    const firstCompletion = collect(first);
    await armGate(controlSocket);
    first.write(exactRequest());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await request(
        controlSocket,
        "/requests",
        {},
        challenge,
        "PUT",
      );
      if ((observed.value.ledger as unknown[]).length === 1) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    await request(controlSocket, "/release", { runId });
    await firstCompletion;
    const partial = await connect(modelPort);
    const partialCompletion = collect(partial).then(
      () => "closed",
      (error: NodeJS.ErrnoException) => error.code ?? "error",
    );
    partial.write("POST /v1/responses HTTP/1.1\r\nHost: model\r\n");
    const started = bootNow();
    expect(await request(controlSocket, "/seal", { runId })).toMatchObject({
      status: 200,
      value: { receipt: { ledgerCount: 1, connectionCount: 2 } },
    });
    expect(bootNow() - started).toBeLessThan(1_000);
    expect(["closed", "ECONNRESET"]).toContain(await partialCompletion);
  });

  it("keeps its one protected control connection through a long idle turn", async () => {
    const { controlSocket } = await startGate();
    await configure(controlSocket, 8_000);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_200));
    expect(await request(controlSocket, "/health")).toMatchObject({
      status: 200,
      value: { state: "pending" },
    });
    expect(await request(controlSocket, "/deny", { runId })).toMatchObject({
      status: 200,
      value: { receipt: { state: "denied" } },
    });
  }, 7_000);
});
