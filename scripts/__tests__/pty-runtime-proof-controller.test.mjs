import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";
import { afterEach, test } from "vitest";

import {
  executeController,
  parseExactContainerId,
  runBoundedProcess,
} from "../pty-runtime-proof-controller.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

const operations = ({ failAt, cleanup = true, signalAt } = {}) => {
  let latch = () => false;
  const events = [];
  const operation = (name) => async () => {
    events.push(name);
    if (signalAt === name) {
      latch("SIGTERM");
      latch("SIGINT");
    }
    if (failAt === name) throw new Error("raw fixture diagnostic");
  };
  return {
    events,
    installSignalHandlers(value) {
      latch = value;
      return () => events.push("uninstall");
    },
    setup: operation("setup"),
    inputIdentity: operation("input-identity"),
    imageIdentity: operation("image-identity"),
    create: operation("create"),
    runtimeReceipt: operation("runtime-receipt"),
    terminalJoin: operation("terminal-join"),
    finalAssertion: operation("final-assertion"),
    async cleanup() {
      events.push("cleanup");
      if (signalAt === "cleanup") {
        latch("SIGTERM");
        latch("SIGINT");
      }
      if (failAt === "cleanup") throw new Error("raw cleanup diagnostic");
      return cleanup;
    },
  };
};

test("emits one closed receipt for every lifecycle failure prefix", async () => {
  for (const stage of [
    "setup",
    "input-identity",
    "image-identity",
    "create",
    "runtime-receipt",
    "terminal-join",
    "final-assertion",
  ]) {
    const fixture = operations({ failAt: stage });
    const result = await executeController({ operations: fixture });
    assert.deepEqual(result.receipt, {
      version: 1,
      stage,
      status: "failed",
      runtimeReceiptAuthenticated: [
        "terminal-join",
        "final-assertion",
      ].includes(stage),
      cleanupProved: true,
      originalOutcome: "failure",
      signal: null,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(fixture.events.at(-2), "cleanup");
    assert.equal(fixture.events.at(-1), "uninstall");
  }
});

test("passes only after authenticated receipt, terminal join, and cleanup", async () => {
  const result = await executeController({ operations: operations() });
  assert.deepEqual(result, {
    exitCode: 0,
    receipt: {
      version: 1,
      stage: "final-assertion",
      status: "passed",
      runtimeReceiptAuthenticated: true,
      cleanupProved: true,
      originalOutcome: "success",
      signal: null,
    },
  });
});

test("latches the first signal without reentrant cleanup or later work", async () => {
  for (const signalAt of ["setup", "create", "cleanup"]) {
    const fixture = operations({ signalAt });
    const result = await executeController({ operations: fixture });
    assert.equal(result.exitCode, 143);
    assert.equal(result.receipt.status, "failed");
    assert.equal(result.receipt.originalOutcome, "signal");
    assert.equal(result.receipt.signal, "SIGTERM");
    assert.equal(
      fixture.events.filter((value) => value === "cleanup").length,
      1,
    );
    if (signalAt !== "cleanup")
      assert.equal(fixture.events.includes("final-assertion"), false);
  }
});

test("cleanup uncertainty overrides apparent success", async () => {
  for (const fixture of [
    operations({ cleanup: false }),
    operations({ failAt: "cleanup" }),
  ]) {
    const result = await executeController({ operations: fixture });
    assert.deepEqual(result.receipt, {
      version: 1,
      stage: "cleanup",
      status: "failed",
      runtimeReceiptAuthenticated: true,
      cleanupProved: false,
      originalOutcome: "uncertain",
      signal: null,
    });
    assert.equal(result.exitCode, 1);
  }
});

test("an expired deadline launches no operation", async () => {
  const fixture = operations();
  const result = await executeController({
    absoluteDeadline: performance.now() - 1,
    operations: fixture,
  });
  assert.deepEqual(fixture.events, ["cleanup", "uninstall"]);
  assert.equal(result.receipt.originalOutcome, "timeout");
  assert.equal(result.receipt.status, "failed");
});

test("bounded direct process execution captures no raw output", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "agentscope-pty-controller."));
  roots.push(root);
  const fixture = resolve(root, "fixture.mjs");
  writeFileSync(
    fixture,
    'process.stdout.write("fixture-out");process.stderr.write("fixture-err");',
    { mode: 0o700 },
  );
  const result = await runBoundedProcess(process.execPath, [fixture], {
    absoluteDeadline: performance.now() + 10_000,
    cwd: root,
    env: { PATH: "/usr/bin:/bin" },
    readStartIdentity: () => "fixture-start",
  });
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.toString(), "fixture-out");
  assert.equal(result.stderr.toString(), "fixture-err");
});

test("bounds timeout, output overflow, and direct signal settlement", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "agentscope-pty-controller."));
  roots.push(root);
  const runFixture = (source, options = {}) =>
    runBoundedProcess(process.execPath, ["-e", source], {
      absoluteDeadline: performance.now() + 10_000,
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      readStartIdentity: () => "fixture-start",
      ...options,
    });
  await assert.rejects(
    runFixture("setTimeout(()=>{},10000)", {
      absoluteDeadline: performance.now() + 7_100,
    }),
    /command-timeout/u,
  );
  await assert.rejects(
    runFixture(
      'process.stdout.write("x".repeat(20000));setTimeout(()=>{},1000)',
    ),
    /command-output-overflow/u,
  );
  const signaled = await runFixture("setTimeout(()=>{},10000)", {
    onActive: (active) => active?.terminate("SIGTERM"),
  });
  assert.equal(signaled.status, null);
  assert.equal(signaled.signal, "SIGTERM");
});

test("rejects process-start substitution before group signaling", async () => {
  let reads = 0;
  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {
      absoluteDeadline: performance.now() + 10_000,
      cwd: tmpdir(),
      env: { PATH: "/usr/bin:/bin" },
      onActive: (active) => active?.terminate("SIGTERM"),
      readStartIdentity: () => (reads++ === 0 ? "first" : "substituted"),
    }),
    /process-start-identity-mismatch/u,
  );
});

test("rejects a same-group descendant after its leader exits", async () => {
  const source =
    'require("node:child_process").spawn("/bin/sleep",["0.2"],{stdio:"ignore"}).unref();';
  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", source], {
      absoluteDeadline: performance.now() + 10_000,
      cwd: tmpdir(),
      env: { PATH: "/usr/bin:/bin" },
      readStartIdentity: () => "fixture-start",
    }),
    /process-group-survived/u,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
});

test("controller source is no-shell, bounded, and emits one sanitized receipt", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../pty-runtime-proof-controller.mjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /execSync|spawnSync|shell:\s*true/u);
  assert.match(source, /shell: false/u);
  assert.match(source, /maximumOutputBytes = 16 \* 1024/u);
  assert.match(source, /totalMilliseconds = 90_000/u);
  assert.match(source, /teardownReserveMilliseconds = 7_000/u);
  assert.equal(source.match(/process\.stdout\.write/gmu)?.length, 1);
  assert.equal(source.match(/process\.stderr\.write/gmu)?.length, undefined);
});

test("accepts one exact container identity and rejects ambiguous observations", () => {
  const identity = "a".repeat(64);
  assert.equal(parseExactContainerId(Buffer.from(`${identity}\n`)), identity);
  for (const value of [
    Buffer.alloc(0),
    Buffer.from(identity),
    Buffer.from(`${identity}\n${identity}\n`),
    Buffer.from(`${identity} \n`),
    Buffer.from(`${"g".repeat(64)}\n`),
  ])
    assert.throws(
      () => parseExactContainerId(value),
      /container-identity-invalid/u,
    );
});
