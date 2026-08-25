import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { standardsManifest } from "@agentscope/protocol";

import { localSqliteLifecycleDeclaration } from "./lifecycle/capability.js";

export const LOCAL_SQLITE_DESTINATION_FORMAT =
  "agentscope.local-sqlite.v1" as const;
export const LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID =
  standardsManifest.manifestId;

export type LocalSqliteMigrationResource = Readonly<{
  version: number;
  ordinal: number;
  name: string;
  sha256: string;
  protocolCompatibilityId: string;
  sql: string;
}>;

export type LocalSqliteMigrationLedgerEntry = Readonly<{
  version: number;
  ordinal: number;
  name: string;
  sha256: string;
}>;

export type LocalSqliteDestinationMetadata = Readonly<{
  destinationFormat: string;
  lifecycleCapabilityVersion: number;
  lifecycleFingerprint: string;
  migrationManifestId: string;
  protocolCompatibilityId: string;
  recoveryHandlerId: string;
}>;

export type LocalSqliteLifecycleMetadataIdentity = Readonly<{
  capabilityVersion: 1;
  fingerprint: string;
  recoveryHandlerId: string;
}>;

const testLifecycleIdentity: LocalSqliteLifecycleMetadataIdentity =
  Object.freeze({
    capabilityVersion: 1,
    fingerprint: `sha256-${"0".repeat(64)}`,
    recoveryHandlerId: localSqliteLifecycleDeclaration.recoveryHandlerId,
  });

export type LocalSqliteImmutableRowEvidence = Readonly<{
  deliveryIdentity: string;
  traceId: string;
  startTimeUnixNano: string;
  startTimeSortKey: string;
  admissionTimeUnixNano: string;
  admissionTimeSortKey: string;
  protocolCompatibilityId: string;
  payloadSha256: string;
  payloadBytes: number;
}>;

export type LocalSqliteProjectionEvidence = Readonly<{
  deliveryIdentity: string;
  kind: string;
  value: string;
  ordinal: number;
}>;

export type LocalSqliteMigrationDatabase = Readonly<{
  beginExclusive: () => void;
  execute: (statement: string) => void;
  inTransaction: () => boolean;
  readMigrationLedger: () => readonly LocalSqliteMigrationLedgerEntry[];
  recordMigration: (entry: LocalSqliteMigrationLedgerEntry) => void;
  readDestinationMetadata: () => LocalSqliteDestinationMetadata | undefined;
  writeDestinationMetadata: (metadata: LocalSqliteDestinationMetadata) => void;
  readImmutableRows: () => readonly LocalSqliteImmutableRowEvidence[];
  rebuildPortableProjections: () => void;
  readPortableProjections: () => readonly LocalSqliteProjectionEvidence[];
  readExpectedPortableProjections: () => readonly LocalSqliteProjectionEvidence[];
  commit: () => void;
  rollback: () => void;
}>;

export type LocalSqliteMigrationResult =
  | Readonly<{ ok: true; state: "current" | "migrated" }>
  | Readonly<{
      ok: false;
      state: "invalid-inventory" | "reconciliation-required" | "failed";
    }>;

const migrationFiles = Object.freeze([
  Object.freeze({
    name: "0001-initialize.sql",
    bytes: 1075,
    sha256: "616f0f680cd8d86d36e3f880caf0925e6c0a16138d50e4af98e907bcfb855d24",
    // This is deliberately a release literal rather than an alias of the
    // current Protocol manifest. Historical ledger prefixes retain the exact
    // compatibility authority with which they were released.
    protocolCompatibilityId:
      "agentscope-protocol-2_otel-1.60.0_otlp-1.11.0_otel-semconv-1.44.0_openinference-js-2.7.0_profile-2-sha256-682b98c09e5f1e2c5827d2eb06885968d5cd1610c57a2ddc28022d0fdd37165d_identity-1-sha256-2c10f312f8e0bf8e6e040843cf88bc5d384993609a4843038fd8e2ed27d8f66b_extensions-2-sha256-691b475677538ec480cc5db480e4d95a2242c06a0ad5517b34dc8da7000a830c_codec-1-sha256-37cd4d040eab9d914496acd83545ca46e7fa3dd78314aa067407d999e966e278_compatibility-1-sha256-86d3c71d7f25f75da3af52cf46ec4ac1ba104684f55146c87db02c1d8de444ca",
  }),
  Object.freeze({
    name: "0002-retrieval-indexes.sql",
    bytes: 180,
    sha256: "48472b1673ed36f4bb77494b3f8c6b425c99467004a2c3da2f042e896e693a3e",
    protocolCompatibilityId:
      "agentscope-protocol-2_otel-1.60.0_otlp-1.11.0_otel-semconv-1.44.0_openinference-js-2.7.0_profile-2-sha256-682b98c09e5f1e2c5827d2eb06885968d5cd1610c57a2ddc28022d0fdd37165d_identity-1-sha256-2c10f312f8e0bf8e6e040843cf88bc5d384993609a4843038fd8e2ed27d8f66b_extensions-2-sha256-691b475677538ec480cc5db480e4d95a2242c06a0ad5517b34dc8da7000a830c_codec-1-sha256-37cd4d040eab9d914496acd83545ca46e7fa3dd78314aa067407d999e966e278_compatibility-1-sha256-86d3c71d7f25f75da3af52cf46ec4ac1ba104684f55146c87db02c1d8de444ca",
  }),
] as const);
const maximumMigrationBytes = 64 * 1024;
const maximumMigrationStatements = 64;
const maximumEvidenceRows = 1_000_000;
const maximumEvidenceBytes = 256 * 1024 * 1024;
const migrationNamePattern = /^(?<version>[0-9]{4})-[a-z][a-z0-9-]*\.sql$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const canonicalUnsignedPattern = /^(?:0|[1-9][0-9]*)$/u;
const traceIdPattern = /^[a-f0-9]{32}$/u;
const sortableUnsignedPattern = /^[0-9]{20}$/u;
const maximumUint64 = 18_446_744_073_709_551_615n;

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const boundedString = (value: unknown, maximumBytes: number): value is string =>
  typeof value === "string" &&
  value.length <= maximumBytes &&
  Buffer.byteLength(value, "utf8") <= maximumBytes;

const exactRecord = (
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined => {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return undefined;
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
};

const exactArray = (
  value: unknown,
  maximum: number,
): readonly unknown[] | undefined => {
  try {
    if (!Array.isArray(value)) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = Object.getOwnPropertyDescriptor(value, "length");
    const lengthValue = length?.value as unknown;
    if (
      !length ||
      !("value" in length) ||
      typeof lengthValue !== "number" ||
      !Number.isSafeInteger(lengthValue) ||
      lengthValue < 0 ||
      lengthValue > maximum
    )
      return undefined;
    const values: unknown[] = [];
    for (let index = 0; index < lengthValue; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor)) return undefined;
      values.push(descriptor.value);
    }
    // `length` plus every exact index were proven above, so any additional
    // string or symbol property necessarily makes this count exceed the bound.
    if (Reflect.ownKeys(descriptors).length !== lengthValue + 1)
      return undefined;
    return values;
  } catch {
    return undefined;
  }
};

type SqlToken = Readonly<{
  kind: "identifier" | "number" | "punctuation" | "string";
  value: string;
}>;

const tokenizeSql = (sql: string): readonly SqlToken[] | undefined => {
  const tokens: SqlToken[] = [];
  let offset = 0;
  while (offset < sql.length) {
    const code = sql.charCodeAt(offset);
    if (code === 9 || code === 10 || code === 13 || code === 32) {
      offset += 1;
      continue;
    }
    if (code === 39) {
      let value = "";
      offset += 1;
      let closed = false;
      while (offset < sql.length) {
        if (sql.charCodeAt(offset) !== 39) {
          value += sql[offset];
          offset += 1;
          continue;
        }
        if (sql.charCodeAt(offset + 1) === 39) {
          value += "'";
          offset += 2;
          continue;
        }
        offset += 1;
        closed = true;
        break;
      }
      if (!closed || value.length > 4_096) return undefined;
      tokens.push(Object.freeze({ kind: "string", value }));
      continue;
    }
    const character = sql[offset]!;
    if (/[A-Za-z_]/u.test(character)) {
      const start = offset;
      offset += 1;
      while (offset < sql.length && /[A-Za-z0-9_]/u.test(sql[offset]!))
        offset += 1;
      tokens.push(
        Object.freeze({
          kind: "identifier",
          value: sql.slice(start, offset).toUpperCase(),
        }),
      );
      continue;
    }
    if (/[0-9]/u.test(character)) {
      const start = offset;
      offset += 1;
      while (offset < sql.length && /[0-9]/u.test(sql[offset]!)) offset += 1;
      tokens.push(
        Object.freeze({ kind: "number", value: sql.slice(start, offset) }),
      );
      continue;
    }
    if ("(),;".includes(character)) {
      tokens.push(Object.freeze({ kind: "punctuation", value: character }));
      offset += 1;
      continue;
    }
    return undefined;
  }
  return Object.freeze(tokens);
};

type SqlCursor = { tokens: readonly SqlToken[]; offset: number };

const grammarKeywords = new Set([
  "ASC",
  "BLOB",
  "CASCADE",
  "CREATE",
  "DEFAULT",
  "DELETE",
  "DESC",
  "INDEX",
  "INTEGER",
  "NOT",
  "NULL",
  "ON",
  "PRIMARY",
  "REFERENCES",
  "STRICT",
  "TABLE",
  "TEXT",
  "UNIQUE",
]);

const consumeValue = (cursor: SqlCursor, value: string): boolean => {
  if (cursor.tokens[cursor.offset]?.value !== value) return false;
  cursor.offset += 1;
  return true;
};

const consumeName = (cursor: SqlCursor): boolean => {
  const token = cursor.tokens[cursor.offset];
  if (token?.kind !== "identifier" || grammarKeywords.has(token.value))
    return false;
  cursor.offset += 1;
  return true;
};

const consumeNameList = (cursor: SqlCursor): boolean => {
  if (!consumeValue(cursor, "(") || !consumeName(cursor)) return false;
  while (consumeValue(cursor, ",")) if (!consumeName(cursor)) return false;
  return consumeValue(cursor, ")");
};

const consumeColumnConstraint = (cursor: SqlCursor): boolean => {
  if (consumeValue(cursor, "NOT")) return consumeValue(cursor, "NULL");
  if (consumeValue(cursor, "UNIQUE")) return true;
  if (consumeValue(cursor, "PRIMARY")) return consumeValue(cursor, "KEY");
  if (consumeValue(cursor, "DEFAULT")) {
    const token = cursor.tokens[cursor.offset];
    if (token?.kind !== "string" && token?.kind !== "number") return false;
    cursor.offset += 1;
    return true;
  }
  if (!consumeValue(cursor, "REFERENCES")) return false;
  if (!consumeName(cursor) || !consumeNameList(cursor)) return false;
  if (!consumeValue(cursor, "ON")) return true;
  return consumeValue(cursor, "DELETE") && consumeValue(cursor, "CASCADE");
};

const consumeTableDefinition = (cursor: SqlCursor): boolean => {
  if (consumeValue(cursor, "PRIMARY"))
    return consumeValue(cursor, "KEY") && consumeNameList(cursor);
  if (!consumeName(cursor)) return false;
  if (
    !consumeValue(cursor, "TEXT") &&
    !consumeValue(cursor, "INTEGER") &&
    !consumeValue(cursor, "BLOB")
  )
    return false;
  while (
    cursor.tokens[cursor.offset]?.value !== "," &&
    cursor.tokens[cursor.offset]?.value !== ")"
  )
    if (!consumeColumnConstraint(cursor)) return false;
  return true;
};

const validCreateTable = (tokens: readonly SqlToken[]): boolean => {
  const cursor: SqlCursor = { tokens, offset: 0 };
  if (
    !consumeValue(cursor, "CREATE") ||
    !consumeValue(cursor, "TABLE") ||
    !consumeName(cursor) ||
    !consumeValue(cursor, "(") ||
    !consumeTableDefinition(cursor)
  )
    return false;
  while (consumeValue(cursor, ","))
    if (!consumeTableDefinition(cursor)) return false;
  return (
    consumeValue(cursor, ")") &&
    consumeValue(cursor, "STRICT") &&
    consumeValue(cursor, ";") &&
    cursor.offset === tokens.length
  );
};

const validCreateIndex = (tokens: readonly SqlToken[]): boolean => {
  const cursor: SqlCursor = { tokens, offset: 0 };
  if (
    !consumeValue(cursor, "CREATE") ||
    !consumeValue(cursor, "INDEX") ||
    !consumeName(cursor) ||
    !consumeValue(cursor, "ON") ||
    !consumeName(cursor) ||
    !consumeValue(cursor, "(")
  )
    return false;
  do {
    if (!consumeName(cursor)) return false;
    if (
      cursor.tokens[cursor.offset]?.value === "ASC" ||
      cursor.tokens[cursor.offset]?.value === "DESC"
    )
      cursor.offset += 1;
  } while (consumeValue(cursor, ","));
  return (
    consumeValue(cursor, ")") &&
    consumeValue(cursor, ";") &&
    cursor.offset === tokens.length
  );
};

const validStatement = (tokens: readonly SqlToken[]): boolean =>
  validCreateTable(tokens) || validCreateIndex(tokens);

const compileStatements = (sql: string): readonly string[] | undefined => {
  if (
    Buffer.byteLength(sql, "utf8") === 0 ||
    Buffer.byteLength(sql, "utf8") > maximumMigrationBytes ||
    sql.includes("\0") ||
    sql.includes("--") ||
    sql.includes("/*")
  )
    return undefined;
  const tokens = tokenizeSql(sql);
  if (!tokens || tokens.length === 0) return undefined;
  const statements: string[] = [];
  let start = 0;
  let insideString = false;
  for (let index = 0; index < sql.length; index += 1) {
    if (sql[index] === "'") {
      if (insideString && sql[index + 1] === "'") {
        index += 1;
        continue;
      }
      insideString = !insideString;
      continue;
    }
    if (insideString || sql[index] !== ";") continue;
    const statement = sql.slice(start, index + 1).trim();
    start = index + 1;
    /* v8 ignore next -- the sliced range always includes the semicolon at
     * `index`, so even adjacent separators produce the one-byte statement ";". */
    if (statement.length === 0) return undefined;
    const statementTokens = tokenizeSql(statement);
    if (
      !statementTokens ||
      statementTokens.at(-1)?.value !== ";" ||
      !validStatement(statementTokens)
    )
      return undefined;
    statements.push(statement);
    if (statements.length > maximumMigrationStatements) return undefined;
  }
  if (sql.slice(start).trim().length !== 0 || statements.length === 0)
    return undefined;
  return Object.freeze(statements);
};

const loadBuiltInventory = (): readonly LocalSqliteMigrationResource[] => {
  const resources = migrationFiles.map((file, index) => {
    const match = migrationNamePattern.exec(file.name);
    /* v8 ignore next -- migrationFiles is the fixed reviewed literal above;
     * external inventories are parsed by compileInventory instead. */
    if (!match?.groups)
      throw new Error("destination.local-sqlite.migration.invalid");
    const sql = readFileSync(
      new URL(`./migrations/${file.name}`, import.meta.url),
      "utf8",
    );
    if (
      Buffer.byteLength(sql, "utf8") !== file.bytes ||
      sha256(sql) !== file.sha256
    )
      throw new Error("destination.local-sqlite.migration.invalid");
    return Object.freeze({
      version: Number(match.groups.version),
      ordinal: index + 1,
      name: file.name,
      sha256: file.sha256,
      protocolCompatibilityId: file.protocolCompatibilityId,
      sql,
    });
  });
  return Object.freeze(resources);
};

export const LOCAL_SQLITE_MIGRATIONS = loadBuiltInventory();

const migrationManifestId = (
  resources: readonly LocalSqliteMigrationResource[],
): string =>
  `sha256:${sha256(
    JSON.stringify({
      format: LOCAL_SQLITE_DESTINATION_FORMAT,
      migrations: resources.map(
        ({ version, ordinal, name, sha256, protocolCompatibilityId }) => ({
          version,
          ordinal,
          name,
          sha256,
          protocolCompatibilityId,
        }),
      ),
    }),
  )}`;

export const LOCAL_SQLITE_MIGRATION_MANIFEST_ID = migrationManifestId(
  LOCAL_SQLITE_MIGRATIONS,
);

const compileInventory = (
  value: unknown,
):
  | readonly Readonly<{
      resource: LocalSqliteMigrationResource;
      statements: readonly string[];
    }>[]
  | undefined => {
  const candidates = exactArray(value, 64);
  if (!candidates || candidates.length === 0) return undefined;
  const compiled = [];
  let priorVersion = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const record = exactRecord(candidates[index], [
      "version",
      "ordinal",
      "name",
      "sha256",
      "protocolCompatibilityId",
      "sql",
    ]);
    if (!record) return undefined;
    const {
      version,
      ordinal,
      name,
      sha256: digest,
      protocolCompatibilityId,
      sql,
    } = record;
    if (
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version !== priorVersion + 1 ||
      typeof ordinal !== "number" ||
      ordinal !== index + 1 ||
      typeof name !== "string" ||
      migrationNamePattern.exec(name)?.groups?.version !==
        String(version).padStart(4, "0") ||
      typeof digest !== "string" ||
      !sha256Pattern.test(digest) ||
      !boundedString(protocolCompatibilityId, 1_024) ||
      protocolCompatibilityId.length === 0 ||
      typeof sql !== "string" ||
      sha256(sql) !== digest
    )
      return undefined;
    const statements = compileStatements(sql);
    if (!statements) return undefined;
    const resource = Object.freeze({
      version,
      ordinal,
      name,
      sha256: digest,
      protocolCompatibilityId,
      sql,
    });
    compiled.push(Object.freeze({ resource, statements }));
    priorVersion = version;
  }
  return Object.freeze(compiled);
};

const snapshotLedger = (
  value: unknown,
): readonly LocalSqliteMigrationLedgerEntry[] | undefined => {
  const candidates = exactArray(value, 64);
  if (!candidates) return undefined;
  const entries: LocalSqliteMigrationLedgerEntry[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const record = exactRecord(candidates[index], [
      "version",
      "ordinal",
      "name",
      "sha256",
    ]);
    if (!record) return undefined;
    const { version, ordinal, name, sha256: digest } = record;
    if (
      typeof version !== "number" ||
      version !== index + 1 ||
      typeof ordinal !== "number" ||
      ordinal !== index + 1 ||
      typeof name !== "string" ||
      typeof digest !== "string" ||
      !sha256Pattern.test(digest)
    )
      return undefined;
    entries.push(Object.freeze({ version, ordinal, name, sha256: digest }));
  }
  return Object.freeze(entries);
};

const ledgerMatchesInventory = (
  ledger: readonly LocalSqliteMigrationLedgerEntry[],
  compiled: readonly Readonly<{ resource: LocalSqliteMigrationResource }>[],
): boolean =>
  ledger.length === compiled.length &&
  ledger.every((actual, index) => {
    const expected = compiled[index]!.resource;
    return (
      actual.version === expected.version &&
      actual.ordinal === expected.ordinal &&
      actual.name === expected.name &&
      actual.sha256 === expected.sha256
    );
  });

const snapshotMetadata = (
  value: unknown,
  expected: LocalSqliteDestinationMetadata,
): LocalSqliteDestinationMetadata | undefined => {
  const record = exactRecord(value, [
    "destinationFormat",
    "lifecycleCapabilityVersion",
    "lifecycleFingerprint",
    "migrationManifestId",
    "protocolCompatibilityId",
    "recoveryHandlerId",
  ]);
  if (
    !record ||
    record.destinationFormat !== expected.destinationFormat ||
    record.lifecycleCapabilityVersion !== expected.lifecycleCapabilityVersion ||
    record.lifecycleFingerprint !== expected.lifecycleFingerprint ||
    record.migrationManifestId !== expected.migrationManifestId ||
    record.protocolCompatibilityId !== expected.protocolCompatibilityId ||
    record.recoveryHandlerId !== expected.recoveryHandlerId
  )
    return undefined;
  return Object.freeze({
    ...expected,
  });
};

const validImmutableEvidence = (record: Record<string, unknown>): boolean =>
  boundedString(record.deliveryIdentity, 1_024) &&
  record.deliveryIdentity.length > 0 &&
  boundedString(record.traceId, 32) &&
  traceIdPattern.test(record.traceId) &&
  boundedString(record.startTimeUnixNano, 20) &&
  canonicalUnsignedPattern.test(record.startTimeUnixNano) &&
  BigInt(record.startTimeUnixNano) <= maximumUint64 &&
  boundedString(record.startTimeSortKey, 20) &&
  sortableUnsignedPattern.test(record.startTimeSortKey) &&
  record.startTimeSortKey === record.startTimeUnixNano.padStart(20, "0") &&
  boundedString(record.admissionTimeUnixNano, 20) &&
  canonicalUnsignedPattern.test(record.admissionTimeUnixNano) &&
  BigInt(record.admissionTimeUnixNano) <= maximumUint64 &&
  boundedString(record.admissionTimeSortKey, 20) &&
  sortableUnsignedPattern.test(record.admissionTimeSortKey) &&
  record.admissionTimeSortKey ===
    record.admissionTimeUnixNano.padStart(20, "0") &&
  boundedString(record.protocolCompatibilityId, 1_024) &&
  record.protocolCompatibilityId.length > 0 &&
  boundedString(record.payloadSha256, 64) &&
  sha256Pattern.test(record.payloadSha256) &&
  typeof record.payloadBytes === "number" &&
  Number.isSafeInteger(record.payloadBytes) &&
  record.payloadBytes >= 0;

const canonicalEvidence = (
  value: unknown,
  kind: "immutable" | "projection",
  maximumBytes = maximumEvidenceBytes,
): readonly string[] | undefined => {
  const candidates = exactArray(value, maximumEvidenceRows);
  if (!candidates) return undefined;
  const rows: string[] = [];
  let evidenceBytes = 0;
  const keys =
    kind === "immutable"
      ? [
          "deliveryIdentity",
          "traceId",
          "startTimeUnixNano",
          "startTimeSortKey",
          "admissionTimeUnixNano",
          "admissionTimeSortKey",
          "protocolCompatibilityId",
          "payloadSha256",
          "payloadBytes",
        ]
      : ["deliveryIdentity", "kind", "value", "ordinal"];
  for (const candidate of candidates) {
    const record = exactRecord(candidate, keys);
    if (!record) return undefined;
    if (kind === "immutable") {
      if (!validImmutableEvidence(record)) return undefined;
    } else if (
      !boundedString(record.deliveryIdentity, 1_024) ||
      record.deliveryIdentity.length === 0 ||
      !boundedString(record.kind, 64) ||
      record.kind.length === 0 ||
      !boundedString(record.value, 4_096) ||
      typeof record.ordinal !== "number" ||
      !Number.isSafeInteger(record.ordinal) ||
      record.ordinal < 0
    )
      return undefined;
    const row = JSON.stringify(keys.map((key) => record[key]));
    evidenceBytes += Buffer.byteLength(row, "utf8");
    if (evidenceBytes > maximumBytes) return undefined;
    rows.push(row);
  }
  return Object.freeze(rows.sort());
};

const equalStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const readLedgerPrefix = (
  database: LocalSqliteMigrationDatabase,
  compiled: readonly Readonly<{ resource: LocalSqliteMigrationResource }>[],
): readonly LocalSqliteMigrationLedgerEntry[] => {
  const ledger = snapshotLedger(database.readMigrationLedger());
  if (!ledger || ledger.length > compiled.length)
    throw new Error("ledger-invalid");
  for (let index = 0; index < ledger.length; index += 1) {
    const expected = compiled[index]!.resource;
    const actual = ledger[index]!;
    if (
      actual.version !== expected.version ||
      actual.ordinal !== expected.ordinal ||
      actual.name !== expected.name ||
      actual.sha256 !== expected.sha256
    )
      throw new Error("ledger-mismatch");
  }
  return ledger;
};

const applyPendingMigrations = (
  database: LocalSqliteMigrationDatabase,
  compiled: readonly Readonly<{
    resource: LocalSqliteMigrationResource;
    statements: readonly string[];
  }>[],
  start: number,
): void => {
  for (let index = start; index < compiled.length; index += 1) {
    const migration = compiled[index]!;
    for (const statement of migration.statements) {
      database.execute(statement);
      if (!database.inTransaction()) throw new Error("transaction-lost");
    }
    const { version, ordinal, name, sha256: digest } = migration.resource;
    database.recordMigration(
      Object.freeze({ version, ordinal, name, sha256: digest }),
    );
    if (!database.inTransaction()) throw new Error("transaction-lost");
  }
};

const verifyCandidateEvidence = (
  database: LocalSqliteMigrationDatabase,
  beforeRows: readonly string[],
): void => {
  const afterRows = canonicalEvidence(
    database.readImmutableRows(),
    "immutable",
  );
  if (!afterRows || !equalStrings(beforeRows, afterRows))
    throw new Error("immutable-drift");
  database.rebuildPortableProjections();
  if (!database.inTransaction()) throw new Error("transaction-lost");
  const actual = canonicalEvidence(
    database.readPortableProjections(),
    "projection",
  );
  const expected = canonicalEvidence(
    database.readExpectedPortableProjections(),
    "projection",
  );
  if (!actual || !expected || !equalStrings(actual, expected))
    throw new Error("projection-drift");
};

const executeMigrationTransaction = (
  database: LocalSqliteMigrationDatabase,
  compiled: readonly Readonly<{
    resource: LocalSqliteMigrationResource;
    statements: readonly string[];
  }>[],
  expectedMetadata: LocalSqliteDestinationMetadata,
): "current" | "migrated" => {
  if (!database.inTransaction()) throw new Error("transaction-missing");
  const ledger = readLedgerPrefix(database, compiled);
  if (ledger.length > 0) {
    const priorMetadata = Object.freeze({
      destinationFormat: LOCAL_SQLITE_DESTINATION_FORMAT,
      lifecycleCapabilityVersion: expectedMetadata.lifecycleCapabilityVersion,
      lifecycleFingerprint: expectedMetadata.lifecycleFingerprint,
      migrationManifestId: migrationManifestId(
        compiled.slice(0, ledger.length).map(({ resource }) => resource),
      ),
      protocolCompatibilityId:
        compiled[ledger.length - 1]!.resource.protocolCompatibilityId,
      recoveryHandlerId: expectedMetadata.recoveryHandlerId,
    });
    if (!snapshotMetadata(database.readDestinationMetadata(), priorMetadata))
      throw new Error("metadata-mismatch");
  }
  const beforeRows =
    ledger.length === 0
      ? Object.freeze([])
      : canonicalEvidence(database.readImmutableRows(), "immutable");
  if (!beforeRows) throw new Error("immutable-invalid");
  applyPendingMigrations(database, compiled, ledger.length);
  if (ledger.length < compiled.length) {
    database.writeDestinationMetadata(expectedMetadata);
    if (!database.inTransaction()) throw new Error("transaction-lost");
  }
  const candidateLedger = snapshotLedger(database.readMigrationLedger());
  if (!candidateLedger || !ledgerMatchesInventory(candidateLedger, compiled))
    throw new Error("ledger-incomplete");
  const candidateMetadata = snapshotMetadata(
    database.readDestinationMetadata(),
    expectedMetadata,
  );
  if (!candidateMetadata) throw new Error("metadata-incomplete");
  verifyCandidateEvidence(database, beforeRows);
  return ledger.length === compiled.length ? "current" : "migrated";
};

const reconciliationErrors = new Set([
  "ledger-incomplete",
  "ledger-invalid",
  "ledger-mismatch",
  "metadata-incomplete",
  "metadata-mismatch",
  "transaction-lost",
]);

const runMigrations = (
  database: LocalSqliteMigrationDatabase,
  inventory: unknown,
  lifecycleIdentity: LocalSqliteLifecycleMetadataIdentity = testLifecycleIdentity,
): LocalSqliteMigrationResult => {
  const compiled = compileInventory(inventory);
  if (!compiled)
    return Object.freeze({ ok: false, state: "invalid-inventory" });
  const expectedMetadata = Object.freeze({
    destinationFormat: LOCAL_SQLITE_DESTINATION_FORMAT,
    lifecycleCapabilityVersion: lifecycleIdentity.capabilityVersion,
    lifecycleFingerprint: lifecycleIdentity.fingerprint,
    migrationManifestId: migrationManifestId(
      compiled.map(({ resource }) => resource),
    ),
    protocolCompatibilityId: compiled.at(-1)!.resource.protocolCompatibilityId,
    recoveryHandlerId: lifecycleIdentity.recoveryHandlerId,
  });
  let began = false;
  let commitAttempted = false;
  let rollbackFailed = false;
  try {
    database.beginExclusive();
    began = true;
    const state = executeMigrationTransaction(
      database,
      compiled,
      expectedMetadata,
    );
    commitAttempted = true;
    database.commit();
    began = false;
    return Object.freeze({ ok: true, state });
  } catch (error) {
    if (began) {
      try {
        database.rollback();
      } catch {
        rollbackFailed = true;
      }
    }
    const state =
      rollbackFailed ||
      commitAttempted ||
      (error instanceof Error && reconciliationErrors.has(error.message))
        ? "reconciliation-required"
        : "failed";
    return Object.freeze({ ok: false, state });
  }
};

export const runLocalSqliteMigrations = (
  database: LocalSqliteMigrationDatabase,
  lifecycleIdentity: LocalSqliteLifecycleMetadataIdentity = testLifecycleIdentity,
): LocalSqliteMigrationResult =>
  runMigrations(database, LOCAL_SQLITE_MIGRATIONS, lifecycleIdentity);

export const compileLocalSqliteMigrationInventoryForTesting = compileInventory;
export const compileLocalSqliteMigrationSqlForTesting = compileStatements;
export const canonicalizeLocalSqliteEvidenceForTesting = canonicalEvidence;
export const runLocalSqliteMigrationsWithInventoryForTesting = runMigrations;
