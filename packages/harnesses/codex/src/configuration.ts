const providerId = "agentscope_internal";
const safeModelPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const trustedInternalHosts = new Set([
  "127.0.0.1",
  "[::1]",
  "localhost",
  "mockserver",
]);
export const CODEX_0_149_1_EXTERNAL_CAPABILITY_SUPPRESSION = Object.freeze({
  representativeVersion: "0.149.1",
  sourceCommit: "ff29a44391deccde0aba0f8390337d7f3c319ea4",
  sourcePath: "codex-rs/features/src/lib.rs",
  sourceSha256:
    "791121524b5269c72254911823b77253cc98121d1dd29608663dd9d73fa7d61a",
  features: Object.freeze([
    "apps",
    "auth_elicitation",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "collab",
    "computer_use",
    "connectors",
    "enable_fanout",
    "enable_mcp_apps",
    "executor_capability_discovery",
    "external_agent_memory_import",
    "image_generation",
    "in_app_browser",
    "in_app_chat",
    "in_app_dictation",
    "in_app_updates",
    "memories",
    "memory_tool",
    "multi_agent",
    "multi_agent_mode",
    "multi_agent_v2",
    "mcp_2026_07_28",
    "non_prefixed_mcp_tool_names",
    "plugin_hooks",
    "plugin_sharing",
    "plugins",
    "recommended_plugins",
    "remote_plugin",
    "remote_compaction_v2",
    "responses_websockets",
    "responses_websockets_v2",
    "search_tool",
    "send_async_message",
    "standalone_web_search",
    "skill_mcp_dependency_install",
    "skill_search",
    "tool_call_mcp_elicitation",
    "tool_registry",
    "tool_search",
    "tool_search_always_defer_mcp_tools",
    "tool_suggest",
    "web_search",
    "web_search_cached",
    "web_search_request",
    "workspace_dependencies",
  ] as const),
});

export class CodexConfigurationError extends Error {
  public readonly code = "codex.configuration.invalid";

  public constructor() {
    super("codex.configuration.invalid");
    this.name = "CodexConfigurationError";
  }
}

const invalid = (): never => {
  throw new CodexConfigurationError();
};

const exactInput = (
  input: Readonly<{ baseUrl: string; model: string }>,
): Readonly<{ baseUrl: string; model: string }> => {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
      Object.keys(descriptors).sort().join("\0") !== "baseUrl\0model" ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor))
    )
      return invalid();
    const baseUrl = descriptors.baseUrl?.value as unknown;
    const model = descriptors.model?.value as unknown;
    if (
      typeof baseUrl !== "string" ||
      typeof model !== "string" ||
      !safeModelPattern.test(model)
    )
      return invalid();
    const parsed = new URL(baseUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== "http:" ||
      !trustedInternalHosts.has(hostname) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port === "" ||
      parsed.pathname !== "/v1" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.href !== baseUrl
    )
      return invalid();
    const port = Number(parsed.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
      return invalid();
    return Object.freeze({ baseUrl: parsed.href, model });
  } catch (error) {
    if (error instanceof CodexConfigurationError) throw error;
    return invalid();
  }
};

export const createCodexInternalProviderConfiguration = (
  input: Readonly<{ baseUrl: string; model: string }>,
): string => {
  const parsed = exactInput(input);
  return [
    `model = ${JSON.stringify(parsed.model)}`,
    `model_provider = ${JSON.stringify(providerId)}`,
    "check_for_update_on_startup = false",
    'web_search = "disabled"',
    "",
    "[agents]",
    "enabled = false",
    "",
    "[analytics]",
    "enabled = false",
    "",
    "[feedback]",
    "enabled = false",
    "",
    "[otel]",
    "log_user_prompt = false",
    'trace_exporter = "none"',
    'metrics_exporter = "none"',
    "",
    "[apps._default]",
    "enabled = false",
    "destructive_enabled = false",
    "open_world_enabled = false",
    "",
    "[features]",
    ...CODEX_0_149_1_EXTERNAL_CAPABILITY_SUPPRESSION.features.map(
      (feature) => `${feature} = false`,
    ),
    "",
    "[mcp_servers]",
    "",
    `[model_providers.${providerId}]`,
    'name = "Agentscope internal model"',
    `base_url = ${JSON.stringify(parsed.baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "",
  ].join("\n");
};
