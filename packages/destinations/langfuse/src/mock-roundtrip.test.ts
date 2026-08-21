import { describe, expect, it } from "vitest";

import { executeLangfuseMockRoundTrip } from "./mock-roundtrip.js";

describe("Langfuse hermetic mock round-trip evidence", () => {
  it("records an eventual report-search-get semantic result", async () => {
    const result = await executeLangfuseMockRoundTrip({
      runId: "0123456789abcdef",
      visibilityDelayAttempts: 2,
    });
    expect(result).toMatchObject({
      resultVersion: 1,
      runId: "0123456789abcdef",
      uniqueTag: "agentscope-roundtrip-0123456789abcdef",
      outcome: "passed",
      report: "accepted",
      search: "matched",
      get: "matched",
      canonicalGraphMatch: true,
      visibilityAttempts: 3,
      networkAuthority: "in-memory-loopback-executor-only",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /pk-fixture|sk-fixture|traceId|resourceSpans/u,
    );
  });

  it.each([
    "report-unavailable",
    "search-unavailable",
    "get-unavailable",
  ] as const)(
    "records deterministic sanitized %s evidence",
    async (failure) => {
      const result = await executeLangfuseMockRoundTrip({
        runId: "fedcba9876543210",
        failure,
      });
      expect(result.outcome).toBe("unavailable");
      expect(JSON.stringify(result)).not.toContain("503");
      expect(JSON.stringify(result)).not.toContain("fixture");
    },
  );

  it("rejects hostile, extra, accessor, and out-of-bound input", async () => {
    for (const value of [
      null,
      {},
      { runId: 1 },
      { runId: "bad" },
      {
        runId: "0123456789abcdef",
        visibilityDelayAttempts: 9,
      },
      {
        runId: "0123456789abcdef",
        visibilityDelayAttempts: -1,
      },
      {
        runId: "0123456789abcdef",
        visibilityDelayAttempts: "1",
      },
      {
        runId: "0123456789abcdef",
        failure: "future",
      },
      {
        runId: "0123456789abcdef",
        extra: true,
      },
      {
        candidateArtifactDigest: `sha256-${"a".repeat(64)}`,
        runId: "0123456789abcdef",
      },
    ])
      await expect(
        executeLangfuseMockRoundTrip(value as never),
      ).rejects.toThrow("destination.langfuse.mock-evidence.invalid");
    let calls = 0;
    const accessor = Object.defineProperty(
      { runId: "0123456789abcdef" },
      "failure",
      {
        enumerable: true,
        get: () => {
          calls += 1;
          return undefined;
        },
      },
    );
    await expect(executeLangfuseMockRoundTrip(accessor)).rejects.toThrow(
      "destination.langfuse.mock-evidence.invalid",
    );
    expect(calls).toBe(0);
    const symbol = Object.assign(
      { runId: "0123456789abcdef" },
      { [Symbol("extra")]: true },
    );
    await expect(executeLangfuseMockRoundTrip(symbol)).rejects.toThrow(
      "destination.langfuse.mock-evidence.invalid",
    );
    const proxy = new Proxy(
      { runId: "0123456789abcdef" },
      {
        ownKeys: () => {
          throw new Error("CANARY_TRAP");
        },
      },
    );
    await expect(executeLangfuseMockRoundTrip(proxy)).rejects.toThrow(
      "destination.langfuse.mock-evidence.invalid",
    );
  });
});
