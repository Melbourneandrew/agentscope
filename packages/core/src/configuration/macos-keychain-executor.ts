import { spawn as nodeSpawn } from "node:child_process";

import type {
  MacosKeychainCommand,
  MacosKeychainCommandExecutor,
  MacosKeychainCommandResult,
} from "./macos-keychain-command.js";

const MAXIMUM_OUTPUT_BYTES = 16_384;
const COMMAND_TIMEOUT_MILLISECONDS = 15_000;

export type MacosSecurityByteStream = Readonly<{
  on(
    event: "data",
    listener: (chunk: unknown) => void,
  ): MacosSecurityByteStream;
}>;

export type MacosSecurityInputStream = Readonly<{
  end(value?: string): void;
}>;

export type MacosSecurityChild = Readonly<{
  stdin: MacosSecurityInputStream;
  stdout: MacosSecurityByteStream;
  stderr: MacosSecurityByteStream;
  kill(): boolean;
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
  if (!(chunk instanceof Uint8Array)) {
    output.overflow = true;
    return;
  }
  if (output.size + chunk.byteLength > MAXIMUM_OUTPUT_BYTES) {
    output.overflow = true;
    return;
  }
  output.chunks.push(Uint8Array.from(chunk));
  output.size += chunk.byteLength;
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
  new Promise((resolve) => {
    const stdout: BoundedOutput = { chunks: [], size: 0, overflow: false };
    const stderr: BoundedOutput = { chunks: [], size: 0, overflow: false };
    let child: MacosSecurityChild | undefined;
    let settled = false;
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        stdout.overflow || stderr.overflow
          ? fixedResult(
              1,
              { chunks: [], size: 0, overflow: false },
              {
                chunks: [],
                size: 0,
                overflow: false,
              },
            )
          : fixedResult(exitCode, stdout, stderr),
      );
    };
    const timer = setTimeout(() => {
      child?.kill();
      finish(1);
    }, COMMAND_TIMEOUT_MILLISECONDS);
    try {
      child = spawn(command.executable, command.arguments, {
        shell: false,
        signal: command.signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout.on("data", (chunk) => {
        append(stdout, chunk);
        if (stdout.overflow) {
          child?.kill();
          finish(1);
        }
      });
      child.stderr.on("data", (chunk) => {
        append(stderr, chunk);
        if (stderr.overflow) {
          child?.kill();
          finish(1);
        }
      });
      child.once("error", () => {
        child?.kill();
        finish(1);
      });
      child.once("close", (code) => {
        finish(
          Number.isInteger(code) && code !== null && code >= 0 && code <= 255
            ? code
            : 1,
        );
      });
      child.stdin.end(command.stdin);
    } catch {
      child?.kill();
      finish(1);
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
