import { describe, expect, it } from "vitest";
import { claudeMarketplaceStrictSettingsSourceMatches as settingsMatch } from "./claude-catalog-entry.js";
import {
  claudeMarketplaceStrictGitSourceMatches as matches,
  claudeMarketplaceStrictScalarSourceMatches as scalarMatches,
  type ClaudeMarketplaceComparisonSource,
} from "./claude-marketplace-url.js";

type GitSource = Extract<
  ClaudeMarketplaceComparisonSource,
  { source: "github" | "git" }
>;
const github = (repo: string, ref?: string, path?: string): GitSource => ({
  source: "github",
  repo,
  ...(ref === undefined ? {} : { ref }),
  ...(path === undefined ? {} : { path }),
});

describe("pinned strict settings source branch", () => {
  const plugin = (fields: Record<string, unknown> = {}) => ({
    name: "plugin",
    source: { source: "github", repo: "owner/plugin" },
    ...fields,
  });
  const source = (plugins: unknown, name = "market") => ({ name, plugins });
  it("compares normalized own fields without depending on key order", () => {
    expect(
      settingsMatch(
        source([plugin({ headers: { first: "a", second: "b" } })]),
        source([
          {
            headers: { second: "b", first: "a" },
            source: { repo: "owner/plugin", source: "github", ignored: 1 },
            name: "plugin",
            ignored: { arbitrary: true },
          },
        ]),
      ),
    ).toBe(true);
    expect(settingsMatch(source([]), source([], "other"))).toBe(false);
  });
  it("does not apply catalog defaults or compare catalog-only components", () => {
    expect(
      settingsMatch(
        source([plugin({ hooks: { malformed: true }, __wrapped__: true })]),
        source([plugin()]),
      ),
    ).toBe(true);
    expect(
      settingsMatch(source([plugin()]), source([plugin({ strict: true })])),
    ).toBe(false);
    expect(
      settingsMatch(source([plugin({ description: "" })]), source([plugin()])),
    ).toBe(false);
  });
  it("preserves plugin array order, length and source scalar identity", () => {
    const second = plugin({ name: "second" });
    expect(
      settingsMatch(source([plugin(), second]), source([second, plugin()])),
    ).toBe(false);
    expect(settingsMatch(source([plugin()]), source([]))).toBe(false);
    expect(
      settingsMatch(
        source([plugin()]),
        source([
          plugin({ source: { source: "github", repo: "Owner/plugin" } }),
        ]),
      ),
    ).toBe(false);
    expect(
      settingsMatch(
        source([plugin({ headers: { authorization: "synthetic" } })]),
        source([plugin({ headers: { authorization: "different" } })]),
      ),
    ).toBe(false);
  });
  it.each([
    plugin({ source: "./plugin" }),
    plugin({ source: { source: "unsupported" } }),
    plugin({ strict: null }),
    plugin({ headers: { header: 1 } }),
    plugin({ headersHelper: "four    spaces" }),
    plugin({ name: "has space" }),
    null,
  ])(
    "rejects invalid settings entries rather than making catalog stubs",
    (entry) => {
      expect(() => settingsMatch(source([entry]), source([plugin()]))).toThrow(
        "cli.harness.plugin-inventory-unavailable",
      );
    },
  );
  it("reports the native wrapper failure without executing caller value", () => {
    let called = false;
    const value = () => {
      called = true;
      return "unexpected";
    };
    for (const marker of ["", "false", "true"])
      expect(() =>
        settingsMatch(
          source([plugin({ headers: { __wrapped__: marker } })]),
          source([plugin({ headers: {} })]),
        ),
      ).toThrow("cli.harness.plugin-inventory-unavailable");
    expect(() =>
      settingsMatch(
        source([plugin({ headers: { __wrapped__: "true", value } })]),
        source([plugin()]),
      ),
    ).toThrow("cli.harness.plugin-inventory-unavailable");
    expect(called).toBe(false);
  });
});

describe("pinned strict scalar source branches", () => {
  type ScalarSource = Parameters<typeof scalarMatches>[0];
  it.each([
    [
      { source: "url", url: "https://WWW.GITHUB.COM./a" },
      { source: "url", url: "https://github.com/a" },
      true,
    ],
    [
      { source: "url", url: "https://first@example.com/a" },
      { source: "url", url: "https://second@example.com/a" },
      false,
    ],
    [
      { source: "url", url: "https://example.com/a?x=1" },
      { source: "url", url: "https://example.com/a" },
      false,
    ],
    [
      { source: "url", url: "https://example.com/a#x" },
      { source: "url", url: "https://example.com/a" },
      false,
    ],
    [
      { source: "url", url: "not a url" },
      { source: "url", url: "not a url" },
      true,
    ],
    [
      { source: "npm", package: "@owner/package" },
      { source: "npm", package: "@owner/package" },
      true,
    ],
    [
      { source: "npm", package: "@Owner/package" },
      { source: "npm", package: "@owner/package" },
      false,
    ],
    [
      { source: "file", path: "./catalog.json" },
      { source: "file", path: "./catalog.json" },
      true,
    ],
    [
      { source: "file", path: "./catalog.json" },
      { source: "file", path: "catalog.json" },
      false,
    ],
    [
      { source: "directory", path: "/plugins/../catalog" },
      { source: "directory", path: "/catalog" },
      false,
    ],
    [
      { source: "directory", path: "/Plugins" },
      { source: "directory", path: "/plugins" },
      false,
    ],
    [
      { source: "directory", path: "%2e%2e/catalog" },
      { source: "directory", path: "../catalog" },
      false,
    ],
    [
      { source: "file", path: "/catalog" },
      { source: "directory", path: "/catalog" },
      false,
    ],
    [
      { source: "url", url: "catalog" },
      { source: "npm", package: "catalog" },
      false,
    ],
  ] satisfies readonly (readonly [ScalarSource, ScalarSource, boolean])[])(
    "compares scalar actual %j against policy %j",
    (actual, policy, expected) => {
      expect(scalarMatches(actual, policy)).toBe(expected);
    },
  );
});
const git = (url: string, ref?: string, path?: string): GitSource => ({
  source: "git",
  url,
  ...(ref === undefined ? {} : { ref }),
  ...(path === undefined ? {} : { path }),
});

describe("pinned strict Git/GitHub policy branch", () => {
  it.each([
    [github("Owner/Repo"), github("Owner/Repo"), true],
    [github("Owner/Repo"), github("owner/Repo"), false],
    [github("Owner/Repo", "main"), github("Owner/Repo"), false],
    [github("Owner/Repo"), github("Owner/Repo", "main"), false],
    [github("Owner/Repo", ""), github("Owner/Repo"), true],
    [github("Owner/Repo", undefined, ""), github("Owner/Repo"), true],
    [github("Owner/Repo", undefined, "plugins"), github("Owner/Repo"), false],
    [github("Owner/Repo"), github("Owner/*"), true],
    [github("owner/Repo"), github("Owner/*"), false],
    [github("Owner/-Repo"), github("Owner/*"), false],
    [github("Owner/Repo/extra"), github("Owner/*"), false],
    [github("Owner/Repo.git"), github("Owner/*"), true],
    [github("Owner/*"), github("Owner/*"), false],
    [github("-Owner/*"), github("-Owner/*"), true],
    [github("Owner/R*"), github("Owner/R*"), true],
    [github("Owner/Repo", "main"), github("Owner/*"), false],
    [github("Owner/Repo", "main"), github("Owner/*", "main"), true],
    [github("Owner/Repo", undefined, "plugins"), github("Owner/*"), true],
    [github("Owner/Repo", undefined, "../plugins"), github("Owner/*"), false],
    [github("Owner/Repo", undefined, "/plugins"), github("Owner/*"), false],
    [github("Owner/Repo", undefined, "C:plugins"), github("Owner/*"), false],
    [github("Owner/Repo", undefined, "x\\..\\y"), github("Owner/*"), false],
    [
      github("Owner/Repo", undefined, "%2e%2e/plugins"),
      github("Owner/*"),
      true,
    ],
    [
      github("Owner/Repo", undefined, "../plugins"),
      github("Owner/*", undefined, "../plugins"),
      true,
    ],
    [
      github("Owner/Repo", undefined, "../plugins"),
      github("Owner/Repo", undefined, "../plugins"),
      true,
    ],
    [git("https://example.com/repo"), github("Owner/Repo"), false],
    [github("Owner/Repo"), git("https://github.com/Owner/Repo"), false],
    [
      git("https://user:synthetic@example.com/repo"),
      git("https://example.com/repo"),
      true,
    ],
    [git("git@WWW.GITHUB.COM.:Owner/Repo"), git("github.com:Owner/Repo"), true],
    [
      git("git@WWW.GITHUB.COM.:Owner/Repo"),
      git("git@github.com:Owner/Repo"),
      true,
    ],
    [
      git("git@ssh.github.com:Owner/Repo"),
      git("git@github.com:Owner/Repo"),
      false,
    ],
    [git("git@EXAMPLE.COM.:repo"), git("git@example.com:repo"), true],
    [git("first@example.com:repo"), git("second@example.com:repo"), false],
    [
      git("https://example.com/repo.git"),
      git("https://example.com/repo"),
      false,
    ],
    [
      git("https://example.com/repo?x=1"),
      git("https://example.com/repo"),
      false,
    ],
    [
      git("https://example.com/repo", "main"),
      git("https://example.com/repo"),
      false,
    ],
    [
      git("https://example.com/repo", ""),
      git("https://example.com/repo"),
      true,
    ],
    [
      git("https://example.com/repo", undefined, "a"),
      git("https://example.com/repo"),
      false,
    ],
    [git("ssh://%65xample.com/repo"), git("ssh://%65xample.com/repo"), false],
    [
      git("https://example\\.com/repo"),
      git("https://example\\.com/repo"),
      false,
    ],
  ] satisfies readonly (readonly [GitSource, GitSource, boolean])[])(
    "compares actual %j against policy %j",
    (actual, policy, expected) => {
      expect(matches(actual, policy)).toBe(expected);
    },
  );
});
