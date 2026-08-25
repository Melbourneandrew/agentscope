/* eslint-disable max-lines-per-function, @typescript-eslint/require-await -- exact SQLite adapters keep query/result validation adjacent and implement asynchronous family ports. */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { readPersistedCanonicalEnvelope } from "@agentscope/protocol";

import type {
  LocalSqliteDestinationMetadata,
  LocalSqliteImmutableRowEvidence,
  LocalSqliteMigrationDatabase,
  LocalSqliteMigrationLedgerEntry,
  LocalSqliteProjectionEvidence,
} from "../migrations.js";
import {
  createLocalSqliteDatabaseFailure,
  type LocalSqlitePreparedDimension,
  type LocalSqlitePreparedTrace,
  type LocalSqliteReporterDatabase,
} from "../reporter/transaction.js";
import type {
  LocalSqliteGetEvidence,
  LocalSqliteGetPlan,
  LocalSqliteRetrievalRow,
  LocalSqliteRetrieverDatabase,
  LocalSqliteSearchEvidence,
  LocalSqliteSearchPlan,
} from "../retriever/index.js";

export type OwnedSqliteStatement = Readonly<{
  all: (...parameters: readonly unknown[]) => readonly unknown[];
  get: (...parameters: readonly unknown[]) => unknown;
  iterate: (...parameters: readonly unknown[]) => Iterable<unknown>;
  run: (...parameters: readonly unknown[]) => unknown;
}>;

export type OwnedSqliteConnection = Readonly<{
  backup?: (filename: string) => Promise<unknown>;
  close: () => void;
  exec: (sql: string) => unknown;
  inTransaction: boolean;
  pragma: (source: string, options?: Readonly<{ simple?: boolean }>) => unknown;
  prepare: (sql: string) => OwnedSqliteStatement;
}>;

export type LocalSqliteExecutionPolicy = Readonly<{
  maximumAgeNanoseconds: string;
  maximumPayloadBytes: number;
  maximumTraceCount: number;
}>;

const maximumEvidenceRows = 1_000_000;
const maximumEvidenceBytes = 256 * 1_024 * 1_024;
const maximumPayloadBytes = 16 * 1_024 * 1_024;
const maximumProjectionValues = 256;
const maximumProjectionValueBytes = 1_024;
const encoder = new TextEncoder();

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const toBuffer = (value: unknown): Buffer => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error("destination.local-sqlite.database.invalid");
};

const rowRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null)
    throw new Error("destination.local-sqlite.database.invalid");
  return value as Record<string, unknown>;
};

const sqliteCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const translateDatabaseError = (error: unknown): never => {
  const code = sqliteCode(error);
  if (code?.startsWith("SQLITE_BUSY") || code?.startsWith("SQLITE_LOCKED"))
    throw createLocalSqliteDatabaseFailure("destination-busy");
  if (code?.startsWith("SQLITE_FULL"))
    throw createLocalSqliteDatabaseFailure("destination-full");
  if (code?.startsWith("SQLITE_CORRUPT") || code?.startsWith("SQLITE_NOTADB"))
    throw createLocalSqliteDatabaseFailure("destination-corrupt");
  if (code?.startsWith("SQLITE_SCHEMA"))
    throw createLocalSqliteDatabaseFailure("destination-migrating");
  throw error;
};

const databaseCall = <Value>(operation: () => Value): Value => {
  try {
    return operation();
  } catch (error) {
    return translateDatabaseError(error);
  }
};

const tableExists = (database: OwnedSqliteConnection, table: string): boolean =>
  database
    .prepare(
      "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?",
    )
    .get(table) !== undefined;

const boundedRows = (
  rows: Iterable<unknown>,
  estimate: (row: Record<string, unknown>) => number,
): readonly Record<string, unknown>[] => {
  const output: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const value of rows) {
    /* v8 ignore next -- the exact 1,000,001-row boundary would require an
       unsafe unit-test allocation; smaller malformed and byte-limit streams
       exercise the same pre-return rejection path. */
    if (output.length === maximumEvidenceRows)
      throw new Error("destination.local-sqlite.evidence.invalid");
    const row = rowRecord(value);
    bytes += estimate(row);
    if (bytes > maximumEvidenceBytes)
      throw new Error("destination.local-sqlite.evidence.invalid");
    output.push(row);
  }
  return Object.freeze(output);
};

const stringAttribute = (
  attributes:
    | readonly Readonly<{
        key: string;
        value: Readonly<Record<string, unknown>>;
      }>[]
    | undefined,
  key: string,
): string | undefined => {
  const value = attributes?.find((entry) => entry.key === key)?.value;
  return typeof value?.stringValue === "string" ? value.stringValue : undefined;
};

const stringArrayAttribute = (
  attributes:
    | readonly Readonly<{
        key: string;
        value: Readonly<Record<string, unknown>>;
      }>[]
    | undefined,
  key: string,
): readonly string[] => {
  const value = attributes?.find((entry) => entry.key === key)?.value;
  const values = (
    value?.arrayValue as
      | Readonly<{ values?: readonly Readonly<Record<string, unknown>>[] }>
      | undefined
  )?.values;
  return Object.freeze(
    values?.flatMap((entry) => {
      /* v8 ignore else -- the persisted Protocol reader rejects non-string tag
         array members; the production fixture exercises the string branch. */
      if (typeof entry.stringValue === "string") return [entry.stringValue];
      /* v8 ignore next -- paired with the Protocol-owned invariant above. */
      return [];
    }) ?? [],
  );
};

const optionalProjectionValues = (
  value: string | undefined,
): readonly string[] => {
  /* v8 ignore next -- Protocol permits these projections to be absent;
     omission contributes no row and the fixed production fixture supplies it. */
  return value === undefined ? [] : [value];
};

const exactProjectionValues = (
  values: readonly string[],
): readonly string[] => {
  const unique = [...new Set(values)].sort();
  if (
    unique.length > maximumProjectionValues ||
    unique.some(
      (value) =>
        value.length === 0 ||
        encoder.encode(value).byteLength > maximumProjectionValueBytes,
    )
  )
    throw new Error("destination.local-sqlite.projection.invalid");
  return Object.freeze(unique);
};

const expectedProjections = (
  deliveryIdentity: string,
  payload: Buffer,
): readonly LocalSqliteProjectionEvidence[] => {
  if (payload.byteLength < 1 || payload.byteLength > maximumPayloadBytes)
    throw new Error("destination.local-sqlite.projection.invalid");
  const read = readPersistedCanonicalEnvelope(payload.toString("utf8"));
  if (!read.ok) throw new Error("destination.local-sqlite.projection.invalid");
  const resourceSpans = read.envelope.graph.resourceSpans;
  const spans = resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) => scope.spans),
  );
  const root = spans.find((span) => span.parentSpanId === undefined);
  /* v8 ignore next -- Protocol's persisted canonical reader admits exactly one
     root before returning a successful envelope. */
  if (root === undefined)
    throw new Error("destination.local-sqlite.projection.invalid");
  const resource = resourceSpans.find((candidate) =>
    candidate.scopeSpans.some((scope) => scope.spans.includes(root)),
  );
  const groups: readonly Readonly<{
    kind: LocalSqlitePreparedDimension["kind"];
    values: readonly string[];
  }>[] = [
    {
      kind: "branch",
      values: optionalProjectionValues(
        stringAttribute(resource?.resource?.attributes, "vcs.ref.head.name"),
      ),
    },
    {
      kind: "harness",
      values: optionalProjectionValues(
        stringAttribute(root.attributes, "agentscope.harness.name"),
      ),
    },
    {
      kind: "model",
      values: spans.flatMap((span) =>
        [
          "llm.model_name",
          "embedding.model_name",
          "reranker.model_name",
        ].flatMap((key) => {
          const value = stringAttribute(span.attributes, key);
          return value === undefined ? [] : [value];
        }),
      ),
    },
    {
      kind: "session",
      values: [stringAttribute(root.attributes, "session.id")].flatMap(
        (value) => (value === undefined ? [] : [value]),
      ),
    },
    { kind: "tag", values: stringArrayAttribute(root.attributes, "tag.tags") },
  ];
  return Object.freeze(
    groups.flatMap(({ kind, values }) =>
      exactProjectionValues(values).map((value, ordinal) =>
        Object.freeze({ deliveryIdentity, kind, ordinal, value }),
      ),
    ),
  );
};

const readExpectedProjectionRows = (
  database: OwnedSqliteConnection,
): readonly LocalSqliteProjectionEvidence[] => {
  if (!tableExists(database, "traces")) return Object.freeze([]);
  const rows = boundedRows(
    database
      .prepare("SELECT delivery_identity, payload, payload_bytes FROM traces")
      .iterate(),
    (row) => Number(row.payload_bytes) + String(row.delivery_identity).length,
  );
  return Object.freeze(
    rows.flatMap((row) =>
      expectedProjections(String(row.delivery_identity), toBuffer(row.payload)),
    ),
  );
};

export const createOwnedMigrationDatabase = (
  database: OwnedSqliteConnection,
): LocalSqliteMigrationDatabase =>
  Object.freeze({
    beginExclusive: () => databaseCall(() => database.exec("BEGIN EXCLUSIVE")),
    execute: (statement) => databaseCall(() => database.exec(statement)),
    inTransaction: () => database.inTransaction,
    readMigrationLedger: () =>
      databaseCall(() => {
        if (!tableExists(database, "schema_migrations"))
          return Object.freeze([]);
        return Object.freeze(
          boundedRows(
            database
              .prepare(
                "SELECT version, ordinal, name, sha256 FROM schema_migrations ORDER BY ordinal ASC",
              )
              .iterate(),
            (row) => String(row.name).length + String(row.sha256).length + 16,
          ).map((row) =>
            Object.freeze({
              version: Number(row.version),
              ordinal: Number(row.ordinal),
              name: String(row.name),
              sha256: String(row.sha256),
            }),
          ),
        );
      }),
    recordMigration: (entry: LocalSqliteMigrationLedgerEntry) =>
      databaseCall(() =>
        database
          .prepare(
            "INSERT INTO schema_migrations(version, ordinal, name, sha256) VALUES (?, ?, ?, ?)",
          )
          .run(entry.version, entry.ordinal, entry.name, entry.sha256),
      ),
    readDestinationMetadata: () =>
      databaseCall(() => {
        if (!tableExists(database, "destination_metadata")) return undefined;
        const rows = database
          .prepare(
            "SELECT key, value FROM destination_metadata WHERE key IN ('destination_format', 'lifecycle_capability_version', 'lifecycle_fingerprint', 'migration_manifest_id', 'protocol_compatibility_id', 'recovery_handler_id') ORDER BY key ASC",
          )
          .all()
          .map(rowRecord);
        const values = new Map(
          rows.map((row) => [String(row.key), String(row.value)]),
        );
        if (values.size !== 6) return undefined;
        const lifecycleCapabilityVersion = Number(
          values.get("lifecycle_capability_version"),
        );
        if (!Number.isSafeInteger(lifecycleCapabilityVersion)) return undefined;
        return Object.freeze({
          destinationFormat: values.get("destination_format")!,
          lifecycleCapabilityVersion,
          lifecycleFingerprint: values.get("lifecycle_fingerprint")!,
          migrationManifestId: values.get("migration_manifest_id")!,
          protocolCompatibilityId: values.get("protocol_compatibility_id")!,
          recoveryHandlerId: values.get("recovery_handler_id")!,
        });
      }),
    writeDestinationMetadata: (metadata: LocalSqliteDestinationMetadata) => {
      databaseCall(() => {
        const statement = database.prepare(
          "INSERT INTO destination_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        );
        statement.run("destination_format", metadata.destinationFormat);
        statement.run(
          "lifecycle_capability_version",
          String(metadata.lifecycleCapabilityVersion),
        );
        statement.run("lifecycle_fingerprint", metadata.lifecycleFingerprint);
        statement.run("migration_manifest_id", metadata.migrationManifestId);
        statement.run(
          "protocol_compatibility_id",
          metadata.protocolCompatibilityId,
        );
        statement.run("recovery_handler_id", metadata.recoveryHandlerId);
      });
    },
    readImmutableRows: () =>
      databaseCall(() => {
        if (!tableExists(database, "traces")) return Object.freeze([]);
        return Object.freeze(
          boundedRows(
            database
              .prepare(
                `SELECT delivery_identity, trace_id, start_time_unix_nano,
                        start_time_sort_key, admission_time_unix_nano,
                        admission_time_sort_key, protocol_compatibility_id,
                        payload_sha256, payload_bytes FROM traces`,
              )
              .iterate(),
            (row) => Number(row.payload_bytes) + 512,
          ).map((row): LocalSqliteImmutableRowEvidence =>
            Object.freeze({
              deliveryIdentity: String(row.delivery_identity),
              traceId: String(row.trace_id),
              startTimeUnixNano: String(row.start_time_unix_nano),
              startTimeSortKey: String(row.start_time_sort_key),
              admissionTimeUnixNano: String(row.admission_time_unix_nano),
              admissionTimeSortKey: String(row.admission_time_sort_key),
              protocolCompatibilityId: String(row.protocol_compatibility_id),
              payloadSha256: String(row.payload_sha256),
              payloadBytes: Number(row.payload_bytes),
            }),
          ),
        );
      }),
    rebuildPortableProjections: () => {
      databaseCall(() => {
        const expected = readExpectedProjectionRows(database);
        database.exec("DELETE FROM trace_dimensions");
        const insert = database.prepare(
          "INSERT INTO trace_dimensions(delivery_identity, kind, value, ordinal) VALUES (?, ?, ?, ?)",
        );
        for (const projection of expected)
          insert.run(
            projection.deliveryIdentity,
            projection.kind,
            projection.value,
            projection.ordinal,
          );
      });
    },
    readPortableProjections: () =>
      databaseCall(() => {
        if (!tableExists(database, "trace_dimensions"))
          return Object.freeze([]);
        return Object.freeze(
          boundedRows(
            database
              .prepare(
                "SELECT delivery_identity, kind, value, ordinal FROM trace_dimensions",
              )
              .iterate(),
            (row) =>
              String(row.delivery_identity).length +
              String(row.kind).length +
              String(row.value).length +
              8,
          ).map((row): LocalSqliteProjectionEvidence =>
            Object.freeze({
              deliveryIdentity: String(row.delivery_identity),
              kind: String(row.kind),
              value: String(row.value),
              ordinal: Number(row.ordinal),
            }),
          ),
        );
      }),
    readExpectedPortableProjections: () =>
      databaseCall(() => readExpectedProjectionRows(database)),
    commit: () => databaseCall(() => database.exec("COMMIT")),
    rollback: () => databaseCall(() => database.exec("ROLLBACK")),
  });

const placeholders = (count: number): string =>
  Array.from({ length: count }, () => "?").join(", ");

const protectedClause = (
  identities: readonly string[],
): Readonly<{ sql: string; parameters: readonly string[] }> =>
  identities.length === 0
    ? Object.freeze({ sql: "", parameters: Object.freeze([]) })
    : Object.freeze({
        sql: ` AND delivery_identity NOT IN (${placeholders(identities.length)})`,
        parameters: Object.freeze([...identities]),
      });

const storedTrace = (row: Record<string, unknown>) =>
  Object.freeze({
    deliveryIdentity: String(row.delivery_identity),
    traceId: String(row.trace_id),
    admissionTimeUnixNano: String(row.admission_time_unix_nano),
    protocolCompatibilityId: String(row.protocol_compatibility_id),
    payloadSha256: String(row.payload_sha256),
    payloadBytes: Number(row.payload_bytes),
  });

export const createOwnedReporterDatabase = (
  database: OwnedSqliteConnection,
): LocalSqliteReporterDatabase =>
  Object.freeze({
    beginImmediate: () => databaseCall(() => database.exec("BEGIN IMMEDIATE")),
    inTransaction: () => database.inTransaction,
    readLastTrustedTimeUnixNano: () =>
      databaseCall(() => {
        const row = database
          .prepare(
            "SELECT value FROM destination_metadata WHERE key = 'last_trusted_time_unix_nano'",
          )
          .get();
        return row === undefined ? undefined : String(rowRecord(row).value);
      }),
    readExisting: (deliveryIdentities) =>
      databaseCall(() => {
        if (deliveryIdentities.length === 0) return Object.freeze([]);
        return Object.freeze(
          database
            .prepare(
              `SELECT delivery_identity, trace_id, admission_time_unix_nano,
                      protocol_compatibility_id, payload_sha256, payload_bytes
                 FROM traces WHERE delivery_identity IN (${placeholders(deliveryIdentities.length)})`,
            )
            .all(...deliveryIdentities)
            .map(rowRecord)
            .map(storedTrace),
        );
      }),
    deleteExpiredBefore: (cutoffUnixNano, protectedDeliveryIdentities) => {
      databaseCall(() => {
        const excluded = protectedClause(protectedDeliveryIdentities);
        database
          .prepare(
            `DELETE FROM traces WHERE admission_time_sort_key < ?${excluded.sql}`,
          )
          .run(cutoffUnixNano.padStart(20, "0"), ...excluded.parameters);
      });
    },
    insertTrace: (trace: LocalSqlitePreparedTrace) =>
      databaseCall(() => {
        try {
          database
            .prepare(
              `INSERT INTO traces(
                 delivery_identity, trace_id, start_time_unix_nano,
                 start_time_sort_key, admission_time_unix_nano,
                 admission_time_sort_key, protocol_compatibility_id,
                 payload, payload_sha256, payload_bytes
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              trace.deliveryIdentity,
              trace.traceId,
              trace.startTimeUnixNano,
              trace.startTimeSortKey,
              trace.admissionTimeUnixNano,
              trace.admissionTimeSortKey,
              trace.protocolCompatibilityId,
              Buffer.from(trace.payloadUtf8, "utf8"),
              trace.payloadSha256,
              trace.payloadBytes,
            );
        } catch (error) {
          if (sqliteCode(error)?.startsWith("SQLITE_CONSTRAINT"))
            return "uniqueness-conflict" as const;
          throw error;
        }
        const insertDimension = database.prepare(
          "INSERT INTO trace_dimensions(delivery_identity, kind, value, ordinal) VALUES (?, ?, ?, ?)",
        );
        for (const dimension of trace.dimensions)
          insertDimension.run(
            trace.deliveryIdentity,
            dimension.kind,
            dimension.value,
            dimension.ordinal,
          );
        return "inserted" as const;
      }),
    readCapacity: () =>
      databaseCall(() => {
        const row = rowRecord(
          database
            .prepare(
              "SELECT COUNT(*) AS trace_count, COALESCE(SUM(payload_bytes), 0) AS payload_bytes FROM traces",
            )
            .get(),
        );
        return Object.freeze({
          traceCount: Number(row.trace_count),
          payloadBytes: Number(row.payload_bytes),
        });
      }),
    evictOldestUntilWithin: (
      maximumTraceCount,
      maximumBytes,
      protectedDeliveryIdentities,
    ) => {
      databaseCall(() => {
        const excluded = protectedClause(protectedDeliveryIdentities);
        database
          .prepare(
            `WITH capacity AS (
               SELECT COUNT(*) AS trace_count,
                      COALESCE(SUM(payload_bytes), 0) AS payload_bytes
                 FROM traces
             ), ordered AS (
               SELECT delivery_identity,
                      ROW_NUMBER() OVER (
                        ORDER BY admission_time_sort_key ASC, trace_id ASC,
                                 delivery_identity ASC
                      ) AS ordinal,
                      SUM(payload_bytes) OVER (
                        ORDER BY admission_time_sort_key ASC, trace_id ASC,
                                 delivery_identity ASC
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                      ) AS removed_bytes
                 FROM traces WHERE 1 = 1${excluded.sql}
             ), threshold AS (
               SELECT MIN(ordered.ordinal) AS cutoff
                 FROM ordered, capacity
                WHERE capacity.trace_count - ordered.ordinal <= ?
                  AND capacity.payload_bytes - ordered.removed_bytes <= ?
             )
             DELETE FROM traces WHERE delivery_identity IN (
               SELECT delivery_identity FROM ordered
                WHERE ordinal <= (SELECT cutoff FROM threshold)
             )`,
          )
          .run(...excluded.parameters, maximumTraceCount, maximumBytes);
      });
    },
    writeLastTrustedTimeUnixNano: (value) => {
      databaseCall(() => {
        const upsert = database.prepare(
          "INSERT INTO destination_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        );
        upsert.run("last_trusted_time_unix_nano", value);
        database
          .prepare(
            `INSERT INTO destination_metadata(key, value)
             VALUES ('content_revision', '1')
             ON CONFLICT(key) DO UPDATE
               SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
          )
          .run();
      });
    },
    commit: () => databaseCall(() => database.exec("COMMIT")),
    rollback: () => databaseCall(() => database.exec("ROLLBACK")),
  });

const trustedRetentionCutoff = (
  database: OwnedSqliteConnection,
  maximumAgeNanoseconds: string,
): string => {
  const row = database
    .prepare(
      "SELECT value FROM destination_metadata WHERE key = 'last_trusted_time_unix_nano'",
    )
    .get();
  const trusted = row === undefined ? 0n : BigInt(String(rowRecord(row).value));
  const maximumAge = BigInt(maximumAgeNanoseconds);
  return (trusted > maximumAge ? trusted - maximumAge : 0n)
    .toString()
    .padStart(20, "0");
};

const snapshotToken = (
  database: OwnedSqliteConnection,
  cutoff: string,
): string => {
  const revision = database
    .prepare(
      "SELECT value FROM destination_metadata WHERE key = 'content_revision'",
    )
    .get();
  const migration = database
    .prepare(
      "SELECT value FROM destination_metadata WHERE key = 'migration_manifest_id'",
    )
    .get();
  return sha256(
    JSON.stringify({
      cutoff,
      migration:
        migration === undefined ? "" : String(rowRecord(migration).value),
      revision:
        revision === undefined ? "0" : String(rowRecord(revision).value),
    }),
  );
};

const retrievalRow = (
  row: Record<string, unknown>,
): LocalSqliteRetrievalRow => {
  const payload = toBuffer(row.payload);
  return Object.freeze({
    deliveryIdentity: String(row.delivery_identity),
    traceId: String(row.trace_id),
    startTimeSortKey: String(row.start_time_sort_key),
    admissionTimeSortKey: String(row.admission_time_sort_key),
    protocolCompatibilityId: String(row.protocol_compatibility_id),
    payloadUtf8: payload.toString("utf8"),
    payloadSha256: String(row.payload_sha256),
    payloadBytes: Number(row.payload_bytes),
  });
};

const readBoundedPayload = (
  database: OwnedSqliteConnection,
  row: Record<string, unknown>,
  maximumBytes: number,
): Record<string, unknown> => {
  const payloadBytes = Number(row.payload_bytes);
  if (
    !Number.isSafeInteger(payloadBytes) ||
    payloadBytes < 1 ||
    payloadBytes > maximumPayloadBytes ||
    payloadBytes > maximumBytes
  )
    throw new Error("retrieval-response-too-large");
  const fetched = database
    .prepare(
      `SELECT substr(payload, 1, ?) AS payload
         FROM traces
        WHERE delivery_identity = ? AND payload_bytes = ?`,
    )
    .get(payloadBytes + 1, String(row.delivery_identity), payloadBytes);
  if (fetched === undefined)
    throw new Error("destination.local-sqlite.database.invalid");
  return Object.freeze({ ...row, payload: rowRecord(fetched).payload });
};

const rollbackRead = (database: OwnedSqliteConnection): void => {
  if (database.inTransaction) database.exec("ROLLBACK");
};

export const createOwnedRetrieverDatabase = (
  database: OwnedSqliteConnection,
  policy: LocalSqliteExecutionPolicy,
  remainingMilliseconds?: () => number,
): LocalSqliteRetrieverDatabase =>
  Object.freeze({
    search: async (plan: LocalSqliteSearchPlan, signal: AbortSignal) =>
      databaseCall((): LocalSqliteSearchEvidence => {
        database.exec("BEGIN");
        try {
          if (signal.aborted) throw new Error("retrieval-aborted");
          const budget = Math.min(
            plan.maximumWorkMilliseconds,
            remainingMilliseconds?.() ?? plan.maximumWorkMilliseconds,
          );
          if (budget < 1) throw new Error("retrieval-aborted");
          database.pragma(`busy_timeout = ${Math.floor(budget)}`);
          const cutoff = trustedRetentionCutoff(
            database,
            policy.maximumAgeNanoseconds,
          );
          const token = snapshotToken(database, cutoff);
          const rows = database
            .prepare(plan.sql)
            .all({
              ...plan.parameters,
              retentionCutoffSortKey: cutoff,
            })
            .map(rowRecord);
          if ((remainingMilliseconds?.() ?? 1) < 1)
            throw new Error("retrieval-aborted");
          const output: LocalSqliteRetrievalRow[] = [];
          let bytes = 0;
          let responseByteLimitReached = false;
          for (const row of rows) {
            if (signal.aborted) throw new Error("retrieval-aborted");
            const payloadBytes = Number(row.payload_bytes);
            if (
              !Number.isSafeInteger(payloadBytes) ||
              payloadBytes < 1 ||
              payloadBytes > maximumPayloadBytes
            )
              throw new Error("destination.local-sqlite.database.invalid");
            if (bytes + payloadBytes > plan.maximumResponseBytes) {
              responseByteLimitReached = true;
              break;
            }
            bytes += payloadBytes;
            output.push(
              retrievalRow(
                readBoundedPayload(
                  database,
                  row,
                  plan.maximumResponseBytes - (bytes - payloadBytes),
                ),
              ),
            );
          }
          database.exec("COMMIT");
          return Object.freeze({
            rows: Object.freeze(output),
            responseByteLimitReached,
            retentionCutoffSortKey: cutoff,
            snapshotToken: token,
          });
        } catch (error) {
          rollbackRead(database);
          throw error;
        }
      }),
    get: async (plan: LocalSqliteGetPlan, signal: AbortSignal) =>
      databaseCall((): LocalSqliteGetEvidence => {
        database.exec("BEGIN");
        try {
          if (signal.aborted) throw new Error("retrieval-aborted");
          const budget = Math.min(
            plan.maximumWorkMilliseconds,
            remainingMilliseconds?.() ?? plan.maximumWorkMilliseconds,
          );
          if (budget < 1) throw new Error("retrieval-aborted");
          database.pragma(`busy_timeout = ${Math.floor(budget)}`);
          const cutoff = trustedRetentionCutoff(
            database,
            policy.maximumAgeNanoseconds,
          );
          const value = database
            .prepare(plan.sql)
            .get({ ...plan.parameters, retentionCutoffSortKey: cutoff });
          if ((remainingMilliseconds?.() ?? 1) < 1)
            throw new Error("retrieval-aborted");
          const row =
            value === undefined
              ? undefined
              : retrievalRow(
                  readBoundedPayload(
                    database,
                    rowRecord(value),
                    plan.maximumResponseBytes,
                  ),
                );
          database.exec("COMMIT");
          return Object.freeze({ row, retentionCutoffSortKey: cutoff });
        } catch (error) {
          rollbackRead(database);
          throw error;
        }
      }),
  });

export const initializeOwnedSqliteConnection = (
  database: OwnedSqliteConnection,
  busyTimeoutMilliseconds: number,
): void => {
  databaseCall(() => {
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.pragma("auto_vacuum = FULL");
    database.pragma(`busy_timeout = ${busyTimeoutMilliseconds}`);
    database.pragma("trusted_schema = OFF");
  });
};
