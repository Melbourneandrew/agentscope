import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

const MAXIMUM_TARGETS = 16;
const MAXIMUM_TARGET_BYTES = 1_048_576;
const MAXIMUM_PATH_LENGTH = 4_096;
const MANIFEST_VERSION = 1;
const FILE_MODE = 0o600;
/* v8 ignore next -- every supported Node platform exposes O_NOFOLLOW. */
const noFollow = constants.O_NOFOLLOW ?? 0;
const readFlags = constants.O_RDONLY | noFollow;
const transactionPattern = /^[0-9a-f]{32}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const typedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
/* v8 ignore next -- the fallback object is reachable only if a supported Node
   runtime removes the intrinsic typed-array byteLength descriptor. */
const typedArrayByteLength: unknown = Reflect.get(
  Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength") ?? {},
  "get",
);
const typedArraySlice: unknown = Reflect.get(Uint8Array.prototype, "slice");

type FileSnapshot = Readonly<{
  exists: boolean;
  bytes: Uint8Array | null;
  digest: string;
  mode: number | null;
}>;

export type HarnessTargetInspection = Readonly<{
  targetPath: string;
  exists: boolean;
  bytes: Uint8Array | null;
  digest: string;
  mode: number | null;
}>;

export type HarnessTargetDecision =
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "replace"; bytes: Uint8Array }>
  | Readonly<{ kind: "replace-overlap"; bytes: Uint8Array }>
  | Readonly<{ kind: "remove" }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "unsupported" }>;

export type HarnessInstallationPlanner = (
  target: HarnessTargetInspection,
) => HarnessTargetDecision;

export type HarnessInstallationPlanInput = Readonly<{
  manifestPath: string;
  operation: "install" | "migrate" | "uninstall";
  targetPaths: readonly string[];
  planner: HarnessInstallationPlanner;
}>;

export type HarnessInstallationDisposition =
  | "ready"
  | "unchanged"
  | "conflict"
  | "unsupported"
  | "recovery-required"
  | "invalid"
  | "unavailable";

declare const planBrand: unique symbol;
export type HarnessInstallationPlan = Readonly<{
  disposition: HarnessInstallationDisposition;
  targetCount: number;
  changedTargetCount: number;
  readonly [planBrand]: true;
}>;

export type HarnessInstallationResult = Readonly<{
  ok: boolean;
  state:
    | "committed"
    | "unchanged"
    | "rolled-back"
    | "conflict"
    | "unsupported"
    | "recovery-required"
    | "invalid"
    | "unavailable";
  changedTargetCount: number;
}>;

type PlannedTarget = Readonly<{
  targetPath: string;
  before: FileSnapshot;
  after: FileSnapshot;
}>;

type PlanState = Readonly<{
  manifestPath: string;
  transactionId: string;
  targets: readonly PlannedTarget[];
}>;

type ManifestTarget = Readonly<{
  targetPath: string;
  beforeDigest: string;
  beforeExists: boolean;
  beforeMode: number | null;
  afterDigest: string;
  afterExists: boolean;
  afterMode: number | null;
  stagePath: string | null;
  backupPath: string | null;
}>;

type TransactionManifest = Readonly<{
  version: 1;
  transactionId: string;
  state: "prepared" | "committing" | "committed" | "rolling-back";
  targets: readonly ManifestTarget[];
}>;

type TargetOwnershipRecord = Readonly<{
  version: 1;
  transactionId: string;
  manifestPath: string;
  targetPath: string;
}>;

const plans = new WeakMap<
  object,
  Readonly<{
    disposition: HarnessInstallationDisposition;
    state?: PlanState;
  }>
>();
const consumedPlans = new WeakSet<object>();

export class HarnessInstallationError extends Error {
  public constructor() {
    super("harness.installation.invalid");
    this.name = "HarnessInstallationError";
  }
}

class HarnessInstallationConflictError extends HarnessInstallationError {}

const invalid = (): never => {
  throw new HarnessInstallationError();
};

const hash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const emptyDigest = hash(new Uint8Array());

const plainDataArray = (
  value: unknown,
  maximum: number,
): readonly unknown[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    /* v8 ignore next 3 -- native arrays always have an own data length; the
       fallback retains totality against a host-runtime invariant failure. */
    const length =
      lengthDescriptor && "value" in lengthDescriptor
        ? (lengthDescriptor.value as unknown)
        : undefined;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > maximum ||
      Reflect.ownKeys(descriptors).length !== length + 1 ||
      Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")
    )
      return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      /* v8 ignore next -- exact native array key cardinality above proves the
         indexed own data descriptor exists. */
      if (!descriptor || !("value" in descriptor)) return undefined;
      output.push(descriptor.value as unknown);
    }
    return Object.freeze(output);
  } catch {
    return undefined;
  }
};

const copyBytes = (value: unknown): Uint8Array | undefined => {
  try {
    if (
      !(value instanceof Uint8Array) ||
      Object.getPrototypeOf(value) !== Uint8Array.prototype
    )
      return undefined;
    /* v8 ignore next -- every supported Node runtime exposes the typed-array
       byteLength intrinsic on Uint8Array.prototype. */
    if (
      typeof typedArrayByteLength !== "function" ||
      typeof typedArraySlice !== "function"
    )
      return undefined;
    const byteLength = Reflect.apply(
      typedArrayByteLength,
      value,
      [],
    ) as unknown;
    if (
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength > MAXIMUM_TARGET_BYTES
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).some(
        (key) =>
          typeof key !== "string" ||
          !/^(0|[1-9][0-9]*)$/u.test(key) ||
          Number(key) >= byteLength,
      )
    )
      return undefined;
    const output: unknown = Reflect.apply(typedArraySlice, value, [
      0,
      byteLength,
    ]);
    /* v8 ignore next -- the captured native slice intrinsic returns a
       Uint8Array after the exact receiver validation above. */
    return output instanceof Uint8Array ? output : undefined;
  } catch {
    return undefined;
  }
};

const exactInput = (
  input: HarnessInstallationPlanInput,
): Readonly<{
  manifestPath: string;
  operation: HarnessInstallationPlanInput["operation"];
  targetPaths: readonly string[];
  planner: HarnessInstallationPlanner;
}> => {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
      Object.keys(descriptors).sort().join("\0") !==
        "manifestPath\0operation\0planner\0targetPaths" ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor))
    )
      return invalid();
    const manifestPath = descriptors.manifestPath.value as unknown;
    const operation = descriptors.operation?.value as unknown;
    const targetPathsInput = descriptors.targetPaths.value as unknown;
    const planner = descriptors.planner.value as unknown;
    const targetPathValues = plainDataArray(targetPathsInput, MAXIMUM_TARGETS);
    if (
      typeof manifestPath !== "string" ||
      !isAbsolute(manifestPath) ||
      manifestPath.length > MAXIMUM_PATH_LENGTH ||
      !["install", "migrate", "uninstall"].includes(String(operation)) ||
      typeof planner !== "function" ||
      !targetPathValues
    )
      return invalid();
    const targetPaths = targetPathValues.map((value) => {
      if (
        typeof value !== "string" ||
        !isAbsolute(value) ||
        value.length > MAXIMUM_PATH_LENGTH ||
        value === manifestPath
      )
        return invalid();
      return value;
    });
    if (
      new Set(targetPaths).size !== targetPaths.length ||
      !pathsAvoidOwnershipRecords(manifestPath, targetPaths)
    )
      return invalid();
    return Object.freeze({
      manifestPath,
      operation: operation as HarnessInstallationPlanInput["operation"],
      targetPaths: Object.freeze(targetPaths),
      planner: planner as HarnessInstallationPlanner,
    });
  } catch {
    return invalid();
  }
};

const nodeErrorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;

const inspectFile = async (path: string): Promise<FileSnapshot> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, readFlags);
    const metadata = await handle.stat();
    if (!metadata.isFile()) return invalid();
    if (metadata.size > MAXIMUM_TARGET_BYTES) return invalid();
    const buffer = Buffer.alloc(MAXIMUM_TARGET_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    /* v8 ignore next -- the pre-read metadata cap handles stable files; this
       guard catches an external growth race without allocating past max+1. */
    if (offset > MAXIMUM_TARGET_BYTES) return invalid();
    const bytes = new Uint8Array(buffer.subarray(0, offset));
    return Object.freeze({
      exists: true,
      bytes,
      digest: hash(bytes),
      mode: metadata.mode & 0o777,
    });
  } catch (error) {
    if (nodeErrorCode(error) === "ELOOP") return invalid();
    if (nodeErrorCode(error) === "ENOENT")
      return Object.freeze({
        exists: false,
        bytes: null,
        digest: emptyDigest,
        mode: null,
      });
    throw error;
  } finally {
    await handle?.close();
  }
};

const safeDecision = (
  planner: HarnessInstallationPlanner,
  targetPath: string,
  before: FileSnapshot,
): HarnessTargetDecision => {
  const input = Object.freeze({
    targetPath,
    exists: before.exists,
    bytes: before.bytes && new Uint8Array(before.bytes),
    digest: before.digest,
    mode: before.mode,
  });
  let decision: unknown;
  try {
    decision = planner(input);
  } catch {
    return invalid();
  }
  if (
    typeof decision !== "object" ||
    decision === null ||
    Array.isArray(decision)
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(decision);
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor)))
    return invalid();
  const kind = descriptors.kind?.value as unknown;
  if (
    ["unchanged", "remove", "conflict", "unsupported"].includes(String(kind))
  ) {
    if (Reflect.ownKeys(descriptors).length !== 1) return invalid();
    return Object.freeze({ kind } as HarnessTargetDecision);
  }
  if (
    !["replace", "replace-overlap"].includes(String(kind)) ||
    Reflect.ownKeys(descriptors).length !== 2 ||
    !descriptors.bytes
  )
    return invalid();
  const bytes = copyBytes(descriptors.bytes.value);
  if (!bytes) return invalid();
  return Object.freeze({
    kind: kind as "replace" | "replace-overlap",
    bytes,
  });
};

const result = (
  ok: boolean,
  state: HarnessInstallationResult["state"],
  changedTargetCount: number,
): HarnessInstallationResult =>
  Object.freeze({ ok, state, changedTargetCount });

const publicPlan = (
  disposition: HarnessInstallationDisposition,
  targetCount: number,
  changedTargetCount: number,
  state?: PlanState,
): HarnessInstallationPlan => {
  const plan = Object.freeze({ disposition, targetCount, changedTargetCount });
  plans.set(plan, Object.freeze({ disposition, ...(state ? { state } : {}) }));
  return plan as HarnessInstallationPlan;
};

const manifestExists = async (path: string): Promise<boolean> =>
  (await inspectFile(path)).exists;

export const inspectHarnessInstallation = async (
  input: HarnessInstallationPlanInput,
): Promise<HarnessInstallationPlan> => {
  try {
    const parsed = exactInput(input);
    if (await manifestExists(parsed.manifestPath))
      return publicPlan("recovery-required", parsed.targetPaths.length, 0);
    const targets: PlannedTarget[] = [];
    for (const targetPath of parsed.targetPaths) {
      const before = await inspectFile(targetPath);
      const decision = safeDecision(parsed.planner, targetPath, before);
      if (decision.kind === "conflict")
        return publicPlan("conflict", parsed.targetPaths.length, 0);
      if (decision.kind === "unsupported")
        return publicPlan("unsupported", parsed.targetPaths.length, 0);
      if (decision.kind === "replace-overlap" && parsed.operation !== "migrate")
        return publicPlan("conflict", parsed.targetPaths.length, 0);
      if (decision.kind === "unchanged") continue;
      const after =
        decision.kind === "remove"
          ? Object.freeze({
              exists: false,
              bytes: null,
              digest: emptyDigest,
              mode: null,
            })
          : Object.freeze({
              exists: true,
              bytes: new Uint8Array(decision.bytes),
              digest: hash(decision.bytes),
              mode: before.mode ?? FILE_MODE,
            });
      if (before.exists === after.exists && before.digest === after.digest)
        continue;
      targets.push(Object.freeze({ targetPath, before, after }));
    }
    if (targets.length === 0)
      return publicPlan("unchanged", parsed.targetPaths.length, 0);
    const state = Object.freeze({
      manifestPath: parsed.manifestPath,
      transactionId: randomBytes(16).toString("hex"),
      targets: Object.freeze(targets),
    });
    return publicPlan(
      "ready",
      parsed.targetPaths.length,
      targets.length,
      state,
    );
  } catch (error) {
    return publicPlan(
      error instanceof HarnessInstallationError ? "invalid" : "unavailable",
      0,
      0,
    );
  }
};

const canonicalManifest = (manifest: TransactionManifest): string =>
  `${JSON.stringify(manifest)}\n`;

const artifactPrefix = (transactionId: string, targetPath: string): string =>
  join(
    dirname(targetPath),
    `.agentscope-${transactionId}-${createHash("sha256")
      .update(targetPath)
      .digest("hex")
      .slice(0, 16)}`,
  );

const ownershipCandidatePath = (
  transactionId: string,
  targetPath: string,
): string => `${artifactPrefix(transactionId, targetPath)}.owner`;

const ownershipMarkerPath = (targetPath: string): string =>
  join(
    dirname(targetPath),
    `.agentscope-installation-${createHash("sha256")
      .update(targetPath)
      .digest("hex")}.owner`,
  );

const ownershipClaimPath = (targetPath: string): string =>
  `${ownershipMarkerPath(targetPath)}.claim`;

const pathsAvoidOwnershipRecords = (
  manifestPath: string,
  targetPaths: readonly string[],
): boolean => {
  const reserved = new Set(
    targetPaths.flatMap((targetPath) => [
      ownershipMarkerPath(targetPath),
      ownershipClaimPath(targetPath),
    ]),
  );
  return (
    !reserved.has(manifestPath) &&
    targetPaths.every((targetPath) => !reserved.has(targetPath))
  );
};

const ownershipRecord = (
  manifestPath: string,
  transactionId: string,
  targetPath: string,
): TargetOwnershipRecord =>
  Object.freeze({
    version: 1,
    transactionId,
    manifestPath,
    targetPath,
  });

const canonicalOwnershipRecord = (record: TargetOwnershipRecord): string =>
  `${JSON.stringify(record)}\n`;

const manifestTarget = (
  state: PlanState,
  target: PlannedTarget,
): ManifestTarget => {
  const token = state.transactionId;
  const prefix = artifactPrefix(token, target.targetPath);
  return Object.freeze({
    targetPath: target.targetPath,
    beforeDigest: target.before.digest,
    beforeExists: target.before.exists,
    beforeMode: target.before.mode,
    afterDigest: target.after.digest,
    afterExists: target.after.exists,
    afterMode: target.after.mode,
    stagePath: target.after.exists ? `${prefix}.stage` : null,
    backupPath: target.before.exists ? `${prefix}.backup` : null,
  });
};

const writeExclusive = async (
  path: string,
  bytes: Uint8Array | string,
  mode: number,
): Promise<void> => {
  const handle = await open(path, "wx", mode);
  try {
    await handle.chmod(mode);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(dirname(path), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const parseOwnershipRecord = (
  snapshot: FileSnapshot,
  expectedTargetPath: string,
): TargetOwnershipRecord | undefined => {
  if (!snapshot.exists || !snapshot.bytes || snapshot.mode !== FILE_MODE)
    return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      snapshot.bytes,
    );
    const value = JSON.parse(text) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return undefined;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join("\0") !==
        "manifestPath\0targetPath\0transactionId\0version" ||
      record.version !== 1 ||
      typeof record.transactionId !== "string" ||
      !transactionPattern.test(record.transactionId) ||
      typeof record.manifestPath !== "string" ||
      !isAbsolute(record.manifestPath) ||
      record.manifestPath.length > MAXIMUM_PATH_LENGTH ||
      record.targetPath !== expectedTargetPath
    )
      return undefined;
    const parsed = ownershipRecord(
      record.manifestPath,
      record.transactionId,
      expectedTargetPath,
    );
    return canonicalOwnershipRecord(parsed) === text ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const ownershipSnapshotMatches = (
  snapshot: FileSnapshot,
  expected: TargetOwnershipRecord,
): boolean =>
  snapshot.exists &&
  snapshot.mode === FILE_MODE &&
  snapshot.digest ===
    hash(new TextEncoder().encode(canonicalOwnershipRecord(expected)));

const ensureTargetOwnership = async (
  manifestPath: string,
  transactionId: string,
  targetPath: string,
): Promise<void> => {
  const expected = ownershipRecord(manifestPath, transactionId, targetPath);
  const candidatePath = ownershipCandidatePath(transactionId, targetPath);
  const markerPath = ownershipMarkerPath(targetPath);
  const claimPath = ownershipClaimPath(targetPath);
  const candidate = await inspectFile(candidatePath);
  if (!candidate.exists) {
    await writeExclusive(
      candidatePath,
      canonicalOwnershipRecord(expected),
      FILE_MODE,
    );
    await syncDirectory(candidatePath);
  } else if (!ownershipSnapshotMatches(candidate, expected)) {
    throw new HarnessInstallationConflictError();
  }
  try {
    await link(candidatePath, claimPath);
    await syncDirectory(claimPath);
  } catch (error) {
    /* v8 ignore next 1 -- native hard-link failures other than an existing
       fixed claim are surfaced unchanged as filesystem unavailability. */
    if (nodeErrorCode(error) !== "EEXIST") throw error;
    if (!ownershipSnapshotMatches(await inspectFile(claimPath), expected))
      throw new HarnessInstallationConflictError();
  }
  try {
    await link(candidatePath, markerPath);
    await syncDirectory(markerPath);
    return;
  } catch (error) {
    /* v8 ignore next 1 -- the fixed marker normally exists after the first
       completed transaction; other native failures remain unavailable. */
    if (nodeErrorCode(error) !== "EEXIST") throw error;
  }
  const marker = await inspectFile(markerPath);
  if (ownershipSnapshotMatches(marker, expected)) return;
  const prior = parseOwnershipRecord(marker, targetPath);
  if (!prior || (await manifestExists(prior.manifestPath)))
    throw new HarnessInstallationConflictError();
  await unlink(markerPath);
  await syncDirectory(markerPath);
  try {
    await link(candidatePath, markerPath);
    await syncDirectory(markerPath);
  } catch (error) {
    /* v8 ignore next 2 -- requires another process to win the exact
       unlink-to-link race; either winner remains authoritative. */
    if (nodeErrorCode(error) === "EEXIST")
      throw new HarnessInstallationConflictError();
    /* v8 ignore next -- other native hard-link failures are unavailable. */
    throw error;
  }
};

const ensureManifestOwnership = async (
  manifestPath: string,
  manifest: TransactionManifest,
): Promise<void> => {
  const targets = [...manifest.targets].sort((left, right) =>
    left.targetPath.localeCompare(right.targetPath),
  );
  for (const target of targets)
    await ensureTargetOwnership(
      manifestPath,
      manifest.transactionId,
      target.targetPath,
    );
};

const ensureRecordedManifestOwnership = async (
  manifestPath: string,
  manifest: TransactionManifest,
): Promise<boolean> => {
  for (const target of manifest.targets) {
    const expected = ownershipRecord(
      manifestPath,
      manifest.transactionId,
      target.targetPath,
    );
    if (
      !ownershipSnapshotMatches(
        await inspectFile(ownershipMarkerPath(target.targetPath)),
        expected,
      )
    )
      return false;
  }
  await ensureManifestOwnership(manifestPath, manifest);
  return true;
};

const removeExactOwnershipClaim = async (
  manifestPath: string,
  manifest: TransactionManifest,
  targetPath: string,
): Promise<void> => {
  const claimPath = ownershipClaimPath(targetPath);
  const expected = ownershipRecord(
    manifestPath,
    manifest.transactionId,
    targetPath,
  );
  if (ownershipSnapshotMatches(await inspectFile(claimPath), expected))
    await unlink(claimPath);
};

const removeExactOwnershipMarker = async (
  manifestPath: string,
  manifest: TransactionManifest,
  targetPath: string,
): Promise<void> => {
  const markerPath = ownershipMarkerPath(targetPath);
  const expected = ownershipRecord(
    manifestPath,
    manifest.transactionId,
    targetPath,
  );
  if (ownershipSnapshotMatches(await inspectFile(markerPath), expected))
    await unlink(markerPath);
};

const replaceManifest = async (
  path: string,
  manifest: TransactionManifest,
): Promise<void> => {
  const temporary = `${path}.${manifest.transactionId}.tmp`;
  await writeExclusive(temporary, canonicalManifest(manifest), FILE_MODE);
  await rename(temporary, path);
  await syncDirectory(path);
};

const snapshotMatches = (
  snapshot: FileSnapshot,
  exists: boolean,
  digest: string,
) => snapshot.exists === exists && snapshot.digest === digest;

const snapshotMatchesManifestState = (
  snapshot: FileSnapshot,
  exists: boolean,
  digest: string,
  mode: number | null,
): boolean =>
  snapshotMatches(snapshot, exists, digest) && snapshot.mode === mode;

const prepareManifest = async (
  state: PlanState,
): Promise<TransactionManifest> => {
  await mkdir(dirname(state.manifestPath), { recursive: true, mode: 0o700 });
  const targets = state.targets.map((target) => manifestTarget(state, target));
  const manifest = Object.freeze({
    version: MANIFEST_VERSION,
    transactionId: state.transactionId,
    state: "prepared" as const,
    targets: Object.freeze(targets),
  });
  await writeExclusive(
    state.manifestPath,
    canonicalManifest(manifest),
    FILE_MODE,
  );
  await syncDirectory(state.manifestPath);
  for (let index = 0; index < targets.length; index += 1) {
    const target = state.targets[index]!;
    const entry = targets[index]!;
    if (entry.stagePath && target.after.bytes) {
      await writeExclusive(
        entry.stagePath,
        target.after.bytes,
        target.after.mode!,
      );
    }
    if (entry.backupPath && target.before.bytes) {
      await writeExclusive(
        entry.backupPath,
        target.before.bytes,
        target.before.mode!,
      );
    }
    await syncDirectory(target.targetPath);
  }
  await ensureManifestOwnership(state.manifestPath, manifest);
  return manifest;
};

const withState = (
  manifest: TransactionManifest,
  state: TransactionManifest["state"],
): TransactionManifest => Object.freeze({ ...manifest, state });

const commitManifest = async (
  path: string,
  manifest: TransactionManifest,
): Promise<void> => {
  if (manifest.state === "prepared") {
    await ensureManifestOwnership(path, manifest);
    for (const target of manifest.targets) {
      if (
        !snapshotMatchesManifestState(
          await inspectFile(target.targetPath),
          target.beforeExists,
          target.beforeDigest,
          target.beforeMode,
        )
      )
        throw new HarnessInstallationConflictError();
    }
  } else if (!(await ensureRecordedManifestOwnership(path, manifest))) {
    throw new HarnessInstallationConflictError();
  }
  let working = withState(manifest, "committing");
  await replaceManifest(path, working);
  for (const target of working.targets) {
    const current = await inspectFile(target.targetPath);
    if (
      !snapshotMatchesManifestState(
        current,
        target.beforeExists,
        target.beforeDigest,
        target.beforeMode,
      ) &&
      !snapshotMatchesManifestState(
        current,
        target.afterExists,
        target.afterDigest,
        target.afterMode,
      )
    )
      throw new HarnessInstallationConflictError();
    if (
      !snapshotMatchesManifestState(
        current,
        target.afterExists,
        target.afterDigest,
        target.afterMode,
      )
    ) {
      if (target.afterExists) {
        const staged = await inspectFile(target.stagePath!);
        if (!staged.exists) throw new Error("harness.installation.unavailable");
        if (
          !snapshotMatchesManifestState(
            staged,
            true,
            target.afterDigest,
            target.afterMode,
          )
        )
          throw new HarnessInstallationConflictError();
        await rename(target.stagePath!, target.targetPath);
      } else {
        await unlink(target.targetPath);
      }
      await syncDirectory(target.targetPath);
    }
    const verified = await inspectFile(target.targetPath);
    /* v8 ignore next 2 -- only an external write in the exact post-rename
       verification window can change the just-replaced target. */
    if (
      !snapshotMatchesManifestState(
        verified,
        target.afterExists,
        target.afterDigest,
        target.afterMode,
      )
    )
      throw new HarnessInstallationConflictError();
  }
  working = withState(working, "committed");
  await replaceManifest(path, working);
};

const removeIfPresent = async (path: string | null): Promise<void> => {
  if (!path) return;
  try {
    await unlink(path);
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
};

const finishTransaction = async (
  manifestPath: string,
  manifest: TransactionManifest,
  removeOwnershipMarker = false,
) => {
  for (const target of manifest.targets) {
    await removeIfPresent(target.stagePath);
    await removeIfPresent(target.backupPath);
    if (removeOwnershipMarker)
      await removeExactOwnershipMarker(
        manifestPath,
        manifest,
        target.targetPath,
      );
    await removeIfPresent(
      ownershipCandidatePath(manifest.transactionId, target.targetPath),
    );
    await removeExactOwnershipClaim(manifestPath, manifest, target.targetPath);
    await syncDirectory(target.targetPath);
  }
  await removeIfPresent(`${manifestPath}.${manifest.transactionId}.tmp`);
  await removeIfPresent(manifestPath);
  await syncDirectory(manifestPath);
};

export const applyHarnessInstallation = async (
  plan: HarnessInstallationPlan,
): Promise<HarnessInstallationResult> => {
  const registered =
    typeof plan === "object" && plan !== null ? plans.get(plan) : undefined;
  if (!registered || consumedPlans.has(plan))
    return result(false, "invalid", 0);
  if (registered.disposition === "unchanged")
    return result(true, "unchanged", 0);
  if (registered.disposition !== "ready")
    return result(false, registered.disposition, 0);
  const state = registered.state;
  /* v8 ignore next -- every registered ready plan stores its private state. */
  if (!state) return result(false, "invalid", 0);
  consumedPlans.add(plan);
  let manifest: TransactionManifest | undefined;
  try {
    if (await manifestExists(state.manifestPath))
      return result(false, "recovery-required", 0);
    for (const target of state.targets) {
      const current = await inspectFile(target.targetPath);
      if (!snapshotMatches(current, target.before.exists, target.before.digest))
        return result(false, "conflict", 0);
    }
    manifest = await prepareManifest(state);
    await commitManifest(state.manifestPath, manifest);
    manifest = withState(manifest, "committed");
    await finishTransaction(state.manifestPath, manifest);
    return result(true, "committed", state.targets.length);
  } catch (error) {
    /* v8 ignore next 5 -- a branded ready plan reaches only native filesystem
       failures here; subclasses cover defensive internal race drift. */
    return result(
      false,
      error instanceof HarnessInstallationConflictError
        ? "conflict"
        : error instanceof HarnessInstallationError
          ? "invalid"
          : "unavailable",
      0,
    );
  }
};

const parseManifestTarget = (input: unknown): ManifestTarget => {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    return invalid();
  const target = input as Record<string, unknown>;
  if (
    Object.keys(target).sort().join("\0") !==
      "afterDigest\0afterExists\0afterMode\0backupPath\0beforeDigest\0beforeExists\0beforeMode\0stagePath\0targetPath" ||
    typeof target.targetPath !== "string" ||
    !isAbsolute(target.targetPath) ||
    typeof target.beforeDigest !== "string" ||
    !digestPattern.test(target.beforeDigest) ||
    typeof target.afterDigest !== "string" ||
    !digestPattern.test(target.afterDigest) ||
    typeof target.beforeExists !== "boolean" ||
    typeof target.afterExists !== "boolean" ||
    (target.beforeMode !== null &&
      (typeof target.beforeMode !== "number" ||
        !Number.isSafeInteger(target.beforeMode))) ||
    (target.afterMode !== null &&
      (typeof target.afterMode !== "number" ||
        !Number.isSafeInteger(target.afterMode))) ||
    (target.stagePath !== null &&
      (typeof target.stagePath !== "string" ||
        !isAbsolute(target.stagePath))) ||
    (target.backupPath !== null &&
      (typeof target.backupPath !== "string" || !isAbsolute(target.backupPath)))
  )
    return invalid();
  return Object.freeze({
    targetPath: target.targetPath,
    beforeDigest: target.beforeDigest,
    beforeExists: target.beforeExists,
    beforeMode: target.beforeMode,
    afterDigest: target.afterDigest,
    afterExists: target.afterExists,
    afterMode: target.afterMode,
    stagePath: target.stagePath,
    backupPath: target.backupPath,
  });
};

const parseManifestRecord = (
  value: unknown,
  text: string,
  manifestPath: string,
): TransactionManifest => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !==
    "state\0targets\0transactionId\0version"
  )
    return invalid();
  const transactionId = record.transactionId;
  const state = record.state;
  const targetsInput = record.targets;
  if (
    record.version !== MANIFEST_VERSION ||
    typeof transactionId !== "string" ||
    !transactionPattern.test(transactionId) ||
    typeof state !== "string" ||
    !["prepared", "committing", "committed", "rolling-back"].includes(state) ||
    !Array.isArray(targetsInput) ||
    targetsInput.length < 1 ||
    targetsInput.length > MAXIMUM_TARGETS
  )
    return invalid();
  const targets = targetsInput.map((target) => parseManifestTarget(target));
  if (
    new Set(targets.map((target) => target.targetPath)).size !==
      targets.length ||
    !pathsAvoidOwnershipRecords(
      manifestPath,
      targets.map((target) => target.targetPath),
    ) ||
    targets.some((target) => {
      const prefix = artifactPrefix(transactionId, target.targetPath);
      return (
        target.targetPath === manifestPath ||
        target.stagePath !== (target.afterExists ? `${prefix}.stage` : null) ||
        target.backupPath !==
          (target.beforeExists ? `${prefix}.backup` : null) ||
        target.beforeExists !== (target.beforeMode !== null) ||
        target.afterExists !== (target.afterMode !== null)
      );
    })
  )
    return invalid();
  const manifest = Object.freeze({
    version: MANIFEST_VERSION,
    transactionId,
    state: state as TransactionManifest["state"],
    targets: Object.freeze(targets),
  });
  if (canonicalManifest(manifest) !== text) return invalid();
  return manifest;
};

const parseManifest = async (path: string): Promise<TransactionManifest> => {
  if (!isAbsolute(path) || path.length > MAXIMUM_PATH_LENGTH) return invalid();
  const snapshot = await inspectFile(path);
  if (!snapshot.exists || !snapshot.bytes) return invalid();
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      snapshot.bytes,
    );
    return parseManifestRecord(JSON.parse(text) as unknown, text, path);
  } catch (error) {
    if (error instanceof HarnessInstallationError) throw error;
    return invalid();
  }
};

const restoreTarget = async (
  target: ManifestTarget,
  current: FileSnapshot,
): Promise<HarnessInstallationResult | undefined> => {
  if (
    !snapshotMatchesManifestState(
      current,
      target.afterExists,
      target.afterDigest,
      target.afterMode,
    )
  )
    return undefined;
  if (target.beforeExists) {
    /* v8 ignore next -- manifest validation makes backup presence equivalent
       to beforeExists. */
    if (!target.backupPath) return result(false, "invalid", 0);
    const backup = await inspectFile(target.backupPath);
    if (!backup.exists) throw new Error("harness.installation.unavailable");
    if (
      !snapshotMatches(backup, true, target.beforeDigest) ||
      backup.mode !== target.beforeMode
    )
      throw new HarnessInstallationConflictError();
    await rename(target.backupPath, target.targetPath);
  } else {
    /* v8 ignore else -- a current value matching an afterExists=true manifest
       entry necessarily exists. */
    /* v8 ignore next */
    if (!current.exists) return undefined;
    await unlink(target.targetPath);
  }
  await syncDirectory(target.targetPath);
  return undefined;
};

export const resumeHarnessInstallation = async (
  manifestPath: string,
): Promise<HarnessInstallationResult> => {
  try {
    const manifest = await parseManifest(manifestPath);
    await commitManifest(manifestPath, manifest);
    await finishTransaction(manifestPath, withState(manifest, "committed"));
    return result(true, "committed", manifest.targets.length);
  } catch (error) {
    return result(
      false,
      error instanceof HarnessInstallationConflictError
        ? "conflict"
        : error instanceof HarnessInstallationError
          ? "invalid"
          : "unavailable",
      0,
    );
  }
};

export const rollbackHarnessInstallation = async (
  manifestPath: string,
): Promise<HarnessInstallationResult> => {
  try {
    let manifest = await parseManifest(manifestPath);
    if (manifest.state === "prepared") {
      await finishTransaction(manifestPath, manifest, true);
      return result(true, "rolled-back", manifest.targets.length);
    }
    if (!(await ensureRecordedManifestOwnership(manifestPath, manifest)))
      return result(false, "conflict", 0);
    manifest = withState(manifest, "rolling-back");
    await replaceManifest(manifestPath, manifest);
    for (const target of [...manifest.targets].reverse()) {
      const current = await inspectFile(target.targetPath);
      if (
        !snapshotMatchesManifestState(
          current,
          target.beforeExists,
          target.beforeDigest,
          target.beforeMode,
        ) &&
        !snapshotMatchesManifestState(
          current,
          target.afterExists,
          target.afterDigest,
          target.afterMode,
        )
      )
        return result(false, "conflict", 0);
      const restoreFailure = await restoreTarget(target, current);
      /* v8 ignore next -- validated manifests cannot make restoreTarget return
         a failure after the exact current-state classification above. */
      if (restoreFailure) return restoreFailure;
    }
    await finishTransaction(manifestPath, manifest);
    return result(true, "rolled-back", manifest.targets.length);
  } catch (error) {
    return result(
      false,
      error instanceof HarnessInstallationConflictError
        ? "conflict"
        : error instanceof HarnessInstallationError
          ? "invalid"
          : "unavailable",
      0,
    );
  }
};
