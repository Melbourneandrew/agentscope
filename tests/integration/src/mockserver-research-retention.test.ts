import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSupervisedProcess } from "../supervisor.mjs";
import { mockServerResearchStopFitsTerminalObservation } from "./mockserver-research-request.js";

afterEach(() => vi.restoreAllMocks());
const child = () =>
  runSupervisedProcess({
    arguments_: ["-e", "process.exit(3)"],
    environment: {},
    executable: process.execPath,
    maximumMilliseconds: 2_000,
    stdio: "ignore",
  });

describe("existing supervisor research terminal observations", () => {
  it("observes a normally joined synthetic exit3 without an intervention", async () => {
    const result = await child();
    expect(result).toMatchObject({
      code: 3,
      signal: null,
      contained: true,
      residualWorkObserved: false,
      terminationInitiated: false,
      completedWithinDeadline: true,
    });
    expect(mockServerResearchStopFitsTerminalObservation(result)).toBe(true);
  });

  it("rejects a late terminal observation even before the timer callback runs", async () => {
    let calls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      calls += 1;
      return calls < 5 ? 10 : 2_011;
    });
    const result = await child();
    expect(result.code).toBe(3);
    expect(result.terminationInitiated).toBe(false);
    expect(result.completedWithinDeadline).toBe(false);
    expect(mockServerResearchStopFitsTerminalObservation(result)).toBe(false);
  });
});
