import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
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
    await new Promise<void>((resolve, reject) => {
      execFile("/usr/bin/git", ["-C", repository, "init", "-q"], (error) => {
        if (error === null) resolve();
        else reject(new Error("git fixture failed", { cause: error }));
      });
    });
    const run = (arguments_: readonly string[]) =>
      new Promise<void>((resolve, reject) => {
        execFile("/usr/bin/git", ["-C", repository, ...arguments_], (error) => {
          if (error === null) resolve();
          else reject(new Error("git fixture failed", { cause: error }));
        });
      });
    await run(["config", "user.email", "fixture@example.invalid"]);
    await run(["config", "user.name", "Fixture"]);
    await run(["commit", "--allow-empty", "-qm", "initial"]);
    await run(["config", "core.fsmonitor", "/usr/bin/touch"]);
    const result = await resolveGitContextForCore({
      candidates: [{ path: repository, source: "process" }],
      gitExecutable: "/usr/bin/git",
      remainingMilliseconds: 1_000,
    });
    expect(
      result.fields.find(({ field }) => field === "vcs.ref.head.revision"),
    ).toBeDefined();
    const entries = await readdir(repository);
    expect(entries).toEqual([".git"]);
  });
});
