/* eslint import-x/no-cycle: "off" -- private in-process controller capability */
/**
 * Public image-preparation facade.
 *
 * Same-process implementation modules exchange the one frozen preparation set
 * or prepared-client snapshot by reference. Exact authentication remains at
 * registry, Docker/process, filesystem persistence, and cleanup boundaries.
 */
export {
  BUILDKIT_IMAGE,
  IMAGE_PREPARATION_EXECUTION_POLICY,
  IMAGE_PREPARATION_LIMITS,
  assertImagePreparationPlatformForTesting,
  authenticateDockerSocketAliasForTesting,
  classifyBuildxStderrForTesting,
  runOwnedImageCommandForTesting,
} from "./image-preparation/boundary.mjs";
export { createBoundedBuildContext } from "./image-preparation/build-context.mjs";
import { createDockerOperations } from "./image-preparation/docker.mjs";
import { createEvidenceOperations } from "./image-preparation/evidence.mjs";
export {
  readPreparedImageEvidence,
  retirePreparedImageEvidence,
  validatePreparedImageEvidence,
} from "./image-preparation/evidence.mjs";
export { probePinnedRegistryTlsForTesting } from "./image-preparation/registry.mjs";
import { createRetirementOperations } from "./image-preparation/retirement.mjs";
import { createImagePreparationState } from "./image-preparation/state.mjs";

const state = createImagePreparationState();
const docker = createDockerOperations(state.docker);
const evidence = createEvidenceOperations(state.evidence);
const retirement = createRetirementOperations(state.retirement, docker);

export const {
  buildPreparedDockerImage,
  createPreparedDockerClient,
  imagePreparationFailureRequiresOuterHostRetirement,
  prepareDockerInvocation,
  preparedDockerClientDiagnostic,
  preparePinnedDockerImages,
  revalidatePreparedImageAdmission,
} = docker;
export const { publishPreparedImageEvidence } = evidence;
export const {
  closePreparedDockerClient,
  handlePreparedDockerCleanupFailure,
  markPreparedDockerClientForOuterHostRetirement,
  preparedDockerClientRequiresOuterHostRetirement,
  retirePreparedDockerImage,
} = retirement;
