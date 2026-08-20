import type { RedactedCanonicalTrace } from "@agentscope/protocol";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

const protocolMock = vi.hoisted(() => ({ brands: new WeakSet<object>() }));
vi.mock("@agentscope/protocol", () => ({
  isRedactedCanonicalTrace: (value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    protocolMock.brands.has(value),
}));

import { createReporterDeadline } from "./deadline.js";
import {
  createDestinationReporter,
  createReporterReceipt,
  invokeReporter,
  isDestinationReporter,
  MAXIMUM_REPORTER_BATCH_ITEMS,
  REPORTER_OUTCOMES,
  ReporterContractError,
  type ReporterAttempt,
  type ReporterImplementation,
  type ReporterReceipt,
} from "./reporter.js";

const trace = (identity: string): RedactedCanonicalTrace => {
  const value = Object.freeze({
    delivery: Object.freeze({ identity }),
  });
  protocolMock.brands.add(value);
  return value as RedactedCanonicalTrace;
};

const attempt = (
  traces: readonly RedactedCanonicalTrace[],
  options: { signal?: AbortSignal; timeout?: number } = {},
): ReporterAttempt =>
  Object.freeze({
    traces,
    signal: options.signal ?? new AbortController().signal,
    deadline: createReporterDeadline(options.timeout ?? 1_000),
  }) as ReporterAttempt;

const implementation = (
  report: ReporterImplementation["report"],
): ReturnType<typeof createDestinationReporter> =>
  createDestinationReporter({ report });

describe("Reporter receipt and construction", () => {
  it("constructs every exact frozen terminal receipt", () => {
    for (const outcome of REPORTER_OUTCOMES) {
      const receipt = createReporterReceipt(outcome);
      expect(receipt).toEqual({ outcome });
      expect(Object.isFrozen(receipt)).toBe(true);
    }
    expectTypeOf<ReporterReceipt["outcome"]>().toEqualTypeOf<
      (typeof REPORTER_OUTCOMES)[number]
    >();
    expect(() => createReporterReceipt("partial" as never)).toThrowError(
      ReporterContractError,
    );
  });

  it("creates only exact synchronous reporter implementations", () => {
    const value = implementation(() =>
      Promise.resolve(createReporterReceipt("accepted")),
    );
    expect(isDestinationReporter(value)).toBe(true);
    expect(isDestinationReporter({ ...value })).toBe(false);
    for (const candidate of [
      null,
      {},
      { report: "not a function" },
      { report: () => Promise.resolve({ outcome: "accepted" }), extra: true },
      Object.defineProperty({}, "report", { get: () => "CANARY_SECRET" }),
    ]) {
      expect(() => createDestinationReporter(candidate as never)).toThrowError(
        ReporterContractError,
      );
    }
  });
});

describe("Reporter branded batch boundary", () => {
  it("passes a fresh frozen batch containing the exact branded envelopes", async () => {
    const first = trace("delivery-a");
    const second = trace("delivery-b");
    const report = vi.fn<ReporterImplementation["report"]>(() =>
      Promise.resolve(createReporterReceipt("accepted")),
    );
    const receipt = await invokeReporter(
      implementation(report),
      attempt([first, second]),
    );
    expect(receipt).toEqual({ outcome: "accepted" });
    const observed = report.mock.calls[0]?.[0] as ReporterAttempt | undefined;
    expect(observed?.traces).toEqual([first, second]);
    expect(observed?.traces[0]).toBe(first);
    expect(observed?.traces[1]).toBe(second);
    expect(Object.isFrozen(observed?.traces)).toBe(true);
  });

  it("accepts the exact maximum batch size", async () => {
    const traces = Array.from(
      { length: MAXIMUM_REPORTER_BATCH_ITEMS },
      (_, index) => trace(`delivery-${index}`),
    );
    const report = vi.fn(() =>
      Promise.resolve(createReporterReceipt("accepted")),
    );
    await expect(
      invokeReporter(implementation(report), attempt(traces)),
    ).resolves.toEqual({ outcome: "accepted" });
    expect(report).toHaveBeenCalledOnce();
  });

  it("rejects empty, duplicate, forged, sparse, accessor, and oversized batches", async () => {
    const valid = trace("delivery-a");
    const sparse = Array.from({ length: 2 });
    sparse[1] = valid;
    const accessor: RedactedCanonicalTrace[] = [];
    Object.defineProperty(accessor, "0", { get: () => valid });
    Object.defineProperty(accessor, "length", { value: 1 });
    const extra = [valid];
    Object.defineProperty(extra, "named", { value: valid });
    const hostile = new Proxy([valid], {
      ownKeys() {
        throw new Error("CANARY_SECRET");
      },
    });
    const candidates = [
      [],
      [valid, valid],
      [{}],
      [{ ...valid }],
      [JSON.parse(JSON.stringify(valid))],
      sparse,
      accessor,
      extra,
      hostile,
      Array.from({ length: MAXIMUM_REPORTER_BATCH_ITEMS + 1 }, (_, index) =>
        trace(`delivery-${index}`),
      ),
    ];
    for (const traces of candidates) {
      const report = vi.fn(() =>
        Promise.resolve(createReporterReceipt("accepted")),
      );
      await expect(
        invokeReporter(implementation(report), attempt(traces as never)),
      ).rejects.toThrowError(ReporterContractError);
      expect(report).not.toHaveBeenCalled();
    }
  });

  it("rejects forged reporters and malformed attempt containers", async () => {
    const valid = trace("delivery-a");
    await expect(
      invokeReporter({} as never, attempt([valid])),
    ).rejects.toThrowError(ReporterContractError);
    for (const candidate of [
      null,
      { traces: [valid] },
      { ...attempt([valid]), extra: true },
      { ...attempt([valid]), signal: {} },
      { ...attempt([valid]), deadline: {} },
      Object.defineProperty({}, "traces", { get: () => [valid] }),
      new Proxy(attempt([valid]), {
        ownKeys() {
          throw new Error("CANARY_SECRET");
        },
      }),
    ]) {
      await expect(
        invokeReporter(
          implementation(() =>
            Promise.resolve(createReporterReceipt("accepted")),
          ),
          candidate as never,
        ),
      ).rejects.toThrowError(ReporterContractError);
    }
  });
});

describe("Reporter fail-open outcome classification", () => {
  it("accepts all exact terminal outcomes and reconstructs receipts", async () => {
    for (const outcome of REPORTER_OUTCOMES) {
      const source = { outcome } as ReporterReceipt;
      const receipt = await invokeReporter(
        implementation(() => Promise.resolve(source)),
        attempt([trace(`delivery-${outcome}`)]),
      );
      expect(receipt).toEqual(source);
      expect(receipt).not.toBe(source);
      expect(Object.isFrozen(receipt)).toBe(true);
    }
  });

  it("classifies throws, rejections, malformed receipts, and async misuse as unknown", async () => {
    const cases: ReporterImplementation["report"][] = [
      () => {
        throw new Error("CANARY_SECRET");
      },
      () => Promise.reject(new Error("CANARY_SECRET")),
      (() => Promise.resolve(null)) as never,
      (() =>
        Promise.resolve({
          outcome: "accepted",
          message: "CANARY_SECRET",
        })) as never,
      (() => Promise.resolve({ outcome: "partial" })) as never,
      (() => ({ outcome: "accepted" })) as never,
      (() => ({
        then() {
          throw new Error("CANARY_SECRET");
        },
      })) as never,
      (() =>
        Promise.resolve(
          Object.defineProperty({}, "outcome", {
            get: () => {
              throw new Error("CANARY_SECRET");
            },
          }),
        )) as never,
      (() =>
        Promise.resolve(
          new Proxy(
            { outcome: "accepted" },
            {
              ownKeys() {
                throw new Error("CANARY_SECRET");
              },
            },
          ),
        )) as never,
    ];
    for (const report of cases) {
      await expect(
        invokeReporter(implementation(report), attempt([trace("delivery-a")])),
      ).resolves.toEqual({ outcome: "outcome-unknown" });
    }
  });

  it("does not invoke for a pre-aborted or already-expired attempt", async () => {
    const report = vi.fn(() =>
      Promise.resolve(createReporterReceipt("accepted")),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      invokeReporter(
        implementation(report),
        attempt([trace("delivery-a")], { signal: controller.signal }),
      ),
    ).resolves.toEqual({ outcome: "deadline-exceeded" });
    await expect(
      invokeReporter(
        implementation(report),
        attempt([trace("delivery-b")], { timeout: 0 }),
      ),
    ).resolves.toEqual({ outcome: "deadline-exceeded" });
    expect(report).not.toHaveBeenCalled();
  });
});

describe("Reporter in-flight deadline classification", () => {
  it("classifies abort and late settlement after invocation as unknown", async () => {
    const controller = new AbortController();
    const hanging = implementation(
      () => new Promise<ReporterReceipt>(() => undefined),
    );
    const aborted = invokeReporter(
      hanging,
      attempt([trace("delivery-a")], {
        signal: controller.signal,
        timeout: 1_000,
      }),
    );
    controller.abort();
    await expect(aborted).resolves.toEqual({ outcome: "outcome-unknown" });
    let resolveAfterAbort: ((receipt: ReporterReceipt) => void) | undefined;
    const abortThenResolve = implementation(
      () =>
        new Promise((resolve) => {
          resolveAfterAbort = resolve;
        }),
    );
    const secondController = new AbortController();
    const result = invokeReporter(
      abortThenResolve,
      attempt([trace("delivery-b")], {
        signal: secondController.signal,
      }),
    );
    secondController.abort();
    await expect(result).resolves.toEqual({ outcome: "outcome-unknown" });
    resolveAfterAbort?.(createReporterReceipt("accepted"));
    await Promise.resolve();
  });
});
