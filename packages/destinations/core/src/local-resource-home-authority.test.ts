import { describe, expect, it } from "vitest";

import { bindLocalResourceHomeAuthorityForTesting } from "./testing.js";
import {
  LocalResourceHomeAuthorityError,
  resolveLocalResourceHomeAuthority,
} from "./index.js";

describe("local resource home authority", () => {
  it("resolves only the exact process-minted authority", () => {
    const home = Object.freeze({
      root: "/owned/.agentscope",
      platform: "linux" as const,
    });
    const authority = bindLocalResourceHomeAuthorityForTesting(home);
    expect(resolveLocalResourceHomeAuthority(authority)).toEqual(home);
    expect(() => resolveLocalResourceHomeAuthority({ ...authority })).toThrow(
      LocalResourceHomeAuthorityError,
    );
  });

  it("rejects getters and hostile reflection without invoking content", () => {
    let calls = 0;
    const accessor = Object.defineProperty({ platform: "linux" }, "root", {
      enumerable: true,
      get() {
        calls += 1;
        return "/owned/.agentscope";
      },
    });
    expect(() =>
      bindLocalResourceHomeAuthorityForTesting(accessor as never),
    ).toThrow(LocalResourceHomeAuthorityError);
    expect(calls).toBe(0);
    expect(() =>
      bindLocalResourceHomeAuthorityForTesting(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("SYNTHETIC_HOME_CANARY");
            },
          },
        ) as never,
      ),
    ).toThrow("destination.local-resource-home.invalid");
  });
});
