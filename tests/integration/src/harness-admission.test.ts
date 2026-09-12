import { describe, expect, it } from "vitest";

import {
  createHarnessAdmissionKernel,
  type HarnessAdmissionControllerSnapshot,
  type HarnessAdmissionSeed,
} from "./harness-admission.js";
import { canonicalJson, sha256 } from "./canonical.js";
import * as integrationRoot from "./index.js";

const digest = (character: string): string => `sha256-${character.repeat(64)}`;
const ociDigest = (character: string): string =>
  `sha256:${character.repeat(64)}`;
const runId = "0123456789abcdef";
const requestFingerprint = ociDigest("f");
const harnessArtifactAuthorityIdentity = (value: unknown): string =>
  sha256(canonicalJson(value));
const harnessCatalogRowIdentity = (value: unknown): string =>
  sha256(canonicalJson(value));

const seed = (overrides: Partial<HarnessAdmissionSeed> = {}) => {
  const artifact = {
    registryIdentity: "@agentscope/harness-codex",
    exactVersion: "1.2.3",
    distributionReference: "npm:@openai/codex@1.2.3",
    artifactDigest: digest("d"),
  };
  const harness = {
    ...artifact,
    evidenceSlot: "codex-headless-v1",
    eligibleRange: {
      minimumInclusive: "1.0.0",
      maximumExclusive: "2.0.0",
    },
    artifactAuthorityDigest: harnessArtifactAuthorityIdentity(artifact),
  };
  const execution = { mode: "headless", outputContract: "jsonl" } as const;
  const platformIdentity = digest("5");
  const destinationCombinationIdentity = digest("6");
  const baseline = {
    admissionVersion: 1,
    runId,
    candidateDigest: digest("a"),
    manifestIdentity: digest("b"),
    scenarioId: "codex-headless",
    catalogRowIdentity: harnessCatalogRowIdentity({
      productIdentity: "agentscope-cli",
      harness: {
        registryIdentity: harness.registryIdentity,
        evidenceSlot: harness.evidenceSlot,
        exactVersion: harness.exactVersion,
      },
      execution,
      platformIdentity,
      destinationCombinationIdentity,
    }),
    productIdentity: "agentscope-cli",
    harness,
    execution,
    component: {
      fixtureDigest: digest("1"),
      adapterArtifactDigest: digest("2"),
      mappingArtifactDigest: digest("3"),
      componentEvidenceDigest: `component-sha256-${"4".repeat(64)}`,
    },
    platformIdentity,
    destinationCombinationIdentity,
    preparedImage: {
      image: `node@${ociDigest("7")}`,
      manifestDigest: ociDigest("8"),
      configDigest: ociDigest("9"),
      platformIdentity: digest("5"),
      scenarioImageDigest: digest("6"),
    },
    ...overrides,
  } satisfies HarnessAdmissionSeed;
  return { ...baseline, ...overrides } as HarnessAdmissionSeed;
};

const validSeed = (overrides: Partial<HarnessAdmissionSeed> = {}) => {
  const candidate = seed(overrides);
  const harness = {
    ...candidate.harness,
    artifactAuthorityDigest: harnessArtifactAuthorityIdentity({
      registryIdentity: candidate.harness.registryIdentity,
      exactVersion: candidate.harness.exactVersion,
      distributionReference: candidate.harness.distributionReference,
      artifactDigest: candidate.harness.artifactDigest,
    }),
  };
  return {
    ...candidate,
    harness,
    catalogRowIdentity: harnessCatalogRowIdentity({
      productIdentity: candidate.productIdentity,
      harness: {
        registryIdentity: harness.registryIdentity,
        evidenceSlot: harness.evidenceSlot,
        exactVersion: harness.exactVersion,
      },
      execution: candidate.execution,
      platformIdentity: candidate.platformIdentity,
      destinationCombinationIdentity: candidate.destinationCombinationIdentity,
    }),
  } satisfies HarnessAdmissionSeed;
};

const completion = (overrides: Record<string, unknown> = {}) => ({
  completionVersion: 1,
  runId,
  requestFingerprint,
  observationPlaneDigest: digest("a"),
  cleanupEvidenceDigest: digest("b"),
  scenarioImageDigest: digest("6"),
  outcome: "scenario-terminal-clean",
  remainingOwnedResources: 0,
  ...overrides,
});

const fixture = (transport: "headless" | "pty" = "headless") => {
  const token = {};
  const materials = new WeakMap<object, unknown>();
  const terminals = new WeakMap<object, unknown>();
  const snapshot: HarnessAdmissionControllerSnapshot = {
    active: true,
    authorityIdentity: ociDigest("a"),
    candidateIdentities: new Set([digest("a")]),
    hostKind: "github-hosted",
    receipts: new Map([[runId, { requestFingerprint, transport }]]),
    runIds: new Set([runId]),
    workspaceRevision: "a".repeat(40),
  };
  const kernel = createHarnessAdmissionKernel(
    (candidate) => (candidate === token ? snapshot : undefined),
    (_candidate, authority) => materials.get(authority),
    (_candidate, authority) => terminals.get(authority),
  );
  const trustMaterial = (candidate: unknown) => {
    const authority = Object.freeze({
      authorityVersion: 1 as const,
      authorityKind: "authenticated-harness-material" as const,
    });
    materials.set(authority, candidate);
    return authority;
  };
  const trustTerminal = (material: object, candidate: unknown) => {
    const authority = Object.freeze({
      authorityVersion: 1 as const,
      authorityKind: "authenticated-harness-terminal" as const,
    });
    terminals.set(authority, { material, completion: candidate });
    return authority;
  };
  return { kernel, snapshot, token, trustMaterial, trustTerminal };
};

const begin = (
  context: ReturnType<typeof fixture>,
  candidate: unknown = seed(),
) => {
  const material = context.trustMaterial(candidate);
  return {
    authority: context.kernel.begin(context.token, material),
    material,
  };
};

const finish = (
  context: ReturnType<typeof fixture>,
  admission: ReturnType<typeof begin>,
  terminal: unknown = completion(),
): void => {
  const terminalAuthority = context.trustTerminal(admission.material, terminal);
  context.kernel.complete(
    context.token,
    admission.authority,
    terminalAuthority,
  );
};

describe("trusted real-harness admission", () => {
  it("keeps admission mints outside the ordinary integration export", () => {
    expect(integrationRoot).not.toHaveProperty("createHarnessAdmissionKernel");
    expect(integrationRoot).not.toHaveProperty("beginRealHarnessAdmission");
    expect(integrationRoot).not.toHaveProperty(
      "compileRealHarnessSupportEvidence",
    );
  });
  it("consumes one exact controller-bound authority into content-free evidence", () => {
    const { kernel, token, trustMaterial, trustTerminal } = fixture();
    const material = trustMaterial(seed());
    const authority = kernel.begin(token, material);
    const terminal = trustTerminal(material, completion());
    kernel.complete(token, authority, terminal);
    const manifest = kernel.compile(token, [authority]);
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.disposition).toBe(
      "real-scenario-evidence-awaiting-release-gate",
    );
    expect(manifest.manifestIdentity).toMatch(/^sha256-[a-f0-9]{64}$/u);
    expect(manifest.entries).toHaveLength(1);
    const entry = manifest.entries[0]!;
    expect(entry.harnessType).toBe("@agentscope/harness-codex");
    expect(entry.evidenceSlot).toBe("codex-headless-v1");
    expect(entry.testedVersion).toBe("1.2.3");
    expect(entry.catalogRowIdentity).toBe(seed().catalogRowIdentity);
    expect(entry.contractSuiteDigest).toMatch(/^sha256-[a-f0-9]{64}$/u);
    expect(entry.realScenarioDigest).toMatch(/^sha256-[a-f0-9]{64}$/u);
    expect(entry.binding.seed.scenarioId).toBe("codex-headless");
    expect(entry.binding.controller).toMatchObject({
      hostKind: "github-hosted",
      workspaceRevision: "a".repeat(40),
    });
    expect(entry.binding.completion.outcome).toBe("scenario-terminal-clean");
    expect(entry.contractSuiteDigest).not.toBe(
      seed().component.componentEvidenceDigest,
    );
    expect(() => kernel.compile(token, [authority])).toThrow(
      "integration.harness-admission.invalid",
    );
  });

  it("rejects plain, cloned, cross-kernel, cross-controller, and incomplete authority", () => {
    const first = fixture();
    const second = fixture();
    const admission = begin(first);
    const authority = admission.authority;
    expect(() =>
      first.kernel.begin(first.token, {
        authorityVersion: 1,
        authorityKind: "authenticated-harness-material",
      }),
    ).toThrow("integration.harness-admission.invalid");
    expect(() => first.kernel.begin(first.token, admission.material)).toThrow(
      "integration.harness-admission.invalid",
    );
    expect(() =>
      first.kernel.compile(first.token, [{ authorityVersion: 1, runId }]),
    ).toThrow("integration.harness-admission.invalid");
    expect(() =>
      first.kernel.compile(first.token, [structuredClone(authority)]),
    ).toThrow("integration.harness-admission.invalid");
    expect(() => {
      const terminal = first.trustTerminal(admission.material, completion());
      first.kernel.complete(second.token, authority, terminal);
    }).toThrow("integration.harness-admission.invalid");
    expect(() => {
      const secondMaterial = second.trustMaterial(seed());
      const terminal = second.trustTerminal(secondMaterial, completion());
      second.kernel.complete(second.token, authority, terminal);
    }).toThrow("integration.harness-admission.invalid");
    expect(() => first.kernel.compile(first.token, [authority])).toThrow(
      "integration.harness-admission.invalid",
    );
  });
});

describe("trusted real-harness admission substitutions", () => {
  it.each([
    ["candidate", seed({ candidateDigest: digest("f") })],
    ["run", seed({ runId: "fedcba9876543210" })],
    [
      "platform",
      seed({
        preparedImage: {
          ...seed().preparedImage,
          platformIdentity: digest("f"),
        },
      }),
    ],
    [
      "version",
      seed({
        harness: { ...seed().harness, exactVersion: "2.0.0" },
      }),
    ],
    [
      "artifact-authority",
      seed({
        harness: {
          ...seed().harness,
          artifactDigest: digest("e"),
        },
      }),
    ],
    ["catalog-row", seed({ catalogRowIdentity: digest("e") })],
    [
      "mode",
      seed({
        execution: { mode: "headless", outputContract: "semantic-pty" },
      } as never),
    ],
    ["product", seed({ productIdentity: "other" } as never)],
    [
      "component-placeholder",
      seed({
        component: {
          ...seed().component,
          componentEvidenceDigest: digest("4"),
        },
      }),
    ],
  ])("rejects %s substitution before mint", (_name, candidate) => {
    const context = fixture();
    const material = context.trustMaterial(candidate);
    expect(() => context.kernel.begin(context.token, material)).toThrow(
      "integration.harness-admission.invalid",
    );
  });

  it.each([
    ["run", completion({ runId: "fedcba9876543210" })],
    ["receipt", completion({ requestFingerprint: ociDigest("0") })],
    ["scenario-image", completion({ scenarioImageDigest: digest("f") })],
    ["outcome", completion({ outcome: "failed" })],
    ["cleanup", completion({ remainingOwnedResources: 1 })],
    ["extra", completion({ extra: true })],
  ])("rejects %s substitution at completion", (_name, candidate) => {
    const context = fixture();
    const admission = begin(context);
    const terminal = context.trustTerminal(admission.material, candidate);
    expect(() => {
      context.kernel.complete(context.token, admission.authority, terminal);
    }).toThrow("integration.harness-admission.invalid");
  });
});

describe("trusted real-harness admission binding", () => {
  it("binds transport and every component artifact into the resulting digests", () => {
    const compile = (candidate: HarnessAdmissionSeed) => {
      const context = fixture();
      const admission = begin(context, candidate);
      finish(context, admission);
      return context.kernel.compile(context.token, [admission.authority])
        .entries[0]!;
    };
    const baseline = compile(seed());
    for (const [name, value] of [
      ["fixtureDigest", digest("a")],
      ["adapterArtifactDigest", digest("b")],
      ["mappingArtifactDigest", digest("c")],
      ["componentEvidenceDigest", `component-sha256-${"d".repeat(64)}`],
    ] as const) {
      const changed = compile(
        seed({ component: { ...seed().component, [name]: value } }),
      );
      expect(changed.contractSuiteDigest).not.toBe(
        baseline.contractSuiteDigest,
      );
      expect(changed.realScenarioDigest).not.toBe(baseline.realScenarioDigest);
    }
    const pty = fixture("pty");
    const material = pty.trustMaterial(
      validSeed({
        execution: { mode: "interactive", outputContract: "semantic-pty" },
      }),
    );
    const authority = pty.kernel.begin(pty.token, material);
    const terminal = pty.trustTerminal(material, completion());
    pty.kernel.complete(pty.token, authority, terminal);
    expect(pty.kernel.compile(pty.token, [authority]).entries).toHaveLength(1);
  });

  it("rejects duplicate catalog rows atomically", () => {
    const { kernel, token, trustMaterial, trustTerminal } = fixture();
    const firstMaterial = trustMaterial(seed());
    const secondMaterial = trustMaterial(seed());
    const first = kernel.begin(token, firstMaterial);
    const second = kernel.begin(token, secondMaterial);
    const firstTerminal = trustTerminal(firstMaterial, completion());
    const secondTerminal = trustTerminal(secondMaterial, completion());
    kernel.complete(token, first, firstTerminal);
    kernel.complete(token, second, secondTerminal);
    expect(() => kernel.compile(token, [first, second])).toThrow(
      "integration.harness-admission.invalid",
    );
    expect(kernel.compile(token, [first]).entries).toHaveLength(1);
  });

  it("rejects accessors, proxies, sparse arrays, symbols, and deactivated controllers", () => {
    const value = seed();
    Object.defineProperty(value, "runId", {
      enumerable: true,
      get: () => {
        throw new Error("CANARY");
      },
    });
    const first = fixture();
    expect(() =>
      first.kernel.begin(first.token, first.trustMaterial(value)),
    ).toThrow("integration.harness-admission.invalid");
    expect(() =>
      first.kernel.begin(
        first.token,
        first.trustMaterial(
          new Proxy(seed(), {
            ownKeys: () => {
              throw new Error("CANARY");
            },
          }),
        ),
      ),
    ).toThrow("integration.harness-admission.invalid");
    const admission = begin(first);
    finish(first, admission);
    const authority = admission.authority;
    const sparse = new Array(1);
    expect(() => first.kernel.compile(first.token, sparse)).toThrow(
      "integration.harness-admission.invalid",
    );
    const symbols = [authority];
    Object.defineProperty(symbols, Symbol.for("canary"), { value: true });
    expect(() => first.kernel.compile(first.token, symbols)).toThrow(
      "integration.harness-admission.invalid",
    );
    expect(() =>
      first.kernel.compile(
        first.token,
        new Proxy([authority], {
          ownKeys: () => {
            throw new Error("CALLER-CONTENT-CANARY");
          },
        }),
      ),
    ).toThrow("integration.harness-admission.invalid");
    (first.snapshot as { active: boolean }).active = false;
    expect(() => first.kernel.compile(first.token, [authority])).toThrow(
      "integration.harness-admission.invalid",
    );
  });
});
