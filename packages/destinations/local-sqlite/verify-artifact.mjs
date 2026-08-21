import { lstatSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { standardsManifest } from "@agentscope/protocol";

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
const migrationFiles = regularFiles(sourceRoot).filter(
  (file) => file.startsWith("migrations/") && file.endsWith(".sql"),
);
const expectedDist = [
  ...sourceFiles.flatMap((file) => [
    file.replace(/\.ts$/u, ".d.ts"),
    file.replace(/\.ts$/u, ".js"),
  ]),
  ...migrationFiles,
].sort();
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
      "canonicalizeLocalSqliteEvidenceForTesting",
      "compileReleaseTarArchiveForTesting",
      "compileLocalSqliteMigrationInventoryForTesting",
      "compileLocalSqliteMigrationSqlForTesting",
      "inspectLocalSqliteNativeSupportManifestForTesting",
      "LOCAL_SQLITE_DESTINATION_FORMAT",
      "LOCAL_SQLITE_MIGRATION_MANIFEST_ID",
      "LOCAL_SQLITE_MIGRATIONS",
      "LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID",
      "runLocalSqliteMigrations",
      "runLocalSqliteMigrationsWithInventoryForTesting",
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

if (
  testing.LOCAL_SQLITE_DESTINATION_FORMAT !== "agentscope.local-sqlite.v1" ||
  testing.LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID !==
    standardsManifest.manifestId ||
  !/^sha256:[a-f0-9]{64}$/u.test(testing.LOCAL_SQLITE_MIGRATION_MANIFEST_ID) ||
  testing.LOCAL_SQLITE_MIGRATIONS.length !== 1 ||
  testing.LOCAL_SQLITE_MIGRATIONS[0]?.name !== "0001-initialize.sql" ||
  testing.LOCAL_SQLITE_MIGRATIONS[0]?.sha256 !==
    "616f0f680cd8d86d36e3f880caf0925e6c0a16138d50e4af98e907bcfb855d24" ||
  testing.LOCAL_SQLITE_MIGRATIONS[0]?.protocolCompatibilityId !==
    standardsManifest.manifestId ||
  testing.compileLocalSqliteMigrationInventoryForTesting(
    testing.LOCAL_SQLITE_MIGRATIONS,
  )?.length !== 1 ||
  testing.compileLocalSqliteMigrationSqlForTesting(
    "CREATE TABLE payload_copy AS SELECT payload FROM traces;",
  ) !== undefined
)
  throw new Error("Local SQLite built migration authority drifted.");

const migrationState = {
  transaction: false,
  committed: false,
  rolledBack: false,
  statements: [],
  ledger: [],
  metadata: undefined,
};
const migrationDatabase = Object.freeze({
  beginExclusive() {
    migrationState.transaction = true;
  },
  execute(statement) {
    migrationState.statements.push(statement);
  },
  inTransaction() {
    return migrationState.transaction;
  },
  readMigrationLedger() {
    return migrationState.ledger;
  },
  recordMigration(entry) {
    migrationState.ledger.push(entry);
  },
  readDestinationMetadata() {
    return migrationState.metadata;
  },
  writeDestinationMetadata(metadata) {
    migrationState.metadata = metadata;
  },
  readImmutableRows() {
    return [];
  },
  rebuildPortableProjections() {},
  readPortableProjections() {
    return [];
  },
  readExpectedPortableProjections() {
    return [];
  },
  commit() {
    migrationState.transaction = false;
    migrationState.committed = true;
  },
  rollback() {
    migrationState.transaction = false;
    migrationState.rolledBack = true;
  },
});
const migrationResult = testing.runLocalSqliteMigrations(migrationDatabase);
if (
  migrationResult.ok !== true ||
  migrationResult.state !== "migrated" ||
  migrationState.statements.length !== 6 ||
  migrationState.ledger.length !== 1 ||
  migrationState.committed !== true ||
  migrationState.rolledBack !== false
)
  throw new Error("Local SQLite built migration transaction drifted.");
const workBeforeInvalidInventory = migrationState.statements.length;
const invalidInventoryResult =
  testing.runLocalSqliteMigrationsWithInventoryForTesting(
    migrationDatabase,
    [],
  );
if (
  invalidInventoryResult.ok !== false ||
  invalidInventoryResult.state !== "invalid-inventory" ||
  migrationState.statements.length !== workBeforeInvalidInventory
)
  throw new Error("Local SQLite built migration preflight drifted.");

const missingLedgerState = {
  transaction: false,
  committed: false,
  rolledBack: false,
  metadata: undefined,
};
const missingLedgerDatabase = Object.freeze({
  ...migrationDatabase,
  beginExclusive() {
    missingLedgerState.transaction = true;
  },
  inTransaction() {
    return missingLedgerState.transaction;
  },
  readMigrationLedger() {
    return [];
  },
  recordMigration() {},
  readDestinationMetadata() {
    return missingLedgerState.metadata;
  },
  writeDestinationMetadata(metadata) {
    missingLedgerState.metadata = metadata;
  },
  commit() {
    missingLedgerState.committed = true;
  },
  rollback() {
    missingLedgerState.transaction = false;
    missingLedgerState.rolledBack = true;
  },
});
const missingLedgerResult = testing.runLocalSqliteMigrations(
  missingLedgerDatabase,
);
if (
  missingLedgerResult.ok !== false ||
  missingLedgerResult.state !== "reconciliation-required" ||
  missingLedgerState.committed !== false ||
  missingLedgerState.rolledBack !== true
)
  throw new Error("Local SQLite built candidate-ledger proof drifted.");
