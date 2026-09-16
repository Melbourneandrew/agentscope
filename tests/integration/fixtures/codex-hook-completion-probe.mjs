#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  writeFileSync,
} from "node:fs";

const main = () => {
  if (
    process.argv.length !== 8 ||
    process.argv[2] !== "--launcher" ||
    process.argv[4] !== "--receipt" ||
    process.argv[6] !== "--nonce"
  )
    throw new Error("probe.arguments");
  const launcher = process.argv[3];
  const receipt = process.argv[5];
  const nonce = process.argv[7];
  if (
    !launcher.startsWith("/") ||
    !receipt.startsWith("/") ||
    !/^[a-f0-9]{64}$/u.test(nonce)
  )
    throw new Error("probe.arguments");
  const launcherStatus = lstatSync(launcher);
  if (
    !launcherStatus.isFile() ||
    launcherStatus.isSymbolicLink() ||
    (launcherStatus.mode & 0o111) === 0
  )
    throw new Error("probe.launcher");
  const result = spawnSync(launcher, [], {
    env: process.env,
    stdio: "inherit",
  });
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0
  )
    throw new Error("probe.child");
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
