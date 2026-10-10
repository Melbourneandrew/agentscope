import { types } from "node:util";
import { z } from "zod";
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

const metadataRecord = (value: unknown): Record<string, unknown> => {
  if (
    typeof value !== "object" ||
    value === null ||
    types.isProxy(value) ||
    Array.isArray(value)
  )
    return invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== "string" || !("value" in descriptors[key]!),
    )
  )
    return invalid();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value as unknown,
    ]),
  );
};

const consumedFixtureMetadata = (value: unknown) => {
  const fixture = metadataRecord(value);
  const governance = metadataRecord(fixture.governance);
  const provenance = metadataRecord(governance.provenance);
  const authority = metadataRecord(provenance.artifactAuthority);
  const representative = metadataRecord(governance.representative);
  const identity = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
  const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
  // Component provenance describes regression inputs, not runtime authority.
  z.discriminatedUnion("captureKind", [
    z.strictObject({
      captureKind: z.literal("synthetic"),
      artifactAuthority: z.strictObject({
        status: z.literal("unresolved"),
        reason: z.literal("independent-integrity-unavailable"),
      }),
    }),
    z.strictObject({
      captureKind: z.literal("disposable-hermetic"),
      artifactAuthority: z.strictObject({
        status: z.literal("authenticated"),
        digest: z.string().regex(/^sha256-[a-f\d]{64}$/u),
      }),
    }),
  ]).parse({
    captureKind: provenance.captureKind,
    artifactAuthority: authority,
  });
  return z
    .strictObject({
      fixtureVersion: z.literal(1),
      harnessId: identity,
      harnessVersion: version,
      scenarioId: identity,
      representativeVersion: version,
      evidenceSlot: identity,
    })
    .parse({
      fixtureVersion: fixture.fixtureVersion,
      harnessId: fixture.harnessId,
      harnessVersion: fixture.harnessVersion,
      scenarioId: representative.scenarioId,
      representativeVersion: representative.representativeVersion,
      evidenceSlot: representative.evidenceSlot,
    });
};

export const compileHarnessAdmissionSeed = (
  input: Readonly<{
    candidateDigest: string;
    componentFixture: unknown;
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
  let fixture;
  try {
    fixture = consumedFixtureMetadata(input.componentFixture);
  } catch {
    return invalid();
  }
  if (
    fixture.harnessId !== input.evidence.harnessId ||
    fixture.harnessVersion !== input.evidence.representativeVersion ||
    fixture.representativeVersion !== input.evidence.representativeVersion
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
