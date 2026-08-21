import { lstatSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as root from "./dist/index.js";
import * as reporter from "./dist/reporter/index.js";
import * as retriever from "./dist/retriever/index.js";
import * as testing from "./dist/testing.js";

const packageRoot = new URL(".", import.meta.url);
const sourceRoot = new URL("./src/", packageRoot);
const distRoot = new URL("./dist/", packageRoot);

const regularFiles = (rootUrl) => {
  const rootPath = fileURLToPath(rootUrl);
  const files = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of readdirSync(directory)) {
      const path = resolve(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink())
        throw new Error(`Local SQLite artifact contains a symlink: ${path}`);
      if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile()) files.push(relative(rootPath, path));
      else
        throw new Error(
          `Local SQLite artifact contains a nonregular entry: ${path}`,
        );
    }
  }
  return files.sort();
};

const sourceFiles = regularFiles(sourceRoot).filter(
  (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
);
const expectedDist = sourceFiles
  .flatMap((file) => [
    file.replace(/\.ts$/u, ".d.ts"),
    file.replace(/\.ts$/u, ".js"),
  ])
  .sort();
const actualDist = regularFiles(distRoot);
if (JSON.stringify(actualDist) !== JSON.stringify(expectedDist))
  throw new Error(
    "Local SQLite dist is not an exact production-source artifact.",
  );
if (actualDist.some((file) => file.includes(".test.")))
  throw new Error("Local SQLite dist contains compiled tests.");

const expectedRoot = [
  "LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST",
  "inspectLocalSqliteNativeSupport",
  "localSqliteDestinationPackageId",
  "localSqliteReporterPackageId",
  "localSqliteRetrieverPackageId",
].sort();
if (JSON.stringify(Object.keys(root).sort()) !== JSON.stringify(expectedRoot))
  throw new Error("Local SQLite root export surface drifted.");
if (
  JSON.stringify(Object.keys(reporter)) !==
  JSON.stringify(["localSqliteReporterPackageId"])
)
  throw new Error("Local SQLite Reporter export surface drifted.");
if (
  JSON.stringify(Object.keys(retriever)) !==
  JSON.stringify(["localSqliteRetrieverPackageId"])
)
  throw new Error("Local SQLite Retriever export surface drifted.");
if (
  JSON.stringify(Object.keys(testing)) !==
  JSON.stringify(
    [
      "compileReleaseTarArchiveForTesting",
      "inspectLocalSqliteNativeSupportManifestForTesting",
    ].sort(),
  )
)
  throw new Error("Local SQLite testing export surface drifted.");
if (
  root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.schemaVersion !== 1 ||
  root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.nativeBinaries.length !== 0 ||
  root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.supportedPlatforms.length !== 0
)
  throw new Error("Local SQLite artifact claimed an unproved native tuple.");

const runtimeIdentity = {
  nodeAbi: 127,
  nodeMajor: 22,
  platform: "linux",
  osVersion: "6.8",
  architecture: "x64",
  libcFamily: "glibc",
  libcVersion: "2.39",
  credentialBackend: "ci-environment",
  filesystemProfile: "local-ext4",
};
const unavailable = root.inspectLocalSqliteNativeSupport(runtimeIdentity);
if (
  root.inspectLocalSqliteNativeSupport.length !== 1 ||
  unavailable.state !== "unavailable" ||
  unavailable.code !== "destination.local-sqlite.native-unavailable"
)
  throw new Error("Local SQLite built unavailable boundary drifted.");

let coercionCalls = 0;
const hostileValue = Object.freeze({
  toString() {
    coercionCalls += 1;
    return "glibc";
  },
  [Symbol.toPrimitive]() {
    coercionCalls += 1;
    return "glibc";
  },
});
testing.inspectLocalSqliteNativeSupportManifestForTesting(
  { ...runtimeIdentity, libcFamily: hostileValue },
  root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST,
);
if (coercionCalls !== 0)
  throw new Error("Local SQLite built boundary coerced caller-owned data.");
