import type { RedactedCanonicalTrace } from "@agentscope/protocol";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const protocolMock = vi.hoisted(() => ({ brands: new WeakSet<object>() }));
vi.mock("@agentscope/protocol", () => ({
  isRedactedCanonicalTrace: (value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    protocolMock.brands.has(value),
}));

import { createReporterDeadline } from "./deadline.js";
import { defineDestinationDescriptor } from "./descriptor.js";
import {
  createDestinationReporter,
  createReporterReceipt,
  invokeReporter,
  type ReporterOutcome,
} from "./reporter.js";
import {
  createDestinationTestAdapter,
  invokeDestinationReporterForTesting,
  prepareDestinationReporterForTesting,
  REPORTER_TEST_BEHAVIORS,
} from "./testing.js";

const trace = (identity: string): RedactedCanonicalTrace => {
  const value = Object.freeze({
    delivery: Object.freeze({ identity }),
  });
  protocolMock.brands.add(value);
  return value as RedactedCanonicalTrace;
};

const invoke = async (
  adapter: ReturnType<typeof createDestinationTestAdapter>,
  behavior: (typeof REPORTER_TEST_BEHAVIORS)[number],
  identity: string,
): Promise<Readonly<{ outcome: ReporterOutcome }>> => {
  const controller = new AbortController();
  const result = invokeReporter(adapter.createReporter(behavior), {
    traces: [trace(identity)],
    signal: controller.signal,
    deadline: createReporterDeadline(1_000),
  });
  if (behavior === "hang") {
    await adapter.waitForDeliveryAttempt();
    controller.abort();
  }
  return await result;
};

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

  it("prepares and invokes one actual remote descriptor behind the testing subpath", async () => {
    const schema = z.strictObject({ endpoint: z.string() });
    void schema.shape;
    const descriptor = defineDestinationDescriptor({
      descriptorVersion: 1,
      destinationType: "@agentscope/destination-testing",
      commandName: "testing",
      settingsVersion: 1,
      settingsSchema: schema,
      defaultSettings: { endpoint: "https://example.com" },
      credentialSlots: [],
      documentationPath: "/docs/destinations/testing",
      deliveryIdentitySupport: "duplicates-possible",
      transport: {
        kind: "remote",
        resolveEndpoint: ({ endpoint }) => ({
          url: endpoint,
          allowInsecureLoopback: false,
        }),
      },
      createReporter: ({ transport }) => {
        expect(transport).not.toBeNull();
        return createDestinationReporter({
          report: () => Promise.resolve(createReporterReceipt("accepted")),
        });
      },
    });
    const reporter = prepareDestinationReporterForTesting({
      descriptor,
      settings: {},
      credentials: {},
      executor: () =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: new Uint8Array(),
        }),
    });
    await expect(
      invokeDestinationReporterForTesting(reporter, {
        traces: [trace("delivery-testing")],
      }),
    ).resolves.toEqual({ outcome: "accepted" });
    const local = defineDestinationDescriptor({
      descriptorVersion: 1,
      destinationType: "@agentscope/destination-testing-local",
      commandName: "testing-local",
      settingsVersion: 1,
      settingsSchema: schema,
      defaultSettings: { endpoint: "local" },
      credentialSlots: [],
      documentationPath: "/docs/destinations/testing-local",
      deliveryIdentitySupport: "duplicates-possible",
      transport: { kind: "local" },
      createReporter: () =>
        createDestinationReporter({
          report: () => Promise.resolve(createReporterReceipt("accepted")),
        }),
    });
    expect(() =>
      prepareDestinationReporterForTesting({
        descriptor: local,
        settings: {},
        credentials: {},
        executor: () =>
          Promise.resolve({
            status: 200,
            headers: {},
            body: new Uint8Array(),
          }),
      }),
    ).toThrowError("destination.testing.remote-required");
  });
});
