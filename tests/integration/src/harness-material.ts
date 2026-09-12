import { createHash } from "node:crypto";

import { canonicalJson, deepFreeze, sha256 } from "./canonical.js";
import type { CapabilityManifest } from "./manifest.js";

type ManifestEvidence = CapabilityManifest["evidence"][number];
export type NpmHarnessMaterial = Extract<
  ManifestEvidence["material"],
  Readonly<{ kind: "npm" }>
>;
export type SignedManifestHarnessMaterial = Extract<
  ManifestEvidence["material"],
  Readonly<{ kind: "signed-release-manifest" }>
>;

export type VerifiedNpmHarnessMaterial = Readonly<{
  authorityVersion: 1;
  evidenceId: string;
  kind: "npm";
  materialIdentity: string;
  platformIdentity: string;
  packages: readonly Readonly<{
    packageName: string;
    installName: string;
    version: string;
    fileName: string;
    bytes: number;
    sha256: string;
    integrity: string;
    shasum: string;
    attestationBundleDigest: string;
  }>[];
  verifier: Readonly<{
    controllerSha256: string;
    image: string;
    imageConfigDigest: string;
    imageId: string;
    imageManifestDigest: string;
    name: "npm";
  }>;
}>;
export type VerifiedSignedManifestHarnessMaterial = Readonly<{
  authorityVersion: 1;
  evidenceId: string;
  kind: "signed-release-manifest";
  materialIdentity: string;
  platformIdentity: string;
  binary: Readonly<{
    bytes: number;
    executableName: string;
    fileName: string;
    platform: string;
    sha256: string;
    version: string;
  }>;
  manifestSha256: string;
  signatureSha256: string;
  signatureHashAlgorithm: "sha256" | "sha384" | "sha512";
  signingKey: Readonly<{
    fingerprint: string;
    sha256: string;
    signerFingerprint: string;
    uid: string;
  }>;
  verifier: Readonly<{
    controllerSha256: string;
    image: string;
    imageConfigDigest: string;
    imageId: string;
    imageManifestDigest: string;
    name: "gpg";
  }>;
}>;
export type VerifiedHarnessMaterial =
  VerifiedNpmHarnessMaterial | VerifiedSignedManifestHarnessMaterial;

const invalid = (): never => {
  throw new Error("integration.harness-material.invalid");
};

const record = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalid();
  return value as Readonly<Record<string, unknown>>;
};

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): void => {
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...keys].sort())
  )
    invalid();
};

const exactArray = (value: unknown, maximum: number): readonly unknown[] => {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  return value;
};

const packagePurl = (packageName: string, version: string): string => {
  const [scope, name] = packageName.split("/");
  if (scope === undefined || name === undefined) return invalid();
  return `pkg:npm/${encodeURIComponent(scope)}/${name}@${version}`;
};

const attestationUrl = (packageName: string, version: string): string =>
  `https://registry.npmjs.org/-/npm/v1/attestations/${packageName.replace("/", "%2f")}@${version}`;

const sha256Bytes = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const sha1Bytes = (value: Uint8Array): string =>
  createHash("sha1").update(value).digest("hex");
const sha512Integrity = (value: Uint8Array): string =>
  `sha512-${createHash("sha512").update(value).digest("base64")}`;

const parseStrictJson = (bytes: Uint8Array): unknown => {
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
        if (keys.has(key)) return invalid();
        keys.add(key);
        whitespace();
        if (source[offset] !== ":") return invalid();
        offset += 1;
        result[key] = value();
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

export const compileNpmAttestationAudit = (
  material: NpmHarnessMaterial,
  responses: ReadonlyMap<string, Uint8Array>,
): unknown => ({
  invalid: [],
  missing: [],
  verified: material.packages.map((descriptor) => {
    const bytes = responses.get(
      `${descriptor.packageName}@${descriptor.version}`,
    );
    if (bytes === undefined) return invalid();
    const response = record(parseStrictJson(bytes));
    exactKeys(response, ["attestations"]);
    const bundles = exactArray(response.attestations, 4);
    if (bundles.length !== 2) return invalid();
    return {
      name: descriptor.packageName,
      version: descriptor.version,
      location: `node_modules/${descriptor.installName}`,
      registry: material.registry,
      attestations: {
        url: descriptor.attestations.url,
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
      attestationBundles: bundles,
    };
  }),
});

const verifyProvenance = (
  verified: Readonly<Record<string, unknown>>,
  material: NpmHarnessMaterial,
  packageName: string,
  version: string,
): string => {
  exactKeys(verified, [
    "name",
    "version",
    "location",
    "registry",
    "attestations",
    "attestationBundles",
  ]);
  if (
    verified.name !== packageName ||
    verified.version !== version ||
    verified.registry !== material.registry ||
    verified.location !==
      `node_modules/${
        material.packages.find(
          (entry) =>
            entry.packageName === packageName && entry.version === version,
        )?.installName ?? "__invalid__"
      }`
  )
    return invalid();
  const attestations = record(verified.attestations);
  exactKeys(attestations, ["url", "provenance"]);
  const provenanceSummary = record(attestations.provenance);
  exactKeys(provenanceSummary, ["predicateType"]);
  if (
    attestations.url !== attestationUrl(packageName, version) ||
    provenanceSummary.predicateType !== "https://slsa.dev/provenance/v1"
  )
    return invalid();
  const bundles = exactArray(verified.attestationBundles, 4);
  if (bundles.length !== 2) return invalid();
  const provenance = bundles
    .map(record)
    .find((entry) => entry.predicateType === "https://slsa.dev/provenance/v1");
  if (provenance === undefined) return invalid();
  exactKeys(provenance, [
    "predicateType",
    "bundle",
    "signedAccessSignatureUrl",
  ]);
  if (provenance.signedAccessSignatureUrl !== "") return invalid();
  const bundle = record(provenance.bundle);
  const envelope = record(bundle.dsseEnvelope);
  if (
    envelope.payloadType !== "application/vnd.in-toto+json" ||
    typeof envelope.payload !== "string" ||
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length !== 1
  )
    return invalid();
  let statement: Readonly<Record<string, unknown>>;
  try {
    statement = record(
      JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")),
    );
  } catch {
    return invalid();
  }
  exactKeys(statement, ["_type", "subject", "predicateType", "predicate"]);
  const subjects = exactArray(statement.subject, 2);
  const subject = subjects.length === 1 ? record(subjects[0]) : invalid();
  const descriptor = material.packages.find(
    (entry) => entry.packageName === packageName && entry.version === version,
  );
  if (descriptor === undefined) return invalid();
  const expectedSha512 = Buffer.from(
    descriptor.integrity.slice("sha512-".length),
    "base64",
  ).toString("hex");
  if (
    statement._type !== "https://in-toto.io/Statement/v1" ||
    statement.predicateType !== "https://slsa.dev/provenance/v1" ||
    subject.name !== packagePurl(packageName, version)
  )
    return invalid();
  const subjectDigest = record(subject.digest);
  exactKeys(subjectDigest, ["sha512"]);
  if (subjectDigest.sha512 !== expectedSha512) return invalid();
  const predicate = record(statement.predicate);
  const buildDefinition = record(predicate.buildDefinition);
  const parameters = record(buildDefinition.externalParameters);
  const workflow = record(parameters.workflow);
  const dependencies = exactArray(buildDefinition.resolvedDependencies, 8);
  if (
    workflow.repository !== material.provenance.repository ||
    workflow.ref !== `refs/tags/${material.provenance.tag}` ||
    workflow.path !== material.provenance.workflowPath ||
    !dependencies.some((candidate) => {
      const dependency = record(candidate);
      const digest = record(dependency.digest);
      return digest.gitCommit === material.provenance.sourceCommit;
    })
  )
    return invalid();
  return sha256(canonicalJson(bundles));
};

export const compileVerifiedNpmHarnessMaterial = (
  input: Readonly<{
    audit: unknown;
    evidenceId: string;
    material: NpmHarnessMaterial;
    tarballs: ReadonlyMap<string, Uint8Array>;
    verifier: Readonly<{
      controllerSha256: string;
      image: string;
      imageConfigDigest: string;
      imageId: string;
      imageManifestDigest: string;
      name: "npm";
    }>;
  }>,
): VerifiedNpmHarnessMaterial => {
  if (
    !/^[a-z][a-z0-9-]{0,63}$/u.test(input.evidenceId) ||
    !/^[a-f0-9]{64}$/u.test(input.verifier.controllerSha256) ||
    !/^[^\s@]{1,448}@sha256:[a-f0-9]{64}$/u.test(input.verifier.image) ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.verifier.imageConfigDigest) ||
    !/^sha256-[a-f0-9]{64}$/u.test(input.verifier.imageId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.verifier.imageManifestDigest) ||
    input.verifier.image !== input.material.verifierImage
  )
    return invalid();
  const audit = record(input.audit);
  exactKeys(audit, ["invalid", "missing", "verified"]);
  if (
    exactArray(audit.invalid, 32).length !== 0 ||
    exactArray(audit.missing, 32).length !== 0
  )
    return invalid();
  const verified = exactArray(audit.verified, 16).map(record);
  const packageKeys = input.material.packages.map(
    ({ packageName, version }) => `${packageName}@${version}`,
  );
  if (
    input.material.kind !== "npm" ||
    input.material.packages.length < 1 ||
    input.material.packages.length > 8 ||
    new Set(packageKeys).size !== packageKeys.length ||
    input.tarballs.size !== input.material.packages.length ||
    verified.length !== input.material.packages.length
  )
    return invalid();
  const packages = input.material.packages
    .map((descriptor) => {
      const key = `${descriptor.packageName}@${descriptor.version}`;
      const bytes = input.tarballs.get(key);
      const auditEntry = verified.find(
        (candidate) =>
          candidate.name === descriptor.packageName &&
          candidate.version === descriptor.version,
      );
      if (
        bytes === undefined ||
        bytes.byteLength !== descriptor.bytes ||
        sha512Integrity(bytes) !== descriptor.integrity ||
        sha1Bytes(bytes) !== descriptor.shasum ||
        auditEntry === undefined
      )
        return invalid();
      const archiveSha256 = sha256Bytes(bytes);
      return Object.freeze({
        packageName: descriptor.packageName,
        installName: descriptor.installName,
        version: descriptor.version,
        fileName: `${archiveSha256}.tgz`,
        bytes: bytes.byteLength,
        sha256: archiveSha256,
        integrity: descriptor.integrity,
        shasum: descriptor.shasum,
        attestationBundleDigest: verifyProvenance(
          auditEntry,
          input.material,
          descriptor.packageName,
          descriptor.version,
        ),
      });
    })
    .sort((left, right) =>
      `${left.packageName}@${left.version}:${left.installName}`.localeCompare(
        `${right.packageName}@${right.version}:${right.installName}`,
      ),
    );
  const material = {
    authorityVersion: 1 as const,
    evidenceId: input.evidenceId,
    kind: "npm" as const,
    packages,
    platformIdentity: input.material.platformIdentity,
    verifier: input.verifier,
  };
  return deepFreeze({
    ...material,
    materialIdentity: sha256(canonicalJson(material)),
  });
};

export const compileVerifiedSignedManifestHarnessMaterial = (
  input: Readonly<{
    binary: Uint8Array;
    evidenceId: string;
    manifestBytes: Uint8Array;
    material: SignedManifestHarnessMaterial;
    signatureBytes: Uint8Array;
    signingKeyBytes: Uint8Array;
    verification: Readonly<{
      primaryFingerprint: string;
      manifestSha256: string;
      signatureHashAlgorithm: "sha256" | "sha384" | "sha512";
      signerFingerprint: string;
      uid: string;
      verifier: Readonly<{
        controllerSha256: string;
        image: string;
        imageConfigDigest: string;
        imageId: string;
        imageManifestDigest: string;
        name: "gpg";
      }>;
    }>;
  }>,
): VerifiedSignedManifestHarnessMaterial => {
  if (
    input.material.kind !== "signed-release-manifest" ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(input.evidenceId) ||
    input.binary.byteLength !== input.material.binary.bytes ||
    input.manifestBytes.byteLength !== input.material.manifest.bytes ||
    input.signatureBytes.byteLength !== input.material.signature.bytes ||
    input.signingKeyBytes.byteLength !== input.material.signingKey.bytes ||
    sha256Bytes(input.binary) !== input.material.binary.sha256 ||
    sha256Bytes(input.manifestBytes) !== input.material.manifest.sha256 ||
    sha256Bytes(input.signatureBytes) !== input.material.signature.sha256 ||
    sha256Bytes(input.signingKeyBytes) !== input.material.signingKey.sha256 ||
    input.verification.primaryFingerprint !==
      input.material.signingKey.fingerprint ||
    !/^[A-F\d]{40}$/u.test(input.verification.signerFingerprint) ||
    input.verification.uid !== input.material.signingKey.uid ||
    input.verification.manifestSha256 !== input.material.manifest.sha256 ||
    !["sha256", "sha384", "sha512"].includes(
      input.verification.signatureHashAlgorithm,
    ) ||
    !/^[a-f0-9]{64}$/u.test(input.verification.verifier.controllerSha256) ||
    !/^[^\s@]{1,448}@sha256:[a-f0-9]{64}$/u.test(
      input.verification.verifier.image,
    ) ||
    !/^sha256:[a-f0-9]{64}$/u.test(
      input.verification.verifier.imageConfigDigest,
    ) ||
    !/^sha256-[a-f0-9]{64}$/u.test(input.verification.verifier.imageId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(
      input.verification.verifier.imageManifestDigest,
    ) ||
    input.verification.verifier.image !== input.material.verifierImage ||
    input.verification.verifier.name !== "gpg"
  )
    return invalid();
  let manifest: Readonly<Record<string, unknown>>;
  try {
    manifest = record(parseStrictJson(input.manifestBytes));
  } catch {
    return invalid();
  }
  const platforms = record(manifest.platforms);
  const selected = record(platforms[input.material.platform]);
  if (selected.checksum !== input.material.binary.sha256) return invalid();
  const binary = {
    bytes: input.binary.byteLength,
    executableName: input.material.binary.executableName,
    fileName: `${input.material.binary.sha256}.bin`,
    platform: input.material.platform,
    sha256: input.material.binary.sha256,
    version: input.material.version,
  };
  const material = {
    authorityVersion: 1 as const,
    evidenceId: input.evidenceId,
    kind: "signed-release-manifest" as const,
    binary,
    platformIdentity: input.material.platformIdentity,
    manifestSha256: input.material.manifest.sha256,
    signatureSha256: input.material.signature.sha256,
    signatureHashAlgorithm: input.verification.signatureHashAlgorithm,
    signingKey: {
      fingerprint: input.verification.primaryFingerprint,
      sha256: input.material.signingKey.sha256,
      signerFingerprint: input.verification.signerFingerprint,
      uid: input.verification.uid,
    },
    verifier: input.verification.verifier,
  };
  return deepFreeze({
    ...material,
    materialIdentity: sha256(canonicalJson(material)),
  });
};
