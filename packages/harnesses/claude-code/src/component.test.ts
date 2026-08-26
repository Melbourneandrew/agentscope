import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditNativeFixtureInventory,
  createHarnessContractSuite,
  deriveHarnessComponentEvidenceDigest,
  serializeHarnessSanitizedFixture,
} from "@agentscope/harnesses-core/testing";

import {
  CLAUDE_CODE_COMPONENT_VERSION,
  CLAUDE_CODE_EVIDENCE_SLOT,
  claudeCodeDescriptor,
} from "./descriptor.js";
import {
  CLAUDE_CODE_DOCUMENTED_INTERFACES,
  CLAUDE_CODE_INTERNAL_AUTH_SENTINEL,
  createClaudeCodeExecutionEnvironment,
} from "./execution.js";
import { claudeCodeFixture } from "./fixture.js";
import { claudeCodeComponentAdapter, claudeCodeScenario } from "./component.js";
import { claudeCodeHarnessPackageId } from "./index.js";
import { claudeCodeContextEvidence } from "./mapping.js";

const fixturePath = resolve(
  import.meta.dirname,
  "../fixtures/native/claude-code-lifecycle-v1.json",
);
const harnessPackagesRoot = resolve(import.meta.dirname, "../..");

describe("Claude Code component contract", () => {
  it("binds the exact descriptor, representative, and component-only evidence", () => {
    expect(claudeCodeHarnessPackageId).toBe("@agentscope/harness-claude-code");
    expect(claudeCodeDescriptor.executable).toEqual({
      names: ["claude"],
      versionArguments: ["--version"],
      versionPrefix: "",
      versionSuffix: " (Claude Code)",
    });
    expect(claudeCodeDescriptor.configuration.locationSegments).toEqual([
      [".claude", "settings.json"],
    ]);
    expect(claudeCodeDescriptor.compatibility).toEqual([
      {
        minimumInclusive: CLAUDE_CODE_COMPONENT_VERSION,
        maximumExclusive: "2.1.246",
        evidenceSlot: CLAUDE_CODE_EVIDENCE_SLOT,
      },
    ]);
    expect(claudeCodeComponentAdapter.componentEvidence.componentDigest).toBe(
      deriveHarnessComponentEvidenceDigest(
        claudeCodeFixture,
        claudeCodeScenario,
        claudeCodeDescriptor,
        claudeCodeContextEvidence,
      ),
    );
    expect(
      claudeCodeComponentAdapter.componentEvidence.componentDigest,
    ).toMatch(/^component-sha256-[a-f0-9]{64}$/u);
    expect(
      "realScenarioDigest" in claudeCodeComponentAdapter.componentEvidence,
    ).toBe(false);
  });

  it("passes every shared component contract case", async () => {
    const cases = createHarnessContractSuite(claudeCodeComponentAdapter);
    expect(cases).toHaveLength(5);
    for (const contractCase of cases) await contractCase.run();
  });

  it("keeps the checked-in fixture canonical and physically auditable", async () => {
    const text = await readFile(fixturePath, "utf8");
    expect(text).toBe(serializeHarnessSanitizedFixture(claudeCodeFixture));
    const inventory = await auditNativeFixtureInventory(harnessPackagesRoot);
    expect(inventory).toEqual([
      expect.objectContaining({
        harnessId: "claude-code",
        fixtureId: "claude-code-lifecycle-v1",
        harnessVersion: CLAUDE_CODE_COMPONENT_VERSION,
        relativePath:
          "claude-code/fixtures/native/claude-code-lifecycle-v1.json",
        artifactAuthority: "unresolved",
      }),
    ]);
  });

  it("routes only to an explicit internal endpoint with the governed sentinel", () => {
    expect(CLAUDE_CODE_DOCUMENTED_INTERFACES).toEqual([
      { mode: "interactive", outputContract: "semantic-pty" },
      { mode: "print", outputContract: "text" },
      { mode: "print", outputContract: "json" },
      { mode: "print", outputContract: "stream-json" },
    ]);
    expect(
      createClaudeCodeExecutionEnvironment(
        "http://model-mock.agentscope.internal:8080",
      ),
    ).toEqual({
      ANTHROPIC_AUTH_TOKEN: CLAUDE_CODE_INTERNAL_AUTH_SENTINEL,
      ANTHROPIC_BASE_URL: "http://model-mock.agentscope.internal:8080",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      DISABLE_UPDATES: "1",
    });
    for (const endpoint of [
      "https://api.anthropic.com",
      "http://example.com",
      "http://user:pass@localhost",
      "http://localhost/path",
      "http://localhost?mode=test",
      "http://localhost#section",
      "not-a-url",
    ])
      expect(() => createClaudeCodeExecutionEnvironment(endpoint)).toThrow(
        "claude-code.execution.internal-endpoint",
      );
  });
});
