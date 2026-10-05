import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { callbackSourcePin } from "../mockserver-material/callback-patch.mjs";
import { verifyMockServerSourceArchive } from "../mockserver-material/source-archive.mjs";

const pin = JSON.parse(
  readFileSync(
    new URL("../mockserver-material/source-pin.json", import.meta.url),
    "utf8",
  ),
) as {
  commit: string;
  tree: string;
  evidenceScope: string;
  archive: { bytes: number; sha256: string; url: string };
  unproved: string[];
  buildDescriptors: { path: string; blob: string }[];
};

describe("MockServer pinned source archive boundary", () => {
  it("binds the callback source to the same complete upstream source tree", () => {
    expect(pin.commit).toBe(callbackSourcePin.commit);
    expect(pin.tree).toBe(callbackSourcePin.tree);
    expect(pin.archive).toEqual({
      bytes: 31_447_709,
      sha256:
        "c364e63e1461e283a3db5d5ce4546f65070ff49b737cd71c0e3999e42f24c1b2",
      url: `https://codeload.github.com/mock-server/mockserver-monorepo/tar.gz/${callbackSourcePin.commit}`,
    });
    expect(pin.evidenceScope).toBe("source-input-only");
    expect(pin.unproved).toEqual([
      "build-tool-and-dependency-closure",
      "compiled-java",
      "runtime-control-isolation",
      "service-admission",
    ]);
  });

  it("retains the implicit frontend input, not just the Maven POMs", () => {
    expect(pin.buildDescriptors).toContainEqual(
      expect.objectContaining({
        path: "mockserver-ui/package-lock.json",
        blob: "279bf6f9cc9e0df18c400c4acc9bc21d631cd4af",
      }),
    );
    expect(pin.buildDescriptors).toContainEqual(
      expect.objectContaining({
        path: "mockserver/.mvn/wrapper/maven-wrapper.properties",
        blob: "216df0589791badf4288a0cc70d685ff5da06408",
      }),
    );
  });

  it.each([0, 31_447_708, 31_447_709, 31_447_710])(
    "rejects missing, substituted or oversized bytes (%i)",
    (length) => {
      expect(() => verifyMockServerSourceArchive(Buffer.alloc(length))).toThrow(
        "integration.mockserver-material.source-archive",
      );
    },
  );

  it("rejects caller proxies without touching properties or prototypes", () => {
    let reads = 0;
    const value = new Proxy(Buffer.alloc(1), {
      get() {
        reads += 1;
        throw new Error("getter");
      },
      getPrototypeOf() {
        reads += 1;
        throw new Error("prototype");
      },
    });
    expect(() => verifyMockServerSourceArchive(value)).toThrow(
      "integration.mockserver-material.source-archive",
    );
    expect(reads).toBe(0);
  });
});
