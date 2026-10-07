/** Cache/JAR observations only; never authenticated dependency closure. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
} from "node:fs";
import { resolve } from "node:path";

const maximumEntries = 16_384;
const maximumFileBytes = 256 * 1024 * 1024;
const maximumAggregateBytes = 1024 * 1024 * 1024;
const maximumOutputBytes = 8 * 1024 * 1024;
const fields = [
  "dev",
  "ino",
  "mode",
  "uid",
  "gid",
  "nlink",
  "size",
  "mtimeMs",
  "ctimeMs",
];
const fail = (observe) => {
  const error = new Error("integration.mockserver-material.supplier-inventory");
  observe("inventory-guard");
  throw error;
};
const same = (before, after) =>
  fields.every((key) => before[key] === after[key]);
const read = (observe, operation) => {
  try {
    return operation();
  } catch (error) {
    observe("inventory-read");
    throw error;
  }
};
const regular = (status) =>
  status.isFile() &&
  status.nlink === 1 &&
  status.uid === process.getuid?.() &&
  [0o600, 0o644].includes(status.mode & 0o7777) &&
  Number.isSafeInteger(status.size) &&
  status.size >= 0 &&
  status.size <= maximumFileBytes;
const directory = (path, archivedSource, observe) => {
  const status = read(observe, () => lstatSync(path));
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.uid !== process.getuid?.() ||
    !(archivedSource
      ? (status.mode & 0o7777) === 0o775
      : [0o700, 0o755].includes(status.mode & 0o7777))
  )
    fail(observe);
  return status;
};
const boundedNames = (path, remaining, observe) => {
  const handle = read(observe, () => opendirSync(path, { bufferSize: 1 }));
  const names = [];
  try {
    for (
      let entry = read(observe, () => handle.readSync());
      entry !== null;
      entry = read(observe, () => handle.readSync())
    ) {
      if (names.length >= remaining) fail(observe);
      names.push(entry.name);
    }
  } finally {
    read(observe, () => handle.closeSync());
  }
  return names.sort();
};
const observeFile = (path, state, observe) => {
  const named = read(observe, () => lstatSync(path));
  if (!regular(named) || state.bytes + named.size > maximumAggregateBytes)
    fail(observe);
  const fd = read(observe, () =>
    openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ),
  );
  try {
    const before = read(observe, () => fstatSync(fd));
    if (!regular(before) || !same(named, before)) fail(observe);
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const length = read(observe, () =>
        readSync(
          fd,
          chunk,
          0,
          Math.min(chunk.length, before.size - position),
          position,
        ),
      );
      if (length < 1) fail(observe);
      hash.update(chunk.subarray(0, length));
      position += length;
    }
    if (
      read(observe, () => readSync(fd, chunk, 0, 1, position)) !== 0 ||
      !same(
        before,
        read(observe, () => fstatSync(fd)),
      ) ||
      !same(
        before,
        read(observe, () => lstatSync(path)),
      )
    )
      fail(observe);
    state.bytes += before.size;
    return {
      bytes: before.size,
      mode: before.mode & 0o7777,
      sha256: hash.digest("hex"),
    };
  } finally {
    read(observe, () => closeSync(fd));
  }
};

/** Run only after the supplier exits, inside its inherited builder lifecycle. */
const inventory = (root, observe) => {
  if (typeof root !== "string" || resolve(root) !== root) fail(observe);
  const initial = directory(root, false, observe);
  const rows = [];
  const state = { bytes: 0, entries: 0 };
  let encodedBytes = 512;
  const append = (row) => {
    encodedBytes += Buffer.byteLength(JSON.stringify(row)) + 1;
    if (encodedBytes > maximumOutputBytes) fail(observe);
    rows.push(row);
  };
  const walk = (relative, depth) => {
    if (depth > 32 || relative.length > 512 || ++state.entries > maximumEntries)
      fail(observe);
    const path = resolve(root, relative);
    const status = read(observe, () => lstatSync(path));
    if (status.isDirectory()) {
      const before = directory(path, false, observe);
      const names = boundedNames(path, maximumEntries - state.entries, observe);
      append({ path: relative, type: "directory", mode: status.mode & 0o7777 });
      for (const name of names) {
        if (
          !/^[A-Za-z\d@+._=-]{1,255}$/u.test(name) ||
          name === "." ||
          name === ".."
        )
          fail(observe);
        walk(`${relative}/${name}`, depth + 1);
      }
      if (!same(before, directory(path, false, observe))) fail(observe);
    } else {
      append({
        path: relative,
        type: "file",
        ...observeFile(path, state, observe),
      });
    }
  };
  for (const cache of ["maven-repository", "npm-cache"]) walk(cache, 0);
  const artifact =
    "source/mockserver/mockserver-netty/target/mockserver-netty-7.6.0-jar-with-dependencies.jar";
  // Check every ancestor; O_NOFOLLOW alone would not protect intermediate links.
  const parts = artifact.split("/");
  for (let index = 1; index < parts.length; index += 1)
    directory(
      resolve(root, ...parts.slice(0, index)),
      // Only these two fixed source ancestors inherit the pinned TAR's mode.
      index === 2 || index === 3,
      observe,
    );
  const jar = {
    path: artifact,
    type: "file",
    ...observeFile(resolve(root, artifact), state, observe),
  };
  if (jar.bytes === 0 || !same(initial, directory(root, false, observe)))
    fail(observe);
  const result = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      evidenceScope: "untrusted-cache-and-jar-research-only",
      consumedDependencyClosure: "not-proved",
      caches: rows,
      artifact: jar,
    })}\n`,
  );
  if (result.length > maximumOutputBytes) fail(observe);
  return result;
};

/**
 * Optional first-failure observation; never changes the original refusal.
 * @param {string} root
 * @param {((category: string) => void) | undefined} [observer]
 */
export const inventoryMockServerSupplier = (root, observer) => {
  let observed = false;
  const observe = (category) => {
    if (observed) return;
    observed = true;
    try {
      observer?.(category);
    } catch {
      // A diagnostic sink cannot replace the original operation failure.
    }
  };
  return inventory(root, observe);
};
