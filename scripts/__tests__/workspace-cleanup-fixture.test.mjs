import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

const source = readFileSync(
  new URL("../fixtures/workspace-cleanup-fixture.mjs", import.meta.url),
  "utf8",
);
const body = source
  .slice(source.indexOf("export function "))
  .replace("export ", "");

function exerciseSetup({
  failureStage,
  substituted = false,
  removalFailure = false,
}) {
  const primary = new Error("seeded setup failure");
  const settlement = new Error("seeded removal failure");
  const root = "/owned-private-fixture";
  let mkdirCount = 0;
  let removed = false;
  let rootInspections = 0;
  const identity = { dev: 1, ino: 2, mode: 0o40700, isDirectory: () => true };
  const create = Function(
    "assert",
    "join",
    "performance",
    "tmpdir",
    "mkdtempSync",
    "lstatSync",
    "mkdirSync",
    "readFileSync",
    "writeFileSync",
    "readdirSync",
    "rmSync",
    `${body}; return createWorkspaceCleanupFixture;`,
  )(
    assert,
    join,
    { now: () => 100 },
    () => "/private",
    () => root,
    () => ({ ...identity, ino: substituted && ++rootInspections > 1 ? 3 : 2 }),
    () => {
      if (++mkdirCount === failureStage) throw primary;
    },
    () => {
      if (failureStage === "read") throw primary;
      return "source";
    },
    () => {
      if (failureStage === "write") throw primary;
    },
    () => [],
    (path) => {
      assert.equal(path, root);
      if (removalFailure) throw settlement;
      removed = true;
    },
  );
  let caught;
  try {
    create("/repository");
  } catch (error) {
    caught = error;
  }
  return { caught, primary, settlement, removed };
}

for (const failureStage of [1, 2, "read", "write"]) {
  test(`setup failure at ${failureStage} rolls back authenticated root and preserves primary`, () => {
    const result = exerciseSetup({ failureStage });
    assert.equal(result.caught, result.primary);
    assert.equal(result.removed, true);
  });
}

for (const condition of ["substituted", "removalFailure"]) {
  test(`setup rollback retains ambiguous root on ${condition}`, () => {
    const result = exerciseSetup({ failureStage: "read", [condition]: true });
    assert.ok(result.caught instanceof AggregateError);
    assert.equal(result.caught.cause, result.primary);
    assert.equal(result.caught.errors[0], result.primary);
    assert.equal(result.removed, false);
    if (condition === "removalFailure")
      assert.equal(result.caught.errors[1], result.settlement);
    else assert.match(result.caught.errors[1].message, /root identity changed/);
  });
}
