import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createOwnedHarnessHookInvocation,
  HARNESS_HOOK_CONTRACT_VERSION,
} from "@agentscope/harnesses-core";

const MAXIMUM_PATH_CODE_UNITS = 4_096;
const MAXIMUM_RELEASE_IDENTITY_CODE_UNITS = 128;
const POSIX_LAUNCHER_MODE = 0o700;
const invalidShebangByte = new Set([0, 9, 10, 13, 32]);
const releaseIdentityPattern = /^[0-9A-Za-z][0-9A-Za-z._-]*$/u;

export type OwnedHookLauncherMetadata = Readonly<{
  contractVersion: typeof HARNESS_HOOK_CONTRACT_VERSION;
  harnessDigest: string;
  harnessType: string;
  hookDeadlineMilliseconds: number;
  launcherPath: string;
  launcherSha256: string;
  machineEntryPath: string;
  mode: typeof POSIX_LAUNCHER_MODE;
  nodeExecutable: string;
  releaseIdentity: string;
}>;

export type OwnedHookLauncherArtifacts = Readonly<{
  launcherBytes: Uint8Array;
  launcherPath: string;
  metadata: OwnedHookLauncherMetadata;
  metadataBytes: Uint8Array;
  metadataPath: string;
  mode: typeof POSIX_LAUNCHER_MODE;
  ownershipIdentity: string;
}>;

export type CreateOwnedHookLauncherArtifactsInput = Readonly<{
  agentscopeHome: string;
  harnessType: string;
  hookDeadlineMilliseconds: number;
  machineEntryPath: string;
  nodeExecutable: string;
  platform: "posix" | "win32";
  releaseIdentity: string;
}>;

export class HookLauncherError extends Error {
  public constructor() {
    super("cli.launcher.unsupported");
    this.name = "HookLauncherError";
  }
}

const invalid = (): never => {
  throw new HookLauncherError();
};

const exactRecord = (
  input: CreateOwnedHookLauncherArtifactsInput,
): CreateOwnedHookLauncherArtifactsInput => {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = [
      "agentscopeHome",
      "harnessType",
      "hookDeadlineMilliseconds",
      "machineEntryPath",
      "nodeExecutable",
      "platform",
      "releaseIdentity",
    ];
    if (
      Reflect.ownKeys(descriptors).length !== keys.length ||
      Reflect.ownKeys(descriptors).some(
        (key) => typeof key !== "string" || !keys.includes(key),
      ) ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor))
    )
      return invalid();
    const output = Object.fromEntries(
      keys.map((key) => [key, descriptors[key]?.value as unknown]),
    ) as CreateOwnedHookLauncherArtifactsInput;
    if (
      output.platform !== "posix" ||
      typeof output.agentscopeHome !== "string" ||
      !isAbsolute(output.agentscopeHome) ||
      output.agentscopeHome.length > MAXIMUM_PATH_CODE_UNITS ||
      typeof output.machineEntryPath !== "string" ||
      !isAbsolute(output.machineEntryPath) ||
      output.machineEntryPath.length > MAXIMUM_PATH_CODE_UNITS ||
      typeof output.nodeExecutable !== "string" ||
      !isAbsolute(output.nodeExecutable) ||
      output.nodeExecutable.length > MAXIMUM_PATH_CODE_UNITS ||
      typeof output.releaseIdentity !== "string" ||
      output.releaseIdentity.length > MAXIMUM_RELEASE_IDENTITY_CODE_UNITS ||
      !releaseIdentityPattern.test(output.releaseIdentity)
    )
      return invalid();
    return Object.freeze(output);
  } catch {
    return invalid();
  }
};

const posixShebang = (nodeExecutable: string): string => {
  const bytes = new TextEncoder().encode(nodeExecutable);
  if (
    bytes.length === 0 ||
    bytes.some((byte) => invalidShebangByte.has(byte)) ||
    2 + bytes.length + 1 > 127
  )
    return invalid();
  return `#!${nodeExecutable}\n`;
};

const launcherProgram = (
  nodeExecutable: string,
  machineEntryPath: string,
): string => `${posixShebang(nodeExecutable)}const startedAt = performance.now();
const physicalPath = process.argv[1];
const arguments_ = process.argv.slice(2);
const match = /(?:^|\\/)agentscope-hook-v1-[a-f0-9]{64}-d(\\d+)$/.exec(physicalPath);
const duration = match ? Number(match[1]) : Number.NaN;
const authority = Object.freeze({
  arguments: Object.freeze(arguments_),
  contractVersion: 1,
  deadlineStartedAt: startedAt,
  duration,
  physicalPath,
});
if (arguments_.length === 0 && Number.isSafeInteger(duration) && duration >= 50 && duration <= 60000)
  try {
    const machine = await import(${JSON.stringify(pathToFileURL(machineEntryPath).href)});
    await machine.runOwnedHookBootstrap(authority);
  } catch {}
process.exitCode = 0;
`;

export const createOwnedHookLauncherArtifacts = (
  input: CreateOwnedHookLauncherArtifactsInput,
): OwnedHookLauncherArtifacts => {
  const parsed = exactRecord(input);
  let invocation;
  try {
    invocation = createOwnedHarnessHookInvocation({
      agentscopeHome: parsed.agentscopeHome,
      harnessType: parsed.harnessType,
      hookDeadlineMilliseconds: parsed.hookDeadlineMilliseconds,
      platform: "posix",
    });
  } catch {
    return invalid();
  }
  const launcherBytes = new TextEncoder().encode(
    launcherProgram(parsed.nodeExecutable, parsed.machineEntryPath),
  );
  const metadata = Object.freeze({
    contractVersion: HARNESS_HOOK_CONTRACT_VERSION,
    harnessDigest: invocation.harnessDigest,
    harnessType: invocation.harnessType,
    hookDeadlineMilliseconds: invocation.hookDeadlineMilliseconds,
    launcherPath: invocation.launcherPath,
    launcherSha256: createHash("sha256").update(launcherBytes).digest("hex"),
    machineEntryPath: parsed.machineEntryPath,
    mode: POSIX_LAUNCHER_MODE,
    nodeExecutable: parsed.nodeExecutable,
    releaseIdentity: parsed.releaseIdentity,
  });
  return Object.freeze({
    launcherBytes,
    launcherPath: invocation.launcherPath,
    metadata,
    metadataBytes: new TextEncoder().encode(
      `${JSON.stringify(metadata, undefined, 2)}\n`,
    ),
    metadataPath: `${invocation.launcherPath}.metadata.json`,
    mode: POSIX_LAUNCHER_MODE,
    ownershipIdentity: invocation.ownershipIdentity,
  });
};
