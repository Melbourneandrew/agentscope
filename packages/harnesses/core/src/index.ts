export const harnessesCorePackageId = "@agentscope/harnesses-core" as const;

export {
  HarnessDescriptorError,
  compileHarnessRegistry,
  defineHarnessDescriptor,
  getHarnessDescriptor,
  isHarnessDescriptor,
  isHarnessRegistry,
} from "./descriptor.js";
export { HarnessDiscoveryError, discoverHarness } from "./discovery.js";
export {
  compareStableSemver,
  parseStableSemver,
  stableSemverIsInRange,
} from "./semver.js";
export type {
  HarnessApplyResult,
  HarnessCompatibilityRange,
  HarnessConfigurationProbe,
  HarnessConfigurationProbeResult,
  HarnessDescriptor,
  HarnessDescriptorInput,
  HarnessDiscoveryProbe,
  HarnessDiscoveryReason,
  HarnessDiscoveryResult,
  HarnessDiscoveryState,
  HarnessExecutableCandidate,
  HarnessExecutableProbe,
  HarnessExecutableProbeResult,
  HarnessInspectionResult,
  HarnessIntegrationOperations,
  HarnessNativeSourceDeclaration,
  HarnessRangeEvidence,
  HarnessRegistry,
  HarnessSupportEvidenceManifest,
  HarnessTypeId,
  HarnessVerifyResult,
  HarnessVersionProbeResult,
  StableSemver,
} from "./types.js";
