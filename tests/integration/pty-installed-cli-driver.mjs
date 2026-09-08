import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";

const installedCli =
  "/opt/agentscope/installed/node_modules/agentscope-cli/dist/bin/agentscope.js";
const fail = () => {
  throw new Error("integration.pty-installed-cli-driver");
};
if (
  process.argv.length !== 4 ||
  process.argv[2] !== installedCli ||
  !/^[a-f0-9]{64}$/u.test(process.argv[3] ?? "")
)
  fail();
const descriptor = openSync(
  installedCli,
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
);
try {
  const before = fstatSync(descriptor);
  if (!before.isFile() || before.size < 1 || before.size > 16 * 1024 * 1024)
    fail();
  const bytes = readFileSync(`/proc/self/fd/${descriptor}`);
  const after = fstatSync(descriptor);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    createHash("sha256").update(bytes).digest("hex") !== process.argv[3]
  )
    fail();
  process.argv = [process.execPath, installedCli, "--version"];
  await import("/opt/agentscope/installed/node_modules/agentscope-cli/dist/bin/agentscope.js");
  if (process.exitCode !== 0) fail();
  process.stdout.write("AGENTSCOPE_PTY_COMPLETE\n");
} finally {
  closeSync(descriptor);
}
