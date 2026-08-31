import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import {
  childLifecycleBounds,
  classifyWorkspacePolicyInventory,
  createVitestInvocation,
  createWorkspacePolicyPlan,
  discoverWorkspacePolicyInventory,
  executeVitestInvocation,
  main,
  processAuthorityFiles,
  publishTerminalOutcome,
  purePolicyFiles,
  requiredPolicyFiles,
  runWorkspacePolicyPlan,
  validateWorkspacePolicyInventory,
} from "../workspace-policy-runner.mjs";

const workspaceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function createLifecycleHarness() {
  let now = 0;
  let observation = { groupAbsent: true, leader: "absent" };
  let inspectError = false;
  let signalError = false;
  const inspections = [];
  const signals = [];
  const timers = [];
  const authority = {
    capture(pid) {
      assert.equal(pid, 4242);
      return Object.freeze({ pid, startIdentity: "start-1" });
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
    inspect(identity) {
      assert.deepEqual(identity, { pid: 4242, startIdentity: "start-1" });
      inspections.push(identity);
      if (inspectError) throw new Error("synthetic inspection failure");
      return observation;
    },
    now: () => now,
    setTimer(callback, delay) {
      const timer = { callback, cleared: false, deadline: now + delay };
      timers.push(timer);
      return timer;
    },
    signal(identity, signal) {
      assert.deepEqual(identity, { pid: 4242, startIdentity: "start-1" });
      if (signalError) throw new Error("synthetic signal failure");
      signals.push(signal);
    },
  };
  return {
    authority,
    async advanceTo(deadline) {
      while (true) {
        const timer = timers
          .filter((item) => !item.cleared && item.deadline <= deadline)
          .sort((left, right) => left.deadline - right.deadline)[0];
        if (timer === undefined) break;
        timer.cleared = true;
        now = timer.deadline;
        timer.callback();
        await Promise.resolve();
      }
      now = deadline;
      await Promise.resolve();
    },
    async fireAt(deadline) {
      now = deadline;
      for (const timer of timers.filter(
        (item) => !item.cleared && item.deadline === deadline,
      )) {
        timer.cleared = true;
        timer.callback();
      }
      await Promise.resolve();
    },
    setInspectionError(value) {
      inspectError = value;
    },
    setObservation(value) {
      observation = value;
    },
    setSignalError(value) {
      signalError = value;
    },
    inspections,
    signals,
  };
}

test("the checked-in inventory is classified exactly once", () => {
  const inventory = discoverWorkspacePolicyInventory();
  assert.equal(validateWorkspacePolicyInventory(inventory), inventory);
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
  assert.deepEqual(plan.pure, purePolicyFiles);
  for (const name of processAuthorityFiles) {
    if (inventory.includes(name)) {
      assert.ok(plan.authority.includes(name));
      assert.ok(!plan.pure.includes(name));
    }
  }
});

test("the checked-in inventory rejects omissions and unreviewed growth", () => {
  const inventory = discoverWorkspacePolicyInventory();
  for (const required of requiredPolicyFiles) {
    assert.throws(
      () =>
        validateWorkspacePolicyInventory(
          inventory.filter((name) => name !== required),
        ),
      new RegExp(
        `required test is missing: ${required.replaceAll(".", "\\.")}`,
      ),
    );
  }
  assert.throws(
    () =>
      validateWorkspacePolicyInventory([
        ...inventory,
        "future-authority.test.mjs",
      ]),
    /no reviewed classification/,
  );
  assert.throws(
    () => validateWorkspacePolicyInventory([...inventory, inventory[0]]),
    /inventory contains duplicates/,
  );
  assert.equal(
    validateWorkspacePolicyInventory([...inventory, "prepush.test.mjs"]).length,
    inventory.length + 1,
  );
});

test("nested test-domain growth fails before classification", () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-policy-inventory-"));
  try {
    mkdirSync(join(root, "nested"));
    assert.throws(
      () => discoverWorkspacePolicyInventory(root),
      /nested test directory is not admitted: nested/,
    );
    rmSync(join(root, "nested"), { recursive: true });
    symlinkSync("missing.test.mjs", join(root, "linked.test.mjs"));
    assert.throws(
      () => discoverWorkspacePolicyInventory(root),
      /test-root entry is not a regular file: linked.test.mjs/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the reserved prepush suite is authority only when present", () => {
  const absentInventory = ["acceptance-evidence.test.mjs"];
  const absent = createWorkspacePolicyPlan(
    absentInventory,
    classifyWorkspacePolicyInventory(absentInventory),
  );
  assert.deepEqual(absent, {
    authority: [],
    pure: ["acceptance-evidence.test.mjs"],
  });

  const presentInventory = ["acceptance-evidence.test.mjs", "prepush.test.mjs"];
  const present = createWorkspacePolicyPlan(
    presentInventory,
    classifyWorkspacePolicyInventory(presentInventory),
  );
  assert.deepEqual(present, {
    authority: ["prepush.test.mjs"],
    pure: ["acceptance-evidence.test.mjs"],
  });
});

test("invalid inventory and classifications fail closed", () => {
  const inventory = [
    "acceptance-evidence.test.mjs",
    "validation-lease.test.mjs",
  ];
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
    /disagrees with reviewed policy/,
  );
  assert.throws(
    () =>
      createWorkspacePolicyPlan(
        ["unknown-authority.test.mjs"],
        [{ classification: "authority", name: "unknown-authority.test.mjs" }],
      ),
    /no reviewed classification/,
  );
  assert.throws(
    () =>
      createWorkspacePolicyPlan(
        ["validation-lease.test.mjs"],
        [{ classification: "pure", name: "validation-lease.test.mjs" }],
      ),
    /disagrees with reviewed policy/,
  );
  assert.throws(
    () => classifyWorkspacePolicyInventory(["future-authority.test.mjs"]),
    /no reviewed classification/,
  );
});

test("pure tests batch once before authority tests serialize", async () => {
  const plan = createWorkspacePolicyPlan(
    [
      "validation-lease.test.mjs",
      "restricted-import-policy.test.mjs",
      "code-quality-policy.test.mjs",
      "acceptance-evidence.test.mjs",
    ],
    classifyWorkspacePolicyInventory([
      "validation-lease.test.mjs",
      "restricted-import-policy.test.mjs",
      "code-quality-policy.test.mjs",
      "acceptance-evidence.test.mjs",
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
    {
      files: [
        "acceptance-evidence.test.mjs",
        "restricted-import-policy.test.mjs",
      ],
      workers: "2",
    },
    { files: ["code-quality-policy.test.mjs"], workers: "1" },
    { files: ["validation-lease.test.mjs"], workers: "1" },
  ]);
});

test("a failed child preserves its result and admits no later child", async () => {
  const inventory = [
    "acceptance-evidence.test.mjs",
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
  assert.deepEqual(calls, [
    "acceptance-evidence.test.mjs",
    "code-quality-policy.test.mjs",
  ]);
});

test("a signaled child admits no later authority child", async () => {
  const inventory = discoverWorkspacePolicyInventory();
  const plan = createWorkspacePolicyPlan(
    inventory,
    classifyWorkspacePolicyInventory(inventory),
  );
  const calls = [];
  const outcome = await runWorkspacePolicyPlan(plan, async (invocation) => {
    calls.push(invocation.arguments.slice(6));
    return { code: 0, signal: "SIGTERM" };
  });
  assert.deepEqual(outcome, { code: 0, signal: "SIGTERM" });
  assert.equal(calls.length, 1);
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
  const lifecycle = createLifecycleHarness();
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
    process,
    lifecycle.authority,
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
  const lifecycle = createLifecycleHarness();
  lifecycle.setObservation({ groupAbsent: false, leader: "same" });
  const result = executeVitestInvocation(
    invocation,
    () => child,
    signalHost,
    lifecycle.authority,
  );
  let terminal = false;
  void result.then(() => {
    terminal = true;
  });
  signalHost.emit("SIGTERM");
  await new Promise((resolveReady) => setImmediate(resolveReady));
  assert.deepEqual(lifecycle.signals, ["SIGTERM"]);
  assert.equal(terminal, false);
  lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
  child.emit("close", 0, null);
  assert.deepEqual(await result, { code: 1, signal: "SIGTERM" });
  assert.equal(terminal, true);
  assert.equal(signalHost.listenerCount("SIGTERM"), 0);
});

test("a publication-gap signal queues until child authority exists", async () => {
  const invocation = createVitestInvocation(["validation-lease.test.mjs"]);
  const child = new EventEmitter();
  child.pid = 4242;
  const signalHost = new EventEmitter();
  signalHost.platform = "darwin";
  const lifecycle = createLifecycleHarness();
  lifecycle.setObservation({ groupAbsent: false, leader: "same" });
  const result = executeVitestInvocation(
    invocation,
    () => {
      signalHost.emit("SIGTERM");
      return child;
    },
    signalHost,
    lifecycle.authority,
  );
  assert.deepEqual(lifecycle.signals, ["SIGTERM"]);
  lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
  child.emit("close", 0, null);
  assert.deepEqual(await result, { code: 1, signal: "SIGTERM" });
  assert.equal(signalHost.listenerCount("SIGTERM"), 0);
});

test("spawn uncertainty is fixed and starts no child lifecycle", async () => {
  const invocation = createVitestInvocation(["validation-lease.test.mjs"]);
  const lifecycle = createLifecycleHarness();
  await assert.rejects(
    executeVitestInvocation(
      invocation,
      () => {
        throw new Error("secret spawn failure");
      },
      process,
      lifecycle.authority,
    ),
    /child spawn uncertainty/,
  );
});

test("signal forwarding failure contains and joins before signaling", async () => {
  const invocation = createVitestInvocation(["validation-lease.test.mjs"]);
  const child = new EventEmitter();
  child.pid = 4242;
  const signalHost = new EventEmitter();
  signalHost.platform = "darwin";
  const lifecycle = createLifecycleHarness();
  lifecycle.setObservation({ groupAbsent: false, leader: "same" });
  lifecycle.setSignalError(true);
  const result = executeVitestInvocation(
    invocation,
    () => child,
    signalHost,
    lifecycle.authority,
  );
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  signalHost.emit("SIGTERM");
  await new Promise((resolveReady) => setImmediate(resolveReady));
  assert.equal(settled, false);
  lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
  child.emit("close", null, "SIGKILL");
  assert.deepEqual(await result, { code: 1, signal: "SIGTERM" });
  assert.equal(settled, true);
  assert.equal(signalHost.listenerCount("SIGTERM"), 0);
});

test("the absolute deadline reserves teardown then kills a hung group", async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  const lifecycle = createLifecycleHarness();
  lifecycle.setObservation({ groupAbsent: false, leader: "same" });
  const result = executeVitestInvocation(
    createVitestInvocation(["validation-lease.test.mjs"]),
    () => child,
    process,
    lifecycle.authority,
  );
  const rejected = assert.rejects(result, /execution deadline exceeded/);
  await lifecycle.advanceTo(
    childLifecycleBounds.hardMilliseconds -
      childLifecycleBounds.teardownMilliseconds,
  );
  assert.deepEqual(lifecycle.signals, ["SIGTERM"]);
  await lifecycle.advanceTo(
    childLifecycleBounds.hardMilliseconds -
      childLifecycleBounds.teardownMilliseconds +
      childLifecycleBounds.signalGraceMilliseconds,
  );
  assert.deepEqual(lifecycle.signals, ["SIGTERM", "SIGKILL"]);
  lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
  child.emit("close", null, "SIGKILL");
  await rejected;
});

test("a surviving same-group descendant blocks the next suite", async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  const lifecycle = createLifecycleHarness();
  lifecycle.setObservation({ groupAbsent: false, leader: "absent" });
  const first = executeVitestInvocation(
    createVitestInvocation(["code-quality-policy.test.mjs"]),
    () => child,
    process,
    lifecycle.authority,
  );
  const rejected = assert.rejects(
    first,
    /leader closed before process-group join/,
  );
  child.emit("close", 0, null);
  let terminal = false;
  void first.catch(() => {
    terminal = true;
  });
  await Promise.resolve();
  assert.equal(terminal, false);
  lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
  await lifecycle.advanceTo(childLifecycleBounds.pollMilliseconds);
  await rejected;
});

test("PID reuse and inspection uncertainty fail without signaling", async () => {
  for (const mode of ["mismatch", "inspection-error"]) {
    const child = new EventEmitter();
    child.pid = 4242;
    const signalHost = new EventEmitter();
    signalHost.platform = "darwin";
    const lifecycle = createLifecycleHarness();
    if (mode === "mismatch")
      lifecycle.setObservation({ groupAbsent: false, leader: "mismatch" });
    else lifecycle.setInspectionError(true);
    const result = executeVitestInvocation(
      createVitestInvocation(["validation-lease.test.mjs"]),
      () => child,
      signalHost,
      lifecycle.authority,
    );
    signalHost.emit("SIGTERM");
    assert.deepEqual(lifecycle.signals, []);
    lifecycle.setInspectionError(false);
    lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
    child.emit("close", 1, null);
    assert.deepEqual(await result, { code: 1, signal: "SIGTERM" });
  }
});

test("a signal during deadline teardown is republished only after join", async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  const signalHost = new EventEmitter();
  signalHost.platform = "darwin";
  const lifecycle = createLifecycleHarness();
  lifecycle.setObservation({ groupAbsent: false, leader: "same" });
  const result = executeVitestInvocation(
    createVitestInvocation(["validation-lease.test.mjs"]),
    () => child,
    signalHost,
    lifecycle.authority,
  );
  await lifecycle.advanceTo(
    childLifecycleBounds.hardMilliseconds -
      childLifecycleBounds.teardownMilliseconds,
  );
  signalHost.emit("SIGHUP");
  lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
  child.emit("close", null, "SIGTERM");
  assert.deepEqual(await result, { code: 1, signal: "SIGHUP" });
});

test("the original hard deadline creates no second containment window", async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  const lifecycle = createLifecycleHarness();
  lifecycle.setObservation({ groupAbsent: false, leader: "same" });
  const result = executeVitestInvocation(
    createVitestInvocation(["validation-lease.test.mjs"]),
    () => child,
    process,
    lifecycle.authority,
  );
  const rejected = assert.rejects(result, /execution deadline exceeded/);
  await lifecycle.advanceTo(childLifecycleBounds.hardMilliseconds);
  await rejected;
  assert.deepEqual(lifecycle.signals, ["SIGTERM", "SIGKILL"]);
});

test("group inspection uncertainty reaches the same hard deadline and admits nothing later", async () => {
  const inventory = [
    "code-quality-policy.test.mjs",
    "validation-lease.test.mjs",
  ];
  const plan = createWorkspacePolicyPlan(
    inventory,
    classifyWorkspacePolicyInventory(inventory),
  );
  const child = new EventEmitter();
  child.pid = 4242;
  const lifecycle = createLifecycleHarness();
  lifecycle.setInspectionError(true);
  const calls = [];
  const result = runWorkspacePolicyPlan(plan, async (invocation) => {
    calls.push(invocation.arguments.at(-1).split("/").at(-1));
    return executeVitestInvocation(
      invocation,
      () => child,
      process,
      lifecycle.authority,
    );
  });
  const rejected = assert.rejects(
    result,
    /process-group inspection uncertainty/,
  );
  child.emit("close", 1, null);
  await lifecycle.fireAt(childLifecycleBounds.hardMilliseconds);
  await rejected;
  assert.deepEqual(calls, ["code-quality-policy.test.mjs"]);
  assert.deepEqual(lifecycle.signals, []);
});

test("the executable boundary preserves exit or terminating signal", () => {
  const exitHost = { exitCode: undefined, kill: assert.fail, pid: 42 };
  publishTerminalOutcome({ code: 73, signal: undefined }, exitHost);
  assert.equal(exitHost.exitCode, 73);

  const signals = [];
  const signalHost = {
    exitCode: undefined,
    kill: (pid, signal) => signals.push([pid, signal]),
    pid: 42,
  };
  publishTerminalOutcome({ code: 1, signal: "SIGTERM" }, signalHost);
  assert.deepEqual(signals, [[42, "SIGTERM"]]);
  assert.equal(signalHost.exitCode, undefined);
});

test("caller arguments and empty child batches are rejected", async () => {
  assert.throws(() => createVitestInvocation([]), /requires at least one/);
  assert.throws(
    () => createVitestInvocation(["acceptance-evidence.test.mjs"], 0),
    /positive worker ceiling/,
  );
  await assert.rejects(main(["--retry"]), /caller arguments are not accepted/);
});
