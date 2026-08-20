import { describe, expect, it, vi } from "vitest";

import { createReporterDeadline } from "./deadline.js";
import { validateDestinationEndpoint } from "./endpoint.js";
import {
  bindDestinationTransport,
  DestinationTransportError,
  executeBoundDestinationRequest,
  isBoundDestinationTransport,
  MAXIMUM_TRANSPORT_REQUEST_BYTES,
  MAXIMUM_TRANSPORT_RESPONSE_BYTES,
  MAXIMUM_TRANSPORT_PATH_AND_QUERY_BYTES,
  type DestinationTransportExecutor,
  type DestinationTransportRequest,
} from "./transport.js";

const endpoint = () =>
  validateDestinationEndpoint("https://example.com/base/", {
    allowInsecureLoopback: false,
  });

const request = (
  overrides: Partial<DestinationTransportRequest> = {},
): DestinationTransportRequest => ({
  method: "POST",
  pathAndQuery: "/v1/traces?project=safe",
  headers: {
    authorization: "Bearer CANARY_SECRET",
    "content-type": "application/json",
  },
  body: Uint8Array.from([1, 2, 3]),
  signal: new AbortController().signal,
  deadline: createReporterDeadline(1_000),
  ...overrides,
});

const validExecutor = (): DestinationTransportExecutor => () =>
  Promise.resolve({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Uint8Array.from([4, 5, 6]),
  });

describe("origin-bound destination transport", () => {
  it("normalizes same-origin requests and snapshots mutable bytes", async () => {
    const executor = vi.fn(validExecutor());
    const transport = bindDestinationTransport(endpoint(), executor);
    const body = Uint8Array.from([1, 2, 3]);
    const result = await executeBoundDestinationRequest(
      transport,
      request({ body }),
    );
    body.fill(9);
    const observed = executor.mock.calls[0]?.[0];
    expect(observed?.url).toBe("https://example.com/v1/traces?project=safe");
    expect(observed?.body).toEqual(Uint8Array.from([1, 2, 3]));
    expect(observed?.body).not.toBe(body);
    expect(Object.isFrozen(observed)).toBe(true);
    expect(result).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Uint8Array.from([4, 5, 6]),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(isBoundDestinationTransport(transport)).toBe(true);
    expect(isBoundDestinationTransport({ ...transport })).toBe(false);
  });

  it("supports bodyless methods and canonical header ordering", async () => {
    const executor = vi.fn(validExecutor());
    const source = request();
    const bodyless: DestinationTransportRequest = {
      method: "GET",
      pathAndQuery: source.pathAndQuery,
      headers: { z: "last", a: "first" },
      signal: source.signal,
      deadline: source.deadline,
    };
    await executeBoundDestinationRequest(
      bindDestinationTransport(endpoint(), executor),
      bodyless,
    );
    expect(executor.mock.calls[0]?.[0].headers).toEqual({
      a: "first",
      z: "last",
    });
    expect(executor.mock.calls[0]?.[0].body).toBeUndefined();
  });

  it("admits the bounded portable-filter request-target envelope", async () => {
    const executor = vi.fn(validExecutor());
    const pathAndQuery = `/?filter=${"x".repeat(4_096)}`;
    const source = request();
    await executeBoundDestinationRequest(
      bindDestinationTransport(endpoint(), executor),
      {
        method: "GET",
        pathAndQuery,
        headers: source.headers,
        signal: source.signal,
        deadline: source.deadline,
      },
    );
    expect(executor.mock.calls[0]?.[0].url).toContain(pathAndQuery);
    expect(MAXIMUM_TRANSPORT_PATH_AND_QUERY_BYTES).toBe(131_072);
  });

  it("rejects forged binding inputs", () => {
    expect(() =>
      bindDestinationTransport({} as never, validExecutor()),
    ).toThrowError(DestinationTransportError);
    expect(() =>
      bindDestinationTransport(endpoint(), null as never),
    ).toThrowError(DestinationTransportError);
  });
});

describe("transport request validation", () => {
  it("rejects cross-origin paths and request-shape attacks before execution", async () => {
    const candidates: unknown[] = [
      null,
      { ...request(), method: "PATCH" },
      { ...request(), pathAndQuery: "https://evil.example/steal" },
      { ...request(), pathAndQuery: "https://example.com/absolute" },
      { ...request(), pathAndQuery: "//evil.example/steal" },
      { ...request(), pathAndQuery: "//example.com/same-origin" },
      { ...request(), pathAndQuery: "relative/path" },
      { ...request(), pathAndQuery: "/path#fragment" },
      { ...request(), pathAndQuery: `/${"x".repeat(131_072)}` },
      { ...request(), pathAndQuery: `/${"é".repeat(65_536)}` },
      { ...request(), headers: { Host: "evil.example" } },
      { ...request(), headers: { host: "evil.example" } },
      { ...request(), headers: { connection: "keep-alive" } },
      { ...request(), headers: { "content-length": "3" } },
      { ...request(), headers: { "bad header": "value" } },
      { ...request(), headers: { authorization: "line\r\nattack" } },
      { ...request(), headers: { authorization: "x".repeat(8_193) } },
      { ...request(), headers: { ["x".repeat(257)]: "value" } },
      {
        ...request(),
        headers: Object.fromEntries(
          Array.from({ length: 5 }, (_, index) => [
            `x-total-${index}`,
            "x".repeat(8_000),
          ]),
        ),
      },
      { ...request(), headers: null },
      { ...request(), headers: [] },
      { ...request(), headers: new (class Headers {})() },
      {
        ...request(),
        headers: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`x-${index}`, "v"]),
        ),
      },
      {
        ...request(),
        body: new Uint8Array(MAXIMUM_TRANSPORT_REQUEST_BYTES + 1),
      },
      { ...request(), signal: {} },
      { ...request(), deadline: {} },
      { ...request(), extra: true },
      Object.defineProperty({}, "method", { get: () => "CANARY_SECRET" }),
      Object.defineProperty({ ...request() }, "body", {
        get: () => new Uint8Array([1]),
      }),
    ];
    for (const candidate of candidates) {
      const executor = vi.fn(validExecutor());
      await expect(
        executeBoundDestinationRequest(
          bindDestinationTransport(endpoint(), executor),
          candidate as never,
        ),
      ).rejects.toThrowError(DestinationTransportError);
      expect(executor).not.toHaveBeenCalled();
    }
  });

  it("rejects forged transports", async () => {
    await expect(
      executeBoundDestinationRequest({} as never, request()),
    ).rejects.toThrowError(DestinationTransportError);
  });

  it("does not invoke an executor after pre-abort or deadline expiry", async () => {
    const executor = vi.fn(validExecutor());
    const transport = bindDestinationTransport(endpoint(), executor);
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeBoundDestinationRequest(
        transport,
        request({ signal: controller.signal }),
      ),
    ).rejects.toThrowError(DestinationTransportError);
    await expect(
      executeBoundDestinationRequest(
        transport,
        request({ deadline: createReporterDeadline(0) }),
      ),
    ).rejects.toThrowError(DestinationTransportError);
    expect(executor).not.toHaveBeenCalled();
  });
});

describe("transport response validation", () => {
  it("collapses thrown executors and malformed responses to fixed errors", async () => {
    const candidates: Array<() => unknown> = [
      () => {
        throw new Error("CANARY_SECRET");
      },
      () => null,
      () => ({ status: 99, headers: {}, body: new Uint8Array() }),
      () => ({ status: 600, headers: {}, body: new Uint8Array() }),
      () => ({ status: 200.5, headers: {}, body: new Uint8Array() }),
      () => ({ status: 200, headers: {}, body: "not bytes" }),
      () => ({
        status: 200,
        headers: {},
        body: new Uint8Array(MAXIMUM_TRANSPORT_RESPONSE_BYTES + 1),
      }),
      () => ({
        status: 200,
        headers: { "Bad Header": "x" },
        body: new Uint8Array(),
      }),
      () => ({ status: 200, headers: {}, body: new Uint8Array(), extra: true }),
      () => Object.defineProperty({}, "status", { get: () => "CANARY_SECRET" }),
    ];
    for (const candidate of candidates) {
      const executor = (() =>
        Promise.resolve(candidate())) as DestinationTransportExecutor;
      await expect(
        executeBoundDestinationRequest(
          bindDestinationTransport(endpoint(), executor),
          request(),
        ),
      ).rejects.toThrowError("destination.transport.invalid");
    }
  });
});
