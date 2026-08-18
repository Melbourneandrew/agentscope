import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMacosSecurityCommandExecutorForTesting,
  type MacosSecurityByteStream,
  type MacosSecurityChild,
  type MacosSecuritySpawn,
} from "./macos-keychain-executor.js";
import type { MacosKeychainCommand } from "./macos-keychain.js";

const command = (signal = new AbortController().signal): MacosKeychainCommand =>
  Object.freeze({
    executable: "/usr/bin/security",
    arguments: Object.freeze(["add-generic-password", "-w"]),
    stdin: "CANARY_SECRET\n",
    signal,
  });

type Fixture = Readonly<{
  child: MacosSecurityChild;
  close(code: number | null): void;
  error(): void;
  emitStdout(chunk: unknown): void;
  emitStderr(chunk: unknown): void;
  killed: () => number;
  stdinValues: readonly (string | undefined)[];
  spawn: MacosSecuritySpawn;
}>;

const fixture = (): Fixture => {
  let closeListener: ((code: number | null) => void) | undefined;
  let errorListener: (() => void) | undefined;
  let stdoutListener: ((chunk: unknown) => void) | undefined;
  let stderrListener: ((chunk: unknown) => void) | undefined;
  let killCount = 0;
  const stdinValues: (string | undefined)[] = [];
  const stream = (
    set: (listener: (chunk: unknown) => void) => void,
  ): MacosSecurityByteStream => {
    const value: MacosSecurityByteStream = {
      on: (_event, listener) => {
        set(listener);
        return value;
      },
    };
    return value;
  };
  const child = {} as MacosSecurityChild;
  Object.assign(child, {
    stdin: { end: (value?: string) => stdinValues.push(value) },
    stdout: stream((listener) => {
      stdoutListener = listener;
    }),
    stderr: stream((listener) => {
      stderrListener = listener;
    }),
    kill: () => {
      killCount += 1;
      return true;
    },
    once: (
      event: "close" | "error",
      listener: ((code: number | null) => void) | (() => void),
    ) => {
      if (event === "close") closeListener = listener;
      else errorListener = listener as () => void;
      return child;
    },
  });
  return {
    child,
    close: (code) => closeListener?.(code),
    error: () => errorListener?.(),
    emitStdout: (chunk) => stdoutListener?.(chunk),
    emitStderr: (chunk) => stderrListener?.(chunk),
    killed: () => killCount,
    stdinValues,
    spawn: () => child,
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("macOS security command executor", () => {
  it("uses exact shell-free process options, bounded bytes, and stdin", async () => {
    const value = fixture();
    let captured: readonly unknown[] | undefined;
    const execute = createMacosSecurityCommandExecutorForTesting(
      (executable, arguments_, options) => {
        captured = [executable, arguments_, options];
        return value.child;
      },
    );
    const pending = execute(command());
    value.emitStdout(Uint8Array.of(1, 2));
    value.emitStderr(Uint8Array.of(3));
    value.close(0);
    await expect(pending).resolves.toEqual({
      exitCode: 0,
      stdout: Uint8Array.of(1, 2),
      stderr: Uint8Array.of(3),
    });
    expect(captured?.[0]).toBe("/usr/bin/security");
    expect(captured?.[1]).toEqual(["add-generic-password", "-w"]);
    expect(captured?.[2]).toMatchObject({
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    expect(value.stdinValues).toEqual(["CANARY_SECRET\n"]);
  });

  it("collapses process errors, malformed chunks, and overflow", async () => {
    for (const emit of [
      (value: Fixture) => {
        value.error();
      },
      (value: Fixture) => {
        value.emitStdout("not-bytes");
        value.close(0);
      },
      (value: Fixture) => {
        value.emitStderr(new Uint8Array(16_385));
        value.close(0);
      },
      (value: Fixture) => {
        value.close(null);
      },
    ]) {
      const value = fixture();
      const pending = createMacosSecurityCommandExecutorForTesting(value.spawn)(
        command(),
      );
      emit(value);
      await expect(pending).resolves.toMatchObject({ exitCode: 1 });
    }
  });

  it("contains synchronous spawn failure and a never-settling command", async () => {
    await expect(
      createMacosSecurityCommandExecutorForTesting(() => {
        throw new Error("CANARY_SECRET");
      })(command()),
    ).resolves.toMatchObject({ exitCode: 1 });
    vi.useFakeTimers();
    const value = fixture();
    const pending = createMacosSecurityCommandExecutorForTesting(value.spawn)(
      command(),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toMatchObject({ exitCode: 1 });
    expect(value.killed()).toBe(1);
  });
});
