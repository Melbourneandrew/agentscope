import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
} from "node:fs";

const installedBin = "/opt/agentscope/installed/bin/agentscope";
const installedCli =
  "/opt/agentscope/installed/node_modules/agentscope-cli/dist/bin/agentscope.js";
const fail = () => {
  throw new Error("integration.pty-installed-cli-driver");
};
if (
  process.argv.length !== 4 ||
  process.argv[2] !== installedBin ||
  !/^[a-f0-9]{64}$/u.test(process.argv[3] ?? "")
)
  fail();
const binStatus = lstatSync(installedBin);
if (
  !binStatus.isSymbolicLink() ||
  readlinkSync(installedBin) !==
    "../node_modules/agentscope-cli/dist/bin/agentscope.js"
)
  fail();
const descriptor = openSync(
  installedCli,
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
);
try {
  const before = fstatSync(descriptor);
  if (
    !before.isFile() ||
    (before.mode & 0o777) !== 0o755 ||
    before.size < 1 ||
    before.size > 16 * 1024 * 1024
  )
    fail();
  const bytes = readFileSync(`/proc/self/fd/${descriptor}`);
  const after = fstatSync(descriptor);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    !bytes.subarray(0, 20).toString("utf8").startsWith("#!/usr/bin/env node") ||
    createHash("sha256").update(bytes).digest("hex") !== process.argv[3]
  )
    fail();
  process.argv = [process.execPath, installedBin, "--version"];
  await import("/opt/agentscope/installed/node_modules/agentscope-cli/dist/bin/agentscope.js");
  if (process.exitCode !== 0) fail();
  process.stdout.write("AGENTSCOPE_PTY_COMPLETE\n");
} finally {
  closeSync(descriptor);
}
