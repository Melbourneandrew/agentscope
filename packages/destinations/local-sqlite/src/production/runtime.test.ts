import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  bindLocalResourceHomeAuthorityForTesting,
  createReporterDeadline,
} from "@agentscope/destinations-core/testing";
import { describe, expect, it } from "vitest";

import { planLocalSqliteNamespace } from "../lifecycle/namespace.js";
import { releaseLocalSqliteSharedLease } from "../lifecycle/fence.js";
import type { LocalSqlitePreparedTrace } from "../reporter/transaction.js";
import type {
  LocalSqliteGetPlan,
  LocalSqliteSearchPlan,
} from "../retriever/index.js";
import {
  bindLocalSqliteProductionRuntimeForTesting,
  getLocalSqliteProductionRuntime,
} from "./runtime.js";
import type { OwnedSqliteConnection } from "./sqlite-port.js";

const connectionId = `destination-connection-v1-${"2".repeat(64)}`;
const fingerprint = `sha256-${"a".repeat(64)}`;
const childIdentity = "5".repeat(32);
const searchPlan: LocalSqliteSearchPlan = Object.freeze({
  planVersion: 1,
  sql: "SELECT 1",
  parameters: Object.freeze({}),
  maximumRows: 1,
  maximumResponseBytes: 1_000,
  maximumWorkMilliseconds: 1_000,
  retentionCutoffParameter: "retentionCutoffSortKey",
});
const getPlan: LocalSqliteGetPlan = Object.freeze({
  planVersion: 1,
  sql: "SELECT 1",
  parameters: Object.freeze({ traceId: "1".repeat(32) }),
  maximumResponseBytes: 1_000,
  maximumWorkMilliseconds: 1_000,
  retentionCutoffParameter: "retentionCutoffSortKey",
});

const retrieverWorkerProgram = `
let buffer = "";
let request;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) return;
    const value = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (value.type === "retrieve") {
      request = value;
      process.stdout.write(JSON.stringify({type:"ready",nonce:value.nonce,pid:process.pid,startIdentity:"${childIdentity}"})+"\\n");
    } else if (value.type === "permission") {
      const evidence = request.operation === "search"
        ? {rows:[],responseByteLimitReached:false,retentionCutoffSortKey:"00000000000000000000",snapshotToken:"3".repeat(64)}
        : {retentionCutoffSortKey:"00000000000000000000"};
      process.stdout.write(JSON.stringify({type:"retrieval-result",nonce:value.nonce,ok:true,evidence})+"\\n");
      process.exit(0);
    }
  }
});
`;

const reporterWorkerProgram = `
let buffer = "";
let header;
let traces = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) return;
    const value = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (value.type === "attempt-header") {
      header = value;
      if (value.preparedCount === 0)
        process.stdout.write(JSON.stringify({type:"ready",nonce:value.nonce,pid:process.pid,startIdentity:"${childIdentity}"})+"\\n");
    } else if (value.type === "trace") {
      traces += 1;
      if (traces === header.preparedCount)
        process.stdout.write(JSON.stringify({type:"ready",nonce:header.nonce,pid:process.pid,startIdentity:"${childIdentity}"})+"\\n");
    } else if (value.type === "permission") {
      process.stdout.write(JSON.stringify({type:"result",nonce:value.nonce,receipt:{outcome:"accepted"}})+"\\n");
      process.exit(0);
    }
  }
});
`;

const watchdogProgram = `
process.on("message", (value) => {
  if (value?.type === "watch") process.send({type:"watching"});
  else if (value?.type === "complete") process.disconnect();
});
process.on("disconnect", () => process.exit(0));
`;

const runtimeFixture = (
  root: string,
  testingHooks?: Parameters<
    typeof bindLocalSqliteProductionRuntimeForTesting
  >[2],
) => {
  let opens = 0;
  const runtime = bindLocalSqliteProductionRuntimeForTesting(
    bindLocalResourceHomeAuthorityForTesting(
      Object.freeze({ root, platform: process.platform }),
    ),
    Object.freeze({
      open: () => {
        opens += 1;
        throw new Error("native opener must not run");
      },
    }),
    testingHooks,
  );
  return Object.freeze({ runtime, opens: () => opens });
};

const report = (
  runtime: ReturnType<typeof runtimeFixture>["runtime"],
  remainingMilliseconds: () => number,
  signal = new AbortController().signal,
) =>
  runtime.reportPrepared({
    connectionId,
    lifecycleFingerprint: fingerprint,
    policy: {
      maximumAgeNanoseconds: "1",
      maximumPayloadBytes: 1,
      maximumTraceCount: 1,
    },
    prepared: [],
    admissionTimeUnixNano: "1",
    signal,
    deadline: createReporterDeadline(remainingMilliseconds()),
  });

const ownedDatabase = (
  database: DatabaseSync,
  close: () => void = () => {
    database.close();
  },
): OwnedSqliteConnection => ({
  close,
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

const createNamespace = (root: string) => {
  const namespace = planLocalSqliteNamespace({
    agentscopeHome: root,
    connectionId,
    platform: process.platform === "win32" ? "win32" : "posix",
  });
  mkdirSync(namespace.lifecycleDirectory, { recursive: true, mode: 0o700 });
  for (const directory of [
    dirname(dirname(namespace.connectionNamespace)),
    dirname(namespace.connectionNamespace),
    namespace.connectionNamespace,
    namespace.lifecycleDirectory,
  ])
    chmodSync(directory, 0o700);
  const database = new DatabaseSync(namespace.databasePath);
  database.exec("CREATE TABLE proof(value TEXT NOT NULL)");
  database.close();
  return namespace;
};

/* eslint-disable max-lines-per-function -- one real filesystem/runtime matrix
 * retains its exact lease, database, abort, and cleanup evidence together. */
describe("Local SQLite production runtime budgets", () => {
  it("rejects an aborted or insufficient attempt before namespace/native work", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-local-runtime-"));
    chmodSync(root, 0o700);
    try {
      const fixture = runtimeFixture(root);
      await expect(report(fixture.runtime, () => 299)).resolves.toEqual({
        outcome: "unavailable",
      });
      const controller = new AbortController();
      controller.abort();
      await expect(
        report(fixture.runtime, () => 1_000, controller.signal),
      ).resolves.toEqual({ outcome: "unavailable" });
      expect(fixture.opens()).toBe(0);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an aggregate Reporter payload beyond the child IPC ceiling before namespace work", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-local-runtime-"));
    chmodSync(root, 0o700);
    try {
      const fixture = runtimeFixture(root);
      const prepared = Object.freeze(
        Array.from({ length: 3 }, (_, index): LocalSqlitePreparedTrace =>
          Object.freeze({
            deliveryIdentity: String(index + 1).repeat(64),
            traceId: String(index + 1).repeat(32),
            startTimeUnixNano: "1",
            startTimeSortKey: "0".repeat(19) + "1",
            admissionTimeUnixNano: "1",
            admissionTimeSortKey: "0".repeat(19) + "1",
            protocolCompatibilityId: `sha256-${"a".repeat(64)}`,
            payloadUtf8: "{}",
            payloadSha256: "a".repeat(64),
            payloadBytes: 16 * 1024 * 1024,
            dimensions: Object.freeze([]),
          }),
        ),
      );
      await expect(
        fixture.runtime.reportPrepared({
          connectionId,
          lifecycleFingerprint: fingerprint,
          policy: {
            maximumAgeNanoseconds: "1",
            maximumPayloadBytes: 1,
            maximumTraceCount: 1,
          },
          prepared,
          admissionTimeUnixNano: "1",
          signal: new AbortController().signal,
          deadline: createReporterDeadline(1_000),
        }),
      ).resolves.toEqual({ outcome: "unavailable" });
      expect(fixture.opens()).toBe(0);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes search, get, and report through deterministic child seams and rejects pre-child authority failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-local-runtime-"));
    chmodSync(root, 0o700);
    try {
      const namespace = createNamespace(root);
      const workerPath = join(root, "retriever-worker.cjs");
      const reporterPath = join(root, "reporter-worker.cjs");
      const watchdogPath = join(root, "retriever-watchdog.cjs");
      writeFileSync(workerPath, retrieverWorkerProgram, { mode: 0o600 });
      writeFileSync(reporterPath, reporterWorkerProgram, { mode: 0o600 });
      writeFileSync(watchdogPath, watchdogProgram, { mode: 0o600 });
      const observedOperations: string[] = [];
      const runtime = bindLocalSqliteProductionRuntimeForTesting(
        bindLocalResourceHomeAuthorityForTesting({
          root,
          platform: process.platform,
        }),
        {
          open: () => {
            throw new Error("parent must not open SQLite");
          },
        },
        {
          childIdentity: () => childIdentity,
          reporterPrograms: { workerPath: reporterPath, watchdogPath },
          retrieverPrograms: { workerPath, watchdogPath },
          executeReporterChild: async (attempt) => {
            observedOperations.push("report");
            const released = await releaseLocalSqliteSharedLease(
              attempt.gate,
              attempt.lease,
            );
            if (!released.ok) throw new Error("fixture lease release");
            return Object.freeze({ outcome: "accepted" as const });
          },
          executeRetrieverChild: async (attempt) => {
            observedOperations.push(attempt.operation);
            const released = await releaseLocalSqliteSharedLease(
              attempt.gate,
              attempt.lease,
            );
            if (!released.ok) throw new Error("fixture lease release");
            return attempt.operation === "search"
              ? Object.freeze({
                  rows: Object.freeze([]),
                  responseByteLimitReached: false,
                  retentionCutoffSortKey: "0".repeat(20),
                  snapshotToken: "3".repeat(64),
                })
              : Object.freeze({
                  row: undefined,
                  retentionCutoffSortKey: "0".repeat(20),
                });
          },
        },
      );
      const base = () =>
        Object.freeze({
          connectionId,
          lifecycleFingerprint: fingerprint,
          policy: {
            maximumAgeNanoseconds: "1",
            maximumPayloadBytes: 1,
            maximumTraceCount: 1,
          },
          signal: new AbortController().signal,
          deadline: createReporterDeadline(1_000),
        });
      await expect(
        runtime.search({ ...base(), plan: searchPlan }),
      ).resolves.toEqual({
        rows: [],
        responseByteLimitReached: false,
        retentionCutoffSortKey: "0".repeat(20),
        snapshotToken: "3".repeat(64),
      });
      await expect(runtime.get({ ...base(), plan: getPlan })).resolves.toEqual({
        row: undefined,
        retentionCutoffSortKey: "0".repeat(20),
      });
      await expect(report(runtime, () => 1_000)).resolves.toEqual({
        outcome: "accepted",
      });
      expect(observedOperations).toEqual(["search", "get", "report"]);
      const noIdentityRuntime = bindLocalSqliteProductionRuntimeForTesting(
        bindLocalResourceHomeAuthorityForTesting({
          root,
          platform: process.platform,
        }),
        {
          open: () => {
            throw new Error("parent must not open SQLite");
          },
        },
        { retrieverPrograms: { workerPath, watchdogPath } },
      );
      await expect(
        noIdentityRuntime.search({ ...base(), plan: searchPlan }),
      ).rejects.toThrow("destination.local-sqlite.unavailable");
      await expect(
        runtime.search({
          ...base(),
          plan: { ...searchPlan, maximumWorkMilliseconds: 1 },
          deadline: createReporterDeadline(0),
        }),
      ).rejects.toThrow("destination.local-sqlite.unavailable");

      writeFileSync(
        join(namespace.lifecycleDirectory, "intent-v1.json"),
        "invalid",
        {
          mode: 0o600,
        },
      );
      await expect(
        runtime.search({ ...base(), plan: searchPlan }),
      ).rejects.toThrow("destination.local-sqlite.reconciliation-required");
      unlinkSync(join(namespace.lifecycleDirectory, "intent-v1.json"));
      unlinkSync(namespace.databasePath);
      await expect(runtime.get({ ...base(), plan: getPlan })).rejects.toThrow(
        "destination.local-sqlite.filesystem.invalid",
      );
      expect(readdirSync(namespace.lifecycleDirectory)).toEqual([]);

      createNamespace(root);
      const corruptingRuntime = bindLocalSqliteProductionRuntimeForTesting(
        bindLocalResourceHomeAuthorityForTesting({
          root,
          platform: process.platform,
        }),
        {
          open: () => {
            throw new Error("parent must not open SQLite");
          },
        },
        {
          childIdentity: () => childIdentity,
          retrieverPrograms: { workerPath, watchdogPath },
          afterSharedLeaseAcquired: (directory) => {
            const lease = readdirSync(directory).find((name) =>
              name.startsWith("lease-"),
            );
            if (lease === undefined) throw new Error("lease fixture missing");
            writeFileSync(join(directory, lease), "invalid", { mode: 0o600 });
          },
        },
      );
      await expect(
        corruptingRuntime.search({
          ...base(),
          plan: { ...searchPlan, maximumWorkMilliseconds: 1 },
        }),
      ).rejects.toThrow("destination.local-sqlite.outcome-unknown");
      for (const name of readdirSync(namespace.lifecycleDirectory))
        unlinkSync(join(namespace.lifecycleDirectory, name));
      unlinkSync(namespace.databasePath);
      await expect(
        corruptingRuntime.get({ ...base(), plan: getPlan }),
      ).rejects.toThrow("destination.local-sqlite.outcome-unknown");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases its lease when budget is consumed before child spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-local-runtime-"));
    chmodSync(root, 0o700);
    try {
      const namespace = createNamespace(root);
      const fixture = runtimeFixture(root, {
        afterSharedLeaseAcquired: () => {
          const until = performance.now() + 100;
          while (performance.now() < until) {
            // Deterministically consume the original deadline after admission.
          }
        },
      });
      await expect(report(fixture.runtime, () => 320)).resolves.toEqual({
        outcome: "unavailable",
      });
      expect(fixture.opens()).toBe(0);
      expect(readdirSync(namespace.lifecycleDirectory)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies post-acquire expiry, failed release, and abort before native open", async () => {
    for (const state of ["expired", "release-failed", "aborted"] as const) {
      const root = mkdtempSync(join(tmpdir(), "agentscope-local-runtime-"));
      chmodSync(root, 0o700);
      try {
        const namespace = createNamespace(root);
        const controller = new AbortController();
        let opens = 0;
        const runtime = bindLocalSqliteProductionRuntimeForTesting(
          bindLocalResourceHomeAuthorityForTesting({
            root,
            platform: process.platform,
          }),
          {
            open: () => {
              opens += 1;
              throw new Error("native opener must not run");
            },
          },
          {
            afterSharedLeaseAcquired:
              state === "aborted"
                ? undefined
                : (directory) => {
                    if (state === "release-failed") {
                      const lease = readdirSync(directory).find((name) =>
                        name.startsWith("lease-"),
                      );
                      if (lease === undefined)
                        throw new Error("lease fixture missing");
                      writeFileSync(join(directory, lease), "invalid", {
                        mode: 0o600,
                      });
                    }
                    Atomics.wait(
                      new Int32Array(new SharedArrayBuffer(4)),
                      0,
                      0,
                      10,
                    );
                  },
            beforeSharedDatabaseOpen:
              state === "aborted"
                ? () => {
                    controller.abort();
                  }
                : undefined,
          },
        );
        const operation = runtime.withSharedDatabase({
          connectionId,
          lifecycleFingerprint: fingerprint,
          policy: {
            maximumAgeNanoseconds: "1",
            maximumPayloadBytes: 1,
            maximumTraceCount: 1,
          },
          maximumWorkMilliseconds: state === "aborted" ? 1_000 : 1,
          signal: controller.signal,
          operation: () => "unreachable",
        });
        await expect(operation).rejects.toThrow(
          state === "release-failed"
            ? "destination.local-sqlite.outcome-unknown"
            : "destination.local-sqlite.unavailable",
        );
        expect(opens).toBe(0);
        if (state !== "release-failed")
          expect(readdirSync(namespace.lifecycleDirectory)).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("fails closed on a missing database or lifecycle blocker before native work", async () => {
    for (const state of ["missing-database", "blocked-lifecycle"] as const) {
      const root = mkdtempSync(join(tmpdir(), "agentscope-local-runtime-"));
      chmodSync(root, 0o700);
      try {
        const namespace = createNamespace(root);
        if (state === "missing-database") unlinkSync(namespace.databasePath);
        else
          writeFileSync(
            join(namespace.lifecycleDirectory, "intent-v1.json"),
            "invalid",
            { mode: 0o600 },
          );
        const fixture = runtimeFixture(root);
        await expect(report(fixture.runtime, () => 1_000)).resolves.toEqual({
          outcome: "unavailable",
        });
        const shared = fixture.runtime.withSharedDatabase({
          connectionId,
          lifecycleFingerprint: fingerprint,
          policy: {
            maximumAgeNanoseconds: "1",
            maximumPayloadBytes: 1,
            maximumTraceCount: 1,
          },
          maximumWorkMilliseconds: 1_000,
          signal: new AbortController().signal,
          operation: () => "unreachable",
        });
        await expect(shared).rejects.toThrow(
          state === "blocked-lifecycle"
            ? "destination.local-sqlite.reconciliation-required"
            : "destination.local-sqlite.filesystem.invalid",
        );
        expect(fixture.opens()).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("opens through owned directory authority with the exact remaining budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-local-runtime-"));
    chmodSync(root, 0o700);
    try {
      const namespace = createNamespace(root);
      let openedPath = "";
      let openedTarget = "";
      let timeout = 0;
      const runtime = bindLocalSqliteProductionRuntimeForTesting(
        bindLocalResourceHomeAuthorityForTesting({
          root,
          platform: process.platform,
        }),
        {
          open: (path, options) => {
            openedPath = path;
            openedTarget =
              process.platform === "linux" ? readlinkSync(path) : path;
            if (typeof options?.timeout !== "number")
              throw new Error("missing timeout authority");
            timeout = options.timeout;
            return ownedDatabase(new DatabaseSync(path));
          },
        },
      );
      await expect(
        runtime.withSharedDatabase({
          connectionId,
          lifecycleFingerprint: fingerprint,
          policy: {
            maximumAgeNanoseconds: "1",
            maximumPayloadBytes: 1,
            maximumTraceCount: 1,
          },
          maximumWorkMilliseconds: 1_000,
          signal: new AbortController().signal,
          operation: (database) => {
            database
              .prepare("INSERT INTO proof(value) VALUES (?)")
              .run("owned");
            return "completed";
          },
        }),
      ).resolves.toBe("completed");
      if (process.platform === "linux")
        expect(openedPath).toMatch(/^\/proc\/self\/fd\/\d+$/);
      expect(openedTarget).toBe(namespace.databasePath);
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(1_000);
      expect(readdirSync(namespace.lifecycleDirectory)).toEqual([]);
      const verified = new DatabaseSync(namespace.databasePath, {
        readOnly: true,
      });
      expect(verified.prepare("SELECT value FROM proof").get()).toEqual({
        value: "owned",
      });
      verified.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "throw",
    "hostile",
    "abort",
    "abort-open",
    "close",
    "family-replace",
    "open-replace",
    "replace",
    "lease",
  ] as const)("contains the %s failure", async (failure) => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-local-runtime-"));
    chmodSync(root, 0o700);
    try {
      const namespace = createNamespace(root);
      if (failure === "family-replace")
        writeFileSync(`${namespace.databasePath}-wal`, "prior", {
          mode: 0o600,
        });
      const controller = new AbortController();
      const replaceWithDistinctFile = (target: string): void => {
        const replacement = `${target}.replacement`;
        const before = statSync(target, { bigint: true });
        writeFileSync(replacement, "replacement", { mode: 0o600 });
        const after = statSync(replacement, { bigint: true });
        expect({ dev: after.dev, ino: after.ino }).not.toEqual({
          dev: before.dev,
          ino: before.ino,
        });
        renameSync(replacement, target);
      };
      const runtime = bindLocalSqliteProductionRuntimeForTesting(
        bindLocalResourceHomeAuthorityForTesting({
          root,
          platform: process.platform,
        }),
        {
          open: (path) => {
            const database = new DatabaseSync(
              failure === "open-replace" || failure === "family-replace"
                ? ":memory:"
                : path,
            );
            const openedTarget =
              process.platform === "linux" ? readlinkSync(path) : path;
            if (failure === "open-replace")
              replaceWithDistinctFile(openedTarget);
            if (failure === "family-replace") {
              const sidecar = `${openedTarget}-wal`;
              replaceWithDistinctFile(sidecar);
            }
            if (failure === "abort-open") controller.abort();
            return ownedDatabase(
              database,
              failure === "close"
                ? () => {
                    database.close();
                    throw new Error("synthetic close failure");
                  }
                : undefined,
            );
          },
        },
      );
      const operation = () => {
        if (failure === "throw") throw new Error("synthetic operation");
        if (failure === "hostile") {
          // Deliberately exercises normalization of a hostile non-Error rejection.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject("hostile non-error");
        }
        if (failure === "abort") controller.abort();
        if (failure === "replace") {
          renameSync(
            namespace.databasePath,
            `${namespace.databasePath}.replaced`,
          );
          writeFileSync(namespace.databasePath, "replacement", {
            mode: 0o600,
          });
        }
        if (failure === "lease") {
          const lease = readdirSync(namespace.lifecycleDirectory).find((name) =>
            name.startsWith("lease-"),
          );
          if (lease === undefined) throw new Error("lease fixture missing");
          writeFileSync(join(namespace.lifecycleDirectory, lease), "invalid", {
            mode: 0o600,
          });
        }
        return "value";
      };
      const result = runtime.withSharedDatabase({
        connectionId,
        lifecycleFingerprint: fingerprint,
        policy: {
          maximumAgeNanoseconds: "1",
          maximumPayloadBytes: 1,
          maximumTraceCount: 1,
        },
        maximumWorkMilliseconds: 1_000,
        signal: controller.signal,
        operation,
      });
      const expected =
        failure === "throw"
          ? "synthetic operation"
          : failure === "hostile" ||
              failure === "abort" ||
              failure === "abort-open"
            ? "destination.local-sqlite.unavailable"
            : failure === "family-replace"
              ? "destination.local-sqlite.reconciliation-required"
              : "destination.local-sqlite.outcome-unknown";
      await expect(result).rejects.toThrow(expected);
      if (failure !== "lease")
        expect(readdirSync(namespace.lifecycleDirectory)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid shared-database budgets without acquiring a lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-local-runtime-"));
    chmodSync(root, 0o700);
    try {
      const fixture = runtimeFixture(root);
      for (const maximumWorkMilliseconds of [0, 60_001, 1.5])
        await expect(
          fixture.runtime.withSharedDatabase({
            connectionId,
            lifecycleFingerprint: fingerprint,
            policy: {
              maximumAgeNanoseconds: "1",
              maximumPayloadBytes: 1,
              maximumTraceCount: 1,
            },
            maximumWorkMilliseconds,
            signal: new AbortController().signal,
            operation: () => "unreachable",
          }),
        ).rejects.toThrow("destination.local-sqlite.unavailable");
      const aborted = new AbortController();
      aborted.abort();
      await expect(
        fixture.runtime.withSharedDatabase({
          connectionId,
          lifecycleFingerprint: fingerprint,
          policy: {
            maximumAgeNanoseconds: "1",
            maximumPayloadBytes: 1,
            maximumTraceCount: 1,
          },
          maximumWorkMilliseconds: 1,
          signal: aborted.signal,
          operation: () => "unreachable",
        }),
      ).rejects.toThrow("destination.local-sqlite.unavailable");
      expect(() => getLocalSqliteProductionRuntime()).toThrow(
        "destination.local-sqlite.native-unavailable",
      );
      expect(fixture.opens()).toBe(0);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
/* eslint-enable max-lines-per-function */
