import type { StableSemver } from "./types.js";

const stableSemverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const maximumComponent = 2_147_483_647;

export const parseStableSemver = (value: string): StableSemver | undefined => {
  if (value.length === 0 || value.length > 32) return undefined;
  const match = stableSemverPattern.exec(value);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch) ||
    major > maximumComponent ||
    minor > maximumComponent ||
    patch > maximumComponent
  )
    return undefined;
  return Object.freeze({ major, minor, patch, text: value });
};

export const compareStableSemver = (
  left: StableSemver,
  right: StableSemver,
): -1 | 0 | 1 => {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
};

export const stableSemverIsInRange = (
  value: StableSemver,
  minimumInclusive: StableSemver,
  maximumExclusive: StableSemver,
): boolean =>
  compareStableSemver(value, minimumInclusive) >= 0 &&
  compareStableSemver(value, maximumExclusive) < 0;
