import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, inflateRawSync } from "node:zlib";

const BLOCK_BYTES = 512;
const MAXIMUM_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAXIMUM_ENTRIES = 256;
const MAXIMUM_PATH_BYTES = 91;
const MAXIMUM_ARCHIVE_PATH_BYTES = 99;
const MAXIMUM_SEGMENT_BYTES = 91;
const MAXIMUM_FILE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_DEPTH = 8;
const MAXIMUM_COMPRESSION_RATIO = 256;
const POSIX_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;

const invalid = () => {
  throw new Error("destination.local-sqlite.native-archive.invalid");
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const crcTable = Object.freeze(
  Array.from({ length: 256 }, (_, value) => {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1)
      current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    return current >>> 0;
  }),
);
const crc32 = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};
const asciiField = (block, offset, length) => {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  const bytes = end < 0 ? field : field.subarray(0, end);
  if (bytes.some((byte) => byte < 0x20 || byte > 0x7e)) invalid();
  return bytes.toString("ascii");
};
const octalField = (block, offset, length) => {
  const value = asciiField(block, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) invalid();
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid();
  return parsed;
};
const exactNameField = (block, offset, length) => {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  if (end < 1 || !field.subarray(end).every((byte) => byte === 0)) invalid();
  return asciiField(block, offset, length);
};
const canonicalPath = (value, directory, maximumBytes = MAXIMUM_PATH_BYTES) => {
  const path = directory && value.endsWith("/") ? value.slice(0, -1) : value;
  if (
    path.length < 1 ||
    Buffer.byteLength(path, "utf8") > maximumBytes ||
    !POSIX_PATH.test(path) ||
    path.split("/").length > MAXIMUM_DEPTH ||
    path
      .split("/")
      .some(
        (part) =>
          part === "." ||
          part === ".." ||
          Buffer.byteLength(part, "utf8") > MAXIMUM_SEGMENT_BYTES,
      ) ||
    path.includes("\\")
  )
    invalid();
  return path;
};

const decodeSingleGzipMember = (archive) => {
  if (
    archive.length < 19 ||
    archive.length > MAXIMUM_ARCHIVE_BYTES ||
    archive[0] !== 0x1f ||
    archive[1] !== 0x8b ||
    archive[2] !== 8 ||
    archive[3] !== 0
  )
    invalid();
  let inflated;
  try {
    inflated = inflateRawSync(archive.subarray(10), {
      info: true,
      maxOutputLength: MAXIMUM_EXPANDED_BYTES,
    });
  } catch {
    return invalid();
  }
  const consumed = inflated.engine.bytesWritten;
  const trailerOffset = 10 + consumed;
  if (trailerOffset + 8 !== archive.length) invalid();
  const bytes = inflated.buffer;
  if (
    archive.readUInt32LE(trailerOffset) !== crc32(bytes) ||
    archive.readUInt32LE(trailerOffset + 4) !== bytes.length >>> 0 ||
    bytes.length > archive.length * MAXIMUM_COMPRESSION_RATIO
  )
    invalid();
  return bytes;
};

// eslint-disable-next-line complexity, max-lines-per-function -- one pre-write compiler admits the complete closed gzip/tar grammar atomically.
export const compileArchive = (archive, declaredEntries) => {
  assert(Buffer.isBuffer(archive));
  const tar = decodeSingleGzipMember(archive);
  const declared = new Map();
  const declaredAliases = new Set();
  let declaredBytes = 0;
  for (const entry of declaredEntries) {
    const alias =
      typeof entry?.path === "string" ? entry.path.toLowerCase() : "";
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > MAXIMUM_FILE_BYTES ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256) ||
      declared.has(entry.path) ||
      canonicalPath(entry.path, false) !== entry.path ||
      declaredAliases.has(alias)
    )
      invalid();
    declaredBytes += entry.bytes;
    if (declaredBytes > MAXIMUM_EXPANDED_BYTES) invalid();
    declaredAliases.add(alias);
    declared.set(entry.path, entry);
  }
  const compiled = new Map();
  const archiveNames = new Set();
  const archiveAliases = new Set();
  let offset = 0;
  let entries = 0;
  let expandedBytes = 0;
  while (offset + BLOCK_BYTES <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) {
      if (
        offset + BLOCK_BYTES * 2 !== tar.length ||
        !tar
          .subarray(offset + BLOCK_BYTES, offset + BLOCK_BYTES * 2)
          .every((byte) => byte === 0)
      )
        invalid();
      offset += BLOCK_BYTES * 2;
      break;
    }
    entries += 1;
    if (entries > MAXIMUM_ENTRIES) invalid();
    const storedChecksum = octalField(header, 148, 8);
    let checksum = 0;
    for (let index = 0; index < header.length; index += 1)
      checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    if (checksum !== storedChecksum) invalid();
    if (
      ![
        Buffer.from("000644 \0", "ascii"),
        Buffer.from("000755 \0", "ascii"),
      ].some((mode) => header.subarray(100, 108).equals(mode)) ||
      !header.subarray(108, 124).every((byte) => byte === 0) ||
      !header
        .subarray(136, 148)
        .equals(Buffer.from("3560116604 \0", "ascii")) ||
      !header
        .subarray(148, 154)
        .every((byte) => byte >= 0x30 && byte <= 0x37) ||
      !(
        (header[154] === 0 && header[155] === 0x20) ||
        (header[154] === 0x20 && header[155] === 0)
      ) ||
      !header.subarray(257, 263).equals(Buffer.from("ustar\0", "ascii")) ||
      !header.subarray(263, 265).equals(Buffer.from("00", "ascii")) ||
      !header.subarray(157, 257).every((byte) => byte === 0) ||
      !header.subarray(265, 329).every((byte) => byte === 0) ||
      ![
        Buffer.from("000000 \0", "ascii"),
        Buffer.from("0000000\0", "ascii"),
      ].some((zero) => header.subarray(329, 337).equals(zero)) ||
      ![
        Buffer.from("000000 \0", "ascii"),
        Buffer.from("0000000\0", "ascii"),
      ].some((zero) => header.subarray(337, 345).equals(zero)) ||
      !header.subarray(345, 512).every((byte) => byte === 0)
    )
      invalid();
    const prefix = "";
    const name = exactNameField(header, 0, 100);
    const archiveName = canonicalPath(
      prefix.length === 0 ? name : `${prefix}/${name}`,
      false,
      MAXIMUM_ARCHIVE_PATH_BYTES,
    );
    const archiveAlias = archiveName.toLowerCase();
    if (archiveNames.has(archiveName) || archiveAliases.has(archiveAlias))
      invalid();
    archiveNames.add(archiveName);
    archiveAliases.add(archiveAlias);
    const size = octalField(header, 124, 12);
    const type = header[156];
    if ((type !== 0 && type !== 0x30) || size > MAXIMUM_FILE_BYTES) invalid();
    const payloadStart = offset + BLOCK_BYTES;
    const padded = Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;
    if (payloadStart + padded > tar.length) invalid();
    expandedBytes += size;
    if (expandedBytes > MAXIMUM_EXPANDED_BYTES) invalid();
    if (!archiveName.startsWith("package/")) invalid();
    const relative = archiveName.slice("package/".length);
    const authority = declared.get(relative);
    const payload = tar.subarray(payloadStart, payloadStart + size);
    if (
      authority === undefined ||
      compiled.has(relative) ||
      authority.bytes !== size ||
      sha256(payload) !== authority.sha256 ||
      !tar
        .subarray(payloadStart + size, payloadStart + padded)
        .every((byte) => byte === 0)
    )
      invalid();
    compiled.set(relative, Buffer.from(payload));
    offset = payloadStart + padded;
  }
  if (
    offset !== tar.length ||
    compiled.size !== declared.size ||
    [...declared.keys()].some((path) => !compiled.has(path))
  )
    invalid();
  return Object.freeze({
    files: compiled,
    archiveEntries: entries,
    expandedBytes,
  });
};

export const materializeCompiledArchive = (compiled, target) => {
  const records = [...compiled.files].map(([path, bytes]) => ({
    path,
    bytes: bytes.length,
    sha256: sha256(bytes),
    base64: bytes.toString("base64"),
  }));
  const result = spawnSync(
    "/usr/bin/python3",
    [fileURLToPath(new URL("materialize-helper.py", import.meta.url)), target],
    {
      input: JSON.stringify(records),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
    },
  );
  if (result.error || result.status !== 0) invalid();
  const evidence = JSON.parse(result.stdout);
  if (
    evidence.files !== records.length ||
    evidence.authority !== "descriptor-relative-openat"
  )
    invalid();
};

export const archiveLimits = Object.freeze({
  maximumArchiveBytes: MAXIMUM_ARCHIVE_BYTES,
  maximumExpandedBytes: MAXIMUM_EXPANDED_BYTES,
  maximumEntries: MAXIMUM_ENTRIES,
  maximumPathBytes: MAXIMUM_PATH_BYTES,
  maximumArchivePathBytes: MAXIMUM_ARCHIVE_PATH_BYTES,
  maximumSegmentBytes: MAXIMUM_SEGMENT_BYTES,
  maximumFileBytes: MAXIMUM_FILE_BYTES,
  maximumDepth: MAXIMUM_DEPTH,
  maximumCompressionRatio: MAXIMUM_COMPRESSION_RATIO,
  archiveGrammar: "single-gzip-member-ustar-regular-file-only-v2",
});

const writeOctal = (block, offset, length, value) => {
  const encoded = value.toString(8).padStart(length - 1, "0");
  block.write(encoded, offset, length - 1, "ascii");
  block[offset + length - 1] = 0;
};
const fixtureTar = (entries) => {
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(BLOCK_BYTES);
    header.write(entry.name, 0, 100, "ascii");
    header.write("000644 \0", 100, 8, "ascii");
    writeOctal(header, 124, 12, entry.payload.length);
    header.write("3560116604 \0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = entry.type ?? 0x30;
    header.write(entry.magic ?? "ustar\0", 257, 6, "ascii");
    header.write(entry.version ?? "00", 263, 2, "ascii");
    header.write("000000 \0", 329, 8, "ascii");
    header.write("000000 \0", 337, 8, "ascii");
    if (entry.linkname) header.write(entry.linkname, 157, 100, "ascii");
    if (entry.reserved) header[500] = 1;
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const checksumText = checksum.toString(8).padStart(6, "0");
    header.write(checksumText, 148, 6, "ascii");
    header[154] = 0x20;
    header[155] = 0;
    blocks.push(header, entry.payload);
    const padding =
      Math.ceil(entry.payload.length / BLOCK_BYTES) * BLOCK_BYTES -
      entry.payload.length;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(BLOCK_BYTES * 2));
  return Buffer.concat(blocks);
};
const gzipFixture = (entries) =>
  gzipSync(fixtureTar(entries), { level: 9, mtime: 0 });

export const verifyArchiveCompilerHostileFixtures = () => {
  const payload = Buffer.from("owned", "utf8");
  const authority = Object.freeze([
    Object.freeze({
      path: "owned.txt",
      bytes: payload.length,
      sha256: sha256(payload),
    }),
  ]);
  const valid = gzipFixture([{ name: "package/owned.txt", payload }]);
  assert.equal(
    compileArchive(valid, authority).files.get("owned.txt").toString(),
    "owned",
  );
  const boundaryPath = "x".repeat(MAXIMUM_PATH_BYTES);
  assert.equal(
    compileArchive(
      gzipFixture([{ name: `package/${boundaryPath}`, payload }]),
      [
        {
          path: boundaryPath,
          bytes: payload.length,
          sha256: sha256(payload),
        },
      ],
    )
      .files.get(boundaryPath)
      .toString(),
    "owned",
  );
  const rejected = [
    gzipFixture([{ name: "package/owned.txt", payload, magic: "notar\0" }]),
    gzipFixture([{ name: "package/owned.txt", payload, version: "01" }]),
    gzipFixture([
      { name: "package/owned.txt", payload, linkname: "package/other" },
    ]),
    gzipFixture([{ name: "package/owned.txt", payload, reserved: true }]),
    gzipFixture([{ name: "evil/", payload: Buffer.alloc(0), type: 0x35 }]),
    gzipFixture([{ name: "package/../owned.txt", payload }]),
    gzipFixture([{ name: "/package/owned.txt", payload }]),
    gzipFixture([{ name: "package\\owned.txt", payload }]),
    gzipFixture([{ name: "package/owned.txt", payload, type: 0x32 }]),
    gzipFixture([{ name: "package/owned.txt", payload, type: 0x78 }]),
    gzipFixture([{ name: "package/owned.txt", payload, type: 0x4c }]),
    gzipFixture([{ name: "package/owned.txt", payload, type: 0x53 }]),
    gzipFixture([
      { name: "package/owned.txt", payload },
      { name: "package/owned.txt", payload },
    ]),
    Buffer.concat([valid, Buffer.from("trailing")]),
    Buffer.concat([valid, valid]),
    valid.subarray(0, valid.length - 1),
    Buffer.from(valid.map((byte, index) => (index === 20 ? byte ^ 1 : byte))),
    gzipFixture([
      { name: `package/${"x".repeat(MAXIMUM_PATH_BYTES + 1)}`, payload },
    ]),
    gzipFixture([
      {
        name: `package/${Array.from({ length: MAXIMUM_DEPTH + 1 }, () => "x").join("/")}`,
        payload,
      },
    ]),
    gzipFixture(
      Array.from({ length: MAXIMUM_ENTRIES + 1 }, (_, index) => ({
        name: `package/${index}.txt`,
        payload: Buffer.alloc(0),
      })),
    ),
    gzipFixture([
      {
        name: "package/owned.txt",
        payload: Buffer.alloc(MAXIMUM_EXPANDED_BYTES + 1),
      },
    ]),
    Buffer.alloc(MAXIMUM_ARCHIVE_BYTES + 1),
  ];
  for (const archive of rejected)
    assert.throws(
      () => compileArchive(archive, authority),
      /native-archive\.invalid/u,
    );
  assert.throws(
    () =>
      compileArchive(
        gzipFixture([
          { name: "package/A", payload },
          { name: "package/a", payload },
        ]),
        [
          { path: "A", bytes: payload.length, sha256: sha256(payload) },
          { path: "a", bytes: payload.length, sha256: sha256(payload) },
        ],
      ),
    /native-archive\.invalid/u,
  );
};

export const verifyMaterializerParentSwapFixture = () => {
  const temporary = mkdtempSync(join(tmpdir(), "agentscope-materializer-"));
  const target = join(temporary, "target");
  const outside = join(temporary, "outside");
  mkdirSync(target, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  chmodSync(target, 0o700);
  chmodSync(outside, 0o700);
  const payload = Buffer.from("descriptor-owned", "utf8");
  const records = [
    {
      path: "nested/owned.txt",
      bytes: payload.length,
      sha256: sha256(payload),
      base64: payload.toString("base64"),
    },
  ];
  try {
    const result = spawnSync(
      "/usr/bin/python3",
      [
        fileURLToPath(new URL("materialize-helper.py", import.meta.url)),
        target,
        "--hostile-parent-swap",
        outside,
      ],
      {
        input: JSON.stringify(records),
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
      },
    );
    assert.notEqual(result.status, 0);
    assert.deepEqual(readdirSync(outside), []);
    assert.equal(
      readFileSync(join(target, "nested-retained", "owned.txt"), "utf8"),
      "descriptor-owned",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};
