#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const maximumLauncherBytes = 64 * 1024;
const sameIdentity = (left, right) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.uid === right.uid &&
  left.gid === right.gid &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;
const readLauncher = (descriptor) => {
  const buffer = Buffer.allocUnsafe(maximumLauncherBytes + 1);
  const length = readSync(descriptor, buffer, 0, buffer.length, 0);
  if (length < 1 || length > maximumLauncherBytes)
    throw new Error("probe.launcher");
  return buffer.subarray(0, length);
};
const validArguments = () =>
  process.argv.length === 10 &&
  process.argv[2] === "--launcher" &&
  process.argv[4] === "--receipt" &&
  process.argv[6] === "--nonce" &&
  process.argv[8] === "--launcher-sha256";
const validParent = (status) =>
  status.isDirectory() &&
  !status.isSymbolicLink() &&
  status.uid === BigInt(process.geteuid()) &&
  (status.mode & 0o022n) === 0n;
const validLauncher = (held, path, bytes, digest) =>
  held.isFile() &&
  held.nlink === 1n &&
  held.uid === BigInt(process.geteuid()) &&
  (held.mode & 0o777n) === 0o700n &&
  sameIdentity(held, path) &&
  createHash("sha256").update(bytes).digest("hex") === digest;
const validResult = ({ result, before, after, pathAfter, bytes, bytesAfter }) =>
  result.error === undefined &&
  result.signal === null &&
  result.status === 0 &&
  sameIdentity(before, after) &&
  sameIdentity(after, pathAfter) &&
  bytes.equals(bytesAfter);

const main = () => {
  if (!validArguments()) throw new Error("probe.arguments");
  const launcher = process.argv[3];
  const receipt = process.argv[5];
  const nonce = process.argv[7];
  const launcherSha256 = process.argv[9];
  if (
    !launcher.startsWith("/") ||
    !receipt.startsWith("/") ||
    !/^[a-f0-9]{64}$/u.test(nonce) ||
    !/^[a-f0-9]{64}$/u.test(launcherSha256)
  )
    throw new Error("probe.arguments");
  const parentStatus = lstatSync(dirname(launcher), { bigint: true });
  if (!validParent(parentStatus)) throw new Error("probe.launcher-parent");
  const launcherDescriptor = openSync(
    launcher,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let launcherBefore;
  try {
    launcherBefore = fstatSync(launcherDescriptor, { bigint: true });
    const pathBefore = lstatSync(launcher, { bigint: true });
    const bytesBefore = readLauncher(launcherDescriptor);
    if (!validLauncher(launcherBefore, pathBefore, bytesBefore, launcherSha256))
      throw new Error("probe.launcher");
    const result = spawnSync(launcher, [], {
      env: process.env,
      stdio: "inherit",
    });
    const launcherAfter = fstatSync(launcherDescriptor, { bigint: true });
    const pathAfter = lstatSync(launcher, { bigint: true });
    const bytesAfter = readLauncher(launcherDescriptor);
    if (
      !validResult({
        result,
        before: launcherBefore,
        after: launcherAfter,
        pathAfter,
        bytes: bytesBefore,
        bytesAfter,
      })
    )
      throw new Error("probe.child");
  } finally {
    closeSync(launcherDescriptor);
  }
  const bytes = Buffer.from(`${nonce}\n`, "utf8");
  const descriptor = openSync(
    receipt,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    const descriptorStatus = fstatSync(descriptor);
    const pathStatus = lstatSync(receipt);
    if (
      !descriptorStatus.isFile() ||
      !pathStatus.isFile() ||
      pathStatus.isSymbolicLink() ||
      descriptorStatus.dev !== pathStatus.dev ||
      descriptorStatus.ino !== pathStatus.ino ||
      descriptorStatus.size !== bytes.byteLength ||
      pathStatus.size !== bytes.byteLength ||
      (descriptorStatus.mode & 0o777) !== 0o600 ||
      (pathStatus.mode & 0o777) !== 0o600
    )
      throw new Error("probe.receipt");
  } finally {
    closeSync(descriptor);
  }
};

try {
  main();
} catch {
  process.exitCode = 1;
}
