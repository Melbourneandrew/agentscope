import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  createDestinationConnectionId,
  createReporterReceipt,
  createTraceLocator,
} from "@agentscope/destinations-core";
import {
  createReporterDeadline,
  createRetrievalContext,
  createTraceGetRequest,
  createTraceSearchRequest,
  invokeDestinationReporterForTesting,
  invokeRetrieverGet,
  invokeRetrieverSearch,
  normalizeTraceSearchQuery,
  prepareDestinationReporterForTesting,
  prepareDestinationRetriever,
  resolveDestinationConnection,
} from "@agentscope/destinations-core/testing";
import { createSanitizedRedactedCanonicalTraceFixture } from "@agentscope/protocol/testing";
import { describe, expect, it, vi } from "vitest";

import { runLocalSqliteMigrations } from "../migrations.js";
import { prepareLocalSqliteTrace } from "../reporter/transaction.js";
import { createLocalSqliteDestinationDescriptorForTesting } from "./descriptor.js";
import type { LocalSqliteProductionRuntime } from "./runtime.js";
import {
  createOwnedMigrationDatabase,
  createOwnedReporterDatabase,
  createOwnedRetrieverDatabase,
  type OwnedSqliteConnection,
} from "./sqlite-port.js";

const connectionId = createDestinationConnectionId(
  `destination-connection-v1-${"a".repeat(64)}`,
);

const owned = (database: DatabaseSync): OwnedSqliteConnection => ({
  close: () => undefined,
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

const runtimeFor = (
  database: OwnedSqliteConnection,
  reportPrepared: LocalSqliteProductionRuntime["reportPrepared"],
): LocalSqliteProductionRuntime =>
  ({
    filesystemProfile: "local-ext4",
    home: { platform: process.platform, root: "/unused" },
    lifecyclePort: {},
    maintenancePort: {},
    maximumSnapshotBytes: 16 * 1_024 * 1_024 * 1_024,
    nativeTupleId: "node127-linux-x64-glibc",
    opener: {},
    platformId: "linux-x64-node22-ci-ext4-proposed",
    reportPrepared,
    search: (request) =>
      createOwnedRetrieverDatabase(database, request.policy).search(
        request.plan,
        request.signal,
      ),
    get: (request) =>
      createOwnedRetrieverDatabase(database, request.policy).get(
        request.plan,
        request.signal,
      ),
    withSharedDatabase: async (request) =>
      request.operation(database, () => request.maximumWorkMilliseconds),
  }) as LocalSqliteProductionRuntime;

const settings = Object.freeze({
  maximumAgeNanoseconds: "1000000000",
  maximumPayloadBytes: 1_000_000,
  maximumTraceCount: 100,
});

/* eslint-disable max-lines-per-function -- each case keeps one complete Core-to-owned-database authority path visible. */
describe("Local SQLite production descriptor", () => {
  it("prepares through Core and delegates exact Reporter authority", async () => {
    const native = new DatabaseSync(":memory:");
    const database = owned(native);
    const remaining: number[] = [];
    const reportPrepared = vi.fn<
      LocalSqliteProductionRuntime["reportPrepared"]
    >((attempt) => {
      remaining.push(attempt.remainingMilliseconds());
      return Promise.resolve(createReporterReceipt("accepted"));
    });
    const descriptor = createLocalSqliteDestinationDescriptorForTesting(
      runtimeFor(database, reportPrepared),
    );
    const reporter = prepareDestinationReporterForTesting({
      descriptor,
      credentials: {},
      executor: () => {
        throw new Error("local destination must not use transport");
      },
      settings,
    });
    const trace = createSanitizedRedactedCanonicalTraceFixture();
    const signal = new AbortController().signal;
    const receipt = await invokeDestinationReporterForTesting(reporter, {
      admissionTimeUnixNano: "200",
      signal,
      traces: [trace],
    });

    expect(receipt).toEqual({ outcome: "accepted" });
    expect(reportPrepared).toHaveBeenCalledOnce();
    expect(reportPrepared.mock.calls[0]?.[0]).toMatchObject({
      admissionTimeUnixNano: "200",
      connectionId,
      lifecycleFingerprint: descriptor.localResourceLifecycle?.fingerprint,
      policy: settings,
      signal,
    });
    expect(reportPrepared.mock.calls[0]?.[0].prepared).toEqual([
      prepareLocalSqliteTrace(trace, "200"),
    ]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBeGreaterThan(0);

    reportPrepared.mockRejectedValueOnce(new Error("synthetic native error"));
    await expect(
      invokeDestinationReporterForTesting(reporter, {
        admissionTimeUnixNano: "201",
        traces: [trace],
      }),
    ).resolves.toEqual({ outcome: "unavailable" });
    native.close();
  });

  it("executes production search and get against the owned database port", async () => {
    const native = new DatabaseSync(":memory:");
    const database = owned(native);
    expect(
      runLocalSqliteMigrations(createOwnedMigrationDatabase(database)),
    ).toEqual({ ok: true, state: "migrated" });
    const trace = createSanitizedRedactedCanonicalTraceFixture();
    const row = prepareLocalSqliteTrace(trace, "200");
    const reporterDatabase = createOwnedReporterDatabase(database);
    reporterDatabase.beginImmediate();
    expect(reporterDatabase.insertTrace(row)).toBe("inserted");
    reporterDatabase.writeLastTrustedTimeUnixNano("200");
    reporterDatabase.commit();

    const runtime = runtimeFor(database, () =>
      Promise.resolve(createReporterReceipt("accepted")),
    );
    const descriptor =
      createLocalSqliteDestinationDescriptorForTesting(runtime);
    const prepared = resolveDestinationConnection(descriptor, {
      connectionId,
      settings,
    });
    const retriever = prepareDestinationRetriever(prepared, {
      credentials: {},
      transport: null,
    });
    const context = createRetrievalContext({
      deadline: createReporterDeadline(1_000),
      maximumProviderRequests: 1,
      maximumResponseBytes: 1_000_000,
      signal: new AbortController().signal,
    });
    const query = normalizeTraceSearchQuery(
      { limit: 10 },
      {
        commandStartedAt: "2099-01-01T00:00:00.000Z",
        knownHarnessIds: ["fixture-harness"],
        ordering: "start-time-desc-trace-id-asc",
      },
    );
    const search = await invokeRetrieverSearch(
      retriever,
      createTraceSearchRequest(query, {
        connectionId,
        destinationType: descriptor.destinationType,
      }),
      context,
    );
    expect(search).toMatchObject({
      ok: true,
      value: {
        state: "exhaustive",
        summaries: [{ locator: { traceId: row.traceId } }],
      },
    });

    const get = await invokeRetrieverGet(
      retriever,
      createTraceGetRequest(
        createTraceLocator({
          connectionId,
          destinationType: descriptor.destinationType,
          traceId: row.traceId,
        }),
        { connectionId, destinationType: descriptor.destinationType },
      ),
      createRetrievalContext({
        deadline: createReporterDeadline(1_000),
        maximumProviderRequests: 1,
        maximumResponseBytes: 1_000_000,
        signal: new AbortController().signal,
      }),
    );
    expect(get).toMatchObject({
      ok: true,
      value: {
        locator: { traceId: row.traceId },
        representation: { kind: "persisted-envelope" },
      },
    });
    expect(row.payloadSha256).toBe(
      createHash("sha256").update(row.payloadUtf8).digest("hex"),
    );
    native.close();
  });
});
/* eslint-enable max-lines-per-function */
