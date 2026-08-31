import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import {
  classifyWorkspacePolicyInventory,
  createVitestInvocation,
  createWorkspacePolicyPlan,
  discoverWorkspacePolicyInventory,
  executeVitestInvocation,
  main,
  processAuthorityFiles,
  runWorkspacePolicyPlan,
} from "../workspace-policy-runner.mjs";

const workspaceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("the checked-in inventory is classified exactly once", () => {
  const inventory = discoverWorkspacePolicyInventory();
  const plan = createWorkspacePolicyPlan(
    inventory,
    classifyWorkspacePolicyInventory(inventory),
  );
  assert.deepEqual(
    [...plan.pure, ...plan.authority].sort(),
    [...inventory].sort(),
  );
  assert.equal(
    new Set([...plan.pure, ...plan.authority]).size,
    inventory.length,
  );
  assert.ok(plan.pure.includes("workspace-policy-runner.test.mjs"));
  for (const name of processAuthorityFiles) {
    if (inventory.includes(name)) {
      assert.ok(plan.authority.includes(name));
      assert.ok(!plan.pure.includes(name));
    }
  }
});

test("the reserved prepush suite is authority only when present", () => {
  const absentInventory = ["pure.test.mjs"];
  const absent = createWorkspacePolicyPlan(
    absentInventory,
    classifyWorkspacePolicyInventory(absentInventory),
  );
  assert.deepEqual(absent, {
    authority: [],
    pure: ["pure.test.mjs"],
  });

  const presentInventory = ["pure.test.mjs", "prepush.test.mjs"];
  const present = createWorkspacePolicyPlan(
    presentInventory,
    classifyWorkspacePolicyInventory(presentInventory),
  );
  assert.deepEqual(present, {
    authority: ["prepush.test.mjs"],
    pure: ["pure.test.mjs"],
  });
});

test("invalid inventory and classifications fail closed", () => {
  const inventory = ["pure.test.mjs", "validation-lease.test.mjs"];
  const valid = classifyWorkspacePolicyInventory(inventory);
  assert.throws(
    () => createWorkspacePolicyPlan([...inventory, inventory[0]], valid),
    /duplicate inventory entry/,
  );
  assert.throws(
    () =>
      createWorkspacePolicyPlan(
        ["../escape.test.mjs"],
        [{ classification: "pure", name: "../escape.test.mjs" }],
      ),
    /invalid test name/,
  );
  assert.throws(
    () => createWorkspacePolicyPlan(inventory, valid.slice(1)),
    /missing classification/,
  );
  assert.throws(
    () => createWorkspacePolicyPlan(inventory, [...valid, valid[0]]),
    /duplicate classification/,
  );
  assert.throws(
    () =>
      createWorkspacePolicyPlan(inventory, [
        ...valid,
        { classification: "pure", name: "unknown.test.mjs" },
      ]),
    /unknown test/,
  );
  assert.throws(
    () =>
      createWorkspacePolicyPlan(inventory, [
        { classification: "unsafe", name: inventory[0] },
        valid[1],
      ]),
    /unknown classification/,
  );
  assert.throws(
    () =>
      createWorkspacePolicyPlan(
        ["unknown-authority.test.mjs"],
        [{ classification: "authority", name: "unknown-authority.test.mjs" }],
      ),
    /outside the closed authority set/,
  );
  assert.throws(
    () =>
      createWorkspacePolicyPlan(
        ["validation-lease.test.mjs"],
        [{ classification: "pure", name: "validation-lease.test.mjs" }],
      ),
    /authority test was classified as pure/,
  );
});

test("pure tests batch once before authority tests serialize", async () => {
  const plan = createWorkspacePolicyPlan(
    [
      "validation-lease.test.mjs",
      "pure-b.test.mjs",
      "code-quality-policy.test.mjs",
      "pure-a.test.mjs",
    ],
    classifyWorkspacePolicyInventory([
      "validation-lease.test.mjs",
      "pure-b.test.mjs",
      "code-quality-policy.test.mjs",
      "pure-a.test.mjs",
    ]),
  );
  const calls = [];
  const outcome = await runWorkspacePolicyPlan(plan, async (invocation) => {
    calls.push({
      files: invocation.arguments
        .slice(6)
        .map((path) => path.split("/").at(-1)),
      workers: invocation.arguments[5],
    });
    return { code: 0, signal: undefined };
  });
  assert.deepEqual(outcome, { code: 0, signal: undefined });
  assert.deepEqual(calls, [
    { files: ["pure-a.test.mjs", "pure-b.test.mjs"], workers: "2" },
    { files: ["code-quality-policy.test.mjs"], workers: "1" },
    { files: ["validation-lease.test.mjs"], workers: "1" },
  ]);
});

test("a failed child preserves its result and admits no later child", async () => {
  const inventory = [
    "pure.test.mjs",
    "code-quality-policy.test.mjs",
    "validation-lease.test.mjs",
  ];
  const plan = createWorkspacePolicyPlan(
    inventory,
    classifyWorkspacePolicyInventory(inventory),
  );
  const calls = [];
  const outcome = await runWorkspacePolicyPlan(plan, async (invocation) => {
    const name = invocation.arguments.at(-1).split("/").at(-1);
    calls.push(name);
    return name === "code-quality-policy.test.mjs"
      ? { code: 73, signal: undefined }
      : { code: 0, signal: undefined };
  });
  assert.deepEqual(outcome, { code: 73, signal: undefined });
  assert.deepEqual(calls, ["pure.test.mjs", "code-quality-policy.test.mjs"]);
});

test("the next authority child waits for prior terminal publication", async () => {
  const inventory = [
    "code-quality-policy.test.mjs",
    "validation-lease.test.mjs",
  ];
  const plan = createWorkspacePolicyPlan(
    inventory,
    classifyWorkspacePolicyInventory(inventory),
  );
  const starts = [];
  let release;
  const firstTerminal = new Promise((resolveTerminal) => {
    release = resolveTerminal;
  });
  const running = runWorkspacePolicyPlan(plan, async (invocation) => {
    starts.push(invocation.arguments.at(-1).split("/").at(-1));
    if (starts.length === 1) await firstTerminal;
    return { code: 0, signal: undefined };
  });
  await new Promise((resolveReady) => setImmediate(resolveReady));
  assert.deepEqual(starts, ["code-quality-policy.test.mjs"]);
  release();
  assert.deepEqual(await running, { code: 0, signal: undefined });
  assert.deepEqual(starts, [
    "code-quality-policy.test.mjs",
    "validation-lease.test.mjs",
  ]);
});

test("Vitest execution is direct, closed, and joins the child terminal", async () => {
  const invocation = createVitestInvocation(["validation-lease.test.mjs"]);
  assert.equal(invocation.executable, process.execPath);
  assert.equal(invocation.arguments[1], "run");
  assert.equal(invocation.arguments[2], "--config");
  assert.equal(
    invocation.arguments[3],
    resolve(workspaceRoot, "vitest.config.ts"),
  );
  assert.equal(invocation.arguments[4], "--maxWorkers");
  assert.equal(invocation.arguments[5], "1");
  assert.equal(
    invocation.arguments[6],
    resolve(workspaceRoot, "scripts/__tests__/validation-lease.test.mjs"),
  );
  assert.equal(invocation.arguments[0], realpathSync(invocation.arguments[0]));

  const child = new EventEmitter();
  child.pid = 4242;
  let options;
  const result = executeVitestInvocation(
    invocation,
    (executable, arguments_, value) => {
      assert.equal(executable, process.execPath);
      assert.deepEqual(arguments_, invocation.arguments);
      options = value;
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  );
  assert.deepEqual(await result, { code: 0, signal: undefined });
  assert.equal(options.shell, false);
  assert.equal(options.cwd, workspaceRoot);
  assert.equal(options.env.NODE_OPTIONS, undefined);
  assert.equal(options.env.AGENTSCOPE_VALIDATION_LEASE_TOKEN, undefined);
});

test("a forwarded signal waits for the exact child terminal", async () => {
  const invocation = createVitestInvocation(["validation-lease.test.mjs"]);
  const child = new EventEmitter();
  child.pid = 4242;
  const signalHost = new EventEmitter();
  signalHost.platform = "darwin";
  const signals = [];
  signalHost.kill = (pid, signal) => signals.push([pid, signal]);
  const result = executeVitestInvocation(invocation, () => child, signalHost);
  let terminal = false;
  void result.then(() => {
    terminal = true;
  });
  signalHost.emit("SIGTERM");
  await new Promise((resolveReady) => setImmediate(resolveReady));
  assert.deepEqual(signals, [[-4242, "SIGTERM"]]);
  assert.equal(terminal, false);
  child.emit("close", null, "SIGTERM");
  assert.deepEqual(await result, { code: 1, signal: "SIGTERM" });
  assert.equal(terminal, true);
  assert.equal(signalHost.listenerCount("SIGTERM"), 0);
});

test("caller arguments and empty child batches are rejected", async () => {
  assert.throws(() => createVitestInvocation([]), /requires at least one/);
  assert.throws(
    () => createVitestInvocation(["pure.test.mjs"], 0),
    /positive worker ceiling/,
  );
  await assert.rejects(main(["--retry"]), /caller arguments are not accepted/);
});
