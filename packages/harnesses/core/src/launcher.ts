import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

import type { HarnessTypeId } from "./types.js";

export const HARNESS_HOOK_CONTRACT_VERSION = 1 as const;
export const MINIMUM_HOOK_DEADLINE_MILLISECONDS = 50 as const;
export const MAXIMUM_HOOK_DEADLINE_MILLISECONDS = 60_000 as const;

const maximumPathLength = 4_096;
const harnessTypePattern = /^@agentscope\/harness-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

declare const invocationBrand: unique symbol;
export type OwnedHarnessHookInvocation = Readonly<{
  launcherPath: string;
  arguments: readonly [];
  contractVersion: typeof HARNESS_HOOK_CONTRACT_VERSION;
  harnessType: HarnessTypeId;
  harnessDigest: string;
  hookDeadlineMilliseconds: number;
  ownershipIdentity: string;
  readonly [invocationBrand]: true;
}>;

export type OwnedHarnessHookInvocationInput = Readonly<{
  agentscopeHome: string;
  harnessType: string;
  hookDeadlineMilliseconds: number;
  platform: "posix" | "win32";
}>;

const invocations = new WeakSet<object>();

export class HarnessLauncherError extends Error {
  public constructor() {
    super("harness.launcher.invalid");
    this.name = "HarnessLauncherError";
  }
}

const invalid = (): never => {
  throw new HarnessLauncherError();
};

const exactInput = (
  input: OwnedHarnessHookInvocationInput,
): Readonly<{
  agentscopeHome: string;
  harnessType: HarnessTypeId;
  hookDeadlineMilliseconds: number;
  platform: "posix" | "win32";
}> => {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
      Object.keys(descriptors).sort().join("\0") !==
        "agentscopeHome\0harnessType\0hookDeadlineMilliseconds\0platform" ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor))
    )
      return invalid();
    const agentscopeHome = descriptors.agentscopeHome.value as unknown;
    const harnessType = descriptors.harnessType.value as unknown;
    const hookDeadlineMilliseconds = descriptors.hookDeadlineMilliseconds
      .value as unknown;
    const platform = descriptors.platform.value as unknown;
    if (
      typeof agentscopeHome !== "string" ||
      !isAbsolute(agentscopeHome) ||
      agentscopeHome.length === 0 ||
      agentscopeHome.length > maximumPathLength ||
      typeof harnessType !== "string" ||
      !harnessTypePattern.test(harnessType) ||
      !Number.isSafeInteger(hookDeadlineMilliseconds) ||
      (hookDeadlineMilliseconds as number) <
        MINIMUM_HOOK_DEADLINE_MILLISECONDS ||
      (hookDeadlineMilliseconds as number) >
        MAXIMUM_HOOK_DEADLINE_MILLISECONDS ||
      (platform !== "posix" && platform !== "win32")
    )
      return invalid();
    return Object.freeze({
      agentscopeHome,
      harnessType: harnessType as HarnessTypeId,
      hookDeadlineMilliseconds: hookDeadlineMilliseconds as number,
      platform,
    });
  } catch {
    return invalid();
  }
};

export const harnessIdentityDigest = (harnessType: HarnessTypeId): string =>
  createHash("sha256").update(harnessType, "utf8").digest("hex");

export const createOwnedHarnessHookInvocation = (
  input: OwnedHarnessHookInvocationInput,
): OwnedHarnessHookInvocation => {
  const parsed = exactInput(input);
  const harnessDigest = harnessIdentityDigest(parsed.harnessType);
  const basename = `agentscope-hook-v1-${harnessDigest}-d${parsed.hookDeadlineMilliseconds}${parsed.platform === "win32" ? ".exe" : ""}`;
  const launcherPath = join(parsed.agentscopeHome, "bin", basename);
  const arguments_: readonly [] = Object.freeze([]);
  const ownershipIdentity = `agentscope-hook-v1-sha256-${createHash("sha256")
    .update(
      JSON.stringify({
        contractVersion: HARNESS_HOOK_CONTRACT_VERSION,
        launcherPath,
        harnessType: parsed.harnessType,
        harnessDigest,
        hookDeadlineMilliseconds: parsed.hookDeadlineMilliseconds,
      }),
      "utf8",
    )
    .digest("hex")}`;
  const invocation = Object.freeze({
    launcherPath,
    arguments: arguments_,
    contractVersion: HARNESS_HOOK_CONTRACT_VERSION,
    harnessType: parsed.harnessType,
    harnessDigest,
    hookDeadlineMilliseconds: parsed.hookDeadlineMilliseconds,
    ownershipIdentity,
  }) as OwnedHarnessHookInvocation;
  invocations.add(invocation);
  return invocation;
};

export const isOwnedHarnessHookInvocation = (
  value: unknown,
): value is OwnedHarnessHookInvocation =>
  typeof value === "object" && value !== null && invocations.has(value);
