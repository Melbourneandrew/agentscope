import type { ReporterDeadline } from "@agentscope/destinations-core";
import { createReporterDeadline } from "@agentscope/destinations-core/core-orchestration";

import {
  MAXIMUM_HOOK_DEADLINE_MILLISECONDS,
  MINIMUM_HOOK_DEADLINE_MILLISECONDS,
} from "../configuration/schema.js";
import {
  createAgentscopeHomeFromOwnedRootForCore,
  type AgentscopeHome,
} from "../configuration/home.js";

declare const hookEntryAuthorityBrand: unique symbol;

export type HookEntryAuthority = Readonly<{
  readonly [hookEntryAuthorityBrand]: true;
}>;

type HookEntryAuthorityState = Readonly<{
  deadline: ReporterDeadline;
  durationMilliseconds: number;
  admissionTimeUnixNano: string;
}>;

const authorityState = new WeakMap<object, HookEntryAuthorityState>();
const ownedHookHomes = new WeakMap<object, AgentscopeHome>();
const monotonicNow = performance.now.bind(performance);
const wallClockNow = Date.now.bind(Date);

const invalid = (): never => {
  throw new Error("core.hook-authority.invalid");
};

const exactInput = (
  input: Readonly<{
    durationMilliseconds: number;
    startedAt: number;
  }>,
): Readonly<{ durationMilliseconds: number; startedAt: number }> => {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(descriptors).length !== 2 ||
    !descriptors.durationMilliseconds ||
    !("value" in descriptors.durationMilliseconds) ||
    !descriptors.startedAt ||
    !("value" in descriptors.startedAt)
  )
    return invalid();
  const durationMilliseconds = descriptors.durationMilliseconds
    .value as unknown;
  const startedAt = descriptors.startedAt.value as unknown;
  const now = monotonicNow();
  if (
    typeof durationMilliseconds !== "number" ||
    !Number.isSafeInteger(durationMilliseconds) ||
    durationMilliseconds < MINIMUM_HOOK_DEADLINE_MILLISECONDS ||
    durationMilliseconds > MAXIMUM_HOOK_DEADLINE_MILLISECONDS ||
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    startedAt < 0 ||
    startedAt > now
  )
    return invalid();
  return Object.freeze({ durationMilliseconds, startedAt });
};

export const createHookEntryAuthority = (
  input: Readonly<{
    durationMilliseconds: number;
    startedAt: number;
  }>,
): HookEntryAuthority => {
  try {
    const parsed = exactInput(input);
    const observedMonotonic = monotonicNow();
    const remainingMilliseconds = Math.max(
      0,
      Math.floor(
        parsed.durationMilliseconds - (observedMonotonic - parsed.startedAt),
      ),
    );
    const entryWallMilliseconds = Math.max(
      0,
      Math.floor(wallClockNow() - (observedMonotonic - parsed.startedAt)),
    );
    const authority = Object.freeze({}) as HookEntryAuthority;
    authorityState.set(
      authority,
      Object.freeze({
        deadline: createReporterDeadline(remainingMilliseconds),
        durationMilliseconds: parsed.durationMilliseconds,
        admissionTimeUnixNano: (
          BigInt(entryWallMilliseconds) * 1_000_000n
        ).toString(),
      }),
    );
    return authority;
  } catch {
    return invalid();
  }
};

/** CLI-only transfer from its authenticated launcher verifier into Core. */
export const createOwnedHookEntryAuthorityForCli = (
  input: Readonly<{
    durationMilliseconds: number;
    homeRoot: string;
    platform: NodeJS.Platform;
    startedAt: number;
  }>,
): HookEntryAuthority => {
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
      Reflect.ownKeys(descriptors).length !== 4 ||
      Object.keys(descriptors).sort().join("\0") !==
        "durationMilliseconds\0homeRoot\0platform\0startedAt" ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor))
    )
      return invalid();
    const durationMilliseconds = descriptors.durationMilliseconds
      ?.value as unknown;
    const homeRoot = descriptors.homeRoot?.value as unknown;
    const platform = descriptors.platform?.value as unknown;
    const startedAt = descriptors.startedAt?.value as unknown;
    if (
      typeof durationMilliseconds !== "number" ||
      typeof homeRoot !== "string" ||
      platform !== process.platform ||
      typeof startedAt !== "number"
    )
      return invalid();
    const home = createAgentscopeHomeFromOwnedRootForCore(
      homeRoot,
      platform as NodeJS.Platform,
    );
    const authority = createHookEntryAuthority({
      durationMilliseconds,
      startedAt,
    });
    ownedHookHomes.set(authority, home);
    return authority;
  } catch {
    return invalid();
  }
};

/** Resolves only a Core-branded home previously transferred by the CLI verifier. */
export const resolveOwnedHookHomeForCli = (
  authority: HookEntryAuthority,
): AgentscopeHome => {
  readHookEntryAuthorityForCore(authority);
  const home = ownedHookHomes.get(authority);
  if (!home) return invalid();
  return home;
};

export const readHookEntryAuthorityForCore = (
  authority: HookEntryAuthority,
): HookEntryAuthorityState => {
  try {
    if (
      typeof authority !== "object" ||
      authority === null ||
      !Object.isFrozen(authority)
    )
      return invalid();
    const state = authorityState.get(authority);
    if (!state) return invalid();
    return state;
  } catch {
    return invalid();
  }
};
