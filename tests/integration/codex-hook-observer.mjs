#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fail = () => {
  throw new Error("integration.codex.hook-observer");
};
const exactArguments = () => {
  if (
    process.argv.length !== 8 ||
    process.argv[2] !== "--event" ||
    process.argv[4] !== "--launcher" ||
    process.argv[6] !== "--ledger"
  )
    return fail();
  const event = process.argv[3];
  const launcher = process.argv[5];
  const ledger = process.argv[7];
  if (
    !["SessionStart", "Stop", "SessionEnd"].includes(event) ||
    !launcher.startsWith("/") ||
    launcher.length > 512 ||
    !ledger.startsWith("/") ||
    ledger.length > 512
  )
    return fail();
  return { event, launcher, ledger };
};
const arguments_ = exactArguments();
const maximumBytes = 65_536;
const launcherBefore = lstatSync(arguments_.launcher);
const launcherBytes = readFileSync(arguments_.launcher);
if (
  !launcherBefore.isFile() ||
  launcherBefore.isSymbolicLink() ||
  launcherBytes.length < 1 ||
  launcherBytes.length > 1024 * 1024
)
  fail();
const chunks = [];
let inputBytes = 0;
for await (const chunk of process.stdin) {
  inputBytes += chunk.length;
  if (inputBytes > maximumBytes) fail();
  chunks.push(chunk);
}
const input = Buffer.concat(chunks, inputBytes);
let hook;
try {
  hook = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input));
} catch {
  fail();
}
if (
  typeof hook !== "object" ||
  hook === null ||
  Array.isArray(hook) ||
  hook.hook_event_name !== arguments_.event ||
  typeof hook.session_id !== "string" ||
  hook.session_id.length < 1 ||
  hook.session_id.length > 256 ||
  (arguments_.event === "Stop" &&
    (typeof hook.turn_id !== "string" ||
      hook.turn_id.length < 1 ||
      hook.turn_id.length > 256))
)
  fail();

mkdirSync(arguments_.ledger, { recursive: true, mode: 0o700 });
const readPrior = (event) => {
  try {
    const value = JSON.parse(
      readFileSync(join(arguments_.ledger, `${event}.json`), "utf8"),
    );
    if (value?.event !== event || value?.sessionId !== hook.session_id) fail();
    return value;
  } catch {
    return fail();
  }
};
if (arguments_.event === "SessionStart") {
  for (const event of ["SessionStart", "Stop", "SessionEnd"])
    try {
      readFileSync(join(arguments_.ledger, `${event}.json`));
      fail();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
} else if (arguments_.event === "Stop") {
  readPrior("SessionStart");
} else {
  readPrior("SessionStart");
  readPrior("Stop");
}

const result = await new Promise((resolve, reject) => {
  const child = spawn(arguments_.launcher, [], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const capture = (target, kind) => (chunk) => {
    if (kind === "stdout") stdoutBytes += chunk.length;
    else stderrBytes += chunk.length;
    if (stdoutBytes > maximumBytes || stderrBytes > maximumBytes) child.kill();
    target.push(chunk);
  };
  child.stdout.on("data", capture(stdout, "stdout"));
  child.stderr.on("data", capture(stderr, "stderr"));
  child.once("error", reject);
  child.once("close", (code, signal) =>
    resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout, stdoutBytes),
      stderr: Buffer.concat(stderr, stderrBytes),
    }),
  );
  child.stdin.end(input);
});
if (
  result.code !== 0 ||
  result.signal !== null ||
  result.stdout.length !== 0 ||
  result.stderr.length !== 0
)
  fail();
const launcherAfter = lstatSync(arguments_.launcher);
if (
  !launcherAfter.isFile() ||
  launcherAfter.isSymbolicLink() ||
  launcherAfter.dev !== launcherBefore.dev ||
  launcherAfter.ino !== launcherBefore.ino ||
  launcherAfter.size !== launcherBefore.size ||
  launcherAfter.mode !== launcherBefore.mode ||
  launcherAfter.uid !== launcherBefore.uid ||
  launcherAfter.gid !== launcherBefore.gid
)
  fail();
const digest = (value) => createHash("sha256").update(value).digest("hex");
writeFileSync(
  join(arguments_.ledger, `${arguments_.event}.json`),
  `${JSON.stringify({
    recordVersion: 1,
    event: arguments_.event,
    sessionId: hook.session_id,
    turnId: arguments_.event === "Stop" ? hook.turn_id : null,
    model:
      typeof hook.model === "string" && hook.model.length <= 256
        ? hook.model
        : null,
    inputBytes: input.length,
    inputSha256: digest(input),
    launcherPathSha256: digest(arguments_.launcher),
    launcherSha256: digest(launcherBytes),
    launcherMode: launcherBefore.mode & 0o7777,
    launcherUid: launcherBefore.uid,
    launcherGid: launcherBefore.gid,
    launcherExitCode: result.code,
    launcherStdoutBytes: result.stdout.length,
    launcherStderrBytes: result.stderr.length,
  })}\n`,
  { flag: "wx", mode: 0o600 },
);
