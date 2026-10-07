import { describe, expect, it } from "vitest";
import { normalizeClaudeCatalogEntry } from "../claude-catalog-entry.js";

const hooks = { Stop: [{ hooks: [{ type: "command", command: "" }] }] };
const normalize = (fields: Record<string, unknown> = {}) =>
  normalizeClaudeCatalogEntry({
    name: "plugin",
    source: "./plugin",
    hooks,
    ...fields,
  });
const stub = {
  name: "plugin",
  source: { source: "unsupported" },
  strict: true,
};

describe("pinned Claude whole catalog entries", () => {
  it("strips unknown keys and preserves genuine empty string and dot edges", () => {
    expect(
      normalize({ source: ".", version: "", headersHelper: "", unknown: 1 }),
    ).toEqual({
      name: "plugin",
      source: "./",
      version: "",
      headersHelper: "",
      strict: true,
      hooks: { Stop: [{ hooks: [{ type: "command", command: "" }] }] },
    });
    expect(normalize({ name: "tab\tname" })?.name).toBe("tab\tname");
    expect(normalize({ name: "has space" })).toBeUndefined();
    expect(normalizeClaudeCatalogEntry({ source: "./" })).toBeUndefined();
  });
  it("drops caught nonrecord fields but stubs malformed recognized records", () => {
    for (const field of ["metadata", "relevance", "experimental"])
      expect(normalize({ [field]: false })).toMatchObject({
        hooks,
        strict: true,
      });
    expect(normalize({ relevance: { topic: 1 } })).toEqual(stub);
    expect(normalize({ experimental: { arbitrary: 3 } })?.experimental).toEqual(
      { arbitrary: 3 },
    );
    expect(
      normalize({
        source: { source: "unsupported", error: "vendor diagnostic" },
      })?.source,
    ).toEqual({ source: "unsupported" });
  });
  it.each([
    { author: { name: "" } },
    { homepage: "not-url" },
    { keywords: [2] },
    { defaultEnabled: 1 },
    { dependencies: ["bad/name"] },
    { headers: { x: 1 } },
    { headersHelper: "four    spaces" },
    { category: 1 },
    { tags: [1] },
    { strict: null },
    { commands: { x: { source: "./cmd", content: "both" } } },
    { agents: "./not-markdown" },
    { skills: "bare" },
    { outputStyles: ["bare"] },
    { themes: 1 },
    { workflows: false },
    {
      userConfig: { "bad-key": { type: "string", title: "", description: "" } },
    },
    { channels: [{ server: "x", unknown: true }] },
    { settings: [] },
    {
      lspServers: {
        x: { command: "has space", extensionToLanguage: { ".ts": "ts" } },
      },
    },
    {
      monitors: [
        { name: "x", command: "x", description: "x" },
        { name: "x", command: "x", description: "x" },
      ],
    },
    { experimental: { syntaxHighlighting: { hljsLanguages: [{ id: "A" }] } } },
  ])(
    "stubs a malformed recognized field without retaining catalog hooks: %j",
    (fields) => {
      expect(normalize(fields)).toEqual(stub);
    },
  );
});

describe("pinned component metadata projection", () => {
  it("normalizes every metadata/component family without extra eligibility rules", () => {
    const result = normalize({
      $schema: "",
      displayName: "",
      description: "",
      repository: "",
      license: "",
      author: { name: "author", email: "not-email", url: "not-url", extra: 1 },
      homepage: "https://example.com",
      keywords: [""],
      defaultEnabled: false,
      metadata: { free: [1] },
      dependencies: [
        "plugin@market@^1",
        { name: "p", marketplace: "m", extra: 2 },
      ],
      commands: {
        emptyContent: { source: "./commands", content: "" },
        inline: { content: "value", allowedTools: [""] },
      },
      agents: ["./a.md"],
      skills: ".",
      outputStyles: "./styles",
      themes: ["./themes"],
      workflows: "./flows",
      userConfig: {
        key: {
          type: "file",
          title: "",
          description: "",
          default: [""],
          min: -1,
        },
      },
      channels: [
        {
          server: "x",
          userConfig: {
            "not-identifier": { type: "number", title: "", description: "" },
          },
        },
      ],
      settings: { arbitrary: null },
      lspServers: {
        x: {
          command: "/path with spaces",
          extensionToLanguage: { ".x": "x" },
          retainedUnknown: 1,
        },
      },
      monitors: [
        { name: "x", command: "x", description: "x", retainedUnknown: 1 },
      ],
      binaries: {
        executable: { sha256: "a".repeat(64), extra: 1 },
        Bad: { sha256: "b".repeat(64) },
        bad: {},
      },
      relevance: {
        topic: "",
        signals: {
          hosts: ["Not/a/bare/HOST"],
          manifestDeps: [{ file: "[", pattern: "[" }],
        },
      },
      experimental: { evals: "not-relative", extra: true },
    });
    expect(result?.source).toBe("./plugin");
    expect(result?.dependencies).toEqual(["plugin@market", "p@m"]);
    expect(result?.author).toEqual({
      name: "author",
      email: "not-email",
      url: "not-url",
    });
    expect(result?.binaries).toEqual({
      executable: { sha256: "a".repeat(64) },
    });
    expect(result?.lspServers).toMatchObject({ x: { transport: "stdio" } });
    expect(result?.lspServers).toMatchObject({ x: { retainedUnknown: 1 } });
    expect(result?.monitors).toEqual([
      {
        name: "x",
        command: "x",
        description: "x",
        retainedUnknown: 1,
        when: "always",
      },
    ]);
    expect(result?.experimental).toEqual({
      evals: "not-relative",
      extra: true,
    });
  });
  it("filters binaries rather than stubbing and caps valid entries at 64", () => {
    expect(normalize({ binaries: 1 })?.hooks).toEqual(hooks);
    const value = Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [
        `bin${index}`,
        { sha256: "a".repeat(64) },
      ]),
    );
    expect(
      Object.keys(normalize({ binaries: value })?.binaries as object),
    ).toHaveLength(64);
  });
});

describe("pinned source, hook and MCP normalization", () => {
  it.each([
    { source: "github", repo: "" },
    { source: "url", url: "git@host" },
    { source: "npm", package: "", version: "" },
    { source: "npm", package: "file:../local" },
    { source: "git-subdir", url: "", path: "x" },
    { source: "command", command: "x", timeout: 600 },
    {
      source: "archive",
      url: "https://example.com/plugin.zip",
      sha256: "A".repeat(64),
    },
  ])("preserves valid source without acquisition: %j", (source) => {
    expect(normalize({ source })?.source).toEqual(source);
  });
  it.each([
    { source: "unknown" },
    { source: "npm", package: "../p" },
    { source: "github", repo: "x", sha: "A".repeat(40) },
    { source: "command", command: "x", timeout: 601 },
    { source: "archive", url: "http://example.com/a" },
    { source: "archive", url: "https://127.0.0.1/a" },
    { source: "git-subdir", url: "valid", path: "" },
    { source: "archive", url: "not-a-url" },
  ])("stubs invalid source: %j", (source) => {
    expect(normalize({ source })).toEqual(stub);
  });
  it("accepts all five hook types and preserves exact caught cloud semantics", () => {
    const values = [
      { type: "command", command: "", cloud: "bad", timeout: 0.5, extra: 1 },
      { type: "prompt", prompt: "", continueOnBlock: false },
      { type: "agent", prompt: "", model: "" },
      { type: "http", url: "https://example.com", cloud: 1 },
      { type: "mcp_tool", server: "", tool: "", input: { x: 1 } },
    ];
    const result = normalize({
      hooks: { DirectoryAdded: [{ matcher: "", hooks: values }] },
    });
    expect(result?.hooks).toEqual({
      DirectoryAdded: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: "", cloud: "skip", timeout: 0.5 },
            ...values.slice(1, 3),
            { type: "http", url: "https://example.com", cloud: "skip" },
            values[4],
          ],
        },
      ],
    });
    expect(normalize({ hooks: { UnknownEvent: [] } })).toEqual(stub);
    expect(
      normalize({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "x", timeout: 0 }] }],
        },
      }),
    ).toEqual(stub);
    expect(normalize({ hooks: ["./hooks.json", {}] })?.hooks).toEqual([
      "./hooks.json",
      {},
    ]);
  });
  it("normalizes eight MCP branches, caught hints and HTTP transforms", () => {
    const mcpServers = {
      stdio: { command: "x", role: "bad" },
      sse: { type: "sse", url: "", request_timeout_ms: 400_000 },
      ide: { type: "sse-ide", url: "", ideName: "" },
      wsIde: { type: "ws-ide", url: "", ideName: "" },
      http: {
        type: "streamable-http",
        url: "",
        timeout: 7,
        request_timeout_ms: 100,
      },
      ws: { type: "ws", url: "" },
      sdk: { type: "sdk", name: "" },
      proxy: {
        type: "claudeai-proxy",
        url: "",
        id: "",
        discoverSupport: "bad",
        eligible: null,
      },
    };
    const result = normalize({ mcpServers })?.mcpServers;
    expect(result).toMatchObject({
      stdio: { command: "x", args: [] },
      sse: { timeout: 300_000 },
      http: { type: "http", timeout: 7 },
      proxy: { eligible: null },
    });
    expect((result as Record<string, unknown>).sse).not.toHaveProperty(
      "request_timeout_ms",
    );
    expect(
      normalize({
        mcpServers: { x: { type: "http", url: "", request_timeout_ms: "bad" } },
      })?.hooks,
    ).toEqual(hooks);
    expect(
      normalize({
        mcpServers: {
          x: {
            type: "http",
            url: "",
            oauth: { authServerMetadataUrl: "http://example.com" },
          },
        },
      }),
    ).toEqual(stub);
  });
});
