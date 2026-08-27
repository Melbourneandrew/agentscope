import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalIssueId,
  createSequentialIssue,
  humanIssueId,
  nextIssueNumber,
  parseArguments,
} from "./create.mjs";

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
    if (arguments_[0] === "show") throw new Error("missing");
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
    throw new Error("missing");
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
      if (!issue) throw new Error("missing");
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
});
