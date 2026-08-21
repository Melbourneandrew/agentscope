import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  canonicalizeLocalSqliteEvidenceForTesting,
  compileLocalSqliteMigrationInventoryForTesting,
  compileLocalSqliteMigrationSqlForTesting,
  LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
  LOCAL_SQLITE_MIGRATIONS,
  LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
  runLocalSqliteMigrations as runProductionLocalSqliteMigrations,
  runLocalSqliteMigrationsWithInventoryForTesting,
  type LocalSqliteImmutableRowEvidence,
  type LocalSqliteMigrationDatabase,
  type LocalSqliteMigrationLedgerEntry,
  type LocalSqliteProjectionEvidence,
} from "./migrations.js";

type DatabaseState = {
  transaction: boolean;
  committed: boolean;
  rolledBack: boolean;
  statements: string[];
  ledger: LocalSqliteMigrationLedgerEntry[];
  metadata?: {
    destinationFormat: string;
    migrationManifestId: string;
    protocolCompatibilityId: string;
  };
  immutableReads: LocalSqliteImmutableRowEvidence[][];
  projections: LocalSqliteProjectionEvidence[];
  expectedProjections: LocalSqliteProjectionEvidence[];
  failAt?: "begin" | "execute" | "record" | "rebuild" | "commit" | "rollback";
  loseTransactionAfterExecute?: boolean;
};

const manifestIdFor = (
  resources: readonly (typeof LOCAL_SQLITE_MIGRATIONS)[number][],
) =>
  `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        format: "agentscope.local-sqlite.v1",
        migrations: resources.map(
          ({ version, ordinal, name, sha256, protocolCompatibilityId }) => ({
            version,
            ordinal,
            name,
            sha256,
            protocolCompatibilityId,
          }),
        ),
      }),
    )
    .digest("hex")}`;

const expectedMetadata = (ledgerLength = LOCAL_SQLITE_MIGRATIONS.length) => ({
  destinationFormat: "agentscope.local-sqlite.v1",
  migrationManifestId: manifestIdFor(
    LOCAL_SQLITE_MIGRATIONS.slice(0, ledgerLength),
  ),
  protocolCompatibilityId:
    LOCAL_SQLITE_MIGRATIONS[ledgerLength - 1]!.protocolCompatibilityId,
});

const runLocalSqliteMigrations = (database: LocalSqliteMigrationDatabase) =>
  runProductionLocalSqliteMigrations(database);

const database = (
  overrides: Partial<DatabaseState> = {},
): { adapter: LocalSqliteMigrationDatabase; state: DatabaseState } => {
  const state: DatabaseState = {
    transaction: false,
    committed: false,
    rolledBack: false,
    statements: [],
    ledger: [],
    immutableReads: [[], []],
    projections: [],
    expectedProjections: [],
    ...overrides,
  };
  if (state.ledger.length > 0 && state.metadata === undefined)
    state.metadata = expectedMetadata(state.ledger.length);
  const adapter: LocalSqliteMigrationDatabase = Object.freeze({
    beginExclusive: () => {
      if (state.failAt === "begin") throw new Error("begin");
      state.transaction = true;
    },
    execute: (statement: string) => {
      if (state.failAt === "execute") throw new Error("execute");
      state.statements.push(statement);
      if (state.loseTransactionAfterExecute) state.transaction = false;
    },
    inTransaction: () => state.transaction,
    readMigrationLedger: () => state.ledger,
    recordMigration: (entry: LocalSqliteMigrationLedgerEntry) => {
      if (state.failAt === "record") throw new Error("record");
      state.ledger.push(entry);
    },
    readDestinationMetadata: () => state.metadata,
    writeDestinationMetadata: (metadata) => {
      state.metadata = { ...metadata };
    },
    readImmutableRows: () => state.immutableReads.shift() ?? [],
    rebuildPortableProjections: () => {
      if (state.failAt === "rebuild") throw new Error("rebuild");
    },
    readPortableProjections: () => state.projections,
    readExpectedPortableProjections: () => state.expectedProjections,
    commit: () => {
      if (state.failAt === "commit") throw new Error("commit");
      state.transaction = false;
      state.committed = true;
    },
    rollback: () => {
      state.transaction = false;
      state.rolledBack = true;
      if (state.failAt === "rollback") throw new Error("rollback");
    },
  });
  return { adapter, state };
};

const overrideDatabase = (
  adapter: LocalSqliteMigrationDatabase,
  overrides: Partial<LocalSqliteMigrationDatabase>,
): LocalSqliteMigrationDatabase => Object.freeze({ ...adapter, ...overrides });

const cloneMigration = (
  overrides: Partial<(typeof LOCAL_SQLITE_MIGRATIONS)[number]> = {},
) => ({ ...LOCAL_SQLITE_MIGRATIONS[0]!, ...overrides });

const migrationWithSql = (sql: string) =>
  cloneMigration({
    sql,
    sha256: createHash("sha256").update(sql, "utf8").digest("hex"),
  });

const immutableRow = (
  overrides: Partial<LocalSqliteImmutableRowEvidence> = {},
): LocalSqliteImmutableRowEvidence => ({
  deliveryIdentity: "asid:delivery",
  traceId: "0123456789abcdef0123456789abcdef",
  startTimeUnixNano: "1",
  startTimeSortKey: "00000000000000000001",
  admissionTimeUnixNano: "2",
  admissionTimeSortKey: "00000000000000000002",
  protocolCompatibilityId: "sha256:protocol",
  payloadSha256: "a".repeat(64),
  payloadBytes: 10,
  ...overrides,
});

const projection = (
  overrides: Partial<LocalSqliteProjectionEvidence> = {},
): LocalSqliteProjectionEvidence => ({
  deliveryIdentity: "asid:delivery",
  kind: "model",
  value: "gpt-test",
  ordinal: 0,
  ...overrides,
});

const malformedInventories = (): readonly unknown[] => {
  const valid = LOCAL_SQLITE_MIGRATIONS[0]!;
  return [
    null,
    {},
    [],
    new Array(65),
    new Array(1),
    [cloneMigration({ version: 2 })],
    [cloneMigration({ version: Number.NaN })],
    [cloneMigration({ ordinal: 2 })],
    [cloneMigration({ ordinal: "1" as never })],
    [cloneMigration({ name: "0002-initialize.sql" })],
    [cloneMigration({ name: 1 as never })],
    [cloneMigration({ sha256: "0".repeat(64) })],
    [cloneMigration({ sha256: 1 as never })],
    [cloneMigration({ protocolCompatibilityId: "" })],
    [cloneMigration({ protocolCompatibilityId: 1 as never })],
    [cloneMigration({ sql: 1 as never })],
    [migrationWithSql(`${valid.sql}\nVACUUM;`)],
    [migrationWithSql("CREATE VIRTUAL TABLE traces USING canary;")],
    [migrationWithSql("BEGIN;")],
    [migrationWithSql("CREATE TABLE traces (value TEXT)")],
    [migrationWithSql("CREATE TABLE traces (value TEXT); trailing")],
    [migrationWithSql("CREATE TABLE traces (value TEXT /* canary */);")],
    [migrationWithSql("CREATE TABLE traces (value TEXT -- canary\n);")],
    [migrationWithSql("CREATE TABLE traces (value TEXT DEFAULT 'x);")],
    [{ ...valid, extra: true }],
    [Object.create(valid)],
    [Object.defineProperty({ ...valid }, "sql", { get: () => valid.sql })],
    [
      new Proxy(
        { ...valid },
        {
          ownKeys: () => {
            throw new Error("CANARY_RECORD");
          },
        },
      ),
    ],
    Object.defineProperty([], "0", {
      enumerable: true,
      get: () => valid,
    }),
    Object.assign([valid], { canary: true }),
    Object.assign([valid], { 4294967295: valid }),
    Object.assign(new Array(1), { canary: valid }),
    Object.assign([valid], { [Symbol("canary")]: true }),
    new Proxy([], {
      ownKeys: () => {
        throw new Error("CANARY");
      },
    }),
  ];
};

describe("Local SQLite migration compiler", () => {
  it("rejects an edited built migration resource before compilation", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({ readFileSync: () => "edited" }));
    try {
      await expect(import("./migrations.js")).rejects.toThrow(
        "destination.local-sqlite.migration.invalid",
      );
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("compiles the exact contiguous built inventory", () => {
    const compiled = compileLocalSqliteMigrationInventoryForTesting(
      LOCAL_SQLITE_MIGRATIONS,
    );
    expect(compiled).toHaveLength(2);
    expect(compiled?.[0]?.resource).toEqual(LOCAL_SQLITE_MIGRATIONS[0]);
    expect(compiled?.[0]?.statements).toHaveLength(6);
    expect(compiled?.[1]?.statements).toHaveLength(2);
    expect(LOCAL_SQLITE_MIGRATION_MANIFEST_ID).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
    expect(
      compiled?.[0]?.statements.every((statement) => statement.endsWith(";")),
    ).toBe(true);
  });

  it("rejects malformed, accessor-backed, and noncontiguous inventories", () => {
    for (const candidate of malformedInventories())
      expect(
        compileLocalSqliteMigrationInventoryForTesting(candidate),
      ).toBeUndefined();
  });

  it("parses only complete bounded admitted SQL statements", () => {
    expect(
      compileLocalSqliteMigrationSqlForTesting(
        "CREATE TABLE canary (value TEXT DEFAULT 'it''s; safe', number INTEGER DEFAULT 123) STRICT;",
      ),
    ).toHaveLength(1);
    expect(
      compileLocalSqliteMigrationSqlForTesting(
        "CREATE INDEX canary_index ON canary(value);",
      ),
    ).toHaveLength(1);
    expect(
      compileLocalSqliteMigrationSqlForTesting(
        "CREATE TABLE child (value TEXT REFERENCES parent(value)) STRICT;",
      ),
    ).toHaveLength(1);
    const invalid = [
      "",
      " ",
      "\0",
      "CREATE TABLE x (v TEXT);;",
      "CREATE TABLE payload_copy AS SELECT payload FROM traces;",
      "CREATE TABLE TABLE (v TEXT) STRICT;",
      "CREATE TABLE 1 (v TEXT) STRICT;",
      "CREATE TABLE x (TABLE TEXT) STRICT;",
      "CREATE TABLE x (1 TEXT) STRICT;",
      "CREATE TABLE x (v CANARY) STRICT;",
      "CREATE TABLE x (v TEXT CANARY) STRICT;",
      "CREATE TABLE x (v TEXT, TABLE TEXT) STRICT;",
      "CREATE TABLE x (v TEXT NOT CANARY) STRICT;",
      "CREATE TABLE x (v TEXT DEFAULT NULL) STRICT;",
      "CREATE TABLE x (v TEXT REFERENCES TABLE(v)) STRICT;",
      "CREATE TABLE x (v TEXT REFERENCES y(TABLE)) STRICT;",
      "CREATE TABLE x (v TEXT REFERENCES y(v) ON UPDATE CASCADE) STRICT;",
      "CREATE TABLE x (PRIMARY CANARY (v)) STRICT;",
      "CREATE TABLE x (PRIMARY KEY (TABLE)) STRICT;",
      "CREATE TABLE x (v TEXT, PRIMARY KEY (v, TABLE)) STRICT;",
      "CREATE INDEX INDEX ON x(v);",
      "CREATE INDEX x ON TABLE(v);",
      "CREATE INDEX x ON y(TABLE);",
      "CREATE INDEX x ON y(1);",
      "CREATE TABLE x (v TEXT); trailing",
      "CREATE THING x (v TEXT);",
      "SELECT value FROM x;",
      "CREATE TABLE x (v TEXT DEFAULT 'unterminated);",
      `CREATE TABLE x (v TEXT DEFAULT '${"x".repeat(4_097)}');`,
      "CREATE TABLE x.y (v TEXT);",
      "CREATE TABLE x (v TEXT -- comment\n);",
      "CREATE TABLE x (v TEXT /* comment */);",
      "CREATE TABLE x (v TEXT);\0",
      "x".repeat(65_537),
      Array.from(
        { length: 65 },
        (_, index) => `CREATE TABLE x${index} (v TEXT) STRICT;`,
      ).join("\n"),
    ];
    for (const sql of invalid)
      expect(compileLocalSqliteMigrationSqlForTesting(sql)).toBeUndefined();
    for (const keyword of [
      "ATTACH",
      "BEGIN",
      "COMMIT",
      "DETACH",
      "EXTENSION",
      "PRAGMA",
      "ROLLBACK",
      "TRIGGER",
      "VACUUM",
      "VIRTUAL",
    ])
      expect(
        compileLocalSqliteMigrationSqlForTesting(
          `CREATE TABLE x (value ${keyword});`,
        ),
      ).toBeUndefined();
  });

  it("bounds canonical migration evidence before aggregate allocation", () => {
    expect(
      canonicalizeLocalSqliteEvidenceForTesting(
        [projection()],
        "projection",
        1,
      ),
    ).toBeUndefined();
  });
});

describe("Local SQLite migration runner", () => {
  it("migrates once, records the exact ledger, and recognizes current state", () => {
    const first = database();
    expect(runLocalSqliteMigrations(first.adapter)).toEqual({
      ok: true,
      state: "migrated",
    });
    expect(first.state.statements).toHaveLength(8);
    expect(first.state.ledger).toEqual([
      {
        version: 1,
        ordinal: 1,
        name: "0001-initialize.sql",
        sha256: LOCAL_SQLITE_MIGRATIONS[0]!.sha256,
      },
      {
        version: 2,
        ordinal: 2,
        name: "0002-retrieval-indexes.sql",
        sha256: LOCAL_SQLITE_MIGRATIONS[1]!.sha256,
      },
    ]);
    expect(first.state.committed).toBe(true);
    expect(first.state.rolledBack).toBe(false);

    const second = database({ ledger: [...first.state.ledger] });
    expect(runLocalSqliteMigrations(second.adapter)).toEqual({
      ok: true,
      state: "current",
    });
    expect(second.state.statements).toEqual([]);
  });

  it("preserves immutable rows and requires exact rebuilt projections", () => {
    const row = immutableRow();
    const dimension = projection();
    const valid = database({
      ledger: [
        {
          version: 1,
          ordinal: 1,
          name: "0001-initialize.sql",
          sha256: LOCAL_SQLITE_MIGRATIONS[0]!.sha256,
        },
      ],
      immutableReads: [[row], [{ ...row }]],
      projections: [dimension],
      expectedProjections: [{ ...dimension }],
    });
    expect(runLocalSqliteMigrations(valid.adapter).ok).toBe(true);

    for (const invalid of [
      database({
        ledger: valid.state.ledger,
        immutableReads: [
          [row],
          [immutableRow({ payloadSha256: "b".repeat(64) })],
        ],
      }),
      database({
        ledger: valid.state.ledger,
        immutableReads: [[row], [{ ...row }]],
        projections: [dimension],
        expectedProjections: [projection({ value: "different" })],
      }),
      database({
        ledger: valid.state.ledger,
        immutableReads: [[immutableRow({ startTimeUnixNano: "01" })], []],
      }),
      database({
        ledger: valid.state.ledger,
        immutableReads: [[row], [{ ...row }]],
        projections: [projection({ ordinal: -1 })],
      }),
      database({
        ledger: valid.state.ledger,
        immutableReads: [
          [immutableRow({ deliveryIdentity: "x".repeat(1_025) })],
          [],
        ],
      }),
    ]) {
      expect(runLocalSqliteMigrations(invalid.adapter).ok).toBe(false);
      expect(invalid.state.rolledBack).toBe(true);
      expect(invalid.state.committed).toBe(false);
    }
  });

  it("authenticates an exact prior metadata state before an append", () => {
    const second = migrationWithSql(
      "CREATE TABLE derived_v2 (value TEXT) STRICT;",
    );
    const inventory = [
      LOCAL_SQLITE_MIGRATIONS[0]!,
      { ...second, version: 2, ordinal: 2, name: "0002-derived.sql" },
    ];
    const ledger = [
      {
        version: 1,
        ordinal: 1,
        name: "0001-initialize.sql",
        sha256: LOCAL_SQLITE_MIGRATIONS[0]!.sha256,
      },
    ];
    const missing = database({ ledger });
    expect(
      runLocalSqliteMigrationsWithInventoryForTesting(
        overrideDatabase(missing.adapter, {
          readDestinationMetadata: () => undefined,
        }),
        inventory,
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });
    expect(missing.state.statements).toEqual([]);

    const valid = database({ ledger });
    expect(
      runLocalSqliteMigrationsWithInventoryForTesting(valid.adapter, inventory),
    ).toEqual({ ok: true, state: "migrated" });
    expect(valid.state.statements).toHaveLength(1);
    expect(valid.state.metadata?.protocolCompatibilityId).toBe(
      LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
    );
  });
});

describe("Local SQLite historical migration authority", () => {
  it("authenticates historical Protocol metadata before transitioning", () => {
    const second = migrationWithSql(
      "CREATE TABLE derived_v2 (value TEXT) STRICT;",
    );
    const priorProtocolCompatibilityId = "agentscope-protocol-historical";
    const historicalFirst = cloneMigration({
      protocolCompatibilityId: priorProtocolCompatibilityId,
    });
    const historical = database();
    expect(
      runLocalSqliteMigrationsWithInventoryForTesting(historical.adapter, [
        historicalFirst,
      ]),
    ).toEqual({ ok: true, state: "migrated" });
    expect(historical.state.metadata?.protocolCompatibilityId).toBe(
      priorProtocolCompatibilityId,
    );

    historical.state.committed = false;
    historical.state.rolledBack = false;
    historical.state.immutableReads = [[], []];
    expect(
      runLocalSqliteMigrationsWithInventoryForTesting(historical.adapter, [
        historicalFirst,
        { ...second, version: 2, ordinal: 2, name: "0002-derived.sql" },
      ]),
    ).toEqual({ ok: true, state: "migrated" });
    expect(historical.state.statements).toHaveLength(7);
    expect(historical.state.metadata?.protocolCompatibilityId).toBe(
      LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
    );
  });
});

describe("Local SQLite migration failure lifecycle", () => {
  it("fails closed for ledger drift, lost transactions, and native failures", () => {
    const mismatched = database({
      ledger: [
        {
          version: 1,
          ordinal: 1,
          name: "0001-initialize.sql",
          sha256: "f".repeat(64),
        },
      ],
    });
    expect(runLocalSqliteMigrations(mismatched.adapter)).toEqual({
      ok: false,
      state: "reconciliation-required",
    });
    expect(mismatched.state.rolledBack).toBe(true);

    const invalidLedger = database({
      ledger: [
        {
          version: 2,
          ordinal: 1,
          name: "0002-canary.sql",
          sha256: "f".repeat(64),
        },
      ],
    });
    expect(runLocalSqliteMigrations(invalidLedger.adapter).state).toBe(
      "reconciliation-required",
    );
  });
});

describe("Local SQLite migration runtime failures", () => {
  it("fails closed for malformed evidence and native operation failures", () => {
    for (const adapter of [
      overrideDatabase(database().adapter, {
        readMigrationLedger: () => null as never,
      }),
      overrideDatabase(database().adapter, {
        readMigrationLedger: () => [null] as never,
      }),
      overrideDatabase(database().adapter, {
        readImmutableRows: () => null as never,
      }),
      overrideDatabase(database().adapter, {
        readImmutableRows: () => [null] as never,
      }),
      overrideDatabase(database().adapter, {
        inTransaction: () => false,
      }),
      overrideDatabase(database().adapter, {
        recordMigration: () => undefined,
        inTransaction: (() => {
          let reads = 0;
          return () => {
            reads += 1;
            return reads < 8;
          };
        })(),
      }),
      overrideDatabase(database().adapter, {
        rebuildPortableProjections: () => undefined,
        inTransaction: (() => {
          let reads = 0;
          return () => {
            reads += 1;
            return reads < 9;
          };
        })(),
      }),
      (() => {
        const target = database();
        let rebuilt = false;
        return overrideDatabase(target.adapter, {
          rebuildPortableProjections: () => {
            rebuilt = true;
          },
          inTransaction: () => !rebuilt,
        });
      })(),
      overrideDatabase(database().adapter, {
        readPortableProjections: () => [null] as never,
      }),
      overrideDatabase(database().adapter, {
        recordMigration: () => undefined,
      }),
      overrideDatabase(database().adapter, {
        writeDestinationMetadata: () => undefined,
      }),
      (() => {
        const target = database();
        return overrideDatabase(target.adapter, {
          writeDestinationMetadata: () => {
            target.state.transaction = false;
          },
        });
      })(),
      overrideDatabase(
        database({
          ledger: [
            {
              version: 1,
              ordinal: 1,
              name: "0001-initialize.sql",
              sha256: LOCAL_SQLITE_MIGRATIONS[0]!.sha256,
            },
          ],
        }).adapter,
        { readDestinationMetadata: () => undefined },
      ),
    ])
      expect(runLocalSqliteMigrations(adapter).ok).toBe(false);

    for (const failing of [
      database({ failAt: "begin" }),
      database({ failAt: "execute" }),
      database({ failAt: "record" }),
      database({ failAt: "rebuild" }),
      database({ failAt: "commit" }),
      database({ failAt: "rollback", loseTransactionAfterExecute: true }),
      database({ loseTransactionAfterExecute: true }),
    ]) {
      expect(runLocalSqliteMigrations(failing.adapter).ok).toBe(false);
      expect(failing.state.committed).toBe(false);
    }
  });
});

describe("Local SQLite migration recovery outcomes", () => {
  it("rejects an invalid inventory before native work", () => {
    const target = database();
    expect(
      runLocalSqliteMigrationsWithInventoryForTesting(target.adapter, []),
    ).toEqual({
      ok: false,
      state: "invalid-inventory",
    });
    expect(target.state.transaction).toBe(false);
    expect(target.state.statements).toEqual([]);
  });

  it("requires reconciliation after ambiguous commit or rollback failure", () => {
    const committedThenThrew = database();
    const commitAdapter = overrideDatabase(committedThenThrew.adapter, {
      commit: () => {
        committedThenThrew.state.committed = true;
        throw new Error("commit-ack-lost");
      },
      rollback: () => {
        throw new Error("rollback-after-commit");
      },
    });
    expect(runLocalSqliteMigrations(commitAdapter)).toEqual({
      ok: false,
      state: "reconciliation-required",
    });

    const rollbackFailed = database({ failAt: "execute" });
    const rollbackAdapter = overrideDatabase(rollbackFailed.adapter, {
      rollback: () => {
        throw new Error("rollback-failed");
      },
    });
    expect(runLocalSqliteMigrations(rollbackAdapter)).toEqual({
      ok: false,
      state: "reconciliation-required",
    });
  });
});
