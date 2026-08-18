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

test("permits destination orchestration authority only inside Core", () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.root, "packages/core/orchestration.ts"),
      'import { bindDestinationTransport } from "@agentscope/destinations-core/core-orchestration";\nvoid bindDestinationTransport;\n',
    );
    auditCoreFinalizationImports(value.root, value.packages);
    const forbidden = join(value.root, "packages/destination/orchestration.ts");
    writeFileSync(
      forbidden,
      'import { bindDestinationTransport } from "@agentscope/destinations-core/core-orchestration";\nvoid bindDestinationTransport;\n',
    );
    assert.throws(
      () => auditCoreFinalizationImports(value.root, value.packages),
      /Core-only/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("permits the destination testing entrypoint only in tests and testkit", () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.root, "packages/destination/adapter.test.ts"),
      'import { createDestinationTestAdapter } from "@agentscope/destinations-core/testing";\nvoid createDestinationTestAdapter;\n',
    );
    auditCoreFinalizationImports(value.root, value.packages);
    const production = join(
      value.root,
      "packages/destination/production-adapter.ts",
    );
    writeFileSync(
      production,
      'import { createDestinationTestAdapter } from "@agentscope/destinations-core/testing";\nvoid createDestinationTestAdapter;\n',
    );
    assert.throws(
      () => auditCoreFinalizationImports(value.root, value.packages),
      /test-only/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("permits the Protocol testing entrypoint only in tests and testkit", () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.root, "packages/destination/fixture.test.ts"),
      'import { createSanitizedCanonicalTraceFixture } from "@agentscope/protocol/testing";\nvoid createSanitizedCanonicalTraceFixture;\n',
    );
    auditCoreFinalizationImports(value.root, value.packages);
    const production = join(value.root, "packages/destination/fixture.ts");
    writeFileSync(
      production,
      'import { createSanitizedCanonicalTraceFixture } from "@agentscope/protocol/testing";\nvoid createSanitizedCanonicalTraceFixture;\n',
    );
    assert.throws(
      () => auditCoreFinalizationImports(value.root, value.packages),
      /test-only/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects testing entrypoints from Core production sources", () => {
  const value = fixture();
  try {
    for (const [name, specifier] of [
      ["destination-testing", "@agentscope/destinations-core/testing"],
      ["protocol-testing", "@agentscope/protocol/testing"],
    ]) {
      const production = join(value.root, `packages/core/${name}.ts`);
      writeFileSync(production, `import ${JSON.stringify(specifier)};\n`);
      assert.throws(
        () => auditCoreFinalizationImports(value.root, value.packages),
        /test-only/u,
      );
      rmSync(production);
    }
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects computed dynamic imports from production sources", () => {
  const value = fixture();
  try {
    const production = join(value.root, "packages/core/computed.ts");
    writeFileSync(
      production,
      'const moduleName = "@agentscope/" + "protocol/testing";\nvoid import(moduleName);\n',
    );
    assert.throws(
      () => auditCoreFinalizationImports(value.root, value.packages),
      /computed dynamic import/u,
    );
    writeFileSync(production, 'void import("@agentscope/protocol");\n');
    auditCoreFinalizationImports(value.root, value.packages);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
