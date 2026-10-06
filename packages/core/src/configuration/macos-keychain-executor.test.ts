import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";

import {
  createMacosSecurityCommandExecutorForTesting,
  type MacosSecurityChild,
  type MacosSecuritySpawn,
} from "./macos-keychain-executor.js";
import type { MacosKeychainCommand } from "./macos-keychain-command.js";

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
  inputError(): void;
  outputError(kind: "stdout" | "stderr"): void;
  emitStdout(chunk: unknown): void;
  emitStderr(chunk: unknown): void;
  killed: () => number;
  disposed: () => number;
  unreferenced: () => number;
  stdinValues: readonly (string | undefined)[];
  spawn: MacosSecuritySpawn;
}>;

const fixture = (
  kill: "true" | "false" | "throw" = "true",
  inputThrows = false,
  disposalThrows = false,
): Fixture => {
  let killCount = 0;
  let disposed = 0;
  let unreferenced = 0;
  const stdinValues: (string | undefined)[] = [];
  const stream = () =>
    Object.assign(new EventEmitter(), {
      destroy: () => {
        disposed += 1;
        if (disposalThrows) throw new Error("CANARY_SECRET");
      },
    });
  const stdout = stream();
  const stderr = stream();
  const stdin = Object.assign(stream(), {
    end: (value?: string) => {
      if (inputThrows) throw new Error("CANARY_SECRET");
      stdinValues.push(value);
    },
  });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: () => {
      killCount += 1;
      if (kill === "throw") throw new Error("CANARY_SECRET");
      return kill === "true";
    },
    unref: () => {
      unreferenced += 1;
      if (disposalThrows) throw new Error("CANARY_SECRET");
    },
  });
  return {
    child,
    close: (code) => {
      child.emit("close", code);
    },
    error: () => {
      child.emit("error", new Error("CANARY_SECRET"));
    },
    inputError: () => {
      stdin.emit("error", new Error("CANARY_SECRET"));
    },
    outputError: (kind) => {
      (kind === "stdout" ? stdout : stderr).emit(
        "error",
        new Error("CANARY_SECRET"),
      );
    },
    emitStdout: (chunk) => {
      stdout.emit("data", chunk);
    },
    emitStderr: (chunk) => {
      stderr.emit("data", chunk);
    },
    killed: () => killCount,
    disposed: () => disposed,
    unreferenced: () => unreferenced,
    stdinValues,
    spawn: () => child,
  };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
        value.close(0);
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
    const rejected = expect(pending).rejects.toThrow(
      "core.credential.macos-keychain-join-uncertain",
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(value.killed()).toBe(1);
    expect(value.disposed()).toBe(3);
    expect(value.unreferenced()).toBe(1);
  });
});

describe("macOS stop versus terminal close", () => {
  it.each(["true", "false", "throw"] as const)(
    "does not mistake kill=%s for close after overflow",
    async (kill) => {
      const value = fixture(kill);
      let settled = false;
      const pending = createMacosSecurityCommandExecutorForTesting(value.spawn)(
        command(),
      );
      void pending.then(() => {
        settled = true;
      });
      value.emitStdout(new Uint8Array(16_385));
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(value.killed()).toBe(1);
      value.emitStdout(Uint8Array.of(7));
      value.close(0);
      await expect(pending).resolves.toEqual({
        exitCode: 1,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      });
      expect(value.disposed()).toBe(0);
    },
  );

  it.each([
    "abort",
    "child-error",
    "stdin-error",
    "stdin-throw",
    "stdout",
    "stderr",
  ] as const)(
    "observes close after %s before returning failure",
    async (failure) => {
      const value = fixture("true", failure === "stdin-throw");
      const controller = new AbortController();
      const pending = createMacosSecurityCommandExecutorForTesting(value.spawn)(
        command(controller.signal),
      );
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      if (failure === "abort") controller.abort();
      if (failure === "child-error") value.error();
      if (failure === "stdin-error") value.inputError();
      if (failure === "stdout" || failure === "stderr")
        value.outputError(failure);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(value.killed()).toBe(1);
      value.close(0);
      await expect(pending).resolves.toMatchObject({ exitCode: 1 });
      value.error();
      value.inputError();
      value.outputError("stdout");
      value.outputError("stderr");
      value.close(0);
      expect(value.killed()).toBe(1);
    },
  );

  it("refuses an already aborted invocation before spawning or sending stdin", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = vi.fn(() => fixture().child);
    await expect(
      createMacosSecurityCommandExecutorForTesting(spawn)(
        command(controller.signal),
      ),
    ).resolves.toMatchObject({ exitCode: 1 });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not write secret input after cancellation during spawn", async () => {
    const value = fixture();
    const controller = new AbortController();
    const pending = createMacosSecurityCommandExecutorForTesting(() => {
      controller.abort();
      return value.child;
    })(command(controller.signal));
    expect(value.stdinValues).toEqual([]);
    expect(value.killed()).toBe(1);
    value.close(0);
    await expect(pending).resolves.toMatchObject({ exitCode: 1 });
  });
});

describe("macOS bounded byte-copy failures", () => {
  it("rejects proxy output without invoking caller hooks", async () => {
    let hooks = 0;
    const value = fixture();
    const pending = createMacosSecurityCommandExecutorForTesting(value.spawn)(
      command(),
    );
    value.emitStdout(
      new Proxy(new Uint8Array(1), {
        get() {
          hooks += 1;
          throw new Error("CANARY_SECRET");
        },
      }),
    );
    expect(hooks).toBe(0);
    value.close(0);
    await expect(pending).resolves.toMatchObject({ exitCode: 1 });
  });

  it.each(["stdout", "stderr"] as const)(
    "waits for close after the bounded %s copy throws",
    async (kind) => {
      const value = fixture();
      const pending = createMacosSecurityCommandExecutorForTesting(value.spawn)(
        command(),
      );
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      vi.spyOn(Buffer, "copyBytesFrom").mockImplementationOnce(() => {
        throw new Error("CANARY_SECRET");
      });
      if (kind === "stdout") value.emitStdout(Uint8Array.of(1));
      else value.emitStderr(Uint8Array.of(1));
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(value.killed()).toBe(1);
      value.close(0);
      await expect(pending).resolves.toEqual({
        exitCode: 1,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      });
      expect(value.disposed()).toBe(0);
    },
  );
});

describe("macOS terminal callback revocation", () => {
  it("ignores stale terminal and hard-cutoff callbacks after a joined close", async () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, "setTimeout");
    const value = fixture();
    const events = vi.spyOn(value.child, "once");
    const pending = createMacosSecurityCommandExecutorForTesting(value.spawn)(
      command(),
    );
    const close = (
      events.mock.calls as readonly (readonly [string, unknown])[]
    ).find(([event]) => event === "close")?.[1];
    const hardCutoff = timers.mock.calls[1]?.[0];
    expect(close).toBeTypeOf("function");
    expect(hardCutoff).toBeTypeOf("function");
    value.close(0);
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
    (close as (code: number | null) => void)(1);
    (hardCutoff as () => void)();
    expect(value.killed()).toBe(0);
    expect(value.disposed()).toBe(0);
    expect(value.unreferenced()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("macOS original command authority", () => {
  it.each(["false", "throw"] as const)(
    "keeps unproved close uncertain when kill=%s and pipe disposal throws",
    async (kill) => {
      vi.useFakeTimers();
      const value = fixture(kill, false, true);
      const pending = createMacosSecurityCommandExecutorForTesting(value.spawn)(
        command(),
      );
      const rejected = expect(pending).rejects.toThrow(
        "core.credential.macos-keychain-join-uncertain",
      );
      value.emitStderr(new Uint8Array(16_385));
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      expect(value.disposed()).toBe(3);
      expect(value.unreferenced()).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("reserves teardown inside fifteen seconds and never resets it on failure", async () => {
    vi.useFakeTimers();
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const value = fixture("false");
    const controller = new AbortController();
    const pending = createMacosSecurityCommandExecutorForTesting(value.spawn)(
      command(controller.signal),
    );
    const rejected = expect(pending).rejects.toThrow(
      "core.credential.macos-keychain-join-uncertain",
    );
    now += 14_000;
    await vi.advanceTimersByTimeAsync(14_000);
    expect(value.killed()).toBe(1);
    controller.abort();
    value.error();
    value.emitStderr(new Uint8Array(16_385));
    now += 999;
    await vi.advanceTimersByTimeAsync(999);
    expect(value.disposed()).toBe(0);
    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(value.disposed()).toBe(3);
    expect(value.unreferenced()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    value.close(0);
    value.error();
    expect(value.killed()).toBe(1);
  });

  it("joins a delayed close inside the reserved interval without a new timer", async () => {
    vi.useFakeTimers();
    const value = fixture();
    const pending = createMacosSecurityCommandExecutorForTesting(value.spawn)(
      command(),
    );
    await vi.advanceTimersByTimeAsync(14_000);
    expect(value.killed()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    value.close(0);
    await expect(pending).resolves.toMatchObject({ exitCode: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects clock-late close even before the hard timer callback runs", async () => {
    vi.useFakeTimers();
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const value = fixture();
    const pending = createMacosSecurityCommandExecutorForTesting(value.spawn)(
      command(),
    );
    const rejected = expect(pending).rejects.toThrow(
      "core.credential.macos-keychain-deadline",
    );
    now = 15_100;
    value.close(0);
    await rejected;
    expect(value.disposed()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never accepts successful work after the reserved cutoff before timer dispatch", async () => {
    vi.useFakeTimers();
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const value = fixture();
    const pending = createMacosSecurityCommandExecutorForTesting(value.spawn)(
      command(),
    );
    now = 14_100;
    value.close(0);
    await expect(pending).resolves.toEqual({
      exitCode: 1,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
