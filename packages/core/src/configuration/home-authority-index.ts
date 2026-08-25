import { bindLocalResourceHomeAuthorityForCore } from "@agentscope/destinations-core/core-orchestration";

import { isAgentscopeHome, type AgentscopeHome } from "./home.js";

export const createLocalResourceHomeAuthority = (home: AgentscopeHome) => {
  if (!isAgentscopeHome(home)) throw new AgentscopeHomeAuthorityError();
  return bindLocalResourceHomeAuthorityForCore({
    root: home.root,
    platform: home.platform,
  });
};

export class AgentscopeHomeAuthorityError extends Error {
  readonly code = "core.home-authority.invalid" as const;

  constructor() {
    super("core.home-authority.invalid");
    this.name = "AgentscopeHomeAuthorityError";
  }
}
