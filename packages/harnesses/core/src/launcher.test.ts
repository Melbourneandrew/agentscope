import { describe, expect, it } from "vitest";

import {
  HARNESS_HOOK_COMMAND,
  HARNESS_HOOK_CONTRACT_VERSION,
  HarnessLauncherError,
  createOwnedHarnessHookInvocation,
  isOwnedHarnessHookInvocation,
  readOwnedHarnessHookInvocationForCore,
} from "./launcher.js";

describe("owned harness launcher contract", () => {
  it("binds one absolute executable and separately encoded versioned arguments", () => {
    const evidence = new TextEncoder().encode("bounded-context");
    const invocation = createOwnedHarnessHookInvocation({
      executablePath: "/opt/agentscope/bin/agentscope",
      harnessType: "@agentscope/harness-codex",
      contextEvidence: evidence,
    });
    evidence.fill(0);
    expect(invocation.contractVersion).toBe(HARNESS_HOOK_CONTRACT_VERSION);
    expect(invocation.arguments).toEqual([
      HARNESS_HOOK_COMMAND,
      "--contract-version",
      "1",
      "--harness",
      "@agentscope/harness-codex",
    ]);
    expect(invocation.executablePath).toBe("/opt/agentscope/bin/agentscope");
    expect(invocation.ownershipIdentity).toMatch(
      /^agentscope-hook-v1-sha256-[0-9a-f]{64}$/u,
    );
    expect(new TextDecoder().decode(invocation.contextEvidence)).toBe(
      "bounded-context",
    );
    expect(isOwnedHarnessHookInvocation(invocation)).toBe(true);
    const read = readOwnedHarnessHookInvocationForCore(invocation);
    read.contextEvidence.fill(0);
    expect(new TextDecoder().decode(invocation.contextEvidence)).toBe(
      "bounded-context",
    );
  });

  it("rejects shell-shaped, forged, accessor, oversized, and relative inputs", () => {
    const valid = {
      executablePath: "/opt/agentscope/bin/agentscope",
      harnessType: "@agentscope/harness-codex",
      contextEvidence: new Uint8Array(),
    };
    for (const input of [
      { ...valid, executablePath: "agentscope" },
      { ...valid, harnessType: "codex; rm" },
      { ...valid, contextEvidence: new Uint8Array(65_537) },
      { ...valid, contextEvidence: Buffer.from("buffer") },
      {
        ...valid,
        contextEvidence: Object.assign(new Uint8Array([1]), { extra: true }),
      },
      { ...valid, contextEvidence: new Proxy(new Uint8Array([1]), {}) },
      {
        ...valid,
        contextEvidence: new (class extends Uint8Array {})([1]),
      },
      { ...valid, extra: true },
      Object.defineProperty({ ...valid }, "harnessType", {
        get: () => valid.harnessType,
      }),
      Object.create(null) as object,
      [],
      null,
    ])
      expect(() =>
        createOwnedHarnessHookInvocation(
          input as Parameters<typeof createOwnedHarnessHookInvocation>[0],
        ),
      ).toThrow(HarnessLauncherError);
    expect(isOwnedHarnessHookInvocation({ ...valid })).toBe(false);
    expect(() =>
      readOwnedHarnessHookInvocationForCore({ ...valid } as never),
    ).toThrow(HarnessLauncherError);
  });
});
