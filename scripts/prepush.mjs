import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MAX_GIT_OUTPUT_BYTES = 8 * 1024;
const MAX_LOCAL_ENVIRONMENT_NAMES = 64;
const MAX_ENVIRONMENT_NAME_BYTES = 128;
const GIT_ENUMERATION_TIMEOUT_MS = 2_000;
const CHILD_JOIN_TIMEOUT_MS = 2_000;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const FORWARDED_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"];
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

export function parseLocalEnvironmentNames(output) {
  if (
    typeof output !== "string" ||
    output.length === 0 ||
    Buffer.byteLength(output) > MAX_GIT_OUTPUT_BYTES ||
    !output.endsWith("\n") ||
    output.includes("\r")
  ) {
    throw new Error("git-environment-invalid");
  }
  const names = output.slice(0, -1).split("\n");
  if (
    names.length === 0 ||
    names.length > MAX_LOCAL_ENVIRONMENT_NAMES ||
    names.some(
      (name) =>
        Buffer.byteLength(name) === 0 ||
        Buffer.byteLength(name) > MAX_ENVIRONMENT_NAME_BYTES ||
        !ENVIRONMENT_NAME.test(name),
    ) ||
    new Set(names).size !== names.length
  ) {
    throw new Error("git-environment-invalid");
  }
  return names;
}

export function scrubLocalEnvironment(ambient, names) {
  const environment = { ...ambient };
  for (const name of names) delete environment[name];
  return environment;
}

function signalProcessGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function terminateBySignal(signal) {
  for (const name of FORWARDED_SIGNALS) process.removeAllListeners(name);
  process.kill(process.pid, signal);
  process.exit(SIGNAL_EXIT_CODES[signal] ?? 74);
}

function runChild(command, arguments_, options) {
  return new Promise((resolve) => {
    const child = spawn(command, arguments_, {
      ...options,
      detached: true,
    });
    let settled = false;
    child.once("error", () => {
      if (!settled) {
        settled = true;
        resolve({ code: null, signal: null, spawnError: true });
      }
    });
    child.once("close", (code, signal) => {
      if (!settled) {
        settled = true;
        resolve({ code, signal, spawnError: false });
      }
    });
    options.onSpawn?.(child);
  });
}

export async function main() {
  let activeChild;
  let pendingSignal;
  let forcedJoin;
  const forward = (signal) => {
    if (pendingSignal !== undefined) return;
    pendingSignal = signal;
    if (activeChild !== undefined) {
      signalProcessGroup(activeChild, signal);
      forcedJoin = setTimeout(() => {
        signalProcessGroup(activeChild, "SIGKILL");
      }, CHILD_JOIN_TIMEOUT_MS);
      forcedJoin.unref();
    }
  };
  for (const signal of FORWARDED_SIGNALS)
    process.on(signal, () => forward(signal));

  let stdout = Buffer.alloc(0);
  let enumerationInvalid = false;
  let enumerationTimedOut = false;
  let enumerationTimer;
  const enumeration = await runChild("git", ["rev-parse", "--local-env-vars"], {
    stdio: ["ignore", "pipe", "pipe"],
    onSpawn(child) {
      activeChild = child;
      enumerationTimer = setTimeout(() => {
        enumerationTimedOut = true;
        signalProcessGroup(child, "SIGKILL");
      }, GIT_ENUMERATION_TIMEOUT_MS);
      child.stdout.on("data", (chunk) => {
        if (stdout.length + chunk.length > MAX_GIT_OUTPUT_BYTES) {
          enumerationInvalid = true;
          signalProcessGroup(child, "SIGKILL");
          return;
        }
        stdout = Buffer.concat([stdout, chunk]);
      });
      let stderrBytes = 0;
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_GIT_OUTPUT_BYTES) {
          enumerationInvalid = true;
          signalProcessGroup(child, "SIGKILL");
        }
      });
    },
  });
  clearTimeout(enumerationTimer);
  clearTimeout(forcedJoin);
  activeChild = undefined;
  if (pendingSignal !== undefined) terminateBySignal(pendingSignal);

  let names;
  try {
    if (
      enumeration.spawnError ||
      enumeration.code !== 0 ||
      enumeration.signal !== null ||
      enumerationInvalid ||
      enumerationTimedOut
    ) {
      throw new Error("git-environment-unavailable");
    }
    names = parseLocalEnvironmentNames(stdout.toString("utf8"));
  } catch {
    process.stderr.write("prepush: git-environment-unavailable\n");
    return 74;
  }

  if (pendingSignal !== undefined) terminateBySignal(pendingSignal);
  const validation = await runChild("pnpm", ["prepush"], {
    env: scrubLocalEnvironment(process.env, names),
    stdio: "inherit",
    onSpawn(child) {
      activeChild = child;
      if (pendingSignal !== undefined) forward(pendingSignal);
    },
  });
  clearTimeout(forcedJoin);
  activeChild = undefined;
  if (pendingSignal !== undefined) terminateBySignal(pendingSignal);
  if (validation.spawnError) {
    process.stderr.write("prepush: validation-unavailable\n");
    return 74;
  }
  if (validation.signal !== null) terminateBySignal(validation.signal);
  return validation.code ?? 74;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
