import { createServer, request as httpRequest } from "node:http";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import {
  downloadAttestationMetadata,
  downloadMockServerJdkArchive,
} from "../harness-material.mjs";
import { downloadMaterialObject } from "../material-download.mjs";

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

const releaseFixture = (
  location: unknown = "https://release-assets.githubusercontent.com/release/canary",
) => {
  const headers: Record<string, unknown> = { location, "content-length": "0" };
  const response = Object.assign(new EventEmitter(), {
    headers,
    rawHeaders: ["Location", location],
    statusCode: 302,
    complete: true,
    destroy() {
      queueMicrotask(() => response.emit("close"));
    },
  });
  let callback: (response: IncomingMessage) => void;
  const request = Object.assign(new EventEmitter(), {
    destroy() {
      queueMicrotask(() => request.emit("close"));
    },
    end() {
      queueMicrotask(() => {
        callback(response as unknown as IncomingMessage);
      });
    },
  });
  const transport = (_options: unknown, incoming: typeof callback) => {
    callback = incoming;
    return request as unknown as ClientRequest;
  };
  return { response, request, transport };
};
const releaseDescriptor = {
  url: "https://github.com/adoptium/temurin17-binaries/releases/download/canary",
  bytes: 2,
};

describe("wire release redirect headers", () => {
  it.each([false, true])(
    "rejects duplicate Location on the wire (%s)",
    async (mixedCase) => {
      const server = createServer((_request, response) => {
        response.writeHead(302, [
          "Location",
          "https://release-assets.githubusercontent.com/release/canary",
          mixedCase ? "lOcAtIoN" : "Location",
          "https://other.invalid/release/canary",
          "Content-Length",
          "0",
        ]);
        response.end();
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("address");
        await expect(
          downloadMaterialObject(
            releaseDescriptor,
            new AbortController().signal,
            performance.now() + 3_000,
            (_options, callback) =>
              httpRequest(
                { hostname: "127.0.0.1", port: address.port, agent: false },
                callback,
              ),
            "release-asset",
          ),
        ).rejects.toThrow("redirect");
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          }),
        );
      }
    },
  );
});

describe("one-hop release transport closure", () => {
  it.each([false, true])(
    "requires a complete final response (%s)",
    async (complete) => {
      const fixture = releaseFixture();
      fixture.response.statusCode = 200;
      fixture.response.complete = complete;
      delete fixture.response.headers.location;
      fixture.response.headers["content-length"] = "2";
      const acquisition = downloadMaterialObject(
        releaseDescriptor,
        new AbortController().signal,
        performance.now() + 3_000,
        fixture.transport,
        "release-body",
      );
      const observed = acquisition.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      fixture.response.emit("data", Buffer.from("{}"));
      fixture.response.emit("end");
      fixture.response.emit("close");
      fixture.request.emit("close");
      if (complete)
        expect(await observed).toEqual({ value: Buffer.from("{}") });
      else expect(await observed).toMatchObject({ error: { message: "size" } });
    },
  );

  it("expires the original deadline without admitting hop two", async () => {
    const fixture = releaseFixture();
    let requests = 0;
    const acquisition = downloadMockServerJdkArchive(
      new AbortController().signal,
      performance.now() + 50,
      (options, callback) => {
        requests += 1;
        return fixture.transport(options, callback);
      },
    );
    const observed = expect(acquisition).rejects.toThrow("deadline");
    await new Promise<void>((resolve) => setImmediate(resolve));
    fixture.response.emit("end");
    fixture.request.emit("close");
    await observed;
    expect(requests).toBe(1);
  });
  it.each([false, true])(
    "waits for both redirect closes in either order (%s)",
    async (requestFirst) => {
      const fixture = releaseFixture();
      let settled = false;
      const acquisition = downloadMaterialObject(
        releaseDescriptor,
        new AbortController().signal,
        performance.now() + 3_000,
        fixture.transport,
        "release-asset",
      ).finally(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      fixture.response.emit("end");
      (requestFirst ? fixture.request : fixture.response).emit("close");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      (requestFirst ? fixture.response : fixture.request).emit("close");
      expect(await acquisition).toBe(
        "https://release-assets.githubusercontent.com/release/canary",
      );
    },
  );
});

describe("closed release redirect rejection", () => {
  it.each([
    undefined,
    [],
    "http://release-assets.githubusercontent.com/a",
    "https://other.invalid/a",
    "https://user@release-assets.githubusercontent.com/a",
    "https://release-assets.githubusercontent.com:443/a",
    "https://release-assets.githubusercontent.com/a#fragment",
    "https://release-assets.githubusercontent.com/" + "x".repeat(16_384),
  ])("rejects nonclosed Location %#", async (location) => {
    const fixture = releaseFixture(location);
    if (location === undefined) delete fixture.response.headers.location;
    await expect(
      downloadMaterialObject(
        releaseDescriptor,
        new AbortController().signal,
        performance.now() + 3_000,
        fixture.transport,
        "release-asset",
      ),
    ).rejects.toThrow("redirect");
  });

  it.each(["incomplete", "overflow", "encoding", "length", "status"])(
    "rejects redirect framing %s",
    async (kind) => {
      const fixture = releaseFixture();
      if (kind === "incomplete") fixture.response.complete = false;
      if (kind === "encoding")
        fixture.response.headers["content-encoding"] = "gzip";
      if (kind === "length") fixture.response.headers["content-length"] = "000";
      if (kind === "status") fixture.response.statusCode = 307;
      const acquisition = downloadMaterialObject(
        releaseDescriptor,
        new AbortController().signal,
        performance.now() + 3_000,
        fixture.transport,
        "release-asset",
      );
      const observed = expect(acquisition).rejects.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (kind === "overflow")
        fixture.response.emit("data", Buffer.alloc(16_385));
      fixture.response.emit("end");
      fixture.response.emit("close");
      fixture.request.emit("close");
      await observed;
    },
  );

  it("blocks hop two if cancellation happens before terminal handoff", async () => {
    const fixture = releaseFixture();
    const controller = new AbortController();
    let requests = 0;
    const acquisition = downloadMockServerJdkArchive(
      controller.signal,
      performance.now() + 3_000,
      (options, callback) => {
        requests += 1;
        return fixture.transport(options, callback);
      },
    );
    const observed = expect(acquisition).rejects.toThrow("interrupted");
    await new Promise<void>((resolve) => setImmediate(resolve));
    fixture.response.emit("end");
    fixture.request.emit("close");
    controller.abort();
    fixture.response.emit("close");
    await observed;
    expect(requests).toBe(1);
  });

  it("does not admit a second redirect", async () => {
    let requests = 0;
    const acquisition = downloadMockServerJdkArchive(
      new AbortController().signal,
      performance.now() + 3_000,
      (options, callback) => {
        requests += 1;
        const fixture = releaseFixture();
        const handle = fixture.transport(options, callback);
        queueMicrotask(() => {
          queueMicrotask(() => {
            fixture.response.emit("end");
            fixture.response.emit("close");
            fixture.request.emit("close");
          });
        });
        return handle;
      },
    );
    await expect(acquisition).rejects.toThrow("status");
    expect(requests).toBe(2);
  });
});
