import assert from "node:assert/strict";

// This exception is only inventory classification. The existing directory
// artifact verifier still authenticates the exact closure and every byte.
const directoryNativePaths = new Set([
  "dist/internal/directory-runtime/native/napi8-darwin-arm64/directory.node",
  "dist/internal/directory-runtime/native/napi8-linux-x64-glibc/directory.node",
]);
const directoryManifestPath =
  "dist/internal/directory-runtime/records/support-manifest.json";

export function assertAlphaLocalNativeAbsent(installedFiles) {
  assert(Array.isArray(installedFiles), "Packed inventory must be a file list");
  const forbidden = installedFiles.filter((file) => {
    assert.equal(typeof file, "string", "Packed inventory path must be text");
    const normalized = file.replaceAll("\\", "/");
    const folded = normalized.toLowerCase();
    const segments = folded.split("/");
    return (
      (folded.endsWith(".node") && !directoryNativePaths.has(normalized)) ||
      segments.includes("local-sqlite") ||
      (segments.includes("support-manifest.json") &&
        normalized !== directoryManifestPath) ||
      segments.includes("owned-loader.cjs") ||
      segments.includes("better-sqlite3.cjs")
    );
  });
  assert.deepEqual(
    forbidden,
    [],
    "the alpha package must not ship the proposed Local native tuple or loader",
  );
}
