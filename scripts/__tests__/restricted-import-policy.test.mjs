import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "vitest";

import { auditCoreFinalizationImports } from "../restricted-import-policy.mjs";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-import-policy-"));
  const packages = new Map([
    ["apps/cli", "agentscope-cli"],
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

test("permits configuration, hook, and harness authority only inside the CLI", () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.root, "apps/cli/configuration.ts"),
      'import { initializeAgentscopeConfiguration } from "@agentscope/core/configuration-management";\nimport { createHookEntryAuthority } from "@agentscope/core/hook-orchestration";\nimport { prepareCoreRetrievalRuntime } from "@agentscope/core/retrieval-orchestration";\nimport { inspectHarnessInstallation } from "@agentscope/harnesses-core/cli-management";\nvoid initializeAgentscopeConfiguration;\nvoid createHookEntryAuthority;\nvoid prepareCoreRetrievalRuntime;\nvoid inspectHarnessInstallation;\n',
    );
    auditCoreFinalizationImports(value.root, value.packages);
    for (const [packagePath, specifier] of [
      ["packages/core", "@agentscope/core/configuration-management"],
      ["packages/destination", "@agentscope/core/hook-orchestration"],
      ["packages/core", "@agentscope/core/retrieval-orchestration"],
      ["packages/destination", "@agentscope/core/retrieval-orchestration"],
      ["packages/destination", "@agentscope/harnesses-core/cli-management"],
    ]) {
      const forbidden = join(value.root, packagePath, "configuration.ts");
      writeFileSync(forbidden, `import "${specifier}";\n`);
      assert.throws(
        () => auditCoreFinalizationImports(value.root, value.packages),
        /CLI-only/u,
      );
      rmSync(forbidden);
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
    const testingEntrypointDirectory = join(
      value.root,
      "packages/destination/src",
    );
    mkdirSync(testingEntrypointDirectory, { recursive: true });
    writeFileSync(
      join(testingEntrypointDirectory, "testing.ts"),
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
      ["langfuse-testing", "@agentscope/destination-langfuse/testing"],
      ["local-sqlite-testing", "@agentscope/destination-local-sqlite/testing"],
      ["destination-testing", "@agentscope/destinations-core/testing"],
      ["harness-testing", "@agentscope/harnesses-core/testing"],
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

test("rejects computed module loads from production sources", () => {
  const value = fixture();
  try {
    const production = join(value.root, "packages/core/computed.ts");
    for (const moduleLoad of [
      "import(moduleName)",
      "import/*comment*/(moduleName)",
      "require(moduleName)",
    ]) {
      writeFileSync(
        production,
        `const moduleName = "@agentscope/" + "protocol/testing";\nvoid ${moduleLoad};\n`,
      );
      assert.throws(
        () => auditCoreFinalizationImports(value.root, value.packages),
        /computed module load/u,
      );
    }
    writeFileSync(
      production,
      'void import("@agentscope/protocol");\nvoid require(`node:fs`);\n',
    );
    auditCoreFinalizationImports(value.root, value.packages);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("excludes only the verified Local SQLite native candidate closure", () => {
  const value = fixture();
  const packagePath = "packages/destinations/local-sqlite";
  value.packages.set(packagePath, "@agentscope/destination-local-sqlite");
  try {
    const candidate = join(
      value.root,
      packagePath,
      "native-candidate/files/runtime",
    );
    mkdirSync(candidate, { recursive: true });
    writeFileSync(
      join(candidate, "runtime.cjs"),
      'const moduleName = "native-binding"; module.exports = require(moduleName);\n',
    );
    const tooling = join(value.root, packagePath, "native-candidate/tooling");
    mkdirSync(tooling, { recursive: true });
    writeFileSync(
      join(tooling, "guest-driver.cjs"),
      'process.stdout.write("bounded evidence");\n',
    );
    auditCoreFinalizationImports(value.root, value.packages);
    writeFileSync(
      join(tooling, "guest-driver.cjs"),
      'const moduleName = "native-binding"; module.exports = require(moduleName);\n',
    );
    assert.throws(
      () => auditCoreFinalizationImports(value.root, value.packages),
      /computed module load/u,
    );
    writeFileSync(
      join(tooling, "guest-driver.cjs"),
      'process.stdout.write("bounded evidence");\n',
    );

    const production = join(value.root, packagePath, "src/runtime.cjs");
    mkdirSync(join(value.root, packagePath, "src"), { recursive: true });
    writeFileSync(
      production,
      'const moduleName = "native-binding"; module.exports = require(moduleName);\n',
    );
    assert.throws(
      () => auditCoreFinalizationImports(value.root, value.packages),
      /computed module load/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("permits exactly one production Agentscope home authority", () => {
  const value = fixture();
  try {
    const authorityDirectory = join(
      value.root,
      "packages/core/src/configuration",
    );
    mkdirSync(authorityDirectory, { recursive: true });
    writeFileSync(
      join(authorityDirectory, "home.ts"),
      'import { homedir } from "node:os";\nconst name = "AGENTSCOPE_HOME";\nvoid homedir; void name;\n',
    );
    auditCoreFinalizationImports(value.root, value.packages);
    const production = join(value.root, "packages/core/other.ts");
    for (const source of [
      'import { homedir } from "node:os";\nvoid homedir;\n',
      "const value = process.env.HOME;\nvoid value;\n",
      'const value = process.env["USERPROFILE"];\nvoid value;\n',
      'const value = "AGENTSCOPE_HOME";\nvoid value;\n',
    ]) {
      writeFileSync(production, source);
      assert.throws(
        () => auditCoreFinalizationImports(value.root, value.packages),
        /home must be injected/u,
      );
    }
    rmSync(production);
    writeFileSync(
      join(value.root, "packages/core/other.test.ts"),
      'const value = "AGENTSCOPE_HOME";\nvoid value;\n',
    );
    auditCoreFinalizationImports(value.root, value.packages);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects escaped test-only module specifiers", () => {
  const value = fixture();
  try {
    const production = join(value.root, "packages/core/escaped.ts");
    for (const source of [
      'import "@agentscope/protocol/test\\u0069ng";\n',
      'import fixture = require("@agentscope/protocol/test\\u0069ng");\n',
      'void import("@agentscope/protocol/test\\u0069ng");\n',
      'void require("@agentscope/destinations-core/test\\u0069ng");\n',
    ]) {
      writeFileSync(production, source);
      assert.throws(
        () => auditCoreFinalizationImports(value.root, value.packages),
        /test-only/u,
      );
    }
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("checks artifact literals while permitting computed artifact loads", () => {
  const value = fixture();
  try {
    const verifier = join(
      value.root,
      "packages/destination/verify-artifact.mjs",
    );
    writeFileSync(
      verifier,
      'const moduleName = "node:" + "fs";\nvoid import(moduleName);\n',
    );
    auditCoreFinalizationImports(value.root, value.packages);
    writeFileSync(
      verifier,
      'void import("@agentscope/protocol/test\\u0069ng");\n',
    );
    assert.throws(
      () => auditCoreFinalizationImports(value.root, value.packages),
      /test-only/u,
    );
    writeFileSync(
      verifier,
      'await import("./verify-production-composition.test.mjs");\n',
    );
    writeFileSync(
      join(
        value.root,
        "packages/destination/verify-production-composition.test.mjs",
      ),
      'import "@agentscope/destinations-core/testing";\n',
    );
    auditCoreFinalizationImports(value.root, value.packages);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects computed Core authority loads from tests and testkit", () => {
  const value = fixture();
  try {
    value.packages.set("packages/testkit", "@agentscope/testkit");
    mkdirSync(join(value.root, "packages/testkit"), { recursive: true });
    for (const path of [
      "packages/destination/authority.test.ts",
      "packages/testkit/authority.ts",
    ]) {
      const source = join(value.root, path);
      writeFileSync(
        source,
        'const moduleName = "@agentscope/protocol/" + "core-finalization";\nvoid import(moduleName);\n',
      );
      assert.throws(
        () => auditCoreFinalizationImports(value.root, value.packages),
        /computed module load/u,
      );
      rmSync(source);
    }
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("reserves terminal stream ownership for the CLI", () => {
  const value = fixture();
  try {
    const production = join(value.root, "packages/destination/output.ts");
    for (const source of [
      'process.stdout.write("unsafe");\n',
      'import { stderr } from "node:process";\nstderr.write("unsafe");\n',
      'const runtime = process;\nruntime["stdout"].write("unsafe");\n',
      'const { stderr: err } = globalThis.process;\nerr.write("unsafe");\n',
    ]) {
      writeFileSync(production, source);
      assert.throws(
        () => auditCoreFinalizationImports(value.root, value.packages),
        /streams are CLI-owned/u,
      );
    }
    rmSync(production);
    writeFileSync(
      join(value.root, "packages/destination/output.test.ts"),
      'process.stdout.write("test fixture");\n',
    );
    writeFileSync(
      join(value.root, "packages/destination/verify-artifact.mjs"),
      'process.stdout.write("verification result");\n',
    );
    auditCoreFinalizationImports(value.root, value.packages);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("permits only the owned Local SQLite child pipe entrypoint", () => {
  const value = fixture();
  const packagePath = "packages/destinations/local-sqlite";
  value.packages.set(packagePath, "@agentscope/destination-local-sqlite");
  try {
    const production = join(value.root, packagePath, "src/production");
    mkdirSync(production, { recursive: true });
    writeFileSync(
      join(production, "reporter-child.ts"),
      'process.stdout.write("bounded child protocol");\n',
    );
    auditCoreFinalizationImports(value.root, value.packages);
    writeFileSync(
      join(production, "other-child.ts"),
      'process.stdout.write("unsafe");\n',
    );
    assert.throws(
      () => auditCoreFinalizationImports(value.root, value.packages),
      /streams are CLI-owned/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
