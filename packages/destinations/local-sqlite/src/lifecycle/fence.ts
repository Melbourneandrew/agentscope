const HEX_128 = /^[a-f0-9]{32}$/u;
const SHA256 = /^sha256-[a-f0-9]{64}$/u;
const PHYSICAL_IDENTITY = /^[\x21-\x7e]{1,128}$/u;
const LEASE_RECORD_BYTES = 256;
const MAXIMUM_FENCE_RECORD_BYTES = 32_768;
const MAXIMUM_DIRECTORY_ENTRIES = 192;
const MAXIMUM_INSPECTION_BYTES = 98_304;
const MAXIMUM_LEASES = 64;
const MAXIMUM_CLEANUP_CLAIMS = 64;
const FENCE_NAME = "exclusive-fence-v1";

type OwnerIdentity = Readonly<{
  pid: number;
  startIdentity: string;
}>;

type ChildIdentity = Readonly<{
  nonce: string;
  pid: number;
  startIdentity: string;
}>;

export type LocalSqliteLeaseRecord = Readonly<{
  leaseId: string;
  lifecycleFingerprint: string;
  lifecycleGeneration: number;
  parent: OwnerIdentity;
  child: ChildIdentity | null;
}>;

type LocalSqliteLifecycleFenceRecord = Readonly<{
  transactionId: string;
  lifecycleFingerprint: string;
  lifecycleGeneration: number;
  purpose: "lifecycle";
}>;

export type LocalSqliteLeaseCleanupState =
  "lease-only" | "lease+cleanup-claim" | "cleanup-claim-only";

export type LocalSqliteDeadLeaseRecoveryEntry = Readonly<{
  originalState: LocalSqliteLeaseCleanupState;
  physicalIdentity: string;
  record: LocalSqliteLeaseRecord;
}>;

export type LocalSqliteRecoveryFenceRecord = Readonly<{
  transactionId: string;
  lifecycleFingerprint: string;
  lifecycleGeneration: number;
  purpose: "recovery";
  recoveryOwner: OwnerIdentity;
  deadLeaseVector: readonly LocalSqliteDeadLeaseRecoveryEntry[];
}>;

export type LocalSqliteFenceRecord =
  LocalSqliteLifecycleFenceRecord | LocalSqliteRecoveryFenceRecord;

export type LocalSqliteSharedLeaseAuthority = Readonly<{
  state: "shared";
  filename: string;
  physicalIdentity: string;
  record: LocalSqliteLeaseRecord;
}>;

type LocalSqliteExclusiveFenceAuthorityBase = Readonly<{
  filename: typeof FENCE_NAME;
  physicalIdentity: string;
  record: LocalSqliteFenceRecord;
  deadLeaseNames: readonly string[];
}>;

export type LocalSqliteExclusiveFenceAuthority =
  | (LocalSqliteExclusiveFenceAuthorityBase & Readonly<{ state: "exclusive" }>)
  | (LocalSqliteExclusiveFenceAuthorityBase &
      Readonly<{
        state: "exclusive-recovery";
        recoveryLockToken: Readonly<Record<string, never>>;
        recoveryVector: readonly LocalSqliteDeadLeaseRecoveryEntry[];
      }>);

export type LocalSqliteLifecycleGateFailure = Readonly<{
  ok: false;
  state:
    "busy" | "reconciliation-required" | "recovery-required" | "unavailable";
}>;

export type LocalSqliteSharedLeaseResult =
  | Readonly<{ ok: true; value: LocalSqliteSharedLeaseAuthority }>
  | LocalSqliteLifecycleGateFailure;

export type LocalSqliteExclusiveFenceResult =
  | Readonly<{ ok: true; value: LocalSqliteExclusiveFenceAuthority }>
  | LocalSqliteLifecycleGateFailure;

export type LocalSqliteDeadLeaseRecoveryPlanResult =
  | Readonly<{ ok: true; value: LocalSqliteRecoveryFenceRecord }>
  | LocalSqliteLifecycleGateFailure;

export type LocalSqliteLifecycleGatePort = Readonly<{
  acquireRecoveryFenceLock: (
    input: Readonly<{ filename: string; physicalIdentity: string }>,
  ) => unknown;
  assertRecoveryFenceLock: (
    input: Readonly<{
      filename: string;
      physicalIdentity: string;
      token: Readonly<Record<string, never>>;
    }>,
  ) => unknown;
  classifyOwner: (input: Readonly<{ owner: OwnerIdentity }>) => unknown;
  createFenceDurably: (
    input: Readonly<{ filename: string; content: string }>,
  ) => unknown;
  createLeaseDurably: (
    input: Readonly<{ filename: string; content: string }>,
  ) => unknown;
  createLeaseCleanupClaim: (
    input: Readonly<{
      cleanupClaimName: string;
      leaseName: string;
      leasePhysicalIdentity: string;
    }>,
  ) => unknown;
  listLifecycle: () => unknown;
  readArtifact: (input: Readonly<{ filename: string }>) => unknown;
  removeArtifactIfIdentity: (
    input: Readonly<{ filename: string; physicalIdentity: string }>,
  ) => unknown;
  releaseRecoveryFenceLock: (
    input: Readonly<{
      filename: string;
      physicalIdentity: string;
      token: Readonly<Record<string, never>>;
    }>,
  ) => unknown;
  replaceLeaseDurably: (
    input: Readonly<{
      filename: string;
      physicalIdentity: string;
      content: string;
    }>,
  ) => unknown;
}>;

type ParsedPort = LocalSqliteLifecycleGatePort;
type ArtifactRead =
  | Readonly<{ state: "absent" }>
  | Readonly<{
      state: "present";
      physicalIdentity: string;
      content: string;
    }>;
type MutationResult =
  | Readonly<{ state: "created" | "replaced"; physicalIdentity: string }>
  | Readonly<{ state: "exists" | "mismatch" | "absent" }>;
type RemoveResult = Readonly<{ state: "removed" | "mismatch" | "absent" }>;
type InventoryEntry = Readonly<{
  name: string;
  bytes: number;
  physicalIdentity: string;
}>;

const failure = (
  state: LocalSqliteLifecycleGateFailure["state"],
): LocalSqliteLifecycleGateFailure => Object.freeze({ ok: false, state });

const exactRecord = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined => {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(
      value,
    ) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const actual = Reflect.ownKeys(descriptors);
    if (
      actual.some((key) => typeof key !== "string" || !keys.includes(key)) ||
      keys.some((key) => !(key in descriptors))
    )
      return undefined;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor))
        return undefined;
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
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
    const descriptors = Object.getOwnPropertyDescriptors(
      value,
    ) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(
      value,
      "length",
    ) as {
      value: number;
    };
    const length = lengthDescriptor.value;
    if (length > maximum) return undefined;
    const expected = new Set([
      "length",
      ...Array.from({ length }, (_, index) => String(index)),
    ]);
    if (
      Reflect.ownKeys(descriptors).length !== expected.size ||
      Reflect.ownKeys(descriptors).some(
        (key) => typeof key !== "string" || !expected.has(key),
      )
    )
      return undefined;
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor))
        return undefined;
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch {
    return undefined;
  }
};

const validInteger = (value: unknown, maximum: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= maximum;

const validHex128 = (value: unknown): value is string =>
  typeof value === "string" &&
  HEX_128.test(value) &&
  value !== "00000000000000000000000000000000";

const isOneOf = <Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): value is Value =>
  typeof value === "string" && allowed.includes(value as Value);

const parseOwner = (value: unknown): OwnerIdentity | undefined => {
  const record = exactRecord(value, ["pid", "startIdentity"]);
  if (
    record === undefined ||
    !validInteger(record.pid, 2_147_483_647) ||
    !validHex128(record.startIdentity)
  )
    return undefined;
  return Object.freeze({
    pid: record.pid,
    startIdentity: record.startIdentity,
  });
};

const parseChild = (value: unknown): ChildIdentity | null | undefined => {
  if (value === null) return null;
  const record = exactRecord(value, ["nonce", "pid", "startIdentity"]);
  if (
    record === undefined ||
    !validHex128(record.nonce) ||
    !validInteger(record.pid, 2_147_483_647) ||
    !validHex128(record.startIdentity)
  )
    return undefined;
  return Object.freeze({
    nonce: record.nonce,
    pid: record.pid,
    startIdentity: record.startIdentity,
  });
};

export const parseLocalSqliteLeaseRecord = (
  value: unknown,
): LocalSqliteLeaseRecord | undefined => {
  const record = exactRecord(value, [
    "leaseId",
    "lifecycleFingerprint",
    "lifecycleGeneration",
    "parent",
    "child",
  ]);
  if (record === undefined) return undefined;
  const parent = parseOwner(record.parent);
  const child = parseChild(record.child);
  if (
    !validHex128(record.leaseId) ||
    typeof record.lifecycleFingerprint !== "string" ||
    !SHA256.test(record.lifecycleFingerprint) ||
    !validInteger(record.lifecycleGeneration, 2_147_483_647) ||
    parent === undefined ||
    child === undefined
  )
    return undefined;
  return Object.freeze({
    leaseId: record.leaseId,
    lifecycleFingerprint: record.lifecycleFingerprint,
    lifecycleGeneration: record.lifecycleGeneration,
    parent,
    child,
  });
};

const cleanupStateRank = (state: LocalSqliteLeaseCleanupState): number =>
  state === "lease-only" ? 0 : state === "lease+cleanup-claim" ? 1 : 2;

const parseDeadLeaseRecoveryVector = (
  value: unknown,
  lifecycle?: Readonly<{
    lifecycleFingerprint: string;
    lifecycleGeneration: number;
  }>,
): readonly LocalSqliteDeadLeaseRecoveryEntry[] | undefined => {
  const values = exactArray(value, MAXIMUM_LEASES);
  if (values === undefined || values.length === 0) return undefined;
  const entries: LocalSqliteDeadLeaseRecoveryEntry[] = [];
  let previousLeaseId: string | undefined;
  for (const value of values) {
    const entry = exactRecord(value, [
      "originalState",
      "physicalIdentity",
      "record",
    ]);
    const record = parseLocalSqliteLeaseRecord(entry?.record);
    if (
      entry === undefined ||
      !isOneOf(entry.originalState, [
        "lease-only",
        "lease+cleanup-claim",
        "cleanup-claim-only",
      ]) ||
      typeof entry.physicalIdentity !== "string" ||
      !PHYSICAL_IDENTITY.test(entry.physicalIdentity) ||
      record === undefined ||
      (previousLeaseId !== undefined && record.leaseId <= previousLeaseId) ||
      (lifecycle !== undefined &&
        (record.lifecycleFingerprint !== lifecycle.lifecycleFingerprint ||
          record.lifecycleGeneration !== lifecycle.lifecycleGeneration))
    )
      return undefined;
    previousLeaseId = record.leaseId;
    entries.push(
      Object.freeze({
        originalState: entry.originalState,
        physicalIdentity: entry.physicalIdentity,
        record,
      }),
    );
  }
  return Object.freeze(entries);
};

export const parseLocalSqliteFenceRecord = (
  value: unknown,
): LocalSqliteFenceRecord | undefined => {
  const commonKeys = [
    "transactionId",
    "lifecycleFingerprint",
    "lifecycleGeneration",
    "purpose",
  ];
  const record =
    exactRecord(value, [...commonKeys, "recoveryOwner", "deadLeaseVector"]) ??
    exactRecord(value, commonKeys);
  if (
    record === undefined ||
    !validHex128(record.transactionId) ||
    typeof record.lifecycleFingerprint !== "string" ||
    !SHA256.test(record.lifecycleFingerprint) ||
    !validInteger(record.lifecycleGeneration, 2_147_483_647) ||
    !isOneOf(record.purpose, ["lifecycle", "recovery"])
  )
    return undefined;
  const common = Object.freeze({
    transactionId: record.transactionId,
    lifecycleFingerprint: record.lifecycleFingerprint,
    lifecycleGeneration: record.lifecycleGeneration,
  });
  if (record.purpose === "lifecycle")
    return Object.freeze({ ...common, purpose: "lifecycle" as const });
  const recoveryOwner = parseOwner(record.recoveryOwner);
  const deadLeaseVector = parseDeadLeaseRecoveryVector(
    record.deadLeaseVector,
    common,
  );
  return recoveryOwner === undefined || deadLeaseVector === undefined
    ? undefined
    : Object.freeze({
        ...common,
        purpose: "recovery" as const,
        recoveryOwner,
        deadLeaseVector,
      });
};

const encodeParsedLeaseRecord = (record: LocalSqliteLeaseRecord): string =>
  JSON.stringify([
    1,
    record.leaseId,
    record.lifecycleFingerprint.slice("sha256-".length),
    record.lifecycleGeneration,
    [record.parent.pid, record.parent.startIdentity],
    record.child === null
      ? null
      : [record.child.nonce, record.child.pid, record.child.startIdentity],
  ]).padEnd(LEASE_RECORD_BYTES, " ");

export const encodeLocalSqliteLeaseRecord = (
  value: unknown,
): string | undefined => {
  const record = parseLocalSqliteLeaseRecord(value);
  return record === undefined ? undefined : encodeParsedLeaseRecord(record);
};

const compactLeaseRecord = (
  record: LocalSqliteLeaseRecord,
): readonly unknown[] =>
  Object.freeze([
    record.leaseId,
    record.parent.pid,
    record.parent.startIdentity,
    record.child === null
      ? null
      : Object.freeze([
          record.child.nonce,
          record.child.pid,
          record.child.startIdentity,
        ]),
  ]);

const encodeParsedFenceRecord = (record: LocalSqliteFenceRecord): string => {
  if (record.purpose === "lifecycle")
    return JSON.stringify([
      1,
      record.transactionId,
      record.lifecycleFingerprint.slice("sha256-".length),
      record.lifecycleGeneration,
      record.purpose,
    ]).padEnd(LEASE_RECORD_BYTES, " ");
  return JSON.stringify([
    2,
    record.transactionId,
    record.lifecycleFingerprint.slice("sha256-".length),
    record.lifecycleGeneration,
    record.purpose,
    [record.recoveryOwner.pid, record.recoveryOwner.startIdentity],
    record.deadLeaseVector.map((entry) => [
      entry.originalState,
      entry.physicalIdentity,
      compactLeaseRecord(entry.record),
    ]),
  ]);
};

export const encodeLocalSqliteFenceRecord = (
  value: unknown,
): string | undefined => {
  const record = parseLocalSqliteFenceRecord(value);
  if (record === undefined) return undefined;
  const content = encodeParsedFenceRecord(record);
  return content.length <= MAXIMUM_FENCE_RECORD_BYTES ? content : undefined;
};

export const decodeLocalSqliteLeaseRecord = (
  content: unknown,
): LocalSqliteLeaseRecord | undefined => {
  if (
    typeof content !== "string" ||
    content.length !== LEASE_RECORD_BYTES ||
    /[^\x20-\x7e]/u.test(content)
  )
    return undefined;
  try {
    const compact = exactArray(JSON.parse(content.trimEnd()), 6);
    if (compact?.length !== 6 || compact[0] !== 1) return undefined;
    const parentArray = exactArray(compact[4], 2);
    const childArray = compact[5] === null ? null : exactArray(compact[5], 3);
    if (
      parentArray?.length !== 2 ||
      (childArray !== null && childArray?.length !== 3)
    )
      return undefined;
    const parsed = parseLocalSqliteLeaseRecord({
      leaseId: compact[1],
      lifecycleFingerprint: `sha256-${String(compact[2])}`,
      lifecycleGeneration: compact[3],
      parent: { pid: parentArray[0], startIdentity: parentArray[1] },
      child:
        childArray === null
          ? null
          : {
              nonce: childArray[0],
              pid: childArray[1],
              startIdentity: childArray[2],
            },
    });
    return parsed !== undefined &&
      encodeLocalSqliteLeaseRecord(parsed) === content
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
};

export const decodeLocalSqliteFenceRecord = (
  content: unknown,
): LocalSqliteFenceRecord | undefined => {
  if (
    typeof content !== "string" ||
    content.length < 1 ||
    content.length > MAXIMUM_FENCE_RECORD_BYTES ||
    /[^\x20-\x7e]/u.test(content)
  )
    return undefined;
  try {
    const compact = exactArray(JSON.parse(content.trimEnd()), 7);
    if (compact === undefined) return undefined;
    let candidate: unknown;
    if (compact.length === 5 && compact[0] === 1)
      candidate = {
        transactionId: compact[1],
        lifecycleFingerprint: `sha256-${String(compact[2])}`,
        lifecycleGeneration: compact[3],
        purpose: compact[4],
      };
    else if (compact.length === 7 && compact[0] === 2) {
      const owner = exactArray(compact[5], 2);
      const vector = exactArray(compact[6], MAXIMUM_LEASES);
      if (owner?.length !== 2 || vector === undefined) return undefined;
      const entries: unknown[] = [];
      for (const value of vector) {
        const entry = exactArray(value, 3);
        const lease = exactArray(entry?.[2], 4);
        const child = lease?.[3] === null ? null : exactArray(lease?.[3], 3);
        if (
          entry?.length !== 3 ||
          lease?.length !== 4 ||
          (child !== null && child?.length !== 3)
        )
          return undefined;
        entries.push({
          originalState: entry[0],
          physicalIdentity: entry[1],
          record: {
            leaseId: lease[0],
            lifecycleFingerprint: `sha256-${String(compact[2])}`,
            lifecycleGeneration: compact[3],
            parent: { pid: lease[1], startIdentity: lease[2] },
            child:
              child === null
                ? null
                : {
                    nonce: child[0],
                    pid: child[1],
                    startIdentity: child[2],
                  },
          },
        });
      }
      candidate = {
        transactionId: compact[1],
        lifecycleFingerprint: `sha256-${String(compact[2])}`,
        lifecycleGeneration: compact[3],
        purpose: compact[4],
        recoveryOwner: { pid: owner[0], startIdentity: owner[1] },
        deadLeaseVector: entries,
      };
    } else return undefined;
    const parsed = parseLocalSqliteFenceRecord(candidate);
    return parsed !== undefined &&
      encodeLocalSqliteFenceRecord(parsed) === content
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
};

const parsePort = (value: unknown): ParsedPort | undefined => {
  const keys = [
    "acquireRecoveryFenceLock",
    "assertRecoveryFenceLock",
    "classifyOwner",
    "createFenceDurably",
    "createLeaseDurably",
    "createLeaseCleanupClaim",
    "listLifecycle",
    "readArtifact",
    "removeArtifactIfIdentity",
    "releaseRecoveryFenceLock",
    "replaceLeaseDurably",
  ];
  const record = exactRecord(value, keys);
  if (
    record === undefined ||
    keys.some((key) => typeof record[key] !== "function")
  )
    return undefined;
  return Object.freeze(record) as ParsedPort;
};

const invoke = async (
  callback: (...args: never[]) => unknown,
  input?: unknown,
): Promise<unknown> => {
  try {
    return await Promise.resolve(
      input === undefined
        ? callback()
        : callback(Object.freeze(input) as never),
    );
  } catch {
    return undefined;
  }
};

const parseArtifactRead = (value: unknown): ArtifactRead | undefined => {
  const base = exactRecord(value, ["state"]);
  if (base?.state === "absent") return Object.freeze({ state: "absent" });
  const record = exactRecord(value, ["state", "physicalIdentity", "content"]);
  if (
    record?.state !== "present" ||
    typeof record.physicalIdentity !== "string" ||
    !PHYSICAL_IDENTITY.test(record.physicalIdentity) ||
    typeof record.content !== "string"
  )
    return undefined;
  return Object.freeze({
    state: "present",
    physicalIdentity: record.physicalIdentity,
    content: record.content,
  });
};

const parseMutation = (value: unknown): MutationResult | undefined => {
  const base = exactRecord(value, ["state"]);
  if (isOneOf(base?.state, ["exists", "mismatch", "absent"]))
    return Object.freeze({ state: base.state });
  const record = exactRecord(value, ["state", "physicalIdentity"]);
  if (
    !isOneOf(record?.state, ["created", "replaced"]) ||
    typeof record?.physicalIdentity !== "string" ||
    !PHYSICAL_IDENTITY.test(record.physicalIdentity)
  )
    return undefined;
  return Object.freeze({
    state: record.state,
    physicalIdentity: record.physicalIdentity,
  });
};

const parseRemove = (value: unknown): RemoveResult | undefined => {
  const record = exactRecord(value, ["state"]);
  if (!isOneOf(record?.state, ["removed", "mismatch", "absent"]))
    return undefined;
  return Object.freeze({ state: record.state });
};

const parseLockToken = (
  value: unknown,
): Readonly<Record<string, never>> | undefined => {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== 0 ||
      !Object.isFrozen(value)
    )
      return undefined;
    return value as Readonly<Record<string, never>>;
  } catch {
    return undefined;
  }
};

const acquireRecoveryLock = async (
  port: ParsedPort,
  physicalIdentity: string,
): Promise<
  | Readonly<{ state: "acquired"; token: Readonly<Record<string, never>> }>
  | Readonly<{ state: "busy" }>
  | undefined
> => {
  const result = await invoke(port.acquireRecoveryFenceLock, {
    filename: FENCE_NAME,
    physicalIdentity,
  });
  const base = exactRecord(result, ["state"]);
  if (base?.state === "busy") return Object.freeze({ state: "busy" });
  const acquired = exactRecord(result, ["state", "token"]);
  const token = parseLockToken(acquired?.token);
  return acquired?.state === "acquired" && token !== undefined
    ? Object.freeze({ state: "acquired", token })
    : undefined;
};

const assertRecoveryLock = async (
  port: ParsedPort,
  physicalIdentity: string,
  token: Readonly<Record<string, never>>,
): Promise<boolean> =>
  exactRecord(
    await invoke(port.assertRecoveryFenceLock, {
      filename: FENCE_NAME,
      physicalIdentity,
      token,
    }),
    ["state"],
  )?.state === "held";

const releaseRecoveryLock = async (
  port: ParsedPort,
  physicalIdentity: string,
  token: Readonly<Record<string, never>>,
): Promise<boolean> =>
  exactRecord(
    await invoke(port.releaseRecoveryFenceLock, {
      filename: FENCE_NAME,
      physicalIdentity,
      token,
    }),
    ["state"],
  )?.state === "released";

const knownLifecycleName = (name: string): boolean =>
  name === FENCE_NAME ||
  name === "intent-v1.json" ||
  name === "operation-phase-v1.json" ||
  name === "ownership-receipt-v1.json" ||
  /^lease-[a-f0-9]{32}\.json$/u.test(name) ||
  /^lease-cleanup-[a-f0-9]{32}\.json$/u.test(name);

const parseInventory = (
  value: unknown,
): readonly InventoryEntry[] | undefined => {
  const record = exactRecord(value, ["entries"]);
  const values = exactArray(record?.entries, MAXIMUM_DIRECTORY_ENTRIES);
  if (values === undefined) return undefined;
  const entries: InventoryEntry[] = [];
  const names = new Set<string>();
  let bytes = 0;
  let leases = 0;
  let cleanupClaims = 0;
  for (const value of values) {
    const entry = exactRecord(value, ["name", "bytes", "physicalIdentity"]);
    if (
      entry === undefined ||
      typeof entry.name !== "string" ||
      !knownLifecycleName(entry.name) ||
      names.has(entry.name) ||
      !validInteger(entry.bytes, MAXIMUM_INSPECTION_BYTES) ||
      typeof entry.physicalIdentity !== "string" ||
      !PHYSICAL_IDENTITY.test(entry.physicalIdentity)
    )
      return undefined;
    bytes += entry.bytes;
    if (!Number.isSafeInteger(bytes) || bytes > MAXIMUM_INSPECTION_BYTES)
      return undefined;
    if (entry.name.startsWith("lease-")) {
      leases += 1;
      if (entry.bytes !== LEASE_RECORD_BYTES || leases > MAXIMUM_LEASES)
        return undefined;
    }
    if (
      entry.name === FENCE_NAME &&
      (entry.bytes < 1 || entry.bytes > MAXIMUM_FENCE_RECORD_BYTES)
    )
      return undefined;
    if (entry.name.startsWith("lease-cleanup-")) {
      cleanupClaims += 1;
      if (
        entry.bytes !== LEASE_RECORD_BYTES ||
        cleanupClaims > MAXIMUM_CLEANUP_CLAIMS
      )
        return undefined;
    }
    names.add(entry.name);
    entries.push(
      Object.freeze({
        name: entry.name,
        bytes: entry.bytes,
        physicalIdentity: entry.physicalIdentity,
      }),
    );
  }
  return Object.freeze(
    entries.sort((left, right) => left.name.localeCompare(right.name)),
  );
};

const leaseName = (leaseId: string): string => `lease-${leaseId}.json`;
const cleanupClaimName = (leaseId: string): string =>
  `lease-cleanup-${leaseId}.json`;

const readArtifact = async (
  port: ParsedPort,
  filename: string,
): Promise<ArtifactRead | undefined> =>
  parseArtifactRead(await invoke(port.readArtifact, { filename }));

const removeExact = async (
  port: ParsedPort,
  filename: string,
  physicalIdentity: string,
): Promise<boolean> =>
  parseRemove(
    await invoke(port.removeArtifactIfIdentity, {
      filename,
      physicalIdentity,
    }),
  )?.state === "removed";

const readValidatedLease = async (
  port: ParsedPort,
  filename: string,
  physicalIdentity?: string,
): Promise<
  | Readonly<{
      artifact: ArtifactRead & { state: "present" };
      record: LocalSqliteLeaseRecord;
    }>
  | undefined
> => {
  const artifact = await readArtifact(port, filename);
  if (
    artifact?.state !== "present" ||
    (physicalIdentity !== undefined &&
      artifact.physicalIdentity !== physicalIdentity)
  )
    return undefined;
  const record = decodeLocalSqliteLeaseRecord(artifact.content);
  if (record === undefined || leaseName(record.leaseId) !== filename)
    return undefined;
  return Object.freeze({ artifact, record });
};

type LeaseCleanupState =
  | Readonly<{ state: "absent" }>
  | Readonly<{
      state: "lease-only" | "cleanup-claim-only" | "lease+cleanup-claim";
      record: LocalSqliteLeaseRecord;
      content: string;
      physicalIdentity: string;
    }>;

const inspectLeaseCleanupState = async (
  port: ParsedPort,
  leaseId: string,
): Promise<LeaseCleanupState | undefined> => {
  const leaseFilename = leaseName(leaseId);
  const claimFilename = cleanupClaimName(leaseId);
  const [lease, claim] = await Promise.all([
    readArtifact(port, leaseFilename),
    readArtifact(port, claimFilename),
  ]);
  if (lease === undefined || claim === undefined) return undefined;
  if (lease.state === "absent" && claim.state === "absent")
    return Object.freeze({ state: "absent" });
  const present = lease.state === "present" ? lease : claim;
  if (present.state !== "present") return undefined;
  const record = decodeLocalSqliteLeaseRecord(present.content);
  if (record === undefined || record.leaseId !== leaseId) return undefined;
  if (lease.state === "present" && claim.state === "present") {
    if (
      lease.physicalIdentity !== claim.physicalIdentity ||
      lease.content !== claim.content
    )
      return undefined;
    return Object.freeze({
      state: "lease+cleanup-claim",
      record,
      content: lease.content,
      physicalIdentity: lease.physicalIdentity,
    });
  }
  return Object.freeze({
    state: lease.state === "present" ? "lease-only" : "cleanup-claim-only",
    record,
    content: present.content,
    physicalIdentity: present.physicalIdentity,
  });
};

const sameLeaseRecord = (
  left: LocalSqliteLeaseRecord,
  right: LocalSqliteLeaseRecord,
): boolean =>
  encodeLocalSqliteLeaseRecord(left) === encodeLocalSqliteLeaseRecord(right);

const validateRecoverySuffix = async (
  port: ParsedPort,
  inventory: readonly InventoryEntry[],
  vector: readonly LocalSqliteDeadLeaseRecoveryEntry[],
): Promise<Readonly<{ firstRemainingIndex: number }> | undefined> => {
  const inventoryIds = inventoryLeaseIds(inventory);
  const remainingIds: string[] = [];
  let firstRemainingIndex = vector.length;
  let remainingStarted = false;
  for (let index = 0; index < vector.length; index += 1) {
    const expected = vector[index]!;
    const current = await inspectLeaseCleanupState(
      port,
      expected.record.leaseId,
    );
    if (current === undefined) return undefined;
    if (current.state === "absent") {
      if (remainingStarted) return undefined;
      continue;
    }
    if (!remainingStarted) {
      remainingStarted = true;
      firstRemainingIndex = index;
      if (
        cleanupStateRank(current.state) <
        cleanupStateRank(expected.originalState)
      )
        return undefined;
    } else if (current.state !== expected.originalState) return undefined;
    if (
      current.physicalIdentity !== expected.physicalIdentity ||
      !sameLeaseRecord(current.record, expected.record)
    )
      return undefined;
    remainingIds.push(expected.record.leaseId);
  }
  return inventoryIds.length === remainingIds.length &&
    inventoryIds.every((id, index) => id === remainingIds[index])
    ? Object.freeze({ firstRemainingIndex })
    : undefined;
};

const validateExactRecoveryVector = async (
  port: ParsedPort,
  inventory: readonly InventoryEntry[],
  vector: readonly LocalSqliteDeadLeaseRecoveryEntry[],
): Promise<boolean> => {
  const inventoryIds = inventoryLeaseIds(inventory);
  if (
    inventoryIds.length !== vector.length ||
    !inventoryIds.every((id, index) => id === vector[index]?.record.leaseId)
  )
    return false;
  for (const expected of vector) {
    const current = await inspectLeaseCleanupState(
      port,
      expected.record.leaseId,
    );
    if (
      current === undefined ||
      current.state === "absent" ||
      current.state !== expected.originalState ||
      current.physicalIdentity !== expected.physicalIdentity ||
      !sameLeaseRecord(current.record, expected.record)
    )
      return false;
  }
  return true;
};

const completeLeaseCleanup = async (
  port: ParsedPort,
  expected: Readonly<{
    record: LocalSqliteLeaseRecord;
    physicalIdentity: string;
  }>,
): Promise<boolean> => {
  let state = await inspectLeaseCleanupState(port, expected.record.leaseId);
  if (state === undefined) return false;
  if (state.state === "absent") return true;
  if (
    state.physicalIdentity !== expected.physicalIdentity ||
    !sameLeaseRecord(state.record, expected.record)
  )
    return false;
  const leaseFilename = leaseName(expected.record.leaseId);
  const claimFilename = cleanupClaimName(expected.record.leaseId);
  if (state.state === "lease-only") {
    const linked = parseMutation(
      await invoke(port.createLeaseCleanupClaim, {
        cleanupClaimName: claimFilename,
        leaseName: leaseFilename,
        leasePhysicalIdentity: expected.physicalIdentity,
      }),
    );
    if (
      !isOneOf(linked?.state, ["created", "exists"]) ||
      (linked.state === "created" &&
        linked.physicalIdentity !== expected.physicalIdentity)
    )
      return false;
    state = await inspectLeaseCleanupState(port, expected.record.leaseId);
    if (
      state?.state !== "lease+cleanup-claim" ||
      state.physicalIdentity !== expected.physicalIdentity ||
      !sameLeaseRecord(state.record, expected.record)
    )
      return false;
  }
  if (state.state === "lease+cleanup-claim") {
    if (!(await removeExact(port, leaseFilename, expected.physicalIdentity)))
      return false;
    state = await inspectLeaseCleanupState(port, expected.record.leaseId);
    if (
      state?.state !== "cleanup-claim-only" ||
      state.physicalIdentity !== expected.physicalIdentity ||
      !sameLeaseRecord(state.record, expected.record)
    )
      return false;
  }
  if (state.state !== "cleanup-claim-only") return false;
  if (!(await removeExact(port, claimFilename, expected.physicalIdentity)))
    return false;
  return (
    (await inspectLeaseCleanupState(port, expected.record.leaseId))?.state ===
    "absent"
  );
};

const inspectInventory = async (
  port: ParsedPort,
): Promise<readonly InventoryEntry[] | undefined> =>
  parseInventory(await invoke(port.listLifecycle));

const blocksDatabaseOpen = (entry: InventoryEntry): boolean =>
  entry.name === "intent-v1.json" ||
  entry.name === "operation-phase-v1.json" ||
  entry.name.startsWith("lease-cleanup-");

const sameInventory = (
  left: readonly InventoryEntry[],
  right: readonly InventoryEntry[],
): boolean =>
  left.length === right.length &&
  left.every(
    (entry, index) =>
      entry.name === right[index]?.name &&
      entry.bytes === right[index].bytes &&
      entry.physicalIdentity === right[index].physicalIdentity,
  );

const inventoryLeaseIds = (
  inventory: readonly InventoryEntry[],
): readonly string[] => {
  const ids = new Set<string>();
  for (const entry of inventory) {
    const lease = /^lease-([a-f0-9]{32})\.json$/u.exec(entry.name);
    const claim = /^lease-cleanup-([a-f0-9]{32})\.json$/u.exec(entry.name);
    const id = lease?.[1] ?? claim?.[1];
    if (id !== undefined) ids.add(id);
  }
  return Object.freeze([...ids].sort());
};

const sameLifecycle = (
  left: Pick<
    LocalSqliteLeaseRecord,
    "lifecycleFingerprint" | "lifecycleGeneration"
  >,
  right: Pick<
    LocalSqliteFenceRecord,
    "lifecycleFingerprint" | "lifecycleGeneration"
  >,
): boolean =>
  left.lifecycleFingerprint === right.lifecycleFingerprint &&
  left.lifecycleGeneration === right.lifecycleGeneration;

const validateSharedInventory = async (
  port: ParsedPort,
  inventory: readonly InventoryEntry[],
  expected: Pick<
    LocalSqliteLeaseRecord,
    "lifecycleFingerprint" | "lifecycleGeneration"
  >,
  own?: Readonly<{ filename: string; physicalIdentity: string }>,
): Promise<boolean> => {
  if (inventory.some(blocksDatabaseOpen)) return false;
  if (
    own !== undefined &&
    !inventory.some(
      (entry) =>
        entry.name === own.filename &&
        entry.physicalIdentity === own.physicalIdentity,
    )
  )
    return false;
  for (const entry of inventory) {
    if (!entry.name.startsWith("lease-")) continue;
    const lease = await readValidatedLease(
      port,
      entry.name,
      entry.physicalIdentity,
    );
    if (lease === undefined || !sameLifecycle(lease.record, expected))
      return false;
  }
  return true;
};

const readFenceState = (
  artifact: ArtifactRead,
  expected: Pick<
    LocalSqliteFenceRecord,
    "lifecycleFingerprint" | "lifecycleGeneration"
  >,
): "absent" | "current" | "invalid" => {
  if (artifact.state === "absent") return "absent";
  const record = decodeLocalSqliteFenceRecord(artifact.content);
  return record !== undefined && sameLifecycle(record, expected)
    ? "current"
    : "invalid";
};

const parseSharedRequest = (
  value: unknown,
): LocalSqliteLeaseRecord | undefined => {
  const record = exactRecord(value, [
    "leaseId",
    "lifecycleFingerprint",
    "lifecycleGeneration",
    "parent",
  ]);
  if (record === undefined) return undefined;
  return parseLocalSqliteLeaseRecord({ ...record, child: null });
};

export const acquireLocalSqliteSharedLease = async (
  portValue: unknown,
  requestValue: unknown,
): Promise<LocalSqliteSharedLeaseResult> => {
  const port = parsePort(portValue);
  const record = parseSharedRequest(requestValue);
  if (port === undefined || record === undefined) return failure("unavailable");
  const content = encodeLocalSqliteLeaseRecord(record)!;
  const initialFence = await readArtifact(port, FENCE_NAME);
  if (initialFence === undefined) return failure("reconciliation-required");
  const initialFenceState = readFenceState(initialFence, record);
  if (initialFenceState !== "absent")
    return failure(
      initialFenceState === "current" ? "busy" : "reconciliation-required",
    );
  const inventory = await inspectInventory(port);
  if (
    inventory === undefined ||
    inventory.filter((entry) => entry.name.startsWith("lease-")).length >=
      MAXIMUM_LEASES
  )
    return failure("reconciliation-required");
  if (!(await validateSharedInventory(port, inventory, record)))
    return failure("reconciliation-required");
  const filename = leaseName(record.leaseId);
  const created = parseMutation(
    await invoke(port.createLeaseDurably, { filename, content }),
  );
  if (created?.state !== "created")
    return failure(
      created?.state === "exists" ? "busy" : "reconciliation-required",
    );
  const verified = await readValidatedLease(
    port,
    filename,
    created.physicalIdentity,
  );
  if (verified === undefined || verified.artifact.content !== content)
    return failure("reconciliation-required");
  const finalInventory = await inspectInventory(port);
  if (
    finalInventory === undefined ||
    !(await validateSharedInventory(port, finalInventory, record, {
      filename,
      physicalIdentity: created.physicalIdentity,
    }))
  ) {
    if (!(await removeExact(port, filename, created.physicalIdentity)))
      return failure("reconciliation-required");
    return failure("reconciliation-required");
  }
  const finalFence = await readArtifact(port, FENCE_NAME);
  if (
    finalFence !== undefined &&
    readFenceState(finalFence, record) === "absent"
  )
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        state: "shared",
        filename,
        physicalIdentity: created.physicalIdentity,
        record,
      }),
    });
  if (!(await removeExact(port, filename, created.physicalIdentity)))
    return failure("reconciliation-required");
  if (finalFence === undefined) return failure("reconciliation-required");
  return failure(
    readFenceState(finalFence, record) === "current"
      ? "busy"
      : "reconciliation-required",
  );
};

const parseFenceRequest = (
  value: unknown,
): LocalSqliteFenceRecord | undefined => parseLocalSqliteFenceRecord(value);

const releaseFenceAfterFailure = async (
  port: ParsedPort,
  physicalIdentity: string,
  state: "busy" | "reconciliation-required" | "recovery-required",
): Promise<LocalSqliteLifecycleGateFailure> =>
  (await removeExact(port, FENCE_NAME, physicalIdentity))
    ? failure(state)
    : failure("reconciliation-required");

const classifyLease = async (
  port: ParsedPort,
  record: LocalSqliteLeaseRecord,
): Promise<"live" | "dead" | "indeterminate" | undefined> => {
  const parent = exactRecord(
    await invoke(port.classifyOwner, { owner: record.parent }),
    ["state"],
  );
  if (!isOneOf(parent?.state, ["live", "dead", "indeterminate"]))
    return undefined;
  if (parent.state !== "dead" || record.child === null) return parent.state;
  const child = exactRecord(
    await invoke(port.classifyOwner, {
      owner: {
        pid: record.child.pid,
        startIdentity: record.child.startIdentity,
      },
    }),
    ["state"],
  );
  if (!isOneOf(child?.state, ["live", "dead", "indeterminate"]))
    return undefined;
  return child.state;
};

const parseRecoveryPlanRequest = (
  value: unknown,
):
  | Readonly<{
      transactionId: string;
      lifecycleFingerprint: string;
      lifecycleGeneration: number;
      recoveryOwner: OwnerIdentity;
    }>
  | undefined => {
  const record = exactRecord(value, [
    "transactionId",
    "lifecycleFingerprint",
    "lifecycleGeneration",
    "recoveryOwner",
  ]);
  const recoveryOwner = parseOwner(record?.recoveryOwner);
  if (
    record === undefined ||
    !validHex128(record.transactionId) ||
    typeof record.lifecycleFingerprint !== "string" ||
    !SHA256.test(record.lifecycleFingerprint) ||
    !validInteger(record.lifecycleGeneration, 2_147_483_647) ||
    recoveryOwner === undefined
  )
    return undefined;
  return Object.freeze({
    transactionId: record.transactionId,
    lifecycleFingerprint: record.lifecycleFingerprint,
    lifecycleGeneration: record.lifecycleGeneration,
    recoveryOwner,
  });
};

export const inspectLocalSqliteDeadLeaseRecoveryPlan = async (
  portValue: unknown,
  requestValue: unknown,
): Promise<LocalSqliteDeadLeaseRecoveryPlanResult> => {
  const port = parsePort(portValue);
  const request = parseRecoveryPlanRequest(requestValue);
  if (port === undefined || request === undefined)
    return failure("unavailable");
  const fence = await readArtifact(port, FENCE_NAME);
  if (fence === undefined) return failure("unavailable");
  if (fence.state === "present") {
    const record = decodeLocalSqliteFenceRecord(fence.content);
    if (
      record === undefined ||
      record.lifecycleFingerprint !== request.lifecycleFingerprint ||
      record.lifecycleGeneration !== request.lifecycleGeneration
    )
      return failure("reconciliation-required");
    return record.purpose === "recovery"
      ? Object.freeze({ ok: true, value: record })
      : failure("busy");
  }
  const inventory = await inspectInventory(port);
  if (
    inventory === undefined ||
    inventory.some(
      (entry) =>
        entry.name === "intent-v1.json" ||
        entry.name === "operation-phase-v1.json",
    )
  )
    return failure("reconciliation-required");
  const vector: LocalSqliteDeadLeaseRecoveryEntry[] = [];
  for (const leaseId of inventoryLeaseIds(inventory)) {
    const cleanup = await inspectLeaseCleanupState(port, leaseId);
    if (
      cleanup === undefined ||
      cleanup.state === "absent" ||
      cleanup.record.lifecycleFingerprint !== request.lifecycleFingerprint ||
      cleanup.record.lifecycleGeneration !== request.lifecycleGeneration
    )
      return failure("reconciliation-required");
    const owner = await classifyLease(port, cleanup.record);
    if (owner === undefined) return failure("unavailable");
    if (owner !== "dead") return failure("busy");
    vector.push(
      Object.freeze({
        originalState: cleanup.state,
        physicalIdentity: cleanup.physicalIdentity,
        record: cleanup.record,
      }),
    );
  }
  if (vector.length === 0) return failure("reconciliation-required");
  const finalInventory = await inspectInventory(port);
  if (finalInventory === undefined || !sameInventory(inventory, finalInventory))
    return failure("unavailable");
  const value = parseLocalSqliteFenceRecord({
    ...request,
    purpose: "recovery",
    deadLeaseVector: vector,
  });
  return value?.purpose === "recovery"
    ? Object.freeze({ ok: true, value })
    : failure("unavailable");
};

const recoveryAuthority = (
  record: LocalSqliteRecoveryFenceRecord,
  physicalIdentity: string,
  token: Readonly<Record<string, never>>,
): LocalSqliteExclusiveFenceAuthority =>
  Object.freeze({
    state: "exclusive-recovery",
    filename: FENCE_NAME,
    physicalIdentity,
    record,
    deadLeaseNames: Object.freeze(
      record.deadLeaseVector.map((entry) => leaseName(entry.record.leaseId)),
    ),
    recoveryLockToken: token,
    recoveryVector: record.deadLeaseVector,
  });

const releaseRecoveryLockAndFail = async (
  port: ParsedPort,
  physicalIdentity: string,
  token: Readonly<Record<string, never>>,
  state: LocalSqliteLifecycleGateFailure["state"],
): Promise<LocalSqliteLifecycleGateFailure> => {
  if (!(await releaseRecoveryLock(port, physicalIdentity, token)))
    return failure("reconciliation-required");
  return failure(state);
};

const remainingLeaseOwnerFailure = async (
  port: ParsedPort,
  vector: readonly LocalSqliteDeadLeaseRecoveryEntry[],
  firstRemainingIndex: number,
): Promise<LocalSqliteLifecycleGateFailure | undefined> => {
  for (let index = firstRemainingIndex; index < vector.length; index += 1) {
    const state = await classifyLease(port, vector[index]!.record);
    if (state === undefined) return failure("unavailable");
    if (state !== "dead") return failure("busy");
  }
  return undefined;
};

const resumeExistingRecoveryFence = async (
  port: ParsedPort,
  record: LocalSqliteRecoveryFenceRecord,
  content: string,
): Promise<LocalSqliteExclusiveFenceResult> => {
  const existing = await readArtifact(port, FENCE_NAME);
  if (existing?.state !== "present" || existing.content !== content)
    return failure("reconciliation-required");
  const lock = await acquireRecoveryLock(port, existing.physicalIdentity);
  if (lock?.state === "busy") return failure("busy");
  if (lock?.state !== "acquired") return failure("unavailable");
  const ownerState = await classifyLease(port, {
    leaseId: record.transactionId,
    lifecycleFingerprint: record.lifecycleFingerprint,
    lifecycleGeneration: record.lifecycleGeneration,
    parent: record.recoveryOwner,
    child: null,
  });
  const inventory = await inspectInventory(port);
  const suffix =
    inventory === undefined
      ? undefined
      : await validateRecoverySuffix(port, inventory, record.deadLeaseVector);
  const finalInventory = await inspectInventory(port);
  if (
    ownerState !== "dead" ||
    inventory === undefined ||
    suffix === undefined ||
    finalInventory === undefined ||
    !sameInventory(inventory, finalInventory)
  )
    return releaseRecoveryLockAndFail(
      port,
      existing.physicalIdentity,
      lock.token,
      ownerState === "live" ? "busy" : "reconciliation-required",
    );
  const ownerFailure = await remainingLeaseOwnerFailure(
    port,
    record.deadLeaseVector,
    suffix.firstRemainingIndex,
  );
  if (ownerFailure !== undefined)
    return releaseRecoveryLockAndFail(
      port,
      existing.physicalIdentity,
      lock.token,
      ownerFailure.state,
    );
  return Object.freeze({
    ok: true,
    value: recoveryAuthority(record, existing.physicalIdentity, lock.token),
  });
};

const inspectCreatedFenceInventory = async (
  port: ParsedPort,
  record: LocalSqliteFenceRecord,
  physicalIdentity: string,
): Promise<
  | LocalSqliteLifecycleGateFailure
  | Readonly<{
      inventory: readonly InventoryEntry[];
      deadLeaseNames: readonly string[];
    }>
> => {
  const inventory = await inspectInventory(port);
  const inventoryFence = inventory?.find((entry) => entry.name === FENCE_NAME);
  if (
    inventory === undefined ||
    inventoryFence?.physicalIdentity !== physicalIdentity
  )
    return releaseFenceAfterFailure(
      port,
      physicalIdentity,
      "reconciliation-required",
    );
  const deadLeaseNames: string[] = [];
  for (const leaseId of inventoryLeaseIds(inventory)) {
    const cleanup = await inspectLeaseCleanupState(port, leaseId);
    if (
      cleanup === undefined ||
      cleanup.state === "absent" ||
      !sameLifecycle(cleanup.record, record)
    )
      return releaseFenceAfterFailure(
        port,
        physicalIdentity,
        "reconciliation-required",
      );
    const state = await classifyLease(port, cleanup.record);
    if (state === undefined)
      return releaseFenceAfterFailure(
        port,
        physicalIdentity,
        "reconciliation-required",
      );
    if (state !== "dead")
      return releaseFenceAfterFailure(port, physicalIdentity, "busy");
    deadLeaseNames.push(leaseName(leaseId));
  }
  return Object.freeze({
    inventory,
    deadLeaseNames: Object.freeze(deadLeaseNames),
  });
};

const acquireCreatedRecoveryFence = async (
  port: ParsedPort,
  record: LocalSqliteRecoveryFenceRecord,
  physicalIdentity: string,
  inspected: Readonly<{
    inventory: readonly InventoryEntry[];
    deadLeaseNames: readonly string[];
  }>,
): Promise<LocalSqliteExclusiveFenceResult> => {
  const lock = await acquireRecoveryLock(port, physicalIdentity);
  if (lock?.state === "busy") return failure("busy");
  if (lock?.state !== "acquired") return failure("unavailable");
  const ownerState = await classifyLease(port, {
    leaseId: record.transactionId,
    lifecycleFingerprint: record.lifecycleFingerprint,
    lifecycleGeneration: record.lifecycleGeneration,
    parent: record.recoveryOwner,
    child: null,
  });
  const lockedInventory = await inspectInventory(port);
  const exactOriginal =
    lockedInventory !== undefined &&
    (await validateExactRecoveryVector(
      port,
      lockedInventory,
      record.deadLeaseVector,
    )) &&
    record.deadLeaseVector.every((entry) =>
      inspected.deadLeaseNames.includes(leaseName(entry.record.leaseId)),
    ) &&
    inspected.deadLeaseNames.length === record.deadLeaseVector.length;
  const finalInventory = await inspectInventory(port);
  if (
    ownerState !== "live" ||
    !exactOriginal ||
    lockedInventory === undefined ||
    finalInventory === undefined ||
    !sameInventory(lockedInventory, finalInventory)
  ) {
    if (!(await releaseRecoveryLock(port, physicalIdentity, lock.token)))
      return failure("reconciliation-required");
    return releaseFenceAfterFailure(
      port,
      physicalIdentity,
      ownerState === "indeterminate" ? "busy" : "reconciliation-required",
    );
  }
  return Object.freeze({
    ok: true,
    value: recoveryAuthority(record, physicalIdentity, lock.token),
  });
};

export const acquireLocalSqliteExclusiveFence = async (
  portValue: unknown,
  requestValue: unknown,
): Promise<LocalSqliteExclusiveFenceResult> => {
  const port = parsePort(portValue);
  const record = parseFenceRequest(requestValue);
  if (port === undefined || record === undefined) return failure("unavailable");
  const content = encodeLocalSqliteFenceRecord(record)!;
  const created = parseMutation(
    await invoke(port.createFenceDurably, {
      filename: FENCE_NAME,
      content,
    }),
  );
  if (created?.state !== "created") {
    if (created?.state !== "exists") return failure("reconciliation-required");
    if (record.purpose === "recovery")
      return resumeExistingRecoveryFence(port, record, content);
    const existing = await readArtifact(port, FENCE_NAME);
    return failure(
      existing !== undefined && readFenceState(existing, record) === "current"
        ? "busy"
        : "reconciliation-required",
    );
  }
  const fence = await readArtifact(port, FENCE_NAME);
  if (
    fence?.state !== "present" ||
    fence.physicalIdentity !== created.physicalIdentity ||
    fence.content !== content ||
    decodeLocalSqliteFenceRecord(fence.content) === undefined
  )
    return failure("reconciliation-required");
  const inspected = await inspectCreatedFenceInventory(
    port,
    record,
    created.physicalIdentity,
  );
  if ("ok" in inspected) return inspected;
  if (record.purpose === "recovery")
    return acquireCreatedRecoveryFence(
      port,
      record,
      created.physicalIdentity,
      inspected,
    );
  if (inspected.deadLeaseNames.length > 0)
    return releaseFenceAfterFailure(
      port,
      created.physicalIdentity,
      "recovery-required",
    );
  const baseAuthority = Object.freeze({
    deadLeaseNames: inspected.deadLeaseNames,
    filename: FENCE_NAME,
    physicalIdentity: created.physicalIdentity,
    record,
  });
  return Object.freeze({
    ok: true,
    value: Object.freeze({ ...baseAuthority, state: "exclusive" as const }),
  });
};

export const amendLocalSqliteLeaseWithChild = async (
  portValue: unknown,
  authorityValue: unknown,
  childValue: unknown,
): Promise<LocalSqliteSharedLeaseResult> => {
  const port = parsePort(portValue);
  const authority = exactRecord(authorityValue, [
    "state",
    "filename",
    "physicalIdentity",
    "record",
  ]);
  const record = parseLocalSqliteLeaseRecord(authority?.record);
  const child = parseChild(childValue);
  if (
    port === undefined ||
    authority?.state !== "shared" ||
    typeof authority.filename !== "string" ||
    typeof authority.physicalIdentity !== "string" ||
    !PHYSICAL_IDENTITY.test(authority.physicalIdentity) ||
    record === undefined ||
    record.child !== null ||
    child === undefined ||
    child === null ||
    leaseName(record.leaseId) !== authority.filename
  )
    return failure("unavailable");
  const current = await readValidatedLease(
    port,
    authority.filename,
    authority.physicalIdentity,
  );
  if (
    current === undefined ||
    encodeLocalSqliteLeaseRecord(current.record) !==
      encodeLocalSqliteLeaseRecord(record)
  )
    return failure("reconciliation-required");
  const amended = Object.freeze({ ...record, child });
  const content = encodeLocalSqliteLeaseRecord(amended)!;
  const replaced = parseMutation(
    await invoke(port.replaceLeaseDurably, {
      filename: authority.filename,
      physicalIdentity: authority.physicalIdentity,
      content,
    }),
  );
  if (replaced?.state !== "replaced") return failure("reconciliation-required");
  const verified = await readValidatedLease(
    port,
    authority.filename,
    replaced.physicalIdentity,
  );
  if (verified === undefined || verified.artifact.content !== content)
    return failure("reconciliation-required");
  const finalInventory = await inspectInventory(port);
  if (
    finalInventory === undefined ||
    !(await validateSharedInventory(port, finalInventory, amended, {
      filename: authority.filename,
      physicalIdentity: replaced.physicalIdentity,
    }))
  ) {
    if (
      !(await removeExact(port, authority.filename, replaced.physicalIdentity))
    )
      return failure("reconciliation-required");
    return failure("reconciliation-required");
  }
  const finalFence = await readArtifact(port, FENCE_NAME);
  if (
    finalFence !== undefined &&
    readFenceState(finalFence, amended) === "absent"
  )
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        state: "shared",
        filename: authority.filename,
        physicalIdentity: replaced.physicalIdentity,
        record: amended,
      }),
    });
  if (!(await removeExact(port, authority.filename, replaced.physicalIdentity)))
    return failure("reconciliation-required");
  if (finalFence === undefined) return failure("reconciliation-required");
  return failure(
    readFenceState(finalFence, amended) === "current"
      ? "busy"
      : "reconciliation-required",
  );
};

export const releaseLocalSqliteSharedLease = async (
  portValue: unknown,
  authorityValue: unknown,
): Promise<
  LocalSqliteLifecycleGateFailure | Readonly<{ ok: true; state: "released" }>
> => {
  const port = parsePort(portValue);
  const authority = exactRecord(authorityValue, [
    "state",
    "filename",
    "physicalIdentity",
    "record",
  ]);
  const record = parseLocalSqliteLeaseRecord(authority?.record);
  if (
    port === undefined ||
    authority?.state !== "shared" ||
    typeof authority.filename !== "string" ||
    typeof authority.physicalIdentity !== "string" ||
    record === undefined ||
    leaseName(record.leaseId) !== authority.filename
  )
    return failure("unavailable");
  return (await completeLeaseCleanup(port, {
    physicalIdentity: authority.physicalIdentity,
    record,
  }))
    ? Object.freeze({ ok: true, state: "released" })
    : failure("reconciliation-required");
};

const parseExclusiveAuthority = (
  value: unknown,
): LocalSqliteExclusiveFenceAuthority | undefined => {
  const authority =
    exactRecord(value, [
      "state",
      "filename",
      "physicalIdentity",
      "record",
      "deadLeaseNames",
      "recoveryLockToken",
      "recoveryVector",
    ]) ??
    exactRecord(value, [
      "state",
      "filename",
      "physicalIdentity",
      "record",
      "deadLeaseNames",
    ]);
  const record = parseLocalSqliteFenceRecord(authority?.record);
  if (
    !isOneOf(authority?.state, ["exclusive", "exclusive-recovery"]) ||
    authority.filename !== FENCE_NAME ||
    typeof authority.physicalIdentity !== "string" ||
    record === undefined
  )
    return undefined;
  const deadLeaseNames = exactArray(authority.deadLeaseNames, MAXIMUM_LEASES);
  if (
    deadLeaseNames === undefined ||
    deadLeaseNames.some((name) => typeof name !== "string")
  )
    return undefined;
  if (authority.state === "exclusive")
    return record.purpose === "lifecycle"
      ? Object.freeze({
          state: "exclusive",
          filename: FENCE_NAME,
          physicalIdentity: authority.physicalIdentity,
          record,
          deadLeaseNames: Object.freeze(
            deadLeaseNames.filter(
              (name): name is string => typeof name === "string",
            ),
          ),
        })
      : undefined;
  const recoveryVector = parseDeadLeaseRecoveryVector(
    authority.recoveryVector,
    record,
  );
  const token = parseLockToken(authority.recoveryLockToken);
  if (
    record.purpose !== "recovery" ||
    recoveryVector === undefined ||
    token === undefined ||
    JSON.stringify(recoveryVector) !== JSON.stringify(record.deadLeaseVector)
  )
    return undefined;
  return Object.freeze({
    state: "exclusive-recovery",
    filename: FENCE_NAME,
    physicalIdentity: authority.physicalIdentity,
    record,
    deadLeaseNames: Object.freeze(deadLeaseNames as string[]),
    recoveryLockToken: token,
    recoveryVector,
  });
};

const recoveryFenceIsComplete = async (
  port: ParsedPort,
  vector: readonly LocalSqliteDeadLeaseRecoveryEntry[],
): Promise<boolean> => {
  const inventory = await inspectInventory(port);
  if (inventory === undefined) return false;
  const suffix = await validateRecoverySuffix(port, inventory, vector);
  const finalInventory = await inspectInventory(port);
  return (
    suffix?.firstRemainingIndex === vector.length &&
    finalInventory !== undefined &&
    sameInventory(inventory, finalInventory)
  );
};

export const releaseLocalSqliteExclusiveFence = async (
  portValue: unknown,
  authorityValue: unknown,
): Promise<
  LocalSqliteLifecycleGateFailure | Readonly<{ ok: true; state: "released" }>
> => {
  const port = parsePort(portValue);
  const authority = parseExclusiveAuthority(authorityValue);
  if (port === undefined || authority === undefined)
    return failure("unavailable");
  const current = await readArtifact(port, FENCE_NAME);
  if (
    current?.state !== "present" ||
    current.physicalIdentity !== authority.physicalIdentity ||
    encodeLocalSqliteFenceRecord(authority.record) !== current.content
  )
    return failure("reconciliation-required");
  const lockToken =
    authority.state === "exclusive-recovery"
      ? authority.recoveryLockToken
      : undefined;
  if (
    authority.state === "exclusive-recovery" &&
    (lockToken === undefined ||
      !(await assertRecoveryLock(port, authority.physicalIdentity, lockToken)))
  )
    return failure("reconciliation-required");
  if (
    authority.state === "exclusive-recovery" &&
    !(await recoveryFenceIsComplete(port, authority.recoveryVector))
  )
    return failure("reconciliation-required");
  const removed = await removeExact(
    port,
    FENCE_NAME,
    authority.physicalIdentity,
  );
  if (lockToken !== undefined) {
    const released = await releaseRecoveryLock(
      port,
      authority.physicalIdentity,
      lockToken,
    );
    if (!released) return failure("reconciliation-required");
  }
  return removed
    ? Object.freeze({ ok: true, state: "released" })
    : failure("reconciliation-required");
};

const parseRecoveryRequest = (
  exclusiveValue: unknown,
  leaseFilenameValue: unknown,
):
  | Readonly<{
      physicalIdentity: string;
      fenceRecord: LocalSqliteFenceRecord;
      leaseFilename: string;
      recoveryLockToken: Readonly<Record<string, never>>;
      recoveryVector: readonly LocalSqliteDeadLeaseRecoveryEntry[];
    }>
  | undefined => {
  const exclusive = exactRecord(exclusiveValue, [
    "state",
    "filename",
    "physicalIdentity",
    "record",
    "deadLeaseNames",
    "recoveryLockToken",
    "recoveryVector",
  ]);
  const fenceRecord = parseLocalSqliteFenceRecord(exclusive?.record);
  const deadLeaseNames = exactArray(exclusive?.deadLeaseNames, MAXIMUM_LEASES);
  const recoveryLockToken = parseLockToken(exclusive?.recoveryLockToken);
  const recoveryVector = parseDeadLeaseRecoveryVector(
    exclusive?.recoveryVector,
    fenceRecord,
  );
  if (
    exclusive?.state !== "exclusive-recovery" ||
    exclusive.filename !== FENCE_NAME ||
    typeof exclusive.physicalIdentity !== "string" ||
    fenceRecord?.purpose !== "recovery" ||
    deadLeaseNames === undefined ||
    recoveryLockToken === undefined ||
    recoveryVector === undefined ||
    JSON.stringify(recoveryVector) !==
      JSON.stringify(fenceRecord.deadLeaseVector) ||
    deadLeaseNames.length !== recoveryVector.length ||
    deadLeaseNames.some(
      (name, index) =>
        name !== leaseName(recoveryVector[index]!.record.leaseId),
    ) ||
    deadLeaseNames.some(
      (name) =>
        typeof name !== "string" || !/^lease-[a-f0-9]{32}\.json$/u.test(name),
    ) ||
    typeof leaseFilenameValue !== "string" ||
    !/^lease-[a-f0-9]{32}\.json$/u.test(leaseFilenameValue) ||
    !deadLeaseNames.includes(leaseFilenameValue)
  )
    return undefined;
  return Object.freeze({
    physicalIdentity: exclusive.physicalIdentity,
    fenceRecord,
    leaseFilename: leaseFilenameValue,
    recoveryLockToken,
    recoveryVector,
  });
};

export const recoverDeadLocalSqliteLease = async (
  portValue: unknown,
  exclusiveValue: unknown,
  leaseFilenameValue: unknown,
): Promise<
  LocalSqliteLifecycleGateFailure | Readonly<{ ok: true; state: "recovered" }>
> => {
  const port = parsePort(portValue);
  const request = parseRecoveryRequest(exclusiveValue, leaseFilenameValue);
  if (port === undefined || request === undefined)
    return failure("unavailable");
  const fence = await readArtifact(port, FENCE_NAME);
  if (
    fence?.state !== "present" ||
    fence.physicalIdentity !== request.physicalIdentity ||
    fence.content !== encodeLocalSqliteFenceRecord(request.fenceRecord)
  )
    return failure("reconciliation-required");
  if (
    !(await assertRecoveryLock(
      port,
      request.physicalIdentity,
      request.recoveryLockToken,
    ))
  )
    return failure("reconciliation-required");
  const inventory = await inspectInventory(port);
  const suffix =
    inventory === undefined
      ? undefined
      : await validateRecoverySuffix(port, inventory, request.recoveryVector);
  const firstRemainingIndex = suffix?.firstRemainingIndex;
  const expected =
    firstRemainingIndex === undefined
      ? undefined
      : request.recoveryVector[firstRemainingIndex];
  if (
    firstRemainingIndex === undefined ||
    expected === undefined ||
    leaseName(expected.record.leaseId) !== request.leaseFilename
  )
    return failure("reconciliation-required");
  if (!sameLifecycle(expected.record, request.fenceRecord))
    return failure("reconciliation-required");
  if ((await classifyLease(port, expected.record)) !== "dead")
    return failure("busy");
  if (
    !(await completeLeaseCleanup(port, {
      physicalIdentity: expected.physicalIdentity,
      record: expected.record,
    }))
  )
    return failure("reconciliation-required");
  const finalInventory = await inspectInventory(port);
  const finalSuffix =
    finalInventory === undefined
      ? undefined
      : await validateRecoverySuffix(
          port,
          finalInventory,
          request.recoveryVector,
        );
  if (finalSuffix?.firstRemainingIndex !== firstRemainingIndex + 1)
    return failure("reconciliation-required");
  return Object.freeze({ ok: true, state: "recovered" });
};

type LifecycleInspectionObservation = Readonly<{
  sawBusy: boolean;
  sawDead: boolean;
}>;

const inspectRecoveryFenceForDoctor = async (
  port: ParsedPort,
  inventory: readonly InventoryEntry[],
  fenceEntry: InventoryEntry,
  record: LocalSqliteRecoveryFenceRecord,
): Promise<
  LocalSqliteLifecycleGateFailure | LifecycleInspectionObservation
> => {
  const lock = await acquireRecoveryLock(port, fenceEntry.physicalIdentity);
  if (lock?.state === "busy")
    return Object.freeze({ sawBusy: true, sawDead: false });
  if (lock?.state !== "acquired") return failure("unavailable");
  const ownerState = await classifyLease(port, {
    leaseId: record.transactionId,
    lifecycleFingerprint: record.lifecycleFingerprint,
    lifecycleGeneration: record.lifecycleGeneration,
    parent: record.recoveryOwner,
    child: null,
  });
  const suffix = await validateRecoverySuffix(
    port,
    inventory,
    record.deadLeaseVector,
  );
  const remainingFailure =
    ownerState === "dead" && suffix !== undefined
      ? await remainingLeaseOwnerFailure(
          port,
          record.deadLeaseVector,
          suffix.firstRemainingIndex,
        )
      : undefined;
  const released = await releaseRecoveryLock(
    port,
    fenceEntry.physicalIdentity,
    lock.token,
  );
  if (!released || ownerState === undefined) return failure("unavailable");
  if (suffix === undefined) return failure("reconciliation-required");
  if (remainingFailure?.state === "unavailable") return remainingFailure;
  return Object.freeze({
    sawBusy: ownerState !== "dead" || remainingFailure?.state === "busy",
    sawDead: ownerState === "dead",
  });
};

const inspectLeaseOwnersForDoctor = async (
  port: ParsedPort,
  inventory: readonly InventoryEntry[],
  initialLifecycle:
    | Pick<
        LocalSqliteLeaseRecord,
        "lifecycleFingerprint" | "lifecycleGeneration"
      >
    | undefined,
): Promise<
  | LocalSqliteLifecycleGateFailure
  | (LifecycleInspectionObservation &
      Readonly<{
        lifecycle:
          | Pick<
              LocalSqliteLeaseRecord,
              "lifecycleFingerprint" | "lifecycleGeneration"
            >
          | undefined;
      }>)
> => {
  let lifecycle = initialLifecycle;
  let sawBusy = false;
  let sawDead = false;
  for (const leaseId of inventoryLeaseIds(inventory)) {
    const lease = await inspectLeaseCleanupState(port, leaseId);
    if (
      lease === undefined ||
      lease.state === "absent" ||
      (lifecycle !== undefined && !sameLifecycle(lease.record, lifecycle))
    )
      return failure("reconciliation-required");
    lifecycle ??= lease.record;
    const owner = await classifyLease(port, lease.record);
    if (owner === undefined) return failure("unavailable");
    if (owner === "dead") sawDead = true;
    else sawBusy = true;
  }
  return Object.freeze({ lifecycle, sawBusy, sawDead });
};

export const inspectLocalSqliteLifecycleInventory = async (
  portValue: unknown,
): Promise<
  | LocalSqliteLifecycleGateFailure
  | Readonly<{
      ok: true;
      state: "busy" | "clean" | "recovery-required";
      entries: number;
      leases: number;
      bytes: number;
      fence: "absent" | "present";
    }>
> => {
  const port = parsePort(portValue);
  if (port === undefined) return failure("unavailable");
  const inventory = await inspectInventory(port);
  if (inventory === undefined) return failure("reconciliation-required");
  const fenceEntry = inventory.find((entry) => entry.name === FENCE_NAME);
  const hasMutationRecord = inventory.some(
    (entry) =>
      entry.name === "intent-v1.json" ||
      entry.name === "operation-phase-v1.json",
  );
  if (hasMutationRecord && fenceEntry === undefined)
    return failure("reconciliation-required");
  let lifecycle:
    | Pick<
        LocalSqliteLeaseRecord,
        "lifecycleFingerprint" | "lifecycleGeneration"
      >
    | undefined;
  let fenceRecord: LocalSqliteFenceRecord | undefined;
  if (fenceEntry !== undefined) {
    const fence = await readArtifact(port, FENCE_NAME);
    fenceRecord =
      fence?.state === "present"
        ? decodeLocalSqliteFenceRecord(fence.content)
        : undefined;
    if (
      fence?.state !== "present" ||
      fence.physicalIdentity !== fenceEntry.physicalIdentity ||
      fenceRecord === undefined
    )
      return failure("reconciliation-required");
    lifecycle = fenceRecord;
  }
  let sawBusy = hasMutationRecord || fenceRecord?.purpose === "lifecycle";
  let sawDead = false;
  if (fenceEntry !== undefined && fenceRecord?.purpose === "recovery") {
    const recovery = await inspectRecoveryFenceForDoctor(
      port,
      inventory,
      fenceEntry,
      fenceRecord,
    );
    if ("ok" in recovery) return recovery;
    sawBusy ||= recovery.sawBusy;
    sawDead ||= recovery.sawDead;
  }
  const leases = await inspectLeaseOwnersForDoctor(port, inventory, lifecycle);
  if ("ok" in leases) return leases;
  sawBusy ||= leases.sawBusy;
  sawDead ||= leases.sawDead;
  const finalInventory = await inspectInventory(port);
  if (finalInventory === undefined || !sameInventory(inventory, finalInventory))
    return failure("unavailable");
  return Object.freeze({
    ok: true,
    state: sawBusy ? "busy" : sawDead ? "recovery-required" : "clean",
    entries: inventory.length,
    leases: inventory.filter((entry) => entry.name.startsWith("lease-")).length,
    bytes: inventory.reduce((total, entry) => total + entry.bytes, 0),
    fence: fenceEntry === undefined ? "absent" : "present",
  });
};

export const LOCAL_SQLITE_LIFECYCLE_GATE_CONSTANTS = Object.freeze({
  exclusiveFenceName: FENCE_NAME,
  leaseRecordBytes: LEASE_RECORD_BYTES,
  maximumDirectoryEntries: MAXIMUM_DIRECTORY_ENTRIES,
  maximumFenceRecordBytes: MAXIMUM_FENCE_RECORD_BYTES,
  maximumInspectionBytes: MAXIMUM_INSPECTION_BYTES,
  maximumLeases: MAXIMUM_LEASES,
});
