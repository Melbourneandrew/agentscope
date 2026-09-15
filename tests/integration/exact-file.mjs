import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  writeFileSync,
} from "node:fs";

export const writeExactRegularFile = (path, bytes, mode) => {
  if (
    typeof path !== "string" ||
    !Buffer.isBuffer(bytes) ||
    ![0o600, 0o644].includes(mode)
  )
    throw new Error("integration.isolation.context");
  const descriptor = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
    const descriptorStatus = fstatSync(descriptor);
    const pathStatus = lstatSync(path);
    if (
      !descriptorStatus.isFile() ||
      !pathStatus.isFile() ||
      pathStatus.isSymbolicLink() ||
      descriptorStatus.dev !== pathStatus.dev ||
      descriptorStatus.ino !== pathStatus.ino ||
      descriptorStatus.size !== bytes.byteLength ||
      pathStatus.size !== bytes.byteLength ||
      (descriptorStatus.mode & 0o777) !== mode ||
      (pathStatus.mode & 0o777) !== mode
    )
      throw new Error("integration.isolation.context");
  } finally {
    closeSync(descriptor);
  }
};
