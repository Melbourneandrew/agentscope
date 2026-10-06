import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  compileCredentialBackendRegistry,
  createCredentialResolutionContext,
  createStoredCredentialReference,
  createCredentialOwnership,
  deriveStoredCredentialReference,
  getStoredCredentialImplementation,
  resolveCredentialReference,
} from "./credential-adapter.js";
import {
  createMacosSecurityCommandExecutorForTesting,
  type MacosSecurityChild,
} from "./macos-keychain-executor.js";
import {
  createMacosKeychainCredentialAdapterForTesting,
  type MacosKeychainCommand,
} from "./macos-keychain.js";

const command = (expiry = 1_100): MacosKeychainCommand =>
  Object.freeze({
    executable: "/usr/bin/security",
    arguments: Object.freeze(["find-generic-password", "-w"]),
    signal: new AbortController().signal,
    expiresAtMonotonicMilliseconds: expiry,
  });

const fixture = () => {
  const destroy = vi.fn();
  const end = vi.fn();
  const stream = () => Object.assign(new EventEmitter(), { destroy });
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(stream(), { end }),
    stdout: stream(),
    stderr: stream(),
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
  const spawn = vi.fn(() => child as MacosSecurityChild);
  return {
    child,
    spawn,
    destroy,
    end,
    execute: createMacosSecurityCommandExecutorForTesting(spawn),
  };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("macOS credential mutation caller cutoff", () => {
  it.each([
    "createPending",
    "activate",
    "removePending",
    "removeOwned",
  ] as const)(
    "forwards the same expiry through the actual %s command without argv secrets",
    async (kind) => {
      vi.spyOn(performance, "now").mockReturnValue(100);
      const native = fixture();
      const captured: MacosKeychainCommand[] = [];
      const registry = compileCredentialBackendRegistry([
        createMacosKeychainCredentialAdapterForTesting({
          platform: "darwin",
          execute: (value) => {
            captured.push(value);
            return native.execute(value);
          },
        }),
      ]);
      const implementation = getStoredCredentialImplementation(
        registry,
        "macos-keychain",
      );
      const ownership = createCredentialOwnership({
        destinationType: "@agentscope/destination-example",
        connectionId: `destination-connection-v1-${"a".repeat(64)}`,
        slot: "api-key",
      });
      const generationId = `credential-generation-v1-${"b".repeat(64)}`;
      const reference = deriveStoredCredentialReference(
        "macos-keychain",
        ownership,
        generationId,
      );
      const boundary = {
        signal: new AbortController().signal,
        expiresAtMonotonicMilliseconds: 1_100,
      };
      const pending =
        kind === "createPending"
          ? implementation.createPending({
              ownership,
              generationId,
              secret: "CANARY",
              ...boundary,
            })
          : kind === "removeOwned"
            ? implementation.removeOwned({ ownership, reference, ...boundary })
            : implementation[kind]({ reference, ...boundary });
      native.child.emit("close", 0);
      expect(await pending).toBeTruthy();
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject(boundary);
      expect(captured[0]?.arguments).not.toContain("CANARY");
      expect(native.end).toHaveBeenCalledWith(
        kind === "createPending" ? "CANARY\nCANARY\n" : undefined,
      );
      expect(native.spawn).toHaveBeenCalledWith(
        "/usr/bin/security",
        captured[0]?.arguments,
        expect.objectContaining({ detached: true }),
      );
    },
  );
});

describe("macOS credential resolution caller cutoff", () => {
  it("propagates the same branded context expiry through the real adapter", async () => {
    vi.spyOn(performance, "now").mockReturnValue(100);
    const captured: MacosKeychainCommand[] = [];
    const native = fixture();
    const registry = compileCredentialBackendRegistry([
      createMacosKeychainCredentialAdapterForTesting({
        platform: "darwin",
        execute: (value) => {
          captured.push(value);
          return native.execute(value);
        },
      }),
    ]);
    const context = createCredentialResolutionContext(
      "hook",
      new AbortController().signal,
      1_100,
    );
    const pending = resolveCredentialReference(
      registry,
      createStoredCredentialReference(
        "macos-keychain",
        `credential-reference-v1-${"a".repeat(64)}`,
        `credential-generation-v1-${"b".repeat(64)}`,
      ),
      context,
    );
    native.child.stdout.emit("data", new TextEncoder().encode("CANARY\n"));
    native.child.emit("close", 0);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.expiresAtMonotonicMilliseconds).toBe(1_100);
    expect(captured[0]?.signal).toBe(context.signal);
    expect(captured[0]?.arguments).not.toContain("CANARY");
  });

  it("preserves success before the inherited work cutoff", async () => {
    vi.spyOn(performance, "now").mockReturnValue(100);
    const value = fixture();
    const pending = value.execute(command());
    value.child.stdout.emit("data", Uint8Array.of(1));
    value.child.emit("close", 0);
    await expect(pending).resolves.toEqual({
      exitCode: 0,
      stdout: Uint8Array.of(1),
      stderr: new Uint8Array(),
    });
    expect(value.child.kill).not.toHaveBeenCalled();
  });

  it("reserves only 100ms within the caller expiry and waits for close", async () => {
    vi.useFakeTimers();
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const value = fixture();
    let settled = false;
    const pending = value.execute(command()).then((result) => {
      settled = true;
      return result;
    });
    now = 1_000;
    await vi.advanceTimersByTimeAsync(900);
    expect(value.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(settled).toBe(false);
    now = 1_050;
    value.child.stdout.emit("data", Uint8Array.of(1));
    value.child.emit("close", 0);
    await expect(pending).resolves.toEqual({
      exitCode: 1,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports uncertainty at the original hard expiry without fresh grace", async () => {
    vi.useFakeTimers();
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const value = fixture();
    const pending = value.execute(command()).catch((error: unknown) => error);
    now = 1_100;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual(
      new Error("core.credential.macos-keychain-join-uncertain"),
    );
    expect(value.destroy).toHaveBeenCalledTimes(3);
    expect(value.child.unref).toHaveBeenCalledOnce();
    value.child.emit("close", 0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("macOS cutoff hostile and delayed boundaries", () => {
  it("refuses process admission when setup consumed the work interval", async () => {
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(100)
      .mockReturnValue(1_000);
    const value = fixture();
    await expect(value.execute(command())).resolves.toHaveProperty(
      "exitCode",
      1,
    );
    expect(value.spawn).not.toHaveBeenCalled();
  });

  it("does not extend a standalone ceiling for a later inherited deadline", async () => {
    vi.useFakeTimers();
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const value = fixture();
    const pending = value
      .execute(command(50_000))
      .catch((error: unknown) => error);
    now = 14_100;
    await vi.advanceTimersByTimeAsync(14_000);
    expect(value.child.kill).toHaveBeenCalledOnce();
    now = 15_100;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual(
      new Error("core.credential.macos-keychain-join-uncertain"),
    );
  });
});

describe("macOS closed cutoff validation", () => {
  it("rejects insufficient or malformed inherited cutoffs before spawn", async () => {
    vi.spyOn(performance, "now").mockReturnValue(100);
    let traps = 0;
    const getter = Object.defineProperty(
      { ...command() },
      "expiresAtMonotonicMilliseconds",
      {
        get: () => {
          traps += 1;
          return 1_100;
        },
      },
    );
    const inherited = Object.assign(
      Object.create({ expiresAtMonotonicMilliseconds: 1_100 }) as object,
      {
        executable: "/usr/bin/security",
        arguments: [],
        signal: command().signal,
      },
    );
    const proxy = new Proxy(command(), {
      get: () => {
        traps += 1;
        throw new Error("CANARY");
      },
      getPrototypeOf: () => {
        traps += 1;
        return null;
      },
    });
    const prototypeProxy: unknown = Object.setPrototypeOf(
      { ...command() },
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor: () => {
            traps += 1;
            throw new Error("CANARY");
          },
        },
      ),
    );
    const coercible = {
      ...command(),
      expiresAtMonotonicMilliseconds: {
        valueOf: () => {
          traps += 1;
          return 1_100;
        },
      },
    };
    for (const input of [
      command(100),
      command(200),
      command(NaN),
      command(Infinity),
      command(-1),
      getter,
      inherited,
      proxy,
      prototypeProxy,
      coercible,
      { ...command(), expiresAtMonotonicMilliseconds: undefined },
      { ...command(), expiresAtMonotonicMilliseconds: "1100" },
    ]) {
      const value = fixture();
      await expect(
        value.execute(input as MacosKeychainCommand),
      ).rejects.toThrow("core.credential.macos-keychain-deadline");
      expect(value.spawn).not.toHaveBeenCalled();
    }
    expect(traps).toBe(0);
  });

  it("refuses stdin if synchronous spawn consumed the remaining work time", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const value = fixture();
    const execute = createMacosSecurityCommandExecutorForTesting(() => {
      now = 1_000;
      return value.child;
    });
    const pending = execute(command());
    expect(value.end).not.toHaveBeenCalled();
    expect(value.child.kill).toHaveBeenCalledOnce();
    value.child.emit("close", 0);
    await expect(pending).resolves.toHaveProperty("exitCode", 1);
  });

  it("rejects a delayed successful close at the hard expiry", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const value = fixture();
    const pending = value.execute(command());
    now = 1_100;
    value.child.emit("close", 0);
    await expect(pending).rejects.toThrow(
      "core.credential.macos-keychain-deadline",
    );
  });
});
