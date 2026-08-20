import { describe, expect, it, vi } from "vitest";

describe("Reporter in-flight deadline expiry", () => {
  it("classifies expiry after invocation without a wall-clock race", async () => {
    let monotonicNow = 10_000;
    const now = vi
      .spyOn(performance, "now")
      .mockImplementation(() => monotonicNow);
    vi.resetModules();
    try {
      const [
        { createSanitizedRedactedCanonicalTraceFixture },
        deadline,
        reporter,
      ] = await Promise.all([
        import("@agentscope/protocol/testing"),
        import("./deadline.js"),
        import("./reporter.js"),
      ]);
      const implementation = vi.fn(() => {
        monotonicNow = 11_000;
        return new Promise<never>(() => undefined);
      });
      const result = await reporter.invokeReporter(
        reporter.createDestinationReporter({ report: implementation }),
        {
          traces: [createSanitizedRedactedCanonicalTraceFixture()],
          signal: new AbortController().signal,
          deadline: deadline.createReporterDeadline(1_000),
        },
      );
      expect(implementation).toHaveBeenCalledOnce();
      expect(result).toEqual({ outcome: "outcome-unknown" });
    } finally {
      now.mockRestore();
      vi.resetModules();
    }
  });
});
