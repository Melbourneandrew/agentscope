import { createServer, request as httpRequest } from "node:http";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { downloadAttestationMetadata } from "../harness-material.mjs";

const acquireMetadata = async (
  headers: Record<string, string>,
  body: string,
  maximumBytes = 64,
  status = 200,
) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(status, { connection: "close", ...headers });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("address");
    const value = await downloadAttestationMetadata(
      { url: "https://registry.npmjs.org/test-attestation", maximumBytes },
      new AbortController().signal,
      performance.now() + 3_000,
      (options, callback) =>
        httpRequest(
          {
            ...options,
            protocol: "http:",
            hostname: "127.0.0.1",
            port: address.port,
          },
          callback,
        ),
    );
    return value;
  } finally {
    expect(requests).toBe(1);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
};

describe("bounded attestation metadata transport", () => {
  it.each(["{}", "{\n }", '{"attestations":[]}'])(
    "accepts complete variable-length JSON transport, not a historical byte pin (%s)",
    async (body) => {
      expect(
        (
          await acquireMetadata(
            { "content-length": String(Buffer.byteLength(body)) },
            body,
          )
        ).toString(),
      ).toBe(body);
    },
  );
  it("accepts bounded complete chunked transport", async () => {
    expect(
      (
        await acquireMetadata({ "transfer-encoding": "chunked" }, "{}")
      ).toString(),
    ).toBe("{}");
  });
  it.each([
    [{ "content-length": "65" }, "{}", 200],
    [{ "content-length": "03" }, "{}", 200],
    [{ "content-length": "0" }, "", 200],
    [{ "content-length": "3" }, "{}", 200],
    [{ "content-encoding": "gzip" }, "{}", 200],
    [{ location: "https://other.example/" }, "{}", 200],
    [{}, "{}", 503],
    [{}, "x".repeat(65), 200],
  ])(
    "rejects malformed, truncated, redirected, encoded or oversized transport",
    async (headers, body, status) => {
      await expect(
        acquireMetadata(headers, body, 64, status),
      ).rejects.toBeInstanceOf(Error);
    },
  );
});

const controlledTransport = () => {
  const response = Object.assign(new EventEmitter(), {
    headers: { "content-length": "2" },
    statusCode: 200,
    complete: true,
    destroy() {
      /* test owns the response terminal event */
    },
  });
  const child = Object.assign(new EventEmitter(), {
    destroy() {
      queueMicrotask(() => child.emit("close"));
    },
    end() {
      queueMicrotask(() => {
        callback(response as unknown as IncomingMessage);
        response.emit("data", Buffer.from("{}"));
        response.emit("end");
        child.emit("close");
      });
    },
  });
  let callback: (response: IncomingMessage) => void;
  const transport = (_options: unknown, incoming: typeof callback) => {
    callback = incoming;
    return child as unknown as ClientRequest;
  };
  return { response, transport };
};

describe("metadata terminal authority", () => {
  it.each([false, true])(
    "waits for both closes and rechecks cancellation (%s)",
    async (cancel) => {
      const fixture = controlledTransport();
      const controller = new AbortController();
      let settled = false;
      const acquisition = downloadAttestationMetadata(
        {
          url: "https://registry.npmjs.org/test-attestation",
          maximumBytes: 64,
        },
        controller.signal,
        performance.now() + 3_000,
        fixture.transport,
      );
      const observed = acquisition
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          settled = true;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      if (cancel) controller.abort();
      fixture.response.emit("close");
      const result = await observed;
      if (cancel)
        expect(result).toMatchObject({ error: { message: "interrupted" } });
      else expect(result).toEqual({ value: Buffer.from("{}") });
    },
  );
  it("rejects an expired authority before starting transport", async () => {
    let called = false;
    await expect(
      downloadAttestationMetadata(
        {
          url: "https://registry.npmjs.org/test-attestation",
          maximumBytes: 64,
        },
        new AbortController().signal,
        performance.now() - 1,
        () => {
          called = true;
          throw new Error("unreachable");
        },
      ),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});
