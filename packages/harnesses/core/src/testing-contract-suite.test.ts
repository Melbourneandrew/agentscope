import { describe, expect, it } from "vitest";

import { defineHarnessDescriptor } from "./descriptor.js";
import {
  completeNativeCaptureBoundary,
  createNativeFieldProvenance,
  createNativeUnavailableField,
  resolveNativeCaptureStart,
} from "./native-mapping.js";
import {
  createHarnessContractSuite,
  deriveHarnessContractEvidenceDigests,
  type HarnessContractAdapter,
  type HarnessHookTestBehavior,
} from "./testing-contract-suite.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
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
  harnessVersion: "1.2.3",
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
    tokenCount: 7,
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

const referenceEvidence = deriveHarnessContractEvidenceDigests(
  referenceFixture,
  referenceScenario,
);

const referenceAdapter = (): HarnessContractAdapter => ({
  descriptor,
  supportEvidence: {
    manifestVersion: 1,
    entries: [
      {
        harnessType: descriptor.harnessType,
        evidenceSlot: "reference-v1",
        testedVersion: "1.2.3",
        contractSuiteDigest: referenceEvidence.contractSuiteDigest,
        realScenarioDigest: referenceEvidence.realScenarioDigest,
      },
    ],
  },
  compatibleVersion: "1.2.3",
  unsupportedVersion: "2.0.0",
  fixture: referenceFixture,
  scenario: referenceScenario,
  contextEvidence: encoder.encode("reference-context"),
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
      command: invocation.executablePath,
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
  adapter: HarnessContractAdapter,
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
      "harness:compatibility-evidence",
      "harness:discovery",
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

describe("harness contract evidence and discovery seeds", () => {
  it("rejects stale compatibility and malformed discovery evidence", async () => {
    const compatibilityViolation = referenceAdapter();
    await expect(
      runCase(
        {
          ...compatibilityViolation,
          supportEvidence: {
            ...compatibilityViolation.supportEvidence,
            entries: compatibilityViolation.supportEvidence.entries.map(
              (entry) => ({
                ...entry,
                contractSuiteDigest: "not-a-digest",
              }),
            ),
          },
        },
        "harness:compatibility-evidence",
      ),
    ).rejects.toThrow("harness.descriptor.invalid");

    for (const field of [
      "contractSuiteDigest",
      "realScenarioDigest",
    ] as const) {
      const unbound = referenceAdapter();
      await expect(
        runCase(
          {
            ...unbound,
            supportEvidence: {
              ...unbound.supportEvidence,
              entries: unbound.supportEvidence.entries.map((entry) => ({
                ...entry,
                [field]: `sha256-${"b".repeat(64)}`,
              })),
            },
          },
          "harness:compatibility-evidence",
        ),
      ).rejects.toThrow("harness.contract.compatibility");
    }
    await expect(
      runCase(
        { ...referenceAdapter(), compatibleVersion: "1.4.0" },
        "harness:compatibility-evidence",
      ),
    ).rejects.toThrow("harness.contract.compatibility");
    const scenarioDrift = referenceAdapter();
    await expect(
      runCase(
        {
          ...scenarioDrift,
          scenario: { ...scenarioDrift.scenario, tags: ["changed"] },
        },
        "harness:compatibility-evidence",
      ),
    ).rejects.toThrow("harness.contract.compatibility");

    const discoveryViolation = referenceAdapter();
    await expect(
      runCase(
        { ...discoveryViolation, unsupportedVersion: "1.2.3" },
        "harness:discovery",
      ),
    ).rejects.toThrow("harness.contract.discovery");
  });
});
