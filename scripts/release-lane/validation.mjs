import { createHash } from "node:crypto";

export const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
export const SOURCE_REVISION_PATTERN = /^[a-f0-9]{40}$/u;

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertExactKeys(value, keys, label) {
  assert(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    `${label} must be a plain object`,
  );
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} keys drifted: ${actual.join(",")}`,
  );
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
