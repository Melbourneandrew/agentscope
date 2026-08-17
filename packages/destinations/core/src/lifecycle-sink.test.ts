import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { RedactedCanonicalTrace } from "@agentscope/protocol";

import { destinationsCorePackageId } from "./index.js";
import {
  invokeRedactedTraceSink,
  type RedactedTraceSink,
} from "./lifecycle-sink.js";

describe("provisional redacted-only lifecycle sink", () => {
  it("keeps the destination contract package identity explicit", () => {
    expect(destinationsCorePackageId).toBe("@agentscope/destinations-core");
  });

  it("rejects raw, forged, cloned, spread, JSON, and proxy values before invocation", () => {
    const sink = vi.fn<RedactedTraceSink>(() => undefined);
    for (const value of [
      null,
      {},
      { envelopeVersion: 1 },
      structuredClone({ envelopeVersion: 1 }),
      { ...{ envelopeVersion: 1 } },
      JSON.parse('{"envelopeVersion":1}'),
      new Proxy(
        {},
        {
          get() {
            throw new Error("CANARY_SECRET");
          },
        },
      ),
    ])
      expect(
        invokeRedactedTraceSink(sink, value as RedactedCanonicalTrace),
      ).toBe("rejected");
    expect(sink).not.toHaveBeenCalled();
  });

  it("exposes only one synchronous branded single-item callback", () => {
    expectTypeOf<RedactedTraceSink>()
      .parameter(0)
      .toEqualTypeOf<RedactedCanonicalTrace>();
    expectTypeOf<RedactedTraceSink>().returns.toEqualTypeOf<undefined>();
    const sink: RedactedTraceSink = () => undefined;
    const compileOnly = () => {
      // @ts-expect-error Raw/unknown values cannot enter the sink API.
      sink({});
    };
    // @ts-expect-error Async callbacks are not this provisional sink contract.
    const asyncSink: RedactedTraceSink = async () => {
      await Promise.resolve();
    };
    void compileOnly;
    void asyncSink;
  });
});
