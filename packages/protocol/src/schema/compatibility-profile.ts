import profileJson from "../standards/compatibility-profile.json" with { type: "json" };
import { standardsManifest } from "../standards/manifest.js";
import { COMPATIBILITY_EXTENSION_ARCHIVE } from "./compatibility-archive.js";
import {
  CompatibilityProfileError,
  compileCompatibilityProfile,
  selectCurrentGeneration,
  validateProductionReaderWindow,
  type CompatibilitySupport,
} from "./compatibility-profile-compiler.js";
import { deepFreeze } from "./immutable.js";

const compiled = compileCompatibilityProfile(
  profileJson,
  COMPATIBILITY_EXTENSION_ARCHIVE,
);
validateProductionReaderWindow(profileJson);
const current = compiled.archive.at(-1)!;
const currentGeneration = selectCurrentGeneration(profileJson);
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
export type { CompatibilitySupport } from "./compatibility-profile-compiler.js";
