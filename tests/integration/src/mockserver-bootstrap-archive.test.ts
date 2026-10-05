import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  bootstrapArchivePins,
  verifyBootstrapArchive,
  type BootstrapArchiveKind,
} from "../mockserver-material/bootstrap-archive.mjs";

const pin = JSON.parse(
  readFileSync(
    new URL("../mockserver-material/bootstrap-pin.json", import.meta.url),
    "utf8",
  ),
) as Record<
  BootstrapArchiveKind,
  {
    archive: { bytes: number; sha256: string; verification: string };
    signature: { verification: string };
  }
>;
const kinds: readonly BootstrapArchiveKind[] = ["node", "jdk"];
const failure = "integration.mockserver-material.bootstrap-archive";

describe("exact MockServer bootstrap archive bytes", () => {
  it("binds both immutable archive byte pins without admission", () => {
    expect(Object.keys(bootstrapArchivePins).sort()).toEqual(["jdk", "node"]);
    expect(Object.isFrozen(bootstrapArchivePins)).toBe(true);
    for (const kind of kinds) {
      expect(bootstrapArchivePins[kind]).toMatchObject({
        bytes: pin[kind].archive.bytes,
        sha256: pin[kind].archive.sha256,
      });
      expect(Object.isFrozen(bootstrapArchivePins[kind])).toBe(true);
      expect(pin[kind].archive.verification).toBe("unproved");
      expect(pin[kind].signature.verification).toBe("unproved");
    }
  });

  it.each(kinds)("rejects missing and truncated %s bytes", (kind) => {
    for (const bytes of [Buffer.alloc(0), Buffer.from([1, 2, 3])])
      expect(() => verifyBootstrapArchive(kind, bytes)).toThrow(failure);
  });

  it("rejects exact-sized substitution and one excess byte", () => {
    for (const size of [
      bootstrapArchivePins.node.bytes,
      bootstrapArchivePins.node.bytes + 1,
    ])
      expect(() =>
        verifyBootstrapArchive("node", new Uint8Array(size)),
      ).toThrow(failure);
  });

  it("rejects unknown and inherited names without coercion", () => {
    let effects = 0;
    const hostile = {
      [Symbol.toPrimitive]() {
        effects += 1;
        return "node";
      },
    };
    for (const kind of ["", "maven", "constructor", "__proto__", hostile])
      expect(() =>
        verifyBootstrapArchive(kind as BootstrapArchiveKind, Buffer.alloc(0)),
      ).toThrow(failure);
    expect(effects).toBe(0);
  });

  it("rejects a byte proxy before traps", () => {
    let effects = 0;
    const bytes = new Proxy(Buffer.alloc(0), {
      get() {
        effects += 1;
        throw new Error("getter");
      },
      getPrototypeOf() {
        effects += 1;
        throw new Error("prototype");
      },
    });
    expect(() => verifyBootstrapArchive("node", bytes)).toThrow(failure);
    expect(effects).toBe(0);
  });

  it("copies intrinsic byte slots without invoking subclass hooks", () => {
    let effects = 0;
    class HostileBytes extends Uint8Array {
      override get byteLength(): number {
        effects += 1;
        throw new Error("length");
      }
      override valueOf(): this {
        effects += 1;
        throw new Error("value");
      }
    }
    expect(() => verifyBootstrapArchive("node", new HostileBytes(1))).toThrow(
      failure,
    );
    expect(effects).toBe(0);
  });
});
