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

const verifyRegularFile = (path, expected, expectedMode = 0o644) => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(descriptor);
    const bytes = readFileSync(descriptor);
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== expectedMode ||
      sha256(bytes) !== expected
    )
      throw new Error(`PTY build input identity mismatch: ${path}`);
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

const prepareToolchainRoot = ({
  addonApi,
  archiveRoot,
  authorityRoot,
  source,
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
  mkdirSync(resolve(toolchainRoot, "build/node-pty"), {
    mode: 0o755,
    recursive: true,
  });
  mkdirSync(resolve(toolchainRoot, "build/node-addon-api"), {
    mode: 0o755,
    recursive: true,
  });
  mkdirSync(resolve(toolchainRoot, "output"), { mode: 0o700 });
  createPrivateBuildTemp(toolchainRoot);
  for (const [sourcePath, destinationPath] of [
    [source, resolve(toolchainRoot, "build/node-pty/pty.cc")],
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
  toolchainRoot = "/toolchain",
}) => {
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
  const source = resolve(sourceRoot, "node-pty", "src", "unix", "pty.cc");
  const addonApi = resolve(sourceRoot, "node-addon-api");
  const canonicalSource = "/build/node-pty/pty.cc";
  const canonicalAddonApi = "/build/node-addon-api";
  if (source !== canonicalSource || addonApi !== canonicalAddonApi)
    throw new Error("PTY runtime sources are not at canonical build paths.");
  const destination = resolve(output, "pty.node");
  if (destination !== "/output/pty.node")
    throw new Error("PTY runtime output is not at the canonical build path.");
  verifyRegularFile(
    source,
    "5809f87b15122f335017b0b3020071df4c6205c7827186a2c5a9e0edc9ef59b2",
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
    source,
    toolchainRoot,
  });
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
  execFileSync(
    "/bin/busybox",
    ["chroot", toolchainRoot, "/usr/bin/g++", ...policy.build.arguments],
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
    "38966cc64050466dd2b2489cc4e3a94a7c0040361d9ab79115241aeff8eb27de"
  )
    throw new Error("PTY runtime build is not reproducible.");
}
