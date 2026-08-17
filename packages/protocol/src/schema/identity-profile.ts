import { z } from "zod";

import rawProfile from "../standards/identity-profile.json" with { type: "json" };
import { standardsManifest } from "../standards/manifest.js";
import { fingerprintCanonicalMaterial } from "./extensions.js";
import { deepFreeze } from "./immutable.js";

const fieldTypeSchema = z.enum([
  "utf8",
  "bytes",
  "u64",
  "digest32",
  "ascii-enum",
]);
const fieldSchema = z
  .object({
    tag: z.number().int().positive().max(65_535),
    name: z.string().min(1).max(64),
    type: fieldTypeSchema,
  })
  .strict();
const domainSchema = z
  .object({
    code: z.number().int().positive().max(65_535),
    fields: z.array(fieldSchema).min(1).max(16),
  })
  .strict();
const profileSchema = z
  .object({
    profileVersion: z.literal(1),
    codecVersion: z.literal(1),
    magic: z.literal("ASID"),
    digest: z.literal("sha256"),
    header: z
      .object({
        magicBytes: z.literal(4),
        order: z.tuple([
          z.literal("magic"),
          z.literal("codecVersion"),
          z.literal("profileVersion"),
          z.literal("domainCode"),
          z.literal("fieldCount"),
        ]),
        endianness: z.literal("big-endian"),
        versionWidth: z.literal("u16be"),
        domainWidth: z.literal("u16be"),
        fieldCountWidth: z.literal("u16be"),
      })
      .strict(),
    fieldEncoding: z
      .object({
        tagWidth: z.literal("u16be"),
        typeWidth: z.literal("u8"),
        lengthWidth: z.literal("u32be"),
        integerWidth: z.literal("u64be"),
        fieldOrder: z.literal("ascending-tag"),
        fieldPresence: z.literal("all-required"),
        duplicateTagPolicy: z.literal("reject"),
        unknownTagPolicy: z.literal("reject"),
      })
      .strict(),
    fieldTypes: z
      .object({
        utf8: z.literal(1),
        bytes: z.literal(2),
        u64: z.literal(3),
        digest32: z.literal(4),
        "ascii-enum": z.literal(5),
      })
      .strict(),
    stringPolicy: z
      .object({
        encoding: z.literal("utf8-exact"),
        unicodeNormalization: z.literal("none"),
        loneSurrogatePolicy: z.literal("reject"),
        emptyPolicy: z.literal("reject"),
        maximumBytes: z.literal(1_024),
      })
      .strict(),
    inputLimits: z
      .object({
        maximumDepth: z.literal(12),
        maximumNodes: z.literal(2_048),
        maximumArrayItems: z.literal(256),
        maximumObjectKeys: z.literal(512),
        maximumKeyBytes: z.literal(128),
        maximumTotalUtf8Bytes: z.literal(1_048_576),
        maximumSafeInteger: z.literal(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    output: z
      .object({
        fullBytes: z.literal(32),
        traceIdBytes: z.literal(16),
        spanIdBytes: z.literal(8),
        projection: z.literal("leftmost"),
        encoding: z.literal("lowercase-hex"),
        allZeroPolicy: z.literal("reject"),
        collisionPolicy: z.literal("reject-no-rehash"),
      })
      .strict(),
    enums: z
      .object({
        harnessRegistryId: z.array(z.string()),
        boundaryKind: z.array(z.string()),
        positionKind: z.array(z.string()),
        operationIdScope: z.array(z.string()),
        locatorClass: z.array(z.string()),
        sessionClass: z.array(z.string()),
        nativeIdentityKind: z.array(z.string()),
      })
      .strict(),
    domains: z.record(z.string(), domainSchema),
    fallback: z
      .object({
        native: z.literal("session-stable"),
        boundary: z.literal("boundary-scoped-at-least-once"),
        attempt: z.literal("attempt-scoped-at-least-once"),
        attemptNonceBytes: z.literal(32),
        boundarySeedExcludes: z.array(z.string()),
      })
      .strict(),
    flags: z
      .object({
        allowedSpanFlags: z.array(z.number().int()),
        rejectedRandomSpanFlags: z.array(z.number().int()),
        otherPolicy: z.literal("reject"),
      })
      .strict(),
    privacyExclusions: z.array(z.string()),
  })
  .strict();

export const NATIVE_IDENTITY_KINDS = Object.freeze([
  "conversation",
  "run",
  "session",
  "thread",
] as const);
export type NativeIdentityKind = (typeof NATIVE_IDENTITY_KINDS)[number];

const EXPECTED_ENUMS = {
  harnessRegistryId: [
    "claude-code",
    "codex",
    "gemini-cli",
    "hermes",
    "openclaw",
    "opencode",
    "pi",
  ],
  boundaryKind: ["hook-invocation", "session", "transcript-range", "turn"],
  positionKind: ["byte-offset", "event-index", "line", "sequence"],
  operationIdScope: ["parent-scoped", "session-global"],
  locatorClass: ["native-operation", "source-ordinal"],
  sessionClass: ["native-session", "boundary-scoped", "attempt-scoped"],
  nativeIdentityKind: NATIVE_IDENTITY_KINDS,
} as const;

const EXPECTED_DOMAIN_LAYOUT = {
  "session-native": [
    1,
    [
      "sessionClass:ascii-enum",
      "harnessRegistryId:ascii-enum",
      "nativeIdentityKind:ascii-enum",
      "nativeIdentity:utf8",
    ],
  ],
  "session-boundary": [
    2,
    [
      "sessionClass:ascii-enum",
      "harnessRegistryId:ascii-enum",
      "boundaryKind:ascii-enum",
      "boundaryId:utf8",
    ],
  ],
  "session-attempt": [
    3,
    [
      "sessionClass:ascii-enum",
      "harnessRegistryId:ascii-enum",
      "invocationNonce:bytes",
    ],
  ],
  trace: [4, ["sessionDigest:digest32"]],
  "root-span": [5, ["traceDigest:digest32"]],
  "child-span-session-global-native": [
    6,
    [
      "traceDigest:digest32",
      "locatorClass:ascii-enum",
      "nativeOperationId:utf8",
    ],
  ],
  "child-span-session-global-ordinal": [
    7,
    ["traceDigest:digest32", "locatorClass:ascii-enum", "sourceOrdinal:u64"],
  ],
  "child-span-parent-native": [
    8,
    [
      "traceDigest:digest32",
      "parentSpanDigest:digest32",
      "locatorClass:ascii-enum",
      "nativeOperationId:utf8",
    ],
  ],
  "child-span-parent-ordinal": [
    9,
    [
      "traceDigest:digest32",
      "parentSpanDigest:digest32",
      "locatorClass:ascii-enum",
      "sourceOrdinal:u64",
    ],
  ],
  boundary: [
    10,
    [
      "sessionDigest:digest32",
      "boundaryKind:ascii-enum",
      "boundaryId:utf8",
      "generation:u64",
      "positionKind:ascii-enum",
      "exclusiveEndPosition:u64",
    ],
  ],
  delivery: [11, ["traceDigest:digest32", "boundaryDigest:digest32"]],
} as const;

const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

export class IdentityProfileError extends Error {
  public readonly code = "protocol.identity.invalid";
  public constructor() {
    super("protocol.identity.invalid");
    this.name = "IdentityProfileError";
  }
}

export const validateIdentityProfileForTesting = (input: unknown) => {
  try {
    const profile = profileSchema.parse(input);
    if (!same(profile.enums, EXPECTED_ENUMS)) throw new IdentityProfileError();
    const actualLayout = Object.fromEntries(
      Object.entries(profile.domains).map(([name, domain]) => [
        name,
        [
          domain.code,
          domain.fields.map((field) => `${field.name}:${field.type}`),
        ],
      ]),
    );
    if (!same(actualLayout, EXPECTED_DOMAIN_LAYOUT))
      throw new IdentityProfileError();
    for (const domain of Object.values(profile.domains)) {
      if (!domain.fields.every((field, index) => field.tag === index + 1))
        throw new IdentityProfileError();
    }
    if (
      !same(profile.fallback.boundarySeedExcludes, [
        "generation",
        "positionKind",
        "exclusiveEndPosition",
      ]) ||
      !same(profile.flags.allowedSpanFlags, [0, 1, 256, 257]) ||
      !same(profile.flags.rejectedRandomSpanFlags, [2, 3]) ||
      !same(profile.privacyExclusions, [
        "content",
        "path",
        "git",
        "model",
        "policy",
        "config",
        "harness-version",
        "destination",
        "batch",
        "time",
        "deadline",
        "outcome",
        "semantic-kind",
        "semantic-name",
        "logical-key",
      ])
    )
      throw new IdentityProfileError();
    return deepFreeze(profile);
  } catch {
    throw new IdentityProfileError();
  }
};

export const IDENTITY_PROFILE = validateIdentityProfileForTesting(rawProfile);
export const IDENTITY_PROFILE_FINGERPRINT =
  fingerprintCanonicalMaterial(IDENTITY_PROFILE);
export const validateIdentityProfileBindingForTesting = (binding: unknown) => {
  try {
    const parsed = z
      .object({
        profileVersion: z.literal(IDENTITY_PROFILE.profileVersion),
        profileFingerprint: z.literal(IDENTITY_PROFILE_FINGERPRINT),
      })
      .passthrough()
      .parse(binding);
    return deepFreeze(parsed);
  } catch {
    throw new IdentityProfileError();
  }
};
validateIdentityProfileBindingForTesting(standardsManifest.identityProfile);
