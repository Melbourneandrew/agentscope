import { describe, expect, it } from "vitest";

import {
  COMMON_FIXTURE_ASSERTIONS,
  composeFixtureAssertions,
  FIXTURE_LIFECYCLE_PHASES,
  runFixtureAssertions,
  type PlatformFixtureEvidence,
} from "../platform-fixture.js";

const evidence = (): PlatformFixtureEvidence => ({
  evidenceVersion: 1,
  scenarioId: "fixture-process-smoke",
  artifactFileName: "agentscope-cli.tgz",
  lifecycle: FIXTURE_LIFECYCLE_PHASES,
  eventKinds: [
    "hook",
    "canonical",
    "redaction",
    "git",
    "model",
    "tool",
    "destination",
  ],
  modelLedger: {
    ledgerVersion: 1,
    scenarioId: "fixture-process-smoke",
    entries: [],
  },
  destinationLedger: {
    ledgerVersion: 1,
    scenarioId: "fixture-process-smoke",
    ingestion: [],
    retrieval: [],
  },
});

describe("platform fixture assertions", () => {
  it("composes common and family-specific extensions without a runner branch", () => {
    const assertions = composeFixtureAssertions(COMMON_FIXTURE_ASSERTIONS, [
      {
        assertionId: "harness-extension",
        evaluate: (value) => value.artifactFileName.endsWith(".tgz"),
      },
      {
        assertionId: "destination-extension",
        evaluate: (value) => value.destinationLedger.ingestion.length === 0,
      },
    ]);
    expect(Object.isFrozen(assertions)).toBe(true);
    expect(() => {
      runFixtureAssertions(assertions, evidence());
    }).not.toThrow();
  });

  it("rejects invalid inventories and emits fixed assertion failures", () => {
    expect(() => composeFixtureAssertions()).toThrow(
      "testkit.fixture.assertions",
    );
    expect(() =>
      composeFixtureAssertions([
        { assertionId: "same", evaluate: () => true },
        { assertionId: "same", evaluate: () => true },
      ]),
    ).toThrow("testkit.fixture.assertions");
    const failing = composeFixtureAssertions([
      { assertionId: "fixed-failure", evaluate: () => false },
      {
        assertionId: "throwing-failure",
        evaluate: () => {
          throw new Error("CANARY");
        },
      },
    ]);
    expect(() => {
      runFixtureAssertions(failing, evidence());
    }).toThrow("testkit.fixture.assertion-fixed-failure");
    expect(() => {
      runFixtureAssertions(failing.slice(1), evidence());
    }).toThrow("testkit.fixture.assertion-throwing-failure");
  });

  it("fails common assertions when lifecycle, namespace, or events drift", () => {
    const base = evidence();
    for (const changed of [
      { ...base, lifecycle: ["install"] },
      {
        ...base,
        modelLedger: { ...base.modelLedger, scenarioId: "other-scenario" },
      },
      {
        ...base,
        eventKinds: base.eventKinds.filter((kind) => kind !== "tool"),
      },
    ]) {
      expect(() => {
        runFixtureAssertions(COMMON_FIXTURE_ASSERTIONS, changed);
      }).toThrow(/testkit\.fixture\.assertion-/u);
    }
  });
});
