import {
  invokeDestinationReporterForTesting,
  type DestinationContractCase,
} from "@agentscope/destinations-core/testing";
import type { RedactedCanonicalTrace } from "@agentscope/protocol";
import { createSanitizedRedactedCanonicalTraceFixture } from "@agentscope/protocol/testing";
import { describe, expect, it } from "vitest";

import {
  createLocalSqliteDatabaseFailure,
  createLocalSqliteReporter,
  prepareLocalSqliteTrace,
  type LocalSqlitePreparedTrace,
  type LocalSqliteReporterDatabase,
  type LocalSqliteStoredTraceEvidence,
} from "./transaction.js";

const policy = () => ({
  maximumAgeNanoseconds: "30",
  maximumTraceCount: 100,
  maximumPayloadBytes: 1_000_000,
});

type FakeState = {
  transaction: boolean;
  committed: boolean;
  rolledBack: boolean;
  trustedTime?: string;
  rows: LocalSqliteStoredTraceEvidence[];
  workingRows: LocalSqliteStoredTraceEvidence[];
  inserted: LocalSqlitePreparedTrace[];
  failAt?:
    | "begin"
    | "read-existing"
    | "delete"
    | "insert"
    | "capacity"
    | "evict"
    | "write-time"
    | "commit"
    | "rollback";
  failureReason?: Parameters<typeof createLocalSqliteDatabaseFailure>[0];
  forceCapacity:
    Readonly<{ traceCount: number; payloadBytes: number }> | undefined;
  cannotEvict: boolean;
  dropConfirmation?: boolean;
  corruptInsertedAdmission?: string;
  uniquenessWinner?: LocalSqliteStoredTraceEvidence;
};

const cloneEvidence = (
  rows: readonly LocalSqliteStoredTraceEvidence[],
): LocalSqliteStoredTraceEvidence[] => rows.map((row) => ({ ...row }));

const fakeDatabase = (
  overrides: Partial<FakeState> = {},
): { database: LocalSqliteReporterDatabase; state: FakeState } => {
  const state: FakeState = {
    transaction: false,
    committed: false,
    rolledBack: false,
    rows: [],
    workingRows: [],
    inserted: [],
    forceCapacity: undefined,
    cannotEvict: false,
    ...overrides,
  };
  const fail = (at: FakeState["failAt"]): void => {
    if (state.failAt !== at) return;
    throw state.failureReason === undefined
      ? new Error("native-failure")
      : createLocalSqliteDatabaseFailure(state.failureReason);
  };
  const database: LocalSqliteReporterDatabase = Object.freeze({
    beginImmediate: () => {
      fail("begin");
      state.transaction = true;
      state.workingRows = cloneEvidence(state.rows);
    },
    inTransaction: () => state.transaction,
    readLastTrustedTimeUnixNano: () => state.trustedTime,
    readExisting: (identities) => {
      fail("read-existing");
      if (state.dropConfirmation && state.inserted.length > 0) return [];
      return state.workingRows.filter((row) =>
        identities.includes(row.deliveryIdentity),
      );
    },
    deleteExpiredBefore: (cutoff, protectedIdentities) => {
      fail("delete");
      state.workingRows = state.workingRows.filter(
        (row) =>
          protectedIdentities.includes(row.deliveryIdentity) ||
          BigInt(row.admissionTimeUnixNano) >= BigInt(cutoff),
      );
    },
    insertTrace: (trace) => {
      fail("insert");
      if (state.uniquenessWinner !== undefined) {
        state.workingRows.push(state.uniquenessWinner);
        return "uniqueness-conflict";
      }
      state.inserted.push(trace);
      state.workingRows.push({
        deliveryIdentity: trace.deliveryIdentity,
        traceId: trace.traceId,
        admissionTimeUnixNano:
          state.corruptInsertedAdmission ?? trace.admissionTimeUnixNano,
        protocolCompatibilityId: trace.protocolCompatibilityId,
        payloadSha256: trace.payloadSha256,
        payloadBytes: trace.payloadBytes,
      });
      return "inserted";
    },
    readCapacity: () => {
      fail("capacity");
      return (
        state.forceCapacity ?? {
          traceCount: state.workingRows.length,
          payloadBytes: state.workingRows.reduce(
            (total, row) => total + row.payloadBytes,
            0,
          ),
        }
      );
    },
    evictOldestUntilWithin: (
      maximumTraceCount,
      maximumPayloadBytes,
      protectedIdentities,
    ) => {
      fail("evict");
      const sorted = [...state.workingRows].sort(
        (left, right) =>
          left.admissionTimeUnixNano.localeCompare(
            right.admissionTimeUnixNano,
          ) ||
          left.traceId.localeCompare(right.traceId) ||
          left.deliveryIdentity.localeCompare(right.deliveryIdentity),
      );
      while (
        sorted.length > maximumTraceCount ||
        sorted.reduce((total, row) => total + row.payloadBytes, 0) >
          maximumPayloadBytes
      ) {
        const index = sorted.findIndex(
          (row) => !protectedIdentities.includes(row.deliveryIdentity),
        );
        if (index < 0) break;
        sorted.splice(index, 1);
      }
      state.workingRows = sorted;
      if (!state.cannotEvict) state.forceCapacity = undefined;
    },
    writeLastTrustedTimeUnixNano: (value) => {
      fail("write-time");
      state.trustedTime = value;
    },
    commit: () => {
      fail("commit");
      state.rows = cloneEvidence(state.workingRows);
      state.transaction = false;
      state.committed = true;
    },
    rollback: () => {
      state.transaction = false;
      state.workingRows = cloneEvidence(state.rows);
      state.rolledBack = true;
      fail("rollback");
    },
  });
  return { database, state };
};

const invoke = (
  database: LocalSqliteReporterDatabase,
  admissionTimeUnixNano = "100",
  traces: readonly [RedactedCanonicalTrace, ...RedactedCanonicalTrace[]] = [
    createSanitizedRedactedCanonicalTraceFixture(),
  ],
) =>
  invokeDestinationReporterForTesting(
    createLocalSqliteReporter(database, policy()),
    { traces, admissionTimeUnixNano },
  );

const overrideDatabase = (
  database: LocalSqliteReporterDatabase,
  overrides: Partial<LocalSqliteReporterDatabase>,
): LocalSqliteReporterDatabase => Object.freeze({ ...database, ...overrides });

describe("Local SQLite Reporter preparation", () => {
  it("serializes one immutable row and complete portable dimensions", () => {
    const trace = createSanitizedRedactedCanonicalTraceFixture({
      sessionId: "session-fixture",
      tags: ["tag-b", "tag-a", "tag-a"],
      modelName: "model-fixture",
    });
    const prepared = prepareLocalSqliteTrace(trace, "25");
    expect(prepared).toMatchObject({
      deliveryIdentity: trace.delivery.identity,
      traceId: trace.graph.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.traceId,
      startTimeUnixNano: "1000000000",
      startTimeSortKey: "00000000001000000000",
      admissionTimeUnixNano: "25",
      admissionTimeSortKey: "00000000000000000025",
      protocolCompatibilityId: trace.protocolManifestId,
    });
    expect(prepared.payloadBytes).toBe(
      Buffer.byteLength(prepared.payloadUtf8, "utf8"),
    );
    expect(prepared.dimensions).toEqual([
      { kind: "branch", value: "fixture-branch", ordinal: 0 },
      { kind: "harness", value: "fixture-harness", ordinal: 0 },
      { kind: "model", value: "model-fixture", ordinal: 0 },
      { kind: "session", value: "session-fixture", ordinal: 0 },
      { kind: "tag", value: "tag-a", ordinal: 0 },
      { kind: "tag", value: "tag-b", ordinal: 1 },
    ]);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.dimensions)).toBe(true);
  });
});

describe("Local SQLite Reporter transaction", () => {
  it("accepts an insert and collapses an exact nonexpired retry", async () => {
    const fixture = fakeDatabase();
    const trace = createSanitizedRedactedCanonicalTraceFixture();
    await expect(invoke(fixture.database, "100", [trace])).resolves.toEqual({
      outcome: "accepted",
    });
    expect(fixture.state.rows).toHaveLength(1);
    expect(fixture.state.rows[0]?.admissionTimeUnixNano).toBe("100");

    fixture.state.committed = false;
    await expect(invoke(fixture.database, "110", [trace])).resolves.toEqual({
      outcome: "accepted",
    });
    expect(fixture.state.rows).toHaveLength(1);
    expect(fixture.state.rows[0]?.admissionTimeUnixNano).toBe("100");
    expect(fixture.state.inserted).toHaveLength(1);
  });

  it("retains equality and rejects one-unit-older duplicate evidence", async () => {
    const trace = createSanitizedRedactedCanonicalTraceFixture();
    const prepared = prepareLocalSqliteTrace(trace, "70");
    const equality = fakeDatabase({
      rows: [
        {
          deliveryIdentity: prepared.deliveryIdentity,
          traceId: prepared.traceId,
          admissionTimeUnixNano: "70",
          protocolCompatibilityId: prepared.protocolCompatibilityId,
          payloadSha256: prepared.payloadSha256,
          payloadBytes: prepared.payloadBytes,
        },
      ],
    });
    await expect(invoke(equality.database, "100", [trace])).resolves.toEqual({
      outcome: "accepted",
    });
    expect(equality.state.rows[0]?.admissionTimeUnixNano).toBe("70");

    const older = fakeDatabase({
      rows: [{ ...equality.state.rows[0]!, admissionTimeUnixNano: "69" }],
    });
    await expect(invoke(older.database, "100", [trace])).resolves.toEqual({
      outcome: "rejected",
      reason: "destination-retention",
    });
  });
});

describe("Local SQLite Reporter concurrent settlement", () => {
  it("rereads and classifies a concurrent uniqueness winner", async () => {
    const trace = createSanitizedRedactedCanonicalTraceFixture();
    const prepared = prepareLocalSqliteTrace(trace, "100");
    const winner = {
      deliveryIdentity: prepared.deliveryIdentity,
      traceId: prepared.traceId,
      admissionTimeUnixNano: "90",
      protocolCompatibilityId: prepared.protocolCompatibilityId,
      payloadSha256: prepared.payloadSha256,
      payloadBytes: prepared.payloadBytes,
    };
    const identical = fakeDatabase({ uniquenessWinner: winner });
    await expect(invoke(identical.database, "100", [trace])).resolves.toEqual({
      outcome: "accepted",
    });
    expect(identical.state.rows[0]?.admissionTimeUnixNano).toBe("90");

    const conflicting = fakeDatabase({
      uniquenessWinner: { ...winner, payloadSha256: "f".repeat(64) },
    });
    await expect(invoke(conflicting.database, "100", [trace])).resolves.toEqual(
      { outcome: "rejected" },
    );

    const expired = fakeDatabase({
      uniquenessWinner: { ...winner, admissionTimeUnixNano: "69" },
    });
    await expect(invoke(expired.database, "100", [trace])).resolves.toEqual({
      outcome: "rejected",
      reason: "destination-retention",
    });
  });

  it("rejects persisted admission drift instead of accepting it", async () => {
    const fixture = fakeDatabase({ corruptInsertedAdmission: "999" });
    await expect(invoke(fixture.database)).resolves.toEqual({
      outcome: "unavailable",
    });
    expect(fixture.state.committed).toBe(false);
  });
});

describe("Local SQLite Reporter atomic settlement", () => {
  it("rejects conflicting, expired, and noncoexisting batches atomically", async () => {
    const trace = createSanitizedRedactedCanonicalTraceFixture();
    const prepared = prepareLocalSqliteTrace(trace, "1");
    const conflicting = fakeDatabase({
      rows: [
        {
          deliveryIdentity: prepared.deliveryIdentity,
          traceId: prepared.traceId,
          admissionTimeUnixNano: "90",
          protocolCompatibilityId: prepared.protocolCompatibilityId,
          payloadSha256: "f".repeat(64),
          payloadBytes: prepared.payloadBytes,
        },
      ],
    });
    await expect(invoke(conflicting.database, "100", [trace])).resolves.toEqual(
      {
        outcome: "rejected",
      },
    );
    expect(conflicting.state.committed).toBe(false);

    const expired = fakeDatabase({
      rows: [
        {
          ...conflicting.state.rows[0]!,
          payloadSha256: prepared.payloadSha256,
          admissionTimeUnixNano: "69",
        },
      ],
    });
    await expect(invoke(expired.database, "100", [trace])).resolves.toEqual({
      outcome: "rejected",
      reason: "destination-retention",
    });
    expect(expired.state.inserted).toHaveLength(0);

    const capacity = fakeDatabase({
      forceCapacity: { traceCount: 101, payloadBytes: 1_000_001 },
    });
    await expect(invoke(capacity.database)).resolves.toEqual({
      outcome: "accepted",
    });
    const impossible = fakeDatabase({
      forceCapacity: { traceCount: 101, payloadBytes: 1_000_001 },
      cannotEvict: true,
    });
    await expect(invoke(impossible.database)).resolves.toEqual({
      outcome: "rejected",
      reason: "destination-capacity",
    });
  });
});

describe("Local SQLite Reporter lifecycle", () => {
  it("uses a nondecreasing trusted time and fails closed on a forward jump", async () => {
    const backward = fakeDatabase({ trustedTime: "110" });
    await expect(invoke(backward.database, "100")).resolves.toEqual({
      outcome: "accepted",
    });
    expect(backward.state.trustedTime).toBe("110");

    const threshold = fakeDatabase({ trustedTime: "100" });
    await expect(invoke(threshold.database, "3600000000100")).resolves.toEqual({
      outcome: "accepted",
    });

    const forward = fakeDatabase({ trustedTime: "100" });
    await expect(invoke(forward.database, "3600000000101")).resolves.toEqual({
      outcome: "unavailable",
      reason: "destination-retention",
    });
    expect(forward.state.inserted).toHaveLength(0);
    expect(forward.state.rolledBack).toBe(true);
  });

  it.each([
    "destination-busy",
    "destination-full",
    "destination-corrupt",
    "destination-migrating",
  ] as const)("maps the typed native failure %s", async (failureReason) => {
    const fixture = fakeDatabase({ failAt: "begin", failureReason });
    await expect(invoke(fixture.database)).resolves.toEqual({
      outcome: "unavailable",
      reason: failureReason,
    });
  });

  it("does not roll back a definite failed-to-begin busy result", async () => {
    const fixture = fakeDatabase({
      failAt: "begin",
      failureReason: "destination-busy",
    });
    const database = overrideDatabase(fixture.database, {
      rollback: () => {
        throw new Error("no-transaction");
      },
    });
    await expect(invoke(database)).resolves.toEqual({
      outcome: "unavailable",
      reason: "destination-busy",
    });
    expect(fixture.state.rolledBack).toBe(false);

    const ambiguous = fakeDatabase();
    await expect(
      invoke(
        overrideDatabase(ambiguous.database, {
          beginImmediate: () => {
            ambiguous.state.transaction = true;
            throw createLocalSqliteDatabaseFailure("destination-busy");
          },
        }),
      ),
    ).resolves.toEqual({
      outcome: "unavailable",
      reason: "destination-busy",
    });
    expect(ambiguous.state.rolledBack).toBe(true);
  });

  it("returns unknown for commit ambiguity and failed rollback", async () => {
    const commit = fakeDatabase({ failAt: "commit" });
    await expect(invoke(commit.database)).resolves.toEqual({
      outcome: "outcome-unknown",
    });
    const rollback = fakeDatabase({
      failAt: "rollback",
      dropConfirmation: true,
    });
    await expect(invoke(rollback.database)).resolves.toEqual({
      outcome: "outcome-unknown",
    });

    const trace = createSanitizedRedactedCanonicalTraceFixture();
    const prepared = prepareLocalSqliteTrace(trace, "100");
    const conflictRollback = fakeDatabase({
      failAt: "rollback",
      rows: [
        {
          deliveryIdentity: prepared.deliveryIdentity,
          traceId: prepared.traceId,
          admissionTimeUnixNano: "100",
          protocolCompatibilityId: prepared.protocolCompatibilityId,
          payloadSha256: "f".repeat(64),
          payloadBytes: prepared.payloadBytes,
        },
      ],
    });
    await expect(
      invoke(conflictRollback.database, "100", [trace]),
    ).resolves.toEqual({ outcome: "outcome-unknown" });
  });
});

describe("Local SQLite Reporter native evidence", () => {
  it("fails closed for invalid native evidence and lost transactions", async () => {
    const trace = createSanitizedRedactedCanonicalTraceFixture();
    const prepared = prepareLocalSqliteTrace(trace, "100");
    const invalidExisting: readonly unknown[] = [
      null,
      new Array(1),
      Object.assign(new Array(1), { canary: true }),
      Object.assign([], { canary: true }),
      [
        {
          deliveryIdentity: prepared.deliveryIdentity,
          traceId: prepared.traceId,
          admissionTimeUnixNano: "100",
          protocolCompatibilityId: prepared.protocolCompatibilityId,
          payloadSha256: prepared.payloadSha256,
          payloadBytes: 0,
        },
      ],
      new Proxy([], {
        ownKeys: () => {
          throw new Error("CANARY");
        },
      }),
    ];
    for (const evidence of invalidExisting) {
      const fixture = fakeDatabase();
      await expect(
        invoke(
          overrideDatabase(fixture.database, {
            readExisting: () => evidence as never,
          }),
        ),
      ).resolves.toEqual({ outcome: "unavailable" });
    }

    for (const capacity of [
      null,
      { traceCount: -1, payloadBytes: 0 },
      { traceCount: 0, payloadBytes: Number.NaN },
    ]) {
      const fixture = fakeDatabase();
      await expect(
        invoke(
          overrideDatabase(fixture.database, {
            readCapacity: () => capacity as never,
          }),
        ),
      ).resolves.toEqual({ outcome: "unavailable" });
    }

    for (const mutate of ["deleteExpiredBefore", "insertTrace"] as const) {
      const fixture = fakeDatabase();
      await expect(
        invoke(
          overrideDatabase(fixture.database, {
            [mutate]: (..._arguments: never[]) => {
              fixture.state.transaction = false;
            },
          }),
        ),
      ).resolves.toEqual({ outcome: "outcome-unknown" });
    }
  });

  it("contains invalid begin and uniqueness evidence", async () => {
    for (const beginImmediate of [
      () => undefined,
      () => {
        throw new Error("begin-failed");
      },
    ]) {
      const fixture = fakeDatabase();
      await expect(
        invoke(
          overrideDatabase(fixture.database, {
            beginImmediate,
            inTransaction: () => {
              throw new Error("transaction-state-failed");
            },
          }),
        ),
      ).resolves.toEqual({ outcome: "outcome-unknown" });
    }

    const invalidInsertion = fakeDatabase();
    await expect(
      invoke(
        overrideDatabase(invalidInsertion.database, {
          insertTrace: () => "CANARY" as never,
        }),
      ),
    ).resolves.toEqual({ outcome: "unavailable" });

    const invalidWinner = fakeDatabase();
    let reads = 0;
    await expect(
      invoke(
        overrideDatabase(invalidWinner.database, {
          insertTrace: () => "uniqueness-conflict",
          readExisting: () => (reads++ === 0 ? [] : [null as never]),
        }),
      ),
    ).resolves.toEqual({ outcome: "unavailable" });
  });
});

describe("Local SQLite Reporter transaction ambiguity", () => {
  it("contains every transaction-state ambiguity", async () => {
    const notStarted = fakeDatabase();
    await expect(
      invoke(
        overrideDatabase(notStarted.database, {
          beginImmediate: () => undefined,
          inTransaction: () => false,
        }),
      ),
    ).resolves.toEqual({ outcome: "unavailable" });

    const invalidTime = fakeDatabase({ trustedTime: "01" });
    await expect(invoke(invalidTime.database)).resolves.toEqual({
      outcome: "unavailable",
    });

    const failedForwardRollback = fakeDatabase({
      trustedTime: "100",
      failAt: "rollback",
    });
    await expect(
      invoke(failedForwardRollback.database, "3600000000101"),
    ).resolves.toEqual({ outcome: "outcome-unknown" });

    const belowAge = fakeDatabase();
    await expect(invoke(belowAge.database, "20")).resolves.toEqual({
      outcome: "accepted",
    });

    const controller = new AbortController();
    const aborted = fakeDatabase();
    await expect(
      invokeDestinationReporterForTesting(
        createLocalSqliteReporter(
          overrideDatabase(aborted.database, {
            readExisting: () => {
              controller.abort();
              return [];
            },
          }),
          policy(),
        ),
        {
          traces: [createSanitizedRedactedCanonicalTraceFixture()],
          admissionTimeUnixNano: "100",
          signal: controller.signal,
        },
      ),
    ).resolves.toEqual({ outcome: "outcome-unknown" });
    expect(aborted.state.rolledBack).toBe(true);

    const failedAbortController = new AbortController();
    const failedAbort = fakeDatabase({ failAt: "rollback" });
    await expect(
      invokeDestinationReporterForTesting(
        createLocalSqliteReporter(
          overrideDatabase(failedAbort.database, {
            readExisting: () => {
              failedAbortController.abort();
              return [];
            },
          }),
          policy(),
        ),
        {
          traces: [createSanitizedRedactedCanonicalTraceFixture()],
          admissionTimeUnixNano: "100",
          signal: failedAbortController.signal,
        },
      ),
    ).resolves.toEqual({ outcome: "outcome-unknown" });
  });
});

describe("Local SQLite Reporter post-mutation ambiguity", () => {
  it("contains capacity, metadata, and commit ambiguity", async () => {
    const afterEvictLost = fakeDatabase({
      forceCapacity: { traceCount: 101, payloadBytes: 1_000_001 },
    });
    await expect(
      invoke(
        overrideDatabase(afterEvictLost.database, {
          evictOldestUntilWithin: () => {
            afterEvictLost.state.forceCapacity = undefined;
            afterEvictLost.state.transaction = false;
          },
        }),
      ),
    ).resolves.toEqual({ outcome: "outcome-unknown" });

    const invalidAfterEvict = fakeDatabase({
      forceCapacity: { traceCount: 101, payloadBytes: 1_000_001 },
    });
    let capacityReads = 0;
    await expect(
      invoke(
        overrideDatabase(invalidAfterEvict.database, {
          readCapacity: () =>
            capacityReads++ === 0
              ? { traceCount: 101, payloadBytes: 1_000_001 }
              : { traceCount: -1, payloadBytes: 0 },
        }),
      ),
    ).resolves.toEqual({ outcome: "unavailable" });

    const afterTimeLost = fakeDatabase();
    await expect(
      invoke(
        overrideDatabase(afterTimeLost.database, {
          writeLastTrustedTimeUnixNano: () => {
            afterTimeLost.state.transaction = false;
          },
        }),
      ),
    ).resolves.toEqual({ outcome: "outcome-unknown" });

    const commitIncomplete = fakeDatabase();
    await expect(
      invoke(
        overrideDatabase(commitIncomplete.database, {
          commit: () => undefined,
        }),
      ),
    ).resolves.toEqual({ outcome: "outcome-unknown" });

    const primitiveFailure = fakeDatabase();
    await expect(
      invoke(
        overrideDatabase(primitiveFailure.database, {
          beginImmediate: () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- hostile native seams may throw non-Error values.
            throw "CANARY";
          },
        }),
      ),
    ).resolves.toEqual({ outcome: "unavailable" });
  });

  it("stops after read loss and treats mutation loss as unknown", async () => {
    const readLoss = fakeDatabase();
    let deleteCalled = false;
    await expect(
      invoke(
        overrideDatabase(readLoss.database, {
          readExisting: () => {
            readLoss.state.transaction = false;
            return [];
          },
          deleteExpiredBefore: () => {
            deleteCalled = true;
          },
        }),
      ),
    ).resolves.toEqual({ outcome: "outcome-unknown" });
    expect(deleteCalled).toBe(false);

    const mutationLoss = fakeDatabase();
    let durableDelete = false;
    let rollbackCalls = 0;
    await expect(
      invoke(
        overrideDatabase(mutationLoss.database, {
          deleteExpiredBefore: () => {
            durableDelete = true;
            mutationLoss.state.transaction = false;
          },
          rollback: () => {
            rollbackCalls += 1;
          },
        }),
      ),
    ).resolves.toEqual({ outcome: "outcome-unknown" });
    expect(durableDelete).toBe(true);
    expect(rollbackCalls).toBe(0);
  });
});

describe("Local SQLite Reporter hostile authority", () => {
  it("rejects malformed policy and database records before work", () => {
    const fixture = fakeDatabase();
    for (const invalid of [
      null,
      [],
      { ...policy(), extra: true },
      { ...policy(), maximumTraceCount: 0 },
      { ...policy(), maximumTraceCount: 1.5 },
      { ...policy(), maximumTraceCount: 1_000_001 },
      { ...policy(), maximumPayloadBytes: 0 },
      { ...policy(), maximumPayloadBytes: 10 * 1024 * 1024 * 1024 + 1 },
      { ...policy(), maximumAgeNanoseconds: "01" },
      { ...policy(), maximumAgeNanoseconds: "0" },
      { ...policy(), maximumAgeNanoseconds: "31536000000000001" },
      { ...policy(), maximumAgeNanoseconds: "18446744073709551615" },
      { ...policy(), maximumAgeNanoseconds: "18446744073709551616" },
      { ...policy(), maximumForwardJumpNanoseconds: "100" },
      Object.defineProperty({ ...policy() }, "maximumTraceCount", {
        get: () => 100,
      }),
    ])
      expect(() =>
        createLocalSqliteReporter(fixture.database, invalid),
      ).toThrowError("destination.local-sqlite.reporter.invalid");
    expect(() =>
      createLocalSqliteReporter(
        { ...fixture.database, extra: () => undefined },
        policy(),
      ),
    ).toThrowError("destination.local-sqlite.reporter.invalid");
    expect(() =>
      createLocalSqliteReporter(
        new Proxy(fixture.database, {
          ownKeys: () => {
            throw new Error("CANARY");
          },
        }),
        policy(),
      ),
    ).toThrowError("destination.local-sqlite.reporter.invalid");
    expect(fixture.state.transaction).toBe(false);
  });
});

// Compile-only guard: this package's suite does not silently replace the
// shared Reporter contract cases when the full native test adapter lands.
const sharedReporterCases: readonly DestinationContractCase[] = [];
void sharedReporterCases;
import { Buffer } from "node:buffer";
