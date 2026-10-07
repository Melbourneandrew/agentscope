import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  mavenArchivePin,
  verifyMavenArchiveBytes,
} from "../mockserver-material/build-tool-archive.mjs";

const pin = JSON.parse(
  readFileSync(
    new URL("../mockserver-material/build-tool-pin.json", import.meta.url),
    "utf8",
  ),
) as {
  evidenceScope: string;
  maven: {
    version: string;
    archive: typeof mavenArchivePin & { url: string };
    signature: { verification: string; parsedIssuerFingerprint: string };
    publicKeyMetadata: { verification: string };
  };
  unproved: string[];
};

describe("MockServer Maven archive input", () => {
  it("binds exact published bytes without promoting metadata to signer proof", () => {
    expect(pin.maven.version).toBe("3.9.16");
    expect(pin.maven.archive).toEqual({
      ...mavenArchivePin,
      url: "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.16/apache-maven-3.9.16-bin.zip",
    });
    expect(Object.isFrozen(mavenArchivePin)).toBe(true);
    expect(pin.evidenceScope).toBe("build-tool-input-only");
    expect(pin.maven.signature.verification).toBe("unproved");
    expect(pin.maven.publicKeyMetadata.verification).toBe("unproved");
    expect(pin.unproved).toEqual([
      "signer-policy-and-cryptographic-verification",
      "jdk-and-frontend-tool-inputs",
      "transitive-build-dependency-closure",
      "offline-build",
      "service-admission",
    ]);
  });

  it.each([0, 9_395_474, 9_395_475, 9_395_476])(
    "rejects missing, substituted or oversized bytes (%i)",
    (size) => {
      expect(() => verifyMavenArchiveBytes(Buffer.alloc(size))).toThrow(
        "integration.mockserver-material.build-tool-archive",
      );
    },
  );

  it("rejects proxies without evaluating caller traps", () => {
    let reads = 0;
    const bytes = new Proxy(Buffer.alloc(1), {
      get() {
        reads += 1;
        throw new Error("getter");
      },
      getPrototypeOf() {
        reads += 1;
        throw new Error("prototype");
      },
    });
    expect(() => verifyMavenArchiveBytes(bytes)).toThrow(
      "integration.mockserver-material.build-tool-archive",
    );
    expect(reads).toBe(0);
  });
});
