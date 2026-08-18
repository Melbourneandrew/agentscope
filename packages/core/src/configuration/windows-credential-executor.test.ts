import { afterEach, describe, expect, it, vi } from "vitest";

import type { WindowsCredentialCommand } from "./windows-credential-command.js";
import {
  createWindowsCredentialCommandExecutorForTesting,
  type WindowsCredentialByteStream,
  type WindowsCredentialChild,
  type WindowsCredentialSpawn,
} from "./windows-credential-executor.js";

const command = (): WindowsCredentialCommand =>
  Object.freeze({
    executable:
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    arguments: Object.freeze(["-NoProfile", "-EncodedCommand", "fixed"]),
    stdin: '{"secretBase64":"Q0FOQVJZ"}',
    signal: new AbortController().signal,
  });

const fixture = () => {
  let closeListener: ((code: number | null) => void) | undefined;
  let errorListener: (() => void) | undefined;
  let stdoutListener: ((chunk: unknown) => void) | undefined;
  let stderrListener: ((chunk: unknown) => void) | undefined;
  let killCount = 0;
  const stdinValues: (string | undefined)[] = [];
  const stream = (
    set: (listener: (chunk: unknown) => void) => void,
  ): WindowsCredentialByteStream => {
    const value: WindowsCredentialByteStream = {
      on: (_event, listener) => {
        set(listener);
        return value;
      },
    };
    return value;
  };
  const child = {} as WindowsCredentialChild;
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
    close: (code: number | null) => closeListener?.(code),
    error: () => errorListener?.(),
    emitStdout: (chunk: unknown) => stdoutListener?.(chunk),
    emitStderr: (chunk: unknown) => stderrListener?.(chunk),
    killed: () => killCount,
    stdinValues,
    spawn: (() => child) as WindowsCredentialSpawn,
  };
};

afterEach(() => vi.useRealTimers());

describe("Windows Credential Manager process executor", () => {
  it("uses exact shell-free options and passes the request only by stdin", async () => {
    const value = fixture();
    let captured: readonly unknown[] | undefined;
    const pending = createWindowsCredentialCommandExecutorForTesting(
      (executable, arguments_, options) => {
        captured = [executable, arguments_, options];
        return value.child;
      },
    )(command());
    value.emitStdout(Uint8Array.of(1));
    value.emitStderr(Uint8Array.of(2));
    value.close(0);
    await expect(pending).resolves.toEqual({
      exitCode: 0,
      stdout: Uint8Array.of(1),
      stderr: Uint8Array.of(2),
    });
    expect(captured?.[0]).toContain("WindowsPowerShell");
    expect(captured?.[1]).not.toContain("Q0FOQVJZ");
    expect(captured?.[2]).toMatchObject({
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    expect(value.stdinValues).toEqual(['{"secretBase64":"Q0FOQVJZ"}']);
  });

  it("collapses process errors, malformed output, and overflow", async () => {
    for (const emit of [
      (value: ReturnType<typeof fixture>) => value.error(),
      (value: ReturnType<typeof fixture>) => {
        value.emitStdout("not-bytes");
        value.close(0);
      },
      (value: ReturnType<typeof fixture>) => {
        value.emitStderr(new Uint8Array(16_385));
        value.close(0);
      },
      (value: ReturnType<typeof fixture>) => value.close(null),
    ]) {
      const value = fixture();
      const pending = createWindowsCredentialCommandExecutorForTesting(
        value.spawn,
      )(command());
      emit(value);
      await expect(pending).resolves.toMatchObject({ exitCode: 1 });
    }
  });

  it("contains spawn failure and a never-settling child", async () => {
    await expect(
      createWindowsCredentialCommandExecutorForTesting(() => {
        throw new Error("CANARY_SECRET");
      })(command()),
    ).resolves.toMatchObject({ exitCode: 1 });
    vi.useFakeTimers();
    const value = fixture();
    const pending = createWindowsCredentialCommandExecutorForTesting(
      value.spawn,
    )(command());
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toMatchObject({ exitCode: 1 });
    expect(value.killed()).toBe(1);
  });
});
