import { execFile as nodeExecFile } from "node:child_process";
import { realpath as nodeRealpath, stat as nodeStat } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import { promisify } from "node:util";

import type {
  CoreContextField,
  CoreContextUnavailable,
} from "../capture/types.js";
import {
  inspectPathsInChildForCore,
  type PathInspectionRequest,
  type PathInspectionResponse,
} from "./path-inspection.js";

const execFile = promisify(nodeExecFile);
const MAXIMUM_PATH_CODE_UNITS = 4_096;
const MAXIMUM_GIT_OUTPUT_BYTES = 32_768;
const MAXIMUM_GIT_STAGE_MILLISECONDS = 500;
const revisionPattern = /^[0-9a-f]{40,64}$/u;

export type WorkspaceCandidate = Readonly<{
  path: string;
  source: "hook-payload" | "native-artifact" | "process";
}>;

export type GitContextSnapshot = Readonly<{
  fields: readonly CoreContextField[];
  unavailable: readonly CoreContextUnavailable[];
}>;

type GitProbeResult = Readonly<{
  worktree: string;
  commonDirectory: string;
  revision: string;
  head: string | null;
}>;

type GitProbe = (
  executable: string,
  workspace: string,
  timeoutMilliseconds: number,
  signal?: AbortSignal,
) => Promise<GitProbeResult>;

type GitCommandExecutor = (
  executable: string,
  arguments_: readonly string[],
  options: Readonly<Record<string, unknown>>,
) => Promise<Readonly<{ stdout: string }>>;

type PathInspector = (
  request: PathInspectionRequest,
  timeoutMilliseconds: number,
  signal?: AbortSignal,
) => Promise<PathInspectionResponse>;

const unavailable = (
  field: string,
  source: CoreContextUnavailable["source"],
): CoreContextUnavailable =>
  Object.freeze({
    field,
    source,
    state: "unavailable",
    reason: "resolution-failed",
  });

const gitUnavailable = (): readonly CoreContextUnavailable[] =>
  Object.freeze(
    [
      "agentscope.git.worktree",
      "agentscope.git.repository_root",
      "vcs.ref.head.name",
      "vcs.ref.head.revision",
      "vcs.ref.type",
    ].map((field) => unavailable(field, "git")),
  );

const field = (
  key: string,
  value: string,
  source: CoreContextField["provenance"]["source"],
): CoreContextField =>
  Object.freeze({
    field: key,
    value,
    provenance: Object.freeze({ field: key, source }),
  });

const boundedOutput = (value: string) => {
  /* v8 ignore next 2 -- execFile enforces the identical maxBuffer before this defense-in-depth check. */
  if (Buffer.byteLength(value) > MAXIMUM_GIT_OUTPUT_BYTES)
    throw new Error("core.git.invalid");
  return value;
};

const runGitWithExecutor = async (
  executable: string,
  workspace: string,
  timeoutMilliseconds: number,
  signal: AbortSignal | undefined,
  execute: GitCommandExecutor,
): Promise<GitProbeResult> => {
  const startedAt = performance.now();
  const remaining = (): number =>
    Math.max(
      0,
      Math.floor(timeoutMilliseconds - (performance.now() - startedAt)),
    );
  /* v8 ignore next -- exactly one platform-specific null device is active per test process. */
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const executeWithinBudget = (arguments_: readonly string[]) => {
    const timeout = remaining();
    if (timeout <= 0 || signal?.aborted === true)
      return Promise.reject(new Error("core.git.unavailable"));
    return execute(executable, arguments_, {
      cwd: workspace,
      env: Object.freeze({
        GIT_CONFIG_GLOBAL: nullDevice,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        PATH: "/usr/bin:/bin",
      }),
      encoding: "utf8" as const,
      maxBuffer: MAXIMUM_GIT_OUTPUT_BYTES,
      timeout,
      windowsHide: true,
      ...(signal === undefined ? {} : { signal }),
    });
  };
  const paths = await executeWithinBudget([
    "-c",
    "credential.helper=",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-C",
    workspace,
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
  ]);
  const revisionResult = await executeWithinBudget([
    "-c",
    "credential.helper=",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-C",
    workspace,
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  const headResult = await executeWithinBudget([
    "-c",
    "credential.helper=",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-C",
    workspace,
    "rev-parse",
    "--symbolic-full-name",
    "HEAD",
  ]);
  const pathLines = boundedOutput(paths.stdout).trimEnd().split("\n");
  if (pathLines.length !== 2)
    /* v8 ignore next -- malformed path output is exercised through the fixed unavailable result. */
    throw new Error("core.git.invalid");
  const [worktree, commonDirectory] = pathLines as [string, string];
  const revision = boundedOutput(revisionResult.stdout).trim();
  const symbolicHead = boundedOutput(headResult.stdout).trim();
  const head =
    symbolicHead === "HEAD"
      ? null
      : symbolicHead.replace(/^refs\/heads\//u, "");
  if (
    revision.length === 0 ||
    symbolicHead.length === 0 ||
    (symbolicHead !== "HEAD" && !symbolicHead.startsWith("refs/heads/"))
  )
    /* v8 ignore next -- incomplete status output is exercised through the fixed unavailable result. */
    throw new Error("core.git.invalid");
  return { worktree, commonDirectory, revision, head };
};

const executeGit: GitCommandExecutor = async (
  executable,
  arguments_,
  options,
) => {
  const result = await execFile(executable, [...arguments_], options as never);
  return { stdout: result.stdout as unknown as string };
};

const runGit: GitProbe = (executable, workspace, timeoutMilliseconds, signal) =>
  runGitWithExecutor(
    executable,
    workspace,
    timeoutMilliseconds,
    signal,
    executeGit,
  );

const inspectPathsInProcess: PathInspector = async (request) => {
  if (request.kind === "workspace") {
    for (let index = 0; index < request.paths.length; index += 1) {
      try {
        const path = await nodeRealpath(request.paths[index]!);
        const information = await nodeStat(path);
        if (information.isDirectory())
          return Object.freeze({ kind: "workspace", index, path });
      } catch {
        // Try the next owned candidate.
      }
    }
    return null;
  }
  return Object.freeze({
    kind: "canonicalize",
    worktree: await nodeRealpath(request.worktree),
    repositoryRoot: await nodeRealpath(dirname(request.commonDirectory)),
  });
};

const resolveWorkspace = async (
  candidates: readonly WorkspaceCandidate[],
  timeoutMilliseconds: number,
  signal: AbortSignal | undefined,
  inspectPaths: PathInspector,
): Promise<Readonly<{
  path: string;
  source: WorkspaceCandidate["source"];
}> | null> => {
  const validCandidates = candidates.filter(
    (candidate) =>
      typeof candidate.path === "string" &&
      candidate.path.length > 0 &&
      candidate.path.length <= MAXIMUM_PATH_CODE_UNITS &&
      isAbsolute(candidate.path),
  );
  if (validCandidates.length === 0) return null;
  const inspected = await inspectPaths(
    { kind: "workspace", paths: validCandidates.map(({ path }) => path) },
    timeoutMilliseconds,
    signal,
  );
  if (inspected === null || inspected.kind !== "workspace") return null;
  const selected = validCandidates[inspected.index];
  if (!selected || inspected.path.length > MAXIMUM_PATH_CODE_UNITS) return null;
  return Object.freeze({ path: inspected.path, source: selected.source });
};

const resolveGitContext = async (
  input: Readonly<{
    candidates: readonly WorkspaceCandidate[];
    gitExecutable: string;
    remainingMilliseconds: number;
    signal?: AbortSignal;
    probe: GitProbe;
    inspectPaths: PathInspector;
  }>,
): Promise<GitContextSnapshot> => {
  const startedAt = performance.now();
  const remaining = (): number =>
    Math.max(
      0,
      Math.floor(input.remainingMilliseconds - (performance.now() - startedAt)),
    );
  let workspace;
  try {
    workspace = await resolveWorkspace(
      input.candidates,
      Math.min(remaining(), MAXIMUM_GIT_STAGE_MILLISECONDS),
      input.signal,
      input.inspectPaths,
    );
  } catch {
    workspace = null;
  }
  if (workspace === null)
    return Object.freeze({
      fields: Object.freeze([]),
      unavailable: Object.freeze([
        unavailable("agentscope.workspace.directory", "process"),
        ...gitUnavailable(),
      ]),
    });
  const workspaceField = field(
    "agentscope.workspace.directory",
    workspace.path,
    workspace.source,
  );
  try {
    if (
      !isAbsolute(input.gitExecutable) ||
      remaining() <= 0 ||
      input.signal?.aborted === true
    )
      throw new Error("core.git.unavailable");
    const result = await input.probe(
      input.gitExecutable,
      workspace.path,
      Math.min(remaining(), MAXIMUM_GIT_STAGE_MILLISECONDS),
      input.signal,
    );
    const canonical = await input.inspectPaths(
      {
        kind: "canonicalize",
        worktree: result.worktree,
        commonDirectory: result.commonDirectory,
      },
      Math.min(remaining(), MAXIMUM_GIT_STAGE_MILLISECONDS),
      input.signal,
    );
    if (canonical === null || canonical.kind !== "canonicalize")
      throw new Error("core.git.invalid");
    const { worktree, repositoryRoot } = canonical;
    const workspaceRelative = relative(worktree, workspace.path);
    const belongsToWorktree =
      workspaceRelative === "" ||
      (!workspaceRelative.startsWith("..") && !isAbsolute(workspaceRelative));
    if (
      !belongsToWorktree ||
      !revisionPattern.test(result.revision) ||
      worktree.length > MAXIMUM_PATH_CODE_UNITS ||
      repositoryRoot.length > MAXIMUM_PATH_CODE_UNITS ||
      (result.head !== null &&
        (result.head.length === 0 || result.head.length > 1_024))
    )
      throw new Error("core.git.invalid");
    const fields = [
      workspaceField,
      field("agentscope.git.worktree", worktree, "git"),
      field("agentscope.git.repository_root", repositoryRoot, "git"),
      field("vcs.ref.head.revision", result.revision, "git"),
      ...(result.head === null
        ? []
        : [
            field("vcs.ref.head.name", result.head, "git"),
            field("vcs.ref.type", "branch", "git"),
          ]),
    ];
    return Object.freeze({
      fields: Object.freeze(fields),
      unavailable: Object.freeze(
        result.head === null
          ? [
              Object.freeze({
                field: "vcs.ref.head.name",
                source: "git" as const,
                state: "not-applicable" as const,
                reason: "detached-head" as const,
              }),
              unavailable("vcs.ref.type", "git"),
            ]
          : [],
      ),
    });
  } catch {
    return Object.freeze({
      fields: Object.freeze([workspaceField]),
      unavailable: gitUnavailable(),
    });
  }
};

export const resolveGitContextForCore = (
  input: Readonly<{
    candidates: readonly WorkspaceCandidate[];
    gitExecutable: string;
    remainingMilliseconds: number;
    signal?: AbortSignal;
  }>,
): Promise<GitContextSnapshot> =>
  resolveGitContext({
    ...input,
    probe: runGit,
    inspectPaths: inspectPathsInChildForCore,
  });

export const resolveGitContextForTesting = (
  input: Readonly<{
    candidates: readonly WorkspaceCandidate[];
    gitExecutable: string;
    remainingMilliseconds: number;
    signal?: AbortSignal;
    probe: GitProbe;
    inspectPaths?: PathInspector;
  }>,
): Promise<GitContextSnapshot> =>
  resolveGitContext({
    ...input,
    inspectPaths: input.inspectPaths ?? inspectPathsInProcess,
  });

export const probeGitForTesting = (
  input: Readonly<{
    executable: string;
    workspace: string;
    timeoutMilliseconds: number;
    signal?: AbortSignal;
    execute: GitCommandExecutor;
  }>,
) =>
  runGitWithExecutor(
    input.executable,
    input.workspace,
    input.timeoutMilliseconds,
    input.signal,
    input.execute,
  );
