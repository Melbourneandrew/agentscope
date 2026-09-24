/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { afterEach, describe, expect, it, vi } from "vitest";

// Private executable helper; no package API is published.
// @ts-expect-error no declaration file is published for this private module
import { drainFailureDiagnostic } from "../failure-diagnostic-drain.mjs";

afterEach(() => vi.useRealTimers());

describe("terminal failure diagnostic drain", () => {
  it("settles when the existing stream accepts the bounded message", async () => {
    const write = vi.fn((_output, callback) => callback());
    await expect(
      drainFailureDiagnostic({
        deadlineMilliseconds: 1_000,
        now: () => 500,
        output: "integration.controller.failed\n",
        stream: { write },
      }),
    ).resolves.toBe(true);
    expect(write).toHaveBeenCalledOnce();
  });

  it("stops waiting for an undrained sink after the original remaining budget", async () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const result = drainFailureDiagnostic({
      deadlineMilliseconds: 525,
      now: () => 500,
      output: "integration.controller.failed\n",
      stream: { write },
    });
    await vi.advanceTimersByTimeAsync(19);
    expect(write).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
  });

  it("caps ample remaining time at 100ms and ignores late callbacks", async () => {
    vi.useFakeTimers();
    let callback: (() => void) | undefined;
    const result = drainFailureDiagnostic({
      deadlineMilliseconds: 1_000,
      now: () => 500,
      output: "integration.controller.failed\n",
      stream: {
        write: (_output: string, next: () => void) => (callback = next),
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBe(false);
    callback?.();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not enter a diagnostic write after the original deadline", async () => {
    const write = vi.fn();
    await expect(
      drainFailureDiagnostic({
        deadlineMilliseconds: 505,
        now: () => 500,
        output: "integration.controller.failed\n",
        stream: { write },
      }),
    ).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("fails closed for malformed input or a throwing sink", async () => {
    const write = vi.fn();
    await expect(
      drainFailureDiagnostic({
        deadlineMilliseconds: 1_000,
        now: () => 500,
        output: "x".repeat(1025),
        stream: { write },
      }),
    ).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
    await expect(
      drainFailureDiagnostic({
        deadlineMilliseconds: 1_000,
        now: () => 500,
        output: "integration.controller.failed\n",
        stream: {
          write: () => {
            throw new Error("synthetic failure");
          },
        },
      }),
    ).resolves.toBe(false);
  });
});
