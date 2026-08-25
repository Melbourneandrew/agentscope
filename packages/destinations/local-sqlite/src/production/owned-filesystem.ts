import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";

export type OwnedDirectory = Readonly<{
  path: string;
  descriptor: number;
  device: bigint;
  inode: bigint;
  currentUserOnly: boolean;
  relativeRoot: string;
  assertCurrent: () => void;
  close: () => void;
}>;

export type OwnedFileEvidence = Readonly<{
  bytes: number;
  physicalIdentity: string;
  sparse: boolean;
}>;

export type OwnedFile = Readonly<{
  descriptor: number;
  evidence: OwnedFileEvidence;
  descriptorPath: string;
  assertCurrent: () => OwnedFileEvidence;
  sync: () => OwnedFileEvidence;
  close: () => void;
}>;

export type OwnedSqliteFamilyEvidence = Readonly<{
  name: string;
  evidence: OwnedFileEvidence;
}>;

export type OwnedFileRetirementEvidence = Readonly<{
  evidence: OwnedFileEvidence;
  state: "public-only" | "public-and-claim" | "claim-only";
}>;

export type OwnedAtomicExchange = (
  directoryDescriptor: number,
  request: Readonly<{
    sourceName: string;
    destinationName: string;
    sourceDevice: string;
    sourceInode: string;
    destinationDevice: string;
    destinationInode: string;
  }>,
) => "exchanged" | "mismatch" | "raced";

export class LocalSqliteOwnedFilesystemError extends Error {
  constructor(public readonly code: "invalid" | "raced") {
    super(`destination.local-sqlite.filesystem.${code}`);
    this.name = "LocalSqliteOwnedFilesystemError";
  }
}

const invalid = (): never => {
  throw new LocalSqliteOwnedFilesystemError("invalid");
};

const raced = (): never => {
  throw new LocalSqliteOwnedFilesystemError("raced");
};

const requiredFilesystemFlag = (value: number | undefined): number => {
  /* v8 ignore next -- supported Node platforms expose both O_DIRECTORY and
     O_NOFOLLOW; absence is retained as a fail-closed runtime guard. */
  if (value === undefined) return invalid();
  return value;
};

const directoryFlag = requiredFilesystemFlag(constants.O_DIRECTORY);
const noFollowFlag = requiredFilesystemFlag(constants.O_NOFOLLOW);

const validName = (name: string): void => {
  if (
    name.length < 1 ||
    name.length > 255 ||
    basename(name) !== name ||
    name === "." ||
    name === ".." ||
    name.includes("\0") ||
    name.includes("/") ||
    name.includes("\\")
  )
    invalid();
};

const identity = (state: Readonly<{ dev: bigint; ino: bigint }>): string =>
  `dev:${state.dev}:ino:${state.ino}`;

const identityParts = (
  physicalIdentity: string,
): Readonly<{ device: string; inode: string }> => {
  const match = /^dev:([0-9]+):ino:([0-9]+)$/u.exec(physicalIdentity);
  /* v8 ignore next -- callers compare against kernel-derived identities before
     this split; malformed caller identities fail that comparison first. */
  if (match?.[1] === undefined || match[2] === undefined) return invalid();
  return Object.freeze({ device: match[1], inode: match[2] });
};

const exchangeTemporaryNameForTesting = (): string =>
  `.agentscope-exchange-testing-${randomBytes(16).toString("hex")}`;

const namespaceClaimPrefix = "namespace-claim-v1-";
const maximumClaimedNameBytes = 100;

export const localSqliteNamespaceClaimName = (publicName: string): string => {
  validName(publicName);
  const publicBytes = Buffer.from(publicName, "utf8");
  if (
    publicBytes.byteLength < 1 ||
    publicBytes.byteLength > maximumClaimedNameBytes ||
    publicName.startsWith(namespaceClaimPrefix)
  )
    invalid();
  const claimName = `${namespaceClaimPrefix}${publicBytes.toString("hex")}`;
  validName(claimName);
  return claimName;
};

export const decodeLocalSqliteNamespaceClaimName = (
  claimName: string,
): string | undefined => {
  try {
    validName(claimName);
    if (!claimName.startsWith(namespaceClaimPrefix)) return undefined;
    const encoded = claimName.slice(namespaceClaimPrefix.length);
    if (
      encoded.length < 2 ||
      encoded.length > maximumClaimedNameBytes * 2 ||
      encoded.length % 2 !== 0 ||
      !/^[a-f0-9]+$/u.test(encoded)
    )
      return undefined;
    const decoded = Buffer.from(encoded, "hex").toString("utf8");
    return localSqliteNamespaceClaimName(decoded) === claimName
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
};

export const createPathAtomicExchangeForTesting =
  (directoryPath: string): OwnedAtomicExchange =>
  (_descriptor, { sourceName, destinationName }) => {
    const temporaryName = exchangeTemporaryNameForTesting();
    renameSync(
      join(directoryPath, sourceName),
      join(directoryPath, temporaryName),
    );
    renameSync(
      join(directoryPath, destinationName),
      join(directoryPath, sourceName),
    );
    renameSync(
      join(directoryPath, temporaryName),
      join(directoryPath, destinationName),
    );
    return "exchanged";
  };

export const openOwnedDirectory = (
  path: string,
  allowPathFallbackForTesting = false,
): OwnedDirectory => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | directoryFlag | noFollowFlag,
  );
  try {
    const state = fstatSync(descriptor, { bigint: true });
    /* v8 ignore next -- O_DIRECTORY makes a successful open of a nondirectory
       impossible; retained as same-handle type evidence. */
    if (!state.isDirectory()) invalid();
    /* v8 ignore next -- macOS source tests exercise the explicitly branded
       pathname fallback; the Linux native/packed verifier exercises /proc FDs. */
    const relativeRoot =
      process.platform === "linux"
        ? `/proc/self/fd/${descriptor}`
        : allowPathFallbackForTesting
          ? path
          : invalid();
    let closed = false;
    const assertCurrent = (): void => {
      if (closed) invalid();
      const currentDescriptor = fstatSync(descriptor, { bigint: true });
      const currentPath = lstatSync(path, { bigint: true });
      if (
        !currentDescriptor.isDirectory() ||
        !currentPath.isDirectory() ||
        currentPath.isSymbolicLink() ||
        currentDescriptor.dev !== state.dev ||
        currentDescriptor.ino !== state.ino ||
        currentPath.dev !== state.dev ||
        currentPath.ino !== state.ino
      )
        raced();
    };
    return Object.freeze({
      path,
      descriptor,
      device: state.dev,
      inode: state.ino,
      currentUserOnly:
        process.platform === "win32" || (Number(state.mode) & 0o077) === 0,
      relativeRoot,
      assertCurrent,
      close: () => {
        if (closed) return;
        closed = true;
        closeSync(descriptor);
      },
    });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
};

const relativePath = (directory: OwnedDirectory, name: string): string => {
  validName(name);
  return join(directory.relativeRoot, name);
};

const evidenceForDescriptor = (
  descriptor: number,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): OwnedFileEvidence => {
  const state = fstatSync(descriptor, { bigint: true });
  if (
    !state.isFile() ||
    state.size < 0n ||
    state.size > BigInt(maximumBytes) ||
    state.size > BigInt(Number.MAX_SAFE_INTEGER)
  )
    invalid();
  return Object.freeze({
    bytes: Number(state.size),
    physicalIdentity: identity(state),
    sparse: state.blocks * 512n < state.size,
  });
};

export const statOwnedFile = (
  directory: OwnedDirectory,
  name: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): OwnedFileEvidence => {
  const descriptor = openSync(
    relativePath(directory, name),
    constants.O_RDONLY | noFollowFlag,
  );
  try {
    const evidence = evidenceForDescriptor(descriptor, maximumBytes);
    directory.assertCurrent();
    return evidence;
  } finally {
    closeSync(descriptor);
  }
};

export const openOwnedFile = (
  directory: OwnedDirectory,
  name: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
  options: Readonly<{
    writable?: boolean;
    requireNonempty?: boolean;
  }> = {},
): OwnedFile => {
  const path = relativePath(directory, name);
  const descriptor = openSync(
    path,
    (options.writable === true ? constants.O_RDWR : constants.O_RDONLY) |
      noFollowFlag,
  );
  try {
    const evidence = evidenceForDescriptor(descriptor, maximumBytes);
    if (options.requireNonempty === true && evidence.bytes === 0) invalid();
    directory.assertCurrent();
    let closed = false;
    const assertCurrent = (): OwnedFileEvidence => {
      if (closed) invalid();
      const retained = evidenceForDescriptor(descriptor, maximumBytes);
      /* v8 ignore next -- an open file descriptor cannot change inode. */
      if (retained.physicalIdentity !== evidence.physicalIdentity) raced();
      const currentDescriptor = openSync(
        path,
        (options.writable === true ? constants.O_RDWR : constants.O_RDONLY) |
          noFollowFlag,
      );
      try {
        const current = evidenceForDescriptor(currentDescriptor, maximumBytes);
        if (current.physicalIdentity !== evidence.physicalIdentity) raced();
      } finally {
        closeSync(currentDescriptor);
      }
      directory.assertCurrent();
      return retained;
    };
    return Object.freeze({
      descriptor,
      evidence,
      /* v8 ignore next -- both fixed platform projections are exercised by
         their native CI lanes; one host cannot execute both branches. */
      descriptorPath:
        process.platform === "linux" ? `/proc/self/fd/${descriptor}` : path,
      assertCurrent,
      sync: () => {
        if (closed) invalid();
        fsyncSync(descriptor);
        fsyncSync(directory.descriptor);
        return assertCurrent();
      },
      close: () => {
        if (closed) return;
        closed = true;
        closeSync(descriptor);
      },
    });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
};

export const createOwnedExclusiveFile = (
  directory: OwnedDirectory,
  name: string,
  maximumBytes: number,
  initialBytes: Uint8Array = Buffer.alloc(0),
): OwnedFile => {
  if (initialBytes.byteLength > maximumBytes) invalid();
  const path = relativePath(directory, name);
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollowFlag,
    0o600,
  );
  let createdPhysicalIdentity: string | undefined;
  try {
    createdPhysicalIdentity = identity(fstatSync(descriptor, { bigint: true }));
    let offset = 0;
    while (offset < initialBytes.byteLength)
      offset += writeSync(
        descriptor,
        initialBytes,
        offset,
        initialBytes.byteLength - offset,
      );
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    const evidence = evidenceForDescriptor(descriptor, maximumBytes);
    /* v8 ignore next -- same-handle byte accounting immediately follows the
       bounded write loop; a mismatch is a kernel/filesystem race. */
    if (evidence.bytes !== initialBytes.byteLength) raced();
    directory.assertCurrent();
    fsyncSync(directory.descriptor);
    let closed = false;
    const assertCurrent = (): OwnedFileEvidence => {
      if (closed) invalid();
      const retained = evidenceForDescriptor(descriptor, maximumBytes);
      /* v8 ignore next -- an open file descriptor cannot change inode. */
      if (retained.physicalIdentity !== evidence.physicalIdentity) raced();
      const currentDescriptor = openSync(path, constants.O_RDWR | noFollowFlag);
      try {
        const current = evidenceForDescriptor(currentDescriptor, maximumBytes);
        if (current.physicalIdentity !== evidence.physicalIdentity) raced();
      } finally {
        closeSync(currentDescriptor);
      }
      directory.assertCurrent();
      return retained;
    };
    return Object.freeze({
      descriptor,
      evidence,
      /* v8 ignore next -- both fixed platform projections are exercised by
         their native CI lanes; one host cannot execute both branches. */
      descriptorPath:
        process.platform === "linux" ? `/proc/self/fd/${descriptor}` : path,
      assertCurrent,
      sync: () => {
        if (closed) invalid();
        fsyncSync(descriptor);
        fsyncSync(directory.descriptor);
        return assertCurrent();
      },
      close: () => {
        if (closed) return;
        closed = true;
        closeSync(descriptor);
      },
    });
  } catch (error) {
    closeSync(descriptor);
    /* v8 ignore else -- after O_EXCL open, only a kernel fstat failure can leave
       the created inode without a physical identity for cleanup. */
    if (createdPhysicalIdentity !== undefined)
      try {
        // The create never returned authority for this inode. Remove only that
        // exact inode through the retained directory descriptor even when the
        // public directory name was replaced. removeOwnedFile may then report
        // the triggering directory race, but the descriptor-rooted unlink has
        // already prevented an unactionable failed-creation artifact.
        removeOwnedFile(directory, name, createdPhysicalIdentity);
      } catch {
        /* v8 ignore next -- cleanup failure retains bounded reconciliation
           evidence and preserves the original acquisition failure. */
      }
    throw error;
  }
};

export const readOwnedUtf8 = (
  directory: OwnedDirectory,
  name: string,
  maximumBytes: number,
  requireNonempty = true,
): Readonly<{ content: string; evidence: OwnedFileEvidence }> => {
  const descriptor = openSync(
    relativePath(directory, name),
    constants.O_RDONLY | noFollowFlag,
  );
  try {
    const before = evidenceForDescriptor(descriptor, maximumBytes);
    if (requireNonempty && before.bytes === 0) invalid();
    const bytes = Buffer.allocUnsafe(before.bytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (count === 0) break;
      offset += count;
    }
    /* v8 ignore next -- a short same-handle regular-file read is a concurrent
       mutation race; deterministic namespace races are covered separately. */
    if (offset !== before.bytes) raced();
    const after = evidenceForDescriptor(descriptor, maximumBytes);
    /* v8 ignore next -- same-handle size/identity drift is the concurrent
       mutation counterpart of the deterministic namespace-race tests. */
    if (
      before.bytes !== after.bytes ||
      before.physicalIdentity !== after.physicalIdentity
    )
      raced();
    directory.assertCurrent();
    return Object.freeze({
      content: bytes.subarray(0, offset).toString("utf8"),
      evidence: after,
    });
  } finally {
    closeSync(descriptor);
  }
};

export const readOwnedPrefix = (
  directory: OwnedDirectory,
  name: string,
  maximumFileBytes: number,
  maximumReadBytes: number,
): Readonly<{ bytes: Uint8Array; evidence: OwnedFileEvidence }> => {
  if (
    !Number.isSafeInteger(maximumReadBytes) ||
    maximumReadBytes < 1 ||
    maximumReadBytes > maximumFileBytes
  )
    invalid();
  const descriptor = openSync(
    relativePath(directory, name),
    constants.O_RDONLY | noFollowFlag,
  );
  try {
    const before = evidenceForDescriptor(descriptor, maximumFileBytes);
    const length = Math.min(before.bytes, maximumReadBytes);
    const bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      /* v8 ignore next -- a short same-handle regular-file read requires a
         concurrent mutation; the production guard remains fail-closed. */
      if (count === 0) break;
      offset += count;
    }
    /* v8 ignore next -- paired with the concurrent short-read guard above. */
    if (offset !== length) raced();
    const after = evidenceForDescriptor(descriptor, maximumFileBytes);
    /* v8 ignore next -- same-handle size/identity drift requires a concurrent
       mutation; deterministic parent replacement is source-tested. */
    if (
      before.bytes !== after.bytes ||
      before.physicalIdentity !== after.physicalIdentity
    )
      raced();
    directory.assertCurrent();
    return Object.freeze({ bytes: bytes.subarray(0, offset), evidence: after });
  } finally {
    closeSync(descriptor);
  }
};

export const writeOwnedExclusive = (
  directory: OwnedDirectory,
  name: string,
  bytes: Uint8Array,
  maximumBytes: number,
  allowEmpty = false,
): OwnedFileEvidence => {
  if ((!allowEmpty && bytes.byteLength < 1) || bytes.byteLength > maximumBytes)
    invalid();
  const descriptor = openSync(
    relativePath(directory, name),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.byteLength)
      offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    const evidence = evidenceForDescriptor(descriptor, maximumBytes);
    /* v8 ignore next -- the complete write loop and same descriptor fstat make
       a different size possible only through an external file mutation. */
    if (evidence.bytes !== bytes.byteLength) invalid();
    directory.assertCurrent();
    fsyncSync(directory.descriptor);
    return evidence;
  } finally {
    closeSync(descriptor);
  }
};

export const syncOwnedFile = (
  directory: OwnedDirectory,
  name: string,
  maximumBytes: number,
): OwnedFileEvidence => {
  const descriptor = openSync(
    relativePath(directory, name),
    constants.O_RDONLY | noFollowFlag,
  );
  try {
    const evidence = evidenceForDescriptor(descriptor, maximumBytes);
    fsyncSync(descriptor);
    directory.assertCurrent();
    fsyncSync(directory.descriptor);
    return evidence;
  } finally {
    closeSync(descriptor);
  }
};

export const syncOwnedDirectory = (directory: OwnedDirectory): void => {
  directory.assertCurrent();
  fsyncSync(directory.descriptor);
  directory.assertCurrent();
};

export const boundedOwnedNames = (
  directory: OwnedDirectory,
  maximumEntries: number,
): readonly string[] => {
  const handle = opendirSync(directory.relativeRoot);
  const names: string[] = [];
  try {
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      if (names.length === maximumEntries) invalid();
      validName(entry.name);
      names.push(entry.name);
    }
  } finally {
    handle.closeSync();
  }
  directory.assertCurrent();
  return Object.freeze(names.sort());
};

export const boundedOwnedLogicalNames = (
  directory: OwnedDirectory,
  maximumEntries: number,
): readonly string[] => {
  if (
    !Number.isSafeInteger(maximumEntries) ||
    maximumEntries < 1 ||
    maximumEntries >= Number.MAX_SAFE_INTEGER
  )
    return invalid();
  // One durable removal claim may coexist with its public name without
  // consuming a second logical inventory slot.
  const physicalNames = boundedOwnedNames(directory, maximumEntries + 1);
  const claims = physicalNames.filter(
    (name) => decodeLocalSqliteNamespaceClaimName(name) !== undefined,
  );
  if (claims.length > 1) return invalid();
  const logicalNames = [
    ...new Set(
      physicalNames.map(
        (name) => decodeLocalSqliteNamespaceClaimName(name) ?? name,
      ),
    ),
  ].sort();
  if (logicalNames.length > maximumEntries) return invalid();
  for (const name of logicalNames)
    /* v8 ignore next 2 -- disappearance between the two bounded retained-directory
       scans is the externally concurrent namespace-race outcome. */
    if (inspectOwnedFileRetirement(directory, name) === undefined) raced();
  return Object.freeze(logicalNames);
};

export const inspectOwnedSqliteFamily = (
  directory: OwnedDirectory,
  databaseName: string,
  maximumBytes: number,
): readonly OwnedSqliteFamilyEvidence[] => {
  try {
    validName(databaseName);
    const allowed = new Set([
      databaseName,
      `${databaseName}-wal`,
      `${databaseName}-shm`,
    ]);
    const familyNames = boundedOwnedNames(directory, 128).filter(
      (name) => name === databaseName || name.startsWith(`${databaseName}-`),
    );
    if (
      !familyNames.includes(databaseName) ||
      familyNames.some((name) => !allowed.has(name))
    )
      invalid();
    return Object.freeze(
      familyNames.map((name) =>
        Object.freeze({
          name,
          evidence: statOwnedFile(directory, name, maximumBytes),
        }),
      ),
    );
  } catch (error) {
    if (error instanceof LocalSqliteOwnedFilesystemError) throw error;
    return invalid();
  }
};

export const removeOwnedFile = (
  directory: OwnedDirectory,
  name: string,
  expectedPhysicalIdentity?: string,
  afterQuarantineForTesting?: () => void,
): "removed" | "absent" | "mismatch" => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      relativePath(directory, name),
      constants.O_RDONLY | noFollowFlag,
    );
    const evidence = evidenceForDescriptor(descriptor);
    if (
      expectedPhysicalIdentity !== undefined &&
      evidence.physicalIdentity !== expectedPhysicalIdentity
    )
      return "mismatch";
    unlinkSync(relativePath(directory, name));
    fsyncSync(directory.descriptor);
    afterQuarantineForTesting?.();
    directory.assertCurrent();
    try {
      statOwnedFile(directory, name);
      return "mismatch";
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return "removed";
      throw error;
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return "absent";
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const optionalOwnedFileEvidence = (
  directory: OwnedDirectory,
  name: string,
): OwnedFileEvidence | undefined => {
  try {
    return statOwnedFile(directory, name);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw error;
  }
};

export const inspectOwnedFileRetirement = (
  directory: OwnedDirectory,
  publicName: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): OwnedFileRetirementEvidence | undefined => {
  const claimName = localSqliteNamespaceClaimName(publicName);
  const publicEvidence = (() => {
    try {
      return statOwnedFile(directory, publicName, maximumBytes);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return undefined;
      throw error;
    }
  })();
  const claimEvidence = (() => {
    try {
      return statOwnedFile(directory, claimName, maximumBytes);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return undefined;
      throw error;
    }
  })();
  if (publicEvidence === undefined && claimEvidence === undefined)
    return undefined;
  if (
    publicEvidence !== undefined &&
    claimEvidence !== undefined &&
    publicEvidence.physicalIdentity !== claimEvidence.physicalIdentity
  )
    raced();
  return Object.freeze({
    /* v8 ignore next -- one member is present after the absent branch. */
    evidence: publicEvidence ?? claimEvidence!,
    state:
      publicEvidence === undefined
        ? "claim-only"
        : claimEvidence === undefined
          ? "public-only"
          : "public-and-claim",
  });
};

export const readOwnedRetirementUtf8 = (
  directory: OwnedDirectory,
  publicName: string,
  maximumBytes: number,
  requireNonempty = true,
): Readonly<{
  content: string;
  retirement: OwnedFileRetirementEvidence;
}> => {
  const retirement = inspectOwnedFileRetirement(
    directory,
    publicName,
    maximumBytes,
  );
  if (retirement === undefined) return invalid();
  const actualName =
    retirement.state === "claim-only"
      ? localSqliteNamespaceClaimName(publicName)
      : publicName;
  const read = readOwnedUtf8(
    directory,
    actualName,
    maximumBytes,
    requireNonempty,
  );
  /* v8 ignore next 2 -- a replacement between the retained retirement scan and
     no-follow read is the externally concurrent namespace-race outcome. */
  if (read.evidence.physicalIdentity !== retirement.evidence.physicalIdentity)
    raced();
  return Object.freeze({ content: read.content, retirement });
};

export const retireOwnedFile = (
  directory: OwnedDirectory,
  publicName: string,
  expectedPhysicalIdentity?: string,
  afterClaimForTesting?: () => void,
): "removed" | "absent" | "mismatch" => {
  const claimName = localSqliteNamespaceClaimName(publicName);
  const publicEvidence = optionalOwnedFileEvidence(directory, publicName);
  let claimEvidence = optionalOwnedFileEvidence(directory, claimName);
  if (publicEvidence === undefined && claimEvidence === undefined)
    return "absent";
  const physicalIdentity =
    publicEvidence?.physicalIdentity ?? claimEvidence?.physicalIdentity;
  /* v8 ignore next -- both values cannot be absent after the terminal branch. */
  if (physicalIdentity === undefined) return "absent";
  if (
    expectedPhysicalIdentity !== undefined &&
    physicalIdentity !== expectedPhysicalIdentity
  )
    return "mismatch";
  if (
    claimEvidence !== undefined &&
    claimEvidence.physicalIdentity !== physicalIdentity
  )
    return "mismatch";
  if (publicEvidence !== undefined && claimEvidence === undefined) {
    linkOwnedFile(
      directory,
      publicName,
      claimName,
      physicalIdentity,
      afterClaimForTesting,
    );
    claimEvidence = statOwnedFile(directory, claimName);
  } else afterClaimForTesting?.();
  if (
    claimEvidence?.physicalIdentity !== physicalIdentity ||
    (publicEvidence !== undefined &&
      statOwnedFile(directory, publicName).physicalIdentity !==
        physicalIdentity)
  )
    return "mismatch";
  /* v8 ignore next 5 -- after the two exact identity checks, only an external
     same-principal namespace substitution can change either removal result. */
  if (
    publicEvidence !== undefined &&
    removeOwnedFile(directory, publicName, physicalIdentity) !== "removed"
  )
    return "mismatch";
  /* v8 ignore next 2 -- the claim is the exact retained inode established above;
     a non-removed result is the same external namespace-race outcome. */
  if (removeOwnedFile(directory, claimName, physicalIdentity) !== "removed")
    return "mismatch";
  directory.assertCurrent();
  return "removed";
};

export const writeOwnedLogicalExclusive = (
  directory: OwnedDirectory,
  publicName: string,
  content: Uint8Array,
  maximumBytes: number,
  options: Readonly<{
    afterAbsentInspectionForTesting?: () => void;
    afterCreateForTesting?: (created: OwnedFileEvidence) => void;
  }> = {},
):
  | Readonly<{ state: "created"; physicalIdentity: string }>
  | Readonly<{ state: "exists" }> => {
  if (
    inspectOwnedFileRetirement(directory, publicName, maximumBytes) !==
    undefined
  )
    return Object.freeze({ state: "exists" });
  options.afterAbsentInspectionForTesting?.();
  let created: OwnedFileEvidence;
  try {
    created = writeOwnedExclusive(directory, publicName, content, maximumBytes);
  } catch (error) {
    /* v8 ignore next 7 -- the EEXIST result is source-tested; all other creation
       failures are exhaustively owned by writeOwnedExclusive and propagate. */
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    )
      return Object.freeze({ state: "exists" });
    /* v8 ignore next -- non-EEXIST creation failures propagate unchanged. */
    throw error;
  }
  options.afterCreateForTesting?.(created);
  const publicEvidence = optionalOwnedFileEvidence(directory, publicName);
  const claimEvidence = optionalOwnedFileEvidence(
    directory,
    localSqliteNamespaceClaimName(publicName),
  );
  if (
    publicEvidence?.physicalIdentity === created.physicalIdentity &&
    claimEvidence === undefined
  )
    return Object.freeze({
      state: "created",
      physicalIdentity: created.physicalIdentity,
    });
  // A retiring prior logical artifact may publish its deterministic claim and
  // remove the public name between the initial inspection and O_EXCL create.
  // Preserve that older claim and remove only the inode created by this call.
  if (publicEvidence?.physicalIdentity === created.physicalIdentity) {
    /* v8 ignore next 5 -- failure after the exact created inode is reread is an
       externally concurrent namespace substitution; the owned removal primitive
       carries the hostile last-observation matrix. */
    if (
      removeOwnedFile(directory, publicName, created.physicalIdentity) !==
      "removed"
    )
      raced();
  } else {
    /* v8 ignore next 2 -- a replacement after O_EXCL create is external
       same-principal namespace corruption. */
    if (publicEvidence !== undefined) raced();
  }
  directory.assertCurrent();
  return Object.freeze({ state: "exists" });
};

export const renameOwnedFile = (
  sourceDirectory: OwnedDirectory,
  sourceName: string,
  destinationDirectory: OwnedDirectory,
  destinationName: string,
  expectedSourceIdentity: string,
  afterQuarantineForTesting?: () => void,
  // eslint-disable-next-line max-params -- the optional final argument is a source-only race oracle; production authority remains the exact five-field mutation tuple.
): OwnedFileEvidence => {
  const source = statOwnedFile(sourceDirectory, sourceName);
  if (source.physicalIdentity !== expectedSourceIdentity) invalid();
  let destination: OwnedFileEvidence | undefined;
  try {
    destination = statOwnedFile(destinationDirectory, destinationName);
  } catch (error) {
    /* v8 ignore next 8 -- non-ENOENT destination inspection failures are owned
       by the no-follow stat primitive and propagate without reinterpretation. */
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  if (destination === undefined) {
    linkSync(
      relativePath(sourceDirectory, sourceName),
      relativePath(destinationDirectory, destinationName),
    );
    fsyncSync(destinationDirectory.descriptor);
    destination = statOwnedFile(destinationDirectory, destinationName);
  }
  /* v8 ignore next -- successful rename preserves the source inode; any
     contrary kernel/filesystem result must fail closed. */
  if (destination.physicalIdentity !== expectedSourceIdentity) invalid();
  afterQuarantineForTesting?.();
  if (
    statOwnedFile(sourceDirectory, sourceName).physicalIdentity !==
      expectedSourceIdentity ||
    statOwnedFile(destinationDirectory, destinationName).physicalIdentity !==
      expectedSourceIdentity
  )
    raced();
  unlinkSync(relativePath(sourceDirectory, sourceName));
  fsyncSync(sourceDirectory.descriptor);
  try {
    statOwnedFile(sourceDirectory, sourceName);
    raced();
  } catch (error) {
    /* v8 ignore next 7 -- after a successful unlink, a non-ENOENT stat requires
       an external same-name recreation in the final observation interval. */
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  sourceDirectory.assertCurrent();
  destinationDirectory.assertCurrent();
  return destination;
};

export const replaceOwnedFile = (
  directory: OwnedDirectory,
  sourceName: string,
  destinationName: string,
  expectedSourceIdentity: string,
  expectedDestinationIdentity: string,
  atomicExchange: OwnedAtomicExchange,
  beforeExchangeForTesting?: () => void,
  // eslint-disable-next-line max-params -- the final two arguments are the package-owned native exchange authority and a source-only race oracle.
): OwnedFileEvidence => {
  const source = statOwnedFile(directory, sourceName);
  const destination = statOwnedFile(directory, destinationName);
  if (
    source.physicalIdentity !== expectedSourceIdentity ||
    destination.physicalIdentity !== expectedDestinationIdentity
  )
    invalid();
  beforeExchangeForTesting?.();
  const sourceIdentity = identityParts(expectedSourceIdentity);
  const destinationIdentity = identityParts(expectedDestinationIdentity);
  const result = atomicExchange(
    directory.descriptor,
    Object.freeze({
      sourceName,
      destinationName,
      sourceDevice: sourceIdentity.device,
      sourceInode: sourceIdentity.inode,
      destinationDevice: destinationIdentity.device,
      destinationInode: destinationIdentity.inode,
    }),
  );
  if (result !== "exchanged") return raced();
  fsyncSync(directory.descriptor);
  const replaced = statOwnedFile(directory, destinationName);
  /* v8 ignore next -- successful same-directory replacement preserves the
     source inode; any contrary result must fail closed. */
  if (replaced.physicalIdentity !== expectedSourceIdentity) invalid();
  const removedSource = removeOwnedFile(
    directory,
    sourceName,
    expectedDestinationIdentity,
  );
  /* v8 ignore next -- exact exchange leaves the old destination at source;
     the identity-bound removal can only report removed absent a kernel race. */
  if (removedSource !== "removed") raced();
  /* v8 ignore start -- final retained-directory verification closes any
     post-exchange namespace race before authority is returned. */
  if (
    statOwnedFile(directory, destinationName).physicalIdentity !==
    expectedSourceIdentity
  )
    raced();
  /* v8 ignore stop */
  directory.assertCurrent();
  return replaced;
};

export const linkOwnedFile = (
  directory: OwnedDirectory,
  sourceName: string,
  destinationName: string,
  expectedSourceIdentity: string,
  afterClaimForTesting?: () => void,
): OwnedFileEvidence => {
  const source = statOwnedFile(directory, sourceName);
  if (source.physicalIdentity !== expectedSourceIdentity) invalid();
  linkSync(
    relativePath(directory, sourceName),
    relativePath(directory, destinationName),
  );
  fsyncSync(directory.descriptor);
  const destination = statOwnedFile(directory, destinationName);
  /* v8 ignore next -- a successful hard link necessarily shares the source
     inode; any contrary result must fail closed. */
  if (destination.physicalIdentity !== expectedSourceIdentity) invalid();
  afterClaimForTesting?.();
  if (
    statOwnedFile(directory, sourceName).physicalIdentity !==
    expectedSourceIdentity
  )
    raced();
  return destination;
};
