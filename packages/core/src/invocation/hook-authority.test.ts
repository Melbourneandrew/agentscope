import { describe, expect, it } from "vitest";

import {
  createHookEntryAuthority,
  createOwnedHookEntryAuthorityForCli,
  resolveOwnedHookHomeForCli,
} from "./hook-authority.js";

describe("owned hook home transfer", () => {
  it("binds an explicit portable root inside the branded entry authority", () => {
    const authority = createOwnedHookEntryAuthorityForCli({
      durationMilliseconds: 2_000,
      homeRoot: "/portable/agentscope-home",
      platform: process.platform,
      startedAt: performance.now(),
    });

    expect(resolveOwnedHookHomeForCli(authority)).toMatchObject({
      root: "/portable/agentscope-home",
      platform: process.platform,
    });
  });

  it("rejects ordinary and structurally substituted authorities", () => {
    const ordinary = createHookEntryAuthority({
      durationMilliseconds: 2_000,
      startedAt: performance.now(),
    });
    expect(() => resolveOwnedHookHomeForCli(ordinary)).toThrow(
      "core.hook-authority.invalid",
    );
    expect(() =>
      resolveOwnedHookHomeForCli(Object.freeze({}) as never),
    ).toThrow("core.hook-authority.invalid");
  });
});
