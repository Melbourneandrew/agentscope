import { describe, expect, it } from "vitest";
import {
  claudeGitAuthorityHasBackslash,
  claudeGitSourceHasInvalidHost,
  claudeMarketplaceGithubHost,
  normalizeClaudeMarketplaceHost,
  normalizeClaudeMarketplaceUrl,
  normalizeClaudeMarketplaceGitUrl,
  claudeMarketplaceGitRepository,
  claudeMarketplaceRepositoryMatches,
  claudeMarketplacePolicyPathIsSafe,
  normalizeClaudeBlockedGitUrl,
  claudeMarketplaceBlockedSourceMatches,
  claudeMarketplaceComparisonHosts,
  type ClaudeMarketplaceComparisonSource,
} from "./claude-marketplace-url.js";

describe("pinned Claude Git authority syntax", () => {
  it.each([
    ["https://example.com/repo", false],
    ["https://example.com/path\\part", false],
    ["https://example.com?query\\part", false],
    ["https://example.com#fragment\\part", false],
    ["https://example\\.com/repo", true],
    [" \tHTTPS://\\example.com/repo", true],
    ["https:////example.com/repo", false],
    ["ftp://\\example.com/repo", true],
    ["ssh://\\example.com/repo", true],
    ["ssh:///\\example.com/repo", false],
    ["git@example.com:repo\\path", false],
  ])("keeps the authority boundary for %j", (value, expected) => {
    expect(claudeGitAuthorityHasBackslash(value)).toBe(expected);
  });

  it.each([
    ["https://example.com/repo", false],
    ["https://éxample.com/repo", false],
    ["https://example.com/path\\part", false],
    ["https://example\\.com/repo", true],
    ["https://%invalid/repo", true],
    ["ssh://example.com/repo", false],
    ["ssh://éxample.com/repo", true],
    ["ssh://%65xample.com/repo", true],
    ["git@example.com:repo", false],
    ["git@éxample.com:repo", true],
    ["git@example%2ecom:repo", true],
    ["host:git@other/repo", true],
    ["./relative-repository", false],
    ["ordinary-string-without-colon", false],
  ])("keeps URL and SCP-host semantics for %j", (value, expected) => {
    expect(claudeGitSourceHasInvalidHost(value)).toBe(expected);
  });
});

const github = (
  repo: string,
  ref?: string,
  path?: string,
): ClaudeMarketplaceComparisonSource => ({
  source: "github",
  repo,
  ...(ref === undefined ? {} : { ref }),
  ...(path === undefined ? {} : { path }),
});
const git = (url: string): ClaudeMarketplaceComparisonSource => ({
  source: "git",
  url,
});
const matches = claudeMarketplaceBlockedSourceMatches;

describe("pinned Claude strict versus blocked host extraction", () => {
  it.each([
    ["git@github.com:Owner/Repo", false, ["github.com"]],
    ["git@WWW.GITHUB.COM.:Owner/Repo", false, ["github.com"]],
    ["git@ssh.github.com:Owner/Repo", false, ["ssh.github.com"]],
    ["git@ssh.github.com:Owner/Repo", true, ["ssh.github.com", "github.com"]],
    ["odd:user@example.com:repo", false, []],
    ["odd:user@example.com:repo", true, ["example.com"]],
    ["github.com:Owner/Repo", true, []],
    [
      "ssh://git@ssh.github.com/Owner/Repo",
      true,
      ["ssh.github.com", "github.com"],
    ],
    ["https://WWW.GITHUB.COM./Owner/Repo", false, ["github.com"]],
    ["https://example\\.com/repo", true, []],
    ["https://%invalid/repo", false, []],
  ] as const)("extracts %s with blocked=%s", (url, blocked, expected) => {
    expect(claudeMarketplaceComparisonHosts(git(url), blocked)).toEqual(
      expected,
    );
  });
  it("does not infer a network host for filesystem or settings sources", () => {
    expect(
      claudeMarketplaceComparisonHosts(
        { source: "file", path: "https://github.com" },
        true,
      ),
    ).toEqual([]);
    expect(
      claudeMarketplaceComparisonHosts(
        { source: "settings", name: "github.com" },
        false,
      ),
    ).toEqual([]);
    expect(
      claudeMarketplaceComparisonHosts(github("other/repo"), false),
    ).toEqual(["github.com"]);
  });
});

describe("pinned Claude blocked repository comparison", () => {
  it("matches GitHub aliases across Git/GitHub kinds, not unrelated hosts", () => {
    expect(
      matches(
        git("ssh://git@ssh.github.com/Owner/Repo.git"),
        github("Owner/Repo"),
      ),
    ).toBe(true);
    expect(
      matches(
        github("Owner/Repo"),
        git("https://www.github.com/Owner/Repo.git"),
      ),
    ).toBe(true);
    expect(
      matches(
        git("git@github.com:Owner/Repo.git"),
        git("https://github.com/Owner/Repo"),
      ),
    ).toBe(true);
    expect(
      matches(git("https://example.com/Owner/Repo"), github("Owner/Repo")),
    ).toBe(false);
    expect(
      matches(github("Owner/Repo"), git("https://example.com/Owner/Repo")),
    ).toBe(false);
  });
  it("keeps owner wildcard case behavior and literal invalid wildcard behavior", () => {
    expect(matches(github("OWNER/Repo.git"), github("owner/*"))).toBe(true);
    expect(matches(github("Owner/Other"), github("Owner/Repo"))).toBe(false);
    expect(matches(github("owner/Repo"), github("Owner/Repo"))).toBe(false);
    expect(matches(github("Owner/R*"), github("Owner/R*"))).toBe(true);
    expect(
      matches(github("Owner/Repo"), git("https://github.com/Owner/*")),
    ).toBe(false);
    expect(
      matches(
        git("https://github.com/Owner/*"),
        git("https://github.com/Owner/*"),
      ),
    ).toBe(true);
  });
  it("uses absent or empty policy ref/path as wildcard, but exact populated values", () => {
    const actual = github("Owner/Repo", "branch", "subdir");
    expect(matches(actual, github("Owner/Repo"))).toBe(true);
    expect(matches(actual, github("Owner/Repo", "", ""))).toBe(true);
    expect(matches(actual, github("Owner/Repo", "branch", "subdir"))).toBe(
      true,
    );
    expect(matches(actual, github("Owner/Repo", "other", "subdir"))).toBe(
      false,
    );
    expect(matches(actual, github("Owner/Repo", "branch", "other"))).toBe(
      false,
    );
    expect(matches(github("Owner/Repo"), actual)).toBe(false);
  });
});

describe("pinned Claude blocked URL comparison", () => {
  it("normalizes non-GitHub Git URLs but preserves SCP suffix and query", () => {
    expect(
      matches(
        git("ssh://a@example.com/one/../repo?x=1#f"),
        git("ssh://b@example.com/repo"),
      ),
    ).toBe(true);
    expect(
      matches(git("git@example.com:repo.git"), git("other@example.com:repo")),
    ).toBe(false);
    expect(
      matches(git("git@example.com:repo?x=1"), git("other@example.com:repo")),
    ).toBe(false);
  });
  it("allows URL policy to match Git URLs with repeated .git erased, not the reverse", () => {
    const policy: ClaudeMarketplaceComparisonSource = {
      source: "url",
      url: "https://github.com/Owner/Repo",
    };
    const actual = git("https://git@github.com/Owner/Repo.git.git?x=1#f");
    expect(matches(actual, policy)).toBe(true);
    expect(matches(policy, actual)).toBe(false);
    expect(matches(git("git@github.com:Owner/Repo.git"), policy)).toBe(false);
  });
  it("does not erase URL-source userinfo, query or fragment", () => {
    expect(
      matches(
        { source: "url", url: "https://user@WWW.GITHUB.COM./repo?x=1#f" },
        { source: "url", url: "https://user@github.com/repo?x=1#f" },
      ),
    ).toBe(true);
    expect(
      matches(
        { source: "url", url: "https://user@github.com/repo" },
        { source: "url", url: "https://github.com/repo" },
      ),
    ).toBe(false);
  });
});

describe("pinned Claude blocked literal-source comparison", () => {
  it.each([
    [
      { source: "npm", package: "one" },
      { source: "npm", package: "one" },
      true,
    ],
    [
      { source: "npm", package: "one" },
      { source: "npm", package: "two" },
      false,
    ],
    [{ source: "file", path: "/one" }, { source: "file", path: "/one" }, true],
    [
      { source: "directory", path: "/one" },
      { source: "directory", path: "/one" },
      true,
    ],
    [
      { source: "directory", path: "/one" },
      { source: "file", path: "/one" },
      false,
    ],
    [
      { source: "file", path: "/one" },
      { source: "file", path: "/one/" },
      false,
    ],
    [
      { source: "settings", name: "one" },
      { source: "settings", name: "one" },
      true,
    ],
    [
      { source: "settings", name: "one" },
      { source: "settings", name: "two" },
      false,
    ],
    [
      { source: "npm", package: "one" },
      { source: "settings", name: "one" },
      false,
    ],
  ] satisfies readonly (readonly [
    ClaudeMarketplaceComparisonSource,
    ClaudeMarketplaceComparisonSource,
    boolean,
  ])[])(
    "compares literal kinds without cross-kind inference",
    (actual, policy, expected) => {
      expect(matches(actual, policy)).toBe(expected);
    },
  );
});

describe("pinned Claude URL-source versus Git-source comparison", () => {
  it("preserves URL userinfo while the admitted Git protocol erases it", () => {
    const value = "https://user:synthetic@WWW.GITHUB.COM./Owner/Repo?x=1#part";
    expect(normalizeClaudeMarketplaceUrl(value)).toBe(
      "https://user:synthetic@github.com/Owner/Repo?x=1#part",
    );
    expect(normalizeClaudeMarketplaceGitUrl(value)).toBe(
      "https://github.com/Owner/Repo?x=1#part",
    );
  });
  it.each([
    ["ssh://git@example.com/Owner/Repo", "ssh://git@example.com/Owner/Repo"],
    ["ssh://git@www.github.com/Owner/Repo", "ssh://github.com/Owner/Repo"],
    [
      "ssh://git@ssh.github.com/Owner/Repo",
      "ssh://git@ssh.github.com/Owner/Repo",
    ],
    ["git@WWW.GITHUB.COM.:Owner/Repo", "github.com:Owner/Repo"],
    ["git@EXAMPLE.COM.:Owner/Repo", "git@example.com:Owner/Repo"],
    ["git@éxample.com:Owner/Repo", "git@éxample.com:Owner/Repo"],
    ["https://%invalid/Owner/Repo", "https://%invalid/Owner/Repo"],
    ["ordinary", "ordinary"],
  ])("keeps the native Git comparison for %j", (value, expected) => {
    expect(normalizeClaudeMarketplaceGitUrl(value)).toBe(expected);
  });
});

describe("pinned Claude GitHub repository and path comparisons", () => {
  it.each([
    [
      "ssh://git@ssh.github.com/Owner/Repo.git?query#part",
      false,
      "ssh://github.com/Owner/Repo.git",
    ],
    [
      "https://user:synthetic@WWW.GITHUB.COM./Owner/%52epo.git///?query#part",
      true,
      "https://github.com/Owner/Repo",
    ],
    [
      "https://github.com/Owner/skip/%2e%2e/Repo",
      false,
      "https://github.com/Owner/Repo",
    ],
    ["git@SSH.GITHUB.COM.:Owner/Repo.git", true, "github.com:Owner/Repo.git"],
    [
      "git@EXAMPLE.COM.:Owner/Repo?query",
      false,
      "example.com:Owner/Repo?query",
    ],
    ["ordinary", true, "ordinary"],
  ])(
    "keeps native blocked normalization distinct for %j",
    (value, strip, expected) => {
      expect(normalizeClaudeBlockedGitUrl(value, strip)).toBe(expected);
    },
  );

  it.each([
    ["https://github.com/Owner/Repo.git/", "Owner/Repo"],
    ["https://www.www.github.com/Owner/Repo.git.git", "Owner/Repo"],
    ["ssh://git@ssh.github.com/Owner/Repo", "Owner/Repo"],
    ["git@github.com:Owner/%52epo.git", "Owner/Repo"],
    ["git@github.com:Owner/ignored/../Repo", "Owner/Repo"],
    ["git@github.com:/Owner//Repo///", "Owner/Repo"],
    ["https://example.com/Owner/Repo", null],
    ["https://github.com/Owner/Repo/path", null],
    ["git@github.com:Owner", null],
    ["https://github\\.com/Owner/Repo", null],
  ])(
    "observes the normalized two-component repository for %j",
    (value, expected) => {
      expect(claudeMarketplaceGitRepository(value)).toBe(expected);
    },
  );

  it.each([
    ["Owner/Repo", "Owner/*", true, true],
    ["owner/Repo", "Owner/*", false, true],
    ["Owner/-Repo", "Owner/*", false, true],
    ["Owner/Repo.git", "Owner/Repo", false, true],
    ["Owner/%52epo", "Owner/Repo", false, true],
    ["Owner/skip/../Repo", "Owner/Repo", false, true],
    ["Owner/Repo/path", "Owner/*", false, false],
    ["Owner/Repo", "*/Repo", false, false],
    ["Owner/Repo", "-Owner/*", false, false],
    ["Owner/Repo", "owner/Repo", false, false],
    ["Owner/Repo*", "Owner/Repo*", true, true],
  ])(
    "distinguishes strict and blocked matching for %j against %j",
    (actual, policy, strict, blocked) => {
      expect(claudeMarketplaceRepositoryMatches(actual, policy, false)).toBe(
        strict,
      );
      expect(claudeMarketplaceRepositoryMatches(actual, policy, true)).toBe(
        blocked,
      );
    },
  );

  it.each([
    ["plugins/ordinary", true],
    ["plugins/./ordinary", true],
    ["plugins/%2e%2e/ordinary", true],
    ["plugins/..ordinary", true],
    ["plugins/../ordinary", false],
    ["plugins\\..\\ordinary", false],
    ["/ordinary", false],
    ["\\ordinary", false],
    ["C:ordinary", false],
  ])(
    "keeps the native literal policy-subpath rule for %j",
    (value, expected) => {
      expect(claudeMarketplacePolicyPathIsSafe(value)).toBe(expected);
    },
  );
});

describe("pinned Claude policy host comparison, not source admission", () => {
  it.each([
    ["GitHub.COM...", "github.com"],
    ["www.www.GITHUB.com.", "www.www.github.com"],
    ["git\thub.\ncom\r", "github.com"],
    ["éxample.com", "xn--xample-9ua.com"],
    ["%67ithub.com", "github.com"],
    ["github.com:443", "github.com:443"],
    ["github.com/repo", "github.com/repo"],
    ["user@github.com", "user@github.com"],
    [" github.com ", " github.com "],
    ["github.com?query", "github.com?query"],
    ["%invalid", "%invalid"],
    ["...", ""],
  ])("preserves exact host normalization for %j", (value, expected) => {
    expect(normalizeClaudeMarketplaceHost(value)).toBe(expected);
  });

  it.each([
    ["GitHub.com.", true],
    ["www.www.github.com", true],
    ["%67ithub.com", true],
    ["ssh.github.com", false],
    ["github.com.example", false],
    ["github.com:443", false],
    [" github.com ", false],
    ["https://github.com", false],
    ["www.github.com/repo", false],
    ["", false],
  ])(
    "matches only the native GitHub host aliases for %j",
    (value, expected) => {
      expect(claudeMarketplaceGithubHost(value)).toBe(expected);
    },
  );
});
