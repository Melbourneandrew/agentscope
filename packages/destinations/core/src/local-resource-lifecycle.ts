import { createHash } from "node:crypto";

import { createDestinationTypeId, type DestinationTypeId } from "./identity.js";
import {
  REPORTER_RECEIPT_REASONS,
  type ReporterReceiptReason,
} from "./reporter.js";

export const LOCAL_RESOURCE_LIFECYCLE_OPERATIONS = Object.freeze([
  "backup",
  "configure",
  "delete",
  "doctor",
  "recover",
  "restore",
  "unconfigure",
] as const);

export type LocalResourceLifecycleOperation =
  (typeof LOCAL_RESOURCE_LIFECYCLE_OPERATIONS)[number];

declare const localResourceLifecycleCapabilityBrand: unique symbol;
declare const localResourceLifecycleDeclarationBrand: unique symbol;

type LocalResourceLifecycleMaterial = Readonly<{
  capabilityVersion: 1;
  destinationType: DestinationTypeId;
  settingsVersion: number;
  settingKeys: readonly string[];
  operations: readonly LocalResourceLifecycleOperation[];
  artifactGrammarVersion: number;
  artifactGrammarFingerprint: string;
  artifactKinds: readonly string[];
  receiptReasons: readonly ReporterReceiptReason[];
  recoveryHandlerId: string;
}>;

export type LocalResourceLifecycleDeclaration = LocalResourceLifecycleMaterial &
  Readonly<{
    readonly [localResourceLifecycleDeclarationBrand]: true;
  }>;

export type LocalResourceLifecycleCapability = LocalResourceLifecycleMaterial &
  Readonly<{
    settingsSchemaFingerprint: string;
    fingerprint: string;
    readonly [localResourceLifecycleCapabilityBrand]: true;
  }>;

export type LocalResourceLifecycleDeclarationInput = Readonly<{
  capabilityVersion: 1;
  destinationType: string;
  settingsVersion: number;
  settingKeys: readonly string[];
  operations: readonly LocalResourceLifecycleOperation[];
  artifactGrammarVersion: number;
  artifactGrammarFingerprint: string;
  artifactKinds: readonly string[];
  receiptReasons: readonly string[];
  recoveryHandlerId: string;
}>;

const capabilityRegistry = new WeakSet<object>();
const declarationRegistry = new WeakSet<object>();
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const objectGetPrototypeOf = Object.getPrototypeOf;
const reflectOwnKeys = Reflect.ownKeys;
const objectFreeze = Object.freeze;

export class DestinationLocalResourceLifecycleError extends Error {
  public readonly code = "destination.local-resource-lifecycle.invalid";

  public constructor() {
    super("destination.local-resource-lifecycle.invalid");
    this.name = "DestinationLocalResourceLifecycleError";
  }
}

const invalid = (): never => {
  throw new DestinationLocalResourceLifecycleError();
};

const exactRecord = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    objectGetPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const descriptors = objectGetOwnPropertyDescriptors(value);
  const actual = reflectOwnKeys(descriptors);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return invalid();
  const output: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) return invalid();
    output[key] = descriptor.value;
  }
  return objectFreeze(output);
};

const exactArray = (value: unknown, maximum: number): readonly unknown[] => {
  if (!Array.isArray(value)) return invalid();
  const descriptors = objectGetOwnPropertyDescriptors(
    value,
  ) as unknown as PropertyDescriptorMap;
  const length = descriptors["length"];
  if (
    !length ||
    !("value" in length) ||
    typeof length.value !== "number" ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0 ||
    length.value > maximum
  )
    return invalid();
  const expected = new Set([
    "length",
    ...Array.from({ length: length.value }, (_, index) => String(index)),
  ]);
  if (
    reflectOwnKeys(descriptors).some(
      (key) => typeof key !== "string" || !expected.has(key),
    ) ||
    expected.size !== reflectOwnKeys(descriptors).length
  )
    return invalid();
  const output: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) return invalid();
    output.push(descriptor.value);
  }
  return objectFreeze(output);
};

const parseInteger = (value: unknown): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 65_535
  )
    return invalid();
  return value;
};

const parseInventory = (
  value: unknown,
  maximum: number,
  pattern: RegExp,
): readonly string[] => {
  const input = exactArray(value, maximum);
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (
      typeof item !== "string" ||
      item.length < 1 ||
      item.length > 96 ||
      !pattern.test(item) ||
      seen.has(item)
    )
      return invalid();
    seen.add(item);
    output.push(item);
  }
  if (output.length === 0) return invalid();
  return objectFreeze(output.sort());
};

const parseOperations = (
  value: unknown,
): readonly LocalResourceLifecycleOperation[] => {
  const operations = parseInventory(value, 16, /^[a-z][a-z0-9-]*$/u);
  if (
    operations.some(
      (operation) =>
        !LOCAL_RESOURCE_LIFECYCLE_OPERATIONS.includes(
          operation as LocalResourceLifecycleOperation,
        ),
    )
  )
    return invalid();
  return operations as readonly LocalResourceLifecycleOperation[];
};

const parseReceiptReasons = (
  value: unknown,
): readonly ReporterReceiptReason[] => {
  const reasons = parseInventory(
    value,
    REPORTER_RECEIPT_REASONS.length,
    /^destination-[a-z][a-z0-9-]*$/u,
  );
  if (
    reasons.some(
      (reason) =>
        !REPORTER_RECEIPT_REASONS.includes(reason as ReporterReceiptReason),
    )
  )
    return invalid();
  return reasons as readonly ReporterReceiptReason[];
};

const fingerprint = (material: object): string =>
  `sha256-${createHash("sha256").update(JSON.stringify(material)).digest("hex")}`;

export const defineLocalResourceLifecycleDeclaration = (
  input: LocalResourceLifecycleDeclarationInput,
): LocalResourceLifecycleDeclaration => {
  try {
    const record = exactRecord(input, [
      "artifactGrammarFingerprint",
      "artifactGrammarVersion",
      "artifactKinds",
      "capabilityVersion",
      "destinationType",
      "operations",
      "receiptReasons",
      "recoveryHandlerId",
      "settingKeys",
      "settingsVersion",
    ]);
    if (record.capabilityVersion !== 1) return invalid();
    const destinationType = createDestinationTypeId(record.destinationType);
    const settingsVersion = parseInteger(record.settingsVersion);
    const settingKeys = parseInventory(
      record.settingKeys,
      64,
      /^[a-z][A-Za-z0-9]*$/u,
    );
    const operations = parseOperations(record.operations);
    const artifactGrammarVersion = parseInteger(record.artifactGrammarVersion);
    if (
      typeof record.artifactGrammarFingerprint !== "string" ||
      !/^sha256-[a-f0-9]{64}$/u.test(record.artifactGrammarFingerprint)
    )
      return invalid();
    const artifactKinds = parseInventory(
      record.artifactKinds,
      64,
      /^[a-z][a-z0-9-]*$/u,
    );
    const receiptReasons = parseReceiptReasons(record.receiptReasons);
    if (
      typeof record.recoveryHandlerId !== "string" ||
      record.recoveryHandlerId.length > 192 ||
      !/^@agentscope\/destination-[a-z0-9-]+\/lifecycle-v[1-9][0-9]{0,4}$/u.test(
        record.recoveryHandlerId,
      ) ||
      record.recoveryHandlerId !== `${destinationType}/lifecycle-v1`
    )
      return invalid();
    const material = objectFreeze({
      artifactGrammarFingerprint: record.artifactGrammarFingerprint,
      artifactGrammarVersion,
      artifactKinds,
      capabilityVersion: 1 as const,
      destinationType,
      operations,
      receiptReasons,
      recoveryHandlerId: record.recoveryHandlerId,
      settingKeys,
      settingsVersion,
    });
    const declaration = objectFreeze(
      material,
    ) as LocalResourceLifecycleDeclaration;
    declarationRegistry.add(declaration);
    return declaration;
  } catch {
    return invalid();
  }
};

export const isLocalResourceLifecycleDeclaration = (
  value: unknown,
): value is LocalResourceLifecycleDeclaration =>
  typeof value === "object" && value !== null && declarationRegistry.has(value);

export const bindLocalResourceLifecycleCapability = (
  declaration: LocalResourceLifecycleDeclaration,
  settingsSchemaFingerprint: string,
): LocalResourceLifecycleCapability => {
  if (
    !isLocalResourceLifecycleDeclaration(declaration) ||
    !/^sha256-[a-f0-9]{64}$/u.test(settingsSchemaFingerprint)
  )
    return invalid();
  const material = objectFreeze({
    artifactGrammarFingerprint: declaration.artifactGrammarFingerprint,
    artifactGrammarVersion: declaration.artifactGrammarVersion,
    artifactKinds: declaration.artifactKinds,
    capabilityVersion: declaration.capabilityVersion,
    destinationType: declaration.destinationType,
    operations: declaration.operations,
    receiptReasons: declaration.receiptReasons,
    recoveryHandlerId: declaration.recoveryHandlerId,
    settingKeys: declaration.settingKeys,
    settingsSchemaFingerprint,
    settingsVersion: declaration.settingsVersion,
  });
  const capability = objectFreeze({
    ...material,
    fingerprint: fingerprint(material),
  }) as LocalResourceLifecycleCapability;
  capabilityRegistry.add(capability);
  return capability;
};

export const isLocalResourceLifecycleCapability = (
  value: unknown,
): value is LocalResourceLifecycleCapability =>
  typeof value === "object" && value !== null && capabilityRegistry.has(value);
