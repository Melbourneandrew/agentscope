import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import {
  compileArchive,
  materializeCompiledArchive,
} from "./archive-compiler.mjs";

const [targetRoot, authorityPath] = process.argv.slice(2);
assert.equal(typeof targetRoot, "string");
assert.equal(typeof authorityPath, "string");
const authority = JSON.parse(readFileSync(authorityPath, "utf8"));
assert.equal(authority.schemaVersion, 3);
const acquired = [];
for (const material of authority.materials) {
  assert.equal(material.registry, "https://registry.npmjs.org");
  const url = `${material.registry}/${material.name}/-/${material.name}-${material.version}.tgz`;
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(response.status, 200);
  assert(response.body);
  const archivePath = join(targetRoot, `${material.name}.tgz`);
  const descriptor = openSync(
    archivePath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW || 0),
    0o400,
  );
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      assert(bytes <= material.tarballBytes);
      sha256.update(chunk);
      sha512.update(chunk);
      let offset = 0;
      while (offset < chunk.length)
        offset += writeSync(descriptor, chunk, offset, chunk.length - offset);
    }
  } finally {
    closeSync(descriptor);
  }
  assert.equal(bytes, material.tarballBytes);
  assert.equal(sha256.digest("hex"), material.tarballSha256);
  assert.equal(`sha512-${sha512.digest("base64")}`, material.tarballIntegrity);
  const compiled = compileArchive(readFileSync(archivePath), material.entries);
  const target = join(targetRoot, `${material.name}-compiled`);
  mkdirSync(target, { mode: 0o700 });
  materializeCompiledArchive(compiled, target);
  acquired.push(
    Object.freeze({
      name: material.name,
      archiveBytes: bytes,
      archiveSha256: material.tarballSha256,
      compiledEntries: compiled.files.size,
      expandedBytes: compiled.expandedBytes,
    }),
  );
}
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, acquired })}\n`);
