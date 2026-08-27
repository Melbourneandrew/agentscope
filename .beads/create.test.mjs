import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireAllocationLock,
  canonicalIssueId,
  createSequentialIssue,
  humanIssueId,
  nextIssueNumber,
  parseArguments,
} from "./create.mjs";

function missingIssueError() {
  const error = new Error("missing");
  error.code = 1;
  error.stdout = JSON.stringify({ error: "no issues found matching the provided IDs", schema_version: 1 });
  return error;
}

test("converts between canonical and conversational issue IDs", () => {
  assert.equal(canonicalIssueId("release-007"), "agentscope-release-007");
  assert.equal(canonicalIssueId("agentscope-release-007"), "agentscope-release-007");
  assert.equal(canonicalIssueId("vah.11.1"), "vah.11.1");
  assert.equal(humanIssueId("agentscope-release-007"), "release-007");
  assert.equal(humanIssueId("external-1"), "external-1");
});

test("allocates after the highest exact workstream sequence", () => {
  assert.equal(
    nextIssueNumber(
      [
        { id: "agentscope-release-001" },
        { id: "agentscope-release-009" },
        { id: "agentscope-release-not-a-sequence" },
        { id: "agentscope-other-999" },
      ],
      "release",
    ),
    10,
  );
  assert.throws(() => nextIssueNumber([], "Bad"), /Workstream/);
});

test("creates with an explicit canonical ID and retries a preflight collision under the allocation lock", async () => {
  const calls = [];
  let released = false;
  const run = async (file, arguments_) => {
    calls.push([file, arguments_]);
    if (arguments_[0] === "list") return { stdout: JSON.stringify([{ id: "agentscope-beads-001" }]) };
    if (arguments_[0] === "show" && arguments_[1] === "agentscope-beads-002") {
      return { stdout: JSON.stringify([{ id: "agentscope-beads-002" }]) };
    }
    if (arguments_[0] === "show") throw missingIssueError();
    return { stdout: "agentscope-beads-003\n" };
  };
  const created = await createSequentialIssue({
    workstream: "beads",
    title: "Build helper",
    arguments_: ["--parent", "release-001", "--deps=blocks:claude-002,related:agentscope-old"],
    run,
    lock: async () => async () => {
      released = true;
    },
  });
  assert.equal(created, "beads-003");
  assert.equal(released, true);
  assert.deepEqual(calls.at(-1)[1], [
    "create",
    "--title",
    "Build helper",
    "--id",
    "agentscope-beads-003",
    "--silent",
    "--parent",
    "agentscope-release-001",
    "--deps=blocks:agentscope-claude-002,related:agentscope-old",
  ]);
});

test("does not hide a non-collision create failure", async () => {
  const failure = new Error("permission denied");
  const run = async (_file, arguments_) => {
    if (arguments_[0] === "list") return { stdout: "[]" };
    if (arguments_[0] === "create") throw failure;
    throw missingIssueError();
  };
  await assert.rejects(
    () => createSequentialIssue({ workstream: "beads", title: "Nope", run, lock: async () => async () => {} }),
    (error) => error === failure,
  );
});

test("serializes concurrent workstream allocation through the canonical Beads workspace", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentscope-beads-create-"));
  const issues = [];
  let concurrentCreates = 0;
  let maximumConcurrentCreates = 0;
  const run = async (_file, arguments_) => {
    if (arguments_[0] === "where") return { stdout: JSON.stringify({ path: directory }) };
    if (arguments_[0] === "list") return { stdout: JSON.stringify(issues) };
    if (arguments_[0] === "show") {
      const issue = issues.find((item) => item.id === arguments_[1]);
      if (!issue) throw missingIssueError();
      return { stdout: JSON.stringify([issue]) };
    }
    concurrentCreates += 1;
    maximumConcurrentCreates = Math.max(maximumConcurrentCreates, concurrentCreates);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const id = arguments_[arguments_.indexOf("--id") + 1];
    issues.push({ id });
    concurrentCreates -= 1;
    return { stdout: `${id}\n` };
  };
  try {
    const created = await Promise.all([
      createSequentialIssue({ workstream: "beads", title: "One", run }),
      createSequentialIssue({ workstream: "beads", title: "Two", run }),
    ]);
    assert.deepEqual(created.sort(), ["beads-001", "beads-002"]);
    assert.equal(maximumConcurrentCreates, 1);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("rejects helper-owned bd flags and malformed CLI input", async () => {
  assert.throws(() => parseArguments([]), /Usage/);
  await assert.rejects(
    () =>
      createSequentialIssue({
        workstream: "beads",
        title: "Nope",
        arguments_: ["--id=custom"],
        lock: async () => async () => {},
      }),
    /owns --id/,
  );
  for (const argument of ["--db=/tmp/other", "-C/tmp/other", "--global", "--repo=other"]) {
    await assert.rejects(
      () => createSequentialIssue({
        workstream: "beads",
        title: "Nope",
        arguments_: [argument],
        lock: async () => async () => {},
      }),
      /creation helper owns/,
    );
  }
});

test("fails closed when candidate absence is not exact authoritative JSON", async () => {
  for (const failure of [
    Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("malformed"), { code: 1, stdout: "{" }),
    Object.assign(new Error("wrong shape"), { code: 1, stdout: JSON.stringify({ error: "different", schema_version: 1 }) }),
  ]) {
    const calls = [];
    const run = async (_file, arguments_) => {
      calls.push(arguments_[0]);
      if (arguments_[0] === "list") return { stdout: "[]" };
      if (arguments_[0] === "show") throw failure;
      throw new Error("create must not run");
    };
    await assert.rejects(
      () => createSequentialIssue({ workstream: "beads", title: "Nope", run, lock: async () => async () => {} }),
      /Unable to prove/,
    );
    assert.deepEqual(calls, ["list", "show"]);
  }
});

test("passes flag-like titles only as the owned title option value", async () => {
  const calls = [];
  const run = async (_file, arguments_) => {
    calls.push(arguments_);
    if (arguments_[0] === "list") return { stdout: "[]" };
    if (arguments_[0] === "show") throw missingIssueError();
    return { stdout: "agentscope-beads-001\n" };
  };
  await createSequentialIssue({ workstream: "beads", title: "--dry-run", run, lock: async () => async () => {} });
  assert.deepEqual(calls.at(-1).slice(0, 4), ["create", "--title", "--dry-run", "--id"]);
});

test("reconciles an authenticated released lock without deleting live ownership", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentscope-beads-lock-"));
  const run = async (_file, arguments_) => {
    if (arguments_[0] === "where") return { stdout: JSON.stringify({ path: directory }) };
    throw new Error("unexpected bd command");
  };
  try {
    const releaseFirst = await acquireAllocationLock(run, async () => {});
    let acquiredSecond = false;
    const second = acquireAllocationLock(run, async () => {}).then((release) => {
      acquiredSecond = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(acquiredSecond, false);
    await releaseFirst();
    const releaseSecond = await second;
    assert.equal(acquiredSecond, true);
    await releaseSecond();
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("recovers an exact stale lock after abrupt allocator death", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentscope-beads-crash-"));
  const moduleUrl = new URL("./create.mjs", import.meta.url).href;
  const childSource = `
    import { acquireAllocationLock } from ${JSON.stringify(moduleUrl)};
    const run = async (_file, args) => {
      if (args[0] === "where") return { stdout: JSON.stringify({ path: ${JSON.stringify(directory)} }) };
      throw new Error("unexpected command");
    };
    await acquireAllocationLock(run);
    process.stdout.write("LOCKED\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once("data", (chunk) => chunk.toString().includes("LOCKED") ? resolve() : reject(new Error("no lock")));
      child.once("error", reject);
      child.once("exit", (code) => code === null || reject(new Error(`allocator exited ${code}`)));
    });
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));
    const run = async (_file, arguments_) => {
      if (arguments_[0] === "where") return { stdout: JSON.stringify({ path: directory }) };
      throw new Error("unexpected command");
    };
    const release = await acquireAllocationLock(run, async () => {});
    await release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true });
  }
});
