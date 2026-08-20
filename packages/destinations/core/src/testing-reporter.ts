import type { DeliveryIdentity } from "@agentscope/protocol";

import {
  createDestinationReporter,
  createReporterReceipt,
  type Reporter,
  type ReporterOutcome,
} from "./reporter.js";

export const REPORTER_TEST_BEHAVIORS = Object.freeze([
  "accept",
  "definite-reject",
  "unavailable-before-send",
  "deadline-before-send",
  "commit-then-lose-acknowledgement",
  "malformed-receipt",
  "throw-before-receipt",
  "hang",
] as const);

export type ReporterTestBehavior = (typeof REPORTER_TEST_BEHAVIORS)[number];

export type ReporterTestLedgerEntry = Readonly<{
  deliveryIdentities: readonly DeliveryIdentity[];
  outcome: ReporterOutcome | "no-receipt";
}>;

export type DestinationTestAdapter = Readonly<{
  createReporter: (behavior: ReporterTestBehavior) => Reporter;
  readDeliveryLedger: () => readonly ReporterTestLedgerEntry[];
  waitForDeliveryAttempt: () => Promise<void>;
  reset: () => void;
}>;

export const createDestinationTestAdapter = (): DestinationTestAdapter => {
  let ledger: ReporterTestLedgerEntry[] = [];
  let resolveDeliveryAttempt: (() => void) | undefined;
  let deliveryAttempt = new Promise<void>((resolve) => {
    resolveDeliveryAttempt = resolve;
  });
  const append = (
    deliveryIdentities: readonly DeliveryIdentity[],
    outcome: ReporterTestLedgerEntry["outcome"],
  ): void => {
    ledger.push(
      Object.freeze({
        deliveryIdentities: Object.freeze([...deliveryIdentities]),
        outcome,
      }),
    );
    resolveDeliveryAttempt?.();
  };
  return Object.freeze({
    createReporter: (behavior) =>
      createDestinationReporter({
        report: ({ traces }) => {
          const identities = traces.map((trace) => trace.delivery.identity);
          switch (behavior) {
            case "accept":
              append(identities, "accepted");
              return Promise.resolve(createReporterReceipt("accepted"));
            case "definite-reject":
              append(identities, "rejected");
              return Promise.resolve(createReporterReceipt("rejected"));
            case "unavailable-before-send":
              append(identities, "unavailable");
              return Promise.resolve(createReporterReceipt("unavailable"));
            case "deadline-before-send":
              append(identities, "deadline-exceeded");
              return Promise.resolve(
                createReporterReceipt("deadline-exceeded"),
              );
            case "commit-then-lose-acknowledgement":
              append(identities, "no-receipt");
              return Promise.reject(new Error("test acknowledgement loss"));
            case "malformed-receipt":
              append(identities, "no-receipt");
              return Promise.resolve({ providerBody: "CANARY" } as never);
            case "throw-before-receipt":
              append(identities, "no-receipt");
              throw new Error("test reporter throw");
            case "hang":
              append(identities, "no-receipt");
              return new Promise(() => undefined);
          }
        },
      }),
    readDeliveryLedger: () =>
      Object.freeze(
        ledger.map((entry) =>
          Object.freeze({
            deliveryIdentities: Object.freeze([...entry.deliveryIdentities]),
            outcome: entry.outcome,
          }),
        ),
      ),
    waitForDeliveryAttempt: () => deliveryAttempt,
    reset: () => {
      ledger = [];
      deliveryAttempt = new Promise<void>((resolve) => {
        resolveDeliveryAttempt = resolve;
      });
    },
  });
};
