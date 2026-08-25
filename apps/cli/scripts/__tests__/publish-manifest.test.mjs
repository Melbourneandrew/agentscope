import assert from "node:assert/strict";
import { test } from "vitest";

import { createPublishManifest } from "../publish-manifest.mjs";

test("preserves public native runtime dependencies", () => {
  assert.deepEqual(
    createPublishManifest({
      dependencies: { "better-sqlite3": "12.4.1" },
      devDependencies: { esbuild: "0.28.2" },
      name: "agentscope-cli",
      version: "0.1.0",
    }),
    {
      dependencies: { "better-sqlite3": "12.4.1" },
      name: "agentscope-cli",
      version: "0.1.0",
    },
  );
});

test("rejects private and workspace runtime dependencies", () => {
  assert.throws(
    () =>
      createPublishManifest({
        dependencies: { "@agentscope/core": "1.0.0" },
      }),
    /Private runtime dependency/u,
  );
  assert.throws(
    () =>
      createPublishManifest({ dependencies: { package: "workspace:\u002a" } }),
    /Workspace runtime dependency/u,
  );
});
