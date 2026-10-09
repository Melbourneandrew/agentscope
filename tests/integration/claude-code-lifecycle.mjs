import { execFile } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { promisify } from "node:util";
import { parseCodexMachineOutput } from "./immutable-candidate-authority.mjs";

const execute = promisify(execFile);
const cli = "/opt/agentscope/installed/node_modules/.bin/agentscope";
const claudeMachine = async (arguments_, deadline, command) =>
  parseCodexMachineOutput(
    Buffer.from(await runClaudeCodeLifecycleCommand(arguments_, deadline)),
    command,
  );

export const prepareClaudeCodePackedCli = async (deadline) => {
  const commands = claudeCodeLifecycleCommands({
    endpoint: "https://collector:4318",
  });
  for (const arguments_ of commands.slice(0, 4))
    await runClaudeCodeLifecycleCommand(arguments_, deadline);
  const installed = await claudeMachine(
    commands[4],
    deadline,
    "agentscope harness status",
  );
  if (
    installed.length !== 1 ||
    installed[0]?.installation !== "installed" ||
    installed[0].discovery?.version !== "2.1.245" ||
    installed[0].discovery.harness !== "claude-code"
  )
    throw new Error("integration.claude-code.install");
  const settings = readClaudeCodeInstalledSettings();
  return Object.freeze({ commands, settings });
};
export const retireClaudeCodePackedCli = async (
  commands,
  settings,
  deadline,
) => {
  if (!readClaudeCodeInstalledSettings().equals(settings))
    throw new Error("integration.claude-code.settings");
  const doctor = await claudeMachine(
    commands[5],
    deadline,
    "agentscope doctor",
  );
  if (
    doctor.length !== 1 ||
    doctor[0]?.summary?.errors !== 0 ||
    !Array.isArray(doctor[0].findings) ||
    doctor[0].findings.some((finding) => finding?.severity === "error")
  )
    throw new Error("integration.claude-code.doctor");
  const retired = await claudeMachine(
    commands[6],
    deadline,
    "agentscope uninstall",
  );
  if (
    retired.length !== 1 ||
    retired[0]?.harness !== "claude-code" ||
    retired[0].operation !== "uninstall" ||
    retired[0].applied !== true ||
    retired[0].disposition !== "committed"
  )
    throw new Error("integration.claude-code.uninstall");
  const status = await claudeMachine(
    commands[7],
    deadline,
    "agentscope harness status",
  );
  if (status.length !== 1 || status[0]?.installation !== "ready")
    throw new Error("integration.claude-code.uninstall");
};

export const monotonicNow = () => {
  const source = readFileSync("/proc/uptime", "utf8");
  if (source.length > 128 || !/^\d+(?:\.\d+)?\s/u.test(source))
    throw new Error("integration.claude-code.clock");
  const value = Number(source.split(/\s/u, 1)[0]) * 1000;
  if (!Number.isFinite(value) || value < 0)
    throw new Error("integration.claude-code.clock");
  return value;
};

export const cliEnvironment = Object.freeze({
  HOME: "/home/agentscope",
  XDG_CONFIG_HOME: "/harness-home",
  CLAUDE_CONFIG_DIR: "/harness-home",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  LANG: "C.UTF-8",
  TERM: "xterm-256color",
  CI: "true",
  AGENTSCOPE_HOME: "/agentscope-home",
  AGENTSCOPE_LANGFUSE_PUBLIC_KEY: "DUMMY_PUBLIC_KEY",
  AGENTSCOPE_LANGFUSE_SECRET_KEY: "DUMMY_SECRET_KEY",
  NODE_EXTRA_CA_CERTS: "/opt/agentscope/collector-ca.pem",
});

// These are ordinary packed-CLI commands within the existing selected PTY
// scenario boundary, not another execution kernel or a support receipt.
export const claudeCodeLifecycleCommands = (destinationSettings) => {
  const settings = JSON.stringify(destinationSettings);
  if (settings === undefined || Buffer.byteLength(settings) > 65_536)
    throw new Error("integration.claude-code.destination-settings");
  return Object.freeze(
    [
      ["init", "--yes"],
      [
        "destination",
        "configure",
        "langfuse",
        "--name",
        "trace",
        "--yes",
        "--settings",
        settings,
        "--credential-env",
        "public-key=AGENTSCOPE_LANGFUSE_PUBLIC_KEY",
        "secret-key=AGENTSCOPE_LANGFUSE_SECRET_KEY",
      ],
      ["routing", "set", "trace"],
      ["install", "claude-code", "--yes"],
      ["harness", "status", "claude-code"],
      ["doctor"],
      ["uninstall", "claude-code", "--yes"],
      ["harness", "status", "claude-code"],
    ].map((arguments_) => Object.freeze(arguments_)),
  );
};

// The original outer deadline is supplied by the selected wrapper. The caller
// must not replace it with a new duration after any command or vendor turn.
export const runClaudeCodeLifecycleCommand = async (arguments_, deadline) => {
  const remaining = Math.floor(deadline - monotonicNow());
  if (!Number.isFinite(remaining) || remaining <= 0)
    throw new Error("integration.claude-code.deadline");
  const result = await execute(cli, [...arguments_, "--output", "json"], {
    cwd: "/worktree",
    env: cliEnvironment,
    uid: 1000,
    gid: 1000,
    timeout: remaining,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
  if (monotonicNow() >= deadline)
    throw new Error("integration.claude-code.deadline");
  return result.stdout;
};

// Only the existing selected PTY owner's initial challenge is accepted here.
// Reading it does not attest native readiness or terminal completion.
export const readClaudeCodeReadinessChallenge = (deadline, now) =>
  new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const finish = (error, value) => {
      clearTimeout(timer);
      process.stdin.off("data", data);
      process.stdin.off("end", ended);
      process.stdin.off("error", ended);
      process.stdin.pause();
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const ended = () => finish(new Error("integration.claude-code.readiness"));
    const data = (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 65) return ended();
      if (bytes.length < 65) return;
      if (
        bytes[64] !== 10 ||
        !/^[a-f0-9]{64}$/u.test(bytes.subarray(0, 64).toString("utf8"))
      )
        return ended();
      finish(undefined, bytes.subarray(0, 64).toString("utf8"));
    };
    const remaining = Math.floor(deadline - now());
    const timer = setTimeout(ended, Math.max(1, Math.min(10_000, remaining)));
    if (remaining <= 0) return ended();
    process.stdin.on("data", data);
    process.stdin.once("end", ended);
    process.stdin.once("error", ended);
    process.stdin.resume();
  });

// Snapshot the CLI-owned installed file before vendor launch and again after
// join. Candidate-controlled symlinks or concurrent replacement are refused.
export const readClaudeCodeInstalledSettings = () => {
  const path = "/harness-home/settings.json";
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.uid !== 1000 ||
      before.nlink !== 1 ||
      (before.mode & 0o7777) !== 0o600 ||
      before.size < 1 ||
      before.size > 65536
    )
      throw new Error("integration.claude-code.settings");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (count === 0) break;
      length += count;
    }
    if (
      length !== before.size ||
      [fstatSync(descriptor), lstatSync(path)].some((after) =>
        [
          "dev",
          "ino",
          "size",
          "mode",
          "uid",
          "nlink",
          "mtimeMs",
          "ctimeMs",
        ].some((key) => before[key] !== after[key]),
      )
    )
      throw new Error("integration.claude-code.settings");
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, length),
      ),
    );
    const events = ["SessionStart", "PreToolUse", "PostToolUse", "Stop"];
    if (
      JSON.stringify(Object.keys(value.hooks ?? {}).sort()) !==
      JSON.stringify([...events].sort())
    )
      throw new Error("integration.claude-code.settings");
    const commands = events.map((event) => {
      const groups = value.hooks[event],
        group = groups?.[0],
        hook = group?.hooks?.[0];
      if (
        groups?.length !== 1 ||
        group?.hooks?.length !== 1 ||
        group?.agentscope?.event !== event ||
        group.agentscope.contractVersion !== 1 ||
        group.agentscope.harnessType !== "@agentscope/harness-claude-code" ||
        !/^agentscope-hook-v1-sha256-[a-f0-9]{64}$/u.test(
          group.agentscope.ownershipIdentity,
        ) ||
        Object.keys(group.agentscope).sort().join("\0") !==
          "contractVersion\0event\0harnessType\0ownershipIdentity" ||
        group.agentscope.ownershipIdentity !==
          value.hooks.SessionStart[0].agentscope.ownershipIdentity ||
        hook?.type !== "command" ||
        !Array.isArray(hook.args) ||
        hook.args.length !== 0 ||
        !Number.isSafeInteger(hook.timeout) ||
        hook.timeout < 1 ||
        typeof hook.command !== "string"
      )
        throw new Error("integration.claude-code.settings");
      return hook.command;
    });
    if (new Set(commands).size !== 1 || commands[0].length === 0)
      throw new Error("integration.claude-code.settings");
    return bytes.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
};
