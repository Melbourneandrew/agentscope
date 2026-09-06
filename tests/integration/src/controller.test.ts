import { describe, expect, it, vi } from "vitest";
import { runIntegrationStages } from "./controller.js";
import type {
  IntegrationControllerFailure,
  IntegrationStageDependencies,
} from "./controller.js";

const stages = (events: string[]): IntegrationStageDependencies =>
  Object.fromEntries(
    [
      "clean",
      "maintainArtifacts",
      "prepareCandidate",
      "prepareImages",
      "prepareModelRoutes",
      "runScenarios",
      "select",
    ].map((name) => [
      name,
      vi.fn(() => {
        events.push(name);
        return Promise.resolve();
      }),
    ]),
  ) as unknown as IntegrationStageDependencies;

describe("integration controller", () => {
  it("runs one private Crabbox lifecycle and cleans last", async () => {
    const events: string[] = [];
    await runIntegrationStages("crabbox", stages(events));
    expect(events).toEqual([
      "prepareCandidate",
      "select",
      "prepareImages",
      "prepareModelRoutes",
      "runScenarios",
      "maintainArtifacts",
      "clean",
    ]);
  });

  it("prepares a CI candidate without consuming or cleaning it", async () => {
    const events: string[] = [];
    await runIntegrationStages("candidate", stages(events));
    expect(events).toEqual(["prepareCandidate", "maintainArtifacts"]);
  });

  it("preserves the primary failure after successful cleanup", async () => {
    const events: string[] = [];
    const dependencies = stages(events);
    const primary = new Error("scenario failed");
    vi.mocked(dependencies.runScenarios).mockRejectedValue(primary);
    await expect(
      runIntegrationStages("lifecycle", dependencies),
    ).rejects.toMatchObject({
      cleanupCause: undefined,
      message: "integration.controller.retire-outer-host",
      primaryCause: primary,
      retirementRequired: true,
    } satisfies Partial<IntegrationControllerFailure>);
    expect(events.at(-1)).toBe("clean");
  });

  it("retains both a scenario failure and cleanup failure", async () => {
    const events: string[] = [];
    const dependencies = stages(events);
    const primary = new Error("scenario failed");
    const cleanup = new Error("cleanup failed");
    vi.mocked(dependencies.runScenarios).mockRejectedValue(primary);
    vi.mocked(dependencies.clean).mockRejectedValue(cleanup);
    await expect(
      runIntegrationStages("lifecycle", dependencies),
    ).rejects.toMatchObject({
      cleanupCause: cleanup,
      primaryCause: primary,
      retirementRequired: true,
    } satisfies Partial<IntegrationControllerFailure>);
  });
});
