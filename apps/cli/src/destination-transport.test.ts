import { MAXIMUM_TRANSPORT_RESPONSE_BYTES } from "@agentscope/destinations-core";
import { createReporterDeadline } from "@agentscope/destinations-core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { productionDestinationTransportExecutor } from "./destination-transport.js";

const request = () => ({
  deadline: createReporterDeadline(2_000),
  headers: Object.freeze({ accept: "application/json" }),
  method: "GET" as const,
  signal: new AbortController().signal,
  url: "https://example.com/api/public/otel/v1/traces",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("production destination transport", () => {
  it("uses one bounded redirect-disabled request and returns governed headers", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response("{}", {
          headers: {
            "content-length": "2",
            "content-type": "application/json",
            "retry-after": "5",
          },
          status: 200,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      productionDestinationTransportExecutor(request()),
    ).resolves.toMatchObject({
      body: new TextEncoder().encode("{}"),
      headers: {
        "content-type": "application/json",
        "retry-after": "5",
      },
      status: 200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/api/public/otel/v1/traces",
      expect.objectContaining({
        credentials: "omit",
        method: "GET",
        redirect: "manual",
        referrerPolicy: "no-referrer",
      }),
    );
  });

  it("cancels and rejects a response before buffering more than the family cap", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      start: (controller) => {
        controller.enqueue(
          new Uint8Array(MAXIMUM_TRANSPORT_RESPONSE_BYTES + 1),
        );
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(body, { status: 200 }))),
    );

    await expect(
      productionDestinationTransportExecutor(request()),
    ).rejects.toThrow("destination.transport.response-too-large");
    expect(cancelled).toBe(true);
  });

  it("rejects an aborted attempt before fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      productionDestinationTransportExecutor({
        ...request(),
        signal: controller.signal,
      }),
    ).rejects.toThrow("destination.transport.deadline-exceeded");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends bounded request bytes and accepts an empty response body", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      productionDestinationTransportExecutor({
        ...request(),
        body: new TextEncoder().encode("request"),
        method: "POST",
      }),
    ).resolves.toMatchObject({ body: new Uint8Array(), status: 204 });
    expect(fetchMock).toHaveBeenCalledWith(
      request().url,
      expect.objectContaining({ body: Buffer.from("request") }),
    );
  });

  it("rejects response headers beyond the family inventory bound", async () => {
    const headers = new Headers();
    for (let index = 0; index < 65; index += 1)
      headers.set(`x-header-${String(index).padStart(2, "0")}`, "value");
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      headers,
      status: 200,
    });
    const getReader = vi.spyOn(response.body!, "getReader");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.resolve(response)),
    );

    await expect(
      productionDestinationTransportExecutor(request()),
    ).rejects.toThrow("destination.transport.response-headers-too-large");
    expect(getReader).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
  });
});
