import { describe, expect, it } from "vitest";

import {
  CodexConfigurationError,
  createCodexInternalProviderConfiguration,
} from "./configuration.js";
import {
  CODEX_COMPONENT_EVIDENCE_SLOT,
  CODEX_REPRESENTATIVE_VERSION,
  codexHarnessDescriptor,
} from "./descriptor.js";
import { codexHarnessPackageId } from "./index.js";

const disabledFeatures = [
  "apps",
  "collab",
  "connectors",
  "enable_fanout",
  "enable_mcp_apps",
  "executor_capability_discovery",
  "external_agent_memory_import",
  "mcp_2026_07_28",
  "memories",
  "memory_tool",
  "multi_agent",
  "multi_agent_mode",
  "multi_agent_v2",
  "non_prefixed_mcp_tool_names",
  "plugin_hooks",
  "plugin_sharing",
  "plugins",
  "recommended_plugins",
  "remote_plugin",
  "responses_websockets",
  "responses_websockets_v2",
  "search_tool",
  "send_async_message",
  "standalone_web_search",
  "tool_call_mcp_elicitation",
  "tool_registry",
  "tool_search",
  "tool_search_always_defer_mcp_tools",
  "web_search",
  "web_search_cached",
  "web_search_request",
] as const;

describe("Codex descriptor", () => {
  it("pins the documented executable, version output, configuration, and component row", () => {
    expect(codexHarnessPackageId).toBe("@agentscope/harness-codex");
    expect(codexHarnessDescriptor).toMatchObject({
      harnessType: "@agentscope/harness-codex",
      executable: {
        names: ["codex"],
        versionArguments: ["--version"],
        versionPrefix: "codex-cli ",
        versionSuffix: "",
      },
      configuration: {
        locationSegments: [
          [".codex", "hooks.json"],
          [".codex", "config.toml"],
        ],
      },
      compatibility: [
        {
          minimumInclusive: CODEX_REPRESENTATIVE_VERSION,
          maximumExclusive: "0.149.2",
          evidenceSlot: CODEX_COMPONENT_EVIDENCE_SLOT,
        },
      ],
      nativeSource: {
        sourceKind: "codex-hook-json",
        continuityVersion: 1,
      },
    });
  });
});

describe("Codex internal provider configuration", () => {
  it("routes Responses to an unauthenticated loopback endpoint and disables fallbacks", () => {
    const configuration = createCodexInternalProviderConfiguration({
      baseUrl: "http://127.0.0.1:4319/v1",
      model: "component-model",
    });
    expect(configuration).toContain('model = "component-model"');
    expect(configuration).toContain('base_url = "http://127.0.0.1:4319/v1"');
    expect(configuration).toContain('wire_api = "responses"');
    expect(configuration).toContain("requires_openai_auth = false");
    expect(configuration).toContain("check_for_update_on_startup = false");
    expect(configuration).toContain('web_search = "disabled"');
    expect(configuration).toContain("[agents]\nenabled = false");
    expect(configuration).toContain("[apps._default]\nenabled = false");
    expect(configuration).toContain("[mcp_servers]");
    const featureSection = configuration
      .split("[features]\n")[1]
      ?.split("\n\n[mcp_servers]")[0];
    expect(featureSection?.split("\n").sort()).toEqual(
      disabledFeatures.map((feature) => `${feature} = false`).sort(),
    );
    expect(configuration).toContain("request_max_retries = 0");
    expect(configuration).toContain("stream_max_retries = 0");
    expect(configuration).toContain('trace_exporter = "none"');
    expect(configuration).toContain('metrics_exporter = "none"');
    expect(configuration).not.toMatch(/api[_-]?key|authorization|token/iu);
  });

  it.each([
    "http://mockserver:1080/v1",
    "http://localhost:8080/v1",
    "http://[::1]:8080/v1",
  ])("accepts an explicit internal endpoint %s", (baseUrl) => {
    expect(
      createCodexInternalProviderConfiguration({
        baseUrl,
        model: "component-model",
      }),
    ).toContain("requires_openai_auth = false");
  });

  it.each([
    "https://localhost:8080/v1",
    "http://api.openai.com:80/v1",
    "http://arbitrary-host:8080/v1",
    "http://LOCALHOST:8080/v1",
    "http://mockserver.local:8080/v1",
    "http://0.0.0.0:8080/v1",
    "http://127.0.0.2:8080/v1",
    "http://localhost/v1",
    "http://localhost:8080",
    "http://localhost:8080/v1/responses",
    "http://user:pass@localhost:8080/v1",
    "http://localhost:8080/v1?route=public",
    "http://localhost:8080/v1#fragment",
  ])("rejects a non-hermetic endpoint %s", (baseUrl) => {
    expect(() =>
      createCodexInternalProviderConfiguration({
        baseUrl,
        model: "component-model",
      }),
    ).toThrow(CodexConfigurationError);
  });

  it("rejects hostile shapes and model interpolation", () => {
    let reads = 0;
    const accessor = { baseUrl: "http://localhost:8080/v1" } as {
      baseUrl: string;
      model: string;
    };
    Object.defineProperty(accessor, "model", {
      enumerable: true,
      get() {
        reads += 1;
        return "component-model";
      },
    });
    expect(() => createCodexInternalProviderConfiguration(accessor)).toThrow(
      CodexConfigurationError,
    );
    expect(reads).toBe(0);
    expect(() =>
      createCodexInternalProviderConfiguration({
        baseUrl: "http://localhost:8080/v1",
        model: 'model"\nbase_url="https://example.com/v1',
      }),
    ).toThrow(CodexConfigurationError);
    expect(() =>
      createCodexInternalProviderConfiguration({
        baseUrl: "http://localhost:8080/v1",
        model: "component-model",
        extra: true,
      } as never),
    ).toThrow(CodexConfigurationError);
    expect(() =>
      createCodexInternalProviderConfiguration(null as never),
    ).toThrow(CodexConfigurationError);
    expect(() =>
      createCodexInternalProviderConfiguration({
        baseUrl: "not-a-url",
        model: "component-model",
      }),
    ).toThrow(CodexConfigurationError);
  });
});
