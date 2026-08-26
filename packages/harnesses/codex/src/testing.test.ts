import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createOwnedHarnessHookInvocation,
  type HarnessTargetInspection,
} from "@agentscope/harnesses-core";
import {
  auditNativeFixtureInventory,
  createHarnessContractSuite,
  serializeHarnessSanitizedFixture,
} from "@agentscope/harnesses-core/testing";
import { describe, expect, it } from "vitest";

import * as productionRoot from "./index.js";
import {
  codexComponentContractAdapter,
  codexComponentEvidence,
  codexSanitizedFixture,
} from "./testing.js";
import { createCodexInstallationPlanner } from "./installation.js";

const encoder = new TextEncoder();
const governedOverlap = JSON.stringify({
  hooks: Object.fromEntries(
    ["SessionStart", "Stop", "SessionEnd"].map((event) => [
      event,
      [
        {
          ...(event === "SessionStart"
            ? { matcher: "startup|resume|clear" }
            : {}),
          hooks: [
            {
              type: "command",
              command: "'/vendor/bin/observability-hook'",
              timeout: 3,
              statusMessage: "Vendor observability",
            },
          ],
        },
      ],
    ]),
  ),
});

const genuineTarget = (text: string): HarnessTargetInspection => ({
  targetPath: "/isolated/.codex/hooks.json",
  exists: true,
  bytes: encoder.encode(text),
  digest: "0".repeat(64),
  mode: 0o600,
});

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

  it("keeps the test adapter and scenario out of the production root", () => {
    expect(productionRoot).not.toHaveProperty("codexComponentContractAdapter");
    expect(productionRoot).not.toHaveProperty("codexComponentScenario");
    expect(productionRoot).not.toHaveProperty("codexSanitizedFixture");
  });
});

describe("Codex shared component contract", () => {
  it("delegates genuine Codex targets unchanged to the production planner", () => {
    const invocation = createOwnedHarnessHookInvocation({
      agentscopeHome: "/opt/agentscope",
      harnessType: codexComponentContractAdapter.descriptor.harnessType,
      hookDeadlineMilliseconds: 2_000,
      platform: "posix",
    });
    const target = genuineTarget('{"hooks":{}}');

    for (const operation of ["install", "migrate", "uninstall"] as const) {
      expect(
        codexComponentContractAdapter.createInstallationPlanner(
          operation,
          invocation,
        )(target),
      ).toEqual(createCodexInstallationPlanner(operation, invocation)(target));
    }

    const hostile: HarnessTargetInspection = {
      ...target,
      bytes: new Uint8Array([0xff]),
    };
    expect(
      codexComponentContractAdapter.createInstallationPlanner(
        "install",
        invocation,
      )(hostile),
    ).toEqual(createCodexInstallationPlanner("install", invocation)(hostile));
  });

  it("translates the suite tag to genuine Codex overlap before planning", () => {
    const invocation = createOwnedHarnessHookInvocation({
      agentscopeHome: "/opt/agentscope",
      harnessType: codexComponentContractAdapter.descriptor.harnessType,
      hookDeadlineMilliseconds: 2_000,
      platform: "posix",
    });
    const tag = genuineTarget("vendor-observability-hook");
    const native = genuineTarget(governedOverlap);

    for (const operation of ["install", "migrate", "uninstall"] as const) {
      expect(
        codexComponentContractAdapter.createInstallationPlanner(
          operation,
          invocation,
        )(tag),
      ).toEqual(createCodexInstallationPlanner(operation, invocation)(native));
    }
  });

  for (const contractCase of createHarnessContractSuite(
    codexComponentContractAdapter,
  )) {
    it(contractCase.name, async () => {
      await contractCase.run();
    });
  }
});
