import { createHash, verify as verifySignature } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const packageRoot = resolve(import.meta.dirname, "..");
const policy = JSON.parse(
  readFileSync(resolve(packageRoot, "pty-runtime-policy.json"), "utf8"),
);
const maximumMemberBytes = 512 * 1024 * 1024;
const maximumMembers = 8_192;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha1Base64 = (bytes) => createHash("sha1").update(bytes).digest("base64");

const readBoundedRegular = (path, maximumBytes, expectedMode) => {
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
      throw new Error(`PTY toolchain authority is not exact: ${path}`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size
    )
      throw new Error(`PTY toolchain authority changed while reading: ${path}`);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
};

const gzipMembers = (bytes) => {
  const members = [];
  for (let offset = 0; offset < bytes.length;) {
    if (
      bytes[offset] !== 0x1f ||
      bytes[offset + 1] !== 0x8b ||
      bytes[offset + 2] !== 8
    )
      throw new Error("PTY APK gzip member is malformed.");
    const flags = bytes[offset + 3];
    let payloadOffset = offset + 10;
    if ((flags & 4) !== 0) {
      const extraBytes = bytes.readUInt16LE(payloadOffset);
      payloadOffset += 2 + extraBytes;
    }
    for (const flag of [8, 16])
      if ((flags & flag) !== 0) {
        const zero = bytes.indexOf(0, payloadOffset);
        if (zero < 0) throw new Error("PTY APK gzip header is unterminated.");
        payloadOffset = zero + 1;
      }
    if ((flags & 2) !== 0) payloadOffset += 2;
    const inflated = inflateRawSync(bytes.subarray(payloadOffset), {
      info: true,
      maxOutputLength: maximumMemberBytes,
    });
    const end = payloadOffset + inflated.engine.bytesWritten + 8;
    if (end > bytes.length)
      throw new Error("PTY APK gzip member exceeds the archive.");
    members.push({ bytes: inflated.buffer, raw: bytes.subarray(offset, end) });
    offset = end;
  }
  return members;
};

const parseOctal = (bytes) => {
  const value = bytes.toString("ascii").replace(/\0.*$/u, "").trim();
  if (!/^[0-7]*$/u.test(value))
    throw new Error("PTY APK tar number is invalid.");
  return value === "" ? 0 : Number.parseInt(value, 8);
};

const parsePax = (bytes) => {
  const values = {};
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) throw new Error("PTY APK PAX length is missing.");
    const length = Number.parseInt(
      bytes.subarray(offset, space).toString(),
      10,
    );
    if (
      !Number.isSafeInteger(length) ||
      length < 4 ||
      offset + length > bytes.length
    )
      throw new Error("PTY APK PAX record is unbounded.");
    const record = bytes.subarray(space + 1, offset + length - 1).toString();
    const equals = record.indexOf("=");
    if (equals < 1) throw new Error("PTY APK PAX record is malformed.");
    values[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return values;
};

const tarEntries = (bytes, memberIndex) => {
  const entries = [];
  let pax = {};
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) continue;
    const size = parseOctal(header.subarray(124, 136));
    if (size > maximumMemberBytes || offset + size > bytes.length)
      throw new Error("PTY APK tar member is unbounded.");
    const contents = bytes.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(header[156] || 48);
    if (type === "x") {
      pax = parsePax(contents);
      continue;
    }
    const headerPath = header
      .subarray(0, 100)
      .toString()
      .replace(/\0.*$/su, "");
    const prefix = header.subarray(345, 500).toString().replace(/\0.*$/su, "");
    const path = String(
      pax.path ?? (prefix ? `${prefix}/${headerPath}` : headerPath),
    );
    const link = String(
      pax.linkpath ??
        header.subarray(157, 257).toString().replace(/\0.*$/su, ""),
    );
    pax = {};
    if (
      path === "" ||
      path.startsWith("/") ||
      path.split("/").includes("..") ||
      !["0", "1", "2", "5"].includes(type)
    )
      throw new Error(`PTY APK member is unsafe: ${path}`);
    entries.push({
      contents,
      link,
      memberIndex,
      mode: parseOctal(header.subarray(100, 108)) & 0o777,
      path,
      size,
      type,
    });
    if (entries.length > maximumMembers)
      throw new Error("PTY APK member count is unbounded.");
  }
  return entries;
};

const inventoryDigest = (entries) =>
  sha256(
    `${entries
      .map(
        ({ contents, link, mode, path, size, type }) =>
          `${path}\0${type}\0${mode.toString(8).padStart(4, "0")}\0${size}\0${link}\0${sha256(contents)}`,
      )
      .sort()
      .join("\n")}\n`,
  );
export const calculatePackageInventory = (bytes) => {
  const members = gzipMembers(bytes);
  const entries = members.flatMap((member, index) =>
    tarEntries(member.bytes, index),
  );
  return Object.freeze({
    inventory: inventoryDigest(entries),
    memberCount: entries.length,
  });
};
const oneEntry = (entries, path) => {
  const matches = entries.filter((entry) => entry.path === path);
  if (matches.length !== 1)
    throw new Error(`PTY APK authority entry is not unique: ${path}`);
  return matches[0];
};

const packageRecords = () =>
  policy.alpineAuthority.packages.map(
    ([
      name,
      version,
      bytes,
      signedIndexChecksum,
      digest,
      memberCount,
      inventory,
    ]) => ({
      bytes,
      filename: `${name}-${version}.apk`,
      inventory,
      memberCount,
      name,
      sha256: digest,
      signedIndexChecksum,
      url: `${policy.alpineAuthority.repository}/${name}-${version}.apk`,
      version,
    }),
  );

export const validatePtyToolchainPolicy = () => {
  const records = packageRecords();
  const bytes = records.reduce((sum, record) => sum + record.bytes, 0);
  if (
    records.length !== policy.alpineAuthority.actualArchives ||
    records.length > policy.alpineAuthority.maximumArchives ||
    bytes !== policy.alpineAuthority.actualCompressedBytes ||
    bytes > policy.alpineAuthority.maximumCompressedBytes ||
    new Set(records.map(({ filename }) => filename)).size !== records.length
  )
    throw new Error("PTY toolchain policy is not closed.");
  return Object.freeze(records.map((record) => Object.freeze(record)));
};

export const inspectAuthenticatedPackage = (bytes, record, publicKeyPem) => {
  if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256)
    throw new Error(`PTY APK payload identity changed: ${record.filename}`);
  const members = gzipMembers(bytes);
  if (members.length !== 3)
    throw new Error("PTY APK member sequence is not exact.");
  const signatureEntries = tarEntries(members[0].bytes, 0);
  const controlEntries = tarEntries(members[1].bytes, 1);
  const dataEntries = tarEntries(members[2].bytes, 2);
  const signature = oneEntry(
    signatureEntries,
    `.SIGN.RSA.${policy.alpineAuthority.index.signer}`,
  );
  if (
    !verifySignature(
      "RSA-SHA1",
      members[1].raw,
      publicKeyPem,
      signature.contents,
    ) ||
    `Q1${sha1Base64(members[1].raw)}` !== record.signedIndexChecksum
  )
    throw new Error(`PTY APK signature authority failed: ${record.filename}`);
  const packageInfo = oneEntry(controlEntries, ".PKGINFO").contents.toString();
  const fields = Object.fromEntries(
    packageInfo
      .split("\n")
      .filter((line) => line.includes(" = "))
      .map((line) => line.split(" = ", 2)),
  );
  if (
    fields.pkgname !== record.name ||
    fields.pkgver !== record.version ||
    fields.arch !== "x86_64" ||
    fields.datahash !== sha256(members[2].raw)
  )
    throw new Error(
      `PTY APK package metadata is not exact: ${record.filename}`,
    );
  const entries = [...signatureEntries, ...controlEntries, ...dataEntries];
  if (
    entries.length !== record.memberCount ||
    inventoryDigest(entries) !== record.inventory
  )
    throw new Error(
      `PTY APK member inventory is not exact: ${record.filename}`,
    );
  return Object.freeze({ dataEntries, entries });
};

export const verifySignedIndex = ({ indexPath, keyPath }) => {
  const authority = policy.alpineAuthority.index;
  const index = readBoundedRegular(indexPath, authority.bytes, 0o400);
  const key = readBoundedRegular(keyPath, 4 * 1024, 0o600);
  if (index.length !== authority.bytes || sha256(index) !== authority.sha256)
    throw new Error("PTY signed APK index identity changed.");
  if (sha256(key) !== authority.signerKeySha256)
    throw new Error("PTY APK signer key identity changed.");
  const members = gzipMembers(index);
  if (members.length !== 2)
    throw new Error("PTY signed APK index is malformed.");
  const signature = oneEntry(
    tarEntries(members[0].bytes, 0),
    `.SIGN.RSA.${authority.signer}`,
  );
  if (!verifySignature("RSA-SHA1", members[1].raw, key, signature.contents))
    throw new Error("PTY signed APK index signature failed.");
  const indexText = oneEntry(
    tarEntries(members[1].bytes, 1),
    "APKINDEX",
  ).contents.toString();
  verifySignedIndexRecords(indexText);
  return key;
};

export const verifySignedIndexRecords = (
  indexText,
  packageAuthority = validatePtyToolchainPolicy(),
) => {
  const indexedRecords = new Map(
    indexText.split("\n\n").map((block) => {
      const fields = Object.fromEntries(
        block
          .split("\n")
          .filter((line) => line.length > 2 && line[1] === ":")
          .map((line) => [line[0], line.slice(2)]),
      );
      return [`${fields.P}=${fields.V}`, fields];
    }),
  );
  for (const record of packageAuthority) {
    const indexed = indexedRecords.get(`${record.name}=${record.version}`);
    if (
      indexed?.A !== "x86_64" ||
      indexed.C !== record.signedIndexChecksum ||
      Number(indexed.S) !== record.bytes
    )
      throw new Error(
        `PTY APK signed index mapping changed: ${record.filename}`,
      );
  }
};

const assertEmptyPrivateDirectory = (directory) => {
  const stat = lstatSync(directory);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    readdirSync(directory).length !== 0
  )
    throw new Error(
      "PTY toolchain destination must be an empty private directory.",
    );
  return stat;
};
const sameDirectory = (path, expected) => {
  const actual = lstatSync(path);
  return (
    !actual.isSymbolicLink() &&
    actual.isDirectory() &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino
  );
};

export const openPrivateDirectory = (directory) => {
  const identity = assertEmptyPrivateDirectory(directory);
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  return Object.freeze({ descriptor, directory, identity });
};

export const writePinnedPayload = (authority, filename, bytes) => {
  if (!/^[A-Za-z0-9+_.-]+$/u.test(filename))
    throw new Error("PTY toolchain filename is not closed.");
  const descriptorIdentity = fstatSync(authority.descriptor);
  if (
    descriptorIdentity.dev !== authority.identity.dev ||
    descriptorIdentity.ino !== authority.identity.ino ||
    !sameDirectory(authority.directory, authority.identity)
  )
    throw new Error("PTY toolchain destination identity changed.");
  const descriptor = openSync(
    `/proc/self/fd/${authority.descriptor}/${filename}`,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let written = 0;
    while (written < bytes.byteLength)
      written += writeSync(descriptor, bytes, written);
    if (!sameDirectory(authority.directory, authority.identity))
      throw new Error("PTY toolchain destination identity changed.");
  } finally {
    closeSync(descriptor);
  }
};

export const verifyPackageDirectory = ({ directory, indexPath, keyPath }) => {
  const publicKey = verifySignedIndex({ indexPath, keyPath });
  const expectedNames = validatePtyToolchainPolicy()
    .map(({ filename }) => filename)
    .sort();
  if (
    JSON.stringify(readdirSync(directory).sort()) !==
    JSON.stringify(expectedNames)
  )
    throw new Error("PTY APK directory inventory is not exact.");
  return validatePtyToolchainPolicy().map((record) => {
    const bytes = readBoundedRegular(
      resolve(directory, record.filename),
      record.bytes,
      0o600,
    );
    return { record, ...inspectAuthenticatedPackage(bytes, record, publicKey) };
  });
};

export const verifyInstalledPackageClosure = (packageSets, root = "/") => {
  const files = new Map();
  for (const { dataEntries, record } of packageSets)
    for (const entry of dataEntries) {
      const prior = files.get(entry.path);
      if (prior && entry.type !== "5")
        throw new Error(
          `PTY installed package member is duplicated: ${entry.path}`,
        );
      files.set(entry.path, { ...entry, package: record.filename });
    }
  for (const entry of files.values()) {
    const path = resolve(root, entry.path);
    const stat = lstatSync(path);
    if (entry.type === "5") {
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error(`PTY installed directory is not exact: ${entry.path}`);
      continue;
    }
    if (entry.type === "2") {
      if (!stat.isSymbolicLink() || readlinkSync(path) !== entry.link)
        throw new Error(`PTY installed symlink is not exact: ${entry.path}`);
      continue;
    }
    if (entry.type === "1") {
      const target = statSync(resolve(root, entry.link));
      if (!stat.isFile() || stat.dev !== target.dev || stat.ino !== target.ino)
        throw new Error(`PTY installed hardlink is not exact: ${entry.path}`);
      continue;
    }
    const contents = readBoundedRegular(path, entry.size, entry.mode);
    if (
      contents.length !== entry.size ||
      sha256(contents) !== sha256(entry.contents)
    )
      throw new Error(
        `PTY installed package bytes are not exact: ${entry.path}`,
      );
  }
  return Object.freeze({ members: files.size });
};

export const installPackageClosure = (packageSets, root) => {
  const rootIdentity = assertEmptyPrivateDirectory(root);
  const entries = packageSets.flatMap(({ dataEntries }) => dataEntries);
  for (const entry of entries.filter(({ type }) => type === "5")) {
    const path = resolve(root, entry.path);
    mkdirSync(path, { mode: entry.mode, recursive: true });
    chmodSync(path, entry.mode);
  }
  for (const entry of entries.filter(({ type }) => type === "0")) {
    const path = resolve(root, entry.path);
    mkdirSync(resolve(path, ".."), { mode: 0o755, recursive: true });
    const descriptor = openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      entry.mode,
    );
    try {
      let written = 0;
      while (written < entry.contents.length)
        written += writeSync(descriptor, entry.contents, written);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(path, entry.mode);
  }
  for (const entry of entries.filter(({ type }) => type === "1"))
    linkSync(resolve(root, entry.link), resolve(root, entry.path));
  for (const entry of entries.filter(({ type }) => type === "2"))
    symlinkSync(entry.link, resolve(root, entry.path));
  if (!sameDirectory(root, rootIdentity))
    throw new Error("PTY installed toolchain root identity changed.");
  verifyInstalledPackageClosure(packageSets, root);
};

export const acquirePtyToolchain = async (
  directory,
  { fetcher = fetch, indexPath, keyPath },
) => {
  const directoryAuthority = openPrivateDirectory(directory);
  try {
    const publicKey = verifySignedIndex({ indexPath, keyPath });
    for (const record of validatePtyToolchainPolicy()) {
      const response = await fetcher(record.url, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok || response.body === null)
        throw new Error(`PTY toolchain download failed: ${record.filename}`);
      if (Number(response.headers.get("content-length")) !== record.bytes)
        throw new Error(`PTY toolchain length changed: ${record.filename}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      inspectAuthenticatedPackage(bytes, record, publicKey);
      try {
        writePinnedPayload(directoryAuthority, record.filename, bytes);
      } finally {
        bytes.fill(0);
      }
    }
    return validatePtyToolchainPolicy();
  } finally {
    closeSync(directoryAuthority.descriptor);
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5)
    throw new Error(
      "Usage: acquire-pty-toolchain.mjs ABSOLUTE_EMPTY_0700_DIRECTORY EXACT_SIGNED_APKINDEX EXACT_SIGNER_KEY",
    );
  const [destination, indexPath, keyPath] = process.argv.slice(2);
  if (![destination, indexPath, keyPath].every((path) => path.startsWith("/")))
    throw new Error("PTY toolchain authority paths must be absolute.");
  await acquirePtyToolchain(destination, { indexPath, keyPath });
}
