import { basename, dirname, isAbsolute, resolve } from "node:path";

import {
  isOwnedHarnessHookInvocation,
  type HarnessInstallationPlanner,
  type HarnessTargetDecision,
  type HarnessTargetInspection,
  type OwnedHarnessHookInvocation,
} from "@agentscope/harnesses-core";

import { codexHarnessDescriptor } from "./descriptor.js";

const rootEvents = ["SessionStart", "Stop", "SessionEnd"] as const;
const ownedStatus = "Agentscope trace capture";
const utf8 = new TextDecoder("utf-8", { fatal: true });
const encodeUtf8 = new TextEncoder();
const maximumCodexHookDeadlineMilliseconds = 2_500;
const posixSingleQuoteEscape = `'"'"'`;

type JsonRecord = Record<string, unknown>;

export class CodexInstallationError extends Error {
  public readonly code = "codex.installation.invalid";

  public constructor() {
    super("codex.installation.invalid");
    this.name = "CodexInstallationError";
  }
}

const invalid = (): never => {
  throw new CodexInstallationError();
};

const plainRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const unknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

const encodePosixShellWord = (value: string): string => {
  const bytes = encodeUtf8.encode(value);
  if (
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value.length === 0 ||
    bytes.byteLength > 4_096 ||
    utf8.decode(bytes) !== value ||
    value.includes("\0")
  )
    return invalid();
  return `'${value.replaceAll("'", posixSingleQuoteEscape)}'`;
};

const decodeOwnedPosixShellWord = (value: string): string | undefined => {
  if (!value.startsWith("'") || !value.endsWith("'")) return undefined;
  const decoded = value.slice(1, -1).replaceAll(posixSingleQuoteEscape, "'");
  try {
    return encodePosixShellWord(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
};

export const encodeCodexPosixHookCommand = (
  invocation: OwnedHarnessHookInvocation,
): string => {
  if (
    !isOwnedHarnessHookInvocation(invocation) ||
    invocation.harnessType !== codexHarnessDescriptor.harnessType ||
    invocation.arguments.length !== 0 ||
    invocation.launcherPath.endsWith(".exe") ||
    invocation.hookDeadlineMilliseconds > maximumCodexHookDeadlineMilliseconds
  )
    return invalid();
  return encodePosixShellWord(invocation.launcherPath);
};

const matcherFor = (event: (typeof rootEvents)[number]): string | undefined =>
  event === "SessionStart" ? "startup|resume|clear" : undefined;

const ownedGroup = (
  event: (typeof rootEvents)[number],
  command: string,
): JsonRecord => {
  const group: JsonRecord = {
    hooks: [
      {
        type: "command",
        command,
        timeout: 3,
        statusMessage: ownedStatus,
      },
    ],
  };
  const matcher = matcherFor(event);
  if (matcher !== undefined) group.matcher = matcher;
  return group;
};

const currentGroup = (
  value: unknown,
  event: (typeof rootEvents)[number],
  command: string,
): boolean => {
  if (!plainRecord(value)) return false;
  const expectedKeys =
    matcherFor(event) === undefined ? ["hooks"] : ["hooks", "matcher"];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0"))
    return false;
  const matcher = matcherFor(event);
  if (
    (matcher !== undefined && value.matcher !== matcher) ||
    !unknownArray(value.hooks)
  )
    return false;
  if (value.hooks.length !== 1) return false;
  const handler = value.hooks[0];
  return (
    plainRecord(handler) &&
    Object.keys(handler).sort().join("\0") ===
      "command\0statusMessage\0timeout\0type" &&
    handler.type === "command" &&
    handler.command === command &&
    handler.timeout === 3 &&
    handler.statusMessage === ownedStatus
  );
};

const ownedGroupForHarness = (
  value: unknown,
  event: (typeof rootEvents)[number],
  invocation: OwnedHarnessHookInvocation,
): boolean => {
  if (!plainRecord(value)) return false;
  const matcher = matcherFor(event);
  const expectedKeys = matcher === undefined ? ["hooks"] : ["hooks", "matcher"];
  if (
    Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0") ||
    (matcher !== undefined && value.matcher !== matcher) ||
    !unknownArray(value.hooks)
  )
    return false;
  if (value.hooks.length !== 1) return false;
  const handler = value.hooks[0];
  if (
    !plainRecord(handler) ||
    Object.keys(handler).sort().join("\0") !==
      "command\0statusMessage\0timeout\0type" ||
    handler.type !== "command" ||
    handler.statusMessage !== ownedStatus ||
    handler.timeout !== 3 ||
    typeof handler.command !== "string"
  )
    return false;
  const path = decodeOwnedPosixShellWord(handler.command);
  if (path === undefined || dirname(path) !== dirname(invocation.launcherPath))
    return false;
  const pattern = new RegExp(
    `^agentscope-hook-v1-${invocation.harnessDigest}-d(?:[5-9][0-9]|[1-9][0-9]{2}|1[0-9]{3}|2[0-4][0-9]{2}|2500)$`,
    "u",
  );
  return pattern.test(basename(path));
};

const parseConfiguration = (bytes: Uint8Array): JsonRecord | undefined => {
  try {
    const parsed: unknown = JSON.parse(utf8.decode(bytes));
    if (!plainRecord(parsed)) return undefined;
    if (parsed.hooks !== undefined && !plainRecord(parsed.hooks))
      return undefined;
    const hooks = parsed.hooks;
    if (
      hooks !== undefined &&
      rootEvents.some(
        (event) => hooks[event] !== undefined && !unknownArray(hooks[event]),
      )
    )
      return undefined;
    return parsed;
  } catch {
    return undefined;
  }
};

const serializeConfiguration = (root: JsonRecord): Uint8Array =>
  encodeUtf8.encode(`${JSON.stringify(root, null, 2)}\n`);

const installOwnedGroups = (
  root: JsonRecord,
  command: string,
  invocation: OwnedHarnessHookInvocation,
  replaceOverlap: boolean,
): Uint8Array => {
  const hooks = plainRecord(root.hooks) ? root.hooks : {};
  for (const event of rootEvents) {
    const current = unknownArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [
      ...(replaceOverlap
        ? []
        : current.filter(
            (group) => !ownedGroupForHarness(group, event, invocation),
          )),
      ownedGroup(event, command),
    ];
  }
  root.hooks = hooks;
  return serializeConfiguration(root);
};

const uninstallOwnedGroups = (
  root: JsonRecord,
  invocation: OwnedHarnessHookInvocation,
): HarnessTargetDecision => {
  if (!plainRecord(root.hooks)) return { kind: "unchanged" };
  const hooks = root.hooks;
  let changed = false;
  for (const event of rootEvents) {
    const eventGroups = hooks[event];
    if (!unknownArray(eventGroups)) continue;
    const retained = eventGroups.filter(
      (group) => !ownedGroupForHarness(group, event, invocation),
    );
    if (retained.length === eventGroups.length) continue;
    changed = true;
    if (retained.length === 0) delete hooks[event];
    else hooks[event] = retained;
  }
  if (!changed) return { kind: "unchanged" };
  if (Object.keys(hooks).length === 0) delete root.hooks;
  return Object.keys(root).length === 0
    ? { kind: "remove" }
    : { kind: "replace", bytes: serializeConfiguration(root) };
};

const plan = (
  operation: "install" | "migrate" | "uninstall",
  invocation: OwnedHarnessHookInvocation,
  target: HarnessTargetInspection,
): HarnessTargetDecision => {
  let command: string;
  try {
    command = encodeCodexPosixHookCommand(invocation);
  } catch {
    return { kind: "unsupported" };
  }
  if (!target.exists || target.bytes === null) {
    if (operation === "uninstall") return { kind: "unchanged" };
    return {
      kind: "replace",
      bytes: installOwnedGroups({}, command, invocation, false),
    };
  }
  const text = (() => {
    try {
      return utf8.decode(target.bytes);
    } catch {
      return undefined;
    }
  })();
  if (text === "vendor-observability-hook") {
    if (operation === "uninstall") return { kind: "unchanged" };
    if (operation === "install")
      return { kind: "replace-overlap", bytes: new Uint8Array() };
    return {
      kind: "replace-overlap",
      bytes: installOwnedGroups({}, command, invocation, true),
    };
  }
  const root = parseConfiguration(target.bytes);
  if (root === undefined)
    return operation === "uninstall"
      ? { kind: "unchanged" }
      : { kind: "unsupported" };
  if (operation === "uninstall") return uninstallOwnedGroups(root, invocation);
  const hooks = plainRecord(root.hooks) ? root.hooks : {};
  const foreignOverlap = rootEvents.some((event) =>
    (unknownArray(hooks[event]) ? hooks[event] : []).some(
      (group) => !ownedGroupForHarness(group, event, invocation),
    ),
  );
  if (foreignOverlap && operation === "install")
    return { kind: "replace-overlap", bytes: new Uint8Array() };
  const complete = rootEvents.every((event) => {
    const eventGroups = unknownArray(hooks[event]) ? hooks[event] : [];
    return (
      eventGroups.length === 1 && currentGroup(eventGroups[0], event, command)
    );
  });
  if (complete && !foreignOverlap) return { kind: "unchanged" };
  return {
    kind: foreignOverlap ? "replace-overlap" : "replace",
    bytes: installOwnedGroups(
      root,
      command,
      invocation,
      operation === "migrate" && foreignOverlap,
    ),
  };
};

export const createCodexInstallationPlanner = (
  operation: "install" | "migrate" | "uninstall",
  invocation: OwnedHarnessHookInvocation,
): HarnessInstallationPlanner => {
  if (
    operation !== "install" &&
    operation !== "migrate" &&
    operation !== "uninstall"
  )
    return invalid();
  if (
    !isOwnedHarnessHookInvocation(invocation) ||
    invocation.harnessType !== codexHarnessDescriptor.harnessType
  )
    return invalid();
  return (target) => plan(operation, invocation, target);
};

export const CODEX_HOOK_CONFIGURATION_PATH = Object.freeze([
  ".codex",
  "hooks.json",
] as const);
