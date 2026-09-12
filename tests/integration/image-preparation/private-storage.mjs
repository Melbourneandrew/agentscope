/* eslint import-x/no-cycle: "off" -- private in-process controller capability */
/** Authenticated inventory and retirement of controller-owned private storage. */
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  integrationPrivateStorageAuthority,
  registerIntegrationPrivateStorageRetirement,
} from "../dist/controller.js";
import {
  diagnosticDigest,
  digestBytes,
  fixedError,
  maximumPrivateStateDepth,
  maximumPrivateStateEntries,
  maximumPrivateStateFileBytes,
  maximumPrivateStateTotalBytes,
} from "./boundary.mjs";

export const createPrivateClientRoot = (options) => {
  const testing =
    options.socketIdentityForTesting !== undefined ||
    options.engineRequestForTesting !== undefined ||
    options.registryRequestForTesting !== undefined;
  const authority = testing ? undefined : integrationPrivateStorageAuthority();
  const parent =
    authority === undefined ? realpathSync("/tmp") : authority.root;
  const parentStatus = lstatSync(parent);
  const outerParentStatus =
    authority === undefined ? undefined : lstatSync(authority.parent);
  if (
    authority !== undefined &&
    (!/^sha256:[a-f\d]{64}$/u.test(authority.authorityDigest ?? "") ||
      authority.parent !== realpathSync("/tmp") ||
      !outerParentStatus.isDirectory() ||
      outerParentStatus.isSymbolicLink() ||
      outerParentStatus.dev !== authority.parentDev ||
      outerParentStatus.ino !== authority.parentIno ||
      outerParentStatus.uid !== authority.parentUid ||
      outerParentStatus.gid !== authority.parentGid ||
      (outerParentStatus.mode & 0o7777) !== authority.parentMode ||
      authority.root !== realpathSync(authority.root) ||
      parentStatus.dev !== authority.rootDev ||
      parentStatus.ino !== authority.rootIno ||
      parentStatus.uid !== authority.rootUid ||
      parentStatus.gid !== authority.rootGid ||
      (parentStatus.mode & 0o7777) !== authority.rootMode ||
      authority.rootMode !== 0o700)
  )
    throw fixedError("integration.images.private-storage");
  const root = mkdtempSync(
    resolve(
      parent,
      authority === undefined
        ? "agentscope-image-preparation-"
        : "docker-client-",
    ),
  );
  const owned = {
    root,
    parent,
    parentIdentity: Object.freeze({
      dev: parentStatus.dev,
      ino: parentStatus.ino,
      mode: parentStatus.mode & 0o7777,
      uid: parentStatus.uid,
      gid: parentStatus.gid,
    }),
    rootIdentity: undefined,
    directories: [],
    files: [],
    retired: false,
    beforeRemovalForTesting: options.beforePrivateRemovalForTesting,
    authorityDigest: authority?.authorityDigest,
  };
  try {
    chmodSync(root, 0o700);
    const rootStatus = lstatSync(root);
    owned.rootIdentity = Object.freeze({
      dev: rootStatus.dev,
      ino: rootStatus.ino,
      mode: rootStatus.mode & 0o7777,
      uid: rootStatus.uid,
      gid: rootStatus.gid,
    });
    options.afterPrivateRootCreatedForTesting?.(root);
    for (const name of [
      "buildx",
      "docker",
      "home",
      "tmp",
      "xdg",
      "npm-cache",
    ]) {
      const path = resolve(root, name);
      mkdirSync(path, { mode: 0o700 });
      owned.directories.push(path);
    }
    for (const [name, content] of [
      ["docker/config.json", '{"auths":{}}\n'],
      ["gitconfig", ""],
      ["npmrc", ""],
    ]) {
      const path = resolve(root, name);
      writeFileSync(path, content, { flag: "wx", mode: 0o600 });
      owned.files.push(path);
    }
    return owned;
  } catch (error) {
    cleanupPrivateClient(owned, Number.POSITIVE_INFINITY);
    throw error;
  }
};
/* eslint-disable complexity, max-depth, max-lines-per-function -- one bounded no-follow inventory and identity-checked retirement state machine */
export const cleanupPrivateClient = (owned, deadline) => {
  const summary = {
    entryCount: 0,
    directoryCount: 0,
    regularFileCount: 0,
    totalBytes: 0,
    entrySetDigest: diagnosticDigest([]),
  };
  const cleanupFailure = (reason) => {
    const error = fixedError("integration.images.cleanup");
    error.privateCleanupDiagnostic = Object.freeze({
      diagnosticVersion: 1,
      stage: "private-client-cleanup",
      outcome: "retired-failure",
      reason,
      ...summary,
    });
    return error;
  };
  const withinDeadline = () => {
    if (performance.now() > deadline) throw cleanupFailure("deadline");
  };
  const mode = (status) => status.mode & 0o7777;
  const sameDirectoryIdentity = (status, identity) =>
    status.isDirectory() &&
    !status.isSymbolicLink() &&
    status.dev === identity.dev &&
    status.ino === identity.ino &&
    status.uid === identity.uid &&
    status.gid === identity.gid &&
    mode(status) === identity.mode;
  const assertBoundary = () => {
    withinDeadline();
    let parentStatus;
    let rootStatus;
    try {
      parentStatus = lstatSync(owned.parent);
      rootStatus = lstatSync(owned.root);
    } catch {
      throw cleanupFailure("identity-substitution");
    }
    if (
      !sameDirectoryIdentity(parentStatus, owned.parentIdentity) ||
      !sameDirectoryIdentity(rootStatus, owned.rootIdentity)
    )
      throw cleanupFailure("identity-substitution");
  };
  const snapshotFile = (path, expected) => {
    let descriptor;
    try {
      descriptor = openSync(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const before = fstatSync(descriptor);
      if (
        !before.isFile() ||
        before.dev !== expected.dev ||
        before.ino !== expected.ino ||
        before.uid !== expected.uid ||
        before.gid !== expected.gid ||
        before.nlink !== 1 ||
        before.size !== expected.size ||
        mode(before) !== expected.mode ||
        ![0o600, 0o644].includes(expected.mode)
      )
        throw cleanupFailure("entry-substitution");
      const content = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.nlink !== before.nlink ||
        mode(after) !== mode(before) ||
        digestBytes(content) !== expected.digest
      )
        throw cleanupFailure("entry-substitution");
    } catch (error) {
      if (error?.message === "integration.images.cleanup") throw error;
      throw cleanupFailure("entry-substitution");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };
  try {
    if (owned.retired) throw cleanupFailure("identity-substitution");
    assertBoundary();
    const pending = [
      {
        path: owned.root,
        relative: "",
        depth: 0,
        identity: owned.rootIdentity,
      },
    ];
    const directories = [];
    const directoryInventories = [];
    const files = [];
    const diagnosticEntries = [];
    while (pending.length > 0) {
      withinDeadline();
      const current = pending.pop();
      let entries;
      try {
        if (!sameDirectoryIdentity(lstatSync(current.path), current.identity))
          throw cleanupFailure("entry-substitution");
        entries = readdirSync(current.path, { withFileTypes: true });
        if (!sameDirectoryIdentity(lstatSync(current.path), current.identity))
          throw cleanupFailure("entry-substitution");
      } catch {
        throw cleanupFailure("entry-inaccessible");
      }
      directoryInventories.push({
        ...current.identity,
        path: current.path,
        childDigest: diagnosticDigest(entries.map(({ name }) => name).sort()),
      });
      for (const entry of entries) {
        summary.entryCount += 1;
        if (summary.entryCount > maximumPrivateStateEntries)
          throw cleanupFailure("entry-overflow");
        const relative = current.relative
          ? `${current.relative}/${entry.name}`
          : entry.name;
        const depth = current.depth + 1;
        if (depth > maximumPrivateStateDepth)
          throw cleanupFailure("depth-overflow");
        const path = resolve(current.path, entry.name);
        if (!path.startsWith(`${owned.root}/`) || entry.isSymbolicLink())
          throw cleanupFailure("entry-type");
        const status = lstatSync(path);
        if (entry.isDirectory() && status.isDirectory()) {
          if (
            status.uid !== owned.rootIdentity.uid ||
            status.gid !== owned.rootIdentity.gid ||
            mode(status) !== 0o700
          )
            throw cleanupFailure("entry-authority");
          const identity = Object.freeze({
            path,
            relative,
            depth,
            dev: status.dev,
            ino: status.ino,
            uid: status.uid,
            gid: status.gid,
            mode: mode(status),
          });
          directories.push(identity);
          pending.push({ path, relative, depth, identity });
          summary.directoryCount += 1;
          diagnosticEntries.push({
            nameDigest: digestBytes(Buffer.from(relative, "utf8")),
            type: "directory",
            size: 0,
          });
          continue;
        }
        if (!entry.isFile() || !status.isFile())
          throw cleanupFailure("entry-type");
        if (
          status.uid !== owned.rootIdentity.uid ||
          status.gid !== owned.rootIdentity.gid ||
          status.nlink !== 1 ||
          ![0o600, 0o644].includes(mode(status))
        )
          throw cleanupFailure("entry-authority");
        if (status.size > maximumPrivateStateFileBytes)
          throw cleanupFailure("file-overflow");
        summary.totalBytes += status.size;
        if (
          !Number.isSafeInteger(summary.totalBytes) ||
          summary.totalBytes > maximumPrivateStateTotalBytes
        )
          throw cleanupFailure("total-overflow");
        const descriptor = openSync(
          path,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        let content;
        try {
          const before = fstatSync(descriptor);
          content = readFileSync(descriptor);
          const after = fstatSync(descriptor);
          if (
            before.dev !== status.dev ||
            before.ino !== status.ino ||
            before.size !== status.size ||
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            after.size !== before.size ||
            after.nlink !== 1 ||
            mode(after) !== mode(before)
          )
            throw cleanupFailure("entry-substitution");
        } finally {
          closeSync(descriptor);
        }
        const identity = Object.freeze({
          path,
          relative,
          depth,
          dev: status.dev,
          ino: status.ino,
          uid: status.uid,
          gid: status.gid,
          mode: mode(status),
          size: status.size,
          digest: digestBytes(content),
        });
        files.push(identity);
        summary.regularFileCount += 1;
        diagnosticEntries.push({
          nameDigest: digestBytes(Buffer.from(relative, "utf8")),
          type: "regular-file",
          size: status.size,
        });
      }
    }
    summary.entrySetDigest = diagnosticDigest(
      diagnosticEntries.sort((left, right) =>
        left.nameDigest.localeCompare(right.nameDigest),
      ),
    );
    owned.beforeRemovalForTesting?.(owned.root);
    // The selected outer host is the destruction boundary. Once every trusted
    // client/helper has joined, this pass authenticates the closed retained
    // inventory and revokes its in-process capability. It deliberately performs
    // no pathname deletion: any unproved writer or identity drift leaves the
    // bytes for irreversible runner/guest retirement.
    for (const inventory of directoryInventories) {
      assertBoundary();
      if (!sameDirectoryIdentity(lstatSync(inventory.path), inventory))
        throw cleanupFailure("entry-substitution");
      const childDigest = diagnosticDigest(readdirSync(inventory.path).sort());
      if (childDigest !== inventory.childDigest)
        throw cleanupFailure("late-mutation");
    }
    for (const file of files) {
      assertBoundary();
      for (const directory of directories) {
        if (file.path.startsWith(`${directory.path}/`)) {
          if (!sameDirectoryIdentity(lstatSync(directory.path), directory))
            throw cleanupFailure("entry-substitution");
        }
      }
      snapshotFile(file.path, file);
    }
    assertBoundary();
    owned.retired = true;
    const retirement = Object.freeze({
      authorityDigest: owned.authorityDigest,
      dev: owned.rootIdentity.dev,
      entryCount: summary.entryCount,
      entrySetDigest: summary.entrySetDigest,
      ino: owned.rootIdentity.ino,
      path: owned.root,
      totalBytes: summary.totalBytes,
    });
    if (owned.authorityDigest !== undefined)
      registerIntegrationPrivateStorageRetirement(retirement);
    return retirement;
  } catch (error) {
    if (error?.message === "integration.images.cleanup") throw error;
    throw cleanupFailure("operation-failed");
  }
};
/* eslint-enable complexity, max-depth, max-lines-per-function */
