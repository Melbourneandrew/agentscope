const HEX_128 = /^[a-f0-9]{32}$/u;
const SHA256 = /^sha256-[a-f0-9]{64}$/u;
const PHYSICAL_IDENTITY = /^[\x21-\x7e]{1,128}$/u;
const LEASE_RECORD_BYTES = 256;
const MAXIMUM_DIRECTORY_ENTRIES = 128;
const MAXIMUM_INSPECTION_BYTES = 65_536;
const MAXIMUM_LEASES = 64;
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

export type LocalSqliteFenceRecord = Readonly<{
  transactionId: string;
  lifecycleFingerprint: string;
  lifecycleGeneration: number;
  purpose: "lifecycle" | "recovery";
}>;

export type LocalSqliteSharedLeaseAuthority = Readonly<{
  state: "shared";
  filename: string;
  physicalIdentity: string;
  record: LocalSqliteLeaseRecord;
}>;

export type LocalSqliteExclusiveFenceAuthority = Readonly<{
  state: "exclusive" | "exclusive-recovery";
  filename: typeof FENCE_NAME;
  physicalIdentity: string;
  record: LocalSqliteFenceRecord;
  deadLeaseNames: readonly string[];
}>;

export type LocalSqliteLifecycleGateFailure = Readonly<{
  ok: false;
  state: "busy" | "reconciliation-required" | "unavailable";
}>;

export type LocalSqliteSharedLeaseResult =
  | Readonly<{ ok: true; value: LocalSqliteSharedLeaseAuthority }>
  | LocalSqliteLifecycleGateFailure;

export type LocalSqliteExclusiveFenceResult =
  | Readonly<{ ok: true; value: LocalSqliteExclusiveFenceAuthority }>
  | LocalSqliteLifecycleGateFailure;

export type LocalSqliteLifecycleGatePort = Readonly<{
  classifyOwner: (input: Readonly<{ owner: OwnerIdentity }>) => unknown;
  createFenceDurably: (
    input: Readonly<{ filename: string; content: string }>,
  ) => unknown;
  createLeaseDurably: (
    input: Readonly<{ filename: string; content: string }>,
  ) => unknown;
  createRecoveryClaim: (
    input: Readonly<{
      claimName: string;
      leaseName: string;
      leasePhysicalIdentity: string;
    }>,
  ) => unknown;
  listLifecycle: () => unknown;
  readArtifact: (input: Readonly<{ filename: string }>) => unknown;
  removeArtifactIfIdentity: (
    input: Readonly<{ filename: string; physicalIdentity: string }>,
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

export const parseLocalSqliteFenceRecord = (
  value: unknown,
): LocalSqliteFenceRecord | undefined => {
  const record = exactRecord(value, [
    "transactionId",
    "lifecycleFingerprint",
    "lifecycleGeneration",
    "purpose",
  ]);
  if (
    record === undefined ||
    !validHex128(record.transactionId) ||
    typeof record.lifecycleFingerprint !== "string" ||
    !SHA256.test(record.lifecycleFingerprint) ||
    !validInteger(record.lifecycleGeneration, 2_147_483_647) ||
    !isOneOf(record.purpose, ["lifecycle", "recovery"])
  )
    return undefined;
  return Object.freeze({
    transactionId: record.transactionId,
    lifecycleFingerprint: record.lifecycleFingerprint,
    lifecycleGeneration: record.lifecycleGeneration,
    purpose: record.purpose,
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

const encodeParsedFenceRecord = (record: LocalSqliteFenceRecord): string =>
  JSON.stringify([
    1,
    record.transactionId,
    record.lifecycleFingerprint.slice("sha256-".length),
    record.lifecycleGeneration,
    record.purpose,
  ]).padEnd(LEASE_RECORD_BYTES, " ");

export const encodeLocalSqliteFenceRecord = (
  value: unknown,
): string | undefined => {
  const record = parseLocalSqliteFenceRecord(value);
  return record === undefined ? undefined : encodeParsedFenceRecord(record);
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
    content.length !== LEASE_RECORD_BYTES ||
    /[^\x20-\x7e]/u.test(content)
  )
    return undefined;
  try {
    const compact = exactArray(JSON.parse(content.trimEnd()), 5);
    if (compact?.length !== 5 || compact[0] !== 1) return undefined;
    const parsed = parseLocalSqliteFenceRecord({
      transactionId: compact[1],
      lifecycleFingerprint: `sha256-${String(compact[2])}`,
      lifecycleGeneration: compact[3],
      purpose: compact[4],
    });
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
    "classifyOwner",
    "createFenceDurably",
    "createLeaseDurably",
    "createRecoveryClaim",
    "listLifecycle",
    "readArtifact",
    "removeArtifactIfIdentity",
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

const knownLifecycleName = (name: string): boolean =>
  name === FENCE_NAME ||
  name === "intent-v1.json" ||
  name === "operation-phase-v1.json" ||
  name === "ownership-receipt-v1.json" ||
  /^lease-[a-f0-9]{32}\.json$/u.test(name) ||
  /^recovery-claim-[a-f0-9]{32}$/u.test(name);

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
  let recoveryClaims = 0;
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
    if (entry.name === FENCE_NAME && entry.bytes !== LEASE_RECORD_BYTES)
      return undefined;
    if (entry.name.startsWith("recovery-claim-")) {
      recoveryClaims += 1;
      if (entry.bytes !== LEASE_RECORD_BYTES || recoveryClaims > 1)
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
const claimName = (transactionId: string): string =>
  `recovery-claim-${transactionId}`;

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

const inspectInventory = async (
  port: ParsedPort,
): Promise<readonly InventoryEntry[] | undefined> =>
  parseInventory(await invoke(port.listLifecycle));

const blocksDatabaseOpen = (entry: InventoryEntry): boolean =>
  entry.name === "intent-v1.json" ||
  entry.name === "operation-phase-v1.json" ||
  entry.name.startsWith("recovery-claim-");

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
  state: "busy" | "reconciliation-required",
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
    const existingFence = await readArtifact(port, FENCE_NAME);
    if (existingFence === undefined) return failure("reconciliation-required");
    return failure(
      readFenceState(existingFence, record) === "current"
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
  const inventory = await inspectInventory(port);
  if (inventory === undefined)
    return releaseFenceAfterFailure(
      port,
      created.physicalIdentity,
      "reconciliation-required",
    );
  const inventoryFence = inventory.find((entry) => entry.name === FENCE_NAME);
  if (
    inventoryFence === undefined ||
    inventoryFence.physicalIdentity !== created.physicalIdentity
  )
    return releaseFenceAfterFailure(
      port,
      created.physicalIdentity,
      "reconciliation-required",
    );
  let sawDead = false;
  const deadLeaseNames: string[] = [];
  for (const entry of inventory) {
    if (!entry.name.startsWith("lease-")) continue;
    const lease = await readValidatedLease(
      port,
      entry.name,
      entry.physicalIdentity,
    );
    if (lease === undefined)
      return releaseFenceAfterFailure(
        port,
        created.physicalIdentity,
        "reconciliation-required",
      );
    if (!sameLifecycle(lease.record, record))
      return releaseFenceAfterFailure(
        port,
        created.physicalIdentity,
        "reconciliation-required",
      );
    const state = await classifyLease(port, lease.record);
    if (state === undefined)
      return releaseFenceAfterFailure(
        port,
        created.physicalIdentity,
        "reconciliation-required",
      );
    if (state === "dead") {
      sawDead = true;
      deadLeaseNames.push(entry.name);
    } else
      return releaseFenceAfterFailure(port, created.physicalIdentity, "busy");
  }
  if (sawDead && record.purpose !== "recovery")
    return releaseFenceAfterFailure(
      port,
      created.physicalIdentity,
      "reconciliation-required",
    );
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      deadLeaseNames: Object.freeze(deadLeaseNames),
      filename: FENCE_NAME,
      physicalIdentity: created.physicalIdentity,
      record,
      state: sawDead ? "exclusive-recovery" : "exclusive",
    }),
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
  return (await removeExact(
    port,
    authority.filename,
    authority.physicalIdentity,
  ))
    ? Object.freeze({ ok: true, state: "released" })
    : failure("reconciliation-required");
};

export const releaseLocalSqliteExclusiveFence = async (
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
    "deadLeaseNames",
  ]);
  const record = parseLocalSqliteFenceRecord(authority?.record);
  if (
    port === undefined ||
    !isOneOf(authority?.state, ["exclusive", "exclusive-recovery"]) ||
    authority.filename !== FENCE_NAME ||
    typeof authority.physicalIdentity !== "string" ||
    record === undefined
  )
    return failure("unavailable");
  const current = await readArtifact(port, FENCE_NAME);
  if (
    current?.state !== "present" ||
    current.physicalIdentity !== authority.physicalIdentity ||
    encodeLocalSqliteFenceRecord(record) !== current.content
  )
    return failure("reconciliation-required");
  return (await removeExact(port, FENCE_NAME, authority.physicalIdentity))
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
      transactionId: string;
    }>
  | undefined => {
  const exclusive = exactRecord(exclusiveValue, [
    "state",
    "filename",
    "physicalIdentity",
    "record",
    "deadLeaseNames",
  ]);
  const fenceRecord = parseLocalSqliteFenceRecord(exclusive?.record);
  const deadLeaseNames = exactArray(exclusive?.deadLeaseNames, MAXIMUM_LEASES);
  if (
    exclusive?.state !== "exclusive-recovery" ||
    exclusive.filename !== FENCE_NAME ||
    typeof exclusive.physicalIdentity !== "string" ||
    fenceRecord?.purpose !== "recovery" ||
    deadLeaseNames === undefined ||
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
    transactionId: fenceRecord.transactionId,
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
  const lease = await readValidatedLease(port, request.leaseFilename);
  if (lease === undefined) return failure("reconciliation-required");
  if (!sameLifecycle(lease.record, request.fenceRecord))
    return failure("reconciliation-required");
  if ((await classifyLease(port, lease.record)) !== "dead")
    return failure("busy");
  const recoveryClaimName = claimName(request.transactionId);
  const claimed = parseMutation(
    await invoke(port.createRecoveryClaim, {
      claimName: recoveryClaimName,
      leaseName: request.leaseFilename,
      leasePhysicalIdentity: lease.artifact.physicalIdentity,
    }),
  );
  if (
    !isOneOf(claimed?.state, ["created", "exists"]) ||
    (claimed.state === "created" &&
      claimed.physicalIdentity !== lease.artifact.physicalIdentity)
  )
    return failure("reconciliation-required");
  const [leaseAfterClaim, claim] = await Promise.all([
    readValidatedLease(
      port,
      request.leaseFilename,
      lease.artifact.physicalIdentity,
    ),
    readArtifact(port, recoveryClaimName),
  ]);
  if (
    leaseAfterClaim === undefined ||
    claim?.state !== "present" ||
    claim.physicalIdentity !== lease.artifact.physicalIdentity ||
    claim.content !== lease.artifact.content
  )
    return failure("reconciliation-required");
  if (
    !(await removeExact(
      port,
      recoveryClaimName,
      lease.artifact.physicalIdentity,
    )) ||
    !(await removeExact(
      port,
      request.leaseFilename,
      lease.artifact.physicalIdentity,
    ))
  )
    return failure("reconciliation-required");
  return Object.freeze({ ok: true, state: "recovered" });
};

export const inspectLocalSqliteLifecycleInventory = async (
  portValue: unknown,
): Promise<
  | LocalSqliteLifecycleGateFailure
  | Readonly<{
      ok: true;
      state: "available";
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
  if (inventory.some(blocksDatabaseOpen))
    return failure("reconciliation-required");
  const fenceEntry = inventory.find((entry) => entry.name === FENCE_NAME);
  let lifecycle:
    | Pick<
        LocalSqliteLeaseRecord,
        "lifecycleFingerprint" | "lifecycleGeneration"
      >
    | undefined;
  if (fenceEntry !== undefined) {
    const fence = await readArtifact(port, FENCE_NAME);
    const fenceRecord =
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
  for (const entry of inventory) {
    if (!entry.name.startsWith("lease-")) continue;
    const lease = await readValidatedLease(
      port,
      entry.name,
      entry.physicalIdentity,
    );
    if (
      lease === undefined ||
      (lifecycle !== undefined && !sameLifecycle(lease.record, lifecycle))
    )
      return failure("reconciliation-required");
    lifecycle ??= lease.record;
  }
  const finalInventory = await inspectInventory(port);
  if (finalInventory === undefined || !sameInventory(inventory, finalInventory))
    return failure("unavailable");
  return Object.freeze({
    ok: true,
    state: "available",
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
  maximumInspectionBytes: MAXIMUM_INSPECTION_BYTES,
  maximumLeases: MAXIMUM_LEASES,
});
