import { types } from "node:util";

export const invalid = (): never => {
  throw new Error("integration.harness-material.invalid");
};

export const record = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalid();
  return value as Readonly<Record<string, unknown>>;
};

export const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): void => {
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...keys].sort())
  )
    invalid();
};

export const parseStrictJson = (bytes: Uint8Array): unknown => {
  const source = Buffer.from(bytes).toString("utf8");
  let offset = 0;
  const whitespace = (): void => {
    while (/\s/u.test(source[offset] ?? "")) offset += 1;
  };
  const string = (): string => {
    const start = offset;
    if (source[offset] !== '"') return invalid();
    offset += 1;
    while (offset < source.length) {
      if (source[offset] === "\\") offset += 2;
      else if (source[offset] === '"') {
        offset += 1;
        try {
          return JSON.parse(source.slice(start, offset)) as string;
        } catch {
          return invalid();
        }
      } else offset += 1;
    }
    return invalid();
  };
  const value = (): unknown => {
    whitespace();
    if (source[offset] === '"') return string();
    if (source[offset] === "{") {
      offset += 1;
      const result: Record<string, unknown> = {};
      const keys = new Set<string>();
      whitespace();
      if (source[offset] === "}") {
        offset += 1;
        return result;
      }
      while (offset < source.length) {
        whitespace();
        const key = string();
        if (keys.has(key) || Object.hasOwn(Object.prototype, key))
          return invalid();
        keys.add(key);
        whitespace();
        if (source[offset] !== ":") return invalid();
        offset += 1;
        Object.defineProperty(result, key, {
          value: value(),
          enumerable: true,
          configurable: true,
          writable: true,
        });
        whitespace();
        if (source[offset] === "}") {
          offset += 1;
          return result;
        }
        if (source[offset] !== ",") return invalid();
        offset += 1;
      }
      return invalid();
    }
    if (source[offset] === "[") {
      offset += 1;
      const result: unknown[] = [];
      whitespace();
      if (source[offset] === "]") {
        offset += 1;
        return result;
      }
      while (offset < source.length) {
        result.push(value());
        whitespace();
        if (source[offset] === "]") {
          offset += 1;
          return result;
        }
        if (source[offset] !== ",") return invalid();
        offset += 1;
      }
      return invalid();
    }
    for (const [literal, parsed] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const)
      if (source.startsWith(literal, offset)) {
        offset += literal.length;
        return parsed;
      }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      source.slice(offset),
    )?.[0];
    if (number === undefined) return invalid();
    offset += number.length;
    return Number(number);
  };
  const parsed = value();
  whitespace();
  if (offset !== source.length) return invalid();
  return parsed;
};

const exactArray = (value: unknown, maximum: number): readonly unknown[] => {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  return value;
};

const closedPersistedMaterial = (value: unknown, keys: readonly string[]) => {
  if (
    types.isProxy(value) ||
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    return invalid();
  const parsed = record(value);
  exactKeys(parsed, keys);
  if (
    Object.values(Object.getOwnPropertyDescriptors(parsed)).some(
      (descriptor) => !("value" in descriptor),
    )
  )
    return invalid();
  return parsed;
};
const persistedMaterialPrimitives = (
  value: unknown,
  strings: readonly string[],
  numbers: readonly string[] = [],
) => {
  const parsed = closedPersistedMaterial(value, [...strings, ...numbers]);
  if (
    strings.some(
      (key) =>
        typeof parsed[key] !== "string" ||
        parsed[key].length < 1 ||
        parsed[key].length > 1024,
    ) ||
    numbers.some(
      (key) =>
        !Number.isSafeInteger(parsed[key]) || (parsed[key] as number) < 1,
    )
  )
    return invalid();
  return parsed;
};
// Validate the existing compiler's persisted public projection, not its authority.
export const assertPersistedHarnessMaterialPrivacy = (value: unknown): void => {
  if (types.isProxy(value)) return invalid();
  const kind = Object.getOwnPropertyDescriptor(record(value), "kind")
    ?.value as unknown;
  const signed = kind === "signed-release-manifest";
  if (!signed && kind !== "npm") return invalid();
  const hasPlatformPackage = Object.hasOwn(value as object, "platformPackage");
  const parsed = closedPersistedMaterial(value, [
    "authorityVersion",
    "evidenceId",
    "kind",
    "materialIdentity",
    "platformIdentity",
    "verifier",
    ...(signed
      ? [
          "binary",
          "manifestSha256",
          "signatureSha256",
          "signatureHashAlgorithm",
          "signingKey",
          ...(hasPlatformPackage ? ["platformPackage"] : []),
        ]
      : ["packages", "verifierNpmVersion"]),
  ]);
  if (
    parsed.authorityVersion !== 1 ||
    typeof parsed.evidenceId !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(parsed.evidenceId)
  )
    return invalid();
  for (const key of ["materialIdentity", "platformIdentity"])
    if (
      typeof parsed[key] !== "string" ||
      !/^sha256-[a-f0-9]{64}$/u.test(parsed[key])
    )
      return invalid();
  const verifier = persistedMaterialPrimitives(parsed.verifier, [
    "controllerSha256",
    "image",
    "imageConfigDigest",
    "imageId",
    "imageManifestDigest",
    "name",
  ]);
  if (verifier.name !== (signed ? "gpg" : "npm")) return invalid();
  if (signed) {
    persistedMaterialPrimitives(
      parsed.binary,
      ["executableName", "fileName", "platform", "sha256", "version"],
      ["bytes"],
    );
    persistedMaterialPrimitives(parsed.signingKey, [
      "fingerprint",
      "sha256",
      "signerFingerprint",
      "uid",
    ]);
    for (const key of ["manifestSha256", "signatureSha256"])
      if (
        typeof parsed[key] !== "string" ||
        !/^[a-f0-9]{64}$/u.test(parsed[key])
      )
        return invalid();
    if (
      !["sha256", "sha384", "sha512"].includes(
        parsed.signatureHashAlgorithm as string,
      )
    )
      return invalid();
    if (hasPlatformPackage)
      persistedMaterialPrimitives(
        parsed.platformPackage,
        [
          "packageName",
          "version",
          "tarballUrl",
          "sha256",
          "integrity",
          "memberName",
          "memberSha256",
        ],
        ["bytes", "memberBytes"],
      );
  } else {
    if (
      typeof parsed.verifierNpmVersion !== "string" ||
      !/^\d+\.\d+\.\d+$/u.test(parsed.verifierNpmVersion)
    )
      return invalid();
    if (
      types.isProxy(parsed.packages) ||
      !Array.isArray(parsed.packages) ||
      Object.values(Object.getOwnPropertyDescriptors(parsed.packages)).some(
        (descriptor) => !("value" in descriptor),
      )
    )
      return invalid();
    const packages = exactArray(parsed.packages, 8);
    if (packages.length === 0) return invalid();
    for (const row of packages)
      persistedMaterialPrimitives(
        row,
        [
          "packageName",
          "installName",
          "version",
          "fileName",
          "sha256",
          "integrity",
          "shasum",
          "attestationBundleDigest",
        ],
        ["bytes"],
      );
  }
};
