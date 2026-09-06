import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, posix, resolve } from "node:path";
import { parse } from "yaml";

const workspaceDefinitionMaximumBytes = 16 * 1024;
const workspaceManifestMaximumBytes = 64 * 1024;
const workspacePatternMaximumCount = 32;
const workspacePatternMaximumLength = 256;
const workspaceDirectoryEntryMaximumCount = 1_024;
const workspacePackageMaximumCount = 256;
const workspacePattern = /^(?:[A-Za-z0-9._-]+\/)*\*$/u;

function sameObjectIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileGeneration(left, right) {
  return (
    sameObjectIdentity(left, right) &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

function identity(stat, path) {
  return {
    ctimeNs: stat.ctimeNs,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
    path,
    size: stat.size,
  };
}

function snapshotDirectory(path, label) {
  const snapshot = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!snapshot?.isDirectory() || snapshot.isSymbolicLink()) {
    throw new Error(`${label} must be a no-follow directory`);
  }
  return identity(snapshot, path);
}

function assertDirectoryIdentity(snapshot, label) {
  const current = lstatSync(snapshot.path, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    !current?.isDirectory() ||
    current.isSymbolicLink() ||
    !sameObjectIdentity(snapshot, current)
  ) {
    throw new Error(`${label} directory identity changed during discovery`);
  }
}

function assertDirectoryGeneration(snapshot, label) {
  const current = lstatSync(snapshot.path, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    !current?.isDirectory() ||
    current.isSymbolicLink() ||
    !sameFileGeneration(snapshot, current)
  ) {
    throw new Error(`${label} directory generation changed during discovery`);
  }
}

function snapshotAbsoluteDirectoryPath(path, label) {
  const paths = [];
  let current = resolve(path);
  while (true) {
    paths.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths.reverse().map((entry) => snapshotDirectory(entry, label));
}

function lexicalPathEntries(path) {
  const paths = [];
  let current = resolve(path);
  while (true) {
    paths.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths.reverse();
}

function snapshotLexicalWorkspacePath(path) {
  const entries = lexicalPathEntries(path);
  return entries.map((entry, index) => {
    const snapshot = lstatSync(entry, {
      bigint: true,
      throwIfNoEntry: false,
    });
    const final = index === entries.length - 1;
    if (
      snapshot === undefined ||
      (final
        ? !snapshot.isDirectory() || snapshot.isSymbolicLink()
        : !snapshot.isDirectory() && !snapshot.isSymbolicLink())
    ) {
      throw new Error(
        final
          ? "Requested workspace root must be a no-follow directory"
          : `Requested workspace root ancestor is invalid: ${entry}`,
      );
    }
    return {
      ...identity(snapshot, entry),
      final,
      symbolicLink: snapshot.isSymbolicLink(),
    };
  });
}

function assertLexicalWorkspacePath(snapshots) {
  for (const snapshot of snapshots) {
    const current = lstatSync(snapshot.path, {
      bigint: true,
      throwIfNoEntry: false,
    });
    const validType = snapshot.final
      ? current?.isDirectory() && !current.isSymbolicLink()
      : current?.isDirectory() || current?.isSymbolicLink();
    const sameGeneration =
      snapshot.final || snapshot.symbolicLink
        ? current !== undefined && sameFileGeneration(snapshot, current)
        : current !== undefined && sameObjectIdentity(snapshot, current);
    if (!validType || !sameGeneration) {
      throw new Error(
        "Requested workspace root generation changed during resolution",
      );
    }
  }
}

function validateRelativePath(path, label) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    posix.normalize(path) !== path ||
    path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a normalized relative path`);
  }
}

function snapshotDirectoryPath(workspaceRoot, relativePath, label) {
  validateRelativePath(relativePath, label);
  const snapshots = [snapshotDirectory(workspaceRoot, "Workspace root")];
  let current = workspaceRoot;
  for (const segment of relativePath.split("/")) {
    current = resolve(current, segment);
    snapshots.push(snapshotDirectory(current, label));
  }
  return snapshots;
}

function assertDirectoryPathIdentities(snapshots, label) {
  for (const snapshot of snapshots) assertDirectoryIdentity(snapshot, label);
}

function readBoundedRegularFile(
  path,
  maximumBytes,
  label,
  expectedIdentity = undefined,
) {
  const before = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!before?.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} must be a no-follow regular file`);
  }
  if (before.size > BigInt(maximumBytes)) {
    throw new Error(`${label} exceeds its ${maximumBytes}-byte ceiling`);
  }
  if (
    expectedIdentity !== undefined &&
    !sameFileGeneration(expectedIdentity, before)
  ) {
    throw new Error(`${label} identity changed after workspace discovery`);
  }

  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileGeneration(before, opened)) {
      throw new Error(`${label} identity changed before reading`);
    }
    const contents = Buffer.alloc(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < contents.length) {
      const count = readSync(
        descriptor,
        contents,
        bytesRead,
        contents.length - bytesRead,
        bytesRead,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > maximumBytes) {
      throw new Error(`${label} exceeds its ${maximumBytes}-byte ceiling`);
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !after.isFile() ||
      !sameFileGeneration(opened, after) ||
      BigInt(bytesRead) !== opened.size
    ) {
      throw new Error(`${label} changed while being read`);
    }
    const final = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (
      !final?.isFile() ||
      final.isSymbolicLink() ||
      !sameFileGeneration(before, final)
    ) {
      throw new Error(`${label} identity changed during reading`);
    }
    const retained = contents.subarray(0, bytesRead);
    return {
      contents: retained.toString("utf8"),
      identity: {
        ...identity(final, path),
        digest: createHash("sha256").update(retained).digest("hex"),
      },
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function loadWorkspacePatterns(workspaceRoot) {
  const path = resolve(workspaceRoot, "pnpm-workspace.yaml");
  const snapshot = readBoundedRegularFile(
    path,
    workspaceDefinitionMaximumBytes,
    "pnpm-workspace.yaml",
  );
  const definition = parse(snapshot.contents, {
    maxAliasCount: 0,
    uniqueKeys: true,
  });
  if (
    !definition ||
    typeof definition !== "object" ||
    !Array.isArray(definition.packages) ||
    definition.packages.length === 0 ||
    definition.packages.length > workspacePatternMaximumCount
  ) {
    throw new Error("pnpm-workspace.yaml must declare a bounded package list");
  }

  const patterns = definition.packages;
  const seen = new Set();
  for (const pattern of patterns) {
    if (
      typeof pattern !== "string" ||
      pattern.length > workspacePatternMaximumLength ||
      !workspacePattern.test(pattern)
    ) {
      throw new Error(
        `Unsupported pnpm workspace package pattern: ${String(pattern)}`,
      );
    }
    validateRelativePath(
      pattern.slice(0, -2),
      "pnpm workspace package pattern root",
    );
    if (seen.has(pattern)) {
      throw new Error(`Duplicate pnpm workspace package pattern: ${pattern}`);
    }
    seen.add(pattern);
  }
  return { patterns, snapshot };
}

function assertFileGeneration(snapshot, maximumBytes, label) {
  const current = readBoundedRegularFile(
    snapshot.path,
    maximumBytes,
    label,
    snapshot,
  ).identity;
  if (current.digest !== snapshot.digest) {
    throw new Error(`${label} generation changed before graph settlement`);
  }
}

function readBoundedDirectory(path, pattern) {
  const directory = opendirSync(path);
  const entries = [];
  try {
    while (entries.length <= workspaceDirectoryEntryMaximumCount) {
      const entry = directory.readSync();
      if (entry === null) return entries;
      entries.push(entry);
    }
    throw new Error(
      `Workspace pattern ${pattern} exceeds its ${workspaceDirectoryEntryMaximumCount}-entry ceiling`,
    );
  } finally {
    directory.closeSync();
  }
}

function discoverWorkspacePackagePaths(workspaceRoot, patterns) {
  const discovered = new Map();
  const directorySnapshots = [];

  for (const pattern of patterns) {
    const relativeRoot = pattern.slice(0, -2);
    const rootSnapshots = snapshotDirectoryPath(
      workspaceRoot,
      relativeRoot,
      `Workspace pattern ${pattern}`,
    );
    const root = rootSnapshots.at(-1).path;
    directorySnapshots.push(rootSnapshots.at(-1));
    const entries = readBoundedDirectory(root, pattern);

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Workspace pattern ${pattern} contains a symlink entry: ${entry.name}`,
        );
      }
      if (!entry.isDirectory()) continue;
      const relativePath = `${relativeRoot}/${entry.name}`;
      const directoryPath = resolve(workspaceRoot, relativePath);
      const directory = lstatSync(directoryPath, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (!directory?.isDirectory() || directory.isSymbolicLink()) {
        throw new Error(
          `Workspace package ${relativePath} changed during discovery`,
        );
      }
      const manifestPath = resolve(workspaceRoot, relativePath, "package.json");
      const manifest = lstatSync(manifestPath, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (manifest === undefined) continue;
      if (!manifest.isFile() || manifest.isSymbolicLink()) {
        throw new Error(
          `${relativePath}/package.json must be a no-follow regular file`,
        );
      }
      if (discovered.has(relativePath)) {
        throw new Error(
          `Workspace package path matched multiple patterns: ${relativePath}`,
        );
      }
      discovered.set(relativePath, {
        directory: identity(directory, directoryPath),
        manifest: identity(manifest, manifestPath),
      });
      if (discovered.size > workspacePackageMaximumCount) {
        throw new Error(
          `Workspace package inventory exceeds its ${workspacePackageMaximumCount}-package ceiling`,
        );
      }
    }
    assertDirectoryPathIdentities(
      rootSnapshots,
      `Workspace pattern ${pattern}`,
    );
    assertDirectoryGeneration(
      rootSnapshots.at(-1),
      `Workspace pattern ${pattern}`,
    );
  }
  return { directorySnapshots, discovered };
}

function dependencyProjection(manifest, packageNames) {
  const declared = Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
    ...manifest.devDependencies,
  });
  const unknownInternal = declared
    .filter(
      (name) =>
        !packageNames.has(name) &&
        (name.startsWith("@agentscope/") || name.startsWith("agentscope-")),
    )
    .sort();
  if (unknownInternal.length > 0) {
    throw new Error(
      `${manifest.name} references unknown workspace ${unknownInternal.join(", ")}`,
    );
  }
  return declared.filter((name) => packageNames.has(name)).sort();
}

function assertAcyclic(graph) {
  const active = new Set();
  const visited = new Set();

  function visit(name, path) {
    if (active.has(name)) {
      throw new Error(
        `Workspace dependency cycle: ${[...path, name].join(" -> ")}`,
      );
    }
    if (visited.has(name)) return;

    active.add(name);
    for (const dependency of graph.get(name) ?? []) {
      visit(dependency, [...path, name]);
    }
    active.delete(name);
    visited.add(name);
  }

  for (const name of graph.keys()) visit(name, []);
}

function assertGraphSettlement({
  lexicalWorkspacePathSnapshots,
  retainedDirectorySnapshots,
  retainedInventoryDirectorySnapshots,
  retainedManifestSnapshots,
  workspaceDefinitionSnapshot,
}) {
  assertLexicalWorkspacePath(lexicalWorkspacePathSnapshots);
  for (const snapshot of retainedDirectorySnapshots) {
    assertDirectoryIdentity(snapshot, snapshot.path);
  }
  for (const snapshot of retainedInventoryDirectorySnapshots) {
    assertDirectoryGeneration(snapshot, snapshot.path);
  }
  assertFileGeneration(
    workspaceDefinitionSnapshot.identity,
    workspaceDefinitionMaximumBytes,
    "pnpm-workspace.yaml",
  );
  for (const snapshot of retainedManifestSnapshots) {
    assertFileGeneration(
      snapshot,
      workspaceManifestMaximumBytes,
      snapshot.path,
    );
  }
}

export function loadWorkspacePackageGraph(workspaceRoot, expectedPackages) {
  const requestedWorkspaceRoot = resolve(workspaceRoot);
  const lexicalWorkspacePathSnapshots = snapshotLexicalWorkspacePath(
    requestedWorkspaceRoot,
  );
  const requestedRootSnapshot = lexicalWorkspacePathSnapshots.at(-1);
  const canonicalWorkspaceRoot = realpathSync(requestedWorkspaceRoot);
  assertLexicalWorkspacePath(lexicalWorkspacePathSnapshots);
  const canonicalRootSnapshot = snapshotDirectory(
    canonicalWorkspaceRoot,
    "Canonical workspace root",
  );
  if (!sameObjectIdentity(requestedRootSnapshot, canonicalRootSnapshot)) {
    throw new Error(
      "Requested workspace root changed while resolving its canonical path",
    );
  }
  const workspacePathSnapshots = snapshotAbsoluteDirectoryPath(
    canonicalWorkspaceRoot,
    "Workspace root ancestry",
  );
  const { patterns, snapshot: workspaceDefinitionSnapshot } =
    loadWorkspacePatterns(canonicalWorkspaceRoot);
  const discovery = discoverWorkspacePackagePaths(
    canonicalWorkspaceRoot,
    patterns,
  );
  const { discovered } = discovery;
  const expectedPaths = new Set(expectedPackages.keys());
  const missing = [...expectedPaths]
    .filter((path) => !discovered.has(path))
    .sort();
  const unexpected = [...discovered.keys()]
    .filter((path) => !expectedPaths.has(path))
    .sort();
  if (missing.length > 0) {
    throw new Error(`Missing workspace package paths: ${missing.join(", ")}`);
  }
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected workspace package paths: ${unexpected.join(", ")}`,
    );
  }

  const manifests = new Map();
  const retainedDirectorySnapshots = [...workspacePathSnapshots];
  const retainedInventoryDirectorySnapshots = discovery.directorySnapshots;
  const retainedManifestSnapshots = [];
  for (const [relativePath, expectedName] of expectedPackages) {
    validateRelativePath(relativePath, "Expected workspace package path");
    const directorySnapshots = snapshotDirectoryPath(
      canonicalWorkspaceRoot,
      relativePath,
      `Workspace package ${relativePath}`,
    );
    const discoveredIdentity = discovered.get(relativePath);
    if (
      !sameObjectIdentity(
        discoveredIdentity.directory,
        directorySnapshots.at(-1),
      )
    ) {
      throw new Error(
        `Workspace package ${relativePath} identity changed after discovery`,
      );
    }
    const manifestPath = resolve(
      canonicalWorkspaceRoot,
      relativePath,
      "package.json",
    );
    const manifestSnapshot = readBoundedRegularFile(
      manifestPath,
      workspaceManifestMaximumBytes,
      `${relativePath}/package.json`,
      discoveredIdentity.manifest,
    );
    const manifest = JSON.parse(manifestSnapshot.contents);
    assertDirectoryPathIdentities(
      directorySnapshots,
      `Workspace package ${relativePath}`,
    );
    if (manifest.name !== expectedName) {
      throw new Error(
        `${relativePath}/package.json must be named ${expectedName}; found ${String(manifest.name)}`,
      );
    }
    if (manifests.has(manifest.name)) {
      throw new Error(`Duplicate workspace package name: ${manifest.name}`);
    }
    manifests.set(manifest.name, { manifest, relativePath });
    retainedDirectorySnapshots.push(...directorySnapshots);
    retainedManifestSnapshots.push(manifestSnapshot.identity);
  }

  const graph = new Map();
  const packageNames = new Set(manifests.keys());
  for (const [name, { manifest }] of manifests) {
    const internal = dependencyProjection(manifest, packageNames);
    graph.set(name, internal);
  }

  assertAcyclic(graph);
  assertGraphSettlement({
    lexicalWorkspacePathSnapshots,
    retainedDirectorySnapshots,
    retainedInventoryDirectorySnapshots,
    retainedManifestSnapshots,
    workspaceDefinitionSnapshot,
  });
  return { graph, manifests };
}
