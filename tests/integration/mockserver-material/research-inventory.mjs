/** Data validation only: cache/JAR observations never authenticate dependencies. */
import { createHash } from "node:crypto";
import { types } from "node:util";

const maximumBytes = 8 * 1024 * 1024;
const maximumEntries = 16_384;
const maximumFileBytes = 256 * 1024 * 1024;
const maximumAggregateBytes = 1024 * 1024 * 1024;
const artifactPath =
  "source/mockserver/mockserver-netty/target/mockserver-netty-7.6.0-jar-with-dependencies.jar";
const cacheRoots = ["maven-repository", "npm-cache"];
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const nativeGetter = (name, value) =>
  Object.getOwnPropertyDescriptor(typedArray, name).get.call(value);
const fail = () => {
  throw new Error("integration.mockserver-material.research-inventory");
};
const snapshot = (value) => {
  if (types.isProxy(value) || !Buffer.isBuffer(value)) fail();
  const length = nativeGetter("byteLength", value);
  const buffer = nativeGetter("buffer", value);
  if (length < 1 || length > maximumBytes || types.isSharedArrayBuffer(buffer))
    fail();
  return Buffer.from(
    new Uint8Array(buffer, nativeGetter("byteOffset", value), length),
  );
};
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  Object.getPrototypeOf(value) === Object.prototype &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());
const file = (row, path) => {
  if (
    !exactKeys(row, ["path", "type", "bytes", "mode", "sha256"]) ||
    row.path !== path ||
    row.type !== "file" ||
    ![0o600, 0o644].includes(row.mode) ||
    !Number.isSafeInteger(row.bytes) ||
    row.bytes < 0 ||
    row.bytes > maximumFileBytes ||
    typeof row.sha256 !== "string" ||
    !/^[a-f\d]{64}$/u.test(row.sha256)
  )
    fail();
  return Object.freeze({
    path,
    type: "file",
    bytes: row.bytes,
    mode: row.mode,
    sha256: row.sha256,
  });
};
const cachePath = (value) => {
  if (typeof value !== "string" || value.length > 512) fail();
  const parts = value.split("/");
  if (
    parts.length > 33 ||
    !cacheRoots.includes(parts[0]) ||
    parts.some(
      (part) =>
        !/^[A-Za-z\d@+._=-]{1,255}$/u.test(part) ||
        part === "." ||
        part === "..",
    )
  )
    fail();
  return parts;
};
const caches = (rows) => {
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > maximumEntries)
    fail();
  const paths = new Set();
  const active = [];
  const lastNames = new Map();
  const roots = [];
  let observedBytes = 0;
  const records = [];
  for (const row of rows) {
    const parts = cachePath(row?.path);
    const path = parts.join("/");
    const name = parts.at(-1);
    const parent = parts.slice(0, -1).join("/");
    if (paths.has(path)) fail();
    paths.add(path);
    while (active.length > 0 && active.at(-1) !== parent) active.pop();
    if (parent !== "" && active.at(-1) !== parent) fail();
    if (lastNames.has(parent) && lastNames.get(parent) >= name) fail();
    lastNames.set(parent, name);
    if (parent === "") roots.push(path);
    let record;
    if (row.type === "directory") {
      if (
        !exactKeys(row, ["path", "type", "mode"]) ||
        ![0o700, 0o755].includes(row.mode)
      )
        fail();
      record = Object.freeze({ path, type: "directory", mode: row.mode });
      active.push(path);
    } else {
      record = file(row, path);
      observedBytes += record.bytes;
      if (observedBytes > maximumAggregateBytes) fail();
    }
    records.push(record);
  }
  if (
    JSON.stringify(roots) !== JSON.stringify(cacheRoots) ||
    !records.some(
      (row) => row.path === "maven-repository" && row.type === "directory",
    ) ||
    !records.some((row) => row.path === "npm-cache" && row.type === "directory")
  )
    fail();
  return { records: Object.freeze(records), observedBytes };
};

/** Returns immutable data, never a prepared image, cache or execution capability. */
export const parseMockServerResearchInventory = (input) => {
  try {
    const bytes = snapshot(input);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(decoded);
    if (
      !exactKeys(value, [
        "schemaVersion",
        "evidenceScope",
        "consumedDependencyClosure",
        "caches",
        "artifact",
      ]) ||
      value.schemaVersion !== 1 ||
      value.evidenceScope !== "untrusted-cache-and-jar-research-only" ||
      value.consumedDependencyClosure !== "not-proved"
    )
      fail();
    const cache = caches(value.caches);
    const artifact = file(value.artifact, artifactPath);
    if (
      artifact.bytes < 1 ||
      cache.observedBytes + artifact.bytes > maximumAggregateBytes
    )
      fail();
    const record = Object.freeze({
      schemaVersion: 1,
      evidenceScope: "untrusted-cache-and-jar-research-only",
      consumedDependencyClosure: "not-proved",
      caches: cache.records,
      artifact,
    });
    // Producer encoding is closed: duplicates, escapes, alternate number forms,
    // whitespace, extra documents and field-order substitutions are rejected.
    if (`${JSON.stringify(record)}\n` !== decoded) fail();
    return Object.freeze({
      record,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      observedBytes: cache.observedBytes + artifact.bytes,
    });
  } catch {
    fail();
  }
};
