import { createHash } from "node:crypto";

const IDENTIFIER = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const VERSION = /^(?:0|[1-9][0-9]{0,5})(?:\.(?:0|[1-9][0-9]{0,5})){0,3}$/u;

type NativePlatform = "darwin" | "linux" | "win32";
type NativeArchitecture = "arm64" | "x64";
type LibcFamily = "glibc" | "musl";
type NativeArtifactKind =
  | "loader"
  | "native-binary"
  | "notice"
  | "provenance"
  | "release-materials"
  | "runtime"
  | "sbom";
type NativeArtifactFile = Readonly<{
  kind: NativeArtifactKind;
  relativePath: string;
  bytes: number;
  digest: string;
}>;
type NativeBinary = Readonly<{
  tupleId: string;
  nodeAbi: number;
  admittedNodeMajors: readonly number[];
  platform: NativePlatform;
  minimumOsVersion: string;
  architecture: NativeArchitecture;
  libcFamily: LibcFamily | null;
  minimumLibcVersion: string | null;
  relativePath: string;
  bytes: number;
  digest: string;
}>;
type SupportedPlatform = Readonly<{
  platformId: string;
  nativeTupleId: string;
  nodeMajor: number;
  credentialBackend: string;
  filesystemProfile: string;
}>;

export type LocalSqliteNativeSupportManifest = Readonly<{
  schemaVersion: 1;
  capability: "local-sqlite";
  disposition: "proposed-unpublished-execution-eligible";
  artifactRoot: "internal/local-sqlite";
  loaderContract: "owned-absolute-no-discovery-plus-exchange-v2";
  namespaceMutationContract: "linux-renameat2-exchange-exact-inode-v1";
  recoveryFenceLockContract: "linux-flock-exclusive-nonblocking-open-description-process-death-release-v1";
  buildSandboxProfile: "agentscope-owned-native-build-v1";
  executionSandboxProfile: "agentscope-sacrificial-native-execution-v1";
  maximumSnapshotBytes: 17_179_869_184;
  minimumNativeChildBudgetMilliseconds: 50;
  nativeTeardownReserveMilliseconds: 250;
  releaseMaterialManifestDigest: string;
  provenanceDigest: string;
  sbomDigest: string;
  noticeInventoryDigest: string;
  artifactFiles: readonly NativeArtifactFile[];
  nativeBinaries: readonly NativeBinary[];
  supportedPlatforms: readonly SupportedPlatform[];
}>;
export type LocalSqliteRuntimeIdentity = Readonly<{
  nodeAbi: number;
  nodeMajor: number;
  platform: string;
  osVersion: string;
  architecture: string;
  libcFamily: string | null;
  libcVersion: string | null;
  credentialBackend: string;
  filesystemProfile: string;
}>;
export type LocalSqliteNativeSupportResult =
  | Readonly<{
      state: "available";
      platformId: string;
      nativeTupleId: string;
      admission: "proposed-unpublished";
      relativePath: string;
      bytes: number;
      digest: string;
      maximumSnapshotBytes: number;
      minimumNativeChildBudgetMilliseconds: number;
      nativeTeardownReserveMilliseconds: number;
    }>
  | Readonly<{
      state: "unavailable";
      code: "destination.local-sqlite.native-unavailable";
    }>;

const candidateBinary = Object.freeze({
  tupleId: "node127-linux-x64-glibc",
  nodeAbi: 127,
  admittedNodeMajors: Object.freeze([22]),
  platform: "linux" as const,
  minimumOsVersion: "5.15",
  architecture: "x64" as const,
  libcFamily: "glibc" as const,
  minimumLibcVersion: "2.34",
  relativePath: "native/node127-linux-x64-glibc/agentscope_sqlite.node",
  bytes: 2_222_856,
  digest:
    "sha256:b07b4ab1f139c8d2b2b6701ceaf3b4f5905b45660f122fab3e3c1fcaa47641c9",
});

const candidateArtifacts = Object.freeze([
  Object.freeze({
    kind: "loader" as const,
    relativePath: "loader/owned-loader.cjs",
    bytes: 15_896,
    digest:
      "sha256:f1bf552b702d1249f23e2e2b5bfdab9be8328a24e600b212cdf40df05963e0ba",
  }),
  Object.freeze({
    kind: "native-binary" as const,
    relativePath: candidateBinary.relativePath,
    bytes: candidateBinary.bytes,
    digest: candidateBinary.digest,
  }),
  Object.freeze({
    kind: "runtime" as const,
    relativePath: "runtime/better-sqlite3.cjs",
    bytes: 29_878,
    digest:
      "sha256:e5b029abcc18d9bc3981616bc9f0e9247be23390584f75cabe13515bccb50849",
  }),
  Object.freeze({
    kind: "notice" as const,
    relativePath: "notices/better-sqlite3-MIT.txt",
    bytes: 1_078,
    digest:
      "sha256:09856b52897c91ab67e7456ef43067019f31dfd3b87fda72e655736b1ebdee55",
  }),
  Object.freeze({
    kind: "notice" as const,
    relativePath: "notices/node-addon-api-MIT.txt",
    bytes: 1_150,
    digest:
      "sha256:89024017b88a9f2b763f79b941a4f2db3b4428edfcacdc0b23866b2da633ad0c",
  }),
  Object.freeze({
    kind: "notice" as const,
    relativePath: "notices/sqlite-public-domain.txt",
    bytes: 231,
    digest:
      "sha256:1d0f05cf16e1c2bbf53b9a00b49480fc802acec5248443c8eaef2e515333da95",
  }),
  Object.freeze({
    kind: "release-materials" as const,
    relativePath: "records/release-materials.json",
    bytes: 18_893,
    digest:
      "sha256:01cc76a9f8c1902e2b52ab242a104edda9082b74cb347489a2cb2c8c47ff0e6f",
  }),
  Object.freeze({
    kind: "provenance" as const,
    relativePath: "records/provenance.json",
    bytes: 3_369,
    digest:
      "sha256:0a775662e9afdb51ba479a1c6a529863e7cdcbfb9f5214b62375dad0c535b1df",
  }),
  Object.freeze({
    kind: "sbom" as const,
    relativePath: "records/sbom.spdx.json",
    bytes: 4_349,
    digest:
      "sha256:04280bcb8de98f8be1e8638888a1a906529e7e4451129f8a1b131219ed2a7f08",
  }),
]);

export const LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST: LocalSqliteNativeSupportManifest =
  Object.freeze({
    schemaVersion: 1,
    capability: "local-sqlite",
    disposition: "proposed-unpublished-execution-eligible",
    artifactRoot: "internal/local-sqlite",
    loaderContract: "owned-absolute-no-discovery-plus-exchange-v2",
    namespaceMutationContract: "linux-renameat2-exchange-exact-inode-v1",
    recoveryFenceLockContract:
      "linux-flock-exclusive-nonblocking-open-description-process-death-release-v1",
    buildSandboxProfile: "agentscope-owned-native-build-v1",
    executionSandboxProfile: "agentscope-sacrificial-native-execution-v1",
    maximumSnapshotBytes: 17_179_869_184,
    minimumNativeChildBudgetMilliseconds: 50,
    nativeTeardownReserveMilliseconds: 250,
    releaseMaterialManifestDigest:
      "sha256:01cc76a9f8c1902e2b52ab242a104edda9082b74cb347489a2cb2c8c47ff0e6f",
    provenanceDigest:
      "sha256:0a775662e9afdb51ba479a1c6a529863e7cdcbfb9f5214b62375dad0c535b1df",
    sbomDigest:
      "sha256:04280bcb8de98f8be1e8638888a1a906529e7e4451129f8a1b131219ed2a7f08",
    noticeInventoryDigest:
      "sha256:748161db20ee1f0f96e74bc7a54cbb0ba9705fcf7ca0a52313a978d482f3534c",
    artifactFiles: candidateArtifacts,
    nativeBinaries: Object.freeze([candidateBinary]),
    supportedPlatforms: Object.freeze([
      Object.freeze({
        platformId: "linux-x64-node22-ci-ext4-proposed",
        nativeTupleId: candidateBinary.tupleId,
        nodeMajor: 22,
        credentialBackend: "ci-environment",
        filesystemProfile: "local-ext4",
      }),
    ]),
  });

export const LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST_DIGEST =
  "sha256:07059633fd124a278d16a1421d3dbd27f5778b1b26f5fecca9f24f27addedd2d" as const;

const unavailable = (): LocalSqliteNativeSupportResult =>
  Object.freeze({
    state: "unavailable",
    code: "destination.local-sqlite.native-unavailable",
  });

const exactRecord = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(
    value,
  ) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => !(key in descriptors))
  )
    return undefined;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
};

const exactArray = (
  value: unknown,
  maximum: number,
): readonly unknown[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(
    value,
  ) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const lengthDescriptor = descriptors["length"];
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximum
  )
    return undefined;
  const length = lengthDescriptor.value;
  const expected = new Set([
    "length",
    ...Array.from({ length }, (_, index) => String(index)),
  ]);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== "string" || !expected.has(key),
    ) ||
    [...expected].some((key) => !(key in descriptors))
  )
    return undefined;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    result.push(descriptor.value);
  }
  return Object.freeze(result);
};

const validIdentifier = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 128 && IDENTIFIER.test(value);
const validVersion = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 32 && VERSION.test(value);
const validInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= minimum &&
  value <= maximum;
const validRelativePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 256 &&
  /^native\/[a-z0-9._-]+\/[a-z0-9._-]+\.node$/u.test(value);
const validArtifactPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 256 &&
  /^(?:loader\/[a-z0-9._-]+\.cjs|native\/[a-z0-9._-]+\/[a-z0-9._-]+\.node|runtime\/[a-z0-9._-]+\.cjs|notices\/[A-Za-z0-9._-]+\.txt|records\/[a-z0-9._-]+\.json)$/u.test(
    value,
  );

const compareVersions = (left: string, right: string): number => {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 4; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const snapshotRuntime = (
  value: unknown,
): LocalSqliteRuntimeIdentity | undefined => {
  const record = exactRecord(value, [
    "nodeAbi",
    "nodeMajor",
    "platform",
    "osVersion",
    "architecture",
    "libcFamily",
    "libcVersion",
    "credentialBackend",
    "filesystemProfile",
  ]);
  if (record === undefined) return undefined;
  const validLibc =
    (record.platform !== "linux" &&
      record.libcFamily === null &&
      record.libcVersion === null) ||
    (record.platform === "linux" &&
      typeof record.libcFamily === "string" &&
      ["glibc", "musl"].includes(record.libcFamily) &&
      validVersion(record.libcVersion));
  if (
    !validInteger(record.nodeAbi, 1, 65_535) ||
    !validInteger(record.nodeMajor, 22, 255) ||
    typeof record.platform !== "string" ||
    !["darwin", "linux", "win32"].includes(record.platform) ||
    !validVersion(record.osVersion) ||
    typeof record.architecture !== "string" ||
    !["arm64", "x64"].includes(record.architecture) ||
    !validLibc ||
    !validIdentifier(record.credentialBackend) ||
    !validIdentifier(record.filesystemProfile)
  )
    return undefined;
  return Object.freeze(record) as LocalSqliteRuntimeIdentity;
};

const NATIVE_KEYS = Object.freeze([
  "tupleId",
  "nodeAbi",
  "admittedNodeMajors",
  "platform",
  "minimumOsVersion",
  "architecture",
  "libcFamily",
  "minimumLibcVersion",
  "relativePath",
  "bytes",
  "digest",
]);

const snapshotBinary = (value: unknown): NativeBinary | undefined => {
  const record = exactRecord(value, NATIVE_KEYS);
  if (record === undefined) return undefined;
  const majors = exactArray(record.admittedNodeMajors, 8);
  const validLibc =
    (record.platform !== "linux" &&
      record.libcFamily === null &&
      record.minimumLibcVersion === null) ||
    (record.platform === "linux" &&
      typeof record.libcFamily === "string" &&
      ["glibc", "musl"].includes(record.libcFamily) &&
      validVersion(record.minimumLibcVersion));
  if (
    !validIdentifier(record.tupleId) ||
    !validInteger(record.nodeAbi, 1, 65_535) ||
    majors === undefined ||
    majors.length === 0 ||
    majors.some((major) => !validInteger(major, 22, 255)) ||
    new Set(majors).size !== majors.length ||
    majors.some((major, index) => {
      if (index === 0) return false;
      const previous = majors[index - 1];
      return (
        typeof major !== "number" ||
        typeof previous !== "number" ||
        previous >= major
      );
    }) ||
    typeof record.platform !== "string" ||
    !["darwin", "linux", "win32"].includes(record.platform) ||
    !validVersion(record.minimumOsVersion) ||
    typeof record.architecture !== "string" ||
    !["arm64", "x64"].includes(record.architecture) ||
    !validLibc ||
    !validRelativePath(record.relativePath) ||
    !validInteger(record.bytes, 1, 16 * 1024 * 1024) ||
    typeof record.digest !== "string" ||
    !SHA256.test(record.digest)
  )
    return undefined;
  return Object.freeze({
    ...record,
    admittedNodeMajors: majors,
  }) as NativeBinary;
};

const nativeProjectionKey = (binary: NativeBinary): string =>
  [
    binary.nodeAbi,
    binary.admittedNodeMajors.join(","),
    binary.platform,
    binary.minimumOsVersion,
    binary.architecture,
    binary.libcFamily ?? "none",
    binary.minimumLibcVersion ?? "none",
  ].join("|");

const snapshotPlatform = (value: unknown): SupportedPlatform | undefined => {
  const record = exactRecord(value, [
    "platformId",
    "nativeTupleId",
    "nodeMajor",
    "credentialBackend",
    "filesystemProfile",
  ]);
  if (
    record === undefined ||
    !validIdentifier(record.platformId) ||
    !validIdentifier(record.nativeTupleId) ||
    !validInteger(record.nodeMajor, 22, 255) ||
    !validIdentifier(record.credentialBackend) ||
    !validIdentifier(record.filesystemProfile)
  )
    return undefined;
  return Object.freeze(record) as SupportedPlatform;
};

const snapshotArtifact = (value: unknown): NativeArtifactFile | undefined => {
  const record = exactRecord(value, [
    "kind",
    "relativePath",
    "bytes",
    "digest",
  ]);
  if (
    record === undefined ||
    typeof record.kind !== "string" ||
    ![
      "native-binary",
      "loader",
      "notice",
      "provenance",
      "release-materials",
      "runtime",
      "sbom",
    ].includes(record.kind) ||
    !validArtifactPath(record.relativePath) ||
    !validInteger(record.bytes, 1, 16 * 1024 * 1024) ||
    typeof record.digest !== "string" ||
    !SHA256.test(record.digest)
  )
    return undefined;
  return Object.freeze(record) as NativeArtifactFile;
};

const runtimeMatchesBinary = (
  runtime: LocalSqliteRuntimeIdentity,
  binary: NativeBinary,
): boolean =>
  runtime.nodeAbi === binary.nodeAbi &&
  binary.admittedNodeMajors.includes(runtime.nodeMajor) &&
  runtime.platform === binary.platform &&
  compareVersions(runtime.osVersion, binary.minimumOsVersion) >= 0 &&
  runtime.architecture === binary.architecture &&
  (binary.platform !== "linux" ||
    (runtime.libcFamily === binary.libcFamily &&
      runtime.libcVersion !== null &&
      compareVersions(runtime.libcVersion, binary.minimumLibcVersion!) >= 0));

const MANIFEST_KEYS = Object.freeze([
  "schemaVersion",
  "capability",
  "disposition",
  "artifactRoot",
  "loaderContract",
  "namespaceMutationContract",
  "recoveryFenceLockContract",
  "buildSandboxProfile",
  "executionSandboxProfile",
  "maximumSnapshotBytes",
  "minimumNativeChildBudgetMilliseconds",
  "nativeTeardownReserveMilliseconds",
  "releaseMaterialManifestDigest",
  "provenanceDigest",
  "sbomDigest",
  "noticeInventoryDigest",
  "artifactFiles",
  "nativeBinaries",
  "supportedPlatforms",
]);

type ManifestEnvelope = Readonly<{
  manifest: Readonly<Record<string, unknown>>;
  artifactValues: readonly unknown[];
  nativeValues: readonly unknown[];
  platformValues: readonly unknown[];
}>;

const snapshotManifestEnvelope = (
  value: unknown,
): ManifestEnvelope | undefined => {
  const manifest = exactRecord(value, MANIFEST_KEYS);
  if (manifest === undefined) return undefined;
  const artifactValues = exactArray(manifest.artifactFiles, 64);
  const nativeValues = exactArray(manifest.nativeBinaries, 16);
  const platformValues = exactArray(manifest.supportedPlatforms, 64);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.capability !== "local-sqlite" ||
    manifest.disposition !== "proposed-unpublished-execution-eligible" ||
    manifest.artifactRoot !== "internal/local-sqlite" ||
    manifest.loaderContract !==
      "owned-absolute-no-discovery-plus-exchange-v2" ||
    manifest.namespaceMutationContract !==
      "linux-renameat2-exchange-exact-inode-v1" ||
    manifest.recoveryFenceLockContract !==
      "linux-flock-exclusive-nonblocking-open-description-process-death-release-v1" ||
    manifest.buildSandboxProfile !== "agentscope-owned-native-build-v1" ||
    manifest.executionSandboxProfile !==
      "agentscope-sacrificial-native-execution-v1" ||
    !validInteger(
      manifest.maximumSnapshotBytes,
      1,
      64 * 1_024 * 1_024 * 1_024,
    ) ||
    !validInteger(manifest.minimumNativeChildBudgetMilliseconds, 1, 1_000) ||
    !validInteger(manifest.nativeTeardownReserveMilliseconds, 1, 5_000) ||
    manifest.minimumNativeChildBudgetMilliseconds +
      manifest.nativeTeardownReserveMilliseconds >
      60_000 ||
    typeof manifest.releaseMaterialManifestDigest !== "string" ||
    !SHA256.test(manifest.releaseMaterialManifestDigest) ||
    typeof manifest.provenanceDigest !== "string" ||
    !SHA256.test(manifest.provenanceDigest) ||
    typeof manifest.sbomDigest !== "string" ||
    !SHA256.test(manifest.sbomDigest) ||
    typeof manifest.noticeInventoryDigest !== "string" ||
    !SHA256.test(manifest.noticeInventoryDigest) ||
    artifactValues === undefined ||
    nativeValues === undefined ||
    platformValues === undefined
  )
    return undefined;
  return Object.freeze({
    manifest,
    artifactValues,
    nativeValues,
    platformValues,
  });
};

const snapshotArtifactInventory = (
  envelope: ManifestEnvelope,
): ReadonlyMap<string, NativeArtifactFile> | undefined => {
  const artifacts = new Map<string, NativeArtifactFile>();
  const digests = new Set<string>();
  const kinds = new Map<NativeArtifactKind, number>();
  for (const value of envelope.artifactValues) {
    const artifact = snapshotArtifact(value);
    if (
      artifact === undefined ||
      artifacts.has(artifact.relativePath) ||
      digests.has(artifact.digest)
    )
      return undefined;
    artifacts.set(artifact.relativePath, artifact);
    digests.add(artifact.digest);
    kinds.set(artifact.kind, (kinds.get(artifact.kind) ?? 0) + 1);
  }
  const { manifest, nativeValues } = envelope;
  if (
    kinds.get("native-binary") !== nativeValues.length ||
    kinds.get("loader") !== 1 ||
    kinds.get("runtime") !== 1 ||
    kinds.get("provenance") !== 1 ||
    kinds.get("release-materials") !== 1 ||
    kinds.get("sbom") !== 1 ||
    kinds.get("notice") !== 3 ||
    artifacts.get("records/provenance.json")?.digest !==
      manifest.provenanceDigest ||
    artifacts.get("records/release-materials.json")?.digest !==
      manifest.releaseMaterialManifestDigest ||
    artifacts.get("records/sbom.spdx.json")?.digest !== manifest.sbomDigest
  )
    return undefined;
  const notices = [...artifacts.values()]
    .filter(({ kind }) => kind === "notice")
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map(({ relativePath, bytes, digest }) => ({
      relativePath,
      bytes,
      digest,
    }));
  const noticeDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify(notices))
    .digest("hex")}`;
  return noticeDigest === manifest.noticeInventoryDigest
    ? Object.freeze(artifacts)
    : undefined;
};

const snapshotBinaries = (
  values: readonly unknown[],
  artifacts: ReadonlyMap<string, NativeArtifactFile>,
): ReadonlyMap<string, NativeBinary> | undefined => {
  const binaries = new Map<string, NativeBinary>();
  const paths = new Set<string>();
  const digests = new Set<string>();
  const projections = new Set<string>();
  for (const value of values) {
    const binary = snapshotBinary(value);
    const projection = binary && nativeProjectionKey(binary);
    const artifact = binary && artifacts.get(binary.relativePath);
    if (
      binary === undefined ||
      projection === undefined ||
      binaries.has(binary.tupleId) ||
      paths.has(binary.relativePath) ||
      digests.has(binary.digest) ||
      projections.has(projection) ||
      artifact?.kind !== "native-binary" ||
      artifact.bytes !== binary.bytes ||
      artifact.digest !== binary.digest
    )
      return undefined;
    binaries.set(binary.tupleId, binary);
    paths.add(binary.relativePath);
    digests.add(binary.digest);
    projections.add(projection);
  }
  return Object.freeze(binaries);
};

const selectPlatform = (
  runtime: LocalSqliteRuntimeIdentity,
  values: readonly unknown[],
  binaries: ReadonlyMap<string, NativeBinary>,
):
  | Readonly<{ platform: SupportedPlatform; binary: NativeBinary }>
  | undefined => {
  const references = new Set<string>();
  const platformIds = new Set<string>();
  let selected:
    Readonly<{ platform: SupportedPlatform; binary: NativeBinary }> | undefined;
  for (const value of values) {
    const platform = snapshotPlatform(value);
    const binary = platform && binaries.get(platform.nativeTupleId);
    if (
      platform === undefined ||
      binary === undefined ||
      !binary.admittedNodeMajors.includes(platform.nodeMajor) ||
      platformIds.has(platform.platformId)
    )
      return undefined;
    platformIds.add(platform.platformId);
    references.add(platform.nativeTupleId);
    const matches =
      platform.nodeMajor === runtime.nodeMajor &&
      platform.credentialBackend === runtime.credentialBackend &&
      platform.filesystemProfile === runtime.filesystemProfile &&
      runtimeMatchesBinary(runtime, binary);
    if (matches) {
      if (selected !== undefined) return undefined;
      selected = Object.freeze({ platform, binary });
    }
  }
  return references.size === binaries.size ? selected : undefined;
};

const inspectManifest = (
  runtimeValue: unknown,
  manifestValue: unknown,
): LocalSqliteNativeSupportResult => {
  const runtime = snapshotRuntime(runtimeValue);
  const envelope = snapshotManifestEnvelope(manifestValue);
  if (runtime === undefined || envelope === undefined) return unavailable();
  const artifacts = snapshotArtifactInventory(envelope);
  if (artifacts === undefined) return unavailable();
  const binaries = snapshotBinaries(envelope.nativeValues, artifacts);
  if (binaries === undefined) return unavailable();
  const selected = selectPlatform(runtime, envelope.platformValues, binaries);
  if (selected === undefined) return unavailable();
  return Object.freeze({
    state: "available",
    platformId: selected.platform.platformId,
    nativeTupleId: selected.binary.tupleId,
    admission: "proposed-unpublished",
    relativePath: selected.binary.relativePath,
    bytes: selected.binary.bytes,
    digest: selected.binary.digest,
    maximumSnapshotBytes: envelope.manifest.maximumSnapshotBytes as number,
    minimumNativeChildBudgetMilliseconds: envelope.manifest
      .minimumNativeChildBudgetMilliseconds as number,
    nativeTeardownReserveMilliseconds: envelope.manifest
      .nativeTeardownReserveMilliseconds as number,
  });
};

export const inspectLocalSqliteNativeSupportManifestForTesting = (
  runtime: LocalSqliteRuntimeIdentity,
  manifest: LocalSqliteNativeSupportManifest,
): LocalSqliteNativeSupportResult => {
  try {
    return inspectManifest(runtime, manifest);
  } catch {
    return unavailable();
  }
};
