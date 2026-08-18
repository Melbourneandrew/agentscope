import { spawn as nodeSpawn } from "node:child_process";

import type {
  LinuxSecretServiceCommand,
  LinuxSecretServiceCommandExecutor,
  LinuxSecretServiceCommandResult,
} from "./linux-secret-service-command.js";

const MAXIMUM_OUTPUT_BYTES = 16_384;
const COMMAND_TIMEOUT_MILLISECONDS = 15_000;

export type LinuxSecretServiceByteStream = Readonly<{
  on(
    event: "data",
    listener: (chunk: unknown) => void,
  ): LinuxSecretServiceByteStream;
}>;
export type LinuxSecretServiceInputStream = Readonly<{
  end(value?: string): void;
}>;
export type LinuxSecretServiceChild = Readonly<{
  stdin: LinuxSecretServiceInputStream;
  stdout: LinuxSecretServiceByteStream;
  stderr: LinuxSecretServiceByteStream;
  kill(): boolean;
  once(
    event: "close",
    listener: (code: number | null) => void,
  ): LinuxSecretServiceChild;
  once(event: "error", listener: () => void): LinuxSecretServiceChild;
}>;
export type LinuxSecretServiceSpawn = (
  executable: string,
  arguments_: readonly string[],
  options: Readonly<{
    shell: false;
    signal: AbortSignal;
    stdio: readonly ["pipe", "pipe", "pipe"];
    windowsHide: true;
  }>,
) => LinuxSecretServiceChild;

type BoundedOutput = { chunks: Uint8Array[]; size: number; overflow: boolean };
const append = (output: BoundedOutput, chunk: unknown): void => {
  if (
    !(chunk instanceof Uint8Array) ||
    output.size + chunk.byteLength > MAXIMUM_OUTPUT_BYTES
  ) {
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

const classifyFailure = (
  command: LinuxSecretServiceCommand,
  stderr: BoundedOutput,
): number => {
  if (stderr.overflow) return 1;
  let message: string;
  try {
    message = new TextDecoder("utf-8", { fatal: true })
      .decode(concatenate(stderr))
      .toLowerCase();
  } catch {
    return 1;
  }
  if (message.includes("locked") || message.includes("islocked")) return 51;
  if (
    message.includes("denied") ||
    message.includes("notauthorized") ||
    message.includes("permission")
  )
    return 36;
  if (
    command.operation !== "store" &&
    (message.trim().length === 0 ||
      message.includes("not found") ||
      message.includes("no such"))
  )
    return 44;
  return 1;
};

const execute = (
  spawn: LinuxSecretServiceSpawn,
  command: LinuxSecretServiceCommand,
): Promise<LinuxSecretServiceCommandResult> =>
  new Promise((resolve) => {
    const stdout: BoundedOutput = { chunks: [], size: 0, overflow: false };
    const stderr: BoundedOutput = { chunks: [], size: 0, overflow: false };
    let child: LinuxSecretServiceChild | undefined;
    let settled = false;
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        Object.freeze({
          exitCode,
          stdout:
            exitCode === 0 && !stdout.overflow
              ? concatenate(stdout)
              : new Uint8Array(),
        }),
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
          code === 0
            ? 0
            : Number.isInteger(code) && code !== null && code > 0 && code <= 255
              ? classifyFailure(command, stderr)
              : 1,
        );
      });
      child.stdin.end(command.stdin);
    } catch {
      child?.kill();
      finish(1);
    }
  });

export const createLinuxSecretServiceCommandExecutor =
  (): LinuxSecretServiceCommandExecutor =>
    createLinuxSecretServiceCommandExecutorForTesting(
      nodeSpawn as unknown as LinuxSecretServiceSpawn,
    );
export const createLinuxSecretServiceCommandExecutorForTesting =
  (spawn: LinuxSecretServiceSpawn): LinuxSecretServiceCommandExecutor =>
  (command) =>
    execute(spawn, command);
