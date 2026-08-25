import { resolveLocalResourceHomeAuthority } from "@agentscope/destinations-core";
import { describe, expect, it } from "vitest";

import {
  AgentscopeHomeAuthorityError,
  createLocalResourceHomeAuthority,
} from "./home-authority-index.js";
import { createAgentscopeHomeFromOwnedRootForCore } from "./home.js";

describe("Core local-resource home authority composition", () => {
  it("mints authority only from the exact Core-owned home", () => {
    const home = createAgentscopeHomeFromOwnedRootForCore(
      "/owned/.agentscope",
      "linux",
    );
    const authority = createLocalResourceHomeAuthority(home);

    expect(resolveLocalResourceHomeAuthority(authority)).toEqual({
      root: home.root,
      platform: home.platform,
    });
    expect(() => createLocalResourceHomeAuthority({ ...home })).toThrow(
      AgentscopeHomeAuthorityError,
    );
  });
});
