import { basename, dirname, isAbsolute, resolve } from "node:path";

import {
  isOwnedHarnessHookInvocation,
  type HarnessInstallationPlanner,
  type HarnessTargetDecision,
  type HarnessTargetInspection,
  type OwnedHarnessHookInvocation,
} from "@agentscope/harnesses-core";

import { codexHarnessDescriptor } from "./descriptor.js";
import { parseCodexBoundedDuplicateAwareJson } from "./strict-json.js";

const rootEvents = ["SessionStart", "Stop", "SessionEnd"] as const;
const ownedStatus = "Agentscope trace capture";
const utf8 = new TextDecoder("utf-8", { fatal: true });
const encodeUtf8 = new TextEncoder();
const maximumCodexHookDeadlineMilliseconds = 2_500;
const posixSingleQuoteEscape = `'"'"'`;

type JsonRecord = Record<string, unknown>;
const maximumConfigurationBytes = 262_144;

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
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const emptyRecord = (): JsonRecord => Object.create(null) as JsonRecord;

const setOwnArrayValue = <T>(values: T[], index: number, value: T): void => {
  Object.defineProperty(values, String(index), {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
};

const appendOwnArrayValue = <T>(values: T[], value: T): void => {
  setOwnArrayValue(values, values.length, value);
};

const hasExactOwnKeys = (
  value: JsonRecord,
  expected: readonly string[],
): boolean => {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") return false;
    let matched = false;
    for (let candidate = 0; candidate < expected.length; candidate += 1)
      if (key === expected[candidate]) matched = true;
    if (!matched) return false;
  }
  return true;
};

const cloneOwnJsonData = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const output = new Array<unknown>(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor))
        return invalid();
      setOwnArrayValue(output, index, cloneOwnJsonData(descriptor.value));
    }
    return output;
  }
  if (!plainRecord(value)) return value;
  const output = emptyRecord();
  const keys = Reflect.ownKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return invalid();
    Object.defineProperty(output, key, {
      value: cloneOwnJsonData(descriptor.value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
};

const unknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

const parseDuplicateAwareJson = (bytes: Uint8Array): unknown => {
  try {
    return parseCodexBoundedDuplicateAwareJson(
      bytes,
      maximumConfigurationBytes,
    );
  } catch {
    return invalid();
  }
};

const encodePosixShellWord = (value: string): string => {
  const bytes = encodeUtf8.encode(value);
  if (
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value.length === 0 ||
    bytes.byteLength > 4_096 ||
    utf8.decode(bytes) !== value ||
    (() => {
      for (let index = 0; index < value.length; index += 1)
        if (value[index] === "\0") return true;
      return false;
    })()
  )
    return invalid();
  let encoded = "'";
  for (let index = 0; index < value.length; index += 1)
    encoded += value[index] === "'" ? posixSingleQuoteEscape : value[index];
  return `${encoded}'`;
};

const decodeOwnedPosixShellWord = (value: string): string | undefined => {
  if (value[0] !== "'" || value[value.length - 1] !== "'") return undefined;
  let decoded = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    let escaped = true;
    for (let offset = 0; offset < posixSingleQuoteEscape.length; offset += 1)
      if (value[index + offset] !== posixSingleQuoteEscape[offset])
        escaped = false;
    if (escaped) {
      decoded += "'";
      index += posixSingleQuoteEscape.length - 1;
    } else decoded += value[index];
  }
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
    (invocation.launcherPath.length >= 4 &&
      invocation.launcherPath[invocation.launcherPath.length - 4] === "." &&
      invocation.launcherPath[invocation.launcherPath.length - 3] === "e" &&
      invocation.launcherPath[invocation.launcherPath.length - 2] === "x" &&
      invocation.launcherPath[invocation.launcherPath.length - 1] === "e") ||
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
  const group = emptyRecord();
  Object.defineProperty(group, "hooks", {
    value: [
      {
        type: "command",
        command,
        timeout: 3,
        statusMessage: ownedStatus,
      },
    ],
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const matcher = matcherFor(event);
  if (matcher !== undefined)
    Object.defineProperty(group, "matcher", {
      value: matcher,
      enumerable: true,
      configurable: true,
      writable: true,
    });
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
  if (!hasExactOwnKeys(value, expectedKeys)) return false;
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
    hasExactOwnKeys(handler, ["command", "statusMessage", "timeout", "type"]) &&
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
    !hasExactOwnKeys(value, expectedKeys) ||
    (matcher !== undefined && value.matcher !== matcher) ||
    !unknownArray(value.hooks)
  )
    return false;
  if (value.hooks.length !== 1) return false;
  const handler = value.hooks[0];
  if (
    !plainRecord(handler) ||
    !hasExactOwnKeys(handler, [
      "command",
      "statusMessage",
      "timeout",
      "type",
    ]) ||
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
    const parsed = cloneOwnJsonData(parseDuplicateAwareJson(bytes));
    if (!plainRecord(parsed)) return undefined;
    if (parsed.hooks !== undefined && !plainRecord(parsed.hooks))
      return undefined;
    const hooks = parsed.hooks;
    if (hooks !== undefined)
      for (let index = 0; index < rootEvents.length; index += 1) {
        const event = rootEvents[index]!;
        if (hooks[event] !== undefined && !unknownArray(hooks[event]))
          return undefined;
      }
    return parsed;
  } catch {
    return undefined;
  }
};

const quoteJsonString = (value: string): string => JSON.stringify(value);

const serializeOwnJsonData = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string") return quoteJsonString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : invalid();
  if (Array.isArray(value)) {
    let output = "[";
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor))
        return invalid();
      output += `${index === 0 ? "" : ","}${serializeOwnJsonData(descriptor.value)}`;
    }
    return `${output}]`;
  }
  if (!plainRecord(value)) return invalid();
  const keys = Reflect.ownKeys(value);
  let output = "{";
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return invalid();
    output += `${index === 0 ? "" : ","}${quoteJsonString(key)}:${serializeOwnJsonData(descriptor.value)}`;
  }
  return `${output}}`;
};

const serializeConfiguration = (root: JsonRecord): Uint8Array =>
  encodeUtf8.encode(`${serializeOwnJsonData(root)}\n`);

const installOwnedGroups = (
  root: JsonRecord,
  command: string,
  invocation: OwnedHarnessHookInvocation,
  replaceOverlap: boolean,
): Uint8Array => {
  const hooks = plainRecord(root.hooks) ? root.hooks : emptyRecord();
  for (let eventIndex = 0; eventIndex < rootEvents.length; eventIndex += 1) {
    const event = rootEvents[eventIndex]!;
    const eventValue = hooks[event];
    const current = unknownArray(eventValue) ? eventValue : [];
    const replacement: unknown[] = [];
    if (!replaceOverlap)
      for (let index = 0; index < current.length; index += 1)
        if (!ownedGroupForHarness(current[index], event, invocation))
          appendOwnArrayValue(replacement, current[index]);
    appendOwnArrayValue(replacement, ownedGroup(event, command));
    hooks[event] = replacement;
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
  for (let eventIndex = 0; eventIndex < rootEvents.length; eventIndex += 1) {
    const event = rootEvents[eventIndex]!;
    const eventGroups = hooks[event];
    if (!unknownArray(eventGroups)) continue;
    const retained: unknown[] = [];
    for (let index = 0; index < eventGroups.length; index += 1)
      if (!ownedGroupForHarness(eventGroups[index], event, invocation))
        appendOwnArrayValue(retained, eventGroups[index]);
    if (retained.length === eventGroups.length) continue;
    changed = true;
    if (retained.length === 0) delete hooks[event];
    else hooks[event] = retained;
  }
  if (!changed) return { kind: "unchanged" };
  if (Reflect.ownKeys(hooks).length === 0) delete root.hooks;
  return Reflect.ownKeys(root).length === 0
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
      bytes: installOwnedGroups(emptyRecord(), command, invocation, false),
    };
  }
  const root = parseConfiguration(target.bytes);
  if (root === undefined)
    return operation === "uninstall"
      ? { kind: "unchanged" }
      : { kind: "unsupported" };
  if (operation === "uninstall") return uninstallOwnedGroups(root, invocation);
  const hooks = plainRecord(root.hooks) ? root.hooks : emptyRecord();
  let foreignOverlap = false;
  for (let eventIndex = 0; eventIndex < rootEvents.length; eventIndex += 1) {
    const event = rootEvents[eventIndex]!;
    const eventValue = hooks[event];
    const groups = unknownArray(eventValue) ? eventValue : [];
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1)
      if (!ownedGroupForHarness(groups[groupIndex], event, invocation))
        foreignOverlap = true;
  }
  if (foreignOverlap && operation === "install")
    return { kind: "replace-overlap", bytes: new Uint8Array() };
  let complete = true;
  for (let index = 0; index < rootEvents.length; index += 1) {
    const event = rootEvents[index]!;
    const eventValue = hooks[event];
    const eventGroups = unknownArray(eventValue) ? eventValue : [];
    if (
      eventGroups.length !== 1 ||
      !currentGroup(eventGroups[0], event, command)
    )
      complete = false;
  }
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
