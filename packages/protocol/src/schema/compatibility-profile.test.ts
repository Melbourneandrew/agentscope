import { describe, expect, it } from "vitest";

import { isRedactedCanonicalTrace } from "./redacted-envelope.js";
import {
  CompatibilityProfileError,
  compileCompatibilityProfileForTesting,
  computeCompatibilitySourceFingerprintsForTesting,
  CURRENT_SOURCE_ARTIFACTS_FOR_TESTING,
  migrateSyntheticEnvelopeForTesting,
  PROTOCOL_COMPATIBILITY_FINGERPRINT,
  PROTOCOL_COMPATIBILITY_PROFILE,
  selectCurrentGenerationForTesting,
  SYNTHETIC_SOURCE_SCHEMA_DESCRIPTOR_FOR_TESTING,
  SUPPORTED_PROTOCOL_GENERATIONS,
  validateProductionReaderWindowForTesting,
  type CompatibilityExtensionSnapshotInput,
  type CompatibilityProfileInput,
} from "./compatibility-profile.js";
import { fingerprintCanonicalMaterial } from "./extensions.js";
import { standardsManifest } from "../standards/manifest.js";

type MutableProfile = CompatibilityProfileInput;
type MutableSnapshot = CompatibilityExtensionSnapshotInput;

const extension = (key: string, semantic: string, introduced: number) => ({
  key,
  semantic,
  valueType: "string",
  introducedInProtocolContractVersion: introduced,
});

const sourceFixture = (
  manifestId: string,
  extensions: Readonly<Record<string, string>>,
) => ({
  envelopeVersion: 1,
  protocolManifestId: manifestId,
  delivery: { identity: "ab".repeat(32), stability: "session-stable" },
  graph: {
    resourceManifestId: manifestId,
    extensions,
    payload: { value: "sanitized" },
  },
});
const sourceDescriptor = () =>
  structuredClone(SYNTHETIC_SOURCE_SCHEMA_DESCRIPTOR_FOR_TESTING);

const refreshIdentity = (profile: MutableProfile) => {
  for (const generation of profile.generations) {
    const material: Partial<typeof generation> = { ...generation };
    delete material.generationFingerprint;
    generation.generationFingerprint = fingerprintCanonicalMaterial(material);
  }
  const material: Partial<MutableProfile> = { ...profile };
  delete material.profileFingerprint;
  profile.profileFingerprint = fingerprintCanonicalMaterial(material);
  return profile;
};

const refresh = (profile: MutableProfile, snapshots: MutableSnapshot[]) => {
  for (let index = 0; index < profile.generations.length; index += 1) {
    const generation = profile.generations[index]!;
    const snapshot = snapshots[index]!;
    try {
      Object.assign(
        generation,
        computeCompatibilitySourceFingerprintsForTesting(generation, snapshot),
      );
    } catch {
      // Invalid mutation fixtures intentionally fail the production compiler.
    }
  }
  return refreshIdentity(profile);
};

const productionProfileWithArchivedSynthetic = () => {
  const profile = structuredClone(
    PROTOCOL_COMPATIBILITY_PROFILE,
  ) as MutableProfile;
  const historical = structuredClone(profile.generations[0]!);
  historical.selector = {
    kind: "manifest",
    manifestId: "archived-synthetic",
  };
  historical.sourceSchemaKind = "synthetic-envelope-v1";
  profile.generations.unshift(historical);
  return profile;
};

const fixture = () => {
  const firstEntries = [extension("agentscope.synthetic.a", "synthetic.a", 1)];
  const secondEntries = [
    extension("agentscope.synthetic.a", "synthetic.a", 1),
    extension("agentscope.synthetic.b", "synthetic.b", 2),
  ];
  const firstFingerprint = fingerprintCanonicalMaterial(firstEntries);
  const secondFingerprint = fingerprintCanonicalMaterial(secondEntries);
  const shared = {
    upstreamBaselineId: "synthetic-baseline",
    canonicalProfileFingerprint: `sha256-${"11".repeat(32)}`,
    semanticDescriptorFingerprint: `sha256-${"22".repeat(32)}`,
    timingDescriptorFingerprint: `sha256-${"33".repeat(32)}`,
    identityProfileFingerprint: `sha256-${"44".repeat(32)}`,
  };
  const profile: MutableProfile = {
    profileVersion: 1,
    profileFingerprint: `sha256-${"00".repeat(32)}`,
    ordering: "protocol-contract-version-only",
    dispatch: "exact-envelope-version-and-manifest-id",
    archivePolicy: "whole-protocol-generation",
    extensionLineage: "append-only-immutable-no-retirement",
    identityPreservation: "equal-identity-profile-fingerprint-only",
    migrationPolicy: "adjacent-forward-strict-fresh-unbranded",
    limits: {
      maximumGenerations: 4,
      maximumMigrations: 3,
      maximumExtensionsPerGeneration: 4,
      maximumMigrationWorkUnits: 16,
    },
    generations: [
      {
        selector: { kind: "manifest", manifestId: "synthetic-v1" },
        protocolContractVersion: 1,
        envelopeVersion: 1,
        sourceSchemaId: "synthetic-envelope-v1",
        sourceSchemaKind: "synthetic-envelope-v1",
        sourceSchemaFingerprint: `sha256-${"00".repeat(32)}`,
        sourceFixtureFingerprint: `sha256-${"00".repeat(32)}`,
        ...shared,
        extensionRegistryVersion: 1,
        extensionRegistryFingerprint: firstFingerprint,
        codecProfileFingerprint: `sha256-${"55".repeat(32)}`,
        generationFingerprint: `sha256-${"00".repeat(32)}`,
      },
      {
        selector: { kind: "current" },
        protocolContractVersion: 2,
        envelopeVersion: 1,
        sourceSchemaId: "synthetic-envelope-v1",
        sourceSchemaKind: "synthetic-envelope-v1",
        sourceSchemaFingerprint: `sha256-${"00".repeat(32)}`,
        sourceFixtureFingerprint: `sha256-${"00".repeat(32)}`,
        ...shared,
        extensionRegistryVersion: 2,
        extensionRegistryFingerprint: secondFingerprint,
        codecProfileFingerprint: `sha256-${"55".repeat(32)}`,
        generationFingerprint: `sha256-${"00".repeat(32)}`,
      },
    ],
    readerWindow: [
      {
        selector: { kind: "manifest", manifestId: "synthetic-v1" },
        envelopeVersion: 1,
      },
      { selector: { kind: "current" }, envelopeVersion: 1 },
    ],
    migrations: [
      {
        migrationId: "synthetic-v1-to-current",
        kind: "adjacent-forward",
        source: { kind: "manifest", manifestId: "synthetic-v1" },
        target: { kind: "current" },
        identityRule: "preserve-if-profile-equal",
        manifestRule: "replace-outer-and-resource-manifest",
      },
    ],
  };
  const snapshots: MutableSnapshot[] = [
    {
      selector: { kind: "manifest", manifestId: "synthetic-v1" },
      registryFingerprint: firstFingerprint,
      entries: firstEntries,
      sourceSchemaDescriptor: sourceDescriptor(),
      sourceFixture: sourceFixture("synthetic-v1", {
        "agentscope.synthetic.a": "sanitized",
      }),
    },
    {
      selector: { kind: "current" },
      registryFingerprint: secondFingerprint,
      entries: secondEntries,
      sourceSchemaDescriptor: sourceDescriptor(),
      sourceFixture: sourceFixture(standardsManifest.manifestId, {
        "agentscope.synthetic.a": "sanitized",
        "agentscope.synthetic.b": "sanitized",
      }),
    },
  ];
  return { profile: refresh(profile, snapshots), snapshots };
};

const mutate = (
  change: (profile: MutableProfile, snapshots: MutableSnapshot[]) => void,
) => {
  const value = fixture();
  change(value.profile, value.snapshots);
  refresh(value.profile, value.snapshots);
  return value;
};

describe("Protocol compatibility history", () => {
  it("binds the exact v1-to-v2 production window without self-reference", () => {
    expect(PROTOCOL_COMPATIBILITY_FINGERPRINT).toBe(
      fingerprintCanonicalMaterial(
        (({ profileFingerprint: _, ...rest }) => rest)(
          PROTOCOL_COMPATIBILITY_PROFILE,
        ),
      ),
    );
    expect(PROTOCOL_COMPATIBILITY_PROFILE.generations).toHaveLength(2);
    expect(
      PROTOCOL_COMPATIBILITY_PROFILE.generations.map(
        ({ protocolContractVersion }) => protocolContractVersion,
      ),
    ).toEqual([1, 2]);
    expect(PROTOCOL_COMPATIBILITY_PROFILE.generations[0]?.selector.kind).toBe(
      "manifest",
    );
    expect(PROTOCOL_COMPATIBILITY_PROFILE.generations[1]?.selector).toEqual({
      kind: "current",
    });
    expect(PROTOCOL_COMPATIBILITY_PROFILE.migrations).toHaveLength(1);
    expect(SUPPORTED_PROTOCOL_GENERATIONS).toHaveLength(2);
    expect(PROTOCOL_COMPATIBILITY_FINGERPRINT).toBe(
      standardsManifest.compatibilityProfile.profileFingerprint,
    );
  });

  it("compiles a synthetic two-generation append-only lineage", () => {
    const { profile, snapshots } = fixture();
    const compiled = compileCompatibilityProfileForTesting(profile, snapshots);
    expect(
      compiled.archive.map(
        ({ protocolContractVersion }) => protocolContractVersion,
      ),
    ).toEqual([1, 2]);
    expect(Object.isFrozen(compiled.profile)).toBe(true);
    expect(Object.isFrozen(compiled.archive)).toBe(true);
    expect(compiled.supported).toEqual(compiled.archive);
  });

  it("selects the explicit current generation in a production-shaped archive", () => {
    const { profile } = fixture();
    profile.generations[0]!.upstreamBaselineId = "historical-baseline";
    refreshIdentity(profile);
    expect(selectCurrentGenerationForTesting(profile).upstreamBaselineId).toBe(
      "synthetic-baseline",
    );
    const missing = structuredClone(profile);
    missing.generations[1]!.selector = {
      kind: "manifest",
      manifestId: "synthetic-v2",
    };
    expect(() => selectCurrentGenerationForTesting(missing)).toThrow(
      CompatibilityProfileError,
    );
    expect(() => selectCurrentGenerationForTesting({})).toThrow(
      CompatibilityProfileError,
    );
    expect(() => validateProductionReaderWindowForTesting(profile)).toThrow(
      CompatibilityProfileError,
    );
    expect(
      validateProductionReaderWindowForTesting(PROTOCOL_COMPATIBILITY_PROFILE),
    ).toBe(true);
    const syntheticProduction = structuredClone(
      PROTOCOL_COMPATIBILITY_PROFILE,
    ) as MutableProfile;
    syntheticProduction.generations[0]!.sourceSchemaKind =
      "synthetic-envelope-v1";
    expect(() =>
      validateProductionReaderWindowForTesting(syntheticProduction),
    ).toThrow(CompatibilityProfileError);
    const codecMismatch = structuredClone(
      PROTOCOL_COMPATIBILITY_PROFILE,
    ) as MutableProfile;
    codecMismatch.readerWindow[0]!.envelopeVersion = 2;
    expect(() =>
      validateProductionReaderWindowForTesting(codecMismatch),
    ).toThrow(CompatibilityProfileError);
    const extraWindow = structuredClone(PROTOCOL_COMPATIBILITY_PROFILE);
    extraWindow.readerWindow.push(
      structuredClone(extraWindow.readerWindow[0]!),
    );
    expect(() => validateProductionReaderWindowForTesting(extraWindow)).toThrow(
      CompatibilityProfileError,
    );
    expect(() => validateProductionReaderWindowForTesting({})).toThrow(
      CompatibilityProfileError,
    );
  });
});

describe("Protocol compatibility validation", () => {
  it("rejects synthetic schemas anywhere in the production archive", () => {
    expect(() =>
      validateProductionReaderWindowForTesting(
        productionProfileWithArchivedSynthetic(),
      ),
    ).toThrow(CompatibilityProfileError);
  });

  it("rejects stale profile and missing snapshot identities", () => {
    const stale = fixture();
    stale.profile.limits.maximumMigrationWorkUnits += 1;
    expect(() =>
      compileCompatibilityProfileForTesting(stale.profile, stale.snapshots),
    ).toThrow(CompatibilityProfileError);

    const missing = fixture();
    missing.snapshots.pop();
    expect(() =>
      compileCompatibilityProfileForTesting(missing.profile, missing.snapshots),
    ).toThrow(CompatibilityProfileError);

    const mismatched = fixture();
    mismatched.snapshots[0]!.registryFingerprint = `sha256-${"88".repeat(32)}`;
    expect(() =>
      compileCompatibilityProfileForTesting(
        mismatched.profile,
        mismatched.snapshots,
      ),
    ).toThrow(CompatibilityProfileError);
  });

  it("rejects malformed extension-history identity metadata", () => {
    const { profile, snapshots } = mutate((p, values) => {
      values[1]!.entries[1]!.key = null;
      values[1]!.registryFingerprint = fingerprintCanonicalMaterial(
        values[1]!.entries,
      );
      p.generations[1]!.extensionRegistryFingerprint =
        values[1]!.registryFingerprint;
    });
    expect(() =>
      compileCompatibilityProfileForTesting(profile, snapshots),
    ).toThrow(CompatibilityProfileError);
  });
});

describe("compatibility profile rejection", () => {
  it.each([
    [
      "zero version",
      (p: MutableProfile) => (p.generations[0]!.protocolContractVersion = 0),
    ],
    [
      "fractional version",
      (p: MutableProfile) => (p.generations[0]!.protocolContractVersion = 1.5),
    ],
    [
      "future gap",
      (p: MutableProfile) => (p.generations[1]!.protocolContractVersion = 3),
    ],
    [
      "equal version",
      (p: MutableProfile) => (p.generations[1]!.protocolContractVersion = 1),
    ],
    [
      "descending versions",
      (p: MutableProfile) => (p.generations[1]!.protocolContractVersion = 0),
    ],
    [
      "duplicate selector",
      (p: MutableProfile) => (p.generations[0]!.selector = { kind: "current" }),
    ],
    ["current not last", (p: MutableProfile) => p.generations.reverse()],
    [
      "missing current",
      (p: MutableProfile) =>
        (p.generations[1]!.selector = { kind: "manifest", manifestId: "v2" }),
    ],
    [
      "wrong window envelope",
      (p: MutableProfile) => (p.readerWindow[0]!.envelopeVersion = 2),
    ],
    [
      "unknown window selector",
      (p: MutableProfile) =>
        (p.readerWindow[0]!.selector = {
          kind: "manifest",
          manifestId: "unknown",
        }),
    ],
    [
      "duplicate window",
      (p: MutableProfile) => p.readerWindow.push(p.readerWindow[0]!),
    ],
    [
      "missing current window",
      (p: MutableProfile) => (p.readerWindow = [p.readerWindow[0]!]),
    ],
    ["missing migration", (p: MutableProfile) => (p.migrations = [])],
    [
      "reverse migration",
      (p: MutableProfile) =>
        ([p.migrations[0]!.source, p.migrations[0]!.target] = [
          p.migrations[0]!.target,
          p.migrations[0]!.source,
        ]),
    ],
    [
      "duplicate migration ID",
      (p: MutableProfile) => p.migrations.push({ ...p.migrations[0]! }),
    ],
    [
      "duplicate migration edge",
      (p: MutableProfile) =>
        p.migrations.push({
          ...p.migrations[0]!,
          migrationId: "synthetic-duplicate-edge",
        }),
    ],
    [
      "resolved current manifest collision",
      (p: MutableProfile) =>
        (p.generations[0]!.selector = {
          kind: "manifest",
          manifestId: standardsManifest.manifestId,
        }),
    ],
    [
      "identity profile change",
      (p: MutableProfile) =>
        (p.generations[1]!.identityProfileFingerprint = `sha256-${"66".repeat(32)}`),
    ],
  ])("rejects coordinated invalid history: %s", (_name, change) => {
    const { profile, snapshots } = mutate((p) => change(p));
    expect(() =>
      compileCompatibilityProfileForTesting(profile, snapshots),
    ).toThrow(CompatibilityProfileError);
  });
});

describe("extension lineage rejection", () => {
  it.each([
    [
      "backdated introduction",
      (_p: MutableProfile, s: MutableSnapshot[]) =>
        (s[1]!.entries[1]!.introducedInProtocolContractVersion = 1),
    ],
    [
      "delayed introduction",
      (_p: MutableProfile, s: MutableSnapshot[]) =>
        (s[1]!.entries[1]!.introducedInProtocolContractVersion = 3),
    ],
    [
      "pre-introduction presence",
      (_p: MutableProfile, s: MutableSnapshot[]) =>
        s[0]!.entries.push(
          extension("agentscope.synthetic.b", "synthetic.b", 2),
        ),
    ],
    [
      "post-introduction disappearance",
      (_p: MutableProfile, s: MutableSnapshot[]) => s[1]!.entries.splice(0, 1),
    ],
    [
      "metadata mutation",
      (_p: MutableProfile, s: MutableSnapshot[]) =>
        (s[1]!.entries[0]!.valueType = "json-string"),
    ],
    [
      "semantic mutation",
      (_p: MutableProfile, s: MutableSnapshot[]) =>
        (s[1]!.entries[0]!.semantic = "synthetic.changed"),
    ],
    [
      "semantic reuse",
      (_p: MutableProfile, s: MutableSnapshot[]) =>
        (s[1]!.entries[1]!.semantic = "synthetic.a"),
    ],
    [
      "duplicate key",
      (_p: MutableProfile, s: MutableSnapshot[]) =>
        s[1]!.entries.push({ ...s[1]!.entries[1]! }),
    ],
  ])("rejects invalid extension lineage: %s", (_name, change) => {
    const { profile, snapshots } = mutate((_p, s) => {
      change(_p, s);
      for (let index = 0; index < s.length; index += 1) {
        s[index]!.registryFingerprint = fingerprintCanonicalMaterial(
          s[index]!.entries,
        );
        _p.generations[index]!.extensionRegistryFingerprint =
          s[index]!.registryFingerprint;
      }
    });
    expect(() =>
      compileCompatibilityProfileForTesting(profile, snapshots),
    ).toThrow(CompatibilityProfileError);
  });
});

describe("source contract identity", () => {
  it("rejects coordinated profile identity with a stale source schema artifact", () => {
    const { profile, snapshots } = fixture();
    profile.generations[0]!.sourceSchemaFingerprint = `sha256-${"99".repeat(32)}`;
    refreshIdentity(profile);
    expect(() =>
      compileCompatibilityProfileForTesting(profile, snapshots),
    ).toThrow(CompatibilityProfileError);
  });

  it("binds the consumed source descriptor and literal source fixture", () => {
    const descriptorDrift = fixture();
    descriptorDrift.snapshots[0]!.sourceSchemaDescriptor = {
      ...SYNTHETIC_SOURCE_SCHEMA_DESCRIPTOR_FOR_TESTING,
      graph: {
        ...SYNTHETIC_SOURCE_SCHEMA_DESCRIPTOR_FOR_TESTING.graph,
        maximumRecordEntries: 255,
      },
    };
    expect(() =>
      compileCompatibilityProfileForTesting(
        descriptorDrift.profile,
        descriptorDrift.snapshots,
      ),
    ).toThrow(CompatibilityProfileError);

    const fixtureDrift = fixture();
    fixtureDrift.snapshots[0]!.sourceFixture = sourceFixture("synthetic-v1", {
      "agentscope.synthetic.a": "changed-literal",
    });
    expect(() =>
      compileCompatibilityProfileForTesting(
        fixtureDrift.profile,
        fixtureDrift.snapshots,
      ),
    ).toThrow(CompatibilityProfileError);

    const semanticMismatch = fixture();
    (
      semanticMismatch.snapshots[0]!.sourceFixture as ReturnType<
        typeof sourceFixture
      >
    ).graph.resourceManifestId = "other";
    refresh(semanticMismatch.profile, semanticMismatch.snapshots);
    expect(() =>
      compileCompatibilityProfileForTesting(
        semanticMismatch.profile,
        semanticMismatch.snapshots,
      ),
    ).toThrow(CompatibilityProfileError);
  });

  it("validates current artifacts against the real persisted reader", () => {
    for (const target of ["descriptor", "fixture"] as const) {
      const profile = structuredClone(
        PROTOCOL_COMPATIBILITY_PROFILE,
      ) as MutableProfile;
      const snapshot = {
        selector: { kind: "current" as const },
        registryFingerprint:
          standardsManifest.agentscopeExtensions.registryFingerprint,
        entries: structuredClone(
          standardsManifest.agentscopeExtensions.entries,
        ),
        ...structuredClone(CURRENT_SOURCE_ARTIFACTS_FOR_TESTING),
      } as MutableSnapshot;
      if (target === "descriptor") {
        snapshot.sourceSchemaDescriptor = {
          ...(snapshot.sourceSchemaDescriptor as Record<string, unknown>),
          unknownFields: "accept",
        };
      } else {
        const fixture = snapshot.sourceFixture as ReturnType<
          typeof sourceFixture
        >;
        fixture.delivery.identity = "invalid";
      }
      refresh(profile, [snapshot]);
      expect(() =>
        compileCompatibilityProfileForTesting(profile, [snapshot]),
      ).toThrow(CompatibilityProfileError);
    }
  });
});

describe("compatibility input hardening", () => {
  it("preflights hostile profile and snapshot key counts before schema traversal", () => {
    const hostile = Object.fromEntries(
      Array.from({ length: 65_537 }, (_, index) => [`key${index}`, "value"]),
    );
    expect(() => compileCompatibilityProfileForTesting(hostile, [])).toThrow(
      CompatibilityProfileError,
    );
    expect(() => compileCompatibilityProfileForTesting({}, hostile)).toThrow(
      CompatibilityProfileError,
    );

    const sparse = new Array<unknown>(1);
    expect(() => compileCompatibilityProfileForTesting(sparse, [])).toThrow(
      CompatibilityProfileError,
    );
    const decorated: unknown[] = [];
    Object.defineProperty(decorated, "extra", { value: true });
    expect(() => compileCompatibilityProfileForTesting(decorated, [])).toThrow(
      CompatibilityProfileError,
    );
    const overlongKey = { ["x".repeat(1_048_577)]: true };
    expect(() =>
      compileCompatibilityProfileForTesting(overlongKey, []),
    ).toThrow(CompatibilityProfileError);
    expect(() =>
      compileCompatibilityProfileForTesting("x".repeat(1_048_577), []),
    ).toThrow(CompatibilityProfileError);
    expect(() => compileCompatibilityProfileForTesting(new Date(), [])).toThrow(
      CompatibilityProfileError,
    );
    expect(() =>
      compileCompatibilityProfileForTesting({ [Symbol("unsafe")]: true }, []),
    ).toThrow(CompatibilityProfileError);
    expect(() =>
      compileCompatibilityProfileForTesting(
        Array.from({ length: 16_385 }, () => null),
        [],
      ),
    ).toThrow(CompatibilityProfileError);
    const accessor = {};
    Object.defineProperty(accessor, "unsafe", { get: () => "CANARY_SECRET" });
    expect(() => compileCompatibilityProfileForTesting(accessor, [])).toThrow(
      CompatibilityProfileError,
    );
    const canary = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("CANARY_SECRET");
        },
      },
    );
    expect(() => compileCompatibilityProfileForTesting(canary, [])).toThrow(
      CompatibilityProfileError,
    );
  });
});

describe("synthetic compatibility migration", () => {
  it("migrates a recognized synthetic envelope freshly and without a brand", () => {
    const { profile, snapshots } = fixture();
    const compiled = compileCompatibilityProfileForTesting(profile, snapshots);
    const source = {
      envelopeVersion: 1,
      protocolManifestId: "synthetic-v1",
      delivery: { identity: "ab".repeat(32), stability: "session-stable" },
      graph: {
        resourceManifestId: "synthetic-v1",
        extensions: { "agentscope.synthetic.a": "safe" },
        payload: { value: "safe" },
      },
    };
    const first = migrateSyntheticEnvelopeForTesting(source, compiled);
    const second = migrateSyntheticEnvelopeForTesting(source, compiled);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.protocolManifestId).toBe(
      SUPPORTED_PROTOCOL_GENERATIONS.at(-1)?.manifestId,
    );
    expect(first.value.graph.resourceManifestId).toBe(
      first.value.protocolManifestId,
    );
    expect(first.value.delivery).toEqual(source.delivery);
    expect(first.value).not.toBe(source);
    expect(first.value.graph).not.toBe(source.graph);
    expect(source.protocolManifestId).toBe("synthetic-v1");
    expect(Object.isFrozen(first.value)).toBe(true);
    expect(isRedactedCanonicalTrace(first.value)).toBe(false);
  });

  it("rejects extensions outside the strict source-generation snapshot", () => {
    const { profile, snapshots } = fixture();
    const compiled = compileCompatibilityProfileForTesting(profile, snapshots);
    const source = {
      envelopeVersion: 1,
      protocolManifestId: "synthetic-v1",
      delivery: { identity: "ab".repeat(32), stability: "session-stable" },
      graph: {
        resourceManifestId: "synthetic-v1",
        extensions: {
          "agentscope.synthetic.b": "future",
        } as Record<string, string>,
        payload: {},
      },
    };
    expect(migrateSyntheticEnvelopeForTesting(source, compiled)).toEqual({
      ok: false,
      reason: "invalid",
    });
    source.graph.extensions = { "agentscope.evil": "unknown" };
    expect(migrateSyntheticEnvelopeForTesting(source, compiled)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it.each([
    [
      "unknown selector",
      {
        protocolManifestId: "future",
        graph: { resourceManifestId: "future", extensions: {}, payload: {} },
      },
      "unsupported",
    ],
    ["wrong envelope pair", { envelopeVersion: 2 }, "unsupported"],
    [
      "outer-inner mismatch",
      { graph: { resourceManifestId: "other", extensions: {}, payload: {} } },
      "invalid",
    ],
    [
      "malformed recognized",
      { delivery: { identity: "not-an-id", stability: "session-stable" } },
      "invalid",
    ],
  ])("classifies synthetic reader failure: %s", (_name, patch, reason) => {
    const { profile, snapshots } = fixture();
    const base = {
      envelopeVersion: 1,
      protocolManifestId: "synthetic-v1",
      delivery: { identity: "ab".repeat(32), stability: "session-stable" },
      graph: {
        resourceManifestId: "synthetic-v1",
        extensions: {},
        payload: {},
      },
    };
    const input = { ...base, ...patch };
    expect(
      migrateSyntheticEnvelopeForTesting(
        input,
        compileCompatibilityProfileForTesting(profile, snapshots),
      ),
    ).toEqual({ ok: false, reason });
  });

  it("uses only exact opaque selectors and never numeric proximity", () => {
    const { profile, snapshots } = fixture();
    const compiled = compileCompatibilityProfileForTesting(profile, snapshots);
    const input = {
      envelopeVersion: 1,
      protocolManifestId: "synthetic-v01",
      delivery: { identity: "ab".repeat(32), stability: "session-stable" },
      graph: {
        resourceManifestId: "synthetic-v01",
        extensions: {},
        payload: {},
      },
    };
    expect(migrateSyntheticEnvelopeForTesting(input, compiled)).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });
});

describe("synthetic migration hardening", () => {
  it("does not execute a generation retained only in the archive", () => {
    const { profile, snapshots } = mutate((p) => {
      p.readerWindow = [p.readerWindow[1]!];
    });
    const compiled = compileCompatibilityProfileForTesting(profile, snapshots);
    expect(compiled.supported).toEqual([compiled.archive[1]]);
    expect(
      migrateSyntheticEnvelopeForTesting(
        {
          envelopeVersion: 1,
          protocolManifestId: "synthetic-v1",
          delivery: { identity: "ab".repeat(32), stability: "session-stable" },
          graph: {
            resourceManifestId: "synthetic-v1",
            extensions: {},
            payload: {},
          },
        },
        compiled,
      ),
    ).toEqual({ ok: false, reason: "unsupported" });
  });

  it("rejects nested or overlong source values before migration", () => {
    const { profile, snapshots } = fixture();
    const compiled = compileCompatibilityProfileForTesting(profile, snapshots);
    const base = {
      envelopeVersion: 1,
      protocolManifestId: "synthetic-v1",
      delivery: { identity: "ab".repeat(32), stability: "session-stable" },
      graph: {
        resourceManifestId: "synthetic-v1",
        extensions: {},
        payload: { unsafe: { nested: true } } as Record<string, unknown>,
      },
    };
    expect(migrateSyntheticEnvelopeForTesting(base, compiled)).toEqual({
      ok: false,
      reason: "invalid",
    });
    base.graph.payload = { unsafe: "x".repeat(1025) };
    expect(migrateSyntheticEnvelopeForTesting(base, compiled)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("enforces descriptor-owned extension and payload entry bounds", () => {
    for (const field of ["extensions", "payload"] as const) {
      const value = fixture();
      value.snapshots[0]!.sourceFixture = sourceFixture("synthetic-v1", {});
      const graph = (
        value.snapshots[0]!.sourceFixture as ReturnType<typeof sourceFixture>
      ).graph as {
        extensions: Record<string, string>;
        payload: Record<string, string>;
      };
      graph[field] = Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => [`key${index}`, "safe"]),
      );
      refresh(value.profile, value.snapshots);
      expect(() =>
        compileCompatibilityProfileForTesting(value.profile, value.snapshots),
      ).toThrow(CompatibilityProfileError);
    }
  });
});

describe("synthetic migration runtime defenses", () => {
  it("bounds migration work before constructing output", () => {
    const { profile, snapshots } = mutate((p) => {
      p.limits.maximumMigrationWorkUnits = 1;
    });
    const compiled = compileCompatibilityProfileForTesting(profile, snapshots);
    expect(
      migrateSyntheticEnvelopeForTesting(
        {
          envelopeVersion: 1,
          protocolManifestId: "synthetic-v1",
          delivery: { identity: "ab".repeat(32), stability: "session-stable" },
          graph: {
            resourceManifestId: "synthetic-v1",
            extensions: {},
            payload: {},
          },
        },
        compiled,
      ),
    ).toEqual({ ok: false, reason: "unsupported" });
  });

  it("maps hostile migration state to one fixed invalid result", () => {
    const { profile, snapshots } = fixture();
    const compiled = compileCompatibilityProfileForTesting(profile, snapshots);
    const hostile = new Proxy(compiled, {
      get() {
        throw new Error("CANARY_SECRET");
      },
    });
    const result = migrateSyntheticEnvelopeForTesting(
      {
        envelopeVersion: 1,
        protocolManifestId: "synthetic-v1",
        delivery: { identity: "ab".repeat(32), stability: "session-stable" },
        graph: {
          resourceManifestId: "synthetic-v1",
          extensions: {},
          payload: {},
        },
      },
      hostile,
    );
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(JSON.stringify(result)).not.toContain("CANARY_SECRET");
  });

  it("fails closed if a compiled migration edge is sabotaged at runtime", () => {
    const { profile, snapshots } = fixture();
    const compiled = compileCompatibilityProfileForTesting(profile, snapshots);
    const sabotaged = {
      ...compiled,
      profile: { ...compiled.profile, migrations: [] },
    };
    expect(
      migrateSyntheticEnvelopeForTesting(
        {
          envelopeVersion: 1,
          protocolManifestId: "synthetic-v1",
          delivery: { identity: "ab".repeat(32), stability: "session-stable" },
          graph: {
            resourceManifestId: "synthetic-v1",
            extensions: { "agentscope.synthetic.a": "safe" },
            payload: {},
          },
        },
        sabotaged,
      ),
    ).toEqual({ ok: false, reason: "unsupported" });

    const invalidDescriptor = {
      ...compiled,
      sourceArtifactsBySelector: compiled.sourceArtifactsBySelector.map(
        (artifact, index) =>
          index === 0 ? { ...artifact, descriptor: {} } : artifact,
      ),
    };
    expect(
      migrateSyntheticEnvelopeForTesting(
        {
          envelopeVersion: 1,
          protocolManifestId: "synthetic-v1",
          delivery: { identity: "ab".repeat(32), stability: "session-stable" },
          graph: {
            resourceManifestId: "synthetic-v1",
            extensions: {},
            payload: {},
          },
        },
        invalidDescriptor as never,
      ),
    ).toEqual({ ok: false, reason: "invalid" });
  });
});
