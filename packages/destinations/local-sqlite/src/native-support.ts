const IDENTIFIER = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const VERSION = /^(?:0|[1-9][0-9]{0,5})(?:\.(?:0|[1-9][0-9]{0,5})){0,3}$/u;

type NativePlatform = "darwin" | "linux" | "win32";
type NativeArchitecture = "arm64" | "x64";
type LibcFamily = "glibc" | "musl";
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
      relativePath: string;
      bytes: number;
      digest: string;
    }>
  | Readonly<{
      state: "unavailable";
      code: "destination.local-sqlite.native-unavailable";
    }>;

export const LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST: LocalSqliteNativeSupportManifest =
  Object.freeze({
    schemaVersion: 1,
    capability: "local-sqlite",
    nativeBinaries: Object.freeze([]),
    supportedPlatforms: Object.freeze([]),
  });

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

const inspectManifest = (
  runtimeValue: unknown,
  manifestValue: unknown,
): LocalSqliteNativeSupportResult => {
  const runtime = snapshotRuntime(runtimeValue);
  const manifest = exactRecord(manifestValue, [
    "schemaVersion",
    "capability",
    "nativeBinaries",
    "supportedPlatforms",
  ]);
  if (runtime === undefined || manifest === undefined) return unavailable();
  const nativeValues = exactArray(manifest.nativeBinaries, 16);
  const platformValues = exactArray(manifest.supportedPlatforms, 64);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.capability !== "local-sqlite" ||
    nativeValues === undefined ||
    platformValues === undefined
  )
    return unavailable();
  const binaries = new Map<string, NativeBinary>();
  const paths = new Set<string>();
  const digests = new Set<string>();
  const projections = new Set<string>();
  for (const value of nativeValues) {
    const binary = snapshotBinary(value);
    const projection =
      binary === undefined ? undefined : nativeProjectionKey(binary);
    if (
      binary === undefined ||
      projection === undefined ||
      binaries.has(binary.tupleId) ||
      paths.has(binary.relativePath) ||
      digests.has(binary.digest) ||
      projections.has(projection)
    )
      return unavailable();
    binaries.set(binary.tupleId, binary);
    paths.add(binary.relativePath);
    digests.add(binary.digest);
    projections.add(projection);
  }
  const references = new Set<string>();
  const platformIds = new Set<string>();
  let selected:
    Readonly<{ platform: SupportedPlatform; binary: NativeBinary }> | undefined;
  for (const value of platformValues) {
    const platform = snapshotPlatform(value);
    const binary =
      platform === undefined ? undefined : binaries.get(platform.nativeTupleId);
    if (
      platform === undefined ||
      binary === undefined ||
      !binary.admittedNodeMajors.includes(platform.nodeMajor) ||
      platformIds.has(platform.platformId)
    )
      return unavailable();
    platformIds.add(platform.platformId);
    references.add(platform.nativeTupleId);
    if (
      platform.nodeMajor === runtime.nodeMajor &&
      platform.credentialBackend === runtime.credentialBackend &&
      platform.filesystemProfile === runtime.filesystemProfile &&
      runtimeMatchesBinary(runtime, binary)
    ) {
      if (selected !== undefined) return unavailable();
      selected = Object.freeze({ platform, binary });
    }
  }
  if (references.size !== binaries.size || selected === undefined)
    return unavailable();
  return Object.freeze({
    state: "available",
    platformId: selected.platform.platformId,
    nativeTupleId: selected.binary.tupleId,
    relativePath: selected.binary.relativePath,
    bytes: selected.binary.bytes,
    digest: selected.binary.digest,
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

export const inspectLocalSqliteNativeSupport = (
  runtime: LocalSqliteRuntimeIdentity,
): LocalSqliteNativeSupportResult => {
  try {
    return inspectManifest(runtime, LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST);
  } catch {
    return unavailable();
  }
};
