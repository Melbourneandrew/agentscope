import { createHash } from "node:crypto";

const BLOCK_BYTES = 512;
const ZERO_BLOCKS = 2;
const MAXIMUM_ENTRIES = 256;
const MAXIMUM_PATH_BYTES = 512;
const MAXIMUM_FILE_BYTES = 32 * 1024 * 1024;
const MAXIMUM_ARCHIVE_BYTES = 64 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export type ReleaseArchiveEntry = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
}>;

export type ReleaseArchiveManifest = Readonly<{
  entries: readonly ReleaseArchiveEntry[];
  maximumExpandedBytes: number;
}>;

const fail = (): never => {
  throw new Error("destination.local-sqlite.release-archive-invalid");
};

const exactRecord = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(
    value,
  ) as unknown as Record<PropertyKey, PropertyDescriptor>;
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== "string" || !keys.includes(key),
    ) ||
    keys.some((key) => !(key in descriptors))
  )
    return undefined;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
};

const exactArray = (value: unknown): readonly unknown[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(
    value,
  ) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const lengthDescriptor = descriptors["length"];
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > MAXIMUM_ENTRIES
  )
    return undefined;
  const length = lengthDescriptor.value;
  const expected = new Set([
    "length",
    ...Array.from({ length }, (_, index) => String(index)),
  ]);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== "string" || !expected.has(key),
    ) ||
    [...expected].some((key) => !(key in descriptors))
  )
    return undefined;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    result.push(descriptor.value);
  }
  return Object.freeze(result);
};

const isZeroBlock = (bytes: Uint8Array, offset: number): boolean => {
  for (let index = offset; index < offset + BLOCK_BYTES; index += 1)
    if (bytes[index] !== 0) return false;
  return true;
};

const fieldBytes = (
  bytes: Uint8Array,
  offset: number,
  length: number,
): Uint8Array => bytes.subarray(offset, offset + length);

const readString = (
  bytes: Uint8Array,
  offset: number,
  length: number,
): string => {
  const field = fieldBytes(bytes, offset, length);
  const zero = field.indexOf(0);
  const value = field.subarray(0, zero < 0 ? field.length : zero);
  try {
    return decoder.decode(value);
  } catch {
    return fail();
  }
};

const readName = (
  bytes: Uint8Array,
  offset: number,
  length: number,
): string => {
  const field = fieldBytes(bytes, offset, length);
  const zero = field.indexOf(0);
  if (zero >= 0) {
    for (let index = zero; index < field.length; index += 1)
      if (field[index] !== 0) return fail();
  }
  return readString(bytes, offset, length);
};

const readOctal = (
  bytes: Uint8Array,
  offset: number,
  length: number,
): number => {
  const raw = readString(bytes, offset, length).trim();
  if (!/^[0-7]+$/u.test(raw)) return fail();
  const value = Number.parseInt(raw, 8);
  /* v8 ignore next -- the fixed 12-byte octal field cannot represent a negative or unsafe integer; retained as a parser invariant. */
  if (!Number.isSafeInteger(value) || value < 0) return fail();
  return value;
};

const canonicalPath = (path: string): boolean => {
  if (
    path.length === 0 ||
    path !== path.normalize("NFC") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    [...path].some((value) => {
      const code = value.codePointAt(0)!;
      return code <= 31 || code === 127;
    }) ||
    /^[a-zA-Z]:/u.test(path) ||
    new TextEncoder().encode(path).length > MAXIMUM_PATH_BYTES
  )
    return false;
  const parts = path.split("/");
  return (
    parts.length <= 16 &&
    parts.every(
      (part) =>
        part.length > 0 &&
        part !== "." &&
        part !== ".." &&
        /^[A-Za-z0-9._@+-]+$/u.test(part) &&
        new TextEncoder().encode(part).length <= 128,
    )
  );
};

const validateManifest = (
  value: unknown,
): ReadonlyMap<string, ReleaseArchiveEntry> => {
  const manifest = exactRecord(value, ["entries", "maximumExpandedBytes"]);
  const values =
    manifest === undefined ? undefined : exactArray(manifest.entries);
  if (
    manifest === undefined ||
    values === undefined ||
    typeof manifest.maximumExpandedBytes !== "number" ||
    !Number.isSafeInteger(manifest.maximumExpandedBytes) ||
    manifest.maximumExpandedBytes < 0 ||
    manifest.maximumExpandedBytes > MAXIMUM_ARCHIVE_BYTES
  )
    return fail();
  const entries = new Map<string, ReleaseArchiveEntry>();
  const aliases = new Set<string>();
  let total = 0;
  for (const value of values) {
    const record = exactRecord(value, ["path", "bytes", "sha256"]);
    if (
      record === undefined ||
      typeof record.path !== "string" ||
      !canonicalPath(record.path) ||
      typeof record.bytes !== "number" ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 0 ||
      record.bytes > MAXIMUM_FILE_BYTES ||
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(record.sha256) ||
      entries.has(record.path)
    )
      return fail();
    const entry = Object.freeze({
      path: record.path,
      bytes: record.bytes,
      sha256: record.sha256,
    });
    const alias = entry.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (aliases.has(alias)) return fail();
    aliases.add(alias);
    entries.set(entry.path, entry);
    total += entry.bytes;
    if (!Number.isSafeInteger(total) || total > manifest.maximumExpandedBytes)
      return fail();
  }
  return entries;
};

const compileReleaseTarArchive = (
  archive: Uint8Array,
  manifest: ReleaseArchiveManifest,
): ReadonlyMap<string, Uint8Array> => {
  if (Object.getPrototypeOf(archive) !== Uint8Array.prototype) return fail();
  const owned = Uint8Array.prototype.slice.call(archive) as Uint8Array;
  if (
    owned.byteLength < BLOCK_BYTES * ZERO_BLOCKS ||
    owned.byteLength > MAXIMUM_ARCHIVE_BYTES ||
    owned.byteLength % BLOCK_BYTES !== 0
  )
    return fail();
  const expected = validateManifest(manifest);
  const compiled = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset < owned.byteLength) {
    if (isZeroBlock(owned, offset)) {
      if (
        offset + BLOCK_BYTES * ZERO_BLOCKS !== owned.byteLength ||
        !isZeroBlock(owned, offset + BLOCK_BYTES) ||
        compiled.size !== expected.size
      )
        return fail();
      return Object.freeze(compiled);
    }
    const header = owned.subarray(offset, offset + BLOCK_BYTES);
    /* v8 ignore next -- archive and every prior entry offset are block-aligned. */
    if (header.byteLength !== BLOCK_BYTES) return fail();
    const storedChecksum = readOctal(header, 148, 8);
    let checksum = 0;
    for (let index = 0; index < header.length; index += 1)
      checksum += index >= 148 && index < 156 ? 32 : header[index]!;
    if (checksum !== storedChecksum) return fail();
    if (
      readString(header, 257, 6) !== "ustar" ||
      readString(header, 263, 2) !== "00" ||
      readName(header, 157, 100) !== ""
    )
      return fail();
    const prefix = readName(header, 345, 155);
    const name = readName(header, 0, 100);
    const path = prefix.length === 0 ? name : `${prefix}/${name}`;
    const type = header[156];
    if (type !== 48 || !canonicalPath(path)) return fail();
    const entry = expected.get(path);
    if (entry === undefined || compiled.has(path)) return fail();
    const size = readOctal(header, 124, 12);
    if (size !== entry.bytes) return fail();
    const dataOffset = offset + BLOCK_BYTES;
    const dataEnd = dataOffset + size;
    const paddedEnd = dataOffset + Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;
    /* v8 ignore next -- admitted manifest file/total caps are below the already-proved archive bound; retained as a defensive arithmetic fence. */
    if (dataEnd > owned.byteLength || paddedEnd > owned.byteLength)
      return fail();
    for (let index = dataEnd; index < paddedEnd; index += 1)
      if (owned[index] !== 0) return fail();
    const payload = owned.slice(dataOffset, dataEnd);
    if (createHash("sha256").update(payload).digest("hex") !== entry.sha256)
      return fail();
    compiled.set(path, payload);
    offset = paddedEnd;
  }
  /* v8 ignore next -- block-aligned input either reaches the exact end marker or fails within the loop. */
  return fail();
};

export const compileReleaseTarArchiveForTesting = (
  archive: Uint8Array,
  manifest: ReleaseArchiveManifest,
): ReadonlyMap<string, Uint8Array> => {
  try {
    return compileReleaseTarArchive(archive, manifest);
  } catch {
    return fail();
  }
};
