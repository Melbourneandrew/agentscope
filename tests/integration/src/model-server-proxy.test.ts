/* eslint-disable max-lines-per-function, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { PassThrough, Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error The private executable deliberately has no public declaration surface.
import { createModelProxy } from "../model-server-proxy.mjs";

const route = Object.freeze({
  headers: {
    authorization: "Bearer fixture",
    "content-type": "application/json",
  },
  method: "POST",
  path: "/v1/responses",
  provider: "fixture",
  requestBody: { input: "fixture" },
  responseBody: { id: "fixture" },
  routeId: "fixture",
});
const invoke = async (
  handler: ReturnType<typeof createModelProxy>["candidateHandler"],
  input: {
    body?: string;
    headers?: Record<string, string>;
    method?: string;
    socket?: object;
    url: string;
  },
) => {
  const request = Readable.from(input.body === undefined ? [] : [input.body]);
  Object.assign(request, {
    headers: input.headers ?? {},
    method: input.method ?? "GET",
    ...(input.socket === undefined ? {} : { socket: input.socket }),
    url: input.url,
  });
  let status = 0;
  let body = "";
  const response = {
    end: (value: string) => {
      body = value;
    },
    writeHead: (value: number) => {
      status = value;
    },
  };
  await handler(request, response);
  return { body: JSON.parse(body || "{}") as unknown, status };
};
const create = () => {
  const fetchImpl = vi.fn(() =>
    Promise.resolve({
      status: 200,
      text: () => Promise.resolve(JSON.stringify(route.responseBody)),
    }),
  );
  return {
    fetchImpl,
    proxy: createModelProxy({
      fetchImpl,
      routes: [route],
      scenarioId: "fixture-scenario",
      upstream: "http://mockserver-control:1080",
    }),
  };
};

describe("model inference proxy", () => {
  it("irreversibly rejects admission after any pre-admission contact", async () => {
    for (const url of [
      "/v1/responses",
      "/mockserver/clear?type=log",
      "/mockserver/reset",
      "/agentscope/ledger",
      "/unknown",
    ]) {
      const { proxy } = create();
      const handler = proxy.candidateHandler;
      expect((await invoke(handler, { url })).status).toBe(409);
      expect(
        (await invoke(handler, { method: "POST", url: "/agentscope/admit" }))
          .status,
      ).toBe(409);
    }
  });

  it("admits once and forwards only the exact inference grammar", async () => {
    const { fetchImpl, proxy } = create();
    const handler = proxy.candidateHandler;
    expect(
      (await invoke(handler, { method: "POST", url: "/agentscope/admit" }))
        .status,
    ).toBe(204);
    expect(
      (
        await invoke(handler, {
          body: JSON.stringify(route.requestBody),
          headers: route.headers,
          method: "POST",
          url: route.path,
        })
      ).status,
    ).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const mutation of [
      { body: "{}", headers: route.headers, method: "POST", url: route.path },
      {
        body: JSON.stringify(route.requestBody),
        headers: {},
        method: "POST",
        url: route.path,
      },
      {
        body: JSON.stringify(route.requestBody),
        headers: route.headers,
        method: "GET",
        url: route.path,
      },
      {
        body: JSON.stringify(route.requestBody),
        headers: route.headers,
        method: "POST",
        url: `${route.path}?extra=1`,
      },
      { url: "/mockserver/clear?type=log" },
    ])
      expect((await invoke(handler, mutation)).status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await invoke(handler, { url: "/agentscope/ready" })).status).toBe(
      200,
    );
    expect((await invoke(handler, { url: "/agentscope/ledger" })).status).toBe(
      404,
    );
    const ledger = await invoke(proxy.controlHandler, {
      method: "POST",
      url: "/agentscope/seal",
    });
    expect(ledger.status).toBe(200);
    expect(ledger.body).toMatchObject({
      activeBodyCount: 0,
      inFlightRequestCount: 0,
      ledgerVersion: 1,
      overflow: false,
      pendingConnectionCount: 0,
      scenarioId: "fixture-scenario",
    });
  });

  it("fails closed for endpoint substitution and upstream uncertainty", async () => {
    expect(() =>
      createModelProxy({
        fetchImpl: fetch,
        routes: [route],
        scenarioId: "fixture-scenario",
        upstream: "http://mockserver:1080",
      }),
    ).toThrow("integration.model-proxy.authority");
    const { proxy } = create();
    const handler = proxy.candidateHandler;
    await invoke(handler, { method: "POST", url: "/agentscope/admit" });
    const oversized = "x".repeat(1024 * 1024 + 1);
    expect(
      (
        await invoke(handler, {
          body: oversized,
          headers: route.headers,
          method: "POST",
          url: route.path,
        })
      ).status,
    ).toBe(413);
  });

  it("records parser-rejected and incomplete transports before admission", async () => {
    for (const outcome of ["parser", "close"]) {
      const { proxy } = create();
      const socket = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
      });
      proxy.observeConnection(socket);
      if (outcome === "parser") {
        proxy.observeClientError(new Error(), socket);
        socket.emit("close");
      } else socket.emit("close");
      expect(
        (
          await invoke(proxy.candidateHandler, {
            method: "POST",
            url: "/agentscope/admit",
          })
        ).status,
      ).toBe(409);
      const ledger = await invoke(proxy.controlHandler, {
        method: "POST",
        url: "/agentscope/seal",
      });
      expect(ledger.body).toMatchObject({ overflow: false });
      expect(JSON.stringify(ledger.body)).toContain(
        outcome === "parser" ? "parser-rejected" : "connection-without-request",
      );
    }
  });

  it("latches bounded ledger overflow and permits no later success", async () => {
    const { fetchImpl, proxy } = create();
    await invoke(proxy.candidateHandler, {
      method: "POST",
      url: "/agentscope/admit",
    });
    for (let index = 0; index < 4_097; index += 1)
      await invoke(proxy.candidateHandler, { url: `/rejected-${index}` });
    const ledger = await invoke(proxy.controlHandler, {
      method: "POST",
      url: "/agentscope/seal",
    });
    expect(ledger.body).toMatchObject({ overflow: true });
    expect(
      (
        await invoke(proxy.candidateHandler, {
          body: JSON.stringify(route.requestBody),
          headers: route.headers,
          method: "POST",
          url: route.path,
        })
      ).status,
    ).toBe(409);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to seal while an accepted request is still in flight", async () => {
    let settle:
      | ((value: { status: number; text: () => Promise<string> }) => void)
      | undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise((resolve) => {
          settle = (value) => {
            resolve(value);
          };
        }),
    );
    const proxy = createModelProxy({
      fetchImpl,
      routes: [route],
      scenarioId: "fixture-scenario",
      upstream: "http://mockserver-control:1080",
    });
    await invoke(proxy.candidateHandler, {
      method: "POST",
      url: "/agentscope/admit",
    });
    const request = invoke(proxy.candidateHandler, {
      body: JSON.stringify(route.requestBody),
      headers: route.headers,
      method: "POST",
      url: route.path,
    });
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    expect(
      (
        await invoke(proxy.controlHandler, {
          method: "POST",
          url: "/agentscope/seal",
        })
      ).status,
    ).toBe(409);
    if (settle === undefined) throw new Error("missing fixture settlement");
    settle({
      status: 200,
      text: () => Promise.resolve(JSON.stringify(route.responseBody)),
    });
    await expect(request).resolves.toMatchObject({ status: 200 });
  });

  it("records an incomplete parsed body before later admission", async () => {
    const { proxy } = create();
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    proxy.observeConnection(socket);
    const request = Object.assign(
      Readable.from(
        (async function* () {
          await Promise.resolve();
          yield "x";
          throw new Error("fixture body abort");
        })(),
      ),
      {
        headers: { "content-length": "10" },
        method: "POST",
        socket,
        url: route.path,
      },
    );
    await proxy.candidateHandler(request, {
      destroy: vi.fn(),
      end: vi.fn(),
      writeHead: vi.fn(),
    });
    expect(
      (
        await invoke(proxy.candidateHandler, {
          method: "POST",
          url: "/agentscope/admit",
        })
      ).status,
    ).toBe(409);
  });

  it("makes the sealed ledger terminal before later transport callbacks", async () => {
    const { fetchImpl, proxy } = create();
    await invoke(proxy.candidateHandler, {
      method: "POST",
      url: "/agentscope/admit",
    });
    expect(
      (
        await invoke(proxy.controlHandler, {
          method: "POST",
          url: "/agentscope/seal",
        })
      ).status,
    ).toBe(200);
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    proxy.observeConnection(socket);
    proxy.observeClientError(new Error(), socket);
    expect(socket.destroy).toHaveBeenCalledTimes(2);
    expect(
      (
        await invoke(proxy.candidateHandler, {
          body: JSON.stringify(route.requestBody),
          headers: route.headers,
          method: "POST",
          url: route.path,
        })
      ).status,
    ).toBe(409);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to seal while a reused socket has a hanging request body", async () => {
    const { proxy } = create();
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    proxy.observeConnection(socket);
    await invoke(proxy.candidateHandler, {
      method: "POST",
      socket,
      url: "/agentscope/admit",
    });
    const body = new PassThrough();
    const request = Object.assign(body, {
      headers: { "content-length": "10" },
      method: "POST",
      socket,
      url: route.path,
    });
    const response = { destroy: vi.fn(), end: vi.fn(), writeHead: vi.fn() };
    const pending = proxy.candidateHandler(request, response);
    await Promise.resolve();
    expect(
      (
        await invoke(proxy.controlHandler, {
          method: "POST",
          url: "/agentscope/seal",
        })
      ).status,
    ).toBe(409);
    body.destroy(new Error("fixture body abort"));
    await pending;
  });

  it("requires the real candidate socket to close before sealing", async () => {
    const { proxy } = create();
    const server = createServer(proxy.candidateHandler);
    server.on("connection", proxy.observeConnection);
    server.on("clientError", proxy.observeClientError);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("missing fixture address");
    const observedConnection = once(server, "connection");
    const socket = createConnection(address.port, "127.0.0.1");
    socket.on("error", () => undefined);
    await once(socket, "connect");
    await observedConnection;
    socket.write(
      "POST /agentscope/admit HTTP/1.1\r\nHost: fixture\r\nContent-Length: 10\r\n\r\nx",
    );
    expect(
      (
        await invoke(proxy.controlHandler, {
          method: "POST",
          url: "/agentscope/seal",
        })
      ).status,
    ).toBe(409);
    socket.destroy();
    await once(socket, "close");
    await vi.waitFor(async () => {
      expect(
        (
          await invoke(proxy.controlHandler, {
            method: "POST",
            url: "/agentscope/seal",
          })
        ).status,
      ).toBe(200);
    });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  });
});
