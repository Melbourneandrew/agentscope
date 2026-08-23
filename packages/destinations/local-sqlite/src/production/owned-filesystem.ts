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

const privateClaimName = (): string =>
  `.agentscope-private-${randomBytes(16).toString("hex")}`;

export const createPathAtomicExchangeForTesting =
  (directoryPath: string): OwnedAtomicExchange =>
  (_descriptor, { sourceName, destinationName }) => {
    const temporaryName = privateClaimName();
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

const removePrivateClaim = (
  directory: OwnedDirectory,
  name: string,
  expectedPhysicalIdentity: string,
): void => {
  const evidence = statOwnedFile(directory, name);
  /* v8 ignore next -- stat and unlink are adjacent under retained directory
     authority; a kernel-level inode change here is treated as a race. */
  if (evidence.physicalIdentity !== expectedPhysicalIdentity) raced();
  unlinkSync(relativePath(directory, name));
  fsyncSync(directory.descriptor);
};

const restoreQuarantinedName = (
  directory: OwnedDirectory,
  quarantineName: string,
  publicName: string,
  physicalIdentity: string,
): void => {
  try {
    linkSync(
      relativePath(directory, quarantineName),
      relativePath(directory, publicName),
    );
    removePrivateClaim(directory, quarantineName, physicalIdentity);
  } catch {
    // Preserve both names for bounded reconciliation rather than overwrite one.
  }
};

const quarantineOwnedName = (
  directory: OwnedDirectory,
  name: string,
  expectedPhysicalIdentity: string,
  afterQuarantineForTesting?: () => void,
): Readonly<{ claimName: string; evidence: OwnedFileEvidence }> | undefined => {
  const claimName = privateClaimName();
  renameSync(relativePath(directory, name), relativePath(directory, claimName));
  fsyncSync(directory.descriptor);
  afterQuarantineForTesting?.();
  const evidence = statOwnedFile(directory, claimName);
  /* v8 ignore start -- a successful hard link necessarily shares the retained
     source inode; contrary kernel evidence is fail-closed. */
  if (evidence.physicalIdentity !== expectedPhysicalIdentity) {
    restoreQuarantinedName(
      directory,
      claimName,
      name,
      evidence.physicalIdentity,
    );
    return undefined;
  }
  directory.assertCurrent();
  return Object.freeze({ claimName, evidence });
};

const linkOwnedClaim = (
  directory: OwnedDirectory,
  sourceName: string,
  expectedPhysicalIdentity: string,
  afterClaimForTesting?: () => void,
): string => {
  const claimName = privateClaimName();
  linkSync(
    relativePath(directory, sourceName),
    relativePath(directory, claimName),
  );
  const evidence = statOwnedFile(directory, claimName);
  if (evidence.physicalIdentity !== expectedPhysicalIdentity) {
    removePrivateClaim(directory, claimName, evidence.physicalIdentity);
    raced();
  }
  /* v8 ignore stop */
  fsyncSync(directory.descriptor);
  afterClaimForTesting?.();
  return claimName;
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
  try {
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
    try {
      unlinkSync(path);
    } catch {
      /* v8 ignore next -- cleanup failure preserves the original fixed
         acquisition error and leaves bounded reconciliation evidence. */
      // Preserve the original fixed acquisition failure.
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
    const quarantined = quarantineOwnedName(
      directory,
      name,
      evidence.physicalIdentity,
      afterQuarantineForTesting,
    );
    if (quarantined === undefined) return "mismatch";
    removePrivateClaim(
      directory,
      quarantined.claimName,
      evidence.physicalIdentity,
    );
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
  try {
    statOwnedFile(destinationDirectory, destinationName);
    invalid();
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  const quarantined = quarantineOwnedName(
    sourceDirectory,
    sourceName,
    expectedSourceIdentity,
    afterQuarantineForTesting,
  );
  if (quarantined === undefined) return raced();
  try {
    linkSync(
      relativePath(sourceDirectory, quarantined.claimName),
      relativePath(destinationDirectory, destinationName),
    );
  } catch (error) {
    restoreQuarantinedName(
      sourceDirectory,
      quarantined.claimName,
      sourceName,
      expectedSourceIdentity,
    );
    throw error;
  }
  fsyncSync(sourceDirectory.descriptor);
  if (sourceDirectory.descriptor !== destinationDirectory.descriptor)
    fsyncSync(destinationDirectory.descriptor);
  const destination = statOwnedFile(destinationDirectory, destinationName);
  /* v8 ignore next -- successful rename preserves the source inode; any
     contrary kernel/filesystem result must fail closed. */
  if (destination.physicalIdentity !== expectedSourceIdentity) invalid();
  removePrivateClaim(
    sourceDirectory,
    quarantined.claimName,
    expectedSourceIdentity,
  );
  try {
    statOwnedFile(sourceDirectory, sourceName);
    raced();
  } catch (error) {
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
  const claimName = linkOwnedClaim(
    directory,
    sourceName,
    expectedSourceIdentity,
    afterClaimForTesting,
  );
  try {
    linkSync(
      relativePath(directory, claimName),
      relativePath(directory, destinationName),
    );
  } finally {
    removePrivateClaim(directory, claimName, expectedSourceIdentity);
  }
  fsyncSync(directory.descriptor);
  const destination = statOwnedFile(directory, destinationName);
  /* v8 ignore next -- a successful hard link necessarily shares the source
     inode; any contrary result must fail closed. */
  if (destination.physicalIdentity !== expectedSourceIdentity) invalid();
  if (
    statOwnedFile(directory, sourceName).physicalIdentity !==
    expectedSourceIdentity
  )
    raced();
  return destination;
};
