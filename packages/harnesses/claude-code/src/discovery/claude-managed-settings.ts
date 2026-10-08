import { dirname, join } from "node:path";
import type {
  HarnessDirectoryInspection,
  HarnessTargetInspection,
} from "@agentscope/harnesses-core";
import type { ClaudeCodePluginSettingsLayer } from "../lifecycle.js";
import {
  type ClaudeCodeDiscoveryReadCapabilities,
  nodeErrorCode,
  type ProductHarnessReadGuard,
} from "./capabilities.js";
import { readClaudePluginSettingsLayer } from "./claude-plugin-inventory.js";

export type ClaudeSettingsDirectorySelection = Readonly<{
  directoryPath: string;
  exists: boolean;
  entries?: readonly string[];
}>;

const unavailable = () => new Error("cli.harness.plugin-inventory-unavailable");

// Pinned Si/Ad/xd: this projects already held ownership facts only. It does
// not observe a path or confer authority on preliminary filesystem metadata.
// The caller must bind every consulted UID to the same Core installation plan.
export const selectClaudeCanonicalLocalRoot = (
  cwd: string,
  candidate: string | null,
  realHome: string | null,
  effectiveUid: number | null,
  ownership?: Readonly<{
    rootUid?: number | null;
    gitEntryUid?: number | null;
    claudeEntryUid?: number | null;
  }>,
): string => {
  if (candidate === null || candidate === cwd) return cwd;
  if (realHome === null || candidate === realHome) return cwd;
  if (
    effectiveUid === null ||
    !Number.isSafeInteger(effectiveUid) ||
    effectiveUid < 0 ||
    ownership?.rootUid !== effectiveUid ||
    ownership.gitEntryUid !== effectiveUid ||
    (ownership.claudeEntryUid !== null &&
      ownership.claudeEntryUid !== effectiveUid)
  )
    return cwd;
  return candidate;
};

// The original installation planner supplies these held observations. Route
// discovery cannot use this helper to substitute lstat ownership or a new plan.
export const selectClaudeCanonicalLocalRootFromHeld = (
  cwd: string,
  candidate: string | null,
  realHome: string | null,
  effectiveUid: number | null,
  held: Readonly<{
    directories: readonly HarnessDirectoryInspection[];
    files: readonly Pick<
      HarnessTargetInspection,
      "targetPath" | "exists" | "uid"
    >[];
  }>,
): string => {
  if (candidate === null || candidate === cwd) return cwd;
  const root = held.directories.filter(
    (entry) => entry.directoryPath === candidate,
  );
  const gitPath = join(candidate, ".git");
  const gitDirectories = held.directories.filter(
    (entry) => entry.directoryPath === gitPath,
  );
  const gitFiles = held.files.filter((entry) => entry.targetPath === gitPath);
  const claude = held.directories.filter(
    (entry) => entry.directoryPath === join(candidate, ".claude"),
  );
  if (
    root.length !== 1 ||
    !root[0]!.exists ||
    claude.length !== 1 ||
    gitDirectories.length + gitFiles.length !== 1
  )
    return cwd;
  const git = gitDirectories[0] ?? gitFiles[0]!;
  const rootUid = root[0]!.uid;
  const gitEntryUid = git.exists ? git.uid : null;
  const claudeEntryUid = claude[0]!.exists ? claude[0]!.uid : null;
  return selectClaudeCanonicalLocalRoot(
    cwd,
    candidate,
    realHome,
    effectiveUid,
    {
      ...(rootUid === undefined ? {} : { rootUid }),
      ...(gitEntryUid === undefined ? {} : { gitEntryUid }),
      ...(claudeEntryUid === undefined ? {} : { claudeEntryUid }),
    },
  );
};

export const claudeManagedSettingsPath = (
  platform: NodeJS.Platform,
): string => {
  if (platform === "darwin")
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "linux") return "/etc/claude-code/managed-settings.json";
  throw unavailable();
};

export const readClaudeScopedSettings = async (
  capabilities: ClaudeCodeDiscoveryReadCapabilities,
  userPath: string,
  project: string,
  managedPaths: readonly string[],
  localRoot: string = project,
): Promise<
  Readonly<{
    guard: ProductHarnessReadGuard;
    layer: ClaudeCodePluginSettingsLayer;
  }>[]
> => {
  const cwdLocal = join(project, ".claude", "settings.local.json");
  const selectedLocal = join(localRoot, ".claude", "settings.local.json");
  const locations = [
    ["user", userPath],
    ["project", join(project, ".claude", "settings.json")],
    // Native Ei/Xd preserve cwd local before canonical local, in the SAME scope.
    // Only this local pair is deduplicated; user/project aliases retain scopes.
    ...(cwdLocal === selectedLocal ? [] : [["local", cwdLocal] as const]),
    ["local", selectedLocal],
    ...managedPaths.map((path) => ["managed", path] as const),
  ] as const;
  const observed = [];
  for (const [scope, path] of locations)
    observed.push(
      await readClaudePluginSettingsLayer(capabilities, path, scope),
    );
  return observed;
};

export const snapshotClaudeSettingsDirectorySelections = (
  selections: readonly ClaudeSettingsDirectorySelection[] = [],
) =>
  Object.freeze(
    selections.map((selection) =>
      Object.freeze({
        ...selection,
        ...(selection.entries === undefined
          ? {}
          : { entries: Object.freeze([...selection.entries]) }),
      }),
    ),
  );

export const mergeClaudeSettingsDirectorySelections = (
  groups: readonly (readonly ClaudeSettingsDirectorySelection[])[],
): readonly ClaudeSettingsDirectorySelection[] => {
  const selected = new Map<string, ClaudeSettingsDirectorySelection>();
  for (const group of groups) {
    for (const entry of snapshotClaudeSettingsDirectorySelections(group)) {
      const previous = selected.get(entry.directoryPath);
      if (
        previous !== undefined &&
        (previous.exists !== entry.exists ||
          (previous.entries !== undefined &&
            entry.entries !== undefined &&
            JSON.stringify(previous.entries) !== JSON.stringify(entry.entries)))
      )
        throw unavailable();
      selected.set(
        entry.directoryPath,
        Object.freeze({
          ...entry,
          ...(previous?.entries === undefined
            ? {}
            : { entries: previous.entries }),
        }),
      );
    }
  }
  return Object.freeze([...selected.values()]);
};

export const claudeDirectoryDependencies = (
  selections: readonly ClaudeSettingsDirectorySelection[] | undefined,
  electionPaths: readonly string[],
) => {
  const settingsSelections =
    snapshotClaudeSettingsDirectorySelections(selections);
  return Object.freeze({
    settingsSelections,
    directoryPaths: Object.freeze([
      ...new Set([
        ...electionPaths,
        ...settingsSelections.map((selection) => selection.directoryPath),
      ]),
    ]),
  });
};

// Preliminary route discovery, not a Core observation or mutation authority.
// The existing installation plan must reopen and bind this directory plus
// every selected regular file before any owned target can be changed.
export const discoverClaudeManagedSettings = async (
  capabilities: ClaudeCodeDiscoveryReadCapabilities,
  mainPath: string,
) => {
  const directoryPath = join(dirname(mainPath), "managed-settings.d");
  let before;
  try {
    before = await capabilities.inspectPath(directoryPath);
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw unavailable();
    return Object.freeze({
      paths: Object.freeze([mainPath]),
      ignoredDirectories: Object.freeze([] as string[]),
      selection: Object.freeze({
        directoryPath,
        exists: false,
        entries: Object.freeze([] as string[]),
      }),
    });
  }
  if (!(before.kind === "directory") || before.symbolicLink)
    throw unavailable();
  const entries = [
    ...(await capabilities.readDirectoryEntries(directoryPath)),
  ].sort();
  const candidates = entries.filter(
    (name) => !name.startsWith(".") && name.endsWith(".json"),
  );
  // Three lower semantic scopes plus managed main share the component's
  // thirteen-row bound. Core separately enforces its total consulted paths.
  const selected: string[] = [];
  const ignoredDirectories: string[] = [];
  for (const name of candidates) {
    const state = await capabilities.inspectPath(join(directoryPath, name));
    if (state.kind === "directory" && !state.symbolicLink) {
      ignoredDirectories.push(join(directoryPath, name));
      continue;
    }
    // Native may follow a drop-in symlink, but the current Core transaction
    // cannot bind that file. Report this concrete observation as unavailable.
    if (!(state.kind === "file") || state.symbolicLink) throw unavailable();
    selected.push(name);
    if (selected.length > 9) throw unavailable();
  }
  const after = await capabilities.inspectPath(directoryPath);
  if (
    !(after.kind === "directory") ||
    after.symbolicLink ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw unavailable();
  return Object.freeze({
    paths: Object.freeze([
      mainPath,
      ...selected.map((name) => join(directoryPath, name)),
    ]),
    ignoredDirectories: Object.freeze(ignoredDirectories),
    selection: Object.freeze({
      directoryPath,
      exists: true,
      entries: Object.freeze(entries),
    }),
  });
};

export const claudeSettingsDirectoriesAgree = (
  selections: readonly ClaudeSettingsDirectorySelection[],
  observed: readonly HarnessDirectoryInspection[],
): boolean =>
  selections.every((selection) => {
    const matches = observed.filter(
      (entry) => entry.directoryPath === selection.directoryPath,
    );
    if (matches.length !== 1 || matches[0]!.exists !== selection.exists)
      return false;
    // Native ignores a .json directory regardless of its contents. Core still
    // binds its type/physical identity so it cannot become a selected file.
    const expected = selection.entries;
    if (expected === undefined) return true;
    const names = [...matches[0]!.entries].sort();
    return (
      names.length === expected.length &&
      names.every((name, index) => name === expected[index])
    );
  });
