#!/usr/bin/env node
import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { createConnection } from "node:net";

const fail = () => {
  throw new Error("integration.codex.candidate-principal");
};

if (
  process.argv.length !== 2 ||
  process.platform !== "linux" ||
  typeof process.execve !== "function" ||
  process.getuid?.() !== 0 ||
  process.geteuid?.() !== 0 ||
  process.getgid?.() !== 0 ||
  process.getegid?.() !== 0
)
  fail();

const runId = process.env.AGENTSCOPE_CANDIDATE_RUN_ID;
const controllerPid = process.ppid;
const candidateEnvironmentKeys = [
  "AGENTSCOPE_CANDIDATE_RUN_ID",
  "AGENTSCOPE_HOME",
  "CODEX_HOME",
  "HOME",
  "LANG",
  "PATH",
  "RUST_LOG",
  "TERM",
  "XDG_CONFIG_HOME",
];
if (
  !/^[a-f0-9]{16}$/u.test(runId ?? "") ||
  controllerPid < 2 ||
  Object.keys(process.env).sort().join("\0") !==
    candidateEnvironmentKeys.join("\0") ||
  candidateEnvironmentKeys.some(
    (key) => !/^[\x20-\x7e]{1,1024}$/u.test(process.env[key] ?? ""),
  )
)
  fail();

process.setgroups([]);
process.setgid(1000);
process.setuid(1000);

const status = readFileSync("/proc/self/status", "utf8");
if (status.length > 64 * 1024) fail();
const field = (name) => {
  const values = status
    .split("\n")
    .filter((line) => line.startsWith(`${name}:`));
  if (values.length !== 1) fail();
  return values[0].slice(name.length + 1).trim();
};
if (
  process.getuid() !== 1000 ||
  process.geteuid() !== 1000 ||
  process.getgid() !== 1000 ||
  process.getegid() !== 1000 ||
  process.getgroups().some((group) => group !== 1000) ||
  field("Uid") !== "1000\t1000\t1000\t1000" ||
  field("Gid") !== "1000\t1000\t1000\t1000" ||
  field("Groups") !== "" ||
  field("CapEff") !== "0000000000000000" ||
  field("CapPrm") !== "0000000000000000" ||
  field("CapInh") !== "0000000000000000" ||
  field("CapAmb") !== "0000000000000000" ||
  field("NoNewPrivs") !== "1"
)
  fail();

const denied = (action, expectedCode) => {
  try {
    action();
  } catch (error) {
    if (error?.code === expectedCode) return;
    fail();
  }
  fail();
};

// These checks execute as the actual candidate principal, in the same PID
// namespace and mount graph as the installed binary. A missing listener is
// insufficient: the protected directory itself must deny traversal.
denied(() => readdirSync("/control/private"), "EACCES");
denied(() => readdirSync(`/proc/${controllerPid}/fd`), "EACCES");
denied(() => process.kill(controllerPid, "SIGUSR2"), "EPERM");
denied(() => {
  const descriptor = openSync(
    `/control/private/checkpoint-${runId}.json`,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  closeSync(descriptor);
}, "EACCES");

await new Promise((resolve, reject) => {
  const connection = createConnection({ path: "/control/private/gate.sock" });
  const timer = setTimeout(() => {
    connection.destroy();
    reject(new Error("integration.codex.candidate-principal"));
  }, 1_000);
  connection.once("connect", () => {
    clearTimeout(timer);
    connection.destroy();
    reject(new Error("integration.codex.candidate-principal"));
  });
  connection.once("error", (error) => {
    clearTimeout(timer);
    connection.destroy();
    if (error?.code === "EACCES") resolve();
    else reject(new Error("integration.codex.candidate-principal"));
  });
});

process.execve(
  "/usr/local/bin/node",
  [
    "node",
    "/opt/agentscope/harness/node_modules/.bin/codex",
    "--no-alt-screen",
    "--enable",
    "hooks",
    "--dangerously-bypass-hook-trust",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
  ],
  {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    TERM: process.env.TERM,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    AGENTSCOPE_HOME: process.env.AGENTSCOPE_HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    RUST_LOG: process.env.RUST_LOG,
  },
);
fail();
