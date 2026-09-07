import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const maximumArtifactBytes = 2 * 1024 * 1024;
const expectedArtifact = Object.freeze({
  bytes: 616_536,
  needed: Object.freeze(["libc.musl-x86_64.so.1"]),
  path: "pty-runtime/node127-linux-x64-musl/pty.node",
  sha256: "a82a5b257b14645b5705211d124300eadb7cb87120e6c7248fe4b6774782d8a3",
  tuple: "node127-linux-x64-musl",
});

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const readBoundedRegular = (
  path,
  maximumBytes = maximumArtifactBytes,
  expectedMode = 0o644,
) => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.size > maximumBytes ||
      (before.mode & 0o777) !== expectedMode
    )
      throw new Error(`PTY runtime input is not bounded regular data: ${path}`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size
    )
      throw new Error(`PTY runtime input changed while reading: ${path}`);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
};

const exactKeys = (value, keys) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const virtualAddressToOffset = (address, loads) => {
  for (const segment of loads) {
    if (address >= segment.address && address < segment.address + segment.bytes)
      return segment.offset + (address - segment.address);
  }
  throw new Error("PTY runtime ELF string table is outside a load segment.");
};

// The closed ELF grammar is intentionally kept in one parser so every bound
// and rejected loader directive is evaluated against the same byte snapshot.
// eslint-disable-next-line complexity
const inspectElf = (bytes) => {
  if (
    bytes.length < 64 ||
    bytes[0] !== 0x7f ||
    bytes.subarray(1, 4).toString("ascii") !== "ELF" ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(16) !== 3 ||
    bytes.readUInt16LE(18) !== 62 ||
    bytes.readUInt32LE(20) !== 1
  )
    throw new Error("PTY runtime is not the selected ELF64 x86-64 object.");
  const programOffset = Number(bytes.readBigUInt64LE(32));
  const programEntryBytes = bytes.readUInt16LE(54);
  const programEntries = bytes.readUInt16LE(56);
  if (
    programEntryBytes !== 56 ||
    programEntries < 1 ||
    programEntries > 128 ||
    programOffset + programEntryBytes * programEntries > bytes.length
  )
    throw new Error("PTY runtime ELF program headers are not bounded.");
  const loads = [];
  let dynamic;
  for (let index = 0; index < programEntries; index += 1) {
    const at = programOffset + index * programEntryBytes;
    const type = bytes.readUInt32LE(at);
    const segment = {
      address: Number(bytes.readBigUInt64LE(at + 16)),
      bytes: Number(bytes.readBigUInt64LE(at + 32)),
      offset: Number(bytes.readBigUInt64LE(at + 8)),
    };
    if (type === 1) loads.push(segment);
    if (type === 2) dynamic = segment;
  }
  if (
    dynamic === undefined ||
    dynamic.bytes > 64 * 1024 ||
    dynamic.offset + dynamic.bytes > bytes.length ||
    dynamic.bytes % 16 !== 0
  )
    throw new Error("PTY runtime ELF dynamic section is not bounded.");
  const neededOffsets = [];
  let stringAddress;
  let stringBytes;
  for (let at = dynamic.offset; at < dynamic.offset + dynamic.bytes; at += 16) {
    const tag = Number(bytes.readBigInt64LE(at));
    const value = Number(bytes.readBigUInt64LE(at + 8));
    if (tag === 0) break;
    if (tag === 1) neededOffsets.push(value);
    if (tag === 5) stringAddress = value;
    if (tag === 10) stringBytes = value;
    if (tag === 15 || tag === 22 || tag === 29)
      throw new Error("PTY runtime ELF contains a forbidden loader directive.");
  }
  if (
    stringAddress === undefined ||
    stringBytes === undefined ||
    stringBytes < 1 ||
    stringBytes > 128 * 1024
  )
    throw new Error("PTY runtime ELF string table is not bounded.");
  const stringOffset = virtualAddressToOffset(stringAddress, loads);
  if (stringOffset + stringBytes > bytes.length)
    throw new Error("PTY runtime ELF string table exceeds the file.");
  return neededOffsets.map((offset) => {
    if (offset < 0 || offset >= stringBytes)
      throw new Error("PTY runtime ELF dependency offset is invalid.");
    const start = stringOffset + offset;
    const end = bytes.indexOf(0, start);
    if (end < start || end >= stringOffset + stringBytes)
      throw new Error("PTY runtime ELF dependency is unterminated.");
    return bytes.subarray(start, end).toString("utf8");
  });
};

const verifyClosedSourceDirectory = (root, expected) => {
  const before = lstatSync(root);
  if (before.isSymbolicLink() || !before.isDirectory())
    throw new Error(`PTY source root is not a directory: ${root}`);
  const entries = readdirSync(root, { withFileTypes: true });
  const actual = entries.map((entry) => entry.name).sort();
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== [...expected].sort()[index])
  )
    throw new Error(`PTY source inventory is not exact: ${root}`);
};

const verifyFileIdentity = (path, bytes, digest, mode = 0o644) => {
  const contents = readBoundedRegular(path, maximumArtifactBytes, mode);
  if (contents.length !== bytes || sha256(contents) !== digest)
    throw new Error(`PTY source identity does not match authority: ${path}`);
};

const verifySourceAuthority = (sourceRoot) => {
  const nodePtyRoot = resolve(sourceRoot, "third_party/node-pty");
  const addonApiRoot = resolve(sourceRoot, "third_party/node-addon-api");
  verifyClosedSourceDirectory(nodePtyRoot, [
    "LICENSE",
    "patches",
    "source-manifest.json",
    "src",
  ]);
  verifyClosedSourceDirectory(resolve(nodePtyRoot, "patches"), [
    "agentscope-terminal-authority.patch",
  ]);
  verifyClosedSourceDirectory(resolve(nodePtyRoot, "src"), ["unix"]);
  verifyClosedSourceDirectory(resolve(nodePtyRoot, "src/unix"), ["pty.cc"]);
  verifyClosedSourceDirectory(addonApiRoot, [
    "napi-inl.h",
    "napi.h",
    "source-manifest.json",
  ]);
  verifyFileIdentity(
    resolve(nodePtyRoot, "LICENSE"),
    3_326,
    "a3d60eaf32d2fb09c9d82ef39f14bd6e2c0f3ca7de30daa827486c0d6f8b6e9f",
  );
  verifyFileIdentity(
    resolve(nodePtyRoot, "src/unix/pty.cc"),
    23_090,
    "5809f87b15122f335017b0b3020071df4c6205c7827186a2c5a9e0edc9ef59b2",
  );
  verifyFileIdentity(
    resolve(nodePtyRoot, "patches/agentscope-terminal-authority.patch"),
    9_471,
    "1b87f2a95bf44e2dce53a4a6530bca38a78d45353c9f3dfcec29d9f716ce63d4",
  );
  verifyFileIdentity(
    resolve(nodePtyRoot, "source-manifest.json"),
    1_683,
    "c6c191296da1415cdafb8044a56c32afe5cf4c3d75c359db074cade04ad6bb48",
  );
  verifyFileIdentity(
    resolve(addonApiRoot, "napi.h"),
    115_423,
    "2f2f5d1e4ca96f315c51ad96c292c18294dbb999b98f8b2f33b80816a3189fb0",
  );
  verifyFileIdentity(
    resolve(addonApiRoot, "napi-inl.h"),
    219_411,
    "4b053c184dfed740fbd802fdcf97e85fb8c7b0eb1d83322000d932d31662eda7",
  );
  verifyFileIdentity(
    resolve(addonApiRoot, "source-manifest.json"),
    2_225,
    "aff0d41e4e5c77313d51cf6cfd070d43798520b4a8b7734b4acc600ded9e9b6e",
  );
  const nodePtyManifest = JSON.parse(
    readBoundedRegular(resolve(nodePtyRoot, "source-manifest.json"), 64 * 1024),
  );
  const addonApiManifest = JSON.parse(
    readBoundedRegular(
      resolve(addonApiRoot, "source-manifest.json"),
      64 * 1024,
    ),
  );
  if (
    nodePtyManifest.upstream?.commit !==
      "8f218f6c194be81d98b1eeea344b150e83445824" ||
    nodePtyManifest.upstream?.npmTarballSha256 !==
      "114ac80c3fe075eff76217a4122d135576582695f49c03a5da3835cdfc2f89c5" ||
    nodePtyManifest.agentscopePatch?.path !==
      "patches/agentscope-terminal-authority.patch" ||
    nodePtyManifest.agentscopePatch?.sha256 !==
      "1b87f2a95bf44e2dce53a4a6530bca38a78d45353c9f3dfcec29d9f716ce63d4" ||
    nodePtyManifest.agentscopePatch?.patchedSourceSha256 !==
      "b57b7a2171826869f4d6a299ccad32bd639ed89c4dcda5cd7c6e9a35dd4f9e84" ||
    addonApiManifest.upstream?.version !== "7.1.1" ||
    addonApiManifest.upstream?.tarballSha256 !==
      "b10455d15a977c0cd17a1cb0eb679e03d939f8ef8d4302eb33e1f78dacc71f82" ||
    addonApiManifest.license?.path !== "LICENSE.md" ||
    Buffer.byteLength(addonApiManifest.license?.text ?? "") !== 1_150 ||
    sha256(addonApiManifest.license?.text ?? "") !==
      "89024017b88a9f2b763f79b941a4f2db3b4428edfcacdc0b23866b2da633ad0c"
  )
    throw new Error("PTY source provenance is not exact.");
};

const verifyPolicy = (root) => {
  verifyFileIdentity(
    resolve(root, "pty-runtime-policy.json"),
    8_832,
    "abcb791a22e4e0d21aefa00ab5209532049ffad5b85b6e30d9204311d24cc09d",
  );
  const policy = JSON.parse(
    readBoundedRegular(resolve(root, "pty-runtime-policy.json"), 256 * 1024),
  );
  if (
    policy.target?.tuple !== expectedArtifact.tuple ||
    policy.target?.nodeVersion !== "22.23.2" ||
    policy.target?.nodeAbi !== 127 ||
    policy.alpineAuthority?.actualArchives !== 19 ||
    policy.alpineAuthority?.actualCompressedBytes !== 97_592_935 ||
    policy.build?.patch?.sha256 !==
      "1b87f2a95bf44e2dce53a4a6530bca38a78d45353c9f3dfcec29d9f716ce63d4" ||
    policy.build?.patch?.patchedSourceSha256 !==
      "b57b7a2171826869f4d6a299ccad32bd639ed89c4dcda5cd7c6e9a35dd4f9e84" ||
    JSON.stringify(policy.build?.nativeExports) !==
      JSON.stringify([
        "close",
        "eof",
        "fork",
        "inspect",
        "open",
        "process",
        "read",
        "resize",
        "write",
      ]) ||
    !Array.isArray(policy.alpineAuthority?.packages) ||
    policy.alpineAuthority.packages.length !== 19
  )
    throw new Error("PTY runtime build policy is not exact.");
  return policy;
};

const verifyManifestAuthority = (authority, policy) => {
  if (
    !exactKeys(authority, [
      "buildArgumentsSha256",
      "buildEnvironmentSha256",
      "canonicalImageConfig",
      "canonicalImageIndex",
      "canonicalImageManifest",
      "nodeAddonApiSourceManifestSha256",
      "nodeHeaderInventorySha256",
      "nodePtySourceManifestSha256",
      "nativeExports",
      "packageClosureSha256",
      "patchSha256",
      "patchedSourceSha256",
      "policySha256",
      "signedIndexSha256",
      "signerKeySha256",
      "tuple",
    ]) ||
    authority.tuple !== expectedArtifact.tuple ||
    authority.canonicalImageIndex !== policy.canonicalImage.index ||
    authority.canonicalImageManifest !== policy.canonicalImage.manifest ||
    authority.canonicalImageConfig !== policy.canonicalImage.config ||
    authority.policySha256 !==
      "abcb791a22e4e0d21aefa00ab5209532049ffad5b85b6e30d9204311d24cc09d" ||
    authority.packageClosureSha256 !==
      sha256(JSON.stringify(policy.alpineAuthority.packages)) ||
    authority.buildArgumentsSha256 !==
      sha256(JSON.stringify(policy.build.arguments)) ||
    authority.buildEnvironmentSha256 !==
      sha256(JSON.stringify(policy.build.environment)) ||
    authority.nodeHeaderInventorySha256 !==
      policy.canonicalImage.nodeHeaderInventorySha256 ||
    authority.signedIndexSha256 !== policy.alpineAuthority.index.sha256 ||
    authority.signerKeySha256 !==
      policy.alpineAuthority.index.signerKeySha256 ||
    authority.nodePtySourceManifestSha256 !==
      "c6c191296da1415cdafb8044a56c32afe5cf4c3d75c359db074cade04ad6bb48" ||
    authority.patchSha256 !== policy.build.patch.sha256 ||
    authority.patchedSourceSha256 !== policy.build.patch.patchedSourceSha256 ||
    JSON.stringify(authority.nativeExports) !==
      JSON.stringify(policy.build.nativeExports) ||
    authority.nodeAddonApiSourceManifestSha256 !==
      "aff0d41e4e5c77313d51cf6cfd070d43798520b4a8b7734b4acc600ded9e9b6e"
  )
    throw new Error("PTY runtime artifact authority is not exact.");
};

const verifyArtifactRecord = (record) => {
  if (
    !exactKeys(record, [
      "bytes",
      "format",
      "mode",
      "needed",
      "path",
      "reproducibility",
      "sha256",
      "tuple",
    ]) ||
    record.tuple !== expectedArtifact.tuple ||
    record.path !== expectedArtifact.path ||
    record.bytes !== expectedArtifact.bytes ||
    record.mode !== "0644" ||
    record.format !== "elf64-x86-64" ||
    record.sha256 !== expectedArtifact.sha256 ||
    !exactKeys(record.reproducibility, [
      "addonExecuted",
      "byteIdentical",
      "firstSha256",
      "independentCleanRoots",
      "secondSha256",
    ]) ||
    record.reproducibility.independentCleanRoots !== 2 ||
    record.reproducibility.firstSha256 !== expectedArtifact.sha256 ||
    record.reproducibility.secondSha256 !== expectedArtifact.sha256 ||
    record.reproducibility.byteIdentical !== true ||
    record.reproducibility.addonExecuted !== false ||
    JSON.stringify(record.needed) !== JSON.stringify(expectedArtifact.needed)
  )
    throw new Error("PTY runtime artifact record is not exact.");
};

// This is the one fail-closed conjunction for provenance, policy, artifact,
// ELF, and staging authority. Every subordinate check is mandatory.
export const verifyPtyRuntime = ({
  root = packageRoot,
  sourceRoot = repositoryRoot,
  stage = false,
} = {}) => {
  verifySourceAuthority(sourceRoot);
  const policy = verifyPolicy(root);
  verifyFileIdentity(
    resolve(root, "pty-runtime-artifacts.json"),
    2_281,
    "69a81b83b71d31bd6d630d12fbba0fa21d96bd06803105e1694acd01bda6a25f",
  );
  const manifest = JSON.parse(
    readBoundedRegular(resolve(root, "pty-runtime-artifacts.json"), 64 * 1024),
  );
  if (
    !exactKeys(manifest, ["artifacts", "authority", "schemaVersion"]) ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== 1
  )
    throw new Error("PTY runtime artifact manifest is not closed.");
  verifyManifestAuthority(manifest.authority, policy);
  const record = manifest.artifacts[0];
  verifyArtifactRecord(record);

  const source = resolve(root, record.path);
  const bytes = readBoundedRegular(source, maximumArtifactBytes, 0o644);
  if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256)
    throw new Error("PTY runtime artifact bytes do not match authority.");
  const needed = inspectElf(bytes);
  if (JSON.stringify(needed) !== JSON.stringify(record.needed))
    throw new Error("PTY runtime dependency closure is not exact.");

  verifyClosedSourceDirectory(resolve(root, "pty-runtime"), [
    "node127-linux-x64-musl",
  ]);
  verifyClosedSourceDirectory(resolve(root, dirname(record.path)), [
    "pty.node",
  ]);

  if (stage) {
    const destination = resolve(root, "dist", record.path);
    mkdirSync(dirname(destination), { mode: 0o755, recursive: true });
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    chmodSync(destination, 0o644);
  }
  return Object.freeze({
    ...record,
    needed: Object.freeze([...record.needed]),
  });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (
    arguments_.length > 1 ||
    (arguments_.length === 1 && arguments_[0] !== "--stage")
  )
    throw new Error("Usage: verify-pty-runtime.mjs [--stage]");
  verifyPtyRuntime({ stage: arguments_[0] === "--stage" });
}
