import { createServer, request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import type { RequestOptions } from "node:https";

import { describe, expect, it } from "vitest";

import {
  classifyAttestationFailurePhaseForTesting,
  downloadAttestationWithRetry,
  downloadRegularHarnessMaterialForTesting,
} from "../harness-material.mjs";

describe("attestation response framing", () => {
  it.each(["2", "0"])(
    "retries one bad length-header response (%s) within the same deadline",
    async (badLength) => {
      let attempts = 0;
      const server = createServer((_request, response) => {
        attempts += 1;
        response.writeHead(200, {
          "content-length": attempts === 1 ? badLength : "1",
          connection: "close",
        });
        response.end("x");
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("missing test server address");
        const bytes = await downloadAttestationWithRetry(
          { url: "https://registry.npmjs.org/test-attestation", bytes: 1 },
          new AbortController().signal,
          performance.now() + 3_000,
          (options, callback) =>
            httpRequest(
              {
                ...options,
                hostname: "127.0.0.1",
                port: address.port,
                protocol: "http:",
              },
              callback,
            ),
        );
        expect(bytes.toString()).toBe("x");
        expect(attempts).toBe(2);
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

  it.each([
    ["2", "0", 200, "hdr-long-then-hdr-short"],
    ["0", "2", 200, "hdr-short-then-hdr-long"],
    ["01", "01", 200, "hdr-noncanon-then-hdr-noncanon"],
    ["2", "1", 503, "hdr-long-then-upstream"],
  ])(
    "fails closed after a bad header and a second rejection (%s then %s, status %s)",
    async (firstLength, secondLength, secondStatus, expectedReason) => {
      let attempts = 0;
      const server = createServer((_request, response) => {
        attempts += 1;
        response.writeHead(attempts === 1 ? 200 : secondStatus, {
          "content-length": attempts === 1 ? firstLength : secondLength,
          connection: "close",
        });
        response.end("x");
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("missing test server address");
        let failure: unknown;
        try {
          await downloadAttestationWithRetry(
            { url: "https://registry.npmjs.org/test-attestation", bytes: 1 },
            new AbortController().signal,
            performance.now() + 3_000,
            (options, callback) =>
              httpRequest(
                {
                  ...options,
                  hostname: "127.0.0.1",
                  port: address.port,
                  protocol: "http:",
                },
                callback,
              ),
          );
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        const phase = classifyAttestationFailurePhaseForTesting(
          {
            installName: "@openai/codex-linux-x64",
            packageName: "@openai/codex",
          },
          failure,
        );
        expect(phase).toBe(`download-attestation-variant-${expectedReason}`);
        expect(`integration.harness-material.${phase}`).toMatch(
          /^integration\.[a-z.-]{1,96}$/u,
        );
        expect(attempts).toBe(2);
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

describe("attestation cancellation", () => {
  it("never starts a retry after cancellation during first close", async () => {
    let attempts = 0;
    let transportCalls = 0;
    let sawBadHeader = false;
    const controller = new AbortController();
    const server = createServer((_request, response) => {
      attempts += 1;
      response.writeHead(200, { "content-length": "2", connection: "close" });
      response.end("x");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("missing test server address");
      await expect(
        downloadAttestationWithRetry(
          { url: "https://registry.npmjs.org/test-attestation", bytes: 1 },
          controller.signal,
          performance.now() + 3_000,
          (options, callback) => {
            transportCalls += 1;
            const client = httpRequest(
              {
                ...options,
                hostname: "127.0.0.1",
                port: address.port,
                protocol: "http:",
              },
              (response) => {
                sawBadHeader = response.headers["content-length"] === "2";
                callback(response);
              },
            );
            client.once("close", () => {
              controller.abort();
            });
            return client;
          },
        ),
      ).rejects.toThrow("interrupted");
      expect(sawBadHeader).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(transportCalls).toBe(1);
      expect(attempts).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });
});

const pinnedAttestation = Object.freeze({
  url: "https://registry.npmjs.org/test-attestation",
  bytes: 1,
  sha256: createHash("sha256").update("x").digest("hex"),
});

const withPinnedLoopback = async (
  respond: (request: IncomingMessage, response: ServerResponse) => void,
  run: (
    transport: (
      options: RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => ClientRequest,
    controller: AbortController,
  ) => Promise<void>,
) => {
  const server = createServer(respond);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("missing test server address");
    const transport = (
      options: RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) =>
      httpRequest(
        {
          ...options,
          hostname: "127.0.0.1",
          port: address.port,
          protocol: "http:",
        },
        callback,
      );
    await run(transport, controller);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
};

describe("pinned overlong attestation framing", () => {
  it.each(["request", "response"])(
    "waits for both terminal closes when %s closes first",
    async (firstToClose) => {
      let allowSecond!: () => void;
      let notifyFirst!: () => void;
      const secondClose = new Promise<void>((resolve) => {
        allowSecond = resolve;
      });
      const firstClose = new Promise<void>((resolve) => {
        notifyFirst = resolve;
      });
      const transport = (
        _options: RequestOptions,
        callback: (response: IncomingMessage) => void,
      ): ClientRequest => {
        const response = Object.assign(new PassThrough(), {
          statusCode: 200,
          headers: { "content-length": "2" },
          complete: false,
        }) as unknown as IncomingMessage;
        const client = Object.assign(new EventEmitter(), {
          destroy: () => {},
          end: () => {
            queueMicrotask(() => {
              callback(response);
              response.emit("data", Buffer.from("x"));
              response.emit("aborted");
              response.emit(
                "error",
                Object.assign(new Error("framing aborted"), {
                  code: "ECONNRESET",
                }),
              );
              const first = firstToClose === "request" ? client : response;
              const second = firstToClose === "request" ? response : client;
              first.emit("close");
              notifyFirst();
              void secondClose.then(() => {
                second.emit("close");
              });
            });
          },
        }) as unknown as ClientRequest;
        return client;
      };
      let settled = false;
      const result = downloadAttestationWithRetry(
        pinnedAttestation,
        new AbortController().signal,
        performance.now() + 3_000,
        transport,
      ).then((bytes) => {
        settled = true;
        return bytes;
      });
      await firstClose;
      expect(settled).toBe(false);
      allowSecond();
      expect((await result).toString()).toBe("x");
    },
  );
});

describe("pinned overlong attestation loopback", () => {
  it("keeps the strict header veto for ordinary pinned material", async () => {
    let attempts = 0;
    await withPinnedLoopback(
      (_request, response) => {
        attempts += 1;
        response.writeHead(200, { "content-length": "2", connection: "close" });
        response.end("x");
      },
      async (transport, controller) => {
        await expect(
          downloadRegularHarnessMaterialForTesting(
            pinnedAttestation,
            controller.signal,
            performance.now() + 3_000,
            transport,
          ),
        ).rejects.toThrow("hdr-long");
        expect(attempts).toBe(1);
      },
    );
  });

  it("accepts exact pinned bytes only after parser abort and both closes", async () => {
    let attempts = 0;
    await withPinnedLoopback(
      (_request, response) => {
        attempts += 1;
        response.writeHead(200, { "content-length": "2", connection: "close" });
        response.end("x");
      },
      async (transport, controller) => {
        let requestClosed = false;
        let responseClosed = false;
        const observedTransport = (
          options: RequestOptions,
          callback: (response: IncomingMessage) => void,
        ) => {
          const client = transport(options, (response) => {
            response.once("close", () => {
              responseClosed = true;
            });
            callback(response);
          });
          client.once("close", () => {
            requestClosed = true;
          });
          return client;
        };
        const bytes = await downloadAttestationWithRetry(
          pinnedAttestation,
          controller.signal,
          performance.now() + 3_000,
          observedTransport,
        );
        expect(bytes.toString()).toBe("x");
        expect(attempts).toBe(1);
        expect(requestClosed).toBe(true);
        expect(responseClosed).toBe(true);
      },
    );
  });

  it.each([
    ["y", "2", "hdr-long", 2],
    ["xy", "3", "size", 1],
    ["x", "0", "hdr-short", 2],
  ])(
    "rejects unauthenticated body %s with header %s",
    async (body, header, reason, expectedAttempts) => {
      let attempts = 0;
      await withPinnedLoopback(
        (_request, response) => {
          attempts += 1;
          response.writeHead(200, {
            "content-length": header,
            connection: "close",
          });
          response.end(body);
        },
        async (transport, controller) => {
          await expect(
            downloadAttestationWithRetry(
              pinnedAttestation,
              controller.signal,
              performance.now() + 3_000,
              transport,
            ),
          ).rejects.toThrow(reason);
          expect(attempts).toBe(expectedAttempts);
        },
      );
    },
  );

  it.each(["abort", "deadline"])(
    "does not accept exact bytes when %s wins before close",
    async (ending) => {
      await withPinnedLoopback(
        (_request, response) => {
          response.writeHead(200, { "content-length": "2" });
          response.write("x");
        },
        async (transport, controller) => {
          if (ending === "abort")
            setTimeout(() => {
              controller.abort();
            }, 20);
          await expect(
            downloadAttestationWithRetry(
              pinnedAttestation,
              controller.signal,
              performance.now() + 80,
              transport,
            ),
          ).rejects.toThrow(ending === "abort" ? "interrupted" : "deadline");
        },
      );
    },
  );
});

describe("pinned overlong attestation response guards", () => {
  it.each([
    [503, {}, "upstream"],
    [200, { location: "https://registry.npmjs.org/other" }, "redirect"],
    [200, { "content-encoding": "gzip" }, "encoding"],
  ])(
    "retains status and header veto before pinned-body recovery",
    async (status, extraHeaders, reason) => {
      let attempts = 0;
      await withPinnedLoopback(
        (_request, response) => {
          attempts += 1;
          response.writeHead(status, {
            "content-length": "2",
            connection: "close",
            ...extraHeaders,
          });
          response.end("x");
        },
        async (transport, controller) => {
          await expect(
            downloadAttestationWithRetry(
              pinnedAttestation,
              controller.signal,
              performance.now() + 3_000,
              transport,
            ),
          ).rejects.toThrow(reason);
          expect(attempts).toBe(1);
        },
      );
    },
  );
});

describe("pinned overlong parser-abort predicates", () => {
  it.each([
    [
      "missing aborted event",
      {
        emitAborted: false,
        errorCode: "ECONNRESET",
        complete: false,
        reason: "hdr-long",
        expectedAttempts: 2,
      },
    ],
    [
      "different response error",
      {
        emitAborted: true,
        errorCode: "EPIPE",
        complete: false,
        reason: "transport failure",
        expectedAttempts: 1,
      },
    ],
    [
      "complete response",
      {
        emitAborted: true,
        errorCode: "ECONNRESET",
        complete: true,
        reason: "hdr-long",
        expectedAttempts: 2,
      },
    ],
  ])("rejects exact pinned bytes with %s", async (_case, options) => {
    let attempts = 0;
    const transport = (
      _options: RequestOptions,
      callback: (response: IncomingMessage) => void,
    ): ClientRequest => {
      attempts += 1;
      const response = Object.assign(new PassThrough(), {
        statusCode: 200,
        headers: { "content-length": "2" },
        complete: options.complete,
      }) as unknown as IncomingMessage;
      const client = Object.assign(new EventEmitter(), {
        destroy: () => {},
        end: () => {
          queueMicrotask(() => {
            callback(response);
            response.emit("data", Buffer.from("x"));
            if (options.emitAborted) response.emit("aborted");
            response.emit(
              "error",
              Object.assign(new Error("transport failure"), {
                code: options.errorCode,
              }),
            );
            client.emit("close");
            response.emit("close");
          });
        },
      }) as unknown as ClientRequest;
      return client;
    };
    await expect(
      downloadAttestationWithRetry(
        pinnedAttestation,
        new AbortController().signal,
        performance.now() + 3_000,
        transport,
      ),
    ).rejects.toThrow(options.reason);
    expect(attempts).toBe(options.expectedAttempts);
  });
});
