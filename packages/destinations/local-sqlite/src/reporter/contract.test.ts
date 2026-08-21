import {
  createDestinationReporter,
  createReporterReceipt,
  type Reporter,
} from "@agentscope/destinations-core";
import {
  createReporterContractSuite,
  type DestinationTestAdapter,
  type ReporterTestBehavior,
  type ReporterTestLedgerEntry,
} from "@agentscope/destinations-core/testing";
import type { DeliveryIdentity } from "@agentscope/protocol";
import { createSanitizedRedactedCanonicalTraceFixture } from "@agentscope/protocol/testing";
import { describe, it } from "vitest";

import {
  createLocalSqliteReporter,
  type LocalSqlitePreparedTrace,
  type LocalSqliteReporterDatabase,
  type LocalSqliteStoredTraceEvidence,
} from "./transaction.js";

const reporterPolicy = Object.freeze({
  maximumAgeNanoseconds: "2592000000000000",
  maximumTraceCount: 100_000,
  maximumPayloadBytes: 1024 * 1024 * 1024,
});

const evidenceFor = (
  trace: LocalSqlitePreparedTrace,
): LocalSqliteStoredTraceEvidence =>
  Object.freeze({
    deliveryIdentity: trace.deliveryIdentity,
    traceId: trace.traceId,
    admissionTimeUnixNano: trace.admissionTimeUnixNano,
    protocolCompatibilityId: trace.protocolCompatibilityId,
    payloadSha256: trace.payloadSha256,
    payloadBytes: trace.payloadBytes,
  });

const createActualReporter = (
  behavior: "accept" | "definite-reject",
  append: (
    identities: readonly DeliveryIdentity[],
    outcome: ReporterTestLedgerEntry["outcome"],
  ) => void,
): Reporter => {
  let transaction = false;
  const rows: LocalSqliteStoredTraceEvidence[] = [];
  let requested: readonly string[] = [];
  const database: LocalSqliteReporterDatabase = Object.freeze({
    beginImmediate: () => {
      transaction = true;
    },
    inTransaction: () => transaction,
    readLastTrustedTimeUnixNano: () => undefined,
    readExisting: (identities) => {
      requested = identities;
      if (behavior === "definite-reject")
        return identities.map((deliveryIdentity) => ({
          deliveryIdentity,
          traceId: "0".repeat(32),
          admissionTimeUnixNano: "1000000",
          protocolCompatibilityId: "historical-conflict",
          payloadSha256: "0".repeat(64),
          payloadBytes: 1,
        }));
      return rows.filter((row) => identities.includes(row.deliveryIdentity));
    },
    deleteExpiredBefore: () => undefined,
    insertTrace: (trace) => {
      rows.push(evidenceFor(trace));
      return "inserted";
    },
    readCapacity: () => ({
      traceCount: rows.length,
      payloadBytes: rows.reduce((total, row) => total + row.payloadBytes, 0),
    }),
    evictOldestUntilWithin: () => undefined,
    writeLastTrustedTimeUnixNano: () => undefined,
    commit: () => {
      transaction = false;
      append(
        requested as readonly DeliveryIdentity[],
        behavior === "accept" ? "accepted" : "rejected",
      );
    },
    rollback: () => {
      transaction = false;
      append(requested as readonly DeliveryIdentity[], "rejected");
    },
  });
  return createLocalSqliteReporter(database, reporterPolicy);
};

const createLocalSqliteDestinationTestAdapter = (): DestinationTestAdapter => {
  let ledger: ReporterTestLedgerEntry[] = [];
  let resolveAttempt: (() => void) | undefined;
  let attempt = new Promise<void>((resolve) => {
    resolveAttempt = resolve;
  });
  const append = (
    identities: readonly DeliveryIdentity[],
    outcome: ReporterTestLedgerEntry["outcome"],
  ): void => {
    ledger.push(
      Object.freeze({
        deliveryIdentities: Object.freeze([...identities]),
        outcome,
      }),
    );
    resolveAttempt?.();
  };
  const syntheticReporter = (behavior: ReporterTestBehavior): Reporter =>
    createDestinationReporter({
      report: ({ traces }) => {
        const identities = traces.map(({ delivery }) => delivery.identity);
        if (behavior === "deadline-before-send") {
          append(identities, "deadline-exceeded");
          return Promise.resolve(createReporterReceipt("deadline-exceeded"));
        }
        if (behavior === "unavailable-before-send") {
          append(identities, "unavailable");
          return Promise.resolve(
            createReporterReceipt("unavailable", "destination-busy"),
          );
        }
        if (behavior === "commit-then-lose-acknowledgement") {
          append(identities, "no-receipt");
          return Promise.reject(new Error("lost-acknowledgement"));
        }
        if (behavior === "malformed-receipt") {
          append(identities, "no-receipt");
          return Promise.resolve({ canary: true } as never);
        }
        if (behavior === "throw-before-receipt") {
          append(identities, "no-receipt");
          throw new Error("native-throw");
        }
        append(identities, "no-receipt");
        return new Promise(() => undefined);
      },
    });
  return Object.freeze({
    createReporter: (behavior) =>
      behavior === "accept" || behavior === "definite-reject"
        ? createActualReporter(behavior, append)
        : syntheticReporter(behavior),
    readDeliveryLedger: () =>
      Object.freeze(
        ledger.map((entry) =>
          Object.freeze({
            deliveryIdentities: Object.freeze([...entry.deliveryIdentities]),
            outcome: entry.outcome,
          }),
        ),
      ),
    waitForDeliveryAttempt: () => attempt,
    reset: () => {
      ledger = [];
      attempt = new Promise<void>((resolve) => {
        resolveAttempt = resolve;
      });
      return "inserted";
    },
  });
};

const traces = Object.freeze([
  createSanitizedRedactedCanonicalTraceFixture({ sequence: 20 }),
  createSanitizedRedactedCanonicalTraceFixture({ sequence: 21 }),
] as const);

describe("Local SQLite shared Reporter contract", () => {
  for (const contractCase of createReporterContractSuite({
    adapter: createLocalSqliteDestinationTestAdapter(),
    traces,
  }))
    it(contractCase.name, contractCase.run);
});
