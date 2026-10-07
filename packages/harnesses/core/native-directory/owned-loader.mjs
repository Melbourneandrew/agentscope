/** Private fixed-location native asset loader; never plan or support authority. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
} from "node:fs";
import { createRequire } from "node:module";
import { release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fail = () => {
  throw new Error("harness.installation.directory-unavailable");
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keys = (record, expected) =>
  record !== null &&
  typeof record === "object" &&
  !Array.isArray(record) &&
  Object.keys(record).sort().join("\0") === [...expected].sort().join("\0");
const relativePath = (value) =>
  typeof value === "string" &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  value
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
const version = (value) =>
  typeof value === "string" &&
  value.length <= 32 &&
  /^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){0,2}$/u.test(value) &&
  value.split(".").every((part) => Number.isSafeInteger(Number(part)));
const atLeast = (actual, minimum) => {
  if (!version(actual) || !version(minimum)) return false;
  const a = actual.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0))
      return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return true;
};

const snapshot = (relative, maximum) => {
  if (!relativePath(relative)) fail();
  const pieces = relative.split("/");
  let parent = root;
  if (!lstatSync(parent).isDirectory()) fail();
  for (const piece of pieces.slice(0, -1)) {
    parent = join(parent, piece);
    if (!lstatSync(parent).isDirectory()) fail();
  }
  const path = join(root, relative);
  return readBoundedFile(path, maximum);
};

const readBoundedFile = (path, maximum, system = false) => {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(maximum) ||
      (system && (before.uid !== 0n || (before.mode & 0o022n) !== 0n))
    )
      fail();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count < 1) fail();
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0) fail();
    const after = fstatSync(fd, { bigint: true });
    const pathIdentity = lstatSync(path, { bigint: true });
    for (const key of [
      "dev",
      "ino",
      "size",
      "mode",
      "nlink",
      "mtimeNs",
      "ctimeNs",
    ])
      if (before[key] !== after[key] || after[key] !== pathIdentity[key])
        fail();
    return bytes;
  } finally {
    closeSync(fd);
  }
};

const macosProductVersion = () => {
  // Apple's CoreFoundation reads this fixed OS-owned ProductVersion source.
  // Never substitute Darwin's kernel release for the macOS product version.
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    readBoundedFile(
      "/System/Library/CoreServices/SystemVersion.plist",
      65_536,
      true,
    ),
  );
  const declaration = '<?xml version="1.0" encoding="UTF-8"?>';
  const doctype =
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';
  let body = text.trim();
  if (!body.startsWith(declaration)) fail();
  body = body.slice(declaration.length).trim();
  if (!body.startsWith(doctype)) fail();
  body = body.slice(doctype.length).trim();
  const envelope =
    /^<plist version="1\.0">\s*<dict>([\s\S]*)<\/dict>\s*<\/plist>$/u.exec(
      body,
    );
  if (!envelope) fail();
  const fields = envelope[1];
  const rows = [
    ...fields.matchAll(
      /\s*<key>([^<&]*)<\/key>\s*<string>([^<&]*)<\/string>\s*/gu,
    ),
  ];
  if (
    rows.length < 1 ||
    rows.length > 32 ||
    rows.map((row) => row[0]).join("") !== fields ||
    new Set(rows.map((row) => row[1])).size !== rows.length
  )
    fail();
  const value = rows.find((row) => row[1] === "ProductVersion")?.[2];
  if (!version(value)) fail();
  return value;
};

const exactInventory = (paths) => {
  const directories = new Set([""]);
  for (const path of paths) {
    const pieces = path.split("/");
    for (let index = 1; index < pieces.length; index += 1)
      directories.add(pieces.slice(0, index).join("/"));
  }
  if (directories.size > 64) fail();
  const seen = new Set();
  for (const directory of directories) {
    const absolute = join(root, directory);
    const before = lstatSync(absolute, { bigint: true });
    if (!before.isDirectory()) fail();
    const stream = opendirSync(absolute, { bufferSize: 1 });
    try {
      let count = 0;
      for (
        let entry = stream.readSync();
        entry !== null;
        entry = stream.readSync()
      ) {
        count += 1;
        if (count > paths.size + directories.size) fail();
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        const stat = lstatSync(join(root, path));
        if (stat.isDirectory() && directories.has(path)) continue;
        if (!stat.isFile() || !paths.has(path) || seen.has(path)) fail();
        seen.add(path);
      }
    } finally {
      stream.closeSync();
    }
    const after = lstatSync(absolute, { bigint: true });
    for (const key of ["dev", "ino", "mode", "nlink", "mtimeNs", "ctimeNs"])
      if (before[key] !== after[key]) fail();
  }
  if (seen.size !== paths.size) fail();
};

const verifyNativeProfiles = (manifest, paths) => {
  const projections = new Set();
  const nativePaths = new Set();
  for (const binary of manifest.nativeBinaries) {
    if (
      !keys(binary, [
        "platform",
        "architecture",
        "admittedNodeMajors",
        "relativePath",
        "minimumOsVersion",
        "libcFamily",
        "minimumLibcVersion",
      ]) ||
      !["darwin", "linux"].includes(binary.platform) ||
      !["arm64", "x64"].includes(binary.architecture) ||
      !Array.isArray(binary.admittedNodeMajors) ||
      binary.admittedNodeMajors.length < 1 ||
      binary.admittedNodeMajors.some(
        (value) => !Number.isSafeInteger(value) || value < 22,
      ) ||
      new Set(binary.admittedNodeMajors).size !==
        binary.admittedNodeMajors.length ||
      !paths.has(binary.relativePath) ||
      !binary.relativePath.endsWith(".node") ||
      !version(binary.minimumOsVersion) ||
      (binary.platform === "darwin" &&
        (binary.libcFamily !== null || binary.minimumLibcVersion !== null)) ||
      (binary.platform === "linux" &&
        (binary.libcFamily !== "glibc" || !version(binary.minimumLibcVersion)))
    )
      fail();
    nativePaths.add(binary.relativePath);
    for (const nodeMajor of binary.admittedNodeMajors) {
      const projection = `${binary.platform}:${binary.architecture}:${nodeMajor}`;
      if (projections.has(projection)) fail();
      projections.add(projection);
    }
  }
  for (const path of paths)
    if (path.endsWith(".node") && !nativePaths.has(path)) fail();
  if (!paths.has("loader/owned-loader.mjs")) fail();
};

// expectedDigest is embedded by the existing candidate build, not read from an
// environment, CLI argument, mutable sidecar, or caller-selected manifest path.
export const verifyDirectoryAsset = (expectedDigest) => {
  if (
    typeof expectedDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(expectedDigest)
  )
    fail();
  const bytes = snapshot("records/support-manifest.json", 65_536);
  if (sha(bytes) !== expectedDigest) fail();
  const manifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (
    !keys(manifest, [
      "schemaVersion",
      "capability",
      "nodeApiVersion",
      "artifactFiles",
      "nativeBinaries",
    ]) ||
    manifest.schemaVersion !== 1 ||
    manifest.capability !== "installation-directory" ||
    manifest.nodeApiVersion !== 8 ||
    !Array.isArray(manifest.artifactFiles) ||
    !Array.isArray(manifest.nativeBinaries) ||
    manifest.artifactFiles.length < 1 ||
    manifest.artifactFiles.length > 32 ||
    manifest.nativeBinaries.length < 1 ||
    manifest.nativeBinaries.length > 16
  )
    fail();
  const paths = new Set();
  for (const file of manifest.artifactFiles) {
    if (
      !keys(file, ["relativePath", "bytes", "digest"]) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 16_777_216 ||
      !relativePath(file.relativePath) ||
      file.relativePath === "records/support-manifest.json" ||
      paths.has(file.relativePath) ||
      !/^sha256:[a-f0-9]{64}$/u.test(file.digest)
    )
      fail();
    paths.add(file.relativePath);
    const actual = snapshot(file.relativePath, file.bytes);
    if (actual.length !== file.bytes || `sha256:${sha(actual)}` !== file.digest)
      fail();
  }
  exactInventory(new Set([...paths, "records/support-manifest.json"]));
  verifyNativeProfiles(manifest, paths);
  return Object.freeze({
    manifest,
    paths: Object.freeze([...paths]),
    digest: expectedDigest,
  });
};

export const loadDirectoryPrimitive = (expectedDigest) => {
  const { manifest } = verifyDirectoryAsset(expectedDigest);
  const major = Number(process.versions.node.split(".")[0]);
  const selected = manifest.nativeBinaries.filter(
    (binary) =>
      binary.platform === process.platform &&
      binary.architecture === process.arch &&
      binary.admittedNodeMajors.includes(major),
  );
  if (selected.length !== 1 || Number(process.versions.napi) < 8) fail();
  const binary = selected[0];
  if (process.platform === "darwin") {
    if (!atLeast(macosProductVersion(), binary.minimumOsVersion)) fail();
  } else if (process.platform === "linux") {
    const kernel = /^([0-9]+(?:\.[0-9]+){0,2})(?:-|$)/u.exec(release())?.[1];
    const glibc = process.report.getReport().header.glibcVersionRuntime;
    if (
      !atLeast(kernel, binary.minimumOsVersion) ||
      !atLeast(glibc, binary.minimumLibcVersion)
    )
      fail();
  } else fail();
  return createRequire(import.meta.url)(join(root, binary.relativePath));
};
