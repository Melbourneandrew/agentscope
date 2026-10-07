import { beforeEach, describe, expect, it, vi } from "vitest";
import { constants } from "node:fs";
import type * as FileSystem from "node:fs";
import {
  git,
  hasCredentialGitState,
  inferModeAndIdentity,
  publishCredentialPreflightFailure,
} from "./controller-host-identity.js";

const boundary = vi.hoisted(() => ({
  exec: vi.fn(),
  close: vi.fn(),
  sync: vi.fn(),
  link: vi.fn(),
  status: vi.fn(),
  mkdir: vi.fn(),
  open: vi.fn(),
  remove: vi.fn(),
  write: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFileSync: boundary.exec }));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof FileSystem>()),
  closeSync: boundary.close,
  fsyncSync: boundary.sync,
  linkSync: boundary.link,
  lstatSync: boundary.status,
  mkdirSync: boundary.mkdir,
  openSync: boundary.open,
  rmSync: boundary.remove,
  writeFileSync: boundary.write,
}));

const directoryStatus = () => ({
  isDirectory: () => true,
  isSymbolicLink: () => false,
});
const publicationEnvironment = () => ({
  AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE: "credential-presence",
  GITHUB_SHA: "a".repeat(40),
});
const credentialFailure = () =>
  new Error("integration.controller.provider-credentials");

beforeEach(() => {
  vi.resetAllMocks();
  boundary.exec.mockReturnValue("");
  boundary.open.mockReturnValueOnce(11).mockReturnValue(12);
  boundary.status.mockImplementation(() => {
    if (boundary.write.mock.calls.length === 0) return directoryStatus();
    const serialized = boundary.write.mock.calls[0]![1] as string;
    return {
      isFile: () => true,
      isSymbolicLink: () => false,
      nlink: 1,
      size: Buffer.byteLength(serialized),
      mode: 0o600,
    };
  });
});

describe("closed host classification", () => {
  const crabbox = () => ({
    AGENTSCOPE_INTEGRATION_EXECUTOR: "crabbox",
    CRABBOX_LEASE_ID: "cbx_exact",
    CRABBOX_RUN_ID: "run_exact",
    CRABBOX_SLUG: "owner/workload",
  });
  it("retains an immutable exact Crabbox identity without ambient fields", () => {
    const selected = inferModeAndIdentity({ ...crabbox(), EXTRA: "untrusted" });
    expect(selected.mode).toBe("crabbox");
    expect(selected.hostKind).toBe("crabbox");
    expect(selected.identity).toEqual({
      CRABBOX_LEASE_ID: "cbx_exact",
      CRABBOX_RUN_ID: "run_exact",
      CRABBOX_SLUG: "owner/workload",
    });
    expect(Object.isFrozen(selected.identity)).toBe(true);
  });
  it.each(["CRABBOX_LEASE_ID", "CRABBOX_RUN_ID", "CRABBOX_SLUG"])(
    "rejects absent, empty, oversized and malformed %s",
    (field) => {
      for (const value of [undefined, "", "x".repeat(1025), "!invalid"])
        expect(() =>
          inferModeAndIdentity({ ...crabbox(), [field]: value }),
        ).toThrow("disposable-host-identity");
    },
  );
});

describe("closed Git credential boundary", () => {
  it("uses only the absolute Git tool, closed environment and original bound", () => {
    boundary.exec.mockReturnValue(" exact\n");
    expect(git("/owned/repository", ["rev-parse", "HEAD"], 17)).toBe("exact");
    expect(boundary.exec).toHaveBeenCalledWith(
      "/usr/bin/git",
      ["rev-parse", "HEAD"],
      {
        cwd: "/owned/repository",
        encoding: "utf8",
        timeout: 17,
        env: {
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          LANG: "C.UTF-8",
          PATH: "/usr/bin:/bin",
        },
      },
    );
  });
  it.each([0, -1, 30_001, 1.5, NaN, Infinity])(
    "rejects invalid bound %s before executing Git",
    (bound) => {
      expect(() => git("/owned/repository", ["status"], bound)).toThrow(
        "integration.controller.deadline",
      );
      expect(boundary.exec).not.toHaveBeenCalled();
    },
  );
  it.each([
    "credential.helper\nstore",
    "HTTP.extraheader\nauthorization",
    "include.path\n/foreign/config",
    "includeif.gitdir:/foreign.path\nx",
    "url.foreign.insteadof\nhttps://example.invalid",
    "core.sshcommand\nssh",
    "remote.origin.url\nhttps://user@example.invalid/repository",
    "credential.helper",
  ])("rejects credential or indirection entry %s", (entry) => {
    boundary.exec.mockReturnValue(`${entry}\0`);
    expect(hasCredentialGitState("/owned/repository")).toBe(true);
  });
  it("accepts unrelated local configuration but propagates Git failure", () => {
    boundary.exec.mockReturnValue(
      "core.bare\nfalse\0remote.origin.url\nhttps://example.invalid/repo\0",
    );
    expect(hasCredentialGitState("/owned/repository")).toBe(false);
    boundary.exec.mockImplementation(() => {
      throw new Error("git-failed");
    });
    expect(() => hasCredentialGitState("/owned/repository")).toThrow(
      "git-failed",
    );
  });
});

describe("pre-authority credential refusal publication", () => {
  it("publishes only the exact refusal with durable exclusive no-follow files", () => {
    publishCredentialPreflightFailure(
      publicationEnvironment(),
      credentialFailure(),
    );
    const [descriptor, serialized] = boundary.write.mock.calls[0]! as [
      number,
      string,
    ];
    expect(descriptor).toBe(11);
    expect(JSON.parse(serialized)).toEqual({
      certificationCase: "credential-presence",
      certificationPredicate: "credential-environment",
      controllerPreflightFailureVersion: 1,
      githubSha: "a".repeat(40),
      mutationAuthority: "not-created",
      primaryFailure: credentialFailure().message,
    });
    expect(boundary.open.mock.calls[0]![1]).toBe(
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_WRONLY,
    );
    expect(boundary.open.mock.calls[0]![2]).toBe(0o600);
    expect(boundary.sync.mock.calls).toEqual([[11], [12]]);
    expect(boundary.close.mock.calls).toEqual([[11], [12]]);
    expect(boundary.link).toHaveBeenCalledTimes(1);
    expect(boundary.remove).toHaveBeenCalledTimes(1);
    expect(boundary.exec).not.toHaveBeenCalled();
  });
  it("ignores other failures and unauthenticated selectors without I/O", () => {
    for (const error of [null, "credential", new Error("foreign")])
      publishCredentialPreflightFailure(publicationEnvironment(), error);
    for (const environment of [
      {},
      { ...publicationEnvironment(), GITHUB_SHA: "bad" },
      {
        ...publicationEnvironment(),
        AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE: "foreign",
      },
    ])
      publishCredentialPreflightFailure(environment, credentialFailure());
    expect(boundary.mkdir).not.toHaveBeenCalled();
  });
  it("rejects substituted directory and cleans only its temporary pathname", () => {
    boundary.status.mockReturnValue({
      isDirectory: () => true,
      isSymbolicLink: () => true,
    });
    expect(() => {
      publishCredentialPreflightFailure(
        publicationEnvironment(),
        credentialFailure(),
      );
    }).toThrow("integration.certification.preflight-evidence");
    expect(boundary.open).not.toHaveBeenCalled();
    expect(boundary.remove.mock.calls[0]![0]).toMatch(
      /\.controller-preflight-failure\.\d+\.tmp$/u,
    );
  });
  it("joins open descriptors when an exclusive publication fails", () => {
    boundary.link.mockImplementation(() => {
      throw new Error("target-exists");
    });
    expect(() => {
      publishCredentialPreflightFailure(
        publicationEnvironment(),
        credentialFailure(),
      );
    }).toThrow("integration.certification.preflight-evidence");
    expect(boundary.close.mock.calls).toEqual([[11]]);
    expect(boundary.remove.mock.calls[0]![1]).toEqual({ force: true });
  });
  it("closes the owned file descriptor when writing fails before publication", () => {
    boundary.write.mockImplementation(() => {
      throw new Error("write-failed");
    });
    expect(() => {
      publishCredentialPreflightFailure(
        publicationEnvironment(),
        credentialFailure(),
      );
    }).toThrow("integration.certification.preflight-evidence");
    expect(boundary.close.mock.calls).toEqual([[11]]);
    expect(boundary.link).not.toHaveBeenCalled();
    expect(boundary.sync).not.toHaveBeenCalled();
  });
  it("rejects mismatched terminal file identity and closes directory authority", () => {
    boundary.status.mockReturnValueOnce(directoryStatus()).mockReturnValue({
      isFile: () => true,
      isSymbolicLink: () => false,
      nlink: 2,
      size: 0,
      mode: 0o644,
    });
    expect(() => {
      publishCredentialPreflightFailure(
        publicationEnvironment(),
        credentialFailure(),
      );
    }).toThrow("integration.certification.preflight-evidence");
    expect(boundary.close.mock.calls).toEqual([[11], [12]]);
  });
});
