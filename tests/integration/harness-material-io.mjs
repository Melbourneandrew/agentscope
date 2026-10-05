/** Shared private material I/O; never execution or prepared-image authority. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";

const fail = () => {
  throw new Error("integration.harness-material.failed");
};

export const exactDirectory = (path) => {
  const status = lstatSync(path);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (status.mode & 0o7777) !== 0o700 ||
    status.uid !== process.getuid?.() ||
    status.gid !== process.getgid?.()
  )
    fail();
  return Object.freeze({ dev: status.dev, ino: status.ino, path });
};
export const sameDirectory = (identity) => {
  const current = exactDirectory(identity.path);
  if (current.dev !== identity.dev || current.ino !== identity.ino) fail();
};

export const readMaterialSource = (path) => {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > 1_048_576) fail();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const length = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (length < 1) fail();
      offset += length;
    }
    // At most one extra byte is inspected solely to reject overlong input.
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) fail();
    const after = fstatSync(fd);
    if (
      bytes.length !== before.size ||
      [
        "dev",
        "ino",
        "size",
        "mode",
        "uid",
        "gid",
        "nlink",
        "mtimeMs",
        "ctimeMs",
      ].some((field) => before[field] !== after[field])
    )
      fail();
    return Object.freeze({
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } finally {
    closeSync(fd);
  }
};

export const writeExclusive = (path, bytes) => {
  const fd = openSync(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  const status = lstatSync(path);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    status.size !== bytes.byteLength ||
    (status.mode & 0o7777) !== 0o600
  )
    fail();
};
