// Pinned 2.1.245 chunk-sqc8ym90 exports g as Q3c and d as R3c. These
// describe URL-host syntax only, not marketplace kind or local-file policy.
const specialProtocols = new Set(["http", "https", "ws", "wss", "ftp"]);

const withoutTrailingDots = (value: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === ".") end -= 1;
  return value.slice(0, end);
};

// The same pinned chunk exports i as K3c and u as M3c. Host comparison is
// not URL/source admission: the caller still applies the native policy matcher.
export const normalizeClaudeMarketplaceHost = (value: string): string => {
  const normalized = withoutTrailingDots(
    value.replace(/[\t\n\r]/gu, "").toLowerCase(),
  );
  if (normalized === "" || /[:/\\?#@\s]/u.test(normalized)) return normalized;
  try {
    const parsed = new URL(`https://${normalized}`);
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    )
      return normalized;
    return withoutTrailingDots(parsed.hostname);
  } catch {
    return normalized;
  }
};

export const claudeMarketplaceGithubHost = (value: string): boolean => {
  let normalized = normalizeClaudeMarketplaceHost(value);
  while (normalized.startsWith("www.")) normalized = normalized.slice(4);
  return normalized === "github.com";
};

export const claudeGitAuthorityHasBackslash = (value: string): boolean => {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) <= 0x20) start += 1;
  value = value.slice(start);
  const delimiter = value.indexOf("://");
  if (delimiter === -1) return false;
  let authority = value.slice(delimiter + 3);
  const protocol = value.slice(0, delimiter).toLowerCase();
  if (specialProtocols.has(protocol)) {
    const leading = authority.match(/^[/\\]+/u)?.[0] ?? "";
    if (leading.includes("\\")) return true;
    authority = authority.slice(leading.length);
  }
  const boundary = authority.search(/[/?#]/u);
  return (boundary === -1 ? authority : authority.slice(0, boundary)).includes(
    "\\",
  );
};

const invalidHost = (host: string): boolean =>
  Array.from(host).some((character) => {
    const code = character.codePointAt(0)!;
    return character === "%" || code < 0x20 || code >= 0x7f;
  });

export const claudeGitSourceHasInvalidHost = (value: string): boolean => {
  if (value.includes("://")) {
    if (claudeGitAuthorityHasBackslash(value)) return true;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === "http:" || parsed.protocol === "https:")
        return false;
      return invalidHost(parsed.hostname);
    } catch {
      return true;
    }
  }
  const colon = value.indexOf(":");
  const at = value.indexOf("@");
  if (colon >= 0 && at > colon) return true;
  const host = value.match(/^(?:[^@]+@)?([^:]+):/u)?.[1];
  return host === undefined ? false : invalidHost(host);
};

const policyHost = (value: string): string => {
  const normalized = normalizeClaudeMarketplaceHost(value);
  return claudeMarketplaceGithubHost(normalized) ? "github.com" : normalized;
};

// Pinned matcher y/F distinguish a URL source from a Git source. A Git source
// may erase userinfo only for the listed protocols or a native GitHub alias.
export const normalizeClaudeMarketplaceUrl = (value: string): string => {
  try {
    const parsed = new URL(value);
    parsed.hostname = policyHost(parsed.hostname);
    return parsed.toString();
  } catch {
    return value;
  }
};

export const normalizeClaudeMarketplaceGitUrl = (value: string): string => {
  if (claudeGitSourceHasInvalidHost(value)) return value;
  if (value.includes("://")) {
    try {
      const parsed = new URL(value);
      parsed.hostname = policyHost(parsed.hostname);
      if (
        ["http:", "https:", "git:", "git+http:", "git+https:"].includes(
          parsed.protocol,
        ) ||
        claudeMarketplaceGithubHost(parsed.hostname)
      ) {
        parsed.username = "";
        parsed.password = "";
      }
      return parsed.toString();
    } catch {
      return value;
    }
  }
  const scp = /^([^@:/[\]]+)@([^@:/[\]]+):(.*)$/su.exec(value);
  if (scp === null) return value;
  const host = withoutTrailingDots(scp[2]!.toLowerCase());
  return claudeMarketplaceGithubHost(host)
    ? `github.com:${scp[3]!}`
    : `${scp[1]!}@${host}:${scp[3]!}`;
};

const repositoryPath = (value: string): string => {
  const components: string[] = [];
  for (const component of value.split("/")) {
    if (component === ".") continue;
    if (component === "..") components.pop();
    else components.push(component);
  }
  return components.filter((component) => component !== "").join("/");
};

const withoutRepositorySuffix = (value: string): string => {
  let end = value.length;
  for (;;) {
    let next = end;
    while (next > 0 && value.charCodeAt(next - 1) === 47) next -= 1;
    if (next >= 4 && value.startsWith(".git", next - 4)) next -= 4;
    if (next === end) return value.slice(0, end);
    end = next;
  }
};

const decodedRepositoryPath = (value: string): string => {
  try {
    value = decodeURIComponent(value);
  } catch {
    // Native matching retains malformed escapes rather than inventing a path.
  }
  return withoutRepositorySuffix(repositoryPath(value));
};

// Native blocked matching h/B also joins the SSH GitHub host alias, removes
// query/fragment, and normalizes decoded dot segments. Strict matching F above
// intentionally does not perform these transformations.
export const normalizeClaudeBlockedGitUrl = (
  value: string,
  stripDotGit = false,
): string => {
  const host = (value: string): string => {
    const normalized = policyHost(value);
    return normalized === "ssh.github.com" ? "github.com" : normalized;
  };
  if (value.includes("://")) {
    try {
      const parsed = new URL(value);
      parsed.hostname = host(parsed.hostname);
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      try {
        parsed.pathname = decodeURIComponent(parsed.pathname);
      } catch {
        // Native blocked matching keeps an undecodable path unchanged here.
      }
      const path = repositoryPath(parsed.pathname);
      parsed.pathname = stripDotGit ? withoutRepositorySuffix(path) : path;
      return parsed.toString();
    } catch {
      return value;
    }
  }
  const scp = /^[^@]+@([^:]+)(:.*)$/su.exec(value);
  return scp === null ? value : `${host(scp[1]!)}${scp[2]!}`;
};

// Native b accepts only a normalized two-component GitHub repository. This
// observation is used by blocked matching; it is not acquisition authority.
export const claudeMarketplaceGitRepository = (
  value: string,
): string | null => {
  let host: string;
  let path: string;
  if (value.includes("://")) {
    if (claudeGitAuthorityHasBackslash(value)) return null;
    try {
      const parsed = new URL(value);
      host = parsed.hostname;
      path = parsed.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  } else {
    const scp = /^[^@]+@([^:]+):(.+)$/u.exec(value);
    if (scp === null) return null;
    host = scp[1]!;
    path = scp[2]!.replace(/^\/+/, "");
  }
  if (
    host === "" ||
    path === "" ||
    (!claudeMarketplaceGithubHost(host) &&
      normalizeClaudeMarketplaceHost(host) !== "ssh.github.com")
  )
    return null;
  const normalized = decodedRepositoryPath(path);
  const parts = normalized.split("/");
  return parts.length === 2 && parts[0] !== "" && parts[1] !== ""
    ? normalized
    : null;
};

const repositoryComponent = (value: string): boolean =>
  /^[A-Za-z0-9._-]+$/u.test(value) &&
  !value.startsWith("-") &&
  value !== "." &&
  value !== "..";

export const claudeMarketplaceRepositoryMatches = (
  actual: string,
  policy: string,
  blocklistDirection: boolean,
): boolean => {
  const owner = policy.endsWith("/*") ? policy.slice(0, -2) : undefined;
  if (owner === undefined || !repositoryComponent(owner))
    return blocklistDirection
      ? decodedRepositoryPath(actual) === policy || actual === policy
      : actual === policy;
  const parts = (
    blocklistDirection ? decodedRepositoryPath(actual) : actual
  ).split("/");
  if (parts.length !== 2 || !repositoryComponent(parts[0]!)) return false;
  return blocklistDirection
    ? /^[A-Za-z0-9._-]+$/u.test(parts[1]!) &&
        parts[0]!.toLowerCase() === owner.toLowerCase()
    : repositoryComponent(parts[1]!) && parts[0] === owner;
};

export const claudeMarketplacePolicyPathIsSafe = (value: string): boolean =>
  !value.startsWith("/") &&
  !value.startsWith("\\") &&
  !/^[A-Za-z]:/u.test(value) &&
  !value.split(/[\\/]/u).some((component) => component === "..");

export type ClaudeMarketplaceComparisonSource =
  | Readonly<{ source: "github"; repo: string; ref?: string; path?: string }>
  | Readonly<{ source: "git"; url: string; ref?: string; path?: string }>
  | Readonly<{ source: "url"; url: string }>
  | Readonly<{ source: "npm"; package: string }>
  | Readonly<{ source: "file" | "directory"; path: string }>
  | Readonly<{ source: "settings"; name: string }>;

type GitMarketplaceSource = Extract<
  ClaudeMarketplaceComparisonSource,
  { source: "git" | "github" }
>;

type ScalarMarketplaceSource = Exclude<
  ClaudeMarketplaceComparisonSource,
  GitMarketplaceSource | Readonly<{ source: "settings"; name: string }>
>;

// Pinned x compares these scalar branches literally except for URL host
// normalization. Package versions and registries are not comparison inputs;
// filesystem paths are not resolved, decoded or case-folded by this matcher.
export const claudeMarketplaceStrictScalarSourceMatches = (
  actual: ScalarMarketplaceSource,
  policy: ScalarMarketplaceSource,
): boolean => {
  if (actual.source !== policy.source) return false;
  if (actual.source === "url" && policy.source === "url")
    return (
      normalizeClaudeMarketplaceUrl(actual.url) ===
      normalizeClaudeMarketplaceUrl(policy.url)
    );
  if (actual.source === "npm" && policy.source === "npm")
    return actual.package === policy.package;
  return (
    (actual.source === "file" || actual.source === "directory") &&
    (policy.source === "file" || policy.source === "directory") &&
    actual.path === policy.path
  );
};

// Pinned Z/x strict Git/GitHub branch. Unlike blocked ft, kinds cannot cross,
// absent policy refs are not wildcards, and owner matching is case-sensitive.
// This is a pure branch comparison, not effective-policy or source admission.
export const claudeMarketplaceStrictGitSourceMatches = (
  actual: GitMarketplaceSource,
  policy: GitMarketplaceSource,
): boolean => {
  if (actual.source === "git" && claudeGitSourceHasInvalidHost(actual.url))
    return false;
  if (actual.source !== policy.source) return false;
  if ((actual.ref || undefined) !== (policy.ref || undefined)) return false;
  if (actual.source === "git" && policy.source === "git")
    return (
      normalizeClaudeMarketplaceGitUrl(actual.url) ===
        normalizeClaudeMarketplaceGitUrl(policy.url) &&
      (actual.path || undefined) === (policy.path || undefined)
    );
  if (actual.source !== "github" || policy.source !== "github") return false;
  const owner = policy.repo.endsWith("/*")
    ? policy.repo.slice(0, -2)
    : undefined;
  if (owner !== undefined && repositoryComponent(owner))
    return (
      claudeMarketplaceRepositoryMatches(actual.repo, policy.repo, false) &&
      (policy.path
        ? policy.path === (actual.path || undefined)
        : !actual.path || claudeMarketplacePolicyPathIsSafe(actual.path))
    );
  return (
    actual.repo === policy.repo &&
    (actual.path || undefined) === (policy.path || undefined)
  );
};

// Native at/T/lt extract only the comparison host. Strict host-pattern matching
// uses k's narrower SCP grammar; blocked matching deliberately uses at instead.
// This does not admit a source, execute a pattern, or resolve a provider policy.
export const claudeMarketplaceComparisonHosts = (
  source: ClaudeMarketplaceComparisonSource,
  blocklistDirection: boolean,
): readonly string[] => {
  let hostname: string | null;
  if (source.source === "github") hostname = "github.com";
  else if (source.source === "git" && !source.url.includes("://"))
    hostname = blocklistDirection
      ? (/^[^@]+@([^:]+):/u.exec(source.url)?.[1] ?? null)
      : (/^([^@:/[\]]+)@([^@:/[\]]+):(.*)$/su.exec(source.url)?.[2] ?? null);
  else if (source.source === "git" || source.source === "url") {
    if (source.source === "git" && claudeGitAuthorityHasBackslash(source.url))
      return Object.freeze([]);
    try {
      hostname = new URL(source.url).hostname || null;
    } catch {
      hostname = null;
    }
  } else hostname = null;
  if (hostname === null) return Object.freeze([]);
  const normalized = policyHost(hostname);
  return Object.freeze(
    blocklistDirection && normalized === "ssh.github.com"
      ? [normalized, "github.com"]
      : [normalized],
  );
};

// Pinned L/K use ordinary case-sensitive RegExp tests over these comparison
// fields. Invalid patterns do not match; a literal-looking URL is not a host
// for filesystem sources. These functions neither resolve nor admit policy.
export const claudeMarketplaceHostPatternMatches = (
  source: ClaudeMarketplaceComparisonSource,
  pattern: string,
  blocklistDirection: boolean,
): boolean => {
  const hosts = claudeMarketplaceComparisonHosts(source, blocklistDirection);
  if (hosts.length === 0) return false;
  try {
    const expression = new RegExp(pattern);
    return hosts.some((host) => expression.test(host));
  } catch {
    return false;
  }
};

export const claudeMarketplacePathPatternMatches = (
  source: ClaudeMarketplaceComparisonSource,
  pattern: string,
): boolean => {
  if (source.source !== "file" && source.source !== "directory") return false;
  try {
    return new RegExp(pattern).test(source.path);
  } catch {
    return false;
  }
};

const blockedReferenceMatches = (
  policy: string | undefined,
  actual: string | undefined,
): boolean => !policy || policy === (actual || undefined);

const blockedRepository = (value: string): string | null => {
  const repository = claudeMarketplaceGitRepository(value);
  return repository?.includes("*") ? null : repository;
};

const blockedGitReferencesMatch = (
  actual: Readonly<{ ref?: string; path?: string }>,
  policy: Readonly<{ ref?: string; path?: string }>,
): boolean =>
  blockedReferenceMatches(policy.ref, actual.ref) &&
  blockedReferenceMatches(policy.path, actual.path);

// Pinned chunk-53e8ej2z ft compares one parsed source with one blocked entry.
// This is only its pure comparison: dt separately rejects malformed Git
// authority and composes block/strict policy from the effective provider layer.
export const claudeMarketplaceBlockedSourceMatches = (
  actual: ClaudeMarketplaceComparisonSource,
  policy: ClaudeMarketplaceComparisonSource,
): boolean => {
  switch (actual.source) {
    case "github": {
      const repository =
        policy.source === "github"
          ? policy.repo
          : policy.source === "git"
            ? blockedRepository(policy.url)
            : null;
      return (
        repository !== null &&
        (policy.source === "github" || policy.source === "git") &&
        claudeMarketplaceRepositoryMatches(actual.repo, repository, true) &&
        blockedGitReferencesMatch(actual, policy)
      );
    }
    case "git": {
      if (policy.source === "github") {
        const repository = claudeMarketplaceGitRepository(actual.url);
        return (
          repository !== null &&
          claudeMarketplaceRepositoryMatches(repository, policy.repo, true) &&
          blockedGitReferencesMatch(actual, policy)
        );
      }
      if (policy.source === "url")
        return (
          actual.url.includes("://") &&
          normalizeClaudeBlockedGitUrl(actual.url, true) ===
            normalizeClaudeBlockedGitUrl(policy.url, true)
        );
      if (policy.source !== "git") return false;
      const selected = blockedRepository(policy.url);
      const repository =
        selected === null ? null : claudeMarketplaceGitRepository(actual.url);
      const matches =
        selected !== null && repository !== null
          ? claudeMarketplaceRepositoryMatches(repository, selected, true)
          : normalizeClaudeBlockedGitUrl(actual.url) ===
            normalizeClaudeBlockedGitUrl(policy.url);
      return matches && blockedGitReferencesMatch(actual, policy);
    }
    case "url":
      return (
        policy.source === "url" &&
        normalizeClaudeMarketplaceUrl(actual.url) ===
          normalizeClaudeMarketplaceUrl(policy.url)
      );
    case "npm":
      return policy.source === "npm" && actual.package === policy.package;
    case "file":
    case "directory":
      return policy.source === actual.source && actual.path === policy.path;
    case "settings":
      return policy.source === "settings" && actual.name === policy.name;
  }
};
