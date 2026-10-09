import { describe, expect, it } from "vitest";

import { sha256 } from "./canonical.js";
import {
  compileHarnessAdmissionCompletion,
  compileHarnessAdmissionSeed,
} from "./harness-scenario-admission.js";

const digest = (character: string): string => `sha256-${character.repeat(64)}`;
// Deliberate grammar-only unit input, never actual-capture admission evidence.
const componentFixture = (version = "1.2.3") => {
  const base = parseHarnessSanitizedFixture(
    JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          "../../../packages/harnesses/codex/fixtures/native/codex-stop-v1.json",
        ),
        "utf8",
      ),
    ),
  );
  return {
    ...base,
    harnessVersion: version,
    governance: {
      ...base.governance,
      provenance: {
        captureKind: "disposable-hermetic",
        sourceReference: "https://vendor.example/capture",
        captureRecipe: "unit-capture",
        artifactAuthority: { status: "authenticated", digest: digest("8") },
      },
      license: {
        redistribution: "reviewed-for-repository",
        reviewedLicenseId: "Apache-2.0",
        sourceReference: "https://vendor.example/license",
      },
      representative: {
        scenarioId: "codex-headless",
        representativeVersion: version,
        evidenceSlot: "codex-headless-v1",
      },
    },
  };
};
const fixture = () => ({
  componentFixture: componentFixture(),
  candidateDigest: digest("a"),
  destinationCombinationIdentity: digest("b"),
  evidence: {
    evidenceId: "codex-evidence",
    harnessId: "codex",
    harnessPackage: "@agentscope/harness-codex",
    representativeVersion: "1.2.3",
    descriptorArtifact: { path: "fixtures/codex.json", sha256: "1".repeat(64) },
    material: {
      kind: "npm" as const,
      platformIdentity: digest("9"),
      verifierImage: `node@sha256:${"a".repeat(64)}`,
      verifierNpmVersion: "11.19.1",
      registry: "https://registry.npmjs.org/" as const,
      packages: [
        {
          attestations: {
            url: "https://registry.npmjs.org/-/npm/v1/attestations/@vendor%2ftool@1.2.3",
            maximumBytes: 1,
            bundleDigest: "1".repeat(64),
          },
          installName: "@vendor/tool",
          packageName: "@vendor/tool",
          version: "1.2.3",
          tarballUrl:
            "https://registry.npmjs.org/@vendor/tool/-/tool-1.2.3.tgz",
          bytes: 1,
          integrity: `sha512-${"A".repeat(86)}==`,
          shasum: "0".repeat(40),
        },
      ],
      provenance: {
        repository: "https://github.com/vendor/tool",
        sourceCommit: "2".repeat(40),
        tag: "v1.2.3",
        workflowPath: ".github/workflows/release.yml",
      },
    },
    admission: {
      evidenceSlot: "codex-headless-v1",
      eligibleRange: { minimumInclusive: "1.0.0", maximumExclusive: "2.0.0" },
      distributionReference: "npm:@vendor/tool@1.2.3",
      component: {
        fixture: {
          path: "packages/harnesses/codex/fixtures/native/a.json",
          sha256: "3".repeat(64),
        },
        adapterArtifact: {
          path: "packages/harnesses/codex/dist/index.js",
          sha256: "4".repeat(64),
        },
        mappingArtifact: {
          path: "packages/harnesses/codex/dist/mapping.js",
          sha256: "5".repeat(64),
        },
        componentEvidenceDigest: `component-sha256-${"6".repeat(64)}`,
      },
    },
  },
  manifestIdentity: digest("7"),
  materialIdentity: digest("8"),
  platformIdentity: digest("9"),
  preparedImage: {
    image: `node@sha256:${"a".repeat(64)}`,
    manifestDigest: `sha256:${"b".repeat(64)}`,
    configDigest: `sha256:${"c".repeat(64)}`,
    platformIdentity: digest("9"),
    scenarioImageDigest: digest("a"),
  },
  runId: "0123456789abcdef",
  scenario: {
    scenarioId: "codex-headless",
    harnessEvidenceId: "codex-evidence",
    executionMode: "headless" as const,
    outputContract: "jsonl" as const,
    image: `node@sha256:${"a".repeat(64)}`,
    mockServerImage: `mock@sha256:${"d".repeat(64)}`,
    modelRoutes: ["route"],
    tags: ["actual"],
    destinations: ["local"],
    fixtureAdapter: { path: "fixtures/a.mjs", sha256: "e".repeat(64) },
    scenarioOracle: { path: "fixtures/oracle.mjs", sha256: "d".repeat(64) },
    scenarioProcess: { path: "fixtures/b.mjs", sha256: "f".repeat(64) },
    runtimeArtifacts: [],
    terminalInputBase64: "AA==",
    postCompletionInputByteLength: 0,
    postCompletionControl: "none" as const,
    waitForSemanticCompletionBeforeTerminalAction: false,
    nativeReadiness: null,
    resourceClass: "small" as const,
    shardWeight: 1,
  },
});

it("refuses hostile consumed metadata without invoking getters or proxy traps", () => {
  const input = fixture();
  const genuine = componentFixture();
  let observed = 0;
  const getter = () => {
    observed++;
    throw new Error("PRIVATE_RAW_CANARY");
  };
  const rootAccessor = Object.defineProperty({ ...genuine }, "harnessId", {
    get: getter,
  });
  const authorityAccessor = Object.defineProperty({}, "status", {
    get: getter,
  });
  const proxy = new Proxy(genuine, { getPrototypeOf: getter, ownKeys: getter });
  const revoked = Proxy.revocable(genuine, {});
  revoked.revoke();
  for (const value of [
    proxy,
    revoked.proxy,
    rootAccessor,
    {
      ...genuine,
      governance: {
        ...genuine.governance,
        provenance: {
          ...genuine.governance.provenance,
          artifactAuthority: authorityAccessor,
        },
      },
    },
    { ...genuine, fixtureVersion: 2 },
    { ...genuine, governance: { ...genuine.governance, representative: [] } },
  ])
    expect(() =>
      compileHarnessAdmissionSeed({ ...input, componentFixture: value }),
    ).toThrow("integration.harness-scenario-admission.invalid");
  expect(observed).toBe(0);
});

it("consumes reviewed governance identity, not the test-only native payload grammar", () => {
  const input = fixture();
  const { fixtureVersion, harnessId, harnessVersion, governance } =
    input.componentFixture;
  const seed = compileHarnessAdmissionSeed({
    ...input,
    componentFixture: { fixtureVersion, harnessId, harnessVersion, governance },
  });
  expect(seed.harness.artifactDigest).toBe(input.materialIdentity);
  expect(seed.component.fixtureDigest).toBe(digest("3"));
});

// eslint-disable-next-line max-lines-per-function -- complete bridge matrix
describe("real harness scenario admission bridge", () => {
  it("refuses missing, synthetic, foreign and unbound component fixtures", () => {
    const input = fixture();
    const genuine = componentFixture();
    const synthetic: unknown = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          "../../../packages/harnesses/codex/fixtures/native/codex-stop-v1.json",
        ),
        "utf8",
      ),
    );
    for (const value of [
      undefined,
      {},
      synthetic,
      { ...genuine, harnessId: "claude-code" },
      { ...genuine, harnessVersion: "9.9.9" },
      {
        ...genuine,
        governance: {
          ...genuine.governance,
          representative: {
            ...genuine.governance.representative,
            scenarioId: "other",
          },
        },
      },
      {
        ...genuine,
        governance: {
          ...genuine.governance,
          representative: {
            ...genuine.governance.representative,
            evidenceSlot: "other",
          },
        },
      },
      {
        ...genuine,
        governance: {
          ...genuine.governance,
          provenance: {
            ...genuine.governance.provenance,
            artifactAuthority: { status: "authenticated", digest: digest("f") },
          },
        },
      },
    ])
      expect(() =>
        compileHarnessAdmissionSeed({ ...input, componentFixture: value }),
      ).toThrow("integration.harness-scenario-admission.invalid");
  });
  it("binds material, component, catalog, platform, and scenario identities", () => {
    const input = fixture();
    const seed = compileHarnessAdmissionSeed(input);
    expect(seed.harness.artifactDigest).toBe(input.materialIdentity);
    expect(seed.component.fixtureDigest).toBe(digest("3"));
    expect(seed.catalogRowIdentity).toMatch(/^sha256-[a-f0-9]{64}$/u);
    expect(Object.isFrozen(seed)).toBe(true);
  });

  it("rejects certification fixtures and cross-scenario material", () => {
    const input = fixture();
    expect(() =>
      compileHarnessAdmissionSeed({
        ...input,
        scenario: { ...input.scenario, harnessEvidenceId: "other" },
      }),
    ).toThrow("integration.harness-scenario-admission.invalid");
    expect(() =>
      compileHarnessAdmissionSeed({
        ...input,
        evidence: {
          ...input.evidence,
          admission: {
            ...input.evidence.admission,
            distributionReference: "npm:@vendor/other@1.2.3",
          },
        },
      }),
    ).toThrow("integration.harness-scenario-admission.invalid");
    expect(() =>
      compileHarnessAdmissionSeed({
        ...input,
        evidence: {
          ...input.evidence,
          material: { kind: "certification-fixture" as const },
          admission: undefined,
        },
      }),
    ).toThrow("integration.harness-scenario-admission.invalid");
  });

  it("uses the same admission seam for a signed-manifest distribution", () => {
    const input = fixture();
    const signed = {
      ...input,
      componentFixture: componentFixture("2.1.89"),
      evidence: {
        ...input.evidence,
        representativeVersion: "2.1.89",
        material: {
          kind: "signed-release-manifest" as const,
          distributionId: "vendor-tool",
          version: "2.1.89",
          platform: "linux-x64",
          platformIdentity: digest("9"),
          verifierImage: `node@sha256:${"a".repeat(64)}`,
          binary: {
            url: "https://downloads.vendor.invalid/2.1.89/linux-x64/tool",
            bytes: 1,
            sha256: "a".repeat(64),
            executableName: "tool",
          },
          manifest: {
            url: "https://downloads.vendor.invalid/2.1.89/manifest.json",
            bytes: 1,
            sha256: "b".repeat(64),
          },
          signature: {
            url: "https://downloads.vendor.invalid/2.1.89/manifest.json.sig",
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
          ...input.evidence.admission,
          distributionReference: "signed-manifest:vendor-tool@2.1.89#linux-x64",
        },
      },
    };
    const seed = compileHarnessAdmissionSeed(signed);
    expect(seed.harness.distributionReference).toBe(
      "signed-manifest:vendor-tool@2.1.89#linux-x64",
    );
    expect(() =>
      compileHarnessAdmissionSeed({
        ...signed,
        evidence: {
          ...signed.evidence,
          admission: {
            ...signed.evidence.admission,
            distributionReference:
              "signed-manifest:vendor-tool@2.1.89#linux-arm64",
          },
        },
      }),
    ).toThrow("integration.harness-scenario-admission.invalid");
  });

  it("admits only passed work followed by complete cleanup", () => {
    const value = {
      cleanup: { outcome: "complete", remaining: 0 },
      observation: { eventKinds: ["span"] },
      outcome: "passed",
      requestFingerprint: `sha256:${"f".repeat(64)}`,
      runId: "0123456789abcdef",
      scenarioImageDigest: digest("a"),
    };
    const completion = compileHarnessAdmissionCompletion(value);
    expect(completion.observationPlaneDigest).toBe(
      sha256(JSON.stringify(value.observation)),
    );
    for (const mutation of [
      { ...value, outcome: "failed" },
      { ...value, cleanup: { outcome: "failed", remaining: 1 } },
    ])
      expect(() => compileHarnessAdmissionCompletion(mutation)).toThrow(
        "integration.harness-scenario-admission.invalid",
      );
  });
});
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseHarnessSanitizedFixture } from "@agentscope/harnesses-core/testing";
