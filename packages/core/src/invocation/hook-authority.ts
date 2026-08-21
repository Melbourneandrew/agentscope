import type { ReporterDeadline } from "@agentscope/destinations-core";
import { createReporterDeadline } from "@agentscope/destinations-core/core-orchestration";

import {
  MAXIMUM_HOOK_DEADLINE_MILLISECONDS,
  MINIMUM_HOOK_DEADLINE_MILLISECONDS,
} from "../configuration/schema.js";

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
