import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  capabilityManifestIdentity,
  compileCapabilityManifest,
  partitionCapabilityScenarios,
  selectCapabilityScenarios,
  verifyManifestEvidence,
  type CapabilityManifest,
} from "./manifest.js";

const integrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestFixture = (): CapabilityManifest =>
  JSON.parse(
    readFileSync(resolve(integrationRoot, "capability-manifest.json"), "utf8"),
  ) as CapabilityManifest;

const withIdentity = (
  value: Omit<CapabilityManifest, "manifestIdentity">,
): CapabilityManifest => ({
  ...value,
  manifestIdentity: capabilityManifestIdentity(value),
});

describe("integration capability manifest", () => {
  it("compiles the committed manifest and verifies descriptor evidence", () => {
    const compiled = compileCapabilityManifest(manifestFixture());
    verifyManifestEvidence(compiled, integrationRoot);
    expect(compiled.manifestIdentity).toMatch(/^sha256-[a-f\d]{64}$/u);
    expect(Object.isFrozen(compiled.scenarios[0])).toBe(true);
  });

  it("rejects identity, duplicate, reference, and coverage drift", () => {
    const original = manifestFixture();
    expect(() =>
      compileCapabilityManifest({
        ...original,
        manifestIdentity: "sha256-" + "0".repeat(64),
      }),
    ).toThrow("integration.manifest.identity");
    for (const mutated of [
      withIdentity({
        ...original,
        evidence: [...original.evidence, original.evidence[0]!],
      }),
      withIdentity({
        ...original,
        scenarios: [...original.scenarios, original.scenarios[0]!],
      }),
      withIdentity({
        ...original,
        requiredRepresentativeIds: ["uncovered-evidence"],
      }),
      withIdentity({
        ...original,
        scenarios: [
          { ...original.scenarios[0]!, harnessEvidenceId: "unknown-evidence" },
        ],
      }),
    ])
      expect(() => compileCapabilityManifest(mutated)).toThrow(
        /integration\.manifest/u,
      );
  });

  it("rejects malformed and unpinned entries", () => {
    const original = manifestFixture();
    expect(() => compileCapabilityManifest(null)).toThrow(
      "integration.manifest.invalid",
    );
    expect(() =>
      compileCapabilityManifest({
        ...original,
        scenarios: [{ ...original.scenarios[0]!, image: "node:22-alpine" }],
      }),
    ).toThrow("integration.manifest.invalid");
  });

  it("detects descriptor evidence mutation", () => {
    const original = manifestFixture();
    const evidencePath = resolve(
      integrationRoot,
      original.evidence[0]!.descriptorArtifact.path,
    );
    const bytes = readFileSync(evidencePath);
    try {
      writeFileSync(evidencePath, `${bytes.toString("utf8")}\n`);
      expect(() => {
        verifyManifestEvidence(original, integrationRoot);
      }).toThrow("integration.manifest.evidence-digest");
    } finally {
      writeFileSync(evidencePath, bytes);
    }
  });

  it("detects scenario adapter mutation", () => {
    const original = manifestFixture();
    const adapterPath = resolve(
      integrationRoot,
      original.scenarios[0]!.fixtureAdapter.path,
    );
    const bytes = readFileSync(adapterPath);
    try {
      writeFileSync(adapterPath, `${bytes.toString("utf8")}\n`);
      expect(() => {
        verifyManifestEvidence(original, integrationRoot);
      }).toThrow("integration.manifest.evidence-digest");
    } finally {
      writeFileSync(adapterPath, bytes);
    }
  });

  it("rejects descriptor evidence that contradicts its manifest binding", () => {
    const original = manifestFixture();
    const evidencePath = resolve(
      integrationRoot,
      original.evidence[0]!.descriptorArtifact.path,
    );
    const bytes = readFileSync(evidencePath);
    try {
      const descriptor = JSON.parse(bytes.toString("utf8")) as {
        harnessId: string;
      };
      descriptor.harnessId = "other-harness";
      const mutated = `${JSON.stringify(descriptor, undefined, 2)}\n`;
      writeFileSync(evidencePath, mutated);
      const manifest = structuredClone(original);
      manifest.evidence[0]!.descriptorArtifact.sha256 = createHash("sha256")
        .update(mutated)
        .digest("hex");
      expect(() => {
        verifyManifestEvidence(manifest, integrationRoot);
      }).toThrow("integration.manifest.evidence-contract");
    } finally {
      writeFileSync(evidencePath, bytes);
    }
  });
});

describe("integration capability selection", () => {
  it("selects by harness, tag, scenario, and deterministic weighted shard", () => {
    const original = manifestFixture();
    const second = {
      ...original.scenarios[0]!,
      scenarioId: "fixture-process-regression",
      tags: ["nightly"],
      shardWeight: 200,
    };
    const third = {
      ...original.scenarios[0]!,
      scenarioId: "fixture-process-small",
      tags: ["nightly"],
      shardWeight: 50,
    };
    const compiled = compileCapabilityManifest(
      withIdentity({
        ...original,
        scenarios: [third, original.scenarios[0]!, second],
      }),
    );
    expect(selectCapabilityScenarios(compiled, { tag: "smoke" })).toHaveLength(
      1,
    );
    expect(
      selectCapabilityScenarios(compiled, { harnessId: "fixture-process" }),
    ).toHaveLength(3);
    expect(
      selectCapabilityScenarios(compiled, {
        scenarioId: "fixture-process-regression",
      })[0]?.scenarioId,
    ).toBe("fixture-process-regression");
    const shards = partitionCapabilityScenarios(compiled.scenarios, 2);
    expect(
      shards.map((shard) => shard.map(({ scenarioId }) => scenarioId)),
    ).toEqual([
      ["fixture-process-regression"],
      ["fixture-process-small", "fixture-process-smoke"],
    ]);
    expect(
      selectCapabilityScenarios(compiled, { shard: { index: 1, total: 2 } }),
    ).toEqual(shards[1]);
  });

  it("rejects empty and hostile selectors and invalid shards", () => {
    const compiled = compileCapabilityManifest(manifestFixture());
    expect(() =>
      selectCapabilityScenarios(compiled, { tag: "missing" }),
    ).toThrow("integration.manifest.selection-empty");
    expect(() =>
      selectCapabilityScenarios(compiled, { unexpected: true } as never),
    ).toThrow("integration.manifest.selector");
    for (const shard of [
      { index: -1, total: 1 },
      { index: 1, total: 1 },
      { index: 0, total: 2 },
    ])
      expect(() => selectCapabilityScenarios(compiled, { shard })).toThrow(
        "integration.manifest.shard",
      );
  });
});
