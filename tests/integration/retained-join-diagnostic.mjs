import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

const maximumBytes = 128;
const sameIdentity = (left, right) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.uid === right.uid &&
  left.gid === right.gid &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

export const readRetainedJoinDiagnostic = (path, afterOpenForTest) => {
  if (
    typeof path !== "string" ||
    (afterOpenForTest !== undefined && process.env.NODE_ENV !== "test")
  )
    return undefined;
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid < 0) return undefined;
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(uid) ||
      (before.mode & 0o7777n) !== 0o600n ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes)
    )
      return undefined;
    afterOpenForTest?.();
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !sameIdentity(before, after) ||
      length !== Number(after.size) ||
      bytes[length - 1] !== 0x0a
    )
      return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, length - 1),
    );
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};
