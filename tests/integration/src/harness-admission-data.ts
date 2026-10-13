import { canonicalJson, deepFreeze, sha256 } from "./canonical.js";

const digestPattern = /^sha256-[a-f0-9]{64}$/u;
const ociDigestPattern = /^sha256:[a-f0-9]{64}$/u;
const componentDigestPattern = /^component-sha256-[a-f0-9]{64}$/u;
const harnessPattern = /^@agentscope\/harness-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const imagePattern = /^[a-z0-9][a-z0-9./_-]{0,159}@sha256:[a-f0-9]{64}$/u;
const semverPattern = /^\d+\.\d+\.\d+$/u;
const runPattern = /^[a-f0-9]{16}$/u;

export type HarnessAdmissionSeed = Readonly<{
  admissionVersion: 1;
  runId: string;
  candidateDigest: string;
  manifestIdentity: string;
  scenarioId: string;
  catalogRowIdentity: string;
  productIdentity: "agentscope-cli";
  harness: Readonly<{
    registryIdentity: string;
    evidenceSlot: string;
    exactVersion: string;
    eligibleRange: Readonly<{
      minimumInclusive: string;
      maximumExclusive: string;
    }>;
    distributionReference: string;
    artifactDigest: string;
    artifactAuthorityDigest: string;
  }>;
  execution: Readonly<{
    mode: "headless" | "interactive";
    outputContract: "jsonl" | "semantic-pty";
  }>;
  component: Readonly<{
    fixtureDigest: string;
    adapterArtifactDigest: string;
    mappingArtifactDigest: string;
    componentEvidenceDigest: string;
  }>;
  platformIdentity: string;
  destinationCombinationIdentity: string;
  preparedImage: Readonly<{
    image: string;
    manifestDigest: string;
    configDigest: string;
    platformIdentity: string;
    scenarioImageDigest: string;
  }>;
}>;

export type HarnessAdmissionCompletion = Readonly<{
  completionVersion: 1;
  runId: string;
  requestFingerprint: string;
  observationPlaneDigest: string;
  cleanupEvidenceDigest: string;
  scenarioImageDigest: string;
  outcome: "scenario-terminal-clean";
  remainingOwnedResources: 0;
}>;

export type HarnessSupportEvidenceManifest = Readonly<{
  manifestVersion: 1;
  disposition: "real-scenario-evidence-awaiting-release-gate";
  manifestIdentity: string;
  entries: readonly Readonly<{
    harnessType: string;
    evidenceSlot: string;
    testedVersion: string;
    catalogRowIdentity: string;
    contractSuiteDigest: string;
    realScenarioDigest: string;
    binding: Readonly<{
      seed: HarnessAdmissionSeed;
      controller: Readonly<{
        authorityIdentity: string;
        hostKind: "crabbox" | "github-hosted";
        workspaceRevision: string;
      }>;
      completion: HarnessAdmissionCompletion;
    }>;
  }>[];
}>;

type DataRecord = Readonly<Record<string, unknown>>;

export const invalid = (): never => {
  throw new Error("integration.harness-admission.invalid");
};

export const exactRecord = (
  value: unknown,
  keys: readonly string[],
): DataRecord => {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return invalid();
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) return invalid();
      output[key] = descriptor.value as unknown;
    }
    return output;
  } catch {
    return invalid();
  }
};

export const exactArray = (
  value: unknown,
  maximum = 32,
): readonly unknown[] => {
  try {
    if (!Array.isArray(value)) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown =
      lengthDescriptor && "value" in lengthDescriptor
        ? (lengthDescriptor.value as unknown)
        : undefined;
    if (
      !Number.isSafeInteger(length) ||
      (length as number) < 1 ||
      (length as number) > maximum ||
      Reflect.ownKeys(descriptors).length !== (length as number) + 1
    )
      return invalid();
    const output: unknown[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor)) return invalid();
      output.push(descriptor.value as unknown);
    }
    return Object.freeze(output);
  } catch {
    return invalid();
  }
};

const text = (value: unknown, pattern: RegExp, maximum = 256): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    !pattern.test(value)
  )
    return invalid();
  return value;
};

const parseSemver = (value: string): readonly [number, number, number] => {
  if (!semverPattern.test(value)) return invalid();
  const parts = value.split(".").map(Number);
  if (
    parts.length !== 3 ||
    parts.some(
      (part, index) =>
        !Number.isSafeInteger(part) ||
        part < 0 ||
        part > 2_147_483_647 ||
        String(part) !== value.split(".")[index],
    )
  )
    return invalid();
  return parts as unknown as readonly [number, number, number];
};

const compareSemver = (
  left: readonly number[],
  right: readonly number[],
): number => {
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
};

const harnessArtifactAuthorityIdentity = (
  input: Readonly<{
    registryIdentity: string;
    exactVersion: string;
    distributionReference: string;
    artifactDigest: string;
  }>,
): string => sha256(canonicalJson(input));

const harnessCatalogRowIdentity = (
  input: Readonly<{
    productIdentity: "agentscope-cli";
    harness: Readonly<{
      registryIdentity: string;
      evidenceSlot: string;
      exactVersion: string;
    }>;
    execution: Readonly<{
      mode: "headless" | "interactive";
      outputContract: "jsonl" | "semantic-pty";
    }>;
    platformIdentity: string;
    destinationCombinationIdentity: string;
  }>,
): string => sha256(canonicalJson(input));

const parseHarness = (value: unknown): HarnessAdmissionSeed["harness"] => {
  const harness = exactRecord(value, [
    "registryIdentity",
    "evidenceSlot",
    "exactVersion",
    "eligibleRange",
    "distributionReference",
    "artifactDigest",
    "artifactAuthorityDigest",
  ]);
  const eligibleRange = exactRecord(harness.eligibleRange, [
    "minimumInclusive",
    "maximumExclusive",
  ]);
  const exactVersion = text(harness.exactVersion, semverPattern, 64);
  const minimumInclusive = text(
    eligibleRange.minimumInclusive,
    semverPattern,
    64,
  );
  const maximumExclusive = text(
    eligibleRange.maximumExclusive,
    semverPattern,
    64,
  );
  const exact = parseSemver(exactVersion);
  const minimum = parseSemver(minimumInclusive);
  const maximum = parseSemver(maximumExclusive);
  if (
    compareSemver(minimum, maximum) >= 0 ||
    compareSemver(exact, minimum) < 0 ||
    compareSemver(exact, maximum) >= 0
  )
    return invalid();
  return {
    registryIdentity: text(harness.registryIdentity, harnessPattern, 128),
    evidenceSlot: text(harness.evidenceSlot, idPattern, 64),
    exactVersion,
    eligibleRange: { minimumInclusive, maximumExclusive },
    distributionReference: text(
      harness.distributionReference,
      /^[A-Za-z0-9][A-Za-z0-9+._:@/#-]{0,255}$/u,
      256,
    ),
    artifactDigest: text(harness.artifactDigest, digestPattern, 71),
    artifactAuthorityDigest: text(
      harness.artifactAuthorityDigest,
      digestPattern,
      71,
    ),
  };
};

const parseExecution = (value: unknown): HarnessAdmissionSeed["execution"] => {
  const execution = exactRecord(value, ["mode", "outputContract"]);
  if (
    (execution.mode !== "headless" && execution.mode !== "interactive") ||
    (execution.outputContract !== "jsonl" &&
      execution.outputContract !== "semantic-pty") ||
    (execution.mode === "headless" && execution.outputContract !== "jsonl") ||
    (execution.mode === "interactive" &&
      execution.outputContract !== "semantic-pty")
  )
    return invalid();
  return { mode: execution.mode, outputContract: execution.outputContract };
};

const parseComponent = (value: unknown): HarnessAdmissionSeed["component"] => {
  const component = exactRecord(value, [
    "fixtureDigest",
    "adapterArtifactDigest",
    "mappingArtifactDigest",
    "componentEvidenceDigest",
  ]);
  return {
    fixtureDigest: text(component.fixtureDigest, digestPattern, 71),
    adapterArtifactDigest: text(
      component.adapterArtifactDigest,
      digestPattern,
      71,
    ),
    mappingArtifactDigest: text(
      component.mappingArtifactDigest,
      digestPattern,
      71,
    ),
    componentEvidenceDigest: text(
      component.componentEvidenceDigest,
      componentDigestPattern,
      81,
    ),
  };
};

const parsePreparedImage = (
  value: unknown,
): HarnessAdmissionSeed["preparedImage"] => {
  const preparedImage = exactRecord(value, [
    "image",
    "manifestDigest",
    "configDigest",
    "platformIdentity",
    "scenarioImageDigest",
  ]);
  return {
    image: text(preparedImage.image, imagePattern, 232),
    manifestDigest: text(preparedImage.manifestDigest, ociDigestPattern, 71),
    configDigest: text(preparedImage.configDigest, ociDigestPattern, 71),
    platformIdentity: text(preparedImage.platformIdentity, digestPattern, 71),
    scenarioImageDigest: text(
      preparedImage.scenarioImageDigest,
      digestPattern,
      71,
    ),
  };
};

export const parseSeed = (value: unknown): HarnessAdmissionSeed => {
  const record = exactRecord(value, [
    "admissionVersion",
    "runId",
    "candidateDigest",
    "manifestIdentity",
    "scenarioId",
    "catalogRowIdentity",
    "productIdentity",
    "harness",
    "execution",
    "component",
    "platformIdentity",
    "destinationCombinationIdentity",
    "preparedImage",
  ]);
  if (
    record.admissionVersion !== 1 ||
    record.productIdentity !== "agentscope-cli"
  )
    return invalid();
  const harness = parseHarness(record.harness);
  const execution = parseExecution(record.execution);
  const component = parseComponent(record.component);
  const preparedImage = parsePreparedImage(record.preparedImage);
  const parsed = deepFreeze({
    admissionVersion: 1 as const,
    runId: text(record.runId, runPattern, 16),
    candidateDigest: text(record.candidateDigest, digestPattern, 71),
    manifestIdentity: text(record.manifestIdentity, digestPattern, 71),
    scenarioId: text(record.scenarioId, idPattern, 64),
    catalogRowIdentity: text(record.catalogRowIdentity, digestPattern, 71),
    productIdentity: "agentscope-cli" as const,
    harness,
    execution,
    component,
    platformIdentity: text(record.platformIdentity, digestPattern, 71),
    destinationCombinationIdentity: text(
      record.destinationCombinationIdentity,
      digestPattern,
      71,
    ),
    preparedImage,
  });
  if (
    parsed.harness.artifactAuthorityDigest !==
      harnessArtifactAuthorityIdentity({
        registryIdentity: parsed.harness.registryIdentity,
        exactVersion: parsed.harness.exactVersion,
        distributionReference: parsed.harness.distributionReference,
        artifactDigest: parsed.harness.artifactDigest,
      }) ||
    parsed.catalogRowIdentity !==
      harnessCatalogRowIdentity({
        productIdentity: parsed.productIdentity,
        harness: {
          registryIdentity: parsed.harness.registryIdentity,
          evidenceSlot: parsed.harness.evidenceSlot,
          exactVersion: parsed.harness.exactVersion,
        },
        execution: parsed.execution,
        platformIdentity: parsed.platformIdentity,
        destinationCombinationIdentity: parsed.destinationCombinationIdentity,
      })
  )
    return invalid();
  return parsed;
};

export const parseCompletion = (value: unknown): HarnessAdmissionCompletion => {
  const record = exactRecord(value, [
    "completionVersion",
    "runId",
    "requestFingerprint",
    "observationPlaneDigest",
    "cleanupEvidenceDigest",
    "scenarioImageDigest",
    "outcome",
    "remainingOwnedResources",
  ]);
  if (
    record.completionVersion !== 1 ||
    record.outcome !== "scenario-terminal-clean" ||
    record.remainingOwnedResources !== 0
  )
    return invalid();
  return deepFreeze({
    completionVersion: 1,
    runId: text(record.runId, runPattern, 16),
    requestFingerprint: text(record.requestFingerprint, ociDigestPattern, 71),
    observationPlaneDigest: text(
      record.observationPlaneDigest,
      digestPattern,
      71,
    ),
    cleanupEvidenceDigest: text(
      record.cleanupEvidenceDigest,
      digestPattern,
      71,
    ),
    scenarioImageDigest: text(record.scenarioImageDigest, digestPattern, 71),
    outcome: "scenario-terminal-clean" as const,
    remainingOwnedResources: 0,
  });
};

// Persisted upload privacy validation only; this cannot authenticate a live run.
export const parsePersistedHarnessSupportEvidence = (
  value: unknown,
): HarnessSupportEvidenceManifest => {
  const manifest = exactRecord(value, [
    "manifestVersion",
    "disposition",
    "manifestIdentity",
    "entries",
  ]);
  if (
    manifest.manifestVersion !== 1 ||
    manifest.disposition !== "real-scenario-evidence-awaiting-release-gate"
  )
    return invalid();
  text(manifest.manifestIdentity, digestPattern, 71);
  for (const value of exactArray(manifest.entries)) {
    const entry = exactRecord(value, [
      "harnessType",
      "evidenceSlot",
      "testedVersion",
      "catalogRowIdentity",
      "contractSuiteDigest",
      "realScenarioDigest",
      "binding",
    ]);
    text(entry.harnessType, harnessPattern, 128);
    text(entry.evidenceSlot, idPattern, 64);
    text(entry.testedVersion, semverPattern, 32);
    for (const key of [
      "catalogRowIdentity",
      "contractSuiteDigest",
      "realScenarioDigest",
    ])
      text(entry[key], digestPattern, 71);
    const binding = exactRecord(entry.binding, [
      "seed",
      "controller",
      "completion",
    ]);
    parseSeed(binding.seed);
    parseCompletion(binding.completion);
    const controller = exactRecord(binding.controller, [
      "authorityIdentity",
      "hostKind",
      "workspaceRevision",
    ]);
    text(controller.authorityIdentity, ociDigestPattern, 71);
    text(controller.workspaceRevision, /^[a-f0-9]{40}$/u, 40);
    if (
      controller.hostKind !== "crabbox" &&
      controller.hostKind !== "github-hosted"
    )
      return invalid();
  }
  return deepFreeze(structuredClone(value)) as HarnessSupportEvidenceManifest;
};
