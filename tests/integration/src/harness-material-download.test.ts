import { createServer, request as httpRequest } from "node:http";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import {
  classifyAttestationFailurePhaseForTesting,
  downloadAttestationWithRetry,
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
