import { lstatSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import { z } from "zod";

import { canonicalJson, deepFreeze, sha256 } from "./canonical.js";

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const packageId = z.string().regex(/^@agentscope\/[a-z][a-z0-9-]{0,63}$/u);
const semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
const digest = z.string().regex(/^sha256-[a-f\d]{64}$/u);
const fileDigest = z.string().regex(/^[a-f\d]{64}$/u);
const relativeEvidencePath = z
  .string()
  .regex(/^fixtures\/[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}\.json$/u)
  .refine((value) => !value.split("/").includes(".."));
const relativeAdapterPath = z
  .string()
  .regex(/^fixtures\/[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}\.mjs$/u)
  .refine((value) => !value.split("/").includes(".."));
const uniqueList = <T extends z.ZodType<string>>(member: T) =>
  z
    .array(member)
    .min(1)
    .max(32)
    .refine((value) => new Set(value).size === value.length);

const evidenceSchema = z.strictObject({
  evidenceId: id,
  harnessId: id,
  harnessPackage: packageId,
  representativeVersion: semver,
  descriptorArtifact: z.strictObject({
    path: relativeEvidencePath,
    sha256: fileDigest,
  }),
});
const descriptorEvidenceSchema = z.strictObject({
  evidenceVersion: z.literal(1),
  harnessId: id,
  harnessPackage: packageId,
  representativeVersion: semver,
  capabilities: uniqueList(id),
});

const scenarioSchema = z.strictObject({
  scenarioId: id,
  harnessEvidenceId: id,
  image: z.string().regex(/^[a-z0-9][a-z0-9./_-]{0,159}@sha256:[a-f\d]{64}$/u),
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
  resourceClass: z.enum(["small", "medium", "large"]),
  shardWeight: z.number().int().min(1).max(100_000),
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
): void => {
  for (const evidence of manifest.evidence) {
    const path = evidencePath(
      integrationRoot,
      evidence.descriptorArtifact.path,
    );
    const status = lstatSync(path);
    if (!status.isFile() || status.isSymbolicLink())
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
  }
  for (const scenario of manifest.scenarios) {
    const path = evidencePath(integrationRoot, scenario.fixtureAdapter.path);
    const status = lstatSync(path);
    if (!status.isFile() || status.isSymbolicLink())
      throw new Error("integration.manifest.evidence-file");
    const actual = sha256(readFileSync(path)).slice("sha256-".length);
    if (actual !== scenario.fixtureAdapter.sha256)
      throw new Error("integration.manifest.evidence-digest");
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
