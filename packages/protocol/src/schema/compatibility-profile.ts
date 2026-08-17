import { z } from "zod";

import canonicalFixture from "../testing/fixtures/sanitized-canonical-trace.json" with { type: "json" };
import historicalV1Fixture from "../testing/fixtures/history/sanitized-canonical-trace-v1.json" with { type: "json" };
import { CODEC_PROFILE } from "../codecs/codec-profile.js";
import {
  PERSISTED_ENVELOPE_SOURCE_SCHEMA_DESCRIPTOR,
  HISTORICAL_V1_SOURCE_SCHEMA_DESCRIPTOR,
  readPersistedEnvelopeAgainstSupport,
} from "../codecs/persisted-source.js";
import profileJson from "../standards/compatibility-profile.json" with { type: "json" };
import { standardsManifest } from "../standards/manifest.js";
import historicalV1Manifest from "../standards/history/manifest-v1.json" with { type: "json" };
import { fingerprintCanonicalMaterial } from "./extensions.js";
import { deepFreeze } from "./immutable.js";

const fingerprintSchema = z.string().regex(/^sha256-[\da-f]{64}$/u);
const exactSelectorSchema = z
  .object({
    kind: z.literal("manifest"),
    manifestId: z.string().min(1).max(1024),
  })
  .strict();
const currentSelectorSchema = z.object({ kind: z.literal("current") }).strict();
const selectorSchema = z.discriminatedUnion("kind", [
  exactSelectorSchema,
  currentSelectorSchema,
]);
const generationSchema = z
  .object({
    selector: selectorSchema,
    protocolContractVersion: z.number().int().positive().safe(),
    envelopeVersion: z.number().int().positive().safe(),
    sourceSchemaId: z.string().regex(/^[a-z][a-z\d-]{0,63}$/u),
    sourceSchemaKind: z.enum([
      "canonical-envelope-v1",
      "synthetic-envelope-v1",
    ]),
    sourceSchemaFingerprint: fingerprintSchema,
    sourceFixtureFingerprint: fingerprintSchema,
    upstreamBaselineId: z.string().min(1).max(512),
    canonicalProfileFingerprint: fingerprintSchema,
    semanticDescriptorFingerprint: fingerprintSchema,
    timingDescriptorFingerprint: fingerprintSchema,
    identityProfileFingerprint: fingerprintSchema,
    extensionRegistryVersion: z.number().int().positive().safe(),
    extensionRegistryFingerprint: fingerprintSchema,
    codecProfileFingerprint: fingerprintSchema,
    generationFingerprint: fingerprintSchema,
  })
  .strict();
const migrationSchema = z
  .object({
    migrationId: z.string().regex(/^[a-z][a-z\d-]{0,63}$/u),
    kind: z.literal("adjacent-forward"),
    source: selectorSchema,
    target: selectorSchema,
    identityRule: z.literal("preserve-if-profile-equal"),
    manifestRule: z.literal("replace-outer-and-resource-manifest"),
  })
  .strict();
const profileSchema = z
  .object({
    profileVersion: z.literal(1),
    profileFingerprint: fingerprintSchema,
    ordering: z.literal("protocol-contract-version-only"),
    dispatch: z.literal("exact-envelope-version-and-manifest-id"),
    archivePolicy: z.literal("whole-protocol-generation"),
    extensionLineage: z.literal("append-only-immutable-no-retirement"),
    identityPreservation: z.literal("equal-identity-profile-fingerprint-only"),
    migrationPolicy: z.literal("adjacent-forward-strict-fresh-unbranded"),
    limits: z
      .object({
        maximumGenerations: z.number().int().positive().max(64),
        maximumMigrations: z.number().int().nonnegative().max(63),
        maximumExtensionsPerGeneration: z.number().int().positive().max(256),
        maximumMigrationWorkUnits: z.number().int().positive().max(65_536),
      })
      .strict(),
    generations: z.array(generationSchema).min(1).max(64),
    readerWindow: z
      .array(
        z
          .object({
            selector: selectorSchema,
            envelopeVersion: z.number().int().positive().safe(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    migrations: z.array(migrationSchema).max(63),
  })
  .strict();

const extensionSnapshotSchema = z
  .object({
    selector: selectorSchema,
    registryFingerprint: fingerprintSchema,
    entries: z.array(z.record(z.string(), z.unknown())).max(256),
    sourceSchemaDescriptor: z.unknown(),
    sourceFixture: z.unknown(),
  })
  .strict();

type Profile = z.infer<typeof profileSchema>;
type Selector = z.infer<typeof selectorSchema>;
export type CompatibilityProfileInput = z.input<typeof profileSchema>;
export type CompatibilityExtensionSnapshotInput = z.input<
  typeof extensionSnapshotSchema
>;
export type CompatibilitySupport = Readonly<{
  protocolContractVersion: number;
  envelopeVersion: number;
  manifestId: string;
}>;

export class CompatibilityProfileError extends Error {
  public constructor() {
    super("protocol.compatibility.invalid");
    this.name = "CompatibilityProfileError";
  }
}

const assertBoundedPlainData = (
  input: unknown,
  limits: Readonly<{ nodes: number; keys: number; stringCodeUnits: number }>,
) => {
  const pending: unknown[] = [input];
  const seen = new Set<object>();
  let nodes = 0;
  let keys = 0;
  let stringCodeUnits = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    nodes += 1;
    if (nodes > limits.nodes) throw new CompatibilityProfileError();
    if (typeof value === "string") {
      stringCodeUnits += value.length;
      if (stringCodeUnits > limits.stringCodeUnits)
        throw new CompatibilityProfileError();
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    if (seen.has(value)) throw new CompatibilityProfileError();
    seen.add(value);
    const prototype = Reflect.getPrototypeOf(value);
    if (
      prototype !== Object.prototype &&
      prototype !== Array.prototype &&
      prototype !== null
    ) {
      throw new CompatibilityProfileError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.keys(descriptors);
    if (Object.getOwnPropertySymbols(value).length > 0)
      throw new CompatibilityProfileError();
    keys += names.length;
    if (keys > limits.keys) throw new CompatibilityProfileError();
    if (Array.isArray(value)) {
      if (
        names.some(
          (name) => name !== "length" && !/^(?:0|[1-9]\d*)$/u.test(name),
        )
      )
        throw new CompatibilityProfileError();
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor))
          throw new CompatibilityProfileError();
        pending.push(descriptor.value);
      }
      continue;
    }
    for (const name of names) {
      const descriptor = descriptors[name]!;
      if (!("value" in descriptor)) throw new CompatibilityProfileError();
      stringCodeUnits += name.length;
      if (stringCodeUnits > limits.stringCodeUnits)
        throw new CompatibilityProfileError();
      pending.push(descriptor.value);
    }
  }
};

const SYNTHETIC_SOURCE_SCHEMA_DESCRIPTOR = deepFreeze({
  descriptorVersion: 1,
  schemaKind: "synthetic-envelope-v1",
  unknownFields: "reject",
  envelope: {
    version: { integer: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    manifestId: { minimumLength: 1, maximumLength: 1024 },
    deliveryIdentityPattern: "^[\\da-f]{64}$",
    stabilityValues: [
      "session-stable",
      "boundary-scoped-at-least-once",
      "attempt-scoped-at-least-once",
    ],
  },
  graph: {
    recordKey: { minimumLength: 1, maximumLength: 128 },
    recordValue: { maximumLength: 1024 },
    maximumRecordEntries: 256,
  },
} as const);
export const SYNTHETIC_SOURCE_SCHEMA_DESCRIPTOR_FOR_TESTING =
  SYNTHETIC_SOURCE_SCHEMA_DESCRIPTOR;

const syntheticDescriptorSchema = z
  .object({
    descriptorVersion: z.literal(1),
    schemaKind: z.literal("synthetic-envelope-v1"),
    unknownFields: z.literal("reject"),
    envelope: z
      .object({
        version: z
          .object({
            integer: z.literal(true),
            minimum: z.number().int().positive().safe(),
            maximum: z.number().int().positive().safe(),
          })
          .strict(),
        manifestId: z
          .object({
            minimumLength: z.number().int().positive().max(1024),
            maximumLength: z.number().int().positive().max(1024),
          })
          .strict(),
        deliveryIdentityPattern: z.literal("^[\\da-f]{64}$"),
        stabilityValues: z
          .array(
            z.enum([
              "session-stable",
              "boundary-scoped-at-least-once",
              "attempt-scoped-at-least-once",
            ]),
          )
          .length(3),
      })
      .strict(),
    graph: z
      .object({
        recordKey: z
          .object({
            minimumLength: z.number().int().positive().max(128),
            maximumLength: z.number().int().positive().max(128),
          })
          .strict(),
        recordValue: z
          .object({
            maximumLength: z.number().int().positive().max(1024),
          })
          .strict(),
        maximumRecordEntries: z.number().int().positive().max(256),
      })
      .strict(),
  })
  .strict();

type SyntheticEnvelope = Readonly<{
  envelopeVersion: number;
  protocolManifestId: string;
  delivery: Readonly<{ identity: string; stability: string }>;
  graph: Readonly<{
    resourceManifestId: string;
    extensions: Readonly<Record<string, string>>;
    payload: Readonly<Record<string, string>>;
  }>;
}>;

const createSyntheticEnvelopeSchema = (
  descriptor: z.infer<typeof syntheticDescriptorSchema>,
) => {
  const record = z.record(
    z
      .string()
      .min(descriptor.graph.recordKey.minimumLength)
      .max(descriptor.graph.recordKey.maximumLength),
    z.string().max(descriptor.graph.recordValue.maximumLength),
  );
  return z
    .object({
      envelopeVersion: z
        .number()
        .int()
        .min(descriptor.envelope.version.minimum)
        .max(descriptor.envelope.version.maximum)
        .safe(),
      protocolManifestId: z
        .string()
        .min(descriptor.envelope.manifestId.minimumLength)
        .max(descriptor.envelope.manifestId.maximumLength),
      delivery: z
        .object({
          identity: z
            .string()
            .regex(
              new RegExp(descriptor.envelope.deliveryIdentityPattern, "u"),
            ),
          stability: z
            .string()
            .refine((value) =>
              descriptor.envelope.stabilityValues.includes(
                value as (typeof descriptor.envelope.stabilityValues)[number],
              ),
            ),
        })
        .strict(),
      graph: z
        .object({
          resourceManifestId: z
            .string()
            .min(descriptor.envelope.manifestId.minimumLength)
            .max(descriptor.envelope.manifestId.maximumLength),
          extensions: record.refine(
            (value) =>
              Object.keys(value).length <=
              descriptor.graph.maximumRecordEntries,
          ),
          payload: record.refine(
            (value) =>
              Object.keys(value).length <=
              descriptor.graph.maximumRecordEntries,
          ),
        })
        .strict(),
    })
    .strict();
};

export type SyntheticMigrationResult =
  | Readonly<{ ok: true; value: SyntheticEnvelope }>
  | Readonly<{ ok: false; reason: "invalid" | "unsupported" }>;

const selectorKey = (selector: Selector) =>
  selector.kind === "current" ? "current" : `manifest:${selector.manifestId}`;

const resolvedManifestId = (selector: Selector) =>
  selector.kind === "current"
    ? standardsManifest.manifestId
    : selector.manifestId;

const withoutFingerprint = (value: Profile) => {
  const material: Partial<Profile> = { ...value };
  delete material.profileFingerprint;
  return material;
};

const generationMaterial = (generation: Profile["generations"][number]) => {
  const material: Partial<typeof generation> = { ...generation };
  delete material.generationFingerprint;
  return material;
};

const entryIdentity = (entry: Record<string, unknown>) => {
  const key = entry.key;
  const semantic = entry.semantic;
  const introduced = entry.introducedInProtocolContractVersion;
  if (
    typeof key !== "string" ||
    typeof semantic !== "string" ||
    typeof introduced !== "number" ||
    !Number.isSafeInteger(introduced) ||
    introduced <= 0
  ) {
    throw new CompatibilityProfileError();
  }
  return { key, semantic, introduced };
};

const assertExtensionLineage = (
  generations: Profile["generations"],
  snapshots: readonly z.infer<typeof extensionSnapshotSchema>[],
  maximumExtensions: number,
) => {
  const bySelector = new Map(
    snapshots.map((item) => [selectorKey(item.selector), item]),
  );
  if (
    bySelector.size !== snapshots.length ||
    bySelector.size !== generations.length ||
    snapshots.some(
      ({ selector }) =>
        !generations.some(
          (generation) =>
            selectorKey(generation.selector) === selectorKey(selector),
        ),
    )
  ) {
    throw new CompatibilityProfileError();
  }
  const permanentKeys = new Map<
    string,
    { semantic: string; material: string; introduced: number }
  >();
  const permanentSemantics = new Map<string, string>();
  for (const generation of generations) {
    const snapshot = bySelector.get(selectorKey(generation.selector));
    if (
      snapshot === undefined ||
      snapshot.registryFingerprint !==
        generation.extensionRegistryFingerprint ||
      snapshot.entries.length > maximumExtensions ||
      fingerprintCanonicalMaterial(snapshot.entries) !==
        snapshot.registryFingerprint
    ) {
      throw new CompatibilityProfileError();
    }
    const present = new Set<string>();
    for (const entry of snapshot.entries) {
      const { key, semantic, introduced } = entryIdentity(entry);
      if (introduced > generation.protocolContractVersion || present.has(key)) {
        throw new CompatibilityProfileError();
      }
      present.add(key);
      const material = JSON.stringify(entry);
      const prior = permanentKeys.get(key);
      const semanticOwner = permanentSemantics.get(semantic);
      if (prior === undefined) {
        if (
          introduced !== generation.protocolContractVersion ||
          semanticOwner !== undefined
        ) {
          throw new CompatibilityProfileError();
        }
        permanentKeys.set(key, { semantic, material, introduced });
        permanentSemantics.set(semantic, key);
      } else if (
        prior.semantic !== semantic ||
        prior.material !== material ||
        prior.introduced !== introduced ||
        semanticOwner !== key
      ) {
        throw new CompatibilityProfileError();
      }
    }
    for (const key of permanentKeys.keys()) {
      if (!present.has(key)) throw new CompatibilityProfileError();
    }
  }
  return bySelector;
};

const sourceSchemaMaterial = (
  generation: Profile["generations"][number],
  snapshot: z.infer<typeof extensionSnapshotSchema>,
) => ({
  sourceSchemaId: generation.sourceSchemaId,
  sourceSchemaKind: generation.sourceSchemaKind,
  descriptor: snapshot.sourceSchemaDescriptor,
  extensionRegistryFingerprint: snapshot.registryFingerprint,
  extensionKeys: snapshot.entries
    .map((entry) => entryIdentity(entry).key)
    .sort(),
});

export const computeCompatibilitySourceFingerprintsForTesting = (
  generationInput: unknown,
  snapshotInput: unknown,
) => {
  try {
    const generation = generationSchema.parse(generationInput);
    const snapshot = extensionSnapshotSchema.parse(snapshotInput);
    return deepFreeze({
      sourceSchemaFingerprint: fingerprintCanonicalMaterial(
        sourceSchemaMaterial(generation, snapshot),
      ),
      sourceFixtureFingerprint: fingerprintCanonicalMaterial(
        snapshot.sourceFixture,
      ),
    });
  } catch {
    throw new CompatibilityProfileError();
  }
};

const replaceCurrentManifestToken = (
  value: unknown,
  source: string,
  target: string,
): unknown => {
  if (typeof value === "string") return value === source ? target : value;
  if (Array.isArray(value))
    return value.map((entry) =>
      replaceCurrentManifestToken(entry, source, target),
    );
  if (typeof value !== "object" || value === null) return value;
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value))
    output[key] = replaceCurrentManifestToken(entry, source, target);
  return output;
};

const parseSyntheticSourceArtifact = (
  generation: Profile["generations"][number],
  snapshot: z.infer<typeof extensionSnapshotSchema>,
) => {
  const descriptor = syntheticDescriptorSchema.parse(
    snapshot.sourceSchemaDescriptor,
  );
  const parsed = createSyntheticEnvelopeSchema(descriptor).parse(
    snapshot.sourceFixture,
  );
  const manifestId = resolvedManifestId(generation.selector);
  const allowedKeys = new Set(
    snapshot.entries.map((entry) => entryIdentity(entry).key),
  );
  if (
    generation.sourceSchemaId !== descriptor.schemaKind ||
    generation.envelopeVersion !== parsed.envelopeVersion ||
    parsed.protocolManifestId !== manifestId ||
    parsed.graph.resourceManifestId !== manifestId ||
    Object.keys(parsed.graph.extensions).some((key) => !allowedKeys.has(key))
  ) {
    throw new CompatibilityProfileError();
  }
  return descriptor;
};

const parseCanonicalSourceArtifact = (
  generation: Profile["generations"][number],
  snapshot: z.infer<typeof extensionSnapshotSchema>,
) => {
  /* v8 ignore next -- production archive contains the exact historical/current pair */
  const expectedDescriptor =
    generation.protocolContractVersion === 1
      ? HISTORICAL_V1_SOURCE_SCHEMA_DESCRIPTOR
      : PERSISTED_ENVELOPE_SOURCE_SCHEMA_DESCRIPTOR;
  /* v8 ignore next -- production descriptors are compiler-generated exact artifacts */
  if (
    generation.sourceSchemaId !==
      PERSISTED_ENVELOPE_SOURCE_SCHEMA_DESCRIPTOR.schemaKind ||
    fingerprintCanonicalMaterial(snapshot.sourceSchemaDescriptor) !==
      fingerprintCanonicalMaterial(expectedDescriptor)
  ) {
    /* v8 ignore next -- exact production descriptor mismatch is covered by fingerprint mutation tests */
    throw new CompatibilityProfileError();
  }
  const materialized =
    generation.selector.kind === "current"
      ? replaceCurrentManifestToken(
          snapshot.sourceFixture,
          "$current",
          standardsManifest.manifestId,
        )
      : snapshot.sourceFixture;
  const result = readPersistedEnvelopeAgainstSupport(
    JSON.stringify(materialized),
    [
      {
        manifestId: resolvedManifestId(generation.selector),
        envelopeVersion: generation.envelopeVersion,
        protocolContractVersion: generation.protocolContractVersion,
      },
    ],
  );
  /* v8 ignore next -- compiled literal artifacts guarantee a successful exact read */
  if (
    !result.ok ||
    result.envelope.envelopeVersion !== generation.envelopeVersion
  ) {
    /* v8 ignore next -- literal source fixture startup guard */
    throw new CompatibilityProfileError();
  }
  return expectedDescriptor;
};

const parseCompatibilityInputs = (
  input: unknown,
  extensionSnapshotsInput: unknown,
) => {
  assertBoundedPlainData(input, {
    nodes: 16_384,
    keys: 65_536,
    stringCodeUnits: 1_048_576,
  });
  assertBoundedPlainData(extensionSnapshotsInput, {
    nodes: 16_384,
    keys: 65_536,
    stringCodeUnits: 1_048_576,
  });
  return {
    profile: profileSchema.parse(input),
    snapshots: z.array(extensionSnapshotSchema).parse(extensionSnapshotsInput),
  };
};

const compileGenerationArchive = (profile: Profile) => {
  const selectorKeys = profile.generations.map(({ selector }) =>
    selectorKey(selector),
  );
  if (new Set(selectorKeys).size !== selectorKeys.length) {
    throw new CompatibilityProfileError();
  }
  let currentCount = 0;
  for (let index = 0; index < profile.generations.length; index += 1) {
    const generation = profile.generations[index]!;
    const prior = profile.generations[index - 1];
    if (
      fingerprintCanonicalMaterial(generationMaterial(generation)) !==
        generation.generationFingerprint ||
      (prior !== undefined &&
        generation.protocolContractVersion !==
          prior.protocolContractVersion + 1)
    ) {
      throw new CompatibilityProfileError();
    }
    if (generation.selector.kind === "current") {
      currentCount += 1;
      if (index !== profile.generations.length - 1) {
        throw new CompatibilityProfileError();
      }
    }
  }
  const resolvedIds = profile.generations.map(({ selector }) =>
    resolvedManifestId(selector),
  );
  if (currentCount !== 1 || new Set(resolvedIds).size !== resolvedIds.length) {
    throw new CompatibilityProfileError();
  }
  return {
    selectorKeys,
    archive: new Map(
      profile.generations.map((generation) => [
        selectorKey(generation.selector),
        generation,
      ]),
    ),
  };
};

const compileReaderWindow = (
  profile: Profile,
  archive: ReturnType<typeof compileGenerationArchive>["archive"],
) => {
  const windowKeys = new Set<string>();
  const supported = profile.readerWindow.map(
    ({ selector, envelopeVersion }) => {
      const key = selectorKey(selector);
      const generation = archive.get(key);
      if (
        generation === undefined ||
        generation.envelopeVersion !== envelopeVersion ||
        windowKeys.has(key)
      ) {
        throw new CompatibilityProfileError();
      }
      windowKeys.add(key);
      return {
        protocolContractVersion: generation.protocolContractVersion,
        envelopeVersion: generation.envelopeVersion,
        manifestId: resolvedManifestId(selector),
      };
    },
  );
  if (!windowKeys.has("current")) throw new CompatibilityProfileError();
  return supported;
};

const assertMigrationGraph = (
  profile: Profile,
  selectorKeys: readonly string[],
) => {
  const migrationIds = new Set<string>();
  const migrationEdges = new Set<string>();
  for (const migration of profile.migrations) {
    const sourceIndex = selectorKeys.indexOf(selectorKey(migration.source));
    const targetIndex = selectorKeys.indexOf(selectorKey(migration.target));
    const edge = `${sourceIndex}:${targetIndex}`;
    if (
      sourceIndex < 0 ||
      targetIndex !== sourceIndex + 1 ||
      migrationIds.has(migration.migrationId) ||
      migrationEdges.has(edge) ||
      profile.generations[sourceIndex]!.identityProfileFingerprint !==
        profile.generations[targetIndex]!.identityProfileFingerprint
    ) {
      throw new CompatibilityProfileError();
    }
    migrationIds.add(migration.migrationId);
    migrationEdges.add(edge);
  }
  for (let index = 0; index < selectorKeys.length - 1; index += 1) {
    if (!migrationEdges.has(`${index}:${index + 1}`)) {
      throw new CompatibilityProfileError();
    }
  }
};

const compileSourceArtifacts = (
  profile: Profile,
  snapshots: readonly z.infer<typeof extensionSnapshotSchema>[],
) => {
  const snapshotsBySelector = assertExtensionLineage(
    profile.generations,
    snapshots,
    profile.limits.maximumExtensionsPerGeneration,
  );
  const sourceArtifactsBySelector = profile.generations.map((generation) => {
    const snapshot = snapshotsBySelector.get(selectorKey(generation.selector));
    /* v8 ignore next -- exact snapshot inventory is proven by assertExtensionLineage */
    if (snapshot === undefined) throw new CompatibilityProfileError();
    const fingerprints = computeCompatibilitySourceFingerprintsForTesting(
      generation,
      snapshot,
    );
    if (
      generation.sourceSchemaFingerprint !==
        fingerprints.sourceSchemaFingerprint ||
      generation.sourceFixtureFingerprint !==
        fingerprints.sourceFixtureFingerprint
    ) {
      throw new CompatibilityProfileError();
    }
    const descriptor =
      generation.sourceSchemaKind === "synthetic-envelope-v1"
        ? parseSyntheticSourceArtifact(generation, snapshot)
        : parseCanonicalSourceArtifact(generation, snapshot);
    return {
      selector: selectorKey(generation.selector),
      keys: snapshot.entries.map((entry) => entryIdentity(entry).key).sort(),
      descriptor,
    };
  });
  return sourceArtifactsBySelector;
};

export const compileCompatibilityProfileForTesting = (
  input: unknown,
  extensionSnapshotsInput: unknown,
) => {
  try {
    const { profile, snapshots } = parseCompatibilityInputs(
      input,
      extensionSnapshotsInput,
    );
    if (
      profile.generations.length > profile.limits.maximumGenerations ||
      profile.migrations.length > profile.limits.maximumMigrations ||
      fingerprintCanonicalMaterial(withoutFingerprint(profile)) !==
        profile.profileFingerprint
    ) {
      throw new CompatibilityProfileError();
    }
    const { selectorKeys, archive } = compileGenerationArchive(profile);
    const supported = compileReaderWindow(profile, archive);
    assertMigrationGraph(profile, selectorKeys);
    const sourceArtifactsBySelector = compileSourceArtifacts(
      profile,
      snapshots,
    );
    const archiveValues = profile.generations.map((generation) => ({
      protocolContractVersion: generation.protocolContractVersion,
      envelopeVersion: generation.envelopeVersion,
      manifestId: resolvedManifestId(generation.selector),
    }));
    return deepFreeze({
      profile,
      archive: archiveValues,
      supported,
      sourceArtifactsBySelector,
    });
  } catch (error) {
    if (error instanceof CompatibilityProfileError) throw error;
    throw new CompatibilityProfileError();
  }
};

export const selectCurrentGenerationForTesting = (input: unknown) => {
  try {
    assertBoundedPlainData(input, {
      nodes: 16_384,
      keys: 65_536,
      stringCodeUnits: 1_048_576,
    });
    const profile = profileSchema.parse(input);
    const current = profile.generations.filter(
      ({ selector }) => selector.kind === "current",
    );
    if (current.length !== 1) throw new CompatibilityProfileError();
    return deepFreeze(current[0]!);
  } catch (error) {
    if (error instanceof CompatibilityProfileError) throw error;
    throw new CompatibilityProfileError();
  }
};

export const validateProductionReaderWindowForTesting = (input: unknown) => {
  try {
    const profile = profileSchema.parse(input);
    if (
      profile.generations.some(
        ({ sourceSchemaKind }) => sourceSchemaKind !== "canonical-envelope-v1",
      )
    ) {
      throw new CompatibilityProfileError();
    }
    const codecWindow =
      CODEC_PROFILE.persistedEnvelopeReader.supportedManifests;
    if (codecWindow.length !== profile.readerWindow.length)
      throw new CompatibilityProfileError();
    for (const { selector, envelopeVersion } of profile.readerWindow) {
      const generation = profile.generations.find(
        (candidate) =>
          selectorKey(candidate.selector) === selectorKey(selector),
      );
      if (
        generation === undefined ||
        generation.sourceSchemaKind !== "canonical-envelope-v1" ||
        generation.envelopeVersion !== envelopeVersion ||
        !codecWindow.some(
          (entry) =>
            entry.selector === selector.kind &&
            entry.envelopeVersion === envelopeVersion,
        )
      ) {
        throw new CompatibilityProfileError();
      }
    }
    return true;
  } catch (error) {
    if (error instanceof CompatibilityProfileError) throw error;
    throw new CompatibilityProfileError();
  }
};

export const migrateSyntheticEnvelopeForTesting = (
  input: unknown,
  compiledInput: ReturnType<typeof compileCompatibilityProfileForTesting>,
): SyntheticMigrationResult => {
  try {
    assertBoundedPlainData(input, {
      nodes: 2_048,
      keys: 8_192,
      stringCodeUnits: 1_048_576,
    });
    const candidate = input as {
      protocolManifestId?: unknown;
      envelopeVersion?: unknown;
    };
    const sourceIndex = compiledInput.archive.findIndex(
      (generation) =>
        generation.manifestId === candidate.protocolManifestId &&
        generation.envelopeVersion === candidate.envelopeVersion,
    );
    if (sourceIndex < 0)
      return deepFreeze({ ok: false, reason: "unsupported" });
    const sourceDescriptor =
      compiledInput.sourceArtifactsBySelector[sourceIndex]?.descriptor;
    const descriptor = syntheticDescriptorSchema.safeParse(sourceDescriptor);
    if (!descriptor.success)
      return deepFreeze({ ok: false, reason: "invalid" });
    const parsed = createSyntheticEnvelopeSchema(descriptor.data).safeParse(
      input,
    );
    if (!parsed.success) return deepFreeze({ ok: false, reason: "invalid" });
    const sourceSelector =
      compiledInput.profile.generations[sourceIndex]?.selector;
    if (
      sourceSelector === undefined ||
      !compiledInput.profile.readerWindow.some(
        ({ selector }) => selectorKey(selector) === selectorKey(sourceSelector),
      )
    ) {
      return deepFreeze({ ok: false, reason: "unsupported" });
    }
    if (
      parsed.data.graph.resourceManifestId !== parsed.data.protocolManifestId
    ) {
      return deepFreeze({ ok: false, reason: "invalid" });
    }
    const sourceExtensionKeys =
      compiledInput.sourceArtifactsBySelector[sourceIndex]?.keys;
    if (
      sourceExtensionKeys === undefined ||
      Object.keys(parsed.data.graph.extensions).some(
        (key) => !sourceExtensionKeys.includes(key),
      )
    ) {
      return deepFreeze({ ok: false, reason: "invalid" });
    }
    const work =
      Object.keys(parsed.data.graph.extensions).length +
      Object.keys(parsed.data.graph.payload).length +
      compiledInput.archive.length -
      sourceIndex;
    if (work > compiledInput.profile.limits.maximumMigrationWorkUnits) {
      return deepFreeze({ ok: false, reason: "unsupported" });
    }
    let value = {
      envelopeVersion: parsed.data.envelopeVersion,
      protocolManifestId: parsed.data.protocolManifestId,
      delivery: { ...parsed.data.delivery },
      graph: {
        resourceManifestId: parsed.data.graph.resourceManifestId,
        extensions: { ...parsed.data.graph.extensions },
        payload: { ...parsed.data.graph.payload },
      },
    };
    for (
      let generationIndex = sourceIndex;
      generationIndex < compiledInput.archive.length - 1;
      generationIndex += 1
    ) {
      const sourceSelector =
        compiledInput.profile.generations[generationIndex]?.selector;
      const targetSelector =
        compiledInput.profile.generations[generationIndex + 1]?.selector;
      const migration = compiledInput.profile.migrations.find(
        (candidate) =>
          sourceSelector !== undefined &&
          targetSelector !== undefined &&
          selectorKey(candidate.source) === selectorKey(sourceSelector) &&
          selectorKey(candidate.target) === selectorKey(targetSelector),
      );
      const target = compiledInput.archive[generationIndex + 1];
      if (migration === undefined || target === undefined) {
        return deepFreeze({ ok: false, reason: "unsupported" });
      }
      value = {
        envelopeVersion: target.envelopeVersion,
        protocolManifestId: target.manifestId,
        delivery: { ...value.delivery },
        graph: {
          resourceManifestId: target.manifestId,
          extensions: { ...value.graph.extensions },
          payload: { ...value.graph.payload },
        },
      };
    }
    return deepFreeze({ ok: true, value });
  } catch {
    return deepFreeze({ ok: false, reason: "invalid" });
  }
};

export const CURRENT_SOURCE_ARTIFACTS_FOR_TESTING = deepFreeze({
  sourceSchemaDescriptor: PERSISTED_ENVELOPE_SOURCE_SCHEMA_DESCRIPTOR,
  sourceFixture: {
    envelopeVersion: 1,
    protocolManifestId: "$current",
    delivery: {
      identity: "ab".repeat(32),
      stability: "session-stable",
    },
    graph: replaceCurrentManifestToken(
      canonicalFixture,
      standardsManifest.manifestId,
      "$current",
    ),
  },
});

const currentSnapshot = {
  selector: { kind: "current" as const },
  registryFingerprint:
    standardsManifest.agentscopeExtensions.registryFingerprint,
  entries: standardsManifest.agentscopeExtensions.entries,
  ...CURRENT_SOURCE_ARTIFACTS_FOR_TESTING,
};

const historicalV1Snapshot = {
  selector: {
    kind: "manifest" as const,
    manifestId: historicalV1Manifest.manifestId,
  },
  registryFingerprint:
    historicalV1Manifest.agentscopeExtensions.registryFingerprint,
  entries: historicalV1Manifest.agentscopeExtensions.entries,
  sourceSchemaDescriptor: HISTORICAL_V1_SOURCE_SCHEMA_DESCRIPTOR,
  sourceFixture: {
    envelopeVersion: 1,
    protocolManifestId: historicalV1Manifest.manifestId,
    delivery: {
      identity: "ab".repeat(32),
      stability: "session-stable",
    },
    graph: historicalV1Fixture,
  },
};

const compiled = compileCompatibilityProfileForTesting(profileJson, [
  historicalV1Snapshot,
  currentSnapshot,
]);
validateProductionReaderWindowForTesting(profileJson);
const current = compiled.archive.at(-1)!;
const currentGeneration = selectCurrentGenerationForTesting(profileJson);
/* v8 ignore next 23 -- startup identity drift is exercised through the compiler mutation matrix */
if (
  profileJson.profileVersion !==
    standardsManifest.compatibilityProfile.profileVersion ||
  profileJson.profileFingerprint !==
    standardsManifest.compatibilityProfile.profileFingerprint ||
  current.protocolContractVersion !==
    standardsManifest.protocolContractVersion ||
  current.envelopeVersion !== 1 ||
  currentGeneration.upstreamBaselineId !==
    standardsManifest.upstreamBaselineId ||
  currentGeneration.canonicalProfileFingerprint !==
    standardsManifest.canonicalProfile.profileFingerprint ||
  currentGeneration.semanticDescriptorFingerprint !==
    standardsManifest.canonicalProfile.semanticDescriptorFingerprint ||
  currentGeneration.timingDescriptorFingerprint !==
    standardsManifest.canonicalProfile.timingDescriptorFingerprint ||
  currentGeneration.identityProfileFingerprint !==
    standardsManifest.identityProfile.profileFingerprint ||
  currentGeneration.extensionRegistryVersion !==
    standardsManifest.agentscopeExtensions.registryVersion ||
  currentGeneration.extensionRegistryFingerprint !==
    standardsManifest.agentscopeExtensions.registryFingerprint ||
  currentGeneration.codecProfileFingerprint !==
    standardsManifest.codecProfile.profileFingerprint
) {
  throw new CompatibilityProfileError();
}

export const PROTOCOL_COMPATIBILITY_PROFILE = deepFreeze(profileJson);
export const PROTOCOL_COMPATIBILITY_FINGERPRINT =
  profileJson.profileFingerprint;
export const SUPPORTED_PROTOCOL_GENERATIONS = deepFreeze(
  compiled.supported as readonly CompatibilitySupport[],
);
