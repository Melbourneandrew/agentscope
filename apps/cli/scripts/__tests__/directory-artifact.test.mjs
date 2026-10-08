import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";

const fixtureArtifact = vi.hoisted(() => ({ value: undefined }));
vi.mock(
  "../../../../packages/harnesses/core/native-directory/verify-artifact.mjs",
  () => ({
    verifyDirectoryArtifact: async () => fixtureArtifact.value,
  }),
);
import { verifyInstalledNativeArtifacts } from "../directory-artifact.mjs";

const roots = [];
const paths = [
  "loader/owned-loader.mjs",
  "records/support-manifest.json",
  "native/napi8-darwin-arm64/directory.node",
  "native/napi8-linux-x64-glibc/directory.node",
];
function put(root, path, bytes) {
  const parts = path.split("/");
  mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}
function regularFiles(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? regularFiles(root, path) : [path];
    })
    .sort();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentscope-directory-pack-"));
  roots.push(root);
  const original = join(root, "original");
  const installed = join(root, "installed");
  const directory = join(installed, "dist/internal/directory-runtime");
  for (const path of paths) {
    put(original, path, `synthetic-inert-${path}`);
    put(directory, path, readFileSync(join(original, path)));
  }
  put(
    installed,
    "dist/bin/agentscope.js",
    '"../internal/directory-runtime/loader/owned-loader.mjs"',
  );
  put(
    installed,
    "dist/internal/agentscope-product-harness-installation.js",
    "synthetic planner",
  );
  fixtureArtifact.value = { root: pathToFileURL(`${original}/`), paths };
  return { installed, directory };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("exact directory-only native closure remains required without Local files", async () => {
  const f = fixture();
  expect(
    await verifyInstalledNativeArtifacts(f.installed, regularFiles),
  ).toEqual([
    "dist/internal/directory-runtime/native/napi8-darwin-arm64/directory.node",
    "dist/internal/directory-runtime/native/napi8-linux-x64-glibc/directory.node",
  ]);
});
test.each(["missing", "extra", "binary", "manifest", "relocation"])(
  "directory %s drift refuses despite Local absence",
  async (kind) => {
    const f = fixture();
    if (kind === "missing") unlinkSync(join(f.directory, paths[2]));
    if (kind === "extra") put(f.directory, "native/extra.node", "synthetic");
    if (kind === "binary") put(f.directory, paths[2], "substituted");
    if (kind === "manifest") put(f.directory, paths[1], "substituted");
    if (kind === "relocation")
      put(
        f.installed,
        "dist/bin/agentscope.js",
        '"./directory-runtime/loader/owned-loader.mjs"',
      );
    await expect(
      verifyInstalledNativeArtifacts(f.installed, regularFiles),
    ).rejects.toThrow();
  },
);
