import { createDestinationConnectionId } from "@agentscope/destinations-core";
import {
  bindDestinationTransport,
  resolveDestinationConnection,
} from "@agentscope/destinations-core/testing";
import { describe, expect, it, vi } from "vitest";

import { createLangfuseReachabilityProbe } from "./doctor.js";
import { langfuseDestinationDescriptor } from "./reporter/index.js";
import { createLangfuseReachabilityProbeTestHarness } from "./testing.js";

const connectionId = createDestinationConnectionId(
  `destination-connection-v1-${"d".repeat(64)}`,
);
type Executor = Parameters<typeof bindDestinationTransport>[1];

const transport = (executor: Executor) => {
  const prepared = resolveDestinationConnection(langfuseDestinationDescriptor, {
    connectionId,
    settings: {
      ...langfuseDestinationDescriptor.defaultSettings,
      endpoint: "http://127.0.0.1:4318",
      allowInsecureLoopback: true,
    },
  });
  if (prepared.endpoint === null) throw new Error("unreachable");
  return bindDestinationTransport(prepared.endpoint, executor);
};

// eslint-disable-next-line max-lines-per-function -- one suite owns resolver identity and non-content request containment.
describe("Langfuse Doctor reachability", () => {
  it("uses one empty unauthenticated nonmutating request and discards the response", async () => {
    const executor = vi.fn<Executor>(() =>
      Promise.resolve({
        status: 405,
        headers: { "x-provider-canary": "CANARY_PROVIDER" },
        body: new TextEncoder().encode("CANARY_TRACE_CONTENT"),
      }),
    );
    const harness = createLangfuseReachabilityProbeTestHarness(executor);
    const probe = harness.probe;
    expect(harness.connectionId).toBe(connectionId);
    await expect(
      probe.inspect({
        connectionId,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("available");
    expect(executor).toHaveBeenCalledTimes(1);
    const request = executor.mock.calls[0]![0];
    expect(request).toMatchObject({
      method: "GET",
      url: "http://127.0.0.1:4318/api/public/otel/v1/traces",
      headers: {},
    });
    expect(request).not.toHaveProperty("body");
  });

  it("contains unavailable, malformed, aborted, throwing, and rejecting resolution", async () => {
    const cases = [
      () => Promise.resolve(null),
      () =>
        Promise.resolve({
          connectionId,
          profileId: "future",
          transport: {},
        } as never),
      () =>
        Promise.resolve(
          Object.assign(
            { connectionId, profileId: "langfuse-cloud-v4", transport: {} },
            { [Symbol("extra")]: true },
          ) as never,
        ),
      () =>
        Promise.resolve(
          new Proxy(
            { connectionId, profileId: "langfuse-cloud-v4", transport: {} },
            {
              ownKeys: () => {
                throw new Error("CANARY_TRAP");
              },
            },
          ) as never,
        ),
      () => {
        throw new Error("CANARY_SYNC");
      },
      () => Promise.reject(new Error("CANARY_REJECT")),
    ];
    for (const resolver of cases) {
      const probe = createLangfuseReachabilityProbe(resolver);
      await expect(
        probe.inspect({
          connectionId,
          signal: new AbortController().signal,
        }),
      ).resolves.toBe("unavailable");
    }
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const probe = createLangfuseReachabilityProbe(() => {
      calls += 1;
      return Promise.resolve(null);
    });
    await expect(
      probe.inspect({ connectionId, signal: controller.signal }),
    ).resolves.toBe("unavailable");
    expect(calls).toBe(0);
    const afterController = new AbortController();
    const afterProbe = createLangfuseReachabilityProbe(() => {
      afterController.abort();
      return Promise.resolve({
        connectionId,
        profileId: "langfuse-cloud-v4",
        transport: transport(() =>
          Promise.reject(new Error("must not execute")),
        ),
      });
    });
    await expect(
      afterProbe.inspect({ connectionId, signal: afterController.signal }),
    ).resolves.toBe("unavailable");
  });

  it("rejects a resolver result bound to a different connection before I/O", async () => {
    const executor = vi.fn<Executor>(() =>
      Promise.resolve({ status: 200, headers: {}, body: new Uint8Array() }),
    );
    const otherConnectionId = createDestinationConnectionId(
      `destination-connection-v1-${"e".repeat(64)}`,
    );
    const probe = createLangfuseReachabilityProbe(() =>
      Promise.resolve({
        connectionId: otherConnectionId,
        profileId: "langfuse-cloud-v4",
        transport: transport(executor),
      }),
    );
    await expect(
      probe.inspect({
        connectionId,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("unavailable");
    expect(executor).not.toHaveBeenCalled();
  });

  it("rejects non-function resolver authority", () => {
    expect(() => createLangfuseReachabilityProbe({} as never)).toThrow(
      "destination.langfuse.doctor.invalid",
    );
  });
});
