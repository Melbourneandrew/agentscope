import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import {
  Agent,
  request as httpRequest,
  createServer as createHttpServer,
  type ClientRequest,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
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
type ChildTerminal = { code: number | null; signal: NodeJS.Signals | null };
type Fixture = {
  child: ChildProcess;
  setupDeadline: number;
  workDeadline: number;
  hardDeadline: number;
  closed: Promise<ChildTerminal>;
  closeObserved: boolean;
  closedAt?: number;
  failure?: Error;
};
const fixtures = new Map<ChildProcess, Fixture>();
const controlFixtures = new Map<string, Fixture>();
const portFixtures = new Map<number, Fixture>();
const rootIdentities = new Map<
  string,
  { dev: number; ino: number; mode: number; uid: number }
>();
type IoReceipt = { closed: Promise<void>; fixture: Fixture; closedAt?: number };
const sockets = new Map<Socket, IoReceipt>();
const pendingRequests = new Map<ClientRequest, IoReceipt>();
const pendingResponses = new Map<IncomingMessage, IoReceipt>();
const probeServers = new Map<HttpServer, IoReceipt>();

const within = async <T>(
  promise: Promise<T>,
  deadline: number,
  failure: string,
): Promise<T> => {
  const remaining = deadline - bootNow();
  if (remaining <= 0) throw new Error(failure);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(failure));
        }, remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const observeChild = (
  child: ChildProcess,
  started: number,
  budget = 5_000,
  setupWindow = 4_000,
): Fixture => {
  const fixture: Fixture = {
    child,
    setupDeadline: Math.min(started + setupWindow, started + budget - 500),
    workDeadline: started + budget - 500,
    hardDeadline: started + budget,
    closed: Promise.resolve({ code: null, signal: null }),
    closeObserved: false,
  };
  fixture.closed = new Promise((resolvePromise) => {
    child.once("error", (error) => {
      fixture.failure = error;
    });
    child.once("close", (code, signal) => {
      fixture.closeObserved = true;
      fixture.closedAt = bootNow();
      resolvePromise({ code, signal });
    });
  });
  let outputBytes = 0;
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 16_384 && fixture.failure === undefined) {
        fixture.failure = new Error("gate-test.child-output");
        child.kill("SIGKILL");
      }
    });
  }
  children.add(child);
  fixtures.set(child, fixture);
  return fixture;
};

const trackRoot = (root: string) => {
  const identity = lstatSync(root);
  controlRoots.add(root);
  rootIdentities.set(root, {
    dev: identity.dev,
    ino: identity.ino,
    mode: identity.mode,
    uid: identity.uid,
  });
};

const observeIo = (
  stream: Socket | ClientRequest | IncomingMessage | HttpServer,
  fixture: Fixture,
): IoReceipt => {
  const receipt: IoReceipt = { closed: Promise.resolve(), fixture };
  receipt.closed = new Promise<void>((resolvePromise) => {
    stream.once("close", () => {
      receipt.closedAt = bootNow();
      resolvePromise();
    });
  });
  return receipt;
};
const joinIo = async (receipt: IoReceipt) => {
  if (receipt.closedAt === undefined)
    await within(
      receipt.closed,
      receipt.fixture.hardDeadline,
      "gate-test.io-not-joined",
    );
  if (
    receipt.closedAt === undefined ||
    receipt.closedAt > receipt.fixture.hardDeadline
  )
    throw new Error("gate-test.io-not-joined");
};
const trackSocket = (socket: Socket, fixture: Fixture) => {
  const receipt = observeIo(socket, fixture);
  socket.on("error", () => {});
  sockets.set(socket, receipt);
};

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
  operation: string | { method: string; deadline: number } = body === undefined
    ? "GET"
    : "POST",
) => {
  const agent = agents.get(controlSocket);
  const fixture = controlFixtures.get(controlSocket);
  if (agent === undefined || fixture === undefined)
    throw new Error("gate-test.agent");
  if (fixture.failure !== undefined) throw fixture.failure;
  if (fixture.closeObserved) throw new Error("gate-test.child-before-request");
  const method = typeof operation === "string" ? operation : operation.method;
  const operationDeadline =
    typeof operation === "string" ? fixture.workDeadline : operation.deadline;
  if (bootNow() >= operationDeadline)
    throw new Error("gate-test.request-deadline");
  let controlRequest: ClientRequest | undefined;
  let response: IncomingMessage | undefined;
  let requestClosed: IoReceipt | undefined;
  let responseClosed: IoReceipt | undefined;
  let timer: NodeJS.Timeout | undefined;
  let completed = false;
  try {
    const result = await new Promise<{
      status: number;
      value: Record<string, unknown>;
    }>((resolvePromise, reject) => {
      const bytes = body === undefined ? undefined : JSON.stringify(body);
      controlRequest = httpRequest(
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
        (value) => {
          response = value;
          responseClosed = observeIo(value, fixture);
          pendingResponses.set(value, responseClosed);
          const chunks: Buffer[] = [];
          let bytesRead = 0;
          let complete = false;
          value.on("data", (chunk: Uint8Array) => {
            bytesRead += chunk.length;
            if (bytesRead > 16_384) {
              reject(new Error("gate-test.response-output"));
              value.destroy();
            } else chunks.push(Buffer.from(chunk));
          });
          value.once("error", reject);
          value.once("aborted", () => {
            reject(new Error("gate-test.response-aborted"));
          });
          value.once("close", () => {
            if (!complete) reject(new Error("gate-test.response-incomplete"));
          });
          value.once("end", () => {
            complete = true;
            try {
              if (bootNow() >= operationDeadline)
                throw new Error("gate-test.request-deadline");
              resolvePromise({
                status: value.statusCode ?? 0,
                value: JSON.parse(
                  Buffer.concat(chunks).toString("utf8"),
                ) as Record<string, unknown>,
              });
            } catch (error) {
              reject(
                error instanceof Error &&
                  error.message === "gate-test.request-deadline"
                  ? error
                  : new Error("gate-test.json"),
              );
            }
          });
        },
      );
      requestClosed = observeIo(controlRequest, fixture);
      pendingRequests.set(controlRequest, requestClosed);
      controlRequest.once("error", reject);
      controlRequest.once("close", () => {
        if (response === undefined)
          reject(new Error("gate-test.request-incomplete"));
      });
      timer = setTimeout(
        () => {
          reject(new Error("gate-test.request-deadline"));
          controlRequest?.destroy();
          response?.destroy();
        },
        Math.max(0, operationDeadline - bootNow()),
      );
      controlRequest.end(bytes);
    });
    completed = true;
    return result;
  } finally {
    clearTimeout(timer);
    if (!completed) {
      controlRequest?.destroy();
      response?.destroy();
    }
    for (const receipt of [requestClosed, responseClosed])
      if (receipt !== undefined) await joinIo(receipt);
    if (controlRequest !== undefined) pendingRequests.delete(controlRequest);
    if (response !== undefined) pendingResponses.delete(response);
  }
};
const startGate = async ({
  delayCutoffTimer = false,
  fixtureBudget = 5_000,
  setupWindow = 4_000,
} = {}) => {
  const started = bootNow();
  const modelPort = await availablePort();
  const controlRoot = mkdtempSync(join(tmpdir(), "agentscope-gate-"));
  trackRoot(controlRoot);
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
  const fixture = observeChild(child, started, fixtureBudget, setupWindow);
  controlFixtures.set(controlSocket, fixture);
  portFixtures.set(modelPort, fixture);
  agents.set(controlSocket, new Agent({ keepAlive: true, maxSockets: 1 }));
  return { child, controlSocket, modelPort };
};
const configure = async (
  controlSocket: string,
  cutoffWindowMs = 5_000,
  clock: () => number = bootNow,
  configureRequest: typeof request = request,
  healthRequest: typeof request = request,
) => {
  const fixture = controlFixtures.get(controlSocket);
  if (fixture === undefined) throw new Error("gate-test.fixture");
  while (true) {
    if (fixture.failure !== undefined) throw fixture.failure;
    if (fixture.closeObserved) throw new Error("gate-test.child-before-ready");
    if (bootNow() >= fixture.setupDeadline)
      throw new Error("gate-test.readiness");
    try {
      const health = await healthRequest(
        controlSocket,
        "/health",
        undefined,
        challenge,
        { method: "GET", deadline: fixture.setupDeadline },
      );
      if (
        health.status !== 200 ||
        Object.keys(health.value).join(",") !== "state" ||
        health.value.state !== "unconfigured"
      )
        throw new Error("gate-test.health");
      break;
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        !["ENOENT", "ECONNREFUSED"].includes(String(error.code))
      )
        throw error;
    }
    await new Promise((resolvePromise) =>
      setTimeout(
        resolvePromise,
        Math.min(10, Math.max(0, fixture.setupDeadline - bootNow())),
      ),
    );
  }
  const cutoff = clock() + cutoffWindowMs;
  while (bootNow() < fixture.setupDeadline) {
    try {
      return await configureRequest(
        controlSocket,
        "/configure",
        {
          challenge,
          cutoff,
          promptSha256,
          responseText,
          runId,
        },
        challenge,
        { method: "POST", deadline: fixture.setupDeadline },
      );
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
  const fixture = portFixtures.get(port);
  if (fixture === undefined) throw new Error("gate-test.fixture");
  let value: Socket | undefined;
  try {
    const socket = await within(
      new Promise<Socket>((resolvePromise, reject) => {
        value = createConnection({ host: "127.0.0.1", port });
        trackSocket(value, fixture);
        value.once("error", reject);
        value.once("connect", () => {
          resolvePromise(value!);
        });
      }),
      fixture.workDeadline,
      "gate-test.connect-deadline",
    );
    return socket;
  } catch (error) {
    value?.destroy();
    throw error;
  }
};
const expectConnectionRefused = async (endpoint: number | string) => {
  const fixture =
    typeof endpoint === "string"
      ? controlFixtures.get(endpoint)
      : portFixtures.get(endpoint);
  if (fixture === undefined) throw new Error("gate-test.fixture");
  await within(
    new Promise<void>((resolvePromise, reject) => {
      const socket =
        typeof endpoint === "string"
          ? createConnection(endpoint)
          : createConnection({ host: "127.0.0.1", port: endpoint });
      trackSocket(socket, fixture);
      socket.once("connect", () => {
        socket.destroy();
        reject(new Error("gate-test.control-open"));
      });
      socket.once("error", () => {
        resolvePromise();
      });
    }),
    fixture.workDeadline,
    "gate-test.refusal-deadline",
  );
};
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
const collect = (socket: Socket) => {
  const tracked = sockets.get(socket);
  if (tracked === undefined) throw new Error("gate-test.socket");
  return within(
    new Promise<Buffer>((resolvePromise, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      socket.on("data", (chunk: Uint8Array) => {
        size += chunk.length;
        if (size > 16_384) {
          socket.destroy();
          reject(new Error("gate-test.model-output"));
        } else chunks.push(Buffer.from(chunk));
      });
      socket.once("error", reject);
      socket.once("close", () => {
        resolvePromise(Buffer.concat(chunks));
      });
    }),
    tracked.fixture.workDeadline,
    "gate-test.collect-deadline",
  );
};
const terminal = (child: ChildProcess) => {
  const fixture = fixtures.get(child)!;
  if (
    fixture.closedAt !== undefined &&
    fixture.closedAt <= fixture.workDeadline
  )
    return fixture.closed;
  return within(
    fixture.closed,
    fixture.workDeadline,
    "gate-test.child-not-terminal",
  );
};

const startProbe = async (
  controlSocket: string,
  handler: (incoming: IncomingMessage, response: ServerResponse) => void,
) => {
  const fixture = controlFixtures.get(controlSocket)!;
  const probeSocket = join(resolve(controlSocket, ".."), "probe.sock");
  const server = createHttpServer(handler);
  probeServers.set(server, observeIo(server, fixture));
  server.on("connection", (socket) => {
    trackSocket(socket, fixture);
  });
  await within(
    new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(probeSocket, resolvePromise);
    }),
    fixture.workDeadline,
    "gate-test.probe-not-ready",
  );
  controlFixtures.set(probeSocket, fixture);
  agents.set(probeSocket, new Agent({ keepAlive: true, maxSockets: 1 }));
  return probeSocket;
};

afterEach(async () => {
  for (const agent of agents.values()) agent.destroy();
  agents.clear();
  for (const value of pendingRequests.keys()) value.destroy();
  for (const value of pendingResponses.keys()) value.destroy();
  for (const socket of sockets.keys()) socket.destroy();
  for (const server of probeServers.keys()) server.close();
  const active = [...children];
  children.clear();
  await Promise.all(
    active.map(async (child) => {
      const fixture = fixtures.get(child)!;
      if (
        !fixture.closeObserved &&
        child.exitCode === null &&
        child.signalCode === null
      )
        child.kill("SIGKILL");
      if (!fixture.closeObserved)
        await within(
          fixture.closed,
          fixture.hardDeadline,
          "gate-test.child-not-joined",
        );
      if (
        fixture.closedAt === undefined ||
        fixture.closedAt > fixture.hardDeadline
      )
        throw new Error("gate-test.child-not-joined");
    }),
  );
  for (const receipt of [
    ...sockets.values(),
    ...pendingRequests.values(),
    ...pendingResponses.values(),
    ...probeServers.values(),
  ])
    await joinIo(receipt);
  sockets.clear();
  pendingRequests.clear();
  pendingResponses.clear();
  probeServers.clear();
  fixtures.clear();
  controlFixtures.clear();
  portFixtures.clear();
  for (const controlRoot of controlRoots) {
    const expected = rootIdentities.get(controlRoot);
    const actual = lstatSync(controlRoot);
    if (
      expected === undefined ||
      !actual.isDirectory() ||
      actual.isSymbolicLink() ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino ||
      actual.mode !== expected.mode ||
      actual.uid !== expected.uid
    )
      throw new Error("gate-test.root-substitution");
    rmSync(controlRoot, { recursive: true });
  }
  controlRoots.clear();
  rootIdentities.clear();
});

describe("gate fixture readiness and terminal settlement", () => {
  it("admits delayed startup within the original case budget before fixing one cutoff", async () => {
    const { controlSocket } = await startGate();
    const readyAt = bootNow() + 1_100;
    const clock = vi.fn(bootNow);
    const delayedHealth: typeof request = async (...arguments_) => {
      if (bootNow() < readyAt)
        throw Object.assign(new Error("not ready"), { code: "ENOENT" });
      return request(...arguments_);
    };
    expect(
      await configure(controlSocket, 5_000, clock, request, delayedHealth),
    ).toMatchObject({
      status: 200,
      value: { state: "pending", runId },
    });
    expect(clock).toHaveBeenCalledTimes(1);
    expect(clock.mock.results[0]?.value).toBeGreaterThanOrEqual(readyAt);
  });

  it("rejects persistent startup absence without entering configuration", async () => {
    const { controlSocket } = await startGate({ setupWindow: 80 });
    const clock = vi.fn(bootNow);
    const configureRequest = vi.fn(request);
    const absent: typeof request = () =>
      Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" }));
    await expect(
      configure(controlSocket, 5_000, clock, configureRequest, absent),
    ).rejects.toThrow("gate-test.readiness");
    expect(clock).not.toHaveBeenCalled();
    expect(configureRequest).not.toHaveBeenCalled();
  });

  it.each([
    { status: 200, value: { state: "pending" } },
    { status: 200, value: { state: "unconfigured", extra: true } },
    { status: 200, value: {} },
    { status: 503, value: { state: "unconfigured" } },
  ])(
    "rejects substituted or unready health %# before configuration",
    async (health) => {
      const { controlSocket } = await startGate();
      const clock = vi.fn(bootNow);
      const configureRequest = vi.fn(request);
      const substituted: typeof request = () => Promise.resolve(health);
      await expect(
        configure(controlSocket, 5_000, clock, configureRequest, substituted),
      ).rejects.toThrow("gate-test.health");
      expect(clock).not.toHaveBeenCalled();
      expect(configureRequest).not.toHaveBeenCalled();
    },
  );

  it("rejects a child already terminal before readiness using its cached close receipt", async () => {
    const { child, controlSocket } = await startGate();
    expect(child.kill("SIGKILL")).toBe(true);
    expect(await terminal(child)).toEqual({ code: null, signal: "SIGKILL" });
    const clock = vi.fn(bootNow);
    await expect(configure(controlSocket, 5_000, clock)).rejects.toThrow(
      "gate-test.child-before-ready",
    );
    expect(clock).not.toHaveBeenCalled();
    expect(await terminal(child)).toEqual({ code: null, signal: "SIGKILL" });
  });

  it("bounds an incomplete health response and joins its owned streams without configuration", async () => {
    const { controlSocket } = await startGate();
    const probeSocket = await startProbe(
      controlSocket,
      (_incoming, response) => {
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": "100",
        });
        response.write("{");
      },
    );
    const deadline = bootNow() + 80;
    const incomplete: typeof request = async (...arguments_) =>
      request(arguments_[0], arguments_[1], arguments_[2], arguments_[3], {
        method: "GET",
        deadline,
      });
    const clock = vi.fn(bootNow);
    const configureRequest = vi.fn(request);
    await expect(
      configure(probeSocket, 5_000, clock, configureRequest, incomplete),
    ).rejects.toThrow("gate-test.request-deadline");
    expect(clock).not.toHaveBeenCalled();
    expect(configureRequest).not.toHaveBeenCalled();
    expect(pendingRequests.size).toBe(0);
    expect(pendingResponses.size).toBe(0);
  });

  it("rejects bounded response overflow instead of parsing or retaining extra bytes", async () => {
    const { controlSocket } = await startGate();
    const probeSocket = await startProbe(
      controlSocket,
      (_incoming, response) => {
        response.end("x".repeat(16_385));
      },
    );
    await expect(request(probeSocket, "/health")).rejects.toThrow(
      "gate-test.response-output",
    );
    expect(pendingRequests.size).toBe(0);
    expect(pendingResponses.size).toBe(0);
  });
});

describe("gate fixture malformed control responses", () => {
  it("rejects malformed health JSON before configuration and joins its streams", async () => {
    const { controlSocket } = await startGate();
    const probeSocket = await startProbe(
      controlSocket,
      (_incoming, response) => {
        response.end("{");
      },
    );
    const clock = vi.fn(bootNow);
    const configureRequest = vi.fn(request);
    await expect(
      configure(probeSocket, 5_000, clock, configureRequest),
    ).rejects.toThrow("gate-test.json");
    expect(clock).not.toHaveBeenCalled();
    expect(configureRequest).not.toHaveBeenCalled();
    expect(pendingRequests.size).toBe(0);
    expect(pendingResponses.size).toBe(0);
  });

  it("rejects an aborted health body before configuration and joins its streams", async () => {
    const { controlSocket } = await startGate();
    const probeSocket = await startProbe(
      controlSocket,
      (_incoming, response) => {
        response.writeHead(200, { "content-length": "100" });
        response.write("{");
        setImmediate(() => response.destroy());
      },
    );
    const clock = vi.fn(bootNow);
    const configureRequest = vi.fn(request);
    await expect(
      configure(probeSocket, 5_000, clock, configureRequest),
    ).rejects.toThrow("gate-test.response-aborted");
    expect(clock).not.toHaveBeenCalled();
    expect(configureRequest).not.toHaveBeenCalled();
    expect(pendingRequests.size).toBe(0);
    expect(pendingResponses.size).toBe(0);
  });
});

// eslint-disable-next-line max-lines-per-function -- closed adversarial state-machine matrix
describe("gate-capable exact-build MockServer", () => {
  it("refuses to create its own control authority directory", async () => {
    const modelPort = await availablePort();
    const controlRoot = mkdtempSync(join(tmpdir(), "agentscope-gate-"));
    trackRoot(controlRoot);
    const started = bootNow();
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
    observeChild(child, started);
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
      await request(
        controlSocket,
        "/connection-count",
        {},
        "c".repeat(64),
        "PUT",
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
    const partialRequest = "POST /v1/responses HTTP/1.1\r\nHost: model\r\n";
    partial.write(partialRequest);
    let secondFramingObserved = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await request(
        controlSocket,
        "/connection-count",
        {},
        challenge,
        "PUT",
      );
      if (
        observed.value.connectionCount === 2 &&
        observed.value.latestAdmission === "admitted" &&
        observed.value.latestRawForwardedBytes ===
          Buffer.byteLength(partialRequest)
      ) {
        secondFramingObserved = true;
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    expect(secondFramingObserved).toBe(true);
    const started = bootNow();
    expect(await request(controlSocket, "/seal", { runId })).toMatchObject({
      status: 200,
      value: {
        receipt: {
          ledgerCount: 1,
          connectionCount: 2,
          parserFailures: 1,
          connections: [
            {},
            {
              closed: true,
              parserOutcome: "rejected",
              rawForwardedBytes: Buffer.byteLength(partialRequest),
            },
          ],
        },
      },
    });
    expect(bootNow() - started).toBeLessThan(1_000);
    expect(["closed", "ECONNRESET"]).toContain(await partialCompletion);
  });

  it("keeps its one protected control connection through a long idle turn", async () => {
    const { controlSocket } = await startGate({ fixtureBudget: 7_000 });
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
