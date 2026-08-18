export const FIXTURE_LIFECYCLE_PHASES = Object.freeze([
  "install",
  "configure",
  "hook",
  "execute",
  "export",
  "retrieve",
  "uninstall",
] as const);

export interface PlatformFixtureEvidence {
  readonly evidenceVersion: 1;
  readonly scenarioId: string;
  readonly artifactFileName: string;
  readonly lifecycle: readonly string[];
  readonly eventKinds: readonly string[];
  readonly modelLedger: Readonly<{
    ledgerVersion: 1;
    scenarioId: string;
    entries: readonly Readonly<Record<string, unknown>>[];
  }>;
  readonly destinationLedger: Readonly<{
    ledgerVersion: 1;
    scenarioId: string;
    ingestion: readonly Readonly<Record<string, unknown>>[];
    retrieval: readonly Readonly<Record<string, unknown>>[];
  }>;
}

export interface FixtureAssertion {
  readonly assertionId: string;
  readonly evaluate: (evidence: PlatformFixtureEvidence) => boolean;
}

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export const composeFixtureAssertions = (
  ...groups: readonly (readonly FixtureAssertion[])[]
): readonly FixtureAssertion[] => {
  const assertions = groups.flat();
  const identities = assertions.map(({ assertionId }) => assertionId);
  if (
    assertions.length < 1 ||
    identities.some((identity) => !/^[a-z][a-z0-9-]{0,63}$/u.test(identity)) ||
    new Set(identities).size !== identities.length
  )
    throw new Error("testkit.fixture.assertions");
  return deepFreeze([...assertions]);
};

export const runFixtureAssertions = (
  assertions: readonly FixtureAssertion[],
  evidence: PlatformFixtureEvidence,
): void => {
  for (const assertion of assertions) {
    let passed = false;
    try {
      passed = assertion.evaluate(evidence) === true;
    } catch {
      // Assertion implementations are test-only extensions; failures stay fixed.
    }
    if (!passed)
      throw new Error(`testkit.fixture.assertion-${assertion.assertionId}`);
  }
};

export const COMMON_FIXTURE_ASSERTIONS = composeFixtureAssertions([
  {
    assertionId: "lifecycle",
    evaluate: ({ lifecycle }) =>
      JSON.stringify(lifecycle) === JSON.stringify(FIXTURE_LIFECYCLE_PHASES),
  },
  {
    assertionId: "scenario-ledgers",
    evaluate: ({ scenarioId, modelLedger, destinationLedger }) =>
      modelLedger.scenarioId === scenarioId &&
      destinationLedger.scenarioId === scenarioId &&
      !Object.is(modelLedger, destinationLedger),
  },
  {
    assertionId: "representative-events",
    evaluate: ({ eventKinds }) =>
      [
        "hook",
        "canonical",
        "redaction",
        "git",
        "model",
        "tool",
        "destination",
      ].every((kind) => eventKinds.includes(kind)),
  },
]);
