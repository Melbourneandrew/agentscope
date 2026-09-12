import { canonicalJson, deepFreeze, sha256 } from "./canonical.js";
import type {
  HarnessAdmissionCompletion,
  HarnessAdmissionSeed,
} from "./harness-admission.js";
import type { CapabilityManifest, CapabilityScenario } from "./manifest.js";

type HarnessEvidence = CapabilityManifest["evidence"][number];

const invalid = (): never => {
  throw new Error("integration.harness-scenario-admission.invalid");
};

export const compileHarnessAdmissionSeed = (
  input: Readonly<{
    candidateDigest: string;
    destinationCombinationIdentity: string;
    evidence: HarnessEvidence;
    manifestIdentity: string;
    materialIdentity: string;
    platformIdentity: string;
    preparedImage: HarnessAdmissionSeed["preparedImage"];
    runId: string;
    scenario: CapabilityScenario;
  }>,
): HarnessAdmissionSeed => {
  const { admission, material } = input.evidence;
  if (
    material.kind === "certification-fixture" ||
    admission === undefined ||
    material.platformIdentity !== input.platformIdentity ||
    input.scenario.harnessEvidenceId !== input.evidence.evidenceId
  )
    return invalid();
  if (material.kind === "npm") {
    const rootPackages = material.packages.filter(
      ({ installName, packageName, version }) =>
        installName === packageName &&
        version === input.evidence.representativeVersion,
    );
    if (
      rootPackages.length !== 1 ||
      admission.distributionReference !==
        `npm:${rootPackages[0]!.packageName}@${rootPackages[0]!.version}`
    )
      return invalid();
  } else if (
    material.version !== input.evidence.representativeVersion ||
    admission.distributionReference !==
      `signed-manifest:${material.distributionId}@${material.version}#${material.platform}`
  )
    return invalid();
  const harnessArtifact = {
    registryIdentity: input.evidence.harnessPackage,
    exactVersion: input.evidence.representativeVersion,
    distributionReference: admission.distributionReference,
    artifactDigest: input.materialIdentity,
  };
  const harness = {
    ...harnessArtifact,
    evidenceSlot: admission.evidenceSlot,
    eligibleRange: admission.eligibleRange,
    artifactAuthorityDigest: sha256(canonicalJson(harnessArtifact)),
  };
  const execution = {
    mode: input.scenario.executionMode,
    outputContract: input.scenario.outputContract,
  };
  const catalogRow = {
    productIdentity: "agentscope-cli" as const,
    harness: {
      registryIdentity: harness.registryIdentity,
      evidenceSlot: harness.evidenceSlot,
      exactVersion: harness.exactVersion,
    },
    execution,
    platformIdentity: input.platformIdentity,
    destinationCombinationIdentity: input.destinationCombinationIdentity,
  };
  return deepFreeze({
    admissionVersion: 1,
    runId: input.runId,
    candidateDigest: input.candidateDigest,
    manifestIdentity: input.manifestIdentity,
    scenarioId: input.scenario.scenarioId,
    catalogRowIdentity: sha256(canonicalJson(catalogRow)),
    productIdentity: "agentscope-cli",
    harness,
    execution,
    component: {
      fixtureDigest: `sha256-${admission.component.fixture.sha256}`,
      adapterArtifactDigest: `sha256-${admission.component.adapterArtifact.sha256}`,
      mappingArtifactDigest: `sha256-${admission.component.mappingArtifact.sha256}`,
      componentEvidenceDigest: admission.component.componentEvidenceDigest,
    },
    platformIdentity: input.platformIdentity,
    destinationCombinationIdentity: input.destinationCombinationIdentity,
    preparedImage: input.preparedImage,
  });
};

export const compileHarnessAdmissionCompletion = (
  input: Readonly<{
    cleanup: unknown;
    observation: unknown;
    outcome: string;
    requestFingerprint: string;
    runId: string;
    scenarioImageDigest: string;
  }>,
): HarnessAdmissionCompletion => {
  if (
    input.outcome !== "passed" ||
    typeof input.cleanup !== "object" ||
    input.cleanup === null ||
    (input.cleanup as { outcome?: unknown }).outcome !== "complete"
  )
    return invalid();
  return deepFreeze({
    completionVersion: 1,
    runId: input.runId,
    requestFingerprint: input.requestFingerprint,
    observationPlaneDigest: sha256(canonicalJson(input.observation)),
    cleanupEvidenceDigest: sha256(canonicalJson(input.cleanup)),
    scenarioImageDigest: input.scenarioImageDigest,
    outcome: "scenario-terminal-clean",
    remainingOwnedResources: 0,
  });
};
