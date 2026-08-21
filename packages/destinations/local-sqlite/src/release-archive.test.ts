import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  compileReleaseTarArchiveForTesting,
  type ReleaseArchiveManifest,
} from "./release-archive.js";

const BLOCK = 512;
const encoder = new TextEncoder();
const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const writeField = (
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
) => {
  target.set(encoder.encode(value).subarray(0, length), offset);
};

const entry = (
  path: string,
  payload: Uint8Array,
  overrides: Readonly<{ type?: number; size?: number; prefix?: string }> = {},
): Uint8Array => {
  const header = new Uint8Array(BLOCK);
  writeField(header, 0, 100, path);
  writeField(header, 100, 8, "0000600\0");
  writeField(header, 108, 8, "0000000\0");
  writeField(header, 116, 8, "0000000\0");
  writeField(
    header,
    124,
    12,
    `${(overrides.size ?? payload.length).toString(8).padStart(11, "0")}\0`,
  );
  writeField(header, 136, 12, "00000000000\0");
  header.fill(32, 148, 156);
  header[156] = overrides.type ?? 48;
  writeField(header, 257, 6, "ustar\0");
  writeField(header, 263, 2, "00");
  if (overrides.prefix) writeField(header, 345, 155, overrides.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const result = new Uint8Array(
    BLOCK + Math.ceil(payload.length / BLOCK) * BLOCK,
  );
  result.set(header);
  result.set(payload, BLOCK);
  return result;
};

const reseal = (value: Uint8Array): void => {
  value.fill(32, 148, 156);
  const checksum = value
    .subarray(0, BLOCK)
    .reduce((sum, byte) => sum + byte, 0);
  writeField(value, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
};

const archive = (...entries: Uint8Array[]): Uint8Array => {
  const size = entries.reduce((sum, value) => sum + value.length, BLOCK * 2);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const value of entries) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
};

const payload = encoder.encode("owned material");
const manifest = (
  path = "package/material.txt",
  bytes = payload.length,
): ReleaseArchiveManifest => ({
  maximumExpandedBytes: bytes,
  entries: [{ path, bytes, sha256: digest(payload) }],
});

const rejects = (
  bytes: Uint8Array,
  candidate: ReleaseArchiveManifest = manifest(),
) => {
  expect(() => compileReleaseTarArchiveForTesting(bytes, candidate)).toThrow(
    "destination.local-sqlite.release-archive-invalid",
  );
};

describe("Local SQLite inert release archive compiler", () => {
  it("compiles one exact regular-file inventory before materialization", () => {
    const result = compileReleaseTarArchiveForTesting(
      archive(entry("material.txt", payload, { prefix: "package" })),
      manifest(),
    );
    expect([...result]).toEqual([["package/material.txt", payload]]);
    const fullName = "x".repeat(100);
    expect(
      compileReleaseTarArchiveForTesting(
        archive(entry(fullName, payload)),
        manifest(fullName),
      ).get(fullName),
    ).toEqual(payload);
  });

  it("rejects malformed archive envelopes and end markers", () => {
    rejects(new Uint8Array(BLOCK));
    rejects(new Uint8Array(BLOCK * 2 + 1));
    rejects(new Uint8Array(65 * 1024 * 1024));
    rejects(archive());
    rejects(new Uint8Array(BLOCK * 3), {
      entries: [],
      maximumExpandedBytes: 0,
    });
    const trailing = new Uint8Array(
      archive(entry("package/material.txt", payload)).length + BLOCK,
    );
    trailing.set(archive(entry("package/material.txt", payload)));
    rejects(trailing);
  });

  it.each([
    "",
    "/absolute",
    "C:drive",
    "a\\b",
    "a//b",
    "a/./b",
    "a/../b",
    "a/\u0001b",
    `a/${"x".repeat(129)}`,
    Array.from({ length: 17 }, () => "a").join("/"),
    "e\u0301",
  ])("rejects noncanonical manifest paths %#", (path) => {
    rejects(archive(entry("package/material.txt", payload)), manifest(path));
  });
});

describe("Local SQLite release archive hostile evidence", () => {
  it("rejects invalid manifest bounds, hashes, duplicates, and aliases", () => {
    const base = manifest();
    for (const candidate of [
      { ...base, maximumExpandedBytes: -1 },
      { ...base, maximumExpandedBytes: 65 * 1024 * 1024 },
      { ...base, maximumExpandedBytes: 1.5 },
      { ...base, entries: [{ ...base.entries[0]!, bytes: -1 }] },
      {
        ...base,
        entries: [{ ...base.entries[0]!, bytes: 32 * 1024 * 1024 + 1 }],
      },
      { ...base, entries: [{ ...base.entries[0]!, bytes: 1.5 }] },
      { ...base, entries: [{ ...base.entries[0]!, sha256: "bad" }] },
      { ...base, entries: [base.entries[0]!, base.entries[0]!] },
      {
        ...base,
        maximumExpandedBytes: payload.length * 2,
        entries: [
          base.entries[0]!,
          { ...base.entries[0]!, path: "PACKAGE/MATERIAL.TXT" },
        ],
      },
      {
        ...base,
        entries: [
          base.entries[0]!,
          { ...base.entries[0]!, path: "package/second.txt" },
        ],
      },
      {
        ...base,
        entries: Array.from({ length: 257 }, (_, index) => ({
          path: `p/${index}`,
          bytes: 0,
          sha256: digest(new Uint8Array()),
        })),
      },
    ] as ReleaseArchiveManifest[])
      rejects(archive(entry("package/material.txt", payload)), candidate);
  });

  it("rejects hostile or mismatched tar entries", () => {
    const valid = entry("package/material.txt", payload);
    const badChecksum = valid.slice();
    badChecksum[0] = badChecksum[0]! ^ 1;
    const badPadding = entry("package/material.txt", payload);
    badPadding[BLOCK + payload.length] = 1;
    const invalidUtf8 = valid.slice();
    invalidUtf8[0] = 0xff;
    reseal(invalidUtf8);
    const invalidOctal = valid.slice();
    writeField(invalidOctal, 124, 12, "0000000000x\0");
    reseal(invalidOctal);
    const unsafeOctal = valid.slice();
    writeField(unsafeOctal, 124, 12, "77777777777\0");
    reseal(unsafeOctal);
    const hiddenNameBytes = valid.slice();
    hiddenNameBytes[21] = 1;
    reseal(hiddenNameBytes);
    const wrongMagic = valid.slice();
    wrongMagic[257] = 1;
    reseal(wrongMagic);
    const linkName = valid.slice();
    linkName[157] = 97;
    reseal(linkName);
    for (const candidate of [
      archive(badChecksum),
      archive(invalidUtf8),
      archive(invalidOctal),
      archive(unsafeOctal),
      archive(hiddenNameBytes),
      archive(wrongMagic),
      archive(linkName),
      archive(entry("package/material.txt", payload, { type: 120 })),
      archive(entry("../escape", payload)),
      archive(
        entry("package/material.txt", payload, { size: payload.length + 1 }),
      ),
      archive(badPadding),
      archive(entry("package/material.txt", encoder.encode("wrong material"))),
      archive(entry("package/extra.txt", payload)),
      archive(valid, valid),
    ])
      rejects(candidate);
    rejects(archive(valid), { maximumExpandedBytes: 0, entries: [] });
  });
});

describe("Local SQLite archive authority containment", () => {
  it("reconstructs manifest evidence once and contains hostile objects", () => {
    const accessorEntry = {
      path: "package/material.txt",
      sha256: digest(payload),
    } as Record<string, unknown>;
    Object.defineProperty(accessorEntry, "bytes", {
      enumerable: true,
      get: () => payload.length,
    });
    const extraEntry = {
      ...manifest().entries[0]!,
      extra: true,
    };
    const symbolEntry = {
      ...manifest().entries[0]!,
      [Symbol("extra")]: true,
    };
    for (const candidate of [accessorEntry, extraEntry, symbolEntry])
      rejects(archive(entry("package/material.txt", payload)), {
        maximumExpandedBytes: payload.length,
        entries: [candidate as unknown as ReleaseArchiveManifest["entries"][0]],
      });
    const sparse = new Array(1) as ReleaseArchiveManifest["entries"];
    rejects(archive(entry("package/material.txt", payload)), {
      maximumExpandedBytes: payload.length,
      entries: sparse,
    });
    const accessorArray = [manifest().entries[0]!];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => manifest().entries[0]!,
    });
    rejects(archive(entry("package/material.txt", payload)), {
      maximumExpandedBytes: payload.length,
      entries: accessorArray,
    });
    const throwing = new Proxy(manifest(), {
      ownKeys: () => {
        throw new Error("CANARY");
      },
    });
    rejects(archive(entry("package/material.txt", payload)), throwing);
    class DerivedBytes extends Uint8Array {}
    rejects(new DerivedBytes(archive(entry("package/material.txt", payload))));
  });

  it("rejects non-record manifests and noncanonical entry arrays", () => {
    const validArchive = archive(entry("package/material.txt", payload));
    for (const candidate of [null, [], Object.create(null)])
      rejects(validArchive, candidate as ReleaseArchiveManifest);
    rejects(validArchive, {
      maximumExpandedBytes: payload.length,
      entries: {} as ReleaseArchiveManifest["entries"],
    });
    const withExtra = [
      ...manifest().entries,
    ] as unknown as ReleaseArchiveManifest["entries"] & Record<string, unknown>;
    withExtra.extra = true;
    rejects(validArchive, {
      maximumExpandedBytes: payload.length,
      entries: withExtra,
    });
    const throwingArchive = new Proxy(validArchive, {
      getPrototypeOf: () => {
        throw new Error("CANARY");
      },
    });
    rejects(throwingArchive);
  });
});
