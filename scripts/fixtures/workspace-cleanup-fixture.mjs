import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

// A finite test fixture, not a process-set or production cleanup authority.
export function createWorkspaceCleanupFixture(repositoryRoot) {
  const deadline = performance.now() + 5000;
  const root = mkdtempSync(join(tmpdir(), "agentscope-clean-identity-"));
  const identity = lstatSync(root);
  const workspaceDirectory = join(root, "packages/protocol");
  const cleaner = join(root, "scripts/clean-workspace.mjs");
  function cleanup() {
    const current = lstatSync(root);
    assert.ok(
      current.isDirectory() &&
        current.dev === identity.dev &&
        current.ino === identity.ino &&
        current.mode === identity.mode,
      "cleanup fixture root identity changed",
    );
    let count = 0;
    let bytes = 0;
    function inspect(directory) {
      for (const name of readdirSync(directory)) {
        assert.ok(++count <= 32, "cleanup fixture member bound");
        const path = join(directory, name);
        const stat = lstatSync(path);
        if (stat.isDirectory()) inspect(path);
        else {
          assert.ok(
            stat.isFile() || stat.isSymbolicLink(),
            "cleanup fixture member type",
          );
          bytes += stat.size;
          assert.ok(bytes <= 64 * 1024, "cleanup fixture byte bound");
        }
      }
    }
    inspect(root);
    rmSync(root, { recursive: true });
  }
  try {
    mkdirSync(workspaceDirectory, { recursive: true });
    mkdirSync(join(root, "scripts"));
    writeFileSync(
      cleaner,
      readFileSync(join(repositoryRoot, "scripts/clean-workspace.mjs")),
    );
    writeFileSync(
      join(root, "scripts/workspace-packages.mjs"),
      'export const expectedWorkspacePackages = new Map([["packages/protocol", "@agentscope/protocol"]]);\n',
    );
  } catch (primary) {
    let rollbackFailed = false;
    let rollbackFailure;
    try {
      cleanup();
    } catch (settlement) {
      rollbackFailed = true;
      rollbackFailure = settlement;
    }
    if (rollbackFailed)
      throw new AggregateError(
        [primary, rollbackFailure],
        "cleanup fixture setup rollback failed",
        { cause: primary },
      );
    throw primary;
  }
  return {
    root,
    workspaceDirectory,
    cleaner,
    replacementPreload(moved, external) {
      const preload = join(root, "replace-parent.cjs");
      writeFileSync(
        preload,
        `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const originalRmSync = fs.rmSync;
const originalDirectory = process.cwd();
let replaced = false;
fs.rmSync = function (target, options) {
  if (!replaced) {
    replaced = true;
    fs.renameSync(originalDirectory, ${JSON.stringify(moved)});
    fs.symlinkSync(${JSON.stringify(external)}, originalDirectory, "dir");
  }
  return Reflect.apply(originalRmSync, this, [target, options]);
};
syncBuiltinESMExports();
`,
      );
      return preload;
    },
    childOptions(extra = {}) {
      const timeout = Math.floor(deadline - performance.now());
      assert.ok(timeout > 0, "cleanup fixture deadline");
      return {
        ...extra,
        cwd: workspaceDirectory,
        encoding: "utf8",
        timeout,
        maxBuffer: 64 * 1024,
        killSignal: "SIGKILL",
      };
    },
    cleanup,
  };
}
