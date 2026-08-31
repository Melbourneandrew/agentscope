import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import npa from "npm-package-arg";

import { publishManifestFields } from "../../apps/cli/scripts/publish-manifest-contract.mjs";

import {
  assert,
  assertExactKeys,
  canonicalJson,
  SHA256_PATTERN,
  sha256,
  SOURCE_REVISION_PATTERN,
} from "./validation.mjs";

const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
const ZERO_BLOCK = Buffer.alloc(512);
const privatePackage = /^@agentscope\//u;
const dependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
];

function assertRegistryDependency(name, specification, label) {
  let parsed;
  try {
    parsed = npa.resolve(name, String(specification));
  } catch {
    throw new Error(`${label} contains invalid dependency specification`);
  }
  assert(
    parsed.registry === true &&
      ["alias", "range", "tag", "version"].includes(parsed.type),
    `${label} contains non-registry dependency specification`,
  );
  if (parsed.type === "alias") {
    assert(
      parsed.subSpec?.registry === true &&
        !privatePackage.test(parsed.subSpec.name ?? ""),
      `${label} contains private or non-registry alias specification`,
    );
  }
}

export function resolveContainedArtifactPath(artifactRoot, input, label) {
  assert(
    typeof input === "string" &&
      input.length > 0 &&
      !isAbsolute(input) &&
      !input.includes("\\") &&
      !input
        .split(/[\\/]/u)
        .some((part) => part === "" || part === "." || part === ".."),
    `${label} must be a canonical contained relative artifact path`,
  );
  const root = realpathSync(artifactRoot);
  const candidate = resolve(root, input);
  const observed = realpathSync(candidate);
  const fromRoot = relative(root, observed);
  assert(
    fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot),
    `${label} escapes the artifact root`,
  );
  assert(lstatSync(candidate).isFile(), `${label} must be a regular file`);
  return observed;
}

function parseOctal(header, start, length, label) {
  const value = header
    .subarray(start, start + length)
    .toString("ascii")
    .replace(/\0.*$/u, "")
    .trim();
  assert(/^[0-7]+$/u.test(value), `Invalid tar ${label}`);
  const parsed = Number.parseInt(value, 8);
  assert(Number.isSafeInteger(parsed), `Oversized tar ${label}`);
  return parsed;
}

function parseString(header, start, length, label) {
  const bytes = header.subarray(start, start + length);
  const nul = bytes.indexOf(0);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      nul < 0 ? bytes : bytes.subarray(0, nul),
    );
  } catch {
    throw new Error(`Invalid UTF-8 in tar ${label}`);
  }
}

function verifyChecksum(header) {
  const expected = parseOctal(header, 148, 8, "checksum");
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((sum, byte) => sum + byte, 0);
  assert(actual === expected, "Tar header checksum mismatch");
}

function assertCanonicalTarPath(path) {
  assert(
    path.length > 0 &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path
        .split("/")
        .some((part) => part === "" || part === "." || part === ".."),
    `Unsafe or noncanonical tar path: ${path}`,
  );
}

function assertNoPrivateMetadata(manifest, label) {
  for (const field of dependencyFields) {
    const value = Object.entries(manifest)
      .find(([name]) => name === field)
      ?.at(1);
    if (value === undefined) continue;
    assert(
      value !== null && typeof value === "object" && !Array.isArray(value),
      `${label} ${field} must be an object`,
    );
    for (const [name, specification] of Object.entries(value)) {
      const text = String(specification);
      let decoded;
      try {
        decoded = decodeURIComponent(text);
      } catch {
        throw new Error(`${label} contains malformed dependency specification`);
      }
      assert(
        !privatePackage.test(name),
        `${label} contains private dependency ${name}`,
      );
      assert(
        !decoded.includes("@agentscope/"),
        `${label} contains private package specification`,
      );
      assertRegistryDependency(name, text, label);
    }
  }
  for (const field of ["bundledDependencies", "bundleDependencies"]) {
    const value = Object.entries(manifest)
      .find(([name]) => name === field)
      ?.at(1);
    if (value === undefined) continue;
    assert(Array.isArray(value), `${label} ${field} must be an array`);
    for (const name of value)
      assert(
        typeof name === "string" && !privatePackage.test(name),
        `${label} contains bundled private dependency`,
      );
  }
}

function readTarInventory(tarball) {
  const unpacked = gunzipSync(tarball, {
    maxOutputLength: MAX_UNPACKED_BYTES,
  });
  assert(unpacked.length % 512 === 0, "Tarball is not block aligned");
  let offset = 0;
  let zeroBlocks = 0;
  let packedManifest;
  let manifestCount = 0;
  const paths = new Set();
  const portablePaths = new Set();
  const inventory = [];
  while (offset + 512 <= unpacked.length) {
    const header = unpacked.subarray(offset, offset + 512);
    offset += 512;
    if (header.equals(ZERO_BLOCK)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) break;
      continue;
    }
    assert(zeroBlocks === 0, "Tar entry appears after an end marker");
    verifyChecksum(header);
    const prefix = parseString(header, 345, 155, "prefix");
    const name = parseString(header, 0, 100, "name");
    const path = prefix.length > 0 ? `${prefix}/${name}` : name;
    assertCanonicalTarPath(path);
    assert(
      path.startsWith("package/"),
      `Candidate tarball entry is outside package/: ${path}`,
    );
    assert(!paths.has(path), `Duplicate tar path: ${path}`);
    paths.add(path);
    assert(
      /^[\x20-\x7e]+$/u.test(path) &&
        path
          .split("/")
          .every(
            (segment) =>
              segment.length > 0 &&
              !/[. ]$/u.test(segment) &&
              !/[<>:"|?*]/u.test(segment) &&
              !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
          ),
      `Candidate tarball path is not portable: ${path}`,
    );
    const portablePath = path.toLowerCase();
    assert(
      !portablePaths.has(portablePath),
      `Platform-ambiguous tar path: ${path}`,
    );
    portablePaths.add(portablePath);
    const size = parseOctal(header, 124, 12, "size");
    const type = header[156];
    assert(type === 0 || type === 0x30, `Forbidden tar entry: ${path}`);
    assert(offset + size <= unpacked.length, `Truncated tar entry: ${path}`);
    const content = unpacked.subarray(offset, offset + size);
    assert(
      !path.split("/").includes("node_modules") &&
        !path.includes("@agentscope"),
      `Private package payload path is forbidden: ${path}`,
    );
    inventory.push({ bytes: size, path, sha256: sha256(content) });
    if (basename(path) === "package.json") {
      const nested = JSON.parse(content.toString("utf8"));
      assertNoPrivateMetadata(nested, `packed manifest ${path}`);
      assert(
        path === "package/package.json" ||
          !privatePackage.test(nested.name ?? ""),
        `Nested private package manifest is forbidden: ${path}`,
      );
      if (path === "package/package.json") {
        manifestCount += 1;
        packedManifest = nested;
      }
    }
    offset += Math.ceil(size / 512) * 512;
  }
  assert(zeroBlocks === 2, "Tarball lacks two end-of-archive blocks");
  assert(
    unpacked.subarray(offset).every((byte) => byte === 0),
    "Tarball contains nonzero trailing bytes",
  );
  assert(
    manifestCount === 1 && packedManifest,
    "Tarball must contain one package/package.json",
  );
  return {
    inventory,
    inventoryDigest: sha256(canonicalJson(inventory)),
    packedManifest,
  };
}

export function inspectCandidateTarball(tarballPath) {
  const stat = statSync(tarballPath);
  assert(
    stat.isFile() && stat.size > 0 && stat.size <= MAX_TARBALL_BYTES,
    "Candidate tarball size is invalid",
  );
  const tarball = readFileSync(tarballPath);
  const inspected = readTarInventory(tarball);
  return Object.freeze({
    bytes: stat.size,
    integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    inventory: inspected.inventory,
    inventoryDigest: inspected.inventoryDigest,
    packedManifest: inspected.packedManifest,
    sha256: `sha256:${createHash("sha256").update(tarball).digest("hex")}`,
  });
}

export function validateCandidateManifest(manifest) {
  assertExactKeys(
    manifest,
    [
      "schemaVersion",
      "candidateId",
      "package",
      "channel",
      "sourceRevision",
      "protectedTag",
      "tarball",
      "certification",
    ],
    "candidate manifest",
  );
  assert(manifest.schemaVersion === 1, "Unsupported candidate schemaVersion");
  assert(
    manifest.candidateId === "agentscope.release-candidate.v1",
    "Candidate identity drifted",
  );
  assertExactKeys(
    manifest.package,
    ["name", "version", "bin"],
    "candidate package",
  );
  assert(
    manifest.package.name === "agentscope-cli" &&
      manifest.package.version === "0.1.0",
    "Candidate package/version drifted",
  );
  assertExactKeys(manifest.package.bin, ["agentscope"], "candidate bin");
  assert(
    manifest.package.bin.agentscope === "./dist/bin/agentscope.js",
    "Candidate executable drifted",
  );
  assertExactKeys(
    manifest.channel,
    ["npmDistTag", "githubPrerelease"],
    "candidate channel",
  );
  assert(
    manifest.channel.npmDistTag === "alpha" &&
      manifest.channel.githubPrerelease === true,
    "Candidate alpha channel drifted",
  );
  assert(
    SOURCE_REVISION_PATTERN.test(manifest.sourceRevision),
    "Invalid candidate source revision",
  );
  assert(manifest.protectedTag === "v0.1.0", "Protected tag/version mismatch");
  assertExactKeys(
    manifest.tarball,
    ["fileName", "bytes", "sha256", "integrity", "inventoryDigest"],
    "candidate tarball",
  );
  assert(
    manifest.tarball.fileName === "agentscope-cli-0.1.0.tgz" &&
      Number.isSafeInteger(manifest.tarball.bytes) &&
      manifest.tarball.bytes > 0 &&
      manifest.tarball.bytes <= MAX_TARBALL_BYTES &&
      SHA256_PATTERN.test(manifest.tarball.sha256) &&
      /^sha512-[A-Za-z0-9+/]{86}==$/u.test(manifest.tarball.integrity) &&
      SHA256_PATTERN.test(manifest.tarball.inventoryDigest),
    "Candidate tarball identity drifted",
  );
  assertExactKeys(
    manifest.certification,
    ["state", "recordDigest"],
    "candidate certification",
  );
  assert(
    manifest.certification.state === "certified" &&
      SHA256_PATTERN.test(manifest.certification.recordDigest),
    "Candidate is not explicitly certified",
  );
  return manifest;
}

export function validateCertificationRecord(record, manifest) {
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "recordId",
      "state",
      "package",
      "sourceRevision",
      "protectedTag",
      "tarballSha256",
      "inventoryDigest",
      "supportAdmissionDigest",
      "evidenceIndexDigest",
    ],
    "candidate certification record",
  );
  assertExactKeys(record.package, ["name", "version"], "certified package");
  assert(
    record.schemaVersion === 1 &&
      record.recordId === "agentscope.candidate-certification.v1" &&
      record.state === "certified" &&
      record.package.name === manifest.package.name &&
      record.package.version === manifest.package.version &&
      record.sourceRevision === manifest.sourceRevision &&
      record.protectedTag === manifest.protectedTag &&
      record.tarballSha256 === manifest.tarball.sha256 &&
      record.inventoryDigest === manifest.tarball.inventoryDigest &&
      SHA256_PATTERN.test(record.supportAdmissionDigest) &&
      SHA256_PATTERN.test(record.evidenceIndexDigest),
    "Certification record does not bind the candidate",
  );
  assert(
    sha256(canonicalJson(record)) === manifest.certification.recordDigest,
    "Certification record digest mismatch",
  );
}

export function verifyCandidateArtifact({
  manifest,
  certificationRecord,
  tarballPath,
  expectedManifestDigest,
  expectedSourceRevision,
  expectedProtectedTag,
}) {
  validateCandidateManifest(manifest);
  assert(
    sha256(canonicalJson(manifest)) === expectedManifestDigest,
    "Candidate manifest digest mismatch",
  );
  validateCertificationRecord(certificationRecord, manifest);
  assert(
    manifest.sourceRevision === expectedSourceRevision,
    "Candidate/source revision mismatch",
  );
  assert(
    manifest.protectedTag === expectedProtectedTag,
    "Candidate/protected tag mismatch",
  );
  assert(
    basename(tarballPath) === manifest.tarball.fileName,
    "Candidate filename mismatch",
  );
  const inspected = inspectCandidateTarball(tarballPath);
  assert(
    inspected.bytes === manifest.tarball.bytes,
    "Candidate byte-size mismatch",
  );
  assert(
    inspected.sha256 === manifest.tarball.sha256,
    "Candidate SHA-256 mismatch",
  );
  assert(
    inspected.integrity === manifest.tarball.integrity,
    "Candidate SRI mismatch",
  );
  assert(
    inspected.inventoryDigest === manifest.tarball.inventoryDigest,
    "Candidate inventory digest mismatch",
  );
  const { packedManifest } = inspected;
  for (const field of Object.keys(packedManifest))
    assert(
      publishManifestFields.includes(field),
      `Packed manifest contains non-publish authority: ${field}`,
    );
  assert(
    packedManifest.name === manifest.package.name &&
      packedManifest.version === manifest.package.version &&
      JSON.stringify(packedManifest.bin) ===
        JSON.stringify(manifest.package.bin),
    "Packed manifest identity mismatch",
  );
  const executablePath = `package/${manifest.package.bin.agentscope.replace(/^\.\//u, "")}`;
  assert(
    inspected.inventory.some(({ path }) => path === executablePath),
    "Candidate executable is missing from the exact tarball inventory",
  );
  assertExactKeys(
    packedManifest.publishConfig,
    ["access"],
    "packed publishConfig",
  );
  assert(
    packedManifest.publishConfig?.access === "public" &&
      !Object.hasOwn(packedManifest.publishConfig, "tag"),
    "Product tarball publishConfig drifted",
  );
  return Object.freeze({
    bytes: inspected.bytes,
    inventoryEntries: inspected.inventory.length,
    inventoryDigest: inspected.inventoryDigest,
    manifestDigest: expectedManifestDigest,
    package: packedManifest.name,
    protectedTag: manifest.protectedTag,
    sha256: inspected.sha256,
    sourceRevision: manifest.sourceRevision,
    version: packedManifest.version,
  });
}
