import type { OwnedHarnessHookInvocation } from "@agentscope/harnesses-core";

export const CLAUDE_CODE_LIFECYCLE_EVENTS = Object.freeze([
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
] as const);
export type ClaudeCodeLifecycleEvent =
  (typeof CLAUDE_CODE_LIFECYCLE_EVENTS)[number];
const ownedEvents = CLAUDE_CODE_LIFECYCLE_EVENTS.filter(
  (event) => event !== "SessionEnd",
);
export const handlerTimeout = (invocation: OwnedHarnessHookInvocation) =>
  Math.ceil((invocation.hookDeadlineMilliseconds + 2_000) / 1_000);

export const ownedMatcher = (
  invocation: OwnedHarnessHookInvocation,
  event: ClaudeCodeLifecycleEvent,
  command: string,
  legacy = false,
) =>
  Object.freeze({
    agentscope: Object.freeze({
      contractVersion: invocation.contractVersion,
      event,
      harnessType: invocation.harnessType,
      ownershipIdentity: invocation.ownershipIdentity,
    }),
    hooks: Object.freeze([
      Object.freeze({
        type: "command" as const,
        command,
        args: Object.freeze([]),
        ...(legacy ? {} : { timeout: handlerTimeout(invocation) }),
      }),
    ]),
  });

export const ownedSettings = (
  invocation: OwnedHarnessHookInvocation,
  command: string,
  legacy = false,
) => ({
  hooks: Object.fromEntries(
    (legacy ? CLAUDE_CODE_LIFECYCLE_EVENTS : ownedEvents).map((event) => [
      event,
      [ownedMatcher(invocation, event, command, legacy)],
    ]),
  ),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hookArrayEquals = (
  value: unknown,
  command: string,
  timeout?: number,
): boolean => {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const hook: unknown = (value as readonly unknown[])[0];
  return (
    isRecord(hook) &&
    hook.type === "command" &&
    hook.command === command &&
    Array.isArray(hook.args) &&
    hook.args.length === 0 &&
    hook.timeout === timeout &&
    Object.keys(hook).length === (timeout === undefined ? 3 : 4)
  );
};

// Only called over the lifecycle planner's bounded duplicate-free parsed JSON.
// This recognizes representation; it neither authenticates callers nor mints authority.
const ownedMatcherEquals = (
  value: unknown,
  invocation: OwnedHarnessHookInvocation,
  event: ClaudeCodeLifecycleEvent,
  command: string,
  timeout?: number,
): boolean =>
  isRecord(value) &&
  Object.keys(value).sort().join("\0") === "agentscope\0hooks" &&
  hookArrayEquals(value.hooks, command, timeout) &&
  isRecord(value.agentscope) &&
  Object.keys(value.agentscope).sort().join("\0") ===
    "contractVersion\0event\0harnessType\0ownershipIdentity" &&
  value.agentscope.contractVersion === invocation.contractVersion &&
  value.agentscope.event === event &&
  value.agentscope.harnessType === invocation.harnessType &&
  value.agentscope.ownershipIdentity === invocation.ownershipIdentity;

export const ownedMatcherProfile = (
  value: unknown,
  invocation: OwnedHarnessHookInvocation,
  event: string,
  command: string,
): "legacy" | "current" | null => {
  if (!CLAUDE_CODE_LIFECYCLE_EVENTS.includes(event as ClaudeCodeLifecycleEvent))
    return null;
  const nativeEvent = event as ClaudeCodeLifecycleEvent;
  if (ownedMatcherEquals(value, invocation, nativeEvent, command))
    return "legacy";
  return event !== "SessionEnd" &&
    ownedMatcherEquals(
      value,
      invocation,
      nativeEvent,
      command,
      handlerTimeout(invocation),
    )
    ? "current"
    : null;
};
export const profileCountsAreValid = (legacy: number, current: number) =>
  (legacy === 0 && current === 0) ||
  (legacy === 5 && current === 0) ||
  (legacy === 0 && current === 4);
