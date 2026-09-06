import { describe, expect, it, vi } from "vitest";
import {
  failureEvidenceCoverageIsExact,
  runIntegrationStages,
  settleAbortableOperation,
} from "./controller.js";
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

describe("integration failure evidence coverage", () => {
  it("requires all and only the current run failure evidence", () => {
    const first = "0123456789abcdef";
    const second = "fedcba9876543210";
    expect(
      failureEvidenceCoverageIsExact(
        [first, second],
        [first, second],
        [second, first],
      ),
    ).toBe(true);
    expect(
      failureEvidenceCoverageIsExact([first, second], [first, second], [first]),
    ).toBe(false);
    expect(
      failureEvidenceCoverageIsExact(
        [first, second],
        [first],
        [first, "aaaaaaaaaaaaaaaa"],
      ),
    ).toBe(false);
  });
});

describe("integration controller", () => {
  it("aborts at the deadline and joins the operation before returning", async () => {
    const events: string[] = [];
    const operation = settleAbortableOperation(
      5,
      async (signal) => {
        await new Promise<void>((resolveOperation) => {
          signal.addEventListener("abort", () => {
            setTimeout(() => {
              events.push("settled");
              resolveOperation();
            }, 5);
          });
        });
      },
      10,
    );
    await expect(operation).rejects.toThrow("integration.controller.deadline");
    expect(events).toEqual(["settled"]);
  });

  it("fails closed when an aborted operation does not settle", async () => {
    await expect(
      settleAbortableOperation(2, () => new Promise(() => {}), 2),
    ).rejects.toThrow("integration.controller.unsettled-operation");
  });

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

  it("does not run later stages after candidate preparation fails", async () => {
    const events: string[] = [];
    const dependencies = stages(events);
    vi.mocked(dependencies.prepareCandidate).mockRejectedValue(
      new Error("candidate failed"),
    );
    await expect(
      runIntegrationStages("candidate", dependencies),
    ).rejects.toMatchObject({ retirementRequired: true });
    expect(events).toEqual([]);
    expect(dependencies.maintainArtifacts).not.toHaveBeenCalled();
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

  it("skips in-process cleanup after an operation cannot be joined", async () => {
    const events: string[] = [];
    const dependencies = stages(events);
    vi.mocked(dependencies.runScenarios).mockRejectedValue(
      new Error("integration.controller.unsettled-operation"),
    );
    let failure: IntegrationControllerFailure | undefined;
    try {
      await runIntegrationStages("lifecycle", dependencies);
    } catch (error) {
      failure = error as IntegrationControllerFailure;
    }
    expect(failure).toBeDefined();
    if (failure === undefined) throw new Error("expected controller failure");
    expect(failure.retirementRequired).toBe(true);
    expect(failure.cleanupCause).toMatchObject({
      message: "integration.controller.unsettled-operation",
    });
    expect(dependencies.clean).not.toHaveBeenCalled();
  });
});
