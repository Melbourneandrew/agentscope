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
  HarnessInstallationError,
  applyHarnessInstallation,
  inspectHarnessInstallation,
  resumeHarnessInstallation,
  rollbackHarnessInstallation,
} from "./installation.js";
export {
  HARNESS_HOOK_CONTRACT_VERSION,
  MAXIMUM_HOOK_DEADLINE_MILLISECONDS,
  MINIMUM_HOOK_DEADLINE_MILLISECONDS,
  HarnessLauncherError,
  createOwnedHarnessHookInvocation,
  harnessIdentityDigest,
  isOwnedHarnessHookInvocation,
} from "./launcher.js";
export {
  COMMON_NATIVE_SEMANTIC_FIELDS,
  NATIVE_BOUNDARY_KINDS,
  NATIVE_POSITION_KINDS,
  NativeMappingError,
  completeNativeCaptureBoundary,
  createEphemeralCaptureBoundary,
  createNativeFieldProvenance,
  createNativeUnavailableField,
  resolveNativeCaptureStart,
} from "./native-mapping.js";
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
export type {
  EphemeralCaptureBoundary,
  NativeBoundaryKind,
  NativeCaptureBoundary,
  NativeCaptureStart,
  NativeCheckpointRequest,
  NativeCheckpointResolver,
  NativeCheckpointResume,
  NativeFieldProvenance,
  NativeMappingSource,
  NativePositionKind,
  NativeUnavailableField,
  NativeUnavailableReason,
  NativeUnavailableState,
} from "./native-mapping.js";
export type {
  HarnessInstallationDisposition,
  HarnessInstallationPlan,
  HarnessInstallationPlanInput,
  HarnessInstallationPlanner,
  HarnessInstallationResult,
  HarnessTargetDecision,
  HarnessTargetInspection,
} from "./installation.js";
export type {
  OwnedHarnessHookInvocation,
  OwnedHarnessHookInvocationInput,
} from "./launcher.js";
