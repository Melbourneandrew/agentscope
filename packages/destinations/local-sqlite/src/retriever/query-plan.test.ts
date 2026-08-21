import { DatabaseSync } from "node:sqlite";

import {
  createDestinationConnectionId,
  createDestinationTypeId,
  createTraceLocator,
} from "@agentscope/destinations-core";
import {
  createTraceGetRequest,
  createTraceSearchRequest,
  normalizeTraceSearchQuery,
} from "@agentscope/destinations-core/testing";
import { describe, expect, it } from "vitest";

import { LOCAL_SQLITE_MIGRATIONS } from "../migrations.js";
import {
  compileLocalSqliteGetPlan,
  compileLocalSqliteSearchPlan,
} from "./index.js";

const connectionId = createDestinationConnectionId(
  `destination-connection-v1-${"9".repeat(64)}`,
);
const destinationType = createDestinationTypeId(
  "@agentscope/destination-local-sqlite",
);
const bounds = Object.freeze({
  maximumResponseBytes: 1_000_000,
  maximumWorkMilliseconds: 1_000,
});

const explain = (
  database: DatabaseSync,
  sql: string,
  parameters: Readonly<Record<string, string | number>>,
): readonly string[] =>
  database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(parameters)
    .map((row) => String(row.detail));

describe("Local SQLite executable query plans", () => {
  it("uses the intended indexes for filters, keyset traversal, get, and retention", () => {
    const database = new DatabaseSync(":memory:");
    try {
      for (const migration of LOCAL_SQLITE_MIGRATIONS)
        database.exec(migration.sql);
      const query = normalizeTraceSearchQuery(
        {
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-02T00:00:00.000Z",
          traceId: "a".repeat(32),
          harness: "codex",
          branch: "main",
          model: "gpt-5",
          sessionId: "session-a",
          tags: ["safe", "contract"],
          limit: 10,
        },
        {
          commandStartedAt: "2026-01-03T00:00:00.000Z",
          knownHarnessIds: ["codex"],
          ordering: "start-time-desc-trace-id-asc",
        },
      );
      const search = compileLocalSqliteSearchPlan(
        createTraceSearchRequest(query, { connectionId, destinationType }),
        bounds,
      )!;
      const searchDetails = explain(database, search.sql, {
        ...search.parameters,
        retentionCutoffSortKey: "0".repeat(20),
      });
      expect(searchDetails).toEqual(
        expect.arrayContaining([
          expect.stringContaining("USING INDEX traces_search_order"),
          expect.stringContaining("USING INDEX traces_trace_id_lookup"),
          expect.stringContaining(
            "USING COVERING INDEX sqlite_autoindex_trace_dimensions_1",
          ),
        ]),
      );

      const get = compileLocalSqliteGetPlan(
        createTraceGetRequest(
          createTraceLocator({
            connectionId,
            destinationType,
            traceId: "a".repeat(32),
          }),
          { connectionId, destinationType },
        ),
        bounds,
      )!;
      expect(
        explain(database, get.sql, {
          ...get.parameters,
          retentionCutoffSortKey: "0".repeat(20),
        }),
      ).toEqual([
        expect.stringContaining("USING INDEX traces_trace_id_lookup"),
      ]);

      expect(
        explain(
          database,
          `SELECT delivery_identity FROM traces
WHERE admission_time_sort_key < :retentionCutoffSortKey
ORDER BY admission_time_sort_key ASC, delivery_identity ASC
LIMIT :maximumRows`,
          { retentionCutoffSortKey: "0".repeat(20), maximumRows: 100 },
        ),
      ).toEqual([
        expect.stringContaining("USING COVERING INDEX traces_retention_order"),
      ]);
    } finally {
      database.close();
    }
  });
});

describe("Local SQLite executable retention selection", () => {
  it("selects the retained representation before collapsing a TraceId", () => {
    const database = new DatabaseSync(":memory:");
    try {
      for (const migration of LOCAL_SQLITE_MIGRATIONS)
        database.exec(migration.sql);
      const traceId = "b".repeat(32);
      const expiredDelivery = "1".repeat(64);
      const retainedDelivery = "2".repeat(64);
      const insert = database.prepare(`INSERT INTO traces (
  delivery_identity, trace_id, start_time_unix_nano, start_time_sort_key,
  admission_time_unix_nano, admission_time_sort_key,
  protocol_compatibility_id, payload, payload_sha256, payload_bytes
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const [deliveryIdentity, admissionTime] of [
        [expiredDelivery, "00000000000000000001"],
        [retainedDelivery, "00000000000000000003"],
      ] as const)
        insert.run(
          deliveryIdentity,
          traceId,
          "1767225600000000000",
          "01767225600000000000",
          admissionTime,
          admissionTime,
          "sha256:protocol",
          Buffer.from("{}"),
          "0".repeat(64),
          2,
        );

      const query = normalizeTraceSearchQuery(
        { to: "2026-01-02T00:00:00.000Z", traceId, tags: [], limit: 10 },
        {
          commandStartedAt: "2026-01-03T00:00:00.000Z",
          knownHarnessIds: ["codex"],
          ordering: "start-time-desc-trace-id-asc",
        },
      );
      const search = compileLocalSqliteSearchPlan(
        createTraceSearchRequest(query, { connectionId, destinationType }),
        bounds,
      )!;
      const get = compileLocalSqliteGetPlan(
        createTraceGetRequest(
          createTraceLocator({ connectionId, destinationType, traceId }),
          { connectionId, destinationType },
        ),
        bounds,
      )!;
      const cutoff = "00000000000000000002";
      const searchRows = database
        .prepare(search.sql)
        .all({ ...search.parameters, retentionCutoffSortKey: cutoff });
      const getRows = database
        .prepare(get.sql)
        .all({ ...get.parameters, retentionCutoffSortKey: cutoff });

      expect(searchRows).toHaveLength(1);
      expect(getRows).toHaveLength(1);
      expect(searchRows[0]?.delivery_identity).toBe(retainedDelivery);
      expect(getRows[0]?.delivery_identity).toBe(retainedDelivery);
    } finally {
      database.close();
    }
  });
});
