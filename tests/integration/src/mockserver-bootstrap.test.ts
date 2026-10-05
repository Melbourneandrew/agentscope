import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  bootstrapMetadataPins,
  verifyBootstrapMetadata,
  type BootstrapMetadataKind,
} from "../mockserver-material/bootstrap-metadata.mjs";

interface BootstrapPin {
  evidenceScope: string;
  platform: { os: string; architecture: string };
  node: {
    version: string;
    frontendPluginVersion: string;
    archive: {
      url: string;
      bytes: number;
      sha256: string;
      verification: string;
    };
    signature: { expectedPrimaryFingerprint: string; verification: string };
    publicKeyProvenance: { blob: string; verification: string };
  };
  jdk: {
    version: string;
    sourceRequirement: { compilerSource: string; compilerTarget: string };
    archive: {
      url: string;
      bytes: number;
      sha256: string;
      verification: string;
    };
    signature: { expectedPrimaryFingerprint: string; verification: string };
  };
  metadata: Record<
    BootstrapMetadataKind,
    { url: string; bytes: number; sha256: string; base64: string }
  >;
  unproved: string[];
}

const pin = JSON.parse(
  readFileSync(
    new URL("../mockserver-material/bootstrap-pin.json", import.meta.url),
    "utf8",
  ),
) as BootstrapPin;
const kinds = Object.keys(bootstrapMetadataPins) as BootstrapMetadataKind[];
const fixture = (kind: BootstrapMetadataKind): Buffer =>
  Buffer.from(pin.metadata[kind].base64, "base64");
const failure = "integration.mockserver-material.bootstrap-metadata";

describe("MockServer bootstrap metadata identity", () => {
  it.each(kinds)("authenticates and owns exact %s bytes", (kind) => {
    const input = fixture(kind);
    const owned = verifyBootstrapMetadata(kind, input);
    expect(owned).toEqual(input);
    expect(owned).not.toBe(input);
    input.fill(0);
    expect(createHash("sha256").update(owned).digest("hex")).toBe(
      bootstrapMetadataPins[kind].sha256,
    );
  });

  it.each(kinds)("rejects substituted %s metadata", (kind) => {
    const input = fixture(kind);
    input[0] = (input[0] ?? 0) ^ 1;
    expect(() => verifyBootstrapMetadata(kind, input)).toThrow(failure);
  });

  it.each(kinds)("rejects missing and oversized %s metadata", (kind) => {
    for (const size of [0, bootstrapMetadataPins[kind].bytes + 1]) {
      expect(() => verifyBootstrapMetadata(kind, Buffer.alloc(size))).toThrow(
        failure,
      );
    }
  });

  it("rejects unknown and inherited names without coercion", () => {
    let reads = 0;
    const hostile = {
      [Symbol.toPrimitive]: () => {
        reads += 1;
        return "node-key";
      },
    };
    for (const kind of ["constructor", "__proto__", "node", "", hostile]) {
      expect(() =>
        verifyBootstrapMetadata(kind as BootstrapMetadataKind, Buffer.alloc(0)),
      ).toThrow(failure);
    }
    expect(reads).toBe(0);
  });

  it("rejects a byte proxy before its traps", () => {
    let reads = 0;
    const bytes = new Proxy(fixture("node-key"), {
      get() {
        reads += 1;
        throw new Error("getter");
      },
      getPrototypeOf() {
        reads += 1;
        throw new Error("prototype");
      },
    });
    expect(() => verifyBootstrapMetadata("node-key", bytes)).toThrow(failure);
    expect(reads).toBe(0);
  });
});

describe("MockServer bootstrap input scope", () => {
  it("closes the exact metadata inventory and immutable byte pins", () => {
    expect(Object.keys(pin.metadata).sort()).toEqual([...kinds].sort());
    expect(Object.isFrozen(bootstrapMetadataPins)).toBe(true);
    for (const kind of kinds) {
      expect(Object.isFrozen(bootstrapMetadataPins[kind])).toBe(true);
      expect(pin.metadata[kind]).toMatchObject(bootstrapMetadataPins[kind]);
      expect(new URL(pin.metadata[kind].url).protocol).toBe("https:");
      expect(fixture(kind).length).toBe(bootstrapMetadataPins[kind].bytes);
    }
  });

  it("maps the Node archive to the retained signed checksum text", () => {
    const checksums = fixture("node-checksums").toString("utf8");
    const signed = fixture("node-signed-checksums").toString("utf8");
    const selected = checksums
      .trimEnd()
      .split("\n")
      .filter((line) => line.endsWith("  node-v22.14.0-linux-x64.tar.gz"));
    expect(selected).toEqual([
      `${pin.node.archive.sha256}  node-v22.14.0-linux-x64.tar.gz`,
    ]);
    expect(signed).toContain(checksums.trimEnd());
    expect(pin.node.archive.url).toBe(
      "https://nodejs.org/download/release/v22.14.0/node-v22.14.0-linux-x64.tar.gz",
    );
    expect(pin.node.archive.bytes).toBe(54_108_748);
  });

  it("binds the Node key to its exact official Git blob without signer proof", () => {
    const key = fixture("node-key");
    expect(
      createHash("sha1")
        .update(`blob ${key.length}\0`)
        .update(key)
        .digest("hex"),
    ).toBe(pin.node.publicKeyProvenance.blob);
    expect(pin.node.signature.expectedPrimaryFingerprint).toBe(
      "C0D6248439F1D5604AAFFB4021D900FFDB233756",
    );
  });

  it("maps the JDK checksum to the exact versioned release artifact", () => {
    expect(fixture("temurin-checksum").toString("utf8")).toBe(
      `${pin.jdk.archive.sha256}  OpenJDK17U-jdk_x64_linux_hotspot_17.0.20.1_1.tar.gz\n`,
    );
    expect(pin.jdk.archive.url).toBe(
      "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_linux_hotspot_17.0.20.1_1.tar.gz",
    );
    expect(pin.jdk.archive.bytes).toBe(193_252_603);
    expect(pin.jdk.signature.expectedPrimaryFingerprint).toBe(
      "3B04D753C9050D9A5D343F39843C48A565F8F04B",
    );
  });

  it("preserves upstream tool requirements and unproved executable authority", () => {
    expect(pin.platform).toEqual({ os: "linux", architecture: "x64" });
    expect(pin.node.version).toBe("22.14.0");
    expect(pin.node.frontendPluginVersion).toBe("2.0.0");
    expect(pin.jdk.version).toBe("17.0.20.1+1");
    expect(pin.jdk.sourceRequirement).toMatchObject({
      compilerSource: "17",
      compilerTarget: "17",
    });
    expect(pin.evidenceScope).toBe("bootstrap-input-only");
    expect(pin.node.archive.verification).toBe("unproved");
    expect(pin.node.signature.verification).toBe("unproved");
    expect(pin.node.publicKeyProvenance.verification).toBe("unproved");
    expect(pin.jdk.archive.verification).toBe("unproved");
    expect(pin.jdk.signature.verification).toBe("unproved");
    expect(pin.unproved).toEqual([
      "signer-policy-and-cryptographic-verification",
      "executable-archive-authentication",
      "transitive-build-dependency-closure",
      "hosted-offline-build",
      "service-admission",
    ]);
  });
});
