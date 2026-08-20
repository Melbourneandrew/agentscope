import { describe, expect, it } from "vitest";

import {
  defineDestinationReachabilityProbe,
  DestinationReachabilityError,
  isDestinationReachabilityProbe,
} from "./reachability.js";

const input = () => ({
  destinationType: "@agentscope/destination-example",
  inspect: () => Promise.resolve("available" as const),
});

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
        connectionId: `destination-connection-v1-${"a".repeat(64)}` as never,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("available");
  });

  it.each([
    null,
    {},
    { destinationType: "example", inspect: () => Promise.resolve("available") },
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
});
