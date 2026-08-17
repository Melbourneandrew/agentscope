import type { CapturedValueCandidate } from "./types.js";

export const CAPTURE_LIMITS = Object.freeze({
  maximumBytes: 1_048_576,
  maximumArrayItems: 8_192,
  maximumDepth: 10,
  maximumEventsPerOperation: 128,
  maximumFieldsPerContainer: 192,
  maximumLinksPerOperation: 64,
  maximumNodes: 16_384,
  maximumObjectKeys: 256,
  maximumOperations: 256,
  maximumStringBytes: 65_536,
});

export class CapturedTraceError extends Error {
  public readonly code = "core.capture.invalid";

  public constructor() {
    super("core.capture.invalid");
    this.name = "CapturedTraceError";
  }
}

type CloneBudget = { bytes: number; nodes: number };

const clone = (
  value: unknown,
  depth: number,
  budget: CloneBudget,
  seen: WeakSet<object>,
): CapturedValueCandidate => {
  budget.nodes += 1;
  if (
    depth > CAPTURE_LIMITS.maximumDepth ||
    budget.nodes > CAPTURE_LIMITS.maximumNodes
  )
    throw new CapturedTraceError();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CapturedTraceError();
    return value;
  }
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value);
    budget.bytes += bytes;
    if (
      bytes > CAPTURE_LIMITS.maximumStringBytes ||
      budget.bytes > CAPTURE_LIMITS.maximumBytes
    )
      throw new CapturedTraceError();
    return value;
  }
  if (typeof value !== "object") throw new CapturedTraceError();
  if (seen.has(value)) throw new CapturedTraceError();
  const isArray = Array.isArray(value);
  if (
    Object.getPrototypeOf(value) !==
    (isArray ? Array.prototype : Object.prototype)
  )
    throw new CapturedTraceError();
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >;
  const keys = Object.keys(descriptors);
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new CapturedTraceError();
  if (
    keys.length >
    (isArray
      ? CAPTURE_LIMITS.maximumArrayItems + 1
      : CAPTURE_LIMITS.maximumObjectKeys)
  )
    throw new CapturedTraceError();
  if (
    keys.some((key) => {
      const descriptor = descriptors[key];
      return (
        descriptor === undefined || "get" in descriptor || "set" in descriptor
      );
    })
  )
    throw new CapturedTraceError();
  seen.add(value);
  if (isArray) {
    const length: unknown = descriptors.length?.value;
    if (
      typeof length !== "number" ||
      !Number.isInteger(length) ||
      length < 0 ||
      length > CAPTURE_LIMITS.maximumArrayItems ||
      keys.some(
        (key) =>
          key !== "length" &&
          (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= length),
      )
    )
      throw new CapturedTraceError();
    return Object.freeze(
      Array.from({ length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined) throw new CapturedTraceError();
        return clone(descriptor.value, depth + 1, budget, seen);
      }),
    );
  }
  const output = Object.create(null) as unknown as Record<
    string,
    CapturedValueCandidate
  >;
  for (const key of keys) {
    budget.bytes += Buffer.byteLength(key);
    if (budget.bytes > CAPTURE_LIMITS.maximumBytes)
      throw new CapturedTraceError();
    output[key] = clone(descriptors[key]!.value, depth + 1, budget, seen);
  }
  return Object.freeze(output);
};

export const clonePlainData = (value: unknown): CapturedValueCandidate =>
  clone(value, 0, { bytes: 0, nodes: 0 }, new WeakSet());

export const deepFreezePrivate = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) deepFreezePrivate(child);
  return Object.freeze(value);
};
