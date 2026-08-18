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
  createLinuxSecretServiceAdapter,
  createLinuxSecretServiceAdapterForTesting,
  linuxSecretServiceSessionIsAvailableForTesting,
  LinuxSecretServiceError,
  type LinuxSecretServiceCommand,
  type LinuxSecretServiceCommandResult,
} from "./linux-secret-service.js";

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
): LinuxSecretServiceCommandResult => ({ exitCode, stdout: bytes(stdout) });
const fixture = (
  respond: (command: LinuxSecretServiceCommand) => unknown = () => result(0),
  sessionAvailable = true,
) => {
  const commands: LinuxSecretServiceCommand[] = [];
  const adapter = createLinuxSecretServiceAdapterForTesting({
    platform: "linux",
    sessionAvailable,
    execute: (command) => {
      commands.push(command);
      return Promise.resolve(
        respond(command) as LinuxSecretServiceCommandResult,
      );
    },
  });
  const registry = compileCredentialBackendRegistry([adapter]);
  return {
    commands,
    registry,
    implementation: getStoredCredentialImplementation(
      registry,
      "linux-secret-service",
    ),
  };
};
const reference = (referenceId = `credential-reference-v1-${"c".repeat(64)}`) =>
  createStoredCredentialReference(
    "linux-secret-service",
    referenceId,
    generationId,
  );

describe("Linux Secret Service command contract", () => {
  it("constructs the production adapter only on Linux", () => {
    if (process.platform === "linux")
      expect(createLinuxSecretServiceAdapter()).toBeDefined();
    else
      expect(() => createLinuxSecretServiceAdapter()).toThrowError(
        LinuxSecretServiceError,
      );
  });

  it("creates a stable pending item with the secret only on stdin", async () => {
    const value = fixture();
    const created = await value.implementation.createPending({
      ownership,
      generationId,
      secret: "CANARY_秘密",
      signal: new AbortController().signal,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const command = value.commands[0]!;
    expect(command.executable).toBe("/usr/bin/secret-tool");
    expect(command.operation).toBe("store");
    expect(command.arguments).toEqual([
      "store",
      expect.stringMatching(/^--label=Agentscope [0-9a-f]{12}$/u),
      "service",
      "dev.agentscope.credentials.v1",
      "reference",
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    ]);
    expect(command.arguments.join(" ")).not.toContain("CANARY_秘密");
    expect(command.stdin).toBe("CANARY_秘密\n");
    expect(JSON.stringify(created)).not.toContain("CANARY_秘密");
  });

  it("rejects malformed factories, newline secrets, and hostile executors", async () => {
    for (const input of [
      null,
      { platform: "darwin", sessionAvailable: true, execute: () => result(0) },
      { platform: "linux", sessionAvailable: 1, execute: () => result(0) },
      { platform: "linux", sessionAvailable: true, execute: 1 },
    ])
      expect(() =>
        createLinuxSecretServiceAdapterForTesting(input as never),
      ).toThrowError(LinuxSecretServiceError);
    const base = {
      ownership,
      generationId,
      secret: "secret",
      signal: new AbortController().signal,
    };
    for (const returned of [
      null,
      {},
      { exitCode: -1, stdout: bytes() },
      { exitCode: 0, stdout: new Uint8Array(16_385) },
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("CANARY_SECRET");
          },
        },
      ),
    ])
      await expect(
        fixture(() => returned).implementation.createPending(base),
      ).resolves.toEqual({ ok: false, code: "unavailable" });
    await expect(
      getStoredCredentialImplementation(
        compileCredentialBackendRegistry([
          createLinuxSecretServiceAdapterForTesting({
            platform: "linux",
            sessionAvailable: true,
            execute: () => Promise.reject(new Error("CANARY_SECRET")),
          }),
        ]),
        "linux-secret-service",
      ).createPending(base),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
    await expect(
      fixture(() => result(51)).implementation.createPending(base),
    ).resolves.toEqual({ ok: false, code: "locked" });
    const newline = fixture();
    await expect(
      newline.implementation.createPending({ ...base, secret: "one\ntwo" }),
    ).resolves.toEqual({ ok: false, code: "malformed" });
    expect(newline.commands).toEqual([]);
    const aborted = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      aborted.implementation.createPending({
        ...base,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
    expect(aborted.commands).toEqual([]);
  });
});

describe("Linux Secret Service session detection", () => {
  it("recognizes only a bounded own data D-Bus session address", () => {
    expect(
      linuxSecretServiceSessionIsAvailableForTesting({
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      }),
    ).toBe(true);
    for (const environment of [
      {},
      { DBUS_SESSION_BUS_ADDRESS: "" },
      { DBUS_SESSION_BUS_ADDRESS: 1 },
      { DBUS_SESSION_BUS_ADDRESS: "x".repeat(4_097) },
      Object.defineProperty({}, "DBUS_SESSION_BUS_ADDRESS", {
        get: () => "CANARY_SECRET",
      }),
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor: () => {
            throw new Error();
          },
        },
      ),
    ])
      expect(linuxSecretServiceSessionIsAvailableForTesting(environment)).toBe(
        false,
      );
  });
});

describe("Linux Secret Service resolution and headless policy", () => {
  it("resolves through the hook-equivalent session without serialization", async () => {
    const value = fixture((command) =>
      command.operation === "lookup" ? result(0, "CANARY_秘密\n") : result(0),
    );
    const resolved = await resolveCredentialReference(
      value.registry,
      reference(),
      createCredentialResolutionContext(
        "hook-equivalent",
        new AbortController().signal,
      ),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok)
      expect(readResolvedCredentialForCore(resolved.credential)).toBe(
        "CANARY_秘密",
      );
    expect(JSON.stringify(resolved)).not.toContain("CANARY_秘密");
  });

  it.each([
    [44, "missing"],
    [51, "locked"],
    [36, "denied"],
    [1, "unavailable"],
  ] as const)("maps exit %i to %s", async (exitCode, code) => {
    await expect(
      fixture(() => result(exitCode)).implementation.resolve({
        reference: reference(),
        context: createCredentialResolutionContext(
          "hook-equivalent",
          new AbortController().signal,
        ),
      }),
    ).resolves.toEqual({ ok: false, code });
  });

  it("fails safely without a D-Bus session and never invokes secret-tool", async () => {
    const value = fixture(() => {
      throw new Error("must not execute");
    }, false);
    const signal = new AbortController().signal;
    await expect(
      value.implementation.createPending({
        ownership,
        generationId,
        secret: "secret",
        signal,
      }),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
    await expect(
      value.implementation.resolve({
        reference: reference(),
        context: createCredentialResolutionContext("hook-equivalent", signal),
      }),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
    await expect(
      value.implementation.activate({ reference: reference(), signal }),
    ).resolves.toBe(false);
    await expect(
      value.implementation.removePending({ reference: reference(), signal }),
    ).resolves.toBe(false);
    expect(value.commands).toEqual([]);
  });

  it("rejects empty/malformed UTF-8, malformed references, and abort", async () => {
    for (const returned of [
      result(0),
      { exitCode: 0, stdout: Uint8Array.of(0xff) },
    ])
      await expect(
        fixture(() => returned).implementation.resolve({
          reference: reference(),
          context: createCredentialResolutionContext(
            "hook-equivalent",
            new AbortController().signal,
          ),
        }),
      ).resolves.toEqual({ ok: false, code: "malformed" });
    await expect(
      fixture().implementation.resolve({
        reference: { backend: "ci-environment" } as never,
        context: createCredentialResolutionContext(
          "hook-equivalent",
          new AbortController().signal,
        ),
      }),
    ).resolves.toEqual({ ok: false, code: "malformed" });
    const controller = new AbortController();
    controller.abort();
    const aborted = fixture();
    await expect(
      aborted.implementation.resolve({
        reference: reference(),
        context: createCredentialResolutionContext(
          "hook-equivalent",
          controller.signal,
        ),
      }),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
    expect(aborted.commands).toEqual([]);
  });
});

describe("Linux Secret Service activation and cleanup", () => {
  it("activates, removes missing items idempotently, and checks ownership", async () => {
    const value = fixture((command) =>
      command.operation === "clear" ? result(44) : result(0, "secret\n"),
    );
    const created = await value.implementation.createPending({
      ownership,
      generationId,
      secret: "secret",
      signal: new AbortController().signal,
    });
    if (!created.ok) throw new Error("fixture failed");
    const stored = reference(created.referenceId);
    const signal = new AbortController().signal;
    await expect(
      value.implementation.activate({ reference: stored, signal }),
    ).resolves.toBe(true);
    await expect(
      value.implementation.removePending({ reference: stored, signal }),
    ).resolves.toBe(true);
    await expect(
      value.implementation.removeOwned({
        ownership,
        reference: stored,
        signal,
      }),
    ).resolves.toBe(true);
    await expect(
      value.implementation.removeOwned({
        ownership: createCredentialOwnership({
          destinationType: ownership.destinationType,
          connectionId: ownership.connectionId,
          slot: "other",
        }),
        reference: stored,
        signal,
      }),
    ).resolves.toBe(false);
  });

  it("returns false for unavailable and malformed cleanup", async () => {
    const value = fixture(() => result(1));
    const signal = new AbortController().signal;
    await expect(
      value.implementation.activate({ reference: reference(), signal }),
    ).resolves.toBe(false);
    await expect(
      value.implementation.removePending({ reference: reference(), signal }),
    ).resolves.toBe(false);
    await expect(
      value.implementation.activate({
        reference: { backend: "ci-environment" } as never,
        signal,
      }),
    ).resolves.toBe(false);
    await expect(
      value.implementation.removePending({
        reference: { backend: "ci-environment" } as never,
        signal,
      }),
    ).resolves.toBe(false);
  });
});
