import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

import { createDestinationConnectionId } from "@agentscope/destinations-core";

import { LOCAL_SQLITE_DESTINATION_TYPE } from "./capability.js";

type PathPlatform = "posix" | "win32";

declare const namespacePlanBrand: unique symbol;
export type LocalSqliteNamespacePlan = Readonly<{
  schemaVersion: 1;
  platform: PathPlatform;
  agentscopeHome: string;
  connectionId: string;
  connectionDigest: string;
  destinationsDirectory: string;
  destinationTypeDirectory: string;
  connectionNamespace: string;
  databasePath: string;
  lifecycleDirectory: string;
  backupsDirectory: string;
  fingerprint: string;
  readonly [namespacePlanBrand]: true;
}>;

export type LocalSqliteNamespacePlanInput = Readonly<{
  platform: PathPlatform;
  agentscopeHome: string;
  connectionId: string;
}>;

type LocalSqliteNamespaceRole =
  | "agentscope-home"
  | "destinations"
  | "destination-type"
  | "connection-namespace";

export type LocalSqliteExistingAncestorEvidence = Readonly<{
  role: LocalSqliteNamespaceRole;
  path: string;
  state: "existing";
  kind: "directory";
  physicalIdentity: string;
  noFollow: true;
  currentUserOnly: true;
}>;

export type LocalSqlitePlannedAbsentAncestor = Readonly<{
  role: LocalSqliteNamespaceRole;
  path: string;
  state: "planned-absent";
  noFollow: true;
  createMode: "current-user-only";
}>;

export type LocalSqliteAbsenceBoundaryEvidence = Readonly<{
  parentRole: LocalSqliteNamespaceRole;
  parentPath: string;
  parentPhysicalIdentity: string;
  firstAbsentRole: LocalSqliteNamespaceRole;
  firstAbsentPath: string;
  noFollow: true;
  nameCollisionFree: true;
}>;

export type LocalSqlitePhysicalNamespaceEvidenceInput = Readonly<{
  schemaVersion: 1;
  filesystemProfile: string;
  existingAncestors: readonly LocalSqliteExistingAncestorEvidence[];
  plannedAbsentAncestors: readonly LocalSqlitePlannedAbsentAncestor[];
  absenceBoundary: LocalSqliteAbsenceBoundaryEvidence | null;
}>;

export type LocalSqlitePhysicalNamespaceEvidence = Readonly<{
  schemaVersion: 1;
  namespaceFingerprint: string;
  filesystemProfile: string;
  existingAncestors: readonly LocalSqliteExistingAncestorEvidence[];
  plannedAbsentAncestors: readonly LocalSqlitePlannedAbsentAncestor[];
  absenceBoundary: LocalSqliteAbsenceBoundaryEvidence | null;
  fingerprint: string;
}>;

const namespacePlans = new WeakSet<object>();

export class LocalSqliteNamespaceError extends Error {
  public readonly code = "destination.local-sqlite.namespace-invalid";

  public constructor() {
    super("destination.local-sqlite.namespace-invalid");
    this.name = "LocalSqliteNamespaceError";
  }
}

const invalid = (): never => {
  throw new LocalSqliteNamespaceError();
};

const exactRecord = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return invalid();
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) return invalid();
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
};

const exactArray = (
  value: unknown,
  minimum: number,
  maximum: number,
): readonly unknown[] => {
  if (!Array.isArray(value)) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(
    value,
  ) as unknown as PropertyDescriptorMap;
  const length: unknown = descriptors["length"]?.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < minimum ||
    length > maximum
  )
    return invalid();
  const expected = new Set([
    "length",
    ...Array.from({ length }, (_, index) => String(index)),
  ]);
  if (
    descriptors["length"]?.value !== length ||
    Reflect.ownKeys(descriptors).length !== expected.size ||
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== "string" || !expected.has(key),
    )
  )
    return invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) return invalid();
    result.push(descriptor.value);
  }
  return Object.freeze(result);
};

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const fingerprint = (value: object): string =>
  `sha256-${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

const parseHome = (value: unknown, platform: PathPlatform): string => {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    value !== value.normalize("NFC") ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return (
        code !== undefined &&
        (code <= 31 || code === 127 || (code >= 0xd800 && code <= 0xdfff))
      );
    })
  )
    return invalid();
  if (platform === "posix") {
    if (
      !posix.isAbsolute(value) ||
      value === "/" ||
      posix.normalize(value) !== value ||
      value
        .slice(1)
        .split("/")
        .some((segment) => Buffer.byteLength(segment, "utf8") > 255)
    )
      return invalid();
  } else {
    if (
      !/^[A-Z]:\\/u.test(value) ||
      /^[A-Z]:\\$/u.test(value) ||
      win32.normalize(value) !== value ||
      value.endsWith("\\")
    )
      return invalid();
    const segments = value.slice(3).split("\\");
    if (
      segments.some((segment) => {
        const stem = segment.split(".", 1)[0]?.toUpperCase();
        return (
          segment.length === 0 ||
          segment.length > 255 ||
          segment.endsWith(".") ||
          segment.endsWith(" ") ||
          segment.includes(":") ||
          stem === "CON" ||
          stem === "PRN" ||
          stem === "AUX" ||
          stem === "NUL" ||
          stem === "CONIN$" ||
          stem === "CONOUT$" ||
          (stem !== undefined && /^(?:COM|LPT)(?:[1-9]|[¹²³])$/u.test(stem))
        );
      })
    )
      return invalid();
  }
  return value;
};

const join = (platform: PathPlatform, ...parts: string[]): string =>
  platform === "posix" ? posix.join(...parts) : win32.join(...parts);

export const planLocalSqliteNamespace = (
  input: LocalSqliteNamespacePlanInput,
): LocalSqliteNamespacePlan => {
  try {
    const record = exactRecord(input, [
      "agentscopeHome",
      "connectionId",
      "platform",
    ]);
    if (record.platform !== "posix" && record.platform !== "win32")
      return invalid();
    const platform = record.platform;
    const agentscopeHome = parseHome(record.agentscopeHome, platform);
    const connectionId = createDestinationConnectionId(record.connectionId);
    const connectionDigest = digest(
      JSON.stringify({
        connectionId,
        destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
      }),
    );
    const destinationsDirectory = join(
      platform,
      agentscopeHome,
      "destinations",
    );
    const destinationTypeDirectory = join(
      platform,
      destinationsDirectory,
      "local-sqlite",
    );
    const connectionNamespace = join(
      platform,
      destinationTypeDirectory,
      connectionDigest,
    );
    const material = Object.freeze({
      agentscopeHome,
      backupsDirectory: join(platform, connectionNamespace, "backups"),
      connectionDigest,
      connectionId,
      connectionNamespace,
      databasePath: join(platform, connectionNamespace, "traces.sqlite"),
      destinationsDirectory,
      destinationTypeDirectory,
      lifecycleDirectory: join(platform, connectionNamespace, "lifecycle"),
      platform,
      schemaVersion: 1 as const,
    });
    const plan = Object.freeze({
      ...material,
      fingerprint: fingerprint(material),
    }) as unknown as LocalSqliteNamespacePlan;
    namespacePlans.add(plan);
    return plan;
  } catch {
    return invalid();
  }
};

const EVIDENCE_ROLES = Object.freeze([
  "agentscope-home",
  "destinations",
  "destination-type",
  "connection-namespace",
] as const);

const parseExistingAncestors = (
  inputs: readonly unknown[],
  paths: readonly string[],
): readonly LocalSqliteExistingAncestorEvidence[] => {
  const identities = new Set<string>();
  const ancestors: LocalSqliteExistingAncestorEvidence[] = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const ancestor = exactRecord(inputs[index], [
      "currentUserOnly",
      "kind",
      "noFollow",
      "path",
      "physicalIdentity",
      "role",
      "state",
    ]);
    if (
      ancestor.role !== EVIDENCE_ROLES[index] ||
      ancestor.path !== paths[index] ||
      ancestor.state !== "existing" ||
      ancestor.kind !== "directory" ||
      ancestor.noFollow !== true ||
      ancestor.currentUserOnly !== true ||
      typeof ancestor.physicalIdentity !== "string" ||
      ancestor.physicalIdentity.length > 192 ||
      !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(ancestor.physicalIdentity) ||
      identities.has(ancestor.physicalIdentity)
    )
      return invalid();
    identities.add(ancestor.physicalIdentity);
    ancestors.push(
      Object.freeze({
        currentUserOnly: true,
        kind: "directory",
        noFollow: true,
        path: ancestor.path,
        physicalIdentity: ancestor.physicalIdentity,
        role: ancestor.role,
        state: "existing",
      }) as LocalSqliteExistingAncestorEvidence,
    );
  }
  return Object.freeze(ancestors);
};

const parsePlannedAbsentAncestors = (
  inputs: readonly unknown[],
  startIndex: number,
  paths: readonly string[],
): readonly LocalSqlitePlannedAbsentAncestor[] => {
  const ancestors: LocalSqlitePlannedAbsentAncestor[] = [];
  for (let offset = 0; offset < inputs.length; offset += 1) {
    const index = startIndex + offset;
    const ancestor = exactRecord(inputs[offset], [
      "createMode",
      "noFollow",
      "path",
      "role",
      "state",
    ]);
    if (
      ancestor.role !== EVIDENCE_ROLES[index] ||
      ancestor.path !== paths[index] ||
      ancestor.state !== "planned-absent" ||
      ancestor.noFollow !== true ||
      ancestor.createMode !== "current-user-only"
    )
      return invalid();
    ancestors.push(
      Object.freeze({
        createMode: "current-user-only",
        noFollow: true,
        path: ancestor.path,
        role: ancestor.role,
        state: "planned-absent",
      }) as LocalSqlitePlannedAbsentAncestor,
    );
  }
  return Object.freeze(ancestors);
};

const parseAbsenceBoundary = (
  value: unknown,
  existing: readonly LocalSqliteExistingAncestorEvidence[],
  planned: readonly LocalSqlitePlannedAbsentAncestor[],
): LocalSqliteAbsenceBoundaryEvidence | null => {
  if (planned.length === 0) {
    if (value !== null) return invalid();
    return null;
  }
  const boundary = exactRecord(value, [
    "firstAbsentPath",
    "firstAbsentRole",
    "nameCollisionFree",
    "noFollow",
    "parentPath",
    "parentPhysicalIdentity",
    "parentRole",
  ]);
  const parent = existing.at(-1)!;
  const firstAbsent = planned[0]!;
  if (
    boundary.parentRole !== parent.role ||
    boundary.parentPath !== parent.path ||
    boundary.parentPhysicalIdentity !== parent.physicalIdentity ||
    boundary.firstAbsentRole !== firstAbsent.role ||
    boundary.firstAbsentPath !== firstAbsent.path ||
    boundary.noFollow !== true ||
    boundary.nameCollisionFree !== true
  )
    return invalid();
  return Object.freeze({
    firstAbsentPath: firstAbsent.path,
    firstAbsentRole: firstAbsent.role,
    nameCollisionFree: true,
    noFollow: true,
    parentPath: parent.path,
    parentPhysicalIdentity: parent.physicalIdentity,
    parentRole: parent.role,
  });
};

export const compileLocalSqlitePhysicalNamespaceEvidence = (
  plan: LocalSqliteNamespacePlan,
  input: LocalSqlitePhysicalNamespaceEvidenceInput,
): LocalSqlitePhysicalNamespaceEvidence => {
  try {
    if (!namespacePlans.has(plan)) return invalid();
    const record = exactRecord(input, [
      "absenceBoundary",
      "existingAncestors",
      "filesystemProfile",
      "plannedAbsentAncestors",
      "schemaVersion",
    ]);
    if (
      record.schemaVersion !== 1 ||
      typeof record.filesystemProfile !== "string" ||
      record.filesystemProfile.length > 96 ||
      !/^[a-z0-9][a-z0-9.-]*$/u.test(record.filesystemProfile)
    )
      return invalid();
    const existingInputs = exactArray(
      record.existingAncestors,
      1,
      EVIDENCE_ROLES.length,
    );
    const plannedInputs = exactArray(
      record.plannedAbsentAncestors,
      EVIDENCE_ROLES.length - existingInputs.length,
      EVIDENCE_ROLES.length - existingInputs.length,
    );
    const paths = [
      plan.agentscopeHome,
      plan.destinationsDirectory,
      plan.destinationTypeDirectory,
      plan.connectionNamespace,
    ];
    const existingAncestors = parseExistingAncestors(existingInputs, paths);
    const plannedAbsentAncestors = parsePlannedAbsentAncestors(
      plannedInputs,
      existingInputs.length,
      paths,
    );
    const absenceBoundary = parseAbsenceBoundary(
      record.absenceBoundary,
      existingAncestors,
      plannedAbsentAncestors,
    );
    const material = Object.freeze({
      absenceBoundary,
      existingAncestors,
      filesystemProfile: record.filesystemProfile,
      namespaceFingerprint: plan.fingerprint,
      plannedAbsentAncestors,
      schemaVersion: 1 as const,
    });
    return Object.freeze({
      ...material,
      fingerprint: fingerprint(material),
    });
  } catch {
    return invalid();
  }
};
