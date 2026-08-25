/* eslint-disable max-lines-per-function -- process-boundary fixtures intentionally keep each complete adversarial orchestration in one test helper. */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { acquireLocalSqliteSharedLease } from "../lifecycle/fence.js";
import { createLocalSqliteFilesystemGatePort } from "./filesystem-port.js";
import { readLocalSqliteReporterChildMessages } from "./reporter-child-output.js";
import { executeLocalSqliteReporterChild } from "./reporter-child-parent.js";

const fingerprint = `sha256-${"a".repeat(64)}`;
const childIdentity = "5".repeat(32);
type WorkerState =
  | "accepted"
  | "accepted-descendant"
  | "before"
  | "after"
  | "malformed"
  | "oversized"
  | "wrong-start"
  | "close-before-header"
  | "close-after-permission"
  | "exit-after-permission"
  | "descendant"
  | "result-error"
  | "wrong-result";

const permissionObservedStates: ReadonlySet<WorkerState> = new Set([
  "after",
  "close-after-permission",
  "exit-after-permission",
  "result-error",
  "wrong-result",
]);

const extendedWorkStates: ReadonlySet<WorkerState> = new Set([
  "accepted",
  "accepted-descendant",
  ...permissionObservedStates,
  "oversized",
]);

const watchdogProgram = (
  stubborn = false,
  watchAcknowledgementDelayMilliseconds = 0,
  closedInputMarkerPath?: string,
) => `
const {existsSync}=require("node:fs");
let worker;
let complete = false;
process.on("message", (value) => {
  if (value?.type === "watch") {
    worker = value.workerPid;
    const acknowledge = () => {
      ${closedInputMarkerPath === undefined ? "" : `if (!existsSync(${JSON.stringify(closedInputMarkerPath)})) { setTimeout(acknowledge, 1); return; }`}
      process.send({type:"watching"});
    };
    setTimeout(acknowledge, ${watchAcknowledgementDelayMilliseconds});
  } else if (value?.type === "complete") {
    ${stubborn ? "setInterval(()=>{},1000); return;" : ""}
    complete = true;
    process.disconnect();
  } else process.exit(70);
});
process.on("disconnect", () => {
  if (!complete && worker) { try { process.kill(-worker, "SIGKILL"); } catch {} }
  process.exit(complete ? 0 : 70);
});
`;

const workerProgram = (
  state: WorkerState,
  descendantPath: string,
  heartbeatPath: string,
  stateObservedPath: string,
) => {
  const heartbeatProgram = `const {appendFileSync}=require("node:fs");setInterval(()=>appendFileSync(${JSON.stringify(heartbeatPath)},"x"),5);`;
  return `
const {spawn} = require("node:child_process");
const {closeSync,renameSync,writeFileSync} = require("node:fs");
${state === "close-before-header" ? `closeSync(0); writeFileSync(${JSON.stringify(descendantPath)},"closed"); setInterval(()=>{},1000);` : ""}
const publishDescendantPid = (pid) => {
  const stage = ${JSON.stringify(`${descendantPath}.stage`)};
  writeFileSync(stage, String(pid));
  renameSync(stage, ${JSON.stringify(descendantPath)});
};
const publishObservedState = (value) => {
  const stage = ${JSON.stringify(`${stateObservedPath}.stage`)};
  writeFileSync(stage, value);
  renameSync(stage, ${JSON.stringify(stateObservedPath)});
};
let buffer = "";
let request;
let traces = 0;
const ready = () => {
  ${state === "before" ? "return;" : state === "malformed" ? 'process.stdout.write("{}\\n"); process.exit(0);' : state === "oversized" ? 'process.stdout.write("x".repeat(4097)); setInterval(()=>{},1000);' : `process.stdout.write(JSON.stringify({type:"ready",nonce:request.nonce,pid:process.pid,startIdentity:"${state === "wrong-start" ? "6".repeat(32) : childIdentity}"})+"\\n");`}
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const value = JSON.parse(line);
    if (value.type === "attempt-header") {
      request = value;
      if (value.preparedCount === 0) ready();
    } else if (value.type === "trace") {
      traces += 1;
      if (traces === request.preparedCount) ready();
    } else if (value.type === "permission") {
      ${state === "accepted" ? 'process.stdout.write(JSON.stringify({type:"result",nonce:value.nonce,receipt:{outcome:"accepted"}})+"\\n"); process.exit(0);' : state === "accepted-descendant" ? `const child=spawn(process.execPath,["-e",${JSON.stringify(heartbeatProgram)}],{stdio:"ignore"}); publishDescendantPid(child.pid); process.stdout.write(JSON.stringify({type:"result",nonce:value.nonce,receipt:{outcome:"accepted"}})+"\\n",()=>process.exit(0));` : state === "after" ? 'publishObservedState("permission"); process.exit(0);' : state === "close-after-permission" ? 'publishObservedState("permission"); closeSync(0); setInterval(()=>{},1000);' : state === "exit-after-permission" ? 'publishObservedState("permission"); process.exit(0);' : state === "result-error" ? 'publishObservedState("permission"); process.stdout.write(JSON.stringify({type:"result",nonce:value.nonce,receipt:{outcome:"accepted"}})+"\\n"); process.exit(1);' : state === "wrong-result" ? 'publishObservedState("permission"); process.stdout.write(JSON.stringify({type:"result",nonce:"0".repeat(32),receipt:{outcome:"accepted"}})+"\\n"); process.exit(0);' : state === "descendant" ? `const child=spawn(process.execPath,["-e",${JSON.stringify(heartbeatProgram)}],{stdio:"ignore"}); publishDescendantPid(child.pid); setInterval(()=>{},1000);` : "setInterval(()=>{},1000);"}
    }
  }
});
`;
};

const attempt = async (
  state: WorkerState,
  options: Readonly<{
    abortAfterMilliseconds?: number;
    abortAfterDescendant?: boolean;
    failRelease?: boolean;
    failAmend?: boolean;
    throwAmend?: boolean;
    identityMissing?: boolean;
    missingWorker?: boolean;
    omitChildIdentity?: boolean;
    maximumWorkMilliseconds?: number;
    minimumUsefulWorkMilliseconds?: number;
    monotonicNowForTesting?: () => number;
    teardownReserveMilliseconds?: number;
    stubbornWatchdog?: boolean;
    watchAcknowledgementDelayMilliseconds?: number;
    withTrace?: boolean;
  }> = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-reporter-child-"));
  chmodSync(root, 0o700);
  try {
    const workerPath = join(root, "worker.cjs");
    const watchdogPath = join(root, "watchdog.cjs");
    const lifecycle = join(root, "lifecycle");
    const descendantPath = join(root, "descendant.pid");
    const heartbeatPath = join(root, "descendant.heartbeat");
    const stateObservedPath = join(root, "state.observed");
    mkdirSync(lifecycle, { mode: 0o700 });
    if (!options.missingWorker)
      writeFileSync(
        workerPath,
        workerProgram(state, descendantPath, heartbeatPath, stateObservedPath),
        {
          mode: 0o600,
        },
      );
    writeFileSync(
      watchdogPath,
      watchdogProgram(
        options.stubbornWatchdog,
        options.watchAcknowledgementDelayMilliseconds,
        state === "close-before-header" ? descendantPath : undefined,
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
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("lease fixture");
    const gate = Object.freeze({
      ...filesystemGate,
      ...(options.failRelease === true
        ? {
            removeArtifactIfIdentity: () =>
              Object.freeze({ state: "mismatch" as const }),
          }
        : {}),
      ...(options.failAmend === true
        ? {
            replaceLeaseDurably: () =>
              Object.freeze({ state: "mismatch" as const }),
          }
        : {}),
      ...(options.throwAmend === true
        ? {
            replaceLeaseDurably: () => {
              throw new Error("synthetic amendment failure");
            },
          }
        : {}),
    });
    const controller = new AbortController();
    let descendantObservedAt: number | undefined;
    let observedDescendantPid: number | undefined;
    const descendantAbortTimer =
      options.abortAfterDescendant === true
        ? setInterval(() => {
            if (descendantObservedAt !== undefined) return;
            let encodedPid: string;
            try {
              encodedPid = readFileSync(descendantPath, "utf8");
            } catch {
              return;
            }
            if (!/^[1-9][0-9]*$/.test(encodedPid)) return;
            observedDescendantPid = Number(encodedPid);
            descendantObservedAt = performance.now();
            controller.abort();
          }, 1)
        : undefined;
    const abortTimer =
      options.abortAfterMilliseconds === undefined
        ? undefined
        : setTimeout(() => {
            controller.abort();
          }, options.abortAfterMilliseconds);
    try {
      const startedAt = performance.now();
      const receipt = await executeLocalSqliteReporterChild({
        programs: { workerPath, watchdogPath },
        gate,
        lease: lease.value,
        nonce: "3".repeat(32),
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
        prepared: options.withTrace
          ? [
              Object.freeze({
                deliveryIdentity: "6".repeat(64),
                traceId: "7".repeat(32),
                startTimeUnixNano: "1",
                startTimeSortKey: "0".repeat(19) + "1",
                admissionTimeUnixNano: "1",
                admissionTimeSortKey: "0".repeat(19) + "1",
                protocolCompatibilityId: `sha256-${"8".repeat(64)}`,
                payloadUtf8: "{}",
                payloadSha256: "9".repeat(64),
                payloadBytes: 2,
                dimensions: Object.freeze([]),
              }),
            ]
          : [],
        admissionTimeUnixNano: "1",
        cutoffAtMonotonicMilliseconds:
          (options.monotonicNowForTesting === undefined
            ? performance.now()
            : 0) +
          (options.maximumWorkMilliseconds ??
            (extendedWorkStates.has(state) ? 2_000 : 300)),
        minimumUsefulWorkMilliseconds:
          options.minimumUsefulWorkMilliseconds ?? 10,
        teardownReserveMilliseconds: options.teardownReserveMilliseconds ?? 500,
        signal: controller.signal,
        ...(options.monotonicNowForTesting === undefined
          ? {}
          : { monotonicNowForTesting: options.monotonicNowForTesting }),
        ...(options.omitChildIdentity === true
          ? {}
          : {
              childIdentity: () =>
                options.identityMissing === true ? undefined : childIdentity,
            }),
      });
      const descendantPid =
        state === "descendant" || state === "accepted-descendant"
          ? (observedDescendantPid ??
            Number(readFileSync(descendantPath, "utf8")))
          : undefined;
      let descendantStopped: boolean | undefined;
      if (descendantPid !== undefined) {
        const before = (() => {
          try {
            return readFileSync(heartbeatPath, "utf8");
          } catch {
            return "";
          }
        })();
        await new Promise((resolve) => setTimeout(resolve, 30));
        const after = (() => {
          try {
            return readFileSync(heartbeatPath, "utf8");
          } catch {
            return "";
          }
        })();
        descendantStopped = after === before;
      }
      return Object.freeze({
        receipt,
        elapsed: performance.now() - startedAt,
        cleanupElapsed:
          descendantObservedAt === undefined
            ? undefined
            : performance.now() - descendantObservedAt,
        entries: readdirSync(lifecycle),
        stateObserved: (() => {
          try {
            return readFileSync(stateObservedPath, "utf8");
          } catch {
            return undefined;
          }
        })(),
        descendantPid,
        descendantStopped,
      });
    } finally {
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      if (descendantAbortTimer !== undefined)
        clearInterval(descendantAbortTimer);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe("bounded Local SQLite Reporter child", () => {
  it("streams a prepared trace before granting mutation permission", async () => {
    const result = await attempt("accepted", { withTrace: true });
    expect(result.receipt).toEqual({ outcome: "accepted" });
    expect(result.entries).toEqual([]);
  });

  it("rejects an oversized child frame at the bounded reader", async () => {
    const stdout = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { stdout });
    const messages = readLocalSqliteReporterChildMessages(
      child as never,
      "3".repeat(32),
    );
    stdout.emit("data", Buffer.alloc(4_097, "x"));
    await expect(messages.ready).resolves.toBeUndefined();
    await expect(messages.result).resolves.toBeUndefined();
  });

  it("refuses wire encoding before spawn when the useful budget expires", async () => {
    const beforeClock = [2];
    const before = await attempt("accepted", {
      withTrace: true,
      maximumWorkMilliseconds: 2,
      minimumUsefulWorkMilliseconds: 1,
      monotonicNowForTesting: () => beforeClock.shift() ?? 2,
    });
    expect(before.receipt).toEqual({ outcome: "unavailable" });
    expect(before.entries).toEqual([]);

    const afterClock = [0, 2];
    const after = await attempt("accepted", {
      withTrace: true,
      maximumWorkMilliseconds: 2,
      minimumUsefulWorkMilliseconds: 1,
      monotonicNowForTesting: () => afterClock.shift() ?? 2,
    });
    expect(after.receipt).toEqual({ outcome: "unavailable" });
    expect(after.entries).toEqual([]);
  });
  for (const [state, outcome] of [
    ["accepted", "accepted"],
    ["before", "unavailable"],
    ["after", "outcome-unknown"],
  ] as const) {
    it(`joins and classifies ${state}`, async () => {
      const result = await attempt(
        state,
        state === "before" ? { maximumWorkMilliseconds: 40 } : {},
      );
      expect(result.receipt).toEqual({ outcome });
      expect(result.entries).toEqual([]);
      if (permissionObservedStates.has(state))
        expect(result.stateObserved).toBe("permission");
    });
  }

  for (const [state, outcome] of [
    ["malformed", "unavailable"],
    ["oversized", "unavailable"],
    ["wrong-start", "unavailable"],
    ["close-after-permission", "outcome-unknown"],
    ["exit-after-permission", "outcome-unknown"],
    ["result-error", "outcome-unknown"],
    ["wrong-result", "outcome-unknown"],
  ] as const) {
    it(`rejects hostile ${state} settlement`, async () => {
      const result = await attempt(state);
      expect(result.receipt).toEqual({ outcome });
      expect(result.entries).toEqual([]);
      if (permissionObservedStates.has(state))
        expect(result.stateObserved).toBe("permission");
    });
  }

  it("aborts before permission as proven noncommit", async () => {
    const result = await attempt("before", { abortAfterMilliseconds: 10 });
    expect(result.receipt).toEqual({ outcome: "unavailable" });
    expect(result.entries).toEqual([]);
  });

  it("rejects peer closure before the bounded header write", async () => {
    const result = await attempt("close-before-header", {
      maximumWorkMilliseconds: 1_000,
      watchAcknowledgementDelayMilliseconds: 100,
    });
    expect(result.receipt).toEqual({ outcome: "unavailable" });
    expect(result.entries).toEqual([]);
  });

  it("rejects a missing worker and joins the watchdog", async () => {
    const result = await attempt("before", { missingWorker: true });
    expect(result.receipt).toEqual({ outcome: "unavailable" });
    expect(result.entries).toEqual([]);
  });

  it("preserves ambiguity when exact lease release fails", async () => {
    const result = await attempt("accepted", { failRelease: true });
    expect(result.receipt).toEqual({ outcome: "outcome-unknown" });
    expect(result.entries).toEqual([
      `lease-${"1".repeat(32)}.json`,
      `lease-cleanup-${"1".repeat(32)}.json`,
    ]);
  });

  it("rejects missing child identity and failed or throwing lease amendment", async () => {
    for (const options of [
      { omitChildIdentity: true },
      { identityMissing: true },
      { failAmend: true },
      { throwAmend: true },
    ]) {
      const result = await attempt("after", options);
      expect(result.receipt).toEqual({ outcome: "unavailable" });
      expect(result.entries).toEqual([]);
    }
  });

  it("keeps pre-permission cleanup failure a proven unavailable result", async () => {
    const result = await attempt("before", {
      failRelease: true,
      maximumWorkMilliseconds: 40,
    });
    expect(result.receipt).toEqual({ outcome: "unavailable" });
    expect(result.entries).toEqual([
      `lease-${"1".repeat(32)}.json`,
      `lease-cleanup-${"1".repeat(32)}.json`,
    ]);
  });

  it("forces a nonsettling watchdog and worker group inside one reserve", async () => {
    const result = await attempt("descendant", {
      abortAfterDescendant: true,
      maximumWorkMilliseconds: 1_000,
      stubbornWatchdog: true,
      teardownReserveMilliseconds: 80,
    });
    expect(result.cleanupElapsed).toBeLessThan(250);
    expect(result.receipt).toEqual({ outcome: "outcome-unknown" });
    expect(result.descendantPid).toBeTypeOf("number");
    expect(result.descendantStopped).toBe(true);
  });

  it("reaps the complete group after a successful leader exits", async () => {
    const result = await attempt("accepted-descendant", {
      maximumWorkMilliseconds: 2_000,
      teardownReserveMilliseconds: 1_000,
    });
    expect(result.receipt).toEqual({ outcome: "accepted" });
    expect(result.descendantPid).toBeTypeOf("number");
    expect(result.descendantStopped).toBe(true);
  });
});

/* eslint-enable max-lines-per-function */
