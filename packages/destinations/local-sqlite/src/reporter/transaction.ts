import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  createDestinationReporter,
  createReporterReceipt,
  reporterDeadlineRemainingMilliseconds,
  type Reporter,
  type ReporterAttempt,
  type ReporterReceipt,
} from "@agentscope/destinations-core";
import {
  serializeRedactedCanonicalTrace,
  type RedactedCanonicalTrace,
} from "@agentscope/protocol";

export const LOCAL_SQLITE_REPORTER_POLICY_VERSION = 1 as const;
export const LOCAL_SQLITE_REPORTER_POLICY_MANIFEST = Object.freeze({
  version: LOCAL_SQLITE_REPORTER_POLICY_VERSION,
  maximumAgeNanoseconds: "31536000000000000",
  maximumForwardJumpNanoseconds: "3600000000000",
});

export type LocalSqliteReporterPolicy = Readonly<{
  maximumAgeNanoseconds: string;
  maximumTraceCount: number;
  maximumPayloadBytes: number;
}>;

export type LocalSqliteDimensionKind =
  "branch" | "harness" | "model" | "session" | "tag";

export type LocalSqlitePreparedDimension = Readonly<{
  kind: LocalSqliteDimensionKind;
  value: string;
  ordinal: number;
}>;

export type LocalSqlitePreparedTrace = Readonly<{
  deliveryIdentity: string;
  traceId: string;
  startTimeUnixNano: string;
  startTimeSortKey: string;
  admissionTimeUnixNano: string;
  admissionTimeSortKey: string;
  protocolCompatibilityId: string;
  payloadUtf8: string;
  payloadSha256: string;
  payloadBytes: number;
  dimensions: readonly LocalSqlitePreparedDimension[];
}>;

export type LocalSqliteStoredTraceEvidence = Readonly<{
  deliveryIdentity: string;
  traceId: string;
  admissionTimeUnixNano: string;
  protocolCompatibilityId: string;
  payloadSha256: string;
  payloadBytes: number;
}>;

export type LocalSqliteCapacityEvidence = Readonly<{
  traceCount: number;
  payloadBytes: number;
}>;

export type LocalSqliteReporterDatabase = Readonly<{
  beginImmediate: () => void;
  inTransaction: () => boolean;
  readLastTrustedTimeUnixNano: () => string | undefined;
  readExisting: (
    deliveryIdentities: readonly string[],
  ) => readonly LocalSqliteStoredTraceEvidence[];
  deleteExpiredBefore: (
    cutoffUnixNano: string,
    protectedDeliveryIdentities: readonly string[],
  ) => void;
  insertTrace: (
    trace: LocalSqlitePreparedTrace,
  ) => "inserted" | "uniqueness-conflict";
  readCapacity: () => LocalSqliteCapacityEvidence;
  evictOldestUntilWithin: (
    maximumTraceCount: number,
    maximumPayloadBytes: number,
    protectedDeliveryIdentities: readonly string[],
  ) => void;
  writeLastTrustedTimeUnixNano: (value: string) => void;
  commit: () => void;
  rollback: () => void;
}>;

export type LocalSqliteDatabaseFailureReason =
  | "destination-busy"
  | "destination-full"
  | "destination-corrupt"
  | "destination-migrating";

const maximumUint64 = 18_446_744_073_709_551_615n;
const maximumForwardJump = BigInt(
  LOCAL_SQLITE_REPORTER_POLICY_MANIFEST.maximumForwardJumpNanoseconds,
);
const uint64Pattern = /^(?:0|[1-9][0-9]{0,19})$/u;
const traceIdPattern = /^[a-f0-9]{32}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const deliveryIdentityPattern = /^[a-f0-9]{64}$/u;
const maximumPayloadBytes = 16 * 1024 * 1024;
const maximumProjectionValues = 256;
const maximumProjectionValueBytes = 1_024;
const databaseFailureRegistry = new WeakMap<
  object,
  LocalSqliteDatabaseFailureReason
>();

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
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor?.value as unknown;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maximum ||
      Reflect.ownKeys(descriptors).length !== length + 1
    )
      return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor)) return undefined;
      output.push(descriptor.value);
    }
    return output;
  } catch {
    return undefined;
  }
};

const parseUint64 = (value: unknown): bigint | undefined => {
  if (typeof value !== "string" || !uint64Pattern.test(value)) return undefined;
  const parsed = BigInt(value);
  return parsed <= maximumUint64 ? parsed : undefined;
};

const parsePolicy = (value: unknown): LocalSqliteReporterPolicy | undefined => {
  const record = exactRecord(value, [
    "maximumAgeNanoseconds",
    "maximumTraceCount",
    "maximumPayloadBytes",
  ]);
  if (!record) return undefined;
  const age = parseUint64(record.maximumAgeNanoseconds);
  if (
    age === undefined ||
    age === 0n ||
    age > BigInt(LOCAL_SQLITE_REPORTER_POLICY_MANIFEST.maximumAgeNanoseconds) ||
    typeof record.maximumTraceCount !== "number" ||
    !Number.isSafeInteger(record.maximumTraceCount) ||
    record.maximumTraceCount < 1 ||
    record.maximumTraceCount > 1_000_000 ||
    typeof record.maximumPayloadBytes !== "number" ||
    !Number.isSafeInteger(record.maximumPayloadBytes) ||
    record.maximumPayloadBytes < 1 ||
    record.maximumPayloadBytes > 10 * 1024 * 1024 * 1024
  )
    return undefined;
  return Object.freeze({
    maximumAgeNanoseconds: age.toString(),
    maximumTraceCount: record.maximumTraceCount,
    maximumPayloadBytes: record.maximumPayloadBytes,
  });
};

const snapshotDatabase = (
  value: unknown,
): LocalSqliteReporterDatabase | undefined => {
  const keys = [
    "beginImmediate",
    "inTransaction",
    "readLastTrustedTimeUnixNano",
    "readExisting",
    "deleteExpiredBefore",
    "insertTrace",
    "readCapacity",
    "evictOldestUntilWithin",
    "writeLastTrustedTimeUnixNano",
    "commit",
    "rollback",
  ] as const;
  const record = exactRecord(value, keys);
  if (!record || keys.some((key) => typeof record[key] !== "function"))
    return undefined;
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, record[key]])),
  ) as LocalSqliteReporterDatabase;
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const stringAttribute = (
  attributes:
    readonly { key: string; value: Record<string, unknown> }[] | undefined,
  key: string,
): string | undefined => {
  const value = attributes?.find((entry) => entry.key === key)?.value;
  return value !== undefined && typeof value.stringValue === "string"
    ? value.stringValue
    : undefined;
};

const stringArrayAttribute = (
  attributes:
    readonly { key: string; value: Record<string, unknown> }[] | undefined,
  key: string,
): readonly string[] => {
  const value = attributes?.find((entry) => entry.key === key)?.value;
  const values = (
    value?.arrayValue as { values?: Record<string, unknown>[] } | undefined
  )?.values;
  if (!Array.isArray(values)) return Object.freeze([]);
  return Object.freeze(
    values.flatMap((entry) => {
      /* v8 ignore else -- branded Protocol tag arrays contain only strings. */
      if (typeof entry.stringValue === "string") return [entry.stringValue];
      /* v8 ignore next -- unreachable under the branded Protocol contract. */
      return [];
    }),
  );
};

const exactProjectionValues = (
  values: readonly string[],
): readonly string[] => {
  const unique = [...new Set(values)].sort();
  /* v8 ignore next 8 -- branded Protocol projection values are already
   * bounded below these stricter local storage ceilings. */
  if (
    unique.length > maximumProjectionValues ||
    unique.some(
      (value) =>
        value.length === 0 ||
        value.length > maximumProjectionValueBytes ||
        Buffer.byteLength(value, "utf8") > maximumProjectionValueBytes,
    )
  )
    throw new Error("destination.local-sqlite.projection.invalid");
  return Object.freeze(unique);
};

const prepareTrace = (
  trace: RedactedCanonicalTrace,
  admissionTimeUnixNano: string,
): LocalSqlitePreparedTrace => {
  const payloadText = serializeRedactedCanonicalTrace(trace);
  const payloadBytes = Buffer.byteLength(payloadText, "utf8");
  /* v8 ignore next 2 -- Protocol's branded envelope has a positive 128 KiB
   * ceiling; this remains a local defense if that upstream contract drifts. */
  if (payloadBytes === 0 || payloadBytes > maximumPayloadBytes)
    throw new Error("destination.local-sqlite.payload.invalid");
  const resourceSpans = trace.graph.resourceSpans;
  const spans = resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) => scope.spans),
  );
  const roots = spans.filter((span) => span.parentSpanId === undefined);
  /* v8 ignore next -- branded Protocol graphs have exactly one root. */
  if (roots.length !== 1)
    throw new Error("destination.local-sqlite.graph.invalid");
  const root = roots[0]!;
  const resource = resourceSpans.find((candidate) =>
    candidate.scopeSpans.some((scope) => scope.spans.includes(root)),
  );
  /* v8 ignore next 2 -- branded Protocol graphs own both scalar grammars. */
  if (
    !traceIdPattern.test(root.traceId) ||
    parseUint64(root.startTimeUnixNano) === undefined
  )
    throw new Error("destination.local-sqlite.graph.invalid");
  const groups: readonly [LocalSqliteDimensionKind, readonly string[]][] = [
    [
      "branch",
      [
        stringAttribute(resource?.resource?.attributes, "vcs.ref.head.name"),
      ].flatMap(
        /* v8 ignore next -- optional omission is admitted and contributes no dimension. */
        (value) => (value === undefined ? [] : [value]),
      ),
    ],
    [
      "harness",
      [stringAttribute(root.attributes, "agentscope.harness.name")].flatMap(
        /* v8 ignore next -- optional omission is admitted and contributes no dimension. */
        (value) => (value === undefined ? [] : [value]),
      ),
    ],
    [
      "model",
      spans.flatMap((span) =>
        [
          "llm.model_name",
          "embedding.model_name",
          "reranker.model_name",
        ].flatMap((key) => {
          const value = stringAttribute(span.attributes, key);
          return value === undefined ? [] : [value];
        }),
      ),
    ],
    [
      "session",
      [stringAttribute(root.attributes, "session.id")].flatMap((value) =>
        value === undefined ? [] : [value],
      ),
    ],
    ["tag", stringArrayAttribute(root.attributes, "tag.tags")],
  ];
  const dimensions = groups.flatMap(([kind, values]) =>
    exactProjectionValues(values).map((value, ordinal) =>
      Object.freeze({ kind, value, ordinal }),
    ),
  );
  return Object.freeze({
    deliveryIdentity: trace.delivery.identity,
    traceId: root.traceId,
    startTimeUnixNano: root.startTimeUnixNano,
    startTimeSortKey: root.startTimeUnixNano.padStart(20, "0"),
    admissionTimeUnixNano,
    admissionTimeSortKey: admissionTimeUnixNano.padStart(20, "0"),
    protocolCompatibilityId: trace.protocolManifestId,
    payloadUtf8: payloadText,
    payloadSha256: sha256(payloadText),
    payloadBytes,
    dimensions: Object.freeze(dimensions),
  });
};

const snapshotStoredEvidence = (
  value: unknown,
  maximum: number,
): readonly LocalSqliteStoredTraceEvidence[] | undefined => {
  const candidates = exactArray(value, maximum);
  if (!candidates) return undefined;
  const output: LocalSqliteStoredTraceEvidence[] = [];
  const identities = new Set<string>();
  for (const candidate of candidates) {
    const record = exactRecord(candidate, [
      "deliveryIdentity",
      "traceId",
      "admissionTimeUnixNano",
      "protocolCompatibilityId",
      "payloadSha256",
      "payloadBytes",
    ]);
    if (
      !record ||
      typeof record.deliveryIdentity !== "string" ||
      !deliveryIdentityPattern.test(record.deliveryIdentity) ||
      identities.has(record.deliveryIdentity) ||
      typeof record.traceId !== "string" ||
      !traceIdPattern.test(record.traceId) ||
      parseUint64(record.admissionTimeUnixNano) === undefined ||
      typeof record.protocolCompatibilityId !== "string" ||
      record.protocolCompatibilityId.length === 0 ||
      Buffer.byteLength(record.protocolCompatibilityId, "utf8") > 1_024 ||
      typeof record.payloadSha256 !== "string" ||
      !sha256Pattern.test(record.payloadSha256) ||
      typeof record.payloadBytes !== "number" ||
      !Number.isSafeInteger(record.payloadBytes) ||
      record.payloadBytes < 1 ||
      record.payloadBytes > maximumPayloadBytes
    )
      return undefined;
    identities.add(record.deliveryIdentity);
    output.push(Object.freeze(record as LocalSqliteStoredTraceEvidence));
  }
  return Object.freeze(output);
};

const snapshotCapacity = (
  value: unknown,
): LocalSqliteCapacityEvidence | undefined => {
  const record = exactRecord(value, ["traceCount", "payloadBytes"]);
  if (
    !record ||
    typeof record.traceCount !== "number" ||
    !Number.isSafeInteger(record.traceCount) ||
    record.traceCount < 0 ||
    record.traceCount > 1_000_000 ||
    typeof record.payloadBytes !== "number" ||
    !Number.isSafeInteger(record.payloadBytes) ||
    record.payloadBytes < 0 ||
    record.payloadBytes > 10 * 1024 * 1024 * 1024
  )
    return undefined;
  return Object.freeze({
    traceCount: record.traceCount,
    payloadBytes: record.payloadBytes,
  });
};

const evidenceMatches = (
  evidence: LocalSqliteStoredTraceEvidence,
  trace: LocalSqlitePreparedTrace,
): boolean =>
  evidence.deliveryIdentity === trace.deliveryIdentity &&
  evidence.traceId === trace.traceId &&
  evidence.protocolCompatibilityId === trace.protocolCompatibilityId &&
  evidence.payloadSha256 === trace.payloadSha256 &&
  evidence.payloadBytes === trace.payloadBytes;

const unavailableForDatabaseFailure = (error: unknown): ReporterReceipt => {
  const reason = databaseFailureReason(error);
  return reason === undefined
    ? createReporterReceipt("unavailable")
    : createReporterReceipt("unavailable", reason);
};

type BeginResult =
  | Readonly<{ state: "begun" }>
  | Readonly<{ state: "begun-with-error"; error: unknown }>
  | Readonly<{ state: "settled"; receipt: ReporterReceipt }>;

const beginDatabaseTransaction = (
  database: LocalSqliteReporterDatabase,
): BeginResult => {
  try {
    database.beginImmediate();
  } catch (error) {
    try {
      return database.inTransaction()
        ? { state: "begun-with-error", error }
        : { state: "settled", receipt: unavailableForDatabaseFailure(error) };
    } catch {
      return {
        state: "settled",
        receipt: createReporterReceipt("outcome-unknown"),
      };
    }
  }
  try {
    return database.inTransaction()
      ? { state: "begun" }
      : {
          state: "settled",
          receipt: createReporterReceipt("unavailable"),
        };
  } catch {
    return {
      state: "settled",
      receipt: createReporterReceipt("outcome-unknown"),
    };
  }
};

type InsertResult =
  | Readonly<{ state: "retained"; admissionTimeUnixNano: string }>
  | Readonly<{
      state: "rejected";
      reason?: "destination-retention";
    }>;

const requireActiveTransaction = (
  database: LocalSqliteReporterDatabase,
): void => {
  if (!database.inTransaction()) throw new Error("transaction-lost");
};

const insertOrClassifyWinner = (
  database: LocalSqliteReporterDatabase,
  trace: LocalSqlitePreparedTrace,
  cutoff: bigint,
): InsertResult => {
  const insertion = database.insertTrace(trace);
  requireActiveTransaction(database);
  if (insertion === "inserted")
    return {
      state: "retained",
      admissionTimeUnixNano: trace.admissionTimeUnixNano,
    };
  if (insertion !== "uniqueness-conflict")
    throw new Error("insertion-result-invalid");
  const reread = snapshotStoredEvidence(
    database.readExisting([trace.deliveryIdentity]),
    1,
  );
  requireActiveTransaction(database);
  const winner = reread?.[0];
  if (!reread || reread.length !== 1 || winner === undefined)
    throw new Error("uniqueness-evidence-invalid");
  if (!evidenceMatches(winner, trace)) return { state: "rejected" };
  return BigInt(winner.admissionTimeUnixNano) < cutoff
    ? { state: "rejected", reason: "destination-retention" }
    : {
        state: "retained",
        admissionTimeUnixNano: winner.admissionTimeUnixNano,
      };
};

const confirmationMatches = (
  confirmed: readonly LocalSqliteStoredTraceEvidence[],
  prepared: readonly LocalSqlitePreparedTrace[],
  expectedAdmissionByIdentity: ReadonlyMap<string, string>,
): boolean =>
  confirmed.length === prepared.length &&
  prepared.every((trace) => {
    const evidence = confirmed.find(
      ({ deliveryIdentity }) => deliveryIdentity === trace.deliveryIdentity,
    );
    return (
      evidence !== undefined &&
      evidenceMatches(evidence, trace) &&
      evidence.admissionTimeUnixNano ===
        expectedAdmissionByIdentity.get(trace.deliveryIdentity)
    );
  });

const rollback = (database: LocalSqliteReporterDatabase): boolean => {
  try {
    if (!database.inTransaction()) return false;
    database.rollback();
    return database.inTransaction() === false;
  } catch {
    return false;
  }
};

const rejectedAfterRollback = (
  database: LocalSqliteReporterDatabase,
  reason?: "destination-retention" | "destination-capacity",
): ReporterReceipt =>
  rollback(database)
    ? createReporterReceipt("rejected", reason)
    : createReporterReceipt("outcome-unknown");

const databaseFailureReason = (
  value: unknown,
): LocalSqliteDatabaseFailureReason | undefined =>
  typeof value === "object" && value !== null
    ? databaseFailureRegistry.get(value)
    : undefined;

// One fail-closed transaction owns the complete classification, retention,
// capacity, confirmation, and receipt decision ledger.
/* eslint-disable complexity -- splitting this one transaction ledger would
 * divide commit and receipt authority. */
export const executePreparedLocalSqliteTransaction = (
  database: LocalSqliteReporterDatabase,
  policy: LocalSqliteReporterPolicy,
  prepared: readonly LocalSqlitePreparedTrace[],
  admissionTimeUnixNano: string,
  unavailable: () => boolean,
): ReporterReceipt => {
  let began = false;
  let commitAttempted = false;
  try {
    const operationTime = parseUint64(admissionTimeUnixNano)!;
    const maximumAge = BigInt(policy.maximumAgeNanoseconds);
    const identities = Object.freeze(
      prepared.map(({ deliveryIdentity }) => deliveryIdentity),
    );
    /* v8 ignore next 2 -- invokeReporter proves this immediately before
     * callback entry; later checks occur before the first mutation. */
    if (unavailable()) return createReporterReceipt("unavailable");
    const beginResult = beginDatabaseTransaction(database);
    if (beginResult.state === "settled") return beginResult.receipt;
    began = true;
    if (beginResult.state === "begun-with-error") throw beginResult.error;
    const priorTimeValue = database.readLastTrustedTimeUnixNano();
    requireActiveTransaction(database);
    const priorTime =
      priorTimeValue === undefined ? undefined : parseUint64(priorTimeValue);
    if (priorTimeValue !== undefined && priorTime === undefined)
      throw new Error("retention-state-invalid");
    if (
      priorTime !== undefined &&
      operationTime > priorTime &&
      operationTime - priorTime > maximumForwardJump
    ) {
      return rollback(database)
        ? createReporterReceipt("unavailable", "destination-retention")
        : createReporterReceipt("outcome-unknown");
    }
    const trustedTime =
      priorTime !== undefined && priorTime > operationTime
        ? priorTime
        : operationTime;
    const cutoff = trustedTime > maximumAge ? trustedTime - maximumAge : 0n;
    const existingValue = database.readExisting(identities);
    requireActiveTransaction(database);
    const existing = snapshotStoredEvidence(existingValue, identities.length);
    if (!existing) throw new Error("existing-invalid");
    const existingByIdentity = new Map(
      existing.map((entry) => [entry.deliveryIdentity, entry]),
    );
    const expectedAdmissionByIdentity = new Map<string, string>();
    for (const trace of prepared) {
      const prior = existingByIdentity.get(trace.deliveryIdentity);
      if (prior !== undefined && !evidenceMatches(prior, trace))
        return rejectedAfterRollback(database);
      const admission =
        prior?.admissionTimeUnixNano ?? trace.admissionTimeUnixNano;
      expectedAdmissionByIdentity.set(trace.deliveryIdentity, admission);
      if (BigInt(admission) < cutoff)
        return rejectedAfterRollback(database, "destination-retention");
    }
    if (unavailable())
      return rollback(database)
        ? createReporterReceipt("unavailable")
        : createReporterReceipt("outcome-unknown");
    database.deleteExpiredBefore(cutoff.toString(), identities);
    requireActiveTransaction(database);
    for (const trace of prepared)
      if (!existingByIdentity.has(trace.deliveryIdentity)) {
        const insertion = insertOrClassifyWinner(database, trace, cutoff);
        if (insertion.state === "rejected")
          return rejectedAfterRollback(database, insertion.reason);
        expectedAdmissionByIdentity.set(
          trace.deliveryIdentity,
          insertion.admissionTimeUnixNano,
        );
      }
    let capacity = snapshotCapacity(database.readCapacity());
    requireActiveTransaction(database);
    if (!capacity) throw new Error("capacity-invalid");
    if (
      capacity.traceCount > policy.maximumTraceCount ||
      capacity.payloadBytes > policy.maximumPayloadBytes
    ) {
      database.evictOldestUntilWithin(
        policy.maximumTraceCount,
        policy.maximumPayloadBytes,
        identities,
      );
      requireActiveTransaction(database);
      capacity = snapshotCapacity(database.readCapacity());
      requireActiveTransaction(database);
      if (!capacity) throw new Error("capacity-invalid");
      if (
        capacity.traceCount > policy.maximumTraceCount ||
        capacity.payloadBytes > policy.maximumPayloadBytes
      )
        return rejectedAfterRollback(database, "destination-capacity");
    }
    const confirmedValue = database.readExisting(identities);
    requireActiveTransaction(database);
    const confirmed = snapshotStoredEvidence(confirmedValue, identities.length);
    if (
      !confirmed ||
      !confirmationMatches(confirmed, prepared, expectedAdmissionByIdentity)
    )
      throw new Error("confirmation-invalid");
    database.writeLastTrustedTimeUnixNano(trustedTime.toString());
    requireActiveTransaction(database);
    commitAttempted = true;
    database.commit();
    if (database.inTransaction()) throw new Error("commit-incomplete");
    return createReporterReceipt("accepted");
  } catch (error) {
    if (commitAttempted || (began && !rollback(database)))
      return createReporterReceipt("outcome-unknown");
    return unavailableForDatabaseFailure(error);
  }
};
/* eslint-enable complexity */

export const createLocalSqliteDatabaseFailure = (
  reason: LocalSqliteDatabaseFailureReason,
): Error => {
  const error = new Error("destination.local-sqlite.unavailable");
  databaseFailureRegistry.set(error, reason);
  return error;
};

export const prepareLocalSqliteTrace = prepareTrace;

export const createLocalSqliteReporter = (
  databaseInput: unknown,
  policyInput: unknown,
): Reporter => {
  const database = snapshotDatabase(databaseInput);
  const policy = parsePolicy(policyInput);
  if (!database || !policy)
    throw new Error("destination.local-sqlite.reporter.invalid");
  return createDestinationReporter({
    report: (attempt: ReporterAttempt) => {
      const prepared = attempt.traces.map((trace) =>
        prepareTrace(trace, attempt.admissionTimeUnixNano),
      );
      return Promise.resolve(
        executePreparedLocalSqliteTransaction(
          database,
          policy,
          prepared,
          attempt.admissionTimeUnixNano,
          () =>
            attempt.signal.aborted ||
            reporterDeadlineRemainingMilliseconds(attempt.deadline) === 0,
        ),
      );
    },
  });
};
