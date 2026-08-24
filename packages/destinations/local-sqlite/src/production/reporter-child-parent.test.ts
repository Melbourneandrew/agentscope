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
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { acquireLocalSqliteSharedLease } from "../lifecycle/fence.js";
import { createLocalSqliteFilesystemGatePort } from "./filesystem-port.js";
import { executeLocalSqliteReporterChild } from "./reporter-child-parent.js";

const fingerprint = `sha256-${"a".repeat(64)}`;
const childIdentity = "5".repeat(32);
type WorkerState =
  | "accepted"
  | "before"
  | "after"
  | "malformed"
  | "oversized"
  | "wrong-start"
  | "close-after-ready"
  | "exit-after-ready"
  | "descendant"
  | "result-error"
  | "wrong-result";

const watchdogProgram = (stubborn = false) => `
let worker;
let complete = false;
process.on("message", (value) => {
  if (value?.type === "watch") {
    worker = value.workerPid;
    process.send({type:"watching"});
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

const workerProgram = (state: WorkerState, descendantPath: string) => `
const {spawn} = require("node:child_process");
const {writeFileSync} = require("node:fs");
let buffer = "";
let request;
let traces = 0;
const ready = () => {
  ${state === "before" ? "return;" : state === "malformed" ? 'process.stdout.write("{}\\n"); process.exit(0);' : state === "oversized" ? 'process.stdout.write("x".repeat(4097)); process.exit(0);' : `process.stdout.write(JSON.stringify({type:"ready",nonce:request.nonce,pid:process.pid,startIdentity:"${state === "wrong-start" ? "6".repeat(32) : childIdentity}"})+"\\n");`}
  ${state === "close-after-ready" ? "process.stdin.destroy(); setInterval(()=>{},1000);" : ""}
  ${state === "exit-after-ready" ? "setTimeout(() => process.exit(0), 25);" : ""}
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
      ${state === "accepted" ? 'process.stdout.write(JSON.stringify({type:"result",nonce:value.nonce,receipt:{outcome:"accepted"}})+"\\n"); process.exit(0);' : state === "result-error" ? 'process.stdout.write(JSON.stringify({type:"result",nonce:value.nonce,receipt:{outcome:"accepted"}})+"\\n"); process.exit(1);' : state === "wrong-result" ? 'process.stdout.write(JSON.stringify({type:"result",nonce:"0".repeat(32),receipt:{outcome:"accepted"}})+"\\n"); process.exit(0);' : state === "descendant" ? `const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); writeFileSync(${JSON.stringify(descendantPath)},String(child.pid)); setInterval(()=>{},1000);` : "setInterval(()=>{},1000);"}
    }
  }
});
`;

const attempt = async (
  state: WorkerState,
  options: Readonly<{
    abortAfterMilliseconds?: number;
    failRelease?: boolean;
    failAmend?: boolean;
    throwAmend?: boolean;
    identityMissing?: boolean;
    missingWorker?: boolean;
    omitChildIdentity?: boolean;
    maximumWorkMilliseconds?: number;
    teardownReserveMilliseconds?: number;
    stubbornWatchdog?: boolean;
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
    mkdirSync(lifecycle, { mode: 0o700 });
    if (!options.missingWorker)
      writeFileSync(workerPath, workerProgram(state, descendantPath), {
        mode: 0o600,
      });
    writeFileSync(watchdogPath, watchdogProgram(options.stubbornWatchdog), {
      mode: 0o600,
    });
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
    const abortTimer =
      options.abortAfterMilliseconds === undefined
        ? undefined
        : setTimeout(() => {
            controller.abort();
          }, options.abortAfterMilliseconds);
    try {
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
        maximumWorkMilliseconds:
          options.maximumWorkMilliseconds ??
          (state === "accepted" || state === "result-error" ? 1_000 : 300),
        teardownReserveMilliseconds: options.teardownReserveMilliseconds ?? 500,
        signal: controller.signal,
        ...(options.omitChildIdentity === true
          ? {}
          : {
              childIdentity: () =>
                options.identityMissing === true ? undefined : childIdentity,
            }),
      });
      const descendantPid =
        state === "descendant"
          ? Number(readFileSync(descendantPath, "utf8"))
          : undefined;
      return Object.freeze({
        receipt,
        entries: readdirSync(lifecycle),
        descendantPid,
      });
    } finally {
      if (abortTimer !== undefined) clearTimeout(abortTimer);
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
    });
  }

  for (const [state, outcome] of [
    ["malformed", "unavailable"],
    ["oversized", "unavailable"],
    ["wrong-start", "unavailable"],
    ["close-after-ready", "outcome-unknown"],
    ["exit-after-ready", "outcome-unknown"],
    ["result-error", "outcome-unknown"],
    ["wrong-result", "outcome-unknown"],
  ] as const) {
    it(`rejects hostile ${state} settlement`, async () => {
      const result = await attempt(state);
      expect(result.receipt).toEqual({ outcome });
      expect(result.entries).toEqual([]);
    });
  }

  it("aborts before permission as proven noncommit", async () => {
    const result = await attempt("before", { abortAfterMilliseconds: 10 });
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
    const started = performance.now();
    const result = await attempt("descendant", {
      maximumWorkMilliseconds: 200,
      stubbornWatchdog: true,
      teardownReserveMilliseconds: 80,
    });
    expect(performance.now() - started).toBeLessThan(350);
    expect(result.receipt).toEqual({ outcome: "outcome-unknown" });
    expect(result.descendantPid).toBeTypeOf("number");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(() => process.kill(result.descendantPid!, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });
});

/* eslint-enable max-lines-per-function */
