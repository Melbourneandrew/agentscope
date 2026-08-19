import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import type { HarnessTypeId } from "./types.js";

export const HARNESS_HOOK_CONTRACT_VERSION = 1 as const;
export const HARNESS_HOOK_COMMAND = "capture-hook-v1" as const;

const maximumPathLength = 4_096;
const maximumEvidenceBytes = 65_536;
const harnessTypePattern = /^@agentscope\/harness-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const typedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
/* v8 ignore next -- the fallback is reachable only if a supported Node
   runtime removes the intrinsic typed-array byteLength descriptor. */
const typedArrayByteLength: unknown = Reflect.get(
  Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength") ?? {},
  "get",
);
const typedArraySlice: unknown = Reflect.get(Uint8Array.prototype, "slice");

declare const invocationBrand: unique symbol;
export type OwnedHarnessHookInvocation = Readonly<{
  executablePath: string;
  arguments: readonly [
    typeof HARNESS_HOOK_COMMAND,
    "--contract-version",
    "1",
    "--harness",
    HarnessTypeId,
  ];
  contractVersion: typeof HARNESS_HOOK_CONTRACT_VERSION;
  harnessType: HarnessTypeId;
  ownershipIdentity: string;
  contextEvidence: Uint8Array;
  readonly [invocationBrand]: true;
}>;

export type OwnedHarnessHookInvocationInput = Readonly<{
  executablePath: string;
  harnessType: string;
  contextEvidence: Uint8Array;
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

const copyEvidence = (value: unknown): Uint8Array => {
  try {
    if (
      !(value instanceof Uint8Array) ||
      Object.getPrototypeOf(value) !== Uint8Array.prototype ||
      typeof typedArrayByteLength !== "function" ||
      typeof typedArraySlice !== "function"
    )
      return invalid();
    const length = Reflect.apply(typedArrayByteLength, value, []) as unknown;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length > maximumEvidenceBytes ||
      Reflect.ownKeys(Object.getOwnPropertyDescriptors(value)).some(
        (key) =>
          typeof key !== "string" ||
          !/^(0|[1-9][0-9]*)$/u.test(key) ||
          Number(key) >= length,
      )
    )
      return invalid();
    const output: unknown = Reflect.apply(typedArraySlice, value, [0, length]);
    /* v8 ignore next -- the captured native slice intrinsic returns a
       Uint8Array after the exact receiver validation above. */
    if (!(output instanceof Uint8Array)) return invalid();
    return output;
  } catch {
    return invalid();
  }
};

const exactInput = (
  input: OwnedHarnessHookInvocationInput,
): Readonly<{
  executablePath: string;
  harnessType: HarnessTypeId;
  contextEvidence: Uint8Array;
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
        "contextEvidence\0executablePath\0harnessType" ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor))
    )
      return invalid();
    const executablePath = descriptors.executablePath.value as unknown;
    const harnessType = descriptors.harnessType.value as unknown;
    const contextEvidence = descriptors.contextEvidence.value as unknown;
    if (
      typeof executablePath !== "string" ||
      !isAbsolute(executablePath) ||
      executablePath.length === 0 ||
      executablePath.length > maximumPathLength ||
      typeof harnessType !== "string" ||
      !harnessTypePattern.test(harnessType) ||
      !(contextEvidence instanceof Uint8Array)
    )
      return invalid();
    const copiedEvidence = copyEvidence(contextEvidence);
    return Object.freeze({
      executablePath,
      harnessType: harnessType as HarnessTypeId,
      contextEvidence: copiedEvidence,
    });
  } catch {
    return invalid();
  }
};

export const createOwnedHarnessHookInvocation = (
  input: OwnedHarnessHookInvocationInput,
): OwnedHarnessHookInvocation => {
  const parsed = exactInput(input);
  const arguments_ = Object.freeze([
    HARNESS_HOOK_COMMAND,
    "--contract-version",
    String(HARNESS_HOOK_CONTRACT_VERSION),
    "--harness",
    parsed.harnessType,
  ]) as OwnedHarnessHookInvocation["arguments"];
  const ownershipIdentity = `agentscope-hook-v1-sha256-${createHash("sha256")
    .update(
      JSON.stringify({
        contractVersion: HARNESS_HOOK_CONTRACT_VERSION,
        executablePath: parsed.executablePath,
        arguments: arguments_,
      }),
      "utf8",
    )
    .digest("hex")}`;
  const invocation = Object.freeze({
    executablePath: parsed.executablePath,
    arguments: arguments_,
    contractVersion: HARNESS_HOOK_CONTRACT_VERSION,
    harnessType: parsed.harnessType,
    ownershipIdentity,
    contextEvidence: parsed.contextEvidence,
  }) as OwnedHarnessHookInvocation;
  invocations.add(invocation);
  return invocation;
};

export const isOwnedHarnessHookInvocation = (
  value: unknown,
): value is OwnedHarnessHookInvocation =>
  typeof value === "object" && value !== null && invocations.has(value);

export const readOwnedHarnessHookInvocationForCore = (
  invocation: OwnedHarnessHookInvocation,
): Readonly<{
  executablePath: string;
  arguments: OwnedHarnessHookInvocation["arguments"];
  ownershipIdentity: string;
  contextEvidence: Uint8Array;
}> => {
  if (!isOwnedHarnessHookInvocation(invocation)) return invalid();
  return Object.freeze({
    executablePath: invocation.executablePath,
    arguments: invocation.arguments,
    ownershipIdentity: invocation.ownershipIdentity,
    contextEvidence: new Uint8Array(invocation.contextEvidence),
  });
};
