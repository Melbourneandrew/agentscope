import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { createSanitizedRedactedCanonicalTraceFixture } from "@agentscope/protocol/testing";
import { describe, expect, it } from "vitest";

import { runLocalSqliteMigrations } from "../migrations.js";
import { prepareLocalSqliteTrace } from "../reporter/transaction.js";
import {
  createOwnedMigrationDatabase,
  createOwnedReporterDatabase,
  createOwnedRetrieverDatabase,
  initializeOwnedSqliteConnection,
  type OwnedSqliteConnection,
} from "./sqlite-port.js";

const owned = (database: DatabaseSync): OwnedSqliteConnection => ({
  close: () => {
    database.close();
  },
  exec: (sql) => {
    database.exec(sql);
  },
  get inTransaction() {
    return database.isTransaction;
  },
  pragma: (source) => {
    database.exec(`PRAGMA ${source}`);
  },
  prepare: (sql) => {
    const statement = database.prepare(sql);
    return {
      all: (...parameters) => statement.all(...(parameters as never[])),
      get: (...parameters) => statement.get(...(parameters as never[])),
      iterate: (...parameters) => statement.iterate(...(parameters as never[])),
      run: (...parameters) => statement.run(...(parameters as never[])),
    };
  },
});

const sortKey = (value: string): string => value.padStart(20, "0");

/* eslint-disable max-lines-per-function -- each case keeps a complete transaction or migration evidence path adjacent. */
describe("owned Local SQLite database ports", () => {
  it("migrates, writes, retains equality, and performs bounded metadata-first reads", async () => {
    const native = new DatabaseSync(":memory:");
    const database = owned(native);
    try {
      initializeOwnedSqliteConnection(database, 1_000);
      expect(
        runLocalSqliteMigrations(createOwnedMigrationDatabase(database)),
      ).toEqual({
        ok: true,
        state: "migrated",
      });

      const payloadUtf8 = JSON.stringify({ value: "x".repeat(1_024) });
      const payloadBytes = Buffer.byteLength(payloadUtf8);
      const reporter = createOwnedReporterDatabase(database);
      expect(reporter.inTransaction()).toBe(false);
      reporter.beginImmediate();
      expect(
        reporter.insertTrace({
          deliveryIdentity: "1".repeat(64),
          traceId: "2".repeat(32),
          startTimeUnixNano: "100",
          startTimeSortKey: sortKey("100"),
          admissionTimeUnixNano: "200",
          admissionTimeSortKey: sortKey("200"),
          protocolCompatibilityId: "protocol-v1",
          payloadUtf8,
          payloadSha256: createHash("sha256").update(payloadUtf8).digest("hex"),
          payloadBytes,
          dimensions: [],
        }),
      ).toBe("inserted");
      reporter.writeLastTrustedTimeUnixNano("300");
      reporter.commit();

      reporter.beginImmediate();
      reporter.deleteExpiredBefore("200", []);
      expect(reporter.readCapacity()).toEqual({
        traceCount: 1,
        payloadBytes,
      });
      reporter.commit();

      const retriever = createOwnedRetrieverDatabase(database, {
        maximumAgeNanoseconds: "100",
        maximumPayloadBytes: 1_000_000,
        maximumTraceCount: 10,
      });
      const searchSql = `SELECT delivery_identity, trace_id, start_time_sort_key,
  admission_time_sort_key, protocol_compatibility_id,
  payload_sha256, payload_bytes
FROM traces WHERE admission_time_sort_key >= :retentionCutoffSortKey`;
      await expect(
        retriever.search(
          {
            planVersion: 1,
            sql: searchSql,
            parameters: {},
            maximumRows: 2,
            maximumResponseBytes: payloadBytes - 1,
            maximumWorkMilliseconds: 1_000,
            retentionCutoffParameter: "retentionCutoffSortKey",
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ rows: [], responseByteLimitReached: true });

      await expect(
        retriever.search(
          {
            planVersion: 1,
            sql: searchSql,
            parameters: {},
            maximumRows: 2,
            maximumResponseBytes: payloadBytes,
            maximumWorkMilliseconds: 1_000,
            retentionCutoffParameter: "retentionCutoffSortKey",
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            deliveryIdentity: "1".repeat(64),
            payloadBytes,
            payloadUtf8,
          },
        ],
        responseByteLimitReached: false,
      });
      await expect(
        retriever.get(
          {
            planVersion: 1,
            sql: "SELECT delivery_identity, trace_id, start_time_sort_key, admission_time_sort_key, protocol_compatibility_id, payload_sha256, payload_bytes FROM traces WHERE trace_id = :traceId AND admission_time_sort_key >= :retentionCutoffSortKey",
            parameters: { traceId: "f".repeat(32) },
            maximumResponseBytes: payloadBytes,
            maximumWorkMilliseconds: 1_000,
            retentionCutoffParameter: "retentionCutoffSortKey",
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ row: undefined });
    } finally {
      database.close();
    }
  });

  it("exposes exact migration, immutable-row, and rebuilt projection evidence", () => {
    const native = new DatabaseSync(":memory:");
    const database = owned(native);
    try {
      const migrations = createOwnedMigrationDatabase(database);
      expect(migrations.readMigrationLedger()).toEqual([]);
      expect(migrations.readDestinationMetadata()).toBeUndefined();
      expect(migrations.readImmutableRows()).toEqual([]);
      expect(migrations.readPortableProjections()).toEqual([]);
      expect(migrations.readExpectedPortableProjections()).toEqual([]);
      expect(runLocalSqliteMigrations(migrations)).toEqual({
        ok: true,
        state: "migrated",
      });
      expect(migrations.readMigrationLedger()).toHaveLength(2);
      const metadata = migrations.readDestinationMetadata();
      expect(metadata).toMatchObject({
        destinationFormat: "agentscope.local-sqlite.v1",
      });
      if (metadata === undefined) throw new Error("expected metadata");
      migrations.writeDestinationMetadata(metadata);

      const trace = prepareLocalSqliteTrace(
        createSanitizedRedactedCanonicalTraceFixture({
          modelName: "model-a",
          sessionId: "session-a",
          tags: ["tag-b", "tag-a"],
        }),
        "200",
      );
      const reporter = createOwnedReporterDatabase(database);
      reporter.beginImmediate();
      expect(reporter.insertTrace(trace)).toBe("inserted");
      reporter.commit();

      expect(migrations.readImmutableRows()).toEqual([
        expect.objectContaining({
          deliveryIdentity: trace.deliveryIdentity,
          payloadBytes: trace.payloadBytes,
          traceId: trace.traceId,
        }),
      ]);
      const expected = migrations.readExpectedPortableProjections();
      expect(expected).toEqual(migrations.readPortableProjections());
      expect(expected.map(({ kind }) => kind)).toEqual([
        "branch",
        "harness",
        "model",
        "session",
        "tag",
        "tag",
      ]);
      database.exec("DELETE FROM trace_dimensions");
      expect(migrations.readPortableProjections()).toEqual([]);
      migrations.rebuildPortableProjections();
      expect(migrations.readPortableProjections()).toEqual(expected);

      migrations.beginExclusive();
      expect(migrations.inTransaction()).toBe(true);
      migrations.execute("CREATE TABLE synthetic_rollback(value TEXT)");
      migrations.rollback();
      expect(
        database
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE name = 'synthetic_rollback'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("supports duplicate detection, protected retention, deterministic eviction, and rollback", () => {
    const native = new DatabaseSync(":memory:");
    const database = owned(native);
    try {
      expect(
        runLocalSqliteMigrations(createOwnedMigrationDatabase(database)),
      ).toMatchObject({ ok: true });
      const reporter = createOwnedReporterDatabase(database);
      const trace = prepareLocalSqliteTrace(
        createSanitizedRedactedCanonicalTraceFixture(),
        "100",
      );
      reporter.beginImmediate();
      expect(reporter.readLastTrustedTimeUnixNano()).toBeUndefined();
      expect(reporter.readExisting([])).toEqual([]);
      expect(reporter.insertTrace(trace)).toBe("inserted");
      reporter.writeLastTrustedTimeUnixNano("200");
      reporter.commit();
      expect(reporter.readExisting([trace.deliveryIdentity])).toEqual([
        expect.objectContaining({
          admissionTimeUnixNano: "100",
          deliveryIdentity: trace.deliveryIdentity,
        }),
      ]);
      expect(reporter.readLastTrustedTimeUnixNano()).toBe("200");

      reporter.beginImmediate();
      reporter.deleteExpiredBefore("101", [trace.deliveryIdentity]);
      expect(reporter.readCapacity().traceCount).toBe(1);
      reporter.evictOldestUntilWithin(0, 0, [trace.deliveryIdentity]);
      expect(reporter.readCapacity().traceCount).toBe(1);
      reporter.rollback();

      reporter.beginImmediate();
      reporter.evictOldestUntilWithin(0, 0, []);
      expect(reporter.readCapacity()).toEqual({
        payloadBytes: 0,
        traceCount: 0,
      });
      reporter.rollback();
      expect(reporter.readCapacity().traceCount).toBe(1);

      reporter.beginImmediate();
      reporter.deleteExpiredBefore("101", []);
      reporter.commit();
      expect(reporter.readCapacity().traceCount).toBe(0);
    } finally {
      database.close();
    }
  });

  it("translates exact SQLite failure families and preserves unknown errors", () => {
    const failing = (code: string | undefined): OwnedSqliteConnection => ({
      close: () => undefined,
      exec: () => undefined,
      inTransaction: false,
      pragma: () => {
        const error = new Error("synthetic database failure");
        if (code !== undefined) Object.assign(error, { code });
        throw error;
      },
      prepare: () => {
        throw new Error("unexpected prepare");
      },
    });
    for (const code of [
      "SQLITE_BUSY",
      "SQLITE_LOCKED_SHAREDCACHE",
      "SQLITE_FULL",
      "SQLITE_CORRUPT",
      "SQLITE_NOTADB",
      "SQLITE_SCHEMA",
    ]) {
      expect(() => {
        initializeOwnedSqliteConnection(failing(code), 1);
      }).toThrow("destination.local-sqlite.unavailable");
    }
    expect(() => {
      initializeOwnedSqliteConnection(failing(undefined), 1);
    }).toThrow("synthetic database failure");

    const constraint = new Error("synthetic uniqueness");
    Object.assign(constraint, { code: "SQLITE_CONSTRAINT_PRIMARYKEY" });
    const uniquenessDatabase: OwnedSqliteConnection = {
      close: () => undefined,
      exec: () => undefined,
      inTransaction: true,
      pragma: () => undefined,
      prepare: () => ({
        all: () => [],
        get: () => undefined,
        iterate: () => [],
        run: () => {
          throw constraint;
        },
      }),
    };
    expect(
      createOwnedReporterDatabase(uniquenessDatabase).insertTrace(
        prepareLocalSqliteTrace(
          createSanitizedRedactedCanonicalTraceFixture(),
          "1",
        ),
      ),
    ).toBe("uniqueness-conflict");
  });

  it("rolls back aborted Retriever reads without exposing partial evidence", async () => {
    const native = new DatabaseSync(":memory:");
    const database = owned(native);
    try {
      expect(
        runLocalSqliteMigrations(createOwnedMigrationDatabase(database)),
      ).toMatchObject({ ok: true });
      const retriever = createOwnedRetrieverDatabase(database, {
        maximumAgeNanoseconds: "100",
        maximumPayloadBytes: 1_000_000,
        maximumTraceCount: 10,
      });
      const controller = new AbortController();
      controller.abort();
      await expect(
        retriever.search(
          {
            planVersion: 1,
            sql: "SELECT * FROM traces",
            parameters: {},
            maximumRows: 1,
            maximumResponseBytes: 1,
            maximumWorkMilliseconds: 1,
            retentionCutoffParameter: "retentionCutoffSortKey",
          },
          controller.signal,
        ),
      ).rejects.toThrow("retrieval-aborted");
      expect(database.inTransaction).toBe(false);
      await expect(
        retriever.get(
          {
            planVersion: 1,
            sql: "SELECT * FROM traces WHERE trace_id = :traceId",
            parameters: { traceId: "1".repeat(32) },
            maximumResponseBytes: 1,
            maximumWorkMilliseconds: 1,
            retentionCutoffParameter: "retentionCutoffSortKey",
          },
          controller.signal,
        ),
      ).rejects.toThrow("retrieval-aborted");
      expect(database.inTransaction).toBe(false);

      const noTransaction: OwnedSqliteConnection = {
        close: () => undefined,
        exec: () => undefined,
        inTransaction: false,
        pragma: () => undefined,
        prepare: () => ({
          all: () => [],
          get: () => undefined,
          iterate: () => [],
          run: () => undefined,
        }),
      };
      await expect(
        createOwnedRetrieverDatabase(noTransaction, {
          maximumAgeNanoseconds: "1",
          maximumPayloadBytes: 1,
          maximumTraceCount: 1,
        }).search(
          {
            planVersion: 1,
            sql: "SELECT 1",
            parameters: {},
            maximumRows: 1,
            maximumResponseBytes: 1,
            maximumWorkMilliseconds: 1,
            retentionCutoffParameter: "retentionCutoffSortKey",
          },
          controller.signal,
        ),
      ).rejects.toThrow("retrieval-aborted");

      for (const operation of ["search", "get"] as const) {
        const zeroBudgetRetriever = createOwnedRetrieverDatabase(
          database,
          {
            maximumAgeNanoseconds: "100",
            maximumPayloadBytes: 1_000_000,
            maximumTraceCount: 10,
          },
          () => 0,
        );
        const zeroBudgetSignal = new AbortController().signal;
        await expect(
          operation === "search"
            ? zeroBudgetRetriever.search(
                {
                  planVersion: 1,
                  sql: "SELECT 1",
                  parameters: {},
                  maximumRows: 1,
                  maximumResponseBytes: 1,
                  maximumWorkMilliseconds: 100,
                  retentionCutoffParameter: "retentionCutoffSortKey",
                },
                zeroBudgetSignal,
              )
            : zeroBudgetRetriever.get(
                {
                  planVersion: 1,
                  sql: "SELECT 1",
                  parameters: { traceId: "1".repeat(32) },
                  maximumResponseBytes: 1,
                  maximumWorkMilliseconds: 100,
                  retentionCutoffParameter: "retentionCutoffSortKey",
                },
                zeroBudgetSignal,
              ),
        ).rejects.toThrow("retrieval-aborted");
        expect(database.inTransaction).toBe(false);

        let remainingCalls = 0;
        const deadlineRetriever = createOwnedRetrieverDatabase(
          database,
          {
            maximumAgeNanoseconds: "100",
            maximumPayloadBytes: 1_000_000,
            maximumTraceCount: 10,
          },
          () => (++remainingCalls === 1 ? 100 : 0),
        );
        const activeSignal = new AbortController().signal;
        await expect(
          operation === "search"
            ? deadlineRetriever.search(
                {
                  planVersion: 1,
                  sql: "SELECT * FROM traces WHERE admission_time_sort_key >= :retentionCutoffSortKey",
                  parameters: {},
                  maximumRows: 1,
                  maximumResponseBytes: 1,
                  maximumWorkMilliseconds: 100,
                  retentionCutoffParameter: "retentionCutoffSortKey",
                },
                activeSignal,
              )
            : deadlineRetriever.get(
                {
                  planVersion: 1,
                  sql: "SELECT * FROM traces WHERE trace_id = :traceId AND admission_time_sort_key >= :retentionCutoffSortKey",
                  parameters: { traceId: "1".repeat(32) },
                  maximumResponseBytes: 1,
                  maximumWorkMilliseconds: 100,
                  retentionCutoffParameter: "retentionCutoffSortKey",
                },
                activeSignal,
              ),
        ).rejects.toThrow("retrieval-aborted");
        expect(database.inTransaction).toBe(false);
      }
    } finally {
      database.close();
    }
  });

  it("rejects malformed migration rows and projection payload evidence before allocation", () => {
    const migrationForRows = (rows: Iterable<unknown>) => {
      const database: OwnedSqliteConnection = {
        close: () => undefined,
        exec: () => undefined,
        inTransaction: false,
        pragma: () => undefined,
        prepare: (sql) => ({
          all: () => [...rows],
          get: () =>
            sql.includes("sqlite_schema") ? { present: 1 } : undefined,
          iterate: () => rows,
          run: () => undefined,
        }),
      };
      return createOwnedMigrationDatabase(database);
    };
    for (const rows of [
      [null],
      [
        {
          delivery_identity: "1".repeat(64),
          payload: "not-bytes",
          payload_bytes: 1,
        },
      ],
      [
        {
          delivery_identity: "1".repeat(64),
          payload: Buffer.alloc(0),
          payload_bytes: 0,
        },
      ],
      [
        {
          delivery_identity: "1".repeat(64),
          payload: Buffer.from("not-json"),
          payload_bytes: 8,
        },
      ],
    ])
      expect(() =>
        migrationForRows(rows).readExpectedPortableProjections(),
      ).toThrow(
        /^destination\.local-sqlite\.(?:database|projection)\.invalid$/u,
      );
    expect(() =>
      migrationForRows([
        {
          delivery_identity: "1".repeat(64),
          payload_bytes: 256 * 1_024 * 1_024,
        },
      ]).readExpectedPortableProjections(),
    ).toThrow("destination.local-sqlite.evidence.invalid");

    const excessiveProjectionTrace = prepareLocalSqliteTrace(
      createSanitizedRedactedCanonicalTraceFixture(),
      "1",
    );
    const excessiveEnvelope = JSON.parse(
      excessiveProjectionTrace.payloadUtf8,
    ) as {
      graph: {
        resourceSpans: Array<{
          scopeSpans: Array<{
            spans: Array<{
              attributes: Array<{
                key: string;
                value: { stringValue?: string };
              }>;
            }>;
          }>;
        }>;
      };
    };
    const model = excessiveEnvelope.graph.resourceSpans
      .flatMap(({ scopeSpans }) => scopeSpans)
      .flatMap(({ spans }) => spans)
      .flatMap(({ attributes }) => attributes)
      .find(({ key }) => key === "llm.model_name");
    if (model === undefined) throw new Error("expected model fixture");
    model.value.stringValue = "m".repeat(1_025);
    const excessivePayload = JSON.stringify(excessiveEnvelope);
    expect(() =>
      migrationForRows([
        {
          delivery_identity: excessiveProjectionTrace.deliveryIdentity,
          payload: Buffer.from(excessivePayload, "utf8"),
          payload_bytes: Buffer.byteLength(excessivePayload, "utf8"),
        },
      ]).readExpectedPortableProjections(),
    ).toThrow("destination.local-sqlite.projection.invalid");
  });

  it("rejects incomplete metadata and non-constraint insertion failures", () => {
    const native = new DatabaseSync(":memory:");
    const database = owned(native);
    try {
      database.exec(
        "CREATE TABLE destination_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO destination_metadata VALUES ('destination_format', 'x')",
      );
      expect(
        createOwnedMigrationDatabase(database).readDestinationMetadata(),
      ).toBeUndefined();
    } finally {
      database.close();
    }

    const failure = new Error("synthetic non-constraint insert failure");
    const failing: OwnedSqliteConnection = {
      close: () => undefined,
      exec: () => undefined,
      inTransaction: true,
      pragma: () => undefined,
      prepare: () => ({
        all: () => [],
        get: () => undefined,
        iterate: () => [],
        run: () => {
          throw failure;
        },
      }),
    };
    expect(() =>
      createOwnedReporterDatabase(failing).insertTrace(
        prepareLocalSqliteTrace(
          createSanitizedRedactedCanonicalTraceFixture(),
          "1",
        ),
      ),
    ).toThrow("synthetic non-constraint insert failure");
  });

  it("rejects missing or malformed Retriever payload rereads and rolls back", async () => {
    type RetrievalMode =
      "missing-payload" | "invalid-size" | "abort-after-query";
    const trace = prepareLocalSqliteTrace(
      createSanitizedRedactedCanonicalTraceFixture(),
      "1",
    );
    const row = {
      delivery_identity: trace.deliveryIdentity,
      trace_id: trace.traceId,
      start_time_sort_key: trace.startTimeSortKey,
      admission_time_sort_key: trace.admissionTimeSortKey,
      protocol_compatibility_id: trace.protocolCompatibilityId,
      payload_sha256: trace.payloadSha256,
      payload_bytes: trace.payloadBytes,
    };
    const controller = new AbortController();
    let transaction = false;
    const connectionFor = (mode: RetrievalMode): OwnedSqliteConnection => ({
      close: () => undefined,
      exec: (sql) => {
        if (sql === "BEGIN") transaction = true;
        if (sql === "ROLLBACK" || sql === "COMMIT") transaction = false;
      },
      get inTransaction() {
        return transaction;
      },
      pragma: () => undefined,
      prepare: (sql) => ({
        all: () => {
          if (mode === "abort-after-query") controller.abort();
          return [
            {
              ...row,
              payload_bytes: mode === "invalid-size" ? 0 : row.payload_bytes,
            },
          ];
        },
        get: () => {
          if (sql.includes("last_trusted_time")) return undefined;
          if (
            sql.includes("content_revision") ||
            sql.includes("migration_manifest_id")
          )
            return undefined;
          if (sql.includes("substr(payload")) return undefined;
          return {
            ...row,
            payload_bytes: mode === "invalid-size" ? 0 : row.payload_bytes,
          };
        },
        iterate: () => [],
        run: () => undefined,
      }),
    });
    const searchPlan = {
      planVersion: 1 as const,
      sql: "SELECT metadata",
      parameters: {},
      maximumRows: 1,
      maximumResponseBytes: 1_000_000,
      maximumWorkMilliseconds: 1,
      retentionCutoffParameter: "retentionCutoffSortKey" as const,
    };
    for (const mode of [
      "missing-payload",
      "invalid-size",
      "abort-after-query",
    ] as const) {
      transaction = false;
      const signal =
        mode === "abort-after-query"
          ? controller.signal
          : new AbortController().signal;
      await expect(
        createOwnedRetrieverDatabase(connectionFor(mode), {
          maximumAgeNanoseconds: "1",
          maximumPayloadBytes: 1_000_000,
          maximumTraceCount: 1,
        }).search(searchPlan, signal),
      ).rejects.toThrow(
        mode === "abort-after-query"
          ? "retrieval-aborted"
          : mode === "invalid-size"
            ? "destination.local-sqlite.database.invalid"
            : "destination.local-sqlite.database.invalid",
      );
      expect(transaction).toBe(false);
    }

    transaction = false;
    await expect(
      createOwnedRetrieverDatabase(connectionFor("invalid-size"), {
        maximumAgeNanoseconds: "1",
        maximumPayloadBytes: 1_000_000,
        maximumTraceCount: 1,
      }).get(
        {
          planVersion: 1,
          sql: "SELECT metadata",
          parameters: { traceId: trace.traceId },
          maximumResponseBytes: 1_000_000,
          maximumWorkMilliseconds: 1,
          retentionCutoffParameter: "retentionCutoffSortKey",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("retrieval-response-too-large");
    expect(transaction).toBe(false);
  });
});
/* eslint-enable max-lines-per-function */
