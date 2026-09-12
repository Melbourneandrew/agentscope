import { lstatSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import { z } from "zod";

import { canonicalJson, deepFreeze, sha256 } from "./canonical.js";

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const packageId = z.string().regex(/^@agentscope\/[a-z][a-z0-9-]{0,63}$/u);
const semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
const digest = z.string().regex(/^sha256-[a-f\d]{64}$/u);
const dockerImage = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._/-]{0,127}@sha256:[a-f\d]{64}$/u);
const fileDigest = z.string().regex(/^[a-f\d]{64}$/u);
const sriSha512 = z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/u);
const sha256Hex = z.string().regex(/^[a-f\d]{64}$/u);
const npmPackageName = z
  .string()
  .regex(/^@[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/u);
const httpsUrl = z
  .string()
  .url()
  .max(512)
  .refine((value) => new URL(value).protocol === "https:");
const relativeEvidencePath = z
  .string()
  .regex(/^fixtures\/[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}\.json$/u)
  .refine((value) => !value.split("/").includes(".."));
const relativeAdapterPath = z
  .string()
  .regex(/^fixtures\/[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}\.mjs$/u)
  .refine((value) => !value.split("/").includes(".."));
const relativeScenarioProcessPath = z
  .string()
  .regex(/^(?:fixtures\/)?[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}\.mjs$/u)
  .refine((value) => !value.split("/").includes(".."));
const relativeWorkspaceArtifactPath = z
  .string()
  .regex(
    /^packages\/harnesses\/[a-z0-9-]+\/[a-zA-Z0-9][a-zA-Z0-9._/-]{0,191}$/u,
  )
  .refine((value) => !value.split("/").includes(".."));
const runtimeArtifactSchema = z.strictObject({
  source: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("integration"),
      path: relativeScenarioProcessPath,
    }),
    z.strictObject({
      kind: z.literal("workspace"),
      path: relativeWorkspaceArtifactPath,
    }),
  ]),
  destination: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u),
  sha256: fileDigest,
});
const uniqueList = <T extends z.ZodType<string>>(member: T) =>
  z
    .array(member)
    .min(1)
    .max(32)
    .refine((value) => new Set(value).size === value.length);

const signedObjectSchema = z.strictObject({
  url: httpsUrl,
  bytes: z
    .number()
    .int()
    .min(1)
    .max(384 * 1024 * 1024),
  sha256: sha256Hex,
});

const npmMaterialPackageSchema = z.strictObject({
  attestations: signedObjectSchema,
  installName: npmPackageName,
  packageName: npmPackageName,
  version: semver,
  tarballUrl: httpsUrl,
  bytes: z
    .number()
    .int()
    .min(1)
    .max(384 * 1024 * 1024),
  integrity: sriSha512,
  shasum: z.string().regex(/^[a-f\d]{40}$/u),
});
const harnessMaterialSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("certification-fixture") }),
  z.strictObject({
    kind: z.literal("npm"),
    platformIdentity: digest,
    verifierImage: dockerImage,
    registry: z.literal("https://registry.npmjs.org/"),
    packages: z
      .array(npmMaterialPackageSchema)
      .min(1)
      .max(8)
      .refine(
        (entries) =>
          new Set(entries.map(({ installName }) => installName)).size ===
            entries.length &&
          new Set(
            entries.map(
              ({ packageName, version }) => `${packageName}@${version}`,
            ),
          ).size === entries.length,
      )
      .refine(
        (entries) =>
          entries.reduce((total, entry) => total + entry.bytes, 0) <=
          320 * 1024 * 1024,
      ),
    provenance: z.strictObject({
      repository: httpsUrl,
      sourceCommit: z.string().regex(/^[a-f\d]{40}$/u),
      tag: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u),
      workflowPath: z
        .string()
        .regex(
          /^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}\.ya?ml$/u,
        ),
    }),
  }),
  z.strictObject({
    kind: z.literal("signed-release-manifest"),
    distributionId: id,
    version: semver,
    platform: id,
    platformIdentity: digest,
    verifierImage: dockerImage,
    binary: signedObjectSchema.extend({
      executableName: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    }),
    manifest: signedObjectSchema.extend({
      bytes: z.number().int().min(1).max(1_048_576),
    }),
    signature: signedObjectSchema.extend({
      bytes: z.number().int().min(1).max(1_048_576),
    }),
    signingKey: signedObjectSchema.extend({
      bytes: z.number().int().min(1).max(1_048_576),
      fingerprint: z.string().regex(/^[A-F\d]{40}$/u),
      signerFingerprint: z.string().regex(/^[A-F\d]{40}$/u),
      signatureHashAlgorithm: z.enum(["sha256", "sha384", "sha512"]),
      uid: z.string().min(1).max(256),
    }),
  }),
]);

const admissionArtifactSchema = z.strictObject({
  path: relativeWorkspaceArtifactPath,
  sha256: fileDigest,
});
const harnessAdmissionSchema = z.strictObject({
  evidenceSlot: id,
  eligibleRange: z.strictObject({
    minimumInclusive: semver,
    maximumExclusive: semver,
  }),
  distributionReference: z
    .string()
    .regex(
      /^(?:npm:@[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}|signed-manifest:[a-z][a-z0-9-]{0,63})@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:#[a-z][a-z0-9-]{0,63})?$/u,
    ),
  component: z.strictObject({
    fixture: admissionArtifactSchema,
    adapterArtifact: admissionArtifactSchema,
    mappingArtifact: admissionArtifactSchema,
    componentEvidenceDigest: z
      .string()
      .regex(/^component-sha256-[a-f\d]{64}$/u),
  }),
});

const evidenceSchema = z
  .strictObject({
    evidenceId: id,
    harnessId: id,
    harnessPackage: packageId,
    representativeVersion: semver,
    descriptorArtifact: z.strictObject({
      path: relativeEvidencePath,
      sha256: fileDigest,
    }),
    material: harnessMaterialSchema,
    admission: harnessAdmissionSchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      (value.material.kind !== "certification-fixture") !==
      (value.admission !== undefined)
    )
      context.addIssue({ code: "custom", message: "admission mismatch" });
    if (value.material.kind === "signed-release-manifest") {
      const origins = [
        value.material.binary.url,
        value.material.manifest.url,
        value.material.signature.url,
        value.material.signingKey.url,
      ].map((entry) => new URL(entry).origin);
      if (new Set(origins).size !== 1)
        context.addIssue({
          code: "custom",
          message: "release origin mismatch",
        });
      const manifestUrl = new URL(value.material.manifest.url);
      const releasePrefix = manifestUrl.pathname.slice(
        0,
        -"manifest.json".length,
      );
      if (
        !manifestUrl.pathname.endsWith(
          `/${value.material.version}/manifest.json`,
        ) ||
        new URL(value.material.signature.url).pathname !==
          `${manifestUrl.pathname}.sig` ||
        !new URL(value.material.binary.url).pathname.startsWith(releasePrefix)
      )
        context.addIssue({
          code: "custom",
          message: "release path mismatch",
        });
    }
  });
const descriptorEvidenceSchema = z.strictObject({
  evidenceVersion: z.literal(1),
  harnessId: id,
  harnessPackage: packageId,
  representativeVersion: semver,
  capabilities: uniqueList(id),
});

const scenarioSchema = z
  .strictObject({
    scenarioId: id,
    harnessEvidenceId: id,
    executionMode: z.enum(["headless", "interactive"]),
    outputContract: z.enum(["jsonl", "semantic-pty"]),
    image: z
      .string()
      .regex(/^[a-z0-9][a-z0-9./_-]{0,159}@sha256:[a-f\d]{64}$/u),
    mockServerImage: z
      .string()
      .regex(/^[a-z0-9][a-z0-9./_-]{0,159}@sha256:[a-f\d]{64}$/u),
    modelRoutes: uniqueList(id),
    tags: uniqueList(id),
    destinations: uniqueList(id),
    fixtureAdapter: z.strictObject({
      path: relativeAdapterPath,
      sha256: fileDigest,
    }),
    scenarioOracle: z.strictObject({
      path: relativeScenarioProcessPath,
      sha256: fileDigest,
    }),
    scenarioProcess: z.strictObject({
      path: relativeScenarioProcessPath,
      sha256: fileDigest,
    }),
    runtimeArtifacts: z
      .array(runtimeArtifactSchema)
      .max(8)
      .refine(
        (value) =>
          new Set(value.map(({ destination }) => destination)).size ===
          value.length,
      ),
    terminalInputBase64: z.string().regex(/^[A-Za-z0-9+/]{1,136}={0,2}$/u),
    postCompletionInputByteLength: z.number().int().min(0).max(32),
    waitForSemanticCompletionBeforeEof: z.boolean(),
    resourceClass: z.enum(["small", "medium", "large"]),
    shardWeight: z.number().int().min(1).max(100_000),
  })
  .superRefine((value, context) => {
    if (
      (value.executionMode === "headless" &&
        (value.outputContract !== "jsonl" ||
          value.terminalInputBase64 !== "AA==" ||
          value.postCompletionInputByteLength !== 0 ||
          value.waitForSemanticCompletionBeforeEof)) ||
      (value.executionMode === "interactive" &&
        (value.outputContract !== "semantic-pty" ||
          Buffer.from(value.terminalInputBase64, "base64").byteLength < 1 ||
          Buffer.from(value.terminalInputBase64, "base64").byteLength > 100 ||
          value.waitForSemanticCompletionBeforeEof !==
            value.postCompletionInputByteLength > 0 ||
          value.postCompletionInputByteLength >=
            Buffer.from(value.terminalInputBase64, "base64").byteLength))
    )
      context.addIssue({ code: "custom", message: "scenario mode drift" });
  });

const manifestSchema = z.strictObject({
  manifestVersion: z.literal(1),
  manifestIdentity: digest,
  requiredRepresentativeIds: uniqueList(id),
  evidence: z.array(evidenceSchema).min(1).max(64),
  scenarios: z.array(scenarioSchema).min(1).max(256),
});

export type CapabilityManifest = z.infer<typeof manifestSchema>;
export type CapabilityScenario = CapabilityManifest["scenarios"][number];

const sortedUnique = (values: readonly string[]): string[] =>
  [...values].sort((left, right) => left.localeCompare(right));

const normalizedMaterial = (
  value: Omit<CapabilityManifest, "manifestIdentity">,
) => ({
  manifestVersion: value.manifestVersion,
  requiredRepresentativeIds: sortedUnique(value.requiredRepresentativeIds),
  evidence: [...value.evidence].sort((left, right) =>
    left.evidenceId.localeCompare(right.evidenceId),
  ),
  scenarios: value.scenarios
    .map((scenario) => ({
      ...scenario,
      modelRoutes: sortedUnique(scenario.modelRoutes),
      tags: sortedUnique(scenario.tags),
      destinations: sortedUnique(scenario.destinations),
    }))
    .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId)),
});

export const capabilityManifestIdentity = (
  input: Omit<CapabilityManifest, "manifestIdentity">,
): string => sha256(canonicalJson(normalizedMaterial(input)));

const assertUnique = (values: readonly string[], label: string): void => {
  if (new Set(values).size !== values.length)
    throw new Error(`integration.manifest.duplicate-${label}`);
};

const assertCoverage = (manifest: CapabilityManifest): void => {
  const evidenceIds = manifest.evidence.map(({ evidenceId }) => evidenceId);
  const required = sortedUnique(manifest.requiredRepresentativeIds);
  if (canonicalJson(sortedUnique(evidenceIds)) !== canonicalJson(required))
    throw new Error("integration.manifest.coverage");
  const referenced = new Set(
    manifest.scenarios.map(({ harnessEvidenceId }) => harnessEvidenceId),
  );
  if (evidenceIds.some((evidenceId) => !referenced.has(evidenceId)))
    throw new Error("integration.manifest.uncovered");
  if (
    manifest.scenarios.some(
      ({ harnessEvidenceId }) => !evidenceIds.includes(harnessEvidenceId),
    )
  )
    throw new Error("integration.manifest.unknown-evidence");
  const preparedImages = new Set(
    manifest.scenarios.flatMap(({ image, mockServerImage }) => [
      image,
      mockServerImage,
    ]),
  );
  if (
    manifest.evidence.some(
      ({ material }) =>
        material.kind !== "certification-fixture" &&
        !preparedImages.has(material.verifierImage),
    )
  )
    throw new Error("integration.manifest.verifier-image");
};

export const compileCapabilityManifest = (
  input: unknown,
): Readonly<CapabilityManifest> => {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) throw new Error("integration.manifest.invalid");
  assertUnique(
    parsed.data.evidence.map(({ evidenceId }) => evidenceId),
    "evidence",
  );
  assertUnique(
    parsed.data.evidence.map(
      ({ harnessId, representativeVersion }) =>
        `${harnessId}@${representativeVersion}`,
    ),
    "representative",
  );
  assertUnique(
    parsed.data.scenarios.map(({ scenarioId }) => scenarioId),
    "scenario",
  );
  assertCoverage(parsed.data);
  const material = normalizedMaterial(parsed.data);
  const expected = capabilityManifestIdentity(material);
  if (parsed.data.manifestIdentity !== expected)
    throw new Error("integration.manifest.identity");
  return deepFreeze({ ...material, manifestIdentity: expected });
};

const evidencePath = (root: string, relativePath: string): string => {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, relativePath);
  if (!absolute.startsWith(`${absoluteRoot}${sep}`))
    throw new Error("integration.manifest.evidence-path");
  return absolute;
};

export const verifyManifestEvidence = (
  manifest: CapabilityManifest,
  integrationRoot: string,
  // eslint-disable-next-line complexity -- one closed manifest evidence boundary
): void => {
  for (const evidence of manifest.evidence) {
    const path = evidencePath(
      integrationRoot,
      evidence.descriptorArtifact.path,
    );
    const status = lstatSync(path);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.size < 1 ||
      status.size > 1_048_576
    )
      throw new Error("integration.manifest.evidence-file");
    const actual = sha256(readFileSync(path)).slice("sha256-".length);
    if (actual !== evidence.descriptorArtifact.sha256)
      throw new Error("integration.manifest.evidence-digest");
    let descriptorInput: unknown;
    try {
      descriptorInput = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error("integration.manifest.evidence-contract");
    }
    const descriptor = descriptorEvidenceSchema.safeParse(descriptorInput);
    if (
      !descriptor.success ||
      descriptor.data.harnessId !== evidence.harnessId ||
      descriptor.data.harnessPackage !== evidence.harnessPackage ||
      descriptor.data.representativeVersion !== evidence.representativeVersion
    )
      throw new Error("integration.manifest.evidence-contract");
    if (evidence.admission !== undefined) {
      const workspaceRoot = resolve(integrationRoot, "../..");
      for (const artifact of [
        evidence.admission.component.fixture,
        evidence.admission.component.adapterArtifact,
        evidence.admission.component.mappingArtifact,
      ]) {
        const artifactPath = resolve(workspaceRoot, artifact.path);
        if (!artifactPath.startsWith(`${workspaceRoot}${sep}`))
          throw new Error("integration.manifest.evidence-file");
        const artifactStatus = lstatSync(artifactPath);
        if (
          !artifactStatus.isFile() ||
          artifactStatus.isSymbolicLink() ||
          artifactStatus.size < 1 ||
          artifactStatus.size > 16_777_216
        )
          throw new Error("integration.manifest.evidence-file");
        const artifactDigest = sha256(readFileSync(artifactPath)).slice(
          "sha256-".length,
        );
        if (artifactDigest !== artifact.sha256)
          throw new Error("integration.manifest.evidence-digest");
      }
    }
  }
  for (const scenario of manifest.scenarios) {
    for (const [artifact, maximumBytes] of [
      [scenario.fixtureAdapter, 1_048_576],
      [scenario.scenarioOracle, 1_048_576],
      [scenario.scenarioProcess, 16_777_216],
    ] as const) {
      const path = evidencePath(integrationRoot, artifact.path);
      const status = lstatSync(path);
      if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.size < 1 ||
        status.size > maximumBytes
      )
        throw new Error("integration.manifest.evidence-file");
      const actual = sha256(readFileSync(path)).slice("sha256-".length);
      if (actual !== artifact.sha256)
        throw new Error("integration.manifest.evidence-digest");
    }
    for (const artifact of scenario.runtimeArtifacts) {
      const root =
        artifact.source.kind === "integration"
          ? integrationRoot
          : resolve(integrationRoot, "../..");
      const path = resolve(root, artifact.source.path);
      if (!path.startsWith(`${root}${sep}`))
        throw new Error("integration.manifest.evidence-file");
      const status = lstatSync(path);
      if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.size < 1 ||
        status.size > 16_777_216
      )
        throw new Error("integration.manifest.evidence-file");
      const actual = sha256(readFileSync(path)).slice("sha256-".length);
      if (actual !== artifact.sha256)
        throw new Error("integration.manifest.evidence-digest");
    }
  }
};

export interface CapabilitySelector {
  readonly scenarioId?: string;
  readonly harnessId?: string;
  readonly tag?: string;
  readonly shard?: Readonly<{ index: number; total: number }>;
}

export const partitionCapabilityScenarios = (
  scenarios: readonly CapabilityScenario[],
  total: number,
): readonly (readonly CapabilityScenario[])[] => {
  if (!Number.isSafeInteger(total) || total < 1 || total > scenarios.length)
    throw new Error("integration.manifest.shard");
  const shards = Array.from({ length: total }, () => ({
    weight: 0,
    scenarios: [] as CapabilityScenario[],
  }));
  const ordered = [...scenarios].sort(
    (left, right) =>
      right.shardWeight - left.shardWeight ||
      left.scenarioId.localeCompare(right.scenarioId),
  );
  for (const scenario of ordered) {
    const target = [...shards].sort(
      (left, right) =>
        left.weight - right.weight ||
        shards.indexOf(left) - shards.indexOf(right),
    )[0];
    if (!target) throw new Error("integration.manifest.shard");
    target.scenarios.push(scenario);
    target.weight += scenario.shardWeight;
  }
  return deepFreeze(
    shards.map(({ scenarios: entries }) =>
      entries.sort((left, right) =>
        left.scenarioId.localeCompare(right.scenarioId),
      ),
    ),
  );
};

export const selectCapabilityScenarios = (
  manifest: CapabilityManifest,
  selector: CapabilitySelector,
): readonly CapabilityScenario[] => {
  const knownKeys = new Set(["scenarioId", "harnessId", "tag", "shard"]);
  if (Object.keys(selector).some((key) => !knownKeys.has(key)))
    throw new Error("integration.manifest.selector");
  const harnessByEvidence = new Map(
    manifest.evidence.map(({ evidenceId, harnessId }) => [
      evidenceId,
      harnessId,
    ]),
  );
  const matching = manifest.scenarios
    .filter(
      (scenario) =>
        (selector.scenarioId === undefined ||
          scenario.scenarioId === selector.scenarioId) &&
        (selector.harnessId === undefined ||
          harnessByEvidence.get(scenario.harnessEvidenceId) ===
            selector.harnessId) &&
        (selector.tag === undefined || scenario.tags.includes(selector.tag)),
    )
    .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
  if (matching.length === 0)
    throw new Error("integration.manifest.selection-empty");
  if (selector.shard === undefined) return deepFreeze([...matching]);
  const { index, total } = selector.shard;
  if (!Number.isSafeInteger(index) || index < 0 || index >= total)
    throw new Error("integration.manifest.shard");
  return partitionCapabilityScenarios(matching, total)[index] ?? [];
};
