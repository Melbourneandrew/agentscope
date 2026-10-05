import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inventoryMockServerSupplier } from "../mockserver-material/supplier-inventory.mjs";
import { parseMockServerResearchInventory } from "../mockserver-material/research-inventory.mjs";

const roots: string[] = [];
const artifact =
  "source/mockserver/mockserver-netty/target/mockserver-netty-7.6.0-jar-with-dependencies.jar";
const hash = "a".repeat(64);
type MutableInventory = {
  schemaVersion: number;
  evidenceScope: string;
  consumedDependencyClosure: string;
  caches: Record<string, unknown>[];
  artifact: Record<string, unknown>;
};
const row = (path: string, bytes = 1): Record<string, unknown> => ({
  path,
  type: "file",
  bytes,
  mode: 0o644,
  sha256: hash,
});
const fixture = (): MutableInventory => ({
  schemaVersion: 1,
  evidenceScope: "untrusted-cache-and-jar-research-only",
  consumedDependencyClosure: "not-proved",
  caches: [
    { path: "maven-repository", type: "directory", mode: 0o700 },
    row("maven-repository/a.jar"),
    { path: "npm-cache", type: "directory", mode: 0o755 },
    row("npm-cache/a"),
  ],
  artifact: row(artifact),
});
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const reject = (value: unknown) => {
  expect(() => parseMockServerResearchInventory(encode(value))).toThrow(
    "research-inventory",
  );
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("untrusted supplier research inventory boundary", () => {
  it("accepts bytes from the actual bounded producer, not a replacement oracle", () => {
    const root = mkdtempSync(
      resolve(tmpdir(), "agentscope-research-inventory-"),
    );
    roots.push(root);
    for (const path of [
      "maven-repository/org/example",
      "npm-cache/_cacache",
      "source/mockserver/mockserver-netty/target",
    ])
      mkdirSync(resolve(root, path), { recursive: true, mode: 0o700 });
    for (const path of [
      "maven-repository/org/example/a.jar",
      "npm-cache/_cacache/a",
      artifact,
    ])
      writeFileSync(resolve(root, path), "synthetic", { mode: 0o644 });
    const bytes = inventoryMockServerSupplier(root);
    const parsed = parseMockServerResearchInventory(bytes);
    expect(parsed.bytes).toBe(bytes.length);
    expect(parsed.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(parsed.observedBytes).toBe(27);
    expect(parsed.record.evidenceScope).toBe(
      "untrusted-cache-and-jar-research-only",
    );
    expect(parsed.record.consumedDependencyClosure).toBe("not-proved");
    expect(encode(parsed.record)).toEqual(bytes);
  });
  it("snapshots bytes and freezes the complete returned observation graph", () => {
    const bytes = encode(fixture());
    const parsed = parseMockServerResearchInventory(bytes);
    bytes.fill(0);
    expect(parsed.record.artifact.sha256).toBe(hash);
    for (const value of [
      parsed,
      parsed.record,
      parsed.record.artifact,
      parsed.record.caches,
      ...parsed.record.caches,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(parsed.record.artifact, "sha256", "b".repeat(64))).toBe(
      false,
    );
  });
  it("uses native view boundaries rather than caller-owned buffer getters", () => {
    const original = encode(fixture());
    const framed = Buffer.concat([
      Buffer.from("ignore"),
      original,
      Buffer.from("ignore"),
    ]);
    const input = framed.subarray(6, 6 + original.length);
    let reads = 0;
    for (const key of [
      "byteLength",
      "byteOffset",
      "buffer",
      "length",
      "toString",
    ])
      Object.defineProperty(input, key, {
        get: () => {
          reads += 1;
          throw Error("must-not-read");
        },
      });
    expect(parseMockServerResearchInventory(input).bytes).toBe(original.length);
    expect(reads).toBe(0);
  });
  it("rejects proxy, forged and shared byte stores without accessor evaluation", () => {
    const bytes = encode(fixture());
    let reads = 0;
    const proxy = new Proxy(bytes, {
      get: () => {
        reads += 1;
        throw Error("must-not-read");
      },
    });
    const prototype: unknown = Buffer.prototype;
    const forged: unknown = Object.create(prototype as object);
    for (const input of [
      proxy,
      forged,
      Buffer.from(new SharedArrayBuffer(bytes.length)),
    ])
      expect(() => parseMockServerResearchInventory(input as Buffer)).toThrow(
        "research-inventory",
      );
    expect(reads).toBe(0);
  });
  it.each([
    Buffer.alloc(0),
    Buffer.alloc(8 * 1024 * 1024 + 1),
    Buffer.from([0xff]),
    Buffer.from("{"),
  ])("rejects bounded byte/UTF-8/JSON failure %#", (bytes) => {
    expect(() => parseMockServerResearchInventory(bytes)).toThrow(
      "research-inventory",
    );
  });
});

describe("canonical supplier research claims and metadata", () => {
  it("rejects duplicate keys, alternate escapes/numbers, whitespace and trailing documents", () => {
    const text = encode(fixture()).toString();
    for (const changed of [
      text.replace('"schemaVersion":1', '"schemaVersion":2,"schemaVersion":1'),
      text.replace('"schemaVersion":1', '"schemaVersion":1e0'),
      text.replace('"maven-repository"', '"maven-\\u0072epository"'),
      ` ${text}`,
      `${text}{}\n`,
      text.trimEnd(),
    ])
      expect(() =>
        parseMockServerResearchInventory(Buffer.from(changed)),
      ).toThrow("research-inventory");
  });
  it.each(["schema", "scope", "closure", "extra", "missing", "artifact"])(
    "rejects root/claim mismatch %s",
    (kind) => {
      const value = fixture();
      if (kind === "schema") value.schemaVersion = 2;
      if (kind === "scope") value.evidenceScope = "authenticated-dependencies";
      if (kind === "closure") value.consumedDependencyClosure = "proved";
      if (kind === "extra") Object.assign(value, { authority: true });
      if (kind === "missing") Reflect.deleteProperty(value, "caches");
      if (kind === "artifact") value.artifact.path = "different.jar";
      reject(value);
    },
  );
  it.each([
    "mode",
    "negative",
    "fraction",
    "oversize",
    "hash",
    "type",
    "empty",
    "extra",
  ])("rejects artifact metadata %s", (kind) => {
    const value = fixture();
    if (kind === "mode") value.artifact.mode = 0o755;
    if (kind === "negative") value.artifact.bytes = -1;
    if (kind === "fraction") value.artifact.bytes = 0.5;
    if (kind === "oversize") value.artifact.bytes = 256 * 1024 * 1024 + 1;
    if (kind === "hash") value.artifact.sha256 = "A".repeat(64);
    if (kind === "type") value.artifact.type = "symlink";
    if (kind === "empty") value.artifact.bytes = 0;
    if (kind === "extra") value.artifact.owner = 0;
    reject(value);
  });
  it.each([
    "/npm-cache/a",
    "npm-cache/../a",
    "npm-cache//a",
    "npm-cache/./a",
    "npm-cache/a\\b",
    "outside/a",
    `npm-cache/${"a".repeat(256)}`,
    `npm-cache/${"a/".repeat(33)}a`,
  ])("rejects escaping/noncanonical path %#", (path) => {
    const value = fixture();
    value.caches[3]!.path = path;
    reject(value);
  });
});

describe("supplier research tree and aggregate bounds", () => {
  it("rejects duplicate, absent-parent, completed-subtree and unsorted sibling records", () => {
    const value = fixture();
    for (const rows of [
      [...value.caches, row("npm-cache/a")],
      [
        value.caches[0],
        row("maven-repository/missing/a"),
        ...value.caches.slice(2),
      ],
      [
        value.caches[0],
        { path: "maven-repository/a", type: "directory", mode: 0o700 },
        row("maven-repository/b"),
        row("maven-repository/a/x"),
        ...value.caches.slice(2),
      ],
      [
        value.caches[0],
        row("maven-repository/z"),
        row("maven-repository/a"),
        ...value.caches.slice(2),
      ],
      [...value.caches.slice(2), ...value.caches.slice(0, 2)],
    ])
      reject({ ...value, caches: rows });
  });
  it("requires both roots as directories and closed directory records", () => {
    const value = fixture();
    for (const rows of [
      value.caches.slice(0, 2),
      [],
      [row("maven-repository"), ...value.caches.slice(1)],
      [{ ...value.caches[0], mode: 0o777 }, ...value.caches.slice(1)],
      [{ ...value.caches[0], bytes: 0 }, ...value.caches.slice(1)],
    ])
      reject({ ...value, caches: rows });
  });
  it("bounds count before traversal and includes the JAR in aggregate bytes", () => {
    const value = fixture();
    reject({
      ...value,
      caches: Array.from({ length: 16_385 }, () => value.caches[0]),
    });
    const files = Array.from({ length: 4 }, (_, index) =>
      row(`maven-repository/f${index}`, 256 * 1024 * 1024),
    );
    const caches = [value.caches[0], ...files, value.caches[2]];
    reject({ ...value, caches });
    files[3]!.bytes = 256 * 1024 * 1024 - 1;
    expect(
      parseMockServerResearchInventory(encode({ ...value, caches }))
        .observedBytes,
    ).toBe(1024 * 1024 * 1024);
  });
});
