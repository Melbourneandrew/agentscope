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
const fail = () => {
  throw new Error("integration.mockserver-material.supplier-inventory");
};
const same = (before, after) =>
  fields.every((key) => before[key] === after[key]);
const regular = (status) =>
  status.isFile() &&
  status.nlink === 1 &&
  status.uid === process.getuid?.() &&
  [0o600, 0o644].includes(status.mode & 0o7777) &&
  Number.isSafeInteger(status.size) &&
  status.size >= 0 &&
  status.size <= maximumFileBytes;
const directory = (path, archivedSource = false) => {
  const status = lstatSync(path);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.uid !== process.getuid?.() ||
    !(archivedSource
      ? (status.mode & 0o7777) === 0o775
      : [0o700, 0o755].includes(status.mode & 0o7777))
  )
    fail();
  return status;
};
const boundedNames = (path, remaining) => {
  const handle = opendirSync(path, { bufferSize: 1 });
  const names = [];
  try {
    for (
      let entry = handle.readSync();
      entry !== null;
      entry = handle.readSync()
    ) {
      if (names.length >= remaining) fail();
      names.push(entry.name);
    }
  } finally {
    handle.closeSync();
  }
  return names.sort();
};
const observeFile = (path, state) => {
  const named = lstatSync(path);
  if (!regular(named) || state.bytes + named.size > maximumAggregateBytes)
    fail();
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd);
    if (!regular(before) || !same(named, before)) fail();
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const length = readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.length, before.size - position),
        position,
      );
      if (length < 1) fail();
      hash.update(chunk.subarray(0, length));
      position += length;
    }
    if (
      readSync(fd, chunk, 0, 1, position) !== 0 ||
      !same(before, fstatSync(fd)) ||
      !same(before, lstatSync(path))
    )
      fail();
    state.bytes += before.size;
    return {
      bytes: before.size,
      mode: before.mode & 0o7777,
      sha256: hash.digest("hex"),
    };
  } finally {
    closeSync(fd);
  }
};

/** Run only after the supplier exits, inside its inherited builder lifecycle. */
export const inventoryMockServerSupplier = (root) => {
  if (typeof root !== "string" || resolve(root) !== root) fail();
  const initial = directory(root);
  const rows = [];
  const state = { bytes: 0, entries: 0 };
  let encodedBytes = 512;
  const append = (row) => {
    encodedBytes += Buffer.byteLength(JSON.stringify(row)) + 1;
    if (encodedBytes > maximumOutputBytes) fail();
    rows.push(row);
  };
  const walk = (relative, depth) => {
    if (depth > 32 || relative.length > 512 || ++state.entries > maximumEntries)
      fail();
    const path = resolve(root, relative);
    const status = lstatSync(path);
    if (status.isDirectory()) {
      const before = directory(path);
      const names = boundedNames(path, maximumEntries - state.entries);
      append({ path: relative, type: "directory", mode: status.mode & 0o7777 });
      for (const name of names) {
        if (
          !/^[A-Za-z\d@+._=-]{1,255}$/u.test(name) ||
          name === "." ||
          name === ".."
        )
          fail();
        walk(`${relative}/${name}`, depth + 1);
      }
      if (!same(before, directory(path))) fail();
    } else {
      append({ path: relative, type: "file", ...observeFile(path, state) });
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
    );
  const jar = {
    path: artifact,
    type: "file",
    ...observeFile(resolve(root, artifact), state),
  };
  if (jar.bytes === 0 || !same(initial, directory(root))) fail();
  const result = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      evidenceScope: "untrusted-cache-and-jar-research-only",
      consumedDependencyClosure: "not-proved",
      caches: rows,
      artifact: jar,
    })}\n`,
  );
  if (result.length > maximumOutputBytes) fail();
  return result;
};
