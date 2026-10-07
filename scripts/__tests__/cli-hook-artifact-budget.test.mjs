import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "vitest";

const source = readFileSync(
  new URL("../../apps/cli/verify-artifact.mjs", import.meta.url),
  "utf8",
);
const declarations = source.match(
  /^const hookMachineArtifactByteLimit = [\d_]+;$/gmu,
);
assert.equal(declarations?.length, 1);
const assertions = source.match(
  /assert\.ok\(\s*lstatSync\(machineEntryPath\)\.size <= hookMachineArtifactByteLimit,\s*"the installed hook machine must retain its bounded cold-start artifact",\s*\);/gu,
);
assert.equal(assertions?.length, 1);
const snippet = `${declarations[0]}\n${assertions[0]}`;

const verifySize = (size) => {
  let reads = 0;
  runInNewContext(
    snippet,
    {
      assert,
      machineEntryPath: "owned-fixture",
      lstatSync(path) {
        assert.equal(path, "owned-fixture");
        reads += 1;
        return { size };
      },
    },
    { timeout: 100 },
  );
  assert.equal(reads, 1);
};

test("the actual installed hook assertion admits its declared finite boundary", () => {
  assert.equal(
    declarations[0],
    "const hookMachineArtifactByteLimit = 1_610_000;",
  );
  verifySize(1_600_765);
  verifySize(1_610_000);
});

test("the actual installed hook assertion rejects one byte beyond its boundary", () => {
  assert.throws(
    () => verifySize(1_610_001),
    /the installed hook machine must retain its bounded cold-start artifact/u,
  );
});
