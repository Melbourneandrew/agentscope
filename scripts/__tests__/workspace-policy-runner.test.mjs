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
  inspectionFailureStages,
  main,
  parseDarwinBirthProbeForTesting,
  processAuthorityFiles,
  publishTerminalOutcome,
  purePolicyFiles,
  requiredPolicyFiles,
  runInternalVitestChild,
  runWorkspacePolicyPlan,
  validateWorkspacePolicyInventory,
} from "../workspace-policy-runner.mjs";

const workspaceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("Darwin birth evidence distinguishes exact ESRCH absence", () => {
  assert.equal(parseDarwinBirthProbeForTesting("absent\n", 4242), undefined);
  assert.equal(parseDarwinBirthProbeForTesting("unavailable\n", 4242), null);
  assert.deepEqual(
    parseDarwinBirthProbeForTesting("4242:4242:1700000000:123456\n", 4242),
    { processGroup: 4242, startIdentity: "1700000000:123456" },
  );
  for (const output of [
    "absent",
    " absent\n",
    "missing\n",
    "unavailable",
    "4243:4242:1700000000:123456\n",
    "4242:4242:1700000000:123456\nextra\n",
  ])
    assert.throws(
      () => parseDarwinBirthProbeForTesting(output, 4242),
      /malformed process birth record/,
    );
});

function createLifecycleHarness() {
  let now = 0;
  let observation = { groupAbsent: true, leader: "absent", memberCount: 0 };
  let inspectError = false;
  let signalError = false;
  let signalResult = "sent";
  let signalHook;
  let inspectionDuration = 0;
  const deadlines = [];
  const inspections = [];
  const signals = [];
  const timers = [];
  const authority = {
    capture(pid, _platform, hardDeadline) {
      assert.equal(pid, 4242);
      deadlines.push(hardDeadline);
      return Object.freeze({ pid, startIdentity: "start-1" });
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
    inspect(identity, _platform, hardDeadline) {
      assert.deepEqual(identity, { pid: 4242, startIdentity: "start-1" });
      deadlines.push(hardDeadline);
      inspections.push(identity);
      if (inspectError) {
        if (typeof inspectError === "object") throw inspectError;
        const error = new Error("synthetic secret must not escape");
        if (typeof inspectError === "string")
          Object.defineProperty(error, "inspectionStage", {
            value: inspectError,
          });
        throw error;
      }
      now += inspectionDuration;
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
      signalHook?.(signal);
      return signalResult;
    },
  };
  return {
    activeTimerCount() {
      return timers.filter((item) => !item.cleared).length;
    },
    authority,
    deadlines,
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
    setInspectionDuration(value) {
      inspectionDuration = value;
    },
    setObservation(value) {
      observation = {
        ...value,
        memberCount:
          value.memberCount ??
          (value.groupAbsent ? 0 : value.leader === "same" ? 1 : 1),
      };
    },
    setNow(value) {
      now = value;
    },
    setSignalError(value) {
      signalError = value;
    },
    setSignalResult(value) {
      signalResult = value;
    },
    setSignalHook(value) {
      signalHook = value;
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
  const withoutReserved = inventory.filter(
    (name) => name !== "prepush.test.mjs",
  );
  const withReserved = [...withoutReserved, "prepush.test.mjs"].sort();
  assert.equal(
    validateWorkspacePolicyInventory(withoutReserved),
    withoutReserved,
  );
  assert.equal(validateWorkspacePolicyInventory(withReserved), withReserved);
  assert.equal(withReserved.length, withoutReserved.length + 1);
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
      files: invocation.files,
      workers: String(invocation.workerCeiling),
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
    const name = invocation.files.at(-1);
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
    calls.push(invocation.files);
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
    starts.push(invocation.files.at(-1));
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
  assert.equal(
    invocation.arguments[0],
    resolve(workspaceRoot, "scripts/workspace-policy-runner.mjs"),
  );
  assert.equal(invocation.arguments[1], "--internal-workspace-policy-child");
  assert.equal(invocation.arguments[2], "1");
  assert.deepEqual(invocation.files, ["validation-lease.test.mjs"]);

  const child = new EventEmitter();
  child.pid = 4242;
  const lifecycle = createLifecycleHarness();
  lifecycle.setObservation({
    groupAbsent: false,
    leader: "same",
    memberCount: 1,
  });
  let options;
  const result = executeVitestInvocation(
    invocation,
    (executable, arguments_, value) => {
      assert.equal(executable, process.execPath);
      assert.deepEqual(arguments_, invocation.arguments);
      options = value;
      queueMicrotask(() =>
        child.emit("message", { code: 0, kind: "direct-terminal" }),
      );
      return child;
    },
    process,
    lifecycle.authority,
  );
  await Promise.resolve();
  assert.deepEqual(lifecycle.signals, ["SIGTERM"]);
  await lifecycle.fireAt(childLifecycleBounds.signalGraceMilliseconds);
  assert.deepEqual(lifecycle.signals, ["SIGTERM", "SIGKILL"]);
  lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
  child.emit("close", 1, "SIGKILL");
  assert.deepEqual(await result, { code: 0, signal: undefined });
  assert.equal(options.shell, false);
  assert.equal(options.cwd, workspaceRoot);
  assert.equal(options.env.NODE_OPTIONS, undefined);
  assert.equal(options.env.AGENTSCOPE_VALIDATION_LEASE_TOKEN, undefined);
});

test("TERM gets its minimum grace before authenticated KILL inspection", async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  const lifecycle = createLifecycleHarness();
  lifecycle.setObservation({ groupAbsent: false, leader: "same" });
  lifecycle.setInspectionDuration(40);
  const result = executeVitestInvocation(
    createVitestInvocation(["validation-lease.test.mjs"]),
    () => child,
    process,
    lifecycle.authority,
  );
  child.emit("message", { code: 0, kind: "direct-terminal" });
  assert.deepEqual(lifecycle.signals, ["SIGTERM"]);
  await lifecycle.advanceTo(
    40 + childLifecycleBounds.signalGraceMilliseconds - 1,
  );
  assert.deepEqual(lifecycle.signals, ["SIGTERM"]);
  await lifecycle.advanceTo(40 + childLifecycleBounds.signalGraceMilliseconds);
  assert.deepEqual(lifecycle.signals, ["SIGTERM", "SIGKILL"]);
  assert.ok(
    lifecycle.deadlines.includes(childLifecycleBounds.hardMilliseconds),
  );
  lifecycle.setInspectionDuration(0);
  lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
  child.emit("close", 1, "SIGKILL");
  assert.deepEqual(await result, { code: 0, signal: undefined });
});

test("a delayed KILL identity probe may use the existing teardown reserve", async () => {
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
  child.emit("message", { code: 0, kind: "direct-terminal" });
  lifecycle.setInspectionDuration(
    childLifecycleBounds.signalGraceMilliseconds + 1,
  );
  await lifecycle.fireAt(childLifecycleBounds.signalGraceMilliseconds);
  assert.deepEqual(lifecycle.signals, ["SIGTERM", "SIGKILL"]);
  lifecycle.setInspectionDuration(0);
  lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
  child.emit("close", 1, "SIGKILL");
  assert.deepEqual(await result, { code: 0, signal: undefined });
});

test("a delayed TERM probe preserves grace and fresh KILL authentication", async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  const lifecycle = createLifecycleHarness();
  lifecycle.setObservation({ groupAbsent: false, leader: "same" });
  lifecycle.setInspectionDuration(
    childLifecycleBounds.teardownMilliseconds -
      childLifecycleBounds.signalGraceMilliseconds -
      childLifecycleBounds.inspectionMilliseconds,
  );
  lifecycle.setSignalHook((signal) => {
    if (signal === "SIGTERM" || signal === "SIGKILL")
      lifecycle.setInspectionDuration(0);
  });
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
  const termSentAt =
    childLifecycleBounds.hardMilliseconds -
    childLifecycleBounds.signalGraceMilliseconds -
    childLifecycleBounds.inspectionMilliseconds;
  lifecycle.setInspectionDuration(childLifecycleBounds.inspectionMilliseconds);
  await lifecycle.fireAt(
    termSentAt + childLifecycleBounds.signalGraceMilliseconds,
  );
  assert.deepEqual(lifecycle.signals, ["SIGTERM", "SIGKILL"]);
  lifecycle.setInspectionDuration(0);
  lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
  child.emit("close", 1, "SIGKILL");
  await rejected;
});

test("KILL authentication at the original deadline is the inclusive boundary", async () => {
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
  child.emit("message", { code: 0, kind: "direct-terminal" });
  lifecycle.setInspectionDuration(
    childLifecycleBounds.hardMilliseconds -
      childLifecycleBounds.signalGraceMilliseconds,
  );
  await lifecycle.fireAt(childLifecycleBounds.signalGraceMilliseconds);
  assert.deepEqual(lifecycle.signals, ["SIGTERM", "SIGKILL"]);
  const rejected = assert.rejects(result, /terminal containment uncertainty/);
  await lifecycle.fireAt(childLifecycleBounds.hardMilliseconds);
  await rejected;
});

test("KILL authentication beyond the original deadline remains uncertainty", async () => {
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
  child.emit("message", { code: 0, kind: "direct-terminal" });
  lifecycle.setInspectionDuration(
    childLifecycleBounds.hardMilliseconds -
      childLifecycleBounds.signalGraceMilliseconds +
      1,
  );
  await lifecycle.fireAt(childLifecycleBounds.signalGraceMilliseconds);
  assert.deepEqual(lifecycle.signals, ["SIGTERM"]);
  const rejected = assert.rejects(result, /terminal containment uncertainty/);
  await lifecycle.fireAt(childLifecycleBounds.hardMilliseconds);
  await rejected;
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

test("exact group absence before or during retirement is a safe terminal", async () => {
  for (const mode of ["before", "during"]) {
    const child = new EventEmitter();
    child.pid = 4242;
    const lifecycle = createLifecycleHarness();
    lifecycle.setObservation({
      groupAbsent: mode === "before",
      leader: mode === "before" ? "absent" : "same",
    });
    if (mode === "during") lifecycle.setSignalResult("absent");
    const result = executeVitestInvocation(
      createVitestInvocation(["validation-lease.test.mjs"]),
      () => child,
      process,
      lifecycle.authority,
    );
    child.emit("message", { code: 0, kind: "direct-terminal" });
    lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
    child.emit("close", 0, null);
    assert.deepEqual(await result, { code: 0, signal: undefined });
    assert.deepEqual(lifecycle.signals, mode === "before" ? [] : ["SIGTERM"]);
  }
});

test("the wrapper protocol preserves other platform terminal signals", async () => {
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
  child.emit("message", {
    code: 1,
    kind: "direct-terminal",
    signal: "SIGKILL",
  });
  await lifecycle.advanceTo(childLifecycleBounds.signalGraceMilliseconds);
  lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
  child.emit("close", 1, "SIGKILL");
  assert.deepEqual(await result, { code: 1, signal: "SIGKILL" });
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
  const rejected = assert.rejects(result, /process-group signal uncertainty/);
  void result.catch(() => {
    settled = true;
  });
  signalHost.emit("SIGTERM");
  await new Promise((resolveReady) => setImmediate(resolveReady));
  assert.equal(settled, false);
  lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
  child.emit("close", null, "SIGKILL");
  await rejected;
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
      childLifecycleBounds.teardownMilliseconds +
      childLifecycleBounds.signalGraceMilliseconds,
  );
  assert.deepEqual(lifecycle.signals, ["SIGTERM", "SIGKILL"]);
  lifecycle.setObservation({
    groupAbsent: false,
    leader: "same",
    memberCount: 2,
  });
  lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
  child.emit("close", null, "SIGKILL");
  await rejected;
  assert.ok(lifecycle.deadlines.length > 2);
  assert.ok(
    lifecycle.deadlines.every(
      (deadline) =>
        deadline === childLifecycleBounds.hardMilliseconds ||
        deadline ===
          childLifecycleBounds.hardMilliseconds -
            childLifecycleBounds.signalGraceMilliseconds -
            childLifecycleBounds.inspectionMilliseconds,
    ),
  );
});

test("a persistent wrapper contains a TERM-ignoring descendant with one poll chain", async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.send = assert.fail;
  const signalHost = new EventEmitter();
  signalHost.platform = "darwin";
  const lifecycle = createLifecycleHarness();
  lifecycle.setObservation({
    groupAbsent: false,
    leader: "same",
    memberCount: 2,
  });
  const result = executeVitestInvocation(
    createVitestInvocation(["validation-lease.test.mjs"]),
    () => child,
    signalHost,
    lifecycle.authority,
  );
  signalHost.emit("SIGTERM");
  child.emit("message", { code: 0, kind: "direct-terminal" });
  assert.deepEqual(lifecycle.signals, ["SIGTERM"]);
  await lifecycle.advanceTo(childLifecycleBounds.signalGraceMilliseconds);
  assert.deepEqual(lifecycle.signals, ["SIGTERM", "SIGKILL"]);
  lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
  child.emit("close", 1, "SIGKILL");
  assert.deepEqual(await result, { code: 1, signal: "SIGTERM" });
  assert.equal(lifecycle.activeTimerCount(), 0);
});

test("successful KILL retirement tolerates leader exit until exact group absence", async () => {
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
  child.emit("message", { code: 0, kind: "direct-terminal" });
  await lifecycle.advanceTo(childLifecycleBounds.signalGraceMilliseconds);
  assert.deepEqual(lifecycle.signals, ["SIGTERM", "SIGKILL"]);
  lifecycle.setObservation({ groupAbsent: false, leader: "absent" });
  await lifecycle.advanceTo(
    childLifecycleBounds.signalGraceMilliseconds +
      childLifecycleBounds.pollMilliseconds,
  );
  let terminal = false;
  void result.then(() => {
    terminal = true;
  });
  await Promise.resolve();
  assert.equal(terminal, false);
  lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
  child.emit("close", 1, "SIGKILL");
  assert.deepEqual(await result, { code: 0, signal: undefined });
});

test("post-KILL birth unavailability remains poll-only until exact group absence", async () => {
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
  child.emit("message", { code: 0, kind: "direct-terminal" });
  await lifecycle.advanceTo(childLifecycleBounds.signalGraceMilliseconds);
  assert.deepEqual(lifecycle.signals, ["SIGTERM", "SIGKILL"]);
  lifecycle.setObservation({ groupAbsent: false, leader: "unavailable" });
  await lifecycle.advanceTo(
    childLifecycleBounds.signalGraceMilliseconds +
      childLifecycleBounds.pollMilliseconds,
  );
  assert.deepEqual(lifecycle.signals, ["SIGTERM", "SIGKILL"]);
  lifecycle.setObservation({ groupAbsent: true, leader: "unavailable" });
  child.emit("close", 1, "SIGKILL");
  assert.deepEqual(await result, { code: 0, signal: undefined });
});

test("birth unavailability before KILL is uncertainty and starts no signal", async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  const signalHost = new EventEmitter();
  signalHost.platform = "darwin";
  const lifecycle = createLifecycleHarness();
  lifecycle.setObservation({ groupAbsent: false, leader: "unavailable" });
  const result = executeVitestInvocation(
    createVitestInvocation(["validation-lease.test.mjs"]),
    () => child,
    signalHost,
    lifecycle.authority,
  );
  signalHost.emit("SIGTERM");
  assert.deepEqual(lifecycle.signals, []);
  lifecycle.setObservation({ groupAbsent: true, leader: "unavailable" });
  child.emit("close", 1, null);
  await assert.rejects(
    result,
    /process birth unavailable before group retirement/,
  );
});

test("post-KILL birth unavailability never becomes absence authority", async () => {
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
  child.emit("message", { code: 0, kind: "direct-terminal" });
  await lifecycle.advanceTo(childLifecycleBounds.signalGraceMilliseconds);
  lifecycle.setObservation({ groupAbsent: false, leader: "unavailable" });
  const rejected = assert.rejects(result, /terminal containment uncertainty/);
  await lifecycle.fireAt(childLifecycleBounds.hardMilliseconds);
  await rejected;
  assert.deepEqual(lifecycle.signals, ["SIGTERM", "SIGKILL"]);
});

test("an absent then reused group is never signaled", async () => {
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
  signalHost.emit("SIGTERM");
  assert.deepEqual(lifecycle.signals, ["SIGTERM"]);
  lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
  await lifecycle.advanceTo(childLifecycleBounds.pollMilliseconds);
  lifecycle.setObservation({ groupAbsent: false, leader: "same" });
  await lifecycle.advanceTo(childLifecycleBounds.signalGraceMilliseconds);
  assert.deepEqual(lifecycle.signals, ["SIGTERM"]);
  const rejected = assert.rejects(result, /terminal containment uncertainty/);
  await lifecycle.fireAt(childLifecycleBounds.hardMilliseconds);
  await rejected;
});

test("leader loss permanently revokes a still-present group", async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  const signalHost = new EventEmitter();
  signalHost.platform = "darwin";
  const lifecycle = createLifecycleHarness();
  lifecycle.setObservation({ groupAbsent: false, leader: "same" });
  const calls = [];
  const plan = createWorkspacePolicyPlan(
    ["code-quality-policy.test.mjs", "validation-lease.test.mjs"],
    classifyWorkspacePolicyInventory([
      "code-quality-policy.test.mjs",
      "validation-lease.test.mjs",
    ]),
  );
  const result = runWorkspacePolicyPlan(plan, (invocation) => {
    calls.push(invocation.files.at(-1));
    return executeVitestInvocation(
      invocation,
      () => child,
      signalHost,
      lifecycle.authority,
    );
  });
  signalHost.emit("SIGTERM");
  lifecycle.setObservation({ groupAbsent: false, leader: "absent" });
  await lifecycle.advanceTo(childLifecycleBounds.pollMilliseconds);
  lifecycle.setObservation({ groupAbsent: false, leader: "same" });
  await lifecycle.advanceTo(childLifecycleBounds.signalGraceMilliseconds);
  assert.deepEqual(lifecycle.signals, ["SIGTERM"]);
  lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
  child.emit("close", 1, null);
  await assert.rejects(result, /wrapper identity lost before group retirement/);
  assert.deepEqual(calls, ["code-quality-policy.test.mjs"]);
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
  const rejected = assert.rejects(first, /wrapper terminal uncertainty/);
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
    await assert.rejects(
      result,
      mode === "mismatch"
        ? /process identity mismatch/
        : /process-group inspection uncertainty/,
    );
  }
});

test("inspection failures expose only the closed content-free stage", async () => {
  assert.deepEqual(inspectionFailureStages, [
    "birth-probe-exit",
    "birth-probe-parse",
    "deadline-after",
    "deadline-before",
    "group-existence",
    "leader-existence",
    "observation-shape",
    "unknown",
  ]);
  for (const expectedStage of inspectionFailureStages) {
    const child = new EventEmitter();
    child.pid = 4242;
    const signalHost = new EventEmitter();
    signalHost.platform = "darwin";
    const lifecycle = createLifecycleHarness();
    lifecycle.setInspectionError(
      expectedStage === "unknown" ? true : expectedStage,
    );
    const result = executeVitestInvocation(
      createVitestInvocation(["validation-lease.test.mjs"]),
      () => child,
      signalHost,
      lifecycle.authority,
    );
    signalHost.emit("SIGTERM");
    lifecycle.setInspectionError(false);
    lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
    child.emit("close", 1, null);
    let failure;
    try {
      await result;
      assert.fail("inspection uncertainty must reject");
    } catch (error) {
      failure = error;
    }
    assert.equal(
      failure.message,
      `workspace-policy child containment failed: process-group inspection uncertainty: ${expectedStage}`,
    );
    assert.ok(!failure.message.includes("synthetic secret"));
    assert.deepEqual(lifecycle.signals, []);
  }
});

test("hostile inspection-stage carriers map to unknown without observation", async () => {
  let getterReads = 0;
  const hostileErrors = [
    Object.defineProperty(new Error("raw canary"), "inspectionStage", {
      get() {
        getterReads += 1;
        return getterReads === 1 ? "group-existence" : "RAW_CANARY";
      },
    }),
    new Proxy(new Error("proxy canary"), {
      getOwnPropertyDescriptor() {
        throw new Error("PROXY_CANARY");
      },
    }),
  ];
  for (const hostileError of hostileErrors) {
    const child = new EventEmitter();
    child.pid = 4242;
    const signalHost = new EventEmitter();
    signalHost.platform = "darwin";
    const lifecycle = createLifecycleHarness();
    lifecycle.setInspectionError(hostileError);
    const result = executeVitestInvocation(
      createVitestInvocation(["validation-lease.test.mjs"]),
      () => child,
      signalHost,
      lifecycle.authority,
    );
    signalHost.emit("SIGTERM");
    lifecycle.setInspectionError(false);
    lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
    child.emit("close", 1, null);
    await assert.rejects(
      result,
      (error) =>
        error.message ===
        "workspace-policy child containment failed: process-group inspection uncertainty: unknown",
    );
  }
  assert.equal(getterReads, 0);
});

test("post-inspection deadline crossing reports deadline-after", async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  const signalHost = new EventEmitter();
  signalHost.platform = "darwin";
  const lifecycle = createLifecycleHarness();
  lifecycle.setObservation({ groupAbsent: false, leader: "same" });
  lifecycle.setInspectionDuration(childLifecycleBounds.hardMilliseconds + 1);
  const result = executeVitestInvocation(
    createVitestInvocation(["validation-lease.test.mjs"]),
    () => child,
    signalHost,
    lifecycle.authority,
  );
  signalHost.emit("SIGTERM");
  lifecycle.setInspectionDuration(0);
  lifecycle.setNow(0);
  lifecycle.setObservation({ groupAbsent: true, leader: "absent" });
  child.emit("close", 1, null);
  await assert.rejects(
    result,
    /process-group inspection uncertainty: deadline-after/,
  );
  assert.deepEqual(lifecycle.signals, []);
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
  const rejected = assert.rejects(result, /terminal containment uncertainty/);
  await lifecycle.advanceTo(childLifecycleBounds.hardMilliseconds);
  await rejected;
  assert.deepEqual(lifecycle.signals, ["SIGTERM", "SIGKILL"]);
});

test("hard-boundary uncertainty revokes IPC and detaches without later admission", async () => {
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
  child.connected = true;
  let disconnects = 0;
  let unrefs = 0;
  child.disconnect = () => {
    disconnects += 1;
    child.connected = false;
  };
  child.unref = () => {
    unrefs += 1;
  };
  const lifecycle = createLifecycleHarness();
  lifecycle.setObservation({ groupAbsent: false, leader: "absent" });
  const calls = [];
  const result = runWorkspacePolicyPlan(plan, (invocation) => {
    calls.push(invocation.files.at(-1));
    return executeVitestInvocation(
      invocation,
      () => child,
      process,
      lifecycle.authority,
    );
  });
  await lifecycle.fireAt(childLifecycleBounds.hardMilliseconds);
  await assert.rejects(result, /terminal containment uncertainty/);
  assert.equal(disconnects, 1);
  assert.equal(unrefs, 1);
  assert.deepEqual(calls, ["code-quality-policy.test.mjs"]);
  assert.deepEqual(lifecycle.signals, []);
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
    calls.push(invocation.files.at(-1));
    return executeVitestInvocation(
      invocation,
      () => child,
      process,
      lifecycle.authority,
    );
  });
  const rejected = assert.rejects(result, /terminal containment uncertainty/);
  await lifecycle.fireAt(childLifecycleBounds.hardMilliseconds);
  await rejected;
  assert.deepEqual(calls, ["code-quality-policy.test.mjs"]);
  assert.deepEqual(lifecycle.signals, []);
});

test("the internal wrapper validates grammar and holds terminal publication for release", async () => {
  for (const direct of [
    { code: 0, signal: null },
    { code: 73, signal: null },
    { code: null, signal: "SIGTERM" },
  ]) {
    const host = new EventEmitter();
    host.connected = true;
    host.pid = 4242;
    host.send = (message) => host.sent.push(message);
    host.kill = assert.fail;
    host.sent = [];
    const child = new EventEmitter();
    let options;
    const result = runInternalVitestChild(
      ["--internal-workspace-policy-child", "1", "validation-lease.test.mjs"],
      (executable, arguments_, value) => {
        assert.equal(executable, process.execPath);
        assert.equal(arguments_[0], realpathSync(arguments_[0]));
        assert.equal(arguments_[1], "run");
        assert.ok(arguments_.at(-1).endsWith("validation-lease.test.mjs"));
        options = value;
        return child;
      },
      host,
    );
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    host.emit("SIGTERM");
    child.emit("close", direct.code, direct.signal);
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(host.listenerCount("SIGTERM"), 1);
    assert.deepEqual(host.sent, [
      {
        code: direct.code ?? 1,
        kind: "direct-terminal",
        ...(direct.signal === null ? {} : { signal: direct.signal }),
      },
    ]);
    host.emit("message", { kind: "release" });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(options.detached, false);
    assert.equal(options.shell, false);
    assert.equal(host.listenerCount("SIGTERM"), 1);
  }

  assert.throws(
    () =>
      runInternalVitestChild([
        "--internal-workspace-policy-child",
        "2",
        "validation-lease.test.mjs",
      ]),
    /internal child classification is invalid/,
  );
  assert.throws(
    () =>
      runInternalVitestChild([
        "--internal-workspace-policy-child",
        "1",
        "unknown.test.mjs",
      ]),
    /internal child classification is invalid/,
  );
  assert.throws(
    () =>
      runInternalVitestChild(
        ["--internal-workspace-policy-child", "1", "validation-lease.test.mjs"],
        assert.fail,
        { connected: false },
      ),
    /authenticated parent channel/,
  );
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
