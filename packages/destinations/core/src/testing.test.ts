import type { RedactedCanonicalTrace } from "@agentscope/protocol";
import { describe, expect, it, vi } from "vitest";

const protocolMock = vi.hoisted(() => ({ brands: new WeakSet<object>() }));
vi.mock("@agentscope/protocol", () => ({
  isRedactedCanonicalTrace: (value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    protocolMock.brands.has(value),
}));

import { createReporterDeadline } from "./deadline.js";
import { invokeReporter, type ReporterOutcome } from "./reporter.js";
import {
  createDestinationTestAdapter,
  REPORTER_TEST_BEHAVIORS,
} from "./testing.js";

const trace = (identity: string): RedactedCanonicalTrace => {
  const value = Object.freeze({
    delivery: Object.freeze({ identity }),
  });
  protocolMock.brands.add(value);
  return value as RedactedCanonicalTrace;
};

const invoke = (
  adapter: ReturnType<typeof createDestinationTestAdapter>,
  behavior: (typeof REPORTER_TEST_BEHAVIORS)[number],
  identity: string,
) =>
  invokeReporter(adapter.createReporter(behavior), {
    traces: [trace(identity)],
    signal: new AbortController().signal,
    deadline: createReporterDeadline(behavior === "hang" ? 1 : 1_000),
  });

describe("DestinationTestAdapter", () => {
  // AC-REP-003.3: acknowledgement loss after the adapter records possible
  // commit is normalized to outcome-unknown, never definite rejection.
  it("normalizes each finite test behavior and delivery ledger", async () => {
    const adapter = createDestinationTestAdapter();
    const expected: ReporterOutcome[] = [
      "accepted",
      "rejected",
      "unavailable",
      "deadline-exceeded",
      "outcome-unknown",
      "outcome-unknown",
      "outcome-unknown",
      "outcome-unknown",
    ];
    for (const [index, behavior] of REPORTER_TEST_BEHAVIORS.entries()) {
      await expect(
        invoke(adapter, behavior, `delivery-${index}`),
      ).resolves.toEqual({ outcome: expected[index] });
    }
    const ledger = adapter.readDeliveryLedger();
    expect(ledger).toHaveLength(REPORTER_TEST_BEHAVIORS.length);
    expect(ledger[0]?.deliveryIdentities).toEqual(["delivery-0"]);
    expect(ledger[4]?.outcome).toBe("no-receipt");
    expect(Object.isFrozen(ledger)).toBe(true);
    expect(Object.isFrozen(ledger[0]?.deliveryIdentities)).toBe(true);
  });

  it("returns fresh snapshots and resets without mutating prior evidence", async () => {
    const adapter = createDestinationTestAdapter();
    await invoke(adapter, "accept", "delivery-a");
    const before = adapter.readDeliveryLedger();
    adapter.reset();
    expect(adapter.readDeliveryLedger()).toEqual([]);
    expect(before).toHaveLength(1);
    expect(adapter.readDeliveryLedger()).not.toBe(before);
  });
});
