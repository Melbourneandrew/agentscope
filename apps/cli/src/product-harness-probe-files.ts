import { constants, createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const MAXIMUM_PATH_CODE_UNITS = 4_096;
const MAXIMUM_PATH_ENTRIES = 64;
export type ExactFileIdentity = Readonly<{ bytes: number; sha256: string }>;

export type ProductHarnessReadGuard = Readonly<{
  targetPath: string;
  exists: boolean;
  digest: string;
  mode: number | null;
}>;

const cacheMarkers = new Set([
  "node_modules",
  ".orphaned_at",
  ".in_use",
  ".links_materialized",
]);
export const claudePluginCacheContentName = (name: string): boolean =>
  !cacheMarkers.has(name);

// Preliminary path discovery ONLY. This never supplies an authenticated
// HarnessDirectoryInspection; the same transaction must independently elect
// from Core's held observations before consuming the selected plugin data.
export const discoverClaudeCacheRecord = async (
  paths: readonly string[],
  fallbackToFirst = true,
): Promise<
  Readonly<{ index: number | undefined; directoryPaths: readonly string[] }>
> => {
  const result = (index: number | undefined, count: number) =>
    Object.freeze({
      index,
      directoryPaths: Object.freeze(paths.slice(0, count)),
    });
  if (paths.length === 0) return result(undefined, 0);
  if (paths.length === 1 && fallbackToFirst) return result(0, 1);
  for (const [index, path] of paths.entries()) {
    if (path.endsWith(".zip"))
      throw new Error("cli.harness.plugin-inventory-unavailable");
    if (
      (await discoverClaudeDirectoryEntries(path)).some(
        claudePluginCacheContentName,
      )
    )
      return result(index, index + 1);
  }
  return result(fallbackToFirst ? 0 : undefined, paths.length);
};

// Unauthenticated route discovery only; never passed to a planner as a Core
// inspection. Every consulted directory is reopened by the existing plan.
export const discoverClaudeDirectoryEntries = async (
  path: string,
): Promise<readonly string[]> => {
  let directory;
  try {
    directory = await opendir(exactAbsolutePath(path));
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return [];
    throw error;
  }
  try {
    const names: string[] = [];
    let bytes = 0;
    for (;;) {
      const entry = await directory.read();
      if (entry === null) break;
      names.push(entry.name);
      bytes += Buffer.byteLength(entry.name, "utf8");
      if (names.length > 1024 || bytes > 1_048_576)
        throw new Error("cli.harness.plugin-inventory-unavailable");
    }
    return Object.freeze(names);
  } finally {
    await directory.close();
  }
};

export const unavailable = (): Readonly<{ kind: "unavailable" }> =>
  Object.freeze({ kind: "unavailable" as const });

export const exactEnvironmentValue = (
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(environment, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor) || descriptor.value === undefined)
    throw new Error("cli.harness.probe-unavailable");
  if (typeof descriptor.value !== "string")
    throw new Error("cli.harness.probe-unavailable");
  return descriptor.value;
};

export const exactAbsolutePath = (value: string): string => {
  if (
    value.length === 0 ||
    value.length > MAXIMUM_PATH_CODE_UNITS ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value
  )
    throw new Error("cli.harness.probe-unavailable");
  return value;
};

export const nodeErrorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;

export const canonicalFutureDirectory = async (
  path: string,
): Promise<string> => {
  let current = exactAbsolutePath(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      return exactAbsolutePath(join(await realpath(current), ...suffix));
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        !["ENOENT", "ENOTDIR"].includes(String(error.code))
      )
        throw error;
      const parent = dirname(current);
      if (parent === current)
        throw new Error("cli.harness.probe-unavailable", { cause: error });
      suffix.unshift(basename(current));
      current = parent;
    }
  }
};

export const canonicalPrivateDirectory = async (
  path: string,
): Promise<string> => {
  const canonical = exactAbsolutePath(await realpath(path));
  const state = await lstat(canonical);
  if (
    canonical !== path ||
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    (process.platform !== "win32" && (state.mode & 0o777) !== 0o700)
  )
    throw new Error("cli.harness.configuration-directory-unavailable");
  return canonical;
};

export const canonicalConfigurationDirectory = async (
  path: string,
): Promise<string> => {
  const canonical = exactAbsolutePath(await realpath(path));
  const state = await lstat(canonical);
  if (canonical !== path || !state.isDirectory() || state.isSymbolicLink())
    throw new Error("cli.harness.configuration-directory-unavailable");
  return canonical;
};

const sameDirectoryIdentity = (
  left: Awaited<ReturnType<FileHandle["stat"]>>,
  right: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean =>
  left.isDirectory() &&
  right.isDirectory() &&
  left.dev === right.dev &&
  left.ino === right.ino;

export const durablyPublishPrivateDirectory = async (
  path: string,
): Promise<void> => {
  const parent = dirname(path);
  if (exactAbsolutePath(await realpath(parent)) !== parent)
    throw new Error("cli.harness.configuration-directory-unavailable");
  const parentHandle = await open(
    parent,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  try {
    const before = await parentHandle.stat();
    const pathBefore = await lstat(parent);
    if (
      !sameDirectoryIdentity(before, pathBefore) ||
      pathBefore.isSymbolicLink()
    )
      throw new Error("cli.harness.configuration-directory-unavailable");
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") throw error;
    }
    await canonicalPrivateDirectory(path);
    await parentHandle.sync();
    const after = await parentHandle.stat();
    const pathAfter = await lstat(parent);
    if (
      !sameDirectoryIdentity(before, after) ||
      !sameDirectoryIdentity(after, pathAfter) ||
      pathAfter.isSymbolicLink() ||
      exactAbsolutePath(await realpath(parent)) !== parent
    )
      throw new Error("cli.harness.configuration-directory-unavailable");
    await canonicalPrivateDirectory(path);
  } finally {
    await parentHandle.close();
  }
};

const pathDirectories = (
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] => {
  const path = exactEnvironmentValue(environment, "PATH");
  if (path === undefined || path.length > 65_536)
    throw new Error("cli.harness.probe-unavailable");
  const entries = path.split(":");
  if (
    entries.length === 0 ||
    entries.length > MAXIMUM_PATH_ENTRIES ||
    entries.some(
      (entry) =>
        entry.length === 0 ||
        entry.length > MAXIMUM_PATH_CODE_UNITS ||
        !isAbsolute(entry) ||
        resolve(entry) !== entry,
    )
  )
    throw new Error("cli.harness.probe-unavailable");
  return Object.freeze([...entries]);
};

export const executableCandidates = async (
  names: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<
  | Readonly<{
      kind: "found";
      candidates: readonly Readonly<{ path: string }>[];
    }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unavailable" }>
> => {
  try {
    if (
      names.length !== 1 ||
      (names[0] !== "codex" && names[0] !== "claude") ||
      Object.getPrototypeOf(names) !== Array.prototype
    )
      return unavailable();
    const candidates = new Map<string, Readonly<{ path: string }>>();
    for (const directory of pathDirectories(environment)) {
      const candidate = join(directory, names[0]);
      try {
        const canonical = exactAbsolutePath(await realpath(candidate));
        const state = await lstat(canonical);
        if (!state.isFile() || state.isSymbolicLink()) continue;
        await access(canonical, constants.X_OK);
        candidates.set(canonical, Object.freeze({ path: canonical }));
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          ["EACCES", "ENOENT", "ENOTDIR"].includes(String(error.code))
        )
          continue;
        return unavailable();
      }
    }
    return candidates.size === 0
      ? Object.freeze({ kind: "absent" as const })
      : Object.freeze({
          candidates: Object.freeze([...candidates.values()]),
          kind: "found" as const,
        });
  } catch {
    return unavailable();
  }
};

export type AuthenticatedFile = Readonly<{
  before: Awaited<ReturnType<FileHandle["stat"]>>;
  handle: FileHandle;
  path: string;
}>;

export const authenticateExactFile = async (
  path: string,
  identity: ExactFileIdentity,
  mode: number,
): Promise<AuthenticatedFile> => {
  if (exactAbsolutePath(await realpath(path)) !== path)
    throw new Error("cli.harness.probe-unavailable");
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size !== identity.bytes ||
      (process.platform !== "win32" && (before.mode & 0o777) !== mode)
    )
      throw new Error("cli.harness.probe-unavailable");
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = createReadStream(path, {
      autoClose: false,
      fd: handle.fd,
      start: 0,
    }) as AsyncIterable<Buffer>;
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > identity.bytes)
        throw new Error("cli.harness.probe-unavailable");
      hash.update(chunk);
    }
    if (bytes !== identity.bytes || hash.digest("hex") !== identity.sha256)
      throw new Error("cli.harness.probe-unavailable");
    return Object.freeze({ before, handle, path });
  } catch (error) {
    await handle.close();
    throw error;
  }
};

export const revalidateAuthenticatedFile = async (
  authenticated: AuthenticatedFile,
): Promise<void> => {
  const after = await authenticated.handle.stat();
  const pathAfter = await lstat(authenticated.path);
  for (const value of [after, pathAfter])
    if (
      value.dev !== authenticated.before.dev ||
      value.ino !== authenticated.before.ino ||
      value.size !== authenticated.before.size ||
      value.mode !== authenticated.before.mode ||
      value.mtimeMs !== authenticated.before.mtimeMs ||
      value.ctimeMs !== authenticated.before.ctimeMs
    )
      throw new Error("cli.harness.probe-unavailable");
};

const maximumDocumentBytes = 1_048_576;
const pluginDocumentUnavailable = (): Error =>
  new Error("cli.harness.plugin-inventory-unavailable");
const pluginDocumentDigest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
type FileState = Awaited<ReturnType<FileHandle["stat"]>>;
const unchangedFile = (before: FileState, after: FileState): boolean =>
  before.isFile() &&
  after.isFile() &&
  !after.isSymbolicLink() &&
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mode === after.mode &&
  before.mtimeMs === after.mtimeMs &&
  before.ctimeMs === after.ctimeMs;

export type ClaudePluginDocument = Readonly<{
  guard: ProductHarnessReadGuard;
  // The version-bound inventory projection validates this value separately.
  // Absence is not an empty registry, an absent hook, or a no-exporter claim.
  value: unknown;
}>;

export type ClaudePluginTextDocument = Readonly<{
  guard: ProductHarnessReadGuard;
  text: string | undefined;
}>;

export const readClaudePluginTextDocument = async (
  requestedPath: string,
): Promise<ClaudePluginTextDocument> => {
  try {
    const path = exactAbsolutePath(requestedPath);
    const parent = dirname(path);
    if ((await canonicalFutureDirectory(parent)) !== parent)
      throw pluginDocumentUnavailable();
    let handle: FileHandle;
    try {
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw pluginDocumentUnavailable();
      // Recheck absence and parent resolution before returning its preimage.
      try {
        await lstat(path);
        throw pluginDocumentUnavailable();
      } catch (absence) {
        if (nodeErrorCode(absence) !== "ENOENT")
          throw pluginDocumentUnavailable();
      }
      if ((await canonicalFutureDirectory(parent)) !== parent)
        throw pluginDocumentUnavailable();
      return Object.freeze({
        guard: Object.freeze({
          targetPath: path,
          exists: false,
          digest: pluginDocumentDigest(new Uint8Array()),
          mode: null,
        }),
        text: undefined,
      });
    }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > maximumDocumentBytes)
        throw pluginDocumentUnavailable();
      const buffer = Buffer.alloc(maximumDocumentBytes + 1);
      let offset = 0;
      for (;;) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          buffer.byteLength - offset,
          offset,
        );
        offset += bytesRead;
        if (offset > maximumDocumentBytes) throw pluginDocumentUnavailable();
        if (bytesRead === 0) break;
      }
      if (
        offset !== before.size ||
        !unchangedFile(before, await handle.stat()) ||
        !unchangedFile(before, await lstat(path)) ||
        (await realpath(path)) !== path
      )
        throw pluginDocumentUnavailable();
      const bytes = buffer.subarray(0, offset);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return Object.freeze({
        guard: Object.freeze({
          targetPath: path,
          exists: true,
          digest: pluginDocumentDigest(bytes),
          mode: before.mode & 0o777,
        }),
        text,
      });
    } finally {
      await handle.close();
    }
  } catch {
    // Configuration content and native path/error details stay transient.
    throw pluginDocumentUnavailable();
  }
};
