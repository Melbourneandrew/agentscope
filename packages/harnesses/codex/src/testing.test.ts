import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  auditNativeFixtureInventory,
  createHarnessContractSuite,
  serializeHarnessSanitizedFixture,
} from "@agentscope/harnesses-core/testing";
import { describe, expect, it } from "vitest";

import {
  codexComponentContractAdapter,
  codexComponentEvidence,
  codexSanitizedFixture,
} from "./testing.js";

describe("Codex governed component fixture", () => {
  it("is serialized canonically from the governed fixture value", async () => {
    const fixturePath = resolve(
      import.meta.dirname,
      "../fixtures/native/codex-stop-v1.json",
    );
    expect(await readFile(fixturePath, "utf8")).toBe(
      serializeHarnessSanitizedFixture(codexSanitizedFixture),
    );
  });

  it("passes the physical-root no-follow inventory audit as unresolved synthetic evidence", async () => {
    const inventory = await auditNativeFixtureInventory(
      resolve(import.meta.dirname, "../.."),
    );
    expect(inventory).toContainEqual(
      expect.objectContaining({
        harnessId: "codex",
        fixtureId: "codex-stop-v1",
        harnessVersion: "0.149.1",
        relativePath: "codex/fixtures/native/codex-stop-v1.json",
        artifactAuthority: "unresolved",
      }),
    );
  });

  it("emits component evidence without actual-admission authority", () => {
    expect(codexComponentEvidence.componentDigest).toMatch(
      /^component-sha256-[a-f0-9]{64}$/u,
    );
    expect(codexComponentEvidence).not.toHaveProperty("realScenarioDigest");
    expect(codexComponentEvidence).not.toHaveProperty("supportManifest");
    expect(codexSanitizedFixture.governance.provenance).toEqual({
      captureKind: "synthetic",
      sourceReference: "urn:agentscope:synthetic:codex-stop-v1",
      artifactAuthority: {
        status: "unresolved",
        reason: "independent-integrity-unavailable",
      },
      captureRecipe: "codex-synthetic-stop-v1",
    });
  });
});

describe("Codex shared component contract", () => {
  for (const contractCase of createHarnessContractSuite(
    codexComponentContractAdapter,
  )) {
    it(contractCase.name, async () => {
      await contractCase.run();
    });
  }
});
