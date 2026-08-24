import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDestinationConnectionId,
  createDestinationTypeId,
} from "@agentscope/destinations-core";
import {
  createTraceSearchRequest,
  normalizeTraceSearchQuery,
} from "@agentscope/destinations-core/testing";
import { describe, expect, it } from "vitest";

import { acquireLocalSqliteSharedLease } from "../lifecycle/fence.js";
import { compileLocalSqliteSearchPlan } from "../retriever/index.js";
import { createLocalSqliteFilesystemGatePort } from "./filesystem-port.js";
import { executeLocalSqliteRetrieverChild } from "./retriever-child-parent.js";

const fingerprint = `sha256-${"a".repeat(64)}`;
const childIdentity = "5".repeat(32);
const connectionId = createDestinationConnectionId(
  `destination-connection-v1-${"a".repeat(64)}`,
);
const destinationType = createDestinationTypeId(
  "@agentscope/destination-local-sqlite",
);
const plan = compileLocalSqliteSearchPlan(
  createTraceSearchRequest(
    normalizeTraceSearchQuery(
      { limit: 1 },
      {
        commandStartedAt: "2099-01-01T00:00:00.000Z",
        knownHarnessIds: ["codex"],
        ordering: "start-time-desc-trace-id-asc",
      },
    ),
    { connectionId, destinationType },
  ),
  { maximumResponseBytes: 1_000, maximumWorkMilliseconds: 1_000 },
)!;

type WorkerState =
  | "accepted"
  | "before"
  | "malformed"
  | "oversized"
  | "split-ready"
  | "wrong-start"
  | "close-after-ready"
  | "false-result"
  | "missing-evidence"
  | "wrong-result"
  | "result-error"
  | "hang";

type WatchdogState = "accepted" | "wrong-message" | "exit-before-watch";

const watchdogProgram = (stubborn: boolean, state: WatchdogState): string => `
let worker;
process.on("message", (value) => {
  if (value?.type === "watch") {
    worker = value.workerPid;
    ${state === "exit-before-watch" ? "process.exit(0);" : state === "wrong-message" ? 'process.send({type:"wrong"});' : 'process.send({type:"watching"});'}
  } else if (value?.type === "complete") {
    ${stubborn ? "setInterval(()=>{},1000);" : "process.disconnect();"}
  }
});
process.on("disconnect", () => process.exit(0));
`;

const successResult = (nonce: string): string =>
  `JSON.stringify({type:"retrieval-result",nonce:${nonce},ok:true,evidence:{rows:[],responseByteLimitReached:false,retentionCutoffSortKey:"00000000000000000000",snapshotToken:"3".repeat(64)}})+"\\n"`;

const workerProgram = (state: WorkerState): string => `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) return;
    const value = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (value.type === "retrieve") {
      ${state === "before" ? "return;" : state === "malformed" ? 'process.stdout.write("{}\\n"); process.exit(0);' : state === "oversized" ? 'process.stdout.write("x".repeat(4097)); process.exit(0);' : state === "split-ready" ? `const ready=JSON.stringify({type:"ready",nonce:value.nonce,pid:process.pid,startIdentity:"${childIdentity}"}); process.stdout.write(ready.slice(0,5)); setTimeout(()=>process.stdout.write(ready.slice(5)+"\\n"),5);` : `process.stdout.write(JSON.stringify({type:"ready",nonce:value.nonce,pid:process.pid,startIdentity:"${state === "wrong-start" ? "6".repeat(32) : childIdentity}"})+"\\n");`}
      ${state === "close-after-ready" ? "process.stdin.destroy(); setInterval(()=>{},1000);" : ""}
    } else if (value.type === "permission") {
      ${state === "hang" ? "setInterval(()=>{},1000);" : state === "false-result" ? 'process.stdout.write(JSON.stringify({type:"retrieval-result",nonce:value.nonce,ok:false})+"\\n"); process.exit(0);' : state === "missing-evidence" ? 'process.stdout.write(JSON.stringify({type:"retrieval-result",nonce:value.nonce,ok:true})+"\\n"); process.exit(0);' : state === "wrong-result" ? `process.stdout.write(${successResult('"0".repeat(32)')}); process.exit(0);` : state === "result-error" ? `process.stdout.write(${successResult("value.nonce")}); process.exit(1);` : `process.stdout.write(${successResult("value.nonce")}); process.exit(0);`}
    }
  }
});
`;

type AttemptOptions = Readonly<{
  abortAfterMilliseconds?: number;
  failAmend?: boolean;
  failRelease?: boolean;
  throwAmend?: boolean;
  identityMissing?: boolean;
  missingWorker?: boolean;
  missingWatchdog?: boolean;
  omitChildIdentity?: boolean;
  stubbornWatchdog?: boolean;
  watchdogState?: WatchdogState;
  maximumWorkMilliseconds?: number;
}>;

const run = async (state: WorkerState, options: AttemptOptions = {}) => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-retriever-child-"));
  chmodSync(root, 0o700);
  try {
    const lifecycle = join(root, "lifecycle");
    const workerPath = join(root, "worker.cjs");
    const watchdogPath = join(root, "watchdog.cjs");
    mkdirSync(lifecycle, { mode: 0o700 });
    if (options.missingWorker !== true)
      writeFileSync(workerPath, workerProgram(state), { mode: 0o600 });
    if (options.missingWatchdog !== true)
      writeFileSync(
        watchdogPath,
        watchdogProgram(
          options.stubbornWatchdog === true,
          options.watchdogState ?? "accepted",
        ),
        { mode: 0o600 },
      );
    const filesystemGate = createLocalSqliteFilesystemGatePort(lifecycle, {
      allowPathFallbackForTesting: true,
    });
    const lease = await acquireLocalSqliteSharedLease(filesystemGate, {
      leaseId: "1".repeat(32),
      lifecycleFingerprint: fingerprint,
      lifecycleGeneration: 1,
      parent: { pid: process.pid, startIdentity: "4".repeat(32) },
    });
    if (!lease.ok) throw new Error("lease fixture");
    const gate = Object.freeze({
      ...filesystemGate,
      ...(options.failAmend === true
        ? {
            replaceLeaseDurably: () =>
              Object.freeze({ state: "mismatch" as const }),
          }
        : {}),
      ...(options.failRelease === true
        ? {
            removeArtifactIfIdentity: () =>
              Object.freeze({ state: "mismatch" as const }),
          }
        : {}),
      ...(options.throwAmend === true
        ? {
            replaceLeaseDurably: () => {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- hostile port boundary proves non-Error normalization.
              throw "synthetic hostile value";
            },
          }
        : {}),
    });
    const controller = new AbortController();
    const abortTimer =
      options.abortAfterMilliseconds === undefined
        ? undefined
        : setTimeout(() => {
            controller.abort();
          }, options.abortAfterMilliseconds);
    const startedAt = performance.now();
    try {
      const settled = await executeLocalSqliteRetrieverChild({
        programs: { workerPath, watchdogPath },
        gate,
        lease: lease.value,
        nonce: "2".repeat(32),
        databasePath: join(root, "traces.sqlite"),
        databaseFamily: Object.freeze([
          Object.freeze({
            name: "traces.sqlite",
            physicalIdentity: "dev:1:ino:2",
          }),
        ]),
        policy: {
          maximumAgeNanoseconds: "1",
          maximumPayloadBytes: 1,
          maximumTraceCount: 1,
        },
        operation: "search",
        plan,
        maximumWorkMilliseconds:
          options.maximumWorkMilliseconds ?? (state === "hang" ? 50 : 1_000),
        teardownReserveMilliseconds: 250,
        signal: controller.signal,
        ...(options.omitChildIdentity === true
          ? {}
          : {
              childIdentity: () =>
                options.identityMissing === true ? undefined : childIdentity,
            }),
      }).then(
        (value) => ({ state: "resolved" as const, value }),
        (error: unknown) => ({
          state: "rejected" as const,
          message: error instanceof Error ? error.message : "hostile",
        }),
      );
      return Object.freeze({
        settled,
        elapsed: performance.now() - startedAt,
        lifecycleEntries: readdirSync(lifecycle),
      });
    } finally {
      if (abortTimer !== undefined) clearTimeout(abortTimer);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe("Local SQLite Retriever child parent", () => {
  it("returns exact bounded evidence only after child exit and lease cleanup", async () => {
    for (const state of ["accepted", "split-ready"] as const) {
      const result = await run(state);
      expect(result.settled).toMatchObject({
        state: "resolved",
        value: { rows: [] },
      });
      expect(result.lifecycleEntries).toEqual([]);
    }
  });

  it("force-joins an uncooperative worker and watchdog within one reserve", async () => {
    const result = await run("hang", { stubbornWatchdog: true });
    expect(result.settled).toMatchObject({ state: "rejected" });
    expect(result.elapsed).toBeLessThan(450);
    expect(result.lifecycleEntries).toEqual([]);
  });

  it.each([
    "before",
    "malformed",
    "oversized",
    "wrong-start",
    "close-after-ready",
    "false-result",
    "missing-evidence",
    "wrong-result",
    "result-error",
  ] as const)(
    "rejects hostile %s settlement and cleans its lease",
    async (state) => {
      const result = await run(state, {
        maximumWorkMilliseconds: state === "before" ? 40 : 1_000,
      });
      expect(result.settled).toMatchObject({ state: "rejected" });
      expect(result.lifecycleEntries).toEqual([]);
    },
  );

  it("rejects missing child identity, failed amendment, abort, and missing worker", async () => {
    for (const options of [
      { identityMissing: true },
      { omitChildIdentity: true },
      { failAmend: true },
      { throwAmend: true },
      { abortAfterMilliseconds: 10, maximumWorkMilliseconds: 200 },
      { missingWorker: true },
      { missingWatchdog: true },
      { watchdogState: "wrong-message" as const },
      { watchdogState: "exit-before-watch" as const },
    ]) {
      const result = await run("accepted", options);
      expect(result.settled).toMatchObject({ state: "rejected" });
      expect(result.lifecycleEntries).toEqual([]);
    }
  });

  it("preserves outcome ambiguity when lease cleanup cannot be proven", async () => {
    const result = await run("accepted", { failRelease: true });
    expect(result.settled).toMatchObject({
      state: "rejected",
      message: "destination.local-sqlite.outcome-unknown",
    });
    expect(result.lifecycleEntries).toEqual([
      `lease-${"1".repeat(32)}.json`,
      `lease-cleanup-${"1".repeat(32)}.json`,
    ]);
  });
});
