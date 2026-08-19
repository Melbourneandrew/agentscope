import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  probeGitForTesting,
  resolveGitContextForCore,
  resolveGitContextForTesting,
} from "./git-context.js";

// Exact Git availability and detached-head evidence for AC-CAP-002.1,
// AC-CAP-002.2, and AC-CAP-002.7.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const fixture = async () => {
  const repository = await mkdtemp(join(tmpdir(), "agentscope-git-"));
  roots.push(repository);
  const workspace = join(repository, "nested");
  const commonDirectory = join(repository, ".git");
  await mkdir(workspace);
  await mkdir(commonDirectory);
  return { repository, workspace, commonDirectory };
};

const gitFixtureEnvironment = (
  repository: string,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(inherited).filter(([key]) => !key.startsWith("GIT_")),
  ),
  GIT_CEILING_DIRECTORIES: dirname(repository),
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
  GIT_TERMINAL_PROMPT: "0",
});

const runFixtureGit = (
  repository: string,
  arguments_: readonly string[],
  inherited?: NodeJS.ProcessEnv,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/git",
      ["-C", repository, ...arguments_],
      { env: gitFixtureEnvironment(repository, inherited), encoding: "utf8" },
      (error, stdout) => {
        if (error === null) resolve(stdout);
        else reject(new Error("git fixture failed", { cause: error }));
      },
    );
  });

describe("snapshot-bound Git context observations", () => {
  it("records attached and detached field closures with exact provenance", async () => {
    const value = await fixture();
    for (const head of ["main", null] as const) {
      const result = await resolveGitContextForTesting({
        candidates: [{ path: value.workspace, source: "hook-payload" }],
        gitExecutable: "/usr/bin/git",
        remainingMilliseconds: 1_000,
        probe: () =>
          Promise.resolve({
            worktree: value.repository,
            commonDirectory: value.commonDirectory,
            revision: "a".repeat(40),
            head,
          }),
      });
      expect(
        result.fields.find(
          ({ field }) => field === "agentscope.workspace.directory",
        ),
      ).toMatchObject({
        provenance: { source: "hook-payload" },
      });
      expect(
        result.fields.find(({ field }) => field === "vcs.ref.head.revision"),
      ).toMatchObject({
        provenance: { source: "git" },
      });
      const headUnavailable = result.unavailable.find(
        ({ field }) => field === "vcs.ref.head.name",
      );
      expect(headUnavailable).toEqual(
        head === null
          ? {
              field: "vcs.ref.head.name",
              source: "git",
              state: "not-applicable",
              reason: "detached-head",
            }
          : undefined,
      );
      expect(
        result.unavailable.some(({ field }) => field === "vcs.ref.type"),
      ).toBe(head === null);
      expect(Object.isFrozen(result)).toBe(true);
    }
  });
});

describe("snapshot-bound Git context failure closure", () => {
  it("uses candidate precedence and preserves workspace when Git fails", async () => {
    const value = await fixture();
    const workspace = await realpath(value.workspace);
    const result = await resolveGitContextForTesting({
      candidates: [
        { path: join(value.repository, "missing"), source: "hook-payload" },
        { path: value.workspace, source: "native-artifact" },
      ],
      gitExecutable: "/usr/bin/git",
      remainingMilliseconds: 1_000,
      probe: () => Promise.reject(new Error("CANARY_SECRET")),
    });
    expect(result.fields).toEqual([
      {
        field: "agentscope.workspace.directory",
        value: workspace,
        provenance: {
          field: "agentscope.workspace.directory",
          source: "native-artifact",
        },
      },
    ]);
    expect(result.unavailable).toHaveLength(5);
    expect(JSON.stringify(result)).not.toContain("CANARY_SECRET");
  });

  it("rejects repository mismatch, malformed revisions, abort, and no workspace", async () => {
    const value = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "agentscope-outside-"));
    roots.push(outside);
    const cases = [
      {
        worktree: outside,
        commonDirectory: value.commonDirectory,
        revision: "a".repeat(40),
        head: "main",
      },
      {
        worktree: value.repository,
        commonDirectory: value.commonDirectory,
        revision: "not-a-revision",
        head: "main",
      },
    ];
    for (const probeResult of cases) {
      const result = await resolveGitContextForTesting({
        candidates: [{ path: value.workspace, source: "process" }],
        gitExecutable: "/usr/bin/git",
        remainingMilliseconds: 1_000,
        probe: () => Promise.resolve(probeResult),
      });
      expect(result.fields).toHaveLength(1);
      expect(result.unavailable).toHaveLength(5);
    }
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const aborted = await resolveGitContextForTesting({
      candidates: [{ path: value.workspace, source: "process" }],
      gitExecutable: "/usr/bin/git",
      remainingMilliseconds: 1_000,
      signal: controller.signal,
      probe: () => {
        calls += 1;
        return Promise.reject(new Error("unreachable"));
      },
    });
    expect(calls).toBe(0);
    expect(aborted.unavailable).toHaveLength(5);
    const missing = await resolveGitContextForTesting({
      candidates: [],
      gitExecutable: "/usr/bin/git",
      remainingMilliseconds: 1_000,
      probe: () => Promise.reject(new Error("unreachable")),
    });
    expect(missing.fields).toEqual([]);
    expect(missing.unavailable).toHaveLength(6);
    const absent = await resolveGitContextForTesting({
      candidates: [
        { path: join(value.repository, "still-missing"), source: "process" },
      ],
      gitExecutable: "/usr/bin/git",
      remainingMilliseconds: 1_000,
      probe: () => Promise.reject(new Error("unreachable")),
    });
    expect(absent.fields).toEqual([]);
    expect(absent.unavailable).toHaveLength(6);
  });
});

describe("snapshot-bound path worker failure closure", () => {
  it("contains path-worker failure before and after Git observation", async () => {
    const value = await fixture();
    const failed = await resolveGitContextForTesting({
      candidates: [{ path: value.workspace, source: "process" }],
      gitExecutable: "/usr/bin/git",
      remainingMilliseconds: 1_000,
      probe: () => Promise.reject(new Error("unreachable")),
      inspectPaths: () => Promise.reject(new Error("worker failed")),
    });
    expect(failed.fields).toEqual([]);
    expect(failed.unavailable).toHaveLength(6);
    let inspections = 0;
    await expect(
      resolveGitContextForTesting({
        candidates: [{ path: value.workspace, source: "process" }],
        gitExecutable: "/usr/bin/git",
        remainingMilliseconds: 1_000,
        probe: () =>
          Promise.resolve({
            worktree: value.repository,
            commonDirectory: value.commonDirectory,
            revision: "a".repeat(40),
            head: "main",
          }),
        inspectPaths: () => {
          inspections += 1;
          return Promise.resolve(
            inspections === 1
              ? { kind: "workspace", index: 0, path: value.workspace }
              : null,
          );
        },
      }),
    ).resolves.toMatchObject({ fields: [{ value: value.workspace }] });
    for (const inspected of [
      { kind: "workspace" as const, index: 99, path: value.workspace },
      { kind: "workspace" as const, index: 0, path: "x".repeat(4_097) },
    ])
      await expect(
        resolveGitContextForTesting({
          candidates: [{ path: value.workspace, source: "process" }],
          gitExecutable: "/usr/bin/git",
          remainingMilliseconds: 1_000,
          probe: () => Promise.reject(new Error("unreachable")),
          inspectPaths: () => Promise.resolve(inspected),
        }),
      ).resolves.toMatchObject({ fields: [] });
  });
});

describe("snapshot-bound Git command failure closure", () => {
  it("rejects invalid workspace candidates and malformed command output", async () => {
    const value = await fixture();
    const ordinaryFile = join(value.repository, "ordinary-file");
    await writeFile(ordinaryFile, "not a directory");
    const selected = await resolveGitContextForTesting({
      candidates: [
        { path: "", source: "hook-payload" },
        { path: "relative", source: "native-artifact" },
        { path: "x".repeat(4_097), source: "process" },
        { path: ordinaryFile, source: "process" },
        { path: value.workspace, source: "process" },
      ],
      gitExecutable: "/usr/bin/git",
      remainingMilliseconds: 1_000,
      probe: () => Promise.reject(new Error("expected")),
    });
    expect(selected.fields).toHaveLength(1);
    for (const mode of [
      "extra-path",
      "missing-status",
      "missing-head",
      "detached",
    ] as const) {
      const paths =
        mode === "extra-path"
          ? `${value.repository}\n${value.commonDirectory}\nextra\n`
          : `${value.repository}\n${value.commonDirectory}\n`;
      const operation = probeGitForTesting({
        executable: "/usr/bin/git",
        workspace: value.workspace,
        timeoutMilliseconds: 1_000,
        execute: (_executable, arguments_) =>
          Promise.resolve({
            stdout: arguments_.includes("--path-format=absolute")
              ? paths
              : arguments_.includes("--verify")
                ? mode === "missing-status"
                  ? ""
                  : `${"a".repeat(40)}\n`
                : mode === "missing-head"
                  ? ""
                  : `${mode === "detached" ? "HEAD" : "refs/heads/main"}\n`,
          }),
      });
      if (mode === "detached")
        await expect(operation).resolves.toMatchObject({ head: null });
      else await expect(operation).rejects.toThrow("core.git.invalid");
    }
    const unavailable = await resolveGitContextForCore({
      candidates: [{ path: value.workspace, source: "process" }],
      gitExecutable: "/not/a/git",
      remainingMilliseconds: 1_000,
    });
    expect(unavailable.unavailable).toHaveLength(5);
  });

  it("uses only non-worktree plumbing and disables repository fsmonitor execution", async () => {
    const repository = await mkdtemp(join(tmpdir(), "agentscope-hostile-git-"));
    roots.push(repository);
    await runFixtureGit(repository, ["init", "-q"]);
    await runFixtureGit(repository, [
      "config",
      "user.email",
      "fixture@example.invalid",
    ]);
    await runFixtureGit(repository, ["config", "user.name", "Fixture"]);
    await runFixtureGit(repository, [
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    ]);
    await runFixtureGit(repository, [
      "config",
      "core.fsmonitor",
      "/usr/bin/touch",
    ]);
    const result = await resolveGitContextForCore({
      candidates: [{ path: repository, source: "process" }],
      gitExecutable: "/usr/bin/git",
      remainingMilliseconds: 2_000,
    });
    expect(
      result.fields.find(({ field }) => field === "vcs.ref.head.revision"),
    ).toBeDefined();
    const entries = await readdir(repository);
    expect(entries).toEqual([".git"]);
  });
});

describe("real Git fixture isolation", () => {
  it("isolates fixture commands from inherited Git hook repository authority", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "agentscope-checkout-"));
    const repository = await mkdtemp(join(tmpdir(), "agentscope-git-fixture-"));
    roots.push(checkout, repository);
    await runFixtureGit(checkout, ["init", "-q"]);
    await runFixtureGit(checkout, [
      "config",
      "user.email",
      "checkout@example.invalid",
    ]);
    await runFixtureGit(checkout, ["config", "user.name", "Checkout"]);
    const sentinelDirectory = join(checkout, "nested");
    const sentinelPath = join(sentinelDirectory, "sentinel.txt");
    await mkdir(sentinelDirectory);
    await writeFile(sentinelPath, "checkout sentinel\n", "utf8");
    await chmod(sentinelPath, 0o640);
    await runFixtureGit(checkout, ["add", "nested/sentinel.txt"]);
    await runFixtureGit(checkout, ["commit", "-qm", "checkout"]);
    const checkoutHead = await runFixtureGit(checkout, ["rev-parse", "HEAD"]);
    const checkoutReflog = await runFixtureGit(checkout, ["reflog", "show"]);
    const checkoutConfig = await runFixtureGit(checkout, [
      "config",
      "--local",
      "--list",
    ]);
    const checkoutStatus = await runFixtureGit(checkout, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const checkoutTree = await runFixtureGit(checkout, ["write-tree"]);
    const sentinelBytes = await readFile(sentinelPath);
    const sentinelMode = (await stat(sentinelPath)).mode & 0o777;
    const checkoutEntries = await readdir(checkout);
    const inherited = {
      ...process.env,
      GIT_COMMON_DIR: join(checkout, ".git"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: join(checkout, "synthetic-hooks"),
      GIT_DIR: join(checkout, ".git"),
      GIT_INDEX_FILE: join(checkout, ".git", "index"),
      GIT_PREFIX: "synthetic-prefix/",
      GIT_WORK_TREE: checkout,
    };
    await runFixtureGit(repository, ["init", "-q"], inherited);
    await runFixtureGit(
      repository,
      ["config", "user.email", "fixture@example.invalid"],
      inherited,
    );
    await runFixtureGit(
      repository,
      ["config", "user.name", "Fixture"],
      inherited,
    );
    await runFixtureGit(
      repository,
      ["commit", "--allow-empty", "-qm", "fixture"],
      inherited,
    );
    expect(
      await runFixtureGit(repository, ["rev-parse", "HEAD"], inherited),
    ).toMatch(/^[a-f0-9]{40}\n$/u);
    expect(await runFixtureGit(checkout, ["rev-parse", "HEAD"])).toBe(
      checkoutHead,
    );
    expect(await runFixtureGit(checkout, ["reflog", "show"])).toBe(
      checkoutReflog,
    );
    expect(await runFixtureGit(checkout, ["config", "--local", "--list"])).toBe(
      checkoutConfig,
    );
    expect(
      await runFixtureGit(checkout, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
    ).toBe(checkoutStatus);
    expect(await runFixtureGit(checkout, ["write-tree"])).toBe(checkoutTree);
    expect(await readFile(sentinelPath)).toEqual(sentinelBytes);
    expect((await stat(sentinelPath)).mode & 0o777).toBe(sentinelMode);
    expect(await readdir(checkout)).toEqual(checkoutEntries);
  });
});

describe("snapshot-bound Git command timeout closure", () => {
  it("shares one elapsed timeout across every sequential Git command", async () => {
    const observedTimeouts: number[] = [];
    let calls = 0;
    let elapsed = 0;
    const operation = probeGitForTesting({
      executable: "/usr/bin/git",
      workspace: "/workspace",
      timeoutMilliseconds: 50,
      now: () => elapsed,
      execute: (_executable, arguments_, options) => {
        observedTimeouts.push(options.timeout as number);
        calls += 1;
        elapsed += 30;
        return Promise.resolve({
          stdout: arguments_.includes("--path-format=absolute")
            ? "/workspace\n/workspace/.git\n"
            : arguments_.includes("--verify")
              ? `${"a".repeat(40)}\n`
              : "refs/heads/main\n",
        });
      },
    });
    await expect(operation).rejects.toThrow("core.git.unavailable");
    expect(calls).toBe(2);
    expect(observedTimeouts[0]).toBeLessThanOrEqual(50);
    expect(observedTimeouts[1]).toBeLessThan(observedTimeouts[0]!);
  });
});
