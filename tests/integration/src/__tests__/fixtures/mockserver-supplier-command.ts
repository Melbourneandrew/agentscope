import type * as FileSystem from "node:fs";
import type * as LifecyclePatch from "../../../mockserver-material/lifecycle-patch.mjs";
import * as fs from "node:fs";
import { types } from "node:util";
import { runInNewContext } from "node:vm";
import { beforeEach, expect, vi } from "vitest";
const state = vi.hoisted(() => ({
  path: "",
  wrongLength: false,
  writes: [] as [string, unknown][],
  directories: [] as string[],
  rejects: "",
  markers: [] as string[],
  sinkFailure: false,
  primary: undefined as Error | undefined,
  inventoryFailure: false,
  failureCategory: "",
  callbackMode: 0o664,
  cacheIssue: "",
  artifactIssue: "",
  opened: 0,
  closed: 0,
  timestamp: 0,
}));
export { state };
const issueMatches = (cache: boolean, artifact: boolean, issue: string) =>
  (cache && state.cacheIssue === issue) ||
  (artifact && state.artifactIssue === issue);
function statusFor(path: string, held = false) {
  const cache = path.endsWith("maven-repository") || path.endsWith("npm-cache");
  const artifact = path.endsWith(".jar");
  const directory = cache || path === "/supplier";
  return {
    isFile: () =>
      (!directory || (cache && state.cacheIssue === "file")) &&
      !(artifact && state.artifactIssue === "directory"),
    isDirectory: () => directory && !(cache && state.cacheIssue === "file"),
    isSymbolicLink: () => issueMatches(cache, artifact, "symlink"),
    dev: cache && state.cacheIssue === "device" ? 2 : 1,
    ino:
      path.length + (held && issueMatches(cache, artifact, "identity") ? 1 : 0),
    nlink: artifact && state.artifactIssue === "links" ? 2 : 1,
    size:
      directory || (artifact && state.artifactIssue === "empty")
        ? 0
        : artifact && state.artifactIssue === "oversized"
          ? 256 * 1024 * 1024 + 1
          : expectedSize(),
    uid: issueMatches(cache, artifact, "owner") ? 1 : 0,
    gid: cache && state.cacheIssue === "group" ? 1 : 0,
    mode: directory
      ? cache && state.cacheIssue === "mode"
        ? 0o755
        : 0o700
      : path.endsWith(".java")
        ? state.callbackMode
        : artifact
          ? state.artifactIssue === "mode"
            ? 0o777
            : 0o644
          : 0o600,
    mtimeMs:
      directory || (artifact && state.artifactIssue === "changed")
        ? state.timestamp++
        : 0,
    ctimeMs: directory ? state.timestamp++ : 0,
  };
}
function expectedSize() {
  if (state.wrongLength) return 8;
  if (state.path.endsWith("source.tar.gz")) return 31_447_709;
  if (state.path.endsWith("maven.zip")) return 9_395_475;
  if (state.path.endsWith("node.tar.gz")) return 54_108_748;
  if (state.path.endsWith("jdk.tar.gz")) return 193_252_603;
  return (
    lifecycleSourcePins.find(({ path }) => state.path.endsWith(path))?.bytes ??
    9101
  );
}
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof FileSystem>()),
  openSync: (path: string) => {
    state.path = path;
    state.opened++;
    return 1;
  },
  closeSync: () => state.closed++,
  fstatSync: () => statusFor(state.path, true),
  lstatSync: (path: string) => {
    if (state.cacheIssue === "missing" && path.endsWith("npm-cache"))
      throw Error("synthetic-missing-cache");
    return statusFor(path);
  },
  readSync: (
    _fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => {
    const count = Math.min(length, expectedSize() - position);
    buffer.fill(32, offset, offset + count);
    return count;
  },
  mkdirSync: (path: string) => {
    if (path === "/out" && state.failureCategory === "output-create")
      throw state.primary ?? Error("synthetic-output-create");
    return state.directories.push(path);
  },
  writeFileSync: (path: string, bytes: unknown) => {
    if (
      path === "/out/material.json" &&
      state.failureCategory === "output-write"
    )
      throw state.primary ?? Error("synthetic-output-write");
    return state.writes.push([path, bytes]);
  },
  copyFileSync: () => {},
  writeSync: (fd: number, value: string) => {
    expect(fd).toBe(2);
    state.markers.push(value);
    if (state.sinkFailure) throw Error("SINK_CANARY");
    return value.length;
  },
}));
vi.mock("../../../mockserver-material/source-archive.mjs", () => ({
  verifyMockServerSourceArchive: (value: Buffer) => {
    if (state.rejects === "source") throw state.primary ?? Error("source");
    return value;
  },
}));
vi.mock("../../../mockserver-material/build-tool-archive.mjs", () => ({
  verifyMavenArchiveBytes: (value: Buffer) => {
    if (state.rejects === "maven") throw Error("maven");
    return value;
  },
}));
vi.mock("../../../mockserver-material/bootstrap-archive.mjs", () => ({
  verifyBootstrapArchive: (kind: string, value: Buffer) => {
    if (state.rejects === kind) throw Error(kind);
    return value;
  },
}));
vi.mock("../../../mockserver-material/callback-patch.mjs", () => ({
  patchCallbackSource: () => "synthetic-patched",
}));
vi.mock(
  "../../../mockserver-material/lifecycle-patch.mjs",
  async (original) => ({
    ...(await original<typeof LifecyclePatch>()),
    patchMockServerLifecycleSource: (name: string) =>
      `synthetic-lifecycle-${name}`,
  }),
);
vi.mock("../../../mockserver-material/supplier-inventory.mjs", () => ({
  inventoryMockServerSupplier: (
    _root: string,
    observe?: (category: string) => void,
  ) => {
    if (state.failureCategory.startsWith("inventory-")) {
      observe?.(state.failureCategory);
      throw state.primary ?? Error("synthetic-inventory");
    }
    if (state.inventoryFailure) throw state.primary ?? new Error("inventory");
    return Buffer.from("synthetic-inventory");
  },
}));
import { runMockServerSupplierResearch as runSupplierResearch } from "../../../mockserver-material/supplier-command.mjs";
import { verifyMockServerSourceArchive } from "../../../mockserver-material/source-archive.mjs";
import { verifyMavenArchiveBytes } from "../../../mockserver-material/build-tool-archive.mjs";
import { verifyBootstrapArchive } from "../../../mockserver-material/bootstrap-archive.mjs";
import { patchCallbackSource } from "../../../mockserver-material/callback-patch.mjs";
import {
  lifecycleSourcePins,
  patchMockServerLifecycleSource,
} from "../../../mockserver-material/lifecycle-patch.mjs";
import { inventoryMockServerSupplier } from "../../../mockserver-material/supplier-inventory.mjs";
import {
  mockServerSupplierBuildPlan,
  mockServerSupplierLayout,
  supplierGlobalMavenSettings,
  supplierMavenSettings,
} from "../../../mockserver-material/build-recipe.mjs";

export const workerSource = fs.readFileSync(
  new URL("../../../mockserver-material/supplier-command.mjs", import.meta.url),
  "utf8",
);
export const privateWorker = runInNewContext(
  `${workerSource.slice(workerSource.indexOf("const environment ="), workerSource.indexOf("export const runMockServerSupplierResearch"))}\nrunSupplier`,
  {
    ...fs,
    types,
    Buffer,
    maximumOutputBytes: 8 * 1024 * 1024,
    verifyMockServerSourceArchive,
    verifyMavenArchiveBytes,
    verifyBootstrapArchive,
    patchCallbackSource,
    lifecycleSourcePins,
    patchMockServerLifecycleSource,
    inventoryMockServerSupplier,
    mockServerSupplierBuildPlan,
    mockServerSupplierLayout,
    supplierGlobalMavenSettings,
    supplierMavenSettings,
  },
) as (
  run: (file: string, ...args: unknown[]) => Promise<unknown>,
  phase: string,
  observe?: boolean,
) => Promise<void>;

// Run the actual command body with synthetic fixed-input I/O. Neither archive
// parsing nor any vendor program runs; fixed byte lengths are mocked below.
beforeEach(() => {
  state.writes = [];
  state.directories = [];
  state.rejects = "";
  state.wrongLength = false;
  state.markers = [];
  state.sinkFailure = false;
  state.primary = undefined;
  state.inventoryFailure = false;
  state.failureCategory = "";
  state.callbackMode = 0o664;
  state.cacheIssue = "";
  state.artifactIssue = "";
  state.opened = state.closed = 0;
  state.timestamp = 0;
});

export const runMockServerSupplierResearch: typeof runSupplierResearch = (
  ...arguments_: Parameters<typeof runSupplierResearch>
) => runSupplierResearch(...arguments_);
