import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "vitest";

import { auditCoreFinalizationImports } from "../restricted-import-policy.mjs";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-import-policy-"));
  const packages = new Map([
    ["packages/core", "@agentscope/core"],
    ["packages/destination", "@agentscope/destination"],
  ]);
  for (const [path] of packages)
    mkdirSync(join(root, path), { recursive: true });
  return { root, packages };
};

test("permits the Core finalization entrypoint only inside Core", () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.root, "packages/core/static.ts"),
      'import { finalizeRedactedCanonicalTrace } from "@agentscope/protocol/core-finalization";\nvoid finalizeRedactedCanonicalTrace;\n',
    );
    auditCoreFinalizationImports(value.root, value.packages);
    for (const [extension, source] of [
      [
        "ts",
        'import { finalizeRedactedCanonicalTrace } from "@agentscope/protocol/core-finalization";',
      ],
      [
        "tsx",
        'const value = import("@agentscope/protocol/core-finalization");',
      ],
      [
        "cts",
        'const value = require("@agentscope/protocol/core-finalization");',
      ],
      [
        "mts",
        "const value = import(`@agentscope/protocol/core-finalization`);",
      ],
      [
        "jsx",
        "const value = require(`@agentscope/protocol/core-finalization`);",
      ],
    ]) {
      const path = join(
        value.root,
        `packages/destination/forbidden.${extension}`,
      );
      writeFileSync(path, `${source}\n`);
      assert.throws(
        () => auditCoreFinalizationImports(value.root, value.packages),
        /Core-only/,
      );
      rmSync(path);
    }
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("permits the provisional lifecycle sink entrypoint only inside Core", () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.root, "packages/core/sink.ts"),
      'import { invokeRedactedTraceSink } from "@agentscope/destinations-core/lifecycle-sink";\nvoid invokeRedactedTraceSink;\n',
    );
    auditCoreFinalizationImports(value.root, value.packages);
    for (const [extension, source] of [
      [
        "ts",
        'import { invokeRedactedTraceSink } from "@agentscope/destinations-core/lifecycle-sink";',
      ],
      [
        "mts",
        "const value = import(`@agentscope/destinations-core/lifecycle-sink`);",
      ],
      [
        "cts",
        'const value = require("@agentscope/destinations-core/lifecycle-sink");',
      ],
    ]) {
      const path = join(
        value.root,
        `packages/destination/forbidden-sink.${extension}`,
      );
      writeFileSync(path, `${source}\n`);
      assert.throws(
        () => auditCoreFinalizationImports(value.root, value.packages),
        /Core-only/,
      );
      rmSync(path);
    }
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
