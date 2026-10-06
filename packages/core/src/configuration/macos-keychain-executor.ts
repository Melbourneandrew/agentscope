import { spawn as nodeSpawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { types } from "node:util";

import type {
  MacosKeychainCommand,
  MacosKeychainCommandExecutor,
  MacosKeychainCommandResult,
} from "./macos-keychain-command.js";

const MAXIMUM_OUTPUT_BYTES = 16_384;
const COMMAND_TIMEOUT_MILLISECONDS = 15_000;
const COMMAND_TEARDOWN_RESERVE_MILLISECONDS = 1_000;
const RESOLUTION_TEARDOWN_RESERVE_MILLISECONDS = 100;

const commandLifetime = (
  command: MacosKeychainCommand,
): Readonly<{ deadline: number; workCutoff: number }> => {
  const enteredAt = performance.now();
  if (types.isProxy(command))
    throw new Error("core.credential.macos-keychain-deadline");
  const descriptor = Object.getOwnPropertyDescriptor(
    command,
    "expiresAtMonotonicMilliseconds",
  );
  const initialPrototype: unknown = Object.getPrototypeOf(command);
  let prototype = initialPrototype as object | null;
  for (let depth = 0; prototype !== null; depth += 1) {
    if (
      depth >= 8 ||
      types.isProxy(prototype) ||
      Object.getOwnPropertyDescriptor(
        prototype,
        "expiresAtMonotonicMilliseconds",
      )
    )
      throw new Error("core.credential.macos-keychain-deadline");
    const nextPrototype: unknown = Object.getPrototypeOf(prototype);
    prototype = nextPrototype as object | null;
  }
  const inherited: unknown = descriptor?.value;
  if (
    descriptor !== undefined &&
    (!("value" in descriptor) ||
      typeof inherited !== "number" ||
      !Number.isFinite(inherited) ||
      inherited < 0)
  )
    throw new Error("core.credential.macos-keychain-deadline");
  const deadline = Math.min(
    enteredAt + COMMAND_TIMEOUT_MILLISECONDS,
    typeof inherited === "number" ? inherited : Number.POSITIVE_INFINITY,
  );
  const reserve =
    descriptor === undefined
      ? COMMAND_TEARDOWN_RESERVE_MILLISECONDS
      : RESOLUTION_TEARDOWN_RESERVE_MILLISECONDS;
  if (deadline - enteredAt <= reserve)
    throw new Error("core.credential.macos-keychain-deadline");
  return Object.freeze({
    deadline,
    workCutoff: Math.min(
      enteredAt +
        COMMAND_TIMEOUT_MILLISECONDS -
        COMMAND_TEARDOWN_RESERVE_MILLISECONDS,
      deadline - reserve,
    ),
  });
};

export type MacosSecurityByteStream = Readonly<{
  on(
    event: "data",
    listener: (chunk: unknown) => void,
  ): MacosSecurityByteStream;
  on(event: "error", listener: () => void): MacosSecurityByteStream;
  destroy(): void;
}>;

export type MacosSecurityInputStream = Readonly<{
  end(value?: string): void;
  on(event: "error", listener: () => void): MacosSecurityInputStream;
  destroy(): void;
}>;

export type MacosSecurityChild = Readonly<{
  stdin: MacosSecurityInputStream;
  stdout: MacosSecurityByteStream;
  stderr: MacosSecurityByteStream;
  kill(signal: "SIGKILL"): boolean;
  unref(): void;
  on(event: "error", listener: () => void): MacosSecurityChild;
  once(
    event: "close",
    listener: (code: number | null) => void,
  ): MacosSecurityChild;
  once(event: "error", listener: () => void): MacosSecurityChild;
}>;

export type MacosSecuritySpawn = (
  executable: string,
  arguments_: readonly string[],
  options: Readonly<{
    detached: true;
    shell: false;
    signal: AbortSignal;
    stdio: readonly ["pipe", "pipe", "pipe"];
    windowsHide: true;
  }>,
) => MacosSecurityChild;

type BoundedOutput = {
  chunks: Uint8Array[];
  size: number;
  overflow: boolean;
};

const append = (output: BoundedOutput, chunk: unknown): void => {
  if (!types.isUint8Array(chunk)) {
    output.overflow = true;
    return;
  }
  const copy = Buffer.copyBytesFrom(
    chunk,
    0,
    MAXIMUM_OUTPUT_BYTES - output.size + 1,
  );
  if (output.size + copy.length > MAXIMUM_OUTPUT_BYTES) {
    output.overflow = true;
    return;
  }
  output.chunks.push(copy);
  output.size += copy.length;
};

const concatenate = (output: BoundedOutput): Uint8Array => {
  const value = new Uint8Array(output.size);
  let offset = 0;
  for (const chunk of output.chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return value;
};

const fixedResult = (
  exitCode: number,
  stdout: BoundedOutput,
  stderr: BoundedOutput,
): MacosKeychainCommandResult =>
  Object.freeze({
    exitCode,
    stdout: concatenate(stdout),
    stderr: concatenate(stderr),
  });

const execute = (
  spawn: MacosSecuritySpawn,
  command: MacosKeychainCommand,
): Promise<MacosKeychainCommandResult> =>
  new Promise((resolve, reject) => {
    const { deadline, workCutoff } = commandLifetime(command);
    const stdout: BoundedOutput = { chunks: [], size: 0, overflow: false };
    const stderr: BoundedOutput = { chunks: [], size: 0, overflow: false };
    let child: MacosSecurityChild | undefined;
    let settled = false;
    let stopped = false;
    const empty: BoundedOutput = { chunks: [], size: 0, overflow: false };
    const clear = (): void => {
      settled = true;
      clearTimeout(workTimer);
      clearTimeout(hardTimer);
      command.signal.removeEventListener("abort", stop);
      stdout.chunks = [];
      stderr.chunks = [];
    };
    const finish = (exitCode: number): void => {
      if (settled) return;
      const late = performance.now() >= deadline;
      const result =
        stopped || command.signal.aborted || performance.now() >= workCutoff
          ? fixedResult(1, empty, empty)
          : fixedResult(exitCode, stdout, stderr);
      clear();
      if (late) reject(new Error("core.credential.macos-keychain-deadline"));
      else resolve(result);
    };
    const stop = (): void => {
      if (settled || stopped) return;
      stopped = true;
      stdout.chunks = [];
      stderr.chunks = [];
      try {
        child?.kill("SIGKILL");
      } catch {
        // A termination request is not close evidence, even when it throws.
      }
    };
    const workTimer = setTimeout(
      stop,
      Math.max(0, workCutoff - performance.now()),
    );
    const hardTimer = setTimeout(
      () => {
        if (settled) return;
        stop();
        clear();
        /* v8 ignore else -- synchronous spawn failure finishes and cancels both timers;
           every unsettled hard-cutoff callback therefore owns a child. */
        if (child !== undefined) {
          for (const stream of [child.stdin, child.stdout, child.stderr]) {
            try {
              stream.destroy();
            } catch {
              // Unproved close stays uncertain; disposing pipes proves no join.
            }
          }
          try {
            child.unref();
          } catch {
            // No close evidence may be inferred from releasing a Node handle.
          }
        }
        reject(new Error("core.credential.macos-keychain-join-uncertain"));
      },
      Math.max(0, deadline - performance.now()),
    );
    try {
      if (command.signal.aborted || performance.now() >= workCutoff) {
        stopped = true;
        finish(1);
        return;
      }
      child = spawn(command.executable, command.arguments, {
        detached: true,
        shell: false,
        signal: command.signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      command.signal.addEventListener("abort", stop, { once: true });
      child.stdout.on("data", (chunk) => {
        if (settled || stopped) return;
        try {
          append(stdout, chunk);
        } catch {
          stop();
        }
        if (stdout.overflow) stop();
      });
      child.stderr.on("data", (chunk) => {
        if (settled || stopped) return;
        try {
          append(stderr, chunk);
        } catch {
          stop();
        }
        if (stderr.overflow) stop();
      });
      child.stdin.on("error", stop);
      child.stdout.on("error", stop);
      child.stderr.on("error", stop);
      child.on("error", stop);
      child.once("close", (code) => {
        finish(
          Number.isInteger(code) && code !== null && code >= 0 && code <= 255
            ? code
            : 1,
        );
      });
      if (command.signal.aborted || performance.now() >= workCutoff) stop();
      if (stopped) return;
      child.stdin.end(command.stdin);
    } catch {
      stop();
      if (child === undefined) finish(1);
    }
  });

export const createMacosSecurityCommandExecutor =
  (): MacosKeychainCommandExecutor =>
    createMacosSecurityCommandExecutorForTesting(
      nodeSpawn as unknown as MacosSecuritySpawn,
    );

export const createMacosSecurityCommandExecutorForTesting =
  (spawn: MacosSecuritySpawn): MacosKeychainCommandExecutor =>
  (command) =>
    execute(spawn, command);
