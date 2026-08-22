import { describe, expect, it, vi } from "vitest";

import {
  defineDestinationReachabilityProbe,
  DestinationReachabilityError,
  inspectBoundDestinationReachability,
  isDestinationReachabilityProbe,
} from "./reachability.js";
import { validateDestinationEndpoint } from "./endpoint.js";
import {
  bindDestinationTransport,
  type DestinationTransportExecutor,
} from "./transport.js";

const input = () => ({
  destinationType: "@agentscope/destination-example",
  inspect: () => Promise.resolve("available" as const),
});

// eslint-disable-next-line max-lines-per-function -- one contract suite owns the closed probe and request boundary.
describe("destination-declared reachability", () => {
  it("reconstructs and brands one exact non-mutating probe", async () => {
    const candidate = input();
    const probe = defineDestinationReachabilityProbe(candidate);

    expect(probe).not.toBe(candidate);
    expect(Object.isFrozen(probe)).toBe(true);
    expect(isDestinationReachabilityProbe(probe)).toBe(true);
    expect(isDestinationReachabilityProbe({ ...probe })).toBe(false);
    await expect(
      probe.inspect({
        configurationGeneration: 1,
        configurationIdentity: `sha256-${"a".repeat(64)}`,
        connectionId: `destination-connection-v1-${"a".repeat(64)}` as never,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("available");
  });

  it.each([
    null,
    {},
    { destinationType: "example", inspect: () => Promise.resolve("available") },
    {
      destinationType: "@agentscope/destination--example",
      inspect: () => Promise.resolve("available"),
    },
    {
      destinationType: "@agentscope/destination-example-",
      inspect: () => Promise.resolve("available"),
    },
    { destinationType: "@agentscope/destination-example", inspect: 1 },
    Object.defineProperty(input(), "inspect", { get: () => input().inspect }),
    Object.assign(input(), { extra: true }),
    Object.assign(input(), { [Symbol("extra")]: true }),
  ])("rejects malformed or executable descriptor structure", (candidate) => {
    expect(() =>
      defineDestinationReachabilityProbe(candidate as never),
    ).toThrowError(DestinationReachabilityError);
  });

  it("contains descriptor traps behind one fixed error", () => {
    const candidate = new Proxy(input(), {
      ownKeys: () => {
        throw new Error("CANARY_SECRET");
      },
    });
    expect(() => defineDestinationReachabilityProbe(candidate)).toThrow(
      "destination.reachability.invalid",
    );
    expect(isDestinationReachabilityProbe(null)).toBe(false);
  });

  it("runs one bounded empty GET and discards all provider content", async () => {
    const executor = vi.fn<DestinationTransportExecutor>(() =>
      Promise.resolve({
        status: 405,
        headers: { "x-canary": "CANARY_HEADER" },
        body: new TextEncoder().encode("CANARY_TRACE_CONTENT"),
      }),
    );
    const transport = bindDestinationTransport(
      validateDestinationEndpoint("http://127.0.0.1:4318", {
        allowInsecureLoopback: true,
      }),
      executor,
    );
    await expect(
      inspectBoundDestinationReachability(
        transport,
        "/api/public/otel/v1/traces",
        new AbortController().signal,
      ),
    ).resolves.toBe("available");
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]![0]).toMatchObject({
      method: "GET",
      headers: {},
    });
    expect(executor.mock.calls[0]![0]).not.toHaveProperty("body");
  });

  it("contains transport failure and abort as unavailable", async () => {
    const endpoint = validateDestinationEndpoint("http://127.0.0.1:4318", {
      allowInsecureLoopback: true,
    });
    await expect(
      inspectBoundDestinationReachability(
        bindDestinationTransport(endpoint, () =>
          Promise.reject(new Error("CANARY_PROVIDER")),
        ),
        "/probe",
        new AbortController().signal,
      ),
    ).resolves.toBe("unavailable");
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      inspectBoundDestinationReachability(
        bindDestinationTransport(endpoint, () => {
          calls += 1;
          return Promise.reject(new Error("unreachable"));
        }),
        "/probe",
        controller.signal,
      ),
    ).resolves.toBe("unavailable");
    expect(calls).toBe(0);
    const afterController = new AbortController();
    await expect(
      inspectBoundDestinationReachability(
        bindDestinationTransport(endpoint, () => {
          afterController.abort();
          return Promise.resolve({
            status: 200,
            headers: {},
            body: new Uint8Array(),
          });
        }),
        "/probe",
        afterController.signal,
      ),
    ).resolves.toBe("unavailable");
  });

  it("rejects redirects, missing endpoints, and provider-unavailable responses", async () => {
    const endpoint = validateDestinationEndpoint("http://127.0.0.1:4318", {
      allowInsecureLoopback: true,
    });
    for (const status of [302, 404, 503]) {
      await expect(
        inspectBoundDestinationReachability(
          bindDestinationTransport(endpoint, () =>
            Promise.resolve({ status, headers: {}, body: new Uint8Array() }),
          ),
          "/probe",
          new AbortController().signal,
        ),
      ).resolves.toBe("unavailable");
    }
  });
});
