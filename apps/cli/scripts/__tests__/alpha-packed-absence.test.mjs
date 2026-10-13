import { describe, expect, it } from "vitest";

import { assertAlphaLocalNativeAbsent } from "../alpha-packed-absence.mjs";

describe("alpha packed Local native absence", () => {
  it("preserves required directory paths and non-native Local runtime", () => {
    expect(() =>
      assertAlphaLocalNativeAbsent([
        "dist/bin/agentscope.js",
        "dist/internal/local-sqlite-runtime/reporter-child.js",
        "dist/internal/directory-runtime/loader/owned-loader.mjs",
        "dist/internal/directory-runtime/records/support-manifest.json",
        "dist/internal/directory-runtime/native/napi8-darwin-arm64/directory.node",
        "dist/internal/directory-runtime/native/napi8-linux-x64-glibc/directory.node",
      ]),
    ).not.toThrow();
  });

  it.each([
    "dist/alternate/AGENTSCOPE_SQLITE.NODE",
    "DIST/INTERNAL/LOCAL-SQLITE/native-loader.js",
    "dist\\internal\\LOCAL-SQLITE\\native-loader.js",
    "dist/alternate/SUPPORT-MANIFEST.JSON",
    "dist/alternate/owned-loader.cjs",
    "dist/alternate/better-sqlite3.cjs",
    "dist/internal/directory-runtime/native/other/directory.node",
    "dist/internal/directory-runtime/native/napi8-darwin-arm64/DIRECTORY.NODE",
  ])("rejects excluded or undeclared native inventory %s", (file) => {
    expect(() => assertAlphaLocalNativeAbsent([file])).toThrow(
      /must not ship the proposed Local native tuple or loader/u,
    );
  });

  it("rejects malformed inventory instead of treating it as absence", () => {
    expect(() => assertAlphaLocalNativeAbsent(null)).toThrow();
    expect(() => assertAlphaLocalNativeAbsent([42])).toThrow();
  });
});
