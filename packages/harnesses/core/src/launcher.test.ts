import { describe, expect, it } from "vitest";

import {
  HARNESS_HOOK_CONTRACT_VERSION,
  HarnessLauncherError,
  createOwnedHarnessHookInvocation,
  isOwnedHarnessHookInvocation,
} from "./launcher.js";

describe("owned harness launcher contract", () => {
  it("binds one deterministic zero-argument launcher without a payload", () => {
    const invocation = createOwnedHarnessHookInvocation({
      agentscopeHome: "/opt/agentscope",
      harnessType: "@agentscope/harness-codex",
      hookDeadlineMilliseconds: 2_000,
      platform: "posix",
    });
    expect(invocation.contractVersion).toBe(HARNESS_HOOK_CONTRACT_VERSION);
    expect(invocation.arguments).toEqual([]);
    expect(invocation.launcherPath).toMatch(
      /^\/opt\/agentscope\/bin\/agentscope-hook-v1-[a-f0-9]{64}-d2000$/u,
    );
    expect(invocation.ownershipIdentity).toMatch(
      /^agentscope-hook-v1-sha256-[0-9a-f]{64}$/u,
    );
    expect(isOwnedHarnessHookInvocation(invocation)).toBe(true);
    expect(
      createOwnedHarnessHookInvocation({
        agentscopeHome: "/opt/agentscope",
        harnessType: "@agentscope/harness-codex",
        hookDeadlineMilliseconds: 2_000,
        platform: "win32",
      }).launcherPath,
    ).toMatch(/\.exe$/u);
  });

  it("rejects shell-shaped, forged, accessor, oversized, and relative inputs", () => {
    const valid = {
      agentscopeHome: "/opt/agentscope",
      harnessType: "@agentscope/harness-codex",
      hookDeadlineMilliseconds: 2_000,
      platform: "posix" as const,
    };
    for (const input of [
      { ...valid, agentscopeHome: "agentscope" },
      { ...valid, harnessType: "codex; rm" },
      { ...valid, hookDeadlineMilliseconds: 49 },
      { ...valid, hookDeadlineMilliseconds: 60_001 },
      { ...valid, platform: "linux" },
      { ...valid, contextEvidence: new Uint8Array() },
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
  });
});
