import { isProxy } from "node:util/types";
import { fail, trustedErrorCode } from "./kernel-errors.js";
import type { SelectedPtyExecutionReceipt } from "../pty-terminal-contract.js";
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const objectPrototype = Object.prototype;
const objectKeys = Object.keys;
const safeReflectApply = Reflect.apply;
const numberIsSafeInteger = Number.isSafeInteger;
// eslint-disable-next-line @typescript-eslint/unbound-method -- this intrinsic does not use its receiver
const bufferIsBuffer = Buffer.isBuffer;
const ownData = (value: object, key: string): unknown => {
  const descriptor = getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !("value" in descriptor)
  )
    return fail("testkit.headless.kernel.request");
  return descriptor.value;
};
const plainRecord = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  !isProxy(value) &&
  (getPrototypeOf(value) === objectPrototype || getPrototypeOf(value) === null);
const boundedNonnegativeInteger = (
  value: unknown,
  maximumValue: number,
): value is number =>
  typeof value === "number" &&
  numberIsSafeInteger(value) &&
  value >= 0 &&
  value <= maximumValue;
export type PtyExit = Readonly<{ code: number; signal: number }>;
export type PtyTerminalObservation = Readonly<{
  canonical: boolean;
  columns: number;
  eofByte: number;
  isTTY: boolean;
  rows: number;
}>;
export type PtyReadObservation =
  | Readonly<{ status: "data"; bytes: Buffer }>
  | Readonly<{ status: "eof" | "eio" | "would-block" }>;
export type PtyWriteObservation = Readonly<{
  status: "complete" | "partial" | "would-block";
  bytesWritten: number;
}>;
export const exactPtyExit = (value: PtyExit): PtyExit => {
  if (
    !plainRecord(value) ||
    safeReflectApply(objectKeys, Object, [value]).sort().join("\0") !==
      "code\0signal" ||
    !boundedNonnegativeInteger(ownData(value, "signal"), 64) ||
    !(
      boundedNonnegativeInteger(ownData(value, "code"), 255) &&
      (ownData(value, "signal") === 0 || ownData(value, "code") === 0)
    )
  )
    return fail("testkit.pty.transport");
  return value;
};

export const exactPtyObservation = (
  value: PtyTerminalObservation,
  geometry: Readonly<{ columns: number; rows: number }>,
  requireCanonicalMode: boolean,
): PtyTerminalObservation => {
  if (
    !plainRecord(value) ||
    safeReflectApply(objectKeys, Object, [value]).sort().join("\0") !==
      "canonical\0columns\0eofByte\0isTTY\0rows" ||
    ownData(value, "isTTY") !== true ||
    typeof ownData(value, "canonical") !== "boolean" ||
    (requireCanonicalMode && ownData(value, "canonical") !== true) ||
    ownData(value, "columns") !== geometry.columns ||
    ownData(value, "rows") !== geometry.rows ||
    !boundedNonnegativeInteger(ownData(value, "eofByte"), 255)
  )
    return fail("testkit.pty.geometry");
  return value;
};

export const exactPtyRead = (value: PtyReadObservation): PtyReadObservation => {
  if (!plainRecord(value)) return fail("testkit.pty.transport");
  const status = ownData(value, "status");
  const keys = safeReflectApply(objectKeys, Object, [value]).sort();
  if (status === "data") {
    const bytes = ownData(value, "bytes");
    if (
      keys.join("\0") !== "bytes\0status" ||
      !bufferIsBuffer(bytes) ||
      bytes.length < 1 ||
      bytes.length > 4_096
    )
      return fail("testkit.pty.transport");
  } else if (
    (status !== "eof" && status !== "eio" && status !== "would-block") ||
    keys.length !== 1 ||
    keys[0] !== "status"
  )
    return fail("testkit.pty.transport");
  return value;
};

export const exactPtyWrite = (
  value: PtyWriteObservation,
  maximumBytes: number,
): PtyWriteObservation => {
  if (
    !plainRecord(value) ||
    safeReflectApply(objectKeys, Object, [value]).sort().join("\0") !==
      "bytesWritten\0status" ||
    (ownData(value, "status") !== "complete" &&
      ownData(value, "status") !== "partial" &&
      ownData(value, "status") !== "would-block") ||
    !boundedNonnegativeInteger(ownData(value, "bytesWritten"), maximumBytes) ||
    (ownData(value, "status") === "would-block" &&
      ownData(value, "bytesWritten") !== 0) ||
    (ownData(value, "status") === "complete" &&
      ownData(value, "bytesWritten") !== maximumBytes) ||
    (ownData(value, "status") === "partial" &&
      (ownData(value, "bytesWritten") === 0 ||
        ownData(value, "bytesWritten") === maximumBytes))
  )
    return fail("testkit.pty.transport");
  return value;
};

type PumpDiagnostic = NonNullable<
  SelectedPtyExecutionReceipt["pumpFailureDiagnostic"]
>;
export const classifyPtyPumpFailure = (
  error: unknown,
): PumpDiagnostic["category"] => {
  switch (trustedErrorCode(error)) {
    case "testkit.headless.observer.read":
      return "observer-read";
    case "testkit.headless.observer.identity":
      return "observer-identity";
    case "testkit.pty.transport":
      return "transport";
    case "testkit.pty.geometry":
      return "geometry";
    case "testkit.pty.checkpoint-witness":
      return "checkpoint-witness";
    case "testkit.headless.execution.deadline":
      return "execution-deadline";
    default:
      return "unknown";
  }
};
