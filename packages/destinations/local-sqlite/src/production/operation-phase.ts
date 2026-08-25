export const LOCAL_SQLITE_OPERATION_PHASE_NAME = "operation-phase-v1.json";

export type LocalSqliteOperationPhase = Readonly<{
  schemaVersion: 1;
  operation: "backup" | "configure" | "delete" | "restore";
  phase:
    | "backup-published"
    | "configured-active"
    | "database-deleted"
    | "restore-rolled-back"
    | "restore-verified";
  transactionId: string;
  lifecycleFingerprint: string;
  artifactGrammarFingerprint: string;
  artifactPhysicalIdentity: string;
}>;

const valid = (record: Readonly<Record<string, unknown>>): boolean =>
  record.schemaVersion === 1 &&
  typeof record.transactionId === "string" &&
  /^(?!0{32}$)[a-f0-9]{32}$/u.test(record.transactionId) &&
  typeof record.lifecycleFingerprint === "string" &&
  /^sha256-[a-f0-9]{64}$/u.test(record.lifecycleFingerprint) &&
  typeof record.artifactGrammarFingerprint === "string" &&
  /^sha256-[a-f0-9]{64}$/u.test(record.artifactGrammarFingerprint) &&
  typeof record.artifactPhysicalIdentity === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9:._-]{0,191}$/u.test(
    record.artifactPhysicalIdentity,
  ) &&
  ((record.operation === "backup" && record.phase === "backup-published") ||
    (record.operation === "configure" &&
      record.phase === "configured-active") ||
    (record.operation === "delete" && record.phase === "database-deleted") ||
    (record.operation === "restore" &&
      (record.phase === "restore-verified" ||
        record.phase === "restore-rolled-back")));

export const decodeLocalSqliteOperationPhase = (
  canonicalBytes: string,
): LocalSqliteOperationPhase | undefined => {
  try {
    if (
      Buffer.byteLength(canonicalBytes, "utf8") > 2_048 ||
      !canonicalBytes.endsWith("\n")
    )
      return undefined;
    const value = JSON.parse(canonicalBytes) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = [
      "schemaVersion",
      "operation",
      "phase",
      "transactionId",
      "lifecycleFingerprint",
      "artifactGrammarFingerprint",
      "artifactPhysicalIdentity",
    ];
    if (
      Reflect.ownKeys(descriptors).length !== keys.length ||
      Reflect.ownKeys(descriptors).some(
        (key) => typeof key !== "string" || !keys.includes(key),
      )
    )
      return undefined;
    const record: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of keys) {
      const descriptor = descriptors[key];
      /* v8 ignore next -- JSON.parse creates an own data descriptor for every key whose exact cardinality was just proved. */
      if (descriptor === undefined || !("value" in descriptor))
        return undefined;
      record[key] = descriptor.value;
    }
    if (!valid(record)) return undefined;
    const phase = Object.freeze(record) as LocalSqliteOperationPhase;
    return `${JSON.stringify(phase)}\n` === canonicalBytes ? phase : undefined;
  } catch {
    return undefined;
  }
};

export const encodeLocalSqliteOperationPhase = (
  phase: LocalSqliteOperationPhase,
): string => {
  const canonicalBytes = `${JSON.stringify(phase)}\n`;
  if (decodeLocalSqliteOperationPhase(canonicalBytes) === undefined)
    throw new Error("destination.local-sqlite.operation-phase.invalid");
  return canonicalBytes;
};
