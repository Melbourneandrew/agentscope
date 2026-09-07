import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  installPackageClosure,
  verifyInstalledPackageClosure,
  verifyPackageDirectory,
} from "./acquire-pty-toolchain.mjs";

const packageRoot = resolve(import.meta.dirname, "..");
const policy = JSON.parse(
  readFileSync(resolve(packageRoot, "pty-runtime-policy.json"), "utf8"),
);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonicalPatchSource = "a/src/unix/pty.cc";
const canonicalPatchDestination = "b/src/unix/pty.cc";
const maximumSourceBytes = 64 * 1024;
const maximumPatchBytes = 40 * 1024;
const maximumPatchLines = 2_048;
const maximumPatchLineBytes = 2_048;
const maximumPatchOperations = 4_096;
const patchedSourceSha256 =
  "7f0a15d54a4fdcc1e2fab2663e6cad0fac1011e331a1df998141560b5a9be4d6";

// One closed parser keeps every header, position, operation, count and final
// digest check in the same no-fuzz authority.
// eslint-disable-next-line complexity
export const applyExactPtyPatch = (source, patch) => {
  if (
    typeof source !== "string" ||
    typeof patch !== "string" ||
    Buffer.byteLength(source) > maximumSourceBytes ||
    Buffer.byteLength(patch) > maximumPatchBytes ||
    !source.endsWith("\n") ||
    !patch.endsWith("\n")
  )
    throw new Error("PTY patch input is malformed or exceeds its byte bound.");
  const sourceLines = source.slice(0, -1).split("\n");
  const patchLines = patch.slice(0, -1).split("\n");
  if (
    sourceLines.length > maximumPatchLines ||
    patchLines.length > maximumPatchLines ||
    [...sourceLines, ...patchLines].some(
      (line) => Buffer.byteLength(line) > maximumPatchLineBytes,
    )
  )
    throw new Error("PTY patch line authority is not bounded.");
  let patchIndex = 0;
  if (
    patchLines[patchIndex++] !== `--- ${canonicalPatchSource}` ||
    patchLines[patchIndex++] !== `+++ ${canonicalPatchDestination}`
  )
    throw new Error("PTY patch paths are not exact.");
  const output = [];
  let sourceIndex = 0;
  let hunkCount = 0;
  let operationCount = 0;
  while (patchIndex < patchLines.length) {
    const header = patchLines[patchIndex++];
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/u.exec(
      header ?? "",
    );
    if (match === null) throw new Error("PTY patch hunk header is malformed.");
    const oldStart = Number(match[1]);
    const oldCount = Number(match[2] ?? 1);
    const newStart = Number(match[3]);
    const newCount = Number(match[4] ?? 1);
    const targetSourceIndex = oldCount === 0 ? oldStart : oldStart - 1;
    if (
      !Number.isSafeInteger(oldStart) ||
      !Number.isSafeInteger(oldCount) ||
      !Number.isSafeInteger(newStart) ||
      !Number.isSafeInteger(newCount) ||
      oldStart < 1 ||
      newStart !==
        output.length +
          (newCount === 0 ? 0 : 1) +
          (targetSourceIndex - sourceIndex) ||
      targetSourceIndex < sourceIndex ||
      targetSourceIndex > sourceLines.length
    ) {
      throw new Error("PTY patch hunk position is not exact.");
    }
    output.push(...sourceLines.slice(sourceIndex, targetSourceIndex));
    sourceIndex = targetSourceIndex;
    let consumed = 0;
    let produced = 0;
    while (
      patchIndex < patchLines.length &&
      !patchLines[patchIndex].startsWith("@@ ")
    ) {
      const line = patchLines[patchIndex++];
      operationCount += 1;
      if (operationCount > maximumPatchOperations)
        throw new Error("PTY patch operation inventory is not bounded.");
      // Stored blank context lines omit the otherwise trailing unified-diff
      // prefix so the repository remains whitespace-clean.
      const operation = line === "" ? " " : line?.[0];
      const contents = line === "" ? "" : line?.slice(1);
      if (
        contents === undefined ||
        (operation !== " " && operation !== "+" && operation !== "-")
      )
        throw new Error("PTY patch operation is unsupported.");
      if (operation !== "+") {
        if (sourceLines[sourceIndex] !== contents)
          throw new Error("PTY patch context does not match exact source.");
        sourceIndex += 1;
        consumed += 1;
      }
      if (operation !== "-") {
        output.push(contents);
        produced += 1;
      }
      if (consumed > oldCount || produced > newCount)
        throw new Error("PTY patch hunk counts are malformed.");
      if (consumed === oldCount && produced === newCount) break;
    }
    if (consumed !== oldCount || produced !== newCount)
      throw new Error("PTY patch hunk is incomplete.");
    hunkCount += 1;
  }
  if (hunkCount !== 63 || patchIndex !== patchLines.length)
    throw new Error("PTY patch hunk inventory is not exact.");
  output.push(...sourceLines.slice(sourceIndex));
  const result = `${output.join("\n")}\n`;
  if (sha256(result) !== patchedSourceSha256)
    throw new Error("PTY patched source identity is not exact.");
  return result;
};

const verifyRegularFile = (
  path,
  expected,
  expectedMode = 0o644,
  maximumBytes = 2 * 1024 * 1024,
) => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.size > maximumBytes ||
      (stat.mode & 0o777) !== expectedMode ||
      stat.size < 1
    )
      throw new Error(`PTY build input identity mismatch: ${path}`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      sha256(bytes) !== expected
    )
      throw new Error(`PTY build input identity mismatch: ${path}`);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
};

const collectFiles = (root, directory = root) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(root, path);
    if (!entry.isFile())
      throw new Error(`PTY Node header inventory is not regular: ${path}`);
    return [path];
  });

const inventorySha256 = (root) => {
  const lines = collectFiles(root)
    .map((path) => `${sha256(readFileSync(path))}  ${path}`)
    .sort();
  return sha256(`${lines.join("\n")}\n`);
};

const verifyExactTreeCopy = (sourceRoot, destinationRoot) => {
  const sourceFiles = collectFiles(sourceRoot).map((path) =>
    path.slice(sourceRoot.length + 1),
  );
  const destinationFiles = collectFiles(destinationRoot).map((path) =>
    path.slice(destinationRoot.length + 1),
  );
  if (
    JSON.stringify(sourceFiles.sort()) !==
    JSON.stringify(destinationFiles.sort())
  )
    throw new Error("PTY copied Node header inventory is not exact.");
  for (const path of sourceFiles) {
    const source = resolve(sourceRoot, path);
    const destination = resolve(destinationRoot, path);
    const sourceStat = lstatSync(source);
    const destinationStat = lstatSync(destination);
    if (
      sourceStat.isSymbolicLink() ||
      destinationStat.isSymbolicLink() ||
      (sourceStat.mode & 0o777) !== (destinationStat.mode & 0o777) ||
      sha256(readFileSync(source)) !== sha256(readFileSync(destination))
    )
      throw new Error(`PTY copied Node header changed: ${path}`);
  }
};

const verifyExecutable = (path, expected) => {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    const bytes = readFileSync(descriptor);
    if (
      !stat.isFile() ||
      (stat.mode & 0o111) === 0 ||
      sha256(bytes) !== expected
    )
      throw new Error(`PTY compiler identity mismatch: ${path}`);
  } finally {
    closeSync(descriptor);
  }
};

export const stageBuiltRuntime = (source, destination) => {
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  chmodSync(destination, 0o644);
  const stat = lstatSync(destination);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o644)
    throw new Error("PTY build output mode is not exact.");
};

export const createPrivateBuildTemp = (toolchainRoot) => {
  const temporary = resolve(toolchainRoot, "tmp");
  mkdirSync(temporary, { mode: 0o700 });
  chmodSync(temporary, 0o700);
  const stat = lstatSync(temporary);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error("PTY compiler temporary root is not private.");
  return temporary;
};

export const verifyCanonicalBuildPaths = ({ output, sourceRoot }) => {
  const source = resolve(sourceRoot, "node-pty", "src", "unix", "pty.cc");
  const patch = resolve(
    sourceRoot,
    "node-pty",
    "patches",
    "agentscope-terminal-authority.patch",
  );
  const addonApi = resolve(sourceRoot, "node-addon-api");
  const destination = resolve(output, "pty.node");
  if (
    source !== "/build/node-pty/src/unix/pty.cc" ||
    addonApi !== "/build/node-addon-api"
  )
    throw new Error("PTY runtime sources are not at canonical build paths.");
  if (destination !== "/output/pty.node")
    throw new Error("PTY runtime output is not at the canonical build path.");
  if (patch !== "/build/node-pty/patches/agentscope-terminal-authority.patch")
    throw new Error("PTY runtime patch is not at the canonical build path.");
  return Object.freeze({ addonApi, destination, patch, source });
};

const prepareToolchainRoot = ({
  addonApi,
  archiveRoot,
  authorityRoot,
  patch,
  patchedSource,
  toolchainRoot,
}) => {
  const packageSets = verifyPackageDirectory({
    directory: archiveRoot,
    indexPath: resolve(authorityRoot, "APKINDEX.tar.gz"),
    keyPath: resolve(authorityRoot, "signer.rsa.pub"),
  });
  verifyExecutable("/bin/busybox", policy.build.busyboxSha256);
  installPackageClosure(packageSets, toolchainRoot);
  mkdirSync(resolve(toolchainRoot, "bin"), { mode: 0o755, recursive: true });
  copyFileSync("/bin/busybox", resolve(toolchainRoot, "bin/busybox"));
  chmodSync(resolve(toolchainRoot, "bin/busybox"), 0o755);
  symlinkSync("busybox", resolve(toolchainRoot, "bin/sh"));
  cpSync(
    "/usr/local/include/node",
    resolve(toolchainRoot, "usr/local/include/node"),
    { errorOnExist: true, recursive: true },
  );
  verifyExactTreeCopy(
    "/usr/local/include/node",
    resolve(toolchainRoot, "usr/local/include/node"),
  );
  mkdirSync(resolve(toolchainRoot, "build/node-pty/src/unix"), {
    mode: 0o755,
    recursive: true,
  });
  mkdirSync(resolve(toolchainRoot, "build/node-pty/patches"), {
    mode: 0o755,
  });
  mkdirSync(resolve(toolchainRoot, "build/node-addon-api"), {
    mode: 0o755,
    recursive: true,
  });
  mkdirSync(resolve(toolchainRoot, "output"), { mode: 0o700 });
  createPrivateBuildTemp(toolchainRoot);
  writeFileSync(
    resolve(toolchainRoot, "build/node-pty/src/unix/pty.cc"),
    patchedSource,
    { flag: "wx", mode: 0o644 },
  );
  for (const [sourcePath, destinationPath] of [
    [
      patch,
      resolve(
        toolchainRoot,
        "build/node-pty/patches/agentscope-terminal-authority.patch",
      ),
    ],
    [
      resolve(addonApi, "napi.h"),
      resolve(toolchainRoot, "build/node-addon-api/napi.h"),
    ],
    [
      resolve(addonApi, "napi-inl.h"),
      resolve(toolchainRoot, "build/node-addon-api/napi-inl.h"),
    ],
  ]) {
    copyFileSync(sourcePath, destinationPath);
    chmodSync(destinationPath, 0o644);
  }
  verifyInstalledPackageClosure(packageSets, toolchainRoot);
};

export const buildPtyRuntime = ({
  authorityRoot = "/authority",
  output,
  packageRoot: archiveRoot = "/packages",
  sourceRoot,
  testFaults = false,
  toolchainRoot = "/toolchain",
}) => {
  if (typeof testFaults !== "boolean")
    throw new Error("PTY test-fault build selection is invalid.");
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    process.versions.modules !== "127"
  )
    throw new Error("PTY runtime build host is not node127-linux-x64.");
  if (readFileSync("/etc/alpine-release", "utf8").trim() !== "3.24.1")
    throw new Error("PTY runtime build host is not Alpine 3.24.1.");
  if (
    inventorySha256("/usr/local/include/node") !==
    policy.canonicalImage.nodeHeaderInventorySha256
  )
    throw new Error("PTY Node header inventory is not exact.");
  const outputStat = lstatSync(output);
  if (
    outputStat.isSymbolicLink() ||
    !outputStat.isDirectory() ||
    (outputStat.mode & 0o077) !== 0
  )
    throw new Error("PTY runtime output root is not a directory.");
  const { addonApi, destination, patch, source } = verifyCanonicalBuildPaths({
    output,
    sourceRoot,
  });
  const sourceBytes = verifyRegularFile(
    source,
    "5809f87b15122f335017b0b3020071df4c6205c7827186a2c5a9e0edc9ef59b2",
    0o644,
    maximumSourceBytes,
  );
  const patchBytes = verifyRegularFile(
    patch,
    "f7ebb2b3dc74e84035b78feaa66263b3a455da499e5f129c8eaa70ede429789e",
    0o644,
    maximumPatchBytes,
  );
  const patchedSource = applyExactPtyPatch(
    sourceBytes.toString("utf8"),
    patchBytes.toString("utf8"),
  );
  verifyRegularFile(
    resolve(addonApi, "napi.h"),
    "2f2f5d1e4ca96f315c51ad96c292c18294dbb999b98f8b2f33b80816a3189fb0",
  );
  verifyRegularFile(
    resolve(addonApi, "napi-inl.h"),
    "4b053c184dfed740fbd802fdcf97e85fb8c7b0eb1d83322000d932d31662eda7",
  );
  prepareToolchainRoot({
    addonApi,
    archiveRoot,
    authorityRoot,
    patch,
    patchedSource,
    toolchainRoot,
  });
  verifyRegularFile(
    resolve(toolchainRoot, "build/node-pty/src/unix/pty.cc"),
    "7f0a15d54a4fdcc1e2fab2663e6cad0fac1011e331a1df998141560b5a9be4d6",
  );
  verifyExecutable(
    resolve(toolchainRoot, "usr/bin/g++"),
    policy.build.gxxSha256,
  );
  verifyExecutable(
    resolve(
      toolchainRoot,
      "usr/libexec/gcc/x86_64-alpine-linux-musl/15.2.0/cc1plus",
    ),
    policy.build.cc1plusSha256,
  );
  verifyExecutable(
    resolve(toolchainRoot, "usr/bin/as"),
    policy.build.assemblerSha256,
  );
  verifyExecutable(
    resolve(toolchainRoot, "usr/bin/ld"),
    policy.build.linkerSha256,
  );
  const arguments_ = [...policy.build.arguments];
  if (testFaults) arguments_.splice(-5, 0, "-DAGENTSCOPE_PTY_TEST_FAULTS");
  execFileSync(
    "/bin/busybox",
    ["chroot", toolchainRoot, "/usr/bin/g++", ...arguments_],
    {
      cwd: "/",
      env: { ...policy.build.environment },
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 120_000,
    },
  );
  stageBuiltRuntime(resolve(toolchainRoot, "output/pty.node"), destination);
  return sha256(readFileSync(destination));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2)
    throw new Error("build-pty-runtime.mjs accepts no arguments.");
  const digest = buildPtyRuntime({ output: "/output", sourceRoot: "/build" });
  if (
    digest !==
    "0f55e9389e47d8d27ba35704c3facdab029cbc5eba3c55540d31fa81cd6604db"
  )
    throw new Error("PTY runtime build is not reproducible.");
}
