/** Private build composition of existing SQLite and Core-owned directory assets. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, open, realpath } from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDirectoryArtifact } from "../../../packages/harnesses/core/native-directory/verify-artifact.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const relocateDirectoryLoader = (source) => {
  const original =
    'const ownedLoaderPath = "./directory-runtime/loader/owned-loader.mjs";';
  assert.equal(typeof source, "string");
  assert.equal(source.split(original).length, 2);
  assert.equal(source.split("await import(ownedLoaderPath)").length, 2);
  return source.replace(
    original,
    'const ownedLoaderPath = "../internal/directory-runtime/loader/owned-loader.mjs";',
  );
};

const compiledModuleIdentity = (stat) =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(
    ":",
  );
const compiledDirectorySource = async (path) => {
  assert.equal(await realpath(path), path);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    assert(before.isFile() && before.size > 0n && before.size <= 1_048_576n);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
      );
      assert(bytesRead > 0);
      offset += bytesRead;
    }
    assert.equal((await handle.read(Buffer.alloc(1), 0, 1)).bytesRead, 0);
    const identity = compiledModuleIdentity(before);
    assert.equal(
      compiledModuleIdentity(await handle.stat({ bigint: true })),
      identity,
    );
    assert.equal(
      compiledModuleIdentity(await lstat(path, { bigint: true })),
      identity,
    );
    return {
      identity,
      digest: digest(bytes),
      source: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } finally {
    await handle.close();
  }
};

/** Only the bin bundle relocates this one Core module beside the same closure. */
export const directoryLoaderBinPlugin = async () => {
  const path = fileURLToPath(
    new URL(
      "../../../packages/harnesses/core/dist/installation-directory-preimages.js",
      import.meta.url,
    ),
  );
  const expected = await compiledDirectorySource(path);
  relocateDirectoryLoader(expected.source);
  // esbuild forwards flags to Go's regexp engine, which has no JS "u" flag.
  const filter = new RegExp(
    `^${path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
  );
  return {
    name: "owned-directory-loader-bin-location",
    setup(build) {
      build.onLoad({ filter }, async (input) => {
        assert.equal(input.path, path);
        const current = await compiledDirectorySource(path);
        assert.equal(current.identity, expected.identity);
        assert.equal(current.digest, expected.digest);
        return {
          contents: relocateDirectoryLoader(current.source),
          loader: "js",
          resolveDir: fileURLToPath(
            new URL("../../../packages/harnesses/core/dist/", import.meta.url),
          ),
        };
      });
    },
  };
};

export const stageDirectoryArtifact = async () => {
  const source = await verifyDirectoryArtifact();
  const built = await verifyDirectoryArtifact(true);
  assert.equal(built.digest, source.digest);
  await cp(
    built.root,
    new URL("../dist/internal/directory-runtime/", import.meta.url),
    {
      recursive: true,
      force: false,
      errorOnExist: true,
    },
  );
  return Object.freeze({ digest: built.digest, paths: built.paths });
};

export const verifyInstalledNativeArtifacts = async (
  installedRoot,
  regularFiles,
) => {
  const candidateRoot = join(installedRoot, "dist/internal/local-sqlite");
  const supportManifestBytes = readFileSync(
    join(candidateRoot, "records/support-manifest.json"),
  );
  assert.equal(
    digest(supportManifestBytes),
    "587e01fac592f3989b05d634fd8a5a03f1d72bebef3c83da0a22b0ca18d1ff76",
  );
  const supportManifest = JSON.parse(supportManifestBytes);
  assert.equal(
    supportManifest.disposition,
    "proposed-unpublished-execution-eligible",
  );
  assert.equal(supportManifest.nativeBinaries.length, 1);
  assert.equal(supportManifest.supportedPlatforms.length, 1);
  const declaredCandidateFiles = supportManifest.artifactFiles
    .map(({ relativePath }) => relativePath)
    .concat("records/support-manifest.json")
    .sort();
  assert.deepEqual(regularFiles(candidateRoot), declaredCandidateFiles);
  for (const artifact of supportManifest.artifactFiles) {
    const bytes = readFileSync(join(candidateRoot, artifact.relativePath));
    assert.equal(bytes.length, artifact.bytes);
    assert.equal(`sha256:${digest(bytes)}`, artifact.digest);
  }

  const directory = await verifyDirectoryArtifact(true);
  const directoryRoot = join(installedRoot, "dist/internal/directory-runtime");
  const bin = readFileSync(
    join(installedRoot, "dist/bin/agentscope.js"),
    "utf8",
  );
  assert(
    bin.includes('"../internal/directory-runtime/loader/owned-loader.mjs"'),
  );
  assert(!bin.includes('"./directory-runtime/loader/owned-loader.mjs"'));
  const planner = readFileSync(
    join(
      installedRoot,
      "dist/internal/agentscope-product-harness-installation.js",
    ),
    "utf8",
  );
  assert(!planner.includes("owned-loader.mjs"));
  assert.deepEqual(regularFiles(directoryRoot), [...directory.paths].sort());
  for (const path of directory.paths) {
    const installed = readFileSync(join(directoryRoot, path));
    const original = readFileSync(new URL(path, directory.root));
    assert.equal(installed.length, original.length);
    assert.equal(digest(installed), digest(original));
  }
  const sqliteNative =
    "dist/internal/local-sqlite/native/node127-linux-x64-glibc/agentscope_sqlite.node";
  const directoryNative = directory.paths
    .filter((path) => path.endsWith(".node"))
    .map((path) => `dist/internal/directory-runtime/${path}`);
  const permittedNative = [sqliteNative, ...directoryNative].sort();
  assert.equal(new Set(permittedNative).size, permittedNative.length);
  return Object.freeze(permittedNative);
};
