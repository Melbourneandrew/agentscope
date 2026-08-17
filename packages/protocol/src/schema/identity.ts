import { createHash } from "node:crypto";

import { deepFreeze } from "./immutable.js";
import {
  IDENTITY_PROFILE,
  IDENTITY_PROFILE_FINGERPRINT,
} from "./identity-profile.js";

declare const identityBrand: unique symbol;
type Brand<Name extends string> = string & { readonly [identityBrand]: Name };
export type SessionIdentity = Brand<"SessionIdentity">;
export type W3CTraceId = Brand<"W3CTraceId">;
export type W3CSpanId = Brand<"W3CSpanId">;
export type BoundaryIdentity = Brand<"BoundaryIdentity">;
export type DeliveryIdentity = Brand<"DeliveryIdentity">;
export type IdentityStability =
  | "session-stable"
  | "boundary-scoped-at-least-once"
  | "attempt-scoped-at-least-once";

export type IdentityBundle = Readonly<{
  stability: IdentityStability;
  sessionId: SessionIdentity;
  traceId: W3CTraceId;
  spans: Readonly<Record<string, W3CSpanId>>;
  boundaryId: BoundaryIdentity;
  deliveryId: DeliveryIdentity;
}>;

const identityBundleRegistry = new WeakSet<object>();
const identityBundleTopology = new WeakMap<
  object,
  Readonly<Record<string, string | undefined>>
>();

/** Internal lifecycle check used by the Core-only finalization entrypoint. */
export const isDerivedIdentityBundle = (
  value: unknown,
): value is IdentityBundle =>
  typeof value === "object" &&
  value !== null &&
  identityBundleRegistry.has(value);

/** Internal association used only while Core finalizes logical spans. */
export const getDerivedIdentityBundleTopology = (
  value: IdentityBundle,
): Readonly<Record<string, string | undefined>> | undefined =>
  identityBundleRegistry.has(value)
    ? identityBundleTopology.get(value)
    : undefined;

export class IdentityError extends Error {
  public readonly code = "protocol.identity.invalid";
  public constructor() {
    super("protocol.identity.invalid");
    this.name = "IdentityError";
  }
}

export { IDENTITY_PROFILE, IDENTITY_PROFILE_FINGERPRINT };

type Data =
  | null
  | boolean
  | number
  | string
  | readonly Data[]
  | { readonly [key: string]: Data };
const clone = (input: unknown): Data => {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let totalUtf8Bytes = 0;
  const visit = (value: unknown, depth: number): Data => {
    nodes += 1;
    if (
      depth > IDENTITY_PROFILE.inputLimits.maximumDepth ||
      nodes > IDENTITY_PROFILE.inputLimits.maximumNodes
    )
      throw new IdentityError();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > IDENTITY_PROFILE.inputLimits.maximumSafeInteger
      )
        throw new IdentityError();
      return value;
    }
    if (typeof value === "string") {
      const bytes = Buffer.byteLength(value);
      totalUtf8Bytes += bytes;
      if (
        bytes > IDENTITY_PROFILE.stringPolicy.maximumBytes ||
        totalUtf8Bytes > IDENTITY_PROFILE.inputLimits.maximumTotalUtf8Bytes
      )
        throw new IdentityError();
      return value;
    }
    if (typeof value !== "object" || seen.has(value)) throw new IdentityError();
    const array = Array.isArray(value);
    if (
      Object.getPrototypeOf(value) !==
      (array ? Array.prototype : Object.prototype)
    )
      throw new IdentityError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0)
      throw new IdentityError();
    const keys = Object.keys(descriptors);
    totalUtf8Bytes += keys.reduce(
      (sum, key) => sum + Buffer.byteLength(key),
      0,
    );
    if (
      keys.length > IDENTITY_PROFILE.inputLimits.maximumObjectKeys ||
      totalUtf8Bytes > IDENTITY_PROFILE.inputLimits.maximumTotalUtf8Bytes ||
      keys.some(
        (key) =>
          Buffer.byteLength(key) > IDENTITY_PROFILE.inputLimits.maximumKeyBytes,
      ) ||
      keys.some(
        (key) => "get" in descriptors[key]! || "set" in descriptors[key]!,
      )
    )
      throw new IdentityError();
    seen.add(value);
    if (array) {
      const length = descriptors.length?.value as unknown;
      if (
        typeof length !== "number" ||
        length > IDENTITY_PROFILE.inputLimits.maximumArrayItems ||
        keys.length !== length + 1
      )
        throw new IdentityError();
      return Object.freeze(
        Array.from({ length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined) throw new IdentityError();
          return visit(descriptor.value, depth + 1);
        }),
      );
    }
    const output = Object.create(null) as Record<string, Data>;
    for (const key of keys)
      output[key] = visit(descriptors[key]!.value, depth + 1);
    return Object.freeze(output);
  };
  try {
    return visit(input, 0);
  } catch {
    throw new IdentityError();
  }
};
const record = (
  value: Data,
  required: readonly string[],
  optional: readonly string[] = [],
) => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new IdentityError();
  const keys = Object.keys(value);
  if (
    required.some((key) => !(key in value)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new IdentityError();
  return value as Record<string, Data>;
};
const string = (value: Data) => {
  if (typeof value !== "string" || value.length === 0)
    throw new IdentityError();
  return value;
};
const integer = (value: Data) => {
  /* v8 ignore next -- hostile numeric values are rejected by clone before parsing */
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new IdentityError();
  return value;
};
const member = (value: string, values: readonly string[]) => {
  if (!values.includes(value)) throw new IdentityError();
  return value;
};
const unicode = (value: string) =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    value,
  );
const ascii = /^[\x21-\x7e]+$/u;
const hex32 = /^(?!0{64}$)[0-9a-f]{64}$/u;
const hexDigest = /^[0-9a-f]{64}$/u;

type FieldType = keyof typeof IDENTITY_PROFILE.fieldTypes;
type Field = { name: string; value: string | bigint };
type Domain = keyof typeof IDENTITY_PROFILE.domains;
const u16 = (value: number) => {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
};
const u32 = (value: number) => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
};
const u64 = (value: bigint) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(value);
  return out;
};
const encodeValue = (type: FieldType, value: string | bigint) => {
  if (type === "u64") return u64(value as bigint);
  if (type === "bytes" || type === "digest32") {
    /* v8 ignore next -- callers construct bytes/digests from prevalidated closed variants */
    if (
      typeof value !== "string" ||
      !(type === "bytes" ? hex32 : hexDigest).test(value)
    )
      throw new IdentityError();
    return Buffer.from(value, "hex");
  }
  if (
    typeof value !== "string" ||
    !unicode(value) ||
    (type === "ascii-enum" && !ascii.test(value))
  )
    throw new IdentityError();
  const bytes = Buffer.from(value, "utf8");
  /* v8 ignore next -- public strings are bounded/nonempty before tuple construction */
  if (
    bytes.length === 0 ||
    bytes.length > IDENTITY_PROFILE.stringPolicy.maximumBytes
  )
    throw new IdentityError();
  return bytes;
};
const encode = (domain: Domain, fields: readonly Field[]) => {
  const descriptor = IDENTITY_PROFILE.domains[domain];
  /* v8 ignore next -- the validated closed domain inventory makes this defensive */
  if (descriptor === undefined) throw new IdentityError();
  /* v8 ignore next -- field construction is cross-checked against the descriptor */
  if (fields.length !== descriptor.fields.length) throw new IdentityError();
  const parts: Buffer[] = [
    Buffer.from(IDENTITY_PROFILE.magic, "ascii"),
    u16(IDENTITY_PROFILE.codecVersion),
    u16(IDENTITY_PROFILE.profileVersion),
    u16(descriptor.code),
    u16(fields.length),
  ];
  for (let index = 0; index < descriptor.fields.length; index += 1) {
    const expected = descriptor.fields[index]!;
    const actual = fields[index]!;
    /* v8 ignore next -- field construction is cross-checked against the descriptor */
    if (actual.name !== expected.name) throw new IdentityError();
    const value = encodeValue(expected.type, actual.value);
    parts.push(
      u16(expected.tag),
      Buffer.from([IDENTITY_PROFILE.fieldTypes[expected.type]]),
      u32(value.length),
      value,
    );
  }
  return Buffer.concat(parts);
};
const hash = (domain: Domain, fields: readonly Field[]) => {
  const digest = createHash("sha256")
    .update(encode(domain, fields))
    .digest("hex");
  /* v8 ignore next -- Node SHA-256 hex output has a fixed 32-byte shape */
  if (!hex32.test(digest)) throw new IdentityError();
  return digest;
};
const f = (name: string, value: string | bigint): Field => ({ name, value });
const project = (digest: string, bytes: number) => {
  const value = digest.slice(0, bytes * 2);
  if (/^0+$/u.test(value)) throw new IdentityError();
  return value;
};

/** Internal verification seam; intentionally absent from the package root. */
export const validateIdentityDigestForTesting = (
  digest: unknown,
  bytes: unknown,
) => {
  try {
    if (typeof digest !== "string" || !hexDigest.test(digest))
      throw new IdentityError();
    if (bytes !== 16 && bytes !== 8) throw new IdentityError();
    return project(digest, bytes);
  } catch {
    throw new IdentityError();
  }
};

type Scope = "parent-scoped" | "session-global";
type Locator =
  | { readonly kind: "native-operation"; readonly value: string }
  | { readonly kind: "source-ordinal"; readonly value: number };
type Operation = Readonly<{
  logicalKey: string;
  parentLogicalKey?: string;
  locator: Locator;
}>;
type ParsedIdentityInput = Readonly<{
  harness: string;
  session: Record<string, Data>;
  sessionClass: string;
  scope: Scope;
  boundaryKind: string;
  boundaryId: string;
  generation: number;
  positionKind: string;
  exclusiveEndPosition: number;
  operations: readonly Operation[];
}>;

const parseOperation = (value: Data): Operation => {
  const operation = record(
    value,
    ["logicalKey", "locator"],
    ["parentLogicalKey"],
  );
  const locator = record(operation.locator!, ["kind"], ["nativeId", "ordinal"]);
  const locatorClass = member(
    string(locator.kind!),
    IDENTITY_PROFILE.enums.locatorClass,
  );
  const normalized: Locator =
    locatorClass === "native-operation"
      ? {
          kind: "native-operation",
          value: string(
            record(operation.locator!, ["kind", "nativeId"]).nativeId!,
          ),
        }
      : {
          kind: "source-ordinal",
          value: integer(
            record(operation.locator!, ["kind", "ordinal"]).ordinal!,
          ),
        };
  return {
    logicalKey: string(operation.logicalKey!),
    ...(operation.parentLogicalKey === undefined
      ? {}
      : { parentLogicalKey: string(operation.parentLogicalKey) }),
    locator: normalized,
  };
};

const parseIdentityInput = (input: unknown): ParsedIdentityInput => {
  const root = record(clone(input), [
    "harnessRegistryId",
    "session",
    "boundary",
    "operationIdScope",
    "operations",
  ]);
  const boundary = record(root.boundary!, [
    "kind",
    "id",
    "generation",
    "positionKind",
    "exclusiveEndPosition",
  ]);
  const session = record(
    root.session!,
    ["kind"],
    ["nativeIdentityKind", "nativeIdentity", "invocationNonce"],
  );
  if (!Array.isArray(root.operations) || root.operations.length === 0)
    throw new IdentityError();
  return {
    harness: member(
      string(root.harnessRegistryId!),
      IDENTITY_PROFILE.enums.harnessRegistryId,
    ),
    session,
    sessionClass: member(
      string(session.kind!),
      IDENTITY_PROFILE.enums.sessionClass,
    ),
    scope: member(
      string(root.operationIdScope!),
      IDENTITY_PROFILE.enums.operationIdScope,
    ) as Scope,
    boundaryKind: member(
      string(boundary.kind!),
      IDENTITY_PROFILE.enums.boundaryKind,
    ),
    boundaryId: string(boundary.id!),
    generation: integer(boundary.generation!),
    positionKind: member(
      string(boundary.positionKind!),
      IDENTITY_PROFILE.enums.positionKind,
    ),
    exclusiveEndPosition: integer(boundary.exclusiveEndPosition!),
    operations: root.operations.map(parseOperation),
  };
};

const deriveSession = (input: ParsedIdentityInput) => {
  if (input.sessionClass === "native-session") {
    const native = record(input.session, [
      "kind",
      "nativeIdentityKind",
      "nativeIdentity",
    ]);
    const nativeKind = string(native.nativeIdentityKind!);
    member(nativeKind, IDENTITY_PROFILE.enums.nativeIdentityKind);
    return {
      stability: "session-stable" as const,
      digest: hash("session-native", [
        f("sessionClass", input.sessionClass),
        f("harnessRegistryId", input.harness),
        f("nativeIdentityKind", nativeKind),
        f("nativeIdentity", string(native.nativeIdentity!)),
      ]),
    };
  }
  if (input.sessionClass === "boundary-scoped") {
    record(input.session, ["kind"]);
    return {
      stability: "boundary-scoped-at-least-once" as const,
      digest: hash("session-boundary", [
        f("sessionClass", input.sessionClass),
        f("harnessRegistryId", input.harness),
        f("boundaryKind", input.boundaryKind),
        f("boundaryId", input.boundaryId),
      ]),
    };
  }
  const attempt = record(input.session, ["kind", "invocationNonce"]);
  const nonce = string(attempt.invocationNonce!);
  if (!hex32.test(nonce)) throw new IdentityError();
  return {
    stability: "attempt-scoped-at-least-once" as const,
    digest: hash("session-attempt", [
      f("sessionClass", input.sessionClass),
      f("harnessRegistryId", input.harness),
      f("invocationNonce", nonce),
    ]),
  };
};

const childSpanDomain = (scope: Scope, locator: Locator): Domain =>
  scope === "parent-scoped"
    ? locator.kind === "native-operation"
      ? "child-span-parent-native"
      : "child-span-parent-ordinal"
    : locator.kind === "native-operation"
      ? "child-span-session-global-native"
      : "child-span-session-global-ordinal";

const childSpanFields = (
  traceDigest: string,
  parentDigest: string,
  scope: Scope,
  locator: Locator,
) => [
  f("traceDigest", traceDigest),
  ...(scope === "parent-scoped" ? [f("parentSpanDigest", parentDigest)] : []),
  f("locatorClass", locator.kind),
  f(
    locator.kind === "native-operation" ? "nativeOperationId" : "sourceOrdinal",
    locator.kind === "native-operation" ? locator.value : BigInt(locator.value),
  ),
];

const deriveSpans = (
  traceDigest: string,
  scope: Scope,
  operations: readonly Operation[],
) => {
  const byKey = new Map(
    operations.map((operation) => [operation.logicalKey, operation]),
  );
  const roots = operations.filter(
    ({ parentLogicalKey }) => parentLogicalKey === undefined,
  );
  if (byKey.size !== operations.length || roots.length !== 1)
    throw new IdentityError();
  const fullByKey = new Map<string, string>();
  const spanIds = new Map<string, string>();
  const active = new Set<string>();
  const derive = (key: string): string => {
    const existing = fullByKey.get(key);
    if (existing !== undefined) return existing;
    if (active.has(key)) throw new IdentityError();
    active.add(key);
    const operation = byKey.get(key);
    if (operation === undefined) throw new IdentityError();
    const digest =
      operation.parentLogicalKey === undefined
        ? hash("root-span", [f("traceDigest", traceDigest)])
        : (() => {
            const parent = derive(operation.parentLogicalKey);
            return hash(
              childSpanDomain(scope, operation.locator),
              childSpanFields(traceDigest, parent, scope, operation.locator),
            );
          })();
    active.delete(key);
    fullByKey.set(key, digest);
    const spanId = project(digest, IDENTITY_PROFILE.output.spanIdBytes);
    /* v8 ignore next -- a SHA-256 truncation collision is exercised through the production projection validator without injectable hashing. */
    if ([...spanIds.values()].includes(spanId)) throw new IdentityError();
    spanIds.set(key, spanId);
    return digest;
  };
  for (const operation of operations) derive(operation.logicalKey);
  return Object.fromEntries(
    [...spanIds].sort(([left], [right]) => (left < right ? -1 : 1)),
  ) as Record<string, W3CSpanId>;
};

const validateLocatorUniqueness = (
  scope: Scope,
  operations: readonly Operation[],
) => {
  const ordinals = new Set<number>();
  const globalNativeIds = new Set<string>();
  const parentNativeIds = new Map<string | undefined, Set<string>>();
  for (const operation of operations) {
    if (operation.locator.kind === "source-ordinal") {
      if (ordinals.has(operation.locator.value)) throw new IdentityError();
      ordinals.add(operation.locator.value);
      continue;
    }
    if (scope === "session-global") {
      if (globalNativeIds.has(operation.locator.value))
        throw new IdentityError();
      globalNativeIds.add(operation.locator.value);
      continue;
    }
    let nativeIds = parentNativeIds.get(operation.parentLogicalKey);
    if (nativeIds === undefined) {
      nativeIds = new Set<string>();
      parentNativeIds.set(operation.parentLogicalKey, nativeIds);
    }
    if (nativeIds.has(operation.locator.value)) throw new IdentityError();
    nativeIds.add(operation.locator.value);
  }
};

const deriveBundle = (input: ParsedIdentityInput): IdentityBundle => {
  validateLocatorUniqueness(input.scope, input.operations);
  const session = deriveSession(input);
  const traceDigest = hash("trace", [f("sessionDigest", session.digest)]);
  const boundaryDigest = hash("boundary", [
    f("sessionDigest", session.digest),
    f("boundaryKind", input.boundaryKind),
    f("boundaryId", input.boundaryId),
    f("generation", BigInt(input.generation)),
    f("positionKind", input.positionKind),
    f("exclusiveEndPosition", BigInt(input.exclusiveEndPosition)),
  ]);
  const bundle = deepFreeze({
    stability: session.stability,
    sessionId: session.digest as SessionIdentity,
    traceId: project(
      traceDigest,
      IDENTITY_PROFILE.output.traceIdBytes,
    ) as W3CTraceId,
    spans: deriveSpans(traceDigest, input.scope, input.operations),
    boundaryId: boundaryDigest as BoundaryIdentity,
    deliveryId: hash("delivery", [
      f("traceDigest", traceDigest),
      f("boundaryDigest", boundaryDigest),
    ]) as DeliveryIdentity,
  });
  const topology = Object.create(null) as Record<string, string | undefined>;
  for (const operation of input.operations)
    topology[operation.logicalKey] = operation.parentLogicalKey;
  identityBundleTopology.set(bundle, deepFreeze(topology));
  identityBundleRegistry.add(bundle);
  return bundle;
};

export const deriveIdentityBundle = (input: unknown): IdentityBundle => {
  try {
    return deriveBundle(parseIdentityInput(input));
  } catch {
    throw new IdentityError();
  }
};

export const identitySpanFlagsAreValid = (flags: unknown) =>
  typeof flags === "number" &&
  Number.isInteger(flags) &&
  IDENTITY_PROFILE.flags.allowedSpanFlags.includes(flags);
