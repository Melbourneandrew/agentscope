export {
  CompatibilityProfileError,
  compileCompatibilityProfile as compileCompatibilityProfileForTesting,
  computeCompatibilitySourceFingerprints as computeCompatibilitySourceFingerprintsForTesting,
  selectCurrentGeneration as selectCurrentGenerationForTesting,
  SYNTHETIC_SOURCE_SCHEMA_DESCRIPTOR as SYNTHETIC_SOURCE_SCHEMA_DESCRIPTOR_FOR_TESTING,
  validateProductionReaderWindow as validateProductionReaderWindowForTesting,
  type CompatibilityExtensionSnapshotInput,
  type CompatibilityProfileInput,
} from "./compatibility-profile-compiler.js";
export { CURRENT_COMPATIBILITY_SOURCE_ARTIFACTS as CURRENT_SOURCE_ARTIFACTS_FOR_TESTING } from "./compatibility-archive.js";
export { migrateSyntheticEnvelope as migrateSyntheticEnvelopeForTesting } from "./compatibility-migration.js";
