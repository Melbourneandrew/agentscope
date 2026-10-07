import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { types } from "node:util";
import type { HarnessDirectoryInspection } from "./installation.js";

declare const __AGENTSCOPE_DIRECTORY_MANIFEST_SHA256__: string;

export type DirectoryPreimage = Readonly<{
  directoryPath: string;
  exists: boolean;
  mode: number | null;
  entries: readonly string[];
  digest: string;
  identity: string | null;
}>;

const unavailable = (): never => {
  throw new Error("harness.installation.directory-unavailable");
};
const own = (value: unknown, key: string): unknown => {
  if (typeof value !== "object" || value === null || types.isProxy(value))
    return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value as unknown;
};
const digest = (entries: readonly string[]) =>
  createHash("sha256").update(JSON.stringify(entries)).digest("hex");
const typedArrayByteLength = Reflect.get(
  Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype) as object,
    "byteLength",
  )!,
  "get",
) as (this: Uint8Array) => number;
const typedArraySet = Reflect.get(Uint8Array.prototype, "set");
const copyNativeBytes = (value: Uint8Array, length: number): Uint8Array => {
  const copy = new Uint8Array(length);
  Reflect.apply(typedArraySet, copy, [value]);
  return copy;
};

const nativeObservation = async (
  fd: number,
): Promise<Readonly<{ value: unknown }>> => {
  // Loading is deliberately inside the directory-only observation, never import
  // initialization. File-only plans do not require a directory native tuple.
  // The compiler-free build supplies this exact runtime asset after TS emit;
  // retain only this fixed specifier, and validate the unknown export below.
  const ownedLoaderPath = "./directory-runtime/loader/owned-loader.mjs";
  const module: unknown = await import(ownedLoaderPath);
  // This namespace comes only from the fixed artifact-bound module import, not
  // caller/native DTO data. Read its own data export without invoking getters.
  const load: unknown = Object.getOwnPropertyDescriptor(
    module,
    "loadDirectoryPrimitive",
  )?.value;
  if (typeof load !== "function") return unavailable();
  const expectedDigest =
    typeof __AGENTSCOPE_DIRECTORY_MANIFEST_SHA256__ === "string"
      ? __AGENTSCOPE_DIRECTORY_MANIFEST_SHA256__
      : undefined;
  const primitive: unknown = Reflect.apply(load, undefined, [expectedDigest]);
  const observe = own(primitive, "observeDirectory");
  if (typeof observe !== "function") return unavailable();
  // Native DTOs must not become thenables merely by crossing this async seam.
  const envelope = {
    __proto__: null,
    value: Reflect.apply(observe, undefined, [fd]) as unknown,
  };
  return envelope;
};

const names = (
  raw: unknown,
  directory: string,
  identity: (path: string) => string,
) => {
  const values = own(raw, "entries");
  if (!Array.isArray(values) || types.isProxy(values)) return unavailable();
  // A non-Proxy Array has its intrinsic non-configurable numeric data length.
  const length = values.length;
  if (length > 1024 || Reflect.ownKeys(values).length !== length + 1)
    return unavailable();
  const result: string[] = [];
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    const value = own(values, String(index));
    if (
      types.isProxy(value) ||
      !(value instanceof Uint8Array) ||
      Object.getPrototypeOf(value) !== Uint8Array.prototype
    )
      return unavailable();
    const byteLength = Reflect.apply(typedArrayByteLength, value, []);
    if (byteLength === 0 || byteLength > 1_048_576 - total)
      return unavailable();
    total += byteLength;
    const bytes = copyNativeBytes(value, byteLength);
    const name = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (name === "." || name === ".." || /[\0/]/u.test(name))
      return unavailable();
    result.push(name);
  }
  if (
    new Set(result.map((name) => identity(join(directory, name)))).size !==
    result.length
  )
    return unavailable();
  return Object.freeze(
    result.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
  );
};

const metadataIdentity = (value: BigIntStats) =>
  [
    value.dev,
    value.ino,
    value.mode,
    value.nlink,
    value.mtimeNs,
    value.ctimeNs,
  ].join(":");

export const inspectDirectoryPreimage = async (
  directoryPath: string,
  identity: (path: string) => string,
): Promise<DirectoryPreimage> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (process.platform !== "darwin" && process.platform !== "linux")
      return unavailable();
    handle = await open(
      directoryPath,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_DIRECTORY |
        constants.O_NONBLOCK,
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isDirectory()) return unavailable();
    const { value: observed } = await nativeObservation(handle.fd);
    const entries = names(observed, directoryPath, identity);
    const after = await handle.stat({ bigint: true });
    const path = await lstat(directoryPath, { bigint: true });
    if (
      own(observed, "dev") !== before.dev ||
      own(observed, "ino") !== before.ino ||
      own(observed, "mode") !== before.mode ||
      metadataIdentity(before) !== metadataIdentity(after) ||
      metadataIdentity(after) !== metadataIdentity(path)
    )
      return unavailable();
    return Object.freeze({
      directoryPath,
      exists: true,
      mode: Number(before.mode & 0o777n),
      entries,
      digest: digest(entries),
      identity: metadataIdentity(before),
    });
  } catch (error) {
    if (own(error, "code") === "ENOENT" && handle === undefined) {
      const entries = Object.freeze([] as string[]);
      return Object.freeze({
        directoryPath,
        exists: false,
        mode: null,
        entries,
        digest: digest(entries),
        identity: null,
      });
    }
    return unavailable();
  } finally {
    await handle?.close();
  }
};

export const directoryPreimageMatches = (
  before: DirectoryPreimage,
  after: DirectoryPreimage,
) =>
  before.exists === after.exists &&
  before.identity === after.identity &&
  before.mode === after.mode &&
  before.digest === after.digest;

export const directoryInspection = (
  values: readonly DirectoryPreimage[],
): readonly HarnessDirectoryInspection[] =>
  Object.freeze(
    values.map((value) =>
      Object.freeze({
        directoryPath: value.directoryPath,
        exists: value.exists,
        mode: value.mode,
        entries: Object.freeze([...value.entries]),
      }),
    ),
  );
