import { describe, expect, it } from "vitest";
import {
  claudeMarketplaceHostPatternMatches as hostMatches,
  claudeMarketplacePathPatternMatches as pathMatches,
  type ClaudeMarketplaceComparisonSource,
} from "./claude-marketplace-url.js";

const git = (url: string): ClaudeMarketplaceComparisonSource => ({
  source: "git",
  url,
});

describe("pinned native host-pattern comparison", () => {
  it.each([
    [git("git@ssh.github.com:Owner/Repo"), "^github\\.com$", true, true],
    [git("git@ssh.github.com:Owner/Repo"), "^github\\.com$", false, false],
    [git("git@ssh.github.com:Owner/Repo"), "^ssh\\.github\\.com$", false, true],
    [git("odd:user@example.com:repo"), "^example\\.com$", true, true],
    [git("odd:user@example.com:repo"), "^example\\.com$", false, false],
    [git("https://WWW.GITHUB.COM./repo"), "^github\\.com$", false, true],
    [git("https://example.com/repo"), "^EXAMPLE\\.COM$", true, false],
    [git("https://example.com/repo"), "example", false, true],
    [git("https://example.com/repo"), "[", true, false],
    [git("https://%invalid/repo"), ".*", true, false],
    [git("https://example\\.com/repo"), ".*", false, false],
    [{ source: "github", repo: "Owner/Repo" }, "^github\\.com$", false, true],
    [
      { source: "url", url: "https://WWW.GITHUB.COM./a" },
      "^github\\.com$",
      true,
      true,
    ],
    [{ source: "file", path: "https://github.com" }, ".*", true, false],
    [{ source: "directory", path: "github.com" }, ".*", false, false],
    [{ source: "settings", name: "github.com" }, ".*", true, false],
    [{ source: "npm", package: "github.com" }, ".*", false, false],
  ] satisfies readonly (readonly [
    ClaudeMarketplaceComparisonSource,
    string,
    boolean,
    boolean,
  ])[])(
    "compares %j against %s (blocked=%s)",
    (source, pattern, blocked, expected) => {
      expect(hostMatches(source, pattern, blocked)).toBe(expected);
    },
  );
});

describe("pinned native path-pattern comparison", () => {
  it.each([
    [{ source: "file", path: "/isolated/a.json" }, "^/isolated/", true],
    [{ source: "directory", path: "/isolated/plugins" }, "plugins$", true],
    [{ source: "directory", path: "/isolated/plugins" }, "PLUGINS$", false],
    [{ source: "file", path: "./plugins/../a.json" }, "\\.\\./", true],
    [{ source: "file", path: "/isolated/a.json" }, "[", false],
    [{ source: "github", repo: "Owner/Repo", path: "plugins" }, ".*", false],
    [{ source: "git", url: "file:///isolated", path: "plugins" }, ".*", false],
    [{ source: "url", url: "file:///isolated" }, ".*", false],
    [{ source: "settings", name: "/isolated/plugins" }, ".*", false],
    [{ source: "npm", package: "/isolated/plugins" }, ".*", false],
  ] satisfies readonly (readonly [
    ClaudeMarketplaceComparisonSource,
    string,
    boolean,
  ])[])("tests literal %j against %s", (source, pattern, expected) => {
    expect(pathMatches(source, pattern)).toBe(expected);
  });
});
