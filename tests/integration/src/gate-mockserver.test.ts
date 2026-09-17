import { spawn, type ChildProcess } from "node:child_process";
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
  const options: RequestInit = { method };
  if (body !== undefined) {
    options.headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(
    `http://127.0.0.1:${controlPort}${path}`,
    options,
  );
  return {
    status: response.status,
    value: (await response.json()) as Record<string, unknown>,
  };
};
const waitForHealth = async (controlPort: number) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const result = await request(controlPort, "/health");
      if (result.status === 200) return result.value;
    } catch {
      // The exact child has not bound its control socket yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("gate-test.health");
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
  expect(await waitForHealth(controlPort)).toEqual({ state: "unconfigured" });
  return { child, controlPort, modelPort };
};
const configure = (controlPort: number, cutoff = bootNow() + 5_000) =>
  request(controlPort, "/configure", {
    challenge,
    cutoff,
    responseText,
    runId,
  });
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

afterEach(async () => {
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

describe("gate-capable exact-build MockServer", () => {
  it("holds the first socket below HTTP parsing until the exact span is armed", async () => {
    const { controlPort, modelPort } = await startGate();
    expect(await configure(controlPort)).toMatchObject({
      status: 200,
      value: { runId, state: "pending" },
    });
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
      value: { receipt: { state: "denied" } },
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
    expect(await waitForHealth(controlPort)).toEqual({ state: "denied" });
    expect(await request(controlPort, "/deny", { runId })).toMatchObject({
      status: 200,
      value: {
        ledger: [],
        receipt: { ledgerCount: 0, state: "denied" },
      },
    });
  });
});
