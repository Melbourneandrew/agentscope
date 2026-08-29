import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import {
  CODEX_0_149_1_EXTERNAL_CAPABILITY_SUPPRESSION,
  CodexConfigurationError,
  createCodexInternalProviderConfiguration,
} from "./configuration.js";
import {
  CODEX_COMPONENT_EVIDENCE_SLOT,
  CODEX_REPRESENTATIVE_VERSION,
  codexHarnessDescriptor,
} from "./descriptor.js";
import { codexHarnessPackageId } from "./index.js";

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

it("pins the upstream 0.149.1 external capability registry authority", () => {
  expect(CODEX_0_149_1_EXTERNAL_CAPABILITY_SUPPRESSION).toMatchObject({
    representativeVersion: "0.149.1",
    sourceCommit: "ff29a44391deccde0aba0f8390337d7f3c319ea4",
    sourcePath: "codex-rs/features/src/lib.rs",
    sourceSha256:
      "791121524b5269c72254911823b77253cc98121d1dd29608663dd9d73fa7d61a",
  });
  expect(CODEX_0_149_1_EXTERNAL_CAPABILITY_SUPPRESSION.features).toEqual(
    expect.arrayContaining([
      "auth_elicitation",
      "browser_use",
      "browser_use_external",
      "browser_use_full_cdp_access",
      "computer_use",
      "in_app_browser",
      "in_app_updates",
      "skill_mcp_dependency_install",
      "unbounded_connection_retries",
      "workspace_dependencies",
    ]),
  );
  expect(
    createHash("sha256")
      .update(CODEX_0_149_1_EXTERNAL_CAPABILITY_SUPPRESSION.features.join("\n"))
      .digest("hex"),
  ).toBe("d2ec2685df722cf37f717a2e0d3fd689327b5b984d66da0cfdba943024ab8c2f");
});

describe("Codex configuration prototype boundary", () => {
  it("emits the complete suppression inventory without inherited array callbacks", () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "map");
    const previousNumeric = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "27",
    );
    let numericSetterCalls = 0;
    let configuration: string;
    Object.defineProperty(Array.prototype, "map", {
      value: () => [],
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Array.prototype, "27", {
      set() {
        numericSetterCalls += 1;
      },
      configurable: true,
    });
    try {
      configuration = createCodexInternalProviderConfiguration({
        baseUrl: "http://127.0.0.1:4319/v1",
        model: "component-model",
      });
    } finally {
      if (previous === undefined)
        delete (Array.prototype as { map?: unknown }).map;
      else Object.defineProperty(Array.prototype, "map", previous);
      if (previousNumeric === undefined)
        Reflect.deleteProperty(Array.prototype, "27");
      else Object.defineProperty(Array.prototype, "27", previousNumeric);
    }
    expect(numericSetterCalls).toBe(0);
    for (const feature of CODEX_0_149_1_EXTERNAL_CAPABILITY_SUPPRESSION.features)
      expect(configuration).toContain(`${feature} = false`);
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
      CODEX_0_149_1_EXTERNAL_CAPABILITY_SUPPRESSION.features
        .map((feature) => `${feature} = false`)
        .sort(),
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
