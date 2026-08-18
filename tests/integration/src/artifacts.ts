import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import { z } from "zod";

import { canonicalJson, deepFreeze, sha256 } from "./canonical.js";

const MAX_ARTIFACTS = 32;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const artifactId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const digest = z.string().regex(/^sha256-[a-f\d]{64}$/u);
const preparedFile = z.strictObject({
  id: artifactId,
  kind: z.enum(["npm-tarball", "runtime-archive", "runtime-binary"]),
  fileName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u),
  bytes: z.number().int().min(1).max(MAX_ARTIFACT_BYTES),
  sha256: digest,
});
const evidenceSchema = z.strictObject({
  evidenceVersion: z.literal(1),
  bundleIdentity: digest,
  candidateRevision: z.string().regex(/^[a-f\d]{40,64}$/u),
  platform: z.strictObject({
    os: z.string().regex(/^[a-z0-9-]{1,32}$/u),
    architecture: z.string().regex(/^[a-z0-9-]{1,32}$/u),
    nodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  }),
  lockfile: z.strictObject({
    fileName: z.literal("pnpm-lock.yaml"),
    bytes: z.number().int().min(1).max(MAX_ARTIFACT_BYTES),
    sha256: digest,
  }),
  artifacts: z.array(preparedFile).min(1).max(MAX_ARTIFACTS),
  scenarioNetworkPolicy: z.literal("offline-no-package-or-registry-download"),
});

export type CandidateEvidence = z.infer<typeof evidenceSchema>;

export interface CandidateArtifactInput {
  readonly id: string;
  readonly kind: "npm-tarball" | "runtime-archive" | "runtime-binary";
  readonly path: string;
}

export interface PrepareCandidateInput {
  readonly candidateRevision: string;
  readonly platform: Readonly<{
    os: string;
    architecture: string;
    nodeVersion: string;
  }>;
  readonly lockfilePath: string;
  readonly outputRoot: string;
  readonly artifacts: readonly CandidateArtifactInput[];
}

interface Snapshot {
  readonly evidence: CandidateEvidence["artifacts"][number];
  readonly bytes: Uint8Array;
}

const snapshotFile = (input: CandidateArtifactInput): Snapshot => {
  const parsed = z
    .strictObject({
      id: artifactId,
      kind: preparedFile.shape.kind,
      path: z.string(),
    })
    .safeParse(input);
  if (!parsed.success) throw new Error("integration.artifact.input");
  const status = lstatSync(parsed.data.path);
  if (!status.isFile() || status.isSymbolicLink())
    throw new Error("integration.artifact.file");
  if (status.size < 1 || status.size > MAX_ARTIFACT_BYTES)
    throw new Error("integration.artifact.size");
  const bytes = readFileSync(parsed.data.path);
  const extension = extname(basename(parsed.data.path));
  const fileName = `${parsed.data.id}${extension}`;
  return {
    bytes,
    evidence: {
      id: parsed.data.id,
      kind: parsed.data.kind,
      fileName,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    },
  };
};

const lockfileEvidence = (path: string) => {
  const status = lstatSync(path);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    basename(path) !== "pnpm-lock.yaml"
  )
    throw new Error("integration.artifact.lockfile");
  const bytes = readFileSync(path);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_ARTIFACT_BYTES)
    throw new Error("integration.artifact.lockfile");
  return {
    bytes,
    evidence: {
      fileName: "pnpm-lock.yaml" as const,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    },
  };
};

const bundleMaterial = (value: CandidateEvidence) => ({
  evidenceVersion: value.evidenceVersion,
  candidateRevision: value.candidateRevision,
  platform: value.platform,
  lockfile: value.lockfile,
  artifacts: value.artifacts,
  scenarioNetworkPolicy: value.scenarioNetworkPolicy,
});

const readEvidence = (directory: string): CandidateEvidence => {
  const path = join(directory, "evidence.json");
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink() || status.size > 1024 * 1024)
    throw new Error("integration.artifact.evidence");
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("integration.artifact.evidence");
  }
  const parsed = evidenceSchema.safeParse(input);
  if (!parsed.success) throw new Error("integration.artifact.evidence");
  const material = bundleMaterial(parsed.data);
  if (sha256(canonicalJson(material)) !== parsed.data.bundleIdentity)
    throw new Error("integration.artifact.identity");
  return parsed.data;
};

export const verifyPreparedCandidate = (
  directory: string,
): Readonly<CandidateEvidence> => {
  const evidence = readEvidence(directory);
  const filesDirectory = join(directory, "files");
  const filesStatus = lstatSync(filesDirectory);
  if (!filesStatus.isDirectory() || filesStatus.isSymbolicLink())
    throw new Error("integration.artifact.prepared-inventory");
  if (
    canonicalJson(readdirSync(directory).sort()) !==
    canonicalJson(["evidence.json", "files"])
  )
    throw new Error("integration.artifact.prepared-inventory");
  const allFiles = [evidence.lockfile, ...evidence.artifacts];
  const expectedNames = allFiles.map(({ fileName }) => fileName).sort();
  const actualNames = readdirSync(filesDirectory).sort();
  if (canonicalJson(actualNames) !== canonicalJson(expectedNames))
    throw new Error("integration.artifact.prepared-inventory");
  for (const file of allFiles) {
    const path = join(filesDirectory, file.fileName);
    const status = lstatSync(path);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.size !== file.bytes
    )
      throw new Error("integration.artifact.prepared-file");
    if (sha256(readFileSync(path)) !== file.sha256)
      throw new Error("integration.artifact.prepared-digest");
  }
  return deepFreeze(evidence);
};

export const prepareCandidate = (
  input: PrepareCandidateInput,
): Readonly<{ directory: string; evidence: Readonly<CandidateEvidence> }> => {
  if (input.artifacts.length < 1 || input.artifacts.length > MAX_ARTIFACTS)
    throw new Error("integration.artifact.count");
  const snapshots = input.artifacts
    .map(snapshotFile)
    .sort((left, right) => left.evidence.id.localeCompare(right.evidence.id));
  const ids = snapshots.map(({ evidence }) => evidence.id);
  if (
    new Set(ids).size !== ids.length ||
    !ids.includes("agentscope-cli") ||
    snapshots.some(({ evidence }) => evidence.fileName === "pnpm-lock.yaml")
  )
    throw new Error("integration.artifact.inventory");
  const lockfile = lockfileEvidence(input.lockfilePath);
  const material = {
    evidenceVersion: 1,
    candidateRevision: input.candidateRevision,
    platform: { ...input.platform },
    lockfile: lockfile.evidence,
    artifacts: snapshots.map(({ evidence }) => evidence),
    scenarioNetworkPolicy: "offline-no-package-or-registry-download",
  };
  const parsedMaterial = evidenceSchema
    .omit({ bundleIdentity: true })
    .safeParse(material);
  if (!parsedMaterial.success) throw new Error("integration.artifact.input");
  const bundleIdentity = sha256(canonicalJson(parsedMaterial.data));
  const evidence = { ...parsedMaterial.data, bundleIdentity };
  const outputRoot = resolve(input.outputRoot);
  mkdirSync(outputRoot, { recursive: true });
  const directory = join(outputRoot, bundleIdentity);
  if (existsSync(directory))
    return { directory, evidence: verifyPreparedCandidate(directory) };
  const staging = mkdtempSync(join(outputRoot, ".candidate-"));
  try {
    const files = join(staging, "files");
    mkdirSync(files);
    writeFileSync(join(files, lockfile.evidence.fileName), lockfile.bytes);
    for (const snapshot of snapshots)
      writeFileSync(join(files, snapshot.evidence.fileName), snapshot.bytes);
    writeFileSync(
      join(staging, "evidence.json"),
      `${JSON.stringify(evidence, undefined, 2)}\n`,
    );
    verifyPreparedCandidate(staging);
    renameSync(staging, directory);
  } catch (error) {
    rmSync(staging, { force: true, recursive: true });
    throw error;
  }
  return { directory, evidence: verifyPreparedCandidate(directory) };
};
