import { afterEach, describe, expect, it, vi } from "vitest";

import type { LinuxSecretServiceCommand } from "./linux-secret-service-command.js";
import {
  createLinuxSecretServiceCommandExecutorForTesting,
  type LinuxSecretServiceByteStream,
  type LinuxSecretServiceChild,
  type LinuxSecretServiceSpawn,
} from "./linux-secret-service-executor.js";

const command = (
  operation: "store" | "lookup" | "clear" = "lookup",
): LinuxSecretServiceCommand => ({
  executable: "/usr/bin/secret-tool",
  operation,
  arguments: [operation, "service", "dev.agentscope.credentials.v1"],
  ...(operation === "store" ? { stdin: "CANARY_SECRET\n" } : {}),
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
  ): LinuxSecretServiceByteStream => {
    const value: LinuxSecretServiceByteStream = {
      on: (_event, listener) => {
        set(listener);
        return value;
      },
    };
    return value;
  };
  const child = {} as LinuxSecretServiceChild;
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
    spawn: (() => child) as LinuxSecretServiceSpawn,
  };
};

afterEach(() => vi.useRealTimers());

describe("Linux secret-tool executor", () => {
  it("uses exact shell-free options, bounded output, and stdin", async () => {
    const value = fixture();
    let captured: readonly unknown[] | undefined;
    const pending = createLinuxSecretServiceCommandExecutorForTesting(
      (executable, arguments_, options) => {
        captured = [executable, arguments_, options];
        return value.child;
      },
    )(command("store"));
    value.emitStdout(new TextEncoder().encode("ok"));
    value.close(0);
    await expect(pending).resolves.toEqual({
      exitCode: 0,
      stdout: new TextEncoder().encode("ok"),
    });
    expect(captured?.[0]).toBe("/usr/bin/secret-tool");
    expect(captured?.[1]).not.toContain("CANARY_SECRET");
    expect(captured?.[2]).toMatchObject({
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    expect(value.stdinValues).toEqual(["CANARY_SECRET\n"]);
  });

  it.each([
    ["lookup", "", 44],
    ["clear", "not found", 44],
    ["lookup", "collection is locked", 51],
    ["lookup", "org.example.IsLocked", 51],
    ["lookup", "access denied", 36],
    ["lookup", "NotAuthorized", 36],
    ["lookup", "permission failure", 36],
    ["store", "", 1],
    ["lookup", "D-Bus unavailable", 1],
  ] as const)("maps %s failure %s to %i", async (operation, message, code) => {
    const value = fixture();
    const pending = createLinuxSecretServiceCommandExecutorForTesting(
      value.spawn,
    )(command(operation));
    value.emitStdout(new TextEncoder().encode("CANARY_SECRET"));
    value.emitStderr(new TextEncoder().encode(message));
    value.close(1);
    await expect(pending).resolves.toEqual({
      exitCode: code,
      stdout: new Uint8Array(),
    });
  });

  it("contains invalid UTF-8, malformed/overflow output, errors, and timeout", async () => {
    for (const emit of [
      (value: ReturnType<typeof fixture>) => {
        value.emitStderr(Uint8Array.of(0xff));
        value.close(1);
      },
      (value: ReturnType<typeof fixture>) => {
        value.emitStdout("bad");
        value.close(0);
      },
      (value: ReturnType<typeof fixture>) => {
        value.emitStderr(new Uint8Array(16_385));
        value.close(1);
      },
      (value: ReturnType<typeof fixture>) => value.error(),
      (value: ReturnType<typeof fixture>) => value.close(null),
    ]) {
      const value = fixture();
      const pending = createLinuxSecretServiceCommandExecutorForTesting(
        value.spawn,
      )(command());
      emit(value);
      await expect(pending).resolves.toMatchObject({ exitCode: 1 });
    }
    await expect(
      createLinuxSecretServiceCommandExecutorForTesting(() => {
        throw new Error("CANARY_SECRET");
      })(command()),
    ).resolves.toMatchObject({ exitCode: 1 });
    vi.useFakeTimers();
    const value = fixture();
    const pending = createLinuxSecretServiceCommandExecutorForTesting(
      value.spawn,
    )(command());
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toMatchObject({ exitCode: 1 });
    expect(value.killed()).toBe(1);
  });
});
