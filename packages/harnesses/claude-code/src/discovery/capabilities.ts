import { isAbsolute, resolve } from "node:path";
import type { HarnessExecutableProbeResult } from "@agentscope/harnesses-core";

export type ExactFileIdentity = Readonly<{ bytes: number; sha256: string }>;
export type ProductHarnessReadGuard = Readonly<{
  targetPath: string;
  exists: boolean;
  digest: string;
  mode: number | null;
}>;
export type ClaudePluginTextDocument = Readonly<{
  guard: ProductHarnessReadGuard;
  text: string | undefined;
}>;
export type ClaudePluginDocument = Readonly<{
  guard: ProductHarnessReadGuard;
  value: unknown;
}>;
export type ClaudeCodePathObservation = Readonly<{
  kind: "file" | "directory" | "other";
  symbolicLink: boolean;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}>;
// Trusted application-owned readers. These observations confer no Core plan
// authority; all consulted preimages must be rebound by the original plan.
export type ClaudeCodeDiscoveryReadCapabilities = Readonly<{
  readTextDocument: (path: string) => Promise<ClaudePluginTextDocument>;
  readDirectoryEntries: (path: string) => Promise<readonly string[]>;
  inspectPath: (path: string) => Promise<ClaudeCodePathObservation>;
  realpath: (path: string) => Promise<string>;
  canonicalFutureDirectory: (path: string) => Promise<string>;
  executableCandidates: (
    names: readonly string[],
    environment: Readonly<Record<string, string | undefined>>,
  ) => Promise<HarnessExecutableProbeResult>;
  authenticateExecutable: (
    path: string,
    identity: ExactFileIdentity,
    mode: number,
  ) => Promise<void>;
}>;

export const unavailable = (): Readonly<{ kind: "unavailable" }> =>
  Object.freeze({ kind: "unavailable" as const });
export const exactAbsolutePath = (value: string): string => {
  if (
    !value ||
    value.length > 4096 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value
  )
    throw new Error("cli.harness.probe-unavailable");
  return value;
};
export const exactEnvironmentValue = (
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(environment, key);
  if (descriptor === undefined) return undefined;
  if (
    !("value" in descriptor) ||
    descriptor.value === undefined ||
    typeof descriptor.value !== "string"
  )
    throw new Error("cli.harness.probe-unavailable");
  return descriptor.value;
};
export const nodeErrorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
const cacheMarkers = new Set([
  "node_modules",
  ".orphaned_at",
  ".in_use",
  ".links_materialized",
]);
export const claudePluginCacheContentName = (name: string): boolean =>
  !cacheMarkers.has(name);
export const discoverClaudeCacheRecord = async (
  capabilities: ClaudeCodeDiscoveryReadCapabilities,
  paths: readonly string[],
  fallbackToFirst = true,
) => {
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
      (await capabilities.readDirectoryEntries(path)).some(
        claudePluginCacheContentName,
      )
    )
      return result(index, index + 1);
  }
  return result(fallbackToFirst ? 0 : undefined, paths.length);
};
