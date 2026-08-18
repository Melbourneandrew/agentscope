import { Buffer } from "node:buffer";

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
  createWindowsCredentialManagerAdapter,
  createWindowsCredentialManagerAdapterForTesting,
  WindowsCredentialManagerError,
  type WindowsCredentialCommand,
  type WindowsCredentialCommandResult,
} from "./windows-credential-manager.js";

const generationId = `credential-generation-v1-${"a".repeat(64)}`;
const ownership = createCredentialOwnership({
  destinationType: "@agentscope/destination-example",
  connectionId: `destination-connection-v1-${"b".repeat(64)}`,
  slot: "api-key",
});
const bytes = (value = "") => new TextEncoder().encode(value);
const result = (
  response: unknown,
  exitCode = 0,
): WindowsCredentialCommandResult => ({
  exitCode,
  stdout: bytes(
    typeof response === "string" ? response : JSON.stringify(response),
  ),
  stderr: bytes(),
});

const fixture = (
  respond: (command: WindowsCredentialCommand) => unknown = () => ({
    ok: true,
  }),
) => {
  const commands: WindowsCredentialCommand[] = [];
  const adapter = createWindowsCredentialManagerAdapterForTesting({
    platform: "win32",
    execute: (command) => {
      commands.push(command);
      const response = respond(command);
      return Promise.resolve(
        typeof response === "object" &&
          response !== null &&
          "exitCode" in response
          ? (response as WindowsCredentialCommandResult)
          : result(response),
      );
    },
  });
  const registry = compileCredentialBackendRegistry([adapter]);
  return {
    commands,
    registry,
    implementation: getStoredCredentialImplementation(
      registry,
      "windows-credential-manager",
    ),
  };
};

const reference = (referenceId = `credential-reference-v1-${"c".repeat(64)}`) =>
  createStoredCredentialReference(
    "windows-credential-manager",
    referenceId,
    generationId,
  );

describe("Windows Credential Manager command contract", () => {
  it("constructs the production adapter only on Windows", () => {
    if (process.platform === "win32")
      expect(createWindowsCredentialManagerAdapter()).toBeDefined();
    else
      expect(() => createWindowsCredentialManagerAdapter()).toThrowError(
        WindowsCredentialManagerError,
      );
  });

  it("creates stable ownership and transports Unicode secrets only via stdin", async () => {
    const value = fixture();
    const secret = "秘密🔑\nsecond line";
    const created = await value.implementation.createPending({
      ownership,
      generationId,
      secret,
      signal: new AbortController().signal,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.referenceId).toMatch(
      /^credential-reference-v1-[0-9a-f]{64}$/u,
    );
    const command = value.commands[0]!;
    expect(command.executable).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(command.arguments).toContain("-EncodedCommand");
    expect(command.arguments.join(" ")).not.toContain(secret);
    const request = JSON.parse(command.stdin) as Record<string, string>;
    expect(request.operation).toBe("write");
    expect(request.target).toMatch(
      /^dev\.agentscope\.credentials\.v1:[0-9a-f]{64}$/u,
    );
    expect(Buffer.from(request.secretBase64!, "base64").toString()).toBe(
      secret,
    );
    expect(JSON.stringify(created)).not.toContain(secret);
  });

  it("rejects malformed factories, hostile execution, and oversized values", async () => {
    for (const input of [
      null,
      {
        platform: "linux",
        execute: () => Promise.resolve(result({ ok: true })),
      },
      { platform: "win32", execute: 1 },
    ])
      expect(() =>
        createWindowsCredentialManagerAdapterForTesting(input as never),
      ).toThrowError(WindowsCredentialManagerError);
    const base = {
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
      const adapter = createWindowsCredentialManagerAdapterForTesting({
        platform: "win32",
        execute: () => Promise.resolve(returned as never),
      });
      await expect(
        getStoredCredentialImplementation(
          compileCredentialBackendRegistry([adapter]),
          "windows-credential-manager",
        ).createPending(base),
      ).resolves.toEqual({ ok: false, code: "unavailable" });
    }
    const rejected = createWindowsCredentialManagerAdapterForTesting({
      platform: "win32",
      execute: () => Promise.reject(new Error("CANARY_SECRET")),
    });
    await expect(
      getStoredCredentialImplementation(
        compileCredentialBackendRegistry([rejected]),
        "windows-credential-manager",
      ).createPending(base),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
    const oversized = fixture();
    await expect(
      oversized.implementation.createPending({
        ...base,
        secret: "é".repeat(1_281),
      }),
    ).resolves.toEqual({ ok: false, code: "malformed" });
    expect(oversized.commands).toEqual([]);
  });
});

describe("Windows Credential Manager resolution", () => {
  it("resolves a Unicode secret through the hook-equivalent reference", async () => {
    const secret = "秘密🔑\nsecond line";
    const value = fixture((command) => {
      const request = JSON.parse(command.stdin) as Record<string, string>;
      return request.operation === "read"
        ? { ok: true, secretBase64: Buffer.from(secret).toString("base64") }
        : { ok: true };
    });
    const created = await value.implementation.createPending({
      ownership,
      generationId,
      secret,
      signal: new AbortController().signal,
    });
    if (!created.ok) throw new Error("fixture failed");
    const resolved = await resolveCredentialReference(
      value.registry,
      reference(created.referenceId),
      createCredentialResolutionContext(
        "hook-equivalent",
        new AbortController().signal,
      ),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok)
      expect(readResolvedCredentialForCore(resolved.credential)).toBe(secret);
    expect(JSON.stringify(resolved)).not.toContain(secret);
  });

  it.each(["missing", "locked", "denied", "unavailable", "malformed"] as const)(
    "maps %s without exposing native output",
    async (code) => {
      await expect(
        fixture(() => ({ ok: false, code })).implementation.resolve({
          reference: reference(),
          context: createCredentialResolutionContext(
            "hook-equivalent",
            new AbortController().signal,
          ),
        }),
      ).resolves.toEqual({ ok: false, code });
    },
  );

  it("rejects malformed responses, invalid UTF-8, and aborted work", async () => {
    for (const response of [
      "not-json",
      null,
      [],
      { ok: true },
      { ok: true, extra: true },
      { ok: true, secretBase64: "" },
      {
        ok: true,
        secretBase64: Buffer.alloc(2_561).toString("base64"),
      },
      { ok: true, secretBase64: "YQ=" },
      { ok: true, secretBase64: "/w==" },
      result({ ok: true }, 1),
    ])
      await expect(
        fixture(() => response).implementation.resolve({
          reference: reference(),
          context: createCredentialResolutionContext(
            "hook-equivalent",
            new AbortController().signal,
          ),
        }),
      ).resolves.toMatchObject({ ok: false });
    let calls = 0;
    const value = fixture(() => {
      calls += 1;
      return { ok: true };
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      value.implementation.resolve({
        reference: reference(),
        context: createCredentialResolutionContext(
          "hook-equivalent",
          controller.signal,
        ),
      }),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
    expect(calls).toBe(0);
  });
});

describe("Windows Credential Manager lifecycle operations", () => {
  it("activates, deletes missing items idempotently, and checks ownership", async () => {
    const value = fixture((command) => {
      const operation = (JSON.parse(command.stdin) as Record<string, string>)
        .operation;
      return operation === "delete"
        ? { ok: false, code: "missing" }
        : { ok: true };
    });
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

  it("returns false for malformed references and unavailable operations", async () => {
    const value = fixture(() => ({ ok: false, code: "denied" }));
    const signal = new AbortController().signal;
    await expect(
      value.implementation.activate({ reference: reference(), signal }),
    ).resolves.toBe(false);
    await expect(
      value.implementation.removePending({ reference: reference(), signal }),
    ).resolves.toBe(false);
    const malformed = { backend: "ci-environment" } as never;
    await expect(
      value.implementation.activate({ reference: malformed, signal }),
    ).resolves.toBe(false);
    await expect(
      value.implementation.removePending({ reference: malformed, signal }),
    ).resolves.toBe(false);
  });
});
