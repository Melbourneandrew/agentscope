import { describe, expect, it } from "vitest";

import {
  compileCredentialBackendRegistry,
  createCredentialOwnership,
  createCredentialResolutionContext,
  createStoredCredentialReference,
  getStoredCredentialImplementation,
  readResolvedCredentialForCore,
  resolveCredentialReference,
} from "./credential-adapter.js";
import {
  createMacosKeychainCredentialAdapter,
  createMacosKeychainCredentialAdapterForTesting,
  MacosKeychainAdapterError,
  type MacosKeychainCommand,
  type MacosKeychainCommandResult,
} from "./macos-keychain.js";

const generationId = `credential-generation-v1-${"a".repeat(64)}`;
const ownership = createCredentialOwnership({
  destinationType: "@agentscope/destination-example",
  connectionId: `destination-connection-v1-${"b".repeat(64)}`,
  slot: "api-key",
});
const bytes = (value = "") => new TextEncoder().encode(value);
const result = (
  exitCode: number,
  stdout = "",
  stderr = "",
): MacosKeychainCommandResult => ({
  exitCode,
  stdout: bytes(stdout),
  stderr: bytes(stderr),
});

const fixture = (
  respond: (command: MacosKeychainCommand) => MacosKeychainCommandResult = () =>
    result(0),
) => {
  const commands: MacosKeychainCommand[] = [];
  const adapter = createMacosKeychainCredentialAdapterForTesting({
    platform: "darwin",
    execute: (command) => {
      commands.push(command);
      return Promise.resolve(respond(command));
    },
  });
  const registry = compileCredentialBackendRegistry([adapter]);
  return {
    commands,
    registry,
    implementation: getStoredCredentialImplementation(
      registry,
      "macos-keychain",
    ),
  };
};

describe("macOS Keychain command construction", () => {
  it("constructs the production adapter only on macOS", () => {
    if (process.platform === "darwin")
      expect(createMacosKeychainCredentialAdapter()).toBeDefined();
    else
      expect(() => createMacosKeychainCredentialAdapter()).toThrowError(
        MacosKeychainAdapterError,
      );
  });

  it("creates a stable pending reference and keeps the secret out of argv", async () => {
    const value = fixture();
    const created = await value.implementation.createPending({
      ownership,
      generationId,
      secret: "CANARY_SECRET",
      signal: new AbortController().signal,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.referenceId).toMatch(
      /^credential-reference-v1-[0-9a-f]{64}$/u,
    );
    const command = value.commands[0]!;
    expect(command.executable).toBe("/usr/bin/security");
    expect(command.arguments.at(0)).toBe("add-generic-password");
    expect(command.arguments.at(-1)).toBe("-w");
    expect(command.arguments.join(" ")).not.toContain("CANARY_SECRET");
    expect(command.stdin).toBe("CANARY_SECRET\n");
    expect(JSON.stringify(created)).not.toContain("CANARY_SECRET");
  });

  it("rejects unsupported platforms and malformed factories", () => {
    for (const input of [
      null,
      { platform: "linux", execute: () => Promise.resolve(result(0)) },
      { platform: "darwin", execute: 1 },
    ])
      expect(() =>
        createMacosKeychainCredentialAdapterForTesting(input as never),
      ).toThrowError(MacosKeychainAdapterError);
  });

  it("contains command failures and hostile result records", async () => {
    const baseInput = {
      ownership,
      generationId,
      secret: "secret",
      signal: new AbortController().signal,
    };
    for (const returned of [
      null,
      {},
      { exitCode: -1, stdout: bytes(), stderr: bytes() },
      { exitCode: 0, stdout: new Uint8Array(16_385), stderr: bytes() },
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("CANARY_SECRET");
          },
        },
      ),
    ]) {
      const adapter = createMacosKeychainCredentialAdapterForTesting({
        platform: "darwin",
        execute: () => Promise.resolve(returned as never),
      });
      await expect(
        getStoredCredentialImplementation(
          compileCredentialBackendRegistry([adapter]),
          "macos-keychain",
        ).createPending(baseInput),
      ).resolves.toEqual({ ok: false, code: "unavailable" });
    }
    const rejected = createMacosKeychainCredentialAdapterForTesting({
      platform: "darwin",
      execute: () => Promise.reject(new Error("CANARY_SECRET")),
    });
    await expect(
      getStoredCredentialImplementation(
        compileCredentialBackendRegistry([rejected]),
        "macos-keychain",
      ).createPending(baseInput),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
    await expect(
      fixture(() => result(36)).implementation.createPending(baseInput),
    ).resolves.toEqual({ ok: false, code: "denied" });
    const newline = fixture();
    await expect(
      newline.implementation.createPending({
        ...baseInput,
        secret: "line-one\nline-two",
      }),
    ).resolves.toEqual({ ok: false, code: "malformed" });
    expect(newline.commands).toEqual([]);
  });
});

describe("macOS Keychain resolution", () => {
  it("resolves through the same reference in a hook-equivalent context", async () => {
    const value = fixture((command) =>
      command.arguments[0] === "find-generic-password" &&
      command.arguments.at(-1) === "-w"
        ? result(0, "CANARY_SECRET\n")
        : result(0),
    );
    const created = await value.implementation.createPending({
      ownership,
      generationId,
      secret: "CANARY_SECRET",
      signal: new AbortController().signal,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const reference = createStoredCredentialReference(
      "macos-keychain",
      created.referenceId,
      generationId,
    );
    const resolved = await resolveCredentialReference(
      value.registry,
      reference,
      createCredentialResolutionContext(
        "hook-equivalent",
        new AbortController().signal,
      ),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok)
      expect(readResolvedCredentialForCore(resolved.credential)).toBe(
        "CANARY_SECRET",
      );
    expect(JSON.stringify(resolved)).not.toContain("CANARY_SECRET");
  });

  it.each([
    [44, "missing"],
    [51, "locked"],
    [36, "denied"],
    [1, "unavailable"],
  ] as const)("maps exit %i to %s", async (exitCode, code) => {
    const value = fixture(() => result(exitCode, "", "CANARY_SECRET"));
    await expect(
      value.implementation.resolve({
        reference: createStoredCredentialReference(
          "macos-keychain",
          `credential-reference-v1-${"c".repeat(64)}`,
          generationId,
        ),
        context: createCredentialResolutionContext(
          "hook-equivalent",
          new AbortController().signal,
        ),
      }),
    ).resolves.toEqual({ ok: false, code });
  });

  it("maps malformed UTF-8, hostile results, exceptions, and abort to fixed failures", async () => {
    const reference = createStoredCredentialReference(
      "macos-keychain",
      `credential-reference-v1-${"c".repeat(64)}`,
      generationId,
    );
    const invalidUtf8 = fixture(() => ({
      exitCode: 0,
      stdout: Uint8Array.of(0xff),
      stderr: bytes(),
    }));
    await expect(
      invalidUtf8.implementation.resolve({
        reference,
        context: createCredentialResolutionContext(
          "hook-equivalent",
          new AbortController().signal,
        ),
      }),
    ).resolves.toEqual({ ok: false, code: "malformed" });
    let calls = 0;
    const aborted = createMacosKeychainCredentialAdapterForTesting({
      platform: "darwin",
      execute: () => {
        calls += 1;
        return Promise.reject(new Error("CANARY_SECRET"));
      },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      getStoredCredentialImplementation(
        compileCredentialBackendRegistry([aborted]),
        "macos-keychain",
      ).resolve({
        reference,
        context: createCredentialResolutionContext(
          "hook-equivalent",
          controller.signal,
        ),
      }),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
    expect(calls).toBe(0);
    await expect(
      fixture().implementation.resolve({
        reference: { backend: "ci-environment" } as never,
        context: createCredentialResolutionContext(
          "hook-equivalent",
          new AbortController().signal,
        ),
      }),
    ).resolves.toEqual({ ok: false, code: "malformed" });
    await expect(
      fixture(() => result(0, "secret")).implementation.resolve({
        reference,
        context: createCredentialResolutionContext(
          "hook-equivalent",
          new AbortController().signal,
        ),
      }),
    ).resolves.toEqual({ ok: true, secret: "secret" });
  });
});

describe("macOS Keychain activation and owned deletion", () => {
  it("activates, removes idempotently, and rejects mismatched ownership", async () => {
    const value = fixture((command) =>
      command.arguments[0] === "delete-generic-password"
        ? result(44)
        : result(0),
    );
    const created = await value.implementation.createPending({
      ownership,
      generationId,
      secret: "secret",
      signal: new AbortController().signal,
    });
    if (!created.ok) throw new Error("fixture failed");
    const reference = createStoredCredentialReference(
      "macos-keychain",
      created.referenceId,
      generationId,
    );
    const signal = new AbortController().signal;
    await expect(
      value.implementation.activate({ reference, signal }),
    ).resolves.toBe(true);
    await expect(
      value.implementation.removePending({ reference, signal }),
    ).resolves.toBe(true);
    await expect(
      value.implementation.removeOwned({ ownership, reference, signal }),
    ).resolves.toBe(true);
    await expect(
      value.implementation.removeOwned({
        ownership: createCredentialOwnership({
          destinationType: ownership.destinationType,
          connectionId: ownership.connectionId,
          slot: "other",
        }),
        reference,
        signal,
      }),
    ).resolves.toBe(false);
  });

  it("returns false when existence or deletion cannot be confirmed", async () => {
    const value = fixture(() => result(1));
    const reference = createStoredCredentialReference(
      "macos-keychain",
      `credential-reference-v1-${"c".repeat(64)}`,
      generationId,
    );
    const signal = new AbortController().signal;
    await expect(
      value.implementation.activate({ reference, signal }),
    ).resolves.toBe(false);
    await expect(
      value.implementation.removePending({ reference, signal }),
    ).resolves.toBe(false);
    const malformed = {
      backend: "macos-keychain",
      referenceId: "bad",
      generationId,
    } as never;
    await expect(
      value.implementation.activate({ reference: malformed, signal }),
    ).resolves.toBe(false);
    await expect(
      value.implementation.removePending({ reference: malformed, signal }),
    ).resolves.toBe(false);
  });
});
