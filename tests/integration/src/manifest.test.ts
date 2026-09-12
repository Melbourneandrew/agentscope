import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createMockServerInitialization,
  MODEL_PROTOCOL_ROUTES,
} from "@agentscope/testkit";

import {
  capabilityScenarioImages,
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

// eslint-disable-next-line max-lines-per-function -- closed manifest boundary matrix
describe("integration capability manifest", () => {
  it("compiles the committed manifest and verifies descriptor evidence", () => {
    const compiled = compileCapabilityManifest(manifestFixture());
    verifyManifestEvidence(compiled, integrationRoot);
    expect(compiled.manifestIdentity).toMatch(/^sha256-[a-f\d]{64}$/u);
    expect(Object.isFrozen(compiled.scenarios[0])).toBe(true);
    const codex = compiled.evidence.find(
      ({ evidenceId }) => evidenceId === "codex-0-149-1",
    );
    expect(codex?.material.kind).toBe("npm");
    expect(codex?.admission).toBeUndefined();
  });

  it("keeps authenticated diagnostic material distinct from support admission", () => {
    const original = manifestFixture();
    const codex = original.evidence.find(
      ({ evidenceId }) => evidenceId === "codex-0-149-1",
    )!;
    expect(codex.material.kind).toBe("npm");
    expect(codex.admission).toBeUndefined();

    const fixture = original.evidence.find(
      ({ evidenceId }) => evidenceId === "fixture-process-v1",
    )!;
    expect(() =>
      compileCapabilityManifest(
        withIdentity({
          ...original,
          evidence: [{ ...fixture, admission: {} as never }],
          requiredRepresentativeIds: [fixture.evidenceId],
          scenarios: original.scenarios.filter(
            ({ harnessEvidenceId }) => harnessEvidenceId === fixture.evidenceId,
          ),
        }),
      ),
    ).toThrow("integration.manifest.invalid");
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

  it("detects scenario oracle mutation", () => {
    const original = manifestFixture();
    const oraclePath = resolve(
      integrationRoot,
      original.scenarios[0]!.scenarioOracle.path,
    );
    const bytes = readFileSync(oraclePath);
    try {
      writeFileSync(oraclePath, `${bytes.toString("utf8")}\n`);
      expect(() => {
        verifyManifestEvidence(original, integrationRoot);
      }).toThrow("integration.manifest.evidence-digest");
    } finally {
      writeFileSync(oraclePath, bytes);
    }
  });

  it("rejects substituted runtime artifact authority", () => {
    const original = manifestFixture();
    const scenario = original.scenarios.find(
      ({ scenarioId }) => scenarioId === "codex-tui-trace-smoke",
    );
    expect(scenario?.runtimeArtifacts).toHaveLength(2);
    const mutated = structuredClone(original);
    const selected = mutated.scenarios.find(
      ({ scenarioId }) => scenarioId === "codex-tui-trace-smoke",
    );
    selected!.runtimeArtifacts[0]!.sha256 = "0".repeat(64);
    expect(() => {
      verifyManifestEvidence(mutated, integrationRoot);
    }).toThrow("integration.manifest.evidence-digest");
  });

  it("selects mutually isolated MockServer expectations per scenario", () => {
    const manifest = manifestFixture();
    const initialization = createMockServerInitialization() as readonly {
      id: string;
    }[];
    const selectedIds = (scenarioId: string) => {
      const scenario = manifest.scenarios.find(
        (candidate) => candidate.scenarioId === scenarioId,
      );
      return scenario!.modelRoutes.map((routeId) => {
        const index = MODEL_PROTOCOL_ROUTES.findIndex(
          (route) => route.routeId === routeId,
        );
        expect(index).toBeGreaterThanOrEqual(0);
        return initialization[index]!.id;
      });
    };
    expect(selectedIds("codex-tui-trace-smoke")).toEqual([
      "codex-tui-responses",
    ]);
    expect(selectedIds("fixture-process-smoke")).not.toContain(
      "codex-tui-responses",
    );
  });

  it("prepares every selected scenario material verifier image", () => {
    const manifest = compileCapabilityManifest(manifestFixture());
    const codex = manifest.scenarios.find(
      ({ scenarioId }) => scenarioId === "codex-tui-trace-smoke",
    )!;
    const material = manifest.evidence.find(
      ({ evidenceId }) => evidenceId === codex.harnessEvidenceId,
    )!.material;
    expect(material.kind).toBe("npm");
    if (material.kind !== "npm") throw new Error("test.material");
    expect(capabilityScenarioImages(manifest, [codex.scenarioId])).toEqual(
      [codex.image, codex.mockServerImage, material.verifierImage].sort(),
    );
    for (const scenarioIds of [
      [],
      [codex.scenarioId, codex.scenarioId],
      ["missing"],
    ])
      expect(() => capabilityScenarioImages(manifest, scenarioIds)).toThrow(
        "integration.manifest.image-selection",
      );
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

describe("integration npm material policy", () => {
  it("detects scenario process mutation", () => {
    const original = manifestFixture();
    const processPath = resolve(
      integrationRoot,
      original.scenarios[0]!.scenarioProcess.path,
    );
    const bytes = readFileSync(processPath);
    try {
      writeFileSync(processPath, `${bytes.toString("utf8")}\n`);
      expect(() => {
        verifyManifestEvidence(original, integrationRoot);
      }).toThrow("integration.manifest.evidence-digest");
    } finally {
      writeFileSync(processPath, bytes);
    }
  });

  it("rejects moving or incomplete npm material", () => {
    const original = manifestFixture();
    expect(() =>
      compileCapabilityManifest({
        ...original,
        evidence: [
          {
            ...original.evidence[0]!,
            material: {
              kind: "npm",
              platformIdentity: `sha256-${"9".repeat(64)}`,
              verifierImage: `node@sha256:${"f".repeat(64)}`,
              registry: "https://registry.npmjs.org/",
              packages: [
                {
                  attestations: {
                    url: "https://registry.npmjs.org/-/npm/v1/attestations/@vendor%2fharness@1.0.0",
                    bytes: 1,
                    sha256: "f".repeat(64),
                  },
                  installName: "@vendor/harness",
                  packageName: "@vendor/harness",
                  version: "1.0.0",
                  tarballUrl: "https://registry.npmjs.org/latest.tgz",
                  bytes: 1,
                  integrity: "moving",
                  shasum: "0".repeat(40),
                },
              ],
              provenance: {
                repository: "https://github.com/vendor/harness",
                sourceCommit: "0".repeat(40),
                tag: "v1.0.0",
                workflowPath: ".github/workflows/release.yml",
              },
            },
          },
        ],
      }),
    ).toThrow("integration.manifest.invalid");
  });
});

describe("integration signed-manifest material policy", () => {
  const signedEvidence = (original: CapabilityManifest) => ({
    ...original.evidence[0]!,
    representativeVersion: "2.1.89",
    material: {
      kind: "signed-release-manifest" as const,
      distributionId: "vendor-tool",
      version: "2.1.89",
      platform: "linux-x64",
      platformIdentity: `sha256-${"9".repeat(64)}`,
      verifierImage: original.scenarios[0]!.image,
      binary: {
        url: "https://downloads.vendor.invalid/releases/2.1.89/linux-x64/tool",
        bytes: 1,
        sha256: "a".repeat(64),
        executableName: "tool",
      },
      manifest: {
        url: "https://downloads.vendor.invalid/releases/2.1.89/manifest.json",
        bytes: 1,
        sha256: "b".repeat(64),
      },
      signature: {
        url: "https://downloads.vendor.invalid/releases/2.1.89/manifest.json.sig",
        bytes: 1,
        sha256: "c".repeat(64),
      },
      signingKey: {
        url: "https://downloads.vendor.invalid/keys/release.asc",
        bytes: 1,
        sha256: "d".repeat(64),
        fingerprint: "A".repeat(40),
        signerFingerprint: "A".repeat(40),
        signatureHashAlgorithm: "sha512" as const,
        uid: "Vendor Release Signing <security@vendor.invalid>",
      },
    },
    admission: {
      evidenceSlot: "vendor-tool-v1",
      eligibleRange: {
        minimumInclusive: "2.1.89",
        maximumExclusive: "3.0.0",
      },
      distributionReference: "signed-manifest:vendor-tool@2.1.89#linux-x64",
      component: {
        fixture: {
          path: "packages/harnesses/codex/fixtures/native/a.json",
          sha256: "e".repeat(64),
        },
        adapterArtifact: {
          path: "packages/harnesses/codex/dist/index.js",
          sha256: "f".repeat(64),
        },
        mappingArtifact: {
          path: "packages/harnesses/codex/dist/mapping.js",
          sha256: "0".repeat(64),
        },
        componentEvidenceDigest: `component-sha256-${"1".repeat(64)}`,
      },
    },
  });

  it("compiles a harness-neutral exact-version signed release", () => {
    const original = manifestFixture();
    const evidence = signedEvidence(original);
    const scenario = original.scenarios.find(
      ({ harnessEvidenceId }) =>
        harnessEvidenceId === original.evidence[0]!.evidenceId,
    )!;
    const compiled = compileCapabilityManifest(
      withIdentity({
        ...original,
        evidence: [evidence],
        requiredRepresentativeIds: [evidence.evidenceId],
        scenarios: [scenario],
      }),
    );
    expect(compiled.evidence[0]?.material.kind).toBe("signed-release-manifest");
  });

  it("rejects origin and exact-version path substitution", () => {
    const original = manifestFixture();
    const evidence = signedEvidence(original);
    for (const manifestUrl of [
      "https://other.vendor.invalid/releases/2.1.89/manifest.json",
      "https://downloads.vendor.invalid/releases/latest/manifest.json",
    ])
      expect(() =>
        compileCapabilityManifest({
          ...original,
          evidence: [
            {
              ...evidence,
              material: {
                ...evidence.material,
                manifest: { ...evidence.material.manifest, url: manifestUrl },
              },
            },
          ],
        }),
      ).toThrow("integration.manifest.invalid");
  });
});

describe("integration capability execution modes", () => {
  it("rejects a headless/interactive output-contract mismatch", () => {
    const original = manifestFixture();
    expect(() =>
      compileCapabilityManifest({
        ...original,
        scenarios: [
          {
            ...original.scenarios[0]!,
            executionMode: "interactive",
            outputContract: "jsonl",
          },
        ],
      }),
    ).toThrow("integration.manifest.invalid");
  });
});

describe("integration capability selection", () => {
  it("selects by harness, tag, scenario, and deterministic weighted shard", () => {
    const original = manifestFixture();
    const fixtureEvidence = original.evidence.find(
      ({ evidenceId }) => evidenceId === "fixture-process-v1",
    )!;
    const fixtureScenario = original.scenarios.find(
      ({ scenarioId }) => scenarioId === "fixture-process-smoke",
    )!;
    const second = {
      ...fixtureScenario,
      scenarioId: "fixture-process-regression",
      tags: ["nightly"],
      shardWeight: 200,
    };
    const third = {
      ...fixtureScenario,
      scenarioId: "fixture-process-small",
      tags: ["nightly"],
      shardWeight: 50,
    };
    const compiled = compileCapabilityManifest(
      withIdentity({
        ...original,
        evidence: [fixtureEvidence],
        requiredRepresentativeIds: [fixtureEvidence.evidenceId],
        scenarios: [third, fixtureScenario, second],
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
      { index: 0, total: 4 },
    ])
      expect(() => selectCapabilityScenarios(compiled, { shard })).toThrow(
        "integration.manifest.shard",
      );
  });
});
