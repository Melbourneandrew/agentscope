import {
  assertBoundedPlainData,
  createSyntheticEnvelopeSchema,
  selectorKey,
  syntheticDescriptorSchema,
  type SyntheticMigrationResult,
  type compileCompatibilityProfile,
} from "./compatibility-profile-compiler.js";
import { deepFreeze } from "./immutable.js";

export const migrateSyntheticEnvelope = (
  input: unknown,
  compiledInput: ReturnType<typeof compileCompatibilityProfile>,
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
    )
      return deepFreeze({ ok: false, reason: "unsupported" });
    if (parsed.data.graph.resourceManifestId !== parsed.data.protocolManifestId)
      return deepFreeze({ ok: false, reason: "invalid" });
    const sourceExtensionKeys =
      compiledInput.sourceArtifactsBySelector[sourceIndex]?.keys;
    if (
      sourceExtensionKeys === undefined ||
      Object.keys(parsed.data.graph.extensions).some(
        (key) => !sourceExtensionKeys.includes(key),
      )
    )
      return deepFreeze({ ok: false, reason: "invalid" });
    const work =
      Object.keys(parsed.data.graph.extensions).length +
      Object.keys(parsed.data.graph.payload).length +
      compiledInput.archive.length -
      sourceIndex;
    if (work > compiledInput.profile.limits.maximumMigrationWorkUnits)
      return deepFreeze({ ok: false, reason: "unsupported" });
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
      const source =
        compiledInput.profile.generations[generationIndex]?.selector;
      const target =
        compiledInput.profile.generations[generationIndex + 1]?.selector;
      const migration = compiledInput.profile.migrations.find(
        (candidateMigration) =>
          source !== undefined &&
          target !== undefined &&
          selectorKey(candidateMigration.source) === selectorKey(source) &&
          selectorKey(candidateMigration.target) === selectorKey(target),
      );
      const targetGeneration = compiledInput.archive[generationIndex + 1];
      if (migration === undefined || targetGeneration === undefined)
        return deepFreeze({ ok: false, reason: "unsupported" });
      value = {
        envelopeVersion: targetGeneration.envelopeVersion,
        protocolManifestId: targetGeneration.manifestId,
        delivery: { ...value.delivery },
        graph: {
          resourceManifestId: targetGeneration.manifestId,
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

export type { SyntheticMigrationResult } from "./compatibility-profile-compiler.js";
