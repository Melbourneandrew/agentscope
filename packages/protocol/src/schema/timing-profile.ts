import { z } from "zod";

import rawTimingProfile from "../standards/timing-profile.json" with { type: "json" };
import { standardsManifest } from "../standards/manifest.js";
import { deepFreeze } from "./immutable.js";
import { fingerprintCanonicalMaterial } from "./extensions.js";

export const PROVENANCE_SOURCES = deepFreeze([
  "hook-payload",
  "native-artifact",
  "harness-config",
  "git",
  "process",
  "derived",
] as const);
export const TIMING_BASES = deepFreeze([
  "native-interval",
  "native-point",
  "artifact-point",
  "hook-observed-point",
  "derived-child-envelope",
] as const);
export const NATIVE_STATES = deepFreeze(["observed", "unavailable"] as const);
export const TIMING_LOCATIONS = deepFreeze(["root-span", "span"] as const);

const timingRuleSchema = z.discriminatedUnion("timingBasis", [
  z
    .object({
      timingBasis: z.literal("native-interval"),
      nativeState: z.literal("observed"),
      allowedSources: z.tuple([
        z.literal("hook-payload"),
        z.literal("native-artifact"),
      ]),
      shape: z.literal("interval"),
      evidenceClass: z.literal("native-operation-time"),
      locations: z.tuple([z.literal("root-span"), z.literal("span")]),
      construction: z.literal("evidence-values"),
    })
    .strict(),
  z
    .object({
      timingBasis: z.literal("native-point"),
      nativeState: z.literal("observed"),
      allowedSources: z.tuple([
        z.literal("hook-payload"),
        z.literal("native-artifact"),
      ]),
      shape: z.literal("point"),
      evidenceClass: z.literal("native-operation-time"),
      locations: z.tuple([z.literal("root-span"), z.literal("span")]),
      construction: z.literal("evidence-values"),
    })
    .strict(),
  z
    .object({
      timingBasis: z.literal("artifact-point"),
      nativeState: z.literal("unavailable"),
      allowedSources: z.tuple([z.literal("native-artifact")]),
      shape: z.literal("point"),
      evidenceClass: z.literal("artifact-observation-time"),
      locations: z.tuple([z.literal("root-span"), z.literal("span")]),
      construction: z.literal("evidence-values"),
    })
    .strict(),
  z
    .object({
      timingBasis: z.literal("hook-observed-point"),
      nativeState: z.literal("unavailable"),
      allowedSources: z.tuple([z.literal("process")]),
      shape: z.literal("point"),
      evidenceClass: z.literal("hook-invocation-time"),
      locations: z.tuple([z.literal("root-span"), z.literal("span")]),
      construction: z.literal("evidence-values"),
    })
    .strict(),
  z
    .object({
      timingBasis: z.literal("derived-child-envelope"),
      nativeState: z.literal("unavailable"),
      allowedSources: z.tuple([z.literal("derived")]),
      shape: z.literal("interval"),
      evidenceClass: z.literal("derived-trace-envelope"),
      locations: z.tuple([z.literal("root-span")]),
      construction: z.literal("descendant-min-max"),
    })
    .strict(),
]);
const timingProfileSchema = z
  .object({
    descriptorVersion: z.number().int().positive(),
    rules: z.array(timingRuleSchema).length(TIMING_BASES.length),
  })
  .strict();

export class TimingProfileError extends Error {
  readonly code = "protocol.timing-profile.invalid";

  constructor() {
    super("protocol.timing-profile.invalid");
    this.name = "TimingProfileError";
  }
}

const compileTimingProfile = (input: unknown) => {
  const parsed = timingProfileSchema.safeParse(input);
  if (!parsed.success) throw new TimingProfileError();
  const seen = new Set<string>();
  for (const rule of parsed.data.rules) {
    if (seen.has(rule.timingBasis)) throw new TimingProfileError();
    seen.add(rule.timingBasis);
  }
  return deepFreeze({
    descriptorVersion: parsed.data.descriptorVersion,
    rules: [...parsed.data.rules]
      .sort((left, right) => (left.timingBasis < right.timingBasis ? -1 : 1))
      .map((rule) => ({
        ...rule,
        allowedSources: [...rule.allowedSources].sort(),
      })),
  });
};

export const timingProfile = compileTimingProfile(rawTimingProfile);
export const TIMING_PROFILE_FINGERPRINT =
  fingerprintCanonicalMaterial(timingProfile);

export const validateTimingProfileIdentity = (
  expectedFingerprint = standardsManifest.canonicalProfile
    .timingDescriptorFingerprint,
  expectedVersion = standardsManifest.canonicalProfile.timingDescriptorVersion,
) => {
  if (
    TIMING_PROFILE_FINGERPRINT !== expectedFingerprint ||
    timingProfile.descriptorVersion !== expectedVersion
  )
    throw new TimingProfileError();
};

validateTimingProfileIdentity();

export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];
export type TimingBasis = (typeof TIMING_BASES)[number];
export type NativeState = (typeof NATIVE_STATES)[number];
export type TimingCompatibilityRule = (typeof timingProfile.rules)[number];
export type TimingLocation = (typeof TIMING_LOCATIONS)[number];

export const getTimingCompatibilityRule = (basis: TimingBasis) => {
  const rule = timingProfile.rules.find(
    (candidate) => candidate.timingBasis === basis,
  );
  if (rule === undefined) throw new TimingProfileError();
  return rule;
};

export const createTimingProvenanceValue = (value: {
  source: ProvenanceSource;
  timingBasis: TimingBasis;
  location: TimingLocation;
}) => {
  const rule = getTimingCompatibilityRule(value.timingBasis);
  const allowedSources: readonly ProvenanceSource[] = rule.allowedSources;
  const allowedLocations: readonly TimingLocation[] = rule.locations;
  if (
    !allowedSources.includes(value.source) ||
    !allowedLocations.includes(value.location)
  )
    throw new TimingProfileError();
  return deepFreeze({
    source: value.source,
    timingBasis: value.timingBasis,
    nativeState: rule.nativeState,
  });
};

export const isTimingProvenanceCompatible = (value: {
  source: ProvenanceSource;
  timingBasis: TimingBasis;
  nativeState: NativeState;
  location: TimingLocation;
}) => {
  const rule = getTimingCompatibilityRule(value.timingBasis);
  const allowedSources: readonly ProvenanceSource[] = rule.allowedSources;
  const allowedLocations: readonly TimingLocation[] = rule.locations;
  return (
    rule.nativeState === value.nativeState &&
    allowedSources.includes(value.source) &&
    allowedLocations.includes(value.location)
  );
};

export const validateTimingProfileForTesting = (input: unknown) =>
  compileTimingProfile(input);
