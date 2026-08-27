import { describe, expect, it } from "vitest";

import {
  compileHarnessRegistry,
  defineHarnessDescriptor,
  HarnessDescriptorError,
} from "./descriptor.js";
import {
  completeNativeCaptureBoundary,
  createNativeFieldProvenance,
  createNativeUnavailableField,
  resolveNativeCaptureStart,
} from "./native-mapping.js";
import {
  createHarnessContractSuite,
  deriveHarnessComponentEvidenceDigest,
  type HarnessComponentContractAdapter,
  type HarnessHookTestBehavior,
} from "./testing-contract-suite.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const structurallyValidSyntheticLicenseSource =
  `https://github.com/Melbourneandrew/agentscope/blob/${"a".repeat(40)}` +
  "/packages/harnesses/core/NATIVE_FIXTURES.md#licenseref-agentscope-synthetic";
const reviewedHeadSha = "c".repeat(40);
const reviewedFixtureBlobSha = "d".repeat(40);
const referenceContextEvidence = Object.freeze({
  evidenceVersion: 1 as const,
  mappingArtifactDigest: `sha256-${"a".repeat(64)}`,
  contextDigest: `sha256-${"b".repeat(64)}`,
});
const descriptor = defineHarnessDescriptor({
  descriptorVersion: 1,
  harnessType: "@agentscope/harness-reference",
  executable: {
    names: ["reference-harness"],
    versionArguments: ["--version"],
    versionPrefix: "reference ",
    versionSuffix: "",
  },
  configuration: { locationSegments: [["reference", "config.json"]] },
  compatibility: [
    {
      minimumInclusive: "1.0.0",
      maximumExclusive: "2.0.0",
      evidenceSlot: "reference-v1",
    },
  ],
  nativeSource: { sourceKind: "reference-session", continuityVersion: 1 },
});

const hookRunner = async (
  behavior: HarnessHookTestBehavior,
  signal: AbortSignal,
): Promise<"completed" | "failed-open"> => {
  if (behavior === "success") return "completed";
  if (behavior === "failure") return "failed-open";
  if (signal.aborted) return "failed-open";
  return new Promise((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve("failed-open");
      },
      { once: true },
    );
  });
};

const referenceFixture = {
  fixtureVersion: 1,
  fixtureId: "reference-session-v1",
  harnessId: "reference",
  harnessVersion: "1.2.3",
  governance: {
    provenance: {
      captureKind: "synthetic",
      sourceReference: "urn:agentscope:synthetic:reference-session-v1",
      artifactAuthority: {
        status: "unresolved",
        reason: "independent-integrity-unavailable",
      },
      captureRecipe: "reference-recipe-v1",
    },
    license: {
      reviewedLicenseId: "LicenseRef-Agentscope-Synthetic",
      redistribution: "reviewed-for-repository",
      sourceReference: structurallyValidSyntheticLicenseSource,
    },
    redaction: {
      profileVersion: 1,
      classification: "sanitized-native-fixture",
      rawContentRetained: false,
      removedCategories: [
        "credentials",
        "raw-transcript",
        "terminal-output",
        "user-content",
        "user-paths",
      ],
    },
    review: {
      status: "approved",
      records: [
        {
          role: "privacy",
          reviewTaskIdentity: "/root/reference_privacy_review",
          reviewExecutionIdentity: "01a00000-0000-4000-8000-000000000001",
          reviewedHeadSha,
          reviewedFixtureBlobSha,
          submittedAt: "2026-08-25T10:00:00.000Z",
          reference:
            "https://github.com/Melbourneandrew/agentscope/pull/101#pullrequestreview-1001",
        },
        {
          role: "redistribution",
          reviewTaskIdentity: "/root/reference_redistribution_review",
          reviewExecutionIdentity: "01a00000-0000-4000-8000-000000000002",
          reviewedHeadSha,
          reviewedFixtureBlobSha,
          submittedAt: "2026-08-25T10:01:00.000Z",
          reference:
            "https://github.com/Melbourneandrew/agentscope/pull/101#issuecomment-1002",
        },
      ],
    },
    representative: {
      scenarioId: "reference-v1",
      representativeVersion: "1.2.3",
      evidenceSlot: "reference-v1",
    },
  },
  nativeIdentityKind: "session",
  nativeIdentity: "reference-session-1",
  sourceGeneration: 1,
  positionKind: "sequence",
  availableStartPosition: 4,
  boundaryKind: "turn",
  boundaryId: "reference-turn-5",
  exclusiveEndPosition: 5,
  expectedFields: ["llm.model_name", "tool.name"],
  sanitizedPayload: {
    model: "reference-model",
    operation: "summarize",
    token_count: 7,
  },
} as const;

const referenceScenario = {
  scenarioVersion: 1,
  scenarioId: "reference-v1",
  harnessId: "reference",
  harnessPackage: "@agentscope/harness-reference",
  representativeVersion: "1.2.3",
  fixtureId: "reference-session-v1",
  tags: ["reference", "contract"],
  commandArguments: ["run", "fixture-session"],
} as const;

const referenceEvidence = deriveHarnessComponentEvidenceDigest(
  referenceFixture,
  referenceScenario,
  descriptor,
  referenceContextEvidence,
);

const referenceAdapter = (): HarnessComponentContractAdapter => ({
  descriptor,
  componentEvidence: {
    evidenceVersion: 1,
    harnessType: descriptor.harnessType,
    testedVersion: "1.2.3",
    fixtureId: referenceFixture.fixtureId,
    scenarioId: referenceScenario.scenarioId,
    evidenceSlot: "reference-v1",
    componentDigest: referenceEvidence,
  },
  compatibleVersion: "1.2.3",
  fixture: referenceFixture,
  scenario: referenceScenario,
  contextEvidence: referenceContextEvidence,
  mapFixture: (resolver) => {
    const fixture = referenceFixture;
    const start = resolveNativeCaptureStart(
      {
        nativeIdentityKind: fixture.nativeIdentityKind,
        nativeIdentity: fixture.nativeIdentity,
        sourceGeneration: fixture.sourceGeneration,
        positionKind: fixture.positionKind,
        availableStartPosition: fixture.availableStartPosition,
      },
      resolver,
    );
    return {
      boundary: completeNativeCaptureBoundary(start, {
        boundaryKind: fixture.boundaryKind,
        boundaryId: fixture.boundaryId,
        exclusiveEndPosition: fixture.exclusiveEndPosition,
      }),
      provenance: [
        createNativeFieldProvenance("llm.model_name", "native-artifact"),
      ],
      unavailable: [
        createNativeUnavailableField({
          field: "tool.name",
          source: "native-artifact",
          state: "unavailable",
          reason: "not-emitted",
        }),
      ],
    };
  },
  createInstallationPlanner: (operation, invocation) => {
    const ownedText = JSON.stringify({
      owner: invocation.ownershipIdentity,
      command: invocation.launcherPath,
      arguments: invocation.arguments,
    });
    return ({ exists, bytes }) => {
      const current = bytes ? decoder.decode(bytes) : "";
      const owned = current === ownedText;
      if (current === "unsupported-native-format")
        return { kind: "unsupported" };
      if (operation === "uninstall")
        return owned ? { kind: "remove" } : { kind: "unchanged" };
      if (!exists) return { kind: "replace", bytes: encoder.encode(ownedText) };
      if (owned) return { kind: "unchanged" };
      return operation === "migrate"
        ? { kind: "replace-overlap", bytes: encoder.encode(ownedText) }
        : { kind: "conflict" };
    };
  },
  runHook: hookRunner,
});

const runCase = async (
  adapter: HarnessComponentContractAdapter,
  name: string,
): Promise<void> => {
  const contract = createHarnessContractSuite(adapter).find(
    (candidate) => candidate.name === name,
  );
  expect(contract).toBeDefined();
  await contract!.run();
};

describe("harness contract suite", () => {
  it("passes the complete minimal reference harness contract", async () => {
    const cases = createHarnessContractSuite(referenceAdapter());
    expect(Object.isFrozen(cases)).toBe(true);
    expect(cases.map(({ name }) => name)).toEqual([
      "harness:component-evidence",
      "harness:sanitized-native-mapping",
      "harness:launcher-and-installation",
      "harness:fail-open-deadline",
      "harness:scenario-adapter",
    ]);
    for (const contract of cases) await contract.run();
  });

  it("rejects secret-bearing fixtures and shell-shaped scenario arguments", async () => {
    const fixtureViolation = referenceAdapter();
    await expect(
      runCase(
        {
          ...fixtureViolation,
          fixture: {
            ...fixtureViolation.fixture,
            sanitizedPayload: { credential: "Bearer CANARY_SECRET" },
          },
        },
        "harness:sanitized-native-mapping",
      ),
    ).rejects.toThrow("harness.contract.fixture.sanitized");

    const privatePathViolation = referenceAdapter();
    await expect(
      runCase(
        {
          ...privatePathViolation,
          fixture: {
            ...privatePathViolation.fixture,
            sanitizedPayload: { workspace: "/Users/example/private-project" },
          },
        },
        "harness:sanitized-native-mapping",
      ),
    ).rejects.toThrow("harness.contract.fixture.sanitized");

    const scenarioViolation = referenceAdapter();
    await expect(
      runCase(
        {
          ...scenarioViolation,
          scenario: {
            ...scenarioViolation.scenario,
            commandArguments: ["run; touch /tmp/canary"],
          },
        },
        "harness:scenario-adapter",
      ),
    ).rejects.toThrow("harness.contract.scenario");

    const cyclicFixture = referenceAdapter();
    const cyclicPayload: Record<string, unknown> = {};
    cyclicPayload.self = cyclicPayload;
    await expect(
      runCase(
        {
          ...cyclicFixture,
          fixture: {
            ...cyclicFixture.fixture,
            sanitizedPayload: cyclicPayload as never,
          },
        },
        "harness:sanitized-native-mapping",
      ),
    ).rejects.toThrow("harness.contract.fixture.sanitized");
  });
});

describe("harness contract suite adversarial seeds", () => {
  it("rejects mapping, overlap, and deadline contract violations", async () => {
    const mappingViolation = referenceAdapter();
    await expect(
      runCase(
        {
          ...mappingViolation,
          mapFixture: (resolver) => {
            const mapped = mappingViolation.mapFixture(resolver);
            return { ...mapped, provenance: [] };
          },
        },
        "harness:sanitized-native-mapping",
      ),
    ).rejects.toThrow("harness.contract.mapping");

    const overlapViolation = referenceAdapter();
    await expect(
      runCase(
        {
          ...overlapViolation,
          createInstallationPlanner: (operation, invocation) => {
            const original = overlapViolation.createInstallationPlanner(
              operation,
              invocation,
            );
            return (input) =>
              operation === "install" &&
              input.exists &&
              decoder.decode(input.bytes!) === "vendor-observability-hook"
                ? { kind: "replace", bytes: encoder.encode("unsafe") }
                : original(input);
          },
        },
        "harness:launcher-and-installation",
      ),
    ).rejects.toThrow("harness.contract.install.overlap");

    const deadlineViolation = referenceAdapter();
    await expect(
      runCase(
        {
          ...deadlineViolation,
          runHook: async (behavior, signal) =>
            behavior === "hang" ? "completed" : hookRunner(behavior, signal),
        },
        "harness:fail-open-deadline",
      ),
    ).rejects.toThrow("harness.contract.hook.deadline");

    const neverSettles = referenceAdapter();
    await expect(
      runCase(
        {
          ...neverSettles,
          runHook: (behavior, signal) =>
            behavior === "hang"
              ? new Promise(() => undefined)
              : hookRunner(behavior, signal),
        },
        "harness:fail-open-deadline",
      ),
    ).rejects.toThrow("harness.contract.hook.deadline");
  });
});

describe("harness mapping correlation adversarial seeds", () => {
  it.each([
    ["nativeIdentityKind", "run", "harness.contract.mapping.checkpoint"],
    ["nativeIdentity", "other-session", "harness.contract.mapping.checkpoint"],
    ["sourceGeneration", 2, "harness.contract.mapping.checkpoint"],
    ["positionKind", "line", "harness.contract.mapping.checkpoint"],
    ["availableStartPosition", 3, "harness.native-mapping.invalid"],
  ] as const)(
    "rejects checkpoint correlation drift in %s",
    async (field, value, code) => {
      const adapter = referenceAdapter();
      await expect(
        runCase(
          {
            ...adapter,
            mapFixture: (resolver) =>
              adapter.mapFixture((request) =>
                resolver({ ...request, [field]: value }),
              ),
          },
          "harness:sanitized-native-mapping",
        ),
      ).rejects.toThrow(code);
    },
  );

  it.each([
    ["nativeIdentityKind", "run"],
    ["nativeIdentity", "other-session"],
    ["generation", 2],
    ["positionKind", "line"],
    ["boundaryKind", "session"],
    ["boundaryId", "other-boundary"],
    ["startPosition", 5],
    ["exclusiveEndPosition", 6],
  ] as const)(
    "rejects mapped boundary correlation drift in %s",
    async (field, value) => {
      const adapter = referenceAdapter();
      await expect(
        runCase(
          {
            ...adapter,
            mapFixture: (resolver) => {
              const mapping = adapter.mapFixture(resolver);
              const boundary =
                field === "nativeIdentityKind" || field === "nativeIdentity"
                  ? {
                      ...mapping.boundary,
                      session: { ...mapping.boundary.session, [field]: value },
                    }
                  : { ...mapping.boundary, [field]: value };
              return {
                ...mapping,
                boundary,
              };
            },
          },
          "harness:sanitized-native-mapping",
        ),
      ).rejects.toThrow("harness.contract.mapping");
    },
  );
});

describe("harness component evidence", () => {
  it("versions evidence across descriptor, context, and mapping artifact drift", () => {
    const baseline = deriveHarnessComponentEvidenceDigest(
      referenceFixture,
      referenceScenario,
      descriptor,
      referenceContextEvidence,
    );
    const executableDrift = defineHarnessDescriptor({
      descriptorVersion: 1,
      harnessType: "@agentscope/harness-reference",
      executable: {
        ...descriptor.executable,
        versionArguments: ["version"],
      },
      configuration: descriptor.configuration,
      compatibility: descriptor.compatibility,
      nativeSource: descriptor.nativeSource,
    });
    const descriptorDigest = deriveHarnessComponentEvidenceDigest(
      referenceFixture,
      referenceScenario,
      executableDrift,
      referenceContextEvidence,
    );
    const contextDigest = deriveHarnessComponentEvidenceDigest(
      referenceFixture,
      referenceScenario,
      descriptor,
      {
        ...referenceContextEvidence,
        contextDigest: `sha256-${"c".repeat(64)}`,
      },
    );
    const mappingDigest = deriveHarnessComponentEvidenceDigest(
      referenceFixture,
      referenceScenario,
      descriptor,
      {
        ...referenceContextEvidence,
        mappingArtifactDigest: `sha256-${"d".repeat(64)}`,
      },
    );
    expect(descriptorDigest).not.toEqual(baseline);
    expect(contextDigest).not.toBe(baseline);
    expect(mappingDigest).not.toBe(baseline);
  });

  it("rejects missing, malformed, accessor, and extra context evidence", () => {
    for (const contextEvidence of [
      undefined,
      { ...referenceContextEvidence, contextDigest: "not-a-digest" },
      { ...referenceContextEvidence, unexpected: true },
    ]) {
      expect(() =>
        deriveHarnessComponentEvidenceDigest(
          referenceFixture,
          referenceScenario,
          descriptor,
          contextEvidence,
        ),
      ).toThrow("harness.contract.context-evidence");
    }
    const accessor = { ...referenceContextEvidence };
    Object.defineProperty(accessor, "contextDigest", {
      enumerable: true,
      get: () => {
        throw new Error("must not execute");
      },
    });
    expect(() =>
      deriveHarnessComponentEvidenceDigest(
        referenceFixture,
        referenceScenario,
        descriptor,
        accessor,
      ),
    ).toThrow("harness.contract.context-evidence");
    const throwing = new Proxy(referenceContextEvidence, {
      getPrototypeOf: () => {
        throw new Error("synthetic context proxy failure");
      },
    });
    expect(() =>
      deriveHarnessComponentEvidenceDigest(
        referenceFixture,
        referenceScenario,
        descriptor,
        throwing,
      ),
    ).toThrow("harness.contract.context-evidence");
  });
  it("cannot populate production support evidence", () => {
    expect(referenceEvidence).toMatch(/^component-sha256-[a-f0-9]{64}$/u);
    expect(() =>
      compileHarnessRegistry([descriptor], {
        manifestVersion: 1,
        entries: [
          {
            harnessType: descriptor.harnessType,
            evidenceSlot: "reference-v1",
            testedVersion: "1.2.3",
            contractSuiteDigest: referenceEvidence,
            realScenarioDigest: referenceEvidence,
          },
        ],
      }),
    ).toThrow(HarnessDescriptorError);
    expect(referenceAdapter().componentEvidence).not.toHaveProperty(
      "realScenarioDigest",
    );
  });
});

describe("harness contract representative and component evidence", () => {
  it("requires the descriptor row containing the version to own the evidence slot", async () => {
    const base = referenceAdapter();
    await expect(
      runCase(
        { ...base, compatibleVersion: "not-semver" },
        "harness:component-evidence",
      ),
    ).rejects.toThrow("harness.contract.component-evidence");
    const outOfRangeFixture = {
      ...base.fixture,
      harnessVersion: "2.1.0",
      governance: {
        ...base.fixture.governance,
        representative: {
          ...base.fixture.governance.representative,
          representativeVersion: "2.1.0",
        },
      },
    } as const;
    const outOfRangeScenario = {
      ...base.scenario,
      representativeVersion: "2.1.0",
    } as const;
    await expect(
      runCase(
        {
          ...base,
          compatibleVersion: "2.1.0",
          fixture: outOfRangeFixture,
          scenario: outOfRangeScenario,
          componentEvidence: {
            ...base.componentEvidence,
            testedVersion: "2.1.0",
            componentDigest: deriveHarnessComponentEvidenceDigest(
              outOfRangeFixture,
              outOfRangeScenario,
              base.descriptor,
              base.contextEvidence,
            ),
          },
        },
        "harness:component-evidence",
      ),
    ).rejects.toThrow("harness.contract.component-evidence");

    const wrongSlotFixture = {
      ...base.fixture,
      governance: {
        ...base.fixture.governance,
        representative: {
          ...base.fixture.governance.representative,
          evidenceSlot: "other-slot",
        },
      },
    } as const;
    await expect(
      runCase(
        {
          ...base,
          fixture: wrongSlotFixture,
          componentEvidence: {
            ...base.componentEvidence,
            evidenceSlot: "other-slot",
            componentDigest: deriveHarnessComponentEvidenceDigest(
              wrongSlotFixture,
              base.scenario,
              base.descriptor,
              base.contextEvidence,
            ),
          },
        },
        "harness:component-evidence",
      ),
    ).rejects.toThrow("harness.contract.component-evidence");
  });
});

describe("harness contract representative evidence drift", () => {
  it("rejects representative scenario and evidence-slot drift", async () => {
    const scenarioDrift = referenceAdapter();
    await expect(
      runCase(
        {
          ...scenarioDrift,
          fixture: {
            ...scenarioDrift.fixture,
            governance: {
              ...scenarioDrift.fixture.governance,
              representative: {
                ...scenarioDrift.fixture.governance.representative,
                scenarioId: "other-scenario",
              },
            },
          },
        },
        "harness:scenario-adapter",
      ),
    ).rejects.toThrow("harness.contract.scenario");

    const evidenceDrift = referenceAdapter();
    const fixtureWithDrift = {
      ...evidenceDrift.fixture,
      governance: {
        ...evidenceDrift.fixture.governance,
        representative: {
          ...evidenceDrift.fixture.governance.representative,
          evidenceSlot: "other-slot",
        },
      },
    } as const;
    await expect(
      runCase(
        {
          ...evidenceDrift,
          fixture: fixtureWithDrift,
        },
        "harness:component-evidence",
      ),
    ).rejects.toThrow("harness.contract.component-evidence");
  });

  it("rejects stale or unbound component evidence", async () => {
    for (const field of [
      "componentDigest",
      "harnessType",
      "testedVersion",
      "fixtureId",
      "scenarioId",
      "evidenceSlot",
    ] as const) {
      const unbound = referenceAdapter();
      await expect(
        runCase(
          {
            ...unbound,
            componentEvidence: {
              ...unbound.componentEvidence,
              [field]:
                field === "componentDigest"
                  ? `component-sha256-${"b".repeat(64)}`
                  : "other",
            },
          },
          "harness:component-evidence",
        ),
      ).rejects.toThrow("harness.contract.component-evidence");
    }
    await expect(
      runCase(
        { ...referenceAdapter(), compatibleVersion: "1.4.0" },
        "harness:component-evidence",
      ),
    ).rejects.toThrow("harness.contract.component-evidence");
    const scenarioDrift = referenceAdapter();
    await expect(
      runCase(
        {
          ...scenarioDrift,
          scenario: { ...scenarioDrift.scenario, tags: ["changed"] },
        },
        "harness:component-evidence",
      ),
    ).rejects.toThrow("harness.contract.component-evidence");
  });
});
